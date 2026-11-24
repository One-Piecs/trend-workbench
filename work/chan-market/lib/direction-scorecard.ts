import {forecastVersionKey} from './forecast-audit.ts';
import {forecastBarStart} from './forecast-journal.ts';
import {breakoutBarContinuity} from './breakout-vwap.ts';
import {candleAvailableAt} from './timeframe-context.ts';
import type {ForecastDirection, MarketForecast} from './forecast-types.ts';
import type {Candle, Market, MarketData, Interval} from './market-types.ts';

export const DIRECTION_HORIZON=12;
export const SCORE_PROTOCOL='direction-forward-12-v1';
export interface DirectionObservation {
  id:string; series:string; anchor:number; anchorClose:number; published:number;
  prediction:ForecastDirection; baseline:ForecastDirection|null;
}
export interface DirectionResult extends DirectionObservation {
  status:'matured'|'gap'; firstTime?:number; endTime?:number; open?:number; close?:number; outcome?:ForecastDirection;
}
export interface DirectionBook {
  series:string;feed:string;market:Market;symbol:string;interval:Interval;source:string;adjustment:string;contract?:string;
  version:string;lastAnchor:number;pending:DirectionObservation[];
  seen:number;matured:number;gap:number;abstained:number;calls:number;hits:number;pairs:number;pairedHits:number;baselineHits:number;
  separateThrough:number;separatePairs:number;winsOnly:number;lossesOnly:number;
}
const direction=(end:number,start:number):ForecastDirection=>end>start?'long':end<start?'short':'neutral';
export function directionFeed(d:MarketData) {
  return JSON.stringify([d.instrument.market,d.instrument.symbol,d.interval,d.source,d.adjustment,d.instrument.contract??'']);
}
export function directionVersion(f:MarketForecast) {
  return SCORE_PROTOCOL+' / '+forecastVersionKey(f);
}
export function emptyDirectionBook(data:MarketData,version:string):DirectionBook {
  const feed=directionFeed(data);
  return {feed,series:JSON.stringify([feed,version]),market:data.instrument.market,symbol:data.instrument.symbol,interval:data.interval,
    source:data.source,adjustment:data.adjustment,contract:data.instrument.contract,version,lastAnchor:0,pending:[],
    seen:0,matured:0,gap:0,abstained:0,calls:0,hits:0,pairs:0,pairedHits:0,baselineHits:0,separateThrough:0,separatePairs:0,winsOnly:0,lossesOnly:0};
}

export function prepareDirectionBars(data:MarketData,now:number) {
  const asOf=Date.parse(data.asOf)/1000;
  if(!Number.isFinite(now)||!Number.isFinite(asOf)||asOf>now+2)return null;
  const bars:Candle[]=[],positions=new Map<number,number>();
  let previous=0,unfinished=false;
  for(const c of data.candles){
    if(!Number.isSafeInteger(c.time)||c.time<=previous||![c.open,c.high,c.low,c.close].every(Number.isFinite)
      ||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close))return null;
    previous=c.time;
    if(c.closed!==true){unfinished=true;continue;}
    if(unfinished)return null;
    positions.set(c.time,bars.length);bars.push(c);
  }
  while(bars.length&&candleAvailableAt(bars.at(-1)!,data.instrument.market,data.interval,data.source)>Math.min(now,asOf)){
    positions.delete(bars.pop()!.time);
  }
  if(!bars.length)return null;
  return {bars,positions,adjacent:breakoutBarContinuity(data.instrument.market,data.interval,data.source)};
}
type Prepared=NonNullable<ReturnType<typeof prepareDirectionBars>>;

function freeze(book:DirectionBook,data:MarketData,f:MarketForecast,p:Prepared,now:number):DirectionObservation|null {
  const last=p.bars.at(-1)!;
  if(f.status!=='ready'||!f.modelVersion||!f.analysisVersion||!f.parameterVersion||directionVersion(f)!==book.version
    ||f.context.market!==book.market||f.context.symbol!==book.symbol||f.context.interval!==book.interval
    ||f.context.source!==book.source||f.context.adjustment!==book.adjustment||f.lastClosedTime!==last.time
    ||f.lastClosedPrice!==last.close||f.structureAsOf!==candleAvailableAt(last,book.market,book.interval,data.source)
    ||!Number.isFinite(f.asOf)||f.asOf>now+2||last.time<=book.lastAnchor)return null;
  const previous=p.bars.slice(-DIRECTION_HORIZON-1);
  const intact=previous.length===DIRECTION_HORIZON+1&&previous.every((c,i)=>i===0||p.adjacent(previous[i-1],c));
  return {id:JSON.stringify([book.series,last.time]),series:book.series,anchor:last.time,anchorClose:last.close,published:now,
    prediction:f.direction,baseline:intact?direction(last.close,previous[0].close):null};
}

function settle(r:DirectionObservation,p:Prepared,data:MarketData):DirectionResult|null {
  const at=p.positions.get(r.anchor);
  if(at===undefined)return p.bars[0].time>r.anchor?{...r,status:'gap'}:null;
  if(p.bars[at].close!==r.anchorClose)return {...r,status:'gap'};
  let first=-1;
  for(let i=at+1;i<p.bars.length;i++){
    const bar=p.bars[i];
    if(!p.adjacent(p.bars[i-1],bar))return {...r,status:'gap'};
    if(first<0&&forecastBarStart(bar,data)>=r.published)first=i;
    if(first>=0&&i-first+1===DIRECTION_HORIZON){
      const open=p.bars[first].open;
      return {...r,status:'matured',firstTime:p.bars[first].time,endTime:bar.time,open,close:bar.close,outcome:direction(bar.close,open)};
    }
  }
  return null;
}
function tally(book:DirectionBook,row:DirectionResult) {
  if(row.status==='gap'){book.gap++;return;}
  book.matured++;
  if(row.prediction==='neutral'){book.abstained++;return;}
  book.calls++;
  const hit=Number(row.prediction===row.outcome);
  book.hits+=hit;
  if(!row.baseline||row.baseline==='neutral')return;
  const baseline=Number(row.baseline===row.outcome);
  book.pairs++;book.pairedHits+=hit;book.baselineHits+=baseline;
  if(row.firstTime!<=book.separateThrough)return;
  book.separateThrough=row.endTime!;
  book.separatePairs++;
  if(hit>baseline)book.winsOnly++;
  if(hit<baseline)book.lossesOnly++;
}

/** Returns a replacement plus immutable observation/audit rows for a single atomic commit. */
export function updateDirectionBook(book:DirectionBook,p:Prepared,data:MarketData,f:MarketForecast|null,now:number) {
  if(book.feed!==directionFeed(data))return null;
  const resolved:DirectionResult[]=[];
  const pending=book.pending.filter(row=>{
    const result=settle(row,p,data);
    if(result)resolved.push(result);
    return !result;
  });
  const fresh=f?freeze(book,data,f,p,now):null;
  if(!fresh&&!resolved.length)return null;
  const next={...book,pending};
  for(const result of resolved)tally(next,result);
  if(fresh){next.pending.push(fresh);next.lastAnchor=fresh.anchor;next.seen++;}
  return {book:next,rows:fresh?[...resolved,fresh]:resolved};
}

// Difference = P(only model correct) - P(only baseline correct). Two 97.5%
// Wilson bounds give a conservative paired interval (Bonferroni). Use only
// disjoint outcome windows; the approximation still assumes independent pairs.
export function pairedDirectionInterval(book:DirectionBook):[number,number]|null {
  const n=book.separatePairs;
  if(n<30)return null;
  function bounds(k:number){
    const z=2.2414,p=k/n,den=1+z*z/n;
    const center=(p+z*z/(2*n))/den,radius=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den;
    return [Math.max(0,center-radius),Math.min(1,center+radius)];
  }
  const [loWin,hiWin]=bounds(book.winsOnly),[loLoss,hiLoss]=bounds(book.lossesOnly);
  return [(loWin-hiLoss)*100,(hiWin-loLoss)*100];
}
