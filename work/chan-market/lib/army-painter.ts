/** Original arcade battlefield art. All world coordinates are CSS pixels, with units anchored at their feet. */
import type {BattleTier} from './battle-deployment';
export type ArmyKind = BattleTier;
export type ArmySide = 'buy' | 'sell';
export const ARMY_PROJECTILE_TRAVEL:Readonly<Record<ArmyKind,number>>={infantry:.40,grenade:.64,armor:.59,artillery:.68,air:.59};

type Brush = CanvasRenderingContext2D;
const ink = '#111f25';
const colors = {
  buy: {shadow:'#153c35',dark:'#1b6550',coat:'#238e66',light:'#62c88c',edge:'#cbefd2',signal:'#7bffb0'},
  sell:{shadow:'#41232e',dark:'#853c4c',coat:'#b64e59',light:'#f28882',edge:'#ffe5bc',signal:'#ff9c8f'},
};
type Uniform = typeof colors.buy;

function art(ctx:Brush,d:string,fill:string|CanvasGradient,stroke?:string,width=.65){
  const shape=new Path2D(d);
  ctx.fillStyle=fill;ctx.fill(shape);
  if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.lineJoin='round';ctx.stroke(shape);}
}
function wash(ctx:Brush,y:number,height:number,...stops:string[]){
  const gradient=ctx.createLinearGradient(0,y,0,y+height);
  stops.forEach((color,i)=>gradient.addColorStop(i/(stops.length-1),color));
  return gradient;
}

function polygon(ctx:Brush, fill:string, points:number[]) {
  ctx.fillStyle=fill;ctx.beginPath();ctx.moveTo(points[0],points[1]);
  for(let i=2;i<points.length;i+=2)ctx.lineTo(points[i],points[i+1]);
  ctx.closePath();ctx.fill();
}
function rect(ctx:Brush,fill:string,x:number,y:number,w:number,h:number) {
  ctx.fillStyle=fill;ctx.fillRect(x,y,w,h);
}
function oval(ctx:Brush,fill:string,x:number,y:number,rx:number,ry:number) {
  ctx.fillStyle=fill;ctx.beginPath();ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2);ctx.fill();
}
function line(ctx:Brush,color:string,width:number,points:number[]) {
  ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(points[0],points[1]);
  for(let i=2;i<points.length;i+=2)ctx.lineTo(points[i],points[i+1]);
  ctx.stroke();
}

function soldier(ctx:Brush,c:Uniform,step:number,recoil:number,throwPose?:number) {
  ctx.lineCap='round';
  const cloth=wash(ctx,-24,22,c.light,c.coat,c.dark),steel=wash(ctx,-20,8,'#d2d9ce','#556d70',ink);
  // Knees and heels follow different arcs, giving the advancing ranks a natural stride.
  for(const leg of [-1,1]){
    const k=leg*step,back=leg<0;
    ctx.save();ctx.translate(leg*1.9,0);
    line(ctx,ink,4.1,[-.5,-11,k*3,-6,-k*3.2,-1]);
    line(ctx,back?'#4f665e':'#6c8172',3,[-.5,-11,k*3,-6,-k*3.2,-1]);
    oval(ctx,back?'#455a52':'#839384',k*3+.4,-6,1.6,1.35);
    art(ctx,`M${-k*3.2-1.5},-2.4 q1.8,-.5 3,.4 l2.3,.6 q1.4,.1 1.1,1.3 h-6.8z`,'#263731','#162720',.55);
    ctx.restore();
  }
  ctx.save();ctx.translate(-recoil*.65,Math.abs(step)*-.47);
  art(ctx,'M-6.9 -22 Q-10.2 -21.7 -10 -18 L-9.7 -10 Q-9.1 -8 -6.9 -8.6 L-4.9 -10.1 L-4.4 -18.8 Z',
    wash(ctx,-22,15,'#889484','#535f51','#36453f'),ink);
  line(ctx,'#c0b69a',.85,[-8.9,-18.9,-6.4,-19.3]);
  art(ctx,'M-4 -22.5 Q-.5 -23 2.6 -20.5 L5 -17 L3.3 -11.2 Q.2 -8.5 -5.7 -10 L-6.7 -14.1 L-7.5 -19.5Z',cloth,ink,.9);
  art(ctx,'M-5.4 -19.9 L.5 -19.7 L3 -17.5 L2.2 -13 L-2.2 -11.9 L-5.5 -13Z','#344d49');
  line(ctx,'#d7cfaa',1,[-4.9,-21.6,-3.7,-17.7,-1.6,-16.8,1.7,-12.2]);
  line(ctx,'#b0bfaa',.55,[-4.1,-15,-1.4,-15.1,1.8,-15.9]);
  art(ctx,'M-5.9 -12 L2.8 -13 L3.2 -11 L-5.7 -10Z','#272f2c');
  rect(ctx,'#c8ad79',-.4,-12.4,1.7,1);
  art(ctx,'M-3.4 -23.8 Q-2.3 -27.7 2.1 -26.8 Q4.9 -26.3 5.1 -24.3 L6.5 -22.7 L5.1 -22.2 Q5 -19 2.5 -19.4 L-1.5 -20.8Z',wash(ctx,-26,8,'#f6cea1','#d1a37e','#856953'),ink,.65);
  art(ctx,'M-5.9 -24.4 Q-6.6 -29.4 -1.6 -30.3 Q4.4 -31.2 6.1 -25.7 L7 -25.3 L6.3 -24.4 L1.4 -24.5 L-.5 -22.3 L-4.8 -22.4Z',
    wash(ctx,-30.6,8,c.edge,c.coat,c.shadow),ink,.85);
  art(ctx,'M-3.8 -29.3 Q-.8 -30.3 2.3 -29.1 L.5 -26.6 L-3.7 -26.3Z',c.light);
  line(ctx,c.shadow,.65,[-5.3,-25.4,-1.5,-25.9,4.2,-26]);
  art(ctx,'M.4 -25.3 L6 -25.4 L5.4 -23.5 L1 -23.4Z','#213a3b');
  line(ctx,'#b4e4cf',.7,[1.1,-24.9,4.9,-24.9]);
  oval(ctx,c.dark,-4,-24,1.3,1.8);
  if(throwPose!==undefined){
    const elbowX=-6+throwPose*11,elbowY=-25+throwPose*2,handX=-9+throwPose*20,handY=-32+throwPose*5;
    const arm=[-1,-20,elbowX,elbowY,handX,handY];
    line(ctx,ink,4.4,arm);line(ctx,c.coat,3.2,arm);
    oval(ctx,'#e7be94',handX,handY,1.8,1.7);
    if(throwPose<1)grenade(ctx,handX,handY-2,0,.46,c.signal);
    ctx.restore();return;
  }
  art(ctx,'M-2.2 -19.8 Q.2 -20.2 1.6 -17.8 L4.3 -16.6 L7.6 -17.5 L8.2 -15.5 L4 -14 Q2.5 -14 1 -15 L-3 -17Z',cloth,ink,.8);
  art(ctx,'M.7 -16 L3.5 -17.4 L8 -17 L10 -18 L17.5 -17.9 L17.5 -17.3 L22 -17.3 L22 -16.2 L16.9 -16 L14.6 -15.4 L9.6 -15.2 L8.9 -12.9 L6.8 -13.1 L7.5 -15.1 L4.2 -15 L2.6 -14Z',steel,ink,.6);
  rect(ctx,'#c7cabb',10.1,-17.9,4.6,.55);rect(ctx,ink,13.4,-19.1,2.4,1.1);
  oval(ctx,'#be9c77',4.6,-15.9,1.45,1.1);oval(ctx,'#e1c39a',11.2,-15.6,1.5,.85);
  ctx.restore();
}

function tracks(ctx:Brush,c:Uniform,x:number,w:number,step:number) {
  art(ctx,`M${x+2} -9 Q${x-3} -8 ${x-2} -5 L${x+1} -1 Q${x+2} 0 ${x+6} 0 H${x+w-6} Q${x+w-3} 0 ${x+w} -4 Q${x+w+3} -8 ${x+w-2} -9Z`,
    wash(ctx,-9,9,'#8a9688','#273638','#455452'),ink,1);
  for(let i=x+4;i<=x+w-3;i+=5.7){
    oval(ctx,'#14282b',i,-4.8,2.8,2.8);oval(ctx,'#77857d',i,-5.0,2.15,2.15);
    oval(ctx,c.shadow,i,-4.8,.95,.95);oval(ctx,'#cad2ba',i-.35,-5.5,.47,.4);
  }
  for(let i=x+3+step;i<x+w-2;i+=3.2)line(ctx,'#9eaa9b',.65,[i,-1.6,i+.6,-.6]);
}
function tank(ctx:Brush,c:Uniform,step:number,recoil:number) {
  tracks(ctx,c,-21,40,step);
  const hull=wash(ctx,-18,13,c.light,c.coat,c.shadow);
  art(ctx,'M-23 -10.9 L-20.2 -15.1 L-10.7 -17.6 L6 -17.3 L19.6 -12.4 L23.2 -10.3 L21 -7.7 L-20 -7.7Z',hull,ink,1);
  art(ctx,'M-19.9 -14.9 L-10.6 -17.5 L5.6 -17.2 L13 -14.5 L-12.6 -13.8Z',c.light);
  for(let i=-19;i<16;i+=7.4){
    art(ctx,`M${i} -12.4 l6.7 -.1 l-1.3 3.9 l-6.2 .1z`,c.dark,c.shadow,.55);
    line(ctx,c.light,.5,[i+.6,-12,i+5,-12]);
  }
  oval(ctx,'#f9df99',19,-11.4,1.5,1);rect(ctx,'#72796e',-22,-12.1,1.2,3.1);
  ctx.save();ctx.translate(-recoil*1.1,0);
  art(ctx,'M-11 -17.6 L-12.8 -19.6 L-9.4 -23 L-3.4 -24.6 L3.8 -24 L9.2 -20.7 L9.6 -18.4 L4.7 -16.6 L-7.1 -16.5Z',
    wash(ctx,-24.8,8.5,c.edge,c.coat,c.dark),ink,.95);
  art(ctx,'M-10.8 -20.3 L-.4 -21.5 L6.9 -20.8 L3.4 -17.7 L-6.5 -17.4Z',c.coat);
  line(ctx,c.light,.65,[-7.2,-19.1,-4.9,-19.5,-3.1,-19.5]);
  art(ctx,'M6.2 -21.4 L10 -21 L11 -20.6 L25.1 -20.1 L25.5 -21 L29.5 -20.8 L30 -18.6 L25.3 -18.5 L24.5 -19.1 L10.3 -19.1 L7 -18.1Z',wash(ctx,-21.5,4,c.edge,'#566a64','#263431'),ink,.55);
  line(ctx,c.edge,.6,[12,-20.5,24,-20.1]);
  oval(ctx,'#263731',-3.4,-24.2,4,.8);rect(ctx,'#bac8ab',-6.3,-24.8,5,.5);
  line(ctx,'#5a6b66',.6,[-9.1,-23.1,-10.1,-31.5]);
  oval(ctx,'#f3c882',4,-21.5,1,.6);ctx.restore();
}
function artillery(ctx:Brush,c:Uniform,step:number,recoil:number) {
  tracks(ctx,c,-20,34,step);
  art(ctx,'M-23 -10 L-21 -14 L-16 -18 L-8 -20 L-1 -19 L4.4 -14 L14.6 -11.8 L17 -8 L12.7 -6.4 L-20 -7.6Z',
    wash(ctx,-20,13,c.light,c.coat,c.shadow),ink,.9);
  art(ctx,'M-21 -12.8 L-17.1 -16.6 L-9 -18.3 L-8.2 -14.7 L-12.6 -12.5Z',c.coat);
  art(ctx,'M-17 -16.3 L-13 -17.2 L-12.5 -15.4 L-16.3 -14.7Z','#334949');
  line(ctx,'#bacaaf',.65,[-18,-11,-15,-11.5,-8,-11.5]);
  ctx.save();ctx.translate(1,-14.8);ctx.rotate(-.48);
  art(ctx,'M-6 -4.5 L1.6 -4.9 L4.6 -3.5 L10.4 -3.1 L11 -2.7 L24 -2.6 L24 -3.4 L29 -3.2 L30 -.3 L25 -.1 L24 -1 L10 -.8 L8.1 .1 L-6.4 1.7Z',
    wash(ctx,-5,7,c.edge,c.dark,'#283832'),ink,.7);
  ctx.translate(-recoil*1.5,0);line(ctx,c.light,.65,[10,-2.4,28,-2.1]);
  line(ctx,'#c7c8ab',1,[-4,3.6,11,1.3]);oval(ctx,'#30473e',-1,1.6,3.1,3.2);oval(ctx,c.coat,-1,1.6,1.8,1.8);
  ctx.restore();rect(ctx,'#d2bc8a',7,-9.3,3.3,.6);
}
function aircraft(ctx:Brush,c:Uniform,step:number) {
  ctx.save();ctx.translate(0,-10);
  art(ctx,`M-24.8 -3 Q${-31-step} -3 -39 0 Q-31.3 2 -24.8 2.7Z`,wash(ctx,-3,6,'#f78249','#fff4bc','#d87954'));
  art(ctx,'M-26 -4.4 L-28.8 -12.8 L-25 -13.1 L-16 -5.6 L-6.6 -5.8 L-13.5 -19.6 L-8.3 -19 L11.8 -5 L20.5 -4.2 Q31 -2.4 34 -.4 Q30.3 2.8 18.2 3.4 L10.6 3.7 L-10.7 17.9 L-15.3 17.7 L-7.4 3.8 L-15.6 3.6 L-27.8 11.4 L-30.6 10.5 L-24.2 2.8Z',
    wash(ctx,-19,38,c.edge,c.coat,c.dark),ink,1);
  art(ctx,'M-24 -2.6 L-.5 -4.3 Q15 -4.5 29.8 -.4 Q13.4 2.7 -1.3 1.7 L-23.7 1Z',wash(ctx,-4,7,c.edge,c.light,c.shadow));
  art(ctx,'M4.2 -3 L10.5 -4 Q16.2 -4.3 20.3 -1.6 L14.3 -.7 L6.9 -.6Z',wash(ctx,-4.2,3.8,'#d1f1e8','#5e8189','#2e4552'),ink,.6);
  line(ctx,c.shadow,.7,[-9.7,-16.6,-4.9,-11.2,.8,-6]);line(ctx,c.light,.6,[-12.3,15,-4.6,7.6,4.9,4.1]);
  oval(ctx,'#f4d982',-8,12.8,1.1,.55);ctx.restore();
}

const drawers = {infantry:soldier,grenade:(ctx:Brush,c:Uniform,step:number,pose:number)=>soldier(ctx,c,step,0,pose),armor:tank,artillery,air:aircraft};
const sprites = new Map<string,HTMLCanvasElement>();
export function drawArmyUnit(ctx:Brush,x:number,y:number,side:ArmySide,kind:ArmyKind,scale=1,stride=0,fire=0) {
  const phase=kind==='infantry'?Math.round(Math.sin(stride)*3):0;
  const recoil=kind==='grenade'?Math.round(fire*4)/4:fire>.4?1:0,key=[side,kind,phase,recoil].join('/');
  let sprite=sprites.get(key);
  if(!sprite){
    sprite=document.createElement('canvas');sprite.width=84*3;sprite.height=60*3;
    const pen=sprite.getContext('2d');
    if(!pen)return;
    pen.scale(3,3);pen.translate(42,40);drawers[kind](pen,colors[side],phase/3,recoil);sprites.set(key,sprite);
  }
  ctx.save();ctx.translate(x,y);
  if(kind!=='air')oval(ctx,'#0a1a2566',0,-.4,scale*(kind==='infantry'||kind==='grenade'?9:22),scale*2.6);
  ctx.scale(side==='buy'?scale:-scale,scale);ctx.imageSmoothingEnabled=true;
  ctx.drawImage(sprite,-42,-40,84,60);ctx.restore();
}

function commandPost(ctx:Brush,x:number,y:number,scale:number,side:ArmySide){
  const c=colors[side];
  ctx.save();ctx.translate(x,y);ctx.scale(side==='buy'?scale:-scale,scale);
  oval(ctx,'#20382f70',-5,2,44,5);
  // The observation deck rises above an angled earthwork with a reinforced door.
  art(ctx,'M-47 1 L-44 -12 L-39 -17 L-17 -18 L-12 -12 L-9 2 Z',wash(ctx,-18,20,'#a6a88c','#6f7564','#434e47'),ink);
  art(ctx,'M-44 -12 L-39 -17 L-17 -18 L-12 -12 L-18 -10Z','#a3a18b');
  art(ctx,'M-37 -8 L-18 -9 L-17 -6 L-38 -5Z','#213536');
  for(const dx of [-38,-25]){
    art(ctx,'M'+dx+' -15 l1.8 -23 h2 l-.8 24z','#5f6e63',ink,.7);
  }
  line(ctx,'#384d4b',2,[-39,-16,-23,-33,-36,-34,-23,-17]);
  line(ctx,'#a7ada0',.65,[-39,-16,-23,-33,-36,-34,-23,-17]);
  art(ctx,'M-43 -46 L-24 -49 L-18 -45 L-19 -37 L-42 -35Z',wash(ctx,-49,13,'#9ba99e','#485f60',ink),ink);
  art(ctx,'M-41 -44 L-26 -46 L-26 -40 L-41 -38Z','#28434a');
  art(ctx,'M-39 -43 L-35 -43.3 L-36.8 -39 L-39 -39Z','#f6d58f');
  line(ctx,'#b1b7a5',.75,[-33,-44.5,-33,-39.3]);line(ctx,'#b1b7a5',.75,[-28,-45,-28,-39.7]);
  art(ctx,'M-45 -45 L-40 -51 L-25 -53 L-17 -48 L-16 -45 L-25 -47Z',wash(ctx,-53,8,c.edge,c.coat,c.shadow),ink);
  art(ctx,'M-43 -35 L-19 -37 L-16 -35 L-17 -32 L-43 -30Z',c.dark,ink);
  line(ctx,c.light,.9,[-42,-34,-19,-36]);line(ctx,'#b0b4a0',.7,[-36,-16,-36,-29,-33,-29,-33,-16]);
  for(let j=0;j<4;j++)line(ctx,'#96a18e',.6,[-36,-18-j*2.7,-33,-18.25-j*2.7]);
  // Folded canvas, staked guy ropes and supply chests use the same light as the tower.
  art(ctx,'M-25 0 Q-20 -8 -14 -16 L2 -20 L16 -6 L17 .5 L-7 3Z',wash(ctx,-19,23,'#a19d7b','#7b7d62','#555d4c'),'#34453f',.9);
  art(ctx,'M-25 0 Q-20 -8 -14 -16 L2 -20 Q-6 -10 -7 3Z','#899075');
  art(ctx,'M-5 1 L1 -14 L9 0Z','#35433b');line(ctx,'#b0ad8f',.8,[-21,0,-14,-15,1,-19,16,-5]);
  for(const tx of [-17,-12])line(ctx,'#626d58',.7,[tx,0,tx+5,-11]);
  line(ctx,'#c8bf9b',.65,[-27,2,-15,-15]);line(ctx,'#afa98d',.65,[21,2,3,-18]);
  for(const [dx,dy] of [[13,-4],[21,-1],[16,2]]){
    art(ctx,'M'+dx+' '+dy+' l6.5 -1.2 3.8 1.8 -.4 4.2 -6.1 1 -3.8 -1.5Z','#7a7054','#485144',.5);
    line(ctx,'#b9a57c',.75,[dx+2,dy+.8,dx+5,dy+1.8,dx+5,dy+4.5]);
  }
  ctx.restore();
}
function landscape(w:number,h:number,density:number) {
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(w*density);canvas.height=Math.ceil(h*density);
  const ctx=canvas.getContext('2d');if(!ctx)return canvas;
  ctx.scale(canvas.width/w,canvas.height/h);
  ctx.save();ctx.scale(w/1000,h/400);
  ctx.fillStyle=wash(ctx,0,145,'#243d50','#637d81','#c6bc96');ctx.fillRect(0,0,1000,147);
  const glow=ctx.createRadialGradient(617,70,1,617,70,200);glow.addColorStop(0,'#fae2a65c');glow.addColorStop(1,'#fae2a600');
  ctx.fillStyle=glow;ctx.fillRect(400,0,470,142);oval(ctx,'#f5dda7',617,67,9,9);
  art(ctx,'M0 47 Q58 43 79 45 Q113 47 149 42 Q182 40 217 42 Q133 53 49 50Z','#c5d0c321');
  art(ctx,'M684 33 Q716 34 740 30 Q777 26 806 30 Q766 32 748 36 L698 38Z','#e0deca30');
  art(ctx,'M0 83 L38 84 76 71 107 73 145 57 177 68 202 62 231 78 256 78 278 84 306 80 339 68 371 75 399 64 431 70 465 68 493 85 534 69 556 73 588 63 618 80 646 75 688 62 719 70 746 62 786 79 818 70 850 79 879 59 911 64 944 48 971 57 1000 55 V143 H0Z',wash(ctx,48,84,'#768891','#9aa6a0'));
  art(ctx,'M54 86 L145 57 127 73 110 76 97 83Z M324 82 L399 64 380 75 371 75 354 82Z M852 89 L944 48 930 66 910 67 893 78Z','#d4d0ae38');
  art(ctx,'M0 98 Q41 101 78 93 T151 88 L190 78 217 83 243 78 277 90 321 102 Q358 101 392 91 L428 82 470 89 498 85 538 101 574 103 600 94 649 81 674 86 703 79 740 95 Q779 99 807 91 L851 80 884 90 920 88 954 98 1000 94 V145 H0Z',wash(ctx,79,60,'#586e75','#788780'));
  art(ctx,'M0 112 Q79 104 124 108 T225 107 Q310 86 372 108 Q430 121 500 112 T646 103 Q698 102 748 113 T863 109 Q942 97 1000 105 V150 H0Z','#465f62');
  let seed=1379;
  const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  // Irregular clusters of conifers separated by clearings along the lower ridge.
  for(let x=-5;x<1008;){
    const cluster=4+Math.floor(noise()*10);
    for(let j=0;j<cluster;j++){
      x+=1.7+noise()*4.8;
      const ground=126+Math.sin(x*.019)*2.8+Math.cos(x*.028)*1.7;
      const tree=3+noise()*8.5,half=1+tree*.22;
      polygon(ctx,'#344f50',[x-half,ground,x-half*.59,ground-tree*.34,x-half*.76,ground-tree*.32,x,ground-tree,x+half*.76,ground-tree*.31,x+half*.55,ground-tree*.36,x+half,ground]);
    }
    x+=4+noise()*15;
  }
  art(ctx,'M0 127 Q140 132 240 127 T452 128 Q598 133 713 127 T1000 127 V401 H0Z',wash(ctx,125,275,'#87917a','#707d68','#526557','#354f46'));
  art(ctx,'M0 143 Q168 123 350 133 T618 133 Q804 121 1000 136 L1000 146 Q795 131 683 137 Q478 148 333 137 Q225 129 0 151Z','#c4bd8d32');
  art(ctx,'M0 206 C143 184 187 141 366 134 C255 149 190 180 110 204 C67 217 30 221 0 226Z','#c5b78b3b');
  art(ctx,'M1000 178 Q886 162 844 143 Q818 138 771 133 Q844 138 879 146 Q947 164 1000 165Z','#d1bd972e');
  art(ctx,'M435 405 C379 362 399 335 457 303 C523 268 529 244 505 216 C475 180 472 157 541 133 C489 159 481 180 517 214 C550 246 534 275 475 309 C421 344 421 367 487 405Z','#c6bca42a');
  art(ctx,'M444 405 C400 361 411 335 465 305 C521 273 546 242 506 205 C552 243 531 272 469 309 C419 341 413 359 453 405Z','#b8ad8754');
  art(ctx,'M0 314 Q93 289 160 300 T312 310 Q221 312 155 309 Q73 302 0 333Z M758 259 Q891 235 1000 247 V254 Q900 244 758 259Z','#203f393b');
  for(let i=0;i<43;i++){
    const px=noise()*1000,py=142+noise()*242,s=.35+1.1*(py-135)/245;
    for(let j=0;j<3+noise()*4;j++){
      const gx=px+(noise()-.5)*24*s,gy=py+noise()*6*s,blade=(.9+noise()*2.4)*s;
      line(ctx,'#a3a38155',.75*s,[gx-blade*.5,gy-blade,gx,gy,gx+blade*.8,gy-blade*.85]);
    }
    if(i%5===0){oval(ctx,'#283c3650',px,py+1,5*s,s);polygon(ctx,'#91927a8f',[px-4*s,py,px-s,py-2*s,px+2*s,py-1.7*s,px+4*s,py]);}
  }
  ctx.restore();
  const base=Math.min(1.1,w/620);
  commandPost(ctx,w*.09,h*.40,base,'buy');commandPost(ctx,w*.91,h*.40,base,'sell');
  return canvas;
}
let cachedField:{w:number;h:number;density:number;canvas:HTMLCanvasElement}|undefined;
export function drawArmyField(ctx:Brush,w:number,h:number,timeSec:number,front=.5){
  if(w<1||h<1)return;
  const density=Math.max(1,Math.min(2,window.devicePixelRatio||1));
  if(!cachedField||cachedField.w!==w||cachedField.h!==h||cachedField.density!==density)cachedField={w,h,density,canvas:landscape(w,h,density)};
  ctx.save();ctx.imageSmoothingEnabled=true;ctx.drawImage(cachedField.canvas,0,0,w,h);ctx.restore();
  // Tint occupied ground and join the visible lanes along one continuous frontline.
  const center=Math.min(.76,Math.max(.24,front))*w;
  const frontPoints:number[]=[];
  for(let i=0;i<=16;i++){
    const q=i/16;
    const bend=(Math.sin(i*.91)+.48*Math.sin(i*1.88))*Math.min(w*.009,7)*(.5+q*.5);
    frontPoints.push(w*.5+(center-w*.5)*(.67+.33*q)+bend,h*(.33+.67*q));
  }
  polygon(ctx,'#31885820',[0,h*.33,...frontPoints,0,h]);
  polygon(ctx,'#d85f5e1d',[w,h*.33,...frontPoints,w,h]);
  ctx.save();ctx.lineJoin='round';
  line(ctx,'#102d355e',7,frontPoints);
  line(ctx,'#e6e8c845',3.5,frontPoints);
  line(ctx,'#f1f4c9bd',1.35,frontPoints);ctx.restore();
  const s=Math.min(1.12,Math.max(.62,w/680));
  for(const side of ['buy','sell'] as const){
    const mirrored=side==='buy'?1:-1,c=colors[side],base=Math.min(1.1,w/620);
    const x=w*(side==='buy'?.09:.91)-mirrored*30*base,y=h*.40-51*base;
    const wave=1.5*Math.sin(timeSec*2+mirrored);
    ctx.save();ctx.translate(x,y);ctx.scale(mirrored*s,s);
    line(ctx,'#263b39',2,[0,2,0,-17]);line(ctx,'#c6bd9c',.85,[-.45,2,-.45,-18]);
    art(ctx,`M.6 -17 Q6 -20 13 -17.3 Q18 ${-15.5+wave} 22 ${-17+wave} L19 ${-12+wave} L22 ${-8+wave} Q16 ${-6.4+wave} 10 -9 Q4 -10.7 .6 -8.4Z`,wash(ctx,-18,12,c.light,c.coat,c.dark),'#293c37',.6);
    art(ctx,'M3 -15 L6.9 -15.4 L9 -13.1 L7.2 -10.8 L4.1 -11.4Z',c.edge);ctx.restore();
  }
}

function impact(ctx:Brush,x:number,y:number,r:number,p:number,color:string) {
  if(p<0||p>=1)return;
  ctx.save();ctx.globalAlpha=1-p;
  for(let i=0;i<5;i++){
    const a=-Math.PI*.89+i*.56;
    const dist=r*(.35+p*.9);const xx=x+Math.cos(a)*dist,yy=y+Math.sin(a)*dist-p*r*.44;
    oval(ctx,i%2?'#a39c84':'#797e72',xx,yy,r*(.16+p*.14),r*(.17+p*.12));
  }
  const burst=r*(.3+.7*Math.sin(Math.min(1,p*1.8)*Math.PI));
  const points:number[]=[];
  for(let i=0;i<16;i++){
    const angle=i*Math.PI/8,len=(i%2?.40:1)*burst;
    points.push(x+Math.cos(angle)*len,y+Math.sin(angle)*len);
  }
  if(p<.65){polygon(ctx,color,points);oval(ctx,'#fff5bb',x,y,burst*.29,burst*.29);}
  for(let i=0;i<6;i++){
    const a=i*Math.PI/3+.25,dist=r*(.7+p*.8);
    rect(ctx,'#ffd085',x+Math.cos(a)*dist,y+Math.sin(a)*dist+p*p*r*.4,2.5,1.5);
  }
  ctx.restore();
}
function paintedShell(ctx:Brush,x:number,y:number,angle:number,kind:ArmyKind,s:number,color:string) {
  const heavy=kind==='artillery',air=kind==='air';
  ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.scale(s,s);
  if(air){
    polygon(ctx,ink,[-9,-4,-5,-2,2,-3,7,-1,8,0,6,2,2,3,-5,2,-9,4,-7,0]);
    polygon(ctx,'#a5b6b0',[-6,-1,1,-2,5,-1,6,0,2,1,-4,1]);
  }else{
    const half=heavy?8:6,height=heavy?3.8:2.7;
    // A bright tail, drawn behind an outlined solid body with a distinct nose.
    polygon(ctx,'#ed7d34bb',[-half, -height*.85,-half-11, -1,-half-20,0,-half-9,2,-half,height*.85]);
    polygon(ctx,'#fff1a7',[-half,-height*.52,-half-12,0,-half,height*.52]);
    polygon(ctx,ink,[-half,-height,half-2,-height,half+4,0,half-2,height,-half,height]);
    polygon(ctx,heavy?'#b98f56':'#a1b8be',[-half+1,-height+1,half-2,-height+1,half+2,0,half-2,height-1,-half+1,height-1]);
    rect(ctx,'#fff5cc',-half+2,-height+1,half+1,1.2);
    rect(ctx,color,-half+2,-height+1,2.5,height*2-2);
    if(heavy)rect(ctx,'#563b32',half-4,-height+1,1.5,height*2-2);
  }
  ctx.restore();
}
function grenade(ctx:Brush,x:number,y:number,angle:number,scale:number,signal:string){
  ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.scale(scale,scale);
  oval(ctx,ink,0,0,5.4,6.5);oval(ctx,'#56613d',0,.2,4.6,5.5);
  line(ctx,'#99a66b',.9,[-2.1,-4.3,-2.2,3.3]);line(ctx,'#a3a975',.8,[-3.8,-1.1,3.7,-1.2]);
  line(ctx,signal,1.2,[-2.5,2.4,2.8,2.1]);
  rect(ctx,'#c1bda7',-2,-7.2,4,2.7);
  line(ctx,ink,2.5,[-1.7,-7.4,2.7,-7.5,5.9,-1.6]);
  line(ctx,'#dcd2b1',1.4,[-1.7,-7.4,2.7,-7.5,5.9,-1.6]);ctx.restore();
}
export function drawArmyFire(ctx:Brush,x1:number,y1:number,x2:number,y2:number,side:ArmySide,kind:ArmyKind,progress:number,scale=1,second:number|null=.22) {
  if(progress<0||progress>=1)return;
  const color=colors[side].signal,travel=ARMY_PROJECTILE_TRAVEL[kind];
  if(kind==='infantry'){
    for(const delay of second===null?[0]:[0,second]){
      const p=progress-delay;
      if(p<0)continue;
      if(p<.1)impact(ctx,x1,y1,5*scale,p*8,color);
      if(p<travel){
        const t=p/travel,trail=Math.max(0,t-.15);
        line(ctx,color,2*scale,[x1+(x2-x1)*trail,y1+(y2-y1)*trail,x1+(x2-x1)*t,y1+(y2-y1)*t]);
      }else impact(ctx,x2,y2,7*scale,(p-travel)/.30,'#ffcf79');
    }
    return;
  }
  // Retain a readable projectile silhouette on a phone, even for the rear ranks.
  const s=Math.max(.86,scale),airborne=kind==='air',heavy=kind==='artillery',thrown=kind==='grenade';
  const arc=thrown?Math.min(45*s,Math.abs(x2-x1)*.72):heavy?Math.min(76*s,Math.abs(x2-x1)*.42):8*s;
  const flight=(t:number)=>[x1+(x2-x1)*t,y1+(y2-y1)*t-4*arc*t*(1-t)];
  if(progress<travel){
    const t=progress/travel,head=flight(t);
    if(thrown){
      for(const distance of [.19,.11,.045]){
        if(t<distance)continue;
        const [x,y]=flight(t-distance);oval(ctx,'#ffe4a19c',x,y,(2-distance*6)*s,s);
      }
      grenade(ctx,head[0],head[1],Math.sign(x2-x1)*t*6.4,s,color);return;
    }
    if(!airborne){
      const length=heavy?.34:.18;
      const trail:number[]=[];
      for(let i=0;i<=5;i++){
        const behind=t-length*(1-i/5);
        if(behind<0)continue;
        const [x,y]=flight(behind);trail.push(x,y);
        if(heavy&&i<4)oval(ctx,'#ddd4b872',x,y-(4-i)*.8*s,(5-i*.65)*s,(3.8-i*.45)*s);
      }
      if(trail.length>=4)line(ctx,heavy?'#ffcb7988':'#ffe396b3',heavy?3*s:1.7*s,trail);
      if(t<.28)impact(ctx,x1,y1,(heavy?14:10)*s,t/.28,'#ffd071');
    }
    const angle=Math.atan2(y2-y1-4*arc*(1-2*t),x2-x1);
    paintedShell(ctx,head[0],head[1],angle,kind,s,color);
  }else{
    const p=(progress-travel)/(1-travel);
    const radius=(airborne?26:heavy?25:thrown?12:16)*s;
    ctx.save();ctx.globalAlpha=(1-p)*.85;ctx.lineWidth=(heavy?2.3:1.5)*s;ctx.strokeStyle=heavy?'#ffe2a0':color;
    const size=radius*(.32+1.28*p);ctx.beginPath();ctx.ellipse(x2,y2+2*s,size,size*.32,0,0,Math.PI*2);ctx.stroke();
    ctx.restore();
    impact(ctx,x2,y2,radius,p,'#ff994b');
    if(airborne){
      for(const offset of [-1,1])impact(ctx,x2+offset*radius*.96,y2+offset*2*scale,radius*.65,(p-.18)/.82,'#ffa24b');
    }
  }
}
