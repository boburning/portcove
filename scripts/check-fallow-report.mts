import { isRecord } from "./runtime-values.mts";
import type { GateOutcome, CheckOutput, HealthSummary } from "fallow/types";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function object(value: unknown, field: string) {
  if (!isRecord(value)) throw new Error(`Invalid Fallow ${field}: expected object`);
  return value;
}

function metric(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER, integer = true) {
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
function validateFallowReport(value: unknown) {
  const report = object(value, "report");
  if (report.kind !== "combined" || report.schema_version !== 14 || report.version !== "3.36.0")
    throw new Error(
      "Unsupported Fallow report kind, schema or tool version (expected combined/14/3.36.0)",
    );
  const check = object(report.check, "check");
  const dupes = object(report.dupes, "dupes");
  const stats = object(dupes.stats, "dupes.stats");
  const health = object(report.health, "health");
  const summary = object(health.summary, "health.summary");
  const totalIssues: CheckOutput["total_issues"] = metric(check.total_issues, "check.total_issues");
  const duplication = metric(
    stats.duplication_percentage,
    "dupes.stats.duplication_percentage",
    100,
    false,
  );
  const criticalCount: HealthSummary["severity_critical_count"] = metric(
    summary.severity_critical_count,
    "health.summary.severity_critical_count",
  );
  const maintainability =
    summary.average_maintainability == null
      ? "unavailable"
      : metric(
          summary.average_maintainability,
          "health.summary.average_maintainability",
          100,
          false,
        );
  if (!Array.isArray(health.findings) || !Array.isArray(dupes.clone_groups))
    throw new Error("Incomplete Fallow finding arrays");
  const findings: unknown[] = health.findings;
  const critical = findings.filter(
    (finding) => isRecord(finding) && finding.severity === "critical",
  ).length;
  if (critical !== criticalCount) throw new Error("Inconsistent Fallow critical complexity count");
  const gates = object(report.gate_outcomes, "gate_outcomes");
  for (const name of ["error-severity-findings", "health-findings"])
    object(gates[name], `gate_outcomes.${name}`);
  const outcomes = new Map<string, Pick<GateOutcome, "status" | "enforced">>();
  for (const [name, value] of Object.entries(gates)) {
    const gate = object(value, `gate_outcomes.${name}`);
    if (
      (gate.status !== "pass" &&
        gate.status !== "warn" &&
        gate.status !== "fail" &&
        gate.status !== "skipped") ||
      typeof gate.enforced !== "boolean"
    )
      throw new Error(`Invalid Fallow gate outcome: ${name}`);
    for (const key of ["observed", "threshold"])
      if (gate[key] != null) metric(gate[key], `${name}.${key}`, Number.MAX_SAFE_INTEGER, false);
    outcomes.set(name, { status: gate.status, enforced: gate.enforced });
  }
  for (const [name, outcome] of Object.entries(
    report.request_outcomes == null ? {} : object(report.request_outcomes, "request_outcomes"),
  ))
    if (!isRecord(outcome) || outcome.status !== "applied")
      throw new Error(`Fallow request not applied: ${name}`);
  return { totalIssues, criticalCount, duplication, maintainability, outcomes };
}

export function evaluateFallowReport(value: unknown, { requireParseGate = false } = {}) {
  const report = validateFallowReport(value);
  const parseGate = report.outcomes.get("parse-error");
  if (
    requireParseGate &&
    (parseGate?.enforced !== true || !["pass", "fail"].includes(parseGate.status))
  )
    throw new Error("Incomplete Fallow qualification: native parse-error gate was not enforced");
  const failures = [];
  if (requireParseGate && isRecord(value)) {
    // The native parse gate deliberately covers parser diagnostics only. A read
    // failure (including invalid UTF-8) or an empty required scope cannot qualify
    // either; optional churn/ownership and intentional exclusions remain advisory.
    for (const container of [value, value.check, value.health]) {
      if (!isRecord(container) || container.workspace_diagnostics === undefined) continue;
      if (!Array.isArray(container.workspace_diagnostics))
        throw new Error("Invalid Fallow workspace_diagnostics: expected array");
      for (const diagnostic of container.workspace_diagnostics)
        if (
          isRecord(diagnostic) &&
          ["source-read-failure", "no-source-files-analyzed"].includes(String(diagnostic.kind))
        )
          failures.push(
            `required source analysis incomplete: ${String(diagnostic.kind)} (${typeof diagnostic.path === "string" ? diagnostic.path : "whole scope"})`,
          );
    }
  }
  if (report.totalIssues) failures.push(`${report.totalIssues} dead-code or dependency findings`);
  if (report.criticalCount) {
    failures.push(`${report.criticalCount} critical complexity findings`);
  }
  for (const [name, gate] of report.outcomes)
    if (gate.status === "fail" && gate.enforced)
      failures.push(`enforced Fallow gate failed: ${name}`);
  return {
    failures,
    maintainability: report.maintainability,
    duplicationPercentage: report.duplication,
  };
}

async function main() {
  const [reportPath] = process.argv.slice(2);
  if (reportPath === "--help" && process.argv.length === 3) {
    console.log(`Usage: node scripts/check-fallow-report.mts <report.json>

Validate a retained Fallow report and enforce the repository's whole-Desktop
qualification gates. This command reads an existing report; it does not run Fallow.

Arguments:
  <report.json>  Required combined JSON report from the repository-pinned Fallow version.
  --help         Show this help without reading a report.

Malformed, incomplete or incompatible reports fail. Dead-code/dependency findings,
critical complexity and enforced native gates fail; duplication is advisory.

Example:
  node scripts/check-fallow-report.mts work/fallow-report.json`);
    return;
  }
  if (!reportPath)
    throw new Error(
      "Usage: node scripts/check-fallow-report.mts <report.json>. Run with --help for an example.",
    );
  const report: unknown = JSON.parse(await readFile(reportPath, "utf8"));
  const assessment = evaluateFallowReport(report, { requireParseGate: true });
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
