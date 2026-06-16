#!/bin/sh
# Bridge: reads WeClawBot-API bot output, forwards incoming messages to webhook
# Run: ./bridge-webhook.sh

WEBHOOK_URL="http://api-server:3000/webhook"

# Use the bot process to capture incoming messages
# The bot CLI outputs messages to stdout when running interactively
# We pipe it through a loop that detects incoming text messages and POSTs them

echo "Starting message bridge..."

# Run bot, capture its output line by line
/app/weclawbot-api 2>&1 | while IFS= read -r line; do
  echo "[bridge] $line"

  # Detect incoming text messages (format varies, try to extract JSON)
  if echo "$line" | grep -q '"MsgType"'; then
    echo "$line" | grep -o '{.*}' | while read -r json; do
      if echo "$json" | grep -q '"FromUserName"'; then
        echo "[bridge] Forwarding message to webhook..."
        curl -s -X POST "$WEBHOOK_URL" \
          -H 'Content-Type: application/json' \
          -d "$json" > /dev/null 2>&1
        echo "[bridge] Forwarded OK"
      fi
    done
  fi
done
