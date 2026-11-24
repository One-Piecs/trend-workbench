# 构建趋势判断工作台

两个平台使用同一套前端与行情服务。以下命令从仓库根目录执行。开发环境使用 Node.js 24.14.1、npm 和 Python 3.11 或更高版本。打包脚本从固定版本的官方 Node 发行件提取运行环境和许可证，并校验 SHA-256。打成的 ZIP 已内置 Node。

先安装依赖并运行源码检查。

```sh
npm ci --prefix work/chan-market
npm test --prefix work/chan-market
npm run typecheck --prefix work/chan-market
node --test work/local-workbench/network-bootstrap.test.mjs work/local-workbench/history-cache.test.mjs work/local-workbench/windows/launcher.test.mjs
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
