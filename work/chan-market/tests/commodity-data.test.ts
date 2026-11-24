import test from 'node:test';
import assert from 'node:assert/strict';
import { getCommodityCandles } from '../lib/commodity-data.ts';
import { searchCommodities } from '../lib/commodity-catalog.ts';
import type { Interval } from '../lib/market-types';

const sec=(date:string)=>Date.parse(date)/1000;
const hour=3600;
const now=Date.parse('2026-11-20T23:00:00Z');
const futuresMeta={symbol:'GC=F',instrumentType:'FUTURE',currency:'USD',exchangeName:'CMX',dataGranularity:'1h'};
function fixture(epoch:number[],meta:Record<string,unknown>=futuresMeta) {
  const series=(offset:number)=>epoch.map((_,i)=>100+i+offset);
  const quote={open:series(0),high:series(3),low:series(-2),close:series(1),volume:epoch.map((_,i)=>10+i)};
  return {chart:{result:[{meta,timestamp:epoch,indicators:{quote:[quote]}}]}};
}
function load(body:ReturnType<typeof fixture>,period:Interval,at=now) {
  return getCommodityCandles('GC=F',period,800,async()=>Response.json(body),at);
}

test('search resolves localized and international commodity aliases without mapping spot or ETFs',()=>{
  for(const [term,symbol] of [['黄金','GC=F'],['silver','SI=F'],['WTI','CL=F'],['CL=F','CL=F']])
    assert.deepEqual(searchCommodities(term).map(i=>i.symbol),[symbol]);
  assert.deepEqual(searchCommodities('黄金ETF'),[]);
});
test('rejects a different symbol, currency, equity instrument, venue or downsampled interval on both hosts',async()=>{
  const ts=[sec('2026-11-16T01:00:00Z')];
  for(const patch of [{symbol:'SI=F'},{instrumentType:'EQUITY'},{exchangeName:'NMS'},{currency:'EUR'},{dataGranularity:'1d'}]) {
    await assert.rejects(()=>load(fixture(ts,{...futuresMeta,...patch}),'1h'),/周期|核验/);
  }
});
test('intraday futures retain valid overnight bars but omit maintenance, non-grid appended quotes and duplicate timestamps',async()=>{
  const t=sec('2026-11-16T19:00:00Z');
  const data=await load(fixture([t,t,t+hour,t+hour*3,t+hour*4,t+hour*4+75]),'1h');
  assert.deepEqual(data.candles.map(c=>c.time),[t,t+hour,t+hour*4]);
  assert.equal(data.candles[0].volume,10);
  assert.equal(data.candles.at(-1)?.closed,true);
});
test('4h uses the session start, preserves the shortened final three-hour segment and skips interior gaps',async()=>{
  const t=sec('2026-11-15T23:00:00Z');
  const stamps=[0,1,2,3,4,6,7,20,21,22,23].map(h=>t+h*hour);
  const data=await load(fixture(stamps),'4h');
  assert.deepEqual(data.candles.map(c=>[c.time,c.open,c.close,c.volume,c.closed]),[[t,100,104,46,true],[t+20*hour,107,110,54,true]]);
  const partial=await load(fixture([t,t+hour]),'4h',(t+1.5*hour)*1000);
  assert.equal(partial.candles[0].closed,false);
});
test('real daily input builds the entire week with no extra intraday or partial-day quote',async()=>{
  const mon=sec('2026-11-16T05:00:00Z'),rows=[mon,mon+86400,mon+172800,mon+259200,mon+345600,mon+345600+42349];
  const result=await load(fixture(rows,{...futuresMeta,dataGranularity:'1d'}),'1w');
  assert.deepEqual(result.candles,[{time:sec('2026-11-15T23:00:00Z'),open:100,high:107,low:98,close:105,volume:60,closed:true}]);
});
test('an absent midweek day requires a genuine weekly candle; the missing day is never silently treated as a holiday',async()=>{
  const mon=sec('2026-11-16T05:00:00Z');
  const source=fixture([mon,mon+86400,mon+259200,mon+345600],{...futuresMeta,dataGranularity:'1d'});
  const native=fixture([mon,mon+345600+41000],{...futuresMeta,dataGranularity:'1wk'});
  native.chart.result[0].indicators.quote[0].volume[0]=900;
  const result=await getCommodityCandles('GC=F','1w',100,async url=>
    Response.json(String(url).includes('interval=1wk')?native:source),now);
  assert.equal(result.candles.length,1);
  assert.equal(result.candles[0].volume,900);
  await assert.rejects(()=>load(source,'1w'),/有效K线/);
});
test('a failed feed retries the second hostname for the exact same contract',async()=>{
  const calls:string[]=[];
  const d=await getCommodityCandles('GC=F','1h',100,async url=>{
    calls.push(String(url));return calls.length===1?new Response(null,{status:429}):Response.json(fixture([sec('2026-11-16T19:00:00Z')]));
  },now);
  assert.equal(calls.length,2);
  assert.ok(calls.every(url=>url.includes('GC%3DF')));
  assert.match(d.source,/query2/);
});
test('negative WTI prices remain in the chart alongside earlier and later observations',async()=>{
  const ticks=[sec('2020-04-17T04:00:00Z'),sec('2020-04-20T04:00:00Z'),sec('2020-04-21T04:00:00Z')];
  const source=fixture(ticks,{...futuresMeta,symbol:'CL=F',exchangeName:'NYM',dataGranularity:'1d'});
  const q=source.chart.result[0].indicators.quote[0];
  q.low[1]=-40.32;q.close[1]=-37.63;
  const data=await getCommodityCandles('CL=F','1d',800,async()=>Response.json(source),now);
  assert.equal(data.candles.length,3);
  assert.equal(data.candles[1].low,-40.32);
  assert.equal(data.candles[1].close,-37.63);
  assert.ok(data.warnings.some(text=>text.includes('非正油价')));
});
