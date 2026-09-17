#!/bin/bash

# Lazy macOS one-click launcher.
# It keeps its Node.js runtime inside the project, so a new Mac needs no
# Homebrew, administrator password, or system-wide Node.js installation.

set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$PROJECT_DIR/.lazy-runtime"
NODE_HOME="$RUNTIME_DIR/node"
LOG_DIR="$RUNTIME_DIR/logs"
LOG_FILE="$LOG_DIR/lazy.log"
PID_FILE="$RUNTIME_DIR/lazy.pid"
DEPENDENCY_MARKER="$RUNTIME_DIR/dependencies.version"
BUILD_MARKER="$RUNTIME_DIR/web-build.version"
URL="http://127.0.0.1:7878"
NODE_RELEASE_LINE="24"

mkdir -p "$RUNTIME_DIR" "$LOG_DIR"
cd "$PROJECT_DIR" || exit 1

pause_on_error() {
  echo ""
  echo "启动失败：$1"
  echo "日志：$LOG_FILE"
  echo ""
  read -r -p "按回车键关闭窗口……" _unused
  exit 1
}

health_ok() {
  curl -fsS --max-time 2 "$URL/api/health" 2>/dev/null \
    | grep -Fq "\"workspace\":\"$PROJECT_DIR/workspace\""
}

frontend_ok() {
  INDEX_HTML="$(curl -fsS --max-time 2 "$URL/" 2>/dev/null)" || return 1
  ASSET_PATH="$(printf '%s' "$INDEX_HTML" | grep -oE '/static/assets/[^" ]+\.(js|css)' | head -n 1)"
  [ -n "$ASSET_PATH" ] && curl -fsS --max-time 2 "$URL$ASSET_PATH" >/dev/null 2>&1
}

record_listener_pid() {
  LISTENER_PID="$(lsof -tiTCP:7878 -sTCP:LISTEN 2>/dev/null | head -n 1)"
  if [ -n "$LISTENER_PID" ]; then
    printf '%s\n' "$LISTENER_PID" > "$PID_FILE"
  fi
}

node_is_compatible() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22&&b>=13) || (a===20&&b>=19) ? 0 : 1)' >/dev/null 2>&1
}

node_runtime_is_usable() {
  CANDIDATE_NODE="$1"
  CANDIDATE_BIN_DIR="$(dirname "$CANDIDATE_NODE")"
  CANDIDATE_NPM="$CANDIDATE_BIN_DIR/npm"

  node_is_compatible "$CANDIDATE_NODE" \
    && [ -x "$CANDIDATE_NPM" ] \
    && PATH="$CANDIDATE_BIN_DIR:$PATH" "$CANDIDATE_NPM" --version >/dev/null 2>&1
}

install_local_node() {
  case "$(uname -m)" in
    arm64) NODE_ARCH="arm64" ;;
    x86_64) NODE_ARCH="x64" ;;
    *) pause_on_error "不支持的 Mac 处理器：$(uname -m)" ;;
  esac

  DOWNLOAD_BASE="https://nodejs.org/dist/latest-v${NODE_RELEASE_LINE}.x"
  DOWNLOAD_DIR="$RUNTIME_DIR/download"
  MANIFEST="$DOWNLOAD_DIR/SHASUMS256.txt"
  STAGING="$RUNTIME_DIR/node-staging"

  mkdir -p "$DOWNLOAD_DIR"
  echo "首次运行：正在下载项目专用 Node.js ${NODE_RELEASE_LINE} LTS（无需管理员权限）……"
  if ! curl --fail --location --retry 3 --connect-timeout 15 \
    "$DOWNLOAD_BASE/SHASUMS256.txt" -o "$MANIFEST"; then
    pause_on_error "无法连接 nodejs.org。请检查网络后再次双击启动。"
  fi

  ARCHIVE_NAME="$(awk -v target="darwin-${NODE_ARCH}.tar.gz" '$2 ~ /^node-v24\./ && $2 ~ target"$" { print $2; exit }' "$MANIFEST")"
  EXPECTED_HASH="$(awk -v file="$ARCHIVE_NAME" '$2 == file { print $1; exit }' "$MANIFEST")"
  if [ -z "$ARCHIVE_NAME" ] || [ -z "$EXPECTED_HASH" ]; then
    pause_on_error "Node.js 下载清单中没有适合这台 Mac 的版本。"
  fi

  ARCHIVE="$DOWNLOAD_DIR/$ARCHIVE_NAME"
  if ! curl --fail --location --retry 3 --connect-timeout 15 \
    "$DOWNLOAD_BASE/$ARCHIVE_NAME" -o "$ARCHIVE"; then
    pause_on_error "Node.js 下载失败。请检查网络后重试。"
  fi

  ACTUAL_HASH="$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')"
  if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
    pause_on_error "Node.js 文件校验失败，已拒绝运行。"
  fi

  rm -rf "$STAGING"
  mkdir -p "$STAGING"
  if ! tar -xzf "$ARCHIVE" -C "$STAGING"; then
    pause_on_error "Node.js 解压失败。"
  fi

  EXTRACTED_DIR="$STAGING/${ARCHIVE_NAME%.tar.gz}"
  if [ ! -x "$EXTRACTED_DIR/bin/node" ]; then
    pause_on_error "Node.js 解压结果不完整。"
  fi

  rm -rf "$NODE_HOME"
  mv "$EXTRACTED_DIR" "$NODE_HOME"
  rm -rf "$STAGING"
}

echo "============================================================"
echo "  Lazy · 本地设计搭子"
echo "============================================================"

if [ "$(uname -s)" != "Darwin" ]; then
  pause_on_error "这个入口仅用于 macOS。Windows 请使用 start-web.bat。"
fi

# Reuse a healthy instance. Do not kill an unrelated process on the same port.
if health_ok; then
  if frontend_ok; then
    record_listener_pid
    echo "Lazy 已经在运行，正在打开……"
    open "$URL"
    exit 0
  fi
  pause_on_error "Lazy 服务正在运行，但网页资源不完整。请先双击 stop-web.command，再重新打开 Lazy。"
fi

PORT_PID="$(lsof -tiTCP:7878 -sTCP:LISTEN 2>/dev/null | head -n 1)"
if [ -n "$PORT_PID" ]; then
  PORT_COMMAND="$(ps -p "$PORT_PID" -o command= 2>/dev/null)"
  pause_on_error "端口 7878 正被其他程序占用（PID $PORT_PID：$PORT_COMMAND）。"
fi

NODE_BIN=""
if command -v node >/dev/null 2>&1 && node_runtime_is_usable "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
elif [ -x "$NODE_HOME/bin/node" ] && node_runtime_is_usable "$NODE_HOME/bin/node"; then
  NODE_BIN="$NODE_HOME/bin/node"
else
  install_local_node
  NODE_BIN="$NODE_HOME/bin/node"
fi

export PATH="$(dirname "$NODE_BIN"):$PATH"
NODE_VERSION="$($NODE_BIN --version)"
NPM_BIN="$(dirname "$NODE_BIN")/npm"
if [ ! -x "$NPM_BIN" ]; then
  pause_on_error "找不到与 $NODE_VERSION 配套的 npm。"
fi

LOCK_HASH="$(shasum -a 256 package-lock.json | awk '{ print $1 }')"
DEPENDENCY_VERSION="$LOCK_HASH|$NODE_VERSION"
INSTALLED_VERSION=""
if [ -f "$DEPENDENCY_MARKER" ]; then
  INSTALLED_VERSION="$(sed -n '1p' "$DEPENDENCY_MARKER")"
fi

if [ ! -d node_modules ] || [ "$INSTALLED_VERSION" != "$DEPENDENCY_VERSION" ]; then
  echo "正在安装项目依赖（首次运行会需要几分钟）……"
  if ! "$NPM_BIN" ci --no-audit --no-fund; then
    pause_on_error "项目依赖安装失败。"
  fi
  printf '%s\n' "$DEPENDENCY_VERSION" > "$DEPENDENCY_MARKER"
fi

if [ ! -f vite.config.ts ]; then
  pause_on_error "缺少 vite.config.ts，无法确认网页构建方式。"
fi

NEEDS_BUILD=0
if [ ! -f "$BUILD_MARKER" ] || [ ! -f src/web/static/index.html ]; then
  NEEDS_BUILD=1
elif find src/web/client vite.config.ts package.json package-lock.json -type f -newer "$BUILD_MARKER" -print -quit | grep -q .; then
  NEEDS_BUILD=1
fi

if [ "$NEEDS_BUILD" -eq 1 ]; then
  echo "正在构建界面……"
  if ! "$NPM_BIN" run build:web; then
    pause_on_error "界面构建失败。"
  fi
  printf '%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$BUILD_MARKER"
fi

if ! grep -Fq '/static/assets/' src/web/static/index.html; then
  pause_on_error "网页资源路径与本地服务不一致。请确认 vite.config.ts 中包含 base: \"/static/\"。"
fi

echo "正在启动 Lazy……"
printf '\n[%s] Starting Lazy with Node %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$NODE_VERSION" >> "$LOG_FILE"

# Keep the server attached to Terminal. This works reliably even when the
# project lives in Desktop/Documents, where background LaunchAgents may not
# receive macOS privacy permission. The small helper opens the browser as soon
# as the health endpoint becomes ready.
(
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 60 ]; do
    if health_ok; then
      record_listener_pid
      open "$URL"
      exit 0
    fi
    sleep 1
    ATTEMPT=$((ATTEMPT + 1))
  done
) &

printf '%s\n' "$$" > "$PID_FILE"
echo "浏览器会自动打开。使用期间请保留此窗口（可以最小化）。"
echo "要停止 Lazy，请回到这里按 Control+C。"
echo ""

# Show server output in Terminal and append the same output to the log.
exec > >(tee -a "$LOG_FILE") 2>&1
exec "$NODE_BIN" "$PROJECT_DIR/node_modules/tsx/dist/cli.mjs" "$PROJECT_DIR/src/web/server.ts"
