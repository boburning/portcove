import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import pinFixture from "./fixtures/upstream-health-fade-to-black.json" with { type: "json" };
import { estimateHealthRequests, type HealthFetch } from "./check-catalog-repositories.mts";
import { isRecord } from "./runtime-values.mts";
import {
  advanceHealthMonitor,
  drainHealthMonitor,
  healthFreshnessMs,
  observedHealthRepositoryIdentity,
  isTrustedHealthExecution,
  type HealthExecution,
} from "./upstream-health-monitor.mts";

const epoch = Date.parse("2026-10-23T17:00:00.000Z");
const mainExecution: HealthExecution = {
  actions: true,
  repository: "boburning/portcove",
  ref: "refs/heads/main",
  workflow_ref: "boburning/portcove/.github/workflows/upstream-health.yml@refs/heads/main",
  event: "schedule",
  source_commit: "a".repeat(40),
  run_id: "1234",
  run_attempt: "1",
};
type Options = Parameters<typeof advanceHealthMonitor>[2];

function catalog(count = 1) {
  return {
    ports: Array.from({ length: count }, (_, index): Record<string, unknown> & { id: string } => ({
      id: `port-${index + 1}`,
      project_url: `https://github.com/owner/port-${index + 1}`,
      release: { provider: "user-prepared" },
    })),
  };
}

function response(status = 200, repositoryId = 1): HealthFetch {
  return async (url) =>
    status === 200
      ? new Response(
          JSON.stringify({
            id: repositoryId,
            full_name: url.replace("https://api.github.com/repos/", ""),
            archived: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : new Response(null, { status });
}

function options(overrides: Partial<Options> = {}): Options {
  return {
    execution: mainExecution,
    scope: { mode: "full", port_ids: [] },
    policySha256: "b".repeat(64),
    now: () => epoch,
    fetch: response(),
    ...overrides,
  };
}

void test("a completed 404 observation remains visible and repeated incidents retain their first clock", async () => {
  const first = await advanceHealthMonitor(catalog(), null, options({ fetch: response(404) }));
  assert.equal(first.exitCode, 0);
  assert.equal(first.report.collection.collection_status, "complete");
  assert.equal(first.report.collection.outcome, "incomplete");
  assert.equal(first.report.collection.material_changes.length, 1);
  assert.match(first.summary, /inaccessible-or-missing.*404/u);
  assert.ok(first.checkpoint);
  const repeated = await advanceHealthMonitor(
    catalog(),
    first.checkpoint,
    options({ now: () => epoch + healthFreshnessMs + 1000, fetch: response(404) }),
  );
  assert.equal(repeated.exitCode, 0);
  assert.equal(repeated.report.collection.material_changes.length, 0);
  assert.equal(
    repeated.report.collection.port_health[0]!.canonical_incidents[0]!.first_seen,
    first.report.collection.port_health[0]!.canonical_incidents[0]!.first_seen,
  );
  assert.match(repeated.summary, /\*\*1 continuing\*\*/u);
  assert.match(repeated.summary, /2 observation\(s\); 1d 0h observed span/u);
  assert.match(repeated.summary, /github:owner\/port-1/u);
  assert.match(repeated.summary, /Unaccounted observation; investigate exact scope/u);
});

void test("inconclusive failures retain missing-incident history without reporting it as current", async () => {
  const missing = await advanceHealthMonitor(catalog(), null, options({ fetch: response(404) }));
  const original = missing.report.collection.port_health[0]!.canonical_incidents[0]!;
  const failed = await advanceHealthMonitor(
    catalog(),
    missing.checkpoint,
    options({ now: () => epoch + 1000, fetch: response(503) }),
  );
  assert.deepEqual(
    failed.report.known_conditions.map((incident) => incident.rule),
    ["provider-error"],
  );
  assert.equal(failed.checkpoint?.incident_history[0]?.canonical_incidents.length, 2);
  assert.deepEqual(failed.report.collection.resolved_incidents, []);
  assert.match(failed.summary, /Partial collection; outcome not established/u);
  const stillMissing = await advanceHealthMonitor(
    catalog(),
    failed.checkpoint,
    options({ now: () => epoch + 2000, fetch: response(404) }),
  );
  const repeated = stillMissing.report.collection.port_health[0]!.canonical_incidents[0]!;
  assert.equal(repeated.first_seen, original.first_seen);
  assert.equal(repeated.occurrences, 2);
  assert.equal(repeated.notify, false);
  assert.deepEqual(
    stillMissing.report.known_conditions.map((incident) => incident.rule),
    ["inaccessible-or-missing"],
  );
  const recovered = await advanceHealthMonitor(
    catalog(),
    stillMissing.checkpoint,
    options({ now: () => epoch + 3000 }),
  );
  assert.ok(recovered.report.collection.resolved_incidents.includes(original.key));
  assert.deepEqual(recovered.checkpoint?.incident_history[0]?.canonical_incidents, []);
});

void test("changed provider pin identities stay visible and metadata recovery does not claim endpoint recovery", async () => {
  const asset = pinFixture.assets.find((entry) => entry.name.endsWith("windows-x64.zip"));
  assert.ok(asset);
  const assetUrl = asset.browser_download_url;
  const input = {
    ports: [
      {
        id: "fixture-pin",
        release: {
          provider: "direct-manifest",
          direct: {
            "windows-x86-64": {
              url: assetUrl,
              version: pinFixture.release.tag_name,
              size: asset.size,
              sha256: asset.digest.replace(/^sha256:/u, ""),
            },
          },
        },
      },
    ],
  };
  const policy = {
    format_version: 2,
    input_version: 1,
    authority: "offline observation fixture",
    decision: "No numeric identity acceptance",
    pins: [],
    original_conditions: [],
  };
  const provider = (variant: "original" | "changed" | "broken"): HealthFetch => {
    const facts = structuredClone(pinFixture);
    if (variant !== "original")
      for (const entry of [...facts.assets, ...facts.release.assets]) entry.id++;
    return async (url) => {
      if (url === assetUrl) return new Response(null, { status: 302 });
      if (url.includes("/assets?"))
        return variant === "broken"
          ? new Response("{broken", { headers: { "content-type": "application/json" } })
          : Response.json(facts.assets);
      if (url.includes("/releases/tags/")) return Response.json(facts.release);
      return Response.json(facts.repository);
    };
  };
  const first = await advanceHealthMonitor(
    input,
    null,
    options({ reviewedAccounting: policy, fetch: provider("original") }),
  );
  const unchanged = await advanceHealthMonitor(
    input,
    first.checkpoint,
    options({ reviewedAccounting: policy, now: () => epoch + 1000, fetch: provider("original") }),
  );
  assert.match(unchanged.summary, /1 routine provider metadata conditions/u);
  const changed = await advanceHealthMonitor(
    input,
    unchanged.checkpoint,
    options({ reviewedAccounting: policy, now: () => epoch + 2000, fetch: provider("changed") }),
  );
  assert.equal(changed.report.collection.material_changes.length, 1);
  assert.match(changed.summary, /\*\*1 new or changed\*\*/u);
  assert.match(changed.summary, /fixture-pin.*New\/changed/u);
  const failed = await advanceHealthMonitor(
    input,
    changed.checkpoint,
    options({ reviewedAccounting: policy, now: () => epoch + 3000, fetch: provider("broken") }),
  );
  assert.equal(failed.exitCode, 1);
  const recovered = await advanceHealthMonitor(
    input,
    failed.checkpoint,
    options({ reviewedAccounting: policy, now: () => epoch + 4000, fetch: provider("changed") }),
  );
  assert.equal(recovered.exitCode, 0);
  assert.deepEqual(recovered.report.collection.resolved_incidents, []);
  assert.equal(recovered.report.collection.assessment_recovered_incidents.length, 1);
  assert.match(
    recovered.summary,
    /\*\*0 endpoint recoveries\*\*, \*\*1 metadata assessments recovered\*\*/u,
  );
});

void test("presentation changes on main make zero calls and preserve history", async () => {
  const first = await advanceHealthMonitor(catalog(), null, options({ fetch: response(404) }));
  const changed = catalog();
  changed.ports[0]!.name = "New title";
  changed.ports[0]!.summary = "New copy";
  changed.ports[0]!.presentation = { artwork: { cover: "new cover" } };
  let calls = 0;
  const next = await advanceHealthMonitor(
    changed,
    first.checkpoint,
    options({
      execution: { ...mainExecution, event: "push" },
      now: () => epoch + 1000,
      fetch: async (...args) => {
        calls += 1;
        return response(404)(...args);
      },
    }),
  );
  assert.equal(calls, 0);
  assert.deepEqual(next.report.batch.selected_port_ids, []);
  assert.deepEqual(next.checkpoint?.port_health, first.checkpoint?.port_health);
  assert.deepEqual(next.report.inventory.fresh_complete_port_ids, ["port-1"]);
  assert.match(next.summary, /No live upstream requests/u);
});

void test("adding another port retains the old incident and only checks the new input on push", async () => {
  const first = await advanceHealthMonitor(catalog(), null, options({ fetch: response(404) }));
  const calls: string[] = [];
  const next = await advanceHealthMonitor(
    catalog(2),
    first.checkpoint,
    options({
      execution: { ...mainExecution, event: "push" },
      now: () => epoch + 1000,
      fetch: async (url, init) => {
        calls.push(url);
        return response()(url, init);
      },
    }),
  );
  assert.deepEqual(next.report.batch.selected_port_ids, ["port-2"]);
  assert.deepEqual(calls, ["https://api.github.com/repos/owner/port-2"]);
  assert.equal(
    next.checkpoint?.port_health.find((port) => port.port_id === "port-1")?.canonical_incidents[0]
      ?.first_seen,
    first.checkpoint?.port_health[0]?.canonical_incidents[0]?.first_seen,
  );
  const repeat = await advanceHealthMonitor(
    catalog(2),
    next.checkpoint,
    options({
      scope: { mode: "affected", port_ids: ["port-1"] },
      now: () => epoch + 2000,
      fetch: response(404),
    }),
  );
  assert.equal(repeat.report.collection.material_changes.length, 0);
});

void test("lineage-only authoring changes refresh the affected otherwise-fresh port", async () => {
  const authored = {
    listing: { id: "port-1", project_url: "https://github.com/owner/port-1", issue_number: 1 },
    upstream_lineage: {
      format_version: 1,
      target_key: "port-1",
      origin: { project_url: "https://github.com/owner/port-1" },
      decisions: [],
    },
  };
  const first = await advanceHealthMonitor(
    catalog(2),
    null,
    options({ lineageRecords: [authored] }),
  );
  const changed = {
    ...authored,
    upstream_lineage: {
      ...authored.upstream_lineage,
      origin: { ...authored.upstream_lineage.origin, repository: { host: "github.com", id: "1" } },
    },
  };
  const calls: string[] = [];
  const next = await advanceHealthMonitor(
    catalog(2),
    first.checkpoint,
    options({
      execution: { ...mainExecution, event: "push" },
      now: () => epoch + 1000,
      lineageRecords: [changed],
      fetch: async (url, init) => {
        calls.push(url);
        return response()(url, init);
      },
    }),
  );
  assert.deepEqual(next.report.batch.selected_port_ids, ["port-1"]);
  assert.deepEqual(calls, ["https://api.github.com/repos/owner/port-1"]);
  assert.notEqual(
    next.checkpoint?.attempts[0]?.health_contract_sha256,
    first.checkpoint?.attempts[0]?.health_contract_sha256,
  );
});

void test("a port freshness change preserves an unchanged endpoint incident", async () => {
  const first = await advanceHealthMonitor(catalog(), null, options({ fetch: response(404) }));
  const original = first.report.collection.port_health[0]!.canonical_incidents[0]!;
  const changed = catalog();
  changed.ports[0]!.platforms = ["windows-x86-64"];
  const next = await advanceHealthMonitor(
    changed,
    first.checkpoint,
    options({
      execution: { ...mainExecution, event: "push" },
      now: () => epoch + 1000,
      fetch: response(404),
    }),
  );
  const repeated = next.report.collection.port_health[0]!.canonical_incidents[0]!;
  assert.deepEqual(next.report.batch.selected_port_ids, ["port-1"]);
  assert.equal(repeated.key, original.key);
  assert.equal(repeated.first_seen, original.first_seen);
  assert.equal(repeated.occurrences, 2);
  assert.equal(repeated.notify, false);
  assert.deepEqual(next.report.collection.material_changes, []);
});

void test("bounded batches rotate across the inventory and keep unassessed scope explicit", async () => {
  const estimate: NonNullable<Options["estimate"]> = (...args) => ({
    ...estimateHealthRequests(...args),
    hard_ceiling: 2,
  });
  const first = await advanceHealthMonitor(catalog(3), null, options({ estimate }));
  assert.equal(first.report.batch.selected_port_ids.length, 2);
  assert.deepEqual(first.report.batch.deferred_port_ids, ["port-3"]);
  assert.deepEqual(first.report.inventory.unmonitored_port_ids, ["port-3"]);
  assert.deepEqual(first.report.inventory.unassessed_this_run_port_ids, ["port-3"]);
  const next = await advanceHealthMonitor(
    catalog(3),
    first.checkpoint,
    options({ estimate, now: () => epoch + 1000 }),
  );
  assert.equal(next.report.batch.selected_port_ids[0], "port-3");
  assert.equal(next.report.inventory.fresh_complete_port_ids.length, 3);
  assert.equal(next.report.inventory.unassessed_this_run_port_ids.length, 1);
  assert.equal(next.report.collection.scope.global_health, "not assessed");
});

void test("a wall-clock-deferred tail leads the next batch and partial main pushes remain due", async () => {
  let now = epoch;
  const first = await advanceHealthMonitor(
    catalog(3),
    null,
    options({
      now: () => now,
      fetch: async (...args) => {
        now += 180_001;
        return response()(...args);
      },
    }),
  );
  assert.equal(first.report.collection.collection_status, "partial");
  assert.equal(first.report.collection.consumed.requests, 1);
  assert.equal(
    first.checkpoint?.attempts.find((attempt) => attempt.port_id === "port-2")
      ?.scheduling_attempted_at,
    null,
  );
  const calls: string[] = [];
  const next = await advanceHealthMonitor(
    catalog(3),
    first.checkpoint,
    options({
      execution: { ...mainExecution, event: "push" },
      now: () => now + 1000,
      fetch: async (url, init) => {
        calls.push(url);
        return response()(url, init);
      },
    }),
  );
  assert.deepEqual(next.report.batch.selected_port_ids, ["port-2", "port-3", "port-1"]);
  assert.equal(calls[0], "https://api.github.com/repos/owner/port-2");
  assert.equal(next.report.collection.collection_status, "complete");
});

void test("zero-request historical obligations still rotate within the observation ceiling", async () => {
  const ports = catalog(2).ports;
  for (const port of ports) delete port.project_url;
  const input = {
    ports,
    source_catalog: {
      qualification: ports.flatMap((port) =>
        Array.from({ length: 300 }, (_, index) => ({
          scope: {
            port_id: port.id,
            upstream_ref: `release-${index}`,
            artifact_sha256: "a".repeat(64),
          },
        })),
      ),
    },
  };
  let calls = 0;
  const settings = options({
    fetch: async (...args) => {
      calls += 1;
      return response()(...args);
    },
  });
  const first = await advanceHealthMonitor(input, null, settings);
  assert.deepEqual(first.report.batch.selected_port_ids, ["port-1"]);
  assert.deepEqual(first.report.batch.deferred_port_ids, ["port-2"]);
  assert.equal(first.report.collection.request_plan.observation_records, 300);
  const next = await advanceHealthMonitor(input, first.checkpoint, {
    ...settings,
    now: () => epoch + 1000,
  });
  assert.deepEqual(next.report.batch.selected_port_ids, ["port-2"]);
  assert.equal(next.checkpoint?.observations.length, 600);
  assert.deepEqual(next.report.inventory.fresh_complete_port_ids, ["port-1", "port-2"]);
  assert.equal(calls, 0);
});

void test("fresh failures replace old success and recovery only clears the reassessed incident", async () => {
  const first = await advanceHealthMonitor(catalog(2), null, options());
  const failed = await advanceHealthMonitor(
    catalog(2),
    first.checkpoint,
    options({
      scope: { mode: "affected", port_ids: ["port-1"] },
      now: () => epoch + 1000,
      fetch: async () => {
        throw new Error("fixture transport failure");
      },
    }),
  );
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.report.collection.collection_status, "partial");
  assert.equal(
    failed.checkpoint?.observations.find((entry) => entry.port_ids.includes("port-1"))?.status,
    "unknown",
  );
  assert.deepEqual(failed.report.inventory.fresh_partial_port_ids, ["port-1"]);
  assert.deepEqual(failed.report.inventory.fresh_complete_port_ids, ["port-2"]);
  const other = await advanceHealthMonitor(
    catalog(2),
    failed.checkpoint,
    options({ scope: { mode: "affected", port_ids: ["port-2"] }, now: () => epoch + 2000 }),
  );
  assert.deepEqual(other.report.collection.resolved_incidents, []);
  assert.equal(
    other.checkpoint?.port_health.find((port) => port.port_id === "port-1")?.canonical_incidents
      .length,
    1,
  );
  const recovered = await advanceHealthMonitor(
    catalog(2),
    other.checkpoint,
    options({ scope: { mode: "affected", port_ids: ["port-1"] }, now: () => epoch + 3000 }),
  );
  assert.equal(recovered.report.collection.resolved_incidents.length, 1);
  assert.equal(
    recovered.checkpoint?.port_health.find((port) => port.port_id === "port-1")?.canonical_incidents
      .length,
    0,
  );
});

void test("a changed repository numeric identity stays a finding across later attempts", async () => {
  const first = await advanceHealthMonitor(catalog(), null, options());
  const changed = await advanceHealthMonitor(
    catalog(),
    first.checkpoint,
    options({ now: () => epoch + 1000, fetch: response(200, 2) }),
  );
  assert.equal(changed.report.collection.observations[0]!.reason, "identity-mismatch");
  assert.equal(changed.report.collection.observations[0]!.baseline_repository_id, 1);
  const again = await advanceHealthMonitor(
    catalog(),
    changed.checkpoint,
    options({ now: () => epoch + 2000, fetch: response(200, 2) }),
  );
  assert.equal(again.report.collection.observations[0]!.reason, "identity-mismatch");
  assert.equal(again.report.collection.observations[0]!.baseline_repository_id, 1);
});

void test("a shared location retains its identity baseline when different ports are batched", async () => {
  const shared = catalog(2);
  shared.ports[1]!.project_url = shared.ports[0]!.project_url;
  const first = await advanceHealthMonitor(
    shared,
    null,
    options({ scope: { mode: "affected", port_ids: ["port-1"] } }),
  );
  assert.deepEqual(first.checkpoint?.observations[0]?.port_ids, ["port-1", "port-2"]);
  const changed = await advanceHealthMonitor(
    shared,
    first.checkpoint,
    options({
      scope: { mode: "affected", port_ids: ["port-2"] },
      now: () => epoch + 1000,
      fetch: response(200, 2),
    }),
  );
  assert.equal(changed.report.collection.observations[0]?.reason, "identity-mismatch");
  assert.equal(changed.report.collection.observations[0]?.baseline_repository_id, 1);
  const repeated = await advanceHealthMonitor(
    shared,
    changed.checkpoint,
    options({
      scope: { mode: "affected", port_ids: ["port-1"] },
      now: () => epoch + 2000,
      fetch: response(200, 2),
    }),
  );
  assert.equal(repeated.report.collection.observations[0]?.baseline_repository_id, 1);
});

void test("a partial batch preserves per-port complete and partial coverage", async () => {
  const result = await advanceHealthMonitor(
    catalog(2),
    null,
    options({
      fetch: async (url, init) => {
        if (url.endsWith("port-1")) throw new Error("fixture transport failure");
        return response()(url, init);
      },
    }),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.collection.collection_status, "partial");
  assert.deepEqual(result.report.inventory.fresh_complete_port_ids, ["port-2"]);
  assert.deepEqual(result.report.inventory.fresh_partial_port_ids, ["port-1"]);
});

void test("PR diagnostics can compare main history but cannot produce a main checkpoint", async () => {
  const first = await advanceHealthMonitor(catalog(), null, options({ fetch: response(404) }));
  const pr = {
    ...mainExecution,
    event: "pull_request",
    ref: "refs/pull/20/merge",
    workflow_ref: "boburning/portcove/.github/workflows/upstream-health.yml@refs/pull/20/merge",
  };
  const next = await advanceHealthMonitor(
    catalog(),
    first.checkpoint,
    options({ execution: pr, now: () => epoch + 1000, fetch: response(404) }),
  );
  assert.equal(next.checkpoint, null);
  assert.equal(next.report.collection.material_changes.length, 0);
  for (const invalid of [
    { ...first.checkpoint, ref: "refs/pull/20/merge" },
    { ...first.checkpoint, repository: "other/repository" },
    { ...first.checkpoint, execution: pr },
    { ...first.checkpoint, updated_at: new Date(epoch + 1000).toISOString() },
  ]) {
    await assert.rejects(advanceHealthMonitor(catalog(), invalid, options()), /checkpoint/u);
  }
  assert.equal(isTrustedHealthExecution(pr), false);
  assert.equal(isTrustedHealthExecution({ ...mainExecution, event: "pull_request_target" }), false);
});

void test("malformed or future cached history fails closed before live requests", async () => {
  const first = await advanceHealthMonitor(catalog(), null, options());
  assert.ok(first.checkpoint);
  let calls = 0;
  for (const invalid of [
    { ...first.checkpoint, port_health: [] },
    { ...first.checkpoint, execution: { ...mainExecution, actions: "true" } },
    {
      ...first.checkpoint,
      observations: [
        { ...first.checkpoint.observations[0], observed_at: new Date(epoch + 1000).toISOString() },
      ],
    },
  ]) {
    await assert.rejects(
      advanceHealthMonitor(
        catalog(),
        invalid,
        options({
          fetch: async (...args) => {
            calls += 1;
            return response()(...args);
          },
        }),
      ),
      /checkpoint/u,
    );
  }
  assert.equal(calls, 0);
});

void test("a corrupt cached repository identity cannot silently establish a new baseline", async () => {
  const first = await advanceHealthMonitor(catalog(), null, options());
  assert.ok(first.checkpoint);
  const corrupted = {
    ...first.checkpoint,
    observations: [
      {
        ...first.checkpoint.observations[0],
        baseline_repository_id: "broken",
        observed_repository_id: null,
      },
    ],
  };
  let calls = 0;
  await assert.rejects(
    advanceHealthMonitor(
      catalog(),
      corrupted,
      options({
        fetch: async (...args) => {
          calls += 1;
          return response(200, 2)(...args);
        },
      }),
    ),
    /checkpoint/u,
  );
  assert.equal(calls, 0);
});

void test("cache absence and stale unassessed history are never represented as fresh coverage", async () => {
  const none = await advanceHealthMonitor(
    catalog(2),
    null,
    options({ scope: { mode: "none", port_ids: [] } }),
  );
  assert.deepEqual(none.report.inventory.unmonitored_port_ids, ["port-1", "port-2"]);
  assert.equal(none.report.inventory.fresh_complete_port_ids.length, 0);
  assert.match(none.report.previous_checkpoint, /comparison unavailable/u);
  const first = await advanceHealthMonitor(catalog(2), null, options());
  const stale = await advanceHealthMonitor(
    catalog(2),
    first.checkpoint,
    options({
      scope: { mode: "affected", port_ids: ["port-1"] },
      now: () => epoch + healthFreshnessMs + 1000,
    }),
  );
  assert.deepEqual(stale.report.inventory.stale_port_ids, ["port-2"]);
  assert.deepEqual(stale.report.inventory.fresh_complete_port_ids, ["port-1"]);
});

void test("a single impossible port budget performs no IO and remains a visible failed obligation", async () => {
  let calls = 0;
  const result = await advanceHealthMonitor(
    catalog(),
    null,
    options({
      estimate: (...args) => ({ ...estimateHealthRequests(...args), hard_ceiling: 0 }),
      fetch: async (...args) => {
        calls += 1;
        return response()(...args);
      },
    }),
  );
  assert.equal(calls, 0);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report.batch.oversized_port_ids, ["port-1"]);
  assert.deepEqual(result.report.inventory.unmonitored_port_ids, ["port-1"]);
});

void test("missing planner scope emits CLI failure artifacts without network work or a checkpoint", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "portcove-health-missing-scope-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "scripts"));
  await mkdir(path.join(directory, ".github"));
  for (const script of [
    "upstream-health-monitor",
    "upstream-health-triage",
    "check-catalog-repositories",
    "observe-configured-upstream",
    "upstream-observer",
    "upstream-health-inputs",
    "upstream-lineage",
    "release-path-safety",
    "json-values",
    "runtime-values",
  ])
    await copyFile(
      new URL(`./${script}.mts`, import.meta.url),
      path.join(directory, "scripts", `${script}.mts`),
    );
  await copyFile(
    new URL("../.github/upstream-health-accounting.json", import.meta.url),
    path.join(directory, ".github/upstream-health-accounting.json"),
  );
  const denyNetwork = path.join(directory, "deny-network.mjs");
  await writeFile(
    denyNetwork,
    'import {writeFileSync} from "node:fs"; globalThis.fetch = () => { writeFileSync(new URL("./network-attempted", import.meta.url), "blocked"); throw new Error("NETWORK_FORBIDDEN"); };',
  );
  const stepSummary = path.join(directory, "step-summary.md");
  const outputs = path.join(directory, "step-outputs");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(denyNetwork).href,
      path.join(directory, "scripts/upstream-health-monitor.mts"),
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HEALTH_MODE: "",
        HEALTH_PORT_IDS: "",
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: mainExecution.repository,
        GITHUB_REF: mainExecution.ref,
        GITHUB_WORKFLOW_REF: mainExecution.workflow_ref,
        GITHUB_EVENT_NAME: mainExecution.event,
        GITHUB_SHA: mainExecution.source_commit,
        GITHUB_RUN_ID: mainExecution.run_id,
        GITHUB_RUN_ATTEMPT: mainExecution.run_attempt,
        GITHUB_TOKEN: "",
        GITHUB_OUTPUT: outputs,
        GITHUB_STEP_SUMMARY: stepSummary,
      },
    },
  );
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /Upstream health monitoring failed; retained report and prior history require inspection\./u,
  );
  const report: unknown = JSON.parse(
    await readFile(path.join(directory, "work/upstream-health/report.json"), "utf8"),
  );
  assert.ok(isRecord(report));
  assert.equal(report.collection_status, "failed");
  assert.match(
    await readFile(path.join(directory, "work/upstream-health/summary.md"), "utf8"),
    /Collection failed/u,
  );
  assert.match(await readFile(stepSummary, "utf8"), /Collection failed/u);
  for (const absent of [
    "work/upstream-health/checkpoint.json",
    "network-attempted",
    "step-outputs",
  ])
    await assert.rejects(readFile(path.join(directory, absent)), { code: "ENOENT" });
});

void test("the hosted workflow saves main history only and retains reports on unsuccessful collection", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/upstream-health.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /node scripts\/upstream-health-monitor\.mts/u);
  assert.match(
    workflow,
    /name: Observe a bounded batch and retain incident history\s+if: \$\{\{ !cancelled\(\) \}\}/u,
  );
  assert.match(
    workflow,
    /github\.ref == 'refs\/heads\/main'.*github\.event_name != 'pull_request'.*checkpoint_updated == 'true'/u,
  );
  assert.match(workflow, /restore-keys: upstream-health-history-v1-main-/u);
  assert.match(workflow, /name: Retain monitoring report\s+if: \$\{\{ !cancelled\(\) \}\}/u);
  assert.doesNotMatch(workflow, /continue-on-error/u);
  assert.match(
    workflow,
    /RETCOMM_PORT_IDS: \$\{\{ steps\.monitor\.outputs\.retcomm_port_ids \}\}/u,
  );
  for (const trigger of ["pull_request", "push"]) {
    const section = workflow.split(`  ${trigger}:`)[1]?.split(/^ {2}\w+:/mu)[0] ?? "";
    for (const dependency of [
      "upstream-lineage",
      "observe-configured-upstream",
      "release-path-safety",
      "runtime-values",
      "json-values",
      "select-ci-plan",
    ])
      assert.ok(
        section.includes(`"scripts/${dependency}.mts"`),
        `${trigger} must follow ${dependency}`,
      );
  }
});

void test("catalog coverage progresses beyond one collector and history batch without claiming global health", async () => {
  const input = catalog(641);
  let checkpoint: Awaited<ReturnType<typeof advanceHealthMonitor>>["checkpoint"] = null;
  const assessed = new Set<string>();
  for (let batch = 0; batch < 3; batch++) {
    const result = await advanceHealthMonitor(
      input,
      checkpoint,
      options({ now: () => epoch + batch * 1000 }),
    );
    checkpoint = result.checkpoint;
    assert.ok(result.report.collection.consumed.requests <= 320);
    for (const id of result.report.batch.selected_port_ids) assessed.add(id);
    assert.equal(result.report.collection.scope.global_health, "not assessed");
    if (batch === 0) assert.ok(result.report.inventory.unmonitored_port_ids.length > 0);
  }
  assert.equal(assessed.size, 641);
  assert.ok(checkpoint!.observations.length > 512);
  assert.equal(checkpoint!.attempts.length, 641);
  const resumed = await advanceHealthMonitor(
    input,
    checkpoint,
    options({ scope: { mode: "none", port_ids: [] }, now: () => epoch + 4000 }),
  );
  assert.equal(resumed.report.inventory.fresh_complete_port_ids.length, 641);
  assert.equal(resumed.checkpoint!.observations.length, 641);
});

void test("physical byte envelopes replace catalog and historical cardinality ceilings", async () => {
  const empty = await advanceHealthMonitor(
    catalog(4097),
    null,
    options({ scope: { mode: "none", port_ids: [] } }),
  );
  assert.equal(empty.report.inventory.unmonitored_port_ids.length, 4097);
  const initial = await advanceHealthMonitor(catalog(), null, options());
  const history = structuredClone(initial.checkpoint!);
  history.observations = Array.from({ length: 8193 }, (_, index) => ({
    ...history.observations[0]!,
    repository: `owner/history-${index}`,
  }));
  const resumed = await advanceHealthMonitor(
    catalog(),
    history,
    options({ scope: { mode: "none", port_ids: [] } }),
  );
  assert.equal(resumed.checkpoint!.observations.length, 8193);
  const recollected = await advanceHealthMonitor(
    catalog(),
    resumed.checkpoint,
    options({ now: () => epoch + 1000 }),
  );
  assert.equal(recollected.report.collection.collection_status, "complete");
  assert.equal(recollected.report.collection.consumed.requests, 1);
  assert.equal(recollected.checkpoint!.observations.length, 1);
  await assert.rejects(
    advanceHealthMonitor({ ...catalog(), extra: "x".repeat(4 * 1024 * 1024) }, null, options()),
    /bounded catalog/,
  );
  await assert.rejects(
    advanceHealthMonitor(catalog(), { ...history, extra: "x".repeat(16 * 1024 * 1024) }, options()),
    /resource bounds/,
  );
});

void test("release observation reuses only equivalent fresh primary repository identity", async () => {
  const result = await advanceHealthMonitor(catalog(), null, options());
  assert.equal(observedHealthRepositoryIdentity(result.checkpoint, "owner/port-1", epoch), 1);
  assert.equal(observedHealthRepositoryIdentity(result.checkpoint, "owner/other", epoch), null);
  assert.equal(
    observedHealthRepositoryIdentity(
      result.checkpoint,
      "owner/port-1",
      epoch + healthFreshnessMs + 1,
    ),
    null,
  );
  const refreshedEnvelope = structuredClone(result.checkpoint!);
  refreshedEnvelope.updated_at = new Date(epoch + healthFreshnessMs + 1).toISOString();
  assert.equal(
    observedHealthRepositoryIdentity(
      refreshedEnvelope,
      "owner/port-1",
      epoch + healthFreshnessMs + 1,
    ),
    null,
  );
  const unknown = structuredClone(result.checkpoint!);
  unknown.observations[0]!.status = "unknown";
  assert.equal(observedHealthRepositoryIdentity(unknown, "owner/port-1", epoch), null);
  const untrusted = structuredClone(result.checkpoint!);
  untrusted.execution.ref = "refs/heads/foreign";
  assert.throws(
    () => observedHealthRepositoryIdentity(untrusted, "owner/port-1", epoch),
    /invalid identity/,
  );
});

function oversizedCatalog(count = 641) {
  return {
    ...catalog(2),
    source_catalog: {
      qualification: Array.from({ length: count }, (_, index) => ({
        scope: {
          port_id: "port-1",
          upstream_ref: `release-${index}`,
          artifact_sha256: "a".repeat(64),
        },
      })),
    },
  };
}

void test("an oversized single collection progresses beyond 320 requests and 512 records beside a smaller port", async () => {
  const input = oversizedCatalog();
  let calls = 0;
  const settings = options({
    fetch: async (...args) => {
      calls += 1;
      return response(404)(...args);
    },
  });
  let result = await advanceHealthMonitor(input, null, settings);
  assert.deepEqual(result.report.batch.selected_port_ids, ["port-1", "port-2"]);
  assert.equal(result.report.collection.consumed.requests, 320);
  assert.equal(result.report.collection.observations.length, 643);
  assert.deepEqual(result.report.inventory.fresh_complete_port_ids, ["port-2"]);
  assert.deepEqual(result.report.inventory.fresh_partial_port_ids, ["port-1"]);
  const firstClock = result.checkpoint!.observations.find(
    (record) => record.attempted,
  )!.observed_at;
  result = await advanceHealthMonitor(input, result.checkpoint, {
    ...settings,
    continueDueOnly: true,
    now: () => epoch + 1000,
  });
  assert.equal(result.report.collection.consumed.requests, 320);
  result = await advanceHealthMonitor(input, result.checkpoint, {
    ...settings,
    continueDueOnly: true,
    now: () => epoch + 2000,
  });
  assert.equal(result.report.collection.consumed.requests, 3);
  assert.deepEqual(result.report.inventory.fresh_complete_port_ids, ["port-1", "port-2"]);
  assert.equal(calls, 643);
  assert.equal(
    result.checkpoint!.attempts.find((attempt) => attempt.port_id === "port-1")!
      .freshness_observed_at,
    firstClock,
  );
  assert.ok(
    result.report.collection.observations.some(
      (record) => record.metadata_reused && record.observed_at === firstClock,
    ),
  );
  assert.ok(
    result.report.collection.port_health[0]!.canonical_incidents.every(
      (incident) => incident.occurrences === 1,
    ),
  );
  assert.equal(result.report.collection.scope.global_health, "not assessed");
});

void test("per-location progress survives interruption, preserves source bindings, and never grants PR checkpoint authority", async () => {
  const input = oversizedCatalog(12);
  let saved: unknown = null;
  let writes = 0;
  let calls = 0;
  await assert.rejects(
    advanceHealthMonitor(
      input,
      null,
      options({
        fetch: async (...args) => {
          calls += 1;
          return response(404)(...args);
        },
        persistProgress: async (value) => {
          saved = structuredClone(value);
          if (++writes === 5) throw new Error("fixture interrupted after durable record");
        },
      }),
    ),
    /fixture interrupted/,
  );
  assert.equal(calls, 5);
  let resumedCalls = 0;
  const resumed = await advanceHealthMonitor(
    input,
    saved,
    options({
      now: () => epoch + 1000,
      fetch: async (...args) => {
        resumedCalls += 1;
        return response(404)(...args);
      },
    }),
  );
  assert.equal(resumedCalls, 9);
  assert.equal(resumed.report.collection.collection_status, "complete");
  const changed = structuredClone(input);
  changed.ports[0]!.project_url = "https://github.com/owner/replaced";
  let changedCalls = 0;
  await advanceHealthMonitor(
    changed,
    saved,
    options({
      now: () => epoch + 1000,
      fetch: async (...args) => {
        changedCalls += 1;
        return response(404)(...args);
      },
    }),
  );
  assert.equal(changedCalls, 13);
  const corrupt = structuredClone(saved) as {
    continuation: { observations: { observed_at: string }[] };
  };
  corrupt.continuation.observations[0]!.observed_at = new Date(epoch + 100000).toISOString();
  await assert.rejects(advanceHealthMonitor(input, corrupt, options()), /continuation/);
  let prWrites = 0;
  const pr = await advanceHealthMonitor(
    input,
    null,
    options({
      execution: { ...mainExecution, event: "pull_request", ref: "refs/pull/1/merge" },
      persistProgress: async () => {
        prWrites += 1;
      },
    }),
  );
  assert.equal(prWrites, 0);
  assert.equal(pr.checkpoint, null);
});

void test("automatic draining finishes logical oversized work without specification splitting or failed-read retry loops", async () => {
  let calls = 0;
  const input = oversizedCatalog();
  const result = await drainHealthMonitor(input, null, {
    ...options({
      fetch: async (...args) => {
        calls += 1;
        return response(404)(...args);
      },
    }),
    sessionDeadline: epoch + 120000,
  });
  assert.equal(calls, 643);
  assert.equal(result.report.session!.batches.length, 3);
  assert.deepEqual(
    result.report.session!.batches.map((batch) => batch.requests),
    [320, 320, 3],
  );
  assert.equal(result.report.inventory.fresh_complete_port_ids.length, 2);
  assert.equal(result.exitCode, 0);
  let failures = 0;
  const failed = await drainHealthMonitor(input, null, {
    ...options({
      fetch: async (...args) => {
        failures += 1;
        return response(503)(...args);
      },
    }),
    sessionDeadline: epoch + 120000,
  });
  assert.equal(failures, 643);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.report.session!.batches.length, 3);
  assert.ok(failed.report.known_conditions.some((record) => record.rule === "provider-error"));
});

void test("zero-request oversized history continues automatically with original failure clocks", async () => {
  const input = oversizedCatalog(1100);
  delete input.ports[0]!.project_url;
  let calls = 0;
  const result = await drainHealthMonitor(input, null, {
    ...options({
      fetch: async (...args) => {
        calls += 1;
        return response()(...args);
      },
    }),
    sessionDeadline: epoch + 120000,
  });
  assert.equal(calls, 1);
  assert.equal(result.report.session!.batches.length, 3);
  assert.equal(result.report.inventory.fresh_complete_port_ids.length, 2);
  assert.equal(result.checkpoint!.observations.length, 1101);
  assert.equal(result.report.collection.outcome, "incomplete");
});

void test("quota reset, cancellation and policy identity remain binding during endpoint continuation", async () => {
  let calls = 0;
  const limited = await advanceHealthMonitor(
    catalog(2),
    null,
    options({
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 429, headers: { "retry-after": "120" } });
      },
    }),
  );
  assert.equal(calls, 1);
  const waiting = await advanceHealthMonitor(
    catalog(2),
    limited.checkpoint,
    options({
      now: () => epoch + 1000,
      fetch: async () => {
        throw new Error("must wait for provider reset");
      },
    }),
  );
  assert.equal(waiting.report.collection.consumed.requests, 0);
  const reset = await advanceHealthMonitor(
    catalog(2),
    waiting.checkpoint,
    options({ now: () => epoch + 121000 }),
  );
  assert.equal(reset.report.collection.consumed.requests, 2);
  const controller = new AbortController();
  let saved: unknown;
  await assert.rejects(
    advanceHealthMonitor(
      oversizedCatalog(12),
      null,
      options({
        abortSignal: controller.signal,
        persistProgress: async (value) => {
          saved = structuredClone(value);
          controller.abort(new Error("fixture cancellation"));
        },
        fetch: response(404),
      }),
    ),
    /fixture cancellation/,
  );
  const resumed = await advanceHealthMonitor(
    oversizedCatalog(12),
    saved,
    options({ now: () => epoch + 1000, fetch: response(404) }),
  );
  assert.equal(resumed.report.collection.consumed.requests, 13);
  const changed = await advanceHealthMonitor(
    oversizedCatalog(12),
    saved,
    options({ now: () => epoch + 1000, policySha256: "c".repeat(64), fetch: response(404) }),
  );
  assert.equal(changed.report.collection.consumed.requests, 14);
});

void test("actual provider headers preserve a rate-limit reserve without rejecting the accepted response", async () => {
  let calls = 0;
  const result = await advanceHealthMonitor(
    catalog(3),
    null,
    options({
      fetch: async (url) => {
        calls += 1;
        return new Response(
          JSON.stringify({
            id: 1,
            full_name: url.replace("https://api.github.com/repos/", ""),
            archived: false,
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "250",
              "x-ratelimit-reset": String((epoch + 3600000) / 1000),
            },
          },
        );
      },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(
    result.report.collection.observations.filter((record) => record.status === "reachable").length,
    1,
  );
  assert.equal(
    result.report.collection.observations.filter((record) => record.reason === "rate-limit").length,
    2,
  );
  assert.ok(
    result.report.collection.observations
      .filter((record) => record.reason === "rate-limit")
      .every((record) => record.retry_at === new Date(epoch + 3600000).toISOString()),
  );
});

void test("provider-wide reserve survives batch boundaries and restart without blocking unrelated providers", async () => {
  const input = catalog(322);
  for (const [index, port] of input.ports.entries())
    port.id = index === 321 ? "z-small" : `g-${String(index).padStart(4, "0")}`;
  input.ports[321]!.project_url = "https://gitlab.com/other/small";
  let githubCalls = 0;
  let gitlabCalls = 0;
  const resetAt = epoch + 3600000;
  const fetch: HealthFetch = async (url) => {
    if (url.startsWith("https://gitlab.com")) {
      gitlabCalls += 1;
      return new Response(
        JSON.stringify({ id: 2, path_with_namespace: "other/small", archived: false }),
        { headers: { "content-type": "application/json" } },
      );
    }
    githubCalls += 1;
    return new Response(
      JSON.stringify({
        id: 1,
        full_name: url.replace("https://api.github.com/repos/", ""),
        archived: false,
      }),
      {
        headers:
          githubCalls === 320
            ? {
                "content-type": "application/json",
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "250",
                "x-ratelimit-reset": String(resetAt / 1000),
              }
            : { "content-type": "application/json" },
      },
    );
  };
  const result = await drainHealthMonitor(input, null, {
    ...options({ fetch }),
    sessionDeadline: epoch + 120000,
  });
  assert.equal(githubCalls, 320);
  assert.equal(gitlabCalls, 1);
  assert.equal(result.report.inventory.fresh_complete_port_ids.length, 321);
  assert.equal(result.checkpoint!.provider_backoff!.github, new Date(resetAt).toISOString());
  const beforeReset = await advanceHealthMonitor(
    input,
    result.checkpoint,
    options({ fetch, now: () => epoch + 1000, continueDueOnly: true }),
  );
  assert.equal(githubCalls, 320);
  assert.equal(beforeReset.report.collection.consumed.requests, 0);
  const reset = await advanceHealthMonitor(
    input,
    beforeReset.checkpoint,
    options({ fetch, now: () => resetAt + 1, continueDueOnly: true }),
  );
  assert.equal(githubCalls, 321);
  assert.equal(reset.report.inventory.fresh_complete_port_ids.length, 322);
  const invalid = {
    ...result.checkpoint,
    provider_backoff: { "https://bad.example/path": "invalid" },
  };
  await assert.rejects(advanceHealthMonitor(input, invalid, options()), /provider backoff/);
});
