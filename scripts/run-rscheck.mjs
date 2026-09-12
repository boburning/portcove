import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export function assessRscheckReport(report) {
  const findings = report.findings ?? [];
  return {
    denies: findings.filter((finding) => finding.severity === "deny"),
    warnings: findings.filter((finding) => finding.severity === "warn"),
  };
}

export function parseRscheckReport({ status, stdout }) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    if (status !== 0 && status !== 1)
      throw new Error(`rscheck could not analyze the workspace (exit ${status ?? "unknown"}).`);
    throw new Error(`rscheck returned an invalid JSON report: ${error.message}`);
  }
  if (!report || !Array.isArray(report.findings)) {
    if (status !== 0 && status !== 1)
      throw new Error(`rscheck could not analyze the workspace (exit ${status ?? "unknown"}).`);
    throw new Error("rscheck returned a JSON report without a findings array.");
  }
  return report;
}

function location(finding) {
  const file = relative(repositoryRoot, finding.primary?.file ?? "unknown");
  const line = finding.primary?.start?.line ?? "?";
  return `${file}:${line}`;
}

export function main() {
  const command = process.platform === "win32" ? "rscheck.exe" : "rscheck";
  const result = spawnSync(command, ["check", "--format", "json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  let report;
  try {
    report = parseRscheckReport(result);
  } catch (error) {
    process.stderr.write(result.stderr ?? "");
    if (result.error) console.error(result.error.message);
    throw error;
  }

  const assessment = assessRscheckReport(report);
  for (const finding of assessment.warnings) {
    console.warn(`rscheck advisory [${finding.rule_id}] ${location(finding)}: ${finding.message}`);
  }
  for (const finding of assessment.denies) {
    console.error(`rscheck failure [${finding.rule_id}] ${location(finding)}: ${finding.message}`);
  }
  console.log(
    `rscheck completed: ${assessment.warnings.length} advisory finding(s), ${assessment.denies.length} blocking finding(s).`,
  );
  if (assessment.denies.length > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
