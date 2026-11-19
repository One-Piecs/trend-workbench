import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarket, parseSearchMarket, searchInstruments } from '../lib/market-data.ts';

function hints(rows: string[]): Response {
  // The real smartbox service escapes Chinese names in an otherwise ASCII response.
  return new Response(`v_hint="${rows.join('^').replace(/[^\x00-\x7F]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`)}"`);
}
const luoyang = 'sh~603993~洛阳钼业~lymy~GP-A';
const cryptoDirectory = {symbols: [
  {symbol:'BTCUSDT', baseAsset:'BTC', quoteAsset:'USDT', status:'TRADING', isSpotTradingAllowed:true},
  {symbol:'ETHUSDT', baseAsset:'ETH', quoteAsset:'USDT', status:'TRADING', isSpotTradingAllowed:true},
]};

test('all is accepted only for search; missing search market defaults to all', () => {
  assert.equal(parseSearchMarket(null),'all');
  assert.equal(parseSearchMarket('all'),'all');
  assert.equal(parseSearchMarket('cn'),'cn');
  assert.throws(() => parseSearchMarket('anything'));
  assert.throws(() => parseMarket('all'));
});

test('global search finds an unpreset A-share by Chinese name, pinyin and qualified codes', async () => {
  const original=globalThis.fetch, queries:string[]=[];
  globalThis.fetch=async input => {
    const url=new URL(String(input));
    if (url.pathname.includes('exchangeInfo')) return Response.json(cryptoDirectory);
    if (url.hostname.includes('yahoo')) return Response.json({quotes:[]});
    if (url.hostname==='smartbox.gtimg.cn') {
      if (url.searchParams.get('t')==='us') return hints([]);
      const q=url.searchParams.get('q')!;queries.push(q);
      return hints(['hk~03993~洛阳钼业~lymy~GP-HK', 'sh~600000~洛阳钼业相关名称~test~GP-A',luoyang,luoyang]);
    }
    return new Response('offline',{status:503});
  };
  try {
    for (const q of ['洛阳钼业','603993','603993.SH','sh603993','lymy','luoyangmuye']) {
      const result=await searchInstruments('all',q);
      const hits=result.results.filter(row=>row.symbol==='603993.SH');
      assert.equal(hits.length,1,q);
      assert.equal(hits[0].name,'洛阳钼业');
      assert.equal(hits[0].market,'cn');
      assert.equal(hits[0].exchange,'上交所');
      assert.equal(hits[0].currency,'CNY');
      assert.ok(result.results.every(row=>row.market==='cn'));
      if (!['lymy','luoyangmuye'].includes(q)) assert.equal(result.results[0].symbol,'603993.SH');
    }
    assert.ok(queries.includes('lymy'));
    assert.ok(queries.includes('luoyangmuye'));
    assert.equal(queries.filter(q=>q==='603993').length,3);
    assert.ok(!queries.includes('603993.SH'));
  } finally { globalThis.fetch=original; }
});

test('Chinese crypto names remain crypto results in global search', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=async input => {
    const url=new URL(String(input));
    if (url.pathname.includes('exchangeInfo')) return Response.json(cryptoDirectory);
    if (url.hostname.includes('yahoo')) return Response.json({quotes:[]});
    if (url.hostname==='smartbox.gtimg.cn') return hints([]);
    return new Response('offline',{status:503});
  };
  try {
    for (const [q,symbol] of [['比特币','BTCUSDT'],['以太坊','ETHUSDT']]) {
      const result=await searchInstruments('all',q);
      assert.equal(result.results[0]?.symbol,symbol);
      assert.equal(result.results[0]?.market,'crypto');
    }
  } finally {globalThis.fetch=original;}
});

test('one failed market cannot remove valid matches from another market',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async input=>{
    const url=new URL(String(input));
    if(url.hostname==='smartbox.gtimg.cn'&&url.searchParams.get('t')==='gp') return hints(['sh~601899~紫金矿业~zjky~GP-A']);
    return new Response('unavailable',{status:503});
  };
  try {
    const result=await searchInstruments('all','紫金矿业');
    assert.equal(result.results[0]?.symbol,'601899.SH');
    assert.match(result.warning||'',/美股/);
    assert.equal(result.results[0]?.name,'紫金矿业');
  } finally {globalThis.fetch=original;}
});

test('an explicit market filter does not silently cross markets',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async input=>String(input).includes('exchangeInfo') ? Response.json(cryptoDirectory) : new Response('offline',{status:503});
  try {
    const result=await searchInstruments('crypto','洛阳钼业');
    assert.equal(result.results.length,0);
  } finally {globalThis.fetch=original;}
});
