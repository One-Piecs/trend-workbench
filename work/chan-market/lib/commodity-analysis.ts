import type { Candle, Market } from './market-types';

/** Percentage-based indicators require a contiguous run of positive prices.
 * Keep the full exchange history and its chart indices, including negative oil. */
export function positiveRunStart(candles: Candle[], market?: Market, available?: (bar: Candle) => boolean) {
  if (market !== 'commodity') return 0;
  return candles.findLastIndex(bar => Number.isFinite(bar.low) && bar.low <= 0 && (!available || available(bar))) + 1;
}
