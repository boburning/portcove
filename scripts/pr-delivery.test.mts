import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubApiClient } from "./github-api.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import type {
  DeliveryPull,
  DeliveryWorkflow,
  DeliveryQueueSnapshot,
  DeliveryQueueClient,
  WatchContext,
  WatchState,
  DeliveryJob,
} from "./pr-delivery.mts";
import { DeliveryOutcomeError } from "./pr-delivery.mts";
import { spawnSync as spawnHelp } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import {
  PullRequestDeliveryClient,
  createWatchClient,
  createWatchProgress,
  deliveryHelp,
  parseArguments,
  parsePullRequestReference,
  renovateCheckEnvelope,
  requiredCheckContexts,
  requiredContextsFromConfigs,
  watchRequiredChecks,
  inspectRenovateQueue,
  baselineTimingWindow,
  retainMergeReceipt,
  inspectDelivery,
  parseInspectionReferences,
  renderDeliveryInspection,
} from "./pr-delivery.mts";

function requiredFixture<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null, "Required fixture value is missing");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function deliveryError(error: unknown): DeliveryOutcomeError {
  assert.ok(error instanceof DeliveryOutcomeError);
  return error;
}
function evidence(error: unknown) {
  return record(deliveryError(error).operationEvidence);
}
type QueueOverrides = Omit<Partial<DeliveryQueueSnapshot>, "pull"> & {
  pull?: Partial<DeliveryPull>;
};

const required = ["catalog", "dependency-review", "frontend", "rust", "rust-quality"];
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);

void test("postmerge receipt retention failure preserves confirmed completion and forbids retry", () => {
  const packet = {
    number: 7,
    head,
    result: { merged: true, sha: merge },
    readback: { merged: true, merge_commit_sha: merge },
  };
  for (const phase of ["mkdirSync", "writeFileSync"] as const) {
    const io = { mkdirSync() {}, writeFileSync() {} };
    io[phase] = () => {
      throw new Error("ENOSPC");
    };
    assert.throws(
      () => retainMergeReceipt("unused", packet, io),
      (error) =>
        /Merge completed.*receipt retention failed; do not retry/.test(errorMessage(error)) &&
        evidence(error).merge_completed === true &&
        record(evidence(error).result).sha === merge &&
        record(evidence(error).readback).merge_commit_sha === merge,
    );
  }
});
const emptyIntent = { format_version: 1, allowed_targets: [] };
const squashMessage = { title: "fix: safe delivery", body: "Related to #244." };
function closingPage(overrides = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          number: 7,
          headRefOid: head,
          title: "fix: safe delivery",
          body: "Related to #244.",
          closingIssuesReferences: {
            totalCount: 0,
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          ...overrides,
        },
      },
    },
  };
}

void test("baseline timings separate initial queue and all required gate completion", () => {
  const workflow = { created_at: "2026-10-09T00:00:00Z", run_started_at: "2026-10-09T00:00:10Z" };
  const jobs = required.map((name, index) => ({
    name,
    completed_at: `2026-10-09T00:01:${10 + index}Z`,
  }));
  const timing = baselineTimingWindow(
    workflow,
    jobs,
    required.map((context) => ({ context })),
  );
  assert.equal(timing.queue_ms, 10000);
  assert.equal(timing.baseline_elapsed_ms, 64000);
  assert.equal(
    baselineTimingWindow(
      workflow,
      jobs.slice(1),
      required.map((context) => ({ context })),
    ).baseline_elapsed_ms,
    null,
  );
  assert.equal(baselineTimingWindow({}, jobs, []).measurement, "unavailable");
});

function included(body: unknown, headers: Record<string, string> = {}) {
  return (
    "HTTP/2.0 200 OK\r\n" +
    Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("") +
    `\r\n${JSON.stringify(body)}`
  );
}

function pull(overrides: Partial<DeliveryPull> = {}): DeliveryPull {
  return {
    number: 7,
    title: "fix: safe delivery",
    body: "Related to #244.",
    commits: 1,
    changed_files: 2,
    head: { sha: head },
    base: { sha: base },
    draft: false,
    mergeable: true,
    merged: false,
    state: "open",
    merge_commit_sha: null,
    ...overrides,
  };
}

function successfulRuns() {
  return required.map((name, index) => ({
    id: index + 1,
    name,
    status: "completed",
    conclusion: "success",
    html_url: `https://github.test/check/${index + 1}`,
  }));
}

void test("queue inventory follows all open-PR pages and rejects duplicate identities", () => {
  const client = new PullRequestDeliveryClient((args) => {
    if (requiredFixture(args[2]).includes("page=2"))
      return included([{ number: 9, user: { login: "app/renovate" } }]);
    return included(
      [
        { number: 7, user: { login: "renovate[bot]" } },
        { number: 8, user: { login: "contributor" } },
      ],
      { link: '<https://api.github.test/pulls?page=2>; rel="next"' },
    );
  });
  assert.deepEqual(
    client.openRenovatePulls().map(({ number }) => number),
    [7, 9],
  );
  const duplicate = new PullRequestDeliveryClient((args) =>
    included(
      [{ number: 7, user: { login: "renovate[bot]" } }],
      requiredFixture(args[2]).includes("page=2")
        ? {}
        : { link: '<https://api.github.test/pulls?page=2>; rel="next"' },
    ),
  );
  assert.throws(() => duplicate.openRenovatePulls(), /duplicate/);
});

function queueClient(overrides: QueueOverrides = {}): DeliveryQueueClient {
  const age = [{ context: "renovate/stability-days", state: "success" }];
  const snapshot: DeliveryQueueSnapshot = {
    pull: pull({
      number: 7,
      user: { login: "renovate[bot]" },
      title: "update crc32fast",
      labels: [],
      base: { sha: base, ref: "main" },
      head: { sha: head, ref: "renovate/crc32fast" },
      assignees: [],
      body: "| Package | Update | Change |\n|---|---|---|\n| crc32fast | patch | `1.5.1` → `1.5.2` |\n",
    }),
    commits: [{ sha: head, author: { login: "renovate[bot]" } }],
    files: [
      { filename: "Cargo.toml", status: "modified" },
      { filename: "Cargo.lock", status: "modified" },
    ],
    statuses: age,
    contexts: requiredCheckContexts(successfulRuns(), [], required),
    target: { commit: { sha: base } },
    checkRuns: successfulRuns(),
  };
  return {
    branch: () => ({ commit: { sha: base } }),
    openRenovatePulls: () => [snapshot.pull],
    sourceWorkflowRuns: () => [
      {
        id: 42,
        run_attempt: 1,
        name: "CI",
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-10-01T00:00:00Z",
      },
    ],
    renovateSnapshot: () => ({
      ...snapshot,
      ...overrides,
      pull: { ...snapshot.pull, ...overrides.pull },
    }),
  };
}
const queueConfig = {
  automerge: false,
  internalChecksFilter: "strict",
  minimumReleaseAge: "1 day",
  minimumReleaseAgeBehaviour: "timestamp-required",
  packageRules: [],
};
const queueBase = () => ({
  currentTarget: base,
  currentMergeBase: base,
  targetPaths: [],
  targetDependencyPaths: [],
});

void test("queue recommends only an actionable exact-head candidate and never supplies merge authority", () => {
  const queue = inspectRenovateQueue(queueClient(), queueConfig, required, queueBase);
  assert.equal(queue.selected, 7);
  assert.equal(requiredFixture(queue.candidates[0]).path, "routine-fast-lane-candidate");
  assert.match(requiredFixture(queue.candidates[0]).next_action, /renovate-check --pr 7 --head/);
  assert.equal(requiredFixture(requiredFixture(queue.candidates[0]).runs[0]).id, 42);
  assert.equal(requiredFixture(requiredFixture(queue.candidates[0]).runs[0]).attempt, 1);
  assert.match(
    queue.selection_boundary,
    /Candidate delivery requires actual writer and source-ownership checks/,
  );
  assert.throws(
    () =>
      inspectRenovateQueue(
        queueClient({ target: { commit: { sha: "d".repeat(40) } } }),
        queueConfig,
        required,
        queueBase,
      ),
    /target changed/,
  );
  assert.throws(
    () =>
      inspectRenovateQueue(queueClient(), queueConfig, required, () => ({
        ...queueBase(),
        changedHead: "d".repeat(40),
      })),
    /candidate changed/,
  );
});

void test("cooldown draft failed CI and rejected targets cannot become actionable controlled candidates", () => {
  for (const overrides of [
    {
      statuses: [
        { context: "renovate/stability-days", state: "pending", description: "missing timestamp" },
      ],
    },
    { pull: { draft: true } },
    { contexts: [{ context: "rust", outcome: "failure", conclusion: "failure" }] },
    { pull: { base: { sha: base, ref: "different" } } },
    { pull: { mergeable: null } },
  ] satisfies QueueOverrides[]) {
    const queue = inspectRenovateQueue(queueClient(overrides), queueConfig, required, queueBase);
    assert.equal(queue.selected, null);
    assert.equal(requiredFixture(queue.candidates[0]).actionable, false);
    assert.ok(requiredFixture(queue.candidates[0]).next_action);
  }
});

void test("branch-only security intent uses controlled expedited assessment without asserting vulnerability", () => {
  const queue = inspectRenovateQueue(
    queueClient({
      pull: { head: { sha: head, ref: "renovate/security/crc32fast" } },
      statuses: [{ context: "renovate/stability-days", state: "pending" }],
    }),
    queueConfig,
    required,
    queueBase,
  );
  assert.equal(requiredFixture(queue.candidates[0]).path, "urgent-remediation-assessment");
  assert.equal(requiredFixture(queue.candidates[0]).verdict, "manual-review-required");
  assert.match(
    requiredFixture(queue.candidates[0]).next_action,
    /inspect advisory\/graph\/features/,
  );
});

void test("required contexts are loaded from both checked-in authorities", () => {
  const ruleset = {
    rules: [
      {
        type: "required_status_checks",
        parameters: { required_status_checks: required.map((context) => ({ context })) },
      },
    ],
  };
  assert.deepEqual(
    requiredContextsFromConfigs(ruleset, { protected_contexts: [...required].reverse() }),
    required,
  );
  assert.throws(
    () => requiredContextsFromConfigs(ruleset, { protected_contexts: required.slice(1) }),
    /differ/,
  );
});

void test("pull request references are repository-bound and exact", () => {
  assert.equal(parsePullRequestReference("7"), 7);
  assert.equal(parsePullRequestReference("https://github.com/boburning/portcove/pull/7"), 7);
  for (const value of ["0", "#7", "https://github.com/other/repo/pull/7"])
    assert.throws(() => parsePullRequestReference(value), /invalid/);
});

void test("delivery arguments accept opt-in JSON without changing required values", () => {
  assert.deepEqual(
    parseArguments([
      "watch",
      "--pr",
      "7",
      "--json",
      "--head",
      head,
      "--run",
      "42",
      "--attempt",
      "1",
      "--deadline",
      "2026-10-01T22:00:00Z",
    ]),
    {
      command: "watch",
      options: {
        "--pr": "7",
        "--json": true,
        "--head": head,
        "--run": "42",
        "--attempt": "1",
        "--deadline": "2026-10-01T22:00:00Z",
      },
    },
  );
  assert.deepEqual(parseArguments(["renovate-check", "--pr", "7", "--head", head]), {
    command: "renovate-check",
    options: { "--pr": "7", "--head": head },
  });
  assert.throws(() => parseArguments(["merge", "--pr", "7", "--head"]), /invalid argument/);
  assert.throws(() => parseArguments(["watch", "--run", "42", "--run", "43"]), /duplicate option/);
});

void test("Renovate verdicts have matching human and JSON output", () => {
  const result = {
    verdict: "waiting",
    reason: "minimum release age is still pending",
    evidence: { release_age: { state: "pending" } },
  };
  const output = renovateCheckEnvelope({
    number: 7,
    head,
    result,
    snapshot: { commits: [{ sha: head }], files: [{ filename: "Cargo.lock" }] },
  });
  assert.match(output.summary, /waiting: minimum release age is still pending/);
  assert.equal(output.evidence.verdict, "waiting");
  assert.equal(output.evidence.release_age.state, "pending");
  const roundTrip: unknown = JSON.parse(JSON.stringify(output));
  assert.equal(record(record(roundTrip).evidence).head, head);
});

void test("check-run pagination requires complete unique totals", () => {
  const calls: string[] = [];
  const client = new PullRequestDeliveryClient((args) => {
    calls.push(requiredFixture(args[2]));
    if (requiredFixture(args[2]).includes("page=2"))
      return included({
        total_count: 2,
        check_runs: [{ id: 2, name: "two", status: "completed" }],
      });
    return included(
      { total_count: 2, check_runs: [{ id: 1, name: "one", status: "completed" }] },
      { link: '<https://api.github.test/checks?page=2>; rel="next"' },
    );
  });
  assert.deepEqual(
    client.checkRuns(head).map((run) => run.id),
    [1, 2],
  );
  assert.equal(calls.length, 2);
});

void test("provider nulls and unconsumed metadata survive the delivery boundary", () => {
  const retained = { provider_note: "preserved raw metadata" };
  const client = new PullRequestDeliveryClient((args) => {
    const endpoint = requiredFixture(args[2]);
    if (endpoint === "repos/boburning/portcove/pulls/7")
      return included({ ...pull({ user: null, body: null }), ...retained });
    if (endpoint.includes("/commits?"))
      return included([{ sha: head, author: null, commit: { message: "fixture" }, ...retained }]);
    if (endpoint.includes("/jobs?"))
      return included({
        total_count: required.length,
        jobs: workflowJobs().map((job) => ({ ...job, completed_at: null })),
      });
    if (endpoint.includes("/actions/runs/42"))
      return included({
        ...workflow({ created_at: null, run_started_at: null }),
        repository: { full_name: "boburning/portcove" },
        ...retained,
      });
    return included([
      { number: 7, user: { login: "renovate[bot]" }, head: { sha: head }, ...retained },
    ]);
  });
  const request = client.pull(7);
  assert.equal(request.user, null);
  assert.equal(request.body, null);
  assert.equal(record(request).provider_note, retained.provider_note);
  const commit = requiredFixture(client.pullCommits(7)[0]);
  assert.equal(commit.author, null);
  assert.equal(record(commit).provider_note, retained.provider_note);
  const run = client.workflowRun(42);
  assert.equal(run.created_at, null);
  assert.equal(run.run_started_at, null);
  assert.equal(record(run).provider_note, retained.provider_note);
  assert.ok(client.workflowJobs(42, 1).every((job) => job.completed_at === null));
  assert.equal(
    record(requiredFixture(client.openRenovatePulls()[0])).provider_note,
    retained.provider_note,
  );
});

void test("delivery response projections reject malformed known metadata without inventing valid facts", () => {
  for (const malformed of [
    { user: 7 },
    { head: { sha: 7 } },
    { commits: "1" },
    { mergeable: "true" },
    { assignees: [{ login: 7 }] },
  ]) {
    const client = new PullRequestDeliveryClient(() => included({ ...pull(), ...malformed }));
    assert.throws(() => client.pull(7));
  }
});

void test("Renovate snapshot inventories every commit and file page exactly once", () => {
  const calls: string[] = [];
  const client = new PullRequestDeliveryClient((args) => {
    const endpoint = requiredFixture(args[2]);
    calls.push(endpoint);
    if (endpoint === "repos/boburning/portcove/pulls/7")
      return included(pull({ commits: 2, changed_files: 2, base: { sha: base, ref: "main" } }));
    if (endpoint.includes("check-runs"))
      return included({ total_count: required.length, check_runs: successfulRuns() });
    if (endpoint.includes("/status?")) return included({ total_count: 0, statuses: [] });
    if (endpoint.includes("/commits?") && endpoint.includes("page=2"))
      return included([{ sha: "d".repeat(40) }]);
    if (endpoint.includes("/commits?"))
      return included([{ sha: head }], {
        link: '<https://api.github.test/commits?page=2>; rel="next"',
      });
    if (endpoint.includes("/files?") && endpoint.includes("page=2"))
      return included([{ filename: "Cargo.lock" }]);
    if (endpoint.includes("/files?"))
      return included([{ filename: "Cargo.toml" }], {
        link: '<https://api.github.test/files?page=2>; rel="next"',
      });
    if (endpoint.endsWith("/branches/main")) return included({ commit: { sha: base } });
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  const result = client.renovateSnapshot(7, head, required);
  assert.deepEqual(
    result.commits.map((commit) => commit.sha),
    [head, "d".repeat(40)],
  );
  assert.deepEqual(
    result.files.map((file) => file.filename),
    ["Cargo.toml", "Cargo.lock"],
  );
  assert.equal(
    calls.filter((endpoint) => endpoint === "repos/boburning/portcove/pulls/7").length,
    1,
  );
});

void test("Renovate snapshot rejects incomplete commit and file inventories", () => {
  for (const mismatch of [
    { commits: 2, changed_files: 2 },
    { commits: 1, changed_files: 3 },
  ]) {
    const client = new PullRequestDeliveryClient();
    client.pull = () => pull({ ...mismatch, base: { sha: base, ref: "main" } });
    client.checkRuns = () => successfulRuns();
    client.commitStatuses = () => [];
    client.pullCommits = () => [{ sha: head }];
    client.pullFiles = () => [{ filename: "Cargo.toml" }, { filename: "Cargo.lock" }];
    client.branch = () => ({ commit: { sha: base } });
    assert.throws(() => client.renovateSnapshot(7, head, required), /inventory is incomplete/);
  }
});

void test("required context reduction fails closed on missing and duplicate producers", () => {
  const successful = requiredCheckContexts(successfulRuns(), [], required);
  assert.ok(successful.every((context) => context.outcome === "success"));
  const missing = requiredCheckContexts(successfulRuns().slice(1), [], required);
  assert.equal(requiredFixture(missing[0]).conclusion, "missing");
  const duplicate = requiredCheckContexts(
    successfulRuns(),
    [{ id: 99, context: "rust", state: "success", target_url: "https://github.test/status" }],
    required,
  );
  assert.equal(
    requiredFixture(duplicate.find((context) => context.context === "rust")).conclusion,
    "ambiguous",
  );
});

void test("required check observation is exact-head and fails closed on ambiguity", () => {
  const client = new PullRequestDeliveryClient();
  client.pull = () => pull();
  client.checkRuns = () => successfulRuns();
  client.commitStatuses = () => [];
  assert.ok(
    client
      .requiredCheckState(7, head, required)
      .contexts.every((item) => item.outcome === "success"),
  );
  client.commitStatuses = () => [
    { id: 99, context: "rust", state: "success", target_url: "https://github.test/status" },
  ];
  assert.equal(
    requiredFixture(
      client.requiredCheckState(7, head, required).contexts.find((item) => item.context === "rust"),
    ).conclusion,
    "ambiguous",
  );
  client.pull = () => pull({ head: { sha: "d".repeat(40) } });
  assert.throws(() => client.requiredCheckState(7, head, required), /head changed/);
});

const watchOptions = {
  number: 7,
  head,
  requiredContexts: required,
  run: 42,
  attempt: 1,
  deadline: "2026-10-01T22:00:00Z",
  now: () => Date.parse("2026-10-01T21:00:00Z"),
};
function workflow(overrides: Partial<DeliveryWorkflow> = {}): DeliveryWorkflow {
  return {
    id: 42,
    head_sha: head,
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-10-01T20:55:00Z",
    run_started_at: "2026-10-01T21:00:00Z",
    html_url: "https://github.com/boburning/portcove/actions/runs/42",
    ...overrides,
  };
}
function checkState(outcome: WatchContext["outcome"] = "pending"): WatchState {
  return {
    contexts: required.map((context, index) => ({
      context,
      source: "check-run",
      check_run_id: index + 1,
      outcome,
      conclusion: outcome === "pending" ? "missing" : outcome,
    })),
  };
}
function workflowJobs() {
  return required.map((name, index) => ({
    id: index + 1,
    name,
    run_id: 42,
    run_attempt: 1,
    head_sha: head,
    status: "completed",
    conclusion: "success",
    check_run_url: `https://api.github.com/repos/boburning/portcove/check-runs/${index + 1}`,
  }));
}

void test("watcher waits quietly on one run and requires both terminal success and exact-head gates", async () => {
  let calls = 0;
  const pauses: number[] = [];
  const pendingThenSuccess = {
    workflowJobs,
    workflowRun(id: number) {
      assert.equal(id, 42);
      return workflow(calls >= 1 ? { status: "completed", conclusion: "success" } : {});
    },
    requiredCheckState(): WatchState {
      calls += 1;
      return {
        contexts: required.map((context, index) => ({
          context,
          source: "check-run",
          check_run_id: index + 1,
          outcome: calls === 1 ? "pending" : "success",
          conclusion: calls === 1 ? "missing" : "success",
        })),
      };
    },
  };
  const state = await watchRequiredChecks(pendingThenSuccess, {
    ...watchOptions,
    sleep: async (milliseconds) => pauses.push(milliseconds),
  });
  assert.ok(state.contexts.every((context) => context.outcome === "success"));
  assert.deepEqual(pauses, [180_000]);
  assert.equal(state.watch.deadline, watchOptions.deadline);
  assert.ok(state.watch.workflow);
  assert.equal(state.watch.workflow.created_at, "2026-10-01T20:55:00Z");
  assert.equal(state.watch.workflow.run_started_at, "2026-10-01T21:00:00Z");
  assert.match(state.watch.next_action, /guarded merge/);

  for (const conclusion of [
    "failure",
    "cancelled",
    "timed_out",
    "skipped",
    "stale",
    "action_required",
  ]) {
    await assert.rejects(
      watchRequiredChecks(
        {
          workflowRun: () => workflow(),
          requiredCheckState: () => ({
            contexts: [{ context: "rust", outcome: "failure", conclusion }],
          }),
        },
        { ...watchOptions, requiredContexts: ["rust"] },
      ),
      new RegExp(conclusion),
    );
  }
});

void test("resuming an expired deadline reads evidence once and never creates another wait", async () => {
  for (let resume = 0; resume < 2; resume += 1) {
    let reads = 0;
    await assert.rejects(
      watchRequiredChecks(
        {
          workflowRun: () => workflow(),
          requiredCheckState: () => {
            reads += 1;
            return checkState();
          },
        },
        {
          ...watchOptions,
          now: () => Date.parse("2026-10-01T22:01:00Z"),
          sleep: async () => assert.fail("expired watcher must not sleep"),
        },
      ),
      (error) => {
        assert.match(errorMessage(error), /timed out/);
        assert.equal(evidence(error).run, 42);
        assert.equal(evidence(error).attempt, 1);
        assert.equal(evidence(error).deadline, watchOptions.deadline);
        assert.equal(array(evidence(error).contexts).length, required.length);
        assert.match(String(evidence(error).next_action), /artifacts/);
        return true;
      },
    );
    assert.equal(reads, 1);
  }
});

void test("watcher caps its final sleep to the retained deadline", async () => {
  let current = Date.parse(watchOptions.deadline) - 2500;
  const pauses: number[] = [];
  await assert.rejects(
    watchRequiredChecks(
      { workflowRun: () => workflow(), requiredCheckState: () => checkState() },
      {
        ...watchOptions,
        now: () => current,
        sleep: async (ms) => {
          pauses.push(ms);
          current += ms;
        },
      },
    ),
    /timed out/,
  );
  assert.deepEqual(pauses, [2500]);
});

void test("watcher stops on replacement identity, failed workflow, absent gates or monitoring failure", async () => {
  for (const [runState, pattern] of [
    [{ head_sha: base }, /run\/source\/attempt changed/],
    [{ run_attempt: 2 }, /run\/source\/attempt changed/],
    [{ status: "unknown" }, /status is missing or unknown/],
    [{ created_at: "unknown" }, /creation time/],
    [{ status: "completed", conclusion: "failure" }, /completed with failure/],
    [{ status: "completed", conclusion: "cancelled" }, /completed with cancelled/],
    [{ status: "completed", conclusion: null }, /no conclusion/],
    [{ status: "completed", conclusion: "success" }, /gates remain missing/],
  ] as const)
    await assert.rejects(
      watchRequiredChecks(
        {
          workflowRun: () => workflow(runState),
          requiredCheckState: () => checkState(),
        },
        { ...watchOptions, sleep: async () => assert.fail("terminal state must stop") },
      ),
      pattern,
    );
  await assert.rejects(
    watchRequiredChecks(
      // @ts-expect-error Deliberately omit later capabilities; the first read must retain its failure.
      {
        workflowRun: () => {
          throw new Error("403 readback unavailable");
        },
      },
      watchOptions,
    ),
    (error) => {
      assert.match(errorMessage(error), /monitoring failed/);
      assert.equal(evidence(error).head, head);
      return true;
    },
  );
});

void test("watcher rejects missing identity/deadline before querying and does not accept old green gates while the run is pending", async () => {
  const client = { workflowRun: () => assert.fail("invalid options must stop before API access") };
  for (const overrides of [
    { run: 0 },
    { attempt: 0 },
    { deadline: undefined },
    { deadline: "in one hour" },
    { deadline: "2026-02-30T22:00:00Z" },
    { deadline: "2026-10-01T22:00:00+00:00" },
  ])
    // @ts-expect-error Deliberately incomplete client and malformed deadline exercise rejection before API access.
    await assert.rejects(watchRequiredChecks(client, { ...watchOptions, ...overrides }));
  await assert.rejects(
    watchRequiredChecks(
      { workflowRun: () => workflow(), requiredCheckState: () => checkState("success") },
      { ...watchOptions, now: () => Date.parse(watchOptions.deadline) },
    ),
    /timed out/,
  );
});

void test("workflow REST readback validates repository and opaque run identity", () => {
  let body = { ...workflow(), repository: { full_name: "boburning/portcove" } };
  const client = new PullRequestDeliveryClient((args) => {
    assert.equal(requiredFixture(args[2]), "repos/boburning/portcove/actions/runs/42");
    return included(body);
  });
  assert.equal(client.workflowRun(42).id, 42);
  body = { ...body, id: 43 };
  assert.throws(() => client.workflowRun(42), /identity/);
  body = { ...body, id: 42, repository: { full_name: "other/portcove" } };
  assert.throws(() => client.workflowRun(42), /identity/);
});

void test("watcher rejects green checks from another run/attempt or incomplete job inventory", async () => {
  for (const change of [
    (jobs: DeliveryJob[]) => jobs.slice(1),
    (jobs: DeliveryJob[]) => [{ ...requiredFixture(jobs[0]), run_id: 43 }, ...jobs.slice(1)],
    (jobs: DeliveryJob[]) => [{ ...requiredFixture(jobs[0]), run_attempt: 2 }, ...jobs.slice(1)],
    (jobs: DeliveryJob[]) => [{ ...requiredFixture(jobs[0]), head_sha: base }, ...jobs.slice(1)],
    (jobs: DeliveryJob[]) => [{ ...requiredFixture(jobs[0]), name: "other" }, ...jobs.slice(1)],
    (jobs: DeliveryJob[]) => [
      { ...requiredFixture(jobs[0]), conclusion: "skipped" },
      ...jobs.slice(1),
    ],
    (jobs: DeliveryJob[]) => [
      {
        ...requiredFixture(jobs[0]),
        check_run_url: requiredFixture(requiredFixture(jobs[1]).check_run_url),
      },
      ...jobs.slice(1),
    ],
    (jobs: DeliveryJob[]) => [
      {
        ...requiredFixture(jobs[0]),
        check_run_url: "https://api.github.com/repos/other/repo/check-runs/1",
      },
      ...jobs.slice(1),
    ],
  ])
    await assert.rejects(
      watchRequiredChecks(
        {
          workflowRun: () => workflow({ status: "completed", conclusion: "success" }),
          requiredCheckState: () => checkState("success"),
          workflowJobs: () => change(workflowJobs()),
        },
        watchOptions,
      ),
      /inventory|not a successful job/,
    );
  await assert.rejects(
    watchRequiredChecks(
      {
        workflowRun: () => workflow({ status: "completed", conclusion: "success" }),
        requiredCheckState: () => checkState("success"),
        workflowJobs: () => {
          throw new Error("incomplete paginated jobs");
        },
      },
      watchOptions,
    ),
    /job readback failed/,
  );
});

void test("workflow attempt job inventory follows pagination and rejects incomplete totals", () => {
  let incomplete = false;
  const client = new PullRequestDeliveryClient((args) => {
    const endpoint = requiredFixture(args[2]);
    assert.match(endpoint, /actions\/runs\/42\/jobs\?filter=all/);
    if (endpoint.includes("page=2"))
      return included({ total_count: 5, jobs: workflowJobs().slice(1) });
    return included(
      { total_count: incomplete ? 6 : 5, jobs: workflowJobs().slice(0, 1) },
      {
        link: '<https://api.github.com/repos/boburning/portcove/actions/runs/42/jobs?filter=all&per_page=100&page=2>; rel="next"',
      },
    );
  });
  assert.equal(client.workflowJobs(42, 1).length, 5);
  incomplete = true;
  assert.throws(() => client.workflowJobs(42, 1), /incomplete|total/);
});

void test("watch-only API reads bound subprocess and whole observation without altering merge clients", () => {
  let time = 1000;
  const timeouts: (number | undefined)[] = [];
  const client = createWatchClient({
    now: () => time,
    spawn: (_command, _args, options) => {
      timeouts.push(options.timeout);
      assert.equal(options.killSignal, "SIGKILL");
      return {
        status: 0,
        stdout: included({ ...workflow(), repository: { full_name: "boburning/portcove" } }),
        stderr: "",
      };
    },
  });
  assert.throws(() => client.workflowRun(42), /60-second budget/);
  client.beginObservation();
  client.workflowRun(42);
  time += 59_500;
  client.workflowRun(42);
  time += 500;
  assert.throws(() => client.workflowRun(42), /60-second budget/);
  assert.deepEqual(timeouts, [15_000, 500]);
});

void test("subprocess timeout is retained as a failed observation with no retry", async () => {
  let calls = 0;
  const client = createWatchClient({
    spawn: () => {
      calls += 1;
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" }),
      };
    },
  });
  await assert.rejects(watchRequiredChecks(client, watchOptions), (error) => {
    assert.match(errorMessage(error), /monitoring failed.*ETIMEDOUT/);
    assert.equal(evidence(error).deadline, watchOptions.deadline);
    return true;
  });
  assert.equal(calls, 1);
});

void test("watcher rejects an attempt changed during otherwise successful job collection", async () => {
  let reads = 0;
  await assert.rejects(
    watchRequiredChecks(
      {
        workflowRun: () =>
          workflow({
            status: "completed",
            conclusion: "success",
            run_attempt: ++reads === 1 ? 1 : 2,
          }),
        requiredCheckState: () => checkState("success"),
        workflowJobs,
      },
      watchOptions,
    ),
    (error) => {
      assert.match(errorMessage(error), /changed during job collection/);
      assert.equal(record(evidence(error).workflow).run_attempt, 2);
      return true;
    },
  );
  assert.equal(reads, 2);
});

void test("REST merge uses the exact SHA and verifies remote completion", () => {
  const calls: { method: string | undefined; endpoint: string; input: string | undefined }[] = [];
  let merged = false;
  const client = new PullRequestDeliveryClient((args, input) => {
    const method = requiredFixture(args[4]);
    const endpoint = args[1] === "graphql" ? "graphql" : requiredFixture(args[2]);
    calls.push({ method, endpoint, input });
    if (endpoint === "graphql") return included(closingPage());
    if (endpoint === "repos/boburning/portcove/pulls/7/commits?per_page=100")
      return included([{ sha: head, commit: { message: squashMessage.title } }]);
    if (endpoint === `repos/boburning/portcove/git/commits/${merge}`)
      return included({ sha: merge, message: `${squashMessage.title}\n\n${squashMessage.body}` });
    if (endpoint === "repos/boburning/portcove/pulls/7") {
      return included(
        merged ? pull({ merged: true, state: "closed", merge_commit_sha: merge }) : pull(),
      );
    }
    if (endpoint.includes("check-runs"))
      return included({ total_count: required.length, check_runs: successfulRuns() });
    if (endpoint.includes("/status?")) return included({ total_count: 0, statuses: [] });
    if (endpoint === "repos/boburning/portcove/pulls/7/merge") {
      merged = true;
      assert.deepEqual(JSON.parse(input ?? ""), {
        merge_method: "squash",
        sha: head,
        commit_title: squashMessage.title,
        commit_message: squashMessage.body,
      });
      return included({ merged: true, sha: merge, message: "Pull Request successfully merged" });
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  const result = client.merge(7, head, required, emptyIntent, squashMessage);
  assert.equal(result.result.sha, merge);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
  assert.equal(
    calls.some((call) => call.endpoint === "graphql"),
    true,
  );
});

void test("merge command errors are reconciled through remote readback before retry", () => {
  let merged = false;
  const client = new PullRequestDeliveryClient((args) => {
    const endpoint = args[1] === "graphql" ? "graphql" : requiredFixture(args[2]);
    if (endpoint === "graphql") return included(closingPage());
    if (endpoint === "repos/boburning/portcove/pulls/7/commits?per_page=100")
      return included([{ sha: head, commit: { message: squashMessage.title } }]);
    if (endpoint === `repos/boburning/portcove/git/commits/${merge}`)
      return included({ sha: merge, message: `${squashMessage.title}\n\n${squashMessage.body}` });
    if (endpoint === "repos/boburning/portcove/pulls/7")
      return included(
        merged ? pull({ merged: true, state: "closed", merge_commit_sha: merge }) : pull(),
      );
    if (endpoint.includes("check-runs"))
      return included({ total_count: required.length, check_runs: successfulRuns() });
    if (endpoint.includes("/status?")) return included({ total_count: 0, statuses: [] });
    if (endpoint === "repos/boburning/portcove/pulls/7/merge") {
      merged = true;
      throw new Error("local cleanup failed after request");
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  const result = client.merge(7, head, required, emptyIntent, squashMessage);
  assert.equal(result.result.sha, merge);
  assert.match(String(result.result.message), /readback confirmed/);
});

void test("merge reports unknown when mutation and remote readback are both ambiguous", () => {
  const client = new PullRequestDeliveryClient();
  client.api = new GitHubApiClient(() => included(closingPage()));
  client.pullCommits = () => [{ sha: head, commit: { message: squashMessage.title } }];
  client.requiredCheckState = () => ({
    head,
    pull: pull(),
    contexts: requiredCheckContexts(successfulRuns(), [], required),
  });
  client.request = () => {
    throw new Error("connection closed");
  };
  client.pull = () => {
    throw new Error("readback unavailable");
  };
  assert.throws(
    () => client.merge(7, head, required, emptyIntent, squashMessage),
    (error) =>
      deliveryError(error).operationStatus === "unknown" &&
      evidence(error).pull_request === 7 &&
      /outcome is unknown/.test(errorMessage(error)),
  );
});

void test("merge refuses draft conflict and incomplete-check states before mutation", () => {
  for (const overrides of [{ draft: true }, { mergeable: false }, { mergeable: null }]) {
    const client = new PullRequestDeliveryClient();
    client.pull = () => pull(overrides);
    client.checkRuns = () => successfulRuns();
    client.commitStatuses = () => [];
    assert.throws(() => client.merge(7, head, required), /draft|conflict|determined/);
  }
  const client = new PullRequestDeliveryClient();
  client.pull = () => pull();
  client.checkRuns = () => successfulRuns().slice(1);
  client.commitStatuses = () => [];
  assert.throws(() => client.merge(7, head, required), /not successful/);
});

function closureGuardClient(
  pages: unknown[],
  commits = [{ sha: head, commit: { message: "fix: scoped component" } }],
) {
  let index = 0;
  const client = new PullRequestDeliveryClient();
  client.api = new GitHubApiClient(() =>
    included(requiredFixture(pages[Math.min(index++, pages.length - 1)])),
  );
  client.requiredCheckState = () => ({
    head,
    pull: pull(),
    contexts: requiredCheckContexts(successfulRuns(), [], required),
  });
  client.pullCommits = () => commits;
  client.request = () => assert.fail("Closure refusal must precede merge mutation");
  return client;
}

void test("empty component intent refuses keyword-free manual closure relationships", () => {
  const page = closingPage({
    closingIssuesReferences: {
      totalCount: 1,
      nodes: [
        { id: "manual-issue", number: 244, repository: { nameWithOwner: "boburning/portcove" } },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  const client = closureGuardClient([page]);
  assert.throws(
    () => client.merge(7, head, required, emptyIntent, squashMessage),
    /Undeclared closing relationship/,
  );
});

void test("unchanged source head does not hide PR body or relationship changes", () => {
  for (const second of [
    closingPage({ body: "Related to #202." }),
    closingPage({
      closingIssuesReferences: {
        totalCount: 1,
        nodes: [
          { id: "manual-issue", number: 244, repository: { nameWithOwner: "boburning/portcove" } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
  ]) {
    assert.throws(
      () =>
        closureGuardClient([closingPage(), second]).merge(
          7,
          head,
          required,
          emptyIntent,
          squashMessage,
        ),
      /changed before merge/,
    );
  }
});

void test("candidate commit and actual proposed squash text require explicit closure permission", () => {
  for (const text of [
    "Fixes https://github.com/boburning/portcove/issues/244",
    "Fixes https://github.com/other/repo/issues/244",
  ]) {
    assert.throws(
      () =>
        closureGuardClient([closingPage()], [{ sha: head, commit: { message: text } }]).merge(
          7,
          head,
          required,
          emptyIntent,
          squashMessage,
        ),
      /Undeclared/,
    );
    assert.throws(
      () =>
        closureGuardClient([closingPage()]).merge(7, head, required, emptyIntent, {
          ...squashMessage,
          body: text,
        }),
      /Undeclared/,
    );
  }
  assert.throws(
    () =>
      closureGuardClient(
        [closingPage()],
        [{ sha: head, commit: { message: "Closes #244" } }],
      ).merge(7, head, required, emptyIntent, squashMessage),
    /Undeclared/,
  );
  assert.throws(
    () =>
      closureGuardClient([closingPage()]).merge(7, head, required, emptyIntent, {
        ...squashMessage,
        body: "Fixes: #244",
      }),
    /Undeclared/,
  );
  assert.throws(
    () => closureGuardClient([closingPage()]).merge(7, head, required, undefined, squashMessage),
    /independent/,
  );
});

void test("unexpected actual squash message preserves a merged outcome without retry", () => {
  const client = closureGuardClient([closingPage()]);
  let writes = 0;
  client.request = (method) => {
    if (method === "PUT") {
      writes++;
      return { body: { merged: true, sha: merge, message: "merged" } };
    }
    return { body: { sha: merge, message: "Unexpected Closes #244" } };
  };
  client.pull = () => pull({ merged: true, state: "closed", merge_commit_sha: merge });
  assert.throws(
    () => client.merge(7, head, required, emptyIntent, squashMessage),
    (error) =>
      deliveryError(error).operationStatus === "unknown" &&
      evidence(error).merge_commit_sha === merge &&
      /Actual merged commit message differs/.test(errorMessage(error)) &&
      record(record(evidence(error).closure_readback).actual_commit).message ===
        "Unexpected Closes #244" &&
      record(record(evidence(error).closure_readback).mutation).merged === true &&
      record(record(evidence(error).closure_readback).pull).merge_commit_sha === merge,
  );
  assert.equal(writes, 1);
});

void test("delivery help shares supported flags and performs no API work", () => {
  assert.match(deliveryHelp("watch"), /--progress/);
  assert.match(deliveryHelp("renovate-check"), /--summary/);
  assert.deepEqual(parseArguments(["watch", "--help"]), {
    command: "watch",
    options: { "--help": true },
  });
  assert.throws(() => parseArguments(["merge", "--progress"]), /unsupported/);
  assert.throws(() => deliveryHelp("unknown"), /unknown command/);
});
void test("progress is change-only and preserves source/run/attempt identity", () => {
  const output: string[] = [];
  const progress = createWatchProgress((text) => output.push(text));
  const observation: import("./pr-delivery.mts").WatchObservation = {
    kind: "delivery-observation",
    head,
    run: 42,
    attempt: 1,
    workflow: { head_sha: head, run_attempt: 1, status: "in_progress", conclusion: null },
    contexts: [{ context: "frontend", outcome: "pending", conclusion: "pending" }],
  };
  progress(observation);
  progress({ ...observation, recorded_at: "later" });
  assert.equal(output.length, 1);
  progress({
    ...observation,
    contexts: [{ context: "frontend", outcome: "success", conclusion: "success" }],
  });
  assert.equal(output.length, 2);
  progress({ ...observation, workflow: { ...observation.workflow, head_sha: base } });
  assert.equal(output.length, 3);
  assert.match(requiredFixture(output[2]), new RegExp(head));
  assert.match(requiredFixture(output[2]), new RegExp(base));
  assert.match(requiredFixture(output[2]), /42\/1/);
  assert(output.every((text) => Buffer.byteLength(text + "\n") <= 16 * 1024));
});

void test("command help and incompatible output modes fail offline before network access", () => {
  for (const command of ["watch", "renovate-check", "merge"]) {
    const result = spawnHelp(process.execPath, ["scripts/pr-delivery.mts", command, "--help"], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, PATH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /usage:/);
    assert.equal(result.stderr, "");
  }
  const incompatible = spawnHelp(
    process.execPath,
    ["scripts/pr-delivery.mts", "renovate-check", "--queue", "--json", "--summary"],
    { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: "" } },
  );
  assert.equal(incompatible.status, 1);
  assert.match(incompatible.stderr, /mutually exclusive/);
});
void test("all authored Renovate next-action branches preserve current execution authority", () => {
  assert.doesNotMatch(
    inspectRenovateQueue.toString(),
    /configured operational board|Accepted coordinator assignments|Confirm the accepted assignment/,
  );
});

void test("selective retry retains independent success but refuses newer authoritative executions", async () => {
  const old = workflowJobs();
  const rerun = {
    ...requiredFixture(old[0]),
    id: 100,
    run_attempt: 2,
    check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/100",
  };
  const state = checkState("success");
  requiredFixture(state.contexts[0]).check_run_id = 100;
  const client = {
    workflowRun: () => workflow({ run_attempt: 2, status: "completed", conclusion: "success" }),
    requiredCheckState: () => state,
    workflowJobs: () => [...old, rerun],
  };
  await watchRequiredChecks(client, { ...watchOptions, attempt: 2 });
  for (const newer of [
    { ...rerun, conclusion: "failure" },
    { ...rerun, status: "in_progress", conclusion: null },
  ]) {
    await assert.rejects(
      watchRequiredChecks(
        { ...client, workflowJobs: () => [...old, newer] },
        { ...watchOptions, attempt: 2 },
      ),
    );
    const stale = checkState("success");
    await assert.rejects(
      watchRequiredChecks(
        { ...client, requiredCheckState: () => stale, workflowJobs: () => [...old, newer] },
        { ...watchOptions, attempt: 2 },
      ),
    );
  }
  await assert.rejects(
    watchRequiredChecks(
      {
        ...client,
        workflowJobs: () => [
          ...old,
          rerun,
          {
            ...rerun,
            id: 101,
            check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/101",
          },
        ],
      },
      { ...watchOptions, attempt: 2 },
    ),
    /invalid or duplicate/,
  );
});

function inspectionClient(
  options: {
    pull?: Partial<DeliveryPull>;
    checks?: ReturnType<typeof successfulRuns>;
    changeHead?: boolean;
    changeTarget?: boolean;
    incomplete?: boolean;
    paginated?: boolean;
    workflow?: Partial<DeliveryWorkflow>;
  } = {},
) {
  let pullReads = 0;
  let targetReads = 0;
  const calls: string[] = [];
  const client = new PullRequestDeliveryClient((args) => {
    assert.equal(args[args.indexOf("--method") + 1], "GET", "inspection must issue only GETs");
    const endpoint = requiredFixture(args[2]);
    calls.push(endpoint);
    if (endpoint.endsWith("/pulls/7")) {
      pullReads++;
      return included(
        pull({
          base: { sha: base, ref: "main" },
          ...options.pull,
          ...(options.changeHead && pullReads > 1 ? { head: { sha: merge } } : {}),
        }),
      );
    }
    if (endpoint.endsWith("/branches/main")) {
      targetReads++;
      return included({ commit: { sha: options.changeTarget && targetReads > 1 ? merge : base } });
    }
    if (endpoint.includes("/check-runs?")) {
      const runs = options.checks ?? successfulRuns();
      if (options.paginated)
        return included(
          {
            total_count: runs.length,
            check_runs: endpoint.includes("page=2") ? runs.slice(3) : runs.slice(0, 3),
          },
          endpoint.includes("page=2")
            ? {}
            : {
                link:
                  "<https://api.github.com/repos/boburning/portcove/commits/" +
                  head +
                  '/check-runs?filter=all&per_page=100&page=2>; rel="next"',
              },
        );
      return included({
        total_count: runs.length + (options.incomplete ? 1 : 0),
        check_runs: runs,
      });
    }
    if (endpoint.includes("/status?")) return included({ total_count: 0, statuses: [] });
    if (endpoint.endsWith("/actions/runs/42"))
      return included({
        id: 42,
        run_attempt: 1,
        head_sha: head,
        repository: { full_name: "boburning/portcove" },
        status: "in_progress",
        conclusion: null,
        ...options.workflow,
      });
    throw new Error(`Unexpected inspection read: ${endpoint}`);
  });
  return { client, calls };
}
const inspectOptions = { number: 7, head, contexts: required };

void test("inspection observes pending, failure, success, changed head and confirmed merge without mutations", async () => {
  for (const [checks, expected] of [
    [[], "Inspect the retained"],
    [successfulRuns().map((run) => ({ ...run, conclusion: "failure" })), "Inspect failed"],
    [successfulRuns(), "Complete or reconcile independent review"],
  ] as const) {
    const fixture = inspectionClient({ checks: [...checks] });
    const result = await inspectDelivery(fixture.client, inspectOptions);
    assert.equal(result.observation, "complete");
    assert.ok(result.next_action.startsWith(expected));
    assert.equal(result.review.state, "unknown");
    assert.equal(fixture.calls.length, 6);
  }
  const changed = await inspectDelivery(
    inspectionClient({ pull: { head: { sha: merge } } }).client,
    inspectOptions,
  );
  assert.equal(changed.source.matches, false);
  assert.match(changed.next_action, /observed source head/);
  const merged = await inspectDelivery(
    inspectionClient({ pull: { state: "closed", merged: true, merge_commit_sha: merge } }).client,
    inspectOptions,
  );
  assert.equal(merged.pull.merge_commit_sha, merge);
  assert.match(merged.next_action, /Reconcile the owning issue/);
  const paginated = inspectionClient({ paginated: true });
  assert.ok(
    (await inspectDelivery(paginated.client, inspectOptions)).checks.every(
      (check) => check.outcome === "success",
    ),
  );
  assert.equal(paginated.calls.length, 7);
});

void test("inspection refuses incomplete pagination, contradictory PR fields and source/target changes during collection", async () => {
  for (const options of [
    { incomplete: true },
    { changeHead: true },
    { changeTarget: true },
    { pull: { merged: true, state: "open", merge_commit_sha: null } },
    { pull: { base: { sha: base } } },
  ] satisfies Parameters<typeof inspectionClient>[0][]) {
    await assert.rejects(
      inspectDelivery(inspectionClient(options).client, inspectOptions),
      (error) =>
        deliveryError(error).operationStatus === "unknown" &&
        evidence(error).observation === "unknown",
    );
  }
});

void test("inspection verifies hashed finite references without converting declarations into approval", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "delivery-inspection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "review Ω.txt");
  writeFileSync(file, "retained reviewer output Ω\n");
  const reference = {
    path: file,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
  const declaration = {
    format_version: 1,
    pull_request: 7,
    review: { head, target: base, result: "clear", reference },
    acceptance: { head, result: "passed", reference },
    watcher: { head, run: 42, attempt: 1, deadline: "2026-10-19T00:00:00Z", reference },
  };
  const inspect = (
    value = declaration,
    options: Parameters<typeof inspectionClient>[0] = {},
    now = Date.parse("2026-10-18T00:00:00Z"),
  ) =>
    inspectDelivery(inspectionClient(options).client, {
      ...inspectOptions,
      references: parseInspectionReferences(JSON.stringify(value), 7),
      now: () => now,
    });
  const valid = await inspect();
  assert.equal(valid.review.state, "referenced");
  assert.equal(valid.acceptance.result, "passed");
  assert.equal(valid.watcher.state, "referenced");
  assert.match(valid.next_action, /Verify current authority/);
  assert.match(valid.boundary, /no approval/);
  assert.match((await inspect(declaration, { checks: [] })).next_action, /Continue the existing/);
  assert.match(
    (
      await inspect(declaration, {
        checks: [],
        workflow: { status: "completed", conclusion: "failure" },
      })
    ).next_action,
    /terminal workflow.*cannot resume/,
  );
  for (const [options, now] of [
    [{ checks: [], workflow: { run_attempt: 2 } }, Date.parse("2026-10-18T00:00:00Z")],
    [{ checks: [] }, Date.parse(declaration.watcher.deadline)],
  ] as const) {
    const result = await inspect(declaration, { ...options, checks: [] }, now);
    assert.equal(result.watcher.state, "unknown");
    assert.match(result.next_action, /do not resume a stale wait or renew/);
  }
  for (const workflow of [
    { status: "in_progress", conclusion: "success" },
    { status: "completed", conclusion: null },
    { status: "completed", conclusion: "made-up" },
  ])
    await assert.rejects(
      inspect(declaration, { workflow }),
      (error) => deliveryError(error).operationStatus === "unknown",
    );
  for (const result of [["clear"], { value: "clear" }])
    assert.throws(() =>
      parseInspectionReferences(
        JSON.stringify({ ...declaration, review: { ...declaration.review, result } }),
        7,
      ),
    );
  for (const result of [["passed"], { value: "passed" }])
    assert.throws(() =>
      parseInspectionReferences(
        JSON.stringify({ ...declaration, acceptance: { ...declaration.acceptance, result } }),
        7,
      ),
    );
  assert.equal(
    (await inspect({ ...declaration, review: { ...declaration.review, target: merge } })).review
      .reason,
    "target-changed",
  );
  assert.equal(
    (await inspect(declaration, { pull: { head: { sha: merge } } })).acceptance.reason,
    "source-changed",
  );
  assert.equal(
    (await inspect(declaration, { workflow: { run_attempt: 2 } })).watcher.reason,
    "watcher-stale",
  );
  assert.equal(
    (await inspect(declaration, {}, Date.parse(declaration.watcher.deadline))).watcher.reason,
    "watcher-stale",
  );
  writeFileSync(file, "corrupt");
  assert.equal((await inspect()).review.reason, "reference-unavailable-or-corrupt");
  assert.match(
    (await inspect(declaration, { checks: [] })).next_action,
    /do not resume a stale wait or renew/,
  );
  rmSync(file);
  assert.equal((await inspect()).acceptance.state, "unknown");
});

void test("inspection declaration schema and full CLI serialization include UTF-8 newline in bounds", async () => {
  for (const text of [
    "{}",
    JSON.stringify({ format_version: 1, pull_request: 8 }),
    "Ω".repeat(4097),
    JSON.stringify({ format_version: 1, pull_request: 7, approval: true }),
  ])
    assert.throws(() => parseInspectionReferences(text, 7));
  const inspection = await inspectDelivery(inspectionClient().client, inspectOptions);
  const moduleUrl = new URL("./pr-delivery.mts", import.meta.url).href;
  for (const json of [true, false]) {
    const result = spawnHelp(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { renderDeliveryInspection } from ${JSON.stringify(moduleUrl)}; console.log(renderDeliveryInspection(JSON.parse(process.argv[1]),${json}));`,
        JSON.stringify(inspection),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) <= 16384);
    assert.ok(result.stdout.endsWith("\n"));
    if (json) assert.equal(record(JSON.parse(result.stdout)).observation, "complete");
  }
  const oversized = { ...inspection, target: { ...inspection.target, ref: "Ω".repeat(8192) } };
  assert.throws(() => renderDeliveryInspection(oversized, true), /including newline/);
  const bounded = { ...inspection, boundary: "" };
  const remaining = 16384 - Buffer.byteLength(JSON.stringify(bounded)) - 1;
  bounded.boundary = "Ω".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  const serializer = `import { renderDeliveryInspection } from ${JSON.stringify(moduleUrl)}; console.log(renderDeliveryInspection(JSON.parse(process.argv[1]),true));`;
  const nearLimit = spawnHelp(
    process.execPath,
    ["--input-type=module", "-e", serializer, JSON.stringify(bounded)],
    { encoding: "utf8" },
  );
  assert.equal(nearLimit.status, 0, nearLimit.stderr);
  assert.equal(Buffer.byteLength(nearLimit.stdout), 16384);
  const beyondLimit = spawnHelp(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      serializer,
      JSON.stringify({ ...bounded, boundary: bounded.boundary + "x" }),
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(beyondLimit.status, 0);
  assert.equal(beyondLimit.stdout, "");
  assert.match(beyondLimit.stderr, /including newline/);
  const cli = new URL("./pr-delivery.mts", import.meta.url);
  const help = spawnHelp(process.execPath, [fileURLToPath(cli), "inspect", "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--evidence-file/);
  const incompatible = spawnHelp(
    process.execPath,
    [fileURLToPath(cli), "inspect", "--json", "--summary"],
    { encoding: "utf8" },
  );
  assert.equal(incompatible.status, 1);
  assert.match(incompatible.stderr, /mutually exclusive/);
});

void test("queue exposes age uncertainty without changing the pending-status gate", () => {
  const statuses = [
    {
      context: "renovate/stability-days",
      state: "pending",
      description: "Updates have not met minimum release age requirement",
    },
  ];
  const queue = inspectRenovateQueue(queueClient({ statuses }), queueConfig, required, queueBase);
  const candidate = requiredFixture(queue.candidates[0]);
  assert.equal(candidate.release_age_diagnosis.classification, "pending-unexplained");
  assert.deepEqual(candidate.release_age, statuses);
  assert.equal(candidate.actionable, false);
  assert.equal(queue.selected, null);
  assert.match(candidate.next_action, /hosted lookup\/branch inputs/);
  assert.equal(inspectRenovateQueue(queueClient(), queueConfig, required, queueBase).selected, 7);
});

void test("watch REST collection resolves complete replay lineage without hiding raw observations", async () => {
  const old: DeliveryJob[] = workflowJobs();
  const newer: DeliveryJob = {
    ...old[0]!,
    id: 100,
    run_attempt: 2,
    check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/100",
  };
  const jobs = [...old, newer];
  const checks = jobs.map((job) => ({
    id: Number(job.check_run_url!.split("/").at(-1)),
    name: job.name,
    head_sha: head,
    status: job.status,
    conclusion: job.conclusion,
  }));
  let runState = workflow({ run_attempt: 2, status: "completed", conclusion: "success" });
  const client = new PullRequestDeliveryClient((args) => {
    const endpoint = requiredFixture(args[2]);
    if (endpoint === "repos/boburning/portcove/pulls/7") return included(pull());
    if (endpoint === "repos/boburning/portcove/actions/runs/42")
      return included({ ...runState, repository: { full_name: "boburning/portcove" } });
    if (endpoint.includes("/jobs?")) return included({ total_count: jobs.length, jobs });
    if (endpoint.includes("/check-runs?")) {
      assert.match(endpoint, /filter=all/);
      return included({ total_count: checks.length, check_runs: checks });
    }
    if (endpoint.includes("/status?")) return included({ total_count: 0, statuses: [] });
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  const observations: import("./pr-delivery.mts").WatchObservation[] = [];
  const result = await watchRequiredChecks(client, {
    ...watchOptions,
    attempt: 2,
    observe: (observation) => observations.push(observation),
  });
  assert.equal(result.contexts[0]!.check_run_id, 100);
  const raw = record(observations[0]);
  assert.equal(array(raw.jobs).length, 6);
  assert.equal(array(record(array(raw.contexts)[0]).observations).length, 2);
  assert.equal(
    client.requiredCheckState(7, head, required).contexts[0]!.conclusion,
    "ambiguous",
    "unbound live route must still refuse duplicate observations",
  );
  for (const status of ["invented", "in_progress"]) {
    old[0]!.status = checks[0]!.status = status;
    old[0]!.conclusion = status === "invented" ? null : "success";
    checks[0]!.conclusion = old[0]!.conclusion;
    await assert.rejects(
      watchRequiredChecks(client, { ...watchOptions, attempt: 2 }),
      /incomplete or contradictory/,
    );
  }
  old[0]!.status = checks[0]!.status = "completed";
  old[0]!.conclusion = checks[0]!.conclusion = "success";
  for (const conclusion of ["failure", "cancelled"]) {
    newer.conclusion = checks.at(-1)!.conclusion = conclusion;
    await assert.rejects(
      watchRequiredChecks(client, { ...watchOptions, attempt: 2 }),
      /required checks failed/,
    );
  }
  newer.status = checks.at(-1)!.status = "in_progress";
  newer.conclusion = checks.at(-1)!.conclusion = null;
  runState = workflow({ run_attempt: 2 });
  await assert.rejects(
    watchRequiredChecks(client, {
      ...watchOptions,
      attempt: 2,
      now: () => Date.parse(watchOptions.deadline),
    }),
    /timed out/,
  );
  newer.status = checks.at(-1)!.status = "completed";
  newer.conclusion = checks.at(-1)!.conclusion = "success";
  newer.run_id = 99;
  await assert.rejects(
    watchRequiredChecks(client, { ...watchOptions, attempt: 2 }),
    /invalid or duplicate/,
  );
});
