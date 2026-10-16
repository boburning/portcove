import { fileURLToPath } from "node:url";
import { lstatSync, rmSync } from "node:fs";
import path from "node:path";
import { resolvePhysicalPath, spawnCommand } from "../../../scripts/dev-storage.mjs";
import { vitePlusCommand } from "../../../scripts/viteplus-cli.mjs";

export function frontendEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !name.toUpperCase().startsWith("TAURI_SIGNING_"),
    ),
  );
}

export function buildFrontend(
  environment = process.env,
  run = spawnCommand,
  fresh = false,
  directory = fileURLToPath(new URL("../", import.meta.url)),
) {
  try {
    const cwd = path.resolve(directory);
    const cli = vitePlusCommand(cwd);
    const output = path.join(cwd, "dist");
    const details = lstatSync(output, { throwIfNoEntry: false });
    if (details) {
      if (
        !details.isDirectory() ||
        details.isSymbolicLink() ||
        resolvePhysicalPath(output) !== path.join(resolvePhysicalPath(cwd), "dist")
      )
        throw new Error("Frontend dist must be an ordinary owned directory");
      // Task replay restores captured files but retains unrelated output files.
      // Mirror Vite's emptyOutDir boundary before either execute or restore.
      rmSync(output, { recursive: true });
    }
    const result = run(
      cli.command,
      [...cli.args, "run", ...(fresh ? ["--no-cache"] : []), "frontend:bundle"],
      {
        cwd,
        env: frontendEnvironment(environment),
        stdio: "inherit",
      },
    );
    return result.status ?? 1;
  } catch (error) {
    console.error(`Frontend build failed: ${error.message}`);
    if (["MODULE_NOT_FOUND", "ENOENT"].includes(error.code))
      console.error(
        "Install the declared local tools with pnpm install --frozen-lockfile from the repository root.",
      );
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = buildFrontend(process.env, spawnCommand, process.argv.includes("--fresh"));
