/** Controlled orchestration only; no hosted, signing or native acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";

void test("fixed hosted pre-sign pipeline preserves original upload custody and refuses failed/ambiguous handoffs", (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "hosted-native-job-"));
  const entry = new URL("./release-hosted-native-job.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
const root=process.argv[1];
process.env.GH_TOKEN='inert-reader';
const order=[], tokens=Array.from({length:6},()=>({}));
const files=Object.fromEntries(['subject','report','capture','bundle'].map(key=>[key,Buffer.from(key)]));
const producer={controller_revision:'a'.repeat(40),run_id:'99',run_attempt:1,job_id:88,check_run_id:'77'};
let fault='',directory,readbacks=0,stale=false,submittedAck;
const step=(name,index)=>async value=>{order.push(name);assert.equal(value,tokens[index-1]);if(fault===name)throw Error('original '+name+' refusal');return tokens[index]};
globalThis.fixture={
 parent:async(dir,platform,stage,deadline)=>{order.push('parent');assert.equal(dir,directory);assert.equal(platform,'linux-x86_64');assert.equal(stage,'payload-signing');assert.ok(deadline>performance.now());if(fault==='parent')throw Error('original parent refusal');return tokens[0]},
 candidate:step('candidate',1),request:step('request',2),capture:step('capture',3),report:step('report',4),sign:step('sign',5),
 original:async value=>{assert.equal(value,tokens[5]);if(stale)throw Error('custody expired');if(fault==='mutate-ack'&&submittedAck){await Promise.resolve();submittedAck.artifact_id=2;submittedAck.sha256='c'.repeat(64)}return {directory,producer,files:Object.fromEntries(Object.entries(files).map(([key,bytes])=>[key,Buffer.from(bytes)])),artifact_name:'hosted-native-payload-signing-linux-x86_64-99-1',deadline:fault==='expired'?performance.now()-1:performance.now()+100000}},
};
globalThis.fixture.readback=(api,slot,dir,deadline)=>{
 readbacks++;assert.deepEqual(slot,{controller_revision:producer.controller_revision,run_id:'99',run_attempt:1,platform_label:'linux-x86_64',stage:'payload-signing'});assert.equal(dir,directory);assert.ok(deadline>performance.now());
 if(fault==='ambiguous')throw Error('provider unavailable');if(fault==='stale')stale=true;
 return {artifact:{id:fault==='mutate-ack'?2:1,sha256:fault==='mutate-ack'?'c'.repeat(64):'b'.repeat(64),bytes:100,name:'hosted-native-payload-signing-linux-x86_64-99-1'},locator:{run_id:'99',run_attempt:1,platform_label:'linux-x86_64',job_id:fault==='job'?9:88,check_run_id:fault==='check'?'9':'77'},files:{...files,...(fault==='bytes'?{bundle:Buffer.from('changed')}: {})}};
};
const routes={
 './release-hosted-native-parent.mts':{createActualHostedNativeParentSource:'parent'},
 './release-hosted-native-candidate.mts':{acquireActualHostedNativeCandidate:'candidate'},
 './release-hosted-native-linux-request.mts':{prepareActualHostedNativeLinuxRequest:'request'},
 './release-hosted-native-linux-capture.mts':{captureActualHostedNativeLinuxInvocation:'capture'},
 './release-native-linux-report.mts':{prepareActualHostedLinuxNativeStageReport:'report'},
 './release-hosted-native-proof-producer.mts':{signActualHostedLinuxNativeProof:'sign',requireActualHostedLinuxNativeProof:'original'},
 './release-hosted-native-artifact.mts':{readHostedNativeProofArtifact:'readback'},
};
registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(entry)}&&routes[specifier])return {url:'inert-job:'+specifier,shortCircuit:true};return next(specifier,context)},load(url,context,next){if(url.startsWith('inert-job:'))return {format:'module',source:Object.entries(routes[url.slice('inert-job:'.length)]).map(([name,key])=>'export const '+name+'=globalThis.fixture.'+key+';').join('\n'),shortCircuit:true};return next(url,context)}});
const api=await import(${JSON.stringify(entry)});
const reset=name=>{fault=name;readbacks=0;stale=false;submittedAck=undefined;order.length=0;directory=path.join(root,name||'valid');mkdirSync(directory);for(const [key,bytes]of Object.entries(files))writeFileSync(path.join(directory,key+'.json'),bytes)};
const prepare=()=>api.prepareActualHostedLinuxPreSignJob(directory,performance.now()+100000);
const ack={artifact_id:1,sha256:'b'.repeat(64)};
reset('');
const upload=await prepare();
assert.deepEqual(order,['parent','candidate','request','capture','report','sign']);
const ready=JSON.parse(readFileSync(upload.ready_file));
assert.equal(ready.retention_days,7);assert.equal(ready.overwrite,false);assert.equal(ready.compression_level,0);
assert.deepEqual(ready.files.map(file=>path.basename(file.path)),['subject.json','report.json','capture.json','bundle.json']);
await assert.rejects(api.readBackActualHostedLinuxPreSignUpload({...upload.receipt},ack),/original/);
assert.equal(readbacks,0);
const result=await api.readBackActualHostedLinuxPreSignUpload(upload.receipt,ack);
assert.equal(result.provider_bytes_match,true);assert.equal(result.native_acceptance,'not-established');assert.equal(result.authority,'none');
assert.equal(readbacks,1);assert.ok(existsSync(path.join(directory,'native-upload-readback.json')));
await assert.rejects(api.readBackActualHostedLinuxPreSignUpload(upload.receipt,ack),/recovery/);assert.equal(readbacks,1);
for(const name of ['parent','candidate','request','capture','report','sign']){
 reset(name);await assert.rejects(prepare(),new RegExp('original '+name+' refusal'));assert.equal(order.at(-1),name);assert.equal(readbacks,0);assert.ok(!existsSync(path.join(directory,'native-upload-ready.json')));
}
for(const name of ['ack-id','ack-hash','ack-schema','mutate-ack','ready','expired','ambiguous','stale','job','check','bytes']){
 reset(name);const upload=await prepare();let submitted={...ack};
 if(name==='ack-id')submitted={...ack,artifact_id:2};
 if(name==='ack-hash')submitted={...ack,sha256:'c'.repeat(64)};
 if(name==='ack-schema')submitted={...ack,extra:true};
 if(name==='ready')writeFileSync(upload.ready_file,'{}');
 submittedAck=submitted;
 await assert.rejects(api.readBackActualHostedLinuxPreSignUpload(upload.receipt,submitted),/retain/);
 const before=readbacks;stale=false;fault='';
 await assert.rejects(api.readBackActualHostedLinuxPreSignUpload(upload.receipt,ack),/recovery/);assert.equal(readbacks,before);
 const refusal=JSON.parse(readFileSync(path.join(directory,'native-upload-refusal.json')));assert.equal(refusal.automatic_retry,false);assert.equal(refusal.recovery_required,true);assert.equal(refusal.upload_effect,'unknown');
 assert.equal(existsSync(path.join(directory,'native-upload-readback.json')),false);
}
console.log('controlled original pipeline and upload refusals passed');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /controlled original pipeline and upload refusals passed/u);
});
