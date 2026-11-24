import { build } from '../chan-market/node_modules/esbuild/lib/main.js';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeInitScript } from '../chan-market/lib/workbench-themes.ts';

const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../chan-market');
const [mode,destination]=process.argv.slice(2);
if(mode!=='--shared-assets'||!destination)throw new Error('Usage: node build.mjs --shared-assets <directory>');
const app=path.resolve(destination);
const {version}=JSON.parse(await readFile(path.join(repo,'package.json'),'utf8'));
const require=createRequire(path.join(repo,'package.json'));
const postcss=require('postcss');
const tailwind=require('@tailwindcss/postcss');
execFileSync(process.execPath,['--experimental-strip-types','--test','tests/official-header.test.ts'],{cwd:repo,stdio:'inherit'});
await mkdir(path.join(app,'public'),{recursive:true});
await build({
  absWorkingDir:repo,entryPoints:[path.join(here,'main.tsx')],outfile:path.join(app,'public/app.js'),
  bundle:true,minify:true,format:'esm',platform:'browser',target:'es2022',jsx:'automatic',
  nodePaths:[path.join(repo,'node_modules')],tsconfig:path.join(repo,'tsconfig.json'),
  alias:{'next/link':path.join(here,'link.tsx')},define:{'process.env.NODE_ENV':'"production"'},
});
await build({absWorkingDir:repo,entryPoints:[path.join(repo,'lib/market-data.ts')],outfile:path.join(app,'market-data.mjs'),bundle:true,format:'esm',platform:'node',target:'node24',minify:false});
const cssSource=path.join(repo,'app/globals.css');
const stylesheet=await postcss([tailwind({base:repo})]).process(await readFile(cssSource,'utf8'),{from:cssSource});
await writeFile(path.join(app,'public/style.css'),stylesheet.css);
await copyFile(path.join(repo,'public/favicon.svg'),path.join(app,'public/favicon.svg'));
const audioFiles=['rifle.wav','cannon.wav','impact.wav','credits.txt'].map(name=>'public/battle-audio/'+name);
await mkdir(path.join(app,'public/battle-audio'),{recursive:true});
for(const file of audioFiles)await copyFile(path.join(repo,file),path.join(app,file));
// A new installation has no locally generated validation report.
const validationSummary={available:false,matchesInstalledBuild:false};
await writeFile(path.join(app,'public/forecast-validation.json'),JSON.stringify(validationSummary));
await copyFile(path.join(here,'network-bootstrap.mjs'),path.join(app,'network-bootstrap.mjs'));
await copyFile(path.join(here,'history-cache.mjs'),path.join(app,'history-cache.mjs'));
await writeFile(path.join(app,'public/index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="theme-color" content="#ffffff"><script>${themeInitScript}</script><title>趋势判断工作台</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><noscript>请在此独立窗口中启用 JavaScript。</noscript><script type="module" src="/app.js"></script></body></html>`);
const serverSource=(await readFile(path.join(here,'server.mjs'),'utf8')).replace('VERSION_FROM_PACKAGE', version);
const placeholder="const buildId='unpackaged';";
if(!serverSource.includes(placeholder))throw new Error('Missing desktop release identifier');
const identity=createHash('sha256').update(serverSource);
for(const file of ['market-data.mjs','network-bootstrap.mjs','history-cache.mjs','public/app.js','public/style.css','public/index.html',...audioFiles]){
  identity.update(createHash('sha256').update(await readFile(path.join(app,file))).digest());
}
const buildId=identity.digest('hex');
await writeFile(path.join(app,'server.mjs'),serverSource.replace(placeholder,`const buildId='${buildId}';`));
await writeFile(path.join(app,'build-info.json'),JSON.stringify({version,buildId,port:43127}));
console.log(`Built shared desktop assets in ${app}`);
