import { renderBoundedSummary } from "./bounded-summary.mjs";
import { summarizeFallow } from "./fallow-summary.mjs";
export { renderBoundedSummary } from "./bounded-summary.mjs";
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

const failureLabels = {
  "source-check": "source/check failure",
  "missing-prerequisite": "missing prerequisite",
  "executor-provider": "executor/provider failure",
  "external-service": "external-service/upstream-health failure",
  "evidence-collection": "evidence-collection failure",
  unknown: "unknown/unclassified",
};

// Structured observations, never a guess from log text or a change to a verdict.
export function describeFailure(result, kind = "unknown") {
  if (!Object.hasOwn(failureLabels, kind)) kind = "unknown";
  try {
    const error = result.error;
    if (/^spawn/u.test(error?.syscall ?? "")) {
      if (error.code === "ENOENT") kind = "missing-prerequisite";
      else if (["EACCES", "EPERM"].includes(error.code)) kind = "executor-provider";
    }
    const facts = [
      Number.isInteger(result.status) ? `exit ${result.status}` : null,
      error?.code ? `error ${error.code}` : null,
      result.signal ? `signal ${result.signal}` : null,
    ].filter(Boolean);
    return {
      kind,
      label: failureLabels[kind],
      observation: facts.join("; ") || "cause not established",
    };
  } catch {
    return {
      kind: "unknown",
      label: failureLabels.unknown,
      observation: "diagnostic facts unavailable",
    };
  }
}

export function commandFailure(
  message,
  result,
  directory,
  cause = result.error,
  kind = "unknown",
  retainedEvidence,
) {
  const evidence = retainedEvidence ?? retainCommandEvidence(directory, result);
  const failure = describeFailure(result, kind);
  const error = new Error(
    renderBoundedSummary(
      message,
      [
        `${failure.label}: ${failure.observation}`,
        String(result.stderr ?? ""),
        evidence.failure ? `evidence-collection failure (secondary): ${evidence.failure}` : "",
      ].filter(Boolean),
      {
        reference:
          [evidence.stdout, evidence.stderr].filter(Boolean).join("; ") || "retention unavailable",
      },
    ).text,
    { cause },
  );
  error.evidence = evidence;
  error.failure = failure;
  error.exitCode = result.status;
  return error;
}

export function summarizeReport(kind, report, reference) {
  if (!report || typeof report !== "object") throw new Error("Report must be a JSON object");
  if (kind === "renovate" && report.evidence) {
    const entries = report.evidence.candidates
      ? report.evidence.candidates.map(
          (entry) =>
            `#${entry.number} ${entry.head}: ${entry.verdict}; ${entry.reason}; ${entry.next_action}`,
        )
      : [`${report.evidence.head}: ${report.evidence.verdict}; ${report.evidence.reason}`];
    return renderBoundedSummary(report.summary, entries, { reference });
  }
  if (
    kind === "ui" &&
    Array.isArray(report.requested_files) &&
    Array.isArray(report.discovered_files) &&
    Array.isArray(report.executed_files)
  ) {
    return renderBoundedSummary(
      `UI selection: requested ${report.requested_files.length}; discovered ${report.discovered_files.length}; executed ${report.executed_files.length}; passed ${report.passed}; skipped ${report.skipped}`,
      report.requested_files,
      { reference },
    );
  }
  if (kind === "timings" && Array.isArray(report.records)) {
    const failed = report.records.filter((entry) => entry.outcome === "failed");
    const observed = new Map();
    for (const entry of failed) {
      const key = JSON.stringify(entry.context ?? {});
      const entries = observed.get(key) ?? [];
      entries.push(entry);
      observed.set(key, entries);
    }
    const failures = [...observed.values()].flatMap((entries) => {
      const ordered = entries.every((entry) => Number.isFinite(Date.parse(entry.recorded_at)));
      const earliest = ordered
        ? entries.reduce((stamp, entry) => Math.min(stamp, Date.parse(entry.recorded_at)), Infinity)
        : null;
      const selected = ordered
        ? entries.filter((entry) => Date.parse(entry.recorded_at) === earliest)
        : entries;
      return selected.map((entry) => {
        const failure = entry.failure;
        const label = Object.hasOwn(failureLabels, failure?.kind)
          ? failureLabels[failure.kind]
          : failureLabels.unknown;
        const order = !ordered
          ? "Order unavailable for"
          : selected.length === 1
            ? "First recorded"
            : "Co-earliest recorded (order ambiguous)";
        return `${order} failing producer ${entry.context?.job ?? "unknown job"}/${entry.context?.run ?? "unknown run"}/${entry.context?.attempt ?? "unknown attempt"} ${entry.phase}: ${label}; ${failure?.observation ?? "cause not established"}`;
      });
    });
    return renderBoundedSummary(
      "CI diagnostic timings (advisory; observed artifact coverage only; not acceptance evidence)",
      [
        ...failures,
        ...report.records.map(
          (entry) =>
            `${entry.context?.job ?? "unknown job"}/${entry.context?.run ?? "unknown run"}/${entry.context?.attempt ?? "unknown attempt"} ${entry.phase}: ${entry.elapsed_ms ?? "unmeasured"}ms; ${entry.outcome ?? "observed"}; cache ${entry.cache_outcome ?? "unknown"}${entry.selected_tests === undefined ? "" : `; tests ${entry.selected_tests}/${entry.complete_tests}`}`,
        ),
      ],
      { reference },
    );
  }
  if (
    kind === "watch" &&
    (report.evidence?.watch || report.evidence?.contexts || report.kind?.startsWith("delivery-"))
  ) {
    const watch = report.evidence?.watch ?? report.evidence ?? report;
    return renderBoundedSummary(
      report.summary ?? "Delivery watch",
      [
        `Source: ${report.evidence?.head ?? watch.head}; run: ${watch.run}; attempt: ${watch.attempt}; status: ${report.status ?? watch.workflow?.status ?? "unknown"}`,
        `Queue: ${watch.timings?.queue_ms ?? "unmeasured"}ms; required baseline: ${watch.timings?.baseline_elapsed_ms ?? "unmeasured"}ms`,
        ...(watch.contexts ?? []).map(
          (entry) => `${entry.context}: ${entry.outcome ?? entry.conclusion ?? "unknown"}`,
        ),
      ],
      { reference },
    );
  }
  if (kind === "doctor" && report.context) {
    return renderBoundedSummary(
      `Roadmap doctor: ${report.status}`,
      [
        `Checkout: ${report.context.root}; HEAD: ${report.context.head}; branch: ${report.context.branch}`,
        `Catalog: ${report.context.catalog}; SHA-256: ${report.context.catalog_sha256}; modified inputs: ${report.context.input_dirty}`,
        ...Object.entries(report.counts ?? {}).map(([key, value]) => `${key}: ${value}`),
        ...(report.errors ?? []),
        ...(report.warnings ?? []),
      ],
      { reference },
    );
  }
  if (kind === "ci" && Array.isArray(report.jobs)) {
    const entries = report.jobs
      .filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped")
      .map(
        (job) =>
          `${job.id ?? job.databaseId ?? "unknown ID"}: ${job.name}; ${job.status ?? "unknown"}/${job.conclusion ?? "pending"}`,
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
    return { text: summarizeFallow(report, reference) };
  }
  throw new Error(`Unsupported or malformed ${kind} report; no result claimed`);
}

export function retainReportSummary(kind, report, directory) {
  mkdirSync(directory, { recursive: true });
  const reference = path.join(directory, `${randomUUID()}.json`);
  writeFileSync(reference, JSON.stringify(report), { flag: "wx" });
  return summarizeReport(kind, report, reference);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const [kind, file, ...rest] = process.argv.slice(2);
    if (!file || rest.length)
      throw new Error(
        "usage: report-summary.mjs ci|roadmap|fallow|watch|doctor|timings|renovate|ui FILE",
      );
    if (statSync(file).size > 32 * 1024 * 1024)
      throw new Error("Report exceeds 32 MiB input limit");
    const result = summarizeReport(
      kind,
      JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/u, "")),
      file,
    );
    process.stdout.write(`${result.text}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
