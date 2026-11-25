import assert from 'node:assert/strict';
import test from 'node:test';
import {createHistorySession, joinSnapshot} from '../lib/earlier-history.ts';
import {endAtTime} from '../lib/chart-viewport.ts';
import type {Candle, MarketData} from '../lib/market-types';

const bar = (time: number): Candle => ({time,open:10,high:12,low:9,close:11,volume:1,closed:true});
const identity = {market:'crypto',symbol:'BTCUSDT',interval:'1h',source:'example',adjustment:'unadjusted'} as const;
const feed: MarketData = {instrument:{id:'crypto:BTCUSDT',market:'crypto',symbol:'BTCUSDT',name:'Bitcoin',exchange:'example',currency:'USDT'},
  interval:'1h',source:identity.source,adjustment:identity.adjustment,asOf:'2026-01-01T00:00:00Z',availableIntervals:['1h'],warnings:[],delayNotice:'',candles:[10,11,12].map(bar)};
const page = (times: number[], status = 'more') => ({...identity, status, candles:times.map(bar)});
const times = (rows: Candle[]) => rows.map(row=>row.time);

test('history cursor is exclusive across pages and a nonempty last page is retained', async () => {
  const cursors:string[] = [];
  const replies = [page([8,9]),page([7],'end')];
  const session = createHistorySession(async url=>{
    const params = new URL(String(url),'http://localhost').searchParams;
    cursors.push(params.get('before')!);
    for (const [key,value] of Object.entries(identity)) assert.equal(params.get(key),value);
    return Response.json(replies.shift());
  });
  await session.load(feed);
  await session.load(feed);
  await session.load(feed);
  assert.deepEqual(cursors,['10','8']);
  assert.deepEqual(times(session.read().bars),[7,8,9,10,11,12]);
  assert.equal(session.read().status,'end');
});

test('a rolling refresh while a page is pending preserves the seam and the selected replay timestamp', async () => {
  let finish!: (response:Response)=>void;
  let calls=0;
  const session=createHistorySession(()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  const loading=session.load(feed);
  await session.load(feed);
  const fresh=[11,12,13].map(bar);
  session.refresh(fresh);
  finish(Response.json(page([8,9])));
  await loading;
  assert.equal(calls,1);
  assert.deepEqual(times(joinSnapshot(session.read().bars,fresh)),[8,9,10,11,12,13]);
  assert.equal(session.read().bars[endAtTime(session.read().bars,11)-1].time,11);
  const replacement=[bar(13),bar(14)];
  replacement[0].low=8;
  session.refresh(replacement);
  assert.deepEqual(session.read().bars,[]);
});

test('an old request cannot update a cancelled session or bridge unrelated price histories', async () => {
  let finish!: (response: Response)=>void;
  const session=createHistorySession(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=session.load(feed);
  session.cancel();
  finish(Response.json(page([9])));
  await pending;
  assert.deepEqual(session.read(),{bars:[],status:'ready'});
  assert.deepEqual(times(joinSnapshot(feed.candles,[bar(30)])),[30]);
});

test('bad pages keep the previous bars intact and allow a retry', async () => {
  for (const invalid of [page([]),page([10]),page([8,8]),page([9,8]),page([9],'unsupported'),
    {...page([9]),symbol:'ETHUSDT'}, {...page([9]),source:'other'}, {...page([9]),adjustment:'adjusted'},
    {...page([]),candles:[{...bar(9),closed:false}]}, {...page([]),candles:[{...bar(9),low:0}]}]) {
    const replies=[page([9]), invalid, page([8])];
    const session=createHistorySession(async()=>Response.json(replies.shift()));
    await session.load(feed);
    const before=session.read().bars;
    await session.load(feed);
    assert.equal(session.read().status,'error');
    assert.equal(session.read().bars,before);
    await session.load(feed);
    assert.equal(session.read().status,'ready');
    assert.deepEqual(times(session.read().bars),[8,9,10,11,12]);
  }
});

test('loadCached stitches locally cached candles onto the live series and rejects identity or seam mismatches', async () => {
  const session = createHistorySession(async url => {
    const parsed = new URL(String(url), 'http://localhost');
    assert.equal(parsed.pathname, '/api/cache/candles');
    assert.equal(parsed.searchParams.get('limit'), '5000');
    return Response.json({...identity, candles: [6, 7, 8, 9, 10, 11].map(bar)});
  });
  await session.loadCached(feed, 5000);
  assert.equal(session.read().status, 'ready');
  assert.deepEqual(times(session.read().bars), [6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(times(joinSnapshot(session.read().bars, [11, 12, 13].map(bar))), [6, 7, 8, 9, 10, 11, 12, 13]);

  for (const invalid of [
    {...identity, source: 'other', candles: [6, 7, 8, 9, 10].map(bar)},
    {...identity, candles: [6, 7, 8, 9, {...bar(10), close: 99}]},
  ]) {
    const guarded = createHistorySession(async () => Response.json(invalid));
    await guarded.loadCached(feed, 5000);
    assert.equal(guarded.read().status, 'error');
    assert.deepEqual(guarded.read().bars, []);
  }
});
