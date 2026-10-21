import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectMetadataSigningBinding,
  inspectMetadataSigningReservation,
} from "./release-metadata-signing-contract.mts";
import {
  prepareCoordinatorSigningContext,
  requireCoordinatorSigningContext,
  readCoordinatorSigningContextFiles,
  bindCoordinatorSigningContextPending,
} from "./release-metadata-signing-context.mts";
import { completeCoordinatorSigningContext } from "./release-metadata-signing-controller.mts";

function fixture() {
  const roles = ["targets", "releases", "preview", "stable", "snapshot", "timestamp"],
    versions = Object.fromEntries(roles.map((role) => [role, "9007199254740993"])),
    next = Object.fromEntries(
      roles.map((role) => [role, role === "targets" ? "9007199254740993" : "9007199254740994"]),
    ),
    expires = Object.fromEntries(roles.map((role) => [role, "2026-10-21T00:00:00Z"])),
    after = Object.fromEntries(
      roles.map((role) => [
        role,
        role === "targets" ? "2026-10-21T00:00:00Z" : "2026-10-22T00:00:00Z",
      ]),
    );
  const pins = {
    repository_sha256: "a".repeat(64),
    root_sha256: "b".repeat(64),
    site_generation_sha256: "c".repeat(64),
  };
  const descriptor = {
    schema_version: 1,
    kind: "application-tuf-metadata-renewal",
    generated_at: "2026-10-20T00:00:00Z",
    root_sha256: pins.root_sha256,
    offline_targets_sha256: "d".repeat(64),
    prior_repository_sha256: pins.repository_sha256,
    prior_timestamp_sha256: "e".repeat(64),
    prior_snapshot_sha256: "f".repeat(64),
    unchanged_records_sha256: digest([]),
    current_versions: versions,
    next_versions: next,
    current_expires: expires,
    next_expires: after,
  };
  const facts = {
    mode: "renewal",
    descriptor,
    namespace: "portcove-test",
    checkpoint: "1".repeat(40),
    previous_site_pins: pins,
    setup_plan_sha256: "2".repeat(64),
    public_source_commit: "3".repeat(40),
  };
  const binding = {
    kind: "metadata-renewal",
    descriptor_sha256: digest(descriptor),
    records_sha256: descriptor.unchanged_records_sha256,
  };
  return { facts, binding, pins };
}
void test("renewal role journal binding needs the exact live published seed and descriptor, with no invented candidate", (t) => {
  const f = fixture(),
    d = f.facts.descriptor;
  const published = {
    schema_version: 1,
    root_sha256: d.root_sha256,
    offline_targets_sha256: d.offline_targets_sha256,
    repository_sha256: d.prior_repository_sha256,
    timestamp_sha256: d.prior_timestamp_sha256,
    snapshot_sha256: d.prior_snapshot_sha256,
    records_sha256: d.unchanged_records_sha256,
    versions: d.current_versions,
    expires: d.current_expires,
    operation_id: null,
    publication: {
      remote_identity: "public fixture",
      evidence_sha256: "9".repeat(64),
      site_generation_sha256: f.pins.site_generation_sha256,
    },
  };
  const state = {
    input: { active_candidate: null, metadata_renewal: d, published_metadata: published },
  };
  const now = "2026-10-20T01:00:00Z";
  assert.deepEqual(inspectMetadataSigningReservation(f.facts, f.binding, f.pins, state, now), d);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T01:00:00.120Z") });
  assert.deepEqual(inspectMetadataSigningReservation(f.facts, f.binding, f.pins, state), d);
  t.mock.timers.tick(880);
  assert.equal(new Date().toISOString(), "2026-10-20T01:00:01.000Z");
  assert.deepEqual(inspectMetadataSigningReservation(f.facts, f.binding, f.pins, state), d);
  for (const input of [
    { ...state.input, metadata_renewal: null },
    { ...state.input, published_metadata: null },
    { ...state.input, published_metadata: { ...published, records_sha256: "0".repeat(64) } },
    {
      ...state.input,
      published_metadata: {
        ...published,
        publication: { ...published.publication, site_generation_sha256: "0".repeat(64) },
      },
    },
  ])
    assert.throws(() =>
      inspectMetadataSigningReservation(f.facts, f.binding, f.pins, { input }, now),
    );
  assert.throws(
    () =>
      inspectMetadataSigningReservation(f.facts, f.binding, f.pins, state, "2026-10-22T00:00:00Z"),
    /expired/,
  );
});
void test("renewal context public contract preserves exact u64 and distinguishes unchanged feed from release/bootstrap claims", () => {
  const f = fixture(),
    result = inspectMetadataSigningBinding(f.facts, f.binding, f.pins);
  assert.equal(result.authority, "none");
  assert.equal(result.facts.descriptor.next_versions.releases, "9007199254740994");
  f.facts.descriptor.next_versions.releases = "7";
  assert.equal(result.facts.descriptor.next_versions.releases, "9007199254740994");
  for (const altered of [
    { ...fixture().facts, mode: "bootstrap" },
    { ...fixture().facts, version: "1.0.0" },
    { ...fixture().facts, native_accepted: true },
    { ...fixture().facts, checkpoint: "not-a-checkpoint" },
    { ...fixture().facts, namespace: "another/repository" },
  ])
    assert.throws(() => inspectMetadataSigningBinding(altered, fixture().binding, fixture().pins));
});
void test("metadata transport cannot substitute prior site, descriptor, records or offline role progression", () => {
  const f = fixture();
  for (const binding of [
    { ...f.binding, kind: "release-signing-context" },
    { ...f.binding, descriptor_sha256: "0".repeat(64) },
    { ...f.binding, records_sha256: "0".repeat(64) },
    { ...f.binding, accepted: true },
  ])
    assert.throws(() => inspectMetadataSigningBinding(f.facts, binding, f.pins));
  assert.throws(() =>
    inspectMetadataSigningBinding(f.facts, f.binding, {
      ...f.pins,
      repository_sha256: "0".repeat(64),
    }),
  );
  const changed = fixture();
  changed.facts.descriptor.next_versions.targets = "9007199254740994";
  assert.throws(() =>
    inspectMetadataSigningBinding(
      changed.facts,
      { ...changed.binding, descriptor_sha256: digest(changed.facts.descriptor) },
      changed.pins,
    ),
  );
});
void test("serialized coordinator results or caller pending cannot mint context custody or write outputs", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "metadata-context-refusal-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const imported = {
    kind: "actual-coordinator-metadata-signing-context",
    mode: "renewal",
    authority: "none",
  };
  await assert.rejects(
    prepareCoordinatorSigningContext(imported, parent, performance.now() + 1000),
    /same-process/,
  );
  await assert.rejects(completeCoordinatorSigningContext(imported, parent), /same-process/);
  await assert.rejects(requireCoordinatorSigningContext(imported), /actual coordinator/);
  await assert.rejects(readCoordinatorSigningContextFiles(imported), /actual coordinator/);
  await assert.rejects(
    bindCoordinatorSigningContextPending(imported, {} as never, {
      checkpoint: "a".repeat(40),
      operation_id: "b".repeat(64),
    }),
    /actual coordinator/,
  );
  assert.deepEqual(await readdir(parent), []);
});
