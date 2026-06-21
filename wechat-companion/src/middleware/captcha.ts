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
import svgCaptcha from 'svg-captcha';

/** Redis 实例 */
let redis: Redis;

/** 验证码配置 */
const CAPTCHA_CONFIG = {
  /** 过期时间 (秒) */
  ttl: 300,
  /** Key 前缀 */
  prefix: 'captcha:',
  /** 验证码长度 */
  size: 4,
  /** 干扰线数量 */
  noise: 2,
  /** 字体大小 */
  fontSize: 50,
  /** 宽度 */
  width: 150,
  /** 高度 */
  height: 50,
};

/**
 * 初始化验证码模块
 */
export function initCaptcha(redisInstance: Redis): void {
  redis = redisInstance;
  console.log('[Captcha] 验证码模块已初始化');
}

/**
 * 生成数学算式验证码
 * 返回 SVG 图片和会话ID
 */
export async function generateCaptcha(): Promise<{
  captchaId: string;
  svg: string;
}> {
  if (!redis) {
    throw new Error('Captcha 模块未初始化');
  }

  // 生成数学算式验证码
  const captcha = svgCaptcha.createMathExpr({
    mathMin: 1,
    mathMax: 20,
    mathOperator: '+-',
    fontSize: CAPTCHA_CONFIG.fontSize,
    width: CAPTCHA_CONFIG.width,
    height: CAPTCHA_CONFIG.height,
    noise: CAPTCHA_CONFIG.noise,
    color: true,
    background: '#f0f0f0',
  });

  // 生成唯一ID
  const captchaId = `captcha_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

  // 将答案存储到 Redis
  const key = `${CAPTCHA_CONFIG.prefix}${captchaId}`;
  await redis.set(key, captcha.text.toLowerCase(), 'EX', CAPTCHA_CONFIG.ttl);

  console.log(`[Captcha] 生成验证码: id=${captchaId}, answer=${captcha.text}`);

  return {
    captchaId,
    svg: captcha.data,
  };
}

/**
 * 验证用户提交的验证码
 *
 * @param captchaId - 生成验证码时返回的ID
 * @param answer - 用户输入的答案
 * @returns 是否验证通过
 */
export async function verifyCaptcha(
  captchaId: string,
  answer: string
): Promise<boolean> {
  if (!redis) {
    console.warn('[Captcha] Redis 未初始化，跳过验证码校验');
    return true; // 宽松模式：未配置Redis时放行
  }

  if (!captchaId || !answer) {
    return false;
  }

  const key = `${CAPTCHA_CONFIG.prefix}${captchaId}`;

  try {
    // 获取存储的答案
    const storedAnswer = await redis.get(key);

    if (!storedAnswer) {
      console.warn(`[Captcha] 验证码已过期: ${captchaId}`);
      return false;
    }

    // 比较答案 (不区分大小写)
    const isValid = storedAnswer.toLowerCase() === answer.toLowerCase().trim();

    if (isValid) {
      // 删除已使用的验证码 (一次性)
      await redis.del(key);
      console.log(`[Captcha] ✅ 验证通过: ${captchaId}`);
    } else {
      console.warn(`[Captcha] ❌ 验证失败: expected=${storedAnswer}, got=${answer}`);
    }

    return isValid;
  } catch (error) {
    console.error('[Captcha] 验证出错:', error);
    return false;
  }
}

/**
 * 生成纯文本验证码 (降级方案，不推荐)
 * 当 SVG 不可用时使用
 */
export async function generateTextCaptcha(): Promise<{
  captchaId: string;
  question: string;
}> {
  if (!redis) {
    throw new Error('Captcha 模块未初始化');
  }

  const a = Math.floor(Math.random() * 20) + 1;
  const b = Math.floor(Math.random() * 20) + 1;
  const op = Math.random() > 0.5 ? '+' : '-';
  const answer = op === '+' ? a + b : a - b;

  const captchaId = `captcha_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  const question = `${a} ${op} ${b} = ?`;

  const key = `${CAPTCHA_CONFIG.prefix}${captchaId}`;
  await redis.set(key, String(answer), 'EX', CAPTCHA_CONFIG.ttl);

  return { captchaId, question };
}
