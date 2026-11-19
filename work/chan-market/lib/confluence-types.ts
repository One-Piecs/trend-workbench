import type { Candle, Interval, Market, MarketData } from './market-types';

export type ConfluenceDirection = 'long' | 'short' | 'neutral';
export type ConfluenceStatus = 'aligned' | 'mixed' | 'opposed' | 'insufficient';
export type HigherConfluenceStatus = 'ready' | 'loading' | 'error' | 'none' | 'imported' | 'insufficient' | 'stale' | 'mismatch';
export interface ConfluenceContext {
  market: Market;
  interval: Interval;
  symbol?: string;
  source?: string;
  adjustment?: string;
  higher?: { interval: Interval | null; status: 'ready' | 'loading' | 'error' | 'none' | 'imported'; data?: MarketData };
}
export interface AnalysisInput {
  market: Market;
  interval: Interval;
  symbol?: string;
  source?: string;
  adjustment?: string;
  count: number;
  firstTime: number | null;
  lastBar: Candle | null;
}
export interface MacdConfluence {
  status: 'ready' | 'insufficient';
  direction: ConfluenceDirection;
  momentum: 'strengthening' | 'weakening' | 'flat';
  dif: number | null;
  dea: number | null;
  hist: number | null;
  samples: number;
}
export interface VolumeConfluence {
  status: 'ready' | 'insufficient';
  ratio: number | null;
  participation: 'expanded' | 'normal' | 'low' | 'unknown';
  priceDirection: ConfluenceDirection;
  samples: number;
  benchmark: 'same-session-slot' | 'rolling-bars';
  reason: 'ready' | 'short-history' | 'zero-volume' | 'no-context';
}
export interface HigherConfluence {
  interval: Interval | null;
  status: HigherConfluenceStatus;
  direction: ConfluenceDirection;
  bars: number;
  asOf: number | null;
}
export type ConfluenceEvidenceCode =
  | 'macd-aligned' | 'macd-weakening' | 'macd-opposed' | 'macd-mixed' | 'macd-insufficient'
  | 'volume-aligned' | 'volume-opposed' | 'volume-normal' | 'volume-low' | 'volume-insufficient'
  | 'higher-aligned' | 'higher-opposed' | 'higher-neutral' | 'higher-insufficient' | 'higher-loading'
  | 'higher-error' | 'higher-none' | 'higher-imported' | 'higher-stale' | 'higher-mismatch';
export interface ConfluenceEvidence {
  factor: 'macd' | 'volume' | 'higher';
  status: ConfluenceStatus;
  code: ConfluenceEvidenceCode;
}
export interface ConfluenceSide {
  status: ConfluenceStatus;
  evidence: ConfluenceEvidence[];
}
/** An auxiliary snapshot, never a trigger, probability, or revision of a stored plan. */
export interface Confluence {
  input?: AnalysisInput;
  advisory: true;
  asOf: number;
  macd: MacdConfluence;
  volume: VolumeConfluence;
  higher: HigherConfluence;
  long: ConfluenceSide;
  short: ConfluenceSide;
}
