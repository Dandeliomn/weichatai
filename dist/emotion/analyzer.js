"use strict";
/**
 * 情绪分析模块
 * 分析用户消息的情感倾向，输出情绪类型和置信度
 *
 * 使用基于规则的关键词匹配 + 简单启发式算法
 * 支持四种基本情绪: 快乐(happy), 悲伤(sad), 愤怒(angry), 焦虑(anxious), 以及中性(neutral)
 *
 * 导出接口: analyze(text: string) => { emotion: string, confidence: number }
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyze = analyze;
exports.getEmotionDescription = getEmotionDescription;
exports.getToneGuidance = getToneGuidance;
// =============================================================================
// 情绪关键词词典
// =============================================================================
/** 快乐相关词汇 */
const HAPPY_WORDS = [
    '哈哈', '嘻嘻', '嘿嘿', '开心', '高兴', '快乐', '太好', '棒', '赞',
    '喜欢', '爱', '可爱', '美好', '幸福', '满足', '感恩', '感谢', '谢谢',
    '不错', 'nice', 'good', 'great', 'wonderful', 'awesome',
    '笑死', '😂', '🤣', '😄', '😊', '🥰', '😍', '💕', '✨',
    '终于', '成功', '恭喜', '庆祝', '太棒了', '完美', '优秀',
    '感动', '温暖', '治愈', '舒服', '放松',
];
/** 悲伤相关词汇 */
const SAD_WORDS = [
    '难过', '伤心', '悲伤', '哭', '泪', '痛苦', '难受', '不舒服',
    '失落', '失望', '沮丧', '绝望', '无助', '孤独', '寂寞',
    '想哭', '心累', '心酸', '心如刀割', '崩溃',
    '😢', '😭', '😔', '😞', '💔', '🥺',
    '抑郁', '消沉', '闷闷不乐', '提不起劲',
    '失败', '没用', '糟糕', '惨',
    '失去了', '离开了', '不见了',
];
/** 愤怒相关词汇 */
const ANGRY_WORDS = [
    '生气', '愤怒', '恼火', '火大', '操', '靠', '妈的', '特么',
    '可恶', '讨厌', '烦', '恶心', '受不了', '忍不了',
    '😠', '😡', '🤬', '💢',
    '凭什么', '不公平', '过分', '欺负',
    '骂', '吵', '打架', '冲突',
    '滚', '闭嘴', '别烦我', '够了',
    '憎恨', '恨', '怨恨', '不爽',
];
/** 焦虑相关词汇 */
const ANXIOUS_WORDS = [
    '担心', '焦虑', '紧张', '害怕', '恐慌', '不安', '忧虑',
    '怎么办', '完蛋', '糟了', '来不及', '压力', '负担',
    '😰', '😨', '😱', '😓', '😥',
    '失眠', '睡不着', '噩梦', '胡思乱想',
    '不确定', '犹豫', '纠结', '迷茫',
    '考试', '面试', '汇报', '检查', '截止',
    '未来', '前途', '工作', '失业', '经济',
    '健康', '生病', '医院', '体检',
];
// =============================================================================
// 辅助函数
// =============================================================================
/**
 * 计算文本中关键词的匹配数量
 */
function countWordMatches(text, wordList) {
    let count = 0;
    const lowerText = text.toLowerCase();
    for (const word of wordList) {
        if (lowerText.includes(word.toLowerCase())) {
            count++;
        }
    }
    return count;
}
/**
 * 计算加权匹配分数
 * 更长的关键词匹配获得更高权重
 */
function calculateWeightedScore(text, wordList) {
    let score = 0;
    const lowerText = text.toLowerCase();
    for (const word of wordList) {
        if (lowerText.includes(word.toLowerCase())) {
            // 根据关键词长度加权: 越长越重要
            score += Math.min(word.length, 5);
            // 如果关键词出现在开头或结尾，额外加分
            if (lowerText.startsWith(word.toLowerCase())) {
                score += 3;
            }
            if (lowerText.endsWith(word.toLowerCase())) {
                score += 3;
            }
        }
    }
    return score;
}
/**
 * 检测文本中的否定模式
 * 例如: "不开心" 不应该被识别为 "开心"
 */
function hasNegation(text, targetWord) {
    const negationPatterns = ['不', '没', '别', '无', '非', '否', '未必', '并不是'];
    const idx = text.indexOf(targetWord);
    if (idx <= 0)
        return false;
    const prefix = text.substring(Math.max(0, idx - 3), idx);
    return negationPatterns.some((n) => prefix.includes(n));
}
/**
 * 基于标点符号和文本长度调整置信度
 */
function adjustConfidenceByContext(text, baseConfidence) {
    let adjustment = 0;
    // 感叹号: 情绪更强烈
    const exclamationCount = (text.match(/[！!]/g) || []).length;
    adjustment += Math.min(exclamationCount * 0.05, 0.15);
    // 问号: 更多不确定性 (焦虑)
    const questionCount = (text.match(/[？?]/g) || []).length;
    adjustment += Math.min(questionCount * 0.02, 0.08);
    // 文本长度很短: 置信度降低
    if (text.length < 5) {
        adjustment -= 0.15;
    }
    // 文本很长(>200字): 可能有混合情绪，略微降低单一情绪置信度
    if (text.length > 200) {
        adjustment -= 0.05;
    }
    return Math.max(0, Math.min(1, baseConfidence + adjustment));
}
// =============================================================================
// 主要分析函数
// =============================================================================
/**
 * 分析文本的情绪倾向
 *
 * 算法:
 * 1. 对每种情绪计算加权匹配分数
 * 2. 取分数最高的情绪
 * 3. 根据上下文调整置信度
 * 4. 如果所有分数都低于阈值，返回 neutral
 *
 * @param text - 要分析的文本
 * @returns 情绪分析结果 { emotion, confidence }
 *
 * @example
 * ```typescript
 * const result = analyze('今天真的太开心了！');
 * // => { emotion: 'happy', confidence: 0.85 }
 *
 * const result2 = analyze('明天就要考试了，好紧张怎么办');
 * // => { emotion: 'anxious', confidence: 0.72 }
 * ```
 */
function analyze(text) {
    if (!text || text.trim().length === 0) {
        return { emotion: 'neutral', confidence: 1.0 };
    }
    const trimmedText = text.trim();
    // 计算每种情绪的加权分数
    const scores = {
        happy: calculateWeightedScore(trimmedText, HAPPY_WORDS),
        sad: calculateWeightedScore(trimmedText, SAD_WORDS),
        angry: calculateWeightedScore(trimmedText, ANGRY_WORDS),
        anxious: calculateWeightedScore(trimmedText, ANXIOUS_WORDS),
        neutral: 0,
    };
    // 检测否定模式，对被否定的情绪降权
    const emotionWordMap = {
        happy: HAPPY_WORDS,
        sad: SAD_WORDS,
        angry: ANGRY_WORDS,
        anxious: ANXIOUS_WORDS,
    };
    for (const emotion of ['happy', 'sad', 'angry', 'anxious']) {
        const wordList = emotionWordMap[emotion];
        for (const word of wordList) {
            if (trimmedText.includes(word) && hasNegation(trimmedText, word)) {
                scores[emotion] -= 5; // 否定导致的降权
                break;
            }
        }
    }
    // 找最高分的情绪
    let topEmotion = 'neutral';
    let topScore = 0;
    let secondScore = 0;
    for (const [emotion, score] of Object.entries(scores)) {
        if (score > topScore) {
            secondScore = topScore;
            topScore = score;
            topEmotion = emotion;
        }
        else if (score > secondScore) {
            secondScore = score;
        }
    }
    // 设置 neutral 的最低阈值
    const NEUTRAL_THRESHOLD = 2;
    if (topScore < NEUTRAL_THRESHOLD) {
        return { emotion: 'neutral', confidence: 0.8 };
    }
    // 计算原始置信度 (基于最高分和第二高分的差距)
    const scoreGap = topScore - secondScore;
    let confidence;
    if (scoreGap >= 10) {
        confidence = 0.9;
    }
    else if (scoreGap >= 5) {
        confidence = 0.75;
    }
    else if (scoreGap >= 2) {
        confidence = 0.6;
    }
    else {
        confidence = 0.45;
    }
    // 根据文本长度调整: 越长且匹配越多越确定
    const matchDensity = topScore / Math.max(trimmedText.length, 1);
    confidence += Math.min(matchDensity * 5, 0.15);
    // 根据上下文微调
    confidence = adjustConfidenceByContext(trimmedText, confidence);
    return {
        emotion: topEmotion,
        confidence: Math.round(confidence * 100) / 100, // 保留两位小数
    };
}
/**
 * 获取情绪的友好描述文字
 *
 * @param emotion - 情绪类型
 * @returns 中文描述
 */
function getEmotionDescription(emotion) {
    const descriptions = {
        happy: '😊 开心愉悦',
        sad: '😢 悲伤低落',
        angry: '😠 愤怒不满',
        anxious: '😰 焦虑不安',
        neutral: '😐 平静中性',
    };
    return descriptions[emotion];
}
/**
 * 根据情绪获取建议的回复语气
 *
 * @param emotion - 情绪类型
 * @returns 语气描述，可注入到 LLM prompt 中
 */
function getToneGuidance(emotion) {
    const guidance = {
        happy: '用户心情很好，请用轻松愉快的语气回应，可以适当附和他的开心，分享正能量。',
        sad: '用户情绪低落，请用温柔、共情的语气回应。多倾听、多安慰，不要急于给建议。适当表达理解和支持。',
        angry: '用户感到愤怒，请用冷静、平和的语气回应。先认可他的情绪，不要反驳或说教。帮助他冷静下来。',
        anxious: '用户感到焦虑，请用坚定、安心的语气回应。给予确定性和实际建议，帮助他理清思路。不要加剧他的不安。',
        neutral: '用户情绪平稳，请用自然、友好的语气回应，像朋友聊天一样。',
    };
    return guidance[emotion];
}
//# sourceMappingURL=analyzer.js.map