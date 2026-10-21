import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  captureActualLinuxPublicJourney,
  requireActualLinuxPublicCapture,
  inspectLinuxPublicTechnicalClosure,
} from "./release-native-linux-public-capture.mts";

void test("actual installed worker routes mocked public phases to Linux claim/capture/settlement without Windows or Check issuance", () => {
  const worker = new URL("./release-native-worker.mts", import.meta.url).href;
  const script = String.raw`
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
Object.defineProperty(process,'platform',{value:'win32'}); // Fixed Windows Task control flow only, never a host claim.
const worker=${JSON.stringify(worker)};
let phase='initial-v0-v1', linux=true;
const calls=[];
const parent={},pair={},historical={},claim={},capture={};
globalThis.fixture={
 call(name,...args){calls.push(name);return {name,args}},
 establish(){calls.push('parent');return parent},
 requireParent(){return {descriptor:{platform_label:linux?'linux-x86_64':'windows-x86_64'}}},
 route(){calls.push('phase');if(phase==='contradictory')throw Error('ambiguous original history');return {phase:phase==='continue-with-v2'?'await-published-v2':phase,historical_cohort_receipt:historical}},
 initial(){calls.push('initial-pair');return pair},
 continued(p,h){assert.equal(p,parent);assert.equal(h,historical);calls.push('continuation-pair');return pair},
 progress(p){assert.equal(p,pair);return {phase}},
 package(p,slot){assert.equal(p,pair);calls.push('package:'+slot);return {slot}},
 claim(p,inputs){assert.deepEqual(Object.keys(inputs).sort(),phase==='continue-with-v2'?['candidate_package','pair','parked_package','prior_package']:['candidate_package','pair','prior_package']);assert.equal(inputs.pair,pair);calls.push('claim');return claim},
 capture(c){assert.equal(c,claim);calls.push('linux-capture');return capture},
 getter(c){assert.equal(c,capture);calls.push('linux-getter')},
 record(c){assert.equal(c,capture);calls.push('linux-settlement');return {authority:'none'}},
 fail(){throw Error('unexpected Windows, native-stage, compiler, or Check path')},
};
const f=globalThis.fixture;
const modules={
 './release-native-parent.mts':{establishActualNativeParent:'establish',requireActualNativeParent:'requireParent'},
 './release-native-candidate.mts':{acquireActualNativeStageCandidate:'fail',readActualNativeWorkerDispatch:'public-route'},
 './release-native-attempt.mts':{claimActualNativeInvocation:'fail',readActualPublicJourneyParentPhase:'route',readActualPublicJourneyProgress:'progress',claimActualPublicJourneyInvocation:'claim',recordActualLinuxPublicSettlement:'record',recordActualWindowsPublicSettlement:'fail'},
 './release-native-public-pair.mts':{acquireActualPublicJourneyPair:'initial',acquireActualPublicJourneyContinuationPair:'continued',materializeActualPublicJourneyPackage:'package'},
 './release-native-windows-capture.mts':{captureActualWindowsNativeInvocation:'fail',captureActualWindowsPublicJourney:'fail',requireActualWindowsPublicCapture:'fail'},
 './release-native-linux-public-capture.mts':{captureActualLinuxPublicJourney:'capture',requireActualLinuxPublicCapture:'getter'},
 './release-native-public-compiler.mts':{collectActualPublicWindowsCompilerIdentity:'fail'},
 './release-native-pre-sign-report.mts':{prepareActualNativeStageReport:'fail',retainActualFailedNativeStage:'fail'},
 './release-native-check-broker.mts':{publishActualNativeStageReport:'fail'},
 './release-native-wsl-capture.mts':{captureActualWslNativeInvocation:'fail'},
 './release-native-linux-report.mts':{prepareActualLinuxNativeStageReport:'fail',retainActualFailedLinuxNativeStage:'fail'},
};
registerHooks({resolve(specifier,context,next){
 if(context.parentURL===worker&&!specifier.startsWith('node:')){
  const exports=modules[specifier];assert.ok(exports,'unexpected dependency:'+specifier);
  const text=Object.entries(exports).map(([name,key])=>'export const '+name+'=async(...args)=>'+(key==='public-route'?'"public"':'globalThis.fixture.'+key+'(...args)')+';').join('\n');
  return {url:'data:text/javascript,'+encodeURIComponent(text),shortCircuit:true};
 }
 return next(specifier,context);
}});
const {runInstalledNativeWorker}=await import(worker);
for(const value of ['initial-v0-v1','park-v0-with-v1','continue-with-v2']){
 phase=value;calls.length=0;const result=await runInstalledNativeWorker('inert','hash');
 assert.equal(result.authority,'none');assert.deepEqual(calls,['parent','phase',value==='continue-with-v2'?'continuation-pair':'initial-pair','package:prior','package:candidate',...(value==='continue-with-v2'?['package:parked']:[]),'claim','linux-capture','linux-getter','linux-settlement']);
}
phase='completed';calls.length=0;await runInstalledNativeWorker('inert','hash');assert.deepEqual(calls,['parent','phase']);
phase='contradictory';calls.length=0;await assert.rejects(runInstalledNativeWorker('inert','hash'),/ambiguous original history/);assert.deepEqual(calls,['parent','phase']);
phase='continue-with-v2';linux=false;calls.length=0;await runInstalledNativeWorker('inert','hash');assert.deepEqual(calls,['parent','phase','continuation-pair']);
console.log('actual-worker-mocked-route-pass');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /actual-worker-mocked-route-pass/u);
});

void test("raw public descriptors cannot enter actual Linux capture or rehydrate its private custody", async () => {
  for (const raw of [
    {},
    { kind: "actual-public-journey-invocation", authority: "none" },
    { phase: "initial-v0-v1", parent: {} },
  ]) {
    await assert.rejects(
      captureActualLinuxPublicJourney(raw),
      /actual freshly claimed public invocation required/u,
    );
    await assert.rejects(
      requireActualLinuxPublicCapture(raw),
      /actual installed Linux public capture required/u,
    );
  }
});
void test("the same invocation cannot enter twice while its first authentication is pending", async () => {
  const raw = {};
  const first = captureActualLinuxPublicJourney(raw);
  const second = captureActualLinuxPublicJourney(raw);
  await assert.rejects(first, /actual freshly claimed public invocation required/u);
  await assert.rejects(second, /one-shot; reconcile original retained invocation/u);
});

void test("technical closure requires original Linux unit generation and positive group emptiness", () => {
  const id = "a".repeat(64),
    request = "b".repeat(64),
    raw = {
      invocation_id: id,
      request_sha256: request,
      authority: "none",
      unit: `portcove-native-${id}.service`,
      unit_invocation_id: "c".repeat(32),
      cgroup_empty: true,
      unit_settled: true,
      cgroup_settlement: "observed-unpopulated",
      cgroup_identity: { device: 1, inode: 2 },
      root_identity: { pid: 123, creation_ticks: "456" },
      exit_code: 0,
      completed_at: "2026-10-21T00:00:00.000Z",
    };
  const result = inspectLinuxPublicTechnicalClosure(raw, id, request);
  assert.equal(result.roots[0]?.creation.kind, "linux-starttime-ticks");
  assert.equal(result.authority, "none");
  for (const changed of [
    { invocation_id: "d".repeat(64) },
    { request_sha256: "e".repeat(64) },
    { cgroup_empty: false },
    { unit_settled: false },
    { unit_invocation_id: "" },
    { root_identity: null },
    { root_identity: { pid: 123, creation_ticks: "0" } },
    { exit_code: null },
    { cgroup_settlement: "wrapper-exited" },
  ])
    assert.throws(() => inspectLinuxPublicTechnicalClosure({ ...raw, ...changed }, id, request));
});
