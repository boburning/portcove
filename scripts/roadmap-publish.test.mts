import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { writeMaintainedRoadmapReport } from "./roadmap-publish.mts";
import {
  mergeRoadmapObservations,
  observationFromReceipt,
  renderRoadmapReport,
  reportDigest,
  unavailableRoadmapStateReport,
} from "./roadmap-report.mts";
import type { RoadmapReportState } from "./roadmap-report.mts";

void test("production publisher maintains one comment for eight results and rejects stale publication", async () => {
  let comment: { id: number; body: string; user: { type: string; login: string } } | undefined;
  let posts = 0,
    patches = 0,
    reads = 0;
  const write = async (method: "POST" | "PATCH", body: string) => {
    if (method === "POST") posts++;
    else patches++;
    comment = { id: 1, body, user: { type: "Bot", login: "github-actions[bot]" } };
    return comment;
  };
  const api = {
    comments: async () => (comment ? [comment] : []),
    create: (body: string) => write("POST", body),
    replace: (_id: number, body: string) => write("PATCH", body),
    comment: async (_id: number) => {
      reads++;
      return comment;
    },
  };
  let state: RoadmapReportState = {
    format_version: 1,
    cursor: "2026-10-24T00:00:00Z",
    observations: {},
    publication_gaps: [],
  };
  const preimage = () => (comment ? { id: comment.id, body: comment.body } : null);
  const render = () =>
    renderRoadmapReport(state, {
      run: 99,
      attempt: 1,
      repository: "boburning/portcove",
      sha256: reportDigest(JSON.stringify(state)),
    });
  for (let issue = 1; issue <= 8; issue++) {
    state = mergeRoadmapObservations(
      state,
      observationFromReceipt(
        {
          status: "failed",
          coverage: "complete",
          scope: { kind: "issues", issues: [issue] },
          errors: ["Missing metadata"],
          observation: { started_at: "2026-10-24T01:00:00Z" },
        },
        issue,
        1,
        "boburning/portcove",
      ),
    );
    await writeMaintainedRoadmapReport(render(), preimage(), api);
  }
  assert.equal(posts, 1);
  assert.equal(patches, 7);
  assert.equal(reads, 8);
  assert.equal(Object.keys(state.observations).length, 8);
  const stale = preimage();
  state = mergeRoadmapObservations(
    state,
    observationFromReceipt(
      {
        status: "passed",
        coverage: "complete",
        scope: { kind: "issues", issues: [1], checked_issues: [1] },
        observation: { started_at: "2026-10-24T02:00:00Z" },
      },
      10,
      1,
      "boburning/portcove",
    ),
  );
  await writeMaintainedRoadmapReport(render(), preimage(), api);
  assert.equal(state.observations["issue:1"]?.status, "passed");
  assert.equal(state.observations["issue:2"]?.status, "needs_attention");
  await assert.rejects(
    () => writeMaintainedRoadmapReport(render(), stale, api),
    /changed outside/u,
  );
  const before = patches;
  await writeMaintainedRoadmapReport(render(), preimage(), api);
  assert.equal(patches, before);
  assert.equal(posts, 1);
  const historical = render();
  const unavailable = unavailableRoadmapStateReport(historical, "Referenced artifact expired");
  await writeMaintainedRoadmapReport(unavailable, preimage(), api);
  assert.equal(posts, 1, "Unavailable state updates the same maintained comment");
  assert.equal(comment?.body.split("\n")[0], historical.split("\n")[0]);
  assert.match(comment?.body ?? "", /\*\*Unable to verify\*\*/u);
});

void test("publisher accepts GitHub's numeric repository links only for its paginated reads", async () => {
  const { allowRoadmapPublicationRequest } = await import("./roadmap-publish.mts");
  const allowed = (method: string, route: string) =>
    allowRoadmapPublicationRequest(method, new URL(route, "https://api.github.com"));
  const alias = "/repositories/1354613114";
  for (const route of [
    "/issues/2414/comments",
    "/actions/runs/42/artifacts",
    "/actions/workflows/roadmap-report.yml/runs",
  ]) {
    assert.equal(allowed("GET", alias + route + "?page=2"), true);
    assert.equal(allowed("POST", alias + route), false);
    assert.equal(allowed("GET", "/repositories/42" + route), false);
  }
  assert.equal(allowed("PATCH", alias + "/issues/comments/7"), false);
  assert.equal(allowed("GET", alias + "/actions/runs/42"), false);
  assert.equal(allowed("GET", alias + "/issues/2415/comments"), false);
});

void test("publisher SDK adapter traverses real pages, sends one mutation, then verifies readback", async () => {
  const { fixtureGitHub } = await import("./fixtures/github-sdk-fixtures.mts");
  const { allowRoadmapPublicationRequest, createPublicationApi } =
    await import("./roadmap-publish.mts");
  const before = `${"<!-- portcove-roadmap-report:"}{} -->\nold`,
    after = before + "\nupdated";
  const row = (body: string) => ({
    id: 7,
    body,
    user: { type: "Bot", login: "github-actions[bot]" },
  });
  const calls: string[] = [];
  let current = before;
  const sdk = await fixtureGitHub(
    ({ method, endpoint, body }) => {
      calls.push(`${method} ${endpoint}`);
      if (endpoint === "repos/boburning/portcove/issues/2414/comments?per_page=100")
        return Response.json(
          [{ id: 1, user: { type: "User", login: "person" }, body: "ordinary" }],
          {
            headers: {
              link: '<https://api.github.com/repositories/1354613114/issues/2414/comments?per_page=100&page=2>; rel="next"',
            },
          },
        );
      if (endpoint.endsWith("&page=2")) return [row(current)];
      assert.equal(endpoint, "repos/boburning/portcove/issues/comments/7");
      if (method === "PATCH") {
        assert.deepEqual(body, { body: after });
        current = after;
      } else assert.equal(method, "GET");
      return row(current);
    },
    { allowRequest: allowRoadmapPublicationRequest },
  );
  assert.equal(
    await writeMaintainedRoadmapReport(after, { id: 7, body: before }, createPublicationApi(sdk)),
    7,
  );
  assert.deepEqual(
    calls.map((call) => call.split(" ")[0]),
    ["GET", "GET", "PATCH", "GET"],
  );
});

void test("publisher refuses duplicate paginated identities before mutation", async () => {
  const { fixtureGitHub } = await import("./fixtures/github-sdk-fixtures.mts");
  const { createPublicationApi } = await import("./roadmap-publish.mts");
  let calls = 0;
  const sdk = await fixtureGitHub(({ method }) => {
    assert.equal(method, "GET");
    calls++;
    return Response.json(
      [{ id: 1 }],
      calls === 1
        ? {
            headers: {
              link: '<https://api.github.com/repos/boburning/portcove/issues/2414/comments?page=2>; rel="next"',
            },
          }
        : {},
    );
  });
  await assert.rejects(createPublicationApi(sdk).comments(), /duplicate identity/u);
  assert.equal(calls, 2);
});

void test("publisher never replays an ambiguous SDK comment write", async () => {
  const { fixtureGitHub } = await import("./fixtures/github-sdk-fixtures.mts");
  const { createPublicationApi } = await import("./roadmap-publish.mts");
  let writes = 0;
  const sdk = await fixtureGitHub(({ method }) => {
    if (method === "GET") return [];
    assert.equal(method, "POST");
    writes++;
    return Response.json({ message: "ambiguous write" }, { status: 503 });
  });
  await assert.rejects(
    writeMaintainedRoadmapReport(
      "<!-- portcove-roadmap-report:{} -->",
      null,
      createPublicationApi(sdk),
    ),
    /ambiguous write/u,
  );
  assert.equal(writes, 1);
});

void test("hosted publisher replays exact archive IDs and verifies the uploaded snapshot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "roadmap-publisher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "work", "roadmap-publisher");
  const entry = new URL("./roadmap-publish.mts", import.meta.url);
  const previous = JSON.stringify({
    format_version: 1,
    cursor: "2026-10-24T00:00:00Z",
    observations: {},
    publication_gaps: [],
  });
  const body = `<!-- portcove-roadmap-report:${JSON.stringify({ run: 40, attempt: 2, sha256: reportDigest(previous) })} -->\nprevious`;
  const diagnostic = JSON.stringify({
    format_version: 1,
    run: 45,
    attempt: 3,
    report: {
      status: "failed",
      coverage: "complete",
      scope: { kind: "issues", issues: [17] },
      errors: ["missing metadata"],
      observation: { started_at: "2026-10-24T01:00:00Z" },
    },
  });
  const uuid = "85fd3cc1-e8c5-4fa9-90a3-624cdf137eb8";
  const state = createAuditZip([["state.json", previous, { descriptor: true }]]);
  const companion = `roadmap-health/${uuid}/stdout.txt`;
  const oversizedName = createAuditZip([["roadmap-health/publication.json", diagnostic]]);
  const central = oversizedName.readUInt32LE(oversizedName.length - 6);
  oversizedName.writeUInt16LE(129, central + 28);
  const archives = {
    valid: createAuditZip([
      ["roadmap-health/publication.json", diagnostic],
      [companion, diagnostic, { descriptor: true }],
      [`roadmap-doctor/${uuid}.json`, diagnostic],
      [`roadmap-diagnostics/membership-${uuid}/report.json`, diagnostic],
    ]),
    unknown: createAuditZip([
      ["roadmap-health/publication.json", diagnostic],
      ["roadmap-health/unknown.json", "{}"],
    ]),
    symlink: createAuditZip([
      ["roadmap-health/publication.json", diagnostic],
      [companion, "publication.json", { attributes: 0xa1ff0000 }],
    ]),
    metadata: oversizedName,
  };
  const run = async (
    operation: "prepare" | "publish",
    variant: keyof typeof archives | "size" = "valid",
  ) => {
    const trace = path.join(root, `${operation}-${variant}.log`);
    const preload = `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      import { appendFileSync, readFileSync } from "node:fs";
      import { createAuditZip } from ${JSON.stringify(new URL("./fixtures/audit-zip-fixture.mts", import.meta.url).href)};
      const urlModule = "data:text/javascript," + encodeURIComponent(
        'import { fileURLToPath as original } from "node:url"; export const fileURLToPath = (url) => url.href === ' +
        ${JSON.stringify(JSON.stringify(new URL("..", entry).href))} + ' ? ' +
        ${JSON.stringify(JSON.stringify(root))} + ' : original(url);'
      );
      registerHooks({ resolve(specifier, context, next) {
        return specifier === "node:url" && context.parentURL === ${JSON.stringify(entry.href)}
          ? { url: urlModule, shortCircuit: true } : next(specifier, context);
      } });
      const state = Buffer.from(${JSON.stringify(state.toString("base64"))}, "base64");
      const diagnostics = Buffer.from(${JSON.stringify(archives[variant === "size" ? "valid" : variant].toString("base64"))}, "base64");
      let current = ${JSON.stringify(body)};
      const zip = { 400: state, 450: diagnostics };
      if (${JSON.stringify(operation)} === "publish")
        zip[500] = createAuditZip([["state.json", readFileSync(${JSON.stringify(path.join(output, "state.json"))})]]);
      const publication = { path: ".github/workflows/roadmap-report.yml", head_branch: "main" };
      const row = () => ({ id: 7, body: current, user: { type: "Bot", login: "github-actions[bot]" } });
      const artifact = (id, name, run) => ({
        id, name, expired: false,
        size_in_bytes: zip[id].length + (id === 450 && ${variant === "size"} ? 1 : 0),
        workflow_run: { id: run, repository_id: 1354613114 },
        archive_download_url: "https://example.invalid/unadmitted",
      });
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const route = url.pathname.replace(/^\\/(?:repos\\/boburning\\/portcove|repositories\\/1354613114)/, "");
        appendFileSync(${JSON.stringify(trace)}, init.method + " " + route + url.search + "\\n");
        const token = new Headers(init.headers).get("authorization");
        if (url.origin === "https://productionresultssa1.blob.core.windows.net") {
          assert.equal(token, null);
          assert.equal(init.credentials, "omit");
          assert.equal(init.redirect, "manual");
          assert.equal(url.search, "?sig=fixture");
          return new Response(zip[Number(url.pathname.split("/").at(-1))]);
        }
        assert.equal(url.origin, "https://api.github.com");
        assert.equal(token, "token fixture-publisher");
        assert.equal(init.redirect, "manual");
        if (route === "/issues/2414/comments") return Response.json([row()]);
        if (route === "/issues/comments/7") {
          if (init.method === "PATCH") current = JSON.parse(init.body).body;
          return Response.json(row());
        }
        if (route === "/actions/runs/40/attempts/2")
          return Response.json({ ...publication, id: 40, run_attempt: 2 });
        if (route === "/actions/runs/40/artifacts") {
          const artifact400 = artifact(400, "roadmap-report-state-40-2", 40);
          return url.searchParams.has("page")
            ? Response.json({ total_count: 2, artifacts: [artifact400] })
            : Response.json({ total_count: 2, artifacts: [{ ...artifact400, id: 399, name: "roadmap-report-state-40-3" }] },
                { headers: { link: '<https://api.github.com/repositories/1354613114/actions/runs/40/artifacts?per_page=100&page=2>; rel="next"' } });
        }
        if (route === "/actions/workflows/roadmap-report.yml/runs")
          return Response.json({ total_count: 0, workflow_runs: [] });
        if (route === "/actions/runs/50")
          return Response.json({ ...publication, id: 50, event: "workflow_run",
            display_title: "Roadmap publication 45 / 3", created_at: "2026-10-24T02:00:00Z" });
        if (route === "/actions/runs/45/attempts/3")
          return Response.json({ id: 45, run_attempt: 3, path: ".github/workflows/roadmap-health.yml",
            head_branch: "main", event: "issues", status: "completed" });
        if (route === "/actions/runs/45/artifacts")
          return Response.json({ total_count: 1, artifacts: [artifact(450, "roadmap-diagnostics-45-3", 45)] });
        if (route === "/actions/runs/50/artifacts")
          return Response.json({ total_count: 1, artifacts: [artifact(500, "roadmap-report-state-50-4", 50)] });
        const match = route.match(/^\\/actions\\/artifacts\\/(400|450|500)\\/zip$/);
        assert.ok(match, "unexpected request " + route);
        return new Response(null, { status: 302,
          headers: { location: "https://productionresultssa1.blob.core.windows.net/actions-results/" + match[1] + "?sig=fixture" } });
      };
    `;
    execFileSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        fileURLToPath(entry),
        operation,
      ],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          PATH: "",
          GH_TOKEN: "fixture-publisher",
          GITHUB_TOKEN: "fixture-unselected",
          GITHUB_RUN_ID: "50",
          GITHUB_RUN_ATTEMPT: "4",
          GITHUB_OUTPUT: "",
        },
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.ok((await readdir(output)).every((name) => !name.startsWith("download-")));
    return (await readFile(trace, "utf8")).split("\n").filter(Boolean);
  };
  const prepared = await run("prepare");
  assert.deepEqual(
    prepared.filter((line) => line.endsWith("/zip")),
    ["GET /actions/artifacts/400/zip", "GET /actions/artifacts/450/zip"],
  );
  const stateFile = path.join(output, "state.json");
  const selected = JSON.parse(await readFile(stateFile, "utf8")) as RoadmapReportState;
  assert.equal(selected.observations["issue:17"]?.attempt, 3);
  assert.deepEqual(selected.publication_gaps, []);
  const published = await run("publish");
  assert.deepEqual(published, [
    "GET /actions/runs/50/artifacts?per_page=100",
    "GET /actions/artifacts/500/zip",
    "GET /actions-results/500?sig=fixture",
    "GET /issues/2414/comments?per_page=100",
    "PATCH /issues/comments/7",
    "GET /issues/comments/7",
  ]);
  for (const [variant, refusal] of [
    ["unknown", /path or collision/u],
    ["symlink", /nonregular entry/u],
    ["metadata", /name or metadata limit/u],
    ["size", /byte count differs/u],
  ] as const) {
    await run("prepare", variant);
    const rejected = JSON.parse(await readFile(stateFile, "utf8")) as RoadmapReportState;
    assert.deepEqual(rejected.observations, {});
    assert.match(rejected.publication_gaps[0] ?? "", refusal);
  }
});
