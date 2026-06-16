# 微信情感陪伴AI服务 — 宝塔面板部署教程

> **适用环境：** CentOS 7/8, Ubuntu 20.04+, 宝塔面板 9.x  
> **服务器要求：** 最低 2 核 4GB，推荐 4 核 8GB  
> **域名要求：** 一个已解析的域名（可选，用于 HTTPS）

---

## 目录

1. [环境准备](#1-环境准备)
2. [安装宝塔面板](#2-安装宝塔面板)
3. [安装 Docker](#3-安装-docker)
4. [上传项目文件](#4-上传项目文件)
5. [配置环境变量](#5-配置环境变量)
6. [配置数据库](#6-配置数据库)
7. [启动服务](#7-启动服务)
8. [配置域名和 HTTPS](#8-配置域名和-https)
9. [微信扫码登录](#9-微信扫码登录)
10. [常见问题](#10-常见问题)

---

## 1. 环境准备

### 服务器要求

| 项目 | 最低配置 | 推荐配置 |
|------|---------|---------|
| CPU | 2 核 | 4 核+ |
| 内存 | 4 GB | 8 GB |
| 磁盘 | 20 GB | 50 GB+ (SSD) |
| 系统 | CentOS 7+ / Ubuntu 20.04+ | Ubuntu 22.04 |
| 网络 | 可访问外网 | 稳定带宽 |

### 端口规划

| 端口 | 服务 | 说明 |
|------|------|------|
| 8080 | Nginx | 主入口（可改 80/443 用域名） |
| 3000 | API Server | Webhook 回调 |
| 26322 | WeClaw Bridge | 微信桥接服务 |
| 9800 | OpeniLink Hub | 微信桥接管理平台 |
| 6379 | Redis | 仅内网 |
| 5432 | PostgreSQL | 仅内网 |
| 9000-9001 | MinIO | 对象存储（可选） |

> ⚠️ **安全提示：** Redis（6379）和 PostgreSQL（5432）默认绑定 `127.0.0.1`，只允许内网访问。不要开放到公网。

---

## 2. 安装宝塔面板

```bash
# 使用宝塔官方安装脚本
wget -O install.sh https://download.bt.cn/install/install_lts.sh
bash install.sh
```

安装完成后，记录面板的登录地址、用户名和密码。

### 安装必要软件

登录宝塔面板后，在 **软件商店** 安装：

- **Docker 管理器**（如未预装）
- **Nginx**（如果不用内置 Nginx 可跳过，项目自带独立 Nginx）

---

## 3. 安装 Docker

如果在宝塔内没有安装 Docker 管理器，用命令行安装：

```bash
# 安装 Docker
curl -fsSL https://get.docker.com | sh

# 启动 Docker
systemctl enable docker
systemctl start docker

# 安装 Docker Compose 插件
docker compose version
```

> 如果 `docker compose` 命令不可用，安装独立版本：
> ```bash
> curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
> chmod +x /usr/local/bin/docker-compose
> ```

---

## 4. 上传项目文件

### 方式一：宝塔面板上传

1. 打开宝塔面板 → **文件** → 进入 `/www/wwwroot/`
2. 新建目录 `wechat-companion`
3. 将项目压缩包上传到此目录
4. 右键 → **解压**

### 方式二：命令行上传

```bash
# 创建项目目录
mkdir -p /www/wwwroot/wechat-companion
cd /www/wwwroot/wechat-companion

# 上传压缩包后解压
unzip -o wechat-companion.zip
```

完成后确认目录结构：

```bash
ls -la
# 应包含: docker-compose.yml Dockerfile .env.example src/ dashboard/ scripts/ nginx.conf deploy.sh
```

---

## 5. 配置环境变量

```bash
cd /www/wwwroot/wechat-companion
cp .env.example .env
nano .env
```

### 必填项

```bash
# DeepSeek API Key（必须填写）
DEEPSEEK_API_KEY=sk-your-deepseek-api-key-here
```

> 获取 DeepSeek API Key：访问 [platform.deepseek.com](https://platform.deepseek.com) → 注册 → API Keys → 创建

### 推荐修改

```bash
# 数据库密码（生产环境务必修改）
POSTGRES_PASSWORD=改成你的强密码

# JWT 签名密钥（生产环境务必修改）
JWT_SECRET=改成随机字符串（可用 openssl rand -hex 32 生成）

# 管理员密码（仪表盘登录用）
# 首次部署后登录 http://你的IP:8080，用微信扫码自动创建账号
```

### 其他配置说明

```bash
# ---- WeClaw 桥接（首次部署后填写） ----
WECLAW_BOT_ID=xxx@im.bot       # 微信扫码登录后获取
WECLAW_API_TOKEN=xxx            # 微信扫码登录后获取

# ---- OpeniLink Hub（首次部署后填写） ----
OPENILINK_TOKEN=app_xxx         # OpeniLink 后台获取
```

> 这些参数可以在服务启动后再配置，不影响首次部署。

---

## 6. 配置数据库

项目使用 **PostgreSQL** 作为主数据库。Docker Compose 会自动初始化。

### 自动初始化

PostgreSQL 容器首次启动时会自动执行 `scripts/` 目录下的 SQL 初始化脚本：

| 文件 | 内容 |
|------|------|
| `01-init.sql` | 基础表：用户表、记忆表、对话日志、每日摘要、关怀日志 |
| `02-init-v2.sql` | 用户认证、导入任务、管理后台、关怀模板 |
| `03-init-v3.sql` | 媒体存储、表情包管理 |
| `04-init-v4.sql` | AI 角色系统、预置角色模板 |

### 手动初始化（可选）

如需手动初始化：

```bash
# 等 PostgreSQL 就绪后
docker compose exec postgres psql -U weclaw -d weclaw_companion -f /docker-entrypoint-initdb.d/01-init.sql
docker compose exec postgres psql -U weclaw -d weclaw_companion -f /docker-entrypoint-initdb.d/02-init-v2.sql
docker compose exec postgres psql -U weclaw -d weclaw_companion -f /docker-entrypoint-initdb.d/03-init-v3.sql
docker compose exec postgres psql -U weclaw -d weclaw_companion -f /docker-entrypoint-initdb.d/04-init-v4.sql
```

---

## 7. 启动服务

```bash
cd /www/wwwroot/wechat-companion

# 构建并启动所有服务
docker compose up -d

# 查看启动状态
docker compose ps
```

### 检查服务状态

所有服务启动后，运行 `docker compose ps` 应看到：

```
NAME                   STATUS
weclaw-api-server      Up (healthy)
weclaw-bull-worker     Up (healthy)
weclaw-care-scheduler  Up (healthy)
weclaw-dashboard       Up
weclaw-nginx           Up
weclaw-postgres        Up (healthy)
weclaw-redis           Up (healthy)
weclaw-bridge          Up
weclaw-minio           Up (healthy)
weclaw-openilink       Up
```

### 验证部署

```bash
# 健康检查
curl http://localhost:3000/health

# 应返回:
# {"status":"ok","services":{"redis":"healthy","postgres":"healthy","queue":{"status":"healthy"}}}
```

### 常用运维命令

```bash
# 查看实时日志
docker compose logs -f

# 查看特定服务日志
docker compose logs -f api-server
docker compose logs -f bull-worker

# 重启服务
docker compose restart api-server

# 更新代码后重新构建
docker compose build api-server
docker compose up -d api-server

# 停止所有服务
docker compose down

# 停止并删除数据卷（⚠️ 会清空所有数据）
docker compose down -v
```

---

## 8. 配置域名和 HTTPS

### 方式一：使用宝塔面板网站功能（推荐）

1. 打开宝塔面板 → **网站** → **添加站点**
2. **域名：** 输入你的域名（如 `companion.example.com`）
3. **PHP 版本：** 选择纯静态
4. **创建成功后**，点击域名的 **设置**

#### 配置反向代理

1. 站点设置 → **反向代理** → **添加反向代理**
2. **代理名称：** `wechat-companion`
3. **目标 URL：** `http://127.0.0.1:8080`
4. **发送域名：** `$host`
5. 点击 **保存**

#### 配置 SSL（HTTPS）

1. 站点设置 → **SSL** → **Let's Encrypt**
2. 勾选域名 → 申请
3. 开启 **强制 HTTPS**

### 方式二：直接修改项目自带的 Nginx

编辑项目的 `nginx.conf`，将 server_name 改为你的域名：

```nginx
server {
    listen 80;
    server_name companion.example.com;  # 改为你的域名
    ...
}
```

然后重启：

```bash
docker compose restart nginx
```

SSL 需要使用 certbot 或其他工具手动配置，推荐方式一。

---

## 9. 微信扫码登录

### 第一步：扫码登录

```bash
# 进入 WeClaw 桥接容器
docker compose exec weclaw-bridge bot

# 在终端中执行:
/login
```

终端会显示二维码，用微信扫描。

### 第二步：获取 Bot ID

```bash
# 扫码后查看机器人信息
/bots
```

会显示类似：

```
Bot 1: b08ea4f44e29@im.bot
```

### 第三步：配置环境变量

编辑 `.env` 文件：

```bash
nano .env
```

填入获取的 Bot ID 和 Token：

```bash
WECLAW_BOT_ID=b08ea4f44e29@im.bot
WECLAW_API_TOKEN=你的API-Token
```

### 第四步：重启服务

```bash
docker compose restart api-server bull-worker
```

### 验证微信收发

向机器人微信号发送一条消息，查看日志：

```bash
docker compose logs -f bull-worker
```

应看到消息被接收并处理。

---

## 10. 常见问题

### 10.1 服务启动失败

**现象：** `docker compose up -d` 后某些容器退出

**排查：**
```bash
# 查看容器日志
docker compose logs 容器名

# 常见原因：
# 1. PostgreSQL 启动较慢，依赖它的容器先启动了 → 设置 restart: unless-stopped 会自动重试
# 2. 端口被占用 → netstat -tlnp | grep 端口号
# 3. .env 文件配置错误 → 检查 DEEPSEEK_API_KEY 等
```

### 10.2 微信消息收发失败

**现象：** 收不到消息或发不出去

**排查：**
1. 确认 WeClaw Bridge 容器正常运行：`docker compose logs weclaw-bridge`
2. 确认 Webhook URL 配置正确（需要外网能访问 `http://你的域名:3000/webhook`）
3. 检查微信是否还在登录状态：进入容器执行 `/login` 重新扫码

### 10.3 仪表盘无法登录

**现象：** 输入账号密码后 502

**排查：**
```bash
# 1. 确认 API 服务正常
curl http://localhost:3000/health

# 2. 确认 Nginx 能转发
curl http://localhost:8080/api/health

# 3. 重置管理员密码（数据库内修改）
docker compose exec postgres psql -U weclaw -d weclaw_companion
UPDATE user_accounts SET password_hash='新bcrypt哈希' WHERE email='你的账号';
```

### 10.4 导入聊天记录失败

**现象：** 上传 zip 后显示解压失败

**排查：**
1. 确认上传文件为 zip/tgz 格式
2. 查看 api-server 日志：`docker compose logs api-server | grep Import`
3. 中文文件名问题：已通过 `-O CP936` 参数修复
4. 文件太大：当前限制 200MB，可在 `upload.ts` 中修改 `MAX_FILE_SIZE`

### 10.5 内存不足

**现象：** 容器被 OOM Killer 杀掉

**解决方法：**
```bash
# 1. 限制容器内存使用
# 编辑 docker-compose.yml，在对应服务下添加：
deploy:
  resources:
    limits:
      memory: 2G

# 2. 降低 Worker 并发
# 在 .env 中设置：
WORKER_CONCURRENCY=5

# 3. 限制 Redis 内存
# docker-compose.yml 中 Redis 的 command 已有 --maxmemory 512mb
```

### 10.6 数据备份与恢复

```bash
# 备份 PostgreSQL
docker compose exec postgres pg_dump -U weclaw weclaw_companion > backup_$(date +%Y%m%d).sql

# 恢复
docker compose exec -T postgres psql -U weclaw weclaw_companion < backup_20260101.sql

# 备份 Redis
docker compose exec redis redis-cli BGSAVE
docker compose cp redis:/data/dump.rdb ./redis_backup.rdb

# 备份整个项目配置
tar czf wechat-companion-backup.tar.gz .env docker-compose.yml nginx.conf
```

---

## 附录

### A. 服务端口说明

| 端口 | 绑定 | 服务 | 说明 |
|------|------|------|------|
| 8080 | 0.0.0.0 | Nginx (主入口) | HTTP 访问端口 |
| 3000 | 0.0.0.0 | API Server | Webhook 接收（外网需开放） |
| 26322 | 0.0.0.0 | WeClaw Bridge | 微信协议接入 |
| 9800 | 0.0.0.0 | OpeniLink Hub | 微信桥接管理 |
| 6379 | 127.0.0.1 | Redis | 仅内网 |
| 5432 | 127.0.0.1 | PostgreSQL | 仅内网 |

### B. 目录结构

```
/www/wwwroot/wechat-companion/
├── docker-compose.yml     # Docker 编排文件
├── Dockerfile             # 主服务镜像构建
├── .env                   # 环境变量配置
├── nginx.conf             # Nginx 反向代理配置
├── src/                   # TypeScript 源码
├── dashboard/             # React 前端
├── scripts/               # SQL 初始化脚本
└── deploy.sh              # 一键部署脚本
```

### C. 更新升级

```bash
# 1. 备份数据
docker compose exec postgres pg_dump -U weclaw weclaw_companion > pre-upgrade-backup.sql

# 2. 拉取新代码（替换 src/ dashboard/ docker-compose.yml 等）
# 或者上传新版压缩包解压覆盖

# 3. 重新构建并启动
docker compose build
docker compose up -d

# 4. 如有数据库变更，执行迁移
docker compose exec postgres psql -U weclaw -d weclaw_companion -f scripts/init-db-v4.sql
```

---

> **技术支持：** 项目交流群（如有）  
> **项目地址：** [GitHub 仓库链接]
