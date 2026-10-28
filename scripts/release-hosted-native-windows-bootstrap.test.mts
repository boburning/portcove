import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t: test.TestContext, code: string) {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "windows-native-bootstrap-"));
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 45000,
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
  assert.equal(
    result.status,
    0,
    JSON.stringify({
      error_code: result.error && "code" in result.error ? result.error.code : null,
      error: result.error?.message,
      signal: result.signal,
      elapsed_milliseconds: Math.round(performance.now() - started),
      stdout: result.stdout,
      stderr: result.stderr,
    }),
  );
  assert.match(result.stdout, /controlled Windows preparation passed/u);
}

void test(
  "Windows bootstrap selects only its platform outputs and refuses drift before bundle import",
  { timeout: 60000 },
  (t) => {
    const entry = new URL("./release-hosted-native-bootstrap.mts", import.meta.url).href;
    fixture(
      t,
      String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';
import {mkdir,writeFile,readFile,stat,realpath as nativeRealpath} from 'node:fs/promises';import path from 'node:path';
const root=process.argv[1], token={};let providerBudget;let budget=10000,caps=Object.freeze({kind:'original controlled capabilities',deadline:10000});
const actual=await import(${JSON.stringify(new URL("./release-controller-tools.mts", import.meta.url).href)});
const {assertControllerBootstrapEnvironment:guard}=await import(${JSON.stringify(new URL("./release-controller-job-bootstrap.mts", import.meta.url).href)});
Object.defineProperties(process,{platform:{value:'win32'},arch:{value:'x64'}});
let fault='',home='',clock=1000,receives=0,imports=0,prepared=0,pathReads=0,connected=false,settlementPathObserved=false;
const source={revision:'a'.repeat(40),execution_ref:'refs/tags/portcove-production-controller-fixture',run_id:'123',run_attempt:1,actor_id:'456'};
const workflow=Buffer.from('fixed Windows workflow');
globalThis.fixture={read:actual.readControllerToolFile,guard,home:()=>home,now:()=>clock,
 workflow:async()=>workflow,
 admit:(policy,env,bytes,platform,stage)=>{assert.equal(platform,'windows-x86_64');assert.equal(stage,'payload-signing');assert.equal(env.GITHUB_JOB,'native_windows');assert.equal(bytes,workflow);if(fault==='source')throw Error('refused source');return source},
 require:(value,job,purpose)=>{assert.equal(value,source);assert.equal(job,'native_windows');assert.equal(purpose,'application')},
 selected:()=>({configuration:{purpose:'application',fixed:'Windows'}}),
 deadline:(platform,identity,cwd,bound)=>{assert.equal(platform,'windows-x86_64');assert.equal(identity.run_id,'123');assert.equal(bound,571000);return providerBudget??budget},
 receive:async(parent,artifact,bundle,options)=>{receives++;assert.equal(path.dirname(parent),home);assert.match(path.basename(parent),/^\.pcn-[a-f0-9]{32}$/);assert.equal(artifact.platform,'windows-x86_64');assert.equal(artifact.artifact_id,3);assert.equal(bundle.artifact_id,4);assert.equal(options.deadline,budget);if(fault==='tools')throw Error('tools refused');if(fault==='late')clock=10001;return token},
 paths:async value=>{pathReads++;if(fault==='late-final'&&pathReads===4)clock=10001;if(fault==='role-final'&&pathReads===4)process.env.PORTCOVE_TUF_ROOT_KEY='inert forbidden';assert.equal(value,token);if(fault==='environment')process.env.GH_TOKEN='changed';return {root:home,node:fault==='node'?path.join(home,'runner.mjs'):process.execPath,platform:fault==='platform'?'linux-x86_64':'windows-x86_64',entries:{'release-hosted-native-runner':path.join(home,'runner.mjs')}}},
 custody:files=>{if(files.length===1){if(fault==='custody')throw Error('foreign ACL');assert.equal((awaitableStat(files[0])).nlink,1)}return new Map(files.map(file=>[file,'fixed']))},
 recheck:(files,before)=>{assert.deepEqual([...before.keys()],files);if(fault==='changed-custody'&&receives)throw Error('changed custody');if(fault==='connected-late-custody'&&settlementPathObserved)clock=5000},
 imported:()=>imports++,prepare:async(raw,parent,deadline,executing)=>{prepared++;assert.equal(raw.tools.artifact.platform,'windows-x86_64');assert.equal(deadline,budget);assert.equal(executing,path.join(home,'runner.mjs'));if(connected){const directory=path.join(parent,'settled');await mkdir(directory);const effective=['connected-short','connected-late-path','connected-late-custody'].includes(fault)?5000:budget;if(fault==='connected-late')clock=budget;else if(['connected-valid','connected-short'].includes(fault))clock=effective-1000;return {deadline:fault==='issuer-final'?500:effective,directory:fault==='connected-escape'?home:directory,scope:'controlled final settlement only',authority:fault==='connected-authority'?'granted':'none'}}return fault==='issuer-final'?{...caps,deadline:500}:caps},
};
const {statSync:awaitableStat,readFileSync}=await import('node:fs');
globalThis.fixture.mkdir=mkdir;globalThis.fixture.writeFile=writeFile;globalThis.fixture.realpath=async directory=>{const observed=await nativeRealpath(directory);if(connected&&path.basename(directory)==='settled'){settlementPathObserved=true;if(fault==='connected-late-path')clock=5000}return observed};
const routes={
 'node:fs/promises':{mkdir:'mkdir',writeFile:'writeFile',realpath:'realpath'},
 'node:os':{homedir:'home'},'node:perf_hooks':{performance:'performance'},
 './release-controller-job-bootstrap.mts':{assertControllerBootstrapEnvironment:'guard'},
 './production-controller-admission.mts':{readProductionControllerWorkflowBytes:'workflow',admitProductionNativeParent:'admit',requireAdmittedProductionSource:'require'},
 './release-authority-configuration-contract.mts':{inspectBoundSelectedPublicationAuthorities:'selected'},
 './release-signing-job-budget.mts':{currentNativeJobDeadline:'deadline'},
 './release-controller-tool-admission.mts':{receiveControllerTools:'receive',verifiedControllerToolPaths:'paths'},
 './release-controller-tools.mts':{controllerToolPaths:'linuxPaths',controllerToolPlatformProfile:'profile',readControllerToolFile:'read'},
 './release-native-runtime-custody.mts':{inspectNativeRuntimeCustody:'custody',recheckNativeRuntimeCustody:'recheck'},
 './heavy-rust-test-lock.mts':{readProcessIdentity:'birth'},
};
globalThis.fixture.birth=pid=>{assert.equal(pid,process.pid);return 'inert-worker-birth'};globalThis.fixture.performance={now:()=>clock};globalThis.fixture.linuxPaths=['never-linux'];globalThis.fixture.profile=platform=>{assert.equal(platform,'windows-x86_64');return {paths:['runner.mjs']}};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(entry)}&&routes[s])return {url:'win-bootstrap:'+s,shortCircuit:true};return next(s,c)},load(u,c,next){if(u===${JSON.stringify(entry)}){const source=readFileSync(new URL(u),'utf8');assert.ok(source.includes('export const hostedWindowsBootstrapExecutionAuthorized = false;'));return {format:'module-typescript',source:source.replace('export const hostedWindowsBootstrapExecutionAuthorized = false;','export const hostedWindowsBootstrapExecutionAuthorized = true;'),shortCircuit:true}}if(u.startsWith('win-bootstrap:'))return {format:'module',source:Object.entries(routes[u.slice('win-bootstrap:'.length)]).map(([name,key])=>'export const '+name+'=globalThis.fixture.'+key+';').join('\n'),shortCircuit:true};return next(u,c)}});
const api=await import(${JSON.stringify(entry)});
for(const name of ['','source','windows-missing','windows-failed','bundle-missing','role','custody','tools','late','node','platform','environment','changed-custody','late-final','role-final','issuer-final']){
 fault=name;receives=0;imports=0;prepared=0;pathReads=0;clock=1000;home=path.join(root,name||'valid');await mkdir(home);
 await writeFile(path.join(home,'manifest.json'),'{}');await writeFile(path.join(home,'runner.mjs'),'globalThis.fixture.imported();export const prepareConfiguredHostedWindowsRuntime=(...a)=>globalThis.fixture.prepare(...a);');
 const needs={tool_bootstrap:{result:'success',outputs:{source_tree:'0'.repeat(40),artifact_id:'1',artifact_sha256:'0'.repeat(64)}},tool_bootstrap_windows:{result:'success',outputs:{source_tree:'b'.repeat(40),artifact_id:'3',artifact_sha256:'c'.repeat(64)}},tool_attest:{result:'success',outputs:{bundle_artifact_id:'2',bundle_artifact_sha256:'0'.repeat(64),windows_bundle_artifact_id:'4',windows_bundle_artifact_sha256:'d'.repeat(64)}}};
 if(name==='windows-missing')delete needs.tool_bootstrap_windows;if(name==='windows-failed')needs.tool_bootstrap_windows.result='failure';if(name==='bundle-missing')delete needs.tool_attest.outputs.windows_bundle_artifact_id;
 process.env.RUNNER_TEMP=home;process.env.GITHUB_JOB='native_windows';process.env.PORTCOVE_CONTROLLER_ADMISSION='fixed';process.env.PORTCOVE_RELEASE_AUTHORITIES='{}';process.env.PORTCOVE_FIXED_NEEDS=JSON.stringify(needs);process.env.GH_TOKEN='inert reader';delete process.env.PORTCOVE_TUF_ROOT_KEY;
 if(name==='role')process.env.PORTCOVE_TUF_ROOT_KEY='inert forbidden test key';
 if(name){await assert.rejects(api.prepareFixedHostedWindowsNativeRuntime());assert.equal(imports,['late-final','role-final','issuer-final'].includes(name)?1:0);assert.equal(prepared,['late-final','role-final','issuer-final'].includes(name)?1:0);continue}
 const result=await api.prepareFixedHostedWindowsNativeRuntime();assert.equal(result,caps);assert.equal(receives,1);assert.equal(imports,1);assert.equal(prepared,1);
 const scope=await api.readActualHostedWindowsBootstrapScope('pre-sign');const directory=path.join(home,'.pcn-'+scope.binding.slice(0,32));
 const record=JSON.parse(await readFile(path.join(directory,'portcove-native-job-clock.json')));assert.equal(record.platform,'windows-x86_64');assert.equal(record.authority,'none');assert.ok(BigInt(record.deadline_ns)-BigInt(record.started_ns)<=570000000000n);
 await assert.rejects(api.prepareFixedHostedWindowsNativeRuntime());assert.equal(receives,1);
 await assert.rejects(api.readActualHostedLinuxBootstrapScope('pre-sign'));await assert.rejects(api.readActualHostedWindowsBootstrapScope('arbitrary'));
}

for(const operation of ['Source','Installation']) {
 fault='';receives=imports=prepared=pathReads=0;clock=1000;budget=500000;home=path.join(root,'full-'+operation);await mkdir(home);process.env.RUNNER_TEMP=home;delete process.env.PORTCOVE_TUF_ROOT_KEY;process.env.GH_TOKEN='inert reader';
 caps=Object.freeze({deadline:budget,source:{},dependencies:{},installation:{}});
 await writeFile(path.join(home,'manifest.json'),'{}');await writeFile(path.join(home,'runner.mjs'),'globalThis.fixture.imported();export const prepareConfiguredHostedWindows'+operation+'=(...a)=>globalThis.fixture.prepare(...a);');
 const result=await api['prepareFixedHostedWindowsNative'+operation]();assert.equal(result,caps);assert.equal(prepared,1);assert.equal(imports,1);assert.equal(result.deadline,budget);
 await assert.rejects(api['prepareFixedHostedWindowsNative'+operation]());assert.equal(receives,1);
}
// Only this isolated admitted-bundle peer opens the bootstrap gate. Actual account/runner gates are untouched.
connected=true;budget=10000;
for(const name of ['connected-valid','connected-short','connected-late-path','connected-late-custody','connected-late','connected-escape','connected-authority','issuer-final','late-final','role-final']) {
 fault=name;settlementPathObserved=false;receives=imports=prepared=pathReads=0;clock=1000;home=path.join(root,'connected-'+name);await mkdir(home);process.env.RUNNER_TEMP=home;delete process.env.PORTCOVE_TUF_ROOT_KEY;process.env.GH_TOKEN='inert reader';
 await writeFile(path.join(home,'manifest.json'),'{}');await writeFile(path.join(home,'runner.mjs'),'globalThis.fixture.imported();export const runConfiguredHostedWindowsNativeJob=(...a)=>globalThis.fixture.prepare(...a);');
 const run=()=>api.launchFixedHostedWindowsNativeJob();
 if(['connected-valid','connected-short'].includes(name)){const effective=name==='connected-short'?5000:budget;const result=await run();assert.equal(result.deadline,effective);assert.equal(result.authority,'none');assert.equal(clock,effective-1000);assert.equal(imports,1);assert.equal(prepared,1);await assert.rejects(run());assert.equal(receives,1)}
 else {await assert.rejects(run());assert.equal(prepared,1)}
}
// Actual bootstrap caller clamp; provider/tool peers remain inert.
const originalHrtime=process.hrtime.bigint;process.hrtime.bigint=()=>1000000000n;providerBudget=10000;
try {
 for(const mode of ['shorter','longer','expired','over-bound','changed-intent']) {
  fault='connected-valid';connected=true;budget=mode==='shorter'?6000:10000;clock=1000;receives=imports=prepared=pathReads=0;
  home=path.join(root,'caller-'+mode);await mkdir(home);process.env.RUNNER_TEMP=home;delete process.env.PORTCOVE_TUF_ROOT_KEY;process.env.GH_TOKEN='inert reader';
  await writeFile(path.join(home,'manifest.json'),'{}');await writeFile(path.join(home,'runner.mjs'),'globalThis.fixture.imported();export const runConfiguredHostedWindowsNativeJob=(...a)=>globalThis.fixture.prepare(...a);');
  const end=mode==='shorter'?6000000000n:mode==='expired'?1000000000n:mode==='over-bound'?571000000001n:21000000000n;
  const scope=await api.readActualHostedWindowsBootstrapScope('pre-sign');
  await writeFile(path.join(home,'portcove-native-windows-workflow-start.json'),JSON.stringify({binding:scope.binding,platform:'windows-x86_64',deadline_ns:String(mode==='changed-intent'?end-1n:end),authority:'none',automatic_retry:false}));
  if(['shorter','longer'].includes(mode)) {
   const result=await api.launchFixedHostedWindowsNativeJob(end);assert.equal(result.deadline,budget);assert.equal(receives,1);
   const nativeRoot=path.join(home,'.pcn-'+scope.binding.slice(0,32));const row=JSON.parse(await readFile(path.join(nativeRoot,'portcove-native-job-clock.json')));
   assert.equal(BigInt(row.deadline_ns),1000000000n+BigInt(budget-1000)*1000000n);
   assert.equal(JSON.parse(await readFile(path.join(nativeRoot,'native-supervision-started.json'))).identity,'inert-worker-birth');
  } else {await assert.rejects(api.launchFixedHostedWindowsNativeJob(end));assert.equal(receives,0);assert.equal(imports,0)}
 }
} finally {process.hrtime.bigint=originalHrtime}
console.log('controlled Windows preparation passed');
`,
    );
  },
);

void test(
  "Windows bundle joins original source/runtime capabilities without account, proof or settlement effects",
  { timeout: 60000 },
  (t) => {
    const entry = new URL("./release-hosted-native-runner.mts", import.meta.url).href;
    fixture(
      t,
      String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import path from 'node:path';
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises';import {statSync,existsSync} from 'node:fs';
const root=process.argv[1], tools={},parent={},runtime={}, producer={controller_revision:'a'.repeat(40),configuration_sha256:'b'.repeat(64),grant_sha256:'c'.repeat(64),workflow_sha256:'d'.repeat(64)};
const {assertControllerBootstrapEnvironment:guard}=await import(${JSON.stringify(new URL("./release-controller-job-bootstrap.mts", import.meta.url).href)});
Object.defineProperties(process,{platform:{value:'win32'},arch:{value:'x64'}});
let fault='',folder='',now=1000,receives=0,parents=0,runtimes=0,evidenceReads=0;
globalThis.fixture={guard,performance:{now:()=>now},
 receive:async(directory,artifact,bundle,options)=>{receives++;assert.equal(directory,folder);assert.equal(artifact.platform,'windows-x86_64');assert.equal(options.deadline,6000);if(fault==='receiver')throw Error('receiver refused');if(fault==='late')now=7000;if(fault==='role-drift')process.env.PORTCOVE_TUF_ROOT_KEY='inert forbidden';return tools},
 paths:async value=>{assert.equal(value,tools);return {root:folder,platform:'windows-x86_64'}},
 custody:files=>{if(fault==='custody'||(fault==='evidence'&&files.length===3))throw Error('foreign custody');for(const file of files)assert.equal(statSync(file).nlink,1,'custody anchor must be a single-link file');return new Map(files.map(file=>[file,'fixed']))},
 recheck:(files,before)=>{assert.deepEqual([...before.keys()],files);if(files.length===3&&++evidenceReads===2){if(fault==='evidence-final')now=7000;if(fault==='issuer-final')now=2500}},
 create:async(directory,platform,stage,deadline)=>{parents++;assert.equal(directory,folder);assert.equal(platform,'windows-x86_64');assert.equal(stage,'payload-signing');assert.equal(deadline,6000);if(fault==='parent')throw Error('source refused');const dir=path.join(folder,'parent');await mkdir(dir);for(const name of ['source','configuration','identity'])await writeFile(path.join(dir,name+'.json'),'{}');return parent},
 requireParent:async value=>{assert.equal(value,parent);return {directory:path.join(folder,'parent'),producer,deadline:fault==='issuer-final'?2000:6000,recheck:()=>assert.ok(now<(fault==='issuer-final'?2000:6000),'issuer expired')}},
 prepare:async(t,p,e)=>{runtimes++;assert.equal(t,tools);assert.equal(p,parent);assert.equal(e,'fixed attested executing entry');if(fault==='runtime')throw Error('runtime refused');return runtime},
 requireRuntime:async(r,p)=>{assert.equal(r,runtime);assert.equal(p,parent);if(fault==='runtime-readback')throw Error('runtime changed');return {root:folder,deadline:6000}},
};
const routes={
 'node:perf_hooks':{performance:'performance'},
 './release-controller-job-bootstrap.mts':{assertControllerBootstrapEnvironment:'guard'},
 './release-controller-tool-admission.mts':{receiveControllerTools:'receive',verifiedControllerToolPaths:'paths'},
 './release-native-runtime-custody.mts':{inspectNativeRuntimeCustody:'custody',recheckNativeRuntimeCustody:'recheck'},
 './release-hosted-native-parent.mts':{createActualHostedNativeParentSource:'create',requireActualHostedNativeParentSource:'requireParent'},
 './release-hosted-native-runtime.mts':{prepareHostedNativeRuntime:'prepare',requireHostedNativeRuntime:'requireRuntime'},
};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(entry)}&&routes[s])return {url:'win-runtime:'+s,shortCircuit:true};return next(s,c)},load(u,c,next){if(u.startsWith('win-runtime:'))return {format:'module',source:Object.entries(routes[u.slice('win-runtime:'.length)]).map(([name,key])=>'export const '+name+'=globalThis.fixture.'+key+';').join('\n'),shortCircuit:true};return next(u,c)}});
const api=await import(${JSON.stringify(entry)});
for(const name of ['','missing-platform','linux-platform','role-entry','custody','receiver','late','role-drift','parent','evidence','runtime','runtime-readback','evidence-final','issuer-final']){
 fault=name;folder=path.join(root,name||'valid');await mkdir(folder);await writeFile(path.join(folder,'manifest.json'),'{}');now=1000;receives=parents=runtimes=evidenceReads=0;delete process.env.PORTCOVE_TUF_ROOT_KEY;
 const raw={tools:{artifact:{platform:'windows-x86_64'},bundle:{}}};if(name==='missing-platform')delete raw.tools.artifact.platform;if(name==='linux-platform')raw.tools.artifact.platform='linux-x86_64';if(name==='role-entry')process.env.PORTCOVE_TUF_ROOT_KEY='inert forbidden';
 const prepare=()=>api.prepareConfiguredHostedWindowsRuntime(raw,folder,6000,'fixed attested executing entry');
 if(name){await assert.rejects(prepare());assert.equal(existsSync(path.join(folder,'windows-runtime-prepared.json')),['evidence-final','issuer-final'].includes(name));if(['missing-platform','linux-platform','role-entry','custody'].includes(name))assert.equal(receives,0);if(['receiver','late','role-drift'].includes(name))assert.equal(parents,0);continue}
 const prepared=await prepare();assert.equal(prepared.tools,tools);assert.equal(prepared.parent,parent);assert.equal(prepared.runtime,runtime);
 assert.equal((await stat(path.join(folder,'windows-runtime-preparation-intent.json'))).nlink,1);
 const report=JSON.parse(await readFile(path.join(folder,'windows-runtime-prepared.json')));assert.deepEqual(report.producer,producer);assert.equal(report.candidate_isolation,'unproven');assert.equal(report.native_acceptance,'not-established');assert.equal(report.production_tool_acceptance,'not-established');assert.equal(report.authority,'none');assert.equal(existsSync(path.join(folder,'native-job-settlement.json')),false);
 await assert.rejects(prepare());assert.equal(receives,1);assert.equal(parents,1);assert.equal(runtimes,1);
}
console.log('controlled Windows preparation passed');
`,
    );
  },
);

void test("Windows connected execution and proof holds refuse before preparation, credentials or provider requests", (t) => {
  fixture(
    t,
    String.raw`
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
let requests=0;globalThis.fetch=()=>{requests++;throw Error('provider request forbidden')};
const bootstrap=await import(${JSON.stringify(new URL("./release-hosted-native-bootstrap.mts", import.meta.url).href)});
assert.equal(bootstrap.hostedWindowsBootstrapExecutionAuthorized,false);
await assert.rejects(bootstrap.launchFixedHostedWindowsNativeJob(),/awaits separate owner authority/);
const runner=await import(${JSON.stringify(new URL("./release-hosted-native-runner.mts", import.meta.url).href)});
assert.equal(runner.hostedWindowsNativeJobExecutionAuthorized,false);
await assert.rejects(runner.runConfiguredHostedWindowsNativeJob({},process.argv[1],performance.now()+1000,'foreign'),/awaits separate owner authority/);
const session=await import(${JSON.stringify(new URL("./release-hosted-native-windows-session.mts", import.meta.url).href)});
assert.equal(session.hostedWindowsSessionExecutionAuthorized,false);
await assert.rejects(session.startActualHostedWindowsSession({}),/authority/);
await assert.rejects(session.refuseActualHostedWindowsSession({},Error('foreign')),/Original Windows session/);
const proof=await import(${JSON.stringify(new URL("./release-hosted-native-proof-producer.mts", import.meta.url).href)});
assert.equal(proof.hostedWindowsProofExecutionAuthorized,false);
await assert.rejects(proof.signActualHostedWindowsNativeProof({}),/awaits separate owner authority/);
assert.equal(requests,0);assert.deepEqual(await readdir(process.argv[1]),[]);
console.log('controlled Windows preparation passed; held connection refused before effects');
`,
  );
});
