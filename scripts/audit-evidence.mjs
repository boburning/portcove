import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { AUDIT_STAGES, hostedAuditIdentity, receiptEnvelope, validateReceipt } from "./audit.mjs";

export const AUDIT_BUNDLE_LIMITS = Object.freeze({
  files: 64,
  expandedBytes: 32 * 1024 * 1024,
  compressedBytes: 8 * 1024 * 1024,
});
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const positive = /^[1-9][0-9]{0,12}$/;
const keys = ["source", "workflowSha", "workflowRef", "workflowDigest", "run", "attempt"];
function requireValid(condition, reason) {
  if (!condition) throw new Error(`Audit bundle rejected: ${reason}`);
}
function intact(value) {
  return value?.payload && value.integrity === receiptEnvelope(value.payload).integrity;
}
function within(time, binding) {
  const ms = Date.parse(time);
  return Number.isFinite(ms) && ms >= binding.startedMs && ms <= binding.completedMs;
}

export function buildAuditBundle({ identity, binding, capture, aggregate, receipts }) {
  requireValid(
    identity?.repository === "boburning/portcove" &&
      sha.test(identity.source) &&
      sha.test(identity.workflowSha) &&
      digest.test(identity.workflowDigest) &&
      positive.test(identity.run) &&
      positive.test(identity.attempt) &&
      /^boburning\/portcove\/\.github\/workflows\/deep-quality.yml@refs\/heads\/[A-Za-z0-9_./-]+$/.test(
        identity.workflowRef,
      ),
    "producer identity",
  );
  requireValid(
    keys.every((k) => binding?.[k] === identity[k]) &&
      Number.isSafeInteger(binding.startedMs) &&
      Number.isSafeInteger(binding.completedMs) &&
      binding.startedMs > 0 &&
      binding.completedMs >= binding.startedMs &&
      binding.completedMs <= Date.now(),
    "attempt binding",
  );
  const input = capture?.payload;
  const result = aggregate?.payload;
  requireValid(
    intact(capture) &&
      input.format === 1 &&
      input.kind === "audit-inputs" &&
      input.head === identity.source &&
      input.profile === "complete" &&
      keys.every((k) => input.identity?.[k] === identity[k]) &&
      input.identity.repository === identity.repository &&
      within(input.capturedAt, binding),
    "original input capture",
  );
  const expected = AUDIT_STAGES.filter((s) => !s.platforms || s.platforms.includes("linux"));
  requireValid(
    intact(aggregate) &&
      result.format === 1 &&
      result.kind === "audit-run" &&
      result.profile === "complete" &&
      result.head === identity.source &&
      within(result.completedAt, binding) &&
      binding.receiptIntegrity === aggregate.integrity &&
      Array.isArray(result.stages) &&
      result.stages.length === expected.length &&
      typeof result.success === "boolean" &&
      result.success === result.stages.every((s) => s.status === "passed") &&
      /^(?:0|[1-9][0-9]{0,2})$/.test(binding.exitCode) &&
      Number(binding.exitCode) <= 255 &&
      (result.success ? binding.exitCode === "0" : binding.exitCode !== "0"),
    "complete execution report",
  );
  requireValid(Object.keys(input.stageInputs).length === expected.length, "input stage inventory");
  const files = new Map();
  const add = (name, value) => files.set(name, Buffer.from(`${JSON.stringify(value)}\n`));
  add("inputs.json", capture);
  add("audit.json", aggregate);
  add("binding.json", binding);
  expected.forEach((stage, index) => {
    const observed = result.stages[index];
    const inputs = input.stageInputs[stage.id];
    requireValid(
      inputs?.contract === 1 &&
        inputs.runtime?.platform === "linux" &&
        inputs.stage?.id === stage.id &&
        inputs.stage.recipe === stage.recipe &&
        inputs.stage.domain === stage.domain &&
        observed.id === stage.id &&
        observed.recipe === stage.recipe &&
        ["passed", "failed"].includes(observed.status) &&
        observed.originatingHead === identity.source &&
        observed.fingerprint === receiptEnvelope(inputs).integrity &&
        Number.isSafeInteger(observed.durationMs) &&
        observed.durationMs >= 0,
      `stage ${stage.id}`,
    );
    if (stage.reusable && observed.status === "passed") {
      const receipt = receipts[stage.id];
      requireValid(
        validateReceipt(receipt, { stageId: stage.id, fingerprint: observed.fingerprint }).valid &&
          receipt.payload.recipe === stage.recipe &&
          receipt.payload.originatingHead === identity.source &&
          receipt.payload.durationMs === observed.durationMs &&
          within(receipt.payload.completedAt, binding),
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

function readBoundedJson(file, budget) {
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
  const receipts = Object.fromEntries(
    aggregate.payload.stages
      .filter((s) => s.status === "passed" && AUDIT_STAGES.find((e) => e.id === s.id)?.reusable)
      .map((s) => {
        requireValid(digest.test(s.fingerprint), "receipt fingerprint path");
        return [
          s.id,
          readBoundedJson(path.join(receiptRoot, "stages", s.id, `${s.fingerprint}.json`), budget),
        ];
      }),
  );
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
    console.error(`Audit evidence unavailable: ${String(error.message).slice(0, 512)}`);
    process.exitCode = 1;
  }
}
