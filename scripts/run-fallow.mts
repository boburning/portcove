import { errorMessage } from "./runtime-values.mts";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateFallowReport } from "./check-fallow-report.mts";
import { commandFailure, renderBoundedSummary, retainCommandEvidence } from "./report-summary.mts";
import { summarizeFallow } from "./fallow-summary.mts";
import { fallowSource } from "./fallow-source.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/fallow/bin/fallow", import.meta.url));
const version = "3.33.1";

export function fallowArguments(mode, base, threads = process.env.PORTCOVE_FALLOW_THREADS ?? "2") {
  if (!/^\d+$/u.test(String(threads)) || Number(threads) < 1 || Number(threads) > 64)
    throw new Error("PORTCOVE_FALLOW_THREADS must be an integer from 1 to 64");
  const common = ["--threads", String(threads), "--format", "json", "--quiet", "--explain"];
  if (mode === "desktop") return ["--root", "apps/desktop", ...common];
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

function validateAdvisory(report, mode) {
  const expected = mode === "css" ? ["health", 11] : ["audit-brief", 12];
  if (
    !report ||
    report.kind !== expected[0] ||
    report.schema_version !== expected[1] ||
    report.version !== version
  )
    throw new Error(`Unsupported ${mode} report kind, schema or tool version`);
  if (mode === "css" && (!report.summary || !Array.isArray(report.findings)))
    throw new Error("Incomplete CSS report");
  if (
    mode === "review" &&
    (!["pass", "warn", "fail"].includes(report.verdict) ||
      !report.attribution ||
      !Number.isSafeInteger(report.changed_files_count) ||
      report.changed_files_count < 0 ||
      !report.base_ref)
  )
    throw new Error("Incomplete review report");
}

export function runFallow({
  spawn = spawnSync,
  mode = "desktop",
  base,
  reuse,
  identity = () => fallowSource(root, base),
  evidenceDirectory = path.join(root, "work/fallow-reports", `${mode}-${randomUUID()}`),
  jobSummary = process.env.GITHUB_STEP_SUMMARY,
} = {}) {
  const args = fallowArguments(mode, base);
  const source = identity();
  const metadata = { format_version: 1, mode, version, args, source };
  let result;
  if (reuse) {
    const previous = JSON.parse(readFileSync(path.join(reuse, "metadata.json"), "utf8"));
    if (JSON.stringify(previous.identity) !== JSON.stringify(metadata))
      throw new Error("Fallow report reuse refused: source, scope, base or tool changed");
    result = {
      status: previous.status,
      stdout: readFileSync(previous.stdout, "utf8"),
      stderr: readFileSync(previous.stderr, "utf8"),
    };
    if (
      previous.stdout_sha256 !== createHash("sha256").update(result.stdout).digest("hex") ||
      previous.stderr_sha256 !== createHash("sha256").update(result.stderr).digest("hex")
    )
      throw new Error("Fallow report reuse refused: retained bytes changed");
  } else {
    result = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, FALLOW_AGENT_SOURCE: "codex" },
    });
  }
  const evidence = retainCommandEvidence(evidenceDirectory, result);
  let secondary = evidence.failure;
  try {
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(
      path.join(evidenceDirectory, "metadata.json"),
      JSON.stringify(
        {
          identity: metadata,
          status: result.status,
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
    secondary ??= `metadata retention failed: ${error.code ?? "unknown"}`;
  }
  evidence.failure ??= secondary;
  const fail = (message, cause) =>
    commandFailure(message, result, evidenceDirectory, cause, "unknown", evidence);
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw fail(`Fallow analyzer execution failed (exit ${result.status ?? "unknown"})`);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw fail("Fallow returned an invalid JSON report", error);
  }
  let assessment;
  try {
    if (["desktop", "tooling"].includes(mode)) assessment = evaluateFallowReport(report);
    else validateAdvisory(report, mode);
    if (JSON.stringify(source) !== JSON.stringify(identity()))
      throw new Error("Fallow source changed during analysis; report is stale");
  } catch (error) {
    throw fail(`Fallow returned invalid evidence: ${errorMessage(error)}`, error);
  }
  const failures = mode === "desktop" ? assessment.failures : [];
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
      const formatted =
        mode === "review"
          ? null
          : spawn(
              process.execPath,
              [cli, "report", "--from", evidence.stdout, "--format", "github-summary"],
              { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true },
            );
      if (formatted && (formatted.error || formatted.status !== 0))
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

export function formatFallowFailure(error) {
  return error.evidence && Buffer.byteLength(error.message) <= 16 * 1024 - 1
    ? error.message
    : renderBoundedSummary("Fallow failed", [String(error.message)]).text;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const [mode = "desktop", base, reuse, ...extra] = process.argv.slice(2);
    if (extra.length || (mode !== "review" && base))
      throw new Error("usage: run-fallow.mts [desktop|tooling|css|review BASE [REUSE_DIRECTORY]]");
    const result = runFallow({ mode, base, reuse });
    (result.exitCode ? console.error : console.log)(result.text);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(formatFallowFailure(error));
    process.exitCode = 1;
  }
}
