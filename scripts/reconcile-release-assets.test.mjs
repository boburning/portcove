import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { reconcileReleaseAssets } from "./reconcile-release-assets.mjs";
import {
  artifactName,
  loadPackagePolicy,
  packagesForPlatform,
  releaseLabels,
} from "./release-package-policy.mjs";

const policy = await loadPackagePolicy();
const version = "0.1.0-alpha.2";
const options = { policy, version, tag: `v${version}` };

function reconcile(paths, overrides = {}) {
  return reconcileReleaseAssets(paths.input, paths.output, {
    ...options,
    projectRoot: paths.root,
    ...overrides,
  });
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "portcove-release-matrix-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const inventoryPath = path.join(root, "metadata", "release-inventory.json");
  for (const label of releaseLabels(policy)) {
    const platform = path.join(input, `release-build-${label}`);
    const assets = path.join(platform, "release-upload");
    await mkdir(assets, { recursive: true });
    const lines = [];
    for (const entry of packagesForPlatform(policy, label)) {
      const name = artifactName(entry, version);
      const contents = `${entry.interface}:${entry.id}`;
      await writeFile(path.join(assets, name), contents);
      lines.push(`${digest(contents)}  ${name}`);
    }
    await writeFile(
      path.join(assets, `SHA256SUMS-${label}.txt`),
      `${lines.join("\n")}\n`,
    );
  }
  return { root, input, output, inventoryPath };
}

test("reconciles the exact matrix, keeps platform manifests internal, and is deterministic", async (t) => {
  const { input, output, inventoryPath } = await fixture(t);
  const paths = { root: path.dirname(input), input, output };
  const first = await reconcile(paths, { inventoryPath });
  const firstAggregate = await readFile(
    path.join(output, "SHA256SUMS.txt"),
    "utf8",
  );
  const firstInventory = await readFile(inventoryPath, "utf8");
  await writeFile(path.join(output, "stale-package.exe"), "stale");

  const second = await reconcile(paths, { inventoryPath });

  assert.deepEqual(second, first);
  assert.equal(
    await readFile(path.join(output, "SHA256SUMS.txt"), "utf8"),
    firstAggregate,
  );
  assert.equal(await readFile(inventoryPath, "utf8"), firstInventory);
  assert.equal((await readdir(output)).length, policy.packages.length + 1);
  assert(
    !(await readdir(output)).some((name) => name.startsWith("SHA256SUMS-")),
  );
  assert(!(await readdir(output)).includes("stale-package.exe"));
});

test("inventory binds labels, exact tag links, sizes, and checksums to validated packages", async (t) => {
  const { input, output } = await fixture(t);
  const result = await reconcile({ root: path.dirname(input), input, output });
  assert.equal(result.inventory.packages.length, 10);
  assert.equal(result.inventory.tag, "v0.1.0-alpha.2");
  assert.equal(
    result.inventory.checksum_url,
    "https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/SHA256SUMS.txt",
  );
  const windows = result.inventory.packages.find(
    (entry) => entry.id === "cli-windows-x86_64-zip",
  );
  assert.equal(windows.display_label, "Windows — Intel/AMD 64-bit");
  assert.equal(
    windows.filename,
    "portcove-cli-0.1.0-alpha.2-windows-x86_64.zip",
  );
  assert.equal(
    windows.download_url,
    `https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/${windows.filename}`,
  );
  assert.equal(typeof windows.bytes, "number");
  assert.match(windows.sha256, /^[a-f0-9]{64}$/);
});

test("rejects missing jobs and package outputs not declared by policy", async (t) => {
  const missingJob = await fixture(t);
  await rm(path.join(missingJob.input, "release-build-linux-x86_64"), {
    recursive: true,
  });
  await assert.rejects(reconcile(missingJob), /must contain exactly/);

  const unexpected = await fixture(t);
  await writeFile(
    path.join(
      unexpected.input,
      "release-build-windows-x86_64/release-upload/Portcove_0.1.0-alpha.2_x64.msi",
    ),
    "not declared",
  );
  await assert.rejects(
    reconcile(unexpected),
    /staged files mismatch.*unexpected: .*\.msi/,
  );
});

test("rejects duplicate, unsafe, malformed, and mismatched checksum entries", async (t) => {
  const duplicate = await fixture(t);
  const manifest = path.join(
    duplicate.input,
    "release-build-macos-aarch64/release-upload/SHA256SUMS-macos-aarch64.txt",
  );
  const contents = await readFile(manifest, "utf8");
  await writeFile(manifest, `${contents}${contents.split(/\r?\n/)[0]}\n`);
  await assert.rejects(reconcile(duplicate), /duplicate checksum entry/);

  const unsafe = await fixture(t);
  const unsafeManifest = path.join(
    unsafe.input,
    "release-build-windows-x86_64/release-upload/SHA256SUMS-windows-x86_64.txt",
  );
  await writeFile(unsafeManifest, `${"a".repeat(64)}  ../Portcove.exe\n`);
  await assert.rejects(reconcile(unsafe), /invalid checksum line/);

  const malformed = await fixture(t);
  const malformedManifest = path.join(
    malformed.input,
    "release-build-linux-x86_64/release-upload/SHA256SUMS-linux-x86_64.txt",
  );
  await writeFile(
    malformedManifest,
    `not-a-hash  Portcove_${version}_amd64.AppImage\n`,
  );
  await assert.rejects(reconcile(malformed), /invalid checksum line/);

  const changed = await fixture(t);
  const changedCli = path.join(
    changed.input,
    `release-build-windows-x86_64/release-upload/portcove-cli-${version}-windows-x86_64.zip`,
  );
  await writeFile(changedCli, "tampered");
  await assert.rejects(reconcile(changed), /checksum mismatch/);
});

test("rejects wrong version and tag identities", async (t) => {
  const paths = await fixture(t);
  await assert.rejects(
    reconcile(paths, { version: "0.1.0-alpha.3", tag: "v0.1.0-alpha.3" }),
    /checksum entries mismatch.*missing:/,
  );
  await assert.rejects(
    reconcile(paths, { tag: "v0.1.0-alpha.3" }),
    /must exactly match v0\.1\.0-alpha\.2/,
  );
});

test("rejects output paths that could remove inputs or publish internal inventory", async (t) => {
  const paths = await fixture(t);
  await assert.rejects(
    reconcileReleaseAssets(paths.input, paths.root, {
      ...options,
      projectRoot: paths.root,
    }),
    /unsafe or overlapping/,
  );
  await assert.rejects(
    reconcileReleaseAssets(paths.input, path.join(paths.input, "aggregate"), {
      ...options,
      projectRoot: paths.root,
    }),
    /unsafe or overlapping/,
  );
  await assert.rejects(
    reconcile(paths, {
      inventoryPath: path.join(paths.output, "release-inventory.json"),
    }),
    /inventory must remain outside/,
  );
});

test("rejects packages hidden in arbitrary nested staging paths", async (t) => {
  const paths = await fixture(t);
  const name = `portcove-cli-${version}-windows-x86_64.zip`;
  const original = path.join(
    paths.input,
    "release-build-windows-x86_64",
    "release-upload",
    name,
  );
  const nested = path.join(
    paths.input,
    "release-build-windows-x86_64",
    "release-upload",
    "nested",
    name,
  );
  await mkdir(path.dirname(nested), { recursive: true });
  await writeFile(nested, await readFile(original));
  await rm(original);
  await assert.rejects(reconcile(paths), /unexpected staged path/);
});

test("refuses linked aggregate and inventory ancestry without touching the link targets", async (t) => {
  const aggregate = await fixture(t);
  const outsideAggregate = await mkdtemp(
    path.join(os.tmpdir(), "portcove-release-outside-"),
  );
  t.after(() => rm(outsideAggregate, { recursive: true, force: true }));
  await writeFile(
    path.join(outsideAggregate, "sentinel.txt"),
    "preserve aggregate",
  );
  const aggregateLink = path.join(aggregate.root, "aggregate-link");
  await symlink(
    outsideAggregate,
    aggregateLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    reconcileReleaseAssets(
      aggregate.input,
      path.join(aggregateLink, "public"),
      {
        ...options,
        projectRoot: aggregate.root,
      },
    ),
    /symbolic-link or reparse-point/,
  );
  assert.equal(
    await readFile(path.join(outsideAggregate, "sentinel.txt"), "utf8"),
    "preserve aggregate",
  );

  const inventory = await fixture(t);
  const outsideInventory = await mkdtemp(
    path.join(os.tmpdir(), "portcove-inventory-outside-"),
  );
  t.after(() => rm(outsideInventory, { recursive: true, force: true }));
  await writeFile(
    path.join(outsideInventory, "sentinel.txt"),
    "preserve inventory",
  );
  const inventoryLink = path.join(inventory.root, "inventory-link");
  await symlink(
    outsideInventory,
    inventoryLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    reconcile(inventory, {
      inventoryPath: path.join(inventoryLink, "release-inventory.json"),
    }),
    /symbolic-link or reparse-point/,
  );
  assert.equal(
    await readFile(path.join(outsideInventory, "sentinel.txt"), "utf8"),
    "preserve inventory",
  );
});
