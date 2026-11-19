"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import type {MarketData} from '@/lib/market-types';
import type {MarketForecast} from '@/lib/forecast-types';
import {advanceForecastJournal,emptyJournal,forecastIdentity,readForecastJournal,recordForecast,writeForecastJournal} from '@/lib/forecast-journal';
import {selectForecastNotices,type ForecastNotice} from '@/lib/forecast-alerts';
export type {ForecastNotice} from '@/lib/forecast-alerts';

export function useForecastJournal() {
  const [journal,setJournal]=useState(emptyJournal),[ready,setReady]=useState(false),[saved,setSaved]=useState(true),[notices,setNotices]=useState<ForecastNotice[]>([]);
  const current=useRef(journal),hydrated=useRef(false),seen=useRef(new Set<string>()),startedAt=useRef(0);
  const quoteBaselines=useRef(new Map<string,number>());
  useEffect(()=>{
    const stored=readForecastJournal();current.current=stored;
    try{const ids=JSON.parse(localStorage.getItem('trend-forecast-notice-ids-v1')||'[]');if(Array.isArray(ids))seen.current=new Set(ids.filter(x=>typeof x==='string'));}catch{}
    startedAt.current=Date.now()/1000;hydrated.current=true;
    // Hydration is intentionally deferred: browser-owned records have no SSR equivalent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setJournal(stored);setReady(true);
  },[]);
  const observe=useCallback((data:MarketData,forecast:MarketForecast,allowSignals:boolean)=>{
    if(!hydrated.current)return;
    const now=Date.now()/1000,advanced=advanceForecastJournal(current.current,data,now);
    const identity=forecastIdentity(data),previousPrice=quoteBaselines.current.get(identity),price=data.candles.at(-1)?.close;
    if(price&&Number.isFinite(price))quoteBaselines.current.set(identity,price);
    const next=allowSignals?recordForecast(advanced.journal,data,forecast,now):advanced.journal;
    current.current=next;setJournal(next);setSaved(writeForecastJournal(next));
    const alerts=selectForecastNotices(next,data,forecast,advanced.events,{now,startedAt:startedAt.current,previousPrice,allowSignals,seen:seen.current});
    if(alerts.length){setNotices(previous=>[...alerts.reverse(),...previous].slice(0,12));try{const ids=[...seen.current].slice(-2000);seen.current=new Set(ids);localStorage.setItem('trend-forecast-notice-ids-v1',JSON.stringify(ids));}catch{}}
  },[]);
  return {journal,ready,saved,notices,observe};
}
