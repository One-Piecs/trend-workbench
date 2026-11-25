import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../lib/chan.ts';
import { getCandles, parseLongbridgeCandles, resetMarketNetworkFailures, setLongbridgeRunner, longbridgeOvernightEnabled } from '../lib/market-data.ts';

const cliRow = (time: string, session: string, open = 100) => ({ time, session, open: String(open), high: String(open + 2), low: String(open - 1), close: String(open + 1), volume: '500', turnover: '50000.000' });
const withEnv = async <T>(run: () => Promise<T>): Promise<T> => {
  const original = process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE;
  process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE = '1';
  try { return await run(); }
  finally {
    if (original === undefined) delete process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE;
    else process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE = original;
  }
};
const failOtherSources = () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  return () => { globalThis.fetch = original; };
};

test('overnight source is opt-in via environment flag', () => {
  const original = process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE;
  delete process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE;
  try { assert.equal(longbridgeOvernightEnabled(), false); }
  finally {
    if (original !== undefined) process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE = original;
  }
  process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE = '1';
  try { assert.equal(longbridgeOvernightEnabled(), true); }
  finally {
    if (original === undefined) delete process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE;
    else process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE = original;
  }
});

test('Longbridge parser accepts all four sessions, rejects unknown ones and drops bad rows', () => {
  const now = Date.parse('2026-11-23T06:30:00Z') / 1000;
  const rows = [
    cliRow('2026-11-20T21:00:00Z', 'Post'),
    cliRow('2026-11-23T05:45:00Z', 'Overnight'),
    cliRow('2026-11-23T14:30:00Z', 'Intraday'),
    cliRow('2026-11-23T09:00:00Z', 'Pre'),
    cliRow('2026-11-23T05:45:30Z', 'Overnight'),
    cliRow('not-a-time', 'Overnight'),
  ];
  const { candles, sessions } = parseLongbridgeCandles(rows, '15m', now);
  assert.deepEqual(candles.map(c => c.time), [Date.parse('2026-11-20T21:00:00Z') / 1000, Date.parse('2026-11-23T05:45:00Z') / 1000, Date.parse('2026-11-23T09:00:00Z') / 1000, Date.parse('2026-11-23T14:30:00Z') / 1000]);
  assert.deepEqual(sessions, { Post: 1, Overnight: 1, Intraday: 1, Pre: 1 });
  // Session labels ride along so the chart can shade pre/post/overnight bands.
  assert.deepEqual(candles.map(c => c.session), ['post', 'overnight', 'pre', 'regular']);
  // Older bars are confirmed; a bar still inside its interval stays open.
  assert.equal(candles[0].closed, true);
  assert.throws(() => parseLongbridgeCandles([{ ...cliRow('2026-11-23T05:45:00Z', 'Overnight'), session: 'Auction' }], '15m', now), /未识别的交易时段/);
  assert.throws(() => parseLongbridgeCandles('nope', '15m', now), /格式异常/);
});

test('enabled overnight source wins candidate selection and keeps overnight bars', async () => {
  const calls: string[][] = [];
  setLongbridgeRunner(async args => {
    calls.push(args);
    if (args[0] === 'static') return JSON.stringify([{ symbol: 'TSLA.US', name: 'Tesla', exchange: 'NASD', currency: 'USD' }]);
    return JSON.stringify([
      cliRow('2026-11-23T14:30:00Z', 'Intraday', 300),
      cliRow('2026-11-23T05:45:00Z', 'Overnight', 290),
      cliRow('2026-11-23T09:00:00Z', 'Pre', 295),
    ]);
  });
  const restoreFetch = failOtherSources();
  try {
    const result = await withEnv(() => getCandles('us', 'TSLA', '1h', 100));
    assert.ok(result.source.includes('Longbridge'));
    assert.equal(result.instrument.name, 'Tesla');
    assert.equal(result.instrument.exchange, 'NASDAQ');
    assert.deepEqual(calls.find(args => args[0] === 'kline'), ['kline', 'TSLA.US', '--period', '1h', '--count', '100', '--session', 'all', '--format', 'json']);
    assert.equal(result.candles.some(c => c.time === Date.parse('2026-11-23T05:45:00Z') / 1000), true);
    assert.ok(result.warnings.some(w => w.includes('夜盘')));
    assert.ok(result.warnings.some(w => w.includes('周期结束时确认收盘')));
    assert.ok(!result.warnings.some(w => w.includes('延后15分钟')));
    assert.ok(result.warnings.some(w => w.includes('盘前1根')));
  } finally { restoreFetch(); setLongbridgeRunnerDefault(); }
});

test('real-time Longbridge 1m candles confirm at bar close so MACD reaches the latest closed bar', () => {
  // 01:30:20Z is 20:30:20 EST (evening overnight after 16:00 regular close).
  const now = Date.parse('2026-11-25T01:30:20Z') / 1000;
  const start = Date.parse('2026-11-25T00:51:00Z') / 1000;
  const rows = Array.from({ length: 40 }, (_, i) =>
    cliRow(new Date((start + i * 60) * 1000).toISOString(), 'Overnight', 65 + i * 0.1));
  const { candles } = parseLongbridgeCandles(rows, '1m', now);
  assert.equal(candles.length, 40);
  // Every bar up to 01:29:00Z (ended at 01:30:00Z) is closed; only the forming 01:30:00Z bar is open.
  assert.equal(candles.slice(0, -1).every(c => c.closed === true), true);
  assert.equal(candles.at(-1)?.time, Date.parse('2026-11-25T01:30:00Z') / 1000);
  assert.equal(candles.at(-1)?.closed, false);
  const analysis = analyze(candles, { skipCalibration: true, skipTradePlans: true });
  assert.equal(analysis.macd.at(-1)?.time, candles.at(-2)?.time);
});

test('dashed symbols are converted to the Longbridge dot format', async () => {
  let requested = '';
  setLongbridgeRunner(async args => {
    if (args[0] === 'static') return JSON.stringify([{ symbol: 'BRK.B.US', name: 'Berkshire Hathaway', exchange: 'NYSE', currency: 'USD' }]);
    requested = args[1];
    return JSON.stringify(Array.from({ length: 12 }, (_, i) => cliRow(`2026-11-23T0${i}:00:00Z`.replace('T00', 'T05'), 'Overnight', 570 + i)));
  });
  const restoreFetch = failOtherSources();
  try {
    await withEnv(() => getCandles('us', 'BRK-B', '1m', 100));
    assert.equal(requested, 'BRK.B.US');
  } finally { restoreFetch(); setLongbridgeRunnerDefault(); }
});

test('disabled or unavailable Longbridge falls back without spawning the CLI', async () => {
  let cliCalls = 0;
  setLongbridgeRunner(async () => { cliCalls++; return '[]'; });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    chart: { result: [{ meta: { dataGranularity: '60m', exchangeTimezoneName: 'America/New_York', currency: 'USD', shortName: 'Tesla' }, timestamp: [Date.parse('2026-11-23T14:30:00Z') / 1000], indicators: { quote: [{ open: [100], high: [102], low: [99], close: [101], volume: [1000] }] } }] },
  }));
  try {
    delete process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE;
    const result = await getCandles('us', 'AAPL', '1h', 100);
    assert.ok(result.source.includes('Yahoo'));
    assert.equal(cliCalls, 0);
  } finally { globalThis.fetch = original; resetMarketNetworkFailures(); setLongbridgeRunnerDefault(); }
});

test('provider failure enters a cooldown and the feed falls back to regular sources', async () => {
  let cliCalls = 0;
  let yahooFails = false;
  setLongbridgeRunner(async () => {
    cliCalls++;
    throw Object.assign(new Error('spawn failed'), { stdout: '', stderr: 'Error: network unreachable' });
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    if (yahooFails) return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify({
      chart: { result: [{ meta: { dataGranularity: '60m', exchangeTimezoneName: 'America/New_York', currency: 'USD', shortName: 'Tesla' }, timestamp: [Date.parse('2026-11-23T14:30:00Z') / 1000], indicators: { quote: [{ open: [100], high: [102], low: [99], close: [101], volume: [1000] }] } }] },
    }));
  };
  try {
    await withEnv(() => getCandles('us', 'MSFT', '1h', 100));
    assert.equal(cliCalls, 1);
    const second = await withEnv(() => getCandles('us', 'MSFT', '1h', 101));
    assert.ok(second.source.includes('Yahoo'));
    assert.equal(cliCalls, 1, 'cooldown must skip repeated CLI spawns');
    resetMarketNetworkFailures();
    yahooFails = true;
    await assert.rejects(withEnv(() => getCandles('us', 'MSFT', '1h', 102)), /Longbridge/);
    assert.equal(cliCalls, 2, 'route reset re-arms the Longbridge source');
  } finally { globalThis.fetch = original; resetMarketNetworkFailures(); setLongbridgeRunnerDefault(); }
});

test('unknown symbols stay 404 and never disable other instruments', async () => {
  setLongbridgeRunner(async () => {
    throw Object.assign(new Error('kline failed'), { stdout: JSON.stringify({ error: { code: 301603, message: 'no security matches "ZZZ.US"' } }), stderr: '' });
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    chart: { result: [{ meta: { dataGranularity: '60m', exchangeTimezoneName: 'America/New_York', currency: 'USD', shortName: 'Tesla' }, timestamp: [Date.parse('2026-11-23T14:30:00Z') / 1000], indicators: { quote: [{ open: [100], high: [102], low: [99], close: [101], volume: [1000] }] } }] },
  }));
  try {
    const result = await withEnv(() => getCandles('us', 'NVDA', '1h', 100));
    assert.ok(result.source.includes('Yahoo'), 'the 404 falls back to the next provider');
  } finally { globalThis.fetch = original; resetMarketNetworkFailures(); setLongbridgeRunnerDefault(); }
});

function setLongbridgeRunnerDefault() {
  // Subsequent tests default to "CLI absent": the enabled source reports unavailable
  // instead of spawning a real process from the test suite.
  setLongbridgeRunner(async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); });
}
