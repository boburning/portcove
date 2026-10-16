import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid Fallow ${field}: expected object`);
  return value;
}

function metric(value, field, maximum = Number.MAX_SAFE_INTEGER, integer = true) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error(
      `Invalid Fallow ${field}: expected finite nonnegative ${integer ? "count" : "metric"}`,
    );
  return value;
}

// Validate the wire contract before using the published types. A type assertion
// alone cannot make parsed JSON trustworthy. Version changes require review.
function validateFallowReport(value) {
  const report = object(value, "report");
  if (report.kind !== "combined" || report.schema_version !== 13 || report.version !== "3.33.1")
    throw new Error(
      "Unsupported Fallow report kind, schema or tool version (expected combined/13/3.33.1)",
    );
  object(report.check, "check");
  object(report.dupes, "dupes");
  object(report.dupes.stats, "dupes.stats");
  object(report.health, "health");
  object(report.health.summary, "health.summary");
  metric(report.check.total_issues, "check.total_issues");
  metric(
    report.dupes.stats.duplication_percentage,
    "dupes.stats.duplication_percentage",
    100,
    false,
  );
  metric(report.health.summary.severity_critical_count, "health.summary.severity_critical_count");
  if (report.health.summary.average_maintainability != null)
    metric(
      report.health.summary.average_maintainability,
      "health.summary.average_maintainability",
      100,
      false,
    );
  if (!Array.isArray(report.health.findings) || !Array.isArray(report.dupes.clone_groups))
    throw new Error("Incomplete Fallow finding arrays");
  const critical = report.health.findings.filter(
    (finding) => finding?.severity === "critical",
  ).length;
  if (critical !== report.health.summary.severity_critical_count)
    throw new Error("Inconsistent Fallow critical complexity count");
  const gates = object(report.gate_outcomes, "gate_outcomes");
  for (const name of ["error-severity-findings", "health-findings"])
    object(gates[name], `gate_outcomes.${name}`);
  for (const [name, gate] of Object.entries(object(report.gate_outcomes, "gate_outcomes"))) {
    object(gate, `gate_outcomes.${name}`);
    if (
      !["pass", "warn", "fail", "skipped"].includes(gate.status) ||
      typeof gate.enforced !== "boolean"
    )
      throw new Error(`Invalid Fallow gate outcome: ${name}`);
    for (const key of ["observed", "threshold"])
      if (gate[key] != null) metric(gate[key], `${name}.${key}`, Number.MAX_SAFE_INTEGER, false);
  }
  for (const [name, outcome] of Object.entries(report.request_outcomes ?? {}))
    if (outcome?.status !== "applied") throw new Error(`Fallow request not applied: ${name}`);
  return /** @type {import("fallow/types").CombinedOutput} */ (report);
}

export function evaluateFallowReport(value) {
  const report = validateFallowReport(value);
  const failures = [];
  if (report.check.total_issues)
    failures.push(`${report.check.total_issues} dead-code or dependency findings`);
  if (report.health.summary.severity_critical_count) {
    failures.push(`${report.health.summary.severity_critical_count} critical complexity findings`);
  }
  for (const [name, gate] of Object.entries(report.gate_outcomes))
    if (gate.status === "fail" && gate.enforced)
      failures.push(`enforced Fallow gate failed: ${name}`);
  return {
    failures,
    maintainability: report.health.summary.average_maintainability ?? "unavailable",
    duplicationPercentage: report.dupes.stats.duplication_percentage,
  };
}

async function main() {
  const [reportPath] = process.argv.slice(2);
  if (!reportPath) throw new Error("usage: node check-fallow-report.mjs <report.json>");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const assessment = evaluateFallowReport(report);
  if (assessment.failures.length) {
    console.error(`Fallow quality gate failed: ${assessment.failures.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Fallow gate passed: maintainability ${assessment.maintainability}, duplication ${assessment.duplicationPercentage}%.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
