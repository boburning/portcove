import { isRecord, errorMessage } from "./runtime-values.mts";
import { readFile, open, lstat } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { renderBoundedSummary, summarizeReport, retainReportSummary } from "./report-summary.mts";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkClosureIntent, readClosingRelationships } from "./closure-intent.mts";
import type { GitHubRunner, OperationStatus } from "./github-api.mts";
import type { RenovatePull, RenovateBaseEvidence } from "./renovate-fast-lane.mts";
import {
  GitHubApiClient,
  createGitHubRunner,
  githubOperationEnvelope,
  sanitizeOperationError,
} from "./github-api.mts";
import {
  classifyRenovateSnapshot,
  fastLaneSummary,
  inspectCurrentBase,
  parseRenovateUpdates,
  runMetadataValidation,
  renovateSecurityIntent,
} from "./renovate-fast-lane.mts";

export interface DeliveryPull extends Omit<RenovatePull, "head" | "base" | "body"> {
  number: number;
  head: { sha: string; ref?: string };
  base: { sha: string; ref?: string };
  body?: string | null;
  commits?: number;
  changed_files?: number;
  html_url?: string;
  merge_commit_sha?: string | null;
  assignees?: { login: string }[];
}
export interface DeliveryCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
}
export interface DeliveryStatus {
  id: number;
  context: string;
  state: string;
  description?: string | null;
  target_url?: string | null;
}
export interface DeliveryWorkflow {
  id: number;
  run_attempt: number;
  head_sha: string;
  status: string;
  conclusion?: string | null;
  name?: string;
  html_url?: string;
  created_at?: string | null;
  run_started_at?: string | null;
}
export interface DeliveryJob {
  id: number;
  name: string;
  status: string;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  conclusion?: string | null;
  check_run_url?: string;
  completed_at?: string | null;
}
interface CheckObservation {
  source: "check-run" | "commit-status";
  check_run_id?: number;
  outcome: "success" | "failure" | "pending";
  conclusion: string;
  url: string | null;
  description?: string | null;
}
export interface RequiredContext {
  context: string;
  outcome: "success" | "failure" | "pending";
  conclusion: string;
  observations: CheckObservation[];
  source?: "check-run" | "commit-status";
  check_run_id?: number;
}
interface ConfirmedMergeResult {
  merged: true;
  sha: string;
  [key: string]: unknown;
}
function assertMergeResult(value: unknown): asserts value is ConfirmedMergeResult {
  if (!isRecord(value) || value.merged !== true || typeof value.sha !== "string")
    throw new Error("Merge result is incomplete");
}
type ClassifiedVerdict = ReturnType<typeof classifyRenovateSnapshot>;
type MetadataEvidence = Extract<ClassifiedVerdict, { verdict: "metadata-required" }>["evidence"];
type DeliveryVerdict =
  | ClassifiedVerdict
  | {
      verdict: "merge-ready";
      reason: string;
      evidence: MetadataEvidence & { metadata: Awaited<ReturnType<typeof runMetadataValidation>> };
    }
  | { verdict: "manual-review-required"; reason: string; evidence: MetadataEvidence };

interface DeliveryReceipt {
  result: { sha: string };
  [key: string]: unknown;
}
export class DeliveryOutcomeError extends Error {
  readonly code: string;
  readonly operationStatus: OperationStatus;
  readonly operationEvidence: unknown;
  constructor(
    operationStatus: OperationStatus,
    message: string,
    operationEvidence: unknown,
    cause: unknown,
  ) {
    super(message, cause ? { cause } : undefined);
    this.code = `pr_delivery_${operationStatus}`;
    this.operationStatus = operationStatus;
    this.operationEvidence = operationEvidence;
  }
}
function fields(
  value: unknown,
  shape: Readonly<
    Record<string, "string" | "number" | "boolean" | "nullableString" | "nullableBoolean">
  >,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("GitHub metadata is not an object");
  for (const [key, type] of Object.entries(shape)) {
    const field = value[key];
    if (field === undefined) continue;
    const valid =
      type === "nullableString"
        ? field === null || typeof field === "string"
        : type === "nullableBoolean"
          ? field === null || typeof field === "boolean"
          : typeof field === type;
    if (!valid) throw new Error(`GitHub ${key} metadata has an invalid type`);
  }
}
function assertPullProjection(
  value: unknown,
  number: number,
): asserts value is DeliveryPull & Record<string, unknown> {
  fields(value, {
    title: "string",
    body: "nullableString",
    commits: "number",
    changed_files: "number",
    html_url: "string",
    merge_commit_sha: "nullableString",
    draft: "boolean",
    mergeable: "nullableBoolean",
    merged: "boolean",
    state: "string",
  });
  if (
    !isRecord(value.head) ||
    typeof value.head.sha !== "string" ||
    !value.head.sha ||
    !isRecord(value.base) ||
    typeof value.base.sha !== "string" ||
    !value.base.sha ||
    value.number !== number
  )
    throw new Error(`pull request #${number} response is incomplete`);
  fields(value.head, { ref: "string" });
  fields(value.base, { ref: "string" });
  if (value.user !== undefined && value.user !== null) fields(value.user, { login: "string" });
  if (value.labels !== undefined) {
    if (!Array.isArray(value.labels)) throw new Error("GitHub labels metadata is invalid");
    const labels: unknown[] = value.labels;
    for (const label of labels) fields(label, { name: "string" });
  }
  if (value.assignees !== undefined) {
    if (!Array.isArray(value.assignees)) throw new Error("GitHub assignee metadata is invalid");
    const assignees: unknown[] = value.assignees;
    for (const assignee of assignees)
      if (!isRecord(assignee) || typeof assignee.login !== "string")
        throw new Error("GitHub assignee login is invalid");
  }
  // The above checks admit only the fields consumed by this delivery adapter;
  // preserve other provider metadata without claiming its schema.
}
function pullMetadata(value: unknown, number: number): DeliveryPull {
  assertPullProjection(value, number);
  return value;
}
function checkMetadata(value: unknown): DeliveryCheckRun {
  fields(value, { conclusion: "nullableString", html_url: "nullableString" });
  if (
    typeof value.id !== "number" ||
    typeof value.name !== "string" ||
    typeof value.status !== "string"
  )
    throw new Error("GitHub check-run metadata is incomplete");
  return {
    ...value,
    id: value.id,
    name: value.name,
    status: value.status,
    ...optionalCheckFields(value),
  };
}
function optionalCheckFields(value: Record<string, unknown>): {
  conclusion?: string | null;
  html_url?: string | null;
} {
  const result: { conclusion?: string | null; html_url?: string | null } = {};
  if (typeof value.conclusion === "string" || value.conclusion === null)
    result.conclusion = value.conclusion;
  if (typeof value.html_url === "string" || value.html_url === null)
    result.html_url = value.html_url;
  return result;
}

function statusMetadata(value: unknown): DeliveryStatus {
  fields(value, { description: "nullableString", target_url: "nullableString" });
  if (
    typeof value.id !== "number" ||
    typeof value.context !== "string" ||
    typeof value.state !== "string"
  )
    throw new Error("GitHub status metadata is incomplete");
  const result: DeliveryStatus = {
    ...value,
    id: value.id,
    context: value.context,
    state: value.state,
  };
  if (typeof value.description === "string" || value.description === null)
    result.description = value.description;
  if (typeof value.target_url === "string" || value.target_url === null)
    result.target_url = value.target_url;
  return result;
}
function assertWorkflow(value: unknown): asserts value is DeliveryWorkflow {
  fields(value, {
    conclusion: "nullableString",
    name: "string",
    html_url: "string",
    created_at: "nullableString",
    run_started_at: "nullableString",
  });
  if (
    typeof value.id !== "number" ||
    typeof value.run_attempt !== "number" ||
    typeof value.head_sha !== "string" ||
    typeof value.status !== "string"
  )
    throw new Error("GitHub workflow metadata is incomplete");
}
function assertJob(value: unknown): asserts value is DeliveryJob {
  fields(value, {
    conclusion: "nullableString",
    check_run_url: "string",
    completed_at: "nullableString",
  });
  if (
    typeof value.id !== "number" ||
    typeof value.run_id !== "number" ||
    typeof value.run_attempt !== "number" ||
    typeof value.head_sha !== "string" ||
    typeof value.name !== "string" ||
    typeof value.status !== "string"
  )
    throw new Error("GitHub job metadata is incomplete");
}
export interface DeliveryQueueSnapshot {
  pull: DeliveryPull;
  commits: { sha?: string; author?: { login?: string } | null }[];
  files: { filename: string; status?: string }[];
  contexts: WatchContext[];
  statuses: Omit<DeliveryStatus, "id">[];
  target: { commit: { sha: string } };
  checkRuns?: DeliveryCheckRun[];
}
export interface DeliveryQueueClient {
  branch(name: string): { commit: { sha: string } };
  openRenovatePulls(): { number: number; head?: unknown }[];
  renovateSnapshot(number: number, head: string, contexts: string[]): DeliveryQueueSnapshot;
  sourceWorkflowRuns(
    head: string,
  ): (Pick<DeliveryWorkflow, "id" | "run_attempt" | "status"> &
    Partial<Pick<DeliveryWorkflow, "name" | "conclusion" | "run_started_at" | "html_url">>)[];
}

export interface WatchContext {
  context: string;
  outcome: "success" | "failure" | "pending";
  conclusion: string;
  source?: "check-run" | "commit-status";
  check_run_id?: number;
}
export interface WatchState {
  contexts: WatchContext[];
  pull?: unknown;
  head?: string;
}
export interface WatchClient {
  beginObservation?: () => void;
  workflowRun(run: number): DeliveryWorkflow;
  requiredCheckState(number: number, head: string, contexts: string[]): WatchState;
  workflowJobs?(run: number, attempt: number): DeliveryJob[];
}
export interface WatchObservation {
  format?: number;
  recorded_at?: string;
  kind: string;
  head?: string;
  run?: number;
  attempt?: number;
  workflow?: {
    head_sha?: string | undefined;
    run_attempt?: number | undefined;
    status?: string | undefined;
    conclusion?: string | null | undefined;
  } | null;
  contexts?: WatchContext[];
  jobs?: DeliveryJob[];
}
export interface WatchOptions {
  number: number;
  head: string;
  requiredContexts: string[];
  run: number;
  attempt: number;
  deadline: string;
  sleep?: (milliseconds: number) => Promise<unknown>;
  now?: () => number;
  observe?: (observation: WatchObservation) => void;
}

const timestamp = (value: string | null | undefined) => Date.parse(value ?? "");

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const repository = "boburning/portcove";

export function baselineTimingWindow(
  workflow: { run_started_at?: string | null; created_at?: string | null },
  jobs: ({ name: string; completed_at?: string | null } | undefined)[],
  contexts: { context: string }[],
) {
  const start = timestamp(workflow.run_started_at);
  const created = timestamp(workflow.created_at);
  const completed = contexts
    .map((context) => jobs.find((job) => job?.name === context.context)?.completed_at)
    .map(timestamp);
  const valid =
    Number.isFinite(start) &&
    Number.isFinite(created) &&
    start >= created &&
    completed.length > 0 &&
    completed.every((end) => Number.isFinite(end) && end >= start);
  return {
    queue_ms:
      Number.isFinite(start) && Number.isFinite(created) && start >= created
        ? start - created
        : null,
    baseline_elapsed_ms: valid ? Math.max(...completed) - start : null,
    measurement: valid ? "observed" : "unavailable",
    boundary: "workflow start to last required context completion",
  };
}

function deliveryOutcomeError(
  status: OperationStatus,
  message: string,
  evidence: unknown = {},
  cause: unknown = null,
) {
  return new DeliveryOutcomeError(status, message, evidence, cause);
}

export function retainMergeReceipt(
  directory: string,
  packet: DeliveryReceipt,
  io: {
    mkdirSync(directory: string, options: { recursive: true }): unknown;
    writeFileSync(file: string, data: string, options: { flag: "wx" }): unknown;
  } = { mkdirSync, writeFileSync },
) {
  const file = path.join(directory, `${randomUUID()}-merge.json`);
  try {
    io.mkdirSync(directory, { recursive: true });
    io.writeFileSync(file, JSON.stringify(packet), { flag: "wx" });
    return file;
  } catch (error) {
    throw deliveryOutcomeError(
      "failed",
      `Merge completed as ${packet.result.sha}; receipt retention failed; do not retry merge: ${errorMessage(error)}`,
      { merge_completed: true, ...packet },
      error,
    );
  }
}

function exactKeys(value: object | undefined, expected: string[], label: string) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted))
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
}

export function requiredContextsFromConfigs(ruleset: unknown, coverage: unknown): string[] {
  const rules = isRecord(ruleset) && Array.isArray(ruleset.rules) ? ruleset.rules : [];
  const values: unknown[] = rules;
  const rule = values.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.type === "required_status_checks",
  );
  const parameters = isRecord(rule?.parameters) ? rule.parameters : undefined;
  const entries = parameters?.required_status_checks;
  const contexts: unknown[] = Array.isArray(entries)
    ? entries.map((entry: unknown) => (isRecord(entry) ? entry.context : undefined))
    : [];
  if (
    !contexts.length ||
    !contexts.every(
      (context): context is string => typeof context === "string" && Boolean(context),
    ) ||
    new Set(contexts).size !== contexts.length
  )
    throw new Error("repository ruleset required checks are incomplete");
  const coverageContexts = isRecord(coverage) ? coverage.protected_contexts : undefined;
  if (
    !Array.isArray(coverageContexts) ||
    !coverageContexts.every((value: unknown): value is string => typeof value === "string") ||
    JSON.stringify([...contexts].sort()) !== JSON.stringify([...coverageContexts].sort())
  )
    throw new Error("repository ruleset and qualification protected contexts differ");
  return contexts;
}

export function parsePullRequestReference(value: string | number) {
  const numeric = /^(\d+)$/u.exec(String(value));
  if (numeric && Number(numeric[1]) > 0) return Number(numeric[1]);
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/u.exec(String(value));
  if (!url || (url[1] ?? "").toLowerCase() !== repository.toLowerCase() || Number(url[2]) < 1)
    throw new Error(`invalid ${repository} pull request reference: ${value}`);
  return Number(url[2]);
}

export class PullRequestDeliveryClient {
  api: Pick<GitHubApiClient, "request" | "paginateRest" | "graphql">;
  beginObservation?: () => void;
  constructor(
    api:
      | GitHubRunner
      | Pick<GitHubApiClient, "request" | "paginateRest" | "graphql"> = new GitHubApiClient(
      createGitHubRunner({ cwd: projectRoot }),
    ),
  ) {
    this.api = typeof api === "function" ? new GitHubApiClient(api) : api;
  }

  request(method: string, endpoint: string, body: unknown = null): { body: unknown } {
    return this.api.request(method, endpoint, body);
  }

  openRenovatePulls() {
    return this.api
      .paginateRest(`repos/${repository}/pulls?state=open&per_page=100`, {
        select: (body) => body,
        identity: (pull) =>
          isRecord(pull) && Number.isSafeInteger(pull.number) ? String(pull.number) : null,
        label: "open pull requests",
      })
      .flatMap((pull) => {
        if (
          !isRecord(pull) ||
          !isRecord(pull.user) ||
          typeof pull.user.login !== "string" ||
          !["renovate[bot]", "app/renovate"].includes(pull.user.login)
        )
          return [];
        if (typeof pull.number !== "number") throw new Error("Pull request number is unavailable");
        return [{ ...pull, number: pull.number }];
      });
  }

  pull(number: number) {
    return pullMetadata(this.request("GET", `repos/${repository}/pulls/${number}`).body, number);
  }

  paginatedConnection(endpoint: string, key: string, identity: (value: unknown) => unknown) {
    return this.api.paginateRest(endpoint, {
      select: (body) => (isRecord(body) ? body[key] : undefined),
      identity,
      totalCount: (body) => {
        if (!isRecord(body) || typeof body.total_count !== "number")
          throw new Error(`${key} total is invalid`);
        return body.total_count;
      },
      label: key,
    });
  }

  checkRuns(sha: string) {
    return this.paginatedConnection(
      `repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100`,
      "check_runs",
      (run) => (isRecord(run) && Number.isSafeInteger(run.id) ? String(run.id) : null),
    ).map(checkMetadata);
  }

  commitStatuses(sha: string) {
    return this.paginatedConnection(
      `repos/${repository}/commits/${sha}/status?per_page=100`,
      "statuses",
      (status) => (isRecord(status) && Number.isSafeInteger(status.id) ? String(status.id) : null),
    ).map(statusMetadata);
  }

  pullFiles(number: number) {
    return this.api
      .paginateRest(`repos/${repository}/pulls/${number}/files?per_page=100`, {
        select: (body) => body,
        identity: (file) =>
          isRecord(file) && typeof file.filename === "string" ? file.filename : null,
        label: "pull request files",
      })
      .map((file) => {
        if (!isRecord(file) || typeof file.filename !== "string")
          throw new Error("Pull request file identity is invalid");
        const result: { filename: string; status?: string } = { ...file, filename: file.filename };
        if (file.status !== undefined) {
          if (typeof file.status !== "string")
            throw new Error("Pull request file status is invalid");
          result.status = file.status;
        }
        return result;
      });
  }

  pullCommits(number: number) {
    return this.api
      .paginateRest(`repos/${repository}/pulls/${number}/commits?per_page=100`, {
        select: (body) => body,
        identity: (commit) =>
          isRecord(commit) && typeof commit.sha === "string" && /^[0-9a-f]{40}$/u.test(commit.sha)
            ? commit.sha
            : null,
        label: "pull request commits",
      })
      .map((commit) => {
        if (!isRecord(commit) || typeof commit.sha !== "string")
          throw new Error("Pull request commit identity is invalid");
        fields(commit, {});
        if (commit.author !== undefined && commit.author !== null)
          fields(commit.author, { login: "string" });
        if (commit.commit !== undefined) fields(commit.commit, { message: "string" });
        const result: {
          sha: string;
          author?: { login?: string } | null;
          commit?: { message?: string };
        } = { ...commit, sha: commit.sha };
        if (isRecord(commit.author))
          result.author =
            typeof commit.author.login === "string"
              ? { ...commit.author, login: commit.author.login }
              : { ...commit.author };
        if (isRecord(commit.commit))
          result.commit =
            typeof commit.commit.message === "string"
              ? { ...commit.commit, message: commit.commit.message }
              : { ...commit.commit };
        return result;
      });
  }

  branch(name: string) {
    const body = this.request(
      "GET",
      `repos/${repository}/branches/${encodeURIComponent(name)}`,
    ).body;
    if (
      !isRecord(body) ||
      !isRecord(body.commit) ||
      typeof body.commit.sha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(body.commit.sha)
    )
      throw new Error(`branch ${name} response is incomplete`);
    return { ...body, commit: { ...body.commit, sha: body.commit.sha } };
  }

  workflowRun(id: number) {
    const body = this.request("GET", `repos/${repository}/actions/runs/${id}`).body;
    if (
      !isRecord(body) ||
      body.id !== id ||
      !isRecord(body.repository) ||
      typeof body.repository.full_name !== "string" ||
      body.repository.full_name.toLowerCase() !== repository
    )
      throw new Error(`workflow run ${id} identity is incomplete or differs`);
    assertWorkflow(body);
    return body;
  }

  sourceWorkflowRuns(sha: string) {
    const runs = this.paginatedConnection(
      `repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`,
      "workflow_runs",
      (run) => (isRecord(run) && Number.isSafeInteger(run.id) ? String(run.id) : null),
    ).map((run) => {
      assertWorkflow(run);
      return run;
    });
    if (runs.some((run) => run.head_sha !== sha || !Number.isSafeInteger(run.run_attempt)))
      throw new Error("source workflow run inventory differs from the exact queue head");
    return runs;
  }

  workflowJobs(run: number, _attempt: number) {
    return this.paginatedConnection(
      `repos/${repository}/actions/runs/${run}/jobs?filter=all&per_page=100`,
      "jobs",
      (job) => (isRecord(job) && Number.isSafeInteger(job.id) ? String(job.id) : null),
    ).map((job) => {
      assertJob(job);
      return job;
    });
  }

  requiredCheckState(number: number, head: string, requiredContexts: string[]) {
    const pull = this.pull(number);
    if (pull.head.sha !== head)
      throw new Error(`pull request #${number} head changed: ${pull.head.sha} != ${head}`);
    const contexts = requiredCheckContexts(
      this.checkRuns(head),
      this.commitStatuses(head),
      requiredContexts,
    );
    return { pull, head, contexts };
  }

  renovateSnapshot(number: number, head: string, requiredContexts: string[]) {
    const pull = this.pull(number);
    const checkRuns = this.checkRuns(head);
    const statuses = this.commitStatuses(head);
    const commits = this.pullCommits(number);
    const files = this.pullFiles(number);
    if (!Number.isSafeInteger(pull.commits) || commits.length !== pull.commits)
      throw new Error(
        `pull request commit inventory is incomplete: expected ${pull.commits ?? "unknown"}, observed ${commits.length}`,
      );
    if (!Number.isSafeInteger(pull.changed_files) || files.length !== pull.changed_files)
      throw new Error(
        `pull request file inventory is incomplete: expected ${pull.changed_files ?? "unknown"}, observed ${files.length}`,
      );
    return {
      pull,
      commits,
      files,
      checkRuns,
      statuses,
      contexts: requiredCheckContexts(checkRuns, statuses, requiredContexts),
      target: this.branch(pull.base.ref ?? ""),
    };
  }

  merge(
    number: number,
    head: string,
    requiredContexts: string[],
    closureIntent?: unknown,
    mergeMessage?: unknown,
  ) {
    const state = this.requiredCheckState(number, head, requiredContexts);
    if (state.pull.draft) throw new Error(`pull request #${number} is still a draft`);
    if (state.pull.mergeable !== true)
      throw new Error(
        state.pull.mergeable === false
          ? `pull request #${number} has merge conflicts`
          : `pull request #${number} mergeability is not determined`,
      );
    const incomplete = state.contexts.filter((context) => context.outcome !== "success");
    if (incomplete.length)
      throw new Error(
        `required checks are not successful: ${incomplete
          .map((context) => `${context.context}=${context.conclusion}`)
          .join(", ")}`,
      );
    if (
      !isRecord(mergeMessage) ||
      typeof mergeMessage.title !== "string" ||
      !mergeMessage.title.trim() ||
      /[\r\n]/u.test(mergeMessage.title) ||
      typeof mergeMessage.body !== "string"
    )
      throw new Error("An explicit squash message with title and body is required");
    const closing = readClosingRelationships(this.api, repository, number);
    if (
      closing.head !== head ||
      closing.body !== state.pull.body ||
      closing.title !== state.pull.title
    )
      throw new Error("PR body or closing relationships changed; refresh delivery review");
    const commits = this.pullCommits(number);
    if (
      commits.length !== state.pull.commits ||
      commits.at(-1)?.sha !== head ||
      commits.some((commit) => typeof commit.commit?.message !== "string")
    )
      throw new Error("Candidate commit message inventory is incomplete");
    checkClosureIntent(closureIntent, {
      repository,
      texts: [
        closing.body,
        ...commits.map((commit) => {
          if (typeof commit.commit?.message !== "string")
            throw new Error("Candidate commit message inventory is incomplete");
          return commit.commit.message;
        }),
        mergeMessage.title,
        mergeMessage.body,
      ],
      relationships: closing.relationships,
    });
    const refreshed = readClosingRelationships(this.api, repository, number);
    if (refreshed.fingerprint !== closing.fingerprint)
      throw new Error(
        "PR body or closing relationships changed before merge; refresh delivery review",
      );
    let result: unknown = null;
    let requestError: unknown = null;
    try {
      result = this.request("PUT", `repos/${repository}/pulls/${number}/merge`, {
        merge_method: "squash",
        sha: head,
        commit_title: mergeMessage.title,
        commit_message: mergeMessage.body,
      }).body;
    } catch (error) {
      requestError = error;
    }
    let readback;
    try {
      readback = this.pull(number);
    } catch (error) {
      throw deliveryOutcomeError(
        "unknown",
        `merge outcome is unknown after ${requestError ? errorMessage(requestError) : "an unexpected response"}; ` +
          `remote readback failed: ${errorMessage(error)}`,
        { pull_request: number, head },
        error,
      );
    }
    if (
      requestError &&
      readback.merged === true &&
      readback.state === "closed" &&
      readback.head.sha === head &&
      typeof readback.merge_commit_sha === "string"
    ) {
      result = {
        merged: true,
        sha: readback.merge_commit_sha,
        message: `merge command reported an error but remote readback confirmed completion: ${errorMessage(requestError)}`,
      };
    }
    if (
      !isRecord(result) ||
      result.merged !== true ||
      typeof result.sha !== "string" ||
      readback.merged !== true ||
      readback.state !== "closed" ||
      readback.head.sha !== head ||
      readback.merge_commit_sha !== result.sha
    ) {
      throw deliveryOutcomeError(
        "unknown",
        `merge response is ambiguous${requestError ? ` after ${errorMessage(requestError)}` : ""}; ` +
          `remote readback: merged=${readback.merged}, ` +
          `state=${readback.state}, head=${readback.head.sha}, merge=${readback.merge_commit_sha}`,
        {
          pull_request: number,
          head,
          remote: {
            merged: readback.merged,
            state: readback.state,
            head: readback.head.sha,
            merge_commit_sha: readback.merge_commit_sha,
          },
        },
        requestError,
      );
    }
    assertMergeResult(result);
    const closureReadback: {
      mutation: unknown;
      pull: DeliveryPull;
      actual_commit: unknown;
      closing: ReturnType<typeof readClosingRelationships> | null;
    } = {
      mutation: result,
      pull: readback,
      actual_commit: null,
      closing: null,
    };
    try {
      const actual = this.request(
        "GET",
        `repos/${repository}/git/commits/${readback.merge_commit_sha}`,
      ).body;
      closureReadback.actual_commit = actual;
      const expectedMessage = mergeMessage.body
        ? `${mergeMessage.title}\n\n${mergeMessage.body}`
        : mergeMessage.title;
      if (
        !isRecord(actual) ||
        actual.sha !== readback.merge_commit_sha ||
        (typeof actual.message === "string" ? actual.message.replace(/\n$/u, "") : undefined) !==
          expectedMessage.replace(/\n$/u, "")
      )
        throw new Error("Actual merged commit message differs from the checked squash message");
      const after = readClosingRelationships(this.api, repository, number);
      closureReadback.closing = after;
      if (after.fingerprint !== closing.fingerprint)
        throw new Error("PR body or closing relationships changed across merge");
    } catch (error) {
      throw deliveryOutcomeError(
        "unknown",
        `Merge occurred; closure readback needs reconciliation: ${errorMessage(error)}`,
        {
          pull_request: number,
          head,
          merge_commit_sha: readback.merge_commit_sha,
          closing,
          closure_readback: closureReadback,
        },
        error,
      );
    }
    return {
      result,
      readback,
      contexts: state.contexts,
      closing,
      closure_readback: closureReadback,
    };
  }
}

export function requiredCheckContexts(
  checkRuns: DeliveryCheckRun[],
  statuses: (Omit<DeliveryStatus, "id"> & { id?: number })[],
  requiredContexts: string[],
): RequiredContext[] {
  const candidates = new Map<string, CheckObservation[]>(
    requiredContexts.map((context) => [context, []]),
  );
  for (const run of checkRuns) {
    if (!candidates.has(run.name)) continue;
    const outcome =
      run.status === "completed"
        ? run.conclusion === "success"
          ? "success"
          : "failure"
        : "pending";
    candidates.get(run.name)?.push({
      source: "check-run",
      check_run_id: run.id,
      outcome,
      conclusion: run.conclusion ?? run.status,
      url: run.html_url ?? null,
    });
  }
  for (const status of statuses) {
    if (!candidates.has(status.context)) continue;
    const outcome =
      status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure";
    candidates.get(status.context)?.push({
      source: "commit-status",
      outcome,
      conclusion: status.state,
      description: status.description ?? null,
      url: status.target_url ?? null,
    });
  }
  const contexts = requiredContexts.map((context): RequiredContext => {
    const matches = candidates.get(context) ?? [];
    if (matches.length > 1)
      return { context, outcome: "failure", conclusion: "ambiguous", observations: matches };
    if (!matches.length)
      return { context, outcome: "pending", conclusion: "missing", observations: [] };
    const observation = matches[0];
    if (!observation) throw new Error("Required check observation disappeared");
    return { context, ...observation, observations: matches };
  });
  return contexts;
}

export function renovateCheckEnvelope<Evidence extends object>({
  number,
  head,
  result,
  snapshot,
}: {
  number: number;
  head: string;
  result: { verdict: string; reason: string; evidence: Evidence };
  snapshot: { commits: unknown[]; files: unknown[] };
}) {
  const summary = `Pull request #${number} exact head ${head}: ${fastLaneSummary(result)}.`;
  return githubOperationEnvelope({
    operation: "pr-delivery.renovate-check",
    status: "succeeded",
    summary,
    evidence: {
      pull_request: number,
      head,
      verdict: result.verdict,
      reason: result.reason,
      commits_observed: snapshot.commits.length,
      files_observed: snapshot.files.length,
      ...result.evidence,
    },
  });
}

// This read-only client bounds both each gh subprocess and all pages/reads in
// one observation. Merge and other GitHub consumers keep their existing runner.
export function createWatchClient({
  now = Date.now,
  spawn = spawnSync,
}: {
  now?: () => number;
  spawn?: NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"];
} = {}) {
  let collectionDeadline = 0;
  const api = new GitHubApiClient(
    createGitHubRunner({
      cwd: projectRoot,
      spawn: (command, args, options) => {
        const remaining = collectionDeadline - now();
        if (remaining <= 0) throw new Error("watch read collection exceeded its 60-second budget");
        return spawn(command, args, {
          ...options,
          timeout: Math.min(15_000, remaining),
          killSignal: "SIGKILL",
        });
      },
    }),
  );
  const client = new PullRequestDeliveryClient(api);
  return Object.assign(client, {
    beginObservation() {
      collectionDeadline = now() + 60_000;
    },
  });
}

export function createWatchProgress(write: (text: string) => void) {
  let previous: string | undefined;
  return (observation: WatchObservation) => {
    if (observation.kind !== "delivery-observation") return;
    const current = {
      head: observation.head,
      run: observation.run,
      attempt: observation.attempt,
      workflow_head: observation.workflow?.head_sha,
      workflow_attempt: observation.workflow?.run_attempt,
      status: observation.workflow?.status,
      conclusion: observation.workflow?.conclusion,
      checks: (observation.contexts ?? [])
        .map(({ context, outcome, conclusion }) => ({ context, outcome, conclusion }))
        .sort((a, b) => a.context.localeCompare(b.context)),
    };
    const fingerprint = JSON.stringify(current);
    if (fingerprint === previous) return;
    previous = fingerprint;
    write(
      renderBoundedSummary("CI progress (observation; final qualification remains separate)", [
        "Source " +
          current.head +
          "; observed " +
          current.workflow_head +
          "; run " +
          current.run +
          "/" +
          current.attempt +
          "; workflow " +
          current.status +
          "/" +
          (current.conclusion ?? "pending"),
        ...current.checks.map(
          (check) => check.context + ": " + check.outcome + "/" + check.conclusion,
        ),
      ]).text,
    );
  };
}

export async function watchRequiredChecks(
  client: WatchClient,
  {
    number,
    head,
    requiredContexts,
    run,
    attempt,
    deadline,
    sleep,
    now = Date.now,
    observe = () => {},
  }: WatchOptions,
) {
  if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error("watch requires a positive run and attempt");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(deadline ?? "") ||
    !Number.isFinite(Date.parse(deadline))
  )
    throw new Error("watch requires an absolute UTC --deadline; retain it when resuming");
  const deadlineMs = Date.parse(deadline);
  if (new Date(deadlineMs).toISOString().replace(".000Z", "Z") !== deadline.replace(".000Z", "Z"))
    throw new Error("watch --deadline must be a valid UTC calendar time");
  const pause =
    sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let observed: DeliveryWorkflow | null = null;
  let state: WatchState | null = null;
  const evidence = () => ({
    pull_request: number,
    head,
    run,
    attempt,
    deadline,
    workflow: observed && {
      id: observed.id,
      head_sha: observed.head_sha,
      run_attempt: observed.run_attempt,
      url: observed.html_url,
      status: observed.status,
      conclusion: observed.conclusion,
      created_at: observed.created_at,
      run_started_at: observed.run_started_at,
    },
    contexts: state?.contexts ?? [],
    next_action:
      "Inspect this run's jobs, logs and available artifacts; preserve the candidate and failure before choosing a repair. Do not redispatch automatically.",
  });
  for (;;) {
    try {
      client.beginObservation?.();
      observed = client.workflowRun(run);
      state = client.requiredCheckState(number, head, requiredContexts);
      try {
        observe({ format: 1, kind: "delivery-observation", ...evidence() });
      } catch {
        /* Diagnostics cannot change monitoring. */
      }
    } catch (error) {
      throw deliveryOutcomeError(
        "failed",
        `watch monitoring failed: ${sanitizeOperationError(error).message}`,
        evidence(),
        error,
      );
    }
    if (observed.head_sha !== head || observed.run_attempt !== attempt)
      throw deliveryOutcomeError(
        "failed",
        "watch run/source/attempt changed; reconcile the identified run before resuming",
        evidence(),
      );
    if (
      !["queued", "requested", "waiting", "pending", "in_progress", "completed"].includes(
        observed.status,
      )
    )
      throw deliveryOutcomeError(
        "failed",
        "watch workflow status is missing or unknown",
        evidence(),
      );
    if (
      !Number.isFinite(timestamp(observed.created_at)) ||
      deadlineMs <= timestamp(observed.created_at)
    )
      throw deliveryOutcomeError(
        "failed",
        "watch run creation time or deadline is invalid",
        evidence(),
      );
    const failures = state.contexts.filter((context) => context.outcome === "failure");
    if (failures.length)
      throw deliveryOutcomeError(
        "failed",
        `required checks failed: ${failures
          .map((context) => `${context.context}=${context.conclusion}`)
          .join(", ")}`,
        evidence(),
      );
    if (observed.status === "completed") {
      if (observed.conclusion !== "success")
        throw deliveryOutcomeError(
          "failed",
          `identified workflow run completed with ${observed.conclusion ?? "no conclusion"}`,
          evidence(),
        );
      if (state.contexts.every((context) => context.outcome === "success")) {
        let jobs;
        try {
          if (!client.workflowJobs) throw new Error("watch job readback is unavailable");
          jobs = client.workflowJobs(run, attempt);
          try {
            observe({ format: 1, kind: "delivery-jobs", ...evidence(), jobs });
          } catch {
            /* Diagnostics cannot change monitoring. */
          }
        } catch (error) {
          throw deliveryOutcomeError(
            "failed",
            `watch job readback failed: ${sanitizeOperationError(error).message}`,
            evidence(),
            error,
          );
        }
        const checks = new Map<number, DeliveryJob>();
        const latestJobs = new Map<string, DeliveryJob>();
        const executions = new Set();
        for (const job of jobs) {
          const match =
            /^https:\/\/api\.github\.com\/repos\/boburning\/portcove\/check-runs\/([1-9]\d*)$/u.exec(
              job.check_run_url ?? "",
            );
          const checkId = Number(match?.[1]);
          if (
            job.run_id !== run ||
            !Number.isSafeInteger(job.run_attempt) ||
            job.run_attempt < 1 ||
            job.run_attempt > attempt ||
            job.head_sha !== head ||
            !Number.isSafeInteger(checkId) ||
            checks.has(checkId) ||
            executions.has(`${job.name}:${job.run_attempt}`)
          )
            throw deliveryOutcomeError(
              "failed",
              "watch job inventory has invalid or duplicate run/attempt/source/check identity",
              evidence(),
            );
          checks.set(checkId, job);
          executions.add(`${job.name}:${job.run_attempt}`);
          if ((latestJobs.get(job.name)?.run_attempt ?? 0) < job.run_attempt)
            latestJobs.set(job.name, job);
        }
        for (const context of state.contexts) {
          const job =
            context.check_run_id === undefined ? undefined : checks.get(context.check_run_id);
          if (
            context.source !== "check-run" ||
            !job ||
            latestJobs.get(context.context) !== job ||
            job.name !== context.context ||
            job.status !== "completed" ||
            job.conclusion !== "success"
          )
            throw deliveryOutcomeError(
              "failed",
              `required check ${context.context} is not a successful job of the identified run attempt`,
              evidence(),
            );
        }
        try {
          observed = client.workflowRun(run);
        } catch (error) {
          throw deliveryOutcomeError(
            "failed",
            `watch final run readback failed: ${sanitizeOperationError(error).message}`,
            evidence(),
            error,
          );
        }
        if (
          observed.head_sha !== head ||
          observed.run_attempt !== attempt ||
          observed.status !== "completed" ||
          observed.conclusion !== "success"
        )
          throw deliveryOutcomeError(
            "failed",
            "watch run changed during job collection",
            evidence(),
          );
        return {
          ...state,
          watch: {
            ...evidence(),
            timings: baselineTimingWindow(
              observed,
              state.contexts.map((context) =>
                context.check_run_id === undefined ? undefined : checks.get(context.check_run_id),
              ),
              state.contexts,
            ),
            next_action:
              "Complete outstanding acceptance and independent review, then use the existing exact-head guarded merge.",
          },
        };
      }
      throw deliveryOutcomeError(
        "failed",
        "identified workflow succeeded but required exact-head gates remain missing or pending",
        evidence(),
      );
    }
    if (now() >= deadlineMs)
      throw deliveryOutcomeError(
        "failed",
        `watch deadline expired (run ${run}, attempt ${attempt}, ${observed.status}); timed out waiting for required checks: ${state.contexts
          .filter((context) => context.outcome !== "success")
          .map((context) => `${context.context}=${context.conclusion}`)
          .join(", ")}`,
        evidence(),
      );
    await pause(Math.min(180_000, Math.max(0, deadlineMs - now())));
  }
}

export function inspectRenovateQueue(
  client: DeliveryQueueClient,
  config: unknown,
  contexts: string[],
  inspectBase: (
    options: Parameters<typeof inspectCurrentBase>[0],
  ) => RenovateBaseEvidence = inspectCurrentBase,
) {
  const target = client.branch("main").commit.sha;
  const candidates = client.openRenovatePulls().map((listed) => {
    const head = isRecord(listed.head) ? listed.head.sha : undefined;
    if (typeof head !== "string" || !/^[0-9a-f]{40}$/u.test(head))
      throw new Error("queue candidate lacks exact head");
    const snapshot = client.renovateSnapshot(listed.number, head, contexts);
    if (snapshot.pull.head.sha !== head || snapshot.target.commit.sha !== target)
      throw new Error("queue head or target changed; refresh once before selection");
    const updates = parseRenovateUpdates(snapshot.pull.body);
    const baseEvidence = inspectBase({
      projectRoot,
      number: listed.number,
      expectedHead: head,
      currentTarget: target,
      interactionTerms: updates.flatMap(({ packageName }) => [
        packageName,
        packageName.replaceAll("-", "_"),
      ]),
    });
    if (baseEvidence.changedHead) throw new Error("queue candidate changed during base inspection");
    const result = classifyRenovateSnapshot({
      ...snapshot,
      config,
      expectedHead: head,
      baseEvidence,
    });
    const security = renovateSecurityIntent(snapshot.pull);
    const failures = snapshot.contexts.filter(({ outcome }) => outcome === "failure");
    const pending = snapshot.contexts.filter(({ outcome }) => outcome !== "success");
    const age = snapshot.statuses.filter(({ context }) => context === "renovate/stability-days");
    const agePending = !security && age.some(({ state }) => state === "pending");
    const actionable =
      !snapshot.pull.draft &&
      snapshot.pull.mergeable === true &&
      !pending.length &&
      !agePending &&
      !["reject", "waiting"].includes(result.verdict);
    return {
      number: listed.number,
      head,
      target,
      title: snapshot.pull.title,
      url: snapshot.pull.html_url,
      owners: (snapshot.pull.assignees ?? []).map(({ login }) => login),
      path: security
        ? "urgent-remediation-assessment"
        : result.verdict === "metadata-required"
          ? "routine-fast-lane-candidate"
          : "controlled-maintenance",
      verdict: result.verdict,
      reason: result.reason,
      actionable,
      release_age: age,
      checks: snapshot.contexts,
      runs: client
        .sourceWorkflowRuns(head)
        .map(({ id, run_attempt, name, status, conclusion, run_started_at, html_url }) => ({
          id,
          attempt: run_attempt,
          name,
          status,
          conclusion,
          started_at: run_started_at,
          url: html_url,
        })),
      next_action: snapshot.pull.draft
        ? "Resume the current owner's draft after verifying actual writer release and the retained checkpoint."
        : failures.length
          ? "Inspect the first failed exact-head job and retained evidence; repair causally before rerunning."
          : pending.length
            ? "Collect the identified source-head run with its original attempt and absolute deadline; do not start duplicate validation."
            : snapshot.pull.mergeable !== true
              ? "Resolve actual conflicts or unknown mergeability with the current owner."
              : agePending
                ? "Wait for the existing release-age status; missing timestamps need a specific reviewed resolution, never a global cooldown waiver."
                : ["reject", "waiting"].includes(result.verdict)
                  ? "Resolve the reported classifier condition before selection."
                  : result.verdict === "metadata-required"
                    ? `Verify actual writer activity and source ownership, then just renovate-check --pr ${listed.number} --head ${head}; final delivering-agent review and guarded merge follow only merge-ready.`
                    : "Verify actual writer activity and source ownership, inspect advisory/graph/features and select the existing local/hosted/behavior plan; independent review and guarded merge remain.",
    };
  });
  candidates.sort(
    (a, b) =>
      Number(b.path === "urgent-remediation-assessment") -
        Number(a.path === "urgent-remediation-assessment") ||
      Number(b.actionable) - Number(a.actionable) ||
      Number(b.path === "routine-fast-lane-candidate") -
        Number(a.path === "routine-fast-lane-candidate") ||
      a.number - b.number,
  );
  return {
    target,
    candidates,
    selected: candidates.find(({ actionable }) => actionable)?.number ?? null,
    selection_boundary:
      "Recommendation only. Candidate delivery requires actual writer and source-ownership checks; this command neither approves, rebases, retries nor merges. Refresh after each delivered candidate.",
  };
}

export interface DeliveryInspectionReferences {
  format_version: 1;
  pull_request: number;
  review?: {
    head: string;
    target: string;
    result: "clear" | "changes-required";
    reference: InspectionReference;
  };
  acceptance?: {
    head: string;
    result: "passed" | "failed" | "not-required";
    reference: InspectionReference;
  };
  watcher?: {
    head: string;
    run: number;
    attempt: number;
    deadline: string;
    reference: InspectionReference;
  };
}
interface InspectionReference {
  path: string;
  sha256: string;
}
interface InspectionEvidence {
  state: "unknown" | "referenced";
  reason?: string;
  result?: string;
  reference?: InspectionReference;
  run?: number;
  attempt?: number;
  deadline?: string;
  status?: string;
  conclusion?: string | null;
}
const inspectionSha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
function inspectionText(value: unknown, maximum = 1024): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum;
}
export function parseInspectionReferences(
  text: string,
  number: number,
): DeliveryInspectionReferences {
  if (Buffer.byteLength(text) > 8192)
    throw new Error("inspection declaration exceeds 8192 UTF-8 bytes");
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.format_version !== 1 || value.pull_request !== number)
    throw new Error("inspection declaration has an invalid version or pull request");
  const optional = ["review", "acceptance", "watcher"].filter((key) => value[key] !== undefined);
  exactKeys(value, ["format_version", "pull_request", ...optional], "inspection declaration");
  for (const kind of optional) {
    const entry = value[kind];
    if (!isRecord(entry) || !inspectionSha(entry.head) || !isRecord(entry.reference))
      throw new Error(`invalid ${kind} reference declaration`);
    exactKeys(entry.reference, ["path", "sha256"], `${kind} reference`);
    if (
      !inspectionText(entry.reference.path) ||
      !path.isAbsolute(entry.reference.path) ||
      typeof entry.reference.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.reference.sha256)
    )
      throw new Error(`invalid ${kind} reference identity`);
    if (kind === "review") {
      exactKeys(entry, ["head", "target", "result", "reference"], kind);
      if (
        !inspectionSha(entry.target) ||
        typeof entry.result !== "string" ||
        !["clear", "changes-required"].includes(entry.result)
      )
        throw new Error("invalid review declaration");
    } else if (kind === "acceptance") {
      exactKeys(entry, ["head", "result", "reference"], kind);
      if (
        typeof entry.result !== "string" ||
        !["passed", "failed", "not-required"].includes(entry.result)
      )
        throw new Error("invalid acceptance declaration");
    } else {
      exactKeys(entry, ["head", "run", "attempt", "deadline", "reference"], kind);
      if (
        !Number.isSafeInteger(entry.run) ||
        Number(entry.run) < 1 ||
        !Number.isSafeInteger(entry.attempt) ||
        Number(entry.attempt) < 1 ||
        typeof entry.deadline !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(entry.deadline) ||
        !Number.isFinite(Date.parse(entry.deadline))
      )
        throw new Error("invalid watcher declaration");
    }
  }
  // All fields admitted above are finite declarations, never approval authority.
  return value as unknown as DeliveryInspectionReferences;
}
async function inspectionReferenceMatches(reference: InspectionReference) {
  try {
    if (!(await lstat(reference.path)).isFile()) return false;
    const file = await open(reference.path, "r");
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 64 * 1024 * 1024) return false;
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        const observed: unknown = chunk;
        if (!Buffer.isBuffer(observed)) return false;
        bytes += observed.length;
        if (bytes > 64 * 1024 * 1024) return false;
        hash.update(observed);
      }
      const after = await file.stat();
      return (
        before.size === after.size &&
        bytes === after.size &&
        before.mtimeMs === after.mtimeMs &&
        hash.digest("hex") === reference.sha256
      );
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}
function assertInspectionPull(pull: DeliveryPull) {
  if (
    !inspectionSha(pull.head.sha) ||
    !inspectionSha(pull.base.sha) ||
    !inspectionText(pull.base.ref) ||
    typeof pull.draft !== "boolean" ||
    typeof pull.merged !== "boolean" ||
    !["open", "closed"].includes(pull.state ?? "") ||
    !(pull.mergeable === null || typeof pull.mergeable === "boolean") ||
    !(pull.merge_commit_sha === null || inspectionSha(pull.merge_commit_sha)) ||
    (pull.merged && (pull.state !== "closed" || !inspectionSha(pull.merge_commit_sha)))
  )
    throw new Error("inspection pull request projection is incomplete or contradictory");
}
export async function inspectDelivery(
  client: Pick<
    PullRequestDeliveryClient,
    "pull" | "branch" | "checkRuns" | "commitStatuses" | "workflowRun" | "beginObservation"
  >,
  {
    number,
    head,
    contexts,
    references,
    now = Date.now,
  }: {
    number: number;
    head: string;
    contexts: string[];
    references?: DeliveryInspectionReferences;
    now?: () => number;
  },
) {
  client.beginObservation?.();
  try {
    const pull = client.pull(number);
    assertInspectionPull(pull);
    const ref = pull.base.ref!;
    const target = client.branch(ref).commit.sha;
    const checks = requiredCheckContexts(
      client.checkRuns(pull.head.sha),
      client.commitStatuses(pull.head.sha),
      contexts,
    ).map(({ context, outcome }) => ({ context, outcome }));
    const observeReference = async (
      kind: "review" | "acceptance" | "watcher",
    ): Promise<InspectionEvidence> => {
      const entry = references?.[kind];
      if (!entry) return { state: "unknown", reason: "no-reference" };
      const identity = { reference: entry.reference };
      if (entry.head !== pull.head.sha || head !== pull.head.sha)
        return { ...identity, state: "unknown", reason: "source-changed" };
      if (!(await inspectionReferenceMatches(entry.reference)))
        return { ...identity, state: "unknown", reason: "reference-unavailable-or-corrupt" };
      if (kind === "review" && references?.review) {
        if (references.review.target !== target)
          return { ...identity, state: "unknown", reason: "target-changed" };
        return { ...identity, state: "referenced", result: references.review.result };
      }
      if (kind === "acceptance" && references?.acceptance)
        return { ...identity, state: "referenced", result: references.acceptance.result };
      const watcher = references.watcher;
      if (!watcher) throw new Error("watcher reference declaration is unavailable");
      const run = client.workflowRun(watcher.run);
      if (
        !["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(
          run.status,
        ) ||
        (run.status === "completed"
          ? ![
              "success",
              "failure",
              "neutral",
              "cancelled",
              "skipped",
              "timed_out",
              "action_required",
              "stale",
              "startup_failure",
            ].includes(run.conclusion ?? "")
          : run.conclusion !== null)
      )
        throw new Error("watcher response has invalid status or conclusion");
      const binding = { run: watcher.run, attempt: watcher.attempt, deadline: watcher.deadline };
      if (
        run.head_sha !== watcher.head ||
        run.run_attempt !== watcher.attempt ||
        now() >= Date.parse(watcher.deadline)
      )
        return { ...identity, ...binding, state: "unknown", reason: "watcher-stale" };
      return {
        ...identity,
        ...binding,
        state: "referenced",
        status: run.status,
        conclusion: run.conclusion ?? null,
      };
    };
    const review = await observeReference("review");
    const acceptance = await observeReference("acceptance");
    const watcher = await observeReference("watcher");
    const after = client.pull(number);
    assertInspectionPull(after);
    if (
      JSON.stringify([
        pull.head.sha,
        ref,
        pull.state,
        pull.draft,
        pull.merged,
        pull.merge_commit_sha,
        pull.mergeable,
      ]) !==
        JSON.stringify([
          after.head.sha,
          after.base.ref,
          after.state,
          after.draft,
          after.merged,
          after.merge_commit_sha,
          after.mergeable,
        ]) ||
      client.branch(ref).commit.sha !== target
    )
      throw new Error("source, target or pull request state changed during inspection");
    const next_action = pull.merged
      ? "Reconcile the owning issue and Project against confirmed merge readback."
      : pull.state === "closed"
        ? "Inspect the closed pull request with its owner before resuming."
        : head !== pull.head.sha
          ? "Resume from the observed source head; retained evidence for the requested head is stale."
          : pull.draft
            ? "Finish the current candidate and its applicable acceptance before marking ready."
            : pull.mergeable !== true
              ? "Resolve conflicts or unknown mergeability with the current owner."
              : checks.some((check) => check.outcome === "failure")
                ? "Inspect failed exact-head jobs and retained evidence before any repair or retry."
                : checks.some((check) => check.outcome !== "success")
                  ? watcher.state === "referenced"
                    ? watcher.status === "completed"
                      ? "Inspect the identified terminal workflow and missing or pending gates; its watcher cannot resume or renew the deadline."
                      : "Continue the existing source-bound watcher with its original run, attempt and deadline."
                    : "Inspect the retained source-head run and reconcile its watcher binding; do not resume a stale wait or renew its deadline."
                  : review.state !== "referenced" || review.result !== "clear"
                    ? "Complete or reconcile independent review against this source and target."
                    : acceptance.state !== "referenced" ||
                        !["passed", "not-required"].includes(acceptance.result ?? "")
                      ? "Complete the owning acceptance or reconcile its retained evidence."
                      : "Verify current authority and target interactions, then use the existing exact-head guarded merge.";
    return {
      format_version: 1,
      pull_request: number,
      observation: "complete",
      source: { expected: head, observed: pull.head.sha, matches: head === pull.head.sha },
      target: { ref, sha: target },
      pull: {
        state: pull.state,
        draft: pull.draft,
        mergeable: pull.mergeable,
        merged: pull.merged,
        merge_commit_sha: pull.merge_commit_sha,
      },
      checks,
      review,
      acceptance,
      watcher,
      next_action,
      boundary:
        "Current observations and referenced declarations only; no approval, acceptance authority or new merge gate.",
    };
  } catch (error) {
    throw deliveryOutcomeError(
      "unknown",
      `Delivery inspection is incomplete: ${sanitizeOperationError(error).message.slice(0, 512)}`,
      {
        pull_request: number,
        head,
        observation: "unknown",
        next_action:
          "Resolve incomplete or contradictory inspection reads; do not infer readiness.",
      },
      error,
    );
  }
}
export function renderDeliveryInspection(
  inspection: Awaited<ReturnType<typeof inspectDelivery>>,
  json: boolean,
) {
  const text = json
    ? JSON.stringify(inspection)
    : renderBoundedSummary(
        `PR #${inspection.pull_request}: ${inspection.pull.merged ? "merged" : inspection.pull.state}; source ${inspection.source.matches ? "matches" : "changed"}`,
        [
          `Source: expected ${inspection.source.expected}; observed ${inspection.source.observed}`,
          `Target: ${inspection.target.ref} ${inspection.target.sha}`,
          ...inspection.checks.map((check) => `${check.context}: ${check.outcome}`),
          ...(["review", "acceptance", "watcher"] as const).map(
            (kind) => `${kind}: ${JSON.stringify(inspection[kind])}`,
          ),
          inspection.next_action,
          inspection.boundary,
        ],
      ).text;
  if (Buffer.byteLength(text) + 1 > 16384)
    throw new Error("inspection output exceeds 16384 UTF-8 bytes including newline");
  return text;
}

const deliveryFlags: Readonly<Record<string, readonly string[]>> = {
  inspect: ["--pr", "--head", "--evidence-file", "--json", "--summary"],
  watch: ["--pr", "--head", "--run", "--attempt", "--deadline", "--json", "--progress"],
  "renovate-check": ["--pr", "--head", "--queue", "--json", "--summary"],
  merge: ["--pr", "--head", "--closure-intent-file", "--merge-message-file", "--json"],
};
const deliveryRequired: Readonly<Record<string, readonly string[]>> = {
  inspect: ["--pr", "--head"],
  watch: ["--pr", "--head", "--run", "--attempt", "--deadline"],
  "renovate-check": ["--pr", "--head"],
  merge: ["--pr", "--head", "--closure-intent-file", "--merge-message-file"],
};
const deliveryValues: Readonly<Record<string, string>> = {
  "--evidence-file": "absolute-reference-declaration.json",
  "--pr": "number-or-url",
  "--head": "40-character-sha",
  "--run": "run-id",
  "--attempt": "positive-attempt",
  "--deadline": "UTC-time",
  "--closure-intent-file": "JSON-file",
  "--merge-message-file": "JSON-file",
};
export function deliveryHelp(command: string | null | undefined = null) {
  const commands = command ? [command] : Object.keys(deliveryFlags);
  const lines = [];
  for (const name of commands) {
    if (!Object.hasOwn(deliveryFlags, name)) throw new Error("unknown command: " + name);
    const render = (flags: readonly string[], required: readonly string[]) =>
      "  node scripts/pr-delivery.mts " +
      name +
      " " +
      flags
        .map((flag) => {
          const value = deliveryValues[flag] ? flag + " <" + deliveryValues[flag] + ">" : flag;
          return required.includes(flag) ? value : "[" + value + "]";
        })
        .join(" ");
    if (name === "renovate-check")
      lines.push(render(["--queue", "--json", "--summary"], ["--queue"]));
    lines.push(
      render(
        (deliveryFlags[name] ?? []).filter((flag) => flag !== "--queue"),
        deliveryRequired[name] ?? [],
      ),
    );
  }
  return "usage:\n" + lines.join("\n");
}

export function parseArguments(argv: string[]) {
  const command = argv[0];
  const options: Record<string, string | true> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === undefined) throw new Error("invalid argument near end of command");
    if (
      command !== undefined &&
      Object.hasOwn(deliveryFlags, command) &&
      !(deliveryFlags[command] ?? []).includes(name) &&
      name !== "--help"
    )
      throw new Error(`unsupported ${command} option: ${name}; use ${command} --help`);
    if (Object.hasOwn(options, name)) throw new Error(`duplicate option: ${name}`);
    if (["--json", "--queue", "--help", "--summary", "--progress"].includes(name)) {
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--"))
      throw new Error(`invalid argument near ${name ?? "end of command"}`);
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

async function requiredContexts() {
  const [ruleset, coverage] = await Promise.all([
    readFile(path.join(projectRoot, ".github", "repository-ruleset.json"), "utf8").then(
      (text): unknown => JSON.parse(text),
    ),
    readFile(path.join(projectRoot, ".github", "qualification-coverage.json"), "utf8").then(
      (text): unknown => JSON.parse(text),
    ),
  ]);
  return requiredContextsFromConfigs(ruleset, coverage);
}

function optionText(options: Record<string, string | true>, key: string): string {
  const value = options[key];
  if (typeof value !== "string") throw new Error(`${key} requires a value`);
  return value;
}

async function main(argv: string[]) {
  const { command, options } = parseArguments(argv);
  if (["help", "--help"].includes(command ?? "") || options["--help"]) {
    console.log(deliveryHelp(options["--help"] ? command : null));
    return;
  }
  if (options["--summary"] && options["--json"])
    throw new Error("--summary and --json are mutually exclusive");
  if (command === "renovate-check" && options["--queue"]) {
    exactKeys(
      options,
      [
        "--queue",
        ...(options["--json"] ? ["--json"] : []),
        ...(options["--summary"] ? ["--summary"] : []),
      ],
      "queue options",
    );
    const config: unknown = JSON.parse(
      await readFile(path.join(projectRoot, "renovate.json"), "utf8"),
    );
    const queue = inspectRenovateQueue(
      new PullRequestDeliveryClient(),
      config,
      await requiredContexts(),
    );
    const summary = `Renovate queue: ${queue.candidates.length} complete candidates; recommended selection ${queue.selected ?? "none"}.`;
    if (options["--summary"]) {
      const output = githubOperationEnvelope({
        operation: "pr-delivery.renovate-queue",
        status: "succeeded",
        summary,
        evidence: queue,
      });
      console.log(
        retainReportSummary("renovate", output, path.join(projectRoot, "work/report-summary")).text,
      );
      return;
    }
    console.log(
      options["--json"]
        ? JSON.stringify(
            githubOperationEnvelope({
              operation: "pr-delivery.renovate-queue",
              status: "succeeded",
              summary,
              evidence: queue,
            }),
          )
        : [
            summary,
            ...queue.candidates.map(
              (c) => `#${c.number} ${c.head}: ${c.path}; ${c.reason}. ${c.next_action}`,
            ),
            queue.selection_boundary,
          ].join("\n"),
    );
    return;
  }
  if (command === undefined || !Object.hasOwn(deliveryRequired, command))
    throw new Error("unknown command: " + command);
  const required = deliveryRequired[command] ?? [];
  exactKeys(
    options,
    [...required, ...Object.keys(options).filter((flag) => !required.includes(flag))],
    command + " options",
  );
  const number = parsePullRequestReference(optionText(options, "--pr"));
  const head = optionText(options, "--head");
  if (!/^[0-9a-f]{40}$/u.test(head ?? "")) throw new Error("--head must be a 40-character SHA");
  const contexts = await requiredContexts();
  const client =
    command === "watch" || command === "inspect"
      ? createWatchClient()
      : new PullRequestDeliveryClient();
  if (command === "inspect") {
    if (!Number.isSafeInteger(number))
      throw new Error("inspection PR number must be a safe positive integer");
    const evidenceFile = options["--evidence-file"];
    if (typeof evidenceFile === "string" && !path.isAbsolute(evidenceFile))
      throw new Error("--evidence-file must be an absolute path");
    const references =
      typeof evidenceFile === "string"
        ? parseInspectionReferences(await readFile(evidenceFile, "utf8"), number)
        : undefined;
    const inspection = await inspectDelivery(client, {
      number,
      head,
      contexts,
      ...(references ? { references } : {}),
    });
    console.log(renderDeliveryInspection(inspection, Boolean(options["--json"])));
    return;
  }
  if (command === "renovate-check") {
    const config: unknown = JSON.parse(
      await readFile(path.join(projectRoot, "renovate.json"), "utf8"),
    );
    const snapshot = client.renovateSnapshot(number, head, contexts);
    let baseEvidence: RenovateBaseEvidence;
    if (snapshot.pull.head.sha !== head) {
      baseEvidence = {
        changedHead: snapshot.pull.head.sha,
        currentTarget: snapshot.target.commit.sha,
        currentMergeBase: null,
        targetPaths: [],
        targetDependencyPaths: [],
      };
    } else {
      const [update] = parseRenovateUpdates(snapshot.pull.body);
      const packageName = update?.packageName;
      baseEvidence = inspectCurrentBase({
        projectRoot,
        number,
        expectedHead: head,
        currentTarget: snapshot.target.commit.sha,
        interactionTerms: packageName ? [packageName, packageName.replaceAll("-", "_")] : [],
      });
    }
    let result: DeliveryVerdict = classifyRenovateSnapshot({
      ...snapshot,
      config,
      expectedHead: head,
      baseEvidence,
    });
    if (baseEvidence.changedHead)
      result = {
        verdict: "reject",
        reason: `pull request head changed to ${baseEvidence.changedHead}`,
        evidence: { expected_head: head, observed_head: baseEvidence.changedHead },
      };
    if (result.verdict === "metadata-required") {
      try {
        const metadata = await runMetadataValidation({
          projectRoot,
          base: result.evidence.original_base,
          head,
          manager: result.evidence.manager,
          packageName: result.evidence.package,
          currentVersion: result.evidence.current_version,
          newVersion: result.evidence.new_version,
          paths: result.evidence.paths,
        });
        result = {
          ...result,
          verdict: "merge-ready",
          reason:
            "remote gates and exact-head metadata validation passed; concise final review remains",
          evidence: { ...result.evidence, metadata },
        };
      } catch (error) {
        result = {
          ...result,
          verdict: "manual-review-required",
          reason: `metadata validation failed: ${sanitizeOperationError(error).message}`,
        };
      }
    }
    const output = renovateCheckEnvelope<DeliveryVerdict["evidence"]>({
      number,
      head,
      result,
      snapshot,
    });
    if (options["--summary"])
      console.log(
        retainReportSummary("renovate", output, path.join(projectRoot, "work/report-summary")).text,
      );
    else if (options["--json"]) console.log(JSON.stringify(output));
    else console.log(output.summary);
    if (result.verdict !== "merge-ready") process.exitCode = 2;
    return;
  }
  if (command === "watch") {
    const directory = path.join(projectRoot, "work/pr-delivery");
    const references: string[] = [];
    const progress = options["--progress"]
      ? createWatchProgress((text) => console.error(text))
      : () => {};
    const retain = (observation: unknown) => {
      try {
        mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${randomUUID()}.json`);
        writeFileSync(file, JSON.stringify(observation), { flag: "wx" });
        references.push(file);
      } catch {
        console.error(
          "pr-delivery: observation retention unavailable; monitoring remains authoritative",
        );
      }
    };
    const state = await watchRequiredChecks(client, {
      number,
      head,
      requiredContexts: contexts,
      run: Number(options["--run"]),
      attempt: Number(options["--attempt"]),
      deadline: optionText(options, "--deadline"),
      observe: (observation) => {
        retain(observation);
        progress(observation);
      },
    });
    retain({ format: 1, kind: "delivery-result", ...state.watch });
    const summary = `Pull request #${number} exact head ${head} passed required checks: ${state.contexts
      .map((context) => context.context)
      .join(", ")}.`;
    if (options["--json"]) {
      console.log(
        JSON.stringify(
          githubOperationEnvelope({
            operation: "pr-delivery.watch",
            status: "succeeded",
            summary,
            evidence: {
              pull_request: number,
              head,
              watch: state.watch,
              contexts: state.contexts.map(({ context, conclusion }) => ({
                context,
                conclusion,
              })),
            },
          }),
        ),
      );
    } else {
      console.log(
        summarizeReport(
          "watch",
          { summary, status: "succeeded", evidence: { head, watch: state.watch } },
          references.at(-1) ?? "retention unavailable",
        ).text,
      );
    }
    return;
  }
  if (command === "merge") {
    const merged = client.merge(
      number,
      head,
      contexts,
      JSON.parse(await readFile(optionText(options, "--closure-intent-file"), "utf8")),
      JSON.parse(await readFile(optionText(options, "--merge-message-file"), "utf8")),
    );
    const directory = path.join(projectRoot, "work/pr-delivery");
    const closureReceipt = retainMergeReceipt(directory, { number, head, ...merged });
    const summary =
      `Merged pull request #${number} at exact head ${head} as ${merged.result.sha}; ` +
      "remote readback confirmed.";
    if (options["--json"]) {
      console.log(
        JSON.stringify(
          githubOperationEnvelope({
            operation: "pr-delivery.merge",
            status: "succeeded",
            summary,
            evidence: {
              pull_request: number,
              head,
              merge_commit_sha: merged.result.sha,
              contexts: merged.contexts.map(({ context, conclusion }) => ({
                context,
                conclusion,
              })),
              remote_readback: true,
              closure_receipt: closureReceipt,
            },
          }),
        ),
      );
    } else {
      console.log(summary);
    }
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

async function settleDirectCli() {
  if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    try {
      await main(process.argv.slice(2));
    } catch (error) {
      const safeError = sanitizeOperationError(error);
      if (process.argv[2] === "inspect" && process.argv.slice(3).includes("--json")) {
        console.log(
          JSON.stringify({
            format_version: 1,
            observation: "unknown",
            error: {
              code: "inspection_failed",
              message: safeError.message.slice(0, 512),
            },
          }),
        );
      } else if (process.argv.slice(3).includes("--json")) {
        console.log(
          JSON.stringify(
            githubOperationEnvelope({
              operation: `pr-delivery.${process.argv[2] ?? "unknown"}`,
              status: error instanceof DeliveryOutcomeError ? error.operationStatus : "failed",
              summary: safeError.message,
              evidence: error instanceof DeliveryOutcomeError ? error.operationEvidence : {},
              error,
            }),
          ),
        );
      }
      let reference = null;
      try {
        const directory = path.join(projectRoot, "work/pr-delivery");
        mkdirSync(directory, { recursive: true });
        reference = path.join(directory, `${randomUUID()}.json`);
        writeFileSync(
          reference,
          JSON.stringify({
            error: safeError,
            evidence: error instanceof DeliveryOutcomeError ? error.operationEvidence : {},
          }),
          { flag: "wx" },
        );
      } catch {
        /* Preserve the original operation failure. */
      }
      console.error(
        renderBoundedSummary("pr-delivery failed", [safeError.message], { reference }).text,
      );
      process.exitCode = 1;
    }
  }
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
