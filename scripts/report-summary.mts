import { renderBoundedSummary } from "./bounded-summary.mts";
import { summarizeFallow } from "./fallow-summary.mts";
export { renderBoundedSummary } from "./bounded-summary.mts";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorCode, isRecord, errorMessage } from "./runtime-values.mts";

/** Observations shared by native spawn results and bounded test process adapters. */
export interface CommandObservation {
  status?: number | null | undefined;
  signal?: NodeJS.Signals | null | undefined;
  error?: unknown;
  stdout?: string | Buffer | null | undefined;
  stderr?: string | Buffer | null | undefined;
}
export interface CommandEvidence {
  stdout?: string;
  stderr?: string;
  failure?: string;
}
export class CommandFailure extends Error {
  declare evidence: CommandEvidence;
  declare failure: ReturnType<typeof describeFailure>;
  declare exitCode: number | null | undefined;
  declare code?: string;
}

export function retainCommandEvidence(
  directory: string,
  result: CommandObservation,
): CommandEvidence {
  const id = randomUUID();
  const evidence: CommandEvidence = {};
  try {
    mkdirSync(directory, { recursive: true });
    for (const stream of ["stdout", "stderr"] as const) {
      const file = path.join(directory, `${id}.${stream}.log`);
      writeFileSync(file, result[stream] ?? "", { flag: "wx" });
      evidence[stream] = file;
    }
  } catch (error) {
    evidence.failure = `Evidence retention failed (${errorCode(error) ?? "unknown"})`;
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
export function describeFailure(result: unknown, kind: string = "unknown") {
  if (!Object.hasOwn(failureLabels, kind)) kind = "unknown";
  try {
    if (!isRecord(result)) throw new TypeError("Missing process observation");
    const error = result.error;
    const code = errorCode(error);
    if (isRecord(error) && typeof error.syscall === "string" && /^spawn/u.test(error.syscall)) {
      if (code === "ENOENT") kind = "missing-prerequisite";
      else if (code === "EACCES" || code === "EPERM") kind = "executor-provider";
    }
    const facts = [
      Number.isInteger(result.status) ? `exit ${diagnosticString(result.status)}` : null,
      code ? `error ${code}` : null,
      result.signal ? `signal ${diagnosticString(result.signal)}` : null,
    ].filter(Boolean);
    return {
      kind,
      label:
        Object.entries(failureLabels).find(([name]) => name === kind)?.[1] ?? failureLabels.unknown,
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
  message: string,
  result: CommandObservation,
  directory: string,
  cause: unknown = result.error,
  kind: string = "unknown",
  retainedEvidence?: CommandEvidence,
) {
  const evidence = retainedEvidence ?? retainCommandEvidence(directory, result);
  const failure = describeFailure(result, kind);
  const error = new CommandFailure(
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

function diagnosticString(value: unknown): string {
  return String(value);
}
function fields(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) throw new TypeError("Missing report section");
  if (isRecord(value)) return value;
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return Object.fromEntries(Object.entries(items));
  }
  if (typeof value === "string")
    return Object.fromEntries(
      value.split("").map((character, index) => [String(index), character]),
    );
  return {};
}
function optionalFields(value: unknown): Record<string, unknown> {
  return value == null ? {} : fields(value);
}
function arrayRows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected report array");
  return value;
}
function rows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  throw new TypeError("Expected report rows");
}
function failureLabel(value: unknown): string {
  return (
    Object.entries(failureLabels).find(([name]) => name === value)?.[1] ?? failureLabels.unknown
  );
}
type CountedReportKind =
  | "ci"
  | "roadmap"
  | "watch"
  | "doctor"
  | "timings"
  | "renovate"
  | "ui"
  | "native";
type CountedSummary = ReturnType<typeof renderBoundedSummary>;
// Inputs remain untrusted presentation data. This projection does not establish
// report validity, inventory completeness, acceptance, or a reusable verdict.
export function summarizeReport(
  kind: CountedReportKind,
  report: unknown,
  reference: string,
): CountedSummary;
export function summarizeReport(
  kind: "fallow",
  report: unknown,
  reference: string,
): { text: string };
export function summarizeReport(
  kind: string,
  report: unknown,
  reference: string,
): CountedSummary | { text: string };
export function summarizeReport(kind: string, report: unknown, reference: string) {
  if (!isRecord(report)) throw new Error("Report must be a JSON object");
  if (
    kind === "native" &&
    (report.format_version === 2 || report.format_version === 3) &&
    Array.isArray(report.checks)
  ) {
    const checks = arrayRows(report.checks).map(fields);
    const setup = arrayRows(report.setup_checks ?? []).map(fields);
    const gaps = arrayRows(report.known_gaps ?? []).map(fields);
    const selected = arrayRows(report.selected_scenarios ?? []);
    const executable = optionalFields(report.executable);
    const referenceFits = Buffer.byteLength(reference) <= 2048;
    return renderBoundedSummary(
      "Native execution observations (recorded facts; no compiled-source, installed or acceptance inference)",
      [
        `Counts: checks ${checks.length}; setup ${setup.length}; selected ${selected.length}; gaps ${gaps.length}; inputs ${arrayRows(report.inputs ?? []).length}; artifacts ${arrayRows(report.artifacts ?? []).length}`,
        ...(!referenceFits
          ? [
              `Raw evidence reference omitted: ${Buffer.byteLength(reference)} UTF-8 bytes; retain the original input path`,
            ]
          : []),
        `Recorded outcome: ${diagnosticString(report.outcome ?? "unknown")}; recorded qualification_complete: ${diagnosticString(report.qualification_complete ?? "unknown")}`,
        `Recorded runner revision: ${diagnosticString(report.revision ?? "unknown")}; clean: ${diagnosticString(optionalFields(report.source_state).clean ?? "unknown")}`,
        `Executable: ${diagnosticString(executable.path ?? "unknown")}; bytes: ${diagnosticString(executable.bytes ?? "unknown")}; SHA-256: ${diagnosticString(executable.sha256 ?? "unknown")}`,
        ...gaps.map(
          (gap) =>
            `Gap ${diagnosticString(gap.scenario)}: ${diagnosticString(gap.reason ?? "unspecified")}`,
        ),
        ...setup.map(
          (check) =>
            `Setup ${diagnosticString(check.scenario)}: ${diagnosticString(check.outcome ?? "unknown")}; ${diagnosticString(check.reason ?? check.message ?? "no detail recorded")}`,
        ),
        ...checks.map(
          (check) =>
            `Check ${diagnosticString(check.scenario)}: ${diagnosticString(check.outcome ?? "unknown")}; ${diagnosticString(check.reason ?? check.message ?? "no detail recorded")}`,
        ),
        ...selected.map((scenario) => `Selected: ${diagnosticString(scenario)}`),
      ],
      { reference: referenceFits ? reference : null },
    );
  }
  if (kind === "renovate" && report.evidence) {
    const evidence = fields(report.evidence);
    const entries = evidence.candidates
      ? arrayRows(evidence.candidates).map((value) => {
          const entry = fields(value);
          return `#${diagnosticString(entry.number)} ${diagnosticString(entry.head)}: ${diagnosticString(entry.verdict)}; ${diagnosticString(entry.reason)}; ${diagnosticString(entry.next_action)}`;
        })
      : [
          `${diagnosticString(evidence.head)}: ${diagnosticString(evidence.verdict)}; ${diagnosticString(evidence.reason)}`,
        ];
    return renderBoundedSummary(diagnosticString(report.summary), entries, { reference });
  }
  if (
    kind === "ui" &&
    Array.isArray(report.requested_files) &&
    Array.isArray(report.discovered_files) &&
    Array.isArray(report.executed_files)
  ) {
    return renderBoundedSummary(
      `UI selection: requested ${diagnosticString(report.requested_files.length)}; discovered ${diagnosticString(report.discovered_files.length)}; executed ${diagnosticString(report.executed_files.length)}; passed ${diagnosticString(report.passed)}; skipped ${diagnosticString(report.skipped)}`,
      rows(report.requested_files).map(diagnosticString),
      { reference },
    );
  }
  if (kind === "timings" && Array.isArray(report.records)) {
    const records = rows(report.records).map(fields);
    const failed = records.filter((entry) => entry.outcome === "failed");
    const observed = new Map<string, Record<string, unknown>[]>();
    for (const entry of failed) {
      const key = JSON.stringify(entry.context ?? {});
      const entries = observed.get(key) ?? [];
      entries.push(entry);
      observed.set(key, entries);
    }
    const failures = [...observed.values()].flatMap((entries) => {
      const ordered = entries.every((entry) =>
        Number.isFinite(Date.parse(diagnosticString(entry.recorded_at))),
      );
      const earliest = ordered
        ? entries.reduce(
            (stamp, entry) => Math.min(stamp, Date.parse(diagnosticString(entry.recorded_at))),
            Infinity,
          )
        : null;
      const selected = ordered
        ? entries.filter((entry) => Date.parse(diagnosticString(entry.recorded_at)) === earliest)
        : entries;
      return selected.map((entry) => {
        const failure = optionalFields(entry.failure);
        const label = failureLabel(failure.kind);
        const order = !ordered
          ? "Order unavailable for"
          : selected.length === 1
            ? "First recorded"
            : "Co-earliest recorded (order ambiguous)";
        return `${diagnosticString(order)} failing producer ${diagnosticString(optionalFields(entry.context).job ?? "unknown job")}/${diagnosticString(optionalFields(entry.context).run ?? "unknown run")}/${diagnosticString(optionalFields(entry.context).attempt ?? "unknown attempt")} ${diagnosticString(entry.phase)}: ${diagnosticString(label)}; ${diagnosticString(failure.observation ?? "cause not established")}`;
      });
    });
    return renderBoundedSummary(
      "CI diagnostic timings (advisory; observed artifact coverage only; not acceptance evidence)",
      [
        ...failures,
        ...records.map(
          (entry) =>
            `${diagnosticString(optionalFields(entry.context).job ?? "unknown job")}/${diagnosticString(optionalFields(entry.context).run ?? "unknown run")}/${diagnosticString(optionalFields(entry.context).attempt ?? "unknown attempt")} ${diagnosticString(entry.phase)}: ${diagnosticString(entry.elapsed_ms ?? "unmeasured")}ms; ${diagnosticString(entry.outcome ?? "observed")}; cache ${diagnosticString(entry.cache_outcome ?? "unknown")}${diagnosticString(entry.selected_tests === undefined ? "" : `; tests ${diagnosticString(entry.selected_tests)}/${diagnosticString(entry.complete_tests)}`)}`,
        ),
      ],
      { reference },
    );
  }
  if (
    kind === "watch" &&
    (optionalFields(report.evidence).watch ||
      optionalFields(report.evidence).contexts ||
      (typeof report.kind === "string" && report.kind.startsWith("delivery-")))
  ) {
    const evidence = optionalFields(report.evidence);
    const watch = fields(evidence.watch ?? report.evidence ?? report);
    return renderBoundedSummary(
      diagnosticString(report.summary ?? "Delivery watch"),
      [
        `Source: ${diagnosticString(evidence.head ?? watch.head)}; run: ${diagnosticString(watch.run)}; attempt: ${diagnosticString(watch.attempt)}; status: ${diagnosticString(report.status ?? optionalFields(watch.workflow).status ?? "unknown")}`,
        `Queue: ${diagnosticString(optionalFields(watch.timings).queue_ms ?? "unmeasured")}ms; required baseline: ${diagnosticString(optionalFields(watch.timings).baseline_elapsed_ms ?? "unmeasured")}ms`,
        ...arrayRows(watch.contexts ?? []).map((value) => {
          const entry = fields(value);
          return `${diagnosticString(entry.context)}: ${diagnosticString(entry.outcome ?? entry.conclusion ?? "unknown")}`;
        }),
      ],
      { reference },
    );
  }
  if (kind === "doctor" && report.context) {
    const context = fields(report.context);
    return renderBoundedSummary(
      `Roadmap doctor: ${diagnosticString(report.status)}`,
      [
        `Scope: ${diagnosticString(optionalFields(report.scope).kind ?? "global")}; coverage: ${diagnosticString(report.coverage ?? "unknown")}; global health: ${diagnosticString(report.global_health ?? "unknown")}`,
        `Checkout: ${diagnosticString(context.root)}; HEAD: ${diagnosticString(context.head)}; branch: ${diagnosticString(context.branch)}`,
        `Catalog: ${diagnosticString(context.catalog)}; SHA-256: ${diagnosticString(context.catalog_sha256)}; modified inputs: ${diagnosticString(context.input_dirty)}`,
        ...Object.entries(optionalFields(report.counts)).map(
          ([key, value]) => `${diagnosticString(key)}: ${diagnosticString(value)}`,
        ),
        ...rows(report.errors ?? []).map(diagnosticString),
        ...rows(report.warnings ?? []).map(diagnosticString),
        ...(optionalFields(report.diagnosis).recovery_condition
          ? [`Recovery: ${diagnosticString(optionalFields(report.diagnosis).recovery_condition)}`]
          : []),
      ],
      { reference },
    );
  }
  if (kind === "ci" && Array.isArray(report.jobs)) {
    const jobs = rows(report.jobs).map(fields);
    const entries = jobs
      .filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped")
      .map(
        (job) =>
          `${diagnosticString(job.id ?? job.databaseId ?? "unknown ID")}: ${diagnosticString(job.name)}; ${diagnosticString(job.status ?? "unknown")}/${diagnosticString(job.conclusion ?? "pending")}`,
      );
    return renderBoundedSummary(
      `CI jobs: observed ${diagnosticString(report.jobs.length)}; provider total ${diagnosticString(report.total_count ?? "unknown")}; inventory completeness must be verified separately`,
      entries,
      { reference },
    );
  }
  if (kind === "roadmap" && report.canonical_issue && report.planning) {
    const issue = fields(report.canonical_issue);
    return renderBoundedSummary(
      `#${diagnosticString(issue.number)} ${diagnosticString(issue.title)}`,
      [
        `Revision: ${diagnosticString(optionalFields(report.snapshot).revision ?? "unknown")}`,
        `Comparison: ${diagnosticString(optionalFields(report.comparison).state ?? "unknown")}; reservation: ${diagnosticString(optionalFields(report.reservation).assessment ?? "unknown")}`,
        ...Object.entries(fields(report.planning)).map(
          ([key, value]) => `${diagnosticString(key)}: ${diagnosticString(value ?? "unset")}`,
        ),
      ],
      { reference },
    );
  }
  if (kind === "fallow" && optionalFields(report.health).summary) {
    return { text: summarizeFallow(report, reference) };
  }
  throw new Error(`Unsupported or malformed ${diagnosticString(kind)} report; no result claimed`);
}

export function retainReportSummary(
  kind: CountedReportKind,
  report: unknown,
  directory: string,
): CountedSummary;
export function retainReportSummary(
  kind: "fallow",
  report: unknown,
  directory: string,
): { text: string };
export function retainReportSummary(
  kind: string,
  report: unknown,
  directory: string,
): CountedSummary | { text: string };
export function retainReportSummary(kind: string, report: unknown, directory: string) {
  mkdirSync(directory, { recursive: true });
  const reference = path.join(directory, `${randomUUID()}.json`);
  const contents = JSON.stringify(report);
  if (contents === undefined) throw new TypeError("Report is not JSON serializable");
  writeFileSync(reference, contents, { flag: "wx" });
  return summarizeReport(kind, report, reference);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const [kind, file, ...rest] = process.argv.slice(2);
    if (!kind || !file || rest.length)
      throw new Error(
        "usage: report-summary.mts ci|roadmap|fallow|watch|doctor|timings|renovate|ui|native FILE",
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
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
