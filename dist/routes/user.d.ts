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
import { Pool } from 'pg';
declare const router: import("express-serve-static-core").Router;
export declare function initUserRoutes(pool: Pool): void;
export default router;
//# sourceMappingURL=user.d.ts.map