import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../lib/chan.ts';
import { getCandles, getOlderHistory, getWorkbenchLiveQuote, MarketError, parseLongbridgeCandles, resetMarketNetworkFailures, setLongbridgeRunner, longbridgeOvernightEnabled } from '../lib/market-data.ts';

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

test('getOlderHistory pages Longbridge 1h and 5m bars with session labels and strict before boundary', async () => {
  const calls: string[][] = [];
  const source = 'Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com';
  const adjustment = '不复权（原始价格）；成交量单位：股';
  const before = Date.parse('2026-11-24T14:30:00Z') / 1000;
  setLongbridgeRunner(async args => {
    calls.push(args);
    return JSON.stringify([
      cliRow('2026-11-24T09:00:00Z', 'Pre', 64),
      cliRow('2026-11-24T13:30:00Z', 'Pre', 65),
      cliRow('2026-11-24T14:30:00Z', 'Intraday', 66),
    ]);
  });
  try {
    const page1h = await withEnv(() => getOlderHistory(new URLSearchParams({
      market: 'us', symbol: 'SOXS', interval: '1h', source, adjustment, before: String(before), limit: '500',
    })));
    assert.equal(page1h.status, 'more');
    assert.deepEqual(page1h.candles.map(c => c.session), ['pre', 'pre']);
    assert.equal(page1h.candles.every(c => c.time < before), true);
    assert.deepEqual(calls[0].slice(0, 5), ['kline', 'history', 'SOXS.US', '--period', '1h']);

    const page5m = await withEnv(() => getOlderHistory(new URLSearchParams({
      market: 'us', symbol: 'SOXS', interval: '5m', source, adjustment, before: String(before), limit: '500',
    })));
    assert.equal(page5m.status, 'more');
    assert.equal(calls[1][4], '5m');
  } finally { resetMarketNetworkFailures(); setLongbridgeRunnerDefault(); }
});

test('getOlderHistory steps endDate back 1 day on busy 1m truncation, steps across empty windows to end, and respects disabled flag', async () => {
  const source = 'Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com';
  const adjustment = '不复权（原始价格）；成交量单位：股';
  const before = Date.parse('2026-11-24T06:00:00Z') / 1000; // 01:00 EST on 2026-11-24
  const ends: string[] = [];
  setLongbridgeRunner(async args => {
    const end = args[args.indexOf('--end') + 1];
    ends.push(end);
    if (end === '2026-11-24') {
      return JSON.stringify([cliRow('2026-11-24T12:00:00Z', 'Pre', 66)]);
    }
    return JSON.stringify([cliRow('2026-11-24T04:59:00Z', 'Overnight', 65)]);
  });
  try {
    const page = await withEnv(() => getOlderHistory(new URLSearchParams({
      market: 'us', symbol: 'SOXS', interval: '1m', source, adjustment, before: String(before), limit: '500',
    })));
    assert.equal(page.status, 'more');
    assert.deepEqual(ends, ['2026-11-24', '2026-11-23']);
    assert.equal(page.candles.length, 1);
    assert.equal(page.candles[0].session, 'overnight');

    const emptyStarts: string[] = [];
    setLongbridgeRunner(async args => {
      emptyStarts.push(`${args[args.indexOf('--start') + 1]}..${args[args.indexOf('--end') + 1]}`);
      return '[]';
    });
    const ended = await withEnv(() => getOlderHistory(new URLSearchParams({
      market: 'us', symbol: 'SOXS', interval: '1m', source, adjustment, before: String(before), limit: '500',
    })));
    assert.equal(ended.status, 'end');
    assert.equal(emptyStarts.length, 4);

    delete process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE;
    const unsupported = await getOlderHistory(new URLSearchParams({
      market: 'us', symbol: 'SOXS', interval: '1m', source, adjustment, before: String(before), limit: '500',
    }));
    assert.equal(unsupported.status, 'unsupported');
    assert.deepEqual(unsupported.candles, []);
  } finally { resetMarketNetworkFailures(); setLongbridgeRunnerDefault(); }
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

test('kline history 301607 with limit:0 marks history unsupported without affecting live kline', async () => {
  const source = 'Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com';
  const adjustment = '不复权（原始价格）；成交量单位：股';
  const before = Date.parse('2026-11-24T14:30:00Z') / 1000;
  let historyCalls = 0;
  let klineCalls = 0;
  setLongbridgeRunner(async args => {
    if (args[0] === 'static') return JSON.stringify([{ symbol: 'QQQ.US', name: 'Invesco QQQ', exchange: 'NASD', currency: 'USD' }]);
    if (args[0] === 'kline' && args[1] === 'history') {
      historyCalls++;
      throw Object.assign(new Error('kline history failed'), {
        stdout: JSON.stringify({ error: { code: 301607, message: 'history candlestick symbol count out of limit, requested:0/limit:0' } }),
        stderr: '',
      });
    }
    klineCalls++;
    return JSON.stringify(Array.from({ length: 12 }, (_, i) => cliRow(`2026-11-23T09:${String(i).padStart(2, '0')}:00Z`, 'Pre', 500 + i)));
  });
  const restoreFetch = failOtherSources();
  try {
    await withEnv(async () => {
      const first = await getOlderHistory(new URLSearchParams({
        market: 'us', symbol: 'QQQ', interval: '1m', source, adjustment, before: String(before), limit: '500',
      }));
      assert.equal(first.status, 'unsupported');
      assert.deepEqual(first.candles, []);
      assert.equal(historyCalls, 1);

      const second = await getOlderHistory(new URLSearchParams({
        market: 'us', symbol: 'SPY', interval: '1m', source, adjustment, before: String(before), limit: '500',
      }));
      assert.equal(second.status, 'unsupported');
      assert.deepEqual(second.candles, []);
      assert.equal(historyCalls, 1, 'unsupported cache must skip repeated CLI spawns');

      const live = await getCandles('us', 'QQQ', '1m', 100);
      assert.ok(live.source.includes('Longbridge'));
      assert.equal(live.candles.length, 12);
      assert.equal(klineCalls, 1);

      resetMarketNetworkFailures();
      const afterReset = await getOlderHistory(new URLSearchParams({
        market: 'us', symbol: 'QQQ', interval: '1m', source, adjustment, before: String(before), limit: '500',
      }));
      assert.equal(afterReset.status, 'unsupported');
      assert.equal(historyCalls, 2, 'resetMarketNetworkFailures clears history unsupported cache');
    });
  } finally { restoreFetch(); resetMarketNetworkFailures(); setLongbridgeRunnerDefault(); }
});

test('kline history quota exhaustion and transient errors isolate history cooldown from live kline', async () => {
  const source = 'Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com';
  const adjustment = '不复权（原始价格）；成交量单位：股';
  const before = Date.parse('2026-11-24T14:30:00Z') / 1000;
  let historyCalls = 0;
  let klineCalls = 0;
  let mode: 'quota' | 'transient' = 'quota';
  setLongbridgeRunner(async args => {
    if (args[0] === 'static') return JSON.stringify([{ symbol: `${args[1]}`, name: 'Test Equity', exchange: 'NASD', currency: 'USD' }]);
    if (args[0] === 'kline' && args[1] === 'history') {
      historyCalls++;
      if (mode === 'quota') {
        throw Object.assign(new Error('kline history quota'), {
          stdout: JSON.stringify({ error: { code: 301607, message: 'history candlestick symbol count out of limit, requested:100/limit:100' } }),
          stderr: '',
        });
      }
      throw Object.assign(new Error('kline history failed'), { stdout: '', stderr: 'Error: history backend timeout' });
    }
    klineCalls++;
    return JSON.stringify(Array.from({ length: 12 }, (_, i) => cliRow(`2026-11-23T09:${String(i).padStart(2, '0')}:00Z`, 'Pre', 120 + i)));
  });
  const restoreFetch = failOtherSources();
  try {
    await withEnv(async () => {
      await assert.rejects(
        getOlderHistory(new URLSearchParams({
          market: 'us', symbol: 'AMD', interval: '1m', source, adjustment, before: String(before), limit: '500',
        })),
        error => error instanceof MarketError && error.status === 503 && error.code === 301607 && /额度不足/.test(error.message),
      );
      assert.equal(historyCalls, 1);

      await assert.rejects(
        getOlderHistory(new URLSearchParams({
          market: 'us', symbol: 'AMD', interval: '1m', source, adjustment, before: String(before - 60), limit: '500',
        })),
        /历史K线接口暂时不可用/,
      );
      assert.equal(historyCalls, 1, 'history cooldown must skip repeated CLI spawns');

      const liveQuota = await getCandles('us', 'AMD', '1m', 100);
      assert.ok(liveQuota.source.includes('Longbridge'));
      assert.equal(klineCalls, 1);

      resetMarketNetworkFailures();
      mode = 'transient';
      await assert.rejects(
        getOlderHistory(new URLSearchParams({
          market: 'us', symbol: 'COIN', interval: '1m', source, adjustment, before: String(before), limit: '500',
        })),
        error => error instanceof MarketError && error.status === 502,
      );
      assert.equal(historyCalls, 2);

      await assert.rejects(
        getOlderHistory(new URLSearchParams({
          market: 'us', symbol: 'COIN', interval: '1m', source, adjustment, before: String(before - 60), limit: '500',
        })),
        /历史K线接口暂时不可用/,
      );
      assert.equal(historyCalls, 2);

      const liveTransient = await getCandles('us', 'COIN', '1m', 100);
      assert.ok(liveTransient.source.includes('Longbridge'));
      assert.equal(klineCalls, 2);
    });
  } finally { restoreFetch(); resetMarketNetworkFailures(); setLongbridgeRunnerDefault(); }
});

test('getWorkbenchLiveQuote supports Longbridge all-session quotes, rejects stale extended timestamps, coalesces batches, and isolates 301606', async () => {
  const lbSource = 'Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com';
  const lbAdjustment = '不复权（原始价格）；成交量单位：股';
  const calls: string[][] = [];
  let failQuote429 = false;
  setLongbridgeRunner(async args => {
    calls.push(args);
    if (args[0] === 'static') return JSON.stringify([{ symbol: args[1], name: 'Test Equity', exchange: 'NASD', currency: 'USD' }]);
    if (args[0] === 'quote') {
      if (failQuote429) {
        throw Object.assign(new Error('rate limited'), {
          stdout: JSON.stringify({ error: { code: 301606, message: 'Request rate limit' } }),
          stderr: '',
        });
      }
      const tickers = args.slice(1, args.indexOf('--format'));
      return JSON.stringify(tickers.map(ticker => {
        if (ticker === 'MU.US') {
          return {
            symbol: ticker,
            last: '110.00',
            status: 'Normal',
            pre_market: { last: '108.00', timestamp: '2026-11-20T13:00:00Z' }, // Previous day stale pre_market
          };
        }
        return {
          symbol: ticker,
          last: '150.25',
          status: 'Normal',
          pre_market: { last: '149.10', timestamp: '2026-11-23T13:00:00Z' },
          post_market: { last: '151.40', timestamp: '2026-11-23T22:15:00Z' },
          overnight: { last: '152.00', timestamp: '2026-11-24T01:30:00Z' },
        };
      }));
    }
    return JSON.stringify(Array.from({ length: 12 }, (_, i) => cliRow(`2026-11-23T09:${String(i).padStart(2, '0')}:00Z`, 'Pre', 200 + i)));
  });
  const restoreFetch = failOtherSources();
  try {
    await withEnv(async () => {
      const makeParams = (symbol: string) => new URLSearchParams({ market: 'us', symbol, interval: '1m', source: lbSource, adjustment: lbAdjustment });

      const pre = await getWorkbenchLiveQuote(makeParams('PLTR'), Date.parse('2026-11-23T13:05:00Z')) as { status: string; quote?: { price: number; session?: string; provider?: string } };
      assert.equal(pre.status, 'quote');
      assert.equal(pre.quote?.session, 'pre');
      assert.equal(pre.quote?.price, 149.1);
      assert.equal(pre.quote?.provider, 'longbridge');

      const reg = await getWorkbenchLiveQuote(makeParams('AMD'), Date.parse('2026-11-23T15:00:00Z')) as { status: string; quote?: { price: number; session?: string } };
      assert.equal(reg.status, 'quote');
      assert.equal(reg.quote?.session, 'regular');
      assert.equal(reg.quote?.price, 150.25);

      const post = await getWorkbenchLiveQuote(makeParams('SMCI'), Date.parse('2026-11-23T22:20:00Z')) as { status: string; quote?: { price: number; session?: string } };
      assert.equal(post.status, 'quote');
      assert.equal(post.quote?.session, 'post');
      assert.equal(post.quote?.price, 151.4);

      const overnight = await getWorkbenchLiveQuote(makeParams('AVGO'), Date.parse('2026-11-24T02:00:00Z')) as { status: string; quote?: { price: number; session?: string } };
      assert.equal(overnight.status, 'quote');
      assert.equal(overnight.quote?.session, 'overnight');
      assert.equal(overnight.quote?.price, 152.0);

      // Weekend stays closed without spawning CLI
      const beforeClosed = calls.length;
      const closed = await getWorkbenchLiveQuote(makeParams('INTC'), Date.parse('2026-11-21T15:00:00Z')) as { status: string };
      assert.equal(closed.status, 'closed');
      assert.equal(calls.length, beforeClosed);

      // Stale previous-day pre_market timestamp is rejected outside regular session
      const stale = await getWorkbenchLiveQuote(makeParams('MU'), Date.parse('2026-11-23T13:05:00Z')) as { status: string };
      assert.equal(stale.status, 'stale');

      // Concurrent quote calls coalesce into one batched CLI invocation
      const beforeBatch = calls.length;
      const [q1, q2] = await Promise.all([
        getWorkbenchLiveQuote(makeParams('QCOM'), Date.parse('2026-11-24T02:00:00Z')) as Promise<{ status: string; quote?: { price: number } }>,
        getWorkbenchLiveQuote(makeParams('TXN'), Date.parse('2026-11-24T02:00:00Z')) as Promise<{ status: string; quote?: { price: number } }>,
      ]);
      assert.equal(q1.status, 'quote');
      assert.equal(q2.status, 'quote');
      assert.equal(calls.length - beforeBatch, 1);
      assert.deepEqual(calls[beforeBatch], ['quote', 'QCOM.US', 'TXN.US', '--format', 'json']);

      // 301606 rate limit cools down quote only and never disables live kline
      failQuote429 = true;
      const limited = await getWorkbenchLiveQuote(makeParams('NFLX'), Date.parse('2026-11-24T02:00:00Z')) as { status: string };
      assert.equal(limited.status, 'unavailable');
      const liveAfter429 = await getCandles('us', 'NFLX', '1m', 100);
      assert.ok(liveAfter429.source.includes('Longbridge'));
    });
  } finally { restoreFetch(); resetMarketNetworkFailures(); setLongbridgeRunnerDefault(); }
});

function setLongbridgeRunnerDefault() {
  // Subsequent tests default to "CLI absent": the enabled source reports unavailable
  // instead of spawning a real process from the test suite.
  setLongbridgeRunner(async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); });
}
