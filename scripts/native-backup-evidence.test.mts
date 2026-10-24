import assert from "node:assert/strict";

import { readFile, readdir, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";

import os from "node:os";
import path from "node:path";
import { encodeHostedEvidence, recoverHostedEvidence } from "./native-backup-evidence.mts";

import { requiredFixture } from "./ci-workflow-fixture.mts";

void test("decoded hosted evidence recovers exact PNG bytes and rejects wrong run or missing terminal data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-hosted-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = {
    source: "a".repeat(40),
    controller: "b".repeat(40),
    base: "c".repeat(40),
    run: "42",
    attempt: "1",
    job: "hosted_history",
    phase: "native",
    binding_sha256: "d".repeat(64),
  };
  const input = path.join(root, "input");
  await mkdir(input);
  await writeFile(path.join(input, "binding.json"), JSON.stringify(expected));
  await writeFile(
    path.join(input, "execution.json"),
    JSON.stringify({ ...expected, phase: "native", exit_code: 0 }),
  );
  // Codec unit fixture, never native acceptance evidence.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTfcAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(path.join(input, "fixture.png"), png);
  await mkdir(path.join(input, "native", "library"), { recursive: true });
  await writeFile(
    path.join(input, "native", "library", "portcove.sqlite3"),
    "runtime state, not evidence",
  );
  await mkdir(path.join(input, "native", "webview"));
  await writeFile(path.join(input, "native", "webview", "Cache"), "runtime state, not evidence");
  const encoded = await encodeHostedEvidence(input);
  const decodedLog = encoded
    .split("\n")
    .map((line) => `2026-10-08T00:00:00Z ${line}`)
    .join("\n");
  const output = path.join(root, "decoded");
  assert.equal((await recoverHostedEvidence(decodedLog, output, expected)).exit_code, 0);
  assert.deepEqual(await readFile(path.join(output, "fixture.png")), png);
  assert.equal((await readdir(output)).includes("native"), false);
  for (const patch of [{ phase: "audit" }, { job: "hosted_audit" }])
    await assert.rejects(
      () =>
        recoverHostedEvidence(decodedLog, path.join(root, requiredFixture(Object.keys(patch)[0])), {
          ...expected,
          ...patch,
        }),
      /differs/,
    );
  await assert.rejects(
    () =>
      recoverHostedEvidence(decodedLog, path.join(root, "wrong-run"), { ...expected, run: "43" }),
    /run differs/,
  );
  await rm(path.join(input, "execution.json"));
  await assert.rejects(
    async () =>
      recoverHostedEvidence(
        await encodeHostedEvidence(input),
        path.join(root, "partial"),
        expected,
      ),
    /terminal/,
  );
  // Reject Windows directory junctions without requiring symlink privileges.
  // Unix retains the file-symlink rejection fixture.
  await symlink(
    process.platform === "win32" ? input : path.join(input, "fixture.png"),
    path.join(input, "linked.png"),
    process.platform === "win32" ? "junction" : "file",
  );
  await assert.rejects(() => encodeHostedEvidence(input), /links/);
});

void test("hosted evidence rejects malformed matching identities while retaining decoded failure evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosted-identity-shape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input");
  await mkdir(input);
  const identity = {
    source: "a".repeat(40),
    controller: "b".repeat(40),
    base: "c".repeat(40),
    run: "42",
    attempt: "1",
    job: "hosted_compiled",
    phase: "compiled",
    binding_sha256: "d".repeat(64),
  };
  for (const [index, patch] of [
    { source: 42 },
    { controller: null },
    { phase: 42 },
    { job: {} },
  ].entries()) {
    const malformed = { ...identity, ...patch };
    await writeFile(path.join(input, "binding.json"), JSON.stringify(malformed));
    await writeFile(
      path.join(input, "execution.json"),
      JSON.stringify({ ...malformed, exit_code: 0 }),
    );
    const destination = path.join(root, `failure-${index}`);
    await assert.rejects(
      recoverHostedEvidence(await encodeHostedEvidence(input), destination, malformed),
      /Invalid expected hosted evidence identity/u,
    );
    assert.deepEqual(
      await readFile(path.join(destination, "binding.json")),
      await readFile(path.join(input, "binding.json")),
    );
    assert.deepEqual(
      await readFile(path.join(destination, "execution.json")),
      await readFile(path.join(input, "execution.json")),
    );
  }
});
