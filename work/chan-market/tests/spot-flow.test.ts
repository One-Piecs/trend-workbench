import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpotFlowReader} from '../lib/spot-flow.ts';

const start=1800000000;
function windowFor(n:number,overrides:Record<string,string>={}){
  return new URLSearchParams({symbol:'BTCUSDT',venue:'Binance',start:String(start),end:String(start+n*60),...overrides});
}
function row(i:number,close:number,buy='1.5',volume='2'){
  const open=(start+i*60)*1000;
  return [open,'100','120','80',String(close),volume,open+59999,'200',5,buy,'150','0'];
}
const now=()=>1000*(start+86400);
function reader(rows:unknown){
  return createSpotFlowReader(async()=>Response.json(rows),now);
}

test('spot volumes for closed BTC and ETH windows use same venue and actual taker sizes',async()=>{
  let count=0;
  const read=createSpotFlowReader(async(url)=>{
    count++;
    const parsed=new URL(String(url));
    assert.equal(parsed.host,'data-api.binance.vision');
    assert.equal(parsed.pathname,'/api/v3/klines');
    assert.equal(parsed.searchParams.get('interval'),'1m');
    assert.equal(parsed.searchParams.get('startTime'),String(start*1000));
    assert.equal(parsed.searchParams.get('endTime'),String((start+120)*1000-1));
    assert.ok(['BTCUSDT','ETHUSDT'].includes(parsed.searchParams.get('symbol')!));
    return Response.json([row(0,90,'2'),row(1,95,'0','3')]);
  },now);
  for(const baseAsset of ['BTC','ETH']){
    const query=windowFor(2,{symbol:baseAsset+'USDT'});
    const [a,b]=await Promise.all([read(query),read(query)]);
    assert.deepEqual(a,b);
    assert.equal(a.status,'ready');
    if(a.status==='ready')assert.deepEqual([a.baseAsset,a.buyVolume,a.sellVolume,a.buyShare,a.minutes,a.observedStart,a.observedEnd],[baseAsset,2,3,0.4,2,start,start+120]);
    await read(query);
  }
  assert.equal(count,2);
});
test('down- and up-crossing inspect the final run and at most five minutes, including the closing minute of the cross',async()=>{
  const closes=[101,102,100,101,101,104,103,102,103];
  for(const direction of ['up','down']){
    const rows=closes.map((n,i)=>row(i,direction==='up'?n:200-n,String(i),'10'));
    const read=reader(rows);
    const observed=await read(windowFor(rows.length,{direction,boundary:'100'}));
    assert.equal(observed.status,'ready');
    if(observed.status==='ready')assert.deepEqual(
      [observed.observedStart,observed.observedEnd,observed.minutes,observed.buyVolume,observed.sellVolume],
      [start+180,start+480,5,25,25]);
    const wrong=await read(windowFor(rows.length,{direction:direction==='up'?'down':'up',boundary:'100'}));
    assert.ok(wrong.status==='unavailable'&&wrong.reason==='incomplete');
  }
  const one=await reader([row(0,100),row(1,101)])(windowFor(2,{direction:'up',boundary:'100'}));
  assert.ok(one.status==='ready'&&one.minutes===1&&one.observedStart===start+60&&one.observedEnd===start+120);
});
test('requires ordered, complete closed minutes and nonmissing nonnegative base/taker volume',async()=>{
  for(const rows of [[row(0,100)], [row(1,100),row(0,100)], [row(0,100),row(0,101)],
    [row(0,100),row(1,100,'')], [row(0,100),row(1,100,'3')], [row(0,100),row(1,100,'-1')],
    [row(0,100),row(1,100).slice(0,9)], [row(0,100),row(1,100).map((v,i)=>i===6?1:v)]]){
    const result=await reader(rows)(windowFor(2));
    assert.ok(result.status==='unavailable'&&result.reason==='incomplete');
  }
  const empty=await reader([row(0,100,'0','0')])(windowFor(1));
  assert.ok(empty.status==='unavailable'&&empty.reason==='no-trades');
});
test('unsupported chart sources and pairs do not fetch, unfinished windows never return a reading',async()=>{
  let calls=0;
  const read=createSpotFlowReader(async()=>{calls++;return Response.json([]);},()=>start*1000);
  const unsupported:Record<string,string>[]=[{venue:'Kraken'},{venue:'OKX'},{symbol:'BTCUSD'},{symbol:'XRPUSDT'}];
  for(const overrides of unsupported){
    const result=await read(windowFor(1,overrides));
    assert.ok(result.status==='unavailable'&&result.reason==='unsupported');
  }
  assert.deepEqual((await read(windowFor(1))).status,'unavailable');
  for(const params of [windowFor(0),windowFor(61),windowFor(241,{direction:'up',boundary:'1'}),windowFor(2,{direction:'up'}),
    windowFor(2,{boundary:'1'}),windowFor(2,{boundary:'0',direction:'down'}),windowFor(1,{start:String(start+1)})]){
    await assert.rejects(read(params),RangeError);
  }
  assert.equal(calls,0);
});
test('upstream throttling is honored across windows and a failed request can recover',async()=>{
  let ts=now(),calls=0;
  const read=createSpotFlowReader(async()=>{
    calls++;
    return calls===1?new Response('',{status:429,headers:{'retry-after':'30'}}):Response.json([row(0,100)]);
  },()=>ts);
  for(const n of [1,2]){
    const result=await read(windowFor(n));
    assert.ok(result.status==='unavailable'&&result.reason==='upstream');
  }
  assert.equal(calls,1);
  ts+=31000;
  assert.equal((await read(windowFor(1))).status,'ready');
});

function hourlyFixture(hours:number,direction:'up'|'down',lastInside:number,allWick=false,brokenHour=false){
  const calls:string[]=[];
  const reflect=(price:number)=>direction==='up'?price:200-price;
  function minute(i:number){
    const p=reflect(i===lastInside?100:105),wick=allWick?100:p;
    return [String(p),String(Math.max(p,wick)),String(Math.min(p,wick)),String(p)];
  }
  const read=createSpotFlowReader(async input=>{
    const q=new URL(String(input)).searchParams,interval=q.get('interval')!;
    calls.push(interval);
    const first=Number(q.get('startTime'))/1000,limit=Number(q.get('limit')),span=interval==='1h'?3600:60;
    const rows=[];
    for(let j=0;j<limit;j++){
      const t=first+j*span,i=(t-start)/60;
      const members=Array.from({length:span/60},(_,k)=>minute(i+k));
      rows.push([t*1000,members[0][0],String(Math.max(...members.map(r=>Number(r[1])))+(brokenHour&&span===3600?1:0)),
        String(Math.min(...members.map(r=>Number(r[2])))),members.at(-1)![3],String(2*span/60),
        (t+span)*1000-1,'200',span/60,String(span/60),'150','0']);
    }
    return Response.json(rows);
  },()=>1000*(start+hours*3600));
  const params=windowFor(hours*60,{direction,boundary:'100',parentClose:String(reflect(105))});
  return {read,params,calls};
}
test('day, week and month resolve the actual crossing minute across an hourly boundary with three reads',async()=>{
  for(const hours of [24,168,744])for(const direction of ['up','down'] as const){
    const lastInside=2*60+58;
    const {read,params,calls}=hourlyFixture(hours,direction,lastInside);
    const result=await read(params);
    assert.ok(result.status==='ready');
    assert.deepEqual([result.observedStart,result.observedEnd,result.minutes,result.buyVolume,result.sellVolume],
      [start+(lastInside+1)*60,start+(lastInside+6)*60,5,5,5]);
    assert.deepEqual(calls,['1h','1m','1m']);
    assert.deepEqual(await read(params),result);
    assert.equal(calls.length,3);
  }
});
test('an entire run outside starts at the first minute; an inside hourly close allows the next hour to start it',async()=>{
  for(const lastInside of [-1,119]){
    const {read,params,calls}=hourlyFixture(24,'up',lastInside);
    const result=await read(params);
    assert.ok(result.status==='ready'&&result.observedStart===start+(lastInside+1)*60);
    assert.deepEqual(calls,['1h','1m']);
  }
});
test('dense inconclusive hours stop at the bounded request budget instead of guessing the last minutes',async()=>{
  const {read,params,calls}=hourlyFixture(24,'up',1,true);
  const result=await read(params);
  assert.ok(result.status==='unavailable'&&result.reason==='budget');
  assert.deepEqual(calls,['1h',...Array(8).fill('1m')]);
});
test('mismatched final selected close or minute and hourly OHLC cannot produce a flow reading',async()=>{
  const {read,params,calls}=hourlyFixture(24,'up',118);
  params.set('parentClose','106');
  let result=await read(params);
  assert.ok(result.status==='unavailable'&&result.reason==='incomplete');
  assert.deepEqual(calls,['1h']);
  const bad=hourlyFixture(24,'up',118,false,true);
  result=await bad.read(bad.params);
  assert.ok(result.status==='unavailable'&&result.reason==='incomplete');
  result=await reader([row(0,100),row(1,101)])(windowFor(2,{direction:'up',boundary:'100',parentClose:'102'}));
  assert.ok(result.status==='unavailable'&&result.reason==='incomplete');
});
