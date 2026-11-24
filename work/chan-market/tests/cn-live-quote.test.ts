import assert from 'node:assert/strict';
import test from 'node:test';
import { getChinaLiveQuote } from '../lib/cn-live-quote.ts';

const eventMs = Date.parse('2026-11-20T10:02:12+08:00');
const session = { open: 1450.89, high: 1489.09, low: 1423.9, close: 1485.75, volume: 6722900 };
const adjustment = '不复权（原始价格）；成交量单位：股';
function tencent(ticker = 'sh600519', stamp = '20261120100212', override: Record<number, string> = {}) {
  const r = Array<string>(55).fill('');
  Object.assign(r, { 2: ticker.slice(2), 3: '1485.75', 5: '1450.89', 6: '67229',
    30: stamp, 33: '1489.09', 34: '1423.90', ...override });
  return new Response(`v_${ticker}="${r.join('~')}";`);
}
function eastmoney(time = eventMs / 1000, override = {}) {
  return Response.json({ rc: 0, data: { f43: 148575, f44: 148909, f45: 142390, f46: 145089,
    f47: 67229, f57: '600519', f59: 2, f86: time, ...override } });
}

test('CNY quotes use the source clock and share volume on all three mainland venues', async () => {
  for (const [symbol, ticker, venue] of [['600519.SH', 'sh600519', 'XSHG'], ['000001.SZ', 'sz000001', 'XSHE'], ['920599.BJ', 'bj920599', 'BJSE']]) {
    const quote = await getChinaLiveQuote(symbol, async url => {
      assert.equal(String(url), 'https://qt.gtimg.cn/q=' + ticker);
      return tencent(ticker);
    }, eventMs + 10000);
    assert.deepEqual(quote, { market: 'cn', symbol, venue, provider: 'tencent', currency: 'CNY', price: session.close,
      time: eventMs / 1000, sessionBar: session });
  }
});

test('stale or mismatched public quote falls through to the independent unadjusted quote', async () => {
  for (const bad of [() => tencent('sz000001'), () => tencent('sh600519', '20261120095100'), () => tencent('sh600519', '20261120100250'),
    () => tencent('sh600519', '20261120100212', {6:'0'}), () => new Response('', {status:429})]) {
    const quote = await getChinaLiveQuote('600519.SH', async url => String(url).includes('gtimg') ? bad() : eastmoney(), eventMs);
    assert.equal(quote?.provider, 'eastmoney');
    assert.deepEqual(quote?.sessionBar, session);
  }
});

test('non-trading sessions, unsupported currencies and unverified codes cause no network reads', async () => {
  let reads = 0;
  const unused = async () => { reads++; return tencent(); };
  for (const stamp of ['2026-11-21T10:02:12+08:00','2026-11-20T12:02:12+08:00','2026-11-20T15:30:12+08:00',
    '2026-10-01T10:02:12+08:00','2027-11-19T10:02:12+08:00']) {
    assert.equal(await getChinaLiveQuote('600519.SH', unused, Date.parse(stamp)), null);
  }
  for (const symbol of ['600519.SZ','200002.SZ','900901.SH','000001.SH','../../url']) {
    assert.equal(await getChinaLiveQuote(symbol, unused, eventMs), null);
  }
  assert.equal(reads, 0);
});

test('stale, invalid and suspended quotes stay unavailable; transport failure is distinguishable', async () => {
  const stale = async (url: RequestInfo | URL) => String(url).includes('gtimg') ? tencent('sh600519', '20261119100212') : eastmoney(eventMs / 1000 - 60);
  assert.equal(await getChinaLiveQuote('600519.SH', stale, eventMs), null);
  const invalid = async (url: RequestInfo | URL) => String(url).includes('gtimg') ? tencent('sh600519', '20261120100212', {5:'0'}) : eastmoney(eventMs / 1000, {f47:0});
  assert.equal(await getChinaLiveQuote('600519.SH', invalid, eventMs), null);
  await assert.rejects(getChinaLiveQuote('600519.SH', async () => { throw Error('network'); }, eventMs), /无法连接/);
});

test('native source-specific 5m bars retain true OHLC, Shanghai end stamps and correct volume units', async () => {
  const native = { start: Date.parse('2026-11-20T10:00:00+08:00') / 1000, end: Date.parse('2026-11-20T10:05:00+08:00') / 1000,
    interval:'5m', open:1480, close:1485.75, high:1487, low:1479.5, volume:54300 };
  const feeds: [string, (url: string) => Response][] = [
    ['东方财富 网页行情 · push2his.eastmoney.com', url => url.includes('push2his.') ? Response.json({ data: { code:'600519',market:1,
      klines:['2026-11-20 10:05,1480,1485.75,1487,1479.50,543'] } }) : eastmoney()],
    ['腾讯证券 K线（独立备用） · ifzq.gtimg.cn', url => url.includes('ifzq') ? Response.json({ code:0,data:{ sh600519:{ m5:[
      ['202611201005','1480','1485.75','1487','1479.50','543'] ] } } }) : tencent()],
    ['新浪财经 OHLC（独立备用） · quotes.sina.cn', url => url.includes('sina') ? new Response(
      'var _data=([{"day":"2026-11-20 10:05:00","open":"1480","close":"1485.75","high":"1487","low":"1479.50","volume":"54300"}]);') : tencent()],
  ];
  for (const [source, read] of feeds) {
    const quote = await getChinaLiveQuote('600519.SH', async url => read(String(url)), eventMs, { interval:'5m', source, adjustment });
    const provider = source.includes('gtimg') ? 'tencent' : source.includes('sina') ? 'sina' : 'eastmoney';
    assert.deepEqual(quote?.bar, { ...native, provider, ...(provider === 'tencent' && { priceBasis:'tencent-minute-native' }) }, source);
  }
});

test('stale interval / different close / impossible high or volume never invents an accurate intraday bar', async () => {
  for (const r of [['1000',1485.75,1487,12],['1005',1480,1487,12],['1005',1485.75,1490,12],['1005',1485.75,1487,99999]]) {
    const fetcher = async (url: RequestInfo | URL) => String(url).includes('ifzq') ? Response.json({ code:0,data:{ sh600519:{ m5:[
      ['20261120'+r[0],1480,r[1],r[2],1479.50,r[3]] ] } } }) : tencent();
    const q = await getChinaLiveQuote('600519.SH', fetcher, eventMs, {interval:'5m',source:'ifzq.gtimg.cn',adjustment});
    assert.equal(q?.price, session.close);
    assert.equal(q?.bar, undefined);
  }
});

test('weekly and monthly bars use every completed session once and replace today with the fresh cumulative snapshot', async () => {
  // Monday 2026-11-02 through Friday 11-20, skipping all weekends.
  const days = [2,3,4,5,6,9,10,11,12,13,16,17,18,19,20];
  const rows = days.map(day => `2026-11-${String(day).padStart(2,'0')},1440,1450,1460,1430,100`);
  for (const interval of ['1w','1M'] as const) {
    const read = (data: string[]) => async (url: RequestInfo | URL) => String(url).includes('push2his.') ?
      Response.json({ data: { code:'600519',market:1,klines:data } }) : eastmoney();
    const source = '东方财富 网页行情 · push2his.eastmoney.com';
    const quote = await getChinaLiveQuote('600519.SH', read(rows), eventMs, { source, interval, adjustment });
    assert.equal(quote?.bar?.volume, session.volume + (interval === '1w' ? 4 : 14) * 10000);
    assert.equal(quote?.bar?.open, 1440);
    assert.equal(quote?.bar?.close, session.close);
    const incomplete = rows.filter(row => !row.startsWith('2026-11-18'));
    const missing = await getChinaLiveQuote('600519.SH', read(incomplete), eventMs, { source, interval, adjustment });
    assert.equal(missing?.bar, undefined);
    assert.equal(missing?.price, session.close);
  }
});
