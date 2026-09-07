import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { exceedsTestBudget } from "./test-duration-reporter.mjs";
import { checkVitestDurations } from "./check-vitest-durations.mjs";

function event(duration, type = "test") {
  return { type: "test:pass", data: { name: "fixture", details: { type, duration_ms: duration } } };
}

test("individual duration is bounded without imposing a suite duration limit", () => {
  assert.equal(exceedsTestBudget(event(5_000)), false);
  assert.equal(exceedsTestBudget(event(5_001)), true);
  assert.equal(exceedsTestBudget(event(50_000, "suite")), false);
  assert.equal(exceedsTestBudget({ ...event(5_001), type: "test:fail" }), true);
  assert.equal(exceedsTestBudget({ ...event(5_001), type: "test:diagnostic" }), false);
  assert.equal(exceedsTestBudget({ type: "test:pass", data: { ...event(5_001).data, skip: true } }), false);
});

test("a synchronous over-budget result fails the reporter process", () => {
  const reporter = new URL("./test-duration-reporter.mjs", import.meta.url).href;
  const script = `import report from ${JSON.stringify(reporter)};
    async function* source() { yield ${JSON.stringify(event(5_001))}; }
    for await (const line of report(source())) process.stdout.write(line);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", windowsHide: true, timeout: 3_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Unit-test budget exceeded/);
});

test("UI timing rejects slow, missing and incomplete measurements", () => {
  const report = duration => ({
    success: true, numPassedTests: 1,
    testResults: [{ assertionResults: [{ status: "passed", fullName: "fixture", duration }] }],
  });
  assert.deepEqual(checkVitestDurations(report(5_000)), { count: 1, longest: 5_000 });
  assert.throws(() => checkVitestDurations(report(5_001)), /exceeded/);
  assert.throws(() => checkVitestDurations(report(undefined)), /Missing duration/);
  assert.throws(() => checkVitestDurations({ ...report(1), numPassedTests: 2 }), /Incomplete/);
  assert.throws(() => checkVitestDurations({ ...report(1), success: false }), /successful run/);
});
