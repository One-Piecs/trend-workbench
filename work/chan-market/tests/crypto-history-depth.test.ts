import test from 'node:test';
import assert from 'node:assert/strict';
import { createCryptoClient, CryptoDataError } from '../lib/crypto-sources.ts';

const clock=()=>Date.UTC(2026,10,14,8,0,30);
const latest=clock()-30000;
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const binanceDirectory=(base='SOL',quote='USDT')=>({symbols:[{symbol:base+quote,status:'TRADING',baseAsset:base,quoteAsset:quote,isSpotTradingAllowed:true}]});
const okxDirectory=(base='SOL',quote='USDT')=>({code:'0',data:[{instId:`${base}-${quote}`,baseCcy:base,quoteCcy:quote,state:'live'}]});
const unrelatedKrakenDirectory=()=>({error:[],result:{XETHZUSD:{altname:'ETHUSD',wsname:'ETH/USD',status:'online'}}});
function binanceRows(count:number,price=100,end=latest) {
  return Array.from({length:count},(_,i)=>[end-i*60000,String(price),String(price+3),String(price-2),String(price+1),'7',end-i*60000+59999]).reverse();
}
function okxRows(count:number,price=250,end=latest) {
  return Array.from({length:count},(_,i)=>[String(end-i*60000),String(price),String(price+3),String(price-2),String(price+1),'11','0','0',end-i*60000===latest?'0':'1']);
}
function binancePage(url:URL,history:unknown[][],cap=1000) {
  const end=Number(url.searchParams.get('endTime')??Infinity);
  return reply(history.filter(row=>Number(row[0])<=end).slice(-Math.min(cap,Number(url.searchParams.get('limit')))));
}
function okxPage(url:URL,history:unknown[][],inclusive=false) {
  const after=Number(url.searchParams.get('after')??Infinity);
  return reply({code:'0',data:history.filter(row=>inclusive?Number(row[0])<=after:Number(row[0])<after).slice(0,Number(url.searchParams.get('limit')))});
}
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}

test('an initially successful short feed is replaced wholesale by a deeper current listing of the same pair',async()=>{
  let binanceRequests=0,okxPages=0;
  const client=createCryptoClient(async value=>{
    const url=new URL(value);
    if(value.includes('binance')) {
      binanceRequests++;
      return value.includes('exchangeInfo')?reply(binanceDirectory()):binancePage(url,binanceRows(80));
    }
    if(value.includes('instruments'))return reply(okxDirectory());
    if(value.includes('okx')){okxPages++;return okxPage(url,okxRows(900));}
    return reply(unrelatedKrakenDirectory());
  },clock);
  const data=await client.getCryptoCandles('SOL/USDT','1m',800);
  assert.equal(data.instrument.exchange,'OKX');assert.equal(data.instrument.symbol,'SOLUSDT');assert.equal(data.instrument.currency,'USDT');
  assert.equal(data.candles.length,800);assert.equal(okxPages,3);
  assert.ok(data.candles.every(c=>c.open===250&&c.volume===11),'prices and volume must all come from the chosen venue');
  assert.equal(data.candles.at(-1)?.time,latest/1000);assert.equal(data.candles.at(-1)?.closed,false);
  const previousRequests=binanceRequests;
  await client.getCryptoCandles('SOLUSDT','1m',100);
  assert.equal(binanceRequests,previousRequests,'reuse the winning source, not the first short success');
});

test('an older deep alternative cannot replace a fresher short feed',async()=>{
  let checkedAlternative=false;
  const client=createCryptoClient(async value=>{
    const url=new URL(value);
    if(value.includes('binance'))return value.includes('exchangeInfo')?reply(binanceDirectory()):binancePage(url,binanceRows(80));
    if(value.includes('instruments'))return reply(okxDirectory());
    if(value.includes('okx')){checkedAlternative=true;return okxPage(url,okxRows(900,250,latest-60000));}
    return reply(unrelatedKrakenDirectory());
  },clock);
  const data=await client.getCryptoCandles('SOLUSDT','1m',800);
  assert.ok(checkedAlternative);assert.equal(data.instrument.exchange,'Binance');assert.equal(data.candles.length,80);
  assert.equal(data.candles.at(-1)?.time,latest/1000);assert.match(data.warnings.join(' '),/80根/);
});

test('a full but stale first response still seeks the newer coverage of another source',async()=>{
  const client=createCryptoClient(async value=>{
    const url=new URL(value);
    if(value.includes('binance'))return value.includes('exchangeInfo')?reply(binanceDirectory()):binancePage(url,binanceRows(800,100,latest-60000));
    if(value.includes('instruments'))return reply(okxDirectory());
    if(value.includes('okx'))return okxPage(url,okxRows(60));
    return reply(unrelatedKrakenDirectory());
  },clock);
  const data=await client.getCryptoCandles('SOLUSDT','1m',800);
  assert.equal(data.instrument.exchange,'OKX');assert.equal(data.candles.length,60);
  assert.equal(data.candles.at(-1)?.close,251);
});

test('Binance endTime pagination fills the requested 800 bars when pages are shorter than the requested size',async()=>{
  const history=binanceRows(1000),cursors:number[]=[];let pages=0;
  const client=createCryptoClient(async value=>{
    if(value.includes('exchangeInfo'))return reply(binanceDirectory());
    assert.ok(value.includes('/klines'));
    const url=new URL(value);pages++;
    assert.ok(Number(url.searchParams.get('limit'))<=1000);
    if(url.searchParams.has('endTime'))cursors.push(Number(url.searchParams.get('endTime')));
    return binancePage(url,history,300);
  },clock);
  const data=await client.getCryptoCandles('SOLUSDT','1m',800);
  assert.equal(pages,3);assert.equal(data.candles.length,800);assert.equal(new Set(data.candles.map(c=>c.time)).size,800);
  assert.deepEqual(cursors,[latest-299*60000-1,latest-599*60000-1]);
  assert.equal(data.candles[0].time,(latest-799*60000)/1000);
  assert.ok(data.candles.slice(0,-1).every(c=>c.closed));assert.equal(data.candles.at(-1)?.closed,false);
});

test('OKX counts unique valid bars, tolerating inclusive boundary overlap without manufacturing depth',async()=>{
  const history=okxRows(1000);history[100][2]='0';let pages=0;
  const client=createCryptoClient(async value=>{
    if(value.includes('binance'))return reply({},403);
    if(value.includes('instruments'))return reply(okxDirectory());
    assert.ok(value.includes('okx'));
    const url=new URL(value);pages++;assert.ok(Number(url.searchParams.get('limit'))<=300);
    return okxPage(url,history,true);
  },clock);
  const data=await client.getCryptoCandles('SOLUSDT','1m',800);
  assert.equal(pages,3);assert.equal(data.candles.length,800);assert.equal(new Set(data.candles.map(c=>c.time)).size,800);
  assert.equal(data.candles[0].time,(latest-800*60000)/1000);
  assert.ok(!data.candles.some(c=>c.time===(latest-100*60000)/1000),'the invalid raw row is omitted, never repaired or duplicated');
});

test('non-progressing pagination stops and preserves genuinely short listing history',async()=>{
  let pages=0;
  const client=createCryptoClient(async value=>{
    if(value.includes('binance'))return reply({},403);
    if(value.includes('instruments'))return reply(okxDirectory());
    if(value.includes('okx')){pages++;return reply({code:'0',data:okxRows(7)});}
    return reply(unrelatedKrakenDirectory());
  },clock);
  const data=await client.getCryptoCandles('SOLUSDT','1m',800);
  assert.equal(pages,2);assert.equal(data.candles.length,7);assert.match(data.warnings.join(' '),/7根/);
  assert.equal(new Set(data.candles.map(c=>c.time)).size,7);
});

test('a later backfill failure preserves the earlier live page while alternatives remain unavailable',async()=>{
  for(const provider of ['binance','okx'] as const) {
    let pages=0;
    const client=createCryptoClient(async value=>{
      if(!value.includes(provider))return reply({},403);
      if(value.includes('exchangeInfo'))return reply(binanceDirectory());
      if(value.includes('instruments'))return reply(okxDirectory());
      pages++;
      if(pages>1)return reply({},500);
      return provider==='binance'?reply(binanceRows(50)):reply({code:'0',data:okxRows(50)});
    },clock);
    const data=await client.getCryptoCandles('SOLUSDT','1m',800);
    assert.equal(pages,2);assert.equal(data.candles.length,50);assert.equal(data.candles.at(-1)?.time,latest/1000);
    assert.match(data.warnings.join(' '),/50根/);
  }
});

test('source retention below 800 remains explicit instead of filling gaps or duplicating prices',async()=>{
  const client=createCryptoClient(async value=>{
    if(!value.includes('kraken'))return reply({},403);
    if(value.includes('AssetPairs'))return reply({error:[],result:{SOLUSDT:{altname:'SOLUSDT',wsname:'SOL/USDT',status:'online'}}});
    return reply({error:[],result:{SOLUSDT:Array.from({length:720},(_,i)=>[(latest-(719-i)*60000)/1000,'100','103','98','101','100','7',1]),last:1}});
  },clock);
  const data=await client.getCryptoCandles('SOLUSDT','1m',800);
  assert.equal(data.candles.length,720);assert.equal(data.instrument.exchange,'Kraken');
  assert.match(data.warnings.join(' '),/本次仅取得720根/);assert.equal(data.candles.at(-1)?.closed,false);
});

test('identical concatenated symbols with different base/quote are not alternative feeds',async()=>{
  let mismatchedFeedRequested=false;
  const client=createCryptoClient(async value=>{
    if(value.includes('exchangeInfo'))return reply(binanceDirectory('AB','CD'));
    if(value.includes('/klines'))return binancePage(new URL(value),binanceRows(7));
    if(value.includes('instruments'))return reply(okxDirectory('A','BCD'));
    if(value.includes('okx')){mismatchedFeedRequested=true;return okxPage(new URL(value),okxRows(900));}
    return reply(unrelatedKrakenDirectory());
  },clock);
  const data=await client.getCryptoCandles('ABCD','1m',800);
  assert.equal(mismatchedFeedRequested,false);assert.equal(data.instrument.exchange,'Binance');assert.equal(data.instrument.currency,'CD');
  assert.equal(data.candles.length,7);
});

test('a failed first price request does not authorize switching to another base/quote with the same text symbol',async()=>{
  const client=createCryptoClient(async value=>{
    if(value.includes('exchangeInfo'))return reply(binanceDirectory('AB','CD'));
    if(value.includes('/klines'))return reply({},500);
    if(value.includes('instruments'))return reply(okxDirectory('A','BCD'));
    if(value.includes('okx'))throw new Error('must not fetch a different asset');
    return reply(unrelatedKrakenDirectory());
  },clock);
  await assert.rejects(client.getCryptoCandles('ABCD','1m',800),e=>e instanceof CryptoDataError&&e.message.includes('基础币或报价币不匹配'));
});

test('Kraken response identity must match its verified directory entry, including the official result alias',async()=>{
  for(const responseKey of ['XXBTZUSD','SOLUSDT']) {
    const client=createCryptoClient(async value=>{
      if(!value.includes('kraken'))return reply({},403);
      if(value.includes('AssetPairs'))return reply({error:[],result:{SOLUSDT:{altname:'SOLUSDT',wsname:'SOL/USDT',status:'online'}}});
      return reply({error:[],result:{[responseKey]:[[latest/1000,'100','103','98','101','100','7',1]],last:1}});
    },clock);
    if(responseKey==='SOLUSDT')assert.equal((await client.getCryptoCandles('SOLUSDT','1m',800)).candles.length,1);
    else await assert.rejects(client.getCryptoCandles('SOLUSDT','1m',800),e=>e instanceof CryptoDataError&&e.message.includes('交易对不匹配'));
  }
  const aliasedClient=createCryptoClient(async value=>{
    if(!value.includes('kraken'))return reply({},403);
    if(value.includes('AssetPairs'))return reply({error:[],result:{XXBTZUSD:{altname:'XBTUSD',wsname:'XBT/USD',status:'online'}}});
    assert.equal(new URL(value).searchParams.get('pair'),'XBTUSD');
    return reply({error:[],result:{XXBTZUSD:[[latest/1000,'100','103','98','101','100','7',1]],last:1}});
  },clock);
  const aliased=await aliasedClient.getCryptoCandles('BTCUSD','1m',800);
  assert.equal(aliased.instrument.symbol,'BTCUSD');assert.equal(aliased.instrument.currency,'USD');assert.equal(aliased.candles.length,1);
});

test('future-dated rows cannot win the newest-coverage selection or become visible K lines',async()=>{
  const client=createCryptoClient(async value=>{
    const url=new URL(value);
    if(value.includes('binance'))return value.includes('exchangeInfo')?reply(binanceDirectory()):binancePage(url,binanceRows(70,100,latest+60000));
    if(value.includes('instruments'))return reply(okxDirectory());
    if(value.includes('okx'))return okxPage(url,okxRows(900));
    return reply(unrelatedKrakenDirectory());
  },clock);
  const data=await client.getCryptoCandles('SOLUSDT','1m',800);
  assert.equal(data.instrument.exchange,'OKX');assert.equal(data.candles.length,800);
  assert.ok(data.candles.every(c=>c.time*1000<=clock()));
});

test('short native monthly success does not hide a deeper native listing and is never padded to 800 months',async()=>{
  const monthRows=(count:number,price:number)=>Array.from({length:count},(_,i)=>[String(Date.UTC(2026,10-i,1)),String(price),String(price+3),String(price-2),String(price+1),'11','0','0',i===0?'0':'1']);
  const client=createCryptoClient(async value=>{
    if(value.includes('exchangeInfo'))return reply(binanceDirectory());
    if(value.includes('/klines')) {
      const url=new URL(value),history=monthRows(12,100).map(row=>{const date=new Date(Number(row[0]));return [...row.slice(0,6),Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)-1];});
      return binancePage(url,history.reverse());
    }
    if(value.includes('instruments'))return reply(okxDirectory());
    if(value.includes('okx'))return okxPage(new URL(value),monthRows(65,250));
    return reply({},403);
  },clock);
  const data=await client.getCryptoCandles('SOLUSDT','1M',800);
  assert.equal(data.instrument.exchange,'OKX');assert.equal(data.candles.length,65);assert.ok(data.candles.every(c=>c.open===250));
  assert.equal(data.candles[0].time,Date.UTC(2021,6,1)/1000);assert.equal(data.candles.at(-1)?.closed,false);
  assert.match(data.warnings.join(' '),/65根/);
});

test('caller cancellation during backward pagination stops the request rather than returning partial or alternate data',async()=>{
  const controller=new AbortController();let pages=0,alternativeCalls=0;
  const client=createCryptoClient(async value=>{
    if(value.includes('exchangeInfo'))return reply(binanceDirectory());
    if(value.includes('/klines')) {
      pages++;
      if(pages===2){controller.abort();throw new DOMException('aborted','AbortError');}
      return binancePage(new URL(value),binanceRows(50));
    }
    alternativeCalls++;return reply({},403);
  },clock);
  await assert.rejects(client.getCryptoCandles('SOLUSDT','1m',800,controller.signal),e=>e instanceof DOMException&&e.name==='AbortError');
  assert.equal(pages,2);assert.equal(alternativeCalls,0);
});

test('short monthly alternatives use two reusable slots, preserving provider-order ties even when responses finish in reverse order',async()=>{
  const monthRows=(count:number,price:number)=>Array.from({length:count},(_,i)=>[String(Date.UTC(2026,10-i,1)),String(price),String(price+3),String(price-2),String(price+1),'11','0','0',i===0?'0':'1']);
  const started={okx:deferred<void>(),bitget:deferred<void>(),bybit:deferred<void>()};
  const response={okx:deferred<Response>(),bitget:deferred<Response>(),bybit:deferred<Response>()};
  let active=0,maxActive=0,primaryFinished=false,krakenCalls=0;
  const client=createCryptoClient(async value=>{
    const url=new URL(value);
    if(value.includes('exchangeInfo'))return reply(binanceDirectory());
    if(value.includes('/klines')) {
      if(url.searchParams.has('endTime')){primaryFinished=true;return reply([]);}
      return reply(monthRows(100,100).map(row=>{const date=new Date(Number(row[0]));return [...row.slice(0,6),Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)-1];}));
    }
    assert.equal(primaryFinished,true,'preferred source must finish before parallel alternatives begin');
    if(value.includes('instruments?'))return reply(okxDirectory());
    if(value.includes('/symbols'))return reply({code:'00000',data:[{status:'online',symbol:'SOLUSDT',baseCoin:'SOL',quoteCoin:'USDT'}]});
    if(value.includes('instruments-info'))return reply({retCode:0,result:{category:'spot',list:[{symbol:'SOLUSDT',baseCoin:'SOL',quoteCoin:'USDT',status:'Trading'}]}});
    if(value.includes('kraken')){krakenCalls++;return reply(unrelatedKrakenDirectory());}
    if(url.searchParams.has('after'))return reply({code:'0',data:[]});
    const provider=value.includes('okx')?'okx':value.includes('bitget')?'bitget':'bybit';
    active++;maxActive=Math.max(maxActive,active);started[provider].resolve();
    try { return await response[provider].promise; } finally { active--; }
  },clock);
  const request=client.getCryptoCandles('SOLUSDT','1M',800);
  await Promise.all([started.okx.promise,started.bitget.promise]);
  assert.equal(active,2,'two alternatives must overlap instead of waiting serially');
  response.bitget.resolve(reply({code:'00000',data:monthRows(120,500)}));
  await started.bybit.promise;
  assert.equal(active,2,'the next source takes the freed slot while OKX is still pending');
  response.bybit.resolve(reply({retCode:0,result:{category:'spot',symbol:'SOLUSDT',list:monthRows(120,800)}}));
  response.okx.resolve(reply({code:'0',data:monthRows(120,250)}));
  const data=await request;
  assert.equal(maxActive,2);assert.equal(active,0);assert.equal(krakenCalls,0);
  assert.equal(data.instrument.exchange,'OKX','equal-depth responses retain declared provider priority, not response race order');
  assert.equal(data.candles.length,120);assert.ok(data.candles.every(c=>c.open===250));
});

test('global cancellation aborts both parallel feed requests and does not start another alternative',async()=>{
  const bothStarted=deferred<void>();const controller=new AbortController();let active=0,aborted=0,unexpected=0;
  const client=createCryptoClient(async(value,init)=>{
    const url=new URL(value);
    if(value.includes('exchangeInfo'))return reply(binanceDirectory());
    if(value.includes('/klines'))return binancePage(url,binanceRows(7));
    if(value.includes('instruments'))return reply(okxDirectory());
    if(value.includes('AssetPairs'))return reply({error:[],result:{SOLUSDT:{altname:'SOLUSDT',wsname:'SOL/USDT',status:'online'}}});
    if(value.includes('/candles')||value.includes('/OHLC')) {
      active++;if(active===2)bothStarted.resolve();
      return new Promise<Response>((_resolve,reject)=>{
        init!.signal!.addEventListener('abort',()=>{active--;aborted++;reject(new DOMException('aborted','AbortError'));},{once:true});
      });
    }
    unexpected++;return reply({},403);
  },clock);
  const request=client.getCryptoCandles('SOLUSDT','1m',800,controller.signal);
  await bothStarted.promise;
  const rejection=assert.rejects(request,e=>e instanceof DOMException&&e.name==='AbortError');
  controller.abort();await rejection;
  assert.equal(aborted,2);assert.equal(active,0);assert.equal(unexpected,0);
});
