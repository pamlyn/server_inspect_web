#!/bin/bash

# 服务器巡检Web应用一键启动脚本

APP_NAME="server_inspect_web"
PID_FILE="app.pid"
LOG_FILE="app.log"

echo "===================================="
echo "服务器巡检Web应用一键启动脚本"
echo "===================================="

# 检查是否已经运行
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "应用已在运行中 (PID: $PID)"
        echo "如需停止，请运行: sh stop.sh"
        echo "如需重启，请先停止再启动"
        exit 0
    else
        rm -f "$PID_FILE"
    fi
fi

# 检查Python是否安装
if ! command -v python3 &> /dev/null; then
    echo "未找到Python3，尝试自动安装..."
    
    # 尝试不同的包管理器安装Python 3.12.9
    if command -v apt-get &> /dev/null; then
        echo "使用apt-get安装Python 3.12.9..."
        sudo apt-get update && sudo apt-get install -y python3.12
    elif command -v yum &> /dev/null; then
        echo "使用yum安装Python 3.12.9..."
        sudo yum install -y python3.12
    elif command -v dnf &> /dev/null; then
        echo "使用dnf安装Python 3.12.9..."
        sudo dnf install -y python3.12
    elif command -v brew &> /dev/null; then
        echo "使用brew安装Python 3.12.9..."
        brew install python@3.12
    else
        echo "错误: 无法自动安装Python3，请手动安装"
        echo "安装命令示例:"
        echo "  Ubuntu/Debian: sudo apt-get install python3.12"
        echo "  CentOS/RHEL: sudo yum install python3.12"
        echo "  macOS: brew install python@3.12 或从官网下载安装包"
        exit 1
    fi
    
    # 再次检查Python是否安装成功
    if ! command -v python3 &> /dev/null; then
        echo "错误: Python3安装失败，请手动安装"
        exit 1
    fi
    echo "Python3安装成功"
fi

# 检查pip是否安装
PIP_CMD=""
# 获取Python 3.12的完整路径
PYTHON3_PATH=$(which python3.12 2>/dev/null || which python3 2>/dev/null)

if [ -n "$PYTHON3_PATH" ]; then
    # 使用完整路径调用python3 -m pip，确保使用正确的Python版本
    PIP_CMD="$PYTHON3_PATH -m pip"
    echo "使用 $PYTHON3_PATH -m pip 作为包管理工具"
elif command -v pip3.12 &> /dev/null; then
    PIP_CMD="pip3.12"
    echo "使用 pip3.12 作为包管理工具"
elif command -v pip3 &> /dev/null; then
    PIP_CMD="pip3"
    echo "使用 pip3 作为包管理工具"
elif command -v pip &> /dev/null; then
    PIP_CMD="pip"
    echo "使用 pip 作为包管理工具"
else
    echo "未找到pip，尝试自动安装..."
    
    # 尝试不同的方法安装pip
    if [ -n "$PYTHON3_PATH" ]; then
        echo "使用$PYTHON3_PATH -m ensurepip安装pip..."
        "$PYTHON3_PATH" -m ensurepip --upgrade
    elif command -v apt-get &> /dev/null; then
        echo "使用apt-get安装python3-pip..."
        sudo apt-get update && sudo apt-get install -y python3-pip
    elif command -v yum &> /dev/null; then
        echo "使用yum安装python3-pip..."
        sudo yum install -y python3-pip
    elif command -v dnf &> /dev/null; then
        echo "使用dnf安装python3-pip..."
        sudo dnf install -y python3-pip
    else
        echo "尝试使用get-pip.py安装pip..."
        curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py && python3 get-pip.py
        rm -f get-pip.py
    fi
    
    # 再次检查pip是否安装成功
    PYTHON3_PATH=$(which python3.12 2>/dev/null || which python3 2>/dev/null)
    if [ -n "$PYTHON3_PATH" ]; then
        PIP_CMD="$PYTHON3_PATH -m pip"
    elif command -v pip3.12 &> /dev/null; then
        PIP_CMD="pip3.12"
    elif command -v pip3 &> /dev/null; then
        PIP_CMD="pip3"
    elif command -v pip &> /dev/null; then
        PIP_CMD="pip"
    else
        echo "错误: pip安装失败，请手动安装"
        echo "安装命令示例:"
        echo "  Ubuntu/Debian: sudo apt-get install python3-pip"
        echo "  CentOS/RHEL: sudo yum install python3-pip"
        echo "  macOS: python3.12 -m ensurepip --upgrade"
        echo "  或使用: curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py && python3.12 get-pip.py"
        exit 1
    fi
    echo "pip安装成功"
fi

# 检查docker命令是否安装
echo "检查docker命令..."
if ! command -v docker &> /dev/null; then
    echo "未找到docker命令，尝试自动安装..."
    
    # 尝试不同的包管理器安装docker
    if command -v apt-get &> /dev/null; then
        echo "使用apt-get安装docker..."
        sudo apt-get update && sudo apt-get install -y docker.io
    elif command -v yum &> /dev/null; then
        echo "使用yum安装docker..."
        sudo yum install -y docker
    elif command -v dnf &> /dev/null; then
        echo "使用dnf安装docker..."
        sudo dnf install -y docker
    else
        echo "错误: 无法自动安装docker，请手动安装"
        echo "安装命令示例:"
        echo "  Ubuntu/Debian: sudo apt-get install docker.io"
        echo "  CentOS/RHEL: sudo yum install docker"
        echo "  macOS: brew install docker 或从官网下载安装包"
        # 继续执行，不退出
        echo "继续执行，跳过Docker容器检查..."
    fi
    
    # 再次检查docker是否安装成功
    if command -v docker &> /dev/null; then
        echo "docker安装成功"
        # 尝试启动docker服务
        if command -v systemctl &> /dev/null; then
            echo "尝试启动docker服务..."
            sudo systemctl start docker
            sudo systemctl enable docker
        fi
    else
        echo "docker安装失败，将跳过Docker容器检查..."
    fi
else
    echo "docker命令已安装"
    # 检查docker服务状态
    if command -v systemctl &> /dev/null; then
        docker_status=$(sudo systemctl is-active docker 2>&1)
        if [[ "$docker_status" != "active" ]]; then
            echo "docker服务未运行，尝试启动..."
            sudo systemctl start docker
            sudo systemctl enable docker
        fi
    fi
fi

# ====================================
# 检查 Java 环境
# ====================================

echo "检查Java环境..."
if command -v java &> /dev/null; then
    echo "Java已安装"
    java -version
else
    echo "未找到Java（可选）"
fi



# 安装依赖
echo "正在安装依赖..."
echo "执行命令: $PIP_CMD install --user --trusted-host pypi.org --trusted-host files.pythonhosted.org -r requirements.txt"
echo "Python 版本: $("$PYTHON3_PATH" --version 2>&1)"
echo "Python 路径: $PYTHON3_PATH"
echo "环境变量 PYTHONPATH: $PYTHONPATH"

# 直接使用完整路径执行，不通过变量，并清除可能的PYTHONPATH冲突
PYTHONPATH="" "$PYTHON3_PATH" -m pip install --user --trusted-host pypi.org --trusted-host files.pythonhosted.org -r requirements.txt

if [ $? -ne 0 ]; then
    echo "错误: 依赖安装失败"
    echo "尝试使用以下命令安装:"
    echo "  $PIP_CMD install --user --trusted-host pypi.org --trusted-host files.pythonhosted.org -r requirements.txt"
    exit 1
fi

# 启动应用
echo "正在启动服务器巡检Web应用..."

# 自动检测服务器IP地址
if command -v hostname &> /dev/null; then
    # 尝试使用hostname命令获取IP地址
    SERVER_IP=$(hostname -I | awk '{print $1}')
    if [ -z "$SERVER_IP" ]; then
        # 如果hostname命令失败，尝试使用ifconfig命令
        if command -v ifconfig &> /dev/null; then
            SERVER_IP=$(ifconfig | grep -E 'inet (addr:)?([0-9]*\.){3}[0-9]*' | grep -v '127.0.0.1' | head -n 1 | awk '{print $2}' | sed 's/addr://')
        elif command -v ip &> /dev/null; then
            # 尝试使用ip命令
            SERVER_IP=$(ip addr | grep -E 'inet (?!127\.0\.0\.1)' | head -n 1 | awk '{print $2}' | cut -d'/' -f1)
        fi
    fi
fi

# 如果无法检测到IP地址，使用localhost
if [ -z "$SERVER_IP" ]; then
    SERVER_IP="localhost"
fi

# 设置SERVER_URL
SERVER_URL="http://$SERVER_IP:59496"
echo "应用将运行在 $SERVER_URL"

# 启动应用并设置SERVER_URL环境变量
export SERVER_URL=$SERVER_URL
# 清除PYTHONPATH冲突并使用完整路径执行Python
PYTHONPATH="" nohup "$PYTHON3_PATH" app.py > "$LOG_FILE" 2>&1 &
PID=$!
echo $PID > "$PID_FILE"

sleep 2

if ps -p "$PID" > /dev/null 2>&1; then
    echo "应用启动成功 (PID: $PID)"
    echo "日志文件: $LOG_FILE"
    echo "如需停止，请运行: sh stop.sh"
    echo "如需查看日志，请运行: tail -f $LOG_FILE"
else
    echo "应用启动失败，请查看日志文件: $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi

echo "===================================="
