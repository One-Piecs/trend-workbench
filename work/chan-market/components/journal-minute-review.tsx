"use client";
import {useEffect,useRef,useState} from 'react';
import {useLanguage} from '@/lib/language';
import type {ForecastRecord} from '@/lib/forecast-journal';
import type {MarketData} from '@/lib/market-types';
import {journalReviewContext,reviewJournalMinuteOrder,type TargetOrder} from '@/lib/journal-minute-review';

const orderLabels:Record<TargetOrder['order'],[string,string]>={
  'target-first':['止盈先到','Target first'],'stop-first':['止损先到','Stop first'],
  'same-minute':['同一分钟内均触及，先后不明','Both touched within one minute; order unknown'],
  'unavailable':['分钟数据未能核对','Minute evidence unavailable'],'untouched':['本根K线未触及该止盈价','Target untouched in this candle']
};
export default function JournalMinuteReview({record,data}:{record:ForecastRecord;data:MarketData|null}){
  const {t,locale}=useLanguage(),[busy,setBusy]=useState(false),[error,setError]=useState(false);
  const [result,setResult]=useState<TargetOrder[]|null>(null);
  const request=useRef<AbortController|null>(null);
  useEffect(()=>()=>request.current?.abort(),[]);
  const input=journalReviewContext(record,data);
  if(input.kind==='none')return null;
  if(input.kind==='same-minute')return <p>{t('这条记录来自1分钟K线，分钟数据无法再区分先后。','This record uses a one-minute candle. Minute history cannot distinguish the sequence.')}</p>;
  if(input.kind==='unsupported')return <p>{t('这条记录的行情源或周期暂不支持分钟核对。','Minute review is unavailable for this feed or timeframe.')}</p>;
  if(input.kind==='missing-parent')return <p>{t('缺少原始K线。旧记录可切回同一行情源和周期再核对。','Original candle unavailable. For older records, reopen the same feed and timeframe.')}</p>;
  const check=async()=>{
    if(input.kind!=='ready'||request.current)return;
    const controller=new AbortController();request.current=controller;setBusy(true);setError(false);
    const {instrument,source,adjustment}=input.primary;
    const params=new URLSearchParams({symbol:instrument.symbol,venue:instrument.exchange,currency:instrument.currency,
      source,adjustment,start:String(input.start),end:String(input.end)});
    try{
      const response=await fetch('/api/journal-minutes?'+params,{signal:controller.signal});
      if(!response.ok)throw new Error();
      const rows=reviewJournalMinuteOrder(record,input,await response.json());
      if(!controller.signal.aborted)setResult(rows);
    }catch{if(!controller.signal.aborted)setError(true);}
    finally{if(!controller.signal.aborted){setBusy(false);request.current=null;}}
  };
  return <div><button disabled={busy} onClick={()=>void check()}>{busy?t('正在核对分钟行情','Checking minute data'):t('用1分钟K线核对先后','Check order with 1m bars')}</button>
    <div aria-live="polite">{error?<p>{t('同源分钟行情暂不可用，可稍后重试。','Same-source minute data are unavailable. Try again later.')}</p>:result&&<>
      <p>{t('该根K线内的触价顺序 · 单独复核，不计入上方统计','Price-touch order within this candle · separate from the statistics above')}</p>
      {result.map((row,i)=><p key={i}>T{i+1} · {t(...orderLabels[row.order])} {row.minuteStart!==undefined&&new Date(row.minuteStart*1000).toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</p>)}
    </>}</div>
  </div>;
}
