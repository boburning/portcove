import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isSlowTest } from "./test-duration-reporter.mjs";
import { checkVitestDurations } from "./check-vitest-durations.mjs";

function event(duration, type = "test") {
  return { type: "test:pass", data: { name: "fixture", details: { type, duration_ms: duration } } };
}

test("individual slow tests are identified independently of suite duration", () => {
  assert.equal(isSlowTest(event(5_000)), false);
  assert.equal(isSlowTest(event(5_001)), true);
  assert.equal(isSlowTest(event(50_000, "suite")), false);
  assert.equal(isSlowTest({ ...event(5_001), type: "test:fail" }), true);
  assert.equal(isSlowTest({ ...event(5_001), type: "test:diagnostic" }), false);
  assert.equal(isSlowTest({ type: "test:pass", data: { ...event(5_001).data, skip: true } }), false);
});

test("a synchronous slow result is reported without failing a correct test", () => {
  const reporter = new URL("./test-duration-reporter.mjs", import.meta.url).href;
  const script = `import report from ${JSON.stringify(reporter)};
    async function* source() { yield ${JSON.stringify(event(5_001))}; }
    for await (const line of report(source())) process.stdout.write(line);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", windowsHide: true, timeout: 3_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Slow tests to investigate/);
});

test("UI timing reports slow tests and rejects missing or incomplete measurements", () => {
  const report = duration => ({
    success: true, numPassedTests: 1,
    testResults: [{ assertionResults: [{ status: "passed", fullName: "fixture", duration }] }],
  });
  assert.deepEqual(checkVitestDurations(report(5_000)), { count: 1, longest: 5_000, slow: [] });
  assert.deepEqual(checkVitestDurations(report(5_001)).slow, [{ name: "fixture", duration: 5_001 }]);
  assert.throws(() => checkVitestDurations(report(undefined)), /Missing duration/);
  assert.throws(() => checkVitestDurations({ ...report(1), numPassedTests: 2 }), /Incomplete/);
  assert.throws(() => checkVitestDurations({ ...report(1), success: false }), /successful run/);
});
