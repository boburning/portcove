import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  controlBridgeOriginalDeadline,
  inspectControlStepReadiness,
  retainControlStepLocator,
  controlReadyUploadRoute,
} from "./release-control-step-bridge.mts";
const expected = {
  phase: "site-publication",
  index: 3,
  run_id: "123",
  revision: "a".repeat(40),
  ref: "refs/tags/portcove-production-controller-fixture",
};
const ready = () => ({
  schema_version: 1,
  phase: expected.phase,
  facts_sha256: "b".repeat(64),
  producer: {
    workflow: ".github/workflows/application-update-production.yml",
    controller_revision: expected.revision,
    controller_ref: expected.ref,
    run_id: 123,
    run_attempt: 1,
    job_id: 456,
    check_run_id: 789,
  },
  round: { index: 3, nonce: "c".repeat(64) },
});
void test("fixed ready routing binds own source/run/phase/round without granting a control proof", () => {
  assert.equal(inspectControlStepReadiness(ready(), expected).authority, "none");
  for (const change of [
    { phase: "payload" },
    { index: 2 },
    { run_id: "124" },
    { revision: "d".repeat(40) },
    { ref: "refs/heads/main" },
  ])
    assert.throws(() => inspectControlStepReadiness(ready(), { ...expected, ...change }));
  const changed = ready();
  changed.producer.run_attempt = 2;
  assert.throws(() => inspectControlStepReadiness(changed, expected));
});
void test("trusted ready file crosses the fixed upload bridge; mutation and repeated locator refuse, settled producer skips unused rounds", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-step-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = ["RUNNER_TEMP", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_REF"];
  const original = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, i) => {
      if (original[i] === undefined) delete process.env[key];
      else process.env[key] = original[i];
    }),
  );
  Object.assign(process.env, {
    RUNNER_TEMP: root,
    GITHUB_RUN_ID: expected.run_id,
    GITHUB_SHA: expected.revision,
    GITHUB_REF: expected.ref,
  });
  const work = path.join(root, "actual-parent");
  await mkdir(work);
  const file = path.join(work, "ready-site-publication.json");
  await writeFile(file, JSON.stringify(ready()));
  const locator = await retainControlStepLocator(file, expected.phase, 3);
  const retained: unknown = JSON.parse(await readFile(locator, "utf8"));
  assert.deepEqual(retained, {
    path: file,
    sha256: createHash("sha256").update(JSON.stringify(ready())).digest("hex"),
  });
  const route = await controlReadyUploadRoute(root, expected.phase, 3, performance.now() + 1000);
  assert.deepEqual(route, {
    ready: true,
    path: file,
    name: "trusted-release-control-site-publication-ready-123-1-r3",
  });
  await assert.rejects(retainControlStepLocator(file, expected.phase, 3), /EEXIST/u);
  await writeFile(file, JSON.stringify({ ...ready(), facts_sha256: "d".repeat(64) }));
  await assert.rejects(
    controlReadyUploadRoute(root, expected.phase, 3, performance.now() + 1000),
    /bytes changed/u,
  );
  await writeFile(
    path.join(root, "release-control-site-publication-process-ended.json"),
    JSON.stringify({ exit_code: 2 }),
  );
  assert.deepEqual(
    await controlReadyUploadRoute(root, expected.phase, 4, performance.now() + 1000),
    { ready: false, producer_exit_code: 2 },
  );
});
void test("deadline refusal precedes any missing-file polling", async () => {
  await assert.rejects(
    controlReadyUploadRoute(path.resolve("unused"), expected.phase, 3, performance.now() - 1),
    /deadline/u,
  );
});

void test("readiness upload uses original provider start rather than allocating a fresh wait per round", (t) => {
  const keys = ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA"],
    before = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, i) => {
      if (before[i] === undefined) delete process.env[key];
      else process.env[key] = before[i];
    }),
  );
  Object.assign(process.env, {
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: expected.revision,
  });
  const start = Date.parse("2026-10-20T00:00:00Z");
  const job = {
    id: 77,
    run_id: 123,
    run_attempt: 1,
    head_sha: expected.revision,
    status: "in_progress",
    name: "Publish authenticated application site",
    started_at: new Date(start).toISOString(),
  };
  const raw = { total_count: 1, jobs: [job] };
  assert.equal(controlBridgeOriginalDeadline(raw, "site-publication", start + 50000, 1000), 241000);
  for (const bad of [
    { ...raw, total_count: 2 },
    { total_count: 2, jobs: [job, job] },
    { total_count: 1, jobs: [{ ...job, run_attempt: 2 }] },
    { total_count: 1, jobs: [{ ...job, name: "other" }] },
  ])
    assert.throws(() =>
      controlBridgeOriginalDeadline(bad, "site-publication", start + 50000, 1000),
    );
  for (const now of [start - 1, start + 290000])
    assert.throws(() => controlBridgeOriginalDeadline(raw, "site-publication", now, 1000));
});
