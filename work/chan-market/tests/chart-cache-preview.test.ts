import test from 'node:test';
import assert from 'node:assert/strict';
import {createChartFeedController} from '../lib/market-context-loader.ts';

const parameters={market:'us',symbol:'AAPL',interval:'1M',background:false} as const;
const next=()=>new Promise(resolve=>setImmediate(resolve));
function data(close:number){
  return Response.json({instrument:{id:'us:AAPL',market:'us',symbol:'AAPL',name:'Apple',currency:'USD',exchange:'Nasdaq'},
    interval:'1M',source:'Yahoo Finance',asOf:'2026-11-20T20:00:00Z',adjustment:'原始OHLC',delayNotice:'',warnings:[],availableIntervals:['1M'],
    candles:[{time:1754006400,open:1,high:20,low:1,close,volume:10,closed:true}]});
}
function delayed(){
  let resolve!:(response:Response)=>void;
  const promise=new Promise<Response>(r=>{resolve=r;});
  return {promise,resolve};
}
test('preview uses its original timestamp, never reports a network success, and gives way to fresh candles',async()=>{
  const live=delayed(),events:string[]=[];
  const app=createChartFeedController(url=>url.startsWith('/api/cached-')?Promise.resolve(data(5)):live.promise);
  const running=app.load({...parameters,onCache:s=>{
    assert.equal(s.cached,true);assert.equal(s.receivedAt,Date.parse(s.data.asOf));events.push('saved');
  },onSnapshot:s=>{assert.equal(s.data.candles[0].close,8);assert.equal(s.cached,undefined);events.push('live');},onPrimaryError:()=>assert.fail('unexpected error')});
  await next();assert.deepEqual(events,['saved']);
  live.resolve(data(8));await running;assert.ok(events.slice(1).every(s=>s==='live'));assert.ok(events.includes('live'));
});
test('an offline response still permits late saved data, but cancelled selections and successful refreshes do not',async()=>{
  for(const mode of ['offline','cancel','fresh']){
    const cache=delayed(),events:string[]=[];
    const app=createChartFeedController(url=>url.startsWith('/api/cached-')?cache.promise:Promise.resolve(mode==='fresh'?data(8):new Response(null,{status:502})));
    await app.load({...parameters,onCache:()=>events.push('saved'),onPrimaryError:()=>events.push('failed'),onSnapshot:()=>events.push('live')});
    if(mode==='cancel')app.cancel();
    cache.resolve(data(5));await next();
    assert.equal(events.includes('saved'),mode==='offline');
    assert.equal(events.includes('failed'),mode!=='fresh');
  }
});
