import { appendFile, mkdtemp, open, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { readRemoteCoordinatorSnapshot } from "./release-coordinator-recovery.mts";
import { assembleReleaseArtifacts } from "./release-artifact-assembly.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import {
  prepareAggregateAttestation,
  verifyUploadedAggregate,
} from "./trusted-aggregate-attestation.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import {
  requestAssemblerToken,
  controllerOidcSubject,
  inspectAssemblerIdentityExpectation,
} from "./assembler-job-identity.mts";
import { inspectReleaseEvidenceRequest } from "./release-run-evidence.mts";

/** Transport only. The held workflow has no producer for this descriptor until
 * independent candidate admission is implemented and ratified. Parsing it or
 * matching the journal does not authenticate its policy/file facts. */
export function inspectAggregateDescriptor(raw: string | undefined) {
  if (!raw || Buffer.byteLength(raw) > 64 * 1024)
    throw new Error("independently admitted aggregate descriptor is unavailable or oversized");
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "archives,assembly,checkpoint,coordinator,evidence,schema_version" ||
    value.schema_version !== 1 ||
    typeof value.checkpoint !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.checkpoint) ||
    !isRecord(value.coordinator) ||
    Object.keys(value.coordinator).sort().join(",") !== "namespace,schema_version" ||
    value.coordinator.schema_version !== 1 ||
    typeof value.coordinator.namespace !== "string" ||
    !/^portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/u.test(value.coordinator.namespace) ||
    value.coordinator.namespace.length > 64 ||
    !isRecord(value.evidence)
  )
    throw new Error("aggregate descriptor schema or reservation identity is invalid");
  return {
    schema_version: 1,
    checkpoint: value.checkpoint,
    coordinator: value.coordinator,
    assembly: value.assembly,
    archives: value.archives,
    evidence: value.evidence,
  };
}

/** Association with the EXISTING reservation; never allocate or advance state.
 * Upstream acceptance and fresh policy/pause/capacity checks remain mandatory. */
export async function requireReservedAggregate(rawDescriptor: string, rawState: unknown) {
  const descriptor = inspectAggregateDescriptor(rawDescriptor);
  const { accepted } = await inspectTrustedAssemblyInput(descriptor.assembly);
  if (accepted.release_profile === "initial-beta-win-linux" && !accepted.public_build_inputs)
    throw new Error("protected beta assembly requires independently bound public build inputs");
  if (
    !isRecord(rawState) ||
    rawState.checkpoint !== descriptor.checkpoint ||
    !isRecord(rawState.input)
  )
    throw new Error("aggregate reservation checkpoint changed or is missing");
  const candidate = rawState.input.active_candidate;
  if (
    !isRecord(candidate) ||
    !["building", "publishing"].includes(String(candidate.phase)) ||
    candidate.prepared_commit !== accepted.source_commit ||
    candidate.prepared_tree !== accepted.source_tree ||
    candidate.version !== accepted.version ||
    !isRecord(candidate.release_run) ||
    String(candidate.release_run.run_id) !== accepted.run_id ||
    candidate.release_run.attempt !== accepted.run_attempt ||
    candidate.release_run.revision !== accepted.source_commit
  )
    throw new Error(
      "aggregate differs from the existing prepared candidate and frozen Release run",
    );
  return { descriptor, accepted };
}

async function output(values: Record<string, string>) {
  const filename = process.env.GITHUB_OUTPUT;
  if (!filename) throw new Error("workflow output channel is missing");
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/u.test(value) || Buffer.byteLength(value) > 64 * 1024)
      throw new Error("workflow output exceeds its single-line bound");
    await appendFile(filename, `${key}=${value}\n`);
  }
}

/** Retain only non-secret association and stage, even if the operation throws.
 * A pre-existing receipt is never overwritten and exception text is excluded. */
export async function retainAggregateStepReceipt(
  filename: string,
  association: { checkpoint: string; descriptor_sha256: string; operation: string },
  operation: (stage: (phase: string) => void) => Promise<void>,
) {
  const expected = structuredClone(association);
  let phase = "recover-existing-reservation";
  const handle = await open(filename, "wx", 0o600);
  const record = (status: string) =>
    handle.writeFile(
      JSON.stringify({
        schema_version: 1,
        ...expected,
        status,
        phase,
        qualification: "orchestration only; no acceptance or publication authority",
      }) + "\n",
    );
  try {
    await record("started");
    await operation((next) => {
      phase = next;
    });
    phase = "complete";
    await record("succeeded");
  } catch (error) {
    await record("refused");
    throw error;
  } finally {
    await handle.close();
  }
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["assemble", "bind", "verify"].includes(mode ?? ""))
    throw new Error("choose only assemble, bind or verify from the held fixed workflow");
  // These jobs remain literally held. This program cannot turn a descriptor into
  // authorization, write a reservation, sign, publish, or select another run.
  const raw = process.env.PORTCOVE_ACCEPTED_AGGREGATE;
  const descriptor = inspectAggregateDescriptor(raw);
  const temp = process.env.RUNNER_TEMP;
  if (!temp || /[\r\n]/u.test(temp) || !path.isAbsolute(temp))
    throw new Error("private runner temporary root is unavailable");
  const receipt = path.join(temp, `portcove-aggregate-${mode}-receipt.jsonl`);
  await retainAggregateStepReceipt(
    receipt,
    {
      operation: mode!,
      checkpoint: descriptor.checkpoint,
      descriptor_sha256: createHash("sha256").update(raw!).digest("hex"),
    },
    async (stage) => {
      if (mode === "assemble") {
        const root = await mkdtemp(path.join(temp, "portcove-aggregate-"));
        const recover = () =>
          readRemoteCoordinatorSnapshot(root, descriptor.coordinator, { transport: { cwd: root } });
        const before = await recover();
        await requireReservedAggregate(raw!, before);
        stage("assemble-accepted-archives");
        const result = await assembleReleaseArtifacts(
          root,
          descriptor.assembly,
          descriptor.archives,
          inspectReleaseEvidenceRequest(descriptor.evidence),
        );
        const after = await recover();
        await requireReservedAggregate(raw!, after);
        await writeFile(path.join(root, "assembly-receipt.json"), JSON.stringify(result), {
          flag: "wx",
          mode: 0o600,
        });
        await output({ assets: result.aggregate.assets });
      } else if (mode === "bind") {
        const expected = inspectAssemblerIdentityExpectation({
          audience: process.env.PORTCOVE_AGGREGATE_AUDIENCE,
          subject: controllerOidcSubject(process.env.PORTCOVE_CONTROLLER_REF ?? ""),
          controller_revision: process.env.PORTCOVE_CONTROLLER_REVISION,
          controller_ref: process.env.PORTCOVE_CONTROLLER_REF,
          actor_id: process.env.PORTCOVE_CONTROLLER_ACTOR_ID,
          run_id: process.env.GITHUB_RUN_ID,
          run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        });
        if (!Array.isArray(descriptor.archives))
          throw new Error("accepted artifact matrix is missing");
        const ids = descriptor.archives.map((archive) => {
          if (!isRecord(archive) || typeof archive.artifact_id !== "number")
            throw new Error("accepted artifact ID missing");
          return archive.artifact_id;
        });
        const root = await mkdtemp(path.join(temp, "portcove-binding-"));
        const recovered = await readRemoteCoordinatorSnapshot(root, descriptor.coordinator, {
          transport: { cwd: root },
        });
        await requireReservedAggregate(raw!, recovered);
        stage("fresh-own-job-token");
        const token = await requestAssemblerToken(expected.audience);
        stage("bind-new-upload");
        const binding = await prepareAggregateAttestation(
          token,
          expected,
          descriptor.assembly,
          ids,
          {
            artifact_id: Number(process.env.PORTCOVE_NEW_ARTIFACT_ID),
            sha256: process.env.PORTCOVE_NEW_ARTIFACT_SHA256 ?? "",
          },
          { cwd: root, evidenceRequest: inspectReleaseEvidenceRequest(descriptor.evidence) },
        );
        await output({
          artifact_id: String(binding.predicate.artifact.id),
          artifact_sha256: binding.predicate.artifact.sha256,
          subject_name: binding.subject_name,
          subject_digest: binding.subject_digest,
          predicate: JSON.stringify(binding.predicate),
        });
      } else {
        const root = await mkdtemp(path.join(temp, "portcove-verification-"));
        const recover = () =>
          readRemoteCoordinatorSnapshot(root, descriptor.coordinator, { transport: { cwd: root } });
        let result;
        try {
          await requireReservedAggregate(raw!, await recover());
          if (!Array.isArray(descriptor.archives))
            throw new Error("accepted artifact matrix is missing");
          const ids = descriptor.archives.map((archive) => {
            if (!isRecord(archive) || typeof archive.artifact_id !== "number")
              throw new Error("accepted artifact ID missing");
            return archive.artifact_id;
          });
          stage("verify-exact-uploaded-aggregate-and-bundle");
          result = await verifyUploadedAggregate(root, {
            controller_revision: process.env.PORTCOVE_CONTROLLER_REVISION ?? "",
            controller_ref: process.env.PORTCOVE_CONTROLLER_REF ?? "",
            run_id: process.env.GITHUB_RUN_ID ?? "",
            run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
            artifact_id: Number(process.env.PORTCOVE_NEW_ARTIFACT_ID),
            sha256: process.env.PORTCOVE_NEW_ARTIFACT_SHA256 ?? "",
            bundle_artifact_id: Number(process.env.PORTCOVE_BUNDLE_ARTIFACT_ID),
            bundle_sha256: process.env.PORTCOVE_BUNDLE_ARTIFACT_SHA256 ?? "",
            candidate: descriptor.assembly,
            candidate_artifact_ids: ids,
          });
          stage("reservation-after-verification");
          await requireReservedAggregate(raw!, await recover());
        } catch (error) {
          const failure =
            error instanceof CoordinatorRemoteError
              ? error.evidence
              : {
                  directory: root,
                  acquisition_directory: result?.acquisition_directory,
                  verification_directory: result?.directory,
                  authority: "none",
                  decision: "refused",
                };
          await writeFile(
            path.join(temp, "portcove-aggregate-verification-result.json"),
            JSON.stringify(failure),
            { flag: "wx", mode: 0o600 },
          );
          throw error;
        }
        await writeFile(
          path.join(temp, "portcove-aggregate-verification-result.json"),
          JSON.stringify(result),
          { flag: "wx", mode: 0o600 },
        );
      }
    },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never print bearer tokens, provider response bodies or credential URLs.
    console.error(
      "held aggregate step refused; retain this run's private evidence and existing reservation",
    );
    process.exitCode = 1;
  });
}

export { requestAssemblerToken } from "./assembler-job-identity.mts";
