import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function runCheckedGit(args, options = {}) {
  if (
    !Array.isArray(args) ||
    !args.length ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
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
    const error = new Error(
      `Git command failed (${result.error?.code ?? `exit ${result.status ?? "unknown"}`}): ${String(result.stderr ?? "").slice(0, 16_000)}`,
      { cause: result.error },
    );
    error.code = result.error?.code ?? "GIT_EXIT";
    error.exitCode = result.status;
    throw error;
  }
  return result.stdout;
}

export function runCheckedGitSequence(steps, options = {}) {
  if (!Array.isArray(steps) || !steps.length)
    throw new TypeError("Git sequence must contain argument arrays");
  return steps.map((args) => runCheckedGit(args, options));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const results =
      args[0] === "--sequence" && args.length === 2
        ? runCheckedGitSequence(JSON.parse(readFileSync(args[1], "utf8")))
        : [runCheckedGit(args[0] === "--" ? args.slice(1) : args)];
    for (const result of results) process.stdout.write(result ?? "");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
