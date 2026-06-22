/**
 * 微信桥接路由
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

/** PostgreSQL 连接池 (由主入口注入) */
let pgPool: Pool;

export function initBridgeRoutes(pool: Pool): void {
  pgPool = pool;
}

// ---- 路由 ----

/**
 * POST /api/bridge/register-bot
 * WeClaw 桥接脚本扫码成功后调用，注册新登录的微信账号
 * 请求体: { botId, apiToken, botToken?, getUpdatesBuf?, ilinkUserId?, ilinkBaseUrl?, wechatId?, nickname?, botIndex? }
 */
router.post('/bridge/register-bot', async (req: Request, res: Response) => {
  try {
    const { botId, apiToken, botToken, getUpdatesBuf, ilinkUserId, ilinkBaseUrl, wechatId, nickname, botIndex, character_id, linked_user_id } = req.body;
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
      `INSERT INTO bot_accounts (bot_id, api_token, bot_token, get_updates_buf, ilink_user_id, ilink_base_url, wechat_id, nickname, bot_index, character_id, linked_user_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
       ON CONFLICT (bot_id)
       DO UPDATE SET api_token = $2, bot_token = COALESCE($3, bot_accounts.bot_token),
                     get_updates_buf = COALESCE($4, bot_accounts.get_updates_buf),
                     ilink_user_id = COALESCE($5, bot_accounts.ilink_user_id),
                     ilink_base_url = COALESCE($6, bot_accounts.ilink_base_url),
                     wechat_id = COALESCE($7, bot_accounts.wechat_id),
                     nickname = COALESCE($8, bot_accounts.nickname),
                     linked_user_id = COALESCE($11, bot_accounts.linked_user_id),
                     character_id = COALESCE($10, bot_accounts.character_id),
                     last_active_at = NOW()`,
      [botId, apiToken, botToken || null, getUpdatesBuf || '', ilinkUserId || null, ilinkBaseUrl || 'https://ilinkai.weixin.qq.com', wechatId || null, nickname || null, botIndex ?? 0, character_id || null, linked_user_id || null]
    );

    // 如果有 character_id，同步激活 user_characters
    if (character_id && linked_user_id) {
      await pgPool.query(
        `INSERT INTO user_characters (user_id, template_id, linked_wechat_id, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (user_id, template_id, linked_wechat_id)
         DO UPDATE SET is_active = TRUE, updated_at = NOW()`,
        [linked_user_id, character_id, wechatId || botId]
      );
    }

    console.log(`[Bot] ✅ 注册/更新 Bot: ${botId} (idx=${botIndex})`);
    res.json({ ok: true, botId });
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

/**
 * DELETE /api/bridge/bots/:id
 * 删除/停用 Bot 账号
 * query: ?permanent=true 彻底删除，默认仅停用
 */
router.delete('/bridge/bots/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const botId = parseInt(req.params.id as string);
    const permanent = String(req.query.permanent) === 'true';
    const currentUserId = (req as any).user?.id;
    const isAdmin = (req as any).user?.role === 'admin';

    // 非管理员只能操作自己的 bot
    const botCheck = await pgPool.query(
      'SELECT linked_user_id FROM bot_accounts WHERE id = $1', [botId]
    );
    if (!isAdmin && botCheck.rows[0]?.linked_user_id !== currentUserId) {
      res.status(403).json({ error: '无权限操作此 Bot' });
      return;
    }

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

    res.json({ ok: true, message: permanent ? 'Bot 已删除' : 'Bot 已停用', botId: botIdStr });
  } catch (error: any) {
    console.error('[Bot] 删除失败:', error.message);
    res.status(500).json({ error: '删除失败' });
  }
});

/**
 * PUT /api/bridge/bots/:id/character
 * 更换 Bot 的角色
 * Body: { character_id: number }
 */
router.put('/bridge/bots/:id/character', authenticate, async (req: Request, res: Response) => {
  try {
    const botId = parseInt(req.params.id as string);
    const { character_id } = req.body;
    const currentUserId = (req as any).user?.id;
    const isAdmin = (req as any).user?.role === 'admin';

    if (!character_id) {
      res.status(400).json({ error: '缺少 character_id' });
      return;
    }

    // 权限检查：admin 或 bot owner
    const bot = await pgPool.query(
      'SELECT linked_user_id, wechat_id FROM bot_accounts WHERE id = $1 AND deleted_at IS NULL',
      [botId]
    );
    if (bot.rows.length === 0) {
      res.status(404).json({ error: 'Bot 不存在' });
      return;
    }
    if (!isAdmin && bot.rows[0].linked_user_id !== currentUserId) {
      res.status(403).json({ error: '无权限' });
      return;
    }

    await pgPool.query(
      'UPDATE bot_accounts SET character_id = $1, linked_user_id = COALESCE(linked_user_id, $2) WHERE id = $3',
      [character_id, currentUserId, botId]
    );

    // 同步 user_characters
    const wechatId = bot.rows[0].wechat_id;
    if (currentUserId && wechatId) {
      await pgPool.query(
        `INSERT INTO user_characters (user_id, template_id, linked_wechat_id, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (user_id, template_id, linked_wechat_id)
         DO UPDATE SET template_id = $2, is_active = TRUE, updated_at = NOW()`,
        [currentUserId, character_id, wechatId]
      );
    }

    console.log(`[Bot] 🔄 ${botId} 角色 → ${character_id}`);
    res.json({ ok: true });
  } catch (error: any) {
    console.error('[Bot] 换角色失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});


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
