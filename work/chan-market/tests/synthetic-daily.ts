import type { Candle } from '../lib/market-types';

// Deterministic multi-scale price swings for structural regression tests.
export function syntheticDaily(count = 800): Candle[] {
  const price = (i: number) => 1000 + 90 * Math.sin(i / 65) + 45 * Math.sin(i / 14) + 21 * Math.sin(i / 3);
  return Array.from({length: count}, (_, i) => {
    const open = price(i - 1), close = price(i);
    return { time: 1704067200 + i * 86400, open, close, high: Math.max(open, close) + 2,
      low: Math.min(open, close) - 2, volume: 100 + i % 31, closed: true };
  });
}
