/** Exact public record-set association for the existing owned publisher. This
 * is not a generic receipt importer: actual preparation below requires private
 * producer, tool and settled-publication custody. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { requireOwnedImmutableReleaseCompletion } from "./release-immutable-publication.mts";
import { requireReceivedSigningContext } from "./release-signing-context-artifact.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { updaterIdentity } from "./updater-artifact-inventory.mts";
import { packagesForPlatform, artifactName } from "./release-package-policy.mts";
import { requireNativeReleaseQualificationPair } from "./release-native-admission.mts";
import { requireVerifiedReleaseSbomDocument } from "./release-acceptance-evidence.mts";
import { immutableReleaseProgressDigest } from "./release-candidate-progress-contract.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function active(deadline: number) {
  if (!Number.isFinite(deadline) || performance.now() >= deadline)
    throw new Error("immutable publication result phase deadline exhausted");
}

/** Pure association only. Inputs here do not establish actual admission or an
 * authenticated context. The private factory below establishes those scopes. */
export async function inspectPublicationRecordAssociation(
  rawManifest: unknown,
  rawFacts: unknown,
  assets: readonly { filename: string; bytes: number; sha256: string }[],
  files: ReadonlyMap<string, Buffer>,
) {
  if (
    !isRecord(rawManifest) ||
    !isRecord(rawManifest.binding) ||
    !isRecord(rawManifest.facts) ||
    !isRecord(rawFacts) ||
    !isRecord(rawManifest.controller)
  )
    throw new Error("publication record association inputs missing");
  const binding = rawManifest.binding,
    facts = rawManifest.facts;
  const { accepted, policy, labels } = await inspectTrustedAssemblyInput(rawFacts.assembly);
  if (
    accepted.release_profile !== "initial-beta-win-linux" ||
    binding.version !== accepted.version ||
    binding.source_commit !== accepted.source_commit ||
    binding.source_tree !== accepted.source_tree ||
    binding.run_id !== String(accepted.run_id) ||
    binding.run_attempt !== accepted.run_attempt ||
    digest(facts.assembly) !== digest(rawFacts.assembly) ||
    digest(facts.archives) !== digest(rawFacts.archives) ||
    digest(facts.configuration) !== digest(rawFacts.configuration)
  )
    throw new Error("publication records differ from actual admitted package/source lineage");
  const packageFiles = labels.flatMap((label) =>
    packagesForPlatform(policy, label).map((rule) => {
      const filename = artifactName(rule, accepted.version);
      const file = accepted.files.find(
        (item) => item.platform_label === label && item.filename === filename,
      );
      if (!file) throw new Error("publication mandatory package absent from accepted inventory");
      return file;
    }),
  );
  if (
    assets.length < packageFiles.length ||
    new Set(assets.map((file) => file.filename)).size !== assets.length
  )
    throw new Error("publication asset inventory duplicates or omits accepted packages");
  for (const file of packageFiles) {
    const actual = assets.find((asset) => asset.filename === file.filename);
    if (!actual || actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new Error("published package differs from record-set source bytes");
  }
  const signatures: { platform: string; filename: string; bytes: number; sha256: string }[] = [];
  for (const label of labels) {
    const updater = updaterIdentity(policy, label, accepted.version);
    const recordBytes = files.get(
      `records/releases/${accepted.version}/${updater.target}/${updater.format}.json`,
    );
    const artifact = accepted.files.find(
      (file) => file.filename === updater.filename && file.platform_label === label,
    );
    const signature = assets.find((file) => file.filename === `${updater.filename}.sig`);
    if (!recordBytes || !artifact || !signature || recordBytes.length > 1024 * 1024)
      throw new Error("publication updater record or original signature asset absent");
    const record: unknown = JSON.parse(recordBytes.toString("utf8"));
    if (
      !isRecord(record) ||
      !isRecord(record.artifact) ||
      !isRecord(record.qualified_run) ||
      record.schema_version !== 1 ||
      record.version !== accepted.version ||
      record.source_commit !== accepted.source_commit ||
      record.source_tree !== accepted.source_tree ||
      record.target !== updater.target ||
      record.qualified_run.run_id !== Number(accepted.run_id) ||
      record.qualified_run.attempt !== accepted.run_attempt ||
      record.artifact.url !==
        `https://github.com/boburning/portcove/releases/download/v${accepted.version}/${updater.filename}` ||
      record.artifact.bytes !== artifact.bytes ||
      record.artifact.sha256 !== artifact.sha256 ||
      typeof record.artifact.tauri_signature !== "string" ||
      record.artifact.tauri_signature.length > 16384
    )
      throw new Error("publication updater record differs from exact admitted artifact");
    // Reconstruction deliberately removes one terminal newline; compare the
    // original signature asset with only the maintained three wire encodings.
    const signatureText = record.artifact.tauri_signature;
    if (
      !["", "\n", "\r\n"].some((ending) => {
        const bytes = Buffer.from(signatureText + ending);
        return bytes.length === signature.bytes && sha(bytes) === signature.sha256;
      })
    )
      throw new Error("publication signature asset differs from frozen updater record");
    signatures.push({
      platform: label,
      filename: signature.filename,
      bytes: signature.bytes,
      sha256: signature.sha256,
    });
  }
  // The two platform signatures have fixed identities; the retained producer's
  // digest also retains its original pair ordering, which conveys no authority.
  if (
    signatures.length !== 2 ||
    ![signatures, [...signatures].reverse()].some(
      (pair) => digest(pair) === binding.signatures_sha256,
    )
  )
    throw new Error("publication signature pair differs from actual context binding");
  return Object.freeze({
    version: accepted.version,
    source_commit: accepted.source_commit,
    source_tree: accepted.source_tree,
    run_id: String(accepted.run_id),
    run_attempt: accepted.run_attempt,
    records_sha256: binding.records_sha256,
    signatures_sha256: binding.signatures_sha256,
    authority: "none" as const,
    scope: "integrity-only" as const,
  });
}

async function observeAssociation(
  completionReceipt: object,
  contextReceipt: object,
  toolsReceipt: object,
  deadline: number,
) {
  active(deadline);
  const completion = await requireOwnedImmutableReleaseCompletion(completionReceipt);
  const actualContext = await requireReceivedSigningContext(contextReceipt);
  const context = {
    ...actualContext,
    manifest_sha256: sha(
      await readControllerToolFile(
        path.join(actualContext.directory, "signing-context-manifest.json"),
        1024 * 1024,
      ),
    ),
  };
  const tools = await verifiedControllerToolPaths(toolsReceipt);
  const controller = context.manifest.controller;
  if (
    !isRecord(controller) ||
    controller.controller_revision !== completion.executor.controller_revision ||
    controller.controller_ref !== completion.executor.execution_ref ||
    controller.source_tree !== tools.identity.source_tree ||
    tools.identity.controller_revision !== completion.executor.controller_revision ||
    tools.identity.controller_ref !== completion.executor.execution_ref ||
    tools.identity.run_id !== completion.executor.run_id ||
    tools.identity.run_attempt !== completion.executor.run_attempt
  )
    throw new Error("context producer/current publisher/tool execution boundaries differ");
  const files = await readBoundedReleaseContextFiles(path.dirname(context.context));
  await inspectPublicationRecordAssociation(
    context.manifest,
    completion.admission.facts,
    completion.release.assets,
    files,
  );
  const native = await requireNativeReleaseQualificationPair(
    completion.admission.native_qualifications,
    completion.admission.facts.assembly,
    completion.admission.facts.archives,
    "release-publication",
  );
  const sbom = await requireVerifiedReleaseSbomDocument(completion.admission.sbom_receipt);
  await requireReceivedSigningContext(contextReceipt);
  active(deadline);
  return { completion, context, tools, native, sbom };
}

const reports = new WeakMap<
  object,
  {
    completion: object;
    context: object;
    tools: object;
    deadline: number;
    directory: string;
    bytes: Buffer;
    record: Record<string, unknown>;
  }
>();

/** Public report data for the existing fixed attestation/upload route. It is
 * deliberately not feed authority until the receiver verifies its actual fixed
 * publisher attestation/provider and fresh site-stage controls/reservation. */
export async function prepareOwnedPublicationResult(
  completionReceipt: object,
  contextReceipt: object,
  toolsReceipt: object,
  outputParent: string,
  deadline: number,
) {
  const { completion, context, tools, native, sbom } = await observeAssociation(
    completionReceipt,
    contextReceipt,
    toolsReceipt,
    deadline,
  );
  if (!path.isAbsolute(outputParent))
    throw new Error("publication report requires private output root");
  const record = {
    schema_version: 1,
    kind: "owned-immutable-application-release",
    repository_id: 1354613114,
    namespace: completion.namespace,
    controller: {
      revision: completion.executor.controller_revision,
      source_tree: tools.identity.source_tree,
      ref: completion.executor.execution_ref,
      run_id: completion.executor.run_id,
      run_attempt: completion.executor.run_attempt,
    },
    producer: {
      job_id: completion.executor.job_id,
      check_run_id: completion.executor.check_run_id,
    },
    context: {
      manifest_sha256: context.manifest_sha256,
      facts_sha256: context.manifest.facts_sha256,
      binding: context.manifest.binding,
    },
    native: native.map((report) =>
      report.hosted_job
        ? {
            platform: report.platform_label,
            transport: "fixed-hosted-job",
            hosted_job: report.hosted_job,
            report_sha256: report.hosted_job.report_sha256,
          }
        : {
            platform: report.platform_label,
            id: report.check.id,
            sha256: report.check.report_sha256,
          },
    ),
    producer_sbom_sha256: sbom.sha256,
    candidate: Object.fromEntries(
      [
        "source_commit",
        "source_tree",
        "prepared_commit",
        "prepared_tree",
        "version",
        "intent_sha256",
        "release_run",
        "transient_retries",
        "substantive_repairs",
      ].map((key) => [key, completion.candidate[key]]),
    ),
    settlement: { checkpoint: completion.checkpoint, operation: completion.operation },
    release: completion.release,
    immutable_identity_sha256: immutableReleaseProgressDigest(completion.release),
    scope: "settled-immutable-release-only",
    authority: "none",
    pending_obligations: [
      "authenticated-feed-deployment",
      "independent-public-byte-readback",
      "ordinary-public-updater-journey",
      "durable-candidate-completion",
    ],
  };
  const bytes = Buffer.from(JSON.stringify(record) + "\n");
  if (bytes.length > 65536) throw new Error("owned publication report exceeds fixed bound");
  const directory = await mkdtemp(path.join(outputParent, "immutable-publication-result-"));
  await mkdir(path.join(directory, "upload"), { mode: 0o700 });
  await writeFile(path.join(directory, "upload", "immutable-release-result.json"), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  active(deadline);
  const receipt = Object.freeze({ kind: "actual-owned-publication-result", authority: "none" });
  reports.set(receipt, {
    completion: completionReceipt,
    context: contextReceipt,
    tools: toolsReceipt,
    deadline,
    directory,
    bytes,
    record,
  });
  return receipt;
}

export async function requireOwnedPublicationResult(receipt: object) {
  const actual = reports.get(receipt);
  if (!actual) throw new Error("actual owned publication result custody required");
  const observed = await observeAssociation(
    actual.completion,
    actual.context,
    actual.tools,
    actual.deadline,
  );
  const bytes = await readControllerToolFile(
    path.join(actual.directory, "upload", "immutable-release-result.json"),
    65536,
  );
  if (
    !bytes.equals(actual.bytes) ||
    immutableReleaseProgressDigest(observed.completion.release) !==
      actual.record.immutable_identity_sha256
  )
    throw new Error("retained owned publication result changed");
  active(actual.deadline);
  return Object.freeze({
    directory: actual.directory,
    report: path.join(actual.directory, "upload", "immutable-release-result.json"),
    report_sha256: sha(bytes),
    record: structuredClone(actual.record),
    executor_receipt: observed.completion.executor_receipt,
    controls: observed.completion.controls,
    original_context: observed.completion.original_context,
    authority: "none" as const,
    scope: "actual report custody; fixed attestation/provider handoff still required",
  });
}
