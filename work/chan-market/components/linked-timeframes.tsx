"use client";
import {useEffect,useMemo,useState} from 'react';
import {ChevronDown, PanelsTopLeft} from 'lucide-react';
import {useLanguage} from '@/lib/language';
import {positiveRunStart} from '@/lib/commodity-analysis';
import {analyze} from '@/lib/chan';
import {linkedBars,barAtTime,fetchLinkedPeriod,fetchLinkedHistory,linkedHistoryCursor,linkedIdentity,linkedPeriods,type LinkedPeriod,type TimedBar} from '@/lib/linked-timeframes';
import {compatibleMarketFeeds,SAME_SOURCE_AGGREGATION} from '@/lib/higher-from-primary';
import {marketDisplayText} from '@/lib/market-i18n';
import {candleAvailableAt} from '@/lib/timeframe-context';
import type {HigherFeed} from '@/lib/market-context-loader';
import type {Candle,MarketData} from '@/lib/market-types';
import {priceText} from './terminal-chart';

type Focus = {time:number; period:LinkedPeriod; start:number};
type PaneProps = {primary:MarketData; higher?:HigherFeed; replaying:boolean; cutoff:number; focus:Focus|null; onFocus:(next:Focus|null)=>void};
const count=48;
const formatTime=(time:number,locale:string)=>new Date(time*1000).toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});

export default function LinkedTimeframes({data,higher,replayBar,replaying,asOf,imported}:{
  data:MarketData|null; higher?:HigherFeed; replayBar?:Candle; replaying:boolean; asOf:number; imported:boolean;
}) {
  const {t}=useLanguage();
  const [open,setOpen]=useState(false);
  if(imported)return null;
  const cutoff=replaying&&data?Math.min(asOf,replayBar?candleAvailableAt(replayBar,data.instrument.market,data.interval,data.source):0):asOf;
  return <section className="linked-timeframes">
    <button type="button" aria-expanded={open} onClick={()=>setOpen(!open)} className="linked-toggle">
      <PanelsTopLeft size={16} aria-hidden="true"/>{t('多周期联动','Linked timeframes')}
      <small>{t('1小时 / 4小时 / 日线','1h / 4h / 1D')}</small><ChevronDown size={15} aria-hidden="true"/>
    </button>
    {open&&(data?<LinkedGroup key={JSON.stringify(linkedIdentity(data))} primary={data} higher={higher} cutoff={cutoff} replaying={replaying}/>:
      <p className="linked-message">{t('等待标的行情','Waiting for market data')}</p>)}
  </section>;
}

function LinkedGroup(props:Omit<PaneProps,'focus'|'onFocus'>) {
  const {t,locale}=useLanguage();
  const [cursor,onFocus]=useState<Focus|null>(null);
  // Rewinding the replay invalidates a cursor that now lies in its future.
  const focus=cursor&&cursor.time<=props.cutoff?cursor:null;
  return <div className="linked-content">
    <div className="linked-time">
      <span>{focus?t('联动时刻','Linked time')+' '+formatTime(focus.time,locale):t('移动十字线，对照同一时刻各周期最近已完成的K线。','Move the crosshair to compare the last closed candle on each timeframe.')}</span>
      {focus&&<button type="button" onClick={()=>onFocus(null)}>{t('回到最新','Latest')}</button>}
    </div>
    <div className="linked-grid">{linkedPeriods.map(period=><PeriodPane key={period} {...props} period={period} focus={focus} onFocus={onFocus}/>)}</div>
    {props.primary.instrument.market==='cn'&&<small>{t('A股常规交易日为4小时，4小时与日线覆盖同一交易时段。','A regular A-share session lasts four hours. The 4h and daily views cover the same session.')}</small>}
  </div>;
}

function PeriodPane({period,primary,higher,cutoff,focus,onFocus,replaying}:PaneProps&{period:LinkedPeriod}) {
  const {t,language}=useLanguage();
  const at=focus&&focus.period!==period?Math.min(cutoff,focus.time):cutoff;
  const sharedReplayParent=replaying&&higher?.interval===period;
  const parent=higher?.interval===period&&higher.status==='ready'?higher.data:undefined;
  const derivedTooRecent=parent?.source.endsWith(SAME_SOURCE_AGGREGATION)&&parent.candles[0]&&candleAvailableAt(parent.candles[0],primary.instrument.market,period,parent.source)>at;
  const native=primary.interval===period?primary:derivedTooRecent&&!sharedReplayParent?undefined:parent;
  const waiting=higher?.interval===period&&(higher.status==='loading'||sharedReplayParent);
  const [remote,setRemote]=useState<MarketData|null>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
  const instrument=primary.instrument;
  useEffect(()=>{
    if(native||waiting)return;
    const ctrl=new AbortController();
    const signal=AbortSignal.any([ctrl.signal,AbortSignal.timeout(90000)]);
    fetchLinkedPeriod({instrument},period,signal).then(result=>{
      if(!ctrl.signal.aborted){setRemote(result);setFailed(false);}
    },async()=>{
      if(ctrl.signal.aborted)return;
      try {
        const saved=await fetchLinkedPeriod({instrument},period,AbortSignal.any([ctrl.signal,AbortSignal.timeout(4000)]),fetch,true);
        if(!ctrl.signal.aborted)setRemote(last=>last&&Date.parse(last.asOf)>=Date.parse(saved.asOf)?last:saved);
      } catch { /* There may be no saved series yet. */ }
      if(!ctrl.signal.aborted)setFailed(true);
    });
    return ()=>ctrl.abort();
  },[instrument,period,native,waiting,retry,primary.asOf]);
  const feed=native??(sharedReplayParent?null:remote);
  const recent=useMemo(()=>feed?linkedBars(feed,Infinity):[],[feed]);
  const lastIndex=barAtTime(recent,at);
  const first=feed?.candles[0]?.time??0;
  const outsideSharedWindow=focus&&focus.period!==period&&lastIndex<0;
  const before=feed&&(outsideSharedWindow||!sharedReplayParent&&primary.interval!==period)&&(replaying||focus)&&lastIndex<count-1&&!feed.source.endsWith(SAME_SOURCE_AGGREGATION)
    ?linkedHistoryCursor(period,first,at):0;
  const identity=feed?JSON.stringify(linkedIdentity(feed)):'';
  const pageKey=before?identity+'|'+before:'';
  const [archive,setArchive]=useState<{key:string;bars:Candle[];status:'ready'|'unsupported'|'error'}|null>(null);
  useEffect(()=>{
    if(!pageKey)return;
    const controller=new AbortController();
    fetchLinkedHistory(JSON.parse(identity),before,AbortSignal.any([controller.signal,AbortSignal.timeout(90000)])).then(page=>{
      if(!controller.signal.aborted)setArchive({key:pageKey,bars:page.bars,status:page.status==='unsupported'?'unsupported':'ready'});
    },()=>{if(!controller.signal.aborted)setArchive({key:pageKey,bars:[],status:'error'});});
    return ()=>controller.abort();
  },[identity,before,pageKey,retry]);
  const page=pageKey&&archive?.key===pageKey?archive:null;
  const older=useMemo(()=>feed&&page?linkedBars({...feed,candles:page.bars},Infinity):[],[feed,page]);
  const rows=useMemo(()=>{
    const history=older.slice(0,barAtTime(older,at)+1);
    return history.concat(recent.slice(0,lastIndex+1));
  },[recent,older,lastIndex,at]);
  const otherSource=feed&&feed!==primary&&!compatibleMarketFeeds(primary,feed);
  const label=period==='1h'?t('1小时','1 hour'):period==='4h'?t('4小时','4 hours'):t('日线','Daily');
  return <article className="linked-pane" aria-label={label} data-period={period}>
    <header><b>{label}</b>{otherSource&&<small title={marketDisplayText(feed.source+' · '+feed.adjustment,language)}>{t('独立行情口径','Separate price feed')}</small>}</header>
    {rows.length>0&&<MiniChart {...{rows,focus,onFocus,period,label}} market={instrument.market}/>}
    {sharedReplayParent&&!feed&&higher.status!=='loading'?<p className="linked-message">{t('此时点之前暂无可核对的大周期K线','No verified higher-timeframe candles by this time')}</p>:
      failed&&!native&&!sharedReplayParent?<p className="linked-message" role="status">{feed?t('更新失败，显示上次行情','Refresh failed; showing earlier data'):t('未取得本周期行情','Timeframe data unavailable')} <button type="button" onClick={()=>{setFailed(false);setRetry(n=>n+1);}}>{t('重试','Retry')}</button></p>:
      page?.status==='error'?<p className="linked-message" role="status">{t('此周期历史读取失败','Could not load history for this timeframe')} <button type="button" onClick={()=>{setArchive(null);setRetry(n=>n+1);}}>{t('重试','Retry')}</button></p>:
      !rows.length&&<p className="linked-message">{!feed||pageKey&&!page?t('正在读取行情','Loading candles'):page?.status==='unsupported'?t('此行情源未提供该时点的历史','This feed does not provide history for this time'):t('此时点之前暂无已完成K线','No closed bars by this time')}</p>}
  </article>;
}

function MiniChart({rows,focus,onFocus,period,label,market}:{rows:TimedBar[];focus:Focus|null;onFocus:PaneProps['onFocus'];period:LinkedPeriod;label:string;market:MarketData['instrument']['market']}) {
  const {t,locale}=useLanguage();
  const index=focus?barAtTime(rows,focus.time):rows.length-1;
  const latestStart=Math.max(0,rows.length-count);
  const start=focus?.period===period?Math.min(latestStart,focus.start):
    index>=0&&index<latestStart?Math.max(0,index-Math.floor(count/2)):latestStart;
  const visible=rows.slice(start,start+count);
  const selected=rows[index];
  // Recompute the pen from the selected prefix. Later bars can revise an endpoint.
  const pen=useMemo(()=>{
    if(index<2)return;
    const prefix=rows.slice(Math.max(0,index+1-800),index+1).map(r=>r.bar);
    return analyze(prefix.slice(positiveRunStart(prefix,market)),{skipCalibration:true,skipTradePlans:true}).strokes.findLast(s=>s.confirmed);
  },[rows,index,market]);
  const width=320,height=112;
  const high=Math.max(...visible.map(r=>r.bar.high)),low=Math.min(...visible.map(r=>r.bar.low));
  const span=high-low||Math.max(high*.001,1e-9);
  const y=(p:number)=>8+(high-p)*(height-16)/span;
  const step=width/visible.length;
  const select=(target:number)=>{
    const bounded=Math.max(0,Math.min(rows.length-1,target));
    const nextStart=bounded<start?bounded:bounded>=start+count?bounded-count+1:start;
    const time=rows[bounded].available;
    if(focus?.period!==period||focus.time!==time||focus.start!==nextStart)onFocus({time,period,start:nextStart});
  };
  const selectPointer=(event:React.PointerEvent<SVGSVGElement>)=>{
    const r=event.currentTarget.getBoundingClientRect();
    const slot=Math.floor((event.clientX-r.left)/r.width*visible.length);
    select(start+Math.max(0,Math.min(visible.length-1,slot)));
  };
  if(!selected)return <p className="linked-message">{t('该时刻早于本周期的可用历史','This time predates available history')}</p>;
  const labelAt=formatTime(selected.bar.time,locale);
  return <>
    <svg className="linked-plot" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" tabIndex={0}
      role="slider" aria-label={label+' '+t('联动十字线','linked crosshair')} aria-valuemin={0} aria-valuemax={rows.length-1} aria-valuenow={Math.max(0,index)} aria-valuetext={labelAt}
      onPointerMove={e=>{if(e.pointerType!=='touch')selectPointer(e);}}
      onPointerDown={selectPointer}
      onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();select(index+(e.key==='ArrowLeft'?-1:1));}else if(e.key==='Escape')onFocus(null);}}>
      {[.25,.5,.75].map(f=><line className="linked-grid-line" key={f} x1={0} x2={width} y1={height*f} y2={height*f}/>)}
      {visible.map(({bar},i)=>{const x=(i+.5)*step;return <g key={bar.time} className={bar.close>=bar.open?'linked-up':'linked-down'}>
        <line x1={x} x2={x} y1={y(bar.high)} y2={y(bar.low)} stroke="currentColor"/>
        <rect x={x-step*.31} width={step*.62} y={Math.min(y(bar.open),y(bar.close))} height={Math.max(1,Math.abs(y(bar.open)-y(bar.close)))} fill="currentColor"/>
      </g>;})}
      {focus&&<g className="linked-cross"><line x1={(index-start+.5)*step} x2={(index-start+.5)*step} y1={0} y2={height}/>
        <line x1={0} x2={width} y1={y(selected.bar.close)} y2={y(selected.bar.close)}/></g>}
    </svg>
    <div className="linked-quote">
      <strong>{t('收','C')} {priceText(selected.bar.close)}</strong><span>{labelAt}</span>
      <span>{pen?(pen.direction==='up'?t('最近确认笔 ↑','Last confirmed stroke ↑'):t('最近确认笔 ↓','Last confirmed stroke ↓')):t('暂无确认笔','No confirmed stroke')}</span>
      <small>{t('开','O')} {priceText(selected.bar.open)} · {t('高','H')} {priceText(selected.bar.high)} · {t('低','L')} {priceText(selected.bar.low)}</small>
    </div>
  </>;
}
