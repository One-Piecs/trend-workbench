import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHistoryCache} from './history-cache.mjs';

const start=Date.parse('2026-01-01T00:00:00Z')/1000;
const instrument={market:'crypto',symbol:'BTCUSDT',id:'crypto:BTCUSDT',name:'Bitcoin',exchange:'',currency:'USDT'};
const source='Binance 公共现货行情 · BTCUSDT',adjustment='原始成交价格，不复权';
const minute=i=>start+i*60;
const bar=(i)=>({time:minute(i),open:10,high:12,low:9,close:11,volume:i+1,closed:true});
const range=(from,to)=>Array.from({length:to-from+1},(_,i)=>bar(i+from));
const feed=(candles,patch={})=>({instrument,interval:'1m',source,adjustment,delayNotice:'',warnings:[],availableIntervals:['1m'],
  asOf:new Date((minute(5000))*1000).toISOString(),candles,...patch});
const pageParams=(before)=>new URLSearchParams({market:'crypto',symbol:'BTCUSDT',interval:'1m',source,adjustment,before:String(before),limit:'500'});
function fake(from=0,to=799){
  let current=feed(range(from,to)),fetched=[],requests=[];
  return {
    getCandles:async(_m,_s,_i,n)=>{fetched.push(n);return {...current,candles:current.candles.slice(-n)};},
    getOlderHistory:async p=>{requests.push(p);const i=(Number(p.get('before'))-start)/60;
      return {...Object.fromEntries(p),status:'more',candles:range(Math.max(0,i-Number(p.get('limit'))),i-1)};},
    set:v=>{current=v;},fetched,requests,
  };
}
async function fetchBars(archive){return archive.candles('crypto','BTCUSDT','1m',800);}

test('reopen database, show only completed cached bars, merge a corrected overlap and preserve forming updates only in memory',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trend-db-')),filename=join(dir,'history.sqlite'),io=fake();
  let archive=createHistoryCache({filename,...io});
  try{
    io.set(feed([...range(0,798),{...bar(799),closed:false}]));
    assert.equal((await fetchBars(archive)).candles.length,800);
    archive.close();archive=createHistoryCache({filename,...io});
    assert.equal(archive.preview('crypto','BTCUSDT','1m').candles.at(-1).time,minute(798));
    const newer=range(704,803);newer[0].high=15;newer.at(-1).closed=false;
    io.set(feed(newer));
    const updated=await fetchBars(archive);
    assert.deepEqual(io.fetched,[800,100]);assert.equal(updated.candles.length,800);
    assert.equal(updated.candles.find(b=>b.time===minute(704)).high,15);
    assert.equal(updated.candles.at(-1).closed,false);
    assert.equal(archive.preview('crypto','BTCUSDT','1m').candles.at(-1).time,minute(802));
    assert.equal(archive.preview('us','BTCUSDT','1m'),null);
  }finally{archive.close();await rm(dir,{recursive:true});}
});
test('disconnected windows backfill from same source and then older chart pages are reusable without a second request',async()=>{
  const io=fake(),archive=createHistoryCache({filename:':memory:',...io});
  try{
    await fetchBars(archive);io.set(feed(range(952,1051)));
    const full=await fetchBars(archive),t=full.candles.map(b=>b.time);
    assert.deepEqual(t,range(252,1051).map(b=>b.time));assert.equal(io.requests.length,1);
    const params=pageParams(t[0]);const page=await archive.older(params);
    assert.equal(page.candles.length,252);assert.equal(io.requests.length,1);
    const intraday=await archive.older(pageParams(t[0]+39));
    assert.equal(intraday.candles.at(-1).time,t[0]);assert.equal(io.requests.length,1);
  }finally{archive.close();}
});
test('changed adjusted prices never connect to the earlier price scale, and private data cannot enter disk cache',async()=>{
  const io=fake(),archive=createHistoryCache({filename:':memory:',...io});
  try{
    const label='前复权';
    io.set(feed(range(0,799),{adjustment:label}));await fetchBars(archive);
    const rebased=range(704,803).map(b=>({...b,open:20,high:24,low:18,close:22}));
    io.set(feed(rebased,{adjustment:label}));await fetchBars(archive);
    assert.equal(archive.preview('crypto','BTCUSDT','1m').candles.some(b=>b.close===11),false);
    io.set(feed(range(704,805),{source:'Barchart private entitlement'}));await fetchBars(archive);
    assert.equal(archive.preview('crypto','BTCUSDT','1m').source,source);
  }finally{archive.close();}
});
test('unwritable cache degrades to normal network requests',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trend-bad-db-')),file=join(dir,'file');await writeFile(file,'x');
  const io=fake(),archive=createHistoryCache({filename:join(file,'db'),...io});
  try{assert.equal((await fetchBars(archive)).candles.length,800);assert.equal(archive.preview('crypto','BTCUSDT','1m'),null);}
  finally{archive.close();await rm(dir,{recursive:true});}
});
test('an internal source gap is filled only from a verified page and survives a repeat snapshot which still omits that minute',async()=>{
  const io=fake(),missing=feed(range(0,799).filter(b=>b.time!==minute(790)),{adjustment:'前复权'});
  io.set(missing);
  const archive=createHistoryCache({filename:':memory:',...io,latestHistoryGap:()=>({after:minute(789),before:minute(791),limit:2})});
  try{
    await fetchBars(archive);await new Promise(r=>setImmediate(r));
    assert.equal(archive.preview('crypto','BTCUSDT','1m').candles.length,800);
    const recovered=await fetchBars(archive);assert.equal(recovered.candles.length,800);
    assert.equal(recovered.candles.filter(b=>b.time===minute(790)).length,1);
  }finally{archive.close();}
});

test('Longbridge US candles preserve session labels, watchlist items stay pinned beyond 12,000 bars and past 48 unpinned LRU series',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trend-pin-db-')),filename=join(dir,'history-v2.sqlite');
  const lbInstrument={market:'us',symbol:'SOXS',id:'us:SOXS',name:'SOXS',exchange:'NYSE American',currency:'USD'};
  const lbSource='Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com';
  const lbAdjustment='不复权（原始价格）；成交量单位：股';
  const sessions=['overnight','pre','regular','post'];
  let currentBars=Array.from({length:800},(_,i)=>({...bar(i),session:sessions[i%sessions.length]}));
  const archive=createHistoryCache({
    filename,
    getCandles:async(_m,symbol)=>symbol==='SOXS'
      ? {instrument:lbInstrument,interval:'1m',source:lbSource,adjustment:lbAdjustment,delayNotice:'',warnings:[],availableIntervals:['1m'],
          asOf:new Date(minute(30000)*1000).toISOString(),candles:currentBars}
      : {instrument:{market:'crypto',symbol,id:`crypto:${symbol}`,name:symbol,exchange:'Binance',currency:'USDT'},
          interval:'1m',source:`Binance 公共现货行情 · ${symbol}`,adjustment,delayNotice:'',warnings:[],availableIntervals:['1m'],
          asOf:new Date(minute(30000)*1000).toISOString(),candles:range(0,49)},
    getOlderHistory:async p=>{
      const before=Number(p.get('before'));
      const count=Number(p.get('limit'));
      const firstIdx=(before-start)/60-count;
      return {...Object.fromEntries(p),status:'more',candles:Array.from({length:count},(_,i)=>({...bar(firstIdx+i),session:'overnight'}))};
    },
  });
  try{
    assert.deepEqual(archive.getWatchlist(),{initialized:false,items:[]});
    archive.setWatchlist([lbInstrument]);
    assert.deepEqual(archive.getWatchlist(),{initialized:true,items:[lbInstrument]});

    // Save 800 bars and verify session preservation on preview
    currentBars=Array.from({length:800},(_,i)=>({...bar(14000+i),session:sessions[i%sessions.length]}));
    await archive.candles('us','SOXS','1m',800);
    const preview=archive.preview('us','SOXS','1m');
    assert.equal(preview.candles.length,800);
    assert.equal(preview.candles[0].session,'overnight');
    assert.equal(preview.candles[1].session,'pre');

    // Backfill past 12,000 bars (13 pages * 1,000 + 800 = 13,800 bars) and confirm pinned SOXS retains > 12,000 bars
    let cursor=14000;
    for(let p=0;p<13;p++){
      await archive.older(new URLSearchParams({market:'us',symbol:'SOXS',interval:'1m',source:lbSource,adjustment:lbAdjustment,before:String(minute(cursor)),limit:'1000'}));
      cursor-=1000;
    }
    const pinnedStatus=archive.listSeriesStatus({pinnedOnly:true});
    assert.equal(pinnedStatus.length,1);
    assert.equal(pinnedStatus[0].barCount,13800);
    assert.equal(pinnedStatus[0].pinned,true);

    // Fetch 55 unrelated unpinned symbols: unpinned LRU keeps 48, pinned SOXS stays untouched
    for(let k=1;k<=55;k++){
      await archive.candles('crypto',`SYM${k}USDT`,'1m',800);
    }
    const allStatus=archive.listSeriesStatus();
    assert.equal(allStatus.filter(s=>!s.pinned).length,48);
    assert.equal(archive.getSeriesInfo('us','SOXS','1m').barCount,13800);
  }finally{
    archive.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('readSeries, readCompatibleHigher, and readMinuteWindows return contiguous ranges and compatible supporting feeds',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'trend-read-db-')),filename=join(dir,'history-v2.sqlite');
  const source='Binance 公共现货行情 · BTCUSDT';
  const adjustment='原始成交价格，不复权';
  const instrument={id:'crypto:BTCUSDT',market:'crypto',symbol:'BTCUSDT',name:'Bitcoin',exchange:'Binance',currency:'USDT'};
  const makeCustomBars=(startSec,count,stepSec)=>Array.from({length:count},(_,i)=>({
    time:startSec+i*stepSec,
    open:100+i*0.1,
    high:102+i*0.1,
    low:99+i*0.1,
    close:101+i*0.1,
    volume:500,
    closed:true,
  }));
  const base=Date.parse('2026-11-01T00:00:00Z')/1000;
  // Two disconnected 1h segments: [base..base+9h] and [base+100h..base+159h]
  const oldSeg=makeCustomBars(base,10,3600);
  const newSeg=makeCustomBars(base+100*3600,60,3600);
  const higher4h=makeCustomBars(base,45,14400);
  const minutes1m=makeCustomBars(base+120*3600,120,60);

  let mode='new-1h';
  const archive=createHistoryCache({
    filename,
    getCandles:async(_m,_s,interval)=>{
      if(interval==='4h')return {instrument,interval:'4h',source,adjustment,delayNotice:'',warnings:[],availableIntervals:['1m','1h','4h'],asOf:new Date((base+200*3600)*1000).toISOString(),candles:higher4h};
      if(interval==='1m')return {instrument,interval:'1m',source,adjustment,delayNotice:'',warnings:[],availableIntervals:['1m','1h','4h'],asOf:new Date((base+200*3600)*1000).toISOString(),candles:minutes1m};
      return {instrument,interval:'1h',source,adjustment,delayNotice:'',warnings:[],availableIntervals:['1m','1h','4h'],asOf:new Date((base+200*3600)*1000).toISOString(),candles:mode==='new-1h'?newSeg:oldSeg};
    },
    getOlderHistory:async()=>({market:'crypto',symbol:'BTCUSDT',interval:'1h',source,adjustment,status:'more',candles:oldSeg}),
  });
  try{
    await archive.candles('crypto','BTCUSDT','1h',60);
    // Older disconnected segment saved at older cursor
    await archive.older(new URLSearchParams({market:'crypto',symbol:'BTCUSDT',interval:'1h',source,adjustment,before:String(base+20*3600),limit:'10'}));
    await archive.candles('crypto','BTCUSDT','4h',45);
    await archive.candles('crypto','BTCUSDT','1m',120);

    // Default readSeries returns only latest contiguous segment (60 bars), not oldSeg
    const latestOnly=archive.readSeries({market:'crypto',symbol:'BTCUSDT',interval:'1h',maxBars:200});
    assert.equal(latestOnly.segmentCount,2);
    assert.equal(latestOnly.totalBars,70);
    assert.equal(latestOnly.data.candles.length,60);
    assert.equal(latestOnly.data.candles[0].time,newSeg[0].time);
    assert.equal(latestOnly.truncated,false);

    // maxBars < segment length sets truncated=true and keeps latest N bars
    const truncated=archive.readSeries({market:'crypto',symbol:'BTCUSDT',interval:'1h',maxBars:15});
    assert.equal(truncated.data.candles.length,15);
    assert.equal(truncated.truncated,true);
    assert.equal(truncated.data.candles[0].time,newSeg[45].time);

    // from/to selects matching older contiguous segment when requested
    const olderRange=archive.readSeries({market:'crypto',symbol:'BTCUSDT',interval:'1h',from:oldSeg[0].time,to:oldSeg[9].time,maxBars:50});
    assert.equal(olderRange.data.candles.length,10);
    assert.equal(olderRange.data.candles[0].time,oldSeg[0].time);

    // readCompatibleHigher fetches >=35 matching higher-timeframe bars up to primary end
    const higher=archive.readCompatibleHigher(latestOnly.data,'4h');
    assert.ok(higher);
    assert.equal(higher.interval,'4h');
    assert.ok(higher.candles.length>=35);
    assert.ok(higher.candles.at(-1).time<=latestOnly.data.candles.at(-1).time);

    // readMinuteWindows extracts matching 1m windows cleanly (includes +60s tail for end-labelled compatibility)
    const win=archive.readMinuteWindows(latestOnly.data,[{start:base+120*3600,end:base+120*3600+3600}]);
    assert.ok(win);
    assert.equal(win.interval,'1m');
    assert.equal(win.candles.length,62);
    assert.equal(win.candles[0].time,base+120*3600);
    assert.equal(win.candles.at(-1).time,base+120*3600+3660);
  }finally{
    archive.close();
    await rm(dir,{recursive:true,force:true});
  }
});
