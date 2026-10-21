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
