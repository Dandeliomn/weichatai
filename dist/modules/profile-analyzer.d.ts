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
import { ChatMessage } from './importer';
/** 分析选项 */
export interface AnalysisOptions {
    /** DeepSeek API Key */
    apiKey?: string;
    /** API 基础URL */
    baseUrl?: string;
    /** 模型名称 */
    model?: string;
    /** 用户昵称 (用于在消息中定位用户) */
    userNickname?: string;
}
/** 用户画像结果 */
export interface UserProfile {
    /** 性格特征 */
    personality: string;
    /** 沟通风格 */
    communicationStyle: string;
    /** 兴趣爱好 */
    hobbies: string[];
    /** 常用词汇 */
    keywords: string[];
    /** 关心的话题 */
    topicsOfInterest: string[];
    /** 核心联系人 */
    keyRelationships: Array<{
        name: string;
        relation: string;
    }>;
    /** 情绪模式 */
    emotionalPatterns: string;
    /** 自定义 AI Prompt */
    customPrompt: string;
    /** 完整分析报告 (原始LLM输出) */
    rawAnalysis: string;
}
/**
 * 分析聊天记录，生成用户画像
 *
 * @param messages - 解析出的消息数组
 * @param options - 分析选项
 * @returns 用户画像
 */
export declare function analyzeChatProfile(messages: ChatMessage[], options?: AnalysisOptions): Promise<UserProfile>;
/**
 * 生成可用于注入到主 Worker Prompt 中的用户上下文
 */
export declare function generateUserContext(profile: UserProfile): string;
//# sourceMappingURL=profile-analyzer.d.ts.map