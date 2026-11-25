# 更新日志（Changelog）

本文件记录 `trend-workbench` 的主要功能变更与修复说明，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] - 2026-11-26（分支 `feat/longbridge-hub-integration`）

### 新增（Added）
- **接入独立 `longbridge-hub` 行情网关服务**：
  - 在 `work/chan-market/lib/longbridge-hub.ts` 与 `work/chan-market/lib/market-data.ts` 中接入美股（含盘前、盘后与夜盘）、港股及实时 A 股的实时报价（`/v1/quote`）、静态信息（`/v1/static`）、K 线（`/v1/kline`，覆盖 `1m`–`1M` 及由 `1h`/`30m` 聚合的 `4h`）与历史分页查询（`/v1/kline/history`）；
  - 历史分页额度不足错误（如上游 `301607` `limit:0`）继续严格隔离至历史回溯链路，不影响实时 K 线与报价。
- **新增港股（`hk`）作为一等市场**：
  - 扩展 `work/chan-market/scripts/generate-equity-calendar.py`，使用 `exchange-calendars==4.13.3` 重新生成 `work/chan-market/lib/equity-calendar-data.ts`，内置港交所（`XHKG`）2000–2026 年官方交易日历（含午休、半日市与节假日）；
  - 支持港股代码归一化（如 `700`、`0700.hk`、`HK00700` → `00700.HK`，请求 Hub 时转换为 `700.HK`）、常用港股列表与在线搜索、港股 4 小时交易日历核对（`FourHourCoverage`）、SQLite 历史缓存、后台自选同步及前端港股市场导航与主题样式。
- **A 股实时行情自动门控（`cnRealtime`）**：
  - 服务端通过 `parseHubCapabilities()` 解析 Hub `/health` 返回的 `upstream.ready`、`upstream.quoteLevel` 与 `upstream.packages` 判定各市场实时权限：
    - 仅当 Hub 具备 A 股 LV1/LV2 实时行情包（例如中国内地机房的 `CN_L1_ChinaMainland_EL` 或 `SHAA/SZAA` 标注 `|LV1` / `|LV2`，而非 `CN_Basic` / `Global|Delay`）时，才将沪深 A 股（不含 `.BJ` 北交所）报价、K 线、历史分页与实时推流路由至 Hub；
    - 当 `cnRealtime` 为 `false`（如海外主机仅开通 `CN_Basic` 15 分钟延迟行情）时，完全跳过 `longbridge-hub`，继续直接使用东方财富 / 腾讯 / 新浪公开行情源；`/api/live-stream` 同步返回 HTTP `503` 拒绝 A 股 Hub 推流。
- **零新增依赖的 WebSocket → SSE 实时推流桥**：
  - 新增 `work/local-workbench/longbridge-hub-stream.mjs`，服务端使用 Node 24 原生 `WebSocket` 持有到 `longbridge-hub /v1/stream` 的单条多路复用连接，支持按标的与周期引用计数订阅、断线指数退避重连与 Ping/Keepalive 保活，并将 `LB_HUB_API_TOKEN` 严格隔离在服务端；
  - 在 `work/local-workbench/server.mjs` 新增 `GET /api/live-stream`（`text/event-stream`）向下游推送 `status`、`candle` 与 `quote` 事件；
  - 更新前端 `work/chan-market/lib/live-stream.ts`、`work/chan-market/lib/live-candle.ts`、`work/chan-market/hooks/use-live-candles.ts` 与 `work/chan-market/app/page.tsx`：当使用 Longbridge 行情源时通过 `EventSource` 实时更新在走 K 线与顶部最新报价，SSE 推流健康时自动暂停冗余的 `/api/live-quote` 轮询，断线降级时自动恢复轮询。
- **Hub 自动发现与健康检查**：
  - `server.mjs` 启动时按 `TREND_WORKBENCH_LONGBRIDGE_HUB`、`TREND_WORKBENCH_LONGBRIDGE_HUB_URL`/`TOKEN` 或本地 `~/.config/longbridge-hub/hub.env`（可通过 `TREND_WORKBENCH_LONGBRIDGE_HUB_ENV` 指定）自动探测 `longbridge-hub` 服务，并在 `GET /health` 返回 `longbridgeHub` 能力摘要（不暴露任何 Token）。
- **测试覆盖**：
  - 新增 `work/chan-market/tests/longbridge-hub.test.ts` 与 `work/local-workbench/longbridge-hub-stream.test.mjs`，并补充 `history-cache.test.mjs`、`watchlist-sync.test.mjs`、`quote-overlay.test.ts` 与 `search-all.test.ts` 用例。

### 变更与修复（Changed / Fixed）
- **区分 Longbridge 起点时间戳与公开 A 股终点时间戳**：修复 A 股与港股在 `timeframe-context.ts`、`feed-health.ts`、`breakout-vwap.ts`、`confluence.ts`、`higher-from-primary.ts`、`history-gaps.ts`、`forecast.ts`、`forecast-journal.ts`、`forecast-validation-minutes.ts` 及 `quote-overlay.ts` 中误将 Longbridge A 股误判为周期终点标注的问题，并正确处理港股/A 股收盘竞价柱（`16:00` HKT / `15:00` CST）与午休分段边界。
- **跨市场搜索与缓存一致性**：`SEARCH_MARKETS` 加入 `hk` 并避免 6 位 A 股代码触发港股目录查询、同名 A/H 股并列时保持 A 股优先；扩展 `history-cache.mjs` 与 `watchlist-sync.mjs` 以持久化 Longbridge 港股与实时 A 股系列；Hub 不可用或未就绪时平滑回退 Longbridge CLI 或公开行情源。

---

## [2026-11-25] 缓存、回测与 Longbridge 实时报价增强

### 新增与优化
- **美股全时段实时报价合并（`1fb935f`）**：接入 Longbridge 盘前/盘中/盘后/夜盘报价及 40ms 请求批合并，并在美股夜盘支持非成交时段按实际时钟更新行情状态。
- **SQLite 自选历史缓存与 worker 回测（`3d95689` / `234e9be` / `a288a9a`）**：按行持久化历史 K 线与时段标签、自选标的长周期保护与后台增量采集、`worker_threads` 滚动回测及 `301607` 历史额度错误隔离。
- **K 线实时收盘确认与界面改进（`54cb7b0` / `c85110b` / `4bd2152` / `b846c07` / `bfb4568`）**：去掉 Longbridge 美股实时源的 15 分钟人工延迟、增加美股盘前/盘后/夜盘图表背景着色、支持搜索弹窗「自选」标签与可折叠侧边栏、支持 Linux 独立 Node 24 与 `systemd --user` 常驻部署（`deploy/linux/deploy.sh`）。

---

## [2.0.0] - 2026-11-24

- **发布趋势判断工作台 V2（`a83524e` / `5832b7d`）**：支持加密货币、美股、A 股与大宗商品（黄金/白银/WTI 原油期货），引入缠论中枢识别、1h/4h/日线多周期联动验证、方向成绩单、突破均价线、实时多空之战与 Windows/macOS 双平台桌面安装包。
