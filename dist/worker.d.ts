/**
 * BullMQ Worker - 异步消息处理
 *
 * 处理流程:
 * 1. 从队列取任务
 * 2. 从 Redis 读取短期上下文 (最近10轮对话)
 * 3. 从 PostgreSQL 读取长期记忆摘要
 * 4. 调用情绪分析模块
 * 5. 调用 DeepSeek API 生成回复
 * 6. 更新 Redis 短期记忆
 * 7. 异步更新 PostgreSQL 长期记忆
 * 8. 通过 WeClaw HTTP API 发送回复
 */
import 'dotenv/config';
//# sourceMappingURL=worker.d.ts.map