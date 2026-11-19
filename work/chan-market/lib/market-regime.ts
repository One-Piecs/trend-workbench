import type { Candle } from './market-types';

/** Fixed research defaults. These thresholds are not calibrated probabilities,
 * position sizes or instructions to override a Chan forecast. */
export const MARKET_REGIME_DEFAULTS = Object.freeze({
  period: 14,
  rangeAdxBelow: 20,
  trendAdxAtLeast: 25,
  absoluteVolatileAtrPct: 5,
  relativeVolatileAtrPct: 2,
  volatilePercentileAtLeast: 95,
  volatilityLookback: 252,
  minVolatilitySamples: 60,
});

export interface MarketRegime {
  version: 'wilder-adx14-v1';
  status: 'ready' | 'insufficient';
  /** When status is insufficient, transition is only a neutral placeholder. */
  state: 'trend' | 'range' | 'transition' | 'volatile';
  /** A DI direction is exposed only in the trend state. */
  direction: 'long' | 'short' | 'neutral';
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
  /** Wilder ATR / latest closed price * 100. */
  atrPct: number | null;
  /** Midrank, 0..100, against prior ATR% observations only; never a win rate. */
  volatilityPercentile: number | null;
  volatilitySamples: number;
  /** Number of valid closed input candles, including the previous-price seed. */
  samples: number;
  /** Last accepted closed candle's Unix timestamp; 0 if no valid bars exist. */
  asOf: number;
}

function closedHistory(candles: readonly Candle[], cutoff: number): Candle[] {
  const bars: Candle[] = [];
  for (const candle of candles) {
    if (!candle || candle.closed === false ||
      ![candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) ||
      !Number.isInteger(candle.time) || candle.time <= 0 || candle.time > cutoff ||
      candle.time <= (bars.at(-1)?.time ?? 0) || candle.volume < 0 ||
      Math.min(candle.open, candle.high, candle.low, candle.close) <= 0 ||
      candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) ||
      candle.high < candle.low) continue;
    // Preserve input order: a stale/duplicate appended row cannot rewrite an
    // earlier accepted candle or change a previously computed historical prefix.
    bars.push(candle);
  }
  return bars;
}

function priorPercentile(value: number, history: readonly number[]): number | null {
  if (history.length < MARKET_REGIME_DEFAULTS.minVolatilitySamples) return null;
  // Compare in percentage units, with relative tolerance for scaling roundoff.
  const tolerance = 1e-10 * Math.max(1, Math.abs(value));
  let smaller = 0, equal = 0;
  for (const previous of history) {
    if (Math.abs(previous - value) <= tolerance) equal++;
    else if (previous < value) smaller++;
  }
  return 100 * (smaller + equal / 2) / history.length;
}

const atLeast = (value: number, threshold: number) =>
  value >= threshold || threshold - value <= Number.EPSILON * Math.max(1, threshold) * 16;

/** Causal, closed-candle-only Wilder ADX14 / DI and ATR14 assessment.
 *
 * DMI warmup follows TA-Lib's convention: accumulate the first 13 transitions,
 * apply Wilder smoothing on transition 14, then average DX at transitions
 * 14..27. The first ADX therefore requires 28 candles. ATR separately seeds
 * from the arithmetic mean of the first 14 true ranges (15 candles).
 * Reference formulas: https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_ADX.c
 * and https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_ATR.c
 * No input sorting, filling, future values or open candles are used.
 * options.asOf is an evaluation cutoff in Unix seconds, not a result timestamp.
 */
export function evaluateMarketRegime(candles: readonly Candle[], options: { asOf?: number } = {}): MarketRegime {
  const cutoff = Number.isFinite(options.asOf) ? options.asOf! : Date.now() / 1000;
  const bars = closedHistory(candles, cutoff);
  const result: MarketRegime = {
    version: 'wilder-adx14-v1', status: 'insufficient', state: 'transition', direction: 'neutral',
    adx: null, plusDI: null, minusDI: null, atrPct: null, volatilityPercentile: null,
    volatilitySamples: 0, samples: bars.length, asOf: bars.at(-1)?.time ?? 0,
  };
  const period = MARKET_REGIME_DEFAULTS.period, decay = (period - 1) / period;
  // Scaled averages (rather than large TR/DM sums) avoid unnecessary overflow.
  let smoothedTR = 0, smoothedPlusDM = 0, smoothedMinusDM = 0, atr = 0;
  let dxSeed = 0, adx: number | null = null;
  const priorAtr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1], current = bars[i];
    const tr = Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
    const up = current.high - previous.high, down = previous.low - current.low;
    const plusDM = up > down && up > 0 ? up : 0;
    const minusDM = down > up && down > 0 ? down : 0;
    if (i < period) {
      smoothedTR += tr / period;
      smoothedPlusDM += plusDM / period;
      smoothedMinusDM += minusDM / period;
    } else {
      smoothedTR = smoothedTR * decay + tr / period;
      smoothedPlusDM = smoothedPlusDM * decay + plusDM / period;
      smoothedMinusDM = smoothedMinusDM * decay + minusDM / period;
      const plusDI = smoothedTR > 0 ? 100 * (smoothedPlusDM / smoothedTR) : 0;
      const minusDI = smoothedTR > 0 ? 100 * (smoothedMinusDM / smoothedTR) : 0;
      const sumDI = plusDI + minusDI;
      const dx = sumDI > 0 ? 100 * Math.abs(plusDI - minusDI) / sumDI : 0;
      result.plusDI = plusDI;
      result.minusDI = minusDI;
      if (i <= 2 * period - 1) {
        dxSeed += dx / period;
        if (i === 2 * period - 1) adx = dxSeed;
      } else {
        adx = adx! * decay + dx / period;
      }
    }
    if (i <= period) atr += tr / period;
    else atr = atr * decay + tr / period;
    if (i >= period) {
      const percentage = (atr / current.close) * 100;
      const atrPct = Number.isFinite(percentage) ? percentage : null;
      result.atrPct = atrPct;
      if (i === bars.length - 1) {
        result.volatilitySamples = priorAtr.length;
        result.volatilityPercentile = atrPct === null ? null : priorPercentile(atrPct, priorAtr);
      }
      if (atrPct !== null) {
        priorAtr.push(atrPct);
        if (priorAtr.length > MARKET_REGIME_DEFAULTS.volatilityLookback) priorAtr.shift();
      }
    }
  }
  if (adx === null || !Number.isFinite(adx) || result.atrPct === null) return result;
  // Clamp only numerical roundoff; ADX/DI ratios mathematically lie in 0..100.
  result.adx = Math.min(100, Math.max(0, adx));
  result.status = 'ready';
  const extreme = atLeast(result.atrPct, MARKET_REGIME_DEFAULTS.absoluteVolatileAtrPct) ||
    (atLeast(result.atrPct, MARKET_REGIME_DEFAULTS.relativeVolatileAtrPct) &&
      result.volatilityPercentile !== null && atLeast(result.volatilityPercentile, MARKET_REGIME_DEFAULTS.volatilePercentileAtLeast));
  if (extreme) result.state = 'volatile';
  else if (atLeast(result.adx, MARKET_REGIME_DEFAULTS.trendAdxAtLeast)) {
    result.state = 'trend';
    result.direction = result.plusDI! > result.minusDI! ? 'long' : result.minusDI! > result.plusDI! ? 'short' : 'neutral';
  } else result.state = !atLeast(result.adx, MARKET_REGIME_DEFAULTS.rangeAdxBelow) ? 'range' : 'transition';
  return result;
}
