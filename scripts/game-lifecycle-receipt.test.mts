import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gameLifecycleChecks,
  verifyGameLifecyclePredicate,
  verifyGameLifecycleJob,
} from "./game-lifecycle-receipt.mts";

const expected = {
  preparation_sha256: "a".repeat(64),
  executable_sha256: "e".repeat(64),
  check_plan_sha256: "f".repeat(64),
  run_id: "1234567",
  run_attempt: 2,
  job_id: "12345678",
  platform: "windows-x86-64" as const,
  selected_at: 1010,
  now: 1100,
};

const valid = {
  schema: 1,
  preparation_sha256: expected.preparation_sha256,
  executable_sha256: expected.executable_sha256,
  check_plan_sha256: expected.check_plan_sha256,
  run_id: expected.run_id,
  run_attempt: expected.run_attempt,
  job_id: expected.job_id,
  platform: expected.platform,
  started_at: 1011,
  completed_at: 1050,
  checks: Object.fromEntries(
    gameLifecycleChecks.map((check) => [
      check,
      { outcome: "passed", evidence_sha256: "c".repeat(64) },
    ]),
  ),
};

void test("game lifecycle evidence needs the exact pair, native job and all mandatory results", () => {
  assert.deepEqual(verifyGameLifecyclePredicate(valid, expected), {
    started_at: 1011,
    completed_at: 1050,
    preparation_sha256: expected.preparation_sha256,
    reports: gameLifecycleChecks.map((check) => ({ check, sha256: "c".repeat(64) })),
  });
  for (const change of [
    { preparation_sha256: "b".repeat(64) },
    { executable_sha256: "b".repeat(64) },
    { check_plan_sha256: "b".repeat(64) },
    { run_attempt: 1 },
    { job_id: "999999" },
    { run_id: "999999" },
    { platform: "linux-x86-64" },
    { started_at: 1009 },
    { completed_at: 1101 },
    { checks: { ...valid.checks, "launch-and-close": "skipped" } },
    { checks: { ...valid.checks, "retain-and-reopen-predecessor": "failed" } },
    { checks: { "launch-and-close": "passed" } },
    { catalog_admission: true },
  ]) {
    assert.throws(() => verifyGameLifecyclePredicate({ ...valid, ...change }, expected));
  }
  assert.equal(verifyGameLifecyclePredicate(valid, { ...expected, now: 87450 }).completed_at, 1050);
});

void test("game lifecycle must match the original successful standard runner job", () => {
  const source_commit = "b".repeat(40);
  const attempt = {
    id: Number(expected.run_id),
    run_attempt: expected.run_attempt,
    repository: { id: 1354613114 },
    path: ".github/workflows/game-lifecycle-qualification.yml",
    head_branch: "main",
    head_sha: source_commit,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
  };
  const job = {
    id: Number(expected.job_id),
    run_id: Number(expected.run_id),
    run_attempt: expected.run_attempt,
    head_sha: source_commit,
    name: "Exact game lifecycle (Windows x64)",
    status: "completed",
    conclusion: "success",
    labels: ["windows-2022"],
    started_at: new Date(1010 * 1000).toISOString(),
    completed_at: new Date(1060 * 1000).toISOString(),
  };
  const binding = { ...expected, source_commit };
  assert.deepEqual(verifyGameLifecycleJob(attempt, job, binding), {
    started: 1010,
    completed: 1060,
  });
  for (const change of [
    { id: 999 },
    { run_attempt: 1 },
    { labels: ["self-hosted", "windows-2022"] },
    { conclusion: "failure" },
    { started_at: "invalid" },
  ])
    assert.throws(() => verifyGameLifecycleJob(attempt, { ...job, ...change }, binding));
  assert.throws(() => verifyGameLifecycleJob({ ...attempt, event: "pull_request" }, job, binding));
  assert.throws(() =>
    verifyGameLifecycleJob(
      { ...attempt, path: ".github/workflows/application-release-native.yml" },
      job,
      binding,
    ),
  );
});
