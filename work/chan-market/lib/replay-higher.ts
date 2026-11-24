import type {Interval,MarketData} from './market-types.ts';
import {compatibleMarketFeeds,deriveHigherFromPrimary,SAME_SOURCE_AGGREGATION} from './higher-from-primary.ts';
import {higherDataStale} from './confluence.ts';
import {barAtTime,linkedBars,type TimedBar} from './linked-timeframes.ts';

export function isNativeReplayParent(primary:MarketData,data:MarketData|undefined,target:Interval):data is MarketData {
  return !!data&&data.interval===target&&!data.source.endsWith(SAME_SOURCE_AGGREGATION)
    &&primary.instrument.currency===data.instrument.currency&&primary.instrument.contract===data.instrument.contract
    &&compatibleMarketFeeds(primary,data);
}

/** The main judgment and comparison pane receive the same strictly as-of snapshot. */
export function replayParentWindow(data:MarketData,rows:TimedBar[],at:number):MarketData|undefined {
  const end=barAtTime(rows,at);
  if(end<0||higherDataStale(rows[end].available,at,data.instrument.market,data.interval))return;
  const candles=rows.slice(Math.max(0,end+1-800),end+1).map(row=>row.bar);
  return {...data,candles,asOf:new Date(Math.min(at*1000,Date.parse(data.asOf))).toISOString()};
}

export function deriveReplayParent(primary:MarketData,rows:TimedBar[],at:number):MarketData|undefined {
  const end=barAtTime(rows,at);
  if(end<0)return;
  // In particular a later nonpositive futures price must not hide an earlier, fully observed history.
  const historical={...primary,candles:rows.slice(0,end+1).map(row=>row.bar),asOf:new Date(at*1000).toISOString()};
  const derived=deriveHigherFromPrimary(historical);
  return derived?replayParentWindow(derived,linkedBars(derived,at),at):undefined;
}
