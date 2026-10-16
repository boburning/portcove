import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isSlowTest } from "./test-duration-reporter.mts";

function event(duration, type = "test") {
  return {
    type: "test:pass",
    data: { name: "fixture", details: { type, duration_ms: duration } },
  };
}

test("individual slow tests are identified independently of suite duration", () => {
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

test("a synchronous slow result is reported without failing a correct test", () => {
  const reporter = new URL("./test-duration-reporter.mts", import.meta.url).href;
  const script = `import report from ${JSON.stringify(reporter)};
    async function* source() { yield ${JSON.stringify(event(5_001))}; }
    for await (const line of report(source())) process.stdout.write(line);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Slow tests to investigate/);
});

test("an abnormal worker exit retains bounded status and remains a failed run", (t) => {
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
    { encoding: "utf8", windowsHide: true, timeout: 3_000, env },
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
