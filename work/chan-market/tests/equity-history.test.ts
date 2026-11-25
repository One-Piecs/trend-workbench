import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseEquityHistory} from '../lib/equity-history.ts';
import type {Candle,MarketData} from '../lib/market-types';

const time=(date:string)=>Date.parse(date)/1000;
const bar=(stamp:string,price=100,closed=true):Candle=>({time:time(stamp),open:price,high:price+2,low:price-2,close:price+1,volume:100,closed});
const feed=(candles:Candle[],overrides:Partial<MarketData>={}):MarketData=>({instrument:{id:'us:AAPL',symbol:'AAPL',market:'us',name:'Apple',exchange:'NASDAQ',currency:'USD'},interval:'4h',source:'Yahoo Finance',adjustment:'raw',candles,asOf:'2026-11-14T12:00:00Z',delayNotice:'',warnings:[],availableIntervals:['4h'],...overrides});
const recent=()=>bar('2026-11-13T13:30:00-05:00');

test('latest four-hour coverage wins over a deeper but stale source',()=>{
  const stale=feed(Array.from({length:200},(_,i)=>({...bar('2026-01-01T13:30:00-05:00'),time:time('2026-01-01T13:30:00-05:00')+i*86400})),{source:'deep stale'});
  const current=feed([recent()],{source:'current short'});
  assert.equal(chooseEquityHistory([stale,current]),current);
  assert.equal(chooseEquityHistory([current,stale]),current);
});

test('equal latest coverage selects deeper completed history rather than the first successful provider',()=>{
  const first=feed([recent()],{source:'short primary'});
  const deep=feed([bar('2026-11-12T09:30:00-05:00'),bar('2026-11-12T13:30:00-05:00'),bar('2026-11-13T09:30:00-05:00'),recent()],{source:'deep backup'});
  assert.equal(chooseEquityHistory([first,deep]),deep);
});

test('a later same-day US session is newer than the deeper morning-only response',()=>{
  const morning=feed([bar('2026-11-12T09:30:00-05:00'),bar('2026-11-12T13:30:00-05:00'),bar('2026-11-13T09:30:00-05:00')]);
  const afternoon=feed([recent()],{source:'current afternoon'});
  assert.equal(chooseEquityHistory([morning,afternoon]),afternoon);
});

test('completed-bar count takes precedence over merely adding unfinished rows',()=>{
  const oneComplete=feed([bar('2026-11-12T09:30:00-05:00',100,false),bar('2026-11-12T13:30:00-05:00',100,false),recent()]);
  const twoComplete=feed([bar('2026-11-13T09:30:00-05:00'),recent()],{source:'more closed'});
  assert.equal(chooseEquityHistory([oneComplete,twoComplete]),twoComplete);
});

test('equal coverage and completion count uses total depth, then stable provider preference',()=>{
  const smaller=feed([recent()]),larger=feed([bar('2026-11-13T09:30:00-05:00',100,false),recent()],{source:'extra current partial'});
  assert.equal(chooseEquityHistory([smaller,larger]),larger);
  const equal=feed(structuredClone(larger.candles),{source:'equal alternative'});
  assert.equal(chooseEquityHistory([larger,equal]),larger);
});

test('selection preserves the whole chosen response, source metadata and adjustment without splicing',()=>{
  const a=feed([bar('2026-11-12T13:30:00-05:00',500),recent()],{source:'source A',adjustment:'adjusted'});
  const b=feed([bar('2026-11-11T13:30:00-05:00',20),bar('2026-11-12T13:30:00-05:00',21),bar('2026-11-13T13:30:00-05:00',22)],{source:'source B',adjustment:'unadjusted',warnings:['provider B only']});
  const before=JSON.stringify([a,b]);
  const selected=chooseEquityHistory([a,b]);assert.equal(selected,b);assert.equal(selected?.candles,b.candles);assert.equal(selected?.adjustment,'unadjusted');assert.deepEqual(selected?.warnings,['provider B only']);
  assert.equal(JSON.stringify([a,b]),before);assert.equal(selected?.candles.some(c=>c.open===500),false);
});

test('empty responses are ignored, while an entirely empty selection remains undefined',()=>{
  assert.equal(chooseEquityHistory([]),undefined);assert.equal(chooseEquityHistory([feed([])]),undefined);
  const nonempty=feed([recent()]);assert.equal(chooseEquityHistory([feed([]),nonempty]),nonempty);
});

test('market, symbol and interval conflicts are rejected even for empty candidates',()=>{
  const a=feed([recent()]);
  for(const b of [feed([],{instrument:{...a.instrument,symbol:'MSFT'}}),feed([],{instrument:{...a.instrument,market:'cn'}}),feed([],{interval:'1h'})])assert.throws(()=>chooseEquityHistory([a,b]),/market, symbol and interval/);
  const same=feed([recent()],{instrument:{...a.instrument,symbol:'aapl'}});assert.doesNotThrow(()=>chooseEquityHistory([a,same]));
});

test('US start-labelled and end-labelled hourly data compare the same actual coverage across DST',()=>{
  for(const date of ['2026-10-30','2026-11-02']) {
    const offset=date==='2026-10-30'?'-04:00':'-05:00';
    const yahoo=feed([bar(`${date}T09:30:00${offset}`),bar(`${date}T10:30:00${offset}`)],{interval:'1h',source:'Yahoo Finance'});
    const eastmoney=feed([bar(`${date}T09:30:00${offset}`),bar(`${date}T10:30:00${offset}`),bar(`${date}T11:30:00${offset}`)],{interval:'1h',source:'东方财富 美股网页行情（备用）'});
    assert.equal(chooseEquityHistory([yahoo,eastmoney]),eastmoney,'equivalent latest end time, deeper history wins');
    const newer=feed([bar(`${date}T11:30:00${offset}`)],{interval:'1h',source:'Yahoo Finance'});
    assert.equal(chooseEquityHistory([eastmoney,newer]),newer,'11:30 start covers to 12:30, newer than 11:30 end');
  }
});

test('calendar month and week labels normalize to their period instead of favoring the later label',()=>{
  const monthStart=feed([bar('2026-10-01T09:30:00-04:00'),bar('2026-11-01T09:30:00-05:00')],{interval:'1M'});
  const monthEnd=feed([bar('2026-11-13T09:30:00-05:00')],{interval:'1M',source:'腾讯证券 原生美股月K'});
  assert.equal(chooseEquityHistory([monthEnd,monthStart]),monthStart);
  const monday=feed([bar('2026-11-02T09:30:00-05:00'),bar('2026-11-09T09:30:00-05:00')],{interval:'1w'});
  const friday=feed([bar('2026-11-13T09:30:00-05:00')],{interval:'1w',source:'腾讯证券 原生美股周K'});
  assert.equal(chooseEquityHistory([friday,monday]),monday);
});

test('invalid or unsorted histories are not made attractive by a fictitious latest candle',()=>{
  const good=feed([recent()]);
  const invalid=feed([recent(),{...bar('2027-01-01T09:30:00-05:00'),high:NaN}]);
  const unsorted=feed([recent(),bar('2026-11-12T13:30:00-05:00')]);
  assert.equal(chooseEquityHistory([invalid,unsorted,good]),good);
});

test('real-time Longbridge feed is not penalized by 900s against Yahoo during regular US hours',()=>{
  const stamps=['2026-11-13T10:00:00-05:00','2026-11-13T10:01:00-05:00','2026-11-13T10:02:00-05:00'];
  const longbridge=feed(stamps.map((s,i)=>bar(s,100+i,i<2)),{interval:'1m',source:'Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com'});
  const yahoo=feed(stamps.map((s,i)=>bar(s,100+i,false)),{interval:'1m',source:'Yahoo Finance 网页行情 · query1.finance.yahoo.com'});
  assert.equal(chooseEquityHistory([yahoo,longbridge]),longbridge);
  assert.equal(chooseEquityHistory([longbridge,yahoo]),longbridge);
});
