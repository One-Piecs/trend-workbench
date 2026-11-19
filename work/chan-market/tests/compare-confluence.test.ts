import test from 'node:test';
import assert from 'node:assert/strict';
import { collectHoldoutEvents, compareEvents, simulateEvent, summarizeOutcomes, validateResearchBars } from '../scripts/compare-confluence.ts';
import type { TriggerEvent } from '../scripts/compare-confluence.ts';
import type { Candle, MarketData, TradePlan } from '../lib/market-types';

const bar = (i: number, open: number, low = open - .2, high = open + .2, close = open): Candle => ({ time: 1700000000 + i * 3600, open, low, high, close, volume: 100, closed: true });
const plan = (): TradePlan => ({ id: 'fixture-long', side: 'long', label: 'test', strategy: 'test', priority: 'primary', status: 'triggered', statusLabel: 'test', entryLow: 100, entryHigh: 102, triggerPrice: 100, stopLoss: 98, target1: 105, target2: 108, rr1: 1.5, rr2: 2.5, anchor: { time: bar(0, 99).time, index: 0, price: 99 }, generatedAt: bar(0, 99).time, generatedIndex: 0, triggeredAt: bar(1, 101).time, atr: 1, basis: 'synthetic test only', trigger: 'test', invalidation: 'test', statusReason: 'test' });
const event = (): TriggerEvent => ({ plan: plan(), triggerIndex: 1, shadowAccepted: true, evidence: { status: 'aligned', synthetic: true } });
const mirror = (b: Candle): Candle => ({ ...b, open: 200 - b.open, low: 200 - b.high, high: 200 - b.low, close: 200 - b.close });
const shortEvent = (): TriggerEvent => { const p = plan(); return { ...event(), plan: { ...p, id: 'fixture-short', side: 'short', entryLow: 200 - p.entryHigh, entryHigh: 200 - p.entryLow, triggerPrice: 200 - p.triggerPrice, stopLoss: 200 - p.stopLoss, target1: 200 - p.target1, target2: 200 - p.target2 } }; };
const noCosts = { feeBps: 0, slippageBps: 0 };

test('entry follows trigger close; fixed T2 fills with explicit adverse costs', () => {
  const candles = [bar(0, 99), bar(1, 101), bar(2, 101), bar(3, 105, 104, 109)];
  const result = simulateEvent(event(), candles, { feeBps: 5, slippageBps: 3 });
  assert.equal(result.entryAt, candles[2].time); assert.equal(result.exitAt, candles[3].time);
  assert.equal(result.entryPrice, 101 * 1.0003); assert.equal(result.exitPrice, 108 * .9997);
  const expected = (result.exitPrice! - result.entryPrice! - .0005 * (result.entryPrice! + result.exitPrice!)) / result.entryPrice! * 100;
  assert.equal(result.netReturnPct, expected); assert.equal(result.exitReason, 'target2');
});

test('short entries and exits receive adverse rather than favorable slippage', () => {
  const candles = [bar(0, 99), bar(1, 101), bar(2, 101), bar(3, 105, 104, 109)].map(mirror);
  const result = simulateEvent(shortEvent(), candles, { feeBps: 5, slippageBps: 3 });
  assert.equal(result.entryPrice, 99 * .9997); assert.equal(result.exitPrice, 92 * 1.0003);
  assert.ok(result.netReturnPct! > 0); assert.equal(result.exitReason, 'target2');
});

test('same candle stop and target resolves conservatively on both sides', () => {
  const candles = [bar(0, 99), bar(1, 101), bar(2, 101, 97, 109)];
  for (const [e, bars] of [[event(), candles], [shortEvent(), candles.map(mirror)]] as const) {
    const result = simulateEvent(e, bars, noCosts);
    assert.equal(result.exitReason, 'ambiguous_stop_first'); assert.ok(result.netReturnPct! < 0);
  }
});

test('stop gap uses worse open and never the favorable frozen stop price', () => {
  const candles = [bar(0, 99), bar(1, 101), bar(2, 101), bar(3, 94, 93, 96)];
  const result = simulateEvent(event(), candles, noCosts);
  assert.equal(result.exitPrice, 94); assert.equal(result.exitReason, 'gap_stop');
  const short = simulateEvent(shortEvent(), candles.map(mirror), noCosts);
  assert.equal(short.exitPrice, 106); assert.equal(short.exitReason, 'gap_stop');
});

test('next open outside the original entry band skips even if later price returns', () => {
  const result = simulateEvent(event(), [bar(0, 99), bar(1, 101), bar(2, 103, 101, 109)], noCosts);
  assert.equal(result.status, 'skipped_entry'); assert.equal(result.entryPrice, undefined);
});

test('opening slippage may disqualify an entry at the band boundary', () => {
  const result = simulateEvent(event(), [bar(0, 99), bar(1, 101), bar(2, 102)], { feeBps: 5, slippageBps: 3 });
  assert.equal(result.status, 'skipped_entry');
});

test('trigger candle extremes cannot close a position that opens next candle', () => {
  const result = simulateEvent(event(), [bar(0, 99), bar(1, 101, 90, 120), bar(2, 101)], noCosts);
  assert.equal(result.status, 'open'); assert.equal(result.exitPrice, undefined);
});

test('unresolved and no-next-bar events are censored without fabricated exit', () => {
  const noNext = simulateEvent(event(), [bar(0, 99), bar(1, 101)], noCosts);
  const open = simulateEvent(event(), [bar(0, 99), bar(1, 101), bar(2, 101)], noCosts);
  const summary = summarizeOutcomes([noNext, open]);
  assert.equal(summary.noNextBar, 1); assert.equal(summary.openAtEnd, 1);
  assert.equal(summary.completed, 0); assert.equal(summary.meanCompletedReturnPct, null);
});

test('shadow comparison is a strict subset of identical baseline event outcomes', () => {
  const candles = [bar(0, 99), bar(1, 101), bar(2, 101), bar(3, 105, 104, 109)];
  const second = { ...event(), plan: { ...plan(), id: 'second' }, shadowAccepted: false };
  const result = compareEvents(candles, [event(), second], noCosts);
  assert.equal(result.baseline.triggered, 2); assert.equal(result.shadow.triggered, 1);
  assert.equal(result.baseline.meanCompletedReturnPct, result.shadow.meanCompletedReturnPct);
  assert.equal(result.shadow.evidenceSufficient, false);
});

test('bad chronology, corrupt OHLC and mixed unfinished history are rejected', () => {
  assert.throws(() => validateResearchBars([bar(0, 99), bar(0, 100)]), /timestamps/);
  assert.throws(() => validateResearchBars([bar(0, 99, 100, 101)]), /OHLCV/);
  assert.throws(() => validateResearchBars([{ ...bar(0, 99), closed: false }, bar(1, 100)]), /unfinished/);
  assert.equal(validateResearchBars([bar(0, 99), { ...bar(1, 100), closed: false }]).length, 1);
});

test('event cannot use a trigger before creation or a different candle', () => {
  const candles = [bar(0, 99), bar(1, 101), bar(2, 101)];
  assert.throws(() => simulateEvent({ ...event(), triggerIndex: 2 }, candles), /trigger/);
  assert.throws(() => simulateEvent({ ...event(), plan: { ...plan(), generatedAt: candles[1].time } }, candles), /trigger/);
});

function researchFixture(): { primary: MarketData; higher: MarketData } {
  const start = 1700006400;
  const instrument = { id: 'crypto:FIXTURE', symbol: 'FIXTURE', name: 'Synthetic test only', market: 'crypto' as const, exchange: 'fixture', currency: 'USD' };
  const metadata = { instrument, source: 'synthetic-test-only', adjustment: '不复权', asOf: new Date((start + 141 * 3600) * 1000).toISOString(), delayNotice: 'test', warnings: [], availableIntervals: ['1h', '4h'] as MarketData['availableIntervals'] };
  const primary: MarketData = { ...metadata, interval: '1h', candles: Array.from({ length: 140 }, (_, i) => {
    const close = 100 + i * .015 + Math.sin(i / 7) * 9 + Math.sin(i / 29) * 14;
    return { time: start + i * 3600, open: close - .15, high: close + .5, low: close - .5, close, volume: 100 + i % 9 * 20, closed: true };
  }) };
  const higher: MarketData = { ...metadata, interval: '4h', candles: Array.from({ length: 90 }, (_, i) => {
    const close = 100 + Math.sin(i / 7) * 9 + i * .2;
    return { time: start + (i - 45) * 14400, open: close - .1, high: close + .5, low: close - .5, close, volume: 400, closed: true };
  }) };
  return { primary, higher };
}

test('chronological holdout supplies complete higher-timeframe context and records only fresh holdout triggers', () => {
  const input = researchFixture();
  const result = collectHoldoutEvents(input);
  assert.equal(result.holdoutStart, 98);
  assert.equal(result.evidenceCoverage.snapshots, 42);
  assert.equal(result.evidenceCoverage.higherStatuses.ready, 42);
  assert.ok(result.events.length > 0, 'Synthetic fixture must exercise event collection');
  assert.ok(result.events.every(e => e.triggerIndex >= result.holdoutStart && e.plan.triggeredAt === result.candles[e.triggerIndex].time));
  assert.equal(new Set(result.events.map(e => e.plan.id)).size, result.events.length);
});

test('future higher-timeframe candles cannot change held-out events or evidence', () => {
  const input = researchFixture();
  const before = collectHoldoutEvents(input);
  const lastAvailable = input.primary.candles.at(-1)!.time + 3600;
  const changed = structuredClone(input);
  changed.higher.candles = changed.higher.candles.map(b => b.time + 14400 > lastAvailable ? { ...b, open: 9000, low: 8000, high: 12000, close: 11000, volume: 1e12 } : b);
  const after = collectHoldoutEvents(changed);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.evidenceCoverage, before.evidenceCoverage);
});

test('provider mismatch is visible in coverage instead of silently claiming a valid shadow comparison', () => {
  const input = researchFixture();
  input.higher.source = 'different-provider';
  const result = collectHoldoutEvents(input);
  assert.equal(result.evidenceCoverage.higherStatuses.mismatch, 42);
  assert.ok(result.events.every(event => !event.shadowAccepted));
});
