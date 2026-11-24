import test from 'node:test';
import assert from 'node:assert/strict';
import {candleAvailableAt,eligibleHigherCandles,higherInterval} from '../lib/timeframe-context.ts';
import type {Candle,MarketData} from '../lib/market-types';
const epoch=(iso:string)=>Date.parse(iso)/1000;
const at=(iso:string)=>({time:epoch(iso)});
test('market-specific larger periods avoid A-share daily/4H duplicate evidence',()=>{
  assert.equal(higherInterval('cn','1h'),'1d');assert.equal(higherInterval('cn','4h'),'1w');
  assert.equal(higherInterval('us','1h'),'4h');assert.equal(higherInterval('crypto','4h'),'1d');
  assert.equal(higherInterval('crypto','1M'),null);
});
test('crypto start-labelled and calendar-month availability excludes incomplete larger bars',()=>{
  assert.equal(candleAvailableAt(at('2026-11-13T00:00Z'),'crypto','4h'),epoch('2026-11-13T04:00Z'));
  assert.equal(candleAvailableAt(at('2024-02-01T00:00Z'),'crypto','1M'),epoch('2024-03-01T00:00Z'));
});
test('China end-labelled minute and whole-session 4H bars use different endpoints',()=>{
  assert.equal(candleAvailableAt(at('2026-11-13T10:30+08:00'),'cn','1h'),epoch('2026-11-13T10:32+08:00'));
  assert.equal(candleAvailableAt(at('2026-11-13T09:30+08:00'),'cn','4h'),epoch('2026-11-13T15:02+08:00'));
});
test('US minute source convention and the shortened 4H tail are respected',()=>{
  assert.equal(candleAvailableAt(at('2026-11-13T09:30-05:00'),'us','1h','Yahoo'),epoch('2026-11-13T10:45-05:00'));
  assert.equal(candleAvailableAt(at('2026-11-13T10:30-05:00'),'us','1h','东方财富'),epoch('2026-11-13T10:45-05:00'));
  assert.equal(candleAvailableAt(at('2026-11-13T13:30-05:00'),'us','4h','东方财富 · 聚合4小时'),epoch('2026-11-13T16:15-05:00'));
});
test('weekly and monthly boundaries follow exchange-local calendars across DST',()=>{
  assert.equal(candleAvailableAt(at('2026-03-02T09:30-05:00'),'us','1w'),epoch('2026-03-06T16:15-05:00'));
  assert.equal(candleAvailableAt(at('2026-03-09T09:30-04:00'),'us','1w'),epoch('2026-03-13T16:15-04:00'));
  assert.equal(candleAvailableAt(at('2026-03-01T00:00-05:00'),'us','1M'),epoch('2026-04-01T00:00-04:00'));
  assert.equal(candleAvailableAt(at('2026-10-30T09:30+08:00'),'cn','1M'),epoch('2026-11-01T00:00+08:00'));
});
test('replay excludes larger bars that closed later even when marked closed now',()=>{
  const bar=(time:string,closed=true):Candle=>({time:epoch(time),open:100,high:105,low:99,close:101,volume:100,closed});
  const data={instrument:{market:'crypto'},interval:'4h',source:'Binance',candles:[bar('2026-11-13T00:00Z'),bar('2026-11-13T04:00Z'),bar('2026-11-13T08:00Z',false)]} as MarketData;
  assert.equal(eligibleHigherCandles(data,epoch('2026-11-13T03:00Z')).length,0);
  assert.equal(eligibleHigherCandles(data,epoch('2026-11-13T04:00Z')).length,1);
  assert.equal(eligibleHigherCandles(data,epoch('2026-11-13T12:00Z')).length,2);
  assert.equal(eligibleHigherCandles(data,NaN).length,0);
});
test('Thanksgiving half-day bars become available after the early close and reporting allowance',()=>{
  for(const [interval,start] of [['1h','2026-11-27T12:30-05:00'],['4h','2026-11-27T09:30-05:00'],['1d','2026-11-27T09:30-05:00'],['1w','2026-11-23T09:30-05:00']] as const){
    assert.equal(candleAvailableAt(at(start),'us',interval,'Yahoo Finance'),epoch('2026-11-27T13:15-05:00'));
  }
});
