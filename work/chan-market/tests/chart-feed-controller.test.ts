import assert from 'node:assert/strict';
import test from 'node:test';
import {createChartFeedController,type ChartSnapshot} from '../lib/market-context-loader.ts';
import type {Interval,MarketData} from '../lib/market-types.ts';

const base={market:'crypto' as const,symbol:'BTCUSDT',interval:'1h' as const};
function response(symbol:string,interval:Interval,close:number) {
  const data:MarketData={
    instrument:{id:`crypto:${symbol}`,market:'crypto',symbol,name:symbol,currency:'USDT',exchange:'Binance'},
    interval,candles:[{time:1700000000,open:close,high:close+1,low:close-1,close,volume:10,closed:true}],
    source:'Binance',asOf:'2024-01-01T00:00:00Z',adjustment:'不复权',warnings:[],delayNotice:'',availableIntervals:['1h','4h','1M'],
  };
  return new Response(JSON.stringify(data));
}
function deferredFeed(){
  const pending:{url:string;signal:AbortSignal;resolve:(response:Response)=>void}[]=[];
  const controller=createChartFeedController((url,{signal})=>new Promise(resolve=>pending.push({url,signal,resolve})));
  const snapshots:ChartSnapshot[]=[],errors:string[]=[];
  function load(symbol:string,background=false,interval:Interval='1h'){
    return controller.load({...base,symbol,interval,background,onSnapshot:snapshot=>snapshots.push(snapshot),onPrimaryError:message=>errors.push(message)});
  }
  function settle(index:number,symbol:string,interval:Interval,close:number){pending[index].resolve(response(symbol,interval,close));}
  return {pending,controller,load,settle,snapshots,errors};
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('foreground candles arrive early, with the higher status bound to the same primary response',async()=>{
  const feed=deferredFeed(),done=feed.load('BTCUSDT');
  feed.settle(0,'BTCUSDT','1h',100);
  await tick();
  assert.deepEqual(feed.snapshots.map(s=>s.higher.status),['loading']);
  feed.settle(1,'BTCUSDT','4h',120);
  await done;
  const [preview,ready]=feed.snapshots;
  assert.equal(ready.data,preview.data);
  assert.equal(ready.receivedAt,preview.receivedAt);
  assert.equal(ready.higher.status,'ready');
  assert.equal(ready.higher.data?.candles[0].close,120);
});

test('timer ticks during a slow refresh keep one request and deliver only the new coherent pair',async()=>{
  const feed=deferredFeed(),first=feed.load('BTCUSDT');
  feed.settle(0,'BTCUSDT','1h',100);feed.settle(1,'BTCUSDT','4h',120);
  await first;
  const next=feed.load('BTCUSDT',true);
  feed.settle(2,'BTCUSDT','1h',200);
  await tick();
  await feed.load('BTCUSDT',true);
  assert.equal(feed.pending.length,4);
  assert.equal(feed.pending[3].signal.aborted,false);
  assert.equal(feed.snapshots.at(-1)?.data.candles[0].close,100);
  feed.settle(3,'BTCUSDT','4h',240);
  await next;
  assert.deepEqual(feed.snapshots.slice(2).map(s=>[s.data.candles[0].close,s.higher.data?.candles[0].close]),[[200,240]]);
});

test('late parent and error from two cancelled selections cannot replace the third selection',async()=>{
  const feed=deferredFeed(),btc=feed.load('BTCUSDT');
  feed.settle(0,'BTCUSDT','1h',100);await tick();
  const eth=feed.load('ETHUSDT'),sol=feed.load('SOLUSDT');
  feed.settle(1,'BTCUSDT','4h',120);
  feed.pending[2].resolve(new Response('{}',{status:503}));feed.settle(3,'ETHUSDT','4h',100);
  await Promise.all([btc,eth]);
  await feed.load('SOLUSDT',true);
  assert.equal(feed.pending.length,6,'completion of a cancelled request must not clear the active request');
  feed.settle(4,'SOLUSDT','1h',50);feed.settle(5,'SOLUSDT','4h',60);
  await sol;
  assert.deepEqual(feed.errors,[]);
  assert.deepEqual(feed.snapshots.map(s=>[s.data.instrument.symbol,s.higher.status]),[['BTCUSDT','loading'],['SOLUSDT','loading'],['SOLUSDT','ready']]);
});

test('replay cancellation suppresses a late parent, and returning to live starts a fresh pair',async()=>{
  const feed=deferredFeed(),done=feed.load('BTCUSDT');
  feed.settle(0,'BTCUSDT','1h',100);await tick();
  feed.controller.cancel();
  feed.settle(1,'BTCUSDT','4h',120);await done;
  assert.deepEqual(feed.snapshots.map(s=>s.higher.status),['loading']);
  const fresh=feed.load('BTCUSDT',true);
  feed.settle(2,'BTCUSDT','1h',200);feed.settle(3,'BTCUSDT','4h',240);
  await fresh;
  assert.deepEqual(feed.snapshots.map(s=>s.higher.status),['loading','ready']);
  assert.equal(feed.snapshots.at(-1)?.data.candles[0].close,200);
});

test('monthly refresh emits its snapshot when the primary settles even without a parent',async()=>{
  const feed=deferredFeed(),done=feed.load('BTCUSDT',true,'1M');
  feed.settle(0,'BTCUSDT','1M',100);
  await done;
  assert.equal(feed.pending.length,1);
  assert.deepEqual(feed.snapshots.map(s=>s.higher.status),['none']);
});
