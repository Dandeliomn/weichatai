"use strict";
/**
 * 用户画像分析器
 *
 * 调用 LLM 分析导入的聊天记录，提取用户特征:
 * - 性格特征 (外向/内向, 感理/感性等)
 * - 沟通风格 (简洁/啰嗦, 正式/随意, 表情包使用频率)
 * - 兴趣爱好 (从聊天内容中提取)
 * - 核心关系 (最常联系的人)
 * - 常用词汇与表达习惯
 *
 * 生成个性化 AI Prompt
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeChatProfile = analyzeChatProfile;
exports.generateUserContext = generateUserContext;
const axios_1 = __importDefault(require("axios"));
// =============================================================================
// 主分析函数
// =============================================================================
/**
 * 分析聊天记录，生成用户画像
 *
 * @param messages - 解析出的消息数组
 * @param options - 分析选项
 * @returns 用户画像
 */
async function analyzeChatProfile(messages, options = {}) {
    const apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY || '';
    const baseUrl = options.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    const model = options.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    if (!apiKey || apiKey === 'sk-your-deepseek-api-key-here') {
        console.warn('[ProfileAnalyzer] API Key 未配置，使用模拟分析');
        return getMockProfile(messages);
    }
    // 准备消息样本
    const userMessages = messages.filter((m) => m.isFromUser).slice(0, 500);
    const otherMessages = messages.filter((m) => !m.isFromUser).slice(0, 500);
    // 构建分析 Prompt
    const systemPrompt = buildAnalysisSystemPrompt();
    const userPrompt = buildAnalysisUserPrompt(userMessages, otherMessages, options.userNickname);
    try {
        const response = await axios_1.default.post(`${baseUrl}/v1/chat/completions`, {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: 2000,
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 60000,
        });
        const rawAnalysis = response.data?.choices?.[0]?.message?.content || '';
        return parseProfileResult(rawAnalysis, messages);
    }
    catch (error) {
        console.error('[ProfileAnalyzer] LLM 分析失败:', error.message);
        return getMockProfile(messages);
    }
}
// =============================================================================
// Prompt 构建
// =============================================================================
function buildAnalysisSystemPrompt() {
    return `你是一个专业的用户画像分析师。你的任务是根据导入的微信聊天记录，分析用户的性格特征和沟通风格。

请严格按以下JSON格式输出分析结果:
{
  "personality": "性格特征描述 (50-100字)",
  "communicationStyle": "沟通风格描述 (50-100字)",
  "hobbies": ["兴趣爱好1", "兴趣爱好2", "..."],
  "keywords": ["常用词汇1", "常用词汇2", "..."],
  "topicsOfInterest": ["关心话题1", "关心话题2", "..."],
  "keyRelationships": [
    {"name": "联系人昵称", "relation": "关系描述"}
  ],
  "emotionalPatterns": "情绪表达模式描述 (30-50字)",
  "customPrompt": "为AI陪伴助手生成一段个性化prompt设定 (100-200字)，让AI能够以符合用户聊天风格的方式交流"
}

注意:
- 只输出JSON，不要有其他内容
- 所有描述使用中文
- hobbies/keywords/topicsOfInterest 各提取3-8个
- keyRelationships 提取1-3个最重要的联系人
- customPrompt 要包含: 称呼方式、语气建议、话题偏好、注意事项`;
}
function buildAnalysisUserPrompt(userMessages, otherMessages, userNickname) {
    // 用户消息样本 (最多100条)
    const userSample = userMessages
        .slice(0, 100)
        .map((m) => `[${m.timestamp.toISOString()}] 用户: ${m.content}`)
        .join('\n');
    // 其他人的消息样本 (最多50条，用于理解关系)
    const otherSample = otherMessages
        .slice(0, 50)
        .map((m) => `[${m.timestamp.toISOString()}] ${m.sender}: ${m.content}`)
        .join('\n');
    // 统计数据
    const totalUserMessages = userMessages.length;
    const totalOtherMessages = otherMessages.length;
    const uniqueSenders = [...new Set(otherMessages.map((m) => m.sender))];
    // 活跃时段统计
    const hourCounts = {};
    for (const m of userMessages) {
        const hour = new Date(m.timestamp).getHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }
    const peakHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];
    // 消息长度统计
    const avgLength = userMessages.length > 0
        ? Math.round(userMessages.reduce((sum, m) => sum + m.content.length, 0) /
            userMessages.length)
        : 0;
    return `请分析以下微信聊天记录数据:

## 基本信息
- 用户昵称: ${userNickname || '未知'}
- 用户消息总数: ${totalUserMessages} 条
- 其他联系人总数: ${uniqueSenders.length} 人
- 最活跃时段: ${peakHour ? `${peakHour[0]}:00 (${peakHour[1]}条消息)` : '未知'}
- 平均消息长度: ${avgLength} 字

## 联系人列表
${uniqueSenders.slice(0, 10).join(', ')}

## 用户消息样本
${userSample || '(无用户消息)'}

## 其他人消息样本
${otherSample || '(无其他消息)'}

请按照系统提示的JSON格式输出分析结果。`;
}
// =============================================================================
// 结果解析
// =============================================================================
function parseProfileResult(rawAnalysis, messages) {
    try {
        // 尝试从LLM输出中提取 JSON
        const jsonMatch = rawAnalysis.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                personality: parsed.personality || '暂无分析',
                communicationStyle: parsed.communicationStyle || '暂无分析',
                hobbies: parsed.hobbies || [],
                keywords: parsed.keywords || [],
                topicsOfInterest: parsed.topicsOfInterest || [],
                keyRelationships: parsed.keyRelationships || [],
                emotionalPatterns: parsed.emotionalPatterns || '暂无分析',
                customPrompt: parsed.customPrompt || '',
                rawAnalysis,
            };
        }
    }
    catch {
        console.warn('[ProfileAnalyzer] JSON 解析失败，使用模拟分析');
    }
    return getMockProfile(messages);
}
// =============================================================================
// 模拟分析 (降级方案)
// =============================================================================
function getMockProfile(messages) {
    const userMsgs = messages.filter((m) => m.isFromUser);
    const totalMessages = userMsgs.length;
    // 统计基础信息
    const wordCount = userMsgs.reduce((sum, m) => sum + m.content.length, 0);
    const avgLength = totalMessages > 0 ? Math.round(wordCount / totalMessages) : 0;
    // 情绪表情使用统计
    const emojiCount = userMsgs.filter((m) => /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1FA00}-\u{1FA6F}]/u.test(m.content)).length;
    // 活跃时段统计
    const hourCounts = {};
    for (const m of userMsgs) {
        const hour = new Date(m.timestamp).getHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }
    const communicationStyle = avgLength < 20
        ? '简洁直接，喜欢用短句和表情包表达'
        : avgLength < 60
            ? '自然流畅，表达恰到好处'
            : '善于表达，喜欢详细描述自己的想法';
    const personality = emojiCount > totalMessages * 0.3
        ? '活泼开朗，善于用表情符号表达情绪'
        : '沉稳理性，表达以文字为主';
    // 生成自定义 Prompt
    const customPrompt = `用户沟通风格: ${communicationStyle}。性格: ${personality}。
回复时请:
1. 使用与用户相似的消息长度 (平均${avgLength}字)
2. ${emojiCount > totalMessages * 0.2 ? '适当使用表情符号' : '以文字表达为主，不过度使用表情'}
3. 保持自然友好的朋友聊天风格
4. 根据用户的话题偏好调整回复内容`;
    return {
        personality,
        communicationStyle,
        hobbies: ['聊天社交', '日常生活'],
        keywords: [],
        topicsOfInterest: ['日常生活', '情感交流'],
        keyRelationships: [],
        emotionalPatterns: '情绪表达自然',
        customPrompt,
        rawAnalysis: `模拟分析: ${totalMessages} 条用户消息`,
    };
}
/**
 * 生成可用于注入到主 Worker Prompt 中的用户上下文
 */
function generateUserContext(profile) {
    const parts = [];
    if (profile.personality) {
        parts.push(`- 性格: ${profile.personality}`);
    }
    if (profile.communicationStyle) {
        parts.push(`- 沟通风格: ${profile.communicationStyle}`);
    }
    if (profile.hobbies.length > 0) {
        parts.push(`- 兴趣爱好: ${profile.hobbies.join('、')}`);
    }
    if (profile.topicsOfInterest.length > 0) {
        parts.push(`- 关心话题: ${profile.topicsOfInterest.join('、')}`);
    }
    return parts.length > 0 ? `基于聊天记录分析的用户画像:\n${parts.join('\n')}` : '';
}
//# sourceMappingURL=profile-analyzer.js.map