import assert from 'node:assert/strict';
import test from 'node:test';
import {planCharge,planGarrison,planReinforcements} from '../lib/battle-formation.ts';

test('each fill has a stable formation, with different lanes, timings and squad sizes across fills',()=>{
  const plans=Array.from({length:100},(_,i)=>planReinforcements(784,'market/'+i,'infantry',false));
  assert.deepEqual(plans[0],planReinforcements(784,'market/0','infantry',false));
  assert.notDeepEqual(plans[0],planReinforcements(785,'market/0','infantry',false));
  assert.deepEqual(new Set(plans.map(p=>p.soldiers.length)),new Set([1,2,3,4,5]));
  assert.deepEqual(new Set(plans.map(p=>p.lane)),new Set([0,1,2,3]));
  assert.ok(plans.some((p,i)=>i>0&&p.lane===plans[i-1].lane));
  const marks=plans.flatMap(p=>p.soldiers.map(man=>man.second));
  assert.ok(marks.includes(null)&&marks.some(second=>second!==null));
  for(const tier of ['grenade','armor','artillery','air'] as const){
    assert.equal(planReinforcements(12,'market/90',tier,false).soldiers.length,1);
  }
  for(let i=0;i<100;i++)assert.ok(planReinforcements(500,String(i),'infantry',true).soldiers.length<=3);
});

test('standing and charging companies vary across lanes while keeping narrow formations legible',()=>{
  for(const compact of [false,true]){
    const rows=planGarrison(322,'buy',compact);
    assert.notDeepEqual(rows,planGarrison(322,'sell',compact));
    assert.equal(rows.reduce((n,row)=>n+row.soldiers.length+1,0),compact?12:36);
    assert.ok(new Set(rows.map(row=>row.soldiers.length)).size>=3);
    const surge=planCharge(322,'trade/78',compact);
    assert.deepEqual(surge,planCharge(322,'trade/78',compact));
    assert.notDeepEqual(surge,planCharge(322,'trade/79',compact));
    assert.equal(new Set(surge.map(row=>row.wait)).size,4);
    assert.equal(surge.filter(row=>row.flag).length,2);
  }
});
