import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';

export const info = {
  id: 'relay-api',
  name: 'Relay API Endpoint',
  description: 'Provides /api/chat/send for hermes-st-relay.js'
};

let API_KEY = '';

function loadConfig() {
  try {
    const yaml = fs.readFileSync('/home/node/app/config.yaml', 'utf8');
    const match = yaml.match(/^apiKey:\s*"?([^"\n]+)"?/m);
    if (match) API_KEY = match[1].trim();
  } catch (_) { API_KEY = '57cd51af2bdaaf1742dbc1a933a31d00'; }
}

function loadSTSettings() {
  try {
    const p = `${globalThis.DATA_ROOT}/default-user/OpenAI Settings/Default.json`;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

export async function init(app) {
  loadConfig();

  app.post('/api/chat/send', async (req, res) => {
    const reqKey = (req.headers['x-api-key'] || '').trim();
    if (API_KEY && reqKey !== API_KEY) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const { mes, stream } = req.body || {};
    if (!Array.isArray(mes) || mes.length === 0) {
      return res.status(400).json({ error: 'mes array required' });
    }

    const settings = loadSTSettings();
    const baseUrl = settings?.reverse_proxy || 'https://api.deepseek.com/v1';
    const model = settings?.openai_model || 'deepseek-v4-flash';
    const apiKey = settings?.proxy_password || '';
    const maxTokens = settings?.openai_max_tokens || 1024;
    const temperature = settings?.temperature ?? 0.8;

    const parsedBase = new URL(baseUrl);
    const body = JSON.stringify({ model, messages: mes, max_tokens: maxTokens, temperature, stream: !!stream });
    const buf = Buffer.from(body);
    const transport = baseUrl.startsWith('https') ? https : http;

    const options = {
      hostname: parsedBase.hostname,
      port: parsedBase.port || (baseUrl.startsWith('https') ? 443 : 80),
      path: parsedBase.pathname + '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': buf.length,
      },
      timeout: 60000,
    };

    try {
      const llmRes = await new Promise((resolve, reject) => {
        const r = transport.request(options, resolve);
        r.on('error', reject);
        r.write(buf);
        r.end();
      });

      if (llmRes.statusCode !== 200) {
        let errData = '';
        llmRes.on('data', c => errData += c);
        llmRes.on('end', () => res.status(502).json({ error: `LLM ${llmRes.statusCode}` }));
        return;
      }

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        let buffer = '', fullContent = '';
        llmRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const t = line.trim();
            if (!t || !t.startsWith('data:')) continue;
            const ds = t.slice(5).trim();
            if (ds === '[DONE]') {
              res.write(`data: ${JSON.stringify({ event: 'final', mes: { content: fullContent } })}\n\n`);
              res.write(`data: ${JSON.stringify({ event: 'stream_end' })}\n\n`);
              res.end();
              return;
            }
            try {
              const j = JSON.parse(ds);
              const d = j.choices?.[0]?.delta?.content || '';
              if (d) { fullContent += d; res.write(`data: ${JSON.stringify({ event: 'token', value: d })}\n\n`); }
            } catch (_) {}
          }
        });
        llmRes.on('end', () => {
          res.write(`data: ${JSON.stringify({ event: 'final', mes: { content: fullContent } })}\n\n`);
          res.write(`data: ${JSON.stringify({ event: 'stream_end' })}\n\n`);
          res.end();
        });
        llmRes.on('error', () => res.end());
      } else {
        let data = '';
        llmRes.on('data', c => data += c);
        llmRes.on('end', () => {
          try {
            const j = JSON.parse(data);
            const content = j.choices?.[0]?.message?.content || '';
            res.json({ mes: { content } });
          } catch (e) {
            res.status(500).json({ error: 'Parse error' });
          }
        });
      }
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  console.log('[relay-api] Plugin loaded — /api/chat/send ready');
  return true;  // MUST return truthy for plugin loader
}

export async function exit() {
  console.log('[relay-api] Shutting down');
}
