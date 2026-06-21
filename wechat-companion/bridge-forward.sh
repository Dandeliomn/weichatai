#!/bin/sh
# =============================================================================
# WeClaw Bridge Forwarder (Busybox 兼容版)
# 1. 启动 WeClawBot-API 后台
# 2. 提取 api_token 用于认证
# 3. 运行 bot CLI (docker tty:true 提供 PTY)
# 4. 提取 QR 码到共享卷 (纯POSIX/awk实现)
# 5. 安全转发消息到 api-server webhook (用临时文件防注入)
# =============================================================================

QR_DIR="${QR_DIR:-/tmp/qr_share}"
mkdir -p "$QR_DIR"

CONFIG_DIR="/app/config"
AUTH_FILE="$CONFIG_DIR/auth.json"
API_PORT=26322
WEBHOOK_URL="${WEBHOOK_URL:-http://api-server:3000/webhook}"
LOG_FILE="/tmp/bot-stdout.log"
QR_FILE="$QR_DIR/qr.txt"

# ---- 提取 api_token (纯POSIX sed, 不依赖grep -o) ----
extract_api_token() {
  if [ -f "$AUTH_FILE" ]; then
    # 优先提取 api_token (不是 bot_token!)
    TOKEN=$(sed -n 's/.*"api_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$AUTH_FILE" | head -1)
    if [ -z "$TOKEN" ]; then
      TOKEN=$(sed -n 's/.*"bot_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$AUTH_FILE" | head -1)
    fi
    if [ -n "$TOKEN" ]; then
      export WECLAW_API_TOKEN="$TOKEN"
      echo "[bridge] api_token: ${TOKEN:0:8}..."
    else
      echo "[bridge] WARNING: 未能从 auth.json 提取 token"
    fi
  else
    echo "[bridge] WARNING: auth.json 不存在，等待 API 生成..."
  fi
}

# ---- QR 码轮询 (保持 /login 长连接，120s 超时) ----
qr_poller() {
  LOGIN_PID=""
  LAST_REFRESH=0

  # 清理旧的 login 进程
  cleanup_login() {
    if [ -n "$LOGIN_PID" ] && kill -0 "$LOGIN_PID" 2>/dev/null; then
      kill "$LOGIN_PID" 2>/dev/null
    fi
    LOGIN_PID=""
  }

  # 启动持久 /login 进程 (保持120s，确保用户有时间扫码)
  start_login() {
    cleanup_login
    echo "[bridge] Starting /login process (120s timeout)..."
    (
      echo "/login"
      sleep 120
      echo "exit"
    ) | /usr/local/bin/bot -port $API_PORT 2>&1 | while IFS= read -r line; do
      echo "$line" >> "$LOG_FILE"
      # 检测登录成功
      case "$line" in
        *"Login successful"*|*"logged in"*|*"Bot:"*"| Message from"*)
          echo "[bridge] Login activity detected: ${line:0:80}"
          ;;
      esac
    done &
    LOGIN_PID=$!
    echo "[bridge] Login process PID: $LOGIN_PID"

    # 等待 QR 码出现
    for i in $(seq 1 10); do
      sleep 1
      if [ -f "$LOG_FILE" ] && grep -q '█' "$LOG_FILE" 2>/dev/null; then
        break
      fi
    done
  }

  # 从日志提取 QR 并保存
  extract_qr() {
    awk '
      /[█▀]/ { block = block $0 "\n"; in_block = 1; next }
      in_block { if (block != "") { last_block = block }; block = ""; in_block = 0 }
      END { if (in_block && block != "") print block; else if (last_block != "") print last_block }
    ' "$LOG_FILE" 2>/dev/null
  }

  # 首次启动
  start_login
  LAST_REFRESH=$(date +%s)

  while true; do
    sleep 3
    NOW=$(date +%s)

    # 检查 login 进程是否还活着
    if [ -z "$LOGIN_PID" ] || ! kill -0 "$LOGIN_PID" 2>/dev/null; then
      echo "[bridge] Login process died, restarting..."
      start_login
      LAST_REFRESH=$NOW
      continue
    fi

    # 检查是否有新 Bot 被注册 (登录成功)
    if [ -f "$AUTH_FILE" ]; then
      BOT_COUNT=$(grep -c '"bot_id"' "$AUTH_FILE" 2>/dev/null || echo "0")
    fi

    # 提取 QR 到文件
    QR_BLOCK=$(extract_qr)
    if [ -n "$QR_BLOCK" ]; then
      NEW_HASH=$(echo "$QR_BLOCK" | md5sum | cut -d' ' -f1)
      if [ "$NEW_HASH" != "$LAST_QR_HASH" ]; then
        echo "$QR_BLOCK" > "$QR_FILE"
        LAST_QR_HASH="$NEW_HASH"
        echo "[bridge] QR updated -> $QR_FILE ($(wc -c < "$QR_FILE") bytes)"
      fi
    fi

    # QR 超过 90 秒刷新
    if [ $((NOW - LAST_REFRESH)) -gt 90 ] 2>/dev/null; then
      echo "[bridge] QR >90s, restarting login..."
      start_login
      LAST_REFRESH=$NOW
    fi
  done
}

# 启动后台QR轮询
qr_poller &
QR_POLL_PID=$!
echo "[bridge] QR poller PID: $QR_POLL_PID (3s interval)"

# ---- 安全转发消息 (用临时文件避免shell注入) ----
forward_message() {
  FROM="$1"
  CONTENT="$2"
  TIMESTAMP=$(date +%s)
  MSG_ID="${FROM}_${TIMESTAMP}"

  # 用 printf 写入临时文件，避免 shell 变量展开中的注入风险
  TMPFILE=$(mktemp /tmp/webhook-XXXXXX)
  printf '{"FromUserName":"%s","MsgType":"text","Content":"%s","CreateTime":%s,"MsgId":"%s"}' \
    "$FROM" "$CONTENT" "$TIMESTAMP" "$MSG_ID" > "$TMPFILE"

  wget -q -O /dev/null --post-file="$TMPFILE" \
    --header="Content-Type: application/json" \
    "$WEBHOOK_URL" 2>/dev/null && echo "OK" || echo "FAIL"

  rm -f "$TMPFILE"
}

# ---- 启动 API 服务器 ----
echo "[bridge] Starting WeClawBot-API on port $API_PORT..."
/app/weclawbot-api -port $API_PORT &
API_PID=$!
echo "[bridge] API PID: $API_PID"
sleep 2

# 等待 auth.json 生成 (最多30秒)
for i in $(seq 1 15); do
  if [ -f "$AUTH_FILE" ]; then break; fi
  sleep 2
done
extract_api_token

# ---- 运行 bot monitor ----
echo "[bridge] Starting bot CLI..."
echo "[bridge] Webhook: $WEBHOOK_URL"

(
  while true; do
    unbuffer bot -port $API_PORT 2>&1
    echo "[bridge] Bot exited, restarting in 3s..."
    sleep 3
  done
) | while IFS= read -r line; do
  echo "$line"
  echo "$line" >> "$LOG_FILE"

  case "$line" in
    *"█"*)
      # QR 码由后台 qr_poller 自动提取，无需行内处理
      ;;
    *"MsgType"*|*"Message from"*)
      echo "[bridge] 📩 Message detected"
      FROM=$(echo "$line" | sed -n 's/.*from[[:space:]]*\([^:]*\).*/\1/p')
      CONTENT=$(echo "$line" | sed 's/.*: //')
      if [ -n "$FROM" ] && [ -n "$CONTENT" ]; then
        forward_message "$FROM" "$CONTENT"
      fi
      ;;
  esac
done &

MONITOR_PID=$!
echo "[bridge] Monitor PID: $MONITOR_PID"

# 信号处理
cleanup() {
  echo "[bridge] Shutting down..."
  kill $MONITOR_PID 2>/dev/null
  kill $API_PID 2>/dev/null
  exit 0
}
trap cleanup TERM INT QUIT

# ---- Bot 自动注册 + 自动清理已删除 session (每10秒轮询) ----
bot_registrar() {
  while true; do
    sleep 10
    # 获取 bot 列表（含索引），格式： "N) [ ] BotID: xxx@im.bot"
    BOTS_WITH_INDEX=$(echo "/bots" | timeout 8 /usr/local/bin/bot -port $API_PORT 2>/dev/null \
      | grep -oE '^\s*[0-9]+\)\s+.*BotID:\s+\S+' || true)

    if [ -n "$BOTS_WITH_INDEX" ]; then
      TOKEN=""
      if [ -f "$AUTH_FILE" ]; then
        TOKEN=$(sed -n 's/.*"api_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$AUTH_FILE" | head -1)
      fi
      echo "[registrar] Found $(echo "$BOTS_WITH_INDEX" | wc -l) bot(s)"

      echo "$BOTS_WITH_INDEX" | while IFS= read -r LINE; do
        # 提取索引 和 BotID
        BOT_INDEX=$(echo "$LINE" | sed -n 's/^\s*\([0-9]\+\).*/\1/p')
        REG_BOT=$(echo "$LINE" | sed -n 's/.*BotID:\s*\([a-zA-Z0-9@._-]*\).*/\1/p')
        [ -z "$BOT_INDEX" ] || [ -z "$REG_BOT" ] && continue

        # 从 auth.json 提取该 bot 的 iLink 凭证
        BOT_TOKEN=$(sed -n "/$REG_BOT/,/^  }/p" "$AUTH_FILE" 2>/dev/null | sed -n 's/.*"bot_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
        GET_UPDATES_BUF=$(sed -n "/$REG_BOT/,/^  }/p" "$AUTH_FILE" 2>/dev/null | sed -n 's/.*"get_updates_buf"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
        ILINK_USER_ID=$(sed -n "/$REG_BOT/,/^  }/p" "$AUTH_FILE" 2>/dev/null | sed -n 's/.*"ilink_user_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
        API_TOKEN=$(sed -n "/$REG_BOT/,/^  }/p" "$AUTH_FILE" 2>/dev/null | sed -n 's/.*"api_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)

        PAYLOAD="{\"botId\":\"$REG_BOT\",\"apiToken\":\"${API_TOKEN:-auto}\""
        [ -n "$BOT_TOKEN" ] && PAYLOAD="$PAYLOAD,\"botToken\":\"$BOT_TOKEN\""
        [ -n "$GET_UPDATES_BUF" ] && PAYLOAD="$PAYLOAD,\"getUpdatesBuf\":\"$GET_UPDATES_BUF\""
        [ -n "$ILINK_USER_ID" ] && PAYLOAD="$PAYLOAD,\"ilinkUserId\":\"$ILINK_USER_ID\""
        PAYLOAD="$PAYLOAD}"

        RESULT=$(wget -q -O- --post-data="$PAYLOAD" \
          --header="Content-Type: application/json" \
          "http://api-server:3000/api/bridge/register-bot" 2>&1 || echo "FAIL")

        case "$RESULT" in
          *'"ok":false'*|*'"ok": false'*)
            echo "[registrar] ⏭️  $REG_BOT (index=$BOT_INDEX) 被拒绝: $RESULT"
            # 自动从 weclawbot-api 断开被删除的 session
            echo "/del $BOT_INDEX" | timeout 5 /usr/local/bin/bot -port $API_PORT 2>/dev/null
            echo "[registrar] 🔌 已从 weclaw-bridge 断开 session #$BOT_INDEX"
            ;;
          *)
            echo "[registrar] $REG_BOT -> $RESULT"
            ;;
        esac
      done
    fi
  done
}

bot_registrar &
BOT_REG_PID=$!
echo "[bridge] Bot registrar PID: $BOT_REG_PID (10s interval)"

# update cleanup to include new PIDs
cleanup() {
  echo "[bridge] Shutting down..."
  kill $MONITOR_PID 2>/dev/null
  kill $BOT_REG_PID 2>/dev/null
  kill $QR_POLL_PID 2>/dev/null
  kill $API_PID 2>/dev/null
  exit 0
}

wait $API_PID
