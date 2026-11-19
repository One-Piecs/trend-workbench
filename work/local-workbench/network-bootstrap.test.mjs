import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {configureLocalNetwork,parseMacProxySettings,resolveNetworkProxy} from './network-bootstrap.mjs';

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
