import type { Interval, Market } from './market-types';

/** Chart time labels. Stocks show the viewer's local time plus the exchange
 * clock (US equities use America/New_York, including overnight sessions);
 * crypto and A-shares stay local-only to avoid cluttering the axis. */
const NY = 'America/New_York';

function localStamp(t: number, full: boolean, interval: Interval, locale: string): string {
  const date = new Date(t * 1000);
  if (interval === '1M') return date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit' });
  if (full) return date.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  if (['1m', '5m', '15m', '30m'].includes(interval)) return date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toLocaleDateString(locale, interval === '1w' ? { year: '2-digit', month: '2-digit', day: '2-digit' } : { month: '2-digit', day: '2-digit' });
}

/** Exchange-clock suffix for US equities; pre/post/overnight candles share the
 * same New York clock, so one suffix covers every session. */
export function exchangeStamp(t: number, full: boolean, interval: Interval, locale: string): string {
  const date = new Date(t * 1000);
  if (interval === '1M') return date.toLocaleDateString(locale, { timeZone: NY, year: 'numeric', month: '2-digit' });
  if (['1d', '1w'].includes(interval)) return date.toLocaleDateString(locale, { timeZone: NY, month: '2-digit', day: '2-digit' });
  const clock = date.toLocaleString(locale, { timeZone: NY, ...(full ? { year: 'numeric' } : {}), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return full || ['1m', '5m', '15m', '30m'].includes(interval) ? clock : `${date.toLocaleDateString(locale, { timeZone: NY, month: '2-digit', day: '2-digit' })} ${date.toLocaleTimeString(locale, { timeZone: NY, hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

/** Whether the exchange clock adds real information for this market. */
export function dualClockMarket(market: Market | undefined): boolean {
  return market === 'us';
}

/** Split axis label so the two clocks stack vertically instead of colliding. */
export function axisStamp(t: number, interval: Interval, locale: string, market?: Market): { local: string; exchange: string } | null {
  if (!dualClockMarket(market)) return null;
  return { local: localStamp(t, false, interval, locale), exchange: exchangeStamp(t, false, interval, locale) };
}

export function chartStamp(t: number, full: boolean, interval: Interval, locale: string, market?: Market): string {
  const local = localStamp(t, full, interval, locale);
  if (!dualClockMarket(market)) return local;
  return `${local} · ${exchangeStamp(t, full, interval, locale)}`;
}
