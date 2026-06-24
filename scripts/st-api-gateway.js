#!/usr/bin/env node
/**
 * ST API Gateway — 为 relay 提供 /api/chat/send 端点
 * =============================================================================
 *
 * 问题: ST 的 API 端点需要 cookie session，relay 无法调用。
 * 解决: 本网关接管 relay → ST 的 API 调用，翻译为 DeepSeek 直连。
 *
 * relay 调用:
 *   POST /api/chat/send
 *   X-API-Key: <config.yaml apiKey>
 *   { chat_id, mes: [{role, content}], stream: true }
 *
 * 网关回复 (SSE):
 *   data: {"event":"token","value":"..."}
 *   data: {"event":"final","mes":{"content":"..."}}
 *   data: {"event":"stream_end"}
 *
 * ST 照常运行 Web UI (:8000)，本网关监听 :8010。
 * relay 的 ST_API_URL 指向 http://localhost:8010。
 */

const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.GATEWAY_PORT || '8010', 10);
const API_KEY = process.env.API_KEY || '57cd51af2bdaaf1742dbc1a933a31d00';
const LLM_KEY = process.env.DEEPSEEK_API_KEY || '';
const LLM_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const LLM_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1';

function log(msg) { console.log(`[st-gateway] ${new Date().toISOString().split('T')[1].split('.')[0]} ${msg}`); }
function warn(msg) { console.warn(`[st-gateway] ${new Date().toISOString().split('T')[1].split('.')[0]} ⚠️ ${msg}`); }

const parsedLLM = new URL(LLM_URL);

/**
 * 调用 DeepSeek API，返回 SSE 流
 */
function streamLLM(messages, res) {
  const body = JSON.stringify({
    model: LLM_MODEL,
    messages: messages,
    max_tokens: 1024,
    temperature: 0.8,
    stream: true,
  });

  const buf = Buffer.from(body);
  const options = {
    hostname: parsedLLM.hostname,
    path: '/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_KEY}`,
      'Content-Length': buf.length,
    },
    timeout: 60000,
  };

  const transport = parsedLLM.protocol === 'https:' ? https : http;

  const llmReq = transport.request(options, (llmRes) => {
    if (llmRes.statusCode !== 200) {
      let errData = '';
      llmRes.on('data', c => errData += c);
      llmRes.on('end', () => {
        warn(`LLM API ${llmRes.statusCode}: ${errData.substring(0, 100)}`);
        res.write(`data: ${JSON.stringify({ event: 'error', message: 'LLM API error' })}\n\n`);
        res.write(`data: ${JSON.stringify({ event: 'stream_end' })}\n\n`);
        res.end();
      });
      return;
    }

    // DeepSeek SSE → ST 格式 SSE
    let buffer = '';
    let fullContent = '';

    llmRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          res.write(`data: ${JSON.stringify({ event: 'final', mes: { content: fullContent } })}\n\n`);
          res.write(`data: ${JSON.stringify({ event: 'stream_end' })}\n\n`);
          res.end();
          return;
        }
        try {
          const data = JSON.parse(dataStr);
          const delta = data.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullContent += delta;
            res.write(`data: ${JSON.stringify({ event: 'token', value: delta })}\n\n`);
          }
        } catch (_) {}
      }
    });

    llmRes.on('end', () => {
      // Process remaining buffer
      if (buffer.trim() && buffer.trim() !== 'data: [DONE]') {
        try {
          const data = JSON.parse(buffer.trim().replace('data: ', ''));
          const delta = data.choices?.[0]?.delta?.content || '';
          if (delta) fullContent += delta;
        } catch (_) {}
      }
      res.write(`data: ${JSON.stringify({ event: 'final', mes: { content: fullContent } })}\n\n`);
      res.write(`data: ${JSON.stringify({ event: 'stream_end' })}\n\n`);
      res.end();
    });

    llmRes.on('error', (e) => {
      warn(`LLM stream error: ${e.message}`);
      res.end();
    });
  });

  llmReq.on('error', (e) => {
    warn(`LLM request failed: ${e.message}`);
    res.write(`data: ${JSON.stringify({ event: 'error', message: e.message })}\n\n`);
    res.write(`data: ${JSON.stringify({ event: 'stream_end' })}\n\n`);
    res.end();
  });

  llmReq.on('timeout', () => {
    llmReq.destroy();
    warn('LLM request timeout');
    res.write(`data: ${JSON.stringify({ event: 'stream_end' })}\n\n`);
    res.end();
  });

  llmReq.write(buf);
  llmReq.end();
}

// =============================================================================
// HTTP Server
// =============================================================================

const server = http.createServer((req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: LLM_MODEL }));
    return;
  }

  // Chat send endpoint
  if (req.method === 'POST' && req.url === '/api/chat/send') {
    // Validate API key
    const reqApiKey = req.headers['x-api-key'] || '';
    if (API_KEY && reqApiKey !== API_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid API key' }));
      return;
    }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { mes, stream } = JSON.parse(body);
        if (!mes || !Array.isArray(mes)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'mes array required' }));
          return;
        }

        log(`请求: ${mes.length} 条消息`);

        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          streamLLM(mes, res);
        } else {
          // Non-streaming fallback
          const body2 = JSON.stringify({
            model: LLM_MODEL,
            messages: mes,
            max_tokens: 1024,
            temperature: 0.8,
          });
          const buf = Buffer.from(body2);
          const transport = parsedLLM.protocol === 'https:' ? https : http;
          const llmReq = transport.request({
            hostname: parsedLLM.hostname,
            path: '/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${LLM_KEY}`,
              'Content-Length': buf.length,
            },
            timeout: 60000,
          }, (llmRes) => {
            let d = '';
            llmRes.on('data', c => d += c);
            llmRes.on('end', () => {
              try {
                const j = JSON.parse(d);
                const content = j.choices?.[0]?.message?.content || '';
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ mes: { content } }));
              } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'Parse error' }));
              }
            });
          });
          llmReq.on('error', (e) => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
          llmReq.write(buf);
          llmReq.end();
        }
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  log(`🚀 ST API Gateway 启动: http://127.0.0.1:${PORT}`);
  log(`   LLM: ${LLM_MODEL} @ ${LLM_URL}`);
});
