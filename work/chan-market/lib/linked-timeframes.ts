import type {Candle, Interval, MarketData} from './market-types';
import {candleAvailableAt} from './timeframe-context.ts';
import {readMarketResponse} from './market-response.ts';
import {decodePage} from './earlier-history.ts';

export const linkedPeriods = ['1h','4h','1d'] as const;
export type LinkedPeriod = typeof linkedPeriods[number];
export type TimedBar = {bar: Candle; available: number};

// Align neighbouring replay positions to one page so stepping through bars
// doesn't refetch the same history. Pages never overlap the current feed.
export function linkedHistoryCursor(period:Interval, first:number, cutoff:number) {
  if (!Number.isFinite(cutoff) || cutoff<=0 || first<=0) return 0;
  const bucket=({ '1m':60,'5m':300,'15m':900,'30m':1800,'1h':3600,'4h':14400,'1d':86400,'1w':604800,'1M':2678400 }[period])*24;
  return Math.min(first,(Math.floor(cutoff/bucket)+1)*bucket);
}

export function linkedIdentity(data:MarketData) {
  const {market,symbol,contract}=data.instrument;
  return {market,symbol,interval:data.interval,source:data.source,adjustment:data.adjustment,...(contract?{contract}:{})};
}

export async function fetchLinkedHistory(identity:ReturnType<typeof linkedIdentity>,before:number,signal:AbortSignal,fetcher=fetch) {
  const params=new URLSearchParams({...identity,before:String(before),limit:'240'});
  const response=await fetcher('/api/history?'+params,{signal});
  if(!response.ok)throw new Error('Linked history unavailable');
  return decodePage(await response.json(),identity,before);
}

export function linkedBars(data: MarketData, cutoff: number): TimedBar[] {
  const until = Math.min(cutoff, Date.parse(data.asOf) / 1000);
  return data.candles.filter(bar => bar.closed === true)
    .map(bar => ({bar, available: candleAvailableAt(bar,data.instrument.market,data.interval,data.source)}))
    .filter(row => row.available <= until);
}

/** Only a candle visible by the shared instant can supply the linked OHLC. */
export function barAtTime(rows: TimedBar[], time: number) {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (rows[mid].available <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export async function fetchLinkedPeriod(primary: Pick<MarketData,'instrument'>, period: LinkedPeriod, signal: AbortSignal, fetcher = fetch, cached=false) {
  const {market,symbol,currency,contract} = primary.instrument;
  const params = new URLSearchParams({market,symbol,interval:period});
  const response = await fetcher((cached?'/api/cached-candles?':'/api/candles?') + params, {signal});
  const result = await readMarketResponse(response,{market,symbol,interval:period});
  if (result.instrument.currency !== currency) throw new Error('报价币种不匹配');
  if (contract && result.instrument.contract!==contract) throw new Error('行情合约不匹配');
  return result;
}
