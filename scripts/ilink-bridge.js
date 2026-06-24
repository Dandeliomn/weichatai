#!/usr/bin/env node
/**
 * iLink Bridge — relay sendViaILink → iLink 云 API 翻译层
 * =============================================================================
 *
 * relay 通过 HTTP POST 调用本服务，本服务翻译为 iLink 云 API 格式。
 *
 * 输入 (relay → bridge):
 *   POST /api/send
 *   Body: { to, content, type }
 *
 * 输出 (bridge → iLink 云):
 *   POST {ILINK_BASE_URL}/ilink/bot/sendmessage
 *   Body: { from_user_id, to_user_id, client_id, message_type, message_state, item_list }
 *
 * 用法:
 *   ILINK_BASE_URL=https://ilinkai.weixin.qq.com \
 *   ILINK_TOKEN=xxx \
 *   ILINK_CLIENT_ID=xxx \
 *   node scripts/ilink-bridge.js
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = parseInt(process.env.ILINK_BRIDGE_PORT || '18789', 10);
const BASE_URL = process.env.ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com';
const TOKEN = process.env.ILINK_TOKEN || '';
const CLIENT_ID = process.env.ILINK_CLIENT_ID || '';
const ACCOUNT_ID = process.env.ILINK_ACCOUNT_ID || CLIENT_ID;

const parsedBase = new URL(BASE_URL);

function log(msg) {
  console.log(`[ilink-bridge] ${new Date().toISOString().split('T')[1].split('.')[0]} ${msg}`);
}

function warn(msg) {
  console.warn(`[ilink-bridge] ${new Date().toISOString().split('T')[1].split('.')[0]} ⚠️ ${msg}`);
}

function error(msg) {
  console.error(`[ilink-bridge] ${new Date().toISOString().split('T')[1].split('.')[0]} ❌ ${msg}`);
}

/**
 * 调用 iLink getupdates 刷新 session
 */
function refreshSession() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ get_updates_buf: '' });
    const isHTTPS = parsedBase.protocol === 'https:';
    const transport = isHTTPS ? https : http;
    const options = {
      hostname: parsedBase.hostname,
      port: parsedBase.port || (isHTTPS ? 443 : 80),
      path: '/ilink/bot/getupdates',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${TOKEN}`,
      },
      timeout: 10000,
    };
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          log(`🔄 Session 刷新: ret=${result.ret}`);
          resolve(result.get_updates_buf || '');
        } catch (e) {
          resolve('');
        }
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.write(body);
    req.end();
  });
}

/**
 * 调用 iLink 云 API 发送消息
 */
function callILinkAPI(to, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      from_user_id: '',
      to_user_id: to,
      client_id: ACCOUNT_ID,
      message_type: 2,   // MSG_TYPE_BOT
      message_state: 2,  // MSG_STATE_FINISH
      item_list: [{
        type: 1,          // ITEM_TEXT
        text_item: { text }
      }]
    });

    const isHTTPS = parsedBase.protocol === 'https:';
    const transport = isHTTPS ? https : http;

    const options = {
      hostname: parsedBase.hostname,
      port: parsedBase.port || (isHTTPS ? 443 : 80),
      path: '/ilink/bot/sendmessage',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${TOKEN}`,
      },
      timeout: 15000,
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            if (result.ret === 0 || result.errcode === 0) {
              log(`✅ 发送成功 → ${to}: "${text.substring(0, 30)}"`);
              resolve(result);
            } else {
              warn(`iLink 返回错误: ret=${result.ret} errcode=${result.errcode} raw=${JSON.stringify(result).substring(0, 200)}`);
              resolve(null); // 降级
            }
          } catch (e) {
            warn(`iLink 响应解析失败: ${data.substring(0, 100)}`);
            resolve(null);
          }
        } else {
          warn(`iLink HTTP ${res.statusCode}: ${data.substring(0, 200)}`);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      error(`iLink 请求失败: ${e.message}`);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      warn('iLink 请求超时');
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, base_url: BASE_URL }));
    return;
  }

  // Message send endpoint
  if (req.method === 'POST' && req.url === '/api/send') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { to, content } = JSON.parse(body);

        if (!to || !content) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'to and content required' }));
          return;
        }

        // 先刷新 session，再发送
        await refreshSession();
        const result = await callILinkAPI(to, content);

        if (result) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'iLink API call failed' }));
        }
      } catch (e) {
        error(`请求处理失败: ${e.message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  log(`🚀 iLink Bridge 已启动: http://127.0.0.1:${PORT}`);
  log(`   iLink 云 API: ${BASE_URL}`);
  log(`   Account: ${ACCOUNT_ID}`);
});
