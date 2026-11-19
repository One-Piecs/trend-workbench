import type { MarketData } from './market-types';

/** Counts the delivered window; meeting a request never means all listing history. */
export function withHistoryCoverage(data:MarketData,requested:number):MarketData {
  const received=data.candles.length;
  const closed=data.candles.filter(candle=>candle.closed!==false).length;
  return {...data,history:{requested,received,closed,
    firstTime:data.candles[0]?.time??null,lastTime:data.candles.at(-1)?.time??null,
    status:closed<35?'insufficient':received<requested?'limited':'target-met',
  }};
}
