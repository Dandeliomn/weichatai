#!/usr/bin/env node
/**
 * hermes-st-relay.js
 *
 * Core relay that bridges Hermes ↔ SillyTavern.
 *
 * Architecture:
 *   Hermes state.db (SQLite) → relay polls for new WeChat user messages
 *     → routes each message to connected ST ChatBridge client via WebSocket SERVER
 *     → ST (ChatBridge) generates reply via DeepSeek/LLM
 *     → relay receives reply via same WebSocket
 *     → relay sends reply via iLink API back to WeChat
 *
 * Bot→ST mapping is loaded from PostgreSQL bot_accounts + character_templates.
 *
 * Usage:
 *   node scripts/hermes-st-relay.js          # run continuously (default)
 *   node scripts/hermes-st-relay.js --once   # process once and exit
 *   node scripts/hermes-st-relay.js --catch-up  # process all history first
 *
 * Environment:
 *   HERMES_STATE_DB       path to state.db (default: ~/.hermes/state.db)
 *   DATABASE_URL          PostgreSQL connection (default: localhost)
 *   RELAY_WS_PORT         WebSocket server port (default: 8850)
 *   POLL_INTERVAL         Poll interval in ms (default: 1000)
 *   MAPPING_REFRESH       Bot mapping refresh in ms (default: 30000)
 *   ILINK_BASE_URL        iLink API base URL (default: https://ilinkai.weixin.qq.com)
 *   HERMES_BOT_ID         Pin to a specific bot_id (optional, for multi-bot setups)
 */

const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Dependencies (lazy-loaded for clear error messages)
// ---------------------------------------------------------------------------
let sqlite3, Pool, WebSocket;

try {
  sqlite3 = require('better-sqlite3');
} catch (e) {
  throw new Error('better-sqlite3 is required: npm install better-sqlite3');
}
try {
  Pool = require('pg').Pool;
} catch (e) {
  throw new Error('pg is required: npm install pg');
}
try {
  WebSocket = require('ws');
} catch (e) {
  throw new Error('ws is required: npm install ws');
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const HERMES_DB = process.env.HERMES_STATE_DB || path.join(os.homedir(), '.hermes', 'state.db');
const PG_URL = process.env.DATABASE_URL || 'postgresql://weclaw:weclaw_secret@localhost:5432/weclaw_companion';
const RELAY_WS_PORT = parseInt(process.env.RELAY_WS_PORT || '8850', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL || '1000', 10);
const MAPPING_REFRESH_MS = parseInt(process.env.MAPPING_REFRESH || '30000', 10);
const ILINK_BASE_URL = process.env.ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com';
const PINNED_BOT_ID = process.env.HERMES_BOT_ID || null;
const CURSOR_CONFIG_KEY = 'hermes_st_relay_cursor';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let pgPool = null;
let hermesDb = null;
let cursor = 0;
let isRunning = true;
let wss = null;

// wechat_id → { ws, botId, charName } — connected ST ChatBridge clients
const stClients = new Map();

// bot_id → bot account info (for iLink send)
const botStMap = new Map();

// wechat_id → bot_id[] lookup for message routing
const wechatIdToBotIds = new Map();

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/**
 * Initialize database connections.
 */
function initDB() {
  pgPool = new Pool({ connectionString: PG_URL, max: 5 });

  // Open and keep Hermes state.db connection for the process lifetime
  try {
    hermesDb = sqlite3(HERMES_DB, { readonly: true });
    console.log(`[Relay] ✅ Hermes state.db: ${HERMES_DB}`);
  } catch (e) {
    console.error(`[Relay] ❌ Cannot open Hermes state.db at ${HERMES_DB}:`, e.message);
    console.error('[Relay] Ensure Hermes is running and the database file exists.');
    process.exit(1);
  }
}

/**
 * Load the last processed message cursor from PostgreSQL.
 */
async function loadCursor() {
  try {
    const { rows } = await pgPool.query(
      `SELECT value FROM system_config WHERE key = '${CURSOR_CONFIG_KEY}'`
    );
    cursor = parseInt(rows[0]?.value || '0', 10);
    console.log(`[Relay] Cursor loaded: ${cursor}`);
  } catch (e) {
    console.warn('[Relay] Could not load cursor, starting from 0.');
    cursor = 0;
  }
}

/**
 * Save the cursor to PostgreSQL.
 */
async function saveCursor(newCursor) {
  try {
    await pgPool.query(
      `INSERT INTO system_config (key, value) VALUES ('${CURSOR_CONFIG_KEY}', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [String(newCursor)]
    );
  } catch (e) {
    console.error(`[Relay] Failed to save cursor ${newCursor}:`, e.message);
  }
}

// ---------------------------------------------------------------------------
// Bot → ST mapping
// ---------------------------------------------------------------------------

/**
 * Load bot mappings from PostgreSQL.
 * Returns an array of bot descriptors with their iLink connection info.
 */
async function loadBotMappings() {
  try {
    const { rows } = await pgPool.query(`
      SELECT
        b.id, b.bot_id, b.wechat_id, b.nickname, b.bot_index,
        b.api_token, b.bot_token, b.ilink_base_url, b.ilink_user_id,
        b.character_id,
        ct.name AS char_name,
        ct.tagline AS char_tagline,
        ct.description AS char_description,
        ct.personality AS char_personality,
        ct.system_prompt AS char_system_prompt,
        ct.example_dialogue AS char_example_dialogue
      FROM bot_accounts b
      LEFT JOIN character_templates ct ON b.character_id = ct.id
      WHERE b.is_active = TRUE
        AND b.deleted_at IS NULL
      ORDER BY b.bot_index
    `);

    let bots = rows.map((r) => ({
      id: r.id,
      bot_id: r.bot_id,
      wechat_id: r.wechat_id,
      nickname: r.nickname,
      bot_index: r.bot_index,
      api_token: r.api_token,
      bot_token: r.bot_token,
      ilink_base_url: r.ilink_base_url || ILINK_BASE_URL,
      ilink_user_id: r.ilink_user_id,
      character_id: r.character_id,
      character: r.char_name
        ? {
            id: r.character_id,
            name: r.char_name,
            tagline: r.char_tagline,
            description: r.char_description,
            personality: r.char_personality,
            system_prompt: r.char_system_prompt,
            example_dialogue: r.char_example_dialogue,
          }
        : null,
    }));

    // If PINNED_BOT_ID is set, filter to only that bot
    if (PINNED_BOT_ID) {
      bots = bots.filter((b) => b.bot_id === PINNED_BOT_ID);
    }

    // Only keep bots that have a character assigned (others can't use ST)
    const withChar = bots.filter((b) => b.character);
    const withoutChar = bots.filter((b) => !b.character);
    if (withoutChar.length > 0) {
      console.log(
        `[Relay] ⚠️  ${withoutChar.length} bot(s) without character (skipping ST):`,
        withoutChar.map((b) => b.bot_id).join(', ')
      );
    }

    return withChar;
  } catch (e) {
    console.error('[Relay] Failed to load bot mappings:', e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// WebSocket Server (ST ChatBridge connects to us)
// ---------------------------------------------------------------------------

/**
 * Start WebSocket server for ST ChatBridge clients to connect to.
 */
function startWSServer() {
  wss = new WebSocket.Server({ port: RELAY_WS_PORT });

  console.log(`[relay] WebSocket server listening on :${RELAY_WS_PORT}`);

  wss.on('connection', (ws) => {
    let clientInfo = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'identify') {
          // ST ChatBridge registers itself
          clientInfo = {
            botId: msg.bot_id,
            wechatId: msg.wechat_id,
            charName: msg.char_name || 'unknown',
          };
          stClients.set(msg.wechat_id, { ws, ...clientInfo });
          console.log(`[relay] ST client registered: ${msg.char_name} (${msg.wechat_id})`);
        } else if (msg.type === 'reply') {
          // ST generated a reply → send via iLink
          const botId = clientInfo?.botId || msg.bot_id;
          const botMapping = botStMap.get(botId);
          if (botMapping) {
            console.log(
              `[Relay] 📩 ← ST: bot=${botId} from=${msg.user_id} "${(msg.content || '').substring(0, 40)}..."`
            );
            sendViaILink(botMapping, msg);
          } else {
            console.warn(`[Relay] No bot mapping for bot_id=${botId}, cannot send iLink reply`);
          }
        }
      } catch (e) {
        // skip malformed messages
      }
    });

    ws.on('close', () => {
      if (clientInfo) {
        stClients.delete(clientInfo.wechatId);
        console.log(`[relay] ST client disconnected: ${clientInfo.charName}`);
      }
    });

    ws.on('error', (err) => {
      console.error(`[relay] WS client error:`, err.message);
    });
  });

  return wss;
}

/**
 * Safely send a JSON message over a WebSocket.
 */
function safeWsSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.error('[Relay] WS send error:', e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bot mapping refresh
// ---------------------------------------------------------------------------

/**
 * Refresh bot→ST mappings from the database.
 * Rebuilds the botStMap and wechatIdToBotIds lookup tables.
 */
async function refreshMappings() {
  try {
    const mappings = await loadBotMappings();

    // Rebuild botStMap (bot_id → bot info for iLink)
    botStMap.clear();
    for (const mapping of mappings) {
      botStMap.set(mapping.bot_id, mapping);
    }

    // Rebuild wechat_id → bot_id lookup map for message routing
    wechatIdToBotIds.clear();
    for (const mapping of mappings) {
      if (mapping.wechat_id) {
        const existing = wechatIdToBotIds.get(mapping.wechat_id);
        if (existing) {
          existing.push(mapping.bot_id);
        } else {
          wechatIdToBotIds.set(mapping.wechat_id, [mapping.bot_id]);
        }
      }
    }

    console.log(
      `[Relay] Bot mappings: ${botStMap.size} configured (${stClients.size} ST clients connected)`
    );
  } catch (e) {
    console.error('[Relay] Failed to refresh mappings:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

/**
 * Poll Hermes state.db for new WeChat user messages and forward to ST.
 */
// ---------------------------------------------------------------------------
// Memory self-evolution: correction detection
// ---------------------------------------------------------------------------

/**
 * Detect and handle memory correction requests from user.
 * Spawns memory-correct.js asynchronously.
 */
function handleMemoryCorrection(content, wechatId, botId) {
  const charName = botStMap.get(botId)?.character_name || '王静';
  const claim = content.replace(/'/g, "'\\''");

  console.log(`[Relay] 🔧 Memory correction detected: bot=${botId} claim="${content.substring(0, 40)}..."`);

  // Spawn correction tool asynchronously (non-blocking)
  const { spawn } = require('child_process');
  const toolPath = path.join(__dirname, 'memory-correct.js');
  const child = spawn('node', [toolPath, '-c', charName, '-m', content], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let result = '';
  child.stdout.on('data', (data) => { result += data.toString(); });
  child.stderr.on('data', (data) => { result += data.toString(); });

  child.on('close', (code) => {
    (async () => {
    console.log(`[Relay] Correction result (exit ${code}): ${result.substring(0, 200)}`);

    // Send acknowledgment back to WeChat via iLink
    const botMapping = botStMap.get(botId);
    if (botMapping) {
      const success = result.includes('✅ 更正完成') || result.includes('🗑️');
      const dryRun = result.includes('DRY RUN');
      const reply = success
        ? `已查证聊天记录并更正记忆 ✓`
        : dryRun
          ? null
          : `已查证，但未找到需要更正的内容`;

      if (reply) {
        try {
          await sendViaILink(botMapping, {
            type: 'reply',
            bot_id: botId,
            user_id: wechatId,
            content: reply,
            action: 'send_message',
          });
        } catch (e) {
          console.error('[Relay] Failed to send correction ack:', e.message);
        }
      }
    }
    })();
  });

  child.on('error', (err) => {
    console.error(`[Relay] Correction spawn error:`, err.message);
  });
}

async function pollMessages() {
  if (!hermesDb) {
    console.error('[Relay] Hermes DB not initialized');
    return;
  }

  try {
    const msgs = hermesDb
      .prepare(
        `
        SELECT m.id, m.role, m.content, m.timestamp, s.user_id
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE s.source = 'weixin'
          AND m.role = 'user'
          AND m.id > ?
        ORDER BY m.id
        LIMIT 50
      `
      )
      .all(cursor);

    if (msgs.length === 0) return;

    let maxId = cursor;

    for (const msg of msgs) {
      const { id, content, timestamp, user_id: wechatId } = msg;

      if (!content || !wechatId) {
        if (id > maxId) maxId = id;
        continue;
      }
      if (id > maxId) maxId = id;

      // Route message to the correct bot(s) by wechat_id
      const targetBotIds = wechatIdToBotIds.get(wechatId);
      if (!targetBotIds || targetBotIds.length === 0) {
        console.log(`[Relay] No bot mapping for wechat_id=${wechatId}, skipping message`);
        continue;
      }

      for (const botId of targetBotIds) {
        // Check for memory correction intent before forwarding to ST
        const correctionPattern = /(?:这段|那个|这个|那里|这里).*(?:不对|不是|错了|记错)|(?:其实|应该是).+|^不对|^错了|^记错|纠正|更正|改一下/;
        if (correctionPattern.test(content)) {
          handleMemoryCorrection(content, wechatId, botId);
        }

        // Route message to connected ST client (by wechat_id)
        const stClient = stClients.get(wechatId);
        if (stClient && stClient.ws.readyState === WebSocket.OPEN) {
          const payload = {
            type: 'user_request',
            user_id: wechatId,
            bot_id: stClient.botId,
            content: {
              messages: [
                { role: 'user', content: content }
              ]
            },
            timestamp: Math.floor(timestamp),
          };
          stClient.ws.send(JSON.stringify(payload));
          console.log(
            `[Relay] 📩 Relayed to ST: bot=${botId} user=${wechatId} "${content.substring(0, 40)}..."`
          );
        } else {
          console.warn(
            `[Relay] ⚠️ Cannot forward (ST not connected for wechat_id=${wechatId})`
          );
        }
      }
    }

    // Advance cursor
    cursor = maxId;
    await saveCursor(cursor);
    console.log(`[Relay] Polled: ${msgs.length} msgs, cursor=${cursor}`);
  } catch (e) {
    console.error('[Relay] Poll error:', e.message);
  }
}

// ---------------------------------------------------------------------------
// iLink API
// ---------------------------------------------------------------------------

/**
 * Send a message via the iLink sendmessage API.
 * Matches the same format used in src/utils/weclawClient.ts.
 * @param {Object} botMapping - Bot account info from botStMap
 * @param {Object} msg - Reply message { user_id, content, ... }
 */
async function sendViaILink(botMapping, msg) {
  const botId = botMapping.bot_id;
  const toUserId = msg.user_id;
  const text = msg.content;

  if (!toUserId || !text) {
    console.warn(`[Relay] Incomplete reply for bot ${botId}:`, JSON.stringify(msg));
    return;
  }

  const token = botMapping.bot_token || botMapping.api_token;
  if (!token) {
    console.warn(`[Relay] No token for bot ${botId}, cannot send iLink message`);
    return;
  }

  const baseUrl = botMapping.ilink_base_url || ILINK_BASE_URL;
  const url = `${baseUrl}/ilink/bot/sendmessage`;

  const body = JSON.stringify({
    base_info: { channel_version: '2.2.0' },
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: `st-relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
    },
  });

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${token}`,
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': '131584',
      },
      body,
      signal: AbortSignal.timeout(15000),
    });

    const result = (await resp.json()) || {};
    const ret = result.ret ?? 0;
    const errcode = result.errcode ?? 0;

    if (ret === 0 && errcode === 0) {
      console.log(`[Relay] ✅ iLink sent: to=${toUserId}`);
    } else if (ret === -14 || errcode === -14) {
      console.warn(`[Relay] ⚠️ Session expired for bot=${botId}, ret=${ret}`);
    } else {
      console.warn(
        `[Relay] ⚠️ iLink error ret=${ret} errcode=${errcode}: ${result.errmsg || 'unknown'}`
      );
    }
  } catch (e) {
    console.error(`[Relay] ❌ iLink send failed: bot=${botId}`, e.message);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  console.log(`\n[Relay] Shutting down (${signal})...`);
  isRunning = false;

  // Close all ST client WebSocket connections
  for (const [wechatId, client] of stClients) {
    if (client.ws) {
      try {
        client.ws.close();
      } catch { /* ignore */ }
    }
  }
  stClients.clear();

  // Close WebSocket server
  if (wss) {
    try {
      wss.close();
    } catch { /* ignore */ }
  }

  // Close PostgreSQL pool
  if (pgPool) {
    try {
      await pgPool.end();
    } catch { /* ignore */ }
  }

  // Close Hermes SQLite connection
  if (hermesDb) {
    try {
      hermesDb.close();
    } catch { /* ignore */ }
  }

  console.log('[Relay] Goodbye');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const isOnce = process.argv.includes('--once');
  const catchUp = process.argv.includes('--catch-up');

  console.log('');
  console.log('='.repeat(60));
  console.log('  Hermes ↔ SillyTavern Relay');
  console.log('='.repeat(60));
  console.log(`  Hermes DB:     ${HERMES_DB}`);
  console.log(`  PostgreSQL:    ${PG_URL.replace(/\/\/.*@/, '//***@')}`);
  console.log(`  WS Server:     :${RELAY_WS_PORT}`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`  Bot refresh:   ${MAPPING_REFRESH_MS}ms`);
  console.log(`  Mode:          ${isOnce ? 'once' : 'continuous'}${catchUp ? ' (catch-up)' : ''}`);
  console.log('='.repeat(60));
  console.log('');

  // Initialize database connections
  initDB();
  await loadCursor();

  // On first run (cursor === 0) and not catching up, jump to recent messages
  // to avoid flooding ST with months of history.
  if (cursor === 0 && !catchUp) {
    const now = Date.now() / 1000;
    // Jump to 5 minutes ago — state.db uses REAL timestamps (epoch)
    const fiveMinAgo = now - 300;
    // Find the first message id newer than 5 min ago
    try {
      const row = hermesDb
        .prepare(
          `
          SELECT MIN(m.id) as id
          FROM messages m
          JOIN sessions s ON m.session_id = s.id
          WHERE s.source = 'weixin' AND m.role = 'user' AND m.timestamp > ?
        `
        )
        .get(fiveMinAgo);
      if (row && row.id) {
        cursor = row.id - 1; // start just before this message
        console.log(`[Relay] First run, fast-forwarding cursor to ~5 min ago (id=${cursor})`);
      }
    } catch (e) {
      console.warn('[Relay] Could not fast-forward cursor:', e.message);
    }
    await saveCursor(cursor);
  }

  // Load initial bot mappings
  await refreshMappings();

  if (botStMap.size === 0) {
    console.log('[Relay] ⚠️  No bots with characters configured. Waiting for bot registration...');
  }

  // Start WebSocket server for ST ChatBridge clients
  startWSServer();

  // Periodic mapping refresh
  if (!isOnce) {
    setInterval(refreshMappings, MAPPING_REFRESH_MS);
  }

  // Main poll loop
  const pollOnce = async () => {
    if (!isRunning) return;
    try {
      await pollMessages();
    } catch (e) {
      console.error('[Relay] Poll loop error:', e.message);
    }
  };

  // First poll immediately, then on interval
  await pollOnce();
  if (!isOnce) {
    setInterval(pollOnce, POLL_INTERVAL_MS);
    console.log(`[Relay] Running. Press Ctrl+C to stop.`);

    // Also refresh mappings once after initial startup
    setTimeout(refreshMappings, 5000);
  } else {
    console.log(`[Relay] --once: done.`);
    await shutdown('SIGTERM');
  }
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGQUIT', () => shutdown('SIGQUIT'));

process.on('uncaughtException', (err) => {
  console.error('[Relay] Uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Relay] Unhandled rejection:', reason);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
main().catch((err) => {
  console.error('[Relay] Fatal:', err.message);
  process.exit(1);
});
