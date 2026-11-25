import {mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {createRequire} from 'node:module';

const maxUnpinnedBars=12000, maxUnpinnedSeries=48;
const pinnedBarCaps={'1m':250000,'5m':150000,'15m':150000,'30m':150000,'1h':100000,'4h':100000,'1d':50000,'1w':50000,'1M':50000};
const validSessions=new Set(['pre','regular','post','overnight']);
const selection=(market,symbol,interval)=>JSON.stringify([market,symbol.toUpperCase(),interval]);
const identity=({market,symbol,interval,source,adjustment,contract=''})=>JSON.stringify([market,symbol,interval,source,adjustment,contract]);
const fields=data=>({market:data.instrument.market,symbol:data.instrument.symbol,interval:data.interval,source:data.source,
  adjustment:data.adjustment,...(data.instrument.contract&&{contract:data.instrument.contract})});
const publicSources=/^(?:(?:Binance|OKX|Bitget|Bybit|Kraken) 公共现货行情 · |Yahoo Finance (?:网页|期货)行情 · |Longbridge OpenAPI 美股行情（含夜盘） · |东方财富 |腾讯证券 |新浪财经 )/;
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
function rowToCandle(row){
  return {
    time:row.time,open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume,closed:true,
    ...(row.session?{session:row.session}:{}),
  };
}
function coverage(data,bars,requested){
  const closed=bars.filter(b=>b.closed===true).length;
  return {...data,candles:bars,history:{requested,received:bars.length,closed,firstTime:bars[0]?.time??null,
    lastTime:last(bars)?.time??null,status:closed<35?'insufficient':bars.length<requested?'limited':'target-met'}};
}
function cachePath(){
  if(process.env.TREND_WORKBENCH_CACHE_PATH)return process.env.TREND_WORKBENCH_CACHE_PATH;
  const base=process.platform==='win32'?(process.env.LOCALAPPDATA||join(homedir(),'AppData','Local')):
    process.platform==='darwin'?join(homedir(),'Library','Caches'):(process.env.XDG_CACHE_HOME||join(homedir(),'.cache'));
  return join(base,'TrendWorkbench','history-v2.sqlite');
}

function mergeSegments(oldSegments,freshStart,freshEnd,cursor){
  let start=freshStart,end=freshEnd;
  const retained=[];
  for(const seg of oldSegments){
    if(seg.end_time<freshStart||seg.start_time>freshEnd){
      if(cursor!==undefined&&seg.start_time===cursor){
        start=Math.min(start,seg.start_time);
        end=Math.max(end,seg.end_time);
      }else{
        retained.push(seg);
      }
      continue;
    }
    start=Math.min(start,seg.start_time);
    end=Math.max(end,seg.end_time);
  }
  retained.push({start_time:start,end_time:end});
  retained.sort((a,b)=>a.start_time-b.start_time);
  return retained;
}

export function createHistoryCache({filename=cachePath(),getCandles,getOlderHistory,latestHistoryGap}={}){
  let db,disabled=false;
  function connection(){
    if(db||disabled)return db;
    try{
      const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
      if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true,mode:0o700});
      db=new DatabaseSync(filename);
      const maxMb=Math.max(64,Number(process.env.TREND_WORKBENCH_CACHE_MAX_MB)||2048);
      const maxPages=Math.floor(maxMb*256);
      db.exec(`
        PRAGMA busy_timeout=500;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA max_page_count=${maxPages};
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS watchlist (
          id TEXT PRIMARY KEY,
          market TEXT NOT NULL,
          symbol TEXT NOT NULL,
          name TEXT NOT NULL,
          exchange TEXT NOT NULL,
          currency TEXT NOT NULL,
          position INTEGER NOT NULL,
          added_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS series (
          key TEXT PRIMARY KEY,
          selection TEXT NOT NULL,
          market TEXT NOT NULL,
          symbol TEXT NOT NULL,
          interval TEXT NOT NULL,
          source TEXT NOT NULL,
          adjustment TEXT NOT NULL,
          contract TEXT NOT NULL DEFAULT '',
          meta_json TEXT NOT NULL,
          stamp INTEGER NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          bar_count INTEGER NOT NULL DEFAULT 0,
          first_time INTEGER,
          last_time INTEGER,
          last_sync_at INTEGER,
          last_error TEXT,
          backfill_done INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS series_selection_stamp ON series(selection, stamp DESC);
        CREATE INDEX IF NOT EXISTS series_pinned_stamp ON series(pinned, stamp DESC);
        CREATE TABLE IF NOT EXISTS candles (
          series_key TEXT NOT NULL,
          time INTEGER NOT NULL,
          open REAL NOT NULL,
          high REAL NOT NULL,
          low REAL NOT NULL,
          close REAL NOT NULL,
          volume REAL NOT NULL,
          session TEXT,
          PRIMARY KEY (series_key, time),
          FOREIGN KEY (series_key) REFERENCES series(key) ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS segments (
          series_key TEXT NOT NULL,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          PRIMARY KEY (series_key, start_time),
          FOREIGN KEY (series_key) REFERENCES series(key) ON DELETE CASCADE
        ) WITHOUT ROWID;
      `);
      return db;
    }catch{disabled=true;try{db?.close();}catch{}db=undefined;}
  }

  function trimSeries(conn,key,budget,segments){
    const countRow=conn.prepare('SELECT COUNT(*) AS n FROM candles WHERE series_key=?').get(key);
    const total=countRow?.n??0;
    if(total<=budget)return segments;
    const excess=total-budget;
    const cutoff=conn.prepare('SELECT time FROM candles WHERE series_key=? ORDER BY time ASC LIMIT 1 OFFSET ?').get(key,excess);
    if(!cutoff)return segments;
    const keepFrom=cutoff.time;
    conn.prepare('DELETE FROM candles WHERE series_key=? AND time<?').run(key,keepFrom);
    const next=[];
    const minStmt=conn.prepare('SELECT MIN(time) AS min_t FROM candles WHERE series_key=? AND time>=? AND time<=?');
    for(const seg of segments){
      if(seg.end_time<keepFrom)continue;
      if(seg.start_time<keepFrom){
        const bound=minStmt.get(key,keepFrom,seg.end_time);
        if(bound?.min_t!=null)next.push({start_time:bound.min_t,end_time:seg.end_time});
      }else{
        next.push(seg);
      }
    }
    return next;
  }

  function readSeriesRecord(conn,key,lookup=false){
    const row=conn.prepare(lookup
      ?'SELECT key, meta_json, stamp, pinned, bar_count, first_time, last_time, last_sync_at, last_error, backfill_done FROM series WHERE selection=? ORDER BY stamp DESC LIMIT 1'
      :'SELECT key, meta_json, stamp, pinned, bar_count, first_time, last_time, last_sync_at, last_error, backfill_done FROM series WHERE key=?').get(key);
    if(!row)return null;
    const meta=JSON.parse(row.meta_json);
    if(!canKeep(meta))return null;
    const id=fields(meta);
    if((lookup?selection(id.market,id.symbol,id.interval):identity(id))!==key)return null;
    const segments=conn.prepare('SELECT start_time, end_time FROM segments WHERE series_key=? ORDER BY start_time ASC').all(row.key);
    if(!segments.length)return null;
    return {
      key:row.key,
      meta,
      stamp:row.stamp,
      pinned:Boolean(row.pinned),
      barCount:row.bar_count,
      firstTime:row.first_time,
      lastTime:row.last_time,
      lastSyncAt:row.last_sync_at,
      lastError:row.last_error,
      backfillDone:Boolean(row.backfill_done),
      segments,
    };
  }

  function get(key,lookup=false){
    try{
      const conn=connection();
      if(!conn)return null;
      return readSeriesRecord(conn,key,lookup);
    }catch{return null;}
  }

  function save(data,incoming,cursor){
    const stamp=Date.parse(data.asOf);
    if(!Number.isFinite(stamp)||!canKeep(data)||!clean(incoming,data.instrument.symbol==='CL=F',stamp/1000))return;
    const confirmed=incoming.filter(b=>b.closed===true);
    if(!confirmed.length)return;
    const conn=connection();if(!conn)return;
    let begun=false;
    try{
      conn.exec('BEGIN IMMEDIATE');
      begun=true;
      const id=fields(data),key=identity(id),sel=selection(id.market,id.symbol,id.interval);
      const old=conn.prepare('SELECT meta_json, stamp, last_sync_at, last_error, backfill_done FROM series WHERE key=?').get(key);
      const oldMeta=old?JSON.parse(old.meta_json):null;
      if((cursor===undefined&&oldMeta&&Date.parse(oldMeta.asOf)>stamp)||(cursor!==undefined&&!oldMeta)){
        conn.exec('ROLLBACK');return;
      }
      const pinned=conn.prepare('SELECT 1 FROM watchlist WHERE market=? AND UPPER(symbol)=UPPER(?) LIMIT 1').get(id.market,id.symbol)?1:0;
      const freshStart=confirmed[0].time,freshEnd=last(confirmed).time;
      let oldSegments=old?conn.prepare('SELECT start_time, end_time FROM segments WHERE series_key=? ORDER BY start_time ASC').all(key):[];
      let rebased=false;
      const adjusted=/调整后|前复权|后复权/.test(data.adjustment);
      if(adjusted&&oldSegments.some(seg=>!(seg.end_time<freshStart||seg.start_time>freshEnd))){
        const existing=conn.prepare('SELECT time, open, high, low, close FROM candles WHERE series_key=? AND time>=? AND time<=?').all(key,freshStart,freshEnd);
        const byTime=new Map(confirmed.map(b=>[b.time,b]));
        const overlap=existing.filter(row=>byTime.has(row.time));
        const stable=overlap.length>0&&overlap.every(row=>{
          const b=byTime.get(row.time);
          return row.open===b.open&&row.high===b.high&&row.low===b.low&&row.close===b.close;
        });
        if(!stable){
          rebased=true;
          conn.prepare('DELETE FROM candles WHERE series_key=?').run(key);
          conn.prepare('DELETE FROM segments WHERE series_key=?').run(key);
          oldSegments=[];
        }
      }
      const meta=cursor===undefined?{...data,candles:[],history:undefined}:oldMeta;
      const metaStamp=Date.parse(meta.asOf);
      const nextBackfillDone=rebased?0:(old?.backfill_done??0);
      conn.prepare(`
        INSERT INTO series
          (key, selection, market, symbol, interval, source, adjustment, contract, meta_json, stamp, pinned, bar_count, first_time, last_time, last_sync_at, last_error, backfill_done)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          meta_json=excluded.meta_json,
          stamp=excluded.stamp,
          pinned=excluded.pinned,
          last_sync_at=excluded.last_sync_at,
          last_error=excluded.last_error,
          backfill_done=excluded.backfill_done
      `).run(key,sel,id.market,id.symbol,id.interval,id.source,id.adjustment,id.contract??'',JSON.stringify(meta),metaStamp,pinned,old?.last_sync_at??null,old?.last_error??null,nextBackfillDone);

      const upsertCandle=conn.prepare(`
        INSERT OR REPLACE INTO candles (series_key, time, open, high, low, close, volume, session)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for(const b of confirmed){
        const session=validSessions.has(b.session)?b.session:null;
        upsertCandle.run(key,b.time,b.open,b.high,b.low,b.close,b.volume,session);
      }

      let segments=mergeSegments(oldSegments,freshStart,freshEnd,cursor);
      const budget=pinned?(pinnedBarCaps[id.interval]??50000):maxUnpinnedBars;
      segments=trimSeries(conn,key,budget,segments);

      conn.prepare('DELETE FROM segments WHERE series_key=?').run(key);
      const insertSeg=conn.prepare('INSERT INTO segments (series_key, start_time, end_time) VALUES (?, ?, ?)');
      for(const seg of segments)insertSeg.run(key,seg.start_time,seg.end_time);

      const stats=conn.prepare('SELECT COUNT(*) AS n, MIN(time) AS first_t, MAX(time) AS last_t FROM candles WHERE series_key=?').get(key);
      conn.prepare('UPDATE series SET bar_count=?, first_time=?, last_time=? WHERE key=?').run(stats.n,stats.first_t,stats.last_t,key);
      conn.exec(`DELETE FROM series WHERE pinned=0 AND key NOT IN (SELECT key FROM series WHERE pinned=0 ORDER BY stamp DESC LIMIT ${maxUnpinnedSeries}); COMMIT`);
      begun=false;
      return {key,meta,segments,rebased};
    }catch{
      if(begun){try{conn.exec('ROLLBACK');}catch{}}
    }
  }

  function preview(market,symbol,interval,limit=800){
    try{
      const conn=connection();if(!conn)return null;
      const record=readSeriesRecord(conn,selection(market,symbol,interval),true);
      if(!record)return null;
      const seg=last(record.segments);
      const rows=conn.prepare('SELECT time, open, high, low, close, volume, session FROM candles WHERE series_key=? AND time>=? AND time<=? ORDER BY time DESC LIMIT ?')
        .all(record.key,seg.start_time,seg.end_time,limit);
      return coverage(record.meta,rows.reverse().map(rowToCandle),limit);
    }catch{return null;}
  }

  function withPrefix(snap,record,count){
    if(!record||!snap.candles.length)return;
    const conn=connection();if(!conn)return;
    const first=snap.candles[0];
    const seg=record.segments.find(s=>s.start_time<=first.time&&first.time<=s.end_time);
    if(!seg)return;
    const exists=conn.prepare('SELECT 1 FROM candles WHERE series_key=? AND time=?').get(record.key,first.time);
    if(!exists)return;
    const end=last(snap.candles).time;
    const rows=conn.prepare('SELECT time, open, high, low, close, volume, session FROM candles WHERE series_key=? AND time>=? AND time<=? ORDER BY time DESC LIMIT ?')
      .all(record.key,seg.start_time,end,count);
    const byTime=new Map(rows.map(r=>[r.time,rowToCandle(r)]));
    for(const bar of snap.candles)byTime.set(bar.time,bar);
    return coverage(snap,[...byTime.values()].sort((a,b)=>a.time-b.time).slice(-count),count);
  }

  async function candles(market,symbol,interval,limit){
    const target=Math.min(1000,Math.max(100,limit));
    const old=get(selection(market,symbol,interval),true);
    let lastSegCount=0;
    if(old){
      const conn=connection();
      const seg=last(old.segments);
      if(conn&&seg)lastSegCount=conn.prepare('SELECT COUNT(*) AS n FROM candles WHERE series_key=? AND time>=? AND time<=?').get(old.key,seg.start_time,seg.end_time)?.n??0;
    }
    if(!old||lastSegCount<target-2||target<=100){
      const full=await getCandles(market,symbol,interval,limit);
      return withPrefix(full,save(full,full.candles),target)??full;
    }
    const recent=await getCandles(market,symbol,interval,100);
    if(identity(fields(old.meta))===identity(fields(recent))){
      const record=save(recent,recent.candles);
      const merged=withPrefix(recent,record,target);
      if(merged&&merged.candles.length===target)return merged;
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
      const part=old.segments.find(s=>s.start_time<before&&before<=s.end_time);
      const conn=part?connection():null;
      if(part&&conn){
        const rows=conn.prepare('SELECT time, open, high, low, close, volume, session FROM candles WHERE series_key=? AND time>=? AND time<? ORDER BY time DESC LIMIT ?')
          .all(old.key,part.start_time,before,limit);
        if(rows.length)return {...fields(old.meta),status:'more',candles:rows.reverse().map(rowToCandle)};
      }
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

  function getWatchlist(){
    const conn=connection();
    if(!conn)return {initialized:false,items:[]};
    try{
      const initRow=conn.prepare("SELECT value FROM kv WHERE key='watchlist_initialized'").get();
      const rows=conn.prepare('SELECT id, market, symbol, name, exchange, currency FROM watchlist ORDER BY position ASC').all();
      return {initialized:initRow?.value==='1',items:rows.map(r=>({id:r.id,market:r.market,symbol:r.symbol,name:r.name,exchange:r.exchange,currency:r.currency}))};
    }catch{return {initialized:false,items:[]};}
  }

  function setWatchlist(items){
    const conn=connection();
    if(!conn)return {initialized:false,items};
    let begun=false;
    try{
      const now=Date.now();
      conn.exec('BEGIN IMMEDIATE');
      begun=true;
      conn.exec('DELETE FROM watchlist');
      const insert=conn.prepare('INSERT INTO watchlist (id, market, symbol, name, exchange, currency, position, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for(let i=0;i<items.length;i++){
        const item=items[i];
        insert.run(item.id,item.market,item.symbol,item.name,item.exchange||'',item.currency||'',i,now);
      }
      conn.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('watchlist_initialized', '1')").run();
      conn.exec('UPDATE series SET pinned=0');
      const pinStmt=conn.prepare('UPDATE series SET pinned=1 WHERE market=? AND UPPER(symbol)=UPPER(?)');
      for(const item of items)pinStmt.run(item.market,item.symbol);
      const oversized=conn.prepare('SELECT key FROM series WHERE pinned=0 AND bar_count>?').all(maxUnpinnedBars);
      for(const row of oversized){
        const oldSegments=conn.prepare('SELECT start_time, end_time FROM segments WHERE series_key=? ORDER BY start_time ASC').all(row.key);
        const nextSegs=trimSeries(conn,row.key,maxUnpinnedBars,oldSegments);
        conn.prepare('DELETE FROM segments WHERE series_key=?').run(row.key);
        const insertSeg=conn.prepare('INSERT INTO segments (series_key, start_time, end_time) VALUES (?, ?, ?)');
        for(const seg of nextSegs)insertSeg.run(row.key,seg.start_time,seg.end_time);
        const stats=conn.prepare('SELECT COUNT(*) AS n, MIN(time) AS first_t, MAX(time) AS last_t FROM candles WHERE series_key=?').get(row.key);
        conn.prepare('UPDATE series SET bar_count=?, first_time=?, last_time=? WHERE key=?').run(stats.n,stats.first_t,stats.last_t,row.key);
      }
      conn.exec(`DELETE FROM series WHERE pinned=0 AND key NOT IN (SELECT key FROM series WHERE pinned=0 ORDER BY stamp DESC LIMIT ${maxUnpinnedSeries}); COMMIT`);
      begun=false;
      return {initialized:true,items};
    }catch{
      if(begun){try{conn.exec('ROLLBACK');}catch{}}
      return getWatchlist();
    }
  }

  function listSeriesStatus({pinnedOnly=false}={}){
    const conn=connection();
    if(!conn)return [];
    try{
      const rows=conn.prepare(`
        SELECT s.key, s.market, s.symbol, s.interval, s.source, s.adjustment, s.contract, s.pinned,
               s.bar_count, s.first_time, s.last_time, s.last_sync_at, s.last_error, s.backfill_done,
               (SELECT COUNT(*) FROM segments g WHERE g.series_key=s.key) AS segment_count
        FROM series s
        ${pinnedOnly?'WHERE s.pinned=1':''}
        ORDER BY s.pinned DESC, s.market ASC, s.symbol ASC, s.interval ASC
      `).all();
      return rows.map(r=>({
        key:r.key,
        market:r.market,
        symbol:r.symbol,
        interval:r.interval,
        source:r.source,
        adjustment:r.adjustment,
        ...(r.contract?{contract:r.contract}:{}),
        pinned:Boolean(r.pinned),
        barCount:r.bar_count,
        firstTime:r.first_time,
        lastTime:r.last_time,
        lastSyncAt:r.last_sync_at,
        lastError:r.last_error,
        backfillDone:Boolean(r.backfill_done),
        segmentCount:r.segment_count,
      }));
    }catch{return [];}
  }

  function getSeriesInfo(market,symbol,interval){
    return get(selection(market,symbol,interval),true);
  }

  function recordSyncState(key,{lastSyncAt,lastError,backfillDone}={}){
    const conn=connection();
    if(!conn)return;
    try{
      const sets=[],args=[];
      if(lastSyncAt!==undefined){sets.push('last_sync_at=?');args.push(lastSyncAt);}
      if(lastError!==undefined){sets.push('last_error=?');args.push(lastError);}
      if(backfillDone!==undefined){sets.push('backfill_done=?');args.push(backfillDone?1:0);}
      if(!sets.length)return;
      args.push(key);
      conn.prepare(`UPDATE series SET ${sets.join(', ')} WHERE key=?`).run(...args);
    }catch{}
  }

  return {
    preview,
    candles:refresh,
    older,
    getWatchlist,
    setWatchlist,
    listSeriesStatus,
    getSeriesInfo,
    recordSyncState,
    close(){disabled=true;db?.close();db=undefined;},
  };
}
