import type { Candle, MarketData } from './market-types';
import { isCandle } from './market-response.ts';
import { endAtTime } from './chart-viewport.ts';

export type HistoryStatus = 'ready' | 'loading' | 'end' | 'unsupported' | 'error';
type HistoryState = { bars: Candle[]; status: HistoryStatus };
type Identity = Pick<MarketData, 'interval' | 'source' | 'adjustment'> & Pick<MarketData['instrument'], 'market' | 'symbol'>;
const pageSize = 500;
export const emptyBars: Candle[] = [];

export function historySeriesKey(data: MarketData) {
  return JSON.stringify([data.instrument.id, data.interval, data.source, data.adjustment,data.instrument.contract??'']);
}

// An overlapping real candle anchors the history to the latest snapshot. Also
// reject a changed OHLC basis at that seam (e.g. a new stock adjustment).
export function joinSnapshot(retained: Candle[], latest: Candle[]): Candle[] {
  if (retained === latest || !latest.length || !retained.length) return latest;
  const seam = endAtTime(retained, latest[0].time)-1;
  if (seam <= 0) return latest;
  const old = retained[seam], fresh = latest[0];
  if (old.time !== fresh.time) return latest;
  if (old.closed !== false && (old.open !== fresh.open || old.high !== fresh.high || old.low !== fresh.low || old.close !== fresh.close)) return latest;
  if (seam + latest.length === retained.length && latest.every((bar,index) => bar === retained[seam+index])) return retained;
  return retained.slice(0, seam).concat(latest);
}

export function decodePage(body: unknown, expected: Identity, before: number): {status:'more'|'end'|'unsupported';bars:Candle[]} {
  if (!body || typeof body !== 'object') throw new Error('Malformed history page');
  const page = body as Record<string, unknown>;
  if (Object.entries(expected).some(([k, v]) => page[k] !== v)) throw new Error('History series mismatch');
  const rows = page.candles;
  const status = page.status;
  if ((status !== 'more' && status !== 'end' && status !== 'unsupported') || !Array.isArray(rows)
    || rows.length > pageSize || (status === 'more' && !rows.length) || (status === 'unsupported' && rows.length)) throw new Error('Invalid history page');
  let previous = 0;
  for (const row of rows) {
    if (!isCandle(row, expected.market === 'commodity') || row.closed === false || row.time <= previous || row.time >= before) throw new Error('Invalid historical candle');
    previous = row.time;
  }
  return {status, bars: rows as Candle[]};
}

export function createHistorySession(request: typeof fetch = fetch, seriesKey?: string) {
  let state: HistoryState = {bars: emptyBars, status: 'ready'};
  let latest = emptyBars;
  let pending: AbortController | undefined;
  const listeners = new Set<() => void>();
  function publish(bars: Candle[], status: HistoryStatus) {
    state = {bars, status};
    listeners.forEach(listener => listener());
  }
  function cancel() {
    if (!pending) return;
    pending.abort();
    pending = undefined;
    publish(state.bars, 'ready');
  }
  function refresh(bars: Candle[]) {
    if (latest === bars) return;
    const prior = latest;
    latest = bars;
    if (!prior.length || !bars.length) return;
    const retained = state.bars.length ? state.bars : prior;
    const joined = joinSnapshot(retained, bars);
    if (joined === bars && (retained[0].time !== bars[0].time || state.bars.length)) {
      cancel();
      publish(emptyBars, 'ready');
    } else if (state.bars.length || (pending && joined !== bars)) {
      publish(joined, state.status);
    }
  }
  async function load(data: MarketData) {
    if (seriesKey !== undefined && seriesKey !== historySeriesKey(data)) return;
    refresh(data.candles);
    if (pending || state.status === 'end' || state.status === 'unsupported' || !latest.length) return;
    const original = state.bars.length ? state.bars : latest;
    const before = original[0].time;
    const {market, symbol} = data.instrument;
    const {source, adjustment, interval} = data;
    const identity = {market, symbol, interval, source, adjustment,...(data.instrument.contract&&{contract:data.instrument.contract})};
    const query = new URLSearchParams({...identity, before: String(before), limit: String(pageSize)});
    const controller = new AbortController();
    pending = controller;
    publish(state.bars, 'loading');
    try {
      const response = await request('/api/history?' + query, {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)])});
      if (!response.ok) throw new Error('History request failed');
      const page = decodePage(await response.json(), identity, before);
      if (pending !== controller) return;
      const base = state.bars.length ? state.bars : latest;
      if (base[0]?.time !== before) { publish(state.bars, 'ready'); return; }
      publish(page.bars.length ? page.bars.concat(base) : state.bars, page.status === 'more' ? 'ready' : page.status);
    } catch {
      if (pending === controller) publish(state.bars, 'error');
    } finally {
      if (pending === controller) pending = undefined;
    }
  }
  return {read: () => state, subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, load, refresh, cancel};
}
