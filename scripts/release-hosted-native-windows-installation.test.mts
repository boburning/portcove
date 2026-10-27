import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  prepareActualHostedWindowsInstallation,
  requireActualHostedWindowsInstallation,
} from "./release-hosted-native-windows-installation.mts";

void test("Windows installation refuses public/replayed observations and non-Windows execution", async () => {
  await assert.rejects(
    requireActualHostedWindowsInstallation({
      kind: "original-hosted-windows-installation",
      authority: "none",
    }),
  );
  await assert.rejects(prepareActualHostedWindowsInstallation({}));
});

void test("Controlled Windows installation joins exact originals, clips acquisition and invalidates drift", () => {
  const module = new URL("./release-hosted-native-windows-installation.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {performance} from 'node:perf_hooks';
import {assertControllerBootstrapEnvironment as guard} from ${JSON.stringify(new URL("./release-controller-job-bootstrap.mts", import.meta.url).href)};
import {coordinatorCommandTimeout} from ${JSON.stringify(new URL("./release-coordinator-deadline.mts", import.meta.url).href)};
Object.defineProperties(process,{platform:{value:'win32'},arch:{value:'x64'}});
let parent,dependencies,candidate,fault='',shift=0,reads=0,acquisitions=0;
const now=()=>performance.now()+shift;
globalThis.installationPeers={clock:{now},guard,
 original:async value=>{assert.equal(value,dependencies);return {parent,deadline:parent.deadline}},
 dependencies:async value=>{assert.equal(value,dependencies);if(fault==='preflight-late')shift=100000;if(fault==='preflight-role')process.env.PORTCOVE_TUF_ROOT_KEY='inert';return {parent,tools:{},runtime:{},root:'private-source'}},
 parent:async value=>{assert.equal(value,parent);parent.recheck();return parent},
 acquire:async value=>{assert.equal(value,parent);acquisitions++;const left=coordinatorCommandTimeout(900000);assert.ok(left<=90000);if(fault==='clipped')assert.ok(left<=40000);if(fault==='late')shift=100000;return candidate},
 candidate:async value=>{assert.equal(value,candidate);reads++;if(fault==='role')process.env.PORTCOVE_TUF_ROOT_KEY='inert';return {parent_source:fault==='mixed'||(fault==='getter-mixed'&&reads>1)?{}:parent,platform_label:fault==='platform'?'linux-x86_64':'windows-x86_64',stage:fault==='stage'?'release-publication':'payload-signing'}}};
const routes={'node:perf_hooks':{performance:'clock'},'./release-hosted-native-parent.mts':{requireActualHostedNativeParentSource:'parent'},'./release-hosted-native-windows-source.mts':{requireActualHostedWindowsDependencies:'dependencies',requireActualHostedWindowsDependencyParent:'original'},'./release-hosted-native-candidate.mts':{acquireActualHostedNativeCandidate:'acquire',requireActualHostedNativeCandidate:'candidate'},'./release-controller-job-bootstrap.mts':{assertControllerBootstrapEnvironment:'guard'}};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(module)}&&routes[s])return {url:'installation-controls:'+s,shortCircuit:true};return next(s,c)},load(u,c,next){if(u.startsWith('installation-controls:'))return {format:'module',source:Object.entries(routes[u.slice(22)]).map(([name,key])=>'export const '+name+'=globalThis.installationPeers.'+key+';').join(''),shortCircuit:true};return next(u,c)}});
const api=await import(${JSON.stringify(module)});
for(const scenario of ['valid','clipped','mixed','platform','stage','late','role','no-reserve','getter-mixed','preflight-late','preflight-role']){
 fault=scenario;shift=reads=acquisitions=0;delete process.env.PORTCOVE_TUF_ROOT_KEY;dependencies={};candidate={};parent={platform_label:'windows-x86_64',stage:'payload-signing',configuration:{purpose:'application'},deadline:now()+(scenario==='clipped'?250000:scenario==='no-reserve'?200000:500000),recheck(){assert.ok(now()<this.deadline)}};
 const failure=['mixed','platform','stage','late','role','no-reserve','preflight-late','preflight-role'].includes(scenario);
 if(failure){await assert.rejects(api.prepareActualHostedWindowsInstallation(dependencies),scenario);delete process.env.PORTCOVE_TUF_ROOT_KEY;shift=0;await assert.rejects(api.prepareActualHostedWindowsInstallation(dependencies),scenario==='no-reserve'?/deadline/:/one Windows candidate join/);assert.equal(acquisitions,['no-reserve','preflight-late','preflight-role'].includes(scenario)?0:1);continue}
 const receipt=await api.prepareActualHostedWindowsInstallation(dependencies);assert.equal(acquisitions,1);await assert.rejects(api.requireActualHostedWindowsInstallation({...receipt}));
 if(scenario==='getter-mixed'){await assert.rejects(api.requireActualHostedWindowsInstallation(receipt));fault='';await assert.rejects(api.requireActualHostedWindowsInstallation(receipt),/original hosted Windows installation required/);continue}
 const result=await api.requireActualHostedWindowsInstallation(receipt);assert.equal(result.dependencies,dependencies);assert.equal(result.candidate,candidate);assert.equal(result.parent,parent);await assert.rejects(api.prepareActualHostedWindowsInstallation(dependencies),/one Windows candidate join/);
}
console.log('controlled Windows installation joins passed; no actual candidate/account/GUI acceptance');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
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
  assert.match(result.stdout, /controlled Windows installation joins passed/u);
});
