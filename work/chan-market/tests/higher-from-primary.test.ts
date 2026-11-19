import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibleMarketFeeds, deriveHigherFromPrimary } from '../lib/higher-from-primary.ts';
import { evaluateHigherConfluence } from '../lib/confluence.ts';
import { candleAvailableAt } from '../lib/timeframe-context.ts';
import type { Candle, Interval, Market, MarketData } from '../lib/market-types';

const DAY=86400,start=Date.parse('2026-01-05T00:00:00Z')/1000;
const bar=(time:number,i=0):Candle=>({time,open:100+i,high:103+i,low:99+i,close:102+i,volume:i+1,closed:true});
const dataset=(market:Market,interval:Interval,candles:Candle[],source=market==='crypto'?'Kraken 公共现货行情 · XBTUSDT':market==='cn'?'新浪财经 OHLC（独立备用）':'Yahoo Finance 网页行情'):MarketData=>({
  instrument:{id:`${market}:TEST`,market,symbol:'TEST',name:'Test',exchange:'Test',currency:'USD'},interval,candles,source,asOf:'2026-11-14T00:00:00Z',delayNotice:'source delay',adjustment:'来源原始OHLC（未请求复权）',warnings:['original warning'],availableIntervals:[interval],
});
function dates(count:number,first='2026-02-02'):string[] {
  const output:string[]=[];let time=Date.parse(`${first}T00:00:00Z`);
  while(output.length<count) { const d=new Date(time);if(d.getUTCDay()>0&&d.getUTCDay()<6)output.push(d.toISOString().slice(0,10));time+=DAY*1000; }
  return output;
}
// These fixtures span the 2026 New York spring and autumn DST changes.
const epoch=(date:string,minute:number,market:'cn'|'us')=>Date.parse(`${date}T00:00:00Z`)/1000+(minute+(market==='cn'?-480:date<'2026-03-08'||date>='2026-11-01'?300:240))*60;

test('crypto parents require each complete UTC child slot and preserve OHLCV and source identity',()=>{
  const cases:[Interval,number,Interval,number][]=[['1m',60,'5m',300],['5m',300,'15m',900],['15m',900,'1h',3600],['30m',1800,'4h',14400],['1h',3600,'4h',14400],['4h',14400,'1d',DAY],['1d',DAY,'1w',7*DAY]];
  for(const [interval,step,parent,width] of cases) {
    const size=width/step,primary=dataset('crypto',interval,Array.from({length:35*size},(_,i)=>bar(start+i*step,i)));
    const derived=deriveHigherFromPrimary(primary)!;
    assert.ok(derived,interval);assert.equal(derived.interval,parent);assert.equal(derived.candles.length,35);
    assert.deepEqual(derived.candles[0],{time:start,open:100,high:102+size,low:99,close:101+size,volume:size*(size+1)/2,closed:true});
    assert.equal(derived.adjustment,primary.adjustment);assert.equal(derived.asOf,primary.asOf);
    assert.equal(derived.source,primary.source+' · 真实同源聚合');assert.ok(compatibleMarketFeeds(primary,derived));
    const higher=evaluateHigherConfluence({market:'crypto',symbol:'TEST',interval,source:primary.source,adjustment:primary.adjustment,higher:{interval:parent,status:'ready',data:derived}},candleAvailableAt(primary.candles.at(-1)!,'crypto',interval),()=> 'long');
    assert.equal(higher.status,'ready');assert.equal(higher.bars,35);
    assert.equal(primary.candles.length,35*size);assert.deepEqual(primary.warnings,['original warning']);
  }
});
test('missing children, forming bars and trailing partial parents are skipped without filling prices',()=>{
  const rows=Array.from({length:40*4+2},(_,i)=>bar(start+i*3600,i));
  rows.splice(5,1);rows[25].closed=false;
  const result=deriveHigherFromPrimary(dataset('crypto','1h',rows))!;
  assert.equal(result.candles.length,38);assert.equal(result.candles.some(c=>c.time===start+4*3600),false);
  assert.ok(result.warnings.some(w=>w.includes('已跳过3个')));
});
test('a completed flag cannot make a future parent available',()=>{
  const primary=dataset('crypto','1h',Array.from({length:40*4},(_,i)=>bar(start+i*3600)));
  primary.asOf=new Date((start+35*14400-1)*1000).toISOString();
  assert.equal(deriveHigherFromPrimary(primary),null);
  primary.asOf=new Date((start+35*14400)*1000).toISOString();
  assert.equal(deriveHigherFromPrimary(primary)?.candles.length,35);
});
test('fewer than 35 parents, weekly to monthly, and unknown adjustment remain unavailable',()=>{
  assert.equal(deriveHigherFromPrimary(dataset('crypto','1h',Array.from({length:34*4},(_,i)=>bar(start+i*3600)))),null);
  assert.equal(deriveHigherFromPrimary(dataset('crypto','1w',Array.from({length:80},(_,i)=>bar(start+i*7*DAY)))),null);
  const data=dataset('crypto','1h',Array.from({length:40*4},(_,i)=>bar(start+i*3600)));
  data.adjustment='复权口径未独立核验';assert.equal(deriveHigherFromPrimary(data),null);
});
test('unordered, duplicate or malformed input is not silently repaired into a valid feed',()=>{
  const data=dataset('crypto','1h',Array.from({length:40*4},(_,i)=>bar(start+i*3600)));
  data.candles[8].time=data.candles[7].time;assert.equal(deriveHigherFromPrimary(data),null);
  data.candles[8]=bar(start+8*3600);data.candles[9].low=-1;assert.equal(deriveHigherFromPrimary(data),null);
});
test('CN hourly to daily requires morning and afternoon end-labelled slots',()=>{
  const rows=dates(40).flatMap((d,i)=>[630,690,840,900].map((m,j)=>bar(epoch(d,m,'cn'),i*4+j)));
  const primary=dataset('cn','1h',rows),derived=deriveHigherFromPrimary(primary)!;
  assert.equal(derived.interval,'1d');assert.equal(derived.candles.length,40);
  assert.equal(derived.candles[0].time,epoch('2026-02-02',0,'cn'));
  primary.candles=rows.filter((_,i)=>i!==6);assert.equal(deriveHigherFromPrimary(primary)?.candles.length,39);
});
test('US 4H to daily requires both regular-session bars and follows NY DST',()=>{
  const primary=dataset('us','4h',dates(40).flatMap((d,i)=>[570,810].map((m,j)=>bar(epoch(d,m,'us'),i*2+j))));
  const result=deriveHigherFromPrimary(primary)!;
  assert.equal(result.candles.length,40);
  assert.equal(result.candles[24].time,Date.parse('2026-03-06T05:00:00Z')/1000);
  assert.equal(result.candles[25].time,Date.parse('2026-03-09T04:00:00Z')/1000);
  primary.candles.splice(21,1);assert.equal(deriveHigherFromPrimary(primary)?.candles.length,39);
});
test('US hourly to 4H does not include an early-close morning without afternoon coverage',()=>{
  const primary=dataset('us','1h',dates(40).flatMap((d,i)=>[570,630,690,750,810,870,930].map((m,j)=>bar(epoch(d,m,'us'),i*7+j))));
  assert.equal(deriveHigherFromPrimary(primary)?.candles.length,80);
  const earlyDate=dates(40)[10];
  primary.candles=primary.candles.filter(c=>c.time<epoch(earlyDate,810,'us')||c.time>epoch(earlyDate,960,'us'));
  assert.equal(deriveHigherFromPrimary(primary)?.candles.length,78);
});
test('stock weekly parents require all five weekdays; missing holidays are never synthesized',()=>{
  for(const [market,interval] of [['cn','4h'],['cn','1d'],['us','1d']] as const) {
    const primary=dataset(market,interval,dates(200).map((d,i)=>bar(epoch(d,interval==='4h'?570:0,market),i)));
    const result=deriveHigherFromPrimary(primary)!;
    assert.equal(result.interval,'1w');assert.equal(result.candles.length,40);
    primary.candles.splice(7,1);assert.equal(deriveHigherFromPrimary(primary)?.candles.length,39);
  }
});
test('incomplete current stock session cannot become a completed parent',()=>{
  const primary=dataset('cn','1h',dates(40).flatMap(d=>[630,690,840,900].map(m=>bar(epoch(d,m,'cn')))));
  const last=dates(40).at(-1)!;
  primary.asOf=new Date(epoch(last,900,'cn')*1000).toISOString();
  assert.equal(deriveHigherFromPrimary(primary)?.candles.length,39);
  primary.asOf=new Date(epoch(last,902,'cn')*1000).toISOString();
  assert.equal(deriveHigherFromPrimary(primary)?.candles.length,40);
});
test('provider and adjustment matching uses the same identity rules as confluence',()=>{
  const a=dataset('us','1h',[bar(start)]),b={...a,source:'Yahoo Finance 网页行情 · query2 · 1小时聚合4小时'};
  assert.equal(compatibleMarketFeeds(a,b),true);
  assert.equal(compatibleMarketFeeds(a,{...b,source:'东方财富 网页行情'}),false);
  assert.equal(compatibleMarketFeeds(a,{...b,adjustment:'前复权'}),false);
  assert.equal(compatibleMarketFeeds(a,{...b,adjustment:'unknown'}),false);
  assert.equal(compatibleMarketFeeds(a,{...b,instrument:{...a.instrument,symbol:'OTHER'}}),false);
});
