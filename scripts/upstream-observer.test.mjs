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
} from "./upstream-observer.mjs";
import { advanceObservation, withCheckpointLock } from "./observe-configured-upstream.mjs";
import { collectRepositoryHealth, renderRepositoryHealth } from "./check-catalog-repositories.mjs";
import { discoverUpstreamHealthScope, selectUpstreamHealthScope } from "./upstream-health-plan.mjs";

const config = JSON.parse(
  await readFile(new URL("../release/upstream-observer.json", import.meta.url), "utf8"),
);

test("the compiled CLI fixture uses the same canonical facts digest", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../crates/portcove-cli/tests/fixtures/upstream-observation.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(observationHash(fixture.facts), fixture.facts_sha256);
});

test("scheduled observation keeps the configured cadence, read-only authority and bounded recovery cache", async () => {
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

function fixture(overrides = {}) {
  const replies = new Map([
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
  const requests = [];
  const fetch = async (url, options) => {
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

test("records exact release and asset facts, conditional cache and changed fixture artifacts", async () => {
  const server = fixture();
  const first = await observeUpstream(config, {
    fetch: server.fetch,
    token: "fixture-token",
  });
  assert.equal(first.observation.authority, "provider-observation-only");
  assert.equal(first.observation.facts.releases[0].assets[0].id, 2);
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
  assert.equal(replaced.observation.facts.releases[0].assets[0].id, 2);
  server.replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body = [asset(3)];
  const changed = await observeUpstream(config, {
    fetch: server.fetch,
    cache: replaced.cache,
  });
  assert.equal(changed.observation.facts.releases[0].assets[0].id, 3);
  assert.notEqual(changed.observation.facts_sha256, replaced.observation.facts_sha256);
});

test("traverses complete asset pagination and rejects partial, repeated or escaped pages", async () => {
  const server = fixture();
  const page = `${root}/releases/1/assets?per_page=100&page=1`;
  const next = `${root}/releases/1/assets?per_page=100&page=2`;
  server.replies.set(page, {
    body: Array.from({ length: 100 }, (_, index) => asset(index + 1)),
    link: `<${next}>; rel="next"`,
  });
  server.replies.set(next, { body: [asset(101)] });
  const complete = await observeUpstream(config, { fetch: server.fetch });
  assert.equal(complete.observation.facts.releases[0].assets.length, 101);
  server.replies.get(next).body = [asset(1)];
  await assert.rejects(
    observeUpstream(config, { fetch: server.fetch }),
    (error) => error.rule === "pagination",
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

test("partial reads and concurrent collection changes never advance the previous cache", async () => {
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
    (error) => error.rule === "provider-status",
  );
  assert.deepEqual(baseline.cache, original);
  const changing = fixture({
    intercept: (_url, _options, count, replies) => {
      if (count === 4) replies.get(root).body.archived = true;
    },
  });
  await assert.rejects(
    observeUpstream(config, { fetch: changing.fetch }),
    (error) => error.rule === "concurrent-change",
  );
});

test("unrelated GitHub counters do not invalidate exact observed release facts", async () => {
  const baseline = await observeUpstream(config, { fetch: fixture().fetch });
  const changing = fixture({
    intercept: (_url, _options, count, replies) => {
      if (count === 4) {
        replies.get(root).body.stargazers_count = 123;
        replies.get(`${root}/releases?per_page=100&page=1`).body[0].body =
          "untrusted release prose changed";
        replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body[0].download_count = 456;
      }
    },
  });
  const result = await observeUpstream(config, { fetch: changing.fetch });
  assert.equal(result.observation.facts_sha256, baseline.observation.facts_sha256);
  assert.equal(result.cache.pages[root].body.stargazers_count, 123);
  const changedAsset = fixture({
    intercept: (_url, _options, count, replies) => {
      if (count === 4)
        replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body[0] = asset(
          2,
          "changed artifact bytes",
        );
    },
  });
  await assert.rejects(
    observeUpstream(config, { fetch: changedAsset.fetch }),
    (error) => error.rule === "concurrent-change",
  );
});

test("rate limits defer to provider clocks and transport retries stay bounded", async () => {
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
  const delays = [];
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
    (error) => error.rule === "transport" && !error.message.includes("untrusted"),
  );
  assert.equal(broken.requests.length, 3);
  assert.deepEqual(delays, [250, 500]);
});

test("budgets, malformed metadata, cache corruption and repository drift fail closed", async () => {
  await assert.rejects(
    observeUpstream(
      { ...config, budget: { ...config.budget, requests: 2 } },
      { fetch: fixture().fetch },
    ),
    (error) => error.rule === "budget",
  );
  await assert.rejects(
    observeUpstream(
      { ...config, budget: { ...config.budget, response_bytes: 1 } },
      { fetch: fixture().fetch },
    ),
    (error) => error.rule === "budget",
  );
  const malformed = fixture();
  malformed.replies.get(root).body.id++;
  await assert.rejects(
    observeUpstream(config, { fetch: malformed.fetch }),
    (error) => error.rule === "repository-identity",
  );
  malformed.replies.get(root).body.id = config.repository_id;
  malformed.replies.get(`${root}/releases?per_page=100&page=1`).body[0].prerelease = "false";
  await assert.rejects(observeUpstream(config, { fetch: malformed.fetch }), /explicit booleans/);
  const baseline = await observeUpstream(config, { fetch: fixture().fetch });
  baseline.cache.pages[root].body.id++;
  await assert.rejects(
    observeUpstream(config, { fetch: fixture().fetch, cache: baseline.cache }),
    (error) => error.rule === "invalid-cache",
  );
  assert.throws(
    () => validateObserverConfig({ ...config, arbitrary_scope: true }),
    /unexpected or missing fields/,
  );
});

test("false prerelease flags and prerelease-only repositories remain observations for shared core policy", async () => {
  const server = fixture();
  server.replies.get(`${root}/releases?per_page=100&page=1`).body = [
    release(1, { tag_name: "1.1-rc5", prerelease: false }),
  ];
  const value = asset();
  value.browser_download_url = value.browser_download_url.replace("v1.0.0", "1.1-rc5");
  server.replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body = [value];
  const result = await observeUpstream(config, { fetch: server.fetch });
  assert.equal(result.observation.facts.releases[0].prerelease, false);
  assert.equal(result.observation.facts.releases[0].tag_name, "1.1-rc5");
  assert.equal(Object.hasOwn(result.observation, "eligible"), false);
  server.replies.get(`${root}/releases?per_page=100&page=1`).body[0].prerelease = true;
  assert.equal(
    (await observeUpstream(config, { fetch: server.fetch })).observation.facts.releases.length,
    1,
  );
});

const project = async (observation) => ({
  format: 1,
  port_id: config.port_id,
  repository_id: config.repository_id,
  facts_sha256: observation.facts_sha256,
  projections: [],
});

test("one checkpoint coordinator owns writes and interrupted locks are never stolen", async (t) => {
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

test("checkpoints preserve the last complete snapshot, deduplicate failures and expose stale unmonitored scope", async () => {
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
  assert.equal(failed.report.fallback.facts_sha256, first.report.observation.facts_sha256);
  const repeated = await advanceObservation(config, failed.checkpoint, {
    ...options,
    fetch: broken.fetch,
  });
  assert.equal(repeated.notify_exception, false);
  assert.equal(repeated.report.exception.occurrences, 2);
  assert.equal(repeated.report.exception.first_seen, failed.report.exception.first_seen);
  const recovered = await advanceObservation(config, repeated.checkpoint, options);
  assert.equal(recovered.report.stale, false);
  assert.equal(recovered.report.transition, "unchanged");
  assert.equal(recovered.report.exception, null);
  assert.equal(recovered.checkpoint.completed_runs, 2);
});

test("deferred checkpoints honor retry clocks without requests and mismatched core output cannot advance", async () => {
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
    project: async (observation) => ({
      ...(await project(observation)),
      facts_sha256: "wrong",
    }),
  });
  assert.equal(mismatch.report.exception.rule, "core-binding");
  assert.equal(
    mismatch.report.failed_policy_input.facts_sha256,
    observationHash(mismatch.report.failed_policy_input.facts),
  );
  assert.deepEqual(mismatch.checkpoint.last_complete, good.checkpoint.last_complete);
  await assert.rejects(
    advanceObservation(config, { ...good.checkpoint, config_sha256: "wrong" }, options),
    (error) => error.rule === "invalid-checkpoint",
  );
});

// #247 early slice: exact declared locations and six independent evidence roles.
const healthPin = {
  version: "v1",
  url: "https://downloads.example.com/package.zip",
  size: 42,
  sha256: "a".repeat(64),
};
const healthCatalog = (pin = healthPin) => ({
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
const healthFetch = async (url, _options) =>
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

test("direct provider preserves original upstream and scopes HEAD separately from exact accepted bytes", async () => {
  const calls = [];
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
  const [health] = report.port_health;
  assert.equal(health.original_upstream.status, "reachable");
  assert.equal(health.lineage.status, "unresolved");
  assert.equal(health.lineage.successor_selected, false);
  assert.equal(health.accepted_artifact_obtainability.status, "unknown");
  assert.equal(health.accepted_artifact_obtainability.identities[0].sha256, healthPin.sha256);
  assert.equal(health.preservation.status, "unknown");
  assert.equal(health.applicable_holds.status, "unknown");
  assert.equal(health.qualification.records[0].scope.artifact_sha256, "b".repeat(64));
  assert.equal(health.qualification.inherited, false);
  assert.match(renderRepositoryHealth(report), /direct-manifest ports included/);
  assert.match(renderRepositoryHealth(report), /Accepted bytes remain unverified/);
  assert.doesNotMatch(JSON.stringify(report), /private-token|private-gitlab/);
});

test("direct endpoint corruption, unavailable headers and redirects remain unknown rather than verified artifacts", async () => {
  for (const headers of [{}, { "content-length": "41" }, { "content-length": "42junk" }]) {
    const report = await collectRepositoryHealth(healthCatalog(), {
      now: () => healthTime,
      fetch: async (url, options) =>
        url === healthPin.url ? new Response(null, { headers }) : healthFetch(url, options),
    });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.observations[0].reason, "invalid-metadata");
    assert.equal(report.port_health[0].accepted_artifact_obtainability.status, "unknown");
  }
  const report = await collectRepositoryHealth(healthCatalog(), {
    now: () => healthTime,
    fetch: async (url, options) =>
      url === healthPin.url ? new Response(null, { status: 302 }) : healthFetch(url, options),
  });
  assert.equal(report.observations[0].reason, "provider-redirect");
});

test("redirects remain distinct unknown HTTP facts without following or retaining their destinations", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls = [];
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
    const direct = calls.find(({ url }) => url === healthPin.url);
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
      assert.match(observation.resume_condition, /no redirect was followed/);
    }
    assert.ok(
      report.port_health[0].canonical_incidents.every(
        (incident) => incident.rule === "provider-redirect" && !incident.accounted_for,
      ),
    );
    assert.match(renderRepositoryHealth(report), new RegExp(`provider-redirect; HTTP ${status}`));
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.ok(!JSON.stringify(report).includes("private-token"));
  }
});

test("transport failures and nonredirect provider statuses do not become redirect observations", async () => {
  const input = { ports: [{ id: "original", release: { repository: "owner/original" } }] };
  for (const [status, reason] of [
    [404, "inaccessible-or-missing"],
    [503, "provider-error"],
    [304, "provider-status"],
  ]) {
    const report = await collectRepositoryHealth(input, {
      fetch: async () => new Response(null, { status }),
    });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.observations[0].reason, reason);
    assert.equal(report.observations[0].http_status, status);
  }
  const transport = await collectRepositoryHealth(input, {
    fetch: async () => {
      throw new Error("private-network-details");
    },
  });
  assert.equal(transport.outcome, "incomplete");
  assert.equal(transport.observations[0].reason, "transport");
  assert.equal(transport.observations[0].http_status, null);
  assert.ok(!JSON.stringify(transport).includes("private-network-details"));
});

test("partial direct inventory never becomes an empty or healthy collection", async () => {
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

test("incident identity is stable across observation times while changed rules create distinct conditions", async () => {
  const collect = (time, status) =>
    collectRepositoryHealth(healthCatalog(), {
      now: () => time,
      fetch: async (url, options) =>
        url === healthPin.url ? new Response(null, { status }) : healthFetch(url, options),
    });
  const first = await collect(healthTime, 404);
  const repeated = await collect(healthTime + 60_000, 404);
  const changed = await collect(healthTime + 60_000, 401);
  const incident = (report) => report.port_health[0].canonical_incidents[0];
  assert.equal(incident(first).key, incident(repeated).key);
  assert.notEqual(incident(first).observed_at, incident(repeated).observed_at);
  assert.notEqual(incident(first).key, incident(changed).key);
  assert.match(incident(first).resume_condition, /404 does not establish deletion or succession/);
  assert.equal(first.port_health[0].lineage.successor_selected, false);
});

test("non-hosted original project remains monitored after a provider change", async () => {
  const input = healthCatalog();
  input.ports[0].project_url = "https://original.example.com/";
  const calls = [];
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
  assert.equal(report.port_health[0].original_upstream.status, "reachable");
  assert.equal(report.port_health[0].lineage.status, "unresolved");
});

test("rate limits defer only the affected direct origin and preserve other acquisition locations", async () => {
  const input = healthCatalog();
  input.ports[0].release.direct.linux = {
    ...healthPin,
    url: "https://downloads.example.com/linux.zip",
  };
  input.ports[0].release.direct.macos = {
    ...healthPin,
    url: "https://other.example.com/package.zip",
  };
  const calls = [];
  const report = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: async (url, options) => {
      calls.push(url);
      if (url === healthPin.url)
        return new Response(null, { status: 429, headers: { "retry-after": "120" } });
      if (url.startsWith("https://other.example.com/"))
        return new Response(null, { headers: { "content-length": "42" } });
      return healthFetch(url, options);
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(report.observations[1].attempted, false);
  assert.equal(report.observations[1].retry_at, new Date(healthTime + 120_000).toISOString());
  assert.equal(report.observations[2].status, "reachable");
  assert.equal(report.port_health[0].accepted_artifact_obtainability.locations.length, 5);
});

test("contradictory immutable pins at one location stay prominent without selecting an authority", async () => {
  const input = healthCatalog();
  input.ports[0].release.direct.linux = { ...healthPin, sha256: "c".repeat(64) };
  const report = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: healthFetch,
  });
  assert.equal(report.observations[0].reason, "identity-mismatch");
  assert.equal(report.observations[0].attempted, false);
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.port_health[0].accepted_artifact_obtainability.identities.length, 2);
  assert.equal(report.port_health[0].applicable_holds.status, "unknown");
});

test("retained Star Fox failure is an unresolved availability condition with no historical qualification transfer", async () => {
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
  const repository = incident.stderr.split(": ")[0];
  const report = await collectRepositoryHealth(
    {
      ports: [{ id: "star-fox-enhanced", release: { repository } }],
    },
    { now: () => healthTime, fetch: async () => new Response(null, { status: 404 }) },
  );
  const [health] = report.port_health;
  assert.equal(report.outcome, "incomplete");
  assert.equal(health.original_upstream.status, "unknown");
  assert.equal(health.canonical_incidents[0].http_status, 404);
  assert.equal(health.canonical_incidents[0].rule, "inaccessible-or-missing");
  assert.equal(health.lineage.owner_issue, incident.lineage_issue);
  assert.equal(health.lineage.status, "unresolved");
  assert.equal(health.lineage.successor_selected, false);
  assert.deepEqual(health.qualification.records, []);
  assert.equal(health.qualification.inherited, false);
});

test("hosted relocation keeps original upstream distinct from the current acquisition repository", async () => {
  const input = {
    ports: [
      {
        id: "relocated",
        project_url: "https://github.com/original/project",
        release: { repository: "successor/project" },
      },
    ],
  };
  const calls = [];
  const report = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: async (url) => {
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
  assert.equal(report.port_health[0].original_upstream.status, "unknown");
  assert.equal(report.port_health[0].original_upstream.locations[0].repository, "original/project");
  assert.equal(report.port_health[0].lineage.successor_selected, false);
});

test("shared acquisition request retains each port's exact artifact scope", async () => {
  const input = healthCatalog();
  input.ports.push({ ...structuredClone(input.ports[0]), id: "other-port" });
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

test("reviewed catalog maintenance accounts for a known original outage without acquiring successor authority", async () => {
  const input = healthCatalog();
  input.source_catalog.qualification = [];
  input.ports[0].upstream_status = "retired";
  const options = {
    now: () => healthTime,
    fetch: async (url, opts) =>
      url.includes("api.github.com") ? new Response(null, { status: 404 }) : healthFetch(url, opts),
  };
  const known = await collectRepositoryHealth(input, options);
  assert.equal(known.outcome, "complete");
  assert.equal(known.degradation, true);
  assert.equal(known.observations[1].classification, "catalog-declared-unavailable-original");
  assert.equal(known.port_health[0].accepted_artifact_obtainability.status, "unknown");
  assert.equal(known.port_health[0].preservation.status, "unknown");
  assert.equal(known.port_health[0].applicable_holds.status, "unknown");
  assert.equal(known.port_health[0].lineage.successor_selected, false);
  delete input.ports[0].upstream_status;
  assert.equal((await collectRepositoryHealth(input, options)).outcome, "incomplete");
  input.ports[0].upstream_status = "retired";
  const artifactMissing = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: async () => new Response(null, { status: 404 }),
  });
  assert.equal(artifactMissing.outcome, "incomplete");
  assert.equal(artifactMissing.observations[0].accounted_for, false);
});

test("recent report comparison deduplicates unchanged conditions, exposes recovery and rejects stale scope", async () => {
  const input = { ports: [{ id: "tracked", release: { repository: "owner/tracked" } }] };
  const collect = (time, previousReport, status) =>
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
  assert.equal(repeated.port_health[0].canonical_incidents[0].occurrences, 2);
  assert.equal(
    repeated.port_health[0].canonical_incidents[0].first_seen,
    first.port_health[0].canonical_incidents[0].first_seen,
  );
  const recovered = await collect(healthTime + 2000, repeated, 200);
  assert.deepEqual(recovered.resolved_incidents, [first.port_health[0].canonical_incidents[0].key]);
  const stale = await collect(healthTime + 25 * 3600_000, first, 404);
  assert.match(stale.previous_report, /stale/);
  assert.equal(stale.material_changes.length, 1);
  const altered = structuredClone(first);
  altered.catalog_sha256 = "f".repeat(64);
  assert.equal((await collect(healthTime + 1000, altered, 404)).material_changes.length, 1);
});

test("repository-name reuse is a changed unknown condition, never continuity or inherited qualification", async () => {
  const input = {
    ports: [
      {
        id: "tracked",
        project_url: "https://github.com/owner/tracked",
        release: { repository: "owner/tracked" },
      },
    ],
  };
  const collect = (id, previousReport = null) =>
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
  assert.equal(replaced.observations[0].reason, "identity-mismatch");
  assert.equal(replaced.outcome, "incomplete");
  assert.equal(replaced.port_health[0].lineage.status, "unresolved");
  assert.equal(replaced.port_health[0].qualification.inherited, false);
});

test("historical release digests are observed at exact tags and partial or conflicting asset pages remain unknown", async () => {
  const input = healthCatalog();
  const paths = [];
  const complete = await collectRepositoryHealth(input, {
    now: () => healthTime,
    fetch: async (url, options) => {
      paths.push(url);
      return healthFetch(url, options);
    },
  });
  assert.ok(paths.includes("https://api.github.com/repos/original/project/releases/tags/v0"));
  assert.equal(complete.port_health[0].accepted_artifact_obtainability.status, "unknown");
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
    assert.equal(report.observations.at(-1).status, "unknown");
    assert.equal(
      report.port_health[0].qualification.records[0].scope.artifact_sha256,
      "b".repeat(64),
    );
  }
});

test("prior provider backoff is honored without using a previous failure as healthy evidence", async () => {
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
  assert.equal(deferred.observations[0].attempted, false);
  assert.equal(deferred.observations[0].reason, "rate-limit");
  assert.equal(deferred.outcome, "incomplete");
});

test("known artifact, authority and distribution failures retain exact reported scope without creating or clearing holds", async () => {
  for (const rule of ["artifact-integrity", "publisher-authority", "distribution-authority"]) {
    const input = healthCatalog();
    input.source_catalog.qualification[0].outcome = "failed";
    input.source_catalog.qualification[0].method = rule;
    input.ports.push({
      id: "unaffected",
      project_url: "https://github.com/original/project",
      release: { repository: "original/project" },
    });
    const report = await collectRepositoryHealth(input, {
      now: () => healthTime,
      fetch: healthFetch,
    });
    assert.equal(report.port_health[0].applicable_holds.reported_failures[0].method, rule);
    assert.equal(
      report.port_health[0].applicable_holds.reported_failures[0].scope.artifact_sha256,
      "b".repeat(64),
    );
    assert.equal(report.port_health[0].applicable_holds.status, "unknown");
    assert.deepEqual(report.port_health[1].applicable_holds.reported_failures, []);
    assert.equal(report.port_health[1].qualification.inherited, false);
  }
});

test("repository identity baseline survives replacement, outage and aged snapshots", async () => {
  const input = { ports: [{ id: "tracked", release: { repository: "owner/tracked" } }] };
  const collect = (id, previousReport, time = healthTime) =>
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
    assert.equal(report.observations[0].baseline_repository_id, 1);
    assert.equal(report.observations[0].observed_repository_id, 2);
    assert.equal(report.observations[0].reason, "identity-mismatch");
    assert.equal(report.outcome, "incomplete");
    assert.deepEqual(report.resolved_incidents, []);
  }
  const replacement = await collect(2, original);
  const repeated = await collect(2, replacement);
  assert.equal(repeated.observations[0].reason, "identity-mismatch");
  assert.equal(repeated.material_changes.length, 0);
});

test("changed material retains condition history and provider-specific recovery", async () => {
  const input = {
    ports: [
      {
        id: "tracked",
        project_url: "https://github.com/owner/tracked",
        release: { provider: "gitlab", repository: "owner/tracked" },
      },
    ],
  };
  const collect = (status, previousReport, time) =>
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
  const before = first.port_health[0].canonical_incidents[0];
  const after = changed.port_health[0].canonical_incidents[0];
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

test("rate-limit fallback defers repeated runs while preserving comparison and incident history", async () => {
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
      assert.equal(report.observations[0].attempted, false);
      assert.equal(report.observations[0].http_status, null);
      assert.equal(report.observations[0].comparison_http_status, 429);
      assert.equal(report.material_changes.length, 0);
      const incident = report.port_health[0].canonical_incidents[0];
      assert.equal(incident.first_seen, first.port_health[0].canonical_incidents[0].first_seen);
      assert.equal(incident.occurrences, elapsed / 1000 + 1);
      assert.equal(incident.notify, false);
      prior = report;
    }
    assert.ok(Date.parse(first.observations[0].retry_at) >= healthTime + 60_000);
  }
});

const healthScopePort = (id, repository = `owner/${id}`) => ({
  id,
  summary: "A native port.",
  platforms: ["windows-x86-64"],
  release: { repository },
  adapter: "owned",
});
const healthScopeCatalog = (...ports) => ({ schema_version: 2, ports });
const change = (file = "crates/portcove-core/catalog/catalog.json", extra = {}) => ({
  oldPath: file,
  newPath: file,
  status: "M",
  oldMode: "100644",
  newMode: "100644",
  ...extra,
});
const copy = (value) => structuredClone(value);

test("summary-only selection makes no requests and does not claim global health", async () => {
  const base = healthScopeCatalog(healthScopePort("game"), healthScopePort("unavailable"));
  const head = copy(base);
  head.ports[0].summary = "Shorter title description.";
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

test("semantic port contracts select affected obligations and their unknowns still block", async () => {
  const base = healthScopeCatalog(healthScopePort("game"), healthScopePort("unavailable"));
  for (const update of [
    (p) => {
      p.release.repository = "owner/new-location";
    },
    (p) => {
      p.release.sha256 = "a".repeat(64);
    },
    (p) => {
      p.upstream_status = "retired";
    },
    (p) => {
      p.platforms.push("linux-x86-64");
    },
    (p) => {
      p.source_profile = "changed-source";
    },
    (p) => {
      p.adapter = "psx-recomp-managed";
    },
  ]) {
    const head = copy(base);
    update(head.ports[0]);
    const scope = await selectUpstreamHealthScope(base, head, [change()]);
    assert.equal(scope.mode, "affected");
    assert.deepEqual(scope.port_ids, ["game"]);
    const calls = [];
    const report = await collectRepositoryHealth(head, {
      portIds: scope.port_ids,
      fetch: async (url) => {
        calls.push(url);
        return new Response(null, { status: 503 });
      },
    });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.observations[0].reason, "provider-error");
    assert.ok(calls.every((url) => !url.endsWith("/unavailable")));
    assert.deepEqual(report.scope.unassessed_port_ids, ["unavailable"]);
    assert.deepEqual(
      scope.retcomm_port_ids,
      head.ports[0].adapter === "psx-recomp-managed" ? ["game"] : [],
    );
  }
});

test("shared endpoints retain unselected maintenance and identity obligations", async () => {
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
  assert.deepEqual(report.observations[0].port_ids, ["retired", "active"]);
  assert.equal(report.observations[0].accounted_for, false);
  assert.equal(report.outcome, "incomplete");
});

test("additions select the new port; removals and root/history changes retain full scope", async () => {
  const base = healthScopeCatalog(healthScopePort("old"));
  const head = healthScopeCatalog(healthScopePort("old"), healthScopePort("new"));
  assert.deepEqual((await selectUpstreamHealthScope(base, head, [change()])).port_ids, ["new"]);
  assert.equal((await selectUpstreamHealthScope(head, base, [change()])).mode, "full");
  for (const update of [
    (c) => {
      c.schema_version++;
    },
    (c) => {
      c.source_catalog = {
        qualification: [
          { scope: { port_id: "old", artifact_sha256: "a".repeat(64), upstream_ref: "v1" } },
        ],
      };
    },
  ]) {
    const changed = copy(base);
    update(changed);
    assert.equal((await selectUpstreamHealthScope(base, changed, [change()])).mode, "full");
  }
});

test("tools, workflows, policy, mixed changes and uncertain inventories cannot narrow monitoring", async () => {
  const input = healthScopeCatalog(healthScopePort("old"));
  for (const changes of [
    [],
    [change("scripts/check-catalog-repositories.mjs")],
    [change("scripts/upstream-health-plan.mjs")],
    [change(".github/workflows/upstream-health.yml")],
    [change("AGENTS.md")],
    [change(), change("README.md")],
    [change(undefined, { newMode: "120000" })],
    [change(undefined, { status: "R" })],
  ])
    assert.equal((await selectUpstreamHealthScope(input, input, changes)).mode, "full");
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

test("exact Git discovery binds base, merge base, head and checkout; drift and missing refs fail closed", async () => {
  const baseSha = "a".repeat(40),
    headSha = "b".repeat(40),
    checkoutSha = "c".repeat(40);
  const base = healthScopeCatalog(healthScopePort("old"));
  const head = copy(base);
  head.ports[0].summary = "New copy.";
  const tree = "d".repeat(40);
  let drift = false;
  const git = (args) => {
    if (args[0] === "rev-parse") {
      const value = args.at(-1).split("^")[0];
      return Buffer.from(
        args.at(-1).endsWith("^{commit}")
          ? value
          : drift && value === checkoutSha
            ? "e".repeat(40)
            : tree,
      );
    }
    if (args[0] === "merge-base") return Buffer.from(baseSha);
    if (args[0] === "diff")
      return Buffer.from(
        `:100644 100644 ${baseSha} ${headSha} M\0crates/portcove-core/catalog/catalog.json\0`,
      );
    if (args[0] === "show")
      return Buffer.from(JSON.stringify(args[1].startsWith(baseSha) ? base : head));
    assert.fail(args);
  };
  const context = { event: "pull_request", baseSha, headSha, checkoutSha };
  const discover = () => discoverUpstreamHealthScope(context, git, () => JSON.stringify(head));
  const scope = await discover();
  assert.equal(scope.mode, "none");
  assert.equal(scope.identities.head, headSha);
  assert.equal(scope.identities.merge_base, baseSha);
  assert.equal(scope.identities.checkout_tree, tree);
  drift = true;
  assert.equal((await discover()).mode, "full");
  await assert.rejects(
    discoverUpstreamHealthScope({ ...context, baseSha: "main" }, git, () => JSON.stringify(head)),
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
  for (const event of ["push", "schedule", "workflow_dispatch", "unknown"])
    assert.equal(
      (
        await discoverUpstreamHealthScope(
          { event },
          () => assert.fail("Full monitoring does not need PR Git refs"),
          () => JSON.stringify(head),
        )
      ).mode,
      "full",
    );
});
