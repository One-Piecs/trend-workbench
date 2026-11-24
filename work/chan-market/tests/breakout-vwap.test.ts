import test from 'node:test';
import assert from 'node:assert/strict';
import {breakoutBarContinuity,breakoutVwap,weightedBreakoutLine} from '../lib/breakout-vwap.ts';
import type {Candle} from '../lib/market-types.ts';

const crossing={level:'stroke',direction:'up',boundary:105} as const;
const time=(value:string)=>Date.parse(value)/1000;
function bar(date:string,close=100,volume=2):Candle {
  return {time:time(date),open:close,high:close+2,low:close-2,close,volume,closed:true};
}
function complete<T>(job:Generator<void,T>):T {
  let step=job.next();
  while(!step.done)step=job.next();
  return step.value;
}

test('VWAP weights each completed HLC3 by base volume and ignores pre-anchor prices',()=>{
  const bars=[
    bar('2026-01-01T00:00Z',999,1000),{...bar('2026-01-01T01:00Z',110,2),high:118,low:102,close:104},
    bar('2026-01-01T02:00Z',114,4),{...bar('2026-01-01T03:00Z',114,0),high:114,low:114},
  ];
  const line=weightedBreakoutLine(bars,1,4,crossing);
  assert.equal(line.status,'ready');
  if(line.status==='ready')assert.deepEqual(line.points,[{index:1,value:108},{index:2,value:112},{index:3,value:112}]);
  assert.equal(weightedBreakoutLine([...bars,bar('2026-01-01T04:00Z',116,0)],1,5,crossing).status,'no-volume');
  assert.equal(weightedBreakoutLine([{...bars[0],volume:NaN}],0,1,crossing).status,'incomplete');
});

test('latest confirmed breakout remains anchored past 12 bars; replay never includes the next breakout',()=>{
  const start=time('2026-01-01T00:00Z');
  const bars=Array.from({length:80},(_,i)=>{
    const price=100+7*Math.sin(i/3)+3*Math.sin(i/11);
    return {...bar('2026-01-01T00:00Z',price),time:start+i*3600,high:price+1,low:price-1};
  });
  const breakout={...bar('2026-01-01T00:00Z',111),time:start+80*3600};
  const after=Array.from({length:19},(_,i)=>({...breakout,time:breakout.time+(i+1)*3600}));
  const full=[...bars,breakout,...after];
  const line=complete(breakoutVwap(full,'crypto','1h',''));
  assert.equal(line.status,'ready');
  if(line.status==='ready'){
    assert.equal(line.anchor,80);
    assert.equal(line.points.at(-1)?.index,99);
    assert.equal(line.crossing.direction,'up');
  }
  const before=complete(breakoutVwap(bars,'crypto','1h',''));
  assert.deepEqual(complete(breakoutVwap(full,'crypto','1h','',80)),before);
  assert.deepEqual(complete(breakoutVwap([...bars,{...breakout,closed:false}],'crypto','1h','')),before);
  assert.equal(complete(breakoutVwap([...bars,{...breakout,time:breakout.time+3600}],'crypto','1h','')).status,'incomplete');
  const reversal=[111,112,108,105,100,95,89].map((price,i)=>({...breakout,time:breakout.time+i*3600,
    open:price-1,high:price+1,low:price-1,close:price}));
  const reanchored=complete(breakoutVwap([...bars,...reversal],'crypto','1h',''));
  assert.equal(reanchored.status,'ready');
  if(reanchored.status==='ready'){
    assert.equal(reanchored.anchor,86);
    assert.equal(reanchored.crossing.direction,'down');
    assert.deepEqual(reanchored.points,[{index:86,value:89}]);
  }
});

test('equity neighbours respect China lunch, US half days, intraday gaps and exchange holidays',()=>{
  const chinaHour=breakoutBarContinuity('cn','1h','东方财富');
  assert.ok(chinaHour(bar('2026-09-14T11:30:00+08:00'),bar('2026-09-14T14:00:00+08:00')));
  assert.equal(chinaHour(bar('2026-09-14T11:30:00+08:00'),bar('2026-09-14T15:00:00+08:00')),false);
  const us4h=breakoutBarContinuity('us','4h','Yahoo Finance');
  assert.ok(us4h(bar('2025-11-26T13:30:00-05:00'),bar('2025-11-28T09:30:00-05:00')));
  assert.ok(us4h(bar('2025-11-28T09:30:00-05:00'),bar('2025-12-01T09:30:00-05:00')));
  assert.equal(us4h(bar('2025-11-26T09:30:00-05:00'),bar('2025-11-28T09:30:00-05:00')),false);
  const usDaily=breakoutBarContinuity('us','1d','Yahoo Finance');
  assert.ok(usDaily(bar('2025-11-26T09:30:00-05:00'),bar('2025-11-28T09:30:00-05:00')));
  assert.equal(usDaily(bar('2025-11-26T09:30:00-05:00'),bar('2025-12-01T09:30:00-05:00')),false);
});
