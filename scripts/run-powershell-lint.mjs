import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "win32") {
  console.log("PSScriptAnalyzer is enforced by the required hosted Windows job.");
} else {
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-File", path.join(projectRoot, "scripts", "run-powershell-lint.ps1")],
    {
      cwd: projectRoot,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
