import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { commandFor, loadQualityManifest } from "./quality-tools.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const requireExecution = process.env.PORTCOVE_REQUIRE_DEEP_TOOLS === "1";
const manifest = await loadQualityManifest();
const hawk = manifest.tools.find((tool) => tool.id === "cargo-hawk");

function reportExecutionFailure(message) {
  console.warn(message);
  if (requireExecution) {
    process.exitCode = 1;
  }
}

if (process.platform === "win32") {
  reportExecutionFailure(
    `Hawk advisory skipped: cargo-hawk ${hawk.version} does not support Windows.`,
  );
} else {
  const command = commandFor(manifest, hawk);
  const result = spawnSync(
    command[0],
    [...command.slice(1, -1), "check", "--only", "dead-public"],
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
