/**
 * OSS 存储模块 (MinIO)
 *
 * 可选: 如果配置了 MinIO 环境变量，则使用 MinIO 存储；
 * 否则回退到本地文件系统。
 *
 * MinIO 是自托管的 S3 兼容对象存储，适合 Docker 环境部署。
 */

import { Client as MinioClient } from 'minio';
import fs from 'fs';
import path from 'path';

/** 上传选项 */
export interface UploadOptions {
  /** 存储桶名称 */
  bucket?: string;
  /** 自定义文件名 (不含路径) */
  filename?: string;
  /** Content-Type */
  contentType?: string;
}

/** MinIO 客户端实例 */
let minioClient: MinioClient | null = null;

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

// =============================================================================
// 初始化
// =============================================================================

function getMinioClient(): MinioClient | null {
  if (minioClient) return minioClient;

  const endPoint = process.env.MINIO_ENDPOINT;
  const accessKey = process.env.MINIO_ACCESS_KEY;
  const secretKey = process.env.MINIO_SECRET_KEY;

  if (!endPoint || !accessKey || !secretKey) {
    console.log('[MinIO] 未配置，使用本地文件系统存储');
    return null;
  }

  try {
    minioClient = new MinioClient({
      endPoint,
      port: parseInt(process.env.MINIO_PORT || '9000', 10),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey,
      secretKey,
    });

    console.log(`[MinIO] 已连接: ${endPoint}`);
    return minioClient;
  } catch (error) {
    console.warn('[MinIO] 连接失败，回退到本地存储');
    return null;
  }
}

/**
 * 检查 MinIO 是否可用
 */
export function isMinIOAvailable(): boolean {
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
export async function uploadFile(
  filePath: string,
  options: UploadOptions = {}
): Promise<string> {
  const client = getMinioClient();
  const bucket = options.bucket || process.env.MINIO_BUCKET || 'weclaw-uploads';
  const filename = options.filename || path.basename(filePath);
  const contentType = options.contentType || 'application/octet-stream';

  if (client) {
    return uploadToMinio(client, filePath, bucket, filename, contentType);
  }

  return uploadToLocal(filePath, options);
}

/**
 * 上传到 MinIO
 */
async function uploadToMinio(
  client: MinioClient,
  filePath: string,
  bucket: string,
  filename: string,
  contentType: string
): Promise<string> {
  // 确保存储桶存在
  const bucketExists = await client.bucketExists(bucket);
  if (!bucketExists) {
    await client.makeBucket(bucket);
    console.log(`[MinIO] 创建存储桶: ${bucket}`);
  }

  // 上传文件
  const fileStream = fs.createReadStream(filePath);
  const fileSize = fs.statSync(filePath).size;

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
function uploadToLocal(
  filePath: string,
  options: UploadOptions
): string {
  const filename = options.filename || path.basename(filePath);
  const destDir = path.join(UPLOAD_DIR, 'persisted');
  const destPath = path.join(destDir, filename);

  // 确保目录存在
  fs.mkdirSync(destDir, { recursive: true });

  // 如果源文件和目标文件不同，则复制
  if (filePath !== destPath) {
    fs.copyFileSync(filePath, destPath);
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
export async function getFileStream(
  filePath: string,
  bucket?: string
): Promise<fs.ReadStream | NodeJS.ReadableStream> {
  const client = getMinioClient();

  if (client) {
    const bkt = bucket || process.env.MINIO_BUCKET || 'weclaw-uploads';
    return await client.getObject(bkt, path.basename(filePath));
  }

  return fs.createReadStream(filePath);
}

/**
 * 获取文件的公开访问 URL
 */
export async function getFileUrl(
  filePath: string,
  bucket?: string
): Promise<string> {
  const client = getMinioClient();

  if (client) {
    const bkt = bucket || process.env.MINIO_BUCKET || 'weclaw-uploads';
    return await client.presignedGetObject(bkt, path.basename(filePath), 24 * 60 * 60);
  }

  return filePath;
}

/**
 * 删除文件
 */
export async function deleteFile(
  filePath: string,
  bucket?: string
): Promise<void> {
  const client = getMinioClient();

  if (client) {
    const bkt = bucket || process.env.MINIO_BUCKET || 'weclaw-uploads';
    await client.removeObject(bkt, path.basename(filePath));
  } else {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
