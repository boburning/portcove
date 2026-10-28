import { errorCode } from "./runtime-values.mts";
import type { BinaryLike } from "node:crypto";
import type { FileIdentity } from "./development-evidence.mts";
type InventoryFile = Pick<FileIdentity, "path" | "bytes" | "sha256">;
type InventoryEntry = InventoryFile | { path: string; missing: true };
export interface FrontendBuildIdentityOptions {
  root: string;
  packageManager: string;
  vitePlusVersion: string;
  environment?: NodeJS.ProcessEnv;
  platform?: string;
  architecture?: string;
}
export interface VerificationBuildIdentityOptions {
  root: string;
  frontendIdentity: { fingerprint: string };
  frontendOutputFingerprint: string;
  features: readonly string[];
  cliFeatures?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  platform?: string;
  compilerProbe?: (options: Parameters<typeof rustSupportCompilerIdentity>[0]) => unknown;
}
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { rustSupportCompilerIdentity } from "./rust-support-cache.mts";

const FORMAT_VERSION = 1;
const FRONTEND_INPUTS = [
  ".node-version",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/desktop/public",
  "apps/desktop/src",
  "apps/desktop/index.html",
  "apps/desktop/package.json",
  "apps/desktop/tsconfig.json",
  "tsconfig.base.json",
  "apps/desktop/vite.config.ts",
  "apps/desktop/scripts/build-frontend.mts",
  "apps/desktop/scripts/production-css.mts",
  "scripts/viteplus-cli.mts",
  "scripts/dev-storage.mts",
  "scripts/development-scratch.mts",
  "scripts/node-test-suites.mts",
  "scripts/node-test-suites.json",
  "scripts/tool-cache.mts",
];
const FRONTEND_OPTIONAL_INPUTS = [
  "apps/desktop/.env",
  "apps/desktop/.env.local",
  "apps/desktop/.env.production",
  "apps/desktop/.env.production.local",
];

const portable = (value: string) => value.split(path.sep).join("/");
const sha256 = (value: BinaryLike) => createHash("sha256").update(value).digest("hex");

async function inventoryEntry(absolute: string, relative: string, entries: InventoryEntry[]) {
  const details = await lstat(absolute, { bigint: false });
  if (details.isSymbolicLink()) {
    const target = await readlink(absolute);
    throw new Error(`desktop build reuse refuses linked input ${portable(relative)} -> ${target}`);
  }
  if (details.isFile()) {
    const contents = await readFile(absolute);
    entries.push({ path: portable(relative), bytes: details.size, sha256: sha256(contents) });
    return;
  }
  if (!details.isDirectory())
    throw new Error(`desktop build reuse refuses non-file input ${portable(relative)}`);
  for (const child of (await readdir(absolute, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const childRelative = path.join(relative, child.name);
    if (child.isSymbolicLink()) {
      const target = await readlink(path.join(absolute, child.name));
      throw new Error(
        `desktop build reuse refuses linked input ${portable(childRelative)} -> ${target}`,
      );
    }
    await inventoryEntry(path.join(absolute, child.name), childRelative, entries);
  }
}

async function inventory(root: string, names: readonly string[]) {
  const entries: InventoryFile[] = [];
  for (const name of names) await inventoryEntry(path.join(root, name), name, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function optionalInventory(root: string, names: readonly string[]) {
  const entries: InventoryEntry[] = [];
  for (const name of names) {
    try {
      await inventoryEntry(path.join(root, name), name, entries);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      entries.push({ path: portable(name), missing: true });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function buildEnvironment(environment: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(environment)
      .filter(
        ([name]) => name === "NODE_ENV" || name.startsWith("TAURI_") || name.startsWith("VITE_"),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function createFrontendBuildIdentity({
  root,
  packageManager,
  vitePlusVersion,
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
}: FrontendBuildIdentityOptions) {
  const identity = {
    format_version: FORMAT_VERSION,
    command: ["node", "apps/desktop/scripts/build-frontend.mts"],
    toolchain: {
      node: process.version,
      package_manager: packageManager,
      vite_plus_version: vitePlusVersion,
      platform,
      architecture,
    },
    environment: buildEnvironment(environment),
    inputs: [
      ...(await inventory(root, FRONTEND_INPUTS)),
      ...(await optionalInventory(root, FRONTEND_OPTIONAL_INPUTS)),
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
  return { ...identity, fingerprint: sha256(JSON.stringify(identity)) };
}

async function outputInventory(outputDirectory: string) {
  const entries = await inventory(path.dirname(outputDirectory), [path.basename(outputDirectory)]);
  if (entries.length === 0) throw new Error("desktop frontend build produced no output files");
  return entries.map((entry) => ({ ...entry, path: entry.path.replace(/^dist\//u, "") }));
}

/** Observe output bytes after Vite Task executes/restores them; never skip execution here. */
export async function observeFrontendBuild({
  identity,
  outputDirectory,
}: {
  identity: { fingerprint: string };
  outputDirectory: string;
}) {
  const outputs = await outputInventory(outputDirectory);
  return {
    execution_owner: "vite-task",
    input_fingerprint: identity.fingerprint,
    output_fingerprint: sha256(JSON.stringify(outputs)),
    output_files: outputs.length,
  };
}

// The two existing native verification profiles have mutable SDK/system inputs.
// These are useful comparison observations, never a complete native cache key.
export async function createVerificationBuildIdentity({
  root,
  frontendIdentity,
  frontendOutputFingerprint,
  features,
  cliFeatures = [],
  environment = process.env,
  platform = process.platform,
  compilerProbe = rustSupportCompilerIdentity,
}: VerificationBuildIdentityOptions) {
  if (!["win32", "linux"].includes(platform))
    throw new Error("Only Windows/Linux verification build profiles are supported");
  const sources = await inventory(root, [
    "Cargo.toml",
    "Cargo.lock",
    "crates",
    "apps/desktop/src-tauri/src",
    "apps/desktop/src-tauri/Cargo.toml",
    "apps/desktop/src-tauri/build.rs",
  ]);
  const resources = await optionalInventory(root, [
    "rust-toolchain.toml",
    ".cargo",
    "apps/desktop/src-tauri/icons",
    "apps/desktop/src-tauri/gen",
    "apps/desktop/src-tauri/tauri.conf.json",
    "apps/desktop/src-tauri/tauri.windows.conf.json",
    "apps/desktop/src-tauri/tauri.native-compatibility.conf.json",
  ]);
  let compiler: unknown;
  try {
    compiler = compilerProbe({ runSync: spawnSync, environment, platform });
  } catch {
    compiler = { state: "unavailable" };
  }
  const relevantEnvironment = Object.entries(environment)
    .filter(
      ([name]) =>
        /^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_TARGET|CC|CXX|LD|AR|CFLAGS|CXXFLAGS|LDFLAGS|INCLUDE|LIB|VCToolsInstallDir|WindowsSdkDir|PKG_CONFIG_PATH|PORTCOVE_APPLICATION_UPDATE_(BUNDLED_ROOT_FILE|METADATA_URL|TARGETS_URL))$/u.test(
          name,
        ) || /^(VITE_|TAURI_)/u.test(name),
    )
    .filter(([name]) => !/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTH)/iu.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, fingerprint: sha256(String(value)) }));
  const identity = {
    format_version: 1,
    profile: platform === "win32" ? "windows-native-verification" : "linux-native-verification",
    workspace: sha256(path.resolve(root)),
    frontend_input_fingerprint: frontendIdentity.fingerprint,
    frontend_output_fingerprint: frontendOutputFingerprint,
    features: [...features].sort(),
    cli_features: [...cliFeatures].sort(),
    repository_inputs: [...sources, ...resources].sort((a, b) => a.path.localeCompare(b.path)),
    compiler_observation: compiler,
    environment: relevantEnvironment,
  };
  return {
    ...identity,
    fingerprint: sha256(JSON.stringify(identity)),
    inventory_complete: false,
    native_reuse: {
      reused: false,
      reason: "external-sdk-system-build-input-completeness-unavailable",
      action: "Use the existing Cargo build and its supported incremental behavior",
    },
  };
}
