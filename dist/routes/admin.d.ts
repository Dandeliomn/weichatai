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
import { Pool } from 'pg';
declare const router: import("express-serve-static-core").Router;
export declare function initAdminRoutes(pool: Pool): void;
export default router;
//# sourceMappingURL=admin.d.ts.map