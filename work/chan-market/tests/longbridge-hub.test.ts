import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fromLongbridgeTicker,
  getLongbridgeHubCapabilities,
  parseHubCapabilities,
  setLongbridgeHubFetcher,
  toLongbridgeTicker,
} from '../lib/longbridge-hub.ts';
import {
  getCandles,
  getOlderHistory,
  getWorkbenchLiveQuote,
  MarketError,
  normalizeSymbol,
  resetMarketNetworkFailures,
  stockBarClosed,
} from '../lib/market-data.ts';
import { equityFourHourWindows, equitySessionOn } from '../lib/equity-calendar.ts';
import { candleAvailableAt, candleDelaySeconds } from '../lib/timeframe-context.ts';
import { getLiveTarget, subscribeLiveCandles } from '../lib/live-stream.ts';
import { acceptLiveCandle, liveCandleKey, liveDisplayCandles } from '../lib/live-candle.ts';
import { selectQuoteOverlay } from '../lib/quote-overlay.ts';
import type { MarketData } from '../lib/market-types.ts';

function withHubEnv(url: string | undefined, token: string | undefined, run: () => Promise<void>) {
  const prevUrl = process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_URL;
  const prevToken = process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN;
  const prevDisable = process.env.TREND_WORKBENCH_LONGBRIDGE_HUB;
  const prevCli = process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE;
  if (url === undefined) delete process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_URL;
  else process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_URL = url;
  if (token === undefined) delete process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN;
  else process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN = token;
  delete process.env.TREND_WORKBENCH_LONGBRIDGE_HUB;
  process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE = '0';
  return run().finally(() => {
    if (prevUrl === undefined) delete process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_URL;
    else process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_URL = prevUrl;
    if (prevToken === undefined) delete process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN;
    else process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN = prevToken;
    if (prevDisable === undefined) delete process.env.TREND_WORKBENCH_LONGBRIDGE_HUB;
    else process.env.TREND_WORKBENCH_LONGBRIDGE_HUB = prevDisable;
    if (prevCli === undefined) delete process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE;
    else process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE = prevCli;
    setLongbridgeHubFetcher(null);
    resetMarketNetworkFailures();
  });
}

test('parseHubCapabilities distinguishes overseas CN_Basic delay from mainland CN_L1 realtime', () => {
  const overseas = parseHubCapabilities({
    status: 'ok',
    upstream: {
      ready: true,
      status: 'connected',
      memberId: 22138514,
      quoteLevel: 'SHAA:OpenAPI|SHAA|Global|Delay;SZAA:OpenAPI|SZAA|Global|Delay;USAA:OpenAPI|USAA|Global|NBBO;USON:OpenAPI|USON|Global|LV1;HKAA:OpenAPI|HKAA|Overseas|LV1;HKAB:OpenAPI|HKAB|Global|LV2',
      packages: [
        { key: 'CN_Basic', name: 'China Basic' },
        { key: 'US_QBBO_OpenAPI', name: 'US QBBO' },
        { key: 'HK_L1_NonMainland_all_platforms', name: 'HK L1' },
      ],
    },
  });
  assert.equal(overseas.ready, true);
  assert.equal(overseas.usRealtime, true);
  assert.equal(overseas.hkRealtime, true);
  assert.equal(overseas.cnRealtime, false);

  const mainland = parseHubCapabilities({
    status: 'ok',
    upstream: {
      ready: true,
      status: 'connected',
      memberId: 23332130,
      quoteLevel: 'SHAA:OpenAPI|SHAA|CN|LV1;SZAA:OpenAPI|SZAA|CN|LV1;USAA:OpenAPI|USAA|Global|NBBO;HKAB:OpenAPI|HKAB|Global|LV2',
      packages: [
        { key: 'CN_L1_ChinaMainland_EL', name: 'CN L1' },
        { key: 'HK_L2_Mainland_all_platforms', name: 'HK L2' },
        { key: 'US_QBBO_OpenAPI', name: 'US QBBO' },
      ],
    },
  });
  assert.equal(mainland.ready, true);
  assert.equal(mainland.usRealtime, true);
  assert.equal(mainland.hkRealtime, true);
  assert.equal(mainland.cnRealtime, true);

  const authRequired = parseHubCapabilities({
    status: 'auth_required',
    upstream: {
      ready: false,
      status: 'auth_required',
      packages: [{ key: 'CN_L1_ChinaMainland_EL', name: 'CN L1' }],
    },
  });
  assert.equal(authRequired.ready, false);
  assert.equal(authRequired.cnRealtime, false);
  assert.equal(authRequired.usRealtime, false);
  assert.equal(authRequired.hkRealtime, false);
});

test('HK symbol normalization, ticker mapping, and official HKEX session calendar work accurately', () => {
  assert.equal(normalizeSymbol('hk', '700'), '00700.HK');
  assert.equal(normalizeSymbol('hk', '0700.hk'), '00700.HK');
  assert.equal(normalizeSymbol('hk', 'HK09988'), '09988.HK');
  assert.equal(normalizeSymbol('hk', 'HSI'), 'HSI.HK');

  assert.equal(toLongbridgeTicker('hk', '00700.HK'), '700.HK');
  assert.equal(toLongbridgeTicker('us', 'BRK-B'), 'BRK.B.US');
  assert.equal(toLongbridgeTicker('cn', '600519.SH'), '600519.SH');
  assert.equal(toLongbridgeTicker('cn', '920599.BJ'), null);
  assert.equal(fromLongbridgeTicker('hk', '700.HK'), '00700.HK');
  assert.equal(fromLongbridgeTicker('us', 'BRK.B.US'), 'BRK-B');

  const regularDay = equitySessionOn('hk', '2026-11-25');
  assert.equal(regularDay.status, 'open');
  assert.deepEqual(regularDay.segments, [{ start: 570, end: 720 }, { start: 780, end: 960 }]);
  assert.deepEqual(equityFourHourWindows('hk', '2026-11-25'), [{ start: 570, end: 870 }, { start: 870, end: 960 }]);
  assert.equal(equitySessionOn('hk', '2026-12-25').status, 'closed');
});

test('Longbridge Hub CN start-labelled bars close immediately without 120s public lag or closing-auction trap', () => {
  const cnLbSource = 'Longbridge OpenAPI A股实时行情 · open.longbridge.com';
  const hkLbSource = 'Longbridge OpenAPI 港股行情 · open.longbridge.com';
  assert.equal(candleDelaySeconds('cn', '1m', cnLbSource), 0);
  assert.equal(candleDelaySeconds('hk', '5m', hkLbSource), 0);
  assert.equal(candleDelaySeconds('cn', '1m', '东方财富 网页行情 · push2his.eastmoney.com'), 120);

  // 10:00 CST start-labelled 1h bar -> ends at 11:00 CST (not 10:02 CST like end-labelled feeds)
  const bar1000 = Date.parse('2026-11-25T02:00:00Z') / 1000;
  assert.equal(candleAvailableAt({ time: bar1000 }, 'cn', '1h', cnLbSource), Date.parse('2026-11-25T03:00:00Z') / 1000);
  assert.equal(stockBarClosed(bar1000, '1h', 'cn', Date.parse('2026-11-25T02:30:00Z') / 1000, undefined, cnLbSource), false);
  assert.equal(stockBarClosed(bar1000, '1h', 'cn', Date.parse('2026-11-25T03:00:00Z') / 1000, undefined, cnLbSource), true);

  // 11:30 HKT 1h bar clips at 12:00 HKT lunch break; 16:00 HKT closing auction bar closes cleanly at 16:01 HKT
  const hk1130 = Date.parse('2026-11-25T03:30:00Z') / 1000;
  assert.equal(candleAvailableAt({ time: hk1130 }, 'hk', '1h', hkLbSource), Date.parse('2026-11-25T04:00:00Z') / 1000);
  const hk1600 = Date.parse('2026-11-25T08:00:00Z') / 1000;
  assert.equal(candleAvailableAt({ time: hk1600 }, 'hk', '1h', hkLbSource), Date.parse('2026-11-25T08:01:00Z') / 1000);
});

test('getCandles and getWorkbenchLiveQuote route US/HK to Hub, skip Hub for CN when cnRealtime=false, and enable Hub for CN when cnRealtime=true', async () => {
  await withHubEnv('http://127.0.0.1:44130', 'secret-token', async () => {
    const hubRequests: Array<{ url: string; auth: string | null; priority: string | null }> = [];
    let cnPackage = 'CN_Basic';
    let cnQuoteLevel = 'SHAA:OpenAPI|SHAA|Global|Delay;SZAA:OpenAPI|SZAA|Global|Delay';

    setLongbridgeHubFetcher(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      hubRequests.push({
        url: url.pathname + url.search,
        auth: headers.get('Authorization'),
        priority: headers.get('X-Priority'),
      });
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({
          status: 'ok',
          upstream: {
            ready: true,
            status: 'connected',
            memberId: 22138514,
            quoteLevel: `${cnQuoteLevel};USAA:OpenAPI|USAA|Global|NBBO;HKAA:OpenAPI|HKAA|Overseas|LV1`,
            packages: [
              { key: cnPackage, name: cnPackage },
              { key: 'US_QBBO_OpenAPI', name: 'US QBBO' },
              { key: 'HK_L1_NonMainland_all_platforms', name: 'HK L1' },
            ],
          },
        }), { status: 200 });
      }
      if (url.pathname === '/v1/static') {
        const sym = url.searchParams.get('symbols') || '';
        return new Response(JSON.stringify({
          items: [{
            symbol: sym,
            market: sym.endsWith('.HK') ? 'HK' : sym.endsWith('.US') ? 'US' : 'CN',
            nameCn: sym === '700.HK' ? '腾讯控股' : sym === '600519.SH' ? '贵州茅台' : '特斯拉',
            nameEn: sym === 'SOXS.US' ? 'SOXS' : sym,
            nameHk: '騰訊控股',
            exchange: sym.endsWith('.HK') ? 'HKEX' : sym.endsWith('.SH') ? 'SH' : 'NASD',
            currency: sym.endsWith('.HK') ? 'HKD' : sym.endsWith('.SH') ? 'CNY' : 'USD',
            lotSize: 100,
            board: 'Main',
          }],
        }), { status: 200 });
      }
      if (url.pathname === '/v1/kline') {
        const sym = url.searchParams.get('symbol') || '';
        const period = url.searchParams.get('period') || '1m';
        const baseSec = sym.endsWith('.US')
          ? Date.parse('2026-11-23T05:00:00Z') / 1000
          : Date.parse('2026-11-25T01:30:00Z') / 1000;
        const step = period === '30m' ? 1800 : period === '1h' ? 3600 : period === '5m' ? 300 : 60;
        const bars = Array.from({ length: 16 }, (_, i) => ({
          time: baseSec + i * step,
          timestamp: new Date((baseSec + i * step) * 1000).toISOString(),
          open: 100 + i,
          high: 102 + i,
          low: 99 + i,
          close: 101 + i,
          volume: 1000 + i * 10,
          turnover: 100000,
          session: sym.endsWith('.US') && i < 4 ? 'Overnight' : 'Intraday',
        }));
        return new Response(JSON.stringify({ candles: bars }), { status: 200 });
      }
      if (url.pathname === '/v1/kline/history') {
        return new Response(JSON.stringify({
          error: { code: 'UPSTREAM_ERROR', message: 'history candlestick symbol count out of limit, requested:0/limit:0', upstreamCode: 301607 },
        }), { status: 503 });
      }
      if (url.pathname === '/v1/quote') {
        const sym = url.searchParams.get('symbols') || '';
        return new Response(JSON.stringify({
          quotes: [{
            symbol: sym,
            market: sym.endsWith('.HK') ? 'HK' : sym.endsWith('.SH') ? 'CN' : 'US',
            lastDone: 412.6,
            prevClose: 410,
            open: 411,
            high: 415,
            low: 409,
            timestamp: '2026-11-25T02:00:00.000Z',
            time: Date.parse('2026-11-25T02:00:00Z') / 1000,
            volume: 12000,
            turnover: 4951200,
            tradeStatus: 'Normal',
            preMarketQuote: null,
            postMarketQuote: null,
            overnightQuote: null,
          }],
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const originalFetch = globalThis.fetch;
    const publicFetchCalls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = String(input);
      publicFetchCalls.push(u);
      if (u.includes('push2his.eastmoney.com')) {
        return new Response(JSON.stringify({
          data: {
            code: '600519',
            market: 1,
            name: '贵州茅台',
            klines: [
              '2026-11-24,1490,1498,1505,1485,12000,0,0,0,0,0',
              '2026-11-25,1500,1510,1515,1495,13000,0,0,0,0,0',
            ],
          },
        }), { status: 200 });
      }
      return new Response('unavailable', { status: 503 });
    }) as typeof fetch;

    try {
      // 1. US uses Hub with Bearer token + preserves overnight sessions
      const us = await getCandles('us', 'SOXS', '1m', 100);
      assert.equal(us.source, 'Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com');
      assert.equal(us.candles[0].session, 'overnight');
      assert.ok(hubRequests.some(r => r.url.startsWith('/v1/kline?symbol=SOXS.US') && r.auth === 'Bearer secret-token'));

      // 2. HK normalizes 700 -> 00700.HK, requests 700.HK from Hub, supports 4h aggregation & live quote
      const hk = await getCandles('hk', '700', '5m', 100);
      assert.equal(hk.instrument.symbol, '00700.HK');
      assert.equal(hk.instrument.currency, 'HKD');
      assert.equal(hk.source, 'Longbridge OpenAPI 港股行情 · open.longbridge.com');
      assert.ok(hubRequests.some(r => r.url.startsWith('/v1/kline?symbol=700.HK')));

      const hk4h = await getCandles('hk', '00700.HK', '4h', 100);
      assert.equal(hk4h.source, 'Longbridge OpenAPI 港股行情 · open.longbridge.com · 30分钟聚合4小时');
      assert.ok(hk4h.candles.length >= 1);

      const hkQuote = await getWorkbenchLiveQuote(
        new URLSearchParams({ market: 'hk', symbol: '00700.HK', interval: '5m', source: hk.source, adjustment: hk.adjustment }),
        Date.parse('2026-11-25T02:01:00Z'),
      ) as { status: string; quote?: { price: number; provider?: string } };
      assert.equal(hkQuote.status, 'quote');
      assert.equal(hkQuote.quote?.price, 412.6);
      assert.equal(hkQuote.quote?.provider, 'longbridge');

      // 3. CN with CN_Basic/Delay NEVER hits Hub kline/quote; falls directly to Eastmoney/Tencent/Sina
      const hubCountBeforeCn = hubRequests.length;
      const cnDelayed = await getCandles('cn', '600519.SH', '1d', 100);
      assert.equal(cnDelayed.source, '东方财富 网页行情 · push2his.eastmoney.com');
      assert.equal(hubRequests.length, hubCountBeforeCn, 'CN_Basic hub must receive zero requests for CN klines');
      assert.ok(publicFetchCalls.some(u => u.includes('push2his.eastmoney.com')));

      // 4. Hub history 301607 (limit:0) isolates cleanly without affecting live kline
      const beforeHistory = Date.parse('2026-11-24T06:00:00Z') / 1000;
      const page = await getOlderHistory(new URLSearchParams({
        market: 'us', symbol: 'SOXS', interval: '1m', source: us.source, adjustment: us.adjustment, before: String(beforeHistory), limit: '100',
      }));
      assert.equal(page.status, 'unsupported');
      const usStillLive = await getCandles('us', 'SOXS', '1m', 101);
      assert.equal(usStillLive.source, 'Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com');

      // 5. Switch Hub to mainland CN_L1 realtime -> CN routes to Hub (except .BJ)
      cnPackage = 'CN_L1_ChinaMainland_EL';
      cnQuoteLevel = 'SHAA:OpenAPI|SHAA|CN|LV1;SZAA:OpenAPI|SZAA|CN|LV1';
      await getLongbridgeHubCapabilities({ force: true });
      const cnRealtime = await getCandles('cn', '600519.SH', '1m', 100);
      assert.equal(cnRealtime.source, 'Longbridge OpenAPI A股实时行情 · open.longbridge.com');
      assert.ok(hubRequests.some(r => r.url.startsWith('/v1/kline?symbol=600519.SH')));

      const cnQuote = await getWorkbenchLiveQuote(
        new URLSearchParams({ market: 'cn', symbol: '600519.SH', interval: '1m', source: cnRealtime.source, adjustment: cnRealtime.adjustment }),
        Date.parse('2026-11-25T02:01:00Z'),
      ) as { status: string; quote?: { price: number; provider?: string; currency: string } };
      assert.equal(cnQuote.status, 'quote');
      assert.equal(cnQuote.quote?.provider, 'longbridge');
      assert.equal(cnQuote.quote?.currency, 'CNY');

      // 6. On hub failure, CN falls back cleanly to Eastmoney
      const prevFetcher = async (input: string | URL | Request) => {
        const u = new URL(String(input));
        if (u.pathname === '/health') {
          return new Response(JSON.stringify({ status: 'ok', upstream: { ready: true, status: 'connected', quoteLevel: cnQuoteLevel, packages: [{ key: cnPackage, name: cnPackage }] } }), { status: 200 });
        }
        return new Response('down', { status: 503 });
      };
      setLongbridgeHubFetcher(prevFetcher as typeof fetch);
      resetMarketNetworkFailures();
      const cnFallback = await getCandles('cn', '600519.SH', '1d', 102);
      assert.equal(cnFallback.source, '东方财富 网页行情 · push2his.eastmoney.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('Longbridge Hub frontend SSE streaming, live-candle gating, and regular-session HK/CN quote overlay work end to end', () => {
  const hkFeed: MarketData = {
    instrument: { id: 'hk:00700.HK', symbol: '00700.HK', market: 'hk', name: '腾讯控股', exchange: '港交所', currency: 'HKD' },
    interval: '1m',
    candles: [
      { time: Date.parse('2026-11-25T02:00:00Z') / 1000, open: 410, high: 412, low: 409, close: 411, volume: 1000, closed: true },
    ],
    source: 'Longbridge OpenAPI 港股行情 · open.longbridge.com',
    asOf: '2026-11-25T02:01:00.000Z',
    adjustment: '不复权（原始价格）；成交量单位：股',
    delayNotice: '',
    availableIntervals: ['1m'],
    warnings: [],
  };

  const target = getLiveTarget(hkFeed);
  assert.ok(target && target.provider === 'longbridge');
  assert.equal(getLiveTarget({ ...hkFeed, interval: '4h', source: `${hkFeed.source} · 30分钟聚合4小时` }), null);

  // Mock EventSource lifecycle
  const listeners = new Map<string, Array<(e: Event) => void>>();
  let closed = false;
  let capturedUrl = '';
  const statuses: string[] = [];
  const candles: number[] = [];
  const quotes: unknown[] = [];

  const stop = subscribeLiveCandles(
    target,
    {
      onStatus: s => statuses.push(s),
      onCandle: c => candles.push(c.close),
      onQuote: q => quotes.push(q),
    },
    () => { throw new Error('unexpected WebSocket call'); },
    url => {
      capturedUrl = url;
      return {
        addEventListener(type: string, fn: (e: Event) => void) {
          const list = listeners.get(type) ?? [];
          list.push(fn);
          listeners.set(type, list);
        },
        close() { closed = true; },
      } as unknown as EventSource;
    },
  );

  assert.match(capturedUrl, /^\/api\/live-stream\?market=hk&symbol=00700\.HK&interval=1m/);
  for (const fn of listeners.get('status') ?? []) fn({ data: JSON.stringify({ status: 'live', time: Date.now() }) } as MessageEvent);
  for (const fn of listeners.get('candle') ?? []) {
    fn({ data: JSON.stringify({ candle: { time: Date.parse('2026-11-25T02:01:00Z') / 1000, open: 411, high: 413, low: 410.5, close: 412.8, volume: 300, closed: false }, eventTimeMs: Date.now() }) } as MessageEvent);
  }
  for (const fn of listeners.get('quote') ?? []) {
    fn({ data: JSON.stringify({ quote: { price: 412.8 }, eventTimeMs: Date.now() }) } as MessageEvent);
  }
  assert.deepEqual(statuses, ['connecting', 'live']);
  assert.deepEqual(candles, [412.8]);
  assert.equal(quotes.length, 1);
  stop();
  assert.equal(closed, true);

  // live-candle accepts next HK forming candle jumping across lunch break (12:00 -> 13:00 HKT)
  const hkMorningEnd: MarketData = {
    ...hkFeed,
    candles: [{ time: Date.parse('2026-11-25T03:59:00Z') / 1000, open: 410, high: 411, low: 409, close: 410.5, volume: 500, closed: true }],
  };
  const key = liveCandleKey(hkMorningEnd);
  const afternoonTime = Date.parse('2026-11-25T05:00:00Z') / 1000;
  const update = {
    key,
    candle: { time: afternoonTime, open: 411, high: 412, low: 410.5, close: 411.5, volume: 800, closed: false },
    eventTimeMs: afternoonTime * 1000 + 5000,
  };
  assert.equal(acceptLiveCandle(hkMorningEnd, null, update, afternoonTime * 1000 + 6000), true);
  assert.equal(liveDisplayCandles(hkMorningEnd, update).length, 2);

  // selectQuoteOverlay accepts regular-session Longbridge HK & CN realtime quotes
  const nowSec = Date.parse('2026-11-25T02:01:00Z') / 1000;
  const overlay = selectQuoteOverlay(hkFeed, {
    market: 'hk',
    symbol: '00700.HK',
    currency: 'HKD',
    time: nowSec - 1,
    observedAt: nowSec,
    price: 412.8,
    venue: 'Longbridge OpenAPI',
    provider: 'longbridge',
    quality: 'realtime',
    session: 'regular',
  }, nowSec * 1000);
  assert.equal(overlay?.price, 412.8);
  assert.equal(overlay?.provider, 'longbridge');
});
