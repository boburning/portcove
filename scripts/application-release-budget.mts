import { applicationOpportunityFromRunTitle } from "./application-release-run-title.mts";
/** Actual native job accounting, including failed-only retries. Not an Actions
 * quota reservation or an observation of available account capacity. */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./runtime-values.mts";
import {
  applicationGet,
  applicationApi,
  applicationRepository,
} from "./application-release-io.mts";
import { GitHubApiClient } from "./github-api.mts";
import { readApplicationBudgetOwner } from "./application-release-run.mts";
import type { ApplicationBudgetContext } from "./application-release-run.mts";
import type { GitHubRestReader } from "./github-api.mts";
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
    assert.equal(context.path, ".github/workflows/release.yml");
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
        Object.hasOwn(ceilings, value.name) || value.name === "targets / execute",
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

/** Complete accessible provider inventory. A durable draft's known run IDs are
 * checked separately below, so deleted/expired prior runs cannot reset a slot. */
export function readApplicationOpportunityRuns(
  api: GitHubRestReader,
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
  const workflowResponse = api.request(
    "GET",
    `${applicationRepository}/actions/workflows/release.yml`,
  );
  assert.equal(workflowResponse.status, 200);
  const workflow = workflowResponse.body;
  assert.ok(
    isRecord(workflow) &&
      workflow.path === ".github/workflows/release.yml" &&
      Number.isSafeInteger(workflow.id) &&
      Number(workflow.id) > 0,
  );
  const route = `${applicationRepository}/actions/workflows/release.yml/runs`;
  const aliases = new Set([
    `/${route}`,
    `/${applicationRepository}/actions/workflows/${Number(workflow.id)}/runs`,
    `/repositories/1354613114/actions/workflows/${Number(workflow.id)}/runs`,
  ]);
  let requests = 0;
  const started = performance.now();
  const bounded: GitHubRestReader = {
    request(method, endpoint) {
      assert.equal(method, "GET");
      assert.ok(++requests <= 10 && performance.now() - started < 90000);
      const url = new URL(
        endpoint.startsWith("https:") ? endpoint : `https://api.github.com/${endpoint}`,
      );
      assert.equal(url.origin, "https://api.github.com");
      assert.ok(aliases.has(url.pathname));
      assert.equal([...url.searchParams.keys()].length, new Set(url.searchParams.keys()).size);
      assert.equal(url.searchParams.get("event"), "workflow_dispatch");
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.ok(
        [...url.searchParams.keys()].every((key) => ["event", "per_page", "page"].includes(key)),
      );
      if (url.searchParams.has("page"))
        assert.match(url.searchParams.get("page")!, /^(?:[1-9]|10)$/u);
      const response = api.request("GET", endpoint);
      assert.equal(response.status, 200);
      assert.ok(Buffer.byteLength(JSON.stringify(response.body)) <= 8 * 1024 ** 2);
      return response;
    },
  };
  const rows = GitHubApiClient.prototype.paginateRest.call(
    bounded,
    `${route}?event=workflow_dispatch&per_page=100`,
    {
      select(raw: unknown) {
        assert.ok(
          isRecord(raw) && Array.isArray(raw.workflow_runs) && raw.workflow_runs.length <= 100,
        );
        const rows: unknown[] = raw.workflow_runs;
        return rows;
      },
      totalCount(raw: unknown) {
        assert.ok(
          isRecord(raw) &&
            Number.isSafeInteger(raw.total_count) &&
            Number(raw.total_count) >= 0 &&
            Number(raw.total_count) < 1000,
          "provider run search at ceiling; completeness unknown",
        );
        return Number(raw.total_count);
      },
      identity(raw: unknown) {
        assert.ok(isRecord(raw) && Number.isSafeInteger(raw.id) && Number(raw.id) > 0);
        return Number(raw.id);
      },
      label: "native release opportunity runs",
    },
  );
  return rows
    .filter(
      (raw: unknown) =>
        isRecord(raw) && scopes.has(applicationOpportunityFromRunTitle(raw.display_title) ?? ""),
    )
    .map((raw: unknown) => {
      assert.ok(
        isRecord(raw) &&
          raw.path === ".github/workflows/release.yml" &&
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

export function readApplicationJobBudget(
  registeredRunIds: readonly string[] | undefined,
  purpose: unknown,
  executionPath: unknown = "ordinary",
  budgetContext?: ApplicationBudgetContext,
) {
  applicationReleaseRemainingMinutes(purpose, executionPath);
  const execution = inspectApplicationReleaseExecution(process.env);
  const opportunity = process.env.PORTCOVE_APPLICATION_RELEASE_OPPORTUNITY ?? "";
  const owner = budgetContext
    ? readApplicationBudgetOwner(applicationApi, budgetContext)
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
  const runs = readApplicationOpportunityRuns(applicationApi, opportunities);
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
  assert.ok(Array.isArray(known) && known.length <= 3 && new Set(known).size === known.length);
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
  let actual = 0,
    remaining = 0,
    attempts = 0;
  const evidence = [];
  for (const run of runs) {
    assert.ok(
      !["queued", "waiting", "requested", "pending"].includes(String(run.status)),
      "pending related release execution has unknown remaining work; no cost waiver",
    );
    const current = run.id === Number(execution.run_id);
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
    assert.ok(attempts <= 3, "release opportunity exhausted its bounded attempts across runs");
    const observations = [];
    for (let attempt = 1; attempt <= Number(run.run_attempt); attempt++)
      observations.push({
        context: applicationGet(`actions/runs/${Number(run.id)}/attempts/${attempt}`),
        jobs: applicationGet(
          `actions/runs/${Number(run.id)}/attempts/${attempt}/jobs?per_page=100`,
        ),
      });
    const result = inspectApplicationJobBudget(
      observations,
      String(run.head_sha),
      String(run.id),
      current,
      current ? purpose : "application-release",
      current ? executionPath : "ordinary",
    );
    actual += result.actual_milliseconds;
    remaining += result.remaining_declared_minutes;
    evidence.push({ run_id: String(run.id), ...result });
  }
  assert.ok(
    actual + remaining * 60000 <= 140 * 60000,
    "all actual opportunity executions plus remaining tail exceed application140",
  );
  return {
    actual_milliseconds: actual,
    remaining_declared_minutes: remaining,
    attempts,
    opportunities,
    maximum_minutes: 140,
    headroom: "unknown",
    reservation: false,
    paid_fallback: false,
    authority: "none",
    runs: evidence,
  };
}
