# BridgePage 多 Bot 管理 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BridgePage 支持多 Bot 管理：扫码前选角色、Bot 卡片列表、换角色、停用/删除。每个用户管理自己的 Bot。

**Architecture:** DB 加 `character_id` 列 → API 增强 `/bots` + 新增换角色端点 → 前端卡片化 + 添加面板 → Worker 复用已有 `loadActiveCharacter`。

**Tech Stack:** Express.js (routes), React+TypeScript+Ant Design (frontend), PostgreSQL

---

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `scripts/init-db-v6.sql` | 新增 `character_id` 列 |
| 修改 | `src/routes/bridge.ts` | GET bots 增强, POST register-bot 扩展, PUT character, DELETE owner-check |
| 修改 | `src/index.ts` | bridge routers 传入 req.user |
| 修改 | `dashboard/src/pages/BridgePage.tsx` | 重写为卡片+添加面板 |
| 修改 | `dashboard/src/components/Layout.tsx` | /bridge 移到普通菜单 |
| 修改 | `src/worker.ts` | 根据 bot.character_id 加载角色 prompt |

---

### Task 1: 数据库迁移脚本

**Files:**
- Create: `scripts/init-db-v6.sql`

- [ ] **Step 1: 创建迁移 SQL**

```sql
-- =============================================================================
-- v6: BridgePage 多 Bot 管理 — character_id 列
-- =============================================================================

-- bot_accounts 加角色关联
ALTER TABLE bot_accounts 
  ADD COLUMN IF NOT EXISTS character_id INTEGER 
  REFERENCES character_templates(id) ON DELETE SET NULL;

-- 索引加速按角色查询
CREATE INDEX IF NOT EXISTS idx_bot_accounts_character
  ON bot_accounts(character_id) WHERE character_id IS NOT NULL;

-- linked_user_id 索引 (已有列但未使用)
CREATE INDEX IF NOT EXISTS idx_bot_accounts_linked_user
  ON bot_accounts(linked_user_id) WHERE linked_user_id IS NOT NULL;
```

- [ ] **Step 2: 执行迁移**

```bash
docker exec weclaw-postgres psql -U weclaw -d weclaw_companion -f /docker-entrypoint-initdb.d/06-init-v6.sql 2>&1
# Expected: ALTER TABLE, CREATE INDEX
```

- [ ] **Step 3: 在 docker-compose.yml 挂载**

```yaml
- ./scripts/init-db-v6.sql:/docker-entrypoint-initdb.d/06-init-v6.sql:ro
```

- [ ] **Step 4: Commit**

```bash
git add scripts/init-db-v6.sql docker-compose.yml
git commit -m "feat: add character_id column to bot_accounts"
```

---

### Task 2: 后端 — GET /api/bridge/bots 增强

**Files:**
- Modify: `src/routes/bridge.ts:178-191`

- [ ] **Step 1: 重写 GET /bots**

```typescript
/**
 * GET /api/bridge/bots
 * 返回 Bot 列表。普通用户只看自己的；管理员看全部。
 * 新增返回 character 信息。
 */
router.get('/bridge/bots', authenticate, async (req: Request, res: Response) => {
  try {
    await syncOpeniLinkBots().catch(() => {});

    const currentUserId = (req as any).user?.id;
    const isAdmin = (req as any).user?.role === 'admin';

    let query: string;
    let params: any[];

    if (isAdmin) {
      query = `SELECT b.id, b.bot_id, b.wechat_id, b.nickname, b.bot_index,
                      b.is_active, b.last_active_at, b.created_at,
                      b.character_id, b.linked_user_id,
                      ct.name AS character_name, ct.tagline AS character_tagline
               FROM bot_accounts b
               LEFT JOIN character_templates ct ON b.character_id = ct.id
               WHERE b.deleted_at IS NULL
               ORDER BY b.bot_index`;
      params = [];
    } else {
      query = `SELECT b.id, b.bot_id, b.wechat_id, b.nickname, b.bot_index,
                      b.is_active, b.last_active_at, b.created_at,
                      b.character_id, b.linked_user_id,
                      ct.name AS character_name, ct.tagline AS character_tagline
               FROM bot_accounts b
               LEFT JOIN character_templates ct ON b.character_id = ct.id
               WHERE b.deleted_at IS NULL AND b.linked_user_id = $1
               ORDER BY b.bot_index`;
      params = [currentUserId];
    }

    const result = await pgPool.query(query, params);
    const bots = result.rows.map((r: any) => ({
      id: r.id,
      bot_id: r.bot_id,
      wechat_id: r.wechat_id,
      nickname: r.nickname,
      bot_index: r.bot_index,
      is_active: r.is_active,
      last_active_at: r.last_active_at,
      created_at: r.created_at,
      character: r.character_id ? {
        id: r.character_id,
        name: r.character_name,
        tagline: r.character_tagline,
      } : null,
    }));

    const connected = bots.some((b: any) => b.is_active);
    res.json({ bots, total: bots.length, connected });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 2: 编译 + 重启验证**

```bash
npx tsc && docker compose build api-server && docker compose up -d api-server
curl -s -H "Authorization: Bearer $(node -e "require('./dist/auth').getToken?.()" 2>/dev/null || echo test)" http://localhost:3000/api/bridge/bots
# Expected: { "bots": [...], "total": N, "connected": bool }
```

---

### Task 3: 后端 — POST register-bot 扩展 + PUT character + DELETE owner-check

**Files:**
- Modify: `src/routes/bridge.ts:92-135` (register-bot)
- Add: `src/routes/bridge.ts` — PUT character 端点
- Modify: `src/routes/bridge.ts:253-289` (DELETE owner-check)

- [ ] **Step 1: 扩展 register-bot 接受 character_id 和 linked_user_id**

Replace the INSERT statement in line 110-122:

```typescript
// 注册 Bot（扩展：支持 character_id 和 linked_user_id）
const { botId, apiToken, botToken, getUpdatesBuf, ilinkUserId, ilinkBaseUrl, wechatId, nickname, botIndex, character_id, linked_user_id } = req.body;

await pgPool.query(
  `INSERT INTO bot_accounts (bot_id, api_token, bot_token, get_updates_buf, ilink_user_id, ilink_base_url, wechat_id, nickname, bot_index, character_id, linked_user_id, is_active)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
   ON CONFLICT (bot_id)
   DO UPDATE SET api_token = $2, bot_token = COALESCE($3, bot_accounts.bot_token),
                 get_updates_buf = COALESCE($4, bot_accounts.get_updates_buf),
                 ilink_user_id = COALESCE($5, bot_accounts.ilink_user_id),
                 ilink_base_url = COALESCE($6, bot_accounts.ilink_base_url),
                 wechat_id = COALESCE($7, bot_accounts.wechat_id),
                 nickname = COALESCE($8, bot_accounts.nickname),
                 linked_user_id = COALESCE($11, bot_accounts.linked_user_id),
                 character_id = COALESCE($10, bot_accounts.character_id),
                 last_active_at = NOW()`,
  [botId, apiToken, botToken || null, getUpdatesBuf || '', ilinkUserId || null, ilinkBaseUrl || 'https://ilinkai.weixin.qq.com', wechatId || null, nickname || null, botIndex ?? 0, character_id || null, linked_user_id || null]
);

// 如果有 character_id，同步激活 user_characters
if (character_id && linked_user_id) {
  // 创建或更新 user_characters
  await pgPool.query(
    `INSERT INTO user_characters (user_id, template_id, linked_wechat_id, is_active)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (user_id, template_id, linked_wechat_id)
     DO UPDATE SET is_active = TRUE, updated_at = NOW()`,
    [linked_user_id, character_id, wechatId || botId]
  );
}
```

- [ ] **Step 2: 新增 PUT /api/bridge/bots/:id/character**

```typescript
/**
 * PUT /api/bridge/bots/:id/character
 * 更换 Bot 的角色
 * Body: { character_id: number }
 */
router.put('/bridge/bots/:id/character', authenticate, async (req: Request, res: Response) => {
  try {
    const botId = parseInt(req.params.id);
    const { character_id } = req.body;
    const currentUserId = (req as any).user?.id;
    const isAdmin = (req as any).user?.role === 'admin';

    if (!character_id) {
      res.status(400).json({ error: '缺少 character_id' });
      return;
    }

    // 权限检查：admin 或 bot owner
    const bot = await pgPool.query(
      'SELECT linked_user_id, wechat_id FROM bot_accounts WHERE id = $1 AND deleted_at IS NULL',
      [botId]
    );
    if (bot.rows.length === 0) {
      res.status(404).json({ error: 'Bot 不存在' });
      return;
    }
    if (!isAdmin && bot.rows[0].linked_user_id !== currentUserId) {
      res.status(403).json({ error: '无权限' });
      return;
    }

    await pgPool.query(
      'UPDATE bot_accounts SET character_id = $1 WHERE id = $2',
      [character_id, botId]
    );

    // 同步 user_characters
    const wechatId = bot.rows[0].wechat_id;
    if (currentUserId && wechatId) {
      await pgPool.query(
        `INSERT INTO user_characters (user_id, template_id, linked_wechat_id, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (user_id, template_id, linked_wechat_id)
         DO UPDATE SET template_id = $2, is_active = TRUE, updated_at = NOW()`,
        [currentUserId, character_id, wechatId]
      );
    }

    console.log(`[Bot] 🔄 ${botId} 角色 → ${character_id}`);
    res.json({ ok: true });
  } catch (error: any) {
    console.error('[Bot] 换角色失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 3: 加强 DELETE owner 检查**

在 `router.delete('/bridge/bots/:id'...` 中添加:

```typescript
const currentUserId = (req as any).user?.id;
const isAdmin = (req as any).user?.role === 'admin';

// 非管理员只能操作自己的 bot
const botCheck = await pgPool.query(
  'SELECT linked_user_id FROM bot_accounts WHERE id = $1', [botId]
);
if (!isAdmin && botCheck.rows[0]?.linked_user_id !== currentUserId) {
  res.status(403).json({ error: '无权限操作此 Bot' });
  return;
}
```

- [ ] **Step 4: 编译 + Commit**

```bash
npx tsc && git add src/routes/bridge.ts && git commit -m "feat: register-bot with character, PUT character endpoint, DELETE owner check"
```

---

### Task 4: 前端 — BridgePage 重写

**Files:**
- Modify: `dashboard/src/pages/BridgePage.tsx` (287→~200 lines)

- [ ] **Step 1: 重写 BridgePage.tsx**

```tsx
import React, { useEffect, useState, useRef } from 'react';
import { Typography, Card, Tag, Space, Button, Grid, Popconfirm, message, Select, Empty } from 'antd';
import { PlusOutlined, ReloadOutlined, DeleteOutlined, StopOutlined, PlayCircleOutlined, SwapOutlined, LinkOutlined } from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';
import api from '../api/client';

const { Title, Text } = Typography;
const { useBreakpoint } = Grid;

interface CharacterBrief {
  id: number;
  name: string;
  tagline: string | null;
}

interface BotInfo {
  id: number;
  bot_id: string;
  nickname: string | null;
  is_active: boolean;
  last_active_at: string;
  created_at: string;
  character: CharacterBrief | null;
}

export default function BridgePage() {
  const { user } = useAuth();
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  const [bots, setBots] = useState<BotInfo[]>([]);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [selectedCharId, setSelectedCharId] = useState<number | undefined>(undefined);
  const [characters, setCharacters] = useState<CharacterBrief[]>([]);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [changingId, setChangingId] = useState<number | null>(null);
  const [qrTs, setQrTs] = useState(Date.now());
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifiedRef = useRef(false);

  // 加载可用角色列表
  const loadCharacters = async () => {
    try {
      const { data } = await api.get('/characters/list/mine');
      setCharacters(data?.characters || []);
    } catch { /* ignore */ }
  };

  // 加载 Bot 列表
  const fetchBots = async () => {
    try {
      const { data } = await api.get('/bridge/bots');
      const newBots: BotInfo[] = data?.bots || [];
      setBots(newBots);
      if (newBots.some(b => b.is_active) && !notifiedRef.current) {
        notifiedRef.current = true;
        setShowAddPanel(false);
        message.success('🎉 Bot 连接成功！');
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadCharacters();
    fetchBots();
    pollingRef.current = setInterval(fetchBots, 5000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []);

  // 换角色
  const handleChangeChar = async (botId: number, characterId: number) => {
    setChangingId(botId);
    try {
      await api.put(`/bridge/bots/${botId}/character`, { character_id: characterId });
      message.success('角色已更新');
      fetchBots();
    } catch (err: any) {
      message.error(err.response?.data?.error || '更换失败');
    }
    setChangingId(null);
  };

  // 停用
  const handleDeactivate = async (botId: number) => {
    setTogglingId(botId);
    try {
      await api.delete(`/bridge/bots/${botId}?permanent=false`);
      message.success('已停用');
      fetchBots();
    } catch (err: any) {
      message.error(err.response?.data?.error || '操作失败');
    }
    setTogglingId(null);
  };

  // 删除
  const handleDelete = async (botId: number) => {
    setDeletingId(botId);
    try {
      await api.delete(`/bridge/bots/${botId}?permanent=true`);
      message.success('已删除');
      notifiedRef.current = false;
      fetchBots();
    } catch (err: any) {
      message.error(err.response?.data?.error || '删除失败');
    }
    setDeletingId(null);
  };

  const botActions = (bot: BotInfo) => (
    <Space size="small" wrap>
      <Select
        size="small"
        style={{ minWidth: 110 }}
        placeholder="换角色"
        value={bot.character?.id}
        loading={changingId === bot.id}
        onChange={(cid) => handleChangeChar(bot.id, cid)}
        options={characters.map(c => ({ value: c.id, label: c.name }))}
        suffixIcon={<SwapOutlined />}
      />
      {bot.is_active && (
        <Popconfirm
          title="停用后将不再处理该 Bot 的消息"
          onConfirm={() => handleDeactivate(bot.id)}
          okText="确定停用" cancelText="取消"
        >
          <Button size="small" icon={<StopOutlined />} loading={togglingId === bot.id}>
            停用
          </Button>
        </Popconfirm>
      )}
      <Popconfirm
        title="永久删除此 Bot？此操作不可恢复"
        onConfirm={() => handleDelete(bot.id)}
        okText="永久删除" cancelText="取消"
        okButtonProps={{ danger: true }}
      >
        <Button size="small" danger icon={<DeleteOutlined />} loading={deletingId === bot.id} />
      </Popconfirm>
    </Space>
  );

  return (
    <div style={{ maxWidth: 700, margin: '0 auto' }}>
      {/* 头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={isMobile ? 5 : 4} style={{ margin: 0 }}>
          <LinkOutlined style={{ marginRight: 8 }} />My Bots ({bots.length})
        </Title>
        <Button type="primary" icon={<PlusOutlined />}
          onClick={() => { setShowAddPanel(!showAddPanel); loadCharacters(); }}>
          添加 Bot
        </Button>
      </div>

      {/* 添加面板 */}
      {showAddPanel && (
        <Card size="small" style={{ marginBottom: 16, background: '#f6ffed' }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <Text strong>① 选择角色：</Text>
              <Select
                style={{ width: '100%', marginTop: 8 }}
                placeholder="选一个角色给这个 Bot"
                value={selectedCharId}
                onChange={setSelectedCharId}
                options={characters.map(c => ({
                  value: c.id,
                  label: `${c.name}${c.tagline ? ' — ' + c.tagline : ''}`,
                }))}
                allowClear
              />
            </div>
            <div style={{ textAlign: 'center' }}>
              <Text strong>② 扫描二维码：</Text>
              <div style={{ margin: '8px 0', background: '#fff', borderRadius: 8, padding: 8 }}>
                <img src={`/qr.svg?t=${qrTs}`} alt="微信扫码"
                  style={{ width: 220, height: 220 }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              </div>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => setQrTs(Date.now())}>
                刷新二维码
              </Button>
              <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                扫码后约 30 秒内自动检测并连接
              </Text>
            </div>
            <Button block onClick={() => { setShowAddPanel(false); setSelectedCharId(undefined); }}>
              取消
            </Button>
          </Space>
        </Card>
      )}

      {/* Bot 列表 */}
      {bots.length === 0 && !showAddPanel ? (
        <Card style={{ textAlign: 'center' }}>
          <Empty description="还没有 Bot，点上方「添加 Bot」开始" />
        </Card>
      ) : (
        bots.map(bot => (
          <Card key={bot.id} size="small" style={{ marginBottom: 8 }}
            title={
              <Space>
                <Text strong>{bot.character?.name || '未分配角色'}</Text>
                <Tag color={bot.is_active ? 'green' : 'default'}>
                  {bot.is_active ? 'Active' : 'Inactive'}
                </Tag>
              </Space>
            }
            extra={
              <Text type="secondary" style={{ fontSize: 11 }}>
                {bot.last_active_at ? new Date(bot.last_active_at).toLocaleString('zh-CN') : ''}
              </Text>
            }
          >
            <div style={{ marginBottom: 4 }}>
              <Text code style={{ fontSize: 11 }} copyable>{bot.bot_id}</Text>
            </div>
            {bot.character?.tagline && (
              <Text type="secondary" style={{ fontSize: 12 }}>{bot.character.tagline}</Text>
            )}
            <div style={{ marginTop: 8 }}>
              {botActions(bot)}
            </div>
          </Card>
        ))
      )}

      {/* 未连接时的后备 QR（无 Bot 或添加面板未开） */}
      {bots.length === 0 && !showAddPanel && (
        <Card style={{ textAlign: 'center', marginTop: 16, background: '#fafafa' }}>
          <img src={`/qr.svg?t=${qrTs}`} alt="QR" style={{ width: 180, height: 180 }} />
          <br />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => setQrTs(Date.now())}>刷新</Button>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 编译前端验证**

```bash
cd dashboard && npx tsc --noEmit 2>&1
# Expected: no errors
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/pages/BridgePage.tsx && git commit -m "feat: rewrite BridgePage with multi-bot card UI and add panel"
```

---

### Task 5: 前端 — Layout 菜单调整

**Files:**
- Modify: `dashboard/src/components/Layout.tsx:34-41`

- [ ] **Step 1: 移动 /bridge 到普通菜单**

```tsx
const commonItems = [
  { key: '/', icon: <DashboardOutlined />, label: '首页概览' },
  { key: '/profile', icon: <UserOutlined />, label: '我的' },
  { key: '/characters', icon: <SmileOutlined />, label: '角色管理' },
  { key: '/bridge', icon: <LinkOutlined />, label: '微信桥接' },   // ← 移到这里
  { key: '/import', icon: <ImportOutlined />, label: '聊天导入' },
  { key: '/stickers', icon: <PictureOutlined />, label: '表情包' },
];
const adminItems = user?.role === 'admin' ? [
  { key: '/users', icon: <UserOutlined />, label: '用户管理' },
  { key: '/conversations', icon: <MessageOutlined />, label: '对话浏览' },
  { key: '/queue', icon: <MonitorOutlined />, label: '队列监控' },
  { key: '/admin-logs', icon: <SettingOutlined />, label: '操作日志' },
  // /bridge 移除
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
] : [];
```

- [ ] **Step 2: 编译 + Commit**

```bash
cd dashboard && npx tsc --noEmit && git add dashboard/src/components/Layout.tsx && git commit -m "feat: move /bridge to common menu for all users"
```

---

### Task 6: Worker — 根据 bot.character_id 加载角色

**Files:**
- Modify: `src/worker.ts` — 在消息处理入口添加 bot character 查找

- [ ] **Step 1: 在 processJob 中注入 bot 角色**

在 worker.ts 处理消息的函数（约 line 200-250, `processJob` 或类似名称）中，`loadActiveCharacter` 调用之前，添加 bot 角色查找逻辑：

```typescript
// 优先从 bot_accounts.character_id 加载角色
let characterPrompt: string | null = null;
if (job.data.botId) {
  const botChar = await pgPool.query(
    `SELECT ct.system_prompt, ct.personality, ct.name, ct.description,
            ct.example_dialogue, uc.custom_personality, uc.custom_prompt
     FROM bot_accounts b
     LEFT JOIN character_templates ct ON b.character_id = ct.id
     LEFT JOIN user_characters uc ON uc.template_id = ct.id AND uc.linked_wechat_id = $2
     WHERE b.bot_id = $1 AND b.character_id IS NOT NULL
     LIMIT 1`,
    [job.data.botId, job.data.wechatId]
  );
  if (botChar.rows.length > 0) {
    characterPrompt = buildCharacterPrompt(botChar.rows[0]);
  }
}

// Fallback: 已有的 loadActiveCharacter 逻辑
if (!characterPrompt) {
  characterPrompt = await loadActiveCharacter(userId, job.data.wechatId);
}
```

- [ ] **Step 2: 编译 + Commit**

```bash
npx tsc && git add src/worker.ts && git commit -m "feat: worker loads character from bot_accounts.character_id first"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 重建所有服务**

```bash
docker compose build api-server bull-worker dashboard
docker compose up -d
```

- [ ] **Step 2: 打开 BridgePage 测试**

```bash
# 浏览器访问 http://localhost:8080/bridge
# 1. 页面应显示 "My Bots (0)" + [+ 添加 Bot] 按钮
# 2. 点 [+ 添加 Bot] → 展开面板：角色下拉 + QR 码
# 3. 选角色 → 扫码 → 自动检测连接
# 4. Bot 卡片出现在列表，显示角色名和状态
# 5. 换角色下拉正常工作
# 6. 停用/启用/删除正常
# 7. 微信发消息 → AI 用对应角色回复
```

- [ ] **Step 3: 检查数据库**

```bash
docker exec weclaw-postgres psql -U weclaw -d weclaw_companion \
  -c "SELECT bot_id, character_id, linked_user_id, is_active FROM bot_accounts WHERE deleted_at IS NULL;"
# Expected: 每行有 character_id 和 linked_user_id
```

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: complete BridgePage multi-bot management

- DB: character_id column on bot_accounts
- API: enhanced GET /bots with character info, PUT character endpoint
- API: register-bot accepts character_id + linked_user_id
- API: DELETE owner check
- Frontend: card-based Bot list with add panel
- Layout: /bridge available to all users
- Worker: bot character lookup for persona prompt

Co-Authored-By: Claude <noreply@anthropic.com>"
```
