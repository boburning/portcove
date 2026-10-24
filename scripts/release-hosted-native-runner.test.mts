/** Real bounded file rendezvous, controlled producer; no native acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  inspectNativeRuntimeSupport,
  nativeRuntimeSupport,
} from "./release-native-runtime-support.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";

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
  { skip: process.platform !== "linux" || process.getuid?.() === 0 },
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
import {controllerToolPaths} from ${JSON.stringify(new URL("./release-controller-tools.mts", import.meta.url).href)};
import {controllerNodeVersion} from ${JSON.stringify(new URL("./controller-node-runtime.mts", import.meta.url).href)};
import {nativeRuntimeSupport as fixed} from ${JSON.stringify(new URL("./release-native-runtime-support.mts", import.meta.url).href)};
import {rustSupportInputIdentity} from ${JSON.stringify(new URL("./rust-support-cache.mts", import.meta.url).href)};
const root=process.argv[1],hash=b=>createHash('sha256').update(b).digest('hex'),toolReceipts=new WeakMap(),parents=new WeakMap();
globalThis.runtimeFixture={tools:async r=>{assert.ok(toolReceipts.has(r),'original tools');return toolReceipts.get(r)},parent:async r=>{assert.ok(parents.has(r),'original parent');return parents.get(r)}};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(entry)}){if(s==='./release-controller-tool-admission.mts')return {url:'controlled:tools',shortCircuit:true};if(s==='./release-hosted-native-parent.mts')return {url:'controlled:parent',shortCircuit:true}}return next(s,c)},load(u,c,next){if(u==='controlled:tools')return {format:'module',source:'export const verifiedControllerToolPaths=globalThis.runtimeFixture.tools;',shortCircuit:true};if(u==='controlled:parent')return {format:'module',source:'export const requireActualHostedNativeParentSource=globalThis.runtimeFixture.parent;',shortCircuit:true};return next(u,c)}});
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
 const tool={},parent={};toolReceipts.set(tool,{root:tools,node:path.join(tools,'bin/node'),identity});parents.set(parent,{producer:{...identity},stage:'payload-signing',platform_label:'linux-x86_64',deadline:performance.now()+60000,recheck(){assert.ok(performance.now()<this.deadline)}});
 return {directory,tools,tool,parent,entry:path.join(tools,'scripts/release-hosted-native-runner.bundle.mjs')};
}
let f=fixture('valid');const runtime=await api.prepareHostedNativeRuntime(f.tool,f.parent,f.entry);
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
for(const kind of ['writable-root','writable-file','wrong-source','wrong-run','copied-tool','copied-parent','wrong-stage']){
 f=fixture(kind);if(kind==='writable-root')chmodSync(f.tools,0o777);if(kind==='writable-file')chmodSync(f.entry,0o666);
 if(kind==='wrong-source')toolReceipts.get(f.tool).identity.controller_revision='c'.repeat(40);
 if(kind==='wrong-run')toolReceipts.get(f.tool).identity.run_id='100';
 if(kind==='wrong-stage')parents.get(f.parent).stage='foreign';
 await assert.rejects(api.prepareHostedNativeRuntime(kind==='copied-tool'?{...f.tool}:f.tool,kind==='copied-parent'?{...f.parent}:f.parent,f.entry));
}
console.log('controlled original-runtime and fixed support refusals passed; no provider or native acceptance');
`;
    const result = spawnSync(fixedNode, ["--input-type=module", "--eval", code, root], {
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 65536,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
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
registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(entry)}){const routes={'./release-hosted-native-job.mts':'job','./release-controller-tools.mts':'tools','./release-routing-marker.mts':'marker','./release-controller-tool-admission.mts':'admission'};if(routes[specifier])return {url:'inert:'+routes[specifier],shortCircuit:true}}return next(specifier,context)},load(url,context,next){const sources={'inert:job':'export const prepareActualHostedLinuxPreSignJob=globalThis.fixture.pre;export const readBackActualHostedLinuxPreSignUpload=globalThis.fixture.preRead;export const prepareActualHostedLinuxPostSignJob=globalThis.fixture.post;export const readBackActualHostedLinuxPostSignUpload=globalThis.fixture.postRead;','inert:admission':'export const receiveControllerTools=globalThis.fixture.receive;','inert:tools':'export const readControllerToolFile=globalThis.fixture.read;','inert:marker':'export const retainReleaseRoutingMarker=globalThis.fixture.marker;'};if(sources[url])return {format:'module',source:sources[url],shortCircuit:true};return next(url,context)}});
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
