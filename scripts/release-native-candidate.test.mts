import assert from "node:assert/strict";
import test from "node:test";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import {
  inspectSelectedNativeCandidate,
  acquireActualNativeCandidate,
  requireActualNativeCandidate,
  inspectNativeSourceCommand,
  nativeInvocationIdentity,
  inspectNativePostSignController,
  readActualNativePostSignController,
  requireActualNativePostSignController,
} from "./release-native-candidate.mts";
import { capacityDigest } from "./release-capacity.mts";
import { prepareNativeStageRequest } from "./release-native-stage-capture.mts";
import { nativeAuthorityConfigurationFixture } from "./fixtures/native-authority-configuration-fixture.mts";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";

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
