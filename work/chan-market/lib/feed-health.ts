import type { Interval, MarketData } from './market-types';
import { candleDelaySeconds, exchangeClock } from './timeframe-context.ts';
import { equitySessionOn } from './equity-calendar.ts';
import {commodityTradeDate,commoditySessionOpen,commodityRegularDate,COMMODITY_DELAY_SECONDS} from './commodity-session.ts';

export type FeedHealthState='fresh'|'delayed'|'closed'|'stale'|'error'|'unknown';
export interface FeedHealth {
  state:FeedHealthState; allowSignals:boolean;
  label:string; labelEn:string; detail:string; detailEn:string;
  checkedAtMs:number; lastSuccessAtMs:number|null; fetchedAtMs:number|null;
  /** The adapters expose bar timestamps, not a verified last-trade timestamp. */
  quoteTimeMs:null; lastBarTimeMs:number|null; ageMs:number|null;
  expectedDelayMs:number|null;
}
export interface FeedHealthOptions {nowMs:number;lastSuccessAtMs?:number|null;error?:string|null;interval?:Interval}
const spans:Record<Exclude<Interval,'1M'>,number>={'1m':60000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'4h':14400000,'1d':86400000,'1w':604800000};
const knownFeed=/Binance|OKX|Kraken|Bitget|Bybit|Yahoo|Tencent|Sina|Eastmoney|Longbridge|腾讯|新浪|东方财富/i;
const fetchLimit=120000;
function bucket(date:string,interval:Interval) {
  if(interval==='1M')return date.slice(0,7);
  if(interval!=='1w')return date;
  const d=new Date(`${date}T00:00:00Z`),weekday=d.getUTCDay();
  d.setUTCDate(d.getUTCDate()-((weekday+6)%7));
  return d.toISOString().slice(0,10);
}
/** Assess fresh transport and exchange-local trading hours independently. */
export function getFeedHealth(data:MarketData|null,options:FeedHealthOptions):FeedHealth {
  const nowMs=options.nowMs, fetched=Date.parse(data?.asOf||'');
  const fetchedAtMs=Number.isFinite(fetched)?fetched:null;
  const success=options.lastSuccessAtMs??fetchedAtMs;
  const lastSuccessAtMs=success!=null&&Number.isFinite(success)?success:null;
  const bars=data?.candles.filter(c=>Number.isFinite(c.time)&&Number.isFinite(c.close)&&(data.instrument.market==='commodity'||c.close>0))||[];
  const last=bars.at(-1),lastBarTimeMs=last?last.time*1000:null;
  const market=data?.instrument.market,interval=options.interval||data?.interval||'1h';
  const expectedDelayMs=market?candleDelaySeconds(market,interval==='1M'?'1d':interval,data?.source)*1000:null;
  const base={checkedAtMs:nowMs,lastSuccessAtMs,fetchedAtMs,quoteTimeMs:null,lastBarTimeMs,ageMs:lastBarTimeMs==null?null:Math.max(0,nowMs-lastBarTimeMs),expectedDelayMs};
  const result=(state:FeedHealthState,label:string,labelEn:string,detail:string,detailEn:string):FeedHealth=>({...base,state,allowSignals:state==='fresh'||state==='delayed',label,labelEn,detail,detailEn});
  if(options.error)return result('error','行情连接异常','Feed error',`最近一次获取失败：${options.error}；暂停新信号。`,'The latest fetch failed. New signals are paused until a successful, current response arrives.');
  if(!Number.isFinite(nowMs)||!data||!last||!market)return result('unknown','等待有效行情','Waiting for valid data','尚无可核对时间的有效K线；不生成新提醒。','No valid timestamped candles are available; no new alerts are generated.');
  const calendar=['1d','1w','1M'].includes(interval);
  // Four-hour equity candles are stamped at the start of the session bucket,
  // including when the original provider uses end labels for its smaller bars.
  const endLabelled=!calendar&&interval!=='4h'&&market!=='crypto'&&(market==='cn'||/Eastmoney|东方财富/i.test(data.source));
  const futureAllowance=endLabelled?spans[interval as Exclude<Interval,'1M'>]+60000:60000;
  if(lastBarTimeMs!>nowMs+futureAllowance||fetchedAtMs!=null&&fetchedAtMs>nowMs+60000||lastSuccessAtMs!=null&&lastSuccessAtMs>nowMs+60000)return result('unknown','时间戳异常','Timestamp mismatch','来源时间或本机时钟超前，暂无法核实时效。','A provider timestamp or local clock is ahead; freshness cannot be verified.');
  if(lastSuccessAtMs==null||fetchedAtMs==null)return result('unknown','取数时间未知','Fetch time unknown','来源未提供有效取数时间，不能确认此响应是否为旧缓存。','No valid fetch timestamp is available; this response may be cached history.');
  if(nowMs-lastSuccessAtMs>fetchLimit||nowMs-fetchedAtMs>fetchLimit)return result('stale','行情取数已过期','Fetch is stale','超过2分钟未获得新鲜响应；暂停新信号。请求成功本身不等于行情已更新。','No fresh response within two minutes; new signals are paused. A successful request alone does not establish current market data.');
  const nowDate=market==='commodity'?commodityTradeDate(nowMs/1000):market==='crypto'?new Date(nowMs).toISOString().slice(0,10):exchangeClock(nowMs/1000,market).date;
  const lastDate=market==='commodity'?commodityTradeDate(last.time):market==='crypto'?new Date(lastBarTimeMs!).toISOString().slice(0,10):exchangeClock(last.time,market).date;
  if(market==='commodity'){
    if(last.low<=0)return result('unknown','价格跨零，暂停预判','Nonpositive futures price',
      '保留来源原始价格，当前区间无法计算百分比指标。','Original market prices are retained. Percentage indicators require a positive price interval.');
    if(!commoditySessionOpen(nowMs/1000))return result('closed','期货常规休市时段','Outside futures trading hours',
      '芝加哥时间每日维护或周末休市，保留最近行情。','Daily maintenance or weekend on the regular Chicago schedule. Showing the last available candles.');
    if(!commodityRegularDate(nowDate))return result('unknown','期货交易时段待核实','Futures schedule unverified',
      '当前交易日的常规时段未经核实，节假日可能提前收市。保留K线，暂停新提醒。','Regular hours are unverified for this trading date. Holiday hours can vary. New alerts are paused.');
  }
  let minute=0;
  if(market==='cn'||market==='us') {
    const clock=exchangeClock(nowMs/1000,market);minute=clock.minute;
    const session=equitySessionOn(market,clock.date);
    if(session.status==='unknown')return result('unknown','交易日历未覆盖','Session calendar unavailable',
      `交易日历尚未覆盖 ${clock.date}，暂停新信号。`,`No verified session calendar for ${clock.date}. New alerts are paused.`);
    if(!session.segments.some(s=>minute>=s.start&&minute<s.end)){
      const lunch=session.segments.length>1&&minute>=session.segments[0].end&&minute<session.segments[1].start;
      const lastEnd=session.segments.at(-1)?.end;
      const early=market==='us'&&lastEnd!==undefined&&lastEnd<960&&minute>=lastEnd;
      const label=lunch?'午间休市':early?'今日已提前收市':session.status==='closed'?'今日休市':'常规交易时段外';
      const en=lunch?'Lunch break':early?'Early close today':session.status==='closed'?'Market closed today':'Outside regular trading hours';
      return result('closed',label,en,`按交易所当地日历，${label}。最近K线日期 ${lastDate}。`,
        `${en} on the exchange calendar. Latest bar date: ${lastDate}.`);
    }
  }
  if(!knownFeed.test(data.source)||/CSV|导入|Imported/i.test(data.source))return result('unknown','来源时效待核实','Source freshness unknown','来源延迟口径未知，不能将取数成功标为实时行情；暂停新信号。','The source latency is unknown. A successful fetch is not labeled real-time; new signals are paused.');
  const timestampNote='来源仅提供K线时间，未提供逐笔更新时间。';
  const timestampNoteEn='The provider exposes bar timestamps, not a verified last-trade timestamp.';
  if(market==='commodity'&&((calendar&&bucket(nowDate,interval)===bucket(lastDate,interval))||
      (!calendar&&nowDate===lastDate&&nowMs-lastBarTimeMs!<=spans[interval as Exclude<Interval,'1M'>]+COMMODITY_DELAY_SECONDS*1000+60000))){
    return result('delayed','期货延时行情','Delayed futures data','公开期货行情可能延迟，交易日按芝加哥时段计算。','Public futures data may be delayed. Trading dates follow the Chicago session.');
  }
  if(calendar) {
    if(bucket(nowDate,interval)!==bucket(lastDate,interval))return result(market==='crypto'?'stale':'unknown','最新周期尚未覆盖','Latest period not covered',
      market==='crypto'?'最近K线未覆盖当前自然周期；暂停新信号。':'最新日/周/月K线未覆盖当前周期；可能为休市、节假日或仅提供已收盘历史，暂不发新信号。',
      market==='crypto'?'The latest candle does not cover the current calendar period; new signals are paused.':'The current day/week/month is not covered. A holiday, closure or closed-history-only feed may explain the gap; new signals are paused.');
    return result('fresh','周期覆盖正常','Period coverage current',`${timestampNote}当前自然周期已覆盖，不能据此确认周期内每笔报价的时效。`,`${timestampNoteEn} The current calendar period is covered; this does not verify every price update within it.`);
  }
  const intervalMs=spans[interval as Exclude<Interval,'1M'>];
  const normalLag=intervalMs+60000,delayedLag=normalLag+(expectedDelayMs||0);
  const age=nowMs-lastBarTimeMs!;
  if(market==='commodity'&&lastDate!==nowDate)return result('stale','等待本期货交易日行情','Waiting for this futures session',
    '最新K线仍属于上一交易日，暂停新提醒。','The latest candle is from a previous trading date. New alerts are paused.');
  if((market==='cn'||market==='us')&&lastDate!==nowDate) {
    if(minute<570+delayedLag/60000)return {...result('delayed','开盘数据衔接中','Opening-session delay',
      '仍是上一交易日K线，处于开盘容忍窗口；等待当前交易日数据前不应追报旧信号。',
      'The feed still contains the prior session during the opening grace window. Do not replay old signals while waiting for current-session bars.'),allowSignals:false};
    return result('unknown','缺少今日行情','No bars for this session','交易日历显示当前正在交易，尚未收到该标的今日K线。个股停牌或数据源缺失均有可能，暂停新信号。','The exchange is in session but this instrument has no bars today. A trading halt or missing feed data is possible. New alerts are paused.');
  }
  if(age>delayedLag)return result('stale','行情K线滞后','Market bars are stale',`${timestampNote}最新K线已落后于周期及保守延迟容忍窗口，暂停新信号。`,`${timestampNoteEn} The latest bar is behind its interval and conservative delay allowance; new signals are paused.`);
  if(age>normalLag)return result('delayed','行情存在延迟','Delayed market data',`${timestampNote}仍在本工具的保守延迟容忍窗口内；该窗口不是数据源的实时承诺。`,`${timestampNoteEn} The lag is within this tool's conservative allowance, not a provider latency guarantee.`);
  return result('fresh','周期覆盖正常','Period coverage current',timestampNote+'取数与最新K线覆盖均通过检查，仍不宣称逐笔实时。',timestampNoteEn+' Fetch age and bar coverage pass the checks; tick-level real-time delivery is not claimed.');
}
