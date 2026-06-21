# 💬 微信情感陪伴 AI

基于 [Hermes Agent](https://github.com/NousResearch/hermes-agent) + DeepSeek 的微信 AI 陪伴系统，支持多 Bot、多角色、对话记录管理。

## 架构

```
微信 ←→ iLink API ←→ 宿主机 Hermes Gateway (AI引擎, 角色扮演)
                              ↕ 对话同步 (10s)
                         Docker PostgreSQL (对话记录, Bot管理)
                              ↕
                         Docker Dashboard (BridgePage 管理界面)
```

| 组件 | 位置 | 作用 |
|------|------|------|
| **Hermes Gateway** | 宿主机 systemd | 微信消息收发 + AI 回复 (DeepSeek V4 Flash) |
| **SOUL.md + ex-skill** | `~/.hermes/` | 角色人格定义 (温柔前任) |
| **api-server** | Docker | REST API + Webhook + BullMQ 队列 |
| **Dashboard** | Docker (Nginx) | Web 管理界面 (BridgePage, 角色管理, 对话浏览) |
| **PostgreSQL** | Docker | 对话记录, 用户数据, Bot 管理 |
| **Redis** | Docker | 缓存 + 消息队列 |

## 快速开始

### 依赖

- Docker & Docker Compose
- Node.js 22+
- Python 3.12+ (Hermes)
- DeepSeek API Key

### 1. 启动管理后台

```bash
docker compose up -d
```

访问 `http://localhost:8080` → 登录 → 微信桥接

### 2. 启动 AI 引擎 (宿主机 Hermes)

```bash
systemctl --user start hermes-gateway   # 微信消息处理 + AI 回复
systemctl --user start hermes-sync      # 对话同步到 PostgreSQL
```

### 3. 扫码连接

打开 BridgePage (`/bridge`) → 选择角色 → 扫描二维码 → Bot 自动连接

## 项目结构

```
├── src/                    # api-server 源码 (Express + TypeScript)
│   ├── index.ts            # 主入口, webhook 处理
│   ├── worker.ts           # BullMQ Worker, AI 调用
│   ├── routes/             # API 路由
│   │   ├── bridge.ts       # Bot 管理, iLink 轮询
│   │   ├── characters.ts   # 角色模板管理
│   │   ├── auth.ts         # 认证
│   │   └── ...
│   ├── memory/             # 短期记忆 (Redis) + 长期记忆 (PostgreSQL)
│   ├── emotion/            # 情绪分析
│   └── utils/              # WeClaw 客户端等工具
├── dashboard/              # React 前端 (Vite + Ant Design)
│   └── src/pages/
│       ├── BridgePage.tsx  # Bot 管理 (多Bot, 选角色, QR扫码)
│       ├── Characters.tsx  # 角色管理
│       └── ...
├── scripts/                # 工具脚本
│   ├── init-db*.sql        # 数据库迁移
│   ├── generate-soul.ts    # 从聊天记录生成 SOUL.md
│   ├── sync-hermes-conversations.js  # Hermes → PostgreSQL 同步
│   └── hermes-webhook-bridge.js      # Webhook 桥接
├── docker-compose.yml      # Docker 服务编排
├── nginx.conf              # Nginx 反向代理
├── bridge-forward.sh       # WeClaw Bridge 消息转发 + QR 码
└── docs/                   # 设计文档
    └── superpowers/
        ├── specs/          # 功能设计
        └── plans/          # 实施计划
```

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/bridge/bots` | GET | Bot 列表 (含角色信息, 需认证) |
| `/api/bridge/bots/:id` | DELETE | 停用/删除 Bot |
| `/api/bridge/bots/:id/character` | PUT | 更换 Bot 角色 |
| `/api/bridge/register-bot` | POST | 注册新 Bot (WeClaw 调用) |
| `/api/characters/list/mine` | GET | 我的角色列表 |
| `/webhook` | POST | 微信消息入口 (WeClaw → API) |
| `/api/hermes/webhook` | POST | Hermes 消息转发入口 |
| `/health` | GET | 健康检查 |

## 数据库

- **bot_accounts** — Bot 账号 (bot_id, token, character_id, linked_user_id)
- **character_templates** — 角色模板 (name, personality, system_prompt)
- **user_characters** — 用户激活的角色
- **conversation_logs** — 对话记录
- **user_memories** — 结构化记忆摘要
- **imported_messages** — 导入的历史聊天记录

## Hermes 配置

核心文件在 `~/.hermes/`:

| 文件 | 作用 |
|------|------|
| `config.yaml` | 模型配置 (DeepSeek V4 Flash) |
| `SOUL.md` | 角色人格定义 |
| `.env` | 微信通道凭证 (bot token) |
| `skills/` | 扩展技能 (ex_gentle_ex 等) |
| `state.db` | 对话数据库 (SQLite) |

## 常用命令

```bash
# Docker 管理
docker compose up -d                    # 启动所有服务
docker compose ps                       # 查看状态
docker compose logs -f api-server       # 查看 API 日志

# Hermes 管理
systemctl --user status hermes-gateway  # 查看 AI 引擎状态
systemctl --user restart hermes-gateway # 重启 (角色更新后需重启)
journalctl --user -u hermes-gateway -f  # 查看 Hermes 日志

# 数据库
docker exec weclaw-postgres psql -U weclaw -d weclaw_companion
```
