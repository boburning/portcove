import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestEvent } from "node:test/reporters";
import report, { isSlowTest, nodeFileObservation } from "./test-duration-reporter.mts";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { isRecord } from "./runtime-values.mts";

function event(duration: number, type = "test") {
  return {
    type: "test:pass",
    data: { name: "fixture", details: { type, duration_ms: duration } },
  };
}

void test("individual slow tests are identified independently of suite duration", () => {
  assert.equal(isSlowTest(event(5_000)), false);
  assert.equal(isSlowTest(event(5_001)), true);
  assert.equal(isSlowTest(event(50_000, "suite")), false);
  assert.equal(isSlowTest({ ...event(5_001), type: "test:fail" }), true);
  assert.equal(isSlowTest({ ...event(5_001), type: "test:diagnostic" }), false);
  assert.equal(
    isSlowTest({
      type: "test:pass",
      data: { ...event(5_001).data, skip: true },
    }),
    false,
  );
});

void test("a synchronous slow result is reported without failing a correct test", () => {
  const reporter = new URL("./test-duration-reporter.mts", import.meta.url).href;
  const script = `import report from ${JSON.stringify(reporter)};
    async function* source() { yield ${JSON.stringify(event(5_001))}; }
    for await (const line of report(source())) process.stdout.write(line);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    windowsHide: true,
    // Cold native TS import can exceed three seconds under the required suite.
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Slow tests to investigate/);
});

void test("an abnormal worker exit retains bounded status and remains a failed run", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-worker-reporter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, "exiting.test.mjs");
  writeFileSync(fixture, "process.exit(7);\n");
  const reporter = new URL("./test-duration-reporter.mts", import.meta.url).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-timeout=30000", `--test-reporter=${reporter}`, fixture],
    { encoding: "utf8", windowsHide: true, timeout: 45_000, env },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  const prefix = "Worker process failure: ";
  const diagnostic = result.stdout.split("\n").find((line: string) => line.startsWith(prefix));
  assert.ok(diagnostic, result.stdout);
  assert.deepEqual(JSON.parse(diagnostic.slice(prefix.length)), {
    exitCode: 7,
    signal: null,
    failureType: "testCodeFailure",
    code: "ERR_TEST_FAILURE",
  });
});

// Watch lifecycle events have no data object; they must not mask later results.
void test("reporter accepts a watch lifecycle event without test details", async () => {
  async function* source(): AsyncGenerator<TestEvent> {
    yield { type: "test:watch:drained", data: undefined };
  }
  await assert.doesNotReject(async () => {
    for await (const chunk of report(source()))
      assert(typeof chunk === "string" || Buffer.isBuffer(chunk));
  });
});

void test("actual file observations retain nested counts, intentional skips and original failures", (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "portcove-file-observations-"));
  const success = path.join(root, "success.test.mjs");
  const failure = path.join(root, "failure.test.mjs");
  writeFileSync(
    success,
    `import { describe, it } from "node:test";
describe("owned group", () => {
  it("passes", () => {});
  it.skip("intentional skip", () => {});
  it.todo("intentional todo");
});
`,
  );
  writeFileSync(
    failure,
    `import { it } from "node:test";
it("original failure", () => { throw new Error("retained original failure"); });
`,
  );
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  environment.PORTCOVE_HEAD_SHA = "b".repeat(40);
  environment.GITHUB_SHA = "a".repeat(40);
  environment.GITHUB_RUN_ID = "314";
  environment.GITHUB_RUN_ATTEMPT = "2";
  environment.GITHUB_JOB = "owned-fixture";
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-timeout=10000",
      `--test-reporter=${new URL("./test-duration-reporter.mts", import.meta.url).href}`,
      success,
      failure,
    ],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20000, env: environment },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /retained original failure/u);
  const observations = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("Node test file observation: "))
    .map((line) => {
      const value: unknown = JSON.parse(line.slice("Node test file observation: ".length));
      assert.ok(isRecord(value));
      return value;
    });
  assert.equal(observations.length, 2, result.stdout);
  const passed = observations.find((entry) => entry.file === success);
  const failed = observations.find((entry) => entry.file === failure);
  assert.ok(passed && failed);
  assert.equal(passed.entry_file, success);
  assert.equal(failed.entry_file, failure);
  assert.equal(passed.success, true);
  assert.equal(failed.success, false);
  assert.deepEqual(passed.counts, {
    tests: 3,
    failed: 0,
    passed: 1,
    cancelled: 0,
    skipped: 1,
    todo: 1,
    topLevel: 1,
    suites: 1,
  });
  assert.deepEqual(failed.counts, {
    tests: 1,
    failed: 1,
    passed: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    topLevel: 1,
    suites: 0,
  });
  for (const observation of observations) {
    assert.ok(typeof observation.duration_ms === "number" && observation.duration_ms >= 0);
    assert.equal(observation.invocation_id, passed.invocation_id);
  }
  const contextLine = result.stdout
    .split("\n")
    .find((line) => line.startsWith("Node test file observation context: "));
  assert.ok(contextLine);
  const context: unknown = JSON.parse(
    contextLine.slice("Node test file observation context: ".length),
  );
  assert.ok(isRecord(context));
  assert.equal(context.invocation_id, passed.invocation_id);
  assert.equal(context.node, process.version);
  assert.equal(context.platform, process.platform);
  assert.equal(context.arch, process.arch);
  assert.equal(context.source, "b".repeat(40));
  assert.equal(context.checkout, "a".repeat(40));
  assert.equal(context.run, "314");
  assert.equal(context.attempt, "2");
  assert.equal(context.job, "owned-fixture");
  assert.equal(context.observed, 2);
  assert.equal(context.invalid, 0);
  assert.equal(context.omitted, 0);
});

function fileSummary(file = "owned.test.mts") {
  return {
    type: "test:summary",
    data: {
      file,
      entryFile: file,
      duration_ms: 1.25,
      success: false,
      counts: {
        tests: 1,
        failed: 1,
        passed: 0,
        cancelled: 0,
        skipped: 0,
        todo: 0,
        topLevel: 1,
        suites: 0,
      },
    },
  };
}

void test("file observations reject missing or malformed measurements without inventing aggregate file coverage", () => {
  const original = fileSummary();
  const observation = nodeFileObservation(original);
  assert.ok(observation);
  assert.equal(observation.duration_ms, 1.25);
  assert.equal(observation.success, false);
  original.data.counts.failed = 0;
  assert.equal(observation.counts.failed, 1, "The event cannot mutate a retained observation");
  assert.equal(nodeFileObservation({ ...original, type: "test:pass" }), undefined);
  assert.equal(
    nodeFileObservation({ type: "test:summary", data: { ...original.data, file: undefined } }),
    undefined,
  );
  for (const patch of [
    { file: "" },
    { file: 5 },
    { file: "x".repeat(4097) },
    { entryFile: null },
    { duration_ms: NaN },
    { duration_ms: Infinity },
    { duration_ms: -1 },
    { success: "true" },
    { counts: {} },
  ])
    assert.equal(
      nodeFileObservation({ ...original, data: { ...original.data, ...patch } }),
      undefined,
    );
  for (const key of Object.keys(original.data.counts))
    for (const value of [-1, 1.5, Infinity, "1", undefined])
      assert.equal(
        nodeFileObservation({
          ...original,
          data: { ...original.data, counts: { ...original.data.counts, [key]: value } },
        }),
        undefined,
      );
  const withoutEntry = nodeFileObservation({
    ...original,
    data: { ...original.data, entryFile: undefined },
  });
  assert.equal(withoutEntry?.entry_file, null);
});

void test("bounded file observations retain an earlier failure and disclose omitted or invalid records", async () => {
  async function* source(): AsyncGenerator<TestEvent> {
    yield fileSummary("\u0001".repeat(4096)) as unknown as TestEvent;
    for (let index = 0; index < 514; index++) {
      const event = fileSummary(index < 2 ? "same.test.mts" : `owned-${index}.test.mts`);
      event.data.success = index !== 0;
      yield event as unknown as TestEvent;
    }
    yield {
      ...fileSummary(),
      data: { ...fileSummary().data, duration_ms: Infinity },
    } as unknown as TestEvent;
    yield { ...fileSummary(), data: { ...fileSummary().data, counts: {} } } as unknown as TestEvent;
  }
  let output = "";
  for await (const chunk of report(source())) output += chunk.toString();
  const lines = output
    .split("\n")
    .filter((line) => line.startsWith("Node test file observation: "));
  assert.equal(lines.length, 512);
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 16_384);
  const first: unknown = JSON.parse(lines[0]!.slice("Node test file observation: ".length));
  const second: unknown = JSON.parse(lines[1]!.slice("Node test file observation: ".length));
  assert.ok(isRecord(first) && isRecord(second));
  assert.equal(first.file, "same.test.mts");
  assert.equal(first.success, false);
  assert.equal(second.file, "same.test.mts");
  assert.equal(second.success, true);
  const contextLine = output
    .split("\n")
    .find((line) => line.startsWith("Node test file observation context: "));
  assert.ok(contextLine);
  const context: unknown = JSON.parse(
    contextLine.slice("Node test file observation context: ".length),
  );
  assert.ok(isRecord(context));
  assert.equal(context.observed, 512);
  assert.equal(context.omitted, 3);
  assert.equal(context.invalid, 2);
});
