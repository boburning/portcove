/** Fixed role budget derivation only; provider metadata does not authenticate a
 * signer. The actual role still requires its signed OIDC identity and controls. */
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  requireAdmittedProductionSource,
  maximumProductionControllerWorkflowBytes,
} from "./production-controller-admission.mts";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import type { TufSigningRole } from "./release-control-phases.mts";
import type { CatalogControlPhase } from "./release-control-phases.mts";
import { applicationProtectionObserver } from "./release-control-phases.mts";
import { isRecord } from "./runtime-values.mts";
import { hostedNativeJobProfile } from "./assembler-job-identity.mts";

type SigningRole = "payload" | TufSigningRole;
type ClockRole =
  | SigningRole
  | CatalogControlPhase
  | "classification-writer"
  | "classification-observer"
  | "candidate-building"
  | "coordinator"
  | "release-publication"
  | "site-publication"
  | "native-windows"
  | "native-linux"
  | "application-protection";
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
  admittedNativeMaximum?: number,
) {
  if (
    ![
      "payload",
      "releases",
      "preview",
      "stable",
      "snapshot",
      "timestamp",
      "catalog-definitions",
      "catalog-policy",
      "catalog-snapshot",
      "catalog-timestamp",
      "classification-writer",
      "classification-observer",
      "candidate-building",
      "coordinator",
      "release-publication",
      "site-publication",
      "native-windows",
      "native-linux",
      "application-protection",
    ].includes(String(rawRole))
  )
    throw new Error("fixed online signing role required");
  const role = rawRole as ClockRole;
  const maximum =
    (role === "native-windows" || role === "native-linux") && admittedNativeMaximum !== undefined
      ? admittedNativeMaximum
      : role === "payload" ||
          role === "native-windows" ||
          role === "native-linux" ||
          role === "application-protection"
        ? 570000
        : role === "candidate-building"
          ? 525000
          : role === "coordinator"
            ? 170000
            : role === "release-publication"
              ? 350000
              : role === "site-publication"
                ? 290000
                : 115000;
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
    role === "application-protection"
      ? applicationProtectionObserver.name
      : role === "coordinator" || role === "release-publication" || role === "site-publication"
        ? releaseControlPhaseProfile(role).reader_name
        : role === "native-windows" || role === "native-linux"
          ? hostedNativeJobProfile(role === "native-linux" ? "linux-x86_64" : "windows-x86_64").job
          : role === "candidate-building"
            ? "Authenticate release control inputs"
            : role === "classification-writer"
              ? "Persist independently reviewed classification"
              : role === "classification-observer"
                ? "Observe release input protections"
                : releaseControlPhaseProfile(
                    role.startsWith("catalog-")
                      ? role
                      : role === "payload"
                        ? "payload"
                        : `tuf-${role}`,
                  ).reader_name;
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
  admittedNativeMaximum?: number,
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
  return Math.min(
    processDeadline,
    signingOriginalJobDeadline(
      role,
      response.body,
      identity,
      Date.now(),
      performance.now(),
      admittedNativeMaximum,
    ),
  );
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

function nativeClockRole(platform: unknown): "native-windows" | "native-linux" {
  if (platform === "windows-x86_64") return "native-windows";
  if (platform === "linux-x86_64") return "native-linux";
  throw new Error("fixed native clock platform required");
}
/** A fixed native job declaration from the SAME admitted immutable source.
 * This is clock metadata, not resource ratification or execution authority.
 * Keep this pre-tool path dependency-free: recognize only the selected job's
 * direct canonical literal, refusing other YAML spellings/merges/expressions. */
export function admittedNativeProviderMaximumMilliseconds(
  platform: unknown,
  source: unknown,
  workflowBytes: Uint8Array,
  identity: JobIdentity,
) {
  const role = nativeClockRole(platform),
    job = role === "native-linux" ? "native_linux" : "native_windows";
  requireAdmittedProductionSource(source, job, "application");
  if (
    source.mode !== "bounded-application-release" ||
    source.revision !== identity.controller_revision ||
    source.execution_ref !== identity.controller_ref ||
    source.run_id !== identity.run_id ||
    source.run_attempt !== identity.run_attempt ||
    identity.run_attempt !== 1
  )
    throw Error("Original native source/clock identity differs");
  if (
    !(workflowBytes instanceof Uint8Array) ||
    workflowBytes.byteLength < 1 ||
    workflowBytes.byteLength > maximumProductionControllerWorkflowBytes
  )
    throw Error("Bounded original workflow bytes required");
  const bytes = Buffer.from(workflowBytes);
  if (createHash("sha256").update(bytes).digest("hex") !== source.workflow_sha256)
    throw Error("Original admitted native workflow bytes differ");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw Error("Original workflow UTF8 required");
  const lines = text.split(/\r?\n/u),
    roots = lines.flatMap((line, index) => (line === "jobs:" ? [index] : []));
  if (roots.length !== 1) throw Error("One canonical jobs mapping required");
  const from = roots[0]! + 1;
  let end = lines.length;
  for (let i = from; i < lines.length; i++)
    if (/^\S/u.test(lines[i]!) && !lines[i]!.startsWith("#")) {
      end = i;
      break;
    }
  const header = new RegExp("^  (?:" + job + "|'" + job + "'|\"" + job + '"):', "u"),
    selected = [];
  for (let i = from; i < end; i++) if (header.test(lines[i]!)) selected.push(i);
  if (selected.length !== 1 || lines[selected[0]!] !== "  " + job + ":")
    throw Error("One canonical fixed native job header required");
  const start = selected[0]! + 1;
  let stop = end;
  for (let i = start; i < end; i++)
    if (/^ {0,2}\S/u.test(lines[i]!) && !/^\s*#/u.test(lines[i]!)) {
      stop = i;
      break;
    }
  const body = lines.slice(start, stop);
  if (body.some((line) => /^    ["']?<<["']?\s*:/u.test(line)))
    throw Error("Selected native job merge refused");
  const timeouts = body.filter((line) =>
    /^    (?:timeout-minutes|"timeout-minutes"|'timeout-minutes')\s*:/u.test(line),
  );
  const literal =
    timeouts.length === 1
      ? /^    timeout-minutes: ([1-9][0-9]{0,2})\s*$/u.exec(timeouts[0]!)
      : null;
  const minutes = literal ? Number(literal[1]) : NaN;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 360)
    throw Error("One direct literal native timeout1..360 required");
  requireAdmittedProductionSource(source, job, "application");
  return minutes * 60000 - 30000;
}
/** Legacy pure fixture clock remains ten minutes minus its30-second reserve.
 * Extra caller arguments cannot inject an extended provider allocation. */
export function nativeOriginalJobDeadline(platform: unknown, ...args: BudgetArguments) {
  return signingOriginalJobDeadline(nativeClockRole(platform), args[0], args[1], args[2], args[3]);
}
/** The actual admitted declared job starts once at provider.started_at. The
 * caller's existing earlier process/owner clock can only shorten that window. */
export function currentNativeJobDeadline(
  platform: unknown,
  identity: JobIdentity,
  root: string,
  processDeadline: number,
  source: unknown,
  workflowBytes: Uint8Array,
) {
  const maximum = admittedNativeProviderMaximumMilliseconds(
    platform,
    source,
    workflowBytes,
    identity,
  );
  return currentSigningJobDeadline(
    nativeClockRole(platform),
    identity,
    root,
    processDeadline,
    maximum,
  );
}
/** One original shared observer allocation; individual phases cannot renew it. */
export function sharedProtectionOriginalJobDeadline(...args: BudgetArguments) {
  return signingOriginalJobDeadline("application-protection", ...args);
}
export function currentSharedProtectionJobDeadline(...args: CurrentArguments) {
  return currentSigningJobDeadline("application-protection", ...args);
}
function catalogClockRole(raw: unknown): CatalogControlPhase {
  if (
    raw !== "catalog-definitions" &&
    raw !== "catalog-policy" &&
    raw !== "catalog-snapshot" &&
    raw !== "catalog-timestamp"
  )
    throw new Error("fixed catalog signing clock role required");
  return raw;
}
export function catalogOriginalJobDeadline(role: unknown, ...args: BudgetArguments) {
  return signingOriginalJobDeadline(catalogClockRole(role), ...args);
}
export function currentCatalogJobDeadline(role: unknown, ...args: CurrentArguments) {
  return currentSigningJobDeadline(catalogClockRole(role), ...args);
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

/** Resource clock for the closed job bootstrap only, never role authority. */
export function currentControllerJobDeadline(operation: unknown, ...args: CurrentArguments) {
  const role = operation === "building" ? "candidate-building" : operation;
  if (
    role === "payload" ||
    role === "candidate-building" ||
    role === "coordinator" ||
    role === "release-publication" ||
    role === "site-publication"
  )
    return currentSigningJobDeadline(role, ...args);
  if (typeof role === "string" && role.startsWith("tuf-"))
    return currentTufJobDeadline(role.slice(4), ...args);
  if (typeof role === "string" && role.startsWith("catalog-"))
    return currentCatalogJobDeadline(role, ...args);
  throw new Error("fixed controller job clock required");
}
