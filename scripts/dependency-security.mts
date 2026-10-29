import { isRecord, errorMessage } from "./runtime-values.mts";
// Development regression policy. This module has no release-approval dependency.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (text: string | Uint8Array) =>
  createHash("sha256")
    .update(typeof text === "string" ? text.replaceAll("\r\n", "\n") : text)
    .digest("hex");
const canonicalText = (value: string) => value.replaceAll("\r\n", "\n");
function scanCommand(name: string, args: string[], cwd: string) {
  const result = execFileSync(name, args, {
    cwd,
    encoding: "utf8",
    timeout: coordinatorCommandTimeout(120_000),
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  }).trim();
  checkCoordinatorDeadline();
  return result;
}

const groups = ["advisories", "bans", "licenses", "sources"] as const;

export function scanDependencies(
  cwd = root,
  filename = process.env.PORTCOVE_706_SCAN_RECEIPT,
  observeRetained?: (raw: unknown) => void,
) {
  const output = filename ?? path.join(cwd, "work", "linux-beta-risk-706", `${randomUUID()}.json`);
  mkdirSync(path.dirname(output), { recursive: true });
  const head = scanCommand("git", ["rev-parse", "HEAD"], cwd);
  const lockSha256 = hash(readFileSync(path.join(cwd, "Cargo.lock")));
  const policy = readFileSync(path.join(cwd, "deny.toml"), "utf8");
  const strictPolicy = canonicalText(policy);
  const policyPath = path.join(cwd, "deny.toml");
  const toolVersion = scanCommand("cargo", ["deny", "--version"], cwd);
  const run = spawnSync(
    "cargo",
    [
      "deny",
      "--format",
      "json",
      "--config",
      policyPath,
      "check",
      "--hide-inclusion-graph",
      "-W",
      "unmaintained",
    ],
    {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: coordinatorCommandTimeout(120_000),
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const scan = {
    head,
    lockSha256,
    scope: "workspace-default-all-targets-all-checks",
    unsoundAll: /^\[advisories\]\r?\n(?:(?!^\[)[\s\S])*?^unsound\s*=\s*"all"\s*$/mu.test(
      strictPolicy,
    ),
    configSha256: hash(strictPolicy),
    sourceConfigSha256: hash(canonicalText(policy)),
    sourceConfig: policy,
    executionConfig: strictPolicy,
    toolVersion,
    completedAt: new Date().toISOString(),
    exitCode: run.status,
    signal: run.signal,
    error: run.error ? String(run.error.message) : null,
    complete: !run.error && run.signal === null && (run.status === 0 || run.status === 1),
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
  };
  // Raw streams and status are retained before a separate decision is attempted.
  writeFileSync(output, `${JSON.stringify(scan, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(scan.stdout);
  process.stderr.write(scan.stderr);
  console.log(`[dependency-policy] original cargo-deny exit ${scan.exitCode}; evidence ${output}`);
  observeRetained?.(scan);
  checkCoordinatorDeadline();
  if (
    scanCommand("git", ["rev-parse", "HEAD"], cwd) !== head ||
    hash(readFileSync(path.join(cwd, "Cargo.lock"))) !== lockSha256 ||
    canonicalText(readFileSync(policyPath, "utf8")) !== strictPolicy ||
    scanCommand("cargo", ["deny", "--version"], cwd) !== toolVersion
  )
    throw new Error(
      "scanner source/lock/policy/tool changed during execution; retain original raw scan",
    );
  return { scan, output };
}

type Diagnostic = Record<string, unknown> & { severity: "error" | "warning" | "note" | "help" };
type SummaryCounts = { errors: number; warnings: number; notes: number; helps: number };
type DependencySummary = Record<"advisories" | "bans" | "licenses" | "sources", SummaryCounts>;
function assertSummary(value: unknown): asserts value is DependencySummary {
  if (!isRecord(value) || Object.keys(value).sort().join() !== groups.toSorted().join())
    throw new Error("incomplete cargo-deny check coverage");
  for (const group of groups) {
    const counts = value[group];
    if (!isRecord(counts)) throw new Error("incomplete cargo-deny summary");
    for (const key of ["errors", "warnings", "notes", "helps"]) {
      if (typeof counts[key] !== "number" || !Number.isSafeInteger(counts[key]) || counts[key] < 0)
        throw new Error("incomplete cargo-deny summary");
    }
  }
}
export function parseDependencyScan(stdout: string, stderr: string) {
  const diagnostics: Diagnostic[] = [];
  let summary: unknown;
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/u).filter((line) => line.trim())) {
    const entry: unknown = JSON.parse(line);
    if (!isRecord(entry)) throw new Error("unexpected or duplicate cargo-deny output");
    if (entry.type === "diagnostic") {
      const fields = entry.fields;
      if (
        !isRecord(fields) ||
        (fields.severity !== "error" &&
          fields.severity !== "warning" &&
          fields.severity !== "note" &&
          fields.severity !== "help")
      )
        throw new Error("unknown cargo-deny diagnostic severity");
      diagnostics.push({ ...fields, severity: fields.severity });
    } else if (entry.type === "summary" && !summary) summary = entry.fields;
    else throw new Error("unexpected or duplicate cargo-deny output");
  }
  assertSummary(summary);
  for (const [severity, key] of [
    ["error", "errors"],
    ["warning", "warnings"],
    ["note", "notes"],
    ["help", "helps"],
  ] as const) {
    // cargo-deny hides license helps/source notes at default verbosity.
    if (
      ["error", "warning"].includes(severity) &&
      diagnostics.filter((d) => d.severity === severity).length !==
        groups.reduce((n, group) => n + summary[group][key], 0)
    )
      throw new Error("cargo-deny diagnostic/summary mismatch");
  }
  return { errors: diagnostics.filter((d) => d.severity === "error"), summary, diagnostics };
}

export function knownFinding706(finding: unknown): boolean {
  if (!isRecord(finding)) return false;
  return (
    finding?.severity === "error" &&
    finding.code === "unsound" &&
    isRecord(finding.advisory) &&
    finding.advisory.id === "RUSTSEC-2024-0429" &&
    finding.advisory.package === "glib" &&
    Array.isArray(finding.labels) &&
    finding.labels.some(
      (label: unknown) =>
        isRecord(label) &&
        label.span === "glib 0.18.5 registry+https://github.com/rust-lang/crates.io-index",
    )
  );
}

export function developmentSecurity(scan: unknown, policy: string) {
  if (
    !isRecord(scan) ||
    !scan.complete ||
    typeof scan.head !== "string" ||
    typeof scan.stdout !== "string" ||
    typeof scan.stderr !== "string" ||
    typeof scan.executionConfig !== "string" ||
    typeof scan.sourceConfig !== "string" ||
    scan.signal !== null ||
    scan.error !== null ||
    (scan.exitCode !== 0 && scan.exitCode !== 1) ||
    scan.unsoundAll !== true ||
    scan.scope !== "workspace-default-all-targets-all-checks" ||
    scan.toolVersion !== "cargo-deny 0.20.2" ||
    scan.configSha256 !== hash(policy) ||
    scan.sourceConfigSha256 !== hash(policy) ||
    hash(scan.executionConfig ?? "") !== hash(policy) ||
    hash(scan.sourceConfig ?? "") !== hash(policy) ||
    !/^\[advisories\]\n(?:(?!^\[)[\s\S])*?^unsound\s*=\s*"all"\s*$/mu.test(
      policy.replaceAll("\r\n", "\n"),
    )
  )
    throw new Error("incomplete or changed dependency-policy execution");
  const { errors, summary } = parseDependencyScan(scan.stdout, scan.stderr);
  if ((scan.exitCode === 0) !== (errors.length === 0))
    throw new Error("scan exit/diagnostics mismatch");
  const known = errors.filter(knownFinding706);
  if (errors.length !== known.length || known.length > 1)
    throw new Error("development security policy failed: new or changed blocking finding");
  return {
    disposition: "development-baseline",
    purpose: "development",
    candidate: scan.head,
    scanPassed: scan.exitCode === 0,
    scanExitCode: scan.exitCode,
    policyPassed: true,
    knownFinding: known.length ? "RUSTSEC-2024-0429" : null,
    remediation: "https://github.com/boburning/portcove/issues/706",
    releaseAuthorization: "not-evaluated",
    summary,
  };
}

// Diagnostic recognition only: never turns a raw failed audit into reusable scanner evidence.
export function recordsDevelopmentPolicy(payload: unknown, source: string): boolean {
  if (!isRecord(payload)) return false;
  const decision = isRecord(payload.policyDecision) ? payload.policyDecision : undefined;
  return (
    payload?.success === false &&
    payload.originalExitCode === 1 &&
    decision?.disposition === "development-baseline" &&
    decision.purpose === "development" &&
    decision.policyPassed === true &&
    decision.candidate === source &&
    decision.scanPassed === false &&
    decision.scanExitCode === 1 &&
    decision.knownFinding === "RUSTSEC-2024-0429" &&
    decision.releaseAuthorization === "not-evaluated" &&
    Array.isArray(payload.stages) &&
    payload.stages.filter((s: unknown) => isRecord(s) && s.status === "failed").length === 1 &&
    payload.stages.every(
      (s: unknown) =>
        isRecord(s) &&
        (s.status === "passed" ||
          (s.id === "dependency-policy" && s.status === "failed" && s.exitCode === 1)),
    )
  );
}

export function describeDevelopmentSecurity(
  decision: Pick<ReturnType<typeof developmentSecurity>, "scanPassed">,
) {
  return `Development security policy: PASS; dependency scanner: ${decision.scanPassed ? "PASS" : "FAIL — existing RUSTSEC-2024-0429; remediation #706 outstanding"}; Linux release authorization: not evaluated.`;
}

async function settleDirectCli() {
  if (
    /^dependency-security(?:[.]mts|(?:[.]bundle)?[.]mjs)$/u.test(
      path.basename(process.argv[1] ?? ""),
    ) &&
    path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
  ) {
    try {
      if (process.argv[2] === "maintenance") {
        const mode = process.argv[3];
        if (process.argv.length !== 4 || !mode)
          throw new Error("usage: dependency-security.mts maintenance classify|check");
        const { runMaintenancePolicy } = await import("./lock-maintenance-policy.mts");
        await runMaintenancePolicy(mode);
      } else if (process.argv[2] === "--help") {
        console.log(
          "usage: dependency-security.mts [scan] — development policy by default; scan returns raw scanner status",
        );
      } else {
        if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "scan"))
          throw new Error("usage: dependency-security.mts [scan]");
        const { scan, output } = scanDependencies(root);
        if (process.argv[2] === "scan") {
          process.exitCode = scan.exitCode ?? 1;
        } else {
          const decision = developmentSecurity(
            scan,
            readFileSync(path.join(root, "deny.toml"), "utf8"),
          );
          writeFileSync(`${output}.decision.json`, `${JSON.stringify(decision, null, 2)}\n`, {
            flag: "wx",
          });
          console.log(describeDevelopmentSecurity(decision));
          if (process.env.GITHUB_STEP_SUMMARY) {
            const { appendFileSync } = await import("node:fs");
            appendFileSync(
              process.env.GITHUB_STEP_SUMMARY,
              `${describeDevelopmentSecurity(decision)}\n`,
            );
          }
        }
      }
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  }
}
void settleDirectCli().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
