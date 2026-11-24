"use client";
import {useMemo,useState} from 'react';
import type {Candle,MarketData} from '@/lib/market-types';
import {useLanguage} from '@/lib/language';
import {auditFourHourCoverage} from '@/lib/four-hour-coverage';
import {candleAvailableAt} from '@/lib/timeframe-context';

const hhmm=(minute:number)=>`${Math.floor(minute/60).toString().padStart(2,'0')}:${(minute%60).toString().padStart(2,'0')}`;

export default function FourHourCoverage({data,bars,replay}:{data:MarketData;bars:Candle[];replay:boolean}){
  const {t}=useLanguage(),market=data.instrument.market;
  const [open,setOpen]=useState(false),[limit,setLimit]=useState(30);
  const audit=useMemo(()=>{
    if((market!=='cn'&&market!=='us')||data.interval!=='4h')return null;
    let asOf=Date.parse(data.asOf)/1000;
    const last=bars.at(-1);
    if(replay&&last)asOf=Math.min(asOf,candleAvailableAt(last,market,'4h',data.source));
    return auditFourHourCoverage(market,bars,asOf);
  },[market,data.interval,data.asOf,data.source,bars,replay]);
  if(!bars.length)return null;
  if(!audit)return <div className="calendar-coverage">{t('4小时交易日历未覆盖这段历史','4h session calendar unavailable for this history')}</div>;
  const pending=audit.gaps.filter(slot=>slot.present).length,missing=audit.gaps.length-pending;
  return <details className="calendar-coverage" data-testid="four-hour-coverage" onToggle={event=>{
    setOpen(event.currentTarget.open);
    if(!event.currentTarget.open)setLimit(30);
  }}>
    <summary>{t('4小时交易日历','4h session calendar')} · {t(`已核对 ${audit.expected} 根`,`${audit.expected} bars checked`)}
      {missing>0&&<span className="calendar-gap"> · {t(`缺 ${missing} 根`,`${missing} missing`)}</span>}
      {pending>0&&<span className="calendar-gap"> · {t(`${pending} 根尚未确认`,`${pending} unconfirmed`)}</span>}
    </summary>
    <p>{audit.start} – {audit.end} · {market==='us'?t('纽约时间','New York time'):t('北京时间','Beijing time')} · {t('仅核对已到期的交易时段','Completed scheduled periods only')}
      {audit.partial&&t(' · 部分日期超出日历范围',' · Some dates fall outside calendar coverage')}</p>
    {open&&audit.gaps.length>0&&<><p>{t('以下时段缺少已完成的K线，原因可能是行情源缺数或个股停牌。','These periods have no confirmed bar. The feed may be missing data, or trading in the instrument may have been halted.')}</p>
      <ul tabIndex={0} aria-label={t('缺少或未确认的交易时段','Missing or unconfirmed sessions')}>{audit.gaps.slice(-limit).reverse().map(slot=><li key={slot.date+'-'+slot.start}>{slot.date} · {hhmm(slot.start)}–{hhmm(slot.end)} · {slot.present?t('尚未确认','Unconfirmed'):t('缺K线','Missing bar')}</li>)}</ul>
      {audit.gaps.length>limit&&<button className="text-button" onClick={()=>setLimit(limit+30)}>{t('查看更早时段','Show earlier periods')}</button>}</>}
  </details>;
}
