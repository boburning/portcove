import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { evaluateFallowReport } from "./check-fallow-report.mjs";

const desktopRoot = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const fallowBin = fileURLToPath(new URL("../apps/desktop/node_modules/fallow/bin/fallow", import.meta.url));
const result = spawnSync(
  process.execPath,
  [fallowBin, "--format", "json", "--quiet", "--explain"],
  { cwd: desktopRoot, encoding: "utf8", env: { ...process.env, FALLOW_AGENT_SOURCE: "codex" } },
);

if (result.status !== 0 && result.status !== 1) {
  process.stderr.write(result.stderr ?? "");
  if (result.error) console.error(result.error.message);
  throw new Error(`Fallow could not analyze the frontend (exit ${result.status ?? "unknown"}).`);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  process.stderr.write(result.stderr ?? "");
  throw new Error(`Fallow returned an invalid JSON report: ${error.message}`);
}

const assessment = evaluateFallowReport(report);
if (assessment.failures.length > 0) {
  console.error(`Fallow quality gate failed: ${assessment.failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(
    `Fallow gate passed: maintainability ${assessment.maintainability}, duplication ${assessment.duplicationPercentage}%.`,
  );
}
