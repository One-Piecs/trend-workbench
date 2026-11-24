import type { Instrument } from './market-types';

const listings = [
  {symbol:'GC=F',name:'黄金期货',exchange:'COMEX',terms:['黄金','金价','纽约金','黄金期货','gold','GC','COMEX gold']},
  {symbol:'SI=F',name:'白银期货',exchange:'COMEX',terms:['白银','银价','纽约银','白银期货','silver','SI','COMEX silver']},
  {symbol:'CL=F',name:'WTI原油期货',exchange:'NYMEX',terms:['原油','油价','美原油','美国原油','石油','WTI','crude oil','oil','CL','NYMEX crude']},
];

export const COMMODITY_INSTRUMENTS: Instrument[] = listings.map(({symbol,name,exchange}) => ({
  id:'commodity:'+symbol,market:'commodity',symbol,name,exchange,currency:'USD',
}));

export function searchCommodities(query:string):Instrument[] {
  const term=query.trim().toLowerCase();
  if(!term)return COMMODITY_INSTRUMENTS.slice();
  return COMMODITY_INSTRUMENTS.filter((instrument,i)=>
    [instrument.symbol,instrument.name,instrument.exchange,...listings[i].terms].some(alias=>alias.toLowerCase().includes(term)));
}
