import type {BattleTier} from './battle-deployment';
import {renderBattleScore} from './battle-score';

export const DEFAULT_BATTLE_VOLUME=80;
type Side='buy'|'sell';
type Sample='rifle'|'cannon'|'impact';

// The output stage has a smooth knee above 0.60, even for simultaneous impacts.
function peakCurve(){
  const curve=new Float32Array(2049);
  for(let i=0;i<curve.length;i++){
    const x=2*i/(curve.length-1)-1,level=Math.abs(x);
    curve[i]=Math.sign(x)*(level<.6?level:.6+.32*Math.tanh((level-.6)/.32));
  }
  return curve;
}

/** Local effects and synchronized orchestral music. The panel owns their lifetime. */
export class BattleAudio {
  private context?:AudioContext;
  private bus?:DynamicsCompressorNode;
  private output?:GainNode;
  private noise?:AudioBuffer;
  private samples:Partial<Record<Sample,AudioBuffer>>={};
  private loading?:AbortController;
  private active=false;
  private music=true;
  private score?:ReturnType<typeof renderBattleScore>;
  private stems:AudioBufferSourceNode[]=[];
  private chargeMix?:GainNode;
  private fanfare=new Set<AudioScheduledSourceNode>();
  private voices=new Map<AudioScheduledSourceNode,()=>void>();
  private volume=DEFAULT_BATTLE_VOLUME;
  private suspended=false;
  private lastDeploy=-Infinity;
  private lastBeat=-Infinity;
  private rifleShots:number[]=[];
  private heat=0;
  private beat=0;
  private grain=0;

  setVolume(percent:number){
    if(!Number.isFinite(percent))return;
    this.volume=Math.max(0,Math.min(100,percent));
    const ctx=this.context,gain=this.output?.gain;
    if(ctx&&gain){
      gain.cancelScheduledValues(ctx.currentTime);
      if(this.volume===0){gain.setValueAtTime(0,ctx.currentTime);this.stopVoices();this.stopScore();}
      else gain.setTargetAtTime(this.volume/100,ctx.currentTime,.018);
      if(this.volume>0)this.startScore();
    }
  }

  private build(ctx:AudioContext){
    const bus=ctx.createDynamicsCompressor(),ceiling=ctx.createWaveShaper(),out=ctx.createGain();
    // One centered battlefield mix, including any stereo recordings or score stems.
    bus.channelCountMode='explicit';bus.channelCount=1;bus.channelInterpretation='speakers';
    bus.threshold.value=-13;bus.knee.value=7;bus.ratio.value=3.8;bus.attack.value=.004;bus.release.value=.13;
    ceiling.curve=peakCurve();
    out.gain.value=this.volume/100;
    bus.connect(ceiling);ceiling.connect(out);out.connect(ctx.destination);
    this.bus=bus;this.output=out;
    // Reuse one broadband texture at different offsets; no files or network reads.
    const buffer=ctx.createBuffer(1,Math.ceil(ctx.sampleRate*1.6),ctx.sampleRate);
    const samples=buffer.getChannelData(0);
    let random=0x324516da;
    for(let i=0;i<samples.length;i++){
      random=(Math.imul(random,1664525)+1013904223)>>>0;
      samples[i]=random/2147483648-1;
    }
    this.noise=buffer;
    this.loadSamples(ctx);
  }
  private loadSamples(ctx:AudioContext){
    const controller=new AbortController();this.loading=controller;
    for(const name of ['rifle','cannon','impact'] as const){
      void (async()=>{
        try{
          const res=await fetch('/battle-audio/'+name+'.wav',{signal:controller.signal});
          if(!res.ok)return;
          const decoded=await ctx.decodeAudioData(await res.arrayBuffer());
          if(!controller.signal.aborted&&ctx===this.context)this.samples[name]=decoded;
        }catch{/* Synthesized cues remain available if a recording cannot be read. */}
      })();
    }
  }
  setMusic(enabled:boolean){
    this.music=enabled;
    if(enabled)this.startScore();else this.stopScore();
  }
  setBattleActive(active:boolean){
    this.active=active;
    if(active)this.startScore();
    else {this.stopScore();this.stopVoices();}
  }
  private startScore(){
    const ctx=this.playable();
    if(!ctx||!this.active||!this.music||!this.bus||this.stems.length)return;
    this.score??=renderBattleScore(ctx);
    const time=ctx.currentTime+.012;
    for(const stem of ['base','charge'] as const){
      const src=ctx.createBufferSource(),mix=ctx.createGain();
      src.buffer=this.score[stem];src.loop=true;
      mix.gain.value=0;
      if(stem==='base')mix.gain.setTargetAtTime(.74,time,.12);else this.chargeMix=mix;
      src.connect(mix);mix.connect(this.bus);src.onended=()=>{src.disconnect();mix.disconnect();};
      this.stems.push(src);src.start(time);
    }
  }
  private stopScore(){
    for(const src of this.stems){src.stop();src.disconnect();}
    for(const src of this.fanfare){
      src.onended=null;src.stop();this.voices.get(src)?.();
    }
    this.stems=[];this.chargeMix=undefined;
  }
  charge(side:Side){
    const ctx=this.playable(),mix=this.chargeMix;
    if(!ctx||!this.music||!this.active||!mix)return;
    const t=ctx.currentTime;
    if(typeof mix.gain.cancelAndHoldAtTime==='function')mix.gain.cancelAndHoldAtTime(t);
    else{
      const level=mix.gain.value;
      mix.gain.cancelScheduledValues(t);mix.gain.setValueAtTime(level,t);
    }
    mix.gain.linearRampToValueAtTime(.97,t+.18);
    mix.gain.setValueAtTime(.97,t+3.55);mix.gain.linearRampToValueAtTime(0,t+4.3);
    // The fanfare signals a new charge even between two notes of the ostinato.
    const pitch=side==='buy'?1:.965;
    this.fanfare.add(this.tone(ctx,t,'triangle',220*pitch,222*pitch,.18,.34,.021));
    this.fanfare.add(this.tone(ctx,t+.15,'triangle',330*pitch,331*pitch,.36,.39,.055));
  }
  async enable(){
    try{
      const Audio=window.AudioContext??(window as typeof window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
      if(!Audio)return false;
      if(!this.context){this.context=new Audio();this.build(this.context);}
      const ctx=this.context;
      const wasSuspended=this.suspended;
      this.suspended=false;
      if(wasSuspended||ctx.state!=='running')await ctx.resume();
      if(ctx===this.context)this.startScore();
      return ctx===this.context&&!this.suspended&&ctx.state==='running';
    }catch{return false;}
  }
  private stopVoices(){
    for(const [source,release] of this.voices){
      source.onended=null;source.stop();release();
    }
    this.lastDeploy=this.lastBeat=-Infinity;this.rifleShots=[];
    this.beat=this.heat=0;
  }
  suspend(){
    this.suspended=true;
    this.stopScore();this.stopVoices();
    if(this.context?.state==='running')void this.context.suspend().catch(()=>{});
  }
  close(){
    this.stopScore();this.stopVoices();this.loading?.abort();
    const ctx=this.context;
    this.output?.disconnect();this.bus?.disconnect();
    this.context=undefined;this.bus=undefined;this.output=undefined;this.noise=undefined;this.score=undefined;
    this.samples={};this.loading=undefined;this.suspended=false;
    if(ctx&&ctx.state!=='closed')void ctx.close().catch(()=>{});
  }
  private playable(){
    if(!this.context||this.context.state!=='running'||this.suspended||!this.volume||document.hidden||!navigator.onLine)return;
    return this.context;
  }

  private schedule(ctx:AudioContext,source:OscillatorNode|AudioBufferSourceNode,time:number,length:number,
    gain:number,attack:number,filter?:BiquadFilterNode,offset=0,recorded=false){
    if(!this.bus)return;
    const env=ctx.createGain();
    // Match the per-speaker gain of a centered equal-power pan.
    gain*=Math.SQRT1_2;
    const peak=time+attack,body=peak+(length-attack)*.31;
    env.gain.setValueAtTime(.0001,time);env.gain.exponentialRampToValueAtTime(gain,peak);
    if(recorded)env.gain.setValueAtTime(gain,time+length*.74);
    else env.gain.exponentialRampToValueAtTime(gain*.48,body);
    env.gain.exponentialRampToValueAtTime(.0001,time+length);
    if(filter){source.connect(filter);filter.connect(env);}else source.connect(env);
    env.connect(this.bus);
    const release=()=>{source.disconnect();filter?.disconnect();env.disconnect();this.voices.delete(source);this.fanfare.delete(source);};
    this.voices.set(source,release);source.onended=release;
    if('buffer' in source)source.start(time,offset);else source.start(time);
    source.stop(time+length+.006);
  }
  private sample(ctx:AudioContext,name:Sample,time:number,maxLength:number,level:number,speed=1){
    const clip=this.samples[name];if(!clip)return false;
    const src=ctx.createBufferSource();src.buffer=clip;src.playbackRate.value=speed;
    this.schedule(ctx,src,time,Math.min(clip.duration/speed,maxLength),level,.002,undefined,0,true);
    return true;
  }
  private tone(ctx:AudioContext,time:number,type:OscillatorType,from:number,to:number,length:number,gain:number,attack=.004){
    const osc=ctx.createOscillator();
    osc.type=type;osc.frequency.setValueAtTime(from,time);osc.frequency.exponentialRampToValueAtTime(to,time+length);
    this.schedule(ctx,osc,time,length,gain,attack);
    return osc;
  }
  private burst(ctx:AudioContext,time:number,from:number,to:number,length:number,gain:number,attack=.003){
    if(!this.noise)return;
    const buf=ctx.createBufferSource(),filter=ctx.createBiquadFilter();
    buf.buffer=this.noise;buf.loop=true;filter.type='bandpass';filter.Q.value=.67;
    filter.frequency.setValueAtTime(from,time);filter.frequency.exponentialRampToValueAtTime(to,time+length);
    this.grain=(this.grain+.271)%1;
    this.schedule(ctx,buf,time,length,gain,attack,filter,this.grain);
  }
  private drum(ctx:AudioContext,t:number,pitch:number,level:number){
    this.tone(ctx,t,'sine',pitch*1.72,pitch*.48,.19,level);
    this.tone(ctx,t,'triangle',pitch*3.1,pitch*1.16,.083,level*.52);
  }
  private cadence(ctx:AudioContext,tier:BattleTier){
    const t=ctx.currentTime;
    this.heat=Math.min(3,this.heat*Math.exp(-(t-this.lastDeploy)/1.25)+(tier==='infantry'?.35:1.2));
    this.lastDeploy=t;
    if(t-this.lastBeat<.51-this.heat*.10)return;
    this.lastBeat=t;
    const pitch=[160,203,169,140][this.beat++%4],level=.34+this.heat*.08;
    this.drum(ctx,t,pitch,level);
    if(this.heat>1.4)this.drum(ctx,t+.115,pitch*1.24,level*.72);
    if(this.heat>2.3)this.burst(ctx,t+.18,2400,850,.074,.35);
  }
  preview(){
    const ctx=this.playable();if(!ctx)return;
    this.drum(ctx,ctx.currentTime,186,.48);
    this.tone(ctx,ctx.currentTime+.09,'triangle',330,525,.15,.26);
  }
  strike(side:Side,tier:BattleTier,shotTimes?:readonly number[]){
    const ctx=this.playable();if(!ctx)return;
    const t=ctx.currentTime,pitch=side==='buy'?1.07:.93;
    this.cadence(ctx,tier);
    if(tier==='infantry'){
      // Shots come from the same timeline as the visible muzzle flashes.
      // Merge near-simultaneous reports across squads; reduced motion gives one report.
      this.rifleShots=this.rifleShots.filter(time=>time>=t-.37);
      for(const offset of shotTimes??[0]){
        if(!Number.isFinite(offset)||offset<0||offset>2)continue;
        const time=t+offset;
        if(this.rifleShots.some(queued=>Math.abs(queued-time)<.04))continue;
        const overlap=this.rifleShots.filter(queued=>Math.abs(queued-time)<.37).length;
        this.rifleShots.push(time);
        const level=(1.03+.07*Math.random())/Math.sqrt(1+overlap*.35);
        const variation=.96+.08*Math.random();
        const recorded=this.sample(ctx,'rifle',time,.37,level,variation);
        if(!recorded)this.burst(ctx,time,3050*pitch*variation,880,.11,level);
        this.tone(ctx,time,'triangle',560*pitch*variation,147,.105,level*(recorded?.25:.46));
      }
      return;
    }
    if(tier==='grenade'){
      const tossed=t+.36;
      this.burst(ctx,tossed,2100,620,.17,.54,.022);
      this.tone(ctx,tossed,'triangle',640*pitch,340,.046,.14);
      return;
    }
    if(tier==='air'){
      this.tone(ctx,t,'triangle',245*pitch,920,.85,.36,.18);
      this.burst(ctx,t+.14,540,2400,1.14,.81,.39);
      this.tone(ctx,t+.80,'triangle',1110*pitch,150,.99,.36,.075);
      return;
    }
    const heavy=tier==='artillery',muzzle=t+(heavy?.63:.54);
    const recorded=this.sample(ctx,'cannon',muzzle,heavy?.89:.60,1.14);
    if(!recorded)this.burst(ctx,muzzle,heavy?2540:3220,390,heavy?.26:.21,1.38);
    this.tone(ctx,muzzle,'triangle',heavy?290:345,68,heavy?.33:.24,.79);
    this.tone(ctx,muzzle+.01,'sine',148,53,.26,.80);
    this.tone(ctx,muzzle+.16,'triangle',heavy?1020:860,355,heavy?.73:.48,.24,.075);
  }

  /** Called at the same animation frame as the rendered shell or bomb impact. */
  impact(side:Side,tier:BattleTier){
    const ctx=this.playable();if(!ctx||tier==='infantry')return;
    const t=ctx.currentTime;
    if(tier==='grenade'){
      this.sample(ctx,'impact',t,.24,.65);
      this.burst(ctx,t,side==='buy'?2360:2240,600,.20,.66);
      this.tone(ctx,t,'sine',186,60,.20,.61);
      return;
    }
    const heavy=tier!=='armor';
    const recorded=this.sample(ctx,'impact',t,heavy?1.15:.70,1.20);
    if(!recorded)this.burst(ctx,t,heavy?2800:3300,350,heavy?.53:.33,1.65);
    this.tone(ctx,t,'triangle',heavy?295:355,82,heavy?.45:.29,.97);
    this.tone(ctx,t,'sine',heavy?138:161,heavy?39:51,heavy?.68:.40,1.07);
    this.burst(ctx,t+.045,680,165,heavy?.60:.36,.95);
    if(heavy){
      this.tone(ctx,t+.085,'triangle',185,68,.31,.58);
      this.burst(ctx,t+.15,1800,400,.24,.74);
    }
    if(tier==='air'){
      this.burst(ctx,t+.205,2300,280,.39,1.22);
      this.tone(ctx,t+.21,'triangle',222,60,.44,.77);
    }
  }
}
