import test from 'node:test';
import assert from 'node:assert/strict';
import { filterWatchlist } from '../lib/watchlist-search.ts';
import type { Instrument } from '../lib/market-types';

const sample: Instrument[] = [
  { id: 'crypto:BTCUSDT', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'crypto', exchange: 'Binance', currency: 'USDT' },
  { id: 'us:NVDA', symbol: 'NVDA', name: 'NVIDIA 英伟达', market: 'us', exchange: 'NASDAQ', currency: 'USD' },
  { id: 'cn:600519.SH', symbol: '600519.SH', name: '贵州茅台', market: 'cn', exchange: '上交所', currency: 'CNY' },
  { id: 'commodity:GC=F', symbol: 'GC=F', name: '黄金期货', market: 'commodity', exchange: 'COMEX', currency: 'USD' },
  { id: 'commodity:CL=F', symbol: 'CL=F', name: 'WTI原油期货', market: 'commodity', exchange: 'NYMEX', currency: 'USD' },
];

test('empty or whitespace query returns the full watchlist in original order without mutating it', () => {
  const snapshot = structuredClone(sample);
  assert.deepEqual(filterWatchlist(sample, ''), sample);
  assert.deepEqual(filterWatchlist(sample, '   \t '), sample);
  assert.deepEqual(sample, snapshot);
});

test('matches watchlist items by symbol, formatted crypto pair, localized name and exchange', () => {
  assert.deepEqual(filterWatchlist(sample, 'btc/usdt').map(i => i.id), ['crypto:BTCUSDT']);
  assert.deepEqual(filterWatchlist(sample, '英伟达').map(i => i.id), ['us:NVDA']);
  assert.deepEqual(filterWatchlist(sample, 'nvidia', 'en').map(i => i.id), ['us:NVDA']);
  assert.deepEqual(filterWatchlist(sample, '600519').map(i => i.id), ['cn:600519.SH']);
  assert.deepEqual(filterWatchlist(sample, 'nasdaq').map(i => i.id), ['us:NVDA']);
});

test('matches commodity aliases in both Chinese and English and returns empty when unmatched', () => {
  assert.deepEqual(filterWatchlist(sample, '黄金').map(i => i.id), ['commodity:GC=F']);
  assert.deepEqual(filterWatchlist(sample, 'gold', 'en').map(i => i.id), ['commodity:GC=F']);
  assert.deepEqual(filterWatchlist(sample, 'wti').map(i => i.id), ['commodity:CL=F']);
  assert.deepEqual(filterWatchlist(sample, 'NONEXISTENT'), []);
});
