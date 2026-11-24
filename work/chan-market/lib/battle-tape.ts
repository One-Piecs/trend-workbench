/** Public spot snapshots only. Amounts are quote-currency notionals; no positions are inferred. */
import {battleDeployments} from './battle-deployment.ts';
type Venue='Binance'|'OKX';
type Side='buy'|'sell';
export interface BattleTradeEvent { id:string; time:number; side:Side; notional:number }
export interface BattlePrintPrice { id:string; time:number; price:number }
// Match IDs are venue-local decimal strings and can exceed Number.MAX_SAFE_INTEGER.
function compareIds(left:string,right:string){
  const a=BigInt(left),b=BigInt(right);
  return a>b?1:a<b?-1:0;
}
export function compareTradeOrder(left:{time:number;id:string},right:{time:number;id:string}){
  return left.time-right.time||compareIds(left.id.slice(left.id.lastIndexOf('/')+1),right.id.slice(right.id.lastIndexOf('/')+1));
}
interface Trade {id:string; ms:number; price:number; amount:number; side:Side}
interface Bucket {start:number;buy:number;sell:number}
export interface BattleFlow {
  buy:number;sell:number;count:number;firstTime:number;lastTime:number;windowSeconds:60;limited:boolean;
  buckets:Bucket[];largest:{time:number;side:Side;amount:number;price:number};
  recentTrades?:BattleTradeEvent[];
}
export interface BattleBook {
  bid:number;ask:number;bestBid:number;bestAsk:number;bids:number;asks:number;bandBps:25;limited:boolean;observedAt:number;
}
export interface BattleSnapshot {
  symbol:string;currency:'USDT';source:Venue;asOf:number;flow:BattleFlow|null;book:BattleBook|null;
  lastTrade?:BattlePrintPrice|null;
}
const depthLimit=100;
const venues:Venue[]=['Binance','OKX'];
const object=(x:unknown):Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:{};
function positive(x:unknown):number {
  if(typeof x!=='string'||!/^\d+(?:\.\d+)?$/.test(x))return NaN;
  const n=Number(x);
  return Number.isFinite(n)&&n>0?n:NaN;
}
function dataRows(raw:unknown):unknown[]|null {
  const body=object(raw);
  return body.code==='0'&&Array.isArray(body.data)?body.data:null;
}
function pairId(symbol:string){return symbol.slice(0,-4)+'-USDT';}

function recentPrints(trades:Trade[],key:string,end:number):BattleTradeEvent[] {
  const fresh=trades.filter(t=>t.ms>=(end-12)*1000);
  const top=fresh.filter(t=>t.amount>=battleDeployments[1].min).sort((a,b)=>b.amount-a.amount).slice(0,6);
  const chosen=new Set(top);
  for(const side of ['buy','sell'] as const){
    const last=fresh.findLast(t=>t.side===side);
    if(last)chosen.add(last);
  }
  for(let i=fresh.length-1;i>=0&&chosen.size<24;i--)chosen.add(fresh[i]);
  const sample=fresh.filter(t=>chosen.has(t));
  return sample.map(t=>({id:key+'/'+t.id,time:t.ms/1000,side:t.side,notional:t.amount}));
}

interface TradeTail {trades:Trade[];knownFrom:number}
function readFlow(raw:unknown,venue:Venue,symbol:string,asOfMs:number,limit:number,tails:Map<string,TradeTail>):{flow:BattleFlow|null;lastTrade:BattlePrintPrice|null}|null {
  const rows=venue==='Binance'?raw:dataRows(raw);
  if(!Array.isArray(rows)||!rows.length||rows.length>limit)return null;
  let trades:Trade[]=[];
  const ids=new Set<string>();
  const end=Math.floor(asOfMs/1000),start=end-60;
  for(const row of rows){
    const r=object(row);
    let trade:Trade;
    if(venue==='Binance'){
      if(typeof r.isBuyerMaker!=='boolean'||typeof r.id!=='number'||!Number.isSafeInteger(r.id)||r.id<0||
        typeof r.time!=='number'||!Number.isFinite(positive(r.qty)))return null;
      trade={id:String(r.id),ms:r.time,price:positive(r.price),amount:positive(r.quoteQty),side:r.isBuyerMaker?'sell':'buy'};
    }else{
      if(r.instId!==pairId(symbol)||(r.side!=='buy'&&r.side!=='sell')||typeof r.tradeId!=='string'||!/^\d{1,32}$/.test(r.tradeId)||
        typeof r.ts!=='string'||!/^\d+$/.test(r.ts))return null;
      const price=positive(r.px);
      trade={id:r.tradeId,ms:Number(r.ts),price,amount:price*positive(r.sz),side:r.side};
    }
    if(!Number.isSafeInteger(trade.ms)||trade.ms<=0||trade.ms>asOfMs+1500||!Number.isFinite(trade.price)||
      !Number.isFinite(trade.amount)||trade.amount<=0||ids.has(trade.id))return null;
    ids.add(trade.id);
    trades.push(trade);
  }
  const chronological=(a:Trade,b:Trade)=>a.ms-b.ms||compareIds(a.id,b.id);
  trades.sort(chronological);
  const key=venue+'/'+symbol,tail=tails.get(key);
  if(tail&&tail.trades.at(-1)!.ms<=asOfMs&&trades.at(-1)!.ms<tail.trades.at(-1)!.ms)return null;
  let knownFrom=trades.length===limit?trades[0].ms:0;
  // Extend the observed minute only across an actual common trade. Polling
  // across a disconnect must not silently bridge missing prints.
  if(tail&&tail.trades.at(-1)!.ms>=start*1000&&tail.trades.at(-1)!.ms<=trades.at(-1)!.ms){
    const previous=new Map(tail.trades.map(t=>[t.id,t]));
    const overlap=trades.filter(t=>previous.has(t.id));
    if(overlap.length&&overlap.every(t=>{
      const old=previous.get(t.id)!;
      return old.ms===t.ms&&old.side===t.side&&old.price===t.price&&old.amount===t.amount;
    })){
      knownFrom=Math.min(knownFrom,tail.knownFrom);
      for(const t of trades)previous.set(t.id,t);
      trades=[...previous.values()].sort(chronological);
    }
  }
  trades=trades.filter(t=>t.ms>=start*1000);
  if(!trades.length)return null;
  if(trades.length>12000){
    trades=trades.slice(-12000);
    knownFrom=Math.max(knownFrom,trades[0].ms);
  }
  if(tails.size>=16&&!tails.has(key))tails.delete(tails.keys().next().value!);
  tails.delete(key);
  tails.set(key,{trades,knownFrom});
  const latest=trades.findLast(t=>t.ms<=asOfMs);
  const lastTrade=latest?{id:latest.id,time:latest.ms/1000,price:latest.price}:null;
  const observed=trades.filter(t=>t.ms>=start*1000&&t.ms<end*1000);
  if(!observed.length)return {flow:null,lastTrade};
  const buckets=Array.from({length:6},(_,i)=>({start:start+i*10,buy:0,sell:0}));
  let buy=0,sell=0,largest=observed[0];
  for(const t of observed){
    if(t.side==='buy')buy+=t.amount;else sell+=t.amount;
    const index=Math.floor((t.ms/1000-start)/10);
    buckets[index][t.side]+=t.amount;
    if(t.amount>largest.amount)largest=t;
  }
  if(!Number.isFinite(buy+sell))return null;
  return {lastTrade,flow:{buy,sell,count:observed.length,firstTime:observed[0].ms/1000,lastTime:observed.at(-1)!.ms/1000,
    windowSeconds:60,limited:knownFrom>=start*1000,buckets,recentTrades:recentPrints(observed,key,end),
    largest:{time:largest.ms/1000,side:largest.side,amount:largest.amount,price:largest.price}}};
}

function levels(raw:unknown,buy:boolean,maxLevels:number) {
  if(!Array.isArray(raw)||!raw.length||raw.length>maxLevels)return null;
  const list:{price:number;size:number}[]=[];
  for(const row of raw){
    if(!Array.isArray(row))return null;
    const price=positive(row[0]),size=positive(row[1]),prior=list.at(-1);
    if(!Number.isFinite(price*size)||prior&&(buy?prior.price<=price:prior.price>=price))return null;
    list.push({price,size});
  }
  return list;
}
export function readBattleBook(raw:unknown,venue:Venue,dateMs:number,nowMs:number,maxLevels=depthLimit):BattleBook|null {
  const packet=venue==='OKX'?dataRows(raw):null;
  const book=venue==='Binance'?object(raw):object(packet?.length===1?packet[0]:null);
  if(venue==='Binance'&&(!Number.isSafeInteger(book.lastUpdateId)||Number(book.lastUpdateId)<=0))return null;
  // The public depth snapshot has an HTTP observation time on one feed and a matching-engine time on the other.
  const ms=venue==='Binance'?dateMs:Number(book.ts);
  if(!Number.isFinite(ms)||ms<nowMs-15000||ms>nowMs+1500)return null;
  const bids=levels(book.bids,true,maxLevels),asks=levels(book.asks,false,maxLevels);
  if(!bids||!asks||bids[0].price>=asks[0].price)return null;
  const bestBid=bids[0].price,bestAsk=asks[0].price,mid=(bestBid+bestAsk)/2;
  const lower=mid*(1-.0025),upper=mid*(1+.0025);
  const buy=bids.filter(l=>l.price>=lower),sell=asks.filter(l=>l.price<=upper);
  if(!buy.length||!sell.length)return null;
  const bid=buy.reduce((n,l)=>n+l.price*l.size,0),ask=sell.reduce((n,l)=>n+l.price*l.size,0);
  if(!Number.isFinite(bid+ask))return null;
  const limited=bids.length===maxLevels&&bids.at(-1)!.price>lower||asks.length===maxLevels&&asks.at(-1)!.price<upper;
  return {bid,ask,bids:buy.length,asks:sell.length,bestBid,bestAsk,bandBps:25,limited,observedAt:ms/1000};
}

export function createBattleReader(fetcher:typeof fetch=fetch,now=Date.now) {
  const pending=new Map<string,Promise<BattleSnapshot>>();
  const recent=new Map<string,BattleSnapshot>();
  const cooldowns=new Map<Venue,number>();
  const tails=new Map<string,TradeTail>();
  async function request(venue:Venue,url:string){
    try{
      const res=await fetcher(url,{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(3500),headers:{Accept:'application/json'}});
      if(res.status===429||res.status===418){
        const retry=res.headers.get('retry-after');
        const until=retry&&/^\d+$/.test(retry)?now()+Number(retry)*1000:Date.parse(retry??'');
        cooldowns.set(venue,Number.isFinite(until)&&until>now()?until:now()+60000);
      }
      if(!res.ok)return null;
      return {raw:await res.json() as unknown,dateMs:Date.parse(res.headers.get('date')??'')};
    }catch{return null;}
  }
  async function venueSnapshot(venue:Venue,symbol:string):Promise<BattleSnapshot> {
    const limit=venue==='Binance'?1000:500;
    const urls=venue==='Binance'?[
      'https://data-api.binance.vision/api/v3/trades?symbol='+symbol+'&limit='+limit,
      'https://data-api.binance.vision/api/v3/depth?symbol='+symbol+'&limit='+depthLimit,
    ]:[
      'https://www.okx.com/api/v5/market/trades?instId='+pairId(symbol)+'&limit='+limit,
      'https://www.okx.com/api/v5/market/books?instId='+pairId(symbol)+'&sz='+depthLimit,
    ];
    const [trades,depth]=await Promise.all(urls.map(url=>request(venue,url)));
    const ms=now();
    const fresh=trades&&(!Number.isFinite(trades.dateMs)||(trades.dateMs>=ms-15000&&trades.dateMs<=ms+1500));
    const tape=fresh?readFlow(trades.raw,venue,symbol,ms,limit,tails):null;
    const book=depth?readBattleBook(depth.raw,venue,depth.dateMs,ms):null;
    return {symbol,currency:'USDT',source:venue,asOf:ms/1000,flow:tape?.flow??null,lastTrade:tape?.lastTrade??null,book};
  }
  async function read(symbol:string,selected?:Venue) {
    let partial:BattleSnapshot|undefined;
    for(const venue of selected?[selected]:venues){
      if((cooldowns.get(venue)??0)>now())continue;
      const snap=await venueSnapshot(venue,symbol);
      if(snap.flow&&snap.book)return snap;
      if(!partial&&(snap.lastTrade||snap.book)||snap.flow&&!partial?.flow)partial=snap;
    }
    if(partial)return partial;
    throw new Error('暂未取得此交易对的现货成交或盘口数据。');
  }
  return async function load(params:URLSearchParams):Promise<BattleSnapshot>{
    const symbol=(params.get('symbol')??'').toUpperCase();
    if(!/^[A-Z0-9]{1,22}USDT$/.test(symbol)||params.has('market')&&params.get('market')!=='crypto')
      throw new RangeError('请选择以 USDT 计价的加密现货交易对。');
    const requested=params.get('venue');
    const selected=venues.find(v=>v===requested);
    if(requested&&!selected)throw new RangeError('无效的现货来源。');
    const key=(selected??'auto')+'/'+symbol;
    const cached=recent.get(key);
    if(cached&&cached.asOf<=now()/1000&&now()/1000-cached.asOf<3)return cached;
    const existing=pending.get(key);
    if(existing)return existing;
    const task=read(symbol,selected).then(snap=>{
      if(recent.size>=64)recent.delete(recent.keys().next().value!);
      recent.set(key,snap);
      return snap;
    }).finally(()=>pending.delete(key));
    pending.set(key,task);
    return task;
  };
}
export const getBattleTape=createBattleReader();
