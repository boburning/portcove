import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import {
  inspectWindowsNativeSourceTree,
  verifyWindowsNativeSourceFiles,
  requireActualHostedWindowsSource,
  prepareActualHostedWindowsSource,
} from "./release-hosted-native-windows-source.mts";

const harness = "scripts/release-native-worker.mts";
const content = Buffer.from("export {};\n");
const digest = createHash("sha256").update(content).digest("hex");
const object = spawnSync("git", ["hash-object", "--stdin"], { input: content, encoding: "utf8" });
assert.equal(object.status, 0);
const blob = object.stdout.trim();
assert.match(blob, /^[a-f0-9]{40}$/u);
const row = (name = harness, mode = "100644", size = content.length, id = blob) =>
  `${mode} blob ${id} ${size}\t${name}\0`;
const inventory = (suffix = "") => inspectWindowsNativeSourceTree(Buffer.from(row() + suffix));

void test("Windows tree accepts exact Git modes, empty blobs and shared exact directory spelling", () => {
  const entries = inventory(
    row("scripts/empty", "100755", 0, "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"),
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[1]!.bytes, 0);
  assert.ok(Object.isFrozen(entries) && Object.isFrozen(entries[0]));
});
for (const [label, name] of [
  ["parent traversal", "a/../b"],
  ["absolute path", "/a"],
  ["backslash", "a\\b"],
  ["alternate stream", "a:b"],
  ["reserved device", "a/CON.txt"],
  ["console device", "a/CONIN$"],
  ["trailing dot", "a./b"],
  ["trailing space", "a /b"],
  ["Git metadata", "a/.Git/config"],
  ["short name alias", "a~1/file"],
  ["Unicode alias", "a/COM¹"],
  ["empty component", "a//b"],
  ["directory case alias", "Scripts/other"],
  ["file case alias", "scripts/RELEASE-NATIVE-WORKER.mts"],
  ["file prefix collision", "scripts"],
]) {
  void test(`Windows tree refuses ${label}`, () => assert.throws(() => inventory(row(name))));
}
void test("Windows tree refuses duplicate files, links, submodules, truncated and excessive inventories", () => {
  for (const bytes of [
    Buffer.from(row() + row()),
    Buffer.from(row(harness, "120000")),
    Buffer.from(row(harness, "160000")),
    Buffer.from(row().slice(0, -1)),
    Buffer.alloc(4 * 1024 ** 2 + 1),
    Buffer.from(row(harness, "100644", 128 * 1024 ** 2 + 1)),
  ])
    assert.throws(() => inspectWindowsNativeSourceTree(bytes));
  assert.throws(() =>
    inventory(row("one", "100644", 128 * 1024 ** 2) + row("two", "100644", 128 * 1024 ** 2)),
  );
  assert.throws(() => inspectWindowsNativeSourceTree(Buffer.from(row("unrelated"))));
});

function fixture(context: { after(callback: () => void | Promise<void>): void }) {
  const root = disposableDirectory(context, path.join(tmpdir(), "pc-win-source-"));
  mkdirSync(path.join(root, path.dirname(harness)), { recursive: true });
  writeFileSync(path.join(root, harness), content);
  return root;
}
void test("Windows source verifies every byte against Git and independently pinned harness", (context) => {
  const root = fixture(context),
    empty = "scripts/empty";
  writeFileSync(path.join(root, empty), "");
  verifyWindowsNativeSourceFiles(
    root,
    inventory(row(empty, "100644", 0, "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")),
    digest,
    () => {},
  );
  assert.throws(() => verifyWindowsNativeSourceFiles(root, inventory(), "0".repeat(64), () => {}));
  writeFileSync(path.join(root, harness), Buffer.alloc(content.length, 0x61));
  assert.throws(
    () => verifyWindowsNativeSourceFiles(root, inventory(), digest, () => {}),
    /Git blob differs/,
  );
});
void test("Windows source rejects hardlinks and directory junction ancestry", (context) => {
  const root = fixture(context);
  linkSync(path.join(root, harness), path.join(root, "second-link"));
  assert.throws(() => verifyWindowsNativeSourceFiles(root, inventory(), digest, () => {}));
  const other = fixture(context);
  symlinkSync(
    path.join(root, "scripts"),
    path.join(other, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () =>
      verifyWindowsNativeSourceFiles(
        other,
        inspectWindowsNativeSourceTree(Buffer.from(row() + row("alias/release-native-worker.mts"))),
        digest,
        () => {},
      ),
    /ancestry changed/,
  );
});
void test("Windows source preserves original expiry and refuses mutations during readback", (context) => {
  const root = fixture(context);
  assert.throws(
    () =>
      verifyWindowsNativeSourceFiles(root, inventory(), digest, () => {
        throw new Error("original clock expired");
      }),
    /original clock expired/,
  );
  let checks = 0;
  assert.throws(() =>
    verifyWindowsNativeSourceFiles(root, inventory(), digest, () => {
      if (++checks === 2) appendFileSync(path.join(root, harness), "changed");
    }),
  );
});
void test("Public Windows source observations and replayed JSON grant no original capability", async () => {
  const publicRecord = { kind: "original-hosted-windows-source", authority: "none" };
  await assert.rejects(requireActualHostedWindowsSource(publicRecord));
  await assert.rejects(requireActualHostedWindowsSource(structuredClone(publicRecord)));
  await assert.rejects(prepareActualHostedWindowsSource({}, {}, {}));
});

void test("Original Windows source API joins controlled capabilities and refuses drift and replay", (context) => {
  const root = disposableDirectory(context, path.join(tmpdir(), "pc-win-source-api-"));
  const module = new URL("./release-hosted-native-windows-source.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';
import {EventEmitter} from 'node:events';import path from 'node:path';import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
const {readControllerToolFile:read}=await import(${JSON.stringify(new URL("./release-controller-tools.mts", import.meta.url).href)});
const {assertControllerBootstrapEnvironment:guard}=await import(${JSON.stringify(new URL("./release-controller-job-bootstrap.mts", import.meta.url).href)});
const {windowsSourceSystemExecutables:systemPaths}=await import(${JSON.stringify(new URL("./release-native-runtime-custody.mts", import.meta.url).href)});
Object.defineProperties(process,{platform:{value:'win32'},arch:{value:'x64'}});
const scratch=process.argv[1],data=Buffer.from(${JSON.stringify(content.toString())}),tree=Buffer.from(${JSON.stringify(row())}),hash=b=>createHash('sha256').update(b).digest('hex');
let fault='',clock=1000,parent,toolReceipt,runtime,tools,spawned=false,requests=0,runtimeReads=0,gate,entered,block=false,inherited=Infinity;
const {selectedPublicationAuthoritiesFixture}=await import(${JSON.stringify(new URL("./fixtures/checkpoint-proof-fixture.mts", import.meta.url).href)});
const {inspectSelectedPublicationAuthorityConfiguration:inspectConfiguration}=await import(${JSON.stringify(new URL("./release-authority-configuration.mts", import.meta.url).href)});
const selected={source_commit:'b'.repeat(40),source_tree:'c'.repeat(40),harness:{path:${JSON.stringify(harness)},sha256:hash(data)}};
const original={controller_revision:'a'.repeat(40),controller_ref:'refs/tags/fixed-controller',run_id:123,run_attempt:1};
globalThis.sourcePeers={
 budget:(maximum=30000)=>{const remaining=Math.floor(Math.min(maximum,inherited-clock));assert.ok(remaining>0);return remaining},deadlineCheck:()=>assert.ok(clock<inherited),deadlineScope:async(deadline,work)=>{const previous=inherited;inherited=Math.min(inherited,deadline);try{return await work()}finally{inherited=previous}},
 now:()=>clock,guard,systemPaths,systemCustody:()=>new Map(),systemRecheck:()=>{if(fault==='getter-system-late' && runtimeReads>=3)clock=parent.deadline+1;if(fault==='getter-system' && runtimeReads>=3)throw Error('original fixed system custody drift')},
 parent:async value=>{assert.equal(value,parent);return parent},
 tools:async value=>{assert.equal(value,toolReceipt);return tools},
 runtime:async(value,source)=>{assert.equal(value,runtime);assert.equal(source,parent);runtimeReads++;if(fault==='deps-preflight-late'&&runtimeReads===4)clock=181001;if(fault==='deps-preflight-role'&&runtimeReads===4)process.env.PORTCOVE_TUF_ROOT_KEY='inert forbidden';if(block){block=false;entered();await new Promise(resolve=>gate=resolve)}if((fault==='late-role'&&runtimeReads===2)||(fault==='getter-role'&&runtimeReads>=3))process.env.PORTCOVE_TUF_ROOT_KEY='inert forbidden';if(fault==='late-final'&&runtimeReads===2)clock=91001;return {tools:fault==='mixed-tools'||(fault==='getter-tools'&&runtimeReads>=3)?{}:toolReceipt,root:'executing-root-is-distinct',deadline:parent.deadline}},
 inputs:async()=>({workspace_sha256:'d'.repeat(64),lock_sha256:'e'.repeat(64),patches:[],registry_packages:1}),graph:async()=>({sha256:(fault==='deps-graph'?'f':'1').repeat(64),entries:2,bytes:5}),
 support:async()=>({}),read:async(filename,...rest)=>filename.includes('Program Files')?Buffer.from('fixed OS helper'):read(filename,...rest),
 custody:files=>new Map(files.map(file=>[file,'controlled-only'])),
 recheck:(files,custody)=>{assert.deepEqual(files,[...custody.keys()]);if((fault==='custody-final'&&spawned)||(fault==='getter-custody'&&runtimeReads>=3))throw Error('controlled custody drift')},
 spawn:()=>{spawned=true;return {stdout:new EventEmitter(),stderr:new EventEmitter()}},
 resource:async(kind,command,args,options)=>{requests++;assert.equal(kind,'analysis');assert.equal(command,tools.node);assert.equal(options.queueDeadline,Math.min(args[1]==='acquire-dependencies'?181000:91000,parent.deadline-210000,inherited));return options.supervise([command,...args],{})},
 supervise:async(args,options)=>{const child=options.spawn(args[0],args.slice(1),{}),plan=JSON.parse(await readFile(args[3],'utf8'));if(args[2]==='acquire-dependencies'){assert.equal(plan.source,path.join(parent.directory,'windows-source/source'));assert.equal(plan.pnpm,tools.pnpm);child.stdout.emit('data',Buffer.from(JSON.stringify({schema_version:1,binding:plan.binding,inputs:plan.inputs,dependencies_prepared:true,entries:2,bytes:5,graph_sha256:'1'.repeat(64),native_acceptance:'not-established',authority:'none'})+'\n'));return 0}assert.equal(args[1],path.join(tools.root,'scripts/release-hosted-native-windows-source.bundle.mjs'));await mkdir(path.join(plan.root,'source',path.dirname(selected.harness.path)),{recursive:true});await writeFile(path.join(plan.root,'tree.bin'),fault==='changed-tree'?Buffer.from('changed'):tree);await writeFile(path.join(plan.root,'source',selected.harness.path),fault==='changed-blob'?Buffer.alloc(data.length,0x61):data);child.stdout.emit('data',Buffer.from(JSON.stringify({schema_version:1,binding:fault==='changed-report'?'changed':plan.binding,source_commit:plan.source_commit,source_tree:plan.source_tree,tree_inventory_sha256:hash(tree),acquired:true,dependencies_prepared:false,native_acceptance:'not-established',authority:'none'})+'\n'));return 0}
};
const routes={'./release-coordinator-deadline.mts':{coordinatorCommandTimeout:'budget',checkCoordinatorDeadline:'deadlineCheck',withCoordinatorDeadline:'deadlineScope'},'./release-hosted-native-windows-dependency-files.mts':{inspectWindowsNativeDependencyInputs:'inputs',snapshotWindowsNativeDependencies:'graph'},'node:perf_hooks':{performance:'clock'},'./release-hosted-native-parent.mts':{requireActualHostedNativeParentSource:'parent'},'./release-controller-tool-admission.mts':{verifiedControllerToolPaths:'tools'},'./release-hosted-native-runtime.mts':{requireHostedNativeRuntime:'runtime',hostedNativeSupportDependencies:'support'},'./release-controller-tools.mts':{readControllerToolFile:'read'},'./release-native-runtime-custody.mts':{inspectNativeRuntimeCustody:'custody',recheckNativeRuntimeCustody:'recheck',windowsSourceSystemExecutables:'systemPaths',inspectWindowsSourceSystemCustody:'systemCustody',recheckWindowsSourceSystemCustody:'systemRecheck'},'node:child_process':{spawn:'spawn'},'./resource-command.mts':{runResourceCommand:'resource'},'./run-rust-tests.mts':{runRustTests:'supervise'},'./release-controller-job-bootstrap.mts':{assertControllerBootstrapEnvironment:'guard'}};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(module)}&&routes[s])return {url:'source-controls:'+s,shortCircuit:true};return next(s,c)},load(u,c,next){if(u.startsWith('source-controls:')){const exports=Object.entries(routes[u.slice(16)]).map(([name,key])=>'export const '+name+'='+(key==='clock'?'({now:globalThis.sourcePeers.now})':'globalThis.sourcePeers.'+key)+';').join('');return {format:'module',source:exports,shortCircuit:true}}return next(u,c)}});
const api=await import(${JSON.stringify(module)});
for(const scenario of ['valid','clipped','platform','stage','purpose','mixed-tools','no-reserve','changed-report','changed-tree','changed-blob','late-final','late-role','custody-final','getter-role','getter-bytes','getter-tools','getter-custody','getter-system','getter-system-late','getter-expired','concurrent-stop','deps','deps-clipped','deps-inherited','deps-preflight-late','deps-preflight-role','harness']){
 fault=scenario;clock=1000;inherited=Infinity;requests=runtimeReads=0;spawned=false;delete process.env.PORTCOVE_TUF_ROOT_KEY;
 const configuration=selectedPublicationAuthoritiesFixture('application');configuration.hosted_native['windows-x86_64'].producer=scenario==='harness'?{...selected,harness:{path:'scripts/test-windows-installer.ps1',sha256:selected.harness.sha256}}:selected;inspectConfiguration(configuration);
 const directory=path.join(scratch,scenario);await mkdir(directory);toolReceipt={};runtime={};tools={root:directory,node:process.execPath,pnpm:path.join(directory,'bin/pnpm.exe'),platform:'windows-x86_64',identity:original};parent={directory,producer:original,platform_label:scenario==='platform'?'linux-x86_64':'windows-x86_64',stage:scenario==='stage'?'release-publication':'payload-signing',deadline:['clipped','deps-clipped'].includes(scenario)?250000:scenario==='no-reserve'?200000:500000,configuration:{...configuration,purpose:scenario==='purpose'?'catalog':'application'},recheck(){assert.ok(clock<this.deadline)}};
 const preflight=['platform','stage','purpose','mixed-tools','no-reserve','harness'].includes(scenario),failure=preflight||['changed-report','changed-tree','changed-blob','late-final','late-role','custody-final'].includes(scenario);
 if(failure){await assert.rejects(api.prepareActualHostedWindowsSource(parent,toolReceipt,runtime),scenario);if(preflight){assert.equal(requests,0);assert.deepEqual(await readdir(directory),[])}else{assert.equal(requests,1);delete process.env.PORTCOVE_TUF_ROOT_KEY;fault='';clock=1000;await assert.rejects(api.prepareActualHostedWindowsSource(parent,toolReceipt,runtime),/one Windows source attempt/)}continue}
 const receipt=await api.prepareActualHostedWindowsSource(parent,toolReceipt,runtime);assert.equal(requests,1);await assert.rejects(api.requireActualHostedWindowsSource({...receipt}));
 if(scenario==='deps-preflight-late'||scenario==='deps-preflight-role'){
 await assert.rejects(api.prepareActualHostedWindowsDependencies(parent,toolReceipt,runtime,receipt));assert.equal(requests,1);assert.equal((await readdir(directory)).includes('windows-dependencies-intent.json'),false);delete process.env.PORTCOVE_TUF_ROOT_KEY;fault='';clock=1000;await assert.rejects(api.prepareActualHostedWindowsDependencies(parent,toolReceipt,runtime,receipt));continue;
 }
 if(['deps','deps-clipped','deps-inherited'].includes(scenario)){
 if(scenario==='deps-inherited')inherited=51000;
 await assert.rejects(api.prepareActualHostedWindowsDependencies({},toolReceipt,runtime,receipt));
 await assert.rejects(api.prepareActualHostedWindowsDependencies(parent,{},runtime,receipt));
 await assert.rejects(api.prepareActualHostedWindowsDependencies(parent,toolReceipt,{},receipt));
 await assert.rejects(api.prepareActualHostedWindowsDependencies(parent,toolReceipt,runtime,{...receipt}));assert.equal(requests,1);
 const deps=await api.prepareActualHostedWindowsDependencies(parent,toolReceipt,runtime,receipt);assert.equal(requests,2);
 const result=await api.requireActualHostedWindowsDependencies(deps);assert.equal(result.source,receipt);assert.equal(result.parent,parent);assert.equal(result.tools,toolReceipt);assert.equal(result.runtime,runtime);
 await assert.rejects(api.requireActualHostedWindowsDependencies({...deps}));await assert.rejects(api.prepareActualHostedWindowsDependencies(parent,toolReceipt,runtime,receipt),/one Windows dependencies attempt/);
 fault='deps-graph';await assert.rejects(api.requireActualHostedWindowsDependencies(deps),/graph changed/);fault='';await assert.rejects(api.requireActualHostedWindowsDependencies(deps),/original Windows dependencies required/);continue;
 }
 if(scenario==='valid'||scenario==='clipped'){const result=await api.requireActualHostedWindowsSource(receipt);assert.equal(result.parent,parent);assert.equal(result.tools,toolReceipt);assert.equal(result.runtime,runtime);assert.equal(result.root,path.join(directory,'windows-source/source'));assert.notEqual(result.root,'executing-root-is-distinct');result.system_custody.set('caller-mutated','data');assert.equal((await api.requireActualHostedWindowsSource(receipt)).system_custody.has('caller-mutated'),false);await assert.rejects(api.prepareActualHostedWindowsSource(parent,toolReceipt,runtime),/one Windows source attempt/);continue}
 const file=path.join(directory,'windows-source/source',selected.harness.path);
 if(scenario==='concurrent-stop'){block=true;let ready;const started=new Promise(resolve=>ready=resolve);entered=ready;const pending=api.requireActualHostedWindowsSource(receipt).then(value=>({value}),error=>({error}));await started;await writeFile(file,Buffer.alloc(data.length,0x61));await assert.rejects(api.requireActualHostedWindowsSource(receipt));await writeFile(file,data);gate();assert.ok((await pending).error);continue}
 if(scenario==='getter-bytes')await writeFile(file,Buffer.alloc(data.length,0x61));if(scenario==='getter-expired')clock=parent.deadline+1;
 await assert.rejects(api.requireActualHostedWindowsSource(receipt),scenario);delete process.env.PORTCOVE_TUF_ROOT_KEY;fault='';clock=1000;await writeFile(file,data);await assert.rejects(api.requireActualHostedWindowsSource(receipt),/original Windows source receipt required/);
}
console.log('controlled original Windows source API passed; no actual Windows or protected observations');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /controlled original Windows source API passed/u);
});

void test("Windows source child retains bounded raw command failure diagnostics without minting receipts", (context) => {
  const root = disposableDirectory(context, path.join(tmpdir(), "pc-win-source-failure-"));
  const module = new URL("./release-hosted-native-windows-source.mts", import.meta.url);
  for (const oversized of [false, true]) {
    const folder = path.join(root, oversized ? "overflow" : "exit");
    mkdirSync(folder);
    const bytes = oversized ? Buffer.alloc(9000, 0x61) : Buffer.from([0, 255, 65, 10]);
    const hook = path.join(folder, "controlled-peer.mjs"),
      plan = path.join(folder, "intent.json");
    writeFileSync(
      hook,
      `import {registerHooks} from 'node:module';import {EventEmitter} from 'node:events';import path from 'node:path';Object.defineProperties(process,{platform:{value:'win32'},arch:{value:'x64'}});globalThis.failedSourceCommand=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;queueMicrotask(()=>{child.stderr.emit('data',Buffer.from(${JSON.stringify(bytes.toString("base64"))},'base64'));child.emit('close',7,null)});return child};registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(module.href)}&&s==='node:child_process')return {url:'controlled:failed-source',shortCircuit:true};return next(s,c)},load(u,c,next){if(u==='controlled:failed-source')return {format:'module',source:'export const spawn=globalThis.failedSourceCommand;',shortCircuit:true};return next(u,c)}});`,
    );
    writeFileSync(
      plan,
      JSON.stringify({
        schema_version: 1,
        binding: "a".repeat(64),
        source_commit: "b".repeat(40),
        source_tree: "c".repeat(40),
        harness_sha256: digest,
        root: path.join(folder, "windows-source"),
        setup: path.join(folder, "release-hosted-native-windows-setup.cs.txt"),
        expires_at: Date.now() + 15000,
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(hook).href, fileURLToPath(module), "acquire-source", plan],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 65536,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
      },
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const record: unknown = JSON.parse(result.stdout);
    assert.ok(
      isRecord(record) && isRecord(record.diagnostic) && isRecord(record.diagnostic.stderr),
    );
    assert.equal(typeof record.diagnostic.stderr.base64, "string");
    assert.equal(record.authority, "none");
    assert.equal(record.automatic_retry, false);
    assert.equal(record.diagnostic.stage, "private-directory");
    assert.equal(record.diagnostic.exit, oversized ? null : 7);
    assert.equal(record.diagnostic.signal, null);
    const retained = bytes.subarray(0, 8192);
    assert.equal(record.diagnostic.stderr.observed_bytes, bytes.length);
    assert.equal(record.diagnostic.stderr.retained_bytes, retained.length);
    assert.equal(record.diagnostic.stderr.truncated, oversized);
    assert.equal(
      record.diagnostic.stderr.sha256,
      createHash("sha256").update(retained).digest("hex"),
    );
    assert.deepEqual(Buffer.from(String(record.diagnostic.stderr.base64), "base64"), retained);
    assert.ok(Buffer.byteLength(result.stdout) < 65536 && Buffer.byteLength(result.stderr) < 8192);
  }
});

void test("Windows dependency child keeps startup homes outside its fresh DACL target", async (context) => {
  const root = disposableDirectory(context, path.join(tmpdir(), "pc-win-deps-startup-")),
    broker = path.join(root, "broker"),
    source = path.join(broker, "windows-source/source"),
    tools = path.join(root, "tools");
  mkdirSync(path.join(source, "apps/desktop"), { recursive: true });
  mkdirSync(path.join(tools, "scripts"), { recursive: true });
  mkdirSync(path.join(tools, "bin"));
  writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ packageManager: "pnpm@12.14.0" }),
    { mode: 0o600 },
  );
  writeFileSync(path.join(source, "apps/desktop/package.json"), "{}", { mode: 0o600 });
  writeFileSync(path.join(source, "pnpm-workspace.yaml"), "packages: [apps/desktop]\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(source, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\npackages:\n  inert@1.0.0:\n    resolution: {integrity: sha512-${Buffer.alloc(64).toString("base64")}}\nimporters:\n  .: {}\n`,
    { mode: 0o600 },
  );
  const { inspectWindowsNativeDependencyInputs } =
    await import("./release-hosted-native-windows-dependency-files.mts");
  const inputs = await inspectWindowsNativeDependencyInputs(
    source,
    performance.now() + 10000,
    () => {},
  );
  const plan = path.join(broker, "intent.json"),
    setup = path.join(tools, "scripts/release-hosted-native-windows-setup.cs.txt"),
    pnpm = path.join(tools, "bin/pnpm.exe"),
    target = path.join(broker, "windows-dependencies");
  writeFileSync(setup, "controlled unused source", { mode: 0o600 });
  writeFileSync(pnpm, "controlled pinned runtime", { mode: 0o600 });
  writeFileSync(
    plan,
    JSON.stringify({
      schema_version: 1,
      binding: "a".repeat(64),
      source,
      root: target,
      setup,
      pnpm,
      inputs,
      expires_at: Date.now() + 120000,
    }),
    { mode: 0o600 },
  );
  const module = new URL("./release-hosted-native-windows-source.mts", import.meta.url),
    hook = path.join(root, "controlled-startup.mjs");
  writeFileSync(
    hook,
    `import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {EventEmitter} from 'node:events';import fs from 'node:fs';import path from 'node:path';Object.defineProperties(process,{platform:{value:'win32'},arch:{value:'x64'}});const plan=JSON.parse(fs.readFileSync(${JSON.stringify(plan)},'utf8'));globalThis.startupPeer=(exe,args,options)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;queueMicrotask(()=>{try{if(exe.endsWith('pwsh.exe')){for(const key of ['HOME','USERPROFILE','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','TEMP','TMP'])assert.equal(options.env[key],path.dirname(plan.root));assert.equal(fs.existsSync(plan.root),false,'startup must not precreate the DACL target');fs.mkdirSync(plan.root)}else{assert.equal(exe,plan.pnpm);assert.equal(options.env.HOME,plan.root);if(args[0]==='--version')child.stdout.emit('data',Buffer.from('12.14.0'));else{assert.ok(args.includes('--frozen-lockfile')&&args.includes('--ignore-scripts')&&args.includes('--ignore-pnpmfile'));fs.mkdirSync(path.join(plan.source,'node_modules'));fs.mkdirSync(path.join(plan.source,'apps/desktop/node_modules'));fs.writeFileSync(path.join(plan.source,'node_modules/inert'),'fixture',{mode:0o600})}}child.emit('close',0,null)}catch(error){child.emit('error',error);child.emit('close',1,null)}});return child};registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(module.href)}&&s==='node:child_process')return {url:'startup-peer:spawn',shortCircuit:true};return next(s,c)},load(u,c,next){if(u==='startup-peer:spawn')return {format:'module',source:'export const spawn=globalThis.startupPeer;',shortCircuit:true};return next(u,c)}});`,
    { mode: 0o600 },
  );
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(hook).href, fileURLToPath(module), "acquire-dependencies", plan],
    {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const observed: unknown = JSON.parse(result.stdout);
  assert.ok(
    isRecord(observed) && observed.dependencies_prepared === true && observed.authority === "none",
  );
  const original: unknown = JSON.parse(readFileSync(plan, "utf8"));
  assert.ok(isRecord(original));
  writeFileSync(plan, JSON.stringify({ ...original, expires_at: Date.now() + 190000 }));
  const expired = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(hook).href, fileURLToPath(module), "acquire-dependencies", plan],
    {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
    },
  );
  assert.equal(expired.status, 1);
  assert.match(expired.stdout, /expiry exceeds internal preparation allocation/);
});
