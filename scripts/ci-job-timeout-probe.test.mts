import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDocument } from "yaml";
import { isRecord } from "./runtime-values.mts";
import { timeoutProbeContext, verifyJobTimeoutProbe } from "./ci-job-timeout-probe.mts";

const context = { source: "a".repeat(40), run: "123", attempt: "2" };
const ready = {
  format_version: 1,
  ...context,
  checkout: context.source,
  platform: "linux",
  node: `v${readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim()}`,
  nonce: "00000000-0000-4000-8000-000000000000",
  job_limit_minutes: 5,
  processes: [
    { pid: 11, identity: "linux:11:100" },
    { pid: 12, identity: "linux:12:101" },
  ],
};
const drained = {
  ...ready,
  status: 130,
  quiescent: true,
  ready_sha256: createHash("sha256").update(JSON.stringify(ready)).digest("hex"),
};
const log = (first: unknown = ready, last: unknown = drained) =>
  `2026-10-25T12:00:01Z CI timeout custody ready: ${JSON.stringify(first)}\n2026-10-25T12:05:00Z CI timeout custody drained: ${JSON.stringify(last)}\n`;
const steps = ["Install pinned Node", "Install pinned Rust", "Run controlled payload"].map(
  (name, index) => ({
    name,
    number: index + 1,
    status: "completed",
    conclusion: index === 2 ? "cancelled" : "success",
  }),
);
const probe = {
  id: 1,
  name: "controlled-job-timeout",
  head_sha: context.source,
  run_id: 123,
  run_attempt: 2,
  status: "completed",
  conclusion: "timed_out",
  started_at: "2026-10-25T12:00:00Z",
  completed_at: "2026-10-25T12:05:00Z",
  steps,
};
const jobs = {
  total_count: 2,
  jobs: [
    probe,
    {
      id: 2,
      name: "verify-job-timeout",
      head_sha: context.source,
      run_id: 123,
      run_attempt: 2,
      status: "in_progress",
      conclusion: null,
    },
  ] as const,
};

void test("timeout observation keeps the original timed-out outcome and separate cleanup proof", () => {
  const observed = verifyJobTimeoutProbe(jobs, log(), context);
  assert.equal(observed.job_outcome, "timed_out");
  assert.equal(observed.quiescent, true);
  assert.equal(observed.processes, 2);
  assert.equal(
    verifyJobTimeoutProbe(jobs, log(ready, { ...drained, status: 143 }), context).supervised_status,
    143,
  );
});

void test("timeout job inventory refuses omissions, duplicates, stale contexts and early failures", () => {
  for (const value of [
    null,
    {},
    { ...jobs, total_count: 1 },
    { ...jobs, total_count: 100 },
    { ...jobs, jobs: jobs.jobs.slice(1) },
  ])
    assert.throws(() => verifyJobTimeoutProbe(value, log(), context));
  for (const patch of [
    { id: 2 },
    { name: "verify-job-timeout" },
    { head_sha: "b".repeat(40) },
    { run_id: 124 },
    { run_attempt: 1 },
    { run_attempt: undefined },
    { status: "in_progress" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { completed_at: "2026-10-25T12:00:10Z" },
    { completed_at: "2026-10-25T12:10:00Z" },
  ])
    assert.throws(() =>
      verifyJobTimeoutProbe(
        { ...jobs, jobs: [{ ...probe, ...patch }, jobs.jobs[1]] },
        log(),
        context,
      ),
    );
  for (const index of [0, 1, 2])
    for (const conclusion of ["skipped", "failure", index === 2 ? "success" : "cancelled"]) {
      const changed = structuredClone(jobs);
      changed.jobs[0].steps[index]!.conclusion = conclusion;
      assert.throws(() => verifyJobTimeoutProbe(changed, log(), context));
    }
  const missing = structuredClone(jobs);
  missing.jobs[0].steps.pop();
  assert.throws(() => verifyJobTimeoutProbe(missing, log(), context));
});

void test("timeout logs refuse absent, duplicate, mismatched or incomplete process drain evidence", () => {
  for (const value of ["", log().split("\n")[0]!, log() + log(), "x".repeat(8 * 1024 * 1024 + 1)])
    assert.throws(() => verifyJobTimeoutProbe(jobs, value, context));
  for (const patch of [
    { source: "b".repeat(40) },
    { checkout: "b".repeat(40) },
    { run: "124" },
    { attempt: "1" },
    { platform: "win32" },
    { node: "v0.0.0" },
    { format_version: 2 },
    { job_limit_minutes: 360 },
    { nonce: "foreign" },
    { processes: [] },
    { processes: [ready.processes[0], ready.processes[0]] },
    { processes: [{ pid: 11, identity: "" }, ready.processes[1]] },
  ])
    assert.throws(() => verifyJobTimeoutProbe(jobs, log({ ...ready, ...patch }), context));
  for (const patch of [
    { status: 0 },
    { quiescent: false },
    { nonce: "10000000-0000-4000-8000-000000000000" },
    { processes: [] },
    { ready_sha256: "0".repeat(64) },
  ])
    assert.throws(() => verifyJobTimeoutProbe(jobs, log(ready, { ...drained, ...patch }), context));
});

void test("manual timeout rehearsal retains finite budgets, normal failure and independent read-only verification", () => {
  const document = parseDocument(
    readFileSync(
      new URL("../.github/workflows/job-timeout-rehearsal.yml", import.meta.url),
      "utf8",
    ),
    { uniqueKeys: true },
  );
  assert.deepEqual(document.errors, []);
  const value: unknown = document.toJS();
  assert.ok(isRecord(value) && isRecord(value.on) && isRecord(value.jobs));
  assert.deepEqual(Object.keys(value.on), ["workflow_dispatch"]);
  assert.deepEqual(value.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(value.jobs), ["probe", "verify"]);
  const probe = value.jobs.probe,
    verify = value.jobs.verify;
  assert.ok(
    isRecord(probe) &&
      Array.isArray(probe.steps) &&
      isRecord(verify) &&
      Array.isArray(verify.steps),
  );
  assert.equal(probe["timeout-minutes"], 5);
  assert.equal(verify["timeout-minutes"], 5);
  assert.equal(probe["continue-on-error"], undefined);
  assert.equal(verify["continue-on-error"], undefined);
  assert.equal(probe.steps.length, 4);
  assert.ok(
    probe.steps.every(
      (step: unknown) =>
        isRecord(step) &&
        step["continue-on-error"] === undefined &&
        step["timeout-minutes"] === undefined,
    ),
  );
  assert.deepEqual(
    probe.steps.map((step: unknown) => (isRecord(step) ? step.name : null)),
    ["Checkout", "Install pinned Node", "Install pinned Rust", "Run controlled payload"],
  );
  const node: unknown = probe.steps[1],
    rust: unknown = probe.steps[2];
  assert.ok(isRecord(node) && isRecord(rust));
  assert.equal(node.uses, "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1");
  assert.deepEqual(node.with, { "node-version-file": ".node-version" });
  assert.equal(rust.uses, "./.github/actions/setup-rust");
  const run: unknown = probe.steps[3];
  assert.ok(isRecord(run));
  assert.equal(run.run, "node scripts/ci-job-timeout-probe.mts run");
  assert.equal(verify.needs, "probe");
  assert.equal(verify.if, "always()");
  assert.deepEqual(verify.permissions, { contents: "read", actions: "read" });
  const final: unknown = verify.steps[2];
  assert.ok(isRecord(final) && typeof final.run === "string");
  assert.match(final.run, /attempts\/\$GITHUB_RUN_ATTEMPT\/jobs\?per_page=100/u);
  assert.match(final.run, /ci-job-timeout-probe\.mts verify/u);
});

void test("timeout context refuses missing or malformed source/run/attempt", () => {
  const environment = {
    GITHUB_SHA: context.source,
    GITHUB_RUN_ID: context.run,
    GITHUB_RUN_ATTEMPT: context.attempt,
  };
  assert.deepEqual(timeoutProbeContext(environment), context);
  for (const key of Object.keys(environment))
    for (const invalid of ["", "0", "bad value"])
      assert.throws(() => timeoutProbeContext({ ...environment, [key]: invalid }));
});
