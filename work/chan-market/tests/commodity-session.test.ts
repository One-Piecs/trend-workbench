import test from 'node:test';
import assert from 'node:assert/strict';
import {commodityBarEnd,commodityCalendarStart,commoditySessionStart,commodityTradeDate,consecutiveCommodityBars} from '../lib/commodity-session.ts';
import {candleAvailableAt} from '../lib/timeframe-context.ts';
import {getFeedHealth} from '../lib/feed-health.ts';
import {evaluateHigherConfluence} from '../lib/confluence.ts';
import {validationClosedBars} from '../lib/forecast-validation.ts';
import {deriveHigherFromPrimary} from '../lib/higher-from-primary.ts';
import {breakoutVwap} from '../lib/breakout-vwap.ts';
import type {Candle,Interval,MarketData} from '../lib/market-types';

const sec=(iso:string)=>Date.parse(iso)/1000;
const candle=(time:number):Candle=>({time,open:70,high:72,low:69,close:71,volume:100,closed:true});
const negative=(time:number):Candle=>({...candle(time),low:-11,close:-10});
function data(interval:Interval,bars:Candle[],asOf:number):MarketData {
  return {instrument:{id:'commodity:CL=F',symbol:'CL=F',name:'WTI',market:'commodity',exchange:'NYMEX',currency:'USD'},
    interval,candles:bars,asOf:new Date(asOf*1000).toISOString(),source:'Yahoo Finance 期货行情 · query1.finance.yahoo.com',
    adjustment:'来源原始OHLC；换月衔接口径未核验',availableIntervals:[interval],delayNotice:'',warnings:[]};
}
test('Globex Sunday evening starts the Monday trade date in Chicago, including DST',()=>{
  for(const [summer,open] of [[false,'2026-01-04T23:00:00Z'],[true,'2026-03-08T22:00:00Z']] as const){
    const t=sec(open);
    assert.equal(commoditySessionStart(t-1),null);
    assert.equal(commoditySessionStart(t+2*3600),t);
    assert.equal(commodityTradeDate(t),summer?'2026-03-09':'2026-01-05');
  }
  assert.equal(commoditySessionStart(sec('2026-11-20T22:00Z')),null);
  assert.equal(commoditySessionStart(sec('2026-11-21T18:00Z')),null);
});
test('day, week, month and 4h tails end at 16:00 CT with an independent availability cutoff',()=>{
  const monday=sec('2026-11-02T05:00Z');
  for(const interval of ['1d','1w','1M'] as const)assert.equal(commodityCalendarStart(monday,interval),sec('2026-11-01T23:00Z'));
  const start=commodityCalendarStart(monday,'1d');
  assert.equal(commodityBarEnd(start,'1d'),sec('2026-11-02T22:00Z'));
  assert.equal(commodityBarEnd(start,'1w'),sec('2026-11-06T22:00Z'));
  assert.equal(commodityBarEnd(start,'1M'),sec('2026-11-30T22:00Z'));
  const fridayTail=sec('2026-11-06T19:00Z');
  assert.equal(commodityBarEnd(fridayTail,'4h'),fridayTail+3*3600);
  assert.equal(candleAvailableAt({time:fridayTail},'commodity','4h'),sec('2026-11-06T22:15Z'));
  assert.equal(consecutiveCommodityBars(fridayTail,sec('2026-11-08T23:00Z'),'4h'),true);
  assert.equal(consecutiveCommodityBars(fridayTail,sec('2026-11-09T03:00Z'),'4h'),false);
  assert.equal(consecutiveCommodityBars(fridayTail,sec('2026-11-06T22:00Z'),'4h'),false);
  assert.equal(consecutiveCommodityBars(start,sec('2026-11-08T23:00Z'),'1w'),true);
  assert.equal(consecutiveCommodityBars(start,sec('2026-11-30T23:00Z'),'1M'),true);
});
test('freshness distinguishes an overnight delayed feed, maintenance, holidays, and genuine signed prices',()=>{
  const health=(now:string,bar:string,price=candle)=>getFeedHealth(data('1h',[price(sec(bar))],sec(now)),{nowMs:sec(now)*1000});
  const sunday=health('2026-11-22T23:20Z','2026-11-22T23:00Z');
  assert.equal(sunday.state,'delayed');assert.ok(sunday.allowSignals);
  assert.equal(health('2026-11-22T23:20Z','2026-11-20T21:00Z').state,'stale');
  assert.equal(health('2026-11-23T22:05Z','2026-11-23T21:00Z').state,'closed');
  assert.equal(health('2026-11-26T20:00Z','2026-11-26T20:00Z').allowSignals,false);
  const signed=health('2026-11-23T21:10Z','2026-11-23T21:00Z',negative);
  assert.equal(signed.lastBarTimeMs,sec('2026-11-23T21:00Z')*1000);assert.equal(signed.allowSignals,false);
});
test('native higher assessment, validation and VWAP never join structures across nonpositive oil prices',()=>{
  const start=sec('2026-11-15T23:00Z'),asOf=start+44*60+900;
  const bars=Array.from({length:45},(_,i)=>candle(start+i*60));
  bars[42]=negative(bars[42].time);
  const market=data('1m',bars,asOf);
  assert.deepEqual(validationClosedBars(market).map(b=>b.time),[bars[43].time]);
  const result=breakoutVwap(bars,'commodity','1m',market.source);
  assert.deepEqual(result.next(),{value:{status:'no-anchor'},done:true});
  const fiveMinute=bars.map((b,i)=>({...b,time:start+i*300}));
  const later=start+45*300+900,parent=data('5m',fiveMinute,later);
  const ctx={market:'commodity' as const,symbol:'CL=F',interval:'1m' as const,source:parent.source,adjustment:parent.adjustment,
    higher:{status:'ready' as const,interval:'5m' as const,data:parent}};
  const h=evaluateHigherConfluence(ctx,later,()=>{throw new Error('Only two subsequent bars');});
  assert.equal(h.bars,2);assert.equal(h.status,'insufficient');
  assert.equal(evaluateHigherConfluence(ctx,start+42*300+900,()=> 'long').status,'ready');
});
test('same-source higher bars use 17:00 CT and require every component slot',()=>{
  const start=sec('2026-11-15T23:00Z');
  const bars=Array.from({length:180},(_,i)=>candle(start+i*60));
  const snapshot=data('1m',bars,start+180*60+900);
  const full=deriveHigherFromPrimary(snapshot);
  assert.equal(full?.candles.length,36);assert.equal(full?.candles[0].time,start);
  const oneMissing={...snapshot,candles:bars.filter((_,i)=>i!==0)};
  assert.equal(deriveHigherFromPrimary(oneMissing)?.candles.length,35);
  const priceReset=bars.slice();priceReset[1]=negative(bars[1].time);
  assert.equal(deriveHigherFromPrimary({...snapshot,candles:priceReset})?.candles.length,35);
});
