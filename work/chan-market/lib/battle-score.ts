// Original eight-bar orchestral cue. Both stems occupy the same sample grid so
// a charge can enter on any beat without restarting the underlying phrase.
export function renderBattleScore(ctx:BaseAudioContext) {
  const rate=24000,beat=60/124,bars=8,length=Math.round(bars*4*beat*rate);
  const base=ctx.createBuffer(2,length,rate),charge=ctx.createBuffer(2,length,rate);
  const tau=2*Math.PI;
  function timbre(partials:number[]){
    const table=new Float32Array(2048);
    for(let i=0;i<table.length;i++){
      for(let j=0;j<partials.length;j++)table[i]+=partials[j]*Math.sin(tau*i/table.length*(j+1));
    }
    return table;
  }
  const string=timbre([.52,.22,.14,.10,.06,.04,.035,.025]),brass=timbre([.55,.28,.17,.095,.05,.02]);
  const bass=timbre([.76,.18,.09,.04]);
  function note(stem:AudioBuffer,start:number,duration:number,midi:number,wave:Float32Array,level:number,pan:number,attack:number){
    const a=stem.getChannelData(0),b=stem.getChannelData(1),begin=Math.round(start*beat*rate);
    const size=Math.round(duration*beat*rate),rise=attack*rate,release=Math.min(size*.38,.18*rate);
    const pitch=440*2**((midi-69)/12),step=2048*pitch/rate,detuned=step*1.003;
    const left=level*Math.sqrt((1-pan)/2),right=level*Math.sqrt((1+pan)/2);
    let phase=0,harmony=173;
    for(let i=0;i<size;i++){
      const value=(wave[phase&2047]*.76+wave[harmony&2047]*.24)*Math.min(i/rise,1,(size-i)/release);
      const index=(begin+i)%length;
      a[index]+=value*left;b[index]+=value*right;
      phase+=step;harmony+=detuned;
    }
  }
  let random=641627;
  function drum(stem:AudioBuffer,start:number,freq:number,level:number,snare=false){
    const a=stem.getChannelData(0),b=stem.getChannelData(1),begin=Math.round(start*beat*rate);
    const size=Math.floor(rate*(snare?.16:.34));
    let phase=0,pitch=freq*2.3,env=.99,low=0;
    for(let i=0;i<size;i++){
      random=(Math.imul(random,1664525)+1013904223)>>>0;
      const noise=random/2147483648-1;
      low+=.31*(noise-low);
      const tone=Math.sin(phase)+.24*Math.sin(phase*2.4);
      const value=(snare?.62*low+.32*noise+.09*tone:.81*tone+.085*low)*env*level*Math.min(1,i/(rate*.003));
      const index=(begin+i)%length;a[index]+=value*.72;b[index]+=value*.68;
      phase+=tau*pitch/rate;pitch+=(freq-pitch)*.00175;env*=snare?.99841:.99935;
    }
  }
  const roots=[38,38,34,36,38,41,39,33],motif=[0,7,12,7,3,7,10,7];
  for(let bar=0;bar<bars;bar++){
    const start=4*bar,root=roots[bar];
    note(base,start,3.9,root,bass,.33,-.04,.08);
    note(base,start,3.92,root+19,string,.095,-.45,.23);
    note(base,start+.04,3.85,root+24,string,.085,.40,.31);
    for(let i=0;i<8;i++){
      note(base,start+i*.5,.29,root+12+motif[i],string,i%2?.12:.19,-.35,.015);
      note(charge,start+i*.5+.25,.19,root+24+motif[(i+3)%8],string,.20,.44,.009);
    }
    drum(base,start,74,.55);drum(base,start+2.5,88,.37);
    for(const i of [0,1.5,2.75])note(charge,start+i,.64,root+19,brass,.36,-.19,.037);
    for(const i of [0,.75,2,3.5])drum(charge,start+i,93,.52);
    for(const i of [1,2.75,3,3.5,3.75])drum(charge,start+i,156,.48,true);
    if(bar%4===3)note(base,start+2,1.77,root+30,brass,.15,.27,.16);
  }
  return {base,charge};
}
