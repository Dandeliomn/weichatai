/**
 * WeClaw 客户端 — 通过 iLink API 直连发送微信消息
 *
 * 绕过 weclawbot-api 的 HTTP 接口（始终 401），
 * 直接用 bot_token 调用 iLink sendmessage API（类似 Hermes 实现）
 */
/** WeClaw API 响应格式 */
interface WeClawResponse {
    code: number;
    message?: string;
    error?: string;
}
/**
 * WeClaw 客户端类
 * 管理 Bot Token 认证，通过 iLink API 直连发送消息
 */
export declare class WeClawClient {
    private botId;
    private apiToken;
    private openilinkUrl;
    private openilinkToken;
    constructor();
    /**
     * 验证客户端是否可发送（总是 true, sendMessage 内部从 DB 查 bot_token）
     */
    isConfigured(): boolean;
    /**
     * 发送文本消息到微信（iLink API 直连）
     *
     * @param text - 消息文本内容
     * @param botId - Bot ID (如 ed446b646fbe@im.bot)
     * @param toUserId - 接收消息的微信用户 ID
     * @returns API 响应
     */
    sendMessage(text: string, botId?: string, toUserId?: string): Promise<WeClawResponse>;
    /**
     * 旧路径: weclawbot-api HTTP (可能 401, 作为最后的尝试)
     */
    private _sendViaLegacy;
    /**
     * 发送图片/表情包
     */
    sendImage(imageUrl: string, _botId?: string): Promise<WeClawResponse>;
    sendWithTyping(text: string, botId?: string): Promise<void>;
}
/**
 * 获取 WeClawClient 单例
 */
export declare function getWeClawClient(): WeClawClient;
export {};
//# sourceMappingURL=weclawClient.d.ts.map