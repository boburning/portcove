import { readFile } from "node:fs/promises";

const [reportPath] = process.argv.slice(2);
if (!reportPath) throw new Error("usage: node check-fallow-report.mjs <report.json>");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const failures = [];
if (report.check.total_issues) failures.push(`${report.check.total_issues} dead-code or dependency findings`);
if (report.dupes.stats.duplication_percentage > 2) failures.push(`${report.dupes.stats.duplication_percentage}% duplication`);
if (report.health.summary.severity_critical_count) failures.push(`${report.health.summary.severity_critical_count} critical complexity findings`);
if (failures.length) {
  console.error(`Fallow quality gate failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`Fallow gate passed: maintainability ${report.health.summary.average_maintainability}, duplication ${report.dupes.stats.duplication_percentage}%.`);
