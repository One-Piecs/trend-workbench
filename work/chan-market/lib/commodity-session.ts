import type {Interval} from './market-types';

// GC, SI and CL on CME Globex normally trade from 17:00 on the preceding
// calendar day until 16:00 Chicago time. Calendar labels use the TRADE date.
// https://www.cmegroup.com/markets/metals/precious/gold.contractSpecs.html
export const COMMODITY_DELAY_SECONDS = 900;
// Special-hours windows published by CME at https://www.cmegroup.com/trading-hours.html .
// A listed window can contain shortened OR open sessions. Do not infer a fill
// or a full closure from the list. Outside coverage this calendar is unknown.
const specialWindows:Record<string,readonly (readonly [string,string])[]> = {
 '2026':[
  ['01-01','01-02'],['01-18','01-20'],['02-15','02-17'],['04-02','04-04'],
  ['05-24','05-26'],['06-18','06-19'],['07-03','07-05'],['09-06','09-08'],
  ['11-26','11-28'],['12-24','12-26'],['12-31','12-31'],
 ],
 // CME's 2027 settlement notices include a broader window around some
 // holidays. Treat these as exceptions without assuming identical hours.
 '2027':[
  ['01-01','01-01'],['01-15','01-19'],['02-12','02-16'],['03-25','03-30'],
  ['05-28','06-01'],['06-17','06-21'],['07-02','07-06'],['09-03','09-07'],
  ['10-11','10-11'],['11-11','11-11'],['11-24','11-26'],['12-23','12-27'],['12-31','12-31'],
 ],
};
export function commodityRegularDate(tradeDate:string): boolean {
  const md=tradeDate.slice(5);
  const windows=specialWindows[tradeDate.slice(0,4)];
  return !!windows&&!windows.some(([start,end])=>md>=start&&md<=end);
}
type CalendarInterval = '1d'|'1w'|'1M';
const minutes = {'1m':1,'5m':5,'15m':15,'30m':30,'1h':60,'4h':240};
const day = 86400000;
const chicago = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const nyDate = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const offsets = new Map<string,number>();
const shift = (date:string,n:number) => new Date(Date.parse(date+'T00:00:00Z')+n*day).toISOString().slice(0,10);
const weekday = (date:string) => new Date(date+'T00:00:00Z').getUTCDay();
function businessDay(date:string,direction:1|-1) {
  const w=weekday(date);
  return w===0?shift(date,direction===1?1:-2):w===6?shift(date,direction===1?2:-1):date;
}

export function commodityClock(time:number) {
  if(!Number.isFinite(new Date(time*1000).getTime()))return {date:'',minute:NaN};
  const p=Object.fromEntries(chicago.formatToParts(time*1000).map(x=>[x.type,x.value]));
  return {date:p.year+'-'+p.month+'-'+p.day,minute:60*Number(p.hour)+Number(p.minute)};
}
/** For regular session boundary hours (16:00 or 17:00 CT, after DST changes).
 * Use the offset at the target date, not the user's or fetch-time timezone. */
export function commodityLocalEpoch(date:string,minute:number) {
  const base=Date.parse(date+'T00:00:00Z')/1000;
  if(!Number.isFinite(base))return NaN;
  let offset=offsets.get(date);
  if(offset===undefined){
    offset=(720-commodityClock(base+43200).minute)*60;
    if(offsets.size>=8192)offsets.clear();
    offsets.set(date,offset);
  }
  return base+minute*60+offset;
}
export function commodityTradeDate(time:number) {
  const {minute,date}=commodityClock(time);
  return date && minute>=1020?shift(date,1):date;
}
export function commoditySessionStart(time:number):number|null {
  const {date,minute}=commodityClock(time);
  if(!date||minute>=960&&minute<1020)return null;
  const trade=minute>=1020?shift(date,1):date,w=weekday(trade);
  return w===6||w===0?null:commodityLocalEpoch(shift(trade,-1),1020);
}
export function commoditySessionOpen(time:number) {return commoditySessionStart(time)!==null;}
export function commodityPeriodStart(tradeDate:string,interval:CalendarInterval) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate))return NaN;
  let first=tradeDate;
  if(interval==='1w')first=shift(first,-((weekday(first)+6)%7));
  if(interval==='1M')first=businessDay(first.slice(0,7)+'-01',1);
  return commodityLocalEpoch(shift(first,-1),1020);
}
/** Yahoo daily dates represent the New York calendar trade date, distinct from
 * an intraday timestamp within Sunday evening trading. */
export function commodityCalendarStart(time:number,interval:CalendarInterval) {
  return Number.isFinite(new Date(time*1000).getTime())?commodityPeriodStart(nyDate.format(time*1000),interval):NaN;
}
export function commodityBarEnd(time:number,interval:Interval) {
  const tradeDate=commodityTradeDate(time);
  if(!tradeDate)return Infinity;
  let last=tradeDate;
  if(interval==='1M'){
    const d=new Date(tradeDate+'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth()+1,0);
    last=businessDay(d.toISOString().slice(0,10),-1);
  }else if(interval==='1w'){
    last=shift(tradeDate,4-(weekday(tradeDate)+6)%7);
  }
  const close=commodityLocalEpoch(last,960);
  return interval==='1d'||interval==='1w'||interval==='1M'?close:Math.min(close,time+minutes[interval]*60);
}

export function consecutiveCommodityBars(from:number,to:number,interval:Interval) {
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)return false;
  const session=commoditySessionStart(from);
  if(session===null||commoditySessionStart(to)===null)return false;
  if(interval==='1d'||interval==='1w'||interval==='1M'){
    if(from!==commodityPeriodStart(commodityTradeDate(from),interval)||to!==commodityPeriodStart(commodityTradeDate(to),interval))return false;
  }else if((from-session)%(minutes[interval]*60)!==0)return false;
  const end=commodityBarEnd(from,interval);
  if(to===end)return true;
  if(end!==commodityLocalEpoch(commodityTradeDate(end),960))return false;
  // Strictly require the next normally scheduled session. A holiday or missing
  // session is an unresolved gap, never an invented price or a verified fill.
  const next=businessDay(shift(commodityTradeDate(end),1),1);
  return to===commodityLocalEpoch(shift(next,-1),1020);
}

export function commodityTradingMinutes(from:number,to:number) {
  if(to<=from)return 0;
  if(to-from>370*86400)return Infinity;
  let total=0;
  const last=commodityTradeDate(to);
  for(let date=commodityTradeDate(from);date&&date<=last;date=shift(date,1)){
    if(weekday(date)===0||weekday(date)===6)continue;
    const start=commodityLocalEpoch(shift(date,-1),1020),end=commodityLocalEpoch(date,960);
    total+=Math.max(0,Math.min(end,to)-Math.max(start,from));
  }
  return total/60;
}
