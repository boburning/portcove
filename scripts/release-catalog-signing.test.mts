import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { isRecord } from "./runtime-values.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
} from "./release-coordinator-state.mts";
import { performance } from "node:perf_hooks";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  catalogSigningAdmissionDigest,
  catalogSigningContextBytes,
  inspectCatalogSigningFacts,
  inspectCatalogContextPaths,
  inspectIsolatedCatalogRoleRequest,
  catalogRoleDependencies,
  assertCatalogSemanticPublishedBaseline,
  deriveCatalogSigningDescriptor,
  inspectCatalogSigningPreflight,
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
  recheckCatalogSemanticProof,
} from "./release-catalog-signing.mts";
import { requireReceivedCatalogRoleArtifact } from "./release-tuf-role-artifact.mts";
import {
  catalogOriginalJobDeadline,
  tufOriginalJobDeadline,
} from "./release-signing-job-budget.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import {
  retainControllerUpload,
  retainControllerAttestation,
  retainControllerRoleKey,
  nextControllerTransport,
  acknowledgeControllerTransport,
  normalizeControllerAttestationBundle,
  retainControllerJobSettlement,
  inspectControllerTransportEvent,
} from "./release-controller-transport.mts";
import {
  prepareSemanticReviewHandoff,
  semanticReviewCheckName,
} from "./release-semantic-review.mts";
import { readIndependentCatalogSemanticReview } from "./release-control-inputs.mts";
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
void test("catalog subject derives from actual source tuple and accepted catalog baseline, never app/latest source", () => {
  const f = fixture(),
    op = f.facts.semantic_opportunity,
    inspection = {
      source: { commit: op.source_commit, tree: op.source_tree },
      bundle_sha256: op.bundle_sha256,
      inspection_sha256: op.core_inspection_sha256,
    };
  const initial = {
    commit: op.baseline.source_commit,
    tree: op.baseline.source_tree,
    root_sha256: f.facts.root_sha256,
  };
  assert.deepEqual(assertCatalogSemanticPublishedBaseline(op, null, initial), op);
  assert.throws(() =>
    assertCatalogSemanticPublishedBaseline(op, null, { ...initial, commit: op.source_commit }),
  );
  assert.throws(() =>
    assertCatalogSemanticPublishedBaseline(op, null, { ...initial, tree: op.source_tree }),
  );
  assert.deepEqual(
    deriveCatalogSigningDescriptor(
      op,
      inspection,
      op.publisher_configuration_sha256,
      f.facts.semantic_proof_sha256,
      {},
      f.facts.root_sha256,
    ),
    f.facts.descriptor,
  );
  assert.throws(() =>
    deriveCatalogSigningDescriptor(
      op,
      { ...inspection, source: { ...inspection.source, tree: "9".repeat(40) } },
      op.publisher_configuration_sha256,
      f.facts.semantic_proof_sha256,
      {},
      f.facts.root_sha256,
    ),
  );
  const versions = { targets: "1", definitions: "1", policy: "1", snapshot: "1", timestamp: "1" },
    expires = Object.fromEntries(
      Object.keys(versions).map((role) => [role, "2026-10-22T00:00:00Z"]),
    ),
    seed = {
      schema_version: 1,
      root_sha256: f.facts.root_sha256,
      offline_targets_sha256: f.facts.offline_targets_sha256,
      index_sha256: op.classification.index_sha256,
      repository_sha256: "4".repeat(64),
      verifier_repository_sha256: "5".repeat(64),
      snapshot_sha256: "6".repeat(64),
      timestamp_sha256: "7".repeat(64),
      immutable_targets_sha256: "8".repeat(64),
      versions,
      expires,
      source_commit: op.baseline.source_commit,
      source_tree: op.baseline.source_tree,
      operation_id: "9".repeat(64),
      publication: {
        evidence_sha256: "a".repeat(64),
        remote_identity: "inert:catalog",
        site_generation_sha256: "b".repeat(64),
      },
    };
  const updated = {
    ...op,
    baseline: {
      ...op.baseline,
      catalog_repository_sha256: seed.repository_sha256,
      site_generation_sha256: seed.publication.site_generation_sha256,
    },
    classification: { ...op.classification, change: "update" },
  };
  assert.equal(
    assertCatalogSemanticPublishedBaseline(updated, seed, null).baseline.source_commit,
    seed.source_commit,
  );
  assert.throws(() =>
    assertCatalogSemanticPublishedBaseline(
      updated,
      { ...seed, source_commit: op.source_commit },
      null,
    ),
  );
  assert.throws(() =>
    assertCatalogSemanticPublishedBaseline(updated, { ...seed, source_tree: op.source_tree }, null),
  );
  const site = {
      schema_version: 1,
      generation_sha256: seed.publication.site_generation_sha256,
      components: {
        application: null,
        catalog: { root_sha256: seed.root_sha256, repository_sha256: seed.repository_sha256 },
      },
      operation_id: seed.operation_id,
      publication: {
        evidence_sha256: seed.publication.evidence_sha256,
        remote_identity: seed.publication.remote_identity,
      },
    },
    input = { published_catalog_metadata: seed, published_site: site };
  const descriptor = deriveCatalogSigningDescriptor(
    updated,
    inspection,
    op.publisher_configuration_sha256,
    f.facts.semantic_proof_sha256,
    input,
    f.facts.root_sha256,
  );
  assert.equal(descriptor.prior.catalog_repository_sha256, seed.repository_sha256);
  assert.throws(() =>
    deriveCatalogSigningDescriptor(
      updated,
      inspection,
      op.publisher_configuration_sha256,
      f.facts.semantic_proof_sha256,
      { ...input, published_site: { ...site, generation_sha256: "d".repeat(64) } },
      f.facts.root_sha256,
    ),
  );
});
void test("catalog producer reserves complete prior site, new targets and four envelopes before keys without increasing caps", () => {
  const f = fixture(),
    small = inspectCatalogSigningPreflight(f.files, []);
  assert.equal(small.authority, "none");
  assert.ok(small.site_bytes_upper_bound >= 6 * 1024 ** 2);
  assert.equal(small.context_files, f.files.size);
  assert.throws(
    () =>
      inspectCatalogSigningPreflight(
        new Map([...f.files, ["bundle/too-large", Buffer.alloc(1024 ** 2 + 1)]]),
        [],
      ),
    /per-file/,
  );
  const many = new Map(Array.from({ length: 2209 }, (_, i) => [`bundle/${i}`, Buffer.from("x")]));
  assert.throws(() => inspectCatalogSigningPreflight(many, []), /aggregate/);
  const prior = Array.from({ length: 5993 }, (_, i) => ({
    path: i ? `catalog/targets/retained-${i}` : ".nojekyll",
    bytes: 1,
    sha256: "1".repeat(64),
  }));
  assert.throws(() => inspectCatalogSigningPreflight(f.files, prior), /complete-site/);
  const full = Array.from({ length: 4 }, (_, i) => ({
    path: `application/targets/retained-${i}`,
    bytes: 64 * 1024 ** 2,
    sha256: "2".repeat(64),
  }));
  assert.throws(() => inspectCatalogSigningPreflight(f.files, full), /complete-site/);
  assert.throws(() => inspectCatalogSigningPreflight(f.files, [prior[0]!, prior[0]!]), /inventory/);
});
void test("catalog descriptor checkpoint uses existing journal CAS and preserves inert setup and capacity state", async (t) => {
  const journal = await mkdtemp(path.join(os.tmpdir(), "catalog-subject-cas-"));
  t.after(() => rm(journal, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "--quiet", journal], {
    windowsHide: true,
    timeout: 10000,
  });
  const raw: unknown = JSON.parse(
    await readFile(new URL("./fixtures/release-coordinator-legacy.json", import.meta.url), "utf8"),
  );
  assert.ok(
    isRecord(raw) &&
      Array.isArray(raw.rows) &&
      isRecord(raw.rows[0]) &&
      isRecord(raw.rows[0].input),
  );
  const input = structuredClone(raw.rows[0].input),
    f = fixture(),
    op = f.facts.semantic_opportunity;
  input.schema_version = 2;
  input.opportunity = null;
  input.active_candidate = null;
  input.controller = {
    workflow: ".github/workflows/fixture.yml",
    revision: "3".repeat(40),
    publication_paused: false,
    capacity_attempt: { ...capacityFixture(), schema_version: 2 },
  };
  input.catalog_initialization = {
    schema_version: 1,
    kind: "catalog-initialization",
    authority: "none",
    source_commit: op.baseline.source_commit,
    source_tree: op.baseline.source_tree,
    root_sha256: f.facts.root_sha256,
    publisher_configuration_sha256: op.publisher_configuration_sha256,
    setup_plan_sha256: "4".repeat(64),
    initial_site_preimage_sha256: "5".repeat(64),
  };
  const initial = await checkpointReleaseOpportunity(journal, null, input),
    before = await recoverReleaseOpportunity(journal, initial.checkpoint);
  assert.equal(before.plan.action, "skip");
  const descriptor = deriveCatalogSigningDescriptor(
      op,
      {
        source: { commit: op.source_commit, tree: op.source_tree },
        bundle_sha256: op.bundle_sha256,
        inspection_sha256: op.core_inspection_sha256,
      },
      op.publisher_configuration_sha256,
      f.facts.semantic_proof_sha256,
      input,
      f.facts.root_sha256,
    ),
    selected = { ...input, catalog_publication: descriptor },
    checkpoint = await checkpointReleaseOpportunity(journal, initial.checkpoint, selected),
    after = await recoverReleaseOpportunity(journal, checkpoint.checkpoint);
  assert.equal(after.plan.action, "catalog-publication");
  assert.deepEqual(after.input.controller, input.controller);
  assert.deepEqual(after.input.catalog_initialization, input.catalog_initialization);
  assert.deepEqual(after.input.catalog_publication, descriptor);
  const { catalog_publication: _subject, ...other } = after.input;
  assert.deepEqual(other, input);
  await assert.rejects(() =>
    checkpointReleaseOpportunity(journal, initial.checkpoint, {
      ...selected,
      catalog_publication: { ...descriptor, bundle_sha256: "9".repeat(64) },
    }),
  );
  assert.equal(
    (await recoverReleaseOpportunity(journal, checkpoint.checkpoint)).checkpoint,
    checkpoint.checkpoint,
  );
});
void test("actual coordinator journal wrapper rechecks controls at every REST and GraphQL mutation after export delay", async () => {
  const source = await readFile(
      new URL("./release-coordinator-driver.mts", import.meta.url),
      "utf8",
    ),
    start = source.indexOf("function guardedCoordinatorJournal("),
    end = source.indexOf("/** Provider inventory facts only.", start);
  assert.ok(start > 0 && end > start);
  const observed: string[] = [],
    journal = {
      request(method: string) {
        observed.push(method);
        return {};
      },
      graphql(query: string) {
        observed.push(query);
        return {};
      },
    };
  const raw: unknown = runInNewContext(
    `${stripTypeScriptTypes(source.slice(start, end))}\nguardedCoordinatorJournal`,
    { createCoordinatorJournalApi: () => journal },
    { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } },
  );
  assert.equal(typeof raw, "function");
  const make = raw as (
    directory: string,
    budget: { check: () => void; monotonicDeadline: number },
    guard: () => void,
  ) => typeof journal;
  let expired = false;
  const guarded = make("inert", { monotonicDeadline: 100, check() {} }, () => {
    observed.push("guard");
    if (expired) throw new Error("original controls expired");
  });
  guarded.request("GET");
  guarded.request("POST");
  guarded.graphql("mutation($input:Input!){updateRefs(input:$input){clientMutationId}}");
  assert.deepEqual(observed, [
    "GET",
    "guard",
    "POST",
    "guard",
    "mutation($input:Input!){updateRefs(input:$input){clientMutationId}}",
  ]);
  expired = true;
  const before = observed.filter((value) => value !== "guard").length;
  assert.throws(() => guarded.request("POST"), /expired/);
  assert.throws(() => guarded.graphql("mutation{updateRefs}"), /expired/);
  assert.equal(observed.filter((value) => value !== "guard").length, before);
  guarded.request("GET");
  assert.equal(observed.at(-1), "GET");
});
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
void test("catalog same App Check receiver binds fresh exact proof without importing a local capture", () => {
  const f = fixture(),
    op = f.facts.semantic_opportunity,
    handoff = prepareSemanticReviewHandoff(op, {
      scope: "complete-catalog-publication-opportunity",
      runtime: "codex-independent-local-review",
      session_ref: "inert:transport-only",
      completed_at: "2026-10-21T00:00:00Z",
      coverage: { accumulated_changes: true, classification: true, compatibility: true },
      accepted_opportunity: op,
      report: "Inert receiver fixture; not actual capture/publisher authority.",
    });
  const body = {
    ...handoff.proposed_request.body,
    id: 303,
    app: { id: 101 },
    output: { ...handoff.proposed_request.body.output, annotations_count: 0 },
  };
  let observed = body,
    reads = 0;
  const api = {
    request(method: string, route: string) {
      reads++;
      assert.equal(method, "GET");
      return {
        status: 200,
        headers: new Map<string, string>(),
        body: route.endsWith("check-runs/303")
          ? observed
          : { id: 1354613114, full_name: "boburning/portcove", node_id: "fixture" },
      };
    },
    graphql() {
      throw new Error("no mutation");
    },
  };
  const proof = readIndependentCatalogSemanticReview(
      api,
      {
        schema_version: 1,
        review_app_id: 101,
        writer_app_id: 202,
        review_check_name: semanticReviewCheckName,
      },
      op,
      303,
    ),
    proof_sha256 = digest(proof),
    descriptor = {
      ...f.facts.descriptor,
      admission_sha256: catalogSigningAdmissionDigest({
        ...op,
        semantic_proof_sha256: proof_sha256,
      }),
    },
    facts = inspectCatalogSigningFacts({
      ...f.facts,
      descriptor,
      semantic_proof_sha256: proof_sha256,
    }),
    binding = {
      ...f.binding,
      descriptor_sha256: digest(descriptor),
      semantic_proof_sha256: proof_sha256,
      context_sha256: hash(catalogSigningContextBytes(facts)),
    },
    authorities = { apps: { semantic: { app_id: 101 }, classification: { app_id: 202 } } };
  assert.equal(
    recheckCatalogSemanticProof(api, authorities, facts, binding, descriptor.prior)
      .semantic_check_id,
    303,
  );
  const before = reads;
  assert.equal(
    recheckCatalogSemanticProof(api, authorities, facts, binding, descriptor.prior)
      .semantic_proof_sha256,
    proof_sha256,
  );
  assert.ok(reads > before);
  for (const changed of [
    { app: { id: 202 } },
    { head_sha: "9".repeat(40) },
    { conclusion: "failure" },
    { external_id: "wrong-purpose" },
  ]) {
    observed = { ...body, ...changed };
    assert.throws(() =>
      recheckCatalogSemanticProof(api, authorities, facts, binding, descriptor.prior),
    );
  }
  observed = body;
  assert.throws(() =>
    recheckCatalogSemanticProof(
      api,
      authorities,
      { ...facts, semantic_proof_sha256: "8".repeat(64) },
      binding,
      descriptor.prior,
    ),
  );
});
void test("catalog context and role ready/predicate routes reach fixed upload and normalized attestation names", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldRun = process.env.GITHUB_RUN_ID,
    oldAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ID = "123";
  process.env.GITHUB_RUN_ATTEMPT = "1";
  t.after(() => {
    if (oldRun === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = oldRun;
    if (oldAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = oldAttempt;
  });
  const f = fixture(),
    manifest = inspectSigningContextArchive(f.archive()).manifest,
    manifestBytes = Buffer.from(JSON.stringify(manifest)),
    directory = path.join(root, "context");
  await mkdir(directory);
  await writeFile(path.join(directory, "signing-context-manifest.json"), manifestBytes);
  await writeFile(
    path.join(directory, "signing-context-bytes.bin"),
    Buffer.concat([...f.files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, bytes]) => bytes)),
  );
  await writeFile(
    path.join(directory, "context-ready.json"),
    JSON.stringify({
      name: "trusted-catalog-signing-context-123-1",
      files: ["signing-context-manifest.json", "signing-context-bytes.bin"],
    }),
  );
  await retainControllerUpload(root, "coordinator", "context", directory);
  const context = await nextControllerTransport(root, "coordinator", 1, performance.now() + 10000);
  assert.equal(context.kind, "context");
  assert.ok("context_kind" in context && context.context_kind === "catalog-signing-context");
  await acknowledgeControllerTransport(root, "coordinator", 1, {
    artifact_id: 70,
    sha256: "1".repeat(64),
  });
  const predicate = path.join(directory, "signing-context-predicate.json");
  await writeFile(
    predicate,
    JSON.stringify({ role: "catalog-signing-context", manifest_sha256: hash(manifestBytes) }),
  );
  await retainControllerAttestation(root, "coordinator", {
    subject_path: path.join(directory, "signing-context-manifest.json"),
    predicate_path: predicate,
    predicate_type: "https://portcove.dev/attestations/release-signing-context/v1",
  });
  await retainControllerJobSettlement(root, "coordinator", 0, true);
  assert.equal(
    (await nextControllerTransport(root, "coordinator", 2, performance.now() + 10000)).kind,
    "attest",
  );
  const action = path.join(root, "action.json");
  await writeFile(action, "inert completed action bytes");
  const normalized = await normalizeControllerAttestationBundle(
    root,
    "coordinator",
    2,
    action,
    performance.now() + 10000,
  );
  assert.equal(normalized.name, "trusted-catalog-signing-context-attestation-123-1");
  assert.equal(path.basename(normalized.path), "signing-context-attestation.json");
  await acknowledgeControllerTransport(root, "coordinator", 2, {
    artifact_id: 71,
    sha256: normalized.sha256,
  });
  for (const role of ["definitions", "policy", "snapshot", "timestamp"] as const) {
    const phase = `catalog-${role}` as const,
      key = path.join(root, `${phase}-key`);
    await mkdir(key);
    await retainControllerRoleKey(root, phase, key);
    const selected = await nextControllerTransport(root, phase, 1, performance.now() + 10000);
    assert.equal(selected.kind, "role-key");
    assert.ok("name" in selected && selected.name === phase);
    const parsed = JSON.parse(
      await readFile(path.join(root, `controller-transport-${phase}-role-key.json`), "utf8"),
    ) as unknown;
    assert.throws(() => inspectControllerTransportEvent(parsed, root, "tuf-snapshot"));
    const roleDir = path.join(root, `${phase}-output`);
    await mkdir(roleDir);
    const publicDir = path.join(roleDir, "public");
    await mkdir(publicDir);
    const subject = path.join(publicDir, "signing-output-manifest.json"),
      rolePredicate = path.join(publicDir, "predicate.json");
    await writeFile(subject, "inert role manifest");
    await writeFile(rolePredicate, "inert role predicate");
    await retainControllerAttestation(roleDir, phase, {
      subject_path: subject,
      predicate_path: rolePredicate,
      predicate_type: "https://portcove.dev/attestations/catalog-role-output/v1",
    });
    const event = JSON.parse(
      await readFile(path.join(roleDir, `controller-transport-${phase}-attest.json`), "utf8"),
    ) as unknown;
    assert.equal(inspectControllerTransportEvent(event, roleDir, phase).kind, "attest");
    await retainControllerJobSettlement(roleDir, phase, 0, true);
    assert.equal(
      (await nextControllerTransport(roleDir, phase, 1, performance.now() + 10000)).kind,
      "attest",
    );
    const normalizedRole = await normalizeControllerAttestationBundle(
      roleDir,
      phase,
      1,
      action,
      performance.now() + 10000,
    );
    assert.equal(normalizedRole.name, `trusted-${phase}-attestation-123-1`);
    assert.equal(path.basename(normalizedRole.path), "role-attestation.json");
  }
});
