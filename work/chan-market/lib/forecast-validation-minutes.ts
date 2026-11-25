import {commoditySessionOpen} from './commodity-session.ts';
import type { Candle, MarketData } from './market-types';
import { compatibleMarketFeeds } from './higher-from-primary.ts';
import { forecastBarStart } from './forecast-journal.ts';
import { candleAvailableAt, candleDelaySeconds, exchangeClock } from './timeframe-context.ts';

export type IntrabarUnknown = 'missing-minutes'|'incompatible-source'|'incomplete-minutes'|'inconsistent-ohlc'|'same-minute'|'unsupported-period';
type MinuteResult = {resolution:IntrabarUnknown}|{resolution:'minute';reason:'stop'|'gap-stop'|'target2';price:number;availableAt:number};

/** The runner can supply noncontiguous minute windows from the same feed. Index them
 * once. Duplicate rows cannot count as evidence, even if their prices happen to agree. */
export function createMinuteExitResolver(primary:MarketData,minute?:MarketData) {
  const byTime=new Map<number,Candle|null>();
  const sameFeed=minute?.interval==='1m'&&compatibleMarketFeeds(primary,minute)
    &&(['id','currency','exchange'] as const).every(k=>primary.instrument[k]&&primary.instrument[k]===minute.instrument[k]);
  if(minute&&sameFeed)for(const b of minute.candles)byTime.set(b.time,byTime.has(b.time)?null:b);
  const capture=Math.min(Date.parse(primary.asOf),Date.parse(minute?.asOf??''))/1000;

  return function resolve(parent:Candle,buy:boolean,stop:number,target:number):MinuteResult {
    const market=primary.instrument.market,interval=primary.interval;
    if(interval==='1m')return {resolution:'same-minute'};
    // Weekly and monthly equity bars require a historical holiday/half-day calendar.
    if(market!=='crypto'&&['1w','1M'].includes(interval))return {resolution:'unsupported-period'};
    if(!minute)return {resolution:'missing-minutes'};
    if(!sameFeed)return {resolution:'incompatible-source'};
    const delay=candleDelaySeconds(market,interval,primary.source);
    const start=forecastBarStart(parent,primary),end=candleAvailableAt(parent,market,interval,primary.source)-delay;
    if(start%60!==0||end%60!==0||end<=start||end-start>31*86400)return {resolution:'unsupported-period'};
    let localStart=0,endLabel=false;
    if(market==='commodity'&&(!commoditySessionOpen(start)||!commoditySessionOpen(end-1)))return {resolution:'unsupported-period'};
    if(market==='cn'||market==='hk'||market==='us') {
      const source=minute.source;
      const isLongbridge=/^Longbridge/i.test(source);
      endLabel=!isLongbridge&&(market==='cn'?/^(东方财富|腾讯证券|新浪财经)/.test(source):/^(东方财富|Eastmoney)/i.test(source));
      if(!endLabel&&!(isLongbridge||(market==='us'||market==='hk')&&/^Yahoo Finance/i.test(source)))return {resolution:'unsupported-period'};
      const clock=exchangeClock(start,market),day=new Date(clock.date+'T00:00:00Z').getUTCDay();
      localStart=clock.minute;
      if(day===0||day===6||localStart<570||localStart+(end-start)/60>(market==='cn'?900:960))return {resolution:'unsupported-period'};
    }

    let firstOpen=NaN,lastClose=NaN,high=-Infinity,low=Infinity;
    let first:MinuteResult|undefined;
    for(let t=start;t<end;t+=60) {
      const local=localStart+(t-start)/60;
      if(market==='cn'&&local>=690&&local<780)continue;
      if(market==='hk'&&local>=720&&local<780)continue;
      const b=byTime.get(t+(endLabel?60:0)),availableAt=t+60+delay;
      if(!b||!b.closed||!Number.isFinite(capture)||availableAt>capture
        ||![b.open,b.high,b.low,b.close].every(n=>Number.isFinite(n)&&n>0)
        ||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)
        ||!Number.isFinite(b.volume)||b.volume<0)return {resolution:'incomplete-minutes'};
      if(!Number.isFinite(firstOpen))firstOpen=b.open;
      lastClose=b.close;high=Math.max(high,b.high);low=Math.min(low,b.low);
      // Check the entire parent candle before accepting the first observed touch.
      if(first)continue;
      const stopped=buy?b.low<=stop:b.high>=stop,targeted=buy?b.high>=target:b.low<=target;
      if(!stopped&&!targeted)continue;
      const opensStopped=buy?b.open<=stop:b.open>=stop,opensTargeted=buy?b.open>=target:b.open<=target;
      if(stopped&&targeted&&!opensStopped&&!opensTargeted){first={resolution:'same-minute'};continue;}
      if(opensStopped){first={resolution:'minute',reason:'gap-stop',price:b.open,availableAt};continue;}
      const targetFirst=opensTargeted||targeted;
      first={resolution:'minute',reason:targetFirst?'target2':'stop',price:targetFirst?target:stop,availableAt};
    }
    const agrees=(a:number,b:number)=>Number.isFinite(a)&&Math.abs(a-b)<=8*Number.EPSILON*Math.max(Math.abs(a),Math.abs(b));
    if(!first||!agrees(firstOpen,parent.open)||!agrees(high,parent.high)||!agrees(low,parent.low)||!agrees(lastClose,parent.close))return {resolution:'inconsistent-ohlc'};
    return first;
  };
}
