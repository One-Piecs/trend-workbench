import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticDaily } from './synthetic-daily.ts';
import {analyze} from '../lib/chan.ts';
import {buildForecast} from '../lib/forecast.ts';
import {advanceForecastJournal,emptyJournal,recordForecast} from '../lib/forecast-journal.ts';
import {candleAvailableAt} from '../lib/timeframe-context.ts';
import {enforceSinglePosition,freezeValidationForecast,simulateFrozenForecast,summarizeForecastValidation,validateForecast,validationClosedBars,type FrozenForecastObservation,type ForecastValidationOutcome} from '../lib/forecast-validation.ts';
import type {Candle,MarketData} from '../lib/market-types';
import type {ReadyForecastSide} from '../lib/forecast-types';

const start=Date.UTC(2025,0,1)/1000;
const bar=(i:number,open:number,high:number,low:number,close:number):Candle=>({time:start+i*3600,open,high,low,close,volume:100,closed:true});
const context={market:'crypto' as const,symbol:'BTCUSDT',interval:'1h' as const,source:'Binance',adjustment:'不复权'};
const data=(candles:Candle[]):MarketData=>({instrument:{id:'crypto:BTCUSDT',symbol:'BTCUSDT',market:'crypto',exchange:'Binance',name:'Bitcoin',currency:'USDT'},interval:'1h',source:'Binance',adjustment:'不复权',asOf:new Date((candles.at(-1)!.time+3600)*1000).toISOString(),candles,delayNotice:'fixture',warnings:[],availableIntervals:['1h']});
const side=(buy=true):ReadyForecastSide=>({status:'ready',id:'frozen',side:buy?'long':'short',kind:buy?'breakout':'breakdown',triggerRule:buy?'close-above':'close-below',basis:['confirmed-fractal'],zoneLow:100,zoneHigh:102,triggerPrice:buy?100.5:101.5,invalidationPrice:buy?90:112,targets:[{price:buy?110:92,source:'atr-reference',estimated:true,time:null,index:null,confirmedAt:null},{price:buy?120:82,source:'atr-reference',estimated:true,time:null,index:null,confirmedAt:null}],anchor:{price:101,source:'confirmed-fractal',estimated:false,time:start,index:0,confirmedAt:0}});
const observation=(buy=true):FrozenForecastObservation=>({id:'sample',publishedAt:start+3600,publicationIndex:0,referencePrice:buy?99:103,modelVersion:'fixture',parameterVersion:'fixture',analysisVersion:'fixture',window:1,forecast:side(buy),regime:undefined,shadowAccepted:true,duplicateGeometry:false});
const normal=()=>[bar(0,99,100,98,99),bar(1,99,103,98,101),bar(2,101,105,100,103),bar(3,103,122,102,119)];

test('current forecast validation charges both sides and enters only after confirmation',()=>{
  const out=simulateFrozenForecast(observation(),data(normal()),{feeBps:10,slippageBps:10});
  assert.equal(out.status,'closed');assert.equal(out.entryIndex,2);assert.equal(out.exitReason,'target2');
  const entry=101*1.001,exit=120*.999,net=exit-entry-(entry+exit)*.001;
  assert.ok(Math.abs(out.netReturnPct!-net/entry*100)<1e-10);assert.ok(Math.abs(out.netR!-net/(entry-90))<1e-10);
});
test('a gapped opening outside the band is skipped and never filled at a later favorable price',()=>{
  const rows=normal();rows[2]=bar(2,106,107,100,101);rows[3]=bar(3,101,122,100,119);
  const out=simulateFrozenForecast(observation(),data(rows));assert.equal(out.status,'skipped-entry');assert.equal(out.entryPrice,undefined);assert.equal(out.netR,undefined);
});
test('an adverse overnight gap exits at the worse opening, not the stale stop price',()=>{
  const rows=normal();rows[3]=bar(3,80,85,78,82);
  const out=simulateFrozenForecast(observation(),data(rows),{feeBps:0,slippageBps:0});
  assert.equal(out.exitReason,'gap-stop');assert.equal(out.exitPrice,80);assert.equal(out.netR,(80-101)/11);
});
test('same-bar post-entry stop and target is counted as stop-first',()=>{
  const rows=normal();rows[2]=bar(2,101,125,85,110);
  const out=simulateFrozenForecast(observation(),data(rows),{feeBps:0,slippageBps:0});
  assert.equal(out.exitReason,'ambiguous-stop-first');assert.equal(out.exitPrice,90);assert.equal(out.netR,-1);
});
test('confirmation plus a target/stop in the same bar is ambiguous before any entry',()=>{
  for(const row of [bar(1,99,111,98,101),bar(1,99,103,89,101)]) {
    const rows=normal();rows[1]=row;const out=simulateFrozenForecast(observation(),data(rows));
    assert.equal(out.status,'ambiguous-confirmation');assert.equal(out.entryPrice,undefined);
  }
});
test('short modeled cash flows apply adverse entry and exit slippage in the proper directions',()=>{
  const rows=[bar(0,103,104,102,103),bar(1,103,104,100,101),bar(2,101,104,99,100),bar(3,100,101,80,81)];
  const out=simulateFrozenForecast(observation(false),data(rows),{feeBps:10,slippageBps:10});
  const entry=101*.999,exit=82*1.001,net=entry-exit-(entry+exit)*.001;
  assert.equal(out.status,'closed');assert.ok(Math.abs(out.netR!-net/(112-entry))<1e-10);
});
test('window boundaries separate no-next-bar, unresolved positions and completed outcomes',()=>{
  const d=data(normal());assert.equal(simulateFrozenForecast(observation(),d,undefined,1).status,'no-next-bar');
  const unresolved=simulateFrozenForecast(observation(),d,undefined,2);assert.equal(unresolved.status,'open');
  const stats=summarizeForecastValidation([unresolved]);assert.equal(stats.completed,0);assert.equal(stats.meanNetR,null);assert.equal(stats.sampleStatus,'insufficient');
});
test('publication cannot reuse an earlier high/low from an already-forming candle',()=>{
  const obs={...observation(),publishedAt:start+3601},rows=normal();rows[2]=bar(2,103,105,102,103);rows[3]=bar(3,103,104,102,103);
  const out=simulateFrozenForecast(obs,data(rows));assert.equal(out.status,'untriggered');assert.equal(out.conditionAt,undefined);
});
test('missing primary candles do not silently manufacture a condition or fill',()=>{
  const rows=normal();rows.splice(1,1);assert.equal(simulateFrozenForecast(observation(),data(rows)).status,'data-gap');
});
test('provider publication delay disqualifies an immediate opening that already passed',()=>{
  const rows=normal().map((b,i)=>({...b,time:Date.UTC(2025,0,2,14,30)/1000+i*3600}));
  const d={...data(rows),instrument:{...data(rows).instrument,market:'us' as const},source:'Yahoo Finance'};
  const obs={...observation(),publishedAt:candleAvailableAt(rows[0],'us','1h','Yahoo Finance')};
  // Publication at 10:45 excludes the 10:30–11:30 bar; 11:30 bar confirms at12:45,
  // after the immediate 12:30 opening, so a retrospective fill is unavailable.
  rows[1]={...rows[1],open:99,high:100,low:98,close:99};rows[2]={...rows[2],open:99,high:103,low:98,close:101};rows[3]={...rows[3],open:101,high:105,low:100,close:103};
  assert.equal(simulateFrozenForecast(obs,d).status,'unavailable-entry');
});
test('A-share short direction never enters executable result statistics',()=>{
  const rows=[bar(0,103,104,102,103),bar(1,103,104,100,101),bar(2,101,104,99,100)].map((b,i)=>({...b,time:Date.UTC(2025,0,2+i,1,30)/1000}));
  const d={...data(rows),instrument:{...data(rows).instrument,market:'cn' as const},interval:'1d' as const,source:'东方财富'};
  const obs={...observation(false),publishedAt:candleAvailableAt(rows[0],'cn','1d')};
  assert.equal(simulateFrozenForecast(obs,d).status,'ineligible-short');
});
test('A-share same-day exits are restricted, not credited as a profitable fill',()=>{
  const rows=normal().map((b,i)=>({...b,time:Date.UTC(2025,0,2+i,1,30)/1000}));rows[2]={...rows[2],high:122,close:119};
  const d={...data(rows),instrument:{...data(rows).instrument,market:'cn' as const},interval:'1d' as const,source:'东方财富'};
  const out=simulateFrozenForecast({...observation(),publishedAt:candleAvailableAt(rows[0],'cn','1d')},d);
  assert.equal(out.status,'restricted-exit');assert.ok(out.entryPrice);assert.equal(out.netReturnPct,undefined);
});
test('A-share next-session exit may be modeled while retaining market restriction caveats',()=>{
  const rows=normal().map((b,i)=>({...b,time:Date.UTC(2025,0,2+i,1,30)/1000}));
  const d={...data(rows),instrument:{...data(rows).instrument,market:'cn' as const},interval:'1d' as const,source:'东方财富'};
  const out=simulateFrozenForecast({...observation(),publishedAt:candleAvailableAt(rows[0],'cn','1d')},d);
  assert.equal(out.status,'closed');assert.equal(out.exitReason,'target2');
});
test('single-position selection rejects overlap by publication order, regardless of future returns',()=>{
  const first:ForecastValidationOutcome={id:'first',side:'long',publishedAt:1,status:'closed',entryAt:3,entryPrice:100,exitAt:8,netReturnPct:-10,netR:-1,shadowAccepted:true,duplicateGeometry:false,reason:'fixture'};
  const better={...first,id:'better',publishedAt:2,netReturnPct:100,netR:10};
  const after={...first,id:'after',publishedAt:8,entryAt:8,exitAt:9};
  const results=enforceSinglePosition([better,after,first]);
  assert.equal(results.find(r=>r.id==='first')?.status,'closed');assert.equal(results.find(r=>r.id==='better')?.status,'overlap-rejected');assert.equal(results.find(r=>r.id==='better')?.netR,undefined);assert.equal(results.find(r=>r.id==='after')?.status,'closed');
});
test('unresolved/restricted positions block later entries through the window end',()=>{
  const first:ForecastValidationOutcome={id:'first',side:'long',publishedAt:1,status:'restricted-exit',entryAt:3,entryPrice:100,shadowAccepted:false,duplicateGeometry:false,reason:'fixture'};
  const next={...first,id:'next',publishedAt:5,entryAt:6,status:'closed' as const,exitAt:7,netR:2};
  assert.equal(enforceSinglePosition([first,next])[1].status,'overlap-rejected');
  assert.equal(enforceSinglePosition([next])[0].status,'closed'); // Shadow has its own position history.
});
test('saved closed flags never expose candles unavailable at their capture timestamp',()=>{
  const d=data(normal());d.asOf=new Date((d.candles[2].time+1)*1000).toISOString();
  assert.equal(validationClosedBars(d).length,2);
  assert.throws(()=>validationClosedBars({...d,candles:[d.candles[0],d.candles[0]]}),/unordered/);
  assert.throws(()=>validationClosedBars({...d,candles:[{...d.candles[0],closed:false},d.candles[1]]}),/precedes/);
});

const history = syntheticDaily(200);
const sample:MarketData={...data(history), interval:'1d',availableIntervals:['1d'],
  asOf:new Date((history.at(-1)!.time+86400)*1000).toISOString()};
test('fixed three-block validation calls current forecasts, freezes snapshots and keeps outcomes within each block',()=>{
  const report=validateForecast({primary:sample});assert.equal(report.windows.length,3);assert.equal(report.method.model,'current buildForecast; legacy tradePlans disabled');
  assert.ok(report.windows.some(w=>w.observations.length));assert.equal(report.evidenceSufficient,false);
  for(const w of report.windows)for(const o of w.observations) {
    assert.ok(o.publicationIndex>=w.startIndex&&o.publicationIndex<=w.endIndex);
    const rows=sample.candles.slice(0,o.publicationIndex+1),asOf=candleAvailableAt(rows.at(-1)!,'crypto','1d');
    assert.equal(o.publishedAt,asOf);
    assert.ok(o.modelVersion.startsWith('forecast-'));
    assert.equal(o.shadowAccepted,o.regime?.status==='ready'&&o.regime.state==='trend');
  }
  for(const w of report.windows)for(const o of w.baselineOutcomes)assert.ok(o.exitIndex===undefined||o.exitIndex<=w.endIndex);
});
test('future higher-timeframe rows cannot change previously published forecast snapshots',()=>{
  const higher:MarketData={...sample,interval:'1w',candles:[{...sample.candles.at(-1)!,time:sample.candles.at(-1)!.time+86400*100,high:999999,volume:999999}],asOf:new Date((sample.candles.at(-1)!.time+86400*200)*1000).toISOString()};
  const a=validateForecast({primary:sample,higher}),b=validateForecast({primary:sample,higher:{...higher,candles:[]}});
  assert.deepEqual(a.windows.flatMap(w=>w.observations),b.windows.flatMap(w=>w.observations));
});
test('later test blocks cannot change the forecasts or outcomes in an earlier block',()=>{
  const a=validateForecast({primary:sample}),end=a.windows[0].endIndex;
  const mutated={...sample,candles:sample.candles.map((b,i)=>i<=end?b:{...b,open:b.open*9,high:b.high*9,low:b.low*9,close:b.close*9})};
  const b=validateForecast({primary:mutated});assert.deepEqual(a.windows[0],b.windows[0]);
});
test('frozen published conditions agree with the production observation journal',()=>{
  const rows=sample.candles.slice(0,130),a=analyze(rows,{skipTradePlans:true,skipCalibration:true,context:{...context,interval:'1d'}});
  // Test the production confirmation state machine with a deliberately simple
  // published condition; the source candle sequence controls the expected time.
  const d=data(normal()),f=buildForecast(rows,a,{...context,interval:'1d',asOf:start+3600});
  const published={...f,status:'ready' as const,mode:'structure' as const,direction:'long' as const,context,asOf:start+3600,structureAsOf:start+3600,referencePrice:99,referenceTime:start,lastClosedTime:start,long:side()};
  const frozen=freezeValidationForecast(published,0,1,a.ruleVersion)!;
  const journal=recordForecast(emptyJournal(),{...d,candles:[d.candles[0]]},published,start+3600);
  const next=advanceForecastJournal(journal,{...d,candles:d.candles.slice(0,2)},start+7200);
  const modeled=simulateFrozenForecast(frozen,d);
  assert.equal(next.journal.records[0].status,'condition-met');assert.equal(modeled.conditionAt,next.journal.records[0].events[0].at);
  published.long.zoneHigh=1000;assert.equal(frozen.forecast.zoneHigh,102);
});
test('short histories and small completed counts remain explicitly unvalidated',()=>{
  assert.equal(validateForecast({primary:{...sample,candles:sample.candles.slice(0,70)}}).status,'insufficient-history');
  assert.throws(()=>validateForecast({primary:sample,minimumCompleted:2}),/at least 30/);
  assert.throws(()=>simulateFrozenForecast(observation(),data(normal()),{feeBps:-1,slippageBps:0}),/Costs/);
});
