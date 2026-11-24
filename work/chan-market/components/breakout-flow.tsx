"use client";
import {useEffect,useMemo,useState} from 'react';
import {breakoutFlowQuery,breakoutLookback,recentCenterBreakout,type CenterBreakout} from '@/lib/breakout-observation';
import {useLanguage} from '@/lib/language';
import type {Candle,Interval} from '@/lib/market-types';
import type {SpotFlowResult} from '@/lib/spot-flow';

export default function BreakoutFlow({candles,interval,symbol,venue}:{
  candles:Candle[]; interval:Interval; symbol:string; venue:string;
}){
  const {t}=useLanguage();
  const event=useMemo(()=>recentCenterBreakout(candles,interval),[candles,interval]);
  if(!event)return <div><dt>{t('中枢突破成交','Center breakout flow')}</dt><dd>{t(`近 ${breakoutLookback} 根已完成 K 线无中枢突破`,`No center breakout in the last ${breakoutLookback} closed bars`)}</dd></div>;
  const query=breakoutFlowQuery(symbol,venue,event);
  return <FlowAtBreakout key={query} query={query} event={event}/>;
}

function FlowAtBreakout({query,event}:{query:string;event:CenterBreakout}){
  const {t,locale}=useLanguage();
  const [flow,setFlow]=useState<SpotFlowResult|null>(null),[retry,setRetry]=useState(0),[failed,setFailed]=useState(false);
  useEffect(()=>{
    const ctrl=new AbortController();
    async function load(){
      try{
        const response=await fetch('/api/spot-flow?'+query,{signal:ctrl.signal,cache:'no-store'});
        if(!response.ok)throw new Error('Feed unavailable');
        const data:SpotFlowResult=await response.json();
        if(!ctrl.signal.aborted)setFlow(data);
      }catch{if(!ctrl.signal.aborted)setFailed(true);}
    }
    void load();
    return ()=>ctrl.abort();
  },[query,retry]);

  const level=event.level==='segment'?t('线段中枢','segment center'):t('笔中枢','stroke center');
  const side=event.direction==='up'?t('突破上沿','broke above'):t('跌破下沿','broke below');
  const formatTime=(v:number)=>new Date(v*1000).toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  const precision=new Intl.NumberFormat(locale,{maximumSignificantDigits:7});
  const ready=flow?.status==='ready'?flow:null;
  const buy=ready?Math.round(ready.buyShare*1000)/10:0;
  const unavailable=flow?.status==='unavailable'?flow.reason:null;
  const transient=failed||unavailable==='upstream';
  return <div data-testid="breakout-flow">
    <dt>{t('中枢突破成交','Center breakout flow')}</dt>
    <dd>{locale.startsWith('zh')?`${level}${side}`:`${side} ${level}`} · {precision.format(event.boundary)}</dd>
    {ready?<><dd>{t('主动买','Taker buy')} {buy.toFixed(1)}% · {t('主动卖','Taker sell')} {(100-buy).toFixed(1)}%</dd>
      <small>{formatTime(ready.observedStart)} · {t('从突破分钟起','From breakout minute')} {ready.minutes} {t('分钟','min')}</small>
      <small>{t('现货成交','Spot volume')} {precision.format(ready.totalVolume)} {ready.baseAsset}</small></>:
      <small>{formatTime(event.start)} · {transient?t('成交数据暂未取得','Trade data unavailable'):
        unavailable==='unsupported'?t('当前行情源未接入主动买卖数据','Taker volume unavailable for this feed'):
        unavailable==='budget'?t('边界多次穿越，尚未核实突破分钟','Repeated crossings; breakout minute unverified'):
        unavailable==='incomplete'?t('同源分钟记录不完整或与突破不符','Minute data incomplete or inconsistent with breakout'):
        unavailable==='no-trades'?t('观察时段无成交','No trades in the window'):t('正在读取分钟成交','Loading minute trades')}
        {transient&&<button className="text-button" onClick={()=>{setFlow(null);setFailed(false);setRetry(n=>n+1);}}>{t('重试','Retry')}</button>}</small>}
  </div>;
}
