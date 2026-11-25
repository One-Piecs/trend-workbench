import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarketError, getCandles, getOlderHistory, getWorkbenchLiveQuote, getJournalMinutes, getSpotFlow, getBattleTape, searchInstruments, parseMarket, parseSearchMarket, parseInterval, normalizeSymbol, latestHistoryGap, resetMarketNetworkFailures } from './market-data.mjs';
import { createNetworkRouteMonitor } from './network-bootstrap.mjs';
import { createHistoryCache } from './history-cache.mjs';

// Market adapters perform no requests at module load. Configure the existing
// user network route before starting the listener or making any market request.
const checkNetworkRoute=createNetworkRouteMonitor({onRouteChange:resetMarketNetworkFailures});
await checkNetworkRoute();

// US overnight (pre/post/night) candles need the Longbridge CLI on this machine.
// Auth and quota are managed by the user's own `longbridge` login; without the
// CLI the workbench silently falls back to the regular-session public sources.
if(!process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE){
  const {accessSync,constants} = await import('node:fs');
  const {execFileSync} = await import('node:child_process');
  // GUI-launched apps inherit a minimal PATH, so common install locations are probed.
  const bin=['longbridge','/opt/homebrew/bin/longbridge','/usr/local/bin/longbridge'].find(candidate=>{
    try{accessSync(candidate,constants.X_OK);return true;}catch{return false;}
  });
  if(bin){
    try{
      execFileSync(bin,['auth','status'],{stdio:'ignore',timeout:10000,env:{...process.env,PATH:`/opt/homebrew/bin:/usr/local/bin:${process.env.PATH||''}`}});
      process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE='1';
    }catch{}
  }
}

async function marketRequest(load){
  const route=await checkNetworkRoute();
  try{return await load();}catch(error){
    if(error instanceof MarketError&&error.status<500)throw error;
    // Retry once if the OS route changed during the failed request.
    if((await checkNetworkRoute(true)).revision===route.revision)throw error;
    return load();
  }
}

const appRoot=dirname(fileURLToPath(import.meta.url));
const publicRoot=resolve(appRoot,'public');
// The packager replaces this literal. An old process must never read a new
// release identity from files that were replaced while it was running.
const buildId='unpackaged';
const autoExit=!process.argv.includes('--no-auto-exit')&&process.env.TREND_WORKBENCH_NO_AUTO_EXIT!=='1';
const portIndex=process.argv.indexOf('--port');
const requestedPort=portIndex<0?43127:Number(process.argv[portIndex+1]);
if(!Number.isInteger(requestedPort)||(requestedPort!==0&&requestedPort<1024)||requestedPort>65535)throw new Error('Invalid local port');
let port,origin;
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.json':'application/json; charset=utf-8','.wav':'audio/wav','.txt':'text/plain; charset=utf-8'};
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const windows=new Set();
const archive=createHistoryCache({getCandles,getOlderHistory,latestHistoryGap});
let exitTimer;
function shutdown(reason='No workbench windows remain. Stopping local service.'){
  console.log(reason);
  for(const window of windows)window.end();
  server.closeAllConnections();
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(0),1000).unref();
}
function scheduleExit(ms){if(!autoExit)return;clearTimeout(exitTimer);exitTimer=setTimeout(()=>shutdown(),ms);}

const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  // Loopback binding and an exact Host/Origin prevent unrelated web pages from
  // using the desktop service and its locally configured data feeds.
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host||''))return json(res,403,{error:'Local host only'});
  if(req.headers.origin&&![origin,`http://localhost:${port}`].includes(req.headers.origin))return json(res,403,{error:'Local origin only'});
  if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'Read-only endpoint'});
  try{
    const url=new URL(req.url||'/',origin);
    if(url.pathname==='/health')return json(res,200,{app:'trend-workbench',version:'VERSION_FROM_PACKAGE',buildId,pid:process.pid,activeWindows:windows.size,autoExit});
    if(url.pathname==='/session'){
      if(req.method!=='GET')return json(res,405,{error:'GET required'});
      clearTimeout(exitTimer);
      windows.add(res);
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write('event: connected\ndata: local-workbench\n\n');
      const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),15000);
      res.on('close',()=>{clearInterval(heartbeat);windows.delete(res);if(!windows.size)scheduleExit(5000);});
      return;
    }
    if(url.pathname==='/api/search'){
      const q=url.searchParams.get('q')||'';
      if(q.length>60)throw new MarketError('搜索内容最多60个字符。',400);
      const market=parseSearchMarket(url.searchParams.get('market'));
      return json(res,200,await marketRequest(()=>searchInstruments(market,q)));
    }
    if(url.pathname==='/api/live-quote')return json(res,200,await marketRequest(()=>getWorkbenchLiveQuote(url.searchParams)));
    if(url.pathname==='/api/battle'){
      try{return json(res,200,await marketRequest(()=>getBattleTape(url.searchParams)));}
      catch(error){if(error instanceof RangeError)throw new MarketError(error.message,400);throw error;}
    }
    if(url.pathname==='/api/history')return json(res,200,await marketRequest(()=>archive.older(url.searchParams)));
    if(url.pathname==='/api/candles'||url.pathname==='/api/cached-candles'){
      const market=parseMarket(url.searchParams.get('market'));
      const interval=parseInterval(url.searchParams.get('interval')||'1d',market);
      const symbol=url.searchParams.get('symbol');
      if(!symbol)throw new MarketError('缺少标的代码。',400);
      const limit=Number(url.searchParams.get('limit')||'800');
      if(!Number.isInteger(limit)||limit<1||limit>2000)throw new MarketError('K线数量须为1至2000。',400);
      const normalized=normalizeSymbol(market,symbol);
      if(url.pathname==='/api/cached-candles'){
        const snapshot=archive.preview(market,normalized,interval,Math.min(1000,limit));
        return json(res,snapshot?200:404,snapshot??{error:'没有已保存的历史K线。'});
      }
      return json(res,200,await marketRequest(()=>archive.candles(market,normalized,interval,limit)));
    }
    if(url.pathname==='/api/spot-flow'||url.pathname==='/api/journal-minutes'){
      try{
        await checkNetworkRoute();
        const load=url.pathname==='/api/spot-flow'?getSpotFlow:getJournalMinutes;
        return json(res,200,await load(url.searchParams));
      }catch(error){
        if(error instanceof RangeError)throw new MarketError(error.message,400);
        throw error;
      }
    }
    if(url.pathname.startsWith('/api/'))return json(res,404,{error:'Unknown endpoint'});
    let decoded;
    try{decoded=decodeURIComponent(url.pathname);}catch{return json(res,400,{error:'Invalid URL'});}
    if(decoded.includes('\\')||decoded.includes('\0'))return json(res,400,{error:'Invalid path'});
    const asset=resolve(publicRoot,'.'+(decoded==='/'?'/index.html':decoded));
    const rel=relative(publicRoot,asset);
    if(rel.startsWith('..')||!rel)return json(res,404,{error:'Not found'});
    const info=await stat(asset);
    if(!info.isFile())return json(res,404,{error:'Not found'});
    const type=mime[extname(asset)];
    if(!type)return json(res,404,{error:'Not found'});
    res.writeHead(200,{'Content-Type':type,'Content-Length':info.size,'Cache-Control':'no-cache'});
    res.end(req.method==='HEAD'?undefined:await readFile(asset));
  }catch(error){
    if(error?.code==='ENOENT')return json(res,404,{error:'Not found'});
    const status=error instanceof MarketError?error.status:502;
    json(res,status,{error:error instanceof Error?error.message:'本机服务暂时无法取得行情。'});
  }
});
server.requestTimeout=60000;
server.headersTimeout=15000;
server.on('error',error=>{console.error(error.code||error.message);process.exitCode=1;});
server.listen(requestedPort,'127.0.0.1',()=>{
  port=server.address().port;
  origin=`http://127.0.0.1:${port}`;
  if(process.argv.includes('--announce-ready'))console.log(`TREND_WORKBENCH_READY ${port}`);
  console.log(`Trend Workbench ${origin} · pid ${process.pid}`);
  scheduleExit(90000);
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>shutdown(`Received ${signal}. Stopping local service.`));
