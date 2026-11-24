import type { Candle } from './market-types';
import { equityExchangeClock, equityFourHourWindows, equitySessionOn, type SessionWindow } from './equity-calendar.ts';

export interface EquityFourHourOptions {
  market:'cn'|'us';
  sourceInterval:'30m'|'1h';
  timestamp:'start'|'end';
  now?:number;
}
export interface EquityFourHourResult {
  candles:Candle[];
  discardedBuckets:number;
  excludedRows:number;
  missingSessions:number;
}

interface Bucket extends SessionWindow { slots:SessionWindow[]; rows:Map<number,Candle> }
function scheduledBuckets(market:'cn'|'us',date:string,step:number):Bucket[] {
  const session=equitySessionOn(market,date);
  return equityFourHourWindows(market,date).map(window=>{
    const slots:SessionWindow[]=[];
    for(const segment of session.segments){
      const limit=Math.min(segment.end,window.end);
      for(let start=Math.max(segment.start,window.start);start<limit;start+=step){
        slots.push({start,end:Math.min(start+step,limit)});
      }
    }
    return {...window,slots,rows:new Map()};
  });
}

/** Cover the published regular session, including interrupted trading hours and
 * announced early closes. A scheduled session alone never supplies any price. */
export function aggregateEquityFourHour(input:Candle[],options:EquityFourHourOptions):EquityFourHourResult {
  const {market,sourceInterval,timestamp}=options;
  const now=options.now??Date.now()/1000;
  const step=sourceInterval==='1h'?60:30;
  const delay=market==='us'?900:120;
  const unique=[...new Map(input.map(row=>[row.time,row])).values()].sort((a,b)=>a.time-b.time);
  const sessions=new Map<string,{midnight:number;buckets:Bucket[]}>();
  let discardedBuckets=0,excludedRows=0,missingSessions=0;
  for(const row of unique){
    if(![row.time,row.open,row.high,row.low,row.close,row.volume].every(Number.isFinite)||row.time<=0||row.time%60!==0||
      row.low<=0||row.volume<0||row.high<Math.max(row.open,row.close)||row.low>Math.min(row.open,row.close)){
      excludedRows++;continue;
    }
    const clock=equityExchangeClock(market,row.time);
    const session=sessions.get(clock.date)??{midnight:row.time-clock.minute*60,buckets:scheduledBuckets(market,clock.date,step)};
    const bucket=session.buckets.find(b=>b.slots.some(s=>s[timestamp]===clock.minute));
    const index=bucket?.slots.findIndex(slot=>slot[timestamp]===clock.minute);
    if(!bucket||index===undefined||session.midnight+bucket.slots[index].start*60>now){excludedRows++;continue;}
    bucket.rows.set(index,row);
    sessions.set(clock.date,session);
  }
  const candles:Candle[]=[];
  const dates=[...sessions.keys()];
  const first=dates[0],last=dates.at(-1);
  for(const [date,{midnight,buckets}] of sessions){
    for(const bucket of buckets){
      const end=midnight+bucket.end*60;
      const parts=[...bucket.rows.entries()];
      if(!parts.length){
        // No observations beyond the provider's retained range prove coverage
        // there. Only count empty slots between observed source timestamps.
        if((date!==first||buckets.some(b=>b.end<=bucket.start&&b.rows.size))&&
          (date!==last||buckets.some(b=>b.start>=bucket.end&&b.rows.size)))discardedBuckets++;
        continue;
      }
      const complete=parts.length===bucket.slots.length;
      if(!parts.every(([index],i)=>index===i)||(!complete&&now>=end+delay)){discardedBuckets++;continue;}
      const values=parts.map(([,row])=>row);
      candles.push({
        time:midnight+bucket.start*60,open:values[0].open,high:Math.max(...values.map(c=>c.high)),
        low:Math.min(...values.map(c=>c.low)),close:values.at(-1)!.close,
        volume:values.reduce((sum,c)=>sum+c.volume,0),
        closed:complete&&now>=end+delay&&values.every(c=>c.closed===true),
      });
    }
  }
  if(first&&last){
    const dayMs=86400000,end=Date.parse(last);
    for(let day=Date.parse(first)+dayMs;day<end;day+=dayMs){
      const date=new Date(day).toISOString().slice(0,10);
      if(sessions.has(date))continue;
      const count=equityFourHourWindows(market,date).length;
      if(count){missingSessions++;discardedBuckets+=count;}
    }
  }
  return {candles,discardedBuckets,excludedRows,missingSessions};
}
