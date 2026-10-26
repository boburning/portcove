import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}
export interface EvidenceCheck {
  scenario: string;
  outcome: "passed" | "failed" | "not-run";
  message?: string;
  reason?: string | undefined;
  duration_ms?: number | null;
  duration_scope?: "scenario-action";
}
export interface EvidenceContext {
  selected_scenarios?: readonly string[];
  setup_scenarios?: readonly string[];
  excluded_scenarios?: readonly string[];
  profile?: string | null;
  restart_cycles?: number;
  reload_cycles?: number;
  harness_deadline_ms?: number;
  source_state?: { revision: string; clean: boolean | null };
  known_gaps?: readonly { scenario: string; reason?: string | undefined }[];
  // These payloads have their own validation owners. This serializer retains
  // them without interpreting them as execution or acceptance authority.
  execution_binding?: object | null;
  acceptance_preflight?: FileIdentity;
  phases?: readonly object[];
}
export interface EvidenceOptions {
  revision: string;
  executable: string;
  checks: readonly EvidenceCheck[];
  setupChecks?: readonly EvidenceCheck[];
  artifacts?: readonly string[];
  method: string;
  inputs?: readonly FileIdentity[];
  capturedExecutable?: FileIdentity;
  context?: EvidenceContext;
}

export const EVIDENCE_READ_CHUNK_BYTES = 1024 * 1024;

export async function fileIdentity(
  file: string,
  { maxBytes = Infinity, signal }: { maxBytes?: number; signal?: AbortSignal | undefined } = {},
): Promise<FileIdentity> {
  const absolute = path.resolve(file);
  const stats = await lstat(absolute);
  if (!stats.isFile() || stats.isSymbolicLink())
    throw new Error(`Evidence requires an ordinary file: ${absolute}`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const rawChunk of createReadStream(absolute, {
    signal,
    highWaterMark: EVIDENCE_READ_CHUNK_BYTES,
  })) {
    const chunk: unknown = rawChunk;
    if (!(chunk instanceof Uint8Array)) throw new Error("Evidence stream yielded non-byte data");
    bytes += chunk.byteLength;
    if (bytes > maxBytes || bytes > stats.size)
      throw new Error("Evidence input grew while being observed");
    hash.update(chunk);
  }
  if (bytes !== stats.size) throw new Error("Evidence input size changed while being observed");
  return { path: absolute, bytes, sha256: hash.digest("hex") };
}

export function evidenceOutcome(
  checks: readonly EvidenceCheck[],
  setupChecks: readonly EvidenceCheck[] = [],
) {
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
  directory: string,
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
  }: EvidenceOptions,
) {
  if (!/^[a-f0-9]{40}$/u.test(revision) || !method)
    throw new Error("Evidence requires a full revision and explicit method");
  const outcome = evidenceOutcome(checks, setupChecks);
  const selectedScenarios = context.selected_scenarios ?? checks.map((check) => check.scenario);
  const report = {
    format_version: context.execution_binding ? 3 : 2,
    captured_at: new Date().toISOString(),
    revision,
    platform: process.platform,
    architecture: process.arch,
    method,
    executable: capturedExecutable ?? (await fileIdentity(executable)),
    inputs,
    ...(context.execution_binding ? { execution_binding: context.execution_binding } : {}),
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
    ...(context.acceptance_preflight ? { acceptance_preflight: context.acceptance_preflight } : {}),
    phases: context.phases ?? [],
    known_gaps: context.known_gaps ?? [],
    qualification_complete:
      outcome === "passed" &&
      !(context.known_gaps && context.known_gaps.length > 0) &&
      selectedScenarios.length > 0,
    artifacts: await Promise.all(artifacts.map((file) => fileIdentity(file))),
    interpretation:
      "Execution observations only; no catalog qualification or human observation is inferred.",
  };
  await writeFile(path.join(directory, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  return report;
}
