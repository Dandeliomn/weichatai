/**
 * AI角色系统路由
 *
 * GET    /api/characters             — 浏览角色库 (分页/搜索/标签筛选)
 * GET    /api/characters/:id         — 角色详情
 * POST   /api/characters/import      — 导入角色 (chara_card_v2 JSON)
 * POST   /api/characters/import-url  — 从GitHub URL导入
 * POST   /api/characters/custom      — 创建自定义角色
 * PUT    /api/characters/:id         — 编辑角色
 * DELETE /api/characters/:id         — 删除角色
 * POST   /api/characters/:id/activate — 激活角色 (应用到指定微信账号)
 * GET    /api/characters/mine        — 我的角色
 */
import { Pool } from 'pg';
declare const router: import("express-serve-static-core").Router;
export declare function initCharacterRoutes(pool: Pool): void;
export default router;
//# sourceMappingURL=characters.d.ts.map