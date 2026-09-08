import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectReleaseArtifacts,
  stageReleaseArtifacts,
  writeReleaseChecksums,
} from "./write-release-checksums.mjs";
import { artifactName, loadPackagePolicy, packagesForPlatform } from "./release-package-policy.mjs";

const policy = await loadPackagePolicy();
const fixtureVersion = "0.1.0-alpha.2";

async function fixture(t, label = "macos-aarch64") {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-checksums-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "release-assets"), { recursive: true });
  await mkdir(path.join(root, "release"), { recursive: true });
  await copyFile(new URL("../release/package-policy.json", import.meta.url), path.join(root, "release/package-policy.json"));
  await mkdir(path.join(root, "target/release/bundle/packages"), { recursive: true });
  await mkdir(path.join(root, "target/release/bundle/macos/Portcove.app/Contents/Resources"), { recursive: true });
  for (const entry of packagesForPlatform(policy, label)) {
    const rootName = entry.interface === "cli" ? "release-assets" : "target/release/bundle/packages";
    await writeFile(path.join(root, rootName, artifactName(entry, fixtureVersion)), `${entry.interface}:${entry.id}`);
  }
  await writeFile(path.join(root, "target/release/bundle/macos/Portcove.app/Contents/Resources/icon.icns"), "internal");
  return root;
}

test("hashes distributable packages and ignores internal application files", async t => {
  const root = await fixture(t);
  const result = await writeReleaseChecksums(root, "macos-aarch64", fixtureVersion);
  assert.deepEqual(result.artifacts.map(artifact => path.basename(artifact)), [
    "Portcove_0.1.0-alpha.2_aarch64.dmg",
    "portcove-cli-0.1.0-alpha.2-macos-aarch64.tar.gz",
  ]);
  const manifest = await readFile(result.output, "utf8");
  assert.match(manifest, /^[a-f0-9]{64}  portcove-cli-0\.1\.0-alpha\.2-macos-aarch64\.tar\.gz$/m);
  assert.match(manifest, /^[a-f0-9]{64}  Portcove_0\.1\.0-alpha\.2_aarch64\.dmg$/m);
  assert.doesNotMatch(manifest, /icon\.icns/);
});

test("stages only manifest-covered release files", async t => {
  const root = await fixture(t);
  const stage = path.join(root, "release-upload");

  const result = await stageReleaseArtifacts(root, "macos-aarch64", stage, fixtureVersion);
  assert.deepEqual((await readdir(stage)).sort(), [
    "Portcove_0.1.0-alpha.2_aarch64.dmg",
    "SHA256SUMS-macos-aarch64.txt",
    "portcove-cli-0.1.0-alpha.2-macos-aarch64.tar.gz",
  ]);
  assert.equal(result.staged.length, 3);
});

test("refuses to overwrite an existing release staging directory", async t => {
  const root = await fixture(t);
  const stage = path.join(root, "release-upload");
  await mkdir(stage);
  await writeFile(path.join(stage, "existing.txt"), "preserve");
  await assert.rejects(
    stageReleaseArtifacts(root, "macos-aarch64", stage, fixtureVersion),
    error => error.code === "EEXIST",
  );
  assert.equal(await readFile(path.join(stage, "existing.txt"), "utf8"), "preserve");
});

test("rejects unsafe or overlapping release staging paths", async t => {
  const root = await fixture(t);
  await assert.rejects(
    stageReleaseArtifacts(root, "macos-aarch64", root, fixtureVersion),
    /child directory inside the project/,
  );
  await assert.rejects(
    stageReleaseArtifacts(root, "macos-aarch64", path.join(root, "target/release/bundle/upload"), fixtureVersion),
    /must not overlap release inputs/,
  );
});

test("refuses staging through linked ancestry without modifying the link target", async t => {
  const root = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "portcove-stage-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "sentinel.txt"), "preserve");
  const linkedParent = path.join(root, "stage-link");
  await symlink(outside, linkedParent, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    stageReleaseArtifacts(root, "macos-aarch64", path.join(linkedParent, "release-upload"), fixtureVersion),
    /symbolic-link or reparse-point/,
  );
  assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "preserve");
  await assert.rejects(readFile(path.join(outside, "release-upload", "SHA256SUMS-macos-aarch64.txt")), error => error.code === "ENOENT");
});

test("rejects duplicate package filenames before publishing", async t => {
  const root = await fixture(t, "linux-x86_64");
  await mkdir(path.join(root, "target/release/bundle/other"), { recursive: true });
  await writeFile(path.join(root, "target/release/bundle/other/Portcove_0.1.0-alpha.2_amd64.deb"), "duplicate");
  await assert.rejects(
    collectReleaseArtifacts(root, "linux-x86_64", fixtureVersion),
    /duplicate or case-colliding filename/,
  );
});

test("fails closed for missing, unexpected, or wrong-version packages", async t => {
  const root = await fixture(t, "windows-x86_64");
  const cliArchive = path.join(root, "release-assets/portcove-cli-0.1.0-alpha.2-windows-x86_64.zip");
  await rm(cliArchive);
  await assert.rejects(collectReleaseArtifacts(root, "windows-x86_64", fixtureVersion), /missing: portcove-cli/);

  await writeFile(cliArchive, "cli");
  await writeFile(path.join(root, "target/release/bundle/packages/Portcove_0.1.0-alpha.2_x64.msi"), "unexpected");
  await assert.rejects(collectReleaseArtifacts(root, "windows-x86_64", fixtureVersion), /unexpected: .*\.msi/);

  await rm(path.join(root, "target/release/bundle/packages/Portcove_0.1.0-alpha.2_x64.msi"));
  await assert.rejects(collectReleaseArtifacts(root, "windows-x86_64", "0.1.0-alpha.3"), /package set mismatch/);
});
