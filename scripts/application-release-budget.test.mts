import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectApplicationJobBudget,
  readApplicationOpportunityRuns,
  applicationNativeJobMinutes,
  readApplicationJobBudget,
} from "./application-release-budget.mts";
import { applicationApi } from "./application-release-io.mts";
import {
  inspectApplicationRunCustody,
  readApplicationRunNotes,
  registerApplicationBudgetRun,
} from "./application-release-run.mts";
import { isRecord } from "./runtime-values.mts";
import { readFile } from "node:fs/promises";
import { sha256 } from "./application-release-io.mts";
import { guardApplicationReleaseSource } from "./application-release-private.mts";
import { releaseControlInputsFixture } from "./fixtures/release-control-inputs-fixture.mts";
import { applicationReleaseTrust } from "./application-release-policy.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";

const source = "a".repeat(40),
  run = "123",
  opportunity = "b".repeat(40);
const at = (seconds: number) =>
  new Date(Date.parse("2026-11-04T00:00:00Z") + seconds * 1000).toISOString();
const context = (attempt: number) => ({
  id: 123,
  run_attempt: attempt,
  head_sha: source,
  path: ".github/workflows/application-release.yml",
  event: "workflow_dispatch",
  run_started_at: at((attempt - 1) * 600),
});
const job = (name: string, start: number, seconds: number) => ({
  id: start + 1,
  run_id: 123,
  run_attempt: 1,
  head_sha: source,
  name,
  head_branch: "fixed-control",
  runner_id: start + 1,
  runner_name: "inert fixture",
  labels: ["fixture"],
  started_at: at(start),
  completed_at: at(start + seconds),
  status: "completed",
  conclusion: "success",
  steps: [
    {
      name: "inert data-only observation",
      started_at: at(start),
      completed_at: at(start + seconds),
      status: "completed",
      conclusion: "success",
    },
  ],
});
const jobs = (rows: unknown[]) => ({ total_count: rows.length, jobs: rows });

void test("native executed feed history survives copied rows and distinguishes unstarted skipped work", () => {
  const original = job("feed", 0, 2);
  const first = { context: context(1), jobs: jobs([original]) };
  const second = { context: context(2), jobs: jobs([{ ...original, id: 200, run_attempt: 2 }]) };
  const facts = inspectApplicationJobBudget([first, second], source, run);
  assert.equal(facts.feed_executions.length, 1);
  assert.equal(facts.feed_executions[0]!.attempt, 1);
  const skipped = inspectApplicationJobBudget(
    [{ context: context(1), jobs: jobs([{ ...original, conclusion: "skipped", steps: [] }]) }],
    source,
    run,
  );
  assert.equal(skipped.feed_executions.length, 0);
  const failed = inspectApplicationJobBudget(
    [{ context: context(1), jobs: jobs([{ ...original, conclusion: "failure" }]) }],
    source,
    run,
  );
  assert.equal(failed.feed_executions.length, 1);
});

void test("bootstrap cannot execute the ordinary preparation branch and each path reserves its actual five-minute publication tail", () => {
  const rows = [{ context: context(1), jobs: jobs([job("publication_prepare", 0, 2)]) }];
  const ordinary = inspectApplicationJobBudget(rows, source, run, true, "application-release");
  assert.equal(ordinary.actual_milliseconds, 2000);
  assert.throws(
    () => inspectApplicationJobBudget(rows, source, run, true, "metadata-bootstrap"),
    /unknown executing release job/u,
  );
  const app = inspectApplicationJobBudget(
    [{ context: context(1), jobs: jobs([]) }],
    source,
    run,
    true,
    "application-release",
  );
  const bootstrap = inspectApplicationJobBudget(
    [{ context: context(1), jobs: jobs([]) }],
    source,
    run,
    true,
    "metadata-bootstrap",
  );
  assert.equal(app.remaining_declared_minutes, 140);
  assert.equal(bootstrap.remaining_declared_minutes, 139);
});

void test("immutable recovery reserves only its remaining feed work, rejects payload work and preserves actual execution charges", () => {
  const rows = [{ context: context(1), jobs: jobs([]) }];
  const recovery = inspectApplicationJobBudget(
    rows,
    source,
    run,
    true,
    "application-release",
    "immutable-recovery",
  );
  assert.equal(recovery.remaining_declared_minutes, 38);
  assert.equal(recovery.maximum_minutes, 140);
  const earlier = inspectApplicationJobBudget(
    [
      {
        context: context(1),
        jobs: jobs([job("package / package", 0, 1800), job("native / execute", 1800, 1800)]),
      },
    ],
    source,
    run,
    false,
    "application-release",
  );
  assert.equal(earlier.actual_milliseconds, 3600000);
  assert.equal(earlier.remaining_declared_minutes, 0);
  for (const name of [
    "package / package",
    "native / execute",
    "payload / execute",
    "timestamp / execute",
    "publication",
  ]) {
    assert.throws(
      () =>
        inspectApplicationJobBudget(
          [{ context: context(1), jobs: jobs([job(name, 0, 1)]) }],
          source,
          run,
          true,
          "application-release",
          "immutable-recovery",
        ),
      /release path cannot execute or copy/u,
    );
  }
  for (const name of ["package / package", "native / execute", "payload / execute"]) {
    assert.throws(
      () =>
        inspectApplicationJobBudget(
          [{ context: context(1), jobs: jobs([job(name, 0, 1)]) }],
          source,
          run,
          true,
          "metadata-renewal",
          "metadata-maintenance",
        ),
      /release path cannot execute or copy/u,
    );
  }
  assert.throws(
    () =>
      inspectApplicationJobBudget(
        [{ context: context(1), jobs: jobs([job("tools", 0, 140 * 60)]) }],
        source,
        run,
        true,
        "application-release",
        "immutable-recovery",
      ),
    /exceeds application140/u,
  );
  assert.throws(() =>
    inspectApplicationJobBudget(
      rows,
      source,
      run,
      true,
      "metadata-bootstrap",
      "immutable-recovery",
    ),
  );
  assert.throws(() =>
    inspectApplicationJobBudget(rows, source, run, true, "application-release", "unknown"),
  );
});

void test("metadata recovery reserves only the existing feed tail and cannot execute signing or publication", () => {
  const rows = [{ context: context(1), jobs: jobs([]) }];
  const recovery = inspectApplicationJobBudget(
    rows,
    source,
    run,
    true,
    "metadata-renewal",
    "metadata-recovery",
  );
  assert.equal(recovery.remaining_declared_minutes, 38);
  assert.equal(recovery.maximum_minutes, 140);
  for (const name of [
    "context / execute",
    "releases / execute",
    "snapshot / execute",
    "timestamp / execute",
    "publication",
    "package / package",
    "native / execute",
    "payload / execute",
  ])
    assert.throws(
      () =>
        inspectApplicationJobBudget(
          [{ context: context(1), jobs: jobs([job(name, 0, 1)]) }],
          source,
          run,
          true,
          "metadata-renewal",
          "metadata-recovery",
        ),
      /release path cannot execute or copy/u,
    );
  assert.throws(() =>
    inspectApplicationJobBudget(
      rows,
      source,
      run,
      true,
      "application-release",
      "metadata-recovery",
    ),
  );
});

void test("native budget charges actual failed/repeated work and deduplicates only proven copied successes", () => {
  assert.ok(
    Object.values(applicationNativeJobMinutes).reduce((sum, value) => sum + value, 0) <= 140,
  );
  const original = [
    job("source", 0, 2),
    job("tools", 2, 10),
    job("package / package", 12, 30),
    job("package / provenance", 42, 2),
  ];
  const first = { context: context(1), jobs: jobs(original) };
  const copied = original.map((value) => ({ ...value, id: value.id + 1000, run_attempt: 2 }));
  const second = { context: context(2), jobs: jobs(copied) };
  const result = inspectApplicationJobBudget([first, second], source, run);
  assert.equal(result.actual_milliseconds, 44000);
  assert.equal(result.copied_successful_observations, 4);
  assert.equal(result.reservation, false);
  assert.equal(result.headroom, "unknown");
  const repeated = copied.map((value) => ({
    ...value,
    started_at: at(600),
    completed_at: at(610),
  }));
  const actual = inspectApplicationJobBudget(
    [first, { context: context(2), jobs: jobs(repeated) }],
    source,
    run,
  );
  assert.equal(actual.copied_successful_observations, 0);
  assert.equal(actual.actual_milliseconds, 84000);
  assert.throws(() =>
    inspectApplicationJobBudget(
      [{ context: context(1), jobs: jobs([job("unknown", 0, 1)]) }],
      source,
      run,
    ),
  );
  assert.throws(() =>
    inspectApplicationJobBudget(
      [{ context: context(1), jobs: { total_count: 2, jobs: [original[0]] } }],
      source,
      run,
    ),
  );
});

function runRow(id: number, title = `Application ${opportunity}`) {
  return {
    id,
    display_title: title,
    path: ".github/workflows/application-release.yml",
    event: "workflow_dispatch",
    head_sha: source,
    repository: { id: 1354613114 },
    head_repository: { id: 1354613114 },
  };
}
function provider(pages: ReturnType<typeof page>[]) {
  let index = 0;
  return {
    async workflow() {
      return { id: 7, path: ".github/workflows/application-release.yml" };
    },
    async runs() {
      const value = pages[index++];
      assert.ok(value, "unexpected provider request");
      return value;
    },
  };
}
const page = (rows: unknown[] | null, total = rows?.length ?? 0, next: string | null = null) => ({
  next,
  body: { total_count: total, workflow_runs: rows },
});
const alias =
  "https://api.github.com/repositories/1354613114/actions/workflows/7/runs?event=workflow_dispatch&per_page=100&page=2";

void test("opportunity traversal covers empty, single and numeric-alias multi-page histories", async () => {
  assert.deepEqual(await readApplicationOpportunityRuns(provider([page([])]), opportunity), []);
  assert.equal(
    (await readApplicationOpportunityRuns(provider([page([runRow(1)])]), opportunity)).length,
    1,
  );
  const unrelated = Array.from({ length: 100 }, (_, index) =>
    runRow(index + 1, "ordinary qualification"),
  );
  const observed = await readApplicationOpportunityRuns(
    provider([page(unrelated, 101, alias), page([runRow(101)], 101)]),
    opportunity,
  );
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.id, 101);
});

void test("automatic wake title is counted in the same opportunity as manual production", async () => {
  const title = `Application ${opportunity} wake 42`;
  const rows = [
    runRow(1),
    runRow(2, title),
    runRow(3, `${title} extra`),
    runRow(4, `Application ${opportunity} wake 042`),
  ];
  assert.deepEqual(
    (await readApplicationOpportunityRuns(provider([page(rows)]), opportunity)).map(
      (run) => run.id,
    ),
    [1, 2],
  );
});

void test("incomplete, stalled, duplicate, foreign, changing or capped histories cannot reset a release budget", async () => {
  const initial = Array.from({ length: 100 }, (_, index) => runRow(index + 1));
  for (const pages of [
    [page([], 1000)],
    [page([], 1)],
    [page(initial, 101, alias), page([runRow(101)], 102)],
    [page(initial, 101, alias), page([runRow(1)], 101)],
    [page(initial, 101, "https://example.com/foreign")],
    [
      page(
        initial,
        101,
        "https://api.github.com/repos/boburning/portcove/actions/workflows/application-release.yml/runs?event=workflow_dispatch&per_page=100",
      ),
    ],
    [page([{ ...runRow(1), repository: { id: 1 } }])],
    [page(null, 1)],
  ])
    await assert.rejects(readApplicationOpportunityRuns(provider(pages), opportunity));
});

void test("forward metadata maintenance counts original executions, refuses missing parent history and keeps the shared cap and attempts", async (t) => {
  const basis = {
    schema_version: 1,
    kind: "application-metadata-renewal-basis",
    root_sha256: applicationReleaseTrust.root.sha256,
    repository_sha256: "d".repeat(64),
    site_generation: "f".repeat(64),
  };
  const child = releaseCanonicalDigest(basis),
    parent = "e".repeat(40);
  const ref = "refs/tags/portcove-production-controller-windows-fixture";
  const workflow = sha256(await readFile(".github/workflows/application-release.yml"));
  const environment = {
    GH_TOKEN: "synthetic-budget-reader",
    PORTCOVE_APPLICATION_RELEASE_REVISION: source,
    PORTCOVE_APPLICATION_RELEASE_REF: ref,
    PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY: child,
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: ref,
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: source,
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_WORKFLOW_REF: `boburning/portcove/.github/workflows/application-release.yml@${ref}`,
    GITHUB_RUN_ID: "124",
    GITHUB_RUN_ATTEMPT: "1",
    PORTCOVE_APPLICATION_RELEASE_ACTIVE: "true",
    PORTCOVE_APPLICATION_RELEASE_WORKFLOW_SHA256: workflow,
    PORTCOVE_KNOWN_RELEASE_RUNS: '["124"]',
    PORTCOVE_APPLICATION_RELEASE_SPENDING: JSON.stringify({
      budget_id: "4a6859d9-fdb7-4da2-afd3-acbdc9848eec",
      scope: "account",
      amount_usd: 0,
      stop_usage: true,
      operator_id: 43177418,
      application_minutes: 140,
      catalog_minutes: 40,
      workflow_sha256: workflow,
    }),
  };
  const priorEnvironment = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of priorEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const actor = { id: "123", control_commit: source, control_ref: ref };
  const owner = inspectApplicationRunCustody({
    schema_version: 2,
    kind: "application-release-run-custody",
    source,
    source_tree: "b".repeat(40),
    opportunity: parent,
    preparation: null,
    runs: [actor],
    budget: { kind: "owner", scopes: [{ opportunity: child, run_ids: ["124"] }] },
  });
  const member = inspectApplicationRunCustody({
    ...owner,
    opportunity: child,
    runs: [{ ...actor, id: "124" }],
    budget: { kind: "member", owner_release_id: 10, owner_opportunity: parent },
  });
  let mode = "valid",
    recordWrites = 0;
  let ownerState = owner;
  const pause = releaseControlInputsFixture(undefined, undefined, undefined, false);
  t.mock.method(applicationApi, "graphql", pause.api.graphql.bind(pause.api));
  t.mock.method(applicationApi, "request", (method: string, endpoint: string, input?: unknown) => {
    if (method === "PATCH") {
      assert.equal(endpoint, "repos/boburning/portcove/releases/10");
      assert.ok(isRecord(input));
      assert.deepEqual(Object.keys(input), ["body"]);
      const parsed = readApplicationRunNotes(input.body);
      assert.ok(parsed);
      ownerState = parsed.custody;
      recordWrites++;
      return { status: 200, headers: new Map<string, string>(), body: {} };
    }
    assert.equal(method, "GET");
    const suffix = endpoint.replace(/^repos\/boburning\/portcove\//u, "");
    let body: unknown;
    if (endpoint === "repos/boburning/portcove" || suffix.startsWith("git/"))
      return pause.api.request(method, endpoint, input);
    if (suffix === "releases/11")
      body = {
        id: 11,
        target_commitish: source,
        body: `<!-- portcove-application-runs-v1\n${JSON.stringify(member)}\n-->`,
      };
    else if (suffix === "releases/10")
      body = {
        id: 10,
        target_commitish: source,
        body: `<!-- portcove-application-runs-v1\n${JSON.stringify(ownerState)}\n-->`,
      };
    else throw new Error(`unexpected legacy request: ${suffix}`);
    return { status: 200, headers: new Map<string, string>(), body };
  });
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
    assert.ok(typeof input === "string");
    const url = new URL(input);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init.method, "GET");
    assert.equal(new Headers(init.headers).get("authorization"), "token synthetic-budget-reader");
    const suffix = (url.pathname + url.search).replace(/^\/repos\/boburning\/portcove\//u, "");
    let body: unknown;
    if (suffix === "actions/workflows/application-release.yml")
      body = { id: 7, path: ".github/workflows/application-release.yml" };
    else if (
      suffix ===
      "actions/workflows/application-release.yml/runs?event=workflow_dispatch&per_page=100"
    ) {
      const rows = [
        {
          ...runRow(123, `Application ${parent}`),
          status: mode === "queued" ? "queued" : "completed",
          run_attempt: mode === "attempts" ? 3 : 1,
        },
        { ...runRow(124, `Application ${child}`), status: "in_progress", run_attempt: 1 },
      ];
      if (mode === "missing") rows.shift();
      if (mode === "newer-active")
        rows.push({
          ...runRow(125, `Application ${parent}`),
          status: "in_progress",
          run_attempt: 1,
        });
      if (mode === "pending-member")
        rows.push({ ...runRow(125, `Application ${child}`), status: "completed", run_attempt: 1 });
      if (mode === "multipage") {
        const fullPage = [
          ...rows,
          ...Array.from({ length: 98 }, (_, index) => runRow(1000 + index, "unrelated")),
        ];
        return Response.json(
          { total_count: 101, workflow_runs: fullPage },
          { headers: { link: `<${alias}>; rel="next"` } },
        );
      }
      body = { total_count: rows.length, workflow_runs: rows };
    } else if (mode === "multipage" && url.href === alias) {
      body = { total_count: 101, workflow_runs: [runRow(1100, "unrelated")] };
    } else {
      const match =
        /^actions\/runs\/(123|124|125)\/attempts\/([1-3])(\/jobs\?per_page=100)?$/u.exec(suffix);
      assert.ok(match, suffix);
      const id = Number(match[1]),
        attempt = Number(match[2]);
      if (!match[3])
        body = {
          ...context(attempt),
          id,
          run_started_at: at(id === 124 ? 5000 : (attempt - 1) * 2000),
        };
      else if (id === 124) body = jobs([]);
      else if (id === 125) body = jobs([{ ...job("source", 1900, 120), run_id: 125 }]);
      else if (attempt > 1) body = jobs([]);
      else
        body = jobs(
          mode === "over-cap"
            ? [
                job("native / execute", 0, 1980),
                job("package / package", 1980, 1800),
                job("tools", 3780, 600),
                job("payload / execute", 4380, 300),
              ]
            : [job("native / execute", 0, 1800)],
        );
    }
    return Response.json(body);
  });
  const inspect = () =>
    readApplicationJobBudget(["124"], "metadata-renewal", "metadata-maintenance", {
      release_id: 11,
      custody: member,
    });
  const result = await inspect();
  assert.equal(result.actual_milliseconds, 1800000);
  assert.equal(result.remaining_declared_minutes, 66);
  assert.equal(result.attempts, 2);
  assert.equal(result.maximum_minutes, 140);
  assert.deepEqual(new Set(result.opportunities), new Set([child, parent]));
  mode = "multipage";
  assert.deepEqual(await inspect(), result);
  mode = "valid";
  const roleSource = {
    purpose: "metadata-renewal",
    execution_path: "metadata-maintenance",
    opportunity: child,
    renewal_basis: basis,
    renewal_generated_at: "2026-11-04T00:00:00Z",
    run_custody: { release_id: 11, custody: member },
  };
  const roleGuard = () => guardApplicationReleaseSource(roleSource, false);
  const guarded = await roleGuard();
  assert.equal(guarded.budget.actual_milliseconds, 1800000);
  assert.equal(guarded.budget.attempts, 2);
  const recovered = await guardApplicationReleaseSource(
    { ...roleSource, execution_path: "metadata-recovery" },
    false,
  );
  assert.equal(recovered.budget.actual_milliseconds, 1800000);
  assert.equal(recovered.budget.remaining_declared_minutes, 38);
  assert.equal(recovered.budget.attempts, 2);
  ownerState = inspectApplicationRunCustody({
    ...owner,
    budget: { kind: "owner", scopes: [{ opportunity: child, run_ids: ["124", "125"] }] },
  });
  mode = "pending-member";
  const pendingMember = await inspect();
  assert.equal(
    pendingMember.actual_milliseconds,
    1920000,
    "an interrupted member append cannot erase its extra owner's actual source work",
  );
  assert.equal(pendingMember.attempts, 3);
  mode = "valid";
  await assert.rejects(
    inspect,
    /recorded related execution missing/u,
    "pending cost IDs remain mandatory even before member registration completes",
  );
  ownerState = owner;
  mode = "missing";
  await assert.rejects(inspect, /recorded related execution missing/u);
  await assert.rejects(roleGuard, /recorded related execution missing/u);
  mode = "over-cap";
  await assert.rejects(inspect, /exceed application140/u);
  await assert.rejects(roleGuard, /exceed application140/u);
  mode = "attempts";
  await assert.rejects(inspect, /exhausted its bounded attempts/u);
  mode = "queued";
  await assert.rejects(inspect, /pending related release execution/u);
  mode = "newer-active";
  await assert.rejects(inspect, /another related release execution is still active/u);
  const { budget: omittedBudget, ...legacyOwner } = owner;
  assert.ok(omittedBudget);
  ownerState = inspectApplicationRunCustody({ ...legacyOwner, schema_version: 1 });
  mode = "over-cap";
  await registerApplicationBudgetRun(
    applicationApi,
    { release_id: 10, custody: ownerState },
    child,
    { source, ref, run_id: "124", run_attempt: 1 },
    async () => {},
  );
  assert.equal(recordWrites, 1);
  assert.equal(ownerState.budget?.kind, "owner");
  await assert.rejects(inspect, /exceed application140/u);
  assert.ok(
    ownerState.budget?.kind === "owner" &&
      ownerState.budget.scopes.some(
        (scope) => scope.opportunity === child && scope.run_ids.includes("124"),
      ),
    "refused maintenance run stays in the original cost record",
  );
});
