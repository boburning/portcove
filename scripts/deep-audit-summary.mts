import { isRecord } from "./runtime-values.mts";
import { readFileSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AUDIT_STAGES, receiptEnvelope } from "./audit.mts";
import { recordsDevelopmentPolicy } from "./dependency-security.mts";

const sha = /^[a-f0-9]{40}$/;
const number = /^(?:0|[1-9][0-9]{0,12})$/;
const outcomes = new Set(["success", "failure", "cancelled", "skipped"]);
const stages = AUDIT_STAGES.filter(
  (stage) => !stage.platforms || stage.platforms.includes("linux"),
);

// Only fixed labels, validated identities and numeric/enum fields reach public output.
interface AuditSummaryIdentity {
  source: string;
  workflowSha: string;
  workflowDigest: string;
  workflowRef: string;
  run: string;
  attempt: string;
  outcome: string;
  exitCode?: string | undefined;
}
function isIdentity(value: unknown): value is AuditSummaryIdentity {
  return (
    isRecord(value) &&
    ["source", "workflowSha", "workflowDigest", "workflowRef", "run", "attempt", "outcome"].every(
      (key) => typeof value[key] === "string",
    ) &&
    (value.exitCode === undefined || typeof value.exitCode === "string")
  );
}
type SummaryStage = { id: string; recipe: string; originatingHead: string; durationMs: number } & (
  | { status: "passed"; exitCode?: unknown }
  | { status: "failed"; exitCode: number | null }
);
function isSummaryStage(stage: unknown): stage is SummaryStage {
  return (
    isRecord(stage) &&
    typeof stage.id === "string" &&
    typeof stage.recipe === "string" &&
    typeof stage.originatingHead === "string" &&
    (stage.status === "passed" || stage.status === "failed") &&
    typeof stage.durationMs === "number" &&
    Number.isSafeInteger(stage.durationMs) &&
    stage.durationMs >= 0 &&
    (stage.status !== "failed" ||
      stage.exitCode === null ||
      (typeof stage.exitCode === "number" &&
        Number.isInteger(stage.exitCode) &&
        stage.exitCode >= 0 &&
        stage.exitCode <= 255))
  );
}
export function renderDeepAuditSummary(receipt: unknown, identity: unknown, binding?: unknown) {
  if (
    !isIdentity(identity) ||
    !sha.test(identity.source) ||
    !sha.test(identity.workflowSha) ||
    !/^[a-f0-9]{64}$/.test(identity.workflowDigest) ||
    !number.test(identity.run) ||
    identity.run === "0" ||
    !number.test(identity.attempt) ||
    identity.attempt === "0" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/.github\/workflows\/deep-quality.yml@refs\/[A-Za-z0-9_./-]+$/.test(
      identity.workflowRef,
    ) ||
    !outcomes.has(identity.outcome)
  )
    return "## Deep audit evidence\n\nIdentity unavailable or invalid; no audit result claimed.\n";
  const payload = isRecord(receipt) && isRecord(receipt.payload) ? receipt.payload : undefined;
  const accepted = recordsDevelopmentPolicy(payload, identity.source);
  const lines = [
    "## Deep audit evidence",
    "",
    `Source: ${identity.source}`,
    `Workflow: ${identity.workflowRef}`,
    `Workflow source: ${identity.workflowSha}`,
    `Workflow bytes SHA-256: ${identity.workflowDigest}`,
    `Run: ${identity.run}; attempt: ${identity.attempt}`,
    `${accepted ? "Development security policy operation" : "Audit step"} outcome: ${identity.outcome}`,
  ];
  const exitValid =
    typeof identity.exitCode === "string" &&
    number.test(identity.exitCode) &&
    Number(identity.exitCode) <= 255;
  lines.push(
    `Recorded ${accepted ? "policy operation" : "audit"} exit status: ${exitValid ? identity.exitCode : "unavailable"}`,
  );
  const checkedStages =
    payload && Array.isArray(payload.stages) ? payload.stages.filter(isSummaryStage) : [];
  const valid =
    payload &&
    isRecord(receipt) &&
    receipt.integrity === receiptEnvelope(payload).integrity &&
    payload.format === 1 &&
    payload.kind === "audit-run" &&
    payload.profile === "complete" &&
    payload.head === identity.source &&
    typeof payload.success === "boolean" &&
    isRecord(binding) &&
    (["source", "workflowSha", "workflowRef", "workflowDigest", "run", "attempt"] as const).every(
      (key) => binding[key] === identity[key],
    ) &&
    binding.exitCode === identity.exitCode &&
    binding.receiptIntegrity === receipt.integrity &&
    typeof binding.startedMs === "number" &&
    typeof binding.completedMs === "number" &&
    Number.isSafeInteger(binding.startedMs) &&
    Number.isSafeInteger(binding.completedMs) &&
    binding.startedMs > 0 &&
    binding.completedMs >= binding.startedMs &&
    binding.completedMs <= Date.now() &&
    typeof payload.completedAt === "string" &&
    Number.isFinite(Date.parse(payload.completedAt)) &&
    Date.parse(payload.completedAt) >= binding.startedMs &&
    Date.parse(payload.completedAt) <= binding.completedMs &&
    Array.isArray(payload.stages) &&
    payload.stages.every(isSummaryStage) &&
    payload.stages.length === stages.length &&
    stages.every((expected, index) => {
      const stage = checkedStages[index];
      return (
        stage?.id === expected.id &&
        stage.recipe === expected.recipe &&
        stage.originatingHead === identity.source &&
        ["passed", "failed"].includes(stage.status) &&
        Number.isSafeInteger(stage.durationMs) &&
        stage.durationMs >= 0 &&
        (stage.status !== "failed" ||
          stage.exitCode === null ||
          (typeof stage.exitCode === "number" &&
            Number.isInteger(stage.exitCode) &&
            stage.exitCode >= 0 &&
            stage.exitCode <= 255))
      );
    }) &&
    payload.success === checkedStages.every((stage) => stage.status === "passed") &&
    exitValid &&
    ((payload.success && identity.exitCode === "0" && identity.outcome === "success") ||
      (!payload.success && identity.exitCode !== "0" && identity.outcome === "failure") ||
      (accepted && identity.exitCode === "0" && identity.outcome === "success"));
  if (!valid)
    lines.push(
      "",
      "Complete matching receipt unavailable or invalid. Stage coverage and audit success are not established; setup failure or interruption may leave no final receipt.",
    );
  else {
    lines.push(
      "",
      `Complete fresh audit receipt: ${payload.success ? "passed" : "failed"}`,
      ...(accepted
        ? [
            "Original audit exit status: 1; development security policy PASS: existing RUSTSEC-2024-0429 remains unresolved in #706. Linux release authorization not evaluated.",
          ]
        : []),
      "",
      "| Stage | Result | Duration (ms) | Exit status |",
      "| --- | --- | ---: | --- | ",
    );
    checkedStages.forEach((stage) =>
      lines.push(
        `| ${stage.id} | ${stage.status} | ${stage.durationMs} | ${stage.status === "passed" ? "0" : (stage.exitCode ?? "unavailable")} |`,
      ),
    );
  }
  lines.push(
    "",
    "Structured execution evidence only; raw diagnostics are not copied. This summary does not replace required CI or acceptance. Forced runner termination can prevent summary publication.",
  );
  return `${lines.join("\n")}\n`;
}

function readJson(file: string): unknown {
  try {
    const text = readFileSync(file, "utf8");
    return Buffer.byteLength(text) <= 1024 * 1024 ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const identity = {
    source: process.env.GITHUB_SHA,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    outcome: process.env.AUDIT_OUTCOME,
    exitCode: process.env.AUDIT_EXIT_CODE,
    workflowDigest: createHash("sha256")
      .update(readFileSync(".github/workflows/deep-quality.yml"))
      .digest("hex"),
  };
  if (
    !identity.source ||
    !identity.run ||
    !identity.attempt ||
    !sha.test(identity.source) ||
    !number.test(identity.run) ||
    !number.test(identity.attempt)
  )
    throw new Error("Invalid audit invocation identity");
  const receiptFile = `work/validation-receipts/audits/${identity.source}.json`;
  const bindingFile = `${process.env.RUNNER_TEMP}/deep-audit-${identity.run}-${identity.attempt}.json`;
  if (process.argv[2] === "--start") {
    rmSync(receiptFile, { force: true });
    writeFileSync(bindingFile, JSON.stringify({ ...identity, startedMs: Date.now() }));
  } else if (process.argv[2] === "--finish") {
    const marker = readJson(bindingFile);
    const receipt = readJson(receiptFile);
    writeFileSync(
      bindingFile,
      JSON.stringify({
        ...(isRecord(marker) ? marker : {}),
        completedMs: Date.now(),
        exitCode: process.argv[3],
        receiptIntegrity: isRecord(receipt) ? receipt.integrity : undefined,
      }),
    );
  } else {
    if (!process.env.GITHUB_STEP_SUMMARY) throw new Error("Missing GITHUB_STEP_SUMMARY");
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      renderDeepAuditSummary(readJson(receiptFile), identity, readJson(bindingFile)),
    );
  }
}
