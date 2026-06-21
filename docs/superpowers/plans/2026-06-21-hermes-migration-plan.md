# Hermes 全权接管 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Hermes Agent 替换 FastAgent + api-server 消息链路，接入 Claude 实现高质量静静角色扮演。

**Architecture:** Hermes 容器连接 iLink 微信通道，Claude 驱动回复，SOUL.md 定义人格。通过 hook 脚本把消息写入 api-server webhook → PostgreSQL。

**Tech Stack:** Docker, Node.js (webhook bridge), Python (Hermes hook), Claude API, PostgreSQL

---

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 创建 | `hermes.Dockerfile` | Hermes 容器镜像 |
| 创建 | `hermes-entrypoint.sh` | 容器启动脚本 |
| 创建 | `hermes-config.yaml` | Hermes 模型/通道配置 |
| 创建 | `scripts/hermes-webhook-bridge.js` | Hermes hook: 消息→api-server |
| 创建 | `scripts/generate-soul.ts` | SOUL.md 生成脚本 |
| 修改 | `docker-compose.yml` | 添加 hermes-companion 服务，停旧服务 |
| 修改 | `src/index.ts` | 添加 POST /api/hermes/webhook 端点 |
| 修改 | `src/routes/bridge.ts` | 禁用 iLink 轮询 |
| 创建 | `hermes-data/SOUL.md` | 静静人格文件 (Phase 2 生成) |

---

### Task 1: Hermes Dockerfile

**Files:**
- Create: `hermes.Dockerfile`
- Create: `hermes-entrypoint.sh`

- [ ] **Step 1: 写 Dockerfile**

```dockerfile
# hermes.Dockerfile
FROM python:3.12-slim

# 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# 安装 Hermes Agent
RUN pip install hermes-agent aiohttp cryptography qrcode

# 工作目录
RUN mkdir -p /app/data /app/config /app/scripts
WORKDIR /app

# 环境变量
ENV HERMES_HOME=/app/data
ENV WEIXIN_DM_POLICY=open
ENV WEIXIN_GROUP_POLICY=disabled

# webhook bridge (Node.js 脚本，监听 Hermes 消息)
COPY scripts/hermes-webhook-bridge.js /app/scripts/webhook-bridge.js

# entrypoint
COPY hermes-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

- [ ] **Step 2: 写 entrypoint 脚本**

```bash
#!/bin/bash
# hermes-entrypoint.sh - Hermes companion entrypoint
set -e

CONFIG_FILE="/app/config/config.yaml"
LOG_DIR="/app/data/logs"
mkdir -p "$LOG_DIR"

echo "[hermes] Starting entrypoint..."
echo "[hermes] HERMES_HOME=$HERMES_HOME"

# 检查是否已配置微信通道
if [ ! -f "$HERMES_HOME/.env" ]; then
    echo "[hermes] ⚠️  未检测到微信通道配置"
    echo "[hermes] 请运行: docker compose exec hermes-companion hermes gateway setup"
    echo "[hermes] 进入待机模式 (保持容器运行)..."
    tail -f /dev/null
    exit 0
fi

# 启动 webhook bridge (后台，监听 Hermes 消息日志)
echo "[hermes] Starting webhook bridge..."
node /app/scripts/webhook-bridge.js &
BRIDGE_PID=$!
echo "[hermes] Bridge PID: $BRIDGE_PID"

# 启动 Hermes gateway (前台)
echo "[hermes] Starting Hermes gateway..."
hermes gateway 2>&1 | tee -a "$LOG_DIR/gateway.log"

# 清理
kill $BRIDGE_PID 2>/dev/null || true
```

- [ ] **Step 3: Build 验证**

```bash
cd /home/dandelion/wechat-companion
docker build -f hermes.Dockerfile -t wechat-companion-hermes .
# Expected: build success
```

---

### Task 2: Hermes 配置文件

**Files:**
- Create: `hermes-config.yaml`

- [ ] **Step 1: 写配置**

```yaml
# hermes-config.yaml
# Hermes Agent 配置文件

model:
  provider: anthropic
  model: claude-sonnet-4-6
  max_tokens: 1024
  temperature: 0.8

gateway:
  channel: weixin
  dm_policy: open
  group_policy: disabled
  output: jsonl  # JSONL 格式输出，方便 webhook bridge 解析

memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375
  write_approval: false

agent:
  # 禁用内置 personality overlay，只用 SOUL.md
  personalities: {}
```

- [ ] **Step 2: 验证文件位置**

```bash
ls -la /home/dandelion/wechat-companion/hermes-config.yaml
# Expected: file exists
```

---

### Task 3: docker-compose 变更

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: 添加 hermes-companion 服务**

在 `services:` 下新增（fastagent 后面）：

```yaml
  # ===========================================================================
  # Hermes Agent - 微信消息处理 + AI角色扮演
  # 替换 FastAgent + api-server 消息链路
  # ===========================================================================
  hermes-companion:
    build:
      context: .
      dockerfile: hermes.Dockerfile
    container_name: hermes-companion
    ports:
      - "18789:18789"
    volumes:
      - hermes_data:/app/data
      - ./hermes-config.yaml:/app/config/config.yaml:ro
      - ./scripts/hermes-webhook-bridge.js:/app/scripts/webhook-bridge.js:ro
    environment:
      - HERMES_HOME=/app/data
      - WEBHOOK_URL=http://api-server:3000/api/hermes/webhook
      - WEIXIN_DM_POLICY=open
      - WEIXIN_GROUP_POLICY=disabled
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    restart: unless-stopped
    networks:
      - companion-net
```

- [ ] **Step 2: 添加 hermes_data 卷**

在 `volumes:` 下新增：

```yaml
  hermes_data:
    driver: local
```

- [ ] **Step 3: 停用旧服务（注释掉）**

将以下服务用 `#` 注释（保留定义以供回滚）：
- `weclaw-bridge` (整个块)
- `weixin-bridge` (整个块)
- `fastagent` (整个块)

并移除 api-server 的 `fastagent_data` 挂载：

```yaml
# 删除这一行:
      - fastagent_data:/app/fastagent-data:ro
```

- [ ] **Step 4: 验证语法**

```bash
cd /home/dandelion/wechat-companion
docker compose config --quiet
# Expected: no output (success)
```

---

### Task 4: Webhook Bridge 脚本 (文件监听)

**Files:**
- Create: `scripts/hermes-webhook-bridge.js`

不依赖 Hermes 内部 hook——用文件监听方案（与现有 message-forwarder.js 同样模式），tail Hermes 输出的 JSONL 日志。

- [ ] **Step 1: 写 bridge 脚本**

```javascript
#!/usr/bin/env node
/**
 * Hermes Webhook Bridge
 * 监听 Hermes gateway 输出的 JSONL 日志，提取消息事件转发到 api-server
 *
 * Hermes 输出格式 (从 --output jsonl):
 *   {"type":"message_received","channel":"weixin","from":"wxid_xxx",
 *    "content":"你好","timestamp":1719000000,"message_id":"abc"}
 *   {"type":"message_sent","channel":"weixin","to":"wxid_xxx",
 *    "content":"你好呀~","timestamp":1719000001}
 */

const fs = require('fs');
const http = require('http');

const LOG_FILE = process.env.LOG_FILE || '/app/data/logs/gateway.log';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://api-server:3000/api/hermes/webhook';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '500', 10);

let lastSize = 0;

function postWebhook(payload) {
  const data = JSON.stringify(payload);
  const url = new URL(WEBHOOK_URL);
  const req = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
    timeout: 5000,
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`[bridge] ✅ ${payload.direction} forwarded (${res.statusCode})`);
      } else {
        console.error(`[bridge] ❌ ${payload.direction} failed (${res.statusCode}): ${body}`);
      }
    });
  });
  req.on('error', (e) => console.error(`[bridge] ❌ error: ${e.message}`));
  req.write(data);
  req.end();
}

function processNewLines() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size <= lastSize) return;

    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(Math.min(stat.size - lastSize, 1024 * 1024)); // max 1MB
    fs.readSync(fd, buf, 0, buf.length, lastSize);
    fs.closeSync(fd);
    lastSize = stat.size;

    const lines = buf.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // 只处理消息收发事件
        if (event.type === 'message_received') {
          const payload = {
            direction: 'inbound',
            from_user: event.from || event.sender?.id || 'unknown',
            content: event.content || event.text || '',
            msg_type: event.msg_type || 'text',
            message_id: event.message_id || event.id || '',
            timestamp: event.timestamp || Math.floor(Date.now() / 1000),
          };
          console.log(`[bridge] 📩 inbound: "${payload.content.substring(0, 40)}" from ${payload.from_user}`);
          postWebhook(payload);
        } else if (event.type === 'message_sent') {
          const payload = {
            direction: 'outbound',
            from_user: event.to || event.recipient?.id || 'unknown',
            content: event.content || event.text || '',
            msg_type: 'text',
            message_id: event.message_id || event.id || '',
            timestamp: event.timestamp || Math.floor(Date.now() / 1000),
          };
          console.log(`[bridge] 📤 outbound: "${payload.content.substring(0, 40)}"`);
          postWebhook(payload);
        }
      } catch (e) {
        // 跳过无法解析的行
      }
    }
  } catch (e) {
    // 文件尚未创建，忽略
  }
}

console.log(`[bridge] Watching ${LOG_FILE}`);
console.log(`[bridge] Forwarding to ${WEBHOOK_URL}`);

// 初始化文件大小
try { lastSize = fs.statSync(LOG_FILE).size; } catch {}

// 轮询新内容
setInterval(processNewLines, POLL_INTERVAL);
```

- [ ] **Step 2: 验证语法**

```bash
node -c /home/dandelion/wechat-companion/scripts/hermes-webhook-bridge.js
# Expected: no output (syntax OK)
```

---

### Task 5: api-server 新增 Hermes Webhook 端点

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 添加 POST /api/hermes/webhook 路由**

在 `/webhook` 路由之后、`/health` 之前插入：

```typescript
/**
 * POST /api/hermes/webhook
 * 接收 Hermes Agent 转发的消息，写入 conversation_logs
 *
 * 请求体:
 * {
 *   "direction": "inbound" | "outbound",
 *   "from_user": "wxid_xxx",
 *   "content": "...",
 *   "msg_type": "text",
 *   "message_id": "...",
 *   "timestamp": 1719000000
 * }
 */
app.post('/api/hermes/webhook', async (req: Request, res: Response) => {
  try {
    const { direction, from_user, content, msg_type, message_id, timestamp } = req.body;

    if (!from_user || !content) {
      res.status(400).json({ error: '缺少必要字段: from_user, content' });
      return;
    }

    // 查找或创建用户
    const userResult = await pgPool.query(
      `INSERT INTO users (wechat_id, last_active_at)
       VALUES ($1, NOW())
       ON CONFLICT (wechat_id) DO UPDATE SET last_active_at = NOW()
       RETURNING id`,
      [from_user]
    );
    const userId = userResult.rows[0].id;

    // 写入对话日志
    const role = direction === 'outbound' ? 'assistant' : 'user';
    await pgPool.query(
      `INSERT INTO conversation_logs (user_id, wechat_id, role, content, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        from_user,
        role,
        content,
        timestamp ? new Date(timestamp * 1000) : new Date(),
      ]
    );

    console.log(
      `[HermesWebhook] 📝 ${role}: "${content.substring(0, 40)}" (user=${from_user})`
    );

    res.status(200).json({ ok: true });
  } catch (error: any) {
    console.error('[HermesWebhook] ❌ 写入失败:', error.message);
    res.status(500).json({ error: '写入失败' });
  }
});
```

- [ ] **Step 2: 编译验证**

```bash
cd /home/dandelion/wechat-companion
npx tsc --noEmit
# Expected: no type errors
```

---

### Task 6: 禁用 iLink 轮询

**Files:**
- Modify: `src/routes/bridge.ts`

- [ ] **Step 1: 添加 iLink 轮询开关**

在 `bridge.ts` 顶部添加环境变量控制，轮询函数加 early return：

找到 `bridge.ts` 中的 iLink poll loop 启动代码（约在文件后半部分，`startILinkPolling` 或类似函数），在最前面加：

```typescript
// iLink 轮询开关 — 当 Hermes 接管时禁用
const ILINK_POLLING_ENABLED = process.env.ILINK_POLLING_ENABLED !== 'false';

// 在启动轮询的函数开头:
if (!ILINK_POLLING_ENABLED) {
  console.log('[Bridge] iLink 轮询已禁用 (ILINK_POLLING_ENABLED=false)，由 Hermes 接管');
  return;
}
```

- [ ] **Step 2: docker-compose 设环境变量**

在 api-server 的 environment 中添加：

```yaml
    environment:
      - ILINK_POLLING_ENABLED=false
```

同时也在 bull-worker 中添加：

```yaml
    environment:
      - ILINK_POLLING_ENABLED=false
```

- [ ] **Step 3: 编译验证**

```bash
cd /home/dandelion/wechat-companion
npx tsc --noEmit
# Expected: no type errors
```

---

### Task 7: SOUL.md 生成脚本

**Files:**
- Create: `scripts/generate-soul.ts`

- [ ] **Step 1: 写生成脚本**

```typescript
/**
 * SOUL.md 生成脚本
 * 从 PostgreSQL 聊天记录 + 结构化记忆中提取静静的人格特征
 *
 * 用法: npx ts-node scripts/generate-soul.ts
 */

import { Pool } from 'pg';
import 'dotenv/config';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://weclaw:weclaw_secret@postgres:5432/weclaw_companion';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

interface Message {
  sender: string;
  content: string;
  timestamp: Date;
}

interface Memory {
  summary_text: string;
  emotion: string | null;
  keywords: string[];
}

async function main() {
  console.log('[SOUL] 🔍 从数据库抽取数据...');

  // 1. 抽取静静的聊天记录（均匀采样 ~3000 条）
  const msgsResult = await pool.query<Message>(
    `SELECT sender, content, timestamp
     FROM imported_messages
     WHERE sender = '静静'
     ORDER BY timestamp
     LIMIT 4000`
  );
  const allMsgs = msgsResult.rows;
  const sampledMsgs = sampleUniform(allMsgs, 3000);
  console.log(`[SOUL] 📊 聊天记录: ${allMsgs.length} 条总, 采样 ${sampledMsgs.length} 条`);

  // 2. 抽取结构化记忆
  const memResult = await pool.query<Memory>(
    `SELECT summary_text, emotion, keywords FROM user_memories ORDER BY importance DESC LIMIT 200`
  );
  const memories = memResult.rows;
  console.log(`[SOUL] 🧠 结构化记忆: ${memories.length} 条`);

  // 3. 分批分析 (500条/批)
  const BATCH_SIZE = 500;
  const batches: string[] = [];
  for (let i = 0; i < sampledMsgs.length; i += BATCH_SIZE) {
    const batch = sampledMsgs.slice(i, i + BATCH_SIZE);
    batches.push(batch.map(m => `[${m.sender}] ${m.content}`).join('\n'));
  }
  console.log(`[SOUL] 📦 分 ${batches.length} 批分析...`);

  const batchInsights: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    console.log(`[SOUL] 🔄 分析第 ${i + 1}/${batches.length} 批...`);
    const insight = await analyzeBatch(batches[i], i + 1);
    batchInsights.push(insight);
  }

  // 4. 汇总合并 + 融合记忆
  const soulMd = await generateFinalSoul(batchInsights, memories);
  console.log('[SOUL] ✅ 生成完成!\n');
  console.log(soulMd);

  await pool.end();
}

function sampleUniform<T>(arr: T[], target: number): T[] {
  if (arr.length <= target) return arr;
  const step = arr.length / target;
  const result: T[] = [];
  for (let i = 0; i < target; i++) {
    result.push(arr[Math.floor(i * step)]);
  }
  return result;
}

async function analyzeBatch(messages: string, batchNum: number): Promise<string> {
  const res = await fetch(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `以下是"静静"的一段聊天记录（第${batchNum}批）。请提取她的语言特征、说话风格、常用词、emoji偏好、情感模式：

${messages.substring(0, 30000)}

请用中文输出分析结果，每行一个特征，格式: "- 特征描述"`,
      }],
      temperature: 0.3,
      max_tokens: 800,
    }),
  });
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

async function generateFinalSoul(batchInsights: string[], memories: Memory[]): Promise<string> {
  const memoryText = memories.map(m =>
    `- ${m.summary_text} (情感: ${m.emotion || '未知'})`
  ).join('\n');

  const res = await fetch(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `你是静静的角色设计师。请综合以下信息，生成一份完整的 SOUL.md 人格文件。

## 分批分析结果
${batchInsights.join('\n\n')}

## 结构化记忆
${memoryText}

## 输出格式
请严格按照以下 Markdown 格式输出（不要输出任何其他内容）：

# Personality
[3-5句话定义静静的性格核心、价值观、情感模式]

## Language Style
- [语言特征，至少8条，包含：句长偏好、常用语气词、emoji偏好、标点习惯、回复速度、话多话少、是否用网络用语]

## Relationship Memory
- [关键关系，至少5条，包含：重要的人、相处方式、共同经历]

## What to avoid
- [至少5条行为守则：什么不能说、什么语气不能用、什么话题要避免]

## Catchphrases
- [高频表达，列5-10个]`,
      }],
      temperature: 0.5,
      max_tokens: 2000,
    }),
  });
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

main().catch(console.error);
```

- [ ] **Step 2: 验证语法**

```bash
cd /home/dandelion/wechat-companion
npx ts-node --dry-run scripts/generate-soul.ts 2>&1 || true
# Expected: no syntax errors (will fail on DB connection without Docker, that's ok)
```

---

### Task 8: 启动与验证

- [ ] **Step 1: 重建并启动 Hermes**

```bash
cd /home/dandelion/wechat-companion

# 停止旧服务
docker compose stop weclaw-fastagent weclaw-bridge weixin-bridge

# 构建 Hermes
docker compose build hermes-companion

# 启动所有
docker compose up -d

# 检查状态
docker compose ps
# Expected: hermes-companion running, 旧服务 stopped
```

- [ ] **Step 2: 扫码连接微信**

```bash
# 进入 Hermes 容器配置微信
docker compose exec hermes-companion hermes gateway setup
# → 选择 weixin
# → 终端出现 QR 码（或 URL）
# → 用微信扫码
# → 看到 "微信连接成功"
```

- [ ] **Step 3: 放 SOUL.md**

```bash
# Phase 2 生成的 SOUL.md 放到 Hermes 数据目录
docker compose exec hermes-companion mkdir -p /app/data
docker cp hermes-data/SOUL.md hermes-companion:/app/data/SOUL.md
docker compose restart hermes-companion
```

- [ ] **Step 4: 端到端验证**

```bash
# 1. 微信给 bot 发 "你好"
# Expected: 收到带有静静风格的回复

# 2. 检查 api-server 是否收到 webhook
docker logs weclaw-api-server --tail 20 | grep HermesWebhook
# Expected: 📝 user: "你好" / 📝 assistant: "回复内容"

# 3. 检查 PostgreSQL 是否有新记录
docker exec weclaw-postgres psql -U weclaw -d weclaw_companion \
  -c "SELECT role, content, created_at FROM conversation_logs ORDER BY created_at DESC LIMIT 5;"
# Expected: 最近的对话记录

# 4. 确认旧服务未运行
docker compose ps weclaw-fastagent weclaw-bridge weixin-bridge
# Expected: "exited" 状态
```

---

### Task 9: 清理与提交

- [ ] **Step 1: 清理 docker-compose.yml 注释**

将 Task 3 中注释掉的服务定义整体删除（已在 git 中保留历史）。

- [ ] **Step 2: 移除 FastAgent 相关文件**

```bash
cd /home/dandelion/wechat-companion
rm -f fastagent.Dockerfile fastagent-entrypoint.sh fastagent-config.json message-forwarder.js
```

- [ ] **Step 3: 更新 .env 添加 ANTHROPIC_API_KEY**

```bash
echo "ANTHROPIC_API_KEY=your-key-here" >> .env
```

- [ ] **Step 4: Git 提交**

```bash
git add -A
git commit -m "feat: Hermes 全权接管微信消息处理

- 新增 hermes-companion 服务，用 Claude 驱动角色扮演
- SOUL.md 生成脚本 (从12K聊天记录提取人格)
- Hermes webhook bridge → api-server → PostgreSQL
- 停止 weclaw-bridge / weixin-bridge / fastagent
- 禁用 api-server iLink 轮询 (ILINK_POLLING_ENABLED=false)

Co-Authored-By: Claude <noreply@anthropic.com>"
```
