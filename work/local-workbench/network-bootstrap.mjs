import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const runFile=promisify(execFile);
const loopback=['localhost','127.0.0.1','::1','[::1]'];
const owns=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const envValue=(env,name)=>owns(env,name.toLowerCase())?env[name.toLowerCase()]:env[name];
function proxyUrl(value){
  if(typeof value!=='string'||!value.trim())return undefined;
  try {
    const input=value.trim();
    const url=new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input)?input:`http://${input}`);
    return ['http:','https:'].includes(url.protocol)&&url.hostname?url.toString():undefined;
  }catch{return undefined;}
}
function bypass(value){
  return [...new Set([...String(value??'').split(/[;,]/).map(v=>v.trim()).filter(v=>v&&v!=='<local>'),...loopback])].join(',');
}

/** Read existing Windows Internet Settings only. No registry writes, browser
 * cookies, new proxy services, PAC execution or credential logging. */
export async function readWindowsProxySettings(){
  if(process.platform!=='win32')return null;
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const command="$s=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop; [pscustomobject]@{ProxyEnable=$s.ProxyEnable;ProxyServer=$s.ProxyServer;ProxyOverride=$s.ProxyOverride;AutoConfigURL=$s.AutoConfigURL}|ConvertTo-Json -Compress";
  try {
    const {stdout}=await runFile(executable,['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:4000,maxBuffer:65536,encoding:'utf8'});
    return JSON.parse(stdout.replace(/^\uFEFF/,''));
  }catch{return null;}
}

// Read the top-level SystemConfiguration dictionary. Scoped interfaces, PAC and
// SOCKS have different routing semantics and must not become global HTTP proxies.
export function parseMacProxySettings(output){
  const fields=new Map(), exceptions=[];
  let depth=0, inExceptions=false;
  for(const raw of output.split(/\r?\n/)){
    const line=raw.trim();
    if(line==='}'){
      if(depth===2)inExceptions=false;
      depth--;
    }else if(/<(?:dictionary|array)>\s*\{$/.test(line)){
      if(depth===1)inExceptions=/^ExceptionsList\s*:\s*<array>/.test(line);
      depth++;
    }else{
      const pair=line.match(/^([\w]+)\s*:\s*(.+)$/);
      if(!pair)continue;
      if(depth===1)fields.set(pair[1],pair[2].trim());
      if(depth===2&&inExceptions&&/^\d+$/.test(pair[1]))exceptions.push(pair[2].trim());
    }
  }
  function endpoint(protocol){
    const host=fields.get(protocol+'Proxy'),port=Number(fields.get(protocol+'Port'));
    if(fields.get(protocol+'Enable')!=='1'||!host||/[\s/@?#;\\]/.test(host)||!Number.isInteger(port)||port<1||port>65535)return undefined;
    const authority=host.includes(':')&&!host.startsWith('[')?'['+host+']':host;
    return proxyUrl('http://'+authority+':'+port);
  }
  return {platform:'darwin',http:endpoint('HTTP'),https:endpoint('HTTPS'),ProxyOverride:exceptions.join(',')};
}
async function readMacProxySettings(){
  try{
    const {stdout}=await runFile('/usr/sbin/scutil',['--proxy'],{timeout:1200,maxBuffer:65536,encoding:'utf8'});
    return parseMacProxySettings(stdout);
  }catch{return null;}
}

/** An explicit environment is authoritative, including explicitly empty proxy
 * values. Otherwise reuse the user's enabled manual system proxy by protocol. */
export function resolveNetworkProxy(env={},settings=null){
  const noProxy=envValue(env,'NO_PROXY');
  if(String(env.NODE_USE_ENV_PROXY)==='0')return {mode:'disabled',proxyEnv:{NO_PROXY:bypass(noProxy)}};
  const explicit=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'].some(name=>owns(env,name)||owns(env,name.toLowerCase()));
  let rawHttp,rawHttps,mode='direct';
  if(explicit){
    const all=envValue(env,'ALL_PROXY');
    rawHttp=envValue(env,'HTTP_PROXY')??all;
    rawHttps=envValue(env,'HTTPS_PROXY')??all;
    mode='environment';
  }else if(settings?.platform==='darwin'){
    rawHttp=settings.http;rawHttps=settings.https;
    if(rawHttp||rawHttps)mode='macos-system';
  }else if(Number(settings?.ProxyEnable)===1&&typeof settings?.ProxyServer==='string'&&settings.ProxyServer.trim()){
    const server=settings.ProxyServer.trim();
    if(/^[a-z]+\s*=/i.test(server)){
      const mapping=Object.fromEntries(server.split(';').map(part=>part.trim().match(/^([a-z]+)\s*=\s*(.+)$/i)).filter(Boolean).map(match=>[match[1].toLowerCase(),match[2].trim()]));
      rawHttp=mapping.http;rawHttps=mapping.https;
    }else rawHttp=rawHttps=server;
    mode='windows-system';
  }
  const proxyEnv={NO_PROXY:bypass(noProxy??settings?.ProxyOverride)};
  const httpProxy=proxyUrl(rawHttp),httpsProxy=proxyUrl(rawHttps);
  if(httpProxy)proxyEnv.HTTP_PROXY=httpProxy;
  if(httpsProxy)proxyEnv.HTTPS_PROXY=httpsProxy;
  const unsupported=!!((rawHttp&&!httpProxy)||(rawHttps&&!httpsProxy));
  return {mode,proxyEnv,unsupported};
}

function applyProxyConfig(config,install){
  if((config.mode==='windows-system'||config.mode==='macos-system')&&config.proxyEnv.HTTP_PROXY&&!config.proxyEnv.HTTPS_PROXY){
    // Node's global fetch dispatcher falls back to HTTP_PROXY for HTTPS.
    // A manual HTTP-only system route applies solely to HTTP.
    const previous=http.globalAgent;
    const agent=new http.Agent({keepAlive:true,proxyEnv:config.proxyEnv});
    http.globalAgent=agent;
    return ()=>{http.globalAgent=previous;};
  }
  return install(config.proxyEnv);
}

/** Re-read the system route on demand while the window is open. Node 24's
 * setGlobalProxyFromEnv({NO_PROXY:...}) is a no-op when switching to direct.
 * Its previous restore function is required to release the old dispatcher. */
export function createNetworkRouteMonitor(options={}){
  const env=options.env??process.env,platform=options.platform??process.platform;
  const explicit=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'].some(name=>owns(env,name)||owns(env,name.toLowerCase()));
  const systemReader=platform==='win32'?readWindowsProxySettings:platform==='darwin'?readMacProxySettings:null;
  const readSettings=!explicit&&String(env.NODE_USE_ENV_PROXY)!=='0'&&systemReader?(options.readSettings??systemReader):null;
  const install=options.installProxy??http.setGlobalProxyFromEnv;
  const now=options.now??Date.now;
  let revision=0,signature,restore,pending,status,previousConfig;
  let lastCheck=-Infinity;
  async function update(){
    lastCheck=now();
    const settings=readSettings?await readSettings():null;
    // A transient OS read failure must not silently drop a known network route.
    if(readSettings&&settings===null&&previousConfig)return {revision,status};
    const config=resolveNetworkProxy(env,settings);
    const nextSignature=JSON.stringify(config);
    if(nextSignature===signature)return {revision,status};
    if(typeof install!=='function'){
      status={mode:config.mode,applied:false,reason:'unsupported-runtime'};
      return {revision,status};
    }
    if(typeof restore==='function')restore();
    try{
      restore=applyProxyConfig(config,install);
    }catch{
      restore=previousConfig?applyProxyConfig(previousConfig,install):undefined;
      status={mode:config.mode,applied:false,reason:'invalid-proxy-configuration'};
      return {revision,status};
    }
    previousConfig=config;
    signature=nextSignature;
    status={mode:config.mode,applied:true,proxied:!!(config.proxyEnv.HTTP_PROXY||config.proxyEnv.HTTPS_PROXY),unsupported:!!config.unsupported};
    revision++;
    if(revision>1)options.onRouteChange?.();
    return {revision,status};
  }
  return async function checkRoute(afterMarketFailure=false){
    if(pending)return pending;
    const minInterval=afterMarketFailure?3000:30000;
    if(status&&(!readSettings||now()-lastCheck<minInterval))return {revision,status};
    pending=update().finally(()=>{pending=undefined;});
    return pending;
  };
}

export async function configureLocalNetwork(options={}){
  return (await createNetworkRouteMonitor(options)()).status;
}
