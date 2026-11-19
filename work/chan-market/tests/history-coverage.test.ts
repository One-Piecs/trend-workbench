import test from 'node:test';
import assert from 'node:assert/strict';
import {withHistoryCoverage} from '../lib/history-coverage.ts';
import type {Candle,Interval,Market,MarketData} from '../lib/market-types';

const makeData=(count:number):MarketData=>({
  instrument:{id:'crypto:ARBUSDT',market:'crypto',symbol:'ARBUSDT',name:'Arbitrum',exchange:'Binance',currency:'USDT'},
  interval:'1h',source:'Binance',asOf:'2026-11-14T00:00:00.000Z',adjustment:'raw',delayNotice:'Public feed',warnings:[],availableIntervals:['1h'],
  candles:Array.from({length:count},(_,i):Candle=>({time:1700000000+i*3600,open:100,high:102,low:99,close:101,volume:1000,closed:true})),
});

test('empty deliveries report insufficient history with no invented dates',()=>{
  const result=withHistoryCoverage(makeData(0),800);
  assert.deepEqual(result.history,{requested:800,received:0,closed:0,firstTime:null,lastTime:null,status:'insufficient'});
});

test('completed-bar threshold takes precedence over the requested loading target',()=>{
  assert.equal(withHistoryCoverage(makeData(34),34).history?.status,'insufficient');
  const data=makeData(35);data.candles[34].closed=false;
  assert.deepEqual(withHistoryCoverage(data,35).history,{requested:35,received:35,closed:34,firstTime:data.candles[0].time,lastTime:data.candles[34].time,status:'insufficient'});
  data.candles[34].closed=undefined;
  assert.equal(withHistoryCoverage(data,35).history?.closed,35);
  assert.equal(withHistoryCoverage(data,35).history?.status,'target-met');
});

test('limited and target-met describe the delivered loading window',()=>{
  assert.equal(withHistoryCoverage(makeData(35),800).history?.status,'limited');
  assert.equal(withHistoryCoverage(makeData(800),800).history?.status,'target-met');
  const result=withHistoryCoverage(makeData(801),800);
  assert.equal(result.history?.status,'target-met');assert.equal(result.history?.received,801);
  assert.equal(result.history?.firstTime,result.candles[0].time);assert.equal(result.history?.lastTime,result.candles.at(-1)?.time);
});

test('coverage attachment preserves the original object, candle identity and provider metadata',()=>{
  const data=makeData(40);data.history={requested:1,received:1,closed:1,firstTime:null,lastTime:null,status:'insufficient'};
  const before=structuredClone(data),result=withHistoryCoverage(data,800);
  assert.notEqual(result,data);assert.equal(result.candles,data.candles);assert.equal(result.instrument,data.instrument);
  assert.equal(result.source,data.source);assert.equal(result.adjustment,data.adjustment);assert.equal(result.warnings,data.warnings);
  assert.deepEqual(data,before);assert.equal(result.history?.status,'limited');assert.equal(data.history.requested,1);
});

test('the same coverage semantics apply to all markets and intervals without symbol-specific handling',()=>{
  const markets:Market[]=['crypto','us','cn'],intervals:Interval[]=['1m','5m','15m','30m','1h','4h','1d','1w','1M'];
  for(const market of markets)for(const interval of intervals){
    const data=makeData(40);data.instrument={...data.instrument,id:`${market}:SEARCH_RESULT`,market,symbol:'SEARCH_RESULT'};data.interval=interval;
    const result=withHistoryCoverage(data,800);
    assert.equal(result.history?.received,40);assert.equal(result.history?.closed,40);assert.equal(result.history?.status,'limited');
    assert.equal(result.instrument.market,market);assert.equal(result.interval,interval);
  }
});
