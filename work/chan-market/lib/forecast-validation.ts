import {consecutiveCommodityBars} from './commodity-session.ts';
import { analyze } from './chan.ts';
import { buildForecast } from './forecast.ts';
import type { MarketForecast, ReadyForecastSide } from './forecast-types';
import type { Candle, MarketData } from './market-types';
import { candleAvailableAt, exchangeClock, higherInterval } from './timeframe-context.ts';
import { forecastBarStart } from './forecast-journal.ts';
import { compatibleMarketFeeds, deriveHigherFromPrimary } from './higher-from-primary.ts';
import { createMinuteExitResolver, type IntrabarUnknown } from './forecast-validation-minutes.ts';

/** Offline research only. No orders, production state or live filter switches. */
export const FORECAST_VALIDATION_VERSION='forecast-validation-1.1';
export interface ForecastValidationCosts {feeBps:number;slippageBps:number}
export interface ForecastValidationInput {
  primary:MarketData;higher?:MarketData;minute?:MarketData;label?:string;
  costs?:ForecastValidationCosts;folds?:number;warmupFraction?:number;
  minimumCompleted?:number;penMode?:'new'|'old';
}
export interface FrozenForecastObservation {
  id:string;publishedAt:number;publicationIndex:number;referencePrice:number;
  modelVersion:string;parameterVersion:string;analysisVersion:string;window:number;
  forecast:ReadyForecastSide;
  regime:MarketForecast['regime'];
  shadowAccepted:boolean;duplicateGeometry:boolean;
}
export type ValidationOutcomeStatus='untriggered'|'expired'|'invalidated-before-entry'|'missed-condition'|'ambiguous-confirmation'|'ambiguous-exit'|'data-gap'|'no-next-bar'|'unavailable-entry'|'skipped-entry'|'ineligible-short'|'restricted-exit'|'open'|'closed'|'overlap-rejected';
export interface ForecastValidationOutcome {
  id:string;side:'long'|'short';publishedAt:number;status:ValidationOutcomeStatus;
  conditionAt?:number;conditionIndex?:number;entryAt?:number;entryIndex?:number;entryPrice?:number;
  exitAt?:number;exitIndex?:number;exitPrice?:number;
  exitReason?:'stop'|'gap-stop'|'target2';
  intrabarResolution?:'minute'|IntrabarUnknown;
  netReturnPct?:number;netR?:number;overlapsWith?:string;
  shadowAccepted:boolean;duplicateGeometry:boolean;reason:string;
}
const DEFAULT_COSTS:ForecastValidationCosts={feeBps:5,slippageBps:3};
const positive=(n:number)=>Number.isFinite(n)&&n>0;

function validateCosts(costs:ForecastValidationCosts) {
  if(![costs.feeBps,costs.slippageBps].every(n=>Number.isFinite(n)&&n>=0&&n<1000))throw new Error('Costs must be finite and between 0 and 1000 bps.');
}
/** Reject malformed history rather than silently repairing it into profitable events. */
export function validationClosedBars(data:MarketData):Candle[] {
  const capturedAt=Date.parse(data.asOf)/1000;
  if(!Number.isFinite(capturedAt))throw new Error('A saved source capture timestamp is required.');
  const closed:Candle[]=[];let tail=false,last=-Infinity;
  for(const b of data.candles) {
    const priceValid=data.instrument.market==='commodity'?Number.isFinite:positive;
    if(!positive(b.time)||b.time<=last||![b.open,b.high,b.low,b.close].every(priceValid)||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||!Number.isFinite(b.volume)||b.volume<0)throw new Error('Invalid or unordered source OHLCV.');
    last=b.time;
    const available=candleAvailableAt(b,data.instrument.market,data.interval,data.source);
    if(b.closed!==true||available>capturedAt){tail=true;continue;}
    if(tail)throw new Error('Unavailable or unfinished candle precedes an available closed candle.');
    if(b.low<=0)closed.length=0;
    else closed.push({...b});
  }
  return closed;
}
function geometry(p:ReadyForecastSide):boolean {
  return [p.zoneLow,p.zoneHigh,p.triggerPrice,p.invalidationPrice,...p.targets.map(t=>t.price)].every(positive)
    &&p.zoneLow<=p.triggerPrice&&p.triggerPrice<=p.zoneHigh
    &&(p.side==='long'?p.invalidationPrice<p.zoneLow&&p.zoneHigh<p.targets[0].price&&p.targets[0].price<p.targets[1].price:p.invalidationPrice>p.zoneHigh&&p.zoneLow>p.targets[0].price&&p.targets[0].price>p.targets[1].price);
}
function hasGap(previous:Candle,next:Candle,data:MarketData):boolean {
  const market=data.instrument.market,interval=data.interval;
  const spans={'1m':60,'5m':300,'15m':900,'30m':1800,'1h':3600,'4h':14400,'1d':86400,'1w':604800};
  if(market==='commodity')return !consecutiveCommodityBars(previous.time,next.time,interval);
  if(market==='crypto') {
    if(interval==='1M'){const d=new Date(previous.time*1000);return next.time>Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)/1000+1;}
    return next.time-previous.time>spans[interval]+1;
  }
  if(['1d','1w','1M'].includes(interval))return false; // Calendar/halts remain an explicit execution limitation.
  const a=exchangeClock(previous.time,market),b=exchangeClock(next.time,market);
  if(a.date!==b.date)return false;
  let elapsed=next.time-previous.time;
  if(market==='cn'&&a.minute<=690&&b.minute>=780)elapsed-=90*60;
  return elapsed>spans[interval as keyof typeof spans]+1;
}

/** Freeze a current production outlook, not legacy tradePlans or a recalculated past signal. */
export function freezeValidationForecast(forecast:MarketForecast,publicationIndex:number,window:number,analysisVersion:string):FrozenForecastObservation|null {
  if(forecast.status!=='ready'||forecast.mode!=='structure'||forecast.direction==='neutral'||forecast.referencePrice===null||forecast.structureAsOf===null)return null;
  const side=forecast[forecast.direction];if(side.status!=='ready'||!geometry(side))return null;
  const id=[forecast.context.market,forecast.context.symbol,forecast.context.interval,forecast.context.source,forecast.context.adjustment,forecast.lastClosedTime,side.side].join('|');
  return {id,publishedAt:forecast.asOf,publicationIndex,referencePrice:forecast.referencePrice,modelVersion:forecast.modelVersion??'unversioned',parameterVersion:forecast.parameterVersion??'unversioned',analysisVersion,window,forecast:structuredClone(side),regime:structuredClone(forecast.regime),shadowAccepted:forecast.regime?.status==='ready'&&forecast.regime.state==='trend',duplicateGeometry:false};
}

/** Production journal confirmation conditions, followed by an explicit execution model.
 * Publication and confirmation must be known before a bar's opening fill. Only
 * the immediate following opening is attempted; unavailable/out-of-band openings
 * are rejected, never replaced by a convenient later fill. */
export function simulateFrozenForecast(observation:FrozenForecastObservation,data:MarketData,costs:ForecastValidationCosts=DEFAULT_COSTS,endIndex=data.candles.length-1,minute?:MarketData):ForecastValidationOutcome {
  return evaluateFrozenForecast(observation,data,costs,endIndex,createMinuteExitResolver(data,minute));
}
function evaluateFrozenForecast(observation:FrozenForecastObservation,data:MarketData,costs:ForecastValidationCosts,endIndex:number,resolveMinute:ReturnType<typeof createMinuteExitResolver>):ForecastValidationOutcome {
  validateCosts(costs);
  const p=observation.forecast,buy=p.side==='long',sign=buy?1:-1,bars=data.candles;
  if(!geometry(p))throw new Error('Invalid frozen forecast geometry.');
  if(!bars[observation.publicationIndex]||observation.publicationIndex>endIndex||observation.publishedAt<candleAvailableAt(bars[observation.publicationIndex],data.instrument.market,data.interval,data.source))throw new Error('Forecast published before its structural bar was available.');
  const base:ForecastValidationOutcome={id:observation.id,side:p.side,publishedAt:observation.publishedAt,status:'untriggered',shadowAccepted:observation.shadowAccepted,duplicateGeometry:observation.duplicateGeometry,reason:'Condition not confirmed before the window ended.'};
  let previousClose=observation.referencePrice,observed=0,triggerIndex=-1;
  for(let i=observation.publicationIndex+1;i<=endIndex;i++) {
    const b=bars[i];if(!b||b.closed!==true)break;
    if(hasGap(bars[i-1],b,data))return {...base,status:'data-gap',reason:'Unobserved bars prevent attributing a future condition to this forecast.'};
    if(forecastBarStart(b,data)<observation.publishedAt){previousClose=b.close;continue;}
    observed++;
    const stopped=buy?b.low<=p.invalidationPrice:b.high>=p.invalidationPrice;
    const target1=buy?b.high>=p.targets[0].price:b.low<=p.targets[0].price;
    const crossed=buy?previousClose<p.triggerPrice&&b.close>=p.triggerPrice:previousClose>p.triggerPrice&&b.close<=p.triggerPrice;
    const touched=buy?b.low<=p.zoneHigh:b.high>=p.zoneLow;
    const condition=p.triggerRule.startsWith('touch-then')?touched&&(buy?b.close>=p.triggerPrice:b.close<=p.triggerPrice):crossed;
    const inside=b.close>=p.zoneLow&&b.close<=p.zoneHigh;
    if(condition&&(stopped||target1))return {...base,status:'ambiguous-confirmation',reason:'The confirmation bar also touched an invalidation/target; no entry order sequence is assumed.'};
    if(stopped)return {...base,status:'invalidated-before-entry',reason:'Invalidation was touched before an entry condition was confirmed.'};
    if(condition&&!inside||target1)return {...base,status:'missed-condition',reason:'The confirmation closed outside the frozen entry band or a target was reached before entry.'};
    if(condition&&inside){triggerIndex=i;break;}
    if(observed>=12)return {...base,status:'expired',reason:'No condition confirmation within 12 observable bars.'};
    previousClose=b.close;
  }
  if(triggerIndex<0)return base;
  const conditionAt=candleAvailableAt(bars[triggerIndex],data.instrument.market,data.interval,data.source);
  const triggered={...base,conditionAt,conditionIndex:triggerIndex};
  if(data.instrument.market==='cn'&&!buy)return {...triggered,status:'ineligible-short',reason:'A-share short direction is not modeled as an executable ordinary-account trade.'};
  const nextIndex=triggerIndex+1,next=bars[nextIndex];
  if(nextIndex>endIndex||!next||next.closed!==true)return {...triggered,status:'no-next-bar',reason:'No next completed bar within this test window; no entry fill.'};
  if(hasGap(bars[triggerIndex],next,data))return {...triggered,status:'data-gap',reason:'A missing next bar prevents a defensible entry fill.'};
  const entryAt=forecastBarStart(next,data);
  if(entryAt<conditionAt)return {...triggered,status:'unavailable-entry',reason:'The immediate next bar opened before the confirmation was available under the provider delay model.'};
  const slip=costs.slippageBps/10000,fee=costs.feeBps/10000,entry=next.open*(1+sign*slip);
  if(entry<p.zoneLow||entry>p.zoneHigh)return {...triggered,status:'skipped-entry',reason:'The next opening plus adverse slippage is outside the frozen entry zone; no chase or later fill.'};
  const entered:ForecastValidationOutcome={...triggered,status:'open',entryAt,entryIndex:nextIndex,entryPrice:entry,reason:'Unresolved at the window end; excluded from completed outcome statistics.'};
  for(let i=nextIndex;i<=endIndex;i++) {
    const b=bars[i];if(!b||b.closed!==true)break;
    if(i>nextIndex&&hasGap(bars[i-1],b,data))return {...entered,status:'data-gap',reason:'A post-entry data gap leaves the modeled position outcome unknown.'};
    const gapStop=buy?b.open<=p.invalidationPrice:b.open>=p.invalidationPrice;
    const stopped=buy?b.low<=p.invalidationPrice:b.high>=p.invalidationPrice;
    const targeted=buy?b.high>=p.targets[1].price:b.low<=p.targets[1].price;
    if(!stopped&&!targeted)continue;
    if(data.instrument.market==='cn') {
      // Coarse weekly/monthly OHLC cannot resolve whether the exit fell on the
      // purchase day. Never credit a fill that may violate settlement rules.
      if(i===nextIndex&&['1w','1M'].includes(data.interval)||exchangeClock(entryAt,'cn').date===exchangeClock(forecastBarStart(b,data),'cn').date)return {...entered,status:'restricted-exit',reason:'A-share T+1 cannot be established for this exit (same purchase day or coarse entry weekly/monthly bar). No realized return credited.'};
    }
    const opensAtTarget=buy?b.open>=p.targets[1].price:b.open<=p.targets[1].price;
    let exitReason:ForecastValidationOutcome['exitReason']=gapStop?'gap-stop':opensAtTarget||!stopped?'target2':'stop';
    let rawExit=gapStop?b.open:exitReason==='stop'?p.invalidationPrice:p.targets[1].price;
    let exitAt=candleAvailableAt(b,data.instrument.market,data.interval,data.source);
    let intrabarResolution:'minute'|undefined;
    if(stopped&&targeted&&!gapStop&&!opensAtTarget) {
      const evidence=resolveMinute(b,buy,p.invalidationPrice,p.targets[1].price);
      if(evidence.resolution!=='minute')return {...entered,status:'ambiguous-exit',exitIndex:i,exitAt,intrabarResolution:evidence.resolution,reason:'Both exit levels were touched. Their order is unknown; the position ended by this bar close and no return is credited.'};
      exitReason=evidence.reason;rawExit=evidence.price;exitAt=evidence.availableAt;intrabarResolution='minute';
    }
    const exit=rawExit*(1-sign*slip),net=sign*(exit-entry)-(entry+exit)*fee;
    return {...entered,status:'closed',exitAt,exitIndex:i,exitPrice:exit,exitReason,intrabarResolution,netReturnPct:net/entry*100,netR:net/Math.abs(entry-p.invalidationPrice),reason:'One-unit hypothetical event outcome with frozen stop/T2 and costs; not an actual fill or account return.'};
  }
  return entered;
}

/** Resolve simultaneous/overlapping candidates by earliest publication, never
 * by future return. An unresolved/restricted trade occupies the rest of a fold. */
export function enforceSinglePosition(outcomes:readonly ForecastValidationOutcome[]):ForecastValidationOutcome[] {
  const ordered=outcomes.map(o=>({...o})).sort((a,b)=>(a.entryAt??Infinity)-(b.entryAt??Infinity)||a.publishedAt-b.publishedAt||a.id.localeCompare(b.id));
  let busyUntil=-Infinity,owner='';
  for(let i=0;i<ordered.length;i++) {
    const o=ordered[i];if(o.entryAt===undefined)continue;
    if(o.entryAt<busyUntil) {
      const {entryAt:ignoredEntry,entryIndex:ignoredIndex,entryPrice:ignoredPrice,exitAt:ignoredExit,exitIndex:ignoredExitIndex,exitPrice:ignoredExitPrice,exitReason:ignoredReason,intrabarResolution:ignoredMinute,netReturnPct:ignoredReturn,netR:ignoredR,...rest}=o;
      void ignoredEntry;void ignoredIndex;void ignoredPrice;void ignoredExit;void ignoredExitIndex;void ignoredExitPrice;void ignoredReason;void ignoredMinute;void ignoredReturn;void ignoredR;
      ordered[i]={...rest,status:'overlap-rejected',overlapsWith:owner,reason:'Earlier accepted forecast still occupies this instrument; no additional position.'};
    }else{busyUntil=o.exitAt??Infinity;owner=o.id;}
  }
  return ordered.sort((a,b)=>a.publishedAt-b.publishedAt||a.id.localeCompare(b.id));
}
export function summarizeForecastValidation(outcomes:readonly ForecastValidationOutcome[],minimumCompleted=30) {
  const completed=outcomes.filter(o=>o.status==='closed'),returns=completed.map(o=>o.netReturnPct!),risks=completed.map(o=>o.netR!);
  const mean=(values:number[])=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
  const median=(values:number[])=>{if(!values.length)return null;const v=[...values].sort((a,b)=>a-b);return (v[Math.floor((v.length-1)/2)]+v[Math.floor(v.length/2)])/2;};
  return {published:outcomes.length,conditionsMet:outcomes.filter(o=>o.conditionAt!==undefined).length,modeledEntries:outcomes.filter(o=>o.entryPrice!==undefined).length,completed:completed.length,
    outcomesByStatus:Object.fromEntries([...new Set(outcomes.map(o=>o.status))].map(s=>[s,outcomes.filter(o=>o.status===s).length])),
    duplicateGeometry:outcomes.filter(o=>o.duplicateGeometry).length,minuteResolved:completed.filter(o=>o.intrabarResolution==='minute').length,
    ambiguousExits:outcomes.filter(o=>o.status==='ambiguous-exit').length,
    meanNetReturnPct:mean(returns),meanNetR:mean(risks),medianNetR:median(risks),
    sampleStatus:completed.length<minimumCompleted?'insufficient':'unvalidated',minimumCompleted,evidenceSufficient:false};
}

/** Fixed rules and three chronological test blocks after an initial history
 * prefix. No tuning, optimization or random train/test mixing occurs here.
 * Outcomes are censored at each block boundary; no future block rescues a trade. */
export function validateForecast(input:ForecastValidationInput) {
  const costs=input.costs??DEFAULT_COSTS;validateCosts(costs);
  const foldCount=input.folds??3,warmupFraction=input.warmupFraction??.4,minimumCompleted=input.minimumCompleted??30;
  if(!Number.isInteger(foldCount)||foldCount<2||foldCount>10||!Number.isFinite(warmupFraction)||warmupFraction<.25||warmupFraction>.75||!Number.isInteger(minimumCompleted)||minimumCompleted<30)throw new Error('Use 2–10 fixed folds, 25–75% warmup and at least 30 completed observations per sample check.');
  const candles=validationClosedBars(input.primary),primary={...input.primary,candles},warmup=Math.max(60,Math.floor(candles.length*warmupFraction));
  const resolveMinute=createMinuteExitResolver(primary,input.minute);
  const enough=candles.length-warmup>=foldCount*10;
  const windows:ReturnType<typeof runWindow>[]=[],baseline:ForecastValidationOutcome[]=[],shadow:ForecastValidationOutcome[]=[];
  function runWindow(number:number,start:number,end:number) {
    const observations:FrozenForecastObservation[]=[],seen=new Set<string>(),geometrySeen=new Set<string>();
    const coverage={snapshots:0,directional:0,neutral:0,unavailable:0,higherStatuses:{} as Record<string,number>,regimes:{} as Record<string,number>};
    for(let index=start;index<=end;index++) {
      const prefix=candles.slice(0,index+1),asOf=candleAvailableAt(candles[index],primary.instrument.market,primary.interval,primary.source),snapshot={...primary,candles:prefix,asOf:new Date(asOf*1000).toISOString()};
      const expected=higherInterval(primary.instrument.market,primary.interval);
      const supplied=input.higher&&input.higher.interval===expected&&compatibleMarketFeeds(primary,input.higher)?input.higher:undefined;
      const higher=supplied??deriveHigherFromPrimary(snapshot);
      const context={market:primary.instrument.market,symbol:primary.instrument.symbol,interval:primary.interval,source:primary.source,adjustment:primary.adjustment};
      const analysis=analyze(prefix,{penMode:input.penMode??'new',skipCalibration:true,skipTradePlans:true,context:{...context,higher:higher?{interval:higher.interval,status:'ready',data:higher}:{interval:expected,status:expected?'error':'none'}}});
      const forecast=buildForecast(prefix,analysis,{...context,asOf});
      coverage.snapshots++;
      const state=analysis.confluence?.higher.status??'insufficient';coverage.higherStatuses[state]=(coverage.higherStatuses[state]??0)+1;
      const regime=forecast.regime?.status==='ready'?forecast.regime.state:'insufficient';coverage.regimes[regime]=(coverage.regimes[regime]??0)+1;
      if(forecast.status!=='ready')coverage.unavailable++;else if(forecast.direction==='neutral')coverage.neutral++;else coverage.directional++;
      const observation=freezeValidationForecast(forecast,index,number,analysis.ruleVersion);
      if(!observation||seen.has(observation.id))continue;
      seen.add(observation.id);
      const p=observation.forecast,key=JSON.stringify([p.side,p.kind,p.triggerRule,p.zoneLow,p.zoneHigh,p.triggerPrice,p.invalidationPrice,p.targets.map(t=>t.price)]);
      observation.duplicateGeometry=geometrySeen.has(key);geometrySeen.add(key);observations.push(observation);
    }
    const candidates=observations.map(o=>evaluateFrozenForecast(o,primary,costs,end,resolveMinute));
    const minuteReviewTimes=[...new Set(candidates.filter(o=>o.intrabarResolution&&o.exitIndex!==undefined).map(o=>candles[o.exitIndex!].time))].sort((a,b)=>a-b);
    const base=enforceSinglePosition(candidates),filtered=enforceSinglePosition(candidates.filter(o=>o.shadowAccepted));
    return {number,startIndex:start,endIndex:end,startTime:candles[start].time,endTime:candles[end].time,coverage,minuteReviewTimes,
      baseline:summarizeForecastValidation(base,minimumCompleted),shadow:summarizeForecastValidation(filtered,minimumCompleted),
      independentCandidates:summarizeForecastValidation(candidates,minimumCompleted),observations,baselineOutcomes:base,shadowOutcomes:filtered};
  }
  if(enough)for(let fold=0;fold<foldCount;fold++) {
    const start=warmup+Math.floor((candles.length-warmup)*fold/foldCount),end=warmup+Math.floor((candles.length-warmup)*(fold+1)/foldCount)-1;
    const result=runWindow(fold+1,start,end);windows.push(result);baseline.push(...result.baselineOutcomes);shadow.push(...result.shadowOutcomes);
  }
  return {schemaVersion:1,validationVersion:FORECAST_VALIDATION_VERSION,label:input.label??`${primary.instrument.market}:${primary.instrument.symbol}:${primary.interval}`,
    data:{market:primary.instrument.market,symbol:primary.instrument.symbol,interval:primary.interval,source:primary.source,adjustment:primary.adjustment,capturedAt:primary.asOf,totalBars:input.primary.candles.length,closedBars:candles.length,firstTime:candles[0]?.time??null,lastTime:candles.at(-1)?.time??null},
    method:{model:'current buildForecast; legacy tradePlans disabled',folds:foldCount,warmupFraction,warmupBars:warmup,penMode:input.penMode??'new',costs,minimumCompleted,positionPolicy:'one open position per instrument per fold; earliest publication wins',shadowRule:'regime.status=ready AND regime.state=trend; research only',confirmationExpiryBars:12,exit:'frozen stop or target2; no partial target1 exit',boundaryProcessingDelaySeconds:0},
    modelVersions:[...new Set(windows.flatMap(w=>w.observations.map(o=>o.modelVersion)))],parameterVersions:[...new Set(windows.flatMap(w=>w.observations.map(o=>o.parameterVersion)))],analysisVersions:[...new Set(windows.flatMap(w=>w.observations.map(o=>o.analysisVersion)))],
    status:!enough?'insufficient-history':'unvalidated',evidenceSufficient:false,activationRecommendation:'Do not activate the regime filter from these reports.',
    baseline:summarizeForecastValidation(baseline,minimumCompleted),shadow:summarizeForecastValidation(shadow,minimumCompleted),windows,
    limitations:[
      'Fixed-rule chronological blocks are not a prospectively preregistered unseen dataset; these saved samples may have been inspected during earlier development. No parameter tuning is performed here.',
      'Each window starts flat; unresolved positions are censored at its end. Aggregated event means are not compounded portfolio returns or maximum drawdown.',
      'Default fees and slippage are assumptions, not venue/account fee schedules. Borrow availability/cost, funding, taxes, lot sizes, liquidity, price limits, partial fills and order rejection are not simulated.',
      'A-share short entries are excluded. Same-day long exits and exits within weekly/monthly bars whose settlement order is unknown receive no realized-return credit.',
      'Confirmed candles are available only at the production conservative timestamp. A next open before that time is rejected. Equality assumes zero processing/network latency; real execution can be worse.',
      'Historical OHLC revisions, source outages, individual halts and corporate-action point-in-time availability are not independently verified. No synthetic missing candles are added.',
      'Post-entry bars touching both stop and target use their opening if conclusive, otherwise complete matching-source one-minute OHLC to establish order. Unresolved cases are counted separately and excluded from return statistics. Targets receive no favorable gap improvement.',
      'Only closed-bar publications are replayed. The live app can refresh from intrabar quotes; archived OHLC alone cannot reproduce those unseen publication snapshots.',
      'Regime filtering is a shadow comparison, not an enabled production rule or a demonstrated improvement. Small/missing evidence is reported instead of a win-probability claim.',
    ]};
}
