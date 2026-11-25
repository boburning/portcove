import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureGitHub } from "./fixtures/github-sdk-fixtures.mts";
import { postgresFixture, postgresServer } from "./fixtures/postgres-cluster.mts";
import { DiscoveryBudget } from "./discovery-budget.mts";
import { emptyCheckpoint } from "./discovery-checkpoint.mts";
import {
  DiscoveryStoreRefused,
  discoveryStatusQuery,
  postgresDiscoveryStore,
  measureDiscoverySeed,
} from "./discovery-store.mts";
import type {
  DiscoveryLease,
  DiscoveryProviderObservation,
  DiscoveryStore,
  DiscoveryWatchChange,
} from "./discovery-store.mts";
import type { DiscoveryRetainedState, DiscoveryWorkerResult } from "./discovery-worker.mts";
import {
  discoveryDefinitionDigest,
  discoveryWorkerMain,
  unmigratedStore,
  importLocalState,
  leadObservation,
  leadWatch,
  parseWorkerState,
  providerWake,
  learnedDigest,
  physicalLeadEnvelope,
  discoveryTransferForecastQuery,
  discoveryPassReservation,
  discoverySeedReservation,
  runDiscoveryPasses,
  renderDiscoveryStatus,
  readStoredLeads,
  runDiscoveryWorker,
  storedLeadsReservation,
} from "./discovery-worker.mts";
import { overlayLocalResearch } from "./discovery-leads.mts";
import type { DiscoveryLead } from "./discovery-leads.mts";
import { selectExternalResolutions } from "./discovery-external-lists.mts";
import { backup, migrate, migrationTransaction, queryJson, readMigrations, restore, runSql } from "./maintenance-store.mts";

const server = postgresServer();
const hex = (digit: string) => digit.repeat(64);
const lease = (name: string): DiscoveryLease => ({
  scope: "primary",
  attempt: `00000000-0000-4000-8000-${name.padStart(12, "0")}`,
  token: `10000000-0000-4000-8000-${name.padStart(12, "0")}`,
});
const options = { leaseSeconds: 600, definition: hex("d"), sourceRevision: "rev", runner: "test" };
const observation = (id: string, digit: string): DiscoveryProviderObservation => ({
  provider: "github",
  provider_id: id,
  parser_version: 1,
  content_sha256: hex(digit),
  repository: `ports/game-${id}`,
  facts: { repository: `ports/game-${id}` },
});
const watch = (id: string, status: DiscoveryWatchChange["status"], digit: string) =>
  ({
    provider: "github",
    provider_id: id,
    reason: "no-native-package",
    status,
    evidence_sha256: hex(digit),
    wake: "release assets",
  }) satisfies DiscoveryWatchChange;
const commit = (
  store: DiscoveryStore,
  owner: DiscoveryLease,
  revision: number,
  state: Record<string, unknown>,
  observations: DiscoveryProviderObservation[] = [],
  watches: DiscoveryWatchChange[] = [],
) =>
  store.commit(owner, revision, {
    definition: hex("d"),
    leaseSeconds: 600,
    state,
    observations,
    watches,
    leadRecords: [],
  });
const count = (environment: NodeJS.ProcessEnv, table: string) =>
  queryJson(environment, `SELECT count(*) FROM portcove_maintenance.${table};`) as number;

void test(
  "fenced discovery leases refuse stale writers, resume committed state and deduplicate replays",
  { skip: server.skip ?? false, timeout: 120_000 },
  (context) => {
    const environment = postgresFixture(context, server.directory!).start("lease").owner;
    migrate(environment);
    const store = postgresDiscoveryStore(environment);
    const first = lease("1");
    const grant = store.acquire(first, options);
    assert.equal(grant.revision, 0);
    assert.deepEqual(grant.state, {});
    assert.throws(
      () => store.acquire(lease("2"), options),
      (error) => error instanceof DiscoveryStoreRefused && error.reason === "leased",
    );

    // A page commits its observations, watch and continuation together.
    const page = [observation("11", "a"), observation("12", "b")];
    assert.equal(
      commit(store, first, 0, { cursor: 1 }, page, [watch("11", "waiting", "1")]).revision,
      1,
    );
    // Replaying the same page after a crash adds no duplicate observation.
    assert.equal(commit(store, first, 1, { cursor: 1 }, page).revision, 2);
    assert.equal(count(environment, "discovery_observations"), 2);
    assert.throws(
      () => commit(store, first, 1, { cursor: 9 }),
      (error) => error instanceof DiscoveryStoreRefused && error.reason === "stale-writer",
      "an unexpected revision is refused",
    );

    // The lease expires while the first worker stalls; a new owner takes over.
    runSql(
      environment,
      "UPDATE portcove_maintenance.discovery_collection_state SET lease_expires_at = clock_timestamp() - interval '1 second';",
    );
    const second = lease("2");
    const resumed = store.acquire(second, options);
    assert.equal(resumed.revision, 2);
    assert.deepEqual(resumed.state, { cursor: 1 }, "the new owner resumes the committed position");
    assert.ok(resumed.acquisition > grant.acquisition);
    assert.throws(
      () => commit(store, first, 2, { cursor: 99 }),
      (error) => error instanceof DiscoveryStoreRefused && error.reason === "stale-writer",
      "the returning stale worker cannot overwrite the newer owner",
    );
    assert.throws(() => store.finish(first, "complete", {}), DiscoveryStoreRefused);
    assert.equal(
      queryJson(
        environment,
        `SELECT to_json(outcome) FROM portcove_maintenance.discovery_collection_attempts WHERE attempt_id = '${first.attempt}';`,
      ),
      "expired",
    );
    assert.equal(commit(store, second, 2, { cursor: 2 }).revision, 3);
    store.finish(second, "partial", {
      committed: { sent_bytes: 4000, received_bytes: 1000 },
    });
    assert.deepEqual(
      queryJson(environment, discoveryTransferForecastQuery),
      {
        state_bytes: Buffer.byteLength(JSON.stringify({ cursor: 2 }).replace(":", ": ")),
        record_bytes: 0,
        // Neon meters only response bytes; what a commit sends is not counted.
        previous_transfer_bytes: 1000,
      },
      "the forecast reads measured state and the recent runs' transfer",
    );
    assert.equal(store.acquire(lease("3"), options).revision, 3, "finish releases the lease");

    assert.throws(
      () =>
        runSql(
          environment,
          "UPDATE portcove_maintenance.discovery_observations SET repository = 'x/y';",
        ),
      /append-only|history/u,
    );
  },
);

void test(
  "watch evidence changes open new episodes and unchanged evidence stays quiet",
  { skip: server.skip ?? false, timeout: 120_000 },
  (context) => {
    const environment = postgresFixture(context, server.directory!).start("watch").owner;
    migrate(environment);
    const store = postgresDiscoveryStore(environment);
    const owner = lease("1");
    store.acquire(owner, options);
    let revision = 0;
    for (const [status, digit] of [
      ["waiting", "1"],
      ["waiting", "1"],
      ["due", "2"],
      ["waiting", "1"],
    ] as const)
      revision = commit(store, owner, revision, {}, [], [watch("42", status, digit)]).revision;
    assert.deepEqual(
      queryJson(
        environment,
        "SELECT json_agg(json_build_array(generation, status) ORDER BY generation) FROM portcove_maintenance.discovery_watch_transitions;",
      ),
      [
        [1, "waiting"],
        [2, "due"],
        [3, "waiting"],
      ],
      "a return to earlier evidence is a new episode, not a rewrite",
    );
  },
);

void test(
  "a restored store starts discovery collection inactive and refuses pre-restore leases",
  { skip: server.skip ?? false, timeout: 240_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const source = fixture.start("source").owner;
    migrate(source);
    const store = postgresDiscoveryStore(source);
    const inflight = lease("1");
    store.acquire(inflight, options);
    commit(store, inflight, 0, { cursor: 1 }, [observation("7", "c")]);
    const output = path.join(fixture.root, "backup");
    await backup(source, output);
    const target = fixture.start("target").owner;
    restore(target, output);
    const restored = postgresDiscoveryStore(target);
    assert.throws(
      () => restored.acquire(lease("2"), options),
      (error) => error instanceof DiscoveryStoreRefused && error.reason === "inactive",
    );
    assert.equal(count(target, "discovery_observations"), 1, "retained observations survive");
    runSql(
      target,
      "UPDATE portcove_maintenance_meta.discovery_intake_activation SET collection_active = true;",
    );
    assert.throws(
      () => commit(restored, inflight, 1, { cursor: 2 }),
      (error) => error instanceof DiscoveryStoreRefused && error.reason === "stale-writer",
      "the restored generation refuses the in-flight pre-restore lease",
    );
    assert.throws(
      () => restored.finish(inflight, "complete", {}),
      (error) => error instanceof DiscoveryStoreRefused && error.reason === "stale-writer",
      "a pre-restore worker cannot close its attempt or clear the restored lease either",
    );
    const after = restored.acquire(lease("2"), options);
    assert.equal(after.revision, 1, "reactivation resumes from the restored position");
    assert.equal(after.generation, 2);
    const status = queryJson(target, discoveryStatusQuery({ attempts: 5 })) as Record<
      string,
      unknown
    >;
    assert.deepEqual(status.activation, { active: true, generation: 2 });
    assert.match(renderDiscoveryStatus(status), /1 rows for 1 provider subjects/u);
  },
);

/** In-memory store with the same revision and lease rules, for worker behavior. */
function memoryStore() {
  const rows = new Map<string, DiscoveryProviderObservation>();
  const watches = new Map<string, DiscoveryWatchChange>();
  const commits: { observations: number; watches: number }[] = [];
  const finished: string[] = [];
  let state: Record<string, unknown> = {};
  let revision = 0;
  let holder: string | undefined;
  let refuse = false;
  let breakAfter = Infinity;
  const leads = new Map<number, unknown>();
  const leadWrites: number[] = [];
  let loads = 0;
  let committer: string | undefined;
  const known: (number | undefined)[] = [];
  const store: DiscoveryStore = {
    acquire(owner, request) {
      holder = owner.token;
      known.push(request.known?.revision);
      // Like the database, omit a revision the caller already holds.
      if (
        request.known?.revision === revision &&
        request.known.generation === 1 &&
        request.known.definition === discoveryDefinitionDigest &&
        request.known.attempt === committer
      )
        return {
          revision,
          state: {},
          state_sha256: hex("0"),
          definition_sha256: discoveryDefinitionDigest,
          acquisition: commits.length + 1,
          generation: 1,
          unchanged: true,
          received_bytes: 200,
        };
      const full = {
        revision,
        state: structuredClone(state),
        state_sha256: hex("0"),
        definition_sha256: discoveryDefinitionDigest,
        acquisition: commits.length + 1,
        generation: 1,
      };
      return { ...full, received_bytes: Buffer.byteLength(JSON.stringify(full)) };
    },
    commit(owner, expected, input) {
      if (refuse || owner.token !== holder || expected !== revision)
        throw new DiscoveryStoreRefused("stale-writer", "stale");
      if (commits.length >= breakAfter) throw new Error("psql exited 2: connection reset");
      for (const o of input.observations) rows.set(`${o.provider_id}:${o.content_sha256}`, o);
      for (const w of input.watches) watches.set(w.provider_id, w);
      for (const r of input.leadRecords) leads.set(r.id, structuredClone(r));
      leadWrites.push(input.leadRecords.length);
      commits.push({ observations: input.observations.length, watches: input.watches.length });
      state = JSON.parse(JSON.stringify(input.state)) as Record<string, unknown>;
      committer = owner.attempt;
      return { revision: ++revision, bytes: 100 };
    },
    loadLeadRecords() {
      loads++;
      const records = [...leads.values()];
      return { records, bytes: Buffer.byteLength(JSON.stringify(records)) };
    },
    finish(owner, outcome) {
      if (owner.token !== holder) throw new DiscoveryStoreRefused("stale-writer", "stale");
      finished.push(outcome);
      holder = undefined;
    },
  };
  return {
    store,
    rows,
    watches,
    commits,
    finished,
    state: () => state,
    leads,
    leadWrites,
    loads: () => loads,
    known,
    /** Another writer's commit, which advances the revision under its own lease. */
    advance: (next: Record<string, unknown>) => {
      state = structuredClone(next);
      revision++;
    },
    refuseCommits: () => (refuse = true),
    failCommitsAfter: (count: number) => (breakAfter = count),
  };
}

async function providers(
  budget: DiscoveryBudget,
  releases: () => unknown[],
  extraProjects = 0,
  releaseReads: string[] = [],
) {
  const extra = Array.from({ length: extraProjects }, (_, index) => ({
    id: 20_000 + index,
    full_name: `ports/project-${index}`,
    html_url: `https://github.com/ports/project-${index}`,
    description: "Native port",
    pushed_at: "2026-10-30T00:00:00Z",
  }));
  const sdk = await fixtureGitHub(({ endpoint }) => {
    budget.charge("GET", endpoint, 1, 100, "200");
    if (endpoint === "rate_limit")
      return {
        resources: Object.fromEntries(
          ["core", "graphql", "search"].map((name) => [
            name,
            { remaining: 4000, reset: Math.floor(Date.parse("2026-12-01T00:00:00Z") / 1000) },
          ]),
        ),
      };
    if (endpoint.startsWith("search/repositories"))
      // A project whose identity never appears in collector code or configuration.
      return {
        total_count: 1 + extra.length,
        incomplete_results: false,
        items: [
          {
            id: 9001,
            full_name: "holdout/unseen-native-port",
            html_url: "https://github.com/holdout/unseen-native-port",
            description: "PC port of a console game",
            pushed_at: "2026-10-30T00:00:00Z",
          },
          ...extra,
        ],
      };
    if (/\/releases\?per_page=\d+$/u.test(endpoint)) {
      releaseReads.push(endpoint);
      return endpoint.startsWith("repos/holdout/unseen-native-port/releases") ? releases() : [];
    }
    return new Response(JSON.stringify({ message: "fixture" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
  const http = {
    request: async (method: string, url: string) => {
      budget.charge(method, url, 1, 1, "503");
      return { requests: 1, bytes: 1, status: 503, headers: {}, text: "" };
    },
  };
  return { sdk, http };
}

void test("the unattended worker retains an unseen project and reconsiders it when assets appear", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-worker-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = memoryStore();
  let assets = false;
  const run = async (at: string) => {
    const now = () => Date.parse(at);
    const budget = new DiscoveryBudget("ordinary", () => {}, now, at);
    return await runDiscoveryWorker({
      store: memory.store,
      runDir: root,
      sourceRevision: "fixture",
      runner: "fixture",
      covered: () => new Set(),
      commitIntervalMs: 0,
      budget,
      now,
      connect: async () =>
        await providers(budget, () =>
          assets
            ? [
                {
                  draft: false,
                  assets: [{ state: "uploaded", name: "unseen-native-port-windows.zip" }],
                },
              ]
            : [],
        ),
    });
  };

  const first = await run("2026-11-01T05:00:00.000Z");
  assert.notEqual(first.outcome, "failed", first.reason ?? "");
  assert.notEqual(first.outcome, "deferred", first.reason ?? "");
  assert.equal(first.canonical_overlap, "unknown", "collection proceeds without Roadmap ownership");
  assert.ok(first.committed.pages > 1, "progress commits during the run, not only at its end");
  assert.ok(
    first.sources.some((s) => s.status === "inaccessible"),
    "failed sources stay visible",
  );
  assert.equal(memory.finished.at(-1), first.outcome);
  const [retained] = [...memory.rows.values()];
  assert.equal(retained?.provider_id, "9001");
  assert.equal(retained.repository, "holdout/unseen-native-port");
  assert.equal(memory.watches.get("9001")?.status, "waiting");
  const stored = parseWorkerState(memory.state());
  assert.deepEqual(stored.leads.records, {}, "the state document carries no lead records");
  const record = memory.leads.get(9001) as DiscoveryLead | undefined;
  assert.equal(record?.release_hint?.assets_observed, false, "the record is its own row");

  // A week later the same project publishes desktop assets. No issue, allowlist or
  // title-specific input is supplied; the same subject becomes due.
  assets = true;
  const sentBefore = memory.commits.reduce((sum, c) => sum + c.observations, 0);
  const second = await run("2026-11-09T05:00:00.000Z");
  assert.notEqual(second.outcome, "failed", second.reason ?? "");
  assert.equal(memory.watches.get("9001")?.status, "due");
  assert.equal(
    memory.commits.reduce((sum, c) => sum + c.observations, 0) - sentBefore,
    1,
    "only the changed facts are sent again",
  );
  assert.equal(new Set([...memory.rows.values()].map((o) => o.provider_id)).size, 1);
});

void test("a pass reuses what this run committed only while the store still holds it", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-worker-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = memoryStore();
  const at = "2026-11-01T05:00:00.000Z";
  const now = () => Date.parse(at);
  let retained: DiscoveryRetainedState | undefined;
  const pass = async () => {
    const budget = new DiscoveryBudget("ordinary", () => {}, now, at);
    return await runDiscoveryWorker({
      store: memory.store,
      runDir: root,
      sourceRevision: "fixture",
      runner: "fixture",
      covered: () => new Set(),
      commitIntervalMs: 0,
      budget,
      now,
      ...(retained ? { retained } : {}),
      retain: (value) => {
        retained = value;
      },
      connect: async () => await providers(budget, () => []),
    });
  };
  const first = await pass();
  assert.notEqual(first.outcome, "failed", first.reason ?? "");
  assert.ok(retained, "a fully committed pass retains its state");
  assert.equal(retained.revision, first.revision);
  const records = Object.keys(
    (retained.state.leads as { records: Record<string, unknown> }).records,
  ).length;
  assert.equal(records, memory.leads.size, "the retained state carries every stored record");
  // Exactly what the store holds at that revision: its document and its rows.
  const stored = memory.state() as { leads: Record<string, unknown> };
  assert.deepEqual(
    JSON.parse(JSON.stringify(retained.state)),
    JSON.parse(
      JSON.stringify({
        ...stored,
        leads: {
          ...stored.leads,
          records: Object.fromEntries([...memory.leads].map(([id, r]) => [String(id), r])),
        },
      }),
    ),
  );
  assert.ok(
    (first.committed.received_bytes ?? 0) > 200,
    "the first pass receives the stored document",
  );
  // The store still holds that revision: nothing is read again.
  const second = await pass();
  assert.notEqual(second.outcome, "failed", second.reason ?? "");
  assert.equal(memory.loads(), 1);
  assert.equal(second.committed.received_bytes, 200, "only the short grant is received");
  // Another writer advanced the revision: the next pass reads what is stored.
  memory.advance(memory.state());
  const third = await pass();
  assert.notEqual(third.outcome, "failed", third.reason ?? "");
  assert.equal(memory.loads(), 2, "a changed store is read in full");
  assert.deepEqual(memory.known.slice(1), [first.revision, second.revision]);
});

void test("a worker that loses its lease stops without finishing for the new owner", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-worker-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = memoryStore();
  memory.refuseCommits();
  const at = "2026-11-01T05:00:00.000Z";
  const now = () => Date.parse(at);
  const budget = new DiscoveryBudget("ordinary", () => {}, now, at);
  const result = await runDiscoveryWorker({
    store: memory.store,
    runDir: root,
    sourceRevision: "fixture",
    runner: "fixture",
    covered: () => new Set(),
    commitIntervalMs: 0,
    budget,
    now,
    connect: async () => await providers(budget, () => []),
  });
  assert.equal(result.outcome, "deferred");
  assert.match(result.reason ?? "", /stale-writer/u);
  assert.deepEqual(memory.finished, [], "a stale worker never closes the newer attempt");
});

void test("observations exclude local paths and clocks so unchanged projects stay one row", () => {
  const lead: DiscoveryLead = {
    id: 5,
    repository: "ports/game",
    url: "https://github.com/ports/game",
    description: "Native port",
    revision: "a",
    observed_at: "2026-11-01T00:00:00Z",
    evidence: "/tmp/run-1/lead-search-1.json",
    status: "pending",
    search_families: ["b", "a"],
    release_hint: { assets_observed: false, observed_at: "2026-11-01T00:00:00Z", evidence: "/x" },
  };
  const later = {
    ...lead,
    observed_at: "2026-11-08T00:00:00Z",
    evidence: "/tmp/run-2/lead-search-9.json",
    status: "researched" as const,
    search_families: ["a", "b"],
  };
  assert.equal(leadObservation(lead)?.content_sha256, leadObservation(later)?.content_sha256);
  assert.doesNotMatch(JSON.stringify(leadObservation(lead)), /tmp/u);
  assert.equal(leadWatch(lead)?.status, "waiting");
  const { release_hint: _hint, ...unhinted } = lead;
  assert.equal(leadWatch(unhinted), undefined);
});

void test(
  "local lead state imports once with its recorded strength",
  { skip: server.skip ?? false, timeout: 120_000 },
  async (context) => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const environment = postgresFixture(context, server.directory!).start("import").owner;
    migrate(environment);
    const store = postgresDiscoveryStore(environment);
    const dir = mkdtempSync(path.join(os.tmpdir(), "discovery-import-"));
    context.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "leads.json"),
      JSON.stringify({
        format: 1,
        next_family: 0,
        slices: {},
        records: {
          "77": {
            id: 77,
            repository: "ports/imported",
            url: "https://github.com/ports/imported",
            description: "",
            revision: "r",
            observed_at: "2026-10-01T00:00:00Z",
            evidence: "/local/file.json",
            status: "pending",
          },
        },
      }),
    );
    const first = importLocalState(store, dir, { sourceRevision: "rev", runner: "test" });
    assert.equal(first.outcome, "imported");
    const second = importLocalState(store, dir, { sourceRevision: "rev", runner: "test" });
    assert.equal(second.outcome, "scope-has-state", "a repeated import has no effect");
    assert.equal(count(environment, "discovery_observations"), 1);
    const state = parseWorkerState(store.acquire(lease("9"), options).state);
    assert.deepEqual(Object.keys(state.checkpoint.sources), [], "local coverage is not trusted");
  },
);

void test(
  "a local runner reads the shared store's leads without a lease and keeps its research",
  { skip: server.skip ?? false, timeout: 120_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const legacy = fixture.start("legacy-hints").owner;
    // Exercise the actual upgrade from the prior schema, not just a fresh install.
    const migrations = readMigrations();
    const split = migrations.find(({ name }) => name === "discovery_external_hints");
    assert.ok(split);
    for (const migration of migrations.filter(({ version }) => version < split.version))
      runSql(legacy, migrationTransaction(migration));
    const old = { leads: { external: { lists: {}, hints: { "legacy-key": { title: "legacy" } } } } };
    runSql(legacy, `INSERT INTO portcove_maintenance.discovery_collection_state
      (scope, definition_sha256, revision, state, state_sha256, updated_at)
      VALUES ('primary', '${hex("d")}', 0, '${JSON.stringify(old)}'::jsonb, '${hex("a")}', clock_timestamp());`);
    migrate(legacy);
    assert.deepEqual(queryJson(legacy, "SELECT portcove_maintenance.discovery_expanded_state(scope, state) FROM portcove_maintenance.discovery_collection_state;"), old);
    assert.equal(count(legacy, "discovery_external_hints"), 1);
    const environment = fixture.start("snapshot").owner;
    migrate(environment);
    assert.equal((await readStoredLeads(environment)).outcome, "empty");
    const store = postgresDiscoveryStore(environment);
    const owner = lease("1");
    store.acquire(owner, options);
    const record = (id: number, revision: string): DiscoveryLead => ({
      id,
      repository: `ports/game-${id}`,
      url: `https://github.com/ports/game-${id}`,
      description: "",
      revision,
      observed_at: "2026-11-01T00:00:00.000Z",
      evidence: "lead-search-1.json",
      status: "pending",
    });
    const stored = [record(1, "a"), record(2, "b")];
    store.commit(owner, 0, {
      definition: hex("d"),
      leaseSeconds: 600,
      state: {
        format: 1,
        leads: {
          format: 1, next_family: 3, slices: {}, records: {},
          external: {
            lists: {},
            hints: {
              "https://github.com/ports/game-1": {
                url: "https://github.com/ports/game-1",
                host: "github",
                title: "Game",
                lists: ["decomp-buddy-finds"],
                first_observed_at: "2026-11-01T00:00:00.000Z",
                last_observed_at: "2026-11-01T00:00:00.000Z",
              },
            },
          },
        },
        checkpoint: emptyCheckpoint(),
        research_progress: {},
      },
      observations: [],
      watches: [],
      leadRecords: stored,
    });
    // The collector still holds its lease; the read takes none.
    const read = await readStoredLeads(environment);
    assert.equal(read.outcome, "read");
    if (read.outcome !== "read") return;
    assert.equal(read.revision, 1);
    assert.equal(read.leads.next_family, 3, "the store's continuation comes along");
    assert.equal(read.leads.external?.hints["https://github.com/ports/game-1"]?.title, "Game");
    assert.equal(count(environment, "discovery_external_hints"), 1);
    assert.equal(queryJson(environment, "SELECT state #> '{leads,external,hints}' IS NULL FROM portcove_maintenance.discovery_collection_state;"), true);
    store.finish(owner, "complete", {});
    const next = lease("2");
    const grant = store.acquire(next, options);
    assert.deepEqual((grant.state.leads as { external: unknown }).external, read.leads.external);
    const state = structuredClone(grant.state);
    const external = (state.leads as { external: { hints: Record<string, unknown> } }).external;
    delete external.hints["https://github.com/ports/game-1"];
    commit(store, next, grant.revision, state);
    assert.equal(count(environment, "discovery_external_hints"), 0);
    assert.throws(() => commit(store, owner, grant.revision, grant.state), DiscoveryStoreRefused);
    const after = await readStoredLeads(environment);
    assert.equal(after.outcome, "read");
    if (after.outcome === "read") assert.deepEqual(after.leads.external?.hints, {});
    assert.deepEqual(Object.keys(read.leads.records).sort(), ["1", "2"]);
    assert.ok(read.bytes > 0);

    const local = {
      format: 1 as const,
      next_family: 0,
      slices: {},
      records: {
        // Researched at the stored revision: the research stays.
        "1": {
          ...record(1, "a"),
          status: "researched" as const,
          research: { evidence_id: "e1", file: "local.json", material: "m" },
        },
        // Researched at an older revision: the stored record requeues it.
        "2": {
          ...record(2, "old"),
          status: "no-change" as const,
          disposition: { reason: "no package", resume: "release" },
        },
        // Found by this runner's own search only.
        "3": record(3, "c"),
      },
    };
    const merged = overlayLocalResearch(read.leads, local);
    assert.equal(merged.records["1"]!.status, "researched");
    assert.equal(merged.records["1"]!.research?.evidence_id, "e1");
    assert.equal(merged.records["2"]!.status, "pending");
    assert.equal(merged.records["2"]!.revision, "b");
    assert.equal(merged.records["2"]!.disposition, undefined);
    assert.equal(merged.records["3"]!.revision, "c");
    assert.equal(merged.next_family, 3);
  },
);

void test("a database failure halts collection instead of relabeling a source", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-worker-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = memoryStore();
  memory.failCommitsAfter(1);
  const at = "2026-11-01T05:00:00.000Z";
  const now = () => Date.parse(at);
  const budget = new DiscoveryBudget("ordinary", () => {}, now, at);
  const result = await runDiscoveryWorker({
    store: memory.store,
    runDir: root,
    sourceRevision: "fixture",
    runner: "fixture",
    covered: () => new Set(),
    commitIntervalMs: 0,
    budget,
    now,
    connect: async () => await providers(budget, () => []),
  });
  assert.equal(result.outcome, "failed");
  assert.match(result.reason ?? "", /store commit failed.*connection reset/u);
  assert.deepEqual(result.sources, [], "no source is reported with a database error");
  assert.equal(memory.commits.length, 1, "nothing after the failed commit is written");
  assert.deepEqual(memory.finished, ["failed"]);
});

void test("unattended collection applies no per-run counts and commits within its transfer pacing", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-worker-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = memoryStore();
  const at = "2026-11-01T05:00:00.000Z";
  const now = () => Date.parse(at);
  const budget = new DiscoveryBudget("hosted", () => {}, now, at, {
    requests: Number.MAX_SAFE_INTEGER,
    bytes: 512 * 1024 * 1024,
    milliseconds: 3_600_000,
  });
  const releaseReads: string[] = [];
  const result = await runDiscoveryWorker({
    store: memory.store,
    runDir: root,
    sourceRevision: "fixture",
    runner: "fixture",
    covered: () => new Set(),
    budget,
    now,
    // No elapsed time yet: pacing allows no interim commit, only the final one.
    transferBytes: 16 * 1024 * 1024,
    connect: async () => await providers(budget, () => [], 11, releaseReads),
  });
  assert.notEqual(result.outcome, "failed", result.reason ?? "");
  // The interactive runner rechecks at most four release hints per run.
  assert.equal(new Set(releaseReads).size, 12, "every pending lead is rechecked in one run");
  assert.equal(memory.commits.length, 1, "pacing defers interim commits to the final commit");
  assert.equal(memory.rows.size, 12);
});

void test("fair hint order takes every due hint, longest waiting first", () => {
  const hint = (first: string, checked?: string) => ({
    url: "",
    host: "github" as const,
    title: "",
    lists: ["finds"],
    first_observed_at: first,
    last_observed_at: first,
    ...(checked
      ? {
          resolution: {
            status: "failed" as const,
            checked_at: checked,
            retry_at: "2026-10-01T00:00:00Z",
          },
        }
      : {}),
  });
  const state = {
    lists: {},
    hints: Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `https://github.com/ports/hint-${String(index).padStart(2, "0")}`,
        hint(`2026-10-${String(10 + index).padStart(2, "0")}T00:00:00Z`),
      ]),
    ),
  } as unknown as Parameters<typeof selectExternalResolutions>[0];
  const fair = selectExternalResolutions(
    state,
    new Set(),
    new Map(),
    "2026-11-01T00:00:00Z",
    Infinity,
    "fair",
  );
  assert.equal(fair.length, 12, "no per-run count");
  assert.equal(fair[0]?.repository, "ports/hint-00", "the longest-waiting hint comes first");
  const bounded = selectExternalResolutions(state, new Set(), new Map(), "2026-11-01T00:00:00Z");
  assert.equal(bounded.length, 8, "the interactive runner keeps its bounded newest-first slice");
  assert.equal(bounded[0]?.repository, "ports/hint-11");
});

void test(
  "the store omits state only for the exact revision, generation and definition a caller holds",
  { skip: server.skip ?? false, timeout: 120_000 },
  (context) => {
    const environment = postgresFixture(context, server.directory!).start("known").owner;
    migrate(environment);
    const store = postgresDiscoveryStore(environment);
    const first = lease("1");
    const grant = store.acquire(first, options);
    assert.equal(commit(store, first, grant.revision, { cursor: 1 }).revision, 1);
    store.finish(first, "partial", {});
    const held = {
      revision: 1,
      generation: grant.generation,
      definition: hex("d"),
      attempt: first.attempt,
    };
    const reused = store.acquire(lease("2"), { ...options, known: held });
    assert.equal(reused.unchanged, true);
    assert.deepEqual(reused.state, {}, "the held state is not sent again");
    assert.equal(reused.revision, 1);
    store.finish(lease("2"), "partial", {});
    for (const [name, known] of [
      ["revision", { ...held, revision: 0 }],
      ["generation", { ...held, generation: held.generation + 1 }],
      ["definition", { ...held, definition: hex("e") }],
      // Another store that reached the same revision through other commits.
      ["attempt", { ...held, attempt: lease("9").attempt }],
    ] as const) {
      const owner = lease({ revision: "3", generation: "4", definition: "5", attempt: "6" }[name]);
      const full = store.acquire(owner, { ...options, known });
      assert.equal(full.unchanged, undefined, name);
      assert.deepEqual(full.state, { cursor: 1 }, `a different ${name} reads the stored state`);
      store.finish(owner, "partial", {});
    }
  },
);

void test(
  "stored collector state is not capped at a fixed size",
  { skip: server.skip ?? false, timeout: 120_000 },
  (context) => {
    const environment = postgresFixture(context, server.directory!).start("large").owner;
    migrate(environment);
    const store = postgresDiscoveryStore(environment);
    const owner = lease("1");
    store.acquire(owner, options);
    const large = { padding: "x".repeat(9 * 1024 * 1024) };
    assert.equal(commit(store, owner, 0, large).revision, 1, "state above 8 MiB commits");
  },
);

void test("an exhausted provider quota waits for its reset between passes and continues", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-worker-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = memoryStore();
  const start = Date.parse("2026-11-01T05:00:00.000Z");
  let clock = start;
  const now = () => clock;
  const reset = start + 20 * 60_000;
  const sleeps: number[] = [];
  const admitted: number[] = [];
  let quotaReads = 0;
  const run = await runDiscoveryPasses({
    store: memory.store,
    runDir: root,
    sourceRevision: "fixture",
    runner: "fixture",
    covered: () => new Set(),
    now,
    deadline: start + 3 * 3_600_000,
    diskBytes: 512 * 1024 * 1024,
    finalizationMs: 60_000,
    // Each pass runs under its own admission, here without a provider meter.
    admit: async (pass, collect) => {
      admitted.push(pass);
      return await collect({ bytes: 64 * 1024 * 1024, deadline: Number.POSITIVE_INFINITY });
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    connect: async (budget) => {
      const fixture = await providers(budget, () => []);
      const original = fixture.sdk.request.bind(fixture.sdk);
      // The first quota read reports search exhausted until the reset.
      fixture.sdk.request = (async (route: { url?: string }) => {
        if (typeof route.url === "string" && route.url.endsWith("/rate_limit")) {
          quotaReads++;
          budget.charge("GET", "rate_limit", 1, 100, "200");
          const search = quotaReads === 1 ? 0 : 4000;
          // After the reset GitHub reports the next window's reset.
          const next = quotaReads === 1 ? reset : reset + 3_600_000;
          return {
            status: 200,
            headers: {},
            url: route.url,
            data: {
              resources: {
                core: { remaining: 4000, reset: Math.floor(next / 1000) },
                graphql: { remaining: 4000, reset: Math.floor(next / 1000) },
                search: { remaining: search, reset: Math.floor(next / 1000) },
              },
            },
          };
        }
        return await original(route as never);
      }) as typeof fixture.sdk.request;
      return fixture;
    },
  });
  assert.notEqual(run.outcome, "failed", run.passes.at(-1)?.reason ?? "");
  assert.deepEqual(admitted, [1, 2], "each pass holds its own admission");
  assert.equal(sleeps.length, 1, "one wait for the search quota reset, holding nothing");
  assert.ok(clock > reset, "collection resumed only after the reset");
  assert.equal(memory.known[0], undefined, "the first pass reads the stored state");
  assert.equal(
    memory.known[1],
    run.passes[0]?.revision,
    "the next pass offers the revision the first committed",
  );
  assert.equal(memory.loads(), 1, "the next pass reuses its lead records instead of rereading");
  assert.equal(
    memory.finished.length,
    2,
    "each pass closes its own attempt and releases its lease",
  );
  assert.ok(
    [...memory.rows.values()].some((row) => row.provider_id === "9001"),
    "the search that quota blocked ran after the reset",
  );
  // The many search families that found it again add no rows.
  assert.deepEqual(
    [...memory.rows.values()].map((row) => row.facts.release_assets_observed),
    [false],
  );
});

void test("passes stop when one makes no progress, the deadline passes or admission defers", async () => {
  const pass = (overrides: Partial<DiscoveryWorkerResult>): DiscoveryWorkerResult =>
    ({
      format: "portcove-discovery-worker-result",
      format_version: 1,
      outcome: "partial",
      started_at: "",
      finished_at: "",
      canonical_overlap: "unknown",
      sources: [],
      notes: [],
      leads: { records: 0, pending_families: 0, external: null },
      committed: {
        pages: 0,
        observations: 0,
        watch_changes: 0,
        state_bytes: 0,
        sent_bytes: 0,
        received_bytes: 0,
      },
      budget: { requests: 0, bytes: 0, milliseconds_remaining: 0 },
      ...overrides,
    }) satisfies DiscoveryWorkerResult;
  const start = Date.parse("2026-11-01T05:00:00.000Z");
  const drive = async (results: (DiscoveryWorkerResult | undefined)[]) => {
    let calls = 0;
    const sleeps: number[] = [];
    const run = await runDiscoveryPasses({
      store: memoryStore().store,
      runDir: os.tmpdir(),
      sourceRevision: "fixture",
      runner: "fixture",
      covered: () => new Set(),
      connect: async () => {
        throw new Error("not used");
      },
      now: () => start,
      deadline: start + 3_600_000,
      diskBytes: 1,
      finalizationMs: 0,
      admit: async () => results[calls++],
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    return { calls, sleeps, run };
  };
  const soon = new Date(start + 60_000).toISOString();
  const late = new Date(start + 2 * 3_600_000).toISOString();
  assert.equal((await drive([pass({ progressed: false, wake_at: soon })])).calls, 1);
  assert.equal((await drive([pass({ progressed: true, wake_at: late })])).calls, 1);
  assert.equal((await drive([pass({ progressed: true })])).calls, 1, "a pass that ended naturally");
  const continued = await drive([
    pass({ progressed: true, wake_at: soon }),
    pass({ outcome: "complete" }),
  ]);
  assert.equal(continued.calls, 2);
  assert.deepEqual(continued.sleeps, [60_000]);
  assert.equal(continued.run.outcome, "complete");
  const deferred = await drive([undefined]);
  assert.equal(deferred.run.outcome, "deferred");
  assert.match(deferred.run.deferred ?? "", /admission/u);
});

void test("a pass that has spent its admitted transfer ends resumably after its final commit", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-worker-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = memoryStore();
  const at = "2026-11-01T05:00:00.000Z";
  const now = () => Date.parse(at);
  const budget = new DiscoveryBudget("hosted", () => {}, now, at);
  const result = await runDiscoveryWorker({
    store: memory.store,
    runDir: root,
    sourceRevision: "fixture",
    runner: "fixture",
    covered: () => new Set(),
    commitIntervalMs: 0,
    transferBytes: 1,
    budget,
    now,
    connect: async () => await providers(budget, () => []),
  });
  assert.equal(result.outcome, "partial");
  assert.match(result.reason ?? "", /admitted database transfer is spent/u);
  assert.equal(result.wake_at, at, "the next pass may continue at once");
  assert.equal(memory.commits.length, 1, "the final commit keeps the pass's progress");
  assert.deepEqual(memory.finished, ["partial"]);
});

void test("provider wake reports only a blocking quota or backoff", () => {
  const at = Date.parse("2026-11-01T05:00:00.000Z");
  const budget = new DiscoveryBudget(
    "hosted",
    () => {},
    () => at,
    new Date(at).toISOString(),
  );
  assert.equal(providerWake(budget, at), undefined);
  budget.observeProvider({ resource: "search", remaining: 0, resetAt: "2026-11-01T05:10:00.000Z" });
  assert.equal(providerWake(budget, at), Date.parse("2026-11-01T05:10:01.000Z"));

  // Once the core window has rolled over, the pass's observation is stale and it
  // admits nothing more; the next pass starts at once and observes it afresh.
  const fresh = new DiscoveryBudget(
    "hosted",
    () => {},
    () => at,
    new Date(at).toISOString(),
  );
  fresh.observeProvider({ resource: "core", remaining: 2737, resetAt: "2026-11-01T05:00:00.000Z" });
  assert.equal(providerWake(fresh, at), at + 1000);
  fresh.observeProvider({ resource: "core", remaining: 2737, resetAt: "2026-11-01T06:00:00.000Z" });
  assert.equal(providerWake(fresh, at), undefined, "a current window with capacity needs no wake");
});

void test("a pass that only restamps observation clocks has learned nothing", () => {
  const state = {
    checkpoint: { sources: { quiver: { completed_at: "2026-11-01T05:00:00Z", records: 3 } } },
  };
  const later = {
    checkpoint: { sources: { quiver: { completed_at: "2026-11-01T06:00:00Z", records: 3 } } },
  };
  const changed = {
    checkpoint: { sources: { quiver: { completed_at: "2026-11-01T06:00:00Z", records: 4 } } },
  };
  assert.equal(learnedDigest(state), learnedDigest(later));
  assert.notEqual(learnedDigest(state), learnedDigest(changed));
});

void test("a pass that throws keeps the record of earlier passes", async () => {
  const start = Date.parse("2026-11-01T05:00:00.000Z");
  let calls = 0;
  const first = {
    format: "portcove-discovery-worker-result",
    format_version: 1,
    outcome: "partial",
    progressed: true,
    wake_at: new Date(start).toISOString(),
    started_at: "",
    finished_at: "",
    canonical_overlap: "unknown",
    sources: [],
    notes: [],
    leads: { records: 0, pending_families: 0, external: null },
    committed: {
      pages: 1,
      observations: 0,
      watch_changes: 0,
      state_bytes: 0,
      sent_bytes: 0,
      received_bytes: 0,
    },
    budget: { requests: 0, bytes: 0, milliseconds_remaining: 0 },
  } satisfies DiscoveryWorkerResult;
  const run = await runDiscoveryPasses({
    store: memoryStore().store,
    runDir: os.tmpdir(),
    sourceRevision: "fixture",
    runner: "fixture",
    covered: () => new Set(),
    connect: async () => {
      throw new Error("not used");
    },
    now: () => start,
    deadline: start + 3_600_000,
    diskBytes: 1,
    finalizationMs: 0,
    admit: async () => {
      if (calls++ === 0) return first;
      throw new Error("psql exited 2: connection reset");
    },
  });
  assert.equal(run.outcome, "failed");
  assert.deepEqual(run.passes, [first], "the committed first pass stays in the record");
  assert.match(run.reason ?? "", /pass 2 failed: .*connection reset/u);
});

void test("lead records are rows and each commit sends only the records that changed", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "discovery-worker-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const memory = memoryStore();
  const run = async (at: string, projects: number) => {
    const now = () => Date.parse(at);
    const budget = new DiscoveryBudget("hosted", () => {}, now, at);
    return await runDiscoveryWorker({
      store: memory.store,
      runDir: root,
      sourceRevision: "fixture",
      runner: "fixture",
      covered: () => new Set(),
      budget,
      now,
      connect: async () => await providers(budget, () => [], projects),
    });
  };
  await run("2026-11-01T05:00:00.000Z", 5);
  assert.equal(memory.leads.size, 6);
  assert.equal(memory.leadWrites.at(-1), 6, "the first commit writes every new record");
  // A later run finds a seventh project.
  await run("2026-11-09T05:00:00.000Z", 6);
  assert.equal(memory.leads.size, 7);
  // Another pass of that run learns nothing new and sends no record at all.
  const writes = memory.leadWrites.length;
  await run("2026-11-09T05:00:00.000Z", 6);
  assert.ok(memory.leadWrites.length > writes, "the pass still commits its state");
  assert.equal(memory.leadWrites.at(-1), 0, "unchanged records are not resent");
});

void test("the unattended lead envelope follows physical memory", () => {
  assert.equal(physicalLeadEnvelope(8 * 1024 ** 3), 2 ** 29 - 24, "bounded by serializable size");
  assert.equal(
    physicalLeadEnvelope(1024 ** 3),
    256 * 1024 ** 2,
    "a quarter of the runner's memory",
  );
});

void test(
  "stored lead records round-trip through PostgreSQL and unchanged rows are not rewritten",
  { skip: server.skip ?? false, timeout: 120_000 },
  async (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const environment = fixture.start("records").owner;
    migrate(environment);
    const store = postgresDiscoveryStore(environment);
    const owner = lease("1");
    store.acquire(owner, options);
    const record = { id: 77, repository: "ports/game", url: "https://github.com/ports/game" };
    store.commit(owner, 0, {
      definition: hex("d"),
      leaseSeconds: 600,
      state: {},
      observations: [],
      watches: [],
      leadRecords: [record],
    });
    assert.deepEqual(store.loadLeadRecords("primary").records, [record]);
    // Many records read back completely across small pages, in key order.
    const many = Array.from({ length: 25 }, (_, index) => ({
      id: 1000 + index,
      padding: "x".repeat(200),
    }));
    store.commit(owner, 1, {
      definition: hex("d"),
      leaseSeconds: 600,
      state: {},
      observations: [],
      watches: [],
      leadRecords: many,
    });
    const paged = postgresDiscoveryStore(environment, 1024).loadLeadRecords("primary");
    assert.deepEqual(
      (paged.records as { id: number }[]).map((r) => r.id),
      [77, ...many.map((r) => r.id)],
    );
    store.commit(owner, 2, {
      definition: hex("d"),
      leaseSeconds: 600,
      state: {},
      observations: [],
      watches: [],
      leadRecords: [record],
    });
    assert.equal(
      queryJson(
        environment,
        "SELECT count(DISTINCT updated_attempt_id) FROM portcove_maintenance.discovery_lead_records;",
      ),
      1,
    );
    assert.deepEqual(
      (queryJson(environment, discoveryTransferForecastQuery) as { record_bytes: number })
        .record_bytes > 0,
      true,
    );

    const state = { leads: { external: { lists: {}, hints: {
      keep: { payload: "x".repeat(100_000) },
      change: { title: "old" },
      remove: { title: "old" },
    } as Record<string, unknown> } } };
    const input = (nextState: Record<string, unknown>) => ({
      definition: options.definition, leaseSeconds: 600,
      state: nextState, observations: [], watches: [], leadRecords: [],
    });
    const seeded = store.commit(owner, 3, input(state));
    assert.ok(seeded.bytes > 100_000);
    // A previous verified portable recovery provides a real cross-run seed.
    const seedPath = path.join(fixture.root, "discovery-seed");
    await backup(environment, seedPath);
    const seedDb = fixture.start("discovery-seed").owner;
    restore(seedDb, seedPath);
    const before = queryJson(environment,
      "SELECT to_json(xmin::text) FROM portcove_maintenance.discovery_external_hints WHERE hint_key = 'keep';");
    state.leads.external.hints.change = { title: "new" };
    delete state.leads.external.hints.remove;
    state.leads.external.hints.add = { title: "added" };
    const changed = store.commit(owner, seeded.revision, input(state));
    assert.ok(changed.bytes < 2_000, "unchanged large hint is not sent again");
    assert.equal(count(environment, "discovery_external_hints"), 3);
    assert.deepEqual(queryJson(environment,
      "SELECT to_json(xmin::text) FROM portcove_maintenance.discovery_external_hints WHERE hint_key = 'keep';"), before);
    assert.deepEqual(queryJson(environment,
      "SELECT portcove_maintenance.discovery_expanded_state(scope, state) FROM portcove_maintenance.discovery_collection_state;"), state);

    const oldAttempt = owner.attempt;
    store.finish(owner, "complete", {});
    const next = lease("2");
    const warm = store.acquire(next, { ...options, known: {
      revision: changed.revision, generation: 1, definition: options.definition, attempt: oldAttempt,
    } });
    assert.equal(warm.unchanged, true);
    assert.ok((warm.received_bytes ?? Infinity) < 2_000);
    const quiet = store.commit(next, warm.revision, input(state));
    assert.ok(quiet.bytes < 2_000, "confirmed warm baseline also sends only changes");
    assert.throws(() => store.commit(owner, changed.revision, input({})), DiscoveryStoreRefused);
    store.finish(next, "complete", {});
    const cold = postgresDiscoveryStore(environment).acquire(lease("3"), { ...options, known: {
      revision: quiet.revision, generation: 1, definition: options.definition, attempt: oldAttempt,
    } });
    assert.notEqual(cold.unchanged, true, "a different commit attempt forces full read");
    assert.deepEqual(cold.state, state);
    store.finish(lease("3"), "complete", {});

    // Alter the seed's rows after verification to prove their actual contents,
    // not its claimed revision, are compared against production.
    runSql(seedDb, `UPDATE portcove_maintenance.discovery_external_hints
      SET hint = '{"payload":"tampered"}' WHERE hint_key = 'change';`);
    runSql(seedDb, `UPDATE portcove_maintenance.discovery_lead_records
      SET record = '{"id":77,"repository":"wrong/game"}' WHERE lead_id = 77;`);
    runSql(environment, `DELETE FROM portcove_maintenance.discovery_lead_records WHERE lead_id = 1000;`);
    const incremental = postgresDiscoveryStore(environment, undefined, seedDb);
    const crossRun = incremental.acquire(lease("4"), options);
    assert.deepEqual(crossRun.state, state);
    assert.ok((crossRun.received_bytes ?? Infinity) < 2_000,
      "unchanged large hints stay local on a cold process read");
    const loaded = incremental.loadLeadRecords("primary");
    const authoritative = store.loadLeadRecords("primary");
    assert.deepEqual(loaded.records, authoritative.records);
    assert.ok(loaded.bytes < authoritative.bytes);
    assert.ok(!loaded.records.some((row) => (row as { id: number }).id === 1000));
    assert.deepEqual(loaded.records[0], record);
    incremental.finish(lease("4"), "complete", {});

    const bounded = postgresDiscoveryStore(environment, 1024, seedDb);
    const fallback = bounded.acquire(lease("5"), options);
    assert.deepEqual(fallback.state, state, "oversized seed uses complete production read");
    assert.deepEqual(bounded.loadLeadRecords("primary").records, authoritative.records);
    bounded.finish(lease("5"), "complete", {});

    const measured = measureDiscoverySeed(environment, seedDb, "primary");
    assert.ok(measured);
    assert.ok(measured.hintsBytes < 2_000);
    assert.ok(measured.leadsBytes < authoritative.bytes);
    const planned = postgresDiscoveryStore(environment, undefined, seedDb, measured);
    const plannedGrant = planned.acquire(lease("6"), options);
    assert.deepEqual(plannedGrant.state, state);
    assert.deepEqual(planned.loadLeadRecords("primary").records, authoritative.records);
    planned.finish(lease("6"), "complete", {});

    const stalePlan = measureDiscoverySeed(environment, seedDb, "primary");
    assert.ok(stalePlan);
    const writer = store.acquire(lease("7"), options);
    commit(store, lease("7"), writer.revision, state);
    store.finish(lease("7"), "complete", {});
    const stale = postgresDiscoveryStore(environment, undefined, seedDb, stalePlan);
    assert.throws(() => stale.acquire(lease("8"), options), DiscoveryStoreRefused);
    assert.equal(queryJson(environment, "SELECT count(*) FROM portcove_maintenance.discovery_collection_attempts WHERE outcome = 'running';"), 0,
      "moved plan rolls back acquisition before returning any payload");
  },
);

void test("a failed lead-record load finishes the attempt instead of holding the lease", async () => {
  const memory = memoryStore();
  memory.store.loadLeadRecords = () => {
    throw new Error("psql exited 2: out of memory");
  };
  const at = "2026-11-01T05:00:00.000Z";
  const result = await runDiscoveryWorker({
    store: memory.store,
    runDir: os.tmpdir(),
    sourceRevision: "fixture",
    runner: "fixture",
    covered: () => new Set(),
    now: () => Date.parse(at),
    connect: async () => {
      throw new Error("not reached");
    },
  });
  assert.equal(result.outcome, "failed");
  assert.match(result.reason ?? "", /lead records could not be loaded/u);
  assert.deepEqual(memory.finished, ["failed"]);
});

void test("invalid retained state or lead records close the owned discovery attempt", async () => {
  for (const invalid of ["state", "lead"]) {
    const memory = memoryStore();
    if (invalid === "state") memory.advance({ format: 999 });
    else memory.leads.set(1, { id: 1 });
    const before = structuredClone(memory.state());
    const beforeLeads = structuredClone(memory.leads);
    let providerCalls = 0;
    const result = await runDiscoveryWorker({
      store: memory.store,
      runDir: os.tmpdir(),
      sourceRevision: "fixture",
      runner: "fixture",
      covered: () => new Set(),
      now: () => Date.parse("2026-11-01T05:00:00.000Z"),
      connect: async () => {
        providerCalls++;
        throw new Error("not reached");
      },
    });
    assert.equal(result.outcome, "failed");
    assert.match(
      result.reason ?? "",
      invalid === "state"
        ? /retained state could not be validated.*unsupported format/u
        : /lead records could not be validated/u,
    );
    assert.deepEqual(memory.finished, ["failed"]);
    assert.deepEqual(memory.state(), before);
    assert.deepEqual(memory.leads, beforeLeads);
    assert.equal(memory.commits.length, 0);
    assert.equal(providerCalls, 0);
  }
});

void test("discovery pass reservation does not charge the cold read twice", () => {
  const acquire = 17_000_000;
  const observed = 18_000_000;
  const commits = 5;
  const reservation = discoveryPassReservation(acquire, observed, commits);
  assert.ok(Math.floor(reservation * 0.7) >= observed);
  assert.ok(reservation < (acquire + observed) / 0.7);
  assert.ok(Math.floor(discoveryPassReservation(observed, acquire, commits) * 0.7) >= observed);
  const plan = { compactBytes: 8_000, hintsBytes: 621, leadsBytes: 1094 };
  const measured = discoverySeedReservation(plan, commits);
  assert.ok(measured < reservation);
  assert.ok(Math.floor(measured * 0.7) >= plan.compactBytes + plan.hintsBytes + plan.leadsBytes);
});

void test("a stored-lead read reserves enough metered payload for the whole state", () => {
  for (const [state, records] of [
    [0, 0],
    [2_000_000, 500_000],
    [8 * 1024 * 1024, 64 * 1024 * 1024],
  ] as const) {
    const reservation = storedLeadsReservation({ state_bytes: state, record_bytes: records });
    // withMaintenanceAdmission meters floor(reservation * 0.7) as payload.
    assert.ok(Math.floor(reservation * 0.7) >= state + records + 700_000);
  }
});

void test("the status report shows each curated source's coverage and baseline progress", () => {
  const text = renderDiscoveryStatus({
    attempts: [
      {
        attempt_id: "a",
        outcome: "partial",
        started_at: "2026-11-24T01:54:12Z",
        source_revision: "rev",
        committed_pages: 1,
        result: {
          leads: {
            external: {
              hints: 11588,
              "unsupported-host": 257,
              "non-github": 65,
              lists: {
                recomplauncher: {
                  last_complete: { completed_at: "2026-11-24T01:12:42Z", entries: 1961 },
                  due: false,
                  contribution: {
                    hints: 1961,
                    discovered: 213,
                    platform_claims: 1946,
                    unresolved_hosts: 4,
                  },
                },
                "unbaked-registry": { last_complete: null, due: true, contribution: null },
              },
              inventories: {
                "unbaked-registry": {
                  inventory_at: "2026-11-24T01:43:07Z",
                  items: 7709,
                  read: 857,
                  due: 6852,
                  candidates_without_public_code: 1718,
                },
              },
            },
          },
        },
      },
    ],
  });
  assert.match(text, /Curated hints: 11588 \(unsupported-host 257, non-GitHub 65\)/u);
  assert.match(
    text,
    /\| recomplauncher \| 2026-11-24T01:12 \| 1961 \| 1961 \| 213 \| 1946 \| 4 \| no \|/u,
  );
  assert.match(text, /\| unbaked-registry \| never \|/u);
  assert.match(text, /\| unbaked-registry \| 2026-11-24T01:43 \| 7709 \| 857 \| 6852 \| 1718 \|/u);
});

void test(
  "the status export reports an unmigrated store instead of failing",
  { skip: server.skip ?? false, timeout: 120_000 },
  async (context) => {
    const environment = postgresFixture(context, server.directory!).start("unmigrated").owner;
    const root = fileURLToPath(new URL("../", import.meta.url));
    mkdirSync(path.join(root, "work"), { recursive: true });
    const output = mkdtempSync(path.join(root, "work", "discovery-status-test-"));
    context.after(() => rmSync(output, { recursive: true, force: true }));
    const name = "PORTCOVE_DISCOVERY_STATUS_TEST_URL";
    const saved = { url: process.env[name], run: process.env.GITHUB_RUN_ID };
    process.env[name] =
      `postgresql://${environment.PGUSER}@localhost/${environment.PGDATABASE}?host=${environment.PGHOST}&port=${environment.PGPORT}`;
    delete process.env.GITHUB_RUN_ID;
    context.after(() => {
      if (saved.url === undefined) delete process.env[name];
      else process.env[name] = saved.url;
      if (saved.run !== undefined) process.env.GITHUB_RUN_ID = saved.run;
    });
    const code = await discoveryWorkerMain(["status", "--database-env", name, "--output", output]);
    assert.equal(code, 75);
    assert.match(
      readFileSync(path.join(output, "status.md"), "utf8"),
      /deferred: The maintenance store is not migrated for discovery collection yet/u,
    );
    // A misconfigured connection is a failure, not an unmigrated store.
    process.env[name] = process.env[name].replace(
      `/${environment.PGDATABASE}?`,
      "/portcove_missing_database?",
    );
    await assert.rejects(
      discoveryWorkerMain(["status", "--database-env", name, "--output", output]),
      /database "portcove_missing_database" does not exist/u,
    );
  },
);

void test("only the store's own missing schema or tables read as an unmigrated store", () => {
  for (const message of [
    'psql exited 3: ERROR:  relation "portcove_maintenance.discovery_watches" does not exist',
    'ERROR:  schema "portcove_maintenance" does not exist',
  ])
    assert.equal(unmigratedStore(new Error(message)), true, message);
  for (const message of [
    'psql exited 2: FATAL:  database "portcove" does not exist',
    'psql exited 2: FATAL:  role "reader" does not exist',
    'ERROR:  column "acquisition" does not exist',
    "ERROR:  function portcove_maintenance.discovery_acquire(text) does not exist",
    'ERROR:  relation "other_schema.discovery_watches" does not exist',
  ])
    assert.equal(unmigratedStore(new Error(message)), false, message);
});
