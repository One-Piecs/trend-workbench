import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarket, parseInterval, normalizeSymbol, sanitizeCandles, stockBarClosed, getCandles, searchInstruments, aggregateChinaCalendar, normalizeYahooMonthlyCandles, normalizeYahooWeeklyCandles, validateYahooGranularity } from '../lib/market-data.ts';

test('market and interval allowlists reject arbitrary routing',()=>{
  assert.throws(()=>parseMarket('https://evil.example'));
  assert.throws(()=>parseInterval('3d','crypto'));
  assert.equal(parseInterval('4h','crypto'),'4h');
  for (const market of ['crypto','us','cn'] as const) {
    assert.equal(parseInterval('4h',market),'4h');
    assert.equal(parseInterval('1m',market),'1m');
    assert.equal(parseInterval('1M',market),'1M');
  }
});
test('symbols retain exchange identity and reject query injection',()=>{
  assert.equal(normalizeSymbol('cn','600519'),'600519.SH');
  assert.equal(normalizeSymbol('cn','000001'),'000001.SZ');
  assert.equal(normalizeSymbol('cn','920599'),'920599.BJ');
  assert.equal(normalizeSymbol('cn','sh000001'),'000001.SH');
  assert.equal(normalizeSymbol('crypto','btc/usdt'),'BTCUSDT');
  assert.equal(normalizeSymbol('us','brk-b'),'BRK-B');
  assert.equal(normalizeSymbol('us','brk.b'),'BRK-B');
  assert.throws(()=>normalizeSymbol('us','AAPL?foo=1'));
  assert.throws(()=>normalizeSymbol('cn','sh600519.sz'));
  assert.throws(()=>normalizeSymbol('cn','920599.SZ'));
  assert.throws(()=>normalizeSymbol('cn','600519.SZ'));
  assert.throws(()=>normalizeSymbol('us','600519.SS'));
});
test('OHLC sanitizer sorts, deduplicates, rejects null-range and malformed values',()=>{
  const valid={time:2,open:10,close:11,high:12,low:9,volume:5};
  const data=sanitizeCandles([valid,{...valid,time:1},{...valid,time:1,volume:8},{...valid,time:3,high:10},{...valid,time:4,close:NaN}]);
  assert.deepEqual(data.map(x=>x.time),[1,2]);
  assert.equal(data[0].volume,8);
});
test('CN end-stamped minute candles require close plus safety window',()=>{
  const end=Date.parse('2026-11-13T10:30:00+08:00')/1000;
  assert.equal(stockBarClosed(end,'1h','cn',end-60),false);
  assert.equal(stockBarClosed(end,'1h','cn',end+121),true);
});
test('NY DST and shortened final hourly bar use session end',()=>{
  const winter=Date.parse('2026-11-12T15:30:00-05:00')/1000;
  const summer=Date.parse('2026-07-09T15:30:00-04:00')/1000;
  for(const t of [winter,summer]){
    assert.equal(stockBarClosed(t,'1h','us',t+30*60+14*60),false);
    assert.equal(stockBarClosed(t,'1h','us',t+30*60+16*60),true);
  }
});
test('daily and weekly bars stay open until the local session/week completes',()=>{
  const monday=Date.parse('2026-11-09T09:30:00+08:00')/1000;
  assert.equal(stockBarClosed(monday,'1w','cn',Date.parse('2026-11-12T16:00:00+08:00')/1000),false);
  assert.equal(stockBarClosed(monday,'1w','cn',Date.parse('2026-11-13T15:03:00+08:00')/1000),true);
  const usDay=Date.parse('2026-11-13T09:30:00-05:00')/1000;
  assert.equal(stockBarClosed(usDay,'1d','us',Date.parse('2026-11-13T16:10:00-05:00')/1000),false);
});
test('monthly confirmation uses exchange-local calendar months, including leap years',()=>{
  const cn = Date.parse('2024-02-01T09:30:00+08:00')/1000;
  assert.equal(stockBarClosed(cn,'1M','cn',Date.parse('2024-02-29T23:59:59+08:00')/1000),false);
  assert.equal(stockBarClosed(cn,'1M','cn',Date.parse('2024-03-01T00:00:00+08:00')/1000),true);
  const us = Date.parse('2026-10-01T09:30:00-04:00')/1000;
  // UTC is already November while the US exchange remains in October.
  assert.equal(stockBarClosed(us,'1M','us',Date.parse('2026-11-01T02:00:00Z')/1000),false);
  assert.equal(stockBarClosed(us,'1M','us',Date.parse('2026-11-01T04:00:00Z')/1000),true);
});
test('Yahoo requests true 1-minute and calendar-month periods with matching ranges',async()=>{
  const original=globalThis.fetch, urls:string[]=[];
  globalThis.fetch=async input=>{
    const url=String(input);urls.push(url);
    const monthly=url.includes('interval=1mo');
    const timestamps=Array.from({length:20},(_,i)=>monthly?Date.UTC(2023,i,1,14,30)/1000:Date.parse('2026-11-12T09:30:00-05:00')/1000+i*60);
    return new Response(JSON.stringify({chart:{result:[{meta:{dataGranularity:monthly?'1mo':'1m',exchangeTimezoneName:'America/New_York',currency:'USD'},timestamp:timestamps,indicators:{quote:[{open:timestamps.map(()=>100),high:timestamps.map(()=>102),low:timestamps.map(()=>99),close:timestamps.map(()=>101),volume:timestamps.map(()=>1000)}],adjclose:[{adjclose:timestamps.map(()=>50.5)}]}}]}}));
  };
  try {
    const minute=await getCandles('us','PERIODTEST','1m');
    const month=await getCandles('us','PERIODTEST','1M');
    assert.ok(urls.some(url=>url.includes('interval=1m&range=7d')));
    assert.ok(urls.some(url=>url.includes('interval=1mo&period1=-2208988800&period2=')));
    assert.equal(minute.candles[0].open,100);
    assert.equal(month.candles[0].open,50);
    assert.ok(month.adjustment.includes('调整'));
  } finally {globalThis.fetch=original;}
});
test('Yahoo monthly validation rejects quarterly downsampling and removes appended day quotes',()=>{
  const bar=(date:string,open:number)=>({time:Date.parse(date)/1000,open,high:open+2,low:open-1,close:open+1,volume:123});
  const rows=[bar('2026-10-01T09:30:00-04:00',100),bar('2026-11-01T09:30:00-05:00',110),bar('2026-11-12T16:00:01-05:00',200)];
  assert.throws(()=>normalizeYahooMonthlyCandles(rows,'3mo'),/季度/);
  const monthly=normalizeYahooMonthlyCandles([...rows,rows[1]],'1mo');
  assert.equal(monthly.length,2);
  assert.equal(monthly.at(-1)?.open,110);
});
test('Yahoo validates every requested period and accepts only documented hourly aliases',()=>{
  for(const interval of ['1m','5m','15m','30m','1d'] as const) {
    assert.doesNotThrow(()=>validateYahooGranularity(interval,interval));
    assert.throws(()=>validateYahooGranularity(interval,'3mo'),/周期/);
    assert.throws(()=>validateYahooGranularity(interval,undefined),/未知/);
  }
  assert.doesNotThrow(()=>validateYahooGranularity('1h','60m'));
  assert.doesNotThrow(()=>validateYahooGranularity('1h','1h'));
  assert.throws(()=>validateYahooGranularity('1w','3mo'),/周期/);
});
test('Yahoo weekly validation removes same-week daily quote and preserves full week OHLC',()=>{
  const bar=(date:string,open:number)=>({time:Date.parse(date)/1000,open,high:open+2,low:open-1,close:open+1,volume:123});
  const rows=[bar('2026-11-02T09:30:00-05:00',100),bar('2026-11-09T09:30:00-05:00',110),bar('2026-11-12T16:00:01-05:00',200)];
  assert.throws(()=>normalizeYahooWeeklyCandles(rows,'3mo'),/周期/);
  const weekly=normalizeYahooWeeklyCandles(rows,'1wk');
  assert.equal(weekly.length,2);
  assert.equal(weekly.at(-1)?.open,110);
});
test('A-share minute candles retain real OHLC even with a short opening-session window',async()=>{
  const original=globalThis.fetch, urls:string[]=[];
  globalThis.fetch=async input=>{
    urls.push(String(input));
    return new Response(JSON.stringify({data:{code:'600036',market:1,name:'招商银行',klines:['2026-11-12 09:31,40,40.1,40.2,39.9,123']}}));
  };
  try {
    const result=await getCandles('cn','600036.SH','1m');
    assert.ok(urls[0].includes('klt=1&'));
    assert.equal(result.candles.length,1);
    assert.deepEqual([result.candles[0].open,result.candles[0].high,result.candles[0].low,result.candles[0].close],[40,40.2,39.9,40.1]);
    assert.equal(result.candles[0].volume,12300);
    assert.ok(result.warnings.some(w=>w.includes('一个交易日')));
  } finally {globalThis.fetch=original;}
});
test('A-share monthly adapter uses source month bars and does not mark current month closed',async()=>{
  const original=globalThis.fetch, urls:string[]=[];
  const now=new Date(),current=`${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-01`;
  const klines=Array.from({length:12},(_,i)=>`2024-${String(i+1).padStart(2,'0')}-28,100,101,102,99,123`);
  klines.push(`${current},100,101,102,99,123`);
  globalThis.fetch=async input=>{urls.push(String(input));return new Response(JSON.stringify({data:{code:'600036',market:1,name:'招商银行',klines}}));};
  try {
    const result=await getCandles('cn','600036.SH','1M');
    assert.ok(urls[0].includes('klt=103&'));
    assert.equal(result.candles.at(-1)?.closed,false);
    assert.equal(result.candles[0].closed,true);
  } finally {globalThis.fetch=original;}
});
test('empty provider data is an error, never a synthetic chart',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({chart:{result:[],error:{description:'No data'}}}));
  try { await assert.rejects(()=>getCandles('us','ZZZZNOTREAL','1d'),/未找到/); }
  finally {globalThis.fetch=original;}
});
test('HTTP 404 and an unknown crypto symbol remain errors',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.includes('exchangeInfo'))return new Response(JSON.stringify({symbols:[{symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}]}));
    if(url.includes('okx.com'))return new Response(JSON.stringify({code:'0',data:[{instId:'BTC-USDT',baseCcy:'BTC',quoteCcy:'USDT',state:'live'}]}));
    if(url.includes('kraken.com'))return new Response(JSON.stringify({error:[],result:{XBTUSDT:{altname:'XBTUSDT',wsname:'XBT/USDT',status:'online'}}}));
    return new Response('{}',{status:404});
  };
  try {
    await assert.rejects(()=>getCandles('us','NOEXISTTICKER','1d'),(error: unknown)=>error instanceof Error && 'status' in error && error.status===404);
    await assert.rejects(()=>getCandles('crypto','NOTREALTOKENUSDT','1d'),(error: unknown)=>error instanceof Error && 'status' in error && error.status===404);
  } finally {globalThis.fetch=original;}
});
test('A-share source market must match the requested exchange',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({data:{code:'600519',market:0,klines:[]}}));
  try {await assert.rejects(()=>getCandles('cn','600519.SH','1d'),/未找到/);}
  finally {globalThis.fetch=original;}
});
test('search failure is explicit and preserves direct code identity',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response('failure',{status:503});
  try {
    const result=await searchInstruments('cn','920118');
    assert.ok(result.warning?.includes('暂时不可用'));
    assert.equal(result.results[0].symbol,'920118.BJ');
  } finally {globalThis.fetch=original;}
});
test('US fallback preserves end timestamps, filters extended hours, and caches source denial',async()=>{
  const original=globalThis.fetch;
  let yahooCalls=0;
  const dates=['2026-07-06','2026-07-07','2026-07-08'];
  const klines=dates.flatMap(date=>['16:00','21:30','22:30','23:30'].map(t=>`${date} ${t},100,101,102,99,1234`));
  // Add regular-session end stamps crossing the Shanghai date boundary.
  klines.push(...['2026-07-07','2026-07-08','2026-07-09'].flatMap(date=>['00:30','01:30','02:30','03:30','04:00','05:00'].map(t=>`${date} ${t},100,101,102,99,1234`)));
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.includes('yahoo')) {yahooCalls++;return new Response('Unavailable in region',{status:403});}
    if(url.includes('smartbox')) return new Response('v_hint="us~pltr.oq~Palantir~palantir~GP"');
    return new Response(JSON.stringify({data:{code:'PLTR',market:105,name:'Palantir',klines}}));
  };
  try {
    const result=await getCandles('us','PLTR','1h',100);
    assert.ok(result.source.includes('备用'));
    assert.ok(result.candles.length>=10);
    assert.equal(result.candles.some(c=>c.time===Date.parse('2026-07-07T05:00:00+08:00')/1000),false);
    assert.ok(result.candles.some(c=>c.time===Date.parse('2026-07-07T04:00:00+08:00')/1000));
    assert.equal(result.candles[0].volume,1234);
    await getCandles('us','PLTR','1h',101);
    assert.equal(yahooCalls,1);
  } finally {globalThis.fetch=original;}
});
test('CN aggregates genuine daily OHLC by calendar bucket and drops the retention-edge bucket',()=>{
  const make=(date:string,open:number,high:number,low:number,close:number,volume:number)=>({time:Date.parse(date+'T09:30:00+08:00')/1000,open,high,low,close,volume,closed:true});
  const daily=[make('2026-09-17',10,12,9,11,100),make('2026-10-08',11,15,10,14,200),make('2026-10-30',14,16,12,13,300),make('2026-11-02',13,14,12,13.5,400)];
  const result=aggregateChinaCalendar(daily,'1M',Date.parse('2026-11-13T12:00:00+08:00')/1000);
  assert.equal(result.length,2);
  assert.deepEqual([result[0].open,result[0].high,result[0].low,result[0].close,result[0].volume],[11,16,10,13,500]);
  assert.equal(result[0].closed,true);assert.equal(result[1].closed,false);
});
test('CN HTTP520 switches to independent Tencent unadjusted calendar candles',async()=>{
  const original=globalThis.fetch, urls:string[]=[];
  globalThis.fetch=async input=>{
    const url=String(input);urls.push(url);
    if(url.includes('eastmoney'))return new Response('upstream unavailable',{status:520});
    const day=Array.from({length:15},(_,i)=>[`2026-10-${String(i+1).padStart(2,'0')}`,'20','21','22','19','123']);
    return new Response(JSON.stringify({code:0,data:{sh600900:{day,qt:{sh600900:['1','长江电力','600900']}}}}));
  };
  try {
    const result=await getCandles('cn','600900.SH','1d');
    assert.ok(result.source.includes('腾讯'));
    assert.ok(result.adjustment.includes('不复权'));
    assert.equal(result.candles[0].volume,12300);
    assert.ok(urls.some(url=>url.includes('fqkline')&&url.endsWith(',800,')));
  } finally {globalThis.fetch=original;}
});
test('CN independent Sina minute fallback parses data only and preserves actual OHLC and share volumes',async()=>{
  const original=globalThis.fetch, urls:string[]=[];
  globalThis.fetch=async input=>{
    const url=String(input);urls.push(url);
    if(!url.includes('sina.cn'))return new Response('unavailable',{status:520});
    const rows=Array.from({length:35},(_,i)=>({day:`2026-11-12 10:${String(i).padStart(2,'0')}:00`,open:'10',high:'12',low:'9',close:'11',volume:'123'}));
    return new Response('/* not executed */\nvar _data=('+JSON.stringify(rows)+');');
  };
  try {
    const result=await getCandles('cn','920599.BJ','1m',101);
    assert.ok(result.source.includes('新浪'));
    assert.equal(result.candles.length,35);
    assert.deepEqual([result.candles[0].open,result.candles[0].high,result.candles[0].low,result.candles[0].close,result.candles[0].volume],[10,12,9,11,123]);
    assert.ok(urls.some(url=>url.includes('scale=1&')));
  } finally {globalThis.fetch=original;}
});
test('native Tencent US month adapter preserves real monthly OHLC, NY dates, USD and current-month status',async()=>{
  const original=globalThis.fetch,urls:string[]=[];
  const currentDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const months:unknown[][]=Array.from({length:12},(_,i)=>[`2024-${String(i+1).padStart(2,'0')}-28`,'100','101','102','99','1234']);
  months.push([currentDate,'342.670','354.880','359.370','325.330','482775784']);
  globalThis.fetch=async input=>{
    const url=String(input);urls.push(url);
    if(url.includes('smartbox'))return new Response('v_hint="us~monthtest.oq~Month Test~month test~GP"');
    if(url.includes('fqkline'))return new Response(JSON.stringify({code:0,data:{'usMONTHTEST.OQ':{month:months}}}));
    throw new Error('The native monthly request should not need another data provider');
  };
  try {
    const result=await getCandles('us','MONTHTEST','1M');
    assert.ok(result.source.includes('原生美股月K'));
    assert.equal(result.instrument.currency,'USD');
    assert.equal(result.instrument.exchange,'NASDAQ');
    assert.equal(result.interval,'1M');
    const last=result.candles.at(-1)!;
    assert.deepEqual([last.open,last.high,last.low,last.close,last.volume],[342.67,359.37,325.33,354.88,482775784]);
    assert.equal(last.closed,false);
    assert.equal(result.candles[0].closed,true);
    assert.equal(result.candles[0].time,Date.parse('2024-01-28T09:30:00-05:00')/1000);
    assert.equal(result.candles[6].time,Date.parse('2024-07-28T09:30:00-04:00')/1000);
    const keys=result.candles.map(c=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit'}).format(new Date(c.time*1000)));
    assert.equal(new Set(keys).size,result.candles.length);
    assert.ok(urls.some(url=>url.endsWith('usMONTHTEST.OQ,month,,,800,')));
  } finally {globalThis.fetch=original;}
});
test('native Tencent monthly duplicate is rejected rather than treated as another month',async()=>{
  const original=globalThis.fetch;
  const months=Array.from({length:12},(_,i)=>[`2024-${String(i+1).padStart(2,'0')}-28`,'100','101','102','99','1234']);
  months.push(['2024-12-29','200','201','202','199','500']);
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.includes('smartbox'))return new Response('v_hint="us~dupmonthtest.oq~Duplicate Month Test~duplicate~GP"');
    if(url.includes('fqkline'))return new Response(JSON.stringify({code:0,data:{'usDUPMONTHTEST.OQ':{month:months}}}));
    if(url.includes('yahoo'))return new Response('unavailable',{status:503});
    return new Response(JSON.stringify({data:null}));
  };
  try {await assert.rejects(()=>getCandles('us','DUPMONTHTEST','1M'));}
  finally {globalThis.fetch=original;}
});
test('native Tencent US weekly candles use week OHLC and keep the current week unfinished',async()=>{
  const original=globalThis.fetch,originalNow=Date.now,urls:string[]=[];
  Date.now=()=>Date.parse('2026-11-13T14:00:00Z');
  const week:unknown[][]=Array.from({length:12},(_,i)=>[new Date(Date.parse('2024-01-05T00:00:00Z')+i*7*86400000).toISOString().slice(0,10),'100','101','102','99','1234']);
  week.push(['2026-11-12','345.000','354.880','359.370','344.780','144837567']);
  globalThis.fetch=async input=>{
    const url=String(input);urls.push(url);
    if(url.includes('smartbox'))return new Response('v_hint="us~weektest.oq~Week Test~week test~GP"');
    return new Response(JSON.stringify({code:0,data:{'usWEEKTEST.OQ':{week}}}));
  };
  try {
    const result=await getCandles('us','WEEKTEST','1w');
    assert.ok(result.source.includes('原生美股周K'));
    assert.equal(result.interval,'1w');
    assert.equal(result.candles.length,13);
    assert.deepEqual([result.candles.at(-1)!.open,result.candles.at(-1)!.high,result.candles.at(-1)!.low,result.candles.at(-1)!.close,result.candles.at(-1)!.volume],[345,359.37,344.78,354.88,144837567]);
    assert.equal(result.candles.at(-1)!.closed,false);
    assert.ok(urls.some(url=>url.endsWith('usWEEKTEST.OQ,week,,,800,')));
  } finally {globalThis.fetch=original;Date.now=originalNow;}
});
