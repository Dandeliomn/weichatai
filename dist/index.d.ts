/**
 * 微信情感陪伴AI服务 - 主服务入口
 *
 * 功能:
 * 1. 启动 Express 服务器，接收 WeClaw 转发的微信消息
 * 2. 根据 FromUserName 区分用户，生成 sessionId
 * 3. 将消息放入 BullMQ 队列，立即返回"正在思考中..."占位回复
 * 4. 提供 /health 健康检查接口
 */
import 'dotenv/config';
export declare const authLimiter: import("express-rate-limit").RateLimitRequestHandler;
//# sourceMappingURL=index.d.ts.map