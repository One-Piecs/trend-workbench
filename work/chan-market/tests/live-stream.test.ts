import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeLiveCandles, getLiveTarget, subscribeLiveCandles } from '../lib/live-stream.ts';
import type { LiveTarget } from '../lib/live-stream.ts';
import type { Instrument, Interval } from '../lib/market-types';

const start = Date.UTC(2026,10,20,6), now = start+15000;
function target(exchange: string, id: string, interval: Interval = '1h') {
  const instrument: Instrument = {id:'crypto:BTCUSDT',symbol:'BTCUSDT',name:'Bitcoin',market:'crypto',currency:'USDT',exchange};
  return getLiveTarget({instrument, interval, source:exchange+' 公共现货行情 · '+id});
}
const candle = {time:start/1000, open:100, high:103, low:99, close:101, volume:8, closed:false};
const row = [String(start),'100','103','99','101','8','808','808'];
const binance = {e:'kline', E:now-100, s:'BTCUSDT', k:{s:'BTCUSDT', i:'1h',t:start,o:'100',h:'103',l:'99',c:'101',v:'8',x:false}};
const key = target('Binance','BTCUSDT')!;

test('sockets require the same verified spot venue, quote, and natively supported period', () => {
  assert.equal(target('Kraken','XBTUSDT')?.pair, 'BTC/USDT');
  assert.equal(target('OKX','BTC-USDT')?.pair, 'BTC-USDT');
  assert.equal(target('Kraken','XBTUSDT','1M'), null);
  assert.equal(target('Kraken','XBTUSD'), null);
  assert.equal(target('Binance','ETHUSDT'), null);
  assert.equal(target('custom','BTCUSDT'), null);
  assert.equal(getLiveTarget({interval:'1h',source:'Binance 公共现货行情 · BTCUSDT', instrument:{id:'us:BTCUSDT',name:'',exchange:'Binance',symbol:'BTCUSDT',currency:'USDT',market:'us'}}), null);
});

test('five upstream formats provide cumulative base volume, bar start and publication time', () => {
  const samples: [LiveTarget,unknown,number][] = [
    [key, binance, now-100],
    [target('OKX','BTC-USDT')!, {arg:{instId:'BTC-USDT',channel:'candle1H'}, data:[[...row,'0']]}, now],
    [target('Bitget','BTCUSDT')!, {arg:{instId:'BTCUSDT',instType:'SPOT',channel:'candle1H'},action:'update',ts:now-100,data:[row]}, now-100],
    [target('Bybit','BTCUSDT')!, {topic:'kline.60.BTCUSDT',type:'snapshot',ts:now-50,data:[{start,interval:'60',open:'100',high:'103',low:'99',close:'101',volume:'8',confirm:false}]}, now-50],
    [target('Kraken','XBTUSDT')!, {channel:'ohlc',type:'update',data:[{symbol:'BTC/USDT',interval:60,interval_begin:new Date(start).toISOString(),open:100,high:103,low:99,close:101,volume:8}]}, now],
  ];
  for (const [sub,msg,eventTimeMs] of samples) assert.deepEqual(decodeLiveCandles(sub,msg,now), [{candle,eventTimeMs}], sub.provider);
});

test('wrong venue packet identity, empty prices, stale event, future bars and false closes are ignored', () => {
  for (const change of [{s:'ETHUSDT'},{i:'1m'},{l:' '},{v:null},{h:'100'},{t:start+1000},{t:start+3600000},{x:true}])
    assert.deepEqual(decodeLiveCandles(key,{...binance,k:{...binance.k,...change}},now),[]);
  assert.deepEqual(decodeLiveCandles(key,{...binance,E:now-100000},now),[]);
  assert.deepEqual(decodeLiveCandles(key,{...binance,E:now+9000},now),[]);
  const close = start+3600000;
  assert.equal(decodeLiveCandles(key,{...binance,E:close,k:{...binance.k,x:true}},close+500)[0]?.candle.closed,true);
  assert.equal(decodeLiveCandles(key,{...binance,E:close,k:{...binance.k,x:true}},close+100000).length,0);
  assert.deepEqual(decodeLiveCandles(target('Bitget','BTCUSDT')!,{arg:{instType:'USDT-FUTURES',instId:'BTCUSDT',channel:'candle1H'},action:'update',data:[row]},now),[]);
});

test('native weekly boundaries follow the selected venue; UTC monthly candles demand month starts', () => {
  const monday = Date.UTC(2026,10,16), thursday = Date.UTC(2026,10,19), month = Date.UTC(2026,10,1);
  const kraken = (time:number) => ({channel:'ohlc',type:'update',data:[{symbol:'BTC/USDT',interval:10080,interval_begin:new Date(time).toISOString(),open:100,high:103,low:99,close:101,volume:8}]});
  const weekly = target('Kraken','XBTUSDT','1w')!;
  assert.equal(decodeLiveCandles(weekly,kraken(thursday),now)[0]?.candle.time,thursday/1000);
  assert.equal(decodeLiveCandles(weekly,kraken(monday),now).length,0);
  for (const [interval,ts] of [['1M',month],['1w',monday]] as const) {
    const msg = {...binance,k:{...binance.k,i:interval,t:ts}};
    assert.equal(decodeLiveCandles({...key,interval},msg,now)[0]?.candle.time,ts/1000);
    assert.equal(decodeLiveCandles({...key,interval},{...msg,k:{...msg.k,t:ts-8*3600000}},now).length,0);
  }
});

test('handshake alone is not live; stale connection falls back, retries, and disposal cancels pending work', t => {
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now});
  const sockets: WebSocket[] = [], statuses: string[] = [], closes: number[] = [];
  let shutdowns = 0;
  const off = subscribeLiveCandles(key,{onStatus:s=>statuses.push(s),onCandle:c=>closes.push(c.close)},() => {
    const socket = {send(){},close(){shutdowns++;}} as unknown as WebSocket;
    sockets.push(socket);
    return socket;
  });
  const original = sockets[0];
  original.onopen?.(new Event('open'));
  original.onmessage?.(new MessageEvent('message',{data:'{"event":"subscribe"}'}));
  assert.deepEqual(statuses,['connecting']);
  const lateMessage = original.onmessage!;
  const tick = new MessageEvent('message',{data:JSON.stringify(binance)});
  original.onmessage?.(tick);
  assert.deepEqual(statuses,['connecting','live']);
  assert.deepEqual(closes,[101]);
  t.mock.timers.tick(35001);
  assert.deepEqual(statuses,['connecting','live','fallback']);
  t.mock.timers.tick(2000);
  assert.equal(sockets.length,2);
  lateMessage.call(original,tick);
  assert.deepEqual(closes,[101]);
  off();
  t.mock.timers.tick(100000);
  assert.equal(sockets.length,2);
  assert.equal(shutdowns,2);
});
