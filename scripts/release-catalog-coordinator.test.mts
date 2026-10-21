import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  inspectFixedCatalogCoordinatorConfiguration,
  runFixedCatalogCoordinatorConfiguration,
} from "./release-catalog-coordinator.mts";

const selected = {
  remote_configuration: { schema_version: 1, namespace: "portcove-worker-fixture-catalog" },
  tools: {
    artifact: {
      controller_revision: "a".repeat(40),
      source_tree: "b".repeat(40),
      controller_ref: "refs/tags/portcove-production-controller-fixture",
      run_id: "123",
      run_attempt: 1,
      artifact_id: 11,
      sha256: "c".repeat(64),
    },
    bundle: { artifact_id: 12, sha256: "d".repeat(64) },
  },
};
void test("fixed catalog coordinator accepts only existing exact locators and refuses supplied authority/source/results", async () => {
  assert.deepEqual(inspectFixedCatalogCoordinatorConfiguration(selected), selected);
  for (const extra of [
    { accepted: true },
    { opportunity: {} },
    { source_commit: "f".repeat(40) },
    { api: {} },
    { context: {} },
    { deadline: Infinity },
  ])
    assert.throws(() => inspectFixedCatalogCoordinatorConfiguration({ ...selected, ...extra }));
  assert.throws(() =>
    inspectFixedCatalogCoordinatorConfiguration({
      ...selected,
      tools: { ...selected.tools, cli: "candidate" },
    }),
  );
  await assert.rejects(
    runFixedCatalogCoordinatorConfiguration(selected, process.cwd(), performance.now() - 1),
    /deadline/u,
  );
});

void test("actual entry routes frozen requests and one neutral CAS without app proposal or nested control zero (controlled adapters, real Git journal)", () => {
  const entry = new URL("./release-catalog-coordinator.mts", import.meta.url).href;
  const stateModule = new URL("./release-coordinator-state.mts", import.meta.url).href;
  const fixtureModule = new URL("./fixtures/release-capacity-fixture.mts", import.meta.url).href;
  const negativeModule = new URL("./release-catalog-review-disposition.mts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
 import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {mkdtemp,mkdir,rm} from 'node:fs/promises';import {execFileSync} from 'node:child_process';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
 const {checkpointReleaseOpportunity,recoverReleaseOpportunity}=await import(${JSON.stringify(stateModule)}),{capacityFixture}=await import(${JSON.stringify(fixtureModule)});
 const negativeModule=await import(${JSON.stringify(negativeModule)});
 const entry=${JSON.stringify(entry)},selection=${JSON.stringify(selected)},hash=x=>createHash('sha256').update(x).digest('hex');
 const core={authority:'none',definitions:[],files:[],index_sha256:'1'.repeat(64),publication_schema:1,scope:'inert-managed-definition-publication-inspection'},coreText=JSON.stringify(core)+String.fromCharCode(10);
 const authority={namespace:selection.remote_configuration.namespace,configuration_sha256:'2'.repeat(64),apps:{semantic:{app_id:123},classification:{app_id:456}},catalog:{setup_plan_sha256:'3'.repeat(64),public_source:{commit:'4'.repeat(40),root:{sha256:'5'.repeat(64)},initial_site_preimage:{sha256:'6'.repeat(64)}}}};
 const scope={source:{commit:'7'.repeat(40),tree:'8'.repeat(40)},request:{compatibility:{contract:'official-definition-policy-launch-v1',notes:'Controlled source route only.'}},request_sha256:'e'.repeat(64),bundle_sha256:'9'.repeat(64),bundle:'/inert/bundle'};
 const actualInspection={tools_receipt:{},tool_sha256:'f'.repeat(64),source:scope.source,bundle:scope.bundle,bundle_sha256:scope.bundle_sha256,inspection_sha256:hash(coreText),inspection:core,directory:'/inert/inspection',authority:'none'};
 const reader={admitted:{revision:selection.tools.artifact.controller_revision,execution_ref:selection.tools.artifact.controller_ref,run_id:'123',run_attempt:1},identity:{evidence_scope:'github.com',job_id:51,check_run_id:52}};
 const facts={reader:{job_id:51,check_run_id:52},pause:{publication_paused:false},capacity_source:{capacity:capacityFixture()},resource_policy_matches_controller:true};
 let scenario,live,cp,root,counters,maintenanceReads;
 const fake={
  authority,reader,
  inspection:actualInspection,
  async recover(){const r=await recoverReleaseOpportunity(live,cp);if(['unchanged','previous-missing'].includes(scenario))r.input.published_catalog_metadata={schema_version:1,source_commit:'4'.repeat(40),source_tree:'a'.repeat(40),operation_id:'1'.repeat(64),publication:{evidence_sha256:'2'.repeat(64),remote_identity:'fixture:none',site_generation_sha256:'3'.repeat(64)},root_sha256:'5'.repeat(64),offline_targets_sha256:'6'.repeat(64),index_sha256:'7'.repeat(64),repository_sha256:'8'.repeat(64),verifier_repository_sha256:'9'.repeat(64),snapshot_sha256:'a'.repeat(64),timestamp_sha256:'b'.repeat(64),immutable_targets_sha256:'c'.repeat(64),versions:{targets:'1',definitions:'1',policy:'1',snapshot:'1',timestamp:'1'},expires:Object.fromEntries(['targets','definitions','policy','snapshot','timestamp'].map(x=>[x,'2026-12-01T00:00:00Z']))};return {...r,repository:live,checkpoint:cp};},
  async publish(repository,checkpoint,_namespace,{api}){await api.request('POST','fixed-journal-object',{});await api.graphql('mutation FixedCas {}',{});cp=checkpoint;},
  controls:{evidence_scope:'github.com',readMaintenance(){maintenanceReads++;if(scenario==='expired'&&maintenanceReads>1)throw new Error('expired maintenance');return facts;}},
  client:{request(method,route){assert.equal(method,'GET');if(route.includes('/actions/runs/'))return {status:200,body:{}};if(route==='repos/boburning/portcove')return {status:200,body:{id:1354613114,full_name:'boburning/portcove',default_branch:'main'}};if(route.endsWith('/git/ref/heads/main')){counters.main++;return {status:200,body:{ref:'refs/heads/main',object:{type:'commit',sha:scope.source.commit}}};}return {status:200,body:{}};},graphql(){return {}; }},
 };
 globalThis.__catalog=fake;
 const data=s=>'data:text/javascript,'+encodeURIComponent(s),code={
 './github-api.mts': 'export const createGitHubRunner=()=>{};export class GitHubApiClient {constructor(){} request(...a){return globalThis.__catalog.client.request(...a)} graphql(...a){return globalThis.__catalog.client.graphql(...a)}}',
 './release-coordinator-driver.mts':'export const coordinatorOriginalJobDeadline=()=>performance.now()+160000;export const catalogCoordinatorMaintenanceIdentity=()=>"stable";export const deriveCoordinatorPublication=(_t,_r,_a,now)=>({complete:true,observed_at:now,published_versions:[],published_sources:[],reserved_versions:[],last_routine_preview_at:null});export const prepareActualCoordinatorCatalogSigning=(...a)=>globalThis.__catalog.prepare(...a);',
 './release-catalog-signing-context.mts':'export const completeCoordinatorCatalogSigningContext=(...a)=>globalThis.__catalog.complete(...a);',
 './release-authority-configuration.mts':'export const requireControllerCatalogPublicationAuthorities=async()=>globalThis.__catalog.authority;export const assertControllerCatalogPublisherScope=()=>{};',
 './release-live-control-admission.mts':'export const authenticateCatalogControlReaderJob=async()=>globalThis.__catalog.reader;export const authenticateCatalogReleaseControlSource=async()=>globalThis.__catalog.authenticateControls();export const requireAuthenticatedCatalogControlSource=()=>{};',
 './production-controller-admission.mts':'export const readProductionControllerWorkflowBytes=async()=>Buffer.from("fixed controlled fixture");',
 './release-controller-tool-admission.mts':'export const receiveControllerTools=async()=>globalThis.__catalog.tools;export const verifiedControllerToolPaths=async()=>({identity:globalThis.__catalog.identity});',
 './release-catalog-source.mts':'export const materializeCatalogPublicationSource=async(_api,commit)=>globalThis.__catalog.source(commit);export const readCatalogPublicationSourceBytes=()=>globalThis.__catalog.previous();',
 './release-catalog-inspection.mts':'export const inspectActualCatalogPublication=async()=>globalThis.__catalog.inspect();export const requireActualCatalogInspection=async()=>globalThis.__catalog.inspection;export const readCatalogPublicationBundle=async()=>new Map();',
 './release-coordinator-recovery.mts':'export const recoverRemoteCoordinator=()=>globalThis.__catalog.recover();export const readRemoteCoordinatorSnapshot=()=>globalThis.__catalog.recover();export const inspectRemoteCommitObject=(_raw,id)=>({tree:id==="4".repeat(40)?"a".repeat(40):"8".repeat(40)});',
 './release-coordinator-remote.mts':'export const inspectCoordinatorRemoteNamespace=x=>{if(x.schema_version!==1||Object.keys(x).sort().join(",")!=="namespace,schema_version")throw new Error("namespace");return x.namespace;};export const publishCoordinatorCheckpoint=(...a)=>globalThis.__catalog.publish(...a);',
 './release-source-changes.mts':'export const collectReleaseSourceChanges=()=>({base_tree:"a".repeat(40),change_set_sha256:"b".repeat(64)});',
 './release-publication-inventory.mts':'export const createReleasePublicationReader=()=>({tags:()=>[],releases:()=>[],readAllocations:()=>({allocations:[]})});',
 './release-coordinator-journal-api.mts':'export const createCoordinatorJournalApi=()=>({request:()=>globalThis.__catalog.write(),graphql:()=>globalThis.__catalog.write()});',
 './release-semantic-disposition-reader.mts':'export const readIndependentSemanticCheckInventory=()=>({records:[],assertUnchanged(){}});export const inspectCatalogSemanticRequestCheckMatches=()=>globalThis.__catalog.matches();export const discoverIndependentCatalogSemanticDisposition=()=>globalThis.__catalog.negativeObserved;',
 './release-catalog-review-disposition.mts': 'export {inspectCatalogReviewDisposition,advanceCatalogReviewRecovery} from '+JSON.stringify(${JSON.stringify(negativeModule)})+';export const receiveActualCatalogReviewDisposition=(...a)=>globalThis.__catalog.receiveNegative(...a);export const requireActualCatalogReviewDisposition=async()=>globalThis.__catalog.negative;export const prepareActualCatalogReviewRetirement=(...a)=>globalThis.__catalog.prepareNegative(...a);',
 './release-control-handshake.mts':'export const prepareControlReadiness=()=>({fixture:true});export const waitForControlArtifact=async()=>({fixture:true});',
 './release-control-step-bridge.mts':'export const retainControlStepLocator=async()=>{};',
 './release-path-safety.mts':'export const assertOwnedUnlinkedPath=async()=>{};'
 };
 registerHooks({resolve(spec,context,next){if(context.parentURL===entry&&code[spec])return {url:data(code[spec]),shortCircuit:true};return next(spec,context);}});
 const {runFixedCatalogCoordinatorConfiguration}=await import(entry);
 process.env.GITHUB_RUN_ID='123';process.env.GITHUB_SHA=selection.tools.artifact.controller_revision;process.env.GITHUB_RUN_ATTEMPT='1';
 root=await mkdtemp(path.join(os.tmpdir(),'catalog-entry-controlled-'));
 try {
  async function setup(name){scenario=name;counters={main:0,controls:0,inspect:0,write:0,prepare:0,complete:0};maintenanceReads=0;live=path.join(root,name);await mkdir(live);execFileSync('git',['init','--bare','--quiet',live]);
   const now=new Date().toISOString(),input={schema_version:2,now,opportunity:null,active_candidate:null,controller:{workflow:'.github/workflows/application-update-production.yml',revision:reader.admitted.revision,publication_paused:false,capacity_attempt:{...capacityFixture(),schema_version:2}},publication:{complete:true,observed_at:now,published_versions:[],published_sources:[],reserved_versions:[],last_routine_preview_at:null},catalog_initialization:{schema_version:1,kind:'catalog-initialization',authority:'none',source_commit:authority.catalog.public_source.commit,source_tree:'a'.repeat(40),root_sha256:authority.catalog.public_source.root.sha256,publisher_configuration_sha256:authority.configuration_sha256,setup_plan_sha256:authority.catalog.setup_plan_sha256,initial_site_preimage_sha256:authority.catalog.public_source.initial_site_preimage.sha256}};
   cp=(await checkpointReleaseOpportunity(live,null,input)).checkpoint;
   fake.tools={};fake.identity=selection.tools.artifact;fake.inspection=actualInspection;fake.previous=()=>({...scope,source:{commit:'4'.repeat(40),tree:'a'.repeat(40)},request:scenario==='previous-missing'?null:scope.request});
   fake.source=commit=>{assert.equal(commit,scope.source.commit);return scenario==='absent'?{...scope,request:null}:scope;};
   fake.inspect=()=>{counters.inspect++;return {};};fake.authenticateControls=()=>{counters.controls++;return fake.controls;};fake.write=()=>{counters.write++;return {};};
   fake.matches=()=>({accepted:['accepted','replacement'].includes(scenario)?[{check_run_id:99,opportunity:{}}]:[],negative:['negative','retire'].includes(scenario)?[100]:[],authority:'none'});
   fake.prepare=(parent,args,deadline)=>{counters.prepare++;assert.equal(args.tools,fake.tools);assert.equal(args.check_id,99);assert.ok(deadline<performance.now()+170000);return {};};fake.complete=()=>{counters.complete++;return {decision:'catalog-context-prepared',authority:'none'};};
  }
  await setup('absent');let result=await runFixedCatalogCoordinatorConfiguration(selection,root,performance.now()+150000);assert.equal(result.decision,'held');assert.equal(counters.inspect,0);assert.equal(counters.write,0);assert.equal(counters.controls,0);
  await setup('neutral');const old=cp;result=await runFixedCatalogCoordinatorConfiguration(selection,root,performance.now()+150000);assert.equal(result.decision,'catalog-review-requested');assert.notEqual(cp,old);assert.equal(counters.controls,1);assert.equal(counters.prepare,0);assert.equal(counters.write,2);const retained=(await recoverReleaseOpportunity(live,cp)).input;assert.deepEqual(retained.catalog_review_request,result.catalog_review_request);assert.equal(retained.opportunity,null);assert.equal(retained.active_candidate,null);assert.equal(retained.catalog_review_request.core_inspection,coreText);
  const frozen=retained.catalog_review_request;const originalSource=fake.source;fake.source=commit=>{assert.equal(commit,frozen.opportunity.source_commit);return originalSource(commit);};const mainBefore=counters.main;result=await runFixedCatalogCoordinatorConfiguration(selection,root,performance.now()+150000);assert.equal(result.decision,'held');assert.equal(counters.main,mainBefore);assert.equal(counters.controls,1);assert.deepEqual((await recoverReleaseOpportunity(live,cp)).input.catalog_review_request,frozen);
  scenario='retire';fake.negativeObserved={fixture:'negative-provider-proof'};fake.receiveNegative=async(_controls,_parent,request,checkpoint)=>{
    const snapshot=await recoverReleaseOpportunity(live,cp);assert.equal(checkpoint,cp);assert.equal(request.request_id,snapshot.input.catalog_review_request.request_id);
    const disposition=negativeModule.compactCatalogReviewDisposition({schema_version:1,kind:'catalog-publication-semantic-disposition-receipt',request,request_checkpoint:cp,check_run_id:100,review_app_id:123,stage:'complete-catalog-publication-opportunity',disposition:'changes-required',wire_sha256:'1'.repeat(64),opportunity_sha256:hash(JSON.stringify(request.opportunity,Object.keys(request.opportunity).sort())),bundle_sha256:'2'.repeat(64),invocation_sha256:'3'.repeat(64),events_sha256:'4'.repeat(64),isolation_sha256:'5'.repeat(64),report_sha256:'6'.repeat(64),session_ref:'controlled:negative',completed_at:request.requested_at.slice(0,19)+'Z'},snapshot.input.catalog_review_disposition);
    // Use the same maintained canonical digest as the state validator.
    const {releaseCanonicalDigest}=await import(new URL('./release-canonical.mts',entry));disposition.opportunity_sha256=releaseCanonicalDigest(request.opportunity);
    fake.negative={input:snapshot.input,disposition,checkpoint:cp,proof_sha256:releaseCanonicalDigest(fake.negativeObserved)};return {};
  };
  fake.prepareNegative=async(_receipt,now,_deadline,publication)=>{const next={...structuredClone(fake.negative.input),now,publication,catalog_review_request:null,catalog_review_disposition:fake.negative.disposition};negativeModule.validateCatalogReviewRecoveryTransition(fake.negative.input,next,cp);return {input:next,checkpoint:cp};};
  result=await runFixedCatalogCoordinatorConfiguration(selection,root,performance.now()+150000);assert.equal(result.decision,'catalog-negative-review-retired');let afterNegative=(await recoverReleaseOpportunity(live,cp)).input;assert.equal(afterNegative.catalog_review_request,null);assert.equal(afterNegative.catalog_review_disposition.substantive_repairs,0);assert.equal(counters.prepare,0);
  scenario='replacement';const writesBefore=counters.write;await assert.rejects(runFixedCatalogCoordinatorConfiguration(selection,root,performance.now()+150000),/changed source AND tree/);assert.equal(counters.write,writesBefore);assert.equal(counters.prepare,0);
  scope.source={commit:'c'.repeat(40),tree:'d'.repeat(40)};fake.source=commit=>{assert.equal(commit,scope.source.commit);return scope;};
  result=await runFixedCatalogCoordinatorConfiguration(selection,root,performance.now()+150000);assert.equal(result.decision,'catalog-review-requested');const repaired=(await recoverReleaseOpportunity(live,cp)).input;assert.equal(repaired.catalog_review_disposition.substantive_repairs,1);assert.equal(counters.prepare,0);assert.equal(repaired.catalog_review_request.opportunity.source_commit,scope.source.commit);
  scope.source={commit:'7'.repeat(40),tree:'8'.repeat(40)};
  await setup('accepted');result=await runFixedCatalogCoordinatorConfiguration(selection,root,performance.now()+150000);assert.equal(result.decision,'catalog-context-prepared');assert.equal(counters.controls,0);assert.equal(counters.prepare,1);assert.equal(counters.complete,1);assert.equal(counters.write,0);
  await setup('negative');result=await runFixedCatalogCoordinatorConfiguration(selection,root,performance.now()+150000);assert.equal(result.decision,'held');assert.equal(counters.prepare,0);assert.equal(counters.controls,0);assert.equal(counters.write,0);
  await setup('unchanged');result=await runFixedCatalogCoordinatorConfiguration(selection,root,performance.now()+150000);assert.match(result.reason,/unchanged accepted/);assert.equal(counters.inspect,0);assert.equal(counters.write,0);
  await setup('previous-missing');result=await runFixedCatalogCoordinatorConfiguration(selection,root,performance.now()+150000);assert.match(result.reason,/missing or contradictory/);assert.equal(counters.inspect,0);assert.equal(counters.write,0);
  await setup('expired');const before=cp;await assert.rejects(runFixedCatalogCoordinatorConfiguration(selection,root,performance.now()+150000),/expired maintenance/);assert.equal(counters.write,0);assert.equal(cp,before);
 }finally{await rm(root,{recursive:true,force:true});}
 `,
    ],
    { encoding: "utf8", timeout: 20000, maxBuffer: 4 * 1024 ** 2, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
