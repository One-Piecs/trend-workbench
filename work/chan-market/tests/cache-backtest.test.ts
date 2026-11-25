import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candle, Instrument, MarketData } from '../lib/market-types';
import { computeMinuteReviewRanges, runCachedBacktest } from '../lib/cache-backtest.ts';
import { runCacheBacktestCli } from '../scripts/backtest-cache.ts';

function makeHourlySeries(count: number, { step = 3600, base = Date.UTC(2025, 0, 1) / 1000 } = {}): Candle[] {
  const price = (i: number) => 1000 + 90 * Math.sin(i / 24) + 45 * Math.sin(i / 8) + 18 * Math.sin(i / 3);
  return Array.from({ length: count }, (_, i) => {
    const open = price(i - 1);
    const close = price(i);
    return {
      time: base + i * step,
      open,
      close,
      high: Math.max(open, close) + 4,
      low: Math.min(open, close) - 4,
      volume: 200 + (i % 29),
      closed: true,
    };
  });
}

test('computeMinuteReviewRanges computes start and end bounds without delay for crypto and Longbridge US 1h open split', () => {
  const cryptoPrimary: MarketData = {
    instrument: { id: 'crypto:BTCUSDT', market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin', exchange: 'Binance', currency: 'USDT' },
    interval: '1h',
    source: 'Binance 公共现货行情 · BTCUSDT',
    adjustment: '原始成交价格，不复权',
    asOf: '2026-11-24T00:00:00Z',
    delayNotice: '',
    warnings: [],
    availableIntervals: ['1h'],
    candles: [],
  };
  const t = Date.parse('2026-11-23T12:00:00Z') / 1000;
  assert.deepEqual(computeMinuteReviewRanges(cryptoPrimary, [t, t]), [{ start: t, end: t + 3600 }]);

  // Longbridge US 1h 09:00 EST bar ends at regular open 09:30 EST (14:30 UTC), so 30 minutes wide
  const lbPrimary: MarketData = {
    instrument: { id: 'us:AAPL', market: 'us', symbol: 'AAPL', name: 'Apple', exchange: 'NASDAQ', currency: 'USD' },
    interval: '1h',
    source: 'Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com',
    adjustment: '不复权（原始价格）；成交量单位：股',
    asOf: '2026-11-24T00:00:00Z',
    delayNotice: '',
    warnings: [],
    availableIntervals: ['1h'],
    candles: [],
  };
  const preOpenSplit = Date.parse('2026-11-23T14:00:00Z') / 1000;
  assert.deepEqual(computeMinuteReviewRanges(lbPrimary, [preOpenSplit]), [
    { start: preOpenSplit, end: Date.parse('2026-11-23T14:30:00Z') / 1000 },
  ]);
});

test('runCachedBacktest computes fold breakdown, winRate, recentTrades and invokes loadMinutes on ambiguous bars', async () => {
  const base = Date.UTC(2025, 0, 1) / 1000;
  const candles = makeHourlySeries(240, { step: 3600, base });
  // Widen a tail bar so at least one active setup touches both sides and requests minute evidence if active
  const primary: MarketData = {
    instrument: { id: 'crypto:BTCUSDT', market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin', exchange: 'Binance', currency: 'USDT' },
    interval: '1h',
    source: 'Binance 公共现货行情 · BTCUSDT',
    adjustment: '原始成交价格，不复权',
    asOf: new Date((candles.at(-1)!.time + 3600) * 1000).toISOString(),
    delayNotice: '',
    warnings: [],
    availableIntervals: ['1h', '4h'],
    candles,
  };
  const higherCandles = makeHourlySeries(60, { step: 14400, base });
  const higher: MarketData = {
    ...primary,
    interval: '4h',
    candles: higherCandles,
  };

  const minuteRangeCalls: { start: number; end: number }[][] = [];
  const result = await runCachedBacktest({
    primary,
    higher,
    options: { folds: 3, warmupFraction: 0.4, costs: { feeBps: 5, slippageBps: 3 } },
    loadMinutes: (ranges) => {
      minuteRangeCalls.push(ranges);
      return {
        ...primary,
        interval: '1m',
        candles: [],
      };
    },
  });

  assert.equal(result.evidenceSufficient, false);
  assert.equal(result.data.symbol, 'BTCUSDT');
  assert.equal(result.data.higherInterval, '4h');
  assert.equal(result.data.higherBars, 60);
  assert.equal(result.folds.length, 3);
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(result.baseline.published >= result.baseline.completed);
  assert.ok(Array.isArray(result.recentTrades));
  assert.ok(Array.isArray(result.limitations) && result.limitations.length > 0);
  if (result.data.minuteConflictBars > 0) {
    assert.equal(minuteRangeCalls.length, 1);
  }
});

test('runCacheBacktestCli supports --list, --export json/csv, single series, and --watchlist batch runs against SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trend-cli-bt-'));
  const dbPath = join(dir, 'history-v2.sqlite');
  const exportJsonPath = join(dir, 'btc-1h.json');
  const exportCsvPath = join(dir, 'btc-1h.csv');
  const singleOutPath = join(dir, 'single-report.json');
  const batchOutPath = join(dir, 'watchlist-summary.json');

  const base = Date.UTC(2025, 0, 1) / 1000;
  const hourly = makeHourlySeries(220, { step: 3600, base });
  const fourHour = makeHourlySeries(55, { step: 14400, base });
  const source = 'Binance 公共现货行情 · BTCUSDT';
  const adjustment = '原始成交价格，不复权';
  const instrument: Instrument = {
    id: 'crypto:BTCUSDT',
    market: 'crypto',
    symbol: 'BTCUSDT',
    name: 'Bitcoin',
    exchange: 'Binance',
    currency: 'USDT',
  };

  const cacheMod = (await import(new URL('../../local-workbench/history-cache.mjs', import.meta.url).href)) as {
    createHistoryCache: (opts: {
      filename: string;
      getCandles: (m: string, s: string, interval: string) => Promise<MarketData>;
      getOlderHistory: () => Promise<{ status: string; candles: Candle[] }>;
    }) => {
      setWatchlist: (items: Instrument[]) => void;
      candles: (m: string, s: string, interval: string, limit: number) => Promise<MarketData>;
      close: () => void;
    };
  };

  const archive = cacheMod.createHistoryCache({
    filename: dbPath,
    getCandles: async (_m, _s, interval) => ({
      instrument,
      interval: interval as MarketData['interval'],
      source,
      adjustment,
      asOf: new Date((hourly.at(-1)!.time + 3600) * 1000).toISOString(),
      delayNotice: '',
      warnings: [],
      availableIntervals: ['1h', '4h'],
      candles: interval === '4h' ? fourHour : hourly,
    }),
    getOlderHistory: async () => ({ status: 'end', candles: [] }),
  });

  try {
    archive.setWatchlist([instrument]);
    await archive.candles('crypto', 'BTCUSDT', '1h', 220);
    await archive.candles('crypto', 'BTCUSDT', '4h', 55);
  } finally {
    archive.close();
  }

  try {
    const listed = (await runCacheBacktestCli(['--list', '--db', dbPath])) as { series: { symbol: string; bars: number }[] };
    assert.equal(listed.series.length, 2);
    assert.ok(listed.series.some((s) => s.symbol === 'BTCUSDT' && s.bars === 220));

    await runCacheBacktestCli([
      '--export', exportJsonPath,
      '--market', 'crypto',
      '--symbol', 'BTCUSDT',
      '--interval', '1h',
      '--db', dbPath,
    ]);
    const exportedJson = JSON.parse(await readFile(exportJsonPath, 'utf8')) as { primary: MarketData; higher?: MarketData };
    assert.equal(exportedJson.primary.candles.length, 220);
    assert.equal(exportedJson.higher?.interval, '4h');
    assert.equal(exportedJson.higher?.candles.length, 55);

    await runCacheBacktestCli([
      '--export', exportCsvPath,
      '--market', 'crypto',
      '--symbol', 'BTCUSDT',
      '--interval', '1h',
      '--format', 'csv',
      '--db', dbPath,
    ]);
    const csvLines = (await readFile(exportCsvPath, 'utf8')).trim().split('\n');
    assert.equal(csvLines[0], 'time,open,high,low,close,volume,closed');
    assert.equal(csvLines.length, 221);

    await runCacheBacktestCli([
      '--market', 'crypto',
      '--symbol', 'BTCUSDT',
      '--interval', '1h',
      '--folds', '3',
      '--db', dbPath,
      '--out', singleOutPath,
    ]);
    const singleReport = JSON.parse(await readFile(singleOutPath, 'utf8')) as { data: { closedBars: number; higherInterval: string }; folds: unknown[] };
    assert.equal(singleReport.data.closedBars, 220);
    assert.equal(singleReport.data.higherInterval, '4h');
    assert.equal(singleReport.folds.length, 3);

    await runCacheBacktestCli([
      '--watchlist',
      '--intervals', '1h',
      '--db', dbPath,
      '--out', batchOutPath,
    ]);
    const batchSummary = JSON.parse(await readFile(batchOutPath, 'utf8')) as { evaluated: number; results: { symbol: string }[] };
    assert.equal(batchSummary.evaluated, 1);
    assert.equal(batchSummary.results[0].symbol, 'BTCUSDT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
