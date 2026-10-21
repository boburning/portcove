import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  catalogSigningAdmissionDigest,
  catalogSigningContextBytes,
  inspectCatalogSigningFacts,
  inspectCatalogContextPaths,
  inspectIsolatedCatalogRoleRequest,
  catalogRoleDependencies,
} from "./release-catalog-signing-contract.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  inspectSigningContextArchive,
  requireReceivedCatalogSigningContext,
  requireReceivedSigningContext,
  prepareCatalogSigningContextArtifact,
} from "./release-signing-context-artifact.mts";
import {
  requireActualCatalogSigningContext,
  bindActualCatalogSigningContextPending,
} from "./release-catalog-signing-context.mts";
import { requireActualCoordinatorCatalogPreparation } from "./release-coordinator-driver.mts";
import {
  requireActualCatalogRepository,
  requirePreparedCatalogRoleOutput,
  runCatalogRoleController,
  assembleActualCatalogRepository,
  catalogRoleControllerDeadline,
} from "./release-catalog-signing.mts";
import { requireReceivedCatalogRoleArtifact } from "./release-tuf-role-artifact.mts";
import {
  catalogOriginalJobDeadline,
  tufOriginalJobDeadline,
} from "./release-signing-job-budget.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const index = Buffer.from('{"index_schema":1,"definitions":[],"contents":[]}'),
    bundle = [{ target: "definitions/index.json", bytes: index.length, sha256: hash(index) }],
    inspection = Buffer.from(
      JSON.stringify({
        publication_schema: 1,
        authority: "none",
        scope: "inert-managed-definition-publication-inspection",
        index_sha256: hash(index),
        files: bundle,
        definitions: [],
      }),
    );
  const root = Buffer.from("inert public anchor; no Tough acceptance"),
    top = Buffer.from("inert offline Targets"),
    prior = {
      application_repository_sha256: null,
      application_root_sha256: null,
      catalog_repository_sha256: null,
      catalog_root_sha256: hash(root),
      site_generation_sha256: null,
    };
  const opportunity = {
    kind: "catalog-publication",
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    base_commit: "c".repeat(40),
    change_set_sha256: "d".repeat(64),
    bundle_sha256: digest(bundle),
    core_inspection_sha256: hash(inspection),
    publisher_configuration_sha256: "e".repeat(64),
    baseline: { source_commit: "c".repeat(40), source_tree: "f".repeat(40), ...prior },
    classification: { change: "initial", index_sha256: hash(index), definitions: [] },
    compatibility: {
      contract: "official-definition-policy-launch-v1",
      notes: "Inert transport test, no Core invocation or actual review.",
    },
  };
  const descriptor = {
    schema_version: 1,
    kind: "catalog-publication",
    source_commit: opportunity.source_commit,
    source_tree: opportunity.source_tree,
    bundle_sha256: opportunity.bundle_sha256,
    core_inspection_sha256: opportunity.core_inspection_sha256,
    publisher_configuration_sha256: opportunity.publisher_configuration_sha256,
    admission_sha256: catalogSigningAdmissionDigest({
      ...opportunity,
      semantic_proof_sha256: "1".repeat(64),
    }),
    prior,
  };
  const facts = inspectCatalogSigningFacts({
      kind: "catalog-signing",
      namespace: "fixture",
      descriptor,
      semantic_opportunity: opportunity,
      semantic_check_id: 303,
      semantic_proof_sha256: "1".repeat(64),
      root_sha256: hash(root),
      offline_targets_sha256: hash(top),
    generated_at: "2026-10-21T00:00:00Z",
      expires: {
        definitions: "2026-10-22T00:00:00Z",
        policy: "2026-10-22T00:00:00Z",
        snapshot: "2026-10-22T00:00:00Z",
        timestamp: "2026-10-22T00:00:00Z",
      },
      versions: { definitions: "9007199254740993", policy: "1", snapshot: "1", timestamp: "1" },
    }),
    context = catalogSigningContextBytes(facts);
  const files = new Map([
      ["bundle/definitions/index.json", index],
      ["context.json", context],
      ["core-inspection.json", inspection],
      ["offline-targets.json", top],
      ["trusted-root.json", root],
    ]),
    binding = {
      source_commit: descriptor.source_commit,
      source_tree: descriptor.source_tree,
      bundle_sha256: descriptor.bundle_sha256,
      core_inspection_sha256: descriptor.core_inspection_sha256,
      descriptor_sha256: digest(descriptor),
      root_sha256: facts.root_sha256,
      offline_targets_sha256: facts.offline_targets_sha256,
      semantic_proof_sha256: facts.semantic_proof_sha256,
      context_sha256: hash(context),
    };
  const archive = (
    changed: ReadonlyMap<string, Buffer> = files,
    override: Record<string, unknown> = {},
  ) => {
    const ordered = [...changed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      manifest = {
        schema_version: 1,
        kind: "catalog-signing-context",
        authority: "none",
        controller: {
          controller_revision: "2".repeat(40),
          source_tree: "3".repeat(40),
          controller_ref: "refs/tags/portcove-production-controller-fixture",
          run_id: "123",
          run_attempt: 1,
        },
        binding,
        facts,
        control_facts: { pause: { publication_paused: false }, capacity: {} },
        facts_sha256: digest(facts),
        previous_site_pins: prior,
        files: ordered.map(([name, bytes]) => ({
          path: name,
          bytes: bytes.length,
          sha256: hash(bytes),
        })),
        ...override,
      };
    return createAuditZip([
      ["signing-context-manifest.json", Buffer.from(JSON.stringify(manifest))],
      ["signing-context-bytes.bin", Buffer.concat(ordered.map(([, bytes]) => bytes))],
    ]);
  };
  return { facts, context, files, binding, archive };
}
void test("catalog context transports exact independent purpose, full byte inventory and lossless u64 wire", () => {
  const f = fixture(),
    actual = inspectSigningContextArchive(f.archive());
  assert.equal(actual.manifest.kind, "catalog-signing-context");
  assert.equal(actual.authority, "none");
  assert.deepEqual(actual.files, f.files);
  assert.match(f.context.toString(), /"definitions":9007199254740993/u);
  assert.equal(inspectCatalogContextPaths(f.context).bootstrap, true);
  for (const [name, bytes] of [
    ["payload.json", Buffer.from("app-only")],
    ["prior/metadata/timestamp.json", Buffer.from("invented prior")],
    ["bundle/definitions/index.json", Buffer.from("changed")],
  ] as const)
    assert.throws(() =>
      inspectSigningContextArchive(f.archive(new Map([...f.files, [name, bytes]]))),
    );
  for (const override of [
    { kind: "metadata-signing-context" },
    { authority: "publisher" },
    { previous_site_pins: null },
    { facts_sha256: "9".repeat(64) },
  ])
    assert.throws(() => inspectSigningContextArchive(f.archive(f.files, override)));
  for (const field of [
    "source_commit",
    "source_tree",
    "bundle_sha256",
    "core_inspection_sha256",
    "publisher_configuration_sha256",
    "admission_sha256",
  ] as const)
    assert.throws(() =>
      inspectCatalogSigningFacts({
        ...f.facts,
        descriptor: {
          ...f.facts.descriptor,
          [field]: "9".repeat(field.startsWith("source_") ? 40 : 64),
        },
      }),
    );
  assert.throws(() =>
    inspectCatalogContextPaths(Buffer.from(f.context.toString().replace('"bundle"', '"/caller"'))),
  );
});
void test("catalog role dependencies stay separate from app and reject missing or reordered actual wire roles", () => {
  assert.deepEqual(catalogRoleDependencies("snapshot"), ["definitions", "policy"]);
  assert.deepEqual(catalogRoleDependencies("timestamp"), ["definitions", "policy", "snapshot"]);
  for (const role of ["root", "targets", "releases", "preview", null])
    assert.throws(() => catalogRoleDependencies(role));
  const request = {
    role: "snapshot",
    context_directory: path.resolve("fixture-context"),
    output: path.resolve("fixture-output"),
    tool: { path: path.resolve("fixed-tool"), sha256: "1".repeat(64) },
    signed_roles: [
      {
        filename: "official-definitions.json",
        path: path.resolve("definitions"),
        bytes: 1,
        sha256: "2".repeat(64),
      },
      {
        filename: "official-policy.json",
        path: path.resolve("policy"),
        bytes: 1,
        sha256: "3".repeat(64),
      },
    ],
  };
  assert.equal(inspectIsolatedCatalogRoleRequest(request).role, "snapshot");
  assert.throws(() =>
    inspectIsolatedCatalogRoleRequest({
      ...request,
      signed_roles: [...request.signed_roles].reverse(),
    }),
  );
  assert.throws(() => inspectIsolatedCatalogRoleRequest({ ...request, signed_roles: [] }));
  assert.throws(() =>
    inspectIsolatedCatalogRoleRequest({
      ...request,
      signed_roles: request.signed_roles.map((file) => ({
        ...file,
        filename: file.filename.replace("official-", ""),
      })),
    }),
  );
});
void test("catalog job clocks derive from original fixed provider start and refuse app purpose, drift and exhaustion", () => {
  const now = Date.parse("2026-10-21T00:00:00.000Z"),
    identity = { run_id: "123", controller_revision: "a".repeat(40) };
  for (const role of ["definitions", "policy", "snapshot", "timestamp"] as const) {
    const phase = `catalog-${role}` as const,
      job = {
        id: 4,
        run_id: 123,
        run_attempt: 1,
        head_sha: identity.controller_revision,
        status: "in_progress",
        started_at: new Date(now - 1000).toISOString(),
        name: releaseControlPhaseProfile(phase).reader_name,
      },
      inventory = { total_count: 1, jobs: [job] };
    assert.equal(catalogOriginalJobDeadline(phase, inventory, identity, now, 30), 114030);
    assert.equal(catalogOriginalJobDeadline(phase, inventory, identity, now + 50000, 30), 64030);
    assert.throws(() => catalogOriginalJobDeadline(phase, inventory, identity, now + 114000, 30));
    assert.throws(() =>
      catalogOriginalJobDeadline(phase, { total_count: 2, jobs: [job, job] }, identity, now, 30),
    );
    assert.throws(() =>
      catalogOriginalJobDeadline(
        phase,
        { total_count: 1, jobs: [{ ...job, name: `Sign authenticated ${role} metadata` }] },
        identity,
        now,
        30,
      ),
    );
    assert.throws(() => tufOriginalJobDeadline(phase, inventory, identity, now, 30));
  }
  assert.throws(() => catalogOriginalJobDeadline("tuf-snapshot", {}, identity));
  assert.throws(() => catalogRoleControllerDeadline(performance.now() - 1));
});
void test("imported contexts, preparations, roles and assemblies cannot reach real protected outputs", async () => {
  const copied = { kind: "actual-catalog-signing-context", authority: "none" };
  for (const call of [
    () => requireActualCatalogSigningContext(copied),
    () => requireActualCoordinatorCatalogPreparation(copied),
    () => requireReceivedCatalogSigningContext(copied),
    () => requireReceivedSigningContext(copied),
    () => requireReceivedCatalogRoleArtifact(copied),
    () => requireActualCatalogRepository(copied),
    () => requirePreparedCatalogRoleOutput(copied),
    () => prepareCatalogSigningContextArtifact(copied, path.resolve("missing-output")),
  ])
    await assert.rejects(call);
  await assert.rejects(() =>
    bindActualCatalogSigningContextPending(
      copied,
      {} as Parameters<typeof bindActualCatalogSigningContextPending>[1],
      { checkpoint: "a".repeat(40), operation_id: "b".repeat(64) },
    ),
  );
  await assert.rejects(() =>
    runCatalogRoleController(
      "definitions",
      {},
      copied,
      copied,
      [],
      path.resolve("missing-output"),
      performance.now() - 1,
    ),
  );
  await assert.rejects(() =>
    assembleActualCatalogRepository(
      copied,
      copied,
      [],
      path.resolve("missing-output"),
      performance.now() - 1,
    ),
  );
});
