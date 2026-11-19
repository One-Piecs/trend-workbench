import type { Candle, Center, Fractal, Point, StructureLine, TradeDecision, TradePlan, TradePlanSession, TradePlanStatus } from './market-types';

type Bar=Candle&{index:number};
export interface PlanStructure {fractals:Fractal[];strokes:StructureLine[];centers:Center[];bias:{long:number;short:number;label:string}}
type Level=Point&{source:string};
const fmt=(n:number)=>n.toLocaleString('en-US',{maximumFractionDigits:Math.min(12,Math.max(2,5-Math.floor(Math.log10(Math.abs(n)||1))))});
const labels:Record<TradePlanStatus,string>={untriggered:'未触发',triggered:'已触发',invalidated:'已失效',target_reached:'目标已到'};
const terminal=(s:TradePlanStatus)=>s==='invalidated'||s==='target_reached';
function atr14(bars:Bar[]) {
  const start=Math.max(0,bars.length-14);
  return bars.slice(start).reduce((sum,b,i)=>{
    const previous=bars[start+i-1]?.close??b.open;
    return sum+Math.max(b.high-b.low,Math.abs(b.high-previous),Math.abs(b.low-previous));
  },0)/Math.min(14,bars.length);
}
function freshPlan(bars:Bar[],structure:PlanStructure,side:'long'|'short'):TradePlan {
  const last=bars.at(-1)!,price=last.close,measuredAtr=atr14(bars);
  // A bounded execution buffer keeps severe gap/monthly extremes from creating
  // negative short targets. The raw ATR is retained and the cap is disclosed.
  const vol=Math.max(price*.002,Math.min(measuredAtr,price*.1));
  const levels:Level[]=[];
  for(const f of structure.fractals)if(f.confirmedAt<=last.index&&f.index>=last.index-24)levels.push({...f,source:f.type==='top'?'最近确认顶分型':'最近确认底分型'});
  for(const p of structure.strokes.filter(s=>s.confirmed&&s.confirmedAt<=last.index).flatMap(s=>[s.from,s.to]))if(p.index>=last.index-24)levels.push({...p,source:'最近确认笔端'});
  const center=structure.centers.at(-1);
  if(center&&center.endIndex>=last.index-24)for(const value of [center.low,center.high]) {
    const p=levels.find(l=>l.price===value);if(p)levels.push({...p,source:value===center.low?'近端中枢下沿':'近端中枢上沿'});
  }
  const highs=levels.filter(p=>p.price>=price+vol*.15&&p.price<=price+vol*2).sort((a,b)=>a.price-b.price||b.index-a.index);
  const lows=levels.filter(p=>p.price<=price-vol*.15&&p.price>=price-vol*2).sort((a,b)=>b.price-a.price||b.index-a.index);
  const buy=side==='long',chosen=buy?highs[0]:lows[0];
  const recent=bars.slice(-8),extreme=recent.reduce((a,b)=>buy?(b.high<a.high?b:a):(b.low>a.low?b:a));
  const fallback=buy?Math.min(Math.max(price+vol*.65,extreme.high),price+vol*1.2):Math.max(Math.min(price-vol*.65,extreme.low),price-vol*1.2);
  const boundary=chosen?.price??fallback;
  const triggerPrice=boundary+(buy?1:-1)*vol*.1;
  const entryLow=buy?triggerPrice:triggerPrice-vol*.25,entryHigh=buy?triggerPrice+vol*.25:triggerPrice;
  const opposite=buy?lows[0]:highs[0];
  const oppositeBoundary=opposite?.price??(buy?Math.min(...recent.map(b=>b.low)):Math.max(...recent.map(b=>b.high)));
  const candidateStop=oppositeBoundary+(buy?-1:1)*vol*.15;
  const stopLoss=buy?Math.max(entryLow-vol*2,Math.min(entryLow-vol*.8,candidateStop)):Math.min(entryLow*1.3,Math.min(entryHigh+vol*2,Math.max(entryHigh+vol*.8,candidateStop)));
  const risk=buy?entryHigh-stopLoss:stopLoss-entryLow;
  const target1=buy?entryHigh+risk*1.5:entryLow-risk*1.5,target2=buy?entryHigh+risk*2.5:entryLow-risk*2.5;
  const anchor:Point=chosen?{index:chosen.index,time:chosen.time,price:chosen.price}:{index:last.index,time:last.time,price};
  const oldCenter=center&&(Math.abs(price-center.low)>vol*3&&Math.abs(price-center.high)>vol*3);
  const source=chosen?`${chosen.source} ${fmt(boundary)}`:`近端结构不在有效价格带，采用最近8根已收盘价格与波动推导边界 ${fmt(boundary)}`;
  return {
    id:`${side}-${last.time}-${triggerPrice.toPrecision(10)}`,side,label:buy?'做多计划':'做空计划',strategy:buy?'近端结构突破':'近端结构跌破',priority:'balanced',status:'untriggered',statusLabel:labels.untriggered,
    entryLow,entryHigh,triggerPrice,stopLoss,target1,target2,rr1:(buy?target1-entryHigh:entryLow-target1)/risk,rr2:(buy?target2-entryHigh:entryLow-target2)/risk,anchor,generatedAt:last.time,generatedIndex:last.index,evaluatedThrough:last.time,evaluatedBars:0,atr:measuredAtr,
    trigger:`后续已收盘K线${buy?'从下向上越过':'从上向下越过'} ${fmt(triggerPrice)}，且收盘在 ${fmt(entryLow)}–${fmt(entryHigh)} 入场区内；收盘越过入场区则跳过，不追价。`,
    invalidation:`${buy?'低点触及或跌破':'高点触及或突破'}止损 ${fmt(stopLoss)} 即失效；生成后12根已收盘K线仍未触发则到期。同根触发与止损/目标同时出现时按顺序不明失效。`,
    basis:`${source}。${oldCenter?'旧中枢距现价较远，仅作方向背景。':''}结合已确认笔/分型/中枢方向制定多空方案；ATR14=${fmt(measuredAtr)}，执行缓冲基准=${fmt(vol)}（价格0.2%至10%范围），入场带宽0.25倍缓冲。止损取近端反向结构并约束风险距离；T1/T2为保守入场端的1.5R/2.5R投影。上述交易映射是本工具策略规则，不是原典已验证的固定目标或盈利概率。`,
    statusReason:'尚无生成时点之后的已收盘K线满足入场条件。'
  };
}

/** Evaluate a frozen plan only after it existed. Status is a model event, not a fill. */
export function evaluateTradePlan(input:TradePlan,candles:Bar[]):TradePlan {
  const plan={...input},buy=plan.side==='long';
  let previous:Bar|undefined;let after=plan.evaluatedBars??0;
  const through=Math.max(plan.generatedAt,plan.evaluatedThrough??plan.generatedAt);
  const set=(status:TradePlanStatus,b:Bar,reason:string)=>{plan.status=status;plan.statusLabel=labels[status];plan.statusAt=b.time;plan.statusReason=reason;};
  for(const b of candles) {
    if(b.closed===false)continue;
    // Timestamps remain stable when a provider's rolling window drops old bars.
    if(b.time<=through){previous=b;continue;}
    if(terminal(plan.status))break;
    after++;plan.evaluatedBars=after;plan.evaluatedThrough=b.time;
    const stopped=buy?b.low<=plan.stopLoss:b.high>=plan.stopLoss;
    const t1=buy?b.high>=plan.target1:b.low<=plan.target1,t2=buy?b.high>=plan.target2:b.low<=plan.target2;
    if(plan.status==='triggered') {
      if(stopped)set('invalidated',b,t1?'同根K线同时覆盖止损与目标，无法确定先后；按失效处理，不记作盈利。':'已收盘K线覆盖止损价，模型计划失效。');
      else if(t2)set('target_reached',b,'已收盘K线覆盖第二目标；这是价格事件，不代表实际成交或收益。');
      else if(t1)plan.statusReason='已触发，第一目标价格已覆盖；剩余方案仍按原止损与第二目标跟踪。';
      else if(b.close<plan.entryLow||b.close>plan.entryHigh)plan.statusReason='此前收盘已触发；最近收盘已离开原入场区，继续跟踪原止损与目标。';
      else plan.statusReason='此前收盘已触发；最近收盘位于原入场区，继续跟踪原止损与目标。';
      previous=b;continue;
    }
    const crossed=previous&&(buy?previous.close<plan.triggerPrice&&b.close>=plan.triggerPrice:previous.close>plan.triggerPrice&&b.close<=plan.triggerPrice);
    const inside=b.close>=plan.entryLow&&b.close<=plan.entryHigh;
    if(stopped)set('invalidated',b,crossed?'同根K线同时出现触发与止损，顺序不明；跳过该计划。':'入场前参考结构已被止损边界破坏，计划失效。');
    else if(crossed&&!inside)set('invalidated',b,'收盘跳过参考入场区，已放弃该次追价计划。');
    else if(t1||t2)set('invalidated',b,crossed?'触发收盘形成前，同根K线已覆盖目标，无法确定顺序；跳过该计划。':'入场触发前目标价格已经覆盖，原计划已错过；不再按原入场区提示进入。');
    else if(crossed&&inside) {plan.triggeredAt=b.time;set('triggered',b,'已收盘K线满足突破及入场区规则；仅表示模型触发，不代表实盘成交。');}
    else if(after>=12)set('invalidated',b,'生成后12根已收盘K线未触发，计划到期。');
    previous=b;
  }
  return plan;
}

/** Separate structural bias from the lifetime of existing model plans.
 * Ordering is for display: old triggers survive a bias change and an opposite
 * untriggered plan must never be presented as an immediate entry instruction. */
export function coordinateTradePlans(plans:TradePlan[],bias:PlanStructure['bias'],asOf:number):{tradePlans:TradePlan[];decision:TradeDecision} {
  // Match the structure card's 60/40 band; a 45/55 balanced score must not
  // become a bearish headline merely because it appears in the plan panel.
  const biasDirection=bias.long>=60?'long':bias.short>=60?'short':'neutral';
  const structureLabel=biasDirection==='long'?'结构偏多':biasDirection==='short'?'结构偏空':'结构无明显偏向';
  const active=plans.filter(p=>!terminal(p.status)),triggered=active.filter(p=>p.status==='triggered');
  const name=(side:'long'|'short')=>side==='long'?'多头计划':'空头计划';
  let direction:TradeDecision['direction']='neutral',state:TradeDecision['state'],title:string,summary:string;
  if(!active.length) {
    state='unavailable';
    title=plans.length?'当前方案已结束':'历史不足';
    summary=plans.length?'当前没有仍在等待或跟踪的计划，需由后续已完成K线建立新方案。':'至少需要3根有效已完成K线建立结构交易计划。';
  } else if(triggered.length>1) {
    state='conflict';
    title='暂不提示新方向';
    summary='当前方向不明确，历史计划保留供查看。';
  } else if(triggered.length===1) {
    state='tracking';direction=triggered[0].side;
    const opposite=plans.find(p=>p.side!==direction);
    title=`${name(direction)}已触发 · 跟踪中`;
    summary=`${name(direction)}此前已触发，继续跟踪原止损与目标。${opposite?.status==='untriggered'?`${name(opposite.side)}尚未触发，等待其K线结束条件。`:opposite?`${name(opposite.side)}已结束，暂无新的反向触发。`:''}`;
  } else {
    state='waiting';
    direction=biasDirection!=='neutral'&&active.some(p=>p.side===biasDirection)?biasDirection:active.length===1?active[0].side:'neutral';
    title=direction==='neutral'?'暂不提示新方向':`等待K线结束确认 · ${structureLabel}`;
    summary=direction==='neutral'?'当前方向不明确，等待后续K线结束形成清晰信号。':`${active.length===2?'多空计划均':name(active[0].side)}未触发；本周期K线结束价需越过对应触发价且落在入场区内，才更新为已触发。`;
  }
  const tradePlans=plans.map(p=>({...p,priority:(direction==='neutral'?'balanced':p.side===direction?'primary':'alternative') as TradePlan['priority']}));
  return {tradePlans,decision:{direction,biasDirection,state,title,summary,asOf}};
}

export function buildTradePlans(bars:Bar[],current:PlanStructure,snapshot:(prefix:Bar[])=>PlanStructure,session?:TradePlanSession):{tradePlans:TradePlan[];decision:TradeDecision;planSession?:TradePlanSession} {
  const last=bars.at(-1);
  if(!last||bars.length<3)return coordinateTradePlans([],current.bias,last?.time||0);
  // A replay always starts at the same historical prefix. Choosing a recent
  // fractal or the penultimate bar here silently moved an existing plan every
  // time another candle closed, including plans that had already triggered.
  const initialPosition=2;
  const snapshots=new Map<number,PlanStructure>();
  const timePositions=new Map(bars.map((b,i)=>[b.time,i]));
  const sessionPosition=session?timePositions.get(session.asOf):undefined;
  // A matching last processed close is required to bridge saved state to the
  // current history. Replays before that close and history gaps start afresh.
  const resume=!!session&&session.version===1&&sessionPosition!==undefined&&bars[sessionPosition].close===session.close&&session.plans.length===2;
  const atPosition=(position:number,prefix:Bar[])=>{
    let value=snapshots.get(position);
    if(!value){value=snapshot(prefix);snapshots.set(position,value);}
    return value;
  };
  const make=(side:'long'|'short')=>{
    let position=initialPosition,previousOutcome:TradePlan['previousOutcome'];
    let evaluated:TradePlan;
    const saved=resume?session!.plans.find(p=>p.side===side):undefined;
    if(saved) {
      const generatedPosition=timePositions.get(saved.generatedAt),anchorPosition=timePositions.get(saved.anchor.time);
      const remapped={...saved,generatedIndex:generatedPosition===undefined?-1:bars[generatedPosition].index,anchor:{...saved.anchor,index:anchorPosition===undefined?-1:bars[anchorPosition].index}};
      evaluated=evaluateTradePlan(remapped,bars.slice(sessionPosition));
      if(!terminal(evaluated.status))return evaluated;
      previousOutcome={status:evaluated.status as 'invalidated'|'target_reached',statusAt:evaluated.statusAt!,reason:evaluated.statusReason};
      position=timePositions.get(evaluated.statusAt!)??initialPosition;
    }
    do {
      const prefix=bars.slice(0,position+1);
      // Consecutive plans scan disjoint later bars (plus their creation bar),
      // rather than repeatedly evaluating the complete history from its start.
      evaluated=evaluateTradePlan(freshPlan(prefix,atPosition(position,prefix),side),bars.slice(position));
      if(previousOutcome)evaluated.previousOutcome=previousOutcome;
      if(!terminal(evaluated.status))break;
      previousOutcome={status:evaluated.status as 'invalidated'|'target_reached',statusAt:evaluated.statusAt!,reason:evaluated.statusReason};
      const at=timePositions.get(evaluated.statusAt!)??-1;
      // The terminal bar is now closed and can create a new snapshot immediately.
      // evaluateTradePlan excludes its creation bar, so its earlier OHLC cannot
      // trigger or terminate the replacement. Every renewal advances in time.
      if(at<=position)break;
      position=at;
    }while(position<bars.length);
    return evaluated!;
  };
  const {tradePlans,decision}=coordinateTradePlans([make('long'),make('short')],current.bias,last.time);
  return {tradePlans,decision,planSession:{version:1,asOf:last.time,close:last.close,plans:tradePlans}};
}
