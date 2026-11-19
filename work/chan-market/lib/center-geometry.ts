import type {Center} from './market-types';

export interface CenterViewport {
  start:number;end:number;left:number;right:number;top:number;bottom:number;
  step:number;minPrice:number;maxPrice:number;
}
export interface CenterGeometry {
  x:number;y:number;width:number;height:number;visibleTop:number;visibleBottom:number;
  firstIndex:number;lastIndex:number;
}

/** A center's solid box covers confirmed segments only, regardless of its state.
 * Preserve actual price edges; the SVG clip cuts off out-of-view portions. */
export function centerGeometry(center:Center,view:CenterViewport):CenterGeometry|null {
  const {start,end,left,right,top,bottom,step,minPrice,maxPrice}=view;
  if(![center.startIndex,center.endIndex,center.low,center.high,start,end,left,right,top,bottom,step,minPrice,maxPrice].every(Number.isFinite)
    ||center.endIndex<center.startIndex||center.low>=center.high||end<=start||right<=left||bottom<=top||step<=0||maxPrice<=minPrice)return null;
  const firstIndex=Math.max(start,center.startIndex),lastIndex=Math.min(end-1,center.endIndex);
  if(firstIndex>lastIndex||center.high<=minPrice||center.low>=maxPrice)return null;
  const x=Math.max(left,left+(firstIndex-start+.5)*step);
  const edge=Math.min(right,left+(lastIndex-start+.5)*step);
  if(x>=right||edge<x)return null;
  const y=top+(maxPrice-center.high)/(maxPrice-minPrice)*(bottom-top);
  const lower=top+(maxPrice-center.low)/(maxPrice-minPrice)*(bottom-top);
  return {x,y,width:Math.min(Math.max(1,edge-x),right-x),height:lower-y,
    visibleTop:Math.max(top,y),visibleBottom:Math.min(bottom,lower),firstIndex,lastIndex};
}
