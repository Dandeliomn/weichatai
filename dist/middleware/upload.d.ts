/**
 * 文件上传中间件
 *
 * 基于 multer，支持聊天记录文件的导入上传
 * 支持格式: .html (EchoTrace), .json (WeFlow/通用), .csv, .txt
 */
import { Request } from 'express';
/**
 * 聊天记录上传中间件
 * 接受单文件，字段名为 'chatfile'
 */
export declare const uploadChatRecord: import("express").RequestHandler<import("express-serve-static-core").ParamsDictionary, any, any, import("qs").ParsedQs, Record<string, any>>;
/**
 * 处理 multer 上传错误的中间件包装器
 */
export declare function handleUpload(req: Request, res: any, next: any): void;
//# sourceMappingURL=upload.d.ts.map