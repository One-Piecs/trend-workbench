import assert from 'node:assert/strict';
import test from 'node:test';
import {createCryptoClient} from '../lib/crypto-sources.ts';
import {getOlderHistory} from '../lib/market-data.ts';
import {HistoryBoundary,loadYahooHistory,yahooHistoryWindow} from '../lib/history-window.ts';
import {equitySessionOn} from '../lib/equity-calendar.ts';

const before=Date.UTC(2026,0,12,12)/1000;
const basis='原始成交价格，不复权';
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});

test('historical crypto requests keep the original spot pair and exclude the boundary',async()=>{
  const urls:URL[]=[];
  const client=createCryptoClient(async raw=>{
    const url=new URL(raw);urls.push(url);
    if(url.pathname.endsWith('/instruments'))return reply({code:'0',data:[{state:'live',baseCcy:'BTC',quoteCcy:'USDT',instId:'BTC-USDT'}]});
    const rows=[before,before-3600,before-7200].map(t=>[String(t*1000),'12','14','9','10','5','0','0','1']);
    return reply({code:'0',data:rows});
  },()=>before*1000+86400000);
  const page=await client.getCryptoHistory('BTCUSDT','1h',500,before,'OKX 公共现货行情 · BTC-USDT',basis);
  assert.deepEqual(page?.map(c=>c.time),[before-7200,before-3600]);
  assert.equal(urls.length,2);
  assert.equal(urls[1].pathname,'/api/v5/market/history-candles');
  assert.equal(urls[1].searchParams.get('after'),String(before*1000));
  assert.equal(urls[1].searchParams.get('instId'),'BTC-USDT');
  await assert.rejects(client.getCryptoHistory('BTCUSDT','1h',500,before,'OKX 公共现货行情 · ETH-USDT',basis));
  assert.equal(urls.length,2);
});

test('a typed empty history is distinct from a failed or malformed response',async()=>{
  let next=reply([]);
  const client=createCryptoClient(async raw=>raw.includes('exchangeInfo')?
    reply({symbols:[{status:'TRADING',symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT'}]}):next);
  const load=()=>client.getCryptoHistory('BTCUSDT','1h',50,before,'Binance 公共现货行情 · BTCUSDT',basis);
  assert.deepEqual(await load(),[]);
  next=reply({message:'invalid body'});await assert.rejects(load());
  next=reply([],503);await assert.rejects(load());
  next=reply([[before*1000,'12','14','9','10','3',(before+3600)*1000-1]]);await assert.rejects(load());
});

test('an empty Yahoo window is not proof of an exhausted archive',async()=>{
  const url=new URL('https://query1.finance.yahoo.com/v8/finance/chart/AAPL');
  const window=yahooHistoryWindow('Yahoo Finance 网页行情 · query1.finance.yahoo.com','1d',before,50,before+86400)!;
  const load=(symbol:string,listing:number)=>loadYahooHistory(url,window,'AAPL',async raw=>String(raw).includes('range=5d')?
    reply({chart:{result:[{meta:{symbol,firstTradeDate:listing}}]}}):
    reply({chart:{error:{code:'Bad Request',description:"Data doesn't exist for startDate = 1, endDate = 2"}}},400));
  await assert.rejects(load('AAPL',before),error=>error instanceof HistoryBoundary&&error.status==='end');
  await assert.rejects(load('AAPL',before-86400),error=>error instanceof HistoryBoundary&&error.status==='unsupported');
  await assert.rejects(load('MSFT',before),error=>!(error instanceof HistoryBoundary));
  await assert.rejects(loadYahooHistory(url,window,'AAPL',async()=>reply({},429)),error=>!(error instanceof HistoryBoundary));
});

test('unrecognized source or cursor never fetches an arbitrary URL',async()=>{
  const params=new URLSearchParams({market:'us',interval:'1d',symbol:'AAPL',source:'https://example.org',adjustment:'raw',before:String(before)});
  const page=await getOlderHistory(params);assert.equal(page.status,'unsupported');assert.deepEqual(page.candles,[]);
  params.set('before','-1');await assert.rejects(getOlderHistory(params));
  params.set('before',String(before));params.set('limit','1001');await assert.rejects(getOlderHistory(params));
});

test('Sina pages all 1,970 available native bars, then reports a source window rather than an IPO boundary',async()=>{
  const source='新浪财经 OHLC（独立备用） · quotes.sina.cn';
  const adjustment='来源原始OHLC（未请求复权）；成交量单位：股';
  const rows:{day:string;open:string;high:string;low:string;close:string;volume:string}[]=[];
  for(let d=Date.UTC(2025,7,1);rows.length<1970;d+=86400000){
    const date=new Date(d).toISOString().slice(0,10);
    for(const {start,end} of equitySessionOn('cn',date).segments){
      for(let m=start+5;m<=end&&rows.length<1970;m+=5){
        const hh=String(Math.floor(m/60)).padStart(2,'0'),mm=String(m%60).padStart(2,'0');
        rows.push({day:`${date} ${hh}:${mm}:00`,open:'20',high:'22',low:'18',close:'21',volume:'10000'});
      }
    }
  }
  const requested:number[]=[];
  const original=globalThis.fetch;
  globalThis.fetch=async input=>{
    const url=new URL(String(input)),count=Number(url.searchParams.get('datalen'));
    assert.equal(url.hostname,'quotes.sina.cn');
    requested.push(count);
    return new Response('var _data=('+JSON.stringify(count<=1970?rows.slice(-count):null)+');');
  };
  try{
    const t=(row:typeof rows[number])=>Date.parse(row.day.replace(' ','T')+'+08:00')/1000;
    let cursor=t(rows[1170]);
    const totals:number[]=[];
    let total=800;
    for(const [count,status] of [[500,'more'],[500,'more'],[170,'more'],[0,'unsupported']] as const){
      const page=await getOlderHistory(new URLSearchParams({market:'cn',symbol:'600519.SH',interval:'5m',source,adjustment,
        before:String(cursor),limit:'500'}));
      assert.equal(page.status,status);
      assert.equal(page.candles.length,count);
      assert.ok(page.candles.every(c=>c.closed&&c.time<cursor));
      if(count)cursor=page.candles[0].time;
      total+=count;totals.push(total);
    }
    assert.deepEqual(totals,[1300,1800,1970,1970]);
    assert.equal(cursor,t(rows[0]));
    assert.deepEqual(requested,[1970],'repeated page cursors reuse the same raw source window');
  }finally{globalThis.fetch=original;}
});
