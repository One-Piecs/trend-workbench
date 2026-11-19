import test from 'node:test';
import assert from 'node:assert/strict';
import type {Interval} from '../lib/market-types';

type Adapter=typeof import('../lib/market-data.ts');
const now=Date.parse('2026-11-14T12:00:00Z');
let instance=0;
function stamps(interval:Interval,count:number):number[] {
  if(interval==='1M')return Array.from({length:count},(_,i)=>Date.UTC(2026,10-count+1+i,1,14,30)/1000);
  if(interval==='1w')return Array.from({length:count},(_,i)=>Date.UTC(2026,10,9-7*(count-1-i),14,30)/1000);
  const values:number[]=[];let cursor=Date.UTC(2026,10,13,14,30);
  while(values.length<count){const day=new Date(cursor).getUTCDay();if(day!==0&&day!==6)values.unshift(cursor/1000);cursor-=86400000;}
  return values;
}
function yahoo(symbol:string,interval:Interval,count=80,granularity?:string):Response {
  const timestamp=stamps(interval,count),prices=timestamp.map((_,i)=>200+i);
  return Response.json({chart:{error:null,result:[{meta:{symbol,dataGranularity:granularity??(interval==='1M'?'1mo':interval==='1w'?'1wk':interval),exchangeTimezoneName:'America/New_York',longName:`${symbol} history`,exchangeName:'NMS',currency:'USD'},timestamp,indicators:{quote:[{open:prices,high:prices.map(p=>p+2),low:prices.map(p=>p-1),close:prices.map(p=>p+1),volume:prices.map(()=>1000)}],adjclose:[{adjclose:prices.map(p=>p+1)}]}}]}});
}
const date=(time:number)=>new Date(time*1000).toISOString().slice(0,10);
function calendarRows(interval:'1w'|'1M',count:number,price:number){
  const dates=stamps(interval,count).map(date);
  // Tencent/EM may label the current native period with its final trading day.
  dates[dates.length-1]='2026-11-13';
  return dates.map(day=>[day,String(price),String(price+1),String(price+2),String(price-1),'1000']);
}
const hint=(symbol:string)=>new Response(`v_hint="us~${symbol}.OQ~${symbol} history";`);
const unavailable=()=>new Response('Unavailable',{status:503});
async function withAdapter(fetcher:(url:URL)=>Promise<Response>|Response,run:(api:Adapter,urls:URL[])=>Promise<void>){
  const originalFetch=globalThis.fetch,originalNow=Date.now,urls:URL[]=[];
  Date.now=()=>now;
  globalThis.fetch=async input=>{const url=new URL(String(input));urls.push(url);return fetcher(url);};
  try{
    // Each regression owns its cooldown/cache; production code remains unmodified.
    const api=await import(new URL(`../lib/market-data.ts?universal-history=${++instance}`,import.meta.url).href) as Adapter;
    await run(api,urls);
  }finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
}

test('a denied Yahoo search never disables chart history for a newly searched ticker',async()=>{
  for(const status of [401,403])await withAdapter(url=>{
    if(url.pathname.includes('/finance/search'))return new Response('Search denied',{status});
    if(url.hostname==='smartbox.gtimg.cn')return hint('ZSCAN');
    if(url.pathname.includes('/finance/chart/'))return yahoo('ZSCAN','1d');
    return unavailable();
  },async(api,urls)=>{
    const found=await api.searchInstruments('us','ZSCAN');assert.ok(found.results.some(i=>i.symbol==='ZSCAN'));
    const data=await api.getCandles('us','ZSCAN','1d',800);
    assert.ok(urls.some(url=>url.pathname.endsWith('/chart/ZSCAN')));
    assert.match(data.source,/^Yahoo Finance/);assert.equal(data.candles.length,80);
  });
});

test('ticker-specific 404, empty chart and transient 503 do not poison a different valid ticker',async()=>{
  for(const failure of ['404','empty','503'])await withAdapter(url=>{
    if(url.hostname==='smartbox.gtimg.cn')return hint(url.searchParams.get('q')??'UNKNOWN');
    if(url.pathname.endsWith('/chart/ZBAD')){
      if(failure==='empty')return Response.json({chart:{result:[],error:{code:'Not Found',description:'No data for this symbol'}}});
      return new Response('Symbol unavailable',{status:Number(failure)});
    }
    if(url.pathname.endsWith('/chart/ZGOOD'))return yahoo('ZGOOD','1d');
    return unavailable();
  },async(api,urls)=>{
    await assert.rejects(api.getCandles('us','ZBAD','1d',800));
    const data=await api.getCandles('us','ZGOOD','1d',800);
    assert.ok(urls.some(url=>url.pathname.endsWith('/chart/ZGOOD')),failure);
    assert.match(data.source,/^Yahoo Finance/);assert.equal(data.candles.length,80);
  });
});

test('US week and month history uses explicit deep time bounds and preserves requested granularity',async()=>{
  for(const interval of ['1w','1M'] as const)await withAdapter(url=>{
    if(url.hostname==='smartbox.gtimg.cn')return hint('ZDEEP');
    if(url.pathname.endsWith('/chart/ZDEEP'))return yahoo('ZDEEP',interval,interval==='1w'?360:180);
    return unavailable();
  },async(api,urls)=>{
    const data=await api.getCandles('us','ZDEEP',interval,800);
    const chart=urls.find(url=>url.pathname.endsWith('/chart/ZDEEP'));assert.ok(chart);
    assert.equal(chart.searchParams.get('interval'),interval==='1w'?'1wk':'1mo');
    assert.equal(chart.searchParams.has('range'),false);
    assert.ok(Number(chart.searchParams.get('period1'))<=Date.UTC(1900,0,1)/1000);
    assert.ok(Number(chart.searchParams.get('period2'))>=now/1000);
    assert.ok(Number(chart.searchParams.get('period2'))<=now/1000+86400);
    assert.equal(data.interval,interval);assert.equal(data.candles.length,interval==='1w'?360:180);
  });
});

test('an explicit window still rejects a provider that downsampled monthly data to quarters',async()=>{
  await withAdapter(url=>{
    if(url.hostname==='smartbox.gtimg.cn')return hint('ZQUARTER');
    if(url.pathname.endsWith('/chart/ZQUARTER'))return yahoo('ZQUARTER','1M',120,'3mo');
    return unavailable();
  },async api=>{await assert.rejects(api.getCandles('us','ZQUARTER','1M',800));});
});

test('short native calendar providers cannot hide a deeper complete Yahoo history or splice into it',async()=>{
  for(const interval of ['1w','1M'] as const)await withAdapter(url=>{
    const period=interval==='1w'?'week':'month';
    if(url.hostname==='smartbox.gtimg.cn')return hint('ZCHOICE');
    if(url.pathname.endsWith('/chart/ZCHOICE'))return yahoo('ZCHOICE',interval,180);
    if(url.hostname==='web.ifzq.gtimg.cn')return Response.json({code:0,data:{'usZCHOICE.OQ':{[period]:calendarRows(interval,12,10)}}});
    if(url.hostname==='push2his.eastmoney.com')return Response.json({data:{market:105,code:'ZCHOICE',name:'Short EM',klines:calendarRows(interval,16,20).map(row=>row.join(','))}});
    return unavailable();
  },async(api,urls)=>{
    const data=await api.getCandles('us','ZCHOICE',interval,800);
    assert.ok(urls.some(url=>url.pathname.endsWith('/chart/ZCHOICE')));
    assert.match(data.source,/^Yahoo Finance/);assert.equal(data.candles.length,180);
    assert.ok(data.candles.every(c=>c.open>=200));
    assert.match(data.adjustment,/调整后收盘价/);
  });
});

test('CN calendar selection also compares independent histories instead of accepting a short first source',async()=>{
  for(const interval of ['1w','1M'] as const)await withAdapter(url=>{
    const period=interval==='1w'?'week':'month';
    if(url.hostname==='push2his.eastmoney.com')return Response.json({data:{market:1,code:'601901',name:'Short primary',klines:calendarRows(interval,12,10).map(row=>row.join(','))}});
    if(url.hostname==='web.ifzq.gtimg.cn')return Response.json({code:0,data:{sh601901:{[period]:calendarRows(interval,160,500),qt:{sh601901:['','Deep source']}}}});
    return unavailable();
  },async(api,urls)=>{
    const data=await api.getCandles('cn','601901.SH',interval,800);
    assert.ok(urls.some(url=>url.hostname==='web.ifzq.gtimg.cn'));
    assert.match(data.source,/^腾讯证券/);assert.equal(data.candles.length,160);
    assert.ok(data.candles.every(c=>c.open===500));
  });
});
