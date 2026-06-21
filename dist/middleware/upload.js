"use strict";
/**
 * 文件上传中间件
 *
 * 基于 multer，支持聊天记录文件的导入上传
 * 支持格式: .html (EchoTrace), .json (WeFlow/通用), .csv, .txt
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadChatRecord = void 0;
exports.handleUpload = handleUpload;
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const uuid_1 = require("uuid");
/** 允许的文件扩展名 */
const ALLOWED_EXTENSIONS = ['.html', '.htm', '.json', '.csv', '.txt', '.zip', '.gz', '.tgz', '.tar.gz', '.rar'];
/** 最大文件大小: 50MB */
const MAX_FILE_SIZE = 500 * 1024 * 1024;
/** 上传目录 */
const UPLOAD_DIR = process.env.UPLOAD_DIR || path_1.default.join(process.cwd(), 'uploads');
/**
 * 文件存储引擎
 * 按 userId/日期 组织目录结构
 */
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => {
        // 按日期分目录
        const dateDir = new Date().toISOString().split('T')[0];
        const dest = path_1.default.join(UPLOAD_DIR, dateDir);
        // multer 不会自动创建目录，用 fs 处理
        const fs = require('fs');
        fs.mkdirSync(dest, { recursive: true });
        cb(null, dest);
    },
    filename: (_req, file, cb) => {
        // 唯一文件名: uuid + 原始扩展名
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        const uniqueName = `${(0, uuid_1.v4)()}${ext}`;
        cb(null, uniqueName);
    },
});
/**
 * 文件类型过滤器
 */
function fileFilter(_req, file, cb) {
    const ext = path_1.default.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
        cb(null, true);
    }
    else {
        cb(new Error(`不支持的文件类型: ${ext}。允许的类型: ${ALLOWED_EXTENSIONS.join(', ')}`));
    }
}
/**
 * 聊天记录上传中间件
 * 接受单文件，字段名为 'chatfile'
 */
exports.uploadChatRecord = (0, multer_1.default)({
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
function handleUpload(req, res, next) {
    (0, exports.uploadChatRecord)(req, res, (err) => {
        if (err) {
            if (err instanceof multer_1.default.MulterError) {
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
//# sourceMappingURL=upload.js.map