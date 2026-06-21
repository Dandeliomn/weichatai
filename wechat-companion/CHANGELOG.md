# 更新日志

## v2.0 — 2026-06-08

### 🆕 新功能

#### 核心系统
- **多用户并行会话隔离** — 每个微信用户独立 session，互不干扰
- **AI 角色系统 (Character Card V2)** — 支持官方预置角色 + 用户自定义 + 聊天记录导入生成
  - 6 个官方预置角色：温柔前任、毒舌死党、暖心长辈、元气女友、毒舌上司、知心姐姐
  - 微信内发送"角色列表"/"使用角色 N" 即可切换
  - 支持完全自定义 Prompt
- **会员系统 (四级)** — 基础/高级/专业/企业，积分扣费制
  - 邀请注册奖励积分 + 自动升级
- **聊天记录导入** — 支持 WeFlow HTML/JSON、EchoTrace 格式
  - 自动解压 zip/gz/tgz 压缩包
  - 提取表情包、图片到用户独立目录
  - AI 分析聊天记录生成角色画像
- **主动关怀定时任务** — 每天 8:00 / 13:00 / 20:00 发送关怀消息
  - 随机延迟 1-5 秒防微信风控
  - 已发送记录防重复
- **情绪分析引擎** — 基于规则的关键词匹配
  - 支持 4 种情绪：开心/悲伤/愤怒/焦虑 + 中性
  - 否定词检测（如"不开心"不被识别为"开心"）
  - 置信度评分 + 语气指导注入 LLM Prompt

#### 技术架构
- **Express + TypeScript** 后端
- **BullMQ + Redis** 异步消息队列
- **PostgreSQL** 长期记忆存储
- **OpeniLink Hub + WeClawBot-API** 双通道微信桥接
- **Docker Compose** 一键部署（6 个容器）
- **React + Ant Design** 管理后台仪表盘

#### 数据存储
- **短期记忆** — Redis List，24h TTL，最近 10 轮对话
- **长期记忆** — PostgreSQL 结构化存储
  - 用户表 (users)
  - 对话日志 (conversation_logs)
  - 用户记忆 (user_memories) 含关键词 + 重要性评分
  - 每日摘要 (daily_summaries)
  - 关怀消息日志 (care_message_logs)
- **媒体存储** — MinIO 对象存储 + 本地文件系统
  - 图片/语音/视频/表情包自动存储
  - SHA256 文件去重

#### 安全体系
- **Helmet** HTTP 安全头
- **CORS** 跨域配置
- **全局速率限制** 200 req/min
- **认证路由限流** 10 req/min
- **SQL 注入检测** — 关键词黑名单 + 正则模式匹配
- **XSS 消毒** — HTML 实体编码
- **输入验证** — 类型/长度/格式校验
- **JWT 双 Token** — Access Token 2h + Refresh Token 7d
- **图形验证码** — 登录失败 5 次后触发
- **邀请码注册** — 防滥用

### 🐛 Bug 修复

#### 2026-06-08
| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | Redis `allkeys-lru` 被 BullMQ 警告 | BullMQ 要求 `noeviction` 策略 | docker-compose.yml 改为 `noeviction` |
| 2 | bull-worker / care-scheduler 状态 unhealthy | 继承 Dockerfile 的 HTTP 健康检查，但没有 HTTP 端口 | 改为 `pgrep` 进程存活检查，移除 Dockerfile HEALTHCHECK |
| 3 | 仪表盘登录 502 Bad Gateway | Nginx 启动时缓存了 api-server 的旧容器 IP，重启后变地址 | 改为变量 `proxy_pass` + resolver 动态 DNS |
| 4 | 管理员密码丢失 | 微信自动创建账号，随机 10 位密码仅通过微信消息发送 | 重置为已知密码 |
| 5 | 压缩包解压失败（中文文件名乱码） | BusyBox unzip 不支持 CP936 编码 | 安装 Info-ZIP UnZip 6.00 + `-O CP936` 参数 |
| 6 | WeFlow HTML 格式解析错误 | 解析器不认识 `window.WEFLOW_DATA` 数据格式，把 CSS 属性当成发送者 | 新增 WeFlow 专用解析器 |
| 7 | AI 角色名识别为 "background" | HTML 解析器把 CSS 属性名当成发送者名 | 同 #6 |
| 8 | AI 角色名被识别为头像首字母 "O" | 对方无头像时 WeChat 显示首字母，导出数据中无真实昵称 | 从系统消息（"静静" 撤回了一条消息）中提取真实名 |
| 9 | 导入任务序号不会重置 | 删除后 ID 持续递增 | 前端用行索引替代原始 ID |
| 10 | 上传结果缺少详情 | 只返回任务ID，无文件数和表情包数 | 新增 `meta` JSONB 字段存储统计信息 |

### 📦 依赖

#### 生产依赖
- express, cors, helmet, express-rate-limit
- bullmq, ioredis
- pg (PostgreSQL)
- axios, bcryptjs
- jsonwebtoken
- multer (文件上传)
- cheerio (HTML 解析)
- csv-parse
- node-cron
- uuid

#### 开发依赖
- typescript, tsx
- @types/express, @types/node 等

### 📁 项目结构

```
wechat-companion/
├── docker-compose.yml          # Docker 编排
├── Dockerfile                  # 主服务镜像
├── .env.example                # 环境变量模板
├── package.json
├── tsconfig.json
├── scripts/
│   ├── init-db.sql             # 基础表结构
│   ├── init-db-v2.sql          # 用户认证/导入/管理后台
│   ├── init-db-v3.sql          # 媒体支持
│   └── init-db-v4.sql          # AI 角色系统
├── src/
│   ├── index.ts                # Express 主入口
│   ├── worker.ts               # BullMQ Worker
│   ├── emotion/
│   │   └── analyzer.ts         # 情绪分析引擎
│   ├── memory/
│   │   ├── short.ts            # Redis 短期记忆
│   │   └── long.ts             # PostgreSQL 长期记忆
│   ├── care/
│   │   └── scheduler.ts        # 主动关怀定时任务
│   ├── middleware/
│   │   ├── auth.ts             # JWT 认证
│   │   ├── captcha.ts          # 验证码
│   │   ├── security.ts         # XSS/SQL 注入防护
│   │   └── upload.ts           # 文件上传
│   ├── routes/
│   │   ├── auth.ts             # 登录/注册/刷新Token
│   │   ├── user.ts             # 用户 API
│   │   ├── admin.ts            # 管理后台 API
│   │   ├── characters.ts       # 角色系统 API
│   │   └── import.ts           # 聊天记录导入 API
│   ├── modules/
│   │   ├── importer.ts         # 聊天记录解析器
│   │   ├── membership.ts       # 会员系统
│   │   ├── media-store.ts      # 媒体存储
│   │   ├── minio.ts            # MinIO 客户端
│   │   └── profile-analyzer.ts # 画像分析
│   └── utils/
│       └── weclawClient.ts     # WeClaw HTTP 客户端
├── dashboard/                  # React 管理后台
│   ├── Dockerfile
│   └── src/
│       ├── pages/
│       │   ├── Login.tsx
│       │   ├── Dashboard.tsx
│       │   ├── Conversations.tsx
│       │   ├── Characters.tsx
│       │   ├── ImportChat.tsx
│       │   ├── Users.tsx
│       │   ├── Stickers.tsx
│       │   └── ...
│       └── components/
│           ├── EmotionTag.tsx
│           └── Layout.tsx
├── nginx.conf                  # Nginx 反向代理
└── deploy.sh                   # 一键部署脚本
```
