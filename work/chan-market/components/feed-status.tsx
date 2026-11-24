"use client";
import {useEffect,useState} from 'react';
import type {Candle,MarketData} from '@/lib/market-types';
import type {MarketForecast} from '@/lib/forecast-types';
import type {FeedHealth} from '@/lib/feed-health';
import {candleAvailableAt} from '@/lib/timeframe-context';
import {useLanguage} from '@/lib/language';
import {marketDisplayText} from '@/lib/market-i18n';
import {priceText} from './terminal-chart';

export default function FeedStatus({data,displayBar,forecast,health,replay=false,imported=false}:{data:MarketData|null;displayBar?:Candle;forecast:MarketForecast|null;health:FeedHealth;replay?:boolean;imported?:boolean}) {
  const {t,language,locale}=useLanguage(),[now,setNow]=useState(()=>Date.now());
  useEffect(()=>{if(replay||imported)return;const id=window.setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[replay,imported]);
  const last=displayBar??data?.candles.at(-1),crypto=data?.instrument.market==='crypto';
  // Availability includes provider delays; countdown labels the candle boundary,
  // while the feed detail separately states the delay and confirmation latency.
  const end=last&&data?candleAvailableAt(last,data.instrument.market,data.interval,data.source)-(crypto?0:data.instrument.market==='cn'?120:900):null;
  const remaining=end===null?0:Math.max(0,Math.ceil(end-now/1000));
  const duration=(s:number)=>s>=86400?`${Math.floor(s/86400)}${t('天','d')} ${Math.floor(s%86400/3600)}${t('小时','h')}`:`${Math.floor(s/3600).toString().padStart(2,'0')}:${Math.floor(s%3600/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`;
  const directional=forecast&&forecast.direction!=='neutral'?forecast[forecast.direction]:null;
  const reference=displayBar?.close??forecast?.referencePrice;
  const diff=directional?.status==='ready'&&reference?((directional.triggerPrice/reference)-1)*100:null;
  const stamp=(time:number)=>new Date(time).toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const showNotice=replay||imported||!['fresh','delayed','closed'].includes(health.state);
  return <div className={`feed-status ${health.state}${showNotice?'':' compact'}`} data-testid="feed-status">
    {showNotice&&<><div><strong>{replay?t('历史回放 · 不发提醒','Replay · alerts paused'):imported?t('导入数据 · 不发提醒','Imported data · alerts paused'):t(health.label,health.labelEn)}</strong><span>{health.lastSuccessAtMs?t(`最近获取 ${stamp(health.lastSuccessAtMs)}`,`Last fetched ${stamp(health.lastSuccessAtMs)}`):t('等待行情','Waiting for data')}</span></div>
    <p>{replay?t('预判仅使用回放位置之前的数据。','Outlooks use only data before the replay cursor.'):imported?t('按导入数据计算，未核验在线时效。','Calculated from imported data; online freshness is not verified.'):marketDisplayText(t(health.detail,health.detailEn),language)}</p></>}
    {!replay&&!imported&&data&&<div className="candle-progress">
      <span>{last?.closed===false&&remaining>0?t(`本根K线剩余 ${duration(remaining)}${health.state==='closed'?t('（夜盘/盘外时段）',' (overnight/extended session)'):''}`,`Candle ends in ${duration(remaining)}${health.state==='closed'?' (overnight/extended session)':''}`):health.state==='closed'?(data.instrument.market==='commodity'?t('期货休市','Futures session closed'):t('当前不在常规交易时段','Outside regular trading hours')):!crypto&&['1w','1M'].includes(data.interval)?t('本周期结束以交易所日历为准','Period end follows the exchange trading calendar'):last?.closed!==false?t('当前K线已结束，等待下一根行情','Latest candle completed; waiting for the next bar'):t('本根已到结束时间，等待行情确认','Candle boundary reached; waiting for data confirmation')}{!crypto&&health.state!=='closed'&&last?.closed===false&&!['1w','1M'].includes(data.interval)&&t('（按常规时段估算）',' (regular-session estimate)')}</span>
      {(health.allowSignals||health.state==='closed')&&diff!==null&&directional?.status==='ready'&&<span>{t('距入场确认价','Distance to entry confirmation price')} {priceText(directional.triggerPrice)} · {diff>=0?t('向上','up'):t('向下','down')} {Math.abs(diff).toFixed(2)}%</span>}
    </div>}
  </div>;
}
