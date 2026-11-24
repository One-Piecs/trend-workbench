import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';

const shell=promisify(execFile);
const here=path.dirname(fileURLToPath(import.meta.url));
const temp=path.resolve(tmpdir());
const winPowerShell=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
async function availablePort(){
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  if(port===43127)return availablePort();
  return port;
}
const alive=child=>child&&child.exitCode===null&&child.signalCode===null;
async function stopChild(child){
  if(!alive(child))return;
  const stopped=new Promise(resolve=>child.once('exit',resolve));
  child.kill();
  await stopped;
}
async function until(check){
  const stop=Date.now()+15000;
  do{
    const result=await check();
    if(result)return result;
    await pause(100);
  }while(Date.now()<stop);
  throw new Error('Timed out waiting for desktop server state');
}

test('Windows replaces only its own listening backend and an open window reconnects on the same origin', {skip:process.platform!=='win32',timeout:100000}, async()=>{
  const stage=await mkdtemp(path.join(temp,'trend-launch-test-'));
  const runtimeDir=path.join(stage,'runtime'), runtime=path.join(runtimeDir,'node.exe');
  const script=path.join(stage,'server.mjs'), launcher=path.join(stage,'launcher.ps1');
  const port=await availablePort(), origin='http://127.0.0.1:'+port;
  const launch=()=>shell(winPowerShell,['-NoProfile','-NonInteractive','-File',launcher,'-NoWindow'],{windowsHide:true,timeout:25000});
  const health=()=>fetch(origin+'/health').then(r=>r.json()).catch(()=>null);
  let old,windowClient,other;
  try{
    await shell(process.execPath,['--experimental-strip-types',path.join(here,'../build.mjs'),'--shared-assets',stage],{windowsHide:true});
    await mkdir(runtimeDir);
    await copyFile(process.execPath,runtime);
    await copyFile(path.join(here,'launcher.ps1'),launcher);
    const built=await readFile(script,'utf8'),buildId=built.match(/const buildId='([0-9a-f]{64})';/)[1];
    await writeFile(path.join(stage,'build-info.json'),JSON.stringify({port,buildId}));
    // Pre-upgrade releases used identical version strings but had no build ID.
    await writeFile(script,built.replace('buildId,pid:process.pid','pid:process.pid'));
    old=spawn(runtime,[script,'--port',String(port)],{windowsHide:true,stdio:'ignore'});
    await until(async()=>(await health())?.pid===old.pid);
    // Model the already-open window with the same EventSource as main.tsx.
    // Its PID and URL stay fixed while the launcher replaces the service.
    windowClient=spawn(runtime,['--experimental-eventsource','-e',
      "const lease=new EventSource(process.argv[1]);lease.addEventListener('connected',()=>console.log('connected'));setInterval(()=>{},1000);",
      origin+'/session'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    let events='';
    windowClient.stdout.on('data',data=>{events+=String(data);});
    await until(async()=>events.includes('connected')&&(await health())?.activeWindows===1);
    const clientPid=windowClient.pid;
    await writeFile(script,built);
    await launch();
    const fresh=await health();
    assert.equal(fresh.buildId,buildId);
    assert.notEqual(fresh.pid,old.pid);
    await until(()=>!alive(old));
    await until(async()=>events.trim().split(/\s+/).length>=2&&(await health())?.activeWindows===1);
    assert.ok(alive(windowClient));
    assert.equal(windowClient.pid,clientPid);
    for(const route of ['/api/history','/api/live-quote']){
      const response=await fetch(origin+route);
      assert.equal(response.status,400,route);
    }
    await launch();
    assert.equal((await health()).pid,fresh.pid);
    await stopChild(windowClient);
    await until(async()=>!(await health()));

    // A second local service can return the same product/build identity. It uses
    // the very same runtime and the same port but runs a different entry point.
    const otherEntry=path.join(stage,'other-server.mjs');
    await copyFile(script,otherEntry);
    other=spawn(runtime,[otherEntry,'--port',String(port)],{windowsHide:true,stdio:'ignore'});
    await until(async()=>(await health())?.pid===other.pid);
    await assert.rejects(launch(),error=>error.code===1);
    assert.equal((await health()).pid,other.pid);
    assert.ok(alive(other));
  }finally{
    await stopChild(windowClient);
    await stopChild(other);
    const current=await health();
    if(current?.app==='trend-workbench'){
      const cleanup=await fetch(origin+'/session');
      await cleanup.body.cancel();
      await until(async()=>!(await health()));
    }
    await stopChild(old);
    assert.equal(path.dirname(path.resolve(stage)),temp);
    assert.ok(path.basename(stage).startsWith('trend-launch-test-'));
    await rm(stage,{recursive:true,force:true,maxRetries:3,retryDelay:300});
  }
});

test('a matching executable identity must independently own the loopback listener', {skip:process.platform!=='win32',timeout:25000}, async()=>{
  const listener=net.createServer(socket=>socket.end());
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  try{
    const port=listener.address().port;
    assert.notEqual(port,43127);
    // Load only the side-effect-free identity predicate. Let both test PIDs pass
    // the executable/command check so the OS listener check decides the result.
    // This check never invokes replacement, process termination or the main launcher.
    const check=`
      $ErrorActionPreference = 'Stop'
      $tokens=$null
      $errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile($env:TREND_TEST_LAUNCHER,[ref]$tokens,[ref]$errors)
      if ($errors.Count) { throw 'Invalid launcher syntax' }
      $predicate=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-WorkbenchIdentity'},$false)
      Invoke-Expression $predicate.Extent.Text
      function Get-VerifiedServerProcess([int]$serverPid) {Get-Process -Id $serverPid}
      $serverPort=[int]$env:TREND_TEST_PORT
      $health=[pscustomobject]@{app='trend-workbench'; version='1.3-local'; pid=$PID}
      if (Test-WorkbenchIdentity $health) {throw 'Accepted a process without the listener'}
      $health.pid=[int]$env:TREND_TEST_OWNER
      if (!(Test-WorkbenchIdentity $health)) {throw 'Rejected the loopback listener owner'}
    `;
    await shell(winPowerShell,['-NoProfile','-NonInteractive','-Command',check],{windowsHide:true,timeout:20000,env:{
      ...process.env,TREND_TEST_LAUNCHER:path.join(here,'launcher.ps1'),TREND_TEST_PORT:String(port),TREND_TEST_OWNER:String(process.pid)}});
  }finally{await new Promise(resolve=>listener.close(resolve));}
});
