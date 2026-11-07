import { applicationOpportunityFromRunTitle } from "./application-release-run-title.mts";
/** Actual native job accounting, including failed-only retries. Not an Actions
 * quota reservation or an observation of available account capacity. */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./runtime-values.mts";
import { applicationRepository } from "./application-release-io.mts";
import { createGitHubClient } from "./github-client.mts";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import { nextLink } from "./github-operation.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import {
  emptyApplicationBootstrap,
  immutableApplicationBootstrap,
  failedBootstrapRecovery,
  isEmptyApplicationBootstrapCustody,
  readApplicationBudgetOwnerAsync,
} from "./application-release-run.mts";
import type { ApplicationBudgetContext } from "./application-release-run.mts";
import {
  inspectApplicationReleaseExecution,
  applicationReleaseBudgetMinutes,
  applicationReleaseRemainingMinutes,
} from "./application-release-policy.mts";

export const applicationNativeJobMinutes = applicationReleaseBudgetMinutes("application-release");

const proof = (value: Record<string, unknown>) =>
  Object.fromEntries(
    [
      "run_id",
      "name",
      "head_sha",
      "head_branch",
      "runner_id",
      "runner_name",
      "labels",
      "started_at",
      "completed_at",
      "steps",
    ].map((key) => [key, value[key]]),
  );

export function inspectApplicationJobBudget(
  attempts: { context: unknown; jobs: unknown }[],
  source: string,
  runId: string,
  reserveTail = true,
  purpose: unknown = "application-release",
  executionPath: unknown = "ordinary",
) {
  const ceilings = applicationReleaseBudgetMinutes(purpose);
  const remainingCeilings = applicationReleaseRemainingMinutes(purpose, executionPath);
  assert.match(source, /^[a-f0-9]{40}$/u);
  assert.match(runId, /^[1-9][0-9]{0,15}$/u);
  assert.ok(attempts.length >= 1 && attempts.length <= 3);
  const executed: { attempt: number; value: Record<string, unknown> }[] = [];
  let actual = 0;
  const done = new Set<string>();
  let copied = 0;
  for (const [index, observation] of attempts.entries()) {
    const context = observation.context;
    assert.ok(
      isRecord(context) &&
        context.id === Number(runId) &&
        context.run_attempt === index + 1 &&
        context.head_sha === source,
    );
    assert.equal(context.path, ".github/workflows/application-release.yml");
    assert.equal(context.event, "workflow_dispatch");
    assert.ok(
      typeof context.run_started_at === "string" &&
        Number.isFinite(Date.parse(context.run_started_at)),
    );
    const data = observation.jobs;
    assert.ok(
      isRecord(data) &&
        Array.isArray(data.jobs) &&
        data.jobs.length < 100 &&
        data.total_count === data.jobs.length,
    );
    const seen = new Set<string>();
    for (const value of data.jobs) {
      assert.ok(isRecord(value) && typeof value.name === "string" && !seen.has(value.name));
      seen.add(value.name);
      assert.equal(value.run_id, Number(runId));
      assert.equal(value.run_attempt, index + 1);
      assert.equal(value.head_sha, source);
      if (value.conclusion === "skipped") {
        assert.deepEqual(value.steps, []);
        continue;
      }
      if (value.conclusion === "cancelled" && value.started_at === null) continue;
      assert.ok(
        Object.hasOwn(ceilings, value.name) ||
          (purpose !== "metadata-bootstrap" && value.name === "targets / execute"),
        `unknown executing release job: ${value.name}`,
      );
      if (executionPath !== "ordinary")
        assert.ok(
          Object.hasOwn(remainingCeilings, value.name) ||
            (executionPath === "metadata-maintenance" && value.name === "targets / execute"),
          `release path cannot execute or copy work outside its remaining jobs: ${value.name}`,
        );
      if (value.status !== "completed") {
        assert.equal(index, attempts.length - 1, "earlier attempt still has active execution");
        continue;
      }
      assert.ok(typeof value.started_at === "string" && typeof value.completed_at === "string");
      const duration = Date.parse(value.completed_at) - Date.parse(value.started_at);
      assert.ok(Number.isSafeInteger(duration) && duration >= 0 && duration <= 6 * 3600 * 1000);
      const carried =
        value.conclusion === "success" &&
        duration > 0 &&
        Number.isSafeInteger(value.runner_id) &&
        Number(value.runner_id) > 0 &&
        Array.isArray(value.steps) &&
        value.steps.length > 0 &&
        Date.parse(value.completed_at) < Date.parse(context.run_started_at) &&
        executed.some(
          (entry) =>
            entry.attempt < index + 1 && isDeepStrictEqual(proof(entry.value), proof(value)),
        );
      if (carried) copied++;
      else {
        actual += duration;
        executed.push({ attempt: index + 1, value });
      }
      if (index === attempts.length - 1) done.add(value.name);
    }
  }
  const remaining = reserveTail
    ? Object.entries(remainingCeilings)
        .filter(([name]) => !done.has(name))
        .reduce((sum, [, minutes]) => sum + minutes, 0)
    : 0;
  assert.ok(
    actual + remaining * 60000 <= 140 * 60000,
    "actual execution plus remaining declared tail exceeds application140",
  );
  return {
    actual_milliseconds: actual,
    remaining_declared_minutes: remaining,
    copied_successful_observations: copied,
    feed_executions: executed
      .filter((entry) => entry.value.name === "feed")
      .map((entry) => ({
        job_id: entry.value.id,
        attempt: entry.attempt,
        started_at: entry.value.started_at,
        completed_at: entry.value.completed_at,
        conclusion: entry.value.conclusion,
      })),
    maximum_minutes: 140,
    headroom: "unknown",
    reservation: false,
    paid_fallback: false,
    authority: "none",
  };
}

const applicationWorkflow = `${applicationRepository}/actions/workflows/application-release.yml`;

interface ApplicationOpportunityProvider {
  workflow(): Promise<unknown>;
  runs(url: string, deadline: number): Promise<{ body: unknown; next: string | null }>;
}

async function createApplicationBudgetProvider() {
  const scope = readOnlyReleaseChildEnvironment();
  const { GH_TOKEN: token = "" } = scope ?? process.env;
  // The complete workflow inventory and bounded attempt/job reads share this deadline.
  const deadline = Math.min(performance.now() + 300000, coordinatorCommandDeadline() ?? Infinity);
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline,
    maxBytes: 8 * 1024 ** 2,
    requestTimeoutMs: 30000,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest(method, url) {
      if (scope && url.pathname.startsWith(`/${applicationRepository}/releases/`))
        assertTrustedDirectNode("fixed application budget owner");
      return method === "GET";
    },
  });
  const get = async (endpoint: string, limit = deadline) => {
    const response = await client.request({
      method: "GET",
      url: new URL(endpoint, "https://api.github.com/").href,
      request: { portcove: { replay: "once", attempts: 0, deadline: limit } },
    });
    assert.equal(response.status, 200);
    return response;
  };
  return {
    async release(id: number) {
      assert.ok(Number.isSafeInteger(id) && id > 0);
      return (await get(`${applicationRepository}/releases/${id}`)).data as unknown;
    },
    async workflow() {
      return (await get(applicationWorkflow)).data as unknown;
    },
    async runs(url: string, limit: number) {
      const response = await get(url, limit);
      const link = response.headers.link;
      return {
        body: response.data as unknown,
        next: typeof link === "string" ? nextLink(new Map([["link", link]])) : null,
      };
    },
    async attempt(run: number, attempt: number) {
      return (await get(`${applicationRepository}/actions/runs/${run}/attempts/${attempt}`))
        .data as unknown;
    },
    async jobs(run: number, attempt: number) {
      const response = await get(
        `${applicationRepository}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`,
      );
      assert.ok(!response.headers.link || !nextLink(new Map([["link", response.headers.link]])));
      return response.data as unknown;
    },
  };
}

/** Complete accessible provider inventory. A durable draft's known run IDs are
 * checked separately below, so deleted/expired prior runs cannot reset a slot. */
export async function readApplicationOpportunityRuns(
  provider: ApplicationOpportunityProvider,
  opportunity: string | readonly string[],
) {
  const rawOpportunities: readonly unknown[] =
    typeof opportunity === "string" ? [opportunity] : opportunity;
  assert.ok(
    Array.isArray(rawOpportunities) && rawOpportunities.length >= 1 && rawOpportunities.length <= 3,
  );
  const opportunities = rawOpportunities.map((value: unknown) => {
    assert.ok(typeof value === "string");
    assert.match(value, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    return value;
  });
  assert.equal(new Set(opportunities).size, opportunities.length);
  const scopes = new Set(opportunities);
  const workflow = await provider.workflow();
  assert.ok(
    isRecord(workflow) &&
      workflow.path === ".github/workflows/application-release.yml" &&
      Number.isSafeInteger(workflow.id) &&
      Number(workflow.id) > 0,
  );
  const route = `/${applicationWorkflow}/runs`;
  const aliases = new Set([
    route,
    `/${applicationRepository}/actions/workflows/${Number(workflow.id)}/runs`,
    `/repositories/1354613114/actions/workflows/${Number(workflow.id)}/runs`,
  ]);
  const deadline = performance.now() + 90000;
  const rows: Record<string, unknown>[] = [];
  const ids = new Set<number>();
  let total: number | undefined;
  let next: string | null = `https://api.github.com${route}?event=workflow_dispatch&per_page=100`;
  for (let page = 1; next !== null; page++) {
    assert.ok(page <= 10 && performance.now() < deadline);
    const url = new URL(next);
    assert.equal(url.origin, "https://api.github.com");
    assert.ok(!url.username && !url.password && !url.hash && aliases.has(url.pathname));
    const keys = [...url.searchParams.keys()];
    assert.equal(keys.length, new Set(keys).size);
    assert.ok(keys.every((key) => ["event", "per_page", "page"].includes(key)));
    assert.equal(url.searchParams.get("event"), "workflow_dispatch");
    assert.equal(url.searchParams.get("per_page"), "100");
    assert.equal(url.searchParams.get("page") ?? "1", String(page));
    const response = await provider.runs(url.href, deadline);
    const raw = response.body;
    assert.ok(performance.now() < deadline);
    assert.ok(isRecord(raw) && Array.isArray(raw.workflow_runs) && raw.workflow_runs.length <= 100);
    assert.ok(
      typeof raw.total_count === "number" &&
        Number.isSafeInteger(raw.total_count) &&
        raw.total_count >= 0 &&
        raw.total_count < 1000,
      "provider run search at ceiling; completeness unknown",
    );
    total ??= raw.total_count;
    assert.equal(raw.total_count, total);
    for (const row of raw.workflow_runs as unknown[]) {
      assert.ok(
        isRecord(row) && typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id > 0,
      );
      assert.ok(!ids.has(row.id), "duplicate application run in provider inventory");
      ids.add(row.id);
      rows.push(row);
    }
    assert.ok(rows.length <= total);
    next = response.next;
  }
  assert.equal(rows.length, total, "application run inventory is incomplete");
  return rows
    .filter((raw) => scopes.has(applicationOpportunityFromRunTitle(raw.display_title) ?? ""))
    .map((raw) => {
      assert.ok(
        raw.path === ".github/workflows/application-release.yml" &&
          raw.event === "workflow_dispatch",
      );
      assert.ok(
        isRecord(raw.repository) &&
          raw.repository.id === 1354613114 &&
          isRecord(raw.head_repository) &&
          raw.head_repository.id === 1354613114,
      );
      assert.ok(typeof raw.head_sha === "string" && /^[a-f0-9]{40}$/u.test(raw.head_sha));
      return raw;
    });
}

const emptyBootstrapContinuation = {
  ...emptyApplicationBootstrap,
  ref: "refs/tags/portcove-production-controller-windows-20261105r12",
  predecessors: [
    {
      id: 42262046049,
      source: "9caa02ce98ccd5d6e3e8133735b373f779a0489c",
      tag: "portcove-production-controller-windows-20261105r10",
      milliseconds: 29_000,
    },
    {
      id: 42264854396,
      source: "9caa02ce98ccd5d6e3e8133735b373f779a0489c",
      tag: "portcove-production-controller-windows-20261105r10",
      milliseconds: 171_000,
    },
    {
      id: 42273701261,
      source: "5ab859841dcdf857572b67a4acce5126002dc1c3",
      tag: "portcove-production-controller-windows-20261105r11",
      milliseconds: 29_000,
    },
  ],
} as const;

// These settled protection diagnostics have separate run titles, outside the
// exact opportunity inventory. They were charged to the retained bootstrap.
const bootstrapDiagnosticCharges = [
  { run_id: "42323830177", attempt: 1, milliseconds: 41_000 },
  { run_id: "42325788961", attempt: 1, milliseconds: 48_000 },
] as const;

/** The protected ref is an independent owner appointment. The failed source run
 * that predates draft creation is counted from the complete provider inventory. */
export function permitsEmptyBootstrapContinuation(
  runs: readonly Record<string, unknown>[],
  execution: ReturnType<typeof inspectApplicationReleaseExecution>,
  opportunity: string,
  purpose: unknown,
  executionPath: unknown,
  owner: ApplicationBudgetContext | undefined,
) {
  const expected = emptyBootstrapContinuation;
  if (
    opportunity !== expected.opportunity ||
    purpose !== "metadata-bootstrap" ||
    executionPath !== "ordinary" ||
    execution.ref !== expected.ref ||
    execution.run_attempt !== 1 ||
    owner?.release_id !== expected.release_id ||
    owner.custody.opportunity !== opportunity ||
    owner.custody.source !== expected.source ||
    owner.custody.source_tree !== expected.source_tree ||
    owner.custody.preparation !== null ||
    owner.custody.budget !== undefined ||
    runs.length !== 4
  )
    return false;
  const current = runs.find((run) => run.id === Number(execution.run_id));
  if (
    !current ||
    current.run_attempt !== 1 ||
    current.head_sha !== execution.source ||
    current.head_branch !== execution.ref.slice("refs/tags/".length) ||
    current.status !== "in_progress"
  )
    return false;
  const prior = expected.predecessors;
  const custody = owner.custody.runs;
  return (
    prior.every(({ id, source, tag }) =>
      runs.some(
        (run) =>
          run.id === id &&
          run.head_sha === source &&
          run.head_branch === tag &&
          run.run_attempt === 1 &&
          run.status === "completed" &&
          run.conclusion === "failure",
      ),
    ) &&
    isDeepStrictEqual(custody, [
      ...prior.slice(1).map(({ id, source, tag }) => ({
        id: String(id),
        control_commit: source,
        control_ref: "refs/tags/" + tag,
      })),
      { id: execution.run_id, control_commit: execution.source, control_ref: execution.ref },
    ])
  );
}

const retainedBootstrapRuns = [
  ...emptyBootstrapContinuation.predecessors,
  {
    id: 42290284351,
    source: "a0d6bc22729151e956870cb321c43fdce48d7821",
    tag: emptyBootstrapContinuation.ref.slice("refs/tags/".length),
    milliseconds: 201_000,
  },
];

const contextOnlyBootstrap = {
  id: 42301931007,
  source: "9754d288e74eae61915086522d9aa49adbd59d55",
  tag: "portcove-production-controller-windows-20261105r13",
  milliseconds: 162_000,
  jobs: ["context / execute", "source", "tools"],
} as const;

function isContextOnlyBootstrap(run: Record<string, unknown>) {
  return (
    run.id === contextOnlyBootstrap.id &&
    run.head_sha === contextOnlyBootstrap.source &&
    run.head_branch === contextOnlyBootstrap.tag
  );
}

// The provider annotation on this exact run records a one-minute job timeout.
// Its cancellation remains historical and does not admit other cancellations.
const timedOutBootstrap = {
  id: 42330828127,
  source: "678133294e5ea5a39935c26958a064ec7dc8976a",
  tag: "portcove-production-controller-windows-20261105r23",
  milliseconds: 398_000,
  jobs: [
    { id: 128276714370, name: "source", conclusion: "success" },
    { id: 128276860078, name: "tools", conclusion: "success" },
    { id: 128277402232, name: "context / execute", conclusion: "success" },
    { id: 128277555273, name: "protection_metadata / execute", conclusion: "success" },
    { id: 128277773517, name: "preview / execute", conclusion: "success" },
    { id: 128277773532, name: "releases / execute", conclusion: "success" },
    { id: 128277773538, name: "stable / execute", conclusion: "success" },
    { id: 128277929443, name: "protection_snapshot / execute", conclusion: "cancelled" },
  ],
} as const;

function isTimedOutBootstrap(run: Record<string, unknown>) {
  return (
    run.id === timedOutBootstrap.id &&
    run.head_sha === timedOutBootstrap.source &&
    run.head_branch === timedOutBootstrap.tag
  );
}

function successorBootstrapRef(ref: string) {
  const revision =
    /^refs\/tags\/portcove-production-controller-windows-20261105r([1-9][0-9]{1,5})$/u.exec(ref);
  return Number(revision?.[1]) >= 13;
}

/** The owner permits metadata-only recovery under cumulative cost accounting.
 * The original pre-draft run is still counted, and later runs must agree with
 * both durable custody and complete provider history. A new pre-registration
 * failure requires reconciliation before another dispatch. */
export function permitsBudgetedEmptyBootstrap(
  runs: readonly Record<string, unknown>[],
  execution: ReturnType<typeof inspectApplicationReleaseExecution>,
  opportunity: string,
  purpose: unknown,
  executionPath: unknown,
  owner: ApplicationBudgetContext | undefined,
) {
  if (
    !owner ||
    owner.release_id !== emptyApplicationBootstrap.release_id ||
    !isEmptyApplicationBootstrapCustody(owner.custody) ||
    opportunity !== emptyApplicationBootstrap.opportunity ||
    purpose !== "metadata-bootstrap" ||
    (executionPath !== "ordinary" && executionPath !== "bootstrap-recovery") ||
    execution.run_attempt !== 1 ||
    !successorBootstrapRef(execution.ref)
  )
    return false;
  const custody = owner.custody.runs;
  if (executionPath === "bootstrap-recovery") {
    const original = immutableApplicationBootstrap.assembly;
    const matches = (
      run: (typeof custody)[number] | undefined,
      identity: typeof original | typeof failedBootstrapRecovery,
    ) =>
      run?.id === identity.run_id &&
      run.control_commit === identity.control_commit &&
      run.control_ref === identity.control_ref;
    if (execution.ref === failedBootstrapRecovery.next_control_ref) {
      if (!matches(custody.at(-3), original) || !matches(custody.at(-2), failedBootstrapRecovery))
        return false;
    } else if (!matches(custody.at(-2), original)) return false;
  }
  const first = retainedBootstrapRuns[0]!;
  if (
    custody.length < retainedBootstrapRuns.length ||
    runs.length !== custody.length + 1 ||
    new Set(custody.slice(3).map((run) => run.control_ref)).size !== custody.length - 3
  )
    return false;
  const observed = new Map(runs.map((run) => [run.id, run]));
  const preDraft = observed.get(first.id);
  if (
    preDraft?.head_sha !== first.source ||
    preDraft.head_branch !== first.tag ||
    preDraft.run_attempt !== 1 ||
    preDraft.status !== "completed" ||
    preDraft.conclusion !== "failure" ||
    custody.some((run) => Number(run.id) === first.id)
  )
    return false;
  return custody.every((run, index) => {
    const prior = retainedBootstrapRuns[index + 1];
    if (
      prior &&
      (run.id !== String(prior.id) ||
        run.control_commit !== prior.source ||
        run.control_ref !== "refs/tags/" + prior.tag)
    )
      return false;
    if (!prior && !successorBootstrapRef(run.control_ref)) return false;
    const row = observed.get(Number(run.id));
    if (
      !row ||
      row.head_sha !== run.control_commit ||
      row.head_branch !== run.control_ref.slice("refs/tags/".length) ||
      row.run_attempt !== 1
    )
      return false;
    if (index === custody.length - 1)
      return (
        run.id === execution.run_id &&
        run.control_commit === execution.source &&
        run.control_ref === execution.ref &&
        row.status === "in_progress"
      );
    return (
      row.status === "completed" &&
      (row.conclusion === "failure" ||
        (row.conclusion === "cancelled" && isTimedOutBootstrap(row)) ||
        (row.conclusion === "success" && isContextOnlyBootstrap(row)))
    );
  });
}

/** Bootstrap recovery has many fixed one-attempt predecessors. Bound reads to
 * four at once and drain each batch before admitting any further requests. */
export async function readBootstrapRecoveryObservations(
  provider: Pick<Awaited<ReturnType<typeof createApplicationBudgetProvider>>, "attempt" | "jobs">,
  runIds: readonly number[],
) {
  const observations = new Map<number, { context: unknown; jobs: unknown }>();
  for (let index = 0; index < runIds.length; index += 2) {
    const ids = runIds.slice(index, index + 2);
    const batch = await Promise.allSettled(
      ids.flatMap((id) => [provider.attempt(id, 1), provider.jobs(id, 1)]),
    );
    const values = batch.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    for (const [offset, id] of ids.entries())
      observations.set(id, { context: values[offset * 2], jobs: values[offset * 2 + 1] });
  }
  return observations;
}

export async function readApplicationJobBudget(
  registeredRunIds: readonly string[] | undefined,
  purpose: unknown,
  executionPath: unknown = "ordinary",
  budgetContext?: ApplicationBudgetContext,
) {
  applicationReleaseRemainingMinutes(purpose, executionPath);
  const execution = inspectApplicationReleaseExecution(process.env);
  const opportunity = process.env.PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY ?? "";
  const provider = await createApplicationBudgetProvider();
  const owner = budgetContext
    ? await readApplicationBudgetOwnerAsync((id) => provider.release(id), budgetContext)
    : undefined;
  const scopes =
    owner?.custody.budget?.kind === "owner"
      ? [
          {
            opportunity: owner.custody.opportunity,
            run_ids: owner.custody.runs.map((run) => run.id),
          },
          ...owner.custody.budget.scopes,
        ]
      : [];
  const opportunities = [...new Set([opportunity, ...scopes.map((scope) => scope.opportunity)])];
  const runs = await readApplicationOpportunityRuns(provider, opportunities);
  for (const scope of scopes)
    for (const id of scope.run_ids)
      assert.ok(
        runs.some(
          (run) =>
            String(run.id) === id &&
            applicationOpportunityFromRunTitle(run.display_title) === scope.opportunity,
        ),
        "recorded related execution missing from provider history; no budget reset",
      );
  assert.ok(runs.some((run) => run.id === Number(execution.run_id)));
  const known: unknown =
    registeredRunIds ?? JSON.parse(process.env.PORTCOVE_KNOWN_RELEASE_RUNS ?? "null");
  const budgetedBootstrap = permitsBudgetedEmptyBootstrap(
    runs,
    execution,
    opportunity,
    purpose,
    executionPath,
    owner,
  );
  if (executionPath === "bootstrap-recovery")
    assert.ok(budgetedBootstrap, "bootstrap recovery requires its single appointed continuation");
  assert.ok(
    Array.isArray(known) &&
      (known.length <= 3 || budgetedBootstrap) &&
      new Set(known).size === known.length,
  );
  if (registeredRunIds === undefined)
    assert.ok(
      known.length > 0 && known.includes(execution.run_id),
      "native run registration is required before private work",
    );
  for (const id of known)
    assert.ok(
      typeof id === "string" &&
        runs.some(
          (run) =>
            String(run.id) === id &&
            applicationOpportunityFromRunTitle(run.display_title) === opportunity,
        ),
      "durably recorded run missing from provider history; no budget reset",
    );
  const continuation = permitsEmptyBootstrapContinuation(
    runs,
    execution,
    opportunity,
    purpose,
    executionPath,
    owner,
  );
  const retainedDiagnostics =
    executionPath === "bootstrap-recovery" ? bootstrapDiagnosticCharges : [];
  const currentId = Number(execution.run_id);
  const recoveryObservations =
    executionPath === "bootstrap-recovery"
      ? await readBootstrapRecoveryObservations(provider, [
          ...runs.filter((run) => run.id !== currentId).map((run) => Number(run.id)),
          currentId,
        ])
      : undefined;
  let actual = retainedDiagnostics.reduce((sum, charge) => sum + charge.milliseconds, 0),
    remaining = 0,
    attempts = 0;
  const evidence = [];
  for (const run of runs) {
    assert.ok(
      !["queued", "waiting", "requested", "pending"].includes(String(run.status)),
      "pending related release execution has unknown remaining work; no cost waiver",
    );
    const current = run.id === currentId;
    if (current) {
      assert.equal(run.head_sha, execution.source, "current budget source changed");
      assert.equal(run.run_attempt, execution.run_attempt, "current budget attempt changed");
    }
    if (!current)
      assert.equal(
        run.status,
        "completed",
        "another related release execution is still active; no cost waiver",
      );
    assert.ok(
      Number.isSafeInteger(run.run_attempt) &&
        Number(run.run_attempt) >= 1 &&
        Number(run.run_attempt) <= 3,
    );
    attempts += Number(run.run_attempt);
    assert.ok(
      budgetedBootstrap || attempts <= (continuation ? 4 : 3),
      "release opportunity exhausted its bounded attempts across runs",
    );
    const observed = recoveryObservations?.get(Number(run.id));
    const observations = observed ? [observed] : [];
    if (!observed)
      for (let attempt = 1; attempt <= Number(run.run_attempt); attempt++)
        observations.push({
          context: await provider.attempt(Number(run.id), attempt),
          jobs: await provider.jobs(Number(run.id), attempt),
        });
    const result = inspectApplicationJobBudget(
      observations,
      String(run.head_sha),
      String(run.id),
      current,
      current || budgetedBootstrap ? purpose : "application-release",
      current ? executionPath : "ordinary",
    );
    if ((continuation || budgetedBootstrap) && !current) {
      const prior = retainedBootstrapRuns.find(({ id }) => id === run.id);
      if (prior)
        assert.equal(
          result.actual_milliseconds,
          prior.milliseconds,
          "bootstrap predecessor cost changed",
        );
    }
    if (budgetedBootstrap && !current && isContextOnlyBootstrap(run)) {
      const evidence = observations[0]?.jobs;
      assert.ok(isRecord(evidence) && Array.isArray(evidence.jobs));
      const names: string[] = [];
      for (const job of evidence.jobs as unknown[]) {
        assert.ok(isRecord(job));
        if (job.conclusion === "skipped") continue;
        assert.ok(job.status === "completed" && job.conclusion === "success");
        assert.ok(typeof job.name === "string");
        names.push(job.name);
      }
      assert.deepEqual(
        names.sort((a, b) => a.localeCompare(b)),
        contextOnlyBootstrap.jobs,
      );
      assert.equal(result.actual_milliseconds, contextOnlyBootstrap.milliseconds);
    }
    if (budgetedBootstrap && !current && isTimedOutBootstrap(run)) {
      const proof = observations[0]?.jobs;
      assert.ok(isRecord(proof) && Array.isArray(proof.jobs));
      const executed = proof.jobs
        .filter((job: unknown) => isRecord(job) && job.conclusion !== "skipped")
        .map((job: unknown) => {
          assert.ok(isRecord(job) && job.status === "completed");
          return { id: job.id, name: job.name, conclusion: job.conclusion };
        })
        .sort((left, right) => Number(left.id) - Number(right.id));
      assert.deepEqual(executed, timedOutBootstrap.jobs);
      assert.equal(result.actual_milliseconds, timedOutBootstrap.milliseconds);
      const cancelled: unknown = proof.jobs.find(
        (job: unknown) => isRecord(job) && job.id === 128277929443,
      );
      assert.ok(isRecord(cancelled));
      assert.equal(
        Date.parse(String(cancelled.completed_at)) - Date.parse(String(cancelled.started_at)),
        63_000,
        "bootstrap timeout duration changed",
      );
    }
    if (
      executionPath === "bootstrap-recovery" &&
      String(run.id) === failedBootstrapRecovery.run_id
    ) {
      assert.equal(result.actual_milliseconds, failedBootstrapRecovery.actual_milliseconds);
      const evidence = observations[0]?.jobs;
      assert.ok(isRecord(evidence) && Array.isArray(evidence.jobs));
      const executed = evidence.jobs
        .flatMap((job: unknown) => {
          assert.ok(isRecord(job));
          return job.conclusion === "skipped" ? [] : [[job.id, job.name, job.conclusion]];
        })
        .sort((left, right) => Number(left[0]) - Number(right[0]));
      assert.deepEqual(executed, [
        [128481328405, "source", "success"],
        [128481502591, "tools", "success"],
        [128482013329, "feed_prepare", "success"],
        [128482331065, "protection_feed / execute", "success"],
        [failedBootstrapRecovery.feed_job_id, "feed", "failure"],
      ]);
    }
    actual += result.actual_milliseconds;
    remaining += result.remaining_declared_minutes;
    evidence.push({ run_id: String(run.id), ...result });
  }
  assert.ok(
    actual + remaining * 60000 <= 140 * 60000,
    "all actual opportunity executions plus remaining tail exceed application140",
  );
  if (recoveryObservations) {
    const identity = (rows: readonly Record<string, unknown>[]) =>
      rows.map(({ id, head_sha, head_branch, run_attempt, status, conclusion }) => ({
        id,
        head_sha,
        head_branch,
        run_attempt,
        status,
        conclusion,
      }));
    assert.deepEqual(
      identity(await readApplicationOpportunityRuns(provider, opportunities)),
      identity(runs),
      "bootstrap execution inventory changed during budget observation",
    );
  }
  return {
    actual_milliseconds: actual,
    remaining_declared_minutes: remaining,
    attempts,
    opportunities,
    ...(retainedDiagnostics.length ? { retained_diagnostics: retainedDiagnostics } : {}),
    maximum_minutes: 140,
    headroom: "unknown",
    reservation: false,
    paid_fallback: false,
    authority: "none",
    runs: evidence,
  };
}
