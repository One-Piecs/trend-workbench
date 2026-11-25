import type { Interval, MarketData } from './market-types';
import { candleAvailableAt, candleDelaySeconds } from './timeframe-context.ts';
import { forecastBarStart } from './forecast-journal.ts';
import {
  validateForecast,
  type ForecastValidationCosts,
  type ForecastValidationOutcome,
} from './forecast-validation.ts';

export interface CacheBacktestOptions {
  label?: string;
  folds?: number;
  warmupFraction?: number;
  minimumCompleted?: number;
  costs?: ForecastValidationCosts;
  penMode?: 'new' | 'old';
}

export interface CacheBacktestTradeSummary {
  id: string;
  side: 'long' | 'short';
  publishedAt: number;
  entryAt?: number;
  entryPrice?: number;
  exitAt?: number;
  exitPrice?: number;
  exitReason?: 'stop' | 'gap-stop' | 'target2';
  intrabarResolution?: 'minute';
  netReturnPct?: number;
  netR?: number;
  shadowAccepted: boolean;
  duplicateGeometry: boolean;
}

export interface CacheBacktestSideSummary {
  published: number;
  conditionsMet: number;
  modeledEntries: number;
  completed: number;
  profitable: number;
  winRate: number | null;
  longCompleted: number;
  shortCompleted: number;
  exitReasons: { target2: number; stop: number; gapStop: number };
  outcomesByStatus: Record<string, number>;
  duplicateGeometry: number;
  minuteResolved: number;
  ambiguousExits: number;
  meanNetReturnPct: number | null;
  meanNetR: number | null;
  medianNetR: number | null;
  sampleStatus: 'insufficient' | 'unvalidated';
  minimumCompleted: number;
  evidenceSufficient: boolean;
}

export interface CacheBacktestFoldSummary {
  number: number;
  startTime: number;
  endTime: number;
  bars: number;
  snapshots: number;
  directional: number;
  higherReady: number;
  baseline: CacheBacktestSideSummary;
  shadow: CacheBacktestSideSummary;
}

export interface CacheBacktestResult {
  generatedAt: string;
  durationMs: number;
  status: 'insufficient-history' | 'unvalidated';
  evidenceSufficient: false;
  activationRecommendation: string;
  data: {
    market: MarketData['instrument']['market'];
    symbol: string;
    interval: Interval;
    source: string;
    adjustment: string;
    capturedAt: string;
    totalBars: number;
    closedBars: number;
    firstTime: number | null;
    lastTime: number | null;
    higherInterval: Interval | null;
    higherBars: number;
    minuteMatched: boolean;
    minuteConflictBars: number;
    minuteResolvedBars: number;
  };
  method: ReturnType<typeof validateForecast>['method'];
  modelVersions: string[];
  parameterVersions: string[];
  analysisVersions: string[];
  baseline: CacheBacktestSideSummary;
  shadow: CacheBacktestSideSummary;
  folds: CacheBacktestFoldSummary[];
  recentTrades: CacheBacktestTradeSummary[];
  limitations: string[];
  rawReport?: ReturnType<typeof validateForecast>;
}

/** Compute exact minute-resolution time bounds for conflict bars where both stop and T2 were touched. */
export function computeMinuteReviewRanges(primary: MarketData, minuteReviewTimes: number[]): { start: number; end: number }[] {
  const unique = [...new Set(minuteReviewTimes.filter(t => Number.isFinite(t)))].sort((a, b) => a - b);
  const market = primary.instrument.market;
  const interval = primary.interval;
  const delay = candleDelaySeconds(market, interval, primary.source);
  const ranges: { start: number; end: number }[] = [];
  for (const time of unique) {
    const stub = { time, open: 1, high: 1, low: 1, close: 1, volume: 0 };
    const start = forecastBarStart(stub, primary);
    const end = candleAvailableAt({ time }, market, interval, primary.source) - delay;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function enrichSideSummary(
  summary: ReturnType<typeof validateForecast>['baseline'],
  outcomes: readonly ForecastValidationOutcome[],
): CacheBacktestSideSummary {
  const closed = outcomes.filter(o => o.status === 'closed');
  const profitable = closed.filter(o => (o.netR ?? 0) > 0).length;
  let target2 = 0, stop = 0, gapStop = 0, longCompleted = 0, shortCompleted = 0;
  for (const trade of closed) {
    if (trade.side === 'long') longCompleted++;
    else shortCompleted++;
    if (trade.exitReason === 'target2') target2++;
    else if (trade.exitReason === 'gap-stop') gapStop++;
    else if (trade.exitReason === 'stop') stop++;
  }
  return {
    ...summary,
    sampleStatus: summary.sampleStatus === 'insufficient' ? 'insufficient' : 'unvalidated',
    profitable,
    winRate: closed.length ? profitable / closed.length : null,
    longCompleted,
    shortCompleted,
    exitReasons: { target2, stop, gapStop },
  };
}

/** Run walk-forward validation on cached history, automatically loading conflict 1m windows on Pass 2. */
export async function runCachedBacktest({
  primary,
  higher,
  loadMinutes,
  options = {},
  includeRawReport = false,
}: {
  primary: MarketData;
  higher?: MarketData;
  loadMinutes?: (ranges: { start: number; end: number }[]) => MarketData | undefined | Promise<MarketData | undefined>;
  options?: CacheBacktestOptions;
  includeRawReport?: boolean;
}): Promise<CacheBacktestResult> {
  const startedAt = Date.now();
  const baseInput = {
    primary,
    ...(higher ? { higher } : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.folds !== undefined ? { folds: options.folds } : {}),
    ...(options.warmupFraction !== undefined ? { warmupFraction: options.warmupFraction } : {}),
    ...(options.minimumCompleted !== undefined ? { minimumCompleted: options.minimumCompleted } : {}),
    ...(options.costs !== undefined ? { costs: options.costs } : {}),
    ...(options.penMode !== undefined ? { penMode: options.penMode } : {}),
  };

  const preliminary = validateForecast(baseInput);
  const minuteReviewTimes = [...new Set(preliminary.windows.flatMap(w => w.minuteReviewTimes))].sort((a, b) => a - b);

  let minute: MarketData | undefined;
  if (minuteReviewTimes.length > 0 && loadMinutes && primary.interval !== '1m') {
    const ranges = computeMinuteReviewRanges(primary, minuteReviewTimes);
    if (ranges.length > 0) {
      minute = await loadMinutes(ranges);
    }
  }

  const report = minute?.candles?.length ? validateForecast({ ...baseInput, minute }) : preliminary;
  const baselineOutcomes = report.windows.flatMap(w => w.baselineOutcomes);
  const shadowOutcomes = report.windows.flatMap(w => w.shadowOutcomes);

  const folds: CacheBacktestFoldSummary[] = report.windows.map(w => ({
    number: w.number,
    startTime: w.startTime,
    endTime: w.endTime,
    bars: w.endIndex - w.startIndex + 1,
    snapshots: w.coverage.snapshots,
    directional: w.coverage.directional,
    higherReady: w.coverage.higherStatuses.ready ?? 0,
    baseline: enrichSideSummary(w.baseline, w.baselineOutcomes),
    shadow: enrichSideSummary(w.shadow, w.shadowOutcomes),
  }));

  const recentTrades: CacheBacktestTradeSummary[] = baselineOutcomes
    .filter(o => o.status === 'closed')
    .sort((a, b) => (b.exitAt ?? b.publishedAt) - (a.exitAt ?? a.publishedAt) || b.publishedAt - a.publishedAt)
    .slice(0, 30)
    .map(o => ({
      id: o.id,
      side: o.side,
      publishedAt: o.publishedAt,
      ...(o.entryAt !== undefined ? { entryAt: o.entryAt } : {}),
      ...(o.entryPrice !== undefined ? { entryPrice: o.entryPrice } : {}),
      ...(o.exitAt !== undefined ? { exitAt: o.exitAt } : {}),
      ...(o.exitPrice !== undefined ? { exitPrice: o.exitPrice } : {}),
      ...(o.exitReason !== undefined ? { exitReason: o.exitReason } : {}),
      ...(o.intrabarResolution === 'minute' ? { intrabarResolution: 'minute' as const } : {}),
      ...(o.netReturnPct !== undefined ? { netReturnPct: o.netReturnPct } : {}),
      ...(o.netR !== undefined ? { netR: o.netR } : {}),
      shadowAccepted: o.shadowAccepted,
      duplicateGeometry: o.duplicateGeometry,
    }));

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    status: report.status === 'insufficient-history' ? 'insufficient-history' : 'unvalidated',
    evidenceSufficient: false,
    activationRecommendation: report.activationRecommendation,
    data: {
      ...report.data,
      higherInterval: higher?.interval ?? null,
      higherBars: higher?.candles.length ?? 0,
      minuteMatched: Boolean(minute?.candles?.length),
      minuteConflictBars: minuteReviewTimes.length,
      minuteResolvedBars: report.baseline.minuteResolved,
    },
    method: report.method,
    modelVersions: report.modelVersions,
    parameterVersions: report.parameterVersions,
    analysisVersions: report.analysisVersions,
    baseline: enrichSideSummary(report.baseline, baselineOutcomes),
    shadow: enrichSideSummary(report.shadow, shadowOutcomes),
    folds,
    recentTrades,
    limitations: report.limitations,
    ...(includeRawReport ? { rawReport: report } : {}),
  };
}
