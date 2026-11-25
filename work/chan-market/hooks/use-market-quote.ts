"use client";

import {useEffect, useRef, useState} from 'react';
import type {MarketData} from '@/lib/market-types';
import {advanceQuoteSequence,displayQuoteSequence,type QuoteSequence} from '@/lib/quote-overlay';

interface Frame {key:string; status:string; checkedAt:number; sequence:QuoteSequence|null}

export function useMarketQuote(data:MarketData|null, enabled:boolean, clock:number, reconcile?:()=>void) {
  const instrument=data?.instrument;
  const key=enabled&&data&&instrument&&instrument.market!=='crypto'?new URLSearchParams({
    market:instrument.market,symbol:instrument.symbol,interval:data.interval,source:data.source,adjustment:data.adjustment,
    ...(instrument.contract?{contract:instrument.contract}:{}),
  }).toString():'';
  const latest=useRef({data,reconcile});
  useEffect(()=>{latest.current={data,reconcile};},[data,reconcile]);
  const [frame,setFrame]=useState<Frame|null>(null);
  useEffect(()=>{
    if(!key)return;
    const identity=new URLSearchParams(key);
    let timer:number|undefined, request:AbortController|undefined;
    let sequence:QuoteSequence|null=null;
    let lastReconcile=-Infinity;
    async function poll(){
      if(document.hidden||!navigator.onLine||request)return;
      const current=new AbortController();
      request=current;
      let intervalMs=15000;
      try{
        const response=await fetch('/api/live-quote?'+key,{cache:'no-store',signal:AbortSignal.any([current.signal,AbortSignal.timeout(18000)])});
        if(!response.ok)throw new Error();
        const value:unknown=await response.json();
        if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
        const body=value as Record<string,unknown>;
        if(!['market','symbol','interval'].every(k=>body[k]===identity.get(k))||typeof body.status!=='string')throw new Error();
        if(request!==current)return;
        const checkedAt=Date.now(), snapshot=latest.current.data;
        if(body.status==='quote'&&snapshot){
          const update=advanceQuoteSequence(snapshot,sequence,body.quote,checkedAt);
          sequence=update.sequence;
          if(update.reconcile&&checkedAt-lastReconcile>=15000){
            lastReconcile=checkedAt;
            latest.current.reconcile?.();
          }
        }
        setFrame({key,status:body.status,checkedAt,sequence});
        const quoteSession=body.status==='quote'&&body.quote&&typeof body.quote==='object'?(body.quote as {session?:unknown}).session:undefined;
        intervalMs=body.status==='quote'?(quoteSession==='overnight'?8000:5000):body.status==='stale'?10000:body.status==='closed'||body.status==='unconfigured'?60000:30000;
      }catch{
        if(request===current)setFrame({key,status:'unavailable',checkedAt:Date.now(),sequence});
      }finally{
        if(request===current){
          request=undefined;
          timer=window.setTimeout(poll,intervalMs);
        }
      }
    }
    function cancel(){
      window.clearTimeout(timer);
      const previous=request;
      request=undefined;
      previous?.abort();
    }
    function onAvailability(){
      cancel();
      setFrame({key,status:'unavailable',checkedAt:Date.now(),sequence});
      void poll();
    }
    void poll();
    window.addEventListener('online',onAvailability);
    window.addEventListener('offline',onAvailability);
    document.addEventListener('visibilitychange',onAvailability);
    return ()=>{
      cancel();
      window.removeEventListener('online',onAvailability);
      window.removeEventListener('offline',onAvailability);
      document.removeEventListener('visibilitychange',onAvailability);
    };
  },[key]);
  const active=key&&frame?.key===key?frame:null;
  const overlay=active&&data?displayQuoteSequence(data,active.sequence,Math.max(clock,active.checkedAt)):null;
  const quote=active?.status==='quote'?overlay?.quote:null;
  // Retain a still-fresh, checked chart bar across a transient poll failure, without claiming the quote is live.
  const candle=active&&['quote','stale','unavailable'].includes(active.status)?overlay?.candle:undefined;
  return {quote,candle,status:active?.status==='quote'&&!quote?'stale':active?.status};
}
