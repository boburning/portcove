import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveUiSelection, reconcileUiSelection } from "./ui-test-selection.mjs";

test("literal UI paths reject omissions, ambiguous filters and outside files before execution", () => {
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
const suite = (moduleId, state = "passed") => ({
  moduleId,
  state: () => state,
  ok: () => ["passed", "skipped"].includes(state),
  children: { allTests: () => [{ fullName: "control", result: () => ({ state }) }] },
});
const report = (testModules) => ({ testModules, unhandledErrors: [] });

test("nonempty successful partial matches cannot claim the requested selection", () => {
  assert.throws(() => reconcileUiSelection(report([suite(one)]), [one, two]), /did not run/);
  assert.throws(() => reconcileUiSelection(report([suite(two)]), [one]), /Unexpected/);
  assert.throws(
    () => reconcileUiSelection(report([suite(one), suite(one)], 2, 2), [one]),
    /duplicate/,
  );
  assert.throws(
    () => reconcileUiSelection(report([suite(one, "skipped")], 0, 1), [one]),
    /no runnable/,
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

test("complete selections distinguish observed suites, executed suites and skipped tests", () => {
  const result = reconcileUiSelection(report([suite(one), suite(two, "skipped")], 1, 2), [
    one,
    two,
  ]);
  assert.deepEqual(result.requested_files, [one, two]);
  assert.deepEqual(result.discovered_files, [one, two]);
  assert.deepEqual(result.executed_files, [one]);
  assert.equal(result.passed, 1);
  assert.equal(result.skipped, 1);
});

test("exact wrapper rejects a mixed valid/missing request before invoking its runner", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/local-validation.mjs",
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
