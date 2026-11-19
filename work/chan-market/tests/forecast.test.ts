import test from 'node:test';
import assert from 'node:assert/strict';
import { buildForecast, FORECAST_MODEL_VERSION, FORECAST_PARAMETER_VERSION } from '../lib/forecast.ts';
import { evaluateMarketRegime } from '../lib/market-regime.ts';
import { forecastTitle, forecastSummary, forecastHigherText, forecastRegimeText } from '../components/forecast-copy.ts';
import { analyze } from '../lib/chan.ts';
import { candleAvailableAt } from '../lib/timeframe-context.ts';
import type { Candle, Interval, Market, StructureLine } from '../lib/market-types';
import type { ForecastContext, MarketForecast, ReadyForecastSide } from '../lib/forecast-types';

const start=Date.UTC(2025,0,1)/1000;
const context:ForecastContext={market:'crypto',symbol:'BTCUSDT',interval:'1h',source:'Binance',adjustment:'raw'};
const candle=(i:number,close=100,low=99,high=101):Candle=>({time:start+i*3600,open:close,high,low,close,volume:100,closed:true});
const flat=(n=50,price=100)=>Array.from({length:n},(_,i)=>candle(i,price,price*.99,price*1.01));
const research=(bars:Candle[])=>analyze(bars,{skipCalibration:true});
test('forward analysis stops legacy simulation while retaining its existing archive unchanged',()=>{
  const bars=flat(),old=research(bars),before=structuredClone(old.planSession);
  const fresh=analyze([...bars,candle(50,120,90,125)],{skipCalibration:true,skipTradePlans:true,planSession:old.planSession});
  assert.deepEqual(fresh.planSession,before);assert.deepEqual(fresh.tradePlans,before?.plans??[]);
  const withoutArchive=analyze(bars,{skipCalibration:true,skipTradePlans:true});
  assert.deepEqual(withoutArchive.tradePlans,[]);assert.equal(withoutArchive.planSession,undefined);
  assert.deepEqual(withoutArchive.bias,old.bias);assert.deepEqual(withoutArchive.strokes,old.strokes);
});
function structured(long=70) {
  const bars=flat();
  bars[30]=candle(30,100,99,107);bars[36]=candle(36,100,98,101);bars[37]=candle(37,100,99,102);
  const a=research(bars);a.fractals=[{index:30,time:bars[30].time,price:107,type:'top',confirmedAt:32},{index:36,time:bars[36].time,price:98,type:'bottom',confirmedAt:38},{index:37,time:bars[37].time,price:102,type:'top',confirmedAt:39}];a.strokes=[];a.segments=[];a.centers=[];a.bias={...a.bias,long,short:100-long};
  return {bars,a};
}
function geometry(s:ReadyForecastSide) {
  assert.ok([s.zoneLow,s.zoneHigh,s.triggerPrice,s.invalidationPrice,...s.targets.map(t=>t.price)].every(v=>Number.isFinite(v)&&v>0));
  assert.ok(s.zoneLow<=s.triggerPrice&&s.triggerPrice<=s.zoneHigh);
  if(s.side==='long')assert.ok(s.invalidationPrice<s.zoneLow&&s.zoneLow<=s.zoneHigh&&s.zoneHigh<s.targets[0].price&&s.targets[0].price<s.targets[1].price);
  else assert.ok(s.invalidationPrice>s.zoneHigh&&s.zoneHigh>=s.zoneLow&&s.zoneLow>s.targets[0].price&&s.targets[0].price>s.targets[1].price);
}
function ready(f:MarketForecast) {
  assert.equal(f.status,'ready');assert.equal(f.long.status,'ready');assert.equal(f.short.status,'ready');
  if(f.long.status!=='ready'||f.short.status!=='ready')throw new Error('Expected two future scenarios');
  geometry(f.long);geometry(f.short);return {long:f.long,short:f.short};
}

test('forward scenarios use nearest actual confirmed levels and real targets before projections',()=>{
  const {bars,a}=structured(),f=buildForecast(bars,a,context),s=ready(f);
  assert.equal(f.referencePrice,100);assert.equal(f.support?.price,98);assert.equal(f.resistance?.price,102);
  assert.equal(f.direction,'long');assert.equal(s.long.kind,'pullback');assert.equal(s.long.triggerRule,'touch-then-close-above');
  assert.ok(s.long.zoneHigh<f.referencePrice!);assert.equal(s.long.targets[0].price,102);assert.equal(s.long.targets[1].price,107);
  assert.ok(s.long.targets.every(t=>!t.estimated&&t.source==='confirmed-fractal'));
  assert.equal(s.short.kind,'breakdown');assert.equal(s.short.triggerRule,'close-below');assert.ok(s.short.zoneHigh<f.referencePrice!);
});

test('short structure chooses a future rebound zone above the current price',()=>{
  const {bars,a}=structured(30),f=buildForecast(bars,a,context),s=ready(f);
  assert.equal(f.direction,'short');assert.equal(s.short.kind,'rebound');assert.equal(s.short.triggerRule,'touch-then-close-below');
  assert.ok(s.short.zoneLow>100);assert.equal(s.long.kind,'breakout');assert.ok(s.long.zoneLow>100);
});

test('pullback and rebound confirmations have nonzero usable width inside the reference zone',()=>{
  for(const bias of [70,30]) {
    const {bars,a}=structured(bias),f=buildForecast(bars,a,context),s=ready(f),plan=bias===70?s.long:s.short;
    assert.ok(plan.triggerPrice>plan.zoneLow&&plan.triggerPrice<plan.zoneHigh);
    const eligibleClose=bias===70?(plan.triggerPrice+plan.zoneHigh)/2:(plan.triggerPrice+plan.zoneLow)/2;
    assert.ok(eligibleClose>plan.zoneLow&&eligibleClose<plan.zoneHigh);
    assert.ok(bias===70?eligibleClose>plan.triggerPrice:eligibleClose<plan.triggerPrice);
    assert.equal(plan.triggerPrice,plan.anchor.price);
  }
});

test('neutral structural scores stay neutral even when an auxiliary side reports alignment',()=>{
  const {bars,a}=structured(50);const auxiliary=analyze(bars,{skipCalibration:true,context}).confluence!;
  auxiliary.long.status='aligned';a.confluence=auxiliary;
  const f=buildForecast(bars,a,context);ready(f);assert.equal(f.direction,'neutral');assert.deepEqual(f.reasonCodes,['balanced']);
  assert.equal(f.support?.source,'confirmed-fractal');assert.equal(f.resistance?.source,'confirmed-fractal');
});

test('current confluence may veto a strong direction, but future confluence is excluded',()=>{
  const {bars,a}=withHigher(70,'short');
  if(!a.confluence)throw new Error('Missing auxiliary fixture');
  a.confluence.long.status='opposed';
  const opposed=buildForecast(bars,a,context);assert.equal(opposed.direction,'neutral');assert.ok(opposed.reasonCodes.includes('confluence-opposed'));
  a.confluence.asOf+=3600;
  const future=buildForecast(bars,a,context);assert.equal(future.direction,'long');assert.ok(!future.reasonCodes.includes('confluence-opposed'));
});

function withHigher(long=70,direction:'long'|'short'|'neutral'='long') {
  const {bars,a}=structured(long);
  a.confluence=analyze(bars,{skipCalibration:true,context}).confluence!;
  a.confluence.long.status='mixed';a.confluence.short.status='mixed';
  a.confluence.higher={interval:'4h',status:'ready',direction,bars:50,asOf:a.confluence.asOf-7200};
  return {bars,a};
}

test('same-time analysis from a different instrument, period, source or history cannot lend its direction or prices',()=>{
  const {bars,a}=structured();
  a.input=analyze(bars,{skipCalibration:true,context}).input;
  assert.ok(a.input);
  assert.equal(buildForecast(bars,a,context).direction,'long');
  const contexts:ForecastContext[]=[
    {...context,symbol:'ETHUSDT'},{...context,market:'us'},{...context,interval:'4h'},
    {...context,source:'Kraken'},{...context,adjustment:'adjusted'},
  ];
  const revised=bars.map((bar,i)=>i===bars.length-1?{...bar,volume:bar.volume+1}:bar);
  const cases:[Candle[],ForecastContext][]=[...contexts.map(ctx=>[bars,ctx] as [Candle[],ForecastContext]),[bars.slice(1),context],[revised,context]];
  for(const [history,ctx] of cases){
    const f=buildForecast(history,a,ctx);
    assert.equal(f.direction,'neutral');assert.equal(f.mode,'volatility');
    assert.ok(f.noticeCodes.includes('analysis-prefix-mismatch'));
    assert.ok(f.support?.estimated&&f.resistance?.estimated);
  }
});

test('a cached auxiliary verdict cannot veto with unavailable, wrong-direction or foreign higher evidence',()=>{
  for(const higher of ['error','insufficient','wrong-interval','future','neutral','same-side','other-symbol'] as const){
    const {bars,a}=withHigher(70,'short'),c=a.confluence!;
    c.long.status='opposed';
    if(higher==='error'||higher==='insufficient')c.higher.status=higher;
    if(higher==='wrong-interval')c.higher.interval='1d';
    if(higher==='future')c.higher.asOf=c.asOf+1;
    if(higher==='neutral')c.higher.direction='neutral';
    if(higher==='same-side')c.higher.direction='long';
    if(higher==='other-symbol')c.input={...c.input!,symbol:'ETHUSDT'};
    const f=buildForecast(bars,a,context);
    assert.equal(f.direction,'long',higher);assert.ok(!f.reasonCodes.includes('confluence-opposed'));
    if(higher==='other-symbol')assert.equal(f.timeframeAssessment?.reason,'snapshot-mismatch');
  }
});

test('new forecasts version the model and carry closed-only regime without changing direction or price levels',()=>{
  const {bars,a}=structured(),f=buildForecast(bars,a,context);
  assert.equal(f.modelVersion,FORECAST_MODEL_VERSION);assert.equal(f.modelVersion,'forecast-2.1');
  assert.equal(f.parameterVersion,FORECAST_PARAMETER_VERSION);assert.equal(f.analysisVersion,a.ruleVersion);
  assert.deepEqual(f.regime,evaluateMarketRegime(bars,{asOf:f.asOf}));
  assert.equal(f.regime?.samples,50);assert.equal(f.direction,'long');
  const live=buildForecast([...bars,{...candle(50,100,2,250),closed:false}],a,context);
  assert.deepEqual(live.regime,f.regime);assert.deepEqual(live.long,f.long);assert.deepEqual(live.short,f.short);
  const cutoff=f.structureAsOf!;
  const replay=buildForecast([...bars,candle(50,150,90,250),{...candle(51),volume:NaN}],a,{...context,asOf:cutoff});
  assert.deepEqual(replay.regime,f.regime);assert.deepEqual(replay.long,f.long);assert.deepEqual(replay.short,f.short);
  const empty=buildForecast([],research([]),context);
  assert.equal(empty.modelVersion,FORECAST_MODEL_VERSION);assert.equal(empty.regime?.status,'insufficient');
  assert.equal(empty.timeframeAssessment?.reason,'current-unavailable');
});

test('timeframe assessment distinguishes alignment and countertrend without a new directional vote',()=>{
  for(const long of [70,30])for(const higher of ['long','short','neutral'] as const) {
    const {bars,a}=withHigher(long,higher),plain=buildForecast(bars,{...a,confluence:undefined},context),f=buildForecast(bars,a,context);
    const current=long===70?'long':'short';
    assert.equal(f.direction,current);assert.deepEqual(f.long,plain.long);assert.deepEqual(f.short,plain.short);
    assert.equal(f.timeframeAssessment?.status,higher==='neutral'?'mixed':higher===current?'aligned':'countertrend');
    assert.equal(f.timeframeAssessment?.currentDirection,current);assert.equal(f.timeframeAssessment?.higherDirection,higher);
    assert.equal(f.timeframeAssessment?.asOf,f.structureAsOf);assert.equal(f.timeframeAssessment?.higherAsOf,a.confluence!.higher.asOf);
    const labels={long:'偏多',short:'偏空',neutral:'方向待明'};
    const english={long:'bullish',short:'bearish',neutral:'unclear'};
    assert.equal(forecastTitle(f,'zh'),`1小时${labels[current]} · 4小时${labels[higher]}`);
    assert.equal(forecastTitle(f,'en'),`1 hour ${english[current]} · 4 hours ${english[higher]}`);
    assert.match(forecastSummary(f,'zh'),/止盈按1小时计算/);
  }
});

test('only matching, completed, available higher snapshots can describe timeframe alignment',()=>{
  for(const status of ['loading','error','none','imported','insufficient','stale','mismatch'] as const){
    const {bars,a}=withHigher();a.confluence!.higher.status=status;
    const f=buildForecast(bars,a,context);assert.equal(f.timeframeAssessment?.status,'unavailable');
    assert.equal(f.timeframeAssessment?.higherDirection,null);assert.doesNotMatch(forecastHigherText(f,'zh'),/偏多|偏空/);
    assert.doesNotMatch(forecastTitle(f,'zh'),/4小时|逆势/);
  }
  for(const [mutate,reason] of [
    [(a:ReturnType<typeof withHigher>['a'])=>{a.confluence!.asOf+=3600;},'snapshot-mismatch'],
    [(a:ReturnType<typeof withHigher>['a'])=>{a.confluence!.higher.asOf=a.confluence!.asOf+1;},'future-higher'],
    [(a:ReturnType<typeof withHigher>['a'])=>{a.confluence!.higher.interval='1d';},'interval-mismatch'],
    [(a:ReturnType<typeof withHigher>['a'])=>{a.confluence!.higher.bars=34;},'higher-unavailable'],
    [(a:ReturnType<typeof withHigher>['a'])=>{a.confluence!.higher.asOf=null;},'higher-unavailable'],
  ] as const){
    const {bars,a}=withHigher();mutate(a);const f=buildForecast(bars,a,context);
    assert.equal(f.timeframeAssessment?.reason,reason);assert.equal(f.timeframeAssessment?.status,'unavailable');
    assert.match(forecastSummary(f,'zh'),/更大周期暂不可用/);
  }
  const {bars,a}=withHigher();
  const monthly=buildForecast(bars,a,{...context,interval:'1M'});
  assert.equal(monthly.timeframeAssessment?.reason,'no-higher-timeframe');assert.equal(monthly.timeframeAssessment?.higherInterval,null);
  assert.match(forecastSummary(monthly,'zh'),/未提供更大周期/);
});

test('neutral final outlook stays calm even when underlying structural timeframes differ or indicators veto it',()=>{
  const {bars,a}=withHigher(70,'short');a.confluence!.long.status='opposed';
  const vetoed=buildForecast(bars,a,context);
  assert.equal(vetoed.direction,'neutral');assert.equal(vetoed.timeframeAssessment?.status,'countertrend');
  assert.equal(vetoed.timeframeAssessment?.currentDirection,'long');
  const balanced=withHigher(50,'long'),neutral=buildForecast(balanced.bars,balanced.a,context);
  assert.equal(neutral.direction,'neutral');assert.equal(neutral.timeframeAssessment?.status,'mixed');
  for(const f of [vetoed,neutral]) {
    assert.match(forecastTitle(f,'zh'),/方向待明/);assert.match(forecastSummary(f,'zh'),/当前方向不明确/);
    assert.doesNotMatch(forecastTitle(f,'zh')+forecastSummary(f,'zh'),/双向冲突|做多|做空|逆势|偏多|偏空/);
    assert.doesNotMatch(forecastTitle(f,'en')+forecastSummary(f,'en'),/countertrend|buy|short after|bullish|bearish|conflict/i);
  }
});

test('market regime copy is bilingual, auxiliary and explicitly unavailable before warmup',()=>{
  const {bars,a}=structured(),f=buildForecast(bars,a,context),regime=f.regime!;
  for(const [state,direction,zh,en] of [
    ['trend','long','上行趋势','Upward trend'],['trend','short','下行趋势','Downward trend'],
    ['range','neutral','区间震荡','Range-bound'],['transition','neutral','趋势过渡','Transition'],['volatile','neutral','高波动','High volatility'],
  ] as const){
    const view={...f,regime:{...regime,status:'ready' as const,state,direction}};
    assert.equal(forecastRegimeText(view,'zh'),zh);assert.equal(forecastRegimeText(view,'en'),en);
    assert.equal(forecastTitle(view,'zh'),forecastTitle(f,'zh'));assert.equal(forecastSummary(view,'zh'),forecastSummary(f,'zh'));
  }
  assert.match(forecastRegimeText({...f,regime:{...regime,status:'insufficient'}},'zh'),/历史不足/);
  const legacy={...f,regime:undefined,timeframeAssessment:undefined,modelVersion:undefined};
  assert.doesNotMatch(forecastSummary(legacy,'zh'),/更大周期|逆势/);
  assert.match(forecastSummary(legacy,'en'),/Entry zones/);
});

test('every forecast is independent of old triggered, stopped or simulated-position state',()=>{
  const {bars,a}=structured(),expected=buildForecast(bars,a,context);
  for(const key of ['tradePlans','decision','planSession','tradeSetups'] as const)Object.defineProperty(a,key,{get(){throw new Error(`Old state ${key} must not be read`);}});
  assert.deepEqual(buildForecast(bars,a,context),expected);
});

test('a forming quote updates future levels without entering ATR or confirmed structure',()=>{
  const {bars,a}=structured(),closedForecast=buildForecast(bars,a,context);
  const current={...candle(50,105,94,120),closed:false};
  const live=buildForecast([...bars,current],a,context);ready(live);
  assert.equal(live.referencePrice,105);assert.equal(live.referenceClosed,false);assert.equal(live.lastClosedPrice,100);
  assert.equal(live.atr,closedForecast.atr);assert.equal(live.structureAsOf,closedForecast.structureAsOf);
  assert.notEqual(live.long.triggerPrice,closedForecast.long.triggerPrice);
  assert.ok(live.noticeCodes.includes('live-reference'));
});

test('a live price far from an old center generates local volatility references, never the old entry',()=>{
  const {bars,a}=structured();
  const f=buildForecast([...bars,{...candle(50,60,59,61),closed:false}],a,context);const s=ready(f);
  assert.equal(f.mode,'volatility');assert.equal(f.direction,'neutral');
  assert.ok(f.support!.price<60&&f.resistance!.price>60);assert.ok(s.long.zoneHigh<70&&s.short.zoneLow>50);
  assert.ok(f.noticeCodes.includes('volatility-reference'));assert.equal(s.long.anchor.estimated,true);
});

test('flat history exposes explicitly estimated volatility references rather than invented Chan points',()=>{
  const bars=flat(),a=research(bars);a.bias={...a.bias,long:90,short:10};
  const f=buildForecast(bars,a,context),s=ready(f);
  assert.equal(f.mode,'volatility');assert.equal(f.direction,'neutral');assert.ok(f.reasonCodes.includes('structure-insufficient'));
  assert.ok([f.support!,f.resistance!,...s.long.targets,...s.short.targets].every(p=>p.estimated&&p.source==='atr-reference'&&p.time===null));
  assert.ok(s.long.basis.includes('estimated-target'));assert.ok(s.short.basis.includes('atr-reference'));
});

test('short history and invalid input do not fabricate operation levels',()=>{
  for(const bars of [[],flat(13),[...flat(13),{...candle(13),closed:false}]]) {
    const f=buildForecast(bars,research(bars),context);assert.equal(f.status,'insufficient');assert.equal(f.long.zoneLow,null);assert.equal(f.short.targets,null);assert.equal(f.direction,'neutral');
  }
  const bars=flat();bars.push({...candle(50),high:NaN});bars.push({...candle(51),low:-1});
  const f=buildForecast(bars,research(bars),context);ready(f);assert.equal(f.referenceTime,candle(49).time);assert.ok(f.noticeCodes.includes('invalid-candles-excluded'));
});

test('zero ranges, sub-cent currencies and severe price gaps retain positive ordered geometry',()=>{
  for(const price of [1e-7,.001,1,69000,1e9]) {
    for(const range of [0,.01,100]) {
      const bars=Array.from({length:50},(_,i)=>candle(i,price,range?price*.1:price,price*(1+range)));
      const f=buildForecast(bars,research(bars),context);ready(f);
      assert.ok(f.buffer!<=price*.08&&f.buffer!>=price*.002);
    }
  }
});

test('forecast is supported across all nine chart intervals and three markets',()=>{
  const intervals:Interval[]=['1m','5m','15m','30m','1h','4h','1d','1w','1M'];
  const markets:Market[]=['crypto','us','cn'];
  const span:Record<Interval,number>={'1m':60,'5m':300,'15m':900,'30m':1800,'1h':3600,'4h':14400,'1d':86400,'1w':604800,'1M':2678400};
  for(const market of markets)for(const interval of intervals) {
    const bars=flat().map((b,i)=>({...b,time:interval==='1M'?Date.UTC(2020, i,1)/1000:start+i*span[interval]}));
    const ctx={...context,market,interval,symbol:market==='crypto'?'BTCUSDT':market==='us'?'AAPL':'603993.SH'};
    const f=buildForecast(bars,research(bars),ctx),s=ready(f);
    assert.equal(f.context.market,market);assert.equal(f.context.interval,interval);assert.ok(s.long.id.includes(`:${interval}:`));
    assert.equal(f.noticeCodes.includes('cn-short-restricted'),market==='cn');
  }
});

test('an explicit historical cutoff excludes later completed candles, including the bar starting at that cutoff',()=>{
  const bars=flat(70),cutoff=candle(40).time+3600;
  bars[60]=candle(60,1000,999,1001);
  const f=buildForecast(bars,research(bars),{...context,asOf:cutoff});ready(f);
  assert.equal(f.referenceTime,candle(40).time);assert.equal(f.referencePrice,100);assert.equal(f.lastClosedTime,candle(40).time);
  assert.ok(f.noticeCodes.includes('future-candles-excluded'));assert.ok(f.noticeCodes.includes('analysis-prefix-mismatch'));assert.equal(f.direction,'neutral');
});

test('China end-labelled forming minute quote is usable before its end timestamp',()=>{
  const ctx:ForecastContext={...context,market:'cn',symbol:'603993.SH',interval:'1m',source:'东方财富',asOf:Date.parse('2026-01-07T02:00:30Z')/1000};
  const first=Date.parse('2026-01-07T01:00:00Z')/1000;
  const bars=flat(50).map((b,i)=>({...b,time:first+i*60}));
  const quote={...candle(50,103,102,104),time:Date.parse('2026-01-07T02:01:00Z')/1000,closed:false};
  const f=buildForecast([...bars,quote],research(bars),ctx);ready(f);
  assert.equal(f.referencePrice,103);assert.equal(f.referenceTime,quote.time);assert.equal(f.referenceClosed,false);
  assert.equal(f.lastClosedTime,bars.at(-1)!.time);
});

test('China and Eastmoney US aggregated forming 4H bars cannot appear before their start time',()=>{
  for(const [market,symbol,open] of [['cn','600519.SH','2026-01-07T01:30:00Z'],['us','AAPL','2026-01-07T14:30:00Z']] as const){
    const quoteTime=Date.parse(open)/1000;
    const bars=flat(50).map((bar,i)=>({...bar,time:quoteTime-(50-i)*86400}));
    const quote={...candle(50,200,190,210),time:quoteTime,closed:false};
    const ctx:ForecastContext={...context,market,symbol,interval:'4h',source:'东方财富',asOf:quoteTime-3600};
    const a=research(bars),before=buildForecast(bars,a,ctx),future=buildForecast([...bars,quote],a,ctx);
    assert.equal(future.referenceTime,bars.at(-1)!.time);assert.equal(future.referencePrice,100);
    assert.equal(future.referenceClosed,true);assert.ok(future.noticeCodes.includes('future-candles-excluded'));
    assert.deepEqual(future.long,before.long);assert.deepEqual(future.short,before.short);assert.deepEqual(future.regime,before.regime);
    const started=buildForecast([...bars,quote],a,{...ctx,asOf:quoteTime});
    assert.equal(started.referenceTime,quoteTime);assert.equal(started.referencePrice,200);assert.equal(started.referenceClosed,false);
  }
});

test('replay prefixes exclude later confirmations and never use a provisional stroke',()=>{
  const {bars,a}=structured(),expected=buildForecast(bars,a,context);
  const future={index:48,time:bars[48].time,price:100.5,type:'top' as const,confirmedAt:53};
  a.fractals.push(future);
  a.strokes.push({from:{index:45,time:bars[45].time,price:99},to:{index:48,time:bars[48].time,price:100.5},direction:'up',confirmed:false,confirmedAt:49});
  assert.deepEqual(buildForecast(bars,a,context),expected);
  const extended=[...bars,...flat(10).map((b,i)=>({...b,time:candle(50+i).time}))];
  extended[55]={...extended[55],close:500,high:510,low:490,open:500};
  assert.deepEqual(buildForecast(extended.slice(0,50),a,context),expected);
});

test('center boundaries require completed constituent segments and retain actual anchor metadata',()=>{
  const bars=flat();for(const [index,price] of [[10,96],[15,104],[20,98],[25,106]])bars[index]=candle(index,100,Math.min(99,price),Math.max(101,price));
  const p=(index:number,price:number)=>({index,time:bars[index].time,price});
  const segments:StructureLine[]=[{from:p(10,96),to:p(15,104),direction:'up',confirmed:true,confirmedAt:30},{from:p(15,104),to:p(20,98),direction:'down',confirmed:true,confirmedAt:31},{from:p(20,98),to:p(25,106),direction:'up',confirmed:true,confirmedAt:32}];
  const a=research(bars);a.fractals=[];a.strokes=[];a.segments=segments;a.centers=[{startIndex:10,endIndex:25,low:98,high:104,level:'线段中枢',status:'active'}];
  const f=buildForecast(bars,a,context);ready(f);assert.equal(f.support?.source,'confirmed-center');assert.equal(f.support?.price,98);assert.equal(f.support?.index,20);assert.equal(f.support?.confirmedAt,32);
  a.segments[2]={...a.segments[2],confirmed:false};
  const provisional=buildForecast(bars,a,context);assert.equal(provisional.mode,'volatility');
});

test('complex center ranges authenticate internal extrema as real forecast anchors',()=>{
  const bars=flat();
  for(const [index,price] of [[10,100],[12,104],[15,96],[20,106],[25,98]])bars[index]=candle(index,100,Math.min(99,price),Math.max(101,price));
  const p=(index:number,price:number)=>({index,time:bars[index].time,price});
  const segments:StructureLine[]=[
    {from:p(10,100),to:p(15,96),direction:'down',confirmed:true,confirmedAt:30,priceRange:{low:96,high:104,lowPoint:p(15,96),highPoint:p(12,104)}},
    {from:p(15,96),to:p(20,106),direction:'up',confirmed:true,confirmedAt:31},
    {from:p(20,106),to:p(25,98),direction:'down',confirmed:true,confirmedAt:32},
  ];
  const a=research(bars);a.fractals=[];a.strokes=[];a.segments=segments;a.centers=[{startIndex:10,endIndex:25,low:98,high:104,level:'线段中枢',status:'active'}];
  const f=buildForecast(bars,a,context);ready(f);
  assert.equal(f.resistance!.source,'confirmed-center');
  assert.equal(f.resistance!.price,104);assert.equal(f.resistance!.index,12);assert.equal(f.resistance!.time,bars[12].time);assert.equal(f.resistance!.confirmedAt,32);
  const future=structuredClone(a);future.segments[0].priceRange!.highPoint=p(40,104);
  const futureBars=structuredClone(bars);futureBars[40]=candle(40,100,99,104);
  assert.equal(buildForecast(futureBars,future,context).mode,'volatility','an extreme after the segment endpoint is not a constituent anchor');
  const mismatched=structuredClone(a);mismatched.segments[0].priceRange!.highPoint.price=103;
  assert.equal(buildForecast(bars,mismatched,context).mode,'volatility');
});

function extendedCenter(retest:boolean) {
  const bars=flat(220),vertices=retest?[[0,96],[10,104],[20,98],[80,106],[120,98],[160,104],[200,99]]:[[0,96],[10,104],[20,98],[80,106],[120,99],[160,105],[200,100]];
  for(const [index,price] of vertices)bars[index]=candle(index,100,Math.min(99,price),Math.max(101,price));
  const points=vertices.map(([index,price])=>({index,time:bars[index].time,price}));
  const segments:StructureLine[]=points.slice(1).map((to,i)=>({from:points[i],to,direction:to.price>points[i].price?'up':'down',confirmed:true,confirmedAt:to.index+2}));
  const a=research(bars);a.fractals=[];a.strokes=[];a.segments=segments;a.centers=[{startIndex:0,endIndex:200,low:98,high:104,level:'线段中枢',status:'active'}];
  return {bars,a};
}

test('a recently extended center retains its fixed old boundaries without inventing recent anchors',()=>{
  const {bars,a}=extendedCenter(false),f=buildForecast(bars,a,context);ready(f);
  assert.equal(f.support?.source,'confirmed-center');assert.equal(f.support?.price,98);assert.equal(f.support?.index,20);assert.equal(f.support?.time,bars[20].time);
  assert.equal(f.resistance?.source,'confirmed-center');assert.equal(f.resistance?.price,104);assert.equal(f.resistance?.index,10);
  assert.equal(f.support?.confirmedAt,202);
  const older=[...bars,...flat(150).map((b,i)=>({...b,time:candle(220+i).time}))];
  assert.equal(buildForecast(older,a,context).mode,'volatility');
});

test('center references prefer the most recent real boundary touch',()=>{
  const {bars,a}=extendedCenter(true),f=buildForecast(bars,a,context);ready(f);
  assert.equal(f.support?.source,'confirmed-center');assert.equal(f.support?.index,120);
  assert.equal(f.resistance?.source,'confirmed-center');assert.equal(f.resistance?.index,160);
});

test('disconnected, direction-invalid or broken extensions cannot authenticate center levels',()=>{
  const {bars,a}=extendedCenter(false);
  const disconnected=structuredClone(a);disconnected.segments[2].from={index:21,time:bars[21].time,price:99};
  assert.equal(buildForecast(bars,disconnected,context).mode,'volatility');
  const wrongDirection=structuredClone(a);wrongDirection.segments[1].direction='up';
  assert.equal(buildForecast(bars,wrongDirection,context).mode,'volatility');
  const broken=structuredClone(a),other=structuredClone(bars);
  other[120]=candle(120,105,104,106);
  broken.segments[3].to.price=105;broken.segments[4].from.price=105;broken.segments[4].to.price=106;
  other[160]=candle(160,106,105,107);broken.segments[5].from.price=106;
  assert.equal(buildForecast(other,broken,context).mode,'volatility');
  const future=structuredClone(a);future.segments.at(-1)!.confirmedAt=230;
  assert.equal(buildForecast(bars,future,context).mode,'volatility');
});

test('a completed-bar forecast uses availability time while preserving its raw reference time',()=>{
  const {bars,a}=structured(),f=buildForecast(bars,a,context),last=bars.at(-1)!;
  assert.equal(f.referenceTime,last.time);assert.equal(f.structureAsOf,candleAvailableAt(last,'crypto','1h','Binance'));assert.equal(f.asOf,f.structureAsOf);
});
