/**
 * 微信桥接路由
 *
 * GET  /api/bridge/qr      — 获取 FastAgent 微信登录二维码
 * GET  /api/bridge/status  — 获取微信桥接连接状态
 * GET  /api/bridge-login   — 管理员登录 OpeniLink Hub（需管理员权限）
 */
import { Pool } from 'pg';
declare const router: import("express-serve-static-core").Router;
export declare function initBridgeRoutes(pool: Pool): void;
export default router;
//# sourceMappingURL=bridge.d.ts.map