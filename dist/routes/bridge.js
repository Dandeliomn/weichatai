"use strict";
/**
 * 微信桥接路由
 *
 * GET  /api/bridge/qr      — 获取 FastAgent 微信登录二维码
 * GET  /api/bridge/status  — 获取微信桥接连接状态
 * GET  /api/bridge-login   — 管理员登录 OpeniLink Hub（需管理员权限）
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initBridgeRoutes = initBridgeRoutes;
const express_1 = require("express");
const axios_1 = __importDefault(require("axios"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/** PostgreSQL 连接池 (由主入口注入) */
let pgPool;
function initBridgeRoutes(pool) {
    pgPool = pool;
}
// ---- 读取 FastAgent 日志，提取最新 QR码 和 登录状态 ----
// 支持多账号模式：读取 messages-*.jsonl 文件（每账号一个），
// 兼容旧版单文件 messages.jsonl
const FASTAGENT_DIR = '/app/fastagent-data';
function readAllAgentLogs() {
    const fs = require('fs');
    const path = require('path');
    const entries = [];
    try {
        // 读取所有 messages-*.jsonl 文件（多账号模式）
        const files = fs.readdirSync(FASTAGENT_DIR);
        const logFiles = files.filter((f) => /^messages(-[^.]+)?\.jsonl$/.test(f));
        for (const file of logFiles) {
            try {
                const data = fs.readFileSync(path.join(FASTAGENT_DIR, file), 'utf-8');
                const lines = data.trim().split('\n').reverse();
                for (const line of lines) {
                    try {
                        const entry = JSON.parse(line);
                        if (entry && typeof entry === 'object') {
                            // 标记来源 agent
                            entry._agentFile = file;
                            entries.push(entry);
                        }
                    }
                    catch { }
                }
            }
            catch { }
        }
    }
    catch { }
    return entries;
}
// ---- OpeniLink Hub 会话管理 ----
let bridgeSessionCookie = null;
let bridgeSessionExpiry = 0;
async function ensureBridgeSession() {
    if (bridgeSessionCookie && Date.now() < bridgeSessionExpiry)
        return bridgeSessionCookie;
    try {
        const resp = await axios_1.default.post('http://openilink-hub:9800/api/auth/login', { username: 'companion', password: 'admin123' }, { headers: { 'Content-Type': 'application/json' } });
        const setCookie = resp.headers['set-cookie'];
        if (setCookie) {
            const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
            const session = cookies.find((c) => c.startsWith('session='));
            if (session) {
                bridgeSessionCookie = session.split(';')[0];
                bridgeSessionExpiry = Date.now() + 3600000;
                return bridgeSessionCookie;
            }
        }
    }
    catch (e) {
        console.error('[Bridge] Login failed:', e);
    }
    return null;
}
// ---- 路由 ----
/**
 * POST /api/bridge/register-bot
 * WeClaw 桥接脚本扫码成功后调用，注册新登录的微信账号
 * 请求体: { botId, apiToken, wechatId?, nickname?, botIndex }
 */
router.post('/bridge/register-bot', async (req, res) => {
    try {
        const { botId, apiToken, wechatId, nickname, botIndex } = req.body;
        if (!botId || !apiToken) {
            res.status(400).json({ error: '缺少 botId 或 apiToken' });
            return;
        }
        // 检查是否已被用户删除 (deleted_at IS NOT NULL)
        const existing = await pgPool.query('SELECT deleted_at FROM bot_accounts WHERE bot_id = $1', [botId]);
        if (existing.rows.length > 0 && existing.rows[0].deleted_at != null) {
            console.log(`[Bot] ⏭️ 跳过已删除的 Bot: ${botId}`);
            res.json({ ok: false, message: 'Bot 已被用户删除', botId });
            return;
        }
        await pgPool.query(`INSERT INTO bot_accounts (bot_id, api_token, wechat_id, nickname, bot_index, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       ON CONFLICT (bot_id)
       DO UPDATE SET api_token = $2, wechat_id = COALESCE($3, bot_accounts.wechat_id),
                     nickname = COALESCE($4, bot_accounts.nickname),
                     last_active_at = NOW()`, [botId, apiToken, wechatId || null, nickname || null, botIndex ?? 0]);
        console.log(`[Bot] ✅ 注册/更新 Bot: ${botId} (idx=${botIndex})`);
        res.json({ ok: true, botId });
    }
    catch (error) {
        console.error('[Bot] 注册失败:', error.message);
        res.status(500).json({ error: 'Bot 注册失败' });
    }
});
/**
 * GET /api/bridge/bot-token?botId=xxx
 * 获取指定 Bot 的 API Token（用于发送消息）
 */
router.get('/bridge/bot-token', async (req, res) => {
    try {
        const { botId, wechatId } = req.query;
        let result;
        if (botId) {
            result = await pgPool.query('SELECT bot_id, api_token FROM bot_accounts WHERE bot_id = $1 AND is_active = TRUE AND deleted_at IS NULL', [botId]);
        }
        else if (wechatId) {
            result = await pgPool.query(`SELECT ba.bot_id, ba.api_token FROM bot_accounts ba
         WHERE (ba.wechat_id = $1 OR ba.bot_id = $1) AND ba.is_active = TRUE AND deleted_at IS NULL
         LIMIT 1`, [wechatId]);
        }
        else {
            // 返回第一个活跃 bot
            result = await pgPool.query('SELECT bot_id, api_token FROM bot_accounts WHERE is_active = TRUE AND deleted_at IS NULL ORDER BY bot_index LIMIT 1');
        }
        if (result.rows.length === 0) {
            res.status(404).json({ error: '未找到活跃的 Bot 账号', code: 'NO_BOT' });
            return;
        }
        res.json(result.rows[0]);
    }
    catch (error) {
        console.error('[Bot] Token 查询失败:', error.message);
        res.status(500).json({ error: '查询失败' });
    }
});
/** 获取 WeClaw 桥接的多个 Bot 列表 (公开接口，用于前端检测连接状态) */
router.get('/bridge/bots', async (_req, res) => {
    try {
        // 自动从 OpeniLink 同步 Bot 列表
        await syncOpeniLinkBots().catch(() => { });
        const result = await pgPool.query('SELECT id, bot_id, wechat_id, nickname, bot_index, is_active, last_active_at FROM bot_accounts WHERE deleted_at IS NULL ORDER BY bot_index');
        const connected = result.rows.some((r) => r.is_active);
        res.json({ bots: result.rows, total: result.rows.length, connected });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
/** 获取 FastAgent 微信登录二维码（所有已登录用户） */
router.get('/bridge/qr', auth_1.authenticate, (_req, res) => {
    try {
        const entries = readAllAgentLogs();
        let latestQr = null;
        let connected = false;
        for (const entry of entries) {
            if (entry.type === 'qr_code' && entry.data?.qrCodeUrl && !latestQr) {
                latestQr = entry.data.qrCodeUrl;
            }
            if (entry.type === 'login' && entry.data?.status === 'success')
                connected = true;
            if (entry.type === 'login_confirmed')
                connected = true;
            if (entry.type === 'running')
                connected = true;
            if (entry.type === 'websocket' && entry.data?.status === 'connected')
                connected = true;
            if (entry.type === 'ready')
                connected = true;
        }
        res.json({ qrCodeUrl: latestQr, connected, refreshIn: 120 });
    }
    catch (error) {
        console.error('[Bridge/QR]', error.message);
        res.status(500).json({ error: '获取二维码失败' });
    }
});
/** 获取微信桥接连接状态 */
router.get('/bridge/status', auth_1.authenticate, (_req, res) => {
    try {
        const entries = readAllAgentLogs();
        let connected = false;
        let botId = null;
        let lastQrTime = null;
        for (const entry of entries) {
            if (entry.type === 'login' && entry.data?.status === 'success') {
                connected = true;
                if (entry.data?.botId)
                    botId = entry.data.botId;
            }
            if (entry.type === 'login_confirmed') {
                connected = true;
                if (entry.data?.accountId)
                    botId = entry.data.accountId;
            }
            if (entry.type === 'running')
                connected = true;
            if (entry.type === 'websocket' && entry.data?.status === 'connected')
                connected = true;
            if (entry.type === 'ready')
                connected = true;
            if (entry.type === 'qr_code' && !lastQrTime)
                lastQrTime = entry.timestamp;
        }
        res.json({ connected, botId, fastAgentOnline: true, lastQrTime });
    }
    catch (error) {
        console.error('[Bridge/Status]', error.message);
        res.status(500).json({ error: '获取状态失败' });
    }
});
/**
 * DELETE /api/bridge/bots/:id
 * 删除/停用 Bot 账号
 * query: ?permanent=true 彻底删除，默认仅停用
 */
router.delete('/bridge/bots/:id', auth_1.authenticate, async (req, res) => {
    try {
        const botId = parseInt(req.params.id);
        const permanent = String(req.query.permanent) === 'true';
        // 先查 bot_id 用于通知 weclaw-bridge
        const bot = await pgPool.query('SELECT bot_id FROM bot_accounts WHERE id = $1', [botId]);
        if (bot.rows.length === 0) {
            res.status(404).json({ error: 'Bot 不存在' });
            return;
        }
        const botIdStr = bot.rows[0].bot_id;
        if (permanent) {
            await pgPool.query('UPDATE bot_accounts SET is_active = FALSE, deleted_at = NOW() WHERE id = $1', [botId]);
            console.log(`[Bot] 🗑️ 永久删除: ${botIdStr}`);
        }
        else {
            await pgPool.query('UPDATE bot_accounts SET is_active = FALSE WHERE id = $1', [botId]);
            console.log(`[Bot] ⏸️ 已停用: ${botIdStr}`);
        }
        // 尝试通知 weclaw-bridge 删除 (curl /del)
        try {
            const http = require('http');
            await new Promise((resolve) => {
                const req = http.request({
                    hostname: 'weclaw-bridge', port: 26322,
                    path: '/api/connections',
                    method: 'GET',
                    timeout: 3000,
                }, () => resolve());
                req.on('error', () => resolve());
                req.end();
            });
        }
        catch { }
        res.json({ ok: true, message: permanent ? 'Bot 已删除' : 'Bot 已停用', botId: botIdStr });
    }
    catch (error) {
        console.error('[Bot] 删除失败:', error.message);
        res.status(500).json({ error: '删除失败' });
    }
});
// ---- OpeniLink 集成: 扫码登录代理 (后端持有 session, 前端无感) ----
/** 活跃的扫码会话: pollId → { status, qr_url, session_id, ws } */
const scanSessions = new Map();
function cleanupScanSession(pollId) {
    const s = scanSessions.get(pollId);
    if (s?.ws) {
        try {
            s.ws.close();
        }
        catch { }
    }
    scanSessions.delete(pollId);
}
/**
 * POST /api/bridge/scan/start — 启动微信扫码 (后端代理 OpeniLink)
 * 返回 { pollId, qr_url } — 前端用 pollId 轮询状态
 */
router.post('/bridge/scan/start', auth_1.authenticate, async (_req, res) => {
    try {
        const session = await ensureBridgeSession();
        if (!session) {
            res.status(502).json({ error: 'OpeniLink 服务不可用' });
            return;
        }
        // 1. 获取 QR URL
        const resp = await axios_1.default.post('http://openilink-hub:9800/api/auth/scan/start', {}, { headers: { Cookie: session, 'Content-Type': 'application/json' }, timeout: 10000 });
        const { qr_url, session_id } = resp.data;
        const pollId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // 2. 后端连接 OpeniLink WebSocket 监听状态
        const httpMod = require('http');
        const wsUrl = new URL(`http://openilink-hub:9800/api/auth/scan/status/${session_id}`);
        const wsReq = httpMod.request({
            hostname: wsUrl.hostname, port: wsUrl.port,
            path: wsUrl.pathname,
            headers: {
                'Upgrade': 'websocket', 'Connection': 'Upgrade',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': require('crypto').randomBytes(16).toString('base64'),
                'Cookie': session,
            },
        });
        const sessionData = { status: 'wait', qr_url, session_id, ws: null, connectedAt: 0 };
        scanSessions.set(pollId, sessionData);
        wsReq.on('upgrade', (resWs, socket) => {
            sessionData.ws = socket;
            // 简易 WebSocket 帧解析
            let buffer = '';
            socket.on('data', (chunk) => {
                buffer += chunk.toString();
                // 解析 WebSocket 文本帧 (opcode 0x1)
                try {
                    const msgs = buffer.split('\n');
                    for (const raw of msgs) {
                        if (raw.length < 2)
                            continue;
                        // 跳过 WebSocket 帧头，提取 JSON payload
                        const jsonStart = raw.indexOf('{');
                        if (jsonStart < 0)
                            continue;
                        const msg = JSON.parse(raw.substring(jsonStart));
                        if (msg.event === 'status') {
                            sessionData.status = msg.status;
                            if (msg.status === 'refreshed' && msg.qr_url)
                                sessionData.qr_url = msg.qr_url;
                            if (msg.status === 'connected') {
                                sessionData.connectedAt = Date.now();
                                syncOpeniLinkBots().catch(() => { });
                            }
                        }
                    }
                    buffer = '';
                }
                catch { }
            });
            socket.on('close', () => {
                // 5分钟后自动清理
                setTimeout(() => cleanupScanSession(pollId), 300000);
            });
        });
        wsReq.on('error', () => {
            sessionData.status = 'error';
        });
        wsReq.end();
        console.log(`[Bridge] Scan started: pollId=${pollId}`);
        res.json({ pollId, qr_url });
    }
    catch (error) {
        console.error('[Bridge] scan/start 失败:', error.message);
        res.status(500).json({ error: '生成二维码失败' });
    }
});
/**
 * GET /api/bridge/scan/poll/:pollId — 轮询扫码状态 (简单 HTTP, 无需 WebSocket)
 * 返回 { status: 'wait'|'scanned'|'refreshed'|'connected'|'error', qr_url? }
 */
router.get('/bridge/scan/poll/:pollId', auth_1.authenticate, async (req, res) => {
    const s = scanSessions.get(req.params.pollId);
    if (!s) {
        res.status(404).json({ error: '会话不存在或已过期' });
        return;
    }
    const result = { status: s.status };
    if (s.qr_url)
        result.qr_url = s.qr_url;
    if (s.status === 'connected') {
        // 连接成功后同步 Bot
        await syncOpeniLinkBots().catch(() => { });
    }
    res.json(result);
});
/**
 * 从 OpeniLink 同步 Bot 列表到 bot_accounts
 */
async function syncOpeniLinkBots() {
    try {
        const session = await ensureBridgeSession();
        if (!session)
            return;
        const resp = await axios_1.default.get('http://openilink-hub:9800/api/bots', { headers: { Cookie: session }, timeout: 10000 });
        const bots = resp.data;
        if (!Array.isArray(bots))
            return;
        for (const bot of bots) {
            const botId = bot.id || bot.bot_id || bot.wechat_id;
            if (!botId)
                continue;
            // 写入 bot_accounts (如果不存在)
            await pgPool.query(`INSERT INTO bot_accounts (bot_id, api_token, wechat_id, nickname, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (bot_id) DO UPDATE SET
           wechat_id = COALESCE($3, bot_accounts.wechat_id),
           nickname = COALESCE($4, bot_accounts.nickname),
           last_active_at = NOW()
         WHERE bot_accounts.deleted_at IS NULL`, [botId, bot.token || bot.api_token || '', botId, bot.name || bot.nickname || null]);
        }
        console.log(`[Bridge] OpeniLink bots synced: ${bots.length}`);
    }
    catch (e) {
        console.warn('[Bridge] Bot sync failed:', e.message);
    }
}
/** 管理员登录 OpeniLink Hub */
router.get('/bridge-login', auth_1.authenticate, auth_1.requireAdmin, async (_req, res) => {
    const session = await ensureBridgeSession();
    if (session) {
        res.setHeader('Set-Cookie', session + '; Path=/; HttpOnly; SameSite=Lax');
        res.json({ ok: true });
    }
    else {
        res.status(502).json({ error: '桥接服务不可用' });
    }
});
exports.default = router;
//# sourceMappingURL=bridge.js.map