#!/usr/bin/env node
/**
 * FastAgent message forwarder
 * Watches conversation-queue.jsonl for incoming WeChat messages
 * and forwards them to the api-server webhook
 */
const fs = require('fs');
const http = require('http');

const QUEUE_FILE = process.env.QUEUE_FILE || '/app/data/conversation-queue.jsonl';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://api-server:3000/webhook';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '1000', 10);

let lastSize = 0;

function postWebhook(payload) {
  const data = JSON.stringify(payload);
  const opts = new URL(WEBHOOK_URL);
  const req = http.request({
    hostname: opts.hostname,
    port: opts.port || 80,
    path: opts.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    timeout: 5000,
  }, (res) => {
    console.log(`[forwarder] Webhook ${res.statusCode}: ${payload.content?.substring(0,30)}`);
  });
  req.on('error', (e) => console.error('[forwarder] Error:', e.message));
  req.write(data);
  req.end();
}

function processNewLines() {
  try {
    const stat = fs.statSync(QUEUE_FILE);
    if (stat.size <= lastSize) return;

    const fd = fs.openSync(QUEUE_FILE, 'r');
    const buf = Buffer.alloc(stat.size - lastSize);
    fs.readSync(fd, buf, 0, buf.length, lastSize);
    fs.closeSync(fd);
    lastSize = stat.size;

    const lines = buf.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'queue_item_enqueued' && event.kind === 'user_message') {
          const convKey = event.conversationKey || '';
          const parts = convKey.split(':');
          // format: weixin:botId:userId:...
          const fromUser = parts[2] || 'unknown';

          const payload = {
            FromUserName: fromUser,
            MsgType: 'text',
            Content: event.normalizedInput || '',
            MsgId: ((event.sourceInboundIds || [''])[0] || `${Date.now()}`).replace(/:/g, '_'),
            CreateTime: Math.floor(event.enqueueTime / 1000),
          };

          console.log(`[forwarder] 📩 Forwarding: "${payload.Content}" from ${fromUser}`);
          postWebhook(payload);
        }
      } catch (e) {
        // Skip unparseable lines
      }
    }
  } catch (e) {
    // File not ready yet, retry
  }
}

console.log(`[forwarder] Watching ${QUEUE_FILE}`);
console.log(`[forwarder] Forwarding to ${WEBHOOK_URL}`);

// Initial size
try { lastSize = fs.statSync(QUEUE_FILE).size; } catch {}

// Poll for changes
setInterval(processNewLines, POLL_INTERVAL);
