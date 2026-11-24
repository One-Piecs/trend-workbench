import type { Interval } from './market-types';
import type { QuoteOhlcv, SourceQuote } from './quote-overlay.ts';
import { quotePeriodBounds } from './quote-overlay.ts';
import { commodityTradeDate } from './commodity-session.ts';
import { equityExchangeClock, equitySessionOn } from './equity-calendar.ts';
import { yahooFutureContract } from './future-contract.ts';

type Market = 'us'|'commodity';
type Status = 'unconfigured'|'unavailable'|'delayed'|'stale'|'unverified'|'denied';
type Quote = SourceQuote & {quality:'observed'|'realtime'};
type Result = {status:Status}|{status:'quote';quote:Quote};
type Fields = Record<string,unknown>;
type Options = {fetcher?:typeof fetch;nowMs?:number;contract?:string;env?:Record<string,string|undefined>};
type Timed = QuoteOhlcv & {time:number};
type Bounds = {start:number;end:number};
const object=(value:unknown):Fields=>value && typeof value==='object' && !Array.isArray(value)?value as Fields:{};
const rows=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
const finite=(v:unknown):v is number=>typeof v==='number' && Number.isFinite(v);
const calendar=(interval:Interval)=>interval==='1d'||interval==='1w'||interval==='1M';
const sec=(t:unknown)=> typeof t==='string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(t)?Math.floor(Date.parse(t)/1000):NaN;
const tradeDate=(market:Market,t:number)=>market==='us'?equityExchangeClock('us',t).date:commodityTradeDate(t);

function readPrices(r:Fields,signed:boolean):QuoteOhlcv|undefined {
  const {open,high,low,close,volume}=r;
  if(!finite(open)||!finite(high)||!finite(low)||!finite(close)||!finite(volume)||!Number.isSafeInteger(volume)
    ||volume<=0||(!signed&&low<=0)||low>Math.min(open,close)||high<Math.max(open,close))return;
  return {open,high,low,close,volume};
}

function fold(bars:QuoteOhlcv[]):QuoteOhlcv {
  return {open:bars[0].open,high:Math.max(...bars.map(b=>b.high)),low:Math.min(...bars.map(b=>b.low)),
    close:bars[bars.length-1].close,volume:bars.reduce((n,b)=>n+b.volume,0)};
}

// Use complete source minute bars from the selected bucket; a last trade alone
// cannot reconstruct the candle's earlier high, low, open or volume.
function fromMinutes(bars:Timed[],bounds:Bounds,time:number,price:number) {
  const last=time-time%60;
  const selected=bars.filter(b=>b.time>=bounds.start && b.time<=last).sort((a,b)=>a.time-b.time);
  if(selected.length!==(last-bounds.start)/60+1||selected.some((b,i)=>b.time!==bounds.start+i*60)
    ||selected.at(-1)?.close!==price)return;
  return fold(selected);
}

function fromDays(days:Map<string,QuoteOhlcv>,market:Market,bounds:Bounds,time:number,price:number) {
  const first=tradeDate(market,bounds.start), last=tradeDate(market,time);
  const ordered:QuoteOhlcv[]=[];
  for(let d=Date.parse(first+'T00:00:00Z');d<=Date.parse(last+'T00:00:00Z');d+=86400000){
    const date=new Date(d), key=date.toISOString().slice(0,10);
    if(market==='us'){
      const session=equitySessionOn('us',key);
      if(session.status==='unknown')return;
      if(session.status==='closed')continue;
    }else if(date.getUTCDay()===0||date.getUTCDay()===6)continue;
    const bar=days.get(key);
    if(!bar)return; // Holidays without a source bar are not fabricated.
    ordered.push(bar);
  }
  return ordered.length && ordered.at(-1)?.close===price?fold(ordered):undefined;
}

class SourceFailure extends Error {
  status:Status;
  constructor(status:Status){super(status);this.status=status;}
}

async function json(fetcher:typeof fetch,url:URL,init:RequestInit={}):Promise<Fields> {
  const r=await fetcher(url.toString(),{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(3500),...init});
  if(!r.ok)throw new SourceFailure(r.status===401||r.status===403?'denied':'unavailable');
  return object(await r.json());
}

function confirm(market:Market,time:unknown,price:unknown,nowMs:number,signed:boolean){
  if(!finite(time)||!Number.isSafeInteger(time)||!finite(price)||(!signed&&price<=0))throw new SourceFailure('unverified');
  if(time>nowMs/1000+2||time<nowMs/1000-60||!quotePeriodBounds(market,'1d',time)
    ||!quotePeriodBounds(market,'1d',Math.floor(nowMs/1000)))throw new SourceFailure('stale');
  return {time,price};
}

async function yahooChart(fetcher:typeof fetch,symbol:string,unit:'1m'|'1d',range:string) {
  const url=new URL('https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(symbol));
  url.search=new URLSearchParams({interval:unit,range,includePrePost:'false'}).toString();
  const body=await json(fetcher,url,{headers:{'User-Agent':'Mozilla/5.0',Accept:'application/json'}});
  const chart=object(body.chart);
  if(chart.error)throw new SourceFailure('unavailable');
  return object(rows(chart.result)[0]);
}

async function publicStock(symbol:string,interval:Interval,fetcher:typeof fetch,nowMs:number):Promise<Quote>{
  const name=symbol.replace('.','-'), daily=calendar(interval), unit=daily?'1d':'1m';
  const chart=await yahooChart(fetcher,name,unit,daily?'3mo':'1d'), m=object(chart.meta);
  const instrumentType=String(m.instrumentType);
  if(m.symbol!==name||!(symbol.startsWith('^')?instrumentType==='INDEX':['EQUITY','ETF'].includes(instrumentType))||m.currency!=='USD'||
    m.exchangeTimezoneName!=='America/New_York'||m.dataGranularity!==unit)throw new SourceFailure('unverified');
  if(finite(m.exchangeDataDelayedBy)&&m.exchangeDataDelayedBy>0)throw new SourceFailure('delayed');
  const {time,price}=confirm('us',m.regularMarketTime,m.regularMarketPrice,nowMs,false);
  const quote:Quote={market:'us',symbol,currency:'USD',time,price,venue:'Yahoo Finance',provider:'yahoo',quality:'observed'};
  const bounds=quotePeriodBounds('us',interval,time);
  if(!bounds)return quote;
  const series=object(rows(object(chart.indicators).quote)[0]), timestamps=rows(chart.timestamp);
  const bars:Timed[]=[],days=new Map<string,QuoteOhlcv>();
  for(let i=0;i<timestamps.length;i++){
    const t=timestamps[i];
    if(!finite(t)||!Number.isSafeInteger(t)||t>time||(!daily&&t%60!==0))continue;
    const bar=readPrices(Object.fromEntries(['open','high','low','close','volume'].map(k=>[k,rows(series[k])[i]])),false);
    if(!bar)continue;
    if(daily)days.set(tradeDate('us',t),bar);
    else bars.push({...bar,time:t});
  }
  const native=daily?fromDays(days,'us',bounds,time,price):fromMinutes(bars,bounds,time,price);
  if(native)quote.bar={...native,...bounds,interval};
  const sessionBar=days.get(tradeDate('us',time));
  if(sessionBar?.close===price)quote.sessionBar=sessionBar;
  return quote;
}

async function barchart(fetcher:typeof fetch,api:'getQuote'|'getHistory',key:string,params:Record<string,string>) {
  // The vendor accepts a form POST. Keys are never put in URLs or surfaced in errors.
  const body=await json(fetcher,new URL('https://ondemand.websol.barchart.com/'+api+'.json'),{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,apikey:key}).toString(),
  });
  const code=object(body.status).code;
  if(code!==200)throw new SourceFailure(code===401||code===403?'denied':'unavailable');
  return rows(body.results).map(object);
}

async function barchartQuote(market:Market,symbol:string,interval:Interval,options:Options,fetcher:typeof fetch,nowMs:number,key:string):Promise<Quote> {
  let contract:string|undefined;
  if(market==='commodity'){
    contract=options.contract??yahooFutureContract(symbol,(await yahooChart(fetcher,symbol,'1d','5d')).meta);
    if(!contract||!new RegExp('^'+symbol.slice(0,2)+'[FGHJKMNQUVXZ]\\d{2}$').test(contract))throw new SourceFailure('unverified');
  }
  const instrument=contract??symbol, signed=symbol==='CL=F';
  const [r]=await barchart(fetcher,'getQuote',key,{symbols:instrument,fields:'tradeDate'});
  if(!r||r.symbol!==instrument)throw new SourceFailure('unverified');
  if(r.mode!=='R')throw new SourceFailure(r.mode==='I'||r.mode==='D'?'delayed':'unverified');
  const {price,time}=confirm(market,sec(r.tradeTimestamp),r.lastPrice,nowMs,signed);
  const date=tradeDate(market,time);
  if(r.tradeDate && r.tradeDate!==date)throw new SourceFailure('unverified');
  const sessionBar=readPrices({...r,close:price},signed);
  const quote:Quote={market,symbol,currency:'USD',price,time,quality:'realtime',venue:contract?(symbol==='CL=F'?'NYMEX':'COMEX'):'Barchart US',
    provider:'barchart',...(contract&&{contract}),...(sessionBar&&{sessionBar})};
  const bounds=quotePeriodBounds(market,interval,time);
  if(!bounds)return quote;
  if(interval==='1d'){
    if(sessionBar)quote.bar={...sessionBar,...bounds,interval};
    return quote;
  }
  try{
    const daily=calendar(interval);
    const params:Record<string,string>={symbol:instrument,type:daily?'daily':'minutes',order:'desc',splits:'false',dividends:'false',
      startDate:tradeDate(market,bounds.start).replaceAll('-',''),maxRecords:daily?'35':String(Math.floor((time-bounds.start)/60)+3)};
    if(!daily)params.interval='1';
    const history=await barchart(fetcher,'getHistory',key,params);
    const bars:Timed[]=[],days=new Map<string,QuoteOhlcv>();
    for(const row of history){
      if(row.symbol!==instrument)continue;
      const bar=readPrices(row,signed);
      if(!bar||typeof row.tradingDay!=='string')continue;
      if(daily){days.set(row.tradingDay,bar);continue;}
      const timestamp=sec(row.timestamp);
      if(row.tradingDay===date&&Number.isSafeInteger(timestamp)&&timestamp%60===0)bars.push({...bar,time:timestamp});
    }
    if(daily&&sessionBar)days.set(date,sessionBar);
    const native=daily?fromDays(days,market,bounds,time,price):fromMinutes(bars,bounds,time,price);
    if(native)quote.bar={...native,...bounds,interval};
  }catch{/* A bar-history entitlement is independent of the live quote entitlement. */}
  return quote;
}

async function alpaca(symbol:string,fetcher:typeof fetch,nowMs:number,env:Record<string,string|undefined>):Promise<Quote>{
  const feed=env.APCA_DATA_FEED||'iex';
  if(feed!=='sip'&&feed!=='iex')throw new SourceFailure('unverified');
  const instrument=symbol.replace('-','.'), url=new URL('https://data.alpaca.markets/v2/stocks/trades/latest');
  url.search=new URLSearchParams({symbols:instrument,feed}).toString();
  const r=await json(fetcher,url,{headers:{'APCA-API-KEY-ID':env.APCA_API_KEY_ID!,'APCA-API-SECRET-KEY':env.APCA_API_SECRET_KEY!}});
  const trade=object(object(r.trades)[instrument]);
  const {time,price}=confirm('us',sec(trade.t),trade.p,nowMs,false);
  return {market:'us',symbol,currency:'USD',provider:'alpaca',quality:'realtime',venue:feed==='iex'?'IEX':'US SIP',time,price};
}

/** Server-side only. Receipt time cannot establish exchange real-time entitlement. */
export async function getLicensedLiveQuote(market:Market,symbol:string,interval:Interval,options:Options={}):Promise<Result> {
  if(market==='commodity'?!['GC=F','SI=F','CL=F'].includes(symbol):market!=='us'||!(/^(?:\^[A-Z][A-Z0-9-]{0,14}|[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z]{1,2})?)$/).test(symbol))return {status:'unverified'};
  const env=options.env??process.env, nowMs=options.nowMs??Date.now(), fetcher=options.fetcher??fetch;
  const sources:(()=>Promise<Quote>)[]=[];
  if(env.BARCHART_API_KEY&&!symbol.startsWith('^'))sources.push(()=>barchartQuote(market,symbol,interval,options,fetcher,nowMs,env.BARCHART_API_KEY!));
  if(market==='us'){
    if(!symbol.startsWith('^')&&env.APCA_API_KEY_ID && env.APCA_API_SECRET_KEY)sources.push(()=>alpaca(symbol,fetcher,nowMs,env));
    sources.push(()=>publicStock(symbol,interval,fetcher,nowMs));
  }
  let failure:Status='unconfigured';
  for(const getQuote of sources){
    try{return {status:'quote',quote:await getQuote()};}
    catch(e){failure=e instanceof SourceFailure?e.status:'unavailable';}
  }
  return {status:failure};
}
