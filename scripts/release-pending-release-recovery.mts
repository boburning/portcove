/** Positive readback of one original Release intent. Data inspections below
 * grant no authority; the caller owns actual receipts, controls and executor. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { inspectCapacityOperation, capacityDigest as digest } from "./release-capacity.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import { releaseControlPhaseProfile } from "./release-control-phases.mts";
import { requireRetainedSigningContext } from "./release-signing-context-artifact.mts";
import { requireRetainedActualTufPublication } from "./release-tuf-publication.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { reconstructPublicationSignatures } from "./release-publication-inputs.mts";
import { releaseSbomName } from "./finalize-release-assets.mts";
import { parseReleaseChecksumManifest } from "./reconcile-release-assets.mts";
import {
  readImmutableReleaseCustodyState,
  proposeImmutableReleaseTransition,
  type ReleaseAsset,
} from "./release-immutable-publication.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const repository = "boburning/portcove";
const base = `repos/${repository}`;
const terminalConclusions = [
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
];
type Operation = NonNullable<ReturnType<typeof inspectCapacityOperation>>;
export function inspectPendingCandidateReleaseOperation(raw: unknown, candidate: unknown) {
  const operation = inspectCapacityOperation(raw);
  assert.ok(
    operation &&
      isRecord(candidate) &&
      ["publishing", "promoting"].includes(String(candidate.phase)) &&
      ["pending", "ambiguous", "capacity-refused"].includes(operation.outcome) &&
      operation.kind === "upload" &&
      operation.receipt_limit === 1 &&
      operation.executor_identity?.role === "release-publication" &&
      operation.executor_identity.workflow === productionControllerWorkflow &&
      operation.executor_identity.run_attempt === 1 &&
      operation.candidate !== undefined &&
      operation.candidate.source_commit === candidate.source_commit &&
      operation.candidate.prepared_commit === candidate.prepared_commit &&
      operation.candidate.version === candidate.version &&
      operation.candidate.transient_retries === candidate.transient_retries &&
      operation.candidate.substantive_repairs === candidate.substantive_repairs,
    "exact unresolved original candidate Release intent required",
  );
  const prefix = `github-release:${repository}:v${String(candidate.version)}:`;
  assert.ok(operation.destination.startsWith(prefix), "different original Release destination");
  const suffix = operation.destination.slice(prefix.length);
  assert.ok(
    ["create-draft", "publish"].includes(suffix) ||
      /^upload:[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$/u.test(suffix),
    "unsupported original Release logical effect",
  );
  return operation;
}

export function inspectPendingReleaseProducer(
  rawRun: unknown,
  rawAttempt: unknown,
  rawJob: unknown,
  operation: Operation,
) {
  const producer = operation.executor_identity!;
  for (const run of [rawRun, rawAttempt])
    assert.ok(
      isRecord(run) &&
        String(run.id) === producer.run_id &&
        run.run_attempt === 1 &&
        run.head_sha === producer.controller_revision &&
        run.path === productionControllerWorkflow &&
        run.event === "workflow_dispatch" &&
        isRecord(run.actor) &&
        String(run.actor.id) === producer.actor_id &&
        run.status === "completed" &&
        terminalConclusions.includes(String(run.conclusion)) &&
        isRecord(run.repository) &&
        run.repository.id === 1354613114 &&
        run.repository.full_name === repository &&
        isRecord(run.head_repository) &&
        run.head_repository.id === 1354613114,
      "original Release run is not exact and terminal",
    );
  assert.ok(
    isRecord(rawJob) &&
      rawJob.id === producer.job_id &&
      String(rawJob.run_id) === producer.run_id &&
      rawJob.run_attempt === 1 &&
      rawJob.head_sha === producer.controller_revision &&
      rawJob.status === "completed" &&
      terminalConclusions.includes(String(rawJob.conclusion)) &&
      rawJob.check_run_url ===
        `https://api.github.com/${base}/check-runs/${String(producer.check_run_id)}` &&
      rawJob.name === releaseControlPhaseProfile("release-publication").reader_name,
    "original fixed publisher is not observed terminal",
  );
  return {
    run: structuredClone(rawRun),
    attempt: structuredClone(rawAttempt),
    job: structuredClone(rawJob),
    authority: "none" as const,
  };
}

export interface PendingReleaseAssets {
  version: string;
  source_commit: string;
  assets: ReleaseAsset[]; // All fully known identities, excluding the SBOM's not-yet-observed length.
  sbom_sha256: string;
}
/** Actual private receivers and keyless Tough output are the only default input
 * source. This returns data, never a publication/admission capability. */
export async function derivePendingReleaseAssets(
  contextReceipt: object,
  publicationReceipt: object,
  toolsReceipt: object,
  candidate: Record<string, unknown>,
  deadline: number,
): Promise<PendingReleaseAssets> {
  const publication = await requireRetainedActualTufPublication(publicationReceipt, deadline);
  assert.equal(publication.context_receipt, contextReceipt);
  assert.equal(publication.tools_receipt, toolsReceipt);
  const context = await requireRetainedSigningContext(contextReceipt, deadline);
  const manifest = context.manifest;
  assert.ok(isRecord(manifest.binding) && isRecord(manifest.facts));
  const { accepted, policy } = await inspectTrustedAssemblyInput(manifest.facts.assembly);
  assert.equal(accepted.version, candidate.version);
  assert.equal(accepted.source_commit, candidate.prepared_commit);
  assert.equal(accepted.source_tree, candidate.prepared_tree);
  assert.ok(isRecord(manifest.facts.sbom_evidence));
  const sbom = manifest.binding.sbom_sha256;
  assert.ok(typeof sbom === "string" && /^[a-f0-9]{64}$/u.test(sbom));
  assert.equal(manifest.facts.sbom_evidence.document_sha256, sbom);
  const files = await readBoundedReleaseContextFiles(path.dirname(context.context));
  const signatures = await reconstructPublicationSignatures(manifest, manifest.facts, files);
  const assets = [
    ...accepted.files.map(({ filename, bytes, sha256 }) => ({ filename, bytes, sha256 })),
    ...signatures.map(({ filename, bytes }) => ({
      filename,
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
  ];
  const checksum = Buffer.from(
    [
      ...assets.map(({ filename, sha256 }) => ({ filename, sha256 })),
      { filename: releaseSbomName, sha256: sbom },
    ]
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .map((entry) => `${entry.sha256}  ${entry.filename}\n`)
      .join(""),
  );
  parseReleaseChecksumManifest(checksum.toString("utf8"), "original signed Release readback");
  assets.push({
    filename: policy.checksum_manifest,
    bytes: checksum.length,
    sha256: hash(checksum),
  });
  assert.equal(new Set(assets.map((entry) => entry.filename)).size, assets.length);
  return {
    version: accepted.version,
    source_commit: accepted.source_commit,
    assets,
    sbom_sha256: sbom,
  };
}

/** Pure/injected provider observations remain data. Missing/partial target
 * effects refuse; no 404 or current absence is converted into non-application. */
export async function observePendingCandidateRelease(
  api: GitHubRestReader,
  operation: Operation,
  expected: PendingReleaseAssets,
  readSbom: (id: number, maximum: number) => Promise<Buffer> | Buffer,
) {
  const names = [...expected.assets.map((entry) => entry.filename), releaseSbomName];
  const actual = readImmutableReleaseCustodyState(api, {
    version: expected.version,
    source_commit: expected.source_commit,
    asset_names: names,
  });
  assert.ok(isRecord(actual.release), "original Release effect has no positive readback");
  const known = expected.assets.map((entry) => ({ ...entry }));
  const sboms = actual.assets.filter((entry) => isRecord(entry) && entry.name === releaseSbomName);
  assert.ok(sboms.length <= 1, "SBOM asset identity conflicts");
  if (sboms.length) {
    const sbom = sboms[0];
    assert.ok(
      isRecord(sbom) &&
        Number.isSafeInteger(sbom.id) &&
        Number(sbom.id) > 0 &&
        Number.isSafeInteger(sbom.size) &&
        Number(sbom.size) > 0 &&
        Number(sbom.size) <= 16 * 1024 ** 2 &&
        sbom.digest === `sha256:${expected.sbom_sha256}`,
      "original SBOM metadata differs",
    );
    const bytes = await readSbom(Number(sbom.id), Number(sbom.size));
    assert.equal(bytes.length, sbom.size);
    assert.equal(hash(bytes), expected.sbom_sha256, "original SBOM bytes differ");
    known.push({ filename: releaseSbomName, bytes: bytes.length, sha256: expected.sbom_sha256 });
  }
  // Missing SBOM length is kept Unknown: it is never replaced with invented
  // metadata. Existing validators authenticate every present asset. Publication
  // additionally requires the entire fixed name set below.
  const transition = proposeImmutableReleaseTransition(
    { version: expected.version, source_commit: expected.source_commit, assets: known },
    actual.release,
    actual.assets,
  );
  const normalized = actual.assets
    .map((entry) => {
      assert.ok(isRecord(entry));
      const item = known.find((file) => file.filename === entry.name);
      assert.ok(item);
      return {
        id: Number(entry.id),
        release_id: Number(actual.release!.id),
        ...item,
        download_url: entry.browser_download_url,
      };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const prefix = `github-release:${repository}:v${expected.version}:`;
  assert.ok(operation.destination.startsWith(prefix));
  const suffix = operation.destination.slice(prefix.length);
  if (actual.release.draft === false)
    assert.equal(normalized.length, names.length, "published Release is missing mandatory assets");
  let remoteIdentity: string;
  if (suffix === "create-draft") {
    remoteIdentity = `github-release:${repository}:release:${String(actual.release.id)}:draft:${digest(normalized)}`;
  } else if (suffix === "publish") {
    assert.equal(
      transition.decision,
      "complete",
      "original publish effect is not positively complete",
    );
    assert.equal(normalized.length, names.length, "original publish asset set is incomplete");
    remoteIdentity = `github-release:${repository}:release:${String(actual.release.id)}:immutable:${digest(normalized)}`;
  } else {
    assert.ok(suffix.startsWith("upload:"));
    const asset = normalized.find((entry) => entry.filename === suffix.slice(7));
    assert.ok(asset, "original upload target is missing; preserve pending intent");
    remoteIdentity = `github-release:${repository}:release:${String(actual.release.id)}:asset:${asset.id}:${asset.sha256}`;
  }
  const projection = {
    operation_id: operation.id,
    version: expected.version,
    source_commit: expected.source_commit,
    release: {
      id: actual.release.id,
      draft: actual.release.draft,
      immutable: actual.release.immutable,
    },
    assets: normalized,
    tag_commit: actual.tag_commit,
  };
  const evidence = digest(projection);
  if (operation.completed_effects.length)
    assert.equal(
      operation.completed_effects[0]!.remote_identity,
      remoteIdentity,
      "retained original effect identity changed",
    );
  return {
    projection,
    evidence_sha256: evidence,
    remote_identity: remoteIdentity,
    authority: "none" as const,
  };
}
