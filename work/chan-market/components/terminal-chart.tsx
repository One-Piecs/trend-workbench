"use client";

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Minus, Plus, ScanLine } from 'lucide-react';
import type { Analysis, Candle, Interval, Market } from '@/lib/market-types';
import {breakoutVwap,type VwapResult} from '@/lib/breakout-vwap';
import { useLanguage } from '@/lib/language';
import { isDirectionUnclear } from '@/lib/plan-presentation';
import type { MarketForecast } from '@/lib/forecast-types';
import { forecastCondition, forecastTargetLabel, forecastTitle } from './forecast-copy';
import ForecastTitleText from './forecast-title-text';
import { centerGeometry } from '@/lib/center-geometry';
import { placePriceTags } from '@/lib/chart-level-layout';
import { chartWindow, endAtTime } from '@/lib/chart-viewport';
import { buildStrokeCenters, type StrokeCenter } from '@/lib/center-layers';
import { analyze } from '@/lib/chan';
import { translateAnalysis } from '@/lib/analysis-i18n';
import type {CenterLayerMode} from './center-layer-selector';

export interface Layers { strokes: boolean; segments: boolean; centers: boolean; signals: boolean; scenarios: boolean; fractals: boolean; setups: boolean; anchoredVwap?:boolean }
export interface ChartHistoryPaging {
  status:'ready'|'loading'|'end'|'unsupported'|'error';
  onLoad:()=>void;
}
interface Props { candles: Candle[]; liveBar?:Candle; snapshotCandles?:Candle[]; analysis: Analysis | null; layers: Layers; symbol: string; interval: Interval; market?:Market; source?:string; loading?: boolean; forecast?:MarketForecast; dataFresh?:boolean; strokeCenters?:StrokeCenter[]; centerLayer?:CenterLayerMode; historyPaging?:ChartHistoryPaging; analysisStart?:number; penMode?:'new'|'old' }
export function priceText(n: number) { const decimals=n===0?2:Math.min(12,Math.max(2,4-Math.floor(Math.log10(Math.abs(n)))));return Number.isFinite(n) ? n.toLocaleString('en-US', {minimumFractionDigits: Math.min(decimals,n<1?4:2),maximumFractionDigits:decimals}) : '—'; }
function priceTicks(low:number,high:number,height:number) {
  const rough=(high-low)/Math.max(3,Math.round(height/58));
  const power=10**Math.floor(Math.log10(rough));
  const step=([1,2,2.5,5,10].find(factor=>factor*power>=rough)??10)*power;
  const first=Math.ceil(low/step), last=Math.floor(high/step);
  return Array.from({length:Math.max(0,last-first+1)},(_,i)=>(first+i)*step);
}
function stamp(t: number, full = false, interval = '1h', locale='zh-CN') {
  const date=new Date(t*1000);
  if(interval==='1M')return date.toLocaleDateString(locale,{year:'numeric',month:'2-digit'});
  if(full)return date.toLocaleString(locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  if(['1m','5m','15m','30m','1h','4h'].includes(interval))return date.toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  return date.toLocaleDateString(locale,interval==='1w'?{year:'2-digit',month:'2-digit',day:'2-digit'}:{month:'2-digit',day:'2-digit'});
}

function useBreakoutVwap(enabled:boolean,candles:Candle[],end:number,market:Market,interval:Interval,source:string) {
  const request=useMemo(()=>enabled?{candles,end,market,interval,source}:null,[enabled,candles,end,market,interval,source]);
  const [completed,setCompleted]=useState<{request:NonNullable<typeof request>;result:VwapResult}|null>(null);
  useEffect(()=>{
    if(!request)return;
    const work=request;
    const scan=breakoutVwap(work.candles,work.market,work.interval,work.source,work.end);
    let timer=0;
    function run(){
      const deadline=performance.now()+8;
      do {
        const step=scan.next();
        if(step.done){setCompleted({request:work,result:step.value});return;}
      } while(performance.now()<deadline);
      timer=window.setTimeout(run,0);
    }
    timer=window.setTimeout(run,0);
    return ()=>window.clearTimeout(timer);
  },[request]);
  return completed&&completed.request===request?completed.result:null;
}

export default function TerminalChart({candles:loaded, liveBar, snapshotCandles=loaded, analysis:currentAnalysis, layers, symbol, interval, market='crypto',source='',loading,forecast,dataFresh=true,strokeCenters:currentCenters=[],centerLayer='all',analysisStart=0,historyPaging,penMode='new'}: Props) {
  const {t,locale,language}=useLanguage();
  const centerClipId=useId(),priceClipId=useId();
  const [planSelection,setPlanSelection]=useState<{context:string;side:'long'|'short'}|null>(null);
  const planContext=`${market}:${symbol}:${interval}:${source}`;
  const planSide=planSelection?.context===planContext?planSelection.side:null;
  const [zoom,setZoom]=useState(1);
  const [anchor,setAnchor] = useState<{context:string;time:number}|null>(null);
  const [hoverState, setHover] = useState<{index: number; y: number; context: string} | null>(null);
  const drag = useRef<{x:number;endTime:number;step:number}|null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [size,setSize]=useState({width:1000,height:490});
  useEffect(()=>{
    const viewport=scrollRef.current;
    if(!viewport)return;
    const observer=new ResizeObserver(()=>{
      const bounds=viewport.getBoundingClientRect();
      // The toolbar can wrap with language, window size or an expanded layer menu.
      // Fit the focused chart below its actual toolbar even when the page was scrolled.
      const top=Math.round(bounds.top+window.scrollY)+'px';
      if(viewport.style.getPropertyValue('--chart-top')!==top)viewport.style.setProperty('--chart-top',top);
      const width=Math.round(bounds.width),height=Math.round(bounds.height);
      if(width>0&&height>0)setSize(previous=>previous.width===width&&previous.height===height?previous:{width,height});
    });
    observer.observe(viewport);
    const panel=viewport.closest('.chart-panel');
    if(panel)observer.observe(panel);
    return ()=>observer.disconnect();
  },[]);
  const W=size.width,H=size.height,LEFT=10,RIGHT=W<480?62:W<550?80:100,TOP=14;
  const usable=Math.max(1,W-LEFT-RIGHT);
  const VOL=H-129,PH=VOL-58-TOP,MACD_TOP=VOL+4,MID=MACD_TOP+63,MP=38;
  // At overview scale several candles can share a pixel. Older pages remain
  // accessible by panning at any scale, independently of display resolution.
  const zoomBy=(factor:number)=>setZoom(value=>Math.max(.035,Math.min(4,value*factor)));
  useEffect(()=>{
    const svg=svgRef.current;
    if(!svg)return;
    // Chromium delivers a trackpad pinch as a Ctrl+wheel gesture. Consume it
    // here so chart zoom cannot also magnify and pan the whole desktop page.
    const zoomChart=(event:WheelEvent)=>{
      if(!event.cancelable||event.deltaY===0||(!event.ctrlKey&&Math.abs(event.deltaX)>Math.abs(event.deltaY)))return;
      event.preventDefault();
      zoomBy(event.deltaY>0?1/1.2:1.2);
    };
    svg.addEventListener('wheel',zoomChart,{passive:false});
    return ()=>svg.removeEventListener('wheel',zoomChart);
  },[]);
  const unclear=forecast?forecast.direction==='neutral'||forecast.status!=='ready'||!dataFresh:isDirectionUnclear(currentAnalysis?.decision);
  const availablePlans=!forecast&&layers.setups&&!unclear?currentAnalysis?.tradePlans??[]:[];
  const selectedPlan=availablePlans.find(p=>p.side===planSide)||availablePlans.find(p=>p.priority==='primary')||availablePlans[0];
  const selectedForecast=forecast&&!unclear?forecast[planSide??(forecast.direction==='neutral'?'long':forecast.direction)]:null;
  const hasPlan=layers.setups&&(selectedForecast?.status==='ready'||!!selectedPlan);
  const laneWidth=hasPlan?Math.min(208,Math.round(usable*(W<640?.44:.30))):0;
  const count=Math.max(14,Math.round((usable-laneWidth)/(10*zoom))-4);
  const lastSnapshot=loaded.at(-1);
  const tick=lastSnapshot&&liveBar&&liveBar.time>=lastSnapshot.time?liveBar:undefined;
  const appended=tick&&tick.time!==lastSnapshot?.time?tick:undefined;
  const total=loaded.length+Number(!!appended);
  const barAt=(index:number)=>index===loaded.length?appended:loaded[index];
  const viewport=chartWindow(loaded,count,anchor?.context===planContext?anchor.time:null,appended);
  const back=viewport.back;
  const manualHistoryEdge=useRef<number|null>(null);
  useEffect(()=>{
    // Zooming out is also a request for history. Keep fetching one page at a
    // time until the requested view is filled or the provider reaches its end.
    if(zoom<1&&total>0&&count>viewport.end-viewport.start&&historyPaging?.status==='ready'){
      historyPaging.onLoad();
    }
  },[zoom,total,count,viewport.start,viewport.end,historyPaging]);
  useEffect(()=>{
    const edge=manualHistoryEdge.current;
    if(edge===null)return;
    if(loaded.length&&loaded[0].time<edge){
      const index=endAtTime(loaded,edge)-1;
      if(index>0)setAnchor({context:planContext,time:loaded[Math.max(index-1,Math.min(count,loaded.length)-1)].time});
      manualHistoryEdge.current=null;
    }else if(historyPaging&&['end','error','unsupported'].includes(historyPaging.status)){
      manualHistoryEdge.current=null;
    }
  },[loaded,count,historyPaging,planContext]);
  const browsingArchive=viewport.start<analysisStart;
  // Keep structure and chart coordinates in the same window. For a view
  // reaching into an older page, warm up indicators before the visible area.
  const offset=browsingArchive?Math.max(0,viewport.start-300):analysisStart;
  const sliceEnd=browsingArchive?viewport.end:undefined;
  const delivered=useMemo(()=>offset||sliceEnd!==undefined?loaded.slice(offset,sliceEnd):loaded,[loaded,offset,sliceEnd]);
  // Quotes change the newest display bar only. Keep archived slices and the
  // closed-bar snapshot used for structure stable throughout live updates.
  const visibleTick=back===0?tick:undefined;
  const candles=useMemo(()=>{
    if(!visibleTick)return delivered;
    if(visibleTick.time===delivered.at(-1)?.time)return delivered.with(-1,visibleTick);
    return [...delivered,visibleTick];
  },[delivered,visibleTick]);
  const snapshots=useMemo(()=>offset||sliceEnd!==undefined?snapshotCandles.slice(offset,sliceEnd):snapshotCandles,[snapshotCandles,offset,sliceEnd]);
  const pastAnalysis=useMemo(()=>browsingArchive?analyze(snapshots,{penMode,skipCalibration:true,skipTradePlans:true,context:{market,interval,symbol,source}}):null,
    [browsingArchive,snapshots,penMode,market,interval,symbol,source]);
  const analysis=useMemo(()=>pastAnalysis?translateAnalysis(pastAnalysis,language):currentAnalysis,[pastAnalysis,language,currentAnalysis]);
  const strokeCenters=useMemo(()=>pastAnalysis?buildStrokeCenters(pastAnalysis.strokes):currentCenters,[pastAnalysis,currentCenters]);
  const start=viewport.start-offset,end=viewport.end-offset;
  const visible = candles.slice(start,end);
  const vwap=useBreakoutVwap(!!layers.anchoredVwap,snapshots,Math.min(snapshots.length,end),market,interval,source);
  const visibleVwap=vwap?.status==='ready'?vwap.points.filter(p=>p.index>=start&&p.index<end):[];
  const showScenarios=!forecast&&layers.scenarios&&back===0&&!unclear;
  const plan=back===0?selectedPlan:undefined;
  const forecastSide=layers.setups&&back===0&&selectedForecast?.status==='ready'?selectedForecast:null;
  const neutralForecast=forecast&&dataFresh&&forecast.status==='ready'&&forecast.direction==='neutral'&&layers.setups&&back===0?forecast:null;
  const future = showScenarios ? 18 : Math.min(6,Math.floor(count/8));
  const calloutLane=back===0?laneWidth:0;
  const plotEnd=W-RIGHT-calloutLane;
  const hoverContext=`${planContext}:${visible[0]?.time}:${visible.at(-1)?.time}:${start}:${end}:${W}:${H}:${future}:${plotEnd}`;
  const hover=hoverState?.context===hoverContext&&hoverState.index>=start&&hoverState.index<end?hoverState:null;
  const step = (plotEnd-LEFT) / Math.max(visible.length+future,Math.min(20,count+future));
  const x = (index:number) => LEFT+(index-start+.5)*step;
  const scenarioPrices = showScenarios ? analysis?.scenarios.flatMap(s=>s.points.map(p=>p.price))||[] : [];
  const vwapPrices=visibleVwap.map(p=>p.value);
  const planPrices=forecastSide?[forecastSide.zoneLow,forecastSide.zoneHigh,forecastSide.triggerPrice,forecastSide.invalidationPrice,...forecastSide.targets.map(item=>item.price)]
    :plan?[plan.entryLow,plan.entryHigh,plan.triggerPrice,plan.stopLoss,plan.target1,plan.target2]:[];
  let lo = Math.min(...visible.map(c=>c.low),...scenarioPrices,...vwapPrices,...planPrices), hi=Math.max(...visible.map(c=>c.high),...scenarioPrices,...vwapPrices,...planPrices);
  if (!Number.isFinite(lo)||!Number.isFinite(hi)){lo=0;hi=100;}
  const pad=Math.max((hi-lo)*.075,Math.max(Math.abs(hi),Math.abs(lo))*.0001,1e-12);
  lo=market==='commodity'?lo-pad:Math.max(0,lo-pad);
  hi+=pad;
  const y = (v:number) => TOP+(hi-v)/(hi-lo)*PH;
  const centerItems=[
    ...(centerLayer==='segment'?[]:strokeCenters.map(center=>({center,number:center.sequence,layer:'stroke' as const}))),
    ...(centerLayer==='stroke'?[]:(analysis?.centers??[]).map((center,index)=>({center,number:index+1,layer:'segment' as const}))),
  ];
  const visibleCenters=layers.centers?centerItems.flatMap(item=>{
    const {center}=item;
    const geometry=centerGeometry(center,{start,end,left:LEFT,right:plotEnd,top:TOP,bottom:TOP+PH,step,minPrice:lo,maxPrice:hi});
    return geometry?[{...item,geometry}]:[];
  }):[];
  const centerDrawings=visibleCenters.map(item=>{
    const {center:c,number,layer}=item,code=`${layer==='stroke'?t('笔','B'):t('段','S')}${number}`;
    const name=layer==='stroke'?t('笔中枢（局部）','Stroke centers (local)'):t('线段中枢','Segment center');
    const upper=`${code} · ${t('上沿 ZG','Upper ZG')} ${priceText(c.high)}`,lower=`${t('下沿 ZD','Lower ZD')} ${priceText(c.low)}`;
    const from=candles[c.startIndex],to=candles[c.endIndex];
    const period=`${t('起止','Period')} ${from?stamp(from.time,true,interval,locale):'—'} — ${to?stamp(to.time,true,interval,locale):'—'}`;
    const description=`${name} ${code} · ${t('上沿 ZG','Upper ZG')} ${priceText(c.high)} / ${lower} · ${period}${layer==='stroke'?t(' · 局部已确认笔重叠',' · Local overlap of confirmed strokes'):''}`;
    const textWidth=(value:string)=>Array.from(value).reduce((width,char)=>width+(char.charCodeAt(0)>255?12:7),0);
    return {...item,key:`${layer}-${number}`,code,upper,lower,description,labelWidth:Math.max(textWidth(upper),textWidth(lower)),compactWidth:textWidth(code)};
  });
  const occupiedLabels:{x:number;y:number;width:number;height:number}[]=[],centerLabels=new Map<string,'full'|'compact'>();
  // Keep the larger segment labels readable; local labels use remaining space.
  for(const item of [...centerDrawings].sort((a,b)=>Number(a.layer==='stroke')-Number(b.layer==='stroke'))){
    const g=item.geometry,height=g.visibleBottom-g.visibleTop;
    const candidates=[
      ...(g.width>=item.labelWidth+10&&height>=35?[{mode:'full' as const,width:item.labelWidth,height:32}]:[]),
      ...(g.width>=Math.max(40,item.compactWidth+10)&&height>=18?[{mode:'compact' as const,width:item.compactWidth,height:18}]:[]),
    ];
    for(const candidate of candidates){
      const area={x:g.x+5,y:g.visibleTop,width:candidate.width,height:candidate.height};
      if(occupiedLabels.some(a=>area.x<a.x+a.width+6&&area.x+area.width+6>a.x&&area.y<a.y+a.height+4&&area.y+area.height+4>a.y))continue;
      occupiedLabels.push(area);centerLabels.set(item.key,candidate.mode);break;
    }
  }
  const maxVol = Math.max(...visible.map(c=>c.volume),1);
  const candleIndices=useMemo(()=>{
    const indices=new Map<number,number>();
    for(let i=start;i<end;i++)indices.set(candles[i].time,i);
    return indices;
  },[candles,start,end]);
  const macd = (analysis?.macd||[]).filter(m=>candleIndices.has(m.time));
  const maxMacd = Math.max(...macd.flatMap(m=>[Math.abs(m.hist),Math.abs(m.dif),Math.abs(m.dea)]),.00001);
  const my = (v:number)=>MID-v/maxMacd*MP;
  const selected = hover ? candles[hover.index] : visible.at(-1);
  const selectedIndex=hover?.index??end-1;
  const last=candles.at(-1);
  const hoverPrice=hover&&selected&&hover.y>=TOP&&hover.y<=TOP+PH
    ?hi-(hover.y-TOP)/PH*(hi-lo):null;
  const hoverPriceLabel=hoverPrice===null?'':priceText(hoverPrice);
  const hoverPriceFontSize=Math.min(13,(RIGHT-16)/Math.max(1,hoverPriceLabel.length*.62));
  const selectedMacd=analysis?.macd.find(m=>m.time===candles[selectedIndex]?.time);
  const conditionIndex=candles.findLastIndex(c=>c.closed!==false);
  const zoneStartX=Math.max(LEFT,x(end-Math.min(20,visible.length)));
  const levels=forecastSide?[
    {id:'entry',label:t('入场区间','Entry zone'),price:forecastSide.triggerPrice,text:`${priceText(forecastSide.zoneLow)} – ${priceText(forecastSide.zoneHigh)}`,color:forecastSide.side==='long'?'var(--chart-long)':'var(--chart-short)'},
    {id:'stop',label:t('止损价','Stop loss'),price:forecastSide.invalidationPrice,text:priceText(forecastSide.invalidationPrice),color:'var(--chart-stop)'},
    ...forecastSide.targets.map((target,i)=>({id:`t${i+1}`,label:forecastTargetLabel(i,target.estimated,language),price:target.price,text:priceText(target.price),color:'var(--chart-target)'})),
  ]:neutralForecast?[
    ...(neutralForecast.support?[{id:'support',label:neutralForecast.support.estimated?t('参考支撑（估算）','Support (estimated)'):t('参考支撑','Reference support'),price:neutralForecast.support.price,text:priceText(neutralForecast.support.price),color:'var(--chart-support)'}]:[]),
    ...(neutralForecast.resistance?[{id:'resistance',label:neutralForecast.resistance.estimated?t('参考阻力（估算）','Resistance (estimated)'):t('参考阻力','Reference resistance'),price:neutralForecast.resistance.price,text:priceText(neutralForecast.resistance.price),color:'var(--chart-segment)'}]:[]),
  ]:plan?[
    {id:'entry',label:t('入场区间','Entry zone'),price:plan.triggerPrice,text:`${priceText(plan.entryLow)} – ${priceText(plan.entryHigh)}`,color:plan.side==='long'?'var(--chart-long)':'var(--chart-short)'},
    {id:'stop',label:t('止损价','Stop loss'),price:plan.stopLoss,text:priceText(plan.stopLoss),color:'var(--chart-stop)'},
    {id:'t1',label:t('第一止盈','Take profit 1'),price:plan.target1,text:priceText(plan.target1),color:'var(--chart-target)'},
    {id:'t2',label:t('第二止盈','Take profit 2'),price:plan.target2,text:priceText(plan.target2),color:'var(--chart-target)'},
  ]:[];
  const tagX=plotEnd+12,tagWidth=Math.max(1,calloutLane-16);
  const tagPadding=W<640?5:8,tagTextWidth=tagWidth-2*tagPadding;
  const tagFont=W<640?12:13,rowHeight=PH<190?13:16;
  const priceTags=calloutLane?placePriceTags(levels.map(level=>{
    const rows=level.id==='entry'&&level.text.length*tagFont*.61>tagTextWidth
      ?level.text.split(' – ').map((value,i)=>value+(i===0?' –':'')):[level.text];
    return {...level,rows,anchorY:y(level.price),height:(1+rows.length)*rowHeight+4};
  }),TOP+1,TOP+PH-1):[];
  const candleWidth=Math.max(1,Math.min(26,step*.73));
  const upColor='var(--chart-long)',downColor='var(--chart-short)';
  const tickCount=Math.max(1,Math.min(visible.length,Math.floor((plotEnd-LEFT)/(interval.endsWith('m')||interval.endsWith('h')?114:90))));
  const historyStatus=historyPaging?.status;
  function loadOlder(manual=false) {
    const retry=manual&&historyStatus==='error';
    if(!historyPaging||!loaded.length||!(historyStatus==='ready'||retry))return;
    if(manual)manualHistoryEdge.current=loaded[0].time;
    historyPaging.onLoad();
  }
  function panTo(rawEnd:number,older:boolean) {
    if(!loaded.length)return;
    const bounded=Math.min(total, Math.max(count,rawEnd));
    const keepHistory=bounded<total||older&&rawEnd<=count;
    setAnchor(keepHistory?{context:planContext,time:barAt(bounded-1)!.time}:null);
    // Prefetch only during a deliberate move towards older bars. A short IPO
    // history or a page with no further data must not issue queries on mount.
    if(older&&rawEnd-count<=Math.min(24,Math.ceil(count/8)))loadOlder();
  }
  function position(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx=(e.clientX-rect.left)/rect.width*W;
    if(drag.current) {
      const delta=Math.round((e.clientX-drag.current.x)/drag.current.step);
      if(delta!==0)panTo(endAtTime(loaded,drag.current.endTime,appended)-delta,delta>0);
    }
    const index=Math.round((sx-LEFT)/step-.5)+start;
    setHover(index>=start&&index<end?{index,y:(e.clientY-rect.top)/rect.height*H,context:hoverContext}:null);
  }
  const colors = {long:'var(--chart-long)',short:'var(--chart-short)',range:'var(--chart-segment)'};
  return <div className="chart-shell trading-chart">
    <div className="trading-readout">
      <div className="trading-ohlc">
        {selected?<><time>{stamp(selected.time,true,interval,locale)}</time>
          {([[t('开','O'),selected.open],[t('高','H'),selected.high],[t('低','L'),selected.low],[t('收','C'),selected.close]] as const).map(([label,value])=>
            <span key={label}>{label}<b style={{color:selected.close>=selected.open?upColor:downColor}}>{priceText(value)}</b></span>)}
        </>:<span>{t('等待行情数据','Waiting for market data')}</span>}
      </div>
      <div className="trading-zoom">
        {layers.setups&&!unclear&&(analysis||forecast)&&<div className="plan-direction-toggle" role="group" aria-label={t('查看预判方向','View forecast direction')}>
          {(['long','short'] as const).map(side=>{
            const active=(selectedForecast?.side??selectedPlan?.side)===side;
            return <button type="button" key={side} title={side==='long'?t('查看做多方案','View long setup'):t('查看做空方案','View short setup')}
              className={active?`active ${side}`:''} aria-pressed={active} onClick={()=>{setPlanSelection({context:planContext,side});setAnchor(null);}}
              disabled={forecast?forecast[side].status!=='ready':!availablePlans.some(p=>p.side===side)}>{side==='long'?t('做多','Long'):t('做空','Short')}</button>;
          })}
        </div>}
        <button type="button" aria-label={t('缩小图表','Zoom out')} title={t('缩小图表','Zoom out')} onClick={()=>zoomBy(1/1.25)}><Minus size={15}/></button>
        <button type="button" aria-label={t('放大图表','Zoom in')} title={t('放大图表','Zoom in')} onClick={()=>zoomBy(1.25)}><Plus size={15}/></button>
        <button type="button" title={t('回到最新','Latest')} aria-label={t('图表回到最新','Return chart to latest')} onClick={()=>{setAnchor(null);setZoom(1);}}><ScanLine size={15}/></button>
      </div>
    </div>
    <div className="chart-scroll" ref={scrollRef} tabIndex={0} role="region" aria-label={t('K线图，拖动查看历史，滚轮缩放','Candlestick chart; drag to pan and scroll to zoom')}>
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" role="img" aria-label={`${symbol} ${interval} ${t('K线、缠论结构、后续点位预判及MACD图，拖动查看历史，滚轮缩放','candlesticks, Chan structures, forward reference levels and MACD; drag to pan, scroll to zoom')}`} className="terminal-chart" onPointerMove={position} onPointerLeave={()=>{setHover(null);drag.current=null;}} onPointerDown={e=>{const bar=barAt(viewport.end-1);if(!bar)return;drag.current={x:e.clientX,endTime:bar.time,step:step*e.currentTarget.getBoundingClientRect().width/W};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{setHover(null);drag.current=null;}}>
      <defs><clipPath id={priceClipId}><rect x={LEFT} y={TOP} width={plotEnd-LEFT} height={PH}/></clipPath><clipPath id={centerClipId}><rect data-testid="chart-center-clip" x={LEFT} y={TOP} width={plotEnd-LEFT} height={PH}/></clipPath></defs>
      <rect width={W} height={H} fill="var(--chart-paper)"/>
      {priceTicks(lo,hi,PH).map(value=>{
        const py=y(value),label=Number.isInteger(value)?value.toLocaleString('en-US'):priceText(value);
        return <g key={value}><line x1={LEFT} x2={W-RIGHT} y1={py} y2={py} stroke="var(--chart-grid)" strokeWidth=".8"/>
          <text x={W-RIGHT+7} y={py+4} fill="var(--chart-muted)" fontSize={Math.min(13,(RIGHT-10)/(.63*label.length))} fontFamily="monospace">{label}</text></g>;
      })}
      {Array.from({length:tickCount},(_,i)=>{const index=start+Math.floor(visible.length*i/tickCount);return <g key={i}><line x1={x(index)} x2={x(index)} y1={TOP} y2={H-28} stroke="var(--chart-grid)" strokeWidth=".7"/><text x={Math.max(48,x(index))} y={H-9} fill="var(--chart-muted)" fontSize="12" textAnchor="middle">{candles[index]?stamp(candles[index].time,false,interval,locale):''}</text></g>;})}
      {showScenarios&&conditionIndex>=0&&<g><line x1={x(conditionIndex+.5)} x2={x(conditionIndex+.5)} y1={TOP} y2={PH+TOP} stroke="var(--chart-cross-line)" strokeDasharray="4 5"/><text x={x(conditionIndex+2)} y={TOP+16} fill="var(--chart-muted)" fontSize="12">{t('推演路径','Projected path')}</text></g>}
      <g clipPath={`url(#${centerClipId})`} data-testid="chart-centers">
        {centerDrawings.map(({center:c,geometry:g,number,layer,key,code,upper,lower,description})=>{
          const color=layer==='stroke'?'var(--chart-pen)':'var(--chart-segment)';
          return <g key={key} data-testid="chart-center" data-start-index={c.startIndex} data-end-index={c.endIndex} data-center-number={number} data-center-layer={layer} role="group" aria-label={description}>
            <title>{description}</title>
            <rect data-testid="chart-center-box" x={g.x} y={g.y} width={g.width} height={g.height} fill={layer==='stroke'?'var(--chart-pen)':'var(--chart-segment)'} fillOpacity={layer==='stroke'?'.07':'.09'} stroke={layer==='stroke'?'var(--chart-pen)':'var(--chart-segment)'} strokeOpacity={layer==='stroke'?'.9':'.65'} strokeWidth={layer==='stroke'?'1.2':'.8'} strokeDasharray={c.status==='broken'?'3 3':undefined}/>
            {centerLabels.get(key)==='full'&&<text data-testid="chart-center-label" x={g.x+5} y={g.visibleTop+14} fill={color} fontSize="12" stroke="var(--chart-paper)" strokeWidth="3" paintOrder="stroke"><tspan>{upper}</tspan><tspan x={g.x+5} dy="15">{lower}</tspan></text>}
            {centerLabels.get(key)==='compact'&&<text data-testid="chart-center-compact-label" x={g.x+5} y={g.visibleTop+13} fill={color} fontSize="12" fontWeight="600" stroke="var(--chart-paper)" strokeWidth="3" paintOrder="stroke">{code}</text>}
          </g>;
        })}
      </g>
      <g clipPath={`url(#${priceClipId})`}>
      {visible.map((c,i)=>{
        const cx=Math.round(x(i+start))+.5,color=c.close>=c.open?upColor:downColor;
        return <g key={c.time} className="trading-candle" data-time={c.time} data-forming={c.closed===false||undefined}>
          <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1"/>
          <rect x={cx-candleWidth/2} y={y(Math.max(c.open,c.close))} width={candleWidth} height={Math.max(1.25,Math.abs(y(c.open)-y(c.close)))} fill={color}/>
        </g>;
      })}
      {layers.strokes&&analysis?.strokes.filter(s=>s.to.index>=start&&s.from.index<end).map((s,i)=><line key={i} x1={x(s.from.index)} x2={x(s.to.index)} y1={y(s.from.price)} y2={y(s.to.price)} stroke="var(--chart-pen)" strokeWidth="1.1" opacity=".72" strokeDasharray={s.confirmed?undefined:'4 4'}/>)}
      {layers.segments&&analysis?.segments.filter(s=>s.to.index>=start&&s.from.index<end).map((s,i)=><line key={i} x1={x(s.from.index)} x2={x(s.to.index)} y1={y(s.from.price)} y2={y(s.to.price)} stroke="var(--chart-segment)" strokeWidth="1.55" opacity=".86" strokeDasharray={s.confirmed?undefined:'5 4'}/>)}
      {visibleVwap.length>0&&<g data-testid="breakout-vwap-line" aria-label={t('中枢突破后的成交量加权均价','Volume-weighted average since the center breakout')} stroke="var(--chart-vwap)" fill="none">
        <polyline points={visibleVwap.map(p=>`${x(p.index)},${y(p.value)}`).join(' ')} strokeWidth="2" strokeLinejoin="round"/>
        <circle cx={x(visibleVwap[visibleVwap.length-1].index)} cy={y(visibleVwap[visibleVwap.length-1].value)} r="2.5" fill="var(--chart-vwap)"/>
      </g>}
      {layers.fractals&&analysis?.fractals.filter(f=>f.index>=start&&f.index<end).map((f,i)=><circle key={i} cx={x(f.index)} cy={y(f.price)} r="2.4" fill={f.type==='bottom'?'var(--chart-long)':'var(--chart-short)'}/>)}
      {layers.signals&&analysis?.signals.filter(s=>s.index>=start&&s.index<end).map((s,i)=>{const yy=y(s.price)+(s.side==='long'?22:-22), labelWidth=Math.max(52,s.label.length*(locale==='zh-CN'?12:6.7)+12);return <g key={i}><line x1={x(s.index)} x2={x(s.index)} y1={y(s.price)} y2={yy} stroke={colors[s.side]} strokeWidth=".7"/><rect x={x(s.index)-labelWidth/2} y={yy-10} width={labelWidth} height="22" rx="3" fill={s.side==='long'?'var(--chart-up-tint)':'var(--chart-down-tint)'} stroke={colors[s.side]} strokeWidth=".5"/><text x={x(s.index)} y={yy+5} textAnchor="middle" fill={colors[s.side]} fontSize="12">{s.label}</text></g>;})}
      {showScenarios&&conditionIndex>=0&&analysis?.scenarios.map((s,i)=><polyline key={i} points={s.points.map(p=>`${x(conditionIndex+p.offset)},${y(p.price)}`).join(' ')} fill="none" stroke={colors[s.side]} strokeWidth="1.5" strokeDasharray="5 5" opacity=".78"/>)}
      {last&&back===0&&<line x1={LEFT} x2={W-RIGHT} y1={y(last.close)} y2={y(last.close)} stroke={last.close>=last.open?'var(--chart-long)':'var(--chart-short)'} strokeDasharray="2 5" opacity=".5"/>}
      </g>
      {levels.length>0&&<g clipPath={`url(#${priceClipId})`} data-testid="chart-level-lines">
        {(plan||forecastSide)&&<rect x={zoneStartX} y={y(forecastSide?.zoneHigh??plan!.entryHigh)}
          width={Math.max(1,plotEnd-zoneStartX)} height={Math.max(1,y(forecastSide?.zoneLow??plan!.entryLow)-y(forecastSide?.zoneHigh??plan!.entryHigh))}
          fill={colors[forecastSide?.side??plan!.side]} fillOpacity=".07"/>}
        {levels.map(level=><line key={level.id} x1={zoneStartX} x2={plotEnd} y1={y(level.price)} y2={y(level.price)}
          stroke={level.color} strokeWidth="1" strokeDasharray={level.id==='entry'?'5 4':'2 4'} opacity=".65">
          <title>{level.label} · {level.text}</title></line>)}
      </g>}
      {priceTags.length>0&&<g data-testid="chart-level-callouts" data-side={forecastSide?.side??plan?.side} pointerEvents="none">
        {priceTags.map(tag=>{
          const centerY=tag.boxY+tag.height/2;
          return <g key={tag.id} data-testid={`chart-level-callout-${tag.id}`} role="group" aria-label={`${tag.label} ${tag.text}`}>
            <path d={`M ${plotEnd} ${tag.anchorY} H ${plotEnd+3} L ${tagX-3} ${centerY} H ${tagX}`} fill="none" stroke={tag.color} strokeWidth="1"/>
            <circle cx={plotEnd} cy={tag.anchorY} r="2.5" fill={tag.color}/>
            <rect x={tagX} y={tag.boxY} width={tagWidth} height={tag.height} rx="4" stroke={tag.color} fill={`color-mix(in srgb, var(--chart-paper) 94%, ${tag.color})`}/>
            <text x={tagX+tagPadding} y={tag.boxY+rowHeight} fill={tag.color} fontSize={Math.min(tagFont,tagTextWidth/(Array.from(tag.label).reduce((n,c)=>n+(c.charCodeAt(0)>255?1:.58),0)))} fontWeight="600">{tag.label}</text>
            {tag.rows.map((row,i)=><text key={i} x={tagX+tagPadding} y={tag.boxY+rowHeight*(i+2)} fontSize={Math.min(tagFont,tagTextWidth/(row.length*.61))} fill="var(--chart-ink)" fontFamily="monospace">{row}</text>)}
          </g>;
        })}
      </g>}
      {last&&back===0&&(hoverPrice===null||!hover||Math.abs(y(last.close)-hover.y)>26)&&<g><rect x={W-RIGHT} y={y(last.close)-12} width={RIGHT} height="24" rx="2" fill={last.close>=last.open?'var(--chart-up-badge)':'var(--chart-down-badge)'}/><text x={W-RIGHT+6} y={y(last.close)+4} fill="var(--chart-inverse-ink)" fontSize={Math.min(13,(RIGHT-10)/Math.max(1,priceText(last.close).length*.63))} fontFamily="monospace">{priceText(last.close)}</text></g>}
      <line x1="0" x2={W} y1={TOP+PH+5} y2={TOP+PH+5} stroke="var(--chart-line)"/>
      <text x={LEFT+2} y={TOP+PH+20} fill="var(--chart-ink)" fontSize="12">{t('成交量','VOL')} {selected?.volume.toLocaleString(locale,{maximumFractionDigits:2})}</text>
      {visible.map((c,i)=><rect key={c.time} x={x(i+start)-candleWidth/2} y={VOL-c.volume/maxVol*31} width={candleWidth} height={c.volume/maxVol*31} fill={c.close>=c.open?upColor:downColor} fillOpacity=".65"/>)}
      <line x1="0" x2={W} y1={MACD_TOP} y2={MACD_TOP} stroke="var(--chart-line)"/>
      <text x={LEFT+2} y={MACD_TOP+18} fill="var(--chart-ink)" fontSize="12">MACD 12 / 26 / 9</text>
      {selectedMacd&&W>=355&&<text x="132" y={MACD_TOP+18} fill="var(--chart-macd-fast)" fontSize="12" fontFamily="monospace">DIF {selectedMacd.dif.toFixed(2)}　<tspan fill="var(--chart-macd-slow)">DEA {selectedMacd.dea.toFixed(2)}</tspan></text>}
      <line x1={LEFT} x2={W-RIGHT} y1={MID} y2={MID} stroke="var(--chart-line)" strokeDasharray="2 4"/>
      {macd.map(m=><rect key={m.time} x={x(candleIndices.get(m.time)!)-Math.max(1,step*.55)/2} y={Math.min(my(m.hist),MID)} width={Math.max(1,step*.55)} height={Math.max(.4,Math.abs(my(m.hist)-MID))} fill={m.hist>=0?'var(--chart-long)':'var(--chart-short)'} opacity=".65"/>)}
      <polyline points={macd.map(m=>`${x(candleIndices.get(m.time)!)},${my(m.dif)}`).join(' ')} stroke="var(--chart-macd-fast)" fill="none" strokeWidth="1"/><polyline points={macd.map(m=>`${x(candleIndices.get(m.time)!)},${my(m.dea)}`).join(' ')} stroke="var(--chart-macd-slow)" fill="none" strokeWidth="1"/>
      {hover&&selected&&<g pointerEvents="none">
        <line x1={x(hover.index)} x2={x(hover.index)} y1={TOP} y2={H-28} stroke="var(--chart-cross-line)" strokeWidth=".7" strokeDasharray="3 3"/>
        {hoverPrice!==null&&<>
          <line x1={LEFT} x2={plotEnd} y1={hover.y} y2={hover.y} stroke="var(--chart-cross-line)" strokeWidth=".8" strokeDasharray="3 3"/>
          <g data-testid="chart-crosshair-price" role="group" aria-label={`${t('十字线价格','Crosshair price')} ${hoverPriceLabel}`}>
            <path d={`M ${W-RIGHT} ${hover.y-13} H ${W-2} V ${hover.y+13} H ${W-RIGHT} L ${W-RIGHT-5} ${hover.y} Z`} fill="var(--chart-cross-bg)"/>
            <text x={W-RIGHT+8} y={hover.y+4.5} fill="var(--chart-inverse-ink)" fontSize={hoverPriceFontSize} fontWeight="600" fontFamily="monospace">{hoverPriceLabel}</text>
          </g>
        </>}
        <rect x={Math.max(0,Math.min(W-184,x(hover.index)-92))} y={H-29} width="184" height="26" fill="var(--chart-cross-bg)" rx="3"/>
        <text x={Math.max(92,Math.min(W-92,x(hover.index)))} y={H-12} fill="var(--chart-inverse-ink)" fontSize="12" textAnchor="middle">{stamp(selected.time,true,interval,locale)}</text>
      </g>}
      {!candles.length&&!loading&&<text x={W/2} y={TOP+PH/2} textAnchor="middle" fill="var(--chart-muted)" fontSize="14">{t('行情载入后，将在这里绘制真实走势','Real price history will appear when data loads')}</text>}
    </svg>
    </div>
    {layers.setups&&(analysis||forecast)&&<section className="trading-levels" aria-label={t('后续预判参考价位','Forward reference levels')} data-testid={levels.length?(forecast?`chart-forecast-${forecastSide?.side??'neutral'}`:`chart-plan-${plan!.side}`):undefined}>
      <div className="trading-levels-head">
        {forecast&&!unclear&&<b><ForecastTitleText forecast={forecast} language={language} dataFresh={dataFresh}/></b>}
        {unclear&&<span className="chart-neutral-note" data-testid="chart-no-direction">{forecast?forecastTitle(forecast,language,dataFresh):t('暂不提示新方向','No new direction')}</span>}
        {forecastSide&&forecastSide.side!==forecast?.direction&&<small>{t('反向备选','Alternative setup')}</small>}
        {neutralForecast?.referencePrice!=null&&<small>{t('基准价格','Reference')} {priceText(neutralForecast.referencePrice)}</small>}
        {forecast?.structureAsOf!=null&&<time>{t('结构时间','Structure time')} {stamp(forecast.structureAsOf,true,interval,locale)}</time>}
        {plan&&<span>{plan.status==='triggered'?t('跟踪中','Tracking'):plan.statusLabel}</span>}
      </div>
      {levels.length>0&&<dl className="trading-level-list">{levels.map(level=><div key={level.id} data-testid={`chart-level-${level.id}`} title={forecastSide&&level.id==='entry'?forecastCondition(forecastSide,language,priceText):undefined}>
        <dt><i style={{background:level.color}}/>{level.label}</dt><dd>{level.text}</dd>
      </div>)}</dl>}
    </section>}
    {layers.anchoredVwap&&<div className="chart-bottom" data-testid="breakout-vwap-info" aria-live="polite" title={t('从最近一次确认突破的K线开始，按每根已完成K线的成交量加权其高、低、收三价均值；下次确认突破时重新起算。','Starting with the latest confirmed breakout bar, average each closed bar’s typical price (high, low and close) weighted by volume. The next confirmed breakout resets the anchor.')}><span style={{color:'var(--chart-vwap)',flexWrap:'wrap'}}>{t('突破均价线','Breakout VWAP')} · {vwap?.status==='ready'?<>
      {priceText(vwap.points[vwap.points.length-1].value)} · {vwap.crossing.level==='segment'?t('线段中枢','Segment center'):t('笔中枢','Stroke center')} {vwap.crossing.direction==='up'?t('上破','break above'):t('下破','break below')} {priceText(vwap.crossing.boundary)} · {t('起点','Anchor')} {stamp(candles[vwap.anchor].time,true,interval,locale)}
    </>:!vwap?t('正在查找最近一次中枢突破','Finding the latest center breakout'):vwap.status==='no-volume'?t('成交量不足，无法计算','Insufficient trading volume'):vwap.status==='incomplete'?t('连续行情不足，无法核对均价','Insufficient continuous history'):t('这段历史未出现已确认突破','No confirmed breakout in this history')}</span></div>}
    {loading&&<div className="chart-loading"><span className="spinner"/><span>{t('正在连接行情源','Connecting to market data')}</span></div>}
    <div className="chart-bottom"><span style={{flexWrap:'wrap',whiteSpace:'normal'}}><i className="legend-dot blue"/>{t('笔','Strokes')} <i className="legend-dot gold"/>{t('线段','Segments')} {layers.centers&&<><i style={{width:9,height:9,border:'1px solid var(--chart-pen)',background:'var(--chart-pen-tint)',marginLeft:7}}/>{t('笔中枢（局部）','Stroke centers (local)')}<i style={{width:9,height:9,border:'1px solid var(--chart-segment)',background:'var(--chart-segment-tint)',marginLeft:7}}/>{t('线段中枢','Segment centers')}</>}{!unclear&&<><i className="legend-line"/>{forecast?t('预判参考位','Outlook reference levels'):t('推演路径','Projected path')}</>}</span><span>{back>0&&layers.setups&&!unclear?forecast?t('查看历史中 · 回到最新显示预判','Viewing history · return to latest for outlook'):t('查看历史中 · 回到最新显示交易计划','Viewing history · return to latest for trade plans'):t('本地时间','Local time')}</span></div>
    {total>0&&<div className="chart-history-nav">
      {historyPaging&&<button type="button" onClick={()=>loadOlder(true)} disabled={historyStatus!=='ready'&&historyStatus!=='error'}>
        {historyStatus==='loading'?t('正在加载…','Loading…'):historyStatus==='end'?t('已到行情源的历史起点','Start of available history'):
          historyStatus==='unsupported'?t('此来源仅提供当前历史','Available history only'):historyStatus==='error'?t('重试加载更早K线','Retry earlier candles'):t('加载更早K线','Load earlier candles')}
      </button>}
      <span>{t('屏内','Showing')} {visible.length} / {t('已加载','loaded')} {total}</span>
      {total>count&&<input className="history-slider" aria-label={t('历史图表位置','Historical chart position')} type="range" min="0" max={total-count} value={viewport.start} onChange={e=>{const next=Number(e.target.value);panTo(next+count,next<viewport.start);}}/>}
    </div>}
  </div>;
}
