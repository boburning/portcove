import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandFailure } from "./report-summary.mts";
import type { CommandObservation } from "./report-summary.mts";
import { errorCode, errorMessage } from "./runtime-values.mts";

interface GitOptions {
  cwd?: string;
  timeoutMs?: number;
  encoding?: "buffer" | "utf8";
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptions,
  ) => CommandObservation;
}
function literalArguments(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((arg: unknown) => typeof arg === "string");
}

export function runCheckedGit(args: unknown, options: GitOptions & { encoding: "buffer" }): Buffer;
export function runCheckedGit(args: unknown, options?: GitOptions & { encoding?: "utf8" }): string;
export function runCheckedGit(args: unknown, options: GitOptions = {}): string | Buffer {
  if (!literalArguments(args) || !args.length || args.some((arg) => arg.includes("\0")))
    throw new TypeError("Git arguments must be a nonempty array of literal strings");
  const { spawn = spawnSync, cwd = process.cwd(), timeoutMs = 30_000 } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new RangeError("Git timeout must be from 1 through 60000 milliseconds");
  const result = spawn("git", args, {
    cwd,
    encoding: options.encoding === "buffer" ? null : "utf8",
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const error = commandFailure(
      `Git command failed (${errorCode(result.error) ?? `exit ${result.status ?? "unknown"}`})`,
      result,
      path.join(cwd, "work", "checked-git"),
    );
    error.code = errorCode(result.error) ?? "GIT_EXIT";
    throw error;
  }
  if (
    options.encoding === "buffer"
      ? !Buffer.isBuffer(result.stdout)
      : typeof result.stdout !== "string"
  )
    throw new TypeError("Successful Git adapter returned incompatible output encoding");
  // The two runtime checks intentionally remain separate to narrow the union.
  if (typeof result.stdout === "string" || Buffer.isBuffer(result.stdout)) return result.stdout;
  throw new TypeError("Successful Git adapter omitted stdout");
}

export function runCheckedGitSequence(steps: unknown, options: GitOptions = {}) {
  if (!Array.isArray(steps) || !steps.length)
    throw new TypeError("Git sequence must contain argument arrays");
  return steps.map((args: unknown) =>
    options.encoding === "buffer"
      ? runCheckedGit(args, { ...options, encoding: "buffer" })
      : runCheckedGit(args, { ...options, encoding: "utf8" }),
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const results =
      args[0] === "--sequence" && args.length === 2
        ? runCheckedGitSequence(JSON.parse(readFileSync(args[1] ?? "", "utf8")))
        : [runCheckedGit(args[0] === "--" ? args.slice(1) : args)];
    for (const result of results) process.stdout.write(result ?? "");
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
