import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function evaluateFallowReport(report) {
  const failures = [];
  if (report.check.total_issues) failures.push(`${report.check.total_issues} dead-code or dependency findings`);
  if (report.dupes.stats.duplication_percentage > 2) {
    failures.push(`${report.dupes.stats.duplication_percentage}% duplication`);
  }
  if (report.health.summary.severity_critical_count) {
    failures.push(`${report.health.summary.severity_critical_count} critical complexity findings`);
  }
  return {
    failures,
    maintainability: report.health.summary.average_maintainability,
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
