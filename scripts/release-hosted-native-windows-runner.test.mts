/** Real connected runner and upload files; controlled installation/session/provider peers only. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import os from "node:os";
import path from "node:path";

void test("Windows connected runner orders both original stages and recovers once on failed or late prerequisite and upload effects", (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "windows-connected-runner-"));
  const entry = new URL("./release-hosted-native-runner.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {readFileSync} from 'node:fs';import {mkdir,writeFile,readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {setTimeout as pause} from 'node:timers/promises';import path from 'node:path';
const entry=${JSON.stringify(entry)},root=process.argv[1],session={},installation={},parent={},pre={},post={},hash=b=>createHash('sha256').update(b).digest('hex');
let clock=1000,directory,scenario,order,recoveries,tasks,api;
const deadline=100000;
const stage=value=>{assert.ok(value===pre||value===post);assert.ok(clock<deadline,'original deadline exhausted');return {kind:value===pre?'payload-signing':'release-publication',directory:path.join(directory,value===pre?'pre':'post'),deadline}};
globalThis.f={performance:{now:()=>clock},
 prepare:async(raw,root,end,executing)=>{assert.equal(root,directory);assert.equal(end,deadline);assert.equal(executing,'fixed.bundle');order.push('installation');return {installation,parent,deadline}},
 start:async token=>{assert.equal(token,installation);order.push('session');return session},
 pre:async token=>{assert.equal(token,session);order.push('pre');return pre},
 post:async token=>{assert.equal(token,session);order.push('post');return post},
 stage:async token=>stage(token),
 finish:async token=>{assert.equal(token,session);order.push('finish');return {authority:'none'}},
 refuse:async token=>{assert.equal(token,session);recoveries++},
 parent:async token=>{assert.equal(token,parent);return {producer:{run_id:'123',controller_revision:'a'.repeat(40)},recheck(){assert.ok(clock<deadline)}}},
 prepareJob:async token=>{
  const actual=stage(token),label=token===pre?'pre':'post';order.push('prepare-'+label);
  const proof=path.join(actual.directory,'proof');await mkdir(proof,{mode:0o700});const files=[];
  for(const name of ['subject','report','capture','bundle']){const bytes=Buffer.from('{}'),file=path.join(proof,name+'.json');await writeFile(file,bytes,{mode:0o600});files.push({path:file,bytes:bytes.length,sha256:hash(bytes)})}
  const ready_file=path.join(proof,'native-upload-ready.json');await writeFile(ready_file,JSON.stringify({schema_version:1,authority:'none',retention_days:7,overwrite:false,compression_level:0,name:'hosted-native-'+actual.kind+'-windows-x86_64-123-1',files}),{mode:0o600});
  tasks.push((async()=>{let request;for(let i=0;i<2000;i++){try{request=await (token===pre?api.readHostedWindowsNativeUploadRequest:api.readHostedWindowsNativePostSignUploadRequest)(actual.directory);break}catch(error){if(error.code!=='ENOENT')throw error;await pause(1)}}assert.ok(request);
   if(scenario==='corrupt-ack'&&token===pre)await writeFile(path.join(actual.directory,'native-job-upload-ack.json'),'{}',{flag:'wx',mode:0o600});
   else await (token===pre?api.acknowledgeHostedWindowsNativeUpload:api.acknowledgeHostedWindowsNativePostSignUpload)(actual.directory,request.request_sha256,token===pre?1:2,'b'.repeat(64));
   if(scenario==='late-ack'&&token===pre)clock=deadline;
  })());
  return {receipt:token,ready_file,deadline};
 },
 readback:async(token,ack)=>{assert.equal(ack.artifact_id,token===pre?1:2);order.push('readback-'+(token===pre?'pre':'post'));if(scenario==='provider'&&token===post)throw Error('ambiguous upload');return {provider_bytes_match:true,authority:'none'}},
 Client:class {request(method,url){assert.equal(method,'GET');assert.match(url,/runs\/123\/attempts\/1\/jobs\?per_page=100$/);order.push('GET');if(scenario==='late-prerequisite')clock=deadline;return {status:200,headers:new Headers(scenario==='partial-prerequisite'?{link:'next'}:{}),body:{total_count:2,jobs:['Sign admitted updater payloads','Sign authenticated Timestamp metadata'].map((name,i)=>({id:i+1,run_id:123,head_sha:'a'.repeat(40),name,status:'completed',conclusion:scenario==='failed-prerequisite'?'failure':'success'}))}}}},
};
const routes={
 'node:perf_hooks':{performance:'performance'},
 './release-hosted-native-windows-session.mts':{startActualHostedWindowsSession:'start',prepareActualHostedWindowsPreSignStage:'pre',prepareActualHostedWindowsPostSignStage:'post',finishActualHostedWindowsSession:'finish',refuseActualHostedWindowsSession:'refuse',requireActualHostedWindowsStage:'stage'},
 './release-hosted-native-parent.mts':{requireActualHostedNativeParentSource:'parent'},
 './release-hosted-native-job.mts':{prepareActualHostedWindowsStageJob:'prepareJob',readBackActualHostedWindowsPreSignUpload:'readback',readBackActualHostedWindowsPostSignUpload:'readback'},
 './github-api.mts':{GitHubApiClient:'Client',createGitHubRunner:'unused'},
};
registerHooks({resolve(s,c,next){if(c.parentURL===entry&&routes[s])return {url:'connected:'+s,shortCircuit:true};return next(s,c)},load(u,c,next){if(u===entry){let source=readFileSync(new URL(u),'utf8');const boundary=source.indexOf('/** Preparation completes in one original bundle realm and under its job clock. */');assert.ok(boundary>0);source=source.slice(0,boundary)+'export const prepareConfiguredHostedWindowsInstallation=(...args)=>globalThis.f.prepare(...args);';source=source.replace('export const hostedWindowsNativeJobExecutionAuthorized = false;','export const hostedWindowsNativeJobExecutionAuthorized = true;');return {format:'module-typescript',source,shortCircuit:true}}if(u.startsWith('connected:'))return {format:'module',source:Object.entries(routes[u.slice('connected:'.length)]).map(([name,key])=>'export const '+name+'=globalThis.f.'+key+';').join('\n'),shortCircuit:true};return next(u,c)}});
api=await import(entry);
for(const name of ['success','failed-prerequisite','late-prerequisite','partial-prerequisite','corrupt-ack','late-ack','provider']){
 scenario=name;clock=1000;order=[];recoveries=0;tasks=[];directory=path.join(root,name);await mkdir(directory,{mode:0o700});for(const leaf of ['pre','post'])await mkdir(path.join(directory,leaf),{mode:0o700});
 const running=api.runConfiguredHostedWindowsNativeJob({},directory,deadline,'fixed.bundle');
 if(name==='success'){assert.equal((await running).authority,'none');assert.equal(recoveries,0);assert.deepEqual(order,['installation','session','pre','prepare-pre','readback-pre','GET','post','prepare-post','readback-post','finish'])}
 else {await assert.rejects(running);assert.equal(recoveries,1);assert.equal(order.includes('finish'),false);if(name!=='provider')assert.equal(order.includes('post'),false)}
 await Promise.all(tasks);
}
console.log('controlled connected Windows runner passed; native and provider peers inert');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /controlled connected Windows runner passed/u);
});
