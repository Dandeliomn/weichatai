/**
 * JWT 认证中间件
 *
 * 提供:
 * - authenticate: 验证 JWT token，将用户信息注入 req.user
 * - requireAdmin: 仅允许管理员角色访问
 * - requireUser: 仅允许普通用户角色访问
 */
import { Request, Response, NextFunction } from 'express';
/** 解码后的用户信息 */
export interface AuthUser {
    userId: number;
    email: string;
    role: 'admin' | 'user';
    wechatId?: string;
}
/** 扩展 Express Request */
declare global {
    namespace Express {
        interface Request {
            user?: AuthUser;
        }
    }
}
/**
 * 签发 Access Token (短期)
 */
export declare function signAccessToken(user: AuthUser): string;
/**
 * 签发 Refresh Token (长期)
 */
export declare function signRefreshToken(userId: number): string;
/**
 * 验证 JWT Token
 */
export declare function verifyToken(token: string): AuthUser;
/**
 * 认证中间件 — 验证请求中的 Bearer Token
 */
export declare function authenticate(req: Request, res: Response, next: NextFunction): void;
/**
 * 管理员权限中间件 — 必须在 authenticate 之后使用
 */
export declare function requireAdmin(req: Request, res: Response, next: NextFunction): void;
/**
 * 普通用户权限中间件
 */
export declare function requireUser(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=auth.d.ts.map