"use client";

import {useEffect,useState} from 'react';
import {compareTradeOrder,type BattleBook,type BattlePrintPrice,type BattleSnapshot,type BattleTradeEvent} from '@/lib/battle-tape';
import {battleTier} from '@/lib/battle-deployment';
import {BattleChargeDetector} from '@/lib/battle-charge';
import {subscribeBattleTrades,type BattleFrame} from '@/lib/battle-stream';
import {subscribeBattleDepth} from '@/lib/battle-depth-stream';
import type {BattleArenaEvent} from './battle-arena';

type Phase='loading'|'ok'|'stale'|'offline'|'paused'|'error';
type Venue=BattleSnapshot['source'];
interface State {
  status:Phase; transport:'live'|'connecting'|'retrying'|'snapshot'; bookLive:boolean;
  data?:BattleSnapshot; events:readonly BattleArenaEvent[];
  charge:{id:string;side:'buy'|'sell';notional:number}|null;
  quote:(BattlePrintPrice & {symbol:string;mode:'live'|'snapshot'})|null;
  fills:Partial<Record<BattleTradeEvent['side'],BattleTradeEvent>>;
}
const empty:State={status:'loading',transport:'connecting',bookLive:false,events:[],charge:null,quote:null,fills:{}};
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
function validQuote(quote:BattlePrintPrice|null|undefined):quote is BattlePrintPrice {
  return !!quote&&typeof quote.id==='string'&&/^\d{1,32}$/.test(quote.id)&&finite(quote.price)&&quote.price>0&&finite(quote.time)&&quote.time>0;
}
function validSnapshot(data:BattleSnapshot,symbol:string) {
  if(!data||data.symbol!==symbol||data.currency!=='USDT'||!finite(data.asOf)||!data.asOf||!['Binance','OKX'].includes(data.source))return false;
  const {flow,book}=data;
  if(!flow&&!book&&!validQuote(data.lastTrade))return false;
  if(flow&&(!finite(flow.buy)||!finite(flow.sell)||!finite(flow.buy+flow.sell)||!Number.isSafeInteger(flow.count)||flow.count<1||!finite(flow.firstTime)||!finite(flow.lastTime)
    ||flow.firstTime>flow.lastTime||typeof flow.limited!=='boolean'||flow.windowSeconds!==60||!Array.isArray(flow.buckets)||flow.buckets.length!==6
    ||!flow.buckets.every(b=>b&&finite(b.start)&&finite(b.buy)&&finite(b.sell))
    ||!flow.largest||!finite(flow.largest.amount)||!finite(flow.largest.time)||!finite(flow.largest.price)||!['buy','sell'].includes(flow.largest.side)))return false;
  return !book||(finite(book.bid)&&finite(book.ask)&&finite(book.bestBid)&&finite(book.bestAsk)&&finite(book.bids)&&finite(book.asks)
    &&finite(book.observedAt)&&book.bestBid<book.bestAsk&&finite(book.bid+book.ask)&&book.bandBps===25);
}

export function useBattleFeed(symbol:string,enabled:boolean,attempt:number) {
  const [state,setState]=useState<State>(empty);
  useEffect(()=>{
    if(!enabled)return;
    let disposed=false,generation=0,source:Venue='Binance',stopTrades:(()=>void)|undefined,stopDepth:(()=>void)|undefined;
    let nextPoll:number|undefined,expiry:number|undefined,failover:number|undefined,request:AbortController|undefined;
    let phase:Phase='loading',connection:'connecting'|'retrying'|'live'='connecting',snapshot:BattleSnapshot|undefined;
    let frame:BattleFrame|undefined,depth:BattleBook|null=null,hadSnapshot=false,switched=false,quiet=false;
    let events:readonly BattleArenaEvent[]=[],cutoff=0;
    let fills:State['fills']={};
    let highWater:BattlePrintPrice|null=null,quoteExpiry:number|undefined,expiresAt=0;
    const detector=new BattleChargeDetector();
    let charge:State['charge']=null,chargeSequence=0;
    function resetCharge(){detector.reset();charge=null;}
    const seen=new Set<string>();
    function paint(){
      if(disposed)return;
      const now=Date.now()/1000;
      const cached=phase==='ok'&&snapshot?.source===source?snapshot:undefined;
      const book=depth??(cached?.book&&now-cached.book.observedAt<=15?cached.book:null);
      const flow=frame?.flow??(!quiet&&cached?.flow||null);
      const asOf=Math.max(frame?.asOf??0,cached?.asOf??0,book?.observedAt??0);
      const latestLive=connection==='live'?frame?.lastTrade:null,latestSnapshot=cached?.lastTrade;
      let quote:State['quote']=null;
      for(const [mode,print] of [['live',latestLive],['snapshot',latestSnapshot]] as const){
        if(!validQuote(print)||print.time>now||now-print.time>=15||highWater&&compareTradeOrder(print,highWater)<0)continue;
        if(!quote||compareTradeOrder(print,quote)>0)quote={...print,symbol,mode};
      }
      if(quote)highWater=quote;
      const expiryMs=quote?Math.round(quote.time*1000)+15000:0;
      if(expiryMs!==expiresAt){
        window.clearTimeout(quoteExpiry);expiresAt=expiryMs;
        if(expiryMs)quoteExpiry=window.setTimeout(paint,Math.max(1,expiryMs-Date.now()+1));
      }
      const data:BattleSnapshot|undefined=flow||book||quote?{source,symbol,currency:'USDT',asOf,flow,book}:undefined;
      setState({status:data?'ok':phase,transport:connection==='live'?'live':cached?'snapshot':connection,
        data,bookLive:!!depth,events,quote,fills:flow?fills:empty.fills,charge:connection==='live'&&frame?charge:null});
    }
    function take(prints:readonly BattleTradeEvent[]|undefined,baseline=false){
      const now=Date.now()/1000,next:BattleArenaEvent[]=[];
      const prefix=source+'/'+symbol+'/';
      for(const p of prints??[]){
        if(!p||typeof p.id!=='string'||!p.id.startsWith(prefix)||!/^\d{1,32}$/.test(p.id.slice(prefix.length))||!finite(p.notional)||p.notional<=0||
          !finite(p.time)||(p.side!=='buy'&&p.side!=='sell')||seen.has(p.id))continue;
        seen.add(p.id);
        if(now-p.time<=15&&p.time<=now){
          const previous=fills[p.side];
          if(!previous||compareTradeOrder(p,previous)>0)fills={...fills,[p.side]:p};
        }
        if(baseline||p.time<cutoff||now-p.time>6||p.time>now+1.5)continue;
        const tier=battleTier(p.notional);
        next.push({id:p.id,side:p.side,notional:p.notional,heavy:tier!=='infantry',tier});
      }
      if(seen.size>4096){for(const id of seen){seen.delete(id);if(seen.size<=3000)break;}}
      if(next.length)events=next;
    }
    function openStreams(venue:Venue){
      stopTrades?.();stopDepth?.();window.clearTimeout(failover);failover=undefined;
      source=venue;frame=undefined;depth=null;quiet=false;hadSnapshot=false;connection='connecting';
      events=[];fills={};seen.clear();highWater=null;cutoff=Date.now()/1000-0.35;resetCharge();
      stopTrades=subscribeBattleTrades(symbol,source,{
        onFrame(value){
          frame=value;quiet=false;
          const total=value.flow.buy+value.flow.sell,now=Math.round(value.asOf*1000);
          const push=detector.update(total?value.flow.buy/total*100:null,value.deltas,now);
          charge=push?{...push,id:[source,symbol,now,++chargeSequence].join('/')}:null;
          take(value.events);paint();
        },
        onQuiet(){frame=undefined;quiet=true;events=[];fills={};resetCharge();paint();},
        onStatus(value){
          connection=value;resetCharge();
          if(value==='live'){events=[];window.clearTimeout(failover);failover=undefined;}
          else if(value==='retrying'){
            frame=undefined;quiet=false;events=[];cutoff=Date.now()/1000;
            failover??=window.setTimeout(()=>{
              if(connection==='live'||disposed)return;
              switched=true;snapshot=undefined;phase='loading';
              openStreams(source==='Binance'?'OKX':'Binance');
              request?.abort();window.clearTimeout(nextPoll);void poll();
            },16000);
          }
          paint();
        },
      });
      stopDepth=subscribeBattleDepth(symbol,source,value=>{depth=value;paint();});
    }
    async function poll(){
      if(disposed||document.hidden||!navigator.onLine)return;
      const gen=generation,ctl=new AbortController();request=ctl;
      let delay=5000;
      try{
        const params=new URLSearchParams({symbol});
        if(switched||connection==='live')params.set('venue',source);
        const response=await fetch('/api/battle?'+params,{cache:'no-store',signal:AbortSignal.any([ctl.signal,AbortSignal.timeout(12000)])});
        if(!response.ok)throw new Error('Market snapshot unavailable');
        const data:BattleSnapshot=await response.json();
        if(!validSnapshot(data,symbol))throw new Error('Invalid market snapshot');
        if(gen!==generation||ctl.signal.aborted||disposed)return;
        const age=Date.now()-data.asOf*1000;
        if(data.source!==source&&connection!=='live'&&!switched&&age>=-1500&&age<15000)openStreams(data.source);
        window.clearTimeout(expiry);
        if(age>15000||age< -1500||data.source!==source){phase='stale';snapshot=undefined;if(!frame)events=[];}
        else{
          phase='ok';snapshot=data;
          if(data.flow&&connection!=='live')take(data.flow.recentTrades,!hadSnapshot);
          hadSnapshot=true;
          expiry=window.setTimeout(()=>{phase='stale';snapshot=undefined;if(!frame)events=[];paint();},15000-age);
        }
        paint();
        if(connection==='live'&&depth)delay=12000;
      }catch{
        if(!ctl.signal.aborted&&gen===generation&&!disposed){
          phase='error';snapshot=undefined;if(!frame)events=[];window.clearTimeout(expiry);paint();delay=8000;
        }
      }finally{
        if(request===ctl&&!ctl.signal.aborted&&gen===generation&&!disposed){
          request=undefined;nextPoll=window.setTimeout(poll,delay);
        }
      }
    }
    function stop(){
      generation++;request?.abort();request=undefined;stopTrades?.();stopDepth?.();
      window.clearTimeout(nextPoll);window.clearTimeout(expiry);window.clearTimeout(failover);failover=undefined;
      window.clearTimeout(quoteExpiry);expiresAt=0;highWater=null;
      stopTrades=stopDepth=undefined;snapshot=undefined;frame=undefined;depth=null;events=[];fills={};resetCharge();
    }
    function activate(){
      stop();switched=false;
      if(document.hidden||!navigator.onLine){
        phase=document.hidden?'paused':'offline';connection='connecting';paint();return;
      }
      phase='loading';openStreams('Binance');void poll();
    }
    activate();
    document.addEventListener('visibilitychange',activate);
    window.addEventListener('offline',activate);window.addEventListener('online',activate);
    return ()=>{disposed=true;stop();document.removeEventListener('visibilitychange',activate);window.removeEventListener('offline',activate);window.removeEventListener('online',activate);};
  },[symbol,enabled,attempt]);
  return state;
}
