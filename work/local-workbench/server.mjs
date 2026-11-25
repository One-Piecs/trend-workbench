import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve, relative, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { MarketError, getCandles, getOlderHistory, getWorkbenchLiveQuote, getJournalMinutes, getSpotFlow, getBattleTape, searchInstruments, parseMarket, parseSearchMarket, parseInterval, normalizeSymbol, latestHistoryGap, resetMarketNetworkFailures, getLongbridgeHubCapabilities, isLongbridgeHubConfigured, toLongbridgeTicker } from './market-data.mjs';
import { createNetworkRouteMonitor } from './network-bootstrap.mjs';
import { createHistoryCache } from './history-cache.mjs';
import { createWatchlistSync } from './watchlist-sync.mjs';
import { createLongbridgeHubStream } from './longbridge-hub-stream.mjs';

// Market adapters perform no requests at module load. Configure the existing
// user network route before starting the listener or making any market request.
const checkNetworkRoute=createNetworkRouteMonitor({onRouteChange:resetMarketNetworkFailures});
await checkNetworkRoute();

function parseHubUrl(raw){
  if(typeof raw!=='string'||!raw.trim())return '';
  try{
    const u=new URL(raw.trim());
    if(!['http:','https:'].includes(u.protocol)||!u.hostname)return '';
    return u.toString().replace(/\/+$/,'');
  }catch{return '';}
}

function parseHubEnv(text){
  let url='',lbUrl='',port='',token='',lbToken='',disabled=false;
  for(const rawLine of text.split(/\r?\n/)){
    const trimmed=rawLine.trim();
    if(!trimmed||trimmed.startsWith('#'))continue;
    const line=trimmed.startsWith('export ')?trimmed.slice(7).trim():trimmed;
    const eq=line.indexOf('=');
    if(eq<=0)continue;
    const k=line.slice(0,eq).trim();
    let v=line.slice(eq+1).trim();
    if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);
    if(k==='TREND_WORKBENCH_LONGBRIDGE_HUB'&&v==='0')disabled=true;
    else if(k==='TREND_WORKBENCH_LONGBRIDGE_HUB_URL')url=parseHubUrl(v);
    else if(k==='LB_HUB_URL')lbUrl=parseHubUrl(v);
    else if(k==='LB_HUB_PORT'&&/^\d+$/.test(v))port=v;
    else if(k==='TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN')token=v;
    else if(k==='LB_HUB_API_TOKEN')lbToken=v;
  }
  return {disabled,url:url||lbUrl,port,token:token||lbToken};
}

function hubEnvCandidates(){
  if(process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_ENV){
    return [process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_ENV];
  }
  const candidates=[join(homedir(),'.config','trend-workbench','hub.env')];
  if(process.platform==='darwin'){
    candidates.push(join(homedir(),'Library','Application Support','TrendWorkbench','hub.env'));
  }else if(process.platform==='win32'){
    if(process.env.APPDATA)candidates.push(join(process.env.APPDATA,'TrendWorkbench','hub.env'));
    if(process.env.LOCALAPPDATA)candidates.push(join(process.env.LOCALAPPDATA,'TrendWorkbench','hub.env'));
  }
  candidates.push(join(homedir(),'.config','longbridge-hub','hub.env'));
  return [...new Set(candidates)];
}

if(process.env.TREND_WORKBENCH_LONGBRIDGE_HUB!=='0'){
  if(!process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_URL){
    for(const envPath of hubEnvCandidates()){
      let rawText='';
      try{rawText=readFileSync(envPath,'utf8');}catch{continue;}
      const parsed=parseHubEnv(rawText);
      if(parsed.disabled)break;
      const isDefaultHubEnv=basename(dirname(envPath))==='longbridge-hub'&&basename(envPath)==='hub.env';
      const candidateUrl=parsed.url||(parsed.port||isDefaultHubEnv?`http://127.0.0.1:${parsed.port||'44130'}`:'');
      if(!candidateUrl)continue;
      try{
        const probe=await fetch(`${candidateUrl}/health`,{signal:AbortSignal.timeout(2000)});
        if(probe.ok){
          const health=await probe.json().catch(()=>null);
          if(health&&typeof health==='object'&&'upstream' in health){
            process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_URL=candidateUrl;
            if(parsed.token&&!process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN){
              process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN=parsed.token;
            }
            break;
          }
        }
      }catch{}
    }
  }
  if(isLongbridgeHubConfigured()){
    const caps=await getLongbridgeHubCapabilities({force:true});
    console.log(`Longbridge Hub connected (${caps.ready?'ready':caps.status}, US:${caps.usRealtime}, HK:${caps.hkRealtime}, CN:${caps.cnRealtime})`);
  }
}

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
    }catch{console.warn('Longbridge CLI auth probe failed; falling back to regular-session sources.');}
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
const watchlistSyncEnabled=process.env.TREND_WORKBENCH_WATCHLIST_SYNC==='1'||(!autoExit&&process.env.TREND_WORKBENCH_WATCHLIST_SYNC!=='0');
let interactiveInFlight=0;
const watchlistSync=createWatchlistSync({
  archive,
  enabled:watchlistSyncEnabled,
  isInteractiveBusy:()=>interactiveInFlight>0,
  longbridgeEnabled:()=>process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE==='1'||isLongbridgeHubConfigured(),
});
const hubStream=createLongbridgeHubStream({
  getConfig:()=>{
    if(process.env.TREND_WORKBENCH_LONGBRIDGE_HUB==='0')return null;
    const baseUrl=process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_URL?.trim().replace(/\/+$/,'');
    if(!baseUrl)return null;
    const token=process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN?.trim()||process.env.LB_HUB_API_TOKEN?.trim()||'';
    return {baseUrl,token};
  },
  getCapabilities:()=>getLongbridgeHubCapabilities(),
});
async function interactiveRequest(load){
  interactiveInFlight++;
  try{return await load();}
  finally{interactiveInFlight--;}
}
async function readJsonBody(req,maxBytes=65536){
  const chunks=[];let total=0;
  for await(const chunk of req){
    total+=chunk.length;
    if(total>maxBytes)throw new MarketError('请求体过大。',413);
    chunks.push(chunk);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw new MarketError('无效的 JSON 请求体。',400);}
}
function validateWatchlistPayload(payload){
  const rawItems=Array.isArray(payload)?payload:payload&&typeof payload==='object'?payload.items:null;
  if(!Array.isArray(rawItems))throw new MarketError('自选列表格式无效。',400);
  if(rawItems.length>50)throw new MarketError('自选列表最多支持 50 个标的。',400);
  const items=[],seen=new Set();
  for(const row of rawItems){
    if(!row||typeof row!=='object')throw new MarketError('自选条目格式无效。',400);
    const market=parseMarket(typeof row.market==='string'?row.market:null);
    const symbol=normalizeSymbol(market,typeof row.symbol==='string'?row.symbol:'');
    const name=typeof row.name==='string'?row.name.trim().slice(0,120):'';
    if(!name)throw new MarketError('自选标的名称不能为空。',400);
    const exchange=typeof row.exchange==='string'?row.exchange.trim().slice(0,80):'';
    const currency=typeof row.currency==='string'?row.currency.trim().slice(0,20):'';
    const id=`${market}:${symbol}`;
    if(seen.has(id))continue;
    seen.add(id);
    items.push({id,market,symbol,name,exchange,currency});
  }
  return items;
}
let exitTimer;
let activeBacktestWorker=null;
function higherIntervalFor(market,interval){
  const next={'1m':'5m','5m':'15m','15m':'1h','30m':'4h','1h':'4h','4h':'1d','1d':'1w','1w':'1M','1M':null};
  if(market==='cn'&&interval==='1h')return '1d';
  if(market==='cn'&&interval==='4h')return '1w';
  return next[interval]??null;
}
function validateOptionalContract(market,symbol,raw){
  const contract=typeof raw==='string'?raw.trim():'';
  if(!contract)return '';
  if(market!=='commodity'||!/^(?:GC|SI|CL)[FGHJKMNQUVXZ]\d{2}$/.test(contract)||!contract.startsWith(symbol.split('=')[0]))throw new MarketError('合约月份无效。',400);
  return contract;
}
function parseEpochParam(raw,name){
  if(raw===null||raw===undefined||raw==='')return undefined;
  const value=typeof raw==='number'?raw:Number(raw);
  if(!Number.isSafeInteger(value)||value<0)throw new MarketError(`${name} 参数无效。`,400);
  return value;
}
function runBacktestWorker({appRoot,primary,higher,canLoadMinutes,options,archive,res}){
  return new Promise((resolveRun,rejectRun)=>{
    let settled=false;
    const worker=new Worker(resolve(appRoot,'backtest-worker.mjs'),{
      workerData:{primary,higher,canLoadMinutes,options},
    });
    activeBacktestWorker=worker;
    const cleanup=()=>{
      clearTimeout(timer);
      res.off('close',onAbort);
      if(activeBacktestWorker===worker)activeBacktestWorker=null;
    };
    const finish=(err,value)=>{
      if(settled)return;
      settled=true;
      cleanup();
      if(err)rejectRun(err);
      else resolveRun(value);
    };
    const timer=setTimeout(()=>{
      void worker.terminate();
      finish(new MarketError('回测计算超时，请缩小K线数量后重试。',504));
    },120000);
    timer.unref?.();
    const onAbort=()=>{
      if(res.writableEnded||settled)return;
      void worker.terminate();
      finish(new MarketError('客户端已取消回测请求。',499));
    };
    res.on('close',onAbort);
    worker.on('message',msg=>{
      if(!msg||typeof msg!=='object')return;
      if(msg.type==='need-minutes'){
        const minute=archive.readMinuteWindows(primary,msg.ranges);
        worker.postMessage({type:'minutes',minute});
        return;
      }
      if(msg.type==='done'){finish(null,msg.result);return;}
      if(msg.type==='error'){finish(new MarketError(msg.message||'回测计算失败。',Number.isInteger(msg.status)?msg.status:400));}
    });
    worker.on('error',err=>{
      finish(new MarketError(err instanceof Error?err.message:'回测工作线程异常。',502));
    });
    worker.on('exit',code=>{
      if(!settled)finish(new MarketError(`回测工作线程意外退出 (${code})。`,502));
    });
  });
}
function shutdown(reason='No workbench windows remain. Stopping local service.'){
  console.log(reason);
  hubStream.close();
  if(activeBacktestWorker){try{void activeBacktestWorker.terminate();}catch{}activeBacktestWorker=null;}
  void watchlistSync.stop();
  for(const window of windows)window.end();
  server.closeAllConnections();
  server.close(()=>{archive.close();process.exit(0);});
  setTimeout(()=>{archive.close();process.exit(0);},1000).unref();
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
  try{
    const url=new URL(req.url||'/',origin);
    const allowedMethod=req.method==='GET'||req.method==='HEAD'||(req.method==='PUT'&&url.pathname==='/api/watchlist')||(req.method==='POST'&&url.pathname==='/api/validation/run');
    if(!allowedMethod)return json(res,405,{error:'Read-only endpoint'});
    if(url.pathname==='/health'){
      const hub=await getLongbridgeHubCapabilities();
      return json(res,200,{
        app:'trend-workbench',
        version:'VERSION_FROM_PACKAGE',
        buildId,
        pid:process.pid,
        activeWindows:windows.size,
        autoExit,
        longbridge:process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE==='1',
        longbridgeHub:{
          configured:hub.configured,
          ready:hub.ready,
          status:hub.status,
          usRealtime:hub.usRealtime,
          hkRealtime:hub.hkRealtime,
          cnRealtime:hub.cnRealtime,
        },
        watchlistSync:watchlistSync.status().enabled,
      });
    }
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
    if(url.pathname==='/api/watchlist'){
      if(req.method==='PUT'){
        const items=validateWatchlistPayload(await readJsonBody(req));
        const saved=archive.setWatchlist(items);
        watchlistSync.notifyWatchlistChanged();
        return json(res,200,saved);
      }
      return json(res,200,archive.getWatchlist());
    }
    if(url.pathname==='/api/cache/status'){
      return json(res,200,{...watchlistSync.status(),watchlistCount:archive.getWatchlist().items.length,series:archive.listSeriesStatus({pinnedOnly:url.searchParams.get('all')!=='1'})});
    }
    if(url.pathname==='/api/cache/candles'){
      const market=parseMarket(url.searchParams.get('market'));
      const interval=parseInterval(url.searchParams.get('interval')||'1d',market);
      const rawSymbol=url.searchParams.get('symbol');
      if(!rawSymbol)throw new MarketError('缺少标的代码。',400);
      const symbol=normalizeSymbol(market,rawSymbol);
      const source=url.searchParams.get('source')||undefined;
      const adjustment=url.searchParams.get('adjustment')||undefined;
      if((source&&source.length>200)||(adjustment&&adjustment.length>200))throw new MarketError('来源或复权参数无效。',400);
      const contract=validateOptionalContract(market,symbol,url.searchParams.get('contract'));
      const from=parseEpochParam(url.searchParams.get('from'),'from');
      const to=parseEpochParam(url.searchParams.get('to'),'to');
      if(from!==undefined&&to!==undefined&&to<from)throw new MarketError('结束时间不能早于开始时间。',400);
      const limitRaw=url.searchParams.get('limit');
      const limit=limitRaw===null||limitRaw===''?5000:Number(limitRaw);
      if(!Number.isInteger(limit)||limit<1||limit>20000)throw new MarketError('缓存K线数量须为1至20000。',400);
      const format=url.searchParams.get('format')||'json';
      if(format!=='json'&&format!=='csv')throw new MarketError('导出格式须为 json 或 csv。',400);
      const result=archive.readSeries({market,symbol,interval,source,adjustment,contract,from,to,maxBars:limit,contiguousOnly:true});
      if(!result||!result.data.candles.length)return json(res,404,{error:'本机尚未缓存该标的所选范围的历史K线。'});
      if(format==='csv'){
        const csv='time,open,high,low,close,volume,closed\n'+result.data.candles.map(c=>[new Date(c.time*1000).toISOString(),c.open,c.high,c.low,c.close,c.volume,c.closed!==false].join(',')).join('\n');
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${symbol}-${interval}-cached.csv"`,'Cache-Control':'no-store'});
        res.end(req.method==='HEAD'?undefined:csv);
        return;
      }
      return json(res,200,{
        market,symbol,interval,
        source:result.data.source,
        adjustment:result.data.adjustment,
        ...(result.data.instrument.contract&&{contract:result.data.instrument.contract}),
        asOf:result.data.asOf,
        instrument:result.data.instrument,
        candles:result.data.candles,
        totalBars:result.totalBars,
        segmentCount:result.segmentCount,
        truncated:result.truncated,
      });
    }
    if(url.pathname==='/api/validation/run'){
      if(activeBacktestWorker)throw new MarketError('已有回测任务正在运行，请等待当前回测完成。',429);
      const body=await readJsonBody(req,8192);
      if(!body||typeof body!=='object'||Array.isArray(body))throw new MarketError('无效的回测参数。',400);
      const market=parseMarket(typeof body.market==='string'?body.market:null);
      const interval=parseInterval(typeof body.interval==='string'?body.interval:null,market);
      const rawSymbol=typeof body.symbol==='string'?body.symbol:'';
      if(!rawSymbol)throw new MarketError('缺少标的代码。',400);
      const symbol=normalizeSymbol(market,rawSymbol);
      const source=typeof body.source==='string'&&body.source?body.source:undefined;
      const adjustment=typeof body.adjustment==='string'&&body.adjustment?body.adjustment:undefined;
      if((source&&source.length>200)||(adjustment&&adjustment.length>200))throw new MarketError('来源或复权参数无效。',400);
      const contract=validateOptionalContract(market,symbol,body.contract);
      const from=parseEpochParam(body.from,'from');
      const to=parseEpochParam(body.to,'to');
      if(from!==undefined&&to!==undefined&&to<from)throw new MarketError('结束时间不能早于开始时间。',400);
      const maxBars=body.maxBars===undefined?2000:Number(body.maxBars);
      if(!Number.isInteger(maxBars)||maxBars<100||maxBars>6000)throw new MarketError('回测K线数量须为100至6000。',400);
      const folds=body.folds===undefined?3:Number(body.folds);
      if(!Number.isInteger(folds)||folds<2||folds>10)throw new MarketError('滚动折数须为2至10。',400);
      const warmupFraction=body.warmupFraction===undefined?0.4:Number(body.warmupFraction);
      if(!Number.isFinite(warmupFraction)||warmupFraction<0.25||warmupFraction>0.75)throw new MarketError('预热比例须在0.25至0.75之间。',400);
      const feeBps=body.feeBps===undefined?5:Number(body.feeBps);
      const slippageBps=body.slippageBps===undefined?3:Number(body.slippageBps);
      if(!Number.isFinite(feeBps)||feeBps<0||feeBps>200||!Number.isFinite(slippageBps)||slippageBps<0||slippageBps>200)throw new MarketError('手续费或滑点须在0至200 bps之间。',400);
      const penMode=body.penMode===undefined?'new':body.penMode;
      if(penMode!=='new'&&penMode!=='old')throw new MarketError('笔划分模式无效。',400);
      if(activeBacktestWorker)throw new MarketError('已有回测任务正在运行，请等待当前回测完成。',429);
      const primaryResult=archive.readSeries({market,symbol,interval,source,adjustment,contract,from,to,maxBars,contiguousOnly:true});
      if(!primaryResult||!primaryResult.data.candles.length)return json(res,404,{error:'本机尚未缓存该标的所选范围的历史K线。'});
      const higher=archive.readCompatibleHigher(primaryResult.data,higherIntervalFor(market,interval),{maxBars:Math.max(maxBars,2000)});
      const outcome=await runBacktestWorker({
        appRoot,
        primary:primaryResult.data,
        higher,
        canLoadMinutes:interval!=='1m',
        options:{folds,warmupFraction,costs:{feeBps,slippageBps},penMode},
        archive,
        res,
      });
      if(res.writableEnded)return;
      return json(res,200,{
        ...outcome,
        cache:{
          key:primaryResult.key,
          totalBars:primaryResult.totalBars,
          segmentCount:primaryResult.segmentCount,
          truncated:primaryResult.truncated,
        },
      });
    }
    if(url.pathname==='/api/search'){
      const q=url.searchParams.get('q')||'';
      if(q.length>60)throw new MarketError('搜索内容最多60个字符。',400);
      const market=parseSearchMarket(url.searchParams.get('market'));
      return json(res,200,await interactiveRequest(()=>marketRequest(()=>searchInstruments(market,q))));
    }
    if(url.pathname==='/api/live-quote')return json(res,200,await interactiveRequest(()=>marketRequest(()=>getWorkbenchLiveQuote(url.searchParams))));
    if(url.pathname==='/api/live-stream')return await hubStream.handleRequest(req,res,url,{parseMarket,parseInterval,normalizeSymbol,toLongbridgeTicker});
    if(url.pathname==='/api/battle'){
      try{return json(res,200,await interactiveRequest(()=>marketRequest(()=>getBattleTape(url.searchParams))));}
      catch(error){if(error instanceof RangeError)throw new MarketError(error.message,400);throw error;}
    }
    if(url.pathname==='/api/history')return json(res,200,await interactiveRequest(()=>marketRequest(()=>archive.older(url.searchParams))));
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
      return json(res,200,await interactiveRequest(()=>marketRequest(()=>archive.candles(market,normalized,interval,limit))));
    }
    if(url.pathname==='/api/spot-flow'||url.pathname==='/api/journal-minutes'){
      try{
        await checkNetworkRoute();
        const load=url.pathname==='/api/spot-flow'?getSpotFlow:getJournalMinutes;
        return json(res,200,await interactiveRequest(()=>load(url.searchParams)));
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
    if(res.writableEnded||res.destroyed)return;
    if(error?.code==='ENOENT')return json(res,404,{error:'Not found'});
    const status=error instanceof MarketError?error.status:502;
    json(res,status,{error:error instanceof Error?error.message:'本机服务暂时无法取得行情。'});
  }
});
server.requestTimeout=150000;
server.headersTimeout=15000;
server.on('error',error=>{console.error(error.code||error.message);process.exitCode=1;});
server.listen(requestedPort,'127.0.0.1',()=>{
  port=server.address().port;
  origin=`http://127.0.0.1:${port}`;
  if(process.argv.includes('--announce-ready'))console.log(`TREND_WORKBENCH_READY ${port}`);
  console.log(`Trend Workbench ${origin} · pid ${process.pid}`);
  watchlistSync.start();
  scheduleExit(90000);
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>shutdown(`Received ${signal}. Stopping local service.`));
