import { errorMessage, isRecord } from "./runtime-values.mts";
import type { WorkflowProvenance } from "./workflow-provenance.mts";
import roadmapConfig from "../.github/roadmap.json" with { type: "json" };
export interface CiRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  event: string;
  head_branch?: string | null;
  status: string;
  conclusion?: string | null;
  // Missing or malformed timestamps remain unavailable observations.
  created_at?: unknown;
  run_started_at?: unknown;
  updated_at?: unknown;
  html_url: string;
  workflow_id?: number | null;
  name?: string | null;
  pull_requests?: { number?: number; head?: { sha?: string }; base?: { sha?: string } }[];
}
export interface CiStep {
  name: string;
  status: string;
  conclusion?: string | null;
  started_at?: unknown;
  completed_at?: unknown;
}
export interface CiJob {
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
  created_at?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  runner_group_name?: string | null;
  labels?: string[];
  steps?: CiStep[];
}
export type AttemptProvenance =
  | { status: "unknown"; reason: string }
  | {
      status: "verified";
      record: Pick<WorkflowProvenance, "equivalent_cohort" | "validation">;
      reason?: never;
    };
export type CiRequest = (
  route: string,
  paginate?: boolean,
  responseType?: "json" | "buffer",
) => Promise<unknown>;
export interface HistoryOptions {
  repository: string;
  workflow?: string;
  branch?: string | undefined;
  event: string;
  limit: number;
  since?: string | undefined;
}
function optionalText(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}
function isStep(value: unknown): value is CiStep {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    optionalText(value.conclusion)
  );
}
function isJob(value: unknown): value is CiJob {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    optionalText(value.conclusion) &&
    (value.html_url == null || typeof value.html_url === "string") &&
    optionalText(value.runner_group_name) &&
    (value.labels === undefined ||
      (Array.isArray(value.labels) &&
        value.labels.every((label: unknown) => typeof label === "string"))) &&
    (value.steps === undefined || (Array.isArray(value.steps) && value.steps.every(isStep)))
  );
}
function isPullRequest(value: unknown): value is NonNullable<CiRun["pull_requests"]>[number] {
  return (
    isRecord(value) &&
    (value.number === undefined || typeof value.number === "number") &&
    [value.head, value.base].every(
      (ref) =>
        ref === undefined ||
        (isRecord(ref) && (ref.sha === undefined || typeof ref.sha === "string")),
    )
  );
}
function assertRun(value: unknown): asserts value is CiRun {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.run_attempt !== "number" ||
    !Number.isSafeInteger(value.run_attempt) ||
    value.run_attempt < 1 ||
    typeof value.head_sha !== "string" ||
    typeof value.event !== "string" ||
    typeof value.status !== "string" ||
    typeof value.html_url !== "string" ||
    !optionalText(value.conclusion) ||
    !optionalText(value.head_branch) ||
    !optionalText(value.name) ||
    (value.workflow_id !== undefined &&
      value.workflow_id !== null &&
      typeof value.workflow_id !== "number") ||
    (value.pull_requests !== undefined &&
      (!Array.isArray(value.pull_requests) || !value.pull_requests.every(isPullRequest)))
  )
    throw new Error("Malformed workflow run observation");
}
interface ArtifactObservation {
  id: number;
  name: string;
  expired: boolean;
  digest?: string | null;
  workflow_run?: { id?: number; head_sha?: string } | null;
}
function isArtifact(value: unknown): value is ArtifactObservation {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.name === "string" &&
    typeof value.expired === "boolean" &&
    (value.digest == null || typeof value.digest === "string") &&
    (value.workflow_run == null ||
      (isRecord(value.workflow_run) &&
        (value.workflow_run.id === undefined || typeof value.workflow_run.id === "number") &&
        (value.workflow_run.head_sha === undefined ||
          typeof value.workflow_run.head_sha === "string")))
  );
}
function pagedItems<T>(
  pages: unknown,
  key: string,
  predicate: (value: unknown) => value is T,
  missing: string,
  incomplete: string,
): T[] {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error(missing);
  let expected: number | undefined;
  const items: T[] = [];
  for (const page of pages as unknown[]) {
    if (!isRecord(page) || !Array.isArray(page[key])) throw new Error(missing);
    if (
      typeof page.total_count !== "number" ||
      !Number.isSafeInteger(page.total_count) ||
      page.total_count < 0 ||
      (expected !== undefined && page.total_count !== expected)
    )
      throw new Error(incomplete);
    expected = page.total_count;
    const entries: unknown[] = page[key];
    for (const entry of entries) {
      if (!predicate(entry)) throw new Error(missing);
      items.push(entry);
    }
  }
  if (items.length !== expected) throw new Error(incomplete);
  return items;
}
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parseProvenanceArchive, validateWorkflowProvenance } from "./workflow-provenance.mts";

const execute = promisify(execFile);

function secondsBetween(start: unknown, end: unknown) {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

const unknownProvenance = (
  reason = "missing-attempt-artifact",
): Extract<AttemptProvenance, { status: "unknown" }> => ({
  status: "unknown",
  reason,
});

export function summarizeAttempt(
  run: CiRun,
  jobs: readonly CiJob[],
  provenance: AttemptProvenance = unknownProvenance(),
) {
  // created_at belongs to the original run, even when inspecting a later attempt.
  const start = run.run_attempt === 1 ? run.created_at : run.run_started_at;
  const measuredJobs = jobs.map((job) => ({
    name: job.name,
    conclusion: job.conclusion,
    url: job.html_url,
    seconds:
      job.status === "completed" && job.conclusion !== "skipped"
        ? secondsBetween(job.started_at, job.completed_at)
        : null,
    preStartSeconds:
      job.status === "completed" && job.conclusion !== "skipped"
        ? secondsBetween(job.created_at, job.started_at)
        : null,
    runner: job.runner_group_name ?? null,
    labels: Array.isArray(job.labels) ? job.labels : [],
    steps: (job.steps ?? [])
      .filter((step) => step.status === "completed")
      .map((step) => ({
        name: step.name,
        seconds: secondsBetween(step.started_at, step.completed_at),
      }))
      .filter((step): step is typeof step & { seconds: number } => step.seconds !== null)
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 3),
  }));
  const completed = measuredJobs.filter(
    (job): job is typeof job & { seconds: number } => job.seconds !== null,
  );
  const completedJobs = jobs.filter(
    (job) =>
      job.status === "completed" &&
      job.conclusion !== "skipped" &&
      secondsBetween(job.started_at, job.completed_at) !== null,
  );
  const firstJobStarted = completedJobs
    .map((job) => job.started_at)
    .filter(
      (stamp): stamp is string => typeof stamp === "string" && Number.isFinite(Date.parse(stamp)),
    )
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const lastJobCompleted = completedJobs
    .map((job) => job.completed_at)
    .filter(
      (stamp): stamp is string => typeof stamp === "string" && Number.isFinite(Date.parse(stamp)),
    )
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const runnerCohort = [
    ...new Set(
      measuredJobs.flatMap((job) =>
        [job.runner, ...job.labels].filter(
          (label): label is string => typeof label === "string" && label.length > 0,
        ),
      ),
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const workflowSeconds = run.status === "completed" ? secondsBetween(start, run.updated_at) : null;
  const pullRequest =
    Array.isArray(run.pull_requests) && run.pull_requests.length === 1
      ? run.pull_requests[0]
      : null;
  return {
    runId: run.id,
    attempt: run.run_attempt,
    sha: run.head_sha,
    event: run.event,
    branch: run.head_branch,
    status: run.status,
    conclusion: run.conclusion,
    url: `${run.html_url}/attempts/${run.run_attempt}`,
    workflowId: run.workflow_id ?? null,
    workflowName: run.name ?? null,
    pullRequest: pullRequest
      ? {
          number: pullRequest.number ?? null,
          headSha: pullRequest.head?.sha ?? null,
          baseSha: pullRequest.base?.sha ?? null,
        }
      : null,
    provenance,
    workClass: provenance.status === "verified" ? provenance.record.validation.mode : "unknown",
    caller: provenance.status === "verified" ? provenance.record.validation.caller : "unknown",
    planDigest: provenance.status === "verified" ? provenance.record.validation.plan_digest : null,
    cohort:
      provenance.status === "verified"
        ? `exact:${provenance.record.equivalent_cohort};runners:${runnerCohort.join(",") || "unknown"}`
        : null,
    seconds: workflowSeconds,
    timing: {
      workflowSeconds,
      preJobSeconds: firstJobStarted ? secondsBetween(start, firstJobStarted) : null,
      observedJobWindowSeconds:
        firstJobStarted && lastJobCompleted
          ? secondsBetween(firstJobStarted, lastJobCompleted)
          : null,
      aggregationSeconds: lastJobCompleted
        ? secondsBetween(lastJobCompleted, run.updated_at)
        : null,
      summedRunnerSeconds:
        completed.length > 0 ? completed.reduce((total, job) => total + job.seconds, 0) : null,
    },
    jobs: measuredJobs,
    failedJobs: measuredJobs
      .filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
      .map((job) => job.name),
    cacheSteps: measuredJobs.flatMap((job) =>
      job.steps
        .filter((step) => /cache|restore/iu.test(step.name))
        .map((step) => ({ job: job.name, name: step.name, seconds: step.seconds })),
    ),
    failures: jobs
      .filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
      .map((job) => ({
        job: job.name,
        url: job.html_url,
        steps: (job.steps ?? [])
          .filter((step) => step.conclusion === "failure" || step.conclusion === "timed_out")
          .map((step) => step.name),
      })),
  };
}

function distribution(values: readonly (number | null)[]) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  return {
    count: sorted.length,
    p50Seconds: percentile(0.5),
    // Avoid presenting an unstable tail estimate as a useful long-term metric.
    p95Seconds: sorted.length >= 20 ? percentile(0.95) : null,
    maxSeconds: sorted.at(-1) ?? null,
  };
}

function stepCategory(name: string) {
  if (/checkout|setup|install|cache|restore|download|read .*pin|prepare .*fixture/iu.test(name))
    return "setup/tool acquisition";
  if (/test|build|clippy|lint|check|execute|archive|verify/iu.test(name)) return "execution";
  return "other";
}

function sampleCounts<T>(values: readonly T[], key: (value: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const name = key(value);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}
export function summarizeHistory(attempts: readonly ReturnType<typeof summarizeAttempt>[]) {
  const successful = attempts.filter(
    (attempt) => attempt.status === "completed" && attempt.conclusion === "success",
  );
  const recoveries = attempts
    .filter(
      (attempt) =>
        attempt.status === "completed" &&
        (["failure", "timed_out"].some((conclusion) => conclusion === attempt.conclusion) ||
          attempt.failedJobs.length > 0),
    )
    .flatMap((failed) => {
      const passed = successful
        .filter(
          (candidate) =>
            candidate.runId === failed.runId &&
            candidate.sha === failed.sha &&
            candidate.attempt > failed.attempt,
        )
        .sort((a, b) => a.attempt - b.attempt)[0];
      return passed
        ? [
            {
              runId: failed.runId,
              sha: failed.sha,
              failedAttempt: failed.attempt,
              passedAttempt: passed.attempt,
              failedJobs: failed.failedJobs,
              url: failed.url,
            },
          ]
        : [];
    });
  const jobSamples = new Map<string, number[]>();
  const stepSamples = new Map<string, number[]>();
  for (const attempt of successful.filter((attempt) => attempt.attempt === 1)) {
    for (const job of attempt.jobs) {
      if (job.seconds === null) continue;
      const samples = jobSamples.get(job.name) ?? [];
      samples.push(job.seconds);
      jobSamples.set(job.name, samples);
      for (const step of job.steps) {
        const key = `${job.name}\0${step.name}`;
        const values = stepSamples.get(key) ?? [];
        values.push(step.seconds);
        stepSamples.set(key, values);
      }
    }
  }
  const successfulFirst = successful.filter((attempt) => attempt.attempt === 1);
  const canceled = attempts.filter(
    (attempt) => attempt.status === "completed" && attempt.conclusion === "cancelled",
  );
  const cohorts = new Map<string, ReturnType<typeof summarizeAttempt>[]>();
  for (const attempt of successfulFirst) {
    if (!attempt.cohort) continue;
    const samples = cohorts.get(attempt.cohort) ?? [];
    samples.push(attempt);
    cohorts.set(attempt.cohort, samples);
  }
  return {
    runs: new Set(attempts.map((attempt) => attempt.runId)).size,
    commits: new Set(attempts.map((attempt) => attempt.sha)).size,
    attempts: attempts.length,
    outcomes: sampleCounts(attempts, (attempt) =>
      String(attempt.status === "completed" ? attempt.conclusion : attempt.status),
    ),
    workClasses: sampleCounts(attempts, (attempt) => attempt.workClass),
    callers: sampleCounts(attempts, (attempt) => attempt.caller),
    canceledWork: {
      attempts: canceled.length,
      workflow: distribution(canceled.map((attempt) => attempt.seconds)),
      summedRunner: distribution(canceled.map((attempt) => attempt.timing.summedRunnerSeconds)),
      observedRunnerSeconds: canceled.reduce(
        (total, attempt) => total + (attempt.timing.summedRunnerSeconds ?? 0),
        0,
      ),
      missingRunnerTimings: canceled.filter(
        (attempt) => attempt.timing.summedRunnerSeconds === null,
      ).length,
      unmeasuredJobs: canceled.reduce(
        (total, attempt) =>
          total +
          attempt.jobs.filter((job) => job.conclusion !== "skipped" && job.seconds === null).length,
        0,
      ),
      failedJobAttempts: canceled.filter((attempt) => attempt.failedJobs.length > 0).length,
      // API cancellation does not tell us whether supersession caused it.
      cause: "unclassified",
    },
    qualificationFailures: attempts
      .filter((attempt) => attempt.workClass === "qualification" && attempt.failures.length > 0)
      .flatMap((attempt) =>
        attempt.failures.map((failure) => ({
          runId: attempt.runId,
          attempt: attempt.attempt,
          planDigest: attempt.planDigest,
          ...failure,
        })),
      ),
    cacheObservations: attempts.reduce((total, attempt) => total + attempt.cacheSteps.length, 0),
    successfulFirstAttempts: distribution(
      successful.filter((attempt) => attempt.attempt === 1).map((attempt) => attempt.seconds),
    ),
    successfulReruns: distribution(
      successful.filter((attempt) => attempt.attempt > 1).map((attempt) => attempt.seconds),
    ),
    missingCompletedTimings: attempts.filter(
      (attempt) => attempt.status === "completed" && attempt.seconds === null,
    ).length,
    provenance: {
      verified: attempts.filter((attempt) => attempt.provenance.status === "verified").length,
      unknown: attempts.filter((attempt) => attempt.provenance.status !== "verified").length,
      unknownReasons: sampleCounts(
        attempts.filter((attempt) => attempt.provenance.status !== "verified"),
        (attempt) =>
          attempt.provenance.status === "unknown" ? attempt.provenance.reason : "unknown",
      ),
    },
    slowestJobs: [...jobSamples]
      .map(([name, values]) => ({
        name,
        ...distribution(values),
        slowestSteps: [...stepSamples]
          .filter(([key]) => key.startsWith(`${name}\0`))
          .map(([key, stepValues]) => ({
            name: key.slice(key.indexOf("\0") + 1),
            category: stepCategory(key.slice(key.indexOf("\0") + 1)),
            ...distribution(stepValues),
          }))
          .sort((left, right) => (right.p50Seconds ?? 0) - (left.p50Seconds ?? 0))
          .slice(0, 3),
      }))
      .sort((a, b) => (b.p50Seconds ?? 0) - (a.p50Seconds ?? 0))
      .slice(0, 8),
    rerunRecoveries: recoveries,
    timing: {
      preJob: distribution(successfulFirst.map((attempt) => attempt.timing.preJobSeconds)),
      observedJobWindow: distribution(
        successfulFirst.map((attempt) => attempt.timing.observedJobWindowSeconds),
      ),
      aggregation: distribution(
        successfulFirst.map((attempt) => attempt.timing.aggregationSeconds),
      ),
      summedRunner: distribution(
        successfulFirst.map((attempt) => attempt.timing.summedRunnerSeconds),
      ),
    },
    cohorts: [...cohorts]
      .map(([name, samples]) => ({
        name,
        attempts: samples.length,
        workflow: distribution(samples.map((attempt) => attempt.seconds)),
      }))
      .sort((left, right) => right.attempts - left.attempts),
    failureLeads: attempts
      .filter((attempt) => attempt.failures.length > 0)
      .flatMap((attempt) =>
        attempt.failures.map((failure) => ({
          runId: attempt.runId,
          attempt: attempt.attempt,
          sha: attempt.sha,
          ...failure,
        })),
      )
      .slice(0, 10),
  };
}

async function collectAttemptProvenance(
  request: CiRequest,
  root: string,
  run: CiRun,
  reference: { id: number; attempt: number },
  { repository, workflow }: { repository: string; workflow: string },
): Promise<AttemptProvenance> {
  const pages = await request(`${root}/runs/${reference.id}/artifacts?per_page=100`, true);
  const artifacts = pagedItems(
    pages,
    "artifacts",
    isArtifact,
    `Missing artifact inventory for ${reference.id}/${reference.attempt}`,
    `Incomplete artifacts for ${reference.id}/${reference.attempt}`,
  );
  const scope = workflow.replace(/\.ya?ml$/u, "");
  const expectedName = `workflow-provenance-${scope}-${reference.id}-${reference.attempt}`;
  const matches = artifacts.filter((artifact) => artifact.name === expectedName);
  if (matches.length === 0) return unknownProvenance();
  if (matches.length !== 1)
    throw new Error(`Ambiguous provenance for ${reference.id}/${reference.attempt}`);
  const artifact = matches[0];
  if (!artifact) throw new Error("Provenance artifact inventory changed");
  if (artifact.expired) return unknownProvenance("expired-attempt-artifact");
  if (
    artifact.workflow_run?.id !== reference.id ||
    artifact.workflow_run?.head_sha !== run.head_sha
  )
    throw new Error(
      `Provenance artifact run identity mismatch for ${reference.id}/${reference.attempt}`,
    );
  const archive = await request(
    `repos/${root.split("/")[1]}/${root.split("/")[2]}/actions/artifacts/${artifact.id}/zip`,
    false,
    "buffer",
  );
  if (!Buffer.isBuffer(archive)) throw new Error("Provenance artifact archive is not bytes");
  const expectedDigest = /^sha256:([a-f0-9]{64})$/u.exec(artifact.digest ?? "")?.[1];
  if (!expectedDigest || createHash("sha256").update(archive).digest("hex") !== expectedDigest)
    throw new Error(`Provenance artifact digest mismatch for ${reference.id}/${reference.attempt}`);
  const record = validateWorkflowProvenance(parseProvenanceArchive(archive), {
    runId: reference.id,
    attempt: reference.attempt,
    headSha: run.head_sha,
    repository,
    workflow,
    calledWorkflow: workflow === "qualification.yml" ? "ci.yml" : workflow,
    event: run.event,
  });
  return { status: "verified", record };
}

export async function collectHistory(
  request: CiRequest,
  { repository, workflow = "ci.yml", branch, event, limit, since }: HistoryOptions,
) {
  const root = `repos/${repository}/actions`;
  const query = new URLSearchParams({ event, per_page: String(limit) });
  if (branch) query.set("branch", branch);
  const listing = await request(`${root}/workflows/${workflow}/runs?${query.toString()}`);
  if (!isRecord(listing) || !Array.isArray(listing.workflow_runs))
    throw new Error("Missing workflow run inventory");
  const listingRuns: unknown[] = listing.workflow_runs;
  const runs = since
    ? listingRuns.filter((run) => {
        if (
          !isRecord(run) ||
          typeof run.created_at !== "string" ||
          !Number.isFinite(Date.parse(run.created_at))
        )
          throw new Error("Missing run creation time");
        return Date.parse(run.created_at) >= Date.parse(since);
      })
    : listingRuns;
  const references = runs.flatMap((run) => {
    if (
      !isRecord(run) ||
      typeof run.id !== "number" ||
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      typeof run.run_attempt !== "number" ||
      !Number.isInteger(run.run_attempt) ||
      run.run_attempt < 1
    )
      throw new Error("Missing attempt count");
    const id = run.id;
    return Array.from({ length: run.run_attempt }, (_, index) => ({
      id,
      attempt: index + 1,
    }));
  });
  const attempts = [];
  // Bound API concurrency; every historical attempt is read, including failures
  // which the latest successful rerun hides in GitHub's run listing.
  for (let offset = 0; offset < references.length; offset += 4) {
    attempts.push(
      ...(await Promise.all(
        references.slice(offset, offset + 4).map(async (reference) => {
          const route = `${root}/runs/${reference.id}/attempts/${reference.attempt}`;
          const run = await request(route);
          const pages = await request(`${route}/jobs?per_page=100`, true);
          const jobs = pagedItems(
            pages,
            "jobs",
            isJob,
            `Missing jobs for ${reference.id}/${reference.attempt}`,
            `Incomplete jobs for ${reference.id}/${reference.attempt}`,
          );
          assertRun(run);
          if (run.id !== reference.id || run.run_attempt !== reference.attempt)
            throw new Error("Attempt identity mismatch");
          const provenance = await collectAttemptProvenance(request, root, run, reference, {
            repository,
            workflow,
          });
          return summarizeAttempt(run, jobs, provenance);
        }),
      )),
    );
  }
  return {
    repository,
    workflow,
    branch,
    event,
    since: since ?? null,
    requestedRuns: limit,
    generatedAt: new Date().toISOString(),
    summary: summarizeHistory(attempts),
    attempts,
  };
}

const duration = (seconds: number | null) =>
  seconds === null
    ? "unavailable"
    : `${Math.floor(Math.round(seconds) / 60)}m${String(Math.round(seconds) % 60).padStart(2, "0")}s`;
const cell = (value: unknown) => String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");

export function renderReport(
  report: Omit<Awaited<ReturnType<typeof collectHistory>>, "workflow" | "branch" | "since"> &
    Partial<Pick<Awaited<ReturnType<typeof collectHistory>>, "workflow" | "branch" | "since">>,
) {
  const { summary } = report;
  const lines = [
    `# CI health: ${cell(report.repository)} / ${cell(report.workflow ?? "ci.yml")} / ${cell(report.branch ?? "all branches")} / ${cell(report.event)}`,
    "",
    `${summary.runs} runs, ${summary.attempts} attempts, ${summary.commits} commits. Generated ${report.generatedAt}.`,
    `Sample: latest ${report.requestedRuns} runs${report.branch ? ` filtered to ${report.branch}` : " across all branches"}${report.since ? ` and created since ${report.since}` : " (no date cutoff)"}. Workflow changes within this sample can make aggregate comparisons misleading.`,
    "",
    "GitHub timestamps separate only observable boundaries. Pre-job time can include dependency or runner scheduling; the job window includes dependency gaps; aggregation is the interval after the last observed job. Cache state is unclassified: first attempts are not necessarily cold and reruns are not necessarily warm.",
    "",
    "| Successful cohort | Samples | p50 | p95 (20+ samples) | Maximum |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const [label, stats] of [
    ["First attempts", summary.successfulFirstAttempts],
    ["Reruns", summary.successfulReruns],
  ] as const) {
    lines.push(
      `| ${label} | ${stats.count} | ${duration(stats.p50Seconds)} | ${duration(stats.p95Seconds)} | ${duration(stats.maxSeconds)} |`,
    );
  }
  lines.push(
    "",
    `Attempt outcomes: ${
      Object.entries(summary.outcomes)
        .map(([name, count]) => `${name}=${count}`)
        .join(", ") || "none"
    }.`,
    `Completed attempts with missing timing: ${summary.missingCompletedTimings}. Cancelled, failed and incomplete attempts are not included in successful-duration percentiles.`,
    `Cancelled work: ${summary.canceledWork.attempts} attempts; ${summary.canceledWork.observedRunnerSeconds}s observed summed runner execution (not billing), ${summary.canceledWork.missingRunnerTimings} attempts without runner timing and ${summary.canceledWork.unmeasuredJobs} unmeasured non-skipped jobs, ${summary.canceledWork.failedJobAttempts} containing failed jobs. Cancellation cause is unclassified; workflow p50 ${duration(summary.canceledWork.workflow.p50Seconds)}.`,
    "",
    "## Recent failure leads",
    "",
  );
  if (!summary.failureLeads.length) lines.push("No failed job observed in this sample.");
  else {
    lines.push("| Run / attempt | Commit | Failed job | Failed steps |", "|---|---|---|---|");
    for (const failure of summary.failureLeads)
      lines.push(
        `| ${failure.runId}/${failure.attempt} | ${cell(failure.sha?.slice(0, 8))} | [${cell(failure.job)}](${failure.url}) | ${failure.steps.map(cell).join(", ") || "Open the job log; no failed step was identified by the API."} |`,
      );
  }
  lines.push(
    "",
    "## Observed workflow timing",
    "",
    "| Boundary in successful first attempts | Samples | p50 | Maximum |",
    "|---|---:|---:|---:|",
  );
  for (const [label, stats] of [
    ["Before first observed job (dependency or scheduling)", summary.timing.preJob],
    ["First job start through last job completion", summary.timing.observedJobWindow],
    ["After last job through workflow update", summary.timing.aggregation],
    ["Summed runner execution (not elapsed or billing)", summary.timing.summedRunner],
  ] as const)
    lines.push(
      `| ${label} | ${stats.count} | ${duration(stats.p50Seconds)} | ${duration(stats.maxSeconds)} |`,
    );
  lines.push(
    "",
    "## Comparable cohorts",
    "",
    "Equivalent cohorts require an attempt-specific artifact that binds the official top-level caller source SHA/ref, called workflow bytes, checked-out code SHA, validation-plan digest/class/caller, desired configuration, the toolchains actually observed by the provenance job, explicit not-applicable toolchains, and reported job runner labels. Historical missing or expired evidence is unknown and excluded rather than inferred.",
    `Provenance: verified=${summary.provenance.verified}, unknown=${summary.provenance.unknown}${Object.entries(
      summary.provenance.unknownReasons,
    )
      .map(([reason, count]) => `, ${reason}=${count}`)
      .join("")}.`,
    "",
    "| Cohort | Attempts | Workflow p50 | Maximum |",
    "|---|---:|---:|---:|",
  );
  for (const cohort of summary.cohorts)
    lines.push(
      `| ${cell(cohort.name)} | ${cohort.attempts} | ${duration(cohort.workflow.p50Seconds)} | ${duration(cohort.workflow.maxSeconds)} |`,
    );
  if (!summary.cohorts.length)
    lines.push("| No verified equivalent cohort in this sample | 0 | unavailable | unavailable |");
  lines.push(
    "",
    "## Slow jobs in successful first attempts",
    "",
    "| Job | Samples | p50 | Maximum | Slowest observed steps |",
    "|---|---:|---:|---:|---|",
  );
  for (const job of summary.slowestJobs)
    lines.push(
      `| ${cell(job.name)} | ${job.count} | ${duration(job.p50Seconds)} | ${duration(job.maxSeconds)} | ${job.slowestSteps.map((step) => `${cell(step.name)} (${step.category}, p50 ${duration(step.p50Seconds)}, n=${step.count})`).join("; ") || "unavailable"} |`,
    );
  lines.push(
    "",
    "## Rerun recoveries",
    "",
    "These are investigation leads, not a measured flake rate. The commit is unchanged, but runners, caches and external services can differ.",
  );
  if (!summary.rerunRecoveries.length)
    lines.push(
      "",
      "No failed-then-passing rerun observed in this sample. This does not establish absence of flakes.",
    );
  for (const recovery of summary.rerunRecoveries)
    lines.push(
      "",
      `- [Run ${recovery.runId}, attempt ${recovery.failedAttempt}](${recovery.url}) reported failures; attempt ${recovery.passedAttempt} passed. Failed jobs: ${recovery.failedJobs.map(cell).join(", ") || "unavailable"}.`,
    );
  lines.push(
    "",
    "## Attempts",
    "",
    "| Run / attempt | Commit | Class / caller | Provenance | Result | Elapsed |",
    "|---|---|---|---|---|---:|",
  );
  for (const attempt of report.attempts)
    lines.push(
      `| [${attempt.runId}/${attempt.attempt}](${attempt.url}) | ${cell(attempt.sha?.slice(0, 8))} | ${cell(attempt.workClass)} / ${cell(attempt.caller)} | ${attempt.provenance.status === "verified" ? `verified ${attempt.provenance.record.equivalent_cohort.slice(0, 12)}` : `unknown (${cell(attempt.provenance.reason)})`} | ${cell(attempt.conclusion ?? attempt.status)} | ${duration(attempt.seconds)} |`,
    );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      workflow: { type: "string", default: "ci.yml" },
      branch: { type: "string" },
      event: { type: "string", default: "push" },
      runs: { type: "string", default: "20" },
      since: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/ci-health.mts [--workflow ci.yml] [--branch main] [--event push] [--runs 20] [--since ISO-date] [--json]\nRead-only GitHub CLI access is required. Push reports default to main; other events cover all branches unless --branch is supplied. All attempts of the selected runs are inspected.",
    );
    return;
  }
  const limit = Number(values.runs);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("--runs must be between 1 and 100");
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/u.test(values.workflow))
    throw new Error("--workflow must be a workflow YAML filename");
  if (values.since && !Number.isFinite(Date.parse(values.since)))
    throw new Error("--since must be a valid ISO date");
  const branch = values.branch ?? (values.event === "push" ? "main" : undefined);
  const { repository } = roadmapConfig;
  const request: CiRequest = async (route, paginate = false, responseType = "json") => {
    const args = ["api", "--method", "GET", route];
    if (paginate) args.push("--paginate", "--slurp");
    const { stdout } = await execute("gh", args, {
      encoding: responseType === "buffer" ? "buffer" : "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (responseType === "buffer") return stdout;
    const parsed: unknown = JSON.parse(
      typeof stdout === "string" ? stdout : stdout.toString("utf8"),
    );
    return parsed;
  };
  const report = await collectHistory(request, {
    repository,
    workflow: values.workflow,
    branch,
    event: values.event,
    limit,
    since: values.since ? new Date(values.since).toISOString() : undefined,
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : renderReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
