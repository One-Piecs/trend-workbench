import type { Candle, MarketData } from './market-types';
import { candleAvailableAt } from './timeframe-context.ts';

/** A complete, cumulative candle snapshot from the currently subscribed live feed. */
export interface LiveCandleUpdate { key: string; candle: Candle; eventTimeMs: number }

export function liveCandleKey(data: MarketData): string {
  return JSON.stringify([data.instrument.market, data.instrument.symbol, data.instrument.exchange,
    data.instrument.currency, data.interval, data.source]);
}

const clockToleranceMs = 10_000;
const maxEventAgeMs = 90_000;

function isLongbridgeEquityStream(data: MarketData): boolean {
  const m = data.instrument.market;
  return (m === 'us' || m === 'hk' || m === 'cn')
    && data.source.startsWith('Longbridge ')
    && !data.source.includes('聚合4小时');
}

function validBar(bar: Candle): boolean {
  return Number.isSafeInteger(bar.time) && bar.time > 0
    && [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
    && bar.low > 0 && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close)
    && bar.volume >= 0;
}

/** Both feeds report cumulative volume and extrema for the same bar.
 * Event/receipt times alone cannot order a REST refresh racing a socket snapshot. */
function continuesBar(base: Candle, incoming: Candle, equity = false): boolean {
  if (incoming.open !== base.open || incoming.high < base.high || incoming.low > base.low || incoming.volume < base.volume) return false;
  if (incoming.volume > base.volume) return true;
  if (equity && incoming.closed === true) return true;
  return incoming.high === base.high && incoming.low === base.low && incoming.close === base.close;
}

function fitsSnapshot(data: MarketData, update: LiveCandleUpdate): boolean {
  const tail = data.candles.at(-1);
  const equity = isLongbridgeEquityStream(data);
  if ((data.instrument.market !== 'crypto' && !equity) || update.key !== liveCandleKey(data) || !tail || !validBar(update.candle)) return false;
  if (update.candle.time === tail.time) return tail.closed === false && continuesBar(tail, update.candle, equity);
  // If the previous REST bar is still forming or there is a hole, let REST fill
  // the boundary before replacing the active overlay. Never invent a closing bar.
  const nextBoundary = candleAvailableAt(tail, data.instrument.market, data.interval, data.source);
  if (equity) return tail.closed !== false && update.candle.time >= nextBoundary;
  return tail.closed !== false && update.candle.time === nextBoundary;
}

export function acceptLiveCandle(data: MarketData, previous: LiveCandleUpdate | null, next: LiveCandleUpdate, nowMs = Date.now()): boolean {
  const { candle, eventTimeMs } = next;
  if (!Number.isFinite(eventTimeMs) || !Number.isFinite(nowMs) || !fitsSnapshot(data, next)) return false;
  const equity = isLongbridgeEquityStream(data);
  const startMs = candle.time * 1000;
  const endMs = candleAvailableAt(candle, data.instrument.market, data.interval, data.source) * 1000;
  if (!Number.isFinite(endMs) || eventTimeMs < startMs || eventTimeMs > endMs + clockToleranceMs
    || eventTimeMs > nowMs + clockToleranceMs || nowMs - eventTimeMs > maxEventAgeMs) return false;
  if (!previous || previous.key !== next.key) return true;
  if (candle.time < previous.candle.time || eventTimeMs < previous.eventTimeMs) return false;
  if (candle.time !== previous.candle.time || !fitsSnapshot(data, previous)) return true;
  return !(previous.candle.closed === true && candle.closed !== true) && continuesBar(previous.candle, candle, equity);
}

/** Presentation only. A fresh REST snapshot always owns history and confirms
 * closes; shrinking or obsolete socket overlays automatically fall away here. */
export function liveDisplayCandles(data: MarketData, update: LiveCandleUpdate | null): Candle[] {
  if (!update || !fitsSnapshot(data, update)) return data.candles;
  const displayBar = { ...update.candle, closed: false };
  if (data.candles.at(-1)!.time === displayBar.time) return [...data.candles.slice(0, -1), displayBar];
  return [...data.candles, displayBar];
}
