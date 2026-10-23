/** Existing GitHub/Sigstore verifier + fixed historical job custody. This does
 * not appoint a trust anchor, accept a history seed, prove current protections
 * or authorize an effect. The caller supplies independently ratified inputs. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  coordinatorCheckpointEvidenceSubject,
  coordinatorCheckpointPredicateType,
  inspectCoordinatorCheckpointEvidence,
} from "./release-coordinator-checkpoint-evidence.mts";
import type { CoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-evidence.mts";
import type { exportCoordinatorCheckpoint } from "./release-coordinator-state.mts";
import type { CapacityExecutorRole } from "./assembler-job-identity.mts";
import { verifyControllerArtifactVerification } from "./github-controller-attestation.mts";
import { verifyHistoricalCheckpointJob } from "./release-checkpoint-job-identity.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import { isRecord } from "./runtime-values.mts";

type Checkpoint = Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>;
export interface CheckpointProducerExpectation {
  actor_id: string;
  check_run_id: string;
  configuration_sha256: string;
  controller_ref: string;
  controller_revision: string;
  job_id: string;
  run_attempt: number;
  run_id: string;
  setup_sha256: string;
  workflow_sha256: string;
}
export interface AuthenticatedCheckpointEvidence {
  readonly kind: "authenticated-checkpoint-evidence";
  readonly evidence_scope: "github.com" | "injected-provider";
  readonly capture_directory: string;
  readonly authority: "none";
}
const receipts = new WeakMap<
  AuthenticatedCheckpointEvidence,
  {
    checkpoint: string;
    namespace: string;
    evidence: CoordinatorCheckpointEvidence;
    deadline: number;
    scope: "github.com" | "injected-provider";
  }
>();
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");

export async function authenticateCoordinatorCheckpointEvidence(
  directory: string,
  rawCheckpoint: Checkpoint,
  rawConfiguration: unknown,
  rawEvidence: CoordinatorCheckpointEvidence,
  rawExpected: { role: CapacityExecutorRole; producer: CheckpointProducerExpectation },
  deadline: number,
  options: {
    attestation?: NonNullable<Parameters<typeof verifyControllerArtifactVerification>[5]>;
    job?: Pick<Parameters<typeof verifyHistoricalCheckpointJob>[3], "api" | "spawn">;
  } = {},
): Promise<AuthenticatedCheckpointEvidence> {
  // Copy bounded bytes and all independently selected metadata synchronously.
  // No caller-retained buffer/object can change the binding across an await.
  if (
    !Buffer.isBuffer(rawEvidence.subject) ||
    rawEvidence.subject.length < 1 ||
    rawEvidence.subject.length > 16384 ||
    !Buffer.isBuffer(rawEvidence.bundle) ||
    rawEvidence.bundle.length < 1 ||
    rawEvidence.bundle.length > 65536
  )
    throw new Error("checkpoint authentication evidence exceeds byte bounds");
  const evidence = {
    subject: Buffer.from(rawEvidence.subject),
    bundle: Buffer.from(rawEvidence.bundle),
  };
  const checkpoint = structuredClone(rawCheckpoint);
  const configuration: unknown = structuredClone(rawConfiguration);
  const expected = structuredClone(rawExpected);
  const attestationOptions =
    options.attestation === undefined
      ? undefined
      : {
          ...options.attestation,
          ...(options.attestation.environment
            ? { environment: { ...options.attestation.environment } }
            : {}),
        };
  const jobOptions = options.job === undefined ? undefined : { ...options.job };
  const scope =
    attestationOptions !== undefined || jobOptions !== undefined
      ? "injected-provider"
      : "github.com";
  const active = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      throw new Error("checkpoint authentication original deadline exhausted");
  };
  active();
  if (deadline - performance.now() > 120000)
    throw new Error("checkpoint authentication requires an original bounded deadline");
  const selected = coordinatorCheckpointEvidenceSubject(
    checkpoint,
    configuration,
    expected.producer,
  );
  if (!Buffer.isBuffer(evidence.subject) || !evidence.subject.equals(selected))
    throw new Error("checkpoint evidence differs from independently expected producer/inputs");
  inspectCoordinatorCheckpointEvidence(checkpoint, configuration, evidence);
  const environment = attestationOptions?.environment ?? readOnlyReleaseChildEnvironment();
  if (!environment)
    throw new Error("checkpoint verification requires isolated read-only child credentials");
  if (
    !path.isAbsolute(directory) ||
    (await realpath(directory)) !== path.resolve(directory) ||
    !(await lstat(directory)).isDirectory()
  )
    throw new Error("checkpoint authentication requires an owned canonical capture parent");
  active();
  const capture = await mkdtemp(path.join(directory, "checkpoint-verification-"));
  let phase = "capture";
  try {
    const subjectPath = path.join(capture, "transition.json");
    const bundlePath = path.join(capture, "bundle.sigstore.json");
    const original = {
      subject: Buffer.from(evidence.subject),
      bundle: Buffer.from(evidence.bundle),
    };
    await writeFile(subjectPath, original.subject, { flag: "wx", mode: 0o600 });
    await writeFile(bundlePath, original.bundle, { flag: "wx", mode: 0o600 });
    active();
    phase = "signature";
    const verified = verifyControllerArtifactVerification(
      capture,
      subjectPath,
      bundlePath,
      expected.producer,
      coordinatorCheckpointPredicateType,
      { ...attestationOptions, environment, deadline },
    );
    // Reuse the exact transport statement binding after the real verifier. It
    // must verify THIS subject/bundle, not another valid controller statement.
    const raw: unknown = JSON.parse(original.bundle.toString());
    if (
      !isRecord(raw) ||
      !isRecord(raw.dsseEnvelope) ||
      typeof raw.dsseEnvelope.payload !== "string"
    )
      throw new Error("checkpoint verified envelope missing");
    const statement: unknown = JSON.parse(
      Buffer.from(raw.dsseEnvelope.payload, "base64").toString(),
    );
    if (!isDeepStrictEqual(verified.statement, statement))
      throw new Error("checkpoint verifier returned a different statement");
    if (verified.verifiedTimestamps.length > 8)
      throw new Error("checkpoint witnessed timestamp bound exceeded");
    const times = verified.verifiedTimestamps.map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        typeof entry.timestamp !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(entry.timestamp) ||
        !Number.isFinite(Date.parse(entry.timestamp))
      )
        throw new Error("checkpoint verifier supplied no supported witnessed time");
      return Date.parse(entry.timestamp);
    });
    phase = "historical-job";
    const producer = expected.producer;
    const job = verifyHistoricalCheckpointJob(
      expected.role,
      {
        controller_revision: producer.controller_revision,
        controller_ref: producer.controller_ref,
        actor_id: producer.actor_id,
        run_id: producer.run_id,
        run_attempt: producer.run_attempt,
        job_id: Number(producer.job_id),
        check_run_id: producer.check_run_id,
      },
      times[0]!,
      { cwd: capture, deadline, ...jobOptions },
    );
    if (
      times.some((time) => time < job.witnessed_interval.start || time > job.witnessed_interval.end)
    )
      throw new Error("checkpoint witnessed times differ from original job interval");
    phase = "capture-readback";
    if (
      !(await readControllerToolFile(subjectPath, 16384)).equals(original.subject) ||
      !(await readControllerToolFile(bundlePath, 65536)).equals(original.bundle)
    )
      throw new Error("checkpoint verification input custody changed");
    active();
    const receipt: AuthenticatedCheckpointEvidence = Object.freeze({
      kind: "authenticated-checkpoint-evidence",
      evidence_scope: scope,
      capture_directory: capture,
      authority: "none",
    });
    await writeFile(
      path.join(capture, "verification.json"),
      JSON.stringify({
        checkpoint: checkpoint.checkpoint,
        role: expected.role,
        producer,
        subject_sha256: hash(original.subject),
        bundle_sha256: hash(original.bundle),
        verified_timestamps: times,
        job,
        evidence_scope: scope,
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    active();
    receipts.set(receipt, {
      checkpoint: checkpoint.checkpoint,
      namespace: inspectCoordinatorRemoteNamespace(configuration),
      evidence: original,
      deadline,
      scope,
    });
    return receipt;
  } catch (error) {
    // Original bytes and bounded error stay private. Do not print a verifier's
    // diagnostics, which may include network/provider or credential material.
    await writeFile(
      path.join(capture, "failure.txt"),
      Buffer.from(String(error)).subarray(0, 4096),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(
      `checkpoint authentication refused during ${phase}; capture retained at ${capture}`,
    );
  }
}

/** Same-process provenance receipt only. Current controls/history-anchor checks
 * remain the owning controller's responsibility before any journal mutation. */
export function requireAuthenticatedCheckpointEvidence(
  receipt: AuthenticatedCheckpointEvidence,
  checkpoint: string,
  configuration: unknown,
) {
  const retained = receipts.get(receipt);
  if (
    !retained ||
    retained.scope !== "github.com" ||
    retained.checkpoint !== checkpoint ||
    retained.namespace !== inspectCoordinatorRemoteNamespace(configuration) ||
    performance.now() >= retained.deadline
  )
    throw new Error("actual current authenticated checkpoint evidence required");
  return {
    subject: Buffer.from(retained.evidence.subject),
    bundle: Buffer.from(retained.evidence.bundle),
  };
}
