import type { Candle, Interval, Market } from './market-types';
import type { MarketRegime } from './market-regime';

export interface ForecastContext {
  market:Market; symbol:string; interval:Interval; source:string; adjustment:string;
  /** Optional historical cutoff in Unix seconds. Omit when candles already form a replay prefix. */
  asOf?:number;
}
export type ForecastDirection='long'|'short'|'neutral';
export interface TimeframeAssessment {
  status:'aligned'|'countertrend'|'mixed'|'unavailable';
  /** Current structural direction before the existing auxiliary veto. */
  currentDirection:ForecastDirection;
  higherDirection:ForecastDirection|null; higherInterval:Interval|null;
  asOf:number|null; higherAsOf:number|null;
  reason:'ready'|'current-unavailable'|'higher-unavailable'|'no-higher-timeframe'|'snapshot-mismatch'|'future-higher'|'interval-mismatch';
}
export type ForecastKind='breakout'|'pullback'|'breakdown'|'rebound';
export type ForecastSource='confirmed-fractal'|'confirmed-stroke'|'confirmed-center'|'atr-reference';
export type ForecastBasisCode=ForecastSource|'atr-buffer'|'structural-target'|'estimated-target';
export type ForecastReasonCode='bias-long'|'bias-short'|'balanced'|'confluence-aligned'|'confluence-opposed'|'structure-insufficient'|'history-insufficient'|'direction-unavailable';
export type ForecastNoticeCode='live-reference'|'volatility-reference'|'estimated-targets'|'bounded-volatility'|'invalid-candles-excluded'|'future-candles-excluded'|'analysis-prefix-mismatch'|'short-history'|'cn-short-restricted';
export type ForecastTriggerRule='close-above'|'close-below'|'touch-then-close-above'|'touch-then-close-below';
export interface ForecastLevel {
  price:number; source:ForecastSource; estimated:boolean;
  /** Actual historical anchor and the raw bar index at which it became known. */
  time:number|null; index:number|null; confirmedAt:number|null;
}
export type ForecastTarget=ForecastLevel;
interface ForecastSideBase {side:'long'|'short';kind:ForecastKind;basis:ForecastBasisCode[];triggerRule:ForecastTriggerRule}
export interface ReadyForecastSide extends ForecastSideBase {
  status:'ready'; id:string; zoneLow:number;zoneHigh:number;triggerPrice:number;invalidationPrice:number;
  targets:[ForecastTarget,ForecastTarget]; anchor:ForecastLevel;
}
export interface InsufficientForecastSide extends ForecastSideBase {
  status:'insufficient'; id:null; zoneLow:null;zoneHigh:null;triggerPrice:null;invalidationPrice:null;
  targets:null;anchor:null;
}
export type ForecastSide=ReadyForecastSide|InsufficientForecastSide;
/** A fresh conditional outlook, with no position, fill or past-trigger state. */
export interface MarketForecast {
  /** Optional on saved legacy snapshots; new forecasts always supply these. */
  modelVersion?:string; parameterVersion?:string; analysisVersion?:string;
  regime?:MarketRegime; timeframeAssessment?:TimeframeAssessment;
  status:'ready'|'insufficient'; mode:'structure'|'volatility'|'insufficient'; context:ForecastContext;
  referencePrice:number|null;referenceTime:number|null;referenceClosed:boolean;
  lastClosedPrice:number|null;lastClosedTime:number|null;
  /** Structure availability time and snapshot time, both Unix seconds. */
  structureAsOf:number|null;asOf:number;atr:number|null;buffer:number|null;
  direction:ForecastDirection;reasonCodes:ForecastReasonCode[];noticeCodes:ForecastNoticeCode[];
  support:ForecastLevel|null;resistance:ForecastLevel|null;long:ForecastSide;short:ForecastSide;
}
/** Monitor callers may keep the raw current bar independently; a forecast never stores a position. */
export type ForecastCandle=Pick<Candle,'time'|'close'|'closed'>;
