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
export const parseMarket=v=>{if(['crypto','us','cn','commodity'].includes(v))return v;throw new MarketError('Invalid market',400);};
export const parseSearchMarket=v=>v||'all';
export const parseInterval=v=>v;
export const normalizeSymbol=(_m,s)=>String(s).trim().toUpperCase();
export const latestHistoryGap=()=>null;
export const resetMarketNetworkFailures=()=>{};
`;
const networkStub=`export function createNetworkRouteMonitor(){return async()=>({revision:1,status:{mode:'direct',applied:true}});}
`;
const historyStub=`const state={initialized:false,items:[],series:[]};
export function createHistoryCache(){return {
  preview:()=>null,candles:async()=>({}),older:async()=>({}),
  getWatchlist:()=>({initialized:state.initialized,items:state.items}),
  setWatchlist:items=>{state.initialized=true;state.items=items;return {initialized:true,items};},
  listSeriesStatus:()=>state.series,
  getSeriesInfo:()=>null,
  recordSyncState:()=>{},
  close(){},
};}
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
    env:{...process.env,TREND_WORKBENCH_LONGBRIDGE_KLINE:'0',NODE_USE_ENV_PROXY:'0',...env},
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
