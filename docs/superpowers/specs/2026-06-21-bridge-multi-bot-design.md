# BridgePage 多 Bot 管理 — 设计方案

## 目标

BridgePage 支持用户添加多个微信 Bot，每个 Bot 绑定不同角色，各自独立运行。

## 用户场景

1. 用户打开 Bridge 页面，看到自己的 Bot 列表（含角色名和状态）
2. 点 "+ 添加 Bot"，选角色 → 扫码 → Bot 自动注册并关联角色
3. 可随时给 Bot 换角色、停用/启用、删除
4. 多个 Bot 各自用不同角色回复消息

## UI 设计

```
┌──────────────────────────────────────────┐
│  My Bots (2)                    [+ 添加]  │
│  ┌────────────────────────────────────┐  │
│  │ 🤖 温柔女友  🟢 Active              │  │
│  │    [换角色▾]  [停用]  [删除]        │  │
│  ├────────────────────────────────────┤  │
│  │ 🤖 毒舌死党  🟢 Active              │  │
│  │    [换角色▾]  [停用]  [删除]        │  │
│  └────────────────────────────────────┘  │
│                                          │
│  [+ 添加] 展开后:                         │
│  ┌────────────────────────────────────┐  │
│  │ ① 选择角色:  [温柔女友 ▾]           │  │
│  │ ② 扫描二维码:                       │  │
│  │    ┌──────────┐                    │  │
│  │    │  QR 码   │                    │  │
│  │    └──────────┘                    │  │
│  │                        [取消]       │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

### 组件树

```
BridgePage
├── BotList
│   └── BotCard × N (每个 Bot 一张卡片)
│       ├── 角色名 + 状态 Tag (Active/Inactive)
│       ├── ChangeCharacterButton (下拉选角色)
│       ├── ToggleButton (停用/启用)
│       └── DeleteButton (Popconfirm)
└── AddBotPanel (可展开/收起)
    ├── CharacterSelect (下拉，用户可用角色)
    ├── QRCode (img src="/qr.svg")
    └── CancelButton
```

## 数据库变更

```sql
-- bot_accounts 加角色关联
ALTER TABLE bot_accounts 
  ADD COLUMN IF NOT EXISTS character_id INTEGER 
  REFERENCES character_templates(id) ON DELETE SET NULL;
```

`linked_user_id` 已存在但未使用 — 此功能开始写入。

## API 设计

### `GET /api/bridge/bots` — 增强

- **认证:** 需要登录（不再是公开接口）
- **权限:** 普通用户只返回自己的 bot (`linked_user_id = current_user`)；管理员返回全部
- **新增字段:** `character: { id, name, tagline } | null`

```json
{
  "bots": [{
    "id": 1,
    "bot_id": "xxx@im.bot",
    "nickname": "静静",
    "is_active": true,
    "character": { "id": 5, "name": "温柔女友", "tagline": "..." },
    "last_active_at": "...",
    "created_at": "..."
  }],
  "total": 2
}
```

### `POST /api/bridge/register-bot` — 扩展

WeClaw 扫码后调用。**新增接收字段：**

```
Body 新增:
  linked_user_id?: number   // 前台传入当前用户ID
  character_id?: number     // 扫码前选的角色ID
```

如果 `character_id` 存在：
1. 写入 `bot_accounts.character_id`
2. 写入 `user_characters` 激活记录

### `PUT /api/bridge/bots/:id/character` — 新增

更换 Bot 的角色。

```
Body: { character_id: number }
认证: 需要登录 + 是 bot 的 owner 或 admin
```

操作：
1. 更新 `bot_accounts.character_id`
2. 更新 `user_characters` 记录

### `GET /api/bridge/bots/:id` — 新增

获取单个 Bot 详情。

### 其他端点不变

- `DELETE /api/bridge/bots/:id` — 已有，加上 owner 检查
- QR 码相关端点 — 不变

## 前端改动

### BridgePage.tsx

| 部分 | 改动 |
|------|------|
| 顶部 | 显示 `My Bots (N)` + `[+ 添加 Bot]` 按钮 |
| Bot 列表 | 从 Table 改为卡片列表，每张卡片展示角色名+状态+操作 |
| 添加面板 | `showAddPanel` 状态控制展开，含角色选择+QR码 |
| 轮询 | 保留 5s 轮询，但只刷新列表不弹通知 |

### 状态变量

```typescript
const [bots, setBots] = useState<BotInfo[]>([])
const [showAddPanel, setShowAddPanel] = useState(false)
const [selectedCharacterId, setSelectedCharacterId] = useState<number | null>(null)
const [changingId, setChangingId] = useState<number | null>(null)
```

### API 调用

| 方法 | 端点 | 用途 |
|------|------|------|
| GET | `/api/bridge/bots` | 获取我的 Bot 列表 |
| PUT | `/api/bridge/bots/:id/character` | 换角色 |
| DELETE | `/api/bridge/bots/:id` | 停用/删除 Bot |

### Layout.tsx

`/bridge` 菜单从 admin-only 移到所有用户可见。

## Worker 变更

`worker.ts` 处理消息时，根据 `bot_id` 查找 `bot_accounts.character_id`，使用对应角色的 persona prompt。

```typescript
// 在 worker 中
const botResult = await pgPool.query(
  'SELECT character_id FROM bot_accounts WHERE bot_id = $1',
  [botId]
);
const characterId = botResult.rows[0]?.character_id;
if (characterId) {
  // 加载 character_templates.system_prompt 注入到消息上下文
}
```

## 边界条件

- 删除 Bot 时：`is_active=false, deleted_at=now()`，保留 `character_id` 供历史查询
- 换角色时：即时生效，下一条消息就用新角色回复
- 未选角色时：允许扫码但不绑定角色，Bot 用默认 prompt 回复
- 用户只能管理自己的 Bot（`linked_user_id` 检查）
