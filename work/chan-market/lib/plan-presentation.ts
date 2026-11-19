import type { TradeDecision } from './market-types';

/** Presentation only: never erase a historical trigger or alter its stop/targets. */
export function isDirectionUnclear(decision?:TradeDecision):boolean {
  return decision?.state==='conflict'||(decision?.state==='waiting'&&decision.direction==='neutral');
}
