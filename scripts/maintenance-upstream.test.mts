import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson, sha256 } from "./maintenance-inventory.mts";
import {
  readUpstreamObservations,
  upstreamAttention,
  upstreamFacts,
  upstreamObservation,
  type UpstreamTransport,
} from "./maintenance-upstream.mts";
import { newCatalogObserverCheckpoint } from "./catalog-upstream-observer.mts";
import { snapshotName } from "./observer-checkpoint-artifact.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  catalog,
  checkpoint,
  exception,
  facts,
  keyOf,
  progress,
  scope,
} from "./fixtures/upstream-checkpoint-fixture.mts";

const now = Date.parse("2026-11-11T00:00:00.000Z");

void test("upstream facts keep stable source facts and report coverage gaps", () => {
  const result = upstreamFacts(
    checkpoint({
      [keyOf("owner/alpha")]: progress("owner/alpha", ["alpha"]),
      // Completed before but its scope was reset for a changed declaration.
      [keyOf("owner/beta")]: progress("owner/beta", ["beta"], { completed_scope_sha256: null }),
    }),
    catalog,
    now,
  );
  assert.equal(result.expected, 4);
  assert.deepEqual([...result.facts.keys()], ["port:alpha"]);
  assert.deepEqual(
    result.gaps.map(({ subject_key, code }) => [subject_key, code]),
    [
      ["port:beta", "scope-changed"],
      ["port:delta", "held"],
      ["port:gamma", "unobserved"],
    ],
  );
  const alpha = result.facts.get("port:alpha") as { sources: Record<string, unknown>[] };
  assert.deepEqual(alpha.sources, [
    {
      source_key: keyOf("owner/alpha"),
      provider: "github",
      repository: "owner/alpha",
      repository_id: 7,
      last_complete_facts_sha256: facts,
      last_change_at: "2026-11-01T00:00:00.000Z",
      exception_key: null,
      exception_rule: null,
      catalog_definition_sha256: "d".repeat(64),
    },
  ]);
  assert.deepEqual(upstreamAttention(alpha), []);
});

void test("a port added after its source completed is a scope change, not a fact", () => {
  const result = upstreamFacts(
    checkpoint({ [keyOf("owner/alpha")]: progress("owner/alpha", []) }),
    { ports: [catalog.ports[0]] },
    now,
  );
  assert.deepEqual(result.facts.size, 0);
  assert.equal(result.gaps[0]?.code, "scope-changed");
});

void test("observer exceptions are facts that need attention, or gaps when never completed", () => {
  const result = upstreamFacts(
    checkpoint({
      [keyOf("owner/alpha")]: progress("owner/alpha", ["alpha"], {
        exception_key: exception,
        exception_rule: "repository-unavailable",
      }),
      [keyOf("owner/gamma")]: progress("owner/gamma", [], {
        completed_scope_sha256: null,
        last_complete_facts_sha256: null,
        exception_key: exception,
      }),
    }),
    catalog,
    now,
  );
  assert.deepEqual(upstreamAttention(result.facts.get("port:alpha")), [
    "upstream observer exception: repository-unavailable (owner/alpha)",
  ]);
  const gamma = result.gaps.find(({ subject_key }) => subject_key === "port:gamma");
  assert.equal(gamma?.code, "unobserved");
  // A checkpoint written before #4779 has no rule; the exception still needs attention.
  assert.deepEqual(upstreamAttention(null, gamma), [
    "upstream observer exception: unrecorded rule",
  ]);
});

void test("the observer's partial-progress stops are routine and stay quiet", () => {
  for (const rule of ["budget", "cancelled", "provider-quota"]) {
    const result = upstreamFacts(
      checkpoint({
        [keyOf("owner/alpha")]: progress("owner/alpha", ["alpha"], {
          exception_key: exception,
          exception_rule: rule,
        }),
      }),
      { ports: [catalog.ports[0]] },
      now,
    );
    assert.equal(result.facts.get("port:alpha") === undefined, false);
    assert.deepEqual(upstreamAttention(result.facts.get("port:alpha")), [], rule);
  }
});

void test("per-observation clocks and progress never change the stored payload", () => {
  const digest = (overrides: Record<string, unknown>, policyClock: string) => {
    const source = progress("owner/alpha", ["alpha"], overrides);
    source.last_complete_policies[0]!.observed_at = policyClock;
    const result = upstreamFacts(
      checkpoint({ [keyOf("owner/alpha")]: source }, 9),
      { ports: [catalog.ports[0]] },
      now,
    );
    return sha256(canonicalJson(result.facts.get("port:alpha")));
  };
  assert.equal(
    digest({}, "2026-11-10T10:00:00.000Z"),
    digest(
      {
        attempted_sequence: 9,
        completed_at: "2026-11-10T16:00:00.000Z",
        freshness_observed_at: "2026-11-10T16:00:00.000Z",
        next_due_at: "2026-11-10T22:00:00.000Z",
        retry_at: "2026-11-10T17:00:00.000Z",
        result_sha256: "c".repeat(64),
        change_intervals: 2,
      },
      "2026-11-10T16:00:00.000Z",
    ),
  );
  // A real upstream change is a different fact.
  assert.notEqual(
    digest({}, "2026-11-10T10:00:00.000Z"),
    digest({ last_change_at: "2026-11-10T16:00:00.000Z" }, "2026-11-10T10:00:00.000Z"),
  );
});

void test("an unreadable or invalid checkpoint is a failed run that observes nothing", async () => {
  const failed = await upstreamObservation(() =>
    Promise.reject(new Error("artifact download refused")),
  );
  assert.equal(failed.failed, true);
  assert.equal(failed.facts.size, 0);
  assert.equal(failed.gaps[0]?.code, "unavailable");
  assert.match(failed.gaps[0]?.message ?? "", /artifact download refused/u);
  const invalid = await upstreamObservation(() =>
    Promise.resolve({
      revision: "r",
      config_sha256: scope,
      checkpoint: { format: 2 },
      catalog,
    }),
  );
  assert.equal(invalid.failed, true);
  assert.match(invalid.gaps[0]?.message ?? "", /Invalid catalog observer checkpoint/u);
});

void test("held declarations of observed ports stay facts; only unserved held ports are gaps", () => {
  const mixed = {
    ports: [
      { id: "alpha", channels: ["stable"], release: { repository: "owner/alpha" } },
      {
        id: "eps",
        channels: ["stable"],
        release: { provider: "user-prepared", repository: "x/y" },
      },
    ],
    listings: [
      // A managed GitHub port whose listing has no supported identity.
      { id: "alpha", project_url: "https://example.com/alpha" },
      // A user-prepared port whose listing the observer still observes.
      { id: "eps", project_url: "https://github.com/owner/eps" },
    ],
  };
  const result = upstreamFacts(
    checkpoint({
      [keyOf("owner/alpha")]: progress("owner/alpha", ["alpha"]),
      [keyOf("owner/eps")]: progress("owner/eps", ["eps"]),
    }),
    mixed,
    now,
  );
  assert.deepEqual(result.gaps, []);
  assert.deepEqual((result.facts.get("port:alpha") as { held_reasons?: string[] }).held_reasons, [
    "listing-provider-observation-unsupported",
  ]);
  assert.deepEqual((result.facts.get("port:eps") as { held_reasons?: string[] }).held_reasons, [
    "provider-user-prepared-not-observable-by-core",
  ]);
  const unserved = upstreamFacts(checkpoint({}), { ports: [catalog.ports[3]] }, now);
  assert.equal(unserved.gaps[0]?.code, "held");
});

void test("a routine partial-progress stop does not change the stored payload", () => {
  const stored = (overrides: Record<string, unknown>) =>
    JSON.stringify(
      upstreamFacts(
        checkpoint({ [keyOf("owner/alpha")]: progress("owner/alpha", ["alpha"], overrides) }),
        { ports: [catalog.ports[0]] },
        now,
      ).facts.get("port:alpha"),
    );
  const quiet = stored({});
  for (const rule of ["budget", "cancelled", "provider-quota"])
    assert.equal(stored({ exception_key: exception, exception_rule: rule }), quiet, rule);
  assert.notEqual(
    stored({ exception_key: exception, exception_rule: "repository-unavailable" }),
    quiet,
  );
});

// Stubbed GitHub transport for the observer snapshot selection and binding.
const observerConfig = Buffer.from("fixture observer config");
const observerConfigDigest = createHash("sha256").update(observerConfig).digest("hex");
const observerCatalog = { ports: [catalog.ports[0]] };
const observerListings = { listings: [{ id: "alpha", project_url: "https://example.com" }] };

interface FixtureRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  path: string;
  created_at: string;
  head_repository: { full_name: string };
}

function observerRuns() {
  const runs: FixtureRun[] = [];
  const artifacts = new Map<number, Record<string, unknown>[]>();
  const archives = new Map<number, Buffer>();
  const downloads: string[] = [];
  let configBytes: Buffer = observerConfig;
  const run = (
    id: number,
    event: string,
    minutesAgo: number,
    overrides: Partial<FixtureRun> = {},
  ) => {
    const value: FixtureRun = {
      id,
      run_attempt: 1,
      head_sha: id.toString(16).padStart(40, "0"),
      head_branch: "main",
      event,
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/configured-upstream-observer.yml",
      created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      head_repository: { full_name: "boburning/portcove" },
      ...overrides,
    };
    runs.push(value);
    artifacts.set(id, []);
    return value;
  };
  /** A retained checkpoint snapshot of `value`, bound like the observer's own upload. */
  const retain = (
    value: FixtureRun,
    options: {
      artifact?: Record<string, unknown>;
      producer?: Partial<{ run: number; attempt: number; source: string }>;
      archive?: (bytes: Buffer) => Buffer;
    } = {},
  ) => {
    const producer = {
      run: value.id,
      attempt: value.run_attempt,
      source: value.head_sha,
      ...options.producer,
    };
    const snapshot = {
      format: 1,
      authority: "observer-checkpoint-cache-only",
      repository: "boburning/portcove",
      repository_id: 1354613114,
      workflow: ".github/workflows/configured-upstream-observer.yml",
      ref: "refs/heads/main",
      config_sha256: observerConfigDigest,
      created_at: new Date(Date.now() - 1000).toISOString(),
      producer,
      files: { "catalog/checkpoint.json": newCatalogObserverCheckpoint() },
    };
    const archive = createAuditZip([["checkpoint.json", JSON.stringify(snapshot)]]);
    const id = 1000 + archives.size;
    artifacts.get(value.id)!.push({
      id,
      name: snapshotName(observerConfigDigest, {
        run: value.id,
        attempt: value.run_attempt,
        source: value.head_sha,
      }),
      expired: false,
      size_in_bytes: archive.length,
      digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      workflow_run: { id: value.id, head_sha: value.head_sha },
      ...options.artifact,
    });
    archives.set(id, options.archive ? options.archive(archive) : archive);
    return { id, archive };
  };
  const transport: UpstreamTransport = {
    read: (endpoint) => {
      const workflow = /^actions\/workflows\/configured-upstream-observer\.yml\/runs\?(.+)$/u.exec(
        endpoint,
      );
      if (workflow) {
        const query = new URLSearchParams(workflow[1]);
        assert.equal(query.get("branch"), "main");
        assert.equal(query.get("status"), "completed");
        // The provider filters by trigger; a foreign row is the provider's own error.
        return Promise.resolve({
          workflow_runs: runs.filter(
            (row) => row.event === query.get("event") || row.event === "workflow_dispatch",
          ),
        });
      }
      const listed = /^actions\/runs\/(\d+)\/artifacts\?per_page=100&page=1$/u.exec(endpoint);
      if (listed) {
        const rows = artifacts.get(Number(listed[1])) ?? [];
        return Promise.resolve({ total_count: rows.length, artifacts: rows });
      }
      throw new Error(`unexpected read ${endpoint}`);
    },
    download: (endpoint, maxBytes) => {
      downloads.push(endpoint);
      const id = Number(/\/artifacts\/(\d+)\/zip$/u.exec(endpoint)?.[1]);
      const bytes = archives.get(id);
      if (!bytes) throw new Error(`unexpected download ${endpoint}`);
      assert.ok(maxBytes > 0);
      return Promise.resolve(bytes);
    },
  };
  const committed = (revision: string, file: string) => {
    assert.match(revision, /^[0-9a-f]{40}$/u);
    if (file === "release/upstream-observer.json") return configBytes;
    if (file === "crates/portcove-core/catalog/catalog.json")
      return Buffer.from(JSON.stringify(observerCatalog));
    if (file === "crates/portcove-core/catalog/listings.json")
      return Buffer.from(JSON.stringify(observerListings));
    throw new Error(`unexpected committed file ${file}`);
  };
  return {
    run,
    retain,
    downloads,
    setConfig(bytes: Buffer) {
      configBytes = bytes;
    },
    read: () => readUpstreamObservations(committed, { transport }),
  };
}

void test("the newest qualifying schedule or push run is selected and bound", async () => {
  const fixture = observerRuns();
  fixture.retain(fixture.run(101, "schedule", 90));
  // A gated push run retains no snapshot; an expired or foreign-named one is passed over.
  fixture.run(102, "push", 5);
  fixture.retain(fixture.run(103, "push", 10), { artifact: { expired: true } });
  fixture.retain(fixture.run(104, "schedule", 15), {
    artifact: { name: `upstream-observer-checkpoint-${observerConfigDigest}-104-2` },
  });
  // Cancelled runs never carry a complete snapshot, even when one is listed.
  fixture.retain(fixture.run(105, "push", 20, { conclusion: "cancelled" }));
  // A failed run can still carry a complete snapshot.
  const selected = fixture.run(106, "push", 30, { conclusion: "failure" });
  const { id, archive } = fixture.retain(selected);
  // Runs older than the one-day retention are never candidates.
  fixture.retain(fixture.run(107, "schedule", 25 * 60));
  const input = await fixture.read();
  const digest = createHash("sha256").update(archive).digest("hex");
  assert.equal(input.revision, `upstream-observer-run:106-1@${selected.head_sha}#sha256:${digest}`);
  assert.equal(input.config_sha256, observerConfigDigest);
  assert.deepEqual(input.checkpoint, newCatalogObserverCheckpoint());
  assert.deepEqual(input.catalog, { ...observerCatalog, listings: observerListings.listings });
  assert.deepEqual(fixture.downloads, [`repos/boburning/portcove/actions/artifacts/${id}/zip`]);
});

void test("a foreign producer run is refused before any artifact is read", async () => {
  for (const overrides of [
    { event: "workflow_dispatch" },
    { head_branch: "feature" },
    { path: ".github/workflows/other.yml" },
    { head_repository: { full_name: "fork/portcove" } },
  ]) {
    const fixture = observerRuns();
    fixture.retain(fixture.run(201, "schedule", 10));
    fixture.retain(fixture.run(202, "schedule", 5, overrides));
    await assert.rejects(fixture.read(), /names a foreign producer/u, JSON.stringify(overrides));
    assert.deepEqual(fixture.downloads, []);
  }
});

void test("an unbound or mismatched snapshot is refused, never passed over", async () => {
  const cases: [
    string,
    (fixture: ReturnType<typeof observerRuns>, run: FixtureRun) => void,
    RegExp,
  ][] = [
    [
      "missing digest",
      (fixture, run) => fixture.retain(run, { artifact: { digest: undefined } }),
      /checkpoint artifact is unbound/u,
    ],
    [
      "foreign workflow run",
      (fixture, run) =>
        fixture.retain(run, { artifact: { workflow_run: { id: 999, head_sha: run.head_sha } } }),
      /checkpoint artifact is unbound/u,
    ],
    [
      "downloaded bytes",
      (fixture, run) =>
        fixture.retain(run, {
          archive: (bytes) =>
            Buffer.concat([bytes.subarray(0, -1), Buffer.from([bytes.at(-1)! ^ 1])]),
        }),
      /does not match its recorded digest/u,
    ],
    [
      "configuration digest",
      (fixture, run) => {
        fixture.retain(run);
        fixture.setConfig(Buffer.from("a different observer config"));
      },
      /configuration differs from its producer source/u,
    ],
    [
      "snapshot producer",
      (fixture, run) => fixture.retain(run, { producer: { run: 999 } }),
      /snapshot producer differs from its run/u,
    ],
  ];
  for (const [label, arrange, expected] of cases) {
    const fixture = observerRuns();
    // An older valid snapshot exists; a refusal must not fall back to it.
    fixture.retain(fixture.run(301, "schedule", 60));
    arrange(fixture, fixture.run(302, "push", 10));
    await assert.rejects(fixture.read(), expected, label);
  }
});

void test("no retained snapshot is a failed run that observes nothing", async () => {
  const fixture = observerRuns();
  fixture.run(401, "schedule", 10);
  fixture.retain(fixture.run(402, "push", 20), { artifact: { expired: true } });
  await assert.rejects(
    fixture.read(),
    /None of the 2 newest completed schedule or push main observer runs/u,
  );
  const failed = await upstreamObservation(() => fixture.read());
  assert.equal(failed.failed, true);
  assert.equal(failed.revision, "upstream-observer:unavailable");
  assert.equal(failed.facts.size, 0);
  assert.deepEqual(
    failed.gaps.map(({ subject_key, code }) => [subject_key, code]),
    [["source:upstream-observer-checkpoint", "unavailable"]],
  );
  assert.deepEqual(fixture.downloads, []);
});
