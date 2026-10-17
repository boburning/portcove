import { resourceEntrypoint } from "./resource-command.mts";
import { vitePlusCommand } from "./viteplus-cli.mts";
import { spawnCommand } from "./dev-storage.mts";
import { lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function vitePlusNeedsCapacity(args: readonly string[], cwd = process.cwd()) {
  const action = args[0];
  if (action === "test" || action === "check") return true;
  if (action !== "lint") return false;
  const files = [];
  let literal = false;
  for (const argument of args.slice(1)) {
    if (!literal && argument === "--") {
      literal = true;
      continue;
    }
    if (!literal && argument.startsWith("-")) {
      if (!["--fix", "--quiet", "--fix-suggestions"].includes(argument)) return true;
      continue;
    }
    try {
      if (!lstatSync(path.resolve(cwd, argument)).isFile()) return true;
    } catch {
      return true;
    }
    files.push(argument);
  }
  return files.length === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = vitePlusCommand(process.cwd());
  const args = process.argv.slice(2);
  const run = () => {
    const result = spawnCommand(cli.command, [...cli.args, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  };
  process.exitCode = vitePlusNeedsCapacity(args)
    ? await resourceEntrypoint(args[0] === "test" ? "browser" : "analysis", run)
    : run();
}
