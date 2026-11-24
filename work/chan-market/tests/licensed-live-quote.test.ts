import test from 'node:test';
import assert from 'node:assert/strict';
import { getLicensedLiveQuote } from '../lib/licensed-live-quote.ts';
import { yahooFutureContract } from '../lib/future-contract.ts';

const epoch=(s:string)=>Date.parse(s)/1000;
const time=epoch('2026-11-18T14:32:10Z'), minute=time-10, nowMs=time*1000;
const env={BARCHART_API_KEY:'unit-token'};
const prices={open:100,low:98,high:102,close:101,volume:90};
const fetchBody=(value:unknown):typeof fetch=>async()=>Response.json(value);
const result=(value:unknown[])=>({status:{code:200},results:value});
const row={...prices,symbol:'GCZ26',mode:'R',tradeTimestamp:'2026-11-18T09:32:10-05:00',tradeDate:'2026-11-18',lastPrice:101};
const meta={currency:'USD',instrumentType:'FUTURE',exchangeName:'CMX',symbol:'GC=F',shortName:'Gold Dec 26'};
const publicMeta={currency:'USD',symbol:'AAPL',exchangeTimezoneName:'America/New_York',exchangeName:'NMS',instrumentType:'EQUITY',
  regularMarketTime:time,regularMarketPrice:101,dataGranularity:'1m'};
const chart=(m:Record<string,unknown>=publicMeta,timestamps=[minute-120,minute-60,minute])=>({chart:{result:[{
  meta:m,timestamp:timestamps,indicators:{quote:[{open:[99,99,100],high:[102,101,102],low:[98,98,99],close:[100,100,101],volume:[12,18,40]}]},
}]}});

test('continuous commodities resolve only the exact named futures product, exchange and delivery month',()=>{
  assert.equal(yahooFutureContract('GC=F',meta),'GCZ26');
  assert.equal(yahooFutureContract('SI=F',{...meta,symbol:'SI=F',shortName:'Silver Dec 2026'}),'SIZ26');
  assert.equal(yahooFutureContract('CL=F',{...meta,symbol:'CL=F',exchangeName:'NYM',shortName:'Crude Oil Jan 27'}),'CLF27');
  for(const patch of [{currency:'EUR'},{instrumentType:'ETF'},{exchangeName:'NYM'},{symbol:'SI=F'},
    {shortName:'Micro Gold Dec 26'},{shortName:'Gold Q4 26'}, {shortName:'Gold'}])assert.equal(yahooFutureContract('GC=F',{...meta,...patch}),undefined);
});
test('no-key US public snapshot aggregates only a fully observed session-aligned current bucket',async()=>{
  const r=await getLicensedLiveQuote('us','AAPL','4h',{nowMs,env:{},fetcher:fetchBody(chart())});
  assert.equal(r.status,'quote');
  if(r.status!=='quote')return;
  assert.equal(r.quote.provider,'yahoo');
  assert.equal(r.quote.quality,'observed');
  assert.deepEqual(r.quote.bar,{open:99,high:102,low:98,close:101,volume:70,
    start:epoch('2026-11-18T14:30:00Z'),end:epoch('2026-11-18T18:30:00Z'),interval:'4h'});
  for(const src of [chart(publicMeta,[minute-180,minute-60,minute]),chart({...publicMeta,regularMarketPrice:102})]){
    const incomplete=await getLicensedLiveQuote('us','AAPL','4h',{nowMs,env:{},fetcher:fetchBody(src)});
    assert.equal(incomplete.status,'quote');
    if(incomplete.status==='quote')assert.equal(incomplete.quote.bar,undefined);
  }
});
test('a US index uses its own published level even when it has no traded volume',async()=>{
  const body=chart({...publicMeta,symbol:'^GSPC',instrumentType:'INDEX'});
  body.chart.result[0].indicators.quote[0].volume=[0,0,0];
  const data=await getLicensedLiveQuote('us','^GSPC','5m',{nowMs,env,fetcher:fetchBody(body)});
  assert.equal(data.status,'quote');
  if(data.status==='quote'){
    assert.equal(data.quote.symbol,'^GSPC');
    assert.equal(data.quote.price,101);
    assert.equal(data.quote.bar,undefined);
  }
});
test('wrong listings, advertised delay, stale/future timestamps and an after-hours quote do not report live',async()=>{
  for(const [patch,status,at] of [
    [{symbol:'MSFT'},'unverified',nowMs],[{exchangeDataDelayedBy:15},'delayed',nowMs],
    [{regularMarketTime:time-61},'stale',nowMs],[{regularMarketTime:time+4},'stale',nowMs],
    [{regularMarketTime:epoch('2026-11-21T14:32:10Z')},'stale',Date.parse('2026-11-21T14:32:10Z')],
  ] as const){
    const r=await getLicensedLiveQuote('us','AAPL','1m',{nowMs:at,env:{},fetcher:fetchBody(chart({...publicMeta,...patch}))});
    assert.equal(r.status,status);
  }
});
test('public daily bars aggregate through this trading day and reject a missing weekday',async()=>{
  const dates=['2026-11-16','2026-11-17','2026-11-18'].map(d=>epoch(d+'T14:30:00Z'));
  const full=await getLicensedLiveQuote('us','AAPL','1w',{nowMs,env:{},fetcher:fetchBody(chart({...publicMeta,dataGranularity:'1d'},dates))});
  assert.equal(full.status,'quote');
  if(full.status==='quote'){
    assert.equal(full.quote.bar?.volume,70);
    assert.equal(full.quote.sessionBar?.volume,40);
  }
  const missing=await getLicensedLiveQuote('us','AAPL','1w',{nowMs,env:{},fetcher:fetchBody(chart({...publicMeta,dataGranularity:'1d'},[dates[0],dates[0],dates[2]]))});
  assert.equal(missing.status==='quote'&&missing.quote.bar,undefined);
});
test('unconfigured futures issue no requests, delayed mode and contract mismatch cannot create a live price',async()=>{
  const offline=await getLicensedLiveQuote('commodity','GC=F','1d',{nowMs,env:{},fetcher:async()=>{assert.fail('unexpected fetch');}});
  assert.equal(offline.status,'unconfigured');
  for(const [patch,status] of [[{mode:'I'},'delayed'],[{mode:'D'},'delayed'],[{symbol:'GCG27'},'unverified'],[{tradeDate:'2026-11-19'},'unverified']] as const){
    const r=await getLicensedLiveQuote('commodity','GC=F','1d',{nowMs,env,contract:'GCZ26',fetcher:fetchBody(result([{...row,...patch}]))});
    assert.equal(r.status,status);
  }
});
test('Barchart current named contract uses form POST and exchange timestamp; minute, volume and contract align',async()=>{
  const calls:string[]=[];
  const f:typeof fetch=async(url,init)=>{
    const u=new URL(String(url));calls.push(u.hostname+u.pathname);
    if(u.hostname.includes('yahoo'))return Response.json(chart(meta));
    assert.equal(u.search,'');assert.equal(init?.method,'POST');
    const form=new URLSearchParams(String(init?.body));
    assert.equal(form.get('apikey'),'unit-token');
    if(u.pathname.includes('Quote')){
      assert.equal(form.get('symbols'),'GCZ26');return Response.json(result([row]));
    }
    assert.equal(form.get('symbol'),'GCZ26');
    return Response.json(result([{symbol:'GCZ26',timestamp:'2026-11-18T09:32:00-05:00',tradingDay:row.tradeDate,...prices}]));
  };
  const r=await getLicensedLiveQuote('commodity','GC=F','1m',{nowMs,env,fetcher:f});
  assert.equal(calls.length,3);
  assert.equal(r.status,'quote');
  if(r.status!=='quote')return;
  assert.equal(r.quote.quality,'realtime');assert.equal(r.quote.contract,'GCZ26');assert.equal(r.quote.time,time);
  assert.deepEqual(r.quote.sessionBar,prices);
  assert.deepEqual(r.quote.bar,{...prices,start:minute,end:minute+60,interval:'1m'});
});
test('lack of history entitlement preserves only the independently authorized price and day range',async()=>{
  const r=await getLicensedLiveQuote('commodity','GC=F','4h',{nowMs,env,contract:'GCZ26',
    fetcher:async u=>String(u).includes('History')?new Response(null,{status:403}):Response.json(result([row]))});
  assert.equal(r.status,'quote');
  if(r.status==='quote'){assert.equal(r.quote.bar,undefined);assert.deepEqual(r.quote.sessionBar,prices);}
});
test('Alpaca returns the stated venue coverage with credentials only in HTTPS headers',async()=>{
  const r=await getLicensedLiveQuote('us','BRK-B','1m',{nowMs,env:{APCA_API_KEY_ID:'k',APCA_API_SECRET_KEY:'s'},
    fetcher:async (u,init)=>{
      const url=new URL(String(u));
      assert.equal(url.searchParams.get('feed'),'iex');assert.equal(url.searchParams.get('symbols'),'BRK.B');
      assert.equal(new Headers(init?.headers).get('APCA-API-SECRET-KEY'),'s');
      return Response.json({trades:{'BRK.B':{p:101,t:'2026-11-18T14:32:10.123456789Z'}}});
    }});
  assert.equal(r.status,'quote');
  if(r.status==='quote'){assert.equal(r.quote.venue,'IEX');assert.equal(r.quote.quality,'realtime');}
});
