import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requireExecution = process.env.PORTCOVE_REQUIRE_DEEP_TOOLS === "1";

function reportExecutionFailure(message) {
  console.warn(message);
  if (requireExecution) {
    process.exitCode = 1;
  }
}

if (process.platform === "win32") {
  reportExecutionFailure("Hawk advisory skipped: cargo-hawk 0.1.13 does not support Windows.");
} else {
  const result = spawnSync(
    "cargo",
    ["+1.98.0", "hawk", "check", "--only", "dead-public"],
    { cwd: repositoryRoot, encoding: "utf8", stdio: "inherit" },
  );
  if (result.error) {
    reportExecutionFailure(`Hawk advisory skipped: ${result.error.message}`);
  } else if (result.status !== 0) {
    reportExecutionFailure(
      `Hawk advisory finished with exit ${result.status}; inspect the output above.`,
    );
  }
}
