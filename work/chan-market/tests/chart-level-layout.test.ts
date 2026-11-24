import assert from 'node:assert/strict';
import test from 'node:test';
import {placePriceTags} from '../lib/chart-level-layout.ts';

test('nearby prices retain their true anchors while labels fit in price order at both edges and the middle',()=>{
  for(const anchor of [14,95,170]){
    const tags=[{id:'entry',height:43,anchorY:anchor+1},{id:'stop',height:30,anchorY:anchor-2},
      {id:'t1',height:30,anchorY:anchor+2},{id:'t2',height:30,anchorY:anchor+3}];
    const placed=placePriceTags(tags,12,176);
    assert.deepEqual(placed.map(tag=>tag.id),['stop','entry','t1','t2']);
    let nextTop=12;
    for(const tag of placed){
      assert.equal(tag.anchorY,tags.find(original=>original.id===tag.id)?.anchorY);
      assert.ok(tag.boxY>=nextTop);
      nextTop=tag.boxY+tag.height;
    }
    assert.ok(nextTop<=176);
  }
});

test('spaced labels stay centered on the target price',()=>{
  const tags=[{anchorY:50,height:34},{anchorY:138,height:48},{anchorY:224,height:34}];
  assert.ok(placePriceTags(tags,10,268).every(tag=>tag.boxY+tag.height/2===tag.anchorY));
});
