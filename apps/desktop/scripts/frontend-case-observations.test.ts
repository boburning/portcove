// @vitest-environment node
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import path from "node:path";
import { it } from "vite-plus/test";
import type { Reporter, TestCase, TestModule, TestSuite } from "vite-plus/test/node";
import { createFrontendCaseObservations } from "../../../scripts/frontend-case-observations.ts";
import {
  declaredFrontendCaseSkip,
  declaredUiSkip,
  frontendCaseSkipAllowed,
} from "../../../scripts/ui-test-selection.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { browserTraceProbe } from "../src/browser/failure-probe-contract.ts";

const root = path.resolve("frontend-observation-fixture");
function fixture(overrides: Partial<TestCase> = {}): TestCase {
  return {
    type: "test",
    id: "runner-order-id",
    fullName: "suite > repeated name",
    project: { name: "unit" },
    module: { moduleId: path.join(root, "src/example.test.ts") },
    options: { mode: "run" },
    location: { line: 10, column: 2 },
    result: () => ({ state: "passed", errors: undefined }),
    diagnostic: () => ({ duration: 7, startTime: 1234, retryCount: 0, repeatCount: 0 }),
    ...overrides,
  } as TestCase;
}
function module(tests: TestCase[] = [], overrides: Partial<TestModule> = {}): TestModule {
  return {
    type: "module",
    id: "module-id",
    moduleId: path.join(root, "src/example.test.ts"),
    project: { name: "unit" },
    state: () => "passed",
    errors: () => [],
    diagnostic: () => ({ duration: 20 }),
    children: { allTests: () => tests.values(), allSuites: () => [].values() },
    ...overrides,
  } as TestModule;
}
function capture() {
  const lines: string[] = [];
  const reporter = createFrontendCaseObservations(root, {
    write: (line) => {
      lines.push(line);
    },
    environment: { PORTCOVE_HEAD_SHA: "a".repeat(40), GITHUB_SHA: "bad", GITHUB_RUN_ID: "42" },
  });
  return { lines, reporter };
}
function rows(lines: string[], context = false) {
  const marker = context
    ? "Frontend test case observation context: "
    : "Frontend test case observation: ";
  return lines
    .filter((line) => line.startsWith(marker))
    .map((line) => {
      const value: unknown = JSON.parse(line.slice(marker.length));
      assert.ok(isRecord(value));
      return value;
    });
}
function end(reporter: Reporter, modules: TestModule[] = []) {
  return reporter.onTestRunEnd?.(modules, [], "passed");
}

it("reports the declared diagnostic route and flags a replacement skip without rewriting native outcomes", async () => {
  const file = path.join(root, "apps/desktop/src/browser/failure-probe.browser.test.tsx");
  for (const name of [browserTraceProbe.name, "replacement skipped case"]) {
    const { reporter, lines } = capture();
    const test = fixture({
      fullName: name,
      module: { moduleId: file } as TestModule,
      result: () => ({ state: "skipped", note: "original native reason", errors: undefined }),
    });
    await reporter.onTestCaseResult?.(test);
    await end(reporter, [module([test], { moduleId: file })]);
    const row = rows(lines).find((item) => item.kind === "test");
    assert.ok(row);
    assert.equal(row.outcome, "skipped");
    assert.equal(row.skip_reason, "original native reason");
    assert.equal(row.unexpected_skip, name !== browserTraceProbe.name);
    assert.equal(rows(lines, true)[0]?.unexpected_skips, name === browserTraceProbe.name ? 0 : 1);
    assert.deepEqual(
      rows(lines, true)[0]?.missing_skip_routes,
      name === browserTraceProbe.name
        ? []
        : [
            {
              file: "apps/desktop/src/browser/failure-probe.browser.test.tsx",
              cases: [browserTraceProbe.name],
            },
          ],
    );
    if (name === browserTraceProbe.name) {
      assert.ok(isRecord(row.skip_contract));
      assert.equal(row.skip_contract.intended_route, browserTraceProbe.intendedRoute);
    }
  }
});

it("retains nested suite hook failures separately from module and test outcomes", async () => {
  const { lines, reporter } = capture();
  const child = fixture();
  const parent = module([child]);
  const suite = {
    type: "suite",
    id: "nested-suite",
    fullName: "outer > failed setup",
    project: child.project,
    module: parent,
    errors: () => [{ message: "original nested hook failure", stack: "original hook stack" }],
    state: () => "failed",
  } as TestSuite;
  const withSuite = module([child], {
    children: {
      allTests: () => [child].values(),
      allSuites: () => [suite].values(),
    } as TestModule["children"],
  });
  await reporter.onTestSuiteResult?.(suite);
  await reporter.onTestRunEnd?.([withSuite], [], "failed");
  const suites = rows(lines).filter((row) => row.kind === "suite");
  assert.equal(suites.length, 1);
  assert.equal(suites[0]!.outcome, "failed");
  assert.equal(suites[0]!.duration_ms, null);
  assert.ok(Array.isArray(suites[0]!.errors) && isRecord(suites[0]!.errors[0]));
  assert.equal(suites[0]!.errors[0].message, "original nested hook failure");
});

it("retains repeated definitions as distinct observations and reconciles end traversal", async () => {
  const { lines, reporter } = capture();
  const first = fixture(),
    second = fixture();
  await reporter.onTestCaseResult?.(first);
  await reporter.onTestCaseResult?.(second);
  await end(reporter, [module([first, second])]);
  const cases = rows(lines).filter((row) => row.kind === "test");
  assert.equal(cases.length, 2);
  assert.equal(cases[0]!.definition_id, cases[1]!.definition_id);
  assert.notEqual(cases[0]!.observation_index, cases[1]!.observation_index);
  assert.equal(cases[0]!.file, "src/example.test.ts");
  assert.equal(cases[0]!.duration_ms, 7);
  assert.equal(cases[0]!.start_time_ms, 1234);
  assert.equal(rows(lines).filter((row) => row.kind === "module").length, 1);
  assert.equal(rows(lines, true)[0]!.observed, 3);
  assert.equal(rows(lines, true)[0]!.source, "a".repeat(40));
  assert.equal(rows(lines, true)[0]!.checkout, null);
});

it("retains skipped notes, TODO mode and unfinished cases discovered at completion", async () => {
  const { lines, reporter } = capture();
  const skipped = fixture({
    result: () => ({ state: "skipped", errors: undefined, note: "platform unavailable" }),
  });
  const todo = fixture({
    options: { ...skipped.options, mode: "todo" },
    result: () => ({ state: "skipped", errors: undefined, note: undefined }),
  });
  const pending = fixture({
    result: () => ({ state: "pending", errors: undefined }),
    diagnostic: () => undefined,
  });
  await end(reporter, [module([skipped, todo, pending])]);
  const cases = rows(lines).filter((row) => row.kind === "test");
  assert.deepEqual(
    cases.map((row) => row.outcome),
    ["skipped", "skipped", "pending"],
  );
  assert.equal(cases[0]!.skip_reason, "platform unavailable");
  assert.equal(cases[1]!.mode, "todo");
  assert.equal(cases[1]!.skip_reason, null);
  assert.equal(cases[2]!.duration_ms, null);
  assert.equal(cases[2]!.start_time_ms, null);
});

it("preserves original test, collection and unhandled failures without changing them", async () => {
  const { lines, reporter } = capture();
  const original = Object.freeze({
    name: "Error",
    message: "original assertion",
    stack: "original stack",
    cause: Object.freeze({ message: "original cause" }),
  });
  const failed = fixture({ result: () => ({ state: "failed", errors: [original] }) });
  await reporter.onTestRunEnd?.(
    [module([failed], { state: () => "failed", errors: () => [original] })],
    [original],
    "failed",
  );
  const observations = rows(lines);
  for (const row of observations) {
    assert.equal(row.outcome, "failed");
    assert.ok(Array.isArray(row.errors));
    assert.ok(isRecord(row.errors[0]));
    assert.equal(row.errors[0].message, original.message);
    assert.equal(row.errors[0].stack, original.stack);
    assert.ok(isRecord(row.errors[0].cause));
    assert.equal(row.errors[0].cause.message, "original cause");
  }
  const context = rows(lines, true)[0]!;
  assert.equal(context.reason, "failed");
  assert.equal(context.unhandled_errors, 1);
  assert.ok(Array.isArray(context.original_unhandled_errors));
  assert.ok(isRecord(context.original_unhandled_errors[0]));
  assert.equal(context.original_unhandled_errors[0].message, original.message);
});

it("does not let unavailable writers or result accessors escape the reporter", async () => {
  const reporter = createFrontendCaseObservations(root, {
    write() {
      throw new Error("writer unavailable");
    },
  });
  await reporter.onTestCaseResult?.(fixture());
  await reporter.onTestRunEnd?.([module([fixture()])], [], "failed");
  const captured = capture();
  await captured.reporter.onTestCaseResult?.(
    fixture({
      result() {
        throw new Error("result unavailable");
      },
    }),
  );
  await end(captured.reporter);
  assert.equal(rows(captured.lines, true)[0]!.invalid, 1);
});

it("bounds record count and starts an independent invocation for each watch run", async () => {
  const { lines, reporter } = capture();
  for (let i = 0; i < 4100; i++) await reporter.onTestCaseResult?.(fixture());
  await end(reporter);
  assert.equal(rows(lines).length, 4096);
  assert.equal(rows(lines, true)[0]!.omitted, 4);
  const first = rows(lines, true)[0]!.invocation_id;
  lines.length = 0;
  await reporter.onTestRunStart?.([]);
  await reporter.onTestCaseResult?.(fixture());
  await end(reporter);
  assert.notEqual(rows(lines, true)[0]!.invocation_id, first);
  assert.equal(rows(lines, true)[0]!.observed, 1);
  assert.equal(rows(lines, true)[0]!.omitted, 0);
});

it("bounds total bytes, escaped oversized records and unhandled error context", async () => {
  const { lines, reporter } = capture();
  const large = { message: "m".repeat(1024), stack: "s".repeat(2048) };
  for (let i = 0; i < 1000; i++)
    await reporter.onTestCaseResult?.(
      fixture({ result: () => ({ state: "failed", errors: [large, large] }) }),
    );
  await reporter.onTestRunEnd?.(
    [],
    [
      { message: "\u0001".repeat(100000), stack: "\u0001".repeat(100000) },
      { message: "\u0001".repeat(100000), stack: "\u0001".repeat(100000) },
    ],
    "failed",
  );
  assert.ok(lines.every((line) => Buffer.byteLength(line) <= 16 * 1024));
  const context = rows(lines, true)[0]!;
  assert.ok(Number(context.bytes) <= 4 * 1024 * 1024);
  assert.ok(Number(context.omitted) > 0);
  assert.equal(
    context.bytes,
    lines.slice(0, -1).reduce((sum, line) => sum + Buffer.byteLength(line), 0),
  );
  assert.equal(context.omitted_unhandled_errors, 2);
});

it("keeps unknown paths and invalid durations unknown while hashing full definition names", async () => {
  const { lines, reporter } = capture();
  const first = fixture({
    fullName: "x".repeat(1500) + "a",
    module: module([], { moduleId: path.resolve(root, "../outside.test.ts") }),
    diagnostic: () => ({
      duration: Number.NaN,
      retryCount: -1,
      repeatCount: 0,
      slow: false,
      heap: undefined,
      startTime: 0,
      flaky: false,
    }),
  });
  await reporter.onTestCaseResult?.(first);
  await reporter.onTestCaseResult?.(fixture({ fullName: "x".repeat(1500) + "a" }));
  await reporter.onTestCaseResult?.(fixture({ fullName: "x".repeat(1500) + "b" }));
  await end(reporter);
  const result = rows(lines);
  assert.equal(result[0]!.file, null);
  assert.equal(result[0]!.definition_id, null);
  assert.equal(result[0]!.duration_ms, null);
  assert.equal(result[0]!.retry_count, null);
  assert.equal(result[1]!.name_truncated, true);
  assert.notEqual(result[1]!.definition_id, result[2]!.definition_id);
});

it("records the original Windows-only lifecycle case route without permitting a Windows skip or a wholly skipped UI file", async () => {
  const file = path.join(root, "apps/desktop/scripts/desktop-install-fixture.test.mts");
  const name = "lifecycle timeout terminates a ready descendant process tree within a second bound";
  const desktop = path.join(root, "apps/desktop");
  const declaration = declaredFrontendCaseSkip(file, desktop);
  assert.ok(declaration && declaration.category === "platform");
  assert.equal(declaration.platform, "win32");
  assert.deepEqual(declaration.cases, [name]);
  assert.equal(
    declaration.intended_route,
    "Windows: node scripts/run-viteplus.mts test --project unit (frontend:unit)",
  );
  assert.equal(
    declaredUiSkip(file, desktop),
    null,
    "case metadata must not widen whole-file UI permissions",
  );
  for (const platform of ["linux", "darwin", "win32"] as const) {
    assert.equal(frontendCaseSkipAllowed(declaration, {}, platform), platform !== "win32");
    assert.equal(
      frontendCaseSkipAllowed(declaration, { [browserTraceProbe.environment]: "1" }, platform),
      platform !== "win32",
    );
  }
  assert.equal(declaredFrontendCaseSkip(file + ".foreign", desktop), null);
  for (const actualName of [name, "replacement Windows skipped case"]) {
    const { reporter, lines } = capture();
    const test = fixture({
      fullName: actualName,
      module: { moduleId: file } as TestModule,
      result: () => ({
        state: "skipped",
        note: "original runner platform skip",
        errors: undefined,
      }),
    });
    await reporter.onTestCaseResult?.(test);
    await end(reporter, [module([test], { moduleId: file })]);
    const row = rows(lines).find((item) => item.kind === "test");
    assert.ok(row);
    assert.equal(row.outcome, "skipped");
    assert.equal(row.skip_reason, "original runner platform skip");
    assert.equal(row.unexpected_skip, actualName !== name || process.platform === "win32");
    assert.deepEqual(
      rows(lines, true)[0]?.missing_skip_routes,
      actualName === name
        ? []
        : [{ file: "apps/desktop/scripts/desktop-install-fixture.test.mts", cases: [name] }],
    );
    if (actualName === name) assert.deepEqual(row.skip_contract, declaration);
    else assert.equal(row.skip_contract, null);
  }
});

it("reports disappearance of the declared platform case without rewriting the original module outcome", async () => {
  const file = path.join(root, "apps/desktop/scripts/desktop-install-fixture.test.mts");
  const { reporter, lines } = capture();
  await end(reporter, [module([], { moduleId: file })]);
  assert.deepEqual(rows(lines, true)[0]?.missing_skip_routes, [
    {
      file: "apps/desktop/scripts/desktop-install-fixture.test.mts",
      cases: ["lifecycle timeout terminates a ready descendant process tree within a second bound"],
    },
  ]);
  assert.equal(rows(lines).find((item) => item.kind === "module")?.outcome, "passed");
});
