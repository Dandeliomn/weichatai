#!/usr/bin/env node
/**
 * hermes-st-relay.js — SillyTavern 直连消息中继（合并版）
 * =============================================================================
 *
 * 功能：消息轮询 + ST API 直连 + PG同步 + 世界书 + 富协议人格注入
 *
 * 消息流:
 *   微信 → iLink → Hermes Gateway → SQLite → relay → HTTP REST → ST → DeepSeek
 *                                                   ↓
 *                                              PG conversation_logs
 *
 * 相比旧版 ChatBridge (WebSocket):
 *   ✅ 无浏览器依赖 — 无需 puppeteer/unbuffer/伪终端
 *   ✅ HTTP REST 直连 ST — 更稳定，更简单
 *   ✅ 内置 SSE 解析 — 处理 ST 流式响应
 *   ✅ 自动重连 & 错误恢复
 *   ✅ 30s 人格缓存 — 避免频繁读盘
 *
 * 使用: node scripts/hermes-st-relay.js
 * 环境变量: 见 .env.example 中的 ST_* 配置
 *
 * =============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const crypto = require('crypto');

// =============================================================================
// 配置常量
// =============================================================================

const CONFIG = {
  // 🔒 开发模式 — 设为 true 时跳过所有 LLM 调用，返回模拟回复
  DEV_MODE: process.env.DEV_MODE === 'true',

  // Hermes Gateway SQLite
  HERMES_DB: process.env.HERMES_DB_PATH || '/root/.hermes/data/conversations.db',
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL || '2000', 10),

  // SillyTavern REST API
  ST_API_URL: process.env.ST_API_URL || 'http://sillytavern:8000',
  ST_API_KEY: process.env.ST_API_KEY || '',
  ST_CHARACTER: process.env.ST_CHARACTER || '助手',
  ST_TIMEOUT: parseInt(process.env.ST_TIMEOUT || '60000', 10),

  // iLink 回复API
  ILINK_API_URL: process.env.ILINK_API_URL || 'http://localhost:18789',
  ILINK_API_TOKEN: process.env.ILINK_API_TOKEN || '',

  // PostgreSQL (同步日志)
  PG_URL: process.env.DATABASE_URL || null,  // 未设置时禁用 PG 同步

  // 人格注入 (Rich Protocol)
  PERSONA_PATH: process.env.PERSONA_PATH || path.join(process.env.HOME || '/root', '.hermes', 'active_persona.json'),
  PERSONA_CACHE_TTL: parseInt(process.env.PERSONA_CACHE_TTL || '30000', 10),

  // 世界书
  WORLDBOOK_DIR: process.env.WORLDBOOK_DIR || '/root/.hermes/worldbooks',

  // 游标
  CURSOR_FILE: process.env.CURSOR_FILE || '/tmp/hermes-relay-cursor.json',
};

// =============================================================================
// 日志工具
// =============================================================================

const LOG_PREFIX = '[hermes-st-relay]';

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`${ts} ${LOG_PREFIX}`, ...args);
}

function warn(...args) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.warn(`${ts} ${LOG_PREFIX} ⚠️`, ...args);
}

function error(...args) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.error(`${ts} ${LOG_PREFIX} ❌`, ...args);
}

// =============================================================================
// 1. SQLite 消息轮询
// =============================================================================

let db = null;

function getDB() {
  if (db) return db;
  try {
    // 优先使用 better-sqlite3 (npm install better-sqlite3)
    db = require('better-sqlite3')(CONFIG.HERMES_DB, { readonly: true, fileMustExist: false });
    log(`📂 SQLite 已打开: ${CONFIG.HERMES_DB}`);
    return db;
  } catch (e) {
    // 降级: 用 sql.js (npm install sql.js)
    try {
      const initSqlJs = require('sql.js');
      const buffer = fs.readFileSync(CONFIG.HERMES_DB);
      const SQL = initSqlJs();
      db = new SQL.Database(buffer);
      log(`📂 SQLite (sql.js) 已打开: ${CONFIG.HERMES_DB}`);
      return db;
    } catch (e2) {
      error(`无法打开 SQLite 数据库: ${e.message} / ${e2.message}`);
      return null;
    }
  }
}

function loadCursor() {
  try {
    if (fs.existsSync(CONFIG.CURSOR_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.CURSOR_FILE, 'utf8'));
      return data.lastId || 0;
    }
  } catch (e) {
    warn(`读取游标失败: ${e.message}`);
  }
  return 0;
}

function saveCursor(lastId) {
  try {
    fs.writeFileSync(CONFIG.CURSOR_FILE, JSON.stringify({ lastId, updatedAt: Date.now() }), 'utf8');
  } catch (e) {
    error(`保存游标失败: ${e.message}`);
  }
}

/**
 * 轮询 Hermes Gateway 的 SQLite 数据库，获取新消息
 * 返回消息数组 [{ id, conversation_id, role, content, timestamp }]
 *
 * 使用参数化查询 (SQL注入防护)
 */
function pollMessages(lastCursor) {
  const database = getDB();
  if (!database) return [];

  try {
    let rows;
    if (database && database.prepare) {
      // better-sqlite3
      const stmt = database.prepare(`
        SELECT id, conversation_id, role, content, created_at
        FROM messages
        WHERE id > ?
        ORDER BY id ASC
        LIMIT 50
      `);
      rows = stmt.all(lastCursor);
    } else {
      // sql.js
      const stmt = database.prepare(`
        SELECT id, conversation_id, role, content, created_at
        FROM messages
        WHERE id > ?
        ORDER BY id ASC
        LIMIT 50
      `);
      stmt.bind([lastCursor]);
      rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
    }

    if (rows && rows.length > 0) {
      log(`📩 新消息: ${rows.length} 条 (游标: ${lastCursor} → ${rows[rows.length - 1].id})`);
    }
    return rows || [];
  } catch (e) {
    error(`轮询消息失败: ${e.message}`);
    return [];
  }
}

// =============================================================================
// 2. 富协议 — 人格加载
// =============================================================================

let personaCache = null;
let personaCacheTime = 0;

/**
 * 加载当前激活的人格 (兼容 set-persona.js 的 attributes 数组格式)
 * 1. 读取 active_persona.json → 获取属性列表
 * 2. 逐个解析 hersona YAML → 提取人格属性
 * 3. 组合为 system prompt，缓存 30s
 *
 * @returns {{ name: string, systemPrompt: string, traits: object } | null}
 */
function loadActivePersona() {
  // 缓存命中
  if (personaCache && (Date.now() - personaCacheTime) < CONFIG.PERSONA_CACHE_TTL) {
    return personaCache;
  }

  try {
    if (!fs.existsSync(CONFIG.PERSONA_PATH)) {
      personaCache = null;
      return null;
    }

    const activePersona = JSON.parse(fs.readFileSync(CONFIG.PERSONA_PATH, 'utf8'));
    const HERSONA_ATTR_DIR = process.env.HERSONA_ATTR_DIR
      || path.join(__dirname, '..', 'vendor', 'hersona', 'attributes');

    // ---- 新格式: { attributes: [{category, name}, ...] } (set-persona.js) ----
    if (Array.isArray(activePersona.attributes) && activePersona.attributes.length > 0) {
      const allYamls = [];
      let personaName = '';

      for (const attr of activePersona.attributes) {
        const yamlPath = path.join(HERSONA_ATTR_DIR, attr.category, attr.name + '.yaml');
        if (!fs.existsSync(yamlPath)) continue;
        try {
          const jsyaml = require('js-yaml');
          const ydata = jsyaml.load(fs.readFileSync(yamlPath, 'utf8')) || {};
          allYamls.push(ydata);
          if (!personaName && ydata.display_name) personaName = ydata.display_name;
        } catch (e) {
          warn(`解析属性失败 ${attr.category}/${attr.name}: ${e.message}`);
        }
      }

      if (allYamls.length > 0) {
        const systemPrompt = buildCombinedPersonaPrompt(personaName || '助手', allYamls);
        personaCache = { name: personaName || '助手', systemPrompt, traits: allYamls, raw: allYamls };
        personaCacheTime = Date.now();
        log(`🧑 人格已加载: ${activePersona.attributes.map(a => a.name).join(', ')}`);
        return personaCache;
      }
    }

    // ---- 旧格式降级: { current/name, path/file } ----
    const personaName = activePersona.current || activePersona.name;
    const personaFile = activePersona.path || activePersona.file;
    if (personaFile && fs.existsSync(personaFile)) {
      let personaData = null;
      try {
        const jsyaml = require('js-yaml');
        personaData = jsyaml.load(fs.readFileSync(personaFile, 'utf8')) || {};
      } catch (e) {
        personaData = { raw: fs.readFileSync(personaFile, 'utf8') };
      }
      const systemPrompt = buildPersonaSystemPrompt(personaName, personaData);
      personaCache = { name: personaName || '助手', systemPrompt, traits: personaData?.traits || {}, raw: personaData };
      personaCacheTime = Date.now();
      log(`🧑 人格已加载 (旧格式): ${personaName}`);
      return personaCache;
    }

    personaCache = null;
    return null;
  } catch (e) {
    error(`加载人格失败: ${e.message}`);
    return null;
  }
}

/**
 * 从多个 hersona YAML 构建组合 system prompt (新格式)
 */
function buildCombinedPersonaPrompt(name, yamls) {
  const parts = [`你是 ${name}。`];

  // 收集所有核心特质
  const allTraits = [];
  for (const y of yamls) {
    if (Array.isArray(y.core_traits)) allTraits.push(...y.core_traits.map(String));
  }
  if (allTraits.length > 0) {
    parts.push(`\n【核心性格】\n${allTraits.map(t => `- ${t}`).join('\n')}`);
  }

  // 收集语气
  const tones = yamls.map(y => y.tone || '').filter(Boolean);
  if (tones.length > 0) {
    parts.push(`\n【语气风格】\n${tones.join('; ')}`);
  }

  // 收集口头禅
  const allPhrases = [];
  for (const y of yamls) {
    if (Array.isArray(y.catchphrases)) {
      for (const p of y.catchphrases) {
        allPhrases.push(typeof p === 'string' ? p : (p.phrase || ''));
      }
    }
  }
  if (allPhrases.length > 0) {
    parts.push(`\n【常用口头禅】\n${allPhrases.filter(Boolean).slice(0, 6).map(p => `- ${p}`).join('\n')}`);
  }

  // 收集描述
  const descs = yamls.map(y => y.description || '').filter(Boolean);
  if (descs.length > 0) {
    parts.push(`\n【属性说明】\n${descs.join('\n')}`);
  }

  return parts.join('\n');
}

/**
 * 从 hersona YAML 构建 system prompt
 */
function buildPersonaSystemPrompt(name, data) {
  if (!data) return '';

  const parts = [];

  // 名字
  if (name) {
    parts.push(`你是 ${name}。`);
  }

  // 核心性格 - hersona 标准属性
  if (data.core || data.core_traits) {
    parts.push(`核心性格: ${data.core || data.core_traits}`);
  }

  // 性格特质
  if (data.traits) {
    const traitStr = Array.isArray(data.traits) ? data.traits.join('、') : data.traits;
    parts.push(`性格特质: ${traitStr}`);
  }

  // 说话风格
  if (data.speech_style || data.speech) {
    parts.push(`说话风格: ${data.speech_style || data.speech}`);
  }

  // 背景故事
  if (data.background || data.story) {
    parts.push(`背景: ${data.background || data.story}`);
  }

  // 自定义属性
  if (data.attributes) {
    for (const [key, val] of Object.entries(data.attributes)) {
      if (['core', 'traits', 'speech', 'background'].includes(key)) continue;
      parts.push(`${key}: ${val}`);
    }
  }

  // 关系状态 (she-love-me 集成)
  if (data.relationship) {
    parts.push(`当前关系: ${JSON.stringify(data.relationship)}`);
  }

  return parts.join('\n');
}

// =============================================================================
// 3. SillyTavern REST API 直连 — 替代 ChatBridge WebSocket
// =============================================================================

/**
 * 调用 SillyTavern 的 HTTP REST API 发送消息并获取 AI 回复
 *
 * ST API: POST /api/chat/send
 * 鉴权: X-API-Key header (对应 ST config.yaml 中的 apiKey)
 *
 * 相比旧版 ChatBridge WebSocket:
 *   - 无浏览器环境要求 (无需 unbuffer/伪终端)
 *   - HTTP 请求/响应模型更稳定可靠
 *   - 自动处理 SSE 流式响应，无需外部依赖
 *   - 内置超时和重试
 *
 * @param {string} userName - 微信用户显示名
 * @param {string} message - 用户消息内容
 * @param {string} [systemPrompt] - 可选的 system prompt (富协议注入)
 * @returns {Promise<string>} AI 回复文本
 */
function callSillyTavernAPI(userName, message, systemPrompt) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(CONFIG.ST_API_URL);
    const chatId = `${CONFIG.ST_CHARACTER}__${userName}`;

    // 构造消息体
    // ST /api/chat/send 接受带有角色信息的消息数组
    const mes = [];

    // 如果有富协议 system prompt，注入到消息历史前面
    if (systemPrompt) {
      mes.push({ role: 'system', content: systemPrompt });
    }

    // 当前用户消息
    mes.push({ name: userName, role: 'user', content: message });

    const body = JSON.stringify({
      chat_id: chatId,
      mes: mes,
      stream: true,  // SSE 流式响应
    });

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 8000,
      path: '/api/chat/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-API-Key': CONFIG.ST_API_KEY,
      },
      timeout: CONFIG.ST_TIMEOUT,
    };

    log(`🔗 ST API 请求: ${chatId} "${message.substring(0, 40)}..."`);

  // 🛡️ 开发模式：跳过真实 LLM 调用，返回模拟回复
  if (CONFIG.DEV_MODE) {
    log('⚠️ DEV_MODE 开启，返回模拟回复');
    resolve(`[开发模式] 你说了: "${message.substring(0, 30)}"，这是模拟回复，未调用 DeepSeek。`);
    return;
  }

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errorBody = '';
        res.on('data', (chunk) => { errorBody += chunk.toString(); });
        res.on('end', () => {
          reject(new Error(`ST API 返回 ${res.statusCode}: ${errorBody.substring(0, 200)}`));
        });
        return;
      }

      // ============================================================
      // SSE (Server-Sent Events) 解析器
      // ST 的 /api/chat/send 以 SSE 流返回 token
      //
      // 支持的格式:
      //   data: {"event":"token","value":"你好"}
      //   data: {"event":"final","mes":{"content":"..."}}
      //   data: {"event":"stream_end"}
      //   data: {"value":"你好"} (无 event 字段的纯 token)
      // ============================================================
      let fullResponse = '';
      let buffer = '';
      let lastEvent = '';

      const bufferLines = [];  // 按行收集 SSE 事件（延后解析，避免尾帧丢 data: 前缀）

      res.on('error', (e) => {
        reject(new Error(`ST API 响应流中断: ${e.message}`));
      });

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';  // 保留不完整的最后一行

        for (const line of lines) {
          bufferLines.push(line);
        }
      });

      res.on('end', () => {
        // 将 buffer 中剩余部分也推入
        if (buffer.trim()) bufferLines.push(buffer.trim());

        // 统一解析所有行（保证 data:/event: 前缀被正确处理）
        for (const line of bufferLines) {
          const trimmed = line.trim();
          if (trimmed === '' || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('event:')) {
            lastEvent = trimmed.slice(6).trim();
            continue;
          }

          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            try {
              const data = JSON.parse(dataStr);
              if (data.event === 'token' || data.event === 'text') {
                fullResponse += data.value || data.text || '';
              } else if (data.event === 'final' || data.event === 'done') {
                if (data.mes?.content) fullResponse = data.mes.content;
                else if (data.content) fullResponse = data.content;
              } else if (data.event === 'error') {
                error(`ST API 流错误: ${data.message || data.value}`);
              } else if (data.value) {
                fullResponse += data.value;
              }
            } catch (_) {
              if (dataStr && lastEvent === 'token') fullResponse += dataStr;
            }
            continue;
          }

          // 无 event/data 前缀的行 — 尝试 JSON 解析
          try {
            const data = JSON.parse(trimmed);
            if (data.value) fullResponse += data.value;
            else if (data.text) fullResponse += data.text;
            else if (data.content) fullResponse = data.content;
          } catch (_) { /* 忽略 */ }
        }

        const trimmed = fullResponse.trim();
        if (trimmed) {
          log(`💬 ST 回复: "${trimmed.substring(0, 60)}..."`);
          resolve(trimmed);
        } else {
          warn('ST API 返回空响应');
          resolve('(没有回复)');
        }
      });
    });

    req.on('error', (e) => {
      error(`ST API 请求失败: ${e.message}`);
      reject(e);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('ST API 请求超时'));
    });

    req.write(body);
    req.end();
  });
}

// =============================================================================
// 4. iLink 回复发送
// =============================================================================

/**
 * 通过 iLink API 发送回复消息到微信
 */
function sendViaILink(toUser, replyText) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(CONFIG.ILINK_API_URL);

    const body = JSON.stringify({
      to: toUser,
      content: replyText,
      type: 'text',
    });

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 18789,
      path: '/api/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${CONFIG.ILINK_API_TOKEN}`,
      },
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('error', (e) => {
        warn(`iLink 响应流错误: ${e.message}`);
        resolve(null); // 降级：不阻塞
      });
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          log(`📤 已发送到 ${toUser}: "${replyText.substring(0, 30)}..."`);
          resolve(data);
        } else {
          warn(`iLink 发送失败: ${res.statusCode} ${data.substring(0, 100)}`);
          resolve(null); // 不阻塞主流程
        }
      });
    });

    req.on('error', (e) => {
      warn(`iLink 发送错误: ${e.message}`);
      resolve(null); // 不阻塞主流程
    });

    req.write(body);
    req.end();
  });
}

// =============================================================================
// 5. PostgreSQL 同步
// =============================================================================

let pgPool = null;
let pgRetryTimer = null;

async function getPG() {
  if (pgPool) return pgPool;
  if (!CONFIG.PG_URL) {
    // 未配置 DATABASE_URL，静默禁用同步
    return null;
  }
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: CONFIG.PG_URL,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
    await pgPool.query('SELECT 1');
    log('🐘 PostgreSQL 已连接');
    return pgPool;
  } catch (e) {
    warn(`PostgreSQL 连接失败 (将在下次同步时重试): ${e.message}`);
    return null;
  }
}

/**
 * 同步消息到 PostgreSQL conversation_logs
 * 首次失败后会每次尝试重连，成功即恢复。
 */
async function syncToPG(conversationId, fromUser, userMsg, botReply) {
  if (!CONFIG.PG_URL) return;  // 未配置，静默跳过

  try {
    const pool = await getPG();
    if (!pool) return;

    await pool.query(
      `INSERT INTO conversation_logs (conversation_id, from_user, role, content, created_at)
       VALUES ($1, $2, 'user', $3, NOW())`,
      [conversationId, fromUser, userMsg]
    );

    await pool.query(
      `INSERT INTO conversation_logs (conversation_id, from_user, role, content, created_at)
       VALUES ($1, $2, 'assistant', $3, NOW())`,
      [conversationId, fromUser, botReply]
    );
  } catch (e) {
    // pgPool 可能已失效，清除缓存强制下次重试
    if (e.message?.includes('Connection') || e.message?.includes('terminated')) {
      warn(`PG 连接失效，准备重建: ${e.message}`);
      try { pgPool?.end(); } catch (_) {}
      pgPool = null;
    } else {
      warn(`PG 同步失败: ${e.message}`);
    }
  }
}

// =============================================================================
// 6. 世界书监控 (World Book)
// =============================================================================

let worldBookWatcher = null;
let worldBookCache = {};

/**
 * 启动世界书文件监控
 * 当世界书文件变化时，自动重新加载
 */
function startWorldBookWatcher() {
  if (!fs.existsSync(CONFIG.WORLDBOOK_DIR)) {
    log(`📖 世界书目录不存在: ${CONFIG.WORLDBOOK_DIR} (跳过)`);
    return;
  }

  log(`📖 世界书监控已启动: ${CONFIG.WORLDBOOK_DIR}`);

  // 首次加载
  loadWorldBooks();

  // 监控文件变化
  try {
    worldBookWatcher = fs.watch(CONFIG.WORLDBOOK_DIR, (eventType, filename) => {
      if (filename && filename.endsWith('.json')) {
        log(`📖 世界书文件已变更: ${filename}，重新加载`);
        loadWorldBooks();
      }
    });
    worldBookWatcher.on('error', (e) => {
      warn(`世界书监控错误: ${e.message} (停止监控)`);
      try { worldBookWatcher.close(); } catch (_) {}
      worldBookWatcher = null;
    });
  } catch (e) {
    warn(`世界书监控启动失败: ${e.message}`);
  }
}

function loadWorldBooks() {
  try {
    const files = fs.readdirSync(CONFIG.WORLDBOOK_DIR).filter(f => f.endsWith('.json'));
    const books = {};

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(CONFIG.WORLDBOOK_DIR, file), 'utf8');
        books[file] = JSON.parse(content);
      } catch (e) {
        warn(`读取世界书 ${file} 失败: ${e.message}`);
      }
    }

    worldBookCache = books;
    log(`📖 世界书已加载: ${Object.keys(books).length} 个文件`);
  } catch (e) {
    error(`加载世界书失败: ${e.message}`);
  }
}

/**
 * 从世界书中查找与用户消息匹配的词条
 * 简单关键词匹配：词条 key 出现在消息中即视为匹配
 */
function getWorldBookMatches(userMessage) {
  const matches = [];
  if (!userMessage || Object.keys(worldBookCache).length === 0) return matches;

  for (const [filename, book] of Object.entries(worldBookCache)) {
    const entries = Array.isArray(book) ? book : (book.entries || []);
    for (const entry of entries) {
      const keys = Array.isArray(entry.keys) ? entry.keys : [entry.key];
      for (const key of keys) {
        if (key && userMessage.includes(key)) {
          matches.push({
            key: key,
            content: entry.content || entry.description || JSON.stringify(entry),
          });
          break;  // 每个词条只匹配一次
        }
      }
    }
  }
  return matches;
}

// =============================================================================
// 7. 消息处理主循环
// =============================================================================

/**
 * 处理单条消息：ST 推理 → iLink 回复 → PG 同步
 */
async function processMessage(msg) {
  const conversationId = msg.conversation_id || `wx_${msg.id}`;
  const fromUser = msg.conversation_id || 'unknown';
  const userContent = msg.content || '';
  const userName = fromUser.substring(0, 10); // 显示名取前10位

  log(`🔄 处理消息 #${msg.id}: "${userContent.substring(0, 40)}..."`);

  try {
    // 1. 跳过非用户消息
    if (msg.role && msg.role !== 'user' && msg.role !== 'human') {
      log(`⏭️ 跳过 ${msg.role} 消息`);
      return;
    }

    // 2. 加载人格 (富协议) + 世界书
    const persona = loadActivePersona();
    let systemPrompt = persona ? persona.systemPrompt : '';

    // 注入世界书 (匹配当前用户消息中出现的词条)
    const worldBookEntries = getWorldBookMatches(userContent);
    if (worldBookEntries.length > 0) {
      const worldBookPrompt = worldBookEntries
        .map(e => `[${e.key}] ${e.content}`)
        .join('\n');
      systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + `【世界书设定】\n${worldBookPrompt}`;
    }

    // 3. 调用 ST API (REST 直连，替代 WebSocket ChatBridge)
    log(`🤖 请求 ST 推理...`);
    const reply = await callSillyTavernAPI(userName, userContent, systemPrompt);

    if (!reply || reply === '(没有回复)') {
      warn(`ST 返回空回复，跳过发送`);
      return;
    }

    // 4. 发送回复到微信 (iLink API)
    await sendViaILink(fromUser, reply);

    // 5. 同步到 PostgreSQL (记录日志)
    await syncToPG(conversationId, fromUser, userContent, reply);

    log(`✅ 消息 #${msg.id} 处理完成`);
  } catch (e) {
    error(`处理消息 #${msg.id} 失败: ${e.message}`);

    // 降级回复：告诉用户出错了
    try {
      await sendViaILink(fromUser, '嗯，我刚刚走神了，你再说一遍好不好？😅');
    } catch (_) { /* 忽略 */ }
  }
}

/**
 * 主轮询循环
 */
async function mainLoop() {
  let lastCursor = loadCursor();

  log('');
  log('='.repeat(56));
  log('  🤖  Hermes ↔ SillyTavern 直连中继 (合并版)');
  log('  🔌  ChatBridge → HTTP REST API');
  log('='.repeat(56));
  log(`  📂  轮询间隔:     ${CONFIG.POLL_INTERVAL}ms`);
  log(`  🌐  ST API:       ${CONFIG.ST_API_URL}`);
  log(`  🎭  角色:         ${CONFIG.ST_CHARACTER}`);
  log(`  🧑  人格缓存:     ${CONFIG.PERSONA_CACHE_TTL}ms`);
  log(`  📖  世界书目录:   ${CONFIG.WORLDBOOK_DIR}`);
  log(`  📌  游标文件:     ${CONFIG.CURSOR_FILE}`);
  log('');

  if (CONFIG.ST_API_KEY) {
    log(`🔑 ST API 鉴权: 已配置`);
  } else {
    warn(`⚠️ ST_API_KEY 未配置 — 如 ST 开启了 API 鉴权，请求会失败`);
  }

  // 启动世界书监控
  startWorldBookWatcher();

  // 主循环
  let pollCount = 0;
  const maxRetries = 10;
  let retries = 0;

  while (true) {
    try {
      // 检查数据库文件是否存在
      if (!fs.existsSync(CONFIG.HERMES_DB)) {
        if (pollCount % 30 === 0) {
          warn(`等待 Hermes 数据库: ${CONFIG.HERMES_DB}`);
        }
        await sleep(CONFIG.POLL_INTERVAL);
        pollCount++;
        continue;
      }

      const messages = pollMessages(lastCursor);

      if (messages.length > 0) {
        // 逐个处理消息（串行，保持顺序）
        for (const msg of messages) {
          await processMessage(msg);
        }

        // 更新游标
        lastCursor = messages[messages.length - 1].id;
        saveCursor(lastCursor);

        retries = 0; // 重置重试计数
      }

      pollCount++;
      if (pollCount % 100 === 0) {
        log(`📊 轮询 #${pollCount} (游标: ${lastCursor})`);
      }

      // 定期检查 SQLite 连接健康
      if (pollCount % 50 === 0 && db) {
        try {
          if (db && db.prepare) {
            db.prepare('SELECT 1').get();
          }
        } catch (e) {
          warn('SQLite 连接异常，准备重新连接');
          try { db.close(); } catch (_) {}
          db = null;
        }
      }
    } catch (e) {
      error(`轮询循环异常: ${e.message}`);
      retries++;

      if (retries >= maxRetries) {
        warn(`连续失败 ${maxRetries} 次，继续运行`);
        retries = 0;
      }
    }

    // 等待下次轮询
    await sleep(CONFIG.POLL_INTERVAL);
  }
}

// =============================================================================
// 工具函数
// =============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// 优雅关闭
// =============================================================================

function shutdown(signal) {
  log(`\n🛑 收到 ${signal} 信号，正在关闭...`);

  // 关闭世界书监听
  if (worldBookWatcher) {
    worldBookWatcher.close();
    worldBookWatcher = null;
  }

  // 关闭 SQLite
  if (db && db.close) {
    try { db.close(); } catch (_) {}
    db = null;
  }

  // 关闭 PG
  if (pgPool) {
    try { pgPool.end(); } catch (_) {}
    pgPool = null;
  }

  log('👋 已关闭');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// =============================================================================
// 启动!
// =============================================================================

mainLoop().catch((e) => {
  error(`致命错误: ${e.message}`);
  process.exit(1);
});
