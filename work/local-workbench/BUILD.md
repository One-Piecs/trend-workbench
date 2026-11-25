# 构建趋势判断工作台

两个平台使用同一套前端与行情服务。以下命令从仓库根目录执行。开发环境使用 Node.js 24.14.1、npm 和 Python 3.11 或更高版本。打包脚本从固定版本的官方 Node 发行件提取运行环境和许可证，并校验 SHA-256。打成的 ZIP 已内置 Node。

先安装依赖并运行源码检查。

```sh
npm ci --prefix work/chan-market
npm test --prefix work/chan-market
npm run typecheck --prefix work/chan-market
node --test work/local-workbench/network-bootstrap.test.mjs work/local-workbench/history-cache.test.mjs work/local-workbench/watchlist-sync.test.mjs work/local-workbench/longbridge-hub-stream.test.mjs work/local-workbench/server.test.mjs work/local-workbench/windows/launcher.test.mjs
```

## Windows x64

在 Windows PowerShell 中运行以下命令。构建产物支持 Windows 10/11 x64，使用系统 Microsoft Edge、Windows Script Host 和 Windows PowerShell。

```powershell
python work/local-workbench/fetch_runtime.py win-x64 .build/node-win
python work/local-workbench/windows/package_windows.py --node-dir .build/node-win --output dist/Trend-Workbench-Windows-x64.zip
python work/local-workbench/windows/verify_archive.py dist/Trend-Workbench-Windows-x64.zip
```

## macOS（Apple 芯片）

在 macOS 15 或更高版本的 Apple 芯片 Mac 上，使用 Xcode Command Line Tools 编译 AppKit 和 WebKit 窗口。以下命令使用 macOS 自带的 codesign 执行本地临时签名。该签名用于检验应用完整性，公开测试包未经 Apple 公证。

```sh
python3 work/local-workbench/fetch_runtime.py darwin-arm64 .build/node-mac
bash work/local-workbench/macos/build-native.sh .build/TrendWorkbench
python3 work/local-workbench/macos/package_app.py --launcher .build/TrendWorkbench --node-dir .build/node-mac --output dist/Trend-Workbench-macOS-arm64.zip
python3 work/local-workbench/macos/verify_archive.py dist/Trend-Workbench-macOS-arm64.zip
```

两端的验收脚本都会解压生成的 ZIP，检查资源、本地服务启动与关窗后的退出。添加 `--check-feed` 可按工作台默认深度请求 XRP/USDT 和 BTC/USDT 小时线，检查返回的交易对、报价币、价格和最近一根 K 线时间。

## Linux 服务器部署（独立 Node + systemd user）

Ubuntu/Debian 等 Linux 服务器使用仓库根目录的 `deploy/linux/deploy.sh` 部署（支持 `linux-arm64` 和 `linux-x64`）：

```sh
./deploy/linux/deploy.sh
```

脚本会自动校验并安装官方独立 Node.js `24.14.1` 至 `~/.local/opt/node24`（不修改系统 `/usr/bin/node`），在依赖或 `package-lock.json` 变化时执行 `npm ci`，构建 `outputs/shared/` 并运行 `work/local-workbench` 测试，随后生成或保留 `~/.config/systemd/user/trend-workbench.service`（传入 `--no-auto-exit` 保持常驻）、重启服务并校验 `http://127.0.0.1:44123/health` 的 `buildId` 与 `autoExit: false`。后续代码更新只需 `git pull --ff-only && ./deploy/linux/deploy.sh`。

- **保持登出后继续运行**：首次在宿主机启用 linger：`sudo loginctl enable-linger "$USER"`。
- **访问方式**：服务默认仅监听 `127.0.0.1:44123` 且校验本机 `Host`/`Origin`。推荐在本机用 SSH 端口转发访问：`ssh -L 44123:127.0.0.1:44123 <user>@<host>` 后打开 `http://127.0.0.1:44123`。若经由私网/Tailscale 内 Nginx 反代，需改写 `Host` 与 `Origin`（如 `proxy_set_header Host 127.0.0.1:44123;`、`proxy_set_header Origin "";`）并为 `/session` 与 `/api/live-stream` 关闭缓冲（`proxy_buffering off;`、`proxy_http_version 1.1;`、`proxy_read_timeout 3600s;`），切勿无鉴权暴露到公网。
- **覆写环境变量**：服务单元示例见 `deploy/linux/trend-workbench.service.example`。可用 `systemctl --user edit trend-workbench.service` 添加覆写项（例如设置 `Environment=TREND_WORKBENCH_LONGBRIDGE_KLINE=0` 关闭服务端 Longbridge 夜盘调用）；`deploy.sh` 默认保留已有 unit 文件，如需按参数重写可执行 `./deploy/linux/deploy.sh --update-service`。

## 自选历史缓存与后台增量采集

服务端使用内置 SQLite（默认路径 `~/.cache/TrendWorkbench/history-v2.sqlite`）按行持久化已收盘 K 线，并保留盘前/盘后/夜盘时段标记：

- **自选保护**：通过 `/api/watchlist`（`GET` / `PUT`）与前端同步自选标的。自选标的不受非自选 LRU（48 条序列 / 12,000 根）淘汰限制，单周期可保留更长历史（如 `1m` 最高 25 万根、`5m/15m` 15 万根、`1h` 10 万根、`1d` 5 万根），可通过 `GET /api/cache/status` 查看各序列覆盖范围与同步状态，通过 `GET /api/cache/candles` 读取或导出连续缓存 K 线（支持 `json` 与 `csv`）。
- **本机缓存滚动回测**：在「预判验证」面板中可直接触发 `POST /api/validation/run`（在独立 `worker_threads` 工作线程中执行 `runCachedBacktest`，不阻塞行情接口），也可通过离线命令对缓存数据库直接导出或批量回测：
  ```sh
  npm --prefix work/chan-market run backtest:cache -- --list
  npm --prefix work/chan-market run backtest:cache -- --watchlist --intervals 5m,15m,1h,1d
  npm --prefix work/chan-market run backtest:cache -- --market us --symbol NVDA --interval 1d --max-bars 2000
  npm --prefix work/chan-market run backtest:cache -- --export ./nvda-1d.json --market us --symbol NVDA --interval 1d
  ```
- **后台采集**：常驻模式（`--no-auto-exit` 或 `TREND_WORKBENCH_NO_AUTO_EXIT=1`）默认开启后台低并发增量采集与冷启动回溯，并在前台交互请求到来时自动让路。
- **常用环境变量**：
  - `TREND_WORKBENCH_WATCHLIST_SYNC`：`1` 强制启用，`0` 关闭（桌面默认关闭，常驻服务默认开启）。
  - `TREND_WORKBENCH_SYNC_INTERVALS`：逗号分隔采集周期，默认 `1m,5m,15m,1h,1d`。
  - `TREND_WORKBENCH_CACHE_MAX_MB`：SQLite 最大磁盘占用上限（MB），默认 `2048`。
  - `TREND_WORKBENCH_CACHE_PATH`：自定义 SQLite 缓存文件路径。

## Longbridge Hub 与多市场实时行情（可选）

工作台支持优先接入独立的 `longbridge-hub` 行情网关，并在 `/api/live-stream` 提供 WebSocket → SSE 实时推送：

- **自动发现与环境变量**：服务启动时按以下顺序探测并自动启用：
  1. 显式环境变量 `TREND_WORKBENCH_LONGBRIDGE_HUB_URL`（搭配 `TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN` 或 `LB_HUB_API_TOKEN`），设置 `TREND_WORKBENCH_LONGBRIDGE_HUB=0` 可显式禁用；
  2. 桌面端与本机配置文件（适合双击打开 macOS `.app` / Windows `.vbs` 时接入远端或本机 Hub，亦可用 `TREND_WORKBENCH_LONGBRIDGE_HUB_ENV` 指定单个路径）：
     - 通用：`~/.config/trend-workbench/hub.env`
     - macOS：`~/Library/Application Support/TrendWorkbench/hub.env`
     - Windows：`%APPDATA%\TrendWorkbench\hub.env`（及 `%LOCALAPPDATA%\TrendWorkbench\hub.env`）
     - 本机同跑 Hub 回退：`~/.config/longbridge-hub/hub.env`（按 `LB_HUB_PORT` 探测 `127.0.0.1`）
  配置文件支持 `TREND_WORKBENCH_LONGBRIDGE_HUB_URL`（或 `LB_HUB_URL`）、`TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN`（或 `LB_HUB_API_TOKEN`）以及 `TREND_WORKBENCH_LONGBRIDGE_HUB=0`。例如桌面端直连 Tailscale 私网 Hub：
  ```ini
  TREND_WORKBENCH_LONGBRIDGE_HUB_URL=http://100.123.123.2:44130
  TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN=<你的_LB_HUB_API_TOKEN>
  ```
- **分市场能力门控**：
  - 美股（含盘前、盘后、夜盘）与港股在 Hub `usRealtime` / `hkRealtime` 就绪时优先走 Hub，并自动回退到 Longbridge CLI 或公开网页来源；
  - A 股仅在 Hub `/health` 确认拥有 A 股 LV1/LV2 实时权限（`cnRealtime: true`）时切换至 Hub；若 Hub 仅为 `CN_Basic` / `Delay` 延迟行情（`cnRealtime: false`），则自动跳过 Hub 并继续沿用东方财富 / 腾讯 / 新浪公开源。
- **Longbridge CLI 后备方案**：若未部署 `longbridge-hub` 但本机安装并登录了 [Longbridge CLI](https://open.longbridge.com/docs/cli/install)（`longbridge auth login`），本地服务仍会自动启用 Longbridge CLI 美股夜盘支持；可用 `TREND_WORKBENCH_LONGBRIDGE_KLINE=1` / `0` 显式开关。Longbridge 历史 K 线按标的配额计费，详见其官方文档。
