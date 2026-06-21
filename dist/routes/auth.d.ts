/**
 * 认证路由 — 用户注册/登录/Token刷新/验证码
 *
 * GET  /api/auth/captcha   — 获取图形验证码
 * POST /api/auth/register  — 注册新账号 (需验证码)
 * POST /api/auth/login     — 登录获取 JWT (失败5次需验证码)
 * POST /api/auth/refresh   — 刷新 Access Token
 * GET  /api/auth/me        — 获取当前用户信息
 */
import { Pool } from 'pg';
declare const router: import("express-serve-static-core").Router;
export declare function initAuthRoutes(pool: Pool): void;
export default router;
//# sourceMappingURL=auth.d.ts.map