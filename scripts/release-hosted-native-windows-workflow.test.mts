/** Real file/process rendezvous with controlled admission, custody and birth
 * observations. No Windows account, native candidate or protected authority. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseDocument } from "yaml";
import { isRecord } from "./runtime-values.mts";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import {
  startHostedWindowsWorkflow,
  hostedWindowsWorkflowUploadRequest,
  acknowledgeHostedWindowsWorkflowUpload,
  settleHostedWindowsWorkflowStage,
} from "./release-hosted-native-workflow.mts";
import { superviseFixedHostedWindowsNativeJob } from "./release-hosted-native-worker.mts";

void test("every real Windows transport entry remains held before source reads, process or upload effects", async () => {
  for (const call of [
    () => startHostedWindowsWorkflow(),
    () => hostedWindowsWorkflowUploadRequest("pre-sign"),
    () => acknowledgeHostedWindowsWorkflowUpload("post-sign", "", "", ""),
    () => settleHostedWindowsWorkflowStage("post-sign"),
    () => superviseFixedHostedWindowsNativeJob(),
  ])
    await assert.rejects(call(), /awaits separate bootstrap execution authority/);
});

void test("unused Windows action retains fixed uploads and adds no production job or external post-start scheduler", async () => {
  const action: unknown = parseDocument(
    await readFile(
      new URL("../.github/actions/release-native-windows/action.yml", import.meta.url),
      "utf8",
    ),
  ).toJS();
  assert.ok(isRecord(action) && isRecord(action.runs) && Array.isArray(action.runs.steps));
  const steps: unknown[] = action.runs.steps;
  const serialized = JSON.stringify(steps);
  for (const operation of ["windows-start", "windows-request", "windows-ack", "windows-settle"])
    assert.ok(serialized.includes(operation));
  assert.doesNotMatch(serialized, /post-start|private_key|secrets\./);
  const upload = steps.find((value) => isRecord(value) && value.id === "upload");
  assert.ok(isRecord(upload));
  assert.equal(upload.uses, "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
  assert.deepEqual(upload.with, {
    name: "${{ steps.ready.outputs.name }}",
    path: "${{ steps.ready.outputs.paths }}",
    "if-no-files-found": "error",
    overwrite: false,
    "retention-days": 7,
    "compression-level": 0,
  });
  const production = await readFile(
    new URL("../.github/workflows/application-update-production.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    production,
    /^  native_windows:|uses: \.\/\.github\/actions\/release-native-windows/mu,
  );
});

const inertWorker = String.raw`
import {mkdir,writeFile,readFile} from 'node:fs/promises';import {existsSync} from 'node:fs';import {createHash} from 'node:crypto';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
const {retainCompletedReleaseRoutingRecord:complete,retainReleaseRoutingMarker:put}=await import(process.env.PORTCOVE_FIXTURE_MARKER);
const mode=process.env.PORTCOVE_FIXTURE_MODE,root=path.join(process.env.HOME,'.pcn-'+'b'.repeat(32)),hash=b=>createHash('sha256').update(b).digest('hex');
setTimeout(()=>process.exit(2),20000).unref();
const pause=async()=>{if(existsSync(path.join(process.env.HOME,'stop')))process.exit(2);await delay(5)};
await mkdir(root,{mode:0o700});
const intent=JSON.parse(await readFile(path.join(process.env.RUNNER_TEMP,'portcove-native-windows-workflow-start.json'),'utf8'));
const now=process.hrtime.bigint();
await writeFile(path.join(root,'portcove-native-job-clock.json'),JSON.stringify({schema_version:1,authority:'none',platform:'windows-x86_64',binding:'b'.repeat(64),started_ns:String(now),deadline_ns:intent.deadline_ns}),{flag:'wx',mode:0o600});
await writeFile(path.join(root,'native-supervision-started.json'),JSON.stringify({schema_version:1,authority:'none',binding:'b'.repeat(64),pid:process.pid,identity:process.env.PORTCOVE_FIXTURE_BIRTH}),{flag:'wx',mode:0o600});
for(const stage of ['pre-sign','post-sign']){
 const phase=stage==='pre-sign'?'payload-signing':'release-publication',parent=stage==='post-sign'&&mode==='session-parent'?'ZYX987':'ABCDEF';
 const relative='hosted-native-parent-'+parent+'/windows-session/'+phase+'/capture',directory=path.join(root,...relative.split('/')),publicRoot=path.join(directory,'proof');
 await mkdir(publicRoot,{recursive:true,mode:0o700});
 await complete(path.join(root,'windows-native-'+stage+'-stage.json'),{schema_version:1,authority:'none',platform:'windows-x86_64',stage:mode==='stage'?'post-sign':stage,run_id:'123',run_attempt:1,revision:'a'.repeat(40),owner_pid:mode==='owner'?process.pid+1:process.pid,owner_identity:process.env.PORTCOVE_FIXTURE_BIRTH,directory:relative});
 if(mode==='delayed-request')await delay(250);
 const files=[];for(const name of ['subject','report','capture','bundle']){const file=path.join(publicRoot,name+'.json'),bytes=Buffer.from('{}');await writeFile(file,bytes,{flag:'wx',mode:0o600});files.push({path:file,bytes:bytes.length,sha256:hash(bytes)})}
 const ready=Buffer.from(JSON.stringify({schema_version:1,authority:'none',retention_days:7,overwrite:false,compression_level:0,name:'hosted-native-'+phase+'-'+(mode==='platform'?'linux-x86_64':'windows-x86_64')+'-123-1',files})),readyFile=path.join(publicRoot,'native-upload-ready.json');await writeFile(readyFile,ready,{flag:'wx',mode:0o600});
 await put(path.join(directory,'native-job-upload-request.json'),{schema_version:1,authority:'none',nonce:stage==='pre-sign'?'1'.repeat(32):'2'.repeat(32),ready_file:readyFile,ready_sha256:hash(ready),deadline_ns:intent.deadline_ns});
 const ack=path.join(directory,'native-job-upload-ack.json');while(!existsSync(ack))await pause();
 if(mode==='provider-refusal'){await put(path.join(directory,'native-job-refusal.json'),{schema_version:1,authority:'none',recovery_required:true});process.exit(2)}
 await put(path.join(directory,'native-job-settlement.json'),{schema_version:1,authority:'none',exit_code:0,provider_bytes_match:true,native_acceptance:'not-established'});
}
if(mode!=='missing-terminal')await complete(path.join(root,'native-supervision-settlement.json'),{schema_version:1,authority:'none',binding:'b'.repeat(64),platform:'windows-x86_64',phase:'complete',pre_sign_complete:true,post_sign_complete:true,exit_code:0,recovery_required:false,deadline_ns:intent.deadline_ns,native_acceptance:'not-established'});
`;

void test("Windows handoff retains one process and refuses stale, changed, expired and incomplete routing", (t) => {
  const root = disposableDirectory(t, path.join(os.homedir(), ".windows-workflow-control-"));
  const entry = new URL("./release-hosted-native-workflow.mts", import.meta.url).href;
  const marker = new URL("./release-routing-marker.mts", import.meta.url).href;
  const toolReader = new URL("./release-controller-tools.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,copyFile,chmod,link,unlink} from 'node:fs/promises';import {lstatSync,existsSync} from 'node:fs';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
const root=process.argv[1],entry=${JSON.stringify(entry)},marker=${JSON.stringify(marker)},worker=${JSON.stringify(inertWorker)};
const real=await import(${JSON.stringify(toolReader)});
let home,temporary,directory,child,closed,birth,live,mode,spoof=false,tools,token={},spawns=0;
const binding='b'.repeat(64),identity={run_id:'123',run_attempt:1,controller_revision:'a'.repeat(40),controller_ref:'refs/tags/portcove-production-controller-fixture'};
const originalSpawn=spawn;
const custody=files=>new Map(files.map(file=>{const s=lstatSync(file,{bigint:true});assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n,'single-link controlled custody');return [file,[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':')]}));
globalThis.windowsWorkflowPeer={
 scope:async()=>({identity,binding,temporary,artifact:{platform:'windows-x86_64'},bundle:{},unchanged(){}}),
 linux:async()=>assert.fail('Windows cannot select Linux source'),
 deadline:()=>performance.now()+30000,
 receive:async()=>token,
 paths:async value=>{assert.equal(value,token);return tools},
 profile:()=>({paths:['bin/node.exe','scripts/release-hosted-native-worker.bundle.mjs']}),
 read:real.readControllerToolFile,custody,recheck:(files,before)=>assert.deepEqual(custody(files),before),
 identity:pid=>pid===child?.pid&&live?(spoof?'reused-fixture-birth':birth):null,
 spawn:(command,args,options)=>{spawns++;assert.equal(command,tools.node);assert.deepEqual(args,[tools.entries['release-hosted-native-worker'],'windows-run']);child=originalSpawn(command,args,options);live=true;closed=new Promise(resolve=>child.once('close',()=>{live=false;resolve()}));return child},
};
const routes={
 './release-hosted-native-bootstrap.mts':"export const hostedWindowsBootstrapExecutionAuthorized=true;export const readActualHostedWindowsBootstrapScope=globalThis.windowsWorkflowPeer.scope;export const readActualHostedLinuxBootstrapScope=globalThis.windowsWorkflowPeer.linux;",
 './release-signing-job-budget.mts':"export const currentNativeJobDeadline=globalThis.windowsWorkflowPeer.deadline;",
 './release-controller-tool-admission.mts':"export const receiveControllerTools=globalThis.windowsWorkflowPeer.receive;export const verifiedControllerToolPaths=globalThis.windowsWorkflowPeer.paths;",
 './release-controller-tools.mts':"export const controllerToolPaths=[];export const controllerToolPlatformProfile=globalThis.windowsWorkflowPeer.profile;export const readControllerToolFile=globalThis.windowsWorkflowPeer.read;",
 './release-native-runtime-custody.mts':"export const inspectNativeRuntimeCustody=globalThis.windowsWorkflowPeer.custody;export const recheckNativeRuntimeCustody=globalThis.windowsWorkflowPeer.recheck;",
 './heavy-rust-test-lock.mts':"export const readProcessIdentity=globalThis.windowsWorkflowPeer.identity;",
 './release-hosted-native-worker.mts':"export const signalFixedHostedLinuxPostStart=()=>{throw Error('Windows must not signal an external post-start')};",
 'node:child_process':"export const spawn=globalThis.windowsWorkflowPeer.spawn;",
};
registerHooks({resolve(s,c,next){if(c.parentURL===entry&&routes[s])return {url:'windows-workflow:'+s,shortCircuit:true};return next(s,c)},load(u,c,next){if(u.startsWith('windows-workflow:'))return {format:'module',source:routes[u.slice('windows-workflow:'.length)],shortCircuit:true};return next(u,c)}});
const api=await import(entry);
// Reuse only this fixture's immutable inert tool bytes; every case gets fresh
// intent, process, clock, stage records, proof files and acknowledgements.
const toolRoot=path.join(root,'tools');await mkdir(path.join(toolRoot,'bin'),{recursive:true,mode:0o700});await mkdir(path.join(toolRoot,'scripts'),{mode:0o700});
const node=path.join(toolRoot,'bin/node.exe');await copyFile(process.execPath,node);await chmod(node,0o700);const executable=path.join(toolRoot,'scripts/release-hosted-native-worker.bundle.mjs');await writeFile(executable,worker,{mode:0o600});await writeFile(path.join(toolRoot,'manifest.json'),'{}',{mode:0o600});
tools={root:toolRoot,node,platform:'windows-x86_64',entries:{'release-hosted-native-worker':executable}};
for(const scenario of ['success','delayed-request','platform','owner','stage','proof-bytes','route-bytes','completed-data-deleted','completed-clock-deleted','proof-data-deleted','completion-name','completion-size','route-link','exit-before-request','exit-after-request','pid-reuse','clock-expired','missing-terminal','session-parent','provider-refusal']){
 mode=scenario;spoof=false;spawns=0;birth='inert-birth-'+scenario;child=undefined;live=false;
 home=path.join(root,scenario);temporary=path.join(home,'temporary');await mkdir(temporary,{recursive:true,mode:0o700});process.env.HOME=home;process.env.USERPROFILE=home;process.env.RUNNER_TEMP=temporary;
 process.env.PORTCOVE_FIXTURE_MARKER=marker;process.env.PORTCOVE_FIXTURE_MODE=scenario;process.env.PORTCOVE_FIXTURE_BIRTH=birth;
 directory=path.join(home,'.pcn-'+binding.slice(0,32));
 try {
  await api.startHostedWindowsWorkflow();child.ref();assert.equal(spawns,1);await assert.rejects(api.startHostedWindowsWorkflow(),{code:'EEXIST'});assert.equal(spawns,1);
  if(scenario==='exit-before-request'){await writeFile(path.join(home,'stop'),'stop');await closed;await assert.rejects(api.hostedWindowsWorkflowUploadRequest('pre-sign'));continue}
  if(['platform','owner','stage'].includes(scenario)){await assert.rejects(api.hostedWindowsWorkflowUploadRequest('pre-sign'));continue}
  const request=await api.hostedWindowsWorkflowUploadRequest('pre-sign');assert.equal(request.files.length,4);
  const pre=path.join(directory,'hosted-native-parent-ABCDEF/windows-session/payload-signing/capture');
  if(scenario==='proof-bytes'){await writeFile(request.files[0],'changed');await assert.rejects(api.hostedWindowsWorkflowUploadRequest('pre-sign'));continue}
  if(scenario==='route-bytes'){await writeFile(path.join(directory,'windows-native-pre-sign-stage.json'),'{}');await assert.rejects(api.hostedWindowsWorkflowUploadRequest('pre-sign'));continue}
  if(scenario==='completed-data-deleted'||scenario==='completed-clock-deleted'||scenario==='proof-data-deleted'){
   const file=scenario==='completed-data-deleted'?path.join(directory,'windows-native-pre-sign-stage.json'):scenario==='completed-clock-deleted'?path.join(directory,'portcove-native-job-clock.json'):request.files[0];
   await unlink(file);await assert.rejects(api.hostedWindowsWorkflowUploadRequest('pre-sign'),error=>error.code==='EINTEGRITY'&&error.cause?.code==='ENOENT');continue
  }
  if(scenario==='completion-name'||scenario==='completion-size'){const file=path.join(directory,'windows-native-pre-sign-stage.json.complete.json'),value=JSON.parse(await readFile(file,'utf8'));if(scenario==='completion-name')value.record='other.json';else value.bytes=1073741824;await writeFile(file,JSON.stringify(value));await assert.rejects(api.hostedWindowsWorkflowUploadRequest('pre-sign'));continue}
  if(scenario==='route-link'){await link(path.join(directory,'windows-native-pre-sign-stage.json'),path.join(directory,'extra-alias'));await assert.rejects(api.hostedWindowsWorkflowUploadRequest('pre-sign'));continue}
  if(scenario==='exit-after-request'){await writeFile(path.join(home,'stop'),'stop');await closed;await assert.rejects(api.acknowledgeHostedWindowsWorkflowUpload('pre-sign',request.request_sha256,'1','c'.repeat(64)));assert.equal(existsSync(path.join(pre,'native-job-upload-ack.json')),false);continue}
  if(scenario==='pid-reuse'){spoof=true;await assert.rejects(api.hostedWindowsWorkflowUploadRequest('pre-sign'),/reused/);continue}
  if(scenario==='clock-expired'){const file=path.join(directory,'portcove-native-job-clock.json'),value=JSON.parse(await readFile(file,'utf8'));value.deadline_ns=String(process.hrtime.bigint()-1n);await writeFile(file,JSON.stringify(value));await assert.rejects(api.hostedWindowsWorkflowUploadRequest('pre-sign'));continue}
  await api.acknowledgeHostedWindowsWorkflowUpload('pre-sign',request.request_sha256,'1','c'.repeat(64));
  if(scenario==='provider-refusal'){await assert.rejects(api.settleHostedWindowsWorkflowStage('pre-sign'));continue}
  await api.settleHostedWindowsWorkflowStage('pre-sign');assert.equal(live,true);
  if(scenario==='session-parent'){await assert.rejects(api.hostedWindowsWorkflowUploadRequest('post-sign'),/original session parent/);continue}
  const post=await api.hostedWindowsWorkflowUploadRequest('post-sign');await api.acknowledgeHostedWindowsWorkflowUpload('post-sign',post.request_sha256,'2','d'.repeat(64));
  if(scenario==='missing-terminal')await assert.rejects(api.settleHostedWindowsWorkflowStage('post-sign'),/without matching terminal settlement/);
  else {const result=await api.settleHostedWindowsWorkflowStage('post-sign');assert.equal(result.native_acceptance,'not-established');assert.equal(live,false)}
 } finally {
  spoof=false;
  if(child&&live){await writeFile(path.join(home,'stop'),'stop');await Promise.race([closed,delay(2500).then(()=>{throw Error('inert worker did not close; preserve bounded orphan deadline')})])}
 }
}
console.log('19 controlled Windows workflow cases passed; real files/processes, inert admission/custody/birth/provider peers; no native acceptance');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 55000,
    maxBuffer: 65536,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /19 controlled Windows workflow cases passed/);
});

void test("original Windows worker bounds caller and terminal clocks and preserves changed-intent and late-publication refusal", (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "windows-worker-terminal-"));
  const entry = new URL("./release-hosted-native-worker.mts", import.meta.url).href;
  const marker = new URL("./release-routing-marker.mts", import.meta.url).href;
  const reader = new URL("./release-controller-tools.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {mkdir,writeFile,readFile} from 'node:fs/promises';import {lstatSync,existsSync} from 'node:fs';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
const entry=${JSON.stringify(entry)},root=process.argv[1],marker=await import(${JSON.stringify(marker)}),reader=await import(${JSON.stringify(reader)});
let clock=1000,ns=1000000000n,home,temporary,intentFile,mode,calls=0,completed=0;
const binding='c'.repeat(64),originalBigint=process.hrtime.bigint;
process.hrtime.bigint=()=>ns;
const custody=files=>new Map(files.map(file=>{const s=lstatSync(file,{bigint:true});assert.equal(s.nlink,1n);return [file,[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')]}));
globalThis.windowsWorkerPeer={
 scope:async()=>({temporary,binding,unchanged(){}}),
 home:()=>home,clock:{now:()=>clock},read:reader.readControllerToolFile,custody,
 recheck:(files,before)=>assert.deepEqual(custody(files),before),
 marker:marker.retainReleaseRoutingMarker,
 complete:async(...args)=>{completed++;await marker.retainCompletedReleaseRoutingRecord(...args);if(mode==='late-publication'){clock=2500;ns=2500000000n}},
 launch:async end=>{calls++;const intent=JSON.parse(await readFile(intentFile,'utf8'));assert.equal(String(end),intent.deadline_ns);
  const directory=path.join(home,'.pcn-'+binding.slice(0,32));await mkdir(directory,{mode:0o700});
  if(mode==='changed-intent'||mode==='restored-intent'){const bytes=await readFile(intentFile);await writeFile(intentFile,'changed');if(mode==='restored-intent'){await delay(5);await writeFile(intentFile,bytes)}}
  if(mode==='late-original'){clock=11000;ns=11000000000n}
  return {deadline:mode==='short'?5000:mode==='late-publication'?2000:mode==='wider-return'?50000:10000,directory,scope:'inert private settlement',authority:'none'};
 },
};
const routes={
 './release-hosted-native-bootstrap.mts':"export const hostedWindowsBootstrapExecutionAuthorized=true;export const readActualHostedWindowsBootstrapScope=globalThis.windowsWorkerPeer.scope;export const launchFixedHostedWindowsNativeJob=globalThis.windowsWorkerPeer.launch;export const readActualHostedLinuxBootstrapScope=()=>{throw Error('no Linux scope')};",
 'node:os':"export const homedir=globalThis.windowsWorkerPeer.home;",
 'node:perf_hooks':"export const performance=globalThis.windowsWorkerPeer.clock;",
 './release-controller-tools.mts':"export const readControllerToolFile=globalThis.windowsWorkerPeer.read;",
 './release-native-runtime-custody.mts':"export const inspectNativeRuntimeCustody=globalThis.windowsWorkerPeer.custody;export const recheckNativeRuntimeCustody=globalThis.windowsWorkerPeer.recheck;",
 './release-routing-marker.mts':"export const retainReleaseRoutingMarker=globalThis.windowsWorkerPeer.marker;export const retainCompletedReleaseRoutingRecord=globalThis.windowsWorkerPeer.complete;",
};
registerHooks({resolve(s,c,next){if(c.parentURL===entry&&routes[s])return {url:'windows-terminal:'+s,shortCircuit:true};return next(s,c)},load(u,c,next){if(u.startsWith('windows-terminal:'))return {format:'module',source:routes[u.slice('windows-terminal:'.length)],shortCircuit:true};return next(u,c)}});
const api=await import(entry);
try {
 for(const scenario of ['success','short','wider-return','expired','over-bound','malformed','platform','changed-intent','restored-intent','late-original','late-publication']){
  mode=scenario;clock=1000;ns=1000000000n;calls=completed=0;home=path.join(root,mode);temporary=path.join(home,'temporary');await mkdir(temporary,{mode:0o700,recursive:true});intentFile=path.join(temporary,'portcove-native-windows-workflow-start.json');
  const deadline=mode==='expired'?'999999999':mode==='over-bound'?'572000000000':mode==='malformed'?'010000000000':'10000000000';
  await writeFile(intentFile,JSON.stringify({schema_version:1,authority:'none',automatic_retry:false,binding,platform:mode==='platform'?'linux-x86_64':'windows-x86_64',deadline_ns:deadline}),{flag:'wx',mode:0o600});
  if(['success','short','wider-return'].includes(mode)){
   await api.superviseFixedHostedWindowsNativeJob();assert.equal(calls,1);assert.equal(completed,1);
   const value=JSON.parse(await readFile(path.join(home,'.pcn-'+binding.slice(0,32),'native-supervision-settlement.json'),'utf8'));
   assert.equal(value.deadline_ns,mode==='short'?'5000000000':'10000000000');assert.equal(value.native_acceptance,'not-established');
  } else {
   await assert.rejects(api.superviseFixedHostedWindowsNativeJob());
   const beforeLaunch=['expired','over-bound','malformed','platform'].includes(mode);assert.equal(calls,beforeLaunch?0:1);
   assert.equal(existsSync(path.join(temporary,'portcove-native-windows-workflow-refusal.json')),!beforeLaunch);
   assert.equal(completed,mode==='late-publication'?1:0);
   if(mode==='late-publication'){const value=JSON.parse(await readFile(path.join(home,'.pcn-'+binding.slice(0,32),'native-supervision-settlement.json'),'utf8'));assert.equal(value.exit_code,0);assert.equal(value.deadline_ns,'2000000000')}
  }
 }
} finally {process.hrtime.bigint=originalBigint}
console.log('11 original worker clock/intent/terminal controls passed with inert private peers; no native acceptance');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /11 original worker clock\/intent\/terminal controls passed/);
});

void test("Windows diagnostics retain only bounded public rows selected by the original binding", async (t) => {
  const { mkdir, writeFile, symlink } = await import("node:fs/promises");
  const { retainHostedNativeDiagnostics } = await import("./release-controller-diagnostics.mts");
  const root = disposableDirectory(t, path.join(os.tmpdir(), "windows-routing-diagnostics-"));
  const binding = "b".repeat(64),
    revision = "a".repeat(40);
  for (const mode of ["valid", "unbound", "escape", "foreign-run", "linked", "oversized"]) {
    const home = path.join(root, mode),
      temporary = path.join(home, "temporary");
    await mkdir(temporary, { recursive: true });
    const source = path.join(home, ".pcn-" + binding.slice(0, 32));
    const relative = "hosted-native-parent-Ab12Cd/windows-session/payload-signing/capture";
    await mkdir(path.join(source, relative), { recursive: true });
    const route = {
      run_id: mode === "foreign-run" ? "124" : "123",
      revision,
      run_attempt: 1,
      platform: "windows-x86_64",
      stage: "pre-sign",
      directory: mode === "escape" ? "../../private" : relative,
    };
    await writeFile(path.join(source, "windows-native-pre-sign-stage.json"), JSON.stringify(route));
    await writeFile(
      path.join(source, relative, "native-job-upload-request.json"),
      '{"authority":"none"}',
    );
    await writeFile(path.join(source, "private-key.json"), '"never-copy"');
    const clock = path.join(source, "portcove-native-job-clock.json");
    if (mode === "linked") await symlink(path.join(source, "private-key.json"), clock);
    else await writeFile(clock, mode === "oversized" ? "x".repeat(65537) : '{"authority":"none"}');
    await writeFile(
      path.join(temporary, "portcove-native-windows-workflow-refusal.json"),
      '{"recovery_required":true}',
    );
    const output = await retainHostedNativeDiagnostics(temporary, home, "123", revision, {
      platform: "windows-x86_64",
      ...(mode === "unbound" ? {} : { binding }),
    });
    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8")) as {
      authority: string;
      binding: string | null;
      files: { path: string; source: string }[];
      unavailable: { path: string; reason: string }[];
    };
    assert.equal(manifest.authority, "none");
    assert.equal(manifest.binding, mode === "unbound" ? null : binding);
    assert.equal(
      manifest.files.some(
        (row: { source: string }) => row.source === relative + "/native-job-upload-request.json",
      ),
      !["unbound", "escape", "foreign-run"].includes(mode),
    );
    assert.ok(
      manifest.files.some(
        (row: { source: string }) =>
          row.source === "temporary:portcove-native-windows-workflow-refusal.json",
      ),
    );
    if (["linked", "oversized"].includes(mode))
      assert.ok(
        manifest.unavailable.some(
          (row: { path: string; reason: string }) =>
            row.path === "portcove-native-job-clock.json" && row.reason === "unreadable-or-invalid",
        ),
      );
    for (const row of manifest.files)
      assert.ok(!(await readFile(path.join(output, row.path), "utf8")).includes("never-copy"));
    await assert.rejects(
      retainHostedNativeDiagnostics(temporary, home, "123", revision, {
        platform: "windows-x86_64",
        binding,
      }),
      { code: "EEXIST" },
    );
  }
});
