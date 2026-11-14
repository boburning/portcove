import type { HealthRequestOptions } from "./check-catalog-repositories.mts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  collectRepositoryHealth as collectRepositoryHealthWithPolicy,
  renderRepositoryHealth,
} from "./check-catalog-repositories.mts";
import { discoverUpstreamHealthScope, selectUpstreamHealthScope } from "./upstream-health-plan.mts";

import {
  reviewedAccounting,
  requiredFixture,
  healthScopePort,
  healthScopeCatalog,
  change,
  copy,
  collectRepositoryHealth,
  currentHealthCatalog,
  accountingFetch,
  capacityPort,
  capacityFetch,
  sourceArchiveFixture,
  sourceArchivePolicy,
} from "./fixtures/upstream-observation-fixtures.mts";
import type { HealthScopeFixture } from "./fixtures/upstream-observation-fixtures.mts";

void test("summary-only selection makes no requests and does not claim global health", async () => {
  const base = healthScopeCatalog(healthScopePort("game"), healthScopePort("unavailable"));
  const head = copy(base);
  requiredFixture(head.ports[0]).summary = "Shorter title description.";
  const scope = await selectUpstreamHealthScope(base, head, [change()]);
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.port_ids, []);
  const report = await collectRepositoryHealth(head, {
    portIds: scope.port_ids,
    fetch: () => assert.fail("Summary changes cannot request any upstream"),
  });
  assert.equal(report.outcome, "not-applicable");
  assert.equal(report.scope.global_health, "not assessed");
  assert.deepEqual(report.scope.unassessed_port_ids, ["game", "unavailable"]);
  assert.equal(report.coverage.monitored_ports, 0);
  assert.equal(report.coverage.attempted_repositories, 0);
});

void test("observed port inputs select affected obligations and retain collection failures", async () => {
  const base = healthScopeCatalog(healthScopePort("game"), healthScopePort("unavailable"));
  for (const update of [
    (p: HealthScopeFixture) => {
      p.release.repository = "owner/new-location";
    },
    (p: HealthScopeFixture) => {
      p.project_url = "https://github.com/owner/project-location";
    },
    (p: HealthScopeFixture) => {
      p.upstream_status = "retired";
    },
    (p: HealthScopeFixture) => {
      p.platforms.push("linux-x86-64");
    },
    (p: HealthScopeFixture) => {
      p.adapter = "psx-recomp-managed";
    },
  ]) {
    const head = copy(base);
    update(requiredFixture(head.ports[0]));
    const scope = await selectUpstreamHealthScope(base, head, [change()]);
    assert.equal(scope.mode, "affected");
    assert.deepEqual(scope.port_ids, ["game"]);
    const calls: string[] = [];
    const report = await collectRepositoryHealth(head, {
      portIds: scope.port_ids,
      fetch: async (url) => {
        calls.push(url);
        return new Response(null, { status: 503 });
      },
    });
    assert.equal(report.outcome, "incomplete");
    assert.equal(requiredFixture(report.observations[0]).reason, "provider-error");
    assert.ok(calls.every((url: string) => !url.endsWith("/unavailable")));
    assert.deepEqual(report.scope.unassessed_port_ids, ["unavailable"]);
    assert.deepEqual(
      scope.retcomm_port_ids,
      requiredFixture(head.ports[0]).adapter === "psx-recomp-managed" ? ["game"] : [],
    );
  }
});

void test("shared endpoints retain unselected maintenance and identity obligations", async () => {
  const input = healthScopeCatalog(
    {
      ...healthScopePort("retired", "owner/shared"),
      upstream_status: "retired",
      project_url: "https://github.com/owner/shared",
    },
    {
      ...healthScopePort("active", "owner/shared"),
      project_url: "https://github.com/owner/shared",
    },
  );
  const report = await collectRepositoryHealth(input, {
    portIds: ["retired"],
    fetch: async () => new Response(null, { status: 404 }),
  });
  assert.equal(report.coverage.repositories, 1);
  assert.deepEqual(requiredFixture(report.observations[0]).port_ids, ["retired", "active"]);
  assert.equal(requiredFixture(report.observations[0]).accounted_for, false);
  assert.equal(report.outcome, "incomplete");
});

void test("additions and history select their port; removals and schema changes retain full scope", async () => {
  const base = healthScopeCatalog(healthScopePort("old"));
  const head = healthScopeCatalog(healthScopePort("old"), healthScopePort("new"));
  assert.deepEqual((await selectUpstreamHealthScope(base, head, [change()])).port_ids, ["new"]);
  assert.equal((await selectUpstreamHealthScope(head, base, [change()])).mode, "full");
  const changedSchema = copy(base);
  changedSchema.schema_version++;
  assert.equal((await selectUpstreamHealthScope(base, changedSchema, [change()])).mode, "full");
  const changedHistory = copy(base);
  changedHistory.source_catalog = {
    qualification: [
      { scope: { port_id: "old", artifact_sha256: "a".repeat(64), upstream_ref: "v1" } },
    ],
  };
  assert.deepEqual((await selectUpstreamHealthScope(base, changedHistory, [change()])).port_ids, [
    "old",
  ]);
});

void test("shared tools and uncertain inventory retain full monitoring; unrelated files do not widen", async () => {
  const input = healthScopeCatalog(healthScopePort("old"));
  for (const changes of [
    [change("scripts/check-catalog-repositories.mts")],
    [change("scripts/upstream-health-plan.mts")],
    [change(".github/workflows/upstream-health.yml")],
    [change(".github/upstream-health-accounting.json")],
    [change(undefined, { newMode: "120000" })],
    [change(undefined, { status: "R" })],
  ])
    assert.equal((await selectUpstreamHealthScope(input, input, changes)).mode, "full");
  for (const changes of [[], [change("AGENTS.md")], [change(), change("README.md")]])
    assert.equal((await selectUpstreamHealthScope(input, input, changes)).mode, "none");
  await assert.rejects(
    selectUpstreamHealthScope(
      { ports: [healthScopePort("duplicate"), healthScopePort("duplicate")] },
      input,
      [change()],
    ),
    /unique stable/,
  );
  await assert.rejects(
    collectRepositoryHealth(input, { portIds: ["missing"] }),
    /existing port IDs/,
  );
  await assert.rejects(
    collectRepositoryHealth(input, { portIds: ["old", "old"] }),
    /unique existing/,
  );
});

void test("Git discovery refuses malformed or unavailable commit identities", async () => {
  const baseSha = "a".repeat(40),
    headSha = "b".repeat(40),
    checkoutSha = "c".repeat(40);
  const head = healthScopeCatalog(healthScopePort("old"));
  const context = { event: "pull_request", baseSha, headSha, checkoutSha };
  await assert.rejects(
    discoverUpstreamHealthScope(
      { ...context, baseSha: "main" },
      () => assert.fail("Malformed Git identity must fail before Git execution"),
      () => JSON.stringify(head),
    ),
    /exact base/,
  );
  await assert.rejects(
    discoverUpstreamHealthScope(
      context,
      () => {
        throw new Error("missing ref");
      },
      () => JSON.stringify(head),
    ),
    /missing ref/,
  );
});

void test("validated forecasts bound full collections, and the batch ceiling never refuses one", async () => {
  for (const count of [351, 352, 353]) {
    const catalog = {
      ports: Array.from({ length: count }, (_, i) => capacityPort(`boundary-${i}`)),
    };
    const calls: { url: string; options: HealthRequestOptions }[] = [];
    const report = await collectRepositoryHealth(catalog, {
      fetch: capacityFetch(calls),
      now: () => 0,
    });
    assert.equal(report.request_plan.conservative_requests, count);
    assert.equal(report.request_plan.hard_ceiling, 352);
    // 352 sizes incremental batches only; a full collection is bounded by its forecast.
    assert.equal(report.request_plan.status, "admitted");
    assert.equal(report.limits.requests, count);
    assert.equal(calls.length, count);
    assert.equal(report.consumed.requests, calls.length);
    assert.equal(report.observations.length, count);
    assert.equal(report.port_health.length, count);
    assert.equal(report.coverage.repositories, count);
    assert.equal(report.scope.mode, "full");
    assert.equal(report.outcome, "complete");
    assert.match(renderRepositoryHealth(report), /scheduled batch ceiling 352; admitted\./);
    const none = await collectRepositoryHealth(catalog, {
      portIds: [],
      fetch: () => assert.fail("Empty scope must not fetch"),
    });
    assert.equal(none.limits.requests, 0);
    assert.equal(none.request_plan.conservative_requests, 0);
    assert.equal(none.outcome, "not-applicable");
    assert.equal(none.scope.unassessed_port_ids.length, count);
    const affected = await collectRepositoryHealth(catalog, {
      portIds: [requiredFixture(catalog.ports[0]).id],
      fetch: capacityFetch([]),
    });
    assert.equal(affected.limits.requests, 1);
    assert.equal(affected.scope.global_health, "not assessed");
    assert.equal(affected.scope.unassessed_port_ids.length, count - 1);
  }
});

void test("incremental operations still stop at the 352-request batch ceiling", async () => {
  const catalog = {
    ports: Array.from({ length: 353 }, (_, i) => capacityPort(`batch-${i}`)),
  };
  const calls: { url: string; options: HealthRequestOptions }[] = [];
  const report = await collectRepositoryHealth(catalog, {
    fetch: capacityFetch(calls),
    now: () => 0,
    incremental: true,
  });
  assert.equal(report.request_plan.conservative_requests, 353);
  assert.equal(report.limits.requests, 352);
  assert.equal(calls.length, 352);
  assert.equal(report.consumed.requests, 352);
  assert.equal(report.observations.filter((r) => r.attempted).length, 352);
  assert.equal(report.observations.filter((r) => r.reason === "budget").length, 1);
});

void test("inventory size never refuses a full collection", async () => {
  for (const count of [512, 513]) {
    const catalog = {
      ports: Array.from({ length: count }, (_, i) => capacityPort(`records-${i}`)),
    };
    const calls: { url: string; options: HealthRequestOptions }[] = [];
    const report = await collectRepositoryHealth(catalog, {
      fetch: capacityFetch(calls),
      now: () => 0,
    });
    assert.equal(report.request_plan.observation_records, count);
    // "overflow" only tells the scheduled planner that one batch is not enough.
    assert.equal(report.request_plan.status, count > 512 ? "overflow" : "admitted");
    assert.equal(report.limits.requests, count);
    assert.equal(calls.length, count);
    assert.equal(report.outcome, "complete");
    assert.equal(report.scope.global_health, "collection attempted; not an installability claim");
    assert.match(
      renderRepositoryHealth(report),
      count > 512 ? /more locations than one scheduled batch\./ : /; admitted\./,
    );
    assert.doesNotMatch(renderRepositoryHealth(report), /Preflight overflow/);
  }
});

void test("static missing-release and conflicting-identity classifications need no request", async () => {
  const direct = (id: string, conflict = false) => ({
    id,
    release: {
      provider: "direct-manifest",
      direct: {
        windows: {
          url: `https://example.invalid/${id}.zip`,
          sha256: "1".repeat(64),
          size: 10,
          version: "v1",
        },
        ...(conflict
          ? {
              linux: {
                url: `https://example.invalid/${id}.zip`,
                sha256: "2".repeat(64),
                size: 10,
                version: "v1",
              },
            }
          : {}),
      },
    },
  });
  const catalog = {
    ports: [
      ...Array.from({ length: 2 }, (_, i) => capacityPort(`mixed-${i}`)),
      direct("unlocated"),
      direct("conflicting", true),
    ],
    source_catalog: {
      qualification: [
        {
          scope: {
            port_id: "unlocated",
            upstream_ref: "historical-v0",
            artifact_sha256: "3".repeat(64),
          },
        },
      ],
    },
  };
  const calls: { url: string; options: HealthRequestOptions }[] = [];
  const report = await collectRepositoryHealth(catalog, {
    fetch: capacityFetch(calls),
    now: () => 0,
  });
  assert.equal(report.observations.length, 5);
  assert.equal(report.coverage.monitored_ports, 4);
  // The two repositories and the current direct download are requested; the
  // historical and conflicting records are classified without a request.
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://api.github.com/repos/fixture/mixed-0",
      "https://api.github.com/repos/fixture/mixed-1",
      "https://example.invalid/unlocated.zip",
    ],
  );
  assert.equal(
    requiredFixture(report.observations.find((r) => r.provider === "unlocated-historical")).reason,
    "release-identity-unavailable",
  );
  assert.equal(
    requiredFixture(report.observations.find((r) => r.repository.endsWith("conflicting.zip")))
      .reason,
    "identity-mismatch",
  );
  assert.ok(
    report.observations
      .filter(
        (r) => r.provider === "unlocated-historical" || r.repository.endsWith("conflicting.zip"),
      )
      .every((r) => !r.attempted && !r.accounted_for),
  );
});

void test("malformed inventories refuse before requests and historical byte bounds are independent of collection counts", async () => {
  const catalog = { ports: [capacityPort("history-bound")] };
  for (const bad of [
    null,
    { ports: null },
    { ports: [capacityPort("duplicate"), capacityPort("duplicate")] },
    {
      ports: [{ ...capacityPort("bad"), release: { provider: "github", repository: "../escape" } }],
    },
  ]) {
    await assert.rejects(
      collectRepositoryHealth(bad, {
        fetch: () => assert.fail("Malformed inventory must not fetch"),
      }),
    );
  }
  const fetch404 = async () => new Response(null, { status: 404 });
  const first = await collectRepositoryHealth(catalog, { fetch: fetch404 });
  assert.equal(first.limits.requests, 1);
  assert.equal(requiredFixture(first.port_health[0]).canonical_incidents.length, 1);
  await assert.rejects(
    collectRepositoryHealth(catalog, {
      previousReport: { ...first, extra: "x".repeat(16 * 1024 * 1024) },
      fetch: () => assert.fail("Oversized history must refuse before requests"),
    }),
    /Invalid historical health comparison/,
  );
  for (const count of [512, 513]) {
    for (const field of ["observations", "incidents"]) {
      const prior = structuredClone(first);
      if (field === "observations")
        prior.observations = Array.from({ length: count }, () =>
          structuredClone(requiredFixture(first.observations[0])),
        );
      else
        requiredFixture(prior.port_health[0]).canonical_incidents = Array.from(
          { length: count },
          () =>
            structuredClone(
              requiredFixture(requiredFixture(first.port_health[0]).canonical_incidents[0]),
            ),
        );
      const report = await collectRepositoryHealth(catalog, {
        previousReport: prior,
        fetch: fetch404,
      });
      assert.equal(report.previous_report, "matching observation history", field);
      assert.equal(requiredFixture(report.observations[0]).reason, "inaccessible-or-missing");
      assert.equal(report.outcome, "incomplete");
    }
  }
});

void test("reuse opportunities require the pin read to precede a shared hosted sibling", async () => {
  const pin = requiredFixture(reviewedAccounting.pins[0]);
  const pinnedPort = requiredFixture(
    currentHealthCatalog.ports.find((port) => port.id === pin.port_id),
  );
  const sibling = {
    id: "shared-hosted-sibling",
    release: { provider: "github", repository: pin.repository },
  };
  for (const pinFirst of [true, false]) {
    const calls: { url: string; options: HealthRequestOptions }[] = [];
    const report = await collectRepositoryHealth(
      { ports: pinFirst ? [pinnedPort, sibling] : [sibling, pinnedPort] },
      { fetch: accountingFetch(calls) },
    );
    assert.equal(report.outcome, "complete");
    assert.equal(report.request_plan.conditional_repository_reuses, pinFirst ? 1 : 0);
    assert.equal(report.coverage.reused_repositories, pinFirst ? 1 : 0);
    assert.equal(report.limits.requests, 5);
    assert.equal(report.consumed.requests, pinFirst ? 4 : 5);
  }
});

void test("source archive conditional reads participate in the full collection forecast", async () => {
  const fixture = sourceArchiveFixture();
  const archiveCalls: { url: string; options: HealthRequestOptions }[] = [];
  const report = await collectRepositoryHealthWithPolicy(
    {
      ports: [
        fixture.port,
        ...Array.from({ length: 349 }, (_, i) => capacityPort(`archive-capacity-${i}`)),
      ],
    },
    {
      reviewedAccounting: sourceArchivePolicy(fixture),
      now: () => 0,
      fetch: capacityFetch(archiveCalls),
    },
  );
  assert.equal(report.request_plan.conservative_requests, 353);
  assert.equal(report.request_plan.conditional_archive_requests, 2);
  assert.equal(report.request_plan.status, "admitted");
  // The archive reads raise the full collection's own bound past the batch ceiling.
  assert.equal(report.limits.requests, 353);
  // Conditional reads count against the bound but are spent only when needed.
  assert.equal(report.consumed.requests, archiveCalls.length);
  assert.ok(archiveCalls.length <= 353);
  assert.equal(report.observations.length, 351);
});
