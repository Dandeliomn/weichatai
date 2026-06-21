/**
 * JWT 认证中间件
 *
 * 提供:
 * - authenticate: 验证 JWT token，将用户信息注入 req.user
 * - requireAdmin: 仅允许管理员角色访问
 * - requireUser: 仅允许普通用户角色访问
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

/** JWT 密钥 (生产环境应从环境变量读取) */
const JWT_SECRET = process.env.JWT_SECRET || 'weclaw-companion-jwt-secret-change-in-production';

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
export function signAccessToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '2h' });
}

/**
 * 签发 Refresh Token (长期)
 */
export function signRefreshToken(userId: number): string {
  return jwt.sign({ userId, type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * 验证 JWT Token
 */
export function verifyToken(token: string): AuthUser {
  return jwt.verify(token, JWT_SECRET) as AuthUser;
}

/**
 * 认证中间件 — 验证请求中的 Bearer Token
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  // 从 Authorization Header 获取 token
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: '未提供认证令牌', code: 'NO_TOKEN' });
    return;
  }

  const token = authHeader.substring(7); // 去掉 "Bearer " 前缀

  try {
    const decoded = verifyToken(token);

    // 防止 refresh token 被当作 access token 使用
    if ((decoded as any).type === 'refresh') {
      res.status(401).json({ error: '无效的令牌类型', code: 'WRONG_TOKEN_TYPE' });
      return;
    }

    req.user = decoded;
    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      res.status(401).json({ error: '令牌已过期，请重新登录', code: 'TOKEN_EXPIRED' });
      return;
    }
    if (error.name === 'JsonWebTokenError') {
      res.status(401).json({ error: '无效的令牌', code: 'INVALID_TOKEN' });
      return;
    }
    res.status(500).json({ error: '认证服务异常' });
  }
}

/**
 * 管理员权限中间件 — 必须在 authenticate 之后使用
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: '请先登录' });
    return;
  }

  if (req.user.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限', code: 'FORBIDDEN' });
    return;
  }

  next();
}

/**
 * 普通用户权限中间件
 */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: '请先登录' });
    return;
  }

  next();
}
