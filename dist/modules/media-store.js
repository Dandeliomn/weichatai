"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initMediaStore = initMediaStore;
exports.storeMedia = storeMedia;
exports.storeMediaFromBase64 = storeMediaFromBase64;
exports.getMedia = getMedia;
exports.getUserStickers = getUserStickers;
exports.getStorageStats = getStorageStats;
exports.cleanupOldMedia = cleanupOldMedia;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
let pgPool;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path_1.default.join(process.cwd(), 'uploads');
// 大小阈值
const BASE64_THRESHOLD = 500 * 1024; // 500KB以下直接base64存DB
function initMediaStore(pool) {
    pgPool = pool;
    // 确保目录存在
    fs_1.default.mkdirSync(path_1.default.join(UPLOAD_DIR, 'media'), { recursive: true });
    fs_1.default.mkdirSync(path_1.default.join(UPLOAD_DIR, 'stickers'), { recursive: true });
    console.log('[MediaStore] 初始化完成');
}
/**
 * 存储媒体文件
 *
 * @param userId - 用户DB ID
 * @param wechatId - 微信ID
 * @param data - 原始二进制数据
 * @param options - 元信息
 * @returns 存储结果 { fileUrl, filePath, isBase64 }
 */
async function storeMedia(userId, wechatId, data, options) {
    const { mediaType, mimeType, filename, originalMsgId } = options;
    const fileSize = data.length;
    const sha256 = crypto_1.default.createHash('sha256').update(data).digest('hex');
    const ext = mimeType ? getExtFromMime(mimeType) : '.bin';
    // 1. 去重: 检查是否已存储
    const existing = await pgPool.query('SELECT id, file_url, file_path FROM media_files WHERE sha256 = $1 AND user_id = $2 LIMIT 1', [sha256, userId]);
    if (existing.rows.length > 0) {
        console.log(`[MediaStore] 去重命中: ${sha256.substring(0, 12)}`);
        return {
            fileUrl: existing.rows[0].file_url || '',
            filePath: existing.rows[0].file_path,
            isBase64: false,
            sha256,
            fileSize,
        };
    }
    let fileUrl = '';
    let filePath = null;
    let isBase64 = false;
    // 2. 小文件 → base64 存 PG
    if (fileSize <= BASE64_THRESHOLD) {
        isBase64 = true;
        const base64 = `data:${mimeType || 'application/octet-stream'};base64,${data.toString('base64')}`;
        fileUrl = base64;
        console.log(`[MediaStore] base64存储: ${(fileSize / 1024).toFixed(1)}KB`);
    }
    else {
        // 3. 大文件 → 存文件系统
        const dateDir = new Date().toISOString().split('T')[0];
        const dir = path_1.default.join(UPLOAD_DIR, 'media', dateDir);
        fs_1.default.mkdirSync(dir, { recursive: true });
        const fname = filename || `${sha256.substring(0, 16)}${ext}`;
        filePath = path_1.default.join(dir, fname);
        fs_1.default.writeFileSync(filePath, data);
        fileUrl = `/uploads/media/${dateDir}/${fname}`;
        console.log(`[MediaStore] 文件存储: ${(fileSize / 1024).toFixed(1)}KB → ${fileUrl}`);
    }
    // 4. 记录到 media_files 表
    await pgPool.query(`INSERT INTO media_files
     (user_id, wechat_id, file_path, file_url, file_size, media_type, mime_type, sha256, is_sticker, original_msg_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT DO NOTHING`, [
        userId, wechatId, filePath, fileUrl, fileSize,
        mediaType, mimeType || null, sha256,
        mediaType === 'sticker', originalMsgId || null,
    ]);
    // 5. 更新用户存储配额
    await pgPool.query(`INSERT INTO user_media_storage (user_id, total_bytes, file_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id)
     DO UPDATE SET total_bytes = user_media_storage.total_bytes + $2,
                   file_count = user_media_storage.file_count + 1`, [userId, fileSize]);
    // 6. 如果是表情包，记录到 stickers 表
    if (mediaType === 'sticker') {
        await pgPool.query(`INSERT INTO user_stickers (user_id, wechat_id, file_url, file_path, usage_count, last_seen_at)
       VALUES ($1, $2, $3, $4, 1, NOW())
       ON CONFLICT DO NOTHING`, [userId, wechatId, fileUrl, filePath]);
    }
    return { fileUrl, filePath, isBase64, sha256, fileSize };
}
/**
 * 从 base64 字符串存储媒体
 */
async function storeMediaFromBase64(userId, wechatId, base64String, options) {
    // 解析 data URI
    const matches = base64String.match(/^data:(.+);base64,(.+)$/);
    let mimeType = options.mimeType || 'image/png';
    let rawBase64 = base64String;
    if (matches) {
        mimeType = matches[1];
        rawBase64 = matches[2];
    }
    const buffer = Buffer.from(rawBase64, 'base64');
    return storeMedia(userId, wechatId, buffer, {
        ...options,
        mimeType,
    });
}
/**
 * 通过URL获取媒体数据
 */
async function getMedia(mediaId) {
    const result = await pgPool.query('SELECT * FROM media_files WHERE id = $1', [mediaId]);
    if (result.rows.length === 0) {
        return { data: null, mimeType: '', fileUrl: '' };
    }
    const row = result.rows[0];
    let data = null;
    if (row.file_path && fs_1.default.existsSync(row.file_path)) {
        data = fs_1.default.readFileSync(row.file_path);
    }
    return {
        data,
        mimeType: row.mime_type || 'application/octet-stream',
        fileUrl: row.file_url || '',
    };
}
/**
 * 获取用户的表情包使用统计
 */
async function getUserStickers(wechatId, limit = 50) {
    // 先找到 users 表的 ID
    const user = await pgPool.query('SELECT id FROM users WHERE wechat_id = $1', [wechatId]);
    if (user.rows.length === 0)
        return [];
    const result = await pgPool.query(`SELECT sticker_name, file_url, usage_count, first_seen_at, last_seen_at
     FROM user_stickers
     WHERE user_id = $1
     ORDER BY usage_count DESC
     LIMIT $2`, [user.rows[0].id, limit]);
    return result.rows;
}
/**
 * 获取用户的媒体存储统计
 */
async function getStorageStats(userId) {
    const [quota, stickers] = await Promise.all([
        pgPool.query('SELECT total_bytes, file_count FROM user_media_storage WHERE user_id = $1', [userId]),
        pgPool.query('SELECT COUNT(*) as count FROM user_stickers WHERE user_id = $1', [userId]),
    ]);
    return {
        totalBytes: quota.rows[0]?.total_bytes || 0,
        fileCount: quota.rows[0]?.file_count || 0,
        stickerCount: parseInt(stickers.rows[0]?.count || '0'),
    };
}
/**
 * 清理旧媒体文件 (保留最近30天)
 */
async function cleanupOldMedia(daysToKeep = 30) {
    const result = await pgPool.query(`DELETE FROM media_files
     WHERE created_at < NOW() - INTERVAL '1 day' * $1
       AND file_path IS NOT NULL
     RETURNING id, file_path`, [daysToKeep]);
    let deletedCount = 0;
    for (const row of result.rows) {
        if (row.file_path && fs_1.default.existsSync(row.file_path)) {
            fs_1.default.unlinkSync(row.file_path);
            deletedCount++;
        }
    }
    console.log(`[MediaStore] 清理完成: ${deletedCount} 个文件`);
    return deletedCount;
}
// ---- 工具函数 ----
function getExtFromMime(mime) {
    const map = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'audio/mpeg': '.mp3',
        'audio/amr': '.amr',
        'audio/silk': '.silk',
        'video/mp4': '.mp4',
        'application/pdf': '.pdf',
    };
    return map[mime] || '.bin';
}
//# sourceMappingURL=media-store.js.map