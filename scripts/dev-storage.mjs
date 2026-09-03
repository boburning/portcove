#!/usr/bin/env node

import { lstatSync, mkdirSync, realpathSync, statSync, statfsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const DEFAULT_MINIMUM_FREE_GIB = 20;
const GIB = 1024 ** 3;

function resolveConfiguredPath(value, fallback) {
  return path.resolve(projectRoot, value || fallback);
}

function cargoMetadata() {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed with exit code ${result.status}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

export function isWindowsSystemDrivePath(candidate, systemDrive = "C:") {
  const normalizeRoot = value => value.replaceAll("/", "\\").replace(/^\\\\[?.]\\/u, "").toLowerCase();
  const systemRoot = normalizeRoot(path.win32.parse(`${systemDrive}\\`).root);
  const candidateRoot = normalizeRoot(path.win32.parse(candidate).root);
  return Boolean(candidateRoot) && candidateRoot === systemRoot;
}

export function windowsSystemDriveViolations(paths, systemDrive = "C:") {
  return Object.entries(paths)
    .filter(([, candidate]) => isWindowsSystemDrivePath(candidate, systemDrive))
    .map(([label, candidate]) => `${label}=${candidate}`);
}

function getPaths() {
  const metadata = cargoMetadata();
  const metadataRoot = path.resolve(metadata.workspace_root);
  if (metadataRoot.toLowerCase() !== projectRoot.toLowerCase()) {
    throw new Error(`Cargo workspace ${metadataRoot} does not match script workspace ${projectRoot}`);
  }

  return {
    workspace: metadataRoot,
    target_directory: path.resolve(metadata.target_directory),
    temporary_directory: resolveConfiguredPath(process.env.PORTCOVE_TEMP_DIR, "work/temp"),
    output_root: resolveConfiguredPath(process.env.PORTCOVE_OUTPUT_DIR, "outputs"),
    pnpm_store: resolveConfiguredPath(process.env.PORTCOVE_PNPM_STORE_DIR, "work/pnpm-store"),
    frontend_dependencies: path.join(projectRoot, "apps/desktop/node_modules"),
    frontend_output: path.join(projectRoot, "apps/desktop/dist"),
    tauri_generated: path.join(projectRoot, "apps/desktop/src-tauri/gen"),
  };
}

function nearestExistingPath(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    try {
      lstatSync(current);
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`No existing ancestor for ${candidate}`);
      current = parent;
    }
  }
}

export function resolvePhysicalPath(candidate) {
  const existing = nearestExistingPath(candidate);
  if (!statSync(existing).isDirectory()) throw new Error(`Storage path is not a directory: ${existing}`);
  return path.resolve(realpathSync.native(existing), path.relative(existing, path.resolve(candidate)));
}

export function storageVolumes(paths) {
  const volumes = new Map();
  for (const candidate of Object.values(paths)) {
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

export function minimumFreeGiB(value) {
  const parsed = Number(value ?? process.env.PORTCOVE_MIN_FREE_GIB ?? DEFAULT_MINIMUM_FREE_GIB);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Minimum free space must be a positive GiB value, received ${value}`);
  }
  return parsed;
}

export function preflight(paths, requiredFreeGiB) {
  paths = Object.fromEntries(Object.entries(paths).map(([label, candidate]) => [label, resolvePhysicalPath(candidate)]));
  if (process.platform === "win32") {
    const violations = windowsSystemDriveViolations(paths, process.env.SystemDrive || "C:");
    if (violations.length) {
      throw new Error(
        `Heavy Portcove work is blocked because these paths resolve to the Windows system drive: ${violations.join(", ")}`,
      );
    }
  }

  const volumes = storageVolumes(paths);
  const shortVolumes = volumes.filter(volume => volume.free_bytes / GIB < requiredFreeGiB);
  if (shortVolumes.length) {
    throw new Error(
      `Portcove needs at least ${requiredFreeGiB.toFixed(1)} GiB free; `
      + shortVolumes.map(volume => `${volume.root} has ${(volume.free_bytes / GIB).toFixed(2)} GiB`).join(", "),
    );
  }
  return { paths, volumes };
}

function printable(paths, volumes, requiredFreeGiB) {
  return {
    ...paths,
    minimum_free_gib: requiredFreeGiB,
    volumes: volumes.map(volume => ({
      root: volume.root,
      free_gib: Number((volume.free_bytes / GIB).toFixed(2)),
    })),
  };
}

function printPaths(paths, volumes, requiredFreeGiB, asJson) {
  const report = printable(paths, volumes, requiredFreeGiB);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  console.log(`Portcove workspace: ${report.workspace}`);
  console.log(`Cargo target:       ${report.target_directory}`);
  console.log(`Temporary data:     ${report.temporary_directory}`);
  console.log(`Packaging output:   ${report.output_root}`);
  console.log(`pnpm store:         ${report.pnpm_store}`);
  console.log(`Frontend packages:  ${report.frontend_dependencies}`);
  console.log(`Frontend output:    ${report.frontend_output}`);
  console.log(`Tauri generated:    ${report.tauri_generated}`);
  for (const volume of report.volumes) {
    console.log(`Free on ${volume.root}:          ${volume.free_gib.toFixed(2)} GiB (minimum ${requiredFreeGiB.toFixed(1)} GiB)`);
  }
}

export function childEnvironment(paths) {
  const overrides = {
    CARGO_TARGET_DIR: paths.target_directory,
    PORTCOVE_TEMP_DIR: paths.temporary_directory,
    PORTCOVE_OUTPUT_DIR: paths.output_root,
    PORTCOVE_PNPM_STORE_DIR: paths.pnpm_store,
    pnpm_config_store_dir: paths.pnpm_store,
    TEMP: paths.temporary_directory,
    TMP: paths.temporary_directory,
    TMPDIR: paths.temporary_directory,
  };
  const overriddenKeys = new Set(Object.keys(overrides).map(key => key.toLowerCase()));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    process.platform !== "win32" || !overriddenKeys.has(key.toLowerCase())));
  return { ...inherited, ...overrides };
}

function ensureChildDirectories(paths) {
  for (const candidate of [paths.temporary_directory, paths.output_root, paths.pnpm_store]) {
    mkdirSync(candidate, { recursive: true });
  }
}

export function spawnCommand(command, args, options) {
  let result = spawnSync(command, args, options);
  if (process.platform === "win32" && ["ENOENT", "EINVAL"].includes(result.error?.code)) {
    // Batch shims need cmd.exe. Quote every token and reject expansion/control
    // characters in both the executable and arguments before invoking the shell.
    const tokens = [command, ...args];
    if (tokens.some(token => /["&|<>^%!()\r\n]/u.test(token))) {
      throw new Error("Refusing shell metacharacters in a Windows command shim");
    }
    const searchPath = Object.entries(options.env ?? process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
    const directories = command.includes("/") || command.includes("\\")
      ? [options.cwd ?? process.cwd()]
      : [options.cwd ?? process.cwd(), ...searchPath.split(";").map(directory => directory.replace(/^"|"$/g, ""))];
    const names = /\.(cmd|bat)$/iu.test(command) ? [command] : [`${command}.cmd`, `${command}.bat`];
    const shim = directories.flatMap(directory => names.map(name => path.resolve(directory, name)))
      .find(candidate => statSync(candidate, { throwIfNoEntry: false })?.isFile());
    if (!shim) throw result.error;
    if (/["&|<>^%!()\r\n]/u.test(shim)) throw new Error("Refusing shell metacharacters in a Windows command shim path");
    const line = [shim, ...args].map(token => `"${token}"`).join(" ");
    result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  if (result.error) throw result.error;
  return result;
}

function runChild(command, args, paths) {
  ensureChildDirectories(paths);
  const options = {
    cwd: projectRoot,
    env: childEnvironment(paths),
    stdio: "inherit",
    windowsHide: true,
  };
  const result = spawnCommand(command, args, options);
  return result.status ?? 1;
}

export function validateCleanTarget(paths) {
  const target = path.resolve(paths.target_directory);
  const workspace = path.resolve(paths.workspace);
  if (target !== path.join(workspace, "target")) {
    throw new Error(`Refusing to clean anything except this workspace's target directory: ${target}`);
  }
  let current = target;
  while (true) {
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Refusing to clean through a symlink, junction, or non-directory: ${current}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}

function cleanCargoTarget(paths) {
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

export function parseArguments(argv) {
  const remaining = [...argv];
  let action = "preflight";
  if (remaining[0] && !remaining[0].startsWith("-")) action = remaining.shift();
  let asJson = false;
  let requestedMinimum;
  while (remaining.length && remaining[0] !== "--") {
    const option = remaining.shift();
    if (option === "--json") asJson = true;
    else if (option === "--minimum-free-gib") {
      requestedMinimum = remaining.shift();
      if (!requestedMinimum || requestedMinimum.startsWith("--")) {
        throw new Error("--minimum-free-gib requires a positive GiB value");
      }
    }
    else throw new Error(`Unknown option: ${option}`);
  }
  if (remaining[0] === "--") remaining.shift();
  if (!["preflight", "run", "clean"].includes(action)) {
    throw new Error(`Unknown action ${action}; expected preflight, run, or clean`);
  }
  if (action === "run" && !remaining.length) throw new Error("run requires a command after --");
  if (action !== "run" && remaining.length) throw new Error(`${action} does not accept a command`);
  if (asJson && action !== "preflight") throw new Error("--json is only supported by preflight");
  return { action, asJson, requestedMinimum, command: remaining };
}

function main() {
  const { action, asJson, requestedMinimum, command } = parseArguments(process.argv.slice(2));
  const configuredPaths = getPaths();
  if (action === "clean") {
    return cleanCargoTarget(configuredPaths);
  }

  const requiredFreeGiB = minimumFreeGiB(requestedMinimum);
  const { paths, volumes } = preflight(configuredPaths, requiredFreeGiB);
  printPaths(paths, volumes, requiredFreeGiB, asJson);
  if (action === "preflight") return 0;
  return runChild(command[0], command.slice(1), paths);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = main();
  }
  catch (error) {
    console.error(`Portcove development storage check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
