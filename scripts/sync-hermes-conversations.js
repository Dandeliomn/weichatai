#!/usr/bin/env node
/**
 * sync-hermes-conversations.js
 * 从宿主机 Hermes state.db 同步微信对话到 Docker PostgreSQL
 * 用法: node scripts/sync-hermes-conversations.js [--once]
 */

const { Pool } = require('pg');
const sqlite3 = require('better-sqlite3');
const path = require('path');
const os = require('os');

const HERMES_DB = path.join(os.homedir(), '.hermes', 'state.db');
const PG_URL = process.env.DATABASE_URL || 'postgresql://weclaw:weclaw_secret@localhost:5432/weclaw_companion';

async function syncOnce() {
  const pg = new Pool({ connectionString: PG_URL });
  const sqlite = sqlite3(HERMES_DB, { readonly: true });

  // 获取上次同步游标
  const { rows } = await pg.query(`SELECT value FROM system_config WHERE key = 'hermes_sync_cursor'`);
  const lastTs = parseFloat(rows[0]?.value || '0');

  // 读取新消息 (WeChat only)
  const msgs = sqlite.prepare(`
    SELECT m.role, m.content, m.timestamp, s.user_id
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    WHERE s.source = 'weixin' AND m.timestamp > ?
    ORDER BY m.timestamp
  `).all(lastTs);

  let synced = 0;
  for (const msg of msgs) {
    const { role, content, timestamp, user_id: wechatId } = msg;
    if (!content || !wechatId) continue;

    const roleMapped = role === 'assistant' ? 'assistant' : 'user';

    // upsert user
    const u = await pg.query(
      `INSERT INTO users (wechat_id, last_active_at) VALUES ($1, NOW())
       ON CONFLICT (wechat_id) DO UPDATE SET last_active_at = NOW() RETURNING id`,
      [wechatId]
    );
    const userId = u.rows[0].id;

    // 写入 (跳过重复 — 用唯一约束)
    try {
      await pg.query(
        `INSERT INTO conversation_logs (user_id, wechat_id, role, content, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, wechatId, roleMapped, content, new Date(timestamp * 1000)]
      );
      synced++;
    } catch (e) {
      if (!e.message?.includes('duplicate')) throw e;
    }
  }

  // 更新游标
  const newCursor = msgs.length > 0 ? msgs[msgs.length - 1].timestamp : lastTs;
  await pg.query(
    `INSERT INTO system_config (key, value) VALUES ('hermes_sync_cursor', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [String(newCursor)]
  );

  console.log(`[sync] ✅ ${synced} new messages (cursor: ${newCursor})`);
  sqlite.close();
  await pg.end();
}

const once = process.argv.includes('--once');

if (once) {
  syncOnce().catch(e => { console.error(e.message); process.exit(1); });
} else {
  console.log('[sync] Starting Hermes → PostgreSQL sync (every 10s)');
  syncOnce().catch(() => {});
  setInterval(() => syncOnce().catch(() => {}), 10000);
}
