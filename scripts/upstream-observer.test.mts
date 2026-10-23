import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import {
  ObservationFailure,
  observationHash,
  observeUpstream,
  validateObserverConfig,
} from "./upstream-observer.mts";
import { advanceObservation, withCheckpointLock } from "./observe-configured-upstream.mts";
import { validateHealthAccountingPolicy } from "./check-catalog-repositories.mts";
import { healthArtifactHash, healthEndpointHash } from "./upstream-health-inputs.mts";

import {
  config,
  root,
  time,
  release,
  asset,
  requiredFixture,
  objectFixture,
  incrementFixtureId,
  arrayFixture,
  fixture,
  project,
} from "./fixtures/upstream-observation-fixtures.mts";

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
    const port = requiredFixture(ports.find((value) => isRecord(value) && value.id === id));
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
