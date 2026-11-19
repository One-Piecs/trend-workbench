import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, serializeCSV } from '../lib/csv.ts';
import { analyze } from '../lib/chan.ts';

function history(n = 100) {
  return Array.from({length: n}, (_, i) => {
    const price = 100 + Math.sin(i / 4) * 8;
    return {time: 1700000000 + i * 3600, open: price, high: price + 2, low: price - 2, close: price + 1, volume: 12, closed: i < n - 1};
  });
}

test('CSV roundtrip preserves prices, timestamps, incomplete candles and analysis', () => {
  const bars = history(), restored = parseCSV(serializeCSV(bars));
  assert.deepEqual(restored, bars);
  assert.deepEqual(analyze(restored), analyze(bars));
});

test('CSV accepts milliseconds, optional volume and closed, then sorts input', () => {
  const bars = history(35).reverse();
  const csv = 'timestamp,open,high,low,close\n' + bars.map(c => [c.time * 1000, c.open, c.high, c.low, c.close].join(',')).join('\n');
  const parsed = parseCSV(csv);
  assert.equal(parsed[0].time, bars.at(-1)!.time);
  assert.ok(parsed.every(c => c.closed && c.volume === 0));
});

test('CSV rejects duplicates, malformed OHLC, invalid closed and excessive rows', () => {
  const bars = history();
  assert.throws(() => parseCSV(serializeCSV([...bars, bars[0]])), /重复时间/);
  assert.throws(() => parseCSV(serializeCSV([{...bars[0], high: 1}, ...bars.slice(1)])), /OHLC/);
  assert.throws(() => parseCSV(serializeCSV(bars).replace(',false', ',unknown')), /closed/);
  assert.throws(() => parseCSV(serializeCSV(history(2001))), /2,000/);
});

test('CSV preserves small crypto prices without rounding them to zero', () => {
  const bars = history(35).map(c => ({...c, open: 0.0000000123, close: 0.0000000131, high: 0.000000014, low: 0.000000011}));
  assert.deepEqual(parseCSV(serializeCSV(bars)), bars);
});
