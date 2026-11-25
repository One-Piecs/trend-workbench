import { searchCommodities } from './commodity-catalog.ts';
import { translateInstrumentName } from './market-i18n.ts';
import type { Instrument } from './market-types';

/** Filter saved watchlist instruments by symbol, formatted spot pair, localized name, exchange, or commodity alias. */
export function filterWatchlist(watchlist: Instrument[], query: string, language: 'zh' | 'en' = 'zh'): Instrument[] {
  const trimmed = query.trim();
  if (!trimmed) return watchlist;
  const needle = trimmed.toLowerCase();
  const commodityIds = new Set(searchCommodities(trimmed).map(item => item.id));
  return watchlist.filter(item => {
    const pair = item.symbol.endsWith('USDT') ? `${item.symbol.slice(0, -4)}/USDT` : item.symbol;
    return item.symbol.toLowerCase().includes(needle)
      || pair.toLowerCase().includes(needle)
      || item.name.toLowerCase().includes(needle)
      || translateInstrumentName(item.name, language).toLowerCase().includes(needle)
      || item.exchange.toLowerCase().includes(needle)
      || (item.market === 'commodity' && commodityIds.has(item.id));
  });
}
