"use strict";
/**
 * BullMQ Worker - 异步消息处理
 *
 * 处理流程:
 * 1. 从队列取任务
 * 2. 从 Redis 读取短期上下文 (最近10轮对话)
 * 3. 从 PostgreSQL 读取长期记忆摘要
 * 4. 调用情绪分析模块
 * 5. 调用 DeepSeek API 生成回复
 * 6. 更新 Redis 短期记忆
 * 7. 异步更新 PostgreSQL 长期记忆
 * 8. 通过 WeClaw HTTP API 发送回复
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const bullmq_1 = require("bullmq");
const ioredis_1 = require("ioredis");
const pg_1 = require("pg");
const axios_1 = __importDefault(require("axios"));
const short_1 = require("./memory/short");
const long_1 = require("./memory/long");
const analyzer_1 = require("./emotion/analyzer");
const weclawClient_1 = require("./utils/weclawClient");
// =============================================================================
// 配置
// =============================================================================
const QUEUE_NAME = 'wechat-messages';
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '10', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://weclaw:weclaw_secret@postgres:5432/weclaw_companion';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
// =============================================================================
// 初始化连接
// =============================================================================
const redis = new ioredis_1.Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
});
const pgPool = new pg_1.Pool({
    connectionString: DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
});
(0, short_1.initShortMemory)(redis);
(0, long_1.initLongMemory)(pgPool);
const weclawClient = (0, weclawClient_1.getWeClawClient)();
// =============================================================================
// DeepSeek API 调用
// =============================================================================
/**
 * 构建发送给 DeepSeek 的系统提示词
 */
function buildSystemPrompt(userName, emotion, toneGuidance, longTermMemories, shortTermContext, characterPrompt, importMemory) {
    if (characterPrompt) {
        return characterPrompt.replace(/\{\{user\}\}/g, userName || '对方')
            + `\n\n## 共同记忆\n${longTermMemories || '暂无'}\n\n## 当前对话\n${shortTermContext || '新对话'}${importMemory || ''}`;
    }
    return `你和朋友在微信上聊天。用口语化中文回复，简短自然。

${longTermMemories || ''}
当前对话：${shortTermContext || '新对话'}${importMemory || ''}`;
}
/**
 * 加载用户当前激活的角色设定
 */
async function loadActiveCharacter(userId, wechatId) {
    try {
        // 查询用户为该微信账号激活的角色
        const result = await pgPool.query(`SELECT uc.*, ct.name, ct.personality, ct.scenario,
              ct.first_message, ct.example_dialogue,
              ct.system_prompt, ct.post_history, ct.description
       FROM user_characters uc
       JOIN character_templates ct ON uc.template_id = ct.id
       WHERE uc.user_id = $1
         AND uc.linked_wechat_id = $2
         AND uc.is_active = TRUE
       ORDER BY uc.updated_at DESC
       LIMIT 1`, [userId, wechatId]);
        // 如果没找到指定微信的角色，找该用户任意活跃角色
        if (result.rows.length === 0) {
            const fallback = await pgPool.query(`SELECT uc.*, ct.name, ct.personality, ct.scenario,
                ct.first_message, ct.example_dialogue,
                ct.system_prompt, ct.post_history, ct.description
         FROM user_characters uc
         JOIN character_templates ct ON uc.template_id = ct.id
         WHERE uc.user_id = $1 AND uc.is_active = TRUE
         ORDER BY uc.updated_at DESC LIMIT 1`, [userId]);
            if (fallback.rows.length > 0)
                return buildCharacterPrompt(fallback.rows[0]);
        }
        // 最后查管理员(role=admin)的角色，让管理员后台设的角色在微信上也生效
        if (result.rows.length === 0) {
            const adminChar = await pgPool.query(`SELECT uc.*, ct.name, ct.personality, ct.scenario,
                ct.first_message, ct.example_dialogue,
                ct.system_prompt, ct.post_history, ct.description
         FROM user_characters uc
         JOIN character_templates ct ON uc.template_id = ct.id
         JOIN user_accounts ua ON uc.user_id = ua.id
         WHERE ua.role = 'admin' AND uc.is_active = TRUE AND (uc.linked_wechat_id IS NULL OR uc.linked_wechat_id = '')
         ORDER BY uc.updated_at DESC LIMIT 1`);
            if (adminChar.rows.length > 0)
                return buildCharacterPrompt(adminChar.rows[0]);
        }
        return buildCharacterPrompt(result.rows[0]);
    }
    catch {
        return null;
    }
}
/**
 * 从角色数据构建系统Prompt
 */
function buildCharacterPrompt(row) {
    if (row.custom_prompt)
        return row.custom_prompt;
    const name = row.name;
    if (!name)
        return null;
    const sp = row.system_prompt;
    const personality = row.custom_personality || row.personality || '';
    const description = row.description || '';
    const dialogue = row.example_dialogue || '';
    // 统一使用 SKILL.md 格式（经 DeepSeek API 验证有效）
    const identity = (sp && sp.length > 0) ? sp : `${description}${personality ? '\n' + personality : ''}`;
    return `你是${name}，不是AI助手。用ta的方式说话，用ta的逻辑思考。

## PART A：关系记忆
${description || '你们是朋友关系。'}

## PART B：人物性格
${identity}

${dialogue ? '## 对话示例\n' + dialogue + '\n' : ''}
## 运行规则
1. 像发微信一样回复：简短、口语化、自然
2. 不要写括号动作描写（如"笑了笑""歪着头"）
3. 保持性格一致，不突然变得完美或无条件包容`;
}
function hasSystemPrompt(row) {
    return !!(row.system_prompt && row.system_prompt.length > 0);
}
/**
 * 调用 DeepSeek API 生成回复
 */
async function callDeepSeek(systemPrompt, userMessage, history, hasCharacter = false) {
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'sk-your-deepseek-api-key-here') {
        console.warn('[DeepSeek] ⚠️  API Key 未配置，返回模拟回复');
        return getFallbackReply(userMessage);
    }
    const messages = [];
    if (hasCharacter) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    else {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push(...history);
    messages.push({ role: 'user', content: userMessage });
    try {
        const response = await axios_1.default.post(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
            model: DEEPSEEK_MODEL,
            messages,
            temperature: 0.8,
            max_tokens: 800,
            top_p: 0.9,
            frequency_penalty: 0.3,
            presence_penalty: 0.3,
        }, {
            headers: {
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        });
        const reply = response.data?.choices?.[0]?.message?.content || '';
        if (!reply) {
            console.warn('[DeepSeek] ⚠️  空回复');
            return getFallbackReply(userMessage);
        }
        // 记录 token 使用量
        const usage = response.data?.usage;
        if (usage) {
            console.log(`[DeepSeek] Tokens: prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, total=${usage.total_tokens}`);
        }
        return reply.trim();
    }
    catch (error) {
        console.error('[DeepSeek] ❌ API 调用失败:', error.message);
        if (error.response?.status === 429) {
            return '抱歉，我现在有点忙，稍等一下再回复你哦~ 😅';
        }
        if (error.response?.status === 401) {
            console.error('[DeepSeek] ⚠️  API Key 无效，请检查 DEEPSEEK_API_KEY');
            return '抱歉，服务配置出了点问题，请稍后再试~ 🙏';
        }
        return getFallbackReply(userMessage);
    }
}
/**
 * 当 DeepSeek API 不可用时的后备回复
 */
function getFallbackReply(userMessage) {
    const fallbacks = [
        '嗯嗯，我听到了~ 👂',
        '你说的我都有在认真听呢 💭',
        '我理解你的感受，慢慢说 😊',
        '好的好的，我在呢~ 🌟',
        '谢谢你跟我分享这些 🤗',
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}
// =============================================================================
// 记忆更新逻辑
// =============================================================================
/**
 * 检查是否需要生成每日摘要
 * 当用户今日对话达到一定数量时触发
 */
async function maybeGenerateDailySummary(userId) {
    try {
        const stats = await (0, long_1.getConversationStats)(userId);
        // 当日消息超过10条，生成摘要
        if (stats.totalMessages >= 10) {
            const today = new Date().toISOString().split('T')[0];
            const emotionSummary = Object.entries(stats.emotions)
                .map(([emotion, count]) => `${emotion}: ${count}次`)
                .join(', ');
            // 使用对话内容生成简单摘要
            const summaryText = `今日对话${stats.totalMessages}条消息，用户消息${stats.userMessages}条。情绪分布: ${emotionSummary || '无明显情绪波动'}`;
            await (0, long_1.upsertDailySummary)(userId, today, summaryText, stats.emotions ? Object.keys(stats.emotions)[0] : null, [], stats.totalMessages);
            console.log(`[Worker] 📝 已生成每日摘要 (userId=${userId}, messages=${stats.totalMessages})`);
        }
    }
    catch (error) {
        console.error('[Worker] 生成每日摘要失败:', error);
    }
}
/**
 * 从对话中提取关键信息并存储为长期记忆
 */
async function extractAndStoreMemory(userId, userMessage, assistantReply, emotion) {
    try {
        // 简单的关键词提取 (生产环境可以用 LLM 提取更准确)
        const combinedText = `${userMessage} ${assistantReply}`;
        const keywords = extractKeywords(combinedText);
        if (keywords.length > 0) {
            // 生成简短摘要
            const summary = `用户说: "${userMessage.substring(0, 100)}"，AI回复: "${assistantReply.substring(0, 100)}"`;
            await (0, long_1.addMemory)(userId, summary, keywords, emotion, keywords.length > 3 ? 7 : 5, // 关键词多 → 重要度高
            'factual');
        }
    }
    catch (error) {
        console.error('[Worker] 提取记忆失败:', error);
    }
}
/**
 * 简单的中文关键词提取
 */
function extractKeywords(text) {
    const stopWords = ['的', '了', '是', '我', '你', '他', '她', '它', '们', '这', '那', '吗', '呢', '吧', '啊', '哦', '嗯', '在', '和', '就', '都', '也', '还', '要', '有', '不', '会', '能', '很', '多', '说', '想', '看', '去', '来', '到', '对'];
    // 简单分词
    const words = text
        .replace(/[^一-龥a-zA-Z0-9]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2 && !stopWords.includes(w));
    // 去重并取前5个
    const unique = [...new Set(words)];
    return unique.slice(0, 5);
}
// =============================================================================
// Worker 处理函数
// =============================================================================
/**
 * 处理单条微信消息
 */
async function processMessage(job) {
    const { sessionId, wechatId, botId, content, msgType, mediaType, mediaUrl, mediaMime, emotion, emotionConfidence } = job.data;
    const isText = !msgType || msgType === 'text';
    console.log(`[Worker] 🔄 处理消息 (jobId=${job.id}, sessionId=${sessionId}, ` +
        `type=${msgType || 'text'}, content="${content.substring(0, 30)}...")`);
    // ---------------------------------------------------------------------------
    // 1. 获取或创建用户
    // ---------------------------------------------------------------------------
    const user = await (0, long_1.getOrCreateUser)(wechatId);
    // 自动创建仪表盘登录账号 + 获取 account ID
    const account = await (0, long_1.ensureUserAccount)(wechatId, user.nickname || undefined, job.data.msgId);
    const acctId = (await pgPool.query('SELECT id FROM user_accounts WHERE wechat_id=$1', [wechatId])).rows[0]?.id || user.id;
    // 首次创建账号：先发送独立的欢迎消息告知账号信息
    if (account?.isNew && weclawClient.isConfigured()) {
        const welcome = `🎉 欢迎！已自动创建后台账号\n📧 登录名: ${account.email}\n🔑 密码: ${account.password}\n\n🌐 仪表盘: http://localhost:8080\n登录后可查看对话记录、选择AI角色\n\n发送"角色列表"选择或自定义AI风格\n发送"我的账号"查看登录名\n发送"分析性格"从聊天记录生成角色`;
        await weclawClient.sendMessage(welcome, botId, sessionId);
    }
    // ---------------------------------------------------------------------------
    // 2. 处理系统命令
    // ---------------------------------------------------------------------------
    if (isText) {
        const pwdMatch = content.match(/^(修改密码|重置密码)\s+(.+)$/);
        if (pwdMatch) {
            const ok = await (0, long_1.changePassword)(wechatId, pwdMatch[2].trim());
            const reply = ok ? '✅ 密码已修改！请用新密码登录仪表盘。' : '❌ 修改失败，请稍后再试。';
            await (0, short_1.addMessage)(sessionId, 'user', content);
            await (0, short_1.addMessage)(sessionId, 'assistant', reply);
            await (0, long_1.logConversation)(user.id, wechatId, 'user', content);
            await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
            if (weclawClient.isConfigured())
                await weclawClient.sendMessage(reply, botId, sessionId);
            return reply;
        }
        // 角色列表
        if (content.trim() === '角色列表') {
            const chars = await pgPool.query('SELECT id, name, tagline FROM character_templates ORDER BY id');
            const list = chars.rows.map((c) => `${c.id}. ${c.name} — ${c.tagline}`).join('\n');
            const reply = `🎭 可选角色:\n${list}\n\n发送"使用角色 <编号>"切换`;
            await (0, short_1.addMessage)(sessionId, 'user', content);
            await (0, short_1.addMessage)(sessionId, 'assistant', reply);
            await (0, long_1.logConversation)(user.id, wechatId, 'user', content);
            await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
            if (weclawClient.isConfigured())
                await weclawClient.sendMessage(reply, botId, sessionId);
            return reply;
        }
        // 使用角色
        const charMatch = content.match(/^使用角色\s*(.+)$/);
        if (charMatch) {
            const query = charMatch[1].trim();
            const byId = /^\d+$/.test(query);
            const charResult = byId
                ? await pgPool.query('SELECT * FROM character_templates WHERE id=$1', [parseInt(query)])
                : await pgPool.query('SELECT * FROM character_templates WHERE name ILIKE $1', [`%${query}%`]);
            if (charResult.rows.length === 0) {
                const reply = '❌ 未找到该角色，发送"角色列表"查看可选角色。';
                await (0, short_1.addMessage)(sessionId, 'user', content);
                await (0, short_1.addMessage)(sessionId, 'assistant', reply);
                await (0, long_1.logConversation)(user.id, wechatId, 'user', content);
                await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
                if (weclawClient.isConfigured())
                    await weclawClient.sendMessage(reply, botId, sessionId);
                return reply;
            }
            const c = charResult.rows[0];
            await pgPool.query(`UPDATE user_characters SET is_active=FALSE WHERE user_id=$1 AND linked_wechat_id=$2`, [acctId, wechatId]);
            await pgPool.query(`INSERT INTO user_characters (user_id, template_id, linked_wechat_id, is_active)
         VALUES ($1,$2,$3,TRUE) ON CONFLICT (user_id,template_id,linked_wechat_id) DO UPDATE SET is_active=TRUE`, [acctId, c.id, wechatId]);
            const reply = `✅ 已切换为: ${c.name}\n“${c.tagline}”`;
            await (0, short_1.addMessage)(sessionId, 'user', content);
            await (0, short_1.addMessage)(sessionId, 'assistant', reply);
            await (0, long_1.logConversation)(user.id, wechatId, 'user', content);
            await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
            if (weclawClient.isConfigured())
                await weclawClient.sendMessage(reply, botId, sessionId);
            return reply;
        }
        // 创建自定义角色: 创建角色 <名字>:<性格描述>
        const createMatch = content.match(/^创建角色\s+(.+?)[:：]\s*(.+)$/s);
        if (createMatch) {
            const name = createMatch[1].trim();
            const desc = createMatch[2].trim();
            if (name.length > 50 || desc.length < 10) {
                const reply = '❌ 格式: 创建角色 <名字>:<性格描述>\n名字不超过50字，描述不少于10字';
                await (0, short_1.addMessage)(sessionId, 'user', content);
                await (0, short_1.addMessage)(sessionId, 'assistant', reply);
                await (0, long_1.logConversation)(user.id, wechatId, 'user', content);
                await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
                if (weclawClient.isConfigured())
                    await weclawClient.sendMessage(reply, botId, sessionId);
                return reply;
            }
            const result = await pgPool.query(`INSERT INTO character_templates (name, tagline, description, personality, category, tags, creator_id, is_official)
         VALUES ($1,$2,$3,$4,'custom',ARRAY['自定义'],$5,FALSE) RETURNING id`, [name, desc.substring(0, 100), desc, desc, acctId]);
            // 自动激活
            const cid = result.rows[0].id;
            await pgPool.query(`UPDATE user_characters SET is_active=FALSE WHERE user_id=$1 AND linked_wechat_id=$2`, [acctId, wechatId]);
            await pgPool.query(`INSERT INTO user_characters (user_id,template_id,linked_wechat_id,is_active) VALUES ($1,$2,$3,TRUE)
         ON CONFLICT (user_id,template_id,linked_wechat_id) DO UPDATE SET is_active=TRUE`, [user.id, cid, wechatId]);
            const reply = `✅ 已创建并激活角色: ${name}\n“${desc.substring(0, 100)}”`;
            await (0, short_1.addMessage)(sessionId, 'user', content);
            await (0, short_1.addMessage)(sessionId, 'assistant', reply);
            await (0, long_1.logConversation)(user.id, wechatId, 'user', content);
            await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
            if (weclawClient.isConfigured())
                await weclawClient.sendMessage(reply, botId, sessionId);
            return reply;
        }
        // 从聊天记录分析性格: 分析性格
        if (content.trim() === '分析性格') {
            const logs = await pgPool.query(`SELECT content FROM conversation_logs WHERE user_id=$1 AND role='user' ORDER BY created_at DESC LIMIT 50`, [user.id]);
            if (logs.rows.length < 10) {
                const reply = '📝 聊天记录不足（至少需要10条消息），多聊几句再试试吧~';
                await (0, short_1.addMessage)(sessionId, 'user', content);
                await (0, short_1.addMessage)(sessionId, 'assistant', reply);
                await (0, long_1.logConversation)(user.id, wechatId, 'user', content);
                await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
                if (weclawClient.isConfigured())
                    await weclawClient.sendMessage(reply, botId, sessionId);
                return reply;
            }
            const sample = logs.rows.map((r) => r.content).join('\n');
            const analysisPrompt = `根据以下聊天记录，分析说话者的性格特点，输出一段200字以内的角色设定（含性格、说话风格、价值观），用于AI角色扮演：\n\n${sample.substring(0, 3000)}`;
            try {
                const resp = await axios_1.default.post(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
                    model: DEEPSEEK_MODEL, messages: [{ role: 'user', content: analysisPrompt }],
                    temperature: 0.7, max_tokens: 400,
                }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 });
                const analysis = resp.data?.choices?.[0]?.message?.content || '分析失败';
                const reply = `🧠 性格分析结果:\n\n${analysis}\n\n发送"创建角色 <名字>:<上面的描述>"即可基于此创建角色`;
                await (0, short_1.addMessage)(sessionId, 'user', content);
                await (0, short_1.addMessage)(sessionId, 'assistant', reply);
                await (0, long_1.logConversation)(user.id, wechatId, 'user', content);
                await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
                if (weclawClient.isConfigured())
                    await weclawClient.sendMessage(reply, botId, sessionId);
                return reply;
            }
            catch {
                const reply = '❌ 分析失败，请稍后再试。';
                await (0, short_1.addMessage)(sessionId, 'user', content);
                await (0, short_1.addMessage)(sessionId, 'assistant', reply);
                if (weclawClient.isConfigured())
                    await weclawClient.sendMessage(reply, botId, sessionId);
                return reply;
            }
        }
        // 关闭角色
        if (content.trim() === '关闭角色') {
            await pgPool.query(`UPDATE user_characters SET is_active=FALSE WHERE user_id=$1 AND linked_wechat_id=$2`, [user.id, wechatId]);
            const reply = '✅ 已关闭角色，恢复默认聊天风格。';
            await (0, short_1.addMessage)(sessionId, 'user', content);
            await (0, short_1.addMessage)(sessionId, 'assistant', reply);
            await (0, long_1.logConversation)(user.id, wechatId, 'user', content);
            await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
            if (weclawClient.isConfigured())
                await weclawClient.sendMessage(reply, botId, sessionId);
            return reply;
        }
        if (content.trim() === '我的账号') {
            const reply = account?.isNew
                ? `🎉 已为你自动创建账号！\n📧 登录名: ${account.email}\n🔑 密码: ${account.password}\n\n🌐 http://localhost:8080\n请妥善保管，发送"重置密码 <新密码>"可修改。`
                : account
                    ? `📧 登录名: ${account.email}\n忘记了密码？发送"重置密码 <新密码>"即可修改。`
                    : '⚠️ 账号创建失败，请稍后再试。';
            await (0, short_1.addMessage)(sessionId, 'user', content);
            await (0, short_1.addMessage)(sessionId, 'assistant', reply);
            await (0, long_1.logConversation)(user.id, wechatId, 'user', content);
            await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
            if (weclawClient.isConfigured())
                await weclawClient.sendMessage(reply, botId, sessionId);
            return reply;
        }
    }
    // ---------------------------------------------------------------------------
    // 2. 对媒体消息, 生成快速确认回复 (不调用DeepSeek, 节省token)
    // ---------------------------------------------------------------------------
    if (!isText && mediaType) {
        const quickReplies = {
            image: '收到你的图片啦~ 👀✨',
            sticker: '哈哈，这个表情包有意思 😄',
            voice: '语音收到啦，我听到了~ 🎧',
            video: '视频收到！📹',
            file: '文件收到啦~ 📎',
        };
        const reply = quickReplies[mediaType] || '收到啦~';
        const displayContent = content || `[${mediaType}消息]`;
        // 存储短期记忆 (用描述代替实际媒体)
        await (0, short_1.addMessage)(sessionId, 'user', displayContent, emotion || 'neutral');
        await (0, short_1.addMessage)(sessionId, 'assistant', reply);
        // 记录日志 (含媒体信息)
        await (0, long_1.logConversation)(user.id, wechatId, 'user', displayContent, emotion, emotionConfidence, {
            mediaType,
            mediaUrl: mediaUrl || null,
            mediaData: null,
            mediaMime: mediaMime || null,
        });
        await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
        // 发送快速回复
        try {
            if (weclawClient.isConfigured()) {
                await weclawClient.sendMessage(reply, botId, sessionId);
                console.log(`[Worker] ✅ 媒体回复已发送 (type=${mediaType})`);
            }
        }
        catch (err) {
            console.error(`[Worker] ❌ 发送媒体回复失败:`, err.message);
        }
        return reply;
    }
    // ---------------------------------------------------------------------------
    // 3. 文本消息: 完整AI处理流程
    // ---------------------------------------------------------------------------
    // ---------------------------------------------------------------------------
    // 2. 读取短期上下文 (最近10轮对话)
    // ---------------------------------------------------------------------------
    const shortTermMemories = await (0, short_1.getContext)(sessionId);
    // 格式化为 LLM 可读的对话历史
    const historyForLLM = shortTermMemories.map((m) => ({
        role: m.role,
        content: m.content,
    }));
    const shortTermContextText = shortTermMemories
        .map((m) => `${m.role === 'user' ? '👤用户' : '🤖AI'}: ${m.content}`)
        .join('\n');
    // ---------------------------------------------------------------------------
    // 3. 读取历史聊天记忆 (从导入的聊天记录搜索相关内容)
    // ---------------------------------------------------------------------------
    // 聊天记录搜索 → 备用于在回复中穿插引用（仅在匹配度高时使用）
    let importMemory = '';
    try {
        // 仅做精确 ILIKE 匹配搜索（用户明确提到之前聊过的内容）
        const searchTerm = content.substring(0, 30).replace(/[的了是我不他她在和就都也很还要多说想看去来到对]/g, '').trim();
        if (searchTerm.length >= 4) {
            const related = await pgPool.query(`SELECT sender, content FROM imported_messages
         WHERE task_id IN (SELECT id FROM import_tasks ORDER BY created_at DESC LIMIT 1)
           AND length(content) > 10
           AND content ILIKE $1
         ORDER BY timestamp DESC LIMIT 1`, [`%${searchTerm}%`]);
            if (related.rows.length > 0) {
                const r = related.rows[0];
                const isAI = r.sender !== 'Dandelionᝰ';
                importMemory = `\n\n💡 你们曾经聊过类似的话题。${isAI ? '你' : '对方'}当时说: "${r.content.substring(0, 150)}"`;
                console.log(`[Worker] 📚 聊天记录匹配: 1 条`);
            }
        }
    }
    catch (e) {
        // 搜索失败不影响主流程
    }
    // ---------------------------------------------------------------------------
    // 4. 读取长期记忆 (AI 自动生成的摘要)
    // ---------------------------------------------------------------------------
    const longTermMemories = await (0, long_1.getMemories)(user.id, 10);
    // 同时搜索与当前消息相关的记忆
    const relevantMemories = await (0, long_1.searchMemories)(user.id, content, 5);
    // 合并去重
    const allMemories = [...longTermMemories];
    for (const mem of relevantMemories) {
        if (!allMemories.find((m) => m.id === mem.id)) {
            allMemories.push(mem);
        }
    }
    const longTermMemoryText = allMemories
        .slice(0, 8)
        .map((m) => `- ${m.summary_text}`)
        .join('\n');
    // ---------------------------------------------------------------------------
    // 4. 情绪分析 (使用传入的预分析结果，Worker中也重新分析一次)
    // ---------------------------------------------------------------------------
    const freshEmotion = (0, analyzer_1.analyze)(content);
    const finalEmotion = freshEmotion.confidence > 0.5 ? freshEmotion.emotion : emotion;
    const toneGuidance = (0, analyzer_1.getToneGuidance)(finalEmotion);
    // ---------------------------------------------------------------------------
    // 5. 检查积分 + 扣除
    // ---------------------------------------------------------------------------
    const cr = await pgPool.query('SELECT credits FROM user_accounts WHERE wechat_id=$1', [wechatId]);
    const credits = cr.rows[0]?.credits ?? 0;
    if (credits <= 0) {
        const reply = '⚠️ 你的对话额度已用完。请通过邀请好友获取更多积分，或联系管理员。';
        await (0, short_1.addMessage)(sessionId, 'user', content);
        await (0, short_1.addMessage)(sessionId, 'assistant', reply);
        await (0, long_1.logConversation)(user.id, wechatId, 'user', content);
        await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
        if (weclawClient.isConfigured())
            await weclawClient.sendMessage(reply, botId, sessionId);
        return reply;
    }
    await pgPool.query('UPDATE user_accounts SET credits = credits - 1 WHERE wechat_id=$1 AND credits > 0', [wechatId]);
    // ---------------------------------------------------------------------------
    // 6. 加载用户角色设定 + 构建系统提示
    // ---------------------------------------------------------------------------
    // 优先从 bot_accounts.character_id 加载角色
    let characterPrompt = null;
    if (job.data.botId) {
        try {
            const botChar = await pgPool.query(`SELECT ct.system_prompt, ct.personality, ct.name, ct.description,
                ct.example_dialogue, uc.custom_personality, uc.custom_prompt
         FROM bot_accounts b
         LEFT JOIN character_templates ct ON b.character_id = ct.id
         LEFT JOIN user_characters uc ON uc.template_id = ct.id AND uc.linked_wechat_id = $2
         WHERE b.bot_id = $1 AND b.character_id IS NOT NULL
         LIMIT 1`, [job.data.botId, job.data.wechatId]);
            if (botChar.rows.length > 0) {
                characterPrompt = buildCharacterPrompt(botChar.rows[0]);
            }
        }
        catch {
            // fall through to loadActiveCharacter
        }
    }
    // Fallback: 已有的 loadActiveCharacter 逻辑
    if (!characterPrompt) {
        characterPrompt = await loadActiveCharacter(acctId, wechatId);
    }
    if (characterPrompt) {
        console.log(`[Worker] 🎭 已加载角色设定 (${characterPrompt.length} chars, 预览: ${characterPrompt.substring(0, 120)}...)`);
    }
    const systemPrompt = buildSystemPrompt(user.nickname || '', finalEmotion, toneGuidance, longTermMemoryText, shortTermContextText, characterPrompt || undefined, importMemory);
    console.log(`[Worker] 📝 系统提示词 (${systemPrompt.length} chars): ${systemPrompt.substring(0, 150)}...`);
    const aiReply = await callDeepSeek(systemPrompt, content, historyForLLM);
    const reply = aiReply;
    // ---------------------------------------------------------------------------
    // 6. 更新短期记忆 (存储用户消息和AI回复)
    // ---------------------------------------------------------------------------
    await (0, short_1.addMessage)(sessionId, 'user', content, finalEmotion);
    await (0, short_1.addMessage)(sessionId, 'assistant', reply);
    // ---------------------------------------------------------------------------
    // 7. 异步更新长期记忆和日志
    // ---------------------------------------------------------------------------
    // 记录对话日志 (含媒体信息)
    await (0, long_1.logConversation)(user.id, wechatId, 'user', content, finalEmotion, freshEmotion.confidence, {
        mediaType: mediaType || '',
        mediaUrl: mediaUrl || null,
        mediaData: null,
        mediaMime: mediaMime || null,
    });
    await (0, long_1.logConversation)(user.id, wechatId, 'assistant', reply);
    // 提取并存储长期记忆 (异步，不阻塞回复)
    extractAndStoreMemory(user.id, content, reply, finalEmotion).catch((err) => console.error('[Worker] 异步存储记忆失败:', err));
    // 检查是否需要生成每日摘要 (异步)
    maybeGenerateDailySummary(user.id).catch((err) => console.error('[Worker] 异步生成摘要失败:', err));
    // ---------------------------------------------------------------------------
    // 8. 通过 WeClaw API 发送回复 (支持表情包)
    // ---------------------------------------------------------------------------
    try {
        if (weclawClient.isConfigured()) {
            // 自动检测回复情感，发送对应GIF表情包
            const stickerRules = [
                [/晚安|睡了|睡觉/, '晚安'], [/早安|早上好|起床/, '早安'],
                [/加油|努力|冲|挺你/, '加油'], [/欢迎|你好呀|来了/, '欢迎'],
                [/抱抱|抱一抱|想要抱|求抱/, '抱抱'], [/摸摸|摸头|安慰/, '摸摸'],
                [/哈哈|笑死|搞笑|笑/, '笑哭'], [/太棒了|厉害|牛|赞/, '赞'],
                [/爱心|爱你|喜欢|比心/, '爱心'], [/开心|高兴|快乐|太好了/, '开心'],
                [/好吧|好的|行|可以|嗯嗯|OK/, '好的'], [/疑问|什么|？|咋回事/, '疑惑'],
                [/生气|气死|愤怒|可恶/, '生气'], [/拜拜|再见|回头聊/, '再见'],
            ];
            // 尝试发送用户的表情包
            try {
                const fs = require('fs');
                const stickerDir = `/app/stickers/${acctId}`;
                if (fs.existsSync(stickerDir)) {
                    const files = fs.readdirSync(stickerDir).filter((f) => /\.(gif|png|jpg|jpeg|webp)$/i.test(f));
                    if (files.length > 0 && Math.random() < 0.3) { // 30%概率发送表情
                        const sticker = files[Math.floor(Math.random() * files.length)];
                        const stickerUrl = `http://localhost:3000/stickers/${acctId}/${sticker}`;
                        await weclawClient.sendImage(stickerUrl, botId);
                        console.log(`[Worker] 🎨 表情已发送: ${sticker}`);
                    }
                }
            }
            catch { }
            // 发送文字回复 (通过 iLink API 直连)
            try {
                await weclawClient.sendMessage(reply, botId, sessionId);
                console.log(`[Worker] ✅ 回复已发送 (sessionId=${sessionId}, len=${reply.length})`);
            }
            catch (sendErr) {
                console.error(`[Worker] ❌ 发送回复失败:`, sendErr.message);
            }
        }
        else {
            console.warn('[Worker] ⚠️  WeClaw 客户端未配置，无法发送回复');
            console.log(`[Worker] 📝 生成的回复: ${reply.substring(0, 100)}...`);
        }
    }
    catch (error) {
        console.error(`[Worker] ❌ 发送回复失败:`, error.message);
    }
    return reply;
}
// =============================================================================
// 创建 Worker
// =============================================================================
// =============================================================================
// 导入 Worker — 异步处理聊天记录导入
// =============================================================================
const importWorker = new bullmq_1.Worker('chat-import', async (job) => {
    const { taskId, userId, filePath, filename, extractDir, stickerList, userStickerDir } = job.data;
    console.log(`[ImportWorker] 🔄 处理导入: taskId=${taskId}, file=${filename}`);
    try {
        const fs = require('fs');
        const path = require('path');
        const stat = fs.statSync(filePath);
        // 1. 后台复制表情包到用户目录 (避免阻塞 HTTP 响应)
        if (stickerList && stickerList.length > 0 && userStickerDir) {
            fs.mkdirSync(userStickerDir, { recursive: true, mode: 0o777 });
            let copied = 0;
            for (const sf of stickerList) {
                try {
                    const dest = path.join(userStickerDir, path.basename(sf));
                    if (!fs.existsSync(dest)) {
                        fs.copyFileSync(sf, dest);
                        copied++;
                    }
                }
                catch { }
            }
            console.log(`[ImportWorker] 🎨 表情包: ${copied}/${stickerList.length}`);
        }
        if (!filePath) {
            await pgPool.query(`UPDATE import_tasks SET status='done', message_count=0 WHERE id=$1`, [taskId]);
            return;
        }
        // 拒绝二进制文件（防止解析二进制导致 OOM）
        const ext = path.extname(filePath).toLowerCase();
        const textExts = ['.html', '.htm', '.json', '.csv', '.txt'];
        if (!textExts.includes(ext)) {
            throw new Error(`不支持的文件类型: ${ext}，请上传 ${textExts.join('/')} 格式`);
        }
        if (stat.size > 200 * 1024 * 1024) {
            throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(0)}MB > 200MB)，请拆分后上传`);
        }
        await pgPool.query(`UPDATE import_tasks SET status='processing', progress=0 WHERE id=$1`, [taskId]);
        // 获取用户昵称用于识别 isFromUser
        let userNickname = '';
        try {
            const ur = await pgPool.query('SELECT nickname, wechat_id FROM user_accounts WHERE id=$1', [userId]);
            if (ur.rows[0]) {
                userNickname = ur.rows[0].nickname || ur.rows[0].wechat_id || '';
            }
        }
        catch { }
        console.log(`[ImportWorker] userNickname="${userNickname}"`);
        const { parseChatExportStreaming } = require('./modules/importer');
        let stored = 0;
        // 统计发送者: isFromUser=true → 用户本人, isFromUser=false → 对方(AI)
        const senderCounts = {};
        // 流式解析 + 批量插入 (每500条一批)，避免全量载入内存
        let total = 0;
        total = await parseChatExportStreaming(filePath, 'auto', { userNickname }, async (batch, progress) => {
            if (batch.length === 0)
                return;
            const values = [];
            const params = [];
            let paramIdx = 1;
            for (const msg of batch) {
                const s = msg.sender || 'unknown';
                if (!senderCounts[s])
                    senderCounts[s] = { total: 0, fromUser: 0, notUser: 0 };
                senderCounts[s].total++;
                if (msg.isFromUser)
                    senderCounts[s].fromUser++;
                else
                    senderCounts[s].notUser++;
                values.push(`($${paramIdx},$${paramIdx + 1},$${paramIdx + 2},$${paramIdx + 3},$${paramIdx + 4},$${paramIdx + 5})`);
                params.push(taskId, userId, s, msg.content || '', msg.timestamp || new Date(), 'text');
                paramIdx += 6;
            }
            await pgPool.query(`INSERT INTO imported_messages (task_id, user_id, sender, content, timestamp, msg_type) VALUES ${values.join(',')}`, params);
            stored += batch.length;
            const pct = Math.min(99, Math.round(stored / Math.max(1, stored + 1000) * 100));
            await pgPool.query(`UPDATE import_tasks SET progress=$1, message_count=$2 WHERE id=$3`, [pct, stored, taskId]);
        });
        // 识别用户和AI: fromUser最高=用户本人, notUser最高=对方(AI)
        let aiName = '';
        let userName = userNickname || '';
        let aiBest = 0, userBest = 0;
        for (const [name, c] of Object.entries(senderCounts)) {
            if (c.notUser > aiBest) {
                aiBest = c.notUser;
                aiName = name;
            }
            if (c.fromUser > userBest) {
                userBest = c.fromUser;
                userName = name;
            }
        }
        if (!aiName && Object.keys(senderCounts).length > 0) {
            // 所有消息都是同一人发的？第一个非空sender作为aiName
            aiName = Object.keys(senderCounts)[0];
        }
        console.log(`[ImportWorker] 识别: aiName="${aiName}" (notUser=${aiBest}), userName="${userName}" (fromUser=${userBest})`);
        const curMeta = (await pgPool.query('SELECT meta FROM import_tasks WHERE id=$1', [taskId])).rows[0]?.meta || {};
        const updMeta = { ...curMeta, aiName: aiName || undefined, userName: userName || undefined };
        await pgPool.query(`UPDATE import_tasks SET status='done', progress=100, message_count=$1, meta=$2::jsonb WHERE id=$3`, [stored, JSON.stringify(updMeta), taskId]);
        console.log(`[ImportWorker] ✅ 导入完成: taskId=${taskId}, messages=${stored}`);
    }
    catch (err) {
        console.error(`[ImportWorker] ❌ 导入失败:`, err.message);
        await pgPool.query(`UPDATE import_tasks SET status='error', error_message=$1 WHERE id=$2`, [err.message, taskId]);
    }
}, { connection: redis, concurrency: 2 });
const worker = new bullmq_1.Worker(QUEUE_NAME, processMessage, {
    connection: redis,
    concurrency: WORKER_CONCURRENCY,
    autorun: true,
    lockDuration: 60000, // 任务锁定时间60秒
    stalledInterval: 30000, // 检查停滞任务间隔
    maxStalledCount: 2, // 停滞任务最大重试次数
});
// =============================================================================
// Worker 事件监听
// =============================================================================
worker.on('completed', (job) => {
    console.log(`[Worker] ✅ 任务完成 (jobId=${job.id})`);
});
worker.on('failed', (job, err) => {
    console.error(`[Worker] ❌ 任务失败 (jobId=${job?.id}, attempts=${job?.attemptsMade}):`, err.message);
});
worker.on('error', (err) => {
    console.error('[Worker] ❌ Worker 错误:', err.message);
});
worker.on('stalled', (jobId) => {
    console.warn(`[Worker] ⚠️  任务停滞 (jobId=${jobId})`);
});
worker.on('drained', () => {
    console.log('[Worker] 📭 队列已清空');
});
// =============================================================================
// 启动
// =============================================================================
async function start() {
    try {
        // 验证连接
        await pgPool.query('SELECT 1');
        await redis.ping();
        await worker.waitUntilReady();
        console.log('');
        console.log('='.repeat(56));
        console.log('  🔧  BullMQ Worker - 异步消息处理器');
        console.log('='.repeat(56));
        console.log(`  📋  队列名称: ${QUEUE_NAME}`);
        console.log(`  ⚡  并发数:   ${WORKER_CONCURRENCY}`);
        console.log(`  🤖  AI模型:   ${DEEPSEEK_MODEL}`);
        console.log(`  🔗  API地址:  ${DEEPSEEK_BASE_URL}`);
        console.log(`  📡  WeClaw:   ${weclawClient.isConfigured() ? '✅ 已配置' : '⚠️ 未配置'}`);
        console.log('='.repeat(56));
        console.log('');
    }
    catch (error) {
        console.error('[Worker] ❌ 启动失败:', error.message);
        process.exit(1);
    }
}
// =============================================================================
// 优雅关闭
// =============================================================================
async function shutdown(signal) {
    console.log(`\n[Worker] 收到 ${signal} 信号，正在优雅关闭...`);
    console.log('[Worker] 等待当前任务完成...');
    try {
        await worker.close();
        await importWorker.close();
        console.log('[Worker] Worker 已关闭');
        await pgPool.end();
        console.log('[Worker] PostgreSQL 连接池已关闭');
        await redis.quit();
        console.log('[Worker] Redis 连接已关闭');
        console.log('[Worker] ✅ 优雅关闭完成');
        process.exit(0);
    }
    catch (error) {
        console.error('[Worker] 关闭失败:', error.message);
        process.exit(1);
    }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
start();
//# sourceMappingURL=worker.js.map