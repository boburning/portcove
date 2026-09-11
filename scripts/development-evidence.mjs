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

export function evidenceOutcome(checks) {
  if (!checks.length) return "not-run";
  for (const check of checks) {
    if (!check.scenario || !["passed", "failed", "not-run"].includes(check.outcome))
      throw new Error("Invalid evidence check");
  }
  return checks.some((check) => check.outcome === "failed")
    ? "failed"
    : checks.some((check) => check.outcome === "not-run")
      ? "incomplete"
      : "passed";
}

export async function writeEvidence(
  directory,
  { revision, executable, checks, artifacts = [], method, inputs = [], capturedExecutable },
) {
  if (!/^[a-f0-9]{40}$/u.test(revision) || !method)
    throw new Error("Evidence requires a full revision and explicit method");
  const report = {
    format_version: 1,
    captured_at: new Date().toISOString(),
    revision,
    platform: process.platform,
    architecture: process.arch,
    method,
    executable: capturedExecutable ?? (await fileIdentity(executable)),
    inputs,
    outcome: evidenceOutcome(checks),
    checks,
    artifacts: await Promise.all(artifacts.map(fileIdentity)),
    interpretation:
      "Execution observations only; no catalog qualification or human observation is inferred.",
  };
  await writeFile(path.join(directory, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  return report;
}
