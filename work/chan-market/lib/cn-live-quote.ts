import { equityExchangeClock, equitySessionOn } from './equity-calendar.ts';
import type { Candle, Interval, MarketData } from './market-types';
import { quotePeriodBounds } from './quote-overlay.ts';

type Prices = Pick<Candle, 'open' | 'high' | 'low' | 'close' | 'volume'>;
type Source = 'tencent' | 'eastmoney';
type Series = Pick<MarketData, 'interval' | 'source' | 'adjustment'>;
type Snapshot = { time: number; prices: Prices };
type NativeBatch = { provider: Source | 'sina'; rows: Snapshot[] };
interface EastmoneySnapshot {
  rc?: number;
  data?: { f43: number; f44: number; f45: number; f46: number; f47: number; f57: string; f59: number; f86: number };
}
interface EastmoneyHistory { data?: { code: string; market: number; klines?: string[] } }
interface TencentHistory { code?: number; data?: Record<string, Record<string, unknown[][]>> }
export interface ChinaLiveQuote {
  market: 'cn';
  symbol: string;
  currency: 'CNY';
  venue: 'XSHG' | 'XSHE' | 'BJSE';
  provider: Source;
  price: number;
  /** Upstream quote snapshot time (seconds), not a local receipt or guaranteed trade time. */
  time: number;
  sessionBar: Prices;
  bar?: Prices & { interval: Interval; start: number; end: number; provider: NativeBatch['provider']; priceBasis?: 'tencent-minute-native' };
}

const venues = { SH: 'XSHG', SZ: 'XSHE', BJ: 'BJSE' } as const;
const intradayMinutes: Partial<Record<Interval, number>> = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60 };

// Only CNY equity / domestic fund codes whose provider volume is quoted in lots of 100.
// In particular, B-shares, bonds and index levels must not be reported as A-share CNY trades.
function instrument(symbol: string) {
  const match = /^(\d{6})\.(SH|SZ|BJ)$/.exec(symbol);
  if (!match) return null;
  const [, code, exchange] = match;
  const eligible = exchange === 'SH' ? /^(?:6|5[0168])/.test(code)
    : exchange === 'SZ' ? /^(?:0[023]|30|1[568])/.test(code) : /^(?:4|8|92)/.test(code);
  if (!eligible) return null;
  return { code, ticker: exchange.toLowerCase() + code, secid: (exchange === 'SH' ? '1.' : '0.') + code,
    venue: venues[exchange as keyof typeof venues] };
}
type ChinaInstrument = NonNullable<ReturnType<typeof instrument>>;

function shanghaiTime(digits: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(digits);
  if (!match) return NaN;
  const [, y, m, d, hh, mm, ss] = match;
  return Date.parse(`${y}-${m}-${d}T${hh}:${mm}:${ss}+08:00`) / 1000;
}

function validPrices(p: Prices) {
  return Object.values(p).every(Number.isFinite) && Number.isSafeInteger(p.volume) && p.volume > 0 &&
    p.low > 0 && p.low <= Math.min(p.open, p.close) && Math.max(p.open, p.close) <= p.high;
}

async function request(fetcher: typeof fetch, url: string) {
  const response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(3500),
    headers: { Accept: 'application/json,text/plain,*/*' } });
  if (!response.ok) throw new Error(`行情源 HTTP ${response.status}`);
  return response;
}

async function readSnapshot(id: ChinaInstrument, provider: Source, fetcher: typeof fetch): Promise<Snapshot | null> {
  if (provider === 'tencent') {
    const response = await request(fetcher, `https://qt.gtimg.cn/q=${id.ticker}`);
    const text = new TextDecoder('gbk').decode(await response.arrayBuffer());
    const match = /^\s*v_(\w+)="([^"]*)";?\s*$/.exec(text);
    const r = match?.[2].split('~');
    if (match?.[1] !== id.ticker || !r || r[2] !== id.code) return null;
    return { time: shanghaiTime(r[30]), prices: {
      open: Number(r[5]), high: Number(r[33]), low: Number(r[34]), close: Number(r[3]), volume: Number(r[6]) * 100 } };
  }
  const query = new URLSearchParams({ secid: id.secid, fields: 'f43,f44,f45,f46,f47,f57,f59,f86' });
  const response = await request(fetcher, `https://push2.eastmoney.com/api/qt/stock/get?${query}`);
  const payload = await response.json() as EastmoneySnapshot | null;
  const r = payload?.data;
  if (payload?.rc !== 0 || !r || r.f57 !== id.code || !Number.isInteger(r.f59) || r.f59 < 0 || r.f59 > 4) return null;
  const scale = 10 ** r.f59;
  return { time: Number(r.f86), prices: {
    open: r.f46 / scale, high: r.f44 / scale, low: r.f45 / scale, close: r.f43 / scale, volume: r.f47 * 100 } };
}

function nativeTime(stamp: unknown, daily: boolean) {
  const digits = String(stamp).replace(/[- :]/g, '');
  if (daily && /^\d{8}(?:000000|150000|093000)?$/.test(digits)) return shanghaiTime(digits.slice(0, 8) + '093000');
  return shanghaiTime(digits.length === 12 ? digits + '00' : digits);
}

// The three history adapters use end-stamped native minute bars and Shanghai-dated daily candles.
// Read the original series' source, raw price basis and volume units.
async function readNativeBars(id: ChinaInstrument, series: Series, fetcher: typeof fetch): Promise<NativeBatch | null> {
  const minutes = intradayMinutes[series.interval];
  const daily = series.interval === '1w' || series.interval === '1M';
  if ((!daily && !minutes) || !series.adjustment.includes('股')) return null;
  const count = daily ? '32' : '2';
  let batch: NativeBatch;
  const tuple = (r: unknown[]): Snapshot => ({ time: nativeTime(r[0], daily), prices: {
    open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]), volume: Number(r[5]) * 100 } });
  if (series.source.includes('push2his.eastmoney.com')) {
    const query = new URLSearchParams({ secid: id.secid, klt: daily ? '101' : String(minutes), fqt: '0', lmt: count, end: '20500101',
      fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56' });
    const response = await request(fetcher, `https://push2his.eastmoney.com/api/qt/stock/kline/get?${query}`);
    const result = (await response.json() as EastmoneyHistory | null)?.data;
    if (result?.code !== id.code || result.market !== Number(id.secid[0]) || !Array.isArray(result.klines)) return null;
    batch = { provider: 'eastmoney', rows: result.klines.map((r: string) => tuple(r.split(','))) };
  } else if (series.source.includes('ifzq.gtimg.cn')) {
    const period = daily ? 'day' : 'm' + minutes;
    const url = daily ? `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${id.ticker},day,,,${count},`
      : `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${id.ticker},${period},,${count}`;
    const response = await request(fetcher, url);
    const payload = await response.json() as TencentHistory | null;
    const rows = payload?.code === 0 && payload.data?.[id.ticker]?.[period];
    if (!Array.isArray(rows)) return null;
    batch = { provider: 'tencent', rows: rows.map(tuple) };
  } else if (series.source.includes('quotes.sina.cn')) {
    const query = new URLSearchParams({ symbol: id.ticker, scale: daily ? '240' : String(minutes), ma: 'no', datalen: count });
    const response = await request(fetcher, `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_data=/CN_MarketDataService.getKLineData?${query}`);
    const body = (await response.text()).match(/\b_data\s*=\s*\(([\s\S]*)\);?\s*$/)?.[1];
    if (!body) return null;
    const rows = JSON.parse(body);
    if (!Array.isArray(rows)) return null;
    batch = { provider: 'sina', rows: rows.map(r => ({ time: nativeTime(r.day, daily),
      prices: { open: +r.open, close: +r.close, high: +r.high, low: +r.low, volume: +r.volume } })) };
  } else return null;
  return { provider: batch.provider, rows: batch.rows.filter(r => validPrices(r.prices) && Number.isFinite(r.time)) };
}

function selectedBar(batch: NativeBatch, interval: Interval, time: number, today: Prices): ChinaLiveQuote['bar'] {
  const bounds = quotePeriodBounds('cn', interval, time);
  if (!bounds) return;
  if (interval !== '1w' && interval !== '1M') {
    const row = batch.rows.at(-1);
    if (!row || row.time !== bounds.end || row.prices.close !== today.close ||
        row.prices.low < today.low || row.prices.high > today.high || row.prices.volume > today.volume) return;
    return { ...row.prices, ...bounds, interval, provider: batch.provider,
      ...(batch.provider === 'tencent' && { priceBasis: 'tencent-minute-native' as const }) };
  }
  // Aggregate each previous, complete trading date once and the current session snapshot once.
  // A skipped or suspended date is ambiguous and therefore leaves the weekly/monthly quote price-only.
  const daily = new Map(batch.rows.map(r => [r.time, r.prices]));
  const todayStart = quotePeriodBounds('cn', '1d', time)!.start;
  let previous: Prices | undefined;
  for (let day = bounds.start; day < todayStart; day += 86400) {
    if (equitySessionOn('cn', equityExchangeClock('cn', day).date).status !== 'open') continue;
    const p = daily.get(day);
    if (!p) return;
    previous = previous ? { open: previous.open, high: Math.max(previous.high, p.high),
      low: Math.min(previous.low, p.low), close: p.close, volume: previous.volume + p.volume } : p;
  }
  const p = previous ? { open: previous.open, high: Math.max(previous.high, today.high),
    low: Math.min(previous.low, today.low), close: today.close, volume: previous.volume + today.volume } : today;
  return { ...p, ...bounds, interval, provider: batch.provider };
}

function tradingSegment(time: number) {
  const { date, minute } = equityExchangeClock('cn', time);
  const segment = equitySessionOn('cn', date).segments.find(s => minute >= s.start && minute < s.end);
  return segment ? date + '/' + segment.start : null;
}

/** A personal-workstation poll of public exchange-traded quotes, without a tick-by-tick entitlement. */
export async function getChinaLiveQuote(symbol: string, fetcher = fetch, nowMs = Date.now(), series?: Series): Promise<ChinaLiveQuote | null> {
  const id = instrument(symbol);
  const started = Date.now();
  const now = () => Math.floor((nowMs + Date.now() - started) / 1000);
  if (!id || !tradingSegment(now())) return null;
  const sources: Source[] = series?.source.includes('push2his.eastmoney.com') ? ['eastmoney', 'tencent'] : ['tencent', 'eastmoney'];
  const native = series ? readNativeBars(id, series, fetcher).catch(() => null) : null;
  let receivedResponse = false;
  for (const provider of sources) {
    let snapshot: Snapshot | null;
    try { snapshot = await readSnapshot(id, provider, fetcher); receivedResponse = true; }
    catch { continue; }
    if (!snapshot || !validPrices(snapshot.prices)) continue;
    const { time, prices: sessionBar } = snapshot;
    const bar = await native;
    const current = now();
    if (!Number.isSafeInteger(time) || time > current || current - time > 30 ||
        !tradingSegment(time) || tradingSegment(time) !== tradingSegment(current)) continue;
    const quote: ChinaLiveQuote = { symbol, market: 'cn', currency: 'CNY', venue: id.venue, provider,
      price: sessionBar.close, time, sessionBar };
    if (series && bar) {
      const selected = selectedBar(bar, series.interval, time, sessionBar);
      if (selected) quote.bar = selected;
    }
    return quote;
  }
  if (!receivedResponse) throw new Error('A股报价源暂时无法连接。');
  return null;
}
