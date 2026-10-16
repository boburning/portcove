// Development regression policy. This module has no release-approval dependency.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (text) =>
  createHash("sha256")
    .update(typeof text === "string" ? text.replaceAll("\r\n", "\n") : text)
    .digest("hex");
const canonicalText = (value) => value.replaceAll("\r\n", "\n");
function scanCommand(name, args, cwd) {
  return execFileSync(name, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  }).trim();
}

const groups = ["advisories", "bans", "licenses", "sources"];

export function scanDependencies(cwd = root, filename = process.env.PORTCOVE_706_SCAN_RECEIPT) {
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
      timeout: 120_000,
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
    complete: !run.error && run.signal === null && [0, 1].includes(run.status),
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
  };
  // Raw streams and status are retained before a separate decision is attempted.
  writeFileSync(output, `${JSON.stringify(scan, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(scan.stdout);
  process.stderr.write(scan.stderr);
  console.log(`[dependency-policy] original cargo-deny exit ${scan.exitCode}; evidence ${output}`);
  return { scan, output };
}

export function parseDependencyScan(stdout, stderr) {
  const diagnostics = [];
  let summary;
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/u).filter((line) => line.trim())) {
    const entry = JSON.parse(line);
    if (entry.type === "diagnostic") {
      if (!["error", "warning", "note", "help"].includes(entry.fields?.severity))
        throw new Error("unknown cargo-deny diagnostic severity");
      diagnostics.push(entry.fields);
    } else if (entry.type === "summary" && !summary) summary = entry.fields;
    else throw new Error("unexpected or duplicate cargo-deny output");
  }
  if (!summary || Object.keys(summary).sort().join() !== groups.toSorted().join())
    throw new Error("incomplete cargo-deny check coverage");
  for (const [severity, key] of [
    ["error", "errors"],
    ["warning", "warnings"],
    ["note", "notes"],
    ["help", "helps"],
  ]) {
    for (const group of groups)
      if (!Number.isSafeInteger(summary[group]?.[key]) || summary[group][key] < 0)
        throw new Error("incomplete cargo-deny summary");
    // cargo-deny hides license helps/source notes at its default verbosity. Errors and warnings are emitted.
    if (
      ["error", "warning"].includes(severity) &&
      diagnostics.filter((d) => d.severity === severity).length !==
        groups.reduce((n, group) => n + summary[group][key], 0)
    )
      throw new Error("cargo-deny diagnostic/summary mismatch");
  }
  return { errors: diagnostics.filter((d) => d.severity === "error"), summary, diagnostics };
}

export function knownFinding706(finding) {
  return (
    finding?.severity === "error" &&
    finding.code === "unsound" &&
    finding.advisory?.id === "RUSTSEC-2024-0429" &&
    finding.advisory.package === "glib" &&
    finding.labels?.some(
      (label) => label.span === "glib 0.18.5 registry+https://github.com/rust-lang/crates.io-index",
    )
  );
}

export function developmentSecurity(scan, policy) {
  if (
    !scan?.complete ||
    scan.signal !== null ||
    scan.error !== null ||
    ![0, 1].includes(scan.exitCode) ||
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
export function recordsDevelopmentPolicy(payload, source) {
  const decision = payload?.policyDecision;
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
    payload.stages.filter((s) => s?.status === "failed").length === 1 &&
    payload.stages.every(
      (s) =>
        s?.status === "passed" ||
        (s?.id === "dependency-policy" && s.status === "failed" && s.exitCode === 1),
    )
  );
}

export function describeDevelopmentSecurity(decision) {
  return `Development security policy: PASS; dependency scanner: ${decision.scanPassed ? "PASS" : "FAIL — existing RUSTSEC-2024-0429; remediation #706 outstanding"}; Linux release authorization: not evaluated.`;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--help") {
      console.log(
        "usage: dependency-security.mjs [scan] — development policy by default; scan returns raw scanner status",
      );
    } else {
      if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "scan"))
        throw new Error("usage: dependency-security.mjs [scan]");
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
    console.error(error.message);
    process.exitCode = 1;
  }
}
