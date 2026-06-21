#!/bin/bash
# sync-hermes-conversations.sh
# 从宿主机 Hermes state.db 同步对话到 Docker PostgreSQL
# 用法: ./scripts/sync-hermes-conversations.sh [--once]

HERMES_DB="$HOME/.hermes/state.db"
PG_URL="postgresql://weclaw:weclaw_secret@localhost:5432/weclaw_companion"

sync_once() {
  python3 -c "
import sqlite3, psycopg2, sys, os

hermes_db = os.path.expanduser('$HERMES_DB')
pg_url = '$PG_URL'

# 连接数据库
sqlite = sqlite3.connect(hermes_db)
pg = psycopg2.connect(pg_url)
pg.autocommit = False

# 获取上次同步时间
pg_cur = pg.cursor()
pg_cur.execute(\"SELECT value FROM system_config WHERE key = 'hermes_sync_cursor'\")
row = pg_cur.fetchone()
last_ts = float(row[0]) if row else 0.0

# 读取新消息 (WeChat source only)
msgs = sqlite.execute('''
  SELECT m.role, m.content, m.timestamp, s.user_id
  FROM messages m
  JOIN sessions s ON m.session_id = s.id
  WHERE s.source = 'weixin'
    AND m.timestamp > ?
  ORDER BY m.timestamp
''', (last_ts,)).fetchall()

synced = 0
for msg in msgs:
    role, content, ts, wechat_id = msg
    if not content or not wechat_id:
        continue

    role_mapped = 'assistant' if role == 'assistant' else 'user'

    # upsert user
    pg_cur.execute('''
      INSERT INTO users (wechat_id, last_active_at) VALUES (%s, NOW())
      ON CONFLICT (wechat_id) DO UPDATE SET last_active_at = NOW()
      RETURNING id
    ''', (wechat_id,))
    user_id = pg_cur.fetchone()[0]

    # 写入对话日志 (跳过重复)
    pg_cur.execute('''
      INSERT INTO conversation_logs (user_id, wechat_id, role, content, created_at)
      VALUES (%s, %s, %s, %s, %s)
      ON CONFLICT DO NOTHING
    ''', (user_id, wechat_id, role_mapped, content, ts))

    if pg_cur.rowcount > 0:
        synced += 1

# 更新游标
new_cursor = msgs[-1][2] if msgs else last_ts
pg_cur.execute('''
  INSERT INTO system_config (key, value) VALUES ('hermes_sync_cursor', %s)
  ON CONFLICT (key) DO UPDATE SET value = %s
''', (str(new_cursor), str(new_cursor)))

pg.commit()
print(f'Synced: {synced} new messages (cursor: {new_cursor})')

pg_cur.close()
pg.close()
sqlite.close()
" 2>&1
}

case "${1:-loop}" in
  --once)
    sync_once
    ;;
  *)
    echo "[sync] Starting Hermes → PostgreSQL sync (every 10s)"
    while true; do
      sync_once
      sleep 10
    done
    ;;
esac
