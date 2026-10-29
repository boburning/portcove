import type { ProviderObservation } from "./upstream-observer.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiError } from "./github-api.mts";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCatalogUpstreams,
  runCatalogOpportunity,
  retireObserverConfigurations,
} from "./observe-catalog-upstreams.mts";
import {
  advanceObservation,
  catalogObservationDefinitionHashes,
} from "./observe-configured-upstream.mts";
import {
  advanceCatalogObservations,
  catalogObservationSources,
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
    JSON.stringify({ format_version: 1, listings: [] }),
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
  h.input.ports.push({
    id: "unavailable-port",
    channels: ["stable"],
    release: { repository: "owner/unavailable" },
  });
  await writeFile(catalog, JSON.stringify(h.input));
  runtime.api.request = () => {
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
    pages: Record<string, { body: unknown; sha256: string; link: string; etag: string }>;
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
    pages: Record<string, { body: unknown; sha256: string; link: string; etag: string }>;
  };
  const url = Object.keys(proof.pages).find((url) => /\/releases\?/.test(url))!;
  const page = structuredClone(proof.pages[url]!);
  const rows = page.body as { id: number; tag_name: string }[];
  rows.find((row) => row.id === 1)!.tag_name = "v1.1.0";
  page.sha256 = observationHash(rows);
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
    api: { request: () => assert.fail("Legacy exact source identity needs no lookup") },
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
    api: {
      request: (_method: string, endpoint: string) => {
        const repository = endpoint.replace("/repos/", ""),
          body = {
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
