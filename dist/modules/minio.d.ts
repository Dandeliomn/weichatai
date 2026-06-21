/**
 * OSS 存储模块 (MinIO)
 *
 * 可选: 如果配置了 MinIO 环境变量，则使用 MinIO 存储；
 * 否则回退到本地文件系统。
 *
 * MinIO 是自托管的 S3 兼容对象存储，适合 Docker 环境部署。
 */
import fs from 'fs';
/** 上传选项 */
export interface UploadOptions {
    /** 存储桶名称 */
    bucket?: string;
    /** 自定义文件名 (不含路径) */
    filename?: string;
    /** Content-Type */
    contentType?: string;
}
/**
 * 检查 MinIO 是否可用
 */
export declare function isMinIOAvailable(): boolean;
/**
 * 上传文件
 * 优先使用 MinIO，否则存储到本地
 *
 * @param filePath - 本地文件路径
 * @param options - 上传选项
 * @returns 可访问的文件 URL 或路径
 */
export declare function uploadFile(filePath: string, options?: UploadOptions): Promise<string>;
/**
 * 获取文件的可读流
 * 自动判断从 MinIO 还是本地读取
 */
export declare function getFileStream(filePath: string, bucket?: string): Promise<fs.ReadStream | NodeJS.ReadableStream>;
/**
 * 获取文件的公开访问 URL
 */
export declare function getFileUrl(filePath: string, bucket?: string): Promise<string>;
/**
 * 删除文件
 */
export declare function deleteFile(filePath: string, bucket?: string): Promise<void>;
//# sourceMappingURL=minio.d.ts.map