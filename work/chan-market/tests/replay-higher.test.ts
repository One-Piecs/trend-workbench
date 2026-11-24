import assert from 'node:assert/strict';
import test from 'node:test';
import {deriveReplayParent,isNativeReplayParent,replayParentWindow} from '../lib/replay-higher.ts';
import {linkedBars,linkedHistoryCursor} from '../lib/linked-timeframes.ts';
import {evaluateHigherConfluence} from '../lib/confluence.ts';
import type {MarketData} from '../lib/market-types.ts';

const start=Date.parse('2026-03-02T00:00:00Z')/1000, hour=3600;
function series(interval:'1h'|'4h',count:number):MarketData{
  const span=interval==='1h'?hour:4*hour;
  return {instrument:{id:'crypto:BTCUSDT',market:'crypto',symbol:'BTCUSDT',name:'BTC',currency:'USDT',exchange:'spot'},
    interval,source:'A · spot',adjustment:'来源原始OHLC',asOf:new Date((start+500*hour)*1000).toISOString(),
    availableIntervals:['1h','4h'],warnings:[],delayNotice:'',
    candles:Array.from({length:count},(_,i)=>({time:start+i*span,open:i+2,low:i+1,high:i+4,close:i+3,volume:i+1,closed:true}))};
}

test('one replay parent window supplies chart and confluence at the same completed close and rejects stale evidence',()=>{
  const primary=series('1h',194),parent=series('4h',60),at=start+181*hour;
  parent.candles[40].closed=false;
  const rows=linkedBars(parent,Infinity);
  const window=replayParentWindow(parent,rows,at)!;
  assert.equal(window.candles.length,44);
  assert.equal(window.candles.at(-1)?.time,start+176*hour);
  assert.equal(window.candles.some(c=>c.closed!==true),false);
  const result=evaluateHigherConfluence({market:'crypto',symbol:'BTCUSDT',interval:'1h',source:primary.source,
    adjustment:primary.adjustment,higher:{interval:'4h',status:'ready',data:window}},at,()=> 'long');
  assert.equal(result.status,'ready');
  assert.equal(result.asOf,linkedBars(window,Infinity).at(-1)?.available);
  assert.equal(replayParentWindow(parent,rows,start),undefined);
  assert.equal(replayParentWindow(parent,rows,start+249*hour),undefined);
  const onlyEarly={...parent,asOf:new Date((start+4*hour)*1000).toISOString()};
  assert.equal(replayParentWindow(onlyEarly,linkedBars(onlyEarly,Infinity),at),undefined);
});

test('aggregate only complete real historical child bars before the selected instant',()=>{
  const primary=series('1h',420),at=start+161*hour;
  primary.candles[9].closed=false;
  const result=deriveReplayParent(primary,linkedBars(primary,Infinity),at)!;
  assert.equal(result.interval,'4h');
  assert.equal(result.candles.length,39);
  assert.equal(result.candles.some(c=>c.time===start+8*hour),false);
  assert.equal(result.candles.at(-1)?.time,start+156*hour);
  assert.equal(result.candles.at(-1)?.close,primary.candles[159].close);
  assert.equal(deriveReplayParent(primary,linkedBars(primary,Infinity),start+35*4*hour),undefined);
  assert.equal(isNativeReplayParent(primary,result,'4h'),false);
});

test('archive identities require a compatible native parent including currency, contract and adjustment',()=>{
  const lower=series('1h',2),p=series('4h',2);
  assert.equal(isNativeReplayParent(lower,p,'4h'),true);
  for(const other of [{...p,source:'other venue'},{...p,interval:'1d' as const},{...p,adjustment:'前复权'},
    {...p,instrument:{...p.instrument,contract:'CLZ26'}},{...p,instrument:{...p.instrument,currency:'USD'}}]){
    assert.equal(isNativeReplayParent(lower,other,'4h'),false);
  }
  for(const interval of ['5m','15m','1h','4h','1d','1w','1M'] as const){
    const at=start+71,first=start+365*24*hour;
    const cursor=linkedHistoryCursor(interval,first,at);
    assert.ok(cursor>at&&cursor<=first);
    assert.equal(linkedHistoryCursor(interval,first,at+1),cursor);
  }
});
