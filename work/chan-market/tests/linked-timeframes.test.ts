import assert from 'node:assert/strict';
import test from 'node:test';
import {linkedBars,barAtTime,fetchLinkedPeriod,fetchLinkedHistory,linkedHistoryCursor,linkedIdentity} from '../lib/linked-timeframes.ts';
import type {MarketData} from '../lib/market-types';

const day=Date.parse('2026-03-09T00:00Z')/1000;
const instrument={id:'crypto:BTCUSDT',name:'Bitcoin',market:'crypto',symbol:'BTCUSDT',currency:'USDT',exchange:'Binance'} as const;
const feed:MarketData={instrument,interval:'1d',source:'spot',adjustment:'unadjusted',warnings:[],delayNotice:'',availableIntervals:['1d'],
  asOf:'2026-03-12T00:00Z',candles:[0,1,2].map(i=>({time:day+i*86400,open:10,high:12,low:8,close:11,volume:2,closed:i!==2}))};

test('daily OHLC becomes readable at close, with no incomplete or future bars in replay',()=>{
  const rows=linkedBars(feed,day+86400*4);
  assert.equal(rows.length,2);
  assert.equal(barAtTime(rows,day+86400-1),-1);
  assert.equal(barAtTime(rows,day+86400),0);
  assert.equal(barAtTime(rows,day+86400*2-1),0);
  assert.equal(barAtTime(rows,day+86400*2),1);
  assert.equal(linkedBars(feed,day+86400-1).length,0);
  assert.equal(linkedBars({...feed,asOf:'2026-03-10T00:00Z'},Infinity).length,1);
});

test('linked fetch uses the selected market, period, symbol and abort signal and validates the response',async()=>{
  const aborter=new AbortController();
  await fetchLinkedPeriod(feed,'1d',aborter.signal,async(url,options)=>{
    assert.equal(url,'/api/candles?market=crypto&symbol=BTCUSDT&interval=1d');
    assert.equal(options?.signal,aborter.signal);return Response.json(feed);
  });
  for(const invalid of [{instrument:{...instrument,currency:'USD'}},{interval:'4h'},{instrument:{...instrument,symbol:'ETHUSDT'}}]){
    await assert.rejects(fetchLinkedPeriod(feed,'1d',aborter.signal,async()=>Response.json({...feed,...invalid})));
  }
});

test('deep replay uses a stable period cursor and requires a matching archived series',async()=>{
  const cursor=linkedHistoryCursor('4h',day+200*86400,day+3600);
  assert.equal(linkedHistoryCursor('4h',day+200*86400,day+3700),cursor);
  assert.equal(linkedHistoryCursor('4h',day+7200,day+3600),day+7200);
  const identity=linkedIdentity({...feed,interval:'4h'});
  const row={...feed.candles[0],time:cursor-14400};
  const result={...identity,status:'more',candles:[row]};
  const signal=new AbortController().signal;
  const fetched=await fetchLinkedHistory(identity,cursor,signal,async(url,options)=>{
    const params=new URL(String(url),'http://localhost').searchParams;
    assert.equal(params.get('before'),String(cursor));assert.equal(params.get('interval'),'4h');
    assert.equal(options?.signal,signal);return Response.json(result);
  });
  assert.deepEqual(fetched.bars,[row]);
  for(const mismatch of [{source:'other'},{adjustment:'adjusted'},{candles:[{...row,closed:false}]},{candles:[{...row,time:cursor}]}])
    await assert.rejects(fetchLinkedHistory(identity,cursor,signal,async()=>Response.json({...result,...mismatch})));
});
