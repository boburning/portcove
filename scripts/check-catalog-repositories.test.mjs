import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectRepositoryHealth, renderRepositoryHealth } from "./check-catalog-repositories.mjs";

const clock = 1_780_000_000_000;
const port = (id, repository = `owner/${id}`, provider = "github") => ({
  id,
  release: { repository, provider },
});
const catalog = (...ports) => ({ ports });
const response = (facts, status = 200, headers = {}) =>
  new Response(JSON.stringify(facts), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const factsFor = (url) =>
  url.startsWith("https://api.github.com/")
    ? { id: 123, full_name: url.split("/repos/")[1], archived: false }
    : {
        id: 456,
        path_with_namespace: decodeURIComponent(url.split("/projects/")[1]),
        archived: false,
      };
const collect = (input, fetcher, options = {}) =>
  collectRepositoryHealth(input, {
    now: () => clock,
    fetch: fetcher ?? (async (url) => response(factsFor(url))),
    ...options,
  });

test("stable port coverage deduplicates shared GitHub repositories without merging providers", async () => {
  const input = catalog(
    port("gold", "Owner/shared"),
    port("silver", "owner/SHARED"),
    port("other", "Owner/shared", "gitlab"),
    port("direct", undefined, "direct-manifest"),
  );
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(
      new URL(url).host === "api.github.com",
      Object.hasOwn(options.headers, "Authorization"),
    );
    assert.equal(
      new URL(url).host === "gitlab.com",
      Object.hasOwn(options.headers, "PRIVATE-TOKEN"),
    );
    return response({ ...factsFor(url), archived: true });
  };
  const report = await collect(input, fetcher, {
    githubToken: "fixture-github",
    gitlabToken: "fixture-gitlab",
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(report.coverage, {
    ports: 4,
    hosted_ports: 3,
    direct_manifest_port_ids: ["direct"],
    repositories: 2,
    attempted_repositories: 2,
    reachable_repositories: 2,
    unknown_repositories: 0,
  });
  assert.deepEqual(report.observations[0].port_ids, ["gold", "silver"]);
  assert.equal(report.outcome, "complete");
  assert.equal(report.observations[0].archived, true);
  assert.ok(report.unassessed.includes("upstream-continuity"));
  assert.ok(report.unassessed.includes("accepted-artifact-availability"));
  assert.doesNotMatch(JSON.stringify(report), /fixture-github|fixture-gitlab/);
  assert.deepEqual(await collect(input), await collect(input));
  assert.match(renderRepositoryHealth(report), /1 direct-manifest ports not assessed/);
});

test("transport failure does not truncate later repository coverage or expose error details", async () => {
  let calls = 0;
  const report = await collect(catalog(port("failed"), port("healthy")), async (url) => {
    if (++calls === 1) throw new Error("secret-token private-path");
    return response(factsFor(url));
  });
  assert.equal(calls, 2);
  assert.equal(report.outcome, "incomplete");
  assert.deepEqual(
    report.observations.map((record) => record.reason),
    ["transport", null],
  );
  assert.deepEqual(
    report.observations.map((record) => record.attempted),
    [true, true],
  );
  assert.doesNotMatch(JSON.stringify(report), /secret-token|private-path/);
});

test("user-prepared entries retain their existing GitHub upstream coverage", async () => {
  const report = await collect(
    catalog(port("managed", "owner/shared"), port("prepared", "owner/shared", "user-prepared")),
  );
  assert.equal(report.coverage.repositories, 1);
  assert.deepEqual(report.observations[0].port_ids, ["managed", "prepared"]);
  assert.deepEqual(report.observations[0].release_providers, ["github", "user-prepared"]);
});

test("remaining duration bounds the actual request abort signal", async () => {
  let ticks = 0;
  const report = await collect(
    catalog(port("timeout")),
    async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        const guard = setTimeout(() => reject(new Error("fixture did not time out")), 100);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(guard);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    { now: () => clock + (ticks++ === 0 ? 0 : 179_995) },
  );
  assert.equal(report.observations[0].reason, "timeout");
  assert.equal(report.outcome, "incomplete");
});

test("HTTP failures remain conservative and never assert upstream deletion or successful health", async () => {
  for (const [status, reason] of [
    [404, "inaccessible-or-missing"],
    [401, "authentication"],
    [403, "forbidden"],
    [503, "provider-error"],
    [302, "provider-status"],
  ]) {
    const report = await collect(catalog(port("failure")), async () => response({}, status));
    assert.equal(report.observations[0].reason, reason);
    assert.equal(report.observations[0].http_status, status);
    assert.equal(report.observations[0].status, "unknown");
    assert.equal(report.outcome, "incomplete");
  }
  const report = await collect(catalog(port("star-fox", "kandowontu/starfox-enhanced")), async () =>
    response({}, 404),
  );
  assert.match(renderRepositoryHealth(report), /404 does not establish deletion or succession/);
});

test("rate limit stops subsequent requests to that provider and retains other-provider coverage", async () => {
  for (const [status, headers] of [
    [429, { "retry-after": "120" }],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(clock / 1000 + 120) }],
    [403, { "retry-after": "invalid" }],
  ]) {
    const calls = [];
    const report = await collect(
      catalog(port("limited"), port("deferred"), port("gitlab", "group/sub/project", "gitlab")),
      async (url) => {
        calls.push(url);
        return url.startsWith("https://api.github.com/")
          ? response({}, status, headers)
          : response(factsFor(url));
      },
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(
      report.observations.map((record) => record.reason),
      ["rate-limit", "rate-limit", null],
    );
    assert.deepEqual(
      report.observations.map((record) => record.attempted),
      [true, false, true],
    );
    assert.equal(report.observations[1].http_status, null);
    assert.match(renderRepositoryHealth(report), /unknown \(rate-limit; not attempted\)/u);
    assert.equal(report.observations[1].retry_at, report.observations[0].retry_at);
    assert.equal(
      report.observations[0].retry_at,
      headers["retry-after"] === "invalid" ? null : new Date(clock + 120_000).toISOString(),
    );
  }
});

test("corrupt, mismatched and oversized metadata cannot turn an endpoint healthy", async () => {
  const input = catalog(port("bad"), port("good"));
  for (const [make, reason] of [
    [
      () => new Response("invalid", { headers: { "content-type": "application/json" } }),
      "invalid-metadata",
    ],
    [() => new Response("{}", { headers: { "content-type": "text/html" } }), "invalid-metadata"],
    [() => response({ id: 1, full_name: "owner/bad", archived: "false" }), "invalid-metadata"],
    [() => response({ id: 1, full_name: "different/repo", archived: false }), "identity-mismatch"],
    [
      () =>
        response({
          id: 1,
          full_name: "owner/bad",
          archived: false,
          filler: "a".repeat(1024 * 1024),
        }),
      "budget",
    ],
    [
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("private transport"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      "transport",
    ],
  ]) {
    let calls = 0;
    const report = await collect(input, async (url) =>
      ++calls === 1 ? make() : response(factsFor(url)),
    );
    assert.equal(report.observations[0].reason, reason);
    assert.equal(report.observations[1].status, "reachable");
    assert.equal(calls, 2);
  }
});

test("fixed request, duration and aggregate byte limits leave unattempted identities visible", async () => {
  const input = catalog(...Array.from({ length: 130 }, (_, i) => port(`port-${i}`)));
  const report = await collect(input);
  assert.equal(report.consumed.requests, 128);
  assert.equal(report.observations.length, 130);
  assert.equal(report.observations[129].reason, "budget");
  assert.equal(report.observations[129].attempted, false);
  let elapsed = 0;
  const timeLimited = await collect(
    input,
    async (url) => {
      elapsed = 180_000;
      return response(factsFor(url));
    },
    { now: () => clock + elapsed },
  );
  assert.equal(timeLimited.consumed.requests, 1);
  assert.equal(timeLimited.observations[0].reason, "budget");
  assert.equal(timeLimited.observations[129].attempted, false);
  const bytesLimited = await collect(input, async (url) =>
    response({ ...factsFor(url), filler: "a".repeat(1024 * 1024 - 200) }),
  );
  assert.equal(bytesLimited.consumed.requests, 17);
  assert.equal(bytesLimited.observations[16].reason, "budget");
  assert.equal(bytesLimited.observations[17].attempted, false);
});

test("crossing the collection deadline during request setup retains the remaining inventory", async () => {
  let ticks = 0;
  const report = await collect(catalog(port("first"), port("last")), undefined, {
    now: () => clock + (ticks++ === 0 ? 0 : ticks === 2 ? 179_999 : 180_001),
  });
  assert.equal(report.observations.length, 2);
  assert.equal(report.observations[0].reason, "budget");
  assert.equal(report.observations[1].attempted, false);
  assert.equal(report.observations[1].reason, "budget");
});

test("malformed inventory refuses before network and direct-manifest-only is explicitly excluded", async () => {
  for (const input of [
    {},
    catalog(port("repeat"), port("repeat")),
    catalog(port("bad", "owner/../repo")),
    catalog(port("unsupported", "owner/repo", "other")),
  ]) {
    await assert.rejects(
      collect(input, async () => {
        assert.fail("invalid inventory must not request");
      }),
    );
  }
  const report = await collect(catalog(port("direct", undefined, "direct-manifest")), async () => {
    assert.fail("direct manifest is outside repository coverage");
  });
  assert.equal(report.consumed.requests, 0);
  assert.equal(report.coverage.hosted_ports, 0);
  assert.deepEqual(report.coverage.direct_manifest_port_ids, ["direct"]);
});

test("actual command emits complete JSON and human coverage with a failure exit after an early transport failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "portcove-repository-health-"));
  try {
    const preload = path.join(dir, "fetch.mjs");
    await writeFile(
      preload,
      `let calls=0; globalThis.fetch=async(url)=>{
      if(process.env.HEALTH_FIXTURE_FAILURE==='yes' && ++calls===1) throw new Error('private fixture error');
      const github=url.startsWith('https://api.github.com/');
      return new Response(JSON.stringify({id:1,archived:false,...(github?{full_name:url.split('/repos/')[1]}:{path_with_namespace:decodeURIComponent(url.split('/projects/')[1])})}),{headers:{'content-type':'application/json'}});
    };`,
    );
    const realCatalog = JSON.parse(
      await readFile(
        new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
        "utf8",
      ),
    );
    const run = (args, failure) =>
      spawnSync(
        process.execPath,
        ["--import", preload, "scripts/check-catalog-repositories.mjs", ...args],
        {
          cwd: new URL("..", import.meta.url),
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, HEALTH_FIXTURE_FAILURE: failure ? "yes" : "no" },
        },
      );
    const failed = run(["--json"], true);
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(failed.stderr, "");
    const report = JSON.parse(failed.stdout);
    assert.equal(report.coverage.ports, realCatalog.ports.length);
    assert.equal(report.observations.length, report.coverage.repositories);
    assert.equal(report.coverage.attempted_repositories, report.coverage.repositories);
    assert.equal(report.coverage.unknown_repositories, 1);
    assert.equal(report.observations.at(-1).status, "reachable");
    const human = run([], true);
    assert.equal(human.status, 1, human.stderr);
    assert.match(human.stdout, /unknown \(transport/);
    assert.match(human.stdout, /Unassessed: upstream-continuity/);
    const good = run(["--json"], false);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).outcome, "complete");
    const invalid = run(["--unexpected"], false);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
