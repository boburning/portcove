import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { spawnSync } from "node:child_process";

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

export function checkStagedFiles(files: readonly string[], cwd = process.cwd()) {
  const cli = vitePlusCommand(cwd);
  for (const batch of stagedFileBatches(files)) {
    const result = spawnSync(cli.command, [...cli.args, "check", "--fix", "--", ...batch], {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Staged Vite+ check failed (${result.signal ?? result.status ?? "unknown"})`);
  }
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
