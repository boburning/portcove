import assert from "node:assert/strict";
import test from "node:test";
import {
  observationHash,
  githubSourceArchive,
  validateGithubSourceArchiveMetadata,
} from "./upstream-observer.mts";
import {
  collectRepositoryHealth as collectRepositoryHealthWithPolicy,
  renderRepositoryHealth,
  validateHealthAccountingPolicy,
} from "./check-catalog-repositories.mts";

import {
  reviewedAccounting,
  requiredFixture,
  objectFixture,
  sourceArchiveFixture,
  sourceArchivePolicy,
  sourceArchiveFetch,
} from "./fixtures/upstream-observation-fixtures.mts";
import type { HealthCall } from "./fixtures/upstream-observation-fixtures.mts";

void test("exact source commit accounting supports roots and merges, preserving Unknown bytes and destinations", async () => {
  for (const parents of [
    [],
    ["3".repeat(40)],
    ["3".repeat(40), "4".repeat(40)],
    Array.from({ length: 16 }, (_, i) => (i + 5).toString(16).padStart(40, "0")),
  ]) {
    const fixture = sourceArchiveFixture(parents),
      calls: HealthCall[] = [];
    const report = await collectRepositoryHealthWithPolicy(
      { ports: [fixture.port] },
      {
        reviewedAccounting: sourceArchivePolicy(fixture),
        fetch: sourceArchiveFetch(fixture, calls),
        githubToken: "fixture-token",
      },
    );
    assert.equal(report.outcome, "complete");
    assert.equal(report.degradation, true);
    assert.equal(report.request_plan.conservative_requests, 4);
    assert.equal(report.request_plan.conditional_archive_requests, 2);
    assert.equal(report.consumed.requests, 3);
    assert.equal(report.coverage.reused_repositories, 1);
    const record = requiredFixture(
      report.observations.find((r) => r.provider === "direct-manifest"),
    );
    assert.equal(record.status, "unknown");
    assert.equal(record.http_status, 302);
    assert.equal(record.source_archive_assessment?.status, "provider-reported-commit-present");
    assert.equal(record.source_archive_assessment?.accepted_bytes, "unverified");
    assert.equal(record.source_archive_assessment?.destination_availability, "unknown");
    assert.match(record.classification ?? "", /provider-reported-commit-present/);
    assert.equal(report.port_health[0]?.accepted_artifact_obtainability.status, "unknown");
    assert.ok(calls.every((c) => !c.url.includes("untrusted.invalid")));
    assert.ok(!JSON.stringify(report).includes("private-signed-url"));
    assert.match(
      renderRepositoryHealth(report),
      /Source commit metadata: provider-reported-commit-present/,
    );
    const repeat = await collectRepositoryHealthWithPolicy(
      { ports: [fixture.port] },
      {
        reviewedAccounting: sourceArchivePolicy(fixture),
        fetch: sourceArchiveFetch(fixture, []),
        previousReport: report,
      },
    );
    assert.equal(repeat.material_changes.length, 0);
    const changed = await collectRepositoryHealthWithPolicy(
      { ports: [fixture.port] },
      {
        reviewedAccounting: sourceArchivePolicy(fixture),
        previousReport: report,
        fetch: async (url, options) =>
          url.includes("/git/commits/")
            ? new Response(
                JSON.stringify({
                  ...fixture.commit,
                  tree: { ...fixture.commit.tree, sha: "f".repeat(40) },
                }),
              )
            : sourceArchiveFetch(fixture, [])(url, options),
      },
    );
    assert.equal(changed.outcome, "incomplete");
    assert.ok(changed.material_changes.length);
  }
});

void test("source archive URLs and immutable graph facts refuse escaped, changed, ambiguous and partial metadata", () => {
  const fixture = sourceArchiveFixture();
  for (const url of [
    fixture.rule.url + "?x=1",
    fixture.rule.url + "#x",
    fixture.rule.url.replace("github.com", "github.com:443"),
    fixture.rule.url.replace("https://", "https://user@"),
    fixture.rule.url.replace("archive/", "archive/refs/heads/"),
    fixture.rule.url.replace(fixture.rule.commit_sha, "main"),
    fixture.rule.url.replace(".zip", ".tar.gz"),
    fixture.rule.url.replace("github.com", "github.com.evil.invalid"),
  ])
    assert.throws(() => githubSourceArchive(url), url);
  const mutations: ((f: ReturnType<typeof sourceArchiveFixture>) => void)[] = [
    (f) => {
      f.repository.id++;
    },
    (f) => {
      f.repository.full_name = "other/source";
    },
    (f) => {
      f.repository.archived = true;
    },
    (f) => {
      f.commit.sha = "f".repeat(40);
    },
    (f) => {
      f.commit.tree.sha = "f".repeat(40);
    },
    (f) => {
      f.commit.tree.url += "?x=1";
    },
    (f) => {
      f.commit.url = "https://example.invalid/commit";
    },
    (f) => {
      f.commit.html_url += "#x";
    },
    (f) => {
      requiredFixture(f.commit.parents[0]).sha = "f".repeat(40);
    },
    (f) => {
      requiredFixture(f.commit.parents[0]).url += "?x=1";
    },
    (f) => {
      requiredFixture(f.commit.parents[0]).html_url += "#x";
    },
    (f) => {
      f.commit.parents.reverse();
    },
    (f) => {
      f.commit.parents.pop();
    },
    (f) => {
      f.commit.parents.push(requiredFixture(f.commit.parents[0]));
    },
    (f) => {
      f.commit.parents = Array.from({ length: 17 }, () => requiredFixture(f.commit.parents[0]));
    },
    (f) => {
      delete objectFixture(f.commit).parents;
    },
    (f) => {
      objectFixture(f.commit).tree = null;
    },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(fixture);
    mutate(altered);
    assert.throws(() =>
      validateGithubSourceArchiveMetadata(altered.repository, altered.commit, altered.rule),
    );
  }
  const prose = {
    ...fixture.commit,
    message: "untrusted prose",
    verification: { verified: false },
  };
  assert.doesNotThrow(() =>
    validateGithubSourceArchiveMetadata(fixture.repository, prose, fixture.rule),
  );
});

void test("source archive collection keeps failed metadata, redirects, pagination and response budgets unaccounted", async () => {
  const fixture = sourceArchiveFixture(),
    endpoint = `${fixture.api}/git/commits/${fixture.rule.commit_sha}`;
  const failures = [
    ...[301, 302, 303, 307, 308, 401, 403, 404, 429, 500].map(
      (status) => () => new Response(null, { status }),
    ),
    () =>
      new Response(JSON.stringify(fixture.commit), {
        headers: { link: '<https://untrusted.invalid>; rel="next"' },
      }),
    () => new Response("not json"),
    () => new Response(" ".repeat(1024 * 1024 + 1)),
    () => {
      throw new Error("transport failure with private details");
    },
  ];
  for (const failure of failures) {
    const calls: HealthCall[] = [],
      fixed = sourceArchiveFetch(fixture, calls);
    let attempts = 0;
    const report = await collectRepositoryHealthWithPolicy(
      { ports: [fixture.port] },
      {
        reviewedAccounting: sourceArchivePolicy(fixture),
        fetch: async (url, options) => {
          if (url === endpoint) {
            attempts++;
            return failure();
          }
          return fixed(url, options);
        },
      },
    );
    assert.equal(attempts, 1);
    assert.equal(report.outcome, "incomplete");
    const record = requiredFixture(
      report.observations.find((r) => r.provider === "direct-manifest"),
    );
    assert.equal(record.source_archive_assessment?.status, "unknown");
    assert.equal(record.accounted_for, false);
    assert.equal(record.http_status, 302);
    assert.ok(!JSON.stringify(report).includes("private details"));
    assert.ok(calls.every((c) => !c.url.includes("untrusted.invalid")));
  }
});

void test("source archive accounting binds every shared port, exact catalog bytes and current contract", async () => {
  const fixture = sourceArchiveFixture();
  for (const change of [
    "contract",
    "size",
    "sha256",
    "platform",
    "missing",
    "shared",
    "conflict",
  ]) {
    const port = structuredClone(fixture.port),
      policy = sourceArchivePolicy(fixture);
    const catalog = { ports: [port] };
    if (change === "contract") objectFixture(port).new_behavior = true;
    if (change === "size") port.release.direct.windows.size++;
    if (change === "sha256") port.release.direct.windows.sha256 = "b".repeat(64);
    if (change === "size" || change === "sha256")
      requiredFixture(policy.source_archives[0]).port_contract_sha256 = observationHash(port);
    if (change === "platform") requiredFixture(policy.source_archives[0]).platform = "linux";
    if (change === "missing") policy.source_archives = [];
    if (change === "shared") catalog.ports.push({ ...port, id: "unreviewed-shared" });
    if (change === "conflict")
      objectFixture(port.release.direct).linux = {
        ...port.release.direct.windows,
        sha256: "b".repeat(64),
      };
    const report = await collectRepositoryHealthWithPolicy(catalog, {
      reviewedAccounting: policy,
      fetch: sourceArchiveFetch(fixture, []),
    });
    assert.equal(report.outcome, "incomplete", change);
    assert.equal(
      report.observations.find((r) => r.provider === "direct-manifest")?.accounted_for,
      false,
      change,
    );
  }
  const shared = { ...fixture.port, id: "reviewed-shared" },
    policy = sourceArchivePolicy(fixture);
  policy.source_archives.push({
    ...fixture.rule,
    port_id: shared.id,
    port_contract_sha256: observationHash(shared),
  });
  const report = await collectRepositoryHealthWithPolicy(
    { ports: [fixture.port, shared] },
    {
      reviewedAccounting: policy,
      fetch: sourceArchiveFetch(fixture, []),
    },
  );
  assert.equal(report.outcome, "complete");
});

void test("accounting record boundaries include source archives and reject duplicates across acquisition families", () => {
  const fixture = sourceArchiveFixture();
  for (const count of [63, 64, 65]) {
    const policy = {
      ...sourceArchivePolicy(fixture),
      source_archives: Array.from({ length: count }, (_, i) => ({
        ...fixture.rule,
        port_id: `fixture-${i}`,
      })),
    };
    if (count <= 64) assert.doesNotThrow(() => validateHealthAccountingPolicy(policy));
    else assert.throws(() => validateHealthAccountingPolicy(policy));
  }
  const retainedCount =
    reviewedAccounting.pins.length + reviewedAccounting.original_conditions.length;
  for (const total of [64, 65]) {
    const mixed = {
      ...structuredClone(reviewedAccounting),
      source_archives: Array.from({ length: total - retainedCount }, (_, i) => ({
        ...fixture.rule,
        port_id: `mixed-${i}`,
      })),
    };
    if (total === 64) assert.doesNotThrow(() => validateHealthAccountingPolicy(mixed));
    else assert.throws(() => validateHealthAccountingPolicy(mixed));
  }
  for (const mutate of [
    (p: ReturnType<typeof sourceArchivePolicy>) => {
      p.source_archives.push(fixture.rule);
    },
    (p: ReturnType<typeof sourceArchivePolicy>) => {
      requiredFixture(p.source_archives[0]).size = 0;
    },
    (p: ReturnType<typeof sourceArchivePolicy>) => {
      requiredFixture(p.source_archives[0]).sha256 = "bad";
    },
    (p: ReturnType<typeof sourceArchivePolicy>) => {
      objectFixture(requiredFixture(p.source_archives[0])).extra = true;
    },
    (p: ReturnType<typeof sourceArchivePolicy>) => {
      requiredFixture(p.source_archives[0]).url += "?x=1";
    },
  ]) {
    const policy = sourceArchivePolicy(fixture);
    mutate(policy);
    assert.throws(() => validateHealthAccountingPolicy(policy));
  }
  const crossFamily = {
    ...sourceArchivePolicy(fixture),
    pins: [
      {
        ...requiredFixture(reviewedAccounting.pins[0]),
        port_id: fixture.rule.port_id,
        platform: fixture.rule.platform,
      },
    ],
  };
  assert.throws(() => validateHealthAccountingPolicy(crossFamily));
});
