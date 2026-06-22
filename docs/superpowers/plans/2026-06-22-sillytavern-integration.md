# SillyTavern 角色引擎接入 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 SillyTavern 作为角色引擎接入微信陪伴AI，Hermes 退化为微信收发桥接，ST 接管角色扮演+记忆+LLM调用。

**Architecture:** Hermes (iLink微信) → hermes-st-relay (Node.js WebSocket路由) → ST容器×N (角色引擎) → DeepSeek API。Docker多实例部署，BridgePage做总控台。

**Tech Stack:** Node.js, WebSocket (ws), Docker Compose, SillyTavern (官方镜像), React + Ant Design, PostgreSQL

**Spec:** `docs/superpowers/specs/2026-06-22-sillytavern-integration-design.md`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `scripts/hermes-st-relay.js` | **Create** | 核心中继：Hermes JSONL → ST WebSocket → iLink发送 |
| `scripts/generate-st-compose.js` | **Create** | 根据DB活跃Bot动态生成 docker-compose.st.yml |
| `scripts/convert-to-st-charcard.ts` | **Create** | PG角色 → SillyTavern角色卡JSON |
| `src/routes/st-manager.ts` | **Create** | ST实例管理 REST API |
| `nginx.conf` | **Modify** | 添加ST反向代理 |
| `docker-compose.yml` | **Modify** | 添加ST服务模板 |
| `src/index.ts` | **Modify** | 挂载ST管理路由 |
| `dashboard/src/pages/BridgePage.tsx` | **Modify** | Bot卡片增强(ST状态/启停/聊天入口) |
| `dashboard/src/App.tsx` | **Modify** | 添加ST代理路由跳转 |

---

### Task 1: SillyTavern Docker 基础部署

**Files:**
- Create: `docker-compose.st.yml`
- Modify: `nginx.conf`
- Modify: `docker-compose.yml`

- [ ] **Step 1: 拉取 ST 镜像并手动测试**

```bash
docker pull sillytavern/sillytavern:latest
# 临时跑一个实例验证
docker run -d --name st-test -p 8001:8000 sillytavern/sillytavern:latest
# 确认 Web UI 可访问
curl -s http://localhost:8001/ | head -c 100
# 应该返回 HTML
```

Expected: 看到 ST 的登录/启动页面 HTML。

- [ ] **Step 2: 停止测试容器并准备数据目录**

```bash
docker rm -f st-test
mkdir -p st-data/default/characters
mkdir -p st-data/default/chats
mkdir -p st-data/default/worlds
```

- [ ] **Step 3: 写静态 docker-compose.st.yml (先单实例验证)**

```yaml
# docker-compose.st.yml
services:
  st-default:
    image: sillytavern/sillytavern:latest
    container_name: weclaw-st-default
    ports:
      - "127.0.0.1:8001:8000"
    volumes:
      - ./st-data/default:/home/node/app/data
    environment:
      - STORAGE_PATH=/home/node/app/data
    restart: unless-stopped
    networks:
      - companion-net

networks:
  companion-net:
    external: true
```

- [ ] **Step 4: 启动 ST 容器**

```bash
docker compose -f docker-compose.st.yml up -d
sleep 5
docker ps --filter name=weclaw-st-default --format '{{.Names}} {{.Status}}'
curl -s -o /dev/null -w "%{http_code}" http://localhost:8001/
```

Expected: `weclaw-st-default Up X seconds` + `200`

- [ ] **Step 5: 添加 Nginx 反向代理，统一从 8080 访问**

在 `nginx.conf` 的 `server` 块中添加：

```nginx
# SillyTavern Web UI 代理
location /st/ {
    rewrite ^/st/([^/]+)/?(.*)$ /$2 break;
    proxy_pass http://host.docker.internal:8001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

- [ ] **Step 6: 重建 Nginx 并验证代理**

```bash
docker compose up -d --force-recreate nginx
sleep 3
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/st/
```

Expected: `200`

- [ ] **Step 7: 在 ST 中配置 DeepSeek API**

手动操作 (ST Web UI 在 http://localhost:8080/st/):
1. 打开 API Connections → Text Completion
2. 选择 "Custom (OpenAI-compatible)"
3. 填入 DeepSeek API URL + Key
4. 保存并测试连接

- [ ] **Step 8: Commit**

```bash
git add docker-compose.st.yml nginx.conf
git commit -m "feat: SillyTavern Docker基础部署 + Nginx代理"
```

---

### Task 2: 编写 hermes-st-relay 核心中继

**Files:**
- Create: `scripts/hermes-st-relay.js`

- [ ] **Step 1: 写中继脚本**

```javascript
#!/usr/bin/env node
/**
 * hermes-st-relay.js
 * Hermes ↔ SillyTavern 核心中继
 *
 * 1. 监听 Hermes gateway JSONL 日志，提取收到的微信消息
 * 2. 通过 WebSocket 转发到对应 SillyTavern 实例
 * 3. 接收 ST 回复，通过 iLink API 发回微信
 */

const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');

// === 配置 ===
const HERMES_LOG = process.env.HERMES_LOG ||
  '/home/dandelion/.hermes/logs/gateway.log';
const PG_URL = process.env.DATABASE_URL ||
  'postgresql://weclaw:weclaw_secret@localhost:5432/weclaw_companion';
const ILINK_BASE = process.env.ILINK_BASE ||
  'https://ilinkai.weixin.qq.com';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '500', 10);
const RECONNECT_DELAY = parseInt(process.env.RECONNECT_DELAY || '3000', 10);

// === Bot → ST 映射缓存 ===
const botStMap = new Map(); // bot_id → { wsUrl, characterId, botToken, wechatId }
let pg = null;

// === PostgreSQL 连接 ===
function getPg() {
  if (!pg) {
    pg = new Pool({ connectionString: PG_URL });
  }
  return pg;
}

// === 加载活跃 Bot → ST 映射 ===
async function loadBotMappings() {
  const client = await getPg().connect();
  try {
    const { rows } = await client.query(`
      SELECT b.bot_id, b.bot_token, b.wechat_id, b.character_id,
             b.ilink_user_id, b.ilink_base_url,
             ct.name as char_name
      FROM bot_accounts b
      LEFT JOIN character_templates ct ON b.character_id = ct.id
      WHERE b.is_active = TRUE AND b.deleted_at IS NULL
    `);
    for (const row of rows) {
      // ST 实例 URL: ws://st-bot-{N}:8000
      // 先用固定映射，后续 Task 4 改成动态
      const port = 8000 + (row.bot_index || 0);
      botStMap.set(row.bot_id, {
        wsUrl: `ws://localhost:${port}/ws`,
        characterId: row.character_id,
        botToken: row.bot_token,
        wechatId: row.wechat_id,
        ilinkBaseUrl: row.ilink_base_url || ILINK_BASE,
        charName: row.char_name,
      });
    }
    console.log(`[relay] Loaded ${botStMap.size} bot→ST mappings`);
  } finally {
    client.release();
  }
}

// === WebSocket 连接池: bot_id → WebSocket ===
const wsPool = new Map();

function connectToST(botId, wsUrl) {
  if (wsPool.has(botId)) {
    try { wsPool.get(botId).close(); } catch {}
  }

  const ws = new WebSocket(wsUrl);
  wsPool.set(botId, ws);

  ws.on('open', () => {
    console.log(`[relay] ✅ Connected to ST: ${botId} @ ${wsUrl}`);
  });

  ws.on('message', (data) => {
    try {
      const reply = JSON.parse(data.toString());
      if (reply.type === 'reply' && reply.content) {
        sendToWeChat(botId, reply);
      }
    } catch (e) {
      console.error(`[relay] ST response parse error:`, e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[relay] ⚠️ ST disconnected: ${botId}, reconnecting in ${RECONNECT_DELAY}ms`);
    wsPool.delete(botId);
    setTimeout(() => connectToST(botId, wsUrl), RECONNECT_DELAY);
  });

  ws.on('error', (err) => {
    console.error(`[relay] ❌ ST WebSocket error [${botId}]:`, err.message);
  });

  return ws;
}

// === 发送消息到微信 (iLink API) ===
async function sendToWeChat(botId, reply) {
  const mapping = botStMap.get(botId);
  if (!mapping) {
    console.error(`[relay] Unknown bot: ${botId}`);
    return;
  }

  const body = JSON.stringify({
    base_info: { channel_version: '2.2.0' },
    msg: {
      from_user_id: '',
      to_user_id: reply.user_id || mapping.wechatId,
      client_id: `hermes-st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: reply.content } }],
    },
  });

  const url = `${mapping.ilinkBaseUrl}/ilink/bot/sendmessage`;
  try {
    const httpModule = url.startsWith('https') ? require('https') : require('http');
    const urlObj = new URL(url);
    const req = httpModule.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'AuthorizationType': 'ilink_bot_token',
        'Authorization': `Bearer ${mapping.botToken}`,
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': '131584',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`[relay] ✅ Sent: "${reply.content.substring(0, 30)}" via ${botId}`);
        } else {
          console.error(`[relay] ❌ Send failed (${res.statusCode}): ${data}`);
        }
      });
    });
    req.on('error', (e) => console.error(`[relay] ❌ iLink error:`, e.message));
    req.write(body);
    req.end();
  } catch (e) {
    console.error(`[relay] ❌ Send error:`, e.message);
  }
}

// === 监听 Hermes JSONL 日志 ===
let lastSize = 0;
try { lastSize = fs.statSync(HERMES_LOG).size; } catch {}

function processHermesLog() {
  try {
    const stat = fs.statSync(HERMES_LOG);
    if (stat.size <= lastSize) return;

    const fd = fs.openSync(HERMES_LOG, 'r');
    const buf = Buffer.alloc(Math.min(stat.size - lastSize, 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, lastSize);
    fs.closeSync(fd);
    lastSize = stat.size;

    const lines = buf.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type !== 'message_received') continue;

        const botId = event.bot_id || Object.keys(Object.fromEntries(botStMap))[0];
        const mapping = botStMap.get(botId);
        if (!mapping) continue;

        // 包装成富协议
        const payload = {
          type: 'message',
          user_id: event.from || event.sender?.id || 'unknown',
          nickname: event.sender?.name || '',
          content: event.content || event.text || '',
          media_type: event.msg_type || 'text',
          media_url: event.media_url || null,
          bot_id: botId,
          timestamp: event.timestamp || Math.floor(Date.now() / 1000),
          context: {
            recent_history: event.recent_history || [],
            emotion: event.emotion || { label: 'neutral', confidence: 0.5 },
            memories: [],
          },
          status: { typing: false, read: true },
        };

        // 确保 ST 连接存在
        let ws = wsPool.get(botId);
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          ws = connectToST(botId, mapping.wsUrl);
          // 连接建立中，跳过此消息（TODO: 加发送队列）
          console.log(`[relay] ST connecting for ${botId}, message queued to retry`);
          continue;
        }

        ws.send(JSON.stringify(payload));
        console.log(`[relay] 📩 Relayed: "${payload.content.substring(0, 30)}" → ${mapping.charName}`);
      } catch (e) {
        // 跳过解析失败的行
      }
    }
  } catch (e) {
    // 文件尚未创建
  }
}

// === 启动 ===
async function main() {
  console.log('[relay] Starting Hermes↔ST relay');
  await loadBotMappings();

  for (const [botId, mapping] of botStMap) {
    connectToST(botId, mapping.wsUrl);
  }

  // 每 30 秒刷新 Bot 映射
  setInterval(() => loadBotMappings().catch(e =>
    console.error('[relay] refresh failed:', e.message)), 30000);

  // 轮询 Hermes 日志
  setInterval(processHermesLog, POLL_INTERVAL);
  console.log(`[relay] Watching ${HERMES_LOG}`);
}

main().catch(e => { console.error('[relay] Fatal:', e); process.exit(1); });

// 优雅退出
process.on('SIGINT', () => {
  for (const ws of wsPool.values()) ws.close();
  if (pg) pg.end();
  process.exit(0);
});
```

- [ ] **Step 2: 安装依赖**

```bash
npm install ws
```

- [ ] **Step 3: 确认 Hermes 日志路径存在**

```bash
ls -la /home/dandelion/.hermes/logs/gateway.log 2>/dev/null || echo "日志文件不存在，检查Hermes配置"
# 如果不存在，可能需要配置 Hermes 开启 JSONL 日志输出
```

- [ ] **Step 4: 手动测试 relay 启动**

```bash
# 先确保 ST 容器在跑
docker compose -f docker-compose.st.yml ps
# 测试 relay (Ctrl+C 退出)
node scripts/hermes-st-relay.js
```

Expected: 看到 `[relay] Loaded N bot→ST mappings` 和 `[relay] ✅ Connected to ST`

- [ ] **Step 5: Commit**

```bash
git add scripts/hermes-st-relay.js package.json package-lock.json
git commit -m "feat: hermes-st-relay 核心中继 — Hermes↔ST WebSocket桥接"
```

---

### Task 3: 角色迁移脚本

**Files:**
- Create: `scripts/convert-to-st-charcard.ts`

- [ ] **Step 1: 写转换脚本**

```typescript
#!/usr/bin/env tsx
/**
 * convert-to-st-charcard.ts
 * 将 PostgreSQL character_templates 转换为 SillyTavern chara_card_v2 格式
 *
 * 用法: npx tsx scripts/convert-to-st-charcard.ts [--all] [--id=N]
 *    --all    转换所有角色 (默认)
 *    --id=N   只转换指定ID的角色
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const PG_URL = process.env.DATABASE_URL ||
  'postgresql://weclaw:weclaw_secret@localhost:5432/weclaw_companion';
const OUTPUT_DIR = path.join(__dirname, '..', 'st-data', 'default', 'characters');

interface CharacterRow {
  id: number;
  name: string;
  tagline: string;
  description: string;
  personality: string;
  scenario: string;
  first_message: string;
  example_dialogue: string;
  system_prompt: string;
  post_history: string;
  tags: string[];
  category: string;
  metadata: Record<string, any>;
}

// PG → ST 字段映射
function rowToCharCard(row: CharacterRow) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: row.name,
      description: row.tagline || '',
      personality: row.personality || '',
      scenario: row.scenario || '',
      first_mes: row.first_message || '',
      mes_example: row.example_dialogue || '',
      system_prompt: row.system_prompt || '',
      post_history_instructions: row.post_history || '',
      creator_notes: `Imported from wechat-companion. Category: ${row.category}`,
      character_version: row.metadata?.card_version || '1.0',
      alternate_greetings: [],
      tags: row.tags || [],
      creator: '',
      extensions: row.metadata || {},
    },
  };
}

async function convertAll() {
  const pg = new Pool({ connectionString: PG_URL });

  // 获取所有官方+自定义角色
  const { rows }: { rows: CharacterRow[] } = await pg.query(
    `SELECT * FROM character_templates
     WHERE is_official = TRUE OR category IN ('preset', 'custom', 'imported')
     ORDER BY id`
  );
  console.log(`Found ${rows.length} characters to convert`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const row of rows) {
    const charCard = rowToCharCard(row);
    const safeName = row.name.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_');

    // 写 JSON 格式
    const jsonPath = path.join(OUTPUT_DIR, `${safeName}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(charCard, null, 2), 'utf-8');
    console.log(`  ✅ ${row.name} → ${safeName}.json`);
  }

  await pg.end();
  console.log(`\nDone! ${rows.length} character cards written to ${OUTPUT_DIR}`);
  console.log('Next: Copy these into your SillyTavern data/default-user/characters/');
}

// 处理额外来源: SOUL.md + persona.txt
function convertHermesFiles() {
  const hermesDir = path.join(require('os').homedir(), '.hermes');
  const soulPath = path.join(hermesDir, 'SOUL.md');
  const personaPath = path.join(hermesDir, 'persona.txt');

  // SOUL.md → "Change" 角色卡
  if (fs.existsSync(soulPath)) {
    const soulContent = fs.readFileSync(soulPath, 'utf-8');
    const changeCard = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Change',
        description: '核心人格 — 成长型伴侣，外冷内热',
        personality: soulContent,
        scenario: '',
        first_mes: '你好，我是Change。',
        mes_example: '',
        system_prompt: soulContent,
        tags: ['核心人格', 'Hermes'],
        creator_notes: 'Converted from Hermes SOUL.md',
        extensions: { source: 'hermes_soul_md' },
      },
    };
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'Change.json'),
      JSON.stringify(changeCard, null, 2), 'utf-8'
    );
    console.log('  ✅ SOUL.md → Change.json');
  }

  // persona.txt → "王静" 角色卡 + Lorebook
  if (fs.existsSync(personaPath)) {
    const personaContent = fs.readFileSync(personaPath, 'utf-8');
    // 解析 persona.txt 中的统计信息作为角色属性
    const wangJingCard = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '王静',
        description: '21岁 · 巨蟹座 · ISFJ · 基于17,708条真实聊天记录',
        personality: personaContent,
        scenario: '分手三个月的ex，微信聊天场景',
        first_mes: '嗯',
        mes_example: `用户: 在干嘛\n王静: 躺着`,
        system_prompt: personaContent,
        tags: ['前任', 'ISFJ', '真实数据', '微信'],
        creator_notes: 'Converted from Hermes persona.txt — 17,708 real messages',
        extensions: {
          source: 'hermes_persona_txt',
          real_messages: 17708,
          avg_message_length: 7.5,
          active_hours: '0-2AM',
          response_median_seconds: 18,
        },
      },
    };
    fs.writeFileSync(
      path.join(OUTPUT_DIR, '王静.json'),
      JSON.stringify(wangJingCard, null, 2), 'utf-8'
    );
    console.log('  ✅ persona.txt → 王静.json');
  }
}

// Main
(async () => {
  await convertAll();
  convertHermesFiles();
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 运行转换脚本**

```bash
npx tsx scripts/convert-to-st-charcard.ts
```

Expected: 输出转换的角色列表 (6预设 + SOUL.md → Change + persona.txt → 王静 = ~8个角色卡)

- [ ] **Step 3: 验证输出**

```bash
ls -la st-data/default/characters/
# 应该有多个 .json 文件
# 验证一个文件格式
cat st-data/default/characters/王静.json | head -30
```

- [ ] **Step 4: 将角色卡复制到 ST 数据卷**

```bash
# ST 容器挂载了 ./st-data/default 到 /home/node/app/data
# ST 的角色目录是 data/default-user/characters/
mkdir -p st-data/default-user/characters
cp st-data/default/characters/*.json st-data/default-user/characters/
docker compose -f docker-compose.st.yml restart st-default
```

- [ ] **Step 5: 在 ST Web UI 验证角色可见**

在 http://localhost:8080/st/ → Character Management → 检查角色列表

- [ ] **Step 6: Commit**

```bash
git add scripts/convert-to-st-charcard.ts st-data/
git commit -m "feat: PG角色→ST角色卡批量转换脚本"
```

---

### Task 4: 多实例编排

**Files:**
- Create: `scripts/generate-st-compose.js`
- Modify: `src/routes/st-manager.ts`

- [ ] **Step 1: 写 compose 生成脚本**

```javascript
#!/usr/bin/env node
/**
 * generate-st-compose.js
 * 从 bot_accounts 表生成 docker-compose.st.yml
 *
 * 用法: node scripts/generate-st-compose.js
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PG_URL = process.env.DATABASE_URL ||
  'postgresql://weclaw:weclaw_secret@localhost:5432/weclaw_companion';
const OUTPUT = path.join(__dirname, '..', 'docker-compose.st.yml');
const ST_IMAGE = 'sillytavern/sillytavern:latest';
const BASE_PORT = 8001;

async function generate() {
  const pg = new Pool({ connectionString: PG_URL });
  const { rows } = await pg.query(`
    SELECT bot_id, bot_index, character_id, ct.name as char_name
    FROM bot_accounts b
    LEFT JOIN character_templates ct ON b.character_id = ct.id
    WHERE b.is_active = TRUE AND b.deleted_at IS NULL
    ORDER BY bot_index
  `);
  await pg.end();

  if (rows.length === 0) {
    // 无活跃 Bot, 生成默认占位
    const fallback = `# Auto-generated by generate-st-compose.js
# No active bots. ST services disabled.

services: {}
networks:
  companion-net:
    external: true
`;
    fs.writeFileSync(OUTPUT, fallback);
    console.log('No active bots. ST compose cleared.');
    return;
  }

  let services = '';
  for (const row of rows) {
    const port = BASE_PORT + (row.bot_index || 0);
    const safeId = row.bot_id.replace(/[@.]/g, '-');
    const charName = (row.char_name || 'default').replace(/[^a-zA-Z0-9一-鿿_-]/g, '_');

    services += `
  st-${safeId}:
    image: ${ST_IMAGE}
    container_name: weclaw-st-${safeId}
    ports:
      - "127.0.0.1:${port}:8000"
    volumes:
      - ./st-data/${safeId}:/home/node/app/data
    environment:
      - STORAGE_PATH=/home/node/app/data
    restart: unless-stopped
    networks:
      - companion-net
`;
  }

  const compose = `# Auto-generated by generate-st-compose.js
# Generated at: ${new Date().toISOString()}
# Active bots: ${rows.length}

services:${services}
networks:
  companion-net:
    external: true
`;

  fs.writeFileSync(OUTPUT, compose);
  console.log(`Generated docker-compose.st.yml with ${rows.length} bot(s)`);
  console.log(rows.map(r => `  ${r.bot_id} → port ${BASE_PORT + r.bot_index} (${r.char_name})`).join('\n'));
}

generate().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 运行生成 + 启动**

```bash
node scripts/generate-st-compose.js
docker compose -f docker-compose.st.yml up -d
docker ps --filter name=weclaw-st
```

- [ ] **Step 3: Commit**

```bash
git add scripts/generate-st-compose.js docker-compose.st.yml
git commit -m "feat: ST多实例编排 — 动态compose生成脚本"
```

---

### Task 5: ST 管理 API

**Files:**
- Create: `src/routes/st-manager.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 写 ST 管理路由**

```typescript
// src/routes/st-manager.ts
import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { Pool } from 'pg';
import * as path from 'path';

const router = Router();
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const COMPOSE_FILE = path.join(PROJECT_ROOT, 'docker-compose.st.yml');

function dockerExec(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: PROJECT_ROOT }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function getContainerName(botId: string): Promise<string> {
  const safeId = botId.replace(/[@.]/g, '-');
  return `weclaw-st-${safeId}`;
}

// GET /api/st/bots/:id/status
router.get('/bots/:id/status', async (req: Request, res: Response) => {
  try {
    const containerName = await getContainerName(req.params.id);
    const result = await dockerExec(
      `docker inspect --format '{{json .State}}' ${containerName} 2>/dev/null || echo '{"Running":false}'`
    );
    const state = JSON.parse(result);
    res.json({
      running: state.Running || false,
      status: state.Status || 'not-found',
      startedAt: state.StartedAt || null,
      error: state.Error || '',
    });
  } catch (e: any) {
    res.json({ running: false, status: 'error', error: e.message });
  }
});

// POST /api/st/bots/:id/start
router.post('/bots/:id/start', async (req: Request, res: Response) => {
  try {
    const containerName = await getContainerName(req.params.id);
    await dockerExec(`docker compose -f ${COMPOSE_FILE} start ${containerName}`);
    res.json({ ok: true, action: 'started' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/st/bots/:id/stop
router.post('/bots/:id/stop', async (req: Request, res: Response) => {
  try {
    const containerName = await getContainerName(req.params.id);
    await dockerExec(`docker compose -f ${COMPOSE_FILE} stop ${containerName}`);
    res.json({ ok: true, action: 'stopped' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/st/bots/:id/restart
router.post('/bots/:id/restart', async (req: Request, res: Response) => {
  try {
    const containerName = await getContainerName(req.params.id);
    await dockerExec(`docker compose -f ${COMPOSE_FILE} restart ${containerName}`);
    res.json({ ok: true, action: 'restarted' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/st/bots/:id/create — 为新 Bot 创建 ST 实例
router.post('/bots/:id/create', async (req: Request, res: Response) => {
  try {
    const botId = req.params.id;
    // 1. 运行 generate-st-compose.js
    await dockerExec(`node ${path.join(PROJECT_ROOT, 'scripts', 'generate-st-compose.js')}`);
    // 2. 启动新容器
    await dockerExec(`docker compose -f ${COMPOSE_FILE} up -d`);
    // 3. 等待 ST 启动
    await new Promise(r => setTimeout(r, 3000));
    // 4. 检查状态
    const containerName = await getContainerName(botId);
    const state = await dockerExec(
      `docker inspect --format '{{json .State}}' ${containerName}`
    );
    res.json({ ok: true, state: JSON.parse(state) });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
```

- [ ] **Step 2: 在 index.ts 中挂载路由**

在 `src/index.ts` 中找到路由挂载位置，添加：

```typescript
import stManager from './routes/st-manager';
// ... 在 app.use() 区域 ...
app.use('/api/st', stManager);
```

- [ ] **Step 3: 测试 API**

```bash
# 重启 api-server
docker compose restart api-server
sleep 3

# 获取当前活跃 bot
BOT_ID=$(docker exec weclaw-postgres psql -U weclaw -d weclaw_companion -t -A -c "SELECT bot_id FROM bot_accounts WHERE is_active=TRUE LIMIT 1;")

# 测试状态查询
curl -s http://localhost:3000/api/st/bots/$BOT_ID/status | jq
```

Expected: `{"running": true, "status": "running", ...}`

- [ ] **Step 4: Commit**

```bash
git add src/routes/st-manager.ts src/index.ts
git commit -m "feat: ST实例管理API — 启停/状态/创建"
```

---

### Task 6: BridgePage 扩展

**Files:**
- Modify: `dashboard/src/pages/BridgePage.tsx`
- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: 增强 Bot 卡片组件**

在 `BridgePage.tsx` 的 Bot 卡片渲染中添加 ST 状态和控制：

找到 Bot 卡片的 JSX 渲染部分，在现有信息下方添加：

```tsx
// 在 Bot 卡片组件内添加 state
const [stStatus, setStStatus] = React.useState<{
  running: boolean; status: string; error?: string;
} | null>(null);

// 获取 ST 状态
const fetchStStatus = async (botId: string) => {
  try {
    const res = await api.get(`/api/st/bots/${botId}/status`);
    setStStatus(res.data);
  } catch { setStStatus(null); }
};

// 在 useEffect 中定时轮询 ST 状态
React.useEffect(() => {
  if (bot.bot_id) {
    fetchStStatus(bot.bot_id);
    const timer = setInterval(() => fetchStStatus(bot.bot_id), 10000);
    return () => clearInterval(timer);
  }
}, [bot.bot_id]);

// 在 Card 的 extra 区域添加 ST 控制按钮
// 添加到 Card 内的 actions 或 extra 属性
<Space>
  <Tag color={stStatus?.running ? 'green' : stStatus ? 'red' : 'default'}>
    {stStatus?.running ? 'ST:运行中' : stStatus?.status === 'not-found' ? 'ST:未创建' : 'ST:已停止'}
  </Tag>
  {stStatus?.running ? (
    <>
      <Button size="small" onClick={() => window.open(`/st/`, '_blank')}>
        聊天
      </Button>
      <Button size="small" danger
        onClick={async () => {
          await api.post(`/api/st/bots/${bot.bot_id}/stop`);
          fetchStStatus(bot.bot_id);
        }}>
        停止
      </Button>
    </>
  ) : stStatus?.status === 'not-found' ? (
    <Button size="small" type="primary"
      onClick={async () => {
        await api.post(`/api/st/bots/${bot.bot_id}/create`);
        fetchStStatus(bot.bot_id);
      }}>
      创建ST实例
    </Button>
  ) : (
    <Button size="small"
      onClick={async () => {
        await api.post(`/api/st/bots/${bot.bot_id}/start`);
        fetchStStatus(bot.bot_id);
      }}>
      启动ST
    </Button>
  )}
</Space>
```

- [ ] **Step 2: 添加 ST 代理跳转**

在 `App.tsx` 中添加路由：

```tsx
// 如果当前路径是 /st，跳转到 Nginx 代理的 ST Web UI
{window.location.pathname.startsWith('/st/') && (
  <Redirect to={`${window.location.pathname}${window.location.search}`} />
)}
```

注意：ST 的 Web UI 由 Nginx 直接代理，React Router 不需要处理 `/st/` 开头的路径。确保 Nginx 配置中 `/st/` 在 SPA fallback 之前匹配。

- [ ] **Step 3: 构建并验证**

```bash
cd dashboard && npm run build
docker compose restart api-server
```

访问 http://localhost:8080/bridge → 查看 Bot 卡片是否显示 ST 状态标签和控制按钮

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/pages/BridgePage.tsx dashboard/src/App.tsx
git commit -m "feat: BridgePage ST管理扩展 — 状态监控+启停+聊天入口"
```

---

### Task 7: hermes-st-relay systemd 服务化

**Files:**
- Create: `~/.config/systemd/user/hermes-st-relay.service`

- [ ] **Step 1: 写 systemd service 文件**

```bash
cat > ~/.config/systemd/user/hermes-st-relay.service << 'EOF'
[Unit]
Description=Hermes ↔ SillyTavern Message Relay
After=hermes-gateway.service docker.service
Requires=hermes-gateway.service

[Service]
Type=simple
WorkingDirectory=/home/dandelion/wechat-companion
ExecStart=/home/dandelion/.local/node/bin/node /home/dandelion/wechat-companion/scripts/hermes-st-relay.js
Restart=always
RestartSec=5
# 环境变量
Environment=HERMES_LOG=/home/dandelion/.hermes/logs/gateway.log
Environment=DATABASE_URL=postgresql://weclaw:weclaw_secret@localhost:5432/weclaw_companion

[Install]
WantedBy=default.target
EOF
```

- [ ] **Step 2: 启用并启动**

```bash
systemctl --user daemon-reload
systemctl --user enable hermes-st-relay.service
systemctl --user start hermes-st-relay.service
sleep 3
systemctl --user status hermes-st-relay.service --no-pager
```

Expected: `active (running)`

- [ ] **Step 3: Commit**

```bash
git add ~/.config/systemd/user/hermes-st-relay.service
git commit -m "feat: hermes-st-relay systemd服务化"
```

---

### Task 8: 端到端测试

- [ ] **Step 1: 检查所有服务健康**

```bash
# Docker 服务
docker ps --format '{{.Names}} {{.Status}}'
# Hermes
systemctl --user status hermes-gateway.service --no-pager | head -5
# Relay
systemctl --user status hermes-st-relay.service --no-pager | head -5
# Sync
systemctl --user status hermes-sync.service --no-pager | head -5
```

所有服务应该都是 active/running。

- [ ] **Step 2: 测试 ST Web UI 访问**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/st/
```

Expected: `200`

- [ ] **Step 3: 测试 ST 管理 API**

```bash
# 获取 Bot ID
BOT_ID=$(docker exec weclaw-postgres psql -U weclaw -d weclaw_companion -t -A -c "SELECT bot_id FROM bot_accounts WHERE is_active=TRUE LIMIT 1;")
echo "Bot: $BOT_ID"

# 状态
curl -s http://localhost:3000/api/st/bots/$BOT_ID/status | jq

# 如果 ST 未创建
curl -s -X POST http://localhost:3000/api/st/bots/$BOT_ID/create | jq
```

- [ ] **Step 4: 发送测试微信消息**

从微信发一条消息给 Bot，观察 relay 日志：

```bash
journalctl --user -u hermes-st-relay.service -f --no-pager
```

Expected: 看到 `[relay] 📩 Relayed: "..." → 角色名`

- [ ] **Step 5: 验证 AI 回复**

检查 Bot 是否回复了消息（通过 ST → relay → iLink → 微信）。

```bash
# 查看最近的回复
journalctl --user -u hermes-st-relay.service --no-pager -n 20 | grep "Sent:"
```

- [ ] **Step 6: 验证对话同步到 PG**

```bash
docker exec weclaw-postgres psql -U weclaw -d weclaw_companion -c "SELECT role, content, created_at FROM conversation_logs ORDER BY created_at DESC LIMIT 5;"
```

- [ ] **Step 7: 在 BridgePage 验证 UI**

打开 http://localhost:8080/bridge，检查：
- Bot 卡片显示 ST 状态
- "聊天" 按钮可打开 ST Web UI
- 启停按钮可用

- [ ] **Step 8: 最后提交 + 推送**

```bash
git add -A
git commit -m "chore: 端到端测试通过 + 文档更新"
GIT_SSL_NO_VERIFY=1 git push
```

---

### 后续手动任务 (不在本次自动执行范围内)

**角色精细打磨:**
1. 打开 ST Web UI → Character Management
2. 选择"王静"角色卡 → 编辑
3. 优化 first_mes (首条消息)
4. 添加 mes_example (3-5轮示例对话)
5. 配置 Lorebook 条目 (关系设定、用户偏好)
6. 选择"温柔前任"重复以上步骤

**Hermes 配置确认:**
- 确认 Hermes 输出 JSONL 日志到 `/home/dandelion/.hermes/logs/gateway.log`
- 如未开启，需在 config.yaml 中添加日志配置
