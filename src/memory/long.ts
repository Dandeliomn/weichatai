/**
 * 长期记忆模块
 * 使用 PostgreSQL 存储用户对话摘要、个人偏好、历史关键信息
 *
 * 表结构 (由 scripts/init-db.sql 创建):
 *   - users:            用户元信息
 *   - user_memories:    结构化记忆摘要
 *   - conversation_logs: 对话历史记录
 *   - daily_summaries:  每日对话摘要
 */

import { Pool, PoolClient, QueryResult } from 'pg';

/** 用户记录 */
export interface User {
  id: number;
  wechat_id: string;
  nickname: string | null;
  first_active_at: Date;
  last_active_at: Date;
  total_messages: number;
}

/** 记忆记录 */
export interface Memory {
  id: number;
  user_id: number;
  summary_text: string;
  keywords: string[];
  emotion: string | null;
  importance: number;
  memory_type: string;
  created_at: Date;
  updated_at: Date;
}

/** 对话日志记录 */
export interface ConversationLog {
  id: number;
  user_id: number;
  wechat_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  emotion: string | null;
  emotion_confidence: number | null;
  created_at: Date;
}

/** PostgreSQL 连接池 */
let pool: Pool;

/**
 * 初始化 PostgreSQL 连接池
 */
export function initLongMemory(pgPool: Pool): void {
  pool = pgPool;
  console.log('[LongMemory] PostgreSQL 连接池初始化完成');
}

/**
 * 获取或创建用户
 * 如果用户不存在则自动创建，存在则更新最后活跃时间
 *
 * @param wechatId - 微信用户 ID (FromUserName)
 * @param nickname - 可选昵称
 * @returns 用户记录
 */
export async function getOrCreateUser(
  wechatId: string,
  nickname?: string
): Promise<User> {
  const client = await pool.connect();
  try {
    // 尝试更新已存在的用户
    const updateResult = await client.query<User>(
      `UPDATE users
       SET last_active_at = NOW(),
           total_messages = total_messages + 1,
           nickname = COALESCE($2, nickname),
           updated_at = NOW()
       WHERE wechat_id = $1
       RETURNING *`,
      [wechatId, nickname || null]
    );

    if (updateResult.rows.length > 0) {
      return updateResult.rows[0];
    }

    // 用户不存在，创建新用户
    const insertResult = await client.query<User>(
      `INSERT INTO users (wechat_id, nickname)
       VALUES ($1, $2)
       ON CONFLICT (wechat_id) DO NOTHING
       RETURNING *`,
      [wechatId, nickname || null]
    );

    // 如果 INSERT 因并发冲突返回空，再查一次
    if (insertResult.rows.length > 0) {
      console.log(`[LongMemory] 🆕 新用户: ${wechatId}`);
      return insertResult.rows[0];
    }

    const selectResult = await client.query<User>(
      `SELECT * FROM users WHERE wechat_id = $1`,
      [wechatId]
    );
    return selectResult.rows[0];
  } finally {
    client.release();
  }
}

/**
 * 查询用户的长期记忆摘要
 * 按重要性排序，返回最相关的记忆
 *
 * @param userId - 用户数据库 ID
 * @param limit - 返回记忆数量上限 (默认 10)
 * @returns 记忆数组
 */
export async function getMemories(
  userId: number,
  limit: number = 10
): Promise<Memory[]> {
  try {
    const result = await pool.query<Memory>(
      `SELECT * FROM user_memories
       WHERE user_id = $1
       ORDER BY importance DESC, updated_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  } catch (error) {
    console.error(`[LongMemory] 查询记忆失败 (userId=${userId}):`, error);
    return [];
  }
}

/**
 * 根据关键词搜索相关记忆
 *
 * @param userId - 用户数据库 ID
 * @param queryText - 搜索文本 (用于关键词匹配)
 * @param limit - 返回数量上限
 * @returns 匹配的记忆数组
 */
export async function searchMemories(
  userId: number,
  queryText: string,
  limit: number = 5
): Promise<Memory[]> {
  try {
    // 使用 PostgreSQL 全文搜索
    const result = await pool.query<Memory>(
      `SELECT * FROM user_memories
       WHERE user_id = $1
         AND to_tsvector('simple', summary_text) @@ plainto_tsquery('simple', $2)
       ORDER BY importance DESC, updated_at DESC
       LIMIT $3`,
      [userId, queryText, limit]
    );

    // 如果全文搜索无结果，回退到简单的 LIKE 匹配
    if (result.rows.length === 0) {
      const likeResult = await pool.query<Memory>(
        `SELECT * FROM user_memories
         WHERE user_id = $1
           AND summary_text ILIKE '%' || $2 || '%'
         ORDER BY importance DESC, updated_at DESC
         LIMIT $3`,
        [userId, queryText, limit]
      );
      return likeResult.rows;
    }

    return result.rows;
  } catch (error) {
    console.error(`[LongMemory] 搜索记忆失败:`, error);
    return [];
  }
}

/**
 * 添加或更新一条长期记忆
 *
 * @param userId - 用户数据库 ID
 * @param summaryText - 记忆摘要文本
 * @param keywords - 关键词数组
 * @param emotion - 关联情绪
 * @param importance - 重要性 (1-10)
 * @param memoryType - 记忆类型
 * @returns 创建的记忆记录
 */
export async function addMemory(
  userId: number,
  summaryText: string,
  keywords: string[] = [],
  emotion: string | null = null,
  importance: number = 5,
  memoryType: string = 'factual'
): Promise<Memory | null> {
  try {
    const result = await pool.query<Memory>(
      `INSERT INTO user_memories (user_id, summary_text, keywords, emotion, importance, memory_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, summaryText, keywords, emotion, importance, memoryType]
    );

    console.log(`[LongMemory] ✅ 新增记忆 (userId=${userId}, keywords=${keywords.join(',')})`);
    return result.rows[0];
  } catch (error) {
    console.error(`[LongMemory] 添加记忆失败:`, error);
    return null;
  }
}

/**
 * 记录对话日志 (支持媒体字段)
 */
export async function logConversation(
  userId: number,
  wechatId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  emotion?: string,
  emotionConfidence?: number,
  media?: { mediaType: string; mediaUrl: string | null; mediaData: string | null; mediaMime: string | null }
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO conversation_logs
       (user_id, wechat_id, role, content, emotion, emotion_confidence,
        media_type, media_url, media_data, media_mime)
       VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10)`,
      [
        userId, wechatId, role, content,
        emotion || null, emotionConfidence || null,
        media?.mediaType || null,
        media?.mediaUrl || null,
        media?.mediaData || null,
        media?.mediaMime || null,
      ]
    );
  } catch (error) {
    console.error(`[LongMemory] 记录对话日志失败:`, error);
  }
}

/**
 * 获取最近 N 天内活跃的用户列表 (用于主动关怀)
 *
 * @param days - 最近多少天 (默认 3)
 * @returns 用户记录数组
 */
export async function getRecentActiveUsers(days: number = 3): Promise<User[]> {
  try {
    const result = await pool.query<User>(
      `SELECT DISTINCT u.* FROM users u
       INNER JOIN conversation_logs cl ON u.id = cl.user_id
       WHERE cl.created_at > NOW() - INTERVAL '1 day' * $1
         AND u.is_active = TRUE
       ORDER BY u.last_active_at DESC`,
      [days]
    );

    // 如果对话日志匹配的用户太少，回退到按 last_active_at 查询
    if (result.rows.length === 0) {
      const fallbackResult = await pool.query<User>(
        `SELECT * FROM users
         WHERE last_active_at > NOW() - INTERVAL '1 day' * $1
           AND is_active = TRUE
         ORDER BY last_active_at DESC`,
        [days]
      );
      return fallbackResult.rows;
    }

    return result.rows;
  } catch (error) {
    console.error(`[LongMemory] 查询活跃用户失败:`, error);
    return [];
  }
}

/**
 * 存储或更新每日摘要
 *
 * @param userId - 用户数据库 ID
 * @param summaryDate - 摘要日期
 * @param summaryText - 摘要内容
 * @param moodSummary - 当日心情总结
 * @param topicKeywords - 话题关键词
 * @param messageCount - 消息数量
 */
export async function upsertDailySummary(
  userId: number,
  summaryDate: string,
  summaryText: string,
  moodSummary: string | null = null,
  topicKeywords: string[] = [],
  messageCount: number = 0
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO daily_summaries (user_id, summary_date, summary_text, mood_summary, topic_keywords, message_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, summary_date)
       DO UPDATE SET
         summary_text = EXCLUDED.summary_text,
         mood_summary = EXCLUDED.mood_summary,
         topic_keywords = EXCLUDED.topic_keywords,
         message_count = daily_summaries.message_count + EXCLUDED.message_count`,
      [userId, summaryDate, summaryText, moodSummary, topicKeywords, messageCount]
    );
  } catch (error) {
    console.error(`[LongMemory] 存储每日摘要失败:`, error);
  }
}

/**
 * 记录关怀消息发送日志
 *
 * @param userId - 用户数据库 ID
 * @param messageText - 关怀消息内容
 * @param scheduleType - 定时类型 (morning/afternoon/evening)
 */
export async function logCareMessage(
  userId: number,
  messageText: string,
  scheduleType: string
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO care_message_logs (user_id, message_text, schedule_type)
       VALUES ($1, $2, $3)`,
      [userId, messageText, scheduleType]
    );
  } catch (error) {
    console.error(`[LongMemory] 记录关怀日志失败:`, error);
  }
}

/**
 * 检查用户今天是否已收到过某个时段的关怀消息
 *
 * @param userId - 用户数据库 ID
 * @param scheduleType - 定时类型
 * @returns 是否已发送
 */
export async function hasCareMessageToday(
  userId: number,
  scheduleType: string
): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1 FROM care_message_logs
       WHERE user_id = $1
         AND schedule_type = $2
         AND sent_at::date = CURRENT_DATE
       LIMIT 1`,
      [userId, scheduleType]
    );
    return result.rows.length > 0;
  } catch (error) {
    console.error(`[LongMemory] 检查关怀记录失败:`, error);
    return false;
  }
}

/**
 * 获取用户的对话统计信息 (用于生成摘要时参考)
 *
 * @param userId - 用户数据库 ID
 * @param since - 起始时间 (默认最近24小时)
 * @returns 统计信息
 */
export async function getConversationStats(
  userId: number,
  since?: Date
): Promise<{
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  emotions: Record<string, number>;
}> {
  try {
    const timeFilter = since
      ? `AND created_at > '${since.toISOString()}'`
      : `AND created_at > NOW() - INTERVAL '24 hours'`;

    const result = await pool.query(
      `SELECT
         COUNT(*) as total_messages,
         COUNT(*) FILTER (WHERE role = 'user') as user_messages,
         COUNT(*) FILTER (WHERE role = 'assistant') as assistant_messages,
         COALESCE(jsonb_object_agg(emotion, emo_count) FILTER (WHERE emotion IS NOT NULL), '{}') as emotions
       FROM (
         SELECT role, emotion, COUNT(*) as emo_count
         FROM conversation_logs
         WHERE user_id = $1 ${timeFilter}
         GROUP BY role, emotion
       ) sub`,
      [userId]
    );

    const row = result.rows[0];
    return {
      totalMessages: parseInt(row.total_messages, 10) || 0,
      userMessages: parseInt(row.user_messages, 10) || 0,
      assistantMessages: parseInt(row.assistant_messages, 10) || 0,
      emotions: typeof row.emotions === 'string' ? JSON.parse(row.emotions) : row.emotions || {},
    };
  } catch (error) {
    console.error(`[LongMemory] 获取对话统计失败:`, error);
    return { totalMessages: 0, userMessages: 0, assistantMessages: 0, emotions: {} };
  }
}

/**
 * 确保微信用户有对应的 user_accounts (仪表盘登录账号)
 */
export async function ensureUserAccount(
  wechatId: string,
  nickname?: string,
  msgId?: string
): Promise<{ email: string; password: string; isNew: boolean } | null> {
  try {
    const existing = await pool.query(
      'SELECT id, email FROM user_accounts WHERE wechat_id = $1', [wechatId]
    );
    if (existing.rows.length > 0) {
      return { email: existing.rows[0].email, password: '', isNew: false };
    }
    // 用消息ID前8位数字作为登录名，带重试去重
    let email = (msgId || wechatId).replace(/\D/g, '').substring(0, 8) || '76000000';
    const password = generateRandomPwd();
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 10);
    // 最多重试5次，每次在后面加随机数字避免冲突
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix = attempt > 0 ? Math.random().toString(36).substring(2, 4) : '';
      const tryEmail = suffix ? email.substring(0, 6) + suffix : email;
      const result = await pool.query(
        `INSERT INTO user_accounts (email, password_hash, display_name, wechat_id, role)
         VALUES ($1,$2,$3,$4,'user') ON CONFLICT (email) DO NOTHING RETURNING id`,
        [tryEmail, hash, nickname || wechatId, wechatId]
      );
      if (result.rows.length > 0) {
        console.log(`[LongMemory] 🆕 自动创建账号: ${tryEmail}`);
        return { email: tryEmail, password, isNew: true };
      }
      email = tryEmail; // use the suffixed version for next attempt
    }
    return null; // 5次都冲突，放弃
  } catch (error) { console.error('[LongMemory] 创建账号失败:', error); return null; }
}

export async function changePassword(wechatId: string, newPassword: string): Promise<boolean> {
  try {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(newPassword, 10);
    const r = await pool.query(
      'UPDATE user_accounts SET password_hash=$1, updated_at=NOW() WHERE wechat_id=$2',
      [hash, wechatId]
    );
    return (r.rowCount || 0) > 0;
  } catch (error) { console.error('[LongMemory] 修改密码失败:', error); return false; }
}

function generateRandomPwd(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let p = ''; for (let i = 0; i < 10; i++) p += chars[Math.floor(Math.random() * chars.length)];
  return p;
}
