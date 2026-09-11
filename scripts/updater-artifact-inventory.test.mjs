import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactName,
  loadPackagePolicy,
  packagesForPlatform,
  releaseLabels,
} from "./release-package-policy.mjs";
import {
  stageUpdaterInventory,
  updaterIdentity,
  verifyUpdaterInventory,
} from "./updater-artifact-inventory.mjs";

const policy = await loadPackagePolicy();
const version = "0.3.0";
const revision = "a".repeat(40);

async function fixture(t, label = "windows-x86_64") {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-updater-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "release"));
  await writeFile(path.join(root, "release/package-policy.json"), JSON.stringify(policy));
  await writeFile(path.join(root, "Cargo.toml"), `[workspace.package]\nversion = "${version}"\n`);
  for (const entry of packagesForPlatform(policy, label)) {
    const directory =
      entry.interface === "cli" ? "release-assets" : `target/release/bundle/${entry.format}`;
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(
      path.join(root, directory, artifactName(entry, version)),
      `${entry.id} final bytes`,
    );
  }
  const identity = updaterIdentity(policy, label, version);
  const bundle = path.join(root, "target/release/bundle", identity.bundle_directory);
  await mkdir(bundle, { recursive: true });
  const source = path.join(bundle, identity.source_filename);
  if (identity.format === "app.tar.gz") await writeFile(source, "mac final archive");
  await writeFile(`${source}.sig`, "signature fixture");
  const publicKey = path.join(root, "test-public.key");
  await writeFile(publicKey, "public key fixture");
  let verified = 0;
  const options = {
    projectRoot: root,
    label,
    revision,
    publicKey,
    output: path.join(root, "staged"),
    input: path.join(root, "staged"),
    // This seam tests inventory ownership only; Rust tests and native rehearsal
    // exercise the real Minisign implementation, including wrong-key signatures.
    verifySignature: async (_verifier, artifact, signature, key, expected) => {
      assert.equal((await readFile(artifact)).length, expected.bytes);
      assert.equal(await readFile(signature, "utf8"), "signature fixture");
      assert.equal(await readFile(key, "utf8"), "public key fixture");
      verified += 1;
    },
  };
  return { root, source, identity, options, verified: () => verified };
}

for (const label of releaseLabels(policy)) {
  test(`stages and independently rechecks all required ${label} packages`, async (t) => {
    const f = await fixture(t, label);
    const staged = await stageUpdaterInventory(f.options);
    assert.deepEqual(await verifyUpdaterInventory(f.options), staged);
    assert.equal(f.verified(), 2);
    assert.equal(staged.packages.length, packagesForPlatform(policy, label).length);
    assert.equal(staged.updater.target, label.replace("macos", "darwin"));
    await assert.rejects(stageUpdaterInventory(f.options), /EEXIST/);
  });
}

test("missing signatures and failed verification never produce successful evidence", async (t) => {
  const f = await fixture(t);
  await rm(`${f.source}.sig`);
  await assert.rejects(stageUpdaterInventory(f.options), /ENOENT/);
  await writeFile(`${f.source}.sig`, "signature fixture");
  f.options.verifySignature = async () => {
    throw new Error("wrong signing key");
  };
  await assert.rejects(stageUpdaterInventory(f.options), /wrong signing key/);
  await assert.rejects(readFile(path.join(f.options.output, "updater-inventory.json")), /ENOENT/);
});

test("changing any final package or the public key invalidates recorded evidence", async (t) => {
  const f = await fixture(t);
  const inventory = await stageUpdaterInventory(f.options);
  const cli = inventory.packages.find((entry) => entry.id.startsWith("cli-"));
  const file = path.join(f.options.output, cli.filename);
  const original = await readFile(file);
  await writeFile(file, "changed companion");
  await assert.rejects(verifyUpdaterInventory(f.options), /checksum mismatch/);
  await writeFile(file, original);
  await writeFile(f.options.publicKey, "substituted key");
  await assert.rejects(verifyUpdaterInventory(f.options), /public key mismatch/);
});

test("rejects duplicate packages, wrong target/version/revision and extra assets", async (t) => {
  const f = await fixture(t);
  const inventory = await stageUpdaterInventory(f.options);
  const manifest = path.join(f.options.output, "updater-inventory.json");
  const mutations = [
    (data) => data.packages.push(data.packages[0]),
    (data) => {
      data.updater.target = "darwin-aarch64";
    },
    (data) => {
      data.version = "0.2.0";
    },
    (data) => {
      data.source_commit = "b".repeat(40);
    },
    (data) => {
      data.packages[0].filename = "../outside";
    },
    (data) => {
      data.updater.signature.filename = "other.sig";
    },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(inventory);
    mutate(data);
    await writeFile(manifest, JSON.stringify(data));
    await assert.rejects(verifyUpdaterInventory(f.options), /mismatch|duplicate/);
  }
  await writeFile(manifest, JSON.stringify(inventory));
  await copyFile(f.source, path.join(f.options.output, "unexpected.exe"));
  await assert.rejects(verifyUpdaterInventory(f.options), /staged files mismatch/);
});

test("rejects overlapping staging paths and version override inheritance", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    stageUpdaterInventory({
      ...f.options,
      output: path.join(f.root, "target/release/bundle/new"),
    }),
    /overlap/,
  );
  await stageUpdaterInventory(f.options);
  await assert.rejects(
    verifyUpdaterInventory({ ...f.options, version: "0.1.0" }),
    /identity mismatch/,
  );
  await assert.rejects(
    verifyUpdaterInventory({ ...f.options, revision: "HEAD" }),
    /exact source commit/,
  );
});

test("release-only overlay preserves ordinary secret-free builds and updater package baseline", async () => {
  const base = JSON.parse(
    await readFile(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url)),
  );
  const overlay = JSON.parse(
    await readFile(new URL("../release/tauri.updater.conf.json", import.meta.url)),
  );
  assert.equal(base.bundle.createUpdaterArtifacts, false);
  assert.equal(overlay.bundle.createUpdaterArtifacts, true);
  assert.equal(overlay.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(overlay.bundle.macOS.signingIdentity, "-");
  assert.equal(overlay.plugins.updater.windows.installMode, "passive");
  assert.equal(overlay.identifier, undefined);
  assert.equal(overlay.plugins.updater.endpoints, undefined);
  assert.equal(overlay.plugins.updater.pubkey, undefined);
});

test("manual rehearsal retains the complete matrix without production credentials or publication", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|contents: write|actions: write|gh release|pull_request_target/,
  );
  assert.match(workflow, /default: all/);
  const matrix = JSON.parse(workflow.match(/label:.*fromJSON\('([^']+)'\)/)[1]);
  assert.deepEqual(matrix.all.toSorted(), releaseLabels(policy).toSorted());
  for (const label of releaseLabels(policy)) assert.deepEqual(matrix[label], [label]);
  assert.match(workflow, /retention-days: 1/);
  assert.doesNotMatch(workflow, /updater-rehearsal\/\*\*|\.key\b/);
  const lifecycle = await readFile(
    new URL("./test-windows-installer.ps1", import.meta.url),
    "utf8",
  );
  assert.match(lifecycle, /\$InstallMode -eq "Passive".*"\/P"/);
  assert.match(lifecycle, /DisplayVersion -ne \$ExpectedVersion/);
  assert.match(lifecycle, /HKEY_CURRENT_USER/);
  const rehearsal = await readFile(
    new URL("./rehearse-updater-artifacts.ps1", import.meta.url),
    "utf8",
  );
  // A DMG-only Tauri build creates the bootstrap disk image but does not return
  // an app bundle target for updater archive/signature generation.
  assert.match(rehearsal, /else \{ "app,dmg" \}/);
});
