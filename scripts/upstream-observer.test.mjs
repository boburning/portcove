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
import {
  advanceObservation,
  withCheckpointLock,
} from "./observe-configured-upstream.mjs";

const config = JSON.parse(
  await readFile(
    new URL("../release/upstream-observer.json", import.meta.url),
    "utf8",
  ),
);

test("the compiled CLI fixture uses the same canonical facts digest", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../crates/portcove-cli/tests/fixtures/upstream-observation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(observationHash(fixture.facts), fixture.facts_sha256);
});

test("scheduled observation keeps the configured cadence, read-only authority and bounded recovery cache", async () => {
  const workflow = await readFile(
    new URL(
      "../.github/workflows/configured-upstream-observer.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(workflow.includes(`cron: '17 */${config.cadence_hours} * * *'`));
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
      const intercepted = await overrides.intercept(
        url,
        options,
        requests.length,
        replies,
      );
      if (intercepted) return intercepted;
    }
    const reply = replies.get(url);
    assert.ok(reply, `Unexpected URL ${url}`);
    const etag = `"${observationHash(reply)}"`;
    if (options.headers["If-None-Match"] === etag)
      return new Response(null, { status: 304 });
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
  assert.notEqual(
    replaced.observation.facts_sha256,
    first.observation.facts_sha256,
  );
  assert.equal(replaced.observation.facts.releases[0].assets[0].id, 2);
  server.replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body = [
    asset(3),
  ];
  const changed = await observeUpstream(config, {
    fetch: server.fetch,
    cache: replaced.cache,
  });
  assert.equal(changed.observation.facts.releases[0].assets[0].id, 3);
  assert.notEqual(
    changed.observation.facts_sha256,
    replaced.observation.facts_sha256,
  );
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
    intercept: (url) =>
      url.includes("/assets?") ? new Response(null, { status: 503 }) : null,
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
        replies.get(
          `${root}/releases/1/assets?per_page=100&page=1`,
        ).body[0].download_count = 456;
      }
    },
  });
  const result = await observeUpstream(config, { fetch: changing.fetch });
  assert.equal(
    result.observation.facts_sha256,
    baseline.observation.facts_sha256,
  );
  assert.equal(result.cache.pages[root].body.stargazers_count, 123);
  const changedAsset = fixture({
    intercept: (_url, _options, count, replies) => {
      if (count === 4)
        replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body[0] =
          asset(2, "changed artifact bytes");
    },
  });
  await assert.rejects(
    observeUpstream(config, { fetch: changedAsset.fetch }),
    (error) => error.rule === "concurrent-change",
  );
});

test("rate limits defer to provider clocks and transport retries stay bounded", async () => {
  const limited = fixture({
    intercept: () =>
      new Response(null, { status: 429, headers: { "retry-after": "120" } }),
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
    (error) =>
      error.rule === "transport" && !error.message.includes("untrusted"),
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
  malformed.replies.get(
    `${root}/releases?per_page=100&page=1`,
  ).body[0].prerelease = "false";
  await assert.rejects(
    observeUpstream(config, { fetch: malformed.fetch }),
    /explicit booleans/,
  );
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
  value.browser_download_url = value.browser_download_url.replace(
    "v1.0.0",
    "1.1-rc5",
  );
  server.replies.get(`${root}/releases/1/assets?per_page=100&page=1`).body = [
    value,
  ];
  const result = await observeUpstream(config, { fetch: server.fetch });
  assert.equal(result.observation.facts.releases[0].prerelease, false);
  assert.equal(result.observation.facts.releases[0].tag_name, "1.1-rc5");
  assert.equal(Object.hasOwn(result.observation, "eligible"), false);
  server.replies.get(
    `${root}/releases?per_page=100&page=1`,
  ).body[0].prerelease = true;
  assert.equal(
    (await observeUpstream(config, { fetch: server.fetch })).observation.facts
      .releases.length,
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
  assert.deepEqual(
    failed.checkpoint.last_complete,
    first.checkpoint.last_complete,
  );
  assert.equal(
    failed.report.fallback.facts_sha256,
    first.report.observation.facts_sha256,
  );
  const repeated = await advanceObservation(config, failed.checkpoint, {
    ...options,
    fetch: broken.fetch,
  });
  assert.equal(repeated.notify_exception, false);
  assert.equal(repeated.report.exception.occurrences, 2);
  assert.equal(
    repeated.report.exception.first_seen,
    failed.report.exception.first_seen,
  );
  const recovered = await advanceObservation(
    config,
    repeated.checkpoint,
    options,
  );
  assert.equal(recovered.report.stale, false);
  assert.equal(recovered.report.transition, "unchanged");
  assert.equal(recovered.report.exception, null);
  assert.equal(recovered.checkpoint.completed_runs, 2);
});

test("deferred checkpoints honor retry clocks without requests and mismatched core output cannot advance", async () => {
  let clock = Date.parse(time);
  const limited = fixture({
    intercept: () =>
      new Response(null, { status: 429, headers: { "retry-after": "120" } }),
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
  assert.deepEqual(
    mismatch.checkpoint.last_complete,
    good.checkpoint.last_complete,
  );
  await assert.rejects(
    advanceObservation(
      config,
      { ...good.checkpoint, config_sha256: "wrong" },
      options,
    ),
    (error) => error.rule === "invalid-checkpoint",
  );
});
