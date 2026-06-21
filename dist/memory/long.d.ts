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
import { Pool } from 'pg';
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
/**
 * 初始化 PostgreSQL 连接池
 */
export declare function initLongMemory(pgPool: Pool): void;
/**
 * 获取或创建用户
 * 如果用户不存在则自动创建，存在则更新最后活跃时间
 *
 * @param wechatId - 微信用户 ID (FromUserName)
 * @param nickname - 可选昵称
 * @returns 用户记录
 */
export declare function getOrCreateUser(wechatId: string, nickname?: string): Promise<User>;
/**
 * 查询用户的长期记忆摘要
 * 按重要性排序，返回最相关的记忆
 *
 * @param userId - 用户数据库 ID
 * @param limit - 返回记忆数量上限 (默认 10)
 * @returns 记忆数组
 */
export declare function getMemories(userId: number, limit?: number): Promise<Memory[]>;
/**
 * 根据关键词搜索相关记忆
 *
 * @param userId - 用户数据库 ID
 * @param queryText - 搜索文本 (用于关键词匹配)
 * @param limit - 返回数量上限
 * @returns 匹配的记忆数组
 */
export declare function searchMemories(userId: number, queryText: string, limit?: number): Promise<Memory[]>;
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
export declare function addMemory(userId: number, summaryText: string, keywords?: string[], emotion?: string | null, importance?: number, memoryType?: string): Promise<Memory | null>;
/**
 * 记录对话日志 (支持媒体字段)
 */
export declare function logConversation(userId: number, wechatId: string, role: 'user' | 'assistant' | 'system', content: string, emotion?: string, emotionConfidence?: number, media?: {
    mediaType: string;
    mediaUrl: string | null;
    mediaData: string | null;
    mediaMime: string | null;
}): Promise<void>;
/**
 * 获取最近 N 天内活跃的用户列表 (用于主动关怀)
 *
 * @param days - 最近多少天 (默认 3)
 * @returns 用户记录数组
 */
export declare function getRecentActiveUsers(days?: number): Promise<User[]>;
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
export declare function upsertDailySummary(userId: number, summaryDate: string, summaryText: string, moodSummary?: string | null, topicKeywords?: string[], messageCount?: number): Promise<void>;
/**
 * 记录关怀消息发送日志
 *
 * @param userId - 用户数据库 ID
 * @param messageText - 关怀消息内容
 * @param scheduleType - 定时类型 (morning/afternoon/evening)
 */
export declare function logCareMessage(userId: number, messageText: string, scheduleType: string): Promise<void>;
/**
 * 检查用户今天是否已收到过某个时段的关怀消息
 *
 * @param userId - 用户数据库 ID
 * @param scheduleType - 定时类型
 * @returns 是否已发送
 */
export declare function hasCareMessageToday(userId: number, scheduleType: string): Promise<boolean>;
/**
 * 获取用户的对话统计信息 (用于生成摘要时参考)
 *
 * @param userId - 用户数据库 ID
 * @param since - 起始时间 (默认最近24小时)
 * @returns 统计信息
 */
export declare function getConversationStats(userId: number, since?: Date): Promise<{
    totalMessages: number;
    userMessages: number;
    assistantMessages: number;
    emotions: Record<string, number>;
}>;
/**
 * 确保微信用户有对应的 user_accounts (仪表盘登录账号)
 */
export declare function ensureUserAccount(wechatId: string, nickname?: string, msgId?: string): Promise<{
    email: string;
    password: string;
    isNew: boolean;
} | null>;
export declare function changePassword(wechatId: string, newPassword: string): Promise<boolean>;
//# sourceMappingURL=long.d.ts.map