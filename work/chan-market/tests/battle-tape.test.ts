import test from 'node:test';
import assert from 'node:assert/strict';
import {createBattleReader} from '../lib/battle-tape.ts';

const start=Date.UTC(2026,10,22,1,2,3);
const query=(symbol='BTCUSDT')=>new URLSearchParams({symbol});
const json=(data:unknown,ms=start)=>Response.json(data,{headers:{date:new Date(ms).toUTCString()}});
const book={lastUpdateId:123,bids:[['99.99','4'],['99.90','3'],['99','12']],asks:[['100.01','2'],['100.15','1'],['103','4']]};
const print=(id:number,ms:number,bid:boolean,qty='1')=>({id,time:ms,price:'100',qty,quoteQty:String(Number(qty)*100),isBuyerMaker:bid});
const fallbackRows=[{instId:'BTC-USDT',tradeId:'21',ts:String(start-1500),px:'100',sz:'2',side:'buy'}];
const fallbackBook={code:'0',data:[{bids:book.bids,asks:book.asks,ts:String(start-500)}]};
const mock=(handle:(url:string)=>Response)=>async(input:RequestInfo|URL)=>handle(String(input));

test('taker flow uses actual trade notionals; displayed order amounts include only levels within the band',async()=>{
  let calls=0;
  const read=createBattleReader(mock(url=>{
    calls++;return json(url.includes('/trades?')?[print(1,start-61000,true),print(2,start-55100,false,'2'),print(3,start-4000,true)]:book);
  }),()=>start);
  const snap=await read(query());
  assert.equal(snap.symbol,'BTCUSDT');assert.equal(snap.currency,'USDT');
  assert.deepEqual([snap.flow?.buy,snap.flow?.sell,snap.flow?.count,snap.flow?.limited],[200,100,2,false]);
  assert.equal(snap.flow!.buckets[0].buy,200);assert.equal(snap.flow!.buckets[5].sell,100);
  assert.equal(snap.flow!.largest.amount,200);assert.equal(snap.flow!.largest.side,'buy');
  assert.deepEqual([snap.book!.bids,snap.book!.asks,snap.book!.bid,snap.book!.ask,snap.book!.limited],[2,2,99.99*4+99.90*3,100.01*2+100.15,false]);
  assert.equal(await read(query()),snap);assert.equal(calls,2);
  await assert.rejects(read(query('BTCUSD')),RangeError);
  await assert.rejects(read(query('BTCUSDT&interval=1d')),RangeError);
});

test('a partial source never borrows the other venue’s order book or tape',async()=>{
  const read=createBattleReader(mock(url=>{
    if(url.includes('binance.vision'))return json(url.includes('/trades?')?[print(1,start-1000,false)]:{...book,asks:[['90','2']]});
    return json(url.includes('/trades?')?{code:'0',data:fallbackRows}:fallbackBook);
  }),()=>start);
  const s=await read(query());
  assert.equal(s.source,'OKX');assert.equal(s.flow!.buy,200);assert.equal(s.book!.observedAt,(start-500)/1000);
  assert.deepEqual(s.flow!.recentTrades,[{id:'OKX/BTCUSDT/21',time:(start-1500)/1000,side:'buy',notional:200}]);

  const partial=createBattleReader(mock(url=>{
    if(url.includes('binance.vision'))return json(url.includes('/trades?')?[print(1,start-1000,false)]:book,url.includes('/trades?')?start:start-16000);
    return json(url.includes('/trades?')?{code:'0',data:[{...fallbackRows[0],instId:'ETH-USDT'}]}:fallbackBook);
  }),()=>start);
  const result=await partial(query());
  assert.equal(result.source,'Binance');assert.equal(result.book,null);assert.equal(result.flow!.buy,100);
});

test('snapshot price uses the newest eligible match, including the partial second, with numeric ID ordering',async()=>{
  const ms=start+780;
  const rows=[
    {...fallbackRows[0],ts:String(start-1500),tradeId:'11',px:'222',sz:'9999'},
    {...fallbackRows[0],ts:String(start+300),tradeId:'10000000000000000000',px:'120'},
    {...fallbackRows[0],ts:String(start+300),tradeId:'9999999999999999999',px:'119'},
    {...fallbackRows[0],ts:String(ms+1),tradeId:'10000000000000000001',px:'121'},
  ];
  const read=createBattleReader(mock(url=>json(url.includes('/trades?')?{code:'0',data:rows}:fallbackBook,ms)),()=>ms);
  const snap=await read(new URLSearchParams({symbol:'BTCUSDT',venue:'OKX'}));
  assert.deepEqual(snap.lastTrade,{time:(start+300)/1000,id:'10000000000000000000',price:120});
  assert.equal(snap.flow!.largest.price,222);
});

test('the first valid trade can supply a price before the first one-second bucket is closed',async()=>{
  const read=createBattleReader(mock(url=>json(url.includes('/trades?')?[print(12,start,false)]:{})),()=>start+33);
  const snap=await read(new URLSearchParams({symbol:'BTCUSDT',venue:'Binance'}));
  assert.equal(snap.flow,null);assert.equal(snap.book,null);
  assert.deepEqual(snap.lastTrade,{time:start/1000,id:'12',price:100});
});

test('a snapshot pinned to the active push venue has a separate cache from automatic selection',async()=>{
  const read=createBattleReader(mock(url=>{
    if(url.includes('binance.vision'))return json(url.includes('/trades?')?[print(5,start-1200,false)]:book);
    return json(url.includes('/trades?')?{code:'0',data:fallbackRows}:fallbackBook);
  }),()=>start);
  const auto=await read(query());
  const alternate=new URLSearchParams({symbol:'BTCUSDT',venue:'OKX'});
  const pinned=await read(alternate);
  assert.equal(auto.source,'Binance');assert.equal(pinned.source,'OKX');
  assert.equal(await read(query()),auto);
  assert.equal(await read(alternate),pinned);
  await assert.rejects(read(new URLSearchParams({symbol:'BTCUSDT',venue:'Unknown'})),RangeError);
});

test('recent effects sample is bounded, includes a recent minority-side match and keeps stable IDs across polls',async()=>{
  let ms=start;
  const rows=[print(1,start-14000,true),print(2,start-10000,true),
    ...Array.from({length:40},(_,i)=>print(i+3,start-3000+i,false))];
  const read=createBattleReader(mock(url=>json(url.includes('/trades?')?rows:book,ms)),()=>ms);
  const flow=(await read(query())).flow!;
  const events=flow.recentTrades!;
  assert.equal(flow.count,42);
  assert.equal(events.length,24);
  assert.deepEqual(events[0],{id:'Binance/BTCUSDT/2',time:(start-10000)/1000,side:'sell',notional:100});
  assert.ok(events.slice(1).every((e,i)=>e.side==='buy'&&e.time>=events[i].time));
  ms+=4000;
  const overlap=(await read(query())).flow!.recentTrades!;
  assert.equal(overlap.at(-1)!.id,events.at(-1)!.id);
});

test('rolling samples stitch only through verified trades; cropped depth remains marked',async()=>{
  let ms=start,step=0;
  const dense={...book,bids:Array.from({length:100},(_,i)=>[(99.999-i*.0001).toFixed(4),'1'])};
  const read=createBattleReader(mock(url=>{
    const first=step===0?0:step===1?800:4000;
    const rows=Array.from({length:1000},(_,i)=>print(first+i,start-31000+(i+first)*30,true));
    return json(url.includes('/trades?')?rows:dense,ms);
  }),()=>ms);
  const first=await read(query());assert.equal(first.flow!.limited,true);assert.equal(first.book!.limited,true);
  step=1;ms+=31000;
  const joined=await read(query());
  assert.equal(joined.flow!.limited,false);
  assert.equal(joined.flow!.count,1733);
  step=2;ms=start+120000;
  const gap=await read(query());assert.equal(gap.flow!.limited,true);
  assert.equal(gap.flow!.count,1000);
});

test('malformed, stale and duplicate rows cannot create synthetic flow or a plausible neutral result',async()=>{
  const duplicate=print(2,start-1000,false);
  for(const rows of [[duplicate,duplicate],[print(1,start-61000,true)],[{...duplicate,isBuyerMaker:'false'}],[{...duplicate,qty:''}]]){
    const read=createBattleReader(mock(url=>json(url.includes('binance.vision')&&url.includes('/trades?')?rows:{})),()=>start);
    await assert.rejects(read(query()),/暂未取得/);
  }
});

test('recent snapshots retain a grenade ahead of newer small trades while keeping the largest tiers',async()=>{
  const rows=[print(1,start-4000,false,'100'),print(2,start-3900,true,'10000'),
    ...Array.from({length:35},(_,i)=>print(3+i,start-3000+i,false))];
  const read=createBattleReader(mock(url=>json(url.includes('/trades?')?rows:book)),()=>start);
  const sample=(await read(query())).flow!.recentTrades!;
  assert.equal(sample.length,24);
  assert.deepEqual(sample.slice(0,2).map(p=>p.notional),[10_000,1_000_000]);
});
