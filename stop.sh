#!/bin/bash

# 服务器巡检Web应用停止脚本

PID_FILE="app.pid"

echo "===================================="
echo "服务器巡检Web应用停止脚本"
echo "===================================="

if [ ! -f "$PID_FILE" ]; then
    echo "未找到PID文件，应用可能未运行"
    exit 0
fi

PID=$(cat "$PID_FILE")

if ! ps -p "$PID" > /dev/null 2>&1; then
    echo "应用未运行 (PID: $PID)"
    rm -f "$PID_FILE"
    exit 0
fi

echo "正在停止应用 (PID: $PID)..."
kill "$PID"

sleep 2

if ps -p "$PID" > /dev/null 2>&1; then
    echo "应用未响应，强制停止..."
    kill -9 "$PID"
    sleep 1
fi

if ps -p "$PID" > /dev/null 2>&1; then
    echo "停止应用失败"
    exit 1
else
    echo "应用已停止"
    rm -f "$PID_FILE"
fi

echo "===================================="
