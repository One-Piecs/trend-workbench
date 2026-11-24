import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptLiveCandle, liveCandleKey, liveDisplayCandles, type LiveCandleUpdate } from '../lib/live-candle.ts';
import type { Candle, MarketData } from '../lib/market-types';

const start = Date.UTC(2026, 0, 1) / 1000;
const tail: Candle = { time: start, open: 10, high: 12, low: 9, close: 11, volume: 20, closed: false };
const feed: MarketData = {
  instrument: { id: 'crypto:BTCUSDT', symbol: 'BTCUSDT', market: 'crypto', name: 'Bitcoin', exchange: 'Kraken', currency: 'USDT' },
  interval: '1m', candles: [{ ...tail, time: start - 60, closed: true }, tail],
  source: 'Kraken 公共现货行情 · XBTUSDT', asOf: new Date(start * 1000).toISOString(),
  adjustment: '', delayNotice: '', availableIntervals: ['1m'], warnings: [],
};
const now = (start + 30) * 1000;
const latest = (data = feed, override: Partial<Candle> = {}, at = now): LiveCandleUpdate => ({
  key: liveCandleKey(data), eventTimeMs: at, candle: { ...tail, close: 11.5, volume: 21, ...override },
});

test('only displays a fresh cumulative snapshot; REST candles and confirmed analysis inputs are immutable', () => {
  const next = latest(feed, { closed: true }, (start + 60) * 1000);
  assert.ok(acceptLiveCandle(feed, null, next, next.eventTimeMs));
  const shown = liveDisplayCandles(feed, next);
  assert.equal(shown.length, feed.candles.length);
  assert.equal(shown[0], feed.candles[0]);
  assert.equal(shown[1].close, 11.5);
  assert.equal(shown[1].closed, false);
  assert.equal(feed.candles[1].close, 11);
  assert.equal(next.candle.closed, true);
  const sealed = { ...feed, candles: [feed.candles[0], { ...tail, closed: true }] };
  assert.equal(liveDisplayCandles(sealed, next), sealed.candles);
  assert.equal(acceptLiveCandle(sealed, null, next, next.eventTimeMs), false);
});

test('reconciles an overlapping REST reload from cumulative volume, extrema and the opening price', () => {
  const next = latest();
  for (const change of [{ volume: 23 }, { high: 13 }, { low: 8 }, { open: 10.5 }, { volume: 21, close: 10 }]) {
    const newer = { ...feed, candles: [{ ...tail, ...change }] };
    assert.equal(liveDisplayCandles(newer, next), newer.candles);
    assert.equal(acceptLiveCandle(newer, null, next, now), false);
  }
  assert.equal(liveDisplayCandles(feed, next).at(-1)?.volume, 21);
  const corrected = { ...feed, candles: [{ ...tail, open: 10.5 }] };
  assert.ok(acceptLiveCandle(corrected, next, latest(corrected, { open: 10.5 }, now + 1), now + 1));
});

test('rejects stale, invalid or out of order websocket candles including a reopened final update', () => {
  const previous = latest();
  for (const candle of [{ volume: 19 }, { volume: -1 }, { time: start - 60 }, { time: NaN }, { close: 14 },
    { close: NaN }, { low: 0 }, { high: Infinity }, { open: 10.5 }]) {
    assert.equal(acceptLiveCandle(feed, previous, latest(feed, candle), now), false);
  }
  for (const stamp of [now - 1, now + 20_000, (start - 1) * 1000, NaN]) {
    assert.equal(acceptLiveCandle(feed, previous, latest(feed, { volume: 24 }, stamp), now), false);
  }
  assert.equal(acceptLiveCandle(feed, null, latest(), now + 100_000), false);
  const final = latest(feed, { closed: true, volume: 24 }, (start + 60) * 1000);
  assert.equal(acceptLiveCandle(feed, final, latest(feed, { volume: 25 }, final.eventTimeMs + 10), final.eventTimeMs + 10), false);
  assert.ok(acceptLiveCandle(feed, previous, latest(feed, { volume: 23, close: 12 }, now), now));
});

test('rejects events from a different selected venue, symbol, source, market or timeframe', () => {
  const update = latest();
  for (const data of [
    { ...feed, source: 'Binance 公共现货行情 · BTCUSDT' },
    { ...feed, instrument: { ...feed.instrument, symbol: 'ETHUSDT' } },
    { ...feed, instrument: { ...feed.instrument, exchange: 'OKX' } },
    { ...feed, instrument: { ...feed.instrument, market: 'us' as const } },
    { ...feed, interval: '1h' as const },
  ]) {
    assert.equal(acceptLiveCandle(data, null, update, now), false);
    assert.equal(liveDisplayCandles(data, update), data.candles);
  }
});

test('appends only the next bucket after a confirmed REST tail, preserving venue weekly alignment and calendar months', () => {
  const thursday = start;
  for (const [interval, from, to] of [
    ['1m', start, start + 60], ['1w', thursday, thursday + 7 * 86400],
    ['1M', Date.UTC(2024, 1, 1) / 1000, Date.UTC(2024, 2, 1) / 1000],
  ] as const) {
    const ended = { ...feed, interval, candles: [{ ...tail, time: from, closed: true }] };
    const update = latest(ended, { time: to }, to * 1000 + 15_000);
    assert.ok(acceptLiveCandle(ended, null, update, update.eventTimeMs));
    assert.equal(liveDisplayCandles(ended, update).length, 2);
    const unresolved = { ...ended, candles: [{ ...tail, time: from }] };
    assert.equal(acceptLiveCandle(unresolved, null, update, update.eventTimeMs), false);
    const gap = latest(ended, { time: to + 60 }, (to + 60) * 1000);
    assert.equal(acceptLiveCandle(ended, null, gap, gap.eventTimeMs), false);
    assert.equal(liveDisplayCandles(ended, gap), ended.candles);
  }
});
