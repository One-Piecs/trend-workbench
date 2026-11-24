import {mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {createRequire} from 'node:module';

const maxBars=12000, maxSeries=48;
const selection=(market,symbol,interval)=>JSON.stringify([market,symbol,interval]);
const identity=({market,symbol,interval,source,adjustment,contract=''})=>JSON.stringify([market,symbol,interval,source,adjustment,contract]);
const fields=data=>({market:data.instrument.market,symbol:data.instrument.symbol,interval:data.interval,source:data.source,
  adjustment:data.adjustment,...(data.instrument.contract&&{contract:data.instrument.contract})});
const publicSources=/^(?:(?:Binance|OKX|Bitget|Bybit|Kraken) 公共现货行情 · |Yahoo Finance (?:网页|期货)行情 · |东方财富 |腾讯证券 |新浪财经 )/;
const canKeep=data=>publicSources.test(data.source)&&(data.instrument.market!=='commodity'||!!data.instrument.contract);
const last=arr=>arr[arr.length-1];
function validBar(bar,signed){
  return bar && bar.closed===true && Number.isSafeInteger(bar.time)&&bar.time>0
    &&[bar.open,bar.high,bar.low,bar.close,bar.volume].every(Number.isFinite)
    &&(signed||bar.low>0)&&bar.volume>=0&&bar.low<=Math.min(bar.open,bar.close)&&bar.high>=Math.max(bar.open,bar.close);
}
function clean(bars,signed,asOf){
  return bars.filter(b=>b.closed===true).every((b,i,a)=>validBar(b,signed)&&b.time<=asOf&&(!i||b.time>a[i-1].time));
}
function coverage(data,bars,requested){
  const closed=bars.filter(b=>b.closed===true).length;
  return {...data,candles:bars,history:{requested,received:bars.length,closed,firstTime:bars[0]?.time??null,
    lastTime:last(bars)?.time??null,status:closed<35?'insufficient':bars.length<requested?'limited':'target-met'}};
}
function cachePath(){
  const base=process.platform==='win32'?(process.env.LOCALAPPDATA||join(homedir(),'AppData','Local')):
    process.platform==='darwin'?join(homedir(),'Library','Caches'):(process.env.XDG_CACHE_HOME||join(homedir(),'.cache'));
  return join(base,'TrendWorkbench','history-v1.sqlite');
}

// A segment is an actual source response or pages connected by an exact
// cursor. A weekend, market halt or inactive symbol never gets synthetic bars.
function stitch(segments,bars,cursor,adjusted){
  let fresh=bars, retained=[],rebased=false;
  for(const old of segments){
    if(last(old).time<fresh[0].time||old[0].time>last(fresh).time){
      if(old[0].time===cursor)fresh=fresh.concat(old);
      else retained.push(old);
      continue;
    }
    const byTime=new Map(old.map(b=>[b.time,b]));
    const overlap=fresh.filter(b=>byTime.has(b.time));
    const stable=overlap.length&&overlap.every(b=>['open','high','low','close'].every(k=>byTime.get(b.time)[k]===b[k]));
    // A split can rebase every historical price. Only an unchanged overlap
    // authorizes retaining a prefix for an adjusted series.
    if(adjusted&&!stable){retained=[];rebased=true;continue;}
    for(const bar of fresh)byTime.set(bar.time,bar);
    fresh=[...byTime.values()].sort((a,b)=>a.time-b.time);
  }
  retained.push(fresh);
  retained.sort((a,b)=>a[0].time-b[0].time);
  let budget=maxBars;
  for(let i=retained.length-1;i>=0;i--){retained[i]=budget?retained[i].slice(-budget):[];budget-=retained[i].length;}
  return {segments:retained.filter(s=>s.length),rebased};
}

export function createHistoryCache({filename=cachePath(),getCandles,getOlderHistory,latestHistoryGap}){
  let db,disabled=false;
  function connection(){
    if(db||disabled)return db;
    try{
      const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
      if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true,mode:0o700});
      db=new DatabaseSync(filename);
      db.exec('PRAGMA busy_timeout=200; PRAGMA max_page_count=16384; CREATE TABLE IF NOT EXISTS series (key TEXT PRIMARY KEY, selection TEXT NOT NULL, stamp INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS recent ON series(selection,stamp DESC);');
      return db;
    }catch{disabled=true;try{db?.close();}catch{}db=undefined;}
  }
  function get(key,lookup=false){
    try{
      const conn=connection();
      if(!conn)return null;
      const row=conn.prepare(lookup?'SELECT payload FROM series WHERE selection=? ORDER BY stamp DESC LIMIT 1':'SELECT payload FROM series WHERE key=?').get(key);
      if(!row)return null;
      const value=JSON.parse(row.payload);
      if(!canKeep(value.meta)||!Array.isArray(value.segments)||!value.segments.length)return null;
      const id=fields(value.meta);
      if((lookup?selection(id.market,id.symbol,id.interval):identity(id))!==key)return null;
      let end=0,count=0;
      const signed=value.meta.instrument.symbol==='CL=F';
      for(const segment of value.segments){
        if(!Array.isArray(segment)||!segment.length||segment[0].time<=end)return null;
        for(const b of segment){if(!validBar(b,signed)||b.time<=end||++count>maxBars)return null;end=b.time;}
      }
      return value;
    }catch{return null;}
  }
  function save(data,incoming,cursor){
    const stamp=Date.parse(data.asOf);
    if(!Number.isFinite(stamp)||!canKeep(data)||!clean(incoming,data.instrument.symbol==='CL=F',stamp/1000))return;
    const confirmed=incoming.filter(b=>b.closed===true);
    if(!confirmed.length)return;
    const conn=connection();if(!conn)return;
    try{
      conn.exec('BEGIN IMMEDIATE');
      const id=fields(data),key=identity(id),old=get(key);
      if((cursor===undefined&&Date.parse(old?.meta.asOf)>stamp)||(cursor!==undefined&&!old)){
        conn.exec('ROLLBACK');return;
      }
      const {segments,rebased}=stitch(old?.segments??[],confirmed,cursor,/调整后|前复权|后复权/.test(data.adjustment));
      const meta=cursor===undefined?{...data,candles:[],history:undefined}:old.meta;
      conn.prepare('INSERT OR REPLACE INTO series VALUES(?,?,?,?)').run(key,selection(id.market,id.symbol,id.interval),Date.parse(meta.asOf),JSON.stringify({meta,segments}));
      conn.exec('DELETE FROM series WHERE key IN (SELECT key FROM series ORDER BY stamp DESC LIMIT -1 OFFSET '+maxSeries+'); COMMIT');
      return {meta,segments,rebased};
    }catch{try{conn.exec('ROLLBACK');}catch{}}
  }
  function preview(market,symbol,interval,limit=800){
    const old=get(selection(market,symbol,interval),true);
    return old?coverage(old.meta,last(old.segments).slice(-limit),limit):null;
  }
  function withPrefix(snap,record,count){
    if(!record||!snap.candles.length)return;
    const first=snap.candles[0];
    const segment=record.segments.find(s=>s.some(b=>b.time===first.time));
    if(!segment)return;
    const end=last(snap.candles).time,byTime=new Map(segment.filter(b=>b.time<=end).map(b=>[b.time,b]));
    for(const bar of snap.candles)byTime.set(bar.time,bar);
    return coverage(snap,[...byTime.values()].sort((a,b)=>a.time-b.time).slice(-count),count);
  }
  async function candles(market,symbol,interval,limit){
    const target=Math.min(1000,Math.max(100,limit));
    const old=get(selection(market,symbol,interval),true);
    if(!old||last(old.segments).length<target-2||target<=100){
      const full=await getCandles(market,symbol,interval,limit);
      return withPrefix(full,save(full,full.candles),target)??full;
    }
    const recent=await getCandles(market,symbol,interval,100);
    if(identity(fields(old.meta))===identity(fields(recent))){
      const record=save(recent,recent.candles);
      const merged=withPrefix(recent,record,target);
      if(merged&&merged.candles.length===target)return merged;
      // Beyond the overlap, fill only the missing prefix from the same venue.
      // If a provider ignores historical cursors, retry the normal full window.
      if(record&&!record.rebased&&recent.candles.length){
        const before=recent.candles[0].time;
        const params=new URLSearchParams({...fields(recent),before:String(before),limit:String(target-recent.candles.length+1)});
        try{
          const page=await older(params);
          if(page.candles.length){
            const joined=withPrefix(recent,get(identity(fields(recent))),target);
            if(joined&&joined.candles.length===target)return joined;
          }
        }catch{/* Existing full-window fallback remains available. */}
      }
    }
    const full=await getCandles(market,symbol,interval,limit);
    return withPrefix(full,save(full,full.candles),target)??full;
  }
  async function older(params){
    const request=Object.fromEntries(params),before=Number(request.before),limit=Number(request.limit??500);
    const old=get(identity(request));
    if(old&&Number.isSafeInteger(before)&&Number.isInteger(limit)&&limit>0&&limit<=1000){
      const part=old.segments.find(s=>s[0].time<before&&before<=last(s).time);
      const found=part?.filter(b=>b.time<before).slice(-limit);
      if(found?.length)return {...fields(old.meta),status:'more',candles:found};
    }
    const page=await getOlderHistory(params);
    if(old&&identity(page)===identity(fields(old.meta))&&page.candles?.length&&last(page.candles).time<before)
      save(old.meta,page.candles,before);
    return page;
  }
  const gapCooldown=new Map();
  async function refresh(market,symbol,interval,limit){
    const data=await candles(market,symbol,interval,limit);
    const gap=canKeep(data)&&latestHistoryGap?.(data);
    if(gap&&!disabled){
      const id=fields(data),key=identity(id)+'/'+gap.before,now=Date.now();
      if(!(gapCooldown.get(key)>now)){
        for(const [k,until] of gapCooldown)if(until<=now)gapCooldown.delete(k);
        if(gapCooldown.size>=256)gapCooldown.delete(gapCooldown.keys().next().value);
        gapCooldown.set(key,now+600000);
        const params=new URLSearchParams({...id,before:String(gap.before),limit:String(gap.limit)});
        // Don't hold the chart open for a secondary lookup. The next normal
        // refresh/scroll can read any observed missing rows from disk.
        void Promise.resolve().then(()=>getOlderHistory(params)).then(page=>{
          if(identity(page)!==identity(id))return;
          const inside=page.candles.filter(b=>b.time>=gap.after&&b.time<gap.before);
          if(!inside.some(b=>b.time>gap.after))return;
          if(/调整后|前复权|后复权/.test(data.adjustment)){
            const seam=data.candles.find(b=>b.time===gap.after);
            if(inside[0]?.time!==gap.after||!seam||!['open','high','low','close'].every(k=>inside[0][k]===seam[k]))return;
          }
          save(data,inside,gap.before);
        }).catch(()=>{});
      }
    }
    return data;
  }
  return {preview,candles:refresh,older,close(){disabled=true;db?.close();db=undefined;}};
}
