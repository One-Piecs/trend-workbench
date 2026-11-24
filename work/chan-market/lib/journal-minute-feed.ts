import {fetchHistoricalMinutes} from './historical-minutes.ts';
import type {MarketData} from './market-types';

/** The journal supplies its original raw source and adjustment. The shared
 * historical adapter verifies both and selects only fixed spot endpoints. */
export function createJournalMinuteFeed(load=fetchHistoricalMinutes){
  const pending=new Map<string,Promise<MarketData>>();
  const cache=new Map<string,MarketData>();
  return async function read(params:URLSearchParams){
    const symbol=params.get('symbol')??'',venue=params.get('venue')??'',currency=params.get('currency')??'';
    const source=params.get('source')??'',adjustment=params.get('adjustment')??'';
    const start=Number(params.get('start')),end=Number(params.get('end'));
    if(!/^[A-Z0-9]{2,40}$/.test(symbol)||!/^[A-Z0-9]{1,12}$/.test(currency)||!['Binance','Bitget','Bybit','OKX'].includes(venue)||
      source.length>100||adjustment.length>64||![start,end].every(t=>Number.isSafeInteger(t)&&t>0&&t%60===0)||
      end<=start||end-start>86400||end*1000>Date.now())throw new RangeError('分钟核对参数无效。');
    const key=JSON.stringify([symbol,venue,currency,source,adjustment,start,end]);
    const saved=cache.get(key);if(saved)return saved;
    const active=pending.get(key);if(active)return active;
    if(pending.size>=3)throw new Error('分钟行情正忙，请稍后重试。');
    const instrument={id:'crypto:'+symbol,symbol,name:symbol,market:'crypto' as const,currency,exchange:venue};
    const result=load({instrument,source,adjustment},start,end).then(data=>{
      if(cache.size>=16)cache.delete(cache.keys().next().value!);
      cache.set(key,data);return data;
    }).finally(()=>pending.delete(key));
    pending.set(key,result);return result;
  };
}
export const getJournalMinutes=createJournalMinuteFeed();
