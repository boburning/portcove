import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function retainCommandEvidence(directory, result) {
  const id = randomUUID();
  const evidence = {};
  try {
    mkdirSync(directory, { recursive: true });
    for (const stream of ["stdout", "stderr"]) {
      const file = path.join(directory, `${id}.${stream}.log`);
      writeFileSync(file, result[stream] ?? "", { flag: "wx" });
      evidence[stream] = file;
    }
  } catch (error) {
    evidence.failure = `Evidence retention failed (${error.code ?? "unknown"})`;
  }
  return evidence;
}

export function commandFailure(message, result, directory, cause = result.error) {
  const evidence = retainCommandEvidence(directory, result);
  const error = new Error(
    renderBoundedSummary(
      message,
      [String(result.stderr ?? ""), evidence.failure ?? ""].filter(Boolean),
      { reference: Object.values(evidence).join("; ") },
    ).text,
    { cause },
  );
  error.evidence = evidence;
  error.exitCode = result.status;
  return error;
}

export function renderBoundedSummary(
  title,
  entries,
  { reference = null, maximumBytes = 16 * 1024 } = {},
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 256)
    throw new RangeError("Summary limit must be at least 256 bytes");
  const lines = [];
  let bytes = 0;
  const append = (line) => {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > maximumBytes - 200) return false;
    lines.push(line);
    bytes += size;
    return true;
  };
  append(String(title).slice(0, 128));
  if (reference) append(`Raw evidence: ${reference}`);
  let included = 0;
  for (const entry of entries) {
    if (!append(String(entry))) break;
    included++;
  }
  const omitted = entries.length - included;
  lines.push(`Findings: ${entries.length}; shown: ${included}; omitted: ${omitted}`);
  return { text: lines.join("\n"), total: entries.length, omitted };
}

export function summarizeReport(kind, report, reference) {
  if (!report || typeof report !== "object") throw new Error("Report must be a JSON object");
  if (kind === "ci" && Array.isArray(report.jobs)) {
    const entries = report.jobs
      .filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped")
      .map(
        (job) =>
          `${job.id}: ${job.name}; ${job.status ?? "unknown"}/${job.conclusion ?? "pending"}`,
      );
    return renderBoundedSummary(
      `CI jobs: observed ${report.jobs.length}; provider total ${report.total_count ?? "unknown"}; inventory completeness must be verified separately`,
      entries,
      { reference },
    );
  }
  if (kind === "roadmap" && report.canonical_issue && report.planning) {
    return renderBoundedSummary(
      `#${report.canonical_issue.number} ${report.canonical_issue.title}`,
      [
        `Revision: ${report.snapshot?.revision ?? "unknown"}`,
        `Comparison: ${report.comparison?.state ?? "unknown"}; reservation: ${report.reservation?.assessment ?? "unknown"}`,
        ...Object.entries(report.planning).map(([key, value]) => `${key}: ${value ?? "unset"}`),
      ],
      { reference },
    );
  }
  if (kind === "fallow" && report.health?.summary) {
    const entries = (report.health.findings ?? [])
      .filter((entry) => entry.severity === "critical")
      .map(
        (entry) =>
          `${entry.path}:${entry.line}: ${entry.name}; cyclomatic ${entry.cyclomatic}; cognitive ${entry.cognitive}`,
      );
    return renderBoundedSummary(
      `Fallow: critical complexity ${report.health.summary.severity_critical_count}; dead-code/dependency ${report.check?.total_issues ?? "unknown"}; duplication ${report.dupes?.stats?.duplication_percentage ?? "unknown"}%`,
      entries,
      { reference },
    );
  }
  throw new Error(`Unsupported or malformed ${kind} report; no result claimed`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const [kind, file, ...rest] = process.argv.slice(2);
    if (!file || rest.length) throw new Error("usage: report-summary.mjs ci|roadmap|fallow FILE");
    if (statSync(file).size > 32 * 1024 * 1024)
      throw new Error("Report exceeds 32 MiB input limit");
    const result = summarizeReport(kind, JSON.parse(readFileSync(file, "utf8")), file);
    process.stdout.write(`${result.text}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
