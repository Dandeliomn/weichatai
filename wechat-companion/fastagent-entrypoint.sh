#!/bin/sh
# FastAgent entrypoint: captures JSONL output to a log file
# We'll check the format of incoming messages, then add webhook forwarding

WEBHOOK_URL="http://api-server:3000/webhook"
LOGFILE="/app/data/messages.jsonl"

echo "[entry] Starting FastAgent - logging to $LOGFILE"

fastagent --channel weixin --output jsonl --config /app/config/config.json 2>&1 | tee -a "$LOGFILE"
