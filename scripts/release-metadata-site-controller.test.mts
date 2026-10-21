import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectMetadataSiteReservation,
  runFixedMetadataSiteConfiguration,
  runMetadataSitePublicationController,
} from "./release-metadata-site-controller.mts";
import { runFixedSiteConfiguration } from "./release-site-controller.mts";

function fixture() {
  const roles = ["targets", "releases", "preview", "stable", "snapshot", "timestamp"];
  const versions = Object.fromEntries(roles.map((role) => [role, "9007199254740993"]));
  const expires = Object.fromEntries(roles.map((role) => [role, "2026-10-21T00:00:00Z"]));
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
    next_versions: Object.fromEntries(
      roles.map((role) => [role, role === "targets" ? "9007199254740993" : "9007199254740994"]),
    ),
    current_expires: expires,
    next_expires: Object.fromEntries(
      roles.map((role) => [
        role,
        role === "targets" ? "2026-10-21T00:00:00Z" : "2026-10-22T00:00:00Z",
      ]),
    ),
  };
  const manifest = {
    kind: "metadata-signing-context",
    facts: {
      mode: "renewal",
      descriptor,
      namespace: "portcove-test",
      checkpoint: "1".repeat(40),
      previous_site_pins: pins,
      setup_plan_sha256: "2".repeat(64),
      public_source_commit: "3".repeat(40),
    },
    binding: {
      kind: "metadata",
      descriptor_sha256: digest(descriptor),
      records_sha256: descriptor.unchanged_records_sha256,
    },
    previous_site_pins: pins,
  };
  const published = {
    schema_version: 1,
    root_sha256: descriptor.root_sha256,
    offline_targets_sha256: descriptor.offline_targets_sha256,
    repository_sha256: descriptor.prior_repository_sha256,
    timestamp_sha256: descriptor.prior_timestamp_sha256,
    snapshot_sha256: descriptor.prior_snapshot_sha256,
    records_sha256: descriptor.unchanged_records_sha256,
    versions,
    expires,
    operation_id: null,
    publication: {
      remote_identity: "public fixture",
      evidence_sha256: "9".repeat(64),
      site_generation_sha256: pins.site_generation_sha256,
    },
  };
  return {
    manifest,
    input: {
      active_candidate: null as unknown,
      metadata_renewal: descriptor,
      published_metadata: published,
    },
  };
}
void test("metadata site binds the exact unchanged seed and descriptor while preserving an active candidate", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T01:00:00.120Z") });
  const f = fixture();
  const first = inspectMetadataSiteReservation(f.input, f.manifest);
  assert.equal(first.authority, "none");
  assert.equal(first.candidate_sha256, digest(null));
  f.input.active_candidate = { version: "0.1.0-beta.1", phase: "qualifying", opaque: "unmodified" };
  const before = structuredClone(f.input);
  assert.equal(
    inspectMetadataSiteReservation(f.input, f.manifest).candidate_sha256,
    digest(f.input.active_candidate),
  );
  assert.deepEqual(f.input, before);
  for (const changed of [
    { ...f.input, metadata_renewal: null },
    { ...f.input, published_metadata: null },
    {
      ...f.input,
      published_metadata: { ...f.input.published_metadata, records_sha256: "0".repeat(64) },
    },
    {
      ...f.input,
      published_metadata: {
        ...f.input.published_metadata,
        publication: {
          ...f.input.published_metadata.publication,
          site_generation_sha256: "0".repeat(64),
        },
      },
    },
  ])
    assert.throws(() => inspectMetadataSiteReservation(changed, f.manifest));
  for (const changed of [
    { ...f.manifest, kind: "release-signing-context" },
    { ...f.manifest, facts: { ...f.manifest.facts, mode: "bootstrap" } },
  ])
    assert.throws(() => inspectMetadataSiteReservation(f.input, changed));
});
void test("imported metadata TUF receipts and invalid dispatch cannot allocate publication files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "metadata-site-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    runMetadataSitePublicationController({}, {}, root, performance.now() + 1000),
    /actual keyless/,
  );
  await assert.rejects(
    runMetadataSitePublicationController({}, {}, root, performance.now() - 1),
    /deadline/,
  );
  for (const raw of [
    {},
    { mode: "metadata" },
    {
      mode: "metadata",
      context: {},
      identity: {},
      roles: [],
      tools: { artifact: {}, bundle: {} },
    },
  ])
    await assert.rejects(
      runFixedMetadataSiteConfiguration(raw, root, performance.now() + 1000),
      /invocation/,
    );
  await assert.rejects(
    runFixedSiteConfiguration({ mode: "metadata" }, root, performance.now() - 1),
    /phase exhausted/,
  );
  assert.deepEqual(await readdir(root), []);
});
