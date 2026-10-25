import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createVitest } from "vite-plus/test/node";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createBrowserTraceRun } from "../../../scripts/browser-traces.ts";
import { createAuditZip } from "../../../scripts/fixtures/audit-zip-fixture.mts";
import {
  inspectProbeTrace,
  probeFailure,
  probeName,
  verifyProbeResult,
  closeProbeRunner,
  createProbeArtifactReader,
} from "./browser-trace-probe.mts";
import {
  screenshotContext,
  screenshotFailure,
  screenshotRoutes,
  verifyScreenshotPacket,
  verifyScreenshotJobs,
} from "./browser-screenshot-custody.mts";

test("screenshot-only packets require exact context, original failure, close acknowledgement and bytes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-screenshot-packet-"));
  const context = { source: "a".repeat(40), run: "123", attempt: "2" };
  const screenshot = "work/bt/run-01234567/screenshots/failure.png";
  const receipt = ".vitest/attachments/browser-artifact-custody/fast.json";
  // Inert header fixture tests validation only; hosted acceptance requires the
  // real Playwright producer and corresponding original failed step outcomes.
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(360, 20);
  const value = {
    format_version: 1,
    ...context,
    checkout: context.source,
    route: "fast",
    browser_closed: true,
    trace_started: false,
    failure: {
      name: "AssertionError",
      code: "ERR_ASSERTION",
      marker: screenshotFailure,
      actual: "Portcove screenshot custody probe",
      expected: "Intentional different title",
    },
    screenshot: {
      path: screenshot,
      bytes: png.length,
      sha256: createHash("sha256").update(png).digest("hex"),
    },
  };
  const save = (input: unknown = value) =>
    writeFileSync(path.join(root, receipt), JSON.stringify(input));
  try {
    for (const file of [receipt, screenshot])
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, screenshot), png);
    save();
    assert.equal(verifyScreenshotPacket(root, "fast", context).bytes, png.length);
    for (const patch of [
      { source: "b".repeat(40) },
      { checkout: "b".repeat(40) },
      { run: "124" },
      { attempt: "1" },
      { route: "full" },
      { browser_closed: false },
      { trace_started: true },
      { failure: { ...value.failure, marker: "unrelated launch failure" } },
      { failure: { ...value.failure, code: "ERR_UNKNOWN" } },
      { screenshot: { ...value.screenshot, sha256: "0".repeat(64) } },
      { screenshot: { ...value.screenshot, bytes: 1 } },
      { screenshot: { ...value.screenshot, path: "../../foreign.png" } },
    ]) {
      save({ ...value, ...patch });
      assert.throws(() => verifyScreenshotPacket(root, "fast", context));
    }
    save();
    const extra = path.join(root, "work/bt/run-01234567/failure.trace.zip");
    writeFileSync(extra, "unexpected trace");
    assert.throws(() => verifyScreenshotPacket(root, "fast", context));
    rmSync(extra);
    writeFileSync(path.join(root, screenshot), "");
    assert.throws(() => verifyScreenshotPacket(root, "fast", context));
    rmSync(path.join(root, screenshot));
    assert.throws(() => verifyScreenshotPacket(root, "fast", context));
    writeFileSync(path.join(root, screenshot), png);
    writeFileSync(path.join(root, receipt), "{}");
    assert.throws(() => verifyScreenshotPacket(root, "fast", context));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("screenshot custody refuses empty or malformed source/run/attempt context", () => {
  const env = { GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" };
  assert.deepEqual(screenshotContext(env), { source: env.GITHUB_SHA, run: "123", attempt: "2" });
  for (const key of Object.keys(env))
    for (const invalid of ["", "0", "-1", "bad value"])
      assert.throws(() => screenshotContext({ ...env, [key]: invalid }));
});

test("hosted screenshot acceptance refuses missing jobs, tolerated steps and unrelated failures", () => {
  const context = { source: "a".repeat(40), run: "123", attempt: "2" };
  const required = [
    "Install pinned dependencies",
    "Bootstrap Chromium",
    "Intentional screenshot-only failure",
    "Retain screenshot-only diagnostics",
  ];
  const jobs = screenshotRoutes.map((route, index) => ({
    id: index + 1,
    name: `screenshot-only (${route})`,
    run_id: 123,
    run_attempt: 2,
    head_sha: context.source,
    status: "completed",
    conclusion: "failure",
    steps: required.map((name, number) => ({
      name,
      number: number + 1,
      status: "completed",
      conclusion: name === "Intentional screenshot-only failure" ? "failure" : "success",
    })),
  }));
  const value = {
    total_count: 4,
    jobs: [
      ...jobs,
      {
        ...jobs[0]!,
        id: 4,
        name: "verify-screenshot-custody",
        status: "in_progress",
        conclusion: null,
      },
    ],
  };
  verifyScreenshotJobs(value, context);
  for (const total_count of [0, 3, 5, 100, 101])
    assert.throws(() => verifyScreenshotJobs({ ...value, total_count }, context));
  assert.throws(() => verifyScreenshotJobs({ ...value, jobs: value.jobs.slice(1) }, context));
  for (const patch of [
    { id: 2 },
    { name: "screenshot-only (full)" },
    { run_id: 124 },
    { run_attempt: 1 },
    { run_attempt: undefined },
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { conclusion: "success" },
  ]) {
    assert.throws(() =>
      verifyScreenshotJobs(
        { ...value, jobs: [{ ...jobs[0]!, ...patch }, ...value.jobs.slice(1)] },
        context,
      ),
    );
  }
  for (const index of [0, 1, 2, 3])
    for (const conclusion of ["skipped", "cancelled", index === 2 ? "success" : "failure"]) {
      const changed = structuredClone(value);
      changed.jobs[0]!.steps[index]!.conclusion = conclusion;
      assert.throws(() => verifyScreenshotJobs(changed, context));
    }
  const omitted = structuredClone(value);
  omitted.jobs[0]!.steps.pop();
  assert.throws(() => verifyScreenshotJobs(omitted, context));
  const duplicate = structuredClone(value);
  duplicate.jobs[0]!.steps.push(duplicate.jobs[0]!.steps[0]!);
  assert.throws(() => verifyScreenshotJobs(duplicate, context));
});

test("artifact reads reject missing, empty, oversized, foreign and replaced output roots", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "portcove-probe-read-"));
  const root = path.join(parent, "run");
  mkdirSync(root);
  const file = path.join(root, "report.json");
  const foreign = path.join(parent, "foreign.json");
  writeFileSync(file, "abc");
  writeFileSync(foreign, "external bytes");
  const reader = createProbeArtifactReader(root);
  try {
    assert.equal(reader.read(file, 3).toString(), "abc");
    assert.throws(() => reader.read(file, 2), /oversized/u);
    assert.throws(() => reader.read(foreign, 32), /outside/u);
    assert.throws(() => reader.read(file, 0), /limit/u);
    assert.throws(() => reader.read(path.join(root, "missing.json"), 32));
    writeFileSync(file, "");
    assert.throws(() => reader.read(file, 32), /empty/u);
    renameSync(root, path.join(parent, "original"));
    mkdirSync(root);
    writeFileSync(path.join(root, "report.json"), "replacement");
    assert.throws(() => reader.list(), /changed identity/u);
    assert.throws(() => reader.read(path.join(root, "report.json"), 32), /changed identity/u);
    assert.equal(readFileSync(foreign, "utf8"), "external bytes");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("redirecting the run root refuses stale artifacts and preserves the external target", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "portcove-probe-redirect-"));
  const root = path.join(parent, "run");
  const external = path.join(parent, "external");
  mkdirSync(root);
  mkdirSync(external);
  const marker = path.join(external, "report.json");
  writeFileSync(marker, "external stale artifact");
  const reader = createProbeArtifactReader(root);
  try {
    renameSync(root, path.join(parent, "original"));
    symlinkSync(external, root, "junction");
    assert.throws(() => reader.list(), /changed identity/u);
    assert.throws(() => reader.read(path.join(root, "report.json"), 128), /changed identity/u);
    assert.throws(() => createProbeArtifactReader(root), /Invalid/u);
    assert.equal(readFileSync(marker, "utf8"), "external stale artifact");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a swallowed pinned-runner pool-close failure cannot satisfy the expected assertion failure", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-probe-close-"));
  const previous = process.exitCode;
  const runner = await createVitest({ root, config: false, watch: false });
  try {
    await runner.standalone();
    Object.defineProperty(runner, "pool", {
      configurable: true,
      writable: true,
      value: {
        close: async () => {
          throw new Error("controlled browser pool close failure");
        },
      },
    });
    process.exitCode = 1;
    await assert.rejects(closeProbeRunner(runner), /shutdown failed/u);
    assert.equal(process.exitCode, 1);
  } finally {
    await runner.close();
    process.exitCode = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean runner close preserves the expected test status until evidence verification", async () => {
  const previous = process.exitCode;
  try {
    process.exitCode = 1;
    await closeProbeRunner({ close: async () => {} });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previous;
  }
});

const completed = () => ({ reason: "failed", unhandled_errors: 0 });
test("the real completion reporter preserves unhandled error counts before probe verification", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-probe-outcome-"));
  try {
    const run = createBrowserTraceRun(root, undefined, true);
    assert.ok(run.reporter.onTestRunEnd);
    await run.reporter.onTestRunEnd(
      [],
      [{ name: "Error", message: "inert unhandled fixture" }],
      "failed",
    );
    const outcome: unknown = JSON.parse(
      readFileSync(path.join(run.directory, "run-outcome.json"), "utf8"),
    );
    assert.deepEqual(outcome, { reason: "failed", unhandled_errors: 1 });
    assert.throws(() => verifyProbeResult(1, result(), outcome));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
const result = () => ({
  success: false,
  numFailedTests: 1,
  numPassedTests: 0,
  numPendingTests: 0,
  numTotalTests: 1,
  testResults: [
    {
      name: "/repo/src/browser/failure-probe.browser.test.tsx",
      status: "failed",
      assertionResults: [
        {
          fullName: probeName,
          status: "failed",
          failureMessages: [`AssertionError: ${probeFailure}`],
        },
      ],
    },
  ],
});

test("only the exact intentional assertion failure satisfies the diagnostic", () => {
  assert.doesNotThrow(() => verifyProbeResult(1, result(), completed()));
  for (const outcome of [
    undefined,
    { reason: "passed", unhandled_errors: 0 },
    { reason: "failed", unhandled_errors: 1 },
  ])
    assert.throws(() => verifyProbeResult(1, result(), outcome));
  for (const status of [null, 0, 2, 124])
    assert.throws(() => verifyProbeResult(status, result(), completed()));
  for (const patch of [
    { success: true },
    { numFailedTests: 0 },
    { numTotalTests: 2 },
    { numPendingTests: 1 },
    { testResults: [] },
    { unhandledErrors: [{ message: "browser launch failed" }] },
  ])
    assert.throws(() => verifyProbeResult(1, { ...result(), ...patch }, completed()));
  const wrong = result();
  wrong.testResults[0]!.assertionResults[0]!.failureMessages = ["browser unavailable"];
  assert.throws(() => verifyProbeResult(1, wrong, completed()));
  for (const message of [
    `TypeError: ${probeFailure}`,
    `Error: browser startup failed: ${probeFailure}`,
    `AssertionError: prefix ${probeFailure}`,
    `AssertionError: ${probeFailure} suffix`,
  ]) {
    const wrongIdentity = result();
    wrongIdentity.testResults[0]!.assertionResults[0]!.failureMessages = [message];
    assert.throws(() => verifyProbeResult(1, wrongIdentity, completed()), message);
  }
  const skipped = result();
  skipped.testResults[0]!.assertionResults[0]!.status = "pending";
  assert.throws(() => verifyProbeResult(1, skipped, completed()));
});

const archive = (trace = '{"type":"context-options"}\n{"type":"after"}\n') =>
  createAuditZip([
    ["trace.trace", trace, { method: 0 }],
    ["trace.network", ""],
    ["trace.stacks", "{}"],
  ]);
test("probe trace validation reads actual events and checks every member CRC", () => {
  assert.deepEqual(inspectProbeTrace(archive()), { members: 3, events: 2 });
  assert.throws(() => inspectProbeTrace(archive("")));
  assert.throws(() => inspectProbeTrace(archive("not JSON")));
  assert.throws(() => inspectProbeTrace(archive('{"message":"no event type"}')));
  assert.throws(() => inspectProbeTrace(Buffer.from("not a zip")));
  const corrupt = archive();
  // Alter a stored payload, leaving the central and local CRC declarations intact.
  corrupt[30 + Buffer.byteLength("trace.trace")]! ^= 1;
  assert.throws(() => inspectProbeTrace(corrupt), /corrupt/);
  assert.throws(() => inspectProbeTrace(createAuditZip([["../trace.trace", "{}"]])), /unexpected/);
  const huge = archive();
  const end = huge.length - 22;
  huge.writeUInt16LE(65535, end + 10);
  assert.throws(() => inspectProbeTrace(huge), /bounds/);
});
