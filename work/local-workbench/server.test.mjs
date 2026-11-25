import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const marketStub=`export class MarketError extends Error{constructor(message,status=502){super(message);this.status=status;}}
export const getCandles=async()=>({});
export const getOlderHistory=async()=>({});
export const getWorkbenchLiveQuote=async()=>({});
export const getJournalMinutes=async()=>({});
export const getSpotFlow=async()=>({});
export const getBattleTape=async()=>({});
export const searchInstruments=async()=>({results:[]});
export const parseMarket=v=>{if(['crypto','us','hk','cn','commodity'].includes(v))return v;throw new MarketError('Invalid market',400);};
export const parseSearchMarket=v=>v||'all';
export const parseInterval=v=>v;
export const normalizeSymbol=(_m,s)=>String(s).trim().toUpperCase();
export const latestHistoryGap=()=>null;
export const resetMarketNetworkFailures=()=>{};
export const getLongbridgeHubCapabilities=async()=>{
  const configured=Boolean(process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_URL&&process.env.TREND_WORKBENCH_LONGBRIDGE_HUB!=='0');
  return {configured,ready:configured,status:configured?'connected':'unconfigured',usRealtime:configured,hkRealtime:configured,cnRealtime:false,packages:[]};
};
export const isLongbridgeHubConfigured=()=>Boolean(process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_URL&&process.env.TREND_WORKBENCH_LONGBRIDGE_HUB!=='0');
export const toLongbridgeTicker=(_m,s)=>s;
`;
const networkStub=`export function createNetworkRouteMonitor(){return async()=>({revision:1,status:{mode:'direct',applied:true}});}
`;
const historyStub=`const bars=(from,count,span)=>Array.from({length:count},(_,i)=>({time:from+i*span,open:100,high:102,low:99,close:101,volume:100,closed:true}));
const state={initialized:false,items:[],series:[{key:'["us","AAPL","1h","Yahoo Finance 网页行情 · query1.finance.yahoo.com","来源原始OHLC",""]',market:'us',symbol:'AAPL',interval:'1h',source:'Yahoo Finance 网页行情 · query1.finance.yahoo.com',adjustment:'来源原始OHLC',pinned:true,barCount:120,firstTime:1700000000,lastTime:1700428400,lastSyncAt:1700428400000,lastError:null,backfillDone:true,segmentCount:1}]};
export function createHistoryCache(){return {
  preview:()=>null,candles:async()=>({}),older:async()=>({}),
  getWatchlist:()=>({initialized:state.initialized,items:state.items}),
  setWatchlist:items=>{state.initialized=true;state.items=items;return {initialized:true,items};},
  listSeriesStatus:()=>state.series,
  getSeriesInfo:()=>null,
  recordSyncState:()=>{},
  readSeries:({market,symbol,interval,maxBars=5000})=>{
    if(symbol!=='AAPL'||interval!=='1h')return null;
    const all=bars(1700000000,120,3600);
    const slice=all.slice(-maxBars);
    return {
      key:state.series[0].key,
      totalBars:all.length,
      segmentCount:1,
      truncated:all.length>slice.length,
      data:{instrument:{id:market+':'+symbol,market,symbol,name:'Apple',exchange:'NASDAQ',currency:'USD'},interval,source:state.series[0].source,adjustment:state.series[0].adjustment,asOf:new Date(1700432000000).toISOString(),delayNotice:'',warnings:[],availableIntervals:['1h','4h'],candles:slice},
    };
  },
  readCompatibleHigher:()=>({instrument:{id:'us:AAPL',market:'us',symbol:'AAPL',name:'Apple',exchange:'NASDAQ',currency:'USD'},interval:'4h',source:state.series[0].source,adjustment:state.series[0].adjustment,asOf:new Date(1700432000000).toISOString(),delayNotice:'',warnings:[],availableIntervals:['4h'],candles:bars(1700000000,40,14400)}),
  readMinuteWindows:(primary,ranges)=>{
    globalThis.__minuteCalls=(globalThis.__minuteCalls||0)+1;
    return ranges?.length?{...primary,interval:'1m',candles:bars(ranges[0].start,5,60)}:undefined;
  },
  close(){},
};}
`;
const backtestStub=`export async function runCachedBacktest({primary,higher,loadMinutes,options}){
  const minute=loadMinutes?await loadMinutes([{start:primary.candles[0].time,end:primary.candles[0].time+3600}]):undefined;
  return {
    generatedAt:'2026-11-25T00:00:00.000Z',
    durationMs:5,
    status:'unvalidated',
    evidenceSufficient:false,
    activationRecommendation:'Do not activate the regime filter from these reports.',
    data:{market:primary.instrument.market,symbol:primary.instrument.symbol,interval:primary.interval,source:primary.source,adjustment:primary.adjustment,capturedAt:primary.asOf,totalBars:primary.candles.length,closedBars:primary.candles.length,firstTime:primary.candles[0].time,lastTime:primary.candles.at(-1).time,higherInterval:higher?.interval??null,higherBars:higher?.candles.length??0,minuteMatched:Boolean(minute?.candles?.length),minuteConflictBars:1,minuteResolvedBars:1},
    method:{folds:options?.folds??3,warmupFraction:options?.warmupFraction??0.4},
    modelVersions:['v1'],parameterVersions:['p1'],analysisVersions:['a1'],
    baseline:{completed:1,profitable:1,winRate:1,meanNetR:1.5,medianNetR:1.5,meanNetReturnPct:1.2,published:2,conditionsMet:1,modeledEntries:1,outcomesByStatus:{closed:1},duplicateGeometry:0,minuteResolved:1,ambiguousExits:0,sampleStatus:'insufficient',minimumCompleted:30,evidenceSufficient:false,longCompleted:1,shortCompleted:0,exitReasons:{target2:1,stop:0,gapStop:0}},
    shadow:{completed:0,profitable:0,winRate:null,meanNetR:null,medianNetR:null,meanNetReturnPct:null,published:0,conditionsMet:0,modeledEntries:0,outcomesByStatus:{},duplicateGeometry:0,minuteResolved:0,ambiguousExits:0,sampleStatus:'insufficient',minimumCompleted:30,evidenceSufficient:false,longCompleted:0,shortCompleted:0,exitReasons:{target2:0,stop:0,gapStop:0}},
    folds:[],recentTrades:[],limitations:[],
  };
}
`;
const syncStub=`export function createWatchlistSync({enabled=false}={}){
  let notified=0;
  return {
    start(){},stop(){},notifyWatchlistChanged(){notified++;},
    status:()=>({enabled,intervals:['1m','5m','15m','1h','1d'],running:false,currentTask:null,lastCycleAt:null,notified}),
  };
}
`;

async function stageServer(){
  const dir=await mkdtemp(join(tmpdir(),'trend-server-'));
  await mkdir(join(dir,'public'),{recursive:true});
  await copyFile(join(here,'server.mjs'),join(dir,'server.mjs'));
  await copyFile(join(here,'longbridge-hub-stream.mjs'),join(dir,'longbridge-hub-stream.mjs'));
  await copyFile(join(here,'backtest-worker.mjs'),join(dir,'backtest-worker.mjs'));
  await writeFile(join(dir,'cache-backtest.mjs'),backtestStub);
  await writeFile(join(dir,'market-data.mjs'),marketStub);
  await writeFile(join(dir,'network-bootstrap.mjs'),networkStub);
  await writeFile(join(dir,'history-cache.mjs'),historyStub);
  await writeFile(join(dir,'watchlist-sync.mjs'),syncStub);
  await writeFile(join(dir,'public/index.html'),'<!doctype html><title>趋势判断工作台</title>');
  return dir;
}

async function startServer(dir,{args=[],env={}}={}){
  const child=spawn(process.execPath,[join(dir,'server.mjs'),'--port','0','--announce-ready',...args],{
    cwd:dir,
    env:{...process.env,TREND_WORKBENCH_LONGBRIDGE_KLINE:'0',TREND_WORKBENCH_LONGBRIDGE_HUB:'0',NODE_USE_ENV_PROXY:'0',...env},
    stdio:['ignore','pipe','pipe'],
  });
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`Timed out waiting for server ready. stdout=${stdout} stderr=${stderr}`)),10000);
    child.stdout.on('data',chunk=>{
      stdout+=chunk;
      const match=stdout.match(/TREND_WORKBENCH_READY (\d+)/);
      if(match){clearTimeout(timer);resolve(Number(match[1]));}
    });
    child.once('exit',(code,signal)=>{
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code}/${signal}). stdout=${stdout} stderr=${stderr}`));
    });
  });
  return {
    child,
    port,
    async stop(){
      if(child.exitCode===null&&child.signalCode===null){
        child.kill('SIGTERM');
        await once(child,'exit',{signal:AbortSignal.timeout(5000)}).catch(()=>{
          if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
        });
      }
    },
  };
}

function sendHttp(port,path,headers={},method='GET',body){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path,method,headers},(res)=>{
      let out='';
      res.setEncoding('utf8');
      res.on('data',chunk=>{out+=chunk;});
      res.on('end',()=>resolve({status:res.statusCode,body:out}));
    });
    req.on('error',reject);
    if(body!==undefined)req.write(body);
    req.end();
  });
}

function openSession(port){
  return new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port,path:'/session'},(res)=>{
      if(res.statusCode!==200){
        reject(new Error(`Unexpected /session status ${res.statusCode}`));
        res.resume();
        return;
      }
      res.once('data',chunk=>{
        assert.match(String(chunk),/event: connected/);
        resolve({
          close:()=>{
            res.destroy();
            req.destroy();
          },
        });
      });
    });
    req.on('error',reject);
  });
}

test('default desktop mode enforces local host/origin and exits after last /session disconnects',async()=>{
  const dir=await stageServer();
  const srv=await startServer(dir);
  try{
    const initial=await sendHttp(srv.port,'/health');
    assert.equal(initial.status,200);
    const initialHealth=JSON.parse(initial.body);
    assert.equal(initialHealth.autoExit,true);
    assert.equal(initialHealth.activeWindows,0);

    const badHost=await sendHttp(srv.port,'/health',{Host:`evil.example:${srv.port}`});
    assert.equal(badHost.status,403);
    const badOrigin=await sendHttp(srv.port,'/health',{Origin:'https://evil.example'});
    assert.equal(badOrigin.status,403);

    const session=await openSession(srv.port);
    const active=JSON.parse((await sendHttp(srv.port,'/health')).body);
    assert.equal(active.activeWindows,1);

    const exitPromise=once(srv.child,'exit',{signal:AbortSignal.timeout(10000)});
    session.close();
    const [code,signal]=await exitPromise;
    assert.equal(code,0);
    assert.equal(signal,null);
  }finally{
    await srv.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

test('--no-auto-exit keeps service running after /session disconnects until SIGTERM',async()=>{
  const dir=await stageServer();
  const srv=await startServer(dir,{args:['--no-auto-exit']});
  try{
    const initial=JSON.parse((await sendHttp(srv.port,'/health')).body);
    assert.equal(initial.autoExit,false);

    const session=await openSession(srv.port);
    const active=JSON.parse((await sendHttp(srv.port,'/health')).body);
    assert.equal(active.activeWindows,1);
    session.close();

    // Wait past the desktop 5000ms shutdown grace period to prove auto-exit is disabled.
    await pause(6000);
    assert.equal(srv.child.exitCode,null);
    assert.equal(srv.child.signalCode,null);

    const after=await sendHttp(srv.port,'/health');
    assert.equal(after.status,200);
    const afterHealth=JSON.parse(after.body);
    assert.equal(afterHealth.activeWindows,0);
    assert.equal(afterHealth.autoExit,false);

    const exitPromise=once(srv.child,'exit',{signal:AbortSignal.timeout(5000)});
    srv.child.kill('SIGTERM');
    const [code]=await exitPromise;
    assert.equal(code,0);
  }finally{
    await srv.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

test('TREND_WORKBENCH_NO_AUTO_EXIT=1 disables auto-exit and responds cleanly to SIGTERM',async()=>{
  const dir=await stageServer();
  const srv=await startServer(dir,{env:{TREND_WORKBENCH_NO_AUTO_EXIT:'1'}});
  try{
    const health=JSON.parse((await sendHttp(srv.port,'/health')).body);
    assert.equal(health.autoExit,false);
    assert.equal(health.watchlistSync,true);

    const exitPromise=once(srv.child,'exit',{signal:AbortSignal.timeout(5000)});
    srv.child.kill('SIGTERM');
    const [code]=await exitPromise;
    assert.equal(code,0);
  }finally{
    await srv.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

test('watchlist and cache status endpoints enforce local origin, method allowlist, and validation',async()=>{
  const dir=await stageServer();
  const srv=await startServer(dir,{args:['--no-auto-exit']});
  try{
    const initial=await sendHttp(srv.port,'/api/watchlist');
    assert.equal(initial.status,200);
    assert.deepEqual(JSON.parse(initial.body),{initialized:false,items:[]});

    const badMethod=await sendHttp(srv.port,'/api/candles?market=crypto&symbol=BTCUSDT&interval=1m',{},'PUT','{}');
    assert.equal(badMethod.status,405);

    const crossOrigin=await sendHttp(srv.port,'/api/watchlist',{Origin:'https://evil.example','Content-Type':'application/json'},'PUT','{"items":[]}');
    assert.equal(crossOrigin.status,403);

    const invalidPayload=await sendHttp(srv.port,'/api/watchlist',{'Content-Type':'application/json'},'PUT','{"items":[{"market":"invalid","symbol":"X","name":"X"}]}');
    assert.equal(invalidPayload.status,400);

    const saved=await sendHttp(srv.port,'/api/watchlist',{'Content-Type':'application/json'},'PUT',JSON.stringify({
      items:[{id:'us:soxs',market:'us',symbol:'soxs',name:'SOXS',exchange:'NYSE American',currency:'USD'}],
    }));
    assert.equal(saved.status,200);
    assert.deepEqual(JSON.parse(saved.body),{
      initialized:true,
      items:[{id:'us:SOXS',market:'us',symbol:'SOXS',name:'SOXS',exchange:'NYSE American',currency:'USD'}],
    });

    const after=JSON.parse((await sendHttp(srv.port,'/api/watchlist')).body);
    assert.equal(after.initialized,true);
    assert.equal(after.items[0].symbol,'SOXS');

    const status=await sendHttp(srv.port,'/api/cache/status');
    assert.equal(status.status,200);
    const parsedStatus=JSON.parse(status.body);
    assert.equal(parsedStatus.enabled,true);
    assert.equal(parsedStatus.watchlistCount,1);
    assert.equal(parsedStatus.notified,1);
  }finally{
    await srv.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

test('cache candles and worker backtest endpoints validate params and run off-thread',async()=>{
  const dir=await stageServer();
  const srv=await startServer(dir,{args:['--no-auto-exit']});
  try{
    const jsonRes=await sendHttp(srv.port,'/api/cache/candles?market=us&symbol=AAPL&interval=1h&limit=50');
    assert.equal(jsonRes.status,200);
    const jsonPayload=JSON.parse(jsonRes.body);
    assert.equal(jsonPayload.candles.length,50);
    assert.equal(jsonPayload.totalBars,120);
    assert.equal(jsonPayload.truncated,true);

    const csvRes=await sendHttp(srv.port,'/api/cache/candles?market=us&symbol=AAPL&interval=1h&limit=10&format=csv');
    assert.equal(csvRes.status,200);
    assert.match(csvRes.body,/^time,open,high,low,close,volume,closed\n/);
    assert.equal(csvRes.body.trim().split('\n').length,11);

    const missingRes=await sendHttp(srv.port,'/api/cache/candles?market=us&symbol=MSFT&interval=1h');
    assert.equal(missingRes.status,404);

    const badLimit=await sendHttp(srv.port,'/api/cache/candles?market=us&symbol=AAPL&interval=1h&limit=999999');
    assert.equal(badLimit.status,400);

    const badOrigin=await sendHttp(srv.port,'/api/validation/run',{Origin:'https://evil.example','Content-Type':'application/json'},'POST','{"market":"us","symbol":"AAPL","interval":"1h"}');
    assert.equal(badOrigin.status,403);

    const badParams=await sendHttp(srv.port,'/api/validation/run',{'Content-Type':'application/json'},'POST','{"market":"us","symbol":"AAPL","interval":"1h","folds":99}');
    assert.equal(badParams.status,400);

    const notCached=await sendHttp(srv.port,'/api/validation/run',{'Content-Type':'application/json'},'POST','{"market":"us","symbol":"NVDA","interval":"1h"}');
    assert.equal(notCached.status,404);

    const runRes=await sendHttp(srv.port,'/api/validation/run',{'Content-Type':'application/json'},'POST',JSON.stringify({
      market:'us',symbol:'AAPL',interval:'1h',maxBars:100,folds:3,
    }));
    assert.equal(runRes.status,200);
    const runPayload=JSON.parse(runRes.body);
    assert.equal(runPayload.data.symbol,'AAPL');
    assert.equal(runPayload.data.higherInterval,'4h');
    assert.equal(runPayload.data.higherBars,40);
    assert.equal(runPayload.data.minuteMatched,true);
    assert.equal(runPayload.baseline.winRate,1);
    assert.equal(runPayload.cache.totalBars,120);
  }finally{
    await srv.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

test('desktop hub.env connects to remote or local longbridge-hub URLs, supports disable flag, and never leaks tokens',async()=>{
  const hubSecret='super-secret-hub-token-9876';
  const mockHub=http.createServer((req,res)=>{
    if(req.url==='/health'){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({status:'ok',upstream:{ready:true,status:'connected',packages:[]}}));
      return;
    }
    res.writeHead(404).end();
  });
  mockHub.listen(0,'127.0.0.1');
  await once(mockHub,'listening');
  const hubPort=mockHub.address().port;
  const hubUrl=`http://127.0.0.1:${hubPort}`;

  const dir=await stageServer();
  const envDir=await mkdtemp(join(tmpdir(),'trend-hub-env-'));
  try{
    // Case 1: Explicit TREND_WORKBENCH_LONGBRIDGE_HUB_URL + TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN
    const envFile1=join(envDir,'hub-explicit.env');
    await writeFile(envFile1,`TREND_WORKBENCH_LONGBRIDGE_HUB_URL=${hubUrl}/\nTREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN="${hubSecret}"\n`);
    const srv1=await startServer(dir,{
      args:['--no-auto-exit'],
      env:{TREND_WORKBENCH_LONGBRIDGE_HUB:'',TREND_WORKBENCH_LONGBRIDGE_HUB_URL:'',TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN:'',TREND_WORKBENCH_LONGBRIDGE_HUB_ENV:envFile1},
    });
    try{
      const res=await sendHttp(srv1.port,'/health');
      assert.equal(res.status,200);
      assert.ok(!res.body.includes(hubSecret),'token must never appear in /health');
      const health=JSON.parse(res.body);
      assert.deepEqual(health.longbridgeHub,{configured:true,ready:true,status:'connected',usRealtime:true,hkRealtime:true,cnRealtime:false});
    }finally{await srv1.stop();}

    // Case 2: LB_HUB_URL + LB_HUB_API_TOKEN
    const envFile2=join(envDir,'hub-lb.env');
    await writeFile(envFile2,`# remote tailscale or LAN hub\nLB_HUB_URL=${hubUrl}\nLB_HUB_API_TOKEN=${hubSecret}\n`);
    const srv2=await startServer(dir,{
      args:['--no-auto-exit'],
      env:{TREND_WORKBENCH_LONGBRIDGE_HUB:'',TREND_WORKBENCH_LONGBRIDGE_HUB_URL:'',TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN:'',TREND_WORKBENCH_LONGBRIDGE_HUB_ENV:envFile2},
    });
    try{
      const res=await sendHttp(srv2.port,'/health');
      assert.equal(res.status,200);
      assert.ok(!res.body.includes(hubSecret));
      assert.equal(JSON.parse(res.body).longbridgeHub.configured,true);
    }finally{await srv2.stop();}

    // Case 3: TREND_WORKBENCH_LONGBRIDGE_HUB=0 disables hub even with URL present
    const envFile3=join(envDir,'hub-disabled.env');
    await writeFile(envFile3,`TREND_WORKBENCH_LONGBRIDGE_HUB=0\nLB_HUB_URL=${hubUrl}\nLB_HUB_API_TOKEN=${hubSecret}\n`);
    const srv3=await startServer(dir,{
      args:['--no-auto-exit'],
      env:{TREND_WORKBENCH_LONGBRIDGE_HUB:'',TREND_WORKBENCH_LONGBRIDGE_HUB_URL:'',TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN:'',TREND_WORKBENCH_LONGBRIDGE_HUB_ENV:envFile3},
    });
    try{
      const res=await sendHttp(srv3.port,'/health');
      assert.equal(res.status,200);
      assert.equal(JSON.parse(res.body).longbridgeHub.configured,false);
    }finally{await srv3.stop();}
  }finally{
    mockHub.close();
    mockHub.closeAllConnections?.();
    await rm(dir,{recursive:true,force:true});
    await rm(envDir,{recursive:true,force:true});
  }
});
