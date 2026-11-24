import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchHistoricalMinutes} from '../lib/historical-minutes.ts';
import type {Instrument} from '../lib/market-types';

const start=Date.UTC(2025,0,1)/1000;
const base:Instrument={id:'crypto:BTCUSDT',symbol:'BTCUSDT',currency:'USDT',market:'crypto',exchange:'Binance',name:'Bitcoin'};
const feed={instrument:base,source:'Binance 公共现货行情 · BTCUSDT',adjustment:'原始成交价格，不复权'};
const minute=(t:number)=>[t*1000,'10','12','9','11','3',t*1000+59999];
const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});

test('minute downloads use non-overlapping exact spot windows and report only complete minute history',async()=>{
  const requested:{start:number,end:number,count:number}[]=[];
  const result=await fetchHistoricalMinutes(feed,start,start+1010*60,{fetcher:async (input,init)=>{
    const u=new URL(String(input)),a=Number(u.searchParams.get('startTime'))/1000,n=Number(u.searchParams.get('limit'));
    requested.push({start:a,end:Number(u.searchParams.get('endTime')),count:n});
    assert.equal(u.host,'data-api.binance.vision');assert.equal(u.searchParams.get('symbol'),'BTCUSDT');
    assert.equal(init?.credentials,'omit');assert.ok(init?.signal);
    return json(Array.from({length:n},(_,i)=>minute(a+i*60)));
  }});
  assert.deepEqual(requested,[{start,end:(start+1000*60)*1000-1,count:1000},{start:start+1000*60,end:(start+1010*60)*1000-1,count:10}]);
  assert.equal(result.candles.length,1010);assert.equal(result.candles.at(-1)?.time,start+1009*60);
  assert.equal(result.instrument.currency,'USDT');assert.ok(result.candles.every(b=>b.closed===true));
});

test('a switched quote, unknown venue, incomplete grid or unconfirmed minute cannot be used as replay evidence',async()=>{
  const never=async()=>{throw new Error('Unexpected request')};
  for(const invalid of [{...feed,source:'Binance 公共现货行情 · BTCUSD'},
    {...feed,instrument:{...base,exchange:'Synthetic'}},{...feed,adjustment:'调整价格'}])
    await assert.rejects(fetchHistoricalMinutes(invalid,start,start+120,{fetcher:never}),/^Error: (Exact-source|Spot source)/);
  for(const rows of [[minute(start)],[minute(start),minute(start)],[minute(start),minute(start+120)],
    [[start*1000,'','','','','',start*1000+59999],minute(start+60)],
    [[...minute(start).slice(0,6),start*1000+3],minute(start+60)]])
    await assert.rejects(fetchHistoricalMinutes(feed,start,start+120,{fetcher:async()=>json(rows)}));
  await assert.rejects(fetchHistoricalMinutes(feed,start,start+59,{fetcher:never}),/aligned|closed interval/);
});

test('a venue envelope for another instrument or a non-final minute is rejected',async()=>{
  const bybit={...feed,instrument:{...base,exchange:'Bybit'},source:'Bybit 公共现货行情 · BTCUSDT'};
  await assert.rejects(fetchHistoricalMinutes(bybit,start,start+60,{fetcher:async()=>json({retCode:0,result:{category:'spot',symbol:'BTCUSD',list:[minute(start)]}})}),/response/);
  const okx={...feed,instrument:{...base,exchange:'OKX'},source:'OKX 公共现货行情 · BTC-USDT'};
  await assert.rejects(fetchHistoricalMinutes(okx,start,start+60,{fetcher:async()=>json({code:'0',data:[[...minute(start).slice(0,6),'1','1','0']]})}),/Unconfirmed/);
});
