import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Existing exact-byte formatter exclusions shared with the staged route. */
export const exactByteFormatInputs = Object.freeze([
  "release/bootstrap-public-inputs/**",
  ".github/workflows/application-update-production.yml",
  "docs/qualification/application-update-production.windows-20261103.proposed.yml",
  "scripts/fixtures/release-resource-baseline-20261103/**",
  "vendor/rfd/**",
]);

export function stagedVitePlusChecks(files: readonly string[], cwd = process.cwd()) {
  const preserved = (file: string) => {
    const relative = path.relative(cwd, path.resolve(cwd, file)).replaceAll("\\", "/");
    return exactByteFormatInputs.some((pattern) =>
      pattern.endsWith("/**") ? relative.startsWith(pattern.slice(0, -2)) : relative === pattern,
    );
  };
  return [false, true].flatMap((keepBytes) =>
    stagedFileBatches(files.filter((file) => preserved(file) === keepBytes)).map((batch) => [
      "check",
      "--fix",
      ...(keepBytes ? ["--no-fmt"] : []),
      "--",
      ...batch,
    ]),
  );
}

/** Bound native argv too; never send filenames through a command-shell shim. */
export function stagedFileBatches(files: readonly string[], limit = 6000): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const size = JSON.stringify(file).length + 1;
    if (size > limit) throw new Error(`Staged path exceeds argument budget: ${file}`);
    if (length + size > limit) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(file);
    length += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

type StagedSpawn = typeof spawnSync;

export function checkStagedFiles(
  files: readonly string[],
  cwd = process.cwd(),
  spawn: StagedSpawn = spawnSync,
) {
  const cli = vitePlusCommand(cwd);
  for (const args of stagedVitePlusChecks(files, cwd)) {
    const result = spawn(cli.command, [...cli.args, ...args], {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Staged Vite+ check failed (${result.signal ?? result.status ?? "unknown"})`);
  }
  if (files.some((file) => file.toLowerCase().endsWith(".rs"))) checkStagedRustFormat(cwd, spawn);
}

/** Read-only `cargo fmt` gate, run once per call (not per batch), never rewriting files. */
export function checkStagedRustFormat(cwd: string, spawn: StagedSpawn = spawnSync) {
  const missing =
    "Rust formatting check needs cargo on PATH. Install the Rust toolchain pinned by rust-toolchain.toml, then retry the commit.";
  const probe = spawn("cargo", ["--version"], { cwd, stdio: "ignore", windowsHide: true });
  if (probe.error || probe.status !== 0) throw new Error(missing);
  // Same storage wrapper as the `rustfmt-check` just recipe.
  const result = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./dev-storage.mts", import.meta.url)),
      "run",
      "--",
      "cargo",
      "fmt",
      "--all",
      "--",
      "--check",
    ],
    { cwd, stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Rust format check failed (${result.signal ?? result.status ?? "unknown"}). If the output above lists formatting differences, run \`cargo fmt --all\`, review the diff, stage it and commit again.`,
    );
}

/** Resolve the installed package's declared executable, never PATH or a download. */
export function vitePlusCommand(cwd: string) {
  const require = createRequire(path.join(path.resolve(cwd), "package.json"));
  const packageFile = require.resolve("vite-plus/package.json");
  const parsed: unknown = JSON.parse(readFileSync(packageFile, "utf8"));
  if (!isRecord(parsed)) throw new Error("Installed Vite+ manifest must be an object");
  const manifest = parsed;
  const bin =
    typeof manifest.bin === "string"
      ? manifest.bin
      : isRecord(manifest.bin)
        ? manifest.bin.vp
        : undefined;
  if (manifest.name !== "vite-plus" || typeof bin !== "string")
    throw new Error("Installed Vite+ does not declare its vp executable");
  const directory = path.dirname(packageFile);
  const executable = path.resolve(directory, bin);
  const relative = path.relative(directory, executable);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  )
    throw new Error("Installed Vite+ executable escapes its package");
  if (!statSync(executable).isFile()) throw new Error("Installed Vite+ executable is not a file");
  const header = Buffer.alloc(128);
  const file = openSync(executable, "r");
  let length;
  try {
    length = readSync(file, header);
  } finally {
    closeSync(file);
  }
  const node = /^#![^\r\n]*\bnode(?:\s|$)/u.test(header.subarray(0, length).toString("utf8"));
  return {
    command: node ? process.execPath : executable,
    args: node ? [executable] : [],
    executable,
    version: manifest.version,
    packageFile,
  };
}
