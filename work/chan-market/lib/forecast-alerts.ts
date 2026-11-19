import type {MarketData} from './market-types.ts';
import type {MarketForecast} from './forecast-types.ts';
import {currentRiskTouches,forecastIdentity,type ForecastJournal,type ForecastEvent,type RiskTouch} from './forecast-journal.ts';
import {forecastCohort,forecastVersionKey} from './forecast-audit.ts';
export interface ForecastNotice {id:string;symbol:string;interval:string;side:'long'|'short';type:ForecastEvent['type']|RiskTouch['type'];at:number;price:number;intrabar:boolean}
/** Only newly observed changes in the current clear direction produce alerts.
 * The first quote in a window establishes a baseline, not a catch-up alert. */
export function selectForecastNotices(journal:ForecastJournal,data:MarketData,forecast:MarketForecast,events:ForecastEvent[],options:{now:number;startedAt:number;previousPrice:number|undefined;allowSignals:boolean;seen:Set<string>}):ForecastNotice[] {
  if(!options.allowSignals||options.previousPrice===undefined||forecast.direction==='neutral')return [];
  // Preserve older observations for review, but never issue them as alerts for
  // the currently running model or mix them with its input/parameter version.
  const cohort=forecastVersionKey(forecast);
  journal={...journal,records:journal.records.filter(r=>forecastCohort(r)===cohort)};
  const key=forecastIdentity(data),alerts:ForecastNotice[]=[],add=(n:ForecastNotice)=>{if(options.seen.has(n.id))return;options.seen.add(n.id);alerts.push(n);};
  for(const event of events) {
    const r=journal.records.find(r=>r.key===key&&r.events.some(e=>e.id===event.id));
    if(!r||event.at<options.startedAt||options.now-event.at>180||event.at>options.now||forecast.direction!==r.outlook.side)continue;
    if(!['condition-met','target1','target2','invalidated'].includes(event.type))continue;
    add({id:`${r.key}:${r.outlook.side}:${event.type}:${event.barTime}`,symbol:r.symbol,interval:r.interval,side:r.outlook.side,type:event.type,at:event.at,price:event.price,intrabar:false});
  }
  const latest=journal.records.findLast(r=>r.key===key&&r.status==='condition-met'&&r.outlook.side===forecast.direction);
  for(const touch of currentRiskTouches(journal,data,options.now)) {
    const prior=options.previousPrice,wasInside=touch.type==='invalidation'?(touch.side==='long'?prior>touch.level:prior<touch.level):(touch.side==='long'?prior<touch.level:prior>touch.level);
    if(touch.recordId===latest?.id&&wasInside)add({...touch,id:`${key}:${touch.side}:touch:${touch.type}:${touch.level.toPrecision(10)}`,intrabar:true});
  }
  return alerts;
}
