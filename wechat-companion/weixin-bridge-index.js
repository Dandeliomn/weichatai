#!/usr/bin/env node
/**
 * weixin-bridge — QR码展示服务
 * 从 qr_share 共享卷读取 weclaw-bridge 输出的 QR 文本
 * - /qr           → HTML 页面 (含 SVG 二维码)
 * - /qr.txt       → 原始 Unicode QR 文本
 * - /qr.svg       → SVG 矢量二维码 (微信可扫)
 * - /health       → 健康检查
 * - /bridge/weclaw-qr → (兼容旧接口) 原始 QR 文本
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3001', 10);
const QR_DIR = process.env.QR_DIR || '/qr-share';
const QR_FILE = path.join(QR_DIR, 'qr.txt');

let cachedQr = '';
let cachedAt = 0;

function readQr() {
  try {
    const stat = fs.statSync(QR_FILE);
    if (stat.mtimeMs > cachedAt) {
      cachedQr = fs.readFileSync(QR_FILE, 'utf-8');
      cachedAt = stat.mtimeMs;
      console.log(`[weixin-bridge] QR updated (${cachedQr.length} chars)`);
    }
  } catch (e) {
    // File not ready yet
  }
  return cachedQr;
}

/**
 * 将 Unicode 块字符 QR 文本解析为二值矩阵
 * 每个 Unicode 字符代表 1列 x 2行:
 *   █ (U+2588) → 1,1 (全黑)
 *   ▀ (U+2580) → 1,0 (上半黑)
 *   ▄ (U+2584) → 0,1 (下半黑)
 *   " " (0x20) → 0,0 (全白)
 *
 * 返回: { matrix: number[][], width: number, height: number }
 */
function parseQrMatrix(qrText) {
  // 只保留包含 QR 块字符(█▀▄)的行, 过滤 "Please scan..." 等文本行
  const lines = qrText.split('\n').filter(l => /[█▀▄]/.test(l));
  if (lines.length === 0) return null;

  // 清理 ANSI 转义序列
  const cleanLines = lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));

  // QR 码是正方形: 宽度 = 最大行长度
  const width = Math.max(...cleanLines.map(l => l.length));

  // 检测最后一行是否全是 ▀ (半块底部，仅贡献1行)
  const lastLine = cleanLines[cleanLines.length - 1];
  const isHalfLine = lastLine && lastLine.length > 0 &&
    [...lastLine].every(ch => ch === '▀');

  // 高度: 正常行 = 2行, 最后一个半行只贡献1行
  const fullLines = isHalfLine ? cleanLines.length - 1 : cleanLines.length;
  const height = fullLines * 2 + (isHalfLine ? 1 : 0);

  // 确保正方形: width == height (QR码必须是正方形)
  const size = Math.max(width, height);

  // 创建矩阵 (size x size)
  const matrix = Array.from({ length: size }, () => new Array(size).fill(0));

  for (let row = 0; row < cleanLines.length; row++) {
    const line = cleanLines[row];
    const isLastHalfLine = isHalfLine && row === cleanLines.length - 1;

    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      const topRow = row * 2;

      if (isLastHalfLine) {
        if (ch === '▀') matrix[topRow][col] = 1;
        else if (ch === '█') matrix[topRow][col] = 1;
      } else {
        const botRow = row * 2 + 1;
        if (ch === '█') {
          matrix[topRow][col] = 1;
          matrix[botRow][col] = 1;
        } else if (ch === '▀') {
          matrix[topRow][col] = 1;
          matrix[botRow][col] = 0;
        } else if (ch === '▄') {
          matrix[topRow][col] = 0;
          matrix[botRow][col] = 1;
        }
      }
    }
  }

  return { matrix, width: size, height: size };
}

/**
 * 从二值矩阵生成 SVG 二维码图片
 * 包含静区 (quiet zone) = 4模块
 */
function generateSvg(matrix, width, height) {
  const QUIET = 4;
  const MODULE = 10;
  const PADDING = QUIET * MODULE;

  const svgW = width * MODULE + PADDING * 2;
  const svgH = height * MODULE + PADDING * 2;

  let rects = '';

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (matrix[y][x] === 1) {
        const rx = PADDING + x * MODULE;
        const ry = PADDING + y * MODULE;
        rects += `<rect x="${rx}" y="${ry}" width="${MODULE}" height="${MODULE}"/>`;
      }
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
  <rect width="${svgW}" height="${svgH}" fill="white"/>
  <g fill="black">${rects}</g>
</svg>`;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 兼容旧接口: /bridge/weclaw-qr → 原始 QR 文本
  if (url.pathname === '/bridge/weclaw-qr') {
    const qr = readQr();
    if (!qr) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('QR not available\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(qr);
    return;
  }

  // SVG 二维码 (微信可扫)
  if (url.pathname === '/qr.svg') {
    const qr = readQr();
    if (!qr) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('QR码尚未生成\n');
      return;
    }

    const parsed = parseQrMatrix(qr);
    if (!parsed) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('QR码解析失败\n');
      return;
    }

    const svg = generateSvg(parsed.matrix, parsed.width, parsed.height);
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-cache',
    });
    res.end(svg);
    return;
  }

  // 原始 QR 文本
  if (url.pathname === '/qr' || url.pathname === '/qr.txt') {
    const qr = readQr();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(qr || 'QR码尚未生成，请在微信端扫码登录...\n');
    return;
  }

  // 健康检查
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', qrAvailable: !!cachedQr }));
    return;
  }

  // HTML 页面 (使用 SVG 展示)
  const qr = readQr();
  const parsed = qr ? parseQrMatrix(qr) : null;
  const svg = parsed ? generateSvg(parsed.matrix, parsed.width, parsed.height) : '';

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>微信扫码登录</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1a1a2e; color: #eee;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh; padding: 20px;
  }
  .container { text-align: center; max-width: 400px; }
  .qr-box {
    background: white; border-radius: 16px; padding: 20px;
    display: inline-block; box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  }
  .qr-box svg, .qr-box img {
    width: 280px; height: 280px; display: block;
  }
  .hint { margin-top: 20px; font-size: 16px; color: #aaa; }
  .hint .icon { font-size: 24px; display: block; margin-bottom: 8px; }
  .auto-refresh { margin-top: 12px; font-size: 12px; color: #666; }
</style>
</head>
<body>
<div class="container">
  ${svg ? `<div class="qr-box">${svg}</div>` : '<div style="color:#888;padding:40px;">⏳ 等待二维码生成...</div>'}
  <div class="hint">
    <span class="icon">📱</span>
    请使用微信扫描上方二维码登录
  </div>
  <div class="auto-refresh">QR 码 <span id="countdown">90s</span> 后自动刷新</div>
</div>
<script>
var left = 90;
var el = document.getElementById('countdown');
setInterval(function() {
  left--;
  if (el) el.textContent = left + 's';
  if (left <= 0) location.reload();
}, 1000);
</script>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log(`[weixin-bridge] QR display service on :${PORT}`);
  console.log(`[weixin-bridge]   SVG QR: http://0.0.0.0:${PORT}/qr.svg`);
  console.log(`[weixin-bridge]   Text QR: http://0.0.0.0:${PORT}/qr.txt`);
  console.log(`[weixin-bridge]   HTML:    http://0.0.0.0:${PORT}/`);
  console.log(`[weixin-bridge] Watching ${QR_FILE}`);
});
