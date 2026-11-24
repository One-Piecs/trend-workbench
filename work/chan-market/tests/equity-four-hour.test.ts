import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateEquityFourHour } from '../lib/equity-four-hour.ts';
import { getCandles } from '../lib/market-data.ts';
import { translateMarketText } from '../lib/market-i18n.ts';
import type { Candle } from '../lib/market-types';

const time = (stamp: string) => Date.parse(stamp) / 1000;
const cnEnds = ['10:00','10:30','11:00','11:30','13:30','14:00','14:30','15:00'];
const cnHourEnds = ['10:30','11:30','14:00','15:00'];
const usStarts = ['09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30'];
const usHours = ['09:30','10:30','11:30','12:30','13:30','14:30','15:30'];
function day(date: string, stamps: string[], offset: string): Candle[] {
  return stamps.map((stamp, i) => ({ time: time(`${date}T${stamp}:00${offset}`), open: 100+i, high: 102+i, low: 99+i, close: 101+i, volume: 10+i, closed: true }));
}
const later = time('2026-12-01T00:00:00Z');

test('A-share 4H covers both sessions, excludes lunch/weekend, and preserves genuine OHLCV', () => {
  const rows = day('2026-11-12',cnEnds,'+08:00');
  const result = aggregateEquityFourHour([...rows, ...day('2026-11-14',cnEnds,'+08:00'), ...day('2026-11-12',['12:00'],'+08:00')], { market:'cn',sourceInterval:'30m',timestamp:'end',now:later });
  assert.equal(result.candles.length,1);
  assert.deepEqual(result.candles[0],{ time:time('2026-11-12T09:30:00+08:00'),open:100,high:109,low:99,close:108,volume:108,closed:true });
  assert.equal(result.excludedRows,9);
});

test('US 4H keeps the 2.5-hour final segment separate and respects NY DST', () => {
  const rows = [...day('2026-10-30',usStarts,'-04:00'), ...day('2026-11-02',usStarts,'-05:00')];
  const result = aggregateEquityFourHour(rows,{ market:'us',sourceInterval:'30m',timestamp:'start',now:later });
  assert.equal(result.candles.length,4);
  assert.deepEqual(result.candles.map(c=>c.time),[
    time('2026-10-30T09:30:00-04:00'),time('2026-10-30T13:30:00-04:00'),
    time('2026-11-02T09:30:00-05:00'),time('2026-11-02T13:30:00-05:00'),
  ]);
  assert.equal(result.candles[0].volume,108);
  assert.equal(result.candles[1].volume,100);
  assert.ok(result.candles.every(c=>c.closed));
});

test('start-stamped and end-stamped providers aggregate into identical prices and start timestamps', () => {
  const starts = day('2026-11-12',usStarts,'-05:00');
  const ends = starts.map(c=>({...c,time:c.time+1800}));
  const first = aggregateEquityFourHour(starts,{market:'us',sourceInterval:'30m',timestamp:'start',now:later});
  const second = aggregateEquityFourHour(ends,{market:'us',sourceInterval:'30m',timestamp:'end',now:later});
  assert.deepEqual(first,second);
});

test('retention-edge and internal gaps are omitted without crossing into the following day', () => {
  const rows = [...day('2026-11-10',cnEnds,'+08:00').slice(1), ...day('2026-11-11',cnEnds,'+08:00').filter((_,i)=>i!==4), ...day('2026-11-12',cnEnds,'+08:00')];
  const result = aggregateEquityFourHour(rows,{market:'cn',sourceInterval:'30m',timestamp:'end',now:later});
  assert.equal(result.candles.length,1);
  assert.equal(result.discardedBuckets,2);
  assert.equal(result.candles[0].time,time('2026-11-12T09:30:00+08:00'));
});

test('current continuous partial session remains unclosed; missing current slots do not produce candles', () => {
  const rows = day('2026-11-13',cnEnds,'+08:00');
  const options = {market:'cn',sourceInterval:'30m',timestamp:'end',now:time('2026-11-13T14:10:00+08:00')} as const;
  const partial = aggregateEquityFourHour(rows.slice(0,6),options);
  assert.equal(partial.candles.length,1);
  assert.equal(partial.candles[0].closed,false);
  assert.equal(aggregateEquityFourHour(rows.slice(0,6).filter((_,i)=>i!==2),options).candles.length,0);
  const full = aggregateEquityFourHour(rows.map((c,i)=>({...c,closed:i!==7})),{...options,now:later});
  assert.equal(full.candles[0].closed,false);
});

test('US hourly bars cover the scheduled morning even if an ordinary afternoon is absent', () => {
  const ordinary = day('2026-11-12',usHours,'-05:00');
  const halfDay = day('2026-11-13',usHours.slice(0,4),'-05:00');
  const result = aggregateEquityFourHour([...ordinary,...halfDay],{market:'us',sourceInterval:'1h',timestamp:'start',now:later});
  assert.equal(result.candles.length,3);
  assert.equal(result.candles[1].volume,45);
  assert.equal(result.discardedBuckets,0); // The absent final tail is outside the returned source window.
  assert.ok(result.candles.every(c=>c.closed));
  const ongoing = aggregateEquityFourHour(halfDay,{market:'us',sourceInterval:'1h',timestamp:'start',now:time('2026-11-13T14:00:00-05:00')});
  assert.equal(ongoing.candles[0].closed,true);
});

test('the seven observed half-hours on Black Friday form one 3.5-hour candle', () => {
  const result = aggregateEquityFourHour(day('2026-11-27',usStarts.slice(0,7),'-05:00'),{market:'us',sourceInterval:'30m',timestamp:'start',now:later});
  assert.equal(result.candles.length,1);
  assert.equal(result.candles[0].closed,true);
  assert.equal(result.candles[0].volume,91);
  assert.equal(result.discardedBuckets,0);
});

test('ordinary missing sessions are counted without inferring a halt or counting a holiday',()=>{
  const options={market:'us',sourceInterval:'1h',timestamp:'start',now:later} as const;
  const rows=[...day('2026-11-24',usHours,'-05:00'),...day('2026-11-27',usHours.slice(0,4),'-05:00')];
  const result=aggregateEquityFourHour(rows,options);
  assert.equal(result.missingSessions,1); // Wednesday missing, Thursday Thanksgiving.
  assert.equal(result.discardedBuckets,2);
  assert.equal(result.candles.length,3);
  const extra=aggregateEquityFourHour([...rows,...day('2026-11-27',['13:30','14:30'],'-05:00')],options);
  assert.equal(extra.excludedRows,2);assert.deepEqual(extra.candles,result.candles);
});

test('instantaneous Yahoo quote, malformed prices, and off-grid data cannot contaminate OHLC', () => {
  const rows = day('2026-11-12',usStarts,'-05:00');
  const result = aggregateEquityFourHour([...rows,{...rows[0],time:rows[0].time+61,high:9999},{...rows[0],time:time('2026-11-12T16:00:00-05:00'),high:9999}],{market:'us',sourceInterval:'30m',timestamp:'start',now:later});
  assert.equal(result.excludedRows,2);
  assert.equal(result.candles[0].high,109);
  assert.equal(aggregateEquityFourHour(rows.map((c,i)=>i===3?{...c,low:NaN}:c),{market:'us',sourceInterval:'30m',timestamp:'start',now:later}).candles.length,1);
});

test('US adapter requests deeper hourly history, returns true 4H and explicit short-session-tail metadata', async () => {
  const original = globalThis.fetch, urls:string[]=[];
  const rows = [...day('2026-11-10',usHours,'-05:00'),...day('2026-11-11',usHours,'-05:00')];
  globalThis.fetch = async input => {
    const url=String(input);urls.push(url);
    if(!url.includes('yahoo'))return new Response('Independent backup unavailable',{status:503});
    return new Response(JSON.stringify({chart:{result:[{meta:{dataGranularity:'60m',exchangeTimezoneName:'America/New_York'},timestamp:rows.map(c=>c.time),indicators:{quote:[{open:rows.map(c=>c.open),high:rows.map(c=>c.high),low:rows.map(c=>c.low),close:rows.map(c=>c.close),volume:rows.map(c=>c.volume)}]}}]}}));
  };
  try {
    const data = await getCandles('us','FOURHOURTEST','4h',100);
    assert.equal(data.interval,'4h');
    assert.equal(data.candles.length,4);
    assert.ok(data.availableIntervals.includes('4h'));
    assert.ok(data.source.includes('1小时聚合4小时'));
    assert.ok(data.warnings.some(w=>w.includes('2.5小时')));
    const yahooUrls=urls.filter(url=>url.includes('yahoo'));
    assert.ok(yahooUrls.length>0&&yahooUrls.every(url=>url.includes('interval=60m&range=2y')));
    assert.ok(urls.some(url=>!url.includes('yahoo')),'short primary history still checks independent alternatives');
    assert.ok(data.source.startsWith('Yahoo'),'failed backup cannot contaminate the chosen source');
    for (const text of [data.source,data.delayNotice,data.adjustment,...data.warnings]) assert.doesNotMatch(translateMarketText(text,'en'),/could not be translated|\p{Script=Han}/u);
  } finally { globalThis.fetch=original; }
});

test('CN adapter takes one longer real hourly source, skips its truncated first day, and reports session boundaries', async () => {
  const original = globalThis.fetch, urls:string[]=[];
  const stamps = ['2026-11-10','2026-11-11','2026-11-12'];
  const rows = stamps.flatMap(date=>cnHourEnds.map(stamp=>({day:`${date} ${stamp}:00`,open:'10',high:'12',low:'9',close:'11',volume:'123'}))).slice(1);
  globalThis.fetch = async input => {const url=String(input);urls.push(url);return url.includes('sina.cn')?new Response(`var _data=(${JSON.stringify(rows)});`):new Response('Backup unavailable',{status:503});};
  try {
    const data = await getCandles('cn','603993.SH','4h',800);
    assert.equal(data.interval,'4h');
    assert.equal(data.candles.length,2);
    assert.equal(data.candles[0].volume,492);
    assert.ok(data.source.includes('新浪'));
    assert.ok(data.source.includes('1小时聚合4小时'));
    assert.ok(data.warnings.some(w=>w.includes('每个交易日一根')));
    assert.ok(urls[0].includes('scale=60&ma=no&datalen=1023'));
    assert.equal(urls.filter(url=>url.includes('sina.cn')).length,1);
    assert.equal(data.candles[0].time,time('2026-11-11T09:30:00+08:00'));
    for (const text of [data.source,data.delayNotice,data.adjustment,...data.warnings]) assert.doesNotMatch(translateMarketText(text,'en'),/could not be translated|\p{Script=Han}/u);
  } finally { globalThis.fetch=original; }
});

test('US 4H fallback aggregates end-stamped half-hours after provider denial without mixing sources', async () => {
  const original = globalThis.fetch, urls:string[]=[];
  const rows = [...day('2026-11-10',usStarts,'-05:00'),...day('2026-11-11',usStarts,'-05:00')];
  const klines = rows.map(c => {
    const shanghai = new Date((c.time+1800+8*3600)*1000).toISOString().slice(0,16).replace('T',' ');
    return `${shanghai},${c.open},${c.close},${c.high},${c.low},${c.volume}`;
  });
  globalThis.fetch = async input => {
    const url=String(input);urls.push(url);
    if(url.includes('yahoo'))return new Response('Denied',{status:403});
    if(url.includes('smartbox'))return new Response('v_hint="us~fourfallback.oq~Four Fallback~four fallback~GP"');
    return new Response(JSON.stringify({data:{code:'FOURFALLBACK',market:105,name:'Four Fallback',klines}}));
  };
  try {
    const data=await getCandles('us','FOURFALLBACK','4h',100);
    assert.equal(data.candles.length,3); // First provider row was already discarded as a retention edge.
    assert.equal(data.candles[0].time,time('2026-11-10T13:30:00-05:00'));
    assert.equal(data.candles[1].time,time('2026-11-11T09:30:00-05:00'));
    assert.equal(data.candles[1].volume,108);
    assert.ok(data.source.includes('东方财富'));
    assert.ok(data.source.includes('30分钟聚合4小时'));
    assert.ok(urls.some(url=>url.includes('klt=30&')));
    assert.equal(urls.filter(url=>url.includes('yahoo')).length,1);
    for (const text of [data.source,data.delayNotice,data.adjustment,...data.warnings]) assert.doesNotMatch(translateMarketText(text,'en'),/could not be translated|\p{Script=Han}/u);
  } finally { globalThis.fetch=original; }
});

test('CN 4H falls back as one complete source when the longer-history feed is unavailable', async () => {
  const original=globalThis.fetch,urls:string[]=[];
  const klines=['2026-11-10','2026-11-11','2026-11-12'].flatMap(date=>cnHourEnds.map(stamp=>`${date} ${stamp},10,11,12,9,123`));
  globalThis.fetch=async input=>{
    const url=String(input);urls.push(url);
    if(!url.includes('eastmoney.com'))return new Response('Unavailable',{status:503});
    return new Response(JSON.stringify({data:{code:'600999',market:1,name:'China test',klines}}));
  };
  try {
    const data=await getCandles('cn','600999.SH','4h',100);
    assert.equal(data.candles.length,3);
    assert.equal(data.candles[0].volume,49200);
    assert.ok(data.source.includes('东方财富'));
    assert.ok(urls.some(url=>url.includes('klt=60&')));
    for (const text of [data.source,data.delayNotice,data.adjustment,...data.warnings]) assert.doesNotMatch(translateMarketText(text,'en'),/could not be translated|\p{Script=Han}/u);
  } finally { globalThis.fetch=original; }
});
