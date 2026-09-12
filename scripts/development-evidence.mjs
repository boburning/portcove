import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function fileIdentity(file) {
  const absolute = path.resolve(file);
  const stats = await lstat(absolute);
  if (!stats.isFile() || stats.isSymbolicLink())
    throw new Error(`Evidence requires an ordinary file: ${absolute}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolute)) hash.update(chunk);
  return { path: absolute, bytes: stats.size, sha256: hash.digest("hex") };
}

export function evidenceOutcome(checks, setupChecks = []) {
  const observed = [...setupChecks, ...checks];
  if (!observed.length) return "not-run";
  for (const check of observed) {
    if (!check.scenario || !["passed", "failed", "not-run"].includes(check.outcome))
      throw new Error("Invalid evidence check");
  }
  return observed.some((check) => check.outcome === "failed")
    ? "failed"
    : observed.some((check) => check.outcome === "not-run")
      ? "incomplete"
      : "passed";
}

export async function writeEvidence(
  directory,
  {
    revision,
    executable,
    checks,
    setupChecks = [],
    artifacts = [],
    method,
    inputs = [],
    capturedExecutable,
    context = {},
  },
) {
  if (!/^[a-f0-9]{40}$/u.test(revision) || !method)
    throw new Error("Evidence requires a full revision and explicit method");
  const outcome = evidenceOutcome(checks, setupChecks);
  const selectedScenarios = context.selected_scenarios ?? checks.map((check) => check.scenario);
  const report = {
    format_version: 2,
    captured_at: new Date().toISOString(),
    revision,
    platform: process.platform,
    architecture: process.arch,
    method,
    executable: capturedExecutable ?? (await fileIdentity(executable)),
    inputs,
    outcome,
    checks,
    setup_checks: setupChecks,
    profile: context.profile ?? null,
    selected_scenarios: selectedScenarios,
    setup_scenarios: context.setup_scenarios ?? [],
    excluded_scenarios: context.excluded_scenarios ?? [],
    restart_cycles: context.restart_cycles ?? null,
    reload_cycles: context.reload_cycles ?? null,
    harness_deadline_ms: context.harness_deadline_ms ?? null,
    source_state: context.source_state ?? { revision, clean: null },
    phases: context.phases ?? [],
    known_gaps: context.known_gaps ?? [],
    qualification_complete:
      outcome === "passed" && !(context.known_gaps?.length > 0) && selectedScenarios.length > 0,
    artifacts: await Promise.all(artifacts.map(fileIdentity)),
    interpretation:
      "Execution observations only; no catalog qualification or human observation is inferred.",
  };
  await writeFile(path.join(directory, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  return report;
}
