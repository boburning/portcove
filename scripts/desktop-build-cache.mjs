import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { rustSupportCompilerIdentity } from "./rust-support-cache.mjs";

const FORMAT_VERSION = 1;
const FRONTEND_INPUTS = [
  ".node-version",
  "package.json",
  "vite.config.ts",
  "tsconfig.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/desktop/public",
  "apps/desktop/src",
  "apps/desktop/index.html",
  "apps/desktop/package.json",
  "apps/desktop/tsconfig.json",
  "apps/desktop/tsconfig.node.json",
  "tsconfig.base.json",
  "apps/desktop/vite.config.ts",
  "apps/desktop/scripts/build-frontend.mjs",
  "scripts/dev-storage.mjs",
  "scripts/tool-cache.mjs",
];
const FRONTEND_OPTIONAL_INPUTS = [
  "apps/desktop/.env",
  "apps/desktop/.env.local",
  "apps/desktop/.env.production",
  "apps/desktop/.env.production.local",
];

const portable = (value) => value.split(path.sep).join("/");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function inventoryEntry(absolute, relative, entries) {
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

async function inventory(root, names) {
  const entries = [];
  for (const name of names) await inventoryEntry(path.join(root, name), name, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function optionalInventory(root, names) {
  const entries = [];
  for (const name of names) {
    try {
      await inventoryEntry(path.join(root, name), name, entries);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entries.push({ path: portable(name), missing: true });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function buildEnvironment(environment) {
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
  packageManagerVersion,
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
}) {
  const identity = {
    format_version: FORMAT_VERSION,
    command: [packageManager, "--dir", "apps/desktop", "build"],
    toolchain: {
      node: process.version,
      package_manager: packageManager,
      package_manager_version: packageManagerVersion,
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

async function outputInventory(outputDirectory) {
  const entries = await inventory(path.dirname(outputDirectory), [path.basename(outputDirectory)]);
  if (entries.length === 0) throw new Error("desktop frontend build produced no output files");
  return entries.map((entry) => ({ ...entry, path: entry.path.replace(/^dist\//u, "") }));
}

export async function checkFrontendBuildReuse({ identity, outputDirectory, stampPath }) {
  let stamp;
  try {
    stamp = JSON.parse(await readFile(stampPath, "utf8"));
  } catch (error) {
    return {
      reused: false,
      reason: error.code === "ENOENT" ? "missing-cache-record" : "invalid-cache-record",
    };
  }
  if (stamp.format_version !== FORMAT_VERSION || stamp.input_fingerprint !== identity.fingerprint)
    return { reused: false, reason: "frontend-inputs-changed" };
  let outputs;
  try {
    outputs = await outputInventory(outputDirectory);
  } catch {
    return { reused: false, reason: "frontend-output-missing-or-unsafe" };
  }
  if (JSON.stringify(outputs) !== JSON.stringify(stamp.outputs))
    return { reused: false, reason: "frontend-output-changed" };
  return {
    reused: true,
    reason: "exact-inputs-and-outputs-match",
    input_fingerprint: identity.fingerprint,
    output_fingerprint: stamp.output_fingerprint,
    output_files: outputs.length,
  };
}

export async function recordFrontendBuild({ identity, outputDirectory, stampPath }) {
  const outputs = await outputInventory(outputDirectory);
  const stamp = {
    format_version: FORMAT_VERSION,
    input_fingerprint: identity.fingerprint,
    output_fingerprint: sha256(JSON.stringify(outputs)),
    outputs,
  };
  await writeFile(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
  return {
    reused: false,
    reason: "frontend-built-and-recorded",
    input_fingerprint: stamp.input_fingerprint,
    output_fingerprint: stamp.output_fingerprint,
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
}) {
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
  let compiler;
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

export function qualificationBindingFingerprint({
  productArtifacts,
  harnessInputs,
  runtimeConditions,
  fixtureIdentities,
  initialState,
  selectedRequirements,
  selectedScenarios,
  acceptanceCriteria,
}) {
  for (const value of [
    productArtifacts,
    harnessInputs,
    runtimeConditions,
    fixtureIdentities,
    initialState,
    selectedRequirements,
    selectedScenarios,
    acceptanceCriteria,
  ])
    if (value === undefined || value === null)
      throw new Error("Execution qualification binding is incomplete");
  return sha256(
    JSON.stringify({
      productArtifacts,
      harnessInputs,
      runtimeConditions,
      fixtureIdentities,
      initialState,
      selectedRequirements,
      selectedScenarios,
      acceptanceCriteria,
    }),
  );
}
