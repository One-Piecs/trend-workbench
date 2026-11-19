import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../lib/chan.ts';
import { buildTradePlans, coordinateTradePlans, evaluateTradePlan } from '../lib/trade-plans.ts';
import { translateAnalysis } from '../lib/analysis-i18n.ts';
import { planSessionKey, readPlanSession, writePlanSession } from '../lib/plan-session.ts';
import type { PlanStructure } from '../lib/trade-plans.ts';
import type { Candle, TradePlan } from '../lib/market-types';

type Bar=Candle&{index:number};
const bar=(index:number,close=100,low=close-.5,high=close+.5):Bar=>({index,time:1700000000+index*3600,open:close,high,low,close,volume:100,closed:true});
const structure=(long=50):PlanStructure=>({fractals:[],strokes:[],centers:[],bias:{long,short:100-long,label:'test'}});
const flat=(n:number,price=100)=>Array.from({length:n},(_,i)=>bar(i,price,price*.99,price*1.01));
const fixture=():TradePlan=>({id:'long-fixture',side:'long',label:'做多计划',strategy:'测试',priority:'primary',status:'untriggered',statusLabel:'未触发',entryLow:101,entryHigh:102,triggerPrice:101,stopLoss:99,target1:106.5,target2:109.5,rr1:1.5,rr2:2.5,anchor:{index:0,time:bar(0).time,price:100},generatedAt:bar(0).time,generatedIndex:0,atr:1,basis:'fixture',trigger:'close crosses and lands inside entry zone',invalidation:'stop or expiry',statusReason:'未触发'});
const mirrorPlan=(p:TradePlan):TradePlan=>({...p,id:'short-fixture',side:'short',entryLow:200-p.entryHigh,entryHigh:200-p.entryLow,triggerPrice:200-p.triggerPrice,stopLoss:200-p.stopLoss,target1:200-p.target1,target2:200-p.target2,anchor:{...p.anchor,price:200-p.anchor.price}});
const mirrorBars=(bars:Bar[])=>bars.map(b=>({...b,open:200-b.open,close:200-b.close,low:200-b.high,high:200-b.low}));
function assertGeometry(p:TradePlan) {
  for(const n of [p.entryLow,p.entryHigh,p.triggerPrice,p.stopLoss,p.target1,p.target2,p.rr1,p.rr2])assert.ok(Number.isFinite(n)&&n>0,`${p.side}: finite positive ${n}`);
  assert.ok(p.entryLow<=p.triggerPrice&&p.triggerPrice<=p.entryHigh);
  if(p.side==='long') {
    assert.ok(p.stopLoss<p.entryLow&&p.entryLow<=p.entryHigh&&p.entryHigh<p.target1&&p.target1<p.target2);
    assert.ok(Math.abs(p.rr1-(p.target1-p.entryHigh)/(p.entryHigh-p.stopLoss))<1e-9);
    assert.ok(Math.abs(p.rr2-(p.target2-p.entryHigh)/(p.entryHigh-p.stopLoss))<1e-9);
  } else {
    assert.ok(p.stopLoss>p.entryHigh&&p.entryHigh>=p.entryLow&&p.entryLow>p.target1&&p.target1>p.target2);
    assert.ok(Math.abs(p.rr1-(p.entryLow-p.target1)/(p.stopLoss-p.entryLow))<1e-9);
    assert.ok(Math.abs(p.rr2-(p.entryLow-p.target2)/(p.stopLoss-p.entryLow))<1e-9);
  }
}

test('plans provide positive ordered prices and conservative reward/risk across price scales',()=>{
  for(const price of [1e-7,.01,100,69000])for(const range of [.00001,.01,2]) {
    const bars=flat(20,price).map(b=>({...b,low:price*.1,high:price*(1+range)}));
    const s=structure(),result=buildTradePlans(bars,s,()=>s);
    assert.equal(result.tradePlans.length,2);
    result.tradePlans.forEach(assertGeometry);
  }
});

test('distant old center is background and recent actual pivots anchor reference entries',()=>{
  const bars=flat(20,69000),s=structure(10);
  s.centers=[{startIndex:0,endIndex:3,low:82595,high:87230,level:'线段',status:'broken'}];
  s.fractals=[{index:12,time:bars[12].time,price:69700,type:'top',confirmedAt:14},{index:11,time:bars[11].time,price:68000,type:'bottom',confirmedAt:13}];
  const {tradePlans,decision}=buildTradePlans(bars,s,()=>s);
  const long=tradePlans.find(p=>p.side==='long')!,short=tradePlans.find(p=>p.side==='short')!;
  assert.ok(long.entryHigh<73000&&short.entryLow>65000);
  assert.equal(long.anchor.price,69700);assert.equal(short.anchor.price,68000);
  assert.equal(long.generatedIndex,14);assert.ok(long.generatedIndex>long.anchor.index);
  assert.match(long.basis,/旧中枢距现价较远/);
  assert.equal(decision.direction,'short');assert.equal(short.priority,'primary');
  tradePlans.forEach(assertGeometry);
});

test('future-confirmed structure is excluded from a generation snapshot',()=>{
  const bars=flat(10),s=structure();
  s.fractals=[{index:6,time:bars[6].time,price:101,type:'top',confirmedAt:12}];
  const {tradePlans}=buildTradePlans(bars,s,()=>s);
  assert.notEqual(tradePlans[0].anchor.index,6);
  assert.ok(tradePlans.every(p=>p.generatedIndex>=p.anchor.index));
});

test('generation candle extremes and unfinished candles cannot trigger a plan',()=>{
  const p=fixture(),candles=[bar(0,100,90,120),{...bar(1,101.5,100,102),closed:false}];
  assert.equal(evaluateTradePlan(p,candles).status,'untriggered');
  assert.equal(p.status,'untriggered');
});

test('a later close crossing into the zone triggers symmetrically, without mutating prices',()=>{
  const p=fixture(),candles=[bar(0),bar(1,101.4,100.5,102)];
  for(const [plan,bars] of [[p,candles],[mirrorPlan(p),mirrorBars(candles)]] as const) {
    const result=evaluateTradePlan(plan,bars);
    assert.equal(result.status,'triggered');assert.equal(result.triggeredAt,bars[1].time);
    assert.deepEqual([result.entryLow,result.entryHigh,result.stopLoss,result.target1,result.target2],[plan.entryLow,plan.entryHigh,plan.stopLoss,plan.target1,plan.target2]);
    assert.equal(plan.status,'untriggered');assert.match(result.statusReason,/不代表实盘成交/);
  }
});

test('closing beyond the entry zone skips the trade instead of claiming a fill',()=>{
  const candles=[bar(0),bar(1,103,100,104)];
  for(const [plan,bars] of [[fixture(),candles],[mirrorPlan(fixture()),mirrorBars(candles)]] as const) {
    const result=evaluateTradePlan(plan,bars);assert.equal(result.status,'invalidated');assert.equal(result.triggeredAt,undefined);assert.match(result.statusReason,/跳过参考入场区/);
  }
});

test('same candle trigger plus stop or pre-trigger target cannot count as profit',()=>{
  for(const b of [bar(1,101.5,98,102),bar(1,101.5,100,110)]) {
    const result=evaluateTradePlan(fixture(),[bar(0),b]);
    assert.equal(result.status,'invalidated');assert.equal(result.triggeredAt,undefined);assert.match(result.statusReason,/顺序不明|无法确定顺序/);
  }
});

test('target touched by a wick before entry invalidates a later apparent trigger',()=>{
  const candles=[bar(0),bar(1,100.5,100,110),bar(2,101.5,100,102)];
  for(const [plan,bars] of [[fixture(),candles],[mirrorPlan(fixture()),mirrorBars(candles)]] as const) {
    const result=evaluateTradePlan(plan,bars);assert.equal(result.status,'invalidated');assert.equal(result.triggeredAt,undefined);assert.equal(result.statusAt,bars[1].time);assert.match(result.statusReason,/目标价格已经覆盖/);
  }
});

test('after trigger, stop and target in the same candle resolve conservatively',()=>{
  const result=evaluateTradePlan(fixture(),[bar(0),bar(1,101.5,100,102),bar(2,103,98,111)]);
  assert.equal(result.status,'invalidated');assert.equal(result.triggeredAt,bar(1).time);assert.match(result.statusReason,/不记作盈利/);
});

test('later target 1 leaves original plan active and target 2 ends the model event',()=>{
  const candles=[bar(0),bar(1,101.5,100,102),bar(2,106,104,107)];
  const first=evaluateTradePlan(fixture(),candles);assert.equal(first.status,'triggered');assert.match(first.statusReason,/第一目标/);
  const second=evaluateTradePlan(fixture(),[...candles,bar(3,109,107,110)]);
  assert.equal(second.status,'target_reached');assert.equal(second.statusAt,bar(3).time);assert.match(second.statusReason,/不代表实际成交/);
});

test('untriggered plans expire after 12 later completed candles',()=>{
  const bars=Array.from({length:13},(_,i)=>bar(i));
  assert.equal(evaluateTradePlan(fixture(),bars.slice(0,12)).status,'untriggered');
  const end=evaluateTradePlan(fixture(),bars);assert.equal(end.status,'invalidated');assert.match(end.statusReason,/到期/);
});

test('appending closed bars preserves a pending plan until its real expiry',()=>{
  const bars=flat(16),s=structure();
  const before=buildTradePlans(bars.slice(0,10),s,()=>s);
  for(const n of [11,12,13,14]) {
    const later=buildTradePlans(bars.slice(0,n),s,()=>s);
    for(const p of later.tradePlans) {
      const old=before.tradePlans.find(x=>x.side===p.side)!;
      assert.equal(p.id,old.id);assert.equal(p.generatedIndex,2);
      assert.equal(p.status,'untriggered');assert.equal(p.previousOutcome,undefined);
      assert.deepEqual([p.entryLow,p.entryHigh,p.stopLoss,p.target1,p.target2],[old.entryLow,old.entryHigh,old.stopLoss,old.target1,old.target2]);
    }
  }
  const expired=buildTradePlans(bars.slice(0,15),s,()=>s);
  for(const p of expired.tradePlans) {
    assert.equal(p.generatedIndex,14);assert.notEqual(p.id,before.tradePlans.find(x=>x.side===p.side)!.id);
    assert.equal(p.previousOutcome?.statusAt,bars[14].time);assert.match(p.previousOutcome!.reason,/12根.*到期/);
  }
});

test('newly confirmed structure cannot replace an existing or triggered plan',()=>{
  const bars=flat(6),s=structure();
  bars[3]=bar(3,101.6,101.2,102);bars[4]=bar(4,102.2,101.5,102.5);bars[5]=bar(5,102,101.5,102.4);
  const before=buildTradePlans(bars.slice(0,3),s,()=>s).tradePlans[0];
  const triggered=buildTradePlans(bars.slice(0,4),s,()=>s).tradePlans[0];
  assert.equal(triggered.id,before.id);assert.equal(triggered.status,'triggered');assert.equal(triggered.triggeredAt,bars[3].time);
  const withNewFractal:PlanStructure={...s,fractals:[{index:3,time:bars[3].time,price:102,type:'top',confirmedAt:4}]};
  const snapshot=(prefix:Bar[])=>prefix.at(-1)!.index>=4?withNewFractal:s;
  for(const n of [5,6]) {
    const later=buildTradePlans(bars.slice(0,n),withNewFractal,snapshot).tradePlans[0];
    assert.equal(later.id,before.id);assert.equal(later.status,'triggered');assert.equal(later.triggeredAt,bars[3].time);
    assert.deepEqual([later.entryLow,later.entryHigh,later.stopLoss,later.target1,later.target2],[before.entryLow,before.entryHigh,before.stopLoss,before.target1,before.target2]);
  }
  assert.deepEqual(buildTradePlans(bars.slice(0,3),s,snapshot).tradePlans[0],before);
});

test('replay shares structure snapshots and rebuilds them only when a plan ends',()=>{
  const bars=flat(800),s=structure(),positions:number[]=[];
  buildTradePlans(bars,s,prefix=>{positions.push(prefix.length-1);return s;});
  assert.deepEqual(positions,Array.from({length:67},(_,i)=>2+i*12));
});

test('saved pending plans survive a rolling history and retain their expiry count',()=>{
  const bars=flat(16),s=structure(),initial=buildTradePlans(bars.slice(0,10),s,()=>s);
  const rolling=(start:number,end:number)=>bars.slice(start,end).map((b,index)=>({...b,index}));
  const next=buildTradePlans(rolling(4,11),s,()=>s,initial.planSession);
  for(const p of next.tradePlans) {
    assert.equal(p.id,initial.tradePlans.find(x=>x.side===p.side)!.id);
    assert.equal(p.generatedAt,bars[2].time);assert.equal(p.generatedIndex,-1);
    assert.equal(p.status,'untriggered');assert.equal(p.evaluatedBars,8);
  }
  const same=buildTradePlans(rolling(4,11),s,()=>s,next.planSession);
  assert.deepEqual(same,next);
  const expired=buildTradePlans(rolling(8,15),s,()=>s,next.planSession);
  for(const p of expired.tradePlans) {
    assert.equal(p.generatedAt,bars[14].time);assert.equal(p.generatedIndex,6);
    assert.equal(p.evaluatedBars,0);assert.equal(p.previousOutcome?.statusAt,bars[14].time);
    assert.match(p.previousOutcome!.reason,/12根.*到期/);
  }
});

test('saved triggered plans survive creation-bar removal, but cannot leak into historical replay',()=>{
  const bars=flat(6),s=structure();
  bars[3]=bar(3,101.6,101.2,102);bars[4]=bar(4,102.2,101.5,102.5);bars[5]=bar(5,102,101.5,102.4);
  const earlier=analyze(bars.slice(0,3)),first=analyze(bars.slice(0,4));
  assert.equal(first.tradePlans[0].status,'triggered');
  const next=analyze(bars.slice(3),{planSession:first.planSession});
  assert.equal(next.tradePlans[0].id,first.tradePlans[0].id);assert.equal(next.tradePlans[0].status,'triggered');
  assert.equal(next.tradePlans[0].generatedIndex,-1);assert.equal(next.tradePlans[0].triggeredAt,bars[3].time);
  assert.deepEqual(analyze(bars.slice(0,3),{planSession:next.planSession}),earlier);
  const gap=flat(20).slice(10),withoutSession=buildTradePlans(gap,s,()=>s);
  assert.deepEqual(buildTradePlans(gap,s,()=>s,first.planSession),withoutSession);
});

test('plan-session storage restores prices and rejects corrupt or incompatible records',()=>{
  const saved=new Map<string,string>(),storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);}};
  const identity={market:'crypto' as const,symbol:'BTCUSDT',interval:'4h' as const,source:'Kraken',penMode:'new' as const};
  const key=planSessionKey(identity),session=analyze(flat(10)).planSession!;
  writePlanSession(key,session,storage);assert.deepEqual(readPlanSession(key,storage),session);
  for(const changed of [{source:'Binance'},{interval:'1h' as const},{symbol:'ETHUSDT'},{penMode:'old' as const},{market:'us' as const}]) {
    assert.notEqual(planSessionKey({...identity,...changed}),key);assert.equal(readPlanSession(planSessionKey({...identity,...changed}),storage),undefined);
  }
  for(const value of ['bad JSON',JSON.stringify({...session,version:0}),JSON.stringify({...session,plans:[session.plans[0],session.plans[0]]}),JSON.stringify({...session,plans:session.plans.map(p=>({...p,stopLoss:-1}))})]) {
    storage.setItem(key,value);assert.equal(readPlanSession(key,storage),undefined);
  }
  const blocked={getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('full');}};
  assert.equal(readPlanSession(key,blocked),undefined);assert.doesNotThrow(()=>writePlanSession(key,session,blocked));
});

test('zero-range candles preserve valid plans when saving and restoring their zero ATR',()=>{
  const saved=new Map<string,string>(),storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);}};
  const candles=flat(10).map(b=>({...b,open:100,high:100,low:100,close:100}));
  const session=analyze(candles).planSession!;
  assert.ok(session.plans.every(p=>p.atr===0));session.plans.forEach(assertGeometry);
  const key=planSessionKey({market:'cn',symbol:'603993.SH',interval:'4h',source:'test',penMode:'new'});
  writePlanSession(key,session,storage);assert.deepEqual(readPlanSession(key,storage),session);
  assert.deepEqual(analyze(candles,{planSession:readPlanSession(key,storage)}).tradePlans,session.plans);
});

test('a terminated plan is replaced at its terminal close with its outcome retained',()=>{
  const bars=flat(10),s=structure();
  s.fractals=[{index:5,time:bars[5].time,price:101,type:'top',confirmedAt:7}];
  bars[8]=bar(8,102.5,100,103);bars[9]=bar(9,102,101.5,102.5);
  const long=buildTradePlans(bars,s,()=>s).tradePlans.find(p=>p.side==='long')!;
  assert.equal(long.generatedIndex,8);assert.equal(long.status,'untriggered');
  assert.equal(long.previousOutcome?.status,'invalidated');assert.equal(long.previousOutcome?.statusAt,bars[8].time);
  assertGeometry(long);
});

test('both plans renew on the latest terminal bar without consuming its earlier extremes',()=>{
  const bars=flat(10),s=structure(10);
  s.fractals=[{index:5,time:bars[5].time,price:101,type:'top',confirmedAt:7},{index:4,time:bars[4].time,price:99,type:'bottom',confirmedAt:6}];
  const before=buildTradePlans(bars.slice(0,9),s,()=>s);
  bars[9]=bar(9,95,90,110);
  const next=buildTradePlans(bars,s,()=>s);
  for(const p of next.tradePlans) {
    assert.equal(p.generatedIndex,9);assert.equal(p.generatedAt,bars[9].time);
    assert.notEqual(p.id,before.tradePlans.find(old=>old.side===p.side)!.id);
    assert.equal(p.status,'untriggered');assert.equal(p.triggeredAt,undefined);assert.equal(p.statusAt,undefined);
    assert.equal(p.previousOutcome?.status,'invalidated');assert.equal(p.previousOutcome?.statusAt,bars[9].time);
    // These extremes belong to the creation bar and must not be replayed as a new entry or stop.
    assert.ok(p.side==='long'?bars[9].low<=p.stopLoss:bars[9].high>=p.stopLoss);
    assertGeometry(p);
  }
  assert.equal(next.decision.direction,'short');assert.equal(next.decision.title,'等待K线结束确认 · 结构偏空');
  assert.equal(next.decision.state,'waiting');
  const later=buildTradePlans([...bars,bar(10,95,94.5,95.5)],s,()=>s);
  for(const p of later.tradePlans) {
    const previous=next.tradePlans.find(old=>old.side===p.side)!;
    assert.equal(p.id,previous.id);assert.equal(p.generatedIndex,previous.generatedIndex);
    assert.deepEqual([p.entryLow,p.entryHigh,p.stopLoss,p.target1,p.target2],[previous.entryLow,previous.entryHigh,previous.stopLoss,previous.target1,previous.target2]);
    assert.equal(p.status,'untriggered');
  }
});

test('analysis ignores live bars in plans and preserves actual raw indices despite gaps',()=>{
  const candles=Array.from({length:100},(_,i)=>{const price=100+Math.sin(i/4)*5;return bar(i,price,price-1,price+1);});
  candles[20]={...candles[20],closed:false};candles[28]={...candles[28],high:NaN};
  const base=analyze(candles),live=analyze([...candles,{...bar(100,1000,1,2000),closed:false}]);
  assert.deepEqual(live.tradePlans,base.tradePlans);assert.deepEqual(live.decision,base.decision);
  for(const p of base.tradePlans){assert.equal(p.anchor.time,candles[p.anchor.index].time);assert.equal(p.generatedAt,candles[p.generatedIndex].time);assertGeometry(p);}
  assert.ok(base.signals.every(s=>!s.label.includes('?')));
});

test('insufficient history gives no invented levels',()=>{
  const a=analyze([bar(0),bar(1)]);assert.deepEqual(a.tradePlans,[]);assert.equal(a.decision.title,'历史不足');
});

test('renewing a failed preferred plan does not reverse the structural preference',()=>{
  const bars=flat(10),s=structure(10);bars[9]=bar(9,100,99.5,101.4);
  const result=buildTradePlans(bars,s,()=>s);
  assert.equal(result.tradePlans.find(p=>p.side==='short')?.status,'untriggered');
  assert.equal(result.tradePlans.find(p=>p.side==='short')?.previousOutcome?.status,'invalidated');
  assert.equal(result.tradePlans.find(p=>p.side==='long')?.status,'untriggered');
  assert.equal(result.decision.direction,'short');assert.equal(result.decision.title,'等待K线结束确认 · 结构偏空');
  assert.equal(result.decision.biasDirection,'short');assert.match(result.decision.summary,/多空计划均未触发/);
});

test('an earlier long trigger stays in focus when structure is 77 percent bearish and short has not triggered',()=>{
  const long={...fixture(),status:'triggered' as const,statusLabel:'已触发',triggeredAt:bar(1).time,priority:'alternative' as const};
  const short={...mirrorPlan(fixture()),priority:'primary' as const};
  const original=structuredClone([long,short]);
  const {tradePlans,decision}=coordinateTradePlans([long,short],structure(23).bias,bar(5).time);
  assert.equal(decision.state,'tracking');assert.equal(decision.direction,'long');assert.equal(decision.biasDirection,'short');
  assert.equal(decision.title,'多头计划已触发 · 跟踪中');assert.match(decision.summary,/空头计划尚未触发/);
  assert.doesNotMatch(decision.title+decision.summary,/优先做空/);
  assert.equal(tradePlans[0].priority,'primary');assert.equal(tradePlans[1].priority,'alternative');
  tradePlans.forEach((p,i)=>assert.deepEqual({...p,priority:original[i].priority},original[i]));
  assert.deepEqual([long,short],original,'presentation must not mutate the input plans');
});

test('an earlier short trigger stays in focus against bullish or neutral structure',()=>{
  const short={...mirrorPlan(fixture()),status:'triggered' as const,statusLabel:'已触发',triggeredAt:bar(1).time};
  for(const longBias of [77,50]) {
    const result=coordinateTradePlans([fixture(),short],structure(longBias).bias,bar(5).time);
    assert.equal(result.decision.direction,'short');assert.equal(result.decision.state,'tracking');
    assert.equal(result.decision.biasDirection,longBias===77?'long':'neutral');
    assert.match(result.decision.title,/空头计划已触发 · 跟踪中/);assert.match(result.decision.summary,/多头计划尚未触发/);
    assert.equal(result.tradePlans[1].priority,'primary');
  }
});

test('opposite historical triggers retain internal conflict and records without displaying a new direction',()=>{
  const plans=[fixture(),mirrorPlan(fixture())].map(p=>({...p,status:'triggered' as const,statusLabel:'已触发',triggeredAt:bar(1).time}));
  for(const bias of [23,50,77]) {
    const result=coordinateTradePlans(plans,structure(bias).bias,bar(5).time);
    assert.equal(result.decision.state,'conflict');assert.equal(result.decision.direction,'neutral');
    assert.equal(result.decision.title,'暂不提示新方向');
    assert.equal(result.decision.summary,'当前方向不明确，历史计划保留供查看。');
    assert.doesNotMatch(result.decision.title+result.decision.summary,/双向|冲突|做多|做空|多头|空头/);
    assert.ok(result.tradePlans.every(p=>p.status==='triggered'&&p.priority==='balanced'));
    assert.deepEqual(result.tradePlans.map(p=>p.triggeredAt),plans.map(p=>p.triggeredAt));
    assert.deepEqual(result.tradePlans.map((p,i)=>({...p,priority:plans[i].priority})),plans);
  }
});

test('waiting plans remain explicitly untriggered even with a strong structure score',()=>{
  for(const bias of [23,50,77]) {
    const result=coordinateTradePlans([fixture(),mirrorPlan(fixture())],structure(bias).bias,bar(5).time);
    assert.equal(result.decision.state,'waiting');
    if(bias===50) {
      assert.equal(result.decision.title,'暂不提示新方向');
      assert.equal(result.decision.summary,'当前方向不明确，等待后续K线结束形成清晰信号。');
    } else {
      assert.match(result.decision.title,/等待K线结束确认/);assert.match(result.decision.summary,/均未触发/);
      assert.match(result.decision.summary,/本周期K线结束价需越过对应触发价且落在入场区内/);
    }
    assert.doesNotMatch(result.decision.title,/优先|做多|做空|双向均衡/);
    assert.equal(result.decision.direction,bias===23?'short':bias===77?'long':'neutral');
    if(bias===50)assert.ok(result.tradePlans.every(p=>p.priority==='balanced'));
  }
});

test('balanced 41–59 structure scores cannot become directional plan headlines',()=>{
  for(const long of [41,45,50,55,59]) {
    const result=coordinateTradePlans([fixture(),mirrorPlan(fixture())],structure(long).bias,bar(5).time);
    assert.equal(result.decision.biasDirection,'neutral');
    assert.equal(result.decision.direction,'neutral');
    assert.equal(result.decision.title,'暂不提示新方向');
    assert.equal(result.decision.summary,'当前方向不明确，等待后续K线结束形成清晰信号。');
    assert.doesNotMatch(result.decision.title+result.decision.summary,/双向|冲突|做多|做空|多头|空头/);
    assert.ok(result.tradePlans.every(p=>p.status==='untriggered'));
  }
  for(const [long,direction] of [[40,'short'],[60,'long']] as const)
    assert.equal(coordinateTradePlans([fixture(),mirrorPlan(fixture())],structure(long).bias,bar(5).time).decision.biasDirection,direction);
});

test('ended plans cannot create a tracking or entry preference, including one remaining waiting side',()=>{
  const plans=[{...fixture(),status:'invalidated' as const},{...mirrorPlan(fixture()),status:'target_reached' as const}];
  const ended=coordinateTradePlans(plans,structure(77).bias,bar(5).time);
  assert.equal(ended.decision.state,'unavailable');assert.equal(ended.decision.direction,'neutral');
  assert.equal(ended.decision.title,'当前方案已结束');assert.ok(ended.tradePlans.every(p=>p.priority==='balanced'));
  const waiting=coordinateTradePlans([plans[0],mirrorPlan(fixture())],structure(77).bias,bar(5).time);
  assert.equal(waiting.decision.state,'waiting');assert.equal(waiting.decision.direction,'short');assert.equal(waiting.decision.biasDirection,'long');
  assert.match(waiting.decision.title,/等待K线结束确认.*结构偏多/);assert.match(waiting.decision.summary,/空头计划未触发/);
  const tracking=coordinateTradePlans([{...fixture(),status:'triggered',triggeredAt:bar(1).time},plans[1]],structure(23).bias,bar(5).time);
  assert.equal(tracking.decision.state,'tracking');assert.match(tracking.decision.summary,/空头计划已结束/);
});

test('legacy saved plan priorities are recomputed without changing a recorded trigger or frozen prices',()=>{
  const bars=flat(6),s=structure(23);
  const long={...fixture(),priority:'alternative' as const,status:'triggered' as const,statusLabel:'已触发',triggeredAt:bars[1].time,evaluatedThrough:bars[5].time,evaluatedBars:5};
  const short={...mirrorPlan(fixture()),priority:'primary' as const,evaluatedThrough:bars[5].time,evaluatedBars:5};
  const session={version:1 as const,asOf:bars[5].time,close:bars[5].close,plans:[long,short]};
  const result=buildTradePlans(bars,s,()=>s,session);
  assert.equal(result.decision.state,'tracking');assert.equal(result.decision.direction,'long');assert.equal(result.decision.biasDirection,'short');
  assert.equal(result.tradePlans[0].priority,'primary');assert.equal(result.tradePlans[0].triggeredAt,long.triggeredAt);
  assert.deepEqual({...result.tradePlans[0],priority:long.priority},long);
  assert.deepEqual({...result.tradePlans[1],priority:short.priority},short);
  assert.deepEqual(session.plans,[long,short]);
});

test('tracking text follows the latest closed bar when it returns inside the original entry zone',()=>{
  const candles=[bar(0),bar(1,101.5,100.5,102),bar(2,103,102.5,104),bar(3,101.5,100,102)];
  for(const [plan,bars] of [[fixture(),candles],[mirrorPlan(fixture()),mirrorBars(candles)]] as const) {
    const outside=evaluateTradePlan(plan,bars.slice(0,3));
    assert.equal(outside.status,'triggered');assert.match(outside.statusReason,/最近收盘已离开原入场区/);
    const returned=evaluateTradePlan(outside,bars);
    assert.equal(returned.status,'triggered');assert.equal(returned.triggeredAt,outside.triggeredAt);
    assert.match(returned.statusReason,/最近收盘位于原入场区/);assert.doesNotMatch(returned.statusReason,/离开/);
    assert.deepEqual([returned.entryLow,returned.entryHigh,returned.stopLoss,returned.target1,returned.target2],[outside.entryLow,outside.entryHigh,outside.stopLoss,outside.target1,outside.target2]);
  }
});

test('English decisions preserve bias, historical triggers, waiting and conflicting states',()=>{
  const base=analyze(flat(6));
  const activated=(p:TradePlan):TradePlan=>({...p,status:'triggered',statusLabel:'已触发',triggeredAt:bar(1).time});
  const cases=[
    coordinateTradePlans([activated(fixture()),mirrorPlan(fixture())],structure(23).bias,bar(5).time),
    coordinateTradePlans([fixture(),activated(mirrorPlan(fixture()))],structure(77).bias,bar(5).time),
    coordinateTradePlans([activated(fixture()),activated(mirrorPlan(fixture()))],structure(23).bias,bar(5).time),
    coordinateTradePlans([fixture(),mirrorPlan(fixture())],structure(50).bias,bar(5).time),
    coordinateTradePlans([{...fixture(),status:'invalidated'},{...mirrorPlan(fixture()),status:'target_reached'}],structure(23).bias,bar(5).time),
    coordinateTradePlans([],structure(50).bias,bar(5).time),
    coordinateTradePlans([fixture(),mirrorPlan(fixture())],structure(77).bias,bar(5).time),
    coordinateTradePlans([fixture(),mirrorPlan(fixture())],structure(23).bias,bar(5).time),
  ];
  const english=cases.map(result=>translateAnalysis({...base,...result},'en'));
  for(let i=0;i<cases.length;i++) {
    assert.equal(english[i].decision.state,cases[i].decision.state);assert.equal(english[i].decision.direction,cases[i].decision.direction);assert.equal(english[i].decision.biasDirection,cases[i].decision.biasDirection);
    assert.doesNotMatch(english[i].decision.title+english[i].decision.summary,/\p{Script=Han}|preferred/iu);
    assert.deepEqual(english[i].tradePlans.map(p=>[p.status,p.triggeredAt,p.entryLow,p.stopLoss]),cases[i].tradePlans.map(p=>[p.status,p.triggeredAt,p.entryLow,p.stopLoss]));
  }
  assert.match(english[0].decision.title,/Long plan triggered.*tracking/);assert.match(english[0].decision.summary,/short plan has not triggered/);
  assert.match(english[1].decision.title,/Short plan triggered.*tracking/);assert.match(english[1].decision.summary,/long plan has not triggered/);
  assert.equal(english[2].decision.title,'No new direction');
  assert.equal(english[2].decision.summary,'Direction is unclear. Previous plans remain available for review.');
  assert.equal(english[3].decision.title,'No new direction');
  assert.equal(english[3].decision.summary,'Direction is unclear. Wait for later candles to finish and establish a clear signal.');
  for(const index of [0,1])assert.match(english[index].decision.summary,/candle-close conditions/);
  assert.match(english[5].decision.summary,/three valid completed candles/);
  for(const index of [6,7]) {
    assert.match(english[index].decision.title,/Waiting for candle-close confirmation/);
    assert.match(english[index].decision.summary,/candle at the selected interval must finish/);
  }
  for(const index of [2,3])assert.doesNotMatch(english[index].decision.title+english[index].decision.summary,/conflict|two-sided|long|short|buy|sell/i);
  const inside={...activated(fixture()),statusReason:'此前收盘已触发；最近收盘位于原入场区，继续跟踪原止损与目标。'};
  const translated=translateAnalysis({...base,tradePlans:[inside]},'en').tradePlans[0];
  assert.match(translated.statusReason,/latest closed candle is within the original entry band/);
});
