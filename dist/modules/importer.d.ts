/**
 * 聊天记录解析器
 *
 * 支持多种微信聊天记录导出格式:
 * - EchoTrace HTML 格式
 * - WeFlow API JSON 格式 (含base64表情包/图片)
 * - WeFlow 导出 JSON/CSV/TXT
 * - 通用 CSV 格式
 *
 * 输出统一格式的 ChatMessage 数组
 */
/** 统一的消息格式 */
export interface ChatMessage {
    /** 发送者昵称 */
    sender: string;
    /** 消息内容 (文字内容，或媒体描述) */
    content: string;
    /** 原始时间戳 */
    timestamp: Date;
    /** 消息类型 */
    msgType: 'text' | 'image' | 'video' | 'file' | 'sticker' | 'emoji' | 'voice' | 'system' | 'other';
    /** 是否来自用户本人 */
    isFromUser: boolean;
    /** 顺序号 */
    seqId?: number;
    /** 媒体数据 base64 (表情包/图片/视频) */
    mediaData?: string;
    /** 媒体 URL */
    mediaUrl?: string;
    /** 缩略图 */
    mediaThumb?: string;
}
/** 解析选项 */
export interface ParseOptions {
    /** 用户本人的昵称 (用于标记 isFromUser) */
    userNickname?: string;
    /** 用户本人的微信ID */
    userWechatId?: string;
}
/**
 * 解析聊天记录文件
 * 自动检测格式，调用对应的解析器
 *
 * @param filePath - 文件路径
 * @param format - 格式提示 (html/json/csv/auto)
 * @param options - 解析选项
 * @returns 解析出的消息数组
 */
export declare function parseChatExport(filePath: string, format?: string, options?: ParseOptions): Promise<ChatMessage[]>;
/**
 * 流式解析大文件 (JSONL/CSV)
 * 逐行读取，每500条返回一批，最后返回全部
 * 相比 readFileSync 大幅降低峰值内存
 */
export declare function parseChatExportStreaming(filePath: string, format: string, options: ParseOptions, onBatch: (batch: ChatMessage[], progress: number) => Promise<void>): Promise<number>;
//# sourceMappingURL=importer.d.ts.map