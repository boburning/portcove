/** Real bounded file rendezvous, controlled producer; no native acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { retainHostedNativeDiagnostics } from "./release-controller-diagnostics.mts";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  inspectNativeRuntimeSupport,
  nativeRuntimeSupport,
  windowsNativeRuntimeSupport,
} from "./release-native-runtime-support.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";
import {
  nativeOriginalJobDeadline,
  tufOriginalJobDeadline,
} from "./release-signing-job-budget.mts";
import { hostedNativeJobProfile } from "./assembler-job-identity.mts";
import { inspectControllerToolManifest } from "./release-controller-tools.mts";
import {
  inspectNativePostSignReadiness,
  waitForNativePostSignReadiness,
} from "./release-native-postsign-readiness.mts";

const prerequisiteJobs = (status = "completed", conclusion: string | null = "success") => ({
  total_count: 2,
  jobs: ["Sign admitted updater payloads", "Sign authenticated Timestamp metadata"].map(
    (name, index) => ({
      id: index + 1,
      run_id: 123,
      head_sha: "a".repeat(40),
      name,
      status,
      conclusion,
    }),
  ),
});
void test("post-sign scheduling refuses wrong source, partial inventory and terminal failed effects", () => {
  const check = (raw: unknown) => inspectNativePostSignReadiness(raw, "123", "a".repeat(40));
  assert.equal(
    check(prerequisiteJobs()).every((job) => job.status === "completed"),
    true,
  );
  assert.equal(
    check({ total_count: 1, jobs: [{ id: 99, name: "unrelated" }] }).every(
      (job) => job.status === "completed",
    ),
    false,
  );
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", null])
    assert.throws(() => check(prerequisiteJobs("completed", conclusion)));
  const foreign = prerequisiteJobs();
  foreign.jobs[0]!.head_sha = "b".repeat(40);
  assert.throws(() => check(foreign));
  const duplicate = prerequisiteJobs();
  duplicate.jobs.push(duplicate.jobs[0]!);
  duplicate.total_count++;
  assert.throws(() => check(duplicate));
  assert.throws(() => check({ ...prerequisiteJobs(), total_count: 3 }));
  for (const status of [["completed"], { toString: () => "completed" }, null, 1]) {
    const malformed = structuredClone(prerequisiteJobs());
    Object.assign(malformed.jobs[0]!, { status, conclusion: null });
    assert.throws(() => check(malformed));
  }
});
void test("post-sign waiting observes only pending reads, preserves evidence and never retries a refused read", async () => {
  let reads = 0,
    pauses = 0,
    active = true;
  const observations: unknown[] = [];
  const input = {
    run: "123",
    revision: "a".repeat(40),
    active: () => assert.ok(active, "original clock/owner expired"),
    read: () => (++reads === 1 ? prerequisiteJobs("in_progress", null) : prerequisiteJobs()),
    retain: async (value: unknown) => {
      observations.push(value);
    },
    pause: async () => {
      pauses++;
    },
  };
  assert.deepEqual(await waitForNativePostSignReadiness(input), {
    prerequisites_observed: true,
    authority: "none",
  });
  assert.equal(reads, 2);
  assert.equal(pauses, 1);
  assert.equal(observations.length, 2);
  reads = 0;
  await assert.rejects(
    waitForNativePostSignReadiness({
      ...input,
      read: () => {
        reads++;
        throw Error("ambiguous GET");
      },
    }),
    /ambiguous GET/u,
  );
  assert.equal(reads, 1);
  reads = 0;
  await assert.rejects(
    waitForNativePostSignReadiness({
      ...input,
      read: () => {
        reads++;
        return prerequisiteJobs("in_progress", null);
      },
      pause: async () => {
        active = false;
      },
    }),
    /original clock/u,
  );
  assert.equal(reads, 1);
  active = true;
  reads = 0;
  await assert.rejects(
    waitForNativePostSignReadiness({
      ...input,
      read: () => {
        reads++;
        return prerequisiteJobs("queued", null);
      },
      pause: async () => {},
    }),
    /observation bound exhausted/u,
  );
  assert.equal(reads, 120);
  reads = 0;
  const retainedBeforeExpiry = observations.length;
  await assert.rejects(
    waitForNativePostSignReadiness({
      ...input,
      read: () => {
        reads++;
        active = false;
        return prerequisiteJobs();
      },
    }),
    /original clock/u,
  );
  assert.equal(reads, 1);
  assert.equal(observations.length, retainedBeforeExpiry);
});

const preparedFixtureResult = path.join(
  process.env.RUNNER_TEMP ?? os.tmpdir(),
  "controller-tool-build-fixture/result.json",
);
void test("fixed native composite pins uploads and binds responses through environment only", () => {
  const body = readFileSync(
    new URL("../.github/actions/release-native-linux/action.yml", import.meta.url),
    "utf8",
  );
  assert.match(body, /actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9/u);
  for (const policy of [
    "overwrite: false",
    "retention-days: 7",
    "compression-level: 0",
    "if-no-files-found: error",
  ])
    assert.ok(body.includes(policy));
  for (const operation of ["start", "request", "ack", "settle"])
    assert.ok(
      body.includes(`release-hosted-native-workflow.mts ${operation} "$PORTCOVE_NATIVE_STAGE"`),
    );
  assert.match(
    body,
    /PORTCOVE_NATIVE_REQUEST_SHA256: \$\{\{ steps\.ready\.outputs\.request_sha256 \}\}/u,
  );
  assert.match(
    body,
    /PORTCOVE_NATIVE_ARTIFACT_ID: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/u,
  );
  assert.match(
    body,
    /PORTCOVE_NATIVE_ARTIFACT_SHA256: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/u,
  );
  assert.doesNotMatch(body, /continue-on-error|secrets\.|always\(\)/iu);
});

void test(
  "Linux workflow handoff keeps actual original process identity across both uploads and refuses drift",
  {
    timeout: 150000,
    skip: process.platform !== "linux" || process.getuid?.() === 0,
  },
  (t) => {
    const root = disposableDirectory(t, path.join(os.homedir(), ".native-workflow-handoff-"));
    chmodSync(root, 0o700);
    const entry = new URL("./release-hosted-native-workflow.mts", import.meta.url).href;
    const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {spawn} from 'node:child_process';import {appendFile,open,mkdir,writeFile,readFile,copyFile,chmod} from 'node:fs/promises';import {existsSync} from 'node:fs';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';import path from 'node:path';import {performance} from 'node:perf_hooks';import {setTimeout as delay} from 'node:timers/promises';
import {readProcessIdentity} from ${JSON.stringify(new URL("./heavy-rust-test-lock.mts", import.meta.url).href)};
import {readControllerToolFile} from ${JSON.stringify(new URL("./release-controller-tools.mts", import.meta.url).href)};
const root=process.argv[1],hash=b=>createHash('sha256').update(b).digest('hex'),identity={run_id:'123',run_attempt:1,controller_revision:'a'.repeat(40)};
let home,temporary,binding='fixed',deadline,child,birth,fault,tools,childClosed,killDuringRead=false,refusalDuringRead=false;
const fake=path.join(root,'inert-worker.mjs');
await writeFile(fake,${JSON.stringify(
      String.raw`
import {mkdir,writeFile,readFile,link} from 'node:fs/promises';import {existsSync} from 'node:fs';import {createHash} from 'node:crypto';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
setTimeout(()=>process.exit(2),30000).unref(); // Bound even a failed enclosing fixture's inert orphan.
const {readProcessIdentity}=await import(IDENTITY_MODULE);
const root=path.join(process.env.HOME,'.portcove-native-123-1-'+'a'.repeat(40)),fault=process.env.PORTCOVE_FIXTURE_FAULT,hash=b=>createHash('sha256').update(b).digest('hex');
const put=async(name,value)=>{const file=path.join(root,name),bytes=JSON.stringify({schema_version:1,authority:'none',...value});if(fault==='partial-records'&&(name==='portcove-native-job-clock.json'||name==='pre-sign-supervision-settlement.json')){await writeFile(file,'{',{flag:'wx',mode:0o600});await delay(200);await writeFile(file,bytes)}else await writeFile(file,bytes,{flag:'wx',mode:0o600})};
await mkdir(root,{mode:0o700});const now=process.hrtime.bigint();await put('portcove-native-job-clock.json',{binding:'fixed',started_ns:String(now),deadline_ns:String(now+30000000000n)});await put('native-supervision-started.json',{binding:'fixed',pid:process.pid,identity:readProcessIdentity(process.pid)});await put('pre-sign-launch.json',{operation:'pre-sign'});
for(const stage of ['pre-sign','post-sign']){
 if(stage==='post-sign')while(!existsSync(path.join(root,'native-post-start.json')))await delay(5);
 const directory=path.join(root,'portcove-native-linux-'+stage),publicRoot=path.join(directory,'public');await mkdir(directory,{mode:0o700});await mkdir(publicRoot,{mode:0o700});
 const files=[];for(const name of ['subject','report','capture','bundle']){const bytes=Buffer.from('{}'),file=path.join(publicRoot,name+'.json');await writeFile(file,bytes,{mode:0o600});files.push({path:file,bytes:bytes.length,sha256:hash(bytes)})}
 const ready=Buffer.from(JSON.stringify({schema_version:1,authority:'none',retention_days:7,overwrite:false,compression_level:0,name:'hosted-native-'+(stage==='pre-sign'?'payload-signing':'release-publication')+'-linux-x86_64-123-1',files})),readyFile=path.join(publicRoot,'native-upload-ready.json');await writeFile(readyFile,ready,{mode:0o600});
 const request=Buffer.from(JSON.stringify({schema_version:1,authority:'none',nonce:'1'.repeat(32),ready_file:readyFile,ready_sha256:hash(ready),deadline_ns:String(now+30000000000n)}));const pending=path.join(directory,'native-job-upload-request.retained');await writeFile(pending,request,{mode:0o600});await link(pending,path.join(directory,'native-job-upload-request.json'));
 const ackFile=path.join(directory,'native-job-upload-ack.json');while(!existsSync(ackFile))await delay(5);const ack=JSON.parse(await readFile(ackFile,'utf8'));if(ack.request_sha256!==hash(request)||ack.nonce!=='1'.repeat(32))throw Error('fixture ACK mismatch');
 await put(stage+'-supervision-settlement.json',{operation:stage,binding:'fixed',exit_code:0,recovery_required:false,supervisor_settled:true,registration_observed:true,tree_quiescent_observed:true,native_acceptance:'not-established'});
 if(stage==='pre-sign'){const marker=path.join(root,'native-pre-sign-handoff-ready.retained');await writeFile(marker,JSON.stringify({schema_version:1,authority:'none',binding:'fixed'}),{mode:0o600});await link(marker,path.join(root,'native-pre-sign-handoff-ready.json'))}
}
if(fault!=='missing-final')await put('native-supervision-settlement.json',{binding:'fixed',exit_code:0,recovery_required:false,phase:'complete',pre_sign_complete:true,post_sign_complete:true,native_acceptance:'not-established'});
`.replace(
        "IDENTITY_MODULE",
        JSON.stringify(new URL("./heavy-rust-test-lock.mts", import.meta.url).href),
      ),
    )},{mode:0o600});
globalThis.workflowFixture={fault:()=>fault,scope:async()=>({identity,binding,temporary,artifact:{fixture:true},bundle:{fixture:true},unchanged(){}}),budget:()=>deadline,appendFile,mkdir,open:async(...args)=>{const handle=await open(...args);if(!args[0].endsWith('native-post-sign-prerequisites.jsonl'))return handle;return {writeFile:b=>handle.writeFile(b),sync:()=>handle.sync(),close:async()=>{await handle.close();if(fault==='dies-during-prerequisite-close'){child.ref();child.kill('SIGKILL');await childClosed}}}},read:async(file,maximum)=>{const bytes=await readControllerToolFile(file,maximum);if(refusalDuringRead&&file.endsWith('portcove-native-job-clock.json')){refusalDuringRead=false;await writeFile(path.join(path.dirname(file),'pre-sign-supervision-refusal.json'),JSON.stringify({schema_version:1,authority:'none',recovery_required:true}),{mode:0o600})}if(killDuringRead&&file.endsWith('portcove-native-job-clock.json')){killDuringRead=false;child.ref();child.kill('SIGKILL');await childClosed}return bytes},
receive:async root=>{await mkdir(path.join(root,'bin'),{mode:0o700});await mkdir(path.join(root,'scripts'),{mode:0o700});const node=path.join(root,'bin/node'),worker=path.join(root,'scripts/release-hosted-native-worker.bundle.mjs');await copyFile(process.execPath,node);await chmod(node,fault==='shared-node'?0o722:0o700);await copyFile(fake,worker);await chmod(worker,0o600);await writeFile(path.join(root,'manifest.json'),'{}',{mode:0o600});tools={root,node,entries:{'release-hosted-native-worker':worker}};return tools},verify:async receipt=>{assert.equal(receipt,tools);return tools},
spawn(command,args,options){assert.equal(command,tools.node);assert.equal(args[0],tools.entries['release-hosted-native-worker']);assert.deepEqual(args.slice(1),['run']);assert.equal(options.stdio,'ignore');child=spawn(command,args,options);childClosed=new Promise(resolve=>child.once('close',resolve));birth=readProcessIdentity(child.pid);return child}};
const routes={'node:fs/promises':'fs','./github-api.mts':'github','./release-signing-job-budget.mts':'budget','./release-controller-tool-admission.mts':'tools','./release-controller-tools.mts':'read','node:child_process':'spawn'};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(entry)}&&routes[s])return {url:'workflow:'+routes[s],shortCircuit:true};if((c.parentURL===${JSON.stringify(entry)}||c.parentURL===${JSON.stringify(new URL("./release-hosted-native-worker.mts", import.meta.url).href)})&&s==='./release-hosted-native-bootstrap.mts')return {url:'workflow:scope',shortCircuit:true};return next(s,c)},load(u,c,next){if(u.startsWith('workflow:'))return {format:'module',source:u==='workflow:fs'?'export const appendFile=globalThis.workflowFixture.appendFile;export const mkdir=globalThis.workflowFixture.mkdir;export const open=globalThis.workflowFixture.open;':u==='workflow:github'?'export class GitHubApiClient {request(method,endpoint){if(method!=="GET"||endpoint!=="repos/boburning/portcove/actions/runs/123/attempts/1/jobs?per_page=100")throw Error("wrong fixed read");if(globalThis.workflowFixture.fault()==="prerequisite-ambiguous")throw Error("ambiguous GET");return {status:200,headers:new Map(),body:{total_count:2,jobs:["Sign admitted updater payloads","Sign authenticated Timestamp metadata"].map((name,i)=>({id:i+1,run_id:123,head_sha:"a".repeat(40),name,status:"completed",conclusion:globalThis.workflowFixture.fault()==="prerequisite-failed"?"failure":"success"}))}}}};export const createGitHubRunner=()=>()=>{};':u==='workflow:budget'?'export const currentNativeJobDeadline=globalThis.workflowFixture.budget;':u==='workflow:scope'?'export const readActualHostedLinuxBootstrapScope=globalThis.workflowFixture.scope;':u==='workflow:tools'?'export const receiveControllerTools=globalThis.workflowFixture.receive;export const verifiedControllerToolPaths=globalThis.workflowFixture.verify;':u==='workflow:read'?'export const readControllerToolFile=globalThis.workflowFixture.read;export const controllerToolPaths=["bin/node","scripts/release-hosted-native-worker.bundle.mjs"];':'export const spawn=globalThis.workflowFixture.spawn;',shortCircuit:true};return next(u,c)}});
const api=await import(${JSON.stringify(entry)});
for(const name of ['valid','prerequisite-failed','prerequisite-ambiguous','dies-during-prerequisite-close','partial-records','shared-node','late-refusal','dies-during-clock','wrong-owner','changed-binding','expired-clock','retained-refusal','missing-final']){
 process.stderr.write('workflow-fixture:'+name+'\n');fault=name;child=undefined;killDuringRead=false;refusalDuringRead=false;process.env.PORTCOVE_FIXTURE_FAULT=name;binding='fixed';home=path.join(root,name);temporary=path.join(home,'temp');await mkdir(home,{mode:0o700});await mkdir(temporary,{mode:0o700});process.env.HOME=home;deadline=performance.now()+30000;
 try{
  if(name==='shared-node'){await assert.rejects(api.startHostedLinuxWorkflow());assert.equal(child,undefined);assert.equal(existsSync(path.join(temporary,'portcove-native-workflow-start.json')),true);continue}
  await api.startHostedLinuxWorkflow();await assert.rejects(api.startHostedLinuxWorkflow(),{code:'EEXIST'});
  const request=await api.hostedLinuxWorkflowUploadRequest('pre-sign'),directory=path.join(home,'.portcove-native-123-1-'+'a'.repeat(40));
  if(name==='late-refusal'){refusalDuringRead=true;await assert.rejects(api.hostedLinuxWorkflowUploadRequest('pre-sign'),/retained native refusal/);continue}
  if(name==='dies-during-clock'){killDuringRead=true;await assert.rejects(api.hostedLinuxWorkflowUploadRequest('pre-sign'),/unavailable after readback/);continue}
  if(name==='wrong-owner'){const started=path.join(temporary,'portcove-native-workflow-started.json');const value=JSON.parse(await readFile(started,'utf8'));await writeFile(started,JSON.stringify({...value,pid:process.pid,identity:readProcessIdentity(process.pid)}));await assert.rejects(api.hostedLinuxWorkflowUploadRequest('pre-sign'));continue}
  if(name==='changed-binding'){binding='changed';await assert.rejects(api.hostedLinuxWorkflowUploadRequest('pre-sign'));continue}
  if(name==='expired-clock'){const file=path.join(directory,'portcove-native-job-clock.json'),clock=JSON.parse(await readFile(file,'utf8'));await writeFile(file,JSON.stringify({...clock,deadline_ns:clock.started_ns}));await assert.rejects(api.hostedLinuxWorkflowUploadRequest('pre-sign'));continue}
  if(name==='retained-refusal'){await writeFile(path.join(directory,'pre-sign-supervision-refusal.json'),JSON.stringify({schema_version:1,authority:'none',recovery_required:true}));await assert.rejects(api.hostedLinuxWorkflowUploadRequest('pre-sign'));continue}
  await assert.rejects(api.acknowledgeHostedLinuxWorkflowUpload('pre-sign','f'.repeat(64),'11','b'.repeat(64)));assert.equal(existsSync(path.join(directory,'portcove-native-linux-pre-sign/native-job-upload-ack.json')),false);
  await api.acknowledgeHostedLinuxWorkflowUpload('pre-sign',request.request_sha256,'11','b'.repeat(64));await api.settleHostedLinuxWorkflowStage('pre-sign');if(name==='prerequisite-failed'||name==='prerequisite-ambiguous'){await assert.rejects(api.startHostedLinuxWorkflowPostSign());assert.equal(existsSync(path.join(directory,'native-post-start.json')),false);const log=await readFile(path.join(directory,'native-post-sign-prerequisites.jsonl'),'utf8');assert.match(log,/refused-or-ambiguous/);assert.match(log,/recovery_required/);await assert.rejects(api.startHostedLinuxWorkflowPostSign(),{code:'EEXIST'});continue}if(name==='dies-during-prerequisite-close'){await assert.rejects(api.startHostedLinuxWorkflowPostSign(),/unavailable after readback/);assert.equal(existsSync(path.join(directory,'native-post-start.json')),false);assert.equal(existsSync(path.join(directory,'native-post-sign-prerequisites.jsonl')),true);continue}await api.startHostedLinuxWorkflowPostSign();await assert.rejects(api.startHostedLinuxWorkflowPostSign(),{code:'EEXIST'});
  const post=await api.hostedLinuxWorkflowUploadRequest('post-sign');await api.acknowledgeHostedLinuxWorkflowUpload('post-sign',post.request_sha256,'12','c'.repeat(64));
  if(name==='missing-final')await assert.rejects(api.settleHostedLinuxWorkflowStage('post-sign'));else {const result=await api.settleHostedLinuxWorkflowStage('post-sign');assert.equal(result.native_acceptance,'not-established');assert.equal(readProcessIdentity(child.pid),null)}
 }finally{if(child&&readProcessIdentity(child.pid)===birth){child.ref();child.kill('SIGKILL');await childClosed}}
}
console.log('actual file/PID workflow rendezvous passed; source, native worker and provider peers controlled');
`;
    const childStarted = performance.now();
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 65536,
    });
    assert.equal(
      result.status,
      0,
      JSON.stringify({
        error_code: result.error && "code" in result.error ? result.error.code : null,
        error: result.error?.message,
        signal: result.signal,
        elapsed_milliseconds: Math.round(performance.now() - childStarted),
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    );
    assert.match(result.stdout, /actual file\/PID workflow rendezvous passed/u);
  },
);

void test(
  "actual prepared reaper supervises both fixed children and closes detached descendants or timeout",
  {
    skip:
      process.platform !== "linux" ||
      process.getuid?.() === 0 ||
      !existsSync(preparedFixtureResult),
  },
  (t) => {
    const resultBytes = readFileSync(preparedFixtureResult);
    assert.ok(resultBytes.length <= 65536);
    const result = JSON.parse(resultBytes.toString("utf8")) as {
      status: string;
      built_directory: string;
      source: { commit: string; tree: string };
    };
    assert.equal(result.status, "pass");
    assert.equal(
      path.dirname(result.built_directory),
      path.join(path.dirname(preparedFixtureResult), "build-work"),
    );
    assert.match(path.basename(result.built_directory), /^controller-tool-build-[A-Za-z0-9]{6}$/u);
    const builtTools = path.join(result.built_directory, "tools"),
      manifestBytes = readFileSync(path.join(builtTools, "manifest.json"));
    assert.ok(manifestBytes.length <= 65536);
    const manifest = inspectControllerToolManifest(JSON.parse(manifestBytes.toString("utf8")));
    assert.equal(manifest.source_commit, result.source.commit);
    assert.equal(manifest.source_tree, result.source.tree);
    const root = disposableDirectory(t, path.join(os.homedir(), ".native-supervision-reaper-"));
    chmodSync(root, 0o700);
    const tools = path.join(root, "prepared");
    mkdirSync(tools, { mode: 0o700 });
    for (const name of [
      "bin/node",
      nativeRuntimeSupport.binary,
      nativeRuntimeSupport.metadata,
      nativeRuntimeSupport.source,
      "scripts/rust-test-tree-supervisor.mts",
    ]) {
      const file = manifest.files.find((file) => file.path === name);
      assert.ok(file);
      const bytes = readFileSync(path.join(builtTools, name));
      assert.equal(bytes.length, file.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
      const output = path.join(tools, name);
      mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      writeFileSync(output, bytes, { mode: name.startsWith("bin/") ? 0o700 : 0o600 });
    }
    const entry = new URL("./release-hosted-native-worker.mts", import.meta.url).href;
    const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {mkdir,writeFile,readFile} from 'node:fs/promises';import {existsSync} from 'node:fs';import path from 'node:path';import {performance} from 'node:perf_hooks';import {setTimeout as delay} from 'node:timers/promises';
import {inspectNativeRuntimeCustody,recheckNativeRuntimeCustody} from ${JSON.stringify(new URL("./release-native-runtime-custody.mts", import.meta.url).href)};
import {readProcessIdentity} from ${JSON.stringify(new URL("./heavy-rust-test-lock.mts", import.meta.url).href)};
const root=process.argv[1],tools=path.join(root,'prepared'),node=path.join(tools,'bin/node'),original=inspectNativeRuntimeCustody([node,path.join(tools,'bin/native-linux-tree-reaper'),path.join(tools,'scripts/rust-test-tree-supervisor.mts')]);
let directory,deadline,stopped=false,registrations=0,releases=0;const plans=new WeakSet();
globalThis.reaperFixture={
 prepare:async operation=>{const plan={operation,binding:'fixed',temporary:directory,command:node,arguments:[path.join(directory,'fixed-bootstrap.mjs'),operation]};await writeFile(path.join(directory,operation+'-launch.json'),JSON.stringify(plan),{flag:'wx',mode:0o600});if(operation==='pre-sign'){const now=process.hrtime.bigint();await writeFile(path.join(directory,'portcove-native-job-clock.json'),JSON.stringify({schema_version:1,binding:'fixed',started_ns:String(now),deadline_ns:String(now+BigInt(Math.max(1,Math.floor(deadline-performance.now())))*1000000n),authority:'none'}),{flag:'wx',mode:0o600})}plans.add(plan);return Object.freeze(plan)},
 claim:async plan=>{assert.ok(plans.has(plan));return {tools_root:tools,deadline,recheck(){assert.ok(!stopped&&performance.now()<deadline,'original source clock expired');recheckNativeRuntimeCustody([...original.keys()].filter(file=>file.endsWith('/node')||file.endsWith('/native-linux-tree-reaper')||file.endsWith('/rust-test-tree-supervisor.mts')),original)},refuse(){stopped=true}}},
 scope:async()=>({identity:{run_id:'123',run_attempt:1,controller_revision:'a'.repeat(40)},binding:'fixed',unchanged(){assert.ok(!stopped)}}),
 resource:async(profile,command,args,options)=>{assert.equal(profile,'analysis');return options.supervise(['--guard-command',command,...args],{environment:options.environment,cwd:options.cwd,acquireLock:async()=>({inherited:false,childEnvironment:{},registerChild:async child=>{assert.ok(child.pid>1);registrations++;return {}},release:async()=>{releases++}})})}
};
const routes={'./release-hosted-native-launcher.mts':{prepareFixedHostedLinuxLaunch:'prepare',claimPreparedHostedLinuxLaunch:'claim'},'./release-hosted-native-bootstrap.mts':{readActualHostedLinuxBootstrapScope:'scope'},'./resource-command.mts':{runResourceCommand:'resource'}};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(entry)}&&routes[s])return {url:'actual-reaper:'+s,shortCircuit:true};return next(s,c)},load(u,c,next){if(u.startsWith('actual-reaper:'))return {format:'module',source:Object.entries(routes[u.slice('actual-reaper:'.length)]).map(([name,key])=>'export const '+name+'=globalThis.reaperFixture.'+key+';').join('\n'),shortCircuit:true};return next(u,c)}});
const api=await import(${JSON.stringify(entry)});
for(const name of ['valid','detached','timeout']){
 const home=path.join(root,name);await mkdir(home,{mode:0o700});process.env.HOME=home;directory=path.join(home,'.portcove-native-123-1-'+'a'.repeat(40));await mkdir(directory,{mode:0o700});stopped=false;registrations=0;releases=0;
 const childSource=name==='timeout'?'setInterval(()=>{},1000);':name==='detached'?'import {spawn} from "node:child_process";import {writeFileSync,existsSync} from "node:fs";const child=spawn(process.execPath,[new URL("./fixed-detached.mjs",import.meta.url).pathname,new URL("./orphan-grand-"+process.argv[2]+".pid",import.meta.url).pathname],{detached:true,stdio:"ignore"});writeFileSync(new URL("./orphan-"+process.argv[2]+".pid",import.meta.url),String(child.pid));child.unref();while(!existsSync(new URL("./orphan-grand-"+process.argv[2]+".pid",import.meta.url)))await new Promise(resolve=>setTimeout(resolve,10));console.log("inert child completed");':'console.log("inert fixed child completed");';
 await writeFile(path.join(directory,'fixed-detached.mjs'),'import {spawn} from "node:child_process";import {writeFileSync} from "node:fs";const grand=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});writeFileSync(process.argv[2],String(grand.pid));grand.unref();setInterval(()=>{},1000);',{mode:0o600});
 await writeFile(path.join(directory,'fixed-bootstrap.mjs'),childSource,{mode:0o600});deadline=performance.now()+(name==='timeout'?2000:15000);
 let done=false;const outcome=api.superviseFixedHostedLinuxNativeStages().then(value=>({value}),error=>({error})).finally(()=>{done=true});
 if(name!=='timeout'){
   const ready=path.join(directory,'pre-sign-supervision-settlement.json');for(let i=0;i<4000&&!existsSync(ready)&&!done;i++)await delay(2);
   assert.ok(existsSync(ready));const preRow=JSON.parse(await readFile(ready,'utf8'));assert.equal(preRow.exit_code,0,JSON.stringify({name,preRow,stderr:(await readFile(path.join(directory,'pre-sign-worker.stderr.bin'),'utf8')).slice(0,8192)}));await api.signalFixedHostedLinuxPostStart();
 }
 const observed=await outcome,final=JSON.parse(await readFile(path.join(directory,'native-supervision-settlement.json'),'utf8'));
 if(name==='timeout'){assert.ok(observed.error);assert.equal(final.recovery_required,true);assert.equal(final.post_sign_complete,false)}else {assert.ok(!observed.error,observed.error?.stack);assert.equal(final.post_sign_complete,true)}
 for(const operation of name==='timeout'?['pre-sign']:['pre-sign','post-sign']){
   const cleanup=JSON.parse(await readFile(path.join(directory,operation+'-tree-cleanup.json'),'utf8'));assert.equal(cleanup.outcome,'quiescent');
   const row=JSON.parse(await readFile(path.join(directory,operation+'-supervision-settlement.json'),'utf8'));assert.equal(row.tree_quiescent_observed,true);
   if(name==='detached'){const pid=Number(await readFile(path.join(directory,'orphan-'+operation+'.pid'),'utf8'));assert.equal(readProcessIdentity(pid),null,'detached descendant survived adopting reaper cleanup');const grandPid=Number(await readFile(path.join(directory,'orphan-grand-'+operation+'.pid'),'utf8'));assert.equal(readProcessIdentity(grandPid),null,'detached grandchild survived adopting reaper cleanup')}
 }
 assert.equal(registrations,name==='timeout'?1:2);assert.equal(releases,registrations);
}
console.log('actual prepared adopting reaper two-stage, detached-descendant and timeout closure passed; source/resource admission peers controlled');
`;
    const resultChild = spawnSync(
      path.join(tools, "bin/node"),
      ["--input-type=module", "--eval", code, root],
      {
        encoding: "utf8",
        timeout: 40000,
        maxBuffer: 65536,
        env: { PATH: "/usr/bin:/bin", HOME: root, RUNNER_TEMP: root },
      },
    );
    assert.equal(resultChild.status, 0, `${resultChild.stdout}\n${resultChild.stderr}`);
    assert.match(resultChild.stdout, /actual prepared adopting reaper two-stage/u);
  },
);

void test("fixed native supervisor retains output refusal, bounded reads and late durable outcomes", (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "native-supervision-contract-"));
  const entry = new URL("./release-hosted-native-worker.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import * as fs from 'node:fs';import * as fsp from 'node:fs/promises';
import {EventEmitter} from 'node:events';import path from 'node:path';import {fileURLToPath} from 'node:url';import {performance} from 'node:perf_hooks';import {setTimeout as delay} from 'node:timers/promises';import {createHash} from 'node:crypto';
import {rustSupportInputIdentity} from ${JSON.stringify(new URL("./rust-support-cache.mts", import.meta.url).href)};
const root=process.argv[1],sourceRoot=fileURLToPath(new URL('../',${JSON.stringify(entry)})),hash=b=>createHash('sha256').update(b).digest('hex');
let clock=1000,fault='',directory,tools,deadline,stopped=false,spawns=0,reads=[],done=false,identityAvailable=true;const plans=new WeakSet();
function custody(files){return new Map(files.map(file=>{const s=fs.lstatSync(file,{bigint:true});return [file,[s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':')]}))}
globalThis.supervisionFixture={
 now:()=>{if(fault==='missing-post'&&directory&&fs.existsSync(path.join(directory,'pre-sign-supervision-settlement.json')))clock+=25;return clock},performance:{now:()=>globalThis.supervisionFixture.now()},
 prepare:async operation=>{const plan={operation,binding:'fixed',temporary:directory,command:path.join(directory,'private-node'),arguments:[path.join(directory,'fixed-bootstrap.mjs'),operation]};await fsp.writeFile(path.join(directory,operation+'-launch.json'),JSON.stringify(plan),{flag:'wx'});if(operation==='pre-sign'){const now=process.hrtime.bigint();await fsp.writeFile(path.join(directory,'portcove-native-job-clock.json'),JSON.stringify({schema_version:1,binding:'fixed',started_ns:String(now),deadline_ns:String(now+60000000000n),authority:'none'}),{flag:'wx'})}plans.add(plan);return Object.freeze(plan)},
 claim:async plan=>{assert.ok(plans.has(plan));return {tools_root:tools,deadline,recheck(){assert.ok(!stopped&&identityAvailable&&globalThis.supervisionFixture.now()<deadline,'original owner or clock unavailable')},refuse(){stopped=true}}},
 scope:async()=>{const frozenDirectory=directory;return {identity:{run_id:'123',run_attempt:1,controller_revision:'a'.repeat(40)},binding:'fixed',unchanged(){assert.equal(directory,frozenDirectory,'fixed fixture source changed')}}},
 identity:()=> identityAvailable?'fixture-owned-process':null,custody,recheck:(files,before)=>assert.deepEqual(custody(files),before),
 open:async file=>{const handle=await fsp.open(file,'wx',0o600);return {writeFile:async bytes=>{if(fault==='lost-supervisor'&&file.endsWith('native-post-start.json'))identityAvailable=false;await handle.writeFile(bytes);if((fault==='late-stage'&&file.endsWith('pre-sign-supervision-settlement.json'))||(fault==='late-final'&&file.endsWith('native-supervision-settlement.json'))){clock=deadline+1;await delay(0)};if(fault==='lost-supervisor'&&file.endsWith('native-post-start.json')){await delay(25)}},sync:()=>handle.sync(),close:()=>handle.close()}},
 resource:async(profile,command,args,options)=>{assert.equal(profile,'analysis');assert.ok(options.queueDeadline===deadline);return options.supervise(['--guard-command',command,...args],{})},
 inspect:(raw,pid)=>{assert.equal(raw.fixture,true);assert.equal(pid,12345);return {pid:12346}},
 spawn:()=>{spawns++;const child=new EventEmitter();child.pid=12345;child.stdout=new EventEmitter();child.stderr=new EventEmitter();return child},
 run:async(args,options)=>{
   const operation=args.at(-1),folder=path.join(directory,'portcove-host-tool-fixture-'+(operation==='pre-sign'?'ABCDEF':'GHIJKL'));await fsp.mkdir(folder,{mode:0o700});
   const command=path.join(folder,'portcove-linux-process-tree-reaper');await fsp.copyFile(path.join(tools,'bin/native-linux-tree-reaper'),command);
   assert.equal(options.rustSupportCompilerIdentity().sysroot,'/build-only');
   const argv=['gate','status','cleanup','registration','parent',process.execPath,path.join(sourceRoot,'scripts/rust-test-tree-supervisor.mts'),args[1],args[2],operation];
   const child=options.spawn(command,argv,{cwd:sourceRoot});
   const registration=path.join(folder,'registration.json'),cleanup=path.join(folder,'containment-cleanup.json');await fsp.writeFile(registration,fault==='oversized-registration'?'x'.repeat(8193):JSON.stringify({fixture:true}));
   try {
     options.readLinuxSupervisor(registration,child);
     child.stdout.emit('data',Buffer.from(fault==='overflow'?'x'.repeat(1024*1024+1):'bounded fixture output'));
     return fault==='overflow'?143:0;
   } finally {await fsp.writeFile(cleanup,JSON.stringify({outcome:'quiescent'}));options.readCleanupReceipt(cleanup)}
 },
 fs:{...fs,readSync:(fd,bytes,offset,length,position)=>{reads.push(length);return fs.readSync(fd,bytes,offset,length,position)}}
};
const routes={'node:perf_hooks':'clock','./release-hosted-native-launcher.mts':'launcher','./release-hosted-native-bootstrap.mts':'scope','./resource-command.mts':'resource','./run-rust-tests.mts':'run','./release-native-runtime-custody.mts':'custody','./heavy-rust-test-lock.mts':'identity','node:child_process':'spawn','node:fs/promises':'open','node:fs':'fs'};
const exports={clock:{performance:'performance'},launcher:{prepareFixedHostedLinuxLaunch:'prepare',claimPreparedHostedLinuxLaunch:'claim'},scope:{readActualHostedLinuxBootstrapScope:'scope'},resource:{runResourceCommand:'resource'},run:{runRustTests:'run',inspectLinuxSupervisor:'inspect'},custody:{inspectNativeRuntimeCustody:'custody',recheckNativeRuntimeCustody:'recheck'},identity:{readProcessIdentity:'identity'},spawn:{spawn:'spawn'},open:{open:'open'}};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(entry)}&&routes[s])return {url:'supervision:'+routes[s],shortCircuit:true};return next(s,c)},load(u,c,next){if(u==='supervision:fs')return {format:'module',source:['closeSync','constants','fstatSync','fsyncSync','openSync','readSync','writeFileSync','writeSync'].map(name=>'export const '+name+'=globalThis.supervisionFixture.fs.'+name+';').join('\n'),shortCircuit:true};if(u.startsWith('supervision:'))return {format:'module',source:Object.entries(exports[u.slice('supervision:'.length)]).map(([name,key])=>'export const '+name+'=globalThis.supervisionFixture.'+key+';').join('\n'),shortCircuit:true};return next(u,c)}});
const api=await import(${JSON.stringify(entry)});
for(const name of ['valid','overflow','oversized-registration','missing-post','bad-post','lost-supervisor','late-stage','late-final']){
 fault=name;clock=1000;stopped=false;spawns=0;reads=[];done=false;identityAvailable=true;
 const home=path.join(root,name);await fsp.mkdir(home);process.env.HOME=home;
 directory=path.join(home,'.portcove-native-123-1-'+'a'.repeat(40));await fsp.mkdir(directory);
 tools=path.join(directory,'tools');await fsp.mkdir(path.join(tools,'scripts/fixtures'),{recursive:true});await fsp.mkdir(path.join(tools,'bin'));
 const source=Buffer.from('fixed fixture support'),binary=Buffer.alloc(64);binary.set([127,69,76,70,2,1]);binary.writeUInt16LE(62,18);
 const sourceFile=path.join(tools,'scripts/fixtures/linux-process-tree-reaper.rs.txt');await fsp.writeFile(sourceFile,source);await fsp.writeFile(path.join(tools,'bin/native-linux-tree-reaper'),binary);
 const compiler={verbose_version:'fixture build',sysroot:'/build-only',commands:[{command:'rustc',resolved:null}],environment:[]};
 const input=rustSupportInputIdentity({product:'linux-process-tree-reaper',source:sourceFile,compiler,rustcArgs:['--edition=2024','--crate-name','portcove_linux_process_tree_reaper'],platform:'linux',architecture:'x64'});
 await fsp.writeFile(path.join(tools,'native-linux-support.json'),JSON.stringify({schema_version:1,product:'linux-process-tree-reaper',platform:'linux-x86_64',compiler,input_fingerprint:input.fingerprint,rustc_arguments:['--edition=2024','--crate-name','portcove_linux_process_tree_reaper'],source:{bytes:source.length,sha256:hash(source)},output:{bytes:64,sha256:hash(binary),mode:448}}));
 deadline=clock+(name==='missing-post'?150:1000);
 const outcome=api.superviseFixedHostedLinuxNativeStages().then(value=>({value}),error=>({error})).finally(()=>{done=true});
 if(['valid','bad-post','lost-supervisor','late-final'].includes(name)){
  const ready=path.join(directory,'pre-sign-supervision-settlement.json');let complete=false;for(let i=0;i<1000&&!complete&&!done;i++){try{JSON.parse(await fsp.readFile(ready,'utf8'));complete=true}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error}if(!complete)await delay(2)}
  assert.ok(complete,'fixture must await completed settlement bytes before signaling');
  if(name==='bad-post')await fsp.writeFile(path.join(directory,'native-post-start.json'),'{}');else if(name==='lost-supervisor'){await assert.rejects(api.signalFixedHostedLinuxPostStart(),/supervisor is unavailable/);stopped=true;assert.ok(fs.existsSync(path.join(directory,'native-post-start.json')))}else await api.signalFixedHostedLinuxPostStart();
 }
 const result=await outcome,final=JSON.parse(await fsp.readFile(path.join(directory,'native-supervision-settlement.json'),'utf8'));
 if(name==='valid'){assert.ok(!result.error,result.error?.stack);assert.equal(spawns,2);assert.equal(final.exit_code,0);assert.equal(final.post_sign_complete,true)}
 else {assert.ok(result.error,name);if(name==='late-final'){assert.equal(final.exit_code,0);assert.equal(JSON.parse(await fsp.readFile(path.join(directory,'native-supervision-refusal.json'),'utf8')).recovery_required,true)}else assert.equal(final.recovery_required,true)}
 if(name==='lost-supervisor'){assert.equal(identityAvailable,false);assert.equal(spawns,1);assert.equal(final.post_sign_complete,false)}
 if(name==='late-stage'){const partial=JSON.parse(await fsp.readFile(path.join(directory,'pre-sign-supervision-settlement.json'),'utf8'));assert.equal(partial.exit_code,0);assert.equal(JSON.parse(await fsp.readFile(path.join(directory,'pre-sign-supervision-refusal.json'),'utf8')).recovery_required,true)}
 if(name==='overflow'){assert.equal((await fsp.stat(path.join(directory,'pre-sign-worker.stdout.bin'))).size,1024*1024);const row=JSON.parse(await fsp.readFile(path.join(directory,'pre-sign-supervision-settlement.json'),'utf8'));assert.equal(row.streams.stdout.observed_bytes,1024*1024+1);assert.equal(row.streams.stdout.truncated,true)}
 if(name==='oversized-registration')assert.ok(reads.includes(8193));
}
console.log('controlled supervisor bounds and late partial outcomes passed; process/provider peers remain controlled');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 65536,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /controlled supervisor bounds/u);
});

void test(
  "Linux private launch preparation preserves original Node identity and partial effects without spawning a worker",
  { timeout: 150000, skip: process.platform !== "linux" || process.getuid?.() === 0 },
  (t) => {
    const root = disposableDirectory(t, path.join(os.homedir(), ".native-launch-preparation-"));
    chmodSync(root, 0o700);
    const entry = new URL("./release-hosted-native-launcher.mts", import.meta.url).href;
    const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';
import {mkdir,writeFile,readFile,copyFile,chmod,rename,symlink,lstat,readdir} from 'node:fs/promises';
import path from 'node:path';import {performance} from 'node:perf_hooks';
const root=process.argv[1], identity={controller_revision:'a'.repeat(40),controller_ref:'refs/tags/fixed-fixture',run_id:'123',run_attempt:1};
let binding='fixed',fault='',checks=0,receives=0;const token={},actualTools=await import(${JSON.stringify(new URL("./release-controller-tools.mts", import.meta.url).href)});let tools;
globalThis.launchFixture={
scope:async operation=>{assert.ok(['pre-sign','post-sign'].includes(operation));if(fault==='source')throw Error('source refused');return {operation,identity,binding,artifact:{expected:'fixed source'},bundle:{expected:'fixed issuer'},unchanged(){checks++;if(fault==='changed')throw Error('changed source')}}},
clock:()=>{if(fault==='provider')throw Error('provider refused');return performance.now()+(fault==='expired'?-1:570000)},
receive:async(root,artifact,bundle,options)=>{receives++;assert.deepEqual(artifact,{expected:'fixed source'});assert.deepEqual(bundle,{expected:'fixed issuer'});assert.ok(options.deadline>performance.now());if(fault==='foreign-tools')throw Error('foreign issuer');tools=path.join(root,'authenticated-tools');await mkdir(tools,{mode:0o700});await copyFile(process.execPath,path.join(tools,'verified-node'));await chmod(path.join(tools,'verified-node'),0o700);await writeFile(path.join(tools,'manifest.json'),'{}',{mode:0o600});return token},
paths:async receipt=>{assert.equal(receipt,token);return {root:tools,node:path.join(tools,'verified-node'),identity:{expected:'fixed source'}}},
read:async(...args)=>{assert.notEqual(args[0],process.execPath,'a shared source-path replacement must never choose executable bytes');return actualTools.readControllerToolFile(...args)}
};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(entry)}){if(s==='./release-hosted-native-bootstrap.mts')return {url:'launch:scope',shortCircuit:true};if(s==='./release-signing-job-budget.mts')return {url:'launch:clock',shortCircuit:true};if(s==='./release-controller-tool-admission.mts')return {url:'launch:tools',shortCircuit:true};if(s==='./release-controller-tools.mts')return {url:'launch:files',shortCircuit:true}}return next(s,c)},load(u,c,next){if(u==='launch:scope')return {format:'module',source:'export const readActualHostedLinuxBootstrapScope=globalThis.launchFixture.scope;',shortCircuit:true};if(u==='launch:clock')return {format:'module',source:'export const currentNativeJobDeadline=globalThis.launchFixture.clock;',shortCircuit:true};if(u==='launch:tools')return {format:'module',source:'export const receiveControllerTools=globalThis.launchFixture.receive;export const verifiedControllerToolPaths=globalThis.launchFixture.paths;',shortCircuit:true};if(u==='launch:files')return {format:'module',source:'export const controllerToolPaths=["verified-node"];export const readControllerToolFile=globalThis.launchFixture.read;',shortCircuit:true};return next(u,c)}});
const api=await import(${JSON.stringify(entry)});
for(const name of ['valid','foreign-tools','missing-pre','replay','binding','replaced','bytes','writable','linked','source','provider','expired','changed','occupied']){
process.stderr.write('launch-fixture:'+name+'\n'); const home=path.join(root,name);await mkdir(home,{mode:0o700});process.env.HOME=home;binding='fixed';fault=name;
 const fixedRoot=path.join(home,'.portcove-native-123-1-'+identity.controller_revision),node=path.join(fixedRoot,'bootstrap-node');
 const pre=()=>api.prepareFixedHostedLinuxLaunch('pre-sign'),post=()=>api.prepareFixedHostedLinuxLaunch('post-sign');
 if(name==='missing-pre'){await assert.rejects(post());assert.deepEqual(await readdir(home),[]);continue}
 if(['source','provider','expired','changed'].includes(name)){await assert.rejects(pre());assert.deepEqual(await readdir(home),[]);continue}
 if(name==='occupied'){await mkdir(fixedRoot,{mode:0o700});await writeFile(path.join(fixedRoot,'retained'),'original');await assert.rejects(pre(),{code:'EEXIST'});assert.equal(await readFile(path.join(fixedRoot,'retained'),'utf8'),'original');continue}
 if(name==='foreign-tools'){await assert.rejects(pre(),/foreign issuer/);assert.deepEqual(await readdir(fixedRoot),[]);continue}
 const plan=await pre();assert.equal(plan.command,node);assert.equal(plan.temporary,fixedRoot);assert.equal(plan.authority,'none');assert.equal(plan.native_acceptance,'not-established');assert.equal(plan.arguments[1],'pre-sign');assert.equal((await lstat(node)).mode&0o777,0o700);
 if(name==='valid'){assert.ok(Object.isFrozen(plan.arguments));assert.throws(()=>{plan.arguments[0]='foreign-code'});await assert.rejects(api.claimPreparedHostedLinuxLaunch({...plan}),/original/);const context=await api.claimPreparedHostedLinuxLaunch(plan);context.recheck();assert.equal(context.tools_root,tools);await assert.rejects(api.claimPreparedHostedLinuxLaunch(plan),/original/)}
 assert.deepEqual(await readFile(node),await readFile(process.execPath));assert.deepEqual((await readdir(fixedRoot)).sort(),['authenticated-tools','bootstrap-node','launcher-binding.json','pre-sign-launch.json']);
 if(name==='binding')binding='changed';if(name==='replaced'){await rename(node,node+'.retained');await writeFile(node,await readFile(node+'.retained'),{mode:0o700})}if(name==='bytes')await writeFile(node,'changed');if(name==='writable')await chmod(node,0o777);if(name==='linked'){await rename(node,node+'.retained');await symlink(node+'.retained',node)}
 if(['binding','replaced','bytes','writable','linked'].includes(name)){await assert.rejects(post());assert.ok((await readFile(path.join(fixedRoot,'pre-sign-launch.json'))).length);continue}
 if(name==='replay'){await assert.rejects(pre(),{code:'EEXIST'});continue}
 const after=await post();assert.equal(after.command,plan.command);assert.equal(after.binding,plan.binding);assert.equal(after.arguments[1],'post-sign');await assert.rejects(post(),{code:'EEXIST'});
}
await assert.rejects(api.prepareFixedHostedLinuxLaunch('selected-operation'));assert.ok(checks>0&&receives>0);
console.log('real private Node custody and retained launch refusal checks passed; no worker or provider acceptance');
`;
    const childStarted = performance.now();
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 65536,
    });
    assert.equal(
      result.status,
      0,
      JSON.stringify({
        error_code: result.error && "code" in result.error ? result.error.code : null,
        error: result.error?.message,
        signal: result.signal,
        elapsed_milliseconds: Math.round(performance.now() - childStarted),
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    );
    assert.match(result.stdout, /real private Node custody/u);
  },
);

void test("native clock uses the original provider job start and existing allocation, without role authority", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const identity = { run_id: "123", controller_revision: "a".repeat(40) };
  for (const platform of ["linux-x86_64", "windows-x86_64"] as const) {
    const job = {
      id: 1,
      name: hostedNativeJobProfile(platform).job,
      run_id: 123,
      run_attempt: 1,
      head_sha: identity.controller_revision,
      status: "in_progress",
      started_at: new Date(now - 10000).toISOString(),
    };
    const inventory = { total_count: 1, jobs: [job] };
    assert.equal(nativeOriginalJobDeadline(platform, inventory, identity, now, 1000), 561000);
    assert.equal(
      nativeOriginalJobDeadline(platform, inventory, identity, now + 10000, 1000),
      551000,
    );
    for (const mutation of [
      { total_count: 2, jobs: [job] },
      { total_count: 2, jobs: [job, job] },
      { total_count: 1, jobs: [{ ...job, status: "completed" }] },
      { total_count: 1, jobs: [{ ...job, run_attempt: 2 }] },
      { total_count: 1, jobs: [{ ...job, head_sha: "b".repeat(40) }] },
      { total_count: 1, jobs: [{ ...job, name: "arbitrary native worker" }] },
      { total_count: 1, jobs: [{ ...job, started_at: new Date(now + 1).toISOString() }] },
    ])
      assert.throws(() => nativeOriginalJobDeadline(platform, mutation, identity, now, 1000));
    assert.throws(() =>
      nativeOriginalJobDeadline(platform, inventory, identity, now + 560000, 1000),
    );
    assert.throws(() => tufOriginalJobDeadline("native-linux", inventory, identity, now, 1000));
  }
  assert.throws(() => nativeOriginalJobDeadline("selected-platform", {}, identity));
});

for (const actualCustody of [false, true])
  void test(
    `native source bootstrap ${actualCustody ? "with real Linux custody" : "with controlled peers"} shares one original clock and refuses drift before importing the runner`,
    { skip: actualCustody && (process.platform !== "linux" || process.getuid?.() === 0) },
    (t) => {
      const root = disposableDirectory(
        t,
        path.join(actualCustody ? os.homedir() : os.tmpdir(), ".native-source-bootstrap-"),
      );
      const fixedNode = actualCustody ? path.join(root, "bootstrap-node") : process.execPath;
      if (actualCustody) {
        copyFileSync(process.execPath, fixedNode);
        chmodSync(fixedNode, 0o700);
      }
      const entry = new URL("./release-hosted-native-bootstrap.mts", import.meta.url).href;
      const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';
import {mkdir,writeFile,readFile,chmod,rename,symlink} from 'node:fs/promises';import path from 'node:path';import {performance} from 'node:perf_hooks';
const root=process.argv[1], token={}, source={revision:'a'.repeat(40),execution_ref:'refs/tags/portcove-production-controller-fixture',run_id:'123',run_attempt:1,actor_id:'456'}, workflow=Buffer.from('fixed reviewed workflow');
Object.defineProperties(process,{platform:{value:'linux'},arch:{value:'x64'}});
const actualCustody=${JSON.stringify(actualCustody)}, actualUid=process.getuid?.();const originalGetUid=process.getuid;
let fault='',directory,worker,executingRoot,receives=0,runs=[],providerReads=0,pathReads=0,imported=0,config='fixed';
const workerCode='globalThis.nativeBootstrapFixture.imported();export const runConfiguredHostedLinuxNativeJob=(...args)=>globalThis.nativeBootstrapFixture.run("pre-sign",...args);export const runConfiguredHostedLinuxPostSignJob=(...args)=>globalThis.nativeBootstrapFixture.run("post-sign",...args);';
const actualTools=await import(${JSON.stringify(new URL("./release-controller-tools.mts", import.meta.url).href)});
globalThis.nativeBootstrapFixture={
 imported:()=>{imported++}, toolFiles:['fixed-runner.mjs'],profile:actualTools.controllerToolPlatformProfile,read:actualTools.readControllerToolFile,custody:files=>{assert.ok(files.length===1||files.length===3);return new Map(files.map(file=>[file,'controlled']))},recheck:(files,observed)=>assert.deepEqual([...observed.keys()],files),
 workflow:async()=>workflow,
 admit:(policy,environment,bytes,platform,stage)=>{assert.equal(policy,'inert policy');assert.equal(environment.GITHUB_JOB,'native_linux');assert.equal(bytes,workflow);assert.equal(platform,'linux-x86_64');assert.ok(['payload-signing','release-publication'].includes(stage));if(fault==='source')throw Error('source refused');return source},
 require:(value,job,purpose)=>{assert.equal(value,source);assert.equal(job,'native_linux');assert.equal(purpose,'application')},
 selected:(raw,value,purpose)=>{assert.equal(value,source);assert.equal(purpose,'application');return {configuration:{purpose:'application',identity:config}}},
 clock:(platform,identity,cwd,bound)=>{providerReads++;assert.equal(platform,'linux-x86_64');assert.equal(identity.run_id,'123');assert.ok(bound>performance.now());if(fault==='provider')throw Error('provider unavailable');return performance.now()+(fault==='late-tools'?20:570000)},
 receive:async(parent,artifact,bundle,options)=>{receives++;assert.ok(parent.startsWith(directory));assert.equal(artifact.controller_revision,source.revision);assert.equal(artifact.source_tree,'b'.repeat(40));assert.deepEqual(bundle,{artifact_id:2,sha256:'d'.repeat(64)});assert.ok(options.deadline>performance.now());if(fault==='tools')throw Error('foreign tools');if(fault==='late-tools')await new Promise(r=>setTimeout(r,30));return token},
 paths:async value=>{assert.equal(value,token);pathReads++;if(fault==='environment')process.env.GH_TOKEN='foreign reader';if(actualCustody&&pathReads===1){if(fault==='writable')await chmod(executingRoot,0o777);if(fault==='link'){await rename(worker,worker+'.retained');await symlink(worker+'.retained',worker)}if(fault==='foreign')Object.defineProperty(process,'getuid',{value:()=>actualUid+1,configurable:true})}if(actualCustody&&pathReads===2&&fault==='replaced'){await rename(worker,worker+'.retained');await writeFile(worker,workerCode,{mode:0o600})}return {root:executingRoot,node:fault==='node'?worker:process.execPath,entries:{'release-hosted-native-runner':worker}}},
 run:async(operation,raw,parent,deadline,executing)=>{assert.equal(executing,worker);assert.equal(raw.tools.artifact.controller_revision,source.revision);assert.equal(parent,path.join(directory,'portcove-native-linux-'+operation));assert.ok(deadline>performance.now());runs.push({operation,deadline});if(fault==='worker')throw Error('actual worker refused');await writeFile(path.join(parent,'native-job-settlement.json'),JSON.stringify({schema_version:1,exit_code:0,provider_bytes_match:true,native_acceptance:'not-established',authority:'none'}));return {authority:'none',native_acceptance:'not-established'}},
};
const routes={
 './production-controller-admission.mts':{readProductionControllerWorkflowBytes:'workflow',admitProductionNativeParent:'admit',requireAdmittedProductionSource:'require'},
 './release-authority-configuration-contract.mts':{inspectBoundSelectedPublicationAuthorities:'selected'},
 './release-signing-job-budget.mts':{currentNativeJobDeadline:'clock'},
 './release-controller-tools.mts':{controllerToolPaths:'toolFiles',controllerToolPlatformProfile:'profile',readControllerToolFile:'read'},
 './release-controller-tool-admission.mts':{receiveControllerTools:'receive',verifiedControllerToolPaths:'paths'},
};
if(!actualCustody)routes['./release-native-runtime-custody.mts']={inspectNativeRuntimeCustody:'custody',recheckNativeRuntimeCustody:'recheck'};
registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(entry)}&&routes[specifier])return {url:'native-bootstrap:'+specifier,shortCircuit:true};return next(specifier,context)},load(url,context,next){if(url.startsWith('native-bootstrap:'))return {format:'module',source:Object.entries(routes[url.slice('native-bootstrap:'.length)]).map(([name,key])=>'export const '+name+'=globalThis.nativeBootstrapFixture.'+key+';').join('\n'),shortCircuit:true};return next(url,context)}});
const api=await import(${JSON.stringify(entry)});
const needs={tool_bootstrap:{result:'success',outputs:{source_tree:'b'.repeat(40),artifact_id:'1',artifact_sha256:'c'.repeat(64)}},tool_attest:{result:'success',outputs:{bundle_artifact_id:'2',bundle_artifact_sha256:'d'.repeat(64)}}};
async function reset(name){if(actualCustody)Object.defineProperty(process,'getuid',{value:originalGetUid,configurable:true});fault=name;config='fixed';receives=0;runs=[];providerReads=0;pathReads=0;imported=0;directory=path.join(root,name||'valid');await mkdir(directory,{mode:0o700});executingRoot=path.join(directory,'executing');await mkdir(executingRoot,{mode:0o700});worker=path.join(executingRoot,'fixed-runner.mjs');await writeFile(worker,workerCode,{mode:0o600});await writeFile(path.join(executingRoot,'manifest.json'),'{}',{mode:0o600});process.env.RUNNER_TEMP=directory;process.env.PORTCOVE_CONTROLLER_ADMISSION='inert policy';process.env.PORTCOVE_RELEASE_AUTHORITIES='{}';process.env.PORTCOVE_FIXED_NEEDS=JSON.stringify(needs);process.env.GITHUB_JOB='native_linux';process.env.GH_TOKEN='inert reader';}
for(const name of ['','source','provider','tools','node','environment','late-tools','worker','missing-pre','changed-binding','expired','enlarged','missing-clock','bad-needs',...(actualCustody?['writable','link','foreign','replaced']:[])]){
 await reset(name);const pre=()=>api.launchFixedHostedLinuxNativeJob('pre-sign'),post=()=>api.launchFixedHostedLinuxNativeJob('post-sign');
 if(name==='missing-clock'){await assert.rejects(post());assert.equal(receives,0);continue}
 if(name==='bad-needs'){process.env.PORTCOVE_FIXED_NEEDS=JSON.stringify({...needs,tool_attest:{...needs.tool_attest,result:'failure'}});await assert.rejects(pre());assert.equal(receives,0);continue}
 if(['source','provider','tools','node','environment','late-tools','worker','writable','link','foreign','replaced'].includes(name)){
  await assert.rejects(pre());assert.equal(runs.length,name==='worker'?1:0);assert.equal(imported,name==='worker'?1:0);if(['source','provider'].includes(name))assert.equal(receives,0);else {const before=receives;fault='';process.env.GH_TOKEN='inert reader';await assert.rejects(pre());assert.equal(receives,before);}continue;
 }
 const result=await pre();assert.equal(result.native_acceptance,'not-established');const clockFile=path.join(directory,'portcove-native-job-clock.json'),clockBytes=await readFile(clockFile),clock=JSON.parse(clockBytes);
 assert.ok(BigInt(clock.deadline_ns)-BigInt(clock.started_ns)<=570000000000n);
 const before=receives;await assert.rejects(pre());assert.equal(receives,before);
 if(name==='missing-pre')await writeFile(path.join(directory,'portcove-native-linux-pre-sign','native-job-settlement.json'),'{}');
 if(name==='changed-binding')config='different setup';
 if(name==='expired')await writeFile(clockFile,JSON.stringify({...clock,deadline_ns:String(BigInt(clock.started_ns)+1n)}));
 if(name==='enlarged')await writeFile(clockFile,JSON.stringify({...clock,deadline_ns:String(BigInt(clock.started_ns)+570000000001n)}));
 if(name){await assert.rejects(post());assert.equal(receives,before);assert.equal(runs.length,1);continue}
 await post();assert.equal(runs.length,2);assert.equal(runs[1].operation,'post-sign');assert.ok(runs[1].deadline<=runs[0].deadline+1);assert.ok((await readFile(clockFile)).equals(clockBytes));
 await assert.rejects(post());assert.equal(runs.length,2);
}
console.log('controlled native bootstrap clock/source/tool handoff passed');
`;
      const result = spawnSync(fixedNode, ["--input-type=module", "--eval", code, root], {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(
        result.stdout,
        /controlled native bootstrap clock\/source\/tool handoff passed/u,
      );
    },
  );

for (const postSign of [false, true])
  void test(`fixed ${postSign ? "post-sign" : "pre-sign"} CLI routes bounded public uploads to its own stage only`, (t) => {
    const temporary = disposableDirectory(t, path.join(os.tmpdir(), "native-cli-route-"));
    const root = path.join(
      temporary,
      postSign ? "portcove-native-linux-post-sign" : "portcove-native-linux-pre-sign",
    );
    const proof = path.join(root, "proof");
    mkdirSync(proof, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const files = ["subject", "report", "capture", "bundle"].map((name) => {
      const bytes = Buffer.from(`inert ${name}`),
        filename = path.join(proof, `${name}.json`);
      writeFileSync(filename, bytes, { mode: 0o600 });
      return { path: filename, bytes: bytes.length, sha256: hash(bytes) };
    });
    const stage = postSign ? "release-publication" : "payload-signing";
    const readyFile = path.join(proof, "native-upload-ready.json");
    const ready = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        authority: "none",
        compression_level: 0,
        files,
        name: `hosted-native-${stage}-linux-x86_64-99-1`,
        overwrite: false,
        retention_days: 7,
      }),
    );
    writeFileSync(readyFile, ready, { mode: 0o600 });
    writeFileSync(
      path.join(root, "native-job-upload-request.json"),
      JSON.stringify({
        schema_version: 1,
        authority: "none",
        nonce: "c".repeat(32),
        ready_file: readyFile,
        ready_sha256: hash(ready),
        deadline_ns: String(process.hrtime.bigint() + 25_000_000_000n),
      }),
      { mode: 0o600 },
    );
    const entry = fileURLToPath(new URL("./release-hosted-native-runner.mts", import.meta.url));
    const invoke = (operation: string, args: string[] = []) =>
      spawnSync(process.execPath, [entry, operation, ...args], {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 65536,
        env: {
          ...process.env,
          RUNNER_TEMP: temporary,
          PORTCOVE_NATIVE_DEADLINE_NS: String(process.hrtime.bigint() + 20_000_000_000n),
        },
      });
    const suffix = postSign ? "-post-sign" : "";
    const observed = invoke(`upload-request${suffix}`);
    assert.equal(observed.status, 0, observed.stderr);
    const request = JSON.parse(observed.stdout) as {
      request_sha256: string;
      name: string;
      authority: string;
    };
    assert.equal(request.name, `hosted-native-${stage}-linux-x86_64-99-1`);
    assert.equal(request.authority, "none");
    assert.notEqual(invoke("run-other").status, 0);
    // A wrong-stage route sees neither this request nor a private proof.
    assert.notEqual(
      invoke(`upload-ack${postSign ? "" : "-post-sign"}`, [
        request.request_sha256,
        "123",
        "a".repeat(64),
      ]).status,
      0,
    );
    const acknowledgement = invoke(`upload-ack${suffix}`, [
      request.request_sha256,
      "123",
      "a".repeat(64),
    ]);
    assert.equal(acknowledgement.status, 0, acknowledgement.stderr);
    assert.deepEqual(JSON.parse(acknowledgement.stdout), {
      acknowledgement_retained: true,
      authority: "none",
    });
    assert.notEqual(
      invoke(`upload-ack${suffix}`, [request.request_sha256, "123", "a".repeat(64)]).status,
      0,
    );
  });

void test("prepared support accepts only the fixed Linux product and exact source/output identities", () => {
  const source = Buffer.from("fixed source"),
    binary = Buffer.alloc(64);
  binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  binary.writeUInt16LE(62, 18);
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const metadata = {
    schema_version: 1,
    product: String(nativeRuntimeSupport.product),
    platform: "linux-x86_64",
    compiler: {
      verbose_version: "build-time compiler",
      sysroot: "/build-only",
      commands: [
        { command: "rustc", resolved: "/build-only/rustc", bytes: 1, sha256: "a".repeat(64) },
      ],
      environment: [],
    },
    input_fingerprint: "b".repeat(64),
    rustc_arguments: [...nativeRuntimeSupport.arguments],
    source: { bytes: source.length, sha256: hash(source) },
    output: { bytes: binary.length, sha256: hash(binary), mode: 0o700 },
  };
  assert.equal(inspectNativeRuntimeSupport(metadata, source, binary).output.sha256, hash(binary));
  for (const mutate of [
    (m: typeof metadata) => {
      m.product = "selected-other-product";
    },
    (m: typeof metadata) => {
      m.platform = "windows-x86_64";
    },
    (m: typeof metadata) => {
      m.rustc_arguments.push("--cfg=other");
    },
    (m: typeof metadata) => {
      m.source.sha256 = "c".repeat(64);
    },
    (m: typeof metadata) => {
      m.output.sha256 = "c".repeat(64);
    },
    (m: typeof metadata) => {
      m.output.mode = 0o777;
    },
    (m: typeof metadata) => {
      Object.assign(m.compiler.commands[0]!, { resolved: null });
    },
    (m: typeof metadata) => {
      Object.assign(m, { runtime_compiler: "/usr/bin/rustc" });
    },
  ]) {
    const changed = structuredClone(metadata);
    mutate(changed);
    assert.throws(() => inspectNativeRuntimeSupport(changed, source, binary));
  }
  assert.throws(() => inspectNativeRuntimeSupport(metadata, Buffer.from("changed source"), binary));
  const otherArchitecture = Buffer.from(binary);
  otherArchitecture.writeUInt16LE(183, 18);
  const changed = structuredClone(metadata);
  changed.output.sha256 = hash(otherArchitecture);
  assert.throws(() => inspectNativeRuntimeSupport(changed, source, otherArchitecture));
});

void test("Windows prepared support metadata refuses platform, source, architecture and compiler-selection changes", () => {
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const source = Buffer.from("inert prepared Windows supervisor source"),
    binary = Buffer.alloc(128);
  binary.write("MZ");
  binary.writeUInt32LE(64, 60);
  binary.write("PE\0\0", 64);
  binary.writeUInt16LE(0x8664, 68);
  binary.writeUInt16LE(0x20b, 88);
  const metadata = {
    schema_version: 1,
    product: windowsNativeRuntimeSupport.product,
    platform: "windows-x86_64",
    rustc_arguments: [...windowsNativeRuntimeSupport.arguments],
    compiler: {
      verbose_version: "inert build compiler",
      sysroot: "C:\\build-only",
      commands: [
        {
          command: "rustc",
          resolved: "C:\\build-only\\rustc.exe",
          bytes: 1,
          sha256: "a".repeat(64),
        },
      ],
      environment: [],
    },
    input_fingerprint: "b".repeat(64),
    source: { bytes: source.length, sha256: hash(source) },
    output: { bytes: binary.length, sha256: hash(binary), mode: 0o666 },
  };
  assert.equal(
    inspectNativeRuntimeSupport(metadata, source, binary, "windows-x86_64").output.sha256,
    hash(binary),
  );
  assert.throws(() => inspectNativeRuntimeSupport(metadata, source, binary));
  assert.throws(() =>
    inspectNativeRuntimeSupport(
      { ...metadata, platform: "linux-x86_64" },
      source,
      binary,
      "windows-x86_64",
    ),
  );
  assert.throws(() =>
    inspectNativeRuntimeSupport(
      { ...metadata, runtime_compiler: "selected.exe" },
      source,
      binary,
      "windows-x86_64",
    ),
  );
  assert.throws(() =>
    inspectNativeRuntimeSupport(metadata, Buffer.from("changed"), binary, "windows-x86_64"),
  );
  const arm = Buffer.from(binary);
  arm.writeUInt16LE(0xaa64, 68);
  assert.throws(() =>
    inspectNativeRuntimeSupport(
      { ...metadata, output: { ...metadata.output, sha256: hash(arm) } },
      source,
      arm,
      "windows-x86_64",
    ),
  );
});

void test(
  "Linux executing custody refuses writable/link/replaced inputs and retains ancestry",
  { skip: process.platform !== "linux" || process.getuid?.() === 0 },
  (t) => {
    // /tmp is intentionally refused: its writable ancestry cannot protect code.
    const root = mkdtempSync(path.join(os.homedir(), ".portcove-runtime-custody-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    chmodSync(root, 0o700);
    const directory = path.join(root, "tools");
    mkdirSync(directory, { mode: 0o700 });
    const file = path.join(directory, "driver");
    writeFileSync(file, "inert exact bytes", { mode: 0o600 });
    const original = inspectNativeRuntimeCustody([file]);
    recheckNativeRuntimeCustody([file], original);
    const brokerUid = process.getuid!();
    const linuxProcess = process as NodeJS.Process & { getuid: () => number };
    const identityView = t.mock.method(linuxProcess, "getuid", () => brokerUid + 1);
    assert.throws(() => inspectNativeRuntimeCustody([file]), /foreign-owned/);
    identityView.mock.restore();
    chmodSync(directory, 0o777);
    assert.throws(() => inspectNativeRuntimeCustody([file]), /custody/);
    chmodSync(directory, 0o700);
    chmodSync(file, 0o666);
    assert.throws(() => inspectNativeRuntimeCustody([file]), /custody/);
    chmodSync(file, 0o600);
    const linked = path.join(directory, "hard-link");
    linkSync(file, linked);
    assert.throws(() => inspectNativeRuntimeCustody([file]), /single-link/);
    rmSync(linked);
    const symbolic = path.join(directory, "symbolic");
    symlinkSync(file, symbolic);
    assert.throws(() => inspectNativeRuntimeCustody([symbolic]), /linked/);
    rmSync(symbolic);
    // Replacing exact bytes still changes the original retained file identity.
    renameSync(file, file + ".retained");
    writeFileSync(file, "inert exact bytes", { mode: 0o600 });
    assert.throws(() => recheckNativeRuntimeCustody([file], original), /custody/);
    const temp = mkdtempSync(path.join(os.tmpdir(), "portcove-runtime-unprotected-"));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const exposed = path.join(temp, "driver");
    writeFileSync(exposed, "inert", { mode: 0o600 });
    assert.throws(() => inspectNativeRuntimeCustody([exposed]), /custody/);
  },
);

void test(
  "Linux runtime uses original controlled providers, exact inputs and prepared support without compiler fallback",
  { timeout: 60000, skip: process.platform !== "linux" || process.getuid?.() === 0 },
  (t) => {
    const root = mkdtempSync(path.join(os.homedir(), ".portcove-runtime-binding-"));
    chmodSync(root, 0o700);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // Hosted setup-node caches can have shared-writable ancestry. The actual
    // fixed launcher uses its verified private Node copy; match that custody.
    const fixedNode = path.join(root, "node");
    copyFileSync(process.execPath, fixedNode);
    chmodSync(fixedNode, 0o700);
    const entry = new URL("./release-hosted-native-runtime.mts", import.meta.url).href;
    const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';
import {mkdirSync,writeFileSync,readFileSync,chmodSync,mkdtempSync} from 'node:fs';
import {createHash} from 'node:crypto';import path from 'node:path';import {performance} from 'node:perf_hooks';
import * as realTools from ${JSON.stringify(new URL("./release-controller-tools.mts", import.meta.url).href)};
import {lstat as realLstat,realpath} from 'node:fs/promises';
const {controllerToolPaths}=realTools;
import {controllerNodeVersion} from ${JSON.stringify(new URL("./controller-node-runtime.mts", import.meta.url).href)};
import {nativeRuntimeSupport as fixed} from ${JSON.stringify(new URL("./release-native-runtime-support.mts", import.meta.url).href)};
import {rustSupportInputIdentity} from ${JSON.stringify(new URL("./rust-support-cache.mts", import.meta.url).href)};
const root=process.argv[1],hash=b=>createHash('sha256').update(b).digest('hex'),toolReceipts=new WeakMap(),parents=new WeakMap();
let gate,corruptRead=false;
globalThis.runtimeFixture={read:async(...args)=>{const bytes=await realTools.readControllerToolFile(...args);return corruptRead?Buffer.from('controlled changed acquisition'):bytes},inspect:realTools.inspectControllerToolManifest,realpath,lstat:async file=>{const current=gate;if(current&&file===current.file){gate=undefined;current.enter();await current.release}return realLstat(file)},tools:async r=>{assert.ok(toolReceipts.has(r),'original tools');return toolReceipts.get(r)},parent:async r=>{assert.ok(parents.has(r),'original parent');return parents.get(r)}};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(entry)}){if(s==='./release-controller-tool-admission.mts')return {url:'controlled:tools',shortCircuit:true};if(s==='./release-hosted-native-parent.mts')return {url:'controlled:parent',shortCircuit:true};if(s==='./release-controller-tools.mts')return {url:'controlled:read',shortCircuit:true};if(s==='node:fs/promises')return {url:'controlled:fs',shortCircuit:true}}return next(s,c)},load(u,c,next){if(u==='controlled:tools')return {format:'module',source:'export const verifiedControllerToolPaths=globalThis.runtimeFixture.tools;',shortCircuit:true};if(u==='controlled:parent')return {format:'module',source:'export const requireActualHostedNativeParentSource=globalThis.runtimeFixture.parent;',shortCircuit:true};if(u==='controlled:read')return {format:'module',source:'export const readControllerToolFile=globalThis.runtimeFixture.read;export const inspectControllerToolManifest=globalThis.runtimeFixture.inspect;',shortCircuit:true};if(u==='controlled:fs')return {format:'module',source:'export const lstat=globalThis.runtimeFixture.lstat;export const realpath=globalThis.runtimeFixture.realpath;',shortCircuit:true};return next(u,c)}});
const api=await import(${JSON.stringify(entry)}),source=Buffer.from('inert fixed source'),binary=Buffer.alloc(64);
binary.set([127,69,76,70,2,1]);binary.writeUInt16LE(62,18);
const compiler={verbose_version:'build-only',sysroot:'/unavailable-build',commands:[{command:'rustc',resolved:null}],environment:[]};
function fixture(name){
 const directory=path.join(root,name);mkdirSync(directory,{mode:0o700});const tools=path.join(directory,'tools');mkdirSync(tools,{mode:0o700});
 const sourceFile=path.join(tools,fixed.source);mkdirSync(path.dirname(sourceFile),{recursive:true,mode:0o700});writeFileSync(sourceFile,source,{mode:0o600});
 const fingerprint=rustSupportInputIdentity({product:fixed.product,source:sourceFile,compiler,rustcArgs:fixed.arguments,platform:'linux',architecture:'x64'}).fingerprint;
 const metadata=Buffer.from(JSON.stringify({schema_version:1,product:fixed.product,platform:'linux-x86_64',compiler,input_fingerprint:fingerprint,rustc_arguments:fixed.arguments,source:{bytes:source.length,sha256:hash(source)},output:{bytes:binary.length,sha256:hash(binary),mode:0o700}}));
 const files=[];for(const name of controllerToolPaths){const filename=path.join(tools,name);mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});const bytes=name===fixed.source?source:name===fixed.binary?binary:name===fixed.metadata?metadata:name==='bin/node'?readFileSync(process.execPath):Buffer.from('inert '+name);if(name!==fixed.source)writeFileSync(filename,bytes,{flag:'wx',mode:name.startsWith('bin/')?0o700:0o600});files.push({path:name,bytes:bytes.length,sha256:hash(bytes)})}
 const identity={controller_revision:'a'.repeat(40),source_tree:'b'.repeat(40),controller_ref:'refs/tags/fixed-fixture',run_id:'99',run_attempt:1};
 writeFileSync(path.join(tools,'manifest.json'),JSON.stringify({schema_version:2,source_commit:identity.controller_revision,source_tree:identity.source_tree,platform:'linux-x86_64',node_version:controllerNodeVersion,bundler:'vite-plus@1.3.0',tauri_cli_version:'2.12.2',files}),{mode:0o600});
 const tool={},parent={};toolReceipts.set(tool,{root:tools,node:path.join(tools,'bin/node'),platform:'linux-x86_64',identity});parents.set(parent,{producer:{...identity},stage:'payload-signing',platform_label:'linux-x86_64',deadline:performance.now()+60000,recheck(){assert.ok(performance.now()<this.deadline)}});
 return {directory,tools,tool,parent,entry:path.join(tools,'scripts/release-hosted-native-runner.bundle.mjs')};
}
let f=fixture('valid');const runtime=await api.prepareHostedNativeRuntime(f.tool,f.parent,f.entry);
assert.equal((await api.requireHostedNativeRuntime(runtime,f.parent)).tools,f.tool);
await assert.rejects(api.requireHostedNativeRuntime({...runtime},f.parent),/original/);
await assert.rejects(api.requireHostedNativeRuntime(runtime,{}),/original/);
const deps=await api.hostedNativeSupportDependencies(runtime,f.parent,f.directory);
assert.deepEqual(deps.rustSupportCompilerIdentity(),compiler);
const outdir=mkdtempSync(path.join(f.directory,'portcove-host-tool-fixture-'));chmodSync(outdir,0o700);
const output=path.join(outdir,'portcove-linux-process-tree-reaper');
const options={root:f.tools+path.sep,product:fixed.product,source:fixed.source,compiler,rustcArgs:fixed.arguments,platform:'linux',architecture:'x64',output,environment:{PATH:'/unavailable'},runSync(){throw Error('runtime compiler must never be called')}};
assert.equal(deps.prepareSupportArtifact(options).outcome,'hit');assert.deepEqual(readFileSync(output),binary);
await assert.rejects(api.prepareHostedNativeRuntime(f.tool,f.parent,f.entry),/recovery/);
const target=path.join(f.tools,'scripts/rust-test-tree-supervisor.mts'),saved=readFileSync(target);writeFileSync(target,'changed');
await assert.rejects(api.requireHostedNativeRuntime(runtime,f.parent));writeFileSync(target,saved);
await assert.rejects(api.requireHostedNativeRuntime(runtime,f.parent),/original/);assert.throws(()=>deps.rustSupportCompilerIdentity(),/expired/);
const post=fixture('post-sign');parents.get(post.parent).stage='release-publication';const postRuntime=await api.prepareHostedNativeRuntime(post.tool,post.parent,post.entry);assert.equal((await api.requireHostedNativeRuntime(postRuntime,post.parent)).root,post.tools);
const refused=fixture('support-preparation-refusal'),refusedRuntime=await api.prepareHostedNativeRuntime(refused.tool,refused.parent,refused.entry),missingOutput=path.join(refused.directory,'absent');
await assert.rejects(api.hostedNativeSupportDependencies(refusedRuntime,refused.parent,missingOutput));mkdirSync(missingOutput,{mode:0o700});
await assert.rejects(api.requireHostedNativeRuntime(refusedRuntime,refused.parent),/original/);
// Controlled acquisition drift restores the read interface without changing file custody.
// The suspended getter must still observe another getter's irreversible refusal.
const concurrent=fixture('concurrent-stop'),concurrentRuntime=await api.prepareHostedNativeRuntime(concurrent.tool,concurrent.parent,concurrent.entry);
let enter,release;const entered=new Promise(resolve=>{enter=resolve}),released=new Promise(resolve=>{release=resolve});
gate={file:path.join(concurrent.tools,fixed.binary),enter,release:released};
const suspended=api.requireHostedNativeRuntime(concurrentRuntime,concurrent.parent);const suspendedResult=suspended.then(value=>({value}),error=>({error}));
await entered;corruptRead=true;await assert.rejects(api.requireHostedNativeRuntime(concurrentRuntime,concurrent.parent));corruptRead=false;release();
const stoppedResult=await suspendedResult;assert.ok(stoppedResult.error,'a concurrent refusal must stop an already suspended getter');assert.match(stoppedResult.error.message,/stopped|expired/);
for(const kind of ['writable-root','writable-file','wrong-source','wrong-run','copied-tool','copied-parent','wrong-stage']){
 f=fixture(kind);if(kind==='writable-root')chmodSync(f.tools,0o777);if(kind==='writable-file')chmodSync(f.entry,0o666);
 if(kind==='wrong-source')toolReceipts.get(f.tool).identity.controller_revision='c'.repeat(40);
 if(kind==='wrong-run')toolReceipts.get(f.tool).identity.run_id='100';
 if(kind==='wrong-stage')parents.get(f.parent).stage='foreign';
 await assert.rejects(api.prepareHostedNativeRuntime(kind==='copied-tool'?{...f.tool}:f.tool,kind==='copied-parent'?{...f.parent}:f.parent,f.entry));
}
console.log('controlled original-runtime and fixed support refusals passed; no provider or native acceptance');
`;
    const childStarted = performance.now();
    const result = spawnSync(fixedNode, ["--input-type=module", "--eval", code, root], {
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 65536,
    });
    assert.equal(
      result.status,
      0,
      JSON.stringify({
        error_code: result.error && "code" in result.error ? result.error.code : null,
        error: result.error?.message,
        signal: result.signal,
        elapsed_milliseconds: Math.round(performance.now() - childStarted),
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    );
    assert.match(result.stdout, /fixed support refusals passed/u);
  },
);

for (const stage of ["payload-signing", "release-publication"] as const)
  void test(`original ${stage} process survives upload rendezvous, binds ACK and refuses replay or ambiguity`, (t) => {
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
const stage=${JSON.stringify(stage)};const post=stage==='release-publication',toolsToken={};let prepared=0,readbacks=0,received=0,fault='';
const realTools=await import(${JSON.stringify(new URL("./release-controller-tools.mts", import.meta.url).href)});
const realMarker=await import(${JSON.stringify(new URL("./release-routing-marker.mts", import.meta.url).href)});
globalThis.fixture={prepare:async directory=>{
 prepared++;const proof=path.join(directory,'proof');await mkdir(proof,{mode:0o700});
 const files=[];for(const name of ['subject','report','capture','bundle']){const bytes=Buffer.from(name),file=path.join(proof,name+'.json');await writeFile(file,bytes,{flag:'wx',mode:0o600});files.push({path:file,bytes:bytes.length,sha256:hash(bytes)})}
 const ready_file=path.join(proof,'native-upload-ready.json');await writeFile(ready_file,JSON.stringify({schema_version:1,name:'hosted-native-'+stage+'-linux-x86_64-99-1',files,retention_days:7,overwrite:false,compression_level:0,authority:'none'}),{flag:'wx',mode:0o600});return {receipt,ready_file,deadline:performance.now()+(['delayed-read','late-settlement','late-ack'].includes(fault)?1500:20000)};
},readback:async(original,ack)=>{assert.equal(original,receipt);readbacks++;assert.deepEqual(ack,{artifact_id:123,sha256:'a'.repeat(64)});if(fault==='provider')throw Error('ambiguous');return {provider_bytes_match:true,native_acceptance:'not-established',authority:'none'}}};
for(const [name,expected]of [['pre','payload-signing'],['post','release-publication']]){globalThis.fixture[name]=async(...args)=>{assert.equal(stage,expected);if(name==='post'||fault==='configured'){assert.equal(args[2].executing_entry,'/fixed.bundle.mjs');assert.equal(args[2].tools,toolsToken);}return globalThis.fixture.prepare(...args)};globalThis.fixture[name+'Read']=async(...args)=>{assert.equal(stage,expected);return globalThis.fixture.readback(...args)}};
globalThis.fixture.receive=async(root,artifact,bundle,options)=>{received++;assert.deepEqual(artifact,{source:'inert expected source'});assert.deepEqual(bundle,{artifact_id:1,sha256:'f'.repeat(64)});assert.ok(options.deadline>performance.now());return toolsToken};
globalThis.fixture.read=async(file,bound)=>{if(fault==='delayed-read'&&path.basename(file)==='native-upload-ready.json')await delay(1800);return realTools.readControllerToolFile(file,bound)};
globalThis.fixture.marker=async(file,value)=>{await realMarker.retainReleaseRoutingMarker(file,value);if((fault==='late-settlement'&&path.basename(file)==='native-job-settlement.json')||(fault==='late-ack'&&path.basename(file)==='native-job-upload-ack.json'))await delay(1800)};
registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(entry)}){const routes={'./release-hosted-native-job.mts':'job','./release-controller-tools.mts':'tools','./release-routing-marker.mts':'marker','./release-controller-tool-admission.mts':'admission'};if(routes[specifier])return {url:'inert:'+routes[specifier],shortCircuit:true}}return next(specifier,context)},load(url,context,next){const sources={'inert:job':'export const prepareActualHostedLinuxPreSignJob=globalThis.fixture.pre;export const readBackActualHostedLinuxPreSignUpload=globalThis.fixture.preRead;export const prepareActualHostedLinuxPostSignJob=globalThis.fixture.post;export const readBackActualHostedLinuxPostSignUpload=globalThis.fixture.postRead;','inert:admission':'export const receiveControllerTools=globalThis.fixture.receive;export const verifiedControllerToolPaths=()=>{};','inert:tools':'export const readControllerToolFile=globalThis.fixture.read;','inert:marker':'export const retainReleaseRoutingMarker=globalThis.fixture.marker;'};if(sources[url])return {format:'module',source:sources[url],shortCircuit:true};return next(url,context)}});
const api=await import(${JSON.stringify(entry)});
const run=(directory,deadline)=>{if(fault==='configured')return (post?api.runConfiguredHostedLinuxPostSignJob:api.runConfiguredHostedLinuxNativeJob)({tools:{artifact:{source:'inert expected source'},bundle:{artifact_id:1,sha256:'f'.repeat(64)}}},directory,deadline,'/fixed.bundle.mjs');return post?api.runActualHostedLinuxPostSignJob(directory,deadline,{tools:toolsToken,executing_entry:'/fixed.bundle.mjs'}):api.runActualHostedLinuxNativeJob(directory,deadline)};
const read=post?api.readHostedNativePostSignUploadRequest:api.readHostedNativeUploadRequest,ack=post?api.acknowledgeHostedNativePostSignUpload:api.acknowledgeHostedNativeUpload;
for(const name of ['valid','configured','wrong-request','corrupt-ack','provider','timeout']){
 fault=name;const directory=path.join(root,name);await mkdir(directory,{mode:0o700});
 const running=run(directory,performance.now()+(name==='timeout'?1500:20000));
 // Attach rejection immediately while waiting for the other process's routing view.
 const outcome=running.then(value=>({value}),error=>({error}));
 let request;for(let i=0;i<100;i++){try{request=await read(directory);break}catch(error){if(error.code!=='ENOENT')throw error;await delay(5)}}
 assert.ok(request);assert.equal(request.files.length,4);assert.equal(request.authority,'none');
 await assert.rejects((post?api.readHostedNativeUploadRequest:api.readHostedNativePostSignUploadRequest)(directory));
 await assert.rejects((post?api.acknowledgeHostedNativeUpload:api.acknowledgeHostedNativePostSignUpload)(directory,request.request_sha256,123,'a'.repeat(64)));
 if(name==='wrong-request'){
   await assert.rejects(ack(directory,'b'.repeat(64),123,'a'.repeat(64)));
   await ack(directory,request.request_sha256,123,'a'.repeat(64));
 }else if(name==='corrupt-ack'){
   await writeFile(path.join(directory,'native-job-upload-ack.json'),'{}',{flag:'wx'});
 }else if(name==='valid'){
   const childCode='import {'+(post?'acknowledgeHostedNativePostSignUpload':'acknowledgeHostedNativeUpload')+' as acknowledgeHostedNativeUpload} from '+${JSON.stringify(JSON.stringify(entry))}+'; await acknowledgeHostedNativeUpload(process.argv[1],process.argv[2],123,"a".repeat(64)); console.log(process.pid);';
   const child=spawnSync(process.execPath,['--input-type=module','--eval',childCode,directory,request.request_sha256],{encoding:'utf8',timeout:15000,maxBuffer:16384});
   assert.equal(child.status,0,child.stderr);assert.ok(Number(child.stdout.trim())>0);assert.notEqual(Number(child.stdout.trim()),process.pid);
 }else if(name!=='timeout')await ack(directory,request.request_sha256,123,'a'.repeat(64));
 const result=await outcome;
 if(['valid','configured','wrong-request'].includes(name)){assert.ok(result.value);await assert.rejects(ack(directory,request.request_sha256,123,'a'.repeat(64)),{code:'EEXIST'})}else assert.match(result.error.message,/retain/);
 const settlement=JSON.parse(await readFile(path.join(directory,'native-job-settlement.json'),'utf8'));
 assert.equal(settlement.exit_code,['valid','configured','wrong-request'].includes(name)?0:1);
 if(settlement.exit_code){assert.equal(settlement.recovery_required,true);assert.equal(settlement.automatic_retry,false);assert.equal(settlement.upload_effect,'unknown')}
 const before=prepared;await assert.rejects(run(directory,performance.now()+5000),{code:'EEXIST'});assert.equal(prepared,before);
}
assert.equal(readbacks,4);assert.equal(received,2); // A retained attempt can re-read tools, never re-prepare a proof.
for(const name of ['delayed-read','late-settlement','late-ack']){
 fault=name;const directory=path.join(root,name);await mkdir(directory,{mode:0o700});
 const outcome=run(directory,performance.now()+20000).then(value=>({value}),error=>({error}));
 if(name==='delayed-read'){
   const result=await outcome;assert.match(result.error.message,/retain/);
   await assert.rejects(readFile(path.join(directory,'native-job-upload-request.json')),{code:'ENOENT'});
 }else{
   let request;for(let i=0;i<100;i++){try{request=await read(directory);break}catch(error){if(error.code!=='ENOENT')throw error;await delay(5)}}
   assert.ok(request);
   if(name==='late-ack')await assert.rejects(ack(directory,request.request_sha256,123,'a'.repeat(64)),/exhausted/);
   else await ack(directory,request.request_sha256,123,'a'.repeat(64));
   const result=await outcome;
   if(name==='late-settlement'){
     assert.match(result.error.message,/retain/);
     const refusal=JSON.parse(await readFile(path.join(directory,'native-job-refusal.json'),'utf8'));assert.equal(refusal.recovery_required,true);
     const partial=JSON.parse(await readFile(path.join(directory,'native-job-settlement.json'),'utf8'));assert.equal(partial.exit_code,0);assert.equal(partial.authority,'none');
   }else assert.ok(result.value); // Parent completed before expiry; the delayed ACK caller still refuses.
   assert.ok((await readFile(path.join(directory,'native-job-upload-ack.json'))).length>0);
 }
 const before=prepared;await assert.rejects(run(directory,performance.now()+5000),{code:'EEXIST'});assert.equal(prepared,before);
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

void test("source-only workflow routing imports without installed signing dependencies", () => {
  const program = `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
 if(!specifier.startsWith('node:')&&!specifier.startsWith('.')&&!specifier.startsWith('file:'))throw Error('uninstalled package:'+specifier);
 return next(specifier,context);
}});
await import(${JSON.stringify(new URL("./release-hosted-native-workflow.mts", import.meta.url).href)});
const reader=await import(${JSON.stringify(new URL("./release-hosted-native-runner.mts", import.meta.url).href)});
if(typeof reader.readHostedNativeUploadRequest!=='function'||typeof reader.acknowledgeHostedNativePostSignUpload!=='function')throw Error('fixed readers absent');
console.log('source-only handoffs available');`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /source-only handoffs available/u);
});
void test("native failure diagnostics retain only bounded public lifecycle rows without retrying partial state", async () => {
  const { classifyChanges } = await import("./ordinary-validation.mts");
  const selected = classifyChanges(
    [{ status: "M", path: "scripts/release-controller-diagnostics.mts" }],
    { fileExists: () => false },
  );
  assert.ok(selected.nodeTests.has("scripts/release-hosted-native-runner.test.mts"));
  assert.ok(selected.nodeTests.has("scripts/release-controller-transport.test.mts"));
  const root = mkdtempSync(path.join(os.tmpdir(), "native-public-diagnostics-"));
  const temporary = path.join(root, "temporary"),
    home = path.join(root, "home"),
    revision = "a".repeat(40);
  mkdirSync(temporary);
  mkdirSync(home);
  const source = path.join(home, `.portcove-native-123-1-${revision}`);
  mkdirSync(source);
  const row = JSON.stringify({
    schema_version: 1,
    authority: "none",
    recovery_required: true,
    reason: "worker-refused-or-ambiguous",
  });
  writeFileSync(path.join(source, "native-supervision-refusal.json"), row);
  writeFileSync(path.join(source, "native-supervision-settlement.json"), "x".repeat(65537));
  writeFileSync(path.join(source, "private-key.json"), "fixture-private-must-never-copy");
  try {
    const directory = await retainHostedNativeDiagnostics(temporary, home, "123", revision);
    const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")) as {
      authority: string;
      files: { path: string; source: string }[];
      unavailable: { path: string; reason: string }[];
    };
    assert.equal(manifest.authority, "none");
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0]!.source, "native-supervision-refusal.json");
    assert.equal(readFileSync(path.join(directory, manifest.files[0]!.path), "utf8"), row);
    assert.ok(
      manifest.unavailable.some(
        (value) =>
          value.path === "native-supervision-settlement.json" &&
          value.reason === "unreadable-or-invalid",
      ),
    );
    assert.ok(manifest.unavailable.some((value) => value.reason === "absent"));
    assert.ok(!readFileSync(path.join(directory, "manifest.json"), "utf8").includes("private-key"));
    await assert.rejects(
      retainHostedNativeDiagnostics(temporary, home, "123", revision),
      /EEXIST/u,
    );
    assert.equal(readFileSync(path.join(source, "native-supervision-refusal.json"), "utf8"), row);
    await assert.rejects(
      retainHostedNativeDiagnostics(temporary, home, "../123", revision),
      /binding/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
