import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import type { CommandObservation } from "./report-summary.mts";
export interface FallowProcessResult extends CommandObservation {
  evidenceFailure?: string;
  status: number | null;
  stdout: string | null;
  stderr: string | null;
}
export type FallowSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
  capture?: import("./fallow-execution.mts").FallowCapture,
) => FallowProcessResult | Promise<FallowProcessResult>;
export interface FallowOptions {
  spawn?: FallowSpawn;
  mode?: string;
  base?: string | undefined;
  reuse?: string | undefined;
  identity?: () => ReturnType<typeof fallowSource>;
  evidenceDirectory?: string;
  jobSummary?: string | null | undefined;
  environment?: NodeJS.ProcessEnv;
}
import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
import { executeFallow } from "./fallow-execution.mts";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  lstatSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateFallowReport, reviewedFallowVersion } from "./check-fallow-report.mts";
import { commandFailure, renderBoundedSummary, retainCommandEvidence } from "./report-summary.mts";
import { summarizeFallow } from "./fallow-summary.mts";
import { fallowSource } from "./fallow-source.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/fallow/bin/fallow", import.meta.url));
const version = reviewedFallowVersion;

// Fixed maintained scopes must not silently inherit a production subset, a line
// filter, or a different semantic backend. Cache and presentation settings remain
// independent of evidence identity. Native defaults pin churn's clock to HEAD.
function analysisEnvironment(environment: NodeJS.ProcessEnv) {
  if (environment.FALLOW_DIFF_FILE)
    throw new Error(
      "FALLOW_DIFF_FILE is incompatible with maintained whole-scope routes; use a targeted native investigation",
    );
  const env: NodeJS.ProcessEnv = { ...environment, FALLOW_AGENT_SOURCE: "codex" };
  for (const name of [
    "FALLOW_PRODUCTION",
    "FALLOW_PRODUCTION_DEAD_CODE",
    "FALLOW_PRODUCTION_HEALTH",
    "FALLOW_PRODUCTION_DUPES",
    "FALLOW_PACKAGE_BASELINES",
    "FALLOW_MAX_FILE_SIZE",
    "FALLOW_TYPE_AWARE",
    "FALLOW_TYPE_AWARE_BIN",
    "FALLOW_TYPE_AWARE_TIMEOUT_SECS",
    "FALLOW_AUDIT_BASE",
    "FALLOW_CLOCK_EPOCH",
  ])
    delete env[name];
  return env;
}

function evidenceIdentity(file: string): { path: string; sha256: string } {
  const hash = createHash("sha256");
  const visit = (file: string, relative: string) => {
    const stat = lstatSync(file);
    hash.update(relative).update("\0");
    if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const name of readdirSync(file).sort())
        visit(path.join(file, name), `${relative}/${name}`);
    } else if (stat.isFile()) hash.update("file\0").update(readFileSync(file)).update("\0");
    else throw new Error(`Nonregular Fallow external evidence: ${file}`);
  };
  visit(file, ".");
  return { path: file, sha256: hash.digest("hex") };
}

function effectiveEvidence(mode: string, env: NodeJS.ProcessEnv) {
  const scopeRoot = mode === "desktop" || mode === "css" ? path.join(root, "apps/desktop") : root;
  const configPath = path.join(
    scopeRoot,
    mode === "desktop" || mode === "css" ? ".fallowrc.json" : ".fallow-tooling.json",
  );
  const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!isRecord(config)) throw new Error("Invalid Fallow configuration");
  // These routes support the maintained local configurations. Additional input
  // loaders need an explicit inventory before they can establish reusable evidence.
  for (const name of ["extends", "plugins", "rulePacks"])
    if (config[name] != null && (!Array.isArray(config[name]) || config[name].length > 0))
      throw new Error(
        `Maintained Fallow reuse does not inventory config.${name}; use native analysis until its external inputs are identified`,
      );
  const health = isRecord(config.health) ? config.health : {};
  const coverage = env.FALLOW_COVERAGE || health.coverage;
  const coverageRoot = env.FALLOW_COVERAGE_ROOT || health.coverageRoot;
  const audit = isRecord(config.audit) ? config.audit : {};
  const baselines = (
    mode === "review" ? ["deadCodeBaseline", "healthBaseline", "dupesBaseline"] : []
  ).map((name) => {
    const file = audit[name];
    return typeof file === "string" && file
      ? evidenceIdentity(path.resolve(scopeRoot, file))
      : null;
  });
  const plugins = path.join(scopeRoot, ".fallow/plugins");
  return {
    coverage:
      typeof coverage === "string" && coverage
        ? evidenceIdentity(path.resolve(scopeRoot, coverage))
        : null,
    coverage_root:
      typeof coverageRoot === "string" && coverageRoot
        ? path.resolve(scopeRoot, coverageRoot)
        : null,
    baselines,
    local_plugins: existsSync(plugins) ? evidenceIdentity(plugins) : null,
  };
}

export function fallowArguments(
  mode: string,
  base?: string,
  threads = process.env.PORTCOVE_FALLOW_THREADS ?? "2",
) {
  if (!/^\d+$/u.test(String(threads)) || Number(threads) < 1 || Number(threads) > 64)
    throw new Error("PORTCOVE_FALLOW_THREADS must be an integer from 1 to 64");
  const common = [
    "--no-production",
    "--no-package-baselines",
    "--no-type-aware",
    "--max-file-size",
    "5",
    "--threads",
    String(threads),
    "--format",
    "json",
    "--quiet",
    "--explain",
  ];
  if (mode === "desktop") return ["--root", "apps/desktop", "--fail-on-parse-error", ...common];
  if (mode === "tooling") return ["--root", ".", "--config", ".fallow-tooling.json", ...common];
  if (mode === "css")
    return ["health", "--root", "apps/desktop", "--css", "--report-only", ...common];
  if (mode === "review") {
    if (!base) throw new Error("Fallow review requires an explicit comparison base");
    return [
      "review",
      "--root",
      ".",
      "--config",
      ".fallow-tooling.json",
      "--base",
      base,
      "--gate",
      "new-only",
      ...common,
    ];
  }
  throw new Error(`Unknown Fallow scope: ${mode}`);
}

function validateAdvisory(report: unknown, mode: string) {
  const expected = mode === "css" ? ["health", 12] : ["audit-brief", 13];
  if (
    !isRecord(report) ||
    report.kind !== expected[0] ||
    report.schema_version !== expected[1] ||
    report.version !== version
  )
    throw new Error(`Unsupported ${mode} report kind, schema or tool version`);
  if (mode === "css" && (!report.summary || !Array.isArray(report.findings)))
    throw new Error("Incomplete CSS report");
  if (
    mode === "review" &&
    (typeof report.verdict !== "string" ||
      !["pass", "warn", "fail"].includes(report.verdict) ||
      !report.attribution ||
      typeof report.changed_files_count !== "number" ||
      !Number.isSafeInteger(report.changed_files_count) ||
      report.changed_files_count < 0 ||
      typeof report.base_ref !== "string" ||
      !report.base_ref)
  )
    throw new Error("Incomplete review report");
}

function reuseFallowReport(reuse: string, metadata: unknown): FallowProcessResult {
  const previous: unknown = JSON.parse(readFileSync(path.join(reuse, "metadata.json"), "utf8"));
  if (
    !isRecord(previous) ||
    previous.execution_complete !== true ||
    (previous.status !== null && typeof previous.status !== "number") ||
    typeof previous.stdout !== "string" ||
    typeof previous.stderr !== "string"
  )
    throw new Error("Fallow report reuse refused: invalid retained metadata");
  if (JSON.stringify(previous.identity) !== JSON.stringify(metadata))
    throw new Error("Fallow report reuse refused: source, scope, base or tool changed");
  const stdout = readFileSync(previous.stdout, "utf8");
  const stderr = readFileSync(previous.stderr, "utf8");
  if (
    previous.stdout_sha256 !== createHash("sha256").update(stdout).digest("hex") ||
    previous.stderr_sha256 !== createHash("sha256").update(stderr).digest("hex")
  )
    throw new Error("Fallow report reuse refused: retained bytes changed");
  return { status: previous.status, stdout, stderr };
}

export async function runFallow({
  spawn = executeFallow,
  mode = "desktop",
  base,
  reuse,
  identity = () => fallowSource(root, base),
  evidenceDirectory = path.join(root, "work/fallow-reports", `${mode}-${randomUUID()}`),
  jobSummary = process.env.GITHUB_STEP_SUMMARY,
  environment = process.env,
}: FallowOptions = {}) {
  const env = analysisEnvironment(environment);
  const args = fallowArguments(mode, base, environment.PORTCOVE_FALLOW_THREADS ?? "2");
  const source = identity();
  const inputs = effectiveEvidence(mode, env);
  const execution_limits = { analysis_ms: 1_200_000, format_ms: 60_000 };
  const metadata = { format_version: 3, mode, version, args, source, inputs, execution_limits };
  let result: FallowProcessResult;
  if (reuse) {
    result = reuseFallowReport(reuse, metadata);
  } else {
    result = await spawn(
      process.execPath,
      [cli, ...args],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env,
      },
      {
        directory: evidenceDirectory,
        phase: "analysis",
        timeoutMilliseconds: execution_limits.analysis_ms,
        identity: metadata,
      },
    );
  }
  const evidence = retainCommandEvidence(evidenceDirectory, result);
  let secondary = evidence.failure ?? result.evidenceFailure;
  try {
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(
      path.join(evidenceDirectory, "metadata.json"),
      JSON.stringify(
        {
          identity: metadata,
          status: result.status,
          execution_complete:
            !result.error &&
            !result.signal &&
            !result.evidenceFailure &&
            (result.status === 0 || result.status === 1),
          ...evidence,
          stdout_sha256: createHash("sha256")
            .update(result.stdout ?? "")
            .digest("hex"),
          stderr_sha256: createHash("sha256")
            .update(result.stderr ?? "")
            .digest("hex"),
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  } catch (error) {
    secondary ??= `metadata retention failed: ${errorCode(error) ?? "unknown"}`;
  }
  if (evidence.failure === undefined && secondary !== undefined) evidence.failure = secondary;
  const fail = (message: string, cause: unknown = result.error) =>
    commandFailure(message, result, evidenceDirectory, cause, "unknown", evidence);
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1))
    throw fail(`Fallow analyzer execution failed (exit ${result.status ?? "unknown"})`);
  let report: unknown;
  try {
    if (typeof result.stdout !== "string") throw new Error("Fallow stdout is not text");
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw fail("Fallow returned an invalid JSON report", error);
  }
  let assessment;
  try {
    if (["desktop", "tooling"].includes(mode))
      assessment = evaluateFallowReport(report, { requireParseGate: mode === "desktop" });
    else validateAdvisory(report, mode);
    if (JSON.stringify(source) !== JSON.stringify(identity()))
      throw new Error("Fallow source changed during analysis; report is stale");
    if (JSON.stringify(inputs) !== JSON.stringify(effectiveEvidence(mode, env)))
      throw new Error("Fallow external evidence changed during analysis; report is stale");
  } catch (error) {
    throw fail(`Fallow returned invalid evidence: ${errorMessage(error)}`, error);
  }
  const failures = mode === "desktop" && assessment ? assessment.failures : [];
  // Combined machine output normally exits 0 for findings. Never turn an
  // unexplained nonzero result into a passing result. Review always exits 0.
  if (result.status === 1 && !assessment?.failures.length)
    failures.push("unexplained analyzer exit 1; no passing result claimed");
  let text = summarizeFallow(
    report,
    [evidence.stdout, evidence.stderr].filter(Boolean).join("; "),
    failures.length
      ? "Fallow quality gate failed (source/check failure)"
      : `Fallow ${mode}: ${mode === "desktop" ? "gate passed" : "advisory findings, not acceptance"}`,
  );
  text += `\nSource: ${source.head}; dirty ${source.dirty}; inputs ${source.source_sha256}; base ${source.merge_base ?? "whole scope"}; Fallow ${version}\nReport directory: ${evidenceDirectory}`;
  if (failures.length) text += `\n${failures.join("\n")}`;
  if (jobSummary) {
    try {
      // Saved evidence only: native formatting performs no new analysis.
      let formatted: FallowProcessResult | null = null;
      if (mode !== "review") {
        const reportFile = evidence.stdout;
        if (!reportFile) throw new Error("native saved-report formatting unavailable");
        formatted = await spawn(
          process.execPath,
          [cli, "report", "--from", reportFile, "--format", "github-summary"],
          { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true },
          {
            directory: evidenceDirectory,
            phase: "format",
            timeoutMilliseconds: execution_limits.format_ms,
            identity: metadata,
          },
        );
      }
      if (formatted && (formatted.error || formatted.evidenceFailure || formatted.status !== 0))
        throw new Error("native saved-report formatting failed");
      appendFileSync(
        jobSummary,
        `${formatted?.stdout ?? ""}\n\n<details><summary>Portcove scope and policy</summary>\n\n\`\`\`text\n${text.replaceAll("```", "'''")}\n\`\`\`\n</details>\n`,
      );
    } catch (error) {
      secondary ??= errorMessage(error);
    }
  }
  if (secondary)
    text += `\nevidence-collection failure${failures.length ? " (secondary)" : ""}: ${secondary}`;
  return {
    exitCode: failures.length || secondary ? 1 : 0,
    text: renderBoundedSummary("Fallow result", text.split("\n")).text,
    evidenceDirectory,
  };
}

export function formatFallowFailure(error: unknown) {
  const message = errorMessage(error);
  return isRecord(error) && error.evidence && Buffer.byteLength(message) <= 16 * 1024 - 1
    ? message
    : renderBoundedSummary("Fallow failed", [message]).text;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const [mode = "desktop", base, reuse, ...extra] = process.argv.slice(2);
    if (extra.length || (mode !== "review" && base))
      throw new Error("usage: run-fallow.mts [desktop|tooling|css|review BASE [REUSE_DIRECTORY]]");
    // Each actual native phase owns admission/containment in executeFallow.
    // Source validation and unique evidence writes need no enclosing lease.
    const result = await runFallow({ mode, base, reuse });
    (result.exitCode ? console.error : console.log)(result.text);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(formatFallowFailure(error));
    process.exitCode = 1;
  }
}
