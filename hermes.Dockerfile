# hermes.Dockerfile
FROM python:3.12-slim

# 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# 安装 Hermes Agent (使用清华镜像)
RUN pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
    --trusted-host pypi.tuna.tsinghua.edu.cn \
    --default-timeout=120 \
    hermes-agent aiohttp cryptography qrcode

# 工作目录
RUN mkdir -p /app/data /app/config /app/scripts
WORKDIR /app

# 环境变量
ENV HERMES_HOME=/app/data
ENV WEIXIN_DM_POLICY=open
ENV WEIXIN_GROUP_POLICY=disabled

# webhook bridge (Node.js 脚本，监听 Hermes 消息日志)
COPY scripts/hermes-webhook-bridge.js /app/scripts/webhook-bridge.js

# entrypoint
COPY hermes-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
