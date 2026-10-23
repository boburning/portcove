import reviewedHealthAccounting from "../.github/upstream-health-accounting.json" with { type: "json" };
import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import type {
  HealthFetch,
  HealthOptions,
  HealthRequestOptions,
} from "./check-catalog-repositories.mts";
import { collectRepositoryHealth, renderRepositoryHealth } from "./check-catalog-repositories.mts";
import os from "node:os";
import path from "node:path";

function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "expected fixture or source section is missing");
  return value;
}

// Inert repository-health controls for the tool invoked by the live upstream workflow.
{
  void test("GitLab public metadata without archive state stays reachable with an explicit unknown", async () => {
    const input = {
      ports: [
        { id: "public-project", release: { provider: "gitlab", repository: "owner/project" } },
      ],
    };
    const fetcher = async () =>
      new Response(JSON.stringify({ id: 1, path_with_namespace: "owner/project" }), {
        headers: { "content-type": "application/json" },
      });
    const report = await collectRepositoryHealth(input, { fetch: fetcher });
    assert.equal(report.outcome, "complete");
    assert.equal(requiredFixture(report.observations[0]).status, "reachable");
    assert.equal(requiredFixture(report.observations[0]).archived, null);
    assert.match(renderRepositoryHealth(report), /reachable \(archive state unknown\)/u);
    for (const archived of [null, "false", 0]) {
      const invalid = await collectRepositoryHealth(input, {
        fetch: async () =>
          new Response(JSON.stringify({ id: 1, path_with_namespace: "owner/project", archived }), {
            headers: { "content-type": "application/json" },
          }),
      });
      assert.equal(invalid.outcome, "incomplete");
      assert.equal(requiredFixture(invalid.observations[0]).reason, "invalid-metadata");
    }
  });
  const clock = 1_780_000_000_000;
  const port = (id: string, repository = `owner/${id}`, provider = "github") => ({
    id,
    release:
      provider === "direct-manifest"
        ? {
            provider,
            direct: {
              windows: {
                version: "v1",
                url: "https://downloads.example.com/direct.zip",
                size: 42,
                sha256: "a".repeat(64),
              },
            },
          }
        : { repository, provider },
  });
  const catalog = (...ports: unknown[]) => ({ ports });
  const response = (facts: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(facts), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const factsFor = (url: string) =>
    url.startsWith("https://api.github.com/")
      ? { id: 123, full_name: requiredFixture(url.split("/repos/")[1]), archived: false }
      : {
          id: 456,
          path_with_namespace: decodeURIComponent(requiredFixture(url.split("/projects/")[1])),
          archived: false,
        };
  const collect = (input: unknown, fetcher?: HealthFetch, options: HealthOptions = {}) =>
    collectRepositoryHealth(input, {
      now: () => clock,
      fetch:
        fetcher ??
        (async (url: string) =>
          url.startsWith("https://downloads.example.com/")
            ? new Response(null, { headers: { "content-length": "42" } })
            : response(factsFor(url))),
      ...options,
    });

  void test("prior health reports cannot forward malformed comparison metadata", async () => {
    const input = catalog(port("limited"));
    const first = await collect(input, async () => response({}, 429, { "retry-after": "120" }));
    assert.equal(first.format_version, 3);
    for (const [field, value] of [
      ["http_status", { private: "untrusted prior metadata" }],
      ["comparison_http_status", "429"],
      ["comparison_observed_at", { private: "untrusted prior clock" }],
    ] as const) {
      const prior: unknown = structuredClone(first);
      assert.ok(isRecord(prior) && Array.isArray(prior.observations));
      const entries: unknown[] = prior.observations;
      const location = requiredFixture(entries[0]);
      assert.ok(isRecord(location));
      location[field] = value;
      let calls = 0;
      await assert.rejects(
        collect(
          input,
          async () => {
            calls++;
            assert.fail("invalid prior metadata reached live collection");
          },
          { previousReport: prior },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Invalid historical health comparison/);
          assert.doesNotMatch(error.message, /untrusted prior/);
          return true;
        },
      );
      assert.equal(calls, 0);
    }
  });

  void test("stable port coverage deduplicates shared GitHub repositories without merging providers", async () => {
    const input = catalog(
      port("gold", "Owner/shared"),
      port("silver", "owner/SHARED"),
      port("other", "Owner/shared", "gitlab"),
      port("direct", undefined, "direct-manifest"),
    );
    const calls: { url: string; options: HealthRequestOptions }[] = [];
    const fetcher: HealthFetch = async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, "manual");
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(
        new URL(url).host === "api.github.com",
        Object.hasOwn(options.headers, "Authorization"),
      );
      assert.equal(
        new URL(url).host === "gitlab.com",
        Object.hasOwn(options.headers, "PRIVATE-TOKEN"),
      );
      if (url.startsWith("https://downloads.example.com/")) {
        assert.equal(options.method, "HEAD");
        return new Response(null, { headers: { "content-length": "42" } });
      }
      return response({ ...factsFor(url), archived: true });
    };
    const report = await collect(input, fetcher, {
      githubToken: "fixture-github",
      gitlabToken: "fixture-gitlab",
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(report.coverage, {
      ports: 4,
      hosted_ports: 3,
      direct_manifest_port_ids: ["direct"],
      monitored_ports: 4,
      repositories: 3,
      attempted_repositories: 3,
      reused_repositories: 0,
      reachable_repositories: 3,
      unknown_repositories: 0,
    });
    assert.deepEqual(requiredFixture(report.observations[0]).port_ids, ["gold", "silver"]);
    assert.equal(report.outcome, "complete");
    assert.equal(requiredFixture(report.observations[0]).archived, true);
    assert.ok(report.unassessed.includes("upstream-continuity"));
    assert.ok(report.unassessed.includes("accepted-artifact-availability"));
    assert.doesNotMatch(JSON.stringify(report), /fixture-github|fixture-gitlab/);
    assert.deepEqual(await collect(input), await collect(input));
    assert.match(renderRepositoryHealth(report), /1 direct-manifest ports included/);
  });

  void test("transport failure does not truncate later repository coverage or expose error details", async () => {
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

  void test("user-prepared entries retain their existing GitHub upstream coverage", async () => {
    const report = await collect(
      catalog(port("managed", "owner/shared"), {
        ...port("prepared", "owner/shared", "user-prepared"),
        project_url: "https://github.com/OWNER/shared",
      }),
    );
    assert.equal(report.coverage.repositories, 1);
    assert.deepEqual(requiredFixture(report.observations[0]).port_ids, ["managed", "prepared"]);
    assert.deepEqual(requiredFixture(report.observations[0]).release_providers, [
      "github",
      "user-prepared",
    ]);
    assert.deepEqual(requiredFixture(report.observations[0]).original_upstream_port_ids, [
      "prepared",
    ]);
  });

  void test("project-only prepared runtimes observe their upstream without claiming artifact delivery", async () => {
    const reviewed = requiredFixture(
      reviewedHealthAccounting.pins.find(
        (pin) => pin.repository === "sergiomanzur/regaiden-recomp",
      ),
    );
    const report = await collect(
      catalog({
        id: "resident-evil-gaiden-recomp",
        project_url: "https://github.com/sergiomanzur/regaiden-recomp",
        release: { provider: "user-prepared" },
      }),
      async () =>
        response({
          id: reviewed.repository_id,
          full_name: reviewed.repository,
          archived: false,
        }),
    );
    assert.equal(report.outcome, "complete");
    assert.equal(report.coverage.monitored_ports, 1);
    assert.equal(report.coverage.repositories, 1);
    const observed = requiredFixture(report.observations[0]);
    assert.equal(observed.repository, "sergiomanzur/regaiden-recomp");
    assert.equal(observed.status, "reachable");
    assert.equal(observed.observed_repository_id, reviewed.repository_id);
    assert.deepEqual(observed.release_providers, ["user-prepared"]);
    assert.deepEqual(observed.original_upstream_port_ids, ["resident-evil-gaiden-recomp"]);
    for (const claim of ["upstream-continuity", "accepted-artifact-availability"])
      assert.ok(report.unassessed.includes(claim));
    assert.equal(observed.artifact_identities, undefined);
    assert.equal(observed.historical_artifact_identities, undefined);
  });

  void test("prepared project fallback preserves explicit repository and project validation", async () => {
    const prepared = {
      id: "prepared",
      project_url: "https://github.com/owner/prepared",
      release: { provider: "user-prepared" },
    };
    for (const repository of [null, "", "../project", "owner/project/extra", 42])
      await assert.rejects(
        collect(catalog({ ...prepared, release: { ...prepared.release, repository } })),
        /Unsupported hosted catalog repository/,
      );
    for (const project_url of [
      "not a URL",
      "http://github.com/owner/prepared",
      "https://github.com/owner/prepared?token=x",
    ])
      await assert.rejects(
        collect(catalog({ ...prepared, project_url })),
        /Unsupported original upstream/,
      );
    await assert.rejects(
      collect(catalog({ ...prepared, id: "Invalid ID" })),
      /unique stable port IDs/,
    );
    await assert.rejects(
      collect(catalog({ ...prepared, release: { provider: "unknown" } })),
      /Unsupported hosted/,
    );
  });

  void test("remaining duration bounds the actual request abort signal", async () => {
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
    assert.equal(requiredFixture(report.observations[0]).reason, "timeout");
    assert.equal(report.outcome, "incomplete");
  });

  void test("HTTP failures remain conservative and never assert upstream deletion or successful health", async () => {
    for (const [status, reason] of [
      [404, "inaccessible-or-missing"],
      [401, "authentication"],
      [403, "forbidden"],
      [503, "provider-error"],
      [302, "provider-redirect"],
    ] as const) {
      const report = await collect(catalog(port("failure")), async () => response({}, status));
      assert.equal(requiredFixture(report.observations[0]).reason, reason);
      assert.equal(requiredFixture(report.observations[0]).http_status, status);
      assert.equal(requiredFixture(report.observations[0]).status, "unknown");
      assert.equal(report.outcome, "incomplete");
    }
    const report = await collect(
      catalog(port("star-fox", "kandowontu/starfox-enhanced")),
      async () => response({}, 404),
    );
    assert.match(renderRepositoryHealth(report), /404 does not establish deletion or succession/);
  });

  void test("rate limit stops subsequent requests to that provider and retains other-provider coverage", async () => {
    for (const [status, headers] of [
      [429, { "retry-after": "120" }],
      [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(clock / 1000 + 120) }],
      [403, { "retry-after": "invalid" }],
    ] as const) {
      const calls: string[] = [];
      const report = await collect(
        catalog(port("limited"), port("deferred"), port("gitlab", "group/sub/project", "gitlab")),
        async (url: string) => {
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
      assert.equal(requiredFixture(report.observations[1]).http_status, null);
      assert.match(renderRepositoryHealth(report), /unknown \(rate-limit; not attempted\)/u);
      assert.equal(
        requiredFixture(report.observations[1]).retry_at,
        requiredFixture(report.observations[0]).retry_at,
      );
      assert.equal(
        requiredFixture(report.observations[0]).retry_at,
        new Date(clock + (headers["retry-after"] === "invalid" ? 60_000 : 120_000)).toISOString(),
      );
    }
  });

  void test("corrupt, mismatched and oversized metadata cannot turn an endpoint healthy", async () => {
    const input = catalog(port("bad"), port("good"));
    for (const [make, reason] of [
      [
        () => new Response("invalid", { headers: { "content-type": "application/json" } }),
        "invalid-metadata",
      ],
      [() => new Response("{}", { headers: { "content-type": "text/html" } }), "invalid-metadata"],
      [() => response({ id: 1, full_name: "owner/bad", archived: "false" }), "invalid-metadata"],
      [
        () => response({ id: 1, full_name: "different/repo", archived: false }),
        "identity-mismatch",
      ],
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
    ] as const) {
      let calls = 0;
      const report = await collect(input, async (url) =>
        ++calls === 1 ? make() : response(factsFor(url)),
      );
      assert.equal(requiredFixture(report.observations[0]).reason, reason);
      assert.equal(requiredFixture(report.observations[1]).status, "reachable");
      assert.equal(calls, 2);
    }
  });

  void test("fixed request, duration and aggregate byte limits leave unattempted identities visible", async () => {
    const input = catalog(...Array.from({ length: 130 }, (_, i) => port(`port-${i}`)));
    const report = await collect(input);
    assert.equal(report.consumed.requests, 130);
    assert.equal(report.observations.length, 130);
    assert.equal(requiredFixture(report.observations[129]).reason, null);
    assert.equal(requiredFixture(report.observations[129]).attempted, true);
    assert.equal(report.request_plan.status, "admitted");
    assert.equal(report.limits.requests, 130);
    const atCeiling = await collect(
      catalog(...Array.from({ length: 320 }, (_, i) => port(`ceiling-${i}`))),
    );
    assert.equal(atCeiling.consumed.requests, 320);
    assert.equal(atCeiling.request_plan.status, "admitted");
    let overflowCalls = 0;
    const overflow = await collect(
      catalog(...Array.from({ length: 321 }, (_, i) => port(`overflow-${i}`))),
      async () => {
        overflowCalls += 1;
        assert.fail("overflow must refuse before network");
      },
    );
    assert.equal(overflow.request_plan.status, "overflow");
    assert.equal(overflow.consumed.requests, 0);
    assert.equal(overflowCalls, 0);
    assert.equal(overflow.observations.length, 321);
    assert.ok(
      overflow.observations.every(
        (record) => record.reason === "budget" && record.attempted === false,
      ),
    );
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
    assert.equal(requiredFixture(timeLimited.observations[0]).reason, "budget");
    assert.equal(requiredFixture(timeLimited.observations[129]).attempted, false);
    const bytesLimited = await collect(input, async (url) =>
      response({ ...factsFor(url), filler: "a".repeat(1024 * 1024 - 200) }),
    );
    assert.equal(bytesLimited.consumed.requests, 17);
    assert.equal(requiredFixture(bytesLimited.observations[16]).reason, "budget");
    assert.equal(requiredFixture(bytesLimited.observations[17]).attempted, false);
  });

  void test("crossing the collection deadline during request setup retains the remaining inventory", async () => {
    let ticks = 0;
    const report = await collect(catalog(port("first"), port("last")), undefined, {
      now: () => clock + (ticks++ === 0 ? 0 : ticks === 2 ? 179_999 : 180_001),
    });
    assert.equal(report.observations.length, 2);
    assert.equal(requiredFixture(report.observations[0]).reason, "budget");
    assert.equal(requiredFixture(report.observations[1]).attempted, false);
    assert.equal(requiredFixture(report.observations[1]).reason, "budget");
  });

  void test("malformed inventory refuses before network and direct-manifest-only retains exact coverage", async () => {
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
    const report = await collect(
      catalog(port("direct", undefined, "direct-manifest")),
      async (_url, options) => {
        assert.equal(options.method, "HEAD");
        return new Response(null, { headers: { "content-length": "42" } });
      },
    );
    assert.equal(report.consumed.requests, 1);
    assert.equal(report.coverage.hosted_ports, 0);
    assert.deepEqual(report.coverage.direct_manifest_port_ids, ["direct"]);
  });

  void test("actual command emits complete JSON and human coverage with a failure exit after an early transport failure", async () => {
    const { pathToFileURL } = await import("node:url");
    const dir = await mkdtemp(path.join(os.tmpdir(), "portcove-repository-health-"));
    try {
      const preload = path.join(dir, "fetch.mjs");
      await writeFile(
        preload,
        `const {readFile}=await import('node:fs/promises');
    const catalog=JSON.parse(await readFile('crates/portcove-core/catalog/catalog.json','utf8'));
    const accounting=${JSON.stringify(reviewedHealthAccounting)};
    const repositoryIds=new Map([...accounting.pins,...accounting.source_archives].map(pin=>['github.com/'+pin.repository.toLowerCase(),pin.repository_id]));
    const {assessUpstreamLineage}=await import(${JSON.stringify(new URL("./upstream-lineage.mts", import.meta.url).href)});
    for(const port of catalog.ports) {
      let record;
      try { record=JSON.parse(await readFile('crates/portcove-core/catalog/ports/'+port.id+'.json','utf8')); }
      catch(error) { if(error.code==='ENOENT') continue; throw error; }
      if(!record.upstream_lineage) continue;
      const {current}=assessUpstreamLineage(record);
      if(current.repository) {
        const project=new URL(current.project_url);
        repositoryIds.set(project.host+'/'+project.pathname.slice(1).toLowerCase(),Number(current.repository.id));
      }
    }
    const pins=new Map(catalog.ports.flatMap(port=>Object.values(port.release.direct??{}).map(pin=>[pin.url,pin.size])));
    let calls=0; globalThis.fetch=async(url,options)=>{
      if(process.env.HEALTH_FIXTURE_FAILURE==='yes' && ++calls===1) throw new Error('private fixture error');
      if(options.method==='HEAD') return new Response(null,{headers:pins.has(url)?{'content-length':String(pins.get(url))}:{}});
      if(url.includes('/releases/')) {
        const github=url.startsWith('https://api.github.com/');
        const [encoded,ref]=(github?url.split('/repos/')[1]:url.split('/projects/')[1]).split(github?'/releases/tags/':'/releases/');
        const repository=decodeURIComponent(encoded);
        const tag=decodeURIComponent(ref);
        const ports=catalog.ports.filter(port=>port.release.repository===repository || port.project_url?.toLowerCase()==='https://github.com/'+repository.toLowerCase()).map(port=>port.id);
        const digests=catalog.source_catalog.qualification.filter(value=>ports.includes(value.scope.port_id)&&value.scope.upstream_ref===tag).map(value=>({digest:'sha256:'+value.scope.artifact_sha256}));
        return new Response(JSON.stringify({id:2,tag_name:tag,assets:github?digests:{links:digests}}),{headers:{'content-type':'application/json'}});
      }
      const github=url.startsWith('https://api.github.com/');
      const repository=decodeURIComponent(github?url.split('/repos/')[1]:url.split('/projects/')[1]);
      const id=repositoryIds.get((github?'github.com/':'gitlab.com/')+repository.toLowerCase())??1;
      return new Response(JSON.stringify({id,archived:false,...(github?{full_name:repository}:{path_with_namespace:repository})}),{headers:{'content-type':'application/json'}});
    };`,
      );
      const realCatalog: unknown = JSON.parse(
        await readFile(
          new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
          "utf8",
        ),
      );
      assert.ok(isRecord(realCatalog) && Array.isArray(realCatalog.ports));
      const realPorts: unknown[] = realCatalog.ports;
      const run = (args: string[], failure: boolean) =>
        spawnSync(
          process.execPath,
          [
            "--import",
            pathToFileURL(preload).href,
            "scripts/check-catalog-repositories.mts",
            ...args,
          ],
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
      const data: unknown = JSON.parse(failed.stdout);
      assert.ok(isRecord(data) && isRecord(data.coverage) && Array.isArray(data.observations));
      const values: unknown[] = data.observations;
      const observations = values.map((value) => {
        assert.ok(isRecord(value));
        return value;
      });
      const report = { ...data, coverage: data.coverage, observations };
      assert.equal(report.coverage.ports, realPorts.length);
      assert.equal(report.observations.length, report.coverage.repositories);
      assert.equal(report.coverage.attempted_repositories, report.coverage.repositories);
      assert.equal(
        report.coverage.unknown_repositories,
        1,
        JSON.stringify(
          report.observations
            .filter((value) => value.status === "unknown")
            .map((value) => ({
              repository: value.repository,
              ref: value.release_ref,
              reason: value.reason,
            })),
        ),
      );
      assert.equal(requiredFixture(report.observations.at(-1)).status, "reachable");
      const human = run([], true);
      assert.equal(human.status, 1, human.stderr);
      assert.match(human.stdout, /unknown \(transport/);
      assert.match(human.stdout, /Unassessed: upstream-continuity/);
      const good = run(["--json"], false);
      assert.equal(good.status, 0, good.stderr);
      const goodReport: unknown = JSON.parse(good.stdout);
      assert.ok(isRecord(goodReport));
      assert.equal(goodReport.outcome, "complete");
      const invalid = run(["--unexpected"], false);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, "");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
