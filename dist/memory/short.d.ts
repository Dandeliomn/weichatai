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
/**
 * 初始化 Redis 连接
 */
export declare function initShortMemory(redisInstance: Redis): void;
/**
 * 获取用户的短期对话上下文
 *
 * @param sessionId - 用户微信 ID
 * @returns 对话上下文数组 (按时间顺序，最早的在前)
 */
export declare function getContext(sessionId: string): Promise<ShortMemoryEntry[]>;
/**
 * 添加一条消息到短期记忆
 *
 * @param sessionId - 用户微信 ID
 * @param role - 角色: 'user' | 'assistant'
 * @param content - 消息内容
 * @param emotion - 可选的情绪标签
 */
export declare function addMessage(sessionId: string, role: 'user' | 'assistant', content: string, emotion?: string): Promise<void>;
/**
 * 批量添加消息 (用于初始化或恢复上下文)
 *
 * @param sessionId - 用户微信 ID
 * @param messages - 消息数组
 */
export declare function addMessages(sessionId: string, messages: ShortMemoryEntry[]): Promise<void>;
/**
 * 清除用户的短期记忆
 *
 * @param sessionId - 用户微信 ID
 */
export declare function clearMemory(sessionId: string): Promise<void>;
/**
 * 获取用户的短期记忆数量
 *
 * @param sessionId - 用户微信 ID
 * @returns 记忆条目数量
 */
export declare function getMemoryCount(sessionId: string): Promise<number>;
//# sourceMappingURL=short.d.ts.map