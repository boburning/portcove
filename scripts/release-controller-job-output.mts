/** Fixed job output routing only. Downstream receivers still authenticate the
 * exact provider artifacts, attestation, producer and current reservation. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createHash, randomBytes } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { inspectControllerExecutionPurpose } from "./release-control-phases.mts";
import {
  requireControllerCatalogPublicationAuthorities,
  requireControllerReleaseAuthorities,
} from "./release-authority-configuration.mts";
import { currentControllerJobDeadline } from "./release-signing-job-budget.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { inspectAggregateOriginalUpload } from "./release-aggregate-locator.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function record(value: unknown) {
  if (!isRecord(value)) throw new Error("fixed output record unavailable");
  return value;
}
function artifact(value: unknown, action = false) {
  const raw = record(value),
    id = raw[action ? "artifact_id" : "id"];
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof raw.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.sha256)
  )
    throw new Error("fixed output artifact identity unavailable");
  return { id, sha256: raw.sha256 };
}
function role(raw: unknown) {
  if (
    typeof raw !== "string" ||
    ![
      "coordinator",
      "building",
      "payload",
      "release-publication",
      "site-publication",
      "tuf-releases",
      "tuf-preview",
      "tuf-stable",
      "tuf-snapshot",
      "tuf-timestamp",
      "catalog-definitions",
      "catalog-policy",
      "catalog-snapshot",
      "catalog-timestamp",
    ].includes(raw)
  )
    throw new Error("fixed controller output role required");
  return raw;
}

/** Inert projection from retained actual-result bytes. No returned value is a
 * capability or accepted evidence; the ordinary consumers recheck custody. */
export function projectFixedControllerJobOutputs(
  rawRole: unknown,
  rawResult: unknown,
  custody?: {
    subject: Buffer;
    predicate: Buffer;
    bundle: unknown;
  },
  aggregatePredicate?: Buffer,
): Record<string, string> {
  const selected = role(rawRole),
    result = record(rawResult);
  if (typeof result.decision !== "string") throw new Error("fixed output decision unavailable");
  if (selected === "coordinator" && result.decision === "candidate-signing-custody-reused") {
    const reportRepair =
      result.report_only_repair === true &&
      typeof result.report_repair_sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(result.report_repair_sha256);
    if (
      ![...(reportRepair ? ["qualifying", "building"] : []), "publishing", "promoting"].includes(
        String(result.candidate_phase),
      ) ||
      !Array.isArray(result.role_locators) ||
      result.role_locators.length !== 5 ||
      result.role_locators.some(
        (entry: unknown, index: number) =>
          !isRecord(entry) ||
          entry.role !== ["releases", "preview", "stable", "snapshot", "timestamp"][index],
      )
    )
      throw new Error("original signing custody routing unavailable");
    return {
      mode: "release",
      stage: String(result.candidate_phase),
      signing_custody: "reused",
      context_locator: JSON.stringify(record(result.context_locator)),
      role_locators: JSON.stringify(result.role_locators),
      ...(result.publication_result_locator === undefined
        ? {}
        : (() => {
            if (result.candidate_phase !== "promoting")
              throw new Error("retained publication requires promoting candidate");
            return {
              publication_custody: "reused",
              publication_locator: JSON.stringify(record(result.publication_result_locator)),
            };
          })()),
      ...(reportRepair
        ? { report_only_repair: "true", report_repair_sha256: String(result.report_repair_sha256) }
        : {}),
    };
  }
  if (selected === "coordinator" && result.decision === "metadata-context-reused")
    return { mode: "metadata", context_locator: JSON.stringify(record(result.context_locator)) };
  if (
    selected === "coordinator" &&
    !["metadata-context-prepared", "catalog-context-prepared"].includes(String(result.decision))
  ) {
    const candidate = isRecord(result.active_candidate) ? result.active_candidate : null;
    const stage = result.decision === "dispatched" ? "qualifying" : candidate?.phase;
    return typeof stage === "string" &&
      ["qualifying", "building", "publishing", "promoting"].includes(stage)
      ? { mode: "release", stage }
      : { mode: "held", stage: "held" };
  }
  if (selected === "building") {
    if (
      ![
        "candidate-building-and-aggregate-prepared",
        "candidate-aggregate-readback-prepared",
      ].includes(result.decision) ||
      !aggregatePredicate ||
      aggregatePredicate.length > 65536 ||
      (result.decision === "candidate-aggregate-readback-prepared"
        ? !["publishing", "promoting"].includes(String(result.stage))
        : result.stage !== "building") ||
      typeof result.subject_name !== "string" ||
      !/^trusted-release-final-[1-9][0-9]*-1$/u.test(result.subject_name) ||
      typeof result.subject_digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(result.subject_digest) ||
      result.predicate_type !== "https://portcove.dev/attestations/package-aggregate/v1"
    )
      throw new Error("building aggregate output held");
    const predicate = record(JSON.parse(aggregatePredicate.toString("utf8"))),
      original =
        result.original_upload === undefined
          ? undefined
          : inspectAggregateOriginalUpload(result.original_upload),
      uploaded = artifact(result.artifact);
    if (
      predicate.role !== "package-aggregate-assembler" ||
      predicate.evidence_scope !== "github.com" ||
      releaseCanonicalDigest(artifact(predicate.artifact)) !== releaseCanonicalDigest(uploaded) ||
      record(predicate.artifact).name !== result.subject_name ||
      result.subject_digest !== `sha256:${uploaded.sha256}` ||
      predicate.producer_profile !==
        (original ? "admitted-aggregate-recovery-v1" : "admitted-aggregate-v1") ||
      releaseCanonicalDigest(predicate.original_upload ?? null) !==
        releaseCanonicalDigest(original ?? null)
    )
      throw new Error("aggregate producer lineage differs");
    return {
      descriptor: JSON.stringify(record(result.descriptor)),
      artifact_id: String(uploaded.id),
      artifact_sha256: uploaded.sha256,
      subject_name: result.subject_name,
      subject_digest: result.subject_digest,
      predicate: aggregatePredicate.toString("utf8"),
      predicate_type: result.predicate_type,
      stage: String(result.stage),
      ...(original ? { original_upload: JSON.stringify(original) } : {}),
    };
  }
  if (selected === "site-publication") {
    if (
      !["site-published", "metadata-site-published", "catalog-site-published"].includes(
        result.decision,
      )
    )
      throw new Error("site output held");
    return { decision: result.decision };
  }
  if (!custody) throw new Error("actual attestation custody unavailable");
  const bundle = artifact(custody.bundle, true),
    predicate = record(JSON.parse(custody.predicate.toString("utf8")));
  if (selected.startsWith("tuf-") || selected.startsWith("catalog-")) {
    if (
      result.decision !==
        (selected.startsWith("catalog-")
          ? "catalog-role-output-prepared"
          : "role-output-prepared") ||
      predicate.role !== selected ||
      result.subject_digest !== hash(custody.subject)
    )
      throw new Error("role output subject differs");
    return {
      role_locator: JSON.stringify({
        ...(selected.startsWith("catalog-") ? { purpose: "catalog" } : {}),
        role: selected.startsWith("catalog-") ? selected.slice(8) : selected.slice(4),
        controller: record(predicate.controller),
        artifact: artifact(result.artifact),
        bundle,
        context_manifest_sha256: predicate.context_manifest_sha256,
        context_binding_sha256: predicate.context_binding_sha256,
        context_facts_sha256: predicate.context_facts_sha256,
      }),
    };
  }
  if (selected === "release-publication") {
    const handoff = record(result.artifact),
      report = record(JSON.parse(custody.subject.toString("utf8"))),
      producer = record(report.controller);
    if (
      result.decision !== "immutable-release-and-result-prepared" ||
      handoff.report_sha256 !== hash(custody.subject) ||
      predicate.report_sha256 !== handoff.report_sha256
    )
      throw new Error("immutable result output subject differs");
    return {
      publication_locator: JSON.stringify({
        controller_revision: producer.revision,
        source_tree: producer.source_tree,
        controller_ref: producer.ref,
        run_id: producer.run_id,
        run_attempt: producer.run_attempt,
        artifact: artifact(handoff, true),
        bundle,
        report_sha256: handoff.report_sha256,
      }),
    };
  }
  const manifest = record(JSON.parse(custody.subject.toString("utf8"))),
    controller = record(manifest.controller),
    handoff = record(selected === "payload" ? result.context_upload : result.artifact),
    manifestSha = selected === "payload" ? handoff.manifest_sha256 : result.manifest_sha256;
  if (
    (result.decision === "catalog-context-prepared" &&
      (manifest.kind !== "catalog-signing-context" ||
        predicate.role !== "catalog-signing-context")) ||
    hash(custody.subject) !== manifestSha ||
    predicate.manifest_sha256 !== manifestSha ||
    manifest.facts_sha256 !== releaseCanonicalDigest(manifest.facts) ||
    (selected === "payload"
      ? result.decision !== "payload-and-context-prepared"
      : !["metadata-context-prepared", "catalog-context-prepared"].includes(
          String(result.decision),
        ))
  )
    throw new Error("context output subject differs");
  return {
    mode:
      selected === "coordinator"
        ? result.decision === "catalog-context-prepared"
          ? "catalog"
          : "metadata"
        : "release",
    context_locator: JSON.stringify({
      ...controller,
      artifact: artifact(handoff, selected === "payload"),
      bundle,
      manifest_sha256: manifestSha,
      binding_sha256: releaseCanonicalDigest(manifest.binding),
      facts_sha256: manifest.facts_sha256,
    }),
  };
}

export async function finishFixedControllerJobOutputs(rawRole: unknown) {
  const selected = role(rawRole),
    phase = selected === "building" ? "admission" : selected,
    root = process.env.RUNNER_TEMP;
  if (!root || !path.isAbsolute(root) || !process.env.GITHUB_OUTPUT)
    throw new Error("fixed output channels unavailable");
  await (
    inspectControllerExecutionPurpose(process.env.PORTCOVE_EXECUTION_PURPOSE) ===
      "catalog-publication"
      ? requireControllerCatalogPublicationAuthorities
      : requireControllerReleaseAuthorities
  )(phase);
  const deadline = currentControllerJobDeadline(
    selected,
    {
      run_id: process.env.GITHUB_RUN_ID ?? "",
      run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      controller_revision: process.env.GITHUB_SHA ?? "",
      controller_ref: process.env.GITHUB_REF ?? "",
    },
    root,
    performance.now() + 570000,
  );
  return withCoordinatorDeadline(deadline, async () => {
    const read = async (file: string, limit = 65536) => {
      await assertOwnedUnlinkedPath(root, file, "fixed output custody");
      return readControllerToolFile(file, limit);
    };
    const settlement = record(
      JSON.parse(
        (await read(path.join(root, `controller-job-settlement-${phase}.json`))).toString("utf8"),
      ),
    );
    if (
      Object.keys(settlement).sort().join(",") !== "exit_code,requires_attestation" ||
      settlement.exit_code !== 0 ||
      typeof settlement.requires_attestation !== "boolean"
    )
      throw new Error("fixed producer has no positive settlement");
    const result: unknown = JSON.parse(
      (await read(path.join(root, `controller-${selected}-result.json`), 256 * 1024)).toString(
        "utf8",
      ),
    );
    let custody: Parameters<typeof projectFixedControllerJobOutputs>[2];
    if (settlement.requires_attestation) {
      await read(path.join(root, `controller-transport-${phase}-attest-ack.json`));
      const event = record(
          JSON.parse(
            (await read(path.join(root, `controller-transport-${phase}-attest.json`))).toString(
              "utf8",
            ),
          ),
        ),
        files = event.files;
      if (
        !Array.isArray(files) ||
        files.length !== 1 ||
        !isRecord(files[0]) ||
        typeof files[0].path !== "string" ||
        typeof event.predicate !== "string"
      )
        throw new Error("fixed attestation files unavailable");
      const subject = await read(files[0].path, 1024 * 1024),
        predicate = await read(event.predicate, 1024 * 1024);
      if (hash(subject) !== files[0].sha256 || hash(predicate) !== event.predicate_sha256)
        throw new Error("fixed attestation bytes changed before output");
      custody = {
        subject,
        predicate,
        bundle: JSON.parse(
          (
            await read(path.join(root, `controller-transport-${phase}-attestation-uploaded.json`))
          ).toString("utf8"),
        ),
      };
    }
    let aggregatePredicate: Buffer | undefined;
    if (selected === "building") {
      const actual = record(result);
      if (
        typeof actual.predicate_path !== "string" ||
        path.basename(actual.predicate_path) !== "aggregate-predicate.json"
      )
        throw new Error("actual aggregate predicate locator unavailable");
      aggregatePredicate = await read(actual.predicate_path);
    }
    const outputs = projectFixedControllerJobOutputs(selected, result, custody, aggregatePredicate);
    for (const [key, value] of Object.entries(outputs)) {
      if (Buffer.byteLength(value) > 65536) throw new Error("fixed output exceeds bound");
      const separator = `controller_${randomBytes(16).toString("hex")}`;
      await appendFile(
        process.env.GITHUB_OUTPUT!,
        `${key}<<${separator}\n${value}\n${separator}\n`,
      );
    }
    return outputs;
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void finishFixedControllerJobOutputs(process.argv[2]).catch(() => {
    console.error("fixed controller output refused; retain custody and pending effects");
    process.exitCode = 1;
  });
