"use strict";
/**
 * JWT 认证中间件
 *
 * 提供:
 * - authenticate: 验证 JWT token，将用户信息注入 req.user
 * - requireAdmin: 仅允许管理员角色访问
 * - requireUser: 仅允许普通用户角色访问
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signAccessToken = signAccessToken;
exports.signRefreshToken = signRefreshToken;
exports.verifyToken = verifyToken;
exports.authenticate = authenticate;
exports.requireAdmin = requireAdmin;
exports.requireUser = requireUser;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
/** JWT 密钥 (生产环境应从环境变量读取) */
const JWT_SECRET = process.env.JWT_SECRET || 'weclaw-companion-jwt-secret-change-in-production';
/**
 * 签发 Access Token (短期)
 */
function signAccessToken(user) {
    return jsonwebtoken_1.default.sign(user, JWT_SECRET, { expiresIn: '2h' });
}
/**
 * 签发 Refresh Token (长期)
 */
function signRefreshToken(userId) {
    return jsonwebtoken_1.default.sign({ userId, type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });
}
/**
 * 验证 JWT Token
 */
function verifyToken(token) {
    return jsonwebtoken_1.default.verify(token, JWT_SECRET);
}
/**
 * 认证中间件 — 验证请求中的 Bearer Token
 */
function authenticate(req, res, next) {
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
        if (decoded.type === 'refresh') {
            res.status(401).json({ error: '无效的令牌类型', code: 'WRONG_TOKEN_TYPE' });
            return;
        }
        req.user = decoded;
        next();
    }
    catch (error) {
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
function requireAdmin(req, res, next) {
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
function requireUser(req, res, next) {
    if (!req.user) {
        res.status(401).json({ error: '请先登录' });
        return;
    }
    next();
}
//# sourceMappingURL=auth.js.map