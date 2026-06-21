/**
 * WeChat message receiver using @tencent-weixin/openclaw-weixin
 * Receives incoming messages and forwards them to the api-server webhook
 */
const http = require('http');

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://api-server:3000/webhook';
const PORT = process.env.PORT || 3001;

// Simple webhook forwarder
function forwardToWebhook(payload) {
  const data = JSON.stringify(payload);
  const url = new URL(WEBHOOK_URL);
  const req = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (res) => {
    console.log(`[receiver] Webhook forwarded: ${res.statusCode}`);
  });
  req.on('error', (e) => console.error('[receiver] Webhook error:', e.message));
  req.write(data);
  req.end();
}

// Start a simple HTTP server to receive iLink callbacks
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/callback') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        console.log('[receiver] Received message:', JSON.stringify(msg).substring(0, 200));
        forwardToWebhook(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('[receiver] Parse error:', e.message);
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
  } else {
    res.writeHead(200);
    res.end('OK');
  }
});

server.listen(PORT, () => {
  console.log(`[receiver] Listening on port ${PORT}`);
  console.log(`[receiver] Forwarding to ${WEBHOOK_URL}`);
});
