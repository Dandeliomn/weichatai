# =============================================================================
# 微信情感陪伴AI服务 - Dockerfile
# 多阶段构建: 第一阶段编译TypeScript, 第二阶段运行Node.js应用
# =============================================================================

# ----- 阶段1: 构建 -----
FROM node:20-alpine AS builder

WORKDIR /app

# 安装编译工具（better-sqlite3 需要 python3/make/gcc）
RUN apk add --no-cache python3 make gcc g++

# 复制依赖文件
COPY package.json package-lock.json* ./

# 安装全部依赖（含devDependencies用于编译）
RUN npm ci --include=dev 2>/dev/null || npm install

# 复制源代码
COPY tsconfig.json ./
COPY src/ ./src/

# 编译TypeScript
RUN npm run build

# 清理devDependencies，只保留生产依赖
RUN npm prune --production

# ----- 阶段2: 运行 -----
FROM node:20-alpine

# 安装必要的系统工具（含 unzip 处理中文编码）
RUN apk add --no-cache \
    curl \
    tini \
    unzip \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# 创建非root用户
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# 从构建阶段复制文件
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# 复制配置文件和脚本
COPY config.json ./
COPY scripts/ ./scripts/

# 创建数据和上传目录
RUN mkdir -p /app/data /app/uploads /app/stickers && chown -R appuser:appgroup /app

# 切换到非root用户
USER appuser

# 暴露端口
EXPOSE 3000

# 使用tini作为init进程
ENTRYPOINT ["/sbin/tini", "--"]

# 默认启动主服务
CMD ["node", "dist/index.js"]
