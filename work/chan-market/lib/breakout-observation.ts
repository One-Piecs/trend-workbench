import {analyze} from './chan.ts';
import {buildStrokeCenters} from './center-layers.ts';
import {candleAvailableAt} from './timeframe-context.ts';
import type {Candle, Center, Interval} from './market-types.ts';

export const breakoutLookback = 12;
export interface CenterBreakout {
  direction:'up'|'down';
  level:'segment'|'stroke';
  boundary:number;
  parentClose:number;
  start:number;
  end:number;
}

export function crossedBoundary(center:Center|undefined, previous:number, close:number) {
  if(!center || center.status!=='active' || previous<center.low || previous>center.high)return;
  if(close>center.high)return {direction:'up' as const,boundary:center.high};
  if(close<center.low)return {direction:'down' as const,boundary:center.low};
}

/** The breakout bar itself may confirm a new pen or segment. The boundary
 * must already exist on the preceding closed prefix. */
export function priorCenterCrossing(closed:Candle[],index:number,start=0) {
  const previous=closed[index-1].close, close=closed[index].close;
  if(previous===close)return;
  const prefix=analyze(closed.slice(start,index),{skipTradePlans:true,skipCalibration:true});
  const segment=crossedBoundary(prefix.centers.at(-1),previous,close);
  if(segment)return {...segment,level:'segment' as const};
  const stroke=crossedBoundary(buildStrokeCenters(prefix.strokes).at(-1),previous,close);
  if(stroke)return {...stroke,level:'stroke' as const};
}

export function recentCenterBreakout(candles:Candle[],interval:Interval):CenterBreakout|undefined {
  const closed=candles.filter(bar=>bar.closed===true);
  for(let i=closed.length-1;i>=Math.max(2,closed.length-breakoutLookback);i--){
    const bar=closed[i], prev=closed[i-1];
    if(candleAvailableAt(prev,'crypto',interval)!==bar.time)continue;
    const crossing=priorCenterCrossing(closed,i);
    if(crossing)return {...crossing,start:bar.time,end:candleAvailableAt(bar,'crypto',interval),parentClose:bar.close};
  }
}

export function breakoutFlowQuery(symbol:string,venue:string,event:CenterBreakout) {
  return new URLSearchParams({symbol,venue,start:String(event.start),end:String(event.end),
    boundary:String(event.boundary),direction:event.direction,parentClose:String(event.parentClose)}).toString();
}
