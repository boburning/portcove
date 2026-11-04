import { fields, pullMetadata, checkMetadata, statusMetadata, assertWorkflow, assertJob, requiredContextsFromConfigs } from "./pr-delivery-snapshot.mts";
export { requiredContextsFromConfigs } from "./pr-delivery-snapshot.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { readFile, open, lstat } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { renderBoundedSummary, summarizeReport, retainReportSummary } from "./report-summary.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readClosingRelationships } from "./closure-intent.mts";
import {
  assertSuccessfulWorkflowJobs,
  requiredCheckContexts,
  validateMergeCandidate,
  validateMergeMessage,
  validateMergeReadiness,
  validateMergedCommit,
  prepareMergeSnapshot,
  verifyMergeSnapshotReadback,
  readDeliverySnapshot,
} from "./pr-delivery-snapshot.mts";
export {
  assertSuccessfulWorkflowJobs,
  requiredCheckContexts,
  validateMergeCandidate,
  validateMergeMessage,
  validateMergedCommit,
} from "./pr-delivery-snapshot.mts";
import type { OperationStatus } from "./github-operation.mts";
import { createGitHubClient, iterateGitHubPages } from "./github-client.mts";
import type { GitHubClientOptions } from "./github-client.mts";
import type { Octokit } from "@octokit/core";
import { localDeveloperCredential } from "./github-cli.mts";
import type { RenovatePull, RenovateBaseEvidence } from "./renovate-fast-lane.mts";
import {
  githubOperationEnvelope,
  sanitizeOperationError,
} from "./github-operation.mts";
import {
  classifyRenovateSnapshot,
  diagnoseRenovateReleaseAge,
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
  head_sha?: string;
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
  branch(name: string): Promise<{ commit: { sha: string } }>;
  openRenovatePulls(): Promise<{ number: number; head?: unknown }[]>;
  renovateSnapshot(number: number, head: string, contexts: string[]): Promise<DeliveryQueueSnapshot>;
  sourceWorkflowRuns(
    head: string,
  ): Promise<(Pick<DeliveryWorkflow, "id" | "run_attempt" | "status"> &
    Partial<Pick<DeliveryWorkflow, "name" | "conclusion" | "run_started_at" | "html_url">>)[]>;
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
  jobs?: DeliveryJob[];
}
export interface WatchClient {
  beginObservation?: () => void;
  workflowRun(run: number): Promise<DeliveryWorkflow>;
  requiredCheckState(
    number: number,
    head: string,
    contexts: string[],
    binding?: { run: number; attempt: number },
  ): Promise<WatchState>;
  workflowJobs?(run: number, attempt: number): Promise<DeliveryJob[]>;
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

export function parsePullRequestReference(value: string | number) {
  const numeric = /^(\d+)$/u.exec(String(value));
  if (numeric && Number(numeric[1]) > 0) return Number(numeric[1]);
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/u.exec(String(value));
  if (!url || (url[1] ?? "").toLowerCase() !== repository.toLowerCase() || Number(url[2]) < 1)
    throw new Error(`invalid ${repository} pull request reference: ${value}`);
  return Number(url[2]);
}

export class PullRequestDeliveryClient {
  private observationDeadline = Infinity;
  beginObservation() { this.observationDeadline = (this.scope.now ?? performance.now.bind(performance))() + 60000; }
  private sdk: Octokit;
  private scope: GitHubClientOptions;
  constructor(sdk: Octokit, scope: GitHubClientOptions) { this.sdk = sdk; this.scope = scope; }

  static async connect(options: Partial<GitHubClientOptions> = {}) {
    const deadline = options.deadline ?? performance.now() + 30 * 60000;
    let bytes = 0;
    const scope: GitHubClientOptions = {
      credential: options.credential ?? localDeveloperCredential({ deadline }), deadline, requestTimeoutMs: 15000,
      headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      reserve: () => ({ consumeBytes(received) {
        bytes += received;
        if (bytes > 64 * 1024 * 1024) throw new Error("Delivery metadata allowance exhausted");
      }, settle() {} }),
      ...options,
      allowRequest: (method, url) =>
        (method === "POST" && url.pathname === "/graphql" ||
          (method === "GET" && url.pathname.startsWith(`/repos/${repository}/`) || method === "PUT" && new RegExp(`^/repos/${repository}/pulls/[1-9][0-9]*/merge$`, "u").test(url.pathname))) &&
        options.allowRequest?.(method, url) !== false,
    };
    const sdk = await createGitHubClient(scope);
    return new PullRequestDeliveryClient(sdk, scope);
  }

  private async request(method: "GET" | "PUT", endpoint: string, data?: unknown) {
    return await this.sdk.request({ method, url: `https://api.github.com/${endpoint}`,
      ...(data === undefined ? {} : { data }),
      request: { portcove: { replay: method === "GET" ? "safe-read" : "once", attempts: 0,
        deadline: Math.min(this.scope.deadline, this.observationDeadline) } },
    });
  }

  /** Delivery inventories retain stable totals and unique provider identities. */
  private async collect(endpoint: string, identityKey: string, collectionKey?: string) {
    const records: unknown[] = [], identities = new Set<string | number>();
    let expected: number | undefined;
    for await (const response of iterateGitHubPages(this.sdk, {
      url: `https://api.github.com/${endpoint}`, deadline: Math.min(this.scope.deadline, this.observationDeadline),
    })) {
      const body: unknown = response.data;
      const values: unknown = collectionKey && isRecord(body) ? body[collectionKey] : body;
      if (!Array.isArray(values)) throw new Error("Delivery collection response is incomplete");
      if (collectionKey) {
        const count = isRecord(body) ? body.total_count : undefined;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`${collectionKey} total is invalid`);
        expected ??= count;
        if (count !== expected) throw new Error(`${collectionKey} total changed during pagination`);
      }
      for (const value of values as readonly unknown[]) {
        const id = isRecord(value) ? value[identityKey] : null;
        if ((typeof id !== "string" && typeof id !== "number") || !id || (typeof id === "number" && (!Number.isSafeInteger(id) || id < 1)) || identities.has(id))
          throw new Error("Delivery collection contains a missing or duplicate ID");
        identities.add(id); records.push(value);
      }
      if (expected !== undefined && records.length > expected) throw new Error("Delivery count exceeds reported total");
    }
    if (expected !== undefined && records.length !== expected) throw new Error("Delivery count does not match reported total");
    return records;
  }

  async openRenovatePulls() {
    return (await this.collect(`repos/${repository}/pulls?state=open&per_page=100`, "number"))
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

  async pull(number: number) {
    return pullMetadata((await this.request("GET", `repos/${repository}/pulls/${number}`)).data, number);
  }

  private async paginatedConnection(endpoint: string, key: string) {
    return await this.collect(endpoint, "id", key);
  }

  async checkRuns(sha: string) {
    return (await this.paginatedConnection(
      `repos/${repository}/commits/${sha}/check-runs?filter=all&per_page=100`,
      "check_runs",
    )).map(checkMetadata);
  }

  async commitStatuses(sha: string) {
    return (await this.paginatedConnection(
      `repos/${repository}/commits/${sha}/status?per_page=100`,
      "statuses",
    )).map(statusMetadata);
  }

  async pullFiles(number: number) {
    return (await this.collect(`repos/${repository}/pulls/${number}/files?per_page=100`, "filename"))
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

  async pullCommits(number: number) {
    return (await this.collect(`repos/${repository}/pulls/${number}/commits?per_page=100`, "sha"))
      .map((commit) => {
        if (!isRecord(commit) || typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/u.test(commit.sha))
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

  async branch(name: string) {
    const body: unknown = (await this.request(
      "GET",
      `repos/${repository}/branches/${encodeURIComponent(name)}`,
    )).data;
    if (
      !isRecord(body) ||
      !isRecord(body.commit) ||
      typeof body.commit.sha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(body.commit.sha)
    )
      throw new Error(`branch ${name} response is incomplete`);
    return { ...body, commit: { ...body.commit, sha: body.commit.sha } };
  }

  async workflowRun(id: number) {
    const body: unknown = (await this.request("GET", `repos/${repository}/actions/runs/${id}`)).data;
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

  async sourceWorkflowRuns(sha: string) {
    const runs = (await this.paginatedConnection(
      `repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`,
      "workflow_runs",
    )).map((run) => {
      assertWorkflow(run);
      return run;
    });
    if (runs.some((run) => run.head_sha !== sha || !Number.isSafeInteger(run.run_attempt)))
      throw new Error("source workflow run inventory differs from the exact queue head");
    return runs;
  }

  async workflowJobs(run: number, _attempt: number) {
    return (await this.paginatedConnection(
      `repos/${repository}/actions/runs/${run}/jobs?filter=all&per_page=100`,
      "jobs",
    )).map((job) => {
      assertJob(job);
      return job;
    });
  }

  async requiredCheckState(
    number: number,
    head: string,
    requiredContexts: string[],
    binding?: { run: number; attempt: number },
  ) {
    const pull = (await this.pull(number));
    if (pull.head.sha !== head)
      throw new Error(`pull request #${number} head changed: ${pull.head.sha} != ${head}`);
    const jobs = binding ? (await this.workflowJobs(binding.run, binding.attempt)) : undefined;
    const contexts = requiredCheckContexts(
      (await this.checkRuns(head)),
      (await this.commitStatuses(head)),
      requiredContexts,
      binding && jobs ? { head, ...binding, jobs } : undefined,
    );
    return { pull, head, contexts, ...(jobs ? { jobs } : {}) };
  }

  async renovateSnapshot(number: number, head: string, requiredContexts: string[]) {
    const pull = (await this.pull(number));
    const checkRuns = (await this.checkRuns(head));
    const statuses = (await this.commitStatuses(head));
    const commits = (await this.pullCommits(number));
    const files = (await this.pullFiles(number));
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
      target: (await this.branch(pull.base.ref ?? "")),
    };
  }

  async merge(
    number: number,
    head: string,
    requiredContexts: string[],
    closureIntent?: unknown,
    mergeMessage?: unknown,
  ) {
    const state = (await this.requiredCheckState(number, head, requiredContexts));
    validateMergeReadiness(number, head, state.pull, state.contexts);
    const message = validateMergeMessage(mergeMessage);
    const closing = await readClosingRelationships(this.sdk, repository, number);
    const commits = (await this.pullCommits(number));
    validateMergeCandidate({
      number,
      head,
      pull: state.pull,
      contexts: state.contexts,
      closing,
      commits,
      closureIntent,
      mergeMessage: message,
    });
    const refreshed = await readClosingRelationships(this.sdk, repository, number);
    if (refreshed.fingerprint !== closing.fingerprint)
      throw new Error(
        "PR body or closing relationships changed before merge; refresh delivery review",
      );
    let result: unknown = null;
    let requestError: unknown = null;
    try {
      result = (await this.request("PUT", `repos/${repository}/pulls/${number}/merge`, {
        merge_method: "squash",
        sha: head,
        commit_title: message.title,
        commit_message: message.body,
      })).data;
    } catch (error) {
      requestError = error;
    }
    let readback;
    try {
      readback = (await this.pull(number));
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
      closing: Awaited<ReturnType<typeof readClosingRelationships>> | null;
    } = {
      mutation: result,
      pull: readback,
      actual_commit: null,
      closing: null,
    };
    try {
      const actual: unknown = (await this.request(
        "GET",
        `repos/${repository}/git/commits/${readback.merge_commit_sha}`,
      )).data;
      closureReadback.actual_commit = actual;
      validateMergedCommit(actual, readback.merge_commit_sha, message);
      const after = await readClosingRelationships(this.sdk, repository, number);
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

/** Each observation has its existing 60-second collection budget; the command
 * deadline remains the original boundary across observations. */
export async function createWatchClient(options: Partial<GitHubClientOptions> = {}) {
  const client = await PullRequestDeliveryClient.connect({ ...options,
    allowRequest: (method, url) => method === "GET" && options.allowRequest?.(method, url) !== false,
  });
  return client;
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
      observed = (await client.workflowRun(run));
      state = (await client.requiredCheckState(number, head, requiredContexts, { run, attempt }));
      try {
        observe({
          format: 1,
          kind: "delivery-observation",
          ...evidence(),
          ...(state.jobs ? { jobs: state.jobs } : {}),
        });
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
          jobs = (await client.workflowJobs(run, attempt));
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
        let checks;
        try {
          checks = assertSuccessfulWorkflowJobs(jobs, state.contexts, { head, run, attempt });
        } catch (error) {
          throw deliveryOutcomeError("failed", errorMessage(error), evidence(), error);
        }
        try {
          observed = (await client.workflowRun(run));
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

export async function inspectRenovateQueue(
  client: DeliveryQueueClient,
  config: unknown,
  contexts: string[],
  inspectBase: (
    options: Parameters<typeof inspectCurrentBase>[0],
  ) => RenovateBaseEvidence = inspectCurrentBase,
) {
  const target = (await client.branch("main")).commit.sha;
  const candidates = [];
  for (const listed of await client.openRenovatePulls()) {
    const head = isRecord(listed.head) ? listed.head.sha : undefined;
    if (typeof head !== "string" || !/^[0-9a-f]{40}$/u.test(head))
      throw new Error("queue candidate lacks exact head");
    const snapshot = (await client.renovateSnapshot(listed.number, head, contexts));
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
    const ageDiagnosis = diagnoseRenovateReleaseAge(snapshot.statuses, snapshot.pull.body);
    const actionable =
      !snapshot.pull.draft &&
      snapshot.pull.mergeable === true &&
      !pending.length &&
      !agePending &&
      !["reject", "waiting"].includes(result.verdict);
    candidates.push({
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
      release_age_diagnosis: ageDiagnosis,
      checks: snapshot.contexts,
      runs: (await client
        .sourceWorkflowRuns(head))
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
                ? ageDiagnosis.next_action
                : ["reject", "waiting"].includes(result.verdict)
                  ? "Resolve the reported classifier condition before selection."
                  : result.verdict === "metadata-required"
                    ? `Verify actual writer activity and source ownership, then just renovate-check --pr ${listed.number} --head ${head}; final delivering-agent review and guarded merge follow only merge-ready.`
                    : "Verify actual writer activity and source ownership, inspect advisory/graph/features and select the existing local/hosted/behavior plan; independent review and guarded merge remain.",
    });
  }
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
    const pull = (await client.pull(number));
    assertInspectionPull(pull);
    const ref = pull.base.ref!;
    const target = (await client.branch(ref)).commit.sha;
    const checks = requiredCheckContexts(
      (await client.checkRuns(pull.head.sha)),
      (await client.commitStatuses(pull.head.sha)),
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
      const run = (await client.workflowRun(watcher.run));
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
    const after = (await client.pull(number));
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
      (await client.branch(ref)).commit.sha !== target
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
  "prepare-merge": [
    "--pr",
    "--head",
    "--target",
    "--tree",
    "--run",
    "--attempt",
    "--snapshot-file",
    "--closure-intent-file",
    "--merge-message-file",
    "--verify-local-composition",
    "--json",
  ],
  "verify-merge": [
    "--pr",
    "--head",
    "--target",
    "--tree",
    "--snapshot-file",
    "--closure-intent-file",
    "--merge-message-file",
    "--json",
  ],
};
const deliveryRequired: Readonly<Record<string, readonly string[]>> = {
  inspect: ["--pr", "--head"],
  watch: ["--pr", "--head", "--run", "--attempt", "--deadline"],
  "renovate-check": ["--pr", "--head"],
  merge: ["--pr", "--head", "--closure-intent-file", "--merge-message-file"],
  "prepare-merge": [
    "--pr",
    "--head",
    "--target",
    "--tree",
    "--run",
    "--attempt",
    "--snapshot-file",
    "--closure-intent-file",
    "--merge-message-file",
  ],
  "verify-merge": [
    "--pr",
    "--head",
    "--target",
    "--tree",
    "--snapshot-file",
    "--closure-intent-file",
    "--merge-message-file",
  ],
};
const deliveryValues: Readonly<Record<string, string>> = {
  "--evidence-file": "absolute-reference-declaration.json",
  "--pr": "number-or-url",
  "--head": "40-character-sha",
  "--target": "reviewed-target-sha",
  "--tree": "reviewed-composed-tree-sha",
  "--snapshot-file": "absolute-observation-file.json",
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
  if (!command || ["prepare-merge", "verify-merge"].includes(command))
    lines.push(
      "  Snapshot commands perform no network, remote mutation, retry, review or acceptance. Prepare requires fresh bracketed collection within 60 seconds and complete source-bound check/job/closure inventories. --verify-local-composition independently checks stored Git objects and current composition when the provider preview is historical. Verify requires actual squash parent/tree/message and closure readback. See docs/CONTRIBUTION-CONVENTIONS.md for the snapshot contract.",
    );
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
    if (
      [
        "--json",
        "--queue",
        "--help",
        "--summary",
        "--progress",
        "--verify-local-composition",
      ].includes(name)
    ) {
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
    const queue = await inspectRenovateQueue(
      await PullRequestDeliveryClient.connect(),
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
  if (command === "prepare-merge" || command === "verify-merge") {
    const expected = {
      number,
      head,
      target: optionText(options, "--target"),
      tree: optionText(options, "--tree"),
      contexts,
      closureIntent: await readDeliverySnapshot(optionText(options, "--closure-intent-file")),
      mergeMessage: await readDeliverySnapshot(optionText(options, "--merge-message-file")),
      ...(command === "prepare-merge"
        ? {
            run: Number(optionText(options, "--run")),
            attempt: Number(optionText(options, "--attempt")),
          }
        : {}),
    };
    const snapshot = await readDeliverySnapshot(optionText(options, "--snapshot-file"));
    let result;
    try {
      result =
        command === "prepare-merge"
          ? prepareMergeSnapshot(
              snapshot,
              expected,
              options["--verify-local-composition"] ? process.cwd() : undefined,
            )
          : verifyMergeSnapshotReadback(snapshot, expected);
    } catch (error) {
      if (command !== "verify-merge") throw error;
      throw deliveryOutcomeError(
        "unknown",
        `Merge readback needs reconciliation; do not retry automatically: ${errorMessage(error)}`,
        { pull_request: number, head, snapshot_file: optionText(options, "--snapshot-file") },
        error,
      );
    }
    const output = options["--json"]
      ? JSON.stringify(result)
      : `${command}: supplied observations match PR #${number}, source ${head}, target ${expected.target}, tree ${expected.tree}.\n${result.boundary}\n${JSON.stringify(result)}`;
    if (Buffer.byteLength(output + "\n") > 16 * 1024)
      throw new Error("Snapshot output exceeds 16384 UTF-8 bytes including newline");
    console.log(output);
    return;
  }
  const client =
    command === "watch" || command === "inspect"
      ? await createWatchClient({ deadline: performance.now() + Date.parse(optionText(options, "--deadline")) - Date.now() })
      : await PullRequestDeliveryClient.connect();
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
    const snapshot = (await client.renovateSnapshot(number, head, contexts));
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
    const merged = (await client.merge(
      number,
      head,
      contexts,
      JSON.parse(await readFile(optionText(options, "--closure-intent-file"), "utf8")),
      JSON.parse(await readFile(optionText(options, "--merge-message-file"), "utf8")),
    ));
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
    } catch (caught) {
      const error =
        process.argv[2] === "verify-merge" &&
        !(caught instanceof DeliveryOutcomeError && caught.operationStatus === "unknown")
          ? deliveryOutcomeError(
              "unknown",
              `Merge readback needs reconciliation; do not retry automatically: ${errorMessage(caught)}`,
              {
                next_action:
                  "Reconcile the live PR before choosing any next action; never retry a confirmed merge.",
              },
              caught,
            )
          : caught;
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
