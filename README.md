# 微信情感陪伴AI

基于 Hermes Agent + ex-skill 的微信情感陪伴 AI 服务。

支持多人格切换、聊天记录导入、表情包发送、记忆保留。已对接 7 个人格（含基于 17,708 条真实聊天记录训练的前任人格）。

## 特性

- **多人格系统** — 7 个内置人格 + 支持自定义创建。微信内说"切换人格"即可切换
- **聊天记录导入** — 支持 JSON/HTML/TXT/zip/WeFlow 格式，自动解析去重
- **表情包发送** — AI 从 604 张真实聊天表情中随机选取发送
- **记忆系统** — Part A（关系记忆）+ Part B（5层人格）双组件驱动
- **聊天记录查询** — AI 可查询 12,000+ 条历史对话回答过去的事
- **仪表盘管理** — Web 界面上传分析、角色管理、对话浏览
- **仪表盘联动** — Web 切换角色自动同步到微信端

## 架构

```
微信消息 → iLink Bot API
    ↓
Hermes Gateway (weixin.py)
    ├─ auto_skill: 自动加载 ex-skill 人格
    ├─ channel_prompt: 系统级身份注入
    └─ sticker: [动画表情] → 真实图片
    ↓
Hermes Agent (DeepSeek V4 Flash)
    ├─ ex-skill SKILL.md (Part A + Part B)
    ├─ chat_history.db (12,117条原始聊天)
    └─ state.db (会话记忆)
    ↓
回复 → iLink API → 微信
```

## 快速开始

### 环境要求

- Docker + Docker Compose
- Node.js 22+（Hermes）
- Python 3.11+（Hermes）
- DeepSeek API Key

### 安装

```bash
# 1. 克隆项目
git clone <repo-url>
cd wechat-companion-export

# 2. 启动 Docker 服务
cd wechat-companion
docker compose up -d

# 3. 安装 Hermes（如未安装）
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/install_hermes.sh | bash

# 4. 配置 Hermes
cp hermes/config/.env.template ~/.hermes/.env
# 编辑 ~/.hermes/.env 填入你的 API Key 和微信配置
cp hermes/config/config.yaml.template ~/.hermes/config.yaml

# 5. 安装 ex-skill 人格
cp -r hermes/skills/ex-skill ~/.hermes/skills/

# 6. 安装脚本
cp hermes/scripts/*.py ~/.hermes/scripts/
cp hermes/weixin/welcome.md ~/.hermes/weixin/

# 7. 应用 weixin.py 补丁
cp hermes/weixin.py.patched ~/.local/share/pipx/venvs/hermes-agent/lib/python3.14/site-packages/gateway/platforms/weixin.py

# 8. 扫码登录微信
bash ~/.hermes/scripts/weixin-login.sh

# 9. 启动 Hermes Gateway
hermes gateway restart

# 10. 访问仪表盘
open http://localhost:8080
```

### 微信使用

| 指令 | 功能 |
|------|------|
| "切换人格" | 列出所有人格 |
| "切换到 温柔前任" | 切换到指定人格 |
| "切换到 温柔前任 保留记忆" | 切换但保留对话记忆 |
| `/new` | 重新开始对话 |
| 发送聊天文件 | 自动识别并导入（HTML/JSON/TXT/zip） |
| 自然对话 | AI 按当前人格回复 |

### 仪表盘

| 页面 | 功能 |
|------|------|
| `http://localhost:8080/import` | 上传聊天记录 + AI 分析 |
| `http://localhost:8080/characters` | 角色管理/切换（自动同步微信） |
| `http://localhost:8080/conversations` | 对话浏览 |
| `http://localhost:8080/` | 系统概览 |

## 内置人格

| 人格 | Slug | 描述 |
|------|------|------|
| 王静 | ex_wang_jing | 21岁巨蟹座ISFJ，基于17,708条真实聊天记录 |
| 温柔前任 | ex_gentle_ex | 念旧但克制，希望你幸福 |
| 毒舌死党 | ex_tsundere_friend | 嘴贱义气，吐槽表达关心 |
| 元气女友 | ex_genki_gf | 活泼可爱，小太阳 |
| 知心姐姐 | ex_wise_sister | 温柔倾听，引导思考 |
| 暖心长辈 | ex_warm_elder | 慈祥睿智，不讲大道理 |
| 毒舌上司 | ex_strict_boss | 严格专业，外冷内热 |

## 创建自定义人格

### 方式一：通过仪表盘

1. 访问 `http://localhost:8080/import`
2. 上传聊天记录 → 等待处理 → 点击"AI 分析"
3. 微调分析结果 → "保存并应用"

### 方式二：通过微信

1. 发送聊天记录文件（HTML/JSON/TXT/zip）
2. AI 自动检测格式 → 解析 → 导入
3. 说"分析聊天记录"触发分析

### 方式三：手动创建

```bash
# 复制模板
cp -r ~/.hermes/skills/ex-skill/ex_wang_jing ~/.hermes/skills/ex-skill/ex_my_persona
# 编辑 SKILL.md
vim ~/.hermes/skills/ex-skill/ex_my_persona/SKILL.md
# 切换到新人格
python3 ~/.hermes/scripts/persona_manager.py switch ex_my_persona
```

## 文件结构

```
wechat-companion/          # Docker 服务（仪表盘 + API + 数据库）
hermes/
  skills/ex-skill/         # 7个人格 SKILL.md
    ex_wang_jing/          #   王静（含 Part A + Part B）
    ex_gentle_ex/          #   温柔前任
    ...                    #   其他人格
  scripts/
    persona_manager.py     # 人格管理（列表/切换）
    chat_importer.py       # 聊天记录导入 + 防注入
  weixin/
    welcome.md             # 激活欢迎消息
  config/
    config.yaml.template   # Hermes 配置模板
    .env.template          # 环境变量模板
  weixin.py.patched        # Hermes Gateway 微信适配器补丁
docs/
  CHANGELOG.md             # 历史改动说明
  SETUP.md                 # 详细搭建教程
```

## 技术栈

- **后端**: Node.js + Express + TypeScript
- **前端**: React + Vite + TypeScript
- **数据库**: PostgreSQL + Redis + MinIO
- **AI框架**: Hermes Agent (Nous Research)
- **人格系统**: ex-skill (AgentSkills 标准)
- **模型**: DeepSeek V4 Flash（可替换）
- **微信接入**: iLink Bot API
- **部署**: Docker Compose

## 安全

- `chat_importer.py` 含 SQL 注入检测、脚本标签过滤、文件大小限制
- 所有聊天数据本地存储
- 仪表盘需 JWT 登录
- 微信消息仅处理已授权用户

## License

MIT
