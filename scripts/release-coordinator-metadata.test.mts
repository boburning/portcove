import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import {
  recordCapacityReadback,
  runBoundedMetadataRenewalOperation,
  recordPublishedMetadata,
} from "./release-capacity-operation.mts";
import { metadataFixture } from "./fixtures/release-metadata-fixture.mts";
import {
  servedNativeBootstrapRenewal,
  standaloneBootstrapAdoption,
  standaloneBootstrapForwardAdoption,
  standaloneBootstrapRenewalAdoption,
  validatePublishedMetadataTransition,
} from "./release-metadata-contract.mts";
import { currentPublishedSite } from "./release-catalog-metadata-contract.mts";
import {
  assertRetainedBootstrapForwardRenewal,
  assertRetainedBootstrapRenewal,
  assertStandaloneBootstrapAdoptionCapacity,
} from "./release-catalog-bootstrap-adoption.mts";
import {
  retainedR55Renewal,
  retainedR56FeedRecovery,
  retainedServedRenewal,
} from "./application-release-run.mts";
import { isDeepStrictEqual } from "node:util";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
  coordinatorStateRef,
  exportCoordinatorCheckpoint,
  importCoordinatorCheckpoint,
  readRetainedCapacityOperation,
} from "./release-coordinator-state.mts";
import {
  hydrateRetainedCoordinatorOperation,
  hydrateRetainedCoordinatorCheckpoint,
} from "./release-coordinator-recovery.mts";
import {
  publishCoordinatorCheckpoint,
  CoordinatorRemoteError,
} from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { inspectCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-evidence.mts";
import { performance } from "node:perf_hooks";
import {
  checkpointProofFixture,
  releaseCustodyFetch,
} from "./fixtures/checkpoint-proof-fixture.mts";
import { authenticateCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-authentication.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import {
  remoteFixture,
  fixture,
  checkpointEvidence,
  remoteCapacityFixture,
} from "./fixtures/coordinator-state-fixtures.mts";

void test("standalone bootstrap adoption requires current eligible catalog capacity", () => {
  const catalog = {
    phase: "coordinator",
    purpose: "catalog-coordinator-controls",
    resource_policy_matches_controller: true,
    capacity_source: { report: { eligibility: "eligible" } },
  };
  assertStandaloneBootstrapAdoptionCapacity(catalog);
  for (const changed of [
    { ...catalog, purpose: "metadata-coordinator-controls" },
    { ...catalog, phase: "site-publication" },
    { ...catalog, resource_policy_matches_controller: false },
    { ...catalog, capacity_source: { report: { eligibility: "ineligible" } } },
    { ...catalog, capacity_source: {} },
  ])
    assert.throws(() => assertStandaloneBootstrapAdoptionCapacity(changed), /ineligible/u);
});

void test("one settled standalone bootstrap can seed the app-only cursor without replacing its abandoned descriptor", async (t) => {
  const generation: string = standaloneBootstrapAdoption.generation;
  const { run_id, feed_job_id } = standaloneBootstrapAdoption;
  const versions = {
    targets: "1",
    releases: "1",
    preview: "1",
    stable: "1",
    snapshot: "1",
    timestamp: "1",
  };
  const root = "17de1676cd26c4bd2867d3a7941793147b94670d027e7846557d813bc9f43f92";
  const offline = "377ca58a2535229056afe552ca34035c3c0791fe4b8ac1a3a0b861dfc2782642";
  const emptyRecords = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
  const offlineExpiry = "2027-01-30T14:53:29Z";
  const before = {
    active_candidate: null,
    metadata_bootstrap: {
      schema_version: 1,
      kind: "application-tuf-initial-bootstrap",
      generated_at: "2026-11-03T21:20:37Z",
      setup_plan_sha256: "fa78511a152452f1ff702a8ef4bf846dfc89f48735c30ae637e95dd0643def1c",
      initial_site_preimage_sha256:
        "82c2fdde9c53051f265a702c3e92b1c2e93a1fd0b973b23022da6750e9846767",
      root_sha256: root,
      offline_targets_sha256: offline,
      payload_key_registry_sha256:
        "3e7738e2e1a87484fa07dcca36c3a35c07f9a53473f65a21d59bbcc3d40ffa10",
      initial_records_sha256: emptyRecords,
      versions,
      expires: {
        targets: offlineExpiry,
        releases: offlineExpiry,
        preview: "2026-11-10T21:20:37Z",
        stable: "2026-11-10T21:20:37Z",
        snapshot: "2026-11-10T21:20:37Z",
        timestamp: "2026-11-05T21:20:37Z",
      },
    },
  };
  const after = {
    ...before,
    now: "2026-11-07T19:00:00.000Z",
    published_metadata: {
      schema_version: 1,
      root_sha256: root,
      offline_targets_sha256: offline,
      records_sha256: emptyRecords,
      repository_sha256: "c4017f8aba6b1fce353eb005564e23d909bd72bd6133d1ef840741929839f38b",
      timestamp_sha256: "7f2402319ea2268453d58807d27bd7e7c924ed14f08a1c16d96a6618cf1ebc19",
      snapshot_sha256: "929ce9769c40883c3329122da6b90adbeedf11e5297d8931e55047056131a2e1",
      operation_id: null,
      standalone_bootstrap_run: run_id,
      versions,
      expires: {
        targets: offlineExpiry,
        releases: offlineExpiry,
        preview: "2026-11-13T02:32:54Z",
        stable: "2026-11-13T02:32:54Z",
        snapshot: "2026-11-13T02:32:54Z",
        timestamp: "2026-11-08T02:32:54Z",
      },
      publication: {
        remote_identity: `https://github.com/boburning/portcove/actions/runs/${run_id}/job/${feed_job_id}`,
        site_generation_sha256: generation,
        evidence_sha256: "a".repeat(64),
      },
    },
  };
  validatePublishedMetadataTransition(before, after, null);
  assert.equal(currentPublishedSite(after)?.generation_sha256, generation);
  assert.equal(currentPublishedSite(after)?.components.catalog, null);
  assert.throws(() => validatePublishedMetadataTransition(before, after, { outcome: "pending" }));
  assert.throws(() => validatePublishedMetadataTransition(before, after, { outcome: "succeeded" }));
  assert.throws(() =>
    validatePublishedMetadataTransition({ ...before, catalog_review_request: {} }, after, null),
  );
  assert.throws(
    () =>
      validatePublishedMetadataTransition(
        before,
        { ...after, now: "2026-11-08T02:32:54.000Z" },
        null,
      ),
    /expired standalone/,
  );
  const { standalone_bootstrap_run: _outside, ...ordinary } = after.published_metadata;
  assert.throws(
    () =>
      validatePublishedMetadataTransition(before, { ...after, published_metadata: ordinary }, null),
    /differs from exact bootstrap descriptor/,
  );
  const tampered = structuredClone(after);
  tampered.published_metadata.publication.site_generation_sha256 = "a".repeat(64);
  assert.throws(() => validatePublishedMetadataTransition(before, tampered, null));
  tampered.published_metadata.publication.site_generation_sha256 = generation;
  tampered.published_metadata.snapshot_sha256 = "a".repeat(64);
  assert.throws(() => validatePublishedMetadataTransition(before, tampered, null));
  const renewalRun = "42400000001";
  const renewal = {
    ...after,
    now: "2026-11-08T07:00:00.000Z",
    published_metadata: {
      ...after.published_metadata,
      standalone_bootstrap_run: renewalRun,
      repository_sha256: "2f09956c9673b69a37fff2556e611af654adf4141f80ffc24a2d207d7873354e",
      timestamp_sha256: "5eea7d893c9481a9a5fb27e582abe2b7b96c9a8b456dfc0c23aa9f1e808ae9c8",
      snapshot_sha256: "688832524d9e95286975bc9f24c00b7a3961357e94c5a37ee2dbdaa41af71e01",
      versions: {
        targets: "1",
        releases: "5",
        preview: "5",
        stable: "5",
        snapshot: "5",
        timestamp: "5",
      },
      expires: {
        targets: offlineExpiry,
        releases: "2027-02-06T06:01:34.664Z",
        preview: "2026-11-15T06:01:34.664Z",
        stable: "2026-11-15T06:01:34.664Z",
        snapshot: "2026-11-15T06:01:34.664Z",
        timestamp: "2026-11-10T06:01:34.664Z",
      },
      publication: {
        ...after.published_metadata.publication,
        remote_identity: `https://github.com/boburning/portcove/actions/runs/${renewalRun}/job/128600000001`,
        site_generation_sha256: standaloneBootstrapRenewalAdoption.generation,
      },
    },
  };
  validatePublishedMetadataTransition(before, renewal, null);
  const pin = standaloneBootstrapForwardAdoption;
  const predecessor = {
    ...renewal,
    published_metadata: {
      ...renewal.published_metadata,
      standalone_bootstrap_run: pin.prior_run_id,
      publication: {
        ...renewal.published_metadata.publication,
        remote_identity: `https://github.com/boburning/portcove/actions/runs/${pin.prior_run_id}/job/${pin.prior_job_id}`,
      },
    },
  };
  const forwardFacts = {
    ...after.published_metadata,
    repository_sha256: "c60ac310b3f6a7ccd118dce45314fa40e09b5db9c397fde469d546541b80c014",
    timestamp_sha256: "ec9e767be018497ebb6a6b33b2bbe5857d71f33e730155a26aaa57fb410e2bcd",
    snapshot_sha256: "57fe74fc121326f45788c5ca36bf1dba128e0f65686b46cb9e18456de4e5fe06",
    versions: {
      targets: "1",
      releases: "7",
      preview: "7",
      stable: "7",
      snapshot: "7",
      timestamp: "7",
    },
    expires: {
      targets: offlineExpiry,
      releases: "2027-02-07T07:10:19.735Z",
      preview: "2026-11-16T07:10:19.735Z",
      stable: "2026-11-16T07:10:19.735Z",
      snapshot: "2026-11-16T07:10:19.735Z",
      timestamp: "2026-11-11T07:10:19.735Z",
    },
  };
  const forward = {
    ...predecessor,
    now: "2026-11-10T08:00:00.000Z",
    published_metadata: {
      ...forwardFacts,
      standalone_bootstrap_run: pin.run_id,
      publication: {
        ...predecessor.published_metadata.publication,
        remote_identity: `https://github.com/boburning/portcove/actions/runs/${pin.run_id}/job/${pin.feed_job_id}`,
        site_generation_sha256: pin.generation,
      },
    },
  };
  validatePublishedMetadataTransition(predecessor, forward, null);
  assert.equal(currentPublishedSite(forward)?.generation_sha256, pin.generation);
  for (const prior of [
    before,
    renewal,
    { ...predecessor, review_request: {} },
    { ...predecessor, published_site: null },
  ])
    assert.throws(
      () => validatePublishedMetadataTransition(prior, forward, null),
      /exact predecessor/u,
    );
  assert.throws(
    () =>
      validatePublishedMetadataTransition(
        predecessor,
        { ...forward, now: "2026-11-11T08:00:00.000Z" },
        null,
      ),
    /expired standalone bootstrap/u,
  );
  const native = servedNativeBootstrapRenewal;
  const superseded = {
    schema_version: 1,
    kind: "application-tuf-metadata-renewal",
    generated_at: "2026-11-10T09:06:10Z",
    root_sha256: forwardFacts.root_sha256,
    offline_targets_sha256: forwardFacts.offline_targets_sha256,
    unchanged_records_sha256: forwardFacts.records_sha256,
    prior_repository_sha256: forwardFacts.repository_sha256,
    prior_timestamp_sha256: forwardFacts.timestamp_sha256,
    prior_snapshot_sha256: forwardFacts.snapshot_sha256,
    current_versions: forwardFacts.versions,
    current_expires: forwardFacts.expires,
    next_versions: {
      targets: "1",
      releases: "8",
      preview: "8",
      stable: "8",
      snapshot: "8",
      timestamp: "8",
    },
    next_expires: {
      targets: offlineExpiry,
      releases: "2027-02-08T09:06:10Z",
      preview: "2026-11-17T09:06:10Z",
      stable: "2026-11-17T09:06:10Z",
      snapshot: "2026-11-17T09:06:10Z",
      timestamp: "2026-11-12T09:06:10Z",
    },
  };
  const operation = {
    id: native.settled_operation_id,
    kind: "upload",
    outcome: "recovered",
    completed_effects: [],
    metadata_renewal: { descriptor_sha256: native.superseded_descriptor_sha256 },
    recovery: { resolution: "effect-not-applied" },
  };
  const servedBefore = {
    ...forward,
    metadata_renewal: superseded,
    review_request: { preserved: "exact request" },
    controller: { capacity_attempt: { operation } },
  };
  const servedAfter = {
    ...servedBefore,
    now: "2026-11-11T17:00:00.000Z",
    metadata_renewal: null,
    published_metadata: {
      ...forward.published_metadata,
      standalone_bootstrap_run: native.run_id,
      repository_sha256: "666abbccb87032ddd004bdeff0b70a3b7a01288baa21adb9811c8c1f9d753489",
      timestamp_sha256: "8f8be74a893ee13e9323febbf86dd20ebbc5b18b849b41a2a2d2c659504504cd",
      snapshot_sha256: "28cb551261a42f71cdfd744c8025121f41141f44293e17ca02277e083fe26045",
      versions: superseded.next_versions,
      expires: {
        targets: offlineExpiry,
        releases: "2027-02-09T12:28:07.71Z",
        preview: "2026-11-18T12:28:07.71Z",
        stable: "2026-11-18T12:28:07.71Z",
        snapshot: "2026-11-18T12:28:07.71Z",
        timestamp: "2026-11-13T12:28:07.71Z",
      },
      publication: {
        ...forward.published_metadata.publication,
        remote_identity: `https://github.com/boburning/portcove/actions/runs/${native.run_id}/job/${native.feed_job_id}`,
        site_generation_sha256: native.generation,
      },
    },
  };
  validatePublishedMetadataTransition(servedBefore, servedAfter, operation);
  assert.equal(currentPublishedSite(servedAfter)?.generation_sha256, native.generation);
  for (const edited of [
    { ...servedAfter, metadata_renewal: superseded },
    { ...servedAfter, review_request: null },
    {
      ...servedAfter,
      controller: { capacity_attempt: { operation: { ...operation, completed_effects: [{}] } } },
    },
  ])
    assert.throws(
      () => validatePublishedMetadataTransition(servedBefore, edited, operation),
      /exact settled journal preimage/u,
    );
  assert.throws(
    () =>
      validatePublishedMetadataTransition(
        servedBefore,
        { ...servedAfter, now: "2026-11-13T12:28:07.710Z" },
        operation,
      ),
    /expired standalone bootstrap/u,
  );
  const {
    publication: _forwardPublication,
    operation_id: _forwardOperation,
    standalone_bootstrap_run: _forwardRun,
    ...forwardTuf
  } = forward.published_metadata;
  const assembly = retainedR56FeedRecovery;
  const forwardSelection = {
    discovered: {
      release_id: retainedR55Renewal.release_id,
      custody: { opportunity: retainedR55Renewal.opportunity, preparation: null },
      execution: {
        run: { id: pin.run_id, control_commit: pin.revision, control_ref: assembly.next_ref },
        attempt: 1,
        conclusion: "success",
        job_id: Number(pin.feed_job_id),
      },
      state: { log_url: forward.published_metadata.publication.remote_identity },
    },
    prior: {
      receipt: {
        producer: {
          id: assembly.run_id,
          control_commit: assembly.control_commit,
          control_ref: retainedR55Renewal.next_ref,
        },
        producer_attempt: 1,
        site: {
          previous_generation: standaloneBootstrapRenewalAdoption.generation,
          generation: pin.generation,
        },
        publication: forwardTuf,
      },
      metadata: {
        purpose: "metadata-renewal",
        prior_generation: standaloneBootstrapRenewalAdoption.generation,
        prior_repository_sha256: pin.prior_repository_sha256,
        context_sha256: assembly.context_sha256,
      },
      assets: Object.entries(assembly.assets).map(([name, asset]) => ({ name, ...asset })),
    },
  } as unknown as Parameters<typeof assertRetainedBootstrapForwardRenewal>[0];
  assertRetainedBootstrapForwardRenewal(forwardSelection);
  const wrongServingJob = structuredClone(forwardSelection);
  wrongServingJob.discovered.execution.job_id++;
  assert.throws(() => assertRetainedBootstrapForwardRenewal(wrongServingJob));
  const wrongPrior = structuredClone(forwardSelection);
  assert.ok(isRecord(wrongPrior.prior.metadata));
  wrongPrior.prior.metadata.prior_repository_sha256 = "0".repeat(64);
  assert.throws(() => assertRetainedBootstrapForwardRenewal(wrongPrior));
  const {
    publication: _publication,
    operation_id: _operation,
    standalone_bootstrap_run: _run,
    ...facts
  } = renewal.published_metadata;
  const run = {
    id: renewalRun,
    control_commit: "e".repeat(40),
    control_ref: standaloneBootstrapRenewalAdoption.feed_ref,
  };
  const selection = {
    discovered: {
      release_id: retainedServedRenewal.release_id,
      custody: {
        opportunity: retainedServedRenewal.opportunity,
        source: retainedServedRenewal.source,
        preparation: null,
        runs: [run],
      },
      execution: { run, attempt: 1, conclusion: "success", job_id: 128600000001 },
      state: { log_url: renewal.published_metadata.publication.remote_identity },
    },
    prior: {
      receipt: {
        producer: {
          id: "42452784395",
          control_commit: "8a3bbbba04c2f67f4f1654efef44d0a6186e8410",
          control_ref: retainedServedRenewal.next_ref,
        },
        producer_attempt: 1,
        site: {
          previous_generation: generation,
          generation: standaloneBootstrapRenewalAdoption.generation,
        },
        publication: facts,
      },
      metadata: {
        purpose: "metadata-renewal",
        prior_generation: generation,
        prior_repository_sha256: after.published_metadata.repository_sha256,
        context_sha256: "fdd0c0dc4b956383a56f21994a8fc4815b091c16ffc480c1291e3553e479bb15",
      },
      assets: [
        {
          id: 723074720,
          name: "application-site.zip",
          sha256: "5d7861c34626e422a0b8e613cf5da603bfc1fd439946857dfba436d127b0aef3",
        },
        {
          id: 723074721,
          name: "application-metadata.json",
          sha256: "f5a7c25de4a4f3d3799c566e0b1c6af71ae1af674e4c51a67aa17e2f39999039",
        },
      ],
    },
  } as unknown as Parameters<typeof assertRetainedBootstrapRenewal>[0];
  assertRetainedBootstrapRenewal(selection);
  const unappointed = structuredClone(selection);
  unappointed.discovered.execution.run.control_ref = standaloneBootstrapAdoption.ref;
  assert.throws(() => assertRetainedBootstrapRenewal(unappointed));
  const failed = structuredClone(selection);
  failed.discovered.execution.conclusion = "failure";
  assert.throws(() => assertRetainedBootstrapRenewal(failed));
  const replayed = structuredClone(selection);
  replayed.discovered.custody.runs.push({ ...run, id: "42400000002" });
  assert.throws(() => assertRetainedBootstrapRenewal(replayed));
  const unrelated = structuredClone(selection);
  assert.ok(isRecord(unrelated.prior.metadata));
  unrelated.prior.metadata.prior_repository_sha256 = "b".repeat(64);
  assert.throws(() => assertRetainedBootstrapRenewal(unrelated));
  assert.equal(
    currentPublishedSite(renewal)?.generation_sha256,
    standaloneBootstrapRenewalAdoption.generation,
  );
  assert.throws(
    () => validatePublishedMetadataTransition(after, renewal, null),
    /exact empty journal/u,
  );
  assert.throws(
    () =>
      validatePublishedMetadataTransition(
        before,
        { ...renewal, now: "2026-11-10T06:01:34.664Z" },
        null,
      ),
    /expired standalone/u,
  );
  for (const mutation of [
    { standalone_bootstrap_run: run_id },
    { timestamp_sha256: "b".repeat(64) },
    {
      publication: {
        ...renewal.published_metadata.publication,
        remote_identity: "https://example.com/forged",
      },
    },
    {
      publication: {
        ...renewal.published_metadata.publication,
        site_generation_sha256: generation,
      },
    },
  ]) {
    assert.throws(
      () =>
        validatePublishedMetadataTransition(
          before,
          {
            ...renewal,
            published_metadata: { ...renewal.published_metadata, ...mutation },
          },
          null,
        ),
      /exact publication/u,
    );
  }
  const repository = await mkdtemp(path.join(os.tmpdir(), "catalog-standalone-seed-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "--quiet", repository], { windowsHide: true });
  const initial = {
    ...before,
    schema_version: 2,
    now: "2026-11-03T21:20:37.000Z",
    opportunity: null,
    published_metadata: null,
    publication: {
      complete: true,
      observed_at: "2026-11-03T21:20:37.000Z",
      published_versions: [],
      published_sources: [],
      reserved_versions: [],
      last_routine_preview_at: null,
    },
    controller: {
      workflow: ".github/workflows/application-update-production.yml",
      revision: "3".repeat(40),
      publication_paused: false,
      capacity_attempt: { ...capacityFixture(), schema_version: 2 },
    },
  };
  const retained = await checkpointReleaseOpportunity(repository, null, initial);
  const next = {
    ...initial,
    ...after,
    publication: { ...initial.publication, observed_at: after.now },
  };
  const seed = await checkpointReleaseOpportunity(repository, retained.checkpoint, next);
  const readback = await recoverReleaseOpportunity(repository, seed.checkpoint);
  assert.deepEqual(readback.input.metadata_bootstrap, before.metadata_bootstrap);
  assert.deepEqual(readback.input.published_metadata, after.published_metadata);
  assert.deepEqual(readback.input.controller, initial.controller);
  assert.equal(currentPublishedSite(readback.input)?.generation_sha256, generation);
  const retry = await checkpointReleaseOpportunity(repository, retained.checkpoint, next);
  assert.equal(retry.checkpoint, seed.checkpoint);
  const competing = structuredClone(next);
  competing.published_metadata.publication.evidence_sha256 = "b".repeat(64);
  await assert.rejects(() =>
    checkpointReleaseOpportunity(repository, retained.checkpoint, competing),
  );
});

void test(
  "metadata renewal remains available during a failed candidate without consuming its recovery counters",
  { timeout: 120000 },
  async (t) => {
    const f = await remoteCapacityFixture(t);
    const { descriptor, published } = metadataFixture();
    const input = structuredClone(
      (await recoverReleaseOpportunity(f.bare, f.migrated.checkpoint)).input,
    );
    assert.ok(isRecord(input.controller) && isRecord(input.controller.capacity_attempt));
    assert.ok(isRecord(input.active_candidate));
    input.controller.capacity_attempt.schema_version = 2;
    input.active_candidate.phase = "failed";
    input.active_candidate.failure_kind = "authority";
    const failed = await checkpointReleaseOpportunity(f.bare, f.migrated.checkpoint, input);
    assert.equal(failed.plan.action, "pause-exception");
    await publishCoordinatorCheckpoint(f.bare, failed.checkpoint, f.config, { api: f.api });
    const seeded = await recordPublishedMetadata(f.bare, failed.checkpoint, published, f.options);
    let effects = 0;
    const operation = await runBoundedMetadataRenewalOperation(
      f.bare,
      seeded.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:timestamp" },
      async () => f.capacity.boundary,
      async (record, pending) => {
        effects++;
        assert.equal(f.refs.get(f.stateRef), pending.checkpoint);
        await record("qualification:timestamp-during-native-hold", "a".repeat(64));
      },
      { ...f.options, maximumReceipts: 1 },
    );
    assert.equal(effects, 1);
    const saved = await recoverReleaseOpportunity(f.bare, operation.checkpoint);
    assert.deepEqual(saved.input.active_candidate, input.active_candidate);
    assert.deepEqual(saved.input.review_request, input.review_request);
    assert.deepEqual(saved.input.review_disposition, input.review_disposition);
    assert.equal(saved.plan.action, "pause");
    assert.match(saved.plan.reason, /pending, refused or ambiguous operation/u);
    assert.equal(operation.operation.outcome, "pending");
    const settled = await recordCapacityReadback(
      f.bare,
      operation.checkpoint,
      "effect-completed",
      "b".repeat(64),
      f.options,
    );
    const resolved = await recoverReleaseOpportunity(f.bare, settled.checkpoint);
    assert.deepEqual(resolved.input.active_candidate, input.active_candidate);
    assert.equal(resolved.plan.action, "pause-exception");
  },
);

void test(
  "metadata renewal uses durable remote journal without allocating or changing an active candidate",
  { timeout: 120000 },
  async (t) => {
    const f = await remoteCapacityFixture(t);
    const { descriptor, published } = metadataFixture();
    const original = (await recoverReleaseOpportunity(f.bare, f.migrated.checkpoint)).input;
    const input = structuredClone(original);
    assert.ok(isRecord(input.controller) && isRecord(input.controller.capacity_attempt));
    input.controller.capacity_attempt.schema_version = 2;
    const modern = await checkpointReleaseOpportunity(f.bare, f.migrated.checkpoint, input);
    await publishCoordinatorCheckpoint(f.bare, modern.checkpoint, f.config, { api: f.api });
    let effects = 0;
    await assert.rejects(
      runBoundedMetadataRenewalOperation(
        f.bare,
        modern.checkpoint,
        descriptor,
        { kind: "upload", destination: "application-tuf:timestamp" },
        async () => f.capacity.boundary,
        async () => {
          effects++;
        },
        f.options,
      ),
      /seed absent/,
    );
    assert.equal(effects, 0);
    const seeded = await recordPublishedMetadata(f.bare, modern.checkpoint, published, f.options);
    const first = await runBoundedMetadataRenewalOperation(
      f.bare,
      seeded.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:timestamp" },
      async () => f.capacity.boundary,
      async (record, pending) => {
        effects++;
        assert.equal(f.refs.get(f.stateRef), pending.checkpoint);
        assert.ok(isRecord(pending.operation.metadata_renewal));
        assert.equal(
          pending.operation.metadata_renewal.prior_repository_sha256,
          published.repository_sha256,
        );
        assert.equal(pending.operation.candidate, undefined);
        await record("qualification:timestamp-envelope", "a".repeat(64));
      },
      { ...f.options, maximumReceipts: 1 },
    );
    assert.equal(first.operation.outcome, "pending");
    await assert.rejects(
      recordCapacityReadback(f.bare, first.checkpoint, "effect-completed", "b".repeat(64), {
        ...f.options,
        completedEffect: {
          remote_identity: "qualification:substituted",
          evidence_sha256: "a".repeat(64),
        },
      }),
      /cannot replace/,
    );
    const recovered = await recordCapacityReadback(
      f.bare,
      first.checkpoint,
      "effect-completed",
      "b".repeat(64),
      {
        ...f.options,
        completedEffect: {
          remote_identity: "qualification:timestamp-envelope",
          evidence_sha256: "a".repeat(64),
        },
      },
    );
    const second = await runBoundedMetadataRenewalOperation(
      f.bare,
      recovered.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:Pages" },
      async () => f.capacity.boundary,
      async (record) => record("qualification:Pages-generation", "c".repeat(64)),
      { ...f.options, maximumReceipts: 1 },
    );
    const resolved = await recordCapacityReadback(
      f.bare,
      second.checkpoint,
      "effect-completed",
      "d".repeat(64),
      f.options,
    );
    const saved = await recoverReleaseOpportunity(f.bare, resolved.checkpoint);
    assert.deepEqual(saved.input.active_candidate, original.active_candidate);
    assert.equal(saved.input.now, original.now);
    assert.ok(
      isRecord(saved.input.controller) && isRecord(saved.input.controller.capacity_attempt),
    );
    const groups = saved.input.controller.capacity_attempt.prior_operations;
    assert.ok(
      Array.isArray(groups) &&
        isRecord(groups[0]) &&
        Array.isArray(groups[0].attempts) &&
        isRecord(groups[0].attempts[0]),
    );
    const proof = groups[0].attempts[0];
    const raw = readRetainedCapacityOperation(f.bare, {
      checkpoint: String(proof.checkpoint),
      id: String(proof.id),
      operation_sha256: String(proof.operation_sha256),
    });
    assert.equal(raw.id, first.operation.id);
    // A newly recovered sparse journal does not contain arbitrary older
    // compact checkpoints. Hydrate exactly the original three inert objects
    // through the supplied owned read-only transport, without fetching parents.
    const sparse = await mkdtemp(path.join(os.tmpdir(), "retained-operation-sparse-"));
    t.after(() => rm(sparse, { recursive: true, force: true }));
    execFileSync("git", ["init", "--bare", "-q", sparse], { windowsHide: true });
    const retainedProof = {
      checkpoint: String(proof.checkpoint),
      id: String(proof.id),
      operation_sha256: String(proof.operation_sha256),
    };
    assert.throws(() => readRetainedCapacityOperation(sparse, retainedProof));
    const commitBytes = execFileSync("git", [
      "-C",
      f.bare,
      "cat-file",
      "commit",
      retainedProof.checkpoint,
    ]);
    const commitText = commitBytes.toString("utf8"),
      boundary = commitText.indexOf("\n\n"),
      header = commitText.slice(0, boundary),
      treeId = /^tree ([a-f0-9]{40})$/mu.exec(header)![1]!;
    const treeBytes = execFileSync("git", ["-C", f.bare, "cat-file", "tree", treeId]),
      blobId = treeBytes.subarray(-20).toString("hex");
    const blobBytes = execFileSync("git", ["-C", f.bare, "cat-file", "blob", blobId]);
    const actor = {
      name: "Portcove release coordinator",
      email: "coordinator@portcove.invalid",
      date: "2000-01-01T00:00:00Z",
    };
    const bodies = new Map<string, unknown>([
      [
        `repos/boburning/portcove/git/commits/${retainedProof.checkpoint}`,
        {
          sha: retainedProof.checkpoint,
          tree: { sha: treeId },
          parents: [...header.matchAll(/^parent ([a-f0-9]{40})$/gmu)].map((match) => ({
            sha: match[1],
          })),
          author: actor,
          committer: actor,
          message: commitText.slice(boundary + 2),
        },
      ],
      [
        `repos/boburning/portcove/git/trees/${treeId}`,
        {
          sha: treeId,
          truncated: false,
          tree: [{ path: "state.json", mode: "100644", type: "blob", sha: blobId }],
        },
      ],
      [
        `repos/boburning/portcove/git/blobs/${blobId}`,
        {
          sha: blobId,
          encoding: "base64",
          size: blobBytes.length,
          content: blobBytes.toString("base64"),
        },
      ],
    ]);
    const reads: string[] = [];
    const api = {
      request(method: string, endpoint: string, body?: unknown) {
        assert.equal(method, "GET");
        assert.equal(body, undefined);
        assert.ok(bodies.has(endpoint));
        reads.push(endpoint);
        return {
          status: 200,
          body: structuredClone(bodies.get(endpoint)),
          headers: new Map<string, string>(),
        };
      },
    };
    const hydrated = await hydrateRetainedCoordinatorOperation(sparse, retainedProof, { api });
    assert.deepEqual(hydrated, raw);
    assert.equal(reads.length, 3);
    const parentId = /^parent ([a-f0-9]{40})$/mu.exec(header)![1]!;
    assert.throws(() =>
      execFileSync("git", ["-C", sparse, "cat-file", "-e", parentId], {
        stdio: "pipe",
        windowsHide: true,
      }),
    );
    assert.equal(
      execFileSync("git", ["-C", sparse, "for-each-ref"], { encoding: "utf8", windowsHide: true }),
      "",
    );
    await assert.rejects(
      hydrateRetainedCoordinatorOperation(
        sparse,
        { ...retainedProof, operation_sha256: "0".repeat(64) },
        { api },
      ),
      /exact raw capacity operation/,
    );
    assert.equal(reads.length, 6);
    const historical = await hydrateRetainedCoordinatorCheckpoint(
      sparse,
      retainedProof.checkpoint,
      { api },
    );
    assert.equal(historical.checkpoint, retainedProof.checkpoint);
    assert.equal(historical.authority, "none");
    const originalHistorical: unknown = JSON.parse(blobBytes.toString("utf8"));
    assert.ok(isRecord(originalHistorical));
    assert.deepEqual(historical.input, originalHistorical.input);
    assert.equal(reads.length, 9);
    assert.equal(
      execFileSync("git", ["-C", sparse, "for-each-ref"], { encoding: "utf8", windowsHide: true }),
      "",
    );
    await assert.rejects(
      hydrateRetainedCoordinatorCheckpoint(sparse, "main", { api }),
      /exact Git/,
    );
    assert.equal(reads.length, 9);
    assert.throws(() =>
      readRetainedCapacityOperation(f.bare, {
        checkpoint: String(proof.checkpoint),
        id: String(proof.id),
        operation_sha256: "0".repeat(64),
      }),
    );
    await assert.rejects(
      runBoundedMetadataRenewalOperation(
        f.bare,
        resolved.checkpoint,
        { ...descriptor, generated_at: descriptor.generated_at },
        { kind: "upload", destination: "application-tuf:timestamp" },
        async () => f.capacity.boundary,
        async () => assert.fail("completed effect cannot repeat"),
        f.options,
      ),
      /repeat|recovery/,
    );
    const advanced = {
      ...published,
      repository_sha256: "e".repeat(64),
      snapshot_sha256: "f".repeat(64),
      timestamp_sha256: "0".repeat(64),
      versions: descriptor.next_versions,
      expires: descriptor.next_expires,
      operation_id: second.operation.id,
      publication: {
        remote_identity: "qualification:Pages-generation",
        evidence_sha256: "c".repeat(64),
        site_generation_sha256: "9".repeat(64),
      },
    };
    const final = await recordPublishedMetadata(f.bare, resolved.checkpoint, advanced, f.options);
    const finalInput = (await recoverReleaseOpportunity(f.bare, final.checkpoint)).input;
    assert.ok(isDeepStrictEqual(finalInput.active_candidate, original.active_candidate));
    assert.deepEqual(finalInput.published_metadata, advanced);
    assert.ok(isRecord(finalInput.controller) && isRecord(finalInput.controller.capacity_attempt));
    assert.deepEqual(finalInput.controller.capacity_attempt.prior_operations, []);
    assert.equal(f.refs.get(f.stateRef), final.checkpoint);
  },
);

void test(
  "observed single-effect readback restores a lost receipt and permits only its metadata handoff",
  { timeout: 120000 },
  async (t) => {
    const f = await remoteCapacityFixture(t);
    const { descriptor, published } = metadataFixture();
    const input = structuredClone(
      (await recoverReleaseOpportunity(f.bare, f.migrated.checkpoint)).input,
    );
    assert.ok(isRecord(input.controller) && isRecord(input.controller.capacity_attempt));
    input.controller.capacity_attempt.schema_version = 2;
    const modern = await checkpointReleaseOpportunity(f.bare, f.migrated.checkpoint, input);
    await publishCoordinatorCheckpoint(f.bare, modern.checkpoint, f.config, { api: f.api });
    const seed = await recordPublishedMetadata(f.bare, modern.checkpoint, published, f.options);
    let checkpoint = "",
      effects = 0;
    const request = { kind: "upload" as const, destination: "application-tuf:lost-Pages-response" };
    await assert.rejects(
      runBoundedMetadataRenewalOperation(
        f.bare,
        seed.checkpoint,
        descriptor,
        request,
        async () => f.capacity.boundary,
        async () => {
          effects++;
          throw new Error("provider response lost after effect");
        },
        { ...f.options, maximumReceipts: 1 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
        checkpoint = String(error.evidence.checkpoint);
        return true;
      },
    );
    const lost = await recoverReleaseOpportunity(f.bare, checkpoint);
    assert.ok(isRecord(lost.input.controller) && isRecord(lost.input.controller.capacity_attempt));
    const original = lost.input.controller.capacity_attempt.operation;
    assert.ok(isRecord(original));
    assert.deepEqual(original.completed_effects, []);
    const receipt = {
      remote_identity: "qualification:observed-public-Pages-generation",
      evidence_sha256: "c".repeat(64),
    };
    for (const resolution of ["effect-not-applied", "partial-effects-retained"] as const)
      await assert.rejects(
        recordCapacityReadback(f.bare, checkpoint, resolution, "d".repeat(64), {
          ...f.options,
          completedEffect: receipt,
        }),
        /single-effect completion/,
      );
    await assert.rejects(
      recordCapacityReadback(f.bare, checkpoint, "effect-completed", "d".repeat(64), {
        ...f.options,
        completedEffect: { ...receipt, evidence_sha256: "invalid" },
      }),
    );
    assert.equal(
      execFileSync("git", ["-C", f.bare, "rev-parse", coordinatorStateRef], {
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      checkpoint,
    );
    const pendingRecovery = recordCapacityReadback(
      f.bare,
      checkpoint,
      "effect-completed",
      "d".repeat(64),
      {
        ...f.options,
        completedEffect: receipt,
      },
    );
    receipt.remote_identity = "mutated-after-call";
    const resolved = await pendingRecovery;
    const saved = await recoverReleaseOpportunity(f.bare, resolved.checkpoint);
    assert.ok(
      isRecord(saved.input.controller) && isRecord(saved.input.controller.capacity_attempt),
    );
    const operation = saved.input.controller.capacity_attempt.operation;
    assert.ok(isRecord(operation));
    assert.equal(operation.id, original.id);
    assert.equal(operation.executor_nonce, original.executor_nonce);
    assert.deepEqual(operation.failure_evidence, original.failure_evidence);
    assert.deepEqual(operation.completed_effects, [
      {
        remote_identity: "qualification:observed-public-Pages-generation",
        evidence_sha256: "c".repeat(64),
      },
    ]);
    assert.equal(f.refs.get(f.stateRef), resolved.checkpoint);
    await assert.rejects(
      runBoundedMetadataRenewalOperation(
        f.bare,
        resolved.checkpoint,
        descriptor,
        request,
        async () => f.capacity.boundary,
        async () => {
          effects++;
        },
        f.options,
      ),
      /repeat|recovery/,
    );
    assert.equal(effects, 1);
    const successor = {
      ...published,
      repository_sha256: "e".repeat(64),
      snapshot_sha256: "f".repeat(64),
      timestamp_sha256: "0".repeat(64),
      versions: descriptor.next_versions,
      expires: descriptor.next_expires,
      operation_id: original.id,
      publication: {
        remote_identity: "qualification:observed-public-Pages-generation",
        evidence_sha256: "c".repeat(64),
        site_generation_sha256: "9".repeat(64),
      },
    };
    const advanced = await recordPublishedMetadata(
      f.bare,
      resolved.checkpoint,
      successor,
      f.options,
    );
    assert.deepEqual(
      (await recoverReleaseOpportunity(f.bare, advanced.checkpoint)).input.published_metadata,
      successor,
    );
  },
);

void test(
  "metadata-only renewal needs no candidate and its compact state survives sparse import",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const before = (await recoverReleaseOpportunity(f.repository, f.initial.checkpoint)).input;
    const capacity = { ...capacityFixture(), schema_version: 2 };
    const input = {
      ...before,
      schema_version: 2,
      controller: {
        workflow: ".github/workflows/release-coordinator.yml",
        revision: "3".repeat(40),
        publication_paused: false,
        capacity_attempt: capacity,
      },
    };
    const migrated = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, input);
    const { descriptor, published } = metadataFixture();
    const seeded = await recordPublishedMetadata(f.repository, migrated.checkpoint, published);
    const first = await runBoundedMetadataRenewalOperation(
      f.repository,
      seeded.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:releases" },
      async () => capacity.boundary,
      async (record) => record("qualification:release-role", "a".repeat(64)),
      { maximumReceipts: 1 },
    );
    const second = await runBoundedMetadataRenewalOperation(
      f.repository,
      first.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:preview" },
      async () => capacity.boundary,
      async (record) => record("qualification:preview-role", "b".repeat(64)),
      { maximumReceipts: 1 },
    );
    const transportRepository = path.join(f.repository, "metadata-transport.git");
    execFileSync("git", ["clone", "--mirror", "--quiet", f.repository, transportRepository], {
      windowsHide: true,
    });
    const exported = await exportCoordinatorCheckpoint(transportRepository, second.checkpoint);
    const sparse = path.join(f.repository, "metadata-sparse.git");
    execFileSync("git", ["init", "--bare", "--quiet", sparse], { windowsHide: true });
    const objects: { kind: "commit" | "tree" | "blob"; oid: string; bytes: Buffer }[] = [];
    for (const checkpoint of [exported.checkpoint, exported.previous]) {
      assert.ok(checkpoint);
      for (const [kind, suffix] of [
        ["commit", ""],
        ["tree", "^{tree}"],
        ["blob", ":state.json"],
      ] as const) {
        const oid = execFileSync(
          "git",
          ["-C", transportRepository, "rev-parse", checkpoint + suffix],
          { encoding: "utf8", windowsHide: true },
        ).trim();
        if (!objects.some((object) => object.oid === oid))
          objects.push({
            kind,
            oid,
            bytes: execFileSync("git", ["-C", transportRepository, "cat-file", kind, oid], {
              windowsHide: true,
            }),
          });
      }
    }
    await importCoordinatorCheckpoint(sparse, exported.checkpoint, objects);
    const restored = await recoverReleaseOpportunity(sparse, exported.checkpoint);
    assert.equal(restored.input.active_candidate, null);
    assert.deepEqual(restored.input.published_metadata, published);
    assert.equal(restored.input.now, before.now);
    assert.ok(
      isRecord(restored.input.controller) && isRecord(restored.input.controller.capacity_attempt),
    );
    const groups = restored.input.controller.capacity_attempt.prior_operations;
    assert.ok(Array.isArray(groups) && groups.length === 1);
    assert.throws(() =>
      execFileSync("git", ["-C", sparse, "cat-file", "-e", seeded.checkpoint], {
        windowsHide: true,
        stdio: "ignore",
      }),
    );
  },
);

for (const expires of ["read", "first-object", "before-cas", "mutated-options"]) {
  void test(`authenticated checkpoint expiry after ${expires} stops the next mutation and retains completed effects`, async (t) => {
    const f = await remoteFixture(t),
      proof = checkpointProofFixture(f.checkpoint, f.config);
    const directory = await mkdtemp(path.join(os.tmpdir(), "checkpoint-publisher-auth-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "inert-metadata-token";
    t.after(() => {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    let clock = performance.now();
    t.mock.method(performance, "now", () => clock);
    t.mock.method(childProcess, "spawnSync", (_command: string, args: readonly string[]) => {
      if (args[0] === "attestation")
        return {
          status: 0,
          stdout: JSON.stringify([{ verificationResult: proof.verification }]),
          stderr: "",
        };
      assert.fail("unexpected retained CLI route");
    });
    syncBuiltinESMExports();
    t.mock.method(
      globalThis,
      "fetch",
      releaseCustodyFetch(proof.provider, (_url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "token inert-metadata-token");
      }),
    );
    await withReadOnlyReleaseChildren(directory, async () => {
      const receipt = await authenticateCoordinatorCheckpointEvidence(
        directory,
        f.checkpoint,
        f.config,
        proof.evidence,
        proof.expected,
        clock + 60000,
      );
      let posts = 0,
        expired = false;
      const api: CoordinatorRemoteApi = {
        request(method, endpoint, body) {
          const response = f.api.request(method, endpoint, body);
          if (method === "POST") posts++;
          if (
            (expires === "read" && method === "GET" && endpoint.includes("/git/commits/")) ||
            (expires === "first-object" && posts === 1) ||
            (expires === "before-cas" && posts === 7)
          ) {
            if (!expired) {
              clock += 60001;
              expired = true;
            }
          }
          return response;
        },
        graphql: (...args) => f.api.graphql(...args),
      };
      if (expires === "mutated-options") {
        const mutable: Parameters<typeof publishCoordinatorCheckpoint>[3] = {
          api,
          authenticatedEvidence: receipt,
        };
        const pending = publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, mutable);
        delete mutable.authenticatedEvidence;
        mutable.evidence = checkpointEvidence(f, "replacement-inert-bundle");
        const result = await pending;
        const expectedProof = inspectCoordinatorCheckpointEvidence(
          f.checkpoint,
          f.config,
          proof.evidence,
        );
        assert.deepEqual(result.updates.at(-1), expectedProof.update);
        assert.equal(f.refs.get(expectedProof.update.name), expectedProof.update.afterOid);
        return;
      }
      await assert.rejects(
        publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
          api,
          authenticatedEvidence: receipt,
        }),
        /authenticated checkpoint/,
      );
      assert.equal(f.counts().mutations, 0);
      assert.equal(f.counts().posts, expires === "read" ? 0 : expires === "first-object" ? 1 : 7);
      assert.equal(f.refs.get(f.stateRef), f.initial.checkpoint);
    });
  });
}
