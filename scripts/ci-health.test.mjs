import assert from "node:assert/strict";
import test from "node:test";
import { collectHistory, renderReport, summarizeAttempt, summarizeHistory } from "./ci-health.mjs";

const stamp = seconds => new Date(Date.UTC(2026, 8, 7) + seconds * 1000).toISOString();
const run = overrides => ({ id: 1, run_attempt: 1, head_sha: "a".repeat(40), event: "push", head_branch: "main",
  status: "completed", conclusion: "success", created_at: stamp(0), run_started_at: stamp(5),
  updated_at: stamp(240), html_url: "https://github.com/example/repo/actions/runs/1", ...overrides });
const job = overrides => ({ name: "rust", status: "completed", conclusion: "success",
  started_at: stamp(10), completed_at: stamp(235), steps: [], ...overrides });
const attempt = overrides => summarizeAttempt(run(overrides), [job()]);

test("first attempts include initial queue time and reruns use their own start", () => {
  assert.equal(attempt().seconds, 240);
  assert.equal(attempt({ run_attempt: 2, run_started_at: stamp(3_600), updated_at: stamp(3_800) }).seconds, 200);
  assert.equal(attempt({ status: "in_progress", conclusion: null }).seconds, null);
});

test("missing or backwards timing is unavailable rather than a zero-duration success", () => {
  for (const updated_at of [null, undefined, "not a timestamp", stamp(-1)]) {
    const result = attempt({ updated_at });
    assert.equal(result.seconds, null);
    assert.equal(summarizeHistory([result]).successfulFirstAttempts.count, 0);
    assert.equal(summarizeHistory([result]).missingCompletedTimings, 1);
  }
});

test("cancelled, failed and running attempts remain visible outside successful percentiles", () => {
  const summary = summarizeHistory([attempt(), attempt({ id: 2, conclusion: "cancelled" }),
    attempt({ id: 3, conclusion: "failure" }), attempt({ id: 4, status: "in_progress", conclusion: null })]);
  assert.equal(summary.runs, 4);
  assert.equal(summary.successfulFirstAttempts.count, 1);
  assert.deepEqual(summary.outcomes, { success: 1, cancelled: 1, failure: 1, in_progress: 1 });
});

test("rerun recovery retains the failed jobs and requires the same run and commit", () => {
  const failed = summarizeAttempt(run({ conclusion: "failure" }), [job({ name: "native Intel", conclusion: "timed_out" })]);
  const passed = attempt({ run_attempt: 2 });
  assert.deepEqual(summarizeHistory([failed, passed]).rerunRecoveries, [{ runId: 1, sha: "a".repeat(40),
    failedAttempt: 1, passedAttempt: 2, failedJobs: ["native Intel"], url: failed.url }]);
  for (const changed of [{ id: 2 }, { head_sha: "b".repeat(40) }, { run_attempt: 1 }]) {
    assert.equal(summarizeHistory([failed, attempt({ run_attempt: 2, ...changed })]).rerunRecoveries.length, 0);
  }
  assert.equal(summarizeHistory([attempt({ conclusion: "cancelled" }), passed]).rerunRecoveries.length, 0);
  const cancelledWithFailure = summarizeAttempt(run({ conclusion: "cancelled" }), [job({ conclusion: "failure" })]);
  assert.equal(summarizeHistory([cancelledWithFailure, passed]).rerunRecoveries.length, 1);
});

test("percentiles separate first attempts from reruns and require twenty tail samples", () => {
  const first = Array.from({ length: 20 }, (_, index) => attempt({ id: index + 1, updated_at: stamp(index + 1) }));
  const summary = summarizeHistory([...first, attempt({ run_attempt: 2, run_started_at: stamp(0), updated_at: stamp(999) })]);
  assert.deepEqual(summary.successfulFirstAttempts, { count: 20, p50Seconds: 10, p95Seconds: 19, maxSeconds: 20 });
  assert.equal(summary.successfulReruns.p50Seconds, 999);
  assert.equal(summary.successfulReruns.p95Seconds, null);
  assert.equal(summarizeHistory(first.slice(0, 19)).successfulFirstAttempts.p95Seconds, null);
});

test("job and step timings preserve setup costs but do not measure skipped jobs", () => {
  const result = summarizeAttempt(run(), [job({ steps: [
    { name: "build", status: "completed", started_at: stamp(20), completed_at: stamp(100) },
    { name: "restore", status: "completed", started_at: stamp(10), completed_at: stamp(20) },
  ] }), job({ name: "dependency-review", conclusion: "skipped" })]);
  assert.equal(result.jobs[0].seconds, 225);
  assert.equal(result.jobs[0].steps[0].name, "build");
  assert.equal(result.jobs[1].seconds, null);
  assert.deepEqual(summarizeHistory([result]).slowestJobs.map(item => item.name), ["rust"]);
});

test("collector retrieves failed earlier attempts and every job page", async () => {
  const calls = [];
  const request = async (route, paginate) => {
    calls.push({ route, paginate });
    if (route.includes("/workflows/")) return { workflow_runs: [{ id: 1, run_attempt: 2 }] };
    const number = Number(route.match(/attempts\/(\d+)/)[1]);
    if (route.includes("/jobs?")) {
      assert.equal(paginate, true);
      return [{ total_count: 2, jobs: [job()] }, { total_count: 2, jobs: [job({ name: "frontend" })] }];
    }
    return run({ run_attempt: number, conclusion: number === 1 ? "failure" : "success" });
  };
  const report = await collectHistory(request, { repository: "example/repo", branch: "feature/test", event: "pull_request", limit: 2 });
  assert.equal(report.attempts.length, 2);
  assert.equal(report.attempts[0].conclusion, "failure");
  assert.equal(report.attempts[0].jobs.length, 2);
  assert.match(calls[0].route, /branch=feature%2Ftest&event=pull_request&per_page=2/);
});

test("collector rejects incomplete job inventories and API failures", async () => {
  const request = async route => route.includes("/workflows/") ? { workflow_runs: [{ id: 1, run_attempt: 1 }] }
    : route.includes("/jobs?") ? [{ total_count: 2, jobs: [job()] }] : run();
  await assert.rejects(collectHistory(request, { repository: "example/repo", branch: "main", event: "push", limit: 1 }), /Incomplete jobs/);
  await assert.rejects(collectHistory(async () => { throw new Error("API unavailable"); }, {}), /API unavailable/);
});

test("date cutoff keeps all attempts of eligible runs without mixing an older workflow", async () => {
  const request = async route => {
    if (route.includes("/workflows/")) return { workflow_runs: [
      { id: 1, run_attempt: 1, created_at: stamp(10) }, { id: 2, run_attempt: 1, created_at: stamp(0) },
    ] };
    assert.doesNotMatch(route, /runs\/2\//);
    return route.includes("/jobs?") ? [{ total_count: 1, jobs: [job()] }] : run();
  };
  const report = await collectHistory(request, { repository: "example/repo", branch: "main", event: "push", limit: 2, since: stamp(5) });
  assert.equal(report.summary.runs, 1);
  assert.equal(report.since, stamp(5));
});

test("report makes sample and cache limitations explicit and includes investigation links", () => {
  const attempts = [attempt({ conclusion: "failure" }), attempt({ run_attempt: 2 })];
  const text = renderReport({ repository: "example/repo", branch: "main", event: "push",
    generatedAt: stamp(300), attempts, summary: summarizeHistory(attempts) });
  assert.match(text, /1 runs, 2 attempts/);
  assert.match(text, /Cache state is unclassified/);
  assert.match(text, /not a measured flake rate/);
  assert.match(text, /actions\/runs\/1\/attempts\/1/);
  assert.match(text, /First attempts \| 0 \| unavailable/);
});
