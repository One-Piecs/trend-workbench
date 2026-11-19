import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMarketRegime, MARKET_REGIME_DEFAULTS } from '../lib/market-regime.ts';
import type { Candle } from '../lib/market-types';

const start = 1577836800;
const candle = (index: number, close: number, radius = 1): Candle => ({
  time: start + index * 3600, open: close, high: close + radius, low: close - radius,
  close, volume: 100, closed: true,
});
const flat = (count: number, radius = 0) => Array.from({ length: count }, (_, i) => candle(i, 100, radius));
const near = (actual: number | null, expected: number, tolerance = 1e-10) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < tolerance, `${actual} differs from ${expected}`);
};

test('ADX14 needs 28 closed candles; ATR/DI warm up earlier without reporting a ready regime', () => {
  const bars = Array.from({ length: 35 }, (_, i) => candle(i, 100 + i));
  assert.deepEqual(evaluateMarketRegime([]), {
    version: 'wilder-adx14-v1', status: 'insufficient', state: 'transition', direction: 'neutral',
    adx: null, plusDI: null, minusDI: null, atrPct: null, volatilityPercentile: null,
    volatilitySamples: 0, samples: 0, asOf: 0,
  });
  assert.equal(evaluateMarketRegime(bars.slice(0, 14)).atrPct, null);
  const fifteen = evaluateMarketRegime(bars.slice(0, 15));
  assert.equal(fifteen.status, 'insufficient');
  near(fifteen.atrPct, 200 / 114); near(fifteen.plusDI, 50); near(fifteen.minusDI, 0);
  const twentySeven = evaluateMarketRegime(bars.slice(0, 27));
  assert.equal(twentySeven.adx, null); assert.equal(twentySeven.direction, 'neutral');
  const twentyEight = evaluateMarketRegime(bars.slice(0, 28));
  assert.equal(twentyEight.status, 'ready'); near(twentyEight.adx, 100);
  assert.equal(twentyEight.state, 'trend'); assert.equal(twentyEight.direction, 'long');
});

test('hand-derived reversal fixture independently checks Wilder seed, DI denominator and ADX recursion', () => {
  // 13 rises of +1 with TR=2, one fall of -2 with TR=3, then 13 flat bars.
  // At transition 14, Wilder DMI sums are +DM=169/14, -DM=2, TR=190/7.
  // Subsequent flat bars decay both DM legs equally, so all first 14 DX equal
  // 100*(169-28)/(169+28)=14100/197. No iterative oracle mirrors the code.
  const bars = Array.from({ length: 28 }, (_, i) => candle(i, i <= 13 ? 100 + i : 111));
  const r = 13 / 14, power = r ** 13;
  const plusSum = (169 / 14) * power, minusSum = 2 * power;
  const trSum = 28 - (6 / 7) * power;
  const expectedAdx = 14100 / 197;
  const first = evaluateMarketRegime(bars);
  near(first.plusDI, 100 * plusSum / trSum);
  near(first.minusDI, 100 * minusSum / trSum);
  near(first.adx, expectedAdx);
  // ATR has an independent 14-TR SMA seed, 29/14, then 13 decay steps.
  const expectedAtr = 2 + power / 14;
  near(first.atrPct, 100 * expectedAtr / 111);
  const next = evaluateMarketRegime([...bars, candle(28, 113)]);
  const nextPlus = plusSum * r + 2, nextMinus = minusSum * r;
  const nextDX = 100 * Math.abs(nextPlus - nextMinus) / (nextPlus + nextMinus);
  near(next.adx, expectedAdx * r + nextDX / 14);
  near(next.atrPct, 100 * (expectedAtr * r + 3 / 14) / 113);
});

test('direction is separate from trend strength, with falling and oscillating markets', () => {
  const falling = Array.from({ length: 100 }, (_, i) => candle(i, 250 - i));
  const down = evaluateMarketRegime(falling);
  near(down.adx, 100); near(down.plusDI, 0); near(down.minusDI, 50);
  assert.equal(down.state, 'trend'); assert.equal(down.direction, 'short');
  const oscillating = Array.from({ length: 100 }, (_, i) => candle(i, 100 + i % 2));
  const range = evaluateMarketRegime(oscillating);
  assert.equal(range.state, 'range'); assert.equal(range.direction, 'neutral');
  assert.ok(range.adx! < 20);
});

test('zero TR and equal outside directional moves do not create NaN or a fake trend', () => {
  const zero = evaluateMarketRegime(flat(100));
  assert.equal(zero.status, 'ready'); assert.equal(zero.state, 'range');
  near(zero.adx, 0); near(zero.plusDI, 0); near(zero.minusDI, 0); near(zero.atrPct, 0);
  near(zero.volatilityPercentile, 50);
  const widening = Array.from({ length: 28 }, (_, i) => candle(i, 1000, 1 + i / 10));
  const tied = evaluateMarketRegime(widening);
  near(tied.adx, 0); near(tied.plusDI, 0); near(tied.minusDI, 0);
});

test('a fading directional move enters the neutral transition band before range', () => {
  const data = Array.from({ length: 120 }, (_, i) => candle(i, i < 70 ? 100 + i * .1 : 107 + (i % 2) * .1, .5));
  const trend = evaluateMarketRegime(data.slice(0, 70));
  const transition = evaluateMarketRegime(data.slice(0, 110));
  const range = evaluateMarketRegime(data);
  assert.equal(trend.state, 'trend');
  assert.ok(transition.adx! >= 20 && transition.adx! < 25);
  assert.equal(transition.state, 'transition'); assert.equal(transition.direction, 'neutral');
  assert.equal(range.state, 'range'); assert.equal(range.direction, 'neutral');
});

test('absolute volatility cutoff is explicit and does not imply a short or long forecast', () => {
  const exact = evaluateMarketRegime(flat(100, 2.5));
  near(exact.atrPct, 5); assert.equal(exact.state, 'volatile'); assert.equal(exact.direction, 'neutral');
  const below = evaluateMarketRegime(flat(100, 2.49));
  assert.equal(below.state, 'range');
  const shortHistory = evaluateMarketRegime(flat(27, 10));
  assert.equal(shortHistory.status, 'insufficient'); assert.equal(shortHistory.state, 'transition');
});

test('relative volatility uses at least 60 prior observations and excludes the current observation', () => {
  // 74 prior candles produce exactly 60 historical ATR observations (indices
  // 14..73); a new 30-point true range lifts ATR to >2% but still below 5%.
  const initial = flat(74, .05);
  const last = candle(74, 100, 15);
  const result = evaluateMarketRegime([...initial, last]);
  assert.equal(result.volatilitySamples, 60); near(result.volatilityPercentile, 100);
  near(result.atrPct, (.1 * 13 + 30) / 14);
  assert.equal(result.state, 'volatile');
  const insufficient = evaluateMarketRegime([...initial.slice(0, 73), candle(73, 100, 15)]);
  assert.equal(insufficient.volatilitySamples, 59); assert.equal(insufficient.volatilityPercentile, null);
  assert.equal(insufficient.state, 'range');
  const tiny = evaluateMarketRegime([...initial, candle(74, 100, .2)]);
  near(tiny.volatilityPercentile, 100); assert.ok(tiny.atrPct! < 2);
  assert.equal(tiny.state, 'range', 'A tiny increase from a flat market is not extreme volatility');
});

test('volatility reference is capped at 252 prior observations', () => {
  const data = flat(400, .5);
  const result = evaluateMarketRegime(data);
  assert.equal(result.volatilitySamples, 252); near(result.volatilityPercentile, 50);
  near(result.atrPct, 1);
});

test('unfinished, future, malformed, duplicate and out-of-order candles are ignored without mutation', () => {
  const data = Array.from({ length: 40 }, (_, i) => candle(i, 100 + i / 10));
  const original = structuredClone(data);
  const cutoff = data.at(-1)!.time + 3600;
  const baseline = evaluateMarketRegime(data, { asOf: cutoff });
  const appended: Candle[] = [
    { ...candle(40, 900, 100), closed: false },
    candle(41, 800, 100),
    { ...candle(40, 110), close: NaN },
    { ...candle(40, 110), low: 112 },
    { ...candle(40, 110), high: 109 },
    { ...candle(40, 110), volume: -1 },
    { ...candle(40, 110), low: 0 },
    { ...candle(40, 110), time: Infinity },
    candle(20, 900, 10),
    candle(39, 900, 10),
  ];
  assert.deepEqual(evaluateMarketRegime([...data, ...appended], { asOf: cutoff }), baseline);
  assert.deepEqual(data, original);
  const future = { ...candle(40, 900, 100), time: Math.ceil(Date.now() / 1000) + 86400 };
  assert.deepEqual(evaluateMarketRegime([...data, future]), evaluateMarketRegime(data));
});

test('each historical cutoff matches its own prefix even when later candles contain extreme prices', () => {
  const data = Array.from({ length: 110 }, (_, i) => candle(i, 100 + Math.sin(i / 3) * 2 + i / 20, .4));
  const withExtremeFuture = [...data, candle(110, 10000, 5000)];
  for (const count of [14, 15, 27, 28, 60, 75, 100, 110]) {
    const prefix = data.slice(0, count), cutoff = prefix.at(-1)!.time;
    assert.deepEqual(evaluateMarketRegime(withExtremeFuture, { asOf: cutoff }), evaluateMarketRegime(prefix, { asOf: cutoff }));
  }
});

test('price and volume scale do not change normalized indicators or classification', () => {
  const data = Array.from({ length: 120 }, (_, i) => candle(i, 100 + Math.sin(i / 4) * 3 + i / 10, .7));
  const original = evaluateMarketRegime(data);
  for (const scale of [1e-9, .01, 1e9]) {
    const scaled = evaluateMarketRegime(data.map(b => ({ ...b, open: b.open * scale, high: b.high * scale, low: b.low * scale, close: b.close * scale, volume: b.volume * 17 })));
    for (const key of ['adx', 'plusDI', 'minusDI', 'atrPct', 'volatilityPercentile'] as const) near(scaled[key], original[key]!, 1e-8);
    assert.equal(scaled.state, original.state); assert.equal(scaled.direction, original.direction);
  }
  assert.equal(MARKET_REGIME_DEFAULTS.trendAdxAtLeast, 25);
  assert.equal(MARKET_REGIME_DEFAULTS.rangeAdxBelow, 20);
  assert.equal(MARKET_REGIME_DEFAULTS.absoluteVolatileAtrPct, 5);
});

test('an unrepresentable ATR percentage is insufficient rather than a false confident classification', () => {
  const data = Array.from({ length: 30 }, (_, i) => ({ ...candle(i, 100), low: 1e-300, high: 1e300, open: 1e-300, close: 1e-300 }));
  const result = evaluateMarketRegime(data);
  assert.equal(result.status, 'insufficient'); assert.equal(result.atrPct, null);
  assert.equal(result.direction, 'neutral');
  for (const value of [result.adx, result.plusDI, result.minusDI, result.atrPct, result.volatilityPercentile]) assert.ok(value === null || Number.isFinite(value));
});
