"""
Gateway → SQLite 消息桥接钩子

将 Hermes Gateway 收到的消息写入 conversations.db，
供 hermes-st-relay.js 轮询并转发到 SillyTavern。

事件:
  agent:start — 用户消息到达时写入 (role=user)
  agent:end   — Agent 回复完成时写入 (role=assistant)

注意: hook 上下文中 message/response 最多 500 字符 (Hermes 限制)
"""

import sqlite3
import os
import sys
import time

DB_PATH = os.path.expanduser("~/.hermes/data/conversations.db")

def ensure_db():
    """确保数据库和表存在"""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            created_at REAL DEFAULT (strftime('%s', 'now'))
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)")
    conn.commit()
    conn.close()

def handle(event_type, context):
    """
    Hermes Hook 入口点。

    context (agent:start):
      { platform, user_id, chat_id, session_id, message }
    context (agent:end):
      { platform, user_id, chat_id, session_id, message, response }
    """
    try:
        ensure_db()

        platform = context.get("platform", "unknown")
        chat_id = context.get("chat_id", "")
        user_id = context.get("user_id", "")
        session_id = context.get("session_id", "")

        # 构建 conversation_id (与 relay 期望一致)
        conv_id = chat_id or f"{platform}:{user_id}"

        conn = sqlite3.connect(DB_PATH)

        if event_type == "agent:start":
            message = context.get("message", "")
            if not message or not message.strip():
                conn.close()
                return

            conn.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at)"
                " VALUES (?, 'user', ?, ?)",
                (conv_id, message, time.time())
            )
            conn.commit()
            print(f"[gateway-sqlite-sync] 📩 user message → {conv_id}", flush=True)

        elif event_type == "agent:end":
            response = context.get("response", "")
            if not response or not response.strip():
                conn.close()
                return

            conn.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at)"
                " VALUES (?, 'assistant', ?, ?)",
                (conv_id, response, time.time())
            )
            conn.commit()
            print(f"[gateway-sqlite-sync] 💬 assistant reply → {conv_id}", flush=True)

        conn.close()

    except Exception as e:
        print(f"[gateway-sqlite-sync] ❌ Error: {e}", file=sys.stderr, flush=True)
