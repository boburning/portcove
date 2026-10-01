import assert from "node:assert/strict";
import test from "node:test";
import {
  PullRequestDeliveryClient,
  parseArguments,
  parsePullRequestReference,
  renovateCheckEnvelope,
  requiredCheckContexts,
  requiredContextsFromConfigs,
  watchRequiredChecks,
} from "./pr-delivery.mjs";

const required = ["catalog", "dependency-review", "frontend", "rust", "rust-quality"];
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);

function included(body, headers = {}) {
  return (
    "HTTP/2.0 200 OK\r\n" +
    Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("") +
    `\r\n${JSON.stringify(body)}`
  );
}

function pull(overrides = {}) {
  return {
    number: 7,
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

test("required contexts are loaded from both checked-in authorities", () => {
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

test("pull request references are repository-bound and exact", () => {
  assert.equal(parsePullRequestReference("7"), 7);
  assert.equal(parsePullRequestReference("https://github.com/boburning/portcove/pull/7"), 7);
  for (const value of ["0", "#7", "https://github.com/other/repo/pull/7"])
    assert.throws(() => parsePullRequestReference(value), /invalid/);
});

test("delivery arguments accept opt-in JSON without changing required values", () => {
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

test("Renovate verdicts have matching human and JSON output", () => {
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
  assert.equal(JSON.parse(JSON.stringify(output)).evidence.head, head);
});

test("check-run pagination requires complete unique totals", () => {
  const calls = [];
  const client = new PullRequestDeliveryClient((args) => {
    calls.push(args[2]);
    if (args[2].includes("page=2"))
      return included({ total_count: 2, check_runs: [{ id: 2, name: "two" }] });
    return included(
      { total_count: 2, check_runs: [{ id: 1, name: "one" }] },
      { link: '<https://api.github.test/checks?page=2>; rel="next"' },
    );
  });
  assert.deepEqual(
    client.checkRuns(head).map((run) => run.id),
    [1, 2],
  );
  assert.equal(calls.length, 2);
});

test("Renovate snapshot inventories every commit and file page exactly once", () => {
  const calls = [];
  const client = new PullRequestDeliveryClient((args) => {
    const endpoint = args[2];
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

test("Renovate snapshot rejects incomplete commit and file inventories", () => {
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

test("required context reduction fails closed on missing and duplicate producers", () => {
  const successful = requiredCheckContexts(successfulRuns(), [], required);
  assert.ok(successful.every((context) => context.outcome === "success"));
  const missing = requiredCheckContexts(successfulRuns().slice(1), [], required);
  assert.equal(missing[0].conclusion, "missing");
  const duplicate = requiredCheckContexts(
    successfulRuns(),
    [{ id: 99, context: "rust", state: "success", target_url: "https://github.test/status" }],
    required,
  );
  assert.equal(duplicate.find((context) => context.context === "rust").conclusion, "ambiguous");
});

test("required check observation is exact-head and fails closed on ambiguity", () => {
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
    client.requiredCheckState(7, head, required).contexts.find((item) => item.context === "rust")
      .conclusion,
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
function workflow(overrides = {}) {
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
function checkState(outcome = "pending") {
  return {
    contexts: required.map((context) => ({
      context,
      outcome,
      conclusion: outcome === "pending" ? "missing" : outcome,
    })),
  };
}

test("watcher waits quietly on one run and requires both terminal success and exact-head gates", async () => {
  let calls = 0;
  const pauses = [];
  const pendingThenSuccess = {
    workflowRun(id) {
      assert.equal(id, 42);
      return workflow(calls === 1 ? { status: "completed", conclusion: "success" } : {});
    },
    requiredCheckState() {
      calls += 1;
      return {
        contexts: required.map((context) => ({
          context,
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
  assert.equal(state.watch.workflow.created_at, "2026-10-01T20:55:00Z");
  assert.equal(state.watch.workflow.run_started_at, "2026-10-01T21:00:00Z");

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

test("resuming an expired deadline reads evidence once and never creates another wait", async () => {
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
        assert.match(error.message, /timed out/);
        assert.equal(error.operationEvidence.run, 42);
        assert.equal(error.operationEvidence.attempt, 1);
        assert.equal(error.operationEvidence.deadline, watchOptions.deadline);
        assert.equal(error.operationEvidence.contexts.length, required.length);
        assert.match(error.operationEvidence.next_action, /artifacts/);
        return true;
      },
    );
    assert.equal(reads, 1);
  }
});

test("watcher caps its final sleep to the retained deadline", async () => {
  let current = Date.parse(watchOptions.deadline) - 2500;
  const pauses = [];
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

test("watcher stops on replacement identity, failed workflow, absent gates or monitoring failure", async () => {
  for (const [runState, pattern] of [
    [{ head_sha: base }, /run\/source\/attempt changed/],
    [{ run_attempt: 2 }, /run\/source\/attempt changed/],
    [{ status: "unknown" }, /status is missing or unknown/],
    [{ created_at: "unknown" }, /creation time/],
    [{ status: "completed", conclusion: "failure" }, /completed with failure/],
    [{ status: "completed", conclusion: "cancelled" }, /completed with cancelled/],
    [{ status: "completed", conclusion: null }, /no conclusion/],
    [{ status: "completed", conclusion: "success" }, /gates remain missing/],
  ])
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
      {
        workflowRun: () => {
          throw new Error("403 readback unavailable");
        },
      },
      watchOptions,
    ),
    (error) => {
      assert.match(error.message, /monitoring failed/);
      assert.equal(error.operationEvidence.head, head);
      return true;
    },
  );
});

test("watcher rejects missing identity/deadline before querying and does not accept old green gates while the run is pending", async () => {
  const client = { workflowRun: () => assert.fail("invalid options must stop before API access") };
  for (const overrides of [
    { run: 0 },
    { attempt: 0 },
    { deadline: undefined },
    { deadline: "in one hour" },
    { deadline: "2026-02-30T22:00:00Z" },
    { deadline: "2026-10-01T22:00:00+00:00" },
  ])
    await assert.rejects(watchRequiredChecks(client, { ...watchOptions, ...overrides }));
  await assert.rejects(
    watchRequiredChecks(
      { workflowRun: () => workflow(), requiredCheckState: () => checkState("success") },
      { ...watchOptions, now: () => Date.parse(watchOptions.deadline) },
    ),
    /timed out/,
  );
});

test("workflow REST readback validates repository and opaque run identity", () => {
  let body = { ...workflow(), repository: { full_name: "boburning/portcove" } };
  const client = new PullRequestDeliveryClient((args) => {
    assert.equal(args[2], "repos/boburning/portcove/actions/runs/42");
    return included(body);
  });
  assert.equal(client.workflowRun(42).id, 42);
  body = { ...body, id: 43 };
  assert.throws(() => client.workflowRun(42), /identity/);
  body = { ...body, id: 42, repository: { full_name: "other/portcove" } };
  assert.throws(() => client.workflowRun(42), /identity/);
});

test("REST merge uses the exact SHA and verifies remote completion", () => {
  const calls = [];
  let merged = false;
  const client = new PullRequestDeliveryClient((args, input) => {
    const method = args[4];
    const endpoint = args[2];
    calls.push({ method, endpoint, input });
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
      assert.deepEqual(JSON.parse(input), { merge_method: "squash", sha: head });
      return included({ merged: true, sha: merge, message: "Pull Request successfully merged" });
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  const result = client.merge(7, head, required);
  assert.equal(result.result.sha, merge);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
  assert.equal(
    calls.some((call) => call.endpoint === "graphql"),
    false,
  );
});

test("merge command errors are reconciled through remote readback before retry", () => {
  let merged = false;
  const client = new PullRequestDeliveryClient((args) => {
    const endpoint = args[2];
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
  const result = client.merge(7, head, required);
  assert.equal(result.result.sha, merge);
  assert.match(result.result.message, /readback confirmed/);
});

test("merge reports unknown when mutation and remote readback are both ambiguous", () => {
  const client = new PullRequestDeliveryClient();
  client.requiredCheckState = () => ({
    pull: pull(),
    contexts: required.map((context) => ({ context, outcome: "success", conclusion: "success" })),
  });
  client.request = () => {
    throw new Error("connection closed");
  };
  client.pull = () => {
    throw new Error("readback unavailable");
  };
  assert.throws(
    () => client.merge(7, head, required),
    (error) =>
      error.operationStatus === "unknown" &&
      error.operationEvidence.pull_request === 7 &&
      /outcome is unknown/.test(error.message),
  );
});

test("merge refuses draft conflict and incomplete-check states before mutation", () => {
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
