# 构建趋势判断工作台

两个平台使用同一套前端与行情服务。以下命令从仓库根目录执行。开发环境使用 Node.js 24.14.1、npm 和 Python 3.11 或更高版本。打包脚本从固定版本的官方 Node 发行件提取运行环境和许可证，并校验 SHA-256。打成的 ZIP 已内置 Node。

先安装依赖并运行源码检查。

```sh
npm ci --prefix work/chan-market
npm test --prefix work/chan-market
npm run typecheck --prefix work/chan-market
node --test work/local-workbench/network-bootstrap.test.mjs work/local-workbench/history-cache.test.mjs work/local-workbench/server.test.mjs work/local-workbench/windows/launcher.test.mjs
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
- **访问方式**：服务默认仅监听 `127.0.0.1:44123` 且校验本机 `Host`/`Origin`。推荐在本机用 SSH 端口转发访问：`ssh -L 44123:127.0.0.1:44123 <user>@<host>` 后打开 `http://127.0.0.1:44123`。若经由私网/Tailscale 内 Nginx 反代，需改写 `Host` 与 `Origin`（如 `proxy_set_header Host 127.0.0.1:44123;`、`proxy_set_header Origin "";`）并为 `/session` 关闭缓冲（`proxy_buffering off;`、`proxy_http_version 1.1;`、`proxy_read_timeout 3600s;`），切勿无鉴权暴露到公网。
- **覆写环境变量**：服务单元示例见 `deploy/linux/trend-workbench.service.example`。可用 `systemctl --user edit trend-workbench.service` 添加覆写项（例如设置 `Environment=TREND_WORKBENCH_LONGBRIDGE_KLINE=0` 关闭服务端 Longbridge 夜盘调用）；`deploy.sh` 默认保留已有 unit 文件，如需按参数重写可执行 `./deploy/linux/deploy.sh --update-service`。

## 美股夜盘行情（可选）

美股分钟级周期默认使用公开正常时段来源。若本机安装并登录了 [Longbridge CLI](https://open.longbridge.com/docs/cli/install)（`longbridge auth login`），本地服务会自动启用 Longbridge 行情源，在 1/5/15/30 分钟和 1 小时 K 线中包含美股盘前、盘后与夜盘时段。未安装或未登录时，工作台自动回退到公开来源，功能不受影响。也可用环境变量显式控制：`TREND_WORKBENCH_LONGBRIDGE_KLINE=1` 启用，`=0` 禁用。Longbridge 历史K线按标的配额计费，详见其官方文档。
