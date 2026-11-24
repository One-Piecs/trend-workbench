import type { Candle, Interval, Market, MarketData } from './market-types';

type RequestIdentity = { market: Market; symbol: string; interval: Interval };
const intervals: ReadonlySet<string> = new Set<Interval>(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M']);
const invalidFormat = '行情源返回格式异常，未使用替代价格。';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isInterval = (value: unknown): value is Interval => isText(value) && intervals.has(value);
// API candles use whole epoch seconds. A modern millisecond stamp would otherwise parse as a far-future year.
const isTimestamp = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value > 0 && value <= 253402300799;

export function isCandle(value: unknown, signedPrices: boolean): value is Candle {
  if (!record(value)) return false;
  const { time, open, high, low, close, volume, closed } = value;
  return isTimestamp(time) && finite(open) && finite(high) && finite(low) && finite(close) && finite(volume)
    && (signedPrices || low > 0) && low <= Math.min(open, close) && high >= Math.max(open, close) && volume >= 0
    && (closed === undefined || typeof closed === 'boolean');
}

function isHistory(value: unknown, bars: Candle[]): value is NonNullable<MarketData['history']> {
  return record(value) && finite(value.requested) && Number.isSafeInteger(value.requested) && value.requested > 0
    && value.received === bars.length && value.closed === bars.filter(bar => bar.closed !== false).length
    && value.firstTime === bars[0].time && value.lastTime === bars[bars.length - 1].time
    && (value.status === 'target-met' || value.status === 'limited' || value.status === 'insufficient');
}

/** Reject a malformed feed as a unit. Dropping or reordering individual bars changes structure indices. */
export async function readMarketResponse(response: Response, expected: RequestIdentity, messages = {
  empty: '该标的在此周期没有可用K线', failed: '行情源暂时没有响应',
}): Promise<MarketData> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(response.ok ? invalidFormat : messages.failed);
  }
  if (!response.ok) {
    const message = record(body) && [body.error, body.message].find(value => isText(value) && value.trim());
    throw new Error(isText(message) ? message : messages.failed);
  }
  if (!record(body)) throw new Error(invalidFormat);
  const { instrument, interval, candles, source, asOf, adjustment, delayNotice, warnings, availableIntervals, history } = body;
  if (!record(instrument) || instrument.market !== expected.market || instrument.symbol !== expected.symbol
    || instrument.id !== `${expected.market}:${expected.symbol}` || interval !== expected.interval) {
    throw new Error('行情标的或周期不匹配');
  }
  if (!Array.isArray(candles) || candles.length === 0) throw new Error(messages.empty);
  if (!candles.every((bar): bar is Candle => isCandle(bar, expected.market==='commodity')) || candles.some((bar, i) => i > 0 && bar.time <= candles[i - 1].time)) {
    throw new Error('行情源缺少完整K线。');
  }
  const { id, name, exchange, currency } = instrument;
  if (!isText(id) || !isText(name) || !isText(exchange) || !isText(currency)
    || !isText(source) || !source.trim() || !isText(asOf) || !Number.isFinite(Date.parse(asOf))
    || !isText(adjustment) || !isText(delayNotice) || !Array.isArray(warnings) || !warnings.every(isText)
    || !Array.isArray(availableIntervals) || !availableIntervals.every(isInterval)
    || (history !== undefined && !isHistory(history, candles))) throw new Error(invalidFormat);
  return {
    instrument: { id, name, exchange, currency, market: expected.market, symbol: expected.symbol,
      ...(expected.market==='commodity' && typeof instrument.contract==='string' &&
        /^(?:GC|CL|SI)[FGHJKMNQUVXZ]\d{2}$/.test(instrument.contract) && instrument.contract.startsWith(expected.symbol.split('=')[0]) && {contract:instrument.contract}) }, interval: expected.interval,
    candles, source, asOf, adjustment, delayNotice, warnings, availableIntervals, ...(history && { history }),
  };
}
