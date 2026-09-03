import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { reconcileReleaseAssets, releaseLabels } from "./reconcile-release-assets.mjs";

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-release-matrix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  for (const label of releaseLabels) {
    const platform = path.join(input, `release-build-${label}`);
    const assets = path.join(platform, "release-assets");
    const bundle = path.join(platform, "target", "release", "bundle", "package");
    await mkdir(assets, { recursive: true });
    await mkdir(bundle, { recursive: true });
    const cliName = `portcove-${label}${label === "windows-x86_64" ? ".zip" : ".tar.gz"}`;
    const desktopName = `Portcove_0.1.0_${label}${label === "linux-x86_64" ? ".deb" : label.startsWith("macos") ? ".dmg" : ".exe"}`;
    const cli = `cli:${label}`;
    const desktop = `desktop:${label}`;
    await writeFile(path.join(assets, cliName), cli);
    await writeFile(path.join(bundle, desktopName), desktop);
    await writeFile(
      path.join(assets, `SHA256SUMS-${label}.txt`),
      `${digest(cli)}  ${cliName}\n${digest(desktop)}  ${desktopName}\n`,
    );
  }
  return { root, input, output };
}

test("reconciles a complete matrix and is deterministic on rerun", async t => {
  const { input, output } = await fixture(t);
  const first = await reconcileReleaseAssets(input, output);
  const firstAggregate = await readFile(path.join(output, "SHA256SUMS.txt"), "utf8");
  await writeFile(path.join(output, "stale-package.exe"), "stale");

  const second = await reconcileReleaseAssets(input, output);

  assert.deepEqual(second, first);
  assert.equal(await readFile(path.join(output, "SHA256SUMS.txt"), "utf8"), firstAggregate);
  assert(!((await readdir(output)).includes("stale-package.exe")));
});

test("rejects missing jobs, duplicate filenames, and checksum drift", async t => {
  const missing = await fixture(t);
  await rm(path.join(missing.input, "release-build-linux-x86_64"), { recursive: true });
  await assert.rejects(reconcileReleaseAssets(missing.input, missing.output), /must contain exactly/);

  const duplicate = await fixture(t);
  const source = path.join(duplicate.input, "release-build-macos-x86_64", "target/release/bundle/package/Portcove_0.1.0_macos-x86_64.dmg");
  const target = path.join(duplicate.input, "release-build-macos-aarch64", "target/release/bundle/package/Portcove_0.1.0_macos-aarch64.dmg");
  const common = "Portcove_0.1.0_duplicate.dmg";
  const sourceContents = await readFile(source);
  const targetContents = await readFile(target);
  await writeFile(path.join(path.dirname(source), common), sourceContents);
  await writeFile(path.join(path.dirname(target), common), targetContents);
  await unlink(source);
  await unlink(target);
  for (const [label, contents] of [["macos-x86_64", sourceContents], ["macos-aarch64", targetContents]]) {
    const manifest = path.join(duplicate.input, `release-build-${label}`, "release-assets", `SHA256SUMS-${label}.txt`);
    const cliLine = (await readFile(manifest, "utf8")).split(/\r?\n/)[0];
    await writeFile(manifest, `${cliLine}\n${digest(contents)}  ${common}\n`);
  }
  await assert.rejects(reconcileReleaseAssets(duplicate.input, duplicate.output), /duplicate matrix artifact/);

  const changed = await fixture(t);
  const changedCli = path.join(changed.input, "release-build-windows-x86_64", "release-assets", "portcove-windows-x86_64.zip");
  await writeFile(changedCli, "tampered");
  await assert.rejects(reconcileReleaseAssets(changed.input, changed.output), /checksum mismatch/);
});

test("rejects output paths that could remove matrix inputs", async t => {
  const fixturePaths = await fixture(t);
  await assert.rejects(
    reconcileReleaseAssets(fixturePaths.input, fixturePaths.root),
    /unsafe or overlapping/,
  );
  await assert.rejects(
    reconcileReleaseAssets(fixturePaths.input, path.join(fixturePaths.input, "aggregate")),
    /unsafe or overlapping/,
  );
});
