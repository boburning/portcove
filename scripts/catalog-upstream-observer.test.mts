import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCatalogUpstreams, retireObserverConfigurations } from "./observe-catalog-upstreams.mts";
import { advanceObservation } from "./observe-configured-upstream.mts";
import {
  advanceCatalogObservations,
  catalogObservationSources,
} from "./catalog-upstream-observer.mts";
import type {
  CatalogObservationOptions,
  CatalogObserverCheckpoint,
} from "./catalog-upstream-observer.mts";
import { observationHash, validateObserverConfig } from "./upstream-observer.mts";
import { config, release } from "./fixtures/upstream-observation-fixtures.mts";

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
        release: { provider: "gitlab", repository: "owner/held" },
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

void test("reviewed declarations share provider collection while keeping port-specific Core projections and unsupported holds", async () => {
  const h = harness();
  const plan = catalogObservationSources(h.input);
  assert.equal(plan.sources.length, 2);
  assert.equal(
    plan.sources.find((source) => source.repository === "owner/shared")!.ports.length,
    2,
  );
  assert.match(plan.held[0]!.reason, /gitlab/);
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

void test("shared byte admission includes identity lookups and stops unrelated HTTP after exhaustion", async () => {
  const h = harness();
  h.options.repositoryId = async (_source, transport) => {
    transport.admitRequest();
    transport.consumeResponseBytes(h.options.config.budget.total_bytes + 1);
    return 7;
  };
  const result = await advanceCatalogObservations(h.input, null, h.options);
  assert.equal(result.report.requests, 1);
  assert.equal(h.network.length, 0);
  assert.equal(result.report.completed_source_keys.length, 0);
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
    now: h.options.now!,
    observer: { fetch: h.options.fetch!, sleep: h.options.sleep! },
    project: async (
      _cli: string,
      config: Parameters<typeof h.options.load>[0],
      _directory: string,
      observation: Parameters<typeof h.options.project>[2],
    ) => h.options.project(config.port_id, config.repository_id, observation),
    api: {
      request: (_method: string, endpoint: string) => {
        const repository = endpoint.replace("/repos/", "");
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
  await writeFile(checkpointFile, JSON.stringify(snapshot.checkpoint));
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
  const cli = path.join(root, "inspector");
  await writeFile(cli, "mock Core identity");
  await writeFile(path.join(root, "release/upstream-observer.json"), JSON.stringify(legacy));
  await writeFile(
    path.join(root, "crates/portcove-core/catalog/catalog.json"),
    JSON.stringify({ ports: h.input.ports.slice(0, 2) }),
  );
  const result = await runCatalogUpstreams(["--cli", cli], {
    root,
    now: h.options.now!,
    observer: { fetch: h.options.fetch! },
    log: () => {},
    api: {
      request: () => assert.fail("Reviewed legacy numeric identity needs no new baseline lookup"),
    },
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
  const handoff = JSON.parse(
    await readFile(path.join(result.handoff_directory, `${observationHash(legacy)}.json`), "utf8"),
  ) as Record<string, unknown>;
  assert.ok(Array.isArray(handoff.catalog_policies) && handoff.catalog_policies.length === 2);
});
