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
import { nodeCaseObservation, createNodeCaseObservations } from "./node-case-observations.mts";

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
  const cases = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("Node test case observation: "));
  assert.equal(cases.length, 1, result.stdout);
  const observation: unknown = JSON.parse(cases[0]!.slice("Node test case observation: ".length));
  assert.ok(isRecord(observation) && isRecord(observation.failure));
  assert.equal(observation.kind, "worker");
  assert.equal(observation.outcome, "failed");
  assert.equal(observation.failure.exit_code, 7);
  assert.equal(observation.failure.signal, null);
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

function caseEvent() {
  return {
    type: "test:pass",
    data: {
      file: path.resolve("scripts/example.test.mts"),
      entryFile: path.resolve("scripts/example.test.mts"),
      name: "parameter",
      classname: "group",
      line: 10,
      column: 3,
      nesting: 1,
      testNumber: 2,
      testId: 3,
      parentId: 1,
      details: { type: "test", duration_ms: 1.25 },
    },
  };
}

void test("case definitions retain separate instances and normalize matching checkout roots", () => {
  const input = caseEvent();
  const original = nodeCaseObservation(input);
  assert.ok(original);
  assert.equal(original.file, "scripts/example.test.mts");
  assert.equal(original.duration_ms, 1.25);
  assert.equal(original.outcome, "passed");
  const second = nodeCaseObservation({
    ...input,
    data: { ...input.data, testId: 4, testNumber: 3 },
  });
  assert.ok(second);
  assert.equal(second.definition_id, original.definition_id);
  assert.notEqual(second.test_id, original.test_id);
  const root = path.resolve("alternate-checkout");
  const relocated = nodeCaseObservation(
    {
      ...input,
      data: {
        ...input.data,
        file: path.join(root, "scripts/example.test.mts"),
        entryFile: path.join(root, "scripts/example.test.mts"),
      },
    },
    root,
  );
  assert.equal(relocated?.definition_id, original.definition_id);
  input.data.details.duration_ms = 99;
  assert.equal(original.duration_ms, 1.25);
});

void test("case observations separate skips, TODO failures, cancellations and worker exits", () => {
  const input = caseEvent();
  for (const reason of [true, "", "requires owned platform"]) {
    const skipped = nodeCaseObservation({ ...input, data: { ...input.data, skip: reason } });
    assert.ok(skipped);
    assert.equal(skipped.outcome, "skipped");
    assert.equal(skipped.skip_reason, typeof reason === "string" ? reason : null);
  }
  const cause = new Error("original assertion");
  const error = Object.assign(new Error("wrapper failure"), {
    cause,
    code: "ERR_TEST_FAILURE",
    failureType: "testCodeFailure",
  });
  const failed = {
    type: "test:fail",
    data: { ...input.data, details: { ...input.data.details, error } },
  };
  const todo = nodeCaseObservation({ ...failed, data: { ...failed.data, todo: "pending route" } });
  assert.ok(todo);
  assert.equal(todo.outcome, "todo");
  assert.equal(todo.event, "test:fail");
  assert.equal(todo.failure?.cause?.message, "original assertion");
  assert.equal(todo.todo_reason, "pending route");
  assert.equal(
    nodeCaseObservation({
      ...failed,
      data: {
        ...failed.data,
        details: {
          ...failed.data.details,
          error: { failureType: "cancelledByParent", message: "parent cancelled" },
        },
      },
    })?.outcome,
    "cancelled",
  );
  const worker = nodeCaseObservation({
    ...failed,
    data: {
      ...failed.data,
      details: {
        ...failed.data.details,
        error: { exitCode: 7, failureType: "testCodeFailure", message: "worker exited" },
      },
    },
  });
  assert.ok(worker);
  assert.equal(worker.kind, "worker");
  assert.equal(worker.outcome, "failed");
  assert.equal(worker.failure?.exit_code, 7);
  assert.equal(error.cause, cause);
  assert.equal(cause.message, "original assertion");
});

void test("actual timeout and AbortSignal rows retain cancellation counts and a failing exit", (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "portcove-case-cancellation-"));
  const fixture = path.join(root, "cancelled.test.mjs");
  writeFileSync(
    fixture,
    `import { it } from "node:test";
import assert from "node:assert/strict";
it("original timeout", { timeout: 20 }, async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
it("original abort", { signal: AbortSignal.abort(new Error("owned abort reason")) }, () => assert.fail("aborted callback ran"));
`,
  );
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-timeout=10000",
      `--test-reporter=${new URL("./test-duration-reporter.mts", import.meta.url).href}`,
      fixture,
    ],
    { cwd: root, env: environment, encoding: "utf8", timeout: 20000, windowsHide: true },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  const parse = (prefix: string) =>
    result.stdout
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .map((line) => {
        const row: unknown = JSON.parse(line.slice(prefix.length));
        assert.ok(isRecord(row));
        return row;
      });
  const rows = parse("Node test case observation: ");
  const files = parse("Node test file observation: ");
  assert.equal(rows.length, 2, result.stdout);
  assert.ok(rows.every((row) => row.outcome === "cancelled" && row.event === "test:fail"));
  assert.deepEqual(
    rows
      .map((row) => {
        assert.ok(isRecord(row.failure));
        assert.equal(typeof row.failure.failure_type, "string");
        return String(row.failure.failure_type);
      })
      .sort((left, right) => left.localeCompare(right)),
    ["testAborted", "testTimeoutFailure"],
  );
  assert.equal(files.length, 1);
  assert.ok(isRecord(files[0]!.counts));
  assert.equal(files[0]!.success, false);
  assert.equal(files[0]!.counts.cancelled, 2);
  assert.equal(files[0]!.counts.failed, 0);
  assert.equal(files[0]!.counts.passed, 0);
  assert.match(result.stdout, /owned abort reason/u);
});

void test(
  "actual POSIX worker signal is retained in the joined case failure",
  {
    skip:
      process.platform === "win32"
        ? "POSIX worker signals execute in the Linux reporter contract route"
        : false,
  },
  (t) => {
    const root = disposableDirectory(t, path.join(os.tmpdir(), "portcove-case-signal-"));
    const fixture = path.join(root, "signal.test.mjs");
    writeFileSync(fixture, 'process.kill(process.pid, "SIGTERM");\n');
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-timeout=10000",
        `--test-reporter=${new URL("./test-duration-reporter.mts", import.meta.url).href}`,
        fixture,
      ],
      { cwd: root, env: environment, encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    const rows = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("Node test case observation: "));
    assert.equal(rows.length, 1, result.stdout);
    const row: unknown = JSON.parse(rows[0]!.slice("Node test case observation: ".length));
    assert.ok(isRecord(row) && isRecord(row.failure));
    assert.equal(row.kind, "worker");
    assert.equal(row.outcome, "failed");
    assert.equal(row.failure.exit_code, null);
    assert.equal(row.failure.signal, "SIGTERM");
  },
);

void test("case diagnostics reject invalid measurements and survive unavailable error fields", () => {
  const input = caseEvent();
  for (const patch of [
    { file: undefined },
    { name: "" },
    { nesting: -1 },
    { testNumber: 0 },
    { skip: 4 },
    { todo: "x".repeat(2049) },
  ])
    assert.equal(nodeCaseObservation({ ...input, data: { ...input.data, ...patch } }), undefined);
  for (const patch of [
    { duration_ms: NaN },
    { duration_ms: Infinity },
    { duration_ms: -1 },
    { type: "unknown" },
  ])
    assert.equal(
      nodeCaseObservation({
        ...input,
        data: { ...input.data, details: { ...input.data.details, ...patch } },
      }),
      undefined,
    );
  const collector = createNodeCaseObservations("owned");
  collector.capture({ type: "test:watch:drained" });
  const error = Object.defineProperty({}, "message", {
    get() {
      throw new Error("diagnostic unavailable");
    },
  });
  assert.doesNotThrow(() =>
    collector.capture({
      type: "test:fail",
      data: { ...input.data, details: { ...input.data.details, error } },
    }),
  );
  collector.capture(input);
  assert.equal(collector.summary().invalid, 1);
  assert.equal(collector.summary().observed, 1);
  assert.equal(collector.summary().omitted, 0);
});

void test("bounded case records disclose count, byte and serialization omissions without collapsing repeats", () => {
  const input = caseEvent();
  const collector = createNodeCaseObservations("owned");
  for (let index = 0; index < 4097; index++) collector.capture(input);
  const summary = collector.summary();
  assert.equal(summary.observed, 4096);
  assert.equal(summary.omitted, 1);
  assert.equal(summary.invalid, 0);
  assert.ok(summary.bytes <= 4 * 1024 * 1024);
  const rows = collector.records().map((line) => {
    assert.ok(Buffer.byteLength(line) <= 16_384);
    const row: unknown = JSON.parse(line.slice("Node test case observation: ".length));
    assert.ok(isRecord(row));
    return row;
  });
  assert.equal(rows[0]!.observation_index, 1);
  assert.equal(rows[4095]!.observation_index, 4096);
  assert.equal(rows[0]!.definition_id, rows[4095]!.definition_id);
  collector.records().pop();
  assert.equal(collector.summary().observed, 4096);
  const oversized = createNodeCaseObservations("owned");
  oversized.capture({
    ...input,
    data: { ...input.data, name: "\u0001".repeat(2048), classname: "\u0001".repeat(4096) },
  });
  assert.equal(oversized.summary().omitted, 1);
  const bytes = createNodeCaseObservations("owned");
  for (let index = 0; index < 900; index++)
    bytes.capture({
      ...input,
      data: { ...input.data, name: "x".repeat(2048), classname: "y".repeat(4096) },
    });
  assert.ok(bytes.summary().observed < 900);
  assert.ok(bytes.summary().omitted > 0);
  assert.ok(bytes.summary().bytes <= 4 * 1024 * 1024);
});

void test("actual nested case outcomes join equivalent runs and preserve original failing exits", (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "portcove-case-observations-"));
  const fixture = path.join(root, "cases.test.mjs");
  writeFileSync(
    fixture,
    `import { describe, it } from "node:test";
import assert from "node:assert/strict";
for (const name of ["first", "second"]) describe(name, { concurrency: true }, () => {
  for (let index = 0; index < 2; index++) it("repeated child", () => {});
  it("platform skip", { skip: "requires owned platform" }, () => assert.fail("skip ran"));
  it("pending route", { todo: "awaits explicit fixture" }, () => {});
});
it("original assertion", () => assert.equal(1, 2, "retained assertion"));
`,
  );
  const environment: NodeJS.ProcessEnv = { ...process.env, PORTCOVE_HEAD_SHA: "b".repeat(40) };
  delete environment.NODE_TEST_CONTEXT;
  const executions = [];
  for (let iteration = 0; iteration < 2; iteration++) {
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-timeout=10000",
        "--test-concurrency=2",
        `--test-reporter=${new URL("./test-duration-reporter.mts", import.meta.url).href}`,
        fixture,
      ],
      { cwd: root, env: environment, encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /retained assertion/u);
    const parse = (prefix: string) =>
      result.stdout
        .split("\n")
        .filter((line) => line.startsWith(prefix))
        .map((line) => {
          const row: unknown = JSON.parse(line.slice(prefix.length));
          assert.ok(isRecord(row));
          return row;
        });
    const rows = parse("Node test case observation: ");
    const contexts = parse("Node test case observation context: ");
    assert.equal(rows.length, 11);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]!.observed, 11);
    assert.equal(contexts[0]!.invalid, 0);
    assert.equal(contexts[0]!.omitted, 0);
    assert.equal(contexts[0]!.source, "b".repeat(40));
    assert.equal(contexts[0]!.platform, process.platform);
    assert.equal(rows.filter((row) => row.kind === "suite").length, 2);
    assert.equal(rows.filter((row) => row.kind === "test" && row.outcome === "passed").length, 4);
    assert.equal(
      rows.filter(
        (row) => row.outcome === "skipped" && row.skip_reason === "requires owned platform",
      ).length,
      2,
    );
    assert.equal(
      rows.filter((row) => row.outcome === "todo" && row.todo_reason === "awaits explicit fixture")
        .length,
      2,
    );
    const failure = rows.find((row) => row.name === "original assertion");
    assert.ok(failure && isRecord(failure.failure));
    assert.equal(failure.outcome, "failed");
    assert.match(String(failure.failure.message), /retained assertion/u);
    assert.ok(
      rows.every(
        (row) =>
          row.invocation_id === contexts[0]!.invocation_id &&
          typeof row.duration_ms === "number" &&
          row.duration_ms >= 0,
      ),
    );
    assert.equal(new Set(rows.map((row) => row.observation_index)).size, 11);
    const repeats = rows.filter((row) => row.name === "repeated child");
    assert.equal(repeats.length, 4);
    assert.equal(new Set(repeats.map((row) => row.test_id)).size, 4);
    assert.equal(new Set(repeats.map((row) => row.definition_id)).size, 2);
    const fileRows = parse("Node test file observation: ");
    assert.equal(fileRows.length, 1);
    assert.ok(isRecord(fileRows[0]!.counts));
    assert.equal(fileRows[0]!.counts.tests, 9);
    assert.equal(fileRows[0]!.counts.failed, 1);
    executions.push(
      rows.map(({ definition_id, test_id, parent_id, test_number, name, kind, outcome }) => ({
        definition_id,
        test_id,
        parent_id,
        test_number,
        name,
        kind,
        outcome,
      })),
    );
  }
  assert.deepEqual(executions[0], executions[1]);
});
