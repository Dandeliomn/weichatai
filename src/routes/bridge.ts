/**
 * 微信桥接路由
 *
 * GET  /api/bridge/qr      — 获取 FastAgent 微信登录二维码
 * GET  /api/bridge/status  — 获取微信桥接连接状态
 * GET  /api/bridge-login   — 管理员登录 OpeniLink Hub（需管理员权限）
 */

import { Router, Request, Response } from 'express';
import axios from 'axios';
import { Pool } from 'pg';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

/** PostgreSQL 连接池 (由主入口注入) */
let pgPool: Pool;

export function initBridgeRoutes(pool: Pool): void {
  pgPool = pool;
}

// ---- 读取 FastAgent 日志，提取最新 QR码 和 登录状态 ----
// 支持多账号模式：读取 messages-*.jsonl 文件（每账号一个），
// 兼容旧版单文件 messages.jsonl

const FASTAGENT_DIR = '/app/fastagent-data';

function readAllAgentLogs(): Record<string, any>[] {
  const fs = require('fs');
  const path = require('path');
  const entries: Record<string, any>[] = [];

  try {
    // 读取所有 messages-*.jsonl 文件（多账号模式）
    const files = fs.readdirSync(FASTAGENT_DIR);
    const logFiles = files.filter((f: string) => /^messages(-[^.]+)?\.jsonl$/.test(f));

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
          } catch {}
        }
      } catch {}
    }
  } catch {}

  return entries;
}

// ---- OpeniLink Hub 会话管理 ----

let bridgeSessionCookie: string | null = null;
let bridgeSessionExpiry = 0;

async function ensureBridgeSession(): Promise<string | null> {
  if (bridgeSessionCookie && Date.now() < bridgeSessionExpiry) return bridgeSessionCookie;
  try {
    const resp = await axios.post('http://openilink-hub:9800/api/auth/login',
      { username: 'companion', password: 'admin123' },
      { headers: { 'Content-Type': 'application/json' } });
    const setCookie = resp.headers['set-cookie'];
    if (setCookie) {
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      const session = cookies.find((c: string) => c.startsWith('session='));
      if (session) {
        bridgeSessionCookie = session.split(';')[0];
        bridgeSessionExpiry = Date.now() + 3600000;
        return bridgeSessionCookie;
      }
    }
  } catch (e) { console.error('[Bridge] Login failed:', e); }
  return null;
}

// ---- 路由 ----

/**
 * POST /api/bridge/register-bot
 * WeClaw 桥接脚本扫码成功后调用，注册新登录的微信账号
 * 请求体: { botId, apiToken, botToken?, getUpdatesBuf?, ilinkUserId?, ilinkBaseUrl?, wechatId?, nickname?, botIndex? }
 */
router.post('/bridge/register-bot', async (req: Request, res: Response) => {
  try {
    const { botId, apiToken, botToken, getUpdatesBuf, ilinkUserId, ilinkBaseUrl, wechatId, nickname, botIndex } = req.body;
    if (!botId || !apiToken) {
      res.status(400).json({ error: '缺少 botId 或 apiToken' });
      return;
    }

    // 检查是否已被用户删除或停用
    const existing = await pgPool.query(
      'SELECT deleted_at, is_active FROM bot_accounts WHERE bot_id = $1', [botId]
    );
    if (existing.rows.length > 0 && (existing.rows[0].deleted_at != null || !existing.rows[0].is_active)) {
      console.log(`[Bot] ⏭️ 跳过已删除/停用的 Bot: ${botId}`);
      res.json({ ok: false, message: 'Bot 已被用户删除或停用', botId });
      return;
    }

    await pgPool.query(
      `INSERT INTO bot_accounts (bot_id, api_token, bot_token, get_updates_buf, ilink_user_id, ilink_base_url, wechat_id, nickname, bot_index, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
       ON CONFLICT (bot_id)
       DO UPDATE SET api_token = $2, bot_token = COALESCE($3, bot_accounts.bot_token),
                     get_updates_buf = COALESCE($4, bot_accounts.get_updates_buf),
                     ilink_user_id = COALESCE($5, bot_accounts.ilink_user_id),
                     ilink_base_url = COALESCE($6, bot_accounts.ilink_base_url),
                     wechat_id = COALESCE($7, bot_accounts.wechat_id),
                     nickname = COALESCE($8, bot_accounts.nickname),
                     last_active_at = NOW()`,
      [botId, apiToken, botToken || null, getUpdatesBuf || '', ilinkUserId || null, ilinkBaseUrl || 'https://ilinkai.weixin.qq.com', wechatId || null, nickname || null, botIndex ?? 0]
    );

    console.log(`[Bot] ✅ 注册/更新 Bot: ${botId} (idx=${botIndex})`);
    res.json({ ok: true, botId });

    // 注册成功后尝试启动 iLink 直连轮询
    startILinkPolling().catch((e: any) =>
      console.warn('[iLink] 启动轮询失败:', e.message)
    );
  } catch (error: any) {
    console.error('[Bot] 注册失败:', error.message);
    res.status(500).json({ error: 'Bot 注册失败' });
  }
});

/**
 * GET /api/bridge/bot-token?botId=xxx
 * 获取指定 Bot 的 API Token（用于发送消息）
 */
router.get('/bridge/bot-token', async (req: Request, res: Response) => {
  try {
    const { botId, wechatId } = req.query;
    let result;

    if (botId) {
      result = await pgPool.query(
        'SELECT bot_id, api_token FROM bot_accounts WHERE bot_id = $1 AND is_active = TRUE AND deleted_at IS NULL',
        [botId]
      );
    } else if (wechatId) {
      result = await pgPool.query(
        `SELECT ba.bot_id, ba.api_token FROM bot_accounts ba
         WHERE (ba.wechat_id = $1 OR ba.bot_id = $1) AND ba.is_active = TRUE AND deleted_at IS NULL
         LIMIT 1`,
        [wechatId]
      );
    } else {
      // 返回第一个活跃 bot
      result = await pgPool.query(
        'SELECT bot_id, api_token FROM bot_accounts WHERE is_active = TRUE AND deleted_at IS NULL ORDER BY bot_index LIMIT 1'
      );
    }

    if (result.rows.length === 0) {
      res.status(404).json({ error: '未找到活跃的 Bot 账号', code: 'NO_BOT' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('[Bot] Token 查询失败:', error.message);
    res.status(500).json({ error: '查询失败' });
  }
});

/** 获取 WeClaw 桥接的多个 Bot 列表 (公开接口，用于前端检测连接状态) */
/**
 * GET /api/bridge/bots
 * 返回 Bot 列表。普通用户只看自己的；管理员看全部。
 * 新增返回 character 信息。
 */
router.get('/bridge/bots', authenticate, async (req: Request, res: Response) => {
  try {
    await syncOpeniLinkBots().catch(() => {});

    const currentUserId = (req as any).user?.id;
    const isAdmin = (req as any).user?.role === 'admin';

    let query: string;
    let params: any[];

    if (isAdmin) {
      query = `SELECT b.id, b.bot_id, b.wechat_id, b.nickname, b.bot_index,
                      b.is_active, b.last_active_at, b.created_at,
                      b.character_id, b.linked_user_id,
                      ct.name AS character_name, ct.tagline AS character_tagline
               FROM bot_accounts b
               LEFT JOIN character_templates ct ON b.character_id = ct.id
               WHERE b.deleted_at IS NULL
               ORDER BY b.bot_index`;
      params = [];
    } else {
      query = `SELECT b.id, b.bot_id, b.wechat_id, b.nickname, b.bot_index,
                      b.is_active, b.last_active_at, b.created_at,
                      b.character_id, b.linked_user_id,
                      ct.name AS character_name, ct.tagline AS character_tagline
               FROM bot_accounts b
               LEFT JOIN character_templates ct ON b.character_id = ct.id
               WHERE b.deleted_at IS NULL AND b.linked_user_id = $1
               ORDER BY b.bot_index`;
      params = [currentUserId];
    }

    const result = await pgPool.query(query, params);
    const bots = result.rows.map((r: any) => ({
      id: r.id,
      bot_id: r.bot_id,
      wechat_id: r.wechat_id,
      nickname: r.nickname,
      bot_index: r.bot_index,
      is_active: r.is_active,
      last_active_at: r.last_active_at,
      created_at: r.created_at,
      character: r.character_id ? {
        id: r.character_id,
        name: r.character_name,
        tagline: r.character_tagline,
      } : null,
    }));

    const connected = bots.some((b: any) => b.is_active);
    res.json({ bots, total: bots.length, connected });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** 获取 FastAgent 微信登录二维码（所有已登录用户） */
router.get('/bridge/qr', authenticate, (_req: Request, res: Response) => {
  try {
    const entries = readAllAgentLogs();
    let latestQr: string | null = null;
    let connected = false;

    for (const entry of entries) {
      if (entry.type === 'qr_code' && entry.data?.qrCodeUrl && !latestQr) {
        latestQr = entry.data.qrCodeUrl;
      }
      if (entry.type === 'login' && entry.data?.status === 'success') connected = true;
      if (entry.type === 'login_confirmed') connected = true;
      if (entry.type === 'running') connected = true;
      if (entry.type === 'websocket' && entry.data?.status === 'connected') connected = true;
      if (entry.type === 'ready') connected = true;
    }

    res.json({ qrCodeUrl: latestQr, connected, refreshIn: 120 });
  } catch (error: any) {
    console.error('[Bridge/QR]', error.message);
    res.status(500).json({ error: '获取二维码失败' });
  }
});

/** 获取微信桥接连接状态 */
router.get('/bridge/status', authenticate, (_req: Request, res: Response) => {
  try {
    const entries = readAllAgentLogs();
    let connected = false;
    let botId: string | null = null;
    let lastQrTime: string | null = null;

    for (const entry of entries) {
      if (entry.type === 'login' && entry.data?.status === 'success') {
        connected = true;
        if (entry.data?.botId) botId = entry.data.botId;
      }
      if (entry.type === 'login_confirmed') {
        connected = true;
        if (entry.data?.accountId) botId = entry.data.accountId;
      }
      if (entry.type === 'running') connected = true;
      if (entry.type === 'websocket' && entry.data?.status === 'connected') connected = true;
      if (entry.type === 'ready') connected = true;
      if (entry.type === 'qr_code' && !lastQrTime) lastQrTime = entry.timestamp;
    }

    res.json({ connected, botId, fastAgentOnline: true, lastQrTime });
  } catch (error: any) {
    console.error('[Bridge/Status]', error.message);
    res.status(500).json({ error: '获取状态失败' });
  }
});

/**
 * DELETE /api/bridge/bots/:id
 * 删除/停用 Bot 账号
 * query: ?permanent=true 彻底删除，默认仅停用
 */
router.delete('/bridge/bots/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const botId = parseInt(req.params.id as string);
    const permanent = String(req.query.permanent) === 'true';

    // 先查 bot_id 用于通知 weclaw-bridge
    const bot = await pgPool.query('SELECT bot_id FROM bot_accounts WHERE id = $1', [botId]);
    if (bot.rows.length === 0) {
      res.status(404).json({ error: 'Bot 不存在' });
      return;
    }

    const botIdStr = bot.rows[0].bot_id;

    if (permanent) {
      await pgPool.query(
        'UPDATE bot_accounts SET is_active = FALSE, deleted_at = NOW() WHERE id = $1',
        [botId]
      );
      console.log(`[Bot] 🗑️ 永久删除: ${botIdStr}`);
    } else {
      await pgPool.query(
        'UPDATE bot_accounts SET is_active = FALSE WHERE id = $1',
        [botId]
      );
      console.log(`[Bot] ⏸️ 已停用: ${botIdStr}`);
    }

    // weclaw-bridge 的 bot_registrar 会自动检测到删除并断开 session
    // 不需要从 api-server 直接操作 weclaw-bridge

    res.json({ ok: true, message: permanent ? 'Bot 已删除' : 'Bot 已停用', botId: botIdStr });
  } catch (error: any) {
    console.error('[Bot] 删除失败:', error.message);
    res.status(500).json({ error: '删除失败' });
  }
});

// ---- OpeniLink 集成: 扫码登录代理 (后端持有 session, 前端无感) ----

/** 活跃的扫码会话: pollId → { status, qr_url, session_id, ws } */
const scanSessions = new Map<string, {
  status: string;
  qr_url: string;
  session_id: string;
  ws: any;
  connectedAt: number;
}>();

function cleanupScanSession(pollId: string) {
  const s = scanSessions.get(pollId);
  if (s?.ws) { try { s.ws.close(); } catch {} }
  scanSessions.delete(pollId);
}

/**
 * POST /api/bridge/scan/start — 启动微信扫码 (后端代理 OpeniLink)
 * 返回 { pollId, qr_url } — 前端用 pollId 轮询状态
 */
router.post('/bridge/scan/start', authenticate, async (_req: Request, res: Response) => {
  try {
    const session = await ensureBridgeSession();
    if (!session) { res.status(502).json({ error: 'OpeniLink 服务不可用' }); return; }

    // 1. 获取 QR URL
    const resp = await axios.post('http://openilink-hub:9800/api/auth/scan/start', {},
      { headers: { Cookie: session, 'Content-Type': 'application/json' }, timeout: 10000 });

    const { qr_url, session_id } = resp.data;
    const pollId = `scan_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

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

    const sessionData = { status: 'wait', qr_url, session_id, ws: null as any, connectedAt: 0 };
    scanSessions.set(pollId, sessionData);

    wsReq.on('upgrade', (resWs: any, socket: any) => {
      sessionData.ws = socket;

      // 简易 WebSocket 帧解析
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        // 解析 WebSocket 文本帧 (opcode 0x1)
        try {
          const msgs = buffer.split('\n');
          for (const raw of msgs) {
            if (raw.length < 2) continue;
            // 跳过 WebSocket 帧头，提取 JSON payload
            const jsonStart = raw.indexOf('{');
            if (jsonStart < 0) continue;
            const msg = JSON.parse(raw.substring(jsonStart));
            if (msg.event === 'status') {
              sessionData.status = msg.status;
              if (msg.status === 'refreshed' && msg.qr_url) sessionData.qr_url = msg.qr_url;
              if (msg.status === 'connected') {
                sessionData.connectedAt = Date.now();
                syncOpeniLinkBots().catch(() => {});
              }
            }
          }
          buffer = '';
        } catch {}
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
  } catch (error: any) {
    console.error('[Bridge] scan/start 失败:', error.message);
    res.status(500).json({ error: '生成二维码失败' });
  }
});

/**
 * GET /api/bridge/scan/poll/:pollId — 轮询扫码状态 (简单 HTTP, 无需 WebSocket)
 * 返回 { status: 'wait'|'scanned'|'refreshed'|'connected'|'error', qr_url? }
 */
router.get('/bridge/scan/poll/:pollId', authenticate, async (req: Request, res: Response) => {
  const s = scanSessions.get(req.params.pollId as string);
  if (!s) { res.status(404).json({ error: '会话不存在或已过期' }); return; }

  const result: any = { status: s.status };
  if (s.qr_url) result.qr_url = s.qr_url;
  if (s.status === 'connected') {
    // 连接成功后同步 Bot
    await syncOpeniLinkBots().catch(() => {});
  }
  res.json(result);
});

/**
 * 从 OpeniLink 同步 Bot 列表到 bot_accounts
 */
async function syncOpeniLinkBots(): Promise<void> {
  try {
    const session = await ensureBridgeSession();
    if (!session) return;

    const resp = await axios.get('http://openilink-hub:9800/api/bots',
      { headers: { Cookie: session }, timeout: 10000 });

    const bots = resp.data;
    if (!Array.isArray(bots)) return;

    for (const bot of bots) {
      const botId = bot.id || bot.bot_id || bot.wechat_id;
      if (!botId) continue;
      // 写入 bot_accounts (如果不存在)
      await pgPool.query(
        `INSERT INTO bot_accounts (bot_id, api_token, wechat_id, nickname, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (bot_id) DO UPDATE SET
           wechat_id = COALESCE($3, bot_accounts.wechat_id),
           nickname = COALESCE($4, bot_accounts.nickname),
           last_active_at = NOW()
         WHERE bot_accounts.deleted_at IS NULL`,
        [botId, bot.token || bot.api_token || '', botId, bot.name || bot.nickname || null]
      );
    }
    console.log(`[Bridge] OpeniLink bots synced: ${bots.length}`);
  } catch (e: any) {
    console.warn('[Bridge] Bot sync failed:', e.message);
  }
}

/** 管理员登录 OpeniLink Hub */
router.get('/bridge-login', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  const session = await ensureBridgeSession();
  if (session) {
    res.setHeader('Set-Cookie', session + '; Path=/; HttpOnly; SameSite=Lax');
    res.json({ ok: true });
  } else {
    res.status(502).json({ error: '桥接服务不可用' });
  }
});

// =========================================================================
// iLink API 直连 — 长轮询接收微信消息 (类似 Hermes 实现)
// 绕过 weclaw-bridge bot CLI, 直接用 bot_token 调用 iLink HTTP API
// =========================================================================

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
const EP_GET_UPDATES = 'ilink/bot/getupdates';

let ilinkPollingStarted = false;

async function ilinkPollLoop(botId: string, token: string, baseUrl: string, initialBuf: string) {
  let syncBuf = initialBuf;
  let consecutiveFailures = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const body = JSON.stringify({
        get_updates_buf: syncBuf,
        base_info: { channel_version: '2.2.0' },
      });
      const url = `${baseUrl || ILINK_BASE}/${EP_GET_UPDATES}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          AuthorizationType: 'ilink_bot_token',
          'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': '131584',
        },
        body,
        signal: AbortSignal.timeout(40_000),
      });

      if (!resp.ok) {
        consecutiveFailures++;
        if (consecutiveFailures > 5) {
          console.warn(`[iLink] ${botId} 连续失败${consecutiveFailures}次, 暂停30s`);
          await new Promise(r => setTimeout(r, 30_000));
          consecutiveFailures = 0;
        } else {
          await new Promise(r => setTimeout(r, 2_000));
        }
        continue;
      }

      consecutiveFailures = 0;
      const data = await resp.json() as any;
      const ret = data.ret ?? 0;
      const errcode = data.errcode ?? 0;

      if (ret === -14 || errcode === -14) {
        console.warn(`[iLink] ${botId} session 过期, 暂停10分钟`);
        await new Promise(r => setTimeout(r, 600_000));
        continue;
      }

      const newBuf = data.get_updates_buf || '';
      if (newBuf && newBuf !== syncBuf) {
        syncBuf = newBuf;
        await pgPool.query(
          'UPDATE bot_accounts SET get_updates_buf = $1 WHERE bot_id = $2',
          [syncBuf, botId]
        );
      }

      const msgs: any[] = data.msgs || [];
      for (const msg of msgs) {
        try {
          await processILinkMessage(botId, token, baseUrl, msg);
        } catch (e: any) {
          console.error(`[iLink] ${botId} 消息处理失败:`, e.message);
        }
      }
    } catch (e: any) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        continue; // 长轮询超时正常
      }
      consecutiveFailures++;
      console.warn(`[iLink] ${botId} 轮询错误:`, e.message);
      await new Promise(r => setTimeout(r, 2_000));
    }
  }
}

/** 将 iLink 消息转为 webhook 格式并提交处理 */
async function processILinkMessage(botId: string, _token: string, _baseUrl: string, msg: any) {
  const fromUserId = (msg.from_user_id || '').toString().trim();
  if (!fromUserId || fromUserId === botId) return;

  const itemList: any[] = msg.item_list || [];
  let content = '';
  for (const item of itemList) {
    if (item.type === 1) {
      content = item.text_item?.text || '';
    }
  }
  if (!content) return;

  const webhookPayload = {
    FromUserName: fromUserId,
    ToUserName: botId,
    MsgType: 'text',
    Content: content,
    CreateTime: Math.floor(Date.now() / 1000),
    MsgId: msg.message_id || `${Date.now()}`,
  };

  await fetch(`http://localhost:${process.env.PORT || 3000}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookPayload),
  }).catch((e: any) => {
    console.warn(`[iLink] webhook 转发失败:`, e.message);
  });
}

/** iLink 轮询开关 — 当 Hermes 接管时通过环境变量禁用 */
const ILINK_POLLING_ENABLED = process.env.ILINK_POLLING_ENABLED !== 'false';

/** 启动 iLink 直连轮询（从数据库加载所有活跃 bot） */
async function startILinkPolling() {
  if (!ILINK_POLLING_ENABLED) {
    console.log('[Bridge] iLink 轮询已禁用 (ILINK_POLLING_ENABLED=false)，由 Hermes 接管');
    return;
  }
  if (ilinkPollingStarted) return;
  ilinkPollingStarted = true;

  try {
    const result = await pgPool.query(
      `SELECT bot_id, api_token, bot_token, get_updates_buf, ilink_user_id, ilink_base_url
       FROM bot_accounts WHERE is_active = TRUE AND deleted_at IS NULL AND bot_token IS NOT NULL`
    );

    for (const row of result.rows) {
      const token = row.bot_token || row.api_token;
      if (!token) continue;
      console.log(`[iLink] 🚀 启动直连轮询: ${row.bot_id}`);
      ilinkPollLoop(row.bot_id, token, row.ilink_base_url || ILINK_BASE, row.get_updates_buf || '')
        .catch((e: any) => console.error(`[iLink] ${row.bot_id} 轮询异常退出:`, e.message));
    }

    if (result.rows.length === 0) {
      console.log('[iLink] 没有活跃 bot, 等待注册后启动');
      ilinkPollingStarted = false;
    }
  } catch (e: any) {
    console.error('[iLink] 启动失败:', e.message);
    ilinkPollingStarted = false;
  }
}

// 模块加载时自动尝试启动
setTimeout(() => {
  startILinkPolling().catch(() => {});
}, 5_000);

/**
 * POST /api/bridge/extract-memories — 从聊天记录提取结构化记忆
 */
router.post('/bridge/extract-memories', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { extractStructuredMemories } = require('../memory/extract');
    res.json({ status: 'started', message: '记忆提取已启动（异步执行）' });
    extractStructuredMemories(pgPool).then((count: number) => {
      console.log(`[API] ✅ 记忆提取完成: ${count} 条`);
    }).catch((e: any) => {
      console.error(`[API] ❌ 记忆提取失败:`, e.message);
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
