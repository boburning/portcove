import fadePin from "./fixtures/upstream-health-fade-to-black.json" with { type: "json" };
import pinCases from "./fixtures/upstream-health-pins.json" with { type: "json" };
import { isRecord } from "./runtime-values.mts";
import accountingCases from "./fixtures/upstream-health-accounting-cases.json" with { type: "json" };
import type { ObserverRequestOptions } from "./upstream-observer.mts";
import type {
  HealthOptions,
  HealthFetch,
  HealthRequestOptions,
} from "./check-catalog-repositories.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import {
  ObservationFailure,
  observationHash,
  observeUpstream,
  validateObserverConfig,
  githubDirectPin,
  validateGithubPinMetadata,
  githubSourceArchive,
  validateGithubSourceArchiveMetadata,
} from "./upstream-observer.mts";
import { advanceObservation, withCheckpointLock } from "./observe-configured-upstream.mts";
import {
  collectRepositoryHealth as collectRepositoryHealthWithPolicy,
  renderRepositoryHealth,
  validateHealthAccountingPolicy,
} from "./check-catalog-repositories.mts";
import { discoverUpstreamHealthScope, selectUpstreamHealthScope } from "./upstream-health-plan.mts";
import { healthArtifactHash, healthEndpointHash } from "./upstream-health-inputs.mts";

const config = validateObserverConfig(
  JSON.parse(await readFile(new URL("../release/upstream-observer.json", import.meta.url), "utf8")),
);

const reviewedAccounting = validateHealthAccountingPolicy(accountingCases.reviewedAccounting);

void test("the compiled CLI fixture uses the same canonical facts digest", async () => {
  const fixture: unknown = JSON.parse(
    await readFile(
      new URL("../crates/portcove-cli/tests/fixtures/upstream-observation.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(isRecord(fixture));
  assert.equal(observationHash(fixture.facts), fixture.facts_sha256);
});

void test("scheduled observation keeps the configured cadence, read-only authority and bounded recovery cache", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/configured-upstream-observer.yml", import.meta.url),
    "utf8",
  );
  const cadence = `17 */${config.cadence_hours} * * *`;
  assert.ok(workflow.includes(`cron: '${cadence}'`) || workflow.includes(`cron: "${cadence}"`));
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.doesNotMatch(
    workflow,
    /pull_request_target|contents: write|id-token: write|actions: write|secrets\.(?!GITHUB_TOKEN\b)/,
  );
  assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(
    workflow,
    /if:.*!cancelled\(\).*hashFiles\('work\/upstream-observer\/\*\/checkpoint.json'\)/,
  );
  assert.doesNotMatch(workflow, /upstream-observer\/\*\*|\.lock|\.next/);
  assert.match(workflow, /retention-days: 7/);
});
const root = `https://api.github.com/repos/${config.repository}`;
const time = "2026-09-09T12:00:00Z";
const release = (id = 1, extra = {}) => ({
  id,
  tag_name: `v${id}.0.0`,
  draft: false,
  prerelease: false,
  created_at: time,
  published_at: time,
  ...extra,
});
const asset = (id = 2, contents = "redistributable fixture one") => ({
  id,
  name: `fixture-${id}-windows.zip`,
  size: Buffer.byteLength(contents),
  state: "uploaded",
  digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
  browser_download_url: `https://github.com/${config.repository}/releases/download/v1.0.0/fixture-${id}-windows.zip`,
  created_at: time,
  updated_at: time,
});

interface FixtureReply {
  body: unknown;
  link?: string;
}
class FixtureReplies extends Map<string, FixtureReply> {
  override get(key: string): FixtureReply {
    return requiredFixture(super.get(key));
  }
}
interface FixtureOverrides {
  intercept?: (
    url: string,
    options: ObserverRequestOptions,
    count: number,
    replies: FixtureReplies,
  ) => Response | null | void | Promise<Response | null | void>;
}
function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, "missing expected fixture");
  return value;
}
function objectFixture(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function incrementFixtureId(value: unknown) {
  const object = objectFixture(value);
  assert.ok(typeof object.id === "number");
  object.id++;
}
function arrayFixture(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function fixture(overrides: FixtureOverrides = {}) {
  const replies = new FixtureReplies([
    [
      root,
      {
        body: {
          id: config.repository_id,
          full_name: config.repository,
          archived: false,
        },
      },
    ],
    [`${root}/releases?per_page=100&page=1`, { body: [release()] }],
    [`${root}/releases/1/assets?per_page=100&page=1`, { body: [asset()] }],
  ]);
  const requests: { url: string; options: ObserverRequestOptions }[] = [];
  const fetch = async (url: string, options: ObserverRequestOptions) => {
    requests.push({ url, options });
    if (overrides.intercept) {
      const intercepted = await overrides.intercept(url, options, requests.length, replies);
      if (intercepted) return intercepted;
    }
    const reply = replies.get(url);
    assert.ok(reply, `Unexpected URL ${url}`);
    const etag = `"${observationHash(reply)}"`;
    if (options.headers["If-None-Match"] === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(reply.body), {
      headers: {
        "content-type": "application/json",
        etag,
        link: reply.link ?? "",
      },
    });
  };
  return { replies, requests, fetch };
}

void test("records exact release and asset facts, conditional cache and changed fixture artifacts", async () => {
  const server = fixture();
  const first = await observeUpstream(config, {
    fetch: server.fetch,
    token: "fixture-token",
  });
  assert.equal(first.observation.authority, "provider-observation-only");
  assert.equal(
    requiredFixture(requiredFixture(first.observation.facts.releases[0]).assets[0]).id,
    2,
  );
  assert.equal(first.observation.consumed.requests, 6);
  assert.equal(first.observation.consumed.conditional_hits, 3);
  assert.ok(
    server.requests.every(
      (request) =>
        request.options.redirect === "error" &&
        request.options.headers.Authorization === "Bearer fixture-token",
    ),
  );
  const second = await observeUpstream(config, {
    fetch: server.fetch,
    cache: first.cache,
  });
  assert.equal(second.observation.facts_sha256, first.observation.facts_sha256);
  assert.equal(second.observation.consumed.response_bytes, 0);
  assert.equal(second.observation.consumed.conditional_hits, 6);
  server.replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body = [
    asset(2, "replacement bytes under the same asset identity"),
  ];
  const replaced = await observeUpstream(config, {
    fetch: server.fetch,
    cache: second.cache,
  });
  assert.notEqual(replaced.observation.facts_sha256, first.observation.facts_sha256);
  assert.equal(
    requiredFixture(requiredFixture(replaced.observation.facts.releases[0]).assets[0]).id,
    2,
  );
  server.replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body = [asset(3)];
  const changed = await observeUpstream(config, {
    fetch: server.fetch,
    cache: replaced.cache,
  });
  assert.equal(
    requiredFixture(requiredFixture(changed.observation.facts.releases[0]).assets[0]).id,
    3,
  );
  assert.notEqual(changed.observation.facts_sha256, replaced.observation.facts_sha256);
});

void test("traverses complete asset pagination and rejects partial, repeated or escaped pages", async () => {
  const server = fixture();
  const page = `${root}/releases/1/assets?per_page=100&page=1`;
  const next = `${root}/releases/1/assets?per_page=100&page=2`;
  server.replies.set(page, {
    body: Array.from({ length: 100 }, (_, index) => asset(index + 1)),
    link: `<${next}>; rel="next"`,
  });
  server.replies.set(next, { body: [asset(101)] });
  const complete = await observeUpstream(config, { fetch: server.fetch });
  assert.equal(requiredFixture(complete.observation.facts.releases[0]).assets.length, 101);
  server.replies.get(next).body = [asset(1)];
  await assert.rejects(
    observeUpstream(config, { fetch: server.fetch }),
    (error: unknown) => error instanceof ObservationFailure && error.rule === "pagination",
  );
  server.replies.get(page).body = [asset(1)];
  await assert.rejects(
    observeUpstream(config, { fetch: server.fetch }),
    /nonterminal page is incomplete/,
  );
  server.replies.get(page).link =
    '<https://foreign.invalid/private?per_page=100&page=2>; rel="next"';
  await assert.rejects(
    observeUpstream(config, { fetch: server.fetch }),
    /escaped its configured collection/,
  );
});

void test("partial reads and concurrent collection changes never advance the previous cache", async () => {
  const baseline = await observeUpstream(config, { fetch: fixture().fetch });
  const original = structuredClone(baseline.cache);
  const partial = fixture({
    intercept: (url) => (url.includes("/assets?") ? new Response(null, { status: 503 }) : null),
  });
  await assert.rejects(
    observeUpstream(config, {
      fetch: partial.fetch,
      cache: baseline.cache,
      sleep: async () => {},
    }),
    (error: unknown) => error instanceof ObservationFailure && error.rule === "provider-status",
  );
  assert.deepEqual(baseline.cache, original);
  const changing = fixture({
    intercept: (_url, _options, count, replies) => {
      if (count === 4) objectFixture(replies.get(root).body).archived = true;
    },
  });
  await assert.rejects(
    observeUpstream(config, { fetch: changing.fetch }),
    (error: unknown) => error instanceof ObservationFailure && error.rule === "concurrent-change",
  );
});

void test("unrelated GitHub counters do not invalidate exact observed release facts", async () => {
  const baseline = await observeUpstream(config, { fetch: fixture().fetch });
  const changing = fixture({
    intercept: (_url, _options, count, replies) => {
      if (count === 4) {
        objectFixture(replies.get(root).body).stargazers_count = 123;
        objectFixture(
          requiredFixture(
            arrayFixture(replies.get(`${root}/releases?per_page=100&page=1`).body)[0],
          ),
        ).body = "untrusted release prose changed";
        objectFixture(
          requiredFixture(
            arrayFixture(replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body)[0],
          ),
        ).download_count = 456;
      }
    },
  });
  const result = await observeUpstream(config, { fetch: changing.fetch });
  assert.equal(result.observation.facts_sha256, baseline.observation.facts_sha256);
  assert.equal(objectFixture(requiredFixture(result.cache.pages[root]).body).stargazers_count, 123);
  const changedAsset = fixture({
    intercept: (_url, _options, count, replies) => {
      if (count === 4)
        arrayFixture(replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body)[0] = asset(
          2,
          "changed artifact bytes",
        );
    },
  });
  await assert.rejects(
    observeUpstream(config, { fetch: changedAsset.fetch }),
    (error: unknown) => error instanceof ObservationFailure && error.rule === "concurrent-change",
  );
});

void test("rate limits defer to provider clocks and transport retries stay bounded", async () => {
  const limited = fixture({
    intercept: () => new Response(null, { status: 429, headers: { "retry-after": "120" } }),
  });
  await assert.rejects(
    observeUpstream(config, {
      fetch: limited.fetch,
      now: () => Date.parse(time),
    }),
    (error) =>
      error instanceof ObservationFailure &&
      error.rule === "rate-limit" &&
      error.retryAt === "2026-09-09T12:02:00.000Z",
  );
  assert.equal(limited.requests.length, 1);
  const delays: number[] = [];
  const broken = fixture({
    intercept: () => {
      throw new Error("untrusted transport detail");
    },
  });
  await assert.rejects(
    observeUpstream(config, {
      fetch: broken.fetch,
      sleep: async (ms) => delays.push(ms),
    }),
    (error: unknown) =>
      error instanceof ObservationFailure &&
      error.rule === "transport" &&
      !error.message.includes("untrusted"),
  );
  assert.equal(broken.requests.length, 3);
  assert.deepEqual(delays, [250, 500]);
});

void test("budgets, malformed metadata, cache corruption and repository drift fail closed", async () => {
  await assert.rejects(
    observeUpstream(
      { ...config, budget: { ...config.budget, requests: 2 } },
      { fetch: fixture().fetch },
    ),
    (error: unknown) => error instanceof ObservationFailure && error.rule === "budget",
  );
  await assert.rejects(
    observeUpstream(
      { ...config, budget: { ...config.budget, response_bytes: 1 } },
      { fetch: fixture().fetch },
    ),
    (error: unknown) => error instanceof ObservationFailure && error.rule === "budget",
  );
  const malformed = fixture();
  incrementFixtureId(malformed.replies.get(root).body);
  await assert.rejects(
    observeUpstream(config, { fetch: malformed.fetch }),
    (error: unknown) => error instanceof ObservationFailure && error.rule === "repository-identity",
  );
  objectFixture(malformed.replies.get(root).body).id = config.repository_id;
  objectFixture(
    requiredFixture(
      arrayFixture(malformed.replies.get(`${root}/releases?per_page=100&page=1`).body)[0],
    ),
  ).prerelease = "false";
  await assert.rejects(observeUpstream(config, { fetch: malformed.fetch }), /explicit booleans/);
  const baseline = await observeUpstream(config, { fetch: fixture().fetch });
  incrementFixtureId(requiredFixture(baseline.cache.pages[root]).body);
  await assert.rejects(
    observeUpstream(config, { fetch: fixture().fetch, cache: baseline.cache }),
    (error: unknown) => error instanceof ObservationFailure && error.rule === "invalid-cache",
  );
  assert.throws(
    () => validateObserverConfig({ ...config, arbitrary_scope: true }),
    /unexpected or missing fields/,
  );
});

void test("false prerelease flags and prerelease-only repositories remain observations for shared core policy", async () => {
  const server = fixture();
  server.replies.get(`${root}/releases?per_page=100&page=1`).body = [
    release(1, { tag_name: "1.1-rc5", prerelease: false }),
  ];
  const value = asset();
  value.browser_download_url = value.browser_download_url.replace("v1.0.0", "1.1-rc5");
  server.replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body = [value];
  const result = await observeUpstream(config, { fetch: server.fetch });
  assert.equal(requiredFixture(result.observation.facts.releases[0]).prerelease, false);
  assert.equal(requiredFixture(result.observation.facts.releases[0]).tag_name, "1.1-rc5");
  assert.equal(Object.hasOwn(result.observation, "eligible"), false);
  objectFixture(
    requiredFixture(
      arrayFixture(server.replies.get(`${root}/releases?per_page=100&page=1`).body)[0],
    ),
  ).prerelease = true;
  assert.equal(
    (await observeUpstream(config, { fetch: server.fetch })).observation.facts.releases.length,
    1,
  );
});

const project = async (observation: { facts_sha256: string }) => ({
  format: 1,
  port_id: config.port_id,
  repository_id: config.repository_id,
  facts_sha256: observation.facts_sha256,
  projections: [],
});

void test("malformed retained checkpoint fields fail before observing or projecting", async () => {
  const initial = await advanceObservation(config, null, { fetch: fixture().fetch, project });
  for (const patch of [{ first_complete_at: 42 }, { last_complete: false }, { exception: 0 }]) {
    await assert.rejects(
      advanceObservation(
        config,
        { ...initial.checkpoint, ...patch },
        {
          fetch: async () => assert.fail("malformed checkpoint reached provider"),
          project: () => assert.fail("malformed checkpoint reached Core projection"),
        },
      ),
      (error: unknown) =>
        error instanceof ObservationFailure && error.rule === "invalid-checkpoint",
    );
  }
});

void test("one checkpoint coordinator owns writes and interrupted locks are never stolen", async (t) => {
  await mkdir(fileURLToPath(new URL("../work", import.meta.url)), {
    recursive: true,
  });
  const directory = await mkdtemp(
    fileURLToPath(new URL("../work/observer-lock-test-", import.meta.url)),
  );
  t.after(() => rm(directory, { recursive: true }));
  const state = path.join(directory, "checkpoint.json");
  await withCheckpointLock(state, async () => {
    await assert.rejects(
      withCheckpointLock(state, () => assert.fail("second writer entered")),
      { code: "EEXIST" },
    );
  });
  await assert.rejects(
    withCheckpointLock(state, () => {
      throw new Error("interrupted operation");
    }),
    /interrupted operation/,
  );
  await withCheckpointLock(state, () => writeFile(state, "preserved snapshot"));
  await writeFile(`${state}.lock`, "interrupted coordinator evidence");
  await assert.rejects(
    withCheckpointLock(state, () => assert.fail("stale lock stolen")),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(state, "utf8"), "preserved snapshot");
});

void test("checkpoints preserve the last complete snapshot, deduplicate failures and expose stale unmonitored scope", async () => {
  let clock = Date.parse(time);
  const options = {
    fetch: fixture().fetch,
    project,
    now: () => clock,
    sleep: async () => {},
    catalogIds: [config.port_id, "unmonitored-port"],
  };
  const first = await advanceObservation(config, null, options);
  assert.equal(first.report.transition, "initial-baseline");
  assert.equal(first.report.stale, false);
  assert.deepEqual(first.report.unmonitored_port_ids, ["unmonitored-port"]);
  assert.equal(first.report.availability_objective.baseline, "unknown");
  assert.equal(first.report.clocks.compatible_client_availability_at, null);
  const original = structuredClone(first.checkpoint);
  clock += 13 * 3_600_000;
  const broken = fixture({
    intercept: () => new Response(null, { status: 503 }),
  });
  const failed = await advanceObservation(config, first.checkpoint, {
    ...options,
    fetch: broken.fetch,
  });
  assert.equal(failed.report.stale, true);
  assert.equal(failed.notify_exception, true);
  assert.deepEqual(first.checkpoint, original);
  assert.deepEqual(failed.checkpoint.last_complete, first.checkpoint.last_complete);
  assert.equal(
    requiredFixture(failed.report.fallback).facts_sha256,
    requiredFixture(first.report.observation).facts_sha256,
  );
  const repeated = await advanceObservation(config, failed.checkpoint, {
    ...options,
    fetch: broken.fetch,
  });
  assert.equal(repeated.notify_exception, false);
  assert.equal(requiredFixture(repeated.report.exception).occurrences, 2);
  assert.equal(
    requiredFixture(repeated.report.exception).first_seen,
    requiredFixture(failed.report.exception).first_seen,
  );
  const recovered = await advanceObservation(config, repeated.checkpoint, options);
  assert.equal(recovered.report.stale, false);
  assert.equal(recovered.report.transition, "unchanged");
  assert.equal(recovered.report.exception, null);
  assert.equal(recovered.checkpoint.completed_runs, 2);
});

void test("deferred checkpoints honor retry clocks without requests and mismatched core output cannot advance", async () => {
  let clock = Date.parse(time);
  const limited = fixture({
    intercept: () => new Response(null, { status: 429, headers: { "retry-after": "120" } }),
  });
  const options = { fetch: limited.fetch, project, now: () => clock };
  const first = await advanceObservation(config, null, options);
  const second = await advanceObservation(config, first.checkpoint, options);
  assert.equal(second.report.transition, "deferred");
  assert.equal(second.notify_exception, false);
  assert.equal(limited.requests.length, 1);
  clock += 120_000;
  const good = await advanceObservation(config, second.checkpoint, {
    ...options,
    fetch: fixture().fetch,
  });
  assert.equal(good.report.transition, "initial-baseline");
  const mismatch = await advanceObservation(config, good.checkpoint, {
    ...options,
    fetch: fixture().fetch,
    project: async (observation: { facts_sha256: string }) => ({
      ...(await project(observation)),
      facts_sha256: "wrong",
    }),
  });
  assert.equal(requiredFixture(mismatch.report.exception).rule, "core-binding");
  assert.equal(
    requiredFixture(mismatch.report.failed_policy_input).facts_sha256,
    observationHash(requiredFixture(mismatch.report.failed_policy_input).facts),
  );
  assert.deepEqual(mismatch.checkpoint.last_complete, good.checkpoint.last_complete);
  await assert.rejects(
    advanceObservation(config, { ...good.checkpoint, config_sha256: "wrong" }, options),
    (error: unknown) => error instanceof ObservationFailure && error.rule === "invalid-checkpoint",
  );
});

// #247 early slice: exact declared locations and six independent evidence roles.
const healthPin = {
  version: "v1",
  url: "https://downloads.example.com/package.zip",
  size: 42,
  sha256: "a".repeat(64),
};
interface HealthTestPort {
  id: string;
  project_url?: string;
  upstream_status?: string;
  release: { provider?: string; repository?: string; direct?: Record<string, typeof healthPin> };
}
interface HealthTestCatalog {
  source_catalog: {
    qualification: {
      scope: { port_id: string; artifact_sha256: string; upstream_ref: string };
      kind: string;
      outcome: string;
      evidence_ids: string[];
      method?: string;
    }[];
  };
  ports: HealthTestPort[];
}
const healthCatalog = (pin = healthPin): HealthTestCatalog => ({
  source_catalog: {
    qualification: [
      {
        scope: { port_id: "sample-port", artifact_sha256: "b".repeat(64), upstream_ref: "v0" },
        kind: "automated_lifecycle",
        outcome: "passed",
        evidence_ids: ["historical"],
      },
    ],
  },
  ports: [
    {
      id: "sample-port",
      project_url: "https://github.com/original/project",
      release: { provider: "direct-manifest", direct: { "windows-x86-64": { ...pin } } },
    },
  ],
});
const healthTime = Date.parse("2026-10-08T12:00:00Z");
const healthFetch: HealthFetch = async (url, _options) =>
  url.includes("/releases/tags/")
    ? new Response(
        JSON.stringify({ id: 3, tag_name: "v0", assets: [{ digest: `sha256:${"b".repeat(64)}` }] }),
        { headers: { "content-type": "application/json" } },
      )
    : url === healthPin.url
      ? new Response(null, { headers: { "content-length": String(healthPin.size) } })
      : new Response(JSON.stringify({ id: 1, full_name: "original/project", archived: false }), {
          headers: { "content-type": "application/json" },
        });

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
  assert.equal(requiredFixture(requiredFixture(stale.port_health[0]).canonical_incidents[0]).occurrences, 2);
  const altered = structuredClone(first);
  altered.catalog_sha256 = "f".repeat(64);
  assert.equal((await collect(healthTime + 1000, altered, 404)).material_changes.length, 0);
  altered.completed_at = new Date(healthTime + 2000).toISOString();
  await assert.rejects(collect(healthTime + 1000, altered, 404), /Invalid historical health comparison/);
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

interface HealthScopeFixture {
  id: string;
  summary: string;
  platforms: string[];
  adapter: string;
  project_url?: string;
  upstream_status?: string;
  source_profile?: string;
  release: {
    repository: string;
    provider?: string;
    sha256?: string;
    direct?: Record<string, typeof healthPin>;
  };
}
const healthScopePort = (id: string, repository = `owner/${id}`): HealthScopeFixture => ({
  id,
  summary: "A native port.",
  platforms: ["windows-x86-64"],
  release: { repository },
  adapter: "owned",
});
const healthScopeCatalog = <T,>(
  ...ports: T[]
): { schema_version: number; ports: T[]; source_catalog?: unknown } => ({
  schema_version: 2,
  ports,
});
const change = (file = "crates/portcove-core/catalog/catalog.json", extra = {}) => ({
  oldPath: file,
  newPath: file,
  status: "M",
  oldMode: "100644",
  newMode: "100644",
  ...extra,
});
const copy = <T,>(value: T): T => structuredClone(value);

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
  assert.deepEqual(
    (await selectUpstreamHealthScope(base, changedHistory, [change()])).port_ids,
    ["old"],
  );
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

// Generic monitoring tests use retained independent cases, not a changing live
// catalog/pin inventory. Explicit negative-policy cases still override this.
function collectRepositoryHealth(catalog: unknown, options: HealthOptions = {}) {
  return collectRepositoryHealthWithPolicy(catalog, { reviewedAccounting, ...options });
}

void test("live monitoring policy retains valid artifact and endpoint contract bindings", async () => {
  const policy = validateHealthAccountingPolicy(
    JSON.parse(
      await readFile(
        new URL("../.github/upstream-health-accounting.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const catalog: unknown = JSON.parse(
    await readFile(
      new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(isRecord(catalog) && Array.isArray(catalog.ports));
  assert.equal(policy.format_version, 2);
  const ports: unknown[] = catalog.ports;
  const portFor = (id: string) => {
    const port = requiredFixture(
      ports.find((value) => isRecord(value) && value.id === id),
    );
    assert.ok(isRecord(port), id);
    return port;
  };
  for (const rule of [...policy.pins, ...(policy.source_archives ?? [])])
    assert.equal(
      healthArtifactHash(portFor(rule.port_id), rule.platform),
      rule.port_contract_sha256,
      rule.port_id,
    );
  for (const rule of policy.original_conditions) {
    assert.ok(rule.role === "project" || rule.role === "acquisition");
    assert.equal(
      healthEndpointHash(portFor(rule.port_id), rule.role, rule.provider, rule.repository),
      rule.port_contract_sha256,
      rule.port_id,
    );
  }
});
const pinMetadata = pinCases.pins;
// Independently retained complete public provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1352788804,
    full_name: "alexbeavs-ps1-ports/armored-core-recomp",
    archived: false,
  },
  release: {
    id: 382786096,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:26Z",
    published_at: "2026-09-04T14:48:29Z",
    assets: [
      {
        id: 544444024,
        name: "Armored-Core-Recomp-0.3.6-linux-x64.zip",
        size: 28046282,
        state: "uploaded",
        digest: "sha256:a8bb86eb739f10653c39f8cb3c83b59d4d8a7b3b837ea7b580667868c6698e6a",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:19:50Z",
        updated_at: "2026-09-04T14:19:52Z",
      },
      {
        id: 544444106,
        name: "Armored-Core-Recomp-0.3.6-macos-arm64.zip",
        size: 25791499,
        state: "uploaded",
        digest: "sha256:83f4f37a9d35119d00eb8f015f29fb25f2d628977835e4ab04545a8271b45740",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:19:54Z",
        updated_at: "2026-09-04T14:19:56Z",
      },
      {
        id: 544444221,
        name: "Armored-Core-Recomp-0.3.6-macos-x64.zip",
        size: 26135526,
        state: "uploaded",
        digest: "sha256:99fe56d964b52d3d5c7fbd17cb8a5c655f76fef30fd4214d87ee212517fb5963",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:19:59Z",
        updated_at: "2026-09-04T14:20:00Z",
      },
      {
        id: 544444321,
        name: "Armored-Core-Recomp-0.3.6-windows-x64.zip",
        size: 30152526,
        state: "uploaded",
        digest: "sha256:43575a4795e5af42c3f545c245a073224d4e1a4643eaa59b3b2dba79c46e231e",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:20:03Z",
        updated_at: "2026-09-04T14:20:05Z",
      },
    ],
  },
  assets: [
    {
      id: 544444024,
      name: "Armored-Core-Recomp-0.3.6-linux-x64.zip",
      size: 28046282,
      state: "uploaded",
      digest: "sha256:a8bb86eb739f10653c39f8cb3c83b59d4d8a7b3b837ea7b580667868c6698e6a",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:19:50Z",
      updated_at: "2026-09-04T14:19:52Z",
    },
    {
      id: 544444106,
      name: "Armored-Core-Recomp-0.3.6-macos-arm64.zip",
      size: 25791499,
      state: "uploaded",
      digest: "sha256:83f4f37a9d35119d00eb8f015f29fb25f2d628977835e4ab04545a8271b45740",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:19:54Z",
      updated_at: "2026-09-04T14:19:56Z",
    },
    {
      id: 544444221,
      name: "Armored-Core-Recomp-0.3.6-macos-x64.zip",
      size: 26135526,
      state: "uploaded",
      digest: "sha256:99fe56d964b52d3d5c7fbd17cb8a5c655f76fef30fd4214d87ee212517fb5963",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:19:59Z",
      updated_at: "2026-09-04T14:20:00Z",
    },
    {
      id: 544444321,
      name: "Armored-Core-Recomp-0.3.6-windows-x64.zip",
      size: 30152526,
      state: "uploaded",
      digest: "sha256:43575a4795e5af42c3f545c245a073224d4e1a4643eaa59b3b2dba79c46e231e",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/armored-core-recomp/releases/download/v0.3.6/Armored-Core-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:20:03Z",
      updated_at: "2026-09-04T14:20:05Z",
    },
  ],
});
// Independently retained Blood Omen v0.3.6 provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1352791125,
    full_name: "alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp",
    archived: false,
  },
  release: {
    id: 382786113,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:26Z",
    published_at: "2026-09-04T14:48:30Z",
    assets: [
      {
        id: 544444045,
        name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-linux-x64.zip",
        size: 28049902,
        state: "uploaded",
        digest: "sha256:7cbef94c5fc72a1dd1ecaad2afe48a40faf2381e3bb579b2f7bbdfb3a74f80fc",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:19:51Z",
        updated_at: "2026-09-04T14:19:53Z",
      },
      {
        id: 544444163,
        name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-arm64.zip",
        size: 25793743,
        state: "uploaded",
        digest: "sha256:2554274350a93468cc7e120cfafb64553bc266d661aca56118989310898b369a",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:19:56Z",
        updated_at: "2026-09-04T14:19:58Z",
      },
      {
        id: 544444256,
        name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-x64.zip",
        size: 26139194,
        state: "uploaded",
        digest: "sha256:e126de5019ba1937a166912bde5f577be256429d8cabb219910f87e6d5c1887c",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:20:01Z",
        updated_at: "2026-09-04T14:20:02Z",
      },
      {
        id: 544444399,
        name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-windows-x64.zip",
        size: 30156064,
        state: "uploaded",
        digest: "sha256:8a829e5913943b45cf086416e15a4a614ad8ce5b8ca407bfb70736a4c68b1759",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:20:06Z",
        updated_at: "2026-09-04T14:20:07Z",
      },
    ],
  },
  assets: [
    {
      id: 544444045,
      name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-linux-x64.zip",
      size: 28049902,
      state: "uploaded",
      digest: "sha256:7cbef94c5fc72a1dd1ecaad2afe48a40faf2381e3bb579b2f7bbdfb3a74f80fc",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:19:51Z",
      updated_at: "2026-09-04T14:19:53Z",
    },
    {
      id: 544444163,
      name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-arm64.zip",
      size: 25793743,
      state: "uploaded",
      digest: "sha256:2554274350a93468cc7e120cfafb64553bc266d661aca56118989310898b369a",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:19:56Z",
      updated_at: "2026-09-04T14:19:58Z",
    },
    {
      id: 544444256,
      name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-x64.zip",
      size: 26139194,
      state: "uploaded",
      digest: "sha256:e126de5019ba1937a166912bde5f577be256429d8cabb219910f87e6d5c1887c",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:20:01Z",
      updated_at: "2026-09-04T14:20:02Z",
    },
    {
      id: 544444399,
      name: "Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-windows-x64.zip",
      size: 30156064,
      state: "uploaded",
      digest: "sha256:8a829e5913943b45cf086416e15a4a614ad8ce5b8ca407bfb70736a4c68b1759",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/blood-omen-legacy-of-kain-recomp/releases/download/v0.3.6/Blood-Omen-Legacy-of-Kain-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:20:06Z",
      updated_at: "2026-09-04T14:20:07Z",
    },
  ],
});
// Independently retained Digimon World 2003 v0.3.6 provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1352789057,
    full_name: "alexbeavs-ps1-ports/digimon-world-2003-recomp",
    archived: false,
  },
  release: {
    id: 382786572,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:29Z",
    published_at: "2026-09-04T14:48:39Z",
    assets: [
      {
        id: 544445063,
        name: "Digimon-World-2003-Recomp-0.3.6-linux-x64.zip",
        size: 28046744,
        state: "uploaded",
        digest: "sha256:0538611d06da652482d035a5b97f356bc4bbae18728a34d27712772bb557bae8",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:20:33Z",
        updated_at: "2026-09-04T14:20:37Z",
      },
      {
        id: 544445200,
        name: "Digimon-World-2003-Recomp-0.3.6-macos-arm64.zip",
        size: 25790678,
        state: "uploaded",
        digest: "sha256:d8c7adc1ae1737e76c625b46df1d3eab68de2f5cc33a94aff081c45ac1a97bb2",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:20:40Z",
        updated_at: "2026-09-04T14:20:42Z",
      },
      {
        id: 544445334,
        name: "Digimon-World-2003-Recomp-0.3.6-macos-x64.zip",
        size: 26136022,
        state: "uploaded",
        digest: "sha256:364cb136d8e435016b559feae8ecf0b895406897269263b8644b45954d13cfc3",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:20:45Z",
        updated_at: "2026-09-04T14:20:46Z",
      },
      {
        id: 544445450,
        name: "Digimon-World-2003-Recomp-0.3.6-windows-x64.zip",
        size: 30152631,
        state: "uploaded",
        digest: "sha256:71f0fe285fe0d6cd34d61e3b286bbdda55eecd551487b8ee33648301a99c249b",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:20:49Z",
        updated_at: "2026-09-04T14:20:51Z",
      },
    ],
  },
  assets: [
    {
      id: 544445063,
      name: "Digimon-World-2003-Recomp-0.3.6-linux-x64.zip",
      size: 28046744,
      state: "uploaded",
      digest: "sha256:0538611d06da652482d035a5b97f356bc4bbae18728a34d27712772bb557bae8",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:20:33Z",
      updated_at: "2026-09-04T14:20:37Z",
    },
    {
      id: 544445200,
      name: "Digimon-World-2003-Recomp-0.3.6-macos-arm64.zip",
      size: 25790678,
      state: "uploaded",
      digest: "sha256:d8c7adc1ae1737e76c625b46df1d3eab68de2f5cc33a94aff081c45ac1a97bb2",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:20:40Z",
      updated_at: "2026-09-04T14:20:42Z",
    },
    {
      id: 544445334,
      name: "Digimon-World-2003-Recomp-0.3.6-macos-x64.zip",
      size: 26136022,
      state: "uploaded",
      digest: "sha256:364cb136d8e435016b559feae8ecf0b895406897269263b8644b45954d13cfc3",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:20:45Z",
      updated_at: "2026-09-04T14:20:46Z",
    },
    {
      id: 544445450,
      name: "Digimon-World-2003-Recomp-0.3.6-windows-x64.zip",
      size: 30152631,
      state: "uploaded",
      digest: "sha256:71f0fe285fe0d6cd34d61e3b286bbdda55eecd551487b8ee33648301a99c249b",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/digimon-world-2003-recomp/releases/download/v0.3.6/Digimon-World-2003-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:20:49Z",
      updated_at: "2026-09-04T14:20:51Z",
    },
  ],
});
// Independently retained Duke Nukem: Land of the Babes v0.3.6 provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1352788290,
    full_name: "alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp",
    archived: false,
  },
  release: {
    id: 382786775,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:30Z",
    published_at: "2026-09-04T14:48:44Z",
    assets: [
      {
        id: 544445523,
        name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-linux-x64.zip",
        size: 28048314,
        state: "uploaded",
        digest: "sha256:46a9b69d869bb7ae868e1d8b9943ae6902b7ba81733f0afc957da8ae9692ebad",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:20:53Z",
        updated_at: "2026-09-04T14:20:54Z",
      },
      {
        id: 544445636,
        name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-arm64.zip",
        size: 25792070,
        state: "uploaded",
        digest: "sha256:89c1649003e66032bc44ff5ac60d1d6ae9b4bccaddf58b4156a16d71cbe4d8cb",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:20:57Z",
        updated_at: "2026-09-04T14:20:58Z",
      },
      {
        id: 544445706,
        name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-x64.zip",
        size: 26137531,
        state: "uploaded",
        digest: "sha256:5fc535897799e593c45090431f2c49da4c54e6fa194c9b8001ed0d41e95266e2",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:21:01Z",
        updated_at: "2026-09-04T14:21:02Z",
      },
      {
        id: 544445831,
        name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-windows-x64.zip",
        size: 30154371,
        state: "uploaded",
        digest: "sha256:33a2bf033dd610b8f6d8afab2373b609b536a1253f15b78138fc6d37a2831c5b",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:21:05Z",
        updated_at: "2026-09-04T14:21:07Z",
      },
    ],
  },
  assets: [
    {
      id: 544445523,
      name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-linux-x64.zip",
      size: 28048314,
      state: "uploaded",
      digest: "sha256:46a9b69d869bb7ae868e1d8b9943ae6902b7ba81733f0afc957da8ae9692ebad",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:20:53Z",
      updated_at: "2026-09-04T14:20:54Z",
    },
    {
      id: 544445636,
      name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-arm64.zip",
      size: 25792070,
      state: "uploaded",
      digest: "sha256:89c1649003e66032bc44ff5ac60d1d6ae9b4bccaddf58b4156a16d71cbe4d8cb",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:20:57Z",
      updated_at: "2026-09-04T14:20:58Z",
    },
    {
      id: 544445706,
      name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-x64.zip",
      size: 26137531,
      state: "uploaded",
      digest: "sha256:5fc535897799e593c45090431f2c49da4c54e6fa194c9b8001ed0d41e95266e2",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:21:01Z",
      updated_at: "2026-09-04T14:21:02Z",
    },
    {
      id: 544445831,
      name: "Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-windows-x64.zip",
      size: 30154371,
      state: "uploaded",
      digest: "sha256:33a2bf033dd610b8f6d8afab2373b609b536a1253f15b78138fc6d37a2831c5b",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-land-of-the-babes-recomp/releases/download/v0.3.6/Duke-Nukem-Land-of-the-Babes-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:21:05Z",
      updated_at: "2026-09-04T14:21:07Z",
    },
  ],
});
// Independently retained Driver v0.3.6 provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1352790121,
    full_name: "alexbeavs-ps1-ports/driver-recomp",
    archived: false,
  },
  release: {
    id: 382786594,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:29Z",
    published_at: "2026-09-04T14:48:39Z",
    assets: [
      {
        id: 544445102,
        name: "Driver-Recomp-0.3.6-linux-x64.zip",
        size: 28047869,
        state: "uploaded",
        digest: "sha256:35bb94181910a9fed63e48ef0e0bcc1e569befc9e19925c0bf29f12b0fabc7cd",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:20:35Z",
        updated_at: "2026-09-04T14:20:37Z",
      },
      {
        id: 544445190,
        name: "Driver-Recomp-0.3.6-macos-arm64.zip",
        size: 25793364,
        state: "uploaded",
        digest: "sha256:b89e64216bc74505762eb9bf79cffe21415080aeb086ec70126f8bb965b64180",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:20:40Z",
        updated_at: "2026-09-04T14:20:41Z",
      },
      {
        id: 544445319,
        name: "Driver-Recomp-0.3.6-macos-x64.zip",
        size: 26138386,
        state: "uploaded",
        digest: "sha256:4ec37fa02646e44787ea0c4b2c8fe857fc0d0caa501615f0301b01f0d7b9b14b",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:20:44Z",
        updated_at: "2026-09-04T14:20:46Z",
      },
      {
        id: 544445443,
        name: "Driver-Recomp-0.3.6-windows-x64.zip",
        size: 30154093,
        state: "uploaded",
        digest: "sha256:57d50b4065b1b680cb660029bb14db3f53d911516342e58fc16f59386aeba2ab",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:20:48Z",
        updated_at: "2026-09-04T14:20:50Z",
      },
    ],
  },
  assets: [
    {
      id: 544445102,
      name: "Driver-Recomp-0.3.6-linux-x64.zip",
      size: 28047869,
      state: "uploaded",
      digest: "sha256:35bb94181910a9fed63e48ef0e0bcc1e569befc9e19925c0bf29f12b0fabc7cd",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:20:35Z",
      updated_at: "2026-09-04T14:20:37Z",
    },
    {
      id: 544445190,
      name: "Driver-Recomp-0.3.6-macos-arm64.zip",
      size: 25793364,
      state: "uploaded",
      digest: "sha256:b89e64216bc74505762eb9bf79cffe21415080aeb086ec70126f8bb965b64180",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:20:40Z",
      updated_at: "2026-09-04T14:20:41Z",
    },
    {
      id: 544445319,
      name: "Driver-Recomp-0.3.6-macos-x64.zip",
      size: 26138386,
      state: "uploaded",
      digest: "sha256:4ec37fa02646e44787ea0c4b2c8fe857fc0d0caa501615f0301b01f0d7b9b14b",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:20:44Z",
      updated_at: "2026-09-04T14:20:46Z",
    },
    {
      id: 544445443,
      name: "Driver-Recomp-0.3.6-windows-x64.zip",
      size: 30154093,
      state: "uploaded",
      digest: "sha256:57d50b4065b1b680cb660029bb14db3f53d911516342e58fc16f59386aeba2ab",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/driver-recomp/releases/download/v0.3.6/Driver-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:20:48Z",
      updated_at: "2026-09-04T14:20:50Z",
    },
  ],
});
// Independently retained Duke Nukem: Time to Kill v0.3.6 provider metadata; no accepted-byte claim.
pinMetadata.push({
  repository: {
    id: 1350730805,
    full_name: "alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp",
    archived: false,
  },
  release: {
    id: 382786779,
    tag_name: "v0.3.6",
    draft: false,
    prerelease: false,
    created_at: "2026-09-04T11:49:31Z",
    published_at: "2026-09-04T14:48:44Z",
    assets: [
      {
        id: 544445527,
        name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-linux-x64.zip",
        size: 28051653,
        state: "uploaded",
        digest: "sha256:c2b421fe2214efecd6736d3f95636b44a6562f459965c7aee098b5cdebaeb1f3",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-linux-x64.zip",
        created_at: "2026-09-04T14:20:53Z",
        updated_at: "2026-09-04T14:20:54Z",
      },
      {
        id: 544445640,
        name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-arm64.zip",
        size: 25795533,
        state: "uploaded",
        digest: "sha256:71481804b16e433688c43625556222fe79561e956bc5ed905911cb23644ee1d5",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-arm64.zip",
        created_at: "2026-09-04T14:20:57Z",
        updated_at: "2026-09-04T14:20:59Z",
      },
      {
        id: 544445718,
        name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-x64.zip",
        size: 26140959,
        state: "uploaded",
        digest: "sha256:e41aa8968e70c12c993561a671ccc08d64c2ff7d17fd6c1a0d3980389f86708f",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-x64.zip",
        created_at: "2026-09-04T14:21:01Z",
        updated_at: "2026-09-04T14:21:03Z",
      },
      {
        id: 544445845,
        name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-windows-x64.zip",
        size: 30158026,
        state: "uploaded",
        digest: "sha256:6ac51ddf4db437fd10ec8ec1de73b66e34904b9b30bbcaf813266dba2997c662",
        browser_download_url:
          "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-windows-x64.zip",
        created_at: "2026-09-04T14:21:05Z",
        updated_at: "2026-09-04T14:21:07Z",
      },
    ],
  },
  assets: [
    {
      id: 544445527,
      name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-linux-x64.zip",
      size: 28051653,
      state: "uploaded",
      digest: "sha256:c2b421fe2214efecd6736d3f95636b44a6562f459965c7aee098b5cdebaeb1f3",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-linux-x64.zip",
      created_at: "2026-09-04T14:20:53Z",
      updated_at: "2026-09-04T14:20:54Z",
    },
    {
      id: 544445640,
      name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-arm64.zip",
      size: 25795533,
      state: "uploaded",
      digest: "sha256:71481804b16e433688c43625556222fe79561e956bc5ed905911cb23644ee1d5",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-arm64.zip",
      created_at: "2026-09-04T14:20:57Z",
      updated_at: "2026-09-04T14:20:59Z",
    },
    {
      id: 544445718,
      name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-x64.zip",
      size: 26140959,
      state: "uploaded",
      digest: "sha256:e41aa8968e70c12c993561a671ccc08d64c2ff7d17fd6c1a0d3980389f86708f",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-macos-x64.zip",
      created_at: "2026-09-04T14:21:01Z",
      updated_at: "2026-09-04T14:21:03Z",
    },
    {
      id: 544445845,
      name: "Duke-Nukem-Time-to-Kill-Recomp-0.3.6-windows-x64.zip",
      size: 30158026,
      state: "uploaded",
      digest: "sha256:6ac51ddf4db437fd10ec8ec1de73b66e34904b9b30bbcaf813266dba2997c662",
      browser_download_url:
        "https://github.com/alexbeavs-ps1-ports/duke-nukem-time-to-kill-recomp/releases/download/v0.3.6/Duke-Nukem-Time-to-Kill-Recomp-0.3.6-windows-x64.zip",
      created_at: "2026-09-04T14:21:05Z",
      updated_at: "2026-09-04T14:21:07Z",
    },
  ],
});
pinMetadata.push(fadePin);
const currentHealthCatalog = accountingCases.catalog;
const accountingCatalog = () => ({
  ports: structuredClone(
    currentHealthCatalog.ports.filter((port) =>
      [...reviewedAccounting.pins, ...reviewedAccounting.original_conditions].some(
        (rule) => rule.port_id === port.id,
      ),
    ),
  ),
});

interface AccountingReply {
  status?: number;
  data: unknown;
  headers?: Record<string, string>;
}
type HealthCall = { url: string; options: HealthRequestOptions };
function accountingFetch(
  calls: HealthCall[],
  mutate: (url: string, response: AccountingReply) => AccountingReply = (_url, response) =>
    response,
): HealthFetch {
  return async (url, options) => {
    calls.push({ url, options });
    let response: AccountingReply | undefined;
    const pin = reviewedAccounting.pins.find((rule) => rule.url === url);
    const condition = reviewedAccounting.original_conditions.find(
      (rule) => url === `https://api.github.com/repos/${rule.repository}`,
    );
    if (pin)
      response = {
        status: 302,
        data: null,
        headers: { location: "https://example.invalid/signed?secret=synthetic-private-value" },
      };
    else if (condition)
      response = {
        status: condition.http_status,
        data:
          condition.http_status === 301
            ? {
                message: "Moved Permanently",
                url: `https://api.github.com/repositories/${condition.redirect_repository_id}`,
              }
            : { message: "Not Found" },
      };
    else {
      for (let i = 0; i < reviewedAccounting.pins.length; i++) {
        const rule = requiredFixture(reviewedAccounting.pins[i]),
          fixture = requiredFixture(pinMetadata[i]),
          prefix = `https://api.github.com/repos/${rule.repository}`;
        if (url === prefix) response = { data: structuredClone(fixture.repository) };
        else if (url === `${prefix}/releases/tags/${encodeURIComponent(rule.tag)}`)
          response = { data: structuredClone(fixture.release) };
        else if (url === `${prefix}/releases/${rule.release_id}/assets?per_page=100`)
          response = { data: structuredClone(fixture.assets) };
      }
    }
    assert.ok(response, `unexpected fixed request ${url}`);
    response = mutate(url, response);
    return new Response(response.data === null ? null : JSON.stringify(response.data), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json", ...response.headers },
    });
  };
}

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

const capacityPort = (id: string) => ({
  id,
  release: { provider: "github", repository: `fixture/${id}` },
});
const capacityFetch =
  (calls: HealthCall[]): HealthFetch =>
  async (url, options) => {
    calls.push({ url, options });
    return new Response(
      JSON.stringify({
        id: 42,
        full_name: url.slice("https://api.github.com/repos/".length),
        archived: false,
      }),
      { headers: { "content-type": "application/json" } },
    );
  };

void test("validated forecasts admit 319/320 and refuse 321 before any network I/O", async () => {
  for (const count of [319, 320, 321]) {
    const catalog = {
      ports: Array.from({ length: count }, (_, i) => capacityPort(`boundary-${i}`)),
    };
    const calls: { url: string; options: HealthRequestOptions }[] = [];
    const report = await collectRepositoryHealth(catalog, {
      fetch: capacityFetch(calls),
      now: () => 0,
    });
    assert.equal(report.request_plan.conservative_requests, count);
    assert.equal(report.request_plan.hard_ceiling, 320);
    assert.equal(report.request_plan.status, count > 320 ? "overflow" : "admitted");
    assert.equal(report.limits.requests, count > 320 ? 0 : count);
    assert.equal(calls.length, count > 320 ? 0 : count);
    assert.equal(report.consumed.requests, calls.length);
    assert.equal(report.observations.length, count);
    assert.equal(report.port_health.length, count);
    assert.equal(report.coverage.repositories, count);
    assert.equal(report.scope.mode, "full");
    if (count > 320) {
      assert.equal(report.outcome, "incomplete");
      assert.equal(report.scope.global_health, "not assessed");
      assert.ok(
        report.observations.every((r) => !r.attempted && !r.accounted_for && r.reason === "budget"),
      );
      assert.match(
        renderRepositoryHealth(report),
        /Preflight overflow: no live requests permitted/,
      );
    } else assert.equal(report.outcome, "complete");
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

void test("overflow preserves static missing-release and conflicting-identity classifications", async () => {
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
      ...Array.from({ length: 319 }, (_, i) => capacityPort(`mixed-${i}`)),
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
  const report = await collectRepositoryHealth(catalog, {
    fetch: () => assert.fail("Overflow must not fetch"),
    now: () => 0,
  });
  assert.equal(report.request_plan.conservative_requests, 321);
  assert.equal(report.limits.requests, 0);
  assert.equal(report.observations.length, 322);
  assert.equal(report.coverage.monitored_ports, 321);
  assert.equal(
    requiredFixture(report.observations.find((r) => r.provider === "unlocated-historical")).reason,
    "release-identity-unavailable",
  );
  assert.equal(
    requiredFixture(report.observations.find((r) => r.repository.endsWith("conflicting.zip")))
      .reason,
    "identity-mismatch",
  );
  assert.ok(report.observations.every((r) => !r.attempted && !r.accounted_for));
});

void test("malformed inventories refuse before requests and prior-report bounds remain independently 512", async () => {
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
      if (count > 512) {
        await assert.rejects(collectRepositoryHealth(catalog, {
          previousReport: prior, fetch: fetch404,
        }), /Invalid historical health comparison/);
        continue;
      }
      const report = await collectRepositoryHealth(catalog, {
        previousReport: prior,
        fetch: fetch404,
      });
      assert.equal(
        report.previous_report,
        count === 512 ? "matching observation history" : "mismatched or incomplete; not reused",
        field,
      );
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

function sourceArchiveFixture(parents = ["3".repeat(40), "4".repeat(40)]) {
  const repository = { id: 567, full_name: "fixture/source", archived: false };
  const sha = "1".repeat(40),
    tree = "2".repeat(40);
  const api = `https://api.github.com/repos/${repository.full_name}/git`;
  const html = `https://github.com/${repository.full_name}/commit`;
  const commit = {
    sha,
    url: `${api}/commits/${sha}`,
    html_url: `${html}/${sha}`,
    tree: { sha: tree, url: `${api}/trees/${tree}` },
    parents: parents.map((value) => ({
      sha: value,
      url: `${api}/commits/${value}`,
      html_url: `${html}/${value}`,
    })),
  };
  const port = {
    id: "source-archive",
    project_url: `https://github.com/${repository.full_name}`,
    release: {
      provider: "direct-manifest",
      direct: {
        windows: {
          url: `https://github.com/${repository.full_name}/archive/${sha}.zip`,
          version: "source-pinned",
          size: 10,
          sha256: "a".repeat(64),
        },
      },
    },
  };
  const scope = {
    port_id: port.id,
    port_contract_sha256: observationHash(port),
    platform: "windows",
    ...port.release.direct.windows,
    repository: repository.full_name,
    repository_id: repository.id,
    archived: false,
    commit_sha: sha,
    tree_sha: tree,
    commit_facts_sha256: observationHash({ sha, tree_sha: tree, parents }),
  };
  const { version: _version, ...rule } = scope;
  return { repository, commit, port, rule, api: api.slice(0, -4) };
}
function sourceArchivePolicy(fixture = sourceArchiveFixture()) {
  return {
    format_version: 1,
    authority: "fixture metadata only",
    decision: "independent synthetic case",
    pins: [],
    original_conditions: [],
    source_archives: [structuredClone(fixture.rule)],
  };
}
function sourceArchiveFetch(
  fixture: ReturnType<typeof sourceArchiveFixture>,
  calls: HealthCall[],
): HealthFetch {
  return async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "manual");
    if (url === fixture.rule.url) {
      assert.equal(options.method, "HEAD");
      assert.equal(options.headers.Authorization, undefined);
      return new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.invalid/private-signed-url" },
      });
    }
    const body =
      url === fixture.api
        ? fixture.repository
        : url === `${fixture.api}/git/commits/${fixture.rule.commit_sha}`
          ? fixture.commit
          : null;
    assert.ok(body, `unexpected source metadata request ${url}`);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
}
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

void test("source archive conditional reads participate in zero-I/O forecast overflow", async () => {
  const fixture = sourceArchiveFixture();
  const report = await collectRepositoryHealthWithPolicy(
    {
      ports: [
        fixture.port,
        ...Array.from({ length: 317 }, (_, i) => capacityPort(`archive-capacity-${i}`)),
      ],
    },
    {
      reviewedAccounting: sourceArchivePolicy(fixture),
      now: () => 0,
      fetch: () => assert.fail("321-call archive forecast must refuse every request"),
    },
  );
  assert.equal(report.request_plan.conservative_requests, 321);
  assert.equal(report.request_plan.conditional_archive_requests, 2);
  assert.equal(report.limits.requests, 0);
  assert.equal(report.consumed.requests, 0);
  assert.equal(report.scope.global_health, "not assessed");
  assert.equal(report.observations.length, 319);
  assert.ok(report.observations.every((r) => !r.attempted && !r.accounted_for));
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
