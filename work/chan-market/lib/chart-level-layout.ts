/** Lay out price tags in price order. Only the tags move; their leaders
 * start at the exact y-coordinate of each level on the candle price scale. */
export function placePriceTags<T extends {anchorY:number; height:number}>(tags:T[], top:number, bottom:number) {
  const sorted = [...tags].sort((a,b)=>a.anchorY-b.anchorY);
  const totalHeight = sorted.reduce((sum,tag)=>sum+tag.height,0);
  const gap = Math.max(0,Math.min(4,(bottom-top-totalHeight)/Math.max(1,sorted.length-1)));
  let nextTop = top;
  const placed = sorted.map(tag=>{
    const boxY = Math.max(nextTop,tag.anchorY-tag.height/2);
    nextTop = boxY+tag.height+gap;
    return {...tag,boxY};
  });
  let nextBottom = bottom;
  for(let i=placed.length-1;i>=0;i--){
    const tag = placed[i];
    tag.boxY = Math.min(tag.boxY,nextBottom-tag.height);
    nextBottom = tag.boxY-gap;
  }
  return placed;
}
