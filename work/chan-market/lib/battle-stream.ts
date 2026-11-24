import {compareTradeOrder,type BattleFlow,type BattlePrintPrice,type BattleSnapshot,type BattleTradeEvent} from './battle-tape.ts';
import {battleDeployments} from './battle-deployment.ts';
import {BATTLE_CHARGE_WINDOW_MS,type BattleDelta} from './battle-charge.ts';

type Venue = BattleSnapshot['source'];
type Print = BattleTradeEvent & {price:number};
type Status = 'connecting'|'live'|'retrying';
export interface BattleFrame {flow:BattleFlow; events:BattleTradeEvent[]; deltas:BattleDelta[]; asOf:number;lastTrade:BattlePrintPrice|null}
interface Callbacks {
  onStatus(status:Status):void;
  onFrame(frame:BattleFrame):void;
  onQuiet?():void;
}
const dictionary = (x:unknown):Record<string,unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string,unknown> : {};
const spotPair = (symbol:string) => symbol.slice(0,-4)+'-USDT';
const positive = (x:unknown) => typeof x==='string' && /^\d+(?:\.\d+)?$/.test(x) ? Number(x) : NaN;

/** Both channels report individual matches. The OKX public 'trades' channel bundles fills. */
export function decodeBattleTrades(symbol:string, source:Venue, raw:unknown, now:number):Print[] {
  const msg=dictionary(raw), result:Print[]=[];
  function accept(id:unknown, ms:number, price:number, size:number, side:unknown) {
    const notional=price*size;
    if(typeof id!=='string'||!/^\d{1,32}$/.test(id)||!Number.isSafeInteger(ms)||ms<=0||ms<now-10000||ms>now+1500||
      !Number.isFinite(notional)||notional<=0||(side!=='buy'&&side!=='sell'))return;
    result.push({id:source+'/'+symbol+'/'+id,time:ms/1000,side,notional,price});
  }
  if(source==='Binance'){
    if(msg.e==='trade'&&msg.s===symbol&&Number.isSafeInteger(msg.t)&&Number(msg.t)>=0&&typeof msg.m==='boolean'&&typeof msg.T==='number')
      accept(String(msg.t),msg.T,positive(msg.p),positive(msg.q),msg.m?'sell':'buy');
  } else {
    const arg=dictionary(msg.arg),pair=spotPair(symbol);
    if(arg.channel!=='trades-all'||arg.instId!==pair||!Array.isArray(msg.data))return result;
    for(const item of msg.data){
      const row=dictionary(item);
      if(row.instId===pair&&typeof row.ts==='string'&&/^\d+$/.test(row.ts))
        accept(row.tradeId,Number(row.ts),positive(row.px),positive(row.sz),row.side);
    }
  }
  return result;
}

interface Second {
  ids:Set<string>; buy:number; sell:number; largest:Print; first:number; last:number;
}
/** Keep one second's totals and largest print per bin. The visual event cap never caps the tape. */
function rollingTape(seed?:BattleFlow|null) {
  const seconds=new Map<number,Second>();
  const seen=new Set<string>();
  const seeded=new Set(seed?.recentTrades?.map(t=>t.id));
  const deltas=new Map<number,{buy:number;sell:number}>();
  const future=new Map<string,Print>();
  let batch:Print[]=[];
  const large:Print[]=[];
  const peak:{buy?:Print;sell?:Print}={};
  let lastBySide:{buy?:Print;sell?:Print}={};
  let lastTrade:BattlePrintPrice|null=null;
  function append(print:Print){
    seen.add(print.id);
    const quote={id:print.id.slice(print.id.lastIndexOf('/')+1),time:print.time,price:print.price};
    if(!lastTrade||compareTradeOrder(quote,lastTrade)>0)lastTrade=quote;
    const sec=Math.floor(print.time);
    let row=seconds.get(sec);
    if(!row){
      row={ids:new Set(),buy:0,sell:0,largest:print,first:print.time,last:print.time};
      seconds.set(sec,row);
    }
    row.ids.add(print.id);
    row[print.side]+=print.notional;
    row.first=Math.min(row.first,print.time);
    row.last=Math.max(row.last,print.time);
    if(print.notional>row.largest.notional)row.largest=print;
    if(!seeded.has(print.id)){
      const previous=lastBySide[print.side];
      if(!previous||compareTradeOrder(print,previous)>0)lastBySide[print.side]=print;
      const at=Math.round(print.time*1000);
      const delta=deltas.get(at)??{buy:0,sell:0};
      delta[print.side]+=print.notional;
      deltas.set(at,delta);
      if(batch.length>=24)batch.shift();
      batch.push(print);
      // Keep large fills that would otherwise fall out of a busy visual batch.
      if(print.notional>=battleDeployments[1].min){
        large.push(print);
        if(large.length>6){
          large.sort((a,b)=>b.notional-a.notional);
          large.length=6;
        }
      }
      if(!peak[print.side]||print.notional>peak[print.side]!.notional)peak[print.side]=print;
    }
  }
  return {
    accept(print:Print,now:number){
      if(seen.has(print.id)||future.has(print.id))return false;
      if(Math.round(print.time*1000)>now){future.set(print.id,print);return true;}
      append(print);return true;
    },
    hasFuture(){return future.size>0;},
    frame(now:number, connectedAt:number):BattleFrame|null {
      for(const [id,print] of future){
        if(Math.round(print.time*1000)>now)continue;
        future.delete(id);append(print);
      }
      const asOf=now/1000,start=Math.floor(asOf)-59;
      const buckets=Array.from({length:6},(_,i)=>({start:start+10*i,buy:0,sell:0}));
      let buy=0,sell=0,count=0,firstTime=Infinity,lastTime=0,largest:Print|undefined;
      for(const [sec,row] of seconds){
        if(sec<start){
          for(const id of row.ids)seen.delete(id);
          seconds.delete(sec);continue;
        }
        if(sec>Math.floor(asOf))continue;
        const bin=buckets[Math.floor((sec-start)/10)];
        buy+=row.buy;sell+=row.sell;bin.buy+=row.buy;bin.sell+=row.sell;count+=row.ids.size;
        firstTime=Math.min(firstTime,row.first);lastTime=Math.max(lastTime,row.last);
        if(!largest||row.largest.notional>largest.notional)largest=row.largest;
      }
      const pending=new Set([...batch,...large,peak.buy,peak.sell,lastBySide.buy,lastBySide.sell]);
      lastBySide={};
      batch=[];large.length=0;delete peak.buy;delete peak.sell;
      const events:BattleTradeEvent[]=[];
      const fresh:BattleDelta[]=[];
      for(const [at,totals] of deltas){
        if(at>now)continue;
        deltas.delete(at);
        if(at<connectedAt||now-at>=BATTLE_CHARGE_WINDOW_MS)continue;
        for(const side of ['buy','sell'] as const){
          if(totals[side]>0)fresh.push({at,side,notional:totals[side]});
        }
      }
      for(const p of pending){
        if(!p||asOf-p.time>4)continue;
        if(Math.floor(p.time)>Math.floor(asOf)){batch.push(p);continue;}
        events.push({id:p.id,time:p.time,side:p.side,notional:p.notional});
      }
      events.sort(compareTradeOrder);
      if(!largest||!Number.isFinite(buy+sell))return null;
      const flow:BattleFlow={buy,sell,count,firstTime,lastTime,windowSeconds:60,limited:connectedAt>start*1000,buckets,
        largest:{amount:largest.notional,price:largest.price,side:largest.side,time:largest.time}};
      return {asOf,events,flow,deltas:fresh,lastTrade};
    },
    clearEvents(){batch=[];large.length=0;delete peak.buy;delete peak.sell;lastBySide={};deltas.clear();future.clear();lastTrade=null;}
  };
}

/** Public spot push, bound to a single market. The caller owns tab visibility and disposal. */
export function subscribeBattleTrades(symbol:string, source:Venue, cb:Callbacks, seed?:BattleFlow|null,
  openSocket=(url:string)=>new WebSocket(url)):()=>void {
  if(!/^[A-Z0-9]{1,22}USDT$/.test(symbol)||(source!=='Binance'&&source!=='OKX'))return ()=>{};
  const main=source==='Binance',stream=symbol.toLowerCase()+'@trade';
  const url=main?'wss://data-stream.binance.vision/ws/'+stream:'wss://ws.okx.com/ws/v5/business';
  const tape=rollingTape(seed);
  let socket:WebSocket|undefined,closed=false,failures=0,status:Status|undefined;
  let retry:ReturnType<typeof setTimeout>|undefined,watch:ReturnType<typeof setTimeout>|undefined;
  let heartbeat:ReturnType<typeof setInterval>|undefined,update:ReturnType<typeof setInterval>|undefined;
  function notify(next:Status){
    if(!closed&&status!==next){status=next;cb.onStatus(next);}
  }
  function detach(){
    clearInterval(heartbeat);clearInterval(update);clearTimeout(watch);tape.clearEvents();
    if(socket){
      socket.onmessage=socket.onopen=socket.onerror=socket.onclose=null;
      socket.close();socket=undefined;
    }
  }
  function reconnect(){
    detach();
    if(closed)return;
    notify('retrying');
    retry=setTimeout(connect,Math.min(30000,1000*2**Math.min(failures++,5)));
  }
  function connect(){
    if(closed)return;
    try{socket=openSocket(url);}catch{reconnect();return;}
    const current=socket;
    let connectedAt=0,lastRead=0,dirty=false,lastSecond=0,showing=false,confirmed=false;
    watch=setTimeout(reconnect,10000);
    current.onopen=()=>{
      if(current!==socket)return;
      clearTimeout(watch);lastRead=Date.now();
      try{
        if(!main)current.send(JSON.stringify({op:'subscribe',args:[{channel:'trades-all',instId:spotPair(symbol)}]}));
      }catch{reconnect();return;}
      connectedAt=lastRead;
      heartbeat=setInterval(()=>{
        const idle=Date.now()-lastRead;
        if(idle>26000||idle<0){reconnect();return;}
        if(idle>=9000)try{current.send(main?'{"method":"LIST_SUBSCRIPTIONS","id":1}':'ping');}catch{reconnect();}
      },10000);
      update=setInterval(()=>{
        const now=Date.now(),second=Math.floor(now/1000);
        if(!confirmed||!dirty&&second===lastSecond&&!tape.hasFuture())return;
        dirty=false;lastSecond=second;
        const frame=tape.frame(now,connectedAt);
        if(frame){showing=true;cb.onFrame(frame);}
        else if(showing){showing=false;cb.onQuiet?.();}
      },180);
    };
    current.onmessage=event=>{
      if(current!==socket||typeof event.data!=='string')return;
      const now=Date.now();
      if(!main&&event.data==='pong'){lastRead=now;return;}
      let msg:Record<string,unknown>;
      try{msg=dictionary(JSON.parse(event.data));}catch{return;}
      if(msg.event==='error'||msg.code!==undefined){reconnect();return;}
      if(main&&msg.id===1&&Array.isArray(msg.result)){
        if(!msg.result.includes(stream)){reconnect();return;}
        lastRead=now;return;
      }
      if(!main&&msg.event==='subscribe'&&dictionary(msg.arg).channel==='trades-all'&&dictionary(msg.arg).instId===spotPair(symbol)){
        lastRead=now;return;
      }
      const prints=decodeBattleTrades(symbol,source,msg,now);
      if(!prints.length)return;
      lastRead=now;
      for(const print of prints)if(tape.accept(print,now))dirty=true;
      confirmed=true;failures=0;notify('live');
    };
    current.onerror=current.onclose=()=>{if(socket===current)reconnect();};
  }
  notify('connecting');connect();
  return ()=>{closed=true;clearTimeout(retry);detach();};
}
