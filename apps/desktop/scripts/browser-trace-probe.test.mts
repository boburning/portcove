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
