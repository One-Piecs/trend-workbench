import type {Candle} from './market-types';

/** Exclusive right edge. An open chart follows the newest bar; a panned chart
 * follows a timestamp even when earlier history or a new live bar arrives. */
export function endAtTime(bars: Candle[], time: number | null, appended?: Candle): number {
  if (appended && (time === null || appended.time <= time)) return bars.length + 1;
  if (time === null) return bars.length;
  let left = 0, right = bars.length;
  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    if (bars[middle].time <= time) left = middle + 1;
    else right = middle;
  }
  return left;
}

export function chartWindow(bars: Candle[], count: number, anchor: number | null, appended?: Candle) {
  const length = bars.length + Number(!!appended);
  const end = Math.min(length, Math.max(count, endAtTime(bars, anchor, appended)));
  return {start: Math.max(0, end - count), end, back: length - end};
}
