import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  inspectSitePublicationReservation,
  runSitePublicationController,
} from "./release-site-controller.mts";
import { siteOriginalJobDeadline } from "./release-site-job-budget.mts";
import { launchFixedSiteController } from "./release-site-launch.mts";
import { prepareSiteDeploymentFromActualTufPublication } from "./release-site-deployment.mts";

void test("site artifact upload requires the exact promoting source, counters, compiler run and frozen review", () => {
  const candidate = {
    phase: "promoting",
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    prepared_commit: "c".repeat(40),
    prepared_tree: "d".repeat(40),
    version: "0.1.0-beta.1",
    intent_sha256: "e".repeat(64),
    release_run: { run_id: 123, attempt: 1, revision: "c".repeat(40) },
    transient_retries: 0,
    substantive_repairs: 0,
    frozen_opportunity: { source: "complete frozen review" },
  };
  const result = {
    candidate: Object.fromEntries(
      Object.entries(candidate).filter(([key]) => !["phase", "frozen_opportunity"].includes(key)),
    ),
  };
  const facts = { opportunity: candidate.frozen_opportunity };
  const actual = inspectSitePublicationReservation({ active_candidate: candidate }, result, facts);
  assert.equal(actual.authority, "none");
  for (const changed of [
    { ...candidate, phase: "publishing" },
    { ...candidate, source_tree: "f".repeat(40) },
    { ...candidate, transient_retries: 1 },
    { ...candidate, substantive_repairs: 1 },
    { ...candidate, release_run: { ...candidate.release_run, run_id: 124 } },
    { ...candidate, frozen_opportunity: { source: "later unrelated opportunity" } },
  ])
    assert.throws(() =>
      inspectSitePublicationReservation({ active_candidate: changed }, result, facts),
    );
  assert.throws(() =>
    inspectSitePublicationReservation({ active_candidate: candidate }, result, {}),
  );
});

void test("copied TUF/result/site claims cannot create a publisher or release any upload readiness", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "site-controller-import-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await assert.rejects(
    runSitePublicationController({}, {}, {}, parent, performance.now() + 10000),
    /actual keyless/u,
  );
  await assert.rejects(
    prepareSiteDeploymentFromActualTufPublication({}, {}, parent, performance.now() + 10000),
    /actual keyless/u,
  );
  assert.deepEqual(await readdir(parent), []);
});

void test("expired phase refuses before filesystem/provider/configuration work", async () => {
  for (const deadline of [NaN, -1, performance.now() - 1])
    await assert.rejects(
      runSitePublicationController({}, {}, {}, path.resolve("unused"), deadline),
      /phase exhausted/u,
    );
});

void test("Pages job budget counts prior setup and refuses partial, duplicate, wrong-source and expired observations", () => {
  const start = Date.parse("2026-10-20T00:00:00Z"),
    identity = { run_id: "123", controller_revision: "a".repeat(40) };
  const job = {
    id: 77,
    run_id: 123,
    run_attempt: 1,
    head_sha: identity.controller_revision,
    name: "Publish authenticated application site",
    status: "in_progress",
    started_at: new Date(start).toISOString(),
  };
  const raw = { total_count: 1, jobs: [job] };
  assert.equal(siteOriginalJobDeadline(raw, identity, start + 35000, 1000), 256000);
  for (const bad of [
    { ...raw, total_count: 2 },
    { total_count: 2, jobs: [job, job] },
    { total_count: 2, jobs: [job, { ...job, id: 78 }] },
    ...[
      { run_id: 124 },
      { run_attempt: 2 },
      { head_sha: "b".repeat(40) },
      { name: "other site job" },
      { status: "completed" },
    ].map((change) => ({ total_count: 1, jobs: [{ ...job, ...change }] })),
  ])
    assert.throws(() => siteOriginalJobDeadline(bad, identity, start + 35000, 1000));
  for (const now of [start - 1, start + 290000, NaN])
    assert.throws(() => siteOriginalJobDeadline(raw, identity, now, 1000));
});
void test("fixed verified Pages launcher refuses copied fields and expired phase before provider IO", async () => {
  await assert.rejects(launchFixedSiteController({}, path.resolve("unused")), /fields differ/u);
  await assert.rejects(launchFixedSiteController({}, path.resolve("unused"), -1), /deadline/u);
});
