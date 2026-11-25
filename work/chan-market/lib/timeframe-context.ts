import type { Candle, Interval, Market, MarketData } from './market-types';
import {equityExchangeClock,equityFourHourWindows,equitySessionOn,equityWeekLastSession} from './equity-calendar.ts';
import {commodityBarEnd,commodityClock,COMMODITY_DELAY_SECONDS} from './commodity-session.ts';

const seconds: Record<Exclude<Interval, '1M'>, number> = {
  '1m':60, '5m':300, '15m':900, '30m':1800, '1h':3600, '4h':14400, '1d':86400, '1w':604800,
};
export function exchangeClock(time:number,market:'cn'|'hk'|'us'|'commodity') {
  return market==='commodity'?commodityClock(time):equityExchangeClock(market,time);
}
/** Exchange-local wall clock to epoch, including New York DST at the target date. */
function localEpoch(date:string,minute:number,market:'cn'|'hk'|'us'):number {
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

export function candleDelaySeconds(market:Market,interval:Interval,source=''):number {
  if(market==='commodity')return COMMODITY_DELAY_SECONDS;
  if(market==='crypto'||interval==='1M')return 0;
  if((market==='us'||market==='hk'||market==='cn')&&/Longbridge/i.test(source))return 0;
  return market==='cn'?120:900;
}

/** Earliest conservative availability, not a prediction of the next trade time.
 * The feeds use start-labelled crypto/Yahoo bars and end-labelled China/EM minute bars.
 * Use the published session close on shortened days. Outside calendar coverage
 * use the later nominal close as a conservative availability bound.
 */
export function candleAvailableAt(candle:Pick<Candle,'time'>,market:Market,interval:Interval,source=''):number {
  if(!Number.isFinite(candle.time))return Infinity;
  const delay=candleDelaySeconds(market,interval,source);
  if(market==='commodity')return commodityBarEnd(candle.time,interval)+delay;
  if(market==='crypto') {
    if(interval!=='1M')return candle.time+seconds[interval];
    const d=new Date(candle.time*1000);
    return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)/1000;
  }
  const c=exchangeClock(candle.time,market);
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
  const session=equitySessionOn(market,c.date);
  const close=session.segments.at(-1)?.end??(market==='cn'?900:960);
  if(interval==='1d')return localEpoch(c.date,close,market)+delay;
  if(interval==='4h') {
    const fourHourWindow=equityFourHourWindows(market,c.date).find(w=>c.minute>=w.start&&c.minute<w.end);
    const fourHourClose=fourHourWindow?fourHourWindow.end:market==='us'&&c.minute<810?Math.min(810,close):market==='hk'&&c.minute<870?Math.min(870,close):close;
    return localEpoch(c.date,fourHourClose,market)+delay;
  }
  if((market==='cn'&&!/Longbridge/i.test(source))||/东方财富|Eastmoney|周期结束/i.test(source))return candle.time+delay;
  // Longbridge minute/hour bars are start-labelled without the public delay.
  if(/Longbridge/i.test(source)) {
    let end=candle.time+seconds[interval];
    if(market==='us') {
      if(interval==='1h'&&session.segments.length) {
        const open=session.segments[0].start;
        if(c.minute<open&&c.minute+60>open)end=Math.min(end,localEpoch(c.date,open,market));
        if(c.minute<close&&c.minute+60>close)end=Math.min(end,localEpoch(c.date,close,market));
      }
      return end+delay;
    }
    if(c.minute>=close)return candle.time+60+delay;
    const segment=session.segments.find(s=>c.minute>=s.start&&c.minute<s.end);
    const segmentEnd=segment?segment.end:close;
    return Math.min(end,localEpoch(c.date,segmentEnd,market))+delay;
  }
  const segment=session.segments.find(s=>c.minute>=s.start&&c.minute<s.end);
  return Math.min(candle.time+seconds[interval],localEpoch(c.date,segment?segment.end:close,market))+delay;
}

/** Filter by what was available at the lower-timeframe close, never by today's closed flag alone. */
export function eligibleHigherCandles(data:MarketData,asOf:number):Candle[] {
  if(!Number.isFinite(asOf))return [];
  return data.candles.filter(c=>c.closed===true&&candleAvailableAt(c,data.instrument.market,data.interval,data.source)<=asOf);
}
