import test from 'node:test';
import assert from 'node:assert/strict';
import {crossedBoundary,recentCenterBreakout} from '../lib/breakout-observation.ts';
import type {Center} from '../lib/market-types.ts';

test('a breakout departs from inside an active center and closes beyond the boundary',()=>{
  const center:Center={low:90,high:100,startIndex:1,endIndex:9,level:'笔中枢',status:'active'};
  assert.deepEqual(crossedBoundary(center,100,101),{direction:'up',boundary:100});
  assert.deepEqual(crossedBoundary(center,90,89),{direction:'down',boundary:90});
  assert.equal(crossedBoundary(center,95,100),undefined);
  assert.equal(crossedBoundary(center,101,102),undefined);
  assert.equal(crossedBoundary({...center,status:'broken'},95,103),undefined);
});

test('a forming candle, a wick and a gap cannot confirm a new observation',()=>{
  const start=Date.UTC(2026,0,1)/1000;
  const bars=Array.from({length:80},(_,i)=>{
    const price=100+7*Math.sin(i/3)+3*Math.sin(i/11);
    return {time:start+i*3600,open:price,close:price,high:price+1,low:price-1,volume:10,closed:true};
  });
  const bar={time:start+80*3600,open:bars[79].close,high:112,low:108,close:111,volume:10,closed:true};
  const previous=recentCenterBreakout(bars,'1h');
  const confirmed=recentCenterBreakout([...bars,bar],'1h');
  assert.equal(confirmed?.start,bar.time);
  assert.equal(confirmed?.direction,'up');
  assert.equal(confirmed?.level,'stroke');
  assert.ok(confirmed!.boundary>bar.open&&confirmed!.boundary<bar.close);
  assert.deepEqual(recentCenterBreakout([...bars,{...bar,closed:false}],'1h'),previous);
  assert.notEqual(recentCenterBreakout([...bars,{...bar,close:bar.open}],'1h')?.start,bar.time);
  assert.notEqual(recentCenterBreakout([...bars,{...bar,time:bar.time+3600}],'1h')?.start,bar.time+3600);
});
