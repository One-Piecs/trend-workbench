import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceQuoteSequence,displayQuoteSequence,quotePeriodBounds,selectQuoteOverlay,usExtendedSessionInfo} from '../lib/quote-overlay.ts';
import type {QuoteSequence,SourceQuote} from '../lib/quote-overlay.ts';
import type {Candle,Interval,MarketData} from '../lib/market-types.ts';

const epoch=(iso:string)=>Date.parse(iso)/1000;
const cn=epoch('2026-03-03T10:12:13+08:00');
const us=epoch('2026-11-27T12:55:13-05:00');
const oil=epoch('2026-11-17T17:32:13-06:00');
const prices={open:11,high:15,low:10,close:13,volume:200};
const prior={open:11,high:14,low:11,close:12,volume:170,closed:false};

function snapshot(market:SourceQuote['market'], interval:Interval, candles:Candle[]=[]):MarketData {
  const symbol={cn:'600519.SH',us:'NVDA',commodity:'CL=F'}[market];
  return {
    instrument:{market,symbol,id:market+':'+symbol,name:symbol,exchange:market,currency:market==='cn'?'CNY':'USD'},
    interval,candles,asOf:'',delayNotice:'',availableIntervals:[interval],warnings:[],
    source:{cn:'东方财富 网页行情 · push2his.eastmoney.com',us:'Yahoo Finance 网页行情 · query1.finance.yahoo.com',commodity:'Yahoo Finance 期货行情 · query2.finance.yahoo.com'}[market],
    adjustment:'来源原始OHLC',
  };
}
function quote(data:MarketData,time:number,provider:string):SourceQuote {
  const market=data.instrument.market;
  if(market==='crypto') throw new Error('unsupported fixture');
  const bounds=quotePeriodBounds(market,data.interval,time);
  if(!bounds)throw new Error('test fixture outside of session');
  return {
    market,symbol:data.instrument.symbol,currency:data.instrument.currency,venue:{cn:'XSHG',us:'US',commodity:'NYMEX'}[market],
    provider,price:prices.close,time,bar:{...prices,...bounds,interval:data.interval},
  };
}

test('bounds use the trading venue session including Shanghai lunch, US early close/DST and the overnight futures trade date',()=>{
  const bounds=(a:string,b:string)=>({start:epoch(a),end:epoch(b)});
  assert.deepEqual(quotePeriodBounds('cn','4h',cn),bounds('2026-03-03T09:30+08:00','2026-03-03T15:00+08:00'));
  assert.deepEqual(quotePeriodBounds('cn','1h',epoch('2026-03-03T13:55+08:00')),bounds('2026-03-03T13:00+08:00','2026-03-03T14:00+08:00'));
  assert.equal(quotePeriodBounds('cn','4h',epoch('2026-03-03T11:45+08:00')),null);
  assert.deepEqual(quotePeriodBounds('us','4h',us),bounds('2026-11-27T09:30-05:00','2026-11-27T13:00-05:00'));
  assert.equal(quotePeriodBounds('us','4h',epoch('2026-11-27T13:10-05:00')),null);
  assert.deepEqual(quotePeriodBounds('us','1w',us),bounds('2026-11-23T09:30-05:00','2026-11-27T13:00-05:00'));
  assert.deepEqual(quotePeriodBounds('us','1h',epoch('2026-07-20T09:40-04:00')),bounds('2026-07-20T09:30-04:00','2026-07-20T10:30-04:00'));
  assert.deepEqual(quotePeriodBounds('commodity','1d',oil),bounds('2026-11-17T17:00-06:00','2026-11-18T16:00-06:00'));
  assert.equal(quotePeriodBounds('commodity','1w',epoch('2026-11-20T17:30-06:00')),null);
  assert.equal(quotePeriodBounds('commodity','5m',epoch('2026-11-17T16:25-06:00')),null);
});

test('A-share session OHLC in shares can refresh compatible daily or 4h charts; never extrapolate it into another timeframe',()=>{
  for(const interval of ['4h','1d','1h','1w','1M'] as const){
    const data=snapshot('cn',interval), q=quote(data,cn,'tencent');
    q.bar=undefined;
    q.sessionBar=prices;
    data.candles=[{...prior,time:quotePeriodBounds('cn',interval,cn)!.start}];
    const original=structuredClone(data),result=selectQuoteOverlay(data,q,cn*1000)!;
    assert.equal(!!result.candle,interval==='4h'||interval==='1d');
    assert.equal(!!result.nativeCandle,interval==='4h'||interval==='1d');
    assert.deepEqual(data,original);
    assert.equal(result.quality,'observed');
  }
});

test('matched end-stamped intraday chart requires the complete source bar, identical basis and monotone OHLC and share count',()=>{
  const data=snapshot('cn','5m'),q=quote(data,cn,'tencent');
  const bar=q.bar!;
  data.candles=[{...prior,time:bar.end}];
  bar.provider='eastmoney';
  const read=()=>selectQuoteOverlay(data,q,cn*1000)!;
  assert.equal(read().candle?.time,bar.end);
  assert.equal(read().nativeCandle?.time,bar.start);
  data.source='腾讯证券 K线（独立备用） · ifzq.gtimg.cn';
  data.adjustment='来源分钟OHLC（复权口径未独立核验）；成交量单位：股';
  assert.equal(read().candle,undefined);
  bar.provider='tencent';
  bar.priceBasis='tencent-minute-native';
  assert.equal(read().candle?.time,bar.end);
  for(const change of [{open:12},{high:16},{low:9},{volume:201},{volume:200},{closed:true}]){
    data.candles=[{...prior,...change,time:bar.end}];
    assert.equal(read().candle,undefined);
    assert.ok(read().nativeCandle);
  }
});

test('US same-source raw minute OHLC can update or append an adjacent candle; IEX and adjusted history remain independent',()=>{
  const data=snapshot('us','5m'), q=quote(data,us,'yahoo'), bar=q.bar!;
  const read=()=>selectQuoteOverlay(data,q,us*1000)!;
  data.candles=[{...prior,time:bar.start}];
  assert.deepEqual(read().candle,{...prices,time:bar.start,closed:false});
  data.candles=[{...prior,time:bar.start-300,closed:true}];
  assert.equal(read().candle?.time,bar.start);
  data.candles=[{...prior,time:bar.start-600,closed:true}];
  assert.equal(read().candle,undefined);
  data.candles=[{...prior,time:bar.start}];
  data.adjustment='按调整后收盘价等比例调整OHLC';
  assert.equal(read().candle,undefined);
  data.adjustment='来源原始OHLC';
  q.provider='alpaca';
  q.quality='realtime';
  assert.equal(read().candle,undefined);
  assert.equal(read().quality,'realtime');
  assert.equal(read().nativeCandle?.close,prices.close);
});

test('futures identity, signed WTI, vendor separation and current contract verification',()=>{
  const data=snapshot('commodity','15m'),q=quote(data,oil,'barchart'),bar=q.bar!;
  data.instrument.contract='CLF27';
  q.contract='CLF27';
  data.candles=[{...prior,time:bar.start}];
  const read=()=>selectQuoteOverlay(data,q,oil*1000);
  assert.equal(read()?.nativeCandle?.open,prices.open);
  assert.equal(read()?.candle,undefined);
  q.provider='yahoo';
  assert.equal(read()?.candle?.close,13);
  q.contract='CLZ26'; assert.equal(read(),null);
  q.contract='GCZ26'; assert.equal(read(),null);
  q.contract='CLF27';
  q.price=-1;
  q.bar={...bar,open:-2,high:0,low:-3,close:-1};
  assert.equal(read()?.nativeCandle?.low,-3);
});

test('no displayed bar for previous bucket, wrong duration, sparse quote, zero-volume or inconsistent OHLC snapshots',()=>{
  const data=snapshot('us','1m'), q=quote(data,us,'yahoo'), bar=q.bar!;
  for(const change of [{start:bar.start-60},{end:bar.end+60},{volume:0},{volume:-1},{open:20},{low:14},{close:14}]){
    const result=selectQuoteOverlay(data,{...q,bar:{...bar,...change}},us*1000)!;
    assert.deepEqual(result,{price:prices.close,time:us,venue:'US',quality:'observed'});
  }
  const next=selectQuoteOverlay(data,q,bar.end*1000)!;
  assert.equal(next.price,prices.close);
  assert.equal(next.nativeCandle,undefined);
});

test('reject wrong instrument, market, currency, venue, stale or future timestamps, and a clock that has entered recess',()=>{
  const data=snapshot('cn','5m'),q=quote(data,cn,'eastmoney');
  for(const change of [{price:NaN},{price:-1},{time:cn+10},{time:cn-61},{time:cn*1000},
    {market:'us'},{symbol:'600519.SZ'},{currency:'USD'},{venue:'XSHE'}]){
    assert.equal(selectQuoteOverlay(data,{...q,...change},cn*1000),null);
  }
  const lunch=epoch('2026-03-03T11:30:05+08:00');
  assert.equal(selectQuoteOverlay(data,{...q,time:lunch-10},lunch*1000),null);
  const beijing=snapshot('cn','1m');
  beijing.instrument={...beijing.instrument,symbol:'920599.BJ',id:'cn:920599.BJ'};
  assert.ok(selectQuoteOverlay(beijing,{...quote(beijing,cn,'tencent'),venue:'BJSE'},cn*1000));
});

test('A-share chart crosses scheduled lunch, the overnight session and a weekend but never a missing traded bar',()=>{
  const examples=[
    ['5m','2026-11-20T11:30','2026-11-20T13:01',true],
    ['5m','2026-11-20T11:25','2026-11-20T13:01',false],
    ['5m','2026-11-20T11:30','2026-11-20T13:06',false],
    ['5m','2026-11-19T15:00','2026-11-20T09:32',true],
    ['5m','2026-11-20T15:00','2026-11-23T09:32',true],
    ['5m','2026-11-19T15:00','2026-11-23T09:32',false],
    ['4h','2026-11-20T09:30','2026-11-23T09:32',true],
    ['1d','2026-11-20T09:30','2026-11-23T09:32',true],
    ['1d','2026-11-19T09:30','2026-11-23T09:32',false],
  ] as const;
  for(const [interval,priorStamp,sourceTime,expected] of examples){
    const t=epoch(sourceTime+'+08:00');
    const data=snapshot('cn',interval,[{...prior,time:epoch(priorStamp+'+08:00'),closed:true}]);
    const q=quote(data,t,'eastmoney');
    assert.equal(!!selectQuoteOverlay(data,q,t*1000)?.candle,expected,interval+' '+priorStamp+' '+sourceTime);
    data.candles[0].closed=false;
    assert.equal(selectQuoteOverlay(data,q,t*1000)?.candle,undefined);
  }
});

test('US adjacent session uses the actual previous close and the next opening across a DST change',()=>{
  const t=epoch('2026-11-02T09:32:00-05:00');
  const data=snapshot('us','5m',[{...prior,time:epoch('2026-10-30T15:55:00-04:00'),closed:true}]);
  const q=quote(data,t,'yahoo');
  assert.ok(selectQuoteOverlay(data,q,t*1000)?.candle);
  data.candles[0].time-=300;
  assert.equal(selectQuoteOverlay(data,q,t*1000)?.candle,undefined);
});

function quotePolls(){
  const base=epoch('2026-11-20T10:01:00+08:00');
  const data=snapshot('cn','5m');
  const initial=quote(data,base,'eastmoney');
  data.candles=[{open:100,high:101,low:99,close:100,volume:100,time:initial.bar!.end,closed:false}];
  let sequence:QuoteSequence|null=null;
  function poll(second:number,fields:Partial<Candle>|null,received=second,provider='eastmoney'){
    const q=quote(data,base+second,provider);
    if(fields){
      q.bar={...q.bar!,open:100,high:103,low:98,close:102,volume:200,...fields,provider};
      q.price=q.bar.close;
    }else{q.bar=undefined;q.price=105;}
    const now=(base+received)*1000;
    const updated=advanceQuoteSequence(data,sequence,q,now);
    sequence=updated.sequence;
    return {...displayQuoteSequence(data,sequence,now),reconcile:updated.reconcile};
  }
  return {poll,data};
}

test('late or regressing polls cannot overwrite the displayed high, low, close or cumulative volume',()=>{
  const {poll}=quotePolls();
  assert.equal(poll(1,{}).candle?.volume,200);
  const regression={high:102,low:99,close:101,volume:140};
  const first=poll(6,regression);
  assert.equal(first.reconcile,true);
  assert.deepEqual([first.quote?.price,first.candle?.high,first.candle?.low,first.candle?.volume],[102,103,98,200]);
  assert.equal(poll(3,{high:105,volume:250},7).candle?.volume,200);
  // Replaying the same correction inside the server's three-second cache cannot confirm it.
  assert.equal(poll(6,regression,8).candle?.volume,200);
  const resumed=poll(10,{high:104,volume:215});
  assert.equal(resumed.reconcile,false);
  assert.equal(resumed.candle?.volume,215);
  assert.equal(poll(9,{high:106,volume:250},11).candle?.volume,215);
  assert.equal(poll(12,{high:104,volume:215,close:103}).reconcile,true);
});

test('only an independent matching-feed cumulative read can confirm an ongoing correction',()=>{
  const {poll}=quotePolls();
  poll(1,{});
  const correction={high:102,low:99,close:101,volume:140};
  assert.ok(poll(5,correction).reconcile);
  // Same venue but a different provider has a different tape; its OHLCV cannot confirm the first correction.
  const other=poll(11,correction,11,'tencent');
  assert.equal(other.candle?.volume,200);
  assert.equal(other.quote?.candle,undefined);
  assert.equal(other.quote?.nativeCandle?.volume,140);
  assert.equal(poll(10,{high:106,volume:270},12).candle?.volume,200);
  assert.equal(poll(17,correction).candle?.volume,200);
  const verified=poll(22,{...correction,volume:146});
  assert.deepEqual([verified.quote?.price,verified.candle?.high,verified.candle?.low,verified.candle?.volume],[101,102,99,146]);
});

test('price-only, ended intervals and authoritative closed REST candles cannot resurrect a stale chart overlay',()=>{
  const {poll,data}=quotePolls();
  poll(1,{});
  const priceOnly=poll(5,null);
  assert.equal(priceOnly.quote?.price,105);
  assert.equal(priceOnly.quote?.candle,undefined);
  assert.equal(priceOnly.candle?.volume,200);
  assert.equal(poll(8,{high:102,low:99,close:101,volume:140}).candle?.volume,200);
  data.candles[0].closed=true;
  assert.equal(poll(10,null).candle,undefined);
  const afterBoundary=poll(245,null);
  assert.equal(afterBoundary.quote?.price,105);
  assert.equal(afterBoundary.candle,undefined);
});

test('usExtendedSessionInfo classifies Sun overnight through Fri post and excludes weekends and holidays',()=>{
  const cases=[
    ['2026-11-22T19:59:00-05:00',null],
    ['2026-11-22T20:00:00-05:00','overnight'],
    ['2026-11-23T03:59:00-05:00','overnight'],
    ['2026-11-23T04:00:00-05:00','pre'],
    ['2026-11-23T09:30:00-05:00','regular'],
    ['2026-11-23T16:00:00-05:00','post'],
    ['2026-11-23T20:00:00-05:00','overnight'],
    ['2026-11-25T21:00:00-05:00',null],
    ['2026-11-26T10:00:00-05:00',null],
    ['2026-11-27T13:00:00-05:00','post'],
    ['2026-11-27T20:00:00-05:00',null],
    ['2026-11-28T10:00:00-05:00',null],
  ] as const;
  for(const [iso,expected] of cases){
    assert.equal(usExtendedSessionInfo(epoch(iso))?.session??null,expected,iso);
  }
});

test('Longbridge extended quotes use observedAt freshness without fabricating candles and refresh sequence on newer polls',()=>{
  const data={...snapshot('us','1m'),source:'Longbridge OpenAPI 美股行情（含夜盘） · open.longbridge.com',adjustment:'不复权（原始价格）；成交量单位：股'};
  const nowSec=epoch('2026-11-23T21:05:00-05:00');
  const tradeTime=nowSec-180;
  const firstInput:SourceQuote={market:'us',symbol:'NVDA',currency:'USD',venue:'Longbridge OpenAPI',provider:'longbridge',quality:'realtime',session:'overnight',price:142.5,time:tradeTime,observedAt:nowSec};

  const firstOverlay=selectQuoteOverlay(data,firstInput,nowSec*1000);
  assert.deepEqual(firstOverlay,{price:142.5,time:tradeTime,observedAt:nowSec,venue:'Longbridge OpenAPI',provider:'longbridge',quality:'realtime',session:'overnight'});

  let seq=advanceQuoteSequence(data,null,firstInput,nowSec*1000).sequence;
  assert.equal(displayQuoteSequence(data,seq,nowSec*1000).quote?.price,142.5);

  // Quiet overnight poll 8s later: same trade timestamp, fresh observedAt advances sequence
  const secondInput:SourceQuote={...firstInput,price:142.6,observedAt:nowSec+8};
  seq=advanceQuoteSequence(data,seq,secondInput,(nowSec+8)*1000).sequence;
  assert.equal(displayQuoteSequence(data,seq,(nowSec+8)*1000).quote?.price,142.6);

  // Stale observedAt (>60s) or session transition rejects the quote
  assert.equal(selectQuoteOverlay(data,{...firstInput,observedAt:nowSec-61},nowSec*1000),null);
  assert.equal(selectQuoteOverlay(data,firstInput,epoch('2026-11-24T04:00:05-05:00')*1000),null);
});
