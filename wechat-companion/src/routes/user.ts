/**
 * 用户门户路由
 *
 * GET  /api/user/profile          — 个人资料
 * PUT  /api/user/profile          — 更新资料
 * GET  /api/user/conversations    — 对话历史 (分页)
 * GET  /api/user/memories         — 长期记忆
 * GET  /api/user/stats            — 情绪统计
 * PUT  /api/user/ai-prefs         — AI 偏好设置
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { authenticate } from '../middleware/auth';

const router = Router();

let pgPool: Pool;

export function initUserRoutes(pool: Pool): void {
  pgPool = pool;
}

// 所有路由需要认证
router.use(authenticate);

// =============================================================================
// GET /api/user/profile
// =============================================================================
router.get('/profile', async (req: Request, res: Response) => {
  try {
    const user = await pgPool.query(
      `SELECT id, email, display_name, role, wechat_id, avatar_url, is_active,
              last_login_at, created_at
       FROM user_accounts WHERE id = $1`,
      [req.user!.userId]
    );

    const profile = await pgPool.query(
      `SELECT * FROM user_profiles WHERE user_id = $1`,
      [req.user!.userId]
    );

    // 获取关联的微信用户统计
    let wechatStats = null;
    if (user.rows[0]?.wechat_id) {
      const stats = await pgPool.query(
        `SELECT total_messages, first_active_at, last_active_at
         FROM users WHERE wechat_id = $1`,
        [user.rows[0].wechat_id]
      );
      wechatStats = stats.rows[0] || null;
    }

    res.json({
      ...user.rows[0],
      profile: profile.rows[0] || null,
      wechatStats,
    });
  } catch (error: any) {
    console.error('[User] 获取资料失败:', error.message);
    res.status(500).json({ error: '获取资料失败' });
  }
});

// =============================================================================
// PUT /api/user/profile
// =============================================================================
router.put('/profile', async (req: Request, res: Response) => {
  try {
    const { displayName, avatarUrl } = req.body;

    const result = await pgPool.query(
      `UPDATE user_accounts
       SET display_name = COALESCE($1, display_name),
           avatar_url = COALESCE($2, avatar_url)
       WHERE id = $3
       RETURNING id, email, display_name, avatar_url`,
      [displayName || null, avatarUrl || null, req.user!.userId]
    );

    res.json({ user: result.rows[0], message: '更新成功' });
  } catch (error: any) {
    res.status(500).json({ error: '更新失败' });
  }
});

// =============================================================================
// GET /api/user/conversations — 分页查看对话历史
// =============================================================================
router.get('/conversations', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;

    // 需要先获取关联的 wechat_id
    const user = await pgPool.query(
      'SELECT wechat_id FROM user_accounts WHERE id = $1',
      [req.user!.userId]
    );

    if (!user.rows[0]?.wechat_id) {
      res.json({ conversations: [], total: 0, page, limit });
      return;
    }

    const wechatId = user.rows[0].wechat_id;

    // 查询对话
    const [convResult, countResult] = await Promise.all([
      pgPool.query(
        `SELECT id, role, content, emotion, emotion_confidence, created_at
         FROM conversation_logs
         WHERE wechat_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [wechatId, limit, offset]
      ),
      pgPool.query(
        `SELECT COUNT(*) FROM conversation_logs WHERE wechat_id = $1`,
        [wechatId]
      ),
    ]);

    res.json({
      conversations: convResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
    });
  } catch (error: any) {
    console.error('[User] 获取对话失败:', error.message);
    res.status(500).json({ error: '获取对话历史失败' });
  }
});

// =============================================================================
// GET /api/user/memories — 长期记忆
// =============================================================================
router.get('/memories', async (req: Request, res: Response) => {
  try {
    const user = await pgPool.query(
      'SELECT wechat_id FROM user_accounts WHERE id = $1',
      [req.user!.userId]
    );

    if (!user.rows[0]?.wechat_id) {
      res.json({ memories: [] });
      return;
    }

    // 找到 users 表中的记录
    const wechatUser = await pgPool.query(
      'SELECT id FROM users WHERE wechat_id = $1',
      [user.rows[0].wechat_id]
    );

    if (wechatUser.rows.length === 0) {
      res.json({ memories: [] });
      return;
    }

    const memories = await pgPool.query(
      `SELECT id, summary_text, keywords, emotion, importance, memory_type, created_at
       FROM user_memories
       WHERE user_id = $1
       ORDER BY importance DESC, updated_at DESC
       LIMIT 50`,
      [wechatUser.rows[0].id]
    );

    res.json({ memories: memories.rows });
  } catch (error: any) {
    res.status(500).json({ error: '获取记忆失败' });
  }
});

// =============================================================================
// GET /api/user/stats — 情绪统计
// =============================================================================
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const user = await pgPool.query(
      'SELECT wechat_id FROM user_accounts WHERE id = $1',
      [req.user!.userId]
    );

    if (!user.rows[0]?.wechat_id) {
      res.json({ stats: { totalMessages: 0 } });
      return;
    }

    const stats = await pgPool.query(
      `SELECT
         COUNT(*) as total_messages,
         COUNT(*) FILTER (WHERE role = 'user') as user_messages,
         COUNT(*) FILTER (WHERE role = 'assistant') as assistant_messages,
         COUNT(DISTINCT DATE(created_at)) as active_days
       FROM conversation_logs
       WHERE wechat_id = $1`,
      [user.rows[0].wechat_id]
    );

    // 情绪分布
    const emotions = await pgPool.query(
      `SELECT emotion, COUNT(*) as count
       FROM conversation_logs
       WHERE wechat_id = $1 AND emotion IS NOT NULL
       GROUP BY emotion
       ORDER BY count DESC`,
      [user.rows[0].wechat_id]
    );

    // 最近7天趋势
    const trend = await pgPool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM conversation_logs
       WHERE wechat_id = $1 AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at)
       ORDER BY date`,
      [user.rows[0].wechat_id]
    );

    res.json({
      stats: stats.rows[0],
      emotions: emotions.rows,
      trend: trend.rows,
    });
  } catch (error: any) {
    res.status(500).json({ error: '获取统计失败' });
  }
});

// =============================================================================
// PUT /api/user/ai-prefs — AI 陪伴偏好
// =============================================================================
router.put('/ai-prefs', async (req: Request, res: Response) => {
  try {
    const { personality, communicationStyle, hobbies, customPrompt, modelPrefs } = req.body;

    const result = await pgPool.query(
      `INSERT INTO user_profiles (user_id, personality, communication_style, hobbies, custom_prompt, model_prefs)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id)
       DO UPDATE SET
         personality = COALESCE(EXCLUDED.personality, user_profiles.personality),
         communication_style = COALESCE(EXCLUDED.communication_style, user_profiles.communication_style),
         hobbies = COALESCE(EXCLUDED.hobbies, user_profiles.hobbies),
         custom_prompt = COALESCE(EXCLUDED.custom_prompt, user_profiles.custom_prompt),
         model_prefs = COALESCE(EXCLUDED.model_prefs, user_profiles.model_prefs),
         updated_at = NOW()
       RETURNING *`,
      [
        req.user!.userId,
        personality || null,
        communicationStyle || null,
        hobbies || null,
        customPrompt || null,
        JSON.stringify(modelPrefs || {}),
      ]
    );

    res.json({ profile: result.rows[0], message: 'AI 偏好已更新' });
  } catch (error: any) {
    console.error('[User] 更新偏好失败:', error.message);
    res.status(500).json({ error: '更新失败' });
  }
});

// =============================================================================
// PUT /api/user/password — 修改密码
// =============================================================================
// =============================================================================
// GET /api/user/invite-codes — 查看自己生成的邀请码
// =============================================================================
router.get('/invite-codes', async (req: Request, res: Response) => {
  try {
    const result = await pgPool.query(
      'SELECT * FROM invite_codes WHERE created_by=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user!.userId]
    );
    res.json({ codes: result.rows });
  } catch (error: any) { res.status(500).json({ error: '获取失败' }); }
});

// =============================================================================
// POST /api/user/invite-codes — 用户生成邀请码 (免费，可复用)
// =============================================================================
router.post('/invite-codes', async (req: Request, res: Response) => {
  try {
    const count = Math.min(req.body.count || 1, 10);
    const maxUses = req.body.maxUses || 0; // 0=不限次数
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const code = 'IC' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
      await pgPool.query('INSERT INTO invite_codes (code, created_by, max_uses, bonus_credits, invitee_credits) VALUES ($1,$2,$3,100,50)', [code, req.user!.userId, maxUses || 999]);
      codes.push(code);
    }
    res.json({ codes, message: `已生成 ${count} 个邀请码` });
  } catch (error: any) { res.status(500).json({ error: '生成失败' }); }
});

// =============================================================================
// GET /api/user/credits — 查询积分+会员
// =============================================================================
router.get('/credits', async (req: Request, res: Response) => {
  try {
    const { getTier } = require('../modules/membership');
    const r = await pgPool.query('SELECT credits, membership FROM user_accounts WHERE id=$1', [req.user!.userId]);
    const tier = getTier(r.rows[0]?.membership || 1);
    res.json({ credits: r.rows[0]?.credits || 0, membership: r.rows[0]?.membership || 1, tier });
  } catch { res.status(500).json({ error: '查询失败' }); }
});

// =============================================================================
// POST /api/user/redeem — 兑换充值码
// =============================================================================
router.post('/redeem', async (req: Request, res: Response) => {
  try {
    const { code } = req.body;
    const r = await pgPool.query('SELECT * FROM recharge_codes WHERE code=$1 AND is_used=FALSE', [code]);
    if (r.rows.length === 0) { res.status(400).json({ error: '充值码无效或已使用' }); return; }
    const rc = r.rows[0];
    await pgPool.query('UPDATE recharge_codes SET is_used=TRUE, used_by=$1, used_at=NOW() WHERE id=$2', [req.user!.userId, rc.id]);
    await pgPool.query('UPDATE user_accounts SET credits = credits + $1 WHERE id=$2', [rc.credits, req.user!.userId]);
    res.json({ credits: rc.credits, message: `成功充值 ${rc.credits} 积分！` });
  } catch (error: any) { res.status(500).json({ error: '兑换失败' }); }
});

// =============================================================================
// POST /api/user/upgrade — 积分购买升级会员
// =============================================================================
router.post('/upgrade', async (req: Request, res: Response) => {
  try {
    const { tier } = req.body;
    const { buyMembership } = require('../modules/membership');
    const err = await buyMembership(pgPool, req.user!.userId, tier);
    if (err) { res.status(400).json({ error: err }); return; }
    const r = await pgPool.query('SELECT membership FROM user_accounts WHERE id=$1', [req.user!.userId]);
    res.json({ membership: r.rows[0].membership, message: '升级成功！' });
  } catch (error: any) { res.status(500).json({ error: '升级失败' }); }
});

// =============================================================================
// POST /api/user/stickers — 上传表情包
// =============================================================================
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
const stickerUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => {
      const dir = `/app/stickers/${(_req as any).user?.userId || 'default'}`;
      require('fs').mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
}).array('stickers', 20);

router.post('/stickers', (req: any, res: any) => {
  stickerUpload(req, res, async (err: any) => {
    if (err) { res.status(400).json({ error: err.message }); return; }
    const files = (req.files as any[]) || [];
    // 解压 zip
    const results: string[] = [];
    for (const f of files) {
      if (f.originalname.endsWith('.zip')) {
        try {
          const { execSync } = require('child_process');
          const dir = `/app/stickers/${req.user.userId}`;
          execSync(`unzip -o "${f.path}" -d "${dir}"`, { timeout: 15000 });
          const extracted = require('fs').readdirSync(dir).filter((x: string) => /\.(gif|png|jpg|jpeg|webp)$/i.test(x));
          results.push(...extracted.map((x: string) => `/stickers/${req.user.userId}/${x}`));
          require('fs').unlinkSync(f.path);
        } catch (e: any) { results.push(`zip提取失败: ${e.message}`); }
      } else {
        results.push(`/stickers/${req.user.userId}/${f.filename}`);
      }
    }
    res.json({ stickers: results, message: `上传成功 ${results.length} 个表情` });
  });
});

// =============================================================================
// GET /api/user/stickers — 我的表情列表
// =============================================================================
router.get('/stickers', (req: any, res: any) => {
  try {
    const dir = `/app/stickers/${req.user.userId}`;
    if (!require('fs').existsSync(dir)) { res.json({ stickers: [] }); return; }
    const files = require('fs').readdirSync(dir).filter((x: string) => /\.(gif|png|jpg|jpeg|webp)$/i.test(x));
    res.json({ stickers: files.map((f: string) => `/stickers/${req.user.userId}/${f}`) });
  } catch { res.json({ stickers: [] }); }
});

// =============================================================================
// DELETE /api/user/stickers — 删除表情包 (单个/批量/全部)
// body: { files: ["/stickers/1/xxx.gif", ...] } 或 { all: true }
// =============================================================================
router.delete('/stickers', (req: any, res: any) => {
  try {
    const dir = `/app/stickers/${req.user.userId}`;
    const fs = require('fs');
    const path = require('path');

    if (!fs.existsSync(dir)) {
      res.json({ deleted: 0, message: '没有表情包可删除' });
      return;
    }

    if (req.body?.all) {
      // 一键删除全部
      const files = fs.readdirSync(dir);
      let count = 0;
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(dir, f));
          count++;
        } catch (e: any) {
          console.error(`[Stickers] 删除失败: ${f}`, e.message);
        }
      }
      res.json({ deleted: count, message: `已删除全部 ${count} 个表情` });
      return;
    }

    if (Array.isArray(req.body?.files) && req.body.files.length > 0) {
      // 批量选择删除
      let count = 0;
      for (const filePath of req.body.files) {
        // 从 URL 提取文件名 (安全校验: 确保路径属于该用户)
        const filename = path.basename(filePath);
        const fullPath = path.join(dir, filename);
        // 防止路径穿越攻击
        if (fullPath.startsWith(dir) && fs.existsSync(fullPath)) {
          try {
            fs.unlinkSync(fullPath);
            count++;
          } catch (e: any) {
            console.error(`[Stickers] 删除失败: ${filename}`, e.message);
          }
        }
      }
      res.json({ deleted: count, message: `已删除 ${count} 个表情` });
      return;
    }

    res.status(400).json({ error: '请提供 files 数组或 all: true' });
  } catch (error: any) {
    res.status(500).json({ error: '删除失败' });
  }
});

router.put('/password', async (req: Request, res: Response) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword || newPassword.length < 6) {
      res.status(400).json({ error: '新密码至少6位' });
      return;
    }
    const user = await pgPool.query('SELECT password_hash FROM user_accounts WHERE id=$1', [req.user!.userId]);
    if (user.rows.length === 0) { res.status(404).json({ error: '用户不存在' }); return; }
    const bcrypt = require('bcryptjs');
    const valid = await bcrypt.compare(oldPassword, user.rows[0].password_hash);
    if (!valid) { res.status(400).json({ error: '原密码错误' }); return; }
    const hash = await bcrypt.hash(newPassword, 10);
    await pgPool.query('UPDATE user_accounts SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.user!.userId]);
    res.json({ message: '密码修改成功' });
  } catch (err: any) { res.status(500).json({ error: '修改失败' }); }
});

export default router;
