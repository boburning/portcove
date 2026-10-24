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
  nativeCoordinatorCheckpointPredicateType,
  coordinatorCheckpointSubjectLimit,
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
import { readCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-evidence.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import {
  capacityExecutorJobProfile,
  capacityExecutorRolesForPurpose,
} from "./assembler-job-identity.mts";
import { inspectFixedJobJournalAuthorities } from "./release-authority-configuration.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { assessBoundedCapacity } from "./release-capacity.mts";

/** Authenticate one independently selected current head, not an ancestry walk.
 * Selected setup pins authorize only the exact empty seed. Every later head
 * must carry the existing signature plus actual fixed historical job binding.
 * This does not establish current ref ownership/protections or effect outcome. */
export async function authenticateFixedJobCoordinatorHistory(
  directory: string,
  rawCheckpoint: Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>,
  rawAuthorities: unknown,
  rawSource: { revision: string; execution_ref: string; workflow_sha256: string; actor_id: string },
  deadline: number,
  api: CoordinatorRemoteApi,
) {
  const checkpoint = structuredClone(rawCheckpoint);
  const authorities = inspectFixedJobJournalAuthorities(rawAuthorities);
  const source = structuredClone(rawSource);
  const configuration = { schema_version: 1, namespace: authorities.namespace };
  const active = () => {
    if (
      !Number.isFinite(deadline) ||
      deadline <= performance.now() ||
      deadline - performance.now() > 120000
    )
      throw new Error("selected history requires the original bounded deadline");
  };
  active();
  if (checkpoint.checkpoint === authorities.journal_seed.checkpoint) {
    const state: unknown = JSON.parse(checkpoint.blob.contents);
    const input = isRecord(state) && isRecord(state.input) ? state.input : null;
    const controller = input && isRecord(input.controller) ? input.controller : null;
    const capacity =
      controller && isRecord(controller.capacity_attempt) ? controller.capacity_attempt : null;
    if (
      checkpoint.previous !== null ||
      !input ||
      input.schema_version !== 2 ||
      input.active_candidate != null ||
      !capacity ||
      capacity.schema_version !== 2 ||
      (capacity &&
        (capacity.operation != null ||
          (Array.isArray(capacity.prior_operations) && capacity.prior_operations.length !== 0))) ||
      checkpoint.receipts.length !== 0 ||
      hash(Buffer.from(checkpoint.blob.contents)) !== authorities.journal_seed.state_sha256
    )
      throw new Error(
        "selected seed bytes/history/effects differ from independently ratified empty seed",
      );
    // Validate the existing contract without turning a supplied ratification or
    // a successful history read into positive capacity/current admission.
    assessBoundedCapacity(capacity);
    return {
      kind: "ratified-initial-seed" as const,
      checkpoint: checkpoint.checkpoint,
      authority: "none" as const,
    };
  }
  if (checkpoint.previous === null) throw new Error("unratified initial journal head");
  const evidence = readCoordinatorCheckpointEvidence(checkpoint, configuration, api, deadline);
  const subject: unknown = JSON.parse(evidence.subject.toString("utf8"));
  const producer = isRecord(subject) && isRecord(subject.producer) ? subject.producer : null;
  if (
    !producer ||
    producer.controller_revision !== source.revision ||
    producer.controller_ref !== source.execution_ref ||
    producer.workflow_sha256 !== source.workflow_sha256 ||
    producer.actor_id !== source.actor_id ||
    producer.configuration_sha256 !== releaseCanonicalDigest(authorities) ||
    producer.setup_sha256 !== authorities.setup_plan_sha256 ||
    producer.run_attempt !== 1
  )
    throw new Error(
      "retained checkpoint source/setup/configuration differs from selected authority",
    );
  active();
  const response = api.request(
    "GET",
    `repos/boburning/portcove/actions/jobs/${String(producer.job_id)}`,
  );
  active();
  const job = response.body;
  // Application/catalog share this same journal and site cursor. Authenticate
  // past custody across both fixed job sets; current operating authority stays
  // separately bound to its app/catalog policy in the private executor.
  const roles = [
    ...new Set([
      ...capacityExecutorRolesForPurpose("application"),
      ...capacityExecutorRolesForPurpose("catalog-publication"),
    ]),
  ].filter((role) => isRecord(job) && job.name === capacityExecutorJobProfile(role).job);
  if (response.status !== 200 || roles.length !== 1)
    throw new Error("retained checkpoint has no unique allowed historical job role");
  // The lookup selects a closed role, never accepts it. The existing verifier
  // independently reads the exact original attempt/job/check and signature.
  const selected = {
    role: roles[0]!,
    producer: {
      controller_revision: String(producer.controller_revision),
      controller_ref: String(producer.controller_ref),
      workflow_sha256: String(producer.workflow_sha256),
      actor_id: String(producer.actor_id),
      configuration_sha256: String(producer.configuration_sha256),
      setup_sha256: String(producer.setup_sha256),
      job_id: String(producer.job_id),
      check_run_id: String(producer.check_run_id),
      run_id: String(producer.run_id),
      run_attempt: Number(producer.run_attempt),
    },
  };
  const authenticated = await authenticateCoordinatorCheckpointEvidence(
    directory,
    checkpoint,
    configuration,
    evidence,
    selected,
    deadline,
  );
  requireAuthenticatedCheckpointEvidence(authenticated, checkpoint.checkpoint, configuration);
  active();
  return {
    kind: "authenticated-retained-checkpoint" as const,
    checkpoint: checkpoint.checkpoint,
    authenticated,
    authority: "none" as const,
  };
}

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
    rawEvidence.subject.length > coordinatorCheckpointSubjectLimit ||
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
  const parsedSubject: unknown = JSON.parse(evidence.subject.toString("utf8"));
  const native =
    isRecord(parsedSubject) && parsedSubject.schema_version === 2
      ? parsedSubject.native_custody
      : undefined;
  const selected = coordinatorCheckpointEvidenceSubject(
    checkpoint,
    configuration,
    expected.producer,
    native,
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
      native === undefined
        ? coordinatorCheckpointPredicateType
        : nativeCoordinatorCheckpointPredicateType,
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
      !(
        await readControllerToolFile(
          subjectPath,
          native === undefined ? 16384 : coordinatorCheckpointSubjectLimit,
        )
      ).equals(original.subject) ||
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
