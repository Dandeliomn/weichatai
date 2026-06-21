# Redeploy from Backup & Fix P0 Issues — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync backup files to local project, redeploy with Docker Compose, and fix two P0 blocking issues: (1) QR code not displayable on web, (2) message sending returns 401.

**Architecture:** The backup introduces a `weixin-bridge` service (Node.js) that generates WeChat login QR codes via the WeChat web protocol, replacing the FastAgent-based QR reading. The `weclaw-bridge` uses WeClawBot-API for multi-account message handling. Fixes: properly route weixin-bridge through nginx, update frontend to call new endpoints, and fix token extraction in bridge-forward.sh so the correct api_token is stored in bot_accounts.

**Tech Stack:** Docker Compose, Node.js/Express, React/TypeScript, Nginx, WeClawBot-API, PostgreSQL

---

## Pre-flight: Environment Check

- [ ] **Step 1: Verify Docker is available**

```bash
docker --version && docker compose version
```

- [ ] **Step 2: Check current running containers**

```bash
docker ps -a --format "table {{.Names}}\t{{.Status}}"
```

---

### Task 1: Sync Backup Files to Project

**Files:**
- Create: `weixin-bridge.js` (project root)
- Modify: `bridge-forward.sh`
- Modify: `weclaw-bridge.Dockerfile`
- Modify: `src/routes/bridge.ts`
- Modify: `src/utils/weclawClient.ts`
- Modify: `src/index.ts`
- Modify: `src/middleware/security.ts`
- Modify: `dashboard/src/pages/BridgePage.tsx`
- Modify: `dashboard/src/components/Layout.tsx`
- Modify: `docker-compose.yml`
- Modify: `nginx.conf`
- Create: `scripts/init-db-v5.sql`

- [ ] **Step 1: Copy all changed source files from backup**

```bash
# src/ files
cp /tmp/wechat-extract/root/src/index.ts /home/dandelion/wechat-companion/src/index.ts
cp /tmp/wechat-extract/root/src/routes/bridge.ts /home/dandelion/wechat-companion/src/routes/bridge.ts
cp /tmp/wechat-extract/root/src/utils/weclawClient.ts /home/dandelion/wechat-companion/src/utils/weclawClient.ts
cp /tmp/wechat-extract/root/src/middleware/security.ts /home/dandelion/wechat-companion/src/middleware/security.ts

# dashboard files
cp /tmp/wechat-extract/root/dashboard/src/pages/BridgePage.tsx /home/dandelion/wechat-companion/dashboard/src/pages/BridgePage.tsx
cp /tmp/wechat-extract/root/dashboard/src/components/Layout.tsx /home/dandelion/wechat-companion/dashboard/src/components/Layout.tsx
cp /tmp/wechat-extract/root/dashboard/src/pages/Login.tsx /home/dandelion/wechat-companion/dashboard/src/pages/Login.tsx
cp /tmp/wechat-extract/root/dashboard/src/pages/Register.tsx /home/dandelion/wechat-companion/dashboard/src/pages/Register.tsx

# bridge + infra files
cp /tmp/wechat-extract/root/weixin-bridge.js /home/dandelion/wechat-companion/weixin-bridge.js
cp /tmp/wechat-extract/root/bridge-forward.sh /home/dandelion/wechat-companion/bridge-forward.sh
cp /tmp/wechat-extract/root/weclaw-bridge.Dockerfile /home/dandelion/wechat-companion/weclaw-bridge.Dockerfile

# docker + nginx + db
cp /tmp/wechat-extract/www/wwwroot/chatai.lightmoment.cn/docker-compose.yml /home/dandelion/wechat-companion/docker-compose.yml
cp /tmp/wechat-extract/www/wwwroot/chatai.lightmoment.cn/nginx.conf /home/dandelion/wechat-companion/nginx.conf
cp /tmp/wechat-extract/root/scripts/init-db-v5.sql /home/dandelion/wechat-companion/scripts/init-db-v5.sql
```

- [ ] **Step 2: Verify all files copied correctly**

```bash
cd /home/dandelion/wechat-companion && ls -la weixin-bridge.js bridge-forward.sh weclaw-bridge.Dockerfile scripts/init-db-v5.sql
```

- [ ] **Step 3: Commit the sync (if git repo)**

```bash
cd /home/dandelion/wechat-companion && git add -A && git status
```

---

### Task 2: Fix QR Code Web Display (P0 #1)

**Problem:** `weixin-bridge` service in docker-compose has issues:
1. Uses main `Dockerfile` which runs `dist/index.js` as CMD — but command override `["node", "weixin-bridge.js"]` needs the JS file at WORKDIR
2. The main Dockerfile WORKDIR is `/app`, volume mounts `./weixin-bridge.js:/app/weixin-bridge.js:ro` — this works but `node_modules` aren't available (weixin-bridge.js only uses built-in `http`/`https` modules, so this is fine)
3. `weixin-bridge` port `3200` only bound to `127.0.0.1` — browser can't reach it
4. No nginx route for weixin-bridge — frontend can't call it
5. BridgePage.tsx still calls `/api/bridge/qr` (Express route that reads FastAgent logs)

**Fix strategy:**
- Fix docker-compose: change weixin-bridge to use `node:20-alpine` image directly (no build needed)
- Add nginx proxy routes for weixin-bridge endpoints
- Update BridgePage.tsx to use weixin-bridge endpoints with fallback to Express

- [ ] **Step 1: Fix weixin-bridge service in docker-compose.yml**

Read the current docker-compose.yml, find the `weixin-bridge` service section:

```yaml
  # ===========================================================================
  # 微信二维码桥接服务 - 生成登录二维码
  # ===========================================================================
  weixin-bridge:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: weclaw-weixin-bridge
    command: ["node", "weixin-bridge.js"]
    volumes:
      - ./weixin-bridge.js:/app/weixin-bridge.js:ro
    ports:
      - "127.0.0.1:3200:3200"
    restart: unless-stopped
    networks:
      - companion-net
```

Replace with:

```yaml
  # ===========================================================================
  # 微信二维码桥接服务 - 生成登录二维码
  # 使用轻量 node 镜像直接运行，无需编译
  # ===========================================================================
  weixin-bridge:
    image: node:20-alpine
    container_name: weclaw-weixin-bridge
    working_dir: /app
    command: ["node", "weixin-bridge.js"]
    volumes:
      - ./weixin-bridge.js:/app/weixin-bridge.js:ro
    restart: unless-stopped
    networks:
      - companion-net
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://localhost:3200/bridge/qr"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 5s
```

Note: Remove the `ports` mapping entirely — access will go through nginx only.

- [ ] **Step 2: Add weixin-bridge proxy to nginx.conf**

Read nginx.conf, find the server block. Add before the `/api/` location:

```nginx
        # Weixin Bridge — 微信二维码生成与扫码轮询
        set $weixin_bridge "http://weixin-bridge:3200";

        location /bridge/qr {
            proxy_pass $weixin_bridge;
            proxy_set_header Host $host;
        }

        location /bridge/poll {
            proxy_pass $weixin_bridge;
            proxy_set_header Host $host;
        }

        location /bridge/login {
            proxy_pass $weixin_bridge;
            proxy_set_header Host $host;
        }
```

- [ ] **Step 3: Update BridgePage.tsx to call weixin-bridge endpoints**

The current `QrCodeView` component calls `/api/bridge/qr` (Express route). Update to try weixin-bridge first, fall back to Express:

Replace the `fetchQr` function in `QrCodeView`:

```typescript
  const fetchQr = async () => {
    try {
      // 优先使用 weixin-bridge（新版二维码服务）
      let qrData;
      try {
        const { data } = await api.get('/bridge/qr');  // nginx proxies to weixin-bridge:3200
        if (data.qrCodeUrl) qrData = data;
      } catch {
        // 回退: 使用 Express 读取 FastAgent 日志
        const { data } = await api.get('/api/bridge/qr');
        if (data.qrCodeUrl) qrData = data;
      }

      if (qrData?.qrCodeUrl) setQrUrl(qrData.qrCodeUrl);
      if (qrData?.connected) {
        setConnected(true);
        if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
      }
      setLoading(false);
      setError(null);
    } catch (err: any) {
      setError('获取二维码失败: ' + (err?.response?.data?.error || err.message));
      setLoading(false);
    }
  };
```

Also update the status polling to try weixin-bridge poll endpoint:

```typescript
  const fetchStatus = async () => {
    try {
      // Try weixin-bridge poll endpoint
      const { data } = await api.get('/bridge/poll?tip=0');
      if (data.code === 201) {
        // 已登录，完成 session 获取
        await api.get(`/bridge/login?redirect=${encodeURIComponent(data.redirect)}`);
        setConnected(true);
        if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
      }
    } catch {
      // Fallback to Express status
      try {
        const { data } = await api.get('/bridge/status');
        if (data.connected) {
          setConnected(true);
          if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
        }
      } catch {}
    }
  };
```

And update the "waiting" message since it won't be FastAgent-specific:

```typescript
          <Alert type="info" message="等待微信二维码生成..." showIcon style={{ textAlign: 'left' }} />
```

- [ ] **Step 4: Verify nginx.conf syntax**

```bash
docker run --rm -v /home/dandelion/wechat-companion/nginx.conf:/etc/nginx/nginx.conf:ro nginx:alpine nginx -t
```

Expected: "syntax is ok" and "test is successful"

---

### Task 3: Fix Message Sending 401 (P0 #2)

**Problem:** `weclawClient.sendMessage()` calls WeClawBot-API with a token that's invalid. Root cause: `bridge-forward.sh` extracts the token with an unreliable regex from the `bot` CLI `/bots` output. The correct token is in `config/auth.json`.

**WeClawBot-API auth (from docs):**
- Token via `Authorization: Bearer <token>` header OR `token=<token>` query param
- Endpoint: `GET/POST /bots/{bot_id}/messages`
- Token stored in `config/auth.json` inside the container

**Fix strategy:**
1. Fix `bridge-forward.sh` to read token from `auth.json` instead of scraping CLI output
2. Update `weclawClient.ts` to prefer Bearer token header (more reliable)
3. Ensure `bot_accounts` table gets the correct token

- [ ] **Step 1: Fix token extraction in bridge-forward.sh**

Read `bridge-forward.sh`, find the `bot_registrar` function. Replace the token extraction:

Old (broken regex):
```bash
TOKEN=$(/usr/local/bin/bot -port 26322 /bots 2>/dev/null | grep "$REG_BOT" | grep -oP 'token[=: ]*\K[a-zA-Z0-9_]+' || echo "auto-$REG_BOT")
```

New (read from auth.json directly):
```bash
# 从 WeClaw 的 auth.json 读取正确的 api_token
# auth.json 格式: {"bots": [{"bot_id": "xxx@im.bot", "api_token": "yyy", ...}]}
if [ -f /app/config/auth.json ]; then
  TOKEN=$(python3 -c "
import json, sys
try:
    with open('/app/config/auth.json') as f:
        data = json.load(f)
    bots = data.get('bots', [])
    for b in bots:
        if b.get('bot_id') == '$REG_BOT':
            print(b.get('api_token', ''))
            break
except: pass
" 2>/dev/null)
fi
if [ -z "$TOKEN" ]; then
  TOKEN=$(grep -oP '"api_token"\s*:\s*"\K[^"]+' /app/config/auth.json 2>/dev/null | head -1)
fi
if [ -z "$TOKEN" ]; then
  TOKEN="auto-$REG_BOT"
fi
```

Wait — the container might not have python3. Let's use a pure-shell approach:

```bash
# 从 auth.json 用 grep 提取 token
if [ -f /app/config/auth.json ]; then
  # auth.json 每行一个 bot: {"bot_id":"xxx","api_token":"yyy"}
  TOKEN=$(grep -o "\"api_token\"\s*:\s*\"[^\"]*\"" /app/config/auth.json | head -1 | sed 's/.*: *"//' | sed 's/"//')
fi
if [ -z "$TOKEN" ]; then
  TOKEN="auto-$REG_BOT"
fi
```

- [ ] **Step 2: Update weclawClient.ts to use Bearer token (more reliable)**

Read `weclawClient.ts`. In the `sendMessage` method, change the primary send path to use `Authorization: Bearer` header instead of query param:

Find (~line 124-131):
```typescript
    if (targetBot && apiToken) {
      try {
        const resp = await axios.get(
          `${this.apiUrl}/bots/${encodeURIComponent(targetBot)}/messages`,
          { params: { token: apiToken, text }, timeout: 15000 }
        );
```

Replace with:
```typescript
    if (targetBot && apiToken) {
      try {
        const resp = await axios.get(
          `${this.apiUrl}/bots/${encodeURIComponent(targetBot)}/messages`,
          {
            params: { text },
            headers: { 'Authorization': `Bearer ${apiToken}` },
            timeout: 15000,
          }
        );
```

Also update the fallback path (~line 141-156) similarly:
```typescript
    if (this.apiToken && this.botId) {
      try {
        const response = await this.http.get<WeClawResponse>(
          `/bots/${encodeURIComponent(targetBot || this.botId)}/messages`,
          { params: { text } }
        );
```

The `this.http` instance already has `Authorization: Bearer ${this.apiToken}` in its default headers, so the fallback is fine.

- [ ] **Step 3: Also update sendTypingStatus similarly**

Find (~line 177-183):
```typescript
      const response = await this.http.get<WeClawResponse>(
        `/bots/${encodeURIComponent(targetBot)}/typing`,
        {
          params: {
            token: this.apiToken,
            status: status,
          },
        }
      );
```

Replace with:
```typescript
      const response = await this.http.get<WeClawResponse>(
        `/bots/${encodeURIComponent(targetBot)}/typing`,
        { params: { status } }
      );
```

The `this.http` already has `Authorization: Bearer` header, so we just remove the redundant `token` param.

- [ ] **Step 4: Verify the fixes compile**

```bash
cd /home/dandelion/wechat-companion && npx tsc --noEmit 2>&1 | head -50
```

Expected: No TypeScript errors (or only pre-existing ones).

---

### Task 4: Build and Deploy

- [ ] **Step 1: Build TypeScript**

```bash
cd /home/dandelion/wechat-companion && npm run build
```

Expected: `dist/` directory created with compiled JS files.

- [ ] **Step 2: Stop existing containers (if any)**

```bash
cd /home/dandelion/wechat-companion && docker compose down
```

- [ ] **Step 3: Build Docker images**

```bash
cd /home/dandelion/wechat-companion && docker compose build --no-cache api-server bull-worker weclaw-bridge
```

- [ ] **Step 4: Start all services**

```bash
cd /home/dandelion/wechat-companion && docker compose up -d
```

- [ ] **Step 5: Wait for health checks and verify**

```bash
# Wait 30s then check
sleep 30 && docker compose ps
```

Expected: All services `healthy` or `running`.

- [ ] **Step 6: Verify API health**

```bash
curl -s http://localhost:3000/health | python3 -m json.tool 2>/dev/null || curl -s http://localhost:3000/health
```

Expected: `{"status":"ok",...}` or `{"status":"degraded",...}`

- [ ] **Step 7: Verify weixin-bridge QR endpoint**

```bash
curl -s http://localhost:3200/bridge/qr
```

Expected: `{"qrCodeUrl":"https://login.weixin.qq.com/l/...","uuid":"..."}` (or 500 if WeChat API fails)

- [ ] **Step 8: Verify nginx routing**

```bash
curl -s http://localhost:8080/bridge/qr
curl -s http://localhost:8080/health
```

Expected: QR JSON response + health JSON response.

- [ ] **Step 9: Check logs for errors**

```bash
docker compose logs --tail=30 api-server weixin-bridge weclaw-bridge
```

---

### Task 5: Post-Deploy Verification

- [ ] **Step 1: Run the verification checklist**

1. QR code displays on BridgePage (`http://localhost:8080` → 连接微信)
2. WeClaw bridge can receive messages (check: `docker compose logs weclaw-bridge | grep "Forwarding"`)
3. Messages go through webhook → queue → worker → reply (send a test message)
4. Reply successfully sends back to WeChat (check: `docker compose logs bull-worker | grep "回复已发送"`)
5. No 401 errors in logs (`docker compose logs bull-worker | grep "401"`)

- [ ] **Step 2: If 401 persists, debug token**

```bash
# Check what token is stored in bot_accounts
docker compose exec api-server node -e "
const { Pool } = require('pg');
const p = new Pool({connectionString:'postgresql://weclaw:weclaw_secret@postgres:5432/weclaw_companion'});
p.query('SELECT * FROM bot_accounts').then(r => { console.log(JSON.stringify(r.rows, null, 2)); p.end(); });
"

# Check the actual token in WeClaw config
docker compose exec weclaw-bridge cat /app/config/auth.json 2>/dev/null || echo "No auth.json yet (no bot logged in)"
```

- [ ] **Step 3: Manual bot login if needed**

```bash
# If no bot is logged in, manually login via terminal
docker compose exec weclaw-bridge /usr/local/bin/bot -port 26322
# Then type: /login → scan QR → /bots → exit
```

---

## Known Risks

1. **weixin-bridge.js uses deprecated WeChat Web API** (`login.wx.qq.com`) — many accounts can no longer use this. If it fails, fall back to FastAgent QR reading or terminal-based login.
2. **WeClawBot-API stability** — the project is labeled "灰度中，可用性待观察" (beta). Auth token format may change.
3. **Database migration** — `init-db-v5.sql` creates `bot_accounts` table. If the table already exists, `CREATE TABLE IF NOT EXISTS` handles it, but on existing databases the migration SQL isn't auto-mounted (only runs on first init). May need manual `docker compose exec postgres psql ... < scripts/init-db-v5.sql`.
