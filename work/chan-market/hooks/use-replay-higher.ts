"use client";
import {useEffect,useMemo,useState} from 'react';
import type {Candle,MarketData} from '@/lib/market-types';
import type {HigherFeed} from '@/lib/market-context-loader';
import {barAtTime,fetchLinkedHistory,linkedBars,linkedHistoryCursor,linkedIdentity} from '@/lib/linked-timeframes';
import {deriveReplayParent,isNativeReplayParent,replayParentWindow} from '@/lib/replay-higher';
import {readMarketResponse} from '@/lib/market-response';
import {higherInterval} from '@/lib/timeframe-context';

interface ParentPage {bars:Candle[]; failed:boolean}

/** A replay cursor owns one parent window even when the comparison pane is closed. */
export function useReplayHigher(primary:MarketData|null,liveHigher:HigherFeed|undefined,at:number|null):HigherFeed|undefined {
  const target=primary?higherInterval(primary.instrument.market,primary.interval):null;
  const active=!!primary&&!!target&&at!==null&&at>0&&liveHigher?.status!=='imported';
  const subscription=active?JSON.stringify([linkedIdentity(primary),primary.instrument.currency,target,primary.asOf]):'';
  const supplied=primary&&target&&isNativeReplayParent(primary,liveHigher?.data,target)?liveHigher.data:undefined;
  const [seed,setSeed]=useState<{key:string;data?:MarketData}|null>(null);
  const seeded=subscription&&seed?.key===subscription?seed:null;
  const native=supplied??(primary&&target&&isNativeReplayParent(primary,seeded?.data,target)?seeded.data:undefined);
  const recent=useMemo(()=>active&&native?linkedBars(native,Infinity):[],[active,native]);
  // One archive page supplies both the chart's 48 visible bars and the judgment's 35-bar minimum.
  const before=active&&native&&barAtTime(recent,at)<47?linkedHistoryCursor(target,native.candles[0]?.time??0,at):0;
  const identity=before&&native?JSON.stringify(linkedIdentity(native)):'';
  const pageKey=before?identity+'|'+before:'';
  const [archive,setArchive]=useState<{scope:string;pages:(ParentPage&{key:string})[]}|null>(null);
  const page=pageKey&&archive?.scope===subscription?archive.pages.find(p=>p.key===pageKey):undefined;
  useEffect(()=>{
    if(!pageKey||page)return;
    const controller=new AbortController();
    function settle(value:ParentPage){
      if(controller.signal.aborted)return;
      setArchive(last=>{
        const pages=last?.scope===subscription?last.pages.slice(-7):[];
        return {scope:subscription,pages:[...pages,{key:pageKey,...value}]};
      });
    }
    void fetchLinkedHistory(JSON.parse(identity),before,AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]))
      .then(result=>settle({bars:result.bars,failed:false}),()=>settle({bars:[],failed:true}));
    return ()=>controller.abort();
  },[subscription,identity,before,pageKey,page]);

  const extraBars=page?.bars;
  const parentRows=useMemo(()=>native&&extraBars?.length?linkedBars({...native,candles:extraBars},Infinity).concat(recent):recent,[native,extraBars,recent]);
  const parent=useMemo(()=>active&&native?replayParentWindow(native,parentRows,at):undefined,[active,native,parentRows,at]);
  const waitingForPage=!!pageKey&&!page;
  const needFallback=active&&!waitingForPage&&(!parent||parent.candles.length<35);
  const primaryRows=useMemo(()=>needFallback?linkedBars(primary,Infinity):[],[needFallback,primary]);
  const derived=useMemo(()=>needFallback?deriveReplayParent(primary,primaryRows,at):undefined,[needFallback,primary,primaryRows,at]);

  // Entering replay cancels the live snapshot request. If it had not resolved the actual
  // parent venue yet, obtain the identity once before asking that venue for an archive page.
  const query=active&&target&&!native&&!derived&&!seeded?new URLSearchParams({market:primary.instrument.market,symbol:primary.instrument.symbol,interval:target}).toString():'';
  useEffect(()=>{
    if(!query||!target)return;
    const controller=new AbortController();
    const p=new URLSearchParams(query);
    const expected={market:p.get('market') as MarketData['instrument']['market'],symbol:p.get('symbol')!,interval:target};
    const read=async(path:string,timeout:number)=>readMarketResponse(await fetch(path+query,{
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(timeout)]),
    }),expected);
    async function load(){
      let data:MarketData|undefined;
      try{data=await read('/api/candles?',90000);}
      catch{
        if(controller.signal.aborted)return;
        try{data=await read('/api/cached-candles?',4000);}catch{/* The desktop may have no saved parent snapshot. */}
      }
      if(!controller.signal.aborted)setSeed({key:subscription,data});
    }
    void load();
    return ()=>controller.abort();
  },[subscription,query,target]);
  return useMemo(()=>{
    if(!active)return liveHigher;
    if(waitingForPage||query)return {interval:target,status:'loading'};
    const data=derived??parent;
    if(data)return {interval:target,status:'ready',data};
    // No corroborating closed bar at this replay instant. Confluence reports insufficient.
    return {interval:target,status:page?.failed?'error':'ready'};
  },[active,liveHigher,waitingForPage,query,target,derived,parent,page]);
}
