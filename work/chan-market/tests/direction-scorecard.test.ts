import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../lib/chan.ts';
import {buildForecast} from '../lib/forecast.ts';
import {directionVersion,emptyDirectionBook,pairedDirectionInterval,prepareDirectionBars,updateDirectionBook} from '../lib/direction-scorecard.ts';
import type {DirectionBook} from '../lib/direction-scorecard.ts';
import type {MarketForecast} from '../lib/forecast-types.ts';
import type {Candle,MarketData} from '../lib/market-types.ts';

const start=Date.UTC(2026,0,1)/1000,span=3600;
function data(n:number){
  const candles:Candle[]=Array.from({length:n},(_,i)=>({time:start+i*span,open:100+i,close:101+i,high:102+i,low:99+i,volume:1000,closed:true}));
  return {instrument:{market:'crypto',symbol:'DEMO',id:'crypto:DEMO',currency:'USD',name:'fixture',exchange:'fixture'},interval:'1h',
    source:'fixture',adjustment:'raw',asOf:new Date((start+n*span)*1000).toISOString(),candles,warnings:[],availableIntervals:['1h'],delayNotice:''} satisfies MarketData;
}
function forecast(d:MarketData):MarketForecast{
  const context={market:d.instrument.market,symbol:d.instrument.symbol,interval:d.interval,source:d.source,adjustment:d.adjustment,asOf:Date.parse(d.asOf)/1000};
  return buildForecast(d.candles,analyze(d.candles,{skipCalibration:true,skipTradePlans:true}),context);
}
function run(d:MarketData,f:MarketForecast|null,book?:DirectionBook,now=Date.parse(d.asOf)/1000){
  const p=prepareDirectionBars(d,now)!;
  return updateDirectionBook(book??emptyDirectionBook(d,directionVersion(f!)),p,d,f,now);
}
test('live registration freezes the actual production call once, including an explicitly neutral ready call',()=>{
  const d=data(80),f=forecast(d),first=run(d,f)!;
  assert.equal(f.status,'ready');assert.equal(first.book.seen,1);
  assert.equal(first.book.pending[0].prediction,f.direction);
  assert.equal(first.book.pending[0].baseline,'long');
  assert.equal(run(d,{...f,direction:'short'},first.book),null);
  assert.equal(run(d,{...f,status:'insufficient'}),null);
  assert.equal(run(d,{...f,lastClosedPrice:999}),null);
  assert.equal(run(d,{...f,context:{...f.context,source:'different'}}),null);
});
test('12 complete candles strictly after publication; partial candle and zero movement do not yield a hit',()=>{
  const d=data(80),f=forecast(d),initial=run(d,{...f,direction:'long'},undefined,start+80*span+1)!.book;
  assert.equal(run(data(92),null,initial),null);
  const next=data(93);
  next.candles[92].close=next.candles[81].open;
  next.candles[92].low=next.candles[92].close;
  const out=run(next,null,initial)!;
  assert.equal(out.book.calls,1);assert.equal(out.book.hits,0);
  assert.equal(out.book.pairedHits,0);assert.equal(out.book.baselineHits,0);
  assert.ok('firstTime' in out.rows[0]&&'endTime' in out.rows[0]);
  assert.equal(out.rows[0].firstTime,next.candles[81].time);
  assert.equal(out.rows[0].endTime,next.candles[92].time);
  assert.equal(run(next,null,out.book),null);
  next.candles[92].closed=false;assert.equal(run(next,null,initial),null);
});
test('neutral stays an abstention, disconnected history or revised anchor cannot produce a result',()=>{
  const d=data(80),f=forecast(d),initial=run(d,{...f,direction:'neutral'})!.book;
  const matured=run(data(92),null,initial)!.book;
  assert.equal(matured.abstained,1);assert.equal(matured.calls,0);assert.equal(matured.pairs,0);
  for(const mode of ['missing','revised','late']){
    const next=data(94);
    if(mode==='missing')next.candles.splice(87,1);
    if(mode==='revised')next.candles[79].close++;
    if(mode==='late')next.candles.splice(0,80);
    const out=run(next,null,initial)!.book;
    assert.equal(out.gap,1);assert.equal(out.matured,0);assert.equal(out.hits,0);
  }
});
test('a flat 12-bar baseline is excluded from the matched directional comparison',()=>{
  const d=data(80);
  d.candles[67]={...d.candles[79],time:d.candles[67].time};
  const initial=run(d,{...forecast(d),direction:'long'})!.book;
  assert.equal(initial.pending[0].baseline,'neutral');
  const settled=run(data(92),null,initial)!.book;
  assert.equal(settled.hits,1);
  assert.equal(settled.pairs,0);
});
test('same-sample comparison, non-overlapping reference interval and isolation by engine/source',()=>{
  const d=data(80),f=forecast(d);
  let b=run(d,{...f,direction:'short'})!.book;
  const second=data(81),f2=forecast(second);
  assert.equal(run(second,{...f2,modelVersion:'future'},b),null);
  const foreign={...second,adjustment:'adjusted'};
  assert.equal(run(foreign,null,b),null);
  b=run(second,{...f2,direction:'long'},b)!.book;
  const out=run(data(93),null,b)!.book;
  assert.equal(out.calls,2);assert.equal(out.hits,1);assert.equal(out.baselineHits,2);
  assert.equal(out.separatePairs,1);assert.equal(out.lossesOnly,1);assert.equal(out.winsOnly,0);
  assert.equal(pairedDirectionInterval(out),null);
  const [low,high]=pairedDirectionInterval({...out,separatePairs:100,winsOnly:50,lossesOnly:10})!;
  assert.ok(low>0&&low<40&&high>40&&high<=100);
  const unavailable=data(80);
  unavailable.candles.splice(75,1);
  assert.equal(run(unavailable,{...forecast(unavailable),direction:'long'})!.book.pending[0].baseline,null);
});
