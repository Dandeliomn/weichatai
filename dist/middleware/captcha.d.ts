/**
 * 验证码模块 (CAPTCHA)
 *
 * 使用 svg-captcha 生成数学算式 SVG 验证码
 * 验证码答案存储在 Redis 中，TTL 5分钟
 *
 * 流程:
 * 1. GET /api/auth/captcha → 返回 SVG + captchaId
 * 2. POST /api/auth/register → 提交 captchaId + captchaAnswer
 */
import { Redis } from 'ioredis';
/**
 * 初始化验证码模块
 */
export declare function initCaptcha(redisInstance: Redis): void;
/**
 * 生成数学算式验证码
 * 返回 SVG 图片和会话ID
 */
export declare function generateCaptcha(): Promise<{
    captchaId: string;
    svg: string;
}>;
/**
 * 验证用户提交的验证码
 *
 * @param captchaId - 生成验证码时返回的ID
 * @param answer - 用户输入的答案
 * @returns 是否验证通过
 */
export declare function verifyCaptcha(captchaId: string, answer: string): Promise<boolean>;
/**
 * 生成纯文本验证码 (降级方案，不推荐)
 * 当 SVG 不可用时使用
 */
export declare function generateTextCaptcha(): Promise<{
    captchaId: string;
    question: string;
}>;
//# sourceMappingURL=captcha.d.ts.map