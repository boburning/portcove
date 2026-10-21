import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { inspectCompiledCliPackage } from "./release-compiler-outputs.mts";
import { compiledCliTarFixture as tar } from "./fixtures/compiled-cli-fixture.mts";
const identity = (bytes: Buffer) => ({
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
const binary = Buffer.from("inert compiler output; never execute");
void test("fixed single ZIP/TAR member matches actual captured compiler bytes without executing or extracting it", () => {
  for (const [platform, archive] of [
    ["windows-x86_64", createAuditZip([["portcove.exe", binary]])],
    ["linux-x86_64", gzipSync(tar(binary))],
  ] as const) {
    const result = inspectCompiledCliPackage(
      archive,
      platform,
      identity(archive),
      identity(binary),
    );
    assert.equal(result.binary_sha256, identity(binary).sha256);
    assert.equal(result.authority, "none");
    assert.match(result.scope, /no compiler\/producer\/native acceptance/);
    assert.throws(() =>
      inspectCompiledCliPackage(
        archive,
        platform,
        identity(archive),
        identity(Buffer.from("different")),
      ),
    );
  }
});
void test("TAR extensions/links/sparse/raw oversized declarations refuse before semantic entry buffering", () => {
  for (const type of ["x", "g", "L", "K", "S", "1", "2"]) {
    const decoded = tar(binary);
    decoded[156] = type.charCodeAt(0);
    decoded.write("77777777777\0", 124, "ascii");
    const archive = gzipSync(decoded);
    assert.throws(
      () => inspectCompiledCliPackage(archive, "linux-x86_64", identity(archive), identity(binary)),
      /unsupported/,
    );
  }
});
void test("raw header checksum, extra trailing members, missing terminal records and changed archive identity refuse", () => {
  for (const decoded of [
    (() => {
      const value = tar(binary);
      value[100] = value[100]! ^ 1;
      return value;
    })(),
    Buffer.concat([tar(binary), Buffer.from("unlisted member")]),
    tar(binary).subarray(0, 1024),
  ]) {
    const archive = gzipSync(decoded);
    assert.throws(() =>
      inspectCompiledCliPackage(archive, "linux-x86_64", identity(archive), identity(binary)),
    );
  }
  const archive = gzipSync(tar(binary));
  assert.throws(
    () =>
      inspectCompiledCliPackage(
        archive,
        "linux-x86_64",
        { ...identity(archive), sha256: "0".repeat(64) },
        identity(binary),
      ),
    /independently acquired/,
  );
});
void test("near-boundary valid terminal padding passes while larger decoded gzip fails its producer-derived bound", () => {
  const one = Buffer.from("x"),
    decoded = tar(one);
  const padded = Buffer.concat([decoded, Buffer.alloc(16384 - decoded.length)]),
    archive = gzipSync(padded);
  inspectCompiledCliPackage(archive, "linux-x86_64", identity(archive), identity(one));
  const tooLarge = gzipSync(Buffer.alloc(16896));
  assert.throws(() =>
    inspectCompiledCliPackage(tooLarge, "linux-x86_64", identity(tooLarge), identity(one)),
  );
});
void test("actual GNU tar producer emits the supported exact single-member route", async (t) => {
  const version = spawnSync("tar", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (version.status !== 0 || !version.stdout.includes("GNU tar")) {
    t.skip("GNU producer is not installed on this host");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-compiler-tar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "portcove"), binary, { mode: 0o755 });
  const generated = spawnSync(
    "tar",
    ["--format=gnu", "-czf", path.join(root, "package.tar.gz"), "-C", root, "portcove"],
    { encoding: "utf8", timeout: 5000, maxBuffer: 4096 },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const archive = await readFile(path.join(root, "package.tar.gz"));
  inspectCompiledCliPackage(archive, "linux-x86_64", identity(archive), identity(binary));
});
import {
  projectWindowsNsisExecutable,
  inspectWindowsDesktopCompilerIdentity,
} from "./release-compiler-desktop.mts";

void test("Windows compiler NSIS projection hashes the single slot without changing captured bytes", () => {
  const bytes = Buffer.concat([
    Buffer.from([0, 1, 255]),
    Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK"),
    Buffer.from([255, 0]),
  ]);
  const original = Buffer.from(bytes);
  const projected = projectWindowsNsisExecutable(bytes);
  assert.deepEqual(bytes, original);
  const installed = Buffer.from(bytes);
  installed.write("NSS", projected.bundle_slot_offset + "__TAURI_BUNDLE_TYPE_VAR_".length, "ascii");
  assert.equal(projected.nsis_sha256, createHash("sha256").update(installed).digest("hex"));
  assert.deepEqual(inspectWindowsDesktopCompilerIdentity(projected), projected);
  assert.throws(() => projectWindowsNsisExecutable(Buffer.from("missing slot")));
  assert.throws(() => projectWindowsNsisExecutable(Buffer.concat([bytes, bytes])));
  assert.throws(() =>
    inspectWindowsDesktopCompilerIdentity({ ...projected, bundle_slot_offset: bytes.length }),
  );
  assert.throws(() =>
    inspectWindowsDesktopCompilerIdentity({ ...projected, nsis_sha256: projected.sha256 }),
  );
});
