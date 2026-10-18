#!/usr/bin/env bash
# 画布服务启动脚本（macOS / Linux / WSL）
set -e
cd "$(dirname "$0")"
export CANVAS_PORT="${CANVAS_PORT:-17800}"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] 未找到 node，请先安装 Node.js 18+"
  exit 1
fi

echo "============================================"
echo " Web 画布启动中..."
echo " 地址: http://127.0.0.1:${CANVAS_PORT}/"
echo " 目录: $(pwd)"
echo " Ctrl+C 停止服务"
echo "============================================"
exec node _canvas/server.mjs
