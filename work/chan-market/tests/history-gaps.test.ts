import test from 'node:test';
import assert from 'node:assert/strict';
import {latestHistoryGap} from '../lib/history-gaps.ts';
import type {Market,MarketData} from '../lib/market-types';
function series(market:Market,a:string,b:string,source='Yahoo Finance'){
  return {instrument:{market},source,interval:'1m',candles:[a,b].map(t=>({time:Date.parse(t)/1000,closed:true}))} as MarketData;
}
test('an intraday hole can be requested without inventing a candle during lunch, the weekend, or the futures maintenance break',()=>{
  assert.equal(latestHistoryGap(series('crypto','2026-11-21T00:00Z','2026-11-21T00:03Z'))?.limit,3);
  assert.equal(latestHistoryGap(series('us','2026-11-20T14:30Z','2026-11-20T14:34Z'))?.limit,4);
  assert.equal(latestHistoryGap(series('cn','2026-11-20T03:30Z','2026-11-20T05:01Z')),undefined);
  assert.equal(latestHistoryGap(series('us','2026-11-20T20:59Z','2026-11-23T14:30Z')),undefined);
  assert.equal(latestHistoryGap(series('commodity','2026-11-18T21:59Z','2026-11-18T23:00Z')),undefined);
});
