export interface HubCapabilities {
  configured: boolean;
  ready: boolean;
  status: string;
  memberId?: number;
  quoteLevel?: string;
  usRealtime: boolean;
  hkRealtime: boolean;
  cnRealtime: boolean;
  packages: Array<{ key: string; name: string; description?: string }>;
}

export interface HubNormalizedCandlestick {
  time: number;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number | null;
  session: 'Intraday' | 'Pre' | 'Post' | 'Overnight';
}

export interface HubNormalizedPrePostQuote {
  lastDone: number | null;
  timestamp: string | null;
  time: number | null;
  volume: number;
  turnover: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
}

export interface HubNormalizedQuote {
  symbol: string;
  market: 'US' | 'HK' | 'CN';
  lastDone: number | null;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  timestamp: string;
  time: number;
  volume: number;
  turnover: number | null;
  tradeStatus: string;
  preMarketQuote: HubNormalizedPrePostQuote | null;
  postMarketQuote: HubNormalizedPrePostQuote | null;
  overnightQuote: HubNormalizedPrePostQuote | null;
}

export interface HubNormalizedStaticInfo {
  symbol: string;
  market: 'US' | 'HK' | 'CN';
  nameCn: string;
  nameEn: string;
  nameHk: string;
  exchange: string;
  currency: string;
  lotSize: number;
  board: string;
}

export class HubHttpError extends Error {
  status: number;
  code: string;
  upstreamCode?: number;

  constructor(status: number, code: string, message: string, upstreamCode?: number) {
    super(message);
    this.name = 'HubHttpError';
    this.status = status;
    this.code = code;
    this.upstreamCode = upstreamCode;
  }
}

export interface LongbridgeHubConfig {
  baseUrl: string;
  token: string;
}

export function getLongbridgeHubConfig(): LongbridgeHubConfig | null {
  if (process.env.TREND_WORKBENCH_LONGBRIDGE_HUB === '0') return null;
  const baseUrl = process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_URL?.trim().replace(/\/+$/, '');
  if (!baseUrl) return null;
  const token = process.env.TREND_WORKBENCH_LONGBRIDGE_HUB_TOKEN?.trim()
    || process.env.LB_HUB_API_TOKEN?.trim()
    || '';
  return { baseUrl, token };
}

export function isLongbridgeHubConfigured(): boolean {
  return getLongbridgeHubConfig() !== null;
}

export function toLongbridgeTicker(market: 'us' | 'hk' | 'cn', symbol: string): string | null {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return null;
  if (market === 'us') {
    if (clean.startsWith('^')) return null;
    const stem = clean.endsWith('.US') ? clean.slice(0, -3) : clean;
    return `${stem.replace(/-/g, '.')}.US`;
  }
  if (market === 'hk') {
    const stem = clean.endsWith('.HK') ? clean.slice(0, -3) : clean;
    if (/^\d+$/.test(stem)) {
      const stripped = stem.replace(/^0+/, '') || '0';
      return `${stripped}.HK`;
    }
    return `${stem}.HK`;
  }
  if (clean.endsWith('.BJ')) return null;
  return clean.endsWith('.SH') || clean.endsWith('.SZ') ? clean : null;
}

export function fromLongbridgeTicker(market: 'us' | 'hk' | 'cn', ticker: string): string {
  const clean = ticker.trim().toUpperCase();
  if (market === 'us') {
    const stem = clean.endsWith('.US') ? clean.slice(0, -3) : clean;
    return stem.replace(/\./g, '-');
  }
  if (market === 'hk') {
    const stem = clean.endsWith('.HK') ? clean.slice(0, -3) : clean;
    if (/^\d{1,5}$/.test(stem)) return `${stem.padStart(5, '0')}.HK`;
    return `${stem}.HK`;
  }
  return clean;
}

function hasQuoteLevel(quoteLevel: string, prefixes: string[], realtimeRe: RegExp): boolean {
  const entries = quoteLevel.split(';').map(s => s.trim()).filter(Boolean);
  return entries.some(entry => {
    const colon = entry.indexOf(':');
    const prefix = colon > 0 ? entry.slice(0, colon).toUpperCase() : '';
    if (!prefixes.includes(prefix)) return false;
    if (/\|(?:Delay|LV0)\b/i.test(entry)) return false;
    return realtimeRe.test(entry);
  });
}

export function parseHubCapabilities(health: unknown, configured = true): HubCapabilities {
  if (!configured) {
    return {
      configured: false,
      ready: false,
      status: 'unconfigured',
      usRealtime: false,
      hkRealtime: false,
      cnRealtime: false,
      packages: [],
    };
  }
  const root = health && typeof health === 'object' ? health as Record<string, unknown> : {};
  const upstream = root.upstream && typeof root.upstream === 'object'
    ? root.upstream as Record<string, unknown>
    : root;
  const status = typeof upstream.status === 'string'
    ? upstream.status
    : typeof root.status === 'string'
      ? root.status
      : 'unknown';
  const ready = Boolean(upstream.ready === true && (status === 'connected' || status === 'ok'));
  const memberId = typeof upstream.memberId === 'number' && Number.isFinite(upstream.memberId)
    ? upstream.memberId
    : undefined;
  const quoteLevel = typeof upstream.quoteLevel === 'string' ? upstream.quoteLevel : undefined;
  const rawPackages = Array.isArray(upstream.packages) ? upstream.packages : [];
  const packages: HubCapabilities['packages'] = [];
  for (const item of rawPackages) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const key = typeof rec.key === 'string' ? rec.key.trim() : '';
    const name = typeof rec.name === 'string' ? rec.name.trim() : key;
    if (!key && !name) continue;
    packages.push({
      key,
      name,
      ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
    });
  }
  if (!ready) {
    return {
      configured: true,
      ready: false,
      status,
      ...(memberId !== undefined ? { memberId } : {}),
      ...(quoteLevel ? { quoteLevel } : {}),
      usRealtime: false,
      hkRealtime: false,
      cnRealtime: false,
      packages,
    };
  }

  const ql = quoteLevel ?? '';
  const cnRealtime = packages.some(p => /^CN_(?:L[12]|LV[12])(?:_|$)/i.test(p.key) && !/basic|delay/i.test(p.key))
    || hasQuoteLevel(ql, ['SHAA', 'SZAA'], /\|LV[12]\b/i);
  const hkRealtime = packages.some(p => /^HK_(?:L[12]|LV[12]|HangSeng)/i.test(p.key) && !/basic|delay/i.test(p.key))
    || hasQuoteLevel(ql, ['HKAA', 'HKAB'], /\|LV[12]\b/i);
  const usRealtime = packages.some(p => /^US_(?:QBBO|NBBO|L[12]|LV[12]|Totalview)/i.test(p.key) && !/basic|delay/i.test(p.key))
    || hasQuoteLevel(ql, ['USAA', 'USON'], /\|(?:NBBO|LV[12])\b/i);

  return {
    configured: true,
    ready: true,
    status,
    ...(memberId !== undefined ? { memberId } : {}),
    ...(quoteLevel ? { quoteLevel } : {}),
    usRealtime,
    hkRealtime,
    cnRealtime,
    packages,
  };
}

let customFetcher: typeof fetch | null = null;
let capabilitiesCache: { key: string; expires: number; value: HubCapabilities } | null = null;
let capabilitiesInflight: Promise<HubCapabilities> | null = null;

/** Tests inject a custom fetch function so no real HTTP requests are made. */
export function setLongbridgeHubFetcher(fetcher: typeof fetch | null) {
  customFetcher = fetcher;
  resetLongbridgeHubState();
}

export function resetLongbridgeHubState() {
  capabilitiesCache = null;
  capabilitiesInflight = null;
}

async function doFetch(url: string, init: RequestInit): Promise<Response> {
  const fn = customFetcher ?? fetch;
  return fn(url, init);
}

export async function getLongbridgeHubCapabilities(options?: { force?: boolean }): Promise<HubCapabilities> {
  const cfg = getLongbridgeHubConfig();
  if (!cfg) return parseHubCapabilities(null, false);
  const cacheKey = `${cfg.baseUrl}|${Boolean(cfg.token)}`;
  const now = Date.now();
  if (!options?.force && capabilitiesCache && capabilitiesCache.key === cacheKey && capabilitiesCache.expires > now) {
    return capabilitiesCache.value;
  }
  if (!options?.force && capabilitiesInflight) return capabilitiesInflight;

  let task: Promise<HubCapabilities> | undefined;
  task = (async (): Promise<HubCapabilities> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    timer.unref?.();
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      const res = await doFetch(`${cfg.baseUrl}/health`, { headers, signal: controller.signal });
      if (!res.ok) {
        const failed = parseHubCapabilities({ status: 'error', ready: false }, true);
        capabilitiesCache = { key: cacheKey, expires: Date.now() + 10_000, value: failed };
        return failed;
      }
      const body = await res.json() as unknown;
      const caps = parseHubCapabilities(body, true);
      capabilitiesCache = {
        key: cacheKey,
        expires: Date.now() + (caps.ready ? 60_000 : 10_000),
        value: caps,
      };
      return caps;
    } catch {
      const failed = parseHubCapabilities({ status: 'unreachable', ready: false }, true);
      capabilitiesCache = { key: cacheKey, expires: Date.now() + 10_000, value: failed };
      return failed;
    } finally {
      clearTimeout(timer);
      if (capabilitiesInflight === task) capabilitiesInflight = null;
    }
  })();

  if (!options?.force) capabilitiesInflight = task;
  return task;
}

export async function hubRequestJson<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  options?: { priority?: 'high' | 'low'; timeoutMs?: number },
): Promise<T> {
  const cfg = getLongbridgeHubConfig();
  if (!cfg) {
    throw new HubHttpError(503, 'HUB_UNCONFIGURED', 'Longbridge Hub 未配置。');
  }
  const url = new URL(`${cfg.baseUrl}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  if (options?.priority === 'low') headers['X-Priority'] = 'low';

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 12_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await doFetch(url.toString(), { headers, signal: controller.signal });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { /* handled below */ }
    }
    if (!res.ok) {
      const errObj = parsed && typeof parsed === 'object' && 'error' in parsed
        ? (parsed as { error?: Record<string, unknown> }).error
        : undefined;
      const code = typeof errObj?.code === 'string' ? errObj.code : `HTTP_${res.status}`;
      const message = typeof errObj?.message === 'string' ? errObj.message : `Longbridge Hub returned HTTP ${res.status}`;
      const upstreamCode = typeof errObj?.upstreamCode === 'number' ? errObj.upstreamCode : undefined;
      throw new HubHttpError(res.status, code, message, upstreamCode);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new HubHttpError(502, 'INVALID_JSON', 'Longbridge Hub returned invalid JSON');
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof HubHttpError) throw error;
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'Longbridge Hub 请求超时'
      : '无法连接 Longbridge Hub 服务';
    throw new HubHttpError(502, 'HUB_NETWORK_ERROR', message);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHubCandles(options: {
  ticker: string;
  period: string;
  count: number;
  adjust?: 'none' | 'forward';
  session?: 'intraday' | 'all';
  priority?: 'high' | 'low';
}): Promise<{ candles: HubNormalizedCandlestick[]; source?: string }> {
  return hubRequestJson('/v1/kline', {
    symbol: options.ticker,
    period: options.period,
    count: options.count,
    adjust: options.adjust ?? 'none',
    session: options.session ?? 'intraday',
  }, { priority: options.priority });
}

export async function fetchHubHistory(options: {
  ticker: string;
  period: string;
  adjust?: 'none' | 'forward';
  session?: 'intraday' | 'all';
  mode?: 'date' | 'offset';
  start?: string;
  end?: string;
  datetime?: string;
  forward?: boolean;
  count?: number;
  priority?: 'high' | 'low';
}): Promise<{ candles: HubNormalizedCandlestick[] }> {
  return hubRequestJson('/v1/kline/history', {
    symbol: options.ticker,
    period: options.period,
    adjust: options.adjust ?? 'none',
    session: options.session ?? 'intraday',
    mode: options.mode ?? (options.start || options.end ? 'date' : 'offset'),
    start: options.start,
    end: options.end,
    datetime: options.datetime,
    forward: options.forward,
    count: options.count,
  }, { priority: options.priority ?? 'low' });
}

export async function fetchHubQuotes(
  tickers: string[],
  priority: 'high' | 'low' = 'high',
): Promise<{ quotes: HubNormalizedQuote[] }> {
  return hubRequestJson('/v1/quote', {
    symbols: tickers.join(','),
  }, { priority, timeoutMs: 8_000 });
}

export async function fetchHubStatic(
  tickers: string[],
  priority: 'high' | 'low' = 'high',
): Promise<{ items: HubNormalizedStaticInfo[] }> {
  return hubRequestJson('/v1/static', {
    symbols: tickers.join(','),
  }, { priority, timeoutMs: 8_000 });
}
