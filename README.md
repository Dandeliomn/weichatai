# 💬 微信情感陪伴 AI

基于 Hermes Agent + SillyTavern + DeepSeek 的微信 AI 陪伴系统，支持角色人格蒸馏、记忆自进化、关系心理学分析。

## 架构

```
微信 ←→ iLink API ←→ 宿主机 Hermes Gateway (消息收发)
                              ↕
                    hermes-st-relay (WebSocket 路由)
                              ↕
                    SillyTavern × N (角色引擎)
                              ↕
                         DeepSeek API
                              ↕
                    Docker PostgreSQL + Redis + MinIO
                              ↕
                    Docker Dashboard (BridgePage)
                              ↕
                    create-ex Skill ←→ she-love-me Skill
                         (人格蒸馏)       (关系分析)
```

## 组件全景

| 组件 | 位置 | 作用 |
|------|------|------|
| **Hermes Gateway** | systemd | 微信消息收发 |
| **hermes-st-relay** | systemd | Hermes → ST WebSocket 消息路由 + 记忆纠正检测 + 关系分析触发 |
| **hermes-sync** | systemd | 对话同步到 PostgreSQL |
| **hermes-st-worldbook** | systemd | ST 世界书自动挂载 (新聊天→自动绑定角色记忆) |
| **SillyTavern** | Docker (per-bot) | 角色引擎 — 角色卡 + 世界书 + ChatBridge 扩展 |
| **api-server** | Docker | REST API + Webhook |
| **Dashboard** | Docker + Nginx | Web 管理界面 (BridgePage, 角色管理) |
| **PostgreSQL** | Docker | 对话记录 (12,117条), 用户数据, 纠正日志 |
| **Redis** | Docker | 缓存 + BullMQ 队列 |
| **MinIO** | Docker | 文件存储 |

## 双 Skill 体系

| Skill | 作用 | 触发 |
|-------|------|------|
| **create-ex** (5,571⭐) | 从聊天记录蒸馏人格 → ST 角色卡 + 世界书 | `/create-ex` / 微信 "不对/记错了" |
| **she-love-me** (374⭐) | 7模块关系心理学分析 (F-A-B-C-D-E-G) | `/she-love-me-skill` / 微信 "分析/关系" |

## 快速开始

### 1. 启动服务

```bash
# Docker 管理后台
docker compose up -d

# AI 引擎
systemctl --user start hermes-gateway
systemctl --user start hermes-st-relay
systemctl --user start hermes-sync
systemctl --user start hermes-st-worldbook
```

### 2. 访问

| 地址 | 用途 |
|------|------|
| `http://localhost:8080` | Dashboard + BridgePage |
| `http://localhost:8082` | SillyTavern Web UI |
| `http://localhost:8080/health` | 健康检查 |

### 3. 使用 Skill

```bash
# 人格蒸馏 (从聊天记录生成角色)
/create-ex 静静

# 角色对话
/静静

# 关系分析
/she-love-me-skill
```

## 记忆自进化

```
用户纠正 "这段不对"
  → 检测纠正意图 (hermes-st-relay)
  → 查 PostgreSQL 聊天记录验证
  → 自动更正 ST 世界书 + 角色卡
  → 记录到 correction_logs
  → 微信通知 "已更正记忆 ✓"
```

```bash
# CLI 手动纠正
node scripts/memory-correct.js -c 王静 -m "哈密瓜那段不对" --dry-run
node scripts/memory-correct.js -c 王静 -m "哈密瓜那段不对"

# API
curl -X POST /api/memory/correct -d '{"character":"王静","claim":"X不对"}'
curl -X POST /api/memory/analyze  -d '{"character":"静静"}'
curl GET /api/memory/corrections
```

## 项目结构

```
├── src/                        # api-server (Express + TypeScript)
│   ├── index.ts                # 主入口
│   ├── routes/
│   │   ├── bridge.ts           # Bot 管理
│   │   ├── correction.ts       # 记忆纠正 + 关系分析 API ★
│   │   └── st-manager.ts       # ST 容器管理
│   └── memory/                 # 短期 + 长期记忆
├── dashboard/                  # React 前端 (Vite + Ant Design)
│   └── src/pages/BridgePage.tsx
├── scripts/                    # 核心脚本
│   ├── hermes-st-relay.js      # ★ 消息中继 (WebSocket 路由 + 纠正/分析检测)
│   ├── memory-correct.js       # ★ 记忆自进化引擎
│   ├── love-analysis.js        # ★ she-love-me PG适配器
│   ├── st-worldbook-autolink.js # ★ 世界书自动挂载
│   ├── generate-st-compose.js  # ST 容器编排生成
│   ├── convert-to-st-charcard.ts # PG角色→ST角色卡
│   ├── sync-hermes-conversations.js # Hermes SQLite→PG
│   ├── init-db-v1~v7.sql       # 数据库迁移
│   └── analyze-wangjing.js     # 聊天数据分析
├── exes/                       # create-ex Skill 输出
│   └── 静静/
│       ├── persona.md          # 5层人格模型
│       ├── memory.md           # 关系记忆 (8维)
│       ├── SKILL.md            # 可对话 Skill
│       └── meta.json           # 元数据
├── st-data/                    # SillyTavern 数据 (角色卡/世界书/对话)
│   ├── default/characters/     # 角色卡 JSON + PNG
│   └── 24926e2e3aa4-im-bot/   # Bot 运行数据
├── docker-compose.yml
├── docker-compose.st.yml       # ST 容器编排
├── nginx.conf                  # Nginx (Dashboard + ST 独立端口)
└── docs/
    ├── changelogs/
    └── superpowers/
```

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/bridge/bots` | GET | Bot 列表 |
| `/api/bridge/bots/:id` | DELETE | 停用/删除 Bot |
| `/api/memory/correct` | POST | 触发记忆纠正 ★ |
| `/api/memory/analyze` | POST | 触发关系分析 ★ |
| `/api/memory/corrections` | GET | 纠正历史 ★ |
| `/api/st/bots/:id/status` | GET | ST 容器状态 |
| `/webhook` | POST | 微信消息入口 |
| `/health` | GET | 健康检查 |

## 数据库

| 表 | 用途 |
|----|------|
| `imported_messages` | 导入的聊天记录 (12,117条) |
| `conversation_logs` | 实时对话记录 |
| `user_memories` | 结构化记忆摘要 |
| `character_templates` | 角色模板 |
| `bot_accounts` | Bot 账号 |
| `correction_logs` | 记忆纠正审计 ★ |
| `system_config` | 系统配置 (游标/计数器) |

## 常用命令

```bash
# Docker
docker compose up -d                        # 启动
docker compose ps                           # 状态
docker compose restart api-server           # 重启 API (代码更新后)

# 服务管理
systemctl --user status hermes-gateway      # AI 引擎
systemctl --user restart hermes-st-relay    # 重启中继
journalctl --user -u hermes-st-relay -f     # 中继日志

# 记忆纠正 (CLI)
node scripts/memory-correct.js -c 王静 -m "X不对" --dry-run
node scripts/memory-correct.js -c 王静 -m "X不对"

# 关系分析
node scripts/love-analysis.js -c 静静

# 数据库
docker exec weclaw-postgres psql -U weclaw -d weclaw_companion
```
