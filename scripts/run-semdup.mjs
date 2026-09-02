import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(fileURLToPath(new URL("../.semdup/", import.meta.url)), { recursive: true });
const command = process.platform === "win32" ? "semdup.exe" : "semdup";
const result = spawnSync(command, ["scan"], { cwd: repositoryRoot, encoding: "utf8", stdio: "inherit" });

if (result.error) {
  console.warn(`semdup advisory skipped: ${result.error.message}`);
} else if (result.status !== 0) {
  console.warn(`semdup advisory finished with exit ${result.status}; inspect the output above.`);
}
