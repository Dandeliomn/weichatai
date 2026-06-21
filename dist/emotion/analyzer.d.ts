/**
 * 情绪分析模块
 * 分析用户消息的情感倾向，输出情绪类型和置信度
 *
 * 使用基于规则的关键词匹配 + 简单启发式算法
 * 支持四种基本情绪: 快乐(happy), 悲伤(sad), 愤怒(angry), 焦虑(anxious), 以及中性(neutral)
 *
 * 导出接口: analyze(text: string) => { emotion: string, confidence: number }
 */
/** 情绪类型 */
export type Emotion = 'happy' | 'sad' | 'angry' | 'anxious' | 'neutral';
/** 分析结果 */
export interface EmotionResult {
    /** 情绪类型 */
    emotion: Emotion;
    /** 置信度 (0-1) */
    confidence: number;
}
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
export declare function analyze(text: string): EmotionResult;
/**
 * 获取情绪的友好描述文字
 *
 * @param emotion - 情绪类型
 * @returns 中文描述
 */
export declare function getEmotionDescription(emotion: Emotion): string;
/**
 * 根据情绪获取建议的回复语气
 *
 * @param emotion - 情绪类型
 * @returns 语气描述，可注入到 LLM prompt 中
 */
export declare function getToneGuidance(emotion: Emotion): string;
//# sourceMappingURL=analyzer.d.ts.map