#!/bin/bash
# hermes-entrypoint.sh - Hermes companion entrypoint
set -e

CONFIG_FILE="/app/config/config.yaml"
LOG_DIR="/app/data/logs"
mkdir -p "$LOG_DIR"

echo "[hermes] Starting entrypoint..."
echo "[hermes] HERMES_HOME=$HERMES_HOME"

# 检查是否已配置微信通道
if [ ! -f "$HERMES_HOME/.env" ]; then
    echo "[hermes] ⚠️  未检测到微信通道配置"
    echo "[hermes] 请运行: docker compose exec hermes-companion hermes gateway setup"
    echo "[hermes] 进入待机模式 (保持容器运行)..."
    tail -f /dev/null
    exit 0
fi

# 启动 webhook bridge (后台，监听 Hermes 消息日志)
echo "[hermes] Starting webhook bridge..."
node /app/scripts/webhook-bridge.js &
BRIDGE_PID=$!
echo "[hermes] Bridge PID: $BRIDGE_PID"

# 启动 Hermes gateway (前台)
echo "[hermes] Starting Hermes gateway..."
hermes gateway 2>&1 | tee -a "$LOG_DIR/gateway.log"

# 清理
kill $BRIDGE_PID 2>/dev/null || true
