# 更新日志

## v2.2 — 2026-06-24

### 🆕 新功能

#### SillyTavern 角色引擎：ChatBridge → HTTP REST 直连
- **彻底移除 ChatBridge WebSocket 依赖**
  - 之前：relay 启动 WebSocket Server → 等待 ChatBridge 客户端连接 → 通过 WebSocket 收发消息 — 需要浏览器/伪终端环境
  - 现在：relay 直接用 HTTP POST 调用 SillyTavern REST API (`/api/chat/send`)，零外部依赖
- **SSE 流式响应解析器**
  - 内建 SSE (Server-Sent Events) 解析器，支持 token/final/stream_end 多种事件格式
  - 双层缓冲区设计：bufferLines[] 按行收集 → 统一解析，解决跨数据包的 data: 前缀割裂问题
  - 兼容 ST 的 token 流式输出和一次性返回两种模式
- **稳定性和错误恢复**
  - 两端 HTTP res.on('error') 处理器：ST API 中断时 reject，iLink 降级 resolve(null)
  - 60s 请求超时自动销毁
  - 10 次连续失败后重置而非退出的守护模式
  - SQLite 连接健康检查 + 自动重建

#### hersona → 角色卡自动生成
- **新增 scripts/generate-charcard.js**
  - 读取 active_persona.json（由 set-persona.js 写入），自动解析 hersona 属性 YAML
  - 组合多维度属性（性格/原型/说话风格/视觉/爱好 → 5类84种），生成 SillyTavern 标准角色卡
  - 内置最小化 PNG 编码器（80x80 纯色头像，颜色随人格标签自动匹配）+ CRC32 校验
  - 角色卡 JSON 嵌入 PNG 末尾，符合 SillyTavern ccv3 规范，可直接在 UI 中导入
  - 自动生成内容：system prompt（核心性格+语气+口头禅）、示例对话、场景设定、描述
- **数据模型统一**
  - relay (loadActivePersona) + charcard 生成器 + set-persona CLI 统一使用 attributes 数组格式
  - relay 新增 buildCombinedPersonaPrompt()，支持多属性组合注入
  - 旧格式 { current, path } 保留降级兼容

#### DEV_MODE 安全开关
- **新增 DEV_MODE=true 环境变量保护机制**
  - 开启后 relay 跳过所有 LLM 调用，返回模拟回复
  - 防止开发和调试期间误烧 DeepSeek API 额度
  - 关闭后恢复正常推理流程

#### SillyTavern Docker 化
- docker-compose.yml 新增 sillytavern 服务 (ghcr.io/sillytavern/sillytavern:latest)
- 端口 8000，HTTP REST 直连模式
- st-data 持久化卷，存储角色卡和聊天历史
- 配置文件模板 st-config.yaml（API Key 鉴权 + Web UI 登录）

#### 世界书系统
- 新增世界书文件监控 (startWorldBookWatcher + loadWorldBooks)
- 新增 getWorldBookMatches() 关键词匹配，结果注入 system prompt 的 【世界书设定】区块

### 🛡️ 安全修复

| # | 问题 | 修复 |
|---|------|------|
| 1 | HTTP 响应流缺少 error 处理器 → Promise 永久挂起导致 relay 卡死 | 两端 res.on('error'): ST API reject，iLink resolve(null) |
| 2 | SSE end 事件直接 JSON.parse 未剥离 data: 前缀 → 最后一帧 token 丢失 | 改用 bufferLines[] 按行收集 → 统一解析 |
| 3 | --name 参数路径穿越 (generate-charcard.js) | 新增 sanitizeName() 过滤特殊字符 |
| 4 | attr.category / attr.name 路径穿越 | 新增 safeAttrPath() + path.basename 白名单 |
| 5 | 默认 DATABASE_URL 硬编码凭据 | 改为 null，未配置时禁用 PG 同步 |
| 6 | relay health check 中 database 未定义 → 健康检查永不触发 | database → db |
| 7 | 开发时无额度保护 → 误烧 DeepSeek 余额 | 新增 DEV_MODE 安全开关 |

### 🐛 Bug 修复

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | relay loadActivePersona() 与 set-persona.js 数据格式不兼容 | relay 期望 { current, path }，set-persona 写入 { attributes: [...] } | relay 新增 attributes 数组解析路径，旧格式降级兼容 |
| 2 | 世界书完整加载但从不注入 prompt | processMessage 中未引用 worldBookCache | 新增 getWorldBookMatches()，匹配结果注入 prompt |
| 3 | generate-charcard.js 手写 YAML 解析器含 4 个 bug | 数组多行覆盖、连字符 key 不支持、inline array 不解析、多行丢 array 上下文 | 替换为 js-yaml（与 relay 一致） |
| 4 | fs.watch 缺 error 事件 → 静默失效 | 未注册 error 监听器 | 添加 .on('error') + 清理 watcher |
| 5 | getPG() 首次失败后永不重试 | pgPool 缓存 null 后不清除 | 连接失效时自动清除缓存，下次重建 |
| 6 | PostgreSQL 连接断开后恢复不了 | syncToPG 只写一个 warn | 新增连接失效检测 + 自动重建逻辑 |

### 🔧 重构

- scripts/hermes-st-relay.js: 全量重写，WebSocket Server → HTTP REST Client
- scripts/generate-charcard.js: 全量新写，hersona → ST charcard PNG 生成器
- docker-compose.yml: 新增 sillytavern 服务，st_data 卷
- .env.example: 新增 DEV_MODE / ST_* / HERMES_* / PERSONA_* 等环境变量
- st-config.yaml: 新文件，SillyTavern 配置模板

### 📦 新增依赖

- js-yaml — YAML 解析（供 generate-charcard.js 使用）
- better-sqlite3 — Hermes SQLite 轮询（供 relay 使用）

### 📁 变更清单

| 文件 | 变化 | 说明 |
|------|------|------|
| scripts/hermes-st-relay.js | 全量重写 | WebSocket → HTTP REST，新增 SSE/ChatBridge/世界书/DEV_MODE |
| scripts/generate-charcard.js | 新建 | hersona 人格 → ST 角色卡 PNG 自动生成 |
| docker-compose.yml | 修改 | 新增 sillytavern 服务 |
| .env.example | 修改 | 新增 DEV_MODE/ST/HERMES/PERSONA 等变量 |
| st-config.yaml | 新建 | SillyTavern 配置模板 |
| CHANGELOG.md | 修改 | 新增 v2.2 日志 |

### ⚠️ 已知问题

1. git 历史仍有旧 .env 凭据 — 需运行 git filter-repo
2. st-config.yaml 中的 apiKey 需用户在 ST Web UI 生成后填入 .env
3. generate-charcard.js 依赖 js-yaml（npm install js-yaml 后使用）

---

## v2.1 — 2026-06-09

### 🔄 架构优化

#### relay + sync + worldbook 三合一
- 之前：3 个独立的 systemd 服务
  - hermes-st-relay.js — WebSocket 消息中继
  - sync-hermes-conversations.js — PG 同步
  - st-worldbook-autolink.js — 世界书自动链接
- 现在：1 个合并的 hermes-st-relay.js

#### 废弃服务移除
- 移除 minio 对象存储（保留接口，代码有本地文件系统回退）
- 移除 fastagent 服务（OpeniLink 已取代）
- 移除 weclaw-bridge 引用（Hermes Gateway 直接接管微信桥接）

#### 安全加固
- .env 真实凭据清除 → .env.example 模板化
- SQL 注入修复: execSync → pg Pool 参数化查询
- SQL 注入修复: SQLite 游标使用参数化 ? 占位符
- Docker socket 安全警告添加到 docker-compose.yml
- import 语句移到文件顶部（ESLint 规范）

#### SillyTavern 集成初版
- ChatBridge WebSocket Server (端口 8850)
- Bot 映射表：bot_accounts + character_templates PostgreSQL 查询
- 人格注入：loadActivePersona() 从 hersona YAML 构建 system prompt
- 消息路由：根据 wechat_id 映射到对应的 ST ChatBridge 客户端
- iLink 回复发送：通过 sendViaILink() 调用 iLink sendmessage API
- 记忆自进化：handleMemoryCorrection() 触发 memory-correct.js
- 关系分析：handleRelationshipAnalysis() 触发 love-analysis.js

### 🧹 废弃代码清理
- scripts/sync-hermes-conversations.js — 功能合并到 relay
- scripts/st-worldbook-autolink.js — 功能合并到 relay
- src/index.ts 中 /webhook 端点 — 无调用者（Hermes 已取代）
- 启动日志修正: /webhook → /api/hermes/webhook

### 📦 依赖变更
- 新增: ws (WebSocket Server, ChatBridge 模式)
- 无其他依赖变更

---

## v2.0 — 2026-06-08

### 🆕 新功能

#### 核心系统
- 多用户并行会话隔离 — 每个微信用户独立 session，互不干扰
- AI 角色系统 (Character Card V2) — 支持官方预置角色 + 用户自定义 + 聊天记录导入生成
- 会员系统 (四级) — 基础/高级/专业/企业，积分扣费制
- 聊天记录导入 — 支持 WeFlow HTML/JSON、EchoTrace 格式
- 主动关怀定时任务 — 每天 8:00 / 13:00 / 20:00 发送关怀消息
- 情绪分析引擎 — 基于规则的关键词匹配

#### 技术架构
- Express + TypeScript 后端
- BullMQ + Redis 异步消息队列
- PostgreSQL 长期记忆存储
- OpeniLink Hub + WeClawBot-API 双通道微信桥接
- Docker Compose 一键部署（6 个容器）
- React + Ant Design 管理后台仪表盘

#### 数据存储
- 短期记忆 — Redis List，24h TTL，最近 10 轮对话
- 长期记忆 — PostgreSQL 结构化存储
- 媒体存储 — MinIO 对象存储 + 本地文件系统

#### 安全体系
- Helmet HTTP 安全头、CORS、速率限制、SQL 注入检测、XSS 消毒
- JWT 双 Token（Access 2h + Refresh 7d）、图形验证码、邀请码注册

### 🐛 Bug 修复

#### 2026-06-08
| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | Redis allkeys-lru 被 BullMQ 警告 | BullMQ 要求 noeviction 策略 | docker-compose.yml 改为 noeviction |
| 2 | bull-worker / care-scheduler 状态 unhealthy | 继承 Dockerfile 的 HTTP 健康检查 | 改为 pgrep 进程存活检查 |
| 3 | 仪表盘登录 502 Bad Gateway | Nginx 缓存了 api-server 的旧容器 IP | 改为动态 DNS resolver |
| 4 | 管理员密码丢失 | 微信自动创建账号，密码仅通过微信消息发送 | 重置为已知密码 |
| 5 | 压缩包解压失败（中文文件名乱码） | BusyBox unzip 不支持 CP936 | 安装 Info-ZIP + -O CP936 |
| 6 | WeFlow HTML 格式解析错误 | 解析器不认识 WEFLOW_DATA | 新增 WeFlow 专用解析器 |
| 7-10 | 其他解析/UI/统计修复 | 多处小问题 | 逐个修复 |

### 📦 依赖

#### 生产依赖
express, cors, helmet, express-rate-limit, bullmq, ioredis, pg, axios, bcryptjs, jsonwebtoken, multer, cheerio, csv-parse, node-cron, uuid

#### 开发依赖
typescript, tsx, @types/express, @types/node 等

### 📁 项目结构

```
wechat-companion/
├── docker-compose.yml, Dockerfile, .env.example, package.json, tsconfig.json
├── scripts/          (init-db.sql, init-db-v2~v4.sql)
├── src/ - index.ts, worker.ts
│   ├── emotion/     (analyzer.ts)
│   ├── memory/      (short.ts, long.ts)
│   ├── care/        (scheduler.ts)
│   ├── middleware/   (auth.ts, captcha.ts, security.ts, upload.ts)
│   ├── routes/      (auth.ts, user.ts, admin.ts, characters.ts, import.ts)
│   └── modules/     (importer.ts, membership.ts, media-store.ts, minio.ts, profile-analyzer.ts)
├── dashboard/       (React + Ant Design SPA)
├── nginx.conf, deploy.sh
```
