import assert from 'node:assert/strict';
import test from 'node:test';
import { createChartFeedController } from '../lib/market-context-loader.ts';
import { readMarketResponse } from '../lib/market-response.ts';
import type { MarketData } from '../lib/market-types';
import { createWatchMonitor, type WatchRow } from '../lib/watch-monitor.ts';

const context = { market: 'crypto', symbol: 'BTCUSDT', interval: '1M' } as const;
const bar = { time: 1767225600, open: 5, high: 7, low: 3, close: 6, volume: 0 };
const feed: MarketData = {
  instrument: { id: 'crypto:BTCUSDT', market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin', exchange: 'Binance', currency: 'USDT' },
  interval: '1M', candles: [bar], source: 'Binance', asOf: '2026-02-12T00:00:00Z',
  adjustment: '原始成交价格，不复权', delayNotice: '', warnings: [], availableIntervals: ['1M'],
};
const read = (body: unknown) => readMarketResponse(Response.json(body), context);

test('the feed contract accepts optional close flags and historical coverage', async () => {
  assert.deepEqual(await read(feed), feed);
  const withHistory = { ...feed, history: { requested: 800, received: 1, closed: 1, firstTime: bar.time, lastTime: bar.time, status: 'insufficient' } };
  assert.deepEqual(await read(withHistory), withHistory);
  const partial = { ...feed, candles: [{ ...bar, closed: false }] };
  assert.deepEqual(await read(partial), partial);
});

test('invalid JSON and unsuccessful HTTP responses use readable errors', async () => {
  await assert.rejects(readMarketResponse(new Response('<html>'), context), /行情源返回格式异常/);
  await assert.rejects(read(null), /行情源返回格式异常/);
  await assert.rejects(readMarketResponse(new Response('<html>', { status: 502 }), context), /行情源暂时没有响应/);
  await assert.rejects(readMarketResponse(Response.json({ error: {}, message: '暂时限流' }, { status: 429 }), context), /暂时限流/);
  await assert.rejects(read({ ...feed, candles: [] }), /该标的在此周期没有可用K线/);
});

test('a mismatched exchange market, symbol, instrument ID or timeframe cannot be displayed', async () => {
  for (const instrument of [{ ...feed.instrument, market: 'us' }, { ...feed.instrument, symbol: 'ETHUSDT' }, { ...feed.instrument, id: 'us:BTCUSDT' }]) {
    await assert.rejects(read({ ...feed, instrument }), /行情标的或周期不匹配/);
  }
  await assert.rejects(read({ ...feed, interval: '1w' }), /行情标的或周期不匹配/);
});

test('a malformed bar, price range or time ordering rejects the complete series', async () => {
  for (const row of [null, {}, { ...bar, time: 0 }, { ...bar, time: bar.time * 1000 },
    { ...bar, time: bar.time + 0.5 }, { ...bar, open: '5' }, { ...bar, high: 5 }, { ...bar, low: 6 },
    { ...bar, low: -1 }, { ...bar, close: null }, { ...bar, volume: -1 }, { ...bar, closed: 'false' }]) {
    await assert.rejects(read({ ...feed, candles: [row] }), /缺少完整K线/);
  }
  for (const time of [bar.time, bar.time - 1]) {
    await assert.rejects(read({ ...feed, candles: [bar, { ...bar, time }] }), /缺少完整K线/);
  }
});

test('invalid data capture time, source, history or renderer metadata cannot reach the chart', async () => {
  for (const metadata of [{ asOf: 'bad' }, { source: null }, { availableIntervals: ['not-a-period'] },
    { warnings: [null] }, { history: null }, { history: {} }]) {
    await assert.rejects(read({ ...feed, ...metadata }), /行情源返回格式异常/);
  }
});

test('chart refresh rejects corrupt candles, retains the last good snapshot and later recovers', async () => {
  const closes: number[] = [], errors: string[] = [];
  const replies = [feed, { ...feed, candles: [null] }, { ...feed, candles: [{ ...bar, close: 7 }] }];
  const controller = createChartFeedController(async () => Response.json(replies.shift()));
  for (const background of [false, true, true]) {
    await controller.load({ ...context, background, onSnapshot: snapshot => closes.push(snapshot.data.candles[0].close), onPrimaryError: message => errors.push(message) });
  }
  assert.deepEqual(closes, [6, 7]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /缺少完整K线/);
});

test('malformed watch responses produce an error row and never emit a forecast', async () => {
  let snapshots = 0;
  const states: WatchRow[] = [];
  const monitor = createWatchMonitor({ watchlist: [feed.instrument], interval: '1M',
    fetcher: async () => Response.json({ ...feed, candles: [null] }),
    onSnapshot: () => { snapshots++; }, onStatus: row => states.push(row),
  });
  monitor.start();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(snapshots, 0);
    assert.equal(states.at(-1)?.state, 'error');
    assert.match(states.at(-1)?.error ?? '', /缺少完整K线/);
  } finally { monitor.stop(); }
});
