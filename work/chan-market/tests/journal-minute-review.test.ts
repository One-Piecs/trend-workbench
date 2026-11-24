import test from 'node:test';
import assert from 'node:assert/strict';
import type {Candle,MarketData} from '../lib/market-types.ts';
import type {ForecastRecord} from '../lib/forecast-journal.ts';
import {advanceForecastJournal,forecastIdentity,forecastStats} from '../lib/forecast-journal.ts';
import {journalReviewContext,reviewJournalMinuteOrder} from '../lib/journal-minute-review.ts';
import {createJournalMinuteFeed} from '../lib/journal-minute-feed.ts';

const at=1740000000, instrument={id:'crypto:BTCUSDT',symbol:'BTCUSDT',market:'crypto' as const,name:'BTC',currency:'USDT',exchange:'Binance'};
const source='Binance 公共现货行情 · BTCUSDT',adjustment='原始成交价格，不复权';
function candle(time:number,lo:number,hi:number):Candle{return {time,low:lo,high:hi,open:100,close:100,closed:true,volume:10};}
const previous=candle(at-300,99,101);
function feed(candles:Candle[],interval:MarketData['interval']='5m'):MarketData{
  return {instrument,source,adjustment,interval,candles,asOf:new Date((at+300)*1000).toISOString(),delayNotice:'',warnings:[],availableIntervals:[interval]};
}
function record():ForecastRecord{
  const level=(price:number)=>({price,source:'confirmed-fractal' as const,estimated:false,time:at-3600,index:1,confirmedAt:2});
  return {id:'x',key:forecastIdentity(feed([])),market:'crypto',symbol:'BTCUSDT',source,adjustment,interval:'5m',createdAt:at-900,
    structureAsOf:at-900,referencePrice:100,referenceTime:at-900,lastBarTime:previous.time,lastClose:100,barsObserved:3,
    status:'condition-met',events:[{id:'c',type:'condition-met',barTime:previous.time,at,price:100}],
    outlook:{id:'p',status:'ready',side:'long',kind:'breakout',zoneLow:99,zoneHigh:101,triggerPrice:100,invalidationPrice:95,
      anchor:level(100),targets:[level(105),level(110)],basis:['confirmed-fractal'],triggerRule:'close-above'}};
}
function study(mins:Candle[]){
  const parent=candle(at,Math.min(...mins.map(m=>m.low)),Math.max(...mins.map(m=>m.high)));
  const active=feed([previous,parent]);
  const result=advanceForecastJournal({version:1,trimmed:0,records:[record()]},active,at+301).journal.records[0];
  assert.equal(result.status,'ambiguous');
  const ctx=journalReviewContext(result,null);
  assert.equal(ctx.kind,'ready');
  if(ctx.kind!=='ready')throw new Error('Expected minute observation');
  return {result,active,ctx,mins:feed(mins,'1m')};
}
test('review uses the frozen parent and distinguishes T1-first, stop-first vs T2 without changing journal statistics',()=>{
  const {result,ctx,mins}=study([candle(at,99,106),candle(at+60,94,101),candle(at+120,99,113),candle(at+180,99,101),candle(at+240,99,101)]);
  const before=forecastStats([result]);
  assert.deepEqual(reviewJournalMinuteOrder(result,ctx,mins),[{order:'target-first',minuteStart:at},{order:'stop-first',minuteStart:at+60}]);
  assert.deepEqual(forecastStats([result]),before);
  assert.equal(before.resolved,0);
  assert.equal(result.status,'ambiguous');
});
test('unresolved same-minute T1+stop never credits an untouched T2; a missing minute cannot prove sequence',()=>{
  const {result,ctx,mins}=study([candle(at,94,106),candle(at+60,99,101),candle(at+120,99,101),candle(at+180,99,101),candle(at+240,99,101)]);
  assert.deepEqual(reviewJournalMinuteOrder(result,ctx,mins),[{order:'same-minute'},{order:'untouched'}]);
  assert.deepEqual(reviewJournalMinuteOrder(result,ctx,{...mins,candles:mins.candles.slice(0,4)})[0],{order:'unavailable'});
});
test('legacy observations need the matching chart and cannot review a confirmation-bar ambiguity',()=>{
  const {result,active}=study([candle(at,94,106),candle(at+60,99,101),candle(at+120,99,101),candle(at+180,99,101),candle(at+240,99,101)]);
  delete result.events.at(-1)!.observedParent;
  assert.equal(journalReviewContext(result,active).kind,'ready');
  assert.equal(journalReviewContext(result,null).kind,'missing-parent');
  assert.equal(journalReviewContext(result,{...active,source:'other'}).kind,'missing-parent');
  assert.equal(journalReviewContext({...result,events:[result.events.at(-1)!]},active).kind,'none');
});
test('interactive minute requests are bounded by one day and deduplicated within exact identities',async()=>{
  let calls=0;
  const read=createJournalMinuteFeed(async()=>{calls++;return feed([previous],'1m');});
  const params=new URLSearchParams({symbol:instrument.symbol,venue:instrument.exchange,currency:instrument.currency,source,adjustment,start:String(at),end:String(at+300)});
  await Promise.all([read(params),read(params)]);await read(params);
  assert.equal(calls,1);
  params.set('end',String(at+172800));await assert.rejects(read(params),RangeError);
  assert.equal(calls,1);
});
