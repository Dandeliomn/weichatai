/**
 * 轻量微信桥接 — 对接微信网页版协议
 *
 * 流程:
 * 1. 获取 UUID → 生成二维码
 * 2. 轮询扫码状态
 * 3. 扫码后登录，获取会话
 * 4. 长轮询接收消息 → 转发到 webhook
 * 5. 通过 WeClaw HTTP API 发送消息回复
 *
 * 启动: node weixin-bridge.js
 */

const http = require('http');
const https = require('https');

const WEBHOOK_URL = 'http://api-server:3000/webhook';
const WECLAW_API = 'http://weclaw-bridge:26322';

// ---- 微信 API 封装 ----

function get(url) {
  return new Promise((resolve, reject) => {
    const h = url.startsWith('https') ? https : http;
    h.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
    }).on('error', reject);
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const h = url.startsWith('https') ? https : http;
    const data = JSON.stringify(body);
    const req = h.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.write(data);
    req.end();
  });
}

// ---- 主流程 ----

const APPID = 'wx782c26e4c19acffb';
let uuid = '';
let cookies = {};
let sk = '', wxsid = '', wxuin = '';

/** 步骤1: 获取 UUID */
async function getUUID() {
  const res = await get(`https://login.wx.qq.com/jslogin?appid=${APPID}&fun=new&lang=zh_CN`);
  const m = res.data.match(/uuid = "([^"]+)"/);
  if (m) uuid = m[1];
  return uuid;
}

/** 步骤2: 轮询扫码 */
async function waitForScan(callback) {
  while (true) {
    const res = await get(`https://login.wx.qq.com/cgi-bin/mmwebwx-bin/login?loginicon=true&uuid=${uuid}&tip=0&r=${Date.now()}`);
    const tip1 = await get(`https://login.wx.qq.com/cgi-bin/mmwebwx-bin/login?uuid=${uuid}&tip=1&r=${Date.now()}`);

    if (res.data.includes('window.code=200') || tip1.data.includes('window.code=200')) {
      // 已扫码，等待确认
      callback({ scanned: true });
    }

    const m = res.data.match(/window.code=(\d+)/);
    const code = m ? parseInt(m[1]) : 0;

    if (code === 201) {
      // 已确认登录
      const redirect = res.data.match(/redirect_uri="([^"]+)"/);
      if (redirect) {
        const loginRes = await get(redirect[1] + '&fun=new');
        // 解析 cookies
        const setCookie = loginRes.headers['set-cookie'] || [];
        for (const c of Array.isArray(setCookie) ? setCookie : [setCookie]) {
          if (c.startsWith('sk=')) sk = c.split(';')[0].substring(3);
          if (c.startsWith('wxsid=')) wxsid = c.split(';')[0].substring(6);
          if (c.startsWith('wxuin=')) wxuin = c.split(';')[0].substring(6);
        }
        callback({ loggedIn: true, sk, wxsid, wxuin });
        return { sk, wxsid, wxuin };
      }
    }

    if (code === 408) {
      callback({ waiting: true });
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

// ---- HTTP 服务（供前端调用） ----

const fs = require('fs');
const path_mod = require('path');

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // WeClaw 原生二维码 - 从共享卷读取 bot 终端输出
  if (path === '/bridge/weclaw-qr') {
    try {
      const qrText = fs.readFileSync('/qr-share/qrcode.txt', 'utf-8');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(qrText);
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('QR not available');
    }
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  if (path === '/bridge/qr') {
    // 生成二维码
    uuid = await getUUID();
    if (uuid) {
      res.end(JSON.stringify({
        qrCodeUrl: `https://login.weixin.qq.com/l/${uuid}`,
        uuid,
      }));
    } else {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: '获取 UUID 失败' }));
    }
    return;
  }

  if (path === '/bridge/poll') {
    const tip = parseInt(url.searchParams.get('tip') || '0');
    const r = await get(`https://login.wx.qq.com/cgi-bin/mmwebwx-bin/login?uuid=${uuid}&tip=${tip}&r=${Date.now()}`);
    
    const code = (r.data.match(/window.code=(\d+)/) || [])[1] || '408';
    const redirect = (r.data.match(/redirect_uri="([^"]+)"/) || [])[1] || '';

    res.end(JSON.stringify({ code: parseInt(code), redirect }));
    return;
  }

  if (path === '/bridge/login') {
    // 扫码确认后，用 redirect URL 获取 session
    const redirectUrl = url.searchParams.get('redirect');
    if (!redirectUrl) { res.statusCode = 400; res.end(JSON.stringify({ error: '缺少 redirect' })); return; }

    try {
      const loginRes = await get(redirectUrl + '&fun=new');
      const setCookie = loginRes.headers['set-cookie'] || [];
      const cookies = {};
      for (const c of Array.isArray(setCookie) ? setCookie : [setCookie]) {
        const [kv] = c.split(';');
        const [k, v] = kv.split('=');
        cookies[k] = v;
      }
      sk = cookies.sk || '';
      wxsid = cookies.wxsid || '';
      wxuin = cookies.wxuin || '';
      res.end(JSON.stringify({ ok: true, cookies }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not Found' }));
});

const PORT = 3200;
server.listen(PORT, () => {
  console.log(`[WeixinBridge] 二维码服务运行在 http://0.0.0.0:${PORT}`);
  console.log(`[WeixinBridge]  GET /bridge/qr     — 获取二维码`);
  console.log(`[WeixinBridge]  GET /bridge/poll    — 轮询扫码状态`);
  console.log(`[WeixinBridge]  GET /bridge/login   — 完成登录`);
});
