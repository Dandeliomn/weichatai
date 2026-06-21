/**
 * WeClaw 客户端 — 通过 iLink API 直连发送微信消息
 *
 * 绕过 weclawbot-api 的 HTTP 接口（始终 401），
 * 直接用 bot_token 调用 iLink sendmessage API（类似 Hermes 实现）
 */

import axios from 'axios';

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage';

/** 发送消息的参数 */
interface SendMessageParams {
  text: string;
}

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
export class WeClawClient {
  private botId: string;
  private apiToken: string;
  private openilinkUrl: string;
  private openilinkToken: string;

  constructor() {
    this.botId = process.env.WECLAW_BOT_ID || '';
    this.apiToken = process.env.WECLAW_API_TOKEN || '';
    this.openilinkUrl = process.env.OPENILINK_HUB_URL || 'http://openilink-hub:9800';
    this.openilinkToken = process.env.OPENILINK_TOKEN || '';
  }

  /**
   * 验证客户端是否可发送（总是 true, sendMessage 内部从 DB 查 bot_token）
   */
  isConfigured(): boolean {
    return true;
  }

  /**
   * 发送文本消息到微信（iLink API 直连）
   *
   * @param text - 消息文本内容
   * @param botId - Bot ID (如 ed446b646fbe@im.bot)
   * @param toUserId - 接收消息的微信用户 ID
   * @returns API 响应
   */
  async sendMessage(text: string, botId?: string, toUserId?: string): Promise<WeClawResponse> {
    console.log(`[WeClawClient] sendMessage 被调用 text="${text.substring(0, 20)}..." botId=${botId} toUserId=${toUserId}`);
    if (!text || text.trim().length === 0) {
      throw new Error('消息内容不能为空');
    }

    // 从数据库查询 bot 凭证
    const targetBot = botId || this.botId;
    let botToken = '';
    let ilinkBaseUrl = ILINK_BASE;
    let targetUser = toUserId || '';

    try {
      const { Pool } = require('pg');
      const p = new Pool({
        connectionString: process.env.DATABASE_URL || 'postgresql://weclaw:weclaw_secret@postgres:5432/weclaw_companion',
      });
      const r = await p.query(
        `SELECT bot_token, api_token, ilink_user_id, ilink_base_url
         FROM bot_accounts
         WHERE (bot_id = $1 OR wechat_id = $1) AND is_active = TRUE AND deleted_at IS NULL
         ORDER BY bot_index LIMIT 1`,
        [targetBot]
      );

      if (r.rows.length > 0) {
        botToken = r.rows[0].bot_token || r.rows[0].api_token || '';
        if (r.rows[0].ilink_base_url) ilinkBaseUrl = r.rows[0].ilink_base_url;
        if (!targetUser) targetUser = r.rows[0].ilink_user_id || '';
      }
      await p.end();
    } catch (e) {
      console.warn('[WeClawClient] DB 查询失败:', (e as Error).message);
    }

    if (!botToken) {
      // 回退: 用环境变量（旧版）
      const oldToken = this.apiToken;
      if (!oldToken || !this.botId) {
        throw new Error('WeClawClient 未配置: 无可用 Bot 账号');
      }
      // 用旧路径（weclawbot-api HTTP）试一次
      return this._sendViaLegacy(text, targetBot || this.botId, oldToken);
    }

    // iLink API 直连
    try {
      const body = JSON.stringify({
        base_info: { channel_version: '2.2.0' },
        msg: {
          from_user_id: '',
          to_user_id: targetUser || targetBot,
          client_id: `weclaw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
        },
      });

      const url = `${ilinkBaseUrl}/${EP_SEND_MESSAGE}`;
      const resp = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          AuthorizationType: 'ilink_bot_token',
          Authorization: `Bearer ${botToken}`,
          'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': '131584',
        },
        timeout: 15000,
      });

      const result = resp.data || {};
      const ret = result.ret ?? 0;
      const errcode = result.errcode ?? 0;

      if (ret === -14 || errcode === -14) {
        console.warn(`[WeClawClient] ⚠️  session 过期 (bot=${targetBot})`);
        return { code: -14, message: 'Session expired', error: result.errmsg || 'session expired' };
      }
      if (ret !== 0 || errcode !== 0) {
        console.warn(`[WeClawClient] ⚠️  iLink 发送返回错误 ret=${ret} errcode=${errcode}: ${result.errmsg}`);
        return { code: errcode || ret, message: result.errmsg || 'iLink error', error: result.errmsg };
      }

      console.log(`[WeClawClient] ✅ iLink 发送成功 (to=${targetUser || targetBot})`);
      return { code: 200, message: 'OK' };
    } catch (e: any) {
      console.error(`[WeClawClient] ❌ iLink 发送失败:`, e.message);
      // iLink 失败时回退到旧路径
      return this._sendViaLegacy(text, targetBot, botToken);
    }
  }

  /**
   * 旧路径: weclawbot-api HTTP (可能 401, 作为最后的尝试)
   */
  private async _sendViaLegacy(text: string, botId: string, token: string): Promise<WeClawResponse> {
    try {
      const legacyUrl = process.env.WECLAW_API_URL || 'http://weclaw-bridge:26322';
      const resp = await axios.get(
        `${legacyUrl}/bots/${encodeURIComponent(botId)}/messages`,
        { params: { text }, headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
      console.log(`[WeClawClient] ✅ 旧路径发送成功 (bot=${botId})`);
      return { code: 200, message: 'OK' };
    } catch {
      console.warn(`[WeClawClient] ⚠️  旧路径发送失败 (401 expected), 消息未发送: bot=${botId}`);
      return { code: 401, message: 'Unauthorized', error: 'weclawbot-api 不支持的接口' };
    }
  }

  /**
   * 发送图片/表情包
   */
  async sendImage(imageUrl: string, _botId?: string): Promise<WeClawResponse> {
    const token = this.openilinkToken || process.env.OPENILINK_TOKEN || '';
    if (!token) {
      console.warn('[WeClawClient] 未配置 OpeniLink Token，无法发送图片');
      return { code: 500, message: 'No token' };
    }
    try {
      const resp = await axios.post(
        `${this.openilinkUrl}/bot/v1/message/send`,
        { type: 'image', url: imageUrl },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      if (resp.data?.ok) console.log('[WeClawClient] ✅ 图片发送成功');
      return { code: resp.data?.ok ? 200 : 500, message: resp.data?.ok ? 'OK' : 'Failed' };
    } catch (e: any) {
      console.error('[WeClawClient] 图片发送失败:', e.message);
      return { code: 500, message: e.message };
    }
  }

  async sendWithTyping(text: string, botId?: string): Promise<void> {
    try {
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(text.length * 50, 1000), 4000)));
      await this.sendMessage(text, botId);
    } catch (error: any) {
      console.error(`[WeClawClient] sendWithTyping 失败:`, error.message);
    }
  }
}

/** 单例实例 */
let instance: WeClawClient | null = null;

/**
 * 获取 WeClawClient 单例
 */
export function getWeClawClient(): WeClawClient {
  if (!instance) {
    instance = new WeClawClient();
  }
  return instance;
}
