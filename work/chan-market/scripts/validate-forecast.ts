import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateForecast,type ForecastValidationInput} from '../lib/forecast-validation.ts';
import type {MarketData} from '../lib/market-types';
import {candleAvailableAt} from '../lib/timeframe-context.ts';
import {fetchHistoricalMinutes} from '../lib/historical-minutes.ts';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const defaultOutput=resolve(repo,'../../outputs/forecast-validation');
const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const engineFiles=[
  'lib/chan.ts','lib/market-types.ts','lib/trade-plans.ts','lib/forecast.ts','lib/forecast-types.ts','lib/market-regime.ts',
  'lib/confluence.ts','lib/confluence-types.ts','lib/timeframe-context.ts','lib/forecast-journal.ts','lib/forecast-audit.ts',
  'lib/higher-from-primary.ts','lib/equity-four-hour.ts','lib/equity-calendar.ts','lib/equity-calendar-data.ts',
  'lib/commodity-session.ts','lib/commodity-analysis.ts','lib/forecast-validation.ts','lib/forecast-validation-minutes.ts',
  'lib/historical-minutes.ts','scripts/validate-forecast.ts',
];
async function engineHashes(){return Object.fromEntries(await Promise.all(engineFiles.map(async p=>[p,sha256(await readFile(resolve(repo,p)))])));}
async function loadJson(path:string){return JSON.parse(await readFile(path,'utf8'));}

async function reviewSample(input:ForecastValidationInput,online:boolean) {
  const preliminary=validateForecast(input);
  const starts=[...new Set(preliminary.windows.flatMap(window=>window.minuteReviewTimes))].sort((a,b)=>a-b);
  const audit={conflictBars:starts.length,lookupAttempts:0,retrievedBars:0,errors:[] as {time:number;message:string}[]};
  if(!online||input.minute||input.primary.instrument.market!=='crypto'||input.primary.interval==='1m')
    return {input,report:preliminary,audit};
  let minute:MarketData|undefined;
  for(const start of starts){
    const end=candleAvailableAt({time:start},'crypto',input.primary.interval);
    audit.lookupAttempts++;
    try{
      const batch=await fetchHistoricalMinutes(input.primary,start,end);
      if(!minute)minute=batch;
      else{minute.candles.push(...batch.candles);minute.asOf=batch.asOf;}
      audit.retrievedBars++;
    }catch(error){audit.errors.push({time:start,message:error instanceof Error?error.message:'Minute history unavailable'});}
  }
  const enriched=minute?{...input,minute}:input;
  return {input:enriched,report:minute?validateForecast(enriched):preliminary,audit};
}

/** Defaults to offline reproduction. --minute-review looks up original-venue minutes only for ambiguous bars. */
export async function runForecastValidationCli(args:string[]):Promise<unknown> {
  const online=args.includes('--minute-review');
  const [inputArg,outputArg]=args.filter(arg=>arg!=='--minute-review');
  if(!inputArg)throw new Error('Usage: node --experimental-strip-types scripts/validate-forecast.ts INPUT.json REPORT.json [--minute-review]');
  const before=await engineHashes();
  const path=resolve(inputArg),raw=await loadJson(path);
  if(Array.isArray(raw.samples)) {
    const output=resolve(outputArg??defaultOutput);await mkdir(output,{recursive:true});
    const results=[];
    for(const sample of raw.samples) {
      if(typeof sample.name!=='string'||!/^[a-zA-Z0-9._-]+$/.test(sample.name)||typeof sample.inputPath!=='string')throw new Error('Manifest sample needs a simple name and inputPath.');
      results.push(await runForecastValidationCli([resolve(dirname(path),sample.inputPath),resolve(output,`${sample.name}.report.json`),...(online?['--minute-review']:[])]));
    }
    return results;
  }
  const input:ForecastValidationInput=raw.primary?raw:{primary:raw};
  const reviewed=await reviewSample(input,online),report=reviewed.report,after=await engineHashes();
  if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Source changed during validation. Re-run.');
  const output=resolve(outputArg??`${path}.forecast-report.json`);await mkdir(dirname(output),{recursive:true});
  const evidence=reviewed.input!==input?JSON.stringify(reviewed.input,null,2):null;
  if(evidence)await writeFile(output+'.input.json',evidence);
  const result={...report,minuteReview:reviewed.audit,provenance:{inputSha256:sha256(await readFile(path)),...(evidence?{normalizedSourceFile:output+'.input.json',normalizedSourceSha256:sha256(evidence)}:{})},engineSha256:before};
  await writeFile(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({output,baseline:report.baseline,shadow:report.shadow,windows:report.windows.length}));
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runForecastValidationCli(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
