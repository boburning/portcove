/** Read selected release-tool identities without installing code on private receivers.
 * Only the canonical pnpm-generated lock rows needed here are accepted. */
import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";

const cli = "@tauri-apps/cli";
const exactVersion = /^\d+\.\d+\.\d+$/u;

function readSelectionFile(filename: string, maximum = 64 * 1024) {
  const descriptor = openSync(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    assert.ok(
      before.isFile() && before.size > 0 && before.size <= maximum,
      "release dependency input exceeds file bound",
    );
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    assert.ok(
      length === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      "release dependency input changed during read",
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    closeSync(descriptor);
  }
}

function block(text: string, heading: string) {
  const lines = text.split(/\r?\n/u);
  const index = lines.indexOf(heading);
  assert.ok(
    index >= 0 && index === lines.lastIndexOf(heading),
    `missing or duplicate lock row: ${heading.trim()}`,
  );
  const indent = heading.length - heading.trimStart().length;
  const end = lines.findIndex(
    (line, position) =>
      position > index && line.trim() !== "" && line.length - line.trimStart().length <= indent,
  );
  return lines.slice(index + 1, end === -1 ? lines.length : end).join("\n");
}

function manifest(root: string, file: string) {
  const value: unknown = JSON.parse(readSelectionFile(path.join(root, file)));
  assert.ok(isRecord(value) && isRecord(value.devDependencies));
  return value.devDependencies;
}

function readReleaseToolLock(root: string) {
  const documents = readSelectionFile(path.join(root, "pnpm-lock.yaml"), 2 * 1024 ** 2).split(
    /^---\r?$/mu,
  );
  assert.ok(
    documents.length === 3 && documents[0]?.trim() === "",
    "expected pnpm toolchain and application lock documents",
  );
  return { toolchain: documents[1]!, lock: documents[2]! };
}

export function readReleaseToolDependencies(root: string) {
  const { toolchain, lock } = readReleaseToolLock(root);
  const rootManifest: unknown = JSON.parse(readSelectionFile(path.join(root, "package.json")));
  assert.ok(isRecord(rootManifest) && typeof rootManifest.packageManager === "string");
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(rootManifest.packageManager)?.[1];
  assert.ok(pnpmVersion, "root must pin an exact pnpm version");
  const managers = block(
    block(block(toolchain, "importers:"), "  .:"),
    "    packageManagerDependencies:",
  );
  assert.equal(
    block(managers, "      pnpm:").trim(),
    `specifier: ${pnpmVersion}\n        version: ${pnpmVersion}`,
    "pnpm toolchain lock differs from root selection",
  );
  const toolchainPackages = block(toolchain, "packages:");
  const pnpmSnapshot = block(
    block(block(toolchain, "snapshots:"), `  pnpm@${pnpmVersion}:`),
    "    optionalDependencies:",
  );
  const nativePnpmIntegrity = (platform: "linux-x64" | "win32-x64") => {
    const name = `@pnpm/exe.${platform}`;
    assert.ok(pnpmSnapshot.split("\n").includes(`      '${name}': ${pnpmVersion}`));
    const artifact = block(toolchainPackages, `  '${name}@${pnpmVersion}':`);
    const integrity = /^    resolution: \{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\}$/mu.exec(
      artifact,
    )?.[1];
    assert.ok(integrity, "native pnpm registry integrity absent");
    return integrity;
  };
  const pnpm = {
    version: pnpmVersion,
    linuxIntegrity: nativePnpmIntegrity("linux-x64"),
    windowsIntegrity: nativePnpmIntegrity("win32-x64"),
  };
  const importers = block(lock, "importers:");
  const desktop = block(block(importers, "  apps/desktop:"), "    devDependencies:");
  const version = manifest(root, "apps/desktop/package.json")[cli];
  assert.ok(
    typeof version === "string" && exactVersion.test(version),
    "desktop must pin an exact Tauri CLI",
  );
  const selected = block(desktop, "      '@tauri-apps/cli':").trim();
  assert.equal(
    selected,
    `specifier: ${version}\n        version: ${version}`,
    "Tauri CLI lock differs from desktop selection",
  );
  const packages = block(lock, "packages:");
  const snapshots = block(lock, "snapshots:");
  const optional = block(block(snapshots, `  '${cli}@${version}':`), "    optionalDependencies:");
  for (const name of [cli, cli + "-linux-x64-gnu", cli + "-win32-x64-msvc"]) {
    const artifact = block(packages, `  '${name}@${version}':`);
    assert.match(artifact, /^    resolution: \{integrity: sha512-[A-Za-z0-9+/]+={0,2}\}$/mu);
    if (name !== cli)
      assert.ok(
        optional.split("\n").includes(`      '${name}': ${version}`),
        "Tauri native binding lock differs from CLI",
      );
  }
  const catalog = block(block(lock, "catalogs:"), "  default:");
  const vite = /^specifier: (\d+\.\d+\.\d+)\n      version: \1$/u.exec(
    block(catalog, "    vite-plus:").trim(),
  )?.[1];
  assert.ok(
    vite && manifest(root, "package.json")["vite-plus"] === "catalog:",
    "root Vite+ catalog selection differs",
  );
  const workspaceCatalog = block(
    readSelectionFile(path.join(root, "pnpm-workspace.yaml")),
    "catalog:",
  );
  assert.equal(
    workspaceCatalog
      .split("\n")
      .filter((line) => line.startsWith("  vite-plus:"))
      .join(),
    `  vite-plus: ${vite}`,
    "Vite+ catalog lock differs from workspace selection",
  );
  const rootDependencies = block(block(importers, "  .:"), "    devDependencies:");
  const resolution = /^specifier: 'catalog:'\n        version: ([^\n]+)$/u.exec(
    block(rootDependencies, "      vite-plus:").trim(),
  )?.[1];
  assert.ok(resolution && resolution.split("(")[0] === vite, "Vite+ importer differs from catalog");
  block(snapshots, `  vite-plus@${resolution}:`);
  assert.match(
    block(packages, `  vite-plus@${vite}:`),
    /^    resolution: \{integrity: sha512-[A-Za-z0-9+/]+={0,2}\}$/mu,
  );
  const signer = "@sigstore/sign";
  const signerVersion = manifest(root, "package.json")[signer];
  assert.ok(typeof signerVersion === "string" && exactVersion.test(signerVersion));
  const signerLock = /^specifier: ([^\n]+)\n        version: ([^\n]+)$/u.exec(
    block(rootDependencies, "      '@sigstore/sign':").trim(),
  );
  const patches = block(lock, "patchedDependencies:");
  const signerPatch = patches
    .split("\n")
    .find((line) => line.startsWith(`  '${signer}@${signerVersion}': `))
    ?.split(": ")[1];
  assert.ok(
    signerPatch && /^[a-f0-9]{64}$/u.test(signerPatch),
    "Sigstore signing transport patch absent",
  );
  assert.ok(
    signerLock?.[1] === signerVersion &&
      signerLock[2]?.startsWith(`${signerVersion}(patch_hash=${signerPatch})`),
    "Sigstore lock differs from patched root selection",
  );
  block(snapshots, `  '${signer}@${signerLock[2]}':`);
  assert.match(
    block(packages, `  '${signer}@${signerVersion}':`),
    /^    resolution: \{integrity: sha512-[A-Za-z0-9+/]+={0,2}\}$/mu,
  );
  return { tauri: version, bundler: `vite-plus@${vite}`, pnpm, sigstoreSign: signerVersion };
}

export function readSealedCheckSdkSelection(root: string) {
  const { lock } = readReleaseToolLock(root);
  const value: unknown = JSON.parse(readSelectionFile(path.join(root, "package.json")));
  assert.ok(isRecord(value) && isRecord(value.dependencies));
  const name = "@octokit/core";
  const version = value.dependencies[name];
  assert.ok(typeof version === "string" && exactVersion.test(version));
  const importer = block(block(lock, "importers:"), "  .:");
  const heading = `  '${name}@${version}':`;
  assert.equal(
    block(block(importer, "    dependencies:"), `      '${name}':`).trim(),
    `specifier: ${version}\n        version: ${version}`,
    "sealed Check lock differs from Octokit selection",
  );
  assert.match(
    block(block(lock, "packages:"), heading),
    /^    resolution: \{integrity: sha512-[A-Za-z0-9+/]+={0,2}\}$/mu,
  );
  block(block(lock, "snapshots:"), heading);
  return { name, version };
}

export function verifyInstalledReleasePackage(filename: string, name: string, version: string) {
  const value: unknown = JSON.parse(readSelectionFile(filename));
  assert.ok(
    isRecord(value) && value.name === name && value.version === version,
    `installed ${name} differs from fixed selection`,
  );
}
