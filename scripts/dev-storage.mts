#!/usr/bin/env node
import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
import type {
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncOptionsWithBufferEncoding,
  SpawnSyncReturns,
} from "node:child_process";

import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  checkoutToolEnvironment,
  readToolPins,
  pinnedAquaCommand,
  toolCachePaths,
} from "./tool-cache.mts";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const DEFAULT_MINIMUM_FREE_GIB = 20;
const GIB = 1024 ** 3;
const HELP = `Check development storage, run a command after preflight, or explicitly clean Cargo caches.

Usage: node scripts/dev-storage.mts [preflight] [options]
       node scripts/dev-storage.mts run [options] -- command [arguments...]
       node scripts/dev-storage.mts clean
       node scripts/dev-storage.mts prune-incremental

Actions:
  preflight          Report physical storage paths and available space without creating directories (default).
  run                Check storage, prepare scratch directories, then run the command after --.
  clean              Ask Cargo to remove this workspace's ordinary target directory.
  prune-incremental  Remove only this workspace's target/debug/incremental cache.

Options:
  --scope all|tooling|frontend|rust  Select preflight/run paths; all includes Cargo discovery.
  --minimum-free-gib GiB            Require a positive finite free-space margin for preflight/run.
  --json                            Print the preflight report as JSON (preflight only).
  --help                            Print this help and exit before storage work.

The free-space margin defaults to ${DEFAULT_MINIMUM_FREE_GIB} GiB. --minimum-free-gib overrides
PORTCOVE_MIN_FREE_GIB. tooling and frontend scopes do not require Cargo.
Place --help before -- to ask for storage help; arguments after -- belong to the child command.

Cleanup requires Cargo and accepts only the exact ordinary target directory in this workspace;
custom targets, symlinks, junctions and non-directories are refused. Cleanup remains available
below the free-space margin. Stop processes using that target first and preserve source inputs,
verification evidence and final outputs. See docs/DEVELOPMENT-STORAGE.md for path overrides.

Examples:
  node scripts/dev-storage.mts preflight --scope tooling --json
  node scripts/dev-storage.mts run -- pnpm install --frozen-lockfile`;

export interface StoragePaths {
  workspace: string;
  temporary_directory: string;
  output_root: string;
  target_directory?: string;
  tauri_generated?: string;
  pnpm_store?: string;
  browser_cache?: string;
  frontend_dependencies?: string;
  desktop_dependencies?: string;
  frontend_output?: string;
}
export interface StorageVolume {
  root: string;
  free_bytes: number;
}
interface CargoStorageMetadata {
  workspace_root: string;
  target_directory: string;
}

function resolveConfiguredPath(value: string | undefined, fallback: string) {
  return path.resolve(projectRoot, value || fallback);
}

function cargoMetadata() {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Cargo metadata failed with exit code ${result.status}: ${result.stderr.trim()}. ` +
        "Run cargo metadata --format-version 1 --no-deps in this checkout to diagnose the workspace before retrying.",
    );
  }
  const metadata: unknown = JSON.parse(result.stdout);
  if (
    !isRecord(metadata) ||
    typeof metadata.workspace_root !== "string" ||
    typeof metadata.target_directory !== "string"
  )
    throw new Error(
      "Cargo metadata omitted workspace storage paths. Verify workspace_root and target_directory in cargo metadata --format-version 1 --no-deps before retrying.",
    );
  return { workspace_root: metadata.workspace_root, target_directory: metadata.target_directory };
}

export function isWindowsSystemDrivePath(candidate: string, systemDrive = "C:") {
  const normalizeRoot = (value: string) =>
    value
      .replaceAll("/", "\\")
      .replace(/^\\\\[?.]\\/u, "")
      .toLowerCase();
  const systemRoot = normalizeRoot(path.win32.parse(`${systemDrive}\\`).root);
  const candidateRoot = normalizeRoot(path.win32.parse(candidate).root);
  return Boolean(candidateRoot) && candidateRoot === systemRoot;
}

export function windowsSystemDriveViolations<P extends object>(
  paths: { [K in keyof P]: string },
  systemDrive = "C:",
) {
  return Object.entries(paths)
    .filter(
      ([, candidate]) =>
        typeof candidate === "string" && isWindowsSystemDrivePath(candidate, systemDrive),
    )
    .map(([label, candidate]) => `${label}=${String(candidate)}`);
}

export function readStoragePolicy({
  environment = process.env,
  configPath = path.join(os.homedir(), ".config/portcove/development-storage.json"),
}: { environment?: NodeJS.ProcessEnv; configPath?: string } = {}) {
  let config: unknown = { format: 1, blockSystemDrive: false };
  try {
    config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      throw new Error(
        `Cannot read machine storage policy ${configPath}: ${errorMessage(error)}. ` +
          "Restore readable, valid JSON at that path; preserve the machine owner's storage restrictions.",
      );
  }
  if (
    !isRecord(config) ||
    config.format !== 1 ||
    typeof config.blockSystemDrive !== "boolean" ||
    Object.keys(config).some((key) => !["format", "blockSystemDrive"].includes(key))
  )
    throw new Error(
      `Invalid machine storage policy ${configPath}. Use only format: 1 and a boolean blockSystemDrive field; preserve the machine owner's storage restrictions.`,
    );
  const override = environment.PORTCOVE_BLOCK_SYSTEM_DRIVE;
  if (override !== undefined && !["0", "1"].includes(override))
    throw new Error(
      `PORTCOVE_BLOCK_SYSTEM_DRIVE must be 0 or 1; received ${JSON.stringify(override)}. Correct the environment value; 0 cannot relax a strict machine policy.`,
    );
  // An environment override can tighten a machine policy, never relax it.
  return { blockSystemDrive: config.blockSystemDrive || override === "1" };
}

export function getPaths(
  scope = "all",
  { metadataProvider = cargoMetadata }: { metadataProvider?: () => CargoStorageMetadata } = {},
) {
  if (!["all", "tooling", "frontend", "rust"].includes(scope))
    throw new Error(`Unknown storage task scope: ${scope}. Use all, tooling, frontend or rust.`);
  const paths: StoragePaths = {
    workspace: projectRoot,
    temporary_directory: resolveConfiguredPath(process.env.PORTCOVE_TEMP_DIR, "work/temp"),
    output_root: resolveConfiguredPath(process.env.PORTCOVE_OUTPUT_DIR, "outputs"),
  };
  if (["all", "rust"].includes(scope)) {
    const metadata = metadataProvider();
    const metadataRoot = path.resolve(metadata.workspace_root);
    if (metadataRoot.toLowerCase() !== projectRoot.toLowerCase())
      throw new Error(
        `Cargo workspace ${metadataRoot} does not match script workspace ${projectRoot}. Run this checkout's storage tool with its own Cargo workspace.`,
      );
    paths.target_directory = path.resolve(metadata.target_directory);
  }
  if (["all", "frontend"].includes(scope))
    Object.assign(paths, {
      pnpm_store: resolveConfiguredPath(process.env.PORTCOVE_PNPM_STORE_DIR, "work/pnpm-store"),
      browser_cache: path.join(projectRoot, "work", "browser-cache"),
      frontend_dependencies: path.join(projectRoot, "node_modules"),
      desktop_dependencies: path.join(projectRoot, "apps/desktop/node_modules"),
      frontend_output: path.join(projectRoot, "apps/desktop/dist"),
    });
  // Desktop build.rs can generate Tauri schemas during a Rust-only build.
  if (["all", "rust"].includes(scope))
    paths.tauri_generated = path.join(projectRoot, "apps/desktop/src-tauri/gen");
  return paths;
}

function nearestExistingPath(candidate: string) {
  let current = path.resolve(candidate);
  while (true) {
    try {
      lstatSync(current);
      return current;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new Error(
          `Cannot inspect storage path ${current}: ${errorMessage(error)}. Choose a readable directory path or correct its parent-directory access before retrying.`,
          { cause: error },
        );
      }
      const parent = path.dirname(current);
      if (parent === current)
        throw new Error(
          `No existing parent directory was found for ${candidate}. Connect the intended volume or choose a storage path below an existing directory.`,
        );
      current = parent;
    }
  }
}

export function resolvePhysicalPath(candidate: string) {
  const existing = nearestExistingPath(candidate);
  let stats;
  try {
    stats = statSync(existing);
  } catch (error) {
    throw new Error(
      `Cannot resolve storage path ${candidate} through ${existing}: ${errorMessage(error)}. Choose an existing directory or repair the unavailable link destination before retrying.`,
      { cause: error },
    );
  }
  if (!stats.isDirectory())
    throw new Error(
      `Storage path is not a directory: ${existing}. Choose a directory for ${candidate}; preserve the existing file.`,
    );
  return path.resolve(
    realpathSync.native(existing),
    path.relative(existing, path.resolve(candidate)),
  );
}

export function storageVolumes<P extends object>(paths: { [K in keyof P]: string }) {
  const volumes = new Map<number, StorageVolume>();
  for (const candidate of Object.values(paths)) {
    if (typeof candidate !== "string") throw new TypeError("Storage paths must be strings");
    const probe = nearestExistingPath(candidate);
    const device = statSync(probe).dev;
    if (!volumes.has(device)) {
      let root = probe;
      while (path.dirname(root) !== root && statSync(path.dirname(root)).dev === device) {
        root = path.dirname(root);
      }
      const stats = statfsSync(probe);
      volumes.set(device, {
        root,
        free_bytes: Number(stats.bavail) * Number(stats.bsize),
      });
    }
  }
  return [...volumes.values()];
}

export function minimumFreeGiB(value?: string | number) {
  const effectiveValue = value ?? process.env.PORTCOVE_MIN_FREE_GIB ?? DEFAULT_MINIMUM_FREE_GIB;
  const parsed = Number(effectiveValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const received =
      typeof effectiveValue === "string" ? JSON.stringify(effectiveValue) : String(effectiveValue);
    throw new Error(
      `Minimum free space must be a positive finite GiB value, received ${received}. ` +
        "Set --minimum-free-gib or PORTCOVE_MIN_FREE_GIB to a number greater than 0.",
    );
  }
  return parsed;
}

export function preflight<P extends object>(
  paths: { [K in keyof P]: string },
  requiredFreeGiB: number,
  policy = readStoragePolicy(),
) {
  const physicalPaths: { [K in keyof P]: string } = { ...paths };
  for (const [label, candidate] of Object.entries(paths)) {
    if (typeof candidate !== "string") throw new TypeError("Storage paths must be strings");
    Object.assign(physicalPaths, { [label]: resolvePhysicalPath(candidate) });
  }
  for (const [label, candidate] of Object.entries(physicalPaths)) {
    if (typeof candidate !== "string") throw new TypeError("Storage paths must be strings");
    try {
      accessSync(nearestExistingPath(candidate), constants.W_OK);
    } catch (error) {
      throw new Error(
        `Storage path is not writable: ${label}=${candidate}: ${errorMessage(error)}. Choose a writable directory for ${label} or restore access to its existing parent.`,
      );
    }
  }
  if (process.platform === "win32" && policy.blockSystemDrive) {
    const violations = windowsSystemDriveViolations(physicalPaths, process.env.SystemDrive || "C:");
    if (violations.length) {
      throw new Error(
        `Heavy Portcove work is blocked because these paths resolve to the Windows system drive: ${violations.join(", ")}. Move the affected workspace or configured storage paths to a volume allowed by the machine policy; see docs/DEVELOPMENT-STORAGE.md.`,
      );
    }
  }

  const volumes = storageVolumes(physicalPaths);
  const shortVolumes = volumes.filter((volume) => volume.free_bytes / GIB < requiredFreeGiB);
  if (shortVolumes.length) {
    throw new Error(
      `Portcove needs at least ${requiredFreeGiB.toFixed(1)} GiB free; ` +
        shortVolumes
          .map((volume) => `${volume.root} has ${(volume.free_bytes / GIB).toFixed(2)} GiB`)
          .join(", ") +
        ". Free verified disposable build caches or choose a volume with enough space; preserve source inputs, recovery material and verification evidence. See docs/DEVELOPMENT-STORAGE.md.",
    );
  }
  return { paths: physicalPaths, volumes };
}

function printable(paths: StoragePaths, volumes: StorageVolume[], requiredFreeGiB: number) {
  return {
    ...paths,
    minimum_free_gib: requiredFreeGiB,
    volumes: volumes.map((volume) => ({
      root: volume.root,
      free_gib: Number((volume.free_bytes / GIB).toFixed(2)),
    })),
  };
}

function printPaths(
  paths: StoragePaths,
  volumes: StorageVolume[],
  requiredFreeGiB: number,
  asJson: boolean,
) {
  const report = printable(paths, volumes, requiredFreeGiB);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  console.log(`Portcove workspace: ${report.workspace}`);
  if (report.target_directory) console.log(`Cargo target:       ${report.target_directory}`);
  console.log(`Temporary data:     ${report.temporary_directory}`);
  console.log(`Packaging output:   ${report.output_root}`);
  if (report.pnpm_store) console.log(`pnpm store:         ${report.pnpm_store}`);
  if (report.frontend_dependencies)
    console.log(`Repository packages: ${report.frontend_dependencies}`);
  if (report.desktop_dependencies)
    console.log(`Desktop packages:   ${report.desktop_dependencies}`);
  if (report.frontend_output) console.log(`Frontend output:    ${report.frontend_output}`);
  if (report.tauri_generated) console.log(`Tauri generated:    ${report.tauri_generated}`);
  for (const volume of report.volumes) {
    console.log(
      `Free on ${volume.root}:          ${volume.free_gib.toFixed(2)} GiB (minimum ${requiredFreeGiB.toFixed(1)} GiB)`,
    );
  }
}

export function childEnvironment(paths: Partial<StoragePaths>) {
  const overrides = Object.fromEntries(
    Object.entries({
      CARGO_TARGET_DIR: paths.target_directory,
      PORTCOVE_TEMP_DIR: paths.temporary_directory,
      PORTCOVE_OUTPUT_DIR: paths.output_root,
      PORTCOVE_PNPM_STORE_DIR: paths.pnpm_store,
      pnpm_config_store_dir: paths.pnpm_store,
      TEMP: paths.temporary_directory,
      TMP: paths.temporary_directory,
      TMPDIR: paths.temporary_directory,
    }).filter(([, value]) => value !== undefined),
  );
  const overriddenKeys = new Set(Object.keys(overrides).map((key: string) => key.toLowerCase()));
  // pnpm normalizes configuration variable names on every platform, even
  // where the operating system permits differently cased names to coexist.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key.toLowerCase() !== "pnpm_config_store_dir" &&
        (process.platform !== "win32" || !overriddenKeys.has(key.toLowerCase())),
    ),
  );
  return checkoutToolEnvironment({ ...inherited, ...overrides }, { paths: toolCachePaths() });
}

function ensureChildDirectories(paths: Partial<StoragePaths>) {
  for (const candidate of [paths.temporary_directory, paths.output_root, paths.pnpm_store]) {
    if (candidate) mkdirSync(candidate, { recursive: true });
  }
}

export function prepareStorageScope(scope: string) {
  const requiredFreeGiB = minimumFreeGiB();
  console.log(`Storage task: ${scope}`);
  const { paths, volumes } = preflight(getPaths(scope), requiredFreeGiB);
  printPaths(paths, volumes, requiredFreeGiB, false);
  ensureChildDirectories(paths);
  return childEnvironment(paths);
}

export function spawnCommand(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnCommand(
  command: string,
  args: readonly string[],
  options?: SpawnSyncOptionsWithBufferEncoding,
): SpawnSyncReturns<Buffer>;
export function spawnCommand(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer>;
export function spawnCommand(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  let result = spawnSync(command, args, options);
  const launchError = result.error;
  if (
    process.platform === "win32" &&
    launchError &&
    ["ENOENT", "EINVAL"].includes(errorCode(launchError) ?? "")
  ) {
    // Batch shims need cmd.exe. Quote every token and reject expansion/control
    // characters in both the executable and arguments before invoking the shell.
    const tokens = [command, ...args];
    if (tokens.some((token) => /["&|<>^%!()\r\n]/u.test(token))) {
      throw new Error(
        "Refusing shell metacharacters in a Windows command shim. Use a native executable or arguments without shell expansion/control characters.",
      );
    }
    const searchPath =
      Object.entries(options.env ?? process.env).find(
        ([key]) => key.toLowerCase() === "path",
      )?.[1] ?? "";
    const workingDirectory =
      options.cwd instanceof URL ? fileURLToPath(options.cwd) : (options.cwd ?? process.cwd());
    const directories =
      command.includes("/") || command.includes("\\")
        ? [workingDirectory]
        : [
            workingDirectory,
            ...searchPath.split(";").map((directory: string) => directory.replace(/^"|"$/g, "")),
          ];
    const names = /\.(cmd|bat)$/iu.test(command) ? [command] : [`${command}.cmd`, `${command}.bat`];
    const shim = directories
      .flatMap((directory: string) => names.map((name: string) => path.resolve(directory, name)))
      .find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
    if (!shim) throw launchError;
    if (/["&|<>^%!()\r\n]/u.test(shim))
      throw new Error(
        `Refusing shell metacharacters in a Windows command shim path: ${shim}. Use a native executable or a shim path without shell expansion/control characters.`,
      );
    const line = [shim, ...args].map((token) => `"${token}"`).join(" ");
    result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  if (result.error) throw result.error;
  return result;
}

export function canonicalCheckoutCommand(command: string, args: string[]): [string, string[]] {
  const executable = path.basename(command).toLowerCase();
  if (!path.isAbsolute(command) && new Set(["aqua", "aqua.exe"]).has(executable))
    return [pinnedAquaCommand(), args];
  if (new Set(["node", "node.exe"]).has(command.toLowerCase())) return [process.execPath, args];
  if (new Set(["corepack", "corepack.cmd", "corepack.exe"]).has(executable) && args[0] === "pnpm") {
    return [command, [readToolPins().packageManager, ...args.slice(1)]];
  }
  return [command, args];
}

function runChild(command: string, args: string[], paths: StoragePaths) {
  ensureChildDirectories(paths);
  const options = {
    cwd: projectRoot,
    env: childEnvironment(paths),
    stdio: "inherit" as const,
    windowsHide: true,
  };
  [command, args] = canonicalCheckoutCommand(command, args);
  const result = spawnCommand(command, args, options);
  return result.status ?? 1;
}

export function validateCleanTarget(paths: Pick<StoragePaths, "workspace" | "target_directory">) {
  if (typeof paths.target_directory !== "string")
    throw new Error(
      "Cargo target directory is unavailable. Run cargo metadata --format-version 1 --no-deps in this workspace and resolve target_directory before requesting cleanup.",
    );
  const target = path.resolve(paths.target_directory);
  const workspace = path.resolve(paths.workspace);
  if (target !== path.join(workspace, "target")) {
    throw new Error(
      `Refusing to clean anything except this workspace's target directory: ${target}. This command accepts only ${path.join(workspace, "target")}. Preserve the custom target and use its owning cleanup workflow.`,
    );
  }
  let current = target;
  while (true) {
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          `Refusing to clean through a symlink, junction, or non-directory: ${current}. Leave that path and its contents unchanged; use an ordinary workspace and target directory with no linked ancestors.`,
        );
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}

function cleanCargoTarget(paths: StoragePaths) {
  const target = validateCleanTarget(paths);
  console.log(`Cleaning exact Cargo target: ${target}`);
  const result = spawnSync("cargo", ["clean", "--target-dir", target], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function validateIncrementalCache(
  paths: Pick<StoragePaths, "workspace" | "target_directory">,
) {
  const target = validateCleanTarget(paths);
  const debug = path.join(target, "debug");
  const incremental = path.join(debug, "incremental");
  for (const candidate of [debug, incremental]) {
    try {
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          `Refusing to prune through a symlink, junction, or non-directory: ${candidate}. Leave that path and its contents unchanged; prune only an ordinary target/debug/incremental directory with no linked ancestors.`,
        );
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return incremental;
}

function pruneCargoIncremental(paths: StoragePaths) {
  const incremental = validateIncrementalCache(paths);
  try {
    lstatSync(incremental);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    console.log(`Cargo incremental cache is already absent: ${incremental}`);
    return 0;
  }
  console.log(`Pruning exact Cargo incremental cache: ${incremental}`);
  rmSync(incremental, { recursive: true, maxRetries: 3, retryDelay: 100 });
  return 0;
}

export function parseArguments(argv: string[]) {
  const remaining = [...argv];
  let action = "preflight";
  if (remaining[0] && !remaining[0].startsWith("-")) action = remaining.shift() ?? action;
  let asJson = false;
  let help = false;
  let requestedMinimum;
  let scope;
  while (remaining.length && remaining[0] !== "--") {
    const option = remaining.shift();
    if (option === "--help") help = true;
    else if (option === "--json") asJson = true;
    else if (option === "--scope") {
      scope = remaining.shift();
      if (!scope || !["all", "tooling", "frontend", "rust"].includes(scope))
        throw new Error(
          "--scope requires all, tooling, frontend or rust. Supply one of those values before --.",
        );
    } else if (option === "--minimum-free-gib") {
      requestedMinimum = remaining.shift();
      if (!requestedMinimum || requestedMinimum.startsWith("--")) {
        throw new Error(
          "--minimum-free-gib requires a positive GiB value. Supply a number greater than 0 before --.",
        );
      }
    } else throw new Error(`Unknown option: ${option}. See node scripts/dev-storage.mts --help.`);
  }
  if (remaining[0] === "--") remaining.shift();
  if (!["preflight", "run", "clean", "prune-incremental"].includes(action)) {
    throw new Error(
      `Unknown action ${action}; expected preflight, run, clean, or prune-incremental. See node scripts/dev-storage.mts --help.`,
    );
  }
  if (action === "run" && !remaining.length && !help)
    throw new Error(
      "run requires a command after --. Use node scripts/dev-storage.mts run [options] -- command [arguments...].",
    );
  if (action !== "run" && remaining.length)
    throw new Error(
      `${action} does not accept a command. Use run -- command [arguments...] to wrap a child command.`,
    );
  if (asJson && action !== "preflight")
    throw new Error(
      "--json is only supported by preflight. Use preflight --json to inspect storage without running a command.",
    );
  if (scope && ["clean", "prune-incremental"].includes(action))
    throw new Error(
      "Cleanup always resolves complete Cargo storage. Omit --scope when using clean or prune-incremental.",
    );
  return { action, asJson, requestedMinimum, scope, command: remaining, help };
}

export function isSideEffectFreeHelpCommand(command: readonly string[]) {
  const externalCommand: unknown = command;
  if (!Array.isArray(externalCommand) || !command.includes("--help")) return false;
  const executable = path.basename(command[0] ?? "").toLowerCase();
  if (!new Set(["node", "node.exe"]).has(executable)) return false;
  const script = String(command[1] ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "");
  return new Set([
    "scripts/local-validation.mts",
    "scripts/audit.mts",
    "scripts/desktop-test-cli.mts",
    "scripts/desktop-verify.mts",
  ]).has(script);
}

function main() {
  const { action, asJson, requestedMinimum, scope, command, help } = parseArguments(
    process.argv.slice(2),
  );
  if (help) {
    console.log(HELP);
    return 0;
  }
  const executable = command[0];
  if (action === "run" && !executable) throw new Error("run requires a command after --");
  if (action === "run" && executable && isSideEffectFreeHelpCommand(command)) {
    const result = spawnSync(executable, command.slice(1), {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  const plannerCommand =
    action === "run" &&
    executable &&
    ["node", "node.exe"].includes(path.basename(executable).toLowerCase()) &&
    path.resolve(projectRoot, command[1] ?? "") ===
      path.join(projectRoot, "scripts/local-validation.mts");
  const selectedScope = scope ?? (plannerCommand ? "tooling" : "all");
  if (!asJson && !["clean", "prune-incremental"].includes(action))
    console.log(`Storage task: ${selectedScope}`);
  const configuredPaths = getPaths(selectedScope);
  if (action === "clean") {
    return cleanCargoTarget(configuredPaths);
  }
  if (action === "prune-incremental") {
    return pruneCargoIncremental(configuredPaths);
  }

  const requiredFreeGiB = minimumFreeGiB(requestedMinimum);
  const { paths, volumes } = preflight(configuredPaths, requiredFreeGiB);
  printPaths(paths, volumes, requiredFreeGiB, asJson);
  if (action === "preflight") return 0;
  if (!executable) throw new Error("run requires a command after --");
  return runChild(executable, command.slice(1), paths);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Portcove development storage check failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
