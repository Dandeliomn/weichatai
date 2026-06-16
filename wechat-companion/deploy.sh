#!/usr/bin/env bash
# =============================================================================
# 微信情感陪伴AI服务 - 一键部署脚本
#
# 使用方法:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# 服务器要求: Ubuntu 22.04, 4核8G (推荐)
# =============================================================================

set -euo pipefail

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 项目目录
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# =============================================================================
# 辅助函数
# =============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC}  $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo ""
    echo -e "${CYAN}============================================${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}============================================${NC}"
}

# 检查命令是否存在
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# 检查Docker是否运行
check_docker_running() {
    if ! docker info >/dev/null 2>&1; then
        log_error "Docker 未运行，请先启动 Docker 服务"
        echo ""
        echo "  Ubuntu/Debian: sudo systemctl start docker"
        echo "  CentOS/RHEL:   sudo systemctl start docker"
        echo ""
        exit 1
    fi
}

# =============================================================================
# 打印横幅
# =============================================================================

print_banner() {
    echo ""
    echo -e "${PURPLE}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${PURPLE}║                                                      ║${NC}"
    echo -e "${PURPLE}║   💬  微信情感陪伴AI服务 - 一键部署脚本               ║${NC}"
    echo -e "${PURPLE}║   WeChat Emotional Companion AI Service               ║${NC}"
    echo -e "${PURPLE}║                                                      ║${NC}"
    echo -e "${PURPLE}╚══════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  技术栈: ${GREEN}WeClaw + DeepSeek + PostgreSQL + Redis + BullMQ${NC}"
    echo -e "  部署方式: ${GREEN}Docker Compose${NC}"
    echo ""
}

# =============================================================================
# 步骤1: 检查系统要求
# =============================================================================

step1_check_requirements() {
    log_step "步骤 1/6: 检查系统要求"

    # 检查操作系统
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        log_info "操作系统: $NAME $VERSION"
    else
        log_warning "无法检测操作系统版本"
    fi

    # 检查CPU核心数
    CPU_CORES=$(nproc 2>/dev/null || echo "unknown")
    if [[ "$CPU_CORES" != "unknown" ]] && [[ "$CPU_CORES" -lt 2 ]]; then
        log_warning "CPU核心数较少 ($CPU_CORES), 建议至少 4 核"
    else
        log_info "CPU核心数: $CPU_CORES"
    fi

    # 检查内存
    if command_exists free; then
        TOTAL_MEM=$(free -g | awk '/^Mem:/{print $2}')
        if [[ "$TOTAL_MEM" -lt 4 ]]; then
            log_warning "内存较少 (${TOTAL_MEM}GB), 建议至少 8GB"
        else
            log_info "内存: ${TOTAL_MEM}GB"
        fi
    fi

    # 检查磁盘空间
    if command_exists df; then
        AVAIL_DISK=$(df -BG . | awk 'NR==2 {print $4}' | sed 's/G//')
        if [[ "$AVAIL_DISK" -lt 10 ]]; then
            log_warning "可用磁盘空间较少 (${AVAIL_DISK}GB), 建议至少 20GB"
        else
            log_info "可用磁盘空间: ${AVAIL_DISK}GB"
        fi
    fi

    log_success "系统检查完成"
}

# =============================================================================
# 步骤2: 安装 Docker
# =============================================================================

step2_install_docker() {
    log_step "步骤 2/6: 检查 Docker 环境"

    DOCKER_INSTALLED=true

    if ! command_exists docker; then
        DOCKER_INSTALLED=false
        log_warning "Docker 未安装，正在自动安装..."

        # 使用官方安装脚本
        curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
        sudo sh /tmp/get-docker.sh
        rm /tmp/get-docker.sh

        # 将当前用户添加到docker组
        sudo usermod -aG docker "$USER"

        log_success "Docker 安装完成"
        log_warning "请重新登录以使 Docker 组权限生效，或运行: newgrp docker"
    else
        log_info "Docker 已安装: $(docker --version)"
    fi

    # 检查 Docker Compose (新版Docker内置compose子命令)
    if ! docker compose version >/dev/null 2>&1; then
        log_warning "Docker Compose 插件未安装"
        if ! command_exists docker-compose; then
            log_info "正在安装 docker-compose..."
            sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
            sudo chmod +x /usr/local/bin/docker-compose
        fi
        log_info "Docker Compose: $(docker-compose --version)"
    else
        log_info "Docker Compose: $(docker compose version)"
    fi

    check_docker_running
    log_success "Docker 环境检查完成"
}

# =============================================================================
# 步骤3: 配置环境变量
# =============================================================================

step3_configure_env() {
    log_step "步骤 3/6: 配置环境变量"

    if [[ -f .env ]]; then
        log_info ".env 文件已存在"
        echo ""
        echo -e "${YELLOW}当前配置:${NC}"
        echo "  DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-未设置}"
        echo "  DEEPSEEK_MODEL:   ${DEEPSEEK_MODEL:-deepseek-chat}"
        echo "  POSTGRES_USER:    ${POSTGRES_USER:-weclaw}"
        echo ""
        read -rp "  是否重新配置? (y/N): " reconfigure
        if [[ "$reconfigure" != "y" && "$reconfigure" != "Y" ]]; then
            log_info "保留现有配置"
            return
        fi
    fi

    # 复制模板
    if [[ ! -f .env ]]; then
        cp .env.example .env
        log_info "已从 .env.example 创建 .env 文件"
    fi

    echo ""
    echo -e "${GREEN}请配置以下关键参数:${NC}"
    echo ""
    echo -e "  1. ${CYAN}DeepSeek API Key${NC} (必填)"
    echo "     从 https://platform.deepseek.com/api_keys 获取"
    echo ""

    read -rp "  请输入 DeepSeek API Key: " DEEPSEEK_KEY

    if [[ -n "$DEEPSEEK_KEY" ]]; then
        # macOS 和 Linux 的 sed 语法不同
        if [[ "$(uname)" == "Darwin" ]]; then
            sed -i '' "s|DEEPSEEK_API_KEY=.*|DEEPSEEK_API_KEY=$DEEPSEEK_KEY|" .env
        else
            sed -i "s|DEEPSEEK_API_KEY=.*|DEEPSEEK_API_KEY=$DEEPSEEK_KEY|" .env
        fi
        log_success "API Key 已配置"
    else
        log_warning "API Key 未输入，请稍后手动编辑 .env 文件"
    fi

    echo ""
    echo -e "  2. ${CYAN}PostgreSQL 密码${NC} (建议修改默认密码)"
    read -rp "  请输入数据库密码 (回车使用默认值): " PG_PASSWORD
    if [[ -n "$PG_PASSWORD" ]]; then
        if [[ "$(uname)" == "Darwin" ]]; then
            sed -i '' "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PG_PASSWORD|" .env
        else
            sed -i "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PG_PASSWORD|" .env
        fi
    fi

    echo ""
    log_info "环境变量配置文件: $PROJECT_DIR/.env"
    log_info "请确认配置无误后继续"
    echo ""
    read -rp "  按 Enter 继续..."

    log_success "环境变量配置完成"
}

# =============================================================================
# 步骤4: 构建镜像并启动服务
# =============================================================================

step4_build_and_start() {
    log_step "步骤 4/6: 构建镜像并启动服务"

    log_info "正在拉取基础镜像..."
    docker compose pull redis postgres weclaw-bridge 2>/dev/null || true

    log_info "正在构建主服务镜像..."
    docker compose build api-server bull-worker care-scheduler

    log_info "正在启动所有服务..."
    docker compose up -d

    echo ""
    log_info "等待服务启动..."
    sleep 5

    # 检查服务状态
    echo ""
    log_info "服务状态:"
    docker compose ps

    log_success "服务启动完成"
}

# =============================================================================
# 步骤5: 等待服务就绪
# =============================================================================

step5_wait_for_services() {
    log_step "步骤 5/6: 等待服务就绪"

    log_info "等待 PostgreSQL 就绪..."
    for i in $(seq 1 30); do
        if docker compose exec -T postgres pg_isready -U weclaw 2>/dev/null; then
            log_success "PostgreSQL 已就绪"
            break
        fi
        if [[ $i -eq 30 ]]; then
            log_error "PostgreSQL 启动超时，请检查日志: docker compose logs postgres"
            exit 1
        fi
        sleep 2
    done

    log_info "等待 Redis 就绪..."
    for i in $(seq 1 15); do
        if docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
            log_success "Redis 已就绪"
            break
        fi
        if [[ $i -eq 15 ]]; then
            log_error "Redis 启动超时"
            exit 1
        fi
        sleep 1
    done

    log_info "等待 API 服务就绪..."
    for i in $(seq 1 20); do
        if curl -s http://localhost:3000/health >/dev/null 2>&1; then
            log_success "API 服务已就绪"
            break
        fi
        if [[ $i -eq 20 ]]; then
            log_warning "API 服务可能仍在启动中，请稍后检查: curl http://localhost:3000/health"
        fi
        sleep 2
    done

    log_success "所有服务就绪"
}

# =============================================================================
# 步骤6: 扫码登录微信
# =============================================================================

step6_wechat_login() {
    log_step "步骤 6/6: 微信扫码登录"

    echo ""
    echo -e "${GREEN}请按以下步骤完成微信扫码登录:${NC}"
    echo ""
    echo -e "  1. 进入 WeClaw 桥接容器终端:"
    echo -e "     ${CYAN}docker compose exec weclaw-bridge bot${NC}"
    echo ""
    echo -e "  2. 在终端中输入 ${CYAN}/login${NC} 发起扫码"
    echo ""
    echo -e "  3. 使用微信扫描终端中显示的二维码"
    echo ""
    echo -e "  4. 授权后，输入 ${CYAN}/bots${NC} 查看你的 Bot ID 和 API Token"
    echo ""
    echo -e "  5. 将获取到的信息填入 ${CYAN}.env${NC} 文件:"
    echo -e "     WECLAW_BOT_ID=你的Bot ID"
    echo -e "     WECLAW_API_TOKEN=你的API Token"
    echo ""
    echo -e "  6. 重启服务使配置生效:"
    echo -e "     ${CYAN}docker compose restart api-server bull-worker${NC}"
    echo ""
    echo -e "${YELLOW}多账号管理:${NC}"
    echo -e "  如需登录多个微信账号，在 WeClaw 控制台中重复执行 /login"
    echo -e "  每个账号会有独立的 Bot ID 和 API Token"
    echo -e "  每次 /login 可添加一个新账号，/bots 查看所有账号"
    echo ""
    echo -e "${YELLOW}⚠️  注意:${NC}"
    echo -e "  - 首次扫码后，需要在微信中给机器人发一条消息以激活"
    echo -e "  - 登录凭证保存在 weclaw_config 卷中，重启不会丢失"
    echo -e "  - 请妥善保管 config/auth.json 中的 API Token"
}

# =============================================================================
# 部署完成总结
# =============================================================================

print_summary() {
    log_step "🎉 部署完成!"

    echo ""
    echo -e "  ${GREEN}✅ 所有服务已启动${NC}"
    echo ""
    echo -e "  服务列表:"
    echo -e "  ┌──────────────────┬──────────────────────────┐"
    echo -e "  │ ${CYAN}API 服务${NC}         │ http://localhost:3000    │"
    echo -e "  │ ${CYAN}健康检查${NC}         │ http://localhost:3000/health │"
    echo -e "  │ ${CYAN}队列统计${NC}         │ http://localhost:3000/stats  │"
    echo -e "  │ ${CYAN}WeClaw 桥接${NC}      │ http://localhost:26322    │"
    echo -e "  │ ${CYAN}Redis${NC}            │ localhost:6379           │"
    echo -e "  │ ${CYAN}PostgreSQL${NC}       │ localhost:5432           │"
    echo -e "  └──────────────────┴──────────────────────────┘"
    echo ""
    echo -e "  常用命令:"
    echo -e "  ${CYAN}docker compose ps${NC}               查看服务状态"
    echo -e "  ${CYAN}docker compose logs -f${NC}          查看实时日志"
    echo -e "  ${CYAN}docker compose logs -f bull-worker${NC}  查看 Worker 日志"
    echo -e "  ${CYAN}docker compose restart api-server${NC}  重启 API 服务"
    echo -e "  ${CYAN}docker compose down${NC}             停止所有服务"
    echo -e "  ${CYAN}docker compose up -d${NC}            重新启动"
    echo ""
    echo -e "  ${YELLOW}下一步: 请完成微信扫码登录 (见上方步骤6)${NC}"
    echo ""
}

# =============================================================================
# 主函数
# =============================================================================

main() {
    print_banner

    # 检查是否以root运行
    if [[ "$EUID" -eq 0 ]]; then
        log_warning "检测到以 root 用户运行，建议使用普通用户"
        read -rp "  是否继续? (y/N): " continue_as_root
        if [[ "$continue_as_root" != "y" && "$continue_as_root" != "Y" ]]; then
            exit 0
        fi
    fi

    # 执行部署步骤
    step1_check_requirements
    step2_install_docker
    step3_configure_env
    step4_build_and_start
    step5_wait_for_services
    step6_wechat_login
    print_summary
}

# 运行
main "$@"
