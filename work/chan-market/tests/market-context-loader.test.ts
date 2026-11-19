import test from 'node:test';
import assert from 'node:assert/strict';
import {loadMarketContext,type HigherFeed} from '../lib/market-context-loader.ts';
import type {Interval,MarketData} from '../lib/market-types';
const start=Date.parse('2026-01-05T00:00:00Z')/1000;
const value=(interval:Interval,count=1):MarketData=>({instrument:{id:'crypto:BTCUSDT',market:'crypto',symbol:'BTCUSDT',name:'Bitcoin',currency:'USDT',exchange:'Kraken'},interval,candles:Array.from({length:count},(_,i)=>({time:start+i*3600,open:100,high:103,low:99,close:102,volume:100,closed:true})),source:'Kraken 公共现货行情 · XBTUSDT',adjustment:'不复权',asOf:'2026-11-14T00:00:00Z',delayNotice:'',warnings:[],availableIntervals:['1h','4h']});
const result=(interval:Interval)=>new Response(JSON.stringify(value(interval)));
const base={market:'crypto' as const,symbol:'BTCUSDT',interval:'1h' as const};
test('parent failure leaves primary available and explicitly marks parent unavailable',async()=>{
  const primary:MarketData[]=[],higher:HigherFeed[]=[],errors:string[]=[];
  await loadMarketContext({...base,signal:new AbortController().signal,onPrimary:d=>primary.push(d),onPrimaryError:e=>errors.push(e),onHigher:h=>higher.push(h),fetcher:async url=>url.endsWith('4h')?new Response('{}',{status:502}):result('1h')});
  assert.equal(primary.length,1);assert.equal(errors.length,0);assert.equal(higher.at(-1)?.status,'error');
});
test('primary renders without waiting for a slow parent',async()=>{
  let finish!:(r:Response)=>void;let loaded=false;
  const parent=new Promise<Response>(resolve=>{finish=resolve;});
  const task=loadMarketContext({...base,signal:new AbortController().signal,onPrimary:()=>{loaded=true;},onPrimaryError:()=>{},onHigher:()=>{},fetcher:url=>url.endsWith('4h')?parent:Promise.resolve(result('1h'))});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(loaded,true);
  finish(result('4h'));await task;
});
test('aborted old requests cannot overwrite another selection',async()=>{
  const controller=new AbortController();let finish!:(r:Response)=>void;let updates=0;
  const response=new Promise<Response>(resolve=>{finish=resolve;});
  const task=loadMarketContext({...base,interval:'1M',signal:controller.signal,onPrimary:()=>updates++,onPrimaryError:()=>updates++,onHigher:()=>{},fetcher:()=>response});
  controller.abort();finish(result('1M'));await task;assert.equal(updates,0);
});
test('wrong interval is rejected rather than analysed as a parent',async()=>{
  let status='';
  await loadMarketContext({...base,signal:new AbortController().signal,onPrimary:()=>{},onPrimaryError:()=>{},onHigher:h=>{status=h.status;},fetcher:async()=>result('1h')});
  assert.equal(status,'error');
});
test('monthly analysis does not request an invented higher timeframe',async()=>{
  let requests=0;let higher:HigherFeed|undefined;
  await loadMarketContext({...base,interval:'1M',signal:new AbortController().signal,onPrimary:()=>{},onPrimaryError:()=>{},onHigher:h=>{higher=h;},fetcher:async()=>{requests++;return result('1M');}});
  assert.equal(requests,1);assert.equal(higher?.status,'none');
});
test('compatible independently loaded parent takes priority over a complete local derivation',async()=>{
  const higher:HigherFeed[]=[];
  await loadMarketContext({...base,signal:new AbortController().signal,onPrimary:()=>{},onPrimaryError:()=>{},onHigher:h=>higher.push(h),fetcher:async url=>new Response(JSON.stringify(value(url.endsWith('4h')?'4h':'1h',160)))});
  assert.equal(higher.at(-1)?.status,'ready');assert.equal(higher.at(-1)?.data?.candles.length,160);
  assert.equal(higher.at(-1)?.data?.source.includes('真实同源聚合'),false);
});
test('failed, different-provider and different-adjustment parent falls back to complete primary aggregation',async()=>{
  for(const mode of ['failure','provider','adjustment']) {
    const primary:MarketData[]=[],higher:HigherFeed[]=[];
    await loadMarketContext({...base,signal:new AbortController().signal,onPrimary:d=>primary.push(d),onPrimaryError:()=>{},onHigher:h=>higher.push(h),fetcher:async url=>{
      if(!url.endsWith('4h'))return new Response(JSON.stringify(value('1h',160)));
      if(mode==='failure')return new Response('{}',{status:502});
      const parent=value('4h',80);if(mode==='provider')parent.source='Binance';else parent.adjustment='前复权';
      return new Response(JSON.stringify(parent));
    }});
    assert.equal(primary.length,1);assert.equal(higher.at(-1)?.status,'ready');
    assert.equal(higher.at(-1)?.data?.candles.length,40);
    assert.equal(higher.at(-1)?.data?.source,primary[0].source+' · 真实同源聚合');
    assert.equal(higher.at(-1)?.data?.adjustment,primary[0].adjustment);
  }
});
test('source mismatch with insufficient local history stays unavailable',async()=>{
  let higher:HigherFeed|undefined;
  await loadMarketContext({...base,signal:new AbortController().signal,onPrimary:()=>{},onPrimaryError:()=>{},onHigher:h=>{higher=h;},fetcher:async url=>{
    const data=value(url.endsWith('4h')?'4h':'1h');if(data.interval==='4h')data.source='Binance';
    return new Response(JSON.stringify(data));
  }});
  assert.equal(higher?.status,'error');assert.equal(higher?.data,undefined);
});
test('an abort after the primary rendered suppresses late parent and derived fallback',async()=>{
  const controller=new AbortController(),higher:HigherFeed[]=[];let primaryCalls=0,finish!:(r:Response)=>void;
  const parent=new Promise<Response>(resolve=>{finish=resolve;});
  const task=loadMarketContext({...base,signal:controller.signal,onPrimary:()=>{primaryCalls++;},onPrimaryError:()=>{},onHigher:h=>higher.push(h),fetcher:url=>url.endsWith('4h')?parent:Promise.resolve(new Response(JSON.stringify(value('1h',160))))});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(primaryCalls,1);controller.abort();
  finish(new Response('{}',{status:502}));await task;
  assert.deepEqual(higher.map(h=>h.status),['loading']);
});
test('a fast parent waits for primary source compatibility before publishing readiness',async()=>{
  const higher:HigherFeed[]=[];let finish!:(r:Response)=>void;
  const primary=new Promise<Response>(resolve=>{finish=resolve;});
  const task=loadMarketContext({...base,signal:new AbortController().signal,onPrimary:()=>{},onPrimaryError:()=>{},onHigher:h=>higher.push(h),fetcher:url=>url.endsWith('4h')?Promise.resolve(result('4h')):primary});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(higher.map(h=>h.status),['loading']);
  finish(result('1h'));await task;assert.equal(higher.at(-1)?.status,'ready');
});
