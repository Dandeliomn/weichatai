/**
 * WeClaw HTTP 客户端
 * 封装对 WeClawBot-API 的 HTTP 调用，用于主动发送微信消息
 *
 * WeClawBot-API 文档: https://github.com/Cp0204/WeClawBot-API
 */
/** WeClaw API 响应格式 */
interface WeClawResponse {
    code: number;
    message?: string;
    error?: string;
}
/**
 * WeClaw 客户端类
 * 管理 API Token 认证和 HTTP 请求
 */
export declare class WeClawClient {
    private apiUrl;
    private botId;
    private apiToken;
    private http;
    private openilinkUrl;
    private openilinkToken;
    constructor();
    /**
     * 验证客户端是否已配置
     */
    isConfigured(): boolean;
    /**
     * 发送文本消息到微信
     *
     * @param text - 消息文本内容
     * @param botId - 可选，指定 Bot ID（默认使用环境变量中的配置）
     * @returns API 响应
     */
    sendMessage(text: string, botId?: string): Promise<WeClawResponse>;
    /**
     * 发送"正在输入"状态
     *
     * @param status - 1=正在输入, 2=停止输入
     * @param botId - 可选，指定 Bot ID
     */
    sendTypingStatus(status: 1 | 2, botId?: string): Promise<WeClawResponse>;
    /**
     * 发送消息（带"正在输入"状态模拟）
     * 先显示"正在输入..."，延迟后再发送实际消息
     *
     * @param text - 消息文本
     * @param botId - 可选 Bot ID
     */
    /**
     * 发送图片/表情包
     */
    sendImage(imageUrl: string, botId?: string): Promise<WeClawResponse>;
    sendWithTyping(text: string, botId?: string): Promise<void>;
}
/**
 * 获取 WeClawClient 单例
 */
export declare function getWeClawClient(): WeClawClient;
export {};
//# sourceMappingURL=weclawClient.d.ts.map