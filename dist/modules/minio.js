"use strict";
/**
 * OSS 存储模块 (MinIO)
 *
 * 可选: 如果配置了 MinIO 环境变量，则使用 MinIO 存储；
 * 否则回退到本地文件系统。
 *
 * MinIO 是自托管的 S3 兼容对象存储，适合 Docker 环境部署。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMinIOAvailable = isMinIOAvailable;
exports.uploadFile = uploadFile;
exports.getFileStream = getFileStream;
exports.getFileUrl = getFileUrl;
exports.deleteFile = deleteFile;
const minio_1 = require("minio");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/** MinIO 客户端实例 */
let minioClient = null;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path_1.default.join(process.cwd(), 'uploads');
// =============================================================================
// 初始化
// =============================================================================
function getMinioClient() {
    if (minioClient)
        return minioClient;
    const endPoint = process.env.MINIO_ENDPOINT;
    const accessKey = process.env.MINIO_ACCESS_KEY;
    const secretKey = process.env.MINIO_SECRET_KEY;
    if (!endPoint || !accessKey || !secretKey) {
        console.log('[MinIO] 未配置，使用本地文件系统存储');
        return null;
    }
    try {
        minioClient = new minio_1.Client({
            endPoint,
            port: parseInt(process.env.MINIO_PORT || '9000', 10),
            useSSL: process.env.MINIO_USE_SSL === 'true',
            accessKey,
            secretKey,
        });
        console.log(`[MinIO] 已连接: ${endPoint}`);
        return minioClient;
    }
    catch (error) {
        console.warn('[MinIO] 连接失败，回退到本地存储');
        return null;
    }
}
/**
 * 检查 MinIO 是否可用
 */
function isMinIOAvailable() {
    return getMinioClient() !== null;
}
// =============================================================================
// 文件上传
// =============================================================================
/**
 * 上传文件
 * 优先使用 MinIO，否则存储到本地
 *
 * @param filePath - 本地文件路径
 * @param options - 上传选项
 * @returns 可访问的文件 URL 或路径
 */
async function uploadFile(filePath, options = {}) {
    const client = getMinioClient();
    const bucket = options.bucket || process.env.MINIO_BUCKET || 'weclaw-uploads';
    const filename = options.filename || path_1.default.basename(filePath);
    const contentType = options.contentType || 'application/octet-stream';
    if (client) {
        return uploadToMinio(client, filePath, bucket, filename, contentType);
    }
    return uploadToLocal(filePath, options);
}
/**
 * 上传到 MinIO
 */
async function uploadToMinio(client, filePath, bucket, filename, contentType) {
    // 确保存储桶存在
    const bucketExists = await client.bucketExists(bucket);
    if (!bucketExists) {
        await client.makeBucket(bucket);
        console.log(`[MinIO] 创建存储桶: ${bucket}`);
    }
    // 上传文件
    const fileStream = fs_1.default.createReadStream(filePath);
    const fileSize = fs_1.default.statSync(filePath).size;
    await client.putObject(bucket, filename, fileStream, fileSize, {
        'Content-Type': contentType,
    });
    // 生成预签名 URL (有效期 7 天)
    const url = await client.presignedGetObject(bucket, filename, 7 * 24 * 60 * 60);
    console.log(`[MinIO] 上传成功: ${filename} → ${bucket}`);
    return url;
}
/**
 * 存储到本地
 */
function uploadToLocal(filePath, options) {
    const filename = options.filename || path_1.default.basename(filePath);
    const destDir = path_1.default.join(UPLOAD_DIR, 'persisted');
    const destPath = path_1.default.join(destDir, filename);
    // 确保目录存在
    fs_1.default.mkdirSync(destDir, { recursive: true });
    // 如果源文件和目标文件不同，则复制
    if (filePath !== destPath) {
        fs_1.default.copyFileSync(filePath, destPath);
    }
    console.log(`[LocalStorage] 文件已保存: ${destPath}`);
    return `/uploads/persisted/${filename}`;
}
// =============================================================================
// 文件下载/读取
// =============================================================================
/**
 * 获取文件的可读流
 * 自动判断从 MinIO 还是本地读取
 */
async function getFileStream(filePath, bucket) {
    const client = getMinioClient();
    if (client) {
        const bkt = bucket || process.env.MINIO_BUCKET || 'weclaw-uploads';
        return await client.getObject(bkt, path_1.default.basename(filePath));
    }
    return fs_1.default.createReadStream(filePath);
}
/**
 * 获取文件的公开访问 URL
 */
async function getFileUrl(filePath, bucket) {
    const client = getMinioClient();
    if (client) {
        const bkt = bucket || process.env.MINIO_BUCKET || 'weclaw-uploads';
        return await client.presignedGetObject(bkt, path_1.default.basename(filePath), 24 * 60 * 60);
    }
    return filePath;
}
/**
 * 删除文件
 */
async function deleteFile(filePath, bucket) {
    const client = getMinioClient();
    if (client) {
        const bkt = bucket || process.env.MINIO_BUCKET || 'weclaw-uploads';
        await client.removeObject(bkt, path_1.default.basename(filePath));
    }
    else {
        if (fs_1.default.existsSync(filePath)) {
            fs_1.default.unlinkSync(filePath);
        }
    }
}
//# sourceMappingURL=minio.js.map