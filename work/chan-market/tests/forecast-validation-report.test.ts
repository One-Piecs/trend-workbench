import test from 'node:test';
import assert from 'node:assert/strict';
import {FORECAST_MODEL_VERSION} from '../lib/forecast.ts';
import {createForecastValidationLoader,parseForecastValidationReport} from '../lib/forecast-validation-report.ts';

const fixture=()=>({generatedAt:'2026-11-18T03:27:45.688Z',modelVersions:[FORECAST_MODEL_VERSION],parameterVersions:['chan-atr14-v1'],analysisVersions:['chan-experimental-1.5'],engineUnchanged:true,matchesInstalledBuild:true,results:[
  {name:'crypto-BTCUSDT-1h',market:'crypto',interval:'1h',closedBars:799,folds:3,baseline:{completed:7,meanNetR:-.17,sampleStatus:'insufficient'},shadow:{completed:6,meanNetR:-.5,sampleStatus:'insufficient'}},
  {name:'us-AAPL-1d',market:'us',interval:'1d',closedBars:799,folds:3,baseline:{completed:4,meanNetR:-.37,sampleStatus:'insufficient'},shadow:{completed:2,meanNetR:.35,sampleStatus:'insufficient'}},
]});

test('report reader keeps matching model groups separate and preserves the full downloadable summary',()=>{
  const input=fixture(),before=structuredClone(input),parsed=parseForecastValidationReport(input);
  assert.equal(parsed.status,'ready');if(parsed.status!=='ready')return;
  assert.equal(parsed.summary.results.length,2);assert.deepEqual(parsed.raw,input);
  assert.equal(parsed.summary.results[1].shadow.meanNetR,.35);assert.deepEqual(input,before);
});
test('missing, mismatched and mixed version reports are unverified',()=>{
  for(const value of [null,{},'oops',{...fixture(),modelVersions:undefined},{...fixture(),modelVersions:['forecast-1.0']},{...fixture(),modelVersions:[FORECAST_MODEL_VERSION,'forecast-1.0']},{...fixture(),parameterVersions:['other']},{...fixture(),engineUnchanged:false},{...fixture(),matchesInstalledBuild:false},{...fixture(),matchesInstalledBuild:undefined},{...fixture(),analysisVersions:[]},{...fixture(),generatedAt:'not a date'}])assert.deepEqual(parseForecastValidationReport(value),{status:'unverified'});
  const input=fixture();assert.equal(parseForecastValidationReport({...input,results:[{...input.results[0],modelVersions:['forecast-1.0']}]}).status,'unverified');
});
test('reader rejects corrupt counts, returns, rows and unsupported sample claims',()=>{
  for(const change of [
    (f:ReturnType<typeof fixture>)=>{f.results[0].baseline.completed=-1;},
    (f:ReturnType<typeof fixture>)=>{f.results[0].baseline.meanNetR=Infinity;},
    (f:ReturnType<typeof fixture>)=>{f.results[0].baseline.sampleStatus='validated';},
    (f:ReturnType<typeof fixture>)=>{f.results[0].baseline.sampleStatus='unvalidated';},
    (f:ReturnType<typeof fixture>)=>{f.results[0].market='unknown';},
    (f:ReturnType<typeof fixture>)=>{f.results[0].interval='2d';},
    (f:ReturnType<typeof fixture>)=>{f.results.push(f.results[0]);},
  ]){const input=fixture();change(input);assert.deepEqual(parseForecastValidationReport(input),{status:'unverified'});}
});
test('independent single-position schedules can complete more filtered outcomes than baseline outcomes',()=>{
  const input=fixture();input.results[0].shadow.completed=12;
  const parsed=parseForecastValidationReport(input);assert.equal(parsed.status,'ready');
  if(parsed.status==='ready'){
    assert.equal(parsed.summary.results[0].baseline.completed,7);
    assert.equal(parsed.summary.results[0].shadow.completed,12);
  }
});
test('zero completed outcomes require unavailable R; larger samples still remain unvalidated',()=>{
  const input=fixture();const row=input.results[0];
  const zero={...input,results:[{...row,baseline:{completed:0,meanNetR:null as number|null,sampleStatus:'insufficient'},shadow:{completed:0,meanNetR:null,sampleStatus:'insufficient'}}]};
  assert.equal(parseForecastValidationReport(zero).status,'ready');
  zero.results[0].baseline.meanNetR=0;assert.equal(parseForecastValidationReport(zero).status,'unverified');
  const larger={...input,results:[{...row,baseline:{completed:45,meanNetR:.2,sampleStatus:'unvalidated'},shadow:{completed:35,meanNetR:.3,sampleStatus:'unvalidated'}}]};
  assert.equal(parseForecastValidationReport(larger).status,'ready');
});
test('report loader is lazy and performs exactly one request for concurrent and repeated opens',async()=>{
  let calls=0;
  const loader=createForecastValidationLoader(async(url,options)=>{calls++;assert.equal(url,'/forecast-validation.json');assert.equal(options.cache,'no-cache');return {ok:true,json:async()=>fixture()};});
  assert.equal(calls,0);
  const [first,second]=await Promise.all([loader(),loader()]);assert.equal(calls,1);assert.equal(first,second);assert.equal(first.status,'ready');
  assert.equal(await loader(),first);assert.equal(calls,1);
});
test('missing or invalid JSON and network failure remain quietly cached without retries',async()=>{
  for(const kind of ['missing','invalid','network']){
    let calls=0;const loader=createForecastValidationLoader(async()=>{calls++;if(kind==='network')throw new Error('offline');return {ok:kind!=='missing',json:async()=>{throw new Error('bad json');}};});
    assert.deepEqual(await loader(),{status:'unverified'});assert.deepEqual(await loader(),{status:'unverified'});assert.equal(calls,1);
  }
});
