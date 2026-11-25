export const DEFAULT_SYNC_INTERVALS=['1m','5m','15m','1h','1d'];
export const BACKFILL_DAYS={'1m':14,'5m':60,'15m':60,'30m':90,'1h':180,'4h':365,'1d':1095,'1w':1825,'1M':3650};
const VALID_INTERVALS=new Set(['1m','5m','15m','30m','1h','4h','1d','1w','1M']);
const REFRESH_MS={'1m':180000,'5m':600000,'15m':1200000,'30m':1800000,'1h':3600000,'4h':7200000,'1d':21600000,'1w':43200000,'1M':86400000};
const INACTIVE_REFRESH_MS=6*3600000;
const RATE_LIMIT_BACKOFF_MS=[5*60000,10*60000,20*60000,60*60000];
const ERROR_BACKOFF_MS=[5*60000,15*60000,30*60000];
const NOT_FOUND_BACKOFF_MS=6*3600000;
const WEEKDAYS={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};

function clockInZone(nowMs,timeZone){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(nowMs));
  const map=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return {weekday:WEEKDAYS[map.weekday]??0,minute:Number(map.hour)*60+Number(map.minute)};
}

export function isMarketActiveForSync(market,interval,nowMs,{longbridgeEnabled=false}={}){
  if(market==='crypto')return true;
  if(market==='commodity'){
    const d=new Date(nowMs),day=d.getUTCDay(),minute=d.getUTCHours()*60+d.getUTCMinutes();
    if(day===6)return false;
    if(day===5&&minute>=22*60)return false;
    if(day===0&&minute<22*60)return false;
    return true;
  }
  if(market==='cn'){
    const {weekday,minute}=clockInZone(nowMs,'Asia/Shanghai');
    return weekday>=1&&weekday<=5&&minute>=565&&minute<=915;
  }
  if(market==='us'){
    const {weekday,minute}=clockInZone(nowMs,'America/New_York');
    if(longbridgeEnabled&&['1m','5m','15m','30m','1h'].includes(interval)){
      if(weekday===6)return false;
      if(weekday===0)return minute>=1200;
      if(weekday===5)return minute<1200;
      return weekday>=1&&weekday<=4;
    }
    return weekday>=1&&weekday<=5&&minute>=565&&minute<=985;
  }
  return true;
}

function parseIntervals(raw){
  if(Array.isArray(raw)){
    const valid=raw.filter(v=>VALID_INTERVALS.has(v));
    return valid.length?valid:DEFAULT_SYNC_INTERVALS.slice();
  }
  if(typeof raw==='string'&&raw.trim()){
    const valid=raw.split(',').map(s=>s.trim()).filter(v=>VALID_INTERVALS.has(v));
    if(valid.length)return [...new Set(valid)];
  }
  return DEFAULT_SYNC_INTERVALS.slice();
}

export function createWatchlistSync({
  archive,
  enabled=true,
  intervals,
  delayMs,
  tickMs,
  isInteractiveBusy,
  now=()=>Date.now(),
  longbridgeEnabled=()=>process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE==='1',
  backfillDays=BACKFILL_DAYS,
  maxPagesPerSeries=120,
  globalCooldownMs,
}={}){
  const syncIntervals=parseIntervals(intervals??process.env.TREND_WORKBENCH_SYNC_INTERVALS);
  const stepDelayMs=Math.max(0,Number.isFinite(delayMs)?delayMs:Number(process.env.TREND_WORKBENCH_SYNC_DELAY_MS??1800));
  const cycleTickMs=Math.max(10,Number.isFinite(tickMs)?tickMs:Number(process.env.TREND_WORKBENCH_SYNC_TICK_MS??30000));
  const cooldown429Ms=Math.max(0,Number.isFinite(globalCooldownMs)?globalCooldownMs:(stepDelayMs===0?0:15000));

  let active=false;
  let stopped=false;
  let running=false;
  let dirty=false;
  let cyclePromise=null;
  let activeRun=null;
  let currentTask=null;
  let lastCycleAt=null;
  let globalCooldownUntil=0;
  let sleepResolve=null;
  let sleepTimer=null;

  const backoffs=new Map();
  const pagesFetched=new Map();

  function cancelSleep(){
    if(sleepTimer){clearTimeout(sleepTimer);sleepTimer=null;}
    if(sleepResolve){const resolve=sleepResolve;sleepResolve=null;resolve();}
  }

  function pause(ms,{wakeOnDirty=false}={}){
    if(stopped||ms<=0)return Promise.resolve();
    if(wakeOnDirty&&dirty)return Promise.resolve();
    return new Promise(resolve=>{
      const done=()=>{sleepTimer=null;sleepResolve=null;resolve();};
      sleepResolve=done;
      sleepTimer=setTimeout(done,ms);
      sleepTimer.unref?.();
    });
  }

  async function waitWhileInteractiveBusy(){
    while(!stopped&&isInteractiveBusy?.()){
      await pause(250);
    }
  }

  function recordFailure(taskKey,info,error){
    const status=error?.status;
    const upstream=error?.upstreamStatus;
    const message=error instanceof Error?error.message:String(error||'Sync error');
    const prev=backoffs.get(taskKey)??{failures:0,until:0};
    const failures=prev.failures+1;
    let waitMs;
    if(status===429||upstream===429||/429|限流|rate limit/i.test(message)){
      waitMs=RATE_LIMIT_BACKOFF_MS[Math.min(failures-1,RATE_LIMIT_BACKOFF_MS.length-1)];
      if(cooldown429Ms>0)globalCooldownUntil=now()+cooldown429Ms;
    }else if(status===404){
      waitMs=NOT_FOUND_BACKOFF_MS;
    }else{
      waitMs=ERROR_BACKOFF_MS[Math.min(failures-1,ERROR_BACKOFF_MS.length-1)];
    }
    backoffs.set(taskKey,{failures,until:now()+waitMs});
    if(info?.key)archive.recordSyncState(info.key,{lastError:message.slice(0,240)});
  }

  async function executeCycle(){
    if(running)return activeRun;
    running=true;
    activeRun=(async()=>{
      try{
        const {items}=archive.getWatchlist();
        const lb=Boolean(longbridgeEnabled());
        for(const item of items){
          for(const interval of syncIntervals){
            if(stopped)return;
            const currentMs=now();
            if(globalCooldownUntil>currentMs)return;
            const taskKey=`${item.market}:${item.symbol.toUpperCase()}:${interval}`;
            if((backoffs.get(taskKey)?.until??0)>currentMs)continue;

            let info=archive.getSeriesInfo(item.market,item.symbol,interval);
            const active=isMarketActiveForSync(item.market,interval,currentMs,{longbridgeEnabled:lb});
            const refreshThreshold=active?(REFRESH_MS[interval]??3600000):INACTIVE_REFRESH_MS;
            const needsIncremental=!info||!info.lastSyncAt||(currentMs-info.lastSyncAt>=refreshThreshold);

            if(needsIncremental){
              await waitWhileInteractiveBusy();
              if(stopped)return;
              currentTask={market:item.market,symbol:item.symbol,interval,phase:'incremental'};
              try{
                await archive.candles(item.market,item.symbol,interval,800);
                info=archive.getSeriesInfo(item.market,item.symbol,interval);
                if(info)archive.recordSyncState(info.key,{lastSyncAt:now(),lastError:null});
                backoffs.delete(taskKey);
              }catch(error){
                recordFailure(taskKey,info,error);
                if(globalCooldownUntil>now())return;
                await pause(stepDelayMs);
                continue;
              }
              await pause(stepDelayMs);
              if(stopped)return;
            }

            info=archive.getSeriesInfo(item.market,item.symbol,interval);
            if(info&&!info.backfillDone&&info.firstTime){
              const targetDays=backfillDays[interval]??30;
              const targetStart=Math.floor(now()/1000)-targetDays*86400;
              const fetchedCount=pagesFetched.get(info.key)??0;
              if(info.firstTime<=targetStart||fetchedCount>=maxPagesPerSeries){
                archive.recordSyncState(info.key,{backfillDone:true});
                continue;
              }
              await waitWhileInteractiveBusy();
              if(stopped)return;
              currentTask={market:item.market,symbol:item.symbol,interval,phase:'backfill'};
              try{
                const params=new URLSearchParams({
                  market:item.market,
                  symbol:item.symbol,
                  interval,
                  source:info.meta.source,
                  adjustment:info.meta.adjustment,
                  ...(info.meta.instrument?.contract?{contract:info.meta.instrument.contract}:{}),
                  before:String(info.firstTime),
                  limit:'500',
                });
                const page=await archive.older(params);
                const nextCount=fetchedCount+1;
                pagesFetched.set(info.key,nextCount);
                const after=archive.getSeriesInfo(item.market,item.symbol,interval);
                const reachedBoundary=page.status==='end'||page.status==='unsupported'||!page.candles?.length;
                const noProgress=Boolean(after&&after.firstTime>=info.firstTime);
                const reachedTarget=Boolean(after&&after.firstTime<=targetStart);
                const hitCap=nextCount>=maxPagesPerSeries;
                archive.recordSyncState(info.key,{lastError:null,backfillDone:reachedBoundary||noProgress||reachedTarget||hitCap});
                backoffs.delete(taskKey);
              }catch(error){
                recordFailure(taskKey,info,error);
                if(globalCooldownUntil>now())return;
              }
              await pause(stepDelayMs);
            }
          }
        }
      }finally{
        currentTask=null;
        lastCycleAt=now();
        running=false;
        activeRun=null;
      }
    })();
    return activeRun;
  }

  function start(){
    if(!enabled||active)return;
    active=true;
    stopped=false;
    cyclePromise=(async()=>{
      try{
        const bootDelay=Math.min(stepDelayMs,2000);
        if(bootDelay>0)await pause(bootDelay,{wakeOnDirty:true});
        while(!stopped){
          dirty=false;
          await executeCycle();
          if(stopped)break;
          if(dirty)continue;
          await pause(cycleTickMs,{wakeOnDirty:true});
        }
      }finally{
        active=false;
      }
    })();
  }

  async function stop(){
    if(stopped&&!active&&!cyclePromise)return;
    stopped=true;
    active=false;
    cancelSleep();
    try{await cyclePromise;}catch{}
    cyclePromise=null;
  }

  function notifyWatchlistChanged(){
    dirty=true;
    if(enabled&&active&&!stopped&&!running)cancelSleep();
  }

  return {
    start,
    stop,
    notifyWatchlistChanged,
    runOnce:executeCycle,
    status(){
      return {
        enabled:Boolean(enabled),
        intervals:syncIntervals.slice(),
        running,
        currentTask,
        lastCycleAt,
      };
    },
  };
}
