/** Fixed role budget derivation only; provider metadata does not authenticate a
 * signer. The actual role still requires its signed OIDC identity and controls. */
import { performance } from "node:perf_hooks";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import type { TufSigningRole } from "./release-control-phases.mts";
import { isRecord } from "./runtime-values.mts";

type SigningRole = "payload" | TufSigningRole;
type ClockRole =
  | SigningRole
  | "classification-writer"
  | "classification-observer"
  | "candidate-building";
type JobIdentity = {
  run_id: string;
  run_attempt: number;
  controller_revision: string;
  controller_ref: string;
};
type BudgetArguments = [
  raw: unknown,
  identity: Pick<JobIdentity, "run_id" | "controller_revision">,
  now?: number,
  monotonic?: number,
];
type CurrentArguments = [identity: JobIdentity, root: string, processDeadline: number];
function signingOriginalJobDeadline(
  rawRole: unknown,
  raw: unknown,
  identity: { run_id: string; controller_revision: string },
  now = Date.now(),
  monotonic = performance.now(),
) {
  if (
    ![
      "payload",
      "releases",
      "preview",
      "stable",
      "snapshot",
      "timestamp",
      "classification-writer",
      "classification-observer",
      "candidate-building",
    ].includes(String(rawRole))
  )
    throw new Error("fixed online signing role required");
  const role = rawRole as ClockRole;
  const maximum = role === "payload" ? 570000 : role === "candidate-building" ? 405000 : 115000;
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.jobs) ||
    !Number.isSafeInteger(raw.total_count) ||
    Number(raw.total_count) < 1 ||
    Number(raw.total_count) > 100 ||
    raw.jobs.length !== raw.total_count
  )
    throw new Error("complete fixed TUF job inventory required");
  const ids = new Set<number>();
  for (const job of raw.jobs as unknown[]) {
    if (
      !isRecord(job) ||
      typeof job.id !== "number" ||
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      ids.has(job.id)
    )
      throw new Error("TUF job inventory duplicated or incomplete");
    ids.add(job.id);
  }
  const name =
    role === "candidate-building"
      ? "Authenticate release control inputs"
      : role === "classification-writer"
        ? "Persist independently reviewed classification"
        : role === "classification-observer"
          ? "Observe release input protections"
          : releaseControlPhaseProfile(role === "payload" ? "payload" : `tuf-${role}`).reader_name;
  const matches = raw.jobs.filter((job: unknown) => isRecord(job) && job.name === name);
  const job: unknown = matches[0];
  if (
    matches.length !== 1 ||
    !isRecord(job) ||
    String(job.run_id) !== identity.run_id ||
    job.run_attempt !== 1 ||
    job.head_sha !== identity.controller_revision ||
    job.status !== "in_progress" ||
    typeof job.started_at !== "string"
  )
    throw new Error("actual fixed TUF job start unavailable");
  const remaining = Date.parse(job.started_at) + maximum - now;
  if (
    !Number.isFinite(remaining) ||
    remaining <= 0 ||
    remaining > maximum ||
    !Number.isFinite(monotonic)
  )
    throw new Error("original TUF job budget exhausted or future dated");
  return monotonic + remaining;
}

/** Reads the original fixed job BEFORE any tool receipt/download. No caller
 * supplied timestamp can reset the selected two-minute job's cleanup reserve. */
function currentSigningJobDeadline(
  role: ClockRole,
  identity: {
    run_id: string;
    run_attempt: number;
    controller_revision: string;
    controller_ref: string;
  },
  root: string,
  processDeadline: number,
) {
  if (
    !/^[1-9][0-9]{0,15}$/u.test(identity.run_id) ||
    !/^[a-f0-9]{40}$/u.test(identity.controller_revision) ||
    identity.run_attempt !== 1 ||
    identity.run_id !== process.env.GITHUB_RUN_ID ||
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    identity.controller_revision !== process.env.GITHUB_SHA ||
    identity.controller_ref !== process.env.GITHUB_REF
  )
    throw new Error("TUF invocation is not the original fixed job");
  const remaining = () => {
    const left = Math.floor(processDeadline - performance.now());
    if (!Number.isFinite(left) || left < 1) throw new Error("fixed TUF job deadline exhausted");
    return Math.min(left, 15000);
  };
  const api = new GitHubApiClient((args, input) =>
    createGitHubRunner({
      cwd: root,
      timeoutMs: remaining(),
      maxBuffer: 2 * 1024 ** 2,
    })([...args, "--hostname", "github.com"], input),
  );
  const response = api.request(
    "GET",
    `repos/boburning/portcove/actions/runs/${identity.run_id}/attempts/1/jobs?per_page=100`,
  );
  remaining();
  if (response.status !== 200) throw new Error("original TUF job budget unavailable");
  return Math.min(processDeadline, signingOriginalJobDeadline(role, response.body, identity));
}
export function tufOriginalJobDeadline(role: unknown, ...args: BudgetArguments) {
  if (!["releases", "preview", "stable", "snapshot", "timestamp"].includes(String(role)))
    throw new Error("fixed online TUF role required");
  return signingOriginalJobDeadline(role, ...args);
}
export function payloadOriginalJobDeadline(...args: BudgetArguments) {
  return signingOriginalJobDeadline("payload", ...args);
}
export function currentTufJobDeadline(role: unknown, ...args: CurrentArguments) {
  if (!["releases", "preview", "stable", "snapshot", "timestamp"].includes(String(role)))
    throw new Error("fixed online TUF role required");
  return currentSigningJobDeadline(role as TufSigningRole, ...args);
}
export function currentPayloadJobDeadline(...args: CurrentArguments) {
  return currentSigningJobDeadline("payload", ...args);
}

/** Clock metadata does not make either classification job a signing executor. */
export function classificationOriginalJobDeadline(role: unknown, ...args: BudgetArguments) {
  if (role !== "writer" && role !== "observer")
    throw new Error("fixed classification clock role required");
  return signingOriginalJobDeadline(`classification-${role}`, ...args);
}
export function currentClassificationJobDeadline(role: unknown, ...args: CurrentArguments) {
  if (role !== "writer" && role !== "observer")
    throw new Error("fixed classification clock role required");
  return currentSigningJobDeadline(`classification-${role}`, ...args);
}

/** Admission clock only; this does not create an executor or signing role. */
export function buildingOriginalJobDeadline(...args: BudgetArguments) {
  return signingOriginalJobDeadline("candidate-building", ...args);
}
export function currentBuildingJobDeadline(...args: CurrentArguments) {
  return currentSigningJobDeadline("candidate-building", ...args);
}
