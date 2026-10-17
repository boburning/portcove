import { errorMessage, isRecord } from "./runtime-values.mts";
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface RscheckFinding {
  severity: string;
  rule_id?: string;
  message?: string;
  primary?: { file?: string; start?: { line?: number | string } | null } | null;
}
function finding(value: unknown): RscheckFinding {
  if (!isRecord(value) || typeof value.severity !== "string")
    throw new TypeError("rscheck returned a finding without a text severity.");
  for (const key of ["rule_id", "message"] as const)
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new TypeError(`rscheck returned a finding with invalid ${key}.`);
  const primary = value.primary;
  if (primary !== undefined && primary !== null) {
    if (!isRecord(primary) || (primary.file !== undefined && typeof primary.file !== "string"))
      throw new TypeError("rscheck returned an invalid finding location.");
    if (primary.start !== undefined && primary.start !== null) {
      if (
        !isRecord(primary.start) ||
        (primary.start.line !== undefined &&
          typeof primary.start.line !== "number" &&
          typeof primary.start.line !== "string")
      )
        throw new TypeError("rscheck returned an invalid finding line.");
    }
  }
  // Preserve all scanner metadata while projecting only validated consumed fields.
  return {
    ...value,
    severity: value.severity,
    ...(typeof value.rule_id === "string" ? { rule_id: value.rule_id } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(primary === null
      ? { primary: null }
      : isRecord(primary)
        ? {
            primary: {
              ...primary,
              ...(typeof primary.file === "string" ? { file: primary.file } : {}),
              ...(primary.start === null
                ? { start: null }
                : isRecord(primary.start)
                  ? {
                      start: {
                        ...primary.start,
                        ...(typeof primary.start.line === "number" ||
                        typeof primary.start.line === "string"
                          ? { line: primary.start.line }
                          : {}),
                      },
                    }
                  : {}),
            },
          }
        : {}),
  };
}
export function assessRscheckReport<Finding extends Pick<RscheckFinding, "severity">>(report: {
  findings?: readonly Finding[];
}) {
  const findings = report.findings ?? [];
  return {
    denies: findings.filter((finding) => finding.severity === "deny"),
    warnings: findings.filter((finding) => finding.severity === "warn"),
  };
}

export function parseRscheckReport({ status, stdout }: { status: number | null; stdout: string }) {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    if (status !== 0 && status !== 1)
      throw new Error(`rscheck could not analyze the workspace (exit ${status ?? "unknown"}).`);
    throw new Error(`rscheck returned an invalid JSON report: ${errorMessage(error)}`);
  }
  if (!isRecord(report) || !Array.isArray(report.findings)) {
    if (status !== 0 && status !== 1)
      throw new Error(`rscheck could not analyze the workspace (exit ${status ?? "unknown"}).`);
    throw new Error("rscheck returned a JSON report without a findings array.");
  }
  const rawFindings: unknown[] = report.findings;
  return { ...report, findings: rawFindings.map(finding) };
}

function location(finding: RscheckFinding) {
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
