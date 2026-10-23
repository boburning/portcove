import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import fade from "./fixtures/upstream-health-fade-to-black.json" with { type: "json" };
import {
  collectRepositoryHealth,
  estimateHealthRequests,
  readHealthLineage,
  validateHealthAccountingPolicy,
  type HealthFetch,
  type HealthAccountingPolicy,
} from "./check-catalog-repositories.mts";
import { healthArtifactHash } from "./upstream-health-inputs.mts";
import { isRecord } from "./runtime-values.mts";

const now = Date.parse("2026-10-23T12:00:00Z");
const productionPolicy = validateHealthAccountingPolicy(JSON.parse(await readFile(
  new URL("../.github/upstream-health-accounting.json", import.meta.url), "utf8")));
const catalog: unknown = JSON.parse(await readFile(
  new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url), "utf8"));
const originalAsset = fade.assets.find((asset) => asset.name.endsWith("windows-x64.zip"));
assert.ok(originalAsset);
const artifactUrl = originalAsset.browser_download_url;
const reviewedPin = productionPolicy.pins.find((pin) => pin.url === artifactUrl);
assert.ok(reviewedPin);
const port = {
  id: reviewedPin.port_id,
  project_url: `https://github.com/${fade.repository.full_name}`,
  platforms: ["windows-x86-64"],
  release: {
    provider: "direct-manifest",
    direct: {
      "windows-x86-64": {
        url: reviewedPin.url,
        version: reviewedPin.tag,
        size: reviewedPin.size,
        sha256: reviewedPin.sha256,
      },
    },
  },
};
const emptyPolicy: HealthAccountingPolicy = {
  format_version: 2, input_version: 1,
  authority: "offline fixture; observation only", decision: "No reviewed numeric identity",
  pins: [], source_archives: [], original_conditions: [],
};
const boundPolicy: HealthAccountingPolicy = {
  ...emptyPolicy,
  pins: [{ ...reviewedPin, port_contract_sha256: healthArtifactHash(port, "windows-x86-64") }],
};

function provider(change: (facts: typeof fade) => void = () => {}) {
  const facts = structuredClone(fade);
  change(facts);
  const requests: string[] = [];
  const fetch: HealthFetch = async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, "manual");
    if (url === artifactUrl) {
      assert.equal(options.method, "HEAD");
      assert.equal(options.headers.Authorization, undefined);
      return new Response(null, { status: 302 });
    }
    const base = `https://api.github.com/repos/${fade.repository.full_name}`;
    if (url === base) return Response.json(facts.repository);
    if (url === `${base}/releases/tags/${fade.release.tag_name}`) return Response.json(facts.release);
    if (url === `${base}/releases/${facts.release.id}/assets?per_page=100`) return Response.json(facts.assets);
    throw new Error(`Unexpected request ${url}`);
  };
  return { fetch, requests };
}

void test("ordinary GitHub pin metadata needs no exception and grants no identity or bytes authority", async () => {
  const remote = provider();
  const input = { ports: [port] };
  const plan = estimateHealthRequests(input, null, emptyPolicy);
  assert.equal(plan.conservative_requests, 5);
  const report = await collectRepositoryHealth(input, {
    ...remote, now: () => now, reviewedAccounting: emptyPolicy, githubToken: "fixture-only",
  });
  assert.equal(report.format_version, 3);
  assert.equal(report.collection_status, "complete");
  assert.equal(report.outcome, "complete");
  assert.equal(remote.requests.length, 4);
  const pin = report.observations[0]?.pin_assessment;
  assert.ok(pin && pin.status !== "unknown");
  assert.equal(pin.status, "provider-reported-pin-observed");
  assert.equal(pin.identity_binding, "unbound-observation");
  assert.equal(pin.destination_availability, "unknown");
  assert.equal(pin.accepted_bytes, "unverified");
});

void test("reviewed identity survives presentation and other platform edits", async () => {
  const input = { ports: [{ ...structuredClone(port), name: "Changed name", summary: "Changed copy",
    artwork: { image_sha256: "a".repeat(64) }, executable_hints: { "windows-x86-64": ["changed.exe"] } }] };
  const report = await collectRepositoryHealth(input, {
    ...provider(), now: () => now, reviewedAccounting: boundPolicy,
  });
  const pin = report.observations[0]?.pin_assessment;
  assert.ok(pin && pin.status !== "unknown");
  assert.equal(pin.status, "provider-reported-pin-present");
  assert.equal(pin.identity_binding, "reviewed");
  assert.equal(pin.repository_id, reviewedPin.repository_id);
  assert.equal(pin.release_id, reviewedPin.release_id);
  assert.equal(pin.asset_id, reviewedPin.asset_id);
});

void test("generic observation cannot bypass a conflicting reviewed artifact binding", async () => {
  const changed = structuredClone(port);
  changed.release.direct["windows-x86-64"].version = "different accepted version";
  const remote = provider();
  const report = await collectRepositoryHealth({ ports: [changed] }, {
    ...remote, now: () => now, reviewedAccounting: boundPolicy,
  });
  const observation = report.observations[0];
  assert.equal(observation?.pin_assessment?.status, "unknown");
  assert.equal(observation?.pin_assessment?.reason, "identity-mismatch");
  assert.equal(observation?.accounted_for, false);
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.collection_status, "complete");
  assert.equal(remote.requests.filter((url) => url.includes("/releases/")).length, 1);
});

void test("reviewed repository, release, asset and fact changes never become unbound success", async () => {
  const changes: ((facts: typeof fade) => void)[] = [
    (facts) => { facts.repository.id++; },
    (facts) => { facts.release.id++; },
    (facts) => { for (const asset of [...facts.assets, ...facts.release.assets]) asset.id++; },
    (facts) => { facts.release.prerelease = true; },
    (facts) => { for (const asset of [...facts.assets, ...facts.release.assets]) asset.size++; },
    (facts) => { for (const asset of [...facts.assets, ...facts.release.assets]) asset.digest = `sha256:${"f".repeat(64)}`; },
  ];
  for (const change of changes) {
    const report = await collectRepositoryHealth({ ports: [port] }, {
      ...provider(change), now: () => now, reviewedAccounting: boundPolicy,
    });
    assert.equal(report.observations[0]?.pin_assessment?.status, "unknown");
    assert.equal(report.observations[0]?.accounted_for, false);
  }
});

void test("unbound pin observations retain their numeric repository baseline across outages", async () => {
  const first = await collectRepositoryHealth({ ports: [port] }, {
    ...provider(), now: () => now, reviewedAccounting: emptyPolicy,
  });
  const outage = await collectRepositoryHealth({ ports: [port] }, {
    fetch: async () => new Response(null, { status: 404 }),
    now: () => now + 86400_000, reviewedAccounting: emptyPolicy, previousReport: first,
  });
  const reused = await collectRepositoryHealth({ ports: [port] }, {
    ...provider((facts) => { facts.repository.id++; }),
    now: () => now + 2 * 86400_000, reviewedAccounting: emptyPolicy, previousReport: outage,
  });
  assert.equal(reused.observations[0]?.baseline_repository_id, fade.repository.id);
  assert.equal(reused.observations[0]?.pin_assessment?.reason, "identity-mismatch");
  assert.equal(reused.observations[1]?.reason, "identity-mismatch");
});

void test("malformed provider metadata is partial collection and a visible pin failure", async () => {
  const remote = provider();
  const report = await collectRepositoryHealth({ ports: [port] }, {
    now: () => now, reviewedAccounting: emptyPolicy,
    fetch: async (url, options) => url.includes("/assets?")
      ? new Response("{unfinished", { headers: { "content-type": "application/json" } })
      : remote.fetch(url, options),
  });
  assert.equal(report.collection_status, "partial");
  assert.equal(report.port_health[0]?.collection_status, "partial");
  assert.equal(report.observations[0]?.http_status, 302);
  assert.equal(report.observations[0]?.pin_assessment?.reason, "invalid-metadata");
});

void test("condition history survives catalog presentation edits and unrelated additions", async () => {
  const input = { ports: [{ id: "tracked", release: { repository: "owner/tracked" } }] };
  const first = await collectRepositoryHealth(input, { now: () => now,
    reviewedAccounting: emptyPolicy, fetch: async () => new Response(null, { status: 404 }) });
  const changed = { ports: [{ ...input.ports[0], summary: "new summary" },
    { id: "unrelated", release: { repository: "owner/unrelated" } }] };
  const repeated = await collectRepositoryHealth(changed, {
    now: () => now + 3 * 86400_000, portIds: ["tracked"], previousReport: first,
    reviewedAccounting: emptyPolicy, fetch: async () => new Response(null, { status: 404 }),
  });
  assert.equal(repeated.material_changes.length, 0);
  assert.equal(repeated.port_health[0]?.canonical_incidents[0]?.occurrences, 2);
  assert.equal(repeated.port_health[0]?.canonical_incidents[0]?.first_seen,
    first.port_health[0]?.canonical_incidents[0]?.first_seen);
  assert.deepEqual(repeated.scope.unassessed_port_ids, ["unrelated"]);
});

void test("Star Fox project lineage and the old acquisition condition remain separate", async () => {
  assert.ok(isRecord(catalog) && Array.isArray(catalog.ports));
  const ports: unknown[] = catalog.ports;
  const star = ports.find((entry) => isRecord(entry) && entry.id === "star-fox-enhanced");
  assert.ok(isRecord(star) && typeof star.id === "string");
  const before = structuredClone(star);
  const input = { ...catalog, ports: [star] };
  const lineageRecords = await readHealthLineage(input);
  assert.equal(lineageRecords.length, 1);
  const collect = (id: number) => collectRepositoryHealth(input, {
    now: () => now, lineageRecords,
    fetch: async (url) => url === "https://api.github.com/repos/kandowontu2/starfox-enhanced"
      ? Response.json({ id, full_name: "kandowontu2/starfox-enhanced", archived: false })
      : new Response(null, { status: 404 }),
  });
  const report = await collect(1393981305);
  const old = report.observations.find((entry) => entry.repository === "kandowontu/starfox-enhanced" && !entry.release_ref);
  const current = report.observations.find((entry) => entry.repository === "kandowontu2/starfox-enhanced" && !entry.release_ref);
  assert.equal(old?.accounted_for, true);
  assert.deepEqual(old?.acquisition_port_ids, [star.id]);
  assert.equal(current?.status, "reachable");
  assert.equal(report.port_health[0]?.lineage.status, "recorded");
  assert.equal(report.port_health[0]?.lineage.successor_selected, true);
  assert.equal(report.port_health[0]?.accepted_artifact_obtainability.status, "unknown");
  assert.equal(report.port_health[0]?.qualification.inherited, false);
  assert.ok(report.observations.filter((entry) => entry.release_ref).every((entry) => !entry.accounted_for));
  assert.deepEqual(star, before);
  const replaced = await collect(1393981306);
  assert.equal(replaced.observations.find((entry) => entry.repository === current?.repository && !entry.release_ref)?.reason, "identity-mismatch");
});

void test("a completed missing endpoint differs from a collection transport failure", async () => {
  const input = { ports: [{ id: "tracked", release: { repository: "owner/tracked" } }] };
  const missing = await collectRepositoryHealth(input, { reviewedAccounting: emptyPolicy,
    fetch: async () => new Response(null, { status: 404 }) });
  assert.equal(missing.collection_status, "complete");
  assert.equal(missing.outcome, "incomplete");
  const failed = await collectRepositoryHealth(input, { reviewedAccounting: emptyPolicy,
    fetch: async () => { throw new Error("offline"); } });
  assert.equal(failed.collection_status, "partial");
  assert.equal(failed.observations[0]?.reason, "transport");
});

void test("monitoring policy versions and exception limits remain strict", () => {
  assert.throws(() => validateHealthAccountingPolicy({ ...emptyPolicy, format_version: "2" }));
  assert.throws(() => validateHealthAccountingPolicy({ ...emptyPolicy, input_version: 2 }));
  const condition = productionPolicy.original_conditions[0];
  assert.ok(condition);
  assert.throws(() => validateHealthAccountingPolicy({ ...emptyPolicy,
    original_conditions: Array.from({ length: 65 }, (_, index) => ({ ...condition, port_id: `fixture-${index}` })) }));
});
