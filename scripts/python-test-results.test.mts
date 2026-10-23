import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { readPythonReport, runPythonSuite } from "./python-test-results.mts";
import { isRecord } from "./runtime-values.mts";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";

function fixture(t: TestContext, source: string) {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "portcove-python-results-"));
  const suite = path.join(root, "cases.test.py");
  writeFileSync(suite, `import unittest\n${source}\n`);
  return suite;
}

function execute(suite: string) {
  return spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-S", "-B", fileURLToPath(new URL("./python-test-results.py", import.meta.url)), suite],
    { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 3 * 1024 * 1024 },
  );
}

void test("Python cases retain selected identities, skips, expected failures and subtests", (t) => {
  const suite = fixture(
    t,
    `class Cases(unittest.TestCase):
    def test_pass(self):
        self.assertEqual(2 + 2, 4)
    @unittest.skip("POSIX execution is owned by Linux qualification")
    def test_skip(self):
        self.fail("must not execute")
    @unittest.expectedFailure
    def test_expected(self):
        self.fail("known diagnostic")
    def test_parameters(self):
        for value in (1, 2):
            with self.subTest(value=value):
                self.assertGreater(value, 0)
`,
  );
  const diagnostics: string[] = [];
  const report = runPythonSuite(suite, {
    name: "outer-control",
    diagnostic: (line) => diagnostics.push(String(line)),
  });
  assert.deepEqual(report.selected, [
    "Cases.test_expected",
    "Cases.test_parameters",
    "Cases.test_pass",
    "Cases.test_skip",
  ]);
  assert.equal(report.tests_run, 4);
  assert.equal(report.cases.filter((item) => item.kind === "test").length, 4);
  assert.equal(report.cases.filter((item) => item.kind === "subtest").length, 2);
  assert.equal(
    report.cases.find((item) => item.status === "skipped")?.reason,
    "POSIX execution is owned by Linux qualification",
  );
  assert.ok(report.cases.some((item) => item.status === "expected-failure"));
  assert.ok(
    report.cases.every((item) =>
      item.kind === "subtest" ? item.duration_ms === null : Number(item.duration_ms) >= 0,
    ),
  );
  const joined = diagnostics
    .filter((line) => line.startsWith("Python case: "))
    .map((line): unknown => JSON.parse(line.slice("Python case: ".length)));
  assert.equal(joined.length, 6);
  const inventory: unknown = JSON.parse(
    diagnostics
      .find((line) => line.startsWith("Python inventory: "))!
      .slice("Python inventory: ".length),
  );
  assert.ok(isRecord(inventory));
  assert.equal(inventory.reporter_sha256, report.reporter_sha256);
  assert.equal(inventory.python, report.python);
  assert.equal(inventory.platform, report.platform);
  assert.ok(
    joined.every(
      (item) =>
        isRecord(item) &&
        item.outer === "outer-control" &&
        item.source === suite &&
        item.source_sha256 === report.source_sha256,
    ),
  );
});

void test("Python failure, error, unexpected success and failed subtest keep the outer suite failed", (t) => {
  const suite = fixture(
    t,
    `class Cases(unittest.TestCase):
    def test_assertion(self):
        self.fail("original assertion")
    def tearDown(self):
        if self._testMethodName == "test_assertion":
            raise RuntimeError("secondary teardown failure")
    def test_error(self):
        raise ValueError("original error")
    def test_subtest_error(self):
        with self.subTest(phase="error"):
            raise ValueError("original subtest error")
    @unittest.expectedFailure
    def test_unexpected(self):
        pass
    def test_subtests(self):
        for value in (1, 2):
            with self.subTest(value=value):
                self.assertEqual(value, 1, "original subtest")
    def test_z_after(self):
        pass
`,
  );
  const result = execute(suite);
  assert.equal(result.status, 1, result.stderr);
  const report = readPythonReport(result.stdout, suite, result.status);
  assert.equal(report.tests_run, 6);
  assert.ok(
    report.cases.some(
      (item) =>
        item.kind === "subtest" &&
        item.status === "error" &&
        item.reason?.includes("original subtest error"),
    ),
  );
  assert.ok(
    report.cases.some((item) => item.id === "Cases.test_z_after" && item.status === "passed"),
  );
  for (const reason of ["original assertion", "original error", "original subtest"])
    assert.ok(
      report.cases.some((item) => item.reason?.includes(reason)),
      reason,
    );
  assert.ok(
    report.cases
      .find((item) => item.id === "Cases.test_assertion")
      ?.additional_outcomes.some((item) => item.reason.includes("secondary teardown failure")),
  );
  assert.ok(report.cases.some((item) => item.status === "unexpected-success"));
  const diagnostics: string[] = [];
  assert.throws(
    () =>
      runPythonSuite(suite, {
        name: "failed-outer",
        diagnostic: (line) => diagnostics.push(String(line)),
      }),
    /original status=1/u,
  );
  assert.ok(
    diagnostics.some(
      (line) => line.startsWith("Python case: ") && line.includes('"status":"failed"'),
    ),
  );
});

void test("Python fixture errors remain visible without claiming selected methods executed", (t) => {
  const suite = fixture(
    t,
    `class Cases(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raise RuntimeError("setup refused")
    def test_never(self):
        self.fail("must not execute")
`,
  );
  const result = execute(suite);
  assert.equal(result.status, 1, result.stderr);
  const report = readPythonReport(result.stdout, suite, result.status);
  assert.deepEqual(report.selected, ["Cases.test_never"]);
  assert.equal(report.tests_run, 0);
  assert.deepEqual(
    report.cases.map(({ kind, status }) => ({ kind, status })),
    [{ kind: "fixture", status: "error" }],
  );
  assert.match(report.cases[0]!.reason!, /setup refused/u);
  assert.equal(report.cases[0]!.duration_ms, null);
});

void test("Python reporting rejects empty inventories, import failure and unstructured stdout", (t) => {
  for (const source of [
    "pass",
    'raise ValueError("import refused")',
    'print("unexpected stdout")\nclass Cases(unittest.TestCase):\n    def test_one(self): pass',
  ]) {
    const suite = fixture(t, source);
    assert.throws(
      () => runPythonSuite(suite, { name: "invalid-outer", diagnostic: () => {} }),
      /reporting incomplete; original status=/u,
    );
  }
});

void test("Python report corruption cannot replace a failed process outcome or source identity", (t) => {
  const suite = fixture(
    t,
    'class Cases(unittest.TestCase):\n    def test_one(self): self.fail("original failure")',
  );
  const result = execute(suite);
  assert.equal(result.status, 1);
  const report: unknown = JSON.parse(result.stdout);
  assert.ok(isRecord(report));
  for (const changed of [
    { ...report, exit_status: 0 },
    { ...report, source_sha256: "0".repeat(64) },
    { ...report, cases: [] },
    { ...report, selected: [] },
    { ...report, tests_run: 7 },
    { ...report, duration_ms: -1 },
    { ...report, platform: "wrong-platform" },
  ])
    assert.throws(() => readPythonReport(JSON.stringify(changed), suite, result.status));
  assert.throws(() => readPythonReport(result.stdout.slice(0, -10), suite, result.status));
  assert.throws(
    () => readPythonReport(" ".repeat(2 * 1024 * 1024 + 1), suite, result.status),
    /byte limit/u,
  );
});

void test("Python reporting failure keeps the original failed outcome and later independent execution", (t) => {
  const suite = fixture(
    t,
    `import json
class Cases(unittest.TestCase):
    def test_a_original_failure(self):
        def broken_report(*args, **kwargs):
            raise RuntimeError("REPORTING_FAILED")
        self.addCleanup(setattr, json, "dumps", broken_report)
        self.fail("ORIGINAL_FAILED_OUTCOME")
    def test_z_after(self):
        pass
`,
  );
  const result = execute(suite);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /ORIGINAL_FAILED_OUTCOME/u);
  assert.match(result.stderr, /REPORTING_FAILED/u);
  assert.match(result.stderr, /test_z_after.*ok/u);
  const diagnostics: string[] = [];
  assert.throws(
    () =>
      runPythonSuite(suite, {
        name: "reporting-failure-outer",
        diagnostic: (line) => diagnostics.push(String(line)),
      }),
    /reporting incomplete; original status=1/u,
  );
  assert.ok(
    diagnostics.some(
      (line) => line.includes("ORIGINAL_FAILED_OUTCOME") && line.includes("REPORTING_FAILED"),
    ),
  );
});

void test("Python partial execution cannot establish a complete successful report", (t) => {
  const suite = fixture(
    t,
    `class Cases(unittest.TestCase):
    def test_a_stops(self):
        self._outcome.result.stop()
    def test_z_unexecuted(self):
        self.fail("must remain unexecuted")
`,
  );
  const result = execute(suite);
  assert.equal(result.status, 0, "preserve the original unittest suite result");
  assert.throws(
    () => readPythonReport(result.stdout, suite, result.status),
    /Unexecuted Python selections/u,
  );
  assert.throws(
    () =>
      runPythonSuite(suite, {
        name: "partial-outer",
        diagnostic: () => {},
      }),
    /reporting incomplete; original status=0/u,
  );
});

void test("an unrelated fixture skip cannot excuse another class's unexecuted Python selection", (t) => {
  const suite = fixture(
    t,
    `class A(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raise unittest.SkipTest("class A is unavailable")
    def test_unavailable(self):
        self.fail("must remain skipped")
class B(unittest.TestCase):
    def test_a_stops(self):
        self._outcome.result.stop()
    def test_z_unexecuted(self):
        self.fail("must remain unexecuted")
`,
  );
  const result = execute(suite);
  assert.equal(result.status, 0, "retain the original unittest suite outcome");
  assert.throws(
    () => readPythonReport(result.stdout, suite, result.status),
    /Unexecuted Python selections/u,
  );
});

void test("Python class and module setup skips explain only their owned selections", (t) => {
  for (const source of [
    `class A(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raise unittest.SkipTest("class A is unavailable")
    def test_unavailable(self):
        self.fail("must remain skipped")
class B(unittest.TestCase):
    def test_available(self):
        pass
`,
    `def setUpModule():
    raise unittest.SkipTest("module is unavailable")
class A(unittest.TestCase):
    def test_unavailable(self):
        self.fail("must remain skipped")
`,
  ]) {
    const suite = fixture(t, source);
    const result = execute(suite);
    assert.equal(result.status, 0, result.stderr);
    const report = readPythonReport(result.stdout, suite, result.status);
    const fixtures = report.cases.filter((item) => item.kind === "fixture");
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0]!.status, "skipped");
    assert.equal(fixtures[0]!.duration_ms, null);
    assert.match(fixtures[0]!.reason!, /is unavailable/u);
    assert.equal(report.tests_run, source.startsWith("class") ? 1 : 0);
  }
});

void test("Python reporter limits retain original failures, partial cases and suite outcome", (t) => {
  for (const source of [
    `class Cases(unittest.TestCase):
    def test_a_fills_report(self):
        for value in range(2050):
            with self.subTest(value=value):
                self.assertGreaterEqual(value, 0)
    def test_z_first_failure(self):
        self.fail("ORIGINAL_ASSERTION")
`,
    `class Cases(unittest.TestCase):
    def test_a_overflow(self):
        for value in range(2050):
            with self.subTest(value=value):
                self.assertNotEqual(value, 0, "ORIGINAL_ASSERTION")
    def test_z_after(self):
        pass
`,
    `class Cases(unittest.TestCase):
    def test_cleanup(self):
        def failed_cleanup():
            raise RuntimeError("SECONDARY_CLEANUP")
        for _ in range(20):
            self.addCleanup(failed_cleanup)
        self.fail("ORIGINAL_ASSERTION")
`,
  ]) {
    const suite = fixture(t, source);
    const result = execute(suite);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /ORIGINAL_ASSERTION/u);
    const report = readPythonReport(result.stdout, suite, result.status);
    assert.equal(report.suite_exit_status, 1);
    assert.match(report.incomplete_reason!, /exceeds .*limit/u);
    assert.ok(report.cases.length <= 2048);
    assert.ok(report.cases.some((item) => item.reason?.includes("ORIGINAL_ASSERTION")));
    let originalSeen = false;
    assert.throws(
      () =>
        runPythonSuite(suite, {
          name: "overflow-outer",
          diagnostic: (line) => {
            if (
              String(line).startsWith("Python case: ") &&
              String(line).includes("ORIGINAL_ASSERTION")
            )
              originalSeen = true;
          },
        }),
      /reporting incomplete; original suite status=1/u,
    );
    assert.ok(originalSeen);
  }
});

void test("Python outcome overflow retains the first actual error after skipped cleanups", (t) => {
  const suite = fixture(
    t,
    `class Cases(unittest.TestCase):
    def test_a_cleanup_outcomes(self):
        def failed_cleanup(reason):
            raise RuntimeError(reason)
        def skipped_cleanup():
            raise unittest.SkipTest("secondary skip")
        self.addCleanup(failed_cleanup, "SECOND_ACTUAL_ERROR")
        self.addCleanup(failed_cleanup, "FIRST_ACTUAL_ERROR")
        for _ in range(16):
            self.addCleanup(skipped_cleanup)
        raise unittest.SkipTest("initial skip")
    def test_z_after(self):
        pass
`,
  );
  const result = execute(suite);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FIRST_ACTUAL_ERROR/u);
  const report = readPythonReport(result.stdout, suite, result.status);
  assert.equal(report.suite_exit_status, 1);
  assert.match(report.incomplete_reason!, /outcome limit/u);
  const first = report.cases.find((item) => item.id === "Cases.test_a_cleanup_outcomes")!;
  assert.ok(first.additional_outcomes.length <= 16);
  assert.ok(first.additional_outcomes.some((item) => item.reason.includes("FIRST_ACTUAL_ERROR")));
  assert.ok(!first.additional_outcomes.some((item) => item.reason.includes("SECOND_ACTUAL_ERROR")));
  assert.ok(
    report.cases.some((item) => item.id === "Cases.test_z_after" && item.status === "passed"),
  );
});

void test("Python record overflow retains the first failure after skipped subtests fill the report", (t) => {
  const suite = fixture(
    t,
    `class Cases(unittest.TestCase):
    def test_a_skips(self):
        for value in range(2047):
            with self.subTest(value=value):
                raise unittest.SkipTest("subtest is unavailable")
        raise unittest.SkipTest("method is unavailable")
    def test_z_first_failure(self):
        self.fail("FIRST_FAILURE_AFTER_ALL_SKIPS")
`,
  );
  const result = execute(suite);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FIRST_FAILURE_AFTER_ALL_SKIPS/u);
  const report = readPythonReport(result.stdout, suite, result.status);
  assert.equal(report.suite_exit_status, 1);
  assert.match(report.incomplete_reason!, /record limit/u);
  assert.ok(report.cases.length <= 2048);
  assert.ok(report.cases.some((item) => item.reason?.includes("FIRST_FAILURE_AFTER_ALL_SKIPS")));
});

void test("Python reporter changes refuse provenance", (t) => {
  const suite = fixture(
    t,
    `from unittest.mock import patch
from pathlib import Path
original_read = Path.read_bytes
class Cases(unittest.TestCase):
    def test_changed_reporter(self):
        def changed(filename):
            result = original_read(filename)
            return result + b"changed" if filename.name == "python-test-results.py" else result
        patch.object(Path, "read_bytes", changed).start()
`,
  );
  const result = execute(suite);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Python reporter changed during execution/u);
  assert.equal(result.stdout, "");
});
