import { isRecord } from "./runtime-values.mts";
import type { HealthRequestOptions } from "./check-catalog-repositories.mts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  observationHash,
  githubDirectPin,
  validateGithubPinMetadata,
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
  arrayFixture,
  collectRepositoryHealth,
  pinMetadata,
  currentHealthCatalog,
  accountingCatalog,
  accountingFetch,
} from "./fixtures/upstream-observation-fixtures.mts";
import type { AccountingReply } from "./fixtures/upstream-observation-fixtures.mts";

void test("reviewed exact metadata and original conditions remain degraded without granting bytes or lineage", async () => {
  const calls: { url: string; options: HealthRequestOptions }[] = [],
    catalog = accountingCatalog();
  const report = await collectRepositoryHealth(catalog, {
    fetch: accountingFetch(calls),
    githubToken: "synthetic-token",
  });
  assert.equal(report.outcome, "complete");
  assert.equal(report.degradation, true);
  assert.equal(report.coverage.repositories, 22);
  assert.equal(report.coverage.attempted_repositories, 14);
  assert.equal(report.coverage.reused_repositories, 8);
  assert.equal(report.coverage.reachable_repositories, 8);
  assert.equal(report.coverage.unknown_repositories, 14);
  assert.equal(report.consumed.requests, 44);
  assert.equal(calls.length, 44);
  for (const call of calls) {
    assert.equal(call.options.redirect, "manual");
    if (call.url.startsWith("https://api.github.com/"))
      assert.equal(call.options.headers.Authorization, "Bearer synthetic-token");
    else {
      assert.equal(call.options.method, "HEAD");
      assert.equal(call.options.headers.Authorization, undefined);
    }
  }
  for (const record of report.observations.filter((record) => record.pin_assessment)) {
    assert.equal(record.http_status, 302);
    assert.equal(record.status, "unknown");
    assert.equal(record.reason, "provider-redirect");
    assert.ok(record.pin_assessment?.status === "provider-reported-pin-present");
    assert.equal(requiredFixture(record.pin_assessment).status, "provider-reported-pin-present");
    assert.equal(requiredFixture(record.pin_assessment).destination_availability, "unknown");
    assert.equal(requiredFixture(record.pin_assessment).accepted_bytes, "unverified");
  }
  for (const port of report.port_health) {
    assert.equal(port.lineage.status, "not-assessed");
    assert.equal(port.accepted_artifact_obtainability.status, "unknown");
  }
  assert.ok(report.port_health.every((port) => port.lineage.catalog_upstream_status === "active"));
  assert.ok(!JSON.stringify(report).includes("synthetic-private-value"));
  assert.match(renderRepositoryHealth(report), /provider-reported-pin-present/);
  assert.match(renderRepositoryHealth(report), /reviewed-endpoint-condition/);
  const original = JSON.stringify(catalog);
  const comparison = await collectRepositoryHealth(catalog, {
    fetch: accountingFetch([]),
    previousReport: report,
  });
  assert.equal(comparison.outcome, "complete");
  assert.equal(comparison.material_changes.length, 0);
  assert.equal(original, JSON.stringify(catalog));
});

void test("fixed mixed inventory retains every location and pin check with eight fewer actual requests", async () => {
  for (const expanded of [false, true]) {
    const catalog = structuredClone(currentHealthCatalog);
    if (expanded)
      catalog.ports.push(
        {
          id: "extra-shared-original",
          release: {
            provider: "github",
            repository: requiredFixture(
              reviewedAccounting.pins.find((pin) => pin.port_id === "alexbeav-ape-escape-recomp"),
            ).repository,
          },
        },
        ...Array.from({ length: 83 }, (_, i) => ({
          id: `expanded-${i}`,
          release: { provider: "github", repository: `fixture/expanded-${i}` },
        })),
      );
    const calls: { url: string; options: HealthRequestOptions }[] = [];
    const inventory = await collectRepositoryHealth(catalog, {
      fetch: async () => {
        throw new Error("offline inventory only");
      },
      now: () => 0,
    });
    const fixed = accountingFetch(calls);
    const fixedPrefixes = reviewedAccounting.pins.map(
      (pin) => `https://api.github.com/repos/${pin.repository}`,
    );
    const fixedUrls = new Set([
      ...reviewedAccounting.pins.map((pin) => pin.url),
      ...reviewedAccounting.original_conditions.map(
        (rule) => `https://api.github.com/repos/${rule.repository}`,
      ),
    ]);
    const report = await collectRepositoryHealth(catalog, {
      fetch: async (url: string, options) => {
        if (
          fixedUrls.has(url) ||
          fixedPrefixes.some((prefix) => url === prefix || url.startsWith(`${prefix}/`))
        )
          return fixed(url, options);
        calls.push({ url, options });
        if (options.method === "HEAD") {
          const artifact = catalog.ports
            .flatMap((port) => {
              const release: unknown = port.release;
              return isRecord(release) && isRecord(release.direct)
                ? Object.values(release.direct)
                : [];
            })
            .find((artifact) => isRecord(artifact) && artifact.url === url);
          return new Response(null, {
            headers: {
              "content-length": String(
                isRecord(artifact) && typeof artifact.size === "number" ? artifact.size : 0,
              ),
            },
          });
        }
        const record = inventory.observations.find((record) => {
          const base =
            record.provider === "github"
              ? `https://api.github.com/repos/${record.repository}`
              : `https://gitlab.com/api/v4/projects/${encodeURIComponent(record.repository)}`;
          return (
            url ===
            (record.release_ref
              ? `${base}/releases/${record.provider === "github" ? "tags/" : ""}${encodeURIComponent(record.release_ref)}`
              : base)
          );
        });
        assert.ok(record, url);
        const assets = (record.historical_artifact_identities ?? []).map((identity) => ({
          digest: `sha256:${identity.artifact_sha256}`,
        }));
        const facts = record.release_ref
          ? {
              id: 1,
              tag_name: record.release_ref,
              assets: record.provider === "github" ? assets : { links: assets },
            }
          : {
              id: 1,
              full_name: record.repository,
              path_with_namespace: record.repository,
              archived: false,
            };
        return new Response(JSON.stringify(facts), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(
      report.outcome,
      "complete",
      JSON.stringify(report.observations.filter((r) => !r.accounted_for)),
    );
    assert.equal(report.coverage.monitored_ports, expanded ? 99 : 15);
    assert.equal(report.coverage.repositories, expanded ? 109 : 25);
    assert.equal(report.coverage.attempted_repositories, expanded ? 100 : 17);
    assert.equal(report.coverage.reused_repositories, expanded ? 9 : 8);
    assert.equal(report.consumed.requests, expanded ? 130 : 47);
    assert.equal(calls.length, expanded ? 130 : 47);
    assert.equal(report.limits.requests, expanded ? 139 : 55);
    assert.equal(report.request_plan.conservative_requests, report.limits.requests);
    assert.equal(report.request_plan.hard_ceiling, 320);
    assert.equal(report.request_plan.conditional_repository_reuses, expanded ? 9 : 8);
    assert.equal(report.observations.filter((record) => record.pin_assessment).length, 10);
    for (const pin of reviewedAccounting.pins) {
      const prefix = `https://api.github.com/repos/${pin.repository}`;
      assert.equal(calls.filter((call) => call.url === prefix).length, 1);
      for (const endpoint of [
        `${prefix}/releases/tags/${encodeURIComponent(pin.tag)}`,
        `${prefix}/releases/${pin.release_id}/assets?per_page=100`,
      ])
        assert.equal(calls.filter((call) => call.url === endpoint).length, 1);
    }
    for (const original of reviewedAccounting.original_conditions)
      assert.equal(
        calls.filter((call) => call.url === `https://api.github.com/repos/${original.repository}`)
          .length,
        1,
      );
  }
});

void test("repository reuse retains all obligations across the former cap and near the fixed ceiling", async () => {
  const pin = requiredFixture(reviewedAccounting.pins[0]);
  const prefix = `https://api.github.com/repos/${pin.repository}`;
  const ordinaryPort = (id: string) => ({
    id,
    release: { provider: "github", repository: `fixture/${id}` },
  });
  for (const [ordinaryCount, nextLive] of [
    [123, false],
    [124, false],
    [124, true],
    [315, false],
  ] as const) {
    const catalog = {
      ports: [
        ...Array.from({ length: ordinaryCount }, (_, i) => ordinaryPort(`capacity-${i}`)),
        currentHealthCatalog.ports.find((port) => port.id === pin.port_id),
        ...(nextLive ? [ordinaryPort("next-live")] : []),
      ],
    };
    const calls: { url: string; options: HealthRequestOptions }[] = [];
    const fixed = accountingFetch(calls);
    const report = await collectRepositoryHealth(catalog, {
      now: () => 0,
      fetch: async (url, options) => {
        if (!url.startsWith("https://api.github.com/repos/fixture/")) return fixed(url, options);
        calls.push({ url, options });
        return new Response(
          JSON.stringify({
            id: 42,
            full_name: url.slice("https://api.github.com/repos/".length),
            archived: false,
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    assert.equal(report.limits.requests, ordinaryCount + 5 + Number(nextLive));
    assert.equal(report.request_plan.hard_ceiling, 320);
    assert.equal(report.consumed.requests, ordinaryCount + 4 + Number(nextLive));
    assert.equal(calls.length, ordinaryCount + 4 + Number(nextLive));
    assert.equal(calls.filter((call) => call.url === prefix).length, 1);
    assert.equal(
      requiredFixture(
        requiredFixture(report.observations.find((record) => record.repository === pin.url))
          .pin_assessment,
      ).status,
      "provider-reported-pin-present",
    );
    const original = requiredFixture(
      report.observations.find((record) => record.repository === pin.repository),
    );
    assert.equal(original.attempted, false);
    assert.equal(original.metadata_reused, true);
    assert.equal(original.reason, null);
    assert.equal(original.status, "reachable");
    assert.equal(original.accounted_for, true);
    assert.equal(report.outcome, "complete");
    if (nextLive) {
      const refused = requiredFixture(
        report.observations.find((record) => record.repository === "fixture/next-live"),
      );
      assert.equal(refused.attempted, true);
      assert.equal(refused.metadata_reused, false);
      assert.equal(refused.reason, null);
      assert.equal(refused.accounted_for, true);
    }
  }
});

void test("repository reuse stays in one collection and failed or partial reads are never cached", async () => {
  const catalog = accountingCatalog();
  const first = await collectRepositoryHealth(catalog, { fetch: accountingFetch([]) });
  const prefix = `https://api.github.com/repos/${requiredFixture(reviewedAccounting.pins[0]).repository}`;
  for (const status of [301, 401, 404, 503]) {
    const calls: { url: string; options: HealthRequestOptions }[] = [];
    const report = await collectRepositoryHealth(catalog, {
      previousReport: first,
      fetch: accountingFetch(calls, (url, response) =>
        url === prefix ? { ...response, status } : response,
      ),
    });
    assert.equal(report.outcome, "incomplete", String(status));
    assert.equal(calls.filter((call) => call.url === prefix).length, 2);
    assert.equal(
      requiredFixture(
        report.observations.find(
          (record) => record.repository === prefix.replace("https://api.github.com/repos/", ""),
        ),
      ).metadata_reused,
      false,
    );
    assert.equal(
      requiredFixture(
        requiredFixture(
          report.observations.find(
            (record) => record.repository === requiredFixture(reviewedAccounting.pins[0]).url,
          ),
        ).pin_assessment,
      ).status,
      "unknown",
    );
  }
  for (const invalid of [
    () => new Response("{", { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          link: '<https://example.invalid>; rel="next"',
        },
      }),
  ]) {
    const calls: { url: string; options: HealthRequestOptions }[] = [],
      ordinary = accountingFetch(calls);
    const report = await collectRepositoryHealth(catalog, {
      fetch: async (url, options) => {
        if (url !== prefix) return ordinary(url, options);
        calls.push({ url, options });
        return invalid();
      },
    });
    assert.equal(report.outcome, "incomplete");
    assert.equal(calls.filter((call) => call.url === prefix).length, 2);
    assert.equal(
      requiredFixture(
        requiredFixture(
          report.observations.find(
            (record) => record.repository === requiredFixture(reviewedAccounting.pins[0]).url,
          ),
        ).pin_assessment,
      ).status,
      "unknown",
    );
  }
  const calls: { url: string; options: HealthRequestOptions }[] = [];
  const fresh = await collectRepositoryHealth(catalog, {
    previousReport: first,
    fetch: accountingFetch(calls),
  });
  assert.equal(fresh.outcome, "complete");
  assert.equal(calls.length, 44);
});

void test("reused repository facts still fail pin and original-location identity checks", async () => {
  const pin = requiredFixture(reviewedAccounting.pins[0]),
    prefix = `https://api.github.com/repos/${pin.repository}`;
  const calls: { url: string; options: HealthRequestOptions }[] = [];
  const report = await collectRepositoryHealth(accountingCatalog(), {
    fetch: accountingFetch(calls, (url, response) =>
      url === prefix
        ? { ...response, data: { ...objectFixture(response.data), full_name: "wrong/repository" } }
        : response,
    ),
  });
  assert.equal(calls.filter((call) => call.url === prefix).length, 1);
  assert.equal(report.outcome, "incomplete");
  const original = requiredFixture(
    report.observations.find((record) => record.repository === pin.repository),
  );
  assert.equal(original.metadata_reused, true);
  assert.equal(original.reason, "identity-mismatch");
  assert.equal(original.accounted_for, false);
  assert.equal(
    requiredFixture(
      requiredFixture(report.observations.find((record) => record.repository === pin.url))
        .pin_assessment,
    ).status,
    "unknown",
  );
});

void test("captured repository metadata cannot bypass deadline or historical numeric identity", async () => {
  const pin = requiredFixture(reviewedAccounting.pins[0]);
  const catalog = { ports: accountingCatalog().ports.filter((port) => port.id === pin.port_id) };
  const original = await collectRepositoryHealth(catalog, { fetch: accountingFetch([]) });
  const baseline = structuredClone(original);
  requiredFixture(
    baseline.observations.find((record) => record.repository === pin.repository),
  ).baseline_repository_id = 1;
  const mismatch = await collectRepositoryHealth(catalog, {
    previousReport: baseline,
    fetch: accountingFetch([]),
  });
  const record = requiredFixture(
    mismatch.observations.find((record) => record.repository === pin.repository),
  );
  assert.equal(record.metadata_reused, true);
  assert.equal(record.reason, "identity-mismatch");
  assert.equal(record.accounted_for, false);
  assert.equal(mismatch.outcome, "incomplete");

  let clock = 0;
  const calls: { url: string; options: HealthRequestOptions }[] = [],
    fixed = accountingFetch(calls);
  const expired = await collectRepositoryHealth(catalog, {
    now: () => clock,
    fetch: async (url: string, options) => {
      const response = await fixed(url, options);
      if (url.endsWith("/assets?per_page=100")) clock = 180_001;
      return response;
    },
  });
  const unattempted = requiredFixture(
    expired.observations.find((record) => record.repository === pin.repository),
  );
  assert.equal(unattempted.reason, "budget");
  assert.equal(unattempted.attempted, false);
  assert.equal(unattempted.metadata_reused, false);
  assert.equal(expired.outcome, "incomplete");
  assert.equal(calls.length, 4);
});

void test("shared metadata validators require exact declared provider facts and complete collections", () => {
  for (let i = 0; i < reviewedAccounting.pins.length; i++) {
    const pin = requiredFixture(reviewedAccounting.pins[i]),
      fixture = requiredFixture(pinMetadata[i]);
    assert.deepEqual(githubDirectPin(pin.url), {
      repository: pin.repository,
      tag: pin.tag,
      name: pin.name,
    });
    assert.equal(
      validateGithubPinMetadata(fixture.repository, fixture.release, fixture.assets, pin).asset.id,
      pin.asset_id,
    );
  }
  for (const url of [
    "https://example.org/a/b/releases/download/v1/a.zip",
    "https://github.com/a/b/releases/download/v1/a.zip?token=x",
    "https://github.com/a/b/releases/download/v1/a%2fzip",
  ]) {
    assert.throws(() => githubDirectPin(url));
  }
});

void test("missing or changed pin metadata remains unaccounted while retaining the original302", async () => {
  const first = requiredFixture(reviewedAccounting.pins[0]);
  const prefix = `https://api.github.com/repos/${first.repository}`;
  const changes: [string, (response: AccountingReply) => AccountingReply][] = [
    [prefix, (response) => ({ ...response, data: { ...objectFixture(response.data), id: 1 } })],
    [
      prefix,
      (response: AccountingReply) => ({
        ...response,
        data: { ...objectFixture(response.data), full_name: "other/reused" },
      }),
    ],
    [
      prefix,
      (response) => ({ ...response, data: { ...objectFixture(response.data), archived: true } }),
    ],
    [
      `${prefix}/releases/tags/${first.tag}`,
      (response: AccountingReply) => ({ ...response, status: 302, data: null }),
    ],
    [
      `${prefix}/releases/tags/${first.tag}`,
      (response: AccountingReply) => ({
        ...response,
        data: { ...objectFixture(response.data), id: 1 },
      }),
    ],
    [
      `${prefix}/releases/tags/${first.tag}`,
      (response: AccountingReply) => ({
        ...response,
        data: { ...objectFixture(response.data), draft: true },
      }),
    ],
    [
      `${prefix}/releases/${first.release_id}/assets?per_page=100`,
      (response: AccountingReply) => ({ ...response, data: [] }),
    ],
    [
      `${prefix}/releases/${first.release_id}/assets?per_page=100`,
      (response: AccountingReply) => ({
        ...response,
        headers: { link: '<https://example.invalid/next>; rel="next"' },
      }),
    ],
  ];
  for (const field of ["id", "size", "digest", "browser_download_url", "updated_at"])
    changes.push([
      `${prefix}/releases/${first.release_id}/assets?per_page=100`,
      (response: AccountingReply) => ({
        ...response,
        data: arrayFixture(response.data).map((rawAsset) => {
          const asset = objectFixture(rawAsset);
          return asset.id === first.asset_id
            ? {
                ...asset,
                [field]:
                  field === "id" || field === "size"
                    ? 1
                    : field === "digest"
                      ? null
                      : field === "updated_at"
                        ? "2026-10-09T12:00:00Z"
                        : "https://example.invalid/asset",
              }
            : asset;
        }),
      }),
    ]);
  for (const [endpoint, mutate] of changes) {
    const calls: { url: string; options: HealthRequestOptions }[] = [];
    const report = await collectRepositoryHealth(accountingCatalog(), {
      fetch: accountingFetch(calls, (url, response) =>
        url === endpoint ? mutate(response) : response,
      ),
    });
    const record = requiredFixture(
      report.observations.find((record) => record.repository === first.url),
    );
    assert.equal(report.outcome, "incomplete", endpoint);
    assert.equal(record.http_status, 302);
    assert.equal(requiredFixture(record.pin_assessment).status, "unknown");
    assert.equal(record.accounted_for, false);
    assert.ok(calls.every((call) => !call.url.includes("example.invalid")));
  }
});

void test("reviewed original conditions cannot hide changed status, redirect identity or port contracts", async () => {
  const original = requiredFixture(reviewedAccounting.original_conditions[0]);
  const endpoint = `https://api.github.com/repos/${original.repository}`;
  for (const change of [
    (response: AccountingReply) => ({ ...response, status: 302 }),
    (response: AccountingReply) => ({ ...response, status: 401 }),
    (response: AccountingReply) => ({ ...response, status: 503 }),
    (response: AccountingReply) => ({
      ...response,
      data: { message: "Moved Permanently", url: "https://api.github.com/repositories/1" },
    }),
    (response: AccountingReply) => ({
      ...response,
      data: { message: "Moved Permanently", url: "https://example.invalid/redirect" },
    }),
  ]) {
    const report = await collectRepositoryHealth(accountingCatalog(), {
      fetch: accountingFetch([], (url, response) =>
        url === endpoint ? change(response) : response,
      ),
    });
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      requiredFixture(
        report.observations.find((record) => record.repository === original.repository),
      ).accounted_for,
      false,
    );
  }
  const changed = accountingCatalog();
  requiredFixture(changed.ports.find((port) => port.id === original.port_id)).name += " changed";
  assert.equal(
    (await collectRepositoryHealth(changed, { fetch: accountingFetch([]) })).outcome,
    "incomplete",
  );
  const summary = accountingCatalog();
  summary.ports.forEach((port) => (port.summary += " clarified"));
  assert.equal(
    (await collectRepositoryHealth(summary, { fetch: accountingFetch([]) })).outcome,
    "complete",
  );
  const shared = accountingCatalog();
  const extra = structuredClone(
    requiredFixture(shared.ports.find((port) => port.id === original.port_id)),
  );
  extra.id = "unreviewed-shared-port";
  shared.ports.push(extra);
  assert.equal(
    (
      await collectRepositoryHealth(shared, {
        fetch: accountingFetch([]),
        portIds: [original.port_id],
      })
    ).outcome,
    "incomplete",
  );
});

void test("missing pin scopes, malformed accounting rules and unclassified failures cannot authorize a pass", async () => {
  const missing = structuredClone(reviewedAccounting);
  missing.pins = [];
  assert.equal(
    (
      await collectRepositoryHealth(accountingCatalog(), {
        fetch: accountingFetch([]),
        reviewedAccounting: missing,
      })
    ).outcome,
    "incomplete",
  );
  const missingOriginal = structuredClone(reviewedAccounting);
  missingOriginal.original_conditions = [];
  assert.equal(
    (
      await collectRepositoryHealth(accountingCatalog(), {
        fetch: accountingFetch([]),
        reviewedAccounting: missingOriginal,
      })
    ).outcome,
    "incomplete",
  );
  for (const mutate of [
    (policy: unknown) => (objectFixture(policy).extra = true),
    (policy: typeof reviewedAccounting) => (requiredFixture(policy.pins[0]).repository_id = 0),
    (policy: typeof reviewedAccounting) =>
      (objectFixture(requiredFixture(policy.original_conditions[0])).http_status = 302),
    (policy: typeof reviewedAccounting) =>
      policy.original_conditions.push(requiredFixture(policy.original_conditions[0])),
  ]) {
    const invalid = structuredClone(reviewedAccounting);
    mutate(invalid);
    assert.throws(() => validateHealthAccountingPolicy(invalid));
    let calls = 0;
    await assert.rejects(
      collectRepositoryHealth(accountingCatalog(), {
        reviewedAccounting: invalid,
        fetch: () => {
          calls++;
          throw Error("must not request");
        },
      }),
    );
    assert.equal(calls, 0);
  }
  const catalog = accountingCatalog();
  const extra = structuredClone(requiredFixture(catalog.ports[0]));
  extra.id = "new-unclassified-port";
  extra.project_url = "https://github.com/unclassified/project";
  extra.release = { provider: "github", repository: "unclassified/project" };
  catalog.ports.push(extra);
  const ordinary = accountingFetch([]);
  assert.equal(
    (
      await collectRepositoryHealth(catalog, {
        fetch: (url, options) =>
          url.includes("unclassified/project")
            ? Promise.resolve(new Response(null, { status: 404 }))
            : ordinary(url, options),
      })
    ).outcome,
    "incomplete",
  );
});

void test("same-ID contradictory release and asset collections never account an exact pin", () => {
  const pin = requiredFixture(reviewedAccounting.pins[0]),
    fixture = requiredFixture(pinMetadata[0]);
  for (const field of ["digest", "size", "browser_download_url", "state", "updated_at"]) {
    const release = structuredClone(fixture.release);
    const asset = requiredFixture(release.assets.find((asset) => asset.id === pin.asset_id));
    objectFixture(asset)[field] =
      field === "digest"
        ? "sha256:" + "0".repeat(64)
        : field === "size"
          ? 1
          : field === "state"
            ? "new"
            : field === "updated_at"
              ? "2026-10-09T12:00:00Z"
              : "https://github.com/" +
                pin.repository +
                "/releases/download/" +
                pin.tag +
                "/different.zip";
    assert.throws(
      () => validateGithubPinMetadata(fixture.repository, release, fixture.assets, pin),
      field,
    );
  }
});

void test("changed release classification or publication facts cannot inherit reviewed pin accounting", () => {
  const pin = requiredFixture(reviewedAccounting.pins[0]),
    fixture = requiredFixture(pinMetadata[0]);
  for (const patch of [
    { prerelease: !fixture.release.prerelease },
    { published_at: "2026-10-09T12:00:00Z" },
    { created_at: "2026-10-09T12:00:00Z" },
  ]) {
    assert.throws(() =>
      validateGithubPinMetadata(
        fixture.repository,
        { ...fixture.release, ...patch },
        fixture.assets,
        pin,
      ),
    );
  }
});

void test("reviewed release URL tags remain exact when catalog version labels omit their v prefix", async () => {
  const policy = structuredClone(reviewedAccounting),
    pin = requiredFixture(policy.pins[0]);
  const port = structuredClone(
    requiredFixture(currentHealthCatalog.ports.find((p) => p.id === pin.port_id)),
  );
  const direct = objectFixture(objectFixture(objectFixture(port.release).direct)[pin.platform]);
  assert.ok(pin.tag.startsWith("v"));
  direct.version = pin.tag.slice(1);
  const { summary: _summary, ...contract } = port;
  pin.port_contract_sha256 = observationHash(contract);
  const report = await collectRepositoryHealthWithPolicy(
    { ports: [port] },
    {
      reviewedAccounting: policy,
      fetch: accountingFetch([]),
    },
  );
  assert.equal(report.outcome, "complete");
  assert.equal(report.request_plan.conditional_pin_requests, 3);
  assert.equal(
    report.observations.find((r) => r.repository === pin.url)?.pin_assessment?.status,
    "provider-reported-pin-present",
  );
  direct.version = "different-catalog-contract";
  const changed = await collectRepositoryHealthWithPolicy(
    { ports: [port] },
    {
      reviewedAccounting: policy,
      fetch: accountingFetch([]),
    },
  );
  assert.equal(changed.outcome, "incomplete");
  assert.equal(changed.request_plan.conditional_pin_requests, 0);
  pin.tag = "different-provider-tag";
  assert.throws(() => validateHealthAccountingPolicy(policy));
});
