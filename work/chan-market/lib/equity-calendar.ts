import { equityCalendarData } from './equity-calendar-data.ts';

type Market = 'us'|'hk'|'cn';
export interface SessionWindow { start:number; end:number }
interface Session { status:'open'|'closed'|'unknown'; segments:readonly SessionWindow[] }
const unknown:Session={status:'unknown',segments:[]};
const closed:Session={status:'closed',segments:[]};
const dayMillis=86400000;

export function equityCalendarCoverage(market:Market):{start:string;end:string} {
  const {start,end}=equityCalendarData[market];
  return {start,end};
}

/** ISO date in the exchange's own timezone; an uncovered date is never guessed. */
export function equitySessionOn(market:Market,date:string):Session {
  const table=equityCalendarData[market];
  if(date<table.start||date>table.end||!/^\d{4}-\d{2}-\d{2}$/.test(date))return unknown;
  const ms=Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==date)return unknown;
  const year=date.slice(0,4),years:Record<string,string>=table.years;
  const ordinal=(ms-Date.UTC(Number(year),0,1))/dayMillis;
  const code=years[year]?.[ordinal];
  if(code===undefined)return unknown;
  return code==='0'?closed:{status:'open',segments:table.layouts[Number(code)]};
}

const clocks=Object.fromEntries(Object.entries({cn:'Asia/Shanghai',hk:'Asia/Hong_Kong',us:'America/New_York'}).map(([market,timeZone])=>
  [market,new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})]
)) as Record<Market,Intl.DateTimeFormat>;

export function equityExchangeClock(market:Market,time:number):{date:string;minute:number} {
  const clock=new Date(time*1000);
  if(!Number.isFinite(clock.getTime()))return {date:'',minute:NaN};
  const parts=Object.fromEntries(clocks[market].formatToParts(clock).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,minute:Number(parts.hour)*60+Number(parts.minute)};
}

export function equitySessionDate(market:Market,epochSeconds:number):string {
  return equityExchangeClock(market,epochSeconds).date;
}

export function equityWeekLastSession(market:Market,date:string):{date:string;end:number}|undefined {
  const day=Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(day))return;
  const monday=day-((new Date(day).getUTCDay()+6)%7)*dayMillis;
  let last:{date:string;end:number}|undefined;
  for(let i=0;i<5;i++){
    const key=new Date(monday+i*dayMillis).toISOString().slice(0,10);
    const session=equitySessionOn(market,key);
    if(session.status==='unknown')return;
    if(session.status==='open')last={date:key,end:session.segments.at(-1)!.end};
  }
  return last;
}

/** Split after 240 traded minutes. The A-share window spans its lunch break,
 * while the child bars are drawn only from the two trading segments. */
export function equityFourHourWindows(market:Market,date:string):SessionWindow[] {
  const windows:SessionWindow[]=[];
  let remaining=0;
  for(const segment of equitySessionOn(market,date).segments){
    for(let cursor=segment.start;cursor<segment.end;){
      if(remaining===0){windows.push({start:cursor,end:cursor});remaining=240;}
      const used=Math.min(remaining,segment.end-cursor);
      cursor+=used;remaining-=used;
      windows[windows.length-1].end=cursor;
    }
  }
  return windows;
}
