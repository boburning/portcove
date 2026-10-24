/** Controlled integration only. Imported fixtures never establish real provider,
 * checkpoint-signature, native, terminal journey or execution acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { hostedNativeProofFixture } from "./fixtures/hosted-native-proof-fixture.mts";
import { inspectHostedNativeCustodyBundle } from "./release-hosted-native-proof-contract.mts";
import { selectHostedNativePredecessorScope } from "./release-hosted-native-history.mts";
import { inspectSelectedPublicationAuthorityConfiguration } from "./release-authority-configuration.mts";

function fixture() {
  const fixtures = (["linux-x86_64", "windows-x86_64"] as const).map((p) =>
    hostedNativeProofFixture(p),
  );
  const custody = {
    schema_version: 1,
    purpose: "hosted-native-custody",
    configuration: inspectSelectedPublicationAuthorityConfiguration(fixtures[0]!.authorities),
    stage: "payload-signing",
    proofs: fixtures.map((f) => ({
      platform_label: f.report.platform_label,
      producer: f.producer,
      files: Object.fromEntries(
        Object.entries(f.files).map(([key, bytes]) => [key, bytes.toString("base64")]),
      ),
    })),
  };
  const inspected = inspectHostedNativeCustodyBundle(Buffer.from(JSON.stringify(custody)));
  const pin = {
    checkpoint: "b".repeat(40),
    native_bundle_sha256: inspected.sha256,
    native_bundle_bytes: inspected.bytes.length,
  };
  const records = inspected.proofs.map((p) => ({
    target: p.report.platform_label,
    source_commit: p.report.candidate.source_commit,
    source_tree: p.report.candidate.source_tree,
    qualified_run: {
      workflow: ".github/workflows/release.yml",
      workflow_commit: p.report.candidate.source_commit,
      run_id: p.report.candidate.run_id,
      attempt: p.report.candidate.run_attempt,
    },
    artifact: {
      ...p.report.candidate.package,
      url: `https://github.com/boburning/portcove/releases/download/v0.1.0-beta.1/${p.report.candidate.package.filename}`,
    },
    evidence_ids: [
      `native-checkpoint:${pin.checkpoint}:${pin.native_bundle_sha256}:${pin.native_bundle_bytes}`,
      `native-job:${p.producer.run_id}:${p.producer.run_attempt}:${p.producer.job_id}:${p.producer.check_run_id}:${p.subject_sha256}`,
      `native-report:${p.report_sha256}`,
      `native-capture:${p.report.runtime.capture_sha256}`,
      `native-teardown:${p.report.runtime.teardown.capture_sha256}`,
    ],
  }));
  const p = fixtures[0]!.producer;
  return {
    custody,
    records,
    pin,
    workflow: fixtures[0]!.sourceFiles.workflow.toString(),
    view: {
      configuration: custody.configuration,
      source: {
        controller_revision: p.controller_revision,
        controller_ref: p.controller_ref,
        actor_id: p.actor_id,
        run_id: p.run_id,
        run_attempt: p.run_attempt,
        authority_configuration_sha256: p.configuration_sha256,
        grant_sha256: p.grant_sha256,
      },
    },
  };
}

void test("closed native predecessor pair selects current run only from both exact original run/attempt IDs", () => {
  const f = fixture();
  assert.equal(selectHostedNativePredecessorScope(f.records, f.view.source), "current-run");
  assert.equal(
    selectHostedNativePredecessorScope(f.records, { ...f.view.source, run_id: "999999" }),
    "completed-history",
  );
  for (const fault of ["mixed", "duplicate", "missing", "malformed", "wrong-platform"]) {
    const records = structuredClone(f.records);
    if (fault === "mixed")
      records[0]!.evidence_ids[1] = records[0]!.evidence_ids[1]!.replace(
        /^native-job:[^:]+:/u,
        "native-job:999999:",
      );
    if (fault === "duplicate") records[0]!.evidence_ids.push(records[0]!.evidence_ids[1]!);
    if (fault === "missing") records[0]!.evidence_ids.splice(1, 1);
    if (fault === "malformed") records[0]!.evidence_ids[1] = "native-job:unknown";
    if (fault === "wrong-platform") records[1]!.target = records[0]!.target;
    assert.throws(() => selectHostedNativePredecessorScope(records, f.view.source));
  }
});

void test("current-run predecessor receiver retains signed checkpoint/native association with no historical fallback", (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "native-live-history-"));
  const input = path.join(root, "fixture.json");
  writeFileSync(input, JSON.stringify(fixture()));
  const entry = new URL("./release-hosted-native-history.mts", import.meta.url).href;
  const contract = new URL("./release-hosted-native-proof-contract.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
const fixture=JSON.parse(readFileSync(process.argv[1],'utf8')), root=process.argv[2];
const {inspectHostedNativeProofFiles}=await import(${JSON.stringify(contract)});
let state,reads,sourceReads,currentReads,historicalReads,checkpointChecks;
const receipts=new WeakMap();
const readSource=async()=>{
 sourceReads++;
 const view=structuredClone(state.view);
 if(state.fault==='changed-source'&&sourceReads>1)view.source.actor_id='9999';
 return view;
};
const collect=kind=>async(dir,config,expected,files,deadline)=>{
 kind==='current'?currentReads++:historicalReads++;
 assert.equal(checkpointChecks,1,'native proof cannot precede authenticated checkpoint');
 assert.ok(deadline>performance.now());
 assert.equal(expected.stage,'payload-signing');assert.equal(expected.journey,null);
 const prepared=inspectHostedNativeProofFiles(files,config,expected.producer);
 if(state.fault==='native-proof')throw Error('native signature refused');
 if(kind==='historical'&&['live-history','configured-live-history'].includes(state.fault))throw Error('historical job still live');
 const receipt=Object.freeze({kind,evidence_scope:'github.com'});
 receipts.set(receipt,{...prepared.report});return receipt;
};
globalThis.fixture={
 source:readSource,workflow:async()=>Buffer.from(state.workflow),
 environment:()=>({PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}),
 hydrate:async(repo,pin)=>{reads++;assert.equal(pin,state.pin.checkpoint);return {checkpoint:pin,requests:1}},
 evidence:()=>({subject:Buffer.from(JSON.stringify({schema_version:2,producer:state.custody.proofs[0].producer,native_custody:state.custody})),requests:1}),
 authenticate:async(dir,checkpoint,config,evidence,expected,deadline)=>{checkpointChecks++;assert.equal(expected.role,'aggregate-assembly');assert.equal(checkpoint.checkpoint,state.pin.checkpoint);if(state.fault==='checkpoint-signature')throw Error('checkpoint signature refused');return {evidence_scope:'github.com'}},
 requireCheckpoint:()=>{assert.equal(checkpointChecks,1)},
 collectCurrent:collect('current'),collectHistorical:collect('historical'),
 readCurrent:async receipt=>receipt.kind==='current'?receipts.get(receipt):undefined,
 readHistorical:async receipt=>receipt.kind==='historical'?receipts.get(receipt):undefined,
};
const routes={
 './release-coordinator-recovery.mts':{hydrateRetainedCoordinatorCheckpointExport:'hydrate'},
 './release-coordinator-checkpoint-evidence.mts':{readCoordinatorCheckpointEvidence:'evidence'},
 './release-coordinator-checkpoint-authentication.mts':{authenticateCoordinatorCheckpointEvidence:'authenticate',requireAuthenticatedCheckpointEvidence:'requireCheckpoint'},
 './release-hosted-native-acceptance.mts':{collectHostedNativeReleaseQualification:'collectCurrent',verifiedHostedNativeReleaseQualification:'readCurrent',collectHistoricalHostedNativeQualification:'collectHistorical',verifiedHistoricalHostedNativeQualification:'readHistorical'},
 './release-authority-configuration.mts':{requireControllerApplicationJobPublicationAuthorities:'source'},
 './production-controller-admission.mts':{readProductionControllerWorkflowBytes:'workflow'},
 './release-readonly-child-environment.mts':{readOnlyReleaseChildEnvironment:'environment'},
};
registerHooks({resolve(spec,ctx,next){if(ctx.parentURL===${JSON.stringify(entry)}&&routes[spec])return {url:'inert-history:'+spec,shortCircuit:true};return next(spec,ctx)},load(url,ctx,next){if(url.startsWith('inert-history:'))return {format:'module',source:Object.entries(routes[url.slice(14)]).map(([name,key])=>'export const '+name+'=globalThis.fixture.'+key+';').join('\n'),shortCircuit:true};return next(url,ctx)}});
const api=await import(${JSON.stringify(entry)});
const provider={request(){throw Error('unexpected transport')},graphql(){throw Error('unexpected GraphQL')}};
for(const fault of ['valid','source','configuration','grant','workflow','package','checkpoint-pin','checkpoint-signature','native-proof','changed-source','configured-history','configured-live-history','history','live-history']){
 state=structuredClone(fixture);state.fault=fault;reads=sourceReads=currentReads=historicalReads=checkpointChecks=0;
 if(fault==='source')state.view.source.actor_id='9999';
 if(fault==='configuration')state.view.configuration.journal.apps.semantic.app_id++;
 if(fault==='grant')state.view.source.grant_sha256='e'.repeat(64);
 if(fault==='workflow')state.workflow+='changed';
 if(fault==='package')state.records[0].artifact.sha256='e'.repeat(64);
 if(fault==='checkpoint-pin')state.records[0].evidence_ids[0]=state.records[0].evidence_ids[0].replace(state.pin.checkpoint,'e'.repeat(40));
 if(fault==='configured-history'||fault==='configured-live-history')state.view.source.run_id='99999';
 const directory=path.join(root,fault);mkdirSync(directory);
 const collect=fault==='history'||fault==='live-history'?api.collectHistoricalHostedNativePredecessors:api.collectConfiguredHostedNativePredecessors;
 const operation=()=>collect(directory,state.records,{schema_version:1,namespace:state.custody.configuration.journal.namespace},performance.now()+60000,provider);
 if(['valid','history','configured-history'].includes(fault)){
   const result=await operation();
   assert.equal(result.kind,fault==='valid'?'verified-current-run-native-predecessors':'verified-hosted-native-predecessors');
   assert.equal(result.journey_completion,'not-established');assert.equal(result.predecessors.length,2);assert.equal(result.authority,'none');
   assert.equal(checkpointChecks,1);assert.equal(fault==='valid'?currentReads:historicalReads,2);
 }else{
   await assert.rejects(operation());
   if(fault==='checkpoint-signature')assert.equal(currentReads,0);
   if(reads){const [capture]=readdirSync(directory);assert.ok(existsSync(path.join(directory,capture,'failure.json')))}
 }
 if(!['history','live-history','configured-history','configured-live-history'].includes(fault))assert.equal(historicalReads,0,'current failure must not fall back');
}
console.log('controlled current/history checkpoint handoff passed');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, input, root], {
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /controlled current\/history checkpoint handoff passed/u);
});
