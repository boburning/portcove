import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(fileURLToPath(new URL("../.semdup/", import.meta.url)), { recursive: true });
const command = process.platform === "win32" ? "semdup.exe" : "semdup";
const result = spawnSync(command, ["scan"], { cwd: repositoryRoot, encoding: "utf8", stdio: "inherit" });
const requireExecution = process.env.PORTCOVE_REQUIRE_DEEP_TOOLS === "1";

function reportExecutionFailure(message) {
  console.warn(message);
  if (requireExecution) {
    process.exitCode = 1;
  }
}

if (result.error) {
  reportExecutionFailure(`semdup advisory skipped: ${result.error.message}`);
} else if (result.status !== 0) {
  reportExecutionFailure(
    `semdup advisory finished with exit ${result.status}; inspect the output above.`,
  );
}
