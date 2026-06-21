/**
 * 媒体存储模块
 *
 * 处理 WeClaw webhook 收到的图片/表情包/语音/视频等媒体文件
 *
 * 存储策略:
 * - 小文件 (<500KB): base64 直接存 PostgreSQL media_data 字段
 * - 大文件 (>=500KB): 存本地文件系统，DB存路径
 * - 如果配置了 MinIO: 优先存 MinIO，DB存URL
 *
 * 去重: 使用 SHA256 哈希避免重复存储
 */
import { Pool } from 'pg';
export declare function initMediaStore(pool: Pool): void;
/**
 * 存储媒体文件
 *
 * @param userId - 用户DB ID
 * @param wechatId - 微信ID
 * @param data - 原始二进制数据
 * @param options - 元信息
 * @returns 存储结果 { fileUrl, filePath, isBase64 }
 */
export declare function storeMedia(userId: number, wechatId: string, data: Buffer, options: {
    mediaType: 'image' | 'sticker' | 'voice' | 'video' | 'file';
    mimeType?: string;
    filename?: string;
    originalMsgId?: string;
}): Promise<{
    fileUrl: string;
    filePath: string | null;
    isBase64: boolean;
    sha256: string;
    fileSize: number;
}>;
/**
 * 从 base64 字符串存储媒体
 */
export declare function storeMediaFromBase64(userId: number, wechatId: string, base64String: string, options: {
    mediaType: 'image' | 'sticker' | 'voice' | 'video' | 'file';
    mimeType?: string;
    originalMsgId?: string;
}): Promise<ReturnType<typeof storeMedia>>;
/**
 * 通过URL获取媒体数据
 */
export declare function getMedia(mediaId: number): Promise<{
    data: Buffer | null;
    mimeType: string;
    fileUrl: string;
}>;
/**
 * 获取用户的表情包使用统计
 */
export declare function getUserStickers(wechatId: string, limit?: number): Promise<any[]>;
/**
 * 获取用户的媒体存储统计
 */
export declare function getStorageStats(userId: number): Promise<{
    totalBytes: number;
    fileCount: number;
    stickerCount: number;
}>;
/**
 * 清理旧媒体文件 (保留最近30天)
 */
export declare function cleanupOldMedia(daysToKeep?: number): Promise<number>;
//# sourceMappingURL=media-store.d.ts.map