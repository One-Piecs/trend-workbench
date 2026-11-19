import test from 'node:test';
import assert from 'node:assert/strict';
import {getCandles} from '../lib/market-data.ts';
import type {Candle,Interval} from '../lib/market-types';

const epoch=(value:string)=>Date.parse(value)/1000;
const bar=(stamp:string,value=100):Candle=>({time:epoch(stamp),open:value,high:value+2,low:value-1,close:value+.75,volume:1234});
const hourly=['09:30','10:30','11:30','12:30','13:30','14:30','15:30'];
const halfHourly=['09:30','10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30','14:00','14:30','15:00','15:30'];
const session=(date:string,stamps:string[],offset:string)=>stamps.map((clock,i)=>bar(`${date}T${clock}:00${offset}`,100+i));
const prices=(candles:Candle[])=>candles.map(c=>[c.time,c.open,c.high,c.low,c.close,c.volume]);

async function yahoo(symbol:string,interval:Interval,rows:Candle[],now:string) {
  const originalFetch=globalThis.fetch,originalNow=Date.now,urls:string[]=[];
  Date.now=()=>Date.parse(now);
  const granularity=interval==='1h'?'60m':interval;
  globalThis.fetch=async input=>{
    const url=String(input);urls.push(url);
    if(!url.includes('yahoo'))return new Response('Unused alternate source',{status:503});
    return new Response(JSON.stringify({chart:{result:[{
      meta:{dataGranularity:granularity,exchangeTimezoneName:'America/New_York',currency:'USD',currentTradingPeriod:{regular:{end:epoch(`${now.slice(0,10)}T16:00:00-05:00`)}}},
      timestamp:rows.map(c=>c.time),indicators:{quote:[{open:rows.map(c=>c.open),high:rows.map(c=>c.high),low:rows.map(c=>c.low),close:rows.map(c=>c.close),volume:rows.map(c=>c.volume)}]},
    }]}}));
  };
  try{return {data:await getCandles('us',symbol,interval,100),urls};}
  finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
}

test('Yahoo hourly bars exclude appended 16:00 quotes, off-grid timestamps, extended hours and weekends',async()=>{
  const regular=[...session('2026-11-12',hourly,'-05:00'),...session('2026-11-13',hourly,'-05:00')];
  const extra=[bar('2026-11-13T16:00:00-05:00',9990),bar('2026-11-13T10:00:00-05:00',9980),bar('2026-11-13T10:30:01-05:00',9970),bar('2026-11-13T09:00:00-05:00',9960),bar('2026-11-13T16:30:00-05:00',9950),bar('2026-11-07T09:30:00-05:00',9940),bar('2026-11-08T09:30:00-05:00',9930)];
  const {data,urls}=await yahoo('YAHOOHOURREG','1h',[...regular,...extra].sort((a,b)=>a.time-b.time),'2026-11-13T16:30:00-05:00');
  assert.equal(data.candles.length,14);assert.deepEqual(prices(data.candles),prices(regular));
  assert.equal(data.candles.at(-1)!.time,epoch('2026-11-13T15:30:00-05:00'));
  assert.ok(data.candles.every(c=>c.closed));assert.ok(urls.some(url=>url.includes('interval=60m&range=2y')));
});

test('Yahoo 30-minute regular slots survive the DST change with original OHLCV and exclude appended/off-grid rows',async()=>{
  const regular=[...session('2026-10-30',halfHourly,'-04:00'),...session('2026-11-02',halfHourly,'-05:00')];
  const extra=[bar('2026-10-30T16:00:00-04:00',9000),bar('2026-11-02T16:00:00-05:00',9001),bar('2026-11-02T09:45:00-05:00',9002),bar('2026-11-02T10:00:01-05:00',9003),bar('2026-11-02T09:00:00-05:00',9004),bar('2026-11-02T17:00:00-05:00',9005),bar('2026-11-01T10:00:00-05:00',9006)];
  const {data,urls}=await yahoo('YAHOOHALFDST','30m',[...regular,...extra].sort((a,b)=>a.time-b.time),'2026-11-02T16:30:00-05:00');
  assert.equal(data.candles.length,26);assert.deepEqual(prices(data.candles),prices(regular));
  assert.equal(data.candles[0].time,epoch('2026-10-30T13:30:00Z'));
  assert.equal(data.candles[13].time,epoch('2026-11-02T14:30:00Z'));
  assert.ok(urls.some(url=>url.includes('interval=30m&range=60d')));
});

test('the genuine current hourly candle remains visible and unfinished while an appended close-time quote is removed',async()=>{
  const regular=[...session('2026-11-12',hourly,'-05:00'),...session('2026-11-13',hourly.slice(0,6),'-05:00')];
  const {data}=await yahoo('YAHOOCURRENTBAR','1h',[...regular,bar('2026-11-13T16:00:00-05:00',9999)],'2026-11-13T15:15:00-05:00');
  assert.deepEqual(prices(data.candles),prices(regular));
  assert.equal(data.candles.at(-1)!.time,epoch('2026-11-13T14:30:00-05:00'));
  assert.equal(data.candles.at(-1)!.closed,false);assert.equal(data.candles.at(-2)!.closed,true);
  assert.equal(data.candles.at(-1)!.close,regular.at(-1)!.close);
});

test('intraday slot filtering does not remove daily OHLC stamped at the session close',async()=>{
  const dates=['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13'];
  const rows=dates.map((date,i)=>bar(`${date}T16:00:00-05:00`,100+i));
  const {data}=await yahoo('YAHOODAYKEEP','1d',rows,'2026-11-14T12:00:00-05:00');
  assert.equal(data.candles.length,10);assert.deepEqual(prices(data.candles),prices(rows));
  assert.ok(data.candles.every(c=>c.closed));
});
