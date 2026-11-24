import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeBattleTrades,subscribeBattleTrades,type BattleFrame} from '../lib/battle-stream.ts';
import {battleTier} from '../lib/battle-deployment.ts';

const epoch=1700000000000;
const tick=(t:number,extra:Record<string,unknown>={})=>({e:'trade',s:'BTCUSDT',t,T:epoch,p:'100',q:'2',m:false,...extra});
const okx={arg:{instId:'BTC-USDT',channel:'trades-all'},data:[{instId:'BTC-USDT',tradeId:'8',ts:String(epoch),px:'100',sz:'2',side:'sell'}]};
class MockSocket {
  onopen:(()=>void)|null=null;
  onmessage:((event:{data:string})=>void)|null=null;
  onclose:(()=>void)|null=null;
  onerror:(()=>void)|null=null;
  closed=false;
  sent:string[]=[];
  send(data:string){this.sent.push(data);}
  close(){this.closed=true;}
  push(raw:unknown){this.onmessage?.({data:JSON.stringify(raw)});}
}

test('native spot match decoders preserve venue, ID and taker side and reject aggregated, stale or wrong-symbol data',()=>{
  assert.deepEqual(decodeBattleTrades('BTCUSDT','Binance',tick(8),epoch),[
    {id:'Binance/BTCUSDT/8',time:epoch/1000,side:'buy',price:100,notional:200}]);
  assert.deepEqual(decodeBattleTrades('BTCUSDT','OKX',okx,epoch),[
    {id:'OKX/BTCUSDT/8',time:epoch/1000,side:'sell',price:100,notional:200}]);
  for(const patch of [{s:'ETHUSDT'},{e:'aggTrade'},{T:epoch-11000},{T:epoch+10000},{q:'0'},{m:1},{p:'Infinity'}]){
    assert.deepEqual(decodeBattleTrades('BTCUSDT','Binance',tick(1,patch),epoch),[]);
  }
  assert.deepEqual(decodeBattleTrades('BTCUSDT','OKX',{...okx,arg:{...okx.arg,channel:'trades'}},epoch),[]);
  assert.deepEqual(decodeBattleTrades('ETHUSDT','OKX',okx,epoch),[]);
});

test('every new match counts once through bursts while effects stay bounded, include both sides, and expire in silence',t=>{
  t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:epoch});
  const socket=new MockSocket(),frames:BattleFrame[]=[],states:string[]=[];
  let quiet=0;
  const stop=subscribeBattleTrades('BTCUSDT','Binance',{onFrame:f=>frames.push(f),onStatus:s=>states.push(s),onQuiet:()=>quiet++},
    undefined,url=>{assert.match(url,/btcusdt@trade$/);return socket as unknown as WebSocket;});
  try{
    socket.onopen?.();
    socket.push(tick(0,{m:true,q:'100'}));
    for(let i=1;i<=200;i++)socket.push(tick(i));
    socket.push(tick(120));socket.push(tick(200));socket.push(tick(120,{T:epoch-1000}));
    t.mock.timers.tick(180);
    const {flow,events,deltas}=frames.at(-1)!;
    assert.deepEqual([flow.count,flow.buy,flow.sell,flow.limited],[201,40000,10000,true]);
    assert.deepEqual([flow.largest.side,flow.largest.amount],['sell',10000]);
    assert.ok(events.length<=26);assert.ok(events.find(e=>e.side==='sell'));assert.ok(events.find(e=>e.side==='buy'));
    assert.deepEqual(deltas,[{at:epoch,side:'buy',notional:40000},{at:epoch,side:'sell',notional:10000}]);
    assert.equal(flow.buckets.at(-1)!.sell,10000);assert.deepEqual(states,['connecting','live']);
    t.mock.timers.tick(1000);assert.deepEqual(frames.at(-1)!.deltas,[]);
    for(let i=0;i<6;i++){
      t.mock.timers.tick(10000);
      socket.push({id:1,result:['btcusdt@trade']});
    }
    assert.equal(quiet,1);
    socket.push(tick(250,{T:Date.now()}));t.mock.timers.tick(180);
    assert.equal(frames.at(-1)!.flow.count,1);assert.equal(frames.at(-1)!.flow.limited,false);
  }finally{stop();}
  assert.equal(socket.closed,true);assert.equal(socket.onmessage,null);
});

test('fresh deltas for charges exclude replays and stale prints and wait for the exchange timestamp',t=>{
  t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:epoch});
  const socket=new MockSocket(),frames:BattleFrame[]=[];
  const stop=subscribeBattleTrades('BTCUSDT','Binance',{onFrame:f=>frames.push(f),onStatus:()=>{}},null,()=>socket as unknown as WebSocket);
  try{
    socket.onopen?.();
    socket.push(tick(1,{T:epoch-900}));
    socket.push(tick(2,{T:epoch+420,m:true}));
    socket.push(tick(3));
    socket.push(tick(3));
    t.mock.timers.tick(180);
    assert.deepEqual(frames.at(-1)!.deltas,[{at:epoch,side:'buy',notional:200}]);
    assert.equal(frames.at(-1)!.flow.sell,0);
    assert.ok(frames.at(-1)!.events.every(print=>print.time*1000<=Date.now()));
    t.mock.timers.tick(1100);
    assert.deepEqual(frames.at(-1)!.deltas,[{at:epoch+420,side:'sell',notional:200}]);
    t.mock.timers.tick(4200);
    socket.push(tick(4,{T:epoch+100}));
    t.mock.timers.tick(180);
    assert.deepEqual(frames.at(-1)!.deltas,[]);
  }finally{stop();}
});

test('loss of transport retries with a new connection, stale callbacks are ignored and unmount stops reconnection',t=>{
  t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:epoch});
  const sockets:MockSocket[]=[],frames:BattleFrame[]=[],states:string[]=[];
  const stop=subscribeBattleTrades('BTCUSDT','OKX',{onFrame:f=>frames.push(f),onStatus:s=>states.push(s)},undefined,()=>{
    const socket=new MockSocket();sockets.push(socket);return socket as unknown as WebSocket;
  });
  sockets[0].onopen?.();assert.equal(JSON.parse(sockets[0].sent[0]).args[0].channel,'trades-all');
  const oldMessage=sockets[0].onmessage;
  sockets[0].onerror?.();t.mock.timers.tick(1000);
  assert.equal(sockets.length,2);assert.equal(sockets[0].closed,true);
  sockets[1].onopen?.();oldMessage?.({data:JSON.stringify(okx)});t.mock.timers.tick(180);
  assert.equal(frames.length,0);
  sockets[1].push(okx);t.mock.timers.tick(180);
  assert.deepEqual(states,['connecting','retrying','live']);assert.equal(frames[0].flow.sell,200);
  assert.deepEqual(frames[0].deltas,[]);
  sockets[1].onclose?.();stop();t.mock.timers.tick(60000);
  assert.equal(sockets.length,2);
});

test('stream quote follows exchange match time then numeric ID across out-of-order bursts and delayed future matches',t=>{
  t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:epoch});
  const socket=new MockSocket(),frames:BattleFrame[]=[];
  const stop=subscribeBattleTrades('BTCUSDT','Binance',{onFrame:f=>frames.push(f),onStatus:()=>{}},null,()=>socket as unknown as WebSocket);
  try{
    socket.onopen?.();
    socket.push(tick(100,{p:'103'}));socket.push(tick(99,{p:'102'}));
    socket.push(tick(102,{T:epoch-500,p:'300',q:'99999'}));
    socket.push(tick(103,{T:epoch+450,p:'104'}));
    t.mock.timers.tick(180);
    assert.deepEqual(frames.at(-1)?.lastTrade,{id:'100',time:epoch/1000,price:103});
    t.mock.timers.tick(500);
    assert.deepEqual(frames.at(-1)?.lastTrade,{id:'103',time:(epoch+450)/1000,price:104});
  }finally{stop();}
});

test('two cannon-size fills on the same side survive a burst of small trades before the first frame',t=>{
  t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:epoch});
  const socket=new MockSocket(),frames:BattleFrame[]=[];
  const stop=subscribeBattleTrades('BTCUSDT','Binance',{onFrame:f=>frames.push(f),onStatus:()=>{}},null,()=>socket as unknown as WebSocket);
  try{
    socket.onopen?.();
    socket.push(tick(1,{q:'500'}));
    socket.push(tick(2,{q:'2500'}));
    for(let i=3;i<=130;i++)socket.push(tick(i));
    t.mock.timers.tick(180);
    const {flow,events}=frames.at(-1)!;
    assert.equal(flow.count,130);
    assert.deepEqual(events.filter(e=>e.notional>=50_000).map(e=>battleTier(e.notional)),['armor','artillery']);
    assert.deepEqual([9_999.99,10_000,49_999.99,50_000,249_999,250_000,999_999,1_000_000].map(battleTier),
      ['infantry','grenade','grenade','armor','armor','artillery','artillery','air']);
  }finally{stop();}
});
