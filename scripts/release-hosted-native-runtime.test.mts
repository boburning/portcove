/** Controlled original providers exercise the real runtime state; no native credit. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

void test("Windows runtime continuation shares both parents, the shorter clock and permanent stop with old support callbacks", () => {
  const entry = new URL("./release-hosted-native-runtime.mts", import.meta.url).href;
  const source = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import path from 'node:path';import {createHash} from 'node:crypto';
Object.defineProperty(process,'platform',{value:'win32'});
const parents=new WeakMap(),tools=new WeakMap(),files=new Map(),hash=b=>createHash('sha256').update(b).digest('hex');let clock=10,corrupt=false,gate;
const fixed={source:'support.txt',metadata:'support.json',binary:'support.exe',product:'fixture-supervisor',arguments:[]};
globalThis.runtimeJoinFixture={clock:{now:()=>clock},paths:async receipt=>{assert.ok(tools.has(receipt),'original tool');return tools.get(receipt)},parent:async receipt=>{assert.ok(parents.has(receipt),'original parent');const p=parents.get(receipt);p.recheck();return p},
 read:async file=>{assert.ok(files.has(file),file);return corrupt?Buffer.from('drift'):Buffer.from(files.get(file))},manifest:value=>value,
 profile:()=>fixed,support:()=>({compiler:'controlled',input_fingerprint:'fingerprint',output:{mode:448}}),fingerprint:()=>({fingerprint:'fingerprint'}),
 custody:()=>new Map(),recheck:()=>{},realpath:async file=>file,lstat:async file=>{if(gate&&file===gate.file){const current=gate;gate=undefined;current.enter();await current.wait}return {mode:448,isFile:()=>true,isSymbolicLink:()=>false}},
 prepared:async(_input,active,stop)=>({rustSupportCompilerIdentity:async()=>{active();return {fixture:true}},prepareSupportArtifact:async()=>{active();return {fixture:true}},stop})};
const routes={'./release-controller-tool-admission.mts':{verifiedControllerToolPaths:'paths'},'./release-controller-tools.mts':{readControllerToolFile:'read',inspectControllerToolManifest:'manifest'},'./release-hosted-native-parent.mts':{requireActualHostedNativeParentSource:'parent'},'./release-native-runtime-support.mts':{nativeRuntimeSupportProfile:'profile',inspectNativeRuntimeSupport:'support',preparedNativeSupportDependencies:'prepared'},'./rust-support-cache.mts':{rustSupportInputIdentity:'fingerprint'},'./release-native-runtime-custody.mts':{inspectNativeRuntimeCustody:'custody',recheckNativeRuntimeCustody:'recheck'},'node:fs/promises':{realpath:'realpath',lstat:'lstat'},'node:perf_hooks':{performance:'clock'}};
const entry=${JSON.stringify(entry)};
registerHooks({resolve(specifier,context,next){if(context.parentURL===entry&&routes[specifier])return {url:'fixture:'+encodeURIComponent(specifier),shortCircuit:true};return next(specifier,context)},load(url,context,next){if(url.startsWith('fixture:'))return {format:'module',source:Object.entries(routes[decodeURIComponent(url.slice(8))]).map(([name,value])=>'export const '+name+'=globalThis.runtimeJoinFixture.'+value+';').join('\n'),shortCircuit:true};return next(url,context)}});
const api=await import(entry);let serial=0;
function fixture(){clock=10;corrupt=false;const root=path.resolve('controlled-runtime-'+(++serial)),node=Buffer.from('inert-node'),binary=Buffer.from('inert-supervisor'),support=Buffer.from('inert-source'),metadata=Buffer.from('{}');
 const rows=[['bin/node.exe',node],['support.txt',support],['support.exe',binary],['support.json',metadata],['scripts/release-hosted-native-runner.bundle.mjs',Buffer.from('inert-entry')]];
 const manifest={source_commit:'a'.repeat(40),source_tree:'b'.repeat(40),files:rows.map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:hash(bytes)}))};
 for(const [name,bytes] of rows)files.set(path.join(root,name),bytes);files.set(path.join(root,'manifest.json'),Buffer.from(JSON.stringify(manifest)));files.set(process.execPath,node);
 const producer={controller_revision:'a'.repeat(40),controller_ref:'refs/tags/v1.0.0',run_id:'2',run_attempt:1,job_id:3,check_run_id:'4'},configuration={purpose:'application',selected:'fixed'};
 const pre={},post={},tool={},state={pre:true,post:true};
 for(const [receipt,stage,key,deadline] of [[pre,'payload-signing','pre',1000],[post,'release-publication','post',800]])parents.set(receipt,{producer:{...producer},configuration:{...configuration},platform_label:'windows-x86_64',stage,deadline,recheck:()=>{assert.ok(state[key]&&clock<parents.get(receipt).deadline,'original parent stopped')}});
 tools.set(tool,{root,node:path.join(root,'bin/node.exe'),platform:'windows-x86_64',identity:{source_tree:'b'.repeat(40),controller_revision:producer.controller_revision,controller_ref:producer.controller_ref,run_id:producer.run_id,run_attempt:1}});
 return {root,pre,post,tool,state,entry:path.join(root,'scripts/release-hosted-native-runner.bundle.mjs')};
}
async function prepare(){const f=fixture();f.runtime=await api.prepareHostedNativeRuntime(f.tool,f.pre,f.entry);f.old=await api.hostedNativeSupportDependencies(f.runtime,f.pre,f.root);return f}
let f=await prepare();assert.equal(await api.joinHostedWindowsPostSignRuntime(f.runtime,f.pre,f.post),f.runtime);assert.equal((await api.requireHostedNativeRuntime(f.runtime,f.post)).deadline,800);const fresh=await api.hostedNativeSupportDependencies(f.runtime,f.post,f.root);await f.old.rustSupportCompilerIdentity();await fresh.prepareSupportArtifact();clock=801;await assert.rejects(f.old.rustSupportCompilerIdentity());clock=10;await assert.rejects(fresh.prepareSupportArtifact());await assert.rejects(api.requireHostedNativeRuntime(f.runtime,f.pre));
for(const kind of ['cloned-post','mixed-job','mixed-config','wrong-stage','longer-post','foreign-tools','second-post','post-expired','post-revoked','restored-drift']){
 f=await prepare();let post=f.post;
 if(kind==='cloned-post')post={...post};if(kind==='mixed-job')parents.get(post).producer.job_id=99;if(kind==='mixed-config')parents.get(post).configuration.selected='foreign';if(kind==='wrong-stage')parents.get(post).stage='payload-signing';if(kind==='longer-post')parents.get(post).deadline=1100;if(kind==='foreign-tools')tools.get(f.tool).root+='/foreign';
 if(['second-post','post-expired','post-revoked','restored-drift'].includes(kind)){await api.joinHostedWindowsPostSignRuntime(f.runtime,f.pre,post);if(kind==='post-expired')clock=801;if(kind==='post-revoked')f.state.post=false;if(kind==='restored-drift')corrupt=true;}
 if(kind==='second-post')await assert.rejects(api.joinHostedWindowsPostSignRuntime(f.runtime,f.pre,post));else if(['post-expired','post-revoked','restored-drift'].includes(kind))await assert.rejects(api.requireHostedNativeRuntime(f.runtime,post));else await assert.rejects(api.joinHostedWindowsPostSignRuntime(f.runtime,f.pre,post));
 clock=10;corrupt=false;f.state.post=true;await assert.rejects(f.old.prepareSupportArtifact(),kind);await assert.rejects(api.requireHostedNativeRuntime(f.runtime,f.pre),kind);
}
f=await prepare();await api.joinHostedWindowsPostSignRuntime(f.runtime,f.pre,f.post);let enter,release;const entered=new Promise(resolve=>enter=resolve),wait=new Promise(resolve=>release=resolve);gate={file:path.join(f.root,'support.exe'),enter,wait};const reading=api.requireHostedNativeRuntime(f.runtime,f.post);await entered;await assert.rejects(api.joinHostedWindowsPostSignRuntime(f.runtime,f.pre,f.post));release();await assert.rejects(reading);await assert.rejects(f.old.rustSupportCompilerIdentity());
console.log('same original runtime, both parents, immutable earlier deadline and old/new callbacks verified; no provider/native acceptance');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 32768,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /old\/new callbacks verified/u);
});
