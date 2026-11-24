import {equityExchangeClock,equitySessionOn} from './equity-calendar.ts';
import {commodityRegularDate,commoditySessionStart,commodityTradeDate} from './commodity-session.ts';
import type {MarketData} from './market-types';

/** Ask the venue about missing bars only where the same session was scheduled
 * to continue. A confirmed halt or a no-trades minute can legitimately stay blank. */
export function latestHistoryGap(data:MarketData) {
  const minutes={'1m':1,'5m':5,'15m':15,'30m':30,'1h':60,'4h':240,'1d':1440,'1w':10080,'1M':0};
  const {market}=data.instrument,step=minutes[data.interval]*60;
  if(!step||market!=='crypto'&&step>=86400)return;
  const endLabel=market==='cn'||(market==='us'&&/东方财富|周期结束/.test(data.source));
  for(let i=data.candles.length-1;i>0;i--){
    const previous=data.candles[i-1],next=data.candles[i],diff=next.time-previous.time;
    if(previous.closed!==true||next.closed!==true||diff<=step||diff%step!==0)continue;
    if(market==='commodity'){
      const start=commoditySessionStart(previous.time);
      if(start===null||start!==commoditySessionStart(next.time)||!commodityRegularDate(commodityTradeDate(next.time)))continue;
    }else if(market!=='crypto'){
      const adjust=endLabel&&data.interval!=='4h'?1:0;
      const a=equityExchangeClock(market,previous.time-adjust),b=equityExchangeClock(market,next.time-adjust);
      if(a.date!==b.date||!equitySessionOn(market,a.date).segments.some(s=>a.minute>=s.start&&b.minute<s.end))continue;
    }
    return {before:next.time,after:previous.time,limit:Math.min(500,diff/step)};
  }
}
