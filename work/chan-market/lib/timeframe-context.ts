import type { Candle, Interval, Market, MarketData } from './market-types';
import {equityExchangeClock,equitySessionOn,equityWeekLastSession} from './equity-calendar.ts';
import {commodityBarEnd,commodityClock,COMMODITY_DELAY_SECONDS} from './commodity-session.ts';

const seconds: Record<Exclude<Interval, '1M'>, number> = {
  '1m':60, '5m':300, '15m':900, '30m':1800, '1h':3600, '4h':14400, '1d':86400, '1w':604800,
};
export function exchangeClock(time:number,market:'cn'|'us'|'commodity') {
  return market==='commodity'?commodityClock(time):equityExchangeClock(market,time);
}
/** Exchange-local wall clock to epoch, including New York DST at the target date. */
function localEpoch(date:string,minute:number,market:'cn'|'us'):number {
  const wall=Date.parse(`${date}T00:00:00Z`)/1000+minute*60;
  let guess=wall;
  for(let i=0;i<3;i++) {
    const c=exchangeClock(guess,market);
    const observed=Date.parse(`${c.date}T00:00:00Z`)/1000+c.minute*60;
    const delta=wall-observed;
    guess+=delta;
    if(!delta)break;
  }
  return guess;
}
export function higherInterval(market:Market,interval:Interval):Interval|null {
  const next:Record<Interval,Interval|null>={'1m':'5m','5m':'15m','15m':'1h','30m':'4h','1h':'4h','4h':'1d','1d':'1w','1w':'1M','1M':null};
  // A-share 4H is already the entire trading day; never count 4H and 1D as two confirmations.
  if(market==='cn'&&interval==='1h')return '1d';
  if(market==='cn'&&interval==='4h')return '1w';
  return next[interval];
}

/** Earliest conservative availability, not a prediction of the next trade time.
 * The feeds use start-labelled crypto/Yahoo bars and end-labelled China/EM minute bars.
 * Use the published session close on shortened days. Outside calendar coverage
 * use the later nominal close as a conservative availability bound.
 */
export function candleAvailableAt(candle:Pick<Candle,'time'>,market:Market,interval:Interval,source=''):number {
  if(!Number.isFinite(candle.time))return Infinity;
  if(market==='commodity')return commodityBarEnd(candle.time,interval)+COMMODITY_DELAY_SECONDS;
  if(market==='crypto') {
    if(interval!=='1M')return candle.time+seconds[interval];
    const d=new Date(candle.time*1000);
    return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)/1000;
  }
  const c=exchangeClock(candle.time,market),delay=market==='cn'?120:900;
  const day=new Date(`${c.date}T00:00:00Z`);
  if(interval==='1M') {
    day.setUTCMonth(day.getUTCMonth()+1,1);
    return localEpoch(day.toISOString().slice(0,10),0,market);
  }
  if(interval==='1w') {
    const last=equityWeekLastSession(market,c.date);
    if(last)return localEpoch(last.date,last.end,market)+delay;
    day.setUTCDate(day.getUTCDate()+(5-day.getUTCDay()+7)%7);
    return localEpoch(day.toISOString().slice(0,10),market==='cn'?900:960,market)+delay;
  }
  const close=equitySessionOn(market,c.date).segments.at(-1)?.end??(market==='cn'?900:960);
  if(interval==='1d')return localEpoch(c.date,close,market)+delay;
  if(interval==='4h')return localEpoch(c.date,market==='us'&&c.minute<810?Math.min(810,close):close,market)+delay;
  if(market==='cn'||/东方财富|Eastmoney|周期结束/i.test(source))return candle.time+delay;
  // Longbridge minute bars are start-labelled and span pre/post/overnight sessions; the
  // regular-session-end clamp would mark evening overnight bars as available too early.
  if(/Longbridge/i.test(source))return candle.time+seconds[interval]+delay;
  return Math.min(candle.time+seconds[interval],localEpoch(c.date,close,market))+delay;
}

/** Filter by what was available at the lower-timeframe close, never by today's closed flag alone. */
export function eligibleHigherCandles(data:MarketData,asOf:number):Candle[] {
  if(!Number.isFinite(asOf))return [];
  return data.candles.filter(c=>c.closed===true&&candleAvailableAt(c,data.instrument.market,data.interval,data.source)<=asOf);
}
