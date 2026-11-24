type Side='buy'|'sell';
type Delta={side:Side;notional:number};
export type BattleDelta=Delta & {at:number};
export const BATTLE_CHARGE_WINDOW_MS=4000;

/** Apply once per fresh frame from one venue. The clock is in milliseconds. */
export class BattleChargeDetector {
  private position:Side|null=null;
  private amounts:{at:number;net:number}[]=[];
  private lastTick=-Infinity;
  private lastSignal=-Infinity;

  reset(){
    this.position=null;this.amounts=[];this.lastTick=this.lastSignal=-Infinity;
  }

  update(share:number|null,fresh:readonly (Delta & {at?:number})[],now:number):Delta|null{
    if(share===null||!Number.isFinite(share)||share<0||share>100||!Number.isFinite(now)){
      this.reset();return null;
    }
    if(now<this.lastTick||now-this.lastTick>BATTLE_CHARGE_WINDOW_MS)this.reset();
    this.lastTick=now;
    this.amounts=this.amounts.filter(row=>now-row.at<BATTLE_CHARGE_WINDOW_MS);
    let delta=0;
    for(const item of fresh){
      const at=item.at??now;
      if(!Number.isFinite(at)||at>now||now-at>=BATTLE_CHARGE_WINDOW_MS||
        !Number.isFinite(item.notional)||item.notional<=0||(item.side!=='buy'&&item.side!=='sell'))continue;
      const net=item.side==='buy'?item.notional:-item.notional;
      this.amounts.push({at,net});delta+=net;
    }
    if(!Number.isFinite(delta))return null;
    const next=share>=52?'buy':share<=48?'sell':null;
    if(!next||next===this.position)return null;
    const previous=this.position;
    this.position=next;
    if(previous===null||now-this.lastSignal<BATTLE_CHARGE_WINDOW_MS)return null;
    const sign=next==='buy'?1:-1;
    if(delta*sign<=0)return null;
    const notional=this.amounts.reduce((sum,row)=>sum+row.net,0)*sign;
    if(!Number.isFinite(notional)||notional<50_000)return null;
    this.lastSignal=now;
    return {side:next,notional};
  }
}
