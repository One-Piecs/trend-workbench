import type {Candle} from './market-types.ts';
import {equityCalendarCoverage,equityFourHourWindows} from './equity-calendar.ts';
import {exchangeClock} from './timeframe-context.ts';

export interface FourHourGap {
  date:string;
  start:number;
  end:number;
  present:boolean;
}

/** Check only due slots at or after the first loaded bar. A truncated history
 * may start in the afternoon, and an open slot has not yet become due. */
export function auditFourHourCoverage(market:'cn'|'us',candles:readonly Candle[],asOf:number) {
  if(!Number.isFinite(asOf)||!candles.length)return null;
  const bars=candles.filter(c=>Number.isFinite(c.time)&&c.time<=asOf);
  if(!bars.length)return null;
  const calendar=equityCalendarCoverage(market);
  const now=exchangeClock(asOf,market);
  const first=exchangeClock(bars[0].time,market);
  const start=first.date<calendar.start?calendar.start:first.date;
  const end=now.date>calendar.end?calendar.end:now.date;
  if(start>end)return null;
  const byDate=new Map<string,Map<number,boolean>>();
  for(const bar of bars){
    if(bar.time%60!==0)continue;
    const {date,minute}=exchangeClock(bar.time,market);
    if(!byDate.has(date))byDate.set(date,new Map());
    byDate.get(date)!.set(minute,bar.closed===true);
  }
  const gaps:FourHourGap[]=[];
  let completed=0;
  const delay=market==='us'?15:2;
  const lastDay=Date.parse(end+'T00:00:00Z');
  for(let time=Date.parse(start+'T00:00:00Z');time<=lastDay;time+=86400000){
    const date=new Date(time).toISOString().slice(0,10);
    for(const slot of equityFourHourWindows(market,date)){
      if(date===first.date&&slot.start<first.minute)continue;
      if(date===now.date&&slot.end+delay>now.minute)continue;
      const present=byDate.get(date)?.get(slot.start);
      if(present===true)completed++;
      else gaps.push({date,start:slot.start,end:slot.end,present:present===false});
    }
  }
  return {start,end,partial:start!==first.date||end!==now.date,completed,expected:completed+gaps.length,gaps};
}
