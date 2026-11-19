import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runForecastValidationCli} from '../scripts/validate-forecast.ts';
import type {MarketData} from '../lib/market-types';

test('CLI saves a reproducible source-hashed current-model report without inventing results for short history',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'forecast-validation-')),input=join(dir,'input.json'),output=join(dir,'report.json');
  const start=Date.UTC(2025,0,1)/1000;
  const primary:MarketData={instrument:{id:'crypto:X',market:'crypto',symbol:'XUSDT',name:'Fixture',exchange:'Fixture',currency:'USDT'},interval:'1h',source:'fixture',adjustment:'不复权',asOf:new Date((start+70*3600)*1000).toISOString(),delayNotice:'test fixture only',warnings:[],availableIntervals:['1h'],candles:Array.from({length:70},(_,i)=>({time:start+i*3600,open:100,high:101,low:99,close:100,volume:100,closed:true}))};
  try {
    await writeFile(input,JSON.stringify({primary}));await runForecastValidationCli([input,output]);
    const report=JSON.parse(await readFile(output,'utf8'));
    assert.equal(report.status,'insufficient-history');assert.equal(report.baseline.completed,0);assert.equal(report.baseline.meanNetReturnPct,null);
    assert.equal(report.method.model,'current buildForecast; legacy tradePlans disabled');assert.equal(report.evidenceSufficient,false);
    assert.match(report.provenance.inputSha256,/^[a-f0-9]{64}$/);assert.match(report.engineSha256['lib/forecast.ts'],/^[a-f0-9]{64}$/);
    assert.equal(report.method.minimumCompleted,30);assert.equal(report.method.costs.feeBps,5);
  }finally {
    await Promise.all([input,output].map(p=>unlink(p).catch(()=>{})));await rmdir(dir);
  }
});
