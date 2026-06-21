#!/usr/bin/env node
/**
 * Hermes Webhook Bridge
 * 监听 Hermes gateway 输出的 JSONL 日志，提取消息事件转发到 api-server
 *
 * Hermes 输出格式 (从 --output jsonl):
 *   {"type":"message_received","channel":"weixin","from":"wxid_xxx",
 *    "content":"你好","timestamp":1719000000,"message_id":"abc"}
 *   {"type":"message_sent","channel":"weixin","to":"wxid_xxx",
 *    "content":"你好呀~","timestamp":1719000001}
 */

const fs = require('fs');
const http = require('http');

const LOG_FILE = process.env.LOG_FILE || '/app/data/logs/gateway.log';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://api-server:3000/api/hermes/webhook';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '500', 10);

let lastSize = 0;

function postWebhook(payload) {
  const data = JSON.stringify(payload);
  const url = new URL(WEBHOOK_URL);
  const req = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
    timeout: 5000,
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`[bridge] ✅ ${payload.direction} forwarded (${res.statusCode})`);
      } else {
        console.error(`[bridge] ❌ ${payload.direction} failed (${res.statusCode}): ${body}`);
      }
    });
  });
  req.on('error', (e) => console.error(`[bridge] ❌ error: ${e.message}`));
  req.write(data);
  req.end();
}

function processNewLines() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size <= lastSize) return;

    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(Math.min(stat.size - lastSize, 1024 * 1024)); // max 1MB
    fs.readSync(fd, buf, 0, buf.length, lastSize);
    fs.closeSync(fd);
    lastSize = stat.size;

    const lines = buf.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // 只处理消息收发事件
        if (event.type === 'message_received') {
          const payload = {
            direction: 'inbound',
            from_user: event.from || event.sender?.id || 'unknown',
            content: event.content || event.text || '',
            msg_type: event.msg_type || 'text',
            message_id: event.message_id || event.id || '',
            timestamp: event.timestamp || Math.floor(Date.now() / 1000),
          };
          console.log(`[bridge] 📩 inbound: "${payload.content.substring(0, 40)}" from ${payload.from_user}`);
          postWebhook(payload);
        } else if (event.type === 'message_sent') {
          const payload = {
            direction: 'outbound',
            from_user: event.to || event.recipient?.id || 'unknown',
            content: event.content || event.text || '',
            msg_type: 'text',
            message_id: event.message_id || event.id || '',
            timestamp: event.timestamp || Math.floor(Date.now() / 1000),
          };
          console.log(`[bridge] 📤 outbound: "${payload.content.substring(0, 40)}"`);
          postWebhook(payload);
        }
      } catch (e) {
        // 跳过无法解析的行
      }
    }
  } catch (e) {
    // 文件尚未创建，忽略
  }
}

console.log(`[bridge] Watching ${LOG_FILE}`);
console.log(`[bridge] Forwarding to ${WEBHOOK_URL}`);

// 初始化文件大小
try { lastSize = fs.statSync(LOG_FILE).size; } catch {}

// 轮询新内容
setInterval(processNewLines, POLL_INTERVAL);
