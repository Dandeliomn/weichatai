"use strict";
/**
 * 认证路由 — 用户注册/登录/Token刷新/验证码
 *
 * GET  /api/auth/captcha   — 获取图形验证码
 * POST /api/auth/register  — 注册新账号 (需验证码)
 * POST /api/auth/login     — 登录获取 JWT (失败5次需验证码)
 * POST /api/auth/refresh   — 刷新 Access Token
 * GET  /api/auth/me        — 获取当前用户信息
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initAuthRoutes = initAuthRoutes;
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const auth_1 = require("../middleware/auth");
const captcha_1 = require("../middleware/captcha");
const router = (0, express_1.Router)();
/** PostgreSQL 连接池 (由主入口注入) */
let pgPool;
function initAuthRoutes(pool) {
    pgPool = pool;
}
// =============================================================================
// 认证路由专用速率限制器
// =============================================================================
/** 严格限流: 注册/登录 每IP每分钟最多10次 */
const strictLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '操作过于频繁，请1分钟后再试', code: 'AUTH_RATE_LIMITED' },
});
/** 验证码获取限流: 每IP每分钟最多5次 */
const captchaLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '验证码获取过于频繁，请稍后再试', code: 'CAPTCHA_RATE_LIMITED' },
});
/** 登录失败计数器 (IP级别，存储在内存中) */
const loginFailures = new Map();
const MAX_LOGIN_FAILURES = 5; // 失败超过此次数需要验证码
const FAILURE_WINDOW = 15 * 60 * 1000; // 15分钟窗口
/**
 * 检查是否需要验证码
 */
function requireCaptcha(ip) {
    const record = loginFailures.get(ip);
    if (!record)
        return false;
    // 超过窗口时间，重置
    if (Date.now() - record.lastAttempt > FAILURE_WINDOW) {
        loginFailures.delete(ip);
        return false;
    }
    return record.count >= MAX_LOGIN_FAILURES;
}
/**
 * 记录登录失败
 */
function recordLoginFailure(ip) {
    const record = loginFailures.get(ip);
    if (record) {
        if (Date.now() - record.lastAttempt > FAILURE_WINDOW) {
            loginFailures.set(ip, { count: 1, lastAttempt: Date.now() });
        }
        else {
            record.count++;
            record.lastAttempt = Date.now();
        }
    }
    else {
        loginFailures.set(ip, { count: 1, lastAttempt: Date.now() });
    }
}
/**
 * 清除登录失败记录
 */
function clearLoginFailures(ip) {
    loginFailures.delete(ip);
}
// =============================================================================
// GET /api/auth/captcha — 获取图形验证码
// =============================================================================
router.get('/captcha', captchaLimiter, async (_req, res) => {
    try {
        const { captchaId, svg } = await (0, captcha_1.generateCaptcha)();
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        // 将 captchaId 通过 Header 返回 (SVG 不支持 JSON)
        res.setHeader('X-Captcha-Id', captchaId);
        // 同时支持 JSON 格式返回
        if (_req.query.format === 'json') {
            res.json({ captchaId, svg });
            return;
        }
        res.status(200).send(svg);
    }
    catch (error) {
        console.error('[Auth] 生成验证码失败:', error.message);
        res.status(500).json({ error: '验证码生成失败' });
    }
});
// =============================================================================
// POST /api/auth/register
// =============================================================================
router.post('/register', strictLimiter, async (req, res) => {
    try {
        const { email, password, displayName, wechatId, captchaId, captchaAnswer, inviteCode } = req.body;
        // 验证码校验
        if (!captchaId || !captchaAnswer) {
            res.status(400).json({ error: '请提供验证码', code: 'CAPTCHA_REQUIRED' });
            return;
        }
        const captchaValid = await (0, captcha_1.verifyCaptcha)(captchaId, captchaAnswer);
        if (!captchaValid) {
            res.status(400).json({ error: '验证码错误或已过期', code: 'CAPTCHA_INVALID' });
            return;
        }
        // 邀请码校验
        if (!inviteCode) {
            res.status(400).json({ error: '请提供邀请码' });
            return;
        }
        const invResult = await pgPool.query('SELECT * FROM invite_codes WHERE code=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) AND use_count < max_uses', [inviteCode]);
        if (invResult.rows.length === 0) {
            res.status(400).json({ error: '邀请码无效或已过期' });
            return;
        }
        // 验证输入
        if (!email || !password) {
            res.status(400).json({ error: '用户名和密码为必填项' });
            return;
        }
        if (password.length < 6) {
            res.status(400).json({ error: '密码长度至少6位' });
            return;
        }
        // 检查用户名是否已注册
        const existing = await pgPool.query('SELECT id FROM user_accounts WHERE email = $1', [email.toLowerCase().trim()]);
        if (existing.rows.length > 0) {
            res.status(409).json({ error: '该用户名已被注册' });
            return;
        }
        // 加密密码
        const passwordHash = await bcryptjs_1.default.hash(password, 12);
        // 检查 wechat_id 是否冲突
        if (wechatId) {
            const wechatExist = await pgPool.query('SELECT id FROM user_accounts WHERE wechat_id = $1', [wechatId]);
            if (wechatExist.rows.length > 0) {
                res.status(409).json({ error: '该微信ID已被其他账号绑定' });
                return;
            }
        }
        // 创建用户 (第一个注册的用户自动成为管理员)
        const isFirst = (await pgPool.query('SELECT COUNT(*) FROM user_accounts')).rows[0].count === '0';
        const role = isFirst ? 'admin' : 'user';
        const result = await pgPool.query(`INSERT INTO user_accounts (email, password_hash, display_name, role, wechat_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, display_name, role, wechat_id, created_at`, [email.toLowerCase().trim(), passwordHash, displayName || email.split('@')[0], role, wechatId || null]);
        const user = result.rows[0];
        console.log(`[Auth] 新用户注册: ${user.email} (role=${user.role})`);
        // 消费邀请码 + 发放积分
        const inv = await pgPool.query('UPDATE invite_codes SET use_count = use_count + 1 WHERE code = $1 RETURNING created_by, bonus_credits, invitee_credits', [inviteCode]);
        const cfg = inv.rows[0] || {};
        const bonusCreator = cfg.bonus_credits || 100;
        const bonusInvitee = cfg.invitee_credits || 50;
        // 新用户获得初始积分 (体验会员每日10分，初始给10)
        await pgPool.query('UPDATE user_accounts SET credits = $1, membership = 1 WHERE id = $2', [bonusInvitee, user.id]);
        // 邀请者获得奖励 + 自动升级
        if (cfg.created_by) {
            await pgPool.query('UPDATE user_accounts SET credits = credits + $1 WHERE id = $2', [bonusCreator, cfg.created_by]);
            const { autoUpgrade } = require('../modules/membership');
            await autoUpgrade(pgPool, cfg.created_by);
        }
        res.status(201).json({
            message: '注册成功',
            user: {
                id: user.id,
                email: user.email,
                displayName: user.display_name,
                role: user.role,
                wechatId: user.wechat_id,
            },
        });
    }
    catch (error) {
        console.error('[Auth] 注册失败:', error.message);
        res.status(500).json({ error: '注册失败，请稍后重试' });
    }
});
// =============================================================================
// POST /api/auth/login
// =============================================================================
router.post('/login', strictLimiter, async (req, res) => {
    try {
        const { email, password, captchaId, captchaAnswer } = req.body;
        const clientIp = req.ip || 'unknown';
        // 检查是否需要验证码
        if (requireCaptcha(clientIp)) {
            if (!captchaId || !captchaAnswer) {
                res.status(400).json({
                    error: '登录失败次数过多，请提供验证码',
                    code: 'CAPTCHA_REQUIRED',
                    requireCaptcha: true,
                });
                return;
            }
            const captchaValid = await (0, captcha_1.verifyCaptcha)(captchaId, captchaAnswer);
            if (!captchaValid) {
                recordLoginFailure(clientIp);
                res.status(400).json({ error: '验证码错误或已过期', code: 'CAPTCHA_INVALID' });
                return;
            }
        }
        if (!email || !password) {
            res.status(400).json({ error: '请输入邮箱和密码' });
            return;
        }
        // 查找用户
        const result = await pgPool.query(`SELECT id, email, password_hash, display_name, role, wechat_id, is_active
       FROM user_accounts WHERE email = $1`, [email.toLowerCase().trim()]);
        if (result.rows.length === 0) {
            recordLoginFailure(clientIp);
            res.status(401).json({ error: '邮箱或密码错误' });
            return;
        }
        const user = result.rows[0];
        // 检查账号是否被禁用
        if (!user.is_active) {
            res.status(403).json({ error: '账号已被禁用，请联系管理员' });
            return;
        }
        // 验证密码
        const isPasswordValid = await bcryptjs_1.default.compare(password, user.password_hash);
        if (!isPasswordValid) {
            recordLoginFailure(clientIp);
            res.status(401).json({ error: '邮箱或密码错误' });
            return;
        }
        // 登录成功，清除失败记录
        clearLoginFailures(clientIp);
        // 签发 Token
        const authUser = {
            userId: user.id,
            email: user.email,
            role: user.role,
            wechatId: user.wechat_id || undefined,
        };
        const accessToken = (0, auth_1.signAccessToken)(authUser);
        const refreshToken = (0, auth_1.signRefreshToken)(user.id);
        // 存储 refresh token
        await pgPool.query(`INSERT INTO user_sessions (user_id, refresh_token, expires_at, ip_address)
       VALUES ($1, $2, NOW() + INTERVAL '7 days', $3)`, [user.id, refreshToken, req.ip || 'unknown']);
        // 更新最后登录时间
        await pgPool.query('UPDATE user_accounts SET last_login_at = NOW() WHERE id = $1', [user.id]);
        console.log(`[Auth] 用户登录: ${user.email}`);
        res.json({
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                email: user.email,
                displayName: user.display_name,
                role: user.role,
                wechatId: user.wechat_id,
            },
        });
    }
    catch (error) {
        console.error('[Auth] 登录失败:', error.message);
        res.status(500).json({ error: '登录失败，请稍后重试' });
    }
});
// =============================================================================
// POST /api/auth/refresh
// =============================================================================
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            res.status(400).json({ error: '缺少刷新令牌' });
            return;
        }
        // 验证 refresh token
        let decoded;
        try {
            decoded = (0, auth_1.verifyToken)(refreshToken);
        }
        catch {
            res.status(401).json({ error: '刷新令牌无效或已过期' });
            return;
        }
        if (decoded.type !== 'refresh') {
            res.status(401).json({ error: '无效的令牌类型' });
            return;
        }
        // 检查数据库中的 refresh token
        const session = await pgPool.query(`SELECT * FROM user_sessions
       WHERE refresh_token = $1 AND is_revoked = FALSE AND expires_at > NOW()`, [refreshToken]);
        if (session.rows.length === 0) {
            res.status(401).json({ error: '刷新令牌已被撤销' });
            return;
        }
        // 获取用户信息
        const user = await pgPool.query('SELECT id, email, role, wechat_id FROM user_accounts WHERE id = $1 AND is_active = TRUE', [decoded.userId]);
        if (user.rows.length === 0) {
            res.status(401).json({ error: '用户不存在或已被禁用' });
            return;
        }
        const u = user.rows[0];
        const authUser = {
            userId: u.id,
            email: u.email,
            role: u.role,
            wechatId: u.wechat_id || undefined,
        };
        // 签发新 Token
        const newAccessToken = (0, auth_1.signAccessToken)(authUser);
        const newRefreshToken = (0, auth_1.signRefreshToken)(u.id);
        // 撤销旧 token，存入新 token
        await pgPool.query('UPDATE user_sessions SET is_revoked = TRUE WHERE refresh_token = $1', [refreshToken]);
        await pgPool.query(`INSERT INTO user_sessions (user_id, refresh_token, expires_at, ip_address)
       VALUES ($1, $2, NOW() + INTERVAL '7 days', $3)`, [u.id, newRefreshToken, req.ip || 'unknown']);
        res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
    }
    catch (error) {
        console.error('[Auth] 刷新失败:', error.message);
        res.status(500).json({ error: 'Token 刷新失败' });
    }
});
// =============================================================================
// GET /api/auth/me
// =============================================================================
router.get('/me', auth_1.authenticate, async (req, res) => {
    try {
        const user = await pgPool.query(`SELECT id, email, display_name, role, wechat_id, avatar_url, is_active, last_login_at, created_at
       FROM user_accounts WHERE id = $1`, [req.user.userId]);
        if (user.rows.length === 0) {
            res.status(404).json({ error: '用户不存在' });
            return;
        }
        // 获取资料
        const profile = await pgPool.query('SELECT * FROM user_profiles WHERE user_id = $1', [req.user.userId]);
        const u = user.rows[0];
        res.json({
            user: {
                id: u.id,
                email: u.email,
                displayName: u.display_name,
                role: u.role,
                wechatId: u.wechat_id,
                avatarUrl: u.avatar_url,
                isActive: u.is_active,
                lastLoginAt: u.last_login_at,
                createdAt: u.created_at,
            },
            profile: profile.rows[0] || null,
        });
    }
    catch (error) {
        console.error('[Auth] 获取用户信息失败:', error.message);
        res.status(500).json({ error: '获取用户信息失败' });
    }
});
// =============================================================================
// POST /api/auth/logout
// =============================================================================
router.post('/logout', auth_1.authenticate, async (req, res) => {
    try {
        // 撤销该用户所有 session
        await pgPool.query('UPDATE user_sessions SET is_revoked = TRUE WHERE user_id = $1 AND is_revoked = FALSE', [req.user.userId]);
        res.json({ message: '已退出登录' });
    }
    catch (error) {
        res.status(500).json({ error: '退出失败' });
    }
});
// =============================================================================
// POST /api/auth/link-wechat — 绑定微信账号
// =============================================================================
router.post('/link-wechat', auth_1.authenticate, async (req, res) => {
    try {
        const { wechatId } = req.body;
        if (!wechatId) {
            res.status(400).json({ error: '请提供微信用户ID' });
            return;
        }
        // 检查是否已被绑定
        const existing = await pgPool.query('SELECT id FROM user_accounts WHERE wechat_id = $1 AND id != $2', [wechatId, req.user.userId]);
        if (existing.rows.length > 0) {
            res.status(409).json({ error: '该微信ID已被其他账号绑定' });
            return;
        }
        await pgPool.query('UPDATE user_accounts SET wechat_id = $1 WHERE id = $2', [wechatId, req.user.userId]);
        res.json({ message: '微信账号绑定成功' });
    }
    catch (error) {
        res.status(500).json({ error: '绑定失败' });
    }
});
exports.default = router;
//# sourceMappingURL=auth.js.map