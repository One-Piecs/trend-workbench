import assert from 'node:assert/strict';
import test from 'node:test';
import {chartWindow, endAtTime} from '../lib/chart-viewport.ts';
import type {Candle} from '../lib/market-types';

function candles(n: number): Candle[] {
  return Array.from({length:n}, (_, i) => ({
    time: 1_700_000_000 + i * 3600, open: 20, high: 22, low: 18, close: 21, volume: 12,
  }));
}

test('a panned range survives an earlier page and new live candles', () => {
  const bars = candles(1600), firstPage = bars.slice(500, 1300);
  const anchor = firstPage[159].time;
  const seen = (data:Candle[]) => {
    const {start, end} = chartWindow(data, 160, anchor);
    return data.slice(start, end).map(c => c.time);
  };
  assert.deepEqual(seen(bars), seen(firstPage));
  assert.equal(seen(firstPage).length, 160);
  assert.equal(chartWindow(bars, 160, anchor).start, 500);
});

test('live mode follows the newest candle and can show over 600 candles at wide zoom', () => {
  const bars = candles(1800);
  assert.deepEqual(chartWindow(bars, 1000, null), {start:800, end:1800, back:0});
  assert.deepEqual(chartWindow(bars.slice(0,-1), 1000, null), {start:799, end:1799, back:0});
  assert.deepEqual(chartWindow(bars.slice(3,10), 20, null), {start:0, end:7, back:0});
  assert.deepEqual(chartWindow([], 20, 0), {start:0, end:0, back:0});
});

test('a cursor between sessions picks the preceding real candle', () => {
  const rows = candles(150);
  const bars = [...rows.slice(0, 55), ...rows.slice(100)];
  assert.equal(endAtTime(bars, rows[80].time), 55);
  assert.deepEqual(chartWindow(bars, 20, rows[80].time), {start:35, end:55, back:50});
  assert.deepEqual(chartWindow(bars, 20, rows[0].time-1), {start:0, end:20, back:85});
});

test('a pending new interval increases only the live edge of the snapshot', () => {
  const bars = candles(81), appended = bars.pop()!;
  assert.deepEqual(chartWindow(bars, 20, null, appended), {start:61, end:81, back:0});
  assert.deepEqual(chartWindow(bars, 20, bars[39].time, appended), {start:20, end:40, back:41});
  assert.equal(endAtTime(bars, appended.time, appended), 81);
  assert.equal(endAtTime(bars, appended.time-1, appended), 80);
  assert.equal(bars.length, 80);
});
