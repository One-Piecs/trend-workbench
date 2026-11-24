import type {Candle,MarketData} from './market-types';
import {forecastIdentity,type ForecastRecord} from './forecast-journal.ts';
import {createMinuteExitResolver} from './forecast-validation-minutes.ts';
import {candleAvailableAt} from './timeframe-context.ts';

type ReviewInput={kind:'ready'; primary:MarketData; parent:Candle; start:number; end:number};
export type ReviewContext=ReviewInput|{kind:'none'|'missing-parent'|'unsupported'|'same-minute'};
export type TargetOrder={order:'target-first'|'stop-first'|'same-minute'|'unavailable'|'untouched';minuteStart?:number};

export function journalReviewContext(record:ForecastRecord,current:MarketData|null):ReviewContext{
  const ambiguous=record.events.find(e=>e.type==='ambiguous');
  if(!ambiguous||record.status!=='ambiguous'||!record.events.some(e=>e.type==='condition-met'&&e.barTime<ambiguous.barTime))return {kind:'none'};
  if(record.interval==='1m')return {kind:'same-minute'};
  if(record.market!=='crypto'||['1w','1M'].includes(record.interval)||!/^((Binance|Bitget|Bybit|OKX) 公共现货行情 · )/.test(record.source))return {kind:'unsupported'};
  const matching=current&&forecastIdentity(current)===record.key?current:null;
  const parent=ambiguous.observedParent?.candle??matching?.candles.find(b=>b.time===ambiguous.barTime);
  const instrument=ambiguous.observedParent?.instrument??matching?.instrument;
  if(!parent||parent.time!==ambiguous.barTime||parent.closed!==true||!instrument||
    instrument.market!==record.market||instrument.symbol!==record.symbol||instrument.id!==`crypto:${record.symbol}`||
    ![parent.open,parent.high,parent.low,parent.close].every(n=>Number.isFinite(n)&&n>0)||
    parent.low>Math.min(parent.open,parent.close)||parent.high<Math.max(parent.open,parent.close))return {kind:'missing-parent'};
  const end=candleAvailableAt(parent,record.market,record.interval,record.source);
  if(end!==ambiguous.at||!record.events.some(e=>e.type==='condition-met'&&e.at<=parent.time))return {kind:'missing-parent'};
  const buy=record.outlook.side==='long',p=record.outlook;
  if(!(buy?parent.low<=p.invalidationPrice&&parent.high>=p.targets[0].price:
    parent.high>=p.invalidationPrice&&parent.low<=p.targets[0].price))return {kind:'missing-parent'};
  const primary:MarketData={instrument,interval:record.interval,source:record.source,adjustment:record.adjustment,
    candles:[parent],asOf:new Date(end*1000).toISOString(),delayNotice:'',availableIntervals:[record.interval],warnings:[]};
  return {kind:'ready',primary,parent,start:parent.time,end};
}

export function reviewJournalMinuteOrder(record:ForecastRecord,input:ReviewInput,minutes:MarketData):TargetOrder[]{
  const {primary,parent}=input,p=record.outlook,buy=p.side==='long';
  const resolve=createMinuteExitResolver(primary,minutes);
  return p.targets.map(target=>{
    if(buy?parent.high<target.price:parent.low>target.price)return {order:'untouched'};
    const result=resolve(parent,buy,p.invalidationPrice,target.price);
    if(result.resolution==='same-minute')return {order:'same-minute'};
    if(result.resolution!=='minute')return {order:'unavailable'};
    return {order:result.reason==='target2'?'target-first':'stop-first',minuteStart:result.availableAt-60};
  });
}
