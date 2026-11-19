import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validateForecast,type ForecastValidationInput} from '../lib/forecast-validation.ts';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const defaultOutput=resolve(repo,'../../outputs/forecast-validation');
const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const engineFiles=['lib/chan.ts','lib/market-types.ts','lib/trade-plans.ts','lib/forecast.ts','lib/forecast-types.ts','lib/market-regime.ts','lib/confluence.ts','lib/confluence-types.ts','lib/timeframe-context.ts','lib/forecast-journal.ts','lib/forecast-audit.ts','lib/higher-from-primary.ts','lib/equity-four-hour.ts','lib/forecast-validation.ts','scripts/validate-forecast.ts'];
async function engineHashes(){return Object.fromEntries(await Promise.all(engineFiles.map(async p=>[p,sha256(await readFile(resolve(repo,p)))])));}
async function loadJson(path:string){return JSON.parse(await readFile(path,'utf8'));}

/** CLI accepts a saved MarketData, a {primary,higher,costs,...} input, or a
 * manifest {samples:[{name,inputPath}]} whose paths are relative to the manifest.
 */
export async function runForecastValidationCli(args:string[]):Promise<unknown> {
  const [inputArg,outputArg]=args;
  if(!inputArg)throw new Error('Usage: node --experimental-strip-types scripts/validate-forecast.ts INPUT.json REPORT.json');
  const before=await engineHashes();
  const path=resolve(inputArg),raw=await loadJson(path);
  if(Array.isArray(raw.samples)) {
    const output=resolve(outputArg??defaultOutput);await mkdir(output,{recursive:true});
    const results=[];
    for(const sample of raw.samples) {
      if(typeof sample.name!=='string'||!/^[a-zA-Z0-9._-]+$/.test(sample.name)||typeof sample.inputPath!=='string')throw new Error('Manifest sample needs a simple name and inputPath.');
      results.push(await runForecastValidationCli([resolve(dirname(path),sample.inputPath),resolve(output,`${sample.name}.report.json`)]));
    }
    return results;
  }
  const input:ForecastValidationInput=raw.primary?raw:{primary:raw};
  const report=validateForecast(input),after=await engineHashes();
  if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Source changed during validation. Re-run.');
  const result={...report,provenance:{inputSha256:sha256(await readFile(path))},engineSha256:before};
  const output=resolve(outputArg??`${path}.forecast-report.json`);await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({output,baseline:report.baseline,shadow:report.shadow,windows:report.windows.length}));
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runForecastValidationCli(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
