/**
 * 结构化记忆提取 — 从导入的聊天记录中提炼关键信息
 *
 * 参照 ex-skill 的记忆架构:
 * - 关键事件 & 时间线
 * - 说话风格 & 口头禅
 * - 常聊话题 & inside jokes
 * - 关系动态 & 互动模式
 */
import { Pool } from 'pg';
/**
 * 主入口：提取并存储结构化记忆
 * @returns 提取的记忆数量
 */
export declare function extractStructuredMemories(pgPool: Pool): Promise<number>;
//# sourceMappingURL=extract.d.ts.map