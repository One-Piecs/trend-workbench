/** The tier describes one spot fill, in USDT, and only affects its depiction. */
export const battleDeployments = [
  {tier:'infantry',min:0,zh:'步兵',en:'Infantry'},
  {tier:'grenade',min:10_000,zh:'手榴弹',en:'Grenade'},
  {tier:'armor',min:50_000,zh:'炮击',en:'Cannon'},
  {tier:'artillery',min:250_000,zh:'重炮',en:'Heavy artillery'},
  {tier:'air',min:1_000_000,zh:'空袭',en:'Airstrike'},
] as const;

export type BattleTier = typeof battleDeployments[number]['tier'];

export function battleUnit(notional:number) {
  return battleDeployments.findLast(r=>notional>=r.min)??battleDeployments[0];
}
export function battleTier(notional:number):BattleTier {
  return battleUnit(notional).tier;
}
