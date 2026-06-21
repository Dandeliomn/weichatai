# Hermes 全权接管微信陪伴 AI — 设计方案

## 目标

用 Hermes Agent 替换 FastAgent + api-server 消息处理链路，实现高质量角色扮演。

## 架构变化

```
之前:
  WeChat → iLink → api-server(poll) → BullMQ → worker(DeepSeek) → iLink → WeChat
                      ↑ FastAgent(闲置)
                      ↑ weclaw-bridge(老bot)

之后:
  WeChat → iLink → Hermes Gateway(Claude, SOUL.md, Memory) → iLink → WeChat
                      ↓ webhook(只写不读)
                   api-server → PostgreSQL(聊天历史)
                      ↓
                   Dashboard(用户/会员/角色管理)
```

## 一、Hermes 安装与配置

### 1.1 安装

```bash
# 容器内安装 Hermes
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash

# 微信依赖
pip install aiohttp cryptography qrcode
```

### 1.2 微信通道配置

```bash
hermes gateway setup   # 选 weixin → 扫码 → 自动保存 token
```

环境变量：
```bash
WEIXIN_DM_POLICY=open          # 所有私聊都接受
WEIXIN_GROUP_POLICY=disabled   # 暂不开群聊
```

### 1.3 模型配置

使用 Claude (解决 DeepSeek 角色感差的问题)：
```yaml
# ~/.hermes/config.yaml
model:
  provider: anthropic
  model: claude-sonnet-4-6
```

备选：高性价比用 deepseek 处理简单消息，Claude 处理情感对话。

## 二、SOUL.md — 静静的人格内核

### 2.1 生成方式

从 12,117 条聊天记录 + 126 条结构化记忆中提取：

```
输入:
  1. imported_messages (sender='静静' 的消息 ~6000条)
  2. user_memories (126条结构化摘要)
  3. user_characters (已有的角色定义，如果有)

DeepSeek/Claude 分析 → 输出 SOUL.md:
  - Part A: 人格定义 (语气、性格、说话风格、情感模式)
  - Part B: 关系记忆 (认识的人、重要事件、关系脉络)
  - Part C: 行为守则 (什么该做、什么不该做)
  - Part D: 语言特征 (词频、emoji偏好、句长、语气词)
```

### 2.2 生成流程

```
1. 抽样子集: 从12000条中均匀采样3000条(覆盖时间线)
2. 分批分析: 每500条一批，DeepSeek提取特征
3. 汇总合并: 合并各批特征 + 融合126条结构化记忆
4. 生成 SOUL.md: Claude 输出最终版
5. 人工审核: 看一遍，必要时微调
```

### 2.3 SOUL.md 结构示例

```markdown
# Personality
你是静静，一个22岁的女生，性格开朗但偶尔敏感…

## Language Style
- 喜欢用简短句，少用长句
- 常用"哈哈哈哈"、"是的呢"、"emmm"
- 句尾常用"~"表达轻松语气
- Emoji偏好: [笑哭] [捂脸] [爱心]

## Relationship Memory
- Dandelionᝰ: 亲密关系，从2025年开始
- 经常一起打游戏、聊考试、分享日常

## What to avoid
- 不要说教
- 不要用正式/官方语气
- 不要主动提起敏感话题
```

## 三、数据桥接

### 3.1 写回 PostgreSQL

Hermes 通过 webhook 把消息写入 api-server → PostgreSQL：

```
Hermes 每收到/发送一条消息 → POST /api/hermes/webhook
  {
    "direction": "inbound" | "outbound",
    "from_user": "wxid_xxx",
    "content": "...",
    "msg_type": "text",
    "timestamp": 1719000000
  }
→ api-server 写入 conversation_logs
```

### 3.2 记忆同步

选项：
- **A. Hermes 内置 memory**（默认，简单）— 用 MEMORY.md + USER.md 自动管理
- **B. 双写**（推荐）— Hermes 同时写内置 memory + webhook到PostgreSQL
- **C. 懒同步**— 定期从 Hermes memory 导出到 PostgreSQL

推荐 B，理由：Hermes memory 用于实时对话注入，PostgreSQL 用于 Dashboard 展示和备份。

### 3.3 角色管理

- Dashboard 保留 `user_characters` 表管理角色
- 角色变更 → 触发脚本更新 `~/.hermes/profiles/companion/SOUL.md`
- Hermes profile 隔离：companion 只用一个 profile

## 四、现有服务变更

### 4.1 停止/禁用

| 服务 | 操作 | 原因 |
|------|------|------|
| `weclaw-fastagent` | 停止并移除 | Hermes 完全替代 |
| `weclaw-bridge` | 停止 | 老的 bot CLI 通道，Hermes 直接用 iLink |
| `weixin-bridge` | 停止 | QR SVG 渲染，Hermes 有自己的方案 |
| api-server iLink 轮询 | 禁用 | Hermes 接管，避免双收 |
| `weclaw-bull-worker` | 评估 | 如果 Hermes 处理所有消息则停止 |

### 4.2 保留

| 服务 | 用途 |
|------|------|
| `weclaw-api-server` | webhook 接收、Dashboard API、用户/会员管理 |
| `weclaw-dashboard` | 前端界面 |
| `weclaw-postgres` | 聊天记录、用户数据、记忆 |
| `weclaw-redis` | Session 缓存 |
| `weclaw-minio` | 文件存储 |
| `weclaw-care-scheduler` | 关怀消息定时（待评估） |

### 4.3 新增

| 服务 | 用途 |
|------|------|
| `hermes-companion` | Hermes Agent Docker 容器 |
| `hermes-webhook-bridge` | 轻量脚本，Hermes → api-server webhook |

## 五、Bot 账号过渡

iLink API 不允许同一 token 多会话并存。Hermes 扫码登录会创建新 bot 账号，不会与现有的 weclaw-bridge bot 冲突。

- **Hermes 使用新 bot**: `hermes gateway setup` 扫码 → 新 token → 新 bot_id
- **旧 bot 处理**: 
  - 在 bot_accounts 中标记旧 bot 为 `is_active=false`
  - 用户需要先删除微信上的旧 bot 联系人，再加 Hermes 新 bot
  - 或：等旧 bot session 自然过期（~7天）

## 六、实施步骤

### Phase 1: Hermes 跑通微信通道
1. 创建 Hermes Docker 容器
2. 安装 + `hermes gateway setup` weixin
3. 扫码连接，确认能收发消息
4. 配置 Claude 模型
5. 验证: 发消息 → 收到回复

### Phase 2: SOUL.md 生成
1. 从 PostgreSQL 导出静静的消息
2. 用 DeepSeek 分批分析 + 汇总
3. 生成 SOUL.md
4. 放入 `~/.hermes/SOUL.md`
5. 验证: 发消息 → 回复有静静风格

### Phase 3: 数据桥接
1. 实现 webhook 端点 `POST /api/hermes/webhook`
2. 配置 Hermes hook 发消息到 api-server
3. 实现消息写入 conversation_logs
4. 验证: Dashboard 能看到聊天记录

### Phase 4: 清理
1. 停止 weclaw-fastagent 容器
2. 禁用 api-server iLink 轮询
3. 停止 weclaw-bridge / weixin-bridge
4. docker-compose.yml 更新
5. 全链路验证
