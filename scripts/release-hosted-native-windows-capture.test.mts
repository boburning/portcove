/** Controlled original-stage peer; real retained bytes/custody, no account or native execution. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import os from "node:os";
import path from "node:path";

void test("Windows capture retains empty streams and original identities, then permanently refuses drift and foreign receipts", (t) => {
  const root = disposableDirectory(t, path.join(os.homedir(), ".hosted-windows-capture-"));
  const entry = new URL("./release-hosted-native-windows-capture.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {mkdir,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';
const root=process.argv[1],parent={},runtime={},stage={},tools={},system=new Map(),nonce='a'.repeat(64);
let started=false,settled=false,revoked=false,systemChanged=false,spawned=0;
const directory=path.join(root,'stage');await mkdir(directory,{mode:0o700});await mkdir(path.join(directory,'isolated-account-desktop'));
const host={schema_version:1,nonce,architecture:'x86_64',machine_id_sha256:'c'.repeat(64),broker_sid:'S-1-5-21-1-2-3-1000',os:{}};
const actual=()=>({parent,runtime,tools,tool_paths:{root},system_custody:system,directory,deadline:performance.now()+30000,host,hostNonce:nonce,prepared:{request:{invocation_id:'inert'},request_sha256:'d'.repeat(64)},started,settled});
for(const name of ['account-binding.json','worker-input.json','worker-ready.json','worker-result.json','installer.json','isolated-account-desktop/native-runtime-capabilities.json','isolated-account-desktop/native-runtime-processes.json','isolated-account-desktop/evidence.json'])await writeFile(path.join(directory,name),'{}',{mode:0o600});
await writeFile(path.join(directory,'bridge-state.json'),JSON.stringify({phase:'settled',roots:[{id:'root-one'}]}));
for(const name of ['root-one.stdout.bin','root-one.stderr.bin','harness.stdout.bin','harness.stderr.bin'])await writeFile(path.join(directory,name),Buffer.alloc(0));
globalThis.fixture={
 requireStage:async value=>{assert.equal(value,stage);assert.ok(!revoked,'original stage revoked');return actual()},
 start:async value=>{assert.equal(value,stage);assert.equal(started,false);started=true},
 settle:async value=>{assert.equal(value,stage);assert.equal(started,true);settled=true},
 parent:async value=>{assert.equal(value,parent);return {deadline:performance.now()+30000}},
 runtime:async(value,p)=>{assert.equal(value,runtime);assert.equal(p,parent);return {root}},
 system:()=>{assert.ok(!systemChanged,'system custody drift')},
 exec:(file,args,options)=>{spawned++;assert.ok(file.endsWith('powershell.exe'));assert.equal(options.cwd,root);assert.equal(options.env.GH_TOKEN,undefined);assert.equal(options.timeout<=30000,true);return JSON.stringify({machine_id_sha256:'c'.repeat(64)})},
};
const real=await import(${JSON.stringify(new URL("./release-native-runtime-custody.mts", import.meta.url).href)});
globalThis.fixture.inspect=real.inspectNativeRuntimeCustody;globalThis.fixture.recheck=real.recheckNativeRuntimeCustody;
const routes={
 './release-hosted-native-windows-session.mts':{requireActualHostedWindowsStage:'requireStage',startActualHostedWindowsStage:'start',settleActualHostedWindowsStage:'settle'},
 './release-hosted-native-parent.mts':{requireActualHostedNativeParentSource:'parent'},
 './release-hosted-native-runtime.mts':{requireHostedNativeRuntime:'runtime'},
 './release-native-runtime-custody.mts':{inspectNativeRuntimeCustody:'inspect',recheckNativeRuntimeCustody:'recheck',recheckWindowsSourceSystemCustody:'system'},
 'node:child_process':{execFileSync:'exec'},
};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(entry)}&&routes[s])return {url:'capture-fixture:'+s,shortCircuit:true};return next(s,c)},load(u,c,next){if(u.startsWith('capture-fixture:')){const name=u.slice('capture-fixture:'.length);return {format:'module',source:Object.entries(routes[name]).map(([k,v])=>'export const '+k+'=globalThis.fixture.'+v+';').join('\n')+(name==='./release-native-runtime-custody.mts'?';export const windowsSourceSystemExecutables={powershell:"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"};':''),shortCircuit:true}}return next(u,c)}});
const api=await import(${JSON.stringify(entry)});
await assert.rejects(api.captureActualHostedNativeWindowsInvocation({}));assert.equal(spawned,0);
await assert.rejects(api.requireActualHostedNativeWindowsCapture({}));
const receipt=await api.captureActualHostedNativeWindowsInvocation(stage);assert.equal(spawned,1);
const got=await api.requireActualHostedNativeWindowsCapture(receipt);assert.equal(got.status,0);assert.equal(got.actual.parent,parent);assert.equal(got.result.native_acceptance,'not-established');
assert.ok(got.original_file_identities.some(row=>row.name==='harness.stderr.bin'&&row.bytes===0));
await assert.rejects(api.requireActualHostedNativeWindowsCapture({...receipt}));
await assert.rejects(api.captureActualHostedNativeWindowsInvocation(stage),/One original/);
const file=path.join(directory,'installer.json'),original=await readFile(file);await writeFile(file,'changed');
await assert.rejects(api.requireActualHostedNativeWindowsCapture(receipt));await writeFile(file,original);
await assert.rejects(api.requireActualHostedNativeWindowsCapture(receipt),/Original active/);
console.log('controlled Windows capture custody passed');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /controlled Windows capture custody passed/u);
});
