import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveUiSelection,
  reconcileUiSelection,
  allowedUiSkippedFiles,
  uiShuffleSeed,
} from "./ui-test-selection.mts";
import type { UiModuleObservation, UiRunObservation } from "./ui-test-selection.mts";

void test("shuffled diagnostics reject ambiguous or unbounded seeds before runner initialization", () => {
  for (const seed of [undefined, "", "-1", "1.5", "01", "Infinity", "4294967296", "1e2"])
    assert.throws(() => uiShuffleSeed(seed), /decimal seed/);
  assert.equal(uiShuffleSeed("0"), 0);
  assert.equal(uiShuffleSeed("4294967295"), 4294967295);
  const result = spawnSync(process.execPath, ["scripts/run-ui-tests.mts", "shuffled", "-1"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, PATH: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /decimal seed/);
  assert.doesNotMatch(result.stdout, /admitted|RUN|passed/);
});

void test("literal UI paths reject omissions, ambiguous filters and outside files before execution", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ui-selection-"));
  try {
    mkdirSync(path.join(root, "src"));
    const file = path.join(root, "src", "日本語.test.tsx");
    writeFileSync(file, "fixture");
    assert.deepEqual(
      resolveUiSelection(["src/日本語.test.tsx", file, "apps/desktop/src/日本語.test.tsx"], root),
      [file],
    );
    for (const input of ["src/missing.test.tsx", "src/*.test.tsx", "--filter", "src"])
      assert.throws(() => resolveUiSelection([file, input], root), /literal|missing|regular/);
    const outside = path.join(root, "..", path.basename(root) + ".test.tsx");
    writeFileSync(outside, "fixture");
    try {
      assert.throws(() => resolveUiSelection([outside], root), /outside/);
    } finally {
      rmSync(outside);
    }
    const source = path.join(root, "src", "source.tsx");
    writeFileSync(source, "source");
    assert.throws(() => resolveUiSelection([source], root), /test file/);
    assert.deepEqual(resolveUiSelection([source], root, "related"), [source]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const one = path.resolve("one.test.tsx");
const two = path.resolve("two.test.tsx");
const suite = (
  moduleId: string,
  state: "passed" | "skipped" | "failed" = "passed",
): UiModuleObservation => ({
  moduleId,
  state: () => state,
  ok: () => ["passed", "skipped"].includes(state),
  children: { allTests: () => [{ fullName: "control", result: () => ({ state }) }] },
});
const report = (testModules: UiModuleObservation[]): UiRunObservation => ({
  testModules,
  unhandledErrors: [],
});

void test("nonempty successful partial matches cannot claim the requested selection", () => {
  assert.throws(() => reconcileUiSelection(report([suite(one)]), [one, two]), /did not run/);
  assert.throws(() => reconcileUiSelection(report([suite(two)]), [one]), /Unexpected/);
  assert.throws(() => reconcileUiSelection(report([suite(one), suite(one)]), [one]), /duplicate/);
  assert.throws(
    () => reconcileUiSelection(report([suite(one, "skipped")]), [one]),
    /wholly skipped/,
  );
  assert.throws(() => reconcileUiSelection(report([suite(one, "failed")]), [one]), /failed/);
  assert.throws(
    () =>
      reconcileUiSelection({ ...report([suite(one)]), unhandledErrors: [new Error("unhandled")] }, [
        one,
      ]),
    /unsuccessful/,
  );
  assert.throws(
    () =>
      reconcileUiSelection(report([{ ...suite(one), children: { allTests: () => [] } }]), [one]),
    /no test evidence/,
  );
});

void test("complete selections distinguish observed suites, executed suites and skipped tests", () => {
  const selected = report([suite(one), suite(two, "skipped")]);
  assert.throws(() => reconcileUiSelection(selected, [one, two]), /wholly skipped/);
  const result = reconcileUiSelection(selected, [one, two], new Map([[two, "Owned diagnostic"]]));
  assert.deepEqual(result.requested_files, [one, two]);
  assert.deepEqual(result.discovered_files, [one, two]);
  assert.deepEqual(result.executed_files, [one]);
  assert.equal(result.passed, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.skipped_files, [{ file: two, reason: "Owned diagnostic" }]);
  assert.throws(
    () => reconcileUiSelection(selected, [one, two], new Map([[two, " "]])),
    /Invalid UI skipped-file permission/,
  );
  assert.throws(
    () => reconcileUiSelection(report([suite(one)]), [one], new Map([[two, "Foreign"]])),
    /Invalid UI skipped-file permission/,
  );
  assert.throws(
    () =>
      reconcileUiSelection(report([suite(two, "skipped")]), [two], new Map([[two, "Diagnostic"]])),
    /no runnable/,
  );
});

void test("only the exact disabled browser diagnostic receives an explicit skip reason", () => {
  const root = path.resolve("desktop");
  const probe = path.join(root, "src/browser/failure-probe.browser.test.tsx");
  const ordinary = path.join(root, "src/browser/ordinary.browser.test.tsx");
  const foreign = path.resolve("other/src/browser/failure-probe.browser.test.tsx");
  assert.deepEqual([...allowedUiSkippedFiles([ordinary, foreign], root, {})], []);
  assert.deepEqual(
    [...allowedUiSkippedFiles([probe], root, { VITE_PORTCOVE_BROWSER_TRACE_PROBE: "1" })],
    [],
  );
  const permissions = allowedUiSkippedFiles([probe, ordinary, foreign], root, {});
  assert.equal(permissions.size, 1);
  assert.match(permissions.get(probe) ?? "", /diagnostic/);
});

void test("exact wrapper rejects a mixed valid/missing request before invoking its runner", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/local-validation.mts",
      "test-ui",
      "apps/desktop/src/count-messages.test.ts",
      "apps/desktop/src/components/missing.test.tsx",
    ],
    { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: "" } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing or not regular/);
  assert.doesNotMatch(result.stdout, /passed|reused/);
});
