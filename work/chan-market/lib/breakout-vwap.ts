import {priorCenterCrossing} from './breakout-observation.ts';
import {equityExchangeClock,equityFourHourWindows,equitySessionOn} from './equity-calendar.ts';
import {candleAvailableAt} from './timeframe-context.ts';
import {consecutiveCommodityBars} from './commodity-session.ts';
import {positiveRunStart} from './commodity-analysis.ts';
import type {Candle,Interval,Market} from './market-types.ts';

const dayMs=86400000;
const minutes={'1m':1,'5m':5,'15m':15,'30m':30,'1h':60} as const;
type EquityMarket='cn'|'hk'|'us';
type Breakout=NonNullable<ReturnType<typeof priorCenterCrossing>>;
export type VwapResult=
  |{status:'ready';anchor:number;crossing:Breakout;points:{index:number;value:number}[]}
  |{status:'no-anchor'|'incomplete'|'no-volume'};

function closedBetween(market:EquityMarket,fromMs:number,toMs:number) {
  for(let ms=fromMs;ms<toMs;ms+=dayMs) {
    if(equitySessionOn(market,new Date(ms).toISOString().slice(0,10)).status!=='closed')return false;
  }
  return true;
}

function periodStart(date:string,period:'1w'|'1M') {
  const d=new Date(date+'T00:00:00Z');
  if(period==='1M')d.setUTCDate(1);
  else d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);
  return d;
}

/** The two labels must cover neighbouring trading bars. Exchange-local
 * slots handle early closes, lunch, DST and start-/end-labelled feeds. */
export function breakoutBarContinuity(market:Market,interval:Interval,source:string) {
  if(market==='commodity')return (a:Candle,b:Candle)=>consecutiveCommodityBars(a.time,b.time,interval);
  if(market==='crypto')return (a:Candle,b:Candle)=>candleAvailableAt(a,market,interval)===b.time;
  const slotCache=new Map<string,number[]>();
  function slots(date:string) {
    const known=slotCache.get(date);
    if(known)return known;
    const times:number[]=[];
    if(interval==='4h')times.push(...equityFourHourWindows(market as EquityMarket,date).map(w=>w.start));
    else {
      const size=minutes[interval as keyof typeof minutes];
      const endLabel=(market==='cn'&&!/Longbridge/i.test(source))||/东方财富|Eastmoney|周期结束/i.test(source);
      for(const segment of equitySessionOn(market as EquityMarket,date).segments){
        for(let m=segment.start;m<segment.end;m+=size)times.push(endLabel?Math.min(m+size,segment.end):m);
      }
    }
    slotCache.set(date,times);
    return times;
  }
  return (a:Candle,b:Candle)=>{
    if(!(b.time>a.time))return false;
    const p=equityExchangeClock(market,a.time),q=equityExchangeClock(market,b.time);
    if(!p.date||!q.date)return false;
    if(interval==='1M'||interval==='1w'){
      const before=periodStart(p.date,interval),after=periodStart(q.date,interval);
      if(after<=before)return false;
      if(interval==='1M')before.setUTCMonth(before.getUTCMonth()+1);
      else before.setUTCDate(before.getUTCDate()+7);
      return closedBetween(market,before.getTime(),after.getTime());
    }
    if(interval==='1d'){
      return p.date<q.date&&equitySessionOn(market,p.date).status==='open'&&equitySessionOn(market,q.date).status==='open'
        &&closedBetween(market,Date.parse(p.date)+dayMs,Date.parse(q.date));
    }
    const prior=slots(p.date),next=slots(q.date);
    const left=prior.indexOf(p.minute),right=next.indexOf(q.minute);
    if(left<0||right<0)return false;
    if(p.date===q.date)return right===left+1;
    return left===prior.length-1&&right===0&&closedBetween(market,Date.parse(p.date)+dayMs,Date.parse(q.date));
  };
}

export function weightedBreakoutLine(bars:Candle[],anchor:number,end:number,crossing:Breakout):VwapResult {
  let volume=0,average=0;
  const points:{index:number;value:number}[]=[];
  for(let i=anchor;i<end;i++){
    const bar=bars[i];
    if(!Number.isFinite(bar.volume)||bar.volume<0||bar.closed!==true)return {status:'incomplete'};
    // Some feeds encode missing size as zero. A range with price movement
    // and no reported trades cannot establish a volume-weighted price.
    if(bar.volume===0&&bar.high!==bar.low)return {status:'no-volume'};
    if(bar.volume>0){
      const typical=(bar.high+bar.low+bar.close)/3;
      volume+=bar.volume;
      average+=(typical-average)*(bar.volume/volume);
      if(!Number.isFinite(average)||!Number.isFinite(volume))return {status:'incomplete'};
    }
    if(volume>0)points.push({index:i,value:average});
  }
  return points.length?{status:'ready',anchor,crossing,points}:{status:'no-volume'};
}

/** Scan the entire loaded prefix from newest to oldest, yielding once per
 * candidate so a large imported chart can't block pointer or replay events. */
export function* breakoutVwap(bars:Candle[],market:Market,interval:Interval,source:string,end=bars.length):Generator<void,VwapResult> {
  while(end>0&&bars[end-1].closed!==true)end--;
  const start=market==='commodity'?positiveRunStart(bars.slice(0,end),market):0;
  const adjacent=breakoutBarContinuity(market,interval,source);
  for(let i=end-1;i>=start+2;i--){
    const prev=bars[i-1],bar=bars[i];
    if(prev.closed!==true||!adjacent(prev,bar))return {status:'incomplete'};
    const crossing=priorCenterCrossing(bars,i,start);
    if(crossing)return weightedBreakoutLine(bars,i,end,crossing);
    yield;
  }
  return {status:'no-anchor'};
}
