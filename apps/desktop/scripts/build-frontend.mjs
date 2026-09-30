import { fileURLToPath } from "node:url";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";

export function frontendEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !name.toUpperCase().startsWith("TAURI_SIGNING_"),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const environment = frontendEnvironment(process.env);
  for (const arguments_ of [["typecheck"], ["exec", "vite", "build"]]) {
    const result = spawnCommand("pnpm", arguments_, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: environment,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
