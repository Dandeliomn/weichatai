# 💬 微信情感陪伴AI服务

基于 **WeClaw + DeepSeek + PostgreSQL + Redis + BullMQ** 构建的个人微信情感陪伴AI服务。

支持多用户并行、会话隔离、长期记忆、情绪识别、主动关怀，Docker Compose 一键部署。

## 🏗️ 架构概览

```
微信用户 → WeClaw桥接 → Express API → BullMQ队列 → Worker → DeepSeek API
                                      ↓                          ↓
                                   Redis短期记忆          PostgreSQL长期记忆
                                      ↓
                                 主动关怀定时任务 (8:00/13:00/20:00)
```

### 服务组件 (5个Docker容器)

| 服务 | 说明 | 端口 |
|------|------|------|
| `weclaw-bridge` | WeChat 桥接层，处理扫码登录和消息收发 | 26322 |
| `api-server` | Express API 服务器，接收webhook并入队 | 3000 |
| `bull-worker` | BullMQ Worker，异步处理消息生成回复 | - |
| `care-scheduler` | 主动关怀定时任务 | - |
| `redis` | 短期记忆存储 + 消息队列后端 | 6379 |
| `postgres` | 长期记忆持久化存储 | 5432 |

## 📋 服务器要求

| 项目 | 最低配置 | 推荐配置 |
|------|---------|---------|
| 操作系统 | Ubuntu 20.04+ | Ubuntu 22.04 |
| CPU | 2 核 | 4 核+ |
| 内存 | 4 GB | 8 GB |
| 磁盘 | 20 GB | 50 GB+ (SSD) |
| 网络 | 可访问外网 | 稳定带宽 |

## 🚀 快速部署

### 1. 克隆项目

```bash
# 将所有文件放入项目目录
mkdir wechat-companion && cd wechat-companion
# 复制所有项目文件到此目录
```

### 2. 一键部署

```bash
chmod +x deploy.sh
./deploy.sh
```

部署脚本会自动完成：
- ✅ 检查系统要求 (CPU/内存/磁盘)
- ✅ 安装 Docker 和 Docker Compose (如未安装)
- ✅ 配置环境变量 (交互式)
- ✅ 构建镜像并启动所有服务
- ✅ 等待服务就绪
- ✅ 引导微信扫码登录

### 3. 手动部署

如果不想使用自动脚本：

```bash
# 1. 安装 Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# 2. 配置环境变量
cp .env.example .env
nano .env  # 编辑配置，至少填写 DEEPSEEK_API_KEY

# 3. 启动服务
docker compose up -d

# 4. 查看日志
docker compose logs -f
```

## ⚙️ 配置说明

### 环境变量 (.env)

```bash
# ----- 必填 -----
DEEPSEEK_API_KEY=sk-xxxxxxxx          # DeepSeek API Key
DEEPSEEK_MODEL=deepseek-chat          # 模型名称

# ----- 数据库 (Docker内部使用，一般无需修改) -----
POSTGRES_USER=weclaw
POSTGRES_PASSWORD=weclaw_secret       # 生产环境请修改
POSTGRES_DB=weclaw_companion

# ----- WeClaw (扫码登录后获取) -----
WECLAW_BOT_ID=your-bot-id            # /bots 命令获取
WECLAW_API_TOKEN=your-api-token      # /bots 命令获取

# ----- 可选配置 -----
WORKER_CONCURRENCY=10                 # Worker 并发数
SHORT_MEMORY_MAX_ROUNDS=10           # 短期记忆轮数
SHORT_MEMORY_TTL=86400               # 短期记忆过期(秒)
```

### WeClaw Agent 配置 (config.json)

```json
{
  "agents": {
    "companion": {
      "channel": "weixin",
      "webhook": {
        "url": "http://api-server:3000/webhook",
        "method": "POST"
      }
    }
  }
}
```

## 📱 微信扫码登录

### 单个微信号

```bash
# 进入 WeClaw 桥接容器
docker compose exec weclaw-bridge bot

# 在终端中操作:
/login          # 发起扫码登录 → 用微信扫描二维码
/bots           # 查看 Bot ID 和 API Token
```

获取到 Bot ID 和 API Token 后，填入 `.env` 文件并重启：

```bash
# 编辑 .env
nano .env
# 设置: WECLAW_BOT_ID=xxx@im.bot
# 设置: WECLAW_API_TOKEN=xxx

# 重启服务
docker compose restart api-server bull-worker
```

### 多个微信号

如需同时管理多个微信账号：

```bash
docker compose exec weclaw-bridge bot

# 第1个账号
/login          # 扫码登录第1个微信
/bots           # 记录 Bot ID 和 Token

# 第2个账号
/login          # 扫码登录第2个微信
/bots           # 查看所有账号

# 切换活跃发送身份
/bot 0          # 切换到第1个账号
/bot 1          # 切换到第2个账号
```

每个 Bot ID 可独立配置到不同服务实例中。

## 📊 监控和管理

### 查看服务状态

```bash
docker compose ps
```

### 查看实时日志

```bash
# 所有服务
docker compose logs -f

# 特定服务
docker compose logs -f api-server
docker compose logs -f bull-worker
docker compose logs -f care-scheduler
```

### 健康检查

```bash
# API 服务
curl http://localhost:3000/health

# 队列统计
curl http://localhost:3000/stats
```

### 数据库直连

```bash
# PostgreSQL
docker compose exec postgres psql -U weclaw -d weclaw_companion

# 常用查询:
SELECT COUNT(*) FROM users;                          -- 用户总数
SELECT COUNT(*) FROM conversation_logs;              -- 对话总数
SELECT * FROM users ORDER BY last_active_at DESC LIMIT 10;  -- 最近活跃用户
SELECT * FROM user_memories WHERE user_id=1;          -- 用户记忆
```

### Redis 监控

```bash
docker compose exec redis redis-cli

# 常用命令:
INFO stats        # 统计信息
DBSIZE            # Key 数量
KEYS short:*      # 查看所有短期记忆 Key
LLEN short:memory:xxx  # 某个用户的记忆条数
```

## 🔧 故障处理

### 常见问题

#### 1. 封号风险

个人微信使用机器人存在封号风险，建议：
- ✅ 使用小号/备用微信
- ✅ 控制消息发送频率 (已在代码中做延迟处理)
- ✅ 主动关怀随机延迟 1-5 秒
- ✅ 不要发送营销/广告内容
- ✅ 单日消息量控制在 1000 条以内
- ❌ 不要群发消息
- ❌ 不要频繁添加好友

#### 2. 队列积压

```bash
# 查看队列状态
curl http://localhost:3000/stats

# 如果 waiting 数量持续增长:
# 方案1: 增加 Worker 并发数 (.env 中设置 WORKER_CONCURRENCY=20)
# 方案2: 增加 Worker 实例
docker compose up -d --scale bull-worker=3

# 清空队列 (紧急情况)
docker compose exec redis redis-cli FLUSHDB
```

#### 3. 数据库连接失败

```bash
# 检查 PostgreSQL 状态
docker compose logs postgres

# 重启数据库
docker compose restart postgres

# 重置数据库 (⚠️ 会删除所有数据)
docker compose down -v postgres
docker compose up -d postgres
```

#### 4. DeepSeek API 错误

- `401 Unauthorized` → API Key 无效，检查 `.env` 中的 `DEEPSEEK_API_KEY`
- `429 Too Many Requests` → 请求频率过高，降低 `WORKER_CONCURRENCY`
- `503 Service Unavailable` → DeepSeek 服务繁忙，消息会自动重试

#### 5. WeClaw 扫码登录问题

```bash
# 重新扫码
docker compose exec weclaw-bridge bot
# 在终端输入: /login

# 查看已登录状态
# 输入: /bots

# 如果扫码后无响应，重启桥接服务
docker compose restart weclaw-bridge
```

### 数据备份

```bash
# 备份 PostgreSQL 数据
docker compose exec postgres pg_dump -U weclaw weclaw_companion > backup_$(date +%Y%m%d).sql

# 恢复
docker compose exec -T postgres psql -U weclaw weclaw_companion < backup_20260101.sql

# 备份 Redis 数据
docker compose exec redis redis-cli BGSAVE
docker compose cp redis:/data/dump.rdb ./redis_backup.rdb
```

## 📁 项目文件结构

```
wechat-companion/
├── .env.example              # 环境变量模板
├── config.json               # WeClaw Agent 配置
├── deploy.sh                 # 一键部署脚本
├── docker-compose.yml        # Docker Compose 编排
├── Dockerfile                # 主服务镜像构建
├── package.json              # Node.js 依赖
├── tsconfig.json             # TypeScript 配置
├── README.md                 # 部署说明
├── scripts/
│   └── init-db.sql           # PostgreSQL 初始化脚本
└── src/
    ├── index.ts              # Express 主服务入口
    ├── worker.ts             # BullMQ Worker
    ├── memory/
    │   ├── short.ts          # 短期记忆 (Redis)
    │   └── long.ts           # 长期记忆 (PostgreSQL)
    ├── emotion/
    │   └── analyzer.ts       # 情绪分析模块
    ├── care/
    │   └── scheduler.ts      # 主动关怀定时任务
    └── utils/
        └── weclawClient.ts   # WeClaw HTTP 客户端
```

## 🛠️ 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 微信桥接 | WeClawBot-API / @fastagent/cli | 微信扫码登录、消息收发 |
| 后端框架 | Express + TypeScript | HTTP API 服务 |
| 消息队列 | BullMQ + Redis | 异步任务处理 |
| 短期记忆 | Redis List | 24h TTL, 最近10轮对话 |
| 长期记忆 | PostgreSQL | 用户表、记忆表、对话日志 |
| AI 模型 | DeepSeek API | 对话生成、记忆摘要 |
| 情绪分析 | 规则引擎 (自研) | 4种情绪 + 中性 |
| 定时任务 | node-cron | 主动关怀 |
| 部署 | Docker Compose | 6个容器，一键部署 |

## ⚡ 性能指标

- 支持同时 1000+ 活跃用户
- 单台 4核8GB 服务器稳定运行
- Redis 内存限制: 512MB
- Worker 并发: 10 (可调整)
- 单条消息处理延迟: 1-5 秒

## 📝 开发

```bash
# 安装依赖
npm install

# 开发模式运行
npm run dev          # API 服务
npm run worker:dev   # Worker
npm run scheduler:dev # 定时任务

# 构建
npm run build
```

## 📄 许可证

MIT License
