import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const script = fileURLToPath(new URL("release-handshake-hosted-fixture.mts", import.meta.url));
void test("credential-free background fixture retains its private sentinel across fixed round-trip steps and settles", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "handshake-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, RUNNER_TEMP: root };
  const child = spawn(process.execPath, [script, "start"], { env, stdio: "ignore" });
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const directory = path.join(root, "portcove-handshake-fixture");
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await readFile(path.join(directory, "ready.json"));
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("fixture readiness expired");
      await setTimeout(25);
    }
  }
  await mkdir(path.join(directory, "roundtrip"));
  await copyFile(
    path.join(directory, "ready.json"),
    path.join(directory, "roundtrip", "ready.json"),
  );
  const complete = spawnSync(process.execPath, [script, "complete"], {
    env: { ...env, FIXTURE_ARTIFACT_ID: "1234", FIXTURE_ARTIFACT_DIGEST: "a".repeat(64) },
    timeout: 5000,
  });
  assert.equal(complete.status, 0, complete.stderr.toString());
  assert.equal(await exit, 0);
  const check = spawnSync(process.execPath, [script, "check"], { env, timeout: 5000 });
  assert.equal(check.status, 0, check.stderr.toString());
  const result: unknown = JSON.parse(
    await readFile(path.join(directory, "qualified.json"), "utf8"),
  );
  assert.deepEqual(result, {
    scope: "credential-free-hosted-process-fixture",
    process_settled: true,
    artifact_id: "1234",
    artifact_digest: "a".repeat(64),
    authority: "none",
  });
  assert.notEqual(
    spawnSync(process.execPath, [script, "complete"], { env, timeout: 5000 }).status,
    0,
  );
});
void test("ordinary hosted fixture has fixed small artifact handoff and no privileged production inputs", async () => {
  const text = await readFile(
    new URL("../.github/workflows/release-handshake-fixture.yml", import.meta.url),
    "utf8",
  );
  const document = parseDocument(text, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  assert.equal(document.getIn(["jobs", "fixture", "timeout-minutes"]), 1);
  assert.doesNotMatch(
    text,
    /secrets\.|id-token:|create-github-app-token|workflow_dispatch|environment:/,
  );
  assert.match(text, /nohup node scripts\/release-handshake-hosted-fixture.mts start/);
  assert.match(text, /artifact-ids:.*upload.outputs.artifact-id/);
  assert.match(text, /retention-days: 7/);
  assert.match(text, /overwrite: false/);
});
