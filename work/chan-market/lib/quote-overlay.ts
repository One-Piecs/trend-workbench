import {equityExchangeClock, equityFourHourWindows, equitySessionOn} from './equity-calendar.ts';
import {commodityBarEnd, commodityPeriodStart, commoditySessionStart, commodityTradeDate} from './commodity-session.ts';
import {breakoutBarContinuity} from './breakout-vwap.ts';
import type {Candle, Interval, MarketData} from './market-types';

export type QuoteMarket = 'cn' | 'hk' | 'us' | 'commodity';
export type QuoteSession = 'pre' | 'regular' | 'post' | 'overnight';
export type QuoteOhlcv = Pick<Candle, 'open'|'high'|'low'|'close'|'volume'>;
export type QuoteQuality = 'observed' | 'realtime';
export interface SourceQuote {
  market: QuoteMarket;
  symbol: string;
  currency: string;
  time: number;
  observedAt?: number;
  price: number;
  venue: string;
  provider?: string;
  quality?: QuoteQuality;
  session?: QuoteSession;
  contract?: string;
  sessionBar?: QuoteOhlcv;
  bar?: QuoteOhlcv & {interval:Interval;start:number;end:number;provider?:string;priceBasis?:string};
}
export interface QuoteOverlay {
  price: number;
  time: number;
  observedAt?: number;
  venue: string;
  provider?: string;
  quality: QuoteQuality;
  session?: QuoteSession;
  contract?: string;
  /** Native source bar displayed separately when its market coverage differs from the history. */
  nativeCandle?: Candle;
  /** Identity of the actual OHLCV feed (which can differ from the last-price provider). */
  nativeFeed?: string;
  /** Only this verified bar may be passed to the historical chart's liveBar input. */
  candle?: Candle;
}

const maxAgeSeconds = 60;
const minuteSpans = {'1m':1,'5m':5,'15m':15,'30m':30,'1h':60,'4h':240} as const;
const day = 86400;
const finite = (value:unknown):value is number=>typeof value==='number' && Number.isFinite(value);
const record = (value:unknown):value is Record<string,unknown>=>value!==null && typeof value==='object' && !Array.isArray(value);
const calendar = (period:Interval):period is '1d'|'1w'|'1M' => period==='1d'||period==='1w'||period==='1M';
const dateAt = (utcDay:number)=>new Date(utcDay*1000).toISOString().slice(0,10);

function exchangeEpoch(market:'cn'|'hk'|'us', date:string, minute:number) {
  // Noon UTC can be before US market open, but already has the correct local
  // DST offset on every regular trading date in both markets.
  const utcNoon = Date.parse(date+'T12:00:00Z')/1000;
  return utcNoon + 60*(minute-equityExchangeClock(market,utcNoon).minute);
}

/** Active US extended-hours window (Sun 20:00 ET overnight through Fri 20:00 ET post, excluding US holidays). */
export function usExtendedSessionInfo(timeSec: number): { session: QuoteSession; start: number; end: number } | null {
  if (!Number.isSafeInteger(timeSec) || timeSec <= 0 || timeSec > 253402300799) return null;
  const { date, minute } = equityExchangeClock('us', timeSec);
  if (!date || !Number.isFinite(minute)) return null;
  const dayMs = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(dayMs)) return null;
  const weekday = new Date(dayMs).getUTCDay();
  const shiftIso = (delta: number) => new Date(dayMs + delta * day * 1000).toISOString().slice(0, 10);

  if (weekday === 6) return null;
  if (weekday === 0) {
    if (minute < 1200) return null;
    const nextDate = shiftIso(1);
    if (equitySessionOn('us', nextDate).status === 'closed') return null;
    return { session: 'overnight', start: exchangeEpoch('us', date, 1200), end: exchangeEpoch('us', nextDate, 240) };
  }
  if (minute < 240) {
    if (equitySessionOn('us', date).status === 'closed') return null;
    return { session: 'overnight', start: exchangeEpoch('us', shiftIso(-1), 1200), end: exchangeEpoch('us', date, 240) };
  }
  if (minute >= 1200) {
    if (weekday === 5) return null;
    const nextDate = shiftIso(1);
    if (equitySessionOn('us', nextDate).status === 'closed') return null;
    return { session: 'overnight', start: exchangeEpoch('us', date, 1200), end: exchangeEpoch('us', nextDate, 240) };
  }
  const session = equitySessionOn('us', date);
  if (session.status === 'closed') return null;
  const regStart = session.segments[0]?.start ?? 570;
  const regEnd = session.segments.at(-1)?.end ?? 960;
  if (minute < regStart) return { session: 'pre', start: exchangeEpoch('us', date, 240), end: exchangeEpoch('us', date, regStart) };
  if (minute < regEnd) return { session: 'regular', start: exchangeEpoch('us', date, regStart), end: exchangeEpoch('us', date, regEnd) };
  return { session: 'post', start: exchangeEpoch('us', date, regEnd), end: exchangeEpoch('us', date, 1200) };
}

function equityCalendarBounds(market:'cn'|'hk'|'us', period:'1w'|'1M', date:string) {
  let first = Date.parse(date+'T00:00:00Z')/1000;
  let last:number;
  if(period==='1w'){
    first -= day*((new Date(first*1000).getUTCDay()+6)%7);
    last = first+4*day;
  }else{
    const month = new Date(first*1000);
    first = Date.UTC(month.getUTCFullYear(),month.getUTCMonth(),1)/1000;
    last = Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+1,0)/1000;
  }
  let start:number|undefined, end:number|undefined;
  for(let i=first;i<=last;i+=day){
    const tradingDate=dateAt(i), session=equitySessionOn(market,tradingDate);
    if(session.status==='unknown')return null;
    if(session.status==='open'){
      start??=exchangeEpoch(market,tradingDate,session.segments[0].start);
      end=exchangeEpoch(market,tradingDate,session.segments[session.segments.length-1].end);
    }
  }
  return start!==undefined&&end!==undefined?{start,end}:null;
}

/** Bounds of the active regular-session bar, in Unix seconds, [start, end).
 * Each price must still come from the provider; a schedule alone supplies no data. */
export function quotePeriodBounds(market:QuoteMarket, interval:Interval, time:number):{start:number;end:number}|null {
  if(!Number.isSafeInteger(time)||time<=0||time>253402300799)return null;
  if(market!=='cn'&&market!=='hk'&&market!=='us'&&market!=='commodity')return null;
  if(!calendar(interval)&&!Object.hasOwn(minuteSpans,interval))return null;
  if(market==='commodity'){
    const sessionStart=commoditySessionStart(time);
    if(sessionStart===null)return null;
    const start=calendar(interval)?commodityPeriodStart(commodityTradeDate(time),interval):
      sessionStart+Math.floor((time-sessionStart)/(60*minuteSpans[interval]))*60*minuteSpans[interval];
    return {start,end:commodityBarEnd(start,interval)};
  }
  const {date,minute}=equityExchangeClock(market,time);
  const session=equitySessionOn(market,date),segments=session.segments;
  const segment=segments.find(s=>minute>=s.start&&minute<s.end);
  if(!segment)return null;
  if(interval==='1w'||interval==='1M')return equityCalendarBounds(market,interval,date);
  let from:number, to:number;
  if(interval==='1d'){
    from=segments[0].start;to=segments[segments.length-1].end;
  }else if(interval==='4h'){
    const window=equityFourHourWindows(market,date).find(w=>minute>=w.start&&minute<w.end);
    if(!window)return null;
    from=window.start;to=window.end;
  }else{
    const span=minuteSpans[interval];
    from=segment.start+Math.floor((minute-segment.start)/span)*span;
    to=Math.min(segment.end,from+span);
  }
  const midnight=time-(time%60)-minute*60;
  return {start:midnight+from*60,end:midnight+to*60};
}

function ohlcv(fields:unknown, price:number, signed:boolean): QuoteOhlcv|null {
  if(!record(fields))return null;
  const {open,high,low,close,volume}=fields;
  if(!finite(open)||!finite(high)||!finite(low)||!finite(close)||!finite(volume)||volume<=0
    ||(!signed&&low<=0)||high<Math.max(open,close)||low>Math.min(open,close)||close!==price)return null;
  return {open,high,low,close,volume};
}

const chinaVenues:Record<string,string> = {SH:'XSHG',SZ:'XSHE',BJ:'BJSE'};
const futuresRoots:Record<string,string> = {'GC=F':'GC','CL=F':'CL','SI=F':'SI'};
function correctListing(market:QuoteMarket,symbol:string,q:Record<string,unknown>) {
  if(market==='cn')return /^\d{6}\.(SH|SZ|BJ)$/.test(symbol)&&chinaVenues[symbol.split('.')[1]]===q.venue;
  if(market==='hk')return /^[A-Z0-9]{1,12}\.HK$/.test(symbol);
  if(market==='us')return true;
  const root=futuresRoots[symbol];
  return !!root && typeof q.contract==='string' && q.contract.startsWith(root) && /^[FGHJKMNQUVXZ]\d{1,4}$/.test(q.contract.slice(root.length));
}

function compatibleFeed(data:MarketData, q:Record<string,unknown>, bar:Record<string,unknown>|null) {
  const {market,contract}=data.instrument;
  const vendor=bar?.provider??q.provider;
  const raw=/不复权|来源原始OHLC/.test(data.adjustment);
  if(market==='us'){
    // Only the same raw regular-session vendor feed. An IEX-only feed has a
    // different open, high, low and volume than a consolidated chart.
    return vendor==='yahoo'&&data.source.startsWith('Yahoo Finance 网页行情 · ')&&raw&&!calendar(data.interval)&&!!bar;
  }
  if(market==='hk'){
    return vendor==='yahoo'&&data.source.startsWith('Yahoo Finance 港股网页行情 · ')&&raw&&!calendar(data.interval)&&!!bar;
  }
  if(market==='commodity'){
    // Calendar series can span futures rolls; their alias does not establish
    // the delivery month of every trade included in the weekly/monthly bar.
    return vendor==='yahoo'&&data.source.startsWith('Yahoo Finance 期货行情 · ')&&raw
      &&!!contract&&q.contract===contract&&data.interval!=='1w'&&data.interval!=='1M';
  }
  if(!/^(东方财富 |腾讯证券 |新浪财经 )/.test(data.source))return false;
  if(vendor!=='eastmoney'&&vendor!=='tencent'&&vendor!=='sina')return false;
  const sameVendor=(vendor==='eastmoney'&&data.source.startsWith('东方财富 '))||
    (vendor==='tencent'&&data.source.startsWith('腾讯证券 '))||(vendor==='sina'&&data.source.startsWith('新浪财经 '));
  if(!raw)return sameVendor&&vendor==='tencent'&&bar?.priceBasis==='tencent-minute-native'
    &&data.adjustment.startsWith('来源分钟OHLC（复权口径未独立核验）');
  return sameVendor||data.interval==='1d'||data.interval==='4h';
}

function continuesCumulativeBar(previous:QuoteOhlcv,next:QuoteOhlcv) {
  if(next.open!==previous.open||next.high<previous.high||next.low>previous.low||next.volume<previous.volume)return false;
  return next.volume>previous.volume||(next.high===previous.high&&next.low===previous.low&&next.close===previous.close);
}

function chartCandle(data:MarketData,native:Candle,end:number):Candle|undefined {
  const {interval}=data, market=data.instrument.market, last=data.candles.at(-1);
  if(!last||market==='crypto')return;
  const endStamped=market==='cn'&&!/Longbridge/i.test(data.source)&&!calendar(interval)&&interval!=='4h';
  let stamp=endStamped?end:native.time;
  // Some equity calendar feeds label a period by its last trading day.
  if(market==='cn'&&calendar(interval)&&last.time>=native.time&&last.time<end)stamp=last.time;
  if(last.time!==stamp){
    // An adjacent, authoritative intraday bar can be appended. Otherwise the
    // independent native bar remains visible while REST fills the history gap.
    if((calendar(interval)&&!(market==='cn'&&interval==='1d'))||last.closed!==true||last.time>=stamp)return;
    const lastBounds=quotePeriodBounds(market,interval,last.time-(endStamped?1:0));
    if(!lastBounds||last.time!==(endStamped?lastBounds.end:lastBounds.start))return;
    if(lastBounds.end!==native.time){
      // Use the same exchange calendar and feed stamp convention as closed-bar analysis.
      if(market==='commodity'||!breakoutBarContinuity(market,interval,data.source)(last,{...native,time:stamp}))return;
    }
  }else{
    if(last.closed!==false||!continuesCumulativeBar(last,native))return;
  }
  return {...native,time:stamp};
}

export function selectQuoteOverlay(data:MarketData, input:unknown, nowMs=Date.now()):QuoteOverlay|null {
  const {market,symbol,currency,id}=data.instrument;
  if(market==='crypto'||id!==market+':'+symbol||!record(input)||input.market!==market||input.symbol!==symbol||input.currency!==currency)return null;
  const {time,price,venue,contract}=input;
  const signed=market==='commodity'&&symbol==='CL=F';
  if(!finite(price)||(!signed&&price<=0)||!finite(time)||!Number.isSafeInteger(time)||!finite(nowMs)
    ||typeof venue!=='string'||!venue.trim()||!correctListing(market,symbol,input))return null;
  if(market==='us'&&input.provider==='longbridge'){
    const session=input.session;
    if(session!=='pre'&&session!=='regular'&&session!=='post'&&session!=='overnight')return null;
    const nowSec=Math.floor(nowMs/1000);
    const active=usExtendedSessionInfo(nowSec);
    if(!active||active.session!==session)return null;
    const observedAt=finite(input.observedAt)&&Number.isSafeInteger(input.observedAt)?input.observedAt:time;
    if(observedAt>nowSec+2||nowSec-observedAt>maxAgeSeconds)return null;
    if(time<active.start-60||time>nowSec+5)return null;
    return {
      price,time,observedAt,venue,provider:'longbridge',
      quality:input.quality==='realtime'?'realtime':'observed',
      session,
    };
  }
  if((market==='hk'||market==='cn')&&input.provider==='longbridge'){
    if(input.session!=='regular')return null;
    const nowSec=Math.floor(nowMs/1000);
    const clock=equityExchangeClock(market,nowSec);
    const daySession=equitySessionOn(market,clock.date);
    if(daySession.status!=='open'||!daySession.segments.length)return null;
    const firstOpen=daySession.segments[0].start;
    const lastEnd=daySession.segments.at(-1)!.end;
    if(clock.minute<firstOpen-15||clock.minute>lastEnd+10)return null;
    const observedAt=finite(input.observedAt)&&Number.isSafeInteger(input.observedAt)?input.observedAt:time;
    if(observedAt>nowSec+2||nowSec-observedAt>maxAgeSeconds)return null;
    const dayStart=exchangeEpoch(market,clock.date,0);
    if(time<dayStart-3600||time>nowSec+5)return null;
    return {
      price,time,observedAt,venue,provider:'longbridge',
      quality:input.quality==='realtime'?'realtime':'observed',
      session:'regular',
    };
  }
  if(time>nowMs/1000+2||nowMs/1000-time>maxAgeSeconds)return null;
  const bounds=quotePeriodBounds(market,data.interval,time);
  const current=quotePeriodBounds(market,data.interval,Math.floor(nowMs/1000));
  if(!bounds||!current||(market==='commodity'&&data.instrument.contract&&data.instrument.contract!==contract))return null;
  const quality=input.quality==='realtime'?'realtime':'observed';
  const result:QuoteOverlay={price,time,venue,quality,...(typeof contract==='string'&&{contract})};
  if(current.start!==bounds.start||current.end!==bounds.end)return result;
  const {bar,sessionBar}=input;
  let sourceBar:Record<string,unknown>|null=null;
  let native:QuoteOhlcv|null=null;
  if(record(bar)&&bar.interval===data.interval&&bar.start===bounds.start&&bar.end===bounds.end){
    native=ohlcv(bar,price,signed);
    if(native)sourceBar=bar;
  }
  if(!native&&(data.interval==='1d'||market==='cn'&&data.interval==='4h'))native=ohlcv(sessionBar,price,signed);
  if(native){
    result.nativeCandle={...native,time:bounds.start,closed:false};
    result.nativeFeed=JSON.stringify([venue,contract,sourceBar?.provider??input.provider,sourceBar?.priceBasis]);
    if(compatibleFeed(data,input,sourceBar)){
      const verified=chartCandle(data,result.nativeCandle,bounds.end);
      if(verified)result.candle=verified;
    }
  }
  return result;
}

interface BarReceipt {
  bar:Candle;
  feed:string;
  input:unknown;
  receivedAt:number;
}

/** Scoped to one subscription. Keep the last cumulative observation even if an intervening poll only reports a price. */
export interface QuoteSequence {
  quote:unknown;
  watermark:number;
  nativeByFeed:Record<string,BarReceipt>;
  chart?:BarReceipt;
  pending?:BarReceipt;
}

export function advanceQuoteSequence(data:MarketData, previous:QuoteSequence|null, input:unknown, nowMs:number) {
  const next=selectQuoteOverlay(data,input,nowMs);
  if(!next||previous&&next.time<previous.watermark)return {sequence:previous,reconcile:false};
  const native=next.nativeCandle,feed=next.nativeFeed;
  if(!native||!feed){
    if(next.provider==='longbridge'&&next.observedAt!==undefined){
      const prevInput=record(previous?.quote)?previous.quote:null;
      const prevObserved=prevInput&&finite(prevInput.observedAt)?prevInput.observedAt:(previous?.watermark??-Infinity);
      if(previous&&next.time===previous.watermark&&next.observedAt<=prevObserved)return {sequence:previous,reconcile:false};
      return {sequence:{nativeByFeed:{},...previous,quote:input,watermark:next.time},reconcile:false};
    }
    // A price alone cannot establish a new trade order for a tie or verify an OHLCV correction.
    if(previous&&next.time===previous.watermark)return {sequence:previous,reconcile:false};
    return {sequence:{nativeByFeed:{},...previous,quote:input,watermark:next.time},reconcile:false};
  }
  const receipt:BarReceipt={bar:native,feed,input,receivedAt:nowMs};
  const regresses=(prior?:BarReceipt)=>prior?.bar.time===native.time&&!continuesCumulativeBar(prior.bar,native);
  if(previous&&(regresses(previous.nativeByFeed[feed])||next.candle&&regresses(previous.chart))){
    const pending=previous.pending;
    // The quote endpoint coalesces requests for three seconds. Require an independent same-feed read.
    // Price-only polls, another provider, a replayed older event or a changing correction cannot confirm it.
    const confirmed=pending&&pending.feed===feed&&pending.bar.time===native.time&&nowMs-pending.receivedAt>3000
      &&continuesCumulativeBar(pending.bar,native);
    if(!confirmed){
      // Keep the original confirmation window on duplicate reads emitted by the server cache.
      const samePending=pending&&pending.feed===feed&&continuesCumulativeBar(pending.bar,native);
      return {sequence:{...previous,watermark:next.time,pending:samePending?pending:receipt},reconcile:!samePending};
    }
  }
  return {sequence:{watermark:next.time,quote:input,nativeByFeed:{...previous?.nativeByFeed,[feed]:receipt},
    chart:next.candle?receipt:previous?.chart},reconcile:false};
}

export function displayQuoteSequence(data:MarketData, sequence:QuoteSequence|null, nowMs:number) {
  const quote=sequence?selectQuoteOverlay(data,sequence.quote,nowMs):null;
  let candle=quote?.candle;
  if(quote&&!candle&&sequence?.chart&&sequence.chart.input!==sequence.quote){
    // Keep the last compatible chart bar separate from an independent venue's quote or a price-only update.
    candle=selectQuoteOverlay(data,sequence.chart.input,nowMs)?.candle;
  }
  return {quote,candle};
}
