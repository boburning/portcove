import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { evaluateFallowReport } from "./check-fallow-report.mjs";
import { renderBoundedSummary } from "./report-summary.mjs";

const desktopRoot = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const fallowBin = fileURLToPath(new URL("../node_modules/fallow/bin/fallow", import.meta.url));
const result = spawnSync(
  process.execPath,
  [fallowBin, "--format", "json", "--quiet", "--explain"],
  {
    cwd: desktopRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, FALLOW_AGENT_SOURCE: "codex" },
  },
);

const evidenceDirectory = fileURLToPath(new URL("../work/fallow-reports/", import.meta.url));
mkdirSync(evidenceDirectory, { recursive: true });
const evidencePath = `${evidenceDirectory}${randomUUID()}.json`;
writeFileSync(evidencePath, result.stdout ?? "", { flag: "wx" });

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
  const findings = report.health.findings
    .filter((entry) => entry.severity === "critical")
    .map(
      (entry) =>
        `${entry.path}:${entry.line}: ${entry.name}; cyclomatic ${entry.cyclomatic}; cognitive ${entry.cognitive}`,
    );
  console.error(
    renderBoundedSummary("Fallow quality gate failed", [...assessment.failures, ...findings], {
      reference: evidencePath,
    }).text,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Fallow gate passed: maintainability ${assessment.maintainability}, duplication ${assessment.duplicationPercentage}%.`,
  );
}
