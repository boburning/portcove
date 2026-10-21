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
import { inspectNativeKeylessAssemblyPlan } from "./release-native-keyless-assembly.mts";

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
