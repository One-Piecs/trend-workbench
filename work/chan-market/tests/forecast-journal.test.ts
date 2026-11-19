import test from 'node:test';
import assert from 'node:assert/strict';
import type {Candle,MarketData} from '../lib/market-types.ts';
import type {MarketForecast,ReadyForecastSide} from '../lib/forecast-types.ts';
import {advanceForecastJournal,currentRiskTouches,emptyJournal,forecastStats,readForecastJournal,recordForecast,writeForecastJournal,JOURNAL_KEY} from '../lib/forecast-journal.ts';
import {selectForecastNotices} from '../lib/forecast-alerts.ts';
import {captureForecastAudit,forecastCohort,forecastInputFingerprint,validForecastAudit} from '../lib/forecast-audit.ts';
import {evaluateMarketRegime} from '../lib/market-regime.ts';
const t=1700000000;
const candle=(time:number,close:number,low=close-1,high=close+1,closed=true):Candle=>({time,open:close,high,low,close,volume:100,closed});
const initial=candle(t,100,99,101);
const data=(candles:Candle[]):MarketData=>({instrument:{id:'crypto:X',symbol:'X',name:'X',market:'crypto',exchange:'Test',currency:'USD'},interval:'1h',candles,source:'Binance',asOf:new Date((t+3600)*1000).toISOString(),delayNotice:'',adjustment:'raw',warnings:[],availableIntervals:['1h']});
const level=(price:number)=>({price,source:'confirmed-fractal' as const,estimated:false,time:t,index:0,confirmedAt:0});
const side:ReadyForecastSide={id:'test-long',side:'long',kind:'breakout',status:'ready',zoneLow:102,zoneHigh:103,triggerPrice:102,invalidationPrice:95,targets:[level(110),level(120)],anchor:level(102),basis:['confirmed-fractal'],triggerRule:'close-above'};
function forecast():MarketForecast {return {status:'ready',mode:'structure',context:{market:'crypto',symbol:'X',interval:'1h',source:'Binance',adjustment:'raw'},referencePrice:100,referenceTime:t,referenceClosed:true,lastClosedPrice:100,lastClosedTime:t,structureAsOf:t+3600,asOf:t+3600,atr:3,buffer:3,direction:'long',reasonCodes:['bias-long'],noticeCodes:[],support:level(95),resistance:level(102),long:structuredClone(side),short:{status:'insufficient',id:null,side:'short',kind:'breakdown',zoneLow:null,zoneHigh:null,triggerPrice:null,invalidationPrice:null,targets:null,anchor:null,basis:[],triggerRule:'close-below'}};}
const start=()=>recordForecast(emptyJournal(),data([initial]),forecast(),t+3600);

test('audit retains immutable model, indicator and input snapshots at publication',()=>{
  const d=data([initial]);
  const f={...forecast(),modelVersion:'forecast-2.0',parameterVersion:'chan-atr14-v1',analysisVersion:'chan-experimental-1.5',
    regime:evaluateMarketRegime(d.candles),timeframeAssessment:{status:'countertrend' as const,currentDirection:'long' as const,higherDirection:'short' as const,higherInterval:'4h' as const,asOf:t+3600,higherAsOf:t,reason:'ready' as const}};
  const record=recordForecast(emptyJournal(),d,f,t+3600).records[0];
  const before=structuredClone(record.audit);
  f.regime.state='volatile';f.timeframeAssessment.higherDirection='long' as 'short';d.candles=[{...initial,volume:1234}];
  assert.deepEqual(record.audit,before);
  assert.ok(validForecastAudit(record.audit));
  assert.equal(record.audit?.input.count,1);
  assert.notEqual(record.audit?.input.fingerprint,forecastInputFingerprint(d));
});

test('same structure and direction are recorded separately across model and engine versions',()=>{
  const d=data([initial]),f={...forecast(),modelVersion:'forecast-2.0',parameterVersion:'chan-atr14-v1',analysisVersion:'chan-experimental-1.5'};
  const first=recordForecast(emptyJournal(),d,f,t+3600);
  assert.equal(recordForecast(first,d,f,t+3700).records.length,1);
  const next=recordForecast(first,d,{...f,modelVersion:'forecast-2.1'},t+3700);
  const engine=recordForecast(next,d,{...f,analysisVersion:'chan-experimental-1.6'},t+3800);
  assert.equal(engine.records.length,3);
  assert.equal(new Set(engine.records.map(forecastCohort)).size,3);
  assert.equal(forecastCohort({}),'legacy-unversioned');
});

test('input checksum detects OHLCV corrections and completion flag changes',()=>{
  const original=data([initial]),fingerprint=forecastInputFingerprint(original);
  assert.equal(forecastInputFingerprint(structuredClone(original)),fingerprint);
  for(const patch of [{close:100.5},{volume:101},{closed:false},{time:t+1}])
    assert.notEqual(forecastInputFingerprint(data([{...initial,...patch}])),fingerprint);
});

test('versioned audit survives storage; legacy records remain readable',()=>{
  const d=data([initial]),j=recordForecast(emptyJournal(),d,{...forecast(),modelVersion:'forecast-2.0'},t+3600);
  const legacy=structuredClone(j.records[0]);delete legacy.audit;legacy.id='old-id';
  const combined={...j,records:[legacy,...j.records]};
  let stored='';const storage={getItem:()=>stored,setItem:(_key:string,value:string)=>{stored=value;}};
  assert.equal(writeForecastJournal(combined,storage),true);
  assert.deepEqual(readForecastJournal(storage),combined);
  assert.equal(forecastCohort(readForecastJournal(storage).records[0]),'legacy-unversioned');
});

test('malformed audit is rejected without accepting fabricated indicator metadata',()=>{
  const audit=captureForecastAudit(data([initial]),forecast());
  assert.equal(validForecastAudit({...audit,input:{...audit.input,fingerprint:'bad'}}),false);
  assert.equal(validForecastAudit({...audit,regime:{...evaluateMarketRegime([initial]),adx:101}}),false);
  assert.equal(validForecastAudit({...audit,timeframes:{status:'countertrend'}}),false);
  assert.equal(validForecastAudit({...audit,modelVersion:''}),false);
});

test('a current model never sends an old-version observation as its own new alert',()=>{
  const bars=[initial,candle(t+3600,102.5,101,103)],j=advanceForecastJournal(start(),data(bars),t+7200).journal;
  const live=data([...bars,candle(t+7200,94,93,101,false)]),options={now:t+7300,startedAt:t+7100,previousPrice:100,allowSignals:true,seen:new Set<string>()};
  const current={...forecast(),modelVersion:'forecast-2.0',parameterVersion:'chan-atr14-v1',analysisVersion:'chan-experimental-1.5'};
  assert.equal(selectForecastNotices(j,live,current,j.records[0].events,options).length,0);
  const matching={...j,records:j.records.map(r=>({...r,audit:captureForecastAudit(data([initial]),current)}))};
  assert.equal(selectForecastNotices(matching,live,current,[],options).length,1);
});
test('alerts establish a baseline and remain quiet for neutral, opposite or stale outlooks',()=>{
  const bars=[initial,candle(t+3600,102.5,101,103)],j=advanceForecastJournal(start(),data(bars),t+7200).journal;
  const live=data([...bars,candle(t+7200,94,93,101,false)]),options={now:t+7300,startedAt:t+7100,previousPrice:100,allowSignals:true,seen:new Set<string>()};
  assert.equal(selectForecastNotices(j,live,forecast(),[],{...options,previousPrice:undefined}).length,0);
  assert.equal(selectForecastNotices(j,live,{...forecast(),direction:'neutral'},[],options).length,0);
  assert.equal(selectForecastNotices(j,live,{...forecast(),direction:'short'},[],options).length,0);
  assert.equal(selectForecastNotices(j,live,forecast(),[],{...options,allowSignals:false}).length,0);
});
test('a risk touch requires a newly observed crossing and is announced once per level',()=>{
  const bars=[initial,candle(t+3600,102.5,101,103)],j=advanceForecastJournal(start(),data(bars),t+7200).journal;
  const live=data([...bars,candle(t+7200,94,93,101,false)]),options={now:t+7300,startedAt:t+7100,previousPrice:100,allowSignals:true,seen:new Set<string>()};
  assert.equal(selectForecastNotices(j,live,forecast(),[],{...options,previousPrice:94}).length,0);
  assert.equal(selectForecastNotices(j,live,forecast(),[],options).length,1);
  assert.equal(selectForecastNotices(j,live,forecast(),[],options).length,0);
});
test('multiple older confirmed observations do not flood the current risk alert',()=>{
  const bars=[initial,candle(t+3600,102.5,101,103)],j=advanceForecastJournal(start(),data(bars),t+7200).journal;
  const many={...j,records:Array.from({length:20},(_,i)=>({...structuredClone(j.records[0]),id:`record-${i}`}))};
  const live=data([...bars,candle(t+7200,94,93,101,false)]),options={now:t+7300,startedAt:t+7100,previousPrice:100,allowSignals:true,seen:new Set<string>()};
  assert.equal(selectForecastNotices(many,live,forecast(),[],options).length,1);
});
test('publication snapshots are immutable, one per structure bar and side',()=>{
  const f=forecast(),j=recordForecast(emptyJournal(),data([initial]),f,t+3600);if(f.long.status==='ready')f.long.zoneHigh=999;
  assert.equal(j.records[0].outlook.zoneHigh,103);
  assert.equal(recordForecast(j,data([initial]),forecast(),t+3700).records.length,1);
  const neutral={...forecast(),direction:'neutral' as const};assert.equal(recordForecast(emptyJournal(),data([initial]),neutral,t).records.length,0);
});
test('creation-bar extremes and forming bars cannot retroactively satisfy a condition',()=>{
  const j=start();const r=advanceForecastJournal(j,data([{...initial,high:125,low:90,close:102.5},candle(t+3600,102.5,102,103,false)]),t+7200);
  assert.equal(r.events.length,0);assert.equal(r.journal.records[0].status,'watching');assert.equal(j.records[0].events.length,0);
});
test('sequential future closes confirm once, targets preserve original levels',()=>{
  const bars=[initial,candle(t+3600,102.5,101,103)],confirmed=advanceForecastJournal(start(),data(bars),t+7200);
  assert.equal(confirmed.events[0].type,'condition-met');
  assert.equal(advanceForecastJournal(confirmed.journal,data(bars),t+7201).events.length,0);
  const result=advanceForecastJournal(confirmed.journal,data([...bars,candle(t+7200,119,115,121)]),t+10800);
  assert.equal(result.journal.records[0].status,'target2');assert.equal(result.journal.records[0].outlook.triggerPrice,102);
});
test('intrabar quote touches warn without changing closed-bar record state',()=>{
  const bars=[initial,candle(t+3600,102.5,101,103)],j=advanceForecastJournal(start(),data(bars),t+7200).journal;
  const risks=currentRiskTouches(j,data([...bars,candle(t+7200,94,93,101,false)]),t+7300);
  assert.equal(risks[0].type,'invalidation');assert.equal(j.records[0].status,'condition-met');
  assert.equal(currentRiskTouches(j,data([...bars,candle(t+7200,100,93,105,false)]),t+7300).length,0,'past intrabar low is not a current quote touch');
});
test('ambiguous same-bar stop/target is excluded from net outcome statistics',()=>{
  const bars=[initial,candle(t+3600,102.5,101,103)],j=advanceForecastJournal(start(),data(bars),t+7200).journal;
  const result=advanceForecastJournal(j,data([...bars,candle(t+7200,100,94,121)]),t+10800).journal;
  assert.equal(result.records[0].status,'ambiguous');assert.equal(forecastStats(result.records).resolved,0);
});
test('missed gap entry never counts as a confirmed observation',()=>{
  const result=advanceForecastJournal(start(),data([initial,candle(t+3600,105,104,106)]),t+7200).journal;
  assert.equal(result.records[0].status,'missed');assert.equal(forecastStats(result.records).confirmed,0);
});
test('provider and adjustment changes cannot update previous-source records',()=>{
  const changed={...data([initial,candle(t+3600,102.5,101,103)]),adjustment:'adjusted'};
  const result=advanceForecastJournal(start(),changed,t+7200);assert.equal(result.events.length,0);assert.equal(result.journal.records[0].status,'watching');
});
test('rolling-window gaps stop evaluation rather than inventing the path',()=>{
  const result=advanceForecastJournal(start(),data([candle(t+72000,110)]),t+75600);
  assert.equal(result.events[0].type,'data-gap');assert.equal(forecastStats(result.journal.records).resolved,0);
});
test('costs apply adverse slippage and fees on both legs',()=>{
  const bars=[initial,candle(t+3600,102.5,101,103),candle(t+7200,119,115,121)],result=advanceForecastJournal(start(),data(bars),t+10800).journal;
  const gross=forecastStats(result.records,0,0),net=forecastStats(result.records,5,3);
  assert.equal(net.resolved,1);assert.ok(net.netMeanPct!<gross.netMeanPct!);assert.equal(gross.netMeanPct,(120-103)/103*100);
});
test('storage round trips validated observations and rejects malformed data',()=>{
  const values=new Map<string,string>(),storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
  assert.equal(writeForecastJournal(start(),storage),true);assert.deepEqual(readForecastJournal(storage),start());
  values.set(JOURNAL_KEY,JSON.stringify({version:1,records:[{status:'condition-met'}]}));assert.equal(readForecastJournal(storage).records.length,0);
});

test('a damaged or mislabeled local row cannot erase or advance another instrument’s records',()=>{
  const original=start(),good=original.records[0];
  const raw=JSON.stringify({...original,records:[{id:'broken'},good,{...good,id:'wrong',symbol:'OTHER'}]});
  const restored=readForecastJournal({getItem:()=>raw,setItem:()=>{}});
  assert.deepEqual(restored,original);
});

test('a feed containing only an unfinished or not-yet-available row cannot report a history gap',()=>{
  for(const closed of [false,true]){
    const pending=data([candle(t+36000,100,99,101,closed)]);
    const result=advanceForecastJournal(start(),pending,t+36001);
    assert.equal(result.journal.records[0].status,'watching');
    assert.deepEqual(result.events,[]);
  }
});

test('a bar already in progress when the snapshot was published cannot supply pre-publication extremes',()=>{
  const published=t+5400;
  const j=recordForecast(emptyJournal(),data([initial]),forecast(),published);
  const beganBeforePublication=candle(t+3600,102.5,101,103);
  const r=advanceForecastJournal(j,data([initial,beganBeforePublication]),t+7200);
  assert.equal(r.events.length,0,'the t+3600 bar began 30 minutes before publication');
  assert.equal(r.journal.records[0].status,'watching');
  assert.equal(forecastStats(r.journal.records).confirmed,0);
});

test('end-labelled stock bars whose start predates publication also cannot confirm a snapshot',()=>{
  const base=Date.parse('2026-01-07T02:00:00Z')/1000;
  const source={...data([candle(base,100,99,101)]),instrument:{...data([]).instrument,id:'cn:603993.SH',symbol:'603993.SH',market:'cn' as const},interval:'1m' as const,source:'东方财富'};
  const f={...forecast(),context:{market:'cn' as const,symbol:'603993.SH',interval:'1m' as const,source:'东方财富',adjustment:'raw'},referencePrice:100,referenceTime:base,lastClosedTime:base,lastClosedPrice:100,structureAsOf:base+120,asOf:base+150};
  const j=recordForecast(emptyJournal(),source,f,base+150);
  const endBeforePublication=candle(base+180,102.5,101,103);
  const r=advanceForecastJournal(j,{...source,candles:[...source.candles,candle(base+60,100,99,101),candle(base+120,100,99,101),endBeforePublication]},base+360);
  assert.equal(r.events.length,0,'the bar ending at 10:03 began at 10:02, before the 10:02:30 snapshot');
  assert.equal(forecastStats(r.journal.records).confirmed,0);
});

test('a missing interior crypto bar ends the observation instead of silently crossing an unseen path',()=>{
  const r=advanceForecastJournal(start(),data([initial,candle(t+7200,102.5,101,103)]),t+10800);
  assert.equal(r.journal.records[0].status,'data-gap');
  assert.equal(r.events.some(e=>e.type==='condition-met'),false);
  assert.equal(forecastStats(r.journal.records).resolved,0);
});

test('record creation rejects a forecast belonging to another provider or instrument',()=>{
  const wrongSource={...forecast(),context:{...forecast().context,source:'Kraken'}};
  const wrongSymbol={...forecast(),context:{...forecast().context,symbol:'ETHUSDT'}};
  for(const f of [wrongSource,wrongSymbol])assert.equal(recordForecast(emptyJournal(),data([initial]),f,t+3600).records.length,0);
});

test('future-starting crypto quotes cannot generate current intrabar risk warnings',()=>{
  const bars=[initial,candle(t+3600,102.5,101,103)],j=advanceForecastJournal(start(),data(bars),t+7200).journal;
  const notYetStarted=candle(t+14400,94,93,101,false);
  assert.deepEqual(currentRiskTouches(j,data([...bars,notYetStarted]),t+7300),[]);
});

test('unavailable closed bars cannot advance the journal before their completion time',()=>{
  const r=advanceForecastJournal(start(),data([initial,candle(t+3600,102.5,101,103)]),t+7199);
  assert.equal(r.events.length,0);assert.equal(r.journal.records[0].barsObserved,0);
});

test('a target wick before the entry close is a missed observation and cannot later become a win',()=>{
  const bars=[initial,candle(t+3600,100,99,111),candle(t+7200,102.5,101,103),candle(t+10800,119,115,121)];
  const r=advanceForecastJournal(start(),data(bars),t+14400);
  assert.equal(r.journal.records[0].status,'missed');assert.equal(r.events.length,1);
  const stats=forecastStats(r.journal.records);assert.equal(stats.confirmed,0);assert.equal(stats.resolved,0);assert.equal(stats.netMeanPct,null);
});

test('short outcome costs use the lower entry edge and adverse slippage on both legs',()=>{
  const short:ReadyForecastSide={...structuredClone(side),id:'test-short',side:'short',kind:'breakdown',zoneLow:97,zoneHigh:98,triggerPrice:98,invalidationPrice:105,targets:[level(90),level(80)],anchor:level(98),triggerRule:'close-below'};
  const f={...forecast(),direction:'short' as const,short};
  const j=recordForecast(emptyJournal(),data([initial]),f,t+3600);
  const r=advanceForecastJournal(j,data([initial,candle(t+3600,97.5,97,99),candle(t+7200,81,79,85)]),t+10800).journal;
  const gross=forecastStats(r.records,0,0),net=forecastStats(r.records,5,3);
  assert.equal(gross.netMeanPct,(97-80)/97*100);assert.equal(net.targets,1);assert.ok(net.netMeanPct!<gross.netMeanPct!);
  const entry=97*(1-3/10000),exit=80*(1+3/10000),expected=((entry-exit)-(entry+exit)*5/10000)/entry*100;
  assert.ok(Math.abs(net.netMeanPct!-expected)<1e-10);
});
