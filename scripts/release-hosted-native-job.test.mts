/** Controlled orchestration only; no hosted, signing or native acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";

for (const stage of ["payload-signing", "release-publication"] as const)
  void test(`original ${stage} request refuses a concurrent stopped reader after restoration`, (t) => {
    const root = disposableDirectory(t, path.join(os.tmpdir(), "hosted-request-race-"));
    const entry = new URL("./release-hosted-native-linux-request.mts", import.meta.url).href;
    const code = String.raw`
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import * as files from 'node:fs/promises';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const directory=process.argv[1], stage=${JSON.stringify(stage)}, token={}, parentToken={};
Object.defineProperties(process,{platform:{value:'linux'},arch:{value:'x64'},getuid:{value:()=>1000},getgid:{value:()=>1000}});
let wait=false,entered,release;
const gateEntered=new Promise(resolve=>entered=resolve), gate=new Promise(resolve=>release=resolve);
globalThis.requestRace={files,
 async candidate(receipt){assert.equal(receipt,token);if(wait){wait=false;entered();await gate;}return {directory,package_path:path.join(directory,'inert.bin'),platform_label:'linux-x86_64',stage,parent_source:parentToken,candidate:{},recovery:{}}},
 async parent(receipt){assert.equal(receipt,parentToken);return {platform_label:'linux-x86_64',stage,producer:{configuration_sha256:'a'.repeat(64)},configuration:{purpose:'application',journal:{setup_plan_sha256:'b'.repeat(64)},hosted_native:{'linux-x86_64':{compatibility:{minimum_os_version:'24.04'}}}},recheck(){}}},
 async read(filename,maximum){const bytes=filename==='/etc/passwd'?Buffer.from('portcove-native:x:2000:2000::/home/portcove-native:/usr/sbin/nologin\n'):filename==='/etc/machine-id'?Buffer.from('a'.repeat(32)):filename==='/etc/os-release'?Buffer.from('ID=ubuntu\nVERSION_ID="24.04"\n'):await files.readFile(filename);assert.ok(bytes.length<=maximum);return bytes},
};
const modules={
'release-hosted-native-candidate.mts':'export const requireActualHostedNativeCandidate=globalThis.requestRace.candidate;',
'release-hosted-native-postsign-inputs.mts':'export const requireActualHostedNativePostSignPayload=globalThis.requestRace.candidate;',
'release-hosted-native-parent.mts':'export const requireActualHostedNativeParentSource=globalThis.requestRace.parent;',
'release-controller-tools.mts':'export const readControllerToolFile=globalThis.requestRace.read;',
'release-native-wsl-host.mts':'export const inspectHostedNativeLinuxHost=()=>{};',
'release-native-stage-capture.mts':'export const prepareHostedNativeStageRequest=input=>({request:input,request_sha256:"c".repeat(64)});',
'release-native-candidate.mts':'export const nativeInvocationIdentity=()=>({invocation_id:"d".repeat(64),counters:{}});',
};
registerHooks({resolve(specifier,context,next){if(specifier==='node:fs/promises'&&context.parentURL?.endsWith('release-hosted-native-linux-request.mts'))return {url:'request-fs:fixed',shortCircuit:true};return next(specifier,context)},load(url,context,next){if(url==='request-fs:fixed')return {format:'module',source:'export const writeFile=globalThis.requestRace.files.writeFile;export const realpath=async p=>p;export const lstat=async p=>({isDirectory:()=>["/","/etc"].includes(p),isFile:()=>true,isSymbolicLink:()=>false,uid:0,mode:0o100644,nlink:1});',shortCircuit:true};const key=Object.keys(modules).find(key=>url.endsWith('/'+key));return key?{format:'module',source:modules[key],shortCircuit:true}:next(url,context)}});
const api=await import(${JSON.stringify(entry)});
const receipt=await (stage==='payload-signing'?api.prepareActualHostedNativeLinuxRequest(token):api.prepareActualHostedNativeLinuxPostSignRequest(token));
await api.requireActualHostedNativeLinuxRequest(receipt);
wait=true;const pending=api.requireActualHostedNativeLinuxRequest(receipt);await gateEntered;
const original=readFileSync(receipt.filename);writeFileSync(receipt.filename,'{}');
await assert.rejects(api.requireActualHostedNativeLinuxRequest(receipt),/request changed/);
writeFileSync(receipt.filename,original);release();
await assert.rejects(pending,/original active hosted Linux request/);
await assert.rejects(api.requireActualHostedNativeLinuxRequest(receipt),/original active hosted Linux request/);
console.log('original request stopped latch preserved');
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /original request stopped latch preserved/u);
  });

for (const jobStage of ["payload-signing", "release-publication"] as const)
  void test(`fixed hosted ${jobStage} pipeline preserves original upload custody and refuses failed/ambiguous handoffs`, (t) => {
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
const stageUnderTest=${JSON.stringify(jobStage)};const post=stageUnderTest==='release-publication';
const order=[], tokens=Array.from({length:11},()=>({})),toolReceipt={},runtimeReceipt={};const final=post?10:5;
const files=Object.fromEntries(['subject','report','capture','bundle'].map(key=>[key,Buffer.from(key)]));
const producer={controller_revision:'a'.repeat(40),run_id:'99',run_attempt:1,job_id:88,check_run_id:'77'};
let fault='',directory,readbacks=0,stale=false,submittedAck;
const step=(name,index)=>async value=>{order.push(name);assert.equal(value,tokens[index-1]);if(fault===name)throw Error('original '+name+' refusal');return tokens[index]};
globalThis.fixture={
 parent:async(dir,platform,stage,deadline)=>{order.push('parent');assert.equal(dir,directory);assert.equal(platform,'linux-x86_64');assert.equal(stage,stageUnderTest);assert.ok(deadline>performance.now());if(fault==='parent')throw Error('original parent refusal');return tokens[0]},
 candidate:step('candidate',1),runtime:async(tools,parent)=>{order.push('runtime');assert.equal(tools,toolReceipt);assert.equal(parent,tokens[0]);if(fault==='runtime')throw Error('original runtime refusal');return runtimeReceipt},controller:async value=>{order.push('controller');assert.equal(value,tokens[0]);if(fault==='controller')throw Error('original controller refusal');return tokens[2]},inputs:step('inputs',3),journey:step('journey',4),package:step('package',5),payload:step('payload',6),request:step('request',post?7:2),capture:step('capture',post?8:3),report:step('report',post?9:4),sign:step('sign',post?10:5),
 original:async value=>{assert.equal(value,tokens[final]);if(stale)throw Error('custody expired');if(fault==='mutate-ack'&&submittedAck){await Promise.resolve();submittedAck.artifact_id=2;submittedAck.sha256='c'.repeat(64)}return {stage:stageUnderTest,directory,producer,files:Object.fromEntries(Object.entries(files).map(([key,bytes])=>[key,Buffer.from(bytes)])),artifact_name:'hosted-native-'+stageUnderTest+'-linux-x86_64-99-1',deadline:fault==='expired'?performance.now()-1:performance.now()+100000}},
};
globalThis.fixture.readback=(api,slot,dir,deadline)=>{
 readbacks++;assert.deepEqual(slot,{controller_revision:producer.controller_revision,run_id:'99',run_attempt:1,platform_label:'linux-x86_64',stage:stageUnderTest});assert.equal(dir,directory);assert.ok(deadline>performance.now());
 if(fault==='ambiguous')throw Error('provider unavailable');if(fault==='stale')stale=true;
 return {artifact:{id:fault==='mutate-ack'?2:1,sha256:fault==='mutate-ack'?'c'.repeat(64):'b'.repeat(64),bytes:100,name:'hosted-native-payload-signing-linux-x86_64-99-1'},locator:{run_id:'99',run_attempt:1,platform_label:'linux-x86_64',job_id:fault==='job'?9:88,check_run_id:fault==='check'?'9':'77'},files:{...files,...(fault==='bytes'?{bundle:Buffer.from('changed')}: {})}};
};
const routes={
 './release-hosted-native-parent.mts':{createActualHostedNativeParentSource:'parent'},
 './release-hosted-native-candidate.mts':{acquireActualHostedNativeCandidate:'candidate',readActualHostedNativePostSignController:'controller',readActualHostedNativePostSignJourney:'journey',acquireActualHostedNativePostSignPackage:'package'},
 './release-hosted-native-postsign-inputs.mts':{acquireActualHostedNativePostSignInputs:'inputs',verifyActualHostedNativePostSignPayload:'payload'},
 './release-hosted-native-runtime.mts':{prepareHostedNativeRuntime:'runtime'},
 './release-hosted-native-linux-request.mts':{prepareActualHostedNativeLinuxRequest:'request',prepareActualHostedNativeLinuxPostSignRequest:'request'},
 './release-hosted-native-linux-capture.mts':{captureActualHostedNativeLinuxInvocation:'capture'},
 './release-native-linux-report.mts':{prepareActualHostedLinuxNativeStageReport:'report'},
 './release-hosted-native-proof-producer.mts':{signActualHostedLinuxNativeProof:'sign',requireActualHostedLinuxNativeProof:'original'},
 './release-hosted-native-artifact.mts':{readHostedNativeProofArtifact:'readback'},
};
registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(entry)}&&routes[specifier])return {url:'inert-job:'+specifier,shortCircuit:true};return next(specifier,context)},load(url,context,next){if(url.startsWith('inert-job:'))return {format:'module',source:Object.entries(routes[url.slice('inert-job:'.length)]).map(([name,key])=>'export const '+name+'=globalThis.fixture.'+key+';').join('\n'),shortCircuit:true};return next(url,context)}});
const api=await import(${JSON.stringify(entry)});
const reset=name=>{fault=name;readbacks=0;stale=false;submittedAck=undefined;order.length=0;directory=path.join(root,name||'valid');mkdirSync(directory);for(const [key,bytes]of Object.entries(files))writeFileSync(path.join(directory,key+'.json'),bytes)};
const prepare=()=>post?api.prepareActualHostedLinuxPostSignJob(directory,performance.now()+100000,{tools:toolReceipt,executing_entry:'/fixed.bundle.mjs'}):api.prepareActualHostedLinuxPreSignJob(directory,performance.now()+100000);
const readBack=post?api.readBackActualHostedLinuxPostSignUpload:api.readBackActualHostedLinuxPreSignUpload;
const ack={artifact_id:1,sha256:'b'.repeat(64)};
reset('');
const upload=await prepare();
const phases=post?['parent','runtime','controller','inputs','journey','package','payload','request','capture','report','sign']:['parent','candidate','request','capture','report','sign'];assert.deepEqual(order,phases);
const ready=JSON.parse(readFileSync(upload.ready_file));
assert.equal(ready.retention_days,7);assert.equal(ready.overwrite,false);assert.equal(ready.compression_level,0);
assert.deepEqual(ready.files.map(file=>path.basename(file.path)),['subject.json','report.json','capture.json','bundle.json']);
await assert.rejects(readBack({...upload.receipt},ack),/original/);
assert.equal(readbacks,0);
const result=await readBack(upload.receipt,ack);
assert.equal(result.provider_bytes_match,true);assert.equal(result.native_acceptance,'not-established');assert.equal(result.authority,'none');
assert.equal(readbacks,1);assert.ok(existsSync(path.join(directory,'native-upload-readback.json')));
await assert.rejects(readBack(upload.receipt,ack),/recovery/);assert.equal(readbacks,1);
for(const name of phases){
 reset(name);await assert.rejects(prepare(),new RegExp('original '+name+' refusal'));assert.equal(order.at(-1),name);assert.equal(readbacks,0);assert.ok(!existsSync(path.join(directory,'native-upload-ready.json')));
}
for(const name of ['ack-id','ack-hash','ack-schema','mutate-ack','ready','expired','ambiguous','stale','job','check','bytes']){
 reset(name);const upload=await prepare();let submitted={...ack};
 if(name==='ack-id')submitted={...ack,artifact_id:2};
 if(name==='ack-hash')submitted={...ack,sha256:'c'.repeat(64)};
 if(name==='ack-schema')submitted={...ack,extra:true};
 if(name==='ready')writeFileSync(upload.ready_file,'{}');
 submittedAck=submitted;
 await assert.rejects(readBack(upload.receipt,submitted),/retain/);
 const before=readbacks;stale=false;fault='';
 await assert.rejects(readBack(upload.receipt,ack),/recovery/);assert.equal(readbacks,before);
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
  const nativeModule = new URL("./release-native-candidate.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import * as files from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {capacityDigest as digest} from ${JSON.stringify(capacity)};
import {coordinatorCommandTimeout} from ${JSON.stringify(deadlineModule)};
const root=process.argv[1]; process.env.GH_TOKEN='inert-reader';
const originals=new Set(); let parentReceipt, directory, fault='', stale=false, calls=0, hydrated=0, clock=1000, originalDeadline=101000; Object.defineProperty(performance,'now',{value:()=>clock});
const producer={controller_revision:'a'.repeat(40),controller_ref:'refs/tags/portcove-production-controller-fixture',actor_id:'123',run_id:'12345',run_attempt:1};
const candidate={phase:'publishing',source_commit:'b'.repeat(40),prepared_commit:'c'.repeat(40),prepared_tree:'d'.repeat(40),frozen_opportunity:{reviewed:true},version:'0.1.0-beta.1',transient_retries:0,substantive_repairs:0,release_run:{run_id:999,attempt:1,revision:'c'.repeat(40)}};
const {phase,release_run,prepared_tree,frozen_opportunity,...subject}=candidate;
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
 parent:async receipt=>{assert.ok(originals.has(receipt),'original active hosted native parent source required');check();return {directory,platform_label:'linux-x86_64',stage:fault==='wrong-stage'?'payload-signing':'release-publication',deadline:originalDeadline,configuration:{schema_version:4,purpose:'application',journal:{namespace:'fixture'},publication:{}},producer:{...producer},recheck:check}},
 recover:async()=>{calls++;check();const op=operation();const groups=[];if(['history','history-budget','history-expiry','duplicate','pending-history','hydrate-drift'].includes(fault))groups.push({summary_schema_version:1,subject:{kind:'candidate',identity:candidate.prepared_commit},kind:'upload',destination_sha256:digest(op.destination),transient_retries:0,substantive_repairs:0,completed:true,attempts:[{checkpoint:'3'.repeat(40),id:op.id,operation_sha256:digest(op)}]});return {checkpoint:(fault==='journal-drift'&&calls>1)?'8'.repeat(40):'7'.repeat(40),repository:directory,input:{active_candidate:structuredClone(candidate),controller:{capacity_attempt:{schema_version:2,operation:['history','history-budget','history-expiry','hydrate-drift','missing'].includes(fault)?null:fault==='pending-history'?{...op,outcome:'pending',completed_effects:[]}:op,prior_operations:groups}}}}},
 hydrate:async()=>{hydrated++; if(fault==='history-budget'||fault==='history-expiry'){assert.equal(coordinatorCommandTimeout(),100,'local Git must inherit the original100ms deadline');if(fault==='history-expiry'){clock+=101;assert.throws(()=>coordinatorCommandTimeout(),/exhausted/)}} if(fault==='hydrate-drift')stale=true; return operation()},
 write:async(...args)=>{await files.writeFile(...args);if(fault==='late-write'&&path.basename(args[0])==='original-controller-selection.json')stale=true;if(scenario==='journey-late-write'&&path.basename(args[0])==='journey.json')clock=122000}
};

const hash=b=>createHash('sha256').update(b).digest('hex');
const payload=Buffer.from('opaque compatible updater'),oldPayload=Buffer.from('opaque distinct predecessor');
const packageId={filename:'Portcove_0.1.0-beta.1_amd64.AppImage',bytes:payload.length,sha256:hash(payload)};
const packageCandidate={source_commit:candidate.prepared_commit,source_tree:candidate.prepared_tree,artifact_id:19,harness:{path:'apps/desktop/scripts/native-qualification.mts',sha256:'5'.repeat(64)},package:packageId};
const metadata={accepted:{version:candidate.version,run_id:'999',run_attempt:1,source_commit:candidate.prepared_commit},archive:{artifact_id:19,bytes:22,sha256:hash(Buffer.alloc(22))},archives:[]};
let inputReceipt,inputValue,sourceReceipt,packageReads=0,assetReads=0,scenario='',holdInputs=false,gateRelease,gateStarted;
Object.assign(globalThis.postsignFixture,{
 inputs:async receipt=>{assert.equal(receipt,inputReceipt);if(holdInputs){holdInputs=false;gateStarted();await new Promise(resolve=>{gateRelease=resolve})}return inputValue},
 config:x=>x,
 derive:async(raw,dir,deadline,parent)=>{assert.equal(parent,parentReceipt);assert.deepEqual(raw.platform_labels,['windows-x86_64','linux-x86_64']);assert.equal(raw.coordinator_input.active_candidate.prepared_commit,candidate.prepared_commit);assert.ok(deadline<=121000);if(scenario==='journey-refusal')throw Error('historical verification refused');const journey=scenario.startsWith('update')?{predecessor:{...packageCandidate,source_commit:'1'.repeat(40),source_tree:'2'.repeat(40),package:{...packageId,bytes:oldPayload.length,sha256:hash(oldPayload)}}}:{kind:'initial-empty-feed'};return [journey,journey].map(x=>({...x,signed_context_sha256:'3'.repeat(64),signatures_sha256:'4'.repeat(64)}))},
 request:(method,endpoint)=>{assert.equal(method,'GET');if(endpoint.endsWith('/actions/artifacts/19')){packageReads++;return {status:200,body:{id:19,stamp:scenario==='metadata-drift'&&packageReads>1?2:1}}}if(endpoint.includes('/releases/tags/'))return {status:200,body:{id:8,immutable:scenario!=='update-mutable'}};throw Error('unexpected fixed endpoint '+endpoint)},
 metadata:async(facts,platform,raw)=>{assert.equal(platform,'linux-x86_64');assert.equal(raw.id,19);if(scenario==='wrong-package')throw Error('signed package metadata refused');return structuredClone(metadata)},
 selected:async(facts,platform,retained)=>{assert.equal(platform,'linux-x86_64');assert.equal(hash(retained.bytes),packageId.sha256);return {candidate:structuredClone(packageCandidate),version:candidate.version}},
 discover:async(_archive,_identity,platform,_compiler,options)=>{assert.equal(platform,'linux-x86_64');await options.retainDesktopPackage({platform_label:platform,...packageId},payload)},
 predecessor:(_record,_candidate,release,_assets)=>{assetReads++;assert.equal(release.immutable,true,'immutable predecessor required');return {id:9,version:'0.1.0-beta.0',filename:packageId.filename,bytes:oldPayload.length,sha256:hash(oldPayload)}},
 archive:()=>Buffer.alloc(22),asset:()=>scenario==='update-bad-bytes'?Buffer.from('wrong predecessor'):oldPayload,
});
const routes={'./release-hosted-native-parent.mts':"export const requireActualHostedNativeParentSource=globalThis.postsignFixture.parent;",'./release-coordinator-recovery.mts':"export const recoverRemoteCoordinator=globalThis.postsignFixture.recover; export const hydrateRetainedCoordinatorOperation=globalThis.postsignFixture.hydrate;",'node:fs/promises':"export {chmod,mkdtemp} from 'node:fs/promises'; export const writeFile=globalThis.postsignFixture.write;",
 './release-hosted-native-postsign-inputs.mts':"export const requireActualHostedNativePostSignInputs=globalThis.postsignFixture.inputs;",
 './release-authority-configuration.mts':"export const inspectSelectedPublicationAuthorityConfiguration=globalThis.postsignFixture.config;",
 './release-native-publication-admission.mts':"export const deriveHostedNativePublicationJourneys=globalThis.postsignFixture.derive;",
 './release-artifact-archive.mts':"export const discoverReleaseArtifactFiles=globalThis.postsignFixture.discover;",
 './github-api.mts':"export class GitHubApiClient{request(...args){return globalThis.postsignFixture.request(...args)}paginateRest(){return [{id:9}]}};export const createGitHubRunner=()=>()=>{throw Error('unexpected CLI')};",
 './github-binary.mts':"export const readGitHubArtifactArchive=globalThis.postsignFixture.archive;export const readGitHubReleaseAsset=globalThis.postsignFixture.asset;",
 './release-native-candidate.mts':"export {inspectNativePostSignController,inspectNativePostSignArtifactInventory,inspectHostedNativePreparationStage,inspectNativeSourceCommand} from "+JSON.stringify(${JSON.stringify(nativeModule)})+"; export const inspectNativePostSignPackageMetadata=globalThis.postsignFixture.metadata;export const inspectSelectedNativeCandidate=globalThis.postsignFixture.selected;export const inspectNativePredecessorReleaseAsset=globalThis.postsignFixture.predecessor;",
};
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

for(const name of ['bootstrap','update','journey-refusal','wrong-package','metadata-drift','update-mutable','update-bad-bytes','journey-race','package-race','package-tamper','journey-lifetime','journey-late-write']){
 reset('integration-'+name);if(name==='journey-lifetime'||name==='journey-late-write')originalDeadline=301000;scenario=name;packageReads=assetReads=0;
 sourceReceipt=await api.readActualHostedNativePostSignController(parentReceipt);
 const source=await api.requireActualHostedNativePostSignController(sourceReceipt);
 inputReceipt={};const contextRoot=path.join(directory,'frozen-context');mkdirSync(contextRoot);
 const contextFiles=new Map([['context.json',Buffer.from('{}')]]);
 if(name.startsWith('update')){const old={target:'linux-x86_64',version:'0.1.0-beta.0',source_commit:'1'.repeat(40),source_tree:'2'.repeat(40),artifact:{bytes:oldPayload.length,sha256:hash(oldPayload)}};contextFiles.set('prior/targets/old.json',Buffer.from(JSON.stringify(old)))}
 for(const [name,bytes]of contextFiles){const filename=path.join(contextRoot,name);mkdirSync(path.dirname(filename),{recursive:true});writeFileSync(filename,bytes)}
 const manifest={files:[...contextFiles].map(([name,b])=>({path:name,bytes:b.length,sha256:hash(b)})),facts:{assembly:{reviewed:true},archives:[{platform:'linux-x86_64',artifact_id:19}]}};
 inputValue={directory,source_receipt:sourceReceipt,source,deadline:source.deadline,context:{context:path.join(contextRoot,'context.json'),manifest},publication:{repository_sha256:'3'.repeat(64)}};
 const journeyAttempt=()=>api.readActualHostedNativePostSignJourney(inputReceipt);
 if(name==='journey-refusal'||name==='journey-late-write'){await assert.rejects(journeyAttempt(),/retain/);continue}
 const journey=await journeyAttempt();await assert.rejects(api.requireActualHostedNativePostSignJourney({...journey}),/original active/);
 if(name==='journey-race'){
  const started=new Promise(r=>{gateStarted=r});holdInputs=true;const first=api.requireActualHostedNativePostSignJourney(journey);await started;
  const file=path.join(journey.directory,'journey.json'),bytes=readFileSync(file);writeFileSync(file,'{}');await assert.rejects(api.requireActualHostedNativePostSignJourney(journey),/changed/);writeFileSync(file,bytes);gateRelease();await assert.rejects(first,/stopped/);continue;
 }
 if(name==='journey-lifetime'){clock=122000;await api.requireActualHostedNativePostSignJourney(journey);clock=1000;continue}
 const packageAttempt=()=>api.acquireActualHostedNativePostSignPackage(journey);
 if(['wrong-package','metadata-drift','update-mutable','update-bad-bytes'].includes(name)){await assert.rejects(packageAttempt(),/retain/);await assert.rejects(packageAttempt(),/recovery/);continue}
 const selected=await packageAttempt(),value=await api.requireActualHostedNativePostSignPackage(selected);
 assert.equal(value.signature_verification,'pending');assert.equal(value.native_acceptance,'not-established');assert.equal(value.package_path.endsWith(packageId.filename),true);assert.equal(assetReads,name.startsWith('update')?2:0);
 await assert.rejects(api.requireActualHostedNativePostSignPackage({...selected}),/original active/);
 if(name==='package-race'){
  const started=new Promise(r=>{gateStarted=r});holdInputs=true;const first=api.requireActualHostedNativePostSignPackage(selected);await started;
  const file=path.join(value.directory,'package.json'),bytes=readFileSync(file);writeFileSync(file,'{}');await assert.rejects(api.requireActualHostedNativePostSignPackage(selected),/changed/);writeFileSync(file,bytes);gateRelease();await assert.rejects(first,/stopped/);
 }else if(name==='package-tamper'){
  const bytes=readFileSync(value.package_path);writeFileSync(value.package_path,'changed');await assert.rejects(api.requireActualHostedNativePostSignPackage(selected),/changed/);writeFileSync(value.package_path,bytes);await assert.rejects(api.requireActualHostedNativePostSignPackage(selected),/original active/);
 }
 await assert.rejects(packageAttempt(),/recovery/);
}
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

void test("hosted signed inputs keep default custody through the fixed keyless child and stop on late drift", (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "hosted-signed-inputs-"));
  const entry = new URL("./release-hosted-native-postsign-inputs.mts", import.meta.url).href;
  const canonical = new URL("./release-canonical.mts", import.meta.url).href;
  const captureModule = new URL("./release-native-capture-files.mts", import.meta.url).href;
  const qualifierModule = new URL("./qualify-controller-tool-build.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict'; import {registerHooks} from 'node:module';
import {mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import * as fs from 'node:fs/promises'; import path from 'node:path';
import {createHash} from 'node:crypto';import {performance} from 'node:perf_hooks';
import {releaseCanonicalDigest as digest} from ${JSON.stringify(canonical)};
import {readNativeCapturedStream as realStream} from ${JSON.stringify(captureModule)};
import {qualifyNativeChildren} from ${JSON.stringify(qualifierModule)};
const connected=process.env.PORTCOVE_CONNECTED_PAYLOAD_FIXTURE?JSON.parse(readFileSync(process.env.PORTCOVE_CONNECTED_PAYLOAD_FIXTURE,'utf8')):null;
const actualPayload=connected?readFileSync(connected.payload):Buffer.from('bytes'),actualSignature=connected?readFileSync(connected.signature,'utf8'):'inert signature',actualPublicKey=connected?readFileSync(connected.publicKey,'utf8'):'inert public key',actualKeyId=connected?connected.publicId:'7'.repeat(64);
const hash=b=>createHash('sha256').update(b).digest('hex');let clock=1000;
if(!connected)Object.defineProperty(performance,'now',{value:()=>clock});
process.env.GH_TOKEN='inert-reader';process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN='inert-parent-only';
const root=process.argv[1],sourceReceipt={},toolsReceipt={},runtimeReceipt={},parentReceipt={},ctxReceipt={},roleReceipts=new Map();
let fault='',stale=false,childDone=false,childStarted=false,sourceRoot,toolRoot,contextDir,manifest,inventory,publication;
let contextCalls=0,roleCalls=0,reads=0,payloadDone=false,childPlan,selectedPackage,holdStream=false,streamStarted,streamRelease;const packageReceipt={};
const anchor=Buffer.from('fixed public anchor'), pin={bytes:anchor.length,sha256:hash(anchor)};
const candidate={prepared_commit:'c'.repeat(40),prepared_tree:'d'.repeat(40),version:connected?connected.version:'0.1.0-beta.1',release_run:{run_id:999,attempt:1},frozen_opportunity:{accumulated_changes:'reviewed'}};
const producer={controller_revision:'a'.repeat(40),controller_ref:'refs/tags/portcove-production-controller-fixture',run_id:'12345',run_attempt:1};
const sourceDeadline=()=>fault==='retained-lifetime'?1001000:101000;
const phaseDeadline=()=>Math.min(301000,sourceDeadline());
const alive=()=>{if(stale||clock>=sourceDeadline())throw Error('original source stopped or expired')};
function source(){alive();return {parent_source:parentReceipt,directory:sourceRoot,deadline:sourceDeadline(),checkpoint:'e'.repeat(40),candidate:structuredClone(candidate),producer:{...producer},controller:{...producer},configuration:{purpose:'application',journal:{namespace:'fixture'},publication:{public_source:{root:pin,offline_targets:pin,payload_key_registry:pin}}}}}
function tools(){alive();return {identity:{...producer,source_tree:'f'.repeat(40),...(fault==='wrong-tool-run'?{run_id:'22222'}:{})},root:toolRoot,node:path.join(toolRoot,'node'),rust:path.join(toolRoot,'portcove-release-tools'),entries:{'release-native-keyless-assembly':path.join(toolRoot,'child.bundle.mjs')}}}
const reset=name=>{fault=name;stale=false;clock=1000;childDone=false;childStarted=false;payloadDone=false;selectedPackage=undefined;contextCalls=0;roleCalls=0;reads=0;roleReceipts.clear();sourceRoot=path.join(root,name||'valid');mkdirSync(sourceRoot,{recursive:true});toolRoot=connected?connected.tools:path.join(sourceRoot,'tools');if(!connected){mkdirSync(path.join(toolRoot,'bin'),{recursive:true});writeFileSync(path.join(toolRoot,'bin/portcove-release-tools'),'fixed rust');for(const name of ['node','portcove-release-tools','child.bundle.mjs'])writeFileSync(path.join(toolRoot,name),name);}manifest={controller:{...producer,source_tree:'f'.repeat(40)},binding:{records_sha256:hash(Buffer.from('[]'))},facts_sha256:'1'.repeat(64),facts:{opportunity:structuredClone(candidate.frozen_opportunity),assembly:{fixed:true}}};if(name==='opportunity')manifest.facts.opportunity={foreign:true};inventory={context:{id:1,bytes:100,sha256:'2'.repeat(64)},context_bundle:{id:2,bytes:100,sha256:'3'.repeat(64)},roles:['releases','preview','stable','snapshot','timestamp'].map((role,i)=>({role,artifact:{id:3+i*2,bytes:100,sha256:'4'.repeat(64)},bundle:{id:4+i*2,bytes:100,sha256:'5'.repeat(64)}}))}}
const fileInventory=dir=>{const out=[];const walk=(prefix='')=>{for(const ent of readdirSync(path.join(dir,prefix),{withFileTypes:true})){const name=prefix?prefix+'/'+ent.name:ent.name;if(ent.isDirectory())walk(name);else{const b=readFileSync(path.join(dir,name));out.push({path:name,bytes:b.length,sha256:hash(b)})}}};walk();return out.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)};
async function materialize(){
 if(path.basename(childPlan)==='native-payload-plan.json'){if(connected){const plan=readFileSync(childPlan);await qualifyNativeChildren(toolRoot,path.dirname(childPlan),{args:[connected.entry,childPlan,hash(plan)],timeout:100000});payloadDone=true;return}const plan=readFileSync(childPlan),p=JSON.parse(plan),dir=path.dirname(childPlan);assert.equal(path.basename(p.artifact),'Portcove_0.1.0-beta.1_amd64.AppImage');const stdout=Buffer.from('actual verifier model'),stderr=Buffer.alloc(0);writeFileSync(path.join(dir,'native-payload.stdout.bin'),stdout);writeFileSync(path.join(dir,'native-payload.stderr.bin'),stderr);writeFileSync(path.join(dir,'native-payload-result.json'),JSON.stringify({schema_version:1,plan_sha256:hash(plan),report:{schema_version:1,signature_verified:true,sha256:p.sha256,bytes:p.bytes,public_key_sha256:fault==='payload-result'?'9'.repeat(64):p.public_key_sha256},stdout_sha256:hash(stdout),stderr_sha256:hash(stderr),authority:'none'}));payloadDone=true;return}
 childStarted=true;const dirs=readdirSync(sourceRoot).filter(name=>name.startsWith('signed-inputs-'));assert.equal(dirs.length,1);const dir=path.join(sourceRoot,dirs[0]);const plan=readFileSync(path.join(dir,'native-keyless-plan.json'));const parsed=JSON.parse(plan);assert.equal(parsed.signed_roles.length,5);assert.equal(parsed.tool.path,path.join(toolRoot,'bin/portcove-release-tools'));assert.equal(parsed.context_directory,contextDir);const assembled=path.join(dir,'tuf-publication-fixture'),repository=path.join(assembled,'repository');mkdirSync(repository,{recursive:true});for(const name of ['public-inputs','signed-roles']){mkdirSync(path.join(assembled,name));writeFileSync(path.join(assembled,name,'fixture.json'),'{}')}writeFileSync(path.join(assembled,'assembly-report.json'),'{}');writeFileSync(path.join(repository,'record.json'),'retained signed record');writeFileSync(path.join(repository,'repository-manifest.json'),'{}');const files=fileInventory(repository);publication={records_sha256:manifest.binding.records_sha256,repository_sha256:digest(files.filter(f=>f.path!=='repository-manifest.json'))};if(fault==='records')publication.records_sha256='9'.repeat(64);const result={schema_version:1,plan_sha256:fault==='result-plan'?'9'.repeat(64):hash(plan),assembled:{directory:assembled,repository,files,publication,input_files:fileInventory(path.join(assembled,'public-inputs')),signed_files:fileInventory(path.join(assembled,'signed-roles')),report_sha256:hash(Buffer.from('{}'))},authority:'none',scope:'keyless utility data'};writeFileSync(path.join(dir,'native-keyless-result.json'),JSON.stringify(result));childDone=true;if(fault==='after-settle')stale=true}
globalThis.signedFixture={
 runtime:async(r,p)=>{assert.equal(r,runtimeReceipt);assert.equal(p,parentReceipt);alive();if(fault==='runtime')throw Error('foreign runtime');return {root:toolRoot,deadline:sourceDeadline()}},
 support:async(r,p,d)=>{assert.equal(r,runtimeReceipt);assert.equal(p,parentReceipt);assert.ok(d.startsWith(sourceRoot));return {rustSupportCompilerIdentity:()=>{throw Error('controlled callback not invoked')},prepareSupportArtifact:()=>{throw Error('controlled callback not invoked')}}},
 stream:async(root,name)=>{if(holdStream){holdStream=false;streamStarted();await new Promise(r=>{streamRelease=r})}return realStream(root,name)},
 package:async r=>{assert.equal(r,packageReceipt);alive();assert.ok(selectedPackage);if(fault==='payload-package-drift'&&payloadDone)throw Error('original package changed');return selectedPackage},
 source:async r=>{assert.equal(r,sourceReceipt);reads++;return source()},tools:async r=>{assert.equal(r,toolsReceipt);if(fault==='tool-drift'&&childDone)stale=true;return tools()},
 inventory:async r=>{assert.equal(r,sourceReceipt);alive();return fault==='inventory'&&childDone?{...inventory,foreign:true}:structuredClone(inventory)},
 archive:async r=>{assert.equal(r,sourceReceipt);alive();return {inventory:structuredClone(inventory),bytes:Buffer.from('owned original archive')}},
 inspect:()=>({files:new Map([['trusted-root.json',fault==='anchor'?Buffer.from('foreign'):anchor],['offline-targets.json',anchor],['payload.json',anchor]]),manifest:structuredClone(manifest),manifest_sha256:'6'.repeat(64)}),
 receiveContext:async(...args)=>{assert.equal(args.length,3,'default context transport only');contextCalls++;assert.ok(args[2]<=phaseDeadline());const dir=path.join(args[0],'received-context');contextDir=path.join(dir,'context');mkdirSync(contextDir,{recursive:true});writeFileSync(path.join(contextDir,'context.json'),'{}');mkdirSync(path.join(contextDir,'records/releases'),{recursive:true});writeFileSync(path.join(contextDir,'records/releases/linux.json'),JSON.stringify({target:'linux-x86_64',version:candidate.version,source_commit:candidate.prepared_commit,source_tree:candidate.prepared_tree,artifact:{bytes:actualPayload.length,sha256:hash(actualPayload),payload_key_id:actualKeyId,tauri_signature:actualSignature}}));writeFileSync(path.join(contextDir,'payload.json'),JSON.stringify({keys:[{id:actualKeyId,tauri_public_key:actualPublicKey}]}));return Object.assign(ctxReceipt,{directory:dir,evidence_scope:'github.com'})},
 requireContext:async r=>{assert.equal(r,ctxReceipt);alive();if(fault==='context-drift'&&childDone)throw Error('retained context changed');return {directory:r.directory,context:path.join(contextDir,'context.json'),manifest:structuredClone(manifest)}},
 receiveRole:async(...args)=>{assert.equal(args.length,4,'default role transport only');assert.equal(args[0],ctxReceipt);assert.ok(args[3]<=phaseDeadline());roleCalls++;const expected=args[2],receipt={};const file=path.join(args[1],expected.role+'.json');writeFileSync(file,'{}');roleReceipts.set(receipt,{envelope:{filename:expected.role+'.json',path:file,bytes:2,sha256:hash(Buffer.from('{}'))}});return receipt},
 snapshotContext:async r=>{const context=await globalThis.signedFixture.requireContext(r);return {context,root:context.directory,files:fileInventory(path.dirname(context.context)).map(f=>({...f,path:'context/'+f.path}))}},
 snapshotRole:async r=>{const actual=await globalThis.signedFixture.requireRole(r);return {root:path.dirname(actual.envelope.path),files:[{path:path.basename(actual.envelope.path),bytes:2,sha256:hash(Buffer.from('{}'))}]}},
 requireRole:async r=>{alive();assert.ok(roleReceipts.has(r));if(fault==='role-drift'&&childDone)throw Error('retained role changed');return roleReceipts.get(r)},
 parseConfig:x=>x,parseAssembly:async()=>({accepted:{release_profile:'initial-beta-win-linux',source_commit:fault==='compiler'?'9'.repeat(40):candidate.prepared_commit,source_tree:candidate.prepared_tree,version:candidate.version,run_id:'999',run_attempt:1},labels:['windows-x86_64','linux-x86_64']}),parsePublication:x=>x,
 resource:async(profile,exe,args,options)=>{childPlan=args[1];assert.equal(profile,'analysis');assert.equal(exe,path.join(toolRoot,'bin/node'));assert.equal(args[0],path.join(toolRoot,'scripts/release-native-keyless-assembly.bundle.mjs'));assert.equal(options.queueDeadline,phaseDeadline());assert.ok(options.exclusive[0].startsWith('native-keyless:'));for(const key of ['GH_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN','NODE_OPTIONS'])assert.equal(options.environment[key],undefined);if(fault==='queue-expiry')clock=101001;return options.supervise(['fixed-child'],{acquireLock:async()=>({release:async()=>{}})})},
 supervise:async(_args,options)=>{assert.equal(typeof options.rustSupportCompilerIdentity,'function');assert.equal(typeof options.prepareSupportArtifact,'function');const lease=await options.acquireLock({},{});try{if(fault==='child-failure'||(fault==='payload-child'&&path.basename(childPlan)==='native-payload-plan.json'))return 1;await materialize();return 0}finally{await lease.release()}},
 write:async(...args)=>{await fs.writeFile(...args);if(path.basename(args[0])==='refusal.json')console.error('controlled refusal '+fault+': '+JSON.parse(args[1]).phase);if(fault==='late-write'&&path.basename(args[0])==='signed-inputs.json')stale=true}
};
const routes={
 './release-hosted-native-candidate.mts':{requireActualHostedNativePostSignController:'source',readActualHostedNativePostSignInventory:'inventory',readActualHostedNativePostSignContextArchive:'archive',requireActualHostedNativePostSignPackage:'package'},
 './release-native-capture-files.mts':{readNativeCapturedStream:'stream'},
 './release-controller-tool-admission.mts':{verifiedControllerToolPaths:'tools'},
 './release-hosted-native-runtime.mts':{requireHostedNativeRuntime:'runtime',hostedNativeSupportDependencies:'support'},
 './release-signing-context-artifact.mts':{inspectSigningContextArchive:'inspect',receiveSigningContextArtifact:'receiveContext',requireReceivedSigningContext:'requireContext',snapshotReceivedSigningContextEvidence:'snapshotContext'},
 './release-tuf-role-artifact.mts':{receiveTufRoleArtifact:'receiveRole',requireReceivedTufRoleArtifact:'requireRole',snapshotReceivedTufRoleEvidence:'snapshotRole'},
 './release-authority-configuration.mts':{inspectSelectedPublicationAuthorityConfiguration:'parseConfig'},
 './trusted-release-assembly.mts':{inspectTrustedAssemblyInput:'parseAssembly'},
 './release-metadata-contract.mts':{inspectTufPublicationFacts:'parsePublication'},
 './resource-command.mts':{runResourceCommand:'resource'},'./run-rust-tests.mts':{runRustTests:'supervise'},
 'node:fs/promises':{writeFile:'write'},
};
let serial=0;
registerHooks({resolve(s,c,next){if(c.parentURL.startsWith(${JSON.stringify(entry)})&&routes[s])return {url:'signed-fixture:'+s,shortCircuit:true};return next(s,c)},load(u,c,next){if(u.startsWith('signed-fixture:')){const name=u.slice('signed-fixture:'.length);return {format:'module',source:(name==='node:fs/promises'?"export {chmod,mkdtemp} from 'node:fs/promises';":name==='./release-native-capture-files.mts'?"export {hashNativeCapturedFile} from "+JSON.stringify(${JSON.stringify(captureModule)})+";":'')+Object.entries(routes[name]).map(([name,key])=>'export const '+name+'=globalThis.signedFixture.'+key+';').join('\n'),shortCircuit:true}}return next(u,c)}});
for(const name of ['','payload-valid','payload-result','payload-child','payload-package-drift','payload-tamper','payload-race','retained-lifetime','retained-input','retained-role','retained-report','runtime','wrong-tool-run','anchor','opportunity','compiler','queue-expiry','child-failure','after-settle','result-plan','records','context-drift','role-drift','inventory','tool-drift','late-write']){
 if(connected&&!['payload-valid','payload-race','payload-tamper'].includes(name))continue;
 reset(name);const api=await import(${JSON.stringify(entry)}+'?case='+(serial++));
 const attempt=()=>api.acquireActualHostedNativePostSignInputs(sourceReceipt,toolsReceipt,runtimeReceipt);
 if(name===''||name.startsWith('retained-')||name.startsWith('payload-')){
  const receipt=await attempt();const value=await api.requireActualHostedNativePostSignInputs(receipt);assert.equal(contextCalls,1);assert.equal(roleCalls,5);assert.equal(childStarted,true);assert.equal(value.authority,'none');assert.equal(value.native_acceptance,'not-established');assert.match(value.scope,/package\/journey\/capture pending/);

  if(name.startsWith('payload-')){
   const dir=path.join(value.directory,'payload');mkdirSync(dir);const packagePath=path.join(dir,'Portcove_0.1.0-beta.1_amd64.AppImage');writeFileSync(packagePath,actualPayload);
   selectedPackage={directory:dir,package_path:packagePath,inputs_receipt:receipt,platform_label:'linux-x86_64',version:candidate.version,candidate:{source_commit:candidate.prepared_commit,source_tree:candidate.prepared_tree,package:{filename:path.basename(packagePath),bytes:actualPayload.length,sha256:hash(actualPayload)}},journey:{signed_context_sha256:'2'.repeat(64),signatures_sha256:'3'.repeat(64)}};
   const verify=()=>api.verifyActualHostedNativePostSignPayload(packageReceipt);
   if(['payload-result','payload-child','payload-package-drift'].includes(name)){await assert.rejects(verify(),/retain/);await assert.rejects(verify(),/recovery/);continue}
   const proof=await verify(),verified=await api.requireActualHostedNativePostSignPayload(proof);assert.equal(verified.signature_verification,'actual-fixed-verifier');assert.equal(verified.native_acceptance,'not-established');assert.equal(readFileSync(path.join(dir,'native-payload.stderr.bin')).length,0);await assert.rejects(api.requireActualHostedNativePostSignPayload({...proof}),/original active/);
   const file=path.join(dir,'native-payload-result.json'),bytes=readFileSync(file);
   if(name==='payload-race'){const started=new Promise(r=>{streamStarted=r});holdStream=true;const first=api.requireActualHostedNativePostSignPayload(proof);await started;writeFileSync(file,'{}');await assert.rejects(api.requireActualHostedNativePostSignPayload(proof),/changed/);writeFileSync(file,bytes);streamRelease();await assert.rejects(first,/stopped/)}
   if(name==='payload-tamper'){writeFileSync(file,'{}');await assert.rejects(api.requireActualHostedNativePostSignPayload(proof),/changed/);writeFileSync(file,bytes);await assert.rejects(api.requireActualHostedNativePostSignPayload(proof),/original active/)}
   await assert.rejects(verify(),/recovery/);continue;
  }
  const originalReads=reads;await assert.rejects(api.requireActualHostedNativePostSignInputs({...receipt}),/original active/);assert.equal(reads,originalReads);
  if(name==='retained-lifetime'){clock=450000;await api.requireActualHostedNativePostSignInputs(receipt);clock=1000;}
  const assembled=path.dirname(value.repository);const target=name==='retained-input'?path.join(assembled,'public-inputs/fixture.json'):name==='retained-role'?path.join(assembled,'signed-roles/fixture.json'):name==='retained-report'?path.join(assembled,'assembly-report.json'):path.join(value.repository,'record.json'),bytes=readFileSync(target);writeFileSync(target,'changed');await assert.rejects(api.requireActualHostedNativePostSignInputs(receipt),/changed/);writeFileSync(target,bytes);await assert.rejects(api.requireActualHostedNativePostSignInputs(receipt),/original active/);
 }else{
  await assert.rejects(attempt(),/retain/);const dirs=readdirSync(sourceRoot).filter(n=>n.startsWith('signed-inputs-'));assert.equal(dirs.length,1);const refusal=JSON.parse(readFileSync(path.join(sourceRoot,dirs[0],'refusal.json')));assert.equal(refusal.automatic_retry,false);assert.equal(refusal.recovery_required,true);
  if(name==='anchor')assert.equal(contextCalls,0);if(name==='queue-expiry')assert.equal(childStarted,false);
 }
 stale=false;fault='';clock=1000;await assert.rejects(attempt(),/explicit recovery/);
}
console.log('controlled default-receiver and owned-keyless composition passed');if(connected)console.log('actual packed payload verifier and private getter passed with empty stderr, tamper and gated race refusals; provider/source custody remains controlled');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /controlled default-receiver and owned-keyless composition passed/u);
});
