import { fileURLToPath } from "node:url";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";

export function frontendEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !name.toUpperCase().startsWith("TAURI_SIGNING_"),
    ),
  );
}

export function buildFrontend(environment = process.env, run = spawnCommand, cached = false) {
  try {
    const result = run(
      "corepack",
      ["pnpm", "exec", "vp", ...(cached ? ["run", "bundle:cached"] : ["build"])],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: frontendEnvironment(environment),
        stdio: "inherit",
      },
    );
    return result.status ?? 1;
  } catch (error) {
    console.error(
      `Frontend build requires Corepack with the repository's pinned pnpm: ${error.message}. Run the repository bootstrap; no global pnpm shim is required.`,
    );
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = buildFrontend(process.env, spawnCommand, process.argv.includes("--cached"));
