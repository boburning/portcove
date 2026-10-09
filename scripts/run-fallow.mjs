import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateFallowReport } from "./check-fallow-report.mjs";
import { commandFailure, renderBoundedSummary, retainCommandEvidence } from "./report-summary.mjs";

export function runFallow({
  spawn = spawnSync,
  evidenceDirectory = fileURLToPath(new URL("../work/fallow-reports/", import.meta.url)),
} = {}) {
  const result = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/fallow/bin/fallow", import.meta.url)),
      "--format",
      "json",
      "--quiet",
      "--explain",
    ],
    {
      cwd: fileURLToPath(new URL("../apps/desktop/", import.meta.url)),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, FALLOW_AGENT_SOURCE: "codex" },
    },
  );
  if (result.error || (result.status !== 0 && result.status !== 1))
    throw commandFailure(
      `Fallow could not analyze the frontend (exit ${result.status ?? "unknown"})`,
      result,
      evidenceDirectory,
    );
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw commandFailure(
      "Fallow returned an invalid JSON report",
      result,
      evidenceDirectory,
      error,
    );
  }
  const evidence = retainCommandEvidence(evidenceDirectory, result);
  let assessment;
  try {
    assessment = evaluateFallowReport(report);
  } catch (error) {
    throw commandFailure(
      "Fallow returned an invalid report shape",
      result,
      evidenceDirectory,
      error,
    );
  }
  if (evidence.failure)
    throw commandFailure("Fallow evidence could not be retained", result, evidenceDirectory);
  if (assessment.failures.length) {
    const findings = report.health.findings
      .filter((entry) => entry.severity === "critical")
      .map(
        (entry) =>
          `${entry.path}:${entry.line}: ${entry.name}; cyclomatic ${entry.cyclomatic}; cognitive ${entry.cognitive}`,
      );
    return {
      exitCode: 1,
      text: renderBoundedSummary(
        "Fallow quality gate failed",
        [...assessment.failures, ...findings],
        { reference: Object.values(evidence).join("; ") },
      ).text,
    };
  }
  return {
    exitCode: 0,
    text: `Fallow gate passed: maintainability ${assessment.maintainability}, duplication ${assessment.duplicationPercentage}%.`,
  };
}

export function formatFallowFailure(error) {
  return error.evidence && Buffer.byteLength(error.message) <= 16 * 1024 - 1
    ? error.message
    : renderBoundedSummary("Fallow failed", [String(error.message)]).text;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = runFallow();
    (result.exitCode ? console.error : console.log)(result.text);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(formatFallowFailure(error));
    process.exitCode = 1;
  }
}
