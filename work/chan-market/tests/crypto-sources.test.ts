import test from 'node:test';
import assert from 'node:assert/strict';
import { createCryptoClient, CryptoDataError, aggregateCryptoMonths } from '../lib/crypto-sources.ts';
import type { Candle } from '../lib/market-types';

const now=()=>Date.UTC(2026,10,13,6,0,30);
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function okxDirectory(){return {code:'0',data:[{state:'live',baseCcy:'BTC',quoteCcy:'USDT',instId:'BTC-USDT'},{state:'live',baseCcy:'ETH',quoteCcy:'USDT',instId:'ETH-USDT'}]};}
function okxRows(n:number){return Array.from({length:n},(_,i)=>[String(now()-30000-i*60000),'100','102','99','101','2','202','202',i===0?'0':'1']);}

test('403 falls back to independent OKX and paginates 800 real-format 1m bars, preserving USDT and confirmation',async()=>{
  let binanceRequests=0,pages=0;const history=okxRows(900);
  const client=createCryptoClient(async url=>{
    const u=new URL(url);
    if(u.hostname==='data-api.binance.vision'){binanceRequests++;return reply({},403);}
    assert.equal(u.hostname,'www.okx.com');
    if(u.pathname.includes('instruments'))return reply(okxDirectory());
    assert.equal(u.searchParams.get('bar'),'1m');assert.equal(u.searchParams.get('instId'),'BTC-USDT');pages++;
    const after=Number(u.searchParams.get('after')||Infinity),limit=Number(u.searchParams.get('limit'));
    return reply({code:'0',data:history.filter(r=>Number(r[0])<after).slice(0,limit)});
  },now);
  const data=await client.getCryptoCandles('BTCUSDT','1m',800);
  assert.equal(data.candles.length,800);assert.equal(pages,3);assert.equal(data.instrument.exchange,'OKX');
  assert.equal(data.instrument.currency,'USDT');assert.equal(data.instrument.symbol,'BTCUSDT');
  assert.equal(data.candles.at(-1)!.closed,false);assert.ok(data.candles.slice(0,-1).every(c=>c.closed));
  assert.ok(data.candles.every((c,i,a)=>i===0||c.time>a[i-1].time));
  await client.getCryptoCandles('BTCUSDT','1m',100);assert.equal(binanceRequests,1,'healthy source should be reused');
});

test('search falls back to a live directory and Chinese BTC name retains its actual venue',async()=>{
  const client=createCryptoClient(async url=>url.includes('binance')?reply({},403):reply(okxDirectory()),now);
  const results=await client.searchCrypto('比特币');
  assert.equal(results[0].symbol,'BTCUSDT');assert.equal(results[0].exchange,'OKX');
  assert.equal(results[0].currency,'USDT');
});

test('USD-only listings are never relabeled as BTCUSDT',async()=>{
  const client=createCryptoClient(async url=>{
    if(url.includes('binance'))return reply({symbols:[{symbol:'BTCUSD',status:'TRADING',baseAsset:'BTC',quoteAsset:'USD'}]});
    if(url.includes('okx'))return reply({code:'0',data:[{state:'live',baseCcy:'BTC',quoteCcy:'USD',instId:'BTC-USD'}]});
    return reply({error:[],result:{XXBTZUSD:{altname:'XBTUSD',wsname:'XBT/USD',status:'online'}}});
  },now);
  await assert.rejects(client.getCryptoCandles('BTCUSDT','1h'),e=>e instanceof CryptoDataError&&e.status===404);
});

test('Kraken backup maps XBT to BTC only, retains quote and excludes its current candle',async()=>{
  const history=Array.from({length:30},(_,i)=>[Math.floor(now()/1000)-3000+i*60,'100','103','99','102','101','3',2]);
  const client=createCryptoClient(async url=>{
    if(!url.includes('api.kraken.com'))return reply({},403);
    if(url.includes('AssetPairs'))return reply({error:[],result:{XBTUSDT:{altname:'XBTUSDT',wsname:'XBT/USDT',status:'online'}}});
    assert.ok(url.includes('pair=XBTUSDT'));assert.ok(url.includes('interval=1'));
    return reply({error:[],result:{XBTUSDT:history,last:123}});
  },now);
  const data=await client.getCryptoCandles('BTCUSDT','1m',100);
  assert.equal(data.instrument.exchange,'Kraken');assert.equal(data.instrument.currency,'USDT');
  assert.equal(data.candles.at(-1)!.closed,false);assert.ok(data.candles.slice(0,-1).every(c=>c.closed));
  assert.equal(data.candles[0].volume,3);
});

test('OKX calendar month uses 1Mutc and respects the returned completion flag',async()=>{
  const client=createCryptoClient(async url=>{
    if(url.includes('binance'))return reply({},403);
    if(url.includes('instruments'))return reply(okxDirectory());
    assert.equal(new URL(url).searchParams.get('bar'),'1Mutc');
    return reply({code:'0',data:Array.from({length:12},(_,i)=>[String(Date.UTC(2026,10-i,1)),'100','102','99','101','20','2020','2020',i?'1':'0'])});
  },now);
  const data=await client.getCryptoCandles('ETHUSDT','1M',100);
  assert.equal(data.candles.length,12);assert.equal(data.candles.at(-1)!.closed,false);
});

test('calendar-month aggregation omits truncated/gapped old months and preserves the open current month',()=>{
  const end=Date.UTC(2026,2,10,12);
  const daily:Candle[]=Array.from({length:69},(_,i)=>({time:Date.UTC(2026,0,1+i)/1000,open:100+i,high:103+i,low:99+i,close:102+i,volume:2,closed:i<68}));
  const months=aggregateCryptoMonths(daily,end);
  assert.equal(months.length,3);assert.equal(months[0].volume,62);assert.equal(months[0].closed,true);assert.equal(months[2].closed,false);
  assert.equal(aggregateCryptoMonths(daily.slice(1),end).length,2);
  assert.equal(aggregateCryptoMonths(daily.filter((_,i)=>i!==40),end).length,2);
});

test('invalid symbols/periods and complete provider failure produce errors without fabricated candles',async()=>{
  const client=createCryptoClient(async()=>reply({},403),now);
  await assert.rejects(client.getCryptoCandles('BTCUSDT?host=x','1h'),e=>e instanceof CryptoDataError&&e.status===400);
  await assert.rejects(client.getCryptoCandles('BTCUSDT','1h'),e=>e instanceof CryptoDataError&&e.status===502);
});

test('cancelling one chart does not poison a shared directory request for another chart',async()=>{
  let release!:(response:Response)=>void,directoryRequests=0;
  const directory=new Promise<Response>(resolve=>{release=resolve;});
  const client=createCryptoClient(async url=>{
    if(url.includes('exchangeInfo')){directoryRequests++;return directory;}
    assert.ok(url.includes('symbol=ETHUSDT'));
    return reply(Array.from({length:35},(_,i)=>[now()-3600000+i*60000,'100','102','99','101','2',now()-3540000+i*60000]));
  },now);
  const controller=new AbortController();
  const first=client.getCryptoCandles('BTCUSDT','1m',100,controller.signal);
  const canceled=assert.rejects(first,e=>e instanceof DOMException&&e.name==='AbortError');
  const second=client.getCryptoCandles('ETHUSDT','1m',100);
  controller.abort();
  release(reply({symbols:['BTC','ETH'].map(base=>({symbol:base+'USDT',status:'TRADING',baseAsset:base,quoteAsset:'USDT'}))}));
  const [,data]=await Promise.all([canceled,second]);
  assert.equal(data.instrument.symbol,'ETHUSDT');assert.equal(directoryRequests,1);
});

const monthlyRows=(n=100)=>Array.from({length:n},(_,i)=>[String(Date.UTC(2026,10-i,1)),'100','110','90','105','20']);
const bitgetDirectory=(quote='USDT')=>({code:'00000',data:[{status:'online',symbol:'BTC'+quote,baseCoin:'BTC',quoteCoin:quote}]});

test('a working Kraken minute feed cannot pin subsequent months to the 24-month daily window',async()=>{
  const visited:string[]=[];
  const client=createCryptoClient(async url=>{
    visited.push(url);
    if(url.includes('binance')||url.includes('okx'))return reply({},403);
    if(url.includes('bitget')) {
      if(url.includes('/symbols'))return reply(bitgetDirectory());
      assert.equal(new URL(url).searchParams.get('granularity'),'1Mutc');
      return reply({code:'00000',data:monthlyRows()});
    }
    if(url.includes('AssetPairs'))return reply({error:[],result:{XBTUSDT:{altname:'XBTUSDT',wsname:'XBT/USDT',status:'online'}}});
    assert.equal(new URL(url).searchParams.get('interval'),'1','monthly request must prefer native history');
    return reply({error:[],result:{XBTUSDT:[[now()/1000-60,'100','110','90','105','102','20',1],[now()/1000,'105','110','100','106','104','3',1]],last:1}});
  },now);
  const minute=await client.getCryptoCandles('BTCUSDT','1m');
  assert.equal(minute.instrument.exchange,'Kraken');
  const month=await client.getCryptoCandles('BTCUSDT','1M');
  assert.equal(month.instrument.exchange,'Bitget');assert.equal(month.instrument.currency,'USDT');
  assert.equal(month.candles.length,100);assert.equal(new Date(month.candles[0].time*1000).toISOString(),'2018-08-01T00:00:00.000Z');
  assert.equal(month.candles.at(-1)?.closed,false);assert.ok(month.candles.slice(0,-1).every(c=>c.closed));
  assert.equal(new Set(month.candles.map(c=>new Date(c.time*1000).toISOString().slice(0,7))).size,100);
  assert.equal(month.candles[0].volume,20);
  const again=await client.getCryptoCandles('BTCUSDT','1m');
  assert.equal(again.instrument.exchange,'Kraken','monthly preference must not change the established minute source');
});

test('Bybit independent month fallback verifies spot identity and preserves current month',async()=>{
  const client=createCryptoClient(async url=>{
    if(!url.includes('bybit'))return reply({},403);
    const u=new URL(url);assert.equal(u.searchParams.get('category'),'spot');
    if(url.includes('instruments-info'))return reply({retCode:0,result:{category:'spot',list:[{symbol:'ETHUSDT',baseCoin:'ETH',quoteCoin:'USDT',status:'Trading'}]}});
    assert.equal(u.searchParams.get('interval'),'M');
    return reply({retCode:0,result:{category:'spot',symbol:'ETHUSDT',list:monthlyRows(65)}});
  },now);
  const data=await client.getCryptoCandles('ETHUSDT','1M');
  assert.equal(data.candles.length,65);assert.equal(data.instrument.exchange,'Bybit');assert.equal(data.instrument.currency,'USDT');
  assert.equal(data.candles[0].open,100);assert.equal(data.candles[0].high,110);assert.equal(data.candles[0].low,90);assert.equal(data.candles[0].close,105);
  assert.equal(data.candles.at(-1)?.closed,false);assert.ok(data.candles.slice(0,-1).every(c=>c.closed));
});

test('monthly fallback rejects UTC+8 stamps and derivatives instead of disguising them as UTC spot months',async()=>{
  const client=createCryptoClient(async url=>{
    if(url.includes('bitget'))return url.includes('/symbols')?reply(bitgetDirectory()):reply({code:'00000',data:monthlyRows().map(r=>[String(Number(r[0])-8*3600000),...r.slice(1)])});
    if(url.includes('bybit'))return url.includes('instruments-info')?reply({retCode:0,result:{category:'spot',list:[{symbol:'BTCUSDT',baseCoin:'BTC',quoteCoin:'USDT',status:'Trading'}]}}):reply({retCode:0,result:{category:'linear',symbol:'BTCUSDT',list:monthlyRows()}});
    return reply({},403);
  },now);
  await assert.rejects(client.getCryptoCandles('BTCUSDT','1M'),e=>e instanceof CryptoDataError&&e.message.includes('UTC月首')&&e.message.includes('现货交易对不匹配'));
});

test('native monthly directories cannot substitute USD for requested USDT',async()=>{
  const client=createCryptoClient(async url=>{
    if(url.includes('bitget'))return reply(bitgetDirectory('USD'));
    if(url.includes('bybit'))return reply({retCode:0,result:{category:'spot',list:[{symbol:'BTCUSD',baseCoin:'BTC',quoteCoin:'USD',status:'Trading'}]}});
    if(url.includes('binance'))return reply({symbols:[{symbol:'BTCUSD',status:'TRADING',baseAsset:'BTC',quoteAsset:'USD'}]});
    if(url.includes('okx'))return reply({code:'0',data:[{state:'live',baseCcy:'BTC',quoteCcy:'USD',instId:'BTC-USD'}]});
    return reply({error:[],result:{XXBTZUSD:{altname:'XBTUSD',wsname:'XBT/USD',status:'online'}}});
  },now);
  await assert.rejects(client.getCryptoCandles('BTCUSDT','1M'),e=>e instanceof CryptoDataError&&e.status===404);
});
