import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHistoryCache} from './history-cache.mjs';
import {createWatchlistSync,isMarketActiveForSync} from './watchlist-sync.mjs';

const start=Date.parse('2026-11-23T00:00:00Z')/1000;
const makeBars=(from,count,span=60)=>Array.from({length:count},(_,i)=>{
  const time=from+i*span;
  return {time,open:100+i*0.01,high:102+i*0.01,low:99+i*0.01,close:101+i*0.01,volume:1000,closed:true};
});

test('isMarketActiveForSync distinguishes crypto, CN, commodity, and US regular vs Longbridge overnight hours',()=>{
  assert.equal(isMarketActiveForSync('crypto','1m',Date.parse('2026-11-22T03:00:00Z')),true);
  // Saturday UTC is closed for CME commodity
  assert.equal(isMarketActiveForSync('commodity','1h',Date.parse('2026-11-21T12:00:00Z')),false);
  assert.equal(isMarketActiveForSync('commodity','1h',Date.parse('2026-11-23T12:00:00Z')),true);
  // Monday 10:00 CST (02:00Z) active for CN, Monday 20:00 CST (12:00Z) inactive
  assert.equal(isMarketActiveForSync('cn','1m',Date.parse('2026-11-23T02:00:00Z')),true);
  assert.equal(isMarketActiveForSync('cn','1m',Date.parse('2026-11-23T12:00:00Z')),false);
  // Sunday 21:00 EST (2026-11-23T02:00:00Z): overnight active for Longbridge 1m, closed for regular Yahoo/1d
  assert.equal(isMarketActiveForSync('us','1m',Date.parse('2026-11-23T02:00:00Z'),{longbridgeEnabled:true}),true);
  assert.equal(isMarketActiveForSync('us','1m',Date.parse('2026-11-23T02:00:00Z'),{longbridgeEnabled:false}),false);
  assert.equal(isMarketActiveForSync('us','1d',Date.parse('2026-11-23T02:00:00Z'),{longbridgeEnabled:true}),false);
  // Saturday afternoon EST: closed even with Longbridge
  assert.equal(isMarketActiveForSync('us','1m',Date.parse('2026-11-21T18:00:00Z'),{longbridgeEnabled:true}),false);
});

test('watchlist-sync performs incremental sync and multi-cycle round-robin backfill until target depth or boundary',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trend-sync-'));
  const filename=join(dir,'history.sqlite');
  let clockMs=Date.parse('2026-11-24T12:00:00Z');
  const nowSec=Math.floor(clockMs/1000);
  const olderCalls=[];
  const archive=createHistoryCache({
    filename,
    getCandles:async(market,symbol,interval,limit)=>{
      const span=interval==='1d'?86400:60;
      const latest=nowSec-(nowSec%span)-span;
      const bars=makeBars(latest-(limit-1)*span,limit,span);
      return {
        instrument:{id:`${market}:${symbol}`,market,symbol,name:symbol,exchange:'Binance',currency:'USDT'},
        interval,candles:bars,source:'Binance 公共现货行情 · '+symbol,asOf:new Date(clockMs).toISOString(),
        adjustment:'原始成交价格，不复权',delayNotice:'',warnings:[],availableIntervals:[interval],
      };
    },
    getOlderHistory:async params=>{
      const p=Object.fromEntries(params);
      olderCalls.push(p);
      const span=p.interval==='1d'?86400:60;
      const before=Number(p.before);
      const limit=Number(p.limit);
      const count=olderCalls.filter(c=>c.symbol===p.symbol&&c.interval===p.interval).length>=2?0:limit;
      const bars=count?makeBars(before-count*span,count,span):[];
      return {market:p.market,symbol:p.symbol,interval:p.interval,source:p.source,adjustment:p.adjustment,
        status:bars.length?'more':'end',candles:bars};
    },
  });
  try{
    archive.setWatchlist([
      {id:'crypto:BTCUSDT',market:'crypto',symbol:'BTCUSDT',name:'Bitcoin',exchange:'Binance',currency:'USDT'},
      {id:'crypto:ETHUSDT',market:'crypto',symbol:'ETHUSDT',name:'Ethereum',exchange:'Binance',currency:'USDT'},
    ]);
    const sync=createWatchlistSync({
      archive,
      intervals:['1m'],
      delayMs:0,
      now:()=>clockMs,
      backfillDays:{'1m':1},
    });
    // Cycle 1: incremental (800 bars = ~13.3h) + 1 backfill page (500 bars = ~8.3h) per symbol
    await sync.runOnce();
    const s1=archive.listSeriesStatus({pinnedOnly:true});
    assert.equal(s1.length,2);
    assert.equal(s1[0].barCount,1300);
    assert.equal(s1[1].barCount,1300);
    assert.equal(s1[0].backfillDone,false);
    // Cycle 2: next backfill page hits 'end', marking backfillDone=true
    await sync.runOnce();
    const s2=archive.listSeriesStatus({pinnedOnly:true});
    assert.equal(s2[0].backfillDone,true);
    assert.equal(s2[1].backfillDone,true);
    // Cycle 3 (immediately after): neither incremental nor backfill triggers
    const callsBefore=olderCalls.length;
    await sync.runOnce();
    assert.equal(olderCalls.length,callsBefore);
  }finally{
    archive.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('watchlist-sync yields while interactive request is busy and applies backoff on 429 errors',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trend-sync-backoff-'));
  const filename=join(dir,'history.sqlite');
  let clockMs=Date.parse('2026-11-24T12:00:00Z');
  let interactiveBusy=false;
  let calls=0;
  const archive=createHistoryCache({
    filename,
    getCandles:async(market,symbol,interval)=>{
      calls++;
      assert.equal(interactiveBusy,false,'must never execute fetch while interactive is busy');
      if(calls===1){
        const err=new Error('Rate limited');
        err.status=429;
        throw err;
      }
      const span=60;
      const latest=Math.floor(clockMs/1000)-60;
      return {
        instrument:{id:`${market}:${symbol}`,market,symbol,name:symbol,exchange:'Binance',currency:'USDT'},
        interval,candles:makeBars(latest-99*span,100,span),source:'Binance 公共现货行情 · '+symbol,
        asOf:new Date(clockMs).toISOString(),adjustment:'原始成交价格，不复权',delayNotice:'',warnings:[],availableIntervals:[interval],
      };
    },
    getOlderHistory:async()=>({status:'end',candles:[]}),
  });
  try{
    archive.setWatchlist([{id:'crypto:BTCUSDT',market:'crypto',symbol:'BTCUSDT',name:'Bitcoin',exchange:'Binance',currency:'USDT'}]);
    const sync=createWatchlistSync({
      archive,
      intervals:['1m'],
      delayMs:0,
      globalCooldownMs:0,
      now:()=>clockMs,
    });
    // 1. 429 triggers 5-minute backoff
    await sync.runOnce();
    assert.equal(calls,1);
    // 2. Within backoff window (2 minutes later): skipped
    clockMs+=2*60000;
    await sync.runOnce();
    assert.equal(calls,1);
    // 3. Past 5-minute backoff: succeeds
    clockMs+=4*60000;
    await sync.runOnce();
    assert.equal(calls,2);
    assert.equal(archive.listSeriesStatus({pinnedOnly:true})[0].barCount,100);

    // 4. Interactive yield test
    const syncYield=createWatchlistSync({
      archive,
      intervals:['1m'],
      delayMs:0,
      now:()=>clockMs,
      isInteractiveBusy:()=>interactiveBusy,
    });
    clockMs+=10*60000;
    interactiveBusy=true;
    const pending=syncYield.runOnce();
    await pause(50);
    assert.equal(calls,2);
    interactiveBusy=false;
    await pending;
    assert.equal(calls,3);
  }finally{
    archive.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('watchlist-sync start, notifyWatchlistChanged, and stop manage lifecycle cleanly without hanging',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trend-sync-life-'));
  const filename=join(dir,'history.sqlite');
  let clockMs=Date.parse('2026-11-24T12:00:00Z');
  const seen=[];
  const archive=createHistoryCache({
    filename,
    getCandles:async(market,symbol,interval)=>{
      seen.push(`${symbol}:${interval}`);
      return {
        instrument:{id:`${market}:${symbol}`,market,symbol,name:symbol,exchange:'Binance',currency:'USDT'},
        interval,candles:makeBars(start,40,60),source:'Binance 公共现货行情 · '+symbol,
        asOf:new Date(clockMs).toISOString(),adjustment:'原始成交价格，不复权',delayNotice:'',warnings:[],availableIntervals:[interval],
      };
    },
    getOlderHistory:async()=>({status:'end',candles:[]}),
  });
  const sync=createWatchlistSync({archive,intervals:['1m'],delayMs:0,tickMs:60000,now:()=>clockMs});
  try{
    sync.start();
    await pause(30);
    archive.setWatchlist([{id:'crypto:SOLUSDT',market:'crypto',symbol:'SOLUSDT',name:'Solana',exchange:'Binance',currency:'USDT'}]);
    sync.notifyWatchlistChanged();
    await pause(50);
    assert.ok(seen.includes('SOLUSDT:1m'));
    await sync.stop();
    assert.equal(sync.status().running,false);
  }finally{
    await sync.stop();
    archive.close();
    await rm(dir,{recursive:true,force:true});
  }
});
