import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectReleaseArtifacts, writeReleaseChecksums } from "./write-release-checksums.mjs";

async function fixture(t, label = "macos-aarch64") {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-checksums-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "release-assets"), { recursive: true });
  await mkdir(path.join(root, "target/release/bundle/dmg"), { recursive: true });
  await mkdir(path.join(root, "target/release/bundle/macos/Portcove.app/Contents/Resources"), { recursive: true });
  await writeFile(path.join(root, "release-assets", `portcove-${label}.tar.gz`), "cli");
  await writeFile(path.join(root, "target/release/bundle/dmg/Portcove_0.1.0_aarch64.dmg"), "desktop");
  await writeFile(path.join(root, "target/release/bundle/macos/Portcove.app/Contents/Resources/icon.icns"), "internal");
  return root;
}

test("hashes distributable packages and ignores internal application files", async t => {
  const root = await fixture(t);
  const result = await writeReleaseChecksums(root, "macos-aarch64");
  assert.deepEqual(result.artifacts.map(artifact => path.basename(artifact)), [
    "Portcove_0.1.0_aarch64.dmg",
    "portcove-macos-aarch64.tar.gz",
  ]);
  const manifest = await readFile(result.output, "utf8");
  assert.match(manifest, /^[a-f0-9]{64}  portcove-macos-aarch64\.tar\.gz$/m);
  assert.match(manifest, /^[a-f0-9]{64}  Portcove_0\.1\.0_aarch64\.dmg$/m);
  assert.doesNotMatch(manifest, /icon\.icns/);
});

test("rejects duplicate package filenames before publishing", async t => {
  const root = await fixture(t, "linux-x86_64");
  await mkdir(path.join(root, "target/release/bundle/other"), { recursive: true });
  await writeFile(path.join(root, "target/release/bundle/other/Portcove_0.1.0_aarch64.dmg"), "duplicate");
  await assert.rejects(
    collectReleaseArtifacts(root, "linux-x86_64"),
    /duplicate filename: Portcove_0\.1\.0_aarch64\.dmg/,
  );
});

test("fails closed when the CLI archive or desktop package is missing", async t => {
  const root = await fixture(t, "windows-x86_64");
  const cliArchive = path.join(root, "release-assets/portcove-windows-x86_64.tar.gz");
  await rm(cliArchive);
  await assert.rejects(collectReleaseArtifacts(root, "windows-x86_64"), /exactly one CLI archive/);

  await writeFile(cliArchive, "cli");
  await rm(path.join(root, "target/release/bundle/dmg/Portcove_0.1.0_aarch64.dmg"));
  await assert.rejects(collectReleaseArtifacts(root, "windows-x86_64"), /at least one desktop package/);
});
