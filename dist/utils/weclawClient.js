"use strict";
/**
 * WeClaw HTTP 客户端
 * 封装对 WeClawBot-API 的 HTTP 调用，用于主动发送微信消息
 *
 * WeClawBot-API 文档: https://github.com/Cp0204/WeClawBot-API
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WeClawClient = void 0;
exports.getWeClawClient = getWeClawClient;
const axios_1 = __importDefault(require("axios"));
/**
 * WeClaw 客户端类
 * 管理 API Token 认证和 HTTP 请求
 */
class WeClawClient {
    apiUrl;
    botId;
    apiToken;
    http;
    openilinkUrl;
    openilinkToken;
    constructor() {
        this.apiUrl = process.env.WECLAW_API_URL || 'http://weclaw-bridge:26322';
        this.botId = process.env.WECLAW_BOT_ID || '';
        this.apiToken = process.env.WECLAW_API_TOKEN || '';
        this.openilinkUrl = process.env.OPENILINK_HUB_URL || 'http://openilink-hub:9800';
        this.openilinkToken = process.env.OPENILINK_TOKEN || '';
        // 创建带认证头的 axios 实例
        this.http = axios_1.default.create({
            baseURL: this.apiUrl,
            timeout: 15000,
            headers: {
                'Authorization': `Bearer ${this.apiToken}`,
                'Content-Type': 'application/json',
            },
        });
        // 请求拦截器: 记录日志
        this.http.interceptors.request.use((config) => {
            console.log(`[WeClawClient] ➡️  ${config.method?.toUpperCase()} ${config.url}`);
            return config;
        }, (error) => Promise.reject(error));
        // 响应拦截器: 记录日志
        this.http.interceptors.response.use((response) => {
            console.log(`[WeClawClient] ✅ ${response.status} ${response.config.url}`);
            return response;
        }, (error) => {
            console.error(`[WeClawClient] ❌ 请求失败:`, error.message);
            return Promise.reject(error);
        });
    }
    /**
     * 验证客户端是否已配置
     */
    isConfigured() {
        return !!(this.botId && this.apiToken) || !!(this.openilinkToken || process.env.OPENILINK_TOKEN);
    }
    /**
     * 发送文本消息到微信
     *
     * @param text - 消息文本内容
     * @param botId - 可选，指定 Bot ID（默认使用环境变量中的配置）
     * @returns API 响应
     */
    async sendMessage(text, botId) {
        if (!text || text.trim().length === 0) {
            throw new Error('消息内容不能为空');
        }
        // 从数据库查询 bot 的 API token（多账号支持）
        let targetBot = botId || this.botId;
        let apiToken = '';
        let queryBot = targetBot;
        try {
            const { Pool } = require('pg');
            const p = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://weclaw:weclaw_secret@postgres:5432/weclaw_companion' });
            // 先按 botId 查，再按 wechatId 查，最后取第一个活跃的
            let r = queryBot
                ? await p.query('SELECT bot_id, api_token FROM bot_accounts WHERE (bot_id=$1 OR wechat_id=$1) AND is_active=TRUE ORDER BY bot_index LIMIT 1', [queryBot])
                : await p.query('SELECT bot_id, api_token FROM bot_accounts WHERE is_active=TRUE ORDER BY bot_index LIMIT 1');
            if (r.rows.length > 0) {
                targetBot = r.rows[0].bot_id;
                apiToken = r.rows[0].api_token;
            }
            await p.end();
        }
        catch (e) {
            console.warn('[WeClawClient] DB 查询失败:', e.message);
        }
        // 如果数据库查到了 token，用 HTTP API 发
        if (targetBot && apiToken) {
            try {
                const resp = await axios_1.default.get(`${this.apiUrl}/bots/${encodeURIComponent(targetBot)}/messages`, {
                    params: { text },
                    headers: { 'Authorization': `Bearer ${apiToken}` },
                    timeout: 15000,
                });
                if (resp.data?.code === 200 || resp.data?.code === undefined) {
                    console.log(`[WeClawClient] ✅ 通过 WeClawBot-API 发送成功 (bot=${targetBot})`);
                    return { code: 200, message: 'OK' };
                }
            }
            catch (e) {
                console.warn('[WeClawClient] WeClawBot-API 发送失败:', e.message);
            }
        }
        // 回退: 用环境变量 (兼容旧版单账号)
        if (this.apiToken && this.botId) {
            try {
                const response = await this.http.get(`/bots/${encodeURIComponent(targetBot || this.botId)}/messages`, { params: { text } });
                return response.data;
            }
            catch (error) {
                if (error.response?.status >= 400) {
                    const response = await this.http.post(`/bots/${encodeURIComponent(targetBot || this.botId)}/messages`, { text });
                    return response.data;
                }
                throw error;
            }
        }
        throw new Error('WeClawClient 未配置: 无可用 Bot 账号');
    }
    /**
     * 发送"正在输入"状态
     *
     * @param status - 1=正在输入, 2=停止输入
     * @param botId - 可选，指定 Bot ID
     */
    async sendTypingStatus(status, botId) {
        const targetBot = botId || this.botId;
        if (!targetBot || !this.apiToken) {
            throw new Error('WeClawClient 未配置');
        }
        try {
            const response = await this.http.get(`/bots/${encodeURIComponent(targetBot)}/typing`, { params: { status } });
            return response.data;
        }
        catch (error) {
            console.error(`[WeClawClient] 发送输入状态失败:`, error.message);
            throw error;
        }
    }
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
    async sendImage(imageUrl, botId) {
        const token = this.openilinkToken || process.env.OPENILINK_TOKEN || '';
        if (!token) {
            console.warn('[WeClawClient] 未配置 OpeniLink Token，无法发送图片');
            return { code: 500, message: 'No token' };
        }
        try {
            const resp = await axios_1.default.post(`${this.openilinkUrl}/bot/v1/message/send`, { type: 'image', url: imageUrl }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 });
            if (resp.data?.ok)
                console.log('[WeClawClient] ✅ 图片发送成功');
            return { code: resp.data?.ok ? 200 : 500, message: resp.data?.ok ? 'OK' : 'Failed' };
        }
        catch (e) {
            console.error('[WeClawClient] 图片发送失败:', e.message);
            return { code: 500, message: e.message };
        }
    }
    async sendWithTyping(text, botId) {
        try {
            // 1. 显示"正在输入" (OpeniLink 可能不支持，忽略错误)
            try {
                await this.sendTypingStatus(1, botId);
            }
            catch { }
            // 2. 模拟人类打字延迟
            const typingDelay = Math.min(Math.max(text.length * 50, 1000), 4000);
            await new Promise((resolve) => setTimeout(resolve, typingDelay));
            // 3. 停止"正在输入"
            try {
                await this.sendTypingStatus(2, botId);
            }
            catch { }
            // 4. 短暂延迟后发送消息
            await new Promise((resolve) => setTimeout(resolve, 300));
            // 5. 发送实际消息
            await this.sendMessage(text, botId);
        }
        catch (error) {
            console.error(`[WeClawClient] sendWithTyping 失败:`, error.message);
        }
    }
}
exports.WeClawClient = WeClawClient;
/** 单例实例 */
let instance = null;
/**
 * 获取 WeClawClient 单例
 */
function getWeClawClient() {
    if (!instance) {
        instance = new WeClawClient();
    }
    return instance;
}
//# sourceMappingURL=weclawClient.js.map