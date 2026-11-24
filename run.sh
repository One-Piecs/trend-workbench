#!/usr/bin/env bash
# 本地运行趋势判断工作台：依赖检查 -> 构建 -> 启动本地服务。
# 用法: ./run.sh [端口]   端口默认 44123。
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
port=${1:-44123}

command -v node >/dev/null || { echo "缺少 Node.js（建议 24.x）"; exit 1; }

if [[ ! -d "$root/work/chan-market/node_modules" ]]; then
  echo "安装前端依赖..."
  npm ci --prefix "$root/work/chan-market"
fi

echo "构建共享资源..."
npm run build --prefix "$root/work/chan-market"

echo "启动本地服务 http://127.0.0.1:${port}（Ctrl+C 退出）"
exec node "$root/outputs/shared/server.mjs" --port "$port"
