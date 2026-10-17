import { errorMessage, isRecord } from "./runtime-values.mts";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { AUDIT_STAGES, hostedAuditIdentity, receiptEnvelope, validateReceipt } from "./audit.mts";
import { recordsDevelopmentPolicy } from "./dependency-security.mts";

export const AUDIT_BUNDLE_LIMITS = Object.freeze({
  files: 64,
  expandedBytes: 32 * 1024 * 1024,
  compressedBytes: 8 * 1024 * 1024,
});
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const positive = /^[1-9][0-9]{0,12}$/;
const keys = ["source", "workflowSha", "workflowRef", "workflowDigest", "run", "attempt"] as const;
function requireValid(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Audit bundle rejected: ${reason}`);
}
interface AuditEnvelope {
  payload: Record<string, unknown>;
  integrity: string;
}
function intact(value: unknown): value is AuditEnvelope {
  return (
    isRecord(value) &&
    isRecord(value.payload) &&
    typeof value.integrity === "string" &&
    value.integrity === receiptEnvelope(value.payload).integrity
  );
}
function within(time: unknown, binding: { startedMs: number; completedMs: number }) {
  const ms = typeof time === "string" ? Date.parse(time) : NaN;
  return Number.isFinite(ms) && ms >= binding.startedMs && ms <= binding.completedMs;
}

export type AuditProducerIdentity = {
  [Key in keyof ReturnType<typeof hostedAuditIdentity>]: string;
};
function assertProducerIdentity(identity: unknown): asserts identity is AuditProducerIdentity {
  requireValid(
    isRecord(identity) &&
      identity.repository === "boburning/portcove" &&
      typeof identity.source === "string" &&
      sha.test(identity.source) &&
      typeof identity.workflowSha === "string" &&
      sha.test(identity.workflowSha) &&
      typeof identity.workflowDigest === "string" &&
      digest.test(identity.workflowDigest) &&
      typeof identity.run === "string" &&
      positive.test(identity.run) &&
      typeof identity.attempt === "string" &&
      positive.test(identity.attempt) &&
      typeof identity.workflowRef === "string" &&
      /^boburning\/portcove\/\.github\/workflows\/deep-quality.yml@refs\/heads\/[A-Za-z0-9_./-]+$/.test(
        identity.workflowRef,
      ),
    "producer identity",
  );
}

export interface AuditBundleInputs {
  identity: unknown;
  binding: unknown;
  capture: unknown;
  aggregate: unknown;
  receipts: Readonly<Record<string, unknown>>;
}
export function buildAuditBundle({
  identity,
  binding,
  capture,
  aggregate,
  receipts,
}: AuditBundleInputs) {
  assertProducerIdentity(identity);
  requireValid(
    isRecord(binding) &&
      keys.every((k) => binding[k] === identity[k]) &&
      typeof binding.startedMs === "number" &&
      typeof binding.completedMs === "number" &&
      Number.isSafeInteger(binding.startedMs) &&
      Number.isSafeInteger(binding.completedMs) &&
      binding.startedMs > 0 &&
      binding.completedMs >= binding.startedMs &&
      binding.completedMs <= Date.now(),
    "attempt binding",
  );
  requireValid(intact(capture), "original input capture");
  const input = capture.payload;
  const executionWindow = { startedMs: binding.startedMs, completedMs: binding.completedMs };
  const inputIdentity = input.identity;
  requireValid(
    input.format === 1 &&
      input.kind === "audit-inputs" &&
      input.head === identity.source &&
      input.profile === "complete" &&
      isRecord(inputIdentity) &&
      keys.every((k) => inputIdentity[k] === identity[k]) &&
      inputIdentity.repository === identity.repository &&
      within(input.capturedAt, executionWindow),
    "original input capture",
  );
  requireValid(intact(aggregate), "complete execution report");
  const result = aggregate.payload;
  const expected = AUDIT_STAGES.filter((s) => !s.platforms || s.platforms.includes("linux"));
  requireValid(
    result.format === 1 &&
      result.kind === "audit-run" &&
      result.profile === "complete" &&
      result.head === identity.source &&
      within(result.completedAt, executionWindow) &&
      binding.receiptIntegrity === aggregate.integrity &&
      Array.isArray(result.stages) &&
      result.stages.length === expected.length &&
      typeof result.success === "boolean" &&
      result.success ===
        result.stages.every((s: unknown) => isRecord(s) && s.status === "passed") &&
      typeof binding.exitCode === "string" &&
      /^(?:0|[1-9][0-9]{0,2})$/.test(binding.exitCode) &&
      Number(binding.exitCode) <= 255 &&
      (result.success
        ? binding.exitCode === "0"
        : binding.exitCode !== "0" ||
          (binding.exitCode === "0" && recordsDevelopmentPolicy(result, identity.source))),
    "complete execution report",
  );
  requireValid(isRecord(input.stageInputs), "input stage inventory");
  const stageInputs = input.stageInputs;
  const observedStages: unknown[] = result.stages;
  requireValid(Object.keys(stageInputs).length === expected.length, "input stage inventory");
  const files = new Map<string, Buffer>();
  const add = (name: string, value: unknown) =>
    files.set(name, Buffer.from(`${JSON.stringify(value)}\n`));
  add("inputs.json", capture);
  add("audit.json", aggregate);
  add("binding.json", binding);
  expected.forEach((stage, index) => {
    const observed = observedStages[index];
    const inputs = stageInputs[stage.id];
    requireValid(
      isRecord(inputs) &&
        inputs.contract === 1 &&
        isRecord(inputs.runtime) &&
        inputs.runtime.platform === "linux" &&
        isRecord(inputs.stage) &&
        inputs.stage.id === stage.id &&
        inputs.stage.recipe === stage.recipe &&
        inputs.stage.domain === stage.domain &&
        isRecord(observed) &&
        observed.id === stage.id &&
        observed.recipe === stage.recipe &&
        (observed.status === "passed" || observed.status === "failed") &&
        observed.originatingHead === identity.source &&
        observed.fingerprint === receiptEnvelope(inputs).integrity &&
        typeof observed.durationMs === "number" &&
        Number.isSafeInteger(observed.durationMs) &&
        observed.durationMs >= 0,
      `stage ${stage.id}`,
    );
    if (stage.reusable && observed.status === "passed") {
      const receipt = receipts[stage.id];
      requireValid(
        intact(receipt) &&
          validateReceipt(receipt, { stageId: stage.id, fingerprint: observed.fingerprint })
            .valid &&
          receipt.payload.recipe === stage.recipe &&
          receipt.payload.originatingHead === identity.source &&
          receipt.payload.durationMs === observed.durationMs &&
          within(receipt.payload.completedAt, executionWindow),
        `receipt ${stage.id}`,
      );
      add(`receipts/${stage.id}.json`, receipt);
    }
  });
  const manifest = {
    format: 1,
    kind: "hosted-audit-evidence",
    identity,
    diagnosticOnly: !result.success,
    limits: AUDIT_BUNDLE_LIMITS,
    files: [...files].map(([name, bytes]) => ({
      path: name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  add("manifest.json", manifest);
  const expanded = [...files.values()].reduce((n, b) => n + b.length, 0);
  requireValid(
    files.size <= AUDIT_BUNDLE_LIMITS.files && expanded <= AUDIT_BUNDLE_LIMITS.expandedBytes,
    "file or expanded byte limit",
  );
  // Match the pinned uploader's level; allow ample headers and central-directory overhead.
  const compressed = [...files.values()].reduce(
    (n, b) => n + deflateRawSync(b, { level: 6 }).length + 1024,
    65536,
  );
  requireValid(
    files.size <= AUDIT_BUNDLE_LIMITS.files &&
      expanded <= AUDIT_BUNDLE_LIMITS.expandedBytes &&
      compressed <= AUDIT_BUNDLE_LIMITS.compressedBytes,
    "file or byte limit",
  );
  return { manifest, files };
}

function readBoundedJson(file: string, budget: { bytes: number; files: number }): unknown {
  const stat = lstatSync(file);
  requireValid(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= budget.bytes && budget.files > 0,
    "input file limit",
  );
  budget.bytes -= stat.size;
  budget.files--;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function exportAuditBundle(root = fileURLToPath(new URL("../", import.meta.url))) {
  const identity = hostedAuditIdentity(root);
  const temporaryRoot = process.env.RUNNER_TEMP;
  requireValid(
    typeof temporaryRoot === "string" && temporaryRoot.length > 0,
    "runner temporary directory",
  );
  const budget = { bytes: AUDIT_BUNDLE_LIMITS.expandedBytes, files: AUDIT_BUNDLE_LIMITS.files };
  const binding = readBoundedJson(
    path.join(temporaryRoot, `deep-audit-${identity.run}-${identity.attempt}.json`),
    budget,
  );
  const capture = readBoundedJson(
    path.join(temporaryRoot, `audit-inputs-${identity.run}-${identity.attempt}.json`),
    budget,
  );
  const receiptRoot = path.join(root, "work", "validation-receipts");
  const aggregate = readBoundedJson(
    path.join(receiptRoot, "audits", `${identity.source}.json`),
    budget,
  );
  requireValid(
    intact(aggregate) && Array.isArray(aggregate.payload.stages),
    "complete execution report",
  );
  const observedStages: unknown[] = aggregate.payload.stages;
  const receipts: Record<string, unknown> = {};
  for (const stage of observedStages) {
    requireValid(isRecord(stage) && typeof stage.id === "string", "receipt stage identity");
    if (stage.status !== "passed" || !AUDIT_STAGES.find((entry) => entry.id === stage.id)?.reusable)
      continue;
    requireValid(
      typeof stage.fingerprint === "string" && digest.test(stage.fingerprint),
      "receipt fingerprint path",
    );
    receipts[stage.id] = readBoundedJson(
      path.join(receiptRoot, "stages", stage.id, `${stage.fingerprint}.json`),
      budget,
    );
  }
  const bundle = buildAuditBundle({ identity, binding, capture, aggregate, receipts });
  const directory = path.join(root, "work", "audit-bundles", `${identity.run}-${identity.attempt}`);
  const temporary = `${directory}.${randomUUID()}.tmp`;
  mkdirSync(temporary, { recursive: true });
  for (const [name, bytes] of bundle.files) {
    const file = path.join(temporary, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes, { flag: "wx" });
  }
  renameSync(temporary, directory);
  return { directory, diagnosticOnly: bundle.manifest.diagnosticOnly, files: bundle.files.size };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = exportAuditBundle();
    console.log(
      `Audit evidence: ${result.files} files; diagnostic only: ${result.diagnosticOnly}; ${result.directory}`,
    );
  } catch (error) {
    console.error(`Audit evidence unavailable: ${String(errorMessage(error)).slice(0, 512)}`);
    process.exitCode = 1;
  }
}
