import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  assessBoundedCapacity,
  inspectCapacityOperation,
  validateCapacityTransition,
  slice4CapacityResources,
  capacityDigest,
  expectedCompactCapacityOperations,
  inspectCompactCapacityOperations,
  verifyRetainedCapacityOperation,
  inspectCapacityExecutorIdentity,
  inspectSitePublicationExpectation,
  assertPublicationResultDestination,
} from "./release-capacity.mts";
import { metadataFixture, metadataBootstrapFixture } from "./fixtures/release-metadata-fixture.mts";
import {
  inspectMetadataRenewalDescriptor,
  metadataInstant,
  assertMetadataRenewalBinding,
  validatePublishedMetadataTransition,
  inspectMetadataBootstrapDescriptor,
  assertMetadataBootstrapBinding,
  assertMetadataBootstrapPublication,
  assertMetadataRenewalPublication,
} from "./release-metadata-contract.mts";

void test("online Targets renewal explicitly binds a new generation while preserving the base identity", () => {
  const fixture = metadataFixture();
  const at = (days: number) =>
    new Date(Date.parse(fixture.now) + days * 86400000).toISOString().replace(".000Z", "Z");
  const raw = {
    ...fixture.descriptor,
    schema_version: 2,
    top_level_targets_profile: "online-unchanged-authority-v1",
    current_expires: { ...fixture.descriptor.current_expires, targets: at(60) },
    next_expires: { ...fixture.descriptor.next_expires, targets: at(90) },
    next_versions: { ...fixture.descriptor.next_versions, targets: "2" },
  };
  const descriptor = inspectMetadataRenewalDescriptor(raw);
  assert.equal(descriptor.schema_version, 2);
  const published = { ...fixture.published, expires: descriptor.current_expires };
  assertMetadataRenewalBinding(descriptor, published, fixture.now);
  const facts = {
    schema_version: 1,
    root_sha256: descriptor.root_sha256,
    offline_targets_sha256: "a".repeat(64),
    repository_sha256: "b".repeat(64),
    snapshot_sha256: "c".repeat(64),
    timestamp_sha256: "d".repeat(64),
    records_sha256: descriptor.unchanged_records_sha256,
    versions: descriptor.next_versions,
    expires: descriptor.next_expires,
  };
  assertMetadataRenewalPublication(raw, facts);
  assert.throws(() =>
    assertMetadataRenewalPublication(raw, {
      ...facts,
      offline_targets_sha256: descriptor.offline_targets_sha256,
    }),
  );
  for (const changed of [
    { schema_version: 1 },
    { top_level_targets_profile: "unscoped" },
    { next_versions: { ...raw.next_versions, targets: "3" } },
    { next_expires: { ...raw.next_expires, targets: at(91) } },
    { next_expires: { ...raw.next_expires, targets: at(60) } },
  ])
    assert.throws(() => inspectMetadataRenewalDescriptor({ ...raw, ...changed }));
  const { top_level_targets_profile: _mode, ...missing } = raw;
  void _mode;
  assert.throws(() => inspectMetadataRenewalDescriptor(missing));
  // Existing held coordinator still rejects a changed Top authority baseline;
  // this component cannot silently opt its production callers in.
  const after = { ...published, ...facts, operation_id: "e".repeat(64) };
  assert.throws(
    () =>
      validatePublishedMetadataTransition(
        { active_candidate: null, published_metadata: published },
        { active_candidate: null, published_metadata: after, metadata_renewal: descriptor },
        {
          id: after.operation_id,
          outcome: "succeeded",
          metadata_renewal: { descriptor_sha256: capacityDigest(descriptor) },
          completed_effects: [published.publication],
        },
      ),
    /offline anchors/,
  );
});
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import { isRecord } from "./runtime-values.mts";
import { catalogPublicationFixture } from "./fixtures/release-catalog-publication-fixture.mts";
import {
  inspectCatalogPublicationDescriptor,
  catalogPublicationLifecycle,
  inspectCatalogCapacitySubject,
  inspectCatalogSitePublicationExpectation,
} from "./release-catalog-publication-contract.mts";

function catalogOperation(
  outcome = "pending",
  descriptor = catalogPublicationFixture(),
  counters = { transient_retries: 0, substantive_repairs: 0 },
) {
  const c = capacityFixture();
  const identity = {
    before_checkpoint: "a".repeat(40),
    catalog_publication: {
      descriptor,
      descriptor_sha256: capacityDigest(descriptor),
      observed_at: "2026-10-21T12:00:00Z",
      ...counters,
    },
    kind: "upload",
    destination: "github-actions:boburning/portcove:catalog-publication-context",
    executor_identity: {
      actor_id: "1",
      check_run_id: "2",
      controller_revision: "3".repeat(40),
      execution_ref: "refs/tags/fixture",
      job_id: 4,
      role: "coordinator",
      run_attempt: 1,
      run_id: "5",
      workflow: ".github/workflows/fixture.yml",
    },
    receipt_limit: 1,
    sequence: 1,
    policy_sha256: c.ratification.resource_policy_sha256,
    ratification_sha256: capacityDigest(c.ratification),
  };
  return {
    ...identity,
    id: capacityDigest(identity),
    outcome,
    completed_effects: [],
    failure_evidence: null,
    recovery: null,
  };
}
void test("catalog subject is explicit, bounded, digest-bound and cannot impersonate app metadata", () => {
  const descriptor = catalogPublicationFixture();
  assert.deepEqual(inspectCatalogPublicationDescriptor(descriptor), descriptor);
  assert.equal(
    inspectCapacityOperation(catalogOperation())!.catalog_publication!.descriptor_sha256,
    capacityDigest(descriptor),
  );
  for (const mutation of [
    { schema_version: 2 },
    { kind: "application-tuf-metadata-renewal" },
    { source_commit: "3".repeat(64) },
    { bundle_sha256: "x" },
    { private_key: "forbidden" },
    { prior: { ...descriptor.prior, application_root_sha256: "a".repeat(64) } },
  ])
    assert.throws(() => inspectCatalogPublicationDescriptor({ ...descriptor, ...mutation }));
  const subject = catalogOperation().catalog_publication;
  for (const mutation of [
    { transient_retries: 3 },
    { substantive_repairs: 4 },
    { observed_at: "not-time" },
    { descriptor_sha256: "0".repeat(64) },
  ])
    assert.throws(() => inspectCatalogCapacitySubject({ ...subject, ...mutation }));
  assert.throws(() =>
    inspectCapacityOperation({ ...catalogOperation(), candidate: operationFixture().candidate }),
  );
  const withApp = {
    ...descriptor,
    bundle_sha256: "0".repeat(64),
    prior: {
      ...descriptor.prior,
      site_generation_sha256: "9".repeat(64),
      application_root_sha256: "a".repeat(64),
      application_repository_sha256: "b".repeat(64),
    },
  };
  assert.equal(catalogPublicationLifecycle(descriptor), catalogPublicationLifecycle(withApp));
});
void test("catalog uses distinct exact role destinations and sole Pages expectation", () => {
  const base = catalogOperation();
  const {
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...identity
  } = base;
  const parse = (delta: Record<string, unknown>) => {
    const i = { ...identity, ...delta };
    return inspectCapacityOperation({ ...base, ...i, id: capacityDigest(i) });
  };
  for (const role of ["definitions", "policy", "snapshot", "timestamp"]) {
    const executor_identity = { ...identity.executor_identity, role: `catalog-${role}` };
    const destination = `github-actions:boburning/portcove:catalog-tuf-role-${role}`;
    assert.doesNotThrow(() => parse({ executor_identity, destination }));
    assert.throws(() =>
      parse({
        executor_identity,
        destination: "github-actions:boburning/portcove:catalog-tuf-role-other",
      }),
    );
    assert.throws(() =>
      parse({ executor_identity: { ...executor_identity, role: `tuf-${role}` }, destination }),
    );
  }
  const catalog_site_expectation = {
    artifact_id: 9,
    archive_sha256: "1".repeat(64),
    catalog_root_sha256: identity.catalog_publication.descriptor.prior.catalog_root_sha256,
    catalog_repository_sha256: "2".repeat(64),
    application_root_sha256: null,
    prior_site_generation_sha256: null,
    site_generation_sha256: "3".repeat(64),
  };
  assert.doesNotThrow(() => inspectCatalogSitePublicationExpectation(catalog_site_expectation));
  const pages = {
    executor_identity: { ...identity.executor_identity, role: "site-publication" },
    destination: "github-pages:boburning/portcove:complete-site",
    catalog_site_expectation,
  };
  assert.doesNotThrow(() => parse(pages));
  assert.throws(() =>
    parse({
      ...pages,
      catalog_site_expectation: {
        ...catalog_site_expectation,
        catalog_root_sha256: "8".repeat(64),
      },
    }),
  );
  assert.throws(() => parse({ ...pages, site_expectation: {} }));
});
void test("shared capacity slot excludes application/catalog crossover and preserves retry accounting across changed bundles", () => {
  const beforeOperation = {
    ...catalogOperation(),
    outcome: "recovered",
    recovery: {
      checkpoint: "b".repeat(40),
      evidence_sha256: "c".repeat(64),
      resolution: "effect-not-applied",
    },
  };
  const capacity = {
    ...capacityFixture(),
    schema_version: 2,
    operation: beforeOperation,
    prior_operations: [] as unknown[],
  };
  const before = {
    schema_version: 2,
    active_candidate: null,
    controller: { capacity_attempt: capacity },
  };
  const changed = { ...catalogPublicationFixture(), bundle_sha256: "e".repeat(64) };
  const nextOp = catalogOperation("pending", changed, {
    transient_retries: 1,
    substantive_repairs: 0,
  });
  const {
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...initial
  } = nextOp;
  const identity = { ...initial, before_checkpoint: "f".repeat(40), sequence: 2 };
  const after = {
    ...before,
    controller: {
      capacity_attempt: {
        ...capacity,
        operation: { ...nextOp, ...identity, id: capacityDigest(identity) },
      },
    },
  };
  after.controller.capacity_attempt.prior_operations = expectedCompactCapacityOperations(
    before,
    after,
    "f".repeat(40),
  );
  assert.doesNotThrow(() => validateCapacityTransition(before, after, "f".repeat(40)));
  assert.equal(
    inspectCompactCapacityOperations(after.controller.capacity_attempt.prior_operations)[0]!.subject
      .kind,
    "catalog-publication",
  );
  const reset = structuredClone(after);
  const op = reset.controller.capacity_attempt.operation;
  const {
    id: _resetId,
    outcome: _resetOutcome,
    completed_effects: _resetEffects,
    failure_evidence: _resetFailure,
    recovery: _resetRecovery,
    ...resetIdentity
  } = op;
  resetIdentity.catalog_publication.transient_retries = 0;
  reset.controller.capacity_attempt.operation = {
    ...op,
    ...resetIdentity,
    id: capacityDigest(resetIdentity),
  };
  assert.throws(
    () => validateCapacityTransition(before, reset, "f".repeat(40)),
    /recovery increment/,
  );
  const pending = {
    ...before,
    controller: { capacity_attempt: { ...capacity, operation: catalogOperation() } },
  };
  assert.throws(
    () => validateCapacityTransition(pending, after, "f".repeat(40)),
    /resolved|unresolved/,
  );
  assert.throws(
    () =>
      validateCapacityTransition(
        { ...before, active_candidate: operationFixture().candidate },
        after,
        "f".repeat(40),
      ),
    /application reservation/,
  );
  const app = {
    ...before,
    controller: { capacity_attempt: { ...capacity, operation: operationFixture("pending") } },
  };
  assert.throws(
    () => validateCapacityTransition(app, after, "f".repeat(40)),
    /resolved|unresolved/,
  );
  const unchanged = structuredClone(before);
  assert.doesNotThrow(() => validateCapacityTransition(before, unchanged, "f".repeat(40)));
  assert.equal(assessBoundedCapacity(capacity).availability, "unknown");
});
void test("replacement publication result uses only the consumed bounded candidate counters", () => {
  const candidate = { version: "0.1.0-beta.1", transient_retries: 1, substantive_repairs: 0 };
  const root = "github-actions:boburning/portcove:0.1.0-beta.1:immutable-release-result";
  assert.doesNotThrow(() => assertPublicationResultDestination(root + ":recovery-1-0", candidate));
  assert.doesNotThrow(() =>
    assertPublicationResultDestination(root, { ...candidate, transient_retries: 0 }),
  );
  for (const destination of [
    root,
    root + ":recovery-0-0",
    root + ":recovery-2-0",
    root + ":retry",
    root.replace("beta.1", "beta.2") + ":recovery-1-0",
  ])
    assert.throws(() => assertPublicationResultDestination(destination, candidate));
});
void test("historical unsuffixed nonzero-counter result remains readable but cannot become a new intent", () => {
  const original = operationFixture("pending");
  const {
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...base
  } = original;
  const candidate = { ...base.candidate, transient_retries: 1 };
  const identity = {
    ...base,
    candidate,
    destination: `github-actions:boburning/portcove:${candidate.version}:immutable-release-result`,
  };
  const historical = {
    ...original,
    ...identity,
    id: capacityDigest(identity),
    completed_effects: [],
  };
  assert.equal(inspectCapacityOperation(historical)!.id, historical.id);
  assert.throws(() => assertPublicationResultDestination(historical.destination, candidate));
  const capacity = capacityFixture();
  const input = {
    schema_version: 2,
    active_candidate: candidate,
    controller: { capacity_attempt: { ...capacity, operation: historical, prior_operations: [] } },
  };
  assert.doesNotThrow(() =>
    validateCapacityTransition(input, structuredClone(input), "a".repeat(40)),
  );
  const before = {
    ...input,
    controller: { capacity_attempt: { ...capacity, operation: null, prior_operations: [] } },
  };
  assert.throws(
    () => validateCapacityTransition(before, input, "a".repeat(40)),
    /consumed candidate/u,
  );
});
void test("durable Pages intent binds exact generation, prior, public repository and artifact before any result", () => {
  const expected = {
    archive_sha256: "1".repeat(64),
    artifact_id: 123,
    prior_site_generation_sha256: "2".repeat(64),
    repository_sha256: "3".repeat(64),
    root_sha256: "4".repeat(64),
    site_generation_sha256: "5".repeat(64),
  };
  const original = operationFixture("pending", "e".repeat(64));
  const {
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...base
  } = original;
  const identity = {
    ...base,
    destination: "github-pages:boburning/portcove:complete-site",
    site_expectation: expected,
    executor_identity: {
      controller_revision: "a".repeat(40),
      execution_ref: "refs/tags/controller-v1",
      workflow: ".github/workflows/controller.yml",
      run_id: "123",
      run_attempt: 1,
      job_id: 456,
      check_run_id: "789",
      actor_id: "43177418",
      role: "site-publication",
    },
  };
  const pending = { ...original, ...identity, id: capacityDigest(identity), completed_effects: [] };
  const parsed = inspectCapacityOperation(pending)!;
  assert.deepEqual(parsed.site_expectation, expected);
  assert.equal(parsed.outcome, "pending");
  assert.deepEqual(parsed.completed_effects, []);
  for (const [key, value] of Object.entries(expected))
    assert.throws(() =>
      inspectCapacityOperation({
        ...pending,
        site_expectation: {
          ...expected,
          [key]: typeof value === "number" ? value + 1 : "f".repeat(64),
        },
      }),
    );
  for (const changed of [
    { ...expected, prior_site_generation_sha256: expected.site_generation_sha256 },
    { ...expected, artifact_id: 0 },
    { ...expected, reservation: true },
  ])
    assert.throws(() => inspectSitePublicationExpectation(changed));
  const other = {
    ...identity,
    executor_identity: { ...identity.executor_identity, role: "payload-signing" },
  };
  assert.throws(
    () => inspectCapacityOperation({ ...pending, ...other, id: capacityDigest(other) }),
    /fixed Pages/u,
  );
  assert.throws(
    () =>
      inspectCapacityOperation({
        ...pending,
        site_expectation: { ...expected, prior_site_generation_sha256: null },
      }),
    /fixed Pages/u,
  );
});
void test("initial metadata descriptor is explicit empty first generation and cannot impersonate renewal or published state", () => {
  const f = metadataBootstrapFixture();
  assertMetadataBootstrapBinding(f.descriptor, null, f.descriptor.generated_at);
  assert.throws(
    () => assertMetadataBootstrapBinding(f.descriptor, f.published, f.descriptor.generated_at),
    /permanently closed/,
  );
  for (const mutation of [
    { initial_records_sha256: "1".repeat(64) },
    { versions: { ...f.descriptor.versions, preview: "2" } },
    { prior_repository_sha256: "1".repeat(64) },
    { expires: { ...f.descriptor.expires, timestamp: "2099-01-01T00:00:00Z" } },
  ])
    assert.throws(() => inspectMetadataBootstrapDescriptor({ ...f.descriptor, ...mutation }));
  const { operation_id, publication, ...facts } = f.published;
  void operation_id;
  void publication;
  assertMetadataBootstrapPublication(f.descriptor, facts);
  assert.throws(() =>
    assertMetadataBootstrapPublication(f.descriptor, { ...facts, records_sha256: "d".repeat(64) }),
  );
  assert.throws(() => inspectMetadataRenewalDescriptor(f.descriptor));
});
void test("Rust and Node share exact descriptor and public component canonical hashes", async () => {
  const fixture: unknown = JSON.parse(
    await readFile(new URL("./fixtures/release-metadata-canonical.json", import.meta.url), "utf8"),
  );
  assert.ok(isRecord(fixture));
  assert.equal(fixture.qualification_only, true);
  assert.equal(capacityDigest(fixture.descriptor), fixture.descriptor_sha256);
  assert.equal(capacityDigest(fixture.public_inventory), fixture.public_inventory_sha256);
});
void test("bounded eligibility never claims availability, headroom or reservation", () => {
  const result = assessBoundedCapacity(capacityFixture());
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.availability, "unknown");
  assert.equal(result.headroom, "unknown");
  assert.equal(result.reservation, "none");
  assert.equal(result.authority, "none");
  assert.equal(result.resource_estimate.total_job_minutes, 100);
  assert.equal(result.resource_estimate.input_receipts, 163);
  assert.equal(result.resource_estimate.declared_job_minutes, 91);
  assert.equal(result.resource_estimate.retention_days, 7);
});
void test("changed account, stop, budget, visibility, runner or resource policy refuses even a rehashed observation", () => {
  for (const [key, value] of Object.entries({
    account_id: 1,
    repository_id: 1,
    budget_usd: 1,
    stop_usage: false,
    public_repository: false,
    runner_class: "larger",
    scope: "repository",
    resource_policy_sha256: "0".repeat(64),
  })) {
    const input = capacityFixture();
    Object.assign(input.boundary, { [key]: value });
    input.ratification.boundary_sha256 = capacityDigest(input.boundary);
    assert.equal(assessBoundedCapacity(input).eligibility, "ineligible", key);
  }
  const input = capacityFixture();
  input.ratification.active = false;
  assert.equal(assessBoundedCapacity(input).eligibility, "ineligible");
  assert.equal(
    assessBoundedCapacity({ ...capacityFixture(), boundary: null }).eligibility,
    "ineligible",
  );
  const changed = capacityFixture();
  changed.boundary.configuration_generation = "changed";
  assert.equal(assessBoundedCapacity(changed).eligibility, "ineligible");
});
void test("complete held controller policy replaces historical pins without appointing capacity authority", async () => {
  for (const [file, expected] of [
    [
      "docs/qualification/application-update-production.complete.yml",
      slice4CapacityResources.aggregate_workflow_sha256,
    ],
    [
      "docs/qualification/application-update-production.complete.yml",
      slice4CapacityResources.input_workflow_sha256,
    ],
    [
      "docs/qualification/application-update-wake.held.yml",
      slice4CapacityResources.wake_workflow_sha256,
    ],
  ] as const) {
    const bytes = await readFile(new URL(`../${file}`, import.meta.url));
    const current = createHash("sha256").update(bytes).digest("hex");
    assert.equal(current, expected);
  }
  assert.equal(
    [
      ...slice4CapacityResources.aggregate_job_minutes,
      ...slice4CapacityResources.input_job_minutes,
      ...slice4CapacityResources.wake_job_minutes,
    ].reduce((a, b) => a + b, 0),
    91,
  );
  const historical = capacityFixture();
  historical.ratification.resource_policy_sha256 = "1".repeat(64);
  assert.equal(assessBoundedCapacity(historical).eligibility, "ineligible");
  assert.equal(assessBoundedCapacity(historical).reason, "capacity resource policy changed");
  assert.equal(slice4CapacityResources.cancel_in_progress, false);
  assert.equal(slice4CapacityResources.shared_cache, false);
  assert.equal(slice4CapacityResources.paid_fallback, false);
  assert.equal(slice4CapacityResources.overwrite, false);
});

function operationFixture(outcome = "succeeded", executorNonce?: string) {
  const capacity = capacityFixture();
  const identity = {
    before_checkpoint: "a".repeat(40),
    candidate: {
      source_commit: "b".repeat(40),
      prepared_commit: "c".repeat(40),
      version: "0.1.0-alpha.1",
      transient_retries: 0,
      substantive_repairs: 0,
    },
    destination: "artifact:A",
    ...(executorNonce === undefined ? {} : { executor_nonce: executorNonce }),
    kind: "upload",
    sequence: 1,
    policy_sha256: capacity.ratification.resource_policy_sha256,
    ratification_sha256: capacityDigest(capacity.ratification),
  };
  return {
    ...identity,
    id: capacityDigest(identity),
    outcome,
    completed_effects: [{ remote_identity: "artifact:A", evidence_sha256: "d".repeat(64) }],
    failure_evidence: null,
    recovery: null,
  };
}
void test("executor nonce is retained and cannot be changed or removed from an existing operation", () => {
  const operation = operationFixture("succeeded", "1".repeat(64));
  assert.equal(inspectCapacityOperation(operation)?.executor_nonce, "1".repeat(64));
  assert.throws(
    () => inspectCapacityOperation({ ...operation, executor_nonce: "2".repeat(64) }),
    /identity differs/,
  );
  assert.throws(() => inspectCapacityOperation({ ...operation, executor_nonce: "not-a-nonce" }));
  const { executor_nonce: _nonce, ...removed } = operation;
  assert.throws(() => inspectCapacityOperation(removed), /identity differs/);
  assert.equal(inspectCapacityOperation(operationFixture())?.id, operationFixture().id);
});
void test("fresh executor nonce cannot repeat a completed logical effect", () => {
  const before = inspectCapacityOperation(operationFixture("succeeded", "1".repeat(64)))!;
  const {
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...identity
  } = operationFixture("pending", "2".repeat(64));
  const nextIdentity = { ...identity, before_checkpoint: "e".repeat(40), sequence: 2 };
  const after = {
    ...nextIdentity,
    id: capacityDigest(nextIdentity),
    outcome: "pending",
    completed_effects: [],
    failure_evidence: null,
    recovery: null,
  };
  const capacity = capacityFixture();
  const previous = {
    schema_version: 2,
    active_candidate: before.candidate,
    controller: { capacity_attempt: { ...capacity, operation: before } },
  };
  const next = {
    ...previous,
    controller: { capacity_attempt: { ...capacity, operation: after, prior_operations: [before] } },
  };
  assert.throws(
    () => validateCapacityTransition(previous, next, nextIdentity.before_checkpoint),
    /completed operation cannot be repeated/,
  );
});
void test("receipt contradictions cannot release capacity hold", () => {
  const operation = operationFixture();
  assert.throws(
    () => inspectCapacityOperation({ ...operation, completed_effects: [] }),
    /requires exact/,
  );
  assert.throws(
    () =>
      inspectCapacityOperation({
        ...operation,
        outcome: "recovered",
        recovery: {
          checkpoint: "e".repeat(40),
          evidence_sha256: "f".repeat(64),
          resolution: "effect-not-applied",
        },
      }),
    /contradicts/,
  );
});
void test("historical failed A behind B still requires existing recovery increment", () => {
  const prior = inspectCapacityOperation({
    ...operationFixture(),
    outcome: "recovered",
    recovery: {
      checkpoint: "e".repeat(40),
      evidence_sha256: "f".repeat(64),
      resolution: "partial-effects-retained",
    },
  })!;
  const identity = { ...operationFixture(), sequence: 3 };
  const {
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...keys
  } = identity;
  const after = {
    ...identity,
    id: capacityDigest(keys),
    outcome: "pending",
    completed_effects: [],
  };
  const capacity = capacityFixture();
  const active = { ...after.candidate };
  const before = {
    schema_version: 2,
    active_candidate: active,
    controller: { capacity_attempt: { ...capacity, operation: null, prior_operations: [prior] } },
  };
  const next = {
    ...before,
    controller: { capacity_attempt: { ...capacity, operation: after, prior_operations: [prior] } },
  };
  assert.throws(
    () => validateCapacityTransition(before, next, after.before_checkpoint),
    /bounded coordinator recovery increment/,
  );
});
void test("metadata versions and expiry remain exact; absent or mismatched seed holds", () => {
  const { descriptor, published, now } = metadataFixture();
  assertMetadataRenewalBinding(descriptor, published, now);
  assert.throws(() => assertMetadataRenewalBinding(descriptor, null, now), /seed absent/);
  for (const key of [
    "root_sha256",
    "offline_targets_sha256",
    "repository_sha256",
    "records_sha256",
  ] as const)
    assert.throws(
      () => assertMetadataRenewalBinding(descriptor, { ...published, [key]: "f".repeat(64) }, now),
      /durable published/,
    );
  for (const time of [
    "2026-02-30T00:00:00Z",
    "2026-10-20T00:00:00.000Z",
    "2026-10-20T00:00:00+00:00",
  ])
    assert.throws(() => metadataInstant(time));
  const large = structuredClone(descriptor);
  large.current_versions.snapshot = "9007199254740993";
  large.next_versions.snapshot = "9007199254740994";
  assert.equal(inspectMetadataRenewalDescriptor(large).next_versions.snapshot, "9007199254740994");
  large.next_versions.snapshot = "9007199254740993";
  assert.throws(() => inspectMetadataRenewalDescriptor(large), /progression/);
  assert.throws(
    () => assertMetadataRenewalBinding(descriptor, published, descriptor.next_expires.timestamp),
    /expired/,
  );
  assert.throws(
    () =>
      validatePublishedMetadataTransition(
        { active_candidate: null },
        { active_candidate: null, published_metadata: published },
        { outcome: "pending" },
      ),
    /pending/,
  );
});
void test("compact lifecycle fits full matrix plus five global recovery increments and metadata interleaving", () => {
  // Three packages per each of six producer platforms, per-package SBOM/signature,
  // five role artifacts, aggregate, draft, publication, Pages and metadata roles.
  // 18*3 + 5+1+1+1+1 = 63 candidate purposes and 7 metadata purposes.
  const { published, now } = metadataFixture();
  const capacity = {
    ...capacityFixture(),
    schema_version: 2,
    prior_operations: [] as unknown[],
    operation: null as unknown,
  };
  let input: Record<string, unknown> = {
    schema_version: 2,
    active_candidate: { prepared_commit: "c".repeat(40) },
    published_metadata: published,
    controller: { capacity_attempt: capacity },
  };
  let sequence = 0;
  let firstRaw: unknown;
  const append = (destination: string, metadata: boolean, transient = 0, repair = 0) => {
    const base = operationFixture();
    const { id: _id, candidate: _candidate, ...rest } = base;
    const identity = {
      ...rest,
      before_checkpoint: "a".repeat(40),
      sequence: ++sequence,
      destination,
      ...(metadata
        ? {
            metadata_renewal: {
              descriptor_sha256: "9".repeat(64),
              prior_repository_sha256: published.repository_sha256,
              observed_at: now,
              transient_retries: transient,
              substantive_repairs: repair,
            },
          }
        : {
            candidate: {
              ...base.candidate,
              transient_retries: transient,
              substantive_repairs: repair,
            },
          }),
    };
    const {
      outcome: _outcome,
      completed_effects: _effects,
      failure_evidence: _failure,
      recovery: _recovery,
      ...keys
    } = identity;
    const raw = {
      ...identity,
      id: capacityDigest(keys),
      outcome: transient + repair > 0 ? "recovered" : "succeeded",
      completed_effects: [
        { remote_identity: "provider:" + "x".repeat(480), evidence_sha256: "d".repeat(64) },
      ],
      recovery:
        transient + repair > 0
          ? {
              checkpoint: "e".repeat(40),
              evidence_sha256: "f".repeat(64),
              resolution: "partial-effects-retained",
            }
          : null,
    };
    const previous = structuredClone(input);
    capacity.operation = raw;
    capacity.prior_operations = expectedCompactCapacityOperations(previous, input, "a".repeat(40));
    inspectCapacityOperation(raw);
    if (!firstRaw) firstRaw = raw;
  };
  for (let index = 0; index < 63; index++) append(`candidate-purpose:${index}`, false);
  for (let index = 0; index < 7; index++) append(`metadata-purpose:${index}`, true);
  // Retry one noncompleted purpose five times; every raw proof stays bound to a
  // checkpoint instead of carrying arbitrarily large provider receipts inline.
  for (let index = 1; index <= 5; index++)
    append("metadata-retry", true, Math.min(index, 2), Math.max(0, index - 2));
  append("final-purpose", false, 2, 3);
  const groups = inspectCompactCapacityOperations(capacity.prior_operations);
  assert.equal(groups.length, 71);
  const retry = groups.find(
    (group) => group.destination_sha256 === capacityDigest("metadata-retry"),
  );
  assert.equal(retry?.attempts.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) + 1024 < 64 * 1024);
  assert.ok(firstRaw);
  const proof = groups
    .flatMap((group) => group.attempts)
    .find((proof) => isRecord(firstRaw) && proof.id === firstRaw.id)!;
  verifyRetainedCapacityOperation(firstRaw, proof);
  assert.throws(() =>
    verifyRetainedCapacityOperation(firstRaw, { ...proof, operation_sha256: "0".repeat(64) }),
  );
  const changed = structuredClone(input);
  assert.ok(isRecord(changed.controller) && isRecord(changed.controller.capacity_attempt));
  changed.controller.capacity_attempt.prior_operations = [];
  assert.throws(
    () => validateCapacityTransition(input, changed, "a".repeat(40)),
    /drop or rewrite/,
  );
  // Advancing an authenticated published generation only releases old metadata
  // summaries. Active-candidate anti-repeat entries survive unchanged.
  const advanced = structuredClone(input);
  advanced.published_metadata = { ...published, repository_sha256: "9".repeat(64) };
  const retained = expectedCompactCapacityOperations(input, advanced, "a".repeat(40));
  assert.equal(retained.filter((group) => group.subject.kind === "metadata-renewal").length, 0);
  assert.equal(retained.filter((group) => group.subject.kind === "candidate").length, 63);
});
void test("original and recovery executor identities are independently bound without authenticating them", () => {
  const executor = {
    controller_revision: "a".repeat(40),
    execution_ref: "refs/tags/controller-v1",
    workflow: ".github/workflows/controller.yml",
    run_id: "123",
    run_attempt: 1,
    job_id: 456,
    check_run_id: "789",
    actor_id: "43177418",
    role: "site-publication",
  };
  const before = operationFixture();
  const {
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...keys
  } = before;
  const identity = { ...keys, executor_identity: executor };
  const raw = {
    ...before,
    ...identity,
    id: capacityDigest(identity),
    outcome: "recovered",
    recovery: {
      checkpoint: "b".repeat(40),
      evidence_sha256: "c".repeat(64),
      resolution: "effect-completed",
      executor_identity: { ...executor, role: "coordinator", job_id: 457 },
    },
  };
  const parsed = inspectCapacityOperation(raw)!;
  assert.deepEqual(parsed.executor_identity, executor);
  assert.throws(
    () => inspectCapacityOperation({ ...raw, executor_identity: { ...executor, job_id: 999 } }),
    /identity differs/,
  );
  assert.throws(() => inspectCapacityExecutorIdentity({ ...executor, check_run_id: 789 }));
});
void test("single-effect receipt survives partial recovery and cannot be repeated with a new retry", () => {
  const original = operationFixture();
  const {
    id: _id,
    outcome: _outcome,
    completed_effects: _effects,
    failure_evidence: _failure,
    recovery: _recovery,
    ...keys
  } = original;
  const firstIdentity = { ...keys, receipt_limit: 1 };
  const first = {
    ...original,
    ...firstIdentity,
    id: capacityDigest(firstIdentity),
    outcome: "recovered",
    recovery: {
      checkpoint: "d".repeat(40),
      evidence_sha256: "e".repeat(64),
      resolution: "partial-effects-retained",
    },
  };
  inspectCapacityOperation(first);
  const active = { ...original.candidate, transient_retries: 1 };
  const nextIdentity = {
    ...firstIdentity,
    candidate: active,
    before_checkpoint: "f".repeat(40),
    sequence: 2,
  };
  const after = {
    ...nextIdentity,
    id: capacityDigest(nextIdentity),
    outcome: "pending",
    completed_effects: [],
    failure_evidence: null,
    recovery: null,
  };
  const capacity = {
    ...capacityFixture(),
    schema_version: 2,
    operation: first,
    prior_operations: [] as unknown[],
  };
  const before = {
    schema_version: 2,
    active_candidate: active,
    controller: { capacity_attempt: capacity },
  };
  const next = { ...before, controller: { capacity_attempt: { ...capacity, operation: after } } };
  next.controller.capacity_attempt.prior_operations = expectedCompactCapacityOperations(
    before,
    next,
    "f".repeat(40),
  );
  assert.equal(
    inspectCompactCapacityOperations(next.controller.capacity_attempt.prior_operations)[0]
      ?.completed,
    true,
  );
  assert.throws(
    () => validateCapacityTransition(before, next, "f".repeat(40)),
    /completed logical effect cannot repeat/,
  );
  assert.throws(
    () =>
      inspectCapacityOperation({
        ...first,
        recovery: { ...first.recovery, resolution: "effect-not-applied" },
      }),
    /contradicts/,
  );
  // Old multi-effect partial recovery stays a partial lifecycle; there is no
  // blanket reinterpretation of historical operations lacking receipt_limit1.
  const legacy = { ...original, outcome: "recovered", recovery: first.recovery };
  const legacyBefore = {
    ...before,
    controller: { capacity_attempt: { ...capacity, operation: legacy } },
  };
  assert.equal(
    expectedCompactCapacityOperations(legacyBefore, next, "f".repeat(40))[0]?.completed,
    false,
  );
});
