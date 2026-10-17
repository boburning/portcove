import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runResourceCommand } from "./resource-command.mts";
import { frontendOutputResource } from "./resource-capacity.mts";
import { spawnCommand } from "./dev-storage.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = path.join(root, "apps", "desktop");

export function nativeBuildCommand(
  args: readonly string[],
  options: { resolve?: (id: string) => string } = {},
) {
  const resolve = options.resolve ?? createRequire(path.join(desktop, "package.json")).resolve;
  return {
    executable: process.execPath,
    args: [resolve("@tauri-apps/cli/tauri.js"), "build", ...args],
    cwd: desktop,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = nativeBuildCommand(process.argv.slice(2));
  if (process.argv.includes("--help")) {
    const result = spawnCommand(command.executable, command.args, {
      cwd: command.cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else {
    process.exitCode = await runResourceCommand("rust", command.executable, command.args, {
      cwd: desktop,
      exclusive: [frontendOutputResource(root)],
    });
  }
}
