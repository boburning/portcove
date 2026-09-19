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
    parseArguments(["watch", "--pr", "7", "--json", "--head", head, "--timeout-seconds", "30"]),
    {
      command: "watch",
      options: { "--pr": "7", "--json": true, "--head": head, "--timeout-seconds": "30" },
    },
  );
  assert.deepEqual(parseArguments(["renovate-check", "--pr", "7", "--head", head]), {
    command: "renovate-check",
    options: { "--pr": "7", "--head": head },
  });
  assert.throws(() => parseArguments(["merge", "--pr", "7", "--head"]), /invalid argument/);
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

test("watcher waits for missing checks and fails on every non-success terminal result", async () => {
  let calls = 0;
  const pendingThenSuccess = {
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
    number: 7,
    head,
    requiredContexts: required,
    timeoutSeconds: 1,
    intervalSeconds: 0,
    sleep: async () => {},
  });
  assert.ok(state.contexts.every((context) => context.outcome === "success"));

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
          requiredCheckState: () => ({
            contexts: [{ context: "rust", outcome: "failure", conclusion }],
          }),
        },
        { number: 7, head, requiredContexts: ["rust"], timeoutSeconds: 1 },
      ),
      new RegExp(conclusion),
    );
  }
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
