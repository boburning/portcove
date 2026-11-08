import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectApplicationJobBudget,
  readApplicationOpportunityRuns,
  applicationNativeJobMinutes,
  readApplicationJobBudget,
  permitsEmptyBootstrapContinuation,
  permitsRetainedServedRenewalContinuation,
  permitsBudgetedEmptyBootstrap,
  readBootstrapRecoveryObservations,
} from "./application-release-budget.mts";
import {
  inspectApplicationRunCustody,
  readApplicationRunNotes,
  registerApplicationBudgetRun,
  createApplicationRunRegistrationProvider,
  immutableApplicationBootstrap,
  failedBootstrapRecovery,
  retainedServedRenewal,
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

void test("bootstrap recovery reads at most four attempt and job requests concurrently", async () => {
  let active = 0;
  let maximum = 0;
  const calls: string[] = [];
  const read = async (route: string, runId: number, attempt: number) => {
    assert.equal(attempt, 1);
    const label = `${route}-${runId}`;
    calls.push(label);
    maximum = Math.max(maximum, ++active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return label;
  };
  const provider = {
    attempt: (runId: number, attempt: number) => read("attempt", runId, attempt),
    jobs: (runId: number, attempt: number) => read("jobs", runId, attempt),
  };
  const result = await readBootstrapRecoveryObservations(provider, [8, 4, 6]);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.deepEqual(
    [...result],
    [
      [8, { context: "attempt-8", jobs: "jobs-8" }],
      [4, { context: "attempt-4", jobs: "jobs-4" }],
      [6, { context: "attempt-6", jobs: "jobs-6" }],
    ],
  );
  calls.length = 0;
  await assert.rejects(
    () =>
      readBootstrapRecoveryObservations(
        {
          ...provider,
          async attempt(runId, attempt) {
            const observed = await provider.attempt(runId, attempt);
            if (runId === 8) throw new Error("inert provider refusal");
            return observed;
          },
        },
        [8, 4, 6],
      ),
    /inert provider refusal/u,
  );
  assert.deepEqual(calls, ["attempt-8", "jobs-8", "attempt-4", "jobs-4"]);
  assert.equal(active, 0);
});

void test("native executed feed history survives copied rows and distinguishes unstarted skipped work", () => {
  const original = job("feed", 0, 2);
  const first = { context: context(1), jobs: jobs([original]) };
  const second = { context: context(2), jobs: jobs([{ ...original, id: 200, run_attempt: 2 }]) };
  const facts = inspectApplicationJobBudget([first, second], source, run);
  assert.equal(facts.feed_executions.length, 1);
  assert.equal(facts.feed_executions[0]!.attempt, 1);
  assert.equal(facts.feed_executions[0]!.job_id, original.id);
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

void test("bootstrap charges its draft preparation without extending the reservation or admitting payload work", () => {
  const rows = [{ context: context(1), jobs: jobs([job("publication_prepare", 0, 2)]) }];
  const ordinary = inspectApplicationJobBudget(rows, source, run, true, "application-release");
  assert.equal(ordinary.actual_milliseconds, 2000);
  const preparedBootstrap = inspectApplicationJobBudget(
    rows,
    source,
    run,
    true,
    "metadata-bootstrap",
  );
  assert.equal(preparedBootstrap.actual_milliseconds, 2000);
  assert.equal(preparedBootstrap.remaining_declared_minutes, 56);
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
  assert.equal(bootstrap.remaining_declared_minutes, 59);
  for (const name of [
    "package / package",
    "protection_payload / execute",
    "payload / execute",
    "native / execute",
    "public_installed",
    "targets / execute",
  ])
    assert.throws(
      () =>
        inspectApplicationJobBudget(
          [{ context: context(1), jobs: jobs([job(name, 0, 2)]) }],
          source,
          run,
          true,
          "metadata-bootstrap",
        ),
      /unknown executing release job/u,
    );
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
  let allowMemberDraft = true;
  const ownerRelease = () => ({
    id: 10,
    target_commitish: source,
    body: `<!-- portcove-application-runs-v1\n${JSON.stringify(ownerState)}\n-->`,
  });
  let pause = releaseControlInputsFixture(undefined, undefined, undefined, false);
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
    assert.ok(typeof input === "string");
    const url = new URL(input);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(new Headers(init.headers).get("authorization"), "token synthetic-budget-reader");
    if (init.method === "PATCH") {
      assert.equal(url.pathname, "/repos/boburning/portcove/releases/10");
      assert.ok(typeof init.body === "string");
      const body: unknown = JSON.parse(init.body);
      assert.ok(isRecord(body));
      assert.deepEqual(Object.keys(body), ["body"]);
      const parsed = readApplicationRunNotes(body.body);
      assert.ok(parsed);
      ownerState = parsed.custody;
      recordWrites++;
      throw new TypeError("fixture lost the cost-owner PATCH acknowledgement");
    }
    if (url.pathname === "/graphql") {
      assert.equal(init.method, "POST");
      assert.ok(typeof init.body === "string");
      const body: unknown = JSON.parse(init.body);
      assert.ok(isRecord(body) && typeof body.query === "string" && isRecord(body.variables));
      return Response.json(pause.api.graphql(body.query, body.variables));
    }
    assert.equal(init.method, "GET");
    if (url.pathname === "/repos/boburning/portcove" || url.pathname.includes("/git/"))
      return Response.json(pause.api.request("GET", url.pathname.slice(1)).body);
    const suffix = (url.pathname + url.search).replace(/^\/repos\/boburning\/portcove\//u, "");
    let body: unknown;
    if (suffix === "releases/10") body = ownerRelease();
    else if (suffix === "releases/11") {
      if (!allowMemberDraft) return Response.json({}, { status: 403 });
      body = {
        id: 11,
        target_commitish: source,
        body: `<!-- portcove-application-runs-v1\n${JSON.stringify(member)}\n-->`,
      };
    } else if (suffix === "actions/workflows/application-release.yml")
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
  const roleGuard = () =>
    guardApplicationReleaseSource(roleSource, false, { useVerifiedSourceCustody: true });
  allowMemberDraft = false;
  const guarded = await roleGuard();
  assert.equal(guarded.budget.actual_milliseconds, 1800000);
  assert.equal(guarded.budget.attempts, 2);
  await assert.rejects(() => guardApplicationReleaseSource(roleSource, false), { status: 403 });
  allowMemberDraft = true;
  const recovered = await guardApplicationReleaseSource(
    { ...roleSource, execution_path: "metadata-recovery" },
    false,
  );
  assert.equal(recovered.budget.actual_milliseconds, 1800000);
  assert.equal(recovered.budget.remaining_declared_minutes, 38);
  assert.equal(recovered.budget.attempts, 2);
  pause = releaseControlInputsFixture(undefined, undefined, undefined, false);
  pause.faults.value = "pause-drift";
  await assert.rejects(roleGuard, /publication pause changed during read/u);
  pause.faults.value = "";

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
    await createApplicationRunRegistrationProvider(),
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

void test("only the exact retained renewal can admit a fifth execution and carry its version floor", () => {
  const selected = retainedServedRenewal;
  const { opportunity, predecessors, release_id } = selected;
  const current: Parameters<typeof permitsRetainedServedRenewalContinuation>[1] = {
    source,
    ref: selected.next_ref,
    run_id: run,
    run_attempt: 1,
  };
  const active = {
    id: Number(run),
    head_sha: source,
    head_branch: current.ref.slice(10),
    run_attempt: 1,
    status: "in_progress",
  };
  const inventory = [
    ...predecessors.map((actor) => ({
      id: Number(actor.id),
      head_sha: actor.control_commit,
      head_branch: actor.control_ref.slice(10),
      run_attempt: 1,
      status: "completed",
      conclusion: "failure",
    })),
    active,
  ];
  const original = {
    opportunity,
    run_id: predecessors[2].id,
    run_attempt: 1,
    control_commit: predecessors[2].control_commit,
    control_ref: predecessors[2].control_ref,
    generated_at: "2026-11-08T03:32:00.089Z",
    root_sha256: "a".repeat(64),
    offline_targets_sha256: "b".repeat(64),
    prior_repository_sha256: "c".repeat(64),
    context_sha256: selected.contexts[0].context_sha256,
    context_inventory_sha256: selected.contexts[0].context_inventory_sha256,
    records_sha256: "d".repeat(64),
    versions: {
      targets: "1",
      snapshot: "2",
      timestamp: "2",
      releases: "2",
      preview: "2",
      stable: "2",
    },
  };
  const second = {
    ...original,
    run_id: predecessors[3].id,
    control_commit: predecessors[3].control_commit,
    control_ref: predecessors[3].control_ref,
    generated_at: "2026-11-08T04:23:00Z",
    ...selected.contexts[1],
    versions: {
      targets: "1",
      snapshot: "3",
      timestamp: "3",
      releases: "3",
      preview: "3",
      stable: "3",
    },
  };
  const next = {
    ...original,
    run_id: run,
    control_commit: source,
    control_ref: current.ref,
    generated_at: "2026-11-08T05:00:00Z",
    context_sha256: "f".repeat(64),
    versions: {
      targets: "1",
      snapshot: "4",
      timestamp: "4",
      releases: "4",
      preview: "4",
      stable: "4",
    },
  };
  const custody = inspectApplicationRunCustody({
    schema_version: 3,
    kind: "application-release-run-custody",
    source: selected.source,
    source_tree: selected.source_tree,
    opportunity,
    preparation: null,
    runs: [
      ...predecessors
        .slice(1)
        .map(({ id, control_commit, control_ref }) => ({ id, control_commit, control_ref })),
      { id: run, control_commit: source, control_ref: current.ref },
    ],
    metadata_contexts: [original, second],
  });
  const permit = (rows = inventory, actor = current, retained = custody) =>
    permitsRetainedServedRenewalContinuation(
      rows,
      actor,
      opportunity,
      "metadata-renewal",
      "metadata-maintenance",
      { release_id, custody: retained },
    );
  assert.equal(permit(), true);
  assert.throws(() => inspectApplicationRunCustody({ ...custody, opportunity: "f".repeat(64) }));
  assert.throws(() =>
    inspectApplicationRunCustody({ ...custody, runs: custody.runs.slice().reverse() }),
  );
  assert.equal(permit(inventory, current, { ...custody, metadata_contexts: [original] }), false);
  assert.equal(
    permit(
      inventory,
      current,
      inspectApplicationRunCustody({ ...custody, metadata_contexts: [original, second, next] }),
    ),
    true,
  );
  assert.equal(permit(inventory.slice(1)), false, "unregistered r30 must still be charged");
  assert.equal(
    permit([...inventory, { ...active, id: Number(run) + 1 }]),
    false,
    "no sixth execution",
  );
  assert.equal(permit(inventory, { ...current, run_attempt: 2 }), false);
  assert.equal(permit(inventory, { ...current, ref: predecessors[2].control_ref }), false);
  assert.equal(
    permit(
      inventory.map((row) =>
        row.id === Number(predecessors[2].id) ? { ...row, conclusion: "success" } : row,
      ),
    ),
    false,
  );
  assert.equal(
    permit(inventory, current, {
      ...custody,
      metadata_contexts: [original, { ...second, context_sha256: next.context_sha256 }],
    }),
    false,
  );
});

void test("only the exact exhausted empty bootstrap can admit one protected successor", async (t) => {
  const opportunity = "ce5fc42d395494d6faff4a2b494b3649923c0b27f508e390667ab7ad46cc4509";
  const r10 = "9caa02ce98ccd5d6e3e8133735b373f779a0489c";
  const r11 = "5ab859841dcdf857572b67a4acce5126002dc1c3";
  const tag = (revision: number) => `portcove-production-controller-windows-20261105r${revision}`;
  const execution = { source, ref: "refs/tags/" + tag(12), run_id: "42279999999", run_attempt: 1 };
  const runs = [
    { id: 42262046049, head_sha: r10, head_branch: tag(10) },
    { id: 42264854396, head_sha: r10, head_branch: tag(10) },
    { id: 42273701261, head_sha: r11, head_branch: tag(11) },
  ].map((row) => ({ ...row, status: "completed", conclusion: "failure", run_attempt: 1 }));
  runs.push({
    id: Number(execution.run_id),
    head_sha: source,
    head_branch: tag(12),
    status: "in_progress",
    conclusion: "",
    run_attempt: 1,
  });
  const custody = inspectApplicationRunCustody({
    schema_version: 1,
    kind: "application-release-run-custody",
    source: r10,
    source_tree: "beac77d095fee337fe4ab495e1f73f7250e2464f",
    opportunity,
    preparation: null,
    runs: runs.slice(1).map((row) => ({
      id: String(row.id),
      control_commit: row.head_sha,
      control_ref: "refs/tags/" + row.head_branch,
    })),
  });
  const owner = { release_id: 436818191, custody };
  const permit = (
    inventory = runs,
    current = execution,
    context = owner,
    purpose = "metadata-bootstrap",
  ) =>
    permitsEmptyBootstrapContinuation(
      inventory,
      current,
      opportunity,
      purpose,
      "ordinary",
      context,
    );
  assert.equal(permit(), true);
  assert.equal(permit(runs.slice(1)), false);
  assert.equal(permit([...runs, { ...runs[3]!, id: 42279999998 }]), false);
  assert.equal(permit([{ ...runs[0]!, conclusion: "cancelled" }, ...runs.slice(1)]), false);
  assert.equal(permit([...runs.slice(0, 3), { ...runs[3]!, status: "completed" }]), false);
  assert.equal(permit(runs, { ...execution, run_attempt: 2 }), false);
  assert.equal(permit(runs, { ...execution, ref: "refs/tags/" + tag(13) }), false);
  assert.equal(permit(runs, execution, { ...owner, release_id: 436818192 }), false);
  assert.equal(permit(runs, execution, owner, "application-release"), false);
  assert.equal(permit(runs, execution, { ...owner, custody: { ...custody, source } }), false);
  assert.equal(
    permit(runs, execution, { ...owner, custody: { ...custody, source_tree: source } }),
    false,
  );

  const environment = {
    GH_TOKEN: "synthetic-bootstrap-budget-reader",
    PORTCOVE_APPLICATION_RELEASE_REVISION: execution.source,
    PORTCOVE_APPLICATION_RELEASE_REF: execution.ref,
    PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY: opportunity,
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_REPOSITORY_ID: "1354613114",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: execution.ref,
    GITHUB_REF_PROTECTED: "true",
    GITHUB_SHA: execution.source,
    GITHUB_WORKFLOW_SHA: execution.source,
    GITHUB_WORKFLOW_REF: `boburning/portcove/.github/workflows/application-release.yml@${execution.ref}`,
    GITHUB_RUN_ID: execution.run_id,
    GITHUB_RUN_ATTEMPT: "1",
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let drift = false;
  let currentSourceDone = false;
  let unexpectedContextOnlyJob = false;
  let unexpectedTimeoutConclusion = false;
  const charged = new Set<number>();
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
    assert.equal(init.method, "GET");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "token synthetic-bootstrap-budget-reader",
    );
    assert.ok(typeof input === "string");
    const url = new URL(input);
    assert.equal(url.origin, "https://api.github.com");
    const prefix = "/repos/boburning/portcove/actions/";
    assert.ok(url.pathname.startsWith(prefix));
    const endpoint = url.pathname.slice(prefix.length) + url.search;
    if (endpoint === "workflows/application-release.yml")
      return Response.json({ id: 7, path: ".github/workflows/application-release.yml" });
    if (endpoint === "workflows/application-release.yml/runs?event=workflow_dispatch&per_page=100")
      return Response.json({
        total_count: runs.length,
        workflow_runs: runs.map((row) => ({
          ...runRow(row.id, `Application ${opportunity}`),
          ...row,
        })),
      });
    const match = /^runs\/(\d+)\/attempts\/1(\/jobs\?per_page=100)?$/u.exec(endpoint);
    assert.ok(match, endpoint);
    const id = Number(match[1]);
    const row = runs.find((run) => run.id === id);
    assert.ok(row);
    if (!match[2]) return Response.json({ ...context(1), id, head_sha: row.head_sha });
    charged.add(id);
    const observedJob = (name: string, start: number, seconds: number, conclusion = "failure") => ({
      ...job(name, start, seconds),
      run_id: id,
      head_sha: row.head_sha,
      conclusion,
    });
    if (id === 42330828127) {
      const rows = [
        [128276714370, "source", 31],
        [128276860078, "tools", 131],
        [128277402232, "context / execute", 34],
        [128277555273, "protection_metadata / execute", 49],
        [128277773517, "preview / execute", 33],
        [128277773532, "releases / execute", 29],
        [128277773538, "stable / execute", 28],
        [128277929443, "protection_snapshot / execute", 63],
      ] as const;
      return Response.json(
        jobs(
          rows.map(([jobId, name, seconds]) => ({
            ...observedJob(
              name,
              0,
              seconds,
              jobId === 128277929443
                ? unexpectedTimeoutConclusion
                  ? "failure"
                  : "cancelled"
                : "success",
            ),
            id: jobId,
          })),
        ),
      );
    }
    if (id === Number(execution.run_id))
      return Response.json(jobs(currentSourceDone ? [observedJob("source", 0, 1, "success")] : []));
    if (id === 42264854396)
      return Response.json(
        jobs([observedJob("source", 0, 34, "success"), observedJob("tools", 34, 137)]),
      );
    if (id === 42290284351)
      return Response.json(
        jobs([
          observedJob("source", 0, 26, "success"),
          observedJob("tools", 26, 154, "success"),
          observedJob("context / execute", 180, 21),
        ]),
      );
    if (id === 42301931007)
      return Response.json(
        jobs([
          observedJob("source", 0, 28, "success"),
          observedJob("tools", 28, 110, "success"),
          observedJob("context / execute", 138, 24, "success"),
          ...(unexpectedContextOnlyJob
            ? [observedJob("releases / execute", 162, 1, "success")]
            : []),
        ]),
      );
    if (row.head_branch === tag(13)) return Response.json(jobs([observedJob("tools", 0, 6000)]));
    return Response.json(jobs([observedJob("source", 0, drift && id === 42262046049 ? 28 : 29)]));
  });
  const inspect = () =>
    readApplicationJobBudget(
      ["42264854396", "42273701261"],
      "metadata-bootstrap",
      "ordinary",
      owner,
    );
  const sourceBudget = await inspect();
  assert.equal(sourceBudget.attempts, 4);
  assert.equal(sourceBudget.actual_milliseconds, 229_000);
  assert.equal(sourceBudget.remaining_declared_minutes, 59);
  assert.deepEqual(charged, new Set(runs.map((row) => row.id)));
  currentSourceDone = true;
  const privateBudget = await inspect();
  assert.equal(privateBudget.actual_milliseconds, 230_000);
  assert.equal(privateBudget.remaining_declared_minutes, 57);
  drift = true;
  await assert.rejects(inspect, /bootstrap predecessor cost changed/u);
  // Reuse the actual reader against the original r12 failure and a successor.
  drift = false;
  runs[3] = {
    id: 42290284351,
    head_sha: "a0d6bc22729151e956870cb321c43fdce48d7821",
    head_branch: tag(12),
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
  };
  execution.ref = "refs/tags/" + tag(13);
  process.env.PORTCOVE_APPLICATION_RELEASE_REF = execution.ref;
  process.env.GITHUB_REF = execution.ref;
  process.env.GITHUB_WORKFLOW_REF = `boburning/portcove/.github/workflows/application-release.yml@${execution.ref}`;
  runs.push({
    id: Number(execution.run_id),
    head_sha: execution.source,
    head_branch: tag(13),
    status: "in_progress",
    conclusion: "",
    run_attempt: 1,
  });
  const successor = {
    ...owner,
    custody: inspectApplicationRunCustody({
      ...owner.custody,
      runs: runs.slice(1).map((row) => ({
        id: String(row.id),
        control_commit: row.head_sha,
        control_ref: "refs/tags/" + row.head_branch,
      })),
    }),
  };
  const known = successor.custody.runs.map((row) => row.id);
  const nextBudget = await readApplicationJobBudget(
    known,
    "metadata-bootstrap",
    "ordinary",
    successor,
  );
  assert.equal(nextBudget.attempts, 5);
  assert.equal(nextBudget.actual_milliseconds, 431_000);
  assert.equal(nextBudget.remaining_declared_minutes, 57);
  runs[runs.length - 1]!.status = "completed";
  runs[runs.length - 1]!.conclusion = "failure";
  execution.ref = "refs/tags/" + tag(14);
  execution.run_id = "42299000002";
  process.env.PORTCOVE_APPLICATION_RELEASE_REF = execution.ref;
  process.env.GITHUB_REF = execution.ref;
  process.env.GITHUB_RUN_ID = execution.run_id;
  process.env.GITHUB_WORKFLOW_REF = `boburning/portcove/.github/workflows/application-release.yml@${execution.ref}`;
  runs.push({
    id: Number(execution.run_id),
    head_sha: execution.source,
    head_branch: tag(14),
    status: "in_progress",
    conclusion: "",
    run_attempt: 1,
  });
  const overBudget = {
    ...successor,
    custody: inspectApplicationRunCustody({
      ...successor.custody,
      runs: [
        ...successor.custody.runs,
        { id: execution.run_id, control_commit: execution.source, control_ref: execution.ref },
      ],
    }),
  };
  await assert.rejects(
    () => readApplicationJobBudget(known, "metadata-bootstrap", "ordinary", overBudget),
    /all actual opportunity executions plus remaining tail exceed application140/u,
  );
  runs[4] = {
    id: 42301931007,
    head_sha: "9754d288e74eae61915086522d9aa49adbd59d55",
    head_branch: tag(13),
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  };
  const reconciled = {
    ...overBudget,
    custody: inspectApplicationRunCustody({
      ...overBudget.custody,
      runs: runs.slice(1).map((row) => ({
        id: String(row.id),
        control_commit: row.head_sha,
        control_ref: "refs/tags/" + row.head_branch,
      })),
    }),
  };
  const inspectReconciled = () =>
    readApplicationJobBudget(
      reconciled.custody.runs.map((row) => row.id),
      "metadata-bootstrap",
      "ordinary",
      reconciled,
    );
  assert.equal((await inspectReconciled()).actual_milliseconds, 593_000);
  unexpectedContextOnlyJob = true;
  await assert.rejects(inspectReconciled, /releases \/ execute/u);
  unexpectedContextOnlyJob = false;
  runs.splice(runs.length - 1, 0, {
    id: 42330828127,
    head_sha: "678133294e5ea5a39935c26958a064ec7dc8976a",
    head_branch: tag(23),
    status: "completed",
    conclusion: "cancelled",
    run_attempt: 1,
  });
  const timeoutOwner = {
    ...reconciled,
    custody: inspectApplicationRunCustody({
      ...reconciled.custody,
      runs: runs.slice(1).map((row) => ({
        id: String(row.id),
        control_commit: row.head_sha,
        control_ref: "refs/tags/" + row.head_branch,
      })),
    }),
  };
  const inspectTimeout = () =>
    readApplicationJobBudget(
      timeoutOwner.custody.runs.map((row) => row.id),
      "metadata-bootstrap",
      "ordinary",
      timeoutOwner,
    );
  assert.equal((await inspectTimeout()).actual_milliseconds, 991_000);
  unexpectedTimeoutConclusion = true;
  await assert.rejects(inspectTimeout);
  unexpectedTimeoutConclusion = false;
  runs[3].conclusion = "cancelled";
  await assert.rejects(inspectTimeout);
});

void test("budgeted bootstrap binds every successor to complete failed history without a run-count ceiling", () => {
  const opportunity = "ce5fc42d395494d6faff4a2b494b3649923c0b27f508e390667ab7ad46cc4509";
  const source = "9caa02ce98ccd5d6e3e8133735b373f779a0489c";
  const tag = (number: number) => "portcove-production-controller-windows-20261105r" + number;
  const runs = [
    [42262046049, source, 10],
    [42264854396, source, 10],
    [42273701261, "5ab859841dcdf857572b67a4acce5126002dc1c3", 11],
    [42290284351, "a0d6bc22729151e956870cb321c43fdce48d7821", 12],
    [42299000001, "1".repeat(40), 13],
    [42299000002, "2".repeat(40), 14],
  ].map(([id, sha, ref]) => ({
    id: Number(id),
    head_sha: String(sha),
    head_branch: tag(Number(ref)),
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
  }));
  runs[5]!.status = "in_progress";
  const current = {
    source: "2".repeat(40),
    ref: "refs/tags/" + tag(14),
    run_id: "42299000002",
    run_attempt: 1,
  };
  const raw = {
    schema_version: 1,
    kind: "application-release-run-custody",
    source,
    source_tree: "beac77d095fee337fe4ab495e1f73f7250e2464f",
    opportunity,
    preparation: null,
    runs: runs.slice(1).map((row) => ({
      id: String(row.id),
      control_commit: row.head_sha,
      control_ref: "refs/tags/" + row.head_branch,
    })),
  };
  const custody = inspectApplicationRunCustody(raw);
  const owner = { release_id: 436818191, custody };
  const permit = (inventory = runs, execution = current, purpose = "metadata-bootstrap") =>
    permitsBudgetedEmptyBootstrap(inventory, execution, opportunity, purpose, "ordinary", owner);
  assert.equal(permit(), true);
  assert.equal(permit(runs.slice(1)), false);
  assert.equal(
    permit(runs.map((row, index) => (index === 4 ? { ...row, conclusion: "success" } : row))),
    false,
  );
  assert.equal(permit(runs, { ...current, run_attempt: 2 }), false);
  assert.equal(permit(runs, current, "application-release"), false);
  assert.throws(() => inspectApplicationRunCustody({ ...raw, opportunity: "3".repeat(64) }));

  const original = immutableApplicationBootstrap.assembly;
  const originalRun = {
    ...runs[4]!,
    id: Number(original.run_id),
    head_sha: original.control_commit,
    head_branch: tag(27),
  };
  const recoveryRun = { ...runs[5]!, head_branch: tag(28) };
  const recoveryExecution = { ...current, ref: "refs/tags/" + tag(28) };
  const recoveryRuns = [...runs.slice(0, 4), originalRun, recoveryRun];
  const recoveryOwner = {
    release_id: immutableApplicationBootstrap.release_id,
    custody: inspectApplicationRunCustody({
      ...raw,
      runs: recoveryRuns.slice(1).map((row) => ({
        id: String(row.id),
        control_commit: row.head_sha,
        control_ref: "refs/tags/" + row.head_branch,
      })),
    }),
  };
  const permitRecovery = (
    execution = recoveryExecution,
    candidateOwner: typeof owner = recoveryOwner,
  ) =>
    permitsBudgetedEmptyBootstrap(
      recoveryRuns,
      execution,
      opportunity,
      "metadata-bootstrap",
      "bootstrap-recovery",
      candidateOwner,
    );
  assert.equal(permitRecovery(), true);
  assert.equal(permitRecovery({ ...recoveryExecution, run_attempt: 2 }), false);
  assert.equal(permitRecovery(recoveryExecution, owner), false);

  const failed = failedBootstrapRecovery;
  const failedRun = {
    ...originalRun,
    id: Number(failed.run_id),
    head_sha: failed.control_commit,
    head_branch: tag(28),
  };
  const retryRun = { ...recoveryRun, id: 42400000111, head_branch: tag(29) };
  const retryExecution = {
    ...recoveryExecution,
    ref: failed.next_control_ref,
    run_id: String(retryRun.id),
  };
  const retryRuns = [...runs.slice(0, 4), originalRun, failedRun, retryRun];
  const retryOwner = {
    release_id: recoveryOwner.release_id,
    custody: inspectApplicationRunCustody({
      ...raw,
      runs: retryRuns.slice(1).map((row) => ({
        id: String(row.id),
        control_commit: row.head_sha,
        control_ref: "refs/tags/" + row.head_branch,
      })),
    }),
  };
  const permitRetry = (
    inventory = retryRuns,
    execution: typeof recoveryExecution = retryExecution,
    candidateOwner: typeof owner = retryOwner,
  ) =>
    permitsBudgetedEmptyBootstrap(
      inventory,
      execution,
      opportunity,
      "metadata-bootstrap",
      "bootstrap-recovery",
      candidateOwner,
    );
  assert.equal(permitRetry(), true);
  assert.equal(permitRetry(retryRuns, { ...retryExecution, run_attempt: 2 }), false);
  assert.equal(permitRetry(retryRuns, { ...retryExecution, ref: "refs/tags/" + tag(30) }), false);
  assert.equal(permitRetry(retryRuns, retryExecution, recoveryOwner), false);
  assert.equal(
    permitRetry(
      retryRuns.map((row) => (row.id === failedRun.id ? { ...row, conclusion: "success" } : row)),
    ),
    false,
  );
});
