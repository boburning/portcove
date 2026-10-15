import { fileURLToPath } from "node:url";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";
import { vitePlusCommand } from "../../../scripts/viteplus-cli.mjs";

export function frontendEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !name.toUpperCase().startsWith("TAURI_SIGNING_"),
    ),
  );
}

export function buildFrontend(environment = process.env, run = spawnCommand, cached = false) {
  try {
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    const cli = vitePlusCommand(cwd);
    const result = run(
      cli.command,
      [...cli.args, ...(cached ? ["run", "bundle:cached"] : ["build"])],
      {
        cwd,
        env: frontendEnvironment(environment),
        stdio: "inherit",
      },
    );
    return result.status ?? 1;
  } catch (error) {
    console.error(
      `Frontend build requires the installed local Vite+ CLI: ${error.message}. Run pnpm install --frozen-lockfile from the repository root.`,
    );
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = buildFrontend(process.env, spawnCommand, process.argv.includes("--cached"));
