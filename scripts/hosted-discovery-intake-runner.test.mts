import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readHostedOutcomes,
  runHostedIntakePasses,
  runHostedIntakeWorker,
} from "./hosted-discovery-intake-runner.mts";

const outcome = (
  request: number,
  continuation: "inventory_changed" | "budget_exhausted" | null = null,
  progress: string | null = null,
) => ({ request, status: continuation ? "incomplete" : "complete", continuation, progress });
const report = (...outcomes: ReturnType<typeof outcome>[]) => ({
  status: outcomes.every((o) => o.status === "complete") ? "passed" : "incomplete",
  requests: outcomes.length,
  outcomes,
});
void test("a progressing logical batch finishes beyond three inventory windows without operator reruns", () => {
  let passes = 0;
  const result = runHostedIntakePasses(() => {
    passes++;
    return report(outcome(17, passes < 6 ? "inventory_changed" : null, String(passes).repeat(64)));
  });
  assert.equal(result.status, "passed");
  assert.equal(passes, 6);
});
void test("the wall deadline and pass ceiling stop even continuously progressing workers", () => {
  let now = 0,
    calls = 0;
  const timed = runHostedIntakePasses(
    (_pass, _requests, remaining) => {
      assert(remaining <= 90 * 60000);
      calls++;
      now += 31 * 60000;
      return report(outcome(1, "inventory_changed", String(calls).padStart(64, "0")));
    },
    () => now,
  );
  assert.equal(timed.status, "incomplete");
  assert.equal(timed.stop_reason, "deadline");
  assert.equal(calls, 3);
  calls = 0;
  const capped = runHostedIntakePasses(() =>
    report(outcome(1, "inventory_changed", String(++calls).padStart(64, "0"))),
  );
  assert.equal(capped.stop_reason, "pass_limit");
  assert.equal(calls, 12);
});
void test("fresh passes drain transient holds and give the exhausted tail priority", () => {
  const calls: unknown[] = [];
  const result = runHostedIntakePasses((pass, requests) => {
    calls.push(requests);
    return pass === 1
      ? report(outcome(1), outcome(2, "inventory_changed"), outcome(3, "budget_exhausted"))
      : report(outcome(3), outcome(2));
  });
  assert.deepEqual(calls, [null, [3, 2]]);
  assert.equal(result.status, "passed");
});
void test("hard-held requests remain incomplete while independent requests finish", () => {
  let passes = 0;
  const result = runHostedIntakePasses(() =>
    ++passes === 1
      ? report({ ...outcome(1), status: "incomplete" }, outcome(2, "inventory_changed"))
      : report(outcome(2)),
  );
  assert.equal(passes, 2);
  assert.equal(result.status, "incomplete");
  assert.equal(result.outcomes[0]!.status, "incomplete");
});
void test("three snapshot passes are finite and repeated budget exhaustion without progress stops", () => {
  let passes = 0;
  assert.equal(
    runHostedIntakePasses(() => {
      passes++;
      return report(outcome(1, "inventory_changed"));
    }).status,
    "incomplete",
  );
  assert.equal(passes, 3);
  passes = 0;
  runHostedIntakePasses(() => {
    passes++;
    return report(outcome(1, "budget_exhausted", "a".repeat(64)));
  });
  assert.equal(passes, 2);
});
void test("missing, forged, inconsistent or crashed worker evidence never retries", () => {
  for (const value of [
    null,
    {},
    report(outcome(1), outcome(1)),
    { ...report(outcome(1)), status: "incomplete" },
    { ...report(outcome(1)), outcomes: [{ ...outcome(1), continuation: "http_error" }] },
  ])
    assert.throws(() => readHostedOutcomes(value));
  let calls = 0;
  assert.throws(() =>
    runHostedIntakePasses(() => {
      calls++;
      throw new Error("worker killed after POST");
    }),
  );
  assert.equal(calls, 1);
  assert.throws(() =>
    runHostedIntakePasses((pass) =>
      pass === 1 ? report(outcome(1, "inventory_changed")) : report(outcome(2)),
    ),
  );
});
void test("read-only queue movement gets bounded fresh reads without losing hard holds", () => {
  const changed = {
    status: "incomplete",
    requests: 0,
    outcomes: [],
    queue_continuation: "inventory_changed",
  };
  let passes = 0;
  const result = runHostedIntakePasses((pass, requests) => {
    passes++;
    if (pass === 1)
      return report({ ...outcome(1), status: "incomplete" }, outcome(2, "inventory_changed"));
    assert.deepEqual(requests, [2]);
    return pass === 2 ? changed : report(outcome(2));
  });
  assert.equal(passes, 3);
  assert.equal(result.status, "incomplete");
  assert.equal(runHostedIntakePasses(() => changed).status, "incomplete");
});
void test("a read-only queue budget hold resumes while unsupported queue failures stop", () => {
  let calls = 0;
  const result = runHostedIntakePasses(() =>
    ++calls === 1
      ? { status: "incomplete", requests: 0, outcomes: [], queue_continuation: "budget_exhausted" }
      : report(outcome(17)),
  );
  assert.equal(result.status, "passed");
  assert.equal(calls, 2);
  assert.throws(
    () =>
      runHostedIntakePasses(() => ({
        status: "incomplete",
        requests: 0,
        outcomes: [],
        queue_continuation: "http_error",
      })),
    /Malformed queue/u,
  );
});
void test("real worker exit/report/probe paths fail closed after a crash or signal", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hosted-worker-"));
  mkdirSync(path.join(root, "scripts"));
  const worker = path.join(root, "scripts/hosted-discovery-intake.mts");
  const directory = path.join(root, "work");
  const run = (source: string) => {
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(
      worker,
      `import {mkdirSync,writeFileSync} from 'node:fs';
      const dir='work/pass-'+process.env.HOSTED_INTAKE_PASS;mkdirSync(dir,{recursive:true});
      ${source}`,
    );
    return () => runHostedIntakeWorker(root, directory, 1, [17]);
  };
  try {
    const valid = JSON.stringify(report(outcome(17)));
    assert.deepEqual(
      readHostedOutcomes(run(`writeFileSync(dir+'/summary.json',${JSON.stringify(valid)});`)()),
      [outcome(17)],
    );
    assert.throws(
      run(`writeFileSync(dir+'/summary.json',${JSON.stringify(valid)});process.exit(2);`),
      /qualified outcome/u,
    );
    assert.throws(
      run(`writeFileSync(dir+'/confirmed-post','17');process.exit(1);`),
      /without a continuation report/u,
    );
    assert.throws(run(`process.kill(process.pid,'SIGTERM');`), /qualified outcome/u);
    assert.throws(
      run(`writeFileSync(dir+'/summary.json',${JSON.stringify(valid)});process.exit(1);`),
      /disagree/u,
    );
    assert.deepEqual(run(`writeFileSync(dir+'/write-probe.json','{}');`)(), {
      status: "passed",
      requests: 0,
      outcomes: [],
    });
    assert.throws(() => runHostedIntakeWorker(root, directory, 1, null), /already exists/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
