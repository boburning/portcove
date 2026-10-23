import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCiMetrics } from "./ci-metrics.mts";
import { baselineTestEnvironment } from "./ci-baseline.mts";

void test(
  "a stuck inner child reports its timeout and exits before the maintained outer budget",
  { timeout: 20_000 },
  (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "portcove-nested-timeout-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fixture = path.join(root, "timeout.test.mjs");
    writeFileSync(
      fixture,
      `import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
test('inner timeout keeps stderr and joins its child', () => {
  const result=spawnSync(process.execPath,['-e','console.log(process.pid); console.error("inner-ready"); setInterval(()=>{},1000)'],{encoding:'utf8',timeout:2000,killSignal:'SIGKILL',windowsHide:true});
  assert.equal(result.error?.code,'ETIMEDOUT');
  assert.match(result.stderr,/inner-ready/);
  const pid=Number(result.stdout.trim()); assert.ok(Number.isInteger(pid)&&pid>0);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  console.log('inner-timeout-reported-and-joined');
});\n`,
    );
    const env = baselineTestEnvironment();
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "--test-timeout=10000", fixture], {
      encoding: "utf8",
      env,
      timeout: 15_000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /inner-timeout-reported-and-joined/);
  },
);

void test("fixture subprocess timings cannot contaminate the hosted batch report", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-fixture-timing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    PORTCOVE_CI_METRICS_DIR: directory,
    GITHUB_RUN_ID: "actual-run",
  };
  const metrics = createCiMetrics({ environment });
  const isolated = baselineTestEnvironment(environment);
  assert.equal(isolated.GITHUB_RUN_ID, "actual-run");
  assert.equal(environment.PORTCOVE_CI_METRICS_DIR, directory);
  const child = metrics.measure("repository-contract-tests", () =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {createCiMetrics} from "./scripts/ci-metrics.mts"; createCiMetrics().record("synthetic-failed-phase", {outcome:"failed"});',
      ],
      { cwd: new URL("..", import.meta.url), env: isolated, encoding: "utf8" },
    ),
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readdirSync(directory).length, 1, "only actual parent batch diagnostics survive");
});
