/** Real bounded file rendezvous, controlled producer; no native acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";

void test("original process survives upload rendezvous, binds ACK and refuses replay or ambiguity", (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "native-runner-"));
  const entry = new URL("./release-hosted-native-runner.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.argv[1], receipt={}, hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let prepared=0,readbacks=0,fault='';
const realTools=await import(${JSON.stringify(new URL("./release-controller-tools.mts", import.meta.url).href)});
const realMarker=await import(${JSON.stringify(new URL("./release-routing-marker.mts", import.meta.url).href)});
globalThis.fixture={prepare:async directory=>{
 prepared++;const proof=path.join(directory,'proof');await mkdir(proof,{mode:0o700});
 const files=[];for(const name of ['subject','report','capture','bundle']){const bytes=Buffer.from(name),file=path.join(proof,name+'.json');await writeFile(file,bytes,{flag:'wx',mode:0o600});files.push({path:file,bytes:bytes.length,sha256:hash(bytes)})}
 const ready_file=path.join(proof,'native-upload-ready.json');await writeFile(ready_file,JSON.stringify({schema_version:1,name:'hosted-native-payload-signing-linux-x86_64-99-1',files,retention_days:7,overwrite:false,compression_level:0,authority:'none'}),{flag:'wx',mode:0o600});return {receipt,ready_file,deadline:performance.now()+(['delayed-read','late-settlement','late-ack'].includes(fault)?1500:20000)};
},readback:async(original,ack)=>{assert.equal(original,receipt);readbacks++;assert.deepEqual(ack,{artifact_id:123,sha256:'a'.repeat(64)});if(fault==='provider')throw Error('ambiguous');return {provider_bytes_match:true,native_acceptance:'not-established',authority:'none'}}};
globalThis.fixture.read=async(file,bound)=>{if(fault==='delayed-read'&&path.basename(file)==='native-upload-ready.json')await delay(1800);return realTools.readControllerToolFile(file,bound)};
globalThis.fixture.marker=async(file,value)=>{await realMarker.retainReleaseRoutingMarker(file,value);if((fault==='late-settlement'&&path.basename(file)==='native-job-settlement.json')||(fault==='late-ack'&&path.basename(file)==='native-job-upload-ack.json'))await delay(1800)};
registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(entry)}){const routes={'./release-hosted-native-job.mts':'job','./release-controller-tools.mts':'tools','./release-routing-marker.mts':'marker'};if(routes[specifier])return {url:'inert:'+routes[specifier],shortCircuit:true}}return next(specifier,context)},load(url,context,next){const sources={'inert:job':'export const prepareActualHostedLinuxPreSignJob=globalThis.fixture.prepare;export const readBackActualHostedLinuxPreSignUpload=globalThis.fixture.readback;','inert:tools':'export const readControllerToolFile=globalThis.fixture.read;','inert:marker':'export const retainReleaseRoutingMarker=globalThis.fixture.marker;'};if(sources[url])return {format:'module',source:sources[url],shortCircuit:true};return next(url,context)}});
const api=await import(${JSON.stringify(entry)});
for(const name of ['valid','wrong-request','corrupt-ack','provider','timeout']){
 fault=name;const directory=path.join(root,name);await mkdir(directory,{mode:0o700});
 const running=api.runActualHostedLinuxNativeJob(directory,performance.now()+(name==='timeout'?1500:20000));
 // Attach rejection immediately while waiting for the other process's routing view.
 const outcome=running.then(value=>({value}),error=>({error}));
 let request;for(let i=0;i<100;i++){try{request=await api.readHostedNativeUploadRequest(directory);break}catch(error){if(error.code!=='ENOENT')throw error;await delay(5)}}
 assert.ok(request);assert.equal(request.files.length,4);assert.equal(request.authority,'none');
 if(name==='wrong-request'){
   await assert.rejects(api.acknowledgeHostedNativeUpload(directory,'b'.repeat(64),123,'a'.repeat(64)));
   await api.acknowledgeHostedNativeUpload(directory,request.request_sha256,123,'a'.repeat(64));
 }else if(name==='corrupt-ack'){
   await writeFile(path.join(directory,'native-job-upload-ack.json'),'{}',{flag:'wx'});
 }else if(name==='valid'){
   const childCode='import {acknowledgeHostedNativeUpload} from '+${JSON.stringify(JSON.stringify(entry))}+'; await acknowledgeHostedNativeUpload(process.argv[1],process.argv[2],123,"a".repeat(64)); console.log(process.pid);';
   const child=spawnSync(process.execPath,['--input-type=module','--eval',childCode,directory,request.request_sha256],{encoding:'utf8',timeout:15000,maxBuffer:16384});
   assert.equal(child.status,0,child.stderr);assert.ok(Number(child.stdout.trim())>0);assert.notEqual(Number(child.stdout.trim()),process.pid);
 }else if(name!=='timeout')await api.acknowledgeHostedNativeUpload(directory,request.request_sha256,123,'a'.repeat(64));
 const result=await outcome;
 if(['valid','wrong-request'].includes(name)){assert.ok(result.value);await assert.rejects(api.acknowledgeHostedNativeUpload(directory,request.request_sha256,123,'a'.repeat(64)),{code:'EEXIST'})}else assert.match(result.error.message,/retain/);
 const settlement=JSON.parse(await readFile(path.join(directory,'native-job-settlement.json'),'utf8'));
 assert.equal(settlement.exit_code,['valid','wrong-request'].includes(name)?0:1);
 if(settlement.exit_code){assert.equal(settlement.recovery_required,true);assert.equal(settlement.automatic_retry,false);assert.equal(settlement.upload_effect,'unknown')}
 const before=prepared;await assert.rejects(api.runActualHostedLinuxNativeJob(directory,performance.now()+5000),{code:'EEXIST'});assert.equal(prepared,before);
}
assert.equal(readbacks,3);
for(const name of ['delayed-read','late-settlement','late-ack']){
 fault=name;const directory=path.join(root,name);await mkdir(directory,{mode:0o700});
 const outcome=api.runActualHostedLinuxNativeJob(directory,performance.now()+20000).then(value=>({value}),error=>({error}));
 if(name==='delayed-read'){
   const result=await outcome;assert.match(result.error.message,/retain/);
   await assert.rejects(readFile(path.join(directory,'native-job-upload-request.json')),{code:'ENOENT'});
 }else{
   let request;for(let i=0;i<100;i++){try{request=await api.readHostedNativeUploadRequest(directory);break}catch(error){if(error.code!=='ENOENT')throw error;await delay(5)}}
   assert.ok(request);
   if(name==='late-ack')await assert.rejects(api.acknowledgeHostedNativeUpload(directory,request.request_sha256,123,'a'.repeat(64)),/exhausted/);
   else await api.acknowledgeHostedNativeUpload(directory,request.request_sha256,123,'a'.repeat(64));
   const result=await outcome;
   if(name==='late-settlement'){
     assert.match(result.error.message,/retain/);
     const refusal=JSON.parse(await readFile(path.join(directory,'native-job-refusal.json'),'utf8'));assert.equal(refusal.recovery_required,true);
     const partial=JSON.parse(await readFile(path.join(directory,'native-job-settlement.json'),'utf8'));assert.equal(partial.exit_code,0);assert.equal(partial.authority,'none');
   }else assert.ok(result.value); // Parent completed before expiry; the delayed ACK caller still refuses.
   assert.ok((await readFile(path.join(directory,'native-job-upload-ack.json'))).length>0);
 }
 const before=prepared;await assert.rejects(api.runActualHostedLinuxNativeJob(directory,performance.now()+5000),{code:'EEXIST'});assert.equal(prepared,before);
}
console.log('original receipt and bounded upload rendezvous passed');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /original receipt and bounded upload rendezvous passed/u);
});
