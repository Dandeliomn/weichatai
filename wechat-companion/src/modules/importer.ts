/**
 * 聊天记录解析器
 *
 * 支持多种微信聊天记录导出格式:
 * - EchoTrace HTML 格式
 * - WeFlow API JSON 格式 (含base64表情包/图片)
 * - WeFlow 导出 JSON/CSV/TXT
 * - 通用 CSV 格式
 *
 * 输出统一格式的 ChatMessage 数组
 */

import * as cheerio from 'cheerio';
import { parse as csvParse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

/** 统一的消息格式 */
export interface ChatMessage {
  /** 发送者昵称 */
  sender: string;
  /** 消息内容 (文字内容，或媒体描述) */
  content: string;
  /** 原始时间戳 */
  timestamp: Date;
  /** 消息类型 */
  msgType: 'text' | 'image' | 'video' | 'file' | 'sticker' | 'emoji' | 'voice' | 'system' | 'other';
  /** 是否来自用户本人 */
  isFromUser: boolean;
  /** 顺序号 */
  seqId?: number;
  /** 媒体数据 base64 (表情包/图片/视频) */
  mediaData?: string;
  /** 媒体 URL */
  mediaUrl?: string;
  /** 缩略图 */
  mediaThumb?: string;
}

/** 解析选项 */
export interface ParseOptions {
  /** 用户本人的昵称 (用于标记 isFromUser) */
  userNickname?: string;
  /** 用户本人的微信ID */
  userWechatId?: string;
}

// =============================================================================
// 主解析入口
// =============================================================================

/**
 * 解析聊天记录文件
 * 自动检测格式，调用对应的解析器
 *
 * @param filePath - 文件路径
 * @param format - 格式提示 (html/json/csv/auto)
 * @param options - 解析选项
 * @returns 解析出的消息数组
 */
export async function parseChatExport(
  filePath: string,
  format: string = 'auto',
  options: ParseOptions = {}
): Promise<ChatMessage[]> {
  const ext = path.extname(filePath).toLowerCase();
  const detectedFormat = format === 'auto' ? detectFormat(ext) : format;

  console.log(`[Importer] 解析文件: ${filePath} (format=${detectedFormat})`);

  const rawContent = fs.readFileSync(filePath, 'utf-8');

  let messages: ChatMessage[] = [];

  switch (detectedFormat) {
    case 'html':
    case 'htm':
      messages = parseHTML(rawContent, options);
      break;
    case 'json':
      messages = parseJSON(rawContent, options);
      break;
    case 'weflow-api':
      // WeFlow HTTP API 直接拉取的格式 (含媒体base64)
      messages = parseWeFlowAPIBundle(rawContent, options);
      break;
    case 'csv':
    case 'txt':
      messages = parseCSV(rawContent, options);
      break;
    default:
      throw new Error(`不支持的格式: ${detectedFormat}`);
  }

  // 后处理
  messages = postProcess(messages, options);

  console.log(`[Importer] 解析完成: ${messages.length} 条消息`);

  return messages;
}

/** 文件大小上限 (超过则使用流式解析) */
const STREAMING_THRESHOLD = 50 * 1024 * 1024; // 50MB
/** 硬上限，拒绝解析 */
const HARD_LIMIT = 200 * 1024 * 1024; // 200MB
/** 安全读取上限 (HTML 解析的硬限制) */
const HTML_SAFE_LIMIT = 100 * 1024 * 1024; // 100MB

/**
 * 流式解析大文件 (JSONL/CSV)
 * 逐行读取，每500条返回一批，最后返回全部
 * 相比 readFileSync 大幅降低峰值内存
 */
export async function parseChatExportStreaming(
  filePath: string,
  format: string,
  options: ParseOptions,
  onBatch: (batch: ChatMessage[], progress: number) => Promise<void>
): Promise<number> {
  const stat = fs.statSync(filePath);
  if (stat.size > HARD_LIMIT) {
    throw new Error(`文件过大 (${(stat.size/1024/1024).toFixed(0)}MB > ${HARD_LIMIT/1024/1024}MB)`);
  }

  const ext = path.extname(filePath).toLowerCase();
  const detectedFormat = format === 'auto' ? detectFormat(ext) : format;
  console.log(`[Importer:stream] ${filePath} (format=${detectedFormat}, size=${(stat.size/1024/1024).toFixed(1)}MB)`);

  let totalMessages = 0;
  let batch: ChatMessage[] = [];
  const BATCH_SIZE = 500;

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const processed = postProcess(batch, options);
    if (processed.length > 0) {
      await onBatch(processed, totalMessages);
      totalMessages += processed.length;
    }
    batch = [];
    // 提示 GC (建议而非强制)
    if (totalMessages % 5000 === 0 && global.gc) { global.gc(); }
  };

  // JSONL 流式读取 (逐行 parse)
  if (detectedFormat === 'json') {
    const rl = createInterface({ input: createReadStream(filePath, { highWaterMark: 64 * 1024 }), crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        // 尝试作为 JSONL 行解析
        const obj = JSON.parse(trimmed);
        if (Array.isArray(obj)) {
          for (const item of obj) {
            const msg = convertJSONObject(item, options, totalMessages + batch.length);
            if (msg) batch.push(msg);
            if (batch.length >= BATCH_SIZE) await flushBatch();
          }
        } else {
          const msg = convertJSONObject(obj, options, totalMessages + batch.length);
          if (msg) batch.push(msg);
          if (batch.length >= BATCH_SIZE) await flushBatch();
        }
      } catch {
        // 不是 JSONL 格式，整文件读取回退
        rl.close();
        const raw = fs.readFileSync(filePath, 'utf-8');
        const messages = parseJSON(raw, options);
        const processed = postProcess(messages, options);
        await onBatch(processed, totalMessages);
        totalMessages += processed.length;
        break;
      }
    }
  } else if (detectedFormat === 'csv' || detectedFormat === 'txt') {
    // CSV 流式读取
    const rl = createInterface({ input: createReadStream(filePath, { highWaterMark: 64 * 1024 }), crlfDelay: Infinity });
    let seqId = totalMessages;
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseTextLine(trimmed);
      if (parsed) {
        seqId++;
        batch.push({
          sender: parsed.sender,
          content: parsed.content,
          timestamp: parseChineseTime(parsed.time || ''),
          msgType: detectMessageType(parsed.content),
          isFromUser: isUserSender(parsed.sender, options),
          seqId,
        });
        if (batch.length >= BATCH_SIZE) await flushBatch();
      }
    }
  } else {
    // HTML/WeFlow: 仍需全量读取，但加以限制
    const stat = fs.statSync(filePath);
    if (stat.size > HTML_SAFE_LIMIT) {
      throw new Error(`HTML文件过大 (${(stat.size/1024/1024).toFixed(0)}MB > ${HTML_SAFE_LIMIT/1024/1024}MB)，请转换为JSON/CSV格式`);
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    let messages: ChatMessage[];
    if (detectedFormat === 'weflow-api') {
      messages = parseWeFlowAPIBundle(raw, options);
    } else {
      messages = parseHTML(raw, options);
    }
    const processed = postProcess(messages, options);
    // 分批回调避免一次性返回海量数据
    for (let i = 0; i < processed.length; i += BATCH_SIZE) {
      const chunk = processed.slice(i, i + BATCH_SIZE);
      await onBatch(chunk, totalMessages);
      totalMessages += chunk.length;
    }
  }

  await flushBatch(); // 最后一批
  console.log(`[Importer:stream] 完成: ${totalMessages} 条`);
  return totalMessages;
}

// =============================================================================
// 格式检测
// =============================================================================

function detectFormat(ext: string): string {
  switch (ext) {
    case '.html':
    case '.htm':
      return 'html';
    case '.json':
      return 'json';
    case '.csv':
      return 'csv';
    case '.txt':
      return 'csv'; // txt 通常也是类 CSV 格式
    default:
      return 'html'; // 默认尝试 HTML
  }
}

// =============================================================================
// HTML 解析器 (EchoTrace 导出格式)
// =============================================================================

/**
 * EchoTrace 导出的 HTML 格式:
 * 通常包含 class="message" 的 div，内含 sender 和 content
 *
 * 示例结构:
 * <div class="message">
 *   <div class="sender">张三</div>
 *   <div class="content">你好呀</div>
 *   <div class="time">2024-01-15 14:30:00</div>
 * </div>
 */
function parseHTML(html: string, options: ParseOptions): ChatMessage[] {
  // 检测 WeFlow 格式 (window.WEFLOW_DATA)
  const weflowMatch = html.match(/window\.WEFLOW_DATA\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (weflowMatch) {
    try {
      const data = JSON.parse(weflowMatch[1]);
      console.log(`[Importer] 检测到 WeFlow 格式: ${data.length} 条消息`);
      return parseWeFlowHTML(data, options, html);
    } catch (e) {
      console.warn('[Importer] WeFlow 数据解析失败，回退到普通 HTML:', e);
    }
  }

  const $ = cheerio.load(html);
  const messages: ChatMessage[] = [];
  let seqId = 0;

  // 尝试多种常见的 HTML 结构
  // 模式1: EchoTrace 格式 — .message-item 或 .chat-item
  const selectors = [
    '.message-item', '.chat-item', '.message', '.msg',
    'tr.message', 'div[class*="message"]', 'div[class*="msg"]',
    '.chatlog-item', '.wechat-message',
  ];

  let items: cheerio.Cheerio<any> = $([] as any);

  for (const selector of selectors) {
    items = $(selector);
    if (items.length > 0) {
      console.log(`[Importer] 匹配到选择器: ${selector} (${items.length} 条)`);
      break;
    }
  }

  // 如果上述选择器都不匹配，尝试解析所有 <tr> (表格格式)
  if (items.length === 0) {
    items = $('tr');
    if (items.length > 0) {
      console.log(`[Importer] 回退到表格格式: tr (${items.length} 条)`);
    }
  }

  // 如果仍然为空，尝试解析纯文本格式
  if (items.length === 0) {
    return parsePlainText(html, options);
  }

  items.each((_i: number, el: any) => {
    const $el = $(el);
    seqId++;

    // 提取发送者
    let sender = $el.find('.sender, .name, .nickname, td:first-child').first().text().trim();

    // 提取内容
    let content = $el.find('.content, .text, .message-text, td:nth-child(2)').first().text().trim();

    // 提取时间
    let timeStr = $el.find('.time, .timestamp, .date, td:nth-child(3)').first().text().trim();

    // 如果标准模式不匹配，尝试从文本中解析
    if (!sender || !content) {
      const fullText = $el.text().trim();
      const parsed = parseTextLine(fullText);
      if (parsed) {
        sender = parsed.sender;
        content = parsed.content;
        timeStr = parsed.time || timeStr;
      }
    }

    if (content && content.length > 0) {
      messages.push({
        sender: sender || '未知',
        content,
        timestamp: parseChineseTime(timeStr),
        msgType: detectMessageType(content),
        isFromUser: isUserSender(sender, options),
        seqId,
      });
    }
  });

  return messages;
}

// =============================================================================
// WeFlow HTML 解析器 (数据在 window.WEFLOW_DATA 中)
// =============================================================================

/**
 * WeFlow 导出的 HTML 格式:
 * <script>window.WEFLOW_DATA = [{i, t, s, a, b, p}, ...]</script>
 *
 * s: sender (0=左/对方, 1=右/自己)
 * a: avatar HTML (含 alt 属性作为发送者名)
 * b: bubble HTML (含消息内容和时间)
 * t: 时间戳 (秒)
 */
function parseWeFlowHTML(data: any[], options: ParseOptions, html?: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let seqId = 0;

  // 收集所有出现过的发送者名（从 avatar 的 alt 中提取）
  const senderNames: Record<number, string> = {};

  for (const item of data) {
    seqId++;
    const side = item.s; // 0=左(对方), 1=右(自己)

    // 从 avatar 提取发送者名
    if (!senderNames[side]) {
      let name = '';
      if (typeof item.a === 'string') {
        // 优先取 img 的 alt 属性
        const altMatch = item.a.match(/alt=["']([^"']*)["']/);
        name = altMatch ? altMatch[1].trim() : '';
        // 如果没有 alt，取 span 等标签的纯文本内容
        if (!name) {
          // 可能是首字母头像如 <span>O</span>，不用"O"这种单字母，后面会从 title 覆盖
          name = item.a.replace(/<[^>]+>/g, '').trim();
        }
      }
      senderNames[side] = name || `用户${side}`;
    }

    const sender = senderNames[side];

    // 从 bubble 中提取消息内容的文本
    let content = '';
    if (typeof item.b === 'string') {
      // 去掉 HTML 标签，提取纯文本
      const textMatch = item.b.match(/<div class="message-text">([\s\S]*?)<\/div>/);
      if (textMatch) {
        content = textMatch[1].replace(/<[^>]+>/g, '').trim();
      }
      // 如果是媒体消息但没提取到文本，用描述
      if (!content) {
        if (item.b.includes('message-media')) {
          const altMatch = item.b.match(/alt=["']([^"']*)["']/);
          content = altMatch ? `[${altMatch[1]}]` : '[媒体消息]';
        } else {
          content = item.b.replace(/<[^>]+>/g, '').trim() || '[消息]';
        }
      }
    }

    // 提取时间
    let timestamp: Date = new Date();
    if (item.t) {
      timestamp = new Date(item.t * 1000);
    }

    // 根据 sender 名判断消息类型和是否用户本人
    const isUser = side === 1; // WeFlow 中 s:1 是用户自己

    messages.push({
      sender,
      content,
      timestamp,
      msgType: detectMessageType(content),
      isFromUser: options.userNickname
        ? isUserSender(sender, options)
        : isUser,
      seqId,
    });
  }

  // 从系统消息中提取对方真实昵称（如 "王静" 撤回了一条消息 → 王静）
  const realName = extractNameFromSystemMessages(messages, senderNames[0]);
  if (realName && senderNames[0] && senderNames[0].length <= 2) {
    const oldName = senderNames[0];
    senderNames[0] = realName;
    for (const msg of messages) {
      if (msg.sender === oldName) msg.sender = realName;
    }
    console.log(`[Importer] 从系统消息识别到对方昵称: "${oldName}" → "${realName}"`);
  }

  console.log(`[Importer] WeFlow 解析完成: ${messages.length} 条, ` +
    `发送者: ${Object.values(senderNames).join(', ')}`);
  return messages;
}

// =============================================================================
// JSON 解析器
// =============================================================================

function parseJSON(json: string, options: ParseOptions): ChatMessage[] {
  let data: any;

  try {
    data = JSON.parse(json);
  } catch {
    // 可能是 JSONL 格式 (每行一个 JSON)
    const lines = json.split('\n').filter((l) => l.trim());
    const messages: ChatMessage[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const msg = convertJSONObject(obj, options);
        if (msg) messages.push(msg);
      } catch {
        // 跳过无效行
      }
    }
    return messages;
  }

  // 如果 JSON 是对象，尝试找到消息列表
  const messageList =
    data.messages || data.chatLog || data.conversations || data.data || data;

  const items = Array.isArray(messageList) ? messageList : [messageList];

  return items
    .map((item: any, index: number) => convertJSONObject(item, options, index))
    .filter(Boolean) as ChatMessage[];
}

function convertJSONObject(
  obj: any,
  options: ParseOptions,
  index: number = 0
): ChatMessage | null {
  if (!obj || typeof obj !== 'object') return null;

  const sender =
    obj.sender || obj.speaker || obj.talker || obj.name || obj.from || '未知';
  const content = obj.content || obj.message || obj.text || obj.body || '';
  const timeStr = obj.time || obj.timestamp || obj.date || obj.createTime || '';
  const msgType = obj.type || obj.msgType || obj.messageType || 'text';

  if (!content) return null;

  return {
    sender,
    content,
    timestamp: typeof timeStr === 'number' ? new Date(timeStr * 1000) : parseChineseTime(String(timeStr)),
    msgType: msgType === 'text' ? 'text' : ('other' as any),
    isFromUser: isUserSender(sender, options),
    seqId: index,
  };
}

// =============================================================================
// CSV 解析器
// =============================================================================

// =============================================================================
// WeFlow API JSON 解析器 (含媒体 base64)
// =============================================================================

/**
 * 解析 WeFlow HTTP API 直接拉取的 JSON Bundle
 *
 * 格式: ExportBundle { exporter: 'weflow-api', messages: [...], stats: {...} }
 * 每条消息包含 senderName, content, timestamp, msgType, mediaData(base64) 等
 */
function parseWeFlowAPIBundle(json: string, options: ParseOptions): ChatMessage[] {
  let bundle: any;

  try {
    bundle = JSON.parse(json);
  } catch {
    throw new Error('WeFlow API JSON 解析失败');
  }

  // 验证是否为 WeFlow API 格式
  if (bundle.exporter === 'weflow-api' && Array.isArray(bundle.messages)) {
    console.log(`[Importer] WeFlow API 格式: ${bundle.messages.length} 条消息`);
    return bundle.messages.map((m: any, idx: number) =>
      convertWeFlowAPIMessage(m, idx, options)
    );
  }

  // 也可能是 ChatLab 格式
  if (bundle.format === 'chatlab' || bundle.chatlab) {
    const messages = bundle.messages || bundle.data || [];
    console.log(`[Importer] ChatLab 格式: ${messages.length} 条消息`);
    return messages.map((m: any, idx: number) =>
      convertWeFlowAPIMessage(m, idx, options)
    );
  }

  // 直接消息数组
  if (Array.isArray(bundle)) {
    console.log(`[Importer] 原始消息数组: ${bundle.length} 条`);
    return bundle.map((m: any, idx: number) =>
      convertWeFlowAPIMessage(m, idx, options)
    );
  }

  throw new Error('不支持的 JSON 格式');
}

/**
 * 转换单条 WeFlow API 消息
 */
function convertWeFlowAPIMessage(
  m: any,
  idx: number,
  options: ParseOptions
): ChatMessage {
  // 消息类型映射
  const msgTypeMap: Record<string, ChatMessage['msgType']> = {
    text: 'text',
    image: 'image',
    img: 'image',
    video: 'video',
    sticker: 'sticker',
    emoji: 'sticker',    // 自定义表情包统一归为 sticker
    emoticon: 'sticker',
    voice: 'voice',
    audio: 'voice',
    file: 'file',
    system: 'system',
    notification: 'system',
  };

  const rawType = (m.msgType || m.type || 'text').toString().toLowerCase();
  const msgType = msgTypeMap[rawType] || 'other';

  // 提取媒体数据
  const mediaData = m.mediaData || m.media_data || m.imageData || m.image_data || m.stickerData || null;
  const mediaUrl = m.mediaUrl || m.media_url || m.imageUrl || m.image_url || null;
  const mediaThumb = m.mediaThumb || m.thumb || m.thumbnail || m.thumbUrl || null;

  // 构建内容描述
  let content = m.content || m.text || m.message || m.strContent || '';
  if (!content) {
    // 媒体消息没有文字时生成描述
    const descMap: Record<string, string> = {
      image: '[图片]',
      video: '[视频]',
      sticker: '[表情包]',
      voice: '[语音]',
      file: '[文件]',
      system: '[系统消息]',
    };
    content = descMap[msgType] || `[${msgType}]`;
  }

  // 检测用户本人
  const senderName = m.senderName || m.sender_name || m.talkerName || m.displayName || '';
  const isFromUser = isUserSender(senderName, options);

  // 解析时间戳
  let timestamp: Date;
  if (typeof m.timestamp === 'number') {
    timestamp = new Date(m.timestamp > 1e12 ? m.timestamp : m.timestamp * 1000);
  } else if (m.timestamp) {
    timestamp = parseChineseTime(String(m.timestamp));
  } else if (m.time) {
    timestamp = parseChineseTime(String(m.time));
  } else {
    timestamp = new Date();
  }

  return {
    sender: senderName || '未知',
    content,
    timestamp,
    msgType,
    isFromUser,
    seqId: idx + 1,
    mediaData,
    mediaUrl,
    mediaThumb,
  };
}

function parseCSV(csv: string, options: ParseOptions): ChatMessage[] {
  try {
    const records = csvParse(csv, {
      columns: false,
      skip_empty_lines: true,
      trim: true,
    });

    return records
      .map((row: string[], index: number) => {
        // CSV 列: sender, content, timestamp (常见顺序)
        const sender = row[0] || '未知';
        const content = row[1] || '';
        const timeStr = row[2] || '';

        if (!content) return null;

        return {
          sender,
          content,
          timestamp: parseChineseTime(timeStr),
          msgType: detectMessageType(content),
          isFromUser: isUserSender(sender, options),
          seqId: index,
        } as ChatMessage;
      })
      .filter(Boolean) as ChatMessage[];
  } catch {
    // CSV 解析失败，回退到纯文本
    return parsePlainText(csv, options);
  }
}

// =============================================================================
// 纯文本回退解析器
// =============================================================================

/**
 * 解析类似 "2024-01-15 14:30 张三: 你好啊" 的文本格式
 */
function parsePlainText(text: string, options: ParseOptions): ChatMessage[] {
  const lines = text.split('\n').filter((l) => l.trim());
  const messages: ChatMessage[] = [];
  let seqId = 0;

  for (const line of lines) {
    const parsed = parseTextLine(line.trim());
    if (parsed) {
      seqId++;
      messages.push({
        sender: parsed.sender,
        content: parsed.content,
        timestamp: parseChineseTime(parsed.time || ''),
        msgType: detectMessageType(parsed.content),
        isFromUser: isUserSender(parsed.sender, options),
        seqId,
      });
    }
  }

  return messages;
}

/**
 * 解析一行文本 "时间 发送者: 内容"
 */
function parseTextLine(line: string): { time?: string; sender: string; content: string } | null {
  // 模式1: "2024-01-15 14:30:00 张三: 你好"
  let match = line.match(/^(\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}(:\d{2})?)\s+(\S+?)[:：]\s*(.+)$/);
  if (match) {
    return { time: match[1], sender: match[3], content: match[4] };
  }

  // 模式2: "张三: 你好"
  match = line.match(/^(\S{1,30})[:：]\s*(.+)$/);
  if (match) {
    return { sender: match[1], content: match[2] };
  }

  // 模式3: "[时间] 发送者: 内容"
  match = line.match(/^\[(\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}(:\d{2})?)\]\s*(\S+?)[:：]\s*(.+)$/);
  if (match) {
    return { time: match[1], sender: match[3], content: match[4] };
  }

  // 过滤系统消息
  if (/加入群聊|退出群聊|修改群名|撤回|红包|转账/.test(line)) {
    return null;
  }

  return null;
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 解析中文时间格式
 */
function parseChineseTime(timeStr: string): Date {
  if (!timeStr || timeStr.length === 0) {
    return new Date();
  }

  // 标准化分隔符
  const normalized = timeStr.replace(/\//g, '-').replace(/\./g, '-');

  const date = new Date(normalized);

  // 如果解析失败，返回当前时间
  if (isNaN(date.getTime())) {
    // 尝试 "2024年1月15日 14:30" 格式
    const cnMatch = normalized.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?\s*(\d{1,2}):(\d{2})/);
    if (cnMatch) {
      return new Date(
        parseInt(cnMatch[1]),
        parseInt(cnMatch[2]) - 1,
        parseInt(cnMatch[3]),
        parseInt(cnMatch[4]),
        parseInt(cnMatch[5])
      );
    }
    return new Date();
  }

  return date;
}

/**
 * 检测消息类型
 */
function detectMessageType(content: string): ChatMessage['msgType'] {
  if (!content || content.trim().length === 0) return 'system';

  // 系统消息
  if (/\[.*\]/.test(content) && content.length < 30) {
    if (/图片|照片|表情|语音|视频|文件|红包|位置|名片/.test(content)) {
      if (/图片|照片/.test(content)) return 'image';
      if (/表情/.test(content)) return 'emoji';
      if (/语音/.test(content)) return 'other';
      if (/视频/.test(content)) return 'video';
      if (/文件/.test(content)) return 'file';
    }
  }

  return 'text';
}

/**
 * 判断是否为用户本人的消息
 */
function isUserSender(sender: string, options: ParseOptions): boolean {
  if (!options.userNickname && !options.userWechatId) return false;

  const senderLower = sender.toLowerCase().trim();

  if (options.userNickname) {
    if (senderLower === options.userNickname.toLowerCase().trim()) return true;
    if (senderLower.includes(options.userNickname.toLowerCase().trim())) return true;
  }

  if (options.userWechatId) {
    if (senderLower === options.userWechatId.toLowerCase().trim()) return true;
  }

  return false;
}

// =============================================================================
// 后处理
// =============================================================================

function postProcess(messages: ChatMessage[], options: ParseOptions): ChatMessage[] {
  // 1. 按时间排序
  messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // 2. 去重 (连续相同内容)
  const deduped: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (i === 0 || messages[i].content !== messages[i - 1].content) {
      deduped.push(messages[i]);
    }
  }

  // 3. 过滤系统消息和空消息
  const filtered = deduped.filter(
    (m) =>
      m.content.trim().length > 0 &&
      m.msgType !== 'system' &&
      !/^\[.*\]$/.test(m.content.trim()) && // 纯系统标记
      m.sender !== '<style>' && // style 标签
      !/^--[a-z]/.test(m.sender) // CSS 变量名 (--bg, --text 等)
  );

  // 4. 重新分配 seqId
  filtered.forEach((m, i) => {
    m.seqId = i + 1;
  });

  // 5. 如果没有明确标记用户，尝试推断
  if (options.userNickname && filtered.length > 0) {
    // 检查是否有标记为 isFromUser 的消息
    const hasMarked = filtered.some((m) => m.isFromUser);
    if (!hasMarked) {
      // 如果未匹配到昵称，尝试用模糊匹配
      const nickname = options.userNickname.toLowerCase().trim();
      for (const msg of filtered) {
        if (msg.sender.toLowerCase().includes(nickname)) {
          msg.isFromUser = true;
        }
      }
    }
  }

  return filtered;
}

// =============================================================================
// 从系统消息中提取对方真实昵称
// =============================================================================

/**
 * 扫描消息，从系统消息（如 "王静" 撤回了一条消息）中提取对方真实昵称。
 * 返回出现次数最多的带引号名字。
 */
function extractNameFromSystemMessages(messages: ChatMessage[], defaultName: string | undefined): string {
  const nameCounts: Record<string, number> = {};
  // 匹配 "XXX" 或 &quot;XXX&quot; 撤回/添加/邀请 等系统消息中的带引号名字
  for (const msg of messages) {
    const m = msg.content.match(/^["“”]([^"“”]{1,10})["“”]/) ||
              msg.content.match(/^&quot;([^&]{1,10})&quot;/);
    if (m) {
      const name = m[1].trim();
      if (name && name !== defaultName) {
        nameCounts[name] = (nameCounts[name] || 0) + 1;
      }
    }
  }
  // 取出现最多的名字
  let best = '';
  let bestCount = 0;
  for (const [name, count] of Object.entries(nameCounts)) {
    if (count > bestCount) { best = name; bestCount = count; }
  }
  return best;
}
