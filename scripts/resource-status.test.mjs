import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectResourceStatus } from "./resource-status.mjs";
import { writeFileSync } from "node:fs";

test("PID reuse is observed without reclaiming the recorded lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-status-"));
  const heavy = path.join(root, "heavy");
  const native = path.join(root, "native");
  const bytes = JSON.stringify({
    format_version: 1,
    token: "owned",
    process: { pid: 123, identity: "original" },
    child: null,
    created_at: "2026-10-09T00:00:00Z",
    workspace: "owned",
    command: "cargo test",
  });
  try {
    await mkdir(heavy);
    await writeFile(path.join(heavy, "owner.json"), bytes);
    const result = await collectResourceStatus({
      paths: { heavy, native },
      inspectIdentity: () => "reused",
    });
    assert.equal(result.resources[0].verification, "identity-mismatch");
    assert.equal(await readFile(path.join(heavy, "owner.json"), "utf8"), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing, malformed, changing and unavailable records never produce an availability claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-observations-"));
  const paths = { heavy: path.join(root, "heavy"), native: path.join(root, "native") };
  const file = path.join(paths.heavy, "owner.json");
  const owner = {
    format_version: 1,
    token: "original",
    process: { pid: 123, identity: "matching" },
    child: null,
    created_at: "2026-10-09T00:00:00Z",
  };
  try {
    assert.equal((await collectResourceStatus({ paths })).resources[0].verification, "unknown");
    await mkdir(paths.heavy);
    await writeFile(file, JSON.stringify(owner));
    assert.equal(
      (await collectResourceStatus({ paths, inspectIdentity: () => "matching" })).resources[0]
        .verification,
      "verified-live",
    );
    assert.equal(
      (await collectResourceStatus({ paths, inspectIdentity: () => null })).resources[0]
        .verification,
      "recorded-process-absent",
    );
    const unavailable = await collectResourceStatus({
      paths,
      inspectIdentity: () => {
        throw new Error("probe timed out");
      },
    });
    assert.equal(unavailable.resources[0].observation, "unavailable");
    const changed = await collectResourceStatus({
      paths,
      inspectIdentity: () => {
        writeFileSync(file, JSON.stringify({ ...owner, token: "foreign" }));
        return "matching";
      },
    });
    assert.equal(changed.resources[0].observation, "changed");
    assert.equal(changed.resources[0].verification, "unknown");
    assert.equal(JSON.parse(await readFile(file)).token, "foreign");
    await writeFile(file, "malformed");
    assert.equal((await collectResourceStatus({ paths })).resources[0].observation, "unavailable");
    await mkdir(paths.native);
    await writeFile(
      path.join(paths.native, "owner.json"),
      JSON.stringify({
        format_version: 1,
        token: "native",
        pid: 123,
        created_at: owner.created_at,
      }),
    );
    const native = (await collectResourceStatus({ paths, isProcessAlive: () => true }))
      .resources[1];
    assert.equal(native.verification, "unknown");
    assert.equal(native.processes[0].verification, "pid-only");
    assert.equal(native.processes[0].observedPresent, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
