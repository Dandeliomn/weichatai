/**
 * 主动关怀定时任务
 *
 * 功能:
 * 1. 每天 8:00 / 13:00 / 20:00 触发
 * 2. 查询 PostgreSQL 中最近 3 天内活跃的用户
 * 3. 为每个用户随机选择关怀文案
 * 4. 随机延迟 1~5 秒后发送 (避免被微信判定为营销)
 * 5. 记录发送日志，避免重复发送
 */
import 'dotenv/config';
//# sourceMappingURL=scheduler.d.ts.map