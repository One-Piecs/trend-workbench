import assert from 'node:assert/strict';
import test from 'node:test';
import {BattleChargeDetector} from '../lib/battle-charge.ts';

const buy=(notional:number)=>({side:'buy' as const,notional});
const sell=(notional:number)=>({side:'sell' as const,notional});

test('a confirmed crossing requires new net flow in its direction, and reports the four-second net',()=>{
  for(const bullish of [true,false]){
    const d=new BattleChargeDetector(),forward=bullish?buy:sell,back=bullish?sell:buy;
    const other=bullish?47:53,across=bullish?52:48;
    assert.equal(d.update(other,[],0),null);
    assert.equal(d.update(50,[forward(46_000),back(7000)],400),null);
    assert.deepEqual(d.update(across,[forward(15_000),back(3000)],700),forward(51_000));
    assert.equal(d.update(across,[forward(100_000)],701),null);
  }
});

test('initial imbalance, a quiet crossing, insufficient net flow and aged fills do not start a charge',()=>{
  const d=new BattleChargeDetector();
  assert.equal(d.update(87,[buy(300_000)],0),null);
  assert.equal(d.update(50,[],2800),null);
  // The older buys expire. A crossing caused by window expiry cannot announce a charge.
  assert.equal(d.update(49,[sell(250_000)],4100),null);
  assert.equal(d.update(47,[],4600),null);
  assert.equal(d.update(53,[buy(300_000),sell(51_000)],4700),null);
  d.reset();
  assert.equal(d.update(48,[],5000),null);
  assert.equal(d.update(50,[buy(55_000)],5200),null);
  assert.equal(d.update(50,[],8500),null);
  assert.equal(d.update(52,[buy(100)],9300),null);
});

test('hysteresis and cooldown suppress repeat bursts, then allow the next genuine recross',()=>{
  const d=new BattleChargeDetector();
  d.update(47,[],0);
  assert.deepEqual(d.update(54,[buy(50_000)],250),buy(50_000));
  assert.equal(d.update(49,[sell(250_000)],330),null);
  assert.equal(d.update(47,[sell(100_000)],510),null);
  assert.equal(d.update(50,[],2780),null);
  assert.deepEqual(d.update(54,[buy(70_000)],4600),buy(70_000));
  assert.equal(d.update(null,[],4610),null);
  assert.equal(d.update(43,[sell(250_000)],4620),null);
  assert.equal(d.update(53,[buy(900_000)],4000),null);
});

test('a late burst expires by the matching engine timestamp, and future matches cannot confirm a crossing',()=>{
  const d=new BattleChargeDetector();
  d.update(45,[],1000);
  d.update(50,[{...buy(90_000),at:1100}],3840);
  assert.equal(d.update(53,[{...buy(40_000),at:5100},{...buy(150_000),at:5300}],5200),null);
  d.reset();
  d.update(46,[],7000);
  assert.deepEqual(d.update(53,[{...buy(58_000),at:7040},{...sell(7000),at:7050}],7100),buy(51_000));
});
