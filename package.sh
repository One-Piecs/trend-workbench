#!/usr/bin/env bash
# 打包趋势判断工作台：测试 -> typecheck -> 原生 launcher -> macOS ZIP -> 验收。
# 用法: ./package.sh            完整打包（默认 dist/Trend-Workbench-macOS-arm64.zip）
#       ./package.sh --skip-tests  跳过测试与 typecheck，只构建打包
#       ./package.sh --check-feed  验收时附带真实行情请求检查
# 需求: Node.js 24.x、npm、Python 3.11+、Xcode Command Line Tools（Apple 芯片）
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
cd "$root"

output="dist/Trend-Workbench-macOS-arm64.zip"
verify_args=()
for arg in "$@"; do
  case "$arg" in
    --skip-tests) skip_tests=1 ;;
    --check-feed) verify_args+=("$arg") ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

command -v node >/dev/null  || { echo "缺少 Node.js"; exit 1; }

# 打包脚本需要 Python 3.11+（hashlib.file_digest），系统自带 3.9 不够
py=""
for candidate in python3.15 python3.14 python3.13 python3.12 python3.11; do
  if command -v "$candidate" >/dev/null 2>&1; then py=$candidate; break; fi
done
py=${py:-python3}
"$py" -c 'import hashlib; hashlib.file_digest' 2>/dev/null \
  || { echo "需要 Python 3.11 或更高版本（当前 $py 过旧）"; exit 1; }

if [[ ! -d "$root/work/chan-market/node_modules" ]]; then
  echo "[1/6] 安装依赖..."
  npm ci --prefix work/chan-market
fi

if [[ -z "${skip_tests:-}" ]]; then
  echo "[2/6] 运行测试与类型检查..."
  npm test --prefix work/chan-market
  npm run typecheck --prefix work/chan-market
  node --test work/local-workbench/network-bootstrap.test.mjs
else
  echo "[2/6] 跳过测试（--skip-tests）"
fi

echo "[3/6] 获取已校验的 Node 运行环境（已有则复用）..."
node_dir="$root/.build/node-mac"
if [[ ! -x "$node_dir/bin/node" ]]; then
  "$py" work/local-workbench/fetch_runtime.py darwin-arm64 "$node_dir"
fi

echo "[4/6] 编译原生 launcher..."
bash work/local-workbench/macos/build-native.sh .build/TrendWorkbench

echo "[5/6] 打包 $output..."
"$py" work/local-workbench/macos/package_app.py \
  --launcher .build/TrendWorkbench \
  --node-dir "$node_dir" \
  --output "$output"

echo "[6/6] 验收..."
"$py" work/local-workbench/macos/verify_archive.py "$output" "${verify_args[@]+"${verify_args[@]}"}"

echo "完成: $output"
unzip -l "$output" | tail -3
