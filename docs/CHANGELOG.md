# 微信情感陪伴AI — 历史改动说明

> 项目位置：`/home/dandelion/wechat-companion`
> 部署方式：Docker Compose + Hermes Gateway
> 最后更新：2026-06-24

---

---

## 2026-06-24 — 安全审计 + 架构优化 (Option B)

### 安全修复

| 问题 | 严重程度 | 修复 |
|------|----------|------|
| `.env` 泄露真实凭据 (API Key/JWT/DB密码) | 🔴 极高 | 替换为模板占位符，清除所有敏感值 |
| `hermes-st-relay.js` SQL 字符串拼接 | 🔴 高 | 改为参数化查询 `$1` |
| `memory-correct.js` 全部 SQL 注入 | 🔴 高 | `execSync`+psql 改为 `pg Pool` 参数化查询 |
| 安全中间件在 body parser 之前执行 | 🟡 中 | 交换顺序，先解析 body 再安全检查 |
| Docker 套接字挂载无风险说明 | 🟡 中 | 添加中文安全警告注释 |

### 架构优化 (Option B)

#### 合并 systemd 服务

| 之前 (3 服务) | 之后 (1 服务) |
|---------------|---------------|
| `hermes-st-relay` (消息路由) | **`hermes-st-relay`** (合并版) |
| `hermes-sync` (对话同步) | ↳ 集成到 `pollMessages()` 循环 |
| `hermes-st-worldbook` (世界书) | ↳ 集成到 `startWorldBookWatcher()` |

- `relay.js` SQL 改为查询所有角色消息（不限 `role='user'`）
- 助理消息跳过 ST 路由，仅写入 `conversation_logs`
- 用户消息实时 upsert 到 `users` 表（为富协议铺路）

#### 移除 MinIO

- MinIO 服务、`minio_data` 卷、相关端口映射已从 `docker-compose.yml` 删除
- 代码已有本地文件系统回退（`minio.ts` 第 33 行: "未配置，使用本地文件系统存储"）
- 存储配额跟踪功能保留，走本地文件

#### 硬编码修复

- `memory-correct.js` 中 ST 容器名 `weclaw-st-24926e2e3aa4-im-bot` 改为 `process.env.ST_CONTAINER_NAME`

#### 废弃脚本

| 脚本 | 状态 |
|------|------|
| `scripts/sync-hermes-conversations.js` | 📝 [DEPRECATED] 已合并到 relay |
| `scripts/st-worldbook-autolink.js` | 📝 [DEPRECATED] 已合并到 relay |

### 影响

| 指标 | 之前 | 之后 |
|------|------|------|
| Systemd 服务 | 4 | **2** (gateway + relay) |
| Docker 容器 | 7 | **6** (MinIO 移除) |
| 总服务数 | **11** | **8** |

### 部署操作

```bash
# 1. 停止废弃服务
systemctl --user stop hermes-sync hermes-st-worldbook
systemctl --user disable hermes-sync hermes-st-worldbook

# 2. 重启 relay（现在包含同步+世界书）
systemctl --user restart hermes-st-relay

# 3. 重建 Docker（移除 MinIO 容器）
docker compose down && docker compose up -d
```

### ⚠️ 已知遗留问题

- git 历史中仍包含旧 `.env` 凭据，建议运行 `git filter-repo --path .env --invert-paths`
- `memory-correct.js` 保留 `docker exec` 回退，但主要路径走 pg Pool
- 富协议（历史/情绪/记忆）待实现，relay 中的 PG 同步为此铺路

## 2026-06-16 — Hermes 集成 + ex-skill 对接

### 核心架构变更：从 wechat-companion worker 切换到 Hermes Gateway

**背景**：原有 wechat-companion 使用 DeepSeek + worker.ts 处理消息，角色扮演效果差，
提示词工程路线走不通。改用 Hermes Agent 框架 + ex-skill 人格系统。

### 新增

- **Hermes Gateway 微信接入**
  - 重新扫码登录 iLink Bot（bot_id: `24926e2e3aa4@im.bot`）
  - 配置 `WEIXIN_AUTO_SKILL` 环境变量自动加载人格
  - `GATEWAY_ALLOW_ALL_USERS=true` 放行所有用户
  - `HERMES_GATEWAY_BUSY_ACK_ENABLED=false` 禁止系统消息泄露到微信

- **ex-skill 人格系统（7个人格）**
  - `ex_wang_jing` — 王静（基于17,708条真实聊天记录）
  - `ex_gentle_ex` — 温柔前任
  - `ex_tsundere_friend` — 毒舌死党
  - `ex_genki_gf` — 元气女友
  - `ex_wise_sister` — 知心姐姐
  - `ex_warm_elder` — 暖心长辈
  - `ex_strict_boss` — 毒舌上司

- **人格管理**
  - `persona_manager.py` — 列出/切换人格，支持保留/清除记忆
  - 微信内说"切换人格"自动列表可选
  - 仪表盘激活角色 → 自动同步 Hermes 人格

- **表情包系统**
  - 604张聊天记录表情（PNG/JPG）
  - AI输出 `[动画表情]` 或 `[sticker]` → 自动替换为真实图片
  - GIF 动图排除（iLink Bot API 不支持动画）

- **聊天记录查询**
  - 导出 12,117 条原始聊天到 `chat_history.db`
  - AI 可主动查询数据库回答过去的事
  - `chat_importer.py` — 支持 JSON/HTML/TXT/zip/WeFlow 自动检测导入
  - 防注入：SQL注入模式检测、文件大小限制、格式白名单

- **仪表盘同步**
  - `POST /characters/:id/activate` → 自动同步 Hermes 人格切换
  - `POST /import/apply` → 分析结果自动创建 ex-skill persona
  - 导入分析改用 ex-skill Part A + Part B 双线并行

### 修改

- **`weixin.py` 补丁**（`gateway/platforms/weixin.py`）
  - 读取 `WEIXIN_AUTO_SKILL` → 设置 `MessageEvent.auto_skill`
  - 读取 SKILL.md → 设置 `MessageEvent.channel_prompt`（系统级身份）
  - `[sticker]`/`[动画表情]` → `MEDIA:` 替换
  - 连接成功后发送 `welcome.md` 使用说明

- **`config.yaml` 修改**
  - `busy_input_mode: queue`（静默排队，不发"⚡ Interrupting"）
  - `interim_assistant_messages: false`
  - `tool_progress: none`
  - `background_process_notifications: none`
  - `approvals.mode: off`（自动批准）
  - `nudge_interval: 0`（禁用记忆审查提示）

### 删除

- 移除自定义 `memory_extract` skill（改为 SKILL.md Part A 内联）
- 移除 `ex-memory-extract` cron 任务
- 移除自定义内存注入脚本

---

## 2026-06-15 — 消息链路打通 + iLink 直连

### 修复

- **BridgePage 白屏根治**
  - React Hooks 违规：`useState(Date.now())` 放在条件 return 之后 → 移到组件顶部
  - Vite 代理劫持：`/bridge` 代理到 Docker nginx → 删除代理项
  - 重复弹"扫码成功"：闭包 `bots.length` 始终为 0 → 改用 `notifiedRef`

- **消息收不到**
  - bot CLI 后台模式不输出来信 → `unbuffer` 包装
  - Dockerfile 安装 `expect`

- **iLink API 直连**
  - 绕过 bot CLI，直接用 iLink `getupdates` 长轮询
  - `bot_accounts` 表新增列：`bot_token`, `get_updates_buf`, `ilink_user_id`
  - api-server 启动后自动从 DB 恢复轮询 → 重启不需要重新扫码

- **消息发不出**
  - weclawbot-api 返回 401 → 改用 iLink `sendmessage` API
  - **致命 bug**：worker.ts 文本回复路径只有 `console.log`，没有实际 `sendMessage()` 调用

- **删 Bot 问题**
  - register-bot 复活被停用 bot → 同时检查 `deleted_at` + `is_active`
  - bot_registrar 自动清理 session

### 新增

- **结构化记忆提取**：`src/memory/extract.ts`
  - 采样消息 → DeepSeek → 结构化记忆
  - 从 12,117 条提取 24 条记忆

---

## 2026-06-14 — QR 链路重做 + 导入系统 + OpeniLink 融入

### 修复

- QR 码链路完全重做
- 导入系统（zip + HTML 聊天记录）
- 表情管理（上传 + 自动发）
- Bot 删除修复
- OpeniLink Hub 融入
- CodeGraph 安装

### 已知问题

- BridgePage 白屏（第二天修复）

---

## 2026-06-09 — 消息收发修复 + QR 问题

### 修复

- 消息收发链路修复
- QR 码获取问题
- ttyd 终端建议

---

## 2026-06-08 — 初始部署 + 核心修复

### 完成

- 仪表盘 + 登录 + 注册 + 邀请码
- 微信收发（OpeniLink + webhook）
- AI 角色系统（官方 + 自定义 + 导入）
- 会员系统（四级 + 充值 + 积分）
- 聊天记录导入（zip + HTML）
- 表情包管理（上传 + 自动发）
- 数据隔离（每用户独立）

### 修复

| 问题 | 根因 | 修复 |
|------|------|------|
| Redis `allkeys-lru` | BullMQ 要求 noeviction | `docker-compose.yml` → `noeviction` |
| bull-worker / care-scheduler unhealthy | 继承 Dockerfile HTTP 健康检查，无 HTTP 端口 | 改用 `pgrep` 进程存活检查 |
| 登录 502 Bad Gateway | Nginx 缓存 api-server 旧 IP | `proxy_pass` + `resolver` 动态 DNS |
| 压缩包中文文件名乱码 | BusyBox unzip 不支持 CP936 | 安装 Info-ZIP UnZip + `-O CP936` |

---

## 当前容器状态（12个）

| 容器 | 端口 | 用途 |
|------|------|------|
| weclaw-nginx | 8080 | Web 入口 |
| weclaw-api-server | 3000 | API 服务 |
| weclaw-dashboard | — | 仪表盘前端 |
| weclaw-postgres | — | 数据库 |
| weclaw-redis | — | 缓存/队列 |
| weclaw-minio | 9000 | 对象存储 |
| weclaw-bull-worker | — | 消息队列处理 |
| weclaw-care-scheduler | — | 定时任务 |
| weclaw-bridge | 26322 | WeChat 桥接 |
| weixin-bridge | — | 微信桥接 |
| weclaw-openilink | 9800 | OpeniLink Hub |
| weclaw-fastagent | 18789 | FastAgent（备用） |
