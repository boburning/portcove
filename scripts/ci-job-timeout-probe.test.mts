import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import { Octokit } from "@octokit/core";
import { collectWorkflowJobEvidence } from "./workflow-job-evidence.mts";
import { isRecord } from "./runtime-values.mts";
import {
  timeoutProbeContext,
  verifyJobTimeoutProbe as verifyProbe,
  type TimeoutProbeContext,
} from "./ci-job-timeout-probe.mts";

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
  check_run_url: "https://api.github.com/repos/boburning/portcove/check-runs/11",
  run_id: 123,
  run_attempt: 2,
  status: "completed",
  conclusion: "timed_out",
  started_at: "2026-10-25T12:00:00Z",
  completed_at: "2026-10-25T12:05:00Z",
  steps,
};

const timeoutMetadata = {
  check: {
    id: 11,
    url: probe.check_run_url,
    head_sha: context.source,
    status: "completed",
    conclusion: "timed_out",
    output: { annotations_count: 1 },
  },
  annotations: [
    {
      annotation_level: "failure",
      message: "The job has exceeded the maximum execution time of 5m0s",
    },
  ],
};
const verifyJobTimeoutProbe = (
  jobs: unknown,
  log: string,
  context: TimeoutProbeContext,
  metadata: unknown = timeoutMetadata,
) => verifyProbe(jobs, log, context, metadata);
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

void test("runner cancellation requires the exact complete job-timeout annotation", () => {
  const cancelled = { ...jobs, jobs: [{ ...probe, conclusion: "cancelled" }, jobs.jobs[1]] };
  const metadata = {
    ...timeoutMetadata,
    check: { ...timeoutMetadata.check, conclusion: "cancelled" },
  };
  assert.equal(verifyJobTimeoutProbe(cancelled, log(), context, metadata).job_outcome, "cancelled");
  for (const annotations of [
    [],
    [{ annotation_level: "failure", message: "The operation was canceled." }],
    [...timeoutMetadata.annotations, ...timeoutMetadata.annotations],
  ])
    assert.throws(() =>
      verifyJobTimeoutProbe(cancelled, log(), context, {
        ...metadata,
        annotations,
        check: { ...metadata.check, output: { annotations_count: annotations.length } },
      }),
    );
  for (const patch of [
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { conclusion: "success" },
    { id: 12 },
    { url: "https://api.github.com/repos/other/repo/check-runs/11" },
    { output: { annotations_count: 2 } },
  ])
    assert.throws(() =>
      verifyJobTimeoutProbe(cancelled, log(), context, {
        ...metadata,
        check: { ...metadata.check, ...patch },
      }),
    );
  for (const value of [null, {}, { check: metadata.check, annotations: "missing" }])
    assert.throws(() => verifyJobTimeoutProbe(cancelled, log(), context, value));
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
    { conclusion: "success" },
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
  assert.equal(run.run, "exec node scripts/ci-job-timeout-probe.mts run");
  assert.equal(verify.needs, "probe");
  assert.equal(verify.if, "always()");
  assert.deepEqual(verify.permissions, { contents: "read", actions: "read", checks: "read" });
  const final: unknown = verify.steps.at(-1);
  assert.ok(isRecord(final) && typeof final.run === "string");
  assert.match(final.run, /ci-job-timeout-probe\.mts verify/u);
  for (const name of [
    "timeout-jobs.json",
    "timeout-job.log",
    "timeout-check.json",
    "timeout-annotations.json",
  ])
    assert.ok(final.run.includes(`"$RUNNER_TEMP/${name}"`));
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

const api = "https://api.github.com/repos/boburning/portcove";
const jobsRoute = api + "/actions/runs/21/attempts/1/jobs?per_page=100";
const logsRoute = api + "/actions/jobs/31/logs";
const checkRoute = api + "/check-runs/41";
const annotationsRoute = checkRoute + "/annotations?per_page=100";
const signed =
  "https://productionresultssa31.blob.core.windows.net/actions-results/fixed/logs/job/test?sig=inert";
const revision = "b".repeat(40);
const workflowJobs = {
  total_count: 2,
  jobs: [
    {
      id: 31,
      name: "controlled-job-timeout",
      run_id: 21,
      run_attempt: 1,
      head_sha: revision,
      check_run_url: checkRoute,
    },
    { id: 32, name: "verify-job-timeout", run_id: 21, run_attempt: 1, head_sha: revision },
  ],
};

for (const [workflow, mode] of [
  ["browser-artifact-custody", "browser"],
  ["job-timeout-rehearsal", "timeout"],
] as const)
  void test(`workflow ${mode} uses the reviewed github-script distribution without script interpolation`, async () => {
    const source = await readFile(
      new URL(`../.github/workflows/${workflow}.yml`, import.meta.url),
      "utf8",
    );
    const document = parseDocument(source);
    assert.deepEqual(document.errors, []);
    const configuration: unknown = document.toJS();
    assert.ok(isRecord(configuration) && isRecord(configuration.jobs));
    const verifier = configuration.jobs.verify;
    assert.ok(isRecord(verifier) && Array.isArray(verifier.steps));
    const sdk = verifier.steps.find(
      (step: unknown) =>
        isRecord(step) &&
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/github-script@"),
    ) as unknown;
    assert.ok(isRecord(sdk) && isRecord(sdk.with));
    assert.equal(sdk.uses, "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3");
    assert.equal(sdk.with.retries, 0);
    assert.equal(sdk.with.debug, false);
    assert.ok(typeof sdk.with.script === "string" && !sdk.with.script.includes("${{"));
    assert.ok(sdk.with.script.includes(`collectWorkflowJobEvidence(github, "${mode}")`));
    assert.doesNotMatch(source, /\bgh api\b/u);
  });

for (const refusal of [null, "stream", "escape", "pagination"] as const)
  void test(`locked SDK timeout evidence ${refusal ?? "success"}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-job-evidence-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dispatched: string[] = [];
    const exactLog = Buffer.from([0x41, 0x0d, 0x0a, 0x42, 0x0a]);
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        dispatched.push(url);
        if (url === signed) {
          assert.equal(new Headers(init?.headers).get("authorization"), null);
          assert.equal(init?.redirect, "error");
          return new Response(exactLog);
        }
        assert.equal(new Headers(init?.headers).get("authorization"), "token synthetic");
        assert.equal(init?.redirect, "manual");
        if (url === jobsRoute && refusal === "stream")
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("unsafe fixture"));
              },
            }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        if (url === jobsRoute)
          return Response.json(workflowJobs, {
            headers:
              refusal === "pagination" ? { link: '<https://example.invalid/>; rel="next"' } : {},
          });
        if (url === logsRoute)
          return new Response(null, {
            status: 302,
            headers: {
              location:
                refusal === "escape" ? "https://example.invalid/?sig=SECRET_FIXTURE" : signed,
            },
          });
        if (url === checkRoute) return Response.json({ id: 41 });
        if (url === annotationsRoute) return Response.json([{ message: "fixture" }]);
        return assert.fail("Unexpected route");
      },
    );
    const result = collectWorkflowJobEvidence(new Octokit({ auth: "synthetic" }), "timeout", {
      GITHUB_REPOSITORY: "boburning/portcove",
      GITHUB_RUN_ID: "21",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: revision,
      RUNNER_TEMP: directory,
    });
    if (refusal) {
      await assert.rejects(result, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /unsafe fixture|SECRET_FIXTURE|example\.invalid/u);
        return true;
      });
      assert.deepEqual(await readdir(directory), []);
      assert.deepEqual(dispatched, refusal === "escape" ? [jobsRoute, logsRoute] : [jobsRoute]);
      return;
    }
    await result;
    assert.deepEqual(dispatched, [jobsRoute, logsRoute, signed, checkRoute, annotationsRoute]);
    assert.deepEqual(await readFile(path.join(directory, "timeout-job.log")), exactLog);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory, "timeout-jobs.json"), "utf8")),
      workflowJobs,
    );
  });

void test("browser evidence publishes the exact complete attempt packet", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-browser-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(input, jobsRoute);
      assert.equal(new Headers(init?.headers).get("authorization"), "token synthetic");
      return Response.json(workflowJobs);
    },
  );
  await collectWorkflowJobEvidence(new Octokit({ auth: "synthetic" }), "browser", {
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_RUN_ID: "21",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: revision,
    RUNNER_TEMP: directory,
  });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await readdir(directory), ["browser-custody-jobs.json"]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(directory, "browser-custody-jobs.json"), "utf8")),
    workflowJobs,
  );
});
