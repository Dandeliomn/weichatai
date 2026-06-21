/**
 * 聊天记录导入路由
 *
 * POST /api/import/upload      — 上传聊天记录文件
 * POST /api/import/weflow-api  — 接收 WeFlow API 提取的数据 (含base64表情包)
 * GET  /api/import/status/:id  — 查看处理进度
 * GET  /api/import/analysis/:id— 获取 AI 分析结果
 * POST /api/import/apply       — 将分析结果应用到 AI 陪伴
 */
import { Pool } from 'pg';
import { Redis } from 'ioredis';
declare const router: import("express-serve-static-core").Router;
export declare function initImportRoutes(pool: Pool, redis: Redis): void;
export default router;
//# sourceMappingURL=import.d.ts.map