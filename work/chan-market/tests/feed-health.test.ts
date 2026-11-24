import test from 'node:test';
import assert from 'node:assert/strict';
import {getFeedHealth} from '../lib/feed-health.ts';
import type {Interval,Market,MarketData} from '../lib/market-types';
const ms=(s:string)=>Date.parse(s);
function data(now:string,last:string,market:Market='crypto',interval:Interval='1m',source=market==='crypto'?'Binance':market==='cn'?'东方财富':'Yahoo Finance'):MarketData {
  return {instrument:{id:`${market}:TEST`,market,symbol:'TEST',name:'Test',exchange:'Test',currency:'USD'},interval,source,asOf:now,adjustment:'none',delayNotice:'',warnings:[],availableIntervals:[interval],candles:[{time:ms(last)/1000,open:100,high:101,low:99,close:100,volume:1,closed:false}]};
}
test('fetch success cannot make old crypto bars current',()=>{
  const now='2026-11-13T10:00:30Z';
  assert.equal(getFeedHealth(data(now,'2026-11-13T10:00:00Z'),{nowMs:ms(now),lastSuccessAtMs:ms(now)}).state,'fresh');
  const old=getFeedHealth(data(now,'2026-11-13T09:50:00Z'),{nowMs:ms(now),lastSuccessAtMs:ms(now)});
  assert.equal(old.state,'stale');assert.equal(old.allowSignals,false);
});
test('cached asOf and last successful transport are checked independently',()=>{
  const now='2026-11-13T10:00:30Z',value=data(now,'2026-11-13T10:00:00Z');
  assert.equal(getFeedHealth(value,{nowMs:ms(now),lastSuccessAtMs:ms(now)-180000}).state,'stale');
  assert.equal(getFeedHealth({...value,asOf:'2026-11-13T09:55:00Z'},{nowMs:ms(now),lastSuccessAtMs:ms(now)}).state,'stale');
});
test('freshly fetched weekend and China lunch history is closed, never a false signal',()=>{
  for(const [now,last] of [['2026-11-14T02:00:00Z','2026-11-13T07:00:00Z'],['2026-11-13T04:00:00Z','2026-11-13T03:30:00Z']]){
    const h=getFeedHealth(data(now,last,'cn'),{nowMs:ms(now),lastSuccessAtMs:ms(now)});
    assert.equal(h.state,'closed');assert.equal(h.allowSignals,false);assert.match(h.detail,/最近K线日期/);
  }
});
test('closed market does not conceal transport failure or stale cached response',()=>{
  const now='2026-11-14T02:00:00Z',value=data(now,'2026-11-13T07:00:00Z','cn');
  assert.equal(getFeedHealth(value,{nowMs:ms(now),error:'timeout'}).state,'error');
  assert.equal(getFeedHealth({...value,asOf:'2026-11-13T07:01:00Z'},{nowMs:ms(now),lastSuccessAtMs:ms(now)}).state,'stale');
});
test('US regular hours follow New York daylight saving time',()=>{
  for(const [now,last] of [['2026-03-09T14:00:30Z','2026-03-09T14:00:00Z'],['2026-11-02T15:00:30Z','2026-11-02T15:00:00Z']]){
    assert.equal(getFeedHealth(data(now,last,'us'),{nowMs:ms(now),lastSuccessAtMs:ms(now)}).state,'fresh');
  }
});
test('US expected delay is distinguishable from hard stale data',()=>{
  const now='2026-11-13T15:20:00Z';
  const delayed=getFeedHealth(data(now,'2026-11-13T15:10:00Z','us'),{nowMs:ms(now),lastSuccessAtMs:ms(now)});
  assert.equal(delayed.state,'delayed');assert.equal(delayed.allowSignals,true);
  assert.equal(getFeedHealth(data(now,'2026-11-13T14:55:00Z','us'),{nowMs:ms(now),lastSuccessAtMs:ms(now)}).state,'stale');
});
test('an unknown source and a verified exchange holiday each pause new signals',()=>{
  const now='2026-11-13T10:00:30Z';
  const unknown=getFeedHealth(data(now,now,'crypto','1m','Unspecified feed'),{nowMs:ms(now),lastSuccessAtMs:ms(now)});
  assert.equal(unknown.state,'unknown');assert.equal(unknown.allowSignals,false);
  const holiday='2026-11-26T17:00:00Z';
  const gap=getFeedHealth(data(holiday,'2026-11-25T20:59:00Z','us'),{nowMs:ms(holiday),lastSuccessAtMs:ms(holiday)});
  assert.equal(gap.state,'closed');assert.equal(gap.allowSignals,false);
});
test('half days, Chinese holidays, missing instrument data and uncovered dates remain distinct',()=>{
  const health=(now:string,last:string,market:'cn'|'us')=>getFeedHealth(data(now,last,market),{nowMs:ms(now)});
  assert.equal(health('2026-11-27T18:01:00Z','2026-11-27T17:59:00Z','us').label,'今日已提前收市');
  assert.equal(health('2026-10-01T02:12:00Z','2026-09-30T07:00:00Z','cn').label,'今日休市');
  assert.equal(health('2026-11-30T17:00:00Z','2026-11-27T17:59:00Z','us').label,'缺少今日行情');
  assert.equal(health('2040-05-02T14:00:00Z','2040-05-02T14:00:00Z','us').allowSignals,false);
});
test('end-labelled China forming hours may be ahead, while future crypto starts are rejected',()=>{
  const now='2026-11-13T02:00:00Z',future='2026-11-13T02:30:00Z';
  assert.equal(getFeedHealth(data(now,future,'cn','1h'),{nowMs:ms(now),lastSuccessAtMs:ms(now)}).state,'fresh');
  assert.equal(getFeedHealth(data(now,future,'crypto','1h'),{nowMs:ms(now),lastSuccessAtMs:ms(now)}).state,'unknown');
});
test('future four-hour equity bucket starts cannot pass as current even without aggregation in the source name',()=>{
  const cases=[['cn','2026-11-13T02:00:00Z'],['us','2026-11-13T15:00:00Z']] as const;
  for(const [market,now] of cases){
    const future=new Date(ms(now)+90*60000).toISOString();
    const health=getFeedHealth(data(now,future,market,'4h','东方财富'),{nowMs:ms(now)});
    assert.equal(health.state,'unknown');
    assert.equal(health.allowSignals,false);
  }
});
test('a current monthly bar is period coverage, not a fabricated last-trade timestamp',()=>{
  const now='2026-11-13T10:00:00Z',value=data(now,'2026-11-01T00:00:00Z','crypto','1M');
  const before=structuredClone(value),health=getFeedHealth(value,{nowMs:ms(now),lastSuccessAtMs:ms(now)});
  assert.equal(health.state,'fresh');assert.equal(health.quoteTimeMs,null);
  assert.equal(health.lastBarTimeMs,ms('2026-11-01T00:00:00Z'));assert.match(health.detail,/逐笔/);
  assert.deepEqual(value,before);
  assert.equal(getFeedHealth(data(now,'2026-10-01T00:00:00Z','crypto','1M'),{nowMs:ms(now),lastSuccessAtMs:ms(now)}).state,'stale');
});
test('opening grace retains prior-day history but never permits old entry alerts',()=>{
  const now='2026-11-13T14:31:00Z',health=getFeedHealth(data(now,'2026-11-12T20:59:00Z','us'),{nowMs:ms(now),lastSuccessAtMs:ms(now)});
  assert.equal(health.state,'delayed');assert.equal(health.allowSignals,false);
});
