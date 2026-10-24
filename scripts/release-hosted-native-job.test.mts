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

void test("hosted post-sign source binds the original timestamp executor and permanently refuses drift or unresolved effects", (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "hosted-native-postsign-"));
  const entry = new URL("./release-hosted-native-candidate.mts", import.meta.url).href;
  const capacity = new URL("./release-capacity.mts", import.meta.url).href;
  const deadlineModule = new URL("./release-coordinator-deadline.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import * as files from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {capacityDigest as digest} from ${JSON.stringify(capacity)};
import {coordinatorCommandTimeout} from ${JSON.stringify(deadlineModule)};
const root=process.argv[1]; process.env.GH_TOKEN='inert-reader';
const originals=new Set(); let parentReceipt, directory, fault='', stale=false, calls=0, hydrated=0, clock=1000, originalDeadline=101000; Object.defineProperty(performance,'now',{value:()=>clock});
const producer={controller_revision:'a'.repeat(40),controller_ref:'refs/tags/portcove-production-controller-fixture',actor_id:'123',run_id:'12345',run_attempt:1};
const candidate={phase:'publishing',source_commit:'b'.repeat(40),prepared_commit:'c'.repeat(40),version:'0.1.0-beta.1',transient_retries:0,substantive_repairs:0,release_run:{run_id:999,attempt:1,revision:'c'.repeat(40)}};
const {phase,release_run,...subject}=candidate;
function operation(){
 const executor={actor_id:'123',check_run_id:'456',controller_revision:producer.controller_revision,execution_ref:producer.controller_ref,job_id:789,role:'tuf-timestamp',run_attempt:1,run_id:'12345',workflow:'.github/workflows/application-update-production.yml'};
 if(fault==='foreign-run')executor.run_id='54321';
 if(fault==='foreign-ref')executor.execution_ref='refs/tags/portcove-production-controller-other';
 if(fault==='foreign-actor')executor.actor_id='321';
 if(fault==='foreign-revision')executor.controller_revision='d'.repeat(40);
 const identity={before_checkpoint:'d'.repeat(40),candidate:subject,destination:'github-actions:boburning/portcove:0.1.0-beta.1:tuf-timestamp-envelope',executor_nonce:'e'.repeat(64),executor_identity:executor,receipt_limit:1,kind:'upload',sequence:1,policy_sha256:'f'.repeat(64),ratification_sha256:'1'.repeat(64)};
 return {...identity,id:digest(identity),outcome:fault==='pending'?'pending':fault==='ambiguous'?'ambiguous':fault==='refused'?'refused':fault==='recovered'?'recovered':'succeeded',completed_effects:fault==='pending'?[]:[{remote_identity:'artifact:fixture',evidence_sha256:'2'.repeat(64)}],recovery:fault==='recovered'?{checkpoint:'8'.repeat(40),resolution:'effect-completed',evidence_sha256:'9'.repeat(64)}:null,failure_evidence:null};
}
const check=()=>{if(stale)throw Error('original parent expired')};
globalThis.postsignFixture={
 parent:async receipt=>{assert.ok(originals.has(receipt),'original active hosted native parent source required');check();return {directory,stage:fault==='wrong-stage'?'payload-signing':'release-publication',deadline:originalDeadline,configuration:{journal:{namespace:'fixture'}},producer:{...producer},recheck:check}},
 recover:async()=>{calls++;check();const op=operation();const groups=[];if(['history','history-budget','history-expiry','duplicate','pending-history','hydrate-drift'].includes(fault))groups.push({summary_schema_version:1,subject:{kind:'candidate',identity:candidate.prepared_commit},kind:'upload',destination_sha256:digest(op.destination),transient_retries:0,substantive_repairs:0,completed:true,attempts:[{checkpoint:'3'.repeat(40),id:op.id,operation_sha256:digest(op)}]});return {checkpoint:(fault==='journal-drift'&&calls>1)?'8'.repeat(40):'7'.repeat(40),repository:directory,input:{active_candidate:structuredClone(candidate),controller:{capacity_attempt:{schema_version:2,operation:['history','history-budget','history-expiry','hydrate-drift','missing'].includes(fault)?null:fault==='pending-history'?{...op,outcome:'pending',completed_effects:[]}:op,prior_operations:groups}}}}},
 hydrate:async()=>{hydrated++; if(fault==='history-budget'||fault==='history-expiry'){assert.equal(coordinatorCommandTimeout(),100,'local Git must inherit the original100ms deadline');if(fault==='history-expiry'){clock+=101;assert.throws(()=>coordinatorCommandTimeout(),/exhausted/)}} if(fault==='hydrate-drift')stale=true; return operation()},
 write:async(...args)=>{await files.writeFile(...args);if(fault==='late-write'&&path.basename(args[0])==='original-controller-selection.json')stale=true}
};
const routes={'./release-hosted-native-parent.mts':"export const requireActualHostedNativeParentSource=globalThis.postsignFixture.parent;",'./release-coordinator-recovery.mts':"export const recoverRemoteCoordinator=globalThis.postsignFixture.recover; export const hydrateRetainedCoordinatorOperation=globalThis.postsignFixture.hydrate;",'node:fs/promises':"export {chmod,mkdtemp} from 'node:fs/promises'; export const writeFile=globalThis.postsignFixture.write;"};
registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(entry)}&&routes[specifier])return {url:'postsign-fixture:'+specifier,shortCircuit:true};return next(specifier,context)},load(url,context,next){if(url.startsWith('postsign-fixture:'))return {format:'module',source:routes[url.slice('postsign-fixture:'.length)],shortCircuit:true};return next(url,context)}});
const api=await import(${JSON.stringify(entry)});
const reset=name=>{fault=name;stale=false;calls=0;hydrated=0;clock=1000;originalDeadline=name.startsWith('history-')?1100:101000;directory=path.join(root,name||'current');mkdirSync(directory);parentReceipt={};originals.add(parentReceipt)};
for(const name of ['','history','history-budget','recovered']){
 reset(name); const receipt=await api.readActualHostedNativePostSignController(parentReceipt);
 const value=await api.requireActualHostedNativePostSignController(receipt);
 assert.equal(value.controller.run_id,producer.run_id);assert.notEqual(value.controller.run_id,String(candidate.release_run.run_id));assert.equal(value.parent_source,parentReceipt);assert.equal(value.authority,'none');assert.equal(value.native_acceptance,'not-established');
 assert.equal(hydrated,name.startsWith('history')?1:0); assert.equal(value.checkpoint,'7'.repeat(40));
 await assert.rejects(api.requireActualHostedNativePostSignController({...receipt}),/original/);
 await assert.rejects(api.readActualHostedNativePostSignController(parentReceipt),/recovery/);
 const retained=path.join(value.directory,'original-controller-selection.json');const bytes=readFileSync(retained);assert.equal(bytes.includes(Buffer.from('inert-reader')),false);writeFileSync(retained,'{}');
 await assert.rejects(api.requireActualHostedNativePostSignController(receipt),/changed/);writeFileSync(retained,bytes);
 await assert.rejects(api.requireActualHostedNativePostSignController(receipt),/original active/);
}
for(const name of ['foreign-run','foreign-ref','foreign-actor','foreign-revision','pending','ambiguous','refused','missing','duplicate','pending-history','journal-drift','hydrate-drift','history-expiry','late-write']){
 reset(name);await assert.rejects(api.readActualHostedNativePostSignController(parentReceipt),/retain/);
 const retained=readdirSync(directory).filter(name=>name.startsWith('post-sign-source-'));assert.equal(retained.length,1);
 const refusal=JSON.parse(readFileSync(path.join(directory,retained[0],'refusal.json')));assert.equal(refusal.automatic_retry,false);assert.equal(refusal.recovery_required,true);assert.equal(refusal.native_acceptance,'not-established');
 stale=false;fault=''; await assert.rejects(api.readActualHostedNativePostSignController(parentReceipt),/recovery/);
}
reset('wrong-stage');await assert.rejects(api.readActualHostedNativePostSignController(parentReceipt),/post-sign/);
await assert.rejects(api.readActualHostedNativePostSignController({}),/original active/);
console.log('controlled hosted timestamp binding and refusal cases passed');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /controlled hosted timestamp binding and refusal cases passed/u);
});
