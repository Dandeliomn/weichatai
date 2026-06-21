#!/bin/sh
# Custom entrypoint: runs WeClawBot-API server + bot monitor
# The bot monitor captures incoming messages and forwards to webhook

# Start the API server in background
/app/weclawbot-api -port 26322 &
API_PID=$!
echo "[entry] API server PID: $API_PID"

# Wait for API server to be ready
sleep 2

# Start bot in background mode, piping output to a log file
# We use 'script' to create a pseudo-TTY so bot thinks it's interactive
echo "[entry] Starting bot monitor..."
(while true; do
  bot -port 26322 2>&1 | while read -r line; do
    echo "[bot] $line"
    # Detect incoming text messages and forward to webhook
    if echo "$line" | grep -q '"MsgType"'; then
      PAYLOAD=$(echo "$line" | sed 's/.*\({.*}\).*/\1/')
      echo "[entry] Forwarding: $PAYLOAD"
      wget -q -O- --post-data="$PAYLOAD" \
        --header="Content-Type: application/json" \
        http://api-server:3000/webhook 2>/dev/null || true
    fi
  done
  sleep 1
done) &
BOT_PID=$!
echo "[entry] Bot monitor PID: $BOT_PID"

# Trap signals to clean up
cleanup() {
  echo "[entry] Shutting down..."
  kill $BOT_PID 2>/dev/null
  kill $API_PID 2>/dev/null
  exit 0
}
trap cleanup TERM INT

# Wait for API server
wait $API_PID
