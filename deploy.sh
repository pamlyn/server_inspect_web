#!/bin/bash

# =============================================================================
# 服务器巡检系统 - 一键部署脚本
# =============================================================================
# 功能：
#   ./deploy.sh init      - 初始化配置文件（首次使用）
#   ./deploy.sh pull      - 拉取最新镜像
#   ./deploy.sh start     - 启动容器
#   ./deploy.sh stop      - 停止容器
#   ./deploy.sh restart   - 重启容器
#   ./deploy.sh logs      - 查看容器日志
#   ./deploy.sh status    - 查看容器状态
#   ./deploy.sh deploy    - 完整部署（init + pull + start）
# =============================================================================

set -e

# -------------------- 配置 --------------------
IMAGE_NAME="harbor.chinajack.com:44330/server_inspect/server_inspect_web:1.4.1"
CONTAINER_NAME="server_inspect_web"
HOST_PORT="59496"

# 解析脚本所在的绝对目录（支持从任意位置执行）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${SCRIPT_DIR}/config"

# 容器内应用端口
APP_PORT="59496"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# -------------------- 函数 --------------------

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查 Docker 是否运行
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        log_error "Docker 未运行，请先启动 Docker"
        exit 1
    fi
}

# 初始化配置文件
init_config() {
    log_info "初始化配置文件..."

    # 创建配置目录
    mkdir -p "${CONFIG_DIR}"

    # 复制示例配置文件（如果外部配置不存在）
    if [ ! -f "${CONFIG_DIR}/config.json" ]; then
        # 优先使用项目已有的配置文件
        if [ -f "${SCRIPT_DIR}/config.json" ]; then
            cp "${SCRIPT_DIR}/config.json" "${CONFIG_DIR}/config.json"
            log_success "已复制项目配置文件到: ${CONFIG_DIR}/config.json"
            log_info "外部配置文件将挂载到容器，覆盖镜像内配置"
        elif [ -f "${SCRIPT_DIR}/config/config.json.example" ]; then
            cp "${SCRIPT_DIR}/config/config.json.example" "${CONFIG_DIR}/config.json"
            log_success "已创建配置文件: ${CONFIG_DIR}/config.json"
            log_warn "请编辑配置文件设置数据库和钉钉配置"
        else
            # 自动生成最小可用配置文件
            generate_default_config
            log_success "已自动生成配置文件: ${CONFIG_DIR}/config.json"
            log_warn "请编辑配置文件设置数据库和钉钉配置"
        fi
    else
        log_info "配置文件已存在，跳过初始化"
    fi

    if [ ! -f "${CONFIG_DIR}/custom_scripts.json" ]; then
        if [ -f "${SCRIPT_DIR}/custom_scripts.json" ]; then
            cp "${SCRIPT_DIR}/custom_scripts.json" "${CONFIG_DIR}/custom_scripts.json"
            log_success "已复制自定义脚本配置到: ${CONFIG_DIR}/custom_scripts.json"
        elif [ -f "${SCRIPT_DIR}/config/custom_scripts.json.example" ]; then
            cp "${SCRIPT_DIR}/config/custom_scripts.json.example" "${CONFIG_DIR}/custom_scripts.json"
            log_success "已创建自定义脚本配置: ${CONFIG_DIR}/custom_scripts.json"
        else
            echo '{"scripts": [], "next_id": 1}' > "${CONFIG_DIR}/custom_scripts.json"
            log_success "已创建自定义脚本配置: ${CONFIG_DIR}/custom_scripts.json"
        fi
    fi

    log_success "配置文件初始化完成"
    echo ""
    echo "配置文件位置: ${CONFIG_DIR}/"
    echo "  - config.json: 主配置文件"
    echo "  - custom_scripts.json: 自定义脚本"
    echo ""
}

# 生成默认最小配置
generate_default_config() {
    cat > "${CONFIG_DIR}/config.json" << 'CONFIG_EOF'
{
  "projectName": "服务器巡检系统",
  "scheduler": {
    "enabled": false,
    "cron": "*/20 * * * *",
    "only_error_notification": false
  },
  "dailyInspection": {
    "enabled": true,
    "hour": 7,
    "minute": 28,
    "only_error_notification": false
  },
  "realTimeMonitoring": {
    "enabled": false,
    "interval": 120,
    "items": {
      "cpu": false,
      "memory": false,
      "disk": false,
      "disk_io": false,
      "swap": false,
      "processes": false,
      "slow_sql": false,
      "worker_output_with_color_size": false,
      "worker_output_without_color_size": false,
      "worker_output_sfd": false,
      "mes_hanging": false
    },
    "notification": {
      "enabled": true,
      "only_error": true,
      "alert_levels": [
        "warning",
        "critical"
      ],
      "dingtalk": true,
      "cooldown_period": 600
    },
    "performance": {
      "max_concurrent_checks": 3,
      "timeout": 10,
      "resource_limit": {
        "cpu_percent": 15,
        "memory_mb": 200
      }
    }
  },
  "thresholds": {
    "cpu": {
      "warning": 80,
      "critical": 90
    },
    "memory": {
      "warning": 80,
      "critical": 90
    },
    "disk": {
      "warning": 80,
      "critical": 90
    },
    "disk_free": {
      "warning": 20,
      "critical": 15
    },
    "slow_sql": {
      "warning": 5,
      "critical": 10
    }
  },
  "inspectionItems": {
    "system_info": false,
    "cpu": false,
    "memory": false,
    "swap": false,
    "disk": false,
    "disk_io": false,
    "processes": false,
    "slow_sql": false
  },
  "scheduledInspectionItems": {
    "system_info": false,
    "cpu": false,
    "memory": false,
    "swap": false,
    "disk": false,
    "disk_io": false,
    "processes": false,
    "slow_sql": false,
    "database": false,
    "network": false,
    "worker_output_with_color_size": false,
    "worker_output_without_color_size": false,
    "worker_output_sfd": false,
    "mes_hanging": false
  },
  "dailyInspectionItems": {
    "system_info": false,
    "cpu": false,
    "memory": false,
    "swap": false,
    "disk": false,
    "disk_io": false,
    "processes": false,
    "slow_sql": false,
    "database": false,
    "network": false,
    "worker_output_with_color_size": false,
    "worker_output_without_color_size": false,
    "worker_output_sfd": false,
    "mes_hanging": false
  },
  "fullInspectionItems": {
    "system_info": false,
    "cpu": false,
    "memory": false,
    "swap": false,
    "disk": false,
    "disk_io": false,
    "processes": false,
    "slow_sql": false,
    "database": false,
    "network": false,
    "worker_output_with_color_size": false,
    "worker_output_without_color_size": false,
    "worker_output_sfd": false,
    "mes_hanging": false
  },
  "dingtalk": {
    "enabled": true,
    "webhooks": [
      "https://oapi.dingtalk.com/robot/send?access_token=YOUR_DINGTALK_TOKEN"
    ],
    "secret": "",
    "show_details": false
  },
  "databaseConfig": {
    "mes": {
      "type": "postgresql",
      "host": "localhost",
      "port": 5432,
      "user": "postgres",
      "password": "your_password",
      "database": "mes"
    },
    "hanging": {
      "type": "mysql",
      "host": "localhost",
      "port": 3306,
      "user": "root",
      "password": "your_password",
      "database": "hanging"
    }
  },
  "inspectionDateConfig": {
    "enabled": true,
    "options": {
      "yesterday": true,
      "today": false,
      "last_n_to_yesterday": false,
      "last_n_to_today": false,
      "current_month_to_yesterday": false,
      "current_month_to_today": false,
      "custom": false
    },
    "last_n_days": 7,
    "custom_date_range": {
      "start_date": "",
      "end_date": ""
    }
  },
  "logDatabase": {
    "enabled": false,
    "type": "postgresql",
    "host": "",
    "port": 5432,
    "user": "",
    "password": "",
    "database": ""
  },
  "arthasServers": []
}
CONFIG_EOF
}

# 拉取镜像
pull_image() {
    log_info "正在拉取镜像: ${IMAGE_NAME}"
    # 检测宿主机架构并指定拉取对应平台
    HOST_ARCH=$(docker info --format '{{.Architecture}}' 2>/dev/null || uname -m)
    if echo "${HOST_ARCH}" | grep -q "x86_64\|amd64"; then
        PLATFORM="linux/amd64"
    else
        PLATFORM="linux/${HOST_ARCH}"
    fi
    log_info "目标平台: ${PLATFORM}"
    docker pull --platform "${PLATFORM}" "${IMAGE_NAME}"
    log_success "镜像拉取完成"
}

# 检查容器是否存在
container_exists() {
    docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"
}

# 检查容器是否运行
container_running() {
    docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"
}

# 启动容器
start_container() {
    check_docker

    if container_running; then
        log_warn "容器 ${CONTAINER_NAME} 已在运行中"
        return
    fi

    # 检测宿主机架构
    HOST_ARCH=$(docker info --format '{{.Architecture}}' 2>/dev/null || uname -m)
    log_info "宿主机架构: ${HOST_ARCH}"

    if container_exists; then
        log_info "启动已存在的容器..."
        docker start "${CONTAINER_NAME}"
    else
        log_info "创建并启动新容器..."

        # 构建 Docker 运行命令
        DOCKER_CMD="docker run -d \
            --name ${CONTAINER_NAME} \
            --restart unless-stopped \
            --platform linux/amd64 \
            -p ${HOST_PORT}:${APP_PORT}"

        # 添加配置目录挂载
        if [ -d "${CONFIG_DIR}" ]; then
            DOCKER_CMD="${DOCKER_CMD} \
                -v ${CONFIG_DIR}/config.json:/app/config/config.json \
                -v ${CONFIG_DIR}/custom_scripts.json:/app/config/custom_scripts.json"
        fi

        # 添加 Cookies 文件（如果存在）
        if [ -f "${CONFIG_DIR}/cookies.txt" ]; then
            DOCKER_CMD="${DOCKER_CMD} \
                -v ${CONFIG_DIR}/cookies.txt:/app/cookies.txt"
        fi

        # 挂载 Docker socket（用于从容器内查看宿主机的 Docker 容器）
        if [ -S /var/run/docker.sock ]; then
            DOCKER_CMD="${DOCKER_CMD} \
                -v /var/run/docker.sock:/var/run/docker.sock"
            log_info "已挂载 Docker socket：可在容器内检测宿主机容器"
        fi

        # 添加环境变量（可选）
        DOCKER_CMD="${DOCKER_CMD} \
            -e TZ=Asia/Shanghai"

        # 添加镜像
        DOCKER_CMD="${DOCKER_CMD} ${IMAGE_NAME}"

        # 执行命令
        eval "${DOCKER_CMD}"
    fi

    # 验证容器是否真的启动成功
    sleep 2
    if container_running; then
        log_success "容器 ${CONTAINER_NAME} 已启动"
        log_info "访问地址: http://localhost:${HOST_PORT}"
    else
        log_error "容器启动后异常退出！请查看日志: ./deploy.sh logs"
        docker logs --tail 30 "${CONTAINER_NAME}" 2>&1 || true
        exit 1
    fi
}

# 停止容器
stop_container() {
    check_docker

    if container_running; then
        log_info "停止容器 ${CONTAINER_NAME}..."
        docker stop "${CONTAINER_NAME}"
        log_success "容器已停止"
    else
        log_warn "容器 ${CONTAINER_NAME} 未运行"
    fi
}

# 重启容器
restart_container() {
    check_docker

    if container_exists; then
        stop_container
        sleep 2
        start_container
    else
        log_warn "容器 ${CONTAINER_NAME} 不存在，将创建新容器"
        start_container
    fi
}

# 查看日志
show_logs() {
    check_docker

    if container_exists; then
        if [ "$1" == "-f" ] || [ "$1" == "--follow" ]; then
            log_info "跟踪容器日志 (Ctrl+C 退出)..."
            docker logs -f "${CONTAINER_NAME}"
        else
            log_info "最近 100 行日志:"
            docker logs --tail 100 "${CONTAINER_NAME}"
        fi
    else
        log_error "容器 ${CONTAINER_NAME} 不存在"
        exit 1
    fi
}

# 查看状态
show_status() {
    check_docker

    echo ""
    echo "=============================================="
    echo "           容器状态信息"
    echo "=============================================="
    echo ""

    if container_running; then
        echo -e "${GREEN}状态:${NC} 运行中"
        echo ""
        echo "容器信息:"
        docker ps --filter "name=${CONTAINER_NAME}" --format "  镜像: {{.Image}}
  端口: ${HOST_PORT} -> ${APP_PORT}
  状态: {{.Status}}
  运行时间: {{.RunningFor}}" 2>/dev/null || true
        echo ""
        echo "访问地址: http://localhost:${HOST_PORT}"
    elif container_exists; then
        echo -e "${YELLOW}状态:${NC} 已停止"
        echo ""
        docker ps -a --filter "name=${CONTAINER_NAME}" --format "  镜像: {{.Image}}
  状态: {{.Status}}" 2>/dev/null || true
    else
        echo -e "${RED}状态:${NC} 未部署"
        echo ""
        echo "镜像信息:"
        docker images --filter "reference=${IMAGE_NAME}" --format "  镜像: {{.Repository}}:{{.Tag}}
  ID: {{.ID}}
  大小: {{.Size}}" 2>/dev/null || echo "  未拉取"
        echo ""
        echo "提示: 运行 './deploy.sh deploy' 进行部署"
    fi
    echo ""
    echo "=============================================="
}

# 完整部署
deploy() {
    check_docker
    init_config
    pull_image

    # 容器已存在则重建：否则 start_container 在容器运行中只会 no-op（见 start_container
    # 的「已在运行中」分支），旧进程不会重启 -> 内存配置(_config_state)与调度器任务表
    # 都不会刷新，表现为「第二次部署后系统页面配置/调度不生效，需手动 restart 才读取」。
    # 重建后全新进程会重跑 load_config_from_file() + start_scheduler()，配置即时生效。
    if container_exists; then
        log_info "检测到已有容器 ${CONTAINER_NAME}，重建以应用最新镜像与配置..."
        docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
        log_success "旧容器已移除"
    fi

    start_container
    echo ""
    log_success "部署完成!（已应用最新镜像与配置）"
    echo ""
    echo "访问地址: http://localhost:${HOST_PORT}"
    echo ""
}

# 重新拉取镜像并部署（强制用最新镜像重建容器）
# 与 deploy 的区别：不跑 init（保留现有挂载配置），其余均为「拉镜像 + 存在即重建」。
# deploy 现在也会在容器已存在时重建，两者唯一差异是 deploy 会先跑 init_config。
# restart 仅 stop+start（复用容器），用于改了挂载配置后重启进程重读配置，不换镜像。
redeploy() {
    check_docker
    pull_image

    if container_exists; then
        log_info "停止并删除旧容器 ${CONTAINER_NAME}（以便用新镜像重建）..."
        docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
        log_success "旧容器已删除"
    else
        log_info "容器 ${CONTAINER_NAME} 不存在，将直接创建"
    fi

    start_container
    echo ""
    log_success "重新部署完成!（已使用最新镜像）"
    echo ""
    echo "访问地址: http://localhost:${HOST_PORT}"
    echo ""
}

# 卸载
uninstall() {
    check_docker

    if container_exists; then
        log_warn "即将删除容器 ${CONTAINER_NAME}..."
        read -p "确认删除? (y/N): " confirm
        if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
            docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
            log_success "容器已删除"
        else
            log_info "已取消"
        fi
    else
        log_warn "容器 ${CONTAINER_NAME} 不存在"
    fi
}

# 帮助信息
show_help() {
    echo ""
    echo "=============================================="
    echo "       服务器巡检系统 - 部署管理脚本"
    echo "=============================================="
    echo ""
    echo "用法: ./deploy.sh <命令>"
    echo ""
    echo "命令:"
    echo "  init      初始化配置文件"
    echo "  pull      拉取最新镜像"
    echo "  start     启动容器"
    echo "  stop      停止容器"
    echo "  restart   重启容器"
    echo "  logs      查看容器日志"
    echo "  logs -f   跟踪容器日志 (Ctrl+C 退出)"
    echo "  status    查看容器状态"
    echo "  deploy    完整部署 (init + pull + start)"
    echo "  redeploy  重新拉取镜像并部署 (pull + 删旧容器 + 重建，用最新镜像)"
    echo "  uninstall 卸载容器"
    echo "  help      显示帮助信息"
    echo ""
    echo "配置文件目录: ${CONFIG_DIR}"
    echo ""
    echo "示例:"
    echo "  首次部署:      ./deploy.sh deploy"
    echo "  更新镜像部署:  ./deploy.sh redeploy"
    echo "  查看状态:      ./deploy.sh status"
    echo "  查看日志:      ./deploy.sh logs"
    echo "  重启:         ./deploy.sh restart"
    echo ""
    echo "=============================================="
}

# -------------------- 主程序 --------------------

# 确保脚本在正确目录执行
cd "${SCRIPT_DIR}"

case "${1:-}" in
    init)
        check_docker
        init_config
        ;;
    pull)
        check_docker
        pull_image
        ;;
    start)
        start_container
        ;;
    stop)
        stop_container
        ;;
    restart)
        restart_container
        ;;
    logs)
        show_logs "$2"
        ;;
    status)
        show_status
        ;;
    deploy)
        deploy
        ;;
    redeploy)
        redeploy
        ;;
    uninstall)
        uninstall
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        log_error "未知命令: $1"
        echo ""
        show_help
        exit 1
        ;;
esac
