import type { Interval, Market, TradePlan, TradePlanSession } from './market-types';

type SessionIdentity={market:Market;symbol:string;interval:Interval;source:string;penMode:'new'|'old'};
type StorageLike=Pick<Storage,'getItem'|'setItem'>;
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function validPlan(v:unknown,asOf:number):v is TradePlan {
  if(!record(v)||!record(v.anchor))return false;
  if(!['long','short'].includes(String(v.side))||!['untriggered','triggered','invalidated','target_reached'].includes(String(v.status)))return false;
  if(!['primary','alternative','balanced'].includes(String(v.priority)))return false;
  if(!['id','label','strategy','statusLabel','basis','trigger','invalidation','statusReason'].every(k=>typeof v[k]==='string'))return false;
  if(!['entryLow','entryHigh','triggerPrice','stopLoss','target1','target2','rr1','rr2','generatedAt'].every(k=>positive(v[k])))return false;
  if(typeof v.atr!=='number'||!Number.isFinite(v.atr)||v.atr<0)return false;
  if(!Number.isInteger(v.generatedIndex)||!Number.isInteger(v.anchor.index)||!positive(v.anchor.time)||!positive(v.anchor.price))return false;
  if(v.evaluatedThrough!==asOf||!Number.isInteger(v.evaluatedBars)||(v.evaluatedBars as number)<0||(v.generatedAt as number)>asOf)return false;
  if(v.triggeredAt!==undefined&&(!positive(v.triggeredAt)||v.triggeredAt>asOf))return false;
  if(v.statusAt!==undefined&&(!positive(v.statusAt)||v.statusAt>asOf))return false;
  if(v.status==='triggered'&&!positive(v.triggeredAt))return false;
  const p=v as unknown as TradePlan;
  if(p.entryLow>p.triggerPrice||p.triggerPrice>p.entryHigh)return false;
  if(p.previousOutcome&&(!['invalidated','target_reached'].includes(p.previousOutcome.status)||!positive(p.previousOutcome.statusAt)||typeof p.previousOutcome.reason!=='string'))return false;
  return p.side==='long'?p.stopLoss<p.entryLow&&p.entryHigh<p.target1&&p.target1<p.target2:p.stopLoss>p.entryHigh&&p.entryLow>p.target1&&p.target1>p.target2;
}
export function planSessionKey(identity:SessionIdentity):string {
  return `trend-plan-session-v1:${[identity.market,identity.symbol,identity.interval,identity.source,identity.penMode].map(encodeURIComponent).join(':')}`;
}
function browserStorage():StorageLike|undefined {
  try{return typeof window==='undefined'?undefined:window.localStorage;}catch{return undefined;}
}
export function readPlanSession(key:string,storage:StorageLike|undefined=browserStorage()):TradePlanSession|undefined {
  try {
    const raw=storage?.getItem(key);if(!raw)return;
    const value:unknown=JSON.parse(raw);
    if(!record(value)||value.version!==1||!positive(value.asOf)||!positive(value.close)||!Array.isArray(value.plans)||value.plans.length!==2)return;
    if(!value.plans.every(p=>validPlan(p,value.asOf as number))||new Set(value.plans.map(p=>p.side)).size!==2)return;
    return value as unknown as TradePlanSession;
  }catch{return undefined;}
}
export function writePlanSession(key:string,session:TradePlanSession|undefined,storage:StorageLike|undefined=browserStorage()):void {
  if(!session)return;
  try{storage?.setItem(key,JSON.stringify(session));}catch{/* Private/quota-limited storage must not prevent chart use. */}
}
