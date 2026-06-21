/**
 * 管理员路由
 *
 * GET    /api/admin/users           — 用户列表
 * GET    /api/admin/users/:id       — 用户详情
 * PUT    /api/admin/users/:id       — 编辑用户
 * DELETE /api/admin/users/:id       — 删除用户
 * GET    /api/admin/stats           — 系统统计
 * GET    /api/admin/queue           — 队列状态
 * GET    /api/admin/care-templates  — 关怀文案
 * PUT    /api/admin/care-templates  — 更新文案
 * POST   /api/admin/broadcast       — 广播通知
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

let pgPool: Pool;

export function initAdminRoutes(pool: Pool): void {
  pgPool = pool;
}

// 所有路由需要管理员权限
router.use(authenticate);
router.use(requireAdmin);

// =============================================================================
// GET /api/admin/users — 用户列表 (分页/搜索)
// =============================================================================
router.get('/users', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;
    const search = req.query.search as string || '';
    const role = req.query.role as string || '';

    let whereClause = 'WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      whereClause += ` AND (email ILIKE $${paramIndex} OR display_name ILIKE $${paramIndex} OR wechat_id ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }
    if (role && ['admin', 'user'].includes(role)) {
      whereClause += ` AND role = $${paramIndex}`;
      params.push(role);
      paramIndex++;
    }

    const [users, countResult] = await Promise.all([
      pgPool.query(
        `SELECT id, email, display_name, role, wechat_id, is_active, last_login_at, created_at
         FROM user_accounts ${whereClause}
         ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      ),
      pgPool.query(
        `SELECT COUNT(*) FROM user_accounts ${whereClause}`,
        params
      ),
    ]);

    // 记录操作日志
    await pgPool.query(
      `INSERT INTO admin_logs (admin_id, action, target_type, details, ip_address)
       VALUES ($1, 'list_users', 'user', $2, $3)`,
      [req.user!.userId, JSON.stringify({ search, role, page }), req.ip]
    );

    res.json({
      users: users.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    });
  } catch (error: any) {
    console.error('[Admin] 获取用户列表失败:', error.message);
    res.status(500).json({ error: '获取用户列表失败' });
  }
});

// =============================================================================
// GET /api/admin/users/:id
// =============================================================================
router.get('/users/:id', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id as string);

    const [user, profile, sessions, imports] = await Promise.all([
      pgPool.query(
        `SELECT id, email, display_name, role, wechat_id, avatar_url, is_active, last_login_at, created_at
         FROM user_accounts WHERE id = $1`,
        [userId]
      ),
      pgPool.query('SELECT * FROM user_profiles WHERE user_id = $1', [userId]),
      pgPool.query(
        `SELECT COUNT(*) FROM user_sessions WHERE user_id = $1 AND is_revoked = FALSE`,
        [userId]
      ),
      pgPool.query(
        `SELECT id, filename, status, message_count, created_at FROM import_tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [userId]
      ),
    ]);

    if (user.rows.length === 0) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    res.json({
      user: user.rows[0],
      profile: profile.rows[0] || null,
      activeSessions: parseInt(sessions.rows[0].count),
      recentImports: imports.rows,
    });
  } catch (error: any) {
    res.status(500).json({ error: '获取用户详情失败' });
  }
});

// =============================================================================
// PUT /api/admin/users/:id
// =============================================================================
router.put('/users/:id', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id as string);
    const { isActive, role } = req.body;

    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (typeof isActive === 'boolean') {
      updates.push(`is_active = $${paramIndex}`);
      params.push(isActive);
      paramIndex++;
    }
    if (role && ['admin', 'user'].includes(role)) {
      updates.push(`role = $${paramIndex}`);
      params.push(role);
      paramIndex++;
    }

    if (updates.length === 0) {
      res.status(400).json({ error: '没有提供要更新的字段' });
      return;
    }

    params.push(userId);
    const result = await pgPool.query(
      `UPDATE user_accounts SET ${updates.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, email, display_name, role, is_active`,
      params
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    // 记录日志
    await pgPool.query(
      `INSERT INTO admin_logs (admin_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'update_user', 'user', $2, $3, $4)`,
      [req.user!.userId, userId, JSON.stringify(req.body), req.ip]
    );

    res.json({ user: result.rows[0], message: '更新成功' });
  } catch (error: any) {
    res.status(500).json({ error: '更新失败' });
  }
});

// =============================================================================
// DELETE /api/admin/users/:id
// =============================================================================
router.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id as string);

    // 不允许删除自己
    if (userId === req.user!.userId) {
      res.status(400).json({ error: '不能删除自己的账号' });
      return;
    }

    const result = await pgPool.query(
      'DELETE FROM user_accounts WHERE id = $1 RETURNING id, email',
      [userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    await pgPool.query(
      `INSERT INTO admin_logs (admin_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'delete_user', 'user', $2, $3, $4)`,
      [req.user!.userId, userId, JSON.stringify({ email: result.rows[0].email }), req.ip]
    );

    res.json({ message: '用户已删除' });
  } catch (error: any) {
    res.status(500).json({ error: '删除失败' });
  }
});

// =============================================================================
// GET /api/admin/stats — 系统统计仪表盘
// =============================================================================
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [
      accountStats,
      wechatUserStats,
      messageStats,
      emotionStats,
      importStats,
      activeStats,
    ] = await Promise.all([
      pgPool.query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE role='admin') as admins,
           COUNT(*) FILTER (WHERE role='user') as users,
           COUNT(*) FILTER (WHERE is_active=TRUE) as active,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as new_this_week
         FROM user_accounts`
      ),
      pgPool.query(
        `SELECT COUNT(*) as total, SUM(total_messages) as total_messages
         FROM users WHERE is_active = TRUE`
      ),
      pgPool.query(
        `SELECT COUNT(*) as total,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as today
         FROM conversation_logs`
      ),
      pgPool.query(
        `SELECT emotion, COUNT(*) as count
         FROM conversation_logs WHERE emotion IS NOT NULL
         GROUP BY emotion ORDER BY count DESC`
      ),
      pgPool.query(
        `SELECT COUNT(*) as total,
                COUNT(*) FILTER (WHERE status='done') as completed,
                COUNT(*) FILTER (WHERE status='processing') as processing,
                SUM(message_count) as total_messages_imported
         FROM import_tasks`
      ),
      pgPool.query(
        `SELECT COUNT(*) as today_active
         FROM users WHERE last_active_at > NOW() - INTERVAL '24 hours'`
      ),
    ]);

    res.json({
      accounts: accountStats.rows[0],
      wechatUsers: wechatUserStats.rows[0],
      messages: messageStats.rows[0],
      emotions: emotionStats.rows,
      imports: importStats.rows[0],
      active: activeStats.rows[0],
    });
  } catch (error: any) {
    console.error('[Admin] 获取统计失败:', error.message);
    res.status(500).json({ error: '获取统计失败' });
  }
});

// =============================================================================
// GET /api/admin/queue — 队列状态
// =============================================================================
router.get('/queue', async (_req: Request, res: Response) => {
  try {
    const { Queue } = require('bullmq');
    const Redis = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
      maxRetriesPerRequest: null,
    });
    const queue = new Queue('wechat-messages', { connection: redis });

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    await queue.close();
    await redis.quit();

    res.json({ waiting, active, completed, failed, delayed });
  } catch (error: any) {
    res.status(500).json({ error: '获取队列状态失败' });
  }
});

// =============================================================================
// GET /api/admin/care-templates
// =============================================================================
router.get('/care-templates', async (req: Request, res: Response) => {
  try {
    const type = req.query.type as string || '';
    let query = 'SELECT * FROM care_templates';
    const params: any[] = [];

    if (type && ['morning', 'afternoon', 'evening'].includes(type)) {
      query += ' WHERE schedule_type = $1';
      params.push(type);
    }

    query += ' ORDER BY schedule_type, sort_order';

    const result = await pgPool.query(query, params);
    res.json({ templates: result.rows });
  } catch (error: any) {
    res.status(500).json({ error: '获取文案失败' });
  }
});

// =============================================================================
// PUT /api/admin/care-templates — 批量更新文案
// =============================================================================
router.put('/care-templates', async (req: Request, res: Response) => {
  try {
    const { templates } = req.body;

    if (!Array.isArray(templates)) {
      res.status(400).json({ error: 'templates 必须是数组' });
      return;
    }

    for (const t of templates) {
      if (t.id) {
        await pgPool.query(
          `UPDATE care_templates
           SET content = COALESCE($1, content),
               schedule_type = COALESCE($2, schedule_type),
               is_active = COALESCE($3, is_active),
               sort_order = COALESCE($4, sort_order)
           WHERE id = $5`,
          [t.content, t.scheduleType, t.isActive, t.sortOrder, t.id]
        );
      } else {
        await pgPool.query(
          `INSERT INTO care_templates (schedule_type, content, sort_order, created_by)
           VALUES ($1, $2, $3, $4)`,
          [t.scheduleType || 'morning', t.content, t.sortOrder || 0, req.user!.userId]
        );
      }
    }

    await pgPool.query(
      `INSERT INTO admin_logs (admin_id, action, target_type, details, ip_address)
       VALUES ($1, 'update_care_templates', 'template', $2, $3)`,
      [req.user!.userId, JSON.stringify({ count: templates.length }), req.ip]
    );

    res.json({ message: `已更新 ${templates.length} 条文案` });
  } catch (error: any) {
    res.status(500).json({ error: '更新失败' });
  }
});

// =============================================================================
// GET /api/admin/logs — 操作日志
// =============================================================================
router.get('/logs', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = (page - 1) * limit;

    const [logs, countResult] = await Promise.all([
      pgPool.query(
        `SELECT al.*, ua.email as admin_email
         FROM admin_logs al
         LEFT JOIN user_accounts ua ON al.admin_id = ua.id
         ORDER BY al.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pgPool.query('SELECT COUNT(*) FROM admin_logs'),
    ]);

    res.json({
      logs: logs.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (error: any) {
    res.status(500).json({ error: '获取日志失败' });
  }
});

// =============================================================================
// GET /api/admin/conversations — 全局对话日志搜索
// =============================================================================
router.get('/conversations', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;
    const wechatId = req.query.wechat_id as string || '';
    const keyword = req.query.keyword as string || '';
    const emotion = req.query.emotion as string || '';
    const dateFrom = req.query.date_from as string || '';
    const dateTo = req.query.date_to as string || '';

    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (wechatId) { conditions.push(`cl.wechat_id ILIKE $${idx}`); params.push(`%${wechatId}%`); idx++; }
    if (keyword) { conditions.push(`cl.content ILIKE $${idx}`); params.push(`%${keyword}%`); idx++; }
    if (emotion && ['happy','sad','angry','anxious','neutral'].includes(emotion)) { conditions.push(`cl.emotion = $${idx}`); params.push(emotion); idx++; }
    if (dateFrom) { conditions.push(`cl.created_at >= $${idx}::timestamp`); params.push(dateFrom); idx++; }
    if (dateTo) { conditions.push(`cl.created_at <= $${idx}::timestamp`); params.push(dateTo); idx++; }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const [logs, countResult] = await Promise.all([
      pgPool.query(`SELECT cl.id, cl.user_id, cl.wechat_id, cl.role, cl.content, cl.emotion, cl.emotion_confidence, cl.media_type, cl.created_at, u.nickname FROM conversation_logs cl LEFT JOIN users u ON cl.user_id = u.id ${where} ORDER BY cl.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]),
      pgPool.query(`SELECT COUNT(*) FROM conversation_logs cl ${where}`, params),
    ]);
    res.json({ logs: logs.rows, total: parseInt(countResult.rows[0].count), page, limit, totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit) });
  } catch (error: any) { console.error('[Admin] conversations error:', error.message); res.status(500).json({ error: '获取对话日志失败' }); }
});

// =============================================================================
// GET /api/admin/users/:id/emotions — 用户情绪分布
// =============================================================================
router.get('/users/:id/emotions', async (req: Request, res: Response) => {
  try {
    const result = await pgPool.query(`SELECT emotion, COUNT(*) as count FROM conversation_logs WHERE user_id = $1 AND emotion IS NOT NULL GROUP BY emotion ORDER BY count DESC`, [parseInt(req.params.id as string)]);
    res.json({ emotions: result.rows });
  } catch (error: any) { res.status(500).json({ error: '获取情绪分布失败' }); }
});

// =============================================================================
// GET /api/admin/users/:id/conversations — 用户对话记录
// =============================================================================
router.get('/users/:id/conversations', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id as string);
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;
    const [logs, countResult] = await Promise.all([
      pgPool.query(`SELECT id, role, content, emotion, emotion_confidence, media_type, created_at FROM conversation_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [userId, limit, offset]),
      pgPool.query('SELECT COUNT(*) FROM conversation_logs WHERE user_id = $1', [userId]),
    ]);
    res.json({ logs: logs.rows, total: parseInt(countResult.rows[0].count), page, limit, totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit) });
  } catch (error: any) { res.status(500).json({ error: '获取对话记录失败' }); }
});

// =============================================================================
// GET /api/admin/users/:id/memories — 用户长期记忆
// =============================================================================
router.get('/users/:id/memories', async (req: Request, res: Response) => {
  try {
    const result = await pgPool.query(`SELECT id, summary_text, keywords, emotion, importance, memory_type, created_at FROM user_memories WHERE user_id = $1 ORDER BY importance DESC, created_at DESC`, [parseInt(req.params.id as string)]);
    res.json({ memories: result.rows });
  } catch (error: any) { res.status(500).json({ error: '获取记忆失败' }); }
});

// =============================================================================
// GET /api/admin/users/:id/summaries — 用户每日摘要
// =============================================================================
router.get('/users/:id/summaries', async (req: Request, res: Response) => {
  try {
    const result = await pgPool.query(`SELECT id, summary_date, summary_text, mood_summary, topic_keywords, message_count FROM daily_summaries WHERE user_id = $1 ORDER BY summary_date DESC LIMIT 30`, [parseInt(req.params.id as string)]);
    res.json({ summaries: result.rows });
  } catch (error: any) { res.status(500).json({ error: '获取摘要失败' }); }
});

// =============================================================================
// POST /api/admin/invite-codes — 生成邀请码
// =============================================================================
router.post('/invite-codes', async (req: Request, res: Response) => {
  try {
    const { count, maxUses } = req.body;
    const n = Math.min(count || 1, 50);
    const uses = maxUses || 1;
    const codes: string[] = [];
    for (let i = 0; i < n; i++) {
      const code = 'IC' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
      await pgPool.query('INSERT INTO invite_codes (code, created_by, max_uses) VALUES ($1,$2,$3)', [code, req.user!.userId, uses]);
      codes.push(code);
    }
    res.json({ codes, message: `已生成 ${n} 个邀请码` });
  } catch (error: any) { res.status(500).json({ error: '生成失败' }); }
});

// =============================================================================
// GET /api/admin/invite-codes — 邀请码列表
// =============================================================================
router.get('/invite-codes', async (_req: Request, res: Response) => {
  try {
    const result = await pgPool.query(
      `SELECT ic.*, ua.email as creator_email FROM invite_codes ic
       LEFT JOIN user_accounts ua ON ic.created_by = ua.id
       ORDER BY ic.created_at DESC LIMIT 100`
    );
    res.json({ codes: result.rows });
  } catch (error: any) { res.status(500).json({ error: '获取失败' }); }
});

// =============================================================================
// POST /api/admin/recharge-codes — 生成充值码
// =============================================================================
router.post('/recharge-codes', async (req: Request, res: Response) => {
  try {
    const { count, credits } = req.body;
    const n = Math.min(count || 1, 20);
    const cr = Math.max(credits || 100, 10);
    const codes: string[] = [];
    for (let i = 0; i < n; i++) {
      const code = 'RC' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
      await pgPool.query('INSERT INTO recharge_codes (code, credits, created_by) VALUES ($1,$2,$3)', [code, cr, req.user!.userId]);
      codes.push(code);
    }
    res.json({ codes, message: `已生成 ${n} 个充值码 (每个 ${cr} 积分)` });
  } catch (error: any) { res.status(500).json({ error: '生成失败' }); }
});

// =============================================================================
// GET /api/admin/recharge-codes — 充值码列表
// =============================================================================
router.get('/recharge-codes', async (_req: Request, res: Response) => {
  try {
    const result = await pgPool.query(
      `SELECT rc.*, ua.email as creator_email, ub.email as used_by_email
       FROM recharge_codes rc
       LEFT JOIN user_accounts ua ON rc.created_by = ua.id
       LEFT JOIN user_accounts ub ON rc.used_by = ub.id
       ORDER BY rc.created_at DESC LIMIT 100`
    );
    res.json({ codes: result.rows });
  } catch (error: any) { res.status(500).json({ error: '获取失败' }); }
});

// =============================================================================
// PUT /api/admin/users/:id/membership — 调整会员等级
// =============================================================================
router.put('/users/:id/membership', async (req: Request, res: Response) => {
  try {
    const { tier } = req.body;
    if (![1,2,3,4].includes(tier)) { res.status(400).json({ error: '无效等级' }); return; }
    await pgPool.query('UPDATE user_accounts SET membership=$1 WHERE id=$2', [tier, parseInt(req.params.id as string)]);
    res.json({ message: '会员等级已更新' });
  } catch (error: any) { res.status(500).json({ error: '更新失败' }); }
});

// =============================================================================
// GET /api/admin/config — 系统配置
// =============================================================================
router.get('/config', async (_req: Request, res: Response) => {
  try {
    const r = await pgPool.query('SELECT key, value FROM system_config');
    const config: any = {};
    r.rows.forEach((row: any) => { config[row.key] = row.value; });
    res.json(config);
  } catch (error: any) { res.status(500).json({ error: '获取失败' }); }
});

// =============================================================================
// PUT /api/admin/config — 更新系统配置
// =============================================================================
router.put('/config', async (req: Request, res: Response) => {
  try {
    const { key, value } = req.body;
    await pgPool.query(
      'INSERT INTO system_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
      [key, value]
    );
    res.json({ message: '配置已更新' });
  } catch (error: any) { res.status(500).json({ error: '更新失败' }); }
});

// =============================================================================
// GET /api/admin/dashboard — 仪表盘聚合统计
// =============================================================================
router.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    const [users, trend] = await Promise.all([
      pgPool.query(`SELECT (SELECT COUNT(*) FROM users WHERE is_active = TRUE) as total_users, (SELECT COUNT(*) FROM conversation_logs WHERE created_at > CURRENT_DATE) as today_messages, (SELECT COUNT(*) FROM users WHERE last_active_at > NOW() - INTERVAL '3 days') as active_users_3d, (SELECT COUNT(*) FROM conversation_logs) as total_messages`),
      pgPool.query(`SELECT summary_date::text, message_count FROM daily_summaries WHERE summary_date >= CURRENT_DATE - INTERVAL '7 days' ORDER BY summary_date ASC`),
    ]);
    const trendData: { date: string; messages: number }[] = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const ds = d.toISOString().split('T')[0]; const row = trend.rows.find((r: any) => r.summary_date === ds); trendData.push({ date: ds, messages: row ? parseInt(row.message_count) || 0 : 0 }); }
    res.json({ totalUsers: parseInt(users.rows[0].total_users) || 0, todayMessages: parseInt(users.rows[0].today_messages) || 0, activeUsers3d: parseInt(users.rows[0].active_users_3d) || 0, totalMessages: parseInt(users.rows[0].total_messages) || 0, trend: trendData });
  } catch (error: any) { console.error('[Admin] dashboard error:', error.message); res.status(500).json({ error: '获取仪表盘数据失败' }); }
});

export default router;
