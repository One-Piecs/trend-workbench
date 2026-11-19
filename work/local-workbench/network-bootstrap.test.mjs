import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {configureLocalNetwork,createNetworkRouteMonitor,parseMacProxySettings,resolveNetworkProxy} from './network-bootstrap.mjs';

test('macOS manual Web and Secure Web proxy routes use only the active global dictionary',async()=>{
  const settings=parseMacProxySettings(`<dictionary> {
    HTTPEnable : 1
    HTTPProxy : 127.0.0.1
    HTTPPort : 7890
    HTTPSEnable : 1
    HTTPSProxy : ::1
    HTTPSPort : 8080
    ExceptionsList : <array> {
      0 : *.example.test
      1 : 169.254/16
    }
    __SCOPED__ : <dictionary> {
      en1 : <dictionary> {
        HTTPSProxy : ignored.example
      }
    }
  }`);
  let installed,reads=0;
  const result=await configureLocalNetwork({env:{},platform:'darwin',readSettings:async()=>{reads++;return settings},installProxy:v=>{installed=v}});
  assert.equal(reads,1);assert.equal(result.mode,'macos-system');
  assert.equal(installed.HTTP_PROXY,'http://127.0.0.1:7890/');
  assert.equal(installed.HTTPS_PROXY,'http://[::1]:8080/');
  for(const host of ['localhost','127.0.0.1','::1','[::1]','*.example.test'])assert.ok(installed.NO_PROXY.split(',').includes(host));
  for(const env of [{https_proxy:''},{ALL_PROXY:'http://other.example:8080'},{NODE_USE_ENV_PROXY:'0'}]){
    await configureLocalNetwork({platform:'darwin',env,readSettings:()=>assert.fail('explicit env must win'),installProxy:()=>{}});
  }
});
test('macOS ignores PAC, SOCKS, disabled or malformed manual endpoints',()=>{
  const settings=parseMacProxySettings(`<dictionary> {
    ProxyAutoConfigEnable : 1
    ProxyAutoConfigURLString : https://pac.example/proxy
    SOCKSEnable : 1
    SOCKSProxy : 127.0.0.1
    HTTPEnable : 0
    HTTPProxy : 127.0.0.1
    HTTPPort : 8080
    HTTPSEnable : 1
    HTTPSProxy : invalid/path
    HTTPSPort : 8080
  }`);
  const config=resolveNetworkProxy({},settings);
  assert.equal(config.mode,'direct');assert.equal(config.proxyEnv.HTTPS_PROXY,undefined);
});
test('Web (HTTP) alone on macOS leaves the HTTPS market fetch dispatcher unchanged',async()=>{
  const original=http.globalAgent;
  try{
    const result=await configureLocalNetwork({env:{},platform:'darwin',
      readSettings:async()=>({platform:'darwin',http:'http://127.0.0.1:7890'}),
      installProxy:()=>assert.fail('global fetch would apply HTTP-only proxy to HTTPS market feeds')});
    assert.equal(result.mode,'macos-system');assert.equal(result.applied,true);assert.notEqual(http.globalAgent,original);
  }finally{if(http.globalAgent!==original)http.globalAgent.destroy();http.globalAgent=original;}
});

test('enabled single Windows proxy applies to both protocols and keeps loopback direct',()=>{
  const config=resolveNetworkProxy({}, {ProxyEnable:1,ProxyServer:'localhost:19080',ProxyOverride:'*.internal.test;<local>'});
  assert.equal(config.mode,'windows-system');assert.equal(config.proxyEnv.HTTP_PROXY,'http://localhost:19080/');assert.equal(config.proxyEnv.HTTPS_PROXY,'http://localhost:19080/');
  for(const host of ['localhost','127.0.0.1','::1','[::1]','*.internal.test'])assert.ok(config.proxyEnv.NO_PROXY.split(',').includes(host));
});
test('Windows per-protocol mapping preserves separate HTTP and HTTPS proxy routes',()=>{
  const config=resolveNetworkProxy({}, {ProxyEnable:1,ProxyServer:'HTTP = localhost:19081;https=http://localhost:19082;socks=localhost:19083'});
  assert.equal(config.proxyEnv.HTTP_PROXY,'http://localhost:19081/');assert.equal(config.proxyEnv.HTTPS_PROXY,'http://localhost:19082/');
});
test('explicit environment wins without importing other system proxy settings',()=>{
  const config=resolveNetworkProxy({http_proxy:'http://env.test:8080',HTTP_PROXY:'http://unused.test:1',no_proxy:'.example.test'}, {ProxyEnable:1,ProxyServer:'localhost:19080'});
  assert.equal(config.mode,'environment');assert.equal(config.proxyEnv.HTTP_PROXY,'http://env.test:8080/');assert.equal(config.proxyEnv.HTTPS_PROXY,undefined);assert.ok(config.proxyEnv.NO_PROXY.includes('.example.test'));
  assert.equal(resolveNetworkProxy({HTTPS_PROXY:''},{ProxyEnable:1,ProxyServer:'localhost:19080'}).proxyEnv.HTTPS_PROXY,undefined);
});
test('disabled setting and unsupported SOCKS proxy never invent a substitute route',()=>{
  assert.equal(resolveNetworkProxy({}, {ProxyEnable:0,ProxyServer:'localhost:19080'}).mode,'direct');
  assert.equal(resolveNetworkProxy({NODE_USE_ENV_PROXY:'0',HTTPS_PROXY:'http://example.test'}, {ProxyEnable:1,ProxyServer:'localhost:19080'}).mode,'disabled');
  const config=resolveNetworkProxy({ALL_PROXY:'socks5://localhost:19080'},null);assert.equal(config.unsupported,true);assert.equal(config.proxyEnv.HTTPS_PROXY,undefined);
});
test('bootstrap is read-only, respects explicit environment and emits no credential-bearing result',async()=>{
  const env={HTTPS_PROXY:'http://user:private-pass@example.test:8080'};let reads=0,installed;
  const result=await configureLocalNetwork({env,platform:'win32',readSettings:async()=>{reads++;return null;},installProxy:config=>{installed=config;}});
  assert.equal(reads,0);assert.equal(installed.HTTPS_PROXY,env.HTTPS_PROXY+'/');assert.equal(result.mode,'environment');assert.equal(result.proxied,true);
  assert.deepEqual(env,{HTTPS_PROXY:'http://user:private-pass@example.test:8080'});assert.equal(JSON.stringify(result).includes('private-pass'),false);
});
test('unreadable system settings and unsupported runtime leave safe status only',async()=>{
  const result=await configureLocalNetwork({env:{},platform:'win32',readSettings:async()=>null,installProxy:()=>{throw Error('http://secret-value');}});
  assert.deepEqual(result,{mode:'direct',applied:false,reason:'invalid-proxy-configuration'});
});
test('real fetch and http requests to loopback bypass an unreachable configured proxy',async()=>{
  const server=http.createServer((_req,res)=>res.end('loopback-ok'));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address(),restore=http.setGlobalProxyFromEnv(resolveNetworkProxy({HTTP_PROXY:'http://127.0.0.1:1'}).proxyEnv);
  try{
    const url=`http://127.0.0.1:${address.port}`;
    assert.equal(await (await fetch(url,{signal:AbortSignal.timeout(2000)})).text(),'loopback-ok');
    const text=await new Promise((resolve,reject)=>http.get(url,response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve(body));}).on('error',reject));
    assert.equal(text,'loopback-ok');
  }finally{restore();server.closeAllConnections();server.close();await once(server,'close');}
});

test('one OS read serves concurrent requests and an unreadable preference preserves the last route',async()=>{
  let clock=1000,reads=0,changes=0,restores=0,installs=0;
  let settings={ProxyEnable:1,ProxyServer:'127.0.0.1:7890'};
  const check=createNetworkRouteMonitor({platform:'win32',env:{},now:()=>clock,
    readSettings:async()=>{reads++;return settings;},
    installProxy:()=>{installs++;return ()=>{restores++;};},
    onRouteChange:()=>{changes++;}});
  const [first,concurrent]=await Promise.all([check(),check()]);
  assert.equal(first.revision,concurrent.revision);
  assert.equal(reads,1);
  clock+=3100;
  await check();
  assert.equal(reads,1);
  settings=null;
  assert.equal((await check(true)).status.proxied,true);
  assert.equal(reads,2);
  settings={ProxyEnable:0};
  clock+=3100;
  const [direct]=await Promise.all([check(true),check(true)]);
  assert.equal(direct.status.proxied,false);
  assert.equal(direct.revision,first.revision+1);
  assert.deepEqual({changes,installs,restores,reads},{changes:1,installs:2,restores:1,reads:3});
  clock+=31000;
  await check();
  assert.equal(installs,2);
});

test('fetch returns to direct access in the same process after the manual system proxy is disabled',async()=>{
  const target=http.createServer((_req,res)=>res.end('direct'));
  let proxyRequests=0;
  const proxy=http.createServer((_req,res)=>{proxyRequests++;res.writeHead(502).end();});
  proxy.on('connect',(_req,socket)=>{proxyRequests++;socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');});
  target.listen(0,'127.0.0.2');
  await once(target,'listening');
  proxy.listen(0,'127.0.0.1');
  await once(proxy,'listening');
  let enabled=1,clock=0;
  const check=createNetworkRouteMonitor({platform:'win32',env:{},now:()=>clock,
    readSettings:async()=>({ProxyEnable:enabled,ProxyServer:'127.0.0.1:'+proxy.address().port})});
  const targetUrl='http://127.0.0.2:'+target.address().port;
  try{
    await check();
    await fetch(targetUrl,{signal:AbortSignal.timeout(2500)}).catch(()=>null);
    assert.ok(proxyRequests>0);
    enabled=0;clock+=3100;
    assert.equal((await check(true)).status.mode,'direct');
    const response=await fetch(targetUrl,{signal:AbortSignal.timeout(2500)});
    assert.equal(await response.text(),'direct');
  }finally{
    enabled=0;clock+=31000;
    await check();
    target.closeAllConnections();proxy.closeAllConnections();
    target.close();proxy.close();
    await Promise.all([once(target,'close'),once(proxy,'close')]);
  }
});
