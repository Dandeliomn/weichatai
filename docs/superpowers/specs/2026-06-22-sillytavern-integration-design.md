# SillyTavern 角色引擎接入设计

**日期:** 2026-06-22
**状态:** 已确认
**关联:** [[wechat-companion-ai]], [[sillytavern-integration]]

## 目标

将 SillyTavern 作为独立的角色扮演引擎接入微信陪伴AI平台。Hermes 退化为纯微信消息桥接，SillyTavern 接管角色卡管理、对话记忆、LLM 调用。

## 核心架构

```
WeChat (多个用户)
  │  iLink Bot API (Tencent)
  ▼
Hermes Gateway (宿主机, systemd)
  │  纯微信收发 + Bot 路由
  │  ChatBridge WebSocket (富协议)
  ├──→ ST:8001 (温柔前任 · 角色卡A)
  ├──→ ST:8002 (毒舌死党 · 角色卡B)
  └──→ ST:8003 (元气女友 · 角色卡C)
         │  OpenAI API
         ▼
      DeepSeek V4 Flash (云端)

PostgreSQL ← hermes-sync (10s) ← Hermes SQLite state.db
BridgePage → ST API + PostgreSQL
```

### 关键变化

| 组件 | 之前 | 之后 |
|------|------|------|
| Hermes | AI引擎 + 微信收发 | 微信收发 + 消息路由 |
| 角色管理 | SOUL.md + persona.txt + ex-skill | SillyTavern 角色卡 |
| LLM 调用 | Hermes → DeepSeek | SillyTavern → DeepSeek |
| 记忆 | PostgreSQL + Redis | ST Lorebook + 向量记忆 (PG 备份) |
| 管理界面 | BridgePage | BridgePage 扩展 + ST Web UI |

## 1. SillyTavern 部署

### 1.1 部署方式

Docker 容器，集成到现有 `docker-compose.yml`。每个活跃 Bot 对应一个独立 ST 容器实例。

```
docker-compose.yml:
  st-bot-8001:   # 温柔前任
    image: sillytavern/sillytavern:latest
    ports: ["8001:8000"]
    volumes: ["./st-data/8001:/home/node/app/data"]
  st-bot-8002:   # 毒舌死党
    ...
```

### 1.2 资源估算

| 组件 | 内存 | CPU | 磁盘 |
|------|------|-----|------|
| ST 单实例 (空闲) | ~200 MB | ~0.1 核 | ~50 MB |
| ST 单实例 (活跃) | ~350 MB | ~0.3 核 | ~50 MB |
| 现有 Docker 服务 | ~500 MB | ~1 核 | - |
| Hermes (宿主机) | ~100 MB | ~0.2 核 | - |
| **3 个 ST 实例 + 现有** | **~1.6 GB** | **~2.1 核** | **~200 MB** |

LLM 推理全部走 DeepSeek 云端 API，不消耗本地 GPU/CPU。

### 1.3 网络

ST 容器使用现有 `companion-net` Docker 网络。通过 `host.docker.internal` 或 `network_mode: host` 连接宿主机 Hermes。

Nginx 添加反向代理规则：`/st/:bot_id/` → 对应 ST 容器，统一从 8080 端口访问。

### 1.4 容器编排

不使用静态 docker-compose 枚举所有 Bot。采用模板生成方式：
- 主 `docker-compose.yml` 包含基础服务
- `docker-compose.st.yml` 由脚本根据活跃 Bot 列表动态生成
- BridgePage 提供"添加 Bot → 自动创建 ST 容器"流程

## 2. ChatBridge 适配层

### 2.1 协议格式 (富协议)

**请求 (Hermes → ST):**
```json
{
  "type": "message",
  "user_id": "wxid_abc123",
  "nickname": "小明",
  "content": "今天好累啊",
  "media_type": "text",
  "media_url": null,
  "bot_id": "24926e2e3aa4@im.bot",
  "timestamp": 1782127000,
  "context": {
    "recent_history": [
      {"role": "user", "content": "在吗", "time": "10分钟前"},
      {"role": "assistant", "content": "在的", "time": "9分钟前"}
    ],
    "emotion": {"label": "neutral", "confidence": 0.85},
    "memories": ["用户喜欢晚睡", "最近工作压力大"]
  },
  "status": {
    "typing": false,
    "read": true
  }
}
```

**响应 (ST → Hermes):**
```json
{
  "type": "reply",
  "user_id": "wxid_abc123",
  "bot_id": "24926e2e3aa4@im.bot",
  "content": "辛苦了，早点休息~",
  "action": "send_message",
  "media": null,
  "status": {"typing": true, "delay_ms": 1500}
}
```

### 2.2 Hermes 端实现

在 Hermes gateway 中新增 `platforms/chatbridge.py`：
- WebSocket 客户端，启动时连接所有活跃 ST 实例
- iLink 收到消息 → 查询 `bot_accounts.character_id` → 路由到对应 ST
- ST 回复 → 调用 iLink `sendmessage` API
- 心跳维持连接，断线自动重连 (backoff: 1s/2s/4s/... max 30s)

### 2.3 SillyTavern 端

安装 ChatBridge 扩展，配置 WebSocket 服务端模式：
- ST 启动时加载指定角色卡
- 收到消息 → 正常角色扮演流程 (角色卡 + Lorebook + 记忆) → 生成回复
- WebSocket 返回 JSON 响应

## 3. 角色迁移

### 3.1 自动批量转换

编写 `scripts/convert-to-st-charcard.ts`，读取 PostgreSQL `character_templates` 表，转换为 SillyTavern 兼容的 `chara_card_v2` JSON 格式。

**字段映射：**
| PostgreSQL | SillyTavern chara_card_v2 |
|-----------|--------------------------|
| name | data.name |
| tagline | data.description |
| personality | data.personality |
| scenario | data.scenario |
| first_message | data.first_mes |
| example_dialogue | data.mes_example |
| system_prompt | data.system_prompt |
| post_history | data.post_history_instructions |
| tags | data.tags |
| metadata | data.extensions |

额外处理：
- SOUL.md → 合并到 system_prompt 中
- persona.txt → 转换为 ST World Book (Lorebook) 条目
- ex-skill 角色 → 枚举每个子目录，提取 persona 字段转换为角色卡

输出目录：`st-data/chars/`，ST 容器挂载为 `data/default-user/characters/`。

### 3.2 手动精细打磨

挑选 2-3 个核心角色（温柔前任 王静、毒舌死党），在 ST 的 Web UI 中：
- 优化首条消息 (first_mes)
- 添加示例对话 (mes_example)
- 配置 Lorebook 条目（世界观、关系设定）
- 测试对话质量，迭代调整

## 4. 多 Bot / 多实例管理

### 4.1 生命周期

BridgePage 新增 ST 实例管理 API (`/api/bridge/bots/:id/st`):

| 操作 | API | 实现 |
|------|-----|------|
| 创建 ST 实例 | POST | 生成角色卡 → 写 docker-compose.st.yml → `docker compose up -d` |
| 启动 | PUT .../start | `docker compose start st-bot-{id}` |
| 停止 | PUT .../stop | `docker compose stop st-bot-{id}` |
| 重启 | PUT .../restart | `docker compose restart st-bot-{id}` |
| 状态 | GET .../status | `docker inspect` + WebSocket 健康检查 |
| 删除 | DELETE | `docker compose rm -sf` + 清理数据卷 |

### 4.2 自动创建流程

1. 用户在 BridgePage 点击"添加 Bot"
2. 扫码绑定微信 → `bot_accounts` 写入
3. 用户选择角色 → 自动触发：
   - 生成角色卡 PNG/JSON → 放入 `st-data/{bot_id}/`
   - 动态更新 docker-compose.st.yml
   - `docker compose up -d st-bot-{bot_id}`
4. ST 启动完成 → Hermes 检测到新 WebSocket 端点 → 建立连接

## 5. 记忆系统

### 5.1 主记忆层：SillyTavern

- **Lorebook (世界书):** 角色背景、用户信息、关系设定。关键词触发自动注入上下文。
- **向量记忆:** ST 内置 ChromaDB，语义检索历史对话。
- **对话树:** ST 会话管理，每个微信用户一个独立聊天会话。

### 5.2 备份层：PostgreSQL

`hermes-sync.service` 不变，继续每 10 秒从 Hermes `state.db` 同步对话到 PG `conversation_logs` 表。

用途：
- BridgePage 对话审计/搜索
- 数据统计/情绪分析
- 灾难恢复（ST 数据丢失时从 PG 重建）

## 6. BridgePage 扩展

### 6.1 Bot 卡片增强

每个 Bot 卡片新增：
- **ST 状态指示灯** (绿/黄/红)
- **[聊天] 按钮** → 新窗口打开 ST Web UI
- **[启动]/[停止] 按钮** → 控制 ST 实例
- **角色卡缩略图** (从 ST 角色卡 PNG 提取)

### 6.2 新增 API 端点

```
GET  /api/bridge/bots/:id/st/status   → { running: true, uptime: 3600, memory: "320MB" }
POST /api/bridge/bots/:id/st/start    → 启动 ST 容器
POST /api/bridge/bots/:id/st/stop     → 停止 ST 容器
POST /api/bridge/bots/:id/st/restart  → 重启 ST 容器
```

### 6.3 Nginx 路由

```nginx
# ST Web UI 代理
location ~ ^/st/([^/]+)/(.*)$ {
    set $st_backend "http://st-bot-$1:8000";
    proxy_pass $st_backend/$2;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## 7. Hermes 变更

### 7.1 角色管理简化

- 移除 persona.txt / SOUL.md 的角色扮演逻辑
- 移除 auto-skill (ex_gentle_ex 等) 的角色切换
- 保留 iLink 连接管理、消息收发基础能力

### 7.2 新增 ChatBridge 模块

`platforms/chatbridge.py`:
- WebSocket 客户端池 (N 个活跃连接)
- 消息路由表: `bot_id → websocket_url`
- 连接健康检查 + 自动重连
- 协议序列化/反序列化

### 7.3 配置变更

```yaml
# config.yaml 新增
platforms:
  chatbridge:
    enabled: true
    bots:
      - id: "24926e2e3aa4@im.bot"
        st_url: "ws://st-bot-8001:8000"
        character: "温柔前任"
```

## 实施步骤

| 步骤 | 内容 | 预估工作量 |
|------|------|-----------|
| 1 | ST Docker 基础部署 (单实例跑通) | 小 |
| 2 | ChatBridge 适配层 (协议 + Hermes 端) | 中 |
| 3 | 角色迁移脚本 (批量转换) | 小 |
| 4 | 多实例编排 (动态 compose + 管理 API) | 中 |
| 5 | BridgePage 扩展 (ST 管理 UI) | 中 |
| 6 | 核心角色精细打磨 | 小 |
| 7 | 端到端测试 + 文档更新 | 小 |

## 风险

| 风险 | 缓解 |
|------|------|
| ChatBridge 扩展 API 变更 | 锁定版本，适配层独立 |
| ST 多实例内存增长 | 设置容器 memory limit，监控 |
| Hermes iLink 断连 | 保留现有重连机制 |
| 角色迁移质量不佳 | 保留原始数据，可回退手动调整 |
