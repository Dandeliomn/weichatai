"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initCharacterRoutes = initCharacterRoutes;
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const axios_1 = __importDefault(require("axios"));
const router = (0, express_1.Router)();
let pgPool;
function initCharacterRoutes(pool) {
    pgPool = pool;
}
router.use(auth_1.authenticate);
// =============================================================================
// GET /api/characters — 角色库
// =============================================================================
router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = (page - 1) * limit;
        const search = (req.query.search || '').trim();
        const tag = req.query.tag;
        const category = req.query.category;
        const conditions = ['(is_public = TRUE OR creator_id = $1)'];
        const params = [req.user.userId];
        let idx = 2;
        if (search) {
            conditions.push(`(name ILIKE $${idx} OR tagline ILIKE $${idx} OR description ILIKE $${idx})`);
            params.push(`%${search}%`);
            idx++;
        }
        if (tag) {
            conditions.push(`$${idx} = ANY(tags)`);
            params.push(tag);
            idx++;
        }
        if (category) {
            conditions.push(`category = $${idx}`);
            params.push(category);
            idx++;
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const [chars, count] = await Promise.all([
            pgPool.query(`SELECT id, name, tagline, category, tags, is_official, use_count, rating, creator_id, created_at
         FROM character_templates ${where}
         ORDER BY is_official DESC, use_count DESC, created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]),
            pgPool.query(`SELECT COUNT(*) FROM character_templates ${where}`, params),
        ]);
        res.json({
            characters: chars.rows,
            total: parseInt(count.rows[0].count),
            page, limit,
        });
    }
    catch (err) {
        res.status(500).json({ error: '获取角色库失败' });
    }
});
// =============================================================================
// GET /api/characters/:id
// =============================================================================
router.get('/:id', async (req, res) => {
    try {
        const result = await pgPool.query(`SELECT * FROM character_templates WHERE id = $1 AND (is_public = TRUE OR creator_id = $2)`, [req.params.id, req.user.userId]);
        if (result.rows.length === 0) {
            res.status(404).json({ error: '角色不存在' });
            return;
        }
        res.json({ character: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ error: '获取角色详情失败' });
    }
});
// =============================================================================
// POST /api/characters/import — 导入 Character Card V2 JSON
// =============================================================================
router.post('/import', async (req, res) => {
    try {
        const card = req.body;
        // 支持两种格式: chara_card_v2 规范 和 简化格式
        let name, description, personality, scenario, firstMessage, exampleDialogue, systemPrompt, postHistory, tags;
        if (card.spec === 'chara_card_v2') {
            // 标准 Character Card V2 格式
            const d = card.data || card;
            name = d.name;
            description = d.description;
            personality = d.personality;
            scenario = d.scenario;
            firstMessage = d.first_mes || d.first_message;
            exampleDialogue = d.mes_example || d.example_dialogue;
            systemPrompt = d.system_prompt;
            postHistory = d.post_history_instructions;
            tags = d.tags || [];
        }
        else {
            // 简化格式 (直接传字段)
            name = card.name;
            description = card.description;
            personality = card.personality;
            scenario = card.scenario;
            firstMessage = card.first_message || card.first_mes;
            exampleDialogue = card.example_dialogue || card.mes_example;
            systemPrompt = card.system_prompt;
            postHistory = card.post_history_instructions;
            tags = card.tags || [];
        }
        if (!name || !personality) {
            res.status(400).json({ error: '角色名称(name)和性格(personality)为必填字段' });
            return;
        }
        const result = await pgPool.query(`INSERT INTO character_templates
       (name, tagline, description, personality, scenario, first_message,
        example_dialogue, system_prompt, post_history, tags, category,
        source_url, creator_id, is_public, card_version, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'imported',$11,$12,FALSE,'v2',$13)
       RETURNING id, name, tagline`, [
            name,
            card.tagline || card.description?.substring(0, 200) || '',
            description || '',
            personality,
            scenario || '',
            firstMessage || '',
            exampleDialogue || '',
            systemPrompt || '',
            postHistory || '',
            tags || [],
            card.source_url || card.sourceUrl || null,
            req.user.userId,
            JSON.stringify(card.metadata || card.extensions || {}),
        ]);
        console.log(`[Character] 导入角色: ${name}`);
        res.status(201).json({ character: result.rows[0], message: '角色导入成功' });
    }
    catch (err) {
        console.error('[Character] 导入失败:', err.message);
        res.status(500).json({ error: '导入失败' });
    }
});
// =============================================================================
// POST /api/characters/import-url — 从GitHub URL导入
// =============================================================================
router.post('/import-url', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            res.status(400).json({ error: '请提供 URL' });
            return;
        }
        // 处理GitHub URL → raw URL
        let rawUrl = url;
        if (url.includes('github.com') && !url.includes('raw.githubusercontent.com')) {
            rawUrl = url
                .replace('github.com', 'raw.githubusercontent.com')
                .replace('/blob/', '/');
        }
        console.log(`[Character] 从URL导入: ${rawUrl}`);
        const response = await axios_1.default.get(rawUrl, { timeout: 15000 });
        const card = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        card.source_url = url;
        card.sourceUrl = url;
        // 标准化字段
        const name = card.data?.name || card.name;
        const personality = card.data?.personality || card.personality;
        const description = card.data?.description || card.description || '';
        const scenario = card.data?.scenario || card.scenario || '';
        const firstMessage = card.data?.first_mes || card.data?.first_message || card.first_message || '';
        const exampleDialogue = card.data?.mes_example || card.data?.example_dialogue || card.example_dialogue || '';
        const systemPrompt = card.data?.system_prompt || card.system_prompt || '';
        const postHistory = card.data?.post_history_instructions || card.post_history_instructions || '';
        const tags = card.data?.tags || card.tags || [];
        if (!name || !personality) {
            res.status(400).json({ error: '角色名称和性格为必填' });
            return;
        }
        const result = await pgPool.query(`INSERT INTO character_templates
       (name, tagline, description, personality, scenario, first_message,
        example_dialogue, system_prompt, post_history, tags, category,
        source_url, creator_id, is_public, card_version, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'imported',$11,$12,FALSE,'v2',$13)
       RETURNING id, name, tagline`, [name, card.tagline || description.substring(0, 200) || '', description, personality,
            scenario, firstMessage, exampleDialogue, systemPrompt, postHistory,
            tags, url, req.user.userId, JSON.stringify(card.metadata || card.extensions || {})]);
        console.log(`[Character] URL导入角色: ${name}`);
        res.status(201).json({ character: result.rows[0], message: '角色导入成功' });
    }
    catch (err) {
        console.error('[Character] URL导入失败:', err.message);
        res.status(500).json({ error: `URL导入失败: ${err.message}` });
    }
});
// =============================================================================
// POST /api/characters/custom — 创建自定义角色
// =============================================================================
router.post('/custom', async (req, res) => {
    try {
        const { name, tagline, description, personality, scenario, firstMessage, exampleDialogue, systemPrompt, tags } = req.body;
        if (!name || !personality) {
            res.status(400).json({ error: '角色名称和性格描述为必填' });
            return;
        }
        const result = await pgPool.query(`INSERT INTO character_templates
       (name, tagline, description, personality, scenario, first_message,
        example_dialogue, system_prompt, tags, category, creator_id, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'custom',$10,FALSE)
       RETURNING *`, [name, tagline || '', description || '', personality,
            scenario || '', firstMessage || '', exampleDialogue || '',
            systemPrompt || '', tags || [], req.user.userId]);
        console.log(`[Character] 创建自定义角色: ${name}`);
        res.status(201).json({ character: result.rows[0] });
    }
    catch (err) {
        res.status(500).json({ error: '创建失败' });
    }
});
// =============================================================================
// POST /api/characters/:id/activate — 激活角色
// =============================================================================
router.post('/:id/activate', async (req, res) => {
    try {
        const charId = parseInt(req.params.id);
        const { wechatId, customName, customPersonality, customPrompt } = req.body;
        // 验证角色存在
        const char = await pgPool.query('SELECT * FROM character_templates WHERE id = $1', [charId]);
        if (char.rows.length === 0) {
            res.status(404).json({ error: '角色不存在' });
            return;
        }
        // 如果指定了微信ID，先停用该微信的其他活跃角色
        if (wechatId) {
            await pgPool.query(`UPDATE user_characters SET is_active = FALSE
         WHERE user_id = $1 AND linked_wechat_id = $2`, [req.user.userId, wechatId]);
        }
        // 创建或更新用户角色关联
        const result = await pgPool.query(`INSERT INTO user_characters
       (user_id, template_id, custom_name, custom_personality, custom_prompt,
        linked_wechat_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE)
       ON CONFLICT (user_id, template_id, linked_wechat_id)
       DO UPDATE SET
         custom_name = COALESCE(EXCLUDED.custom_name, user_characters.custom_name),
         custom_personality = COALESCE(EXCLUDED.custom_personality, user_characters.custom_personality),
         custom_prompt = COALESCE(EXCLUDED.custom_prompt, user_characters.custom_prompt),
         is_active = TRUE,
         updated_at = NOW()
       RETURNING *`, [
            req.user.userId, charId,
            customName || null,
            customPersonality || null,
            customPrompt || null,
            wechatId || null,
        ]);
        // 更新使用次数
        await pgPool.query('UPDATE character_templates SET use_count = use_count + 1 WHERE id = $1', [charId]);
        console.log(`[Character] 激活角色: ${char.rows[0].name} (userId=${req.user.userId})`);
        // 同步到 Hermes (如果存在对应的 ex-skill)
        try {
            const charName = char.rows[0].name;
            const { execSync } = require('child_process');
            const personaList = execSync('python3 /home/dandelion/.hermes/scripts/persona_manager.py list', {
                encoding: 'utf-8', timeout: 5000,
            });
            // 按名称匹配 ex-skill slug
            const match = personaList.match(new RegExp(`\\(([^)]+)\\)\\s*\\n.*${charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
            if (match) {
                const slug = match[1];
                execSync(`python3 /home/dandelion/.hermes/scripts/persona_manager.py switch ${slug} --keep-memory`, {
                    timeout: 15000,
                });
                console.log(`[Character] Hermes已同步切换: ${slug}`);
            }
        }
        catch (e) {
            console.warn(`[Character] Hermes同步跳过: ${e.message}`);
        }
        res.json({ userCharacter: result.rows[0], message: `已激活角色: ${char.rows[0].name}` });
    }
    catch (err) {
        res.status(500).json({ error: '激活失败' });
    }
});
// =============================================================================
// GET /api/characters/mine — 我的角色
// =============================================================================
router.get('/list/mine', async (req, res) => {
    try {
        const result = await pgPool.query(`SELECT uc.*, ct.name, ct.tagline, ct.tags, ct.category, ct.system_prompt
       FROM user_characters uc
       JOIN character_templates ct ON uc.template_id = ct.id
       WHERE uc.user_id = $1
       ORDER BY uc.is_active DESC, uc.updated_at DESC`, [req.user.userId]);
        res.json({ characters: result.rows });
    }
    catch (err) {
        res.status(500).json({ error: '获取失败' });
    }
});
// =============================================================================
// DELETE /api/characters/:id — 删除 (仅自己的)
// =============================================================================
router.delete('/:id', async (req, res) => {
    try {
        // 先停用所有关联
        await pgPool.query('UPDATE user_characters SET is_active = FALSE WHERE template_id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
        const result = await pgPool.query(`DELETE FROM character_templates
       WHERE id = $1 AND creator_id = $2 AND category != 'preset'
       RETURNING id, name`, [req.params.id, req.user.userId]);
        if (result.rows.length === 0) {
            res.status(404).json({ error: '角色不存在或无法删除(预置角色不可删)' });
            return;
        }
        res.json({ message: '已删除' });
    }
    catch (err) {
        res.status(500).json({ error: '删除失败' });
    }
});
exports.default = router;
//# sourceMappingURL=characters.js.map