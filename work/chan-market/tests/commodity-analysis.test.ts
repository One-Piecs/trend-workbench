import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze } from '../lib/chan.ts';
import { positiveRunStart } from '../lib/commodity-analysis.ts';
import { parseCSV, serializeCSV } from '../lib/csv.ts';
import { readMarketResponse } from '../lib/market-response.ts';
import type { Candle, MarketData } from '../lib/market-types';

const bars: Candle[] = Array.from({length: 105}, (_, index) => {
  const open = 80 + Math.sin(index / 3) * 8;
  return {time: 1580000000 + index * 3600, open, high: open + 2, low: open - 2, close: open + 1, volume: 80, closed: true};
});
const negativeIndex = 41;
bars[negativeIndex] = {...bars[negativeIndex], open: 3, high: 4, low: -40.32, close: -30};
const context = {market: 'commodity', symbol: 'CL=F', interval: '1h'} as const;

test('oil history keeps chart coordinates and restarts indicators after the last non-positive low', () => {
  const options = {context, skipTradePlans: true, skipCalibration: true};
  const start = negativeIndex + 1;
  const full = analyze(bars, options);
  const suffix = analyze(bars.slice(start), options);
  assert.ok(suffix.fractals.length > 0);
  assert.deepEqual(full.fractals, suffix.fractals.map(point => ({...point, index: point.index + start, confirmedAt: point.confirmedAt + start})));
  assert.deepEqual(full.macd, suffix.macd);
  assert.deepEqual(full.bias, suffix.bias);
});

test('an unreleased non-positive bar cannot reset an earlier replay', () => {
  const available = (bar: Candle) => bar.time < bars[negativeIndex].time;
  assert.equal(positiveRunStart(bars, 'commodity', available), 0);
  assert.equal(positiveRunStart(bars, 'commodity'), negativeIndex + 1);
  assert.equal(positiveRunStart(bars, 'us'), 0);
});

test('the commodity API and CSV round-trip a signed oil price while stocks reject it', async () => {
  const feed: MarketData = {instrument: {id: 'commodity:CL=F', symbol: 'CL=F', market: 'commodity', name: 'WTI', exchange: 'NYMEX', currency: 'USD'},
    interval: '1h', candles: bars, source: 'fixture', asOf: '2020-07-01T00:00:00Z', adjustment: '', delayNotice: '', warnings: [], availableIntervals: ['1h']};
  assert.deepEqual((await readMarketResponse(Response.json(feed), context)).candles, bars);
  const stock = {...feed, instrument: {...feed.instrument, id: 'us:TEST', symbol: 'TEST', market: 'us'}};
  await assert.rejects(readMarketResponse(Response.json(stock), {market: 'us', symbol: 'TEST', interval: '1h'}), /完整K线/);
  const csv = serializeCSV(bars);
  assert.deepEqual(parseCSV(csv, 'commodity'), bars);
  assert.throws(() => parseCSV(csv, 'us'), /OHLC/);
});
