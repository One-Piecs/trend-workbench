import type { MarketData } from './market-types.ts';
import type { MarketForecast, TimeframeAssessment } from './forecast-types.ts';
import type { MarketRegime } from './market-regime.ts';

/** A compact audit trail, not a complete historical market-data archive. */
export interface ForecastAudit {
  version: 1;
  modelVersion: string;
  parameterVersion: string;
  analysisVersion: string;
  forecastAsOf: number;
  regime: MarketRegime | null;
  timeframes: TimeframeAssessment | null;
  input: { count: number; firstTime: number | null; lastTime: number | null; sourceAsOf: string; fingerprint: string };
}

/** Non-cryptographic checksum for spotting changed input snapshots. */
export function forecastInputFingerprint(data: Pick<MarketData, 'candles'>): string {
  let hash = 0x811c9dc5;
  for (const b of data.candles) {
    const row = JSON.stringify([b.time, b.open, b.high, b.low, b.close, b.volume, b.closed ?? null]) + '\n';
    for (let i = 0; i < row.length; i++) hash = Math.imul(hash ^ row.charCodeAt(i), 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

export function captureForecastAudit(data: MarketData, forecast: MarketForecast): ForecastAudit {
  return {
    version: 1,
    modelVersion: forecast.modelVersion ?? 'legacy-unversioned',
    parameterVersion: forecast.parameterVersion ?? 'legacy-unversioned',
    analysisVersion: forecast.analysisVersion ?? 'legacy-unversioned',
    forecastAsOf: forecast.asOf,
    regime: forecast.regime ? structuredClone(forecast.regime) : null,
    timeframes: forecast.timeframeAssessment ? structuredClone(forecast.timeframeAssessment) : null,
    input: { count: data.candles.length, firstTime: data.candles[0]?.time ?? null, lastTime: data.candles.at(-1)?.time ?? null,
      sourceAsOf: data.asOf, fingerprint: forecastInputFingerprint(data) },
  };
}

export function forecastVersionKey(forecast: Pick<MarketForecast, 'modelVersion' | 'analysisVersion' | 'parameterVersion' | 'regime'>): string {
  if (!forecast.modelVersion || forecast.modelVersion === 'legacy-unversioned') return 'legacy-unversioned';
  return [forecast.modelVersion, forecast.analysisVersion ?? 'legacy-unversioned', forecast.parameterVersion ?? 'legacy-unversioned', forecast.regime?.version ?? 'no-regime'].join(' / ');
}

export function forecastCohort(record: { audit?: ForecastAudit }): string {
  const a = record.audit;
  return a ? forecastVersionKey({ ...a, regime: a.regime ?? undefined }) : 'legacy-unversioned';
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nullable = (v: unknown) => v === null || finite(v);
const count = (v: unknown) => finite(v) && Number.isInteger(v) && v >= 0;
const direction = (v: unknown) => ['long', 'short', 'neutral'].includes(String(v));
const intervals = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'];
export function validForecastAudit(v: unknown): v is ForecastAudit {
  if (!object(v) || v.version !== 1 || !['modelVersion', 'parameterVersion', 'analysisVersion'].every(k => typeof v[k] === 'string' && v[k].length > 0 && v[k].length < 200) || !finite(v.forecastAsOf)) return false;
  if (!object(v.input) || !count(v.input.count) || !nullable(v.input.firstTime) || !nullable(v.input.lastTime) || typeof v.input.sourceAsOf !== 'string' || typeof v.input.fingerprint !== 'string' || !/^fnv1a32:[0-9a-f]{8}$/.test(v.input.fingerprint)) return false;
  if (v.regime !== null) {
    const r = v.regime;
    if (!object(r) || typeof r.version !== 'string' || !['ready', 'insufficient'].includes(String(r.status)) || !['trend', 'range', 'transition', 'volatile'].includes(String(r.state)) || !direction(r.direction) || !count(r.samples) || !count(r.volatilitySamples) || !finite(r.asOf)) return false;
    if (!['adx', 'plusDI', 'minusDI', 'volatilityPercentile'].every(k => r[k] === null || finite(r[k]) && r[k] >= 0 && r[k] <= 100) || !(r.atrPct === null || finite(r.atrPct) && r.atrPct >= 0)) return false;
  }
  if (v.timeframes !== null) {
    const t = v.timeframes;
    if (!object(t) || !['aligned', 'countertrend', 'mixed', 'unavailable'].includes(String(t.status)) || !direction(t.currentDirection) || !(t.higherDirection === null || direction(t.higherDirection)) || !(t.higherInterval === null || intervals.includes(String(t.higherInterval))) || !nullable(t.asOf) || !nullable(t.higherAsOf)) return false;
    if (!['ready', 'current-unavailable', 'higher-unavailable', 'no-higher-timeframe', 'snapshot-mismatch', 'future-higher', 'interval-mismatch'].includes(String(t.reason))) return false;
  }
  return true;
}
