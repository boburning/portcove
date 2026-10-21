import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  tufRoleControllerDeadline,
  runTufRoleController,
  runFixedTufRoleConfiguration,
  requirePreparedTufRoleOutput,
} from "./release-tuf-controller.mts";
import { launchFixedTufController } from "./release-tuf-launch.mts";
import { controllerOidcSubject } from "./assembler-job-identity.mts";
import {
  tufOriginalJobDeadline,
  payloadOriginalJobDeadline,
  classificationOriginalJobDeadline,
  buildingOriginalJobDeadline,
} from "./release-signing-job-budget.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
const ref = "refs/tags/portcove-production-controller-test",
  identity = {
    audience: "portcove-capacity-executor",
    subject: controllerOidcSubject(ref, "production-tuf-releases"),
    controller_revision: "a".repeat(40),
    controller_ref: ref,
    actor_id: "1234",
    run_id: "12345",
    run_attempt: 1,
  };
void test("fixed role job budget includes setup time and refuses partial, stale, duplicate or cross-role provider jobs", () => {
  const started = Date.parse("2026-10-20T00:00:00Z");
  for (const role of ["releases", "preview", "stable", "snapshot", "timestamp"] as const) {
    const job = {
      id: 501,
      run_id: Number(identity.run_id),
      run_attempt: 1,
      head_sha: identity.controller_revision,
      status: "in_progress",
      started_at: new Date(started).toISOString(),
      name: releaseControlPhaseProfile(`tuf-${role}`).reader_name,
    };
    const inventory = { total_count: 1, jobs: [job] };
    assert.equal(tufOriginalJobDeadline(role, inventory, identity, started + 35000, 1000), 81000);
    for (const bad of [
      { ...inventory, total_count: 2 },
      { total_count: 2, jobs: [job, job] },
      { total_count: 2, jobs: [job, { ...job, id: 502 }] },
      { total_count: 1, jobs: [{ ...job, run_attempt: 2 }] },
      { total_count: 1, jobs: [{ ...job, head_sha: "b".repeat(40) }] },
      { total_count: 1, jobs: [{ ...job, run_id: 777 }] },
      { total_count: 1, jobs: [{ ...job, name: "caller-selected signer" }] },
      { total_count: 1, jobs: [{ ...job, status: "completed" }] },
    ])
      assert.throws(() => tufOriginalJobDeadline(role, bad, identity, started + 35000, 1000));
    for (const time of [started - 1, started + 115000])
      assert.throws(() => tufOriginalJobDeadline(role, inventory, identity, time, 1000), /budget/);
  }
  assert.throws(() => tufOriginalJobDeadline("root", {}, identity), /role/);
});
void test("payload fixed job budget counts earlier tools/setup and keeps the original ten-minute cleanup reserve", () => {
  const started = Date.parse("2026-10-20T00:00:00Z");
  const job = {
    id: 501,
    run_id: Number(identity.run_id),
    run_attempt: 1,
    head_sha: identity.controller_revision,
    status: "in_progress",
    started_at: new Date(started).toISOString(),
    name: releaseControlPhaseProfile("payload").reader_name,
  };
  const inventory = { total_count: 1, jobs: [job] };
  assert.equal(payloadOriginalJobDeadline(inventory, identity, started + 120000, 1000), 451000);
  for (const now of [started - 1, started + 570000])
    assert.throws(() => payloadOriginalJobDeadline(inventory, identity, now, 1000), /budget/);
  assert.throws(
    () =>
      payloadOriginalJobDeadline(
        {
          ...inventory,
          jobs: [{ ...job, name: releaseControlPhaseProfile("tuf-releases").reader_name }],
        },
        identity,
        started + 1000,
        1000,
      ),
    /start/,
  );
});
void test("fixed TUF phase only tightens a live original deadline and keeps selected two-minute cleanup reserve", () => {
  const now = performance.now();
  assert.ok(tufRoleControllerDeadline() < now + 115010);
  const deadline = now + 1000;
  assert.equal(tufRoleControllerDeadline(deadline), deadline);
  assert.ok(tufRoleControllerDeadline(now + 500000) < now + 115010);
  for (const bad of [Infinity, NaN, now - 1])
    assert.throws(() => tufRoleControllerDeadline(bad), /deadline/u);
});
void test("role callable refuses imported tools/output and wrong dependencies before any role key or output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuf-controller-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    runTufRoleController("releases", identity, {}, {}, [], root),
    /actual same-process/u,
  );
  await assert.rejects(
    runTufRoleController("snapshot", identity, {}, {}, [], root),
    /dependencies/u,
  );
  await assert.rejects(
    requirePreparedTufRoleOutput({ decision: "role-output-prepared" }),
    /actual TUF/u,
  );
  assert.deepEqual(await readdir(root), []);
});
void test("fixed source entry/launcher reject arbitrary commands, offline roles and expired phases before provider effects", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuf-controller-fields-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = {
    role: "releases",
    identity,
    tools: { artifact: {}, bundle: {} },
    context: {},
    dependencies: [],
  };
  for (const raw of [
    { ...input, command: "candidate.sh" },
    { ...input, role: "root" },
    { ...input, role: "targets" },
  ]) {
    await assert.rejects(runFixedTufRoleConfiguration(raw, root));
    await assert.rejects(launchFixedTufController(raw, root));
  }
  await assert.rejects(launchFixedTufController(input, root, performance.now() - 1), /deadline/u);
  await assert.rejects(
    runFixedTufRoleConfiguration(input, root, performance.now() - 1),
    /deadline/u,
  );
  assert.deepEqual(await readdir(root), []);
});

void test("classification original job clocks keep their own names, first attempt and two-minute reserve", () => {
  const started = Date.parse("2026-10-20T00:00:00Z");
  for (const [role, name] of [
    ["writer", "Persist independently reviewed classification"],
    ["observer", "Observe release input protections"],
  ] as const) {
    const job = {
      id: 501,
      run_id: Number(identity.run_id),
      run_attempt: 1,
      head_sha: identity.controller_revision,
      status: "in_progress",
      started_at: new Date(started).toISOString(),
      name,
    };
    const inventory = { total_count: 1, jobs: [job] };
    assert.equal(
      classificationOriginalJobDeadline(role, inventory, identity, started + 35000, 1000),
      81000,
    );
    for (const changed of [
      { name: "caller job" },
      { run_attempt: 2 },
      { head_sha: "b".repeat(40) },
      { started_at: new Date(started + 36000).toISOString() },
    ])
      assert.throws(() =>
        classificationOriginalJobDeadline(
          role,
          { ...inventory, jobs: [{ ...job, ...changed }] },
          identity,
          started + 35000,
          1000,
        ),
      );
    assert.throws(() =>
      classificationOriginalJobDeadline(role, inventory, identity, started + 115000, 1000),
    );
    assert.throws(() =>
      classificationOriginalJobDeadline(
        role,
        { ...inventory, total_count: 2 },
        identity,
        started + 35000,
        1000,
      ),
    );
    assert.throws(() => tufOriginalJobDeadline(`classification-${role}`, inventory, identity));
  }
});

void test("building admission original clock includes tools/acquisition and reserves cleanup inside seven minutes", () => {
  const started = Date.parse("2026-10-20T00:00:00Z");
  const job = {
    id: 501,
    run_id: Number(identity.run_id),
    run_attempt: 1,
    head_sha: identity.controller_revision,
    status: "in_progress",
    started_at: new Date(started).toISOString(),
    name: "Authenticate release control inputs",
  };
  assert.equal(
    buildingOriginalJobDeadline({ total_count: 1, jobs: [job] }, identity, started + 100000, 1000),
    306000,
  );
  for (const bad of [
    { ...job, name: "Sign admitted updater payloads" },
    { ...job, run_attempt: 2 },
    { ...job, head_sha: "b".repeat(40) },
  ])
    assert.throws(() =>
      buildingOriginalJobDeadline(
        { total_count: 1, jobs: [bad] },
        identity,
        started + 100000,
        1000,
      ),
    );
  assert.throws(() =>
    buildingOriginalJobDeadline({ total_count: 1, jobs: [job] }, identity, started + 405000, 1000),
  );
  assert.throws(() =>
    tufOriginalJobDeadline("candidate-building", { total_count: 1, jobs: [job] }, identity),
  );
});
