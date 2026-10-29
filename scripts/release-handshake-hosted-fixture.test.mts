import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const child = spawn(process.execPath, [script, "start"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  });
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
  assert.equal(await exit, 0, stderr);
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

void test("paused completion publication stays invisible until its complete no-clobber link", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "handshake-paused-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, RUNNER_TEMP: root };
  const directory = path.join(root, "portcove-handshake-fixture");
  const paused = path.join(root, "paused.json");
  const release = path.join(root, "release");
  const preload = path.join(root, "pause-link.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout } from "node:timers/promises";
import { retainReleaseRoutingMarker } from ${JSON.stringify(new URL("./release-routing-marker.mts", import.meta.url).href)};
const original = fs.link;
fs.link = async (staging, destination) => {
  if (destination === ${JSON.stringify(path.join(directory, "completion-input.json"))}) {
    await retainReleaseRoutingMarker(${JSON.stringify(paused)}, { staging, destination });
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await fs.stat(${JSON.stringify(release)}); break; }
      catch (error) {
        if (error.code !== "ENOENT" || Date.now() > deadline) throw error;
        await setTimeout(10);
      }
    }
  }
  return original(staging, destination);
};
syncBuiltinESMExports();
`,
    { flag: "wx" },
  );
  let stderr = "";
  const launch = (args: string[]) => {
    const child = spawn(process.execPath, args, {
      env: { ...env, FIXTURE_ARTIFACT_ID: "1234", FIXTURE_ARTIFACT_DIGEST: "a".repeat(64) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    return { child, exit };
  };
  const waitFor = async (file: string) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        return await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() > deadline)
          throw error;
        await setTimeout(10);
      }
    }
  };
  const background = launch([script, "start"]);
  await waitFor(path.join(directory, "ready.json"));
  await mkdir(path.join(directory, "roundtrip"));
  await copyFile(path.join(directory, "ready.json"), path.join(directory, "roundtrip/ready.json"));
  const complete = launch(["--import", preload, script, "complete"]);
  const publication: unknown = JSON.parse(await waitFor(paused));
  assert.ok(publication && typeof publication === "object" && "staging" in publication);
  assert.equal(typeof publication.staging, "string");
  const staged: unknown = JSON.parse(await readFile(String(publication.staging), "utf8"));
  assert.ok(staged && typeof staged === "object" && "artifact_id" in staged);
  assert.equal(staged.artifact_id, "1234");
  await assert.rejects(readFile(path.join(directory, "completion-input.json")), { code: "ENOENT" });
  // Span more than two real reader polls while the actual publisher is paused.
  await setTimeout(250);
  assert.equal(background.child.exitCode, null, stderr);
  await assert.rejects(readFile(path.join(directory, "completion-input.json")), { code: "ENOENT" });
  await writeFile(release, "release", { flag: "wx" });
  assert.equal(await complete.exit, 0, stderr);
  assert.equal(await background.exit, 0, stderr);
  const check = spawnSync(process.execPath, [script, "check"], { env, timeout: 5000 });
  assert.equal(check.status, 0, check.stderr.toString());
  const before = await readFile(path.join(directory, "completion-input.json"));
  const duplicate = spawnSync(process.execPath, [script, "complete"], {
    env: { ...env, FIXTURE_ARTIFACT_ID: "1234", FIXTURE_ARTIFACT_DIGEST: "a".repeat(64) },
    timeout: 5000,
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr.toString(), /EEXIST/u);
  assert.deepEqual(await readFile(path.join(directory, "completion-input.json")), before);
});
