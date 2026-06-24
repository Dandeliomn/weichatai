/**
 * 微信情感陪伴AI服务 - 主服务入口
 *
 * 功能:
 * 1. 启动 Express 服务器
 * 2. 提供 REST API + Webhook
 * 3. 提供 /health 健康检查接口
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Queue, JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { initShortMemory } from './memory/short';
import { initLongMemory } from './memory/long';
import { analyze } from './emotion/analyzer';
import { initCaptcha } from './middleware/captcha';
import { initMediaStore, storeMediaFromBase64 } from './modules/media-store';
import { securityGuard } from './middleware/security';
import authRouter, { initAuthRoutes } from './routes/auth';
import userRouter, { initUserRoutes } from './routes/user';
import adminRouter, { initAdminRoutes } from './routes/admin';
import importRouter, { initImportRoutes } from './routes/import';
import characterRouter, { initCharacterRoutes } from './routes/characters';
import bridgeRouter, { initBridgeRoutes } from './routes/bridge';
import stManager from './routes/st-manager';
import initCorrectionRoutes from './routes/correction';

// =============================================================================
// 配置常量
// =============================================================================

const PORT = parseInt(process.env.PORT || '3000', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://weclaw:weclaw_secret@postgres:5432/weclaw_companion';
const QUEUE_NAME = 'wechat-messages';

// =============================================================================
// 初始化连接
// =============================================================================

/** Redis 连接 (用于短期记忆 + BullMQ) */
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null, // BullMQ 要求
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on('connect', () => console.log('[Redis] ✅ 已连接'));
redis.on('error', (err) => console.error('[Redis] ❌ 连接错误:', err.message));

/** PostgreSQL 连接池 (用于长期记忆) */
const pgPool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pgPool.on('connect', () => console.log('[PostgreSQL] ✅ 连接池已创建'));
pgPool.on('error', (err) => console.error('[PostgreSQL] ❌ 连接池错误:', err.message));

/** BullMQ 消息队列 */
const messageQueue = new Queue(QUEUE_NAME, {
  connection: redis as any, // BullMQ 内置 ioredis 版本不同，需类型断言
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      age: 3600, // 完成的任务1小时后删除
      count: 1000,
    },
    removeOnFail: {
      age: 86400, // 失败的任务24小时后删除
    },
  },
});

// =============================================================================
// 初始化各模块
// =============================================================================

initShortMemory(redis);
initLongMemory(pgPool);
initCaptcha(redis);
initMediaStore(pgPool);

// =============================================================================
// Express 应用
// =============================================================================

const app = express();

// 信任代理 (Nginx 反向代理场景)
app.set('trust proxy', 1);

// ---- 安全中间件 (按优先级排列) ----

// 1. Helmet: 安全 HTTP 头 (防 XSS/点击劫持/MIME嗅探等)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// 2. CORS 跨域
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));

// 3. 全局速率限制 (每个IP每分钟最多200请求)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' },
  keyGenerator: (req) => req.ip || 'unknown',
});
app.use(globalLimiter);

// 4. 身份验证路由速率限制 (每分钟最多20次)
export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '操作过于频繁，请稍后再试', code: 'AUTH_RATE_LIMITED' },
  skipSuccessfulRequests: false,
});

// 5. Body 解析 (增大限制以支持文件上传)
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// 6. 统一安全中间件 (XSS消毒 + SQL检测 + 输入验证 + 日志)
app.use(securityGuard);

// 静态文件 - 上传目录
app.use('/uploads', express.static('uploads'));
app.use('/stickers', express.static('/app/stickers'));

// 请求日志
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path} from ${req.ip}`);
  next();
});

// 初始化路由模块
initAuthRoutes(pgPool);
initUserRoutes(pgPool);
initAdminRoutes(pgPool);
initImportRoutes(pgPool, redis);
initCharacterRoutes(pgPool);
initBridgeRoutes(pgPool);

// =============================================================================
// 路由
// =============================================================================

/**
 * POST /api/hermes/webhook
 * 接收 Hermes Agent 转发的消息，写入 conversation_logs
 *
 * 请求体:
 * {
 *   "direction": "inbound" | "outbound",
 *   "from_user": "wxid_xxx",
 *   "content": "...",
 *   "msg_type": "text",
 *   "message_id": "...",
 *   "timestamp": 1719000000
 * }
 */
app.post('/api/hermes/webhook', async (req: Request, res: Response) => {
  try {
    const { direction, from_user, content, msg_type, message_id, timestamp } = req.body;

    if (!from_user || !content) {
      res.status(400).json({ error: '缺少必要字段: from_user, content' });
      return;
    }

    // 查找或创建用户
    const userResult = await pgPool.query(
      `INSERT INTO users (wechat_id, last_active_at)
       VALUES ($1, NOW())
       ON CONFLICT (wechat_id) DO UPDATE SET last_active_at = NOW()
       RETURNING id`,
      [from_user]
    );
    const userId = userResult.rows[0].id;

    // 写入对话日志
    const role = direction === 'outbound' ? 'assistant' : 'user';
    await pgPool.query(
      `INSERT INTO conversation_logs (user_id, wechat_id, role, content, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        from_user,
        role,
        content,
        timestamp ? new Date(timestamp * 1000) : new Date(),
      ]
    );

    console.log(
      `[HermesWebhook] 📝 ${role}: "${content.substring(0, 40)}" (user=${from_user})`
    );

    res.status(200).json({ ok: true });
  } catch (error: any) {
    console.error('[HermesWebhook] ❌ 写入失败:', error.message);
    res.status(500).json({ error: '写入失败' });
  }
});

/**
 * GET /health
 * 健康检查接口，返回各服务状态
 */
app.get('/health', async (_req: Request, res: Response) => {
  const health: Record<string, any> = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {},
  };

  // 检查 Redis
  try {
    const pingResult = await redis.ping();
    health.services.redis = pingResult === 'PONG' ? 'healthy' : 'degraded';
  } catch {
    health.services.redis = 'unhealthy';
  }

  // 检查 PostgreSQL
  try {
    const pgResult = await pgPool.query('SELECT 1');
    health.services.postgres = pgResult ? 'healthy' : 'degraded';
  } catch {
    health.services.postgres = 'unhealthy';
  }

  // 检查 BullMQ 队列
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      messageQueue.getWaitingCount(),
      messageQueue.getActiveCount(),
      messageQueue.getCompletedCount(),
      messageQueue.getFailedCount(),
    ]);
    health.services.queue = {
      status: 'healthy',
      waiting,
      active,
      completed,
      failed,
    };
  } catch {
    health.services.queue = { status: 'unhealthy' };
  }

  // 判断总体状态
  const allHealthy = Object.values(health.services).every(
    (s: any) => (typeof s === 'string' ? s === 'healthy' : s.status === 'healthy')
  );
  health.status = allHealthy ? 'ok' : 'degraded';

  const statusCode = allHealthy ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * GET /stats
 * 获取服务统计信息
 */
app.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      messageQueue.getWaitingCount(),
      messageQueue.getActiveCount(),
      messageQueue.getCompletedCount(),
      messageQueue.getFailedCount(),
    ]);

    const memoryUsage = process.memoryUsage();

    res.json({
      queue: { waiting, active, completed, failed },
      memory: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
        rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
      },
      uptime: process.uptime(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// API 路由挂载
// =============================================================================

app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/admin', adminRouter);
app.use('/api/import', importRouter);
app.use('/api/characters', characterRouter);
app.use('/api', bridgeRouter);
app.use('/api/st', stManager);
app.use('/api/memory', initCorrectionRoutes(pgPool));

// =============================================================================
// 404 处理
// =============================================================================

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not Found' });
});

// =============================================================================
// 全局错误处理
// =============================================================================

app.use((err: Error, _req: Request, res: Response, _next: any) => {
  console.error('[Express] 未捕获错误:', err);
  res.status(500).json({ error: '内部服务器错误' });
});

// =============================================================================
// 启动服务器
// =============================================================================

async function start() {
  try {
    // 测试数据库连接
    await pgPool.query('SELECT 1');
    console.log('[PostgreSQL] ✅ 数据库连接验证成功');

    // 测试 Redis
    await redis.ping();
    console.log('[Redis] ✅ 连接验证成功');

    // 测试 BullMQ 队列
    await messageQueue.waitUntilReady();
    console.log('[BullMQ] ✅ 消息队列就绪');

    // 启动 HTTP 服务
    app.listen(PORT, () => {
      console.log('');
      console.log('='.repeat(56));
      console.log('  💬  微信情感陪伴AI平台');
      console.log('='.repeat(56));
      console.log(`  🚀  服务地址:    http://0.0.0.0:${PORT}`);
      console.log(`  📋  健康检查:    http://0.0.0.0:${PORT}/health`);
      console.log(`  📊  队列统计:    http://0.0.0.0:${PORT}/stats`);
      console.log(`  📩  Webhook:     POST /webhook`);
      console.log(`  🔐  认证API:     /api/auth/*`);
      console.log(`  👤  用户API:     /api/user/*`);
      console.log(`  🛡️  管理API:    /api/admin/*`);
      console.log(`  📥  导入API:     /api/import/*`);
      console.log('='.repeat(56));
      console.log('');
    });
  } catch (error: any) {
    console.error('[启动] ❌ 服务启动失败:', error.message);
    process.exit(1);
  }
}

// =============================================================================
// 优雅关闭
// =============================================================================

async function shutdown(signal: string) {
  console.log(`\n[Shutdown] 收到 ${signal} 信号，正在优雅关闭...`);

  try {
    // 关闭队列
    await messageQueue.close();
    console.log('[Shutdown] BullMQ 队列已关闭');

    // 关闭 PostgreSQL
    await pgPool.end();
    console.log('[Shutdown] PostgreSQL 连接池已关闭');

    // 关闭 Redis
    await redis.quit();
    console.log('[Shutdown] Redis 连接已关闭');

    console.log('[Shutdown] ✅ 优雅关闭完成');
    process.exit(0);
  } catch (error: any) {
    console.error('[Shutdown] ❌ 关闭过程中出错:', error.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 启动!
start();
