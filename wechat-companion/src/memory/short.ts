/**
 * 短期记忆模块
 * 使用 Redis List 存储每个用户最近N轮对话，TTL 24小时
 *
 * 数据结构:
 *   Key: short:memory:{sessionId}
 *   Value: List of JSON strings, 每个JSON包含 { role, content, emotion, timestamp }
 *   操作: LPUSH 新消息到头部, LTRIM 保持最多 N 条, EXPIRE 设置过期时间
 */

import { Redis } from 'ioredis';

/** 一条短期记忆记录 */
export interface ShortMemoryEntry {
  role: 'user' | 'assistant';
  content: string;
  emotion?: string;
  timestamp: number;
}

/** 短期记忆配置 */
const CONFIG = {
  /** Redis Key 前缀 */
  keyPrefix: 'short:memory:',
  /** 最大对话轮数 (user+assistant 各算一轮，实际存储 2*N 条) */
  maxRounds: parseInt(process.env.SHORT_MEMORY_MAX_ROUNDS || '10', 10),
  /** TTL 过期时间 (秒)，默认 24 小时 */
  ttl: parseInt(process.env.SHORT_MEMORY_TTL || '86400', 10),
};

/** Redis 连接实例 */
let redis: Redis;

/**
 * 初始化 Redis 连接
 */
export function initShortMemory(redisInstance: Redis): void {
  redis = redisInstance;
  console.log(`[ShortMemory] 初始化完成 (maxRounds=${CONFIG.maxRounds}, ttl=${CONFIG.ttl}s)`);
}

/**
 * 生成 Redis Key
 */
function getKey(sessionId: string): string {
  return `${CONFIG.keyPrefix}${sessionId}`;
}

/**
 * 获取用户的短期对话上下文
 *
 * @param sessionId - 用户微信 ID
 * @returns 对话上下文数组 (按时间顺序，最早的在前)
 */
export async function getContext(sessionId: string): Promise<ShortMemoryEntry[]> {
  if (!redis) {
    console.warn('[ShortMemory] Redis 未初始化，返回空上下文');
    return [];
  }

  try {
    const key = getKey(sessionId);
    // LRANGE 获取列表中所有元素 (从索引0到-1表示全部)
    const items = await redis.lrange(key, 0, -1);

    if (!items || items.length === 0) {
      return [];
    }

    // 解析JSON并反转顺序 (Redis List头部是最新的，我们需要按时间正序)
    const memories: ShortMemoryEntry[] = [];
    for (const item of items) {
      try {
        const parsed = JSON.parse(item) as ShortMemoryEntry;
        memories.push(parsed);
      } catch (parseError) {
        console.warn(`[ShortMemory] 解析记忆条目失败:`, item.substring(0, 50));
      }
    }

    // 反转: List中最新在头部(索引0)，返回按时间正序排列
    return memories.reverse();
  } catch (error) {
    console.error(`[ShortMemory] 获取上下文失败 (sessionId=${sessionId}):`, error);
    return [];
  }
}

/**
 * 添加一条消息到短期记忆
 *
 * @param sessionId - 用户微信 ID
 * @param role - 角色: 'user' | 'assistant'
 * @param content - 消息内容
 * @param emotion - 可选的情绪标签
 */
export async function addMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  emotion?: string
): Promise<void> {
  if (!redis) {
    console.warn('[ShortMemory] Redis 未初始化，跳过记忆存储');
    return;
  }

  try {
    const key = getKey(sessionId);
    const entry: ShortMemoryEntry = {
      role,
      content,
      emotion,
      timestamp: Date.now(),
    };

    // 使用 pipeline 批量执行，保证原子性
    const pipeline = redis.pipeline();

    // LPUSH: 将新消息添加到列表头部
    pipeline.lpush(key, JSON.stringify(entry));

    // LTRIM: 裁剪列表，保持最多 maxRounds*2 条记录 (每轮user+assistant各一条)
    const maxEntries = CONFIG.maxRounds * 2;
    pipeline.ltrim(key, 0, maxEntries - 1);

    // EXPIRE: 重置过期时间
    pipeline.expire(key, CONFIG.ttl);

    await pipeline.exec();

    console.log(`[ShortMemory] ✅ 已存储 (sessionId=${sessionId}, role=${role}, len=${content.length})`);
  } catch (error) {
    console.error(`[ShortMemory] 存储消息失败 (sessionId=${sessionId}):`, error);
  }
}

/**
 * 批量添加消息 (用于初始化或恢复上下文)
 *
 * @param sessionId - 用户微信 ID
 * @param messages - 消息数组
 */
export async function addMessages(
  sessionId: string,
  messages: ShortMemoryEntry[]
): Promise<void> {
  if (!redis || messages.length === 0) return;

  try {
    const key = getKey(sessionId);
    const pipeline = redis.pipeline();

    for (const msg of messages) {
      pipeline.lpush(key, JSON.stringify(msg));
    }

    const maxEntries = CONFIG.maxRounds * 2;
    pipeline.ltrim(key, 0, maxEntries - 1);
    pipeline.expire(key, CONFIG.ttl);

    await pipeline.exec();
    console.log(`[ShortMemory] ✅ 批量存储 ${messages.length} 条记忆`);
  } catch (error) {
    console.error(`[ShortMemory] 批量存储失败:`, error);
  }
}

/**
 * 清除用户的短期记忆
 *
 * @param sessionId - 用户微信 ID
 */
export async function clearMemory(sessionId: string): Promise<void> {
  if (!redis) return;

  try {
    await redis.del(getKey(sessionId));
    console.log(`[ShortMemory] 🗑️  已清除 (sessionId=${sessionId})`);
  } catch (error) {
    console.error(`[ShortMemory] 清除记忆失败:`, error);
  }
}

/**
 * 获取用户的短期记忆数量
 *
 * @param sessionId - 用户微信 ID
 * @returns 记忆条目数量
 */
export async function getMemoryCount(sessionId: string): Promise<number> {
  if (!redis) return 0;

  try {
    return await redis.llen(getKey(sessionId));
  } catch {
    return 0;
  }
}
