# 富协议设计文档 — Rich Protocol

> 版本: v1.0  
> 最后更新: 2026-06-24  
> 相关技能: hersona (84 个人格属性模板), SoulCraft (人格蒸馏)

---

## 一、概述

### 1.1 问题

微信情感陪伴 AI 的完整链路是：

```
微信消息 → Hermes Agent (技能处理) → SQLite → relay → SillyTavern (角色引擎) → DeepSeek API
```

其中 **Hermes Agent** 负责运行技能（如 hersona 人格切换、SoulCraft 人格蒸馏），但实际调用 LLM 生成回复的是 **SillyTavern**。两者之间存在一个信息断层：

- ✅ Hermes 知道当前人格（her sona skill 已执行）
- ❌ relay 转发消息时**没有携带人格信息**
- ❌ SillyTavern/DeepSeek 收到的只有纯文本消息

### 1.2 解决方案

**富协议（Rich Protocol）** 在 relay 转发消息时，将当前活跃的人格属性作为 `system` 角色的消息注入到 SillyTavern 的消息列表中，使 DeepSeek 能够感知并遵循人格设定。

```
之前:
{messages: [{role: "user", content: "你好"}]}

之后:
{messages: [
  {role: "system", content: "[Tsundere] 用敌对言辞掩饰真实情感..."},
  {role: "user", content: "你好"}
]}
```

---

## 二、架构

### 2.1 组件关系

```
┌──────────────────────────────────────────────────────────┐
│                    用户说"切换傲娇"                          │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  Hermes Agent                                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │ hersona skill                                      │  │
│  │ → 读取 attributes/personality/tsundere.yaml        │  │
│  │ → 将 core_traits / catchphrases 注入系统提示词     │  │
│  └────────────────────────────────────────────────────┘  │
│                          │                                │
│                          ▼                                │
│  消息写入 Hermes SQLite (state.db)                        │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  scripts/set-persona.js (CLI / Hermes hook)              │
│  → 写入 ~/.hermes/active_persona.json                    │
│  { "attributes": [{"category":"personality","name":"tsundere"}] }  │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  hermes-st-relay.js (systemd)                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │ pollMessages() 每次轮询:                           │  │
│  │ 1. 读 Hermes SQLite 新消息                         │  │
│  │ 2. 调用 loadActivePersona() ← 缓存 30s             │  │
│  │    → 读 active_persona.json                        │  │
│  │    → 读 tsundere.yaml → 提取 description           │  │
│  │    → 拼 system prompt                              │  │
│  │ 3. 构建 payload: {system + user} messages          │  │
│  │ 4. WebSocket → SillyTavern                         │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  SillyTavern ChatBridge                                  │
│  → 收到含 system prompt 的消息列表                        │
│  → 传给 DeepSeek API                                     │
│  → DeepSeek 按傲娇风格生成回复                            │
└──────────────────────────────────────────────────────────┘
```

### 2.2 数据流

| 步骤 | 组件 | 输入 | 输出 |
|------|------|------|------|
| 1 | hersona skill | 用户指令 "切换傲娇" | 更新 Hermes 系统提示词 |
| 2 | set-persona.js | CLI: `personality/tsundere` | `~/.hermes/active_persona.json` |
| 3 | relay.js | 轮询到新消息 | 读取 active_persona.json |
| 4 | relay.js | tsundere.yaml | 提取 description |
| 5 | relay.js | description | system prompt 字符串 |
| 6 | relay.js → ST | WebSocket | `{messages: [{system}, {user}]}` |
| 7 | ST → DeepSeek | 消息列表 | 按人格回复 |

---

## 三、API 规范

### 3.1 活跃人格文件 (`active_persona.json`)

```json
{
  "attributes": [
    { "category": "personality", "name": "tsundere" },
    { "category": "speech", "name": "keigo" }
  ],
  "updated_at": "2026-06-24T10:00:00.000Z"
}
```

**字段说明:**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `attributes` | array | 是 | 当前激活的属性列表 |
| `attributes[].category` | string | 是 | 属性类别: personality / speech / archetype / visual / hobby |
| `attributes[].name` | string | 是 | 属性名称，对应 YAML 文件名（不含扩展名） |
| `updated_at` | string | 否 | 最后更新时间 (ISO 8601) |

**写入路径:** `~/.hermes/active_persona.json`  
**写入工具:** `scripts/set-persona.js`  
**读取组件:** `scripts/hermes-st-relay.js`

### 3.2 属性 YAML 格式 (`vendor/hersona/attributes/<category>/<name>.yaml`)

```yaml
attribute_category: personality    # 属性类别
attribute_name: tsundere          # 属性名（文件名）
display_name: Tsundere            # 显示名称
description: >                    # 人格描述（relay 读取此字段）
  A tendency to cover true feelings with opposite or hostile words
examples:                         # 对话示例
  - |-
    [system] ...
    [user] ...
    [assistant] ...
```

relay 通过 `extractYamlValue()` 函数提取 `description` 和 `display_name` 字段，拼装为 system prompt。

### 3.3 WebSocket 消息格式（relay → SillyTavern）

```typescript
// 不带人格（默认）
{
  type: "user_request",
  user_id: string,
  bot_id: string,
  content: {
    messages: [
      { role: "user", content: string }
    ]
  },
  timestamp: number
}

// 带人格上下文（富协议）
{
  type: "user_request",
  user_id: string,
  bot_id: string,
  content: {
    messages: [
      { role: "system", content: "[Tsundere] 用敌对言辞掩饰真实情感..." },
      { role: "user", content: string }
    ]
  },
  timestamp: number
}
```

**关键变更:**
- 当 `loadActivePersona()` 返回非空时，在 `messages` 数组头部插入 `{role: "system"}` 消息
- `system` 消息内容格式: `[display_name] description`
- 多重人格时用换行分隔: `[Tsundere] ...\n[Keigo] ...`

---

## 四、配置

### 4.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ACTIVE_PERSONA_FILE` | `~/.hermes/active_persona.json` | 活跃人格状态文件路径 |
| `HERSONA_ATTR_DIR` | `<project>/vendor/hersona/attributes` | hersona 属性 YAML 目录 |
| `PERSONA_CACHE_TTL` | `30000` (30秒) | 人格缓存有效期 (ms) |

### 4.2 relay.js 新增函数

#### `loadActivePersona()`

```javascript
function loadActivePersona() {
  // 1. 检查缓存 (PERSONA_CACHE_TTL)
  // 2. 读取 active_persona.json → 获取 attributes 列表
  // 3. 遍历 attributes → 读取对应 YAML
  // 4. 提取 display_name + description
  // 5. 拼装: "[display_name] description"
  // 6. 更新缓存
  // 返回: string | null
}
```

#### `extractYamlValue(yaml, key)`

```javascript
function extractYamlValue(yaml, key) {
  // 简单正则提取 YAML 顶层标量值（无三方依赖）
  // 返回: string | null
}
```

---

## 五、使用指南

### 5.1 快速开始

```bash
# 1. 安装 hersona 技能
bash scripts/install-skills.sh

# 2. 设置人格
node scripts/set-persona.js personality/tsundere

# 3. 重启 relay（加载人格配置）
systemctl --user restart hermes-st-relay

# 4. 验证
journalctl --user -u hermes-st-relay -f
# 应看到: [Persona] Loaded: tsundere
```

### 5.2 常用命令

```bash
# 查看所有可用属性
node scripts/set-persona.js --list

# 设置单一人格
node scripts/set-persona.js personality/tsundere
node scripts/set-persona.js personality/kuudere
node scripts/set-persona.js speech/keigo

# 多重人格组合
node scripts/set-persona.js personality/tsundere,speech/keigo,archetype/heroine

# 清除人格（恢复默认）
node scripts/set-persona.js --clear

# 查看当前状态
node scripts/set-persona.js --status
```

### 5.3 验证富协议生效

在 relay 日志中可以看到 system prompt 被加载：

```
[Persona] Loaded: tsundere
[Relay] 📩 Relayed to ST: bot=xxx user=xxx "你好..."
```

此时 SillyTavern 收到的消息列表应包含 `system` 角色消息。

---

## 六、属性库参考

84 个属性模板按 5 个类别组织:

| 类别 | 数量 | 示例 |
|------|------|------|
| `personality` | 35 | tsundere, kuudere, yandere, genki, dandere |
| `speech` | 30 | keigo, kansai_ben, archaic, soft, seductive |
| `archetype` | 9 | childhood_friend, heroine, mentor, rival |
| `visual` | 5 | glasses, petite, silver_hair, animal_ears |
| `hobby` | 5 | cooking, gamer, music, reading, sports |

完整列表: `vendor/hersona/attributes/`

---

## 七、扩展

### 7.1 对接 SoulCraft 人格蒸馏

SoulCraft 蒸馏出的人格（`persona.md`）可以通过适配器转换为 hersona 属性格式，然后通过 set-persona.js 设置：

```bash
# SoulCraft 蒸馏 → 生成 persona
# 适配器: convert-soulcraft-to-hersona.js (待实现)
# → 输出 personality/custom.yaml
# → 复制到 vendor/hersona/attributes/personality/
# → node scripts/set-persona.js personality/custom
```

### 7.2 对接 hermes-st-relay 自动同步

当 Hermes Agent 执行 hersona skill 时，可以自动写入 `active_persona.json`（目前 HERMES hook 待实现），实现"说切换就切换"的实时效果。

---

## 八、变更日志

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-06-24 | v1.0 | 初始设计：relay 读 active_persona.json → 注入 system prompt → ST |
