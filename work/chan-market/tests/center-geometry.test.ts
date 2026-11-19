import test from 'node:test';
import assert from 'node:assert/strict';
import {centerGeometry,type CenterViewport} from '../lib/center-geometry.ts';
import type {Center} from '../lib/market-types';

const view:CenterViewport={start:0,end:100,left:18,right:718,top:100,bottom:420,step:5,minPrice:80,maxPrice:120};
const center:Center={startIndex:10,endIndex:30,low:90,high:110,status:'active',level:'线段中枢'};

test('active and broken centers end at their confirmed endpoint, never at the latest bar',()=>{
  const active=centerGeometry(center,view),broken=centerGeometry({...center,status:'broken'},view);
  assert.deepEqual(active,broken);assert.equal(active?.lastIndex,30);assert.equal(active?.width,100);
  assert.equal(active?.x,70.5);assert.ok(active!.x+active!.width<view.left+(view.end-.5)*view.step);
});
test('horizontal intersection follows actual confirmed coverage at both viewport edges',()=>{
  assert.equal(centerGeometry(center,{...view,start:31,end:100}),null);
  assert.equal(centerGeometry(center,{...view,start:0,end:10}),null);
  const partial=centerGeometry(center,{...view,start:20,end:25});
  assert.equal(partial?.firstIndex,20);assert.equal(partial?.lastIndex,24);assert.equal(partial?.x,20.5);assert.equal(partial?.width,20);
});
test('price clipping preserves the real center height instead of inventing boundary prices',()=>{
  const tall=centerGeometry({...center,low:60,high:140},view);
  assert.equal(tall?.y,-60);assert.equal(tall?.height,640);
  assert.equal(tall?.visibleTop,100);assert.equal(tall?.visibleBottom,420);
  assert.equal(centerGeometry({...center,low:121,high:140},view),null);
  assert.equal(centerGeometry({...center,low:50,high:79},view),null);
});
test('reserved forecast space cannot be occupied by a center box',()=>{
  const narrow={...view,right:120},clipped=centerGeometry(center,narrow);
  assert.equal(clipped?.x,70.5);assert.equal(clipped?.width,49.5);
  assert.ok(clipped!.x+clipped!.width<=narrow.right);
  assert.equal(centerGeometry({...center,startIndex:30,endIndex:80},narrow),null);
});
test('invalid geometry is omitted and neither center nor viewport is mutated',()=>{
  const before=structuredClone({center,view});centerGeometry(center,view);
  assert.deepEqual({center,view},before);
  for(const invalid of [{...center,low:110},{...center,high:NaN},{...center,startIndex:31}])assert.equal(centerGeometry(invalid,view),null);
  assert.equal(centerGeometry(center,{...view,minPrice:120}),null);
});
