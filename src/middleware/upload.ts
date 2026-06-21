/**
 * 文件上传中间件
 *
 * 基于 multer，支持聊天记录文件的导入上传
 * 支持格式: .html (EchoTrace), .json (WeFlow/通用), .csv, .txt
 */

import multer, { FileFilterCallback } from 'multer';
import path from 'path';
import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';

/** 允许的文件扩展名 */
const ALLOWED_EXTENSIONS = ['.html', '.htm', '.json', '.csv', '.txt', '.zip', '.gz', '.tgz', '.tar.gz', '.rar'];

/** 最大文件大小: 50MB */
const MAX_FILE_SIZE = 500 * 1024 * 1024;

/** 上传目录 */
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

/**
 * 文件存储引擎
 * 按 userId/日期 组织目录结构
 */
const storage = multer.diskStorage({
  destination: (_req: Request, _file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
    // 按日期分目录
    const dateDir = new Date().toISOString().split('T')[0];
    const dest = path.join(UPLOAD_DIR, dateDir);
    // multer 不会自动创建目录，用 fs 处理
    const fs = require('fs');
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
    // 唯一文件名: uuid + 原始扩展名
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${uuidv4()}${ext}`;
    cb(null, uniqueName);
  },
});

/**
 * 文件类型过滤器
 */
function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
): void {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`不支持的文件类型: ${ext}。允许的类型: ${ALLOWED_EXTENSIONS.join(', ')}`));
  }
}

/**
 * 聊天记录上传中间件
 * 接受单文件，字段名为 'chatfile'
 */
export const uploadChatRecord = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
}).single('chatfile');

/**
 * 处理 multer 上传错误的中间件包装器
 */
export function handleUpload(
  req: Request,
  res: any,
  next: any
): void {
  uploadChatRecord(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            error: `文件太大，最大允许 ${MAX_FILE_SIZE / 1024 / 1024}MB`,
            code: 'FILE_TOO_LARGE',
          });
          return;
        }
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }

      // 自定义错误 (如文件类型)
      res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
      return;
    }
    next();
  });
}
