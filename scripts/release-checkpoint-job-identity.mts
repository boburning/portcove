/** Historical provider custody only. No expired OIDC token, latest-attempt
 * substitution, successful-effect inference, or current execution authority. */
import { performance } from "node:perf_hooks";
import { createGitHubRunner, GitHubApiClient, nextLink } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import {
  capacityExecutorJobProfile,
  hostedNativeJobProfile,
  controllerOidcSubject,
  inspectAssemblerIdentityExpectation,
} from "./assembler-job-identity.mts";
import type { CapacityExecutorRole } from "./assembler-job-identity.mts";
import { isRecord } from "./runtime-values.mts";
import { spawnSync } from "node:child_process";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";

const repository = "boburning/portcove";
const repositoryId = 1354613114;
type Spawn = NonNullable<NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"]>;

export interface HistoricalCheckpointJob {
  controller_revision: string;
  controller_ref: string;
  actor_id: string;
  run_id: string;
  run_attempt: number;
  job_id: number;
  check_run_id: string;
}

function instant(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new Error("historical checkpoint job time is unavailable");
  return Date.parse(value);
}

function upperInstant(value: unknown): number {
  const parsed = instant(value);
  const fraction = typeof value === "string" ? value.match(/\.(\d+)Z$/u)?.[1] : undefined;
  // GitHub normally reports whole seconds. Include the represented final
  // second, not an arbitrary clock-skew allowance beyond its precision.
  return parsed + (fraction ? Math.max(0, 10 ** (3 - fraction.length) - 1) : 999);
}

export function verifyHistoricalCheckpointJob(
  role: CapacityExecutorRole,
  rawExpected: HistoricalCheckpointJob,
  witnessedAt: number,
  transport: { cwd: string; deadline: number; spawn?: Spawn; api?: GitHubRestReader },
) {
  return verifyHistoricalFixedJob(
    capacityExecutorJobProfile(role),
    role,
    rawExpected,
    witnessedAt,
    transport,
    false,
  );
}

/** Historical custody of a completed fixed native parent. This authenticates
 * neither its report/capture nor an installation, minimum OS or native result. */
export function verifyHistoricalHostedNativeJob(
  platform: "windows-x86_64" | "linux-x86_64",
  rawExpected: HistoricalCheckpointJob,
  witnessedAt: number,
  transport: { cwd: string; deadline: number; spawn?: Spawn; api?: GitHubRestReader },
) {
  const { role: _role, ...observed } = verifyHistoricalFixedJob(
    hostedNativeJobProfile(platform),
    platform,
    rawExpected,
    witnessedAt,
    transport,
    true,
  );
  return {
    ...observed,
    platform_label: platform,
    native_acceptance: "not-established" as const,
  };
}

function verifyHistoricalFixedJob<
  Role extends CapacityExecutorRole | "windows-x86_64" | "linux-x86_64",
>(
  profile:
    | ReturnType<typeof capacityExecutorJobProfile>
    | ReturnType<typeof hostedNativeJobProfile>,
  role: Role,
  rawExpected: HistoricalCheckpointJob,
  witnessedAt: number,
  transport: { cwd: string; deadline: number; spawn?: Spawn; api?: GitHubRestReader },
  native: boolean,
) {
  const expected = inspectAssemblerIdentityExpectation({
    audience: "audience" in profile ? profile.audience : "portcove-capacity-executor",
    subject: controllerOidcSubject(rawExpected.controller_ref, profile.environment),
    controller_revision: rawExpected.controller_revision,
    controller_ref: rawExpected.controller_ref,
    actor_id: rawExpected.actor_id,
    run_id: rawExpected.run_id,
    run_attempt: rawExpected.run_attempt,
  });
  if (
    !Number.isSafeInteger(rawExpected.job_id) ||
    rawExpected.job_id < 1 ||
    !/^[1-9][0-9]{0,15}$/u.test(rawExpected.check_run_id) ||
    !Number.isSafeInteger(Number(rawExpected.check_run_id)) ||
    !Number.isFinite(witnessedAt)
  )
    throw new Error("historical checkpoint job/check/time binding differs");
  const started = performance.now();
  if (
    !Number.isFinite(transport.deadline) ||
    transport.deadline <= started ||
    transport.deadline - started > 120000
  )
    throw new Error("historical checkpoint requires the original bounded deadline");
  const remaining = () => {
    const value = Math.floor(Math.min(15000, transport.deadline - performance.now()));
    if (value < 1) throw new Error("historical checkpoint job deadline exhausted");
    return value;
  };
  const api =
    transport.api ??
    new GitHubApiClient((args, body) =>
      createGitHubRunner({
        cwd: transport.cwd,
        spawn:
          transport.spawn ??
          ((command, args, settings) =>
            spawnSync(command, args, {
              ...settings,
              env: readOnlyReleaseChildEnvironment() ?? process.env,
            })),
        maxBuffer: 2 * 1024 * 1024,
        timeoutMs: remaining(),
      })([...args, "--hostname", "github.com"], body),
    );
  let requests = 0;
  const get = (suffix: string) => {
    remaining();
    if (++requests > 20) throw new Error("historical checkpoint job request bound exhausted");
    const response = api.request("GET", `repos/${repository}${suffix}`);
    remaining();
    if (response.status !== 200) throw new Error("historical checkpoint provider read unavailable");
    return response;
  };
  const attemptPath = `/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`;
  const inspectAttempt = (raw: unknown) => {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "number" ||
      !Number.isSafeInteger(raw.id) ||
      String(raw.id) !== expected.run_id ||
      raw.run_attempt !== expected.run_attempt ||
      raw.head_sha !== expected.controller_revision ||
      raw.head_branch !== expected.controller_ref.slice("refs/tags/".length) ||
      (raw.path !== profile.workflow &&
        raw.path !== `${profile.workflow}@${expected.controller_ref}`) ||
      raw.event !== "workflow_dispatch" ||
      !["in_progress", "completed"].includes(String(raw.status)) ||
      !isRecord(raw.repository) ||
      raw.repository.id !== repositoryId ||
      raw.repository.full_name !== repository ||
      !isRecord(raw.head_repository) ||
      raw.head_repository.id !== repositoryId ||
      !isRecord(raw.actor) ||
      typeof raw.actor.id !== "number" ||
      !Number.isSafeInteger(raw.actor.id) ||
      String(raw.actor.id) !== expected.actor_id ||
      !isRecord(raw.triggering_actor) ||
      typeof raw.triggering_actor.id !== "number" ||
      !Number.isSafeInteger(raw.triggering_actor.id) ||
      String(raw.triggering_actor.id) !== expected.actor_id
    )
      throw new Error("historical checkpoint attempt identity differs");
  };
  inspectAttempt(get(attemptPath).body);
  const jobs: Record<string, unknown>[] = [];
  let total: number | null = null;
  for (let page = 1; page <= 16; page++) {
    const response = get(`${attemptPath}/jobs?per_page=100&page=${page}`);
    const raw = response.body;
    const next = nextLink(response.headers);
    if (next !== null) {
      const url = new URL(next);
      const suffix = `${attemptPath}/jobs`;
      if (
        url.protocol !== "https:" ||
        url.hostname !== "api.github.com" ||
        url.port ||
        url.username ||
        url.password ||
        url.hash ||
        ![`/repos/${repository}${suffix}`, `/repositories/${repositoryId}${suffix}`].includes(
          url.pathname,
        ) ||
        [...url.searchParams.keys()].sort().join(",") !== "page,per_page" ||
        url.searchParams.get("page") !== String(page + 1) ||
        url.searchParams.get("per_page") !== "100"
      )
        throw new Error("historical checkpoint job pagination link differs");
    }
    if (
      !isRecord(raw) ||
      typeof raw.total_count !== "number" ||
      !Number.isSafeInteger(raw.total_count) ||
      raw.total_count < 1 ||
      raw.total_count > 1600 ||
      (total !== null && total !== raw.total_count) ||
      !Array.isArray(raw.jobs) ||
      raw.jobs.length > 100
    )
      throw new Error("historical checkpoint attempt job inventory is incomplete");
    total = raw.total_count;
    for (const job of raw.jobs) {
      if (
        !isRecord(job) ||
        typeof job.id !== "number" ||
        !Number.isSafeInteger(job.id) ||
        job.id < 1 ||
        String(job.run_id) !== expected.run_id ||
        job.run_attempt !== expected.run_attempt ||
        job.head_sha !== expected.controller_revision
      )
        throw new Error("historical checkpoint inventory job identity differs");
      jobs.push(job);
    }
    if (jobs.length === total) {
      if (next !== null)
        throw new Error("historical checkpoint terminal page has a contradictory next link");
      break;
    }
    if (jobs.length > total || raw.jobs.length !== 100 || page === 16)
      throw new Error("historical checkpoint attempt job pages are incomplete");
  }
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length)
    throw new Error("historical checkpoint attempt has duplicate jobs");
  const inspectJob = (raw: unknown) => {
    if (native && (!isRecord(raw) || raw.status !== "completed" || raw.conclusion !== "success"))
      throw new Error("historical native job must complete successfully");
    if (
      !isRecord(raw) ||
      raw.id !== rawExpected.job_id ||
      String(raw.run_id) !== expected.run_id ||
      raw.run_attempt !== expected.run_attempt ||
      raw.head_sha !== expected.controller_revision ||
      raw.name !== profile.job ||
      raw.check_run_url !==
        `https://api.github.com/repos/${repository}/check-runs/${rawExpected.check_run_id}` ||
      !["in_progress", "completed"].includes(String(raw.status)) ||
      (Array.isArray(raw.labels) && raw.labels.includes("self-hosted"))
    )
      throw new Error("historical checkpoint selected job differs");
    const began = instant(raw.started_at);
    const finished =
      raw.status === "completed"
        ? Math.min(upperInstant(raw.completed_at), Date.now())
        : Date.now();
    if (
      finished < began ||
      witnessedAt < began ||
      witnessedAt > finished ||
      (raw.status === "completed" &&
        ![
          "success",
          "failure",
          "cancelled",
          "timed_out",
          "action_required",
          "neutral",
          "stale",
          "startup_failure",
        ].includes(String(raw.conclusion)))
    )
      throw new Error("verified checkpoint timestamp is outside the original started job");
    return {
      started_at: String(raw.started_at),
      completed_at: raw.status === "completed" ? String(raw.completed_at) : null,
      witnessed_interval: { start: began, end: finished },
    };
  };
  const matches = jobs.filter(
    (job) =>
      job.id === rawExpected.job_id ||
      job.check_run_url ===
        `https://api.github.com/repos/${repository}/check-runs/${rawExpected.check_run_id}`,
  );
  if (matches.length !== 1 || matches[0]!.id !== rawExpected.job_id)
    throw new Error("historical checkpoint selected job is absent or ambiguous");
  const before = inspectJob(matches[0]);
  const after = inspectJob(get(`/actions/jobs/${rawExpected.job_id}`).body);
  if (
    before.started_at !== after.started_at ||
    (before.completed_at !== null && before.completed_at !== after.completed_at)
  )
    throw new Error("historical checkpoint job interval changed during readback");
  inspectAttempt(get(attemptPath).body);
  return {
    controller_revision: expected.controller_revision,
    controller_ref: expected.controller_ref,
    actor_id: expected.actor_id,
    run_id: expected.run_id,
    run_attempt: expected.run_attempt,
    job_id: rawExpected.job_id,
    check_run_id: rawExpected.check_run_id,
    ...after,
    role,
    requests,
    evidence_scope:
      transport.api || transport.spawn ? ("injected-provider" as const) : ("github.com" as const),
    environment_evidence: "not-independently-observed" as const,
    required_environment: profile.environment,
    required_signer_confinement: "pinned-workflow-live-gate" as const,
    effect_outcome: "not-established" as const,
    protection_enforcement: "unproven" as const,
    authority: "none" as const,
  };
}
