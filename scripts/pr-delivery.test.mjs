import assert from "node:assert/strict";
import test from "node:test";
import {
  PullRequestDeliveryClient,
  parsePullRequestReference,
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
