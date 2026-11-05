import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp, readdir, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { disposableTufWorkerFixture } from "./fixtures/tuf-worker-fixture.mts";
import { signIsolatedTufRole, tufRoleDependencies } from "./release-tuf-signing.mts";
import { signReleasePayload } from "./release-payload-signing.mts";
import os from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import {
  inspectNativePredecessorReleaseAsset,
  acquireNativePredecessorRelease,
  inspectNativePostSignPackageMetadata,
  acquireActualNativePostSignCandidate,
  inspectSelectedNativeCandidate,
  acquireActualNativeCandidate,
  requireActualNativeCandidate,
  inspectNativeSourceCommand,
  nativeInvocationIdentity,
  inspectNativePostSignController,
  inspectNativeCurrentStage,
  inspectHostedNativePreparationStage,
  acquireActualNativeStageCandidate,
  readActualNativePostSignController,
  requireActualNativePostSignController,
  inspectNativeControllerVerificationCommand,
  inspectNativePostSignArtifactInventory,
  readActualNativePostSignPublicInputs,
  assembleActualNativePostSignRepository,
} from "./release-native-candidate.mts";
import { capacityDigest } from "./release-capacity.mts";
import { prepareNativeStageRequest } from "./release-native-stage-capture.mts";
import { nativeAuthorityConfigurationFixture } from "./fixtures/native-authority-configuration-fixture.mts";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectNativeKeylessAssemblyPlan,
  inspectNativePayloadVerificationPlan,
  runNativePayloadVerificationPlan,
} from "./release-native-keyless-assembly.mts";

void test("native keyless plan fixes owned public input paths and the maintained local tool without minting execution authority", async () => {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    directory = path.join(root, "work/inert-native-keyless");
  const plan = {
    schema_version: 1,
    context_directory: path.join(directory, "context"),
    output_parent: directory,
    tool: {
      path: path.join(
        root,
        "tools",
        process.platform === "win32" ? "portcove-release-tools.exe" : "portcove-release-tools",
      ),
      sha256: "a".repeat(64),
    },
    signed_roles: ["releases", "preview", "stable", "snapshot", "timestamp"].map((name) => ({
      filename: `${name}.json`,
      path: path.join(directory, name, `${name}.json`),
      bytes: 2,
      sha256: "b".repeat(64),
    })),
  };
  const selected = inspectNativeKeylessAssemblyPlan(plan, directory);
  assert.equal(selected.signed_roles.length, 5);
  for (const mutation of [
    { ...plan, accepted: true },
    { ...plan, output_parent: root },
    { ...plan, context_directory: root },
    { ...plan, tool: { ...plan.tool, path: path.join(directory, "candidate.exe") } },
    { ...plan, tool: { ...plan.tool, sha256: "unobserved" } },
    { ...plan, signed_roles: plan.signed_roles.slice(0, 4) },
    { ...plan, signed_roles: [...plan.signed_roles].reverse() },
    {
      ...plan,
      signed_roles: plan.signed_roles.map((role, index) =>
        index === 0 ? { ...role, path: path.join(root, role.filename) } : role,
      ),
    },
  ])
    assert.throws(() => inspectNativeKeylessAssemblyPlan(mutation, directory));
  plan.tool.sha256 = "c".repeat(64);
  assert.equal(selected.tool.sha256, "a".repeat(64));
  await assert.rejects(
    assembleActualNativePostSignRepository({}),
    /actual native post-sign controller source/,
  );
});

void test("post-sign run inventory selects the exact twelve opaque artifacts and refuses partial, duplicate or unrelated producer locators", async () => {
  const controller = { run_id: "12345", run_attempt: 1, controller_revision: "a".repeat(40) };
  const names = [
    "trusted-payload-signing-context-12345-1",
    "trusted-payload-signing-context-attestation-12345-1",
    ...["releases", "preview", "stable", "snapshot", "timestamp"].flatMap((role) => [
      `trusted-tuf-${role}-output-12345-1`,
      `trusted-tuf-${role}-attestation-12345-1`,
    ]),
  ];
  const raw = {
    total_count: names.length,
    artifacts: names.map((name, index) => ({
      id: 100 + index,
      name,
      expired: false,
      digest: "sha256:" + "b".repeat(64),
      size_in_bytes: 22,
      workflow_run: {
        id: 12345,
        repository_id: 1354613114,
        head_repository_id: 1354613114,
        head_sha: "a".repeat(40),
      },
    })),
  };
  const selected = inspectNativePostSignArtifactInventory(raw, controller);
  assert.equal(selected.context.id, 100);
  assert.equal(selected.context_bundle.id, 101);
  assert.deepEqual(
    selected.roles.map((role) => role.role),
    ["releases", "preview", "stable", "snapshot", "timestamp"],
  );
  assert.equal(selected.authority, "none");
  for (const change of [
    { id: 101 },
    { name: "foreign" },
    { expired: true },
    { digest: "unobserved" },
    { size_in_bytes: 0 },
    { size_in_bytes: 128 * 1024 ** 2 + 1 },
    { workflow_run: { ...raw.artifacts[0]!.workflow_run, id: 12346 } },
    { workflow_run: { ...raw.artifacts[0]!.workflow_run, head_sha: "c".repeat(40) } },
    { workflow_run: { ...raw.artifacts[0]!.workflow_run, head_repository_id: 42 } },
  ]) {
    const altered = structuredClone(raw);
    Object.assign(altered.artifacts[0]!, change);
    assert.throws(() => inspectNativePostSignArtifactInventory(altered, controller));
  }
  assert.throws(() =>
    inspectNativePostSignArtifactInventory({ ...raw, total_count: 13 }, controller),
  );
  assert.throws(() =>
    inspectNativePostSignArtifactInventory(raw, { ...controller, run_attempt: 2 }),
  );
  assert.throws(() =>
    inspectNativePostSignArtifactInventory(raw, { ...controller, run_id: "9007199254740992" }),
  );
  await assert.rejects(
    readActualNativePostSignPublicInputs({}),
    /actual native post-sign controller source/,
  );
});

void test("parent-owned controller verifier admits only fixed local-bundle verification with complete source/certificate flags", () => {
  const root = path.resolve("inert-native-verifier"),
    directory = path.join(root, "context-123"),
    filename = path.join(directory, "signing-context-manifest.json"),
    bundle = path.join(directory, "attestation.json");
  const controller = {
    controller_revision: "a".repeat(40),
    controller_ref: "refs/tags/portcove-production-controller-fixture",
  };
  const args = [
    "attestation",
    "verify",
    filename,
    "--bundle",
    bundle,
    "--repo",
    "boburning/portcove",
    "--signer-workflow",
    "boburning/portcove/.github/workflows/application-update-production.yml",
    "--signer-digest",
    controller.controller_revision,
    "--source-digest",
    controller.controller_revision,
    "--source-ref",
    controller.controller_ref,
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--deny-self-hosted-runners",
    "--predicate-type",
    "https://portcove.dev/attestations/release-signing-context/v1",
    "--format",
    "json",
  ];
  inspectNativeControllerVerificationCommand(args, root, controller);
  const role = [...args];
  role[2] = path.join(directory, "signing-output-manifest.json");
  role[4] = path.join(directory, "role-attestation.json");
  role[19] = "https://portcove.dev/attestations/tuf-role-output/v1";
  inspectNativeControllerVerificationCommand(role, root, controller);
  for (const index of [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  ]) {
    const changed = [...args];
    changed[index] = "foreign";
    assert.throws(() => inspectNativeControllerVerificationCommand(changed, root, controller));
  }
  assert.throws(() =>
    inspectNativeControllerVerificationCommand(
      [...args, "--insecure-ignore-tlog"],
      root,
      controller,
    ),
  );
  const outside = [...args];
  outside[2] = path.resolve("foreign/signing-context-manifest.json");
  assert.throws(() => inspectNativeControllerVerificationCommand(outside, root, controller));
  assert.throws(() =>
    inspectNativeControllerVerificationCommand(args, directory + "-sibling", controller),
  );
});

void test("post-sign source run comes from exact completed timestamp candidate operation, not compiler or maintenance identity", async () => {
  const candidate = {
    phase: "publishing",
    source_commit: "b".repeat(40),
    prepared_commit: "c".repeat(40),
    version: "0.1.0-beta.1",
    transient_retries: 0,
    substantive_repairs: 0,
    release_run: { run_id: 999, attempt: 1, revision: "c".repeat(40) },
  };
  const { phase: _phase, release_run: _compiler, ...subject } = candidate;
  const executor = {
    actor_id: "123",
    check_run_id: "456",
    controller_revision: "a".repeat(40),
    execution_ref: "refs/tags/portcove-production-controller-fixture",
    job_id: 789,
    role: "tuf-timestamp",
    run_attempt: 1,
    run_id: "12345",
    workflow: ".github/workflows/application-update-production.yml",
  };
  const make = (changes: Record<string, unknown> = {}, state: Record<string, unknown> = {}) => {
    const identity = {
      before_checkpoint: "d".repeat(40),
      candidate: subject,
      destination: "github-actions:boburning/portcove:0.1.0-beta.1:tuf-timestamp-envelope",
      executor_nonce: "e".repeat(64),
      executor_identity: executor,
      receipt_limit: 1,
      kind: "upload",
      sequence: 1,
      policy_sha256: "f".repeat(64),
      ratification_sha256: "1".repeat(64),
      ...changes,
    };
    return {
      ...identity,
      id: capacityDigest(identity),
      outcome: "succeeded",
      completed_effects: [{ remote_identity: "artifact:fixture", evidence_sha256: "2".repeat(64) }],
      recovery: null,
      failure_evidence: null,
      ...state,
    };
  };
  const actual = inspectNativePostSignController(make(), candidate, "a".repeat(40));
  assert.equal(actual.run_id, "12345");
  assert.notEqual(actual.run_id, String(candidate.release_run.run_id));
  assert.equal(actual.authority, "none");
  const snapshot = (operation: unknown) => ({
    active_candidate: { ...candidate, phase: "building" },
    controller: { capacity_attempt: { schema_version: 2, operation, prior_operations: [] } },
  });
  const qualifying = { ...snapshot(null), active_candidate: { ...candidate, phase: "qualifying" } };
  assert.equal(inspectHostedNativePreparationStage(qualifying), "payload-signing");
  assert.equal(inspectHostedNativePreparationStage(snapshot(null)), "payload-signing");
  assert.throws(() => inspectNativeCurrentStage(qualifying), /not eligible/);
  for (const effect of [
    make(),
    make({}, { outcome: "pending", completed_effects: [] }),
    make({}, { outcome: "ambiguous" }),
  ])
    assert.throws(() => inspectHostedNativePreparationStage(snapshot(effect)), /timestamp effects/);
  assert.throws(
    () =>
      inspectHostedNativePreparationStage({
        ...snapshot(null),
        active_candidate: { ...candidate, phase: "publishing" },
      }),
    /not eligible/,
  );
  assert.equal(inspectNativeCurrentStage(snapshot(null)), "payload-signing");
  assert.equal(inspectNativeCurrentStage(snapshot(make())), "release-publication");
  assert.equal(
    inspectNativeCurrentStage(snapshot(make({}, { outcome: "pending", completed_effects: [] }))),
    "release-publication",
  );
  assert.equal(
    inspectNativeCurrentStage(snapshot(make({}, { outcome: "ambiguous" }))),
    "release-publication",
  );
  assert.equal(
    inspectNativeCurrentStage(snapshot(make({ candidate: { ...subject, transient_retries: 1 } }))),
    "payload-signing",
  );
  assert.throws(() =>
    inspectNativeCurrentStage({
      ...snapshot(null),
      active_candidate: { ...candidate, phase: "promoting" },
    }),
  );
  await assert.rejects(acquireActualNativeStageCandidate({}), /actual installed native parent/);
  for (const changed of [
    make({ candidate: { ...subject, transient_retries: 1 } }),
    make({ candidate: { ...subject, prepared_commit: "3".repeat(40) } }),
    make({ executor_identity: { ...executor, role: "payload-signing" } }),
    make({ executor_identity: { ...executor, run_attempt: 2 } }),
    make({ executor_identity: { ...executor, controller_revision: "3".repeat(40) } }),
    make({ executor_identity: { ...executor, execution_ref: "refs/tags/other-controller" } }),
    make({
      destination: "github-actions:boburning/portcove:metadata-renewal:tuf-timestamp-envelope",
    }),
    make({ receipt_limit: 2 }),
    make({}, { outcome: "pending", completed_effects: [] }),
    make({}, { outcome: "ambiguous" }),
    make({}, { completed_effects: [] }),
  ])
    assert.throws(() => inspectNativePostSignController(changed, candidate, "a".repeat(40)));
  assert.throws(() =>
    inspectNativePostSignController(make(), { ...candidate, phase: "promoting" }, "a".repeat(40)),
  );
  await assert.rejects(readActualNativePostSignController({}), /actual installed native parent/);
  await assert.rejects(
    requireActualNativePostSignController({}),
    /actual native post-sign controller source/,
  );
});

void test("actual installed post-sign source uses locked SDK for exact context and role proof archives", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const entry = new URL("./release-native-candidate.mts", import.meta.url).href;
  const capacity = new URL("./release-capacity.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {writeFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {capacityDigest as digest} from ${JSON.stringify(capacity)};
const root=process.argv[1],hash=b=>createHash('sha256').update(b).digest('hex'),bytes=Buffer.alloc(22),sha256=hash(bytes),revision='a'.repeat(40),ref='refs/tags/portcove-production-controller-fixture';
const token='fixed_native_source_fixture_token', gh=path.join(root,'fixed-gh'), tokenFile=path.join(root,'source-token');
await writeFile(gh,'inert verifier',{mode:0o700});await writeFile(tokenFile,token,{mode:0o600});
process.env.GH_TOKEN='unrelated-ambient-token';
const candidate={phase:'publishing',source_commit:'b'.repeat(40),prepared_commit:'c'.repeat(40),prepared_tree:'d'.repeat(40),frozen_opportunity:{fixed:true},version:'0.1.0-beta.1',transient_retries:0,substantive_repairs:0,release_run:{run_id:999,attempt:1,revision:'c'.repeat(40)}};
const {phase,prepared_tree,frozen_opportunity,release_run,...subject}=candidate;
const identity={before_checkpoint:'d'.repeat(40),candidate:subject,destination:'github-actions:boburning/portcove:0.1.0-beta.1:tuf-timestamp-envelope',executor_nonce:'e'.repeat(64),executor_identity:{actor_id:'123',check_run_id:'456',controller_revision:revision,execution_ref:ref,job_id:789,role:'tuf-timestamp',run_attempt:1,run_id:'12345',workflow:'.github/workflows/application-update-production.yml'},receipt_limit:1,kind:'upload',sequence:1,policy_sha256:'f'.repeat(64),ratification_sha256:'1'.repeat(64)};
const operation={...identity,id:digest(identity),outcome:'succeeded',completed_effects:[{remote_identity:'artifact:fixture',evidence_sha256:'2'.repeat(64)}],recovery:null,failure_evidence:null};
const parentReceipt={}, parent={descriptor:{capture_root:root,controller_revision:revision,namespace:'portcove-fixture'},transport_configuration:{github_cli:{path:gh,sha256:hash(Buffer.from('inert verifier'))},source_read_token:tokenFile},controller_tree:'e'.repeat(40),authority_configuration:{},recheck:async()=>{}};
const roles=['releases','preview','stable','snapshot','timestamp'], files=new Map(['trusted-root.json','offline-targets.json','payload.json'].map(name=>[name,Buffer.from(name)]));
const names=['trusted-payload-signing-context','trusted-payload-signing-context-attestation',...roles.flatMap(role=>['trusted-tuf-'+role+'-output','trusted-tuf-'+role+'-attestation'])];
const rows=names.map((name,i)=>({id:i+100,name:name+'-12345-1',expired:false,size_in_bytes:22,digest:'sha256:'+sha256,workflow_run:{id:12345,repository_id:1354613114,head_repository_id:1354613114,head_sha:revision}}));
let mode='',reads=0,wire=[],deliveries=[];
const download=async(item,opts,directory)=>opts.download('repos/boburning/portcove/actions/artifacts/'+item.id+'/zip',{cwd:directory,maxBytes:22,timeoutMs:30000});
globalThis.nativeProofFixture={
 parent:async receipt=>{assert.equal(receipt,parentReceipt);return parent},
 recover:async()=>({checkpoint:'7'.repeat(40),repository:root,input:{active_candidate:candidate,controller:{capacity_attempt:{schema_version:2,operation,prior_operations:[]}}}}),
 pins:()=>({public_source:{root:{sha256:hash(files.get('trusted-root.json'))},offline_targets:{sha256:hash(files.get('offline-targets.json'))},payload_key_registry:{sha256:hash(files.get('payload.json'))}}}),
 inspect:archive=>{assert.deepEqual(archive,bytes);return {files,manifest_sha256:'f'.repeat(64),manifest:{facts_sha256:'a'.repeat(64),binding:{fixed:true},facts:{opportunity:candidate.frozen_opportunity,assembly:{}}}}},
 assembly:async()=>({accepted:{release_profile:'initial-beta-win-linux',source_commit:candidate.prepared_commit,source_tree:candidate.prepared_tree,version:candidate.version,run_id:'999',run_attempt:1}}),
 context:async(directory,expected,_deadline,opts)=>{assert.equal(typeof opts.spawn,'function');assert.deepEqual(await download(expected.artifact,opts,directory),bytes);assert.deepEqual(await download(expected.bundle,opts,directory),bytes);return {directory}},
 role:async(directory,expected,_deadline,opts)=>{assert.equal(typeof opts.spawn,'function');assert.deepEqual(await download(expected.artifact,opts,directory),bytes);assert.deepEqual(await download(expected.bundle,opts,directory),bytes);return {envelope:{role:expected.role}}},
};
const mocks={
 './release-native-parent.mts':'export const requireActualNativeParent=globalThis.nativeProofFixture.parent;export const remainingNativeParentBudget=(cap=2070000)=>cap;',
 './release-coordinator-recovery.mts':'export const recoverRemoteCoordinator=globalThis.nativeProofFixture.recover;export const hydrateRetainedCoordinatorOperation=()=>{throw Error("unexpected historical hydrate")};',
 './release-authority-configuration.mts':'export const inspectNativePrepublicationAuthorities=()=>({});export const inspectPublicationAuthorities=globalThis.nativeProofFixture.pins;',
 './release-signing-context-artifact.mts':'export const inspectSigningContextArchive=globalThis.nativeProofFixture.inspect;export const receiveSigningContextArtifact=globalThis.nativeProofFixture.context;',
 './release-tuf-role-artifact.mts':'export const readAttestedTufRoleArtifact=globalThis.nativeProofFixture.role;',
 './trusted-release-assembly.mts':'export const inspectTrustedAssemblyInput=globalThis.nativeProofFixture.assembly;',
};
registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(entry)}&&mocks[specifier])return {url:'native-proof:'+specifier,shortCircuit:true};return next(specifier,context)},load(url,context,next){if(url.startsWith('native-proof:'))return {format:'module',source:mocks[url.slice('native-proof:'.length)],shortCircuit:true};return next(url,context)}});
globalThis.fetch=async(input,init)=>{
 const url=new URL(input instanceof Request?input.url:input),headers=new Headers(init.headers);assert.equal(init.redirect,'manual');
 if(url.origin==='https://productionresultssa1.blob.core.windows.net'){assert.equal(init.credentials,'omit');assert.equal(headers.has('authorization'),false);deliveries.push(url.pathname);return new Response(mode==='short'?bytes.subarray(0,21):bytes)}
 assert.equal(url.origin,'https://api.github.com');assert.equal(headers.get('authorization'),'token '+token);wire.push(url.pathname);
 const endpoint='/repos/boburning/portcove/actions';
 if(url.pathname===endpoint+'/runs/12345/artifacts'){
  assert.equal(url.search,'?per_page=100');reads++;
  const artifacts=structuredClone(rows);
  if(mode==='drift'&&reads===2)artifacts[0].digest='sha256:'+'0'.repeat(64);
  return Response.json({total_count:artifacts.length,artifacts});
 }
 const id=Number(url.pathname.split('/').at(-2));
 assert.equal(url.pathname,endpoint+'/artifacts/'+id+'/zip');assert.ok(id>=100&&id<=111);
 return new Response(null,{status:302,headers:{location:'https://productionresultssa1.blob.core.windows.net/actions-results/'+id+'?sig=fixture'}});
};
const api=await import(${JSON.stringify(entry)});
for(const scenario of ['ok','drift','short']){
 mode=scenario;reads=0;wire=[];deliveries=[];
 const source=await api.readActualNativePostSignController(parentReceipt);
 if(scenario==='ok'){
  const result=await api.readActualNativePostSignPublicInputs(source);
  assert.equal(result.authority,'none');assert.equal(result.roles.length,5);
  assert.ok(!(await readdir(result.directory)).some(name=>name.startsWith('native-proof-archive-')));
 }else await assert.rejects(api.readActualNativePostSignPublicInputs(source));
 const count=scenario==='short'?1:12;
 assert.equal(deliveries.length,count);assert.equal(new Set(deliveries).size,count);
 assert.equal(reads,scenario==='short'?1:2);
 assert.equal(wire.length,deliveries.length+reads);
}
`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", code, f.root], {
    timeout: 15000,
  });
});

void test("native duplicate identity binds the actual tuple and existing bounded recovery counters", () => {
  const report = nativeQualificationFixture();
  const prepare = (nonce: string) =>
    prepareNativeStageRequest(
      {
        schema_version: 1,
        stage: report.stage,
        platform_label: report.platform_label,
        candidate: report.candidate,
        journey: report.journey,
        invocation_id: nonce,
        setup_descriptor_sha256: "f".repeat(64),
      },
      nativeAuthorityConfigurationFixture(),
    );
  const counters = { transient_retries: 0, substantive_repairs: 0 };
  const first = nativeInvocationIdentity(prepare("0".repeat(64)), counters);
  assert.equal(
    first.invocation_id,
    nativeInvocationIdentity(prepare("e".repeat(64)), counters).invocation_id,
  );
  assert.equal(first.authority, "none");
  assert.notEqual(
    first.invocation_id,
    nativeInvocationIdentity(prepare("0".repeat(64)), { ...counters, transient_retries: 1 })
      .invocation_id,
  );
  for (const changed of [
    { ...counters, transient_retries: 3 },
    { ...counters, substantive_repairs: 4 },
    { ...counters, transient_retries: -1 },
    { ...counters, accepted: true },
  ])
    assert.throws(() => nativeInvocationIdentity(prepare("0".repeat(64)), changed));
});

void test("selection reconstructs exact package identities without native or admission authority", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const facts = {
    assembly: f.request,
    checkpoint: "c".repeat(40),
    archives: ["windows-x86_64", "linux-x86_64"].map((platform, index) => ({
      platform,
      artifact_id: 100 + index,
      bytes: 123,
      sha256: "d".repeat(64),
    })),
  };
  for (const platform of ["windows-x86_64", "linux-x86_64"] as const) {
    const file = f.request.files.find(
      (entry) => entry.platform_label === platform && /(?:\.exe|\.AppImage)$/u.test(entry.filename),
    );
    assert.ok(file);
    const bytes = f.contents.get(`${platform}/${file.filename}`);
    assert.ok(bytes);
    const retained = { identity: file, bytes };
    const selected = await inspectSelectedNativeCandidate(facts, platform, retained);
    assert.equal(selected.candidate.source_commit, f.request.source_commit);
    assert.equal(selected.candidate.source_tree, f.request.source_tree);
    assert.equal(selected.candidate.run_id, f.request.run_id);
    assert.equal(selected.candidate.package.sha256, file.sha256);
    assert.equal(selected.authority, "none");
    assert.equal(selected.scope, "integrity-only");
    for (const changed of [
      { ...retained, bytes: Buffer.from("changed") },
      { ...retained, identity: { ...file, sha256: "e".repeat(64) } },
      { ...retained, identity: { ...file, platform_label: "foreign" } },
    ])
      await assert.rejects(inspectSelectedNativeCandidate(facts, platform, changed));
    for (const archives of [
      facts.archives.slice(0, 1),
      [facts.archives[0]!, facts.archives[0]!],
      facts.archives.map((entry) => ({ ...entry, artifact_id: 0 })),
    ])
      await assert.rejects(
        inspectSelectedNativeCandidate({ ...facts, archives }, platform, retained),
      );
  }
});

void test("credentialled source routes admit only exact provider reads and query bodies", () => {
  const args = [
    "api",
    "--include",
    "repos/boburning/portcove/actions/runs/123",
    "--method",
    "GET",
    "--hostname",
    "github.com",
  ];
  assert.equal(inspectNativeSourceCommand(args).authority, "none");
  const query = ["api", "graphql", "--include", "--input", "-", "--hostname", "github.com"];
  inspectNativeSourceCommand(
    query,
    JSON.stringify({ query: "query($id:ID!){node(id:$id){id}}", variables: { id: "fixed" } }),
  );
  for (const changed of [
    args.map((value) => (value === "GET" ? "POST" : value)),
    args.map((value) => (value === "github.com" ? "foreign.invalid" : value)),
    args.map((value) => (value.startsWith("repos/") ? "repos/foreign/portcove" : value)),
    [...args, "--jq", ".token"],
    ["auth", "token"],
  ])
    assert.throws(() => inspectNativeSourceCommand(changed));
  assert.throws(() =>
    inspectNativeSourceCommand(
      query,
      JSON.stringify({ query: "mutation{deleteRepository{clientMutationId}}" }),
    ),
  );
  assert.throws(() => inspectNativeSourceCommand(args, "unexpected body"));
});

void test("imported parent and selected descriptors cannot start actual source collection", async () => {
  for (const raw of [{}, { kind: "actual-native-candidate-selection", accepted: true }]) {
    await assert.rejects(acquireActualNativeCandidate(raw), /actual installed native parent/);
    await assert.rejects(requireActualNativeCandidate(raw), /actual parent-owned/);
  }
});

void test("signed native package source binds the complete platform archive tuple and original compiler run", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const facts = {
    assembly: f.request,
    archives: ["windows-x86_64", "linux-x86_64"].map((platform, index) => ({
      platform,
      artifact_id: 100 + index,
      bytes: 123,
      sha256: "d".repeat(64),
    })),
  };
  const body = {
    id: 100,
    name: `release-build-windows-x86_64-${f.request.run_id}-${f.request.run_attempt}`,
    expired: false,
    size_in_bytes: 123,
    digest: "sha256:" + "d".repeat(64),
    workflow_run: {
      id: Number(f.request.run_id),
      repository_id: 1354613114,
      head_repository_id: 1354613114,
      head_sha: f.request.source_commit,
    },
  };
  const result = await inspectNativePostSignPackageMetadata(facts, "windows-x86_64", body);
  assert.equal(result.authority, "none");
  assert.equal(result.archive.artifact_id, 100);
  for (const changed of [
    { ...body, id: 101 },
    { ...body, expired: true },
    { ...body, size_in_bytes: 124 },
    { ...body, digest: "sha256:" + "e".repeat(64) },
    { ...body, name: body.name + "-other" },
    { ...body, workflow_run: { ...body.workflow_run, id: Number(f.request.run_id) + 1 } },
    { ...body, workflow_run: { ...body.workflow_run, head_sha: "e".repeat(40) } },
    { ...body, workflow_run: { ...body.workflow_run, head_repository_id: 1 } },
  ])
    await assert.rejects(inspectNativePostSignPackageMetadata(facts, "windows-x86_64", changed));
  await assert.rejects(
    inspectNativePostSignPackageMetadata(
      { ...facts, archives: facts.archives.slice(0, 1) },
      "windows-x86_64",
      body,
    ),
  );
  await assert.rejects(acquireActualNativePostSignCandidate({}), /actual installed native parent/);
});

void test("predecessor custody requires exact immutable Release and streams verified bytes around complete inventories", async (t) => {
  const payload = Buffer.from("opaque exact predecessor");
  const original = nativeQualificationFixture().candidate;
  const candidate = {
    ...original,
    package: {
      ...original.package,
      bytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    },
  };
  const url = `https://github.com/boburning/portcove/releases/download/v0.1.0-beta.1/${candidate.package.filename}`;
  const record = {
    version: "0.1.0-beta.1",
    source_commit: candidate.source_commit,
    source_tree: candidate.source_tree,
    artifact: { ...candidate.package, url },
  };
  const release = {
    id: 1,
    tag_name: "v0.1.0-beta.1",
    draft: false,
    immutable: true,
    published_at: "2026-10-20T12:00:00Z",
  };
  const asset = {
    id: 2,
    name: candidate.package.filename,
    state: "uploaded",
    size: candidate.package.bytes,
    digest: `sha256:${candidate.package.sha256}`,
    browser_download_url: url,
    url: "https://api.github.com/repos/boburning/portcove/releases/assets/2",
    download_count: 1,
  };
  const first = inspectNativePredecessorReleaseAsset(record, candidate, release, [asset]);
  assert.equal(first.id, 2);
  assert.deepEqual(
    first,
    inspectNativePredecessorReleaseAsset(record, candidate, release, [
      { ...asset, download_count: 2 },
    ]),
  );
  for (const [r, assets] of [
    [{ ...release, immutable: false }, [asset]],
    [{ ...release, draft: true }, [asset]],
    [{ ...release, tag_name: "v0.2.0" }, [asset]],
    [release, [{ ...asset, size: asset.size + 1 }]],
    [release, [{ ...asset, digest: "sha256:" + "f".repeat(64) }]],
    [release, [asset, asset]],
    [release, [{ ...asset, browser_download_url: url + "?other" }]],
  ] as const)
    assert.throws(() => inspectNativePredecessorReleaseAsset(record, candidate, r, assets));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-predecessor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let observations = 0;
  let fault = "";
  const routes: string[] = [];
  const acquire = () =>
    acquireNativePredecessorRelease(record, candidate, root, {
      credential: { kind: "explicit", token: "fixed-fixture-native-reader" },
      deadline: performance.now() + 5000,
      recheck() {},
      async fetch(input, init) {
        const request = new Request(input, init);
        const endpoint = new URL(request.url);
        assert.equal(endpoint.origin, "https://api.github.com");
        assert.equal(request.headers.get("authorization"), "token fixed-fixture-native-reader");
        const route = endpoint.pathname + endpoint.search;
        routes.push(route);
        switch (route) {
          case "/repos/boburning/portcove/releases/tags/v0.1.0-beta.1":
            observations++;
            return Response.json(release);
          case "/repos/boburning/portcove/releases/1/assets":
            return Response.json([{ id: 3 }], {
              headers: {
                link:
                  fault === "malformed"
                    ? "rel=next"
                    : `<https://api.github.com/repositories/1354613114/releases/1/assets?page=${fault === "skip" ? 3 : 2}>; rel="next"`,
              },
            });
          case "/repositories/1354613114/releases/1/assets?page=2":
            return Response.json([
              fault === "drift" && observations === 2 ? { ...asset, state: "new" } : asset,
            ]);
          case "/repos/boburning/portcove/releases/assets/2":
            assert.equal(request.headers.get("accept"), "application/octet-stream");
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(payload.subarray(0, 1));
                  if (fault !== "short") controller.enqueue(payload.subarray(1));
                  controller.close();
                },
              }),
            );
          default:
            throw new Error("unexpected predecessor fixture route");
        }
      },
    });
  for (const refusal of ["skip", "malformed", "short", "drift"]) {
    fault = refusal;
    observations = 0;
    await assert.rejects(acquire());
    assert.deepEqual(await readdir(root), []);
  }
  fault = "";
  routes.length = 0;
  const retained = await acquire();
  assert.deepEqual(await readFile(retained.path), payload);
  assert.deepEqual(routes, [
    "/repos/boburning/portcove/releases/tags/v0.1.0-beta.1",
    "/repos/boburning/portcove/releases/1/assets",
    "/repositories/1354613114/releases/1/assets?page=2",
    "/repos/boburning/portcove/releases/assets/2",
    "/repos/boburning/portcove/releases/tags/v0.1.0-beta.1",
    "/repos/boburning/portcove/releases/1/assets",
    "/repositories/1354613114/releases/1/assets?page=2",
  ]);
  await assert.rejects(acquire(), { code: "EEXIST" });
  assert.deepEqual(await readFile(retained.path), payload);
  assert.deepEqual(await readdir(root), [path.basename(retained.path)]);
  assert.throws(() =>
    inspectNativeSourceCommand([
      "api",
      "--hostname",
      "github.com",
      "-H",
      "Accept: application/octet-stream",
      "repos/boburning/portcove/issues",
    ]),
  );
});

void test("native detached payload verifier uses the same pinned keyless tool with exact private paths and refuses credentials before reading", async () => {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    directory = path.join(root, "work/inert-native-payload");
  const plan = {
    schema_version: 1,
    artifact: path.join(directory, "setup.exe"),
    signature: path.join(directory, "payload.sig"),
    public_key: path.join(directory, "public.key"),
    public_key_sha256: "c".repeat(64),
    sha256: "a".repeat(64),
    bytes: 128,
    version: "0.1.0-beta.1",
    output_parent: directory,
    tool: {
      path: path.join(
        root,
        "tools",
        process.platform === "win32" ? "portcove-release-tools.exe" : "portcove-release-tools",
      ),
      sha256: "b".repeat(64),
    },
  };
  const selected = inspectNativePayloadVerificationPlan(plan, directory);
  assert.equal(selected.bytes, 128);
  for (const changed of [
    { ...plan, artifact: root },
    { ...plan, signature: path.join(root, "foreign.sig") },
    { ...plan, public_key: "relative.key" },
    { ...plan, sha256: "unknown" },
    { ...plan, bytes: 0 },
    { ...plan, tool: { ...plan.tool, path: path.join(directory, "candidate.exe") } },
    { ...plan, accepted: true },
  ])
    assert.throws(() => inspectNativePayloadVerificationPlan(changed, directory));
  await assert.rejects(
    runNativePayloadVerificationPlan(path.join(directory, "wrong-plan.json"), "a".repeat(64)),
    /fixed native payload verifier/,
  );
});

void test(
  "actual fixed Node CLI assembles disposable five-role Tough repository and verifies selected signed payload with retained refusals",
  {
    skip: !process.env.PORTCOVE_NATIVE_KEYLESS_FIXTURE_TOOL,
    timeout: 180000,
  },
  async (t) => {
    const execute = promisify(execFile),
      sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    const sourceTool = process.env.PORTCOVE_NATIVE_KEYLESS_FIXTURE_TOOL!,
      toolHash = process.env.PORTCOVE_NATIVE_KEYLESS_FIXTURE_SHA256!;
    assert.match(toolHash, /^[a-f0-9]{64}$/u);
    const toolBytes = await readFile(sourceTool);
    assert.equal(sha(toolBytes), toolHash);
    const checkout = fileURLToPath(new URL("..", import.meta.url));
    await mkdir(path.join(checkout, "work/slice4"), { recursive: true });
    const root = await mkdtemp(path.join(checkout, "work/slice4/native-keyless-cli-"));
    t.diagnostic(`retained disposable public fixture: ${root}`);
    const tool = {
      path: path.join(
        root,
        process.platform === "win32" ? "portcove-release-tools.exe" : "portcove-release-tools",
      ),
      sha256: toolHash,
    };
    await writeFile(tool.path, toolBytes, { flag: "wx", mode: 0o700 });
    const input = path.join(root, "context"),
      keys = await disposableTufWorkerFixture(input);
    const signed: Awaited<ReturnType<typeof signIsolatedTufRole>>[] = [];
    for (const role of ["releases", "preview", "stable", "snapshot", "timestamp"] as const) {
      const key = Buffer.from(keys[role]);
      const result = await signIsolatedTufRole(
        {
          role,
          context_directory: input,
          output: path.join(root, role),
          tool,
          signed_roles: tufRoleDependencies(role).map((name) => {
            const item = signed.find((entry) => entry.role === name);
            assert.ok(item);
            return {
              filename: item.filename,
              path: item.path,
              bytes: item.bytes,
              sha256: item.sha256,
            };
          }),
        },
        {
          deadline: performance.now() + 15000,
          beforeKey: async () => {},
          keyMaterial: async () => key,
        },
      );
      assert.ok(key.every((byte) => byte === 0));
      signed.push(result);
      keys[role].fill(0);
    }
    const environment = {
      SystemRoot: process.env.SystemRoot,
      LANG: "C.UTF-8",
      PATH: path.dirname(process.execPath),
    };
    const cli = fileURLToPath(new URL("./release-native-keyless-assembly.mts", import.meta.url));
    const invoke = async (directory: string, name: string, plan: unknown) => {
      const wire = Buffer.from(JSON.stringify(plan)),
        filename = path.join(directory, name);
      await writeFile(filename, wire, { flag: "wx", mode: 0o600 });
      return execute(process.execPath, [cli, filename, sha(wire)], {
        cwd: checkout,
        env: environment,
        timeout: 100000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
    };
    const assemblyPlan = {
      schema_version: 1,
      context_directory: input,
      output_parent: root,
      tool,
      signed_roles: signed.map(({ filename, path, bytes, sha256 }) => ({
        filename,
        path,
        bytes,
        sha256,
      })),
    };
    await invoke(root, "native-keyless-plan.json", assemblyPlan);
    const assembly = JSON.parse(
      await readFile(path.join(root, "native-keyless-result.json"), "utf8"),
    ) as { assembled: { records: number; publication: { records_sha256: string } } };
    assert.equal(assembly.assembled.records, 0);
    assert.equal(assembly.assembled.publication.records_sha256, sha(Buffer.from("[]")));
    const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
    const cliRequire = createRequire(desktopRequire.resolve("@tauri-apps/cli/package.json"));
    const addon = cliRequire.resolve(
      `@tauri-apps/cli-${process.platform === "win32" ? "win32-x64-msvc" : "linux-x64-gnu"}`,
    );
    const launcher = path.join(root, "fixture-signer.cjs");
    await writeFile(
      launcher,
      `require(${JSON.stringify(addon)}).run(process.argv.slice(2),"tauri",e=>{if(e)process.exitCode=1});`,
      { flag: "wx" },
    );
    const privatePath = path.join(root, "disposable.key");
    await execute(
      process.execPath,
      [launcher, "signer", "generate", "--ci", "--password", "", "--write-keys", privatePath],
      { env: environment, timeout: 30000, maxBuffer: 65536, windowsHide: true },
    );
    const privateKey = await readFile(privatePath, "utf8"),
      publicKey = `${privatePath}.pub`;
    const version = "0.3.0-beta.1",
      filename = "Portcove_0.3.0-beta.1_x64-setup.exe",
      payload = Buffer.from(Array.from({ length: 180321 }, (_, i) => i % 251));
    const artifact = path.join(root, filename);
    await writeFile(artifact, payload, { flag: "wx" });
    const keySha = sha(Buffer.from((await readFile(publicKey, "utf8")).trim(), "base64"));
    let signaturePath: string;
    try {
      await signReleasePayload(
        {
          projectRoot: checkout,
          payload: artifact,
          publicKey,
          output: path.join(root, "signed"),
          request: {
            schema_version: 1,
            repository: "boburning/portcove",
            version,
            source_commit: "a".repeat(40),
            platform_label: "windows-x86_64",
            filename,
            sha256: sha(payload),
            bytes: payload.length,
            public_key_sha256: keySha,
            qualification_inventory_sha256: "b".repeat(64),
            reservation_checkpoint: "c".repeat(40),
            aggregate_archive_sha256: "d".repeat(64),
            producer: { run_id: "1", run_attempt: 1, job_id: "2", artifact_id: "3" },
          },
          tools: {
            node: { path: process.execPath, sha256: sha(await readFile(process.execPath)) },
            tauriAddon: { path: addon, sha256: sha(await readFile(addon)) },
            verifier: tool,
          },
        },
        {
          deadline: performance.now() + 60000,
          beforeSign: async () => {},
          keyMaterial: async () => ({ key: privateKey, password: "" }),
        },
      );
      signaturePath = path.join(root, "signed", `${filename}.sig`);
    } finally {
      await rm(privatePath);
    }
    const payloadPlan = {
      schema_version: 1,
      artifact,
      signature: signaturePath!,
      public_key: publicKey,
      public_key_sha256: keySha,
      bytes: payload.length,
      sha256: sha(payload),
      version,
      tool,
      output_parent: root,
    };
    await invoke(root, "native-payload-plan.json", payloadPlan);
    const result = JSON.parse(
      await readFile(path.join(root, "native-payload-result.json"), "utf8"),
    ) as { report: { signature_verified: boolean } };
    assert.equal(result.report.signature_verified, true);
    const negative = path.join(root, "tampered-payload");
    await mkdir(negative);
    const changed = Buffer.from(payload);
    changed[0] = changed[0]! ^ 1;
    await writeFile(path.join(negative, filename), changed);
    await copyFile(signaturePath!, path.join(negative, "payload.sig"));
    await copyFile(publicKey, path.join(negative, "public.key"));
    await assert.rejects(
      invoke(negative, "native-payload-plan.json", {
        ...payloadPlan,
        artifact: path.join(negative, filename),
        signature: path.join(negative, "payload.sig"),
        public_key: path.join(negative, "public.key"),
        output_parent: negative,
      }),
    );
    assert.equal(
      (
        JSON.parse(await readFile(path.join(negative, "native-payload-refusal.json"), "utf8")) as {
          authority: string;
        }
      ).authority,
      "none",
    );
    const corrupt = path.join(root, "corrupt-envelope");
    await mkdir(corrupt);
    const altered = Buffer.from('{"signed":{},"signatures":[]}');
    const alteredPath = path.join(corrupt, "releases.json");
    await writeFile(alteredPath, altered);
    await cp(input, path.join(corrupt, "context"), { recursive: true, errorOnExist: true });
    const corruptRoles = [];
    for (const item of assemblyPlan.signed_roles) {
      const bytes = item.filename === "releases.json" ? altered : await readFile(item.path);
      const filename = path.join(corrupt, item.filename);
      if (filename !== alteredPath) await writeFile(filename, bytes, { flag: "wx" });
      corruptRoles.push({
        filename: item.filename,
        path: filename,
        bytes: bytes.length,
        sha256: sha(bytes),
      });
    }
    await assert.rejects(
      invoke(corrupt, "native-keyless-plan.json", {
        ...assemblyPlan,
        output_parent: corrupt,
        context_directory: path.join(corrupt, "context"),
        signed_roles: corruptRoles,
      }),
    );
    assert.equal(
      (
        JSON.parse(await readFile(path.join(corrupt, "native-keyless-refusal.json"), "utf8")) as {
          authority: string;
        }
      ).authority,
      "none",
    );
    // The exact original contexts/results remain public fixture evidence only.
    await writeFile(
      path.join(root, "qualification.json"),
      JSON.stringify({
        schema_version: 1,
        source_tool_sha256: toolHash,
        node_sha256: sha(await readFile(process.execPath)),
        outcomes: [
          "actual-cli-five-role-tough-assembled",
          "actual-cli-selected-payload-verified",
          "actual-cli-tampered-payload-refused",
          "actual-cli-corrupt-envelope-refused",
        ],
        authority: "none",
        scope:
          "disposable crypto/CLI integration; no parent Task, native package or production qualification",
      }),
      { flag: "wx", mode: 0o600 },
    );
  },
);
