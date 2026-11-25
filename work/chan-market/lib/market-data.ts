import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Candle, Instrument, Interval, Market, MarketData } from './market-types';
import { getCryptoCandles, getCryptoHistory, searchCrypto, CryptoDataError, resetMarketNetworkFailures as resetCryptoSources } from './crypto-sources.ts';
import { HistoryBoundary,loadYahooHistory,yahooHistoryWindow,type YahooHistoryWindow } from './history-window.ts';
export { getSpotFlow } from './spot-flow.ts';
export { getBattleTape } from './battle-tape.ts';
export { latestHistoryGap } from './history-gaps.ts';
export { getJournalMinutes } from './journal-minute-feed.ts';
import { aggregateEquityFourHour } from './equity-four-hour.ts';
import { equityExchangeClock, equitySessionOn } from './equity-calendar.ts';
import { candleAvailableAt, candleDelaySeconds } from './timeframe-context.ts';
import { chooseEquityHistory } from './equity-history.ts';
import { withHistoryCoverage } from './history-coverage.ts';
import { COMMODITY_INSTRUMENTS, searchCommodities } from './commodity-catalog.ts';
import { getCommodityCandles } from './commodity-data.ts';
import { commoditySessionOpen } from './commodity-session.ts';
import { getChinaLiveQuote } from './cn-live-quote.ts';
import { getLicensedLiveQuote } from './licensed-live-quote.ts';
import { usExtendedSessionInfo, type QuoteSession } from './quote-overlay.ts';
import {
  fetchHubCandles,
  fetchHubHistory,
  fetchHubQuotes,
  fetchHubStatic,
  getLongbridgeHubCapabilities,
  HubHttpError,
  isLongbridgeHubConfigured,
  resetLongbridgeHubState,
  toLongbridgeTicker,
  type HubNormalizedCandlestick,
  type HubNormalizedQuote,
} from './longbridge-hub.ts';
export { getLongbridgeHubCapabilities, isLongbridgeHubConfigured, toLongbridgeTicker };

/** Read-only market data for the selected instrument. */
export class MarketError extends Error {
  status: number;
  upstreamStatus?: number;
  code?: number;
  constructor(message: string, status = 502, upstreamStatus?: number, code?: number) { super(message); this.name = 'MarketError'; this.status = status; this.upstreamStatus = upstreamStatus; this.code = code; }
}
const ALL_INTERVALS: Interval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'];
export const AVAILABLE_INTERVALS: Record<Market, Interval[]> = {
  crypto: ALL_INTERVALS,
  us: ALL_INTERVALS,
  hk: ALL_INTERVALS,
  cn: ALL_INTERVALS,
  commodity: ALL_INTERVALS,
};
const MINUTES: Record<Exclude<Interval, '1M'>, number> = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 };
const isCalendarBar = (interval: Interval) => ['1d', '1w', '1M'].includes(interval);
const eastmoneyPeriod = (interval: Interval) => interval === '1M' ? '103' : interval === '1w' ? '102' : interval === '1d' ? '101' : String(MINUTES[interval]);
const US_EXCHANGES = new Set(['NMS','NGM','NCM','NYQ','ASE','PCX','BTS','BATS','PNK','OQB','OQX','OBB','CXI','DJI','SNP','WCB']);
interface YahooSearch {quotes?:{exchange:string;quoteType:string;symbol:string;shortname?:string;longname?:string;exchDisp?:string}[]}
interface YahooChart {chart?:{error?:unknown;result?:{meta?:{dataGranularity?:string;exchangeTimezoneName?:string;currentTradingPeriod?:{regular?:{end:number}};longName?:string;shortName?:string;fullExchangeName?:string;exchangeName?:string;currency?:string};timestamp?:number[];indicators?:{quote?:{open:(number|null)[];high:(number|null)[];low:(number|null)[];close:(number|null)[];volume:(number|null)[]}[];adjclose?:{adjclose:(number|null)[]}[]}}[]}}
interface EastmoneyData {data?:{code:string;market:number;name?:string;klines?:string[]}}
let yahooUnavailableUntil = 0;
let yahooSearchUnavailableUntil = 0;
let cnEastmoneyUnavailableUntil = 0;
let longbridgeUnavailableUntil = 0;
let longbridgeHistoryUnavailableUntil = 0;
let longbridgeHistoryUnsupportedUntil = 0;
let longbridgeQuoteUnavailableUntil = 0;
let longbridgeHubKlineUnavailableUntil = 0;
let longbridgeHubHistoryUnavailableUntil = 0;
let longbridgeHubHistoryUnsupportedUntil = 0;
let longbridgeHubQuoteUnavailableUntil = 0;
interface LongbridgeExtendedSubQuote { last?: unknown; timestamp?: unknown }
interface LongbridgeQuotePayload {
  symbol?: unknown;
  last?: unknown;
  status?: unknown;
  pre_market?: LongbridgeExtendedSubQuote;
  post_market?: LongbridgeExtendedSubQuote;
  overnight?: LongbridgeExtendedSubQuote;
}
const longbridgeQuoteCache = new Map<string, { expires: number; row: LongbridgeQuotePayload | null }>();
const longbridgeHubStaticCache = new Map<string, { name: string; exchange: string }>();
/** A network-route change (sleep/wake, VPN switch) re-arms every provider cooldown, not only crypto. */
export function resetMarketNetworkFailures() {
  resetCryptoSources();
  resetLongbridgeHubState();
  yahooUnavailableUntil = 0;
  yahooSearchUnavailableUntil = 0;
  cnEastmoneyUnavailableUntil = 0;
  longbridgeUnavailableUntil = 0;
  longbridgeHistoryUnavailableUntil = 0;
  longbridgeHistoryUnsupportedUntil = 0;
  longbridgeQuoteUnavailableUntil = 0;
  longbridgeHubKlineUnavailableUntil = 0;
  longbridgeHubHistoryUnavailableUntil = 0;
  longbridgeHubHistoryUnsupportedUntil = 0;
  longbridgeHubQuoteUnavailableUntil = 0;
  longbridgeQuoteCache.clear();
}
const cache = new Map<string, { expires: number; value: Promise<unknown> }>();
async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
  if (cache.size > 160) { for (const [k,v] of cache) if (v.expires < Date.now()) cache.delete(k); if (cache.size > 160) cache.delete(cache.keys().next().value!); }
  const value = fn().catch(error => {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw error;
  });
  cache.set(key, { expires: Date.now() + ttl, value });
  return value;
}
async function upstream(url: string, encoding = 'utf-8'): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChanObservatory/1.0)', Accept: 'application/json,text/plain,*/*' } });
    if (!response.ok) throw new MarketError(response.status === 429 ? '行情源限流，请稍后重试。' : `行情源返回 HTTP ${response.status}。`, response.status === 404 ? 404 : 502, response.status);
    return new TextDecoder(encoding).decode(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof MarketError) throw error;
    throw new MarketError('行情源暂时无法连接或请求超时，请重试。');
  } finally { clearTimeout(timer); }
}
async function json<T>(url: string): Promise<T> {
  try { return JSON.parse(await upstream(url)) as T; }
  catch (error) { if (error instanceof MarketError) throw error; throw new MarketError('行情源返回格式异常，未使用替代价格。'); }
}
function instrument(market: Market, symbol: string, name: string, exchange: string, currency: string): Instrument {
  return { id: `${market}:${symbol}`, market, symbol, name, exchange, currency };
}
const popularRows: Record<Exclude<Market,'commodity'>, [string, string, string, string][]> = {
  crypto: [['BTCUSDT','比特币 Bitcoin','Binance','USDT'],['ETHUSDT','以太坊 Ethereum','Binance','USDT'],['SOLUSDT','Solana','Binance','USDT'],['BNBUSDT','BNB','Binance','USDT'],['XRPUSDT','XRP','Binance','USDT'],['DOGEUSDT','Dogecoin','Binance','USDT'],['ADAUSDT','Cardano','Binance','USDT'],['AVAXUSDT','Avalanche','Binance','USDT'],['LINKUSDT','Chainlink','Binance','USDT'],['SUIUSDT','Sui','Binance','USDT'],['LTCUSDT','Litecoin','Binance','USDT'],['DOTUSDT','Polkadot','Binance','USDT']],
  us: [['AAPL','苹果 Apple','NASDAQ','USD'],['MSFT','微软 Microsoft','NASDAQ','USD'],['NVDA','英伟达 NVIDIA','NASDAQ','USD'],['TSLA','特斯拉 Tesla','NASDAQ','USD'],['AMZN','亚马逊 Amazon','NASDAQ','USD'],['GOOGL','谷歌 Alphabet','NASDAQ','USD'],['META','Meta Platforms','NASDAQ','USD'],['AMD','AMD','NASDAQ','USD'],['COIN','Coinbase','NASDAQ','USD'],['MSTR','Strategy','NASDAQ','USD'],['SPY','标普500 ETF','NYSE Arca','USD'],['QQQ','纳斯达克100 ETF','NASDAQ','USD']],
  hk: [['00700.HK','腾讯控股 tengxunkonggu txkg','港交所','HKD'],['09988.HK','阿里巴巴-W alibaba albb','港交所','HKD'],['03690.HK','美团-W meituan mt','港交所','HKD'],['01810.HK','小米集团-W xiaomijituan xmjt','港交所','HKD'],['09618.HK','京东集团-SW jingdongjituan jd','港交所','HKD'],['09888.HK','百度集团-SW baidujituan bd','港交所','HKD'],['01211.HK','比亚迪股份 biyadigufen byd','港交所','HKD'],['00941.HK','中国移动 zhongguoyidong zgyd','港交所','HKD'],['00005.HK','汇丰控股 huifengkonggu hfkg','港交所','HKD'],['00388.HK','香港交易所 xianggangjiaoyisuo gj','港交所','HKD'],['00981.HK','中芯国际 zhongxinguoji zxgj','港交所','HKD'],['02800.HK','盈富基金 yingfujijin yfjj','港交所','HKD']],
  cn: [['600519.SH','贵州茅台 guizhoumaotai gzmt','上交所','CNY'],['300750.SZ','宁德时代 ningdeshidai ndsd','深交所','CNY'],['002594.SZ','比亚迪 biyadi byd','深交所','CNY'],['000001.SZ','平安银行 pinganyinhang payh','深交所','CNY'],['600036.SH','招商银行 zhaoshangyinhang zsyh','上交所','CNY'],['601318.SH','中国平安 zhongguopingan zgpa','上交所','CNY'],['600900.SH','长江电力 changjiangdianli cjdl','上交所','CNY'],['000858.SZ','五粮液 wuliangye wly','深交所','CNY'],['000333.SZ','美的集团 meidijituan mdjt','深交所','CNY'],['688981.SH','中芯国际 zhongxinguoji zxgj','上交所','CNY'],['300059.SZ','东方财富 dongfangcaifu dfcf','深交所','CNY'],['920599.BJ','同力股份 tongligufen tlgf','北交所','CNY']],
};
function popular(market: Market, q: string): Instrument[] {
  if (market === 'commodity') return searchCommodities(q);
  const key = q.toLowerCase().replace(/[\s/]/g, '');
  return popularRows[market].filter(row => !key || row.slice(0,2).join('').toLowerCase().replace(/\s/g, '').includes(key)).map(row => instrument(market, row[0], (market === 'cn' || market === 'hk') ? row[1].split(' ')[0] : row[1], row[2], row[3]));
}
function unique(rows: Instrument[]): Instrument[] {
  const found = new Map<string, Instrument>();
  for (const row of rows) if (!found.has(row.id)) found.set(row.id, row);
  return [...found.values()].slice(0, 30);
}
export type SearchMarket = Market | 'all';
interface SearchResult { results: Instrument[]; warning?: string }
const SEARCH_MARKETS: Market[] = ['crypto', 'commodity', 'us', 'cn', 'hk'];
const MARKET_NAMES: Record<Market, string> = { crypto: '加密货币', commodity:'大宗商品', us: '美股', hk: '港股', cn: 'A股' };
export function parseSearchMarket(value: string | null): SearchMarket {
  return !value || value === 'all' ? 'all' : parseMarket(value);
}
export function parseMarket(value: string | null): Market {
  if (value === 'crypto' || value === 'us' || value === 'hk' || value === 'cn' || value === 'commodity') return value;
  throw new MarketError('请选择有效的市场。', 400);
}
export function parseInterval(value: string | null, market: Market): Interval {
  if (!value || !ALL_INTERVALS.includes(value as Interval)) throw new MarketError('不支持的K线周期。', 400);
  if (!AVAILABLE_INTERVALS[market].includes(value as Interval)) throw new MarketError('该市场不提供所选K线周期。', 422);
  return value as Interval;
}
export function normalizeSymbol(market: Market, input: string): string {
  const value = input.trim().toUpperCase();
  if (market === 'commodity') {
    const contract = COMMODITY_INSTRUMENTS.find(item=>item.symbol===value);
    if (!contract) throw new MarketError('请选择黄金、白银或WTI原油期货。',400);
    return contract.symbol;
  }
  if (market === 'crypto') {
    const symbol = value.replace(/\//g, '');
    if (!/^[A-Z0-9]{4,30}$/.test(symbol)) throw new MarketError('请输入有效的现货交易对，例如 BTCUSDT。', 400);
    return symbol;
  }
  if (market === 'us') {
    if (!/^[A-Z^][A-Z0-9.^-]{0,19}$/.test(value) || /\.(SS|SZ|HK|L|TO|AX|DE|PA|T)$/.test(value)) throw new MarketError('请输入美股代码，例如 AAPL、BRK-B。', 400);
    return value.replace(/\./g, '-');
  }
  if (market === 'hk') {
    const numMatch = value.match(/^(?:HK)?(\d{1,5})(?:\.HK)?$/);
    if (numMatch) return `${numMatch[1].padStart(5, '0')}.HK`;
    const alphaMatch = value.match(/^([A-Z][A-Z0-9]{1,11})(?:\.HK)?$/);
    if (alphaMatch) return `${alphaMatch[1]}.HK`;
    throw new MarketError('请输入港股代码，例如 00700.HK、700。', 400);
  }
  const match = value.match(/^(?:(SH|SZ|BJ))?(\d{6})(?:\.(SH|SZ|BJ|SS))?$/);
  if (!match || (match[1] && match[3] && match[1] !== match[3])) throw new MarketError('请输入六位A股代码，或 600519.SH、000001.SZ、920599.BJ。', 400);
  const code = match[2];
  const exchange = (match[1] || match[3] || (/^(4|8|92)/.test(code) ? 'BJ' : /^[569]/.test(code) ? 'SH' : 'SZ')).replace('SS', 'SH');
  if (exchange === 'BJ' && !/^(4|8|92)/.test(code) || exchange !== 'BJ' && /^(4|8|92)/.test(code) || exchange === 'SZ' && /^[569]/.test(code) || exchange === 'SH' && /^[123]/.test(code)) throw new MarketError('代码与沪、深、北交易所后缀不匹配。',400);
  return `${code}.${exchange}`;
}
export function sanitizeCandles(rows: Candle[]): Candle[] {
  const valid = rows.filter(c => [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) && c.time > 0 && c.low > 0 && c.volume >= 0 && c.high >= c.low && c.high >= Math.max(c.open,c.close) - 1e-7 && c.low <= Math.min(c.open,c.close) + 1e-7);
  return [...new Map(valid.map(c => [c.time,c])).values()].sort((a,b) => a.time-b.time);
}

export async function getWorkbenchLiveQuote(params:URLSearchParams, nowMs = Date.now()) {
  const market=parseMarket(params.get('market')), interval=parseInterval(params.get('interval'),market);
  if(market==='crypto')throw new MarketError('加密货币使用独立推送通道。',400);
  const symbol=normalizeSymbol(market,params.get('symbol')??'');
  const source=params.get('source')??'', adjustment=params.get('adjustment')??'';
  const contract=params.get('contract')||undefined;
  if(source.length>200||adjustment.length>200||(contract&&
    (market!=='commodity'||!/^(?:GC|CL|SI)[FGHJKMNQUVXZ]\d{2}$/.test(contract)||!contract.startsWith(symbol.split('=')[0]))))
    throw new MarketError('报价参数有误。',400);
  const seconds=Math.floor(nowMs/1000);
  let regularOpen:boolean;
  if(market==='commodity')regularOpen=commoditySessionOpen(seconds);
  else{
    const clock=equityExchangeClock(market,seconds);
    regularOpen=equitySessionOn(market,clock.date).segments.some(s=>clock.minute>=s.start&&clock.minute<s.end);
  }
  const hub=await getLongbridgeHubCapabilities();
  const lbCliEnabled=market==='us'&&longbridgeOvernightEnabled()&&!symbol.startsWith('^');
  const lbHubEnabled=hub.ready&&(
    (market==='us'&&hub.usRealtime&&!symbol.startsWith('^'))
    ||(market==='hk'&&hub.hkRealtime)
    ||(market==='cn'&&hub.cnRealtime&&!symbol.endsWith('.BJ'))
  );
  const extended=market==='us'&&(lbCliEnabled||lbHubEnabled)?usExtendedSessionInfo(seconds):null;
  const identity={market,symbol,interval};
  if(!regularOpen&&!extended)return {...identity,status:'closed'};
  const key=JSON.stringify(['live-quote',market,symbol,interval,source,adjustment,contract]);
  return cached(key,3000,async()=>{
    if(market==='cn'){
      if(lbHubEnabled&&longbridgeHubQuoteUnavailableUntil<=Date.now()){
        const ticker=toLongbridgeTicker('cn',symbol);
        if(ticker){
          try{
            const {quotes}=await fetchHubQuotes([ticker]);
            const hubResult=parseLongbridgeHubRegularQuote('cn',symbol,quotes[0],nowMs);
            if(hubResult.status==='quote')return {...identity,...hubResult};
          }catch(error){
            if(error instanceof HubHttpError&&error.status===429)longbridgeHubQuoteUnavailableUntil=Date.now()+30_000;
            else if(!(error instanceof HubHttpError)||error.status!==404)longbridgeHubQuoteUnavailableUntil=Date.now()+60_000;
          }
        }
      }
      const quote=await getChinaLiveQuote(symbol,fetch,nowMs,{interval,source,adjustment});
      return quote?{...identity,status:'quote',quote}:{...identity,status:'stale'};
    }
    if(market==='hk'){
      if(!lbHubEnabled)return {...identity,status:'unconfigured'};
      if(longbridgeHubQuoteUnavailableUntil>Date.now())return {...identity,status:'unavailable'};
      const ticker=toLongbridgeTicker('hk',symbol);
      if(!ticker)return {...identity,status:'unavailable'};
      try{
        const {quotes}=await fetchHubQuotes([ticker]);
        return {...identity,...parseLongbridgeHubRegularQuote('hk',symbol,quotes[0],nowMs)};
      }catch(error){
        if(error instanceof HubHttpError&&error.status===429)longbridgeHubQuoteUnavailableUntil=Date.now()+30_000;
        else if(!(error instanceof HubHttpError)||error.status!==404)longbridgeHubQuoteUnavailableUntil=Date.now()+60_000;
        return {...identity,status:'unavailable'};
      }
    }
    if(market==='us'&&lbHubEnabled&&extended&&(source.startsWith('Longbridge ')||!regularOpen)){
      if(longbridgeHubQuoteUnavailableUntil<=Date.now()){
        const ticker=toLongbridgeTicker('us',symbol);
        if(ticker){
          try{
            const {quotes}=await fetchHubQuotes([ticker]);
            const hubResult=parseLongbridgeLiveQuote(symbol,quotes[0]?toLongbridgeQuotePayload(quotes[0]):null,nowMs);
            if(hubResult.status==='quote'||(!regularOpen&&!lbCliEnabled))return {...identity,...hubResult};
          }catch(error){
            if(error instanceof HubHttpError&&error.status===429)longbridgeHubQuoteUnavailableUntil=Date.now()+30_000;
            else if(!(error instanceof HubHttpError)||error.status!==404)longbridgeHubQuoteUnavailableUntil=Date.now()+60_000;
          }
        }
      }
    }
    if(market==='us'&&lbCliEnabled&&extended&&(source.startsWith('Longbridge ')||!regularOpen)){
      const lbResult=parseLongbridgeLiveQuote(symbol,await fetchLongbridgeQuoteRow(symbol),nowMs);
      if(lbResult.status==='quote'||!regularOpen)return {...identity,...lbResult};
      return {...identity,...await getLicensedLiveQuote(market,symbol,interval,{contract,nowMs})};
    }
    const licensed=await getLicensedLiveQuote(market,symbol,interval,{contract,nowMs});
    if(market==='us'&&licensed.status!=='quote'&&extended){
      if(lbHubEnabled&&longbridgeHubQuoteUnavailableUntil<=Date.now()){
        const ticker=toLongbridgeTicker('us',symbol);
        if(ticker){
          try{
            const {quotes}=await fetchHubQuotes([ticker]);
            const hubResult=parseLongbridgeLiveQuote(symbol,quotes[0]?toLongbridgeQuotePayload(quotes[0]):null,nowMs);
            if(hubResult.status==='quote')return {...identity,...hubResult};
          }catch{/* fallback below */}
        }
      }
      if(lbCliEnabled){
        const lbResult=parseLongbridgeLiveQuote(symbol,await fetchLongbridgeQuoteRow(symbol),nowMs);
        if(lbResult.status==='quote')return {...identity,...lbResult};
      }
    }
    return {...identity,...licensed};
  });
}

/** Load a strictly earlier page from the live series' original venue and price basis. */
export async function getOlderHistory(params:URLSearchParams) {
  const market=parseMarket(params.get('market')), interval=parseInterval(params.get('interval'),market);
  const symbol=normalizeSymbol(market,params.get('symbol')??'');
  const source=params.get('source')??'',adjustment=params.get('adjustment')??'';
  const before=Number(params.get('before')),limit=Number(params.get('limit')??500),now=Date.now()/1000;
  const contract=params.get('contract');
  if(contract&&(market!=='commodity'||!/^(?:GC|SI|CL)[FGHJKMNQUVXZ]\d{2}$/.test(contract)||!contract.startsWith(symbol.split('=')[0])))
    throw new MarketError('历史合约月份无效。',400);
  if(!Number.isSafeInteger(before)||before<=0||before>now+86400||!Number.isInteger(limit)||limit<1||limit>1000||
    !source||source.length>200||!adjustment||adjustment.length>200)throw new MarketError('历史K线游标、来源或数量无效。',400);
  const response=(status:'more'|'end'|'unsupported',candles:Candle[]=[])=>({market,symbol,interval,source,adjustment,...(contract&&{contract}),status,candles});
  if(market==='crypto'){
    try{
      const page=await getCryptoHistory(symbol,interval,limit,before,source,adjustment);
      return page===null?response('unsupported'):page.length?response('more',page):response('end');
    }catch(error){
      if(error instanceof CryptoDataError)throw new MarketError(error.message,error.status,error.upstreamStatus);
      throw error;
    }
  }
  const aggregate=interval==='4h'&&market!=='commodity';
  const child=aggregate?(source.endsWith(' · 1小时聚合4小时')?'1h':source.endsWith(' · 30分钟聚合4小时')?'30m':null):interval;
  if(!child)return response('unsupported');
  const venue=aggregate?source.slice(0,source.lastIndexOf(' · ')):source;
  const sinaWindow=market==='cn'&&venue==='新浪财经 OHLC（独立备用） · quotes.sina.cn';
  const count=Math.min(2000,aggregate?limit*(child==='1h'?4:8)+8:limit);
  const expectedLbSource=market==='us'?LONGBRIDGE_SOURCE:market==='hk'?LONGBRIDGE_HK_SOURCE:LONGBRIDGE_CN_SOURCE;
  const isLongbridgeVenue=(market==='us'||market==='hk'||market==='cn')&&venue===expectedLbSource;
  if(isLongbridgeVenue){
    if(adjustment!==LONGBRIDGE_ADJUSTMENT)throw new MarketError('历史行情的标的、周期、来源或复权口径与当前图表不一致。');
    const hub=await getLongbridgeHubCapabilities();
    const canUseHub=hub.ready&&((market==='us'&&hub.usRealtime&&!symbol.startsWith('^'))||(market==='hk'&&hub.hkRealtime)||(market==='cn'&&hub.cnRealtime&&!symbol.endsWith('.BJ')));
    if(canUseHub){
      const page=await longbridgeHubHistory(market,symbol,child,before,count,{session:aggregate?'intraday':undefined});
      if(!aggregate)return response(page.status,page.candles.slice(-limit));
      if(page.status!=='more')return response(page.status);
      const agg=aggregateEquityFourHour(page.candles,{market,sourceInterval:child as '1h'|'30m',timestamp:'start',delaySeconds:0});
      const candles=agg.candles.filter(c=>c.time<before&&c.closed!==false).slice(-limit);
      return candles.length?response('more',candles):response('end');
    }
    if(market==='cn'&&hub.configured&&!hub.cnRealtime)return response('unsupported');
    if(!aggregate&&market==='us'&&venue===LONGBRIDGE_SOURCE){
      const page=await longbridgeUsHistory(symbol,child,before,limit);
      return response(page.status,page.candles);
    }
    return response('unsupported');
  }
  let data:MarketData;
  const isYahoo=(market==='commodity'&&/^Yahoo Finance 期货行情 · query[12]\.finance\.yahoo\.com$/.test(venue))||
    (market==='us'&&/^Yahoo Finance 网页行情 · query[12]\.finance\.yahoo\.com$/.test(venue))||
    (market==='hk'&&/^Yahoo Finance 港股网页行情 · query[12]\.finance\.yahoo\.com$/.test(venue));
  if(isYahoo){
    const yahooTicker=market==='hk'?hkYahooSymbol(symbol):symbol;
    const window=yahooHistoryWindow(venue,child,before,count,now)!;
    if(window.start>=before)return response('end');
    try{
      data=market==='commodity'?await getCommodityCandles(symbol,interval,limit,fetch,Date.now(),window)
        :market==='hk'?await hkYahooCandles(symbol,child,count,window,yahooTicker)
        :await yahooCandles(symbol,child,count,window);
    }catch(error){
      if(error instanceof HistoryBoundary)return response(error.status);
      throw error;
    }
  }else{
    if(market==='commodity')return response('unsupported');
    const calendar=isCalendarBar(child);
    const zone=(market==='cn'||market==='hk'||!calendar)?'Asia/Shanghai':'America/New_York';
    const endDate=localClock(before,zone).date;
    // Date-based feeds include all bars from the cursor date. Fetch enough
    // overlap even when the requested output page is a single bar.
    const padding=calendar?2:Math.ceil(390/MINUTES[child as Exclude<Interval,'1M'>])+2;
    if(market==='cn'&&venue==='东方财富 网页行情 · push2his.eastmoney.com')data=await cnEastmoneyCandles(symbol,child,count+padding,endDate);
    else if(market==='us'&&venue==='东方财富 美股网页行情（备用） · push2his.eastmoney.com')data=await usEastmoneyCandles(symbol,child,count+padding,endDate);
    else if(market==='hk'&&venue==='东方财富 港股网页行情 · push2his.eastmoney.com')data=await hkEastmoneyCandles(symbol,child,count+padding,endDate);
    else if(market==='cn'&&calendar&&venue==='腾讯证券 K线（独立备用） · ifzq.gtimg.cn')data=await cnTencentCandles(symbol,child,Math.min(640,count+padding),endDate);
    else if(market==='us'&&(child==='1w'||child==='1M')&&venue===`腾讯证券 原生美股${child==='1w'?'周':'月'}K · ifzq.gtimg.cn`)data=await usTencentCalendar(symbol,child,Math.min(640,count+padding),endDate);
    else if(sinaWindow)data=await cached(`sina-archive:${symbol}:${child}`,60000,()=>cnSinaCandles(symbol,child,limit,true));
    else if(market==='cn'&&!calendar&&venue==='腾讯证券 K线（独立备用） · ifzq.gtimg.cn')data=await cnTencentCandles(symbol,child,800);
    else return response('unsupported');
  }
  if(data.instrument.symbol!==symbol||data.instrument.market!==market||data.source!==venue||data.interval!==child||data.adjustment!==adjustment||(contract&&data.instrument.contract!==contract))
    throw new MarketError('历史行情的标的、周期、来源或复权口径与当前图表不一致。');
  const rows=aggregate?aggregateEquityFourHour(data.candles,{market,sourceInterval:child as '1h'|'30m',timestamp:isYahoo?'start':'end'}).candles:data.candles;
  const candles=rows.filter(c=>c.time<before&&c.closed!==false).slice(-limit);
  if(candles.length)return response('more',candles);
  // This endpoint has a count, but no backwards cursor or listing-date metadata.
  if(sinaWindow)return response('unsupported');
  if(!rows.length&&data.candles.length)return response('unsupported');
  // Some public endpoints ignore the end date and always send the latest
  // batch. Do not describe that as reaching the listing date.
  if(rows.length&&rows[0].time>before)return response('unsupported');
  return response('end');
}
export function localClock(time: number, zone: string): { date: string; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(time * 1000));
  const p = Object.fromEntries(parts.map(x => [x.type,x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday) };
}
/** Convert a US exchange-local date without assuming a fixed UTC offset. */
function usDateStamp(date: string): number {
  const guess = Date.parse(`${date}T14:30:00Z`)/1000;
  if (!Number.isFinite(guess)) return NaN;
  const clock = localClock(guess,'America/New_York');
  return guess + (570-clock.hour*60-clock.minute)*60;
}
async function tencentHints(q: string, market: 'gp'|'hk'|'us'): Promise<string[][]> {
  const text = await upstream(`https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(q)}&t=${market}`,'gbk');
  const body = text.match(/v_hint\s*=\s*"([\s\S]*?)"/)?.[1];
  if (body === undefined) throw new MarketError('在线标的搜索暂不可用。');
  return body.replace(/\\u([0-9a-fA-F]{4})/g, (_,h) => String.fromCharCode(parseInt(h,16))).split('^').map(s=>s.split('~'));
}
function usHint(row: string[]): { symbol: string; name: string; exchange: string; secid: string } | undefined {
  if (row[0] !== 'us') return;
  const match = row[1]?.toUpperCase().match(/^([A-Z][A-Z0-9.\-]*)\.(OQ|N|AM)$/);
  if (!match) return;
  const markets: Record<string,[string,string]> = {OQ:['105','NASDAQ'],N:['106','NYSE'],AM:['107','NYSE Arca / AMEX']};
  const [id,exchange] = markets[match[2]];
  return { symbol:match[1].replace(/\./g,'-'), name:row[2], exchange, secid:`${id}.${match[1].replace(/\./g,'_')}` };
}
async function usHints(q: string) {
  return cached(`tencent-us:${q.toUpperCase()}`, 30*60000, async () => (await tencentHints(q.replace(/-/g,'.'),'us')).map(usHint).filter((x): x is NonNullable<typeof x> => !!x));
}
/** Calendar bars close conservatively. Monthly bars are confirmed only after local month-end. */
export function stockBarClosed(time: number, interval: Interval, market: 'cn' | 'hk' | 'us', now = Date.now() / 1000, sessionEnd?: number, source = ''): boolean {
  if (!Number.isFinite(time) || !Number.isFinite(now)) return false;
  let available=candleAvailableAt({time},market,interval,source);
  if((market==='us'||market==='hk')&&!isCalendarBar(interval)&&sessionEnd&&sessionEnd>time&&
    equityExchangeClock(market,sessionEnd).date===equityExchangeClock(market,time).date){
    available=Math.min(available,sessionEnd+candleDelaySeconds(market,interval,source));
  }
  return now>=available;
}

function searchRank(row: Instrument, query: string): number {
  const key = query.toLowerCase().replace(/[\s/]/g, '');
  const symbol = row.symbol.toLowerCase(), name = row.name.toLowerCase();
  if (row.name.startsWith('代码查询 ')) return -1;
  if (symbol === key || row.market === 'cn' && symbol.split('.')[0] === key) return 100;
  if (row.market === 'hk' && (symbol.split('.')[0] === key || symbol.split('.')[0].replace(/^0+/, '') === key.replace(/^0+/, ''))) return 100;
  if (row.market === 'cn' || row.market === 'hk') {
    try { if (normalizeSymbol(row.market, query) === row.symbol) return 100; } catch { /* A name or pinyin query. */ }
  }
  if (name.replace(/\s/g, '') === key || name.split(/\s+/).includes(key)) return 90;
  if (row.market === 'crypto' && symbol === key + row.currency.toLowerCase()) return 85;
  if (symbol.startsWith(key) || name.startsWith(key)) return 70;
  if (symbol.includes(key) || name.includes(key)) return 50;
  return 10; // A provider can match Chinese names and pinyin that are not in the display name.
}
function rankSearch(rows: Instrument[], query: string): Instrument[] {
  return unique([...rows].sort((a,b) => searchRank(b,query) - searchRank(a,query)));
}
/** Search markets independently: a slow exchange directory must not hide a matching stock. */
async function boundedMarketSearch(market: Market, query: string): Promise<SearchResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      searchSingleMarket(market, query),
      new Promise<SearchResult>(resolve => {
        timer = setTimeout(() => resolve({ results: popular(market, query), warning: '搜索响应较慢，已显示当前可用结果；可选择该市场重试。' }), 5000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
export async function searchInstruments(market: SearchMarket, query: string): Promise<SearchResult> {
  const q = query.trim().slice(0,60);
  if (market !== 'all') {
    const result = await searchSingleMarket(market,q);
    return { ...result, results: rankSearch(result.results,q) };
  }
  if (!q) return { results: unique(SEARCH_MARKETS.flatMap(m => popular(m,''))) };
  const replies = await Promise.allSettled(SEARCH_MARKETS.map(m => boundedMarketSearch(m,q)));
  const rows: Instrument[] = [], warnings: string[] = [];
  replies.forEach((reply,index) => {
    if (reply.status === 'fulfilled') {
      rows.push(...reply.value.results);
      if (reply.value.warning) warnings.push(`${MARKET_NAMES[SEARCH_MARKETS[index]]}：${reply.value.warning}`);
    } else warnings.push(`${MARKET_NAMES[SEARCH_MARKETS[index]]}搜索暂不可用。`);
  });
  // Direct-code fallbacks are useful when everything fails, but must not crowd out verified matches.
  const verified = rows.filter(row => !row.name.startsWith('代码查询 '));
  const results = rankSearch(verified.length ? verified : rows,q);
  return { results, ...(warnings.length ? {warning: warnings.join('；')} : {}) };
}
async function searchSingleMarket(market: Market, query: string): Promise<SearchResult> {
  const q = query.trim().slice(0,60);
  if (market === 'commodity') return {results:searchCommodities(q)};
  if (!q) return { results: popular(market, ''), warning: '常用标的；输入代码或名称搜索更多。' };
  const local = popular(market,q);
  try {
    return await cached(`search:${market}:${q.toLowerCase()}`, 5 * 60000, async () => {
      if (market === 'crypto') {
        return {results:await searchCrypto(q)};
      }
      if (market === 'us') {
        const key = local[0]?.symbol && /[^\x00-\x7F]/.test(q) ? local[0].symbol : q;
        try {
          if (yahooSearchUnavailableUntil>Date.now()) throw new MarketError('Yahoo搜索暂不可用。');
          const data = await json<YahooSearch>(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(key)}&quotesCount=20&newsCount=0&enableFuzzyQuery=false`);
          if (!Array.isArray(data.quotes)) throw new MarketError('美股搜索暂不可用。');
          const rows = data.quotes.filter(x => US_EXCHANGES.has(x.exchange) && ['EQUITY','ETF','INDEX'].includes(x.quoteType)).map(x => instrument('us',normalizeSymbol('us',x.symbol),x.shortname || x.longname || x.symbol,x.exchDisp || x.exchange,'USD'));
          return { results: unique([...rows,...local]) };
        } catch {
          if (yahooSearchUnavailableUntil<=Date.now()) yahooSearchUnavailableUntil=Date.now()+5*60000;
          const rows = (await usHints(key)).map(x=>instrument('us',x.symbol,x.name,x.exchange,'USD'));
          return {results:unique([...rows,...local]),warning:'Yahoo搜索暂不可用，已切换腾讯美股搜索；支持范围取决于备用源收录。'};
        }
      }
      if (market === 'hk') {
        if (/^(?:SH|SZ|BJ)?\d{6}(?:\.(?:SH|SZ|BJ|SS))?$/i.test(q)) return { results: [] };
        const directCode = /^(?:HK)?\d{1,5}(?:\.HK)?$/i.test(q) ? normalizeSymbol('hk', q) : undefined;
        const rows = (await tencentHints(directCode ? directCode.slice(0, 5) : q, 'hk'))
          .filter(x => x[0] === 'hk' && /^[A-Z0-9]{1,12}$/i.test(x[1] ?? ''))
          .map(x => {
            const sym = /^\d+$/.test(x[1]) ? `${x[1].padStart(5, '0')}.HK` : `${x[1].toUpperCase()}.HK`;
            return instrument('hk', sym, x[2] || sym, '港交所', 'HKD');
          });
        if (directCode && !rows.some(r => r.symbol === directCode)) {
          rows.push(instrument('hk', directCode, `代码查询 ${directCode}`, '港交所', 'HKD'));
        }
        return { results: unique([...rows, ...local]) };
      }
      const directCode = /^(?:(SH|SZ|BJ))?\d{6}(?:\.(SH|SZ|BJ|SS))?$/i.test(q) ? normalizeSymbol('cn',q) : undefined;
      const rows = (await tencentHints(directCode ? directCode.slice(0,6) : q,'gp')).filter(x=>['sh','sz','bj'].includes(x[0]) && /^\d{6}$/.test(x[1])).map(x=>instrument('cn',`${x[1]}.${x[0].toUpperCase()}`,x[2], x[0]==='sh'?'上交所':x[0]==='bj'?'北交所':'深交所','CNY'));
      // Search by an exact code is still useful when the hint service does not index a new listing.
      if (directCode) {
        const symbol = directCode;
        if (!rows.some(r=>r.symbol===symbol)) rows.push(instrument('cn',symbol,`代码查询 ${symbol.slice(0,6)}`,symbol.endsWith('SH')?'上交所':symbol.endsWith('BJ')?'北交所':'深交所','CNY'));
      }
      return { results: unique([...rows,...local]) };
    });
  } catch {
    const results = [...local];
    try {
      if (market === 'cn' && /\d{6}/.test(q)) { const symbol = normalizeSymbol(market,q); results.push(instrument(market,symbol,`代码查询 ${symbol}`,symbol.endsWith('SH')?'上交所':symbol.endsWith('BJ')?'北交所':'深交所','CNY')); }
      if (market === 'hk' && /^(?:HK)?\d{1,5}(?:\.HK)?$/i.test(q)) { const symbol = normalizeSymbol('hk',q); results.push(instrument('hk',symbol,`代码查询 ${symbol}`,'港交所','HKD')); }
      if (market === 'us' && /^[A-Za-z^][A-Za-z0-9.^-]{0,19}$/.test(q)) { const symbol = normalizeSymbol(market,q); results.push(instrument(market,symbol,`代码查询 ${symbol}`,'待行情源确认','USD')); }
    } catch { /* Invalid direct symbol is not exposed. */ }
    return { results: unique(results), warning: '在线搜索暂时不可用；仅显示匹配的常用标的或待行情核验的代码。' };
  }
}

export async function getCandles(market: Market, rawSymbol: string, interval: Interval, requestedLimit = 800): Promise<MarketData> {
  const symbol = normalizeSymbol(market,rawSymbol);
  parseInterval(interval,market);
  const limit = Math.min(1000,Math.max(100,Number.isFinite(requestedLimit)?Math.floor(requestedLimit):800));
  // A rollover reconciliation must not reuse the previous minute's open bar.
  const withinMinute = Date.now() % 60000;
  const ttl = market === 'crypto'
    ? Math.min(30000, (withinMinute < 3000 ? 3000 : 60000) - withinMinute)
    : 30000;
  return cached(`candles:${market}:${symbol}:${interval}:${limit}`, ttl, async () => {
    const data = market === 'crypto' ? await cryptoCandles(symbol,interval,limit)
      : market === 'commodity' ? await getCommodityCandles(symbol,interval,limit)
      : interval === '4h' ? await equityFourHourCandles(market,symbol,limit)
      : market === 'us' ? await usCandles(symbol,interval,limit)
      : market === 'hk' ? await hkCandles(symbol,interval,limit)
      : await cnCandles(symbol,interval,limit);
    return withHistoryCoverage(data,limit);
  });
}
async function equityFourHourCandles(market: 'cn' | 'hk' | 'us', symbol: string, limit: number): Promise<MarketData> {
  // Fetch extra children before aggregation; the public result still respects
  // the requested limit. Every candidate is an independent, unmixed source.
  const sourceLimit = Math.min(8200, limit * (market === 'cn' ? 4 : market === 'hk' ? 10 : 7) + 16);
  const hub = await getLongbridgeHubCapabilities();
  const useHub = hub.ready && longbridgeHubKlineUnavailableUntil <= Date.now() && (
    (market === 'us' && hub.usRealtime && !symbol.startsWith('^'))
    || (market === 'hk' && hub.hkRealtime)
    || (market === 'cn' && hub.cnRealtime && !symbol.endsWith('.BJ'))
  );
  const hubChild: '1h' | '30m' = market === 'hk' ? '30m' : '1h';
  const fourHourRule = market === 'cn'
    ? 'A股4小时按09:30–11:30、13:00–15:00累计4个交易小时，每个交易日一根，午休不计入。'
    : market === 'hk'
      ? '港股4小时按香港正常交易时段聚合：09:30–12:00、13:00–14:30累计4小时，14:30–16:00尾段为1.5小时，分别保留；半日市按实际时段聚合。'
      : '美股4小时按纽约正常交易时段聚合：09:30–13:30为4小时，13:30–16:00尾段为2.5小时，分别保留；不跨交易日，自动处理夏令时。';
  const fourHourZone = market === 'us' ? 'America/New_York' : market === 'hk' ? 'Asia/Hong_Kong' : 'Asia/Shanghai';
  let lastError: unknown;
  const aggregate = async (candidate: () => Promise<MarketData>): Promise<MarketData | undefined> => {
    try {
      const data = await candidate();
      const isStartSource = data.source.startsWith('Yahoo') || data.source.startsWith('Longbridge ');
      const isLongbridge = data.source.startsWith('Longbridge ');
      const result = aggregateEquityFourHour(data.candles, {
        market,
        sourceInterval: data.interval as '30m'|'1h',
        timestamp: isStartSource ? 'start' : 'end',
        delaySeconds: isLongbridge ? 0 : undefined,
      });
      const candles = ensure(result.candles,1).slice(-limit);
      const childPeriod = data.interval === '1h' ? '1小时' : '30分钟';
      const warnings = data.warnings.filter(w => !/本次仅返回|仅有\d+根|备用源返回\d+根|东方财富连接失败|分钟K线保留源|免费分钟K线历史窗口有限|受单次最多1000根限制/.test(w));
      warnings.push(fourHourRule, '聚合K线标记周期起点；仅使用同一来源真实子K线，全部子K收盘且覆盖完整后才确认，未完成尾部不参与收盘信号。');
      if (market === 'us' || market === 'hk') warnings.push('遇交易所提前收市，按当日实际交易时段聚合；缺少子K线的历史区间会跳过。');
      if (result.discardedBuckets) warnings.push(`已跳过${result.discardedBuckets}个覆盖不完整的历史区间或缺口区间。`);
      if (candles.length < 200) warnings.push(`4小时有效K线仅${candles.length}根，受来源分钟历史窗口限制，统计样本可能不足。`);
      return { ...data, interval: '4h', candles, source: `${data.source} · ${childPeriod}聚合4小时`, delayNotice: `${data.delayNotice.split(' · ')[0]} · ${fourHourZone} · 聚合K线为周期起点`, warnings, availableIntervals: AVAILABLE_INTERVALS[market] };
    } catch (error) { lastError = error; return undefined; }
  };
  if (useHub) {
    const hubFourHour = await aggregate(() => longbridgeHubCandles(market, symbol, hubChild, Math.min(1000, sourceLimit), { session: 'intraday' }));
    if (hubFourHour) return hubFourHour;
  }
  const candidates: (() => Promise<MarketData>)[] = market === 'cn'
    ? [() => cnSinaCandles(symbol,'1h',sourceLimit), () => cnEastmoneyCandles(symbol,'1h',sourceLimit), () => cnTencentCandles(symbol,'1h',sourceLimit)]
    : market === 'hk'
      ? [
        ...(yahooUnavailableUntil > Date.now() ? [] : [async () => {
          try { return await hkYahooCandles(symbol,'30m',sourceLimit); }
          catch (error) {
            if (error instanceof MarketError && [403,429].includes(error.upstreamStatus || 0)) yahooUnavailableUntil = Date.now() + 5*60000;
            throw error;
          }
        }]),
        () => hkEastmoneyCandles(symbol,'30m',sourceLimit),
      ]
      : [
        ...(yahooUnavailableUntil > Date.now() ? [] : [async () => {
          try { return await yahooCandles(symbol,'1h',sourceLimit); }
          catch (error) {
            if (error instanceof MarketError && [403,429].includes(error.upstreamStatus || 0)) yahooUnavailableUntil = Date.now() + 5*60000;
            throw error;
          }
        }]),
        () => usEastmoneyCandles(symbol,'30m',sourceLimit),
      ];
  // A non-empty response is not necessarily enough history. Compare available
  // complete feeds; freshness wins over depth and sources are never spliced.
  const alternatives = await Promise.all(candidates.map(aggregate));
  const best = chooseEquityHistory(alternatives.filter((data): data is MarketData => !!data));
  if (best) return best;
  if (lastError instanceof MarketError) throw lastError;
  throw new MarketError('4小时所需的真实子K线暂不可用，请稍后重试。');
}
function ensure(rows: Candle[], minimum = 10): Candle[] {
  const data = sanitizeCandles(rows);
  if (!data.length) throw new MarketError('未找到有效OHLC行情，请核对标的或更换周期。',404);
  if (data.length < minimum) throw new MarketError(`历史K线不足${minimum}根，暂不能进行结构分析。`,422);
  return data;
}
async function cryptoCandles(symbol: string, interval: Interval, limit: number): Promise<MarketData> {
  try { return await getCryptoCandles(symbol, interval, limit); }
  catch (error) {
    if (error instanceof CryptoDataError) throw new MarketError(error.message,error.status,error.upstreamStatus);
    throw error;
  }
}
/** Longbridge OpenAPI (via its CLI) is the only source with US overnight sessions.
 * Opt-in per process: the desktop service enables it; plain imports (tests, scripts) stay off. */
export function longbridgeOvernightEnabled(): boolean {
  return process.env.TREND_WORKBENCH_LONGBRIDGE_KLINE === '1';
}
const LONGBRIDGE_PERIODS: Partial<Record<Interval, string>> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h' };
const LONGBRIDGE_HUB_PERIODS: Partial<Record<Interval, string>> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '1d': '1d', '1w': '1w', '1M': '1M' };
const LONGBRIDGE_SESSIONS = new Set(['Intraday', 'Pre', 'Post', 'Overnight']);
const LONGBRIDGE_SESSION_LABELS: Record<string, Candle['session']> = { Intraday: 'regular', Pre: 'pre', Post: 'post', Overnight: 'overnight' };
const LONGBRIDGE_EXCHANGES: Record<string, string> = { NASD: 'NASDAQ', NYSE: 'NYSE', AMEX: 'NYSE American', HKEX: '港交所', SEHK: '港交所', XHKG: '港交所', SH: '上交所', SSE: '上交所', XSHG: '上交所', SZ: '深交所', SZSE: '深交所', XSHE: '深交所' };
const LONGBRIDGE_SOURCE = 'Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com';
const LONGBRIDGE_HK_SOURCE = 'Longbridge OpenAPI 港股行情 · open.longbridge.com';
const LONGBRIDGE_CN_SOURCE = 'Longbridge OpenAPI A股实时行情 · open.longbridge.com';
const LONGBRIDGE_ADJUSTMENT = '不复权（原始价格）；成交量单位：股';
const LONGBRIDGE_HISTORY_DAYS: Partial<Record<Interval, number>> = { '1m': 3, '5m': 5, '15m': 14, '30m': 28, '1h': 60, '1d': 730, '1w': 1825, '1M': 3650 };
function shiftDate(date: string, deltaDays: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + deltaDays);
  return day.toISOString().slice(0, 10);
}
// GUI-launched macOS apps inherit a minimal PATH; Homebrew locations are tried explicitly.
const LONGBRIDGE_BINARIES = ['longbridge', '/opt/homebrew/bin/longbridge', '/usr/local/bin/longbridge'];
let longbridgeBinaryIndex = 0;
export type LongbridgeRunner = (args: string[]) => Promise<string>;
function longbridgeErrorOutput(text: string): { code?: number; message?: string } | undefined {
  try { return (JSON.parse(text) as { error?: { code?: number; message?: string } }).error; } catch { return undefined; }
}
function longbridgeCliError(error: unknown): MarketError {
  const failure = error as { code?: string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
  if (failure.code === 'ENOENT') return new MarketError('未找到 longbridge CLI，夜盘行情源不可用。', 503);
  const reported = longbridgeErrorOutput(String(failure.stdout ?? '').trim()) ?? longbridgeErrorOutput(String(failure.stderr ?? '').trim());
  const detail = reported?.message || [failure.stderr, failure.stdout, failure.message].map(x => String(x ?? '').trim()).filter(Boolean)[0]?.split('\n')[0]
    || (failure.killed ? '请求超时' : '行情源暂时无法连接');
  if (reported?.code === 301600 || reported?.code === 301603) return new MarketError(`Longbridge 未收录该美股标的或暂无行情（${detail}）。`, 404, undefined, reported.code);
  if (reported?.code === 301604) return new MarketError(`Longbridge 行情权限不足（${detail}）。`, 503, undefined, reported.code);
  if (reported?.code === 301606) return new MarketError('Longbridge 行情源限流，请稍后重试。', 429, 429, reported.code);
  if (reported?.code === 301607) return new MarketError(`Longbridge 历史K线额度不足（${detail}）。`, 503, undefined, reported.code);
  return new MarketError(`Longbridge 行情源暂不可用：${detail.slice(0, 120)}`, 502, undefined, reported?.code);
}
let longbridgeExec: LongbridgeRunner = async args => {
  while (longbridgeBinaryIndex < LONGBRIDGE_BINARIES.length) {
    try {
      const { stdout } = await promisify(execFile)(LONGBRIDGE_BINARIES[longbridgeBinaryIndex], args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      return stdout;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT' && ++longbridgeBinaryIndex < LONGBRIDGE_BINARIES.length) continue;
      throw longbridgeCliError(error);
    }
  }
  throw new MarketError('未找到 longbridge CLI，夜盘行情源不可用。', 503);
};
async function longbridgeRun(args: string[]): Promise<string> {
  try {
    return await longbridgeExec(args);
  } catch (error) {
    throw error instanceof MarketError ? error : longbridgeCliError(error);
  }
}
/** Tests inject a stub runner so no real CLI process is ever spawned. */
export function setLongbridgeRunner(run: LongbridgeRunner) { longbridgeExec = run; }
/** Start-labelled UTC bars across Intraday/Pre/Post/Overnight sessions; unknown sessions reject the whole feed. */
export function parseLongbridgeCandles(rows: unknown, interval: Interval, now = Date.now() / 1000): { candles: Candle[]; sessions: Record<string, number> } {
  if (!Array.isArray(rows)) throw new MarketError('Longbridge 行情源返回格式异常。');
  const sessions: Record<string, number> = {};
  const list: Candle[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.session !== 'string' || !LONGBRIDGE_SESSIONS.has(record.session)) throw new MarketError('Longbridge 返回未识别的交易时段，未将该段行情用于结构分析。');
    const time = Date.parse(String(record.time ?? '')) / 1000;
    if (!Number.isFinite(time) || time % 60 !== 0) continue;
    sessions[record.session] = (sessions[record.session] ?? 0) + 1;
    list.push({ time, open: Number(record.open), high: Number(record.high), low: Number(record.low), close: Number(record.close), volume: Number(record.volume), closed: stockBarClosed(time, interval, 'us', now, undefined, LONGBRIDGE_SOURCE), session: LONGBRIDGE_SESSION_LABELS[record.session] });
  }
  return { candles: sanitizeCandles(list), sessions };
}
const longbridgeStaticCache = new Map<string, { name: string; exchange: string }>();
async function longbridgeStaticInfo(symbol: string): Promise<{ name: string; exchange: string } | undefined> {
  if (longbridgeUnavailableUntil > Date.now()) return undefined;
  const key = symbol.toUpperCase();
  const cached = longbridgeStaticCache.get(key);
  if (cached) return cached;
  try {
    const rows = JSON.parse(await longbridgeRun(['static', `${symbol.replace(/-/g, '.')}.US`, '--format', 'json'])) as unknown;
    const row = Array.isArray(rows) ? rows[0] as Record<string, unknown> : undefined;
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name) return undefined;
    const exchange = typeof row?.exchange === 'string' ? LONGBRIDGE_EXCHANGES[row.exchange] ?? row.exchange : 'US';
    const info = { name, exchange };
    longbridgeStaticCache.set(key, info);
    return info;
  } catch { return undefined; }
}

const pendingLongbridgeQuotes = new Map<string, Array<(row: LongbridgeQuotePayload | null) => void>>();
let longbridgeQuoteFlushTimer: ReturnType<typeof setTimeout> | null = null;
let longbridgeQuoteInFlight: Promise<void> = Promise.resolve();

async function flushLongbridgeQuoteBatch() {
  const batch = [...pendingLongbridgeQuotes.entries()].slice(0, 50);
  if (!batch.length) return;
  for (const [ticker] of batch) pendingLongbridgeQuotes.delete(ticker);
  if (pendingLongbridgeQuotes.size > 0 && !longbridgeQuoteFlushTimer) {
    longbridgeQuoteFlushTimer = setTimeout(() => {
      longbridgeQuoteFlushTimer = null;
      longbridgeQuoteInFlight = longbridgeQuoteInFlight.catch(() => {}).then(flushLongbridgeQuoteBatch);
    }, 40);
    longbridgeQuoteFlushTimer.unref?.();
  }
  const now = Date.now();
  if (longbridgeQuoteUnavailableUntil > now) {
    for (const [, waiters] of batch) for (const resolve of waiters) resolve(null);
    return;
  }
  const toFetch: [string, Array<(row: LongbridgeQuotePayload | null) => void>][] = [];
  for (const [ticker, waiters] of batch) {
    const hit = longbridgeQuoteCache.get(ticker);
    if (hit && hit.expires > now) {
      for (const resolve of waiters) resolve(hit.row);
    } else {
      toFetch.push([ticker, waiters]);
    }
  }
  if (!toFetch.length) return;
  try {
    const raw = JSON.parse(await longbridgeRun(['quote', ...toFetch.map(([ticker]) => ticker), '--format', 'json'])) as unknown;
    const rows = Array.isArray(raw) ? raw as LongbridgeQuotePayload[] : [];
    const bySymbol = new Map<string, LongbridgeQuotePayload>();
    for (const item of rows) {
      if (item && typeof item.symbol === 'string') bySymbol.set(item.symbol.toUpperCase(), item);
    }
    const stamp = Date.now();
    if (longbridgeQuoteCache.size > 200) {
      for (const [k, v] of longbridgeQuoteCache) if (v.expires <= stamp) longbridgeQuoteCache.delete(k);
      while (longbridgeQuoteCache.size > 200) longbridgeQuoteCache.delete(longbridgeQuoteCache.keys().next().value!);
    }
    for (const [ticker, waiters] of toFetch) {
      const row = bySymbol.get(ticker) ?? null;
      longbridgeQuoteCache.set(ticker, { expires: stamp + 3500, row });
      for (const resolve of waiters) resolve(row);
    }
  } catch (error) {
    if (error instanceof MarketError && error.status === 429) {
      longbridgeQuoteUnavailableUntil = Date.now() + 30_000;
    } else if (!(error instanceof MarketError) || error.status !== 404) {
      longbridgeQuoteUnavailableUntil = Date.now() + 60_000;
    }
    for (const [, waiters] of toFetch) for (const resolve of waiters) resolve(null);
  }
}

async function fetchLongbridgeQuoteRow(symbol: string): Promise<LongbridgeQuotePayload | null> {
  const now = Date.now();
  if (longbridgeQuoteUnavailableUntil > now) return null;
  const ticker = `${symbol.replace(/-/g, '.')}.US`.toUpperCase();
  const hit = longbridgeQuoteCache.get(ticker);
  if (hit && hit.expires > now) return hit.row;
  return new Promise(resolve => {
    const existing = pendingLongbridgeQuotes.get(ticker);
    if (existing) existing.push(resolve);
    else pendingLongbridgeQuotes.set(ticker, [resolve]);
    if (!longbridgeQuoteFlushTimer) {
      longbridgeQuoteFlushTimer = setTimeout(() => {
        longbridgeQuoteFlushTimer = null;
        longbridgeQuoteInFlight = longbridgeQuoteInFlight.catch(() => {}).then(flushLongbridgeQuoteBatch);
      }, 40);
      longbridgeQuoteFlushTimer.unref?.();
    }
  });
}

export function parseLongbridgeLiveQuote(symbol: string, row: LongbridgeQuotePayload | null, nowMs = Date.now()):
  | { status: 'closed' | 'stale' | 'unavailable' }
  | { status: 'quote'; quote: { market: 'us'; symbol: string; currency: 'USD'; time: number; observedAt: number; price: number; venue: 'Longbridge OpenAPI'; provider: 'longbridge'; quality: 'realtime'; session: QuoteSession } } {
  const nowSec = Math.floor(nowMs / 1000);
  const active = usExtendedSessionInfo(nowSec);
  if (!active) return { status: 'closed' };
  if (!row) return { status: 'unavailable' };
  if (active.session === 'regular') {
    if (typeof row.status === 'string' && row.status && !/normal/i.test(row.status)) return { status: 'unavailable' };
    const price = Number(row.last);
    if (!Number.isFinite(price) || price <= 0) return { status: 'unavailable' };
    return {
      status: 'quote',
      quote: { market: 'us', symbol, currency: 'USD', time: nowSec, observedAt: nowSec, price, venue: 'Longbridge OpenAPI', provider: 'longbridge', quality: 'realtime', session: 'regular' },
    };
  }
  const sub = active.session === 'pre' ? row.pre_market : active.session === 'post' ? row.post_market : row.overnight;
  if (!sub) return { status: 'stale' };
  const price = Number(sub.last);
  const tradeTime = typeof sub.timestamp === 'string' ? Math.floor(Date.parse(sub.timestamp) / 1000) : NaN;
  if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(tradeTime) || tradeTime < active.start - 60 || tradeTime > nowSec + 5) {
    return { status: 'stale' };
  }
  return {
    status: 'quote',
    quote: { market: 'us', symbol, currency: 'USD', time: tradeTime, observedAt: nowSec, price, venue: 'Longbridge OpenAPI', provider: 'longbridge', quality: 'realtime', session: active.session },
  };
}
function toLongbridgeQuotePayload(row: HubNormalizedQuote): LongbridgeQuotePayload {
  return {
    symbol: row.symbol,
    last: row.lastDone,
    status: row.tradeStatus,
    pre_market: row.preMarketQuote ? { last: row.preMarketQuote.lastDone, timestamp: row.preMarketQuote.timestamp } : undefined,
    post_market: row.postMarketQuote ? { last: row.postMarketQuote.lastDone, timestamp: row.postMarketQuote.timestamp } : undefined,
    overnight: row.overnightQuote ? { last: row.overnightQuote.lastDone, timestamp: row.overnightQuote.timestamp } : undefined,
  };
}
export function parseLongbridgeHubRegularQuote(
  market: 'hk' | 'cn',
  symbol: string,
  row: HubNormalizedQuote | null | undefined,
  nowMs = Date.now(),
):
  | { status: 'closed' | 'stale' | 'unavailable' }
  | { status: 'quote'; quote: { market: 'hk' | 'cn'; symbol: string; currency: 'HKD' | 'CNY'; time: number; observedAt: number; price: number; venue: 'Longbridge OpenAPI'; provider: 'longbridge'; quality: 'realtime'; session: 'regular' } } {
  const nowSec = Math.floor(nowMs / 1000);
  const clock = equityExchangeClock(market, nowSec);
  const session = equitySessionOn(market, clock.date);
  if (session.status !== 'open' || !session.segments.length) return { status: 'closed' };
  const firstOpen = session.segments[0].start;
  const lastEnd = session.segments.at(-1)!.end;
  if (clock.minute < firstOpen - 15 || clock.minute > lastEnd + 10) return { status: 'closed' };
  if (!row) return { status: 'unavailable' };
  if (typeof row.tradeStatus === 'string' && row.tradeStatus && !/normal/i.test(row.tradeStatus)) return { status: 'unavailable' };
  const price = Number(row.lastDone);
  const quoteTime = Number.isSafeInteger(row.time) && row.time > 0 ? row.time : nowSec;
  if (!Number.isFinite(price) || price <= 0) return { status: 'unavailable' };
  return {
    status: 'quote',
    quote: {
      market,
      symbol,
      currency: market === 'cn' ? 'CNY' : 'HKD',
      time: quoteTime,
      observedAt: nowSec,
      price,
      venue: 'Longbridge OpenAPI',
      provider: 'longbridge',
      quality: 'realtime',
      session: 'regular',
    },
  };
}
function hubErrorToMarketError(err: HubHttpError, market: 'us' | 'hk' | 'cn'): MarketError {
  const label = market === 'hk' ? '港股' : market === 'cn' ? 'A股' : '美股';
  if (err.upstreamCode === 301600 || err.upstreamCode === 301603 || err.status === 404) {
    return new MarketError(`Longbridge 未收录该${label}标的或暂无行情（${err.message}）。`, 404, err.status, err.upstreamCode);
  }
  if (err.upstreamCode === 301604) return new MarketError(`Longbridge 行情权限不足（${err.message}）。`, 503, err.status, err.upstreamCode);
  if (err.upstreamCode === 301606 || err.status === 429) return new MarketError('Longbridge 行情源限流，请稍后重试。', 429, 429, err.upstreamCode);
  if (err.upstreamCode === 301607) return new MarketError(`Longbridge 历史K线额度不足（${err.message}）。`, 503, err.status, err.upstreamCode);
  return new MarketError(`Longbridge 行情源暂不可用：${err.message.slice(0, 120)}`, err.status >= 400 ? err.status : 502, err.status, err.upstreamCode);
}
export function parseLongbridgeHubCandles(
  rows: HubNormalizedCandlestick[],
  market: 'us' | 'hk' | 'cn',
  interval: Interval,
  source: string,
  now = Date.now() / 1000,
): { candles: Candle[]; sessions: Record<string, number> } {
  const sessions: Record<string, number> = {};
  const list: Candle[] = [];
  const calendar = isCalendarBar(interval);
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const session = typeof row.session === 'string' && LONGBRIDGE_SESSIONS.has(row.session) ? row.session : null;
    if (!session) throw new MarketError('Longbridge 返回未识别的交易时段，未将该段行情用于结构分析。');
    const time = Number(row.time);
    if (!Number.isSafeInteger(time) || time <= 0 || (!calendar && time % 60 !== 0)) continue;
    sessions[session] = (sessions[session] ?? 0) + 1;
    list.push({
      time,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      closed: stockBarClosed(time, interval, market, now, undefined, source),
      ...(market === 'us' && !calendar ? { session: LONGBRIDGE_SESSION_LABELS[session] } : {}),
    });
  }
  return { candles: sanitizeCandles(list), sessions };
}
async function longbridgeHubStaticInfo(market: 'us' | 'hk' | 'cn', symbol: string): Promise<{ name: string; exchange: string } | undefined> {
  const cacheKey = `${market}:${symbol.toUpperCase()}`;
  const hit = longbridgeHubStaticCache.get(cacheKey);
  if (hit) return hit;
  const ticker = toLongbridgeTicker(market, symbol);
  if (!ticker) return undefined;
  try {
    const { items } = await fetchHubStatic([ticker]);
    const row = items[0];
    if (!row) return undefined;
    const name = market === 'cn'
      ? (row.nameCn || row.nameEn || symbol).trim()
      : market === 'hk'
        ? (row.nameCn || row.nameHk || row.nameEn || symbol).trim()
        : (row.nameEn || row.nameCn || symbol).trim();
    const defaultEx = market === 'hk' ? '港交所' : market === 'cn' ? (symbol.endsWith('.SH') ? '上交所' : '深交所') : 'US';
    const rawEx = typeof row.exchange === 'string' ? row.exchange.trim() : '';
    const exchange = LONGBRIDGE_EXCHANGES[rawEx] ?? (rawEx || defaultEx);
    const info = { name: name || symbol, exchange };
    longbridgeHubStaticCache.set(cacheKey, info);
    return info;
  } catch { return undefined; }
}
async function longbridgeHubCandles(
  market: 'us' | 'hk' | 'cn',
  symbol: string,
  interval: Interval,
  limit: number,
  options?: { session?: 'all' | 'intraday' },
): Promise<MarketData> {
  const period = LONGBRIDGE_HUB_PERIODS[interval];
  const ticker = toLongbridgeTicker(market, symbol);
  if (!period || !ticker) throw new MarketError('Longbridge Hub 不支持该标的或周期。', 400);
  if (longbridgeHubKlineUnavailableUntil > Date.now()) throw new MarketError('Longbridge Hub 行情源暂时不可用。', 503);
  const count = Math.min(1000, limit);
  const session: 'all' | 'intraday' = options?.session ?? (market === 'us' && !isCalendarBar(interval) ? 'all' : 'intraday');
  const source = market === 'us' ? LONGBRIDGE_SOURCE : market === 'hk' ? LONGBRIDGE_HK_SOURCE : LONGBRIDGE_CN_SOURCE;
  let now = Date.now() / 1000;
  let parsed: { candles: Candle[]; sessions: Record<string, number> };
  try {
    const res = await fetchHubCandles({ ticker, period, count, adjust: 'none', session });
    now = Date.now() / 1000;
    parsed = parseLongbridgeHubCandles(res.candles, market, interval, source, now);
  } catch (err) {
    const mapped = err instanceof HubHttpError ? hubErrorToMarketError(err, market) : err instanceof MarketError ? err : new MarketError('Longbridge Hub 行情源返回格式异常。');
    if (mapped.status !== 404) longbridgeHubKlineUnavailableUntil = Date.now() + 2 * 60_000;
    throw mapped;
  }
  const candles = ensure(parsed.candles, 1).slice(-count);
  const info = await longbridgeHubStaticInfo(market, symbol);
  const defaultCurrency = market === 'hk' ? 'HKD' : market === 'cn' ? 'CNY' : 'USD';
  const defaultExchange = market === 'hk' ? '港交所' : market === 'cn' ? (symbol.endsWith('.SH') ? '上交所' : '深交所') : 'US';
  const fallbackName = popular(market, symbol).find(x => x.symbol === symbol)?.name ?? symbol;
  let warnings: string[];
  let delayNotice: string;
  if (market === 'us') {
    if (session === 'all') {
      warnings = [
        '已使用Longbridge官方行情，包含美股盘前、盘后及夜盘时段；夜盘成交稀薄，结构信号请结合正常时段确认。',
        'K线为周期起点时间；按实时行情在周期结束时确认收盘，未完成K线不参与收盘信号。',
        `本段含盘前${parsed.sessions.Pre ?? 0}根、盘后${parsed.sessions.Post ?? 0}根、夜盘${parsed.sessions.Overnight ?? 0}根K线。`,
      ];
      if (candles.length >= count) warnings.push('受单次最多1000根限制，纳入夜盘后覆盖的交易日更少，可与不含夜盘的来源对照。');
    } else {
      warnings = [
        '已使用Longbridge官方行情；K线为周期起点时间，按实时行情在周期结束时确认收盘，未完成K线不参与收盘信号。',
      ];
    }
    delayNotice = 'Longbridge实时行情 · America/New_York · 含盘前/盘后/夜盘 · K线为周期起点';
  } else if (market === 'hk') {
    warnings = ['已使用Longbridge官方港股实时行情；K线为周期起点时间，按实时行情在周期结束时确认收盘。'];
    delayNotice = 'Longbridge实时行情 · Asia/Hong_Kong · 仅交易时段 · K线为周期起点';
  } else {
    warnings = [
      '已使用Longbridge官方A股实时行情；K线为周期起点时间，按实时行情在周期结束时确认收盘。',
      'A股展示看多/看空倾向；看空信号不代表该标的可以直接卖空。',
    ];
    delayNotice = 'Longbridge实时行情 · Asia/Shanghai · 仅交易时段 · K线为周期起点';
  }
  if (candles.length < 200) warnings.push(`行情源本次仅返回${candles.length}根K线，统计样本可能不足。`);
  return {
    instrument: instrument(market, symbol, info?.name ?? fallbackName, info?.exchange ?? defaultExchange, defaultCurrency),
    interval,
    candles,
    source,
    asOf: new Date(now * 1000).toISOString(),
    delayNotice,
    adjustment: LONGBRIDGE_ADJUSTMENT,
    warnings,
    availableIntervals: AVAILABLE_INTERVALS[market],
  };
}
async function longbridgeHubHistory(
  market: 'us' | 'hk' | 'cn',
  symbol: string,
  interval: Interval,
  before: number,
  limit: number,
  options?: { session?: 'all' | 'intraday' },
): Promise<{ candles: Candle[]; status: 'more' | 'end' | 'unsupported' }> {
  const period = LONGBRIDGE_HUB_PERIODS[interval];
  const windowDays = LONGBRIDGE_HISTORY_DAYS[interval];
  const ticker = toLongbridgeTicker(market, symbol);
  if (!period || !windowDays || !ticker) return { candles: [], status: 'unsupported' };
  if (longbridgeHubHistoryUnsupportedUntil > Date.now()) return { candles: [], status: 'unsupported' };
  if (longbridgeHubHistoryUnavailableUntil > Date.now()) throw new MarketError('Longbridge 历史K线接口暂时不可用。', 503);
  const source = market === 'us' ? LONGBRIDGE_SOURCE : market === 'hk' ? LONGBRIDGE_HK_SOURCE : LONGBRIDGE_CN_SOURCE;
  const session: 'all' | 'intraday' = options?.session ?? (market === 'us' && !isCalendarBar(interval) ? 'all' : 'intraday');
  const zone = market === 'us' ? 'America/New_York' : market === 'hk' ? 'Asia/Hong_Kong' : 'Asia/Shanghai';
  let endDate = localClock(before - 1, zone).date;
  for (let attempt = 0; attempt < 4; attempt++) {
    const startDate = shiftDate(endDate, -(windowDays - 1));
    let parsed: { candles: Candle[]; sessions: Record<string, number> };
    try {
      const res = await fetchHubHistory({ ticker, period, adjust: 'none', session, mode: 'date', start: startDate, end: endDate, priority: 'low' });
      const now = Date.now() / 1000;
      parsed = parseLongbridgeHubCandles(res.candles, market, interval, source, now);
    } catch (err) {
      if (err instanceof HubHttpError) {
        if (err.upstreamCode === 301604 || (err.upstreamCode === 301607 && /limit:\s*0\b/i.test(err.message))) {
          longbridgeHubHistoryUnsupportedUntil = Date.now() + 6 * 3600_000;
          return { candles: [], status: 'unsupported' };
        }
        if (err.upstreamCode === 301607) longbridgeHubHistoryUnavailableUntil = Date.now() + 60 * 60_000;
        else if (err.status !== 404) longbridgeHubHistoryUnavailableUntil = Date.now() + 5 * 60_000;
        throw hubErrorToMarketError(err, market);
      }
      longbridgeHubHistoryUnavailableUntil = Date.now() + 5 * 60_000;
      throw err instanceof MarketError ? err : new MarketError('Longbridge Hub 行情源返回格式异常。');
    }
    const eligible = parsed.candles.filter(c => c.time < before && c.closed !== false);
    if (eligible.length > 0) return { candles: eligible.slice(-limit), status: 'more' };
    endDate = parsed.candles.length > 0 ? shiftDate(endDate, -1) : shiftDate(startDate, -1);
  }
  return { candles: [], status: 'end' };
}
async function longbridgeUsCandles(symbol: string, interval: Interval, limit: number): Promise<MarketData> {
  const period = LONGBRIDGE_PERIODS[interval];
  if (!period || !longbridgeOvernightEnabled()) throw new MarketError('Longbridge 夜盘行情源未启用或不支持该周期。', 503);
  if (longbridgeUnavailableUntil > Date.now()) throw new MarketError('Longbridge 夜盘行情源暂时不可用。', 503);
  const count = Math.min(1000, limit);
  let now = Date.now() / 1000;
  let parsed: { candles: Candle[]; sessions: Record<string, number> };
  try {
    const raw = JSON.parse(await longbridgeRun(['kline', `${symbol.replace(/-/g, '.')}.US`, '--period', period, '--count', String(count), '--session', 'all', '--format', 'json']));
    now = Date.now() / 1000;
    parsed = parseLongbridgeCandles(raw, interval, now);
  } catch (error) {
    if (!(error instanceof MarketError) || error.status !== 404) longbridgeUnavailableUntil = Date.now() + 5 * 60000;
    if (error instanceof MarketError) throw error;
    throw new MarketError('Longbridge 行情源返回格式异常。');
  }
  const candles = ensure(parsed.candles, 1).slice(-count);
  const info = await longbridgeStaticInfo(symbol);
  const warnings = [
    '已使用Longbridge官方行情，包含美股盘前、盘后及夜盘时段；夜盘成交稀薄，结构信号请结合正常时段确认。',
    'K线为周期起点时间；按实时行情在周期结束时确认收盘，未完成K线不参与收盘信号。',
    `本段含盘前${parsed.sessions.Pre ?? 0}根、盘后${parsed.sessions.Post ?? 0}根、夜盘${parsed.sessions.Overnight ?? 0}根K线。`,
  ];
  if (candles.length >= count) warnings.push('受单次最多1000根限制，纳入夜盘后覆盖的交易日更少，可与不含夜盘的来源对照。');
  if (candles.length < 200) warnings.push(`行情源本次仅返回${candles.length}根K线，统计样本可能不足。`);
  return {
    instrument: instrument('us', symbol, info?.name ?? symbol, info?.exchange ?? 'US', 'USD'),
    interval, candles,
    source: LONGBRIDGE_SOURCE,
    asOf: new Date(now * 1000).toISOString(),
    delayNotice: 'Longbridge实时行情 · America/New_York · 含盘前/盘后/夜盘 · K线为周期起点',
    adjustment: LONGBRIDGE_ADJUSTMENT,
    warnings, availableIntervals: AVAILABLE_INTERVALS.us,
  };
}
async function longbridgeUsHistory(symbol: string, interval: Interval, before: number, limit: number): Promise<{ candles: Candle[]; status: 'more' | 'end' | 'unsupported' }> {
  const period = LONGBRIDGE_PERIODS[interval];
  const windowDays = LONGBRIDGE_HISTORY_DAYS[interval];
  if (!period || !windowDays || !longbridgeOvernightEnabled()) return { candles: [], status: 'unsupported' };
  if (longbridgeHistoryUnsupportedUntil > Date.now()) return { candles: [], status: 'unsupported' };
  if (longbridgeHistoryUnavailableUntil > Date.now()) throw new MarketError('Longbridge 历史K线接口暂时不可用。', 503);
  let endDate = localClock(before - 1, 'America/New_York').date;
  for (let attempt = 0; attempt < 4; attempt++) {
    const startDate = shiftDate(endDate, -(windowDays - 1));
    let parsed: { candles: Candle[]; sessions: Record<string, number> };
    try {
      const raw = JSON.parse(await longbridgeRun(['kline', 'history', `${symbol.replace(/-/g, '.')}.US`, '--period', period, '--start', startDate, '--end', endDate, '--session', 'all', '--format', 'json']));
      const now = Date.now() / 1000;
      parsed = parseLongbridgeCandles(raw, interval, now);
    } catch (error) {
      if (error instanceof MarketError) {
        if (error.code === 301604 || (error.code === 301607 && /limit:\s*0\b/i.test(error.message))) {
          longbridgeHistoryUnsupportedUntil = Date.now() + 6 * 3600_000;
          return { candles: [], status: 'unsupported' };
        }
        if (error.code === 301607) {
          longbridgeHistoryUnavailableUntil = Date.now() + 60 * 60_000;
        } else if (error.status !== 404) {
          longbridgeHistoryUnavailableUntil = Date.now() + 5 * 60000;
        }
        throw error;
      }
      longbridgeHistoryUnavailableUntil = Date.now() + 5 * 60000;
      throw new MarketError('Longbridge 行情源返回格式异常。');
    }
    const eligible = parsed.candles.filter(c => c.time < before && c.closed !== false);
    if (eligible.length > 0) return { candles: eligible.slice(-limit), status: 'more' };
    endDate = parsed.candles.length > 0 ? shiftDate(endDate, -1) : shiftDate(startDate, -1);
  }
  return { candles: [], status: 'end' };
}
async function usCandles(symbol: string, interval: Interval, limit: number): Promise<MarketData> {
  const hub = await getLongbridgeHubCapabilities();
  const canUseHub = hub.ready && hub.usRealtime && !symbol.startsWith('^') && LONGBRIDGE_HUB_PERIODS[interval] !== undefined && longbridgeHubKlineUnavailableUntil <= Date.now();
  let hubError: unknown;
  if (canUseHub) {
    try { return await longbridgeHubCandles('us', symbol, interval, limit); }
    catch (error) { hubError = error; }
  }
  const calendar = interval === '1M' || interval === '1w';
  // Only Longbridge carries overnight sessions; every other provider stays regular-session-only.
  const overnight = !calendar && LONGBRIDGE_PERIODS[interval] !== undefined && longbridgeOvernightEnabled();
  const candidates: (() => Promise<MarketData>)[] = [
    ...(calendar ? [() => usTencentCalendar(symbol,interval,limit)] : []),
    ...(overnight ? [() => longbridgeUsCandles(symbol,interval,limit)] : []),
    ...(yahooUnavailableUntil>Date.now() ? [] : [async () => {
      try { return await yahooCandles(symbol,interval,limit); }
      catch (error) {
        // A search failure, unknown symbol or malformed interval must not
        // disable the chart service for every other searched instrument.
        if (error instanceof MarketError && [403,429].includes(error.upstreamStatus || 0)) yahooUnavailableUntil=Date.now()+5*60000;
        throw error;
      }
    }]),
    () => usEastmoneyCandles(symbol,interval,limit),
  ];
  try { return await selectStockHistory(candidates); }
  catch (error) {
    if (hubError instanceof MarketError && (!(error instanceof MarketError) || (hubError.status === 404 && error.status !== 404))) throw hubError;
    throw error;
  }
}
function hkYahooSymbol(symbol: string): string {
  const stem = symbol.replace(/\.HK$/i, '');
  if (/^\d+$/.test(stem)) {
    const num = stem.replace(/^0+/, '') || '0';
    return `${num.padStart(4, '0')}.HK`;
  }
  return symbol;
}
async function hkCandles(symbol: string, interval: Interval, limit: number): Promise<MarketData> {
  const hub = await getLongbridgeHubCapabilities();
  const canUseHub = hub.ready && hub.hkRealtime && LONGBRIDGE_HUB_PERIODS[interval] !== undefined && longbridgeHubKlineUnavailableUntil <= Date.now();
  let hubError: unknown;
  if (canUseHub) {
    try { return await longbridgeHubCandles('hk', symbol, interval, limit); }
    catch (error) { hubError = error; }
  }
  const candidates: (() => Promise<MarketData>)[] = [
    ...(yahooUnavailableUntil > Date.now() ? [] : [async () => {
      try { return await hkYahooCandles(symbol, interval, limit); }
      catch (error) {
        if (error instanceof MarketError && [403, 429].includes(error.upstreamStatus || 0)) yahooUnavailableUntil = Date.now() + 5 * 60000;
        throw error;
      }
    }]),
    () => hkEastmoneyCandles(symbol, interval, limit),
  ];
  try { return await selectStockHistory(candidates); }
  catch (error) {
    if (hubError instanceof MarketError && (!(error instanceof MarketError) || (hubError.status === 404 && error.status !== 404))) throw hubError;
    throw error;
  }
}
/** All searched stocks use the same source-quality policy. Select one whole
 * response, prioritising current coverage and then usable history depth. */
async function selectStockHistory(candidates:(() => Promise<MarketData>)[]):Promise<MarketData> {
  const results = await Promise.allSettled(candidates.map(candidate => candidate()));
  const data = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const best = chooseEquityHistory(data);
  if (best) return best;
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
  const error = errors.find(error => error instanceof MarketError && error.status === 404) ?? errors[0];
  if (error instanceof MarketError) throw error;
  throw new MarketError('该标的在当前周期暂时没有可用历史行情。');
}
async function yahooCandles(symbol: string, interval: Interval, limit: number, history?:YahooHistoryWindow): Promise<MarketData> {
  const providerInterval = interval === '1h' ? '60m' : interval === '1w' ? '1wk' : interval === '1M' ? '1mo' : interval;
  const range = interval === '1m' ? '7d' : interval === '1d' ? '5y' : interval === '1h' ? '2y' : '60d';
  // Explicit calendar bounds avoid range=max silently changing monthly bars
  // into quarters. The actual returned granularity is still strictly checked.
  const window = history?`period1=${history.start}&period2=${history.end}`:interval === '1w' || interval === '1M'
    ? `period1=${Date.UTC(1900,0,1)/1000}&period2=${Math.floor(Date.now()/1000)+86400}` : `range=${range}`;
  const query = `interval=${providerInterval}&${window}&includePrePost=false&events=div%2Csplits`;
  // First-party website endpoints, not an authorized exchange feed. No retry on denial/limits.
  let data: YahooChart, host = history?.host??'query1.finance.yahoo.com';
  try {
    const url=new URL(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`);
    data=history?await loadYahooHistory<YahooChart>(url,history,symbol):await json<YahooChart>(url.toString());
  }
  catch(error) {
    if(history)throw error;
    if (error instanceof MarketError && error.status === 404) throw new MarketError('未找到该美股标的。',404);
    if (error instanceof MarketError && [403,429].includes(error.upstreamStatus || 0)) throw error;
    host = 'query2.finance.yahoo.com';
    data = await json<YahooChart>(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`);
  }
  const result = data?.chart?.result?.[0];
  if (!result || data.chart?.error) throw new MarketError('未找到该美股标的或该周期暂无数据。',404);
  const meta = result.meta || {};
  if(history&&(meta as {symbol?:string}).symbol!==symbol)throw new MarketError('历史行情标的与当前图表不一致。');
  if (meta.exchangeTimezoneName && meta.exchangeTimezoneName !== 'America/New_York') throw new MarketError('该代码不属于美股市场，请重新选择。',422);
  validateYahooGranularity(interval,meta.dataGranularity);
  const q = result.indicators?.quote?.[0];
  if (!q || !Array.isArray(result.timestamp) || ![q.open,q.high,q.low,q.close,q.volume].every(Array.isArray)) throw new MarketError('行情源缺少完整K线。');
  const now = Date.now()/1000;
  const adjust = result.indicators?.adjclose?.[0]?.adjclose;
  const useAdjusted = isCalendarBar(interval) && Array.isArray(adjust);
  const rows: Candle[] = result.timestamp.map((time: number,i: number) => {
    const ratio = useAdjusted && Number(q.close[i]) > 0 && Number(adjust?.[i]) > 0 ? Number(adjust?.[i])/Number(q.close[i]) : 1;
    return {time,open:q.open[i] == null ? NaN : Number(q.open[i])*ratio,high:q.high[i] == null ? NaN : Number(q.high[i])*ratio,low:q.low[i] == null ? NaN : Number(q.low[i])*ratio,close:q.close[i] == null ? NaN : Number(q.close[i])*ratio,volume:q.volume[i] == null ? 0 : Number(q.volume[i]),closed:stockBarClosed(time,interval,'us',now,meta.currentTradingPeriod?.regular?.end)};
  });
  // Yahoo can append a 16:00 instantaneous quote to intraday history. It is
  // not a new hourly/minute OHLC candle and must not enter structure analysis.
  const regularRows = isCalendarBar(interval) ? rows : rows.filter(c => {
    if (!Number.isFinite(c.time) || c.time % 60 !== 0) return false;
    const {date,minute}=equityExchangeClock('us',c.time);
    return equitySessionOn('us',date).segments.some(s=>minute>=s.start&&minute<s.end&&(minute-s.start)%MINUTES[interval as Exclude<Interval,'1M'>]===0);
  });
  const prepared = interval === '1M' ? normalizeYahooMonthlyCandles(rows,meta.dataGranularity) : interval === '1w' ? normalizeYahooWeeklyCandles(rows,meta.dataGranularity) : regularRows;
  const candles = ensure(prepared,1).slice(-limit);
  const warnings = ['美股正常交易时段数据，不含盘前盘后；公开网页接口可能限流或延迟。','美股K线在该周期结束15分钟后确认，覆盖范围内使用交易日历的实际收市时间。'];
  if (interval === '1m') warnings.push('1分钟K线由真实分钟OHLC构成；Yahoo最多请求最近7天，页面仍受返回数量限制。');
  if (interval === '1M') warnings.push('月线按纽约自然月聚合；当前月在进入下月后才标记已收盘。');
  if (interval === '1M' && rows.length !== prepared.length) warnings.push('已排除行情源追加的日内报价或重复月份，月线仅使用已核验粒度的月首OHLC条目。');
  if (interval === '1w' && rows.length !== prepared.length) warnings.push('已排除行情源追加的当日报价或重复周，周线仅使用已核验周粒度的OHLC条目。');
  if (candles.length<200) warnings.push(`该周期仅有${candles.length}根有效K线，统计样本可能不足。`);
  return {instrument:instrument('us',symbol,meta.longName || meta.shortName || symbol,meta.fullExchangeName || meta.exchangeName || 'US',meta.currency || 'USD'),interval,candles,source:`Yahoo Finance 网页行情 · ${host}`,asOf:new Date(now*1000).toISOString(),delayNotice:'可能延迟，非交易所直连 · America/New_York正常交易时段 · K线为周期起点',adjustment:useAdjusted?'按调整后收盘价等比例调整OHLC（分红、拆股），成交量未调整':'来源原始OHLC；拆股或其他公司行动可能影响历史比较',warnings,availableIntervals:AVAILABLE_INTERVALS.us};
}
export function validateYahooGranularity(interval:Interval,granularity:string|undefined):void {
  const allowed:Record<Interval,string[]>={'1m':['1m'],'5m':['5m'],'15m':['15m'],'30m':['30m'],'1h':['60m','1h'],'4h':['4h'],'1d':['1d'],'1w':['1wk'],'1M':['1mo']};
  if(!granularity||!allowed[interval].includes(granularity))throw new MarketError(`Yahoo实际周期${granularity||'未知'}与请求的${interval}不一致，已拒绝错周期数据。`);
}
function usWeekKey(time:number):string {
  const date=localClock(time,'America/New_York').date;
  const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);
  return d.toISOString().slice(0,10);
}
export function normalizeYahooWeeklyCandles(rows:Candle[],granularity:string|undefined):Candle[] {
  validateYahooGranularity('1w',granularity);
  const weeks=new Map<string,Candle>();
  for(const row of sanitizeCandles(rows)) {
    const key=usWeekKey(row.time);
    // The genuine period bar precedes Yahoo's appended last-session quote.
    if(!weeks.has(key))weeks.set(key,row);
  }
  return [...weeks.values()];
}
/** Yahoo may downsample range=max to quarters and append a daily quote to period data. */
export function normalizeYahooMonthlyCandles(rows:Candle[],granularity:string|undefined):Candle[] {
  if(granularity!=='1mo')throw new MarketError('Yahoo返回周期与月线不一致，未将季度数据作为月线使用。');
  const months=new Map<string,Candle>();
  for(const row of sanitizeCandles(rows)) {
    const date=localClock(row.time,'America/New_York').date;
    // Yahoo native monthly bars are stamped on the first calendar day, whereas
    // appended realtime/day quotes carry their actual trading date/time.
    if(!date.endsWith('-01'))continue;
    const key=date.slice(0,7);
    if(!months.has(key))months.set(key,row);
  }
  return [...months.values()];
}
async function usTencentCalendar(symbol:string,interval:'1w'|'1M',limit:number,endDate=''):Promise<MarketData> {
  const period=interval==='1w'?'week':'month',label=interval==='1w'?'周':'月';
  const metadata=(await usHints(symbol)).find(x=>x.symbol===symbol);
  if(!metadata)throw new MarketError(`腾讯${label}线源未收录该美股代码。`,404);
  const [market,code]=metadata.secid.split('.');
  const suffix:Record<string,string>={'105':'OQ','106':'N','107':'AM'};
  if(!suffix[market])throw new MarketError(`腾讯${label}线源不支持该交易所。`);
  const ticker=`us${code.replace(/_/g,'.')}.${suffix[market]}`;
  const payload=await json<TencentKline>(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${ticker},${period},,${endDate},${limit},`);
  const rows=payload.data?.[ticker]?.[period];
  if(payload.code!==0||!Array.isArray(rows))throw new MarketError(`腾讯${label}线源未返回完整${label}OHLC。`);
  const now=Date.now()/1000;
  const candles=endDate&&!rows.length?[]:ensure(rows.map((r):Candle=>{
    const time=usDateStamp(String(r[0]));
    return {time,open:Number(r[1]),close:Number(r[2]),high:Number(r[3]),low:Number(r[4]),volume:Number(r[5]),closed:stockBarClosed(time,interval,'us',now)};
  }),1).slice(-limit);
  const keys=candles.map(c=>interval==='1w'?usWeekKey(c.time):localClock(c.time,'America/New_York').date.slice(0,7));
  if(new Set(keys).size!==keys.length)throw new MarketError(`腾讯${label}线源返回重复周期，未用于结构分析。`);
  const warnings=[`美股${label}线使用腾讯原生${label}OHLC；不复权历史的拆股和分红可能影响结构，请与其他周期的复权口径对照。`,interval==='1M'?'月份按America/New_York交易日期，当前月进入下月后才标记已收盘。':'周线按纽约交易日期，在该周最后一个交易日收市15分钟后确认。',`公开网页行情可能延迟，${label}线时间标记为源最后交易日。`];
  if(candles.length<200)warnings.push(`${label}线源本次返回${candles.length}根，历史统计样本可能不足。`);
  return {instrument:instrument('us',symbol,metadata.name,metadata.exchange,'USD'),interval,candles,source:`腾讯证券 原生美股${label}K · ifzq.gtimg.cn`,asOf:new Date(now*1000).toISOString(),delayNotice:`公开${label}OHLC行情可能延迟 · America/New_York · 周期内最后交易日时间标记`,adjustment:`不复权（${label}度原始OHLC）；成交量单位：股`,warnings,availableIntervals:AVAILABLE_INTERVALS.us};
}
async function usEastmoneyCandles(symbol: string, interval: Interval, limit: number, endDate?:string): Promise<MarketData> {
  const metadata = (await usHints(symbol)).find(x=>x.symbol===symbol);
  if (!metadata) throw new MarketError('Yahoo行情不可用，备用源未收录该美股代码；请核对代码或稍后重试。',404);
  const klt = eastmoneyPeriod(interval);
  const params = new URLSearchParams({secid:metadata.secid,klt,fqt:'0',lmt:String(limit+1),end:endDate?.replaceAll('-','')??'20500101',fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'});
  const payload = await json<EastmoneyData>(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`);
  const result = payload?.data;
  if (!result || !Array.isArray(result.klines) || `${result.market}.${result.code}`!==metadata.secid) throw new MarketError('备用行情源未返回该美股标的的有效数据。',404);
  const now = Date.now()/1000, intraday=!isCalendarBar(interval);
  const rows: Candle[] = result.klines.filter(raw=>typeof raw==='string').map((raw: string) => {
    const r=raw.split(',');
    // The alternate source uses Shanghai-time END stamps for US minute candles.
    const time=intraday?Date.parse(r[0].replace(' ','T')+':00+08:00')/1000:usDateStamp(r[0]);
    return {time,open:Number(r[1]),close:Number(r[2]),high:Number(r[3]),low:Number(r[4]),volume:Number(r[5]),closed:intraday?now>=time+900:stockBarClosed(time,interval,'us',now)};
  }).filter((c: Candle)=>{
    if (!Number.isFinite(c.time)) return false;
    if (!intraday) return true;
    const {date,minute}=equityExchangeClock('us',c.time);
    return equitySessionOn('us',date).segments.some(s=>minute>s.start&&minute<=s.end);
  });
  // The earliest minute candle can be truncated by the provider's retention window.
  const candles=endDate&&!result.klines.length?[]:ensure(intraday && interval !== '1m' ? rows.slice(1) : rows,1).slice(-limit);
  const warnings=['已使用东方财富美股公开行情源；公开网页接口可能限流或延迟。','备用源采用不复权价格，除权除息和拆股可能影响结构；不同来源结果可能不同。','仅正常交易时段；最近K线延后15分钟确认。'];
  if (intraday) warnings.push('分钟K线保留源时间标记（周期结束），已转换为UTC；纽约时区筛选正常交易时段，免费历史窗口有限。');
  if (interval === '1m') warnings.push('备用源1分钟真实OHLC仅覆盖最近一个交易日；不会把只有收盘价的分时数据伪造成K线。');
  if (interval === '1M') warnings.push('月线按纽约自然月聚合；当前月在进入下月后才标记已收盘。');
  if (candles.length<200) warnings.push(`行情源本次仅返回${candles.length}根K线，历史统计样本可能不足。`);
  return {instrument:instrument('us',symbol,result.name||metadata.name,metadata.exchange,'USD'),interval,candles,source:'东方财富 美股网页行情（备用） · push2his.eastmoney.com',asOf:new Date(now*1000).toISOString(),delayNotice:'延迟行情，非交易所直连 · America/New_York正常交易时段 · 分钟K线为周期结束',adjustment:'不复权（原始价格）；成交量单位：股',warnings,availableIntervals:AVAILABLE_INTERVALS.us};
}
function hkDateStamp(date: string): number {
  return Date.parse(`${date}T09:30:00+08:00`) / 1000;
}
async function hkYahooCandles(symbol: string, interval: Interval, limit: number, history?: YahooHistoryWindow, tickerOverride?: string): Promise<MarketData> {
  const providerInterval = interval === '1h' ? '60m' : interval === '1w' ? '1wk' : interval === '1M' ? '1mo' : interval;
  const range = interval === '1m' ? '7d' : interval === '1d' ? '5y' : interval === '1h' ? '2y' : '60d';
  const window = history ? `period1=${history.start}&period2=${history.end}` : interval === '1w' || interval === '1M'
    ? `period1=${Date.UTC(1900, 0, 1) / 1000}&period2=${Math.floor(Date.now() / 1000) + 86400}` : `range=${range}`;
  const yahooSymbol = tickerOverride ?? hkYahooSymbol(symbol);
  const query = `interval=${providerInterval}&${window}&includePrePost=false&events=div%2Csplits`;
  let data: YahooChart, host = history?.host ?? 'query1.finance.yahoo.com';
  try {
    const url = new URL(`https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?${query}`);
    data = history ? await loadYahooHistory<YahooChart>(url, history, yahooSymbol) : await json<YahooChart>(url.toString());
  } catch (error) {
    if (history) throw error;
    if (error instanceof MarketError && error.status === 404) throw new MarketError('未找到该港股标的。', 404);
    if (error instanceof MarketError && [403, 429].includes(error.upstreamStatus || 0)) throw error;
    host = 'query2.finance.yahoo.com';
    data = await json<YahooChart>(`https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?${query}`);
  }
  const result = data?.chart?.result?.[0];
  if (!result || data.chart?.error) throw new MarketError('未找到该港股标的或该周期暂无数据。', 404);
  const meta = result.meta || {};
  if (history && (meta as { symbol?: string }).symbol !== yahooSymbol) throw new MarketError('历史行情标的与当前图表不一致。');
  if (meta.exchangeTimezoneName && meta.exchangeTimezoneName !== 'Asia/Hong_Kong') throw new MarketError('该代码不属于港股市场，请重新选择。', 422);
  validateYahooGranularity(interval, meta.dataGranularity);
  const q = result.indicators?.quote?.[0];
  if (!q || !Array.isArray(result.timestamp) || ![q.open, q.high, q.low, q.close, q.volume].every(Array.isArray)) throw new MarketError('行情源缺少完整K线。');
  const now = Date.now() / 1000;
  const adjust = result.indicators?.adjclose?.[0]?.adjclose;
  const useAdjusted = isCalendarBar(interval) && Array.isArray(adjust);
  const rows: Candle[] = result.timestamp.map((time: number, i: number) => {
    const ratio = useAdjusted && Number(q.close[i]) > 0 && Number(adjust?.[i]) > 0 ? Number(adjust?.[i]) / Number(q.close[i]) : 1;
    return { time, open: q.open[i] == null ? NaN : Number(q.open[i]) * ratio, high: q.high[i] == null ? NaN : Number(q.high[i]) * ratio, low: q.low[i] == null ? NaN : Number(q.low[i]) * ratio, close: q.close[i] == null ? NaN : Number(q.close[i]) * ratio, volume: q.volume[i] == null ? 0 : Number(q.volume[i]), closed: stockBarClosed(time, interval, 'hk', now, meta.currentTradingPeriod?.regular?.end) };
  });
  const regularRows = isCalendarBar(interval) ? rows : rows.filter(c => {
    if (!Number.isFinite(c.time) || c.time % 60 !== 0) return false;
    const { date, minute } = equityExchangeClock('hk', c.time);
    return equitySessionOn('hk', date).segments.some(s => minute >= s.start && minute < s.end && (minute - s.start) % MINUTES[interval as Exclude<Interval, '1M'>] === 0);
  });
  const prepared = interval === '1M' ? normalizeYahooMonthlyCandles(rows, meta.dataGranularity) : interval === '1w' ? normalizeYahooWeeklyCandles(rows, meta.dataGranularity) : regularRows;
  const candles = ensure(prepared, 1).slice(-limit);
  const warnings = ['港股正常交易时段数据；公开网页接口可能限流或延迟。', '港股K线在该周期结束15分钟后确认，覆盖范围内使用交易日历的实际收市时间。'];
  if (candles.length < 200) warnings.push(`该周期仅有${candles.length}根有效K线，统计样本可能不足。`);
  return {
    instrument: instrument('hk', symbol, meta.longName || meta.shortName || popular('hk', symbol)[0]?.name || symbol, '港交所', meta.currency || 'HKD'),
    interval,
    candles,
    source: `Yahoo Finance 港股网页行情 · ${host}`,
    asOf: new Date(now * 1000).toISOString(),
    delayNotice: '可能延迟，非交易所直连 · Asia/Hong_Kong正常交易时段 · K线为周期起点',
    adjustment: useAdjusted ? '按调整后收盘价等比例调整OHLC（分红、拆股），成交量未调整' : '来源原始OHLC；拆股或其他公司行动可能影响历史比较',
    warnings,
    availableIntervals: AVAILABLE_INTERVALS.hk,
  };
}
async function hkEastmoneyCandles(symbol: string, interval: Interval, limit: number, endDate?: string): Promise<MarketData> {
  const code = symbol.replace(/\.HK$/i, '');
  if (!/^\d{5}$/.test(code)) throw new MarketError('未找到该港股标的或该周期暂无数据。', 404);
  const secid = `116.${code}`;
  const klt = eastmoneyPeriod(interval);
  const params = new URLSearchParams({ secid, klt, fqt: '0', lmt: String(limit + 1), end: endDate?.replaceAll('-', '') ?? '20500101', fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' });
  const payload = await json<EastmoneyData>(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`);
  const result = payload?.data;
  if (!result || !Array.isArray(result.klines) || result.code !== code) throw new MarketError('未找到该港股标的或该周期暂无数据。', 404);
  const now = Date.now() / 1000, intraday = !isCalendarBar(interval);
  const rows: Candle[] = result.klines.filter(raw => typeof raw === 'string').map((raw: string) => {
    const r = raw.split(',');
    const time = intraday ? Date.parse(r[0].replace(' ', 'T') + ':00+08:00') / 1000 : hkDateStamp(r[0]);
    return { time, open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]), volume: Number(r[5]), closed: intraday ? now >= time + 900 : stockBarClosed(time, interval, 'hk', now) };
  }).filter((c: Candle) => Number.isFinite(c.time));
  const candles = endDate && !result.klines.length ? [] : ensure(intraday && interval !== '1m' ? rows.slice(1) : rows, 1).slice(-limit);
  const warnings = ['港股正常交易时段数据；公开网页接口可能限流或延迟。', '不复权历史包含除权除息跳空，可能影响分型和背驰比较。'];
  if (intraday) warnings.push('分钟K线保留源时间标记（周期结束），已转换为UTC；免费历史窗口有限。');
  if (candles.length < 200) warnings.push(`行情源本次仅返回${candles.length}根K线，历史统计样本可能不足。`);
  return {
    instrument: instrument('hk', symbol, result.name || popular('hk', symbol)[0]?.name || code, '港交所', 'HKD'),
    interval,
    candles,
    source: '东方财富 港股网页行情 · push2his.eastmoney.com',
    asOf: new Date(now * 1000).toISOString(),
    delayNotice: intraday ? '延迟行情，非交易所直连 · Asia/Hong_Kong · 分钟K线为周期结束' : '可能延迟，非交易所直连 · Asia/Hong_Kong · 仅交易时段',
    adjustment: '不复权（原始价格）；成交量单位：股',
    warnings,
    availableIntervals: AVAILABLE_INTERVALS.hk,
  };
}
async function cnCandles(symbol: string, interval: Interval, limit: number): Promise<MarketData> {
  const hub = await getLongbridgeHubCapabilities();
  const canUseHub = hub.ready && hub.cnRealtime && !symbol.endsWith('.BJ') && LONGBRIDGE_HUB_PERIODS[interval] !== undefined && longbridgeHubKlineUnavailableUntil <= Date.now();
  let hubError: unknown;
  if (canUseHub) {
    try { return await longbridgeHubCandles('cn', symbol, interval, limit); }
    catch (error) { hubError = error; }
  }
  const fallbacks = isCalendarBar(interval) && !symbol.endsWith('.BJ') ? [cnTencentCandles,cnSinaCandles] : [cnSinaCandles,cnTencentCandles];
  try {
    return await selectStockHistory([
      ...(cnEastmoneyUnavailableUntil > Date.now() ? [] : [async () => {
        try { return await cnEastmoneyCandles(symbol,interval,limit); }
        catch (error) {
          if (error instanceof MarketError && [403,429].includes(error.upstreamStatus || 0)) cnEastmoneyUnavailableUntil=Date.now()+5*60000;
          throw error;
        }
      }]),
      ...fallbacks.map(fallback => () => fallback(symbol,interval,limit)),
    ]);
  } catch (error) {
    if (hubError instanceof MarketError && (!(error instanceof MarketError) || (hubError.status === 404 && error.status !== 404))) throw hubError;
    throw error;
  }
}
async function cnEastmoneyCandles(symbol: string, interval: Interval, limit: number, endDate?:string): Promise<MarketData> {
  const [code,exchange] = symbol.split('.');
  const secid = `${exchange === 'SH' ? '1' : '0'}.${code}`;
  const klt = eastmoneyPeriod(interval);
  const params = new URLSearchParams({secid,klt,fqt:'0',lmt:String(limit),end:endDate?.replaceAll('-','')??'20500101',fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'});
  const payload = await json<EastmoneyData>(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`);
  const result = payload?.data;
  if (!result || !Array.isArray(result.klines) || result.code !== code || Number(result.market) !== (exchange==='SH'?1:0)) throw new MarketError('未找到该A股标的或该周期暂无行情。',404);
  const now = Date.now()/1000;
  const rows: Candle[] = result.klines.filter(raw=>typeof raw==='string').map((raw: string) => {
    const r = raw.split(',');
    const stamp = r[0].includes(' ') ? r[0].replace(' ','T')+':00+08:00' : r[0]+'T09:30:00+08:00';
    const time = Date.parse(stamp)/1000;
    return {time,open:Number(r[1]),close:Number(r[2]),high:Number(r[3]),low:Number(r[4]),volume:Number(r[5])*100,closed:stockBarClosed(time,interval,'cn',now)};
  });
  const candles = endDate&&!result.klines.length?[]:ensure(rows,1).slice(-limit);
  const warnings = ['A股展示看多/看空倾向；看空信号不代表该标的可以直接卖空。','不复权历史包含除权除息跳空，可能影响分型和背驰比较。'];
  if (!isCalendarBar(interval)) warnings.push('免费分钟K线历史窗口有限；时间标记为周期结束，成交量已由手换算为股。');
  if (interval === '1m') warnings.push('1分钟真实OHLC仅覆盖最近一个交易日；刚开盘时结构样本较少。');
  if (interval === '1M') warnings.push('月线按上海自然月聚合；当前月在进入下月后才标记已收盘。');
  if (candles.length<200) warnings.push(`行情源本次仅返回${candles.length}根K线，历史统计样本可能不足。`);
  return {instrument:instrument('cn',symbol,result.name || code,exchange==='SH'?'上交所':exchange==='BJ'?'北交所':'深交所','CNY'),interval,candles,source:'东方财富 网页行情 · push2his.eastmoney.com',asOf:new Date(now*1000).toISOString(),delayNotice:'可能延迟，非交易所直连 · Asia/Shanghai · 仅交易时段',adjustment:'不复权（原始价格）；成交量单位：股',warnings,availableIntervals:AVAILABLE_INTERVALS.cn};
}

function cnInstrument(symbol:string, name?:string):Instrument {
  const [code,exchange]=symbol.split('.');
  return instrument('cn',symbol,name||popular('cn',symbol)[0]?.name||code,exchange==='SH'?'上交所':exchange==='BJ'?'北交所':'深交所','CNY');
}
function cnPrefix(symbol:string):string {
  const [code,exchange]=symbol.split('.');return `${exchange.toLowerCase()}${code}`;
}
interface TencentKline {code?:number; data?:Record<string,{day?:unknown[][];week?:unknown[][];month?:unknown[][];m1?:unknown[][];m5?:unknown[][];m15?:unknown[][];m30?:unknown[][];m60?:unknown[][];qt?:Record<string,string[]>}>}
async function cnTencentCandles(symbol:string,interval:Interval,limit:number,endDate=''):Promise<MarketData> {
  const ticker=cnPrefix(symbol), calendar=isCalendarBar(interval);
  const period=interval==='1M'?'month':interval==='1w'?'week':interval==='1d'?'day':interval==='1h'?'m60':`m${MINUTES[interval as Exclude<Interval,'1M'>]}`;
  const url=calendar?`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${ticker},${period},,${endDate},${limit},`:`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${ticker},${period},,${limit}`;
  const payload=await json<TencentKline>(url),data=payload.data?.[ticker];
  const rows=data?.[period as 'day'];
  if(payload.code!==0||!data||!Array.isArray(rows))throw new MarketError('腾讯备用源暂无该标的K线。');
  const now=Date.now()/1000;
  const parsed=rows.map((r):Candle=>{
    const raw=String(r[0]);
    const stamp=calendar?`${raw}T09:30:00+08:00`:/^\d{12}$/.test(raw)?`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${raw.slice(8,10)}:${raw.slice(10,12)}:00+08:00`:'';
    const time=Date.parse(stamp)/1000;
    return {time,open:Number(r[1]),close:Number(r[2]),high:Number(r[3]),low:Number(r[4]),volume:Number(r[5])*100,closed:stockBarClosed(time,interval,'cn',now)};
  });
  const candles=endDate&&!rows.length?[]:ensure(parsed,1).slice(-limit);
  const warnings=['已使用独立腾讯K线源；不同来源的历史和复权口径可能不同。','A股看空不代表可以直接卖空。'];
  if(!calendar)warnings.push('腾讯分钟K线保留源周期结束时间；分钟历史的复权口径未独立核验。');
  if(interval==='1M')warnings.push('当前月在进入上海时区下月后才标记已收盘。');
  if(candles.length<200)warnings.push(`备用源返回${candles.length}根K线，统计样本可能不足。`);
  return {instrument:cnInstrument(symbol,data.qt?.[ticker]?.[1]),interval,candles,source:'腾讯证券 K线（独立备用） · ifzq.gtimg.cn',asOf:new Date(now*1000).toISOString(),delayNotice:'公开网页行情可能延迟 · Asia/Shanghai · 分钟K线标记周期结束',adjustment:calendar?'不复权（日/周/月原始价格）；成交量单位：股':'来源分钟OHLC（复权口径未独立核验）；成交量单位：股',warnings,availableIntervals:AVAILABLE_INTERVALS.cn};
}

/** Aggregate genuine daily OHLC only; drop the first bucket because retention may start mid-period. */
export function aggregateChinaCalendar(daily:Candle[],interval:'1w'|'1M',now=Date.now()/1000):Candle[] {
  const groups=new Map<string,Candle>();
  for(const c of sanitizeCandles(daily)) {
    const date=localClock(c.time,'Asia/Shanghai').date;
    let key=date.slice(0,7);
    if(interval==='1w') {
      const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);key=d.toISOString().slice(0,10);
    }
    const prior=groups.get(key);
    if(prior) {prior.high=Math.max(prior.high,c.high);prior.low=Math.min(prior.low,c.low);prior.close=c.close;prior.volume+=c.volume;}
    else groups.set(key,{...c});
  }
  return [...groups.values()].slice(1).map(c=>({...c,closed:stockBarClosed(c.time,interval,'cn',now)}));
}
interface SinaRow {day:string;open:string;high:string;low:string;close:string;volume:string}
async function cnSinaCandles(symbol:string,interval:Interval,limit:number,archive=false):Promise<MarketData> {
  const ticker=cnPrefix(symbol),calendar=isCalendarBar(interval);
  const scale=calendar?240:MINUTES[interval as Exclude<Interval,'1M'>];
  // At 1971 rows the provider returns null. Request the full available window
  // only during backfill, including the underlying daily/hourly rows for aggregates.
  const count=archive?1970:interval==='1M'||interval==='1w'?1023:Math.min(1023,limit);
  const url=`https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_data=/CN_MarketDataService.getKLineData?symbol=${ticker}&scale=${scale}&ma=no&datalen=${count}`;
  const text=await upstream(url),body=text.match(/\b_data\s*=\s*\(([\s\S]*)\);?\s*$/)?.[1];
  if(!body)throw new MarketError('新浪备用源返回格式异常。');
  let raw:SinaRow[];
  try {raw=JSON.parse(body) as SinaRow[];}catch {throw new MarketError('新浪备用源返回格式异常。');}
  if(!Array.isArray(raw))throw new MarketError('新浪备用源暂无该标的数据。');
  const now=Date.now()/1000;
  const rows=raw.filter(r=>r&&typeof r.day==='string').map((r):Candle=>{
    const stamp=r.day.includes(' ')?`${r.day.replace(' ','T')}+08:00`:`${r.day}T09:30:00+08:00`;
    const time=Date.parse(stamp)/1000;
    return {time,open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume),closed:stockBarClosed(time,calendar?'1d':interval,'cn',now)};
  });
  const aggregated=interval==='1M'||interval==='1w';
  const complete=ensure(aggregated?aggregateChinaCalendar(rows,interval,now):rows,1);
  const candles=archive?complete:complete.slice(-limit);
  const warnings=['已使用独立新浪OHLC行情源；历史长度取决于来源保留窗口。','A股看空不代表可以直接卖空。'];
  if(aggregated)warnings.push('按新浪真实日OHLC聚合，已丢弃起始不完整周期；日线入库可能滞后，最新交易日可能尚未包含。');
  if(calendar)warnings.push('新浪日线可能只更新到上一个已完成交易日，请核对图表末端时间。');
  if(interval==='1M')warnings.push('当前月在进入上海时区下月后才标记已收盘。');
  if(candles.length<200)warnings.push(`备用源返回${candles.length}根K线，统计样本可能不足。`);
  return {instrument:cnInstrument(symbol),interval,candles,source:'新浪财经 OHLC（独立备用） · quotes.sina.cn',asOf:new Date(now*1000).toISOString(),delayNotice:'公开网页行情可能延迟 · Asia/Shanghai · 分钟K线标记周期结束',adjustment:'来源原始OHLC（未请求复权）；成交量单位：股',warnings,availableIntervals:AVAILABLE_INTERVALS.cn};
}
