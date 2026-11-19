import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticDaily } from './synthetic-daily.ts';
import { buildStrokeCenters } from '../lib/center-layers.ts';
import { analyze } from '../lib/chan.ts';
import type { Candle, StructureLine } from '../lib/market-types';

const pens = (prices: number[], offset = 0): StructureLine[] => prices.slice(1).map((price, i) => ({
  from: {index: offset + i * 5, time: 1700000000 + (offset + i * 5) * 60, price: prices[i]},
  to: {index: offset + (i + 1) * 5, time: 1700000000 + (offset + (i + 1) * 5) * 60, price},
  direction: price > prices[i] ? 'up' : 'down', confirmed: true, confirmedAt: offset + (i + 2) * 5,
}));

test('the stroke layer requires three confirmed pens and records its actual formation dependency', () => {
  const lines = pens([10, 30, 20, 40]);
  assert.deepEqual(buildStrokeCenters(lines.slice(0, 2)), []);
  const [center] = buildStrokeCenters(lines);
  assert.deepEqual({low: center.low, high: center.high, start: center.startIndex, end: center.endIndex},
    {low: 20, high: 30, start: 0, end: 15});
  assert.equal(center.layer, 'stroke');
  assert.equal(center.level, '笔中枢');
  assert.equal(center.sequence, 1);
  assert.equal(center.formedAt, 20);
  assert.equal(center.formationEndIndex, 15);
  assert.equal(center.startTime, lines[0].from.time);
  assert.equal(center.status, 'active');
  assert.deepEqual(buildStrokeCenters(pens([10, 20, 5, 10])), [], 'a single touching price is not an area');
});

test('extension keeps the initial intersection, identifier and number, including an exact boundary return', () => {
  const lines = pens([10, 30, 20, 40, 30, 50, 25, 60]);
  const original = buildStrokeCenters(lines.slice(0, 3))[0];
  for (let size = 4; size <= lines.length; size++) {
    const [center] = buildStrokeCenters(lines.slice(0, size));
    assert.equal(center.id, original.id);
    assert.equal(center.sequence, original.sequence);
    assert.deepEqual([center.low, center.high, center.formedAt], [20, 30, 20]);
    assert.equal(center.endIndex, lines[size - 1].to.index);
    assert.equal(center.status, 'active');
  }
  const shifted = lines.map(line => ({...line, from: {...line.from, index: line.from.index + 7},
    to: {...line.to, index: line.to.index + 7}, confirmedAt: line.confirmedAt + 7}));
  assert.equal(buildStrokeCenters(shifted)[0].id, original.id);
});

test('a confirmed departure preserves the old center and numbers the later independent center', () => {
  const lines = pens([1, 30, 10, 25, 15, 40, 30, 50, 35]);
  const original = buildStrokeCenters(lines.slice(0, 3))[0];
  const result = buildStrokeCenters(lines);
  assert.deepEqual(result.map(c => [c.sequence, c.startIndex, c.endIndex, c.low, c.high, c.status]), [
    [1, 0, 25, 10, 25, 'broken'], [2, 25, 40, 35, 40, 'active'],
  ]);
  assert.equal(result[0].id, original.id);
  assert.notEqual(result[0].id, result[1].id);
  const mirrored = buildStrokeCenters(pens([1, 30, 10, 25, 15, 40, 30, 50, 35].map(p => 100 - p)));
  assert.deepEqual(mirrored.map(c => [c.low, c.high]), [[75, 90], [60, 65]]);
});

test('missing, mismatched and unfinished constituents cannot bridge a center across a broken chain', () => {
  const base = pens([10, 30, 20, 40]);
  for (const change of [{index: 6}, {time: base[1].from.time + 1}, {price: 31}]) {
    const lines = base.map((s, i) => i === 1 ? {...s, from: {...s.from, ...change}} : s);
    assert.deepEqual(buildStrokeCenters(lines), []);
  }
  assert.deepEqual(buildStrokeCenters(pens([10, 30, 35, 20])), []);
  assert.deepEqual(buildStrokeCenters(base.map((s, i) => i === 1 ? {...s, confirmed: false} : s)), []);
  const afterGap = buildStrokeCenters([...pens([10, 30, 20]), ...pens([18, 28, 20, 30], 50)]);
  assert.deepEqual(afterGap.map(c => [c.startIndex, c.endIndex, c.low, c.high]), [[50, 65, 20, 28]]);
});

test('an unfinished tail cannot extend or break an older center or create a new one', () => {
  const lines = pens([1, 30, 10, 25, 15, 40, 30, 50, 35]);
  const before = buildStrokeCenters(lines.slice(0, 5));
  assert.deepEqual(buildStrokeCenters([...lines.slice(0, 5), {...lines[5], confirmed: false}]), before);
  const unconfirmedLast = lines.map((s, i) => i === lines.length - 1 ? {...s, confirmed: false} : s);
  assert.equal(buildStrokeCenters(unconfirmedLast).length, 1);
});

test('the display calculation is pure and rejects invalid confirmed pen data', () => {
  const lines = pens([10, 30, 20, 40]);
  const input = lines.map(s => Object.freeze({...s, from: Object.freeze(s.from), to: Object.freeze(s.to)}));
  const snapshot = JSON.stringify(input);
  assert.equal(buildStrokeCenters(Object.freeze(input)).length, 1);
  assert.equal(JSON.stringify(input), snapshot);
  for (const invalid of [{confirmedAt: 0}, {confirmedAt: NaN}, {from: {...lines[1].from, price: NaN}}]) {
    assert.deepEqual(buildStrokeCenters(lines.map((s, i) => i === 1 ? {...s, ...invalid} : s)), []);
  }
});

const candles = syntheticDaily();

test('new and old pen centers are visible using only the history available at their formation', () => {
  for (const penMode of ['new', 'old'] as const) {
    const options = {penMode, skipCalibration: true, skipTradePlans: true};
    const analysis = analyze(candles, options);
    const centers = buildStrokeCenters(analysis.strokes);
    assert.ok(centers.length > 1);
    for (const center of centers) {
      const prefix = analyze(candles.slice(0, center.formedAt + 1), options);
      assert.ok(buildStrokeCenters(prefix.strokes).some(c => c.id === center.id), `${penMode} ${center.id}`);
    }
  }
});
