#!/bin/bash

set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROJECT_DIR/.lazy-runtime/lazy.pid"
URL="http://127.0.0.1:7878"

if [ ! -f "$PID_FILE" ]; then
  echo "Lazy 当前没有记录为运行状态。"
  read -r -p "按回车键关闭窗口……" _unused
  exit 0
fi

PID="$(sed -n '1p' "$PID_FILE")"
LISTENER_PID="$(lsof -tiTCP:7878 -sTCP:LISTEN 2>/dev/null | head -n 1)"
EXPECTED_WORKSPACE="$PROJECT_DIR/workspace"

if [ -z "$PID" ] || [ "$PID" != "$LISTENER_PID" ]; then
  echo "启动记录已经失效；为避免误停其他程序，没有结束任何进程。"
  rm -f "$PID_FILE"
  read -r -p "按回车键关闭窗口……" _unused
  exit 1
fi

if ! curl -fsS --max-time 2 "$URL/api/health" 2>/dev/null | grep -Fq "\"workspace\":\"$EXPECTED_WORKSPACE\""; then
  echo "7878 端口上的程序不是这个项目的 Lazy 实例；没有结束它。"
  read -r -p "按回车键关闭窗口……" _unused
  exit 1
fi

kill "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "Lazy 已停止。"
sleep 1
