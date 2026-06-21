/**
 * WeFlow HTTP API 本地提取脚本
 *
 * 用法 (在你安装了微信和WeFlow的电脑上运行):
 *   npx tsx scripts/extract-weflow.ts
 *
 * 前提条件:
 *   1. 微信已登录
 *   2. WeFlow 已启动 (设置 → API 服务 → 启动)
 *   3. 服务器后端已运行，且已知服务器地址
 *
 * 流程:
 *   1. 连接 WeFlow API (localhost:5031) 获取联系人列表
 *   2. 遍历联系人，拉取消息 (含base64编码的图片/表情包)
 *   3. 打包为完整JSON，上传到服务器
 *
 * 环境变量 (可选，也可用命令行参数):
 *   WEFLOW_API=http://127.0.0.1:5031     WeFlow API 地址
 *   SERVER_URL=http://your-server:3000    服务器地址
 *   SERVER_TOKEN=your-jwt-token          登录令牌
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';

// =============================================================================
// 配置
// =============================================================================

const WEFLOW_API = process.env.WEFLOW_API || 'http://127.0.0.1:5031';
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const SERVER_TOKEN = process.env.SERVER_TOKEN || '';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(process.cwd(), 'weflow-exports');

// =============================================================================
// 类型定义
// =============================================================================

interface WeFlowContact {
  id: string;
  name: string;
  remark?: string;       // 备注名
  type: 'private' | 'group';
  avatar?: string;
  messageCount?: number;
}

interface WeFlowMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;      // Unix毫秒
  msgType: 'text' | 'image' | 'video' | 'emoji' | 'sticker' | 'file' | 'voice' | 'system';
  // 媒体文件的本地路径或base64
  mediaData?: string;     // base64 或 文件路径
  mediaUrl?: string;      // API获取URL
  mediaThumb?: string;    // 缩略图
  isGroupMsg: boolean;
}

interface ExportBundle {
  exporter: 'weflow-api';
  version: '1.0';
  exportedAt: string;
  contact: WeFlowContact;
  messages: WeFlowMessage[];
  stats: {
    total: number;
    textCount: number;
    imageCount: number;
    stickerCount: number;
    videoCount: number;
    otherCount: number;
  };
}

// =============================================================================
// WeFlow API 客户端
// =============================================================================

/**
 * WeFlow HTTP API 封装
 * API 文档: https://github.com/hicccc77/WeFlow/blob/main/docs/HTTP-API.md
 */
class WeFlowClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * 测试 API 是否可用
   */
  async ping(): Promise<boolean> {
    try {
      const res = await axios.get(`${this.baseUrl}/ping`, { timeout: 3000 });
      return res.status === 200;
    } catch {
      // 尝试其他可能的健康检查端点
      try {
        const res = await axios.get(`${this.baseUrl}/health`, { timeout: 3000 });
        return res.status === 200;
      } catch {
        try {
          const res = await axios.get(`${this.baseUrl}/api/status`, { timeout: 3000 });
          return res.status === 200;
        } catch {
          return false;
        }
      }
    }
  }

  /**
   * 获取联系人列表
   * GET /contacts 或 /api/contacts 或 /chats
   */
  async getContacts(): Promise<WeFlowContact[]> {
    // 尝试多个可能的端点
    const endpoints = [
      '/contacts',
      '/api/contacts',
      '/chats',
      '/api/chats',
      '/api/conversations',
    ];

    for (const ep of endpoints) {
      try {
        const res = await axios.get(`${this.baseUrl}${ep}`, { timeout: 10000 });
        if (res.data && Array.isArray(res.data)) {
          return this.normalizeContacts(res.data);
        }
        if (res.data?.contacts && Array.isArray(res.data.contacts)) {
          return this.normalizeContacts(res.data.contacts);
        }
        if (res.data?.data && Array.isArray(res.data.data)) {
          return this.normalizeContacts(res.data.data);
        }
      } catch {
        // 尝试下一个端点
      }
    }

    throw new Error(
      '无法获取联系人列表。请确认:\n' +
      '  1. WeFlow 已启动 (设置 → API 服务 → 启动)\n' +
      '  2. API 端口是 5031\n' +
      '  3. 微信已经登录'
    );
  }

  /**
   * 获取指定联系人的消息
   * GET /messages?chat_id=xxx&limit=1000&offset=0
   */
  async getMessages(
    chatId: string,
    limit: number = 1000,
    offset: number = 0
  ): Promise<{ messages: WeFlowMessage[]; hasMore: boolean }> {
    const endpoints = [
      `/messages?chat_id=${chatId}&limit=${limit}&offset=${offset}`,
      `/api/messages?chat_id=${chatId}&limit=${limit}&offset=${offset}`,
      `/chats/${chatId}/messages?limit=${limit}&offset=${offset}`,
      `/api/chats/${chatId}/messages?limit=${limit}&offset=${offset}`,
    ];

    for (const ep of endpoints) {
      try {
        const res = await axios.get(`${this.baseUrl}${ep}`, { timeout: 30000 });
        const data = res.data;

        // 统一数据格式
        const messages = Array.isArray(data)
          ? data
          : data?.messages || data?.data || [];

        const hasMore =
          data?.hasMore !== undefined
            ? data.hasMore
            : messages.length >= limit;

        return {
          messages: this.normalizeMessages(messages, chatId),
          hasMore,
        };
      } catch {
        // 尝试下一个端点
      }
    }

    return { messages: [], hasMore: false };
  }

  /**
   * 获取媒体文件 (图片/表情包/视频的base64数据)
   * GET /media/{messageId}
   */
  async getMedia(messageId: string): Promise<string | null> {
    const endpoints = [
      `/media/${messageId}`,
      `/api/media/${messageId}`,
      `/messages/${messageId}/media`,
      `/api/messages/${messageId}/media`,
    ];

    for (const ep of endpoints) {
      try {
        const res = await axios.get(`${this.baseUrl}${ep}`, {
          timeout: 30000,
          responseType: 'arraybuffer',
        });
        const base64 = Buffer.from(res.data).toString('base64');
        const mimeType = res.headers['content-type'] || 'image/png';
        return `data:${mimeType};base64,${base64}`;
      } catch {
        // 尝试下一个
      }
    }

    return null;
  }

  /**
   * 查询聊天记录 (更细粒度的查询)
   * 支持按关键词/日期范围筛选
   */
  async searchMessages(
    chatId: string,
    keyword?: string,
    startDate?: string,
    endDate?: string
  ): Promise<WeFlowMessage[]> {
    const params = new URLSearchParams();
    params.set('chat_id', chatId);
    if (keyword) params.set('keyword', keyword);
    if (startDate) params.set('start_date', startDate);
    if (endDate) params.set('end_date', endDate);
    params.set('limit', '5000');

    const endpoints = ['/search', '/api/search', '/messages/search', '/api/messages/search'];

    for (const ep of endpoints) {
      try {
        const res = await axios.get(`${this.baseUrl}${ep}?${params.toString()}`, {
          timeout: 60000,
        });
        const data = res.data;
        const messages = Array.isArray(data) ? data : data?.messages || data?.data || [];
        return this.normalizeMessages(messages, chatId);
      } catch {
        // 尝试下一个
      }
    }

    return [];
  }

  // ---- 标准化工具 ----

  private normalizeContacts(raw: any[]): WeFlowContact[] {
    return raw.map((c: any) => ({
      id: c.id || c.chatId || c.chat_id || c.userName || '',
      name: c.name || c.nickName || c.nickname || c.displayName || '未知',
      remark: c.remark || c.remarkName || c.alias,
      type: (c.type === 'group' || c.isGroup || c.is_group) ? 'group' : 'private',
      avatar: c.avatar || c.headImgUrl || c.headImageUrl,
      messageCount: c.messageCount || c.msgCount || c.total,
    }));
  }

  private normalizeMessages(raw: any[], chatId: string): WeFlowMessage[] {
    return raw.map((m: any, index: number) => ({
      id: m.id || m.msgId || m.msg_id || `msg_${index}`,
      chatId: m.chatId || m.chat_id || chatId,
      senderId: m.senderId || m.sender_id || m.talker || '',
      senderName: m.senderName || m.sender_name || m.talkerName || m.displayName || '未知',
      content: m.content || m.message || m.text || m.strContent || '',
      timestamp: typeof m.timestamp === 'number'
        ? (m.timestamp > 1e12 ? m.timestamp : m.timestamp * 1000)
        : Date.parse(m.timestamp || m.time || m.createTime) || Date.now(),
      msgType: this.normalizeMsgType(m),
      mediaData: m.mediaData || m.media_data || m.imageData || m.image_data,
      mediaUrl: m.mediaUrl || m.media_url || m.imageUrl || m.image_url,
      mediaThumb: m.thumb || m.thumbnail || m.thumbUrl,
      isGroupMsg: !!(m.isGroup || m.is_group || m.isGroupMsg),
    }));
  }

  private normalizeMsgType(m: any): WeFlowMessage['msgType'] {
    const t = (m.msgType || m.msg_type || m.type || m.messageType || '').toString().toLowerCase();
    if (/image|img|photo|图片/.test(t)) return 'image';
    if (/video|视频/.test(t)) return 'video';
    if (/emoji|sticker|emoticon|表情/.test(t)) return 'sticker';
    if (/voice|audio|语音/.test(t)) return 'voice';
    if (/file|文件/.test(t)) return 'file';
    if (/system|系统|notification/.test(t)) return 'system';
    return 'text';
  }
}

// =============================================================================
// 导出逻辑
// =============================================================================

async function extractAndUpload(
  chatId: string,
  chatName: string,
  serverToken: string,
  limit: number = 5000
): Promise<ExportBundle> {
  const client = new WeFlowClient(WEFLOW_API);

  console.log(`\n📥 提取: ${chatName} (${chatId})`);

  const allMessages: WeFlowMessage[] = [];
  let offset = 0;
  let hasMore = true;

  // 分批拉取
  while (hasMore && offset < limit) {
    console.log(`  拉取中... offset=${offset}`);
    const result = await client.getMessages(chatId, 1000, offset);
    allMessages.push(...result.messages);
    hasMore = result.hasMore;
    offset += result.messages.length;
  }

  console.log(`  共获取 ${allMessages.length} 条消息`);

  // 下载媒体文件 (图片/表情包)
  const mediaMessages = allMessages.filter(
    (m) => ['image', 'sticker', 'video'].includes(m.msgType) && !m.mediaData
  );

  if (mediaMessages.length > 0) {
    console.log(`  下载 ${mediaMessages.length} 个媒体文件...`);
    let downloaded = 0;
    for (const msg of mediaMessages) {
      try {
        const mediaData = await client.getMedia(msg.id);
        if (mediaData) {
          msg.mediaData = mediaData;
          downloaded++;
        }
      } catch {
        // 跳过下载失败的
      }
      if (downloaded % 50 === 0 && downloaded > 0) {
        console.log(`    媒体下载进度: ${downloaded}/${mediaMessages.length}`);
      }
    }
    console.log(`  成功下载 ${downloaded}/${mediaMessages.length} 个媒体文件`);
  }

  // 统计
  const stats = {
    total: allMessages.length,
    textCount: allMessages.filter((m) => m.msgType === 'text').length,
    imageCount: allMessages.filter((m) => m.msgType === 'image').length,
    stickerCount: allMessages.filter((m) => m.msgType === 'sticker').length,
    videoCount: allMessages.filter((m) => m.msgType === 'video').length,
    otherCount: allMessages.filter((m) => !['text', 'image', 'sticker', 'video'].includes(m.msgType)).length,
  };

  console.log(`  📊 文字:${stats.textCount} 图片:${stats.imageCount} 表情:${stats.stickerCount} 视频:${stats.videoCount}`);

  // 构建导出包
  const bundle: ExportBundle = {
    exporter: 'weflow-api',
    version: '1.0',
    exportedAt: new Date().toISOString(),
    contact: { id: chatId, name: chatName, type: 'private' },
    messages: allMessages,
    stats,
  };

  // 上传
  if (serverToken) {
    console.log(`  📤 上传到服务器: ${SERVER_URL}`);
    try {
      const res = await axios.post(
        `${SERVER_URL}/api/import/weflow-api`,
        bundle,
        {
          headers: {
            'Authorization': `Bearer ${serverToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 120000,
          maxContentLength: 500 * 1024 * 1024, // 500MB
          maxBodyLength: 500 * 1024 * 1024,
        }
      );
      console.log(`  ✅ 上传成功: ${res.data?.taskId ? `taskId=${res.data.taskId}` : 'OK'}`);
    } catch (err: any) {
      console.error(`  ❌ 上传失败: ${err.message}`);
      // 即使上传失败，也保存本地副本
    }
  }

  // 同时保存本地副本
  const outputFile = path.join(OUTPUT_DIR, `weflow_${chatId}_${Date.now()}.json`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(bundle, null, 2));
  console.log(`  💾 本地保存: ${outputFile}`);

  return bundle;
}

async function extractChatLab(chatId: string): Promise<any> {
  // ChatLab 标准格式
  const client = new WeFlowClient(WEFLOW_API);
  const endpoints = [
    `/chatlab/export?chat_id=${chatId}`,
    `/api/chatlab/export?chat_id=${chatId}`,
    `/export/chatlab?chat_id=${chatId}`,
  ];

  for (const ep of endpoints) {
    try {
      const res = await axios.get(`${WEFLOW_API}${ep}`, { timeout: 60000 });
      return res.data;
    } catch {
      // 尝试下一个
    }
  }
  return null;
}

// =============================================================================
// 交互式命令行
// =============================================================================

async function main() {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║   📥 WeFlow → 微信陪伴平台 数据提取工具       ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');

  // 参数解析
  const args = process.argv.slice(2);
  const argMap: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i].startsWith('--')) {
      argMap[args[i].substring(2)] = args[i + 1] || '';
    }
  }

  const weflowUrl = argMap['weflow'] || WEFLOW_API;
  const serverUrl = argMap['server'] || SERVER_URL;
  const serverToken = argMap['token'] || SERVER_TOKEN;
  const chatId = argMap['chat'] || '';
  const keyword = argMap['keyword'] || '';
  const limit = parseInt(argMap['limit'] || '10000', 10);

  const client = new WeFlowClient(weflowUrl);

  // 1. 检查 WeFlow API
  console.log(`🔍 检查 WeFlow API: ${weflowUrl}`);
  const isAlive = await client.ping();
  if (!isAlive) {
    console.error('❌ 无法连接 WeFlow API!');
    console.error('   请确认:');
    console.error('   1. WeFlow 已启动');
    console.error('   2. 设置 → API 服务 → 已启动服务');
    console.error('   3. 端口号是 5031');
    console.error('');
    console.error('   如端口不同，请用: npx tsx scripts/extract-weflow.ts --weflow http://127.0.0.1:你的端口');
    process.exit(1);
  }
  console.log('✅ WeFlow API 已连接');

  // 2. 获取联系人列表
  console.log('\n📋 获取联系人列表...');
  const contacts = await client.getContacts();
  if (contacts.length === 0) {
    console.error('❌ 未找到任何联系人');
    process.exit(1);
  }

  console.log(`找到 ${contacts.length} 个联系人:\n`);
  contacts.forEach((c, i) => {
    const label = c.remark
      ? `${c.name} (备注: ${c.remark})`
      : c.name;
    const typeIcon = c.type === 'group' ? '👥' : '👤';
    const count = c.messageCount ? ` [${c.messageCount}条]` : '';
    console.log(`  ${i}. ${typeIcon} ${label}${count}`);
  });

  // 3. 如果命令行指定了chat，直接提取
  if (chatId) {
    const contact = contacts.find((c) => c.id === chatId) || { id: chatId, name: chatId, type: 'private' as const };
    console.log(`\n📥 提取: ${contact.name}`);
    await extractAndUpload(contact.id, contact.name, serverToken, limit);
    console.log('\n✅ 完成');
    process.exit(0);
  }

  // 4. 关键词搜索模式
  if (keyword) {
    console.log(`\n🔍 搜索关键词 "${keyword}" 的相关消息...`);
    // 搜索所有联系人的聊天记录
    let totalFound = 0;
    for (const contact of contacts) {
      const messages = await client.searchMessages(contact.id, keyword);
      if (messages.length > 0) {
        totalFound += messages.length;
        console.log(`  ${contact.name}: 找到 ${messages.length} 条`);
      }
    }
    console.log(`\n共找到 ${totalFound} 条包含 "${keyword}" 的消息`);
    process.exit(0);
  }

  // 5. 交互模式
  console.log('\n请输入要提取的联系人编号 (多个用逗号分隔, 输入 all 全部提取):');
  // 简单读取输入
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  readline.question('> ', async (answer: string) => {
    readline.close();

    if (answer.toLowerCase() === 'all') {
      console.log(`\n⚠️  将提取全部 ${contacts.length} 个联系人的聊天记录`);
      for (const contact of contacts) {
        await extractAndUpload(contact.id, contact.name, serverToken, limit);
        // 短暂延迟避免 API 过载
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else {
      const indices = answer.split(',').map((s) => parseInt(s.trim()));
      for (const idx of indices) {
        if (idx >= 0 && idx < contacts.length) {
          const contact = contacts[idx];
          await extractAndUpload(contact.id, contact.name, serverToken, limit);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    console.log('\n✅ 全部完成');
    console.log(`本地文件保存在: ${OUTPUT_DIR}`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('❌ 运行失败:', err.message);
  process.exit(1);
});
