import type { HealthRequestOptions } from "./check-catalog-repositories.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { renderRepositoryHealth } from "./check-catalog-repositories.mts";

import {
  requiredFixture,
  healthPin,
  healthCatalog,
  healthTime,
  healthFetch,
  collectRepositoryHealth,
} from "./fixtures/upstream-observation-fixtures.mts";

void test("direct provider preserves original upstream and scopes HEAD separately from exact accepted bytes", async () => {
  const calls: { url: string; options: HealthRequestOptions }[] = [];
  const report = await collectRepositoryHealth(healthCatalog(), {
    now: () => healthTime,
    githubToken: "private-token",
    gitlabToken: "private-gitlab",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === healthPin.url) {
        assert.equal(options.method, "HEAD");
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers["PRIVATE-TOKEN"], undefined);
        assert.equal(options.redirect, "manual");
      }
      return healthFetch(url, options);
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(report.coverage.monitored_ports, 1);
  assert.equal(report.outcome, "complete");
  const health = requiredFixture(report.port_health[0]);
  assert.equal(health.original_upstream.status, "reachable");
  assert.equal(health.lineage.status, "not-assessed");
  assert.equal(health.lineage.successor_selected, null);
  assert.equal(health.accepted_artifact_obtainability.status, "unknown");
  assert.equal(
    requiredFixture(health.accepted_artifact_obtainability.identities[0]).sha256,
    healthPin.sha256,
  );
  assert.equal(health.preservation.status, "unknown");
  assert.equal(health.applicable_holds.status, "unknown");
  assert.equal(
    requiredFixture(health.qualification.records[0]).scope.artifact_sha256,
    "b".repeat(64),
  );
  assert.equal(health.qualification.inherited, false);
  assert.match(renderRepositoryHealth(report), /direct-manifest ports included/);
  assert.match(renderRepositoryHealth(report), /Accepted bytes remain unverified/);
  assert.doesNotMatch(JSON.stringify(report), /private-token|private-gitlab/);
});

void test("direct endpoint corruption, unavailable headers and redirects remain unknown rather than verified artifacts", async () => {
  for (const headers of [{}, { "content-length": "41" }, { "content-length": "42junk" }]) {
    const report = await collectRepositoryHealth(healthCatalog(), {
      now: () => healthTime,
      fetch: async (url, options) =>
        url === healthPin.url ? new Response(null, { headers }) : healthFetch(url, options),
    });
    assert.equal(report.outcome, "incomplete");
    assert.equal(requiredFixture(report.observations[0]).reason, "invalid-metadata");
    assert.equal(
      requiredFixture(report.port_health[0]).accepted_artifact_obtainability.status,
      "unknown",
    );
  }
  const report = await collectRepositoryHealth(healthCatalog(), {
    now: () => healthTime,
    fetch: async (url, options) =>
      url === healthPin.url ? new Response(null, { status: 302 }) : healthFetch(url, options),
  });
  assert.equal(requiredFixture(report.observations[0]).reason, "provider-redirect");
});

void test("redirects remain distinct unknown HTTP facts without following or retaining their destinations", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls: { url: string; options: HealthRequestOptions }[] = [];
    let cancelled = 0;
    const secret = "private-signed-location-and-response";
    const report = await collectRepositoryHealth(healthCatalog(), {
      now: () => healthTime,
      githubToken: "private-token",
      fetch: async (url, options) => {
        calls.push({ url, options });
        assert.equal(options.redirect, "manual");
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(secret));
          },
          cancel() {
            cancelled++;
          },
        });
        return new Response(body, {
          status,
          headers: { location: `https://untrusted.example/asset?token=${secret}` },
        });
      },
    });
    assert.equal(calls.length, 3);
    assert.equal(cancelled, 3);
    assert.ok(calls.every(({ url }) => !url.startsWith("https://untrusted.example/")));
    const direct = requiredFixture(calls.find(({ url }) => url === healthPin.url));
    assert.equal(direct.options.method, "HEAD");
    assert.equal(direct.options.headers.Authorization, undefined);
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.degradation, true);
    assert.equal(report.coverage.reachable_repositories, 0);
    for (const observation of report.observations) {
      assert.equal(observation.status, "unknown");
      assert.equal(observation.reason, "provider-redirect");
      assert.equal(observation.http_status, status);
      assert.equal(observation.accounted_for, false);
      assert.match(requiredFixture(observation.resume_condition), /no redirect was followed/);
    }
    assert.ok(
      requiredFixture(report.port_health[0]).canonical_incidents.every(
        (incident) => incident.rule === "provider-redirect" && !incident.accounted_for,
      ),
    );
    assert.match(renderRepositoryHealth(report), new RegExp(`provider-redirect; HTTP ${status}`));
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.ok(!JSON.stringify(report).includes("private-token"));
  }
});

void test("transport failures and nonredirect provider statuses do not become redirect observations", async () => {
  const input = { ports: [{ id: "original", release: { repository: "owner/original" } }] };
  for (const [status, reason] of [
    [404, "inaccessible-or-missing"],
    [503, "provider-error"],
    [304, "provider-status"],
  ] as const) {
    const report = await collectRepositoryHealth(input, {
      fetch: async () => new Response(null, { status }),
    });
    assert.equal(report.outcome, "incomplete");
    assert.equal(requiredFixture(report.observations[0]).reason, reason);
    assert.equal(requiredFixture(report.observations[0]).http_status, status);
  }
  const transport = await collectRepositoryHealth(input, {
    fetch: async () => {
      throw new Error("private-network-details");
    },
  });
  assert.equal(transport.outcome, "incomplete");
  assert.equal(requiredFixture(transport.observations[0]).reason, "transport");
  assert.equal(requiredFixture(transport.observations[0]).http_status, null);
  assert.ok(!JSON.stringify(transport).includes("private-network-details"));
});

void test("partial direct inventory never becomes an empty or healthy collection", async () => {
  for (const bad of [
    { ...healthPin, sha256: "bad" },
    { ...healthPin, url: "https://127.0.0.1/secret" },
    { ...healthPin, url: "https://user:password@example.com/pkg" },
  ]) {
    let calls = 0;
    await assert.rejects(
      collectRepositoryHealth(healthCatalog(bad), {
        fetch: async () => {
          calls++;
          return new Response();
        },
      }),
      /safe exact artifact identity/,
    );
    assert.equal(calls, 0);
  }
});

void test("incident identity is stable across observation times while changed rules create distinct conditions", async () => {
  const collect = (time: number, status: number) =>
    collectRepositoryHealth(healthCatalog(), {
      now: () => time,
      fetch: async (url, options) =>
        url === healthPin.url ? new Response(null, { status }) : healthFetch(url, options),
    });
  const first = await collect(healthTime, 404);
  const repeated = await collect(healthTime + 60_000, 404);
  const changed = await collect(healthTime + 60_000, 401);
  const incident = (report: Awaited<ReturnType<typeof collectRepositoryHealth>>) =>
    requiredFixture(requiredFixture(report.port_health[0]).canonical_incidents[0]);
  assert.equal(incident(first).key, incident(repeated).key);
  assert.notEqual(incident(first).observed_at, incident(repeated).observed_at);
  assert.notEqual(incident(first).key, incident(changed).key);
  assert.match(
    requiredFixture(incident(first).resume_condition),
    /404 does not establish deletion or succession/,
  );
  assert.equal(requiredFixture(first.port_health[0]).lineage.successor_selected, null);
});

void test("non-hosted original project remains monitored after a provider change", async () => {
  const input = healthCatalog();
  requiredFixture(input.ports[0]).project_url = "https://original.example.com/";
  const calls: string[] = [];
  const report = await collectRepositoryHealth(input, {
    now: () => healthTime,
    githubToken: "private-token",
    gitlabToken: "private-token",
    fetch: async (url, options) => {
      calls.push(url);
      assert.equal(options.method, "HEAD");
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers["PRIVATE-TOKEN"], undefined);
      return url === healthPin.url ? healthFetch(url, options) : new Response(null);
    },
  });
  assert.deepEqual(calls, [healthPin.url, "https://original.example.com/"]);
  assert.equal(requiredFixture(report.port_health[0]).original_upstream.status, "reachable");
  assert.equal(requiredFixture(report.port_health[0]).lineage.status, "not-assessed");
});

void test("rate limits defer only the affected direct origin and preserve other acquisition locations", async () => {
  const input = healthCatalog();
  requiredFixture(requiredFixture(input.ports[0]).release.direct).linux = {
    ...healthPin,
    url: "https://downloads.example.com/linux.zip",
  };
  requiredFixture(requiredFixture(input.ports[0]).release.direct).macos = {
    ...healthPin,
    url: "https://other.example.com/package.zip",
  };
  const calls: string[] = [];
  const report = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: async (url: string, options) => {
      calls.push(url);
      if (url === healthPin.url)
        return new Response(null, { status: 429, headers: { "retry-after": "120" } });
      if (url.startsWith("https://other.example.com/"))
        return new Response(null, { headers: { "content-length": "42" } });
      return healthFetch(url, options);
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(requiredFixture(report.observations[1]).attempted, false);
  assert.equal(
    requiredFixture(report.observations[1]).retry_at,
    new Date(healthTime + 120_000).toISOString(),
  );
  assert.equal(requiredFixture(report.observations[2]).status, "reachable");
  assert.equal(
    requiredFixture(report.port_health[0]).accepted_artifact_obtainability.locations.length,
    5,
  );
});

void test("contradictory immutable pins at one location stay prominent without selecting an authority", async () => {
  const input = healthCatalog();
  requiredFixture(requiredFixture(input.ports[0]).release.direct).linux = {
    ...healthPin,
    sha256: "c".repeat(64),
  };
  const report = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: healthFetch,
  });
  assert.equal(requiredFixture(report.observations[0]).reason, "identity-mismatch");
  assert.equal(requiredFixture(report.observations[0]).attempted, false);
  assert.equal(report.outcome, "incomplete");
  assert.equal(
    requiredFixture(report.port_health[0]).accepted_artifact_obtainability.identities.length,
    2,
  );
  assert.equal(requiredFixture(report.port_health[0]).applicable_holds.status, "unknown");
});

void test("retained Star Fox failure is an unresolved availability condition with no historical qualification transfer", async () => {
  // Exact failure text and immutable run identity retained in #247's early slice.
  // HTTP fixture reconstructs that recorded failure; it is not a new live probe.
  const incident = {
    run: "36735216087",
    job: "109955016518",
    head: "5d6905ea8bf90fb887bb49a6a8524ab2ecc5846b",
    stderr: "kandowontu/starfox-enhanced: github returned 404",
    port_issue: 124,
    lineage_issue: 139,
  };
  const repository = requiredFixture(incident.stderr.split(": ")[0]);
  const report = await collectRepositoryHealth(
    {
      ports: [{ id: "star-fox-enhanced", release: { repository } }],
    },
    { now: () => healthTime, fetch: async () => new Response(null, { status: 404 }) },
  );
  const health = requiredFixture(report.port_health[0]);
  assert.equal(report.outcome, "incomplete");
  assert.equal(health.original_upstream.status, "unknown");
  assert.equal(requiredFixture(health.canonical_incidents[0]).http_status, 404);
  assert.equal(requiredFixture(health.canonical_incidents[0]).rule, "inaccessible-or-missing");
  assert.equal(health.lineage.owner_issue, incident.lineage_issue);
  assert.equal(health.lineage.status, "not-assessed");
  assert.equal(health.lineage.successor_selected, null);
  assert.deepEqual(health.qualification.records, []);
  assert.equal(health.qualification.inherited, false);
});

void test("hosted relocation keeps original upstream distinct from the current acquisition repository", async () => {
  const input = {
    ports: [
      {
        id: "relocated",
        project_url: "https://github.com/original/project",
        release: { repository: "successor/project" },
      },
    ],
  };
  const calls: string[] = [];
  const report = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: async (url: string) => {
      calls.push(url);
      if (url.endsWith("original/project")) return new Response(null, { status: 404 });
      return new Response(
        JSON.stringify({ id: 2, full_name: "successor/project", archived: false }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.deepEqual(calls, [
    "https://api.github.com/repos/successor/project",
    "https://api.github.com/repos/original/project",
  ]);
  assert.equal(requiredFixture(report.port_health[0]).original_upstream.status, "unknown");
  assert.equal(
    requiredFixture(requiredFixture(report.port_health[0]).original_upstream.locations[0])
      .repository,
    "original/project",
  );
  assert.equal(requiredFixture(report.port_health[0]).lineage.successor_selected, null);
});

void test("shared acquisition request retains each port's exact artifact scope", async () => {
  const input = healthCatalog();
  input.ports.push({ ...structuredClone(requiredFixture(input.ports[0])), id: "other-port" });
  const report = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: healthFetch,
  });
  assert.equal(report.consumed.requests, 3);
  for (const port of report.port_health) {
    assert.deepEqual(
      port.accepted_artifact_obtainability.identities.map((identity) => identity.port_id),
      [port.port_id],
    );
  }
});

void test("reviewed catalog maintenance accounts for a known original outage without acquiring successor authority", async () => {
  const input = healthCatalog();
  input.source_catalog.qualification = [];
  requiredFixture(input.ports[0]).upstream_status = "retired";
  const options = {
    now: () => healthTime,
    fetch: async (url: string, opts: HealthRequestOptions) =>
      url.includes("api.github.com") ? new Response(null, { status: 404 }) : healthFetch(url, opts),
  };
  const known = await collectRepositoryHealth(input, options);
  assert.equal(known.outcome, "complete");
  assert.equal(known.degradation, true);
  assert.equal(
    requiredFixture(known.observations[1]).classification,
    "catalog-declared-unavailable-original",
  );
  assert.equal(
    requiredFixture(known.port_health[0]).accepted_artifact_obtainability.status,
    "unknown",
  );
  assert.equal(requiredFixture(known.port_health[0]).preservation.status, "unknown");
  assert.equal(requiredFixture(known.port_health[0]).applicable_holds.status, "unknown");
  assert.equal(requiredFixture(known.port_health[0]).lineage.successor_selected, null);
  delete requiredFixture(input.ports[0]).upstream_status;
  assert.equal((await collectRepositoryHealth(input, options)).outcome, "incomplete");
  requiredFixture(input.ports[0]).upstream_status = "retired";
  const artifactMissing = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: async () => new Response(null, { status: 404 }),
  });
  assert.equal(artifactMissing.outcome, "incomplete");
  assert.equal(requiredFixture(artifactMissing.observations[0]).accounted_for, false);
});

void test("observation history deduplicates aged conditions and exposes recovery without whole-catalog coupling", async () => {
  const input = { ports: [{ id: "tracked", release: { repository: "owner/tracked" } }] };
  const collect = (time: number, previousReport: unknown, status: number) =>
    collectRepositoryHealth(input, {
      now: () => time,
      previousReport,
      fetch: async () =>
        status === 200
          ? new Response(JSON.stringify({ id: 1, full_name: "owner/tracked", archived: false }), {
              headers: { "content-type": "application/json" },
            })
          : new Response(null, { status }),
    });
  const first = await collect(healthTime, null, 404);
  const repeated = await collect(healthTime + 1000, first, 404);
  assert.equal(repeated.material_changes.length, 0);
  assert.equal(
    requiredFixture(requiredFixture(repeated.port_health[0]).canonical_incidents[0]).occurrences,
    2,
  );
  assert.equal(
    requiredFixture(requiredFixture(repeated.port_health[0]).canonical_incidents[0]).first_seen,
    requiredFixture(requiredFixture(first.port_health[0]).canonical_incidents[0]).first_seen,
  );
  const recovered = await collect(healthTime + 2000, repeated, 200);
  assert.deepEqual(recovered.resolved_incidents, [
    requiredFixture(requiredFixture(first.port_health[0]).canonical_incidents[0]).key,
  ]);
  const stale = await collect(healthTime + 25 * 3600_000, first, 404);
  assert.equal(stale.previous_report, "matching observation history");
  assert.equal(stale.material_changes.length, 0);
  assert.equal(
    requiredFixture(requiredFixture(stale.port_health[0]).canonical_incidents[0]).occurrences,
    2,
  );
  const altered = structuredClone(first);
  altered.catalog_sha256 = "f".repeat(64);
  assert.equal((await collect(healthTime + 1000, altered, 404)).material_changes.length, 0);
  altered.completed_at = new Date(healthTime + 2000).toISOString();
  await assert.rejects(
    collect(healthTime + 1000, altered, 404),
    /Invalid historical health comparison/,
  );
});

void test("repository-name reuse is a changed unknown condition, never continuity or inherited qualification", async () => {
  const input = {
    ports: [
      {
        id: "tracked",
        project_url: "https://github.com/owner/tracked",
        release: { repository: "owner/tracked" },
      },
    ],
  };
  const collect = (id: number, previousReport: unknown = null) =>
    collectRepositoryHealth(input, {
      now: () => healthTime,
      previousReport,
      fetch: async () =>
        new Response(JSON.stringify({ id, full_name: "owner/tracked", archived: false }), {
          headers: { "content-type": "application/json" },
        }),
    });
  const prior = await collect(1);
  const replaced = await collect(2, prior);
  assert.equal(requiredFixture(replaced.observations[0]).reason, "identity-mismatch");
  assert.equal(replaced.outcome, "incomplete");
  assert.equal(requiredFixture(replaced.port_health[0]).lineage.status, "not-assessed");
  assert.equal(requiredFixture(replaced.port_health[0]).qualification.inherited, false);
});

void test("historical release digests are observed at exact tags and partial or conflicting asset pages remain unknown", async () => {
  const input = healthCatalog();
  const paths: string[] = [];
  const complete = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: async (url, options) => {
      paths.push(url);
      return healthFetch(url, options);
    },
  });
  assert.ok(paths.includes("https://api.github.com/repos/original/project/releases/tags/v0"));
  assert.equal(
    requiredFixture(complete.port_health[0]).accepted_artifact_obtainability.status,
    "unknown",
  );
  for (const assets of [
    [],
    [{ digest: `sha256:${"c".repeat(64)}` }],
    Array(100).fill({ digest: `sha256:${"b".repeat(64)}` }),
  ]) {
    const report = await collectRepositoryHealth(input, {
      now: () => healthTime,
      fetch: async (url, options) =>
        url.includes("/releases/tags/")
          ? new Response(JSON.stringify({ id: 3, tag_name: "v0", assets }), {
              headers: { "content-type": "application/json" },
            })
          : healthFetch(url, options),
    });
    assert.equal(report.outcome, "incomplete");
    assert.equal(requiredFixture(report.observations.at(-1)).status, "unknown");
    assert.equal(
      requiredFixture(requiredFixture(report.port_health[0]).qualification.records[0]).scope
        .artifact_sha256,
      "b".repeat(64),
    );
  }
});

void test("prior provider backoff is honored without using a previous failure as healthy evidence", async () => {
  const input = { ports: [{ id: "tracked", release: { repository: "owner/tracked" } }] };
  const first = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: async () => new Response(null, { status: 429, headers: { "retry-after": "120" } }),
  });
  const deferred = await collectRepositoryHealth(input, {
    now: () => healthTime + 1000,
    previousReport: first,
    fetch: async () => assert.fail("backoff must not request"),
  });
  assert.equal(requiredFixture(deferred.observations[0]).attempted, false);
  assert.equal(requiredFixture(deferred.observations[0]).reason, "rate-limit");
  assert.equal(deferred.outcome, "incomplete");
});

void test("known artifact, authority and distribution failures retain exact reported scope without creating or clearing holds", async () => {
  for (const rule of ["artifact-integrity", "publisher-authority", "distribution-authority"]) {
    const input = healthCatalog();
    requiredFixture(input.source_catalog.qualification[0]).outcome = "failed";
    requiredFixture(input.source_catalog.qualification[0]).method = rule;
    input.ports.push({
      id: "unaffected",
      project_url: "https://github.com/original/project",
      release: { repository: "original/project" },
    });
    const report = await collectRepositoryHealth(input, {
      now: () => healthTime,
      fetch: healthFetch,
    });
    assert.equal(
      requiredFixture(requiredFixture(report.port_health[0]).applicable_holds.reported_failures[0])
        .method,
      rule,
    );
    assert.equal(
      requiredFixture(requiredFixture(report.port_health[0]).applicable_holds.reported_failures[0])
        .scope.artifact_sha256,
      "b".repeat(64),
    );
    assert.equal(requiredFixture(report.port_health[0]).applicable_holds.status, "unknown");
    assert.deepEqual(requiredFixture(report.port_health[1]).applicable_holds.reported_failures, []);
    assert.equal(requiredFixture(report.port_health[1]).qualification.inherited, false);
  }
});

void test("repository identity baseline survives replacement, outage and aged snapshots", async () => {
  const input = { ports: [{ id: "tracked", release: { repository: "owner/tracked" } }] };
  const collect = (id: number | null, previousReport: unknown = null, time = healthTime) =>
    collectRepositoryHealth(input, {
      now: () => time,
      previousReport,
      fetch: async () =>
        id === null
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify({ id, full_name: "owner/tracked", archived: false }), {
              headers: { "content-type": "application/json" },
            }),
    });
  const original = await collect(1);
  for (const intervening of [await collect(2, original), await collect(null, original), original]) {
    const report = await collect(2, intervening, healthTime + 25 * 3600_000);
    assert.equal(requiredFixture(report.observations[0]).baseline_repository_id, 1);
    assert.equal(requiredFixture(report.observations[0]).observed_repository_id, 2);
    assert.equal(requiredFixture(report.observations[0]).reason, "identity-mismatch");
    assert.equal(report.outcome, "incomplete");
    assert.deepEqual(report.resolved_incidents, []);
  }
  const replacement = await collect(2, original);
  const repeated = await collect(2, replacement);
  assert.equal(requiredFixture(repeated.observations[0]).reason, "identity-mismatch");
  assert.equal(repeated.material_changes.length, 0);
});

void test("changed material retains condition history and provider-specific recovery", async () => {
  const input = {
    ports: [
      {
        id: "tracked",
        project_url: "https://github.com/owner/tracked",
        release: { provider: "gitlab", repository: "owner/tracked" },
      },
    ],
  };
  const collect = (status: number, previousReport: unknown, time: number) =>
    collectRepositoryHealth(input, {
      now: () => time,
      previousReport,
      fetch: async (url) =>
        url.includes("api.github.com")
          ? new Response(null, { status })
          : new Response(
              JSON.stringify({ id: 2, path_with_namespace: "owner/tracked", archived: false }),
              {
                headers: { "content-type": "application/json" },
              },
            ),
    });
  const first = await collect(503, null, healthTime);
  const changed = await collect(502, first, healthTime + 1000);
  const before = requiredFixture(requiredFixture(first.port_health[0]).canonical_incidents[0]);
  const after = requiredFixture(requiredFixture(changed.port_health[0]).canonical_incidents[0]);
  assert.equal(after.first_seen, before.first_seen);
  assert.equal(after.occurrences, 2);
  assert.equal(after.notify, true);
  assert.equal(after.provider, "github");
  assert.deepEqual(changed.resolved_incidents, []);
  const missing = await collect(404, null, healthTime);
  const repeated = await collect(404, missing, healthTime + 1000);
  assert.deepEqual(repeated.resolved_incidents, []);
  assert.equal(repeated.material_changes.length, 0);
});

void test("rate-limit fallback defers repeated runs while preserving comparison and incident history", async () => {
  const input = { ports: [{ id: "tracked", release: { repository: "owner/tracked" } }] };
  for (const headers of [{}, { "retry-after": "120" }]) {
    const first = await collectRepositoryHealth(input, {
      now: () => healthTime,
      fetch: async () => new Response(null, { status: 429, headers }),
    });
    let prior = first;
    for (const elapsed of [1000, 2000]) {
      const report = await collectRepositoryHealth(input, {
        now: () => healthTime + elapsed,
        previousReport: prior,
        fetch: async () => assert.fail("backoff must not request"),
      });
      assert.equal(requiredFixture(report.observations[0]).attempted, false);
      assert.equal(requiredFixture(report.observations[0]).http_status, null);
      assert.equal(requiredFixture(report.observations[0]).comparison_http_status, 429);
      assert.equal(report.material_changes.length, 0);
      const incident = requiredFixture(
        requiredFixture(report.port_health[0]).canonical_incidents[0],
      );
      assert.equal(
        incident.first_seen,
        requiredFixture(requiredFixture(first.port_health[0]).canonical_incidents[0]).first_seen,
      );
      assert.equal(incident.occurrences, elapsed / 1000 + 1);
      assert.equal(incident.notify, false);
      prior = report;
    }
    assert.ok(
      Date.parse(requiredFixture(requiredFixture(first.observations[0]).retry_at)) >=
        healthTime + 60_000,
    );
  }
});
