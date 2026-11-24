"use client";

import {useCallback,useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore,type ReactNode,type RefObject} from 'react';
import {drawArmyField,drawArmyUnit,drawArmyFire,ARMY_PROJECTILE_TRAVEL,type ArmySide} from '@/lib/army-painter';
import {battleUnit,battleTier,type BattleTier} from '@/lib/battle-deployment';
import type {BattleTradeEvent} from '@/lib/battle-tape';
import {planReinforcements,planGarrison,planCharge} from '@/lib/battle-formation';

export interface BattleArenaEvent {
  id:string;
  side:ArmySide;
  notional:number;
  heavy:boolean;
  tier?:BattleTier;
}

interface Props {
  buyShare:number|null;bidShare?:number|null;
  events:readonly BattleArenaEvent[];active:boolean;en:boolean;
  fills:Partial<Record<ArmySide,BattleTradeEvent>>;
  charge?:Charge|null;
  onStrike?:(trade:BattleArenaEvent,shotTimes?:readonly number[])=>void;onImpact?:(trade:BattleArenaEvent)=>void;
  onCharge?:(side:ArmySide)=>void;children?:ReactNode;
}
interface Charge {id:string;side:ArmySide;notional:number}
interface Impact {trade:BattleArenaEvent;x:number;y:number}

const motionQuery='(prefers-reduced-motion: reduce)';
function subscribeMotion(change:()=>void){
  const query=window.matchMedia(motionQuery);
  query.addEventListener('change',change);document.addEventListener('visibilitychange',change);
  return ()=>{query.removeEventListener('change',change);document.removeEventListener('visibilitychange',change);};
}
function readMotion(){return document.hidden?'paused':window.matchMedia(motionQuery).matches?'reduced':'full';}
type Motion='full'|'reduced'|'paused';

const lanes=4,companies=4,baseTroops=lanes*(companies*2+1);
const sides=['buy','sell'] as const;
const durations={infantry:1550,grenade:1500,armor:2000,artillery:2330,air:2650};
const cap=(n:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,n));
type InfantryPlan=ReturnType<typeof planReinforcements>;
type Garrison=Record<ArmySide,ReturnType<typeof planGarrison>>;
interface Deployment extends InfantryPlan {trade:BattleArenaEvent;kind:BattleTier;start:number;throwLine?:number;hit?:Impact}
const frontTarget=(share:number|null)=>share===null||!Number.isFinite(share) ? .5 : .28+.44*cap(share,0,100)/100;
function laneFront(front:number,lane:number){return .5+(front-.5)*(.73+.075*lane);}
const horizon=(lane:number)=>.475+.131*lane;
const chargeDuration=4000;
// The standard bearer leads the first rank across the fixed midfield marker.
// Regroup behind the moving front before handing the lane back to its patrol.
function drawCharge(ctx:CanvasRenderingContext2D,w:number,h:number,lane:number,side:ArmySide,phase:number,plan:ReturnType<typeof planCharge>[number]){
  const dir=side==='buy'?1:-1,scale=cap(w/780,.56,1.35)*(.85+.1*lane);
  const p=cap((phase-plan.wait)/.88,0,1);
  const advance=1-(1-p)**2,fade=cap(p*18,0,1)*cap((1-phase)*6,0,1);
  const lead=w*(.5+dir*(-.14+(.14+plan.reach)*advance)),floor=h*(horizon(lane)+.013);
  ctx.save();ctx.globalAlpha=fade;
  const flag=side==='buy'?'#37df87':'#ff6462';
  for(let rank=plan.soldiers.length-1;rank>=0;rank--){
    const man=plan.soldiers[rank],x=lead-dir*man.trail*scale;
    const y=floor+man.depth*h,step=p*man.pace+man.phase;
    ctx.fillStyle='rgba(190,167,120,.30)';
    for(let i=0;i<3;i++){
      const f=(p*5+rank*.29+i/3)%1;
      ctx.beginPath();ctx.ellipse(x-dir*(8+20*f)*scale,y-scale*(1+3*f),scale*(1.5+3*f),scale*(1+1.6*f),0,0,Math.PI*2);ctx.fill();
    }
    drawArmyUnit(ctx,x,y,side,'infantry',scale,step,0);
    if(rank===0&&plan.flag){
      const top=y-36*scale;
      ctx.strokeStyle='#d8c9ad';ctx.lineWidth=1.4*scale;
      ctx.beginPath();ctx.moveTo(x,y-7*scale);ctx.lineTo(x,top);ctx.stroke();
      ctx.fillStyle=flag;ctx.beginPath();ctx.moveTo(x,top);
      ctx.quadraticCurveTo(x-dir*7*scale,top+Math.sin(step)*2*scale,x-dir*18*scale,top+3*scale);
      ctx.lineTo(x-dir*12*scale,top+6*scale);ctx.lineTo(x-dir*17*scale,top+10*scale);
      ctx.lineTo(x,top+8*scale);ctx.closePath();ctx.fill();
    }
  }
  ctx.restore();
}
function formation(ctx:CanvasRenderingContext2D,w:number,h:number,lane:number,front:number,t:number,deployments:readonly Deployment[],now:number,garrison:Garrison) {
  const y=h*horizon(lane),line=laneFront(front,lane);
  const compact=w<=500;
  const size=cap(w/760,compact?.76:.65,1.24)*(.76+lane*.11);
  for(const side of sides){
    const dir=side==='buy'?1:-1,home=dir>0?.083:.917;
    const ownLine=line-dir*(.027+.007*Math.sin(lane*2.4));
    const contacts=deployments.filter(d=>d.lane===lane);
    let flinch=0;
    for(const d of contacts){
      if(d.trade.side===side)continue;
      const p=(now-d.start)/durations[d.kind];
      flinch=Math.max(flinch,Math.max(0,1-Math.abs(p-.68)*5));
    }
    const span=ownLine-home,group=garrison[side][lane];
    drawArmyUnit(ctx,w*(home+span*group.vehicle),y,side,group.artillery?'artillery':'armor',size*.88,t+lane,0);
    for(const man of group.soldiers){
      const march=t*man.pace+man.stride;
      const travel=Math.sin(march*(man.patrol?.67:.38))*(man.patrol?.084:.019);
      const recoil=man.post>.74?flinch*.018:0;
      const x=w*(home+span*(man.post+travel)-dir*recoil);
      const yy=y+h*man.depth+Math.sin(march*.76)*size*1.7;
      drawArmyUnit(ctx,x,yy,side,'infantry',size*man.scale,march*(man.patrol?4.8:2.1),0);
    }
  }
}

function deployed(ctx:CanvasRenderingContext2D,w:number,h:number,front:number,time:number,a:Deployment,now:number,onImpact:(hit:Impact)=>void){
  const p=cap((now-a.start)/durations[a.kind],0,1),side=a.trade.side,dir=side==='buy'?1:-1;
  const liveLine=laneFront(front,a.lane),y=h*horizon(a.lane);
  if(a.kind==='grenade'&&p>=.24)a.throwLine??=liveLine;
  const line=a.throwLine??liveLine;
  const size=cap(w/715,.56,1.34)*(.85+.09*a.lane);
  const march=1-(1-Math.min(1,p/.46))**2;
  const near=line-dir*.022;
  const projectile=a.kind==='grenade'?(p-.24)/.72:a.kind==='air'?(p-.40)/.55:(p-.27)/.64;
  if(a.kind!=='infantry'&&!a.hit&&projectile>=ARMY_PROJECTILE_TRAVEL[a.kind]){
    a.hit={trade:a.trade,x:line+dir*.06,y:(y-(a.kind==='air'?0:size*4))/h};
    onImpact(a.hit);
  }
  const target=w*(a.hit?.x??line+dir*.06);
  const impactY=a.hit?h*a.hit.y:y-(a.kind==='air'?0:size*4);
  const alpha=cap(p*13,0,1)*cap((1-p)*6,0,1);
  ctx.save();ctx.globalAlpha=alpha;
  if(a.kind==='infantry'){
    for(const man of a.soldiers){
      const local=p-man.wait;
      if(local<0)continue;
      const step=cap(local/man.pace,0,1),progress=1-(1-step)**2;
      const x=w*(near-dir*(man.spacing+man.approach*(1-progress)));
      const yy=y+h*(.02+man.depth+man.curve*Math.sin(step*Math.PI));
      const fire=(local-man.fire)/.53;
      drawArmyUnit(ctx,x,yy,side,'infantry',size*man.scale,time*(11*man.scale)+man.phase,fire>=0&&fire<.32?1:0);
      drawArmyFire(ctx,x+dir*size*10,yy-size*13,target+dir*size*man.spacing*60,y-size*8+man.depth*h,side,a.kind,fire,size,man.second);
    }
  }else if(a.kind==='grenade'){
    const throwerScale=Math.max(.8,size),approach=cap(1-p/.18,0,1);
    const x=w*(line-dir*(.072+.065*approach)),foot=y+h*.02;
    const pose=cap((p-.13)/.11,0,1);
    drawArmyUnit(ctx,x,foot,side,'grenade',throwerScale,0,pose);
    drawArmyFire(ctx,x+dir*11*throwerScale,foot-27*throwerScale,target,impactY,side,'grenade',projectile,throwerScale);
  }else if(a.kind==='air'){
    const along=dir>0?p:1-p;
    const planeX=w*(-.13+1.26*along),planeY=h*(.17+.07*Math.sin(Math.PI*p));
    drawArmyUnit(ctx,planeX,planeY,side,'air',size*1.18,time,0);
    const releaseX=w*(side==='buy'?.40:.60);
    drawArmyFire(ctx,releaseX,h*.22,target,impactY,side,'air',projectile,size*1.25);
  }else{
    const armored=a.kind==='armor';
    const home=dir>0?.095:.905;
    const x=w*(home+(line-home)*((armored?.39:.12)+(armored?.24:.09)*march));
    drawArmyUnit(ctx,x,y+h*.035,side,a.kind,size*1.12,time*5,p>.28&&p<.5?1:0);
    drawArmyFire(ctx,x+dir*size*22,y+h*.035-size*19,target,impactY,side,a.kind,projectile,size*1.2);
  }
  ctx.restore();
}

function ArmyField({events,buyShare,mode,en,onStrike,onImpact,onCharge,charge,seen,consumeCharge,children,bidShare,fills}:Props&{mode:Motion;seen:RefObject<Set<string>>;consumeCharge:(id:string)=>boolean}){
  const holder=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null);
  const [impacts,setImpacts]=useState<Impact[]>([]);
  const [banner,setBanner]=useState<Charge|null>(null);
  const rush=useRef<{side:ArmySide;start:number;lanes:ReturnType<typeof planCharge>}|null>(null);
  const scenario=useRef(0);
  const rushTimer=useRef<number|undefined>(undefined);
  const receive=useRef<((items:readonly BattleArenaEvent[])=>void)|null>(null);
  const renderStatic=useRef<(()=>void)|null>(null);
  const desired=useRef(frontTarget(buyShare)),sound=useRef({onStrike,onImpact,onCharge});
  useLayoutEffect(()=>{sound.current={onStrike,onImpact,onCharge};},[onStrike,onImpact,onCharge]);
  useEffect(()=>{
    if(!charge||mode==='paused')return;
    const frame=requestAnimationFrame(now=>{
      if(document.hidden||!consumeCharge(charge.id))return;
      rush.current={side:charge.side,start:now,lanes:planCharge(scenario.current,charge.id,(canvas.current?.clientWidth??0)<=500)};setBanner(charge);
      sound.current.onCharge?.(charge.side);
      clearTimeout(rushTimer.current);
      rushTimer.current=window.setTimeout(()=>{setBanner(null);rush.current=null;},chargeDuration);
    });
    return ()=>cancelAnimationFrame(frame);
  },[charge,mode,consumeCharge]);
  useEffect(()=>()=>window.clearTimeout(rushTimer.current),[]);
  useLayoutEffect(()=>{desired.current=frontTarget(buyShare);renderStatic.current?.();},[buyShare]);
  useLayoutEffect(()=>{
    const stage=holder.current,field=canvas.current,ctx=field?.getContext('2d',{alpha:false});
    if(!stage||!field||!ctx)return;
    const seed=crypto.getRandomValues(new Uint32Array(1))[0];
    scenario.current=seed;
    const garrison=(compact:boolean):Garrison=>({buy:planGarrison(seed,'buy',compact),sell:planGarrison(seed,'sell',compact)});
    const wide=garrison(false),narrow=garrison(true);
    let w=0,h=0,front=desired.current,t=0,previous=0,raf=0,lastDispatch=-Infinity,sequence=0;
    let active:Deployment[]=[],queue:BattleArenaEvent[]=[];
    const labels=new Map<string,number>();
    const hit=(impact:Impact)=>{
      sound.current.onImpact?.(impact.trade);
      setImpacts(old=>[...old,impact].slice(-4));
      if(labels.size>=4){
        const oldest=labels.keys().next().value;
        if(oldest!==undefined){clearTimeout(labels.get(oldest));labels.delete(oldest);}
      }
      labels.set(impact.trade.id,window.setTimeout(()=>{
        labels.delete(impact.trade.id);setImpacts(old=>old.filter(item=>item.trade.id!==impact.trade.id));
      },1550));
    };
    const render=(now:number)=>{
      if(w<=0||h<=0)return;
      if(mode==='full'){
        const delta=previous?cap(now-previous,0,100)/1000:0;
        t+=delta;front+=(desired.current-front)*(1-Math.exp(-delta*2.9));
      }else front=desired.current;
      previous=now;
      active=active.filter(d=>now-d.start<durations[d.kind]);
      if(mode==='full'&&queue.length&&now-lastDispatch>=160){
        const trade=queue.shift()!;
        const kind=trade.tier??battleTier(trade.notional);
        const plan=planReinforcements(seed,trade.id,kind,w<=500);
        active.push({trade,kind,start:now,...plan});
        sequence++;lastDispatch=now;
        stage.dataset.battleDeployments=String(sequence);stage.dataset.battleEvent=trade.id;
        stage.dataset.battleSide=trade.side;stage.dataset.battleTier=kind;
        stage.dataset.battleLane=String(plan.lane);stage.dataset.battleSquadSize=String(plan.soldiers.length);
        if(kind!=='infantry')stage.dataset.battleHeavy='true';else delete stage.dataset.battleHeavy;
        const shots=kind==='infantry'?plan.soldiers.flatMap(man=>{
          const first=man.wait+man.fire;
          return (man.second===null?[first]:[first,first+man.second*.53]).map(p=>p*durations.infantry/1000);
        }).sort((a,b)=>a-b):undefined;
        sound.current.onStrike?.(trade,shots);
      }
      if(!active.length&&stage.dataset.battleEvent){
        delete stage.dataset.battleEvent;delete stage.dataset.battleSide;
        delete stage.dataset.battleTier;delete stage.dataset.battleHeavy;
      }
      if(Number(stage.dataset.battleActiveAttacks)!==active.length)stage.dataset.battleActiveAttacks=String(active.length);
      ctx.imageSmoothingEnabled=true;
      drawArmyField(ctx,w,h,t,front);
      const charging=rush.current;
      if(charging){
        ctx.save();ctx.strokeStyle='#fff3ca99';ctx.lineWidth=1.5;
        ctx.setLineDash([4,8]);ctx.beginPath();ctx.moveTo(w*.5,h*.34);ctx.lineTo(w*.5,h*.94);
        ctx.stroke();ctx.restore();
      }
      for(let lane=0;lane<lanes;lane++){
        formation(ctx,w,h,lane,front,t,active,now,w<=500?narrow:wide);
        if(mode==='full'&&charging&&now>=charging.start&&now-charging.start<chargeDuration)
          drawCharge(ctx,w,h,lane,charging.side,(now-charging.start)/chargeDuration,charging.lanes[lane]);
        for(const a of active)if(a.lane===lane&&a.kind!=='air')deployed(ctx,w,h,front,t,a,now,hit);
      }
      for(const a of active)if(a.kind==='air')deployed(ctx,w,h,front,t,a,now,hit);
    };
    function resize(){
      if(!field||!ctx)return;
      const rect=field.getBoundingClientRect();
      w=Math.round(rect.width);h=Math.round(rect.height);
      if(w<=0||h<=0)return;
      const troops=String(w<=500?lanes*3:baseTroops);
      if(stage){stage.dataset.battleBuyUnits=troops;stage.dataset.battleSellUnits=troops;}
      const ratio=Math.min(window.devicePixelRatio||1,2);
      field.width=Math.round(w*ratio);field.height=Math.round(h*ratio);
      ctx.setTransform(field.width/w,0,0,field.height/h,0,0);render(performance.now());
    }
    function tick(now:number){
      if(document.hidden)return;
      if(now-previous>=1000/30)render(now);
      raf=requestAnimationFrame(tick);
    }
    receive.current=items=>{
      const fresh:BattleArenaEvent[]=[];
      for(const trade of items){
        if(seen.current.has(trade.id))continue;
        seen.current.add(trade.id);
        if(mode!=='paused')fresh.push(trade);
      }
      if(seen.current.size>2400)seen.current=new Set(Array.from(seen.current).slice(-1200));
      if(!fresh.length)return;
      if(mode==='reduced'){
        const highlighted=fresh.reduce((best,x)=>x.notional>best.notional?x:best);
        if((highlighted.tier??battleTier(highlighted.notional))==='infantry')sound.current.onStrike?.(highlighted);
        else hit({trade:highlighted,x:desired.current,y:horizon(planReinforcements(seed,highlighted.id,highlighted.tier??battleTier(highlighted.notional),w<=500).lane)});
        return;
      }
      // Keep cannon fire ahead of ordinary reinforcements and group only the
      // smaller fills on each side. Queue length bounds visual time lag.
      const pending=queue.concat(fresh);
      const shells=pending.filter(v=>v.heavy).sort((a,b)=>b.notional-a.notional).slice(0,6);
      const foot=pending.filter(v=>!v.heavy);
      const infantry=sides.map(side=>foot.findLast(v=>v.side===side)).filter(v=>v!==undefined);
      queue=[...shells,...infantry];
    };
    if(mode!=='full')renderStatic.current=()=>render(performance.now());
    const observer=new ResizeObserver(resize);observer.observe(field);resize();
    if(mode==='full')raf=requestAnimationFrame(tick);
    return ()=>{cancelAnimationFrame(raf);observer.disconnect();for(const timer of labels.values())clearTimeout(timer);receive.current=null;renderStatic.current=null;};
  },[mode,seen]);
  useEffect(()=>{receive.current?.(events);},[events]);
  const guard=(side:ArmySide)=>{
    if(bidShare===undefined||bidShare===null||!Number.isFinite(bidShare))return null;
    const n=cap(side==='buy'?bidShare:100-bidShare,0,100);
    const label=(en?(side==='buy'?'Near-price bid depth ':'Near-price ask depth '):(side==='buy'?'近价买盘挂单占比 ':'近价卖盘挂单占比 '))+n.toFixed(1)+'%';
    return <span className="army-defense" role="img" title={label} aria-label={label}><i style={{width:n+'%'}}/></span>;
  };
  return <div ref={holder} className="army-stage" data-battle-arena="" data-battle-motion={mode}
    data-battle-lanes={lanes} data-battle-buy-units={baseTroops} data-battle-sell-units={baseTroops}
    data-battle-deployments="0" data-battle-active-attacks="0">
    <canvas data-battle-field="" ref={canvas} role="img" aria-label={en?'Green buyers and red sellers on a four-lane battlefield':'多方绿军与空方红军在四条战线交锋'}/>
    {impacts.map(({trade,x,y})=><span key={trade.id} className="army-impact" data-battle-impact={trade.id} data-notional={trade.notional} data-side={trade.side}
      style={{left:x*100+'%',top:y*100+'%'}}>{trade.notional.toLocaleString(en?'en-US':'zh-CN',{maximumFractionDigits:2})} <small>USDT</small></span>)}
    {banner&&<div role="status" className="army-charge" data-battle-charge={banner.id} data-side={banner.side}>
      <b>{banner.side==='buy'?(en?'Buyers charge':'多军冲锋'):(en?'Sellers charge':'空军冲锋')}</b>
      <span>{en?'Net flow':'净主动成交'} {banner.notional.toLocaleString(en?'en-US':'zh-CN',{maximumFractionDigits:0})} USDT</span></div>}
    <div className="army-hud"><div className="army-name army-green"><i aria-hidden="true"/>{en?'Green · Buyers':'绿军 · 多方'}{guard('buy')}</div>
      {children}<div className="army-name army-red">{guard('sell')}{en?'Sellers · Red':'空方 · 红军'}<i aria-hidden="true"/></div></div>
    <div className="army-readouts">{sides.map(side=>{
      const print=fills[side];
      const unit=print&&battleUnit(print.notional);
      const label=side==='buy'?(en?'Buy':'多军买入'):(en?'Sell':'空军卖出');
      return <div key={side} className="army-readout" data-side={side} data-trade-id={print?.id}
        title={print?new Date(print.time*1000).toLocaleTimeString(en?'en-US':'zh-CN',{hour12:false}):undefined}>
        <span>{label}{unit&&<> · {en?unit.en:unit.zh}</>}</span>
        <strong>{print?print.notional.toLocaleString(en?'en-US':'zh-CN',{maximumFractionDigits:2})+' USDT':'—'}</strong>
      </div>;
    })}</div>
  </div>;
}

export function BattleArena(props:Props){
  const motion=useSyncExternalStore(subscribeMotion,readMotion,()=>'paused' as const);
  const mode=props.active?motion:'paused',seen=useRef(new Set<string>()),lastCharge=useRef<string|null>(null);
  const consumeCharge=useCallback((id:string)=>{
    if(lastCharge.current===id)return false;
    lastCharge.current=id;return true;
  },[]);
  return <ArmyField key={mode} {...props} mode={mode} seen={seen} consumeCharge={consumeCharge}/>;
}

export default BattleArena;
