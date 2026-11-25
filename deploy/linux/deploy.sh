#!/usr/bin/env bash
# Deploy/update trend-workbench on Linux with an isolated Node.js 24 runtime and a user-level systemd service.
set -euo pipefail

NODE_VERSION="24.14.1"
SHA256_ARM64="71e427e28b78846f201d4d5ecc30cb13d1508ca099ef3871889a1256c7d6f67e"
SHA256_X64="84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be"

port="${PORT:-44123}"
node_dir="${NODE_DIR:-$HOME/.local/opt/node24}"
service_name="${SERVICE_NAME:-trend-workbench}"
force_ci=0
skip_tests=0
update_service=0
no_restart=0

usage() {
  cat <<'EOF'
Usage: ./deploy/linux/deploy.sh [options]

Options:
  --port <port>       Loopback port for the server (1024..65535, default: 44123)
  --node-dir <dir>    Standalone Node.js 24 prefix/symlink (default: ~/.local/opt/node24)
  --service <name>    systemd --user service name (default: trend-workbench)
  --ci                Force `npm ci --prefix work/chan-market`
  --skip-tests        Skip `node --test` checks
  --update-service    Overwrite existing ~/.config/systemd/user/<service>.service
  --no-restart        Build and test only; skip systemd unit update and restart
  -h, --help          Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || { echo "Missing value for --port" >&2; exit 1; }
      port="$2"
      shift 2
      ;;
    --node-dir)
      [[ $# -ge 2 ]] || { echo "Missing value for --node-dir" >&2; exit 1; }
      node_dir="$2"
      shift 2
      ;;
    --service)
      [[ $# -ge 2 ]] || { echo "Missing value for --service" >&2; exit 1; }
      service_name="$2"
      shift 2
      ;;
    --ci)
      force_ci=1
      shift
      ;;
    --skip-tests)
      skip_tests=1
      shift
      ;;
    --update-service)
      update_service=1
      shift
      ;;
    --no-restart)
      no_restart=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then
  echo "Invalid port: $port (must be an integer in 1024..65535)" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This deployment script targets Linux hosts only." >&2
  exit 1
fi

case "$(uname -m)" in
  aarch64|arm64)
    target="linux-arm64"
    expected_sha256="$SHA256_ARM64"
    ;;
  x86_64|amd64)
    target="linux-x64"
    expected_sha256="$SHA256_X64"
    ;;
  *)
    echo "Unsupported Linux architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

node_supports_24_14() {
  local node_bin="$1/bin/node" npm_bin="$1/bin/npm"
  [[ -x "$node_bin" && -x "$npm_bin" ]] || return 1
  "$node_bin" -e '
    const [maj, min, pat] = process.versions.node.split(".").map(Number);
    process.exit(maj > 24 || (maj === 24 && (min > 14 || (min === 14 && pat >= 1))) ? 0 : 1);
  ' >/dev/null 2>&1
}

tmp_dir=""
cleanup() {
  if [[ -n "$tmp_dir" ]]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

echo "[1/5] Checking standalone Node.js runtime (${target})..."
if node_supports_24_14 "$node_dir"; then
  echo "Reusing standalone Node $("$node_dir/bin/node" -v) at $node_dir"
else
  for cmd in curl tar xz sha256sum; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
  done
  if [[ -e "$node_dir" && ! -L "$node_dir" ]]; then
    echo "Refusing to replace non-symlink directory $node_dir; remove or pass a different --node-dir." >&2
    exit 1
  fi
  node_parent="$(dirname "$node_dir")"
  extract_dir="${node_parent}/node-v${NODE_VERSION}-${target}"
  mkdir -p "$node_parent"
  if ! node_supports_24_14 "$extract_dir"; then
    tmp_dir="$(mktemp -d)"
    archive_name="node-v${NODE_VERSION}-${target}.tar.xz"
    archive_url="https://nodejs.org/dist/v${NODE_VERSION}/${archive_name}"
    echo "Downloading ${archive_url}..."
    curl -fsSL "$archive_url" -o "${tmp_dir}/${archive_name}"
    echo "${expected_sha256}  ${tmp_dir}/${archive_name}" | sha256sum -c -
    tar -xJf "${tmp_dir}/${archive_name}" -C "$node_parent"
  fi
  ln -sfn "$extract_dir" "$node_dir"
  echo "Installed standalone Node $("$node_dir/bin/node" -v) at $node_dir"
fi

export PATH="$node_dir/bin:$PATH"

echo "[2/5] Installing dependencies if needed..."
lock_file="work/chan-market/package-lock.json"
stamp_file="work/chan-market/node_modules/.deploy-lock.sha256"
lock_hash="$(sha256sum "$lock_file" | awk '{print $1}')"
current_hash="$(cat "$stamp_file" 2>/dev/null || true)"
if [[ "$force_ci" -eq 1 || ! -d "work/chan-market/node_modules" || "$current_hash" != "$lock_hash" ]]; then
  npm ci --prefix work/chan-market
  printf '%s\n' "$lock_hash" > "$stamp_file"
else
  echo "package-lock.json unchanged; skipping npm ci"
fi

echo "[3/5] Building shared assets..."
npm run build --prefix work/chan-market

if [[ "$skip_tests" -eq 0 ]]; then
  echo "[4/5] Running local-workbench tests..."
  node --test \
    work/local-workbench/network-bootstrap.test.mjs \
    work/local-workbench/history-cache.test.mjs \
    work/local-workbench/watchlist-sync.test.mjs \
    work/local-workbench/longbridge-hub-stream.test.mjs \
    work/local-workbench/server.test.mjs
else
  echo "[4/5] Skipping tests (--skip-tests)"
fi

if [[ "$no_restart" -eq 1 ]]; then
  echo "[5/5] Skipping systemd update/restart (--no-restart)"
  exit 0
fi

echo "[5/5] Configuring and restarting systemd --user service (${service_name}.service)..."
for cmd in systemctl curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
unit_dir="$HOME/.config/systemd/user"
unit_file="${unit_dir}/${service_name}.service"
mkdir -p "$unit_dir"

if [[ ! -f "$unit_file" || "$update_service" -eq 1 ]]; then
  cat > "$unit_file" <<EOF
[Unit]
Description=trend-workbench · 趋势判断工作台 Web 服务
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
Environment=PATH=${node_dir}/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
ExecStart=${node_dir}/bin/node ${root}/outputs/shared/server.mjs --port ${port} --no-auto-exit
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=default.target
EOF
  echo "Wrote ${unit_file}"
else
  echo "Keeping existing ${unit_file} (pass --update-service to rewrite)"
fi

systemctl --user daemon-reload
systemctl --user enable "${service_name}.service"
systemctl --user restart "${service_name}.service"

if command -v loginctl >/dev/null 2>&1; then
  linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
  if [[ -n "$linger" && "$linger" != "yes" ]]; then
    echo "Notice: Linger=${linger}. To keep the service running after logout, run: sudo loginctl enable-linger $USER"
  fi
fi

health_json=""
for _ in $(seq 1 20); do
  if health_json="$(curl -fsS --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null)"; then
    break
  fi
  sleep 0.5
done

if [[ -z "$health_json" ]]; then
  echo "Health check failed on http://127.0.0.1:${port}/health" >&2
  systemctl --user status "${service_name}.service" --no-pager >&2 || true
  exit 1
fi

"$node_dir/bin/node" -e '
  const fs = require("node:fs");
  const health = JSON.parse(process.argv[1]);
  const manifest = JSON.parse(fs.readFileSync("outputs/shared/build-info.json", "utf8"));
  if (health.buildId !== manifest.buildId) {
    throw new Error(`buildId mismatch: health=${health.buildId} manifest=${manifest.buildId}`);
  }
  if (health.autoExit !== false) {
    throw new Error(`Expected autoExit=false, got ${health.autoExit}`);
  }
  console.log(`Healthy: pid=${health.pid} version=${health.version} buildId=${health.buildId} autoExit=${health.autoExit}`);
' "$health_json"

echo "Access locally via SSH tunnel: ssh -L ${port}:127.0.0.1:${port} ${USER}@$(hostname)"
