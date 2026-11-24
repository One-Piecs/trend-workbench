import type {BattleTier} from './battle-deployment';

// Draw a formation once when a trade arrives; motion interpolates those same
// coordinates every frame, including after changes in canvas resolution.
function randomSequence(session:number,tag:string){
  let state=session>>>0;
  for(let i=0;i<tag.length;i++)state=Math.imul(state^tag.charCodeAt(i),16777619)>>>0;
  return ()=>{
    state=(state+0x6d2b79f5)>>>0;
    let x=Math.imul(state^(state>>>15),state|1);
    x^=x+Math.imul(x^(x>>>7),x|61);
    return ((x^(x>>>14))>>>0)/4294967296;
  };
}
const lanes=4;
function shuffled<T>(values:T[],random:()=>number){
  for(let i=values.length-1;i>0;i--){
    const j=Math.floor(random()*(i+1));
    [values[i],values[j]]=[values[j],values[i]];
  }
  return values;
}

export function planReinforcements(session:number,id:string,tier:BattleTier,compact:boolean){
  const next=randomSequence(session,id);
  const lane=Math.floor(next()*lanes),count=tier==='infantry'?1+Math.floor(next()*(compact?3:5)):1;
  const flank=next()<.5?-1:1;
  const soldiers=Array.from({length:count},(_,i)=>({
    wait:i===0?0:.025+next()*.14,approach:.11+next()*.17,
    spacing:i*.010+next()*.026,depth:(next()-.5)*.044,
    curve:(.012+next()*.037)*flank*(i%2?-.65:1),
    pace:.37+next()*.23,phase:next()*Math.PI*2,scale:.86+next()*.19,
    fire:.255+next()*.075,second:next()<.67?.14+next()*.18:null,
  }));
  return {lane,soldiers};
}

export function planGarrison(session:number,side:'buy'|'sell',compact:boolean){
  const next=randomSequence(session,'garrison/'+side);
  // Same overall footprint, different concentrations along each lane.
  const counts=shuffled(compact?[1,2,2,3]:[6,7,9,10],next);
  return counts.map(count=>{
    const vehicle=.045+next()*.20;
    const soldiers=Array.from({length:count},(_,i)=>({
      post:.30+.61*(i+.2+next()*.55)/count,patrol:next()<.26,
      depth:(next()-.5)*.052,stride:next()*Math.PI*2,
      pace:.82+next()*.62,scale:.82+next()*.16,
    }));
    return {vehicle,artillery:next()>.52,soldiers};
  });
}

export function planCharge(session:number,id:string,compact:boolean){
  const next=randomSequence(session,'charge/'+id),order=shuffled([0,1,2,3],next);
  return order.map(rank=>{
    const count=(compact?1:2)+Math.floor(next()*(compact?3:4));
    return {wait:rank*.028+next()*.02,reach:.13+next()*.065,flag:rank%2===0,
      soldiers:Array.from({length:count},(_,i)=>({
        trail:i*(8+next()*6),depth:(next()-.5)*.029,pace:30+next()*11,phase:next()*Math.PI*2,
      }))};
  });
}
