import type { Instrument } from './market-types';

export const WATCHLIST_STORAGE_KEY = 'chan-watchlist-v1';

const VALID_MARKETS = new Set(['crypto', 'us', 'cn', 'commodity']);

export function parseWatchlist(value: unknown): Instrument[] | null {
  if (!Array.isArray(value)) return null;
  const items: Instrument[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') return null;
    const item = row as Record<string, unknown>;
    if (
      typeof item.id !== 'string'
      || typeof item.market !== 'string'
      || !VALID_MARKETS.has(item.market)
      || typeof item.symbol !== 'string'
      || !item.symbol.trim()
      || typeof item.name !== 'string'
      || !item.name.trim()
    ) return null;
    items.push({
      id: item.id,
      market: item.market as Instrument['market'],
      symbol: item.symbol,
      name: item.name,
      exchange: typeof item.exchange === 'string' ? item.exchange : '',
      currency: typeof item.currency === 'string' ? item.currency : '',
    });
  }
  return items;
}

export async function syncWatchlistOnMount(localItems: Instrument[], fetcher: typeof fetch = fetch): Promise<Instrument[] | null> {
  try {
    const res = await fetcher('/api/watchlist', { cache: 'no-store' });
    if (!res.ok) return null;
    const payload = await res.json() as { initialized?: unknown; items?: unknown };
    if (payload?.initialized === true) {
      return parseWatchlist(payload.items);
    }
    if (payload?.initialized === false) {
      await persistWatchlistRemote(localItems, fetcher);
      return localItems;
    }
    return null;
  } catch {
    return null;
  }
}

export async function persistWatchlistRemote(items: Instrument[], fetcher: typeof fetch = fetch): Promise<void> {
  try {
    await fetcher('/api/watchlist', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
  } catch {
    /* Static or read-only hosts without /api/watchlist degrade cleanly to localStorage. */
  }
}
