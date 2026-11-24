import type { Candle, Instrument, Interval, MarketData } from './market-types';
import { COMMODITY_INSTRUMENTS } from './commodity-catalog.ts';
import { yahooFutureContract } from './future-contract.ts';
import { HistoryBoundary,loadYahooHistory,type YahooHistoryWindow } from './history-window.ts';
import { commodityBarEnd, commodityCalendarStart, commoditySessionStart, commodityTradeDate, COMMODITY_DELAY_SECONDS } from './commodity-session.ts';

const intervals:Interval[]=['1m','5m','15m','30m','1h','4h','1d','1w','1M'];
const seconds = {'1m':60,'5m':300,'15m':900,'30m':1800,'1h':3600} as const;
const ranges = {'1m':'5d','5m':'1mo','15m':'1mo','30m':'1mo','1h':'3mo','4h':'1y','1d':'5y'} as const;
const day = 86400;
const nyClock = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'short'});
const nyDate = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
type Quote = {open:unknown[];high:unknown[];low:unknown[];close:unknown[];volume:unknown[]};
type Payload = {chart?:{error?:unknown;result?:{meta?:{symbol?:string;currency?:string;instrumentType?:string;exchangeName?:string;dataGranularity?:string;regularMarketTime?:number};timestamp?:unknown[];indicators?:{quote?:Quote[]}}[]}};
type SourceRow={label:number; bar:Candle};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);

function dailyLabel(sec:number) {
  // Calendar responses can append a single quote stamped at its actual trade
  // time. It must never stand in for a day's or a month's OHLCV.
  const text=nyClock.format(sec*1000);
  return text.includes('00:00:00')&&!text.startsWith('Sat')&&!text.startsWith('Sun');
}
function queryFor(interval:Interval,limit:number,nowSec:number) {
  const calendar=interval==='1w'||interval==='1M';
  const native=calendar?'1d':interval==='4h'||interval==='1h'?'60m':interval;
  const params=new URLSearchParams({interval:native,includePrePost:'true'});
  if(calendar){
    // Explicit dates keep the provider at 1d resolution. range=max may
    // silently downsample to months or quarters, which cannot be reaggregated.
    const days=interval==='1w'?7*(limit+5):32*(limit+2);
    params.set('period1',String(Math.max(0,nowSec-days*day)));
    params.set('period2',String(nowSec+1));
  }else params.set('range',ranges[interval]);
  return {native,params};
}
function merge(rows:Candle[],time:number,end:number,asOf:number):Candle{
  return {time,open:rows[0].open,high:Math.max(...rows.map(c=>c.high)),low:Math.min(...rows.map(c=>c.low)),
    close:rows[rows.length-1].close,volume:rows.reduce((n,c)=>n+c.volume,0),closed:end<=asOf};
}
function hourlyBuckets(rows:SourceRow[],asOf:number) {
  const buckets=new Map<number,Candle[]>();
  for(const {bar} of rows){
    const start=commoditySessionStart(bar.time);
    if(start===null)continue;
    const key=start+Math.floor((bar.time-start)/14400)*14400;
    if(!buckets.has(key))buckets.set(key,[]);
    buckets.get(key)!.push(bar);
  }
  const result:Candle[]=[];
  for(const [key,children] of buckets){
    const end=commodityBarEnd(key,'4h');
    if(children.some((c,i)=>c.time!==key+i*3600))continue;
    // The last bucket of a normal Globex session has three hours. Holidays,
    // missing source hours and a truncated first page never create full bars.
    if(end<=asOf && children.length*3600!==end-key)continue;
    result.push(merge(children,key,end,asOf));
  }
  return result;
}
function calendarBuckets(rows:SourceRow[],interval:'1w'|'1M',asOf:number,missing:Set<number>) {
  const groups=new Map<number,Candle[]>();
  for(const row of rows){
    const key=commodityCalendarStart(row.label,interval);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key)!.push(row.bar);
  }
  const result:Candle[]=[];
  for(const [key,children] of groups){
    const end=commodityBarEnd(key,interval);
    const first=Date.parse(commodityTradeDate(key)+'T00:00:00Z');
    const through=Date.parse(commodityTradeDate(Math.min(asOf,end))+'T00:00:00Z');
    let expected=0;
    for(let ms=first;ms<=through;ms+=day*1000){
      const weekday=new Date(ms).getUTCDay();
      if(weekday!==0&&weekday!==6)expected++;
    }
    // A missing weekday could be a holiday or an upstream gap. Only accept
    // that period if the source also provides the genuine weekly/monthly bar.
    if(children.length<expected)missing.add(key);
    result.push(merge(children,key,end,asOf));
  }
  return result;
}

function readBars(payload:Payload,instrument:Instrument,interval:Interval,native:string,nowSec:number,missing=new Set<number>()) {
  const chart=payload?.chart, data=chart?.result?.[0],meta=data?.meta,q=data?.indicators?.quote?.[0],times=data?.timestamp;
  const venue=instrument.symbol==='CL=F'?'NYM':'CMX';
  if(chart?.error || !meta || meta.symbol!==instrument.symbol || meta.instrumentType!=='FUTURE' || meta.currency!=='USD' || meta.exchangeName!==venue)
    throw new Error('期货行情未通过合约、交易所或计价币种核验。');
  if(meta.dataGranularity!==native&&!(native==='60m'&&meta.dataGranularity==='1h'))
    throw new Error('期货行情返回的周期与请求不符。');
  if(!Array.isArray(times)||!q||![q.open,q.high,q.low,q.close,q.volume].every(Array.isArray))throw new Error('期货行情缺少完整的价格和成交量。');
  const asOf=nowSec-COMMODITY_DELAY_SECONDS;
  const rows=new Map<number,SourceRow>();
  const nativePeriod=native==='1wk'?'1w':native==='1mo'?'1M':null;
  const calendar=native==='1d'||nativePeriod!==null;
  const unit=interval==='4h'?'1h':interval;
  for(let i=0;i<times.length;i++){
    const label=times[i],open=q.open[i],high=q.high[i],low=q.low[i],close=q.close[i],volume=q.volume[i];
    if(!finite(label)||!Number.isSafeInteger(label)||label<=0||label>(nowSec+day)||
      !finite(open)||!finite(high)||!finite(low)||!finite(close)||!finite(volume)||
      low>Math.min(open,close)||high<Math.max(open,close)||volume<0)continue;
    let time=label;
    if(calendar){
      if(nativePeriod){
        const stamp=nyClock.format(label*1000);
        if(!stamp.includes('00:00:00')||(nativePeriod==='1w'?!stamp.startsWith('Mon'):!nyDate.format(label*1000).endsWith('-01')))continue;
      }else if(!dailyLabel(label))continue;
      time=commodityCalendarStart(label,nativePeriod??'1d');
    }else{
      const size=seconds[unit as keyof typeof seconds];
      if(label%size!==0||commoditySessionStart(label)===null)continue;
    }
    if(time>nowSec||rows.has(time))continue;
    if(i===times.length-1 && label===meta.regularMarketTime && volume===0 && open===high && open===low && open===close)continue;
    rows.set(time,{label,bar:{time,open,high,low,close,volume,closed:commodityBarEnd(time,nativePeriod??(calendar?'1d':unit))<=asOf}});
  }
  const ordered=[...rows.values()].sort((a,b)=>a.bar.time-b.bar.time);
  if(nativePeriod)return ordered.map(r=>r.bar);
  return interval==='4h'?hourlyBuckets(ordered,asOf):interval==='1w'||interval==='1M'?calendarBuckets(ordered,interval,asOf,missing):ordered.map(r=>r.bar);
}

async function loadChart(fetcher:typeof fetch,url:URL) {
  const res=await fetcher(url.toString(),{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'},signal:AbortSignal.timeout(10000)});
  if(!res.ok)throw new Error('HTTP '+res.status);
  return await res.json() as Payload;
}

export async function getCommodityCandles(symbol:string,interval:Interval,limit=800,fetcher:typeof fetch=fetch,nowMs=Date.now(),history?:YahooHistoryWindow):Promise<MarketData> {
  const instrument=COMMODITY_INSTRUMENTS.find(i=>i.symbol===symbol);
  if(!instrument||!intervals.includes(interval))throw new Error('暂未接入此期货合约或周期。');
  const count=Math.max(1,Math.min(1000,Number.isFinite(limit)?Math.floor(limit):800));
  const nowSec=Math.floor(nowMs/1000),{native,params}=queryFor(interval,count,nowSec);
  if(history){
    params.delete('range');
    params.set('period1',String(history.start));
    params.set('period2',String(history.end));
  }
  let failure:unknown;
  for(const host of history?[history.host]:['query1.finance.yahoo.com','query2.finance.yahoo.com']){
    try{
      const url=new URL('https://'+host+'/v8/finance/chart/'+encodeURIComponent(symbol)+'?'+params);
      const gaps=new Set<number>();
      const payload=history?await loadYahooHistory<Payload>(url,history,symbol,fetcher):await loadChart(fetcher,url);
      let raw=readBars(payload,instrument,interval,native,nowSec,gaps);
      let incomplete=false;
      if((interval==='1w'||interval==='1M')&&gaps.size){
        const period=interval==='1w'?'1wk':'1mo';
        url.searchParams.set('interval',period);
        let verified:Candle[]=[];
        try{verified=readBars(await loadChart(fetcher,url),instrument,interval,period,nowSec);}
        catch(error){if(history)throw error;/* Complete daily groups remain usable on the latest chart. */}
        const complete=new Map(verified.map(bar=>[bar.time,bar]));
        for(const bar of raw){
          if(!gaps.has(bar.time))complete.set(bar.time,bar);
          else if(!complete.has(bar.time))incomplete=true;
        }
        raw=[...complete.values()].sort((a,b)=>a.time-b.time);
      }
      const candles=(history?raw.filter(c=>c.time>=history.start&&c.time<history.end&&c.closed&&commodityBarEnd(c.time,interval)<=history.end):raw).slice(-count);
      if(!candles.length)throw new Error('该合约暂无此周期的有效K线。');
      const contract=yahooFutureContract(symbol,payload.chart?.result?.[0]?.meta);
      return {instrument:contract?{...instrument,contract}:instrument,interval,candles,asOf:new Date(nowMs).toISOString(),source:'Yahoo Finance 期货行情 · '+host,
        adjustment:'来源原始OHLC；换月衔接口径未核验',delayNotice:'公开期货行情可能延迟 · 芝加哥交易时段 · 换月可能产生跳空',
        warnings:[...(candles.some(c=>c.low<=0)?['历史含非正油价，结构分析从最近一次非正价格之后开始。']:[]),
          ...(incomplete?['部分周期缺少来源交易日，亦无同期原生K线，已跳过。']:[])],
        availableIntervals:intervals.slice()};
    }catch(error){if(error instanceof HistoryBoundary)throw error;failure=error;}
  }
  throw new Error('未能取得该合约的期货行情：'+(failure instanceof Error?failure.message:'数据源不可用'));
}
