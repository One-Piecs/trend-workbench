import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWatchlist, persistWatchlistRemote, syncWatchlistOnMount } from '../lib/watchlist-storage.ts';
import type { Instrument } from '../lib/market-types';

const btc: Instrument = { id: 'crypto:BTCUSDT', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'crypto', exchange: 'Binance', currency: 'USDT' };
const nvda: Instrument = { id: 'us:NVDA', symbol: 'NVDA', name: 'NVIDIA 英伟达', market: 'us', exchange: 'NASDAQ', currency: 'USD' };

test('parseWatchlist validates instrument rows and rejects malformed entries', () => {
  assert.deepEqual(parseWatchlist([btc, nvda]), [btc, nvda]);
  assert.equal(parseWatchlist('not-an-array'), null);
  assert.equal(parseWatchlist([{ ...btc, market: 'forex' }]), null);
  assert.equal(parseWatchlist([{ ...btc, name: '' }]), null);
});

test('syncWatchlistOnMount migrates local items when server watchlist is uninitialized', async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (method === 'GET') return new Response(JSON.stringify({ initialized: false, items: [] }), { status: 200 });
    return new Response(JSON.stringify({ initialized: true, items: [btc] }), { status: 200 });
  }) as typeof fetch;

  const synced = await syncWatchlistOnMount([btc], fetcher);
  assert.deepEqual(synced, [btc]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].body!), { items: [btc] });
});

test('syncWatchlistOnMount prefers server items when already initialized', async () => {
  const fetcher = (async () => new Response(JSON.stringify({ initialized: true, items: [nvda] }), { status: 200 })) as typeof fetch;
  const synced = await syncWatchlistOnMount([btc], fetcher);
  assert.deepEqual(synced, [nvda]);
});

test('syncWatchlistOnMount and persistWatchlistRemote degrade gracefully when endpoint is absent or unreachable', async () => {
  const notFound = (async () => new Response('Not found', { status: 404 })) as typeof fetch;
  assert.equal(await syncWatchlistOnMount([btc], notFound), null);

  const offline = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  assert.equal(await syncWatchlistOnMount([btc], offline), null);
  await assert.doesNotReject(() => persistWatchlistRemote([btc], offline));
});
