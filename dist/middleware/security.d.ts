/**
 * 安全中间件（统一版）
 *
 * XSS消毒 + SQL注入检测 + 输入验证 + 安全日志 → 单个中间件
 * 减少请求穿透层数，提升性能
 */
import { Request, Response, NextFunction } from 'express';
export declare function sanitize<T>(input: T): T;
export declare function securityGuard(req: Request, res: Response, next: NextFunction): void;
export declare const xssSanitizer: typeof securityGuard;
export declare const sqlInjectionGuard: typeof securityGuard;
export declare const inputValidator: typeof securityGuard;
export declare const securityLogger: typeof securityGuard;
//# sourceMappingURL=security.d.ts.map