"use strict";
/**
 * 安全中间件（统一版）
 *
 * XSS消毒 + SQL注入检测 + 输入验证 + 安全日志 → 单个中间件
 * 减少请求穿透层数，提升性能
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.securityLogger = exports.inputValidator = exports.sqlInjectionGuard = exports.xssSanitizer = void 0;
exports.sanitize = sanitize;
exports.securityGuard = securityGuard;
const xss_1 = __importDefault(require("xss"));
// ---- XSS 消毒 ----
const xssOptions = {
    whiteList: {},
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'],
    css: false,
};
function sanitize(input) {
    if (typeof input === 'string')
        return (0, xss_1.default)(input, xssOptions);
    if (Array.isArray(input))
        return input.map((item) => sanitize(item));
    if (input !== null && typeof input === 'object') {
        const sanitized = {};
        for (const [key, value] of Object.entries(input)) {
            sanitized[key] = sanitize(value);
        }
        return sanitized;
    }
    return input;
}
// ---- SQL 注入检测 ----
const SQL_PATTERNS = [
    /(\bUNION\b.*\bSELECT\b)/i, /(\bDROP\b.*\bTABLE\b)/i, /(\bALTER\b.*\bTABLE\b)/i,
    /(\bCREATE\b.*\bTABLE\b)/i, /(\bINSERT\b.*\bINTO\b)/i, /(\bDELETE\b.*\bFROM\b)/i,
    /(\bUPDATE\b.*\bSET\b)/i, /(\bEXEC\b.*\bxp_cmdshell\b)/i, /(\bSLEEP\b\s*\()/i,
    /(\bBENCHMARK\b\s*\()/i, /;.*--/, /' OR '/i, /'='/, /1\s*=\s*1/i,
];
function hasSQLInjection(value) {
    if (typeof value !== 'string')
        return false;
    let matchCount = 0;
    for (const pattern of SQL_PATTERNS) {
        if (pattern.test(value)) {
            if (value.length < 200)
                return true;
            matchCount++;
        }
    }
    return matchCount >= 3;
}
// ---- 输入验证 ----
function validateInput(obj, path = '') {
    if (obj === null || obj === undefined)
        return null;
    if (typeof obj === 'string') {
        if (obj.length > 10000)
            return `${path}: 内容过长`;
        if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(obj))
            return `${path}: 含非法字符`;
    }
    if (Array.isArray(obj)) {
        if (obj.length > 100)
            return `${path}: 数组过长`;
        for (let i = 0; i < obj.length; i++) {
            const err = validateInput(obj[i], `${path}[${i}]`);
            if (err)
                return err;
        }
    }
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
        const keys = Object.keys(obj);
        if (keys.length > 50)
            return `${path}: 字段过多`;
        for (const key of keys) {
            const err = validateInput(obj[key], path ? `${path}.${key}` : key);
            if (err)
                return err;
        }
    }
    return null;
}
// ---- 统一安全中间件 ----
function securityGuard(req, res, next) {
    // 1. 安全日志
    if (req.path.includes('/auth/') || req.path.includes('/admin/')) {
        console.log(`[Security] ${req.method} ${req.path} from ${req.ip}`);
    }
    // 2. SQL注入检测
    for (const v of [...Object.values(req.body || {}), ...Object.values(req.query || {})]) {
        if (hasSQLInjection(v)) {
            res.status(403).json({ error: '请求包含不安全的内容', code: 'SECURITY_BLOCKED' });
            return;
        }
    }
    // 3. XSS 消毒
    if (req.body)
        req.body = sanitize(req.body);
    if (req.query)
        req.query = sanitize(req.query);
    if (req.params)
        req.params = sanitize(req.params);
    // 4. 输入验证
    const err = validateInput(req.body, 'body');
    if (err) {
        res.status(400).json({ error: err, code: 'VALIDATION_ERROR' });
        return;
    }
    next();
}
// 保留旧导出兼容性
exports.xssSanitizer = securityGuard;
exports.sqlInjectionGuard = securityGuard;
exports.inputValidator = securityGuard;
exports.securityLogger = securityGuard;
//# sourceMappingURL=security.js.map