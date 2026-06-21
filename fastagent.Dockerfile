FROM node:20-alpine
RUN npm install -g @fastagent/cli@0.8.4 && apk add --no-cache curl
RUN mkdir -p /app/data /app/config
WORKDIR /app
ENV IM_GATEWAY_ALLOW_ALL_PERMISSIONS=true
ENV IM_GATEWAY_WORKSPACE_DIR=/app/data
ENV IM_GATEWAY_DATA_DIR=/app/data
ENV IM_GATEWAY_AGENT_ID=companion
EXPOSE 18789
COPY fastagent-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
