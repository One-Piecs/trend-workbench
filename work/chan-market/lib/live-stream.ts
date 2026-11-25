import type { CryptoProvider } from './crypto-sources';
import type { Candle, Interval, MarketData } from './market-types';

export interface CryptoLiveTarget {
  provider: CryptoProvider;
  symbol: string;
  /** Subscription symbol in the venue's own WebSocket notation. */
  pair: string;
  interval: Interval;
}
export interface LongbridgeLiveTarget {
  provider: 'longbridge';
  market: 'us' | 'hk' | 'cn';
  symbol: string;
  pair: string;
  interval: Interval;
  source: string;
}
export type LiveTarget = CryptoLiveTarget | LongbridgeLiveTarget;
export type LiveStatus = 'connecting' | 'live' | 'fallback';
type Callbacks = {
  /** Full cumulative bar, plus publication time in ms (receipt time if omitted by the venue). */
  onCandle(candle: Candle, eventTimeMs: number): void;
  onQuote?(quote: unknown, eventTimeMs: number): void;
  onHeartbeat?(eventTimeMs: number): void;
  onStatus(status: LiveStatus): void;
};
const providers = { Binance:'binance', OKX:'okx', Kraken:'kraken', Bitget:'bitget', Bybit:'bybit' } as const;
const minutes: Record<Interval, number> = { '1m':1, '5m':5, '15m':15, '30m':30, '1h':60, '4h':240, '1d':1440, '1w':10080, '1M':0 };
const candleChannels: Record<Interval, string> = {
  '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1H','4h':'4H','1d':'1Dutc','1w':'1Wutc','1M':'1Mutc',
};
const bybitPeriods: Record<Interval, string> = { '1m':'1','5m':'5','15m':'15','30m':'30','1h':'60','4h':'240','1d':'D','1w':'W','1M':'M' };
const krakenAlias = (currency: string) => currency === 'BTC' ? 'XBT' : currency === 'DOGE' ? 'XDG' : currency;

/** Only subscribe to the exact public spot history returned by the REST adapter, or Longbridge Hub stream. */
export function getLiveTarget({ instrument, interval, source }: Pick<MarketData, 'instrument'|'interval'|'source'>): LiveTarget | null {
  const { symbol, currency, exchange } = instrument;
  if ((instrument.market === 'us' || instrument.market === 'hk' || instrument.market === 'cn')
    && instrument.id === `${instrument.market}:${symbol}`
    && Object.hasOwn(minutes, interval)
    && source.startsWith('Longbridge ')
    && !source.includes('聚合4小时')) {
    return { provider: 'longbridge', market: instrument.market, symbol, pair: symbol, interval, source };
  }
  if (instrument.market !== 'crypto' || instrument.id !== 'crypto:'+symbol || !Object.hasOwn(providers, exchange)
    || !Object.hasOwn(minutes, interval) || !/^[A-Z0-9]{4,30}$/.test(symbol) || !/^[A-Z0-9]+$/.test(currency)
    || !symbol.endsWith(currency) || symbol.length <= currency.length) return null;
  const provider = providers[exchange as keyof typeof providers];
  const base = symbol.slice(0, -currency.length);
  const pair = provider === 'kraken' ? base+'/'+currency : provider === 'okx' ? base+'-'+currency : symbol;
  let sourceIds = [pair];
  if (provider === 'kraken') {
    if (interval === '1M') return null; // REST builds this from daily bars.
    sourceIds = [symbol, krakenAlias(base)+currency, base+krakenAlias(currency), krakenAlias(base)+krakenAlias(currency)];
  }
  return sourceIds.some(id => source === exchange+' 公共现货行情 · '+id) ? {provider, symbol, pair, interval} : null;
}

function streamConfig({ provider, pair, interval }: CryptoLiveTarget) {
  const channel = 'candle'+candleChannels[interval];
  switch (provider) {
    case 'binance': return {url:'wss://data-stream.binance.vision/ws/'+pair.toLowerCase()+'@kline_'+interval};
    case 'okx': return {url:'wss://ws.okx.com:8443/ws/v5/business', request:{op:'subscribe',args:[{channel,instId:pair}]}, ping:'ping'};
    case 'bitget': return {url:'wss://ws.bitget.com/v2/ws/public', request:{op:'subscribe',args:[{instType:'SPOT',channel,instId:pair}]}, ping:'ping'};
    case 'kraken': return {url:'wss://ws.kraken.com/v2', request:{method:'subscribe',params:{channel:'ohlc',symbol:[pair],interval:minutes[interval],snapshot:false}}};
    case 'bybit': return {url:'wss://stream.bybit.com/v5/public/spot', request:{op:'subscribe',args:['kline.'+bybitPeriods[interval]+'.'+pair]}, ping:'{"op":"ping"}'};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function numeric(value: unknown): number {
  return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
}

export function decodeLiveCandles(target: LiveTarget, message: unknown, receivedAt = Date.now()) {
  if (target.provider === 'longbridge') return [];
  const {provider, interval, pair} = target;
  const msg = record(message);
  const result: { candle:Candle; eventTimeMs:number }[] = [];
  function accept(start: number, values: unknown[], closed: unknown, timestamp?: unknown) {
    const [open, high, low, close, volume] = values.map(numeric);
    if (!Number.isSafeInteger(start) || start <= 0 || start > receivedAt || typeof closed !== 'boolean'
      || ![open, high, low, close, volume].every(Number.isFinite) || low <= 0 || volume < 0
      || high < Math.max(open, close) || low > Math.min(open, close)) return;
    // Kraken weeks are epoch-anchored (Thursday); other native spot weeks start Monday.
    const date = new Date(start);
    const duration = minutes[interval]*60000;
    const aligned = interval === '1M' ? start === Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
      : interval === '1w' && provider !== 'kraken' ? (start+3*86400000)%duration === 0 : start%duration === 0;
    if (!aligned) return;
    const end = interval === '1M' ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth()+1, 1) : start+duration;
    const eventTimeMs = timestamp === undefined ? receivedAt : numeric(timestamp);
    // Long-period candles legitimately opened months ago. Freshness concerns the event and
    // whether this is today's forming bar or an explicit close at the previous boundary.
    if (!Number.isSafeInteger(eventTimeMs) || eventTimeMs < start || eventTimeMs < receivedAt-90000 || eventTimeMs > receivedAt+5000
      || (closed ? end > receivedAt+2000 || end < receivedAt-90000 : end <= receivedAt-2000)) return;
    result.push({candle:{time:start/1000, open, high, low, close, volume, closed}, eventTimeMs});
  }
  const data = Array.isArray(msg.data) ? msg.data : [];
  if (provider === 'binance') {
    const k = record(msg.k);
    if (msg.e === 'kline' && msg.s === pair && k.s === pair && k.i === interval && typeof msg.E === 'number')
      accept(numeric(k.t), [k.o,k.h,k.l,k.c,k.v], k.x, msg.E);
  } else if (provider === 'bybit') {
    if (msg.type === 'snapshot' && msg.topic === 'kline.'+bybitPeriods[interval]+'.'+pair) {
      for (const raw of data) {
        const k = record(raw);
        if (k.interval === bybitPeriods[interval]) accept(numeric(k.start), [k.open,k.high,k.low,k.close,k.volume], k.confirm, msg.ts);
      }
    }
  } else if (provider === 'kraken') {
    if (msg.channel === 'ohlc' && msg.type === 'update') {
      for (const raw of data) {
        const k = record(raw);
        if (k.symbol === pair && k.interval === minutes[interval] && typeof k.interval_begin === 'string')
          accept(Date.parse(k.interval_begin), [k.open,k.high,k.low,k.close,k.volume], false);
      }
    }
  } else {
    const arg = record(msg.arg);
    if (arg.channel === 'candle'+candleChannels[interval] && arg.instId === pair
      && (provider === 'okx' || (arg.instType === 'SPOT' && msg.action === 'update'))) {
      for (const k of data) {
        if (!Array.isArray(k) || (provider === 'okx' && k[8] !== '0' && k[8] !== '1')) continue;
        accept(numeric(k[0]), k.slice(1,6), provider === 'okx' && k[8] === '1', msg.ts);
      }
    }
  }
  return result;
}

function subscribeLongbridgeSse(
  target: LongbridgeLiveTarget,
  callbacks: Callbacks,
  openEventSource = (url: string) => new EventSource(url),
): () => void {
  const url = '/api/live-stream?' + new URLSearchParams({
    market: target.market,
    symbol: target.symbol,
    interval: target.interval,
    source: target.source,
  }).toString();
  let source: EventSource | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false, attempts = 0, status: LiveStatus | undefined;

  function notify(next: LiveStatus) {
    if (!stopped && next !== status) {
      status = next;
      callbacks.onStatus(next);
    }
  }
  function disconnect() {
    clearTimeout(deadline);
    if (!source) return;
    source.onerror = null;
    source.close();
    source = undefined;
  }
  function reconnect() {
    disconnect();
    if (stopped) return;
    notify('fallback');
    retry = setTimeout(connect, Math.min(30000, 2000 * 2 ** Math.min(attempts++, 4)));
  }
  function armWatchdog(ms: number) {
    clearTimeout(deadline);
    deadline = setTimeout(reconnect, ms);
  }
  function connect() {
    if (stopped) return;
    try { source = openEventSource(url); } catch { reconnect(); return; }
    const current = source;
    armWatchdog(15000);
    current.addEventListener('status', (rawEvent: Event) => {
      if (current !== source) return;
      const data = (rawEvent as MessageEvent).data;
      if (typeof data !== 'string') return;
      let parsed: Record<string, unknown>;
      try { parsed = record(JSON.parse(data)); } catch { return; }
      if (parsed.status === 'live') {
        attempts = 0;
        armWatchdog(45000);
        callbacks.onHeartbeat?.(typeof parsed.time === 'number' ? parsed.time : Date.now());
        notify('live');
      } else if (parsed.status === 'fallback') {
        notify('fallback');
      }
    });
    current.addEventListener('candle', (rawEvent: Event) => {
      if (current !== source) return;
      const data = (rawEvent as MessageEvent).data;
      if (typeof data !== 'string') return;
      let parsed: Record<string, unknown>;
      try { parsed = record(JSON.parse(data)); } catch { return; }
      const c = record(parsed.candle);
      const time = numeric(c.time), open = numeric(c.open), high = numeric(c.high), low = numeric(c.low), close = numeric(c.close), volume = numeric(c.volume);
      if (!Number.isSafeInteger(time) || time <= 0 || ![open, high, low, close, volume].every(Number.isFinite) || low <= 0 || volume < 0) return;
      const candle: Candle = {
        time, open, high, low, close, volume,
        closed: c.closed === true,
        ...(typeof c.session === 'string' && ['pre', 'regular', 'post', 'overnight'].includes(c.session)
          ? { session: c.session as Candle['session'] } : {}),
      };
      const eventTimeMs = Number.isFinite(Number(parsed.eventTimeMs)) ? Number(parsed.eventTimeMs) : Date.now();
      attempts = 0;
      armWatchdog(45000);
      callbacks.onHeartbeat?.(eventTimeMs);
      notify('live');
      callbacks.onCandle(candle, eventTimeMs);
    });
    current.addEventListener('quote', (rawEvent: Event) => {
      if (current !== source) return;
      const data = (rawEvent as MessageEvent).data;
      if (typeof data !== 'string') return;
      let parsed: Record<string, unknown>;
      try { parsed = record(JSON.parse(data)); } catch { return; }
      const eventTimeMs = Number.isFinite(Number(parsed.eventTimeMs)) ? Number(parsed.eventTimeMs) : Date.now();
      attempts = 0;
      armWatchdog(45000);
      callbacks.onHeartbeat?.(eventTimeMs);
      notify('live');
      callbacks.onQuote?.(parsed.quote, eventTimeMs);
    });
    current.onerror = () => { if (current === source) reconnect(); };
  }
  notify('connecting');
  connect();
  return () => { stopped = true; clearTimeout(retry); disconnect(); };
}

/** One subscription, including reconnects. Unsubscribe releases even a pending handshake. */
export function subscribeLiveCandles(
  target: LiveTarget,
  callbacks: Callbacks,
  openSocket = (url: string) => new WebSocket(url),
  openEventSource?: (url: string) => EventSource,
): () => void {
  if (target.provider === 'longbridge') {
    return subscribeLongbridgeSse(target, callbacks, openEventSource);
  }
  const {url, request, ping} = streamConfig(target);
  let socket: WebSocket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopped = false, attempts = 0, status: LiveStatus | undefined;
  function notify(next: LiveStatus) {
    if (!stopped && next !== status) {
      status = next;
      callbacks.onStatus(next);
    }
  }
  function disconnect() {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    socket.close();
    socket = undefined;
  }
  function reconnect() {
    disconnect();
    if (stopped) return;
    notify('fallback');
    retry = setTimeout(connect, Math.min(30000, 2000 * 2**Math.min(attempts++,4)));
  }
  function armWatchdog(ms: number) {
    clearTimeout(deadline);
    deadline = setTimeout(reconnect, ms);
  }
  function connect() {
    if (stopped) return;
    try { socket = openSocket(url); } catch { reconnect(); return; }
    const current = socket;
    armWatchdog(12000);
    current.onopen = () => {
      if (current !== socket) return;
      // Some quiet venues publish only on trades; the history poll remains usable.
      armWatchdog(target.provider === 'bybit' ? 75000 : 35000);
      try {
        if (request) current.send(JSON.stringify(request));
        if (ping) heartbeat = setInterval(() => {
          try { current.send(ping); } catch { reconnect(); }
        }, 20000);
      } catch { reconnect(); }
    };
    current.onmessage = event => {
      if (current !== socket || typeof event.data !== 'string') return;
      let raw: unknown;
      try { raw = JSON.parse(event.data); } catch { return; }
      const msg = record(raw);
      if (msg.event === 'error' || msg.success === false) { reconnect(); return; }
      const updates = decodeLiveCandles(target, msg);
      if (!updates.length) return;
      attempts = 0;
      armWatchdog(target.provider === 'bybit' ? 75000 : 35000);
      notify('live');
      for (const {candle,eventTimeMs} of updates) {
        if (current !== socket) break;
        callbacks.onCandle(candle,eventTimeMs);
      }
    };
    current.onerror = current.onclose = () => { if (current === socket) reconnect(); };
  }
  notify('connecting');
  connect();
  return () => { stopped = true; clearTimeout(retry); disconnect(); };
}
