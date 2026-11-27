import { upstreamFacts } from "./maintenance-upstream.mts";
import { createHash } from "node:crypto";
import { inputEvidenceKey, readOriginalSourceProgress } from "./upstream-original-recognition.mts";
import {
  n64AuthoringScope,
  n64PackagedInputLayout,
  planN64OriginalBindings,
  prepareN64OriginalContractAmendment,
} from "./n64-original-binding-candidates.mts";
import { n64GameTablePath, parseN64GameTable } from "./upstream-n64-game-entry.mts";
import { n64RuntimeLinkPath } from "./upstream-n64-runtime-input.mts";
import type { ProviderObservation } from "./upstream-observer.mts";
import { modeledCatalogSources, ObservationFailure } from "./upstream-observer.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiError } from "./github-operation.mts";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCatalogUpstreams,
  runCatalogOpportunity,
  hostedHandoffByteLimit,
  omitOversizedBindingInputs,
  retireObserverConfigurations,
} from "./observe-catalog-upstreams.mts";
import {
  advanceObservation,
  catalogObservationDefinitionHashes,
  validateObserverCheckpoint,
  observerCheckpointByteLimit,
} from "./observe-configured-upstream.mts";
import {
  advanceCatalogObservations,
  catalogObservationSources,
  newCatalogObserverCheckpoint,
  orderHostedObservationTurns,
  validateCatalogObserverCheckpoint,
} from "./catalog-upstream-observer.mts";
import type {
  CatalogObservationOptions,
  CatalogObserverCheckpoint,
} from "./catalog-upstream-observer.mts";
import {
  observationHash,
  reusableProviderObservation,
  validateObserverConfig,
} from "./upstream-observer.mts";
import { config, release } from "./fixtures/upstream-observation-fixtures.mts";
import {
  collectObserverSnapshot,
  publishObserverSnapshot,
  readObserverSnapshotArchive,
  encodeObserverSnapshot,
  observerSnapshotLimit,
  observerStreamingSnapshotLimit,
  observerStreamingGraphLimit,
  collectCompactObserverSnapshot,
  encodeCompactObserverSnapshot,
  recoverObserverCheckpoint,
  validateObserverSnapshot,
  encodeStreamingObserverSnapshot,
  readRecoverableObserverSnapshotArchive,
  collectFactObserverSnapshot,
} from "./observer-checkpoint-artifact.mts";
import {
  decodeStoredObserverCheckpoint,
  encodeStoredObserverCheckpoint,
} from "./observer-checkpoint-storage.mts";
import { isRecord } from "./runtime-values.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { encodeObserverRecords } from "./observer-snapshot-records.mts";

function harness(requests = 256) {
  let now = Date.parse("2026-10-27T00:00:00Z");
  let quota: number | null = null;
  let changedId = false;
  let revision = 0;
  const input = {
    ports: [
      { id: "stable-port", channels: ["stable"], release: { repository: "owner/shared" } },
      {
        id: "rolling-port",
        channels: ["rolling"],
        release: { repository: "owner/shared", rolling_tag: "rolling" },
      },
      { id: "other-port", channels: ["stable"], release: { repository: "owner/other" } },
      {
        id: "held-port",
        channels: ["stable"],
        release: { provider: "user-prepared", repository: "owner/held" },
      },
    ],
  };
  const states = new Map<string, unknown>();
  const exported: Parameters<CatalogObservationOptions["export"]>[] = [];
  const network: string[] = [];
  const snapshots: CatalogObserverCheckpoint[] = [];
  const options: CatalogObservationOptions = {
    config: validateObserverConfig({ ...config, budget: { ...config.budget, requests } }),
    now: () => now,
    policyIdentity: "a".repeat(64),
    definitionHash: (portId) => observationHash(input.ports.find((port) => port.id === portId)),
    sleep: async () => {},
    load: async (config) => states.get(observationHash(config)) ?? null,
    save: async (config, value) => {
      states.set(observationHash(config), structuredClone(value));
    },
    commit: async (value) => {
      snapshots.push(structuredClone(value));
    },
    withSourceLock: async (_config, operation) => operation(),
    repositoryId: async (source, transport) => {
      transport.admitRequest();
      network.push(`identity:${source.repository}`);
      return source.repository === "owner/shared" ? 7 : 8;
    },
    fetch: async (url) => {
      network.push(url);
      const repository = url.includes("/owner/shared") ? "owner/shared" : "owner/other";
      const id = repository === "owner/shared" ? 7 : 8;
      const pathname = new URL(url).pathname;
      const body = pathname.endsWith(repository)
        ? { id: changedId ? id + 100 : id, full_name: repository, archived: false }
        : pathname.endsWith("/releases")
          ? [release(2, { tag_name: "rolling" }), release(1, { tag_name: `v1.${revision}.0` })]
          : [];
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (quota !== null) {
        headers["x-ratelimit-remaining"] = String(quota);
        headers["x-ratelimit-limit"] = "100";
        headers["x-ratelimit-reset"] = String(Math.floor((now + 1000) / 1000));
      }
      return new Response(JSON.stringify(body), { headers });
    },
    // This mock exercises orchestration, not Core policy. Real Rust regressions
    // and hosted Core execution remain necessary for channel/asset semantics.
    project: async (portId, repositoryId, observation) => ({
      format: 1,
      port_id: portId,
      catalog_definition_sha256: observationHash(input.ports.find((port) => port.id === portId)),
      repository_id: repositoryId,
      facts_sha256: observation.facts_sha256,
      projections: [
        {
          channel: portId === "rolling-port" ? "rolling" : "stable",
          channel_candidate: { id: portId === "rolling-port" ? 2 : 1 },
          latest_eligible: null,
        },
      ],
      evidence: {
        provider_authenticated: false,
        artifact_bytes_verified: false,
        catalog_admission_assessed: false,
      },
    }),
    export: async (...values) => {
      exported.push(values);
    },
  };
  return {
    input,
    options,
    states,
    exported,
    network,
    snapshots,
    tick: () => {
      now += 10000;
    },
    setQuota: (value: number | null) => {
      quota = value;
    },
    changeIdentity: () => {
      changedId = true;
    },
    restoreIdentity: () => {
      changedId = false;
    },
    advanceClock: (milliseconds: number) => {
      now += milliseconds;
    },
    bumpRelease: () => {
      revision++;
    },
  };
}

void test("fresh-baseline provenance survives real bounded provider progress without supplying freshness", async () => {
  const h = harness(2);
  const prior = newCatalogObserverCheckpoint();
  prior.baseline = {
    id: "approved-baseline-fixture",
    continuity: "lost",
    initial_freshness: "unknown",
    initialized_at: new Date(h.options.now!() - 1000).toISOString(),
    producer: { run: 101, attempt: 1, source: "a".repeat(40) },
    inputs: {
      config_sha256: "a".repeat(64),
      catalog_sha256: "b".repeat(64),
      listings_sha256: "c".repeat(64),
    },
  };
  const result = await advanceCatalogObservations(h.input, prior, h.options);
  assert.deepEqual(result.checkpoint.baseline, prior.baseline);
  assert.ok(result.checkpoint.sequence > 0);
  assert.ok(h.states.size > 0);
  for (const progress of Object.values(result.checkpoint.sources)) {
    assert.notEqual(progress.completed_at, prior.baseline.initialized_at);
    assert.notEqual(progress.freshness_observed_at, prior.baseline.initialized_at);
  }
  for (const change of [
    { ...prior.baseline, continuity: "restored" },
    { ...prior.baseline, completed_at: prior.baseline.initialized_at },
    { ...prior.baseline, initialized_at: new Date(h.options.now!() + 1000).toISOString() },
    { ...prior.baseline, inputs: { ...prior.baseline.inputs, catalog_sha256: "invalid" } },
    { ...prior.baseline, producer: { ...prior.baseline.producer, attempt: 0 } },
  ])
    assert.throws(
      () => validateCatalogObserverCheckpoint({ ...prior, baseline: change }, h.options.now!()),
      /baseline provenance/,
    );
});

void test("a separate batch recovers accepted provider pages and fair turns after complete cache loss", async (t) => {
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "catalog-snapshot-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness(2);
  let result = await advanceCatalogObservations(h.input, null, h.options);
  const before = structuredClone(result.checkpoint);
  assert.ok(h.states.size > 0);
  assert.ok(result.report.pending_source_keys.length > 0);
  assert.ok(
    [...h.states.values()].some(
      (value) =>
        isRecord(value) &&
        isRecord(value.continuation) &&
        isRecord(value.continuation.pages) &&
        Object.keys(value.continuation.pages).length > 0,
    ),
  );
  const sourceTree = path.join(root, "work/upstream-observer");
  await mkdir(path.join(sourceTree, "catalog"), { recursive: true });
  await writeFile(path.join(sourceTree, "catalog/checkpoint.json"), JSON.stringify(before));
  for (const [digest, value] of h.states) {
    await mkdir(path.join(sourceTree, digest), { recursive: true });
    await writeFile(path.join(sourceTree, digest, "checkpoint.json"), JSON.stringify(value));
  }
  const snapshot = await collectObserverSnapshot(root, "c".repeat(64), {
    run: 101,
    attempt: 1,
    source: "a".repeat(40),
  });
  assert.ok(
    Object.keys(snapshot.files).length > 1,
    "Provider continuation must accompany the scheduler",
  );
  const transfer = await encodeStreamingObserverSnapshot(snapshot, Date.now() + 60000);
  const archive = createAuditZip([["checkpoint.json", transfer.bytes]]);
  const recovered = await readRecoverableObserverSnapshotArchive(
    archive,
    "c".repeat(64),
    Date.now(),
    Date.now() + 60000,
  );
  await rm(sourceTree, { recursive: true });
  h.states.clear();
  await publishObserverSnapshot(root, recovered);
  for (const [name, value] of Object.entries(recovered.files)) {
    assert.deepEqual(
      JSON.parse(await readFile(path.join(sourceTree, name), "utf8")),
      name === "catalog/checkpoint.json" ? before : value,
    );
    assert.deepEqual(decodeStoredObserverCheckpoint(value), snapshot.files[name]);
    if (name !== "catalog/checkpoint.json") h.states.set(name.split("/")[0]!, value);
  }
  let state = JSON.parse(
    await readFile(path.join(sourceTree, "catalog/checkpoint.json"), "utf8"),
  ) as CatalogObserverCheckpoint;
  assert.deepEqual(state, before);
  for (let batch = 0; batch < 24 && result.report.pending_source_keys.length > 0; batch++) {
    h.tick();
    result = await advanceCatalogObservations(h.input, state, h.options);
    assert.ok(result.report.requests <= 2);
    state = result.checkpoint;
  }
  assert.equal(result.report.pending_source_keys.length, 0);
  assert.ok(state.sequence > before.sequence);
  assert.equal(Object.values(state.sources).filter((source) => source.completed_at).length, 2);
  const missing = structuredClone(snapshot);
  delete missing.files[
    Object.keys(missing.files).find((name) => name !== "catalog/checkpoint.json")!
  ];
  assert.throws(
    () =>
      readObserverSnapshotArchive(
        createAuditZip([["checkpoint.json", JSON.stringify(missing)]]),
        "c".repeat(64),
        Date.now(),
        Date.now() + 60000,
      ),
    /checkpoint missing/,
  );
});

// Construct the historical raw-page representation explicitly. New observations
// deliberately retain only consumed facts, but legacy recovery remains lossless.
function legacyNotes(states: Map<string, unknown>, notes: string, assets = false) {
  for (const value of states.values()) {
    assert.ok(isRecord(value));
    const complete = isRecord(value.last_complete) ? value.last_complete : null;
    const cache = complete && isRecord(complete.cache) ? complete.cache : null;
    for (const holder of [cache, value.continuation]) {
      if (!isRecord(holder) || !isRecord(holder.pages)) continue;
      for (const [url, page] of Object.entries(holder.pages)) {
        assert.ok(isRecord(page));
        delete page.representation;
        delete page.facts_sha256;
        if (Array.isArray(page.body) && (assets || new URL(url).pathname.endsWith("/releases")))
          page.body = page.body.map((item: unknown) => {
            assert.ok(isRecord(item));
            return { ...item, body: notes };
          });
        page.sha256 = observationHash(page.body);
      }
    }
  }
}

void test("production-shaped retained provider pages fit the fixed artifact reserve through lossless encoding", async (t) => {
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "catalog-encoded-snapshot-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness(6),
    originalFetch = h.options.fetch!;
  // Real provider page bodies retain upstream release notes even though Core's
  // normalized release facts exclude them. Multiple valid source checkpoints
  // therefore exceed one response envelope without any individual file doing so.
  const releaseNotes = Array.from(
    { length: 18000 },
    (_, i) =>
      `Release note ${i}: preserve bounded collection, unchanged identity and all retained upstream metadata.`,
  ).join("\n");
  h.options.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    const body: unknown = await response.json();
    if (!Array.isArray(body) || !new URL(url).pathname.endsWith("/releases"))
      return new Response(JSON.stringify(body), { headers: response.headers });
    return new Response(
      JSON.stringify(
        body.map((release: unknown) => {
          assert.ok(isRecord(release));
          return { ...release, body: releaseNotes };
        }),
      ),
      { headers: response.headers },
    );
  };
  let result = await advanceCatalogObservations(h.input, null, h.options);
  for (
    let seed = 0;
    seed < 12 &&
    [...h.states.values()].reduce<number>(
      (sum, value) => sum + Buffer.byteLength(JSON.stringify(value)),
      0,
    ) <= observerSnapshotLimit;
    seed++
  ) {
    h.tick();
    result = await advanceCatalogObservations(h.input, result.checkpoint, h.options);
    assert.ok(result.report.requests <= 6);
  }
  legacyNotes(h.states, releaseNotes);
  const sourceTree = path.join(root, "work/upstream-observer");
  await mkdir(path.join(sourceTree, "catalog"), { recursive: true });
  await writeFile(
    path.join(sourceTree, "catalog/checkpoint.json"),
    JSON.stringify(result.checkpoint),
  );
  const originals = new Map<string, string>();
  for (const [digest, value] of h.states) {
    const bytes = JSON.stringify(value);
    assert.ok(
      Buffer.byteLength(bytes) <= observerSnapshotLimit,
      "Each original source file fits the prior per-file export bound",
    );
    originals.set(`${digest}/checkpoint.json`, bytes);
    await mkdir(path.join(sourceTree, digest), { recursive: true });
    await writeFile(path.join(sourceTree, digest, "checkpoint.json"), bytes);
  }
  const combined = [...originals.values()].reduce(
    (sum, bytes) => sum + Buffer.byteLength(bytes),
    0,
  );
  assert.ok(
    combined > observerSnapshotLimit,
    "Reproduces the live aggregate overflow, rather than one oversized synthetic file",
  );
  const snapshot = await collectObserverSnapshot(root, "c".repeat(64), {
    run: 101,
    attempt: 1,
    source: "a".repeat(40),
  });
  const encoded = encodeObserverSnapshot(snapshot, Date.now() + 60000);
  assert.ok(encoded.decoded_bytes > observerSnapshotLimit);
  assert.ok(encoded.bytes.length <= observerSnapshotLimit);
  assert.equal(encoded.checkpoint_files, originals.size + 1);
  for (const [name, bytes] of originals)
    assert.equal(
      await readFile(path.join(sourceTree, name), "utf8"),
      bytes,
      "Export never edits the source cache",
    );
  const recovered = readObserverSnapshotArchive(
    createAuditZip([["checkpoint.json", encoded.bytes]]),
    "c".repeat(64),
    Date.now(),
    Date.now() + 60000,
  );
  assert.deepEqual(recovered, snapshot);
  await rm(sourceTree, { recursive: true });
  h.states.clear();
  await publishObserverSnapshot(root, recovered);
  for (const [name, bytes] of originals) {
    assert.equal(
      await readFile(path.join(sourceTree, name), "utf8"),
      bytes,
      "All accepted page bodies and digests survive byte-for-byte",
    );
    h.states.set(name.split("/")[0]!, JSON.parse(bytes) as unknown);
  }
  // Match the live file-count shape, including valid retained configurations.
  // These inert historical budgets alter only configuration identity; accepted
  // provider pages, clocks and cursors are retained and independently validated.
  const sourceProgress = Object.values(result.checkpoint.sources).find(
    (progress) =>
      progress.current_config &&
      Buffer.byteLength(JSON.stringify(h.states.get(observationHash(progress.current_config)))) >
        1024 * 1024,
  )!;
  const originalConfig = sourceProgress.current_config!;
  const originalHash = observationHash(originalConfig);
  const sourceBytes = JSON.stringify(h.states.get(originalHash));
  const extra = 350 - originals.size;
  for (let i = 0; i < extra; i++) {
    const retained = validateObserverConfig({
      ...originalConfig,
      budget: { ...originalConfig.budget, duration_ms: 180000 - i - 1 },
    });
    const hash = observationHash(retained);
    const value: unknown =
      i < 10
        ? JSON.parse(sourceBytes.replaceAll(originalHash, hash))
        : {
            format: 1,
            config_sha256: hash,
            completed_runs: 0,
            first_complete_at: null,
            last_complete: null,
            exception: null,
          };
    validateObserverCheckpoint(value, retained);
    sourceProgress.retired_configs.push(retained);
    const bytes = JSON.stringify(value);
    originals.set(`${hash}/checkpoint.json`, bytes);
    await mkdir(path.join(sourceTree, hash), { recursive: true });
    await writeFile(path.join(sourceTree, hash, "checkpoint.json"), bytes);
  }
  await writeFile(
    path.join(sourceTree, "catalog/checkpoint.json"),
    JSON.stringify(result.checkpoint),
  );
  const largeRawBytes = [...originals.values()].reduce(
    (sum, value) => sum + Buffer.byteLength(value),
    0,
  );
  assert.ok(largeRawBytes > observerCheckpointByteLimit);
  assert.equal(originals.size + 1, 351);
  await assert.rejects(
    collectObserverSnapshot(root, "c".repeat(64), { run: 102, attempt: 1, source: "b".repeat(40) }),
    /decoded snapshot exceeds/,
  );
  let metrics: Record<string, number> = {};
  const compact = await collectCompactObserverSnapshot(
    root,
    "c".repeat(64),
    { run: 102, attempt: 1, source: "b".repeat(40) },
    Date.now(),
    Date.now() + 60000,
    (value) => {
      metrics = { ...value };
    },
  );
  assert.ok(metrics.logical_json_bytes! > observerCheckpointByteLimit);
  assert.ok(metrics.stored_json_bytes! < observerCheckpointByteLimit);
  const packed = encodeCompactObserverSnapshot(compact, Date.now() + 60000);
  assert.ok(packed.bytes.length <= observerSnapshotLimit);
  assert.ok(packed.decoded_bytes <= observerCheckpointByteLimit);
  const foreign = structuredClone(compact);
  const [firstName] = originals.keys();
  const decodedSource = decodeStoredObserverCheckpoint(foreign.files[firstName!]);
  assert.ok(isRecord(decodedSource));
  foreign.files[firstName!] = encodeStoredObserverCheckpoint({
    ...decodedSource,
    config_sha256: "0".repeat(64),
  });
  assert.throws(
    () => validateObserverSnapshot(foreign, "c".repeat(64), Date.now()),
    /different observer configuration/,
  );
  const unpacked = readObserverSnapshotArchive(
    createAuditZip([["checkpoint.json", packed.bytes]]),
    "c".repeat(64),
    Date.now(),
    Date.now() + 60000,
  );
  assert.deepEqual(unpacked, {
    ...compact,
    files: { ...compact.files, "catalog/checkpoint.json": result.checkpoint },
  });
  for (const [name, bytes] of originals)
    assert.equal(
      await readFile(path.join(sourceTree, name), "utf8"),
      bytes,
      "Compaction leaves the original cache unchanged",
    );
  await rm(sourceTree, { recursive: true });
  await publishObserverSnapshot(root, unpacked, Date.now() + 60000);
  // The compatibility collector expands stored sources. Its aggregate budget
  // must stop before decoding later files, rather than counting compressed bytes
  // and only refusing after an oversized graph has already been materialized.
  const lastName = [...originals.keys()].at(-1)!;
  const lastPath = path.join(sourceTree, lastName);
  const lastStored = await readFile(lastPath);
  await writeFile(lastPath, "invalid later input");
  await assert.rejects(
    collectObserverSnapshot(root, "c".repeat(64), { run: 103, attempt: 1, source: "d".repeat(40) }),
    /decoded snapshot exceeds checkpoint read envelope/,
  );
  assert.equal(await readFile(lastPath, "utf8"), "invalid later input");
  await writeFile(lastPath, lastStored);
  const cacheRead = await recoverObserverCheckpoint({
    root,
    config: "c".repeat(64),
    current: { run: 103, attempt: 1, source: "d".repeat(40) },
    deadline: Date.now() + 60000,
    api: {
      read: async (route) => {
        assert.equal(
          route,
          "repos/boburning/portcove",
          "Valid compact cache must not need artifact recovery",
        );
        const body = { id: 1354613114, full_name: "boburning/portcove", default_branch: "main" };
        return {
          status: 200,
          headers: new Map(),
          body,
          bodyBytes: Buffer.byteLength(JSON.stringify(body)),
        };
      },
    },
  });
  assert.deepEqual(cacheRead, { origin: "cache", sequence: result.checkpoint.sequence });
  h.states.clear();
  for (const [name, bytes] of originals) {
    const stored: unknown = JSON.parse(await readFile(path.join(sourceTree, name), "utf8"));
    assert.equal(
      JSON.stringify(decodeStoredObserverCheckpoint(stored)),
      bytes,
      "Every complete accepted source document survives losslessly",
    );
    h.states.set(name.split("/")[0]!, stored);
  }
  console.log(
    JSON.stringify({
      fixture: "live-shaped-351-file-aggregate",
      ...metrics,
      artifact_bytes: packed.bytes.length,
    }),
  );
  let state = result.checkpoint;
  const sequenceBefore = state.sequence;
  if (!result.report.pending_source_keys.length) {
    h.advanceClock(7 * 3600000);
    h.bumpRelease();
  }
  for (let batch = 0; batch < 24; batch++) {
    h.tick();
    result = await advanceCatalogObservations(h.input, state, h.options);
    assert.ok(result.report.requests <= 6);
    state = result.checkpoint;
    if (!result.report.pending_source_keys.length) break;
  }
  assert.equal(result.report.pending_source_keys.length, 0);
  assert.ok(state.sequence > sequenceBefore);
  console.log(
    JSON.stringify({
      fixture: "production-shaped-checkpoint-encoding",
      checkpoint_files: encoded.checkpoint_files,
      decoded_bytes: encoded.decoded_bytes,
      artifact_bytes: encoded.bytes.length,
      artifact_byte_limit: observerStreamingSnapshotLimit,
    }),
  );
});

void test("419 source records stream globally when nested compressed snapshots exceed four MiB", async (t) => {
  const root = await mkdtemp(
    path.join(fileURLToPath(new URL("../work/", import.meta.url)), "catalog-record-snapshot-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness(),
    fetchOriginal = h.options.fetch!;
  const entropy = Array.from({ length: 650 }, (_, i) => observationHash({ release_note: i })).join(
    "",
  );
  const notes = entropy + "Preserve original provider metadata and continuation. ".repeat(1000);
  h.options.fetch = async (url, options) => {
    const response = await fetchOriginal(url, options),
      body: unknown = await response.json();
    return new Response(
      JSON.stringify(
        Array.isArray(body)
          ? body.map((release: unknown) => {
              assert.ok(isRecord(release));
              return { ...release, body: notes };
            })
          : body,
      ),
      { headers: response.headers },
    );
  };
  const result = await advanceCatalogObservations(h.input, null, h.options);
  legacyNotes(h.states, notes, true);
  const progress = Object.values(result.checkpoint.sources).find(
    (p) => p.current_config && h.states.has(observationHash(p.current_config)),
  )!;
  const sourceConfig = progress.current_config!,
    originalHash = observationHash(sourceConfig);
  const originalBytes = JSON.stringify(h.states.get(originalHash));
  const sourceTree = path.join(root, "work/upstream-observer");
  const originals = new Map<string, string>();
  await mkdir(path.join(sourceTree, "catalog"), { recursive: true });
  for (const [hash, value] of h.states) {
    const bytes = JSON.stringify(value);
    originals.set(`${hash}/checkpoint.json`, observationHash(value));
    await mkdir(path.join(sourceTree, hash), { recursive: true });
    await writeFile(path.join(sourceTree, hash, "checkpoint.json"), bytes);
  }
  for (let i = 0, extra = 418 - originals.size; i < extra; i++) {
    const retained = validateObserverConfig({
      ...sourceConfig,
      budget: { ...sourceConfig.budget, duration_ms: 180000 - i - 1 },
    });
    const hash = observationHash(retained),
      value: unknown = JSON.parse(originalBytes.replaceAll(originalHash, hash));
    validateObserverCheckpoint(value, retained);
    progress.retired_configs.push(retained);
    originals.set(`${hash}/checkpoint.json`, observationHash(value));
    await mkdir(path.join(sourceTree, hash), { recursive: true });
    await writeFile(path.join(sourceTree, hash, "checkpoint.json"), JSON.stringify(value));
  }
  await writeFile(
    path.join(sourceTree, "catalog/checkpoint.json"),
    JSON.stringify(result.checkpoint),
  );
  let metrics: Record<string, number> = {};
  const compact = await collectCompactObserverSnapshot(
    root,
    "c".repeat(64),
    { run: 110, attempt: 1, source: "a".repeat(40) },
    Date.now(),
    Date.now() + 60000,
    (m) => {
      metrics = { ...m };
    },
  );
  assert.equal(Object.keys(compact.files).length, 419);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < observerCheckpointByteLimit);
  assert.throws(
    () => encodeCompactObserverSnapshot(compact, Date.now() + 60000),
    /larger|envelope|buffer/i,
  );
  const encoded = await encodeStreamingObserverSnapshot(compact, Date.now() + 60000);
  const archive = createAuditZip([["checkpoint.json", encoded.bytes]]);
  assert.ok(archive.length <= observerSnapshotLimit);
  const restored = await readRecoverableObserverSnapshotArchive(
    archive,
    "c".repeat(64),
    Date.now(),
    Date.now() + 60000,
  );
  const { files: compactFiles, ...scope } = compact;
  const incomplete = await encodeObserverRecords(
    (async function* () {
      yield { name: "$snapshot", bytes: Buffer.from(JSON.stringify(scope)) };
      yield {
        name: "catalog/checkpoint.json",
        bytes: Buffer.from(
          JSON.stringify(decodeStoredObserverCheckpoint(compactFiles["catalog/checkpoint.json"])),
        ),
      };
    })(),
    {
      member: observerSnapshotLimit - 16384,
      record: observerCheckpointByteLimit,
      records: 1000,
      deadline: Date.now() + 60000,
    },
  );
  await assert.rejects(
    readRecoverableObserverSnapshotArchive(
      createAuditZip([["checkpoint.json", incomplete.bytes]]),
      "c".repeat(64),
      Date.now(),
      Date.now() + 60000,
    ),
    /referenced complete checkpoint missing/,
  );
  for (const [name, expected] of originals)
    assert.equal(observationHash(decodeStoredObserverCheckpoint(restored.files[name])), expected);
  await rm(sourceTree, { recursive: true });
  await publishObserverSnapshot(root, restored, Date.now() + 60000);
  h.states.clear();
  for (const name of originals.keys())
    h.states.set(
      name.split("/")[0]!,
      JSON.parse(await readFile(path.join(sourceTree, name), "utf8")) as unknown,
    );
  const continued = await advanceCatalogObservations(
    h.input,
    JSON.parse(await readFile(path.join(sourceTree, "catalog/checkpoint.json"), "utf8")),
    h.options,
  );
  assert.deepEqual(continued.checkpoint.sources, result.checkpoint.sources);
  console.log(
    JSON.stringify({
      fixture: "419-record-global-compression",
      ...metrics,
      framed_bytes: encoded.logical_transfer_bytes,
      member_bytes: encoded.bytes.length,
      archive_bytes: archive.length,
    }),
  );
});

void test("format four collects and restores a named stored graph above the legacy allowance", async (t) => {
  const root = await mkdtemp(
    path.join(fileURLToPath(new URL("../work/", import.meta.url)), "catalog-full-graph-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness();
  const { checkpoint } = await advanceCatalogObservations(h.input, null, h.options);
  const progress = Object.values(checkpoint.sources).find(
    (entry) => entry.current_config && h.states.has(observationHash(entry.current_config)),
  )!;
  const source = progress.current_config!;
  const sourceHash = observationHash(source);
  const sourceBytes = JSON.stringify(h.states.get(sourceHash));
  const tree = path.join(root, "work/upstream-observer");
  await mkdir(path.join(tree, "catalog"), { recursive: true });
  for (const [hash, value] of h.states) {
    await mkdir(path.join(tree, hash), { recursive: true });
    await writeFile(path.join(tree, hash, "checkpoint.json"), JSON.stringify(value));
  }

  // Incompressible per source and repeated across the stream, so the stored
  // graph crosses the old limit while each record and archive remain bounded.
  const entropy = Buffer.from(
    Array.from({ length: 13500 }, (_, block) => observationHash({ block })).join(""),
    "hex",
  ).toString("base64");
  for (let index = 0; index < 64; index++) {
    const retained = validateObserverConfig({
      ...source,
      budget: { ...source.budget, duration_ms: 180000 - index - 1 },
    });
    const hash = observationHash(retained);
    const value: unknown = JSON.parse(sourceBytes.replaceAll(sourceHash, hash));
    assert.ok(isRecord(value) && isRecord(value.last_complete));
    assert.ok(isRecord(value.last_complete.projection));
    value.last_complete.projection.fixture_entropy = entropy;
    progress.retired_configs.push(retained);
    await mkdir(path.join(tree, hash), { recursive: true });
    await writeFile(path.join(tree, hash, "checkpoint.json"), JSON.stringify(value));
  }
  await writeFile(path.join(tree, "catalog/checkpoint.json"), JSON.stringify(checkpoint));
  const producer = { run: 119, attempt: 1, source: "a".repeat(40) };
  const configuration = "c".repeat(64);
  let metrics: Record<string, number> = {};
  const snapshot = await collectFactObserverSnapshot(
    root,
    configuration,
    producer,
    Date.now(),
    Date.now() + 60000,
    (value) => {
      metrics = { ...value };
    },
  );
  const graphBytes = Buffer.byteLength(JSON.stringify(snapshot));
  assert.ok(graphBytes > observerCheckpointByteLimit && graphBytes <= observerStreamingGraphLimit);
  assert.equal(metrics.stored_graph_bytes, graphBytes);
  const storedJsonBytes = metrics.stored_json_bytes;
  assert.ok(typeof storedJsonBytes === "number" && graphBytes > storedJsonBytes);
  assert.throws(
    () => encodeCompactObserverSnapshot(snapshot, Date.now() + 60000),
    /decoded snapshot exceeds checkpoint read envelope/,
  );
  const encoded = await encodeStreamingObserverSnapshot(snapshot, Date.now() + 60000);
  assert.equal(encoded.decoded_bytes, graphBytes);
  const archive = createAuditZip([["checkpoint.json", encoded.bytes]]);
  assert.ok(archive.length <= observerStreamingSnapshotLimit);
  const restored = await readRecoverableObserverSnapshotArchive(
    archive,
    configuration,
    Date.now(),
    Date.now() + 60000,
  );
  assert.deepEqual(restored, snapshot);
  await rm(tree, { recursive: true });
  await publishObserverSnapshot(root, restored, Date.now() + 60000);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(tree, "catalog/checkpoint.json"), "utf8")),
    checkpoint,
  );
  const lastName = `${observationHash(progress.retired_configs.at(-1)!)}/checkpoint.json`;
  const retainedRecord = decodeStoredObserverCheckpoint(
    JSON.parse(await readFile(path.join(tree, lastName), "utf8")),
  );
  assert.ok(isRecord(retainedRecord) && isRecord(retainedRecord.last_complete));
  assert.ok(isRecord(retainedRecord.last_complete.projection));
  assert.equal(retainedRecord.last_complete.projection.fixture_entropy, entropy);
});

const factGrowthTest =
  "fact-only recovery supports 1295 distinct pending sources plus retained configurations within unchanged limits";
// Two snapshot round trips and the legacy refusal share one fixture deadline.
void test(factGrowthTest, { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(
    path.join(fileURLToPath(new URL("../work/", import.meta.url)), "catalog-fact-growth-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness(4);
  const seeded = await advanceCatalogObservations(h.input, null, h.options);
  const template = Object.values(seeded.checkpoint.sources).find(
    (source) => source.current_config && h.states.has(observationHash(source.current_config)),
  )!;
  const templateConfig = template.current_config!,
    templateHash = observationHash(templateConfig);
  const templateSource = h.states.get(templateHash);
  assert.ok(isRecord(templateSource) && isRecord(templateSource.continuation));
  // Seed a second accepted collection page from the maintained provider fixture;
  // this regression measures graph persistence, not request admission.
  const releaseRows = [release(2, { tag_name: "rolling" }), release(1)];
  objectRecord(templateSource.continuation.pages)[
    `https://api.github.com/repos/${templateConfig.repository}/releases?per_page=100&page=1`
  ] = {
    etag: '"fixture-release-page"',
    link: "",
    body: releaseRows,
    sha256: observationHash(releaseRows),
  };
  objectRecord(templateSource.continuation.consumed).requests = 2;
  assert.ok(Object.keys(objectRecord(templateSource.continuation.pages)).length >= 2);
  const controller = structuredClone(seeded.checkpoint);
  controller.sources = {};
  const tree = path.join(root, "work/upstream-observer");
  await mkdir(path.join(tree, "catalog"), { recursive: true });
  const retained = new Map<
    string,
    { hashes: Record<string, string>; position: unknown; rawHash: string }
  >();
  async function writeSource(config: typeof templateConfig, index: number) {
    const hash = observationHash(config);
    const source = JSON.parse(
      JSON.stringify(templateSource)
        .replaceAll(templateHash, hash)
        .replaceAll(templateConfig.repository, config.repository),
    ) as Record<string, unknown>;
    if (isRecord(source.exception)) {
      source.exception.repository_id = config.repository_id;
      source.exception.key = observationHash({
        port_id: config.port_id,
        repository_id: config.repository_id,
        operation: "observe",
        rule: source.exception.rule,
      });
    }
    const continuation = objectRecord(source.continuation),
      pages = objectRecord(continuation.pages);
    const notes =
      Array.from({ length: 128 }, (_, block) => observationHash({ index, block })).join("") +
      "unused release notes and author metadata. ".repeat(900);
    for (const [url, value] of Object.entries(pages)) {
      const page = objectRecord(value);
      if (new URL(url).pathname === `/repos/${config.repository}`)
        objectRecord(page.body).id = config.repository_id;
      if (Array.isArray(page.body))
        page.body = page.body.map((row: unknown) => ({
          ...objectRecord(row),
          body: notes,
          author: { login: `author-${index}` },
        }));
      delete page.representation;
      delete page.facts_sha256;
      page.sha256 = observationHash(page.body);
    }
    validateObserverCheckpoint(source, config);
    const { pages: _pages, ...position } = continuation;
    const bytes = JSON.stringify(source),
      name = `${hash}/checkpoint.json`;
    retained.set(name, {
      position,
      hashes: Object.fromEntries(
        Object.entries(pages).map(([url, page]) => [url, String(objectRecord(page).sha256)]),
      ),
      rawHash: observationHash(source),
    });
    await mkdir(path.join(tree, hash), { recursive: true });
    await writeFile(path.join(tree, name), bytes);
  }
  async function snapshot(stage: string) {
    await writeFile(path.join(tree, "catalog/checkpoint.json"), JSON.stringify(controller));
    let metrics: Record<string, number> = {};
    const value = await collectFactObserverSnapshot(
      root,
      "c".repeat(64),
      { run: 120, attempt: 1, source: "a".repeat(40) },
      Date.now(),
      Date.now() + 60000,
      (m) => {
        metrics = { ...m };
      },
    );
    const encoded = await encodeStreamingObserverSnapshot(value, Date.now() + 60000);
    assert.ok(
      encoded.bytes.length < observerSnapshotLimit / 2,
      "full modeled catalog retains substantial headroom within the old cap",
    );
    const restored = await readRecoverableObserverSnapshotArchive(
      createAuditZip([["checkpoint.json", encoded.bytes]]),
      "c".repeat(64),
      Date.now(),
      Date.now() + 60000,
    );
    const storedController = restored.files["catalog/checkpoint.json"];
    assert.ok(
      Buffer.byteLength(JSON.stringify(storedController)) < metrics.controller_bytes!,
      "controller compaction leaves room in the stored graph",
    );
    assert.deepEqual(decodeStoredObserverCheckpoint(storedController), controller);
    for (const [name, expected] of retained) {
      const source = objectRecord(decodeStoredObserverCheckpoint(restored.files[name]));
      const { pages, ...position } = objectRecord(source.continuation);
      assert.deepEqual(position, expected.position);
      for (const [url, hash] of Object.entries(expected.hashes)) {
        const page = objectRecord(objectRecord(pages)[url]);
        assert.equal(page.sha256, hash);
        assert.equal(page.representation, "observer-facts-v1");
        assert.equal(page.facts_sha256, observationHash(page.body));
      }
      assert.equal(
        observationHash(JSON.parse(await readFile(path.join(tree, name), "utf8"))),
        expected.rawHash,
        "export preserves original cache files",
      );
    }
    console.log(
      JSON.stringify({
        fixture: "distinct-source-fact-growth",
        stage,
        ...metrics,
        member_bytes: encoded.bytes.length,
      }),
    );
    return encoded.bytes.length;
  }
  function objectRecord(value: unknown): Record<string, unknown> {
    assert.ok(isRecord(value));
    return value;
  }
  // The modeled population is the one release-text budgets are shared by.
  assert.equal(modeledCatalogSources, 1295);
  for (let index = 0; index < modeledCatalogSources; index++) {
    const repository = `fixture/repository-${index}`;
    const config = validateObserverConfig({
      ...templateConfig,
      repository,
      repository_id: 10000 + index,
    });
    const progress = structuredClone(template);
    progress.repository = repository;
    progress.repository_id = config.repository_id;
    progress.current_config = config;
    progress.last_complete_config = null;
    progress.retired_configs = [];
    progress.selection_progress = null;
    progress.policy_progress = null;
    controller.sources[observationHash({ provider: "github", repository })] = progress;
    await writeSource(config, index);
    if (index === 558) await snapshot("560-files");
    if (index >= 559 && index % 3 === 0) {
      const historical = validateObserverConfig({
        ...config,
        budget: { ...config.budget, duration_ms: config.budget.duration_ms - 1 },
      });
      progress.retired_configs.push(historical);
      await writeSource(historical, index);
    }
  }
  const projectedBytes = await snapshot("1295-sources-plus-retained-configurations");
  const unprojected = await collectCompactObserverSnapshot(
    root,
    "c".repeat(64),
    { run: 121, attempt: 1, source: "b".repeat(40) },
    Date.now(),
    Date.now() + 60000,
  );
  const encoded = await encodeStreamingObserverSnapshot(unprojected, Date.now() + 60000);
  assert.ok(encoded.bytes.length > observerSnapshotLimit);
  assert.ok(projectedBytes < encoded.bytes.length);
});

void test("reviewed declarations share provider collection while keeping port-specific Core projections and unsupported holds", async () => {
  const h = harness();
  const plan = catalogObservationSources(h.input);
  assert.equal(plan.sources.length, 2);
  assert.equal(
    plan.sources.find((source) => source.repository === "owner/shared")!.ports.length,
    2,
  );
  assert.match(plan.held[0]!.reason, /user-prepared/);
  const result = await advanceCatalogObservations(h.input, null, h.options);
  assert.equal(result.report.completed_source_keys.length, 2);
  assert.equal(result.report.global_eligibility, "not-assessed");
  const shared = h.exported.find(([source]) => source.repository === "owner/shared")!;
  assert.equal(shared[3].length, 2);
  assert.deepEqual(shared[2].report.observation!.coverage, {
    kind: "channel-candidate-assets",
    complete_release_headers: true,
    asset_release_ids: [1, 2],
  });
  assert.equal(
    h.network.filter((url) => url.endsWith("/owner/shared/releases?per_page=100&page=1")).length,
    2,
  );
  assert.ok(
    h.snapshots.some(
      (value) =>
        value.sequence > 0 &&
        Object.values(value.sources).some((source) => source.completed_at === null),
    ),
  );
});

const gameEntryFixture = `std::vector<recomp::GameEntry> supported_games = {
  { .rom_hash = 0x0123456789ABCDEFULL, .game_id = u8"fixture.us", .mod_game_id = "fixture",
    .ignored = callback(1, 2) },
  { .rom_hash = 0x1234ULL, .game_id = u8"fixture.eu" },
};`;

void test("N64 game entries require a single unconditional table and literal identities", () => {
  assert.deepEqual(parseN64GameTable("/* unused declaration */\n" + gameEntryFixture), [
    { game_id: "fixture.us", mod_game_id: "fixture", rom_hash_u64: "0123456789abcdef" },
    { game_id: "fixture.eu", mod_game_id: null, rom_hash_u64: "0000000000001234" },
  ]);
  assert.deepEqual(
    parseN64GameTable(gameEntryFixture.replace("0x0123456789ABCDEFULL", "0xafc33da7101fec88"))[0],
    { game_id: "fixture.us", mod_game_id: "fixture", rom_hash_u64: "afc33da7101fec88" },
  );
  for (const invalid of [
    `#if ENABLED
${gameEntryFixture}
#endif`,
    `/* marker */ #if 0
${gameEntryFixture}
/* marker */ #endif`,
    `#/**/if 0
${gameEntryFixture}
#/**/endif`,
    `%:if 0
${gameEntryFixture}
%:endif`,
    ["// hidden " + String.fromCharCode(92) + "   ", gameEntryFixture.replace(/\n/gu, " ")].join(
      "\n",
    ),
    ["// hidden " + String.fromCharCode(92), gameEntryFixture.replace(/\n/gu, " ")].join("\r"),
    `/* ${gameEntryFixture} */`,
    `/* missing terminator
${gameEntryFixture}`,
    `auto s = R"(
${gameEntryFixture}
)";`,
    `${gameEntryFixture}
${gameEntryFixture}`,
    gameEntryFixture.replace("0x1234ULL", "PLATFORM_HASH"),
    gameEntryFixture.replace("fixture.eu", "fixture.us"),
    gameEntryFixture.replace('.mod_game_id = "fixture",', '.mod_game_id = "fi" "xture",'),
    gameEntryFixture.replace(
      ".ignored = callback(1, 2)",
      `
#if ENABLED
.ignored = callback(1, 2)
#endif
`,
    ),
  ])
    assert.throws(() => parseN64GameTable(invalid), /unsupported or ambiguous/u);
});

for (const family of ["libultraship", "n64-recomp"] as const) {
  void test(`scheduled ${family} original source facts retain exact evidence across refresh and optional failure`, async () => {
    const h = harness();
    Object.assign(h.input.ports[0]!, {
      adapter: `${family}-portable`,
      source_profile: "example",
      runtime_source_filename: "user/fixture.us.z64",
      platforms: ["linux-x86-64", "windows-x86-64"],
      executable_hints: { "linux-x86-64": ["FixtureRecompiled"] },
    });
    h.input.ports.push({ ...h.input.ports[0]!, id: "stable-port-second" });
    const authoringCatalog = {
      ...h.input,
      source_catalog: {
        identities: [
          {
            id: "example",
            kind: "file",
            variants: [{ representations: [{ kind: "canonical-n64" }] }],
          },
        ],
        evidence: [],
        contracts: [
          {
            id: "example-game",
            port_id: "stable-port",
            profile_id: "example",
            role: "game",
            admission_mode: "enforced",
            supported_variant_ids: ["legacy-accepted"],
          },
        ],
      },
    };
    const baseProject = h.options.project;
    let unavailable: "budget" | "rate-limit" | null = null;
    let additionalPlatform = false;
    let outputExpired = false;
    h.options.project = async (portId, repositoryId, observation) => {
      const policy = await baseProject(portId, repositoryId, observation);
      if (
        portId !== "stable-port" &&
        !(portId === "stable-port-second" && unavailable === "rate-limit")
      )
        return policy;
      const release = observation.facts.releases.find((release) => release.id === 1);
      assert.ok(release);
      return {
        ...(policy as Record<string, unknown>),
        projections: [
          {
            channel: "stable",
            platform: "linux-x86-64",
            channel_candidate: { id: 1, tag: release.tag_name },
            latest_eligible: {
              release_id: 1,
              release: { version: release.tag_name, asset: { sha256: "a".repeat(64) } },
            },
          },
          ...(additionalPlatform
            ? [
                {
                  channel: "stable",
                  platform: "windows-x86-64",
                  channel_candidate: { id: 1, tag: release.tag_name },
                  latest_eligible: {
                    release_id: 1,
                    release: { version: release.tag_name, asset: { sha256: "b".repeat(64) } },
                  },
                },
              ]
            : []),
        ],
      };
    };
    const raw = Buffer.from(
      family === "n64-recomp"
        ? gameEntryFixture
        : JSON.stringify([{ name: "Fixture", sha1: "b".repeat(40) }]),
    );
    const sourcePath = family === "n64-recomp" ? n64GameTablePath : "docs/supportedHashes.json";
    const requests: string[] = [];
    const runtimeRequests: string[] = [];
    const buildRequests: string[] = [];
    const jobLogs: [number, number][] = [];
    const run = {
      id: 70,
      repository: { id: 7 },
      head_repository: { id: 7 },
      head_sha: "c".repeat(40),
      event: "push",
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      workflow_id: 71,
      path: ".github/workflows/release.yml",
      run_started_at: "2026-10-26T12:00:00Z",
      updated_at: "2026-10-26T12:05:00Z",
    };
    h.options.observeN64Runtime = family === "n64-recomp";
    let gitlinkResponse: "deferred" | "incomplete" | "unsupported" = "deferred";
    let tagSha = "c".repeat(40);
    let retryAt: string | null = null;
    h.options.readOriginalRecognition = async (repository, endpoint, account) => {
      account.admitRequest();
      if (endpoint.includes(`/contents/${n64RuntimeLinkPath}`)) {
        runtimeRequests.push(endpoint);
        if (gitlinkResponse === "deferred")
          throw new ObservationFailure("budget", "fixture runtime metadata deferred");
        return gitlinkResponse === "incomplete"
          ? { path: n64RuntimeLinkPath, type: "submodule" }
          : { path: n64RuntimeLinkPath, type: "dir", sha: "4".repeat(40) };
      }
      if (endpoint.includes("/actions/runs")) {
        buildRequests.push(endpoint);
        if (endpoint.includes("head_sha=")) return { total_count: 1, workflow_runs: [run] };
        if (endpoint.includes("/attempts/1/jobs?"))
          return {
            total_count: 1,
            jobs: [
              {
                id: 77,
                run_id: 70,
                run_attempt: 1,
                head_sha: run.head_sha,
                status: "completed",
                conclusion: "success",
                steps: [
                  { number: 2, name: "Checkout", status: "completed", conclusion: "success" },
                  {
                    number: 10,
                    name: "Build FixtureRecompiled",
                    status: "completed",
                    conclusion: "success",
                  },
                  {
                    number: 12,
                    name: "Archive game",
                    status: "completed",
                    conclusion: "success",
                    started_at: "2026-10-26T12:03:00Z",
                    completed_at: "2026-10-26T12:04:00Z",
                  },
                ],
              },
            ],
          };
        if (!endpoint.includes("/artifacts?")) return run;
        return {
          total_count: 1,
          artifacts: [
            {
              id: 72,
              digest: "sha256:" + "a".repeat(64),
              expired: outputExpired,
              size_in_bytes: 1024,
              created_at: "2026-10-26T12:04:00Z",
              workflow_run: {
                id: 70,
                repository_id: 7,
                head_repository_id: 7,
                head_sha: run.head_sha,
              },
            },
          ],
        };
      }
      requests.push(endpoint);
      if (unavailable)
        throw new ObservationFailure(unavailable, "fixture metadata deferred", retryAt);
      const ref = endpoint.split("/git/ref/tags/")[1];
      if (ref !== undefined)
        return {
          ref: `refs/tags/${ref}`,
          object: { type: "commit", sha: tagSha },
        };
      if (endpoint.includes("/contents/"))
        return {
          type: "file",
          path: sourcePath,
          encoding: "base64",
          size: raw.length,
          content: raw.toString("base64"),
          sha: createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex"),
        };
      return { id: 7, full_name: repository };
    };
    const retained = (checkpoint: CatalogObserverCheckpoint) => {
      const source = Object.values(checkpoint.sources).find(
        (source) => source.repository === "owner/shared",
      );
      const policy = source?.last_complete_policies.find(
        (policy) => policy.port_id === "stable-port",
      );
      return readOriginalSourceProgress(
        policy?.[inputEvidenceKey(family)],
        {
          repository: "owner/shared",
          repository_id: 7,
        },
        family,
      );
    };
    const initial = await advanceCatalogObservations(authoringCatalog, null, h.options);
    let observation = retained(initial.checkpoint);
    assert.equal(observation?.state, "observed");
    const fact = observation?.last_complete?.fact;
    assert.equal(fact?.release_tag, "v1.0.0");
    assert.equal(
      fact?.coverage,
      family === "n64-recomp" ? "source-declaration" : "recognition-only",
    );
    assert.ok(
      requests.some((endpoint) => endpoint.endsWith(`/contents/${sourcePath}?ref=${tagSha}`)),
    );
    const stored = upstreamFacts(initial.checkpoint, authoringCatalog, h.options.now!()).facts;
    const port = stored.get("port:stable-port");
    assert.ok(isRecord(port) && Array.isArray(port.sources) && isRecord(port.sources[0]));
    assert.deepEqual(port.sources[0][inputEvidenceKey(family)], observation);
    assert.equal(requests.length, 4);

    h.advanceClock(48 * 3600_000);
    gitlinkResponse = "incomplete";
    let refreshed = await advanceCatalogObservations(
      authoringCatalog,
      initial.checkpoint,
      h.options,
    );
    let extraTagReads = 0;
    if (family === "n64-recomp") {
      assert.ok(fact?.parser === "n64-recomp-game-entry-v1");
      assert.deepEqual(fact.runtime_source, { state: "unavailable" });
      assert.deepEqual(retained(refreshed.checkpoint)?.last_complete, observation?.last_complete);
      h.advanceClock(48 * 3600_000);
      gitlinkResponse = "unsupported";
      refreshed = await advanceCatalogObservations(
        authoringCatalog,
        refreshed.checkpoint,
        h.options,
      );
      extraTagReads++;
      assert.deepEqual(runtimeRequests, [
        `/repos/owner/shared/contents/${n64RuntimeLinkPath}?ref=${tagSha}`,
        `/repos/owner/shared/contents/${n64RuntimeLinkPath}?ref=${tagSha}`,
        `/repos/owner/shared/contents/${n64RuntimeLinkPath}?ref=${tagSha}`,
      ]);
      const refreshedObservation = retained(refreshed.checkpoint);
      const refreshedFact = refreshedObservation?.last_complete?.fact;
      assert.deepEqual(refreshedFact, {
        ...fact,
        runtime_source: { state: "unsupported-gitlink" },
      });
      observation = refreshedObservation;
    } else {
      assert.deepEqual(retained(refreshed.checkpoint), observation);
      assert.equal(runtimeRequests.length, 0);
    }
    assert.equal(requests.length, 5 + extraTagReads);

    let previous = refreshed.checkpoint;
    if (family === "n64-recomp") {
      // Feed the same retained runtime/header receipt shape the real observer reads.
      // The unrelated synthetic game table above does not serve as runtime source.
      const retainedPolicy = Object.values(previous.sources)
        .find((source) => source.repository === "owner/shared")
        ?.last_complete_policies.find((policy) => policy.port_id === "stable-port");
      const sourceFact = observation?.last_complete?.fact;
      assert.ok(
        retainedPolicy &&
          observation?.last_complete &&
          sourceFact?.parser === "n64-recomp-game-entry-v1",
      );
      retainedPolicy[inputEvidenceKey(family)] = {
        ...observation,
        last_complete: {
          ...observation.last_complete,
          fact: {
            ...sourceFact,
            runtime_source: {
              state: "observed",
              source: {
                repository: "N64Recomp/N64ModernRuntime",
                repository_id: 802962241,
                source_path: "librecomp/src/recomp.cpp",
                revision: "a".repeat(40),
                blob_sha1: "b".repeat(40),
                source_sha256: "c".repeat(64),
                input_blocks_sha256:
                  "0c7cf4bad35b597ac6fd332cb9110907bf28ab182ab4e526bec3e641f0e21dbc",
                matched_input_blocks: "n64modernruntime-padded-xxh3-call-sites-v1",
                hash_source: {
                  state: "observed",
                  repository: "Cyan4973/xxHash",
                  repository_id: 19330466,
                  revision: "d".repeat(40),
                  headers: [
                    ["xxh3.h", "a927ee0e6e0800835baed52b16bc981ec39f46287271a1a3f77c22cc48634430"],
                    [
                      "xxhash.h",
                      "ccc7934d982bfd4f51624e7fdd93a6c40bc3d5c33f66463b54e70c21932d9129",
                    ],
                  ].map(([source_path, source_sha256]) => ({
                    source_path,
                    source_blob_sha1: "e".repeat(40),
                    source_sha256,
                  })),
                },
              },
            },
          },
        },
      };
      h.options.readN64BuildStepLog = async (repository, job, step, account) => {
        account.admitRequest();
        jobLogs.push([job, step]);
        const lines =
          step === 2
            ? [
                "##[group]Run actions/checkout@v4",
                "Syncing repository: " + repository,
                "Submodule path 'lib/N64ModernRuntime': checked out '" + "a".repeat(40) + "'",
                "Submodule path 'lib/N64ModernRuntime/thirdparty/xxHash': checked out '" +
                  "d".repeat(40) +
                  "'",
                run.head_sha,
              ]
            : step === 10
              ? [
                  "[100/103] Building CXX object lib/N64ModernRuntime/librecomp/CMakeFiles/librecomp.dir/src/recomp.cpp.o",
                  "[102/103] Linking CXX static library lib/N64ModernRuntime/librecomp/liblibrecomp.a",
                  "[103/103] Linking CXX executable FixtureRecompiled",
                ]
              : [
                  "##[group]Run actions/upload-artifact@v4",
                  "SHA256 digest of uploaded artifact zip is " + "a".repeat(64),
                  "Artifact Build.zip successfully finalized. Artifact ID 72",
                  "Artifact Build has been successfully uploaded! Final size is 1024 bytes. Artifact ID is 72",
                ];
        const bytes = Buffer.from(lines.map((line) => "2026-10-26T12:04:00Z " + line).join("\r\n"));
        account.consumeResponseBytes(bytes.byteLength);
        return bytes;
      };
      h.advanceClock(48 * 3600_000);
      previous = (await advanceCatalogObservations(authoringCatalog, previous, h.options))
        .checkpoint;
      extraTagReads++;
      observation = retained(previous);
      const built = observation?.last_complete?.fact;
      assert.ok(built?.parser === "n64-recomp-game-entry-v1");
      assert.deepEqual(
        built.build_outputs?.matches.map((match) => match.artifact_id),
        [72],
      );
      assert.equal(built.build_outputs?.search, null);
      assert.equal(buildRequests.length, 4);
      assert.deepEqual(jobLogs, [
        [77, 12],
        [77, 2],
      ]);
      assert.deepEqual(
        built.build_jobs?.matches.map((match) => match.job_id),
        [77],
      );
      const projected = upstreamFacts(previous, authoringCatalog, h.options.now!()).facts.get(
        "port:stable-port",
      );
      assert.ok(
        isRecord(projected) && Array.isArray(projected.sources) && isRecord(projected.sources[0]),
      );
      assert.deepEqual(projected.sources[0][inputEvidenceKey(family)], observation);

      h.advanceClock(48 * 3600_000);
      previous = (await advanceCatalogObservations(authoringCatalog, previous, h.options))
        .checkpoint;
      extraTagReads++;
      observation = retained(previous);
      const compiled = observation?.last_complete?.fact;
      assert.ok(compiled?.parser === "n64-recomp-game-entry-v1");
      assert.equal(compiled.build_jobs?.matches[0]?.compile?.executable, "FixtureRecompiled");
      assert.deepEqual(jobLogs, [
        [77, 12],
        [77, 2],
        [77, 10],
      ]);
      const readProjectedSource = (catalog: unknown) => {
        const projectedBinding = upstreamFacts(previous, catalog, h.options.now!()).facts.get(
          "port:stable-port",
        );
        assert.ok(
          isRecord(projectedBinding) &&
            Array.isArray(projectedBinding.sources) &&
            isRecord(projectedBinding.sources[0]),
        );
        return projectedBinding.sources[0];
      };
      const plan = readProjectedSource(authoringCatalog).n64_original_binding_plan;
      assert.ok(isRecord(plan));
      assert.equal(plan.authority, "authoring-input-only");
      assert.equal(plan.n64_recomp_inputs_v1, undefined);
      assert.deepEqual(plan.platforms, [
        {
          platform: "linux-x86-64",
          artifact_sha256: "a".repeat(64),
          build_job_id: 77,
          state: "legacy-contract-migration-required",
          proposed_input: {
            upstream_ref: "v1.0.0",
            artifact_sha256: "a".repeat(64),
            game_id: "fixture.us",
            rom_xxh3_64: "0123456789abcdef",
          },
        },
        { platform: "windows-x86-64", state: "no-current-artifact" },
      ]);
      const migratedSources = {
        ...authoringCatalog.source_catalog,
        contracts: authoringCatalog.source_catalog.contracts.map((contract) => ({
          ...contract,
          n64_recomp_inputs_v1: [
            {
              upstream_ref: "older",
              artifact_sha256: "c".repeat(64),
              game_id: "fixture.us",
              rom_xxh3_64: "1111111111111111",
            },
          ],
        })),
      };
      const port = authoringCatalog.ports[0];
      assert.ok(observation?.last_complete && port);
      const migratedScope = n64AuthoringScope(port, migratedSources);
      assert.ok(migratedScope);
      const migratedPlan = planN64OriginalBindings(port, migratedSources, {
        ...observation,
        last_complete: {
          ...observation.last_complete,
          fact: {
            ...compiled,
            authoring_scope_sha256: migratedScope,
          },
        },
      });
      assert.equal(migratedPlan?.platforms[0]?.state, "awaiting-effective-build-proof");
      const successorObservation = {
        ...observation,
        last_complete: {
          ...observation.last_complete,
          fact: { ...compiled, authoring_scope_sha256: migratedScope },
        },
      };
      assert.equal(
        readProjectedSource(authoringCatalog).n64_original_contract_amendment,
        undefined,
      );
      const runtime =
        compiled.runtime_source?.state === "observed" ? compiled.runtime_source.source : undefined;
      const hash = runtime?.hash_source?.state === "observed" ? runtime.hash_source : undefined;
      const job = compiled.build_jobs?.matches[0];
      assert.ok(runtime && hash && job?.compile);
      const receipt = {
        repository_id: compiled.repository_id,
        release_id: compiled.release_id,
        source_commit: compiled.source_commit,
        source_blob_sha1: compiled.source_blob_sha1,
        runtime_revision: runtime.revision,
        hash_revision: hash.revision,
        game_id: "fixture.us",
        rom_xxh3_64: "0123456789abcdef",
        review_url: "https://example.com/package-review",
        reviewed_at: "2026-10-26",
        packages: [
          {
            platform: "linux-x86-64",
            layout_sha256: n64PackagedInputLayout(port, "linux-x86-64"),
            artifact_sha256: "a".repeat(64),
            job_id: job.job_id,
            compile_sha256: job.compile.log_sha256,
            executable_sha256: "e".repeat(64),
          },
        ],
      };
      const amendment = prepareN64OriginalContractAmendment(
        port,
        migratedSources,
        successorObservation,
        [port],
        [receipt],
      );
      assert.equal(amendment?.requires_reader, 11);
      assert.equal(amendment?.contract_id, "example-game");
      assert.equal(amendment?.upstream_support_evidence.role, "upstream_support");
      assert.deepEqual(amendment?.n64_recomp_inputs_v1, [
        ...migratedSources.contracts[0]!.n64_recomp_inputs_v1,
        {
          upstream_ref: "v1.0.0",
          artifact_sha256: "a".repeat(64),
          game_id: "fixture.us",
          rom_xxh3_64: "0123456789abcdef",
        },
      ]);
      const sharedPackage = {
        ...successorObservation,
        last_complete: {
          ...successorObservation.last_complete,
          fact: {
            ...successorObservation.last_complete.fact,
            artifacts: [
              ...compiled.artifacts,
              { platform: "windows-x86-64", sha256: "a".repeat(64) },
            ],
          },
        },
      };
      assert.equal(
        prepareN64OriginalContractAmendment(
          port,
          migratedSources,
          sharedPackage,
          [port],
          [receipt],
        ),
        undefined,
      );
      assert.equal(
        prepareN64OriginalContractAmendment(
          port,
          migratedSources,
          successorObservation,
          [port],
          [{ ...receipt, rom_xxh3_64: "f".repeat(16) }],
        ),
        undefined,
      );

      const reobservedAmendment = (
        changedPort: typeof port & Record<string, unknown>,
        changedSources: typeof migratedSources,
        consumers: readonly unknown[] = [changedPort],
      ) =>
        prepareN64OriginalContractAmendment(
          changedPort,
          changedSources,
          {
            ...successorObservation,
            last_complete: {
              ...successorObservation.last_complete,
              fact: {
                ...compiled,
                authoring_scope_sha256: n64AuthoringScope(changedPort, changedSources)!,
              },
            },
          },
          consumers,
          [receipt],
        );
      assert.equal(
        reobservedAmendment(
          {
            ...port,
            executable_hints: { "linux-x86-64": ["Alternate", "FixtureRecompiled"] },
          },
          migratedSources,
        ),
        undefined,
      );
      assert.equal(
        reobservedAmendment(
          {
            ...port,
            runtime_subdirectory: "alternate-root",
          },
          migratedSources,
        ),
        undefined,
      );
      assert.equal(
        reobservedAmendment(
          {
            ...port,
            runtime_source_materialization: "copy",
          },
          migratedSources,
        ),
        undefined,
      );
      assert.equal(
        reobservedAmendment(port, migratedSources, [
          port,
          { id: "dependent", bios_source_profile: "example" },
        ]),
        undefined,
      );
      assert.equal(
        reobservedAmendment(port, migratedSources, [port, { ...port, id: "dependent" }]),
        undefined,
      );
      const equivalentSources = {
        ...migratedSources,
        contracts: migratedSources.contracts.map((contract) => ({
          ...contract,
          n64_recomp_inputs_v1: [
            ...contract.n64_recomp_inputs_v1,
            {
              upstream_ref: "v1.0.0",
              artifact_sha256: "A".repeat(64),
              game_id: "fixture.us",
              rom_xxh3_64: "0123456789ABCDEF",
            },
          ],
        })),
      };
      assert.equal(reobservedAmendment(port, equivalentSources), undefined);
      const conflictingSources = structuredClone(equivalentSources);
      conflictingSources.contracts[0]!.n64_recomp_inputs_v1[1]!.rom_xxh3_64 = "F".repeat(16);
      assert.equal(reobservedAmendment(port, conflictingSources), undefined);
      const changedDefinition = {
        ...authoringCatalog,
        ports: authoringCatalog.ports.map((port) =>
          port.id === "stable-port"
            ? {
                ...port,
                release: { ...port.release, asset_hints: { "linux-x86-64": ["new-archive.zip"] } },
              }
            : port,
        ),
      };
      const stale = readProjectedSource(changedDefinition);
      assert.equal(stale.n64_original_binding_plan, undefined);
      assert.deepEqual(stale[inputEvidenceKey(family)], observation);
      const changedContract = {
        ...authoringCatalog,
        source_catalog: {
          ...authoringCatalog.source_catalog,
          contracts: authoringCatalog.source_catalog.contracts.map((contract) => ({
            ...contract,
            admission_mode: "informational",
          })),
        },
      };
      assert.equal(readProjectedSource(changedContract).n64_original_binding_plan, undefined);

      additionalPlatform = true;
      outputExpired = true;
      h.advanceClock(48 * 3600_000);
      previous = (await advanceCatalogObservations(authoringCatalog, previous, h.options))
        .checkpoint;
      extraTagReads += 4;
      observation = retained(previous);
      const expanded = observation?.last_complete?.fact;
      assert.ok(expanded?.parser === "n64-recomp-game-entry-v1");
      assert.deepEqual(expanded.build_outputs?.matches, built.build_outputs?.matches);
      assert.deepEqual(expanded.build_jobs?.matches, compiled.build_jobs?.matches);
      const expandedPlan = readProjectedSource(authoringCatalog).n64_original_binding_plan;
      assert.ok(isRecord(expandedPlan) && Array.isArray(expandedPlan.platforms));
      assert.deepEqual(expandedPlan.platforms[1], {
        platform: "windows-x86-64",
        artifact_sha256: "b".repeat(64),
        state: "awaiting-build",
      });
      assert.notEqual(expanded.build_outputs?.search, null);
      assert.equal(buildRequests.length, 7);
      assert.equal(jobLogs.length, 3);
    }

    h.advanceClock(48 * 3600_000);
    tagSha = "d".repeat(40);
    const moved = await advanceCatalogObservations(authoringCatalog, previous, h.options);
    assert.equal(retained(moved.checkpoint)?.state, "source-tag-changed");
    assert.deepEqual(retained(moved.checkpoint)?.last_complete, observation?.last_complete);
    assert.equal(requests.length, 6 + extraTagReads);
    assert.equal(buildRequests.length, family === "n64-recomp" ? 7 : 0);

    h.advanceClock(48 * 3600_000);
    h.bumpRelease();
    unavailable = "budget";
    const deferred = await advanceCatalogObservations(
      authoringCatalog,
      moved.checkpoint,
      h.options,
    );
    assert.equal(retained(deferred.checkpoint)?.state, "budget");
    assert.deepEqual(retained(deferred.checkpoint)?.last_complete, observation?.last_complete);
    assert.equal(deferred.report.completed_source_keys.length, 2);
    assert.equal(requests.length, 7 + extraTagReads);

    h.advanceClock(48 * 3600_000);
    unavailable = "rate-limit";
    h.setQuota(100);
    retryAt = new Date(h.options.now!() + 100_000).toISOString();
    const limited = await advanceCatalogObservations(
      authoringCatalog,
      deferred.checkpoint,
      h.options,
    );
    assert.equal(retained(limited.checkpoint)?.state, "rate-limit");
    assert.deepEqual(retained(limited.checkpoint)?.last_complete, observation?.last_complete);
    assert.equal(limited.checkpoint.provider_retry_at, retryAt);
    const secondPolicy = Object.values(limited.checkpoint.sources)
      .find((source) => source.repository === "owner/shared")
      ?.last_complete_policies.find((policy) => policy.port_id === "stable-port-second");
    assert.equal(
      readOriginalSourceProgress(
        secondPolicy?.[inputEvidenceKey(family)],
        {
          repository: "owner/shared",
          repository_id: 7,
        },
        family,
      )?.state,
      "budget",
    );
    const projected = upstreamFacts(
      limited.checkpoint,
      authoringCatalog,
      h.options.now!(),
    ).facts.get("port:stable-port");
    assert.ok(isRecord(projected) && Array.isArray(projected.sources));
    const source: unknown = projected.sources.find(
      (value: unknown) => isRecord(value) && value.repository === "owner/shared",
    );
    assert.ok(isRecord(source));
    assert.deepEqual(source[inputEvidenceKey(family)], retained(limited.checkpoint));
  });
}

void test("unknown quota admits finite batches, durable turns prevent starvation, and completed sources are not refetched", async () => {
  const h = harness(2);
  let state: CatalogObserverCheckpoint | null = null;
  const firstAttempt = new Set<string>();
  let completed = false;
  for (let batch = 0; batch < 24; batch++) {
    const before = h.network.length;
    const result = await advanceCatalogObservations(h.input, state, h.options);
    assert.ok(h.network.length - before <= 2);
    assert.equal(result.report.requests, h.network.length - before);
    state = result.checkpoint;
    for (const source of result.report.attempted_source_keys) firstAttempt.add(source);
    if (result.report.pending_source_keys.length === 0) {
      completed = true;
      break;
    }
    h.tick();
  }
  assert.equal(firstAttempt.size, 2);
  assert.equal(completed, true);
  const before = h.network.length;
  const unchanged = await advanceCatalogObservations(h.input, state, h.options);
  assert.equal(h.network.length, before);
  assert.deepEqual(unchanged.report.attempted_source_keys, []);
});

void test("a resumed opportunity gives untouched sources a turn before retrying attempted sources", async () => {
  const h = harness(2);
  const sources = catalogObservationSources(h.input).sources.sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  assert.equal(sources.length, 2);
  const [attempted, untouched] = sources;
  assert.ok(attempted && untouched);
  const first = await advanceCatalogObservations(h.input, null, {
    ...h.options,
    excludedSources: new Set([untouched.key]),
  });
  assert.deepEqual(first.report.attempted_source_keys, [attempted.key]);
  assert.equal(first.checkpoint.sources[untouched.key], undefined);
  assert.equal(first.checkpoint.sources[attempted.key]?.completed_at, null);

  const resumed = await advanceCatalogObservations(h.input, first.checkpoint, h.options);
  assert.equal(resumed.report.attempted_source_keys[0], untouched.key);
  assert.ok(resumed.report.requests <= 2);
});

void test("untouched managed sources are admitted before listing-only sources", async () => {
  const h = harness();
  const input = {
    ...h.input,
    listings: ["alpha", "beta", "gamma"].map((name) => ({
      id: `listing-${name}`,
      name: `Listing ${name}`,
      summary: "Descriptive listing",
      project_url: `https://github.com/listing-owner/${name}`,
    })),
  };
  const sources = catalogObservationSources(input).sources;
  const managed = sources.filter((source) => source.ports.some((port) => port.kind !== "listing"));
  const listingOnly = sources.filter((source) =>
    source.ports.every((port) => port.kind === "listing"),
  );
  assert.ok(managed.length > 0 && listingOnly.length === 3);
  const result = await advanceCatalogObservations(input, null, h.options);
  const order = result.report.attempted_source_keys;
  const lastManaged = Math.max(...managed.map((source) => order.indexOf(source.key)));
  const listingPositions = listingOnly
    .map((source) => order.indexOf(source.key))
    .filter((position) => position !== -1);
  assert.ok(managed.every((source) => order.includes(source.key)));
  assert.ok(listingPositions.every((position) => position > lastManaged));
});

void test("hosted recovery rotates stale sources through ordinary managed backlog", () => {
  const hour = 3_600_000;
  const now = Date.parse("2026-11-21T04:37:34.422Z");
  const clock = (age: number) => new Date(now - age * hour).toISOString();
  const turn = (
    key: string,
    attemptedSequence: number,
    freshnessObservedAt: string | null,
    managed = false,
    appointment = false,
  ) => ({ key, attemptedSequence, freshnessObservedAt, managed, appointment });
  const stale = turn("stale", 7, clock(20));
  const never = turn("never", -1, null);
  const recentlyFailed = turn("exception", 21, null);
  const ordinary = Array.from({ length: 9 }, (_, index) =>
    turn(`ordinary-${index}`, index, clock(8), true),
  );
  const candidates = [
    ...ordinary,
    recentlyFailed,
    stale,
    never,
    turn("fresh-listing", 0, clock(8)),
    turn("critical", 9, clock(11.99), true),
    turn("appointed", 30, clock(6), false, true),
  ];
  const limits = { now, deadline: now + 60_000, freshnessMs: 12 * hour };
  const order = (turns: typeof candidates) =>
    orderHostedObservationTurns(turns, limits).map(({ key }) => key);
  assert.deepEqual(order(candidates), [
    "appointed",
    "critical",
    "never",
    "ordinary-0",
    "ordinary-1",
    "ordinary-2",
    "stale",
    "ordinary-3",
    "ordinary-4",
    "ordinary-5",
    "exception",
    "ordinary-6",
    "ordinary-7",
    "ordinary-8",
    "fresh-listing",
  ]);
  assert.deepEqual(
    order(
      candidates.map((item) => (item === never ? { ...item, attemptedSequence: 32 } : item)),
    ).slice(0, 3),
    ["appointed", "critical", "stale"],
  );
});

void test("hosted listing turns protect expiring managed work and reduce purely descriptive debt", async () => {
  const h = harness();
  const input = {
    ...h.input,
    listings: ["alpha", "beta", "gamma"].map((name) => ({
      id: `listing-${name}`,
      name: `Listing ${name}`,
      summary: "Descriptive fixture",
      project_url: `https://github.com/listing-owner/${name}`,
    })),
  };
  const { sources } = catalogObservationSources(input);
  const critical = sources.find((source) => source.repository === "owner/shared")!;
  const ordinary = sources.find((source) => source.repository === "owner/other")!;
  const listings = sources
    .filter((source) => source.repository.startsWith("listing-owner/"))
    .sort((a, b) => a.key.localeCompare(b.key));
  const [deferred, oldest, next] = listings;
  assert.ok(deferred && oldest && next);
  const listingIds = new Map(listings.map((source, index) => [source.repository, 20 + index]));
  const options: CatalogObservationOptions = {
    ...h.options,
    repositoryId: async (source, transport) => {
      const id = listingIds.get(source.repository);
      if (id === undefined) return h.options.repositoryId(source, transport);
      transport.admitRequest();
      return id;
    },
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      for (const [repository, id] of listingIds) {
        if (pathname === `/repos/${repository}`)
          return new Response(JSON.stringify({ id, full_name: repository, archived: false }), {
            headers: { "content-type": "application/json" },
          });
        if (pathname.startsWith(`/repos/${repository}/`))
          return new Response("[]", { headers: { "content-type": "application/json" } });
      }
      return h.options.fetch!(url, init);
    },
  };
  const first = await advanceCatalogObservations(input, null, {
    ...options,
    excludedSources: new Set([oldest.key, next.key]),
  });
  const initial = first.checkpoint.sources[critical.key]?.freshness_observed_at;
  assert.ok(initial);
  const hour = 3600000;
  h.advanceClock(6 * hour);
  const fresh = await advanceCatalogObservations(input, first.checkpoint, {
    ...options,
    excludedSources: new Set([critical, ...listings].map(({ key }) => key)),
  });
  const verified = fresh.checkpoint.sources[ordinary.key]?.freshness_observed_at;
  assert.ok(verified && verified !== initial);
  h.advanceClock(6 * hour - 60000);
  const prior = fresh.checkpoint;
  // Ordinary due work is older in rotation than the freshness-critical source.
  // The reservation must protect the latter even when order alone would not.
  prior.sources[ordinary.key]!.attempted_sequence = 1;
  prior.sources[critical.key]!.attempted_sequence = prior.sequence;
  prior.sources[deferred.key]!.retry_at = new Date(options.now!() + hour).toISOString();
  const baselineTime = options.now!();
  const perBatch = options.config.budget.duration_ms;
  const displace = {
    ...options,
    policyIdentity: "b".repeat(64),
    project: async (...args: Parameters<CatalogObservationOptions["project"]>) => {
      if (args[0] === "other-port") h.advanceClock(perBatch);
      return options.project(...args);
    },
  };
  const beforeSourceCheckpoints = new Map(h.states);
  const baseline = await advanceCatalogObservations(input, prior, displace);
  assert.deepEqual(baseline.report.attempted_source_keys, [ordinary.key]);
  h.advanceClock(baselineTime - options.now!());
  h.states.clear();
  for (const [key, value] of beforeSourceCheckpoints) h.states.set(key, value);

  const reserved = await advanceCatalogObservations(input, prior, {
    ...displace,
    rotateStaleSources: true,
  });
  assert.deepEqual(reserved.report.attempted_source_keys, [critical.key, oldest.key, ordinary.key]);
  assert.ok(reserved.report.completed_source_keys.includes(oldest.key));
  assert.equal(reserved.checkpoint.sources[next.key], undefined);
  assert.deepEqual(reserved.checkpoint.sources[deferred.key], prior.sources[deferred.key]);
  for (const source of [critical, ordinary]) {
    assert.equal(
      reserved.checkpoint.sources[source.key]?.freshness_observed_at,
      baseline.checkpoint.sources[source.key]?.freshness_observed_at,
    );
  }
  const retained = reserved.checkpoint.sources[oldest.key]!;
  assert.ok(retained.freshness_observed_at && retained.completed_at && retained.next_due_at);

  const empty = await advanceCatalogObservations(input, reserved.checkpoint, {
    ...options,
    requestLimit: 0,
    excludedSources: new Set([critical.key, ordinary.key]),
    rotateStaleSources: true,
  });
  assert.equal(empty.report.requests, 0);
  assert.deepEqual(empty.report.attempted_source_keys, []);
  assert.deepEqual(empty.checkpoint, reserved.checkpoint);

  const resumed = await advanceCatalogObservations(input, empty.checkpoint, {
    ...options,
    policyIdentity: displace.policyIdentity,
    rotateStaleSources: true,
  });
  assert.ok(resumed.report.completed_source_keys.includes(next.key));
  assert.equal(resumed.report.attempted_source_keys[0], critical.key);
  assert.deepEqual(resumed.checkpoint.sources[oldest.key], retained);
  assert.deepEqual(resumed.checkpoint.sources[deferred.key], prior.sources[deferred.key]);
  assert.ok(
    Date.parse(resumed.checkpoint.sources[critical.key]!.freshness_observed_at!) >
      Date.parse(initial),
  );
});

void test("failing managed sources rejoin ordinary rotation instead of starving listings", async () => {
  const h = harness();
  const input = {
    ...h.input,
    listings: [
      {
        id: "listing-only",
        name: "Listing only",
        summary: "Descriptive listing",
        project_url: "https://github.com/listing-owner/only",
      },
    ],
  };
  const sources = catalogObservationSources(input).sources;
  const listing = sources.find((source) => source.ports.every((port) => port.kind === "listing"));
  assert.ok(listing);
  const first = await advanceCatalogObservations(input, null, {
    ...h.options,
    excludedSources: new Set([listing.key]),
  });
  const state = structuredClone(first.checkpoint);
  for (const progress of Object.values(state.sources)) {
    progress.exception_key = "f".repeat(64);
    progress.exception_rule = "provider-transport";
    progress.completed_at = null;
    progress.next_due_at = null;
    progress.attempted_sequence = state.sequence;
  }
  h.tick();
  const next = await advanceCatalogObservations(input, state, h.options);
  assert.equal(next.report.attempted_source_keys[0], listing.key);

  // Budget stops are partial progress: the managed source keeps its priority.
  const budget = structuredClone(state);
  for (const progress of Object.values(budget.sources)) progress.exception_rule = "budget";
  const resumed = await advanceCatalogObservations(input, budget, h.options);
  assert.notEqual(resumed.report.attempted_source_keys[0], listing.key);

  // Entries written before rules were recorded keep priority until reattempted.
  const legacy = structuredClone(state);
  for (const progress of Object.values(legacy.sources)) delete progress.exception_rule;
  const legacyRun = await advanceCatalogObservations(input, legacy, h.options);
  assert.notEqual(legacyRun.report.attempted_source_keys[0], listing.key);
});

void test("the configured source gets an early bounded turn without starving untouched sources", async () => {
  const h = harness(2);
  const sources = catalogObservationSources(h.input).sources.sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const [untouched, configured] = sources;
  assert.ok(untouched && configured);
  const options = {
    ...h.options,
    config: validateObserverConfig({
      ...h.options.config,
      port_id: configured.ports[0]!.id,
      repository: configured.repository,
      repository_id: configured.repository === "owner/shared" ? 7 : 8,
    }),
  };
  const simultaneous = await advanceCatalogObservations(h.input, null, {
    ...options,
    prioritizeConfigured: true,
  });
  assert.equal(simultaneous.report.attempted_source_keys[0], configured.key);
  const first = await advanceCatalogObservations(h.input, null, {
    ...options,
    excludedSources: new Set([untouched.key]),
    prioritizeConfigured: true,
  });
  assert.equal(first.report.attempted_source_keys[0], configured.key);
  assert.equal(first.checkpoint.sources[untouched.key], undefined);
  assert.ok(first.report.requests <= 2);

  const next = await advanceCatalogObservations(h.input, first.checkpoint, {
    ...options,
    prioritizeConfigured: true,
  });
  assert.equal(next.report.attempted_source_keys[0], untouched.key);
  assert.ok(next.report.requests <= 2);
});

void test("scarce capacity completes admitted sources instead of one request each", async () => {
  const h = harness(40);
  for (let index = 0; index < 60; index++)
    h.input.ports.push({
      id: `many-${index}`,
      channels: ["stable"],
      release: { repository: `owner/many-${index}` },
    });
  const result = await advanceCatalogObservations(h.input, null, h.options);
  // Dividing 40 requests across 62 pending sources would admit one request per
  // source and complete none. Depth-first turns finish admitted sources.
  assert.ok(result.report.completed_source_keys.length > 0);
  assert.ok(result.report.requests <= 40);
});

void test("an operation request limit caps admissions below the template budget (#4779)", async () => {
  const h = harness(400);
  for (let index = 0; index < 60; index++)
    h.input.ports.push({
      id: `limited-${index}`,
      channels: ["stable"],
      release: { repository: `owner/limited-${index}` },
    });
  const unlimited = await advanceCatalogObservations(h.input, null, h.options);
  assert.ok(unlimited.report.requests > 40);
  const limited = harness(400);
  limited.input.ports.push(...h.input.ports.slice(limited.input.ports.length));
  const result = await advanceCatalogObservations(limited.input, null, {
    ...limited.options,
    requestLimit: 40,
  });
  assert.ok(result.report.requests <= 40, String(result.report.requests));
  assert.ok(result.report.attempted_source_keys.length > 0);
  // Every provider request passes the capped admission.
  assert.equal(limited.network.length, result.report.requests);
});

void test("the configured first turn admits a page set while other sources retain capacity", async () => {
  const h = harness(8);
  for (const name of ["extra-one", "extra-two"]) {
    h.input.ports.push({
      id: name,
      channels: ["stable"],
      release: { repository: `owner/${name}` },
    });
  }
  const options = {
    ...h.options,
    config: validateObserverConfig({
      ...h.options.config,
      port_id: "stable-port",
      repository: "owner/shared",
      repository_id: 7,
    }),
    prioritizeConfigured: true,
  };
  const result = await advanceCatalogObservations(h.input, null, options);
  assert.equal(
    h.network.findIndex((request) => !request.includes("owner/shared")),
    4,
  );
  assert.ok(result.report.attempted_source_keys.length > 1);
  assert.ok(result.report.requests <= 8);
});

void test("both scheduled priority scopes refresh early without excluding normal turns", async () => {
  const h = harness(64);
  for (let index = 0; index < 32; index++) {
    const port = `extra-${index}`;
    h.input.ports.push({
      id: port,
      channels: ["stable"],
      release: { repository: `owner/${port}` },
    });
  }
  const { sources } = catalogObservationSources(h.input);
  const selected = sources.find((source) => source.repository === "owner/other")!;
  const companion = sources.find((source) => source.repository === "owner/extra-0")!;
  const configured = sources.find((source) => source.repository === "owner/shared")!;
  const options: CatalogObservationOptions = {
    ...h.options,
    repositoryId: async (source, transport) => {
      if (source.key !== companion.key) return h.options.repositoryId(source, transport);
      transport.admitRequest();
      return 9;
    },
    fetch: (url, init) =>
      new URL(url).pathname === "/repos/owner/extra-0"
        ? Promise.resolve(
            new Response(JSON.stringify({ id: 9, full_name: "owner/extra-0", archived: false }), {
              headers: { "content-type": "application/json" },
            }),
          )
        : h.options.fetch!(url, init),
    config: validateObserverConfig({
      ...h.options.config,
      port_id: "stable-port",
      repository: "owner/shared",
      repository_id: 7,
    }),
  };
  const first = await advanceCatalogObservations(h.input, null, {
    ...options,
    excludedSources: new Set(sources.filter((source) => source !== selected).map(({ key }) => key)),
  });
  const retained = await advanceCatalogObservations(h.input, first.checkpoint, {
    ...options,
    excludedSources: new Set(
      sources.filter((source) => source !== companion).map(({ key }) => key),
    ),
  });
  const progress = retained.checkpoint.sources[selected.key]!;
  const oldObserved = progress.freshness_observed_at;
  assert.ok(oldObserved);
  const retainedConfig = progress.current_config;
  h.advanceClock(13 * 3600000);
  // A resumed validation can finish many hours after its first verified read.
  progress.next_due_at = new Date(h.options.now!() + 3600000).toISOString();
  retained.checkpoint.sources[companion.key]!.next_due_at = progress.next_due_at;

  const result = await advanceCatalogObservations(h.input, retained.checkpoint, {
    ...options,
    prioritizeConfigured: true,
    scheduledPrioritySources: new Set([selected.key, companion.key]),
  });
  const status = result.report.source_statuses.find(
    ({ source_key }) => source_key === selected.key,
  )!;
  assert.ok(status.current_scope_complete);
  assert.equal(status.stale, false);
  assert.equal(status.observed_at, new Date(h.options.now!()).toISOString());
  assert.notEqual(status.observed_at, oldObserved);
  assert.deepEqual(result.checkpoint.sources[selected.key]!.current_config, retainedConfig);
  const companionStatus = result.report.source_statuses.find(
    ({ source_key }) => source_key === companion.key,
  )!;
  assert.ok(companionStatus.current_scope_complete);
  assert.equal(companionStatus.observed_at, status.observed_at);
  assert.deepEqual(
    new Set(result.report.attempted_source_keys.slice(0, 3)),
    new Set([configured.key, selected.key, companion.key]),
  );
  assert.ok(result.report.attempted_source_keys.length > 3);
  assert.ok(result.report.requests <= 64);
});

void test("partial refresh keeps a stale selected scope pending until a later batch completes", async () => {
  const h = harness();
  h.input.ports = [h.input.ports[2]!];
  const selected = catalogObservationSources(h.input).sources[0]!;
  const first = await advanceCatalogObservations(h.input, null, h.options);
  const progress = first.checkpoint.sources[selected.key]!;
  const oldObserved = progress.freshness_observed_at;
  assert.ok(oldObserved);
  h.advanceClock((h.options.config.stale_after_hours + 1) * 3600000);
  const nextDue = new Date(h.options.now!() + 3600000).toISOString();
  progress.next_due_at = nextDue;
  const options = { ...h.options, scheduledPrioritySources: new Set([selected.key]) };

  h.setQuota(0);
  const partial = await advanceCatalogObservations(h.input, first.checkpoint, {
    ...options,
    prioritizeConfigured: true,
  });
  assert.deepEqual(partial.report.attempted_source_keys, [selected.key]);
  assert.deepEqual(partial.report.completed_source_keys, []);
  assert.deepEqual(partial.report.pending_source_keys, [selected.key]);
  assert.equal(partial.checkpoint.sources[selected.key]!.next_due_at, nextDue);
  assert.equal(partial.checkpoint.sources[selected.key]!.freshness_observed_at, oldObserved);
  assert.ok(h.exported.at(-1)![2].checkpoint.continuation);

  h.advanceClock(2000);
  h.setQuota(null);
  const resumed = await advanceCatalogObservations(h.input, partial.checkpoint, options);
  assert.deepEqual(resumed.report.completed_source_keys, [selected.key]);
  assert.deepEqual(resumed.report.pending_source_keys, []);
  assert.equal(resumed.report.source_statuses[0]!.stale, false);
  assert.notEqual(resumed.report.source_statuses[0]!.observed_at, oldObserved);
});

void test("provider reserve stops work and later quota recovery resumes exact retained pages", async () => {
  const h = harness();
  h.setQuota(0);
  const first = await advanceCatalogObservations(h.input, null, h.options);
  assert.ok(first.report.pending_source_keys.length > 0);
  assert.ok(first.report.requests <= 2);
  const beforeReset = h.network.length;
  const deferred = await advanceCatalogObservations(h.input, first.checkpoint, h.options);
  assert.equal(h.network.length, beforeReset);
  assert.equal(deferred.report.requests, 0);
  h.tick();
  h.setQuota(100);
  const resumed = await advanceCatalogObservations(h.input, first.checkpoint, h.options);
  assert.equal(resumed.report.pending_source_keys.length, 0);
  assert.equal(resumed.report.completed_source_keys.length, 2);
});

void test("foreign repository identity and Core binding failures isolate a source without replacing its identity", async () => {
  const h = harness();
  h.changeIdentity();
  const result = await advanceCatalogObservations(h.input, null, h.options);
  assert.equal(result.report.completed_source_keys.length, 0);
  assert.ok(result.report.failures.every((failure) => failure.rule === "repository-identity"));
  assert.deepEqual(
    Object.values(result.checkpoint.sources)
      .map((source) => source.repository_id)
      .sort((a, b) => Number(a) - Number(b)),
    [7, 8],
  );
  const other = harness();
  other.options.project = async () => ({ format: 1, port_id: "foreign", projections: [] });
  const rejected = await advanceCatalogObservations(other.input, null, other.options);
  assert.equal(rejected.report.completed_source_keys.length, 0);
  assert.ok(rejected.report.failures.every((failure) => failure.rule === "core-binding"));
});

void test("cancellation and a contended source lock preserve unrelated progress and malformed checkpoints refuse before IO", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  const cancelled = await advanceCatalogObservations(h.input, null, {
    ...h.options,
    signal: controller.signal,
  });
  assert.equal(h.network.length, 0);
  assert.deepEqual(cancelled.report.completed_source_keys, []);
  h.options.withSourceLock = async (config, operation) => {
    if (config.repository === "owner/shared") throw new Error("held lock");
    return operation();
  };
  const partial = await advanceCatalogObservations(h.input, null, h.options);
  assert.equal(partial.report.completed_source_keys.length, 1);
  assert.equal(partial.report.failures.length, 1);
  const before = h.network.length;
  await assert.rejects(
    advanceCatalogObservations(h.input, { ...partial.checkpoint, sequence: -1 }, h.options),
    /Invalid catalog observer/,
  );
  assert.equal(h.network.length, before);
  assert.throws(
    () => catalogObservationSources({ ports: [h.input.ports[0], h.input.ports[0]] }),
    /unique stable/,
  );
});

void test("changed catalog scope or Core identity cannot inherit fresh completion", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  const changed = structuredClone(h.input);
  changed.ports[0]!.channels = ["beta"];
  const next = await advanceCatalogObservations(changed, first.checkpoint, h.options);
  assert.ok(next.report.attempted_source_keys.length > 0);
  const changedCore = await advanceCatalogObservations(changed, next.checkpoint, {
    ...h.options,
    policyIdentity: "b".repeat(64),
  });
  assert.equal(changedCore.report.attempted_source_keys.length, 2);
});

void test("Core selection and policy projection resume exact per-port cursors across execution budgets", async () => {
  const h = harness();
  h.input.ports = Array.from({ length: 40 }, (_, index) => ({
    id: `shared-${index}`,
    channels: ["stable"],
    release: { repository: "owner/shared" },
  }));
  const project = h.options.project;
  const counts = new Map<string, number>();
  h.options.project = async (...args) => {
    const [portId, , observation] = args;
    const phase = observation.coverage?.asset_release_ids.length ? "policy" : "selection";
    const key = `${phase}:${portId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const policy = await project(...args);
    h.tick();
    return policy;
  };
  let state: CatalogObserverCheckpoint | null = null;
  let complete = false;
  let offlineResumes = 0;
  for (let batch = 0; batch < 10; batch++) {
    const offline =
      state !== null &&
      Object.values(state.sources).some((source) => source.policy_progress !== null);
    if (offline) state!.provider_retry_at = new Date(h.options.now!() + 3600000).toISOString();
    const before = h.network.length;
    const result = await advanceCatalogObservations(h.input, state, h.options);
    if (offline) {
      assert.equal(h.network.length, before);
      offlineResumes++;
    }
    state = result.checkpoint;
    if (!result.report.pending_source_keys.length) {
      complete = true;
      break;
    }
    assert.equal(result.report.completed_source_keys.length, 0);
  }
  assert.equal(complete, true);
  assert.ok(
    offlineResumes > 0,
    "provider quota depletion does not block already collected Core work",
  );
  assert.equal(counts.size, 80);
  assert.ok([...counts.values()].every((count) => count === 1));
  assert.equal(h.exported.at(-1)![3].length, 40);
});

void test("nonempty asset selection preserves post-asset Core progress across finite invocations", async () => {
  const h = harness();
  h.input.ports = [h.input.ports[0]!];
  h.options.config = validateObserverConfig({
    ...h.options.config,
    budget: { ...h.options.config.budget, duration_ms: 15000 },
  });
  const fetch = h.options.fetch!;
  h.options.fetch = async (url, init) => {
    if (new URL(url).pathname.endsWith("/releases/1/assets")) {
      h.network.push(url);
      return new Response(
        JSON.stringify([
          {
            id: 10,
            name: "player-windows.zip",
            size: 16,
            state: "uploaded",
            digest: `sha256:${"a".repeat(64)}`,
            created_at: "2026-09-09T12:00:00Z",
            updated_at: "2026-09-09T12:00:00Z",
            browser_download_url:
              "https://github.com/owner/shared/releases/download/v1.0.0/player-windows.zip",
          },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    }
    return fetch(url, init);
  };
  const project = h.options.project;
  let calls = 0;
  h.options.project = async (...args) => {
    calls++;
    const result = await project(...args);
    h.tick();
    return result;
  };
  let state: CatalogObserverCheckpoint | null = null;
  let complete = false;
  for (let batch = 0; batch < 6; batch++) {
    const result = await advanceCatalogObservations(h.input, state, h.options);
    state = result.checkpoint;
    if (result.report.pending_source_keys.length === 0) {
      complete = true;
      break;
    }
  }
  assert.ok(complete, "header-only probes must not overwrite a retained post-assets cursor");
  assert.equal(calls, 3, "one header projection, one covered selection, one final policy");
  const observed = h.exported.at(-1)![2].report.observation;
  assert.ok(observed && isRecord(observed.facts));
  assert.equal(
    (observed.facts.releases as ProviderObservation["facts"]["releases"])[1]!.assets.length,
    1,
  );
});

function coveredSelectionHarness(
  finalCoverage: (covered: boolean) => string,
  extra: (projection: Record<string, unknown>) => void = () => {},
) {
  const h = harness();
  h.input.ports = [h.input.ports[0]!];
  h.options.config = validateObserverConfig({
    ...h.options.config,
    budget: { ...h.options.config.budget, duration_ms: 15000 },
  });
  const fetch = h.options.fetch!;
  h.options.fetch = async (url, init) => {
    const match = new URL(url).pathname.match(/\/releases\/(\d+)\/assets$/u);
    if (match) {
      h.network.push(url);
      const tag = match[1] === "1" ? "v1.0.0" : "rolling";
      return new Response(
        JSON.stringify([
          {
            id: Number(match[1]) * 10,
            name: "player-windows.zip",
            size: 16,
            state: "uploaded",
            digest: `sha256:${"a".repeat(64)}`,
            created_at: "2026-09-09T12:00:00Z",
            updated_at: "2026-09-09T12:00:00Z",
            browser_download_url: `https://github.com/owner/shared/releases/download/${tag}/player-windows.zip`,
          },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    }
    return fetch(url, init);
  };
  const project = h.options.project;
  const coverages: string[] = [];
  h.options.project = async (portId, repositoryId, observation) => {
    const result = (await project(portId, repositoryId, observation)) as Record<string, unknown>;
    h.tick();
    // Like Core, a headers-only probe reaches an uncollected candidate.
    const covered = (observation.coverage?.asset_release_ids ?? []).includes(1);
    const kind = finalCoverage(covered);
    coverages.push(kind);
    for (const projection of result.projections as Record<string, unknown>[]) extra(projection);
    return { ...result, fact_provenance: { coverage: { kind } }, release_facts: [{}] };
  };
  return { h, coverages };
}

void test("selection probes project uncovered headers and only the final projection gates coverage", async () => {
  const { h, coverages } = coveredSelectionHarness((covered) => (covered ? "complete" : "partial"));
  let state: CatalogObserverCheckpoint | null = null;
  let complete = false;
  for (let batch = 0; batch < 6; batch++) {
    const result = await advanceCatalogObservations(h.input, state, h.options);
    state = result.checkpoint;
    assert.deepEqual(
      result.report.failures.filter((failure) => failure.rule !== "budget"),
      [],
    );
    if (result.report.pending_source_keys.length === 0) {
      complete = true;
      break;
    }
  }
  assert.ok(complete, "a partial headers-only probe must not fail selection");
  assert.equal(coverages[0], "partial");
  assert.equal(coverages.at(-1), "complete");
  const source = Object.values(state!.sources)[0]!;
  assert.equal(typeof source.last_complete_facts_sha256, "string");
  // Retained policies keep provenance but not per-release typed facts.
  for (const policy of source.last_complete_policies) {
    assert.ok(isRecord(policy.fact_provenance));
    assert.equal(Object.hasOwn(policy, "release_facts"), false);
  }
});

void test("a stated partial final projection keeps the cursor and last-good facts", async () => {
  const { h } = coveredSelectionHarness(() => "partial");
  let state: CatalogObserverCheckpoint | null = null;
  let failure: unknown = null;
  for (let batch = 0; batch < 6 && failure === null; batch++) {
    const result = await advanceCatalogObservations(h.input, state, h.options);
    state = result.checkpoint;
    failure = result.report.failures.find((item) => item.rule === "incomplete-coverage") ?? null;
  }
  assert.ok(failure, "the final partial projection is refused");
  const source = Object.values(state!.sources)[0]!;
  assert.equal(source.last_complete_facts_sha256, null);
  assert.deepEqual(source.last_complete_policies, []);
  assert.equal(source.exception_rule, "incomplete-coverage");
});

void test("selection collects a reviewed fallback's assets as well as the candidate's", async () => {
  const { h } = coveredSelectionHarness(
    () => "complete",
    (projection) => {
      if (projection.channel === "stable") projection.reviewed_fallback = { id: 2 };
    },
  );
  let state: CatalogObserverCheckpoint | null = null;
  for (let batch = 0; batch < 6; batch++) {
    const result = await advanceCatalogObservations(h.input, state, h.options);
    state = result.checkpoint;
    if (result.report.pending_source_keys.length === 0) break;
  }
  assert.ok(h.network.some((url) => new URL(url).pathname.endsWith("/releases/2/assets")));
  assert.ok(h.network.some((url) => new URL(url).pathname.endsWith("/releases/1/assets")));
  const { projectionAssetReleaseIds } = await import("./catalog-observer-continuation.mts");
  assert.deepEqual(
    projectionAssetReleaseIds({ channel_candidate: { id: 3 }, reviewed_fallback: { id: 2 } }),
    [3, 2],
  );
  assert.deepEqual(projectionAssetReleaseIds({ channel_candidate: null }), []);
});

void test("source byte admission includes identity lookups while smaller unrelated sources continue", async () => {
  const h = harness();
  h.options.repositoryId = async (source, transport) => {
    transport.admitRequest();
    if (source.repository === "owner/shared")
      transport.consumeResponseBytes(h.options.config.budget.total_bytes + 1);
    return source.repository === "owner/shared" ? 7 : 8;
  };
  const result = await advanceCatalogObservations(h.input, null, h.options);
  assert.ok(result.report.requests > 1);
  assert.ok(h.network.length > 0);
  assert.equal(result.report.completed_source_keys.length, 1);
  assert.ok(result.report.pending_source_keys.length > 0);
  assert.equal(result.notify_exception, false);
});

void test("new provider exceptions notify once and failed refresh retains every secondary fallback policy", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  h.changeIdentity();
  const changed = structuredClone(h.input);
  changed.ports[0]!.channels = ["beta"];
  const failed = await advanceCatalogObservations(changed, first.checkpoint, h.options);
  assert.equal(failed.notify_exception, true);
  const shared = h.exported.at(-1)!;
  assert.equal(shared[3].length, 2);
  assert.ok(shared[2].report.exception);
  const repeated = await advanceCatalogObservations(changed, failed.checkpoint, h.options);
  assert.equal(repeated.notify_exception, false);
});

void test("listing-only provider exceptions are reported without failing the job", async () => {
  const h = harness();
  const input = {
    ...h.input,
    listings: [
      {
        id: "listing-gone",
        name: "Listing gone",
        summary: "Descriptive listing",
        project_url: "https://github.com/listing-owner/gone",
      },
    ],
  };
  const fetch = h.options.fetch!;
  const result = await advanceCatalogObservations(input, null, {
    ...h.options,
    fetch: async (url, init) =>
      url.includes("/listing-owner/gone")
        ? new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          })
        : fetch(url, init),
  });
  assert.ok(result.report.failures.some((failure) => failure.repository === "listing-owner/gone"));
  assert.equal(result.notify_exception, false);
});

void test("scheduled priority and promoted listing exceptions still fail the job once", async () => {
  const h = harness();
  const listing = {
    id: "listing-gone",
    name: "Listing gone",
    summary: "Descriptive listing",
    project_url: "https://github.com/listing-owner/gone",
  };
  const input = { ...h.input, listings: [listing] };
  const fetch = h.options.fetch!;
  const repositoryId = h.options.repositoryId;
  const options = {
    ...h.options,
    // A deleted repository fails its identity lookup before release collection.
    repositoryId: async (...args: Parameters<typeof repositoryId>) => {
      if (args[0].repository === "listing-owner/gone")
        throw new ObservationFailure("provider-status", "provider returned HTTP 404");
      return repositoryId(...args);
    },
    fetch: async (url: string, init: Parameters<typeof fetch>[1]) =>
      url.includes("/listing-owner/gone")
        ? new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          })
        : fetch(url, init),
  };
  const key = catalogObservationSources(input).sources.find(
    (source) => source.repository === "listing-owner/gone",
  )!.key;
  const priority = await advanceCatalogObservations(input, null, {
    ...options,
    scheduledPrioritySources: new Set([key]),
    prioritizeConfigured: true,
  });
  assert.equal(priority.notify_exception, true);

  const quiet = await advanceCatalogObservations(input, null, options);
  assert.equal(quiet.notify_exception, false);
  const promoted = {
    ...input,
    ports: [
      ...input.ports,
      { id: "listing-gone", channels: ["stable"], release: { repository: "listing-owner/gone" } },
    ],
  };
  h.tick();
  const state = structuredClone(quiet.checkpoint);
  for (const progress of Object.values(state.sources)) progress.next_due_at = null;
  const managed = await advanceCatalogObservations(promoted, state, {
    ...options,
    definitionHash: (portId: string) =>
      observationHash(promoted.ports.find((port) => port.id === portId)),
  });
  assert.ok(managed.report.failures.some((failure) => failure.repository === "listing-owner/gone"));
  assert.equal(managed.notify_exception, true);
});

void test("provider reset headers do not turn fair quantum exhaustion into provider backoff", async () => {
  const h = harness(2);
  h.setQuota(100);
  const result = await advanceCatalogObservations(h.input, null, h.options);
  assert.equal(result.report.completed_source_keys.length, 2);
  assert.equal(result.report.pending_source_keys.length, 0);
  assert.ok(
    result.report.requests > 2,
    "multiple bounded source batches complete automatically inside actual available quota",
  );
  assert.ok(Object.values(result.checkpoint.sources).every((source) => source.retry_at === null));
});

void test("operational coordinator isolates handoff files, preserves failure notification and recovers changed-scope caches", async (t) => {
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "catalog-coordinator-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness();
  await mkdir(path.join(root, "release"), { recursive: true });
  await mkdir(path.join(root, "crates/portcove-core/catalog"), { recursive: true });
  await writeFile(
    path.join(root, "crates/portcove-core/catalog/listings.json"),
    JSON.stringify({
      format_version: 1,
      listings: [
        {
          id: "stable-port",
          name: "Stable listing",
          summary: "Reviewed description",
          project_url: "https://github.com/owner/shared",
        },
      ],
    }),
  );
  const cli = path.join(root, "inspector");
  await writeFile(cli, "fixture inspector identity; native execution is mocked");
  await writeFile(
    path.join(root, "release/upstream-observer.json"),
    JSON.stringify(h.options.config),
  );
  const catalog = path.join(root, "crates/portcove-core/catalog/catalog.json");
  await writeFile(catalog, JSON.stringify(h.input));
  const runtime = {
    root,
    inspectCatalog: async () =>
      new Map(h.input.ports.map((port) => [port.id, observationHash(port)])),
    now: h.options.now!,
    observer: { fetch: h.options.fetch!, sleep: h.options.sleep! },
    project: async (
      _cli: string,
      config: Parameters<typeof h.options.load>[0],
      _directory: string,
      observation: Parameters<typeof h.options.project>[2],
    ) => h.options.project(config.port_id, config.repository_id, observation),
    repositoryMetadata: async (repository: string) => {
      const body = {
        id: repository === "owner/shared" ? 7 : 8,
        full_name: repository,
        archived: false,
      };
      return {
        status: 200,
        headers: new Map<string, string>(),
        body,
        bodyBytes: Buffer.byteLength(JSON.stringify(body)),
      };
    },
    log: () => {},
  };
  const first = await runCatalogUpstreams(["--cli", cli], runtime);
  assert.equal(first.report.completed_source_keys.length, 2);
  const files = await readdir(first.handoff_directory);
  assert.equal(files.length, 3);
  const source = Object.values(first.checkpoint.sources).find(
    (source) => source.repository === "owner/shared",
  )!;
  const initialHandoff = JSON.parse(
    await readFile(
      path.join(first.handoff_directory, `${observationHash(source.current_config)}.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(Object.hasOwn(initialHandoff, "unmonitored_port_ids"), false);
  assert.deepEqual(initialHandoff.descriptive_listing_preimages, {
    "stable-port": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
  });
  const previousConfig = source.current_config!;
  const priorFile = path.join(
    root,
    "work/upstream-observer",
    observationHash(previousConfig),
    "checkpoint.json",
  );
  const second = await runCatalogUpstreams(["--cli", cli], runtime);
  assert.equal(second.report.requests, 0);
  assert.notEqual(first.handoff_directory, second.handoff_directory);
  assert.deepEqual(await readdir(second.handoff_directory), ["summary.json"]);
  h.input.ports[0]!.channels = ["beta"];
  await writeFile(catalog, JSON.stringify(h.input));
  h.changeIdentity();
  const failed = await runCatalogUpstreams(["--cli", cli], runtime);
  assert.equal(failed.notify_exception, true);
  const retained = JSON.parse(
    await readFile(
      path.join(
        failed.handoff_directory,
        `${observationHash(Object.values(failed.checkpoint.sources).find((source) => source.repository === "owner/shared")!.current_config)}.json`,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.match(String(retained.catalog_policies_scope), /historical-fallback/);
  assert.ok(Array.isArray(retained.catalog_policies) && retained.catalog_policies.length === 2);
  assert.ok((await readFile(priorFile)).byteLength > 0);
  const repeated = await runCatalogUpstreams(["--cli", cli], runtime);
  assert.equal(repeated.notify_exception, false);
  h.restoreIdentity();
  const recovered = await runCatalogUpstreams(["--cli", cli], runtime);
  assert.equal(recovered.report.failures.length, 0);
  await assert.rejects(readFile(priorFile), { code: "ENOENT" });
  h.input.ports.push({
    id: "unavailable-port",
    channels: ["stable"],
    release: { repository: "owner/unavailable" },
  });
  await writeFile(catalog, JSON.stringify(h.input));
  runtime.repositoryMetadata = async () => {
    throw new GitHubApiError(
      "command_failed",
      "private transport detail must stay out of proposal evidence",
      { status: 404 },
    );
  };
  const unavailable = await runCatalogUpstreams(["--cli", cli], runtime);
  assert.equal(unavailable.report.failures[0]!.rule, "repository-unavailable");
  assert.match(unavailable.report.failures[0]!.details, /HTTP 404/);
  assert.doesNotMatch(JSON.stringify(unavailable.report), /private transport detail/);
});

void test("retired cache cleanup preserves live snapshots, contention, foreign files and unknown ownership", async (t) => {
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "catalog-cache-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness();
  const result = await advanceCatalogObservations(h.input, null, h.options);
  const progress = Object.values(result.checkpoint.sources).find(
    (source) => source.repository === "owner/shared",
  )!;
  const current = progress.current_config!;
  const retired = validateObserverConfig({ ...current, policy_input_sha256: "f".repeat(64) });
  const snapshot = await advanceObservation(retired, null, {
    fetch: h.options.fetch!,
    now: h.options.now!,
    selectAssetReleases: async () => [1],
    project: (observation) =>
      h.options.project(retired.port_id, retired.repository_id, observation),
  });
  progress.retired_configs.push(retired);
  const directory = path.join(root, "work/upstream-observer", observationHash(retired));
  await mkdir(directory, { recursive: true });
  const checkpointFile = path.join(directory, "checkpoint.json");
  const reportFile = path.join(directory, "report.json");
  const statePath = path.join(root, "work/upstream-observer/catalog/checkpoint.json");
  const stored = encodeStoredObserverCheckpoint(snapshot.checkpoint);
  assert.notDeepEqual(
    stored,
    snapshot.checkpoint,
    "Cleanup exercises an actual compressed source document",
  );
  await writeFile(checkpointFile, JSON.stringify(stored));
  await writeFile(reportFile, JSON.stringify(snapshot.report));
  await writeFile(path.join(directory, "foreign.txt"), "preserve unrelated bytes");
  const cleanup = () =>
    retireObserverConfigurations(root, statePath, result.checkpoint, Date.now() + 30000);
  progress.last_complete_config = retired;
  assert.deepEqual(await cleanup(), []);
  assert.ok((await readFile(checkpointFile)).byteLength > 0);
  progress.last_complete_config = current;
  await writeFile(`${checkpointFile}.lock`, "owned test contention fixture");
  assert.deepEqual(await cleanup(), [observationHash(retired)]);
  await rm(`${checkpointFile}.lock`);
  await writeFile(
    reportFile,
    JSON.stringify({ ...snapshot.report, config_sha256: "0".repeat(64) }),
  );
  assert.deepEqual(await cleanup(), [observationHash(retired)]);
  assert.ok((await readFile(checkpointFile)).byteLength > 0);
  await writeFile(reportFile, JSON.stringify(snapshot.report));
  assert.deepEqual(await cleanup(), []);
  await assert.rejects(readFile(checkpointFile), { code: "ENOENT" });
  assert.equal(
    await readFile(path.join(directory, "foreign.txt"), "utf8"),
    "preserve unrelated bytes",
  );
  assert.equal(progress.retired_configs.length, 0);
});

void test("measured quiet activity defers inside freshness and catalog changes reset that estimate", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  h.advanceClock(48 * 3600000);
  h.bumpRelease();
  const changed = await advanceCatalogObservations(h.input, first.checkpoint, h.options);
  const shared = Object.values(changed.checkpoint.sources).find(
    (source) => source.repository === "owner/shared",
  )!;
  assert.equal(shared.change_intervals, 1);
  assert.equal(shared.mean_change_interval_ms, 48 * 3600000);
  assert.ok(
    Date.parse(shared.next_due_at!) - Date.parse(shared.freshness_observed_at!) < 12 * 3600000,
  );
  h.advanceClock(6 * 3600000);
  const quiet = await advanceCatalogObservations(h.input, changed.checkpoint, h.options);
  assert.equal(quiet.report.requests, 0);
  h.input.ports[0]!.channels = ["beta"];
  const scoped = await advanceCatalogObservations(h.input, quiet.checkpoint, h.options);
  const reset = Object.values(scoped.checkpoint.sources).find(
    (source) => source.repository === "owner/shared",
  )!;
  assert.equal(reset.change_intervals, 0);
  assert.equal(reset.mean_change_interval_ms, null);
});

void test("legacy artifact retains its original report shape while shared ports get separate catalog policies", async (t) => {
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "catalog-legacy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness();
  const legacy = validateObserverConfig({
    ...config,
    port_id: "stable-port",
    repository: "owner/shared",
    repository_id: 7,
  });
  await mkdir(path.join(root, "release"), { recursive: true });
  await mkdir(path.join(root, "crates/portcove-core/catalog"), { recursive: true });
  await writeFile(
    path.join(root, "crates/portcove-core/catalog/listings.json"),
    JSON.stringify({ format_version: 1, listings: [] }),
  );
  const cli = path.join(root, "inspector");
  await writeFile(cli, "mock Core identity");
  await writeFile(path.join(root, "release/upstream-observer.json"), JSON.stringify(legacy));
  await writeFile(
    path.join(root, "crates/portcove-core/catalog/catalog.json"),
    JSON.stringify({ ports: h.input.ports.slice(0, 2) }),
  );
  const result = await runCatalogUpstreams(["--cli", cli], {
    root,
    inspectCatalog: async () =>
      new Map(h.input.ports.map((port) => [port.id, observationHash(port)])),
    now: h.options.now!,
    observer: { fetch: h.options.fetch! },
    log: () => {},
    repositoryMetadata: async () =>
      assert.fail("Reviewed legacy numeric identity needs no new baseline lookup"),
    project: async (_cli, source, _directory, observation) =>
      h.options.project(source.port_id, source.repository_id, observation),
  });
  assert.equal(result.notify_exception, false);
  const legacyReport = JSON.parse(
    await readFile(
      path.join(root, "work/upstream-observer", observationHash(legacy), "report.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(legacyReport.config_sha256, observationHash(legacy));
  assert.equal(Object.hasOwn(legacyReport, "catalog_policies"), false);
  assert.equal(Object.hasOwn(legacyReport, "source_port_ids"), false);
  assert.deepEqual(legacyReport.unmonitored_port_ids, ["rolling-port"]);
  const handoff = JSON.parse(
    await readFile(path.join(result.handoff_directory, `${observationHash(legacy)}.json`), "utf8"),
  ) as Record<string, unknown>;
  assert.ok(Array.isArray(handoff.catalog_policies) && handoff.catalog_policies.length === 2);
  assert.equal(Object.hasOwn(handoff, "unmonitored_port_ids"), false);
});

void test("cumulative session bytes can exceed one source operation without unsafe reads or false completion", async () => {
  const baseline = harness();
  const before = await advanceCatalogObservations(baseline.input, null, baseline.options);
  const total = before.report.response_bytes_charged;
  const h = harness();
  const operationLimit = Math.ceil(total * 0.75);
  h.options.config = validateObserverConfig({
    ...h.options.config,
    budget: {
      ...h.options.config.budget,
      response_bytes: operationLimit,
      total_bytes: operationLimit,
    },
  });
  const result = await advanceCatalogObservations(h.input, null, h.options);
  assert.equal(result.report.completed_source_keys.length, 2);
  assert.equal(result.report.pending_source_keys.length, 0);
  assert.ok(result.report.response_bytes_charged > operationLimit);
  assert.equal(result.report.global_eligibility, "not-assessed");
});

void test("a refused oversized read with no accepted progress is not immediately requeued", async () => {
  const h = harness();
  h.options.config = validateObserverConfig({
    ...h.options.config,
    budget: { ...h.options.config.budget, response_bytes: 32 },
  });
  const result = await advanceCatalogObservations(h.input, null, h.options);
  assert.equal(result.report.completed_source_keys.length, 0);
  assert.equal(result.report.attempted_source_keys.length, 2);
  assert.equal(h.network.filter((url) => url.startsWith("https:")).length, 2);
  assert.equal(result.report.failures.length, 2);
  assert.equal(result.notify_exception, false);
});

void test("a changed Core reprojects fresh complete facts without provider reads or manufactured freshness", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  const network = h.network.length;
  const freshClocks = Object.fromEntries(
    Object.entries(first.checkpoint.sources).map(([key, value]) => [
      key,
      value.freshness_observed_at,
    ]),
  );
  h.advanceClock(10000);
  const originalProject = h.options.project;
  let projections = 0;
  const result = await advanceCatalogObservations(h.input, first.checkpoint, {
    ...h.options,
    policyIdentity: "b".repeat(64),
    project: async (...args) => {
      projections++;
      return {
        ...((await originalProject(...args)) as Record<string, unknown>),
        current_core_fixture: true,
      };
    },
  });
  assert.equal(h.network.length, network);
  assert.equal(result.report.requests, 0);
  assert.equal(result.report.completed_source_keys.length, 2);
  assert.equal(
    projections,
    6,
    "all three ports receive current Core header selection and final policy projection",
  );
  for (const [key, progress] of Object.entries(result.checkpoint.sources)) {
    assert.equal(progress.freshness_observed_at, freshClocks[key]);
    assert.ok(
      progress.last_complete_policies.every((policy) => policy.current_core_fixture === true),
    );
  }
});

void test("an appointed scheduled source refreshes when due even after a Core binding change", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  const selected = catalogObservationSources(h.input).sources.find(
    (source) => source.repository === "owner/other",
  )!;
  const peer = catalogObservationSources(h.input).sources.find(
    (source) => source.repository === "owner/shared",
  )!;
  const prior = first.checkpoint.sources[selected.key]!;
  const due = Date.parse(prior.next_due_at!);
  assert.ok(due > h.options.now!());
  h.advanceClock(due - h.options.now!());
  assert.ok(
    due - Date.parse(prior.freshness_observed_at!) < h.options.config.stale_after_hours * 3600000,
  );
  h.bumpRelease();
  const before = h.network.length;
  const result = await advanceCatalogObservations(h.input, first.checkpoint, {
    ...h.options,
    policyIdentity: "b".repeat(64),
    prioritizeConfigured: true,
    scheduledPrioritySources: new Set([selected.key]),
  });
  assert.equal(result.report.attempted_source_keys[0], selected.key);
  assert.ok(result.report.completed_source_keys.includes(selected.key));
  assert.ok(h.network.length > before);
  assert.ok(h.network.slice(before).every((url) => url.includes("owner/other")));
  assert.notEqual(
    result.checkpoint.sources[selected.key]!.last_complete_facts_sha256,
    prior.last_complete_facts_sha256,
  );
  assert.equal(
    result.checkpoint.sources[selected.key]!.freshness_observed_at,
    new Date(due).toISOString(),
  );
  assert.equal(
    result.checkpoint.sources[peer.key]!.freshness_observed_at,
    first.checkpoint.sources[peer.key]!.freshness_observed_at,
  );
});

void test("fresh fact reuse falls back to collection when current Core requires uncovered candidate assets", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  const count = h.network.length;
  const originalProject = h.options.project;
  const result = await advanceCatalogObservations(h.input, first.checkpoint, {
    ...h.options,
    policyIdentity: "b".repeat(64),
    project: async (...args) => {
      const policy = (await originalProject(...args)) as {
        projections: { channel_candidate: { id: number } }[];
      };
      if (args[0] === "other-port") policy.projections[0]!.channel_candidate.id = 2;
      return policy;
    },
  });
  assert.equal(result.report.completed_source_keys.length, 2);
  assert.ok(h.network.length > count);
  assert.ok(h.network.slice(count).every((url) => url.includes("owner/other")));
  assert.ok(h.network.slice(count).some((url) => url.includes("releases/2/assets")));
});

void test("expired provider facts are observed again after a changed Core", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  const count = h.network.length;
  h.advanceClock(13 * 3600000);
  const result = await advanceCatalogObservations(h.input, first.checkpoint, {
    ...h.options,
    policyIdentity: "b".repeat(64),
  });
  assert.equal(result.report.completed_source_keys.length, 2);
  assert.ok(h.network.length > count);
  for (const [key, progress] of Object.entries(result.checkpoint.sources))
    assert.notEqual(
      progress.freshness_observed_at,
      first.checkpoint.sources[key]!.freshness_observed_at,
    );
});

void test("cancellation after a reused-facts Core call cannot retain current eligibility", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  const originalProject = h.options.project;
  const control = new AbortController();
  const result = await advanceCatalogObservations(h.input, first.checkpoint, {
    ...h.options,
    policyIdentity: "b".repeat(64),
    signal: control.signal,
    project: async (...args) => {
      const result = await originalProject(...args);
      control.abort();
      return result;
    },
  });
  assert.equal(result.report.completed_source_keys.length, 0);
  assert.ok(result.report.source_statuses.every((status) => !status.current_scope_complete));
  assert.equal(result.report.requests, 0);
});

void test("current Core can reproject complete facts while the provider remains durably unavailable", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  first.checkpoint.provider_retry_at = new Date(
    Date.parse(first.report.generated_at) + 3600000,
  ).toISOString();
  const count = h.network.length;
  const next = await advanceCatalogObservations(h.input, first.checkpoint, {
    ...h.options,
    policyIdentity: "b".repeat(64),
  });
  assert.equal(h.network.length, count);
  assert.equal(next.report.completed_source_keys.length, 2);
  assert.equal(next.checkpoint.provider_retry_at, first.checkpoint.provider_retry_at);
});

void test("provider fact reuse refuses missing page coverage, corrupt facts and changed repository identity", async () => {
  const h = harness();
  await advanceCatalogObservations(h.input, null, h.options);
  const [, config, result] = h.exported[0]!;
  const complete = result.checkpoint.last_complete!;
  const now = Date.parse(result.report.generated_at);
  assert.ok(
    reusableProviderObservation(config, complete.observation, complete.cache, undefined, now),
  );
  const brokenCache = structuredClone(complete.cache) as {
    pages: Record<
      string,
      { body: unknown; sha256: string; facts_sha256?: string; link: string; etag: string }
    >;
  };
  const assetPage = Object.keys(brokenCache.pages).find((url) => url.includes("/assets"))!;
  delete brokenCache.pages[assetPage];
  assert.throws(
    () => reusableProviderObservation(config, complete.observation, brokenCache, undefined, now),
    /incomplete page chain/,
  );
  const observation = structuredClone(complete.observation);
  observation.facts_sha256 = "b".repeat(64);
  assert.throws(
    () => reusableProviderObservation(config, observation, complete.cache, undefined, now),
    /facts differ/,
  );
  const changedConfig = { ...config, repository_id: config.repository_id + 1 };
  assert.throws(
    () =>
      reusableProviderObservation(
        changedConfig,
        complete.observation,
        complete.cache,
        undefined,
        now,
      ),
    /scope differs/,
  );
  assert.equal(
    reusableProviderObservation(
      config,
      complete.observation,
      complete.cache,
      undefined,
      now + config.stale_after_hours * 3600000,
    ),
    null,
  );
});

void test("known changed partial provider facts cannot be replaced by an older fresh snapshot", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  const [, config, result] = h.exported.find(([source]) => source.repository === "owner/other")!;
  const state = structuredClone(result.checkpoint);
  const proof = state.last_complete!.cache as {
    pages: Record<
      string,
      { body: unknown; sha256: string; facts_sha256?: string; link: string; etag: string }
    >;
  };
  const url = Object.keys(proof.pages).find((url) => /\/releases\?/.test(url))!;
  const page = structuredClone(proof.pages[url]!);
  const rows = page.body as { id: number; tag_name: string }[];
  rows.find((row) => row.id === 1)!.tag_name = "v1.1.0";
  page.sha256 = observationHash(rows);
  page.facts_sha256 = observationHash(rows);
  state.continuation = {
    format: 1,
    config_sha256: observationHash(config),
    started_at: first.report.generated_at,
    phase: "collect",
    pages: { [url]: page },
    validation_cursor: 0,
    first_validated_at: null,
    last_validated_at: null,
    validation_order_sha256: null,
    consumed: { requests: 1, response_bytes: 1, conditional_hits: 0 },
  };
  h.states.set(observationHash(config), state);
  h.bumpRelease();
  const count = h.network.length;
  const next = await advanceCatalogObservations(h.input, first.checkpoint, {
    ...h.options,
    policyIdentity: "b".repeat(64),
  });
  assert.ok(h.network.length > count);
  const other = Object.values(next.checkpoint.sources).find(
    (source) => source.repository === "owner/other",
  )!;
  assert.notEqual(
    other.last_complete_facts_sha256,
    Object.values(first.checkpoint.sources).find((source) => source.repository === "owner/other")!
      .last_complete_facts_sha256,
  );
});

void test("a Core executable changed during projection cannot publish a completed source scope", async (t) => {
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "portcove-core-change-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness();
  const legacy = validateObserverConfig({
    ...config,
    port_id: "stable-port",
    repository: "owner/shared",
    repository_id: 7,
  });
  await mkdir(path.join(root, "release"), { recursive: true });
  await mkdir(path.join(root, "crates/portcove-core/catalog"), { recursive: true });
  await writeFile(
    path.join(root, "crates/portcove-core/catalog/listings.json"),
    JSON.stringify({ format_version: 1, listings: [] }),
  );
  const cli = path.join(root, "inspector");
  await writeFile(cli, "original mock Core identity");
  await writeFile(path.join(root, "release/upstream-observer.json"), JSON.stringify(legacy));
  await writeFile(
    path.join(root, "crates/portcove-core/catalog/catalog.json"),
    JSON.stringify({ ports: h.input.ports.slice(0, 2) }),
  );
  const result = await runCatalogUpstreams(["--cli", cli], {
    root,
    inspectCatalog: async () =>
      new Map(h.input.ports.map((port) => [port.id, observationHash(port)])),
    now: h.options.now!,
    observer: { fetch: h.options.fetch! },
    log: () => {},
    repositoryMetadata: async () => assert.fail("Legacy exact source identity needs no lookup"),
    project: async (_cli, source, _directory, observation) => {
      await writeFile(cli, "changed mock Core identity");
      return h.options.project(source.port_id, source.repository_id, observation);
    },
  });
  assert.equal(result.report.completed_source_keys.length, 0);
  assert.equal(result.report.failures[0]!.rule, "core-identity");
  assert.ok(result.report.source_statuses.every((source) => !source.current_scope_complete));
});

void test("old embedded catalog policy cannot become current eligibility for a different reviewed definition", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  const next = await advanceCatalogObservations(h.input, first.checkpoint, {
    ...h.options,
    policyIdentity: "b".repeat(64),
    definitionHash: (portId) =>
      portId === "stable-port" ? "f".repeat(64) : h.options.definitionHash(portId),
  });
  const sharedKey = Object.entries(next.checkpoint.sources).find(
    ([, source]) => source.repository === "owner/shared",
  )![0];
  assert.ok(
    next.report.failures.some(
      (failure) => failure.source === sharedKey && failure.rule === "core-binding",
    ),
  );
  assert.equal(
    next.report.source_statuses.find((source) => source.repository === "owner/shared")!
      .current_scope_complete,
    false,
  );
  assert.deepEqual(
    next.checkpoint.sources[sharedKey]!.last_complete_policies,
    first.checkpoint.sources[sharedKey]!.last_complete_policies,
  );
});

for (const partial of [false, true]) {
  void test(`pre-guard ${partial ? "partial policies" : "completed scope"} cannot inherit normalized definition authority`, async () => {
    const h = harness();
    const first = await advanceCatalogObservations(h.input, null, h.options);
    const source = catalogObservationSources(h.input).sources.find(
      (source) => source.repository === "owner/shared",
    )!;
    const retained = first.checkpoint.sources[source.key]!;
    const oldBinding = observationHash({
      policy: h.options.policyIdentity,
      scope: source.scope_sha256,
    });
    const policies = retained.last_complete_policies.map((policy) => ({
      ...policy,
      catalog_definition_sha256: "f".repeat(64),
    }));
    retained.completed_scope_sha256 = oldBinding;
    retained.last_complete_policies = policies;
    retained.selection_progress = {
      binding: oldBinding,
      facts_sha256: retained.last_complete_facts_sha256!,
      cursor: 2,
      release_ids: [1, 2],
      sha256: observationHash([1, 2]),
    };
    if (partial) {
      retained.policy_progress = {
        binding: oldBinding,
        facts_sha256: retained.last_complete_facts_sha256!,
        policies: policies.slice(0, 1),
        sha256: observationHash(policies.slice(0, 1)),
      };
    }
    const before = h.network.length;
    const originalProject = h.options.project;
    let projections = 0;
    const next = await advanceCatalogObservations(h.input, first.checkpoint, {
      ...h.options,
      project: async (...args) => {
        projections++;
        return originalProject(...args);
      },
    });
    assert.equal(h.network.length, before);
    assert.equal(
      projections,
      4,
      "both ports need new header selection and final normalized policy",
    );
    assert.equal(next.report.completed_source_keys.length, 1);
    assert.notEqual(next.checkpoint.sources[source.key]!.completed_scope_sha256, oldBinding);
    assert.ok(
      next.checkpoint.sources[source.key]!.last_complete_policies.every(
        (policy) =>
          policy.catalog_definition_sha256 === h.options.definitionHash(String(policy.port_id)),
      ),
    );
  });
}

void test("a mismatched retained policy in a current binding is refused before acceptance", async () => {
  const h = harness();
  const first = await advanceCatalogObservations(h.input, null, h.options);
  const source = Object.values(first.checkpoint.sources).find(
    (source) => source.repository === "owner/shared",
  )!;
  const binding = source.completed_scope_sha256!;
  const policy = {
    ...source.last_complete_policies[0]!,
    catalog_definition_sha256: "f".repeat(64),
  };
  source.completed_scope_sha256 = null;
  source.policy_progress = {
    binding,
    facts_sha256: source.last_complete_facts_sha256!,
    policies: [policy],
    sha256: observationHash([policy]),
  };
  const next = await advanceCatalogObservations(h.input, first.checkpoint, h.options);
  assert.equal(next.report.completed_source_keys.length, 0);
  assert.equal(next.report.failures[0]!.rule, "invalid-checkpoint");
  assert.equal(
    next.report.source_statuses.find((source) => source.repository === "owner/shared")!
      .current_scope_complete,
    false,
  );
});

void test("observation bindings use the canonical normalized Core hash and retain legacy receipt identity", () => {
  const bytes = Buffer.from('{"ports":[]}');
  // These are intentionally different serialization contracts on the same normalized definition.
  const receipt = {
    format_version: 1,
    input_sha256: observationHash({ ports: [] }),
    input_bytes: bytes.length,
    ports: [
      {
        port_id: "stable-port",
        definition_sha256: "a".repeat(64),
        observation_definition_sha256: "b".repeat(64),
      },
    ],
  };
  assert.equal(
    catalogObservationDefinitionHashes(receipt, bytes).get("stable-port"),
    "b".repeat(64),
  );
  const oldReceipt = structuredClone(receipt) as {
    ports: { observation_definition_sha256?: string }[];
  };
  delete oldReceipt.ports[0]!.observation_definition_sha256;
  assert.throws(
    () => catalogObservationDefinitionHashes(oldReceipt, bytes),
    /definition identities/,
  );
  assert.throws(
    () => catalogObservationDefinitionHashes({ ...receipt, input_sha256: "c".repeat(64) }, bytes),
    /exact reviewed input/,
  );
});

void test("one fair catalog pipeline isolates GitLab failures, observes fixed pins and preserves numeric identities across refresh", async () => {
  const h = harness();
  const gitlab = {
    id: "gitlab-port",
    channels: ["stable"],
    release: { provider: "gitlab", repository: "owner/lab" },
  };
  const direct = {
    id: "direct-port",
    channels: ["stable"],
    release: {
      provider: "direct-manifest",
      direct: { windows: { url: "https://example.org/pin.zip" } },
    },
  };
  const catalog = { ports: [...h.input.ports, gitlab, direct] };
  let projectId = 27,
    fail = true;
  const options: CatalogObservationOptions = {
    ...h.options,
    definitionHash: (id) => observationHash(catalog.ports.find((port) => port.id === id)),
    providerFetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin === "https://example.org")
        return new Response(null, { headers: { "content-length": "123" } });
      if (fail) throw new Error("isolated GitLab failure");
      return new Response(
        JSON.stringify(
          url.pathname.endsWith("lab")
            ? { id: projectId, path_with_namespace: "owner/lab", archived: false }
            : [],
        ),
        {
          headers: {
            etag: '"fixed"',
            "x-page": url.searchParams.get("page") ?? "1",
            "x-per-page": "100",
            "x-next-page": "",
          },
        },
      );
    },
    projectProvider: async (id, observation) => ({
      format: 2,
      port_id: id,
      catalog_definition_sha256: observationHash(catalog.ports.find((port) => port.id === id)),
      facts_sha256: observation.facts_sha256,
      projections: [],
    }),
    exportProvider: async () => {},
  };
  const first = await advanceCatalogObservations(catalog, null, options);
  assert.equal(first.report.total_sources, 4);
  assert.equal(first.report.completed_source_keys.length, 3);
  assert.ok(first.report.failures.some((failure) => failure.rule === "provider-transport"));
  fail = false;
  const second = await advanceCatalogObservations(catalog, first.checkpoint, options);
  const source = catalogObservationSources(catalog).sources.find(
    (source) => source.provider === "gitlab",
  )!;
  assert.equal(second.checkpoint.sources[source.key]!.repository_id, 27);
  assert.equal(second.report.pending_source_keys.length, 0);
  const legacy = structuredClone(second.checkpoint);
  const oldProgress = legacy.sources[source.key]!.provider_progress!;
  oldProgress.format = 1;
  for (const read of oldProgress.reads) {
    delete read.page;
    delete read.per_page;
    read.next ??= "";
    read.sha256 = observationHash({
      url: read.url,
      method: read.method,
      body: read.body,
      status: read.status,
      next: read.next,
      content_length: read.content_length,
    });
  }
  legacy.sources[source.key]!.completed_scope_sha256 = "0".repeat(64);
  const migrated = await advanceCatalogObservations(catalog, legacy, options);
  assert.equal(migrated.checkpoint.sources[source.key]!.provider_progress!.format, 2);
  assert.equal(migrated.checkpoint.sources[source.key]!.provider_previous_progress!.format, 1);
  assert.equal(migrated.checkpoint.sources[source.key]!.repository_id, 27);
  assert.equal(migrated.report.pending_source_keys.length, 0);
  (gitlab.release as Record<string, unknown>).asset_hints = { windows: ["new-reviewed-hint"] };
  const changedScope = await advanceCatalogObservations(catalog, second.checkpoint, options);
  assert.equal(changedScope.report.pending_source_keys.length, 0);
  assert.ok(changedScope.checkpoint.sources[source.key]!.provider_previous_progress);
  assert.equal(changedScope.checkpoint.sources[source.key]!.repository_id, 27);
  projectId = 28;
  h.advanceClock(7 * 3600000);
  const replaced = await advanceCatalogObservations(catalog, changedScope.checkpoint, options);
  assert.ok(replaced.report.failures.some((failure) => failure.rule === "repository-identity"));
  assert.equal(replaced.checkpoint.sources[source.key]!.repository_id, 27);
  assert.equal(
    replaced.report.source_statuses.find((status) => status.repository === "owner/lab")!
      .current_scope_complete,
    false,
  );
});

void test("hosted opportunity drains accepted progress without retrying failed sources or hiding initial exceptions", async () => {
  const { continueCatalogBatches } = await import("./catalog-observer-continuation.mts");
  let turns = 0;
  const failure = {
    source: "broken",
    repository: "owner/broken",
    rule: "provider-transport",
    details: "original failure",
  };
  const result = await continueCatalogBatches(
    async (excluded) => {
      assert.equal(excluded.has("broken"), turns > 0);
      turns++;
      return {
        report: {
          pending_source_keys: turns < 7 ? ["large", "broken"] : ["broken"],
          attempted_source_keys: turns === 1 ? ["large", "broken"] : ["large"],
          completed_source_keys: turns === 7 ? ["large"] : [],
          failures: turns === 1 ? [failure] : [],
          requests: 12,
          response_bytes_charged: 120,
        },
        made_progress: true,
        handoff_exhausted: false,
        notify_exception: turns === 1,
      };
    },
    { deadline: 100, now: () => 0 },
  );
  assert.equal(result.batches, 7);
  assert.equal(result.notify_exception, true);
  assert.equal(result.report.requests, 84);
  assert.equal(result.report.response_bytes_charged, 840);
  assert.deepEqual(result.report.failures, [failure]);
  assert.deepEqual(result.report.pending_source_keys, ["broken"]);
  assert.deepEqual(result.report.completed_source_keys, ["large"]);
});

void test("hosted opportunity hands each batch only its remaining request allowance", async () => {
  const { continueCatalogBatches } = await import("./catalog-observer-continuation.mts");
  const limits: number[] = [];
  const result = await continueCatalogBatches(
    async (_excluded, requestLimit) => {
      limits.push(requestLimit);
      // A batch honours its allowance, as advanceCatalogObservations does.
      return {
        report: {
          pending_source_keys: ["large"],
          attempted_source_keys: ["large"],
          completed_source_keys: [],
          failures: [],
          requests: Math.min(300, requestLimit),
          response_bytes_charged: 10,
        },
        made_progress: true,
        handoff_exhausted: false,
        notify_exception: false,
      };
    },
    { deadline: 100, now: () => 0, maxRequests: 1000 },
  );
  // The ceiling is a hard total, not an admission threshold (#4779).
  assert.deepEqual(limits, [1000, 700, 400, 100]);
  assert.equal(result.report.requests, 1000);
  assert.deepEqual(result.report.pending_source_keys, ["large"]);
});

void test("opportunity refuses unknown capacity and stops on no accepted progress, byte exhaustion, deadline and cancellation", async () => {
  const { continueCatalogBatches } = await import("./catalog-observer-continuation.mts");
  const batch = {
    report: {
      pending_source_keys: ["large"],
      attempted_source_keys: ["large"],
      completed_source_keys: [],
      failures: [],
      requests: 100,
      response_bytes_charged: 1000,
    },
    made_progress: false,
    handoff_exhausted: false,
    notify_exception: false,
  };
  let calls = 0;
  assert.equal(
    (
      await continueCatalogBatches(
        async () => {
          calls++;
          return batch;
        },
        { deadline: 10, now: () => 0 },
      )
    ).batches,
    1,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await continueCatalogBatches(
        async () => ({ ...batch, made_progress: true, handoff_exhausted: true }),
        { deadline: 10, now: () => 0 },
      )
    ).batches,
    1,
  );
  let now = 0;
  assert.equal(
    (
      await continueCatalogBatches(
        async () => {
          now = 10;
          return { ...batch, made_progress: true };
        },
        { deadline: 10, now: () => now },
      )
    ).batches,
    1,
  );
  await assert.rejects(
    continueCatalogBatches(async () => batch, { deadline: NaN }),
    /unavailable/,
  );
  const controller = new AbortController();
  await assert.rejects(
    continueCatalogBatches(
      async () => {
        controller.abort();
        return { ...batch, made_progress: true };
      },
      { deadline: 10, now: () => 0, signal: controller.signal },
    ),
    /cancelled/,
  );
  await assert.rejects(
    continueCatalogBatches(
      async () => ({
        ...batch,
        report: {
          ...batch.report,
          failures: [
            {
              source: "large",
              repository: "owner/large",
              rule: "budget",
              details: "large diagnostic",
            },
          ],
        },
      }),
      { deadline: 10, now: () => 0, evidenceByteLimit: 1 },
    ),
    /evidence envelope/,
  );
});

void test("accepted checkpoint advancement ignores request counts, clocks, cleared pages and sequence-only changes", async () => {
  const {
    acceptedObservationPosition: position,
    acceptedObservationAdvanced: advanced,
    catalogProgressPosition: catalogPosition,
    catalogPositionAdvanced: catalogAdvanced,
  } = await import("./catalog-observer-continuation.mts");
  const a = position({ continuation: { pages: { a: {} }, validation_cursor: 0 } });
  assert.equal(
    advanced(
      a,
      position({ continuation: { pages: { a: {} }, validation_cursor: 0 }, requests: 1000 }),
    ),
    false,
  );
  assert.equal(
    advanced(a, position({ continuation: { phase: "restart", pages: { a: {}, b: {} } } })),
    false,
  );
  assert.equal(advanced(a, position({ continuation: { pages: { a: {}, b: {} } } })), true);
  // Changed last-good facts advance only without a stated incomplete coverage.
  const facts = (sha: string, kind?: string) =>
    position({
      last_complete: {
        observation: { facts_sha256: sha },
        projection: kind ? { fact_provenance: { coverage: { kind } } } : {},
      },
    });
  assert.equal(advanced(facts("a", "complete"), facts("b", "complete")), true);
  assert.equal(advanced(facts("a"), facts("b")), true);
  for (const kind of ["partial", "failed", "unavailable", "invented"])
    assert.equal(advanced(facts("a", "complete"), facts("b", kind)), false, kind);
  const { coreProjectionCoverage, requireCompleteCoreCoverage } =
    await import("./catalog-observer-continuation.mts");
  assert.equal(coreProjectionCoverage({}), "unstated");
  assert.equal(
    coreProjectionCoverage({ fact_provenance: { coverage: { kind: "partial" } } }),
    "partial",
  );
  assert.equal(coreProjectionCoverage({ fact_provenance: { coverage: { kind: 7 } } }), "failed");
  requireCompleteCoreCoverage({ fact_provenance: { coverage: { kind: "complete" } } });
  assert.throws(
    () => requireCompleteCoreCoverage({ fact_provenance: { coverage: { kind: "partial" } } }),
    (error: unknown) => error instanceof ObservationFailure && error.rule === "incomplete-coverage",
  );
  assert.equal(
    advanced(a, position({ continuation: { pages: { a: {} }, validation_cursor: 1 } })),
    true,
  );
  const baseline = catalogPosition({
    sources: {
      a: {
        repository_id: 7,
        attempted_sequence: 1,
        next_due_at: "old",
        selection_progress: { binding: "b", facts_sha256: "f", cursor: 1 },
      },
    },
  });
  assert.equal(
    catalogAdvanced(
      baseline,
      catalogPosition({
        sources: {
          a: {
            repository_id: 7,
            attempted_sequence: 200,
            next_due_at: "new",
            selection_progress: { binding: "b", facts_sha256: "f", cursor: 1 },
          },
        },
      }),
    ),
    false,
  );
  assert.equal(
    catalogAdvanced(
      baseline,
      catalogPosition({
        sources: {
          a: {
            repository_id: 7,
            selection_progress: { binding: "b", facts_sha256: "f", cursor: 2 },
          },
        },
      }),
    ),
    true,
  );
  assert.equal(
    catalogAdvanced(
      baseline,
      catalogPosition({ sources: { a: { repository_id: 7, selection_progress: null } } }),
    ),
    false,
  );
});

void test("hosted opportunity wires its request ceiling into every batch (#4779)", async (t) => {
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "catalog-opportunity-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness(4);
  await mkdir(path.join(root, "release"), { recursive: true });
  await mkdir(path.join(root, "crates/portcove-core/catalog"), { recursive: true });
  await writeFile(
    path.join(root, "crates/portcove-core/catalog/listings.json"),
    JSON.stringify({ format_version: 1, listings: [] }),
  );
  const cli = path.join(root, "inspector"),
    catalog = path.join(root, "crates/portcove-core/catalog/catalog.json");
  await writeFile(cli, "fixture inspector identity; native execution is mocked");
  await writeFile(
    path.join(root, "release/upstream-observer.json"),
    JSON.stringify(h.options.config),
  );
  await writeFile(catalog, JSON.stringify(h.input));
  const runtime = {
    root,
    deadline: h.options.now!() + 500000,
    now: h.options.now!,
    inspectCatalog: async () =>
      new Map(h.input.ports.map((port) => [port.id, observationHash(port)])),
    observer: { fetch: h.options.fetch!, sleep: h.options.sleep! },
    project: async (
      _cli: string,
      config: Parameters<typeof h.options.load>[0],
      _directory: string,
      observation: Parameters<typeof h.options.project>[2],
    ) => h.options.project(config.port_id, config.repository_id, observation),
    repositoryMetadata: async (repository: string) => {
      const body = {
        id: repository === "owner/shared" ? 7 : 8,
        full_name: repository,
        archived: false,
      };
      return {
        status: 200,
        headers: new Map<string, string>(),
        body,
        bodyBytes: Buffer.byteLength(JSON.stringify(body)),
      };
    },
    log: () => {},
  };
  // Each batch's template budget is 4 requests. Without the wiring, two batches
  // would spend 8 against a ceiling of 6; with it the second receives only 2.
  const result = await runCatalogOpportunity(["--cli", cli], { ...runtime, requestCeiling: 6 });
  assert.ok(result.batches >= 2, String(result.batches));
  assert.equal(result.report.requests, 6);
});

void test("hosted opportunity preserves one aggregate handoff and refuses changed catalog after accepted progress", async (t) => {
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "catalog-opportunity-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = harness(4);
  await mkdir(path.join(root, "release"), { recursive: true });
  await mkdir(path.join(root, "crates/portcove-core/catalog"), { recursive: true });
  await writeFile(
    path.join(root, "crates/portcove-core/catalog/listings.json"),
    JSON.stringify({ format_version: 1, listings: [] }),
  );
  const cli = path.join(root, "inspector"),
    catalog = path.join(root, "crates/portcove-core/catalog/catalog.json");
  await writeFile(cli, "fixture inspector identity; native execution is mocked");
  await writeFile(
    path.join(root, "release/upstream-observer.json"),
    JSON.stringify(h.options.config),
  );
  await writeFile(catalog, JSON.stringify(h.input));
  const runtime = {
    root,
    deadline: h.options.now!() + 500000,
    now: h.options.now!,
    inspectCatalog: async () =>
      new Map(h.input.ports.map((port) => [port.id, observationHash(port)])),
    observer: { fetch: h.options.fetch!, sleep: h.options.sleep! },
    project: async (
      _cli: string,
      config: Parameters<typeof h.options.load>[0],
      _directory: string,
      observation: Parameters<typeof h.options.project>[2],
    ) => h.options.project(config.port_id, config.repository_id, observation),
    repositoryMetadata: async (repository: string) => {
      const body = {
        id: repository === "owner/shared" ? 7 : 8,
        full_name: repository,
        archived: false,
      };
      return {
        status: 200,
        headers: new Map<string, string>(),
        body,
        bodyBytes: Buffer.byteLength(JSON.stringify(body)),
      };
    },
    log: () => {},
  };
  const result = await runCatalogOpportunity(["--cli", cli], runtime);
  assert.ok(result.batches > 1);
  assert.equal(result.report.pending_source_keys.length, 0);
  const files = await readdir(result.handoff_directory);
  assert.equal(files.length, 3);
  const actualBytes = (
    await Promise.all(
      files
        .filter((name) => name !== "summary.json")
        .map((name) => readFile(path.join(result.handoff_directory, name))),
    )
  ).reduce((sum, bytes) => sum + bytes.length, 0);
  assert.equal((result.summary as { artifact_bytes: number }).artifact_bytes, actualBytes);
  // The hosted path wires its own aggregate handoff envelope into the summary.
  assert.equal(
    (result.summary as { artifact_byte_limit: number }).artifact_byte_limit,
    hostedHandoffByteLimit +
      h.options.config.budget.response_bytes +
      observerStreamingSnapshotLimit,
  );
  h.advanceClock(7 * 3600000);
  runtime.deadline = h.options.now!() + 500000;
  let changed = false;
  runtime.log = () => {
    if (!changed) {
      changed = true;
      h.input.ports[0]!.channels = ["beta"];
    }
  };
  // A changed file is detected after the collector before any subsequent batch.
  const originalProject = runtime.project;
  runtime.project = async (...args) => {
    const value = await originalProject(...args);
    await writeFile(catalog, JSON.stringify({ ...h.input, change: true }));
    return value;
  };
  await assert.rejects(
    runCatalogOpportunity(["--cli", cli], runtime),
    /changed between bounded batches/,
  );
  const directories = await readdir(path.join(root, "work/upstream-observer-handoff"));
  assert.equal(directories.length, 2);
  const failedDirectory = directories.find(
    (name) => path.join(root, "work/upstream-observer-handoff", name) !== result.handoff_directory,
  )!;
  const retained = await readdir(
    path.join(root, "work/upstream-observer-handoff", failedDirectory),
  );
  assert.ok(retained.length > 1);
  const failureSummary = JSON.parse(
    await readFile(
      path.join(root, "work/upstream-observer-handoff", failedDirectory, "summary.json"),
      "utf8",
    ),
  ) as { coverage: string };
  assert.match(failureSummary.coverage, /partial; operation failed/);
});

void test("Core subprocess inspection refuses an expired or unknown remaining opportunity before execution", async (t) => {
  const { inspectCatalogDefinitions } = await import("./observe-configured-upstream.mts");
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(path.join(work, "catalog-inspection-admission-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const deadline of [0, NaN]) {
    await assert.rejects(
      inspectCatalogDefinitions(path.join(root, "must-not-execute"), root, Buffer.from("{}"), {
        deadline,
        now: () => 1,
      }),
      /Core inspection admission exhausted/,
    );
  }
  assert.deepEqual(await readdir(root), []);
});

void test(
  "a Core subprocess cut short by the batch deadline is budget continuation",
  { skip: process.platform === "win32" },
  async (t) => {
    const { inspectCatalogDefinitions } = await import("./observe-configured-upstream.mts");
    const work = fileURLToPath(new URL("../work/", import.meta.url));
    await mkdir(work, { recursive: true });
    const root = await mkdtemp(path.join(work, "catalog-inspection-deadline-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const inspector = path.join(root, "inspector");
    await writeFile(inspector, "#!/bin/sh\nexec sleep 1\n", { mode: 0o700 });
    await assert.rejects(
      inspectCatalogDefinitions(inspector, root, Buffer.from("{}"), {
        deadline: 25,
        now: () => 0,
      }),
      (error: unknown) => error instanceof ObservationFailure && error.rule === "budget",
    );
    await writeFile(inspector, "#!/bin/sh\nexit 2\n");
    await assert.rejects(
      inspectCatalogDefinitions(inspector, root, Buffer.from("{}"), {
        deadline: 500,
        now: () => 0,
      }),
      (error: unknown) => isRecord(error) && error.status === 2,
    );
    assert.deepEqual(await readdir(root), ["inspector"]);
  },
);

void test("original failure details are published before aggregate diagnostic refusal", async () => {
  const { continueCatalogBatches } = await import("./catalog-observer-continuation.mts");
  const failure = {
    source: "large",
    repository: "owner/large",
    rule: "provider-transport",
    details: "original provider refusal",
  };
  const logged: unknown[] = [];
  await assert.rejects(
    continueCatalogBatches(
      async () => ({
        report: {
          pending_source_keys: ["large"],
          attempted_source_keys: ["large"],
          completed_source_keys: [],
          failures: [failure],
          requests: 1,
          response_bytes_charged: 0,
        },
        made_progress: true,
        handoff_exhausted: false,
        notify_exception: true,
      }),
      {
        deadline: 10,
        now: () => 0,
        evidenceByteLimit: 1,
        onBatch: (batch) => {
          logged.push(...batch.report.failures);
        },
      },
    ),
    /evidence envelope/,
  );
  assert.deepEqual(logged, [failure]);
});

void test("descriptive consumers share one repository collection without managed inspector calls", async () => {
  const h = harness();
  const listings = ["descriptive-one", "descriptive-two"].map((id) => ({
    id,
    name: id,
    summary: id,
    project_url: "https://github.com/owner/shared",
    availability: "unknown",
  }));
  const catalog = { ...h.input, listings };
  const plan = catalogObservationSources(catalog);
  assert.equal(plan.sources.length, 2);
  assert.equal(
    plan.sources.find((source) => source.repository === "owner/shared")!.ports.length,
    4,
  );
  const originalProject = h.options.project;
  const managedCalls: string[] = [];
  h.options.project = async (...args) => {
    managedCalls.push(args[0]);
    assert.ok(!args[0].startsWith("descriptive"));
    return originalProject(...args);
  };
  let state: CatalogObserverCheckpoint | null = null;
  for (let index = 0; index < 20; index++) {
    const result = await advanceCatalogObservations(catalog, state, h.options);
    state = result.checkpoint;
    if (!result.report.pending_source_keys.length) break;
  }
  const policies = Object.values(state!.sources).flatMap((source) => source.last_complete_policies);
  for (const listing of listings) {
    const policy = policies.find((policy) => policy.port_id === listing.id)!;
    assert.equal(policy.authority, "descriptive-listing-observation-only");
    assert.deepEqual(policy.projections, []);
    assert.ok(policy.listing_update);
  }
  assert.ok(managedCalls.length > 0);
  assert.equal(h.network.filter((url) => url === "identity:owner/shared").length, 1);
});

void test("Core rebuilds retain pure listing completion and invalidate exact managed and mixed scopes", async () => {
  const h = harness();
  const catalog = {
    ...h.input,
    listings: [
      { id: "pure-description", project_url: "https://github.com/owner/pure" },
      { id: "mixed-description", project_url: "https://github.com/owner/shared" },
    ],
  };
  const sources = catalogObservationSources(catalog).sources;
  const pure = sources.find((source) => source.repository === "owner/pure")!;
  const managed = sources.filter((source) => source.key !== pure.key);
  const originalFetch = h.options.fetch!;
  h.options.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/owner/pure")) {
      return Response.json({ id: 8, full_name: "owner/pure", archived: false });
    }
    return originalFetch(input, init);
  };
  const previousBinding = (source: (typeof sources)[number], policy = h.options.policyIdentity) =>
    observationHash({
      contract: "normalized-current-catalog-core-policy-v1",
      policy,
      scope: source.scope_sha256,
      definitions: source.ports.map((port) => [
        port.id,
        port.kind === "listing" ? port.definition_sha256 : h.options.definitionHash(port.id),
      ]),
    });
  const first = await advanceCatalogObservations(catalog, null, h.options);
  assert.deepEqual(first.report.failures, []);
  for (const source of managed) {
    assert.equal(
      first.checkpoint.sources[source.key]!.completed_scope_sha256,
      previousBinding(source),
    );
  }
  const pureProgress = first.checkpoint.sources[pure.key]!;
  assert.ok(pureProgress.completed_scope_sha256);
  const initialInputs = first.report.scope_binding_inputs;
  const managedSource = managed[0]!;
  const definitionSet = managedSource.ports.map((port) => [
    port.id,
    port.kind === "listing" ? port.definition_sha256 : h.options.definitionHash(port.id),
  ]);
  assert.equal(initialInputs.core_executable_sha256, h.options.policyIdentity);
  assert.equal(initialInputs.listing_stale_after_hours, h.options.config.stale_after_hours);
  assert.deepEqual(initialInputs.sources[managedSource.key], {
    contract: "normalized-current-catalog-core-policy-v1",
    provider_proof: null,
    source_sha256: managedSource.scope_sha256,
    definitions_sha256: observationHash(definitionSet),
    current_sha256: previousBinding(managedSource),
    retained_sha256: previousBinding(managedSource),
  });
  assert.equal(initialInputs.sources[pure.key]?.definitions_sha256, null);
  assert.equal(
    pureProgress.last_complete_policies[0]!.authority,
    "descriptive-listing-observation-only",
  );
  assert.deepEqual(pureProgress.last_complete_policies[0]!.projections, []);

  h.advanceClock(1000);
  const held = await advanceCatalogObservations(catalog, structuredClone(first.checkpoint), {
    ...h.options,
    policyIdentity: "b".repeat(64),
    excludedSources: new Set(sources.map(({ key }) => key)),
  });
  const heldInputs = held.report.scope_binding_inputs;
  assert.equal(heldInputs.core_executable_sha256, "b".repeat(64));
  assert.deepEqual(heldInputs.sources[pure.key], initialInputs.sources[pure.key]);
  assert.deepEqual(heldInputs.sources[managedSource.key], {
    ...initialInputs.sources[managedSource.key],
    current_sha256: previousBinding(managedSource, "b".repeat(64)),
  });

  const rebuilt = await advanceCatalogObservations(catalog, first.checkpoint, {
    ...h.options,
    policyIdentity: "b".repeat(64),
    requestLimit: 0,
  });
  assert.deepEqual(rebuilt.report.failures, []);
  assert.equal(rebuilt.report.requests, 0);
  assert.deepEqual(
    rebuilt.report.attempted_source_keys.toSorted(),
    managed.map(({ key }) => key).toSorted(),
  );
  assert.deepEqual(rebuilt.checkpoint.sources[pure.key], pureProgress);

  const officialSetupOnly = {
    ...catalog,
    listings: catalog.listings.map((listing) =>
      listing.id === "pure-description"
        ? { ...listing, official_setup_id: "reviewed-setup" }
        : listing,
    ),
  };
  const withSetup = await advanceCatalogObservations(officialSetupOnly, rebuilt.checkpoint, {
    ...h.options,
    policyIdentity: "b".repeat(64),
    requestLimit: 0,
  });
  assert.deepEqual(withSetup.report.attempted_source_keys, []);
  assert.equal(withSetup.report.requests, 0);
  assert.deepEqual(withSetup.checkpoint.sources[pure.key], pureProgress);

  for (const source of managed) {
    assert.equal(
      rebuilt.checkpoint.sources[source.key]!.completed_scope_sha256,
      previousBinding(source, "b".repeat(64)),
    );
  }

  const legacy = structuredClone(first.checkpoint);
  const priorPure = legacy.sources[pure.key]!;
  priorPure.completed_scope_sha256 = previousBinding(pure);
  priorPure.change_intervals = 2;
  priorPure.mean_change_interval_ms = 20 * 3600000;
  priorPure.next_due_at = new Date(h.options.now!() + 8 * 3600000).toISOString();
  const deferred = await advanceCatalogObservations(catalog, legacy, {
    ...h.options,
    excludedSources: new Set(sources.map(({ key }) => key)),
  });
  assert.equal(
    deferred.report.source_statuses.find((source) => source.source_key === pure.key)
      ?.current_scope_complete,
    false,
  );
  const reprojected = await advanceCatalogObservations(catalog, deferred.checkpoint, {
    ...h.options,
    requestLimit: 0,
  });
  assert.deepEqual(reprojected.report.failures, []);
  assert.deepEqual(reprojected.report.completed_source_keys, [pure.key]);
  assert.equal(reprojected.report.requests, 0);
  const currentPure = reprojected.checkpoint.sources[pure.key]!;
  assert.equal(currentPure.completed_scope_sha256, pureProgress.completed_scope_sha256);
  for (const key of [
    "last_complete_facts_sha256",
    "freshness_observed_at",
    "completed_at",
    "last_change_at",
    "change_intervals",
    "mean_change_interval_ms",
    "next_due_at",
  ] as const)
    assert.equal(currentPure[key], priorPure[key], key);

  const revised = await advanceCatalogObservations(catalog, reprojected.checkpoint, {
    ...h.options,
    config: { ...h.options.config, stale_after_hours: 24 },
    excludedSources: new Set([pure.key]),
  });
  assert.equal(
    revised.report.source_statuses.find((source) => source.source_key === pure.key)
      ?.current_scope_complete,
    false,
  );

  priorPure.next_due_at = new Date(h.options.now!()).toISOString();
  const due = await advanceCatalogObservations(catalog, legacy, { ...h.options, requestLimit: 0 });
  assert.ok(!due.report.attempted_source_keys.includes(pure.key));
  assert.equal(due.checkpoint.sources[pure.key]!.completed_scope_sha256, previousBinding(pure));
  const refreshed = await advanceCatalogObservations(catalog, due.checkpoint, h.options);
  assert.ok(refreshed.report.requests > 0);
  assert.ok(refreshed.report.completed_source_keys.includes(pure.key));
  assert.equal(
    refreshed.checkpoint.sources[pure.key]!.freshness_observed_at,
    new Date(h.options.now!()).toISOString(),
  );
});

void test("binding diagnostics fit the summary budget without removing source coverage", () => {
  const summary = { source_statuses: ["source"], scope_binding_inputs: { value: "入力" } };
  const bytes = Buffer.byteLength(JSON.stringify(summary));
  assert.deepEqual(omitOversizedBindingInputs(summary, bytes), summary);
  assert.deepEqual(omitOversizedBindingInputs(summary, bytes - 1), {
    source_statuses: ["source"],
  });
});

void test("descriptive projection retains asset identity without manufacturing package or managed eligibility", async () => {
  const { projectListingObservation, listingDeclarationHash } =
    await import("./listing-upstream-observation.mts");
  const h = harness();
  await advanceCatalogObservations(h.input, null, h.options);
  const observed = h.exported.find((entry) => entry[0].repository === "owner/shared")![2].report
    .observation! as ProviderObservation;
  const listing = {
    id: "description",
    project_url: "https://github.com/owner/shared",
    availability: "unknown",
    download_asset_hints: { "windows-x86-64": ["windows", "x64"] },
  };
  const report = projectListingObservation(listing, observed, 12);
  assert.equal(report.authority, "descriptive-listing-observation-only");
  assert.deepEqual(report.projections, []);
  assert.equal(report.listing_update.availability, "unknown");
  assert.equal(report.listing_update.upstream_observation.status, "complete");
  assert.equal(report.listing_update.upstream_observation.facts_sha256, observed.facts_sha256);
  assert.equal(
    listingDeclarationHash(report.listing_update),
    listingDeclarationHash(listing),
    "accepting an observation does not invalidate its unchanged declaration",
  );
  assert.notEqual(
    listingDeclarationHash({ ...listing, name: "Correction" }),
    listingDeclarationHash(listing),
  );
});

void test("failed descriptive refresh preserves current authored restrictions and old fact clocks", async () => {
  const { projectListingObservation, listingUpdatesForReport } =
    await import("./listing-upstream-observation.mts");
  const h = harness();
  await advanceCatalogObservations(h.input, null, h.options);
  const observed = h.exported.find((entry) => entry[0].repository === "owner/shared")![2].report
    .observation! as ProviderObservation;
  const original = {
    id: "description",
    project_url: "https://github.com/owner/shared",
    name: "Old name",
    download_block_reason: "Old restriction",
  };
  const policy = projectListingObservation(original, observed, 12);
  const current = {
    ...original,
    name: "Corrected name",
    download_block_reason: "Current exact restriction",
    manual_setup: { steps: [] },
  };
  const attempt = "2026-10-28T00:00:00Z";
  const updates = listingUpdatesForReport(
    [policy],
    { exception: { rule: "provider-unavailable" } },
    attempt,
    { repository: "owner/shared", ports: [{ listing: current }] },
  );
  assert.equal(updates[0]!.name, "Corrected name");
  assert.equal(updates[0]!.download_block_reason, "Current exact restriction");
  assert.deepEqual(updates[0]!.manual_setup, { steps: [] });
  assert.deepEqual(updates[0]!.upstream_observation, {
    ...policy.listing_update.upstream_observation,
    attempted_at: attempt,
    status: "unavailable",
  });
  const firstFailure = listingUpdatesForReport(
    [],
    { exception: { rule: "invalid-metadata" } },
    attempt,
    { repository: "owner/shared", ports: [{ listing: current }] },
  );
  assert.equal(firstFailure[0]!.upstream_observation.observed_at, null);
  assert.equal(firstFailure[0]!.upstream_observation.facts_sha256, null);
  assert.deepEqual(firstFailure[0]!.upstream_observation.releases, []);
});

void test("descriptive release windows and pin reconsideration are bounded observations", async () => {
  const { projectListingObservation, listingObservationReleaseIds } =
    await import("./listing-upstream-observation.mts");
  const h = harness();
  await advanceCatalogObservations(h.input, null, h.options);
  const observed = structuredClone(
    h.exported.find((entry) => entry[0].repository === "owner/shared")![2].report
      .observation! as ProviderObservation,
  );
  const listing = {
    id: "description",
    project_url: "https://github.com/owner/shared",
    release_maintenance: {
      reason: "Retained quickstates",
      reconsider_when: "Bounded original/save/launch assessment",
      pinned_releases: [{ version: "older", published_at: "2020-01-01T00:00:00Z" }],
    },
  };
  const report = projectListingObservation(listing, observed, 12);
  assert.equal(report.pin_reconsideration?.status, "newer-release-observed");
  assert.deepEqual(report.projections, []);
  const incomplete = {
    ...observed,
    format: 2,
    coverage: {
      kind: "channel-candidate-assets" as const,
      complete_release_headers: true as const,
      asset_release_ids: [],
    },
  };
  assert.equal(
    projectListingObservation(listing, incomplete, 12).listing_update.upstream_observation.status,
    "incomplete",
  );
  const invalid = structuredClone(observed);
  invalid.facts.releases[0]!.draft = false;
  invalid.facts.releases[0]!.published_at = null;
  assert.throws(() => listingObservationReleaseIds(invalid), /publication clock/);
  invalid.facts.releases[0]!.draft = true;
  assert.ok(!listingObservationReleaseIds(invalid).includes(invalid.facts.releases[0]!.id));
});

void test("failed refresh invalidates only derived platform labels after authored hint correction", async () => {
  const { listingUpdatesForReport } = await import("./listing-upstream-observation.mts");
  const fact = {
    repository: "owner/shared",
    observed_at: "2026-10-27T00:00:00Z",
    fresh_until: "2026-10-27T12:00:00Z",
    facts_sha256: "a".repeat(64),
    releases: [
      {
        id: 1,
        assets: [
          {
            id: 2,
            name: "old-windows-x64.zip",
            sha256: "b".repeat(64),
            platform_hints: ["windows-x86-64"],
          },
        ],
      },
    ],
  };
  const current = {
    id: "description",
    download_asset_hints: { "windows-x86-64": ["new-layout", "windows", "x64"] },
  };
  const candidate = listingUpdatesForReport(
    [{ port_id: "description", listing_update: { ...current, upstream_observation: fact } }],
    { exception: { rule: "provider-unavailable" } },
    "2026-10-28T00:00:00Z",
    { repository: "owner/shared", ports: [{ listing: current }] },
  )[0]!;
  assert.deepEqual(candidate.upstream_observation.releases, [
    {
      id: 1,
      assets: [{ id: 2, name: "old-windows-x64.zip", sha256: "b".repeat(64), platform_hints: [] }],
    },
  ]);
  assert.equal(candidate.upstream_observation.observed_at, fact.observed_at);
  assert.equal(candidate.upstream_observation.fresh_until, fact.fresh_until);
  assert.equal(candidate.upstream_observation.facts_sha256, fact.facts_sha256);
});

void test(
  "repository identity lookup aborts the actual SDK fetch with its command",
  { timeout: 30000 },
  async (t) => {
    for (const [name, run] of [
      ["batch", runCatalogUpstreams],
      ["opportunity", runCatalogOpportunity],
    ] as const)
      await t.test(name, async (t) => {
        const work = fileURLToPath(new URL("../work/", import.meta.url));
        await mkdir(work, { recursive: true });
        const root = await mkdtemp(path.join(work, "catalog-identity-cancel-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const originalGh = process.env.GH_TOKEN,
          originalGitHub = process.env.GITHUB_TOKEN;
        process.env.GH_TOKEN = process.env.GITHUB_TOKEN = "synthetic-cancelled-identity";
        t.after(() => {
          if (originalGh === undefined) delete process.env.GH_TOKEN;
          else process.env.GH_TOKEN = originalGh;
          if (originalGitHub === undefined) delete process.env.GITHUB_TOKEN;
          else process.env.GITHUB_TOKEN = originalGitHub;
        });
        const h = harness();
        await mkdir(path.join(root, "release"), { recursive: true });
        await mkdir(path.join(root, "crates/portcove-core/catalog"), { recursive: true });
        await writeFile(
          path.join(root, "release/upstream-observer.json"),
          JSON.stringify(h.options.config),
        );
        await writeFile(
          path.join(root, "crates/portcove-core/catalog/catalog.json"),
          JSON.stringify({ ports: h.input.ports.slice(0, 1) }),
        );
        await writeFile(
          path.join(root, "crates/portcove-core/catalog/listings.json"),
          JSON.stringify({ format_version: 1, listings: [] }),
        );
        const cli = path.join(root, "inspector");
        await writeFile(cli, "inert controlled inspector");
        const controller = new AbortController();
        let dispatched!: () => void,
          drain!: () => void,
          aborted = false,
          calls = 0,
          projections = 0;
        const entered = new Promise<void>((resolve) => {
          dispatched = resolve;
        });
        t.mock.method(
          globalThis,
          "fetch",
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            calls++;
            const url =
              input instanceof Request ? input.url : input instanceof URL ? input.href : input;
            assert.equal(url, "https://api.github.com/repos/owner/shared");
            assert.ok(init?.signal);
            return await new Promise<Response>((_resolve, reject) => {
              drain = () => reject(new Error("controlled fixture cleanup"));
              init.signal!.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(init.signal!.reason);
                },
                { once: true },
              );
              dispatched();
            });
          },
        );
        const completed = run(["--cli", cli], {
          root,
          deadline: h.options.now!() + 60000,
          now: h.options.now!,
          observer: { signal: controller.signal },
          inspectCatalog: async () =>
            new Map(h.input.ports.map((port) => [port.id, observationHash(port)])),
          project: async () => {
            projections++;
            assert.fail("cancelled identity cannot project facts");
          },
          log: () => {},
        }).then(
          (value) => ({ status: "resolved" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        try {
          await Promise.race([
            entered,
            completed.then(() => assert.fail("identity did not reach the configured SDK")),
          ]);
          controller.abort();
          assert.equal(aborted, true, "command cancellation must reach the pending SDK fetch");
          const result = await completed;
          assert.equal(calls, 1);
          assert.equal(projections, 0);
          if (result.status === "resolved")
            assert.equal(result.value.report.failures[0]?.rule, "cancelled");
          else
            assert.ok(
              result.error instanceof Error &&
                "rule" in result.error &&
                result.error.rule === "cancelled",
            );
        } finally {
          controller.abort();
          drain?.();
          await completed;
        }
      });
  },
);

void test("GitLab descriptive listings reuse the provider collector and export native tags plus exact registry candidates", async () => {
  const h = harness();
  const listing = {
    id: "lab-description",
    project_url: "https://gitlab.com/owner/subgroup/lab",
    release_url: "https://gitlab.com/owner/subgroup/lab/-/releases",
    availability: "unknown",
    download_asset_hints: { "windows-x86-64": ["windows", "x64"] },
  };
  const catalog = { ports: [], listings: [listing] };
  const calls: string[] = [];
  let exported: unknown[] = [];
  let providerObservations: Record<string, unknown>[] = [];
  const options: CatalogObservationOptions = {
    ...h.options,
    projectProvider: async () => {
      throw new Error("Descriptive listing must never enter managed Core policy");
    },
    providerFetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push(url.href);
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      const body = url.pathname.endsWith("/releases")
        ? [
            {
              tag_name: "v1.2.0",
              upcoming_release: false,
              released_at: "2026-10-26T00:00:00Z",
              assets: {
                links: [
                  {
                    id: 5,
                    url: "https://gitlab.com/owner/subgroup/lab/-/package_files/301/download",
                  },
                ],
              },
            },
          ]
        : url.pathname.endsWith("/packages")
          ? [{ id: 101, name: "game", version: "1.2.0" }]
          : url.pathname.endsWith("/package_files")
            ? [
                {
                  id: 301,
                  file_name: "game-windows-x64.zip",
                  size: 42,
                  file_sha256: "a".repeat(64),
                },
              ]
            : { id: 27, path_with_namespace: "owner/subgroup/lab", archived: false };
      return new Response(JSON.stringify(body), {
        headers: { "x-page": "1", "x-per-page": "100", "x-next-page": "" },
      });
    },
    exportProvider: async (_source, observations, policies) => {
      exported = policies;
      providerObservations = observations;
    },
  };
  const result = await advanceCatalogObservations(catalog, null, options);
  assert.deepEqual(result.report.failures, []);
  assert.equal(result.report.completed_source_keys.length, 1);
  assert.equal(calls.length, 4);
  assert.equal(exported.length, 1);
  assert.ok(isRecord(exported[0]));
  const policy = exported[0];
  assert.equal(policy.authority, "descriptive-listing-observation-only");
  assert.deepEqual(policy.projections, []);
  assert.ok(isRecord(policy.listing_update));
  assert.equal(policy.listing_update.availability, "unknown");
  const observation = policy.listing_update.upstream_observation as Record<string, unknown>;
  assert.equal(observation.provider, "gitlab");
  assert.equal(observation.repository_id, 27);
  assert.equal(observation.status, "complete");
  const release = (observation.releases as Record<string, unknown>[])[0]!;
  assert.deepEqual(release.id, { provider: "gitlab", project_id: 27, tag: "v1.2.0" });
  assert.equal(release.release_url, "https://gitlab.com/owner/subgroup/lab/-/releases/v1.2.0");
  assert.deepEqual(release.assets, [
    {
      id: 301,
      name: "game-windows-x64.zip",
      size: 42,
      sha256: "a".repeat(64),
      platform_hints: ["windows-x86-64"],
      url: "https://gitlab.com/api/v4/projects/27/packages/generic/game/1.2.0/game-windows-x64.zip",
    },
  ]);
  const key = result.report.completed_source_keys[0]!;
  let registryRequests = 0;
  let gitLabRequests = 0;
  const bounded = await advanceCatalogObservations(catalog, null, {
    ...options,
    requestLimit: 2,
    exportProvider: async () => {},
    modProviderRegistryFetch: async () => {
      registryRequests++;
      return new Response(null, { status: 429, headers: { "retry-after": "120" } });
    },
    providerFetch: async () => {
      gitLabRequests++;
      return Response.json({ id: 27, path_with_namespace: "owner/subgroup/lab", archived: false });
    },
  });
  assert.equal(registryRequests, 1);
  assert.equal(gitLabRequests, 1);
  assert.equal(bounded.report.requests, 2);
  h.advanceClock(1000);
  const rebuilt = await advanceCatalogObservations(catalog, result.checkpoint, {
    ...options,
    policyIdentity: "b".repeat(64),
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(rebuilt.report.attempted_source_keys, []);
  assert.deepEqual(rebuilt.checkpoint.sources[key], result.checkpoint.sources[key]);
  assert.equal(rebuilt.report.source_statuses[0]!.current_scope_complete, true);

  const legacy = structuredClone(result.checkpoint);
  const prior = legacy.sources[key]!;
  prior.completed_scope_sha256 = "f".repeat(64);
  const providerCompletion = providerObservations[0]?.completed_at;
  assert.equal(typeof providerCompletion, "string");
  prior.completed_at = new Date(Date.parse(prior.completed_at!) + 250).toISOString();
  prior.change_intervals = 2;
  prior.mean_change_interval_ms = 16 * 3600000;
  const migrated = await advanceCatalogObservations(catalog, legacy, options);
  assert.deepEqual(migrated.report.failures, []);
  assert.deepEqual(migrated.report.completed_source_keys, [key]);
  assert.equal(calls.length, 4);
  const migratedSource = migrated.checkpoint.sources[key]!;
  for (const field of [
    "last_complete_facts_sha256",
    "completed_at",
    "freshness_observed_at",
    "last_change_at",
    "change_intervals",
    "mean_change_interval_ms",
    "next_due_at",
  ] as const)
    assert.equal(migratedSource[field], prior[field], field);
  assert.equal(providerObservations[0]?.completed_at, providerCompletion);

  const tightenedConfig = { ...options.config, stale_after_hours: 6 };
  const tightened = await advanceCatalogObservations(catalog, legacy, {
    ...options,
    config: tightenedConfig,
  });
  assert.equal(calls.length, 4);
  assert.equal(
    tightened.checkpoint.sources[key]!.next_due_at,
    new Date(
      Date.parse(prior.freshness_observed_at!) +
        tightenedConfig.stale_after_hours * 3600000 -
        tightenedConfig.budget.duration_ms,
    ).toISOString(),
  );
  assert.equal(tightened.checkpoint.sources[key]!.completed_at, prior.completed_at);

  prior.next_due_at = new Date(h.options.now!()).toISOString();
  const refreshed = await advanceCatalogObservations(catalog, legacy, options);
  assert.deepEqual(refreshed.report.failures, []);
  assert.deepEqual(refreshed.report.completed_source_keys, [key]);
  assert.equal(calls.length, 8);
  assert.equal(
    refreshed.checkpoint.sources[key]!.completed_at,
    new Date(h.options.now!()).toISOString(),
  );
  assert.equal(providerObservations[0]?.completed_at, new Date(h.options.now!()).toISOString());
});

void test("descriptive provider identity refuses arbitrary hosts and reports unsupported observation without release absence", async () => {
  const { listingProviderIdentity } = await import("./listing-upstream-observation.mts");
  for (const project_url of [
    "https://gitlab.com/owner/lab",
    "https://gitlab.com/owner/lab.git",
    "https://gitlab.com/owner/lab/-/releases/v1.0",
  ]) {
    assert.deepEqual(listingProviderIdentity({ project_url }), {
      provider: "gitlab",
      repository: "owner/lab",
    });
  }
  assert.deepEqual(
    listingProviderIdentity({ project_url: "https://gitlab.com/owner/subgroup/lab/-/releases/v1" }),
    { provider: "gitlab", repository: "owner/subgroup/lab" },
  );
  for (const project_url of [
    "https://gitlab.example.com/owner/lab",
    "https://gitlab.com/owner/.git",
    "https://gitlab.com.evil.test/owner/lab",
    "https://user:pass@gitlab.com/owner/lab",
    "https://gitlab.com:8443/owner/lab",
    "https://gitlab.com/owner/lab?token=secret",
    "https://gitlab.com/owner/lab/-/blob/main/file",
  ]) {
    assert.equal(listingProviderIdentity({ project_url }), null);
    const result = catalogObservationSources({
      ports: [],
      listings: [{ id: "unsupported", project_url }],
    });
    assert.equal(result.sources.length, 0);
    assert.equal(result.held[0]?.reason, "listing-provider-observation-unsupported");
  }
});

void test("GitLab listing failures preserve last-good freshness and unsupported release links remain incomplete", async () => {
  const { projectGitLabListingObservation, listingUpdatesForReport } =
    await import("./listing-upstream-observation.mts");
  const listing = {
    id: "lab-description",
    project_url: "https://gitlab.com/owner/lab",
    availability: "unknown",
  };
  const facts = {
    project: { id: 27, path_with_namespace: "owner/lab" },
    releases: [
      {
        tag_name: "v1",
        upcoming_release: false,
        released_at: "2026-10-26T00:00:00Z",
        assets: { links: [] },
      },
    ],
    packages: [],
    package_files: {},
    coverage: { releases: true, packages: true },
  };
  const observation = {
    format: 3,
    authority: "provider-observation-only",
    provider: "gitlab",
    started_at: "2026-10-27T00:00:00Z",
    completed_at: "2026-10-27T00:01:00Z",
    facts,
    facts_sha256: observationHash(facts),
  };
  for (const badRelease of [
    null,
    { ...facts.releases[0], upcoming_release: undefined },
    { ...facts.releases[0], assets: {} },
  ]) {
    const badFacts = { ...facts, releases: [badRelease] };
    assert.throws(
      () =>
        projectGitLabListingObservation(
          listing,
          { ...observation, facts: badFacts, facts_sha256: observationHash(badFacts) },
          12,
        ),
      /invalid native/,
    );
  }
  const policy = projectGitLabListingObservation(listing, observation, 12);
  const current = policy.listing_update;
  for (const rule of ["provider-transport", "provider-pagination", "provider-stale"]) {
    const updates = listingUpdatesForReport(
      [policy],
      { exception: { rule } },
      "2026-10-28T00:00:00Z",
      { provider: "gitlab", repository: "owner/lab", ports: [{ listing: current }] },
    );
    assert.equal(updates[0]?.upstream_observation.provider, "gitlab");
    assert.equal(updates[0]?.upstream_observation.observed_at, "2026-10-27T00:00:00Z");
    assert.equal(updates[0]?.upstream_observation.fresh_until, "2026-10-27T12:00:00.000Z");
    assert.equal(updates[0]?.availability, "unknown");
  }
  const incompleteFacts = structuredClone(facts);
  (incompleteFacts.releases[0]!.assets.links as unknown[]).push({
    id: 5,
    url: "https://unknown.test/game.zip",
  });
  const incomplete = projectGitLabListingObservation(
    listing,
    { ...observation, facts: incompleteFacts, facts_sha256: observationHash(incompleteFacts) },
    12,
  );
  assert.equal(incomplete.listing_update.upstream_observation.status, "incomplete");
  assert.deepEqual(
    (incomplete.listing_update.upstream_observation.releases as Record<string, unknown>[])[0]!
      .assets,
    [],
  );
  assert.throws(
    () =>
      projectGitLabListingObservation(
        listing,
        {
          ...observation,
          facts: { ...facts, coverage: {} },
          facts_sha256: observationHash({ ...facts, coverage: {} }),
        },
        12,
      ),
    /Exact covered/,
  );
});

void test("GitLab provider failures export a descriptive failure candidate without refreshing successful facts", async () => {
  const h = harness();
  const listing = {
    id: "lab-description",
    project_url: "https://gitlab.com/owner/lab",
    availability: "unknown",
  };
  const failures: unknown[] = [];
  const result = await advanceCatalogObservations({ ports: [], listings: [listing] }, null, {
    ...h.options,
    providerFetch: async () => {
      throw new Error("bounded provider failure");
    },
    exportProvider: async (_source, observations, _policies, report) => {
      assert.deepEqual(observations, []);
      failures.push(report);
    },
  });
  assert.equal(result.report.failures[0]?.rule, "provider-transport");
  assert.deepEqual(failures, [
    {
      exception: {
        rule: "provider-transport",
        coverage: { kind: "unavailable", rule: "provider-transport" },
      },
    },
  ]);
  // The descriptive failure candidate uses the attempt's stated coverage word.
  const { listingUpdatesForReport } = await import("./listing-upstream-observation.mts");
  const source = catalogObservationSources({ ports: [], listings: [listing] }).sources[0]!;
  const statusFor = (report: unknown) =>
    listingUpdatesForReport([], report, new Date(h.options.now!()).toISOString(), source)[0]
      ?.upstream_observation.status;
  assert.equal(statusFor(failures[0]), "unavailable");
  assert.equal(
    statusFor({
      exception: {
        rule: "provider-quota",
        coverage: { kind: "unavailable", rule: "provider-quota" },
      },
    }),
    "unavailable",
  );
  // A report without a statement (written before #8569) keeps the rule mapping.
  assert.equal(statusFor({ exception: { rule: "provider-quota" } }), "unavailable");
  assert.equal(
    statusFor({
      exception: {
        rule: "provider-pagination",
        coverage: { kind: "partial", rule: "provider-pagination", next_cursor: null },
      },
    }),
    "incomplete",
  );
  assert.equal(
    statusFor({
      exception: { rule: "provider-http", coverage: { kind: "failed", rule: "provider-http" } },
    }),
    "failed",
  );
  const state = Object.values(result.checkpoint.sources)[0]!;
  assert.equal(state.freshness_observed_at, null);
  assert.equal(state.last_complete_facts_sha256, null);
});

void test("the mod-provider registry keeps exact discovery evidence across observer restart and incomplete reads", async () => {
  const h = harness();
  const { upstreamFacts } = await import("./maintenance-upstream.mts");
  const { thunderstoreRegistrySubject, thunderstoreRegistryUrl } =
    await import("./upstream-mod-provider-registry.mts");
  const ship = {
    uuid: "9fb26233-032a-43e3-bbe7-6e058f5daf15",
    label: "ship-of-harkinian",
    thunderstore: { listed: true, wikiUrl: "https://gamebanana.com/games/16121" },
  };
  const twoShip = {
    uuid: "245724c1-1b08-4fd5-b827-1e9816bda1e1",
    label: "2-ship-2-harkinian",
    thunderstore: { listed: false, wikiUrl: "https://gamebanana.com/games/20371" },
  };
  const registry = (...games: (typeof ship)[]) => ({
    schemaVersion: "0.3.0",
    games: Object.fromEntries(games.map((game) => [game.label, game])),
    communities: Object.fromEntries(games.map((game) => [game.label, game.thunderstore])),
  });
  let response = () => Response.json(registry(ship, twoShip));
  let requests = 0;
  h.options.modProviderRegistryFetch = async (url, init) => {
    assert.equal(
      url instanceof URL ? url.href : typeof url === "string" ? url : url.url,
      thunderstoreRegistryUrl,
    );
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    requests++;
    return response();
  };
  const observe = (prior: CatalogObserverCheckpoint | null) =>
    advanceCatalogObservations(h.input, prior, h.options);
  const first = await observe(null);
  const complete = first.checkpoint.mod_provider_registry?.last_complete;
  assert.ok(complete);
  assert.equal(requests, 1);
  assert.deepEqual(complete.communities, [
    {
      community: twoShip.label,
      game_uuid: twoShip.uuid,
      listed: false,
      gamebanana_game: 20371,
    },
    {
      community: ship.label,
      game_uuid: ship.uuid,
      listed: true,
      gamebanana_game: 16121,
    },
  ]);
  const published = upstreamFacts(first.checkpoint, h.input, h.options.now!());
  assert.equal(published.expected, h.input.ports.length + 1);
  assert.ok(published.facts.has(thunderstoreRegistrySubject));
  assert.ok(first.report.completed_source_keys.length > 0);

  const saved: unknown = JSON.parse(JSON.stringify(h.snapshots.at(-1)));
  const restarted = await observe(validateCatalogObserverCheckpoint(saved, h.options.now!()));
  assert.equal(requests, 1);
  assert.deepEqual(restarted.checkpoint.mod_provider_registry?.last_complete, complete);

  h.advanceClock(h.options.config.cadence_hours * 3600000);
  response = () =>
    new Response(Buffer.alloc(h.options.config.budget.response_bytes + 1), {
      status: 429,
      headers: { "retry-after": new Date(h.options.now!() + 120000).toUTCString() },
    });
  const limited = await observe(restarted.checkpoint);
  assert.equal(limited.checkpoint.mod_provider_registry?.exception, "rate-limit");
  assert.deepEqual(limited.checkpoint.mod_provider_registry?.last_complete, complete);
  assert.equal(limited.checkpoint.provider_retry_at, null);
  assert.ok(limited.report.completed_source_keys.length > 0);
  const held = upstreamFacts(limited.checkpoint, h.input, h.options.now!());
  assert.equal(held.facts.has(thunderstoreRegistrySubject), false);
  assert.ok(held.gaps.some((gap) => gap.subject_key === thunderstoreRegistrySubject));
  await observe(limited.checkpoint);
  assert.equal(requests, 2);
  const controller = new AbortController();
  let beforeSource: CatalogObserverCheckpoint | undefined;
  await advanceCatalogObservations(h.input, restarted.checkpoint, {
    ...h.options,
    signal: controller.signal,
    commit: async (checkpoint) => {
      beforeSource ??= structuredClone(checkpoint);
    },
    withSourceLock: async () => {
      controller.abort();
      throw new ObservationFailure("cancelled", "fixture cancelled the source turn");
    },
  });
  assert.equal(controller.signal.aborted, true);
  assert.ok(beforeSource);
  assert.deepEqual(beforeSource.mod_provider_registry, limited.checkpoint.mod_provider_registry);
  await observe(beforeSource);
  assert.equal(requests, 3);

  h.advanceClock(120000);
  response = () => Response.json(registry(ship));
  const incomplete = await observe(limited.checkpoint);
  assert.equal(incomplete.checkpoint.mod_provider_registry?.exception, "identity-changed");
  assert.deepEqual(incomplete.checkpoint.mod_provider_registry?.identity_conflicts, [
    "2-ship-2-harkinian",
  ]);
  assert.deepEqual(incomplete.checkpoint.mod_provider_registry?.last_complete, complete);

  h.advanceClock(h.options.config.cadence_hours * 3600000);
  response = () => new Response(null, { status: 503 });
  const outage = await observe(incomplete.checkpoint);
  assert.equal(outage.checkpoint.mod_provider_registry?.exception, "unavailable");
  assert.deepEqual(outage.checkpoint.mod_provider_registry?.identity_conflicts, [
    "2-ship-2-harkinian",
  ]);
  h.advanceClock(h.options.config.cadence_hours * 3600000);
  response = () =>
    Response.json(
      registry(ship, {
        ...twoShip,
        thunderstore: { listed: false, wikiUrl: "https://example.com/games/20371" },
      }),
    );
  const recovered = await observe(outage.checkpoint);
  assert.equal(recovered.checkpoint.mod_provider_registry?.exception, null);
  assert.equal(recovered.checkpoint.mod_provider_registry?.identity_conflicts, undefined);
  assert.equal(
    recovered.checkpoint.mod_provider_registry?.last_complete?.communities[0]?.gamebanana_game,
    null,
  );
  assert.equal(
    recovered.checkpoint.mod_provider_registry?.last_complete?.communities[0]?.game_uuid,
    twoShip.uuid,
  );
  assert.ok(
    upstreamFacts(recovered.checkpoint, h.input, h.options.now!()).facts.has(
      thunderstoreRegistrySubject,
    ),
  );
  h.advanceClock(h.options.config.stale_after_hours * 3600000);
  const expired = upstreamFacts(recovered.checkpoint, h.input, h.options.now!());
  assert.equal(expired.facts.has(thunderstoreRegistrySubject), false);
  assert.ok(
    expired.gaps.some(
      (gap) => gap.subject_key === thunderstoreRegistrySubject && gap.code === "stale",
    ),
  ); // Ordinary source growth must not replace a readable recovered controller
  // with a checkpoint that cannot be read on the next scheduled run.
  const retainedRegistry = recovered.checkpoint.mod_provider_registry;
  assert.ok(retainedRegistry);
  const large = {
    ...newCatalogObserverCheckpoint(),
    mod_provider_registry: retainedRegistry,
    fixture_padding: "",
  };
  large.fixture_padding = "x".repeat(
    32 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(large)) - 8,
  );
  const written = h.snapshots.length;
  const registryRequestsBeforeHold = requests;
  await assert.rejects(observe(large), /exceed the checkpoint envelope/u);
  assert.equal(h.snapshots.length, written);
  assert.equal(requests, registryRequestsBeforeHold);
});

// #8569: provider-level outcomes are stated per source; an incomplete source
// keeps its accepted cursor and last-good facts while other sources advance.
type CoverageFault =
  | "truncated-page"
  | "quota-403"
  | "retry-after-429"
  | "outage-503"
  | "timeout"
  | "malformed-json"
  | "blocked-403"
  | "legal-451";
function faultySourceHarness() {
  const h = harness();
  let fault: CoverageFault | null = null;
  const faultRequests: string[] = [];
  const base = h.options.fetch!;
  h.options.fetch = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (fault === null || !pathname.startsWith("/repos/owner/other")) return base(url, init);
    faultRequests.push(url);
    const reset = Math.floor((h.options.now!() + 600_000) / 1000);
    const json = { "content-type": "application/json" };
    switch (fault) {
      case "truncated-page":
        if (!pathname.endsWith("/releases")) return base(url, init);
        // A nonterminal page that names a next page but holds fewer than 100 items.
        return new Response(JSON.stringify([release(3), release(2)]), {
          headers: {
            ...json,
            link: `<https://api.github.com${pathname}?per_page=100&page=2>; rel="next"`,
          },
        });
      case "quota-403":
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            ...json,
            "x-ratelimit-remaining": "0",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": String(reset),
          },
        });
      case "retry-after-429":
        return new Response("{}", { status: 429, headers: { ...json, "retry-after": "120" } });
      case "outage-503":
        return new Response("{}", { status: 503, headers: json });
      case "timeout":
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      case "malformed-json":
        return new Response("{not json", { headers: json });
      // A blocked repository is a rejection, not quota: no Retry-After and
      // no exhausted rate-limit header.
      case "blocked-403":
        return new Response(JSON.stringify({ message: "Repository access blocked" }), {
          status: 403,
          headers: { ...json, "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000" },
        });
      case "legal-451":
        return new Response(JSON.stringify({ message: "Unavailable for legal reasons" }), {
          status: 451,
          headers: json,
        });
    }
  };
  return {
    h,
    faultRequests,
    setFault: (value: CoverageFault | null) => {
      fault = value;
    },
    resetAt: () => new Date(Math.floor((h.options.now!() + 600_000) / 1000) * 1000).toISOString(),
  };
}
const sourceByRepository = (state: CatalogObserverCheckpoint, repository: string) =>
  Object.values(state.sources).find((source) => source.repository === repository)!;
const expectedCoverage: Record<CoverageFault, { kind: string; rule: string }> = {
  "truncated-page": { kind: "partial", rule: "pagination" },
  "quota-403": { kind: "unavailable", rule: "rate-limit" },
  "retry-after-429": { kind: "unavailable", rule: "rate-limit" },
  "outage-503": { kind: "unavailable", rule: "provider-status" },
  timeout: { kind: "unavailable", rule: "transport" },
  "malformed-json": { kind: "failed", rule: "invalid-metadata" },
  "blocked-403": { kind: "failed", rule: "provider-status" },
  "legal-451": { kind: "failed", rule: "provider-status" },
};

for (const fault of Object.keys(expectedCoverage) as CoverageFault[]) {
  void test(`stated ${fault} coverage keeps the source's cursor and last-good facts and resumes`, async () => {
    const { h, setFault, faultRequests } = faultySourceHarness();
    const baseline = await advanceCatalogObservations(h.input, null, h.options);
    assert.equal(baseline.report.completed_source_keys.length, 2);
    assert.ok(baseline.report.source_statuses.every((status) => !("coverage" in status)));
    const before = sourceByRepository(baseline.checkpoint, "owner/other");
    const beforeShared = sourceByRepository(baseline.checkpoint, "owner/shared");
    const otherKey = Object.entries(baseline.checkpoint.sources).find(
      ([, source]) => source.repository === "owner/other",
    )![0];

    h.advanceClock(48 * 3600_000);
    h.bumpRelease();
    setFault(fault);
    const failed = await advanceCatalogObservations(h.input, baseline.checkpoint, h.options);
    const after = sourceByRepository(failed.checkpoint, "owner/other");
    const expected = expectedCoverage[fault];
    assert.ok(faultRequests.length > 0, "the fault fixture was exercised");
    assert.equal(after.coverage?.kind, expected.kind, JSON.stringify(after.coverage));
    assert.equal(after.coverage?.rule, expected.rule);
    assert.equal(after.exception_rule, expected.rule);
    // Unknown is never "no release": last-good facts, policies and scope are retained.
    assert.equal(after.last_complete_facts_sha256, before.last_complete_facts_sha256);
    assert.deepEqual(after.last_complete_policies, before.last_complete_policies);
    assert.equal(after.completed_scope_sha256, before.completed_scope_sha256);
    assert.equal(after.completed_at, before.completed_at);
    assert.equal(after.freshness_observed_at, before.freshness_observed_at);
    assert.ok(!failed.report.completed_source_keys.includes(otherKey));
    const status = failed.report.source_statuses.find((item) => item.source_key === otherKey)!;
    assert.deepEqual(status.coverage, after.coverage);
    assert.equal(status.current_scope_complete, false);
    const failure = failed.report.failures.find((item) => item.source === otherKey)!;
    assert.deepEqual(failure.coverage, after.coverage);
    if (fault === "quota-403" || fault === "retry-after-429") {
      assert.ok(after.coverage && "retry_at" in after.coverage);
      const retryAt = Date.parse(after.coverage.retry_at);
      assert.ok(retryAt >= h.options.now!() + (fault === "quota-403" ? 590_000 : 60_000));
      assert.equal(after.retry_at, after.coverage.retry_at);
      assert.equal(failed.checkpoint.provider_retry_at, after.coverage.retry_at);
      // GitHub quota is shared by the token: a sibling GitHub source waits as
      // pending work with its own cursor; it is neither failed nor marked incomplete.
      const shared = sourceByRepository(failed.checkpoint, "owner/shared");
      assert.equal(shared.coverage, undefined);
      assert.equal(shared.exception_rule, null);
      assert.equal(shared.last_complete_facts_sha256, beforeShared.last_complete_facts_sha256);
    } else {
      assert.ok(after.coverage && !("retry_at" in after.coverage));
      // Only a quota response is retried as transient quota; nothing else defers.
      assert.equal(after.retry_at, null);
      assert.equal(failed.checkpoint.provider_retry_at, null);
      // One failing source does not starve the other: it completes and advances.
      const shared = sourceByRepository(failed.checkpoint, "owner/shared");
      assert.equal(shared.coverage, undefined);
      assert.notEqual(shared.last_complete_facts_sha256, beforeShared.last_complete_facts_sha256);
      assert.equal(failed.report.completed_source_keys.length, 1);
    }
    if (after.coverage?.kind === "partial")
      assert.match(String(after.coverage.next_cursor), /^collect:\d+$/u);
    // A new rejection, outage or integrity failure of a managed source notifies
    // through the ordinary exception path.
    if (after.coverage?.kind === "failed") assert.equal(failed.notify_exception, true);
    // A stated coverage is bounded checkpoint content.
    assert.ok(Buffer.byteLength(JSON.stringify(after.coverage)) <= 256);
    assert.ok(
      failed.report.checkpoint_storage.bytes - baseline.report.checkpoint_storage.bytes < 4096,
    );
    const reparsed = validateCatalogObserverCheckpoint(
      JSON.parse(JSON.stringify(failed.checkpoint)),
      h.options.now!(),
    );
    assert.deepEqual(sourceByRepository(reparsed, "owner/other").coverage, after.coverage);

    // The next run resumes from the retained cursor once the provider recovers.
    setFault(null);
    h.advanceClock(3600_000);
    const resumed = await advanceCatalogObservations(h.input, failed.checkpoint, h.options);
    const recovered = sourceByRepository(resumed.checkpoint, "owner/other");
    assert.ok(resumed.report.completed_source_keys.includes(otherKey));
    assert.equal(recovered.coverage, undefined);
    assert.equal(recovered.exception_rule, null);
    assert.notEqual(recovered.last_complete_facts_sha256, before.last_complete_facts_sha256);
    assert.ok(
      resumed.report.source_statuses.every((item) => !("coverage" in item)),
      "complete sources omit coverage",
    );
  });
}

void test("retained checkpoints without stated coverage parse and malformed statements are refused", async () => {
  const h = harness();
  const result = await advanceCatalogObservations(h.input, null, h.options);
  const now = h.options.now!();
  const plain = JSON.parse(JSON.stringify(result.checkpoint)) as CatalogObserverCheckpoint;
  assert.ok(Object.values(plain.sources).every((source) => !("coverage" in source)));
  validateCatalogObserverCheckpoint(plain, now);
  const key = Object.keys(plain.sources)[0]!;
  for (const coverage of [
    { kind: "complete", rule: "budget" },
    { kind: "partial", rule: "budget" },
    { kind: "unavailable", rule: "rate-limit", retry_at: "soon" },
    { kind: "failed", rule: "x".repeat(81) },
    { kind: "failed", rule: "invalid-metadata", next_cursor: null },
    { kind: "partial", rule: "budget", next_cursor: "c".repeat(81) },
  ]) {
    const changed = structuredClone(plain);
    (changed.sources[key] as unknown as Record<string, unknown>).coverage = coverage;
    assert.throws(() => validateCatalogObserverCheckpoint(changed, now), /progress/u);
  }
});

void test("GitLab quota, outage, malformed and truncated responses state coverage while GitHub sources complete", async () => {
  const h = harness();
  const gitlab = {
    id: "gitlab-port",
    channels: ["stable"],
    release: { provider: "gitlab", repository: "owner/lab" },
  };
  const catalog = { ports: [...h.input.ports, gitlab] };
  type Mode = "ok" | "429" | "503" | "malformed" | "truncated";
  let mode: Mode = "ok";
  const options: CatalogObservationOptions = {
    ...h.options,
    definitionHash: (id) => observationHash(catalog.ports.find((port) => port.id === id)),
    providerFetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const project = url.pathname.endsWith("lab");
      if (!project && mode === "429")
        return new Response("{}", { status: 429, headers: { "retry-after": "300" } });
      if (!project && mode === "503") return new Response("{}", { status: 503 });
      if (!project && mode === "malformed")
        return new Response("[{", {
          headers: { "x-page": "1", "x-per-page": "100", "x-next-page": "" },
        });
      return new Response(
        JSON.stringify(
          project ? { id: 27, path_with_namespace: "owner/lab", archived: false } : [],
        ),
        {
          headers: {
            "x-page": url.searchParams.get("page") ?? "1",
            "x-per-page": "100",
            // A truncated page names a next page while holding fewer than 100 rows.
            "x-next-page": !project && mode === "truncated" ? "2" : "",
          },
        },
      );
    },
    projectProvider: async (id, observation) => ({
      format: 2,
      port_id: id,
      catalog_definition_sha256: observationHash(catalog.ports.find((port) => port.id === id)),
      facts_sha256: observation.facts_sha256,
      projections: [],
    }),
    exportProvider: async () => {},
  };
  const key = catalogObservationSources(catalog).sources.find(
    (source) => source.provider === "gitlab",
  )!.key;
  const baseline = await advanceCatalogObservations(catalog, null, options);
  assert.equal(baseline.report.completed_source_keys.length, 3);
  const expected: Record<Exclude<Mode, "ok">, { kind: string; rule: string; retry?: number }> = {
    "429": { kind: "unavailable", rule: "provider-quota", retry: 300_000 },
    "503": { kind: "unavailable", rule: "provider-http" },
    malformed: { kind: "failed", rule: "provider-metadata" },
    truncated: { kind: "partial", rule: "provider-pagination" },
  };
  let state = baseline.checkpoint;
  for (const [fault, want] of Object.entries(expected) as [
    Exclude<Mode, "ok">,
    typeof expected.malformed,
  ][]) {
    h.advanceClock(48 * 3600_000);
    h.bumpRelease();
    mode = fault;
    const lastGood = state.sources[key]!;
    const failed = await advanceCatalogObservations(catalog, state, options);
    const progress = failed.checkpoint.sources[key]!;
    assert.equal(
      progress.coverage?.kind,
      want.kind,
      `${fault}: ${JSON.stringify(progress.coverage)}`,
    );
    assert.equal(progress.coverage?.rule, want.rule);
    assert.equal(progress.last_complete_facts_sha256, lastGood.last_complete_facts_sha256);
    assert.equal(progress.freshness_observed_at, lastGood.freshness_observed_at);
    if (want.retry)
      assert.equal(
        progress.coverage && "retry_at" in progress.coverage
          ? Date.parse(progress.coverage.retry_at)
          : null,
        h.options.now!() + want.retry,
      );
    if (progress.coverage?.kind === "partial")
      assert.match(String(progress.coverage.next_cursor), /^reads:\d+:validate:\d+$/u);
    // The GitHub sources are not starved by the failing GitLab source.
    assert.equal(failed.report.completed_source_keys.length, 2, fault);
    assert.ok(!failed.report.completed_source_keys.includes(key));
    assert.deepEqual(
      failed.report.source_statuses.find((status) => status.source_key === key)!.coverage,
      progress.coverage,
    );
    mode = "ok";
    h.advanceClock(3600_000);
    const resumed = await advanceCatalogObservations(catalog, failed.checkpoint, options);
    assert.ok(resumed.report.completed_source_keys.includes(key), fault);
    assert.equal(resumed.checkpoint.sources[key]!.coverage, undefined);
    state = resumed.checkpoint;
  }
});

void test("a failure after the observation states the retained continuation cursor", async () => {
  const { h, setFault } = faultySourceHarness();
  const baseline = await advanceCatalogObservations(h.input, null, h.options);
  h.advanceClock(48 * 3600_000);
  h.bumpRelease();
  setFault("truncated-page");
  const exportSource = h.options.export;
  h.options.export = async (source, ...rest) => {
    if (source.repository === "owner/other")
      throw new ObservationFailure("cancelled", "Handoff interrupted after the continuation");
    return exportSource(source, ...rest);
  };
  const failed = await advanceCatalogObservations(h.input, baseline.checkpoint, h.options);
  const after = sourceByRepository(failed.checkpoint, "owner/other");
  assert.equal(after.exception_rule, "cancelled");
  assert.equal(after.coverage?.kind, "partial");
  // Not null ("restart"): the next run resumes from the retained pages.
  assert.match(
    String(after.coverage?.kind === "partial" ? after.coverage.next_cursor : ""),
    /^collect:[1-9]\d*$/u,
  );
});

function gitLabQuotaHarness() {
  const h = harness();
  const gitlab = {
    id: "gitlab-port",
    channels: ["stable"],
    release: { provider: "gitlab", repository: "owner/lab" },
  };
  const catalog = { ports: [...h.input.ports, gitlab] };
  let retryAfter: string | null = null;
  let status = 200;
  let requests = 0;
  const options: CatalogObservationOptions = {
    ...h.options,
    definitionHash: (id) => observationHash(catalog.ports.find((port) => port.id === id)),
    providerFetch: async (input) => {
      requests++;
      const url = new URL(input instanceof Request ? input.url : input);
      const project = url.pathname.endsWith("lab");
      if (!project && status !== 200)
        return new Response(JSON.stringify({ message: "denied" }), {
          status,
          headers: retryAfter === null ? {} : { "retry-after": retryAfter },
        });
      return new Response(
        JSON.stringify(
          project ? { id: 27, path_with_namespace: "owner/lab", archived: false } : [],
        ),
        {
          headers: {
            "x-page": url.searchParams.get("page") ?? "1",
            "x-per-page": "100",
            "x-next-page": "",
          },
        },
      );
    },
    projectProvider: async (id, observation) => ({
      format: 2,
      port_id: id,
      catalog_definition_sha256: observationHash(catalog.ports.find((port) => port.id === id)),
      facts_sha256: observation.facts_sha256,
      projections: [],
    }),
    exportProvider: async () => {},
  };
  const key = catalogObservationSources(catalog).sources.find(
    (source) => source.provider === "gitlab",
  )!.key;
  return {
    h,
    catalog,
    options,
    key,
    requests: () => requests,
    respond: (value: { status: number; retryAfter?: string | null }) => {
      status = value.status;
      retryAfter = value.retryAfter ?? null;
    },
  };
}

void test("an absurd, past or garbage GitLab Retry-After never defers beyond the retry horizon", async () => {
  const { providerRetryHorizonMs } = await import("./upstream-observer.mts");
  const cases: [string, "horizon" | "none"][] = [
    ["9999999999", "horizon"],
    ["Wed, 21 Oct 2405 07:28:00 GMT", "horizon"],
    ["Mon, 01 Jan 2001 00:00:00 GMT", "none"],
    ["eventually", "none"],
    ["-30", "none"],
  ];
  for (const [retryAfter, expected, status = 429] of [
    ...cases,
    // A 403 naming any Retry-After is quota, as on the GitHub path.
    ["eventually", "none", 403] as const,
    ["9999999999", "horizon", 403] as const,
  ]) {
    const g = gitLabQuotaHarness();
    const baseline = await advanceCatalogObservations(g.catalog, null, g.options);
    assert.ok(baseline.report.completed_source_keys.includes(g.key));
    g.h.advanceClock(48 * 3600_000);
    g.h.bumpRelease();
    g.respond({ status, retryAfter });
    const deferred = await advanceCatalogObservations(g.catalog, baseline.checkpoint, g.options);
    const progress = deferred.checkpoint.sources[g.key]!;
    assert.equal(progress.exception_rule, "provider-quota", retryAfter);
    assert.equal(progress.coverage?.kind, "unavailable");
    const horizon = new Date(g.h.options.now!() + providerRetryHorizonMs).toISOString();
    if (expected === "horizon") {
      assert.equal(progress.retry_at, horizon, retryAfter);
      assert.equal(progress.coverage?.retry_at, horizon);
    } else {
      assert.equal(progress.retry_at, null, retryAfter);
      assert.ok(progress.coverage && !("retry_at" in progress.coverage));
    }
    // Once the bounded clock has passed the source is attempted and recovers.
    g.respond({ status: 200 });
    g.h.advanceClock(providerRetryHorizonMs + 1000);
    const recovered = await advanceCatalogObservations(g.catalog, deferred.checkpoint, g.options);
    assert.ok(recovered.report.completed_source_keys.includes(g.key), retryAfter);
    assert.equal(recovered.checkpoint.sources[g.key]!.quota_deferrals, undefined);
  }
});

void test("a checkpoint retaining an unbounded provider clock is attempted instead of deferred", async () => {
  const g = gitLabQuotaHarness();
  const baseline = await advanceCatalogObservations(g.catalog, null, g.options);
  g.h.advanceClock(48 * 3600_000);
  g.h.bumpRelease();
  const legacy = structuredClone(baseline.checkpoint);
  const far = "2405-10-21T07:28:00.000Z";
  legacy.sources[g.key]!.retry_at = far;
  legacy.provider_retry_at = far;
  for (const rate of Object.values(legacy.provider_capacities ?? {})) rate.retry_at = far;
  const resumed = await advanceCatalogObservations(g.catalog, legacy, g.options);
  assert.ok(resumed.report.completed_source_keys.includes(g.key));
  assert.equal(resumed.checkpoint.sources[g.key]!.retry_at, null);
  assert.equal(resumed.checkpoint.provider_retry_at, null);
  for (const rate of Object.values(resumed.checkpoint.provider_capacities ?? {}))
    assert.notEqual(rate.retry_at, far);
});

void test("a source the provider keeps deferring for quota notifies once after repeated deferral", async () => {
  const { quotaDeferralNotifyAfter } = await import("./catalog-upstream-observer.mts");
  const g = gitLabQuotaHarness();
  let state = (await advanceCatalogObservations(g.catalog, null, g.options)).checkpoint;
  g.respond({ status: 429, retryAfter: "60" });
  const notified: boolean[] = [];
  for (let attempt = 1; attempt <= quotaDeferralNotifyAfter + 3; attempt++) {
    g.h.advanceClock(48 * 3600_000);
    g.h.bumpRelease();
    const result = await advanceCatalogObservations(g.catalog, state, g.options);
    state = result.checkpoint;
    const progress = state.sources[g.key]!;
    assert.equal(progress.exception_rule, "provider-quota");
    assert.equal(progress.quota_deferrals, Math.min(attempt, quotaDeferralNotifyAfter + 1));
    notified.push(result.notify_exception);
    const status = result.report.source_statuses.find((item) => item.source_key === g.key)!;
    assert.equal(status.quota_deferrals, progress.quota_deferrals);
    const failure = result.report.failures.find((item) => item.source === g.key)!;
    assert.equal(
      failure.details.includes("consecutive attempts"),
      attempt > quotaDeferralNotifyAfter,
    );
    // The bounded counter survives a checkpoint round trip.
    validateCatalogObserverCheckpoint(JSON.parse(JSON.stringify(state)), g.h.options.now!());
  }
  // Quiet while transient; exactly one notification once it persists.
  assert.deepEqual(
    notified,
    Array.from(
      { length: quotaDeferralNotifyAfter + 3 },
      (_, index) => index === quotaDeferralNotifyAfter,
    ),
  );
  // Recovery clears the counter; a later deferral starts counting again quietly.
  g.respond({ status: 200 });
  g.h.advanceClock(48 * 3600_000);
  g.h.bumpRelease();
  const recovered = await advanceCatalogObservations(g.catalog, state, g.options);
  assert.ok(recovered.report.completed_source_keys.includes(g.key));
  assert.equal(recovered.checkpoint.sources[g.key]!.quota_deferrals, undefined);
  assert.ok(
    recovered.report.source_statuses.every((item) => !("quota_deferrals" in item)),
    "zero deferrals are omitted",
  );
  g.respond({ status: 429, retryAfter: "60" });
  g.h.advanceClock(48 * 3600_000);
  g.h.bumpRelease();
  const again = await advanceCatalogObservations(g.catalog, recovered.checkpoint, g.options);
  assert.equal(again.checkpoint.sources[g.key]!.quota_deferrals, 1);
  assert.equal(again.notify_exception, false);
  // Malformed counters are refused.
  for (const value of [0, -1, 1.5, quotaDeferralNotifyAfter + 2, "2"]) {
    const changed = structuredClone(again.checkpoint);
    (changed.sources[g.key] as unknown as Record<string, unknown>).quota_deferrals = value;
    assert.throws(
      () => validateCatalogObserverCheckpoint(changed, g.h.options.now!()),
      /progress/u,
    );
  }
});

void test("a non-quota GitLab 403 is a failed rejection that notifies and is not deferred as quota", async () => {
  const g = gitLabQuotaHarness();
  const baseline = await advanceCatalogObservations(g.catalog, null, g.options);
  for (const status of [403, 451]) {
    g.h.advanceClock(48 * 3600_000);
    g.h.bumpRelease();
    g.respond({ status });
    const failed = await advanceCatalogObservations(g.catalog, baseline.checkpoint, g.options);
    const progress = failed.checkpoint.sources[g.key]!;
    assert.equal(progress.exception_rule, "provider-http", String(status));
    assert.deepEqual(progress.coverage, { kind: "failed", rule: "provider-http" });
    assert.equal(progress.retry_at, null);
    assert.equal(progress.quota_deferrals, undefined);
    assert.equal(failed.notify_exception, true);
    // It is attempted again on the next run rather than waiting for a quota clock.
    const before = g.requests();
    g.h.advanceClock(3600_000);
    const next = await advanceCatalogObservations(g.catalog, failed.checkpoint, g.options);
    assert.ok(g.requests() > before);
    assert.equal(next.notify_exception, false, "the same exception notifies only once");
  }
});

void test("first-party mod observation shares the opportunity budget and retains last success on outage", async () => {
  const h = harness();
  const input = {
    ...h.input,
    ports: h.input.ports.map((port) =>
      port.id === "other-port" ? { ...port, source_profile: "fixture-disc" } : port,
    ),
    listings: [
      {
        id: "other-port",
        project_url: "https://github.com/owner/other",
        original_game: { source_editions: [{ system: "nintendo-gamecube" }] },
      },
    ],
    source_catalog: {
      contracts: [
        {
          port_id: "other-port",
          role: "game",
          admission_mode: "enforced",
          profile_id: "fixture-disc",
          supported_variant_ids: ["usa", "europe"],
        },
      ],
      identities: [
        {
          id: "fixture-disc",
          variants: [
            { id: "usa", product_codes: ["GPIE01"] },
            { id: "europe", product_codes: ["GPIP01"] },
          ],
        },
      ],
    },
  };
  const first = await advanceCatalogObservations(input, null, h.options);
  const proof = {
    state: "observed" as const,
    repository_id: 8,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    blob: "c".repeat(40),
    manifest_sha256: "d".repeat(64),
    game_input_ids: ["GPIE01", "GPIP01"],
    mod_portals: [
      {
        id: "upstream-gamebanana",
        site: "community_site" as const,
        name: "GameBanana",
        url: "https://gamebanana.com/games/123",
        instructions: "The upstream project lists this community. Follow its setup instructions.",
      },
    ],
  };
  const modResults = [
    proof,
    { state: "unavailable", reason: "provider-outage" },
    { ...proof, game_input_ids: ["GPIE01", "GPI"] },
  ] satisfies Awaited<ReturnType<NonNullable<CatalogObservationOptions["observeLauncherMods"]>>>[];
  let reads = 0;
  h.options.observeLauncherMods = async (repository, account) => {
    assert.deepEqual(repository, { id: 8, slug: "owner/other" });
    account.admitRequest();
    account.observeResponse(new Response());
    account.consumeResponseBytes(18);
    reads++;
    return modResults.shift()!;
  };
  h.options.launcherModRequestLimit = 3;
  const deferred = await advanceCatalogObservations(input, first.checkpoint, h.options);
  assert.equal(reads, 0);
  assert.deepEqual(deferred.report.launcher_mod_sources, {
    enrolled: 1,
    due: 1,
    attempted: 0,
    complete: 0,
    deferred: 1,
    requests: 0,
  });
  h.options.launcherModRequestLimit = 4;
  const observed = await advanceCatalogObservations(input, deferred.checkpoint, h.options);
  assert.equal(reads, 1);
  assert.equal(observed.report.launcher_mod_sources?.requests, 1);
  assert.equal(observed.report.launcher_mod_sources?.complete, 1);
  const row = observed.checkpoint.launcher_mod_sources?.["other-port"];
  assert.equal(row?.outcome, "observed");
  assert.deepEqual(row?.last_complete?.result, proof);
  assert.deepEqual(
    validateCatalogObserverCheckpoint(
      decodeStoredObserverCheckpoint(
        encodeStoredObserverCheckpoint(observed.checkpoint),
        h.options.now!() + 1000,
        h.options.now,
      ),
      h.options.now!(),
    ).launcher_mod_sources,
    observed.checkpoint.launcher_mod_sources,
  );
  const replay = await advanceCatalogObservations(input, observed.checkpoint, h.options);
  assert.equal(reads, 1);
  h.advanceClock(24 * 3600000);
  const outage = await advanceCatalogObservations(input, replay.checkpoint, h.options);
  assert.equal(reads, 2);
  assert.equal(outage.report.launcher_mod_sources?.complete, 0);
  assert.equal(outage.checkpoint.launcher_mod_sources?.["other-port"]?.outcome, "unavailable");
  assert.deepEqual(
    outage.checkpoint.launcher_mod_sources?.["other-port"]?.last_complete,
    row?.last_complete,
  );
  h.advanceClock(24 * 3600000);
  const conflicting = await advanceCatalogObservations(input, outage.checkpoint, h.options);
  assert.equal(reads, 3);
  assert.equal(conflicting.report.launcher_mod_sources?.complete, 0);
  const held = conflicting.checkpoint.launcher_mod_sources?.["other-port"];
  assert.equal(held?.outcome, "held");
  assert.equal(held?.reason, "game-input-scope-conflict");
  assert.equal(held?.last_complete, undefined);
});

void test("the observer enrolls a listing-only port using its accepted shared edition", async () => {
  const h = harness();
  const original_game = {
    id: "shared-fixture-original",
    source_editions: [{ id: "fixture-usa", system: "playstation" }],
  };
  const input = {
    ports: h.input.ports.flatMap((port) => {
      if (port.id === "other-port") return [];
      return [port.id === "held-port" ? { ...port, source_profile: "fixture-disc" } : port];
    }),
    listings: [
      { id: "held-port", original_game },
      { id: "other-port", project_url: "https://github.com/owner/other", original_game },
    ],
    source_catalog: {
      contracts: [
        {
          port_id: "held-port",
          role: "game",
          admission_mode: "enforced",
          profile_id: "fixture-disc",
          supported_variant_ids: ["usa"],
        },
      ],
      identities: [
        {
          id: "fixture-disc",
          variants: [{ id: "usa", product_codes: ["SLUS-01212"] }],
        },
      ],
    },
  };
  const first = await advanceCatalogObservations(input, null, h.options);
  const visits: number[] = [];
  h.options.launcherModRequestLimit = 4;
  h.options.observeLauncherMods = async (repo, account) => {
    account.admitRequest();
    visits.push(repo.id);
    return {
      state: "absent",
      repository_id: repo.id,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    };
  };
  const assessment = await advanceCatalogObservations(input, first.checkpoint, h.options);
  assert.deepEqual(visits, [8]);
  assert.equal(assessment.report.launcher_mod_sources?.enrolled, 1);
  const old = assessment.checkpoint.launcher_mod_sources?.["other-port"];
  assert.equal(old?.outcome, "absent");
  const corrected = structuredClone(input);
  corrected.source_catalog.identities[0]!.variants[0]!.product_codes = ["SLUS-03434"];
  const reassessed = await advanceCatalogObservations(corrected, assessment.checkpoint, h.options);
  assert.deepEqual(visits, [8, 8]);
  assert.notEqual(
    reassessed.checkpoint.launcher_mod_sources?.["other-port"]?.binding,
    old?.binding,
  );
});

void test("first-party due work reserves a share for missing scopes and follows the oldest lane with one slot", async () => {
  const { selectLauncherModWork } = await import("./upstream-launcher-mod-progress.mts");
  const reviewed = ["old-reviewed", "new-reviewed", "later-reviewed", "last-reviewed"];
  const unresolved = ["old-unresolved", "new-unresolved", "later-unresolved"];
  assert.deepEqual(selectLauncherModWork(reviewed, unresolved, 0, "", ""), []);
  assert.deepEqual(selectLauncherModWork(reviewed, unresolved, 1, "", ""), ["old-reviewed"]);
  assert.deepEqual(selectLauncherModWork(reviewed, unresolved, 1, "2026-11-27T00:00:00Z", ""), [
    "old-unresolved",
  ]);
  assert.deepEqual(selectLauncherModWork(reviewed, unresolved, 4, "", ""), [
    "old-reviewed",
    "new-reviewed",
    "later-reviewed",
    "old-unresolved",
  ]);
  assert.deepEqual(selectLauncherModWork(reviewed.slice(0, 1), unresolved, 3, "", ""), [
    "old-reviewed",
    "old-unresolved",
    "new-unresolved",
  ]);
});

void test("first-party observation retains a missing game scope and reassesses when exact evidence arrives", async () => {
  const h = harness();
  const listings = [
    {
      id: "other-port",
      project_url: "https://github.com/owner/other",
      original_game: {
        id: "fixture-original",
        source_editions: [{ id: "fixture-usa", system: "playstation" }],
      },
    },
  ];
  const input = { ...h.input, listings };
  const first = await advanceCatalogObservations(input, null, h.options);
  const proof = {
    state: "observed" as const,
    repository_id: 8,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    blob: "c".repeat(40),
    manifest_sha256: "d".repeat(64),
    game_input_ids: ["SLUS-01212"],
    mod_portals: [
      {
        id: "upstream-gamebanana",
        site: "community_site" as const,
        name: "GameBanana",
        url: "https://gamebanana.com/games/123",
        instructions: "The upstream project lists this community. Follow its setup instructions.",
      },
    ],
  };
  let requests = 0;
  h.options.launcherModRequestLimit = 4;
  h.options.observeLauncherMods = async (repo, account) => {
    assert.equal(repo.id, 8);
    account.admitRequest();
    requests++;
    // The parser can produce no accepted portal from a present but unsupported declaration.
    return requests === 1 ? { ...proof, mod_portals: [] } : proof;
  };
  const unproven = await advanceCatalogObservations(input, first.checkpoint, h.options);
  const held = unproven.checkpoint.launcher_mod_sources?.["other-port"];
  assert.equal(held?.outcome, "held");
  assert.equal(held?.reason, "game-input-scope-unproven");
  assert.equal(held?.last_complete, undefined);
  assert.equal(requests, 1);
  const replay = await advanceCatalogObservations(input, unproven.checkpoint, h.options);
  assert.equal(requests, 1);
  const known = {
    ...input,
    ports: input.ports.map((port) =>
      port.id === "other-port" ? { ...port, source_profile: "fixture-disc" } : port,
    ),
    source_catalog: {
      identities: [
        { id: "fixture-disc", variants: [{ id: "usa", product_codes: ["SLUS-01212"] }] },
      ],
      contracts: [
        {
          port_id: "other-port",
          role: "game",
          admission_mode: "enforced",
          profile_id: "fixture-disc",
          supported_variant_ids: ["usa"],
        },
      ],
    },
  };
  const reassessed = await advanceCatalogObservations(known, replay.checkpoint, h.options);
  const resolved = reassessed.checkpoint.launcher_mod_sources?.["other-port"];
  assert.equal(requests, 2);
  assert.notEqual(resolved?.binding, held?.binding);
  assert.equal(resolved?.outcome, "observed");
  assert.deepEqual(resolved?.last_complete?.result, proof);
});
