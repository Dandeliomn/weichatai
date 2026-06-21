# 微信情感陪伴AI — 搭建教程

> 从零开始部署，预计耗时 20-30 分钟。

## 前置要求

| 软件 | 版本要求 | 检查命令 |
|------|---------|---------|
| Docker | 24+ | `docker --version` |
| Docker Compose | v2+ | `docker compose version` |
| Python | 3.11+ | `python3 --version` |
| Node.js | 20+ | `node --version` |
| DeepSeek API Key | — | 从 [platform.deepseek.com](https://platform.deepseek.com) 获取 |

## 第一步：安装 Hermes Agent

```bash
# 官方安装脚本
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/install_hermes.sh | bash

# 验证安装
hermes --version
```

> 如果 GitHub 不可访问，需要配置代理或手动安装。详见 [Hermes 官方文档](https://github.com/NousResearch/hermes-agent)。

## 第二步：启动 Docker 服务

```bash
cd wechat-companion
docker compose up -d
```

等待所有容器启动（约 1-2 分钟）：

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

应看到 12 个容器全部 `Up` 或 `healthy`。

### 初始化数据库

```bash
# 等待 postgres 就绪
docker exec weclaw-postgres pg_isready -U weclaw

# 运行数据库迁移（如需要）
docker exec weclaw-api-server node dist/db-migrate.js
```

## 第三步：配置 Hermes

### 3.1 复制配置文件

```bash
cp hermes/config/.env.template ~/.hermes/.env
cp hermes/config/config.yaml.template ~/.hermes/config.yaml
```

### 3.2 编辑 `.env`

```bash
vim ~/.hermes/.env
```

必填项：

```ini
DEEPSEEK_API_KEY=sk-你的key

# 微信 Gateway（扫码后自动填入前三项）
WEIXIN_HOME_CHANNEL=你的微信ID@im.wechat
WEIXIN_ACCOUNT_ID=
WEIXIN_TOKEN=
WEIXIN_BASE_URL=https://ilinkai.weixin.qq.com
WEIXIN_CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c
WEIXIN_AUTO_SKILL=ex_wang_jing

GATEWAY_ALLOW_ALL_USERS=true
HERMES_GATEWAY_BUSY_ACK_ENABLED=false
```

> `WEIXIN_HOME_CHANNEL` 格式：`o9cq80y2...@im.wechat`（扫码后会自动获取）
> `WEIXIN_AUTO_SKILL` 默认人格，可选值见 README 人格列表

### 3.3 验证 config.yaml

确保以下关键配置正确（模板已预设）：

```yaml
display:
  busy_input_mode: queue
  interim_assistant_messages: false
  tool_progress: none
  background_process_notifications: none

approvals:
  mode: off

memory:
  nudge_interval: 0
```

## 第四步：安装 ex-skill 人格系统

```bash
# 安装人格 SKILL.md 文件
cp -r hermes/skills/ex-skill ~/.hermes/skills/

# 安装管理脚本
cp hermes/scripts/*.py ~/.hermes/scripts/
chmod +x ~/.hermes/scripts/*.py

# 安装欢迎消息
cp hermes/weixin/welcome.md ~/.hermes/weixin/

# 验证人格列表
python3 ~/.hermes/scripts/persona_manager.py list
```

应列出 7 个人格。

## 第五步：应用 weixin.py 补丁

这是关键步骤——Hermes 原版微信适配器不支持 auto_skill 和表情包。

```bash
# 找到 Hermes 安装路径
HERMES_VENV=$(dirname $(dirname $(which hermes)))/lib/python3.*/site-packages

# 备份原文件
cp $HERMES_VENV/gateway/platforms/weixin.py $HERMES_VENV/gateway/platforms/weixin.py.bak

# 应用补丁
cp hermes/weixin.py.patched $HERMES_VENV/gateway/platforms/weixin.py
```

补丁添加的功能：
- `WEIXIN_AUTO_SKILL` 环境变量 → 自动加载人格 skill
- `channel_prompt` 系统级身份注入（每轮持久）
- `[sticker]` / `[动画表情]` → 真实表情图片替换
- 激活时自动发送欢迎消息

## 第六步：扫码登录微信

```bash
bash ~/.hermes/scripts/weixin-login.sh
```

终端会显示二维码链接，用手机微信扫描。成功后凭证自动写入 `.env`。

> 如果脚本不存在，手动登录：参考 Hermes 微信文档

## 第七步：启动 Gateway

```bash
hermes gateway restart
```

检查状态：

```bash
cat ~/.hermes/gateway_state.json
# 应显示: "gateway_state": "running", "weixin": "connected"
```

查看日志确认无报错：

```bash
tail -f ~/.hermes/logs/gateway.log
# 应看到: ✓ weixin connected
# 不应有: Session expired
```

## 第八步：导入表情包（可选）

如果你有聊天记录导出的表情包：

```bash
# 将表情文件放入
cp /path/to/stickers/* ~/.hermes/weixin/stickers/
```

AI 在回复中输出 `[动画表情]` 时会随机挑选发送。

## 第九步：验证

### 微信端测试

1. 给机器人发一条消息
2. 应该收到人格化的回复
3. 说"切换人格"→ 应列出 7 个人格
4. 说"切换到 温柔前任"→ 应切换并通知

### 仪表盘测试

1. 打开 `http://localhost:8080`
2. 注册/登录账号
3. 进入"角色管理" → 切换角色 → 微信端应同步切换

## 常见问题

### Q: Gateway 显示 "Session expired"

重新扫码登录：
```bash
bash ~/.hermes/scripts/weixin-login.sh
hermes gateway restart
```

### Q: 切换人格后微信没反应

检查 Gateway 是否成功重启：
```bash
tail -20 ~/.hermes/logs/gateway.log | grep -i error
```

### Q: 仪表盘拒绝连接

检查容器状态：
```bash
docker ps | grep nginx
# 访问 http://localhost:8080
```

### Q: AI 回复"我是AI助手"而不是人格

检查 channel_prompt 是否生效：
```bash
grep WEIXIN_AUTO_SKILL ~/.hermes/.env
# 应显示当前人格 slug
```

### Q: 表情包不显示

iLink Bot API 不支持 GIF 动图。确保表情目录只有 PNG/JPG：
```bash
ls ~/.hermes/weixin/stickers/ | grep -c '.gif'  # 应为 0
```

## 目录参考

```
~/.hermes/
  .env                    # 环境变量（Key、微信配置）
  config.yaml             # Hermes 主配置
  SOUL.md                 # 默认人格（Change）
  skills/ex-skill/        # 7 个人格
    ex_wang_jing/SKILL.md
    ex_gentle_ex/SKILL.md
    ...
  scripts/
    persona_manager.py    # 人格管理
    chat_importer.py      # 聊天导入
  weixin/
    welcome.md            # 激活欢迎消息
    stickers/              # 表情图片（可选）
    accounts/              # Bot 凭据（自动管理）
  memories/
    chat_history.db       # 原始聊天记录（SQLite）
  state.db                # 会话状态（SQLite）
  sessions/               # 会话记录（JSON）
  logs/                   # 日志
```
