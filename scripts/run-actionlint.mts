import type { SpawnSyncOptions } from "node:child_process";
import { runAqua } from "./tool-cache.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

export type ActionlintOptions = Pick<SpawnSyncOptions, "stdio" | "windowsHide"> & {
  encoding?: "utf8";
};
export type ActionlintRunner = (
  command: string,
  args: readonly string[],
  options: ActionlintOptions,
) => {
  status: number | null;
  stdout?: string | null;
  error?: Error;
};
export function runActionlint(
  arguments_: readonly string[],
  run: ActionlintRunner = (_command, args, options) =>
    runAqua(args, { ...options, encoding: "utf8" }),
) {
  const shellcheck = run("aqua", ["which", "shellcheck"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const shellcheckPath = shellcheck.stdout?.trim();
  if (shellcheck.error || shellcheck.status !== 0 || !shellcheckPath) {
    throw new Error(
      "the aqua-managed ShellCheck executable is unavailable; run the quality bootstrap",
    );
  }
  return run("aqua", ["exec", "--", "actionlint", `-shellcheck=${shellcheckPath}`, ...arguments_], {
    stdio: "inherit",
    windowsHide: true,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const result = runActionlint(process.argv.slice(2));
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
