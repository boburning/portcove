/** Historical attribution from already Tough-authenticated release records.
 * Journal custody and native signature/job verification remain separate. This
 * route never mints current native admission, signs or changes a journal ref. */
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-namespace.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { hydrateRetainedCoordinatorCheckpointExport } from "./release-coordinator-recovery.mts";
import { readCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-evidence.mts";
import {
  authenticateCoordinatorCheckpointEvidence,
  requireAuthenticatedCheckpointEvidence,
} from "./release-coordinator-checkpoint-authentication.mts";
import { inspectHostedNativeCustodyBundle } from "./release-hosted-native-proof-contract.mts";
import {
  collectHistoricalHostedNativeQualification,
  verifiedHistoricalHostedNativeQualification,
  collectHostedNativeReleaseQualification,
  verifiedHostedNativeReleaseQualification,
} from "./release-hosted-native-acceptance.mts";
import {
  requireControllerApplicationJobPublicationAuthorities,
  inspectSelectedPublicationAuthorityConfiguration,
} from "./release-authority-configuration.mts";
import { readProductionControllerWorkflowBytes } from "./production-controller-admission.mts";
import { createHash } from "node:crypto";
import {
  inspectNativeCheckpointLocator,
  nativeCheckpointEvidenceId,
} from "./release-native-checkpoint-custody.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";

type Custody = ReturnType<typeof inspectHostedNativeCustodyBundle>;

/** Selection only. The caller must obtain these records from the authenticated
 * Tough baseline and source from the original admitted consumer, never a report. */
export function selectHostedNativePredecessorScope(
  records: readonly unknown[],
  source: { run_id: unknown; run_attempt: unknown },
) {
  if (
    typeof source.run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(source.run_id) ||
    !Number.isSafeInteger(source.run_attempt) ||
    Number(source.run_attempt) < 1 ||
    ![1, 2].includes(records.length)
  )
    throw new Error("original native predecessor run/pair required");
  if (records.length === 1 && (!isRecord(records[0]) || records[0].target !== "windows-x86_64"))
    throw new Error("single-platform predecessor must be Windows x86-64");
  const platforms = new Set<unknown>();
  const current = records.map((record) => {
    if (
      !isRecord(record) ||
      !Array.isArray(record.evidence_ids) ||
      (record.target !== "windows-x86_64" && record.target !== "linux-x86_64") ||
      platforms.has(record.target)
    )
      throw new Error("native predecessor platform pair differs");
    platforms.add(record.target);
    const ids = record.evidence_ids.filter(
      (id: unknown) => typeof id === "string" && id.startsWith("native-job:"),
    );
    const id: unknown = ids[0];
    const match =
      typeof id === "string"
        ? /^native-job:([1-9][0-9]{0,15}):([1-9][0-9]{0,6}):([1-9][0-9]{0,15}):([1-9][0-9]{0,15}):([a-f0-9]{64})$/u.exec(
            id,
          )
        : null;
    if (ids.length !== 1 || !match) throw new Error("one exact native predecessor job required");
    // A different attempt of this same run is not current and cannot be mixed
    // into its original live job. Both foreign records retain historical rules.
    return match[1] === source.run_id && Number(match[2]) === source.run_attempt;
  });
  if (current[0] !== current[1])
    throw new Error("mixed current/historical native predecessors refused");
  return current[0] ? ("current-run" as const) : ("completed-history" as const);
}

type PredecessorConsumer = {
  source: {
    controller_revision: string;
    controller_ref: string;
    actor_id: string;
    run_id: string;
    run_attempt: number;
    authority_configuration_sha256: string;
    grant_sha256: string;
  };
  configuration: ReturnType<typeof inspectSelectedPublicationAuthorityConfiguration>;
  workflow_sha256: string;
};

async function currentHostedPredecessorSource(): Promise<PredecessorConsumer> {
  const view = await requireControllerApplicationJobPublicationAuthorities("release-publication");
  if (view.configuration.schema_version !== 4)
    throw new Error("selected current native predecessor source required");
  const configuration = inspectSelectedPublicationAuthorityConfiguration(view.configuration);
  if (configuration.purpose !== "application")
    throw new Error("current native predecessor application configuration required");
  const workflow = await readProductionControllerWorkflowBytes();
  if (!view.source.run_id) throw new Error("original predecessor run identity required");
  return {
    source: { ...view.source, run_id: view.source.run_id },
    configuration,
    workflow_sha256: createHash("sha256").update(workflow).digest("hex"),
  };
}
function checkpointPin(record: Record<string, unknown>) {
  if (!Array.isArray(record.evidence_ids)) throw new Error("historical native evidence missing");
  const matches = record.evidence_ids.filter(
    (value: unknown) => typeof value === "string" && value.startsWith("native-checkpoint:"),
  );
  if (matches.length !== 1 || typeof matches[0] !== "string")
    throw new Error("one Tough-pinned native checkpoint required");
  const match = /^native-checkpoint:([a-f0-9]{40}):([a-f0-9]{64}):([1-9][0-9]{0,6})$/u.exec(
    matches[0],
  );
  if (!match) throw new Error("historical native checkpoint pin differs");
  return inspectNativeCheckpointLocator({
    checkpoint: match[1],
    native_bundle_sha256: match[2],
    native_bundle_bytes: Number(match[3]),
  });
}

/** Integrity only. The owning caller establishes Tough authority; the actual
 * receiver below independently verifies the original signatures and jobs. */
export function inspectHostedNativePredecessorRecord(raw: unknown, custody: Custody) {
  const record: unknown = structuredClone(raw);
  if (
    !isRecord(record) ||
    !isRecord(record.artifact) ||
    !isRecord(record.qualified_run) ||
    !Array.isArray(record.evidence_ids)
  )
    throw new Error("authenticated historical record missing");
  const pin = checkpointPin(record);
  if (
    pin.native_bundle_sha256 !== custody.sha256 ||
    pin.native_bundle_bytes !== custody.bytes.length ||
    custody.stage !== "payload-signing"
  )
    throw new Error("historical native custody differs from Tough pin");
  const proofs = custody.proofs.filter((proof) => proof.report.platform_label === record.target);
  if (proofs.length !== 1) throw new Error("exact historical native platform missing");
  const proof = proofs[0]!,
    candidate = proof.report.candidate,
    producer = proof.producer;
  const expected = [
    nativeCheckpointEvidenceId(pin),
    `native-job:${producer.run_id}:${producer.run_attempt}:${producer.job_id}:${producer.check_run_id}:${proof.subject_sha256}`,
    `native-report:${proof.report_sha256}`,
    `native-capture:${proof.report.runtime.capture_sha256}`,
    `native-teardown:${proof.report.runtime.teardown.capture_sha256}`,
  ];
  for (const value of expected) {
    const prefix = value.slice(0, value.indexOf(":")) + ":";
    const values = record.evidence_ids.filter(
      (entry: unknown) => typeof entry === "string" && entry.startsWith(prefix),
    );
    if (values.length !== 1 || values[0] !== value)
      throw new Error("historical native job/report identity differs from Tough record");
  }
  if (
    record.evidence_ids.some(
      (entry: unknown) => typeof entry === "string" && entry.startsWith("native-check:"),
    ) ||
    candidate.source_commit !== record.source_commit ||
    candidate.source_tree !== record.source_tree ||
    String(candidate.run_id) !== String(record.qualified_run.run_id) ||
    candidate.run_attempt !== record.qualified_run.attempt ||
    record.qualified_run.workflow !== ".github/workflows/release.yml" ||
    record.qualified_run.workflow_commit !== candidate.source_commit ||
    candidate.package.bytes !== record.artifact.bytes ||
    candidate.package.sha256 !== record.artifact.sha256 ||
    typeof record.artifact.url !== "string" ||
    decodeURIComponent(new URL(record.artifact.url).pathname.split("/").at(-1) ?? "") !==
      candidate.package.filename
  )
    throw new Error("historical native candidate differs from authenticated package record");
  return { pin, proof, candidate };
}

/** The records are selected by the actual authenticated Tough baseline caller,
 * not from a supplied native report. No current authority/config is inferred
 * from an old job, and successful history cannot enter the current WeakMap. */
type PredecessorArguments = [
  parent: string,
  rawRecords: readonly unknown[],
  rawConfiguration: unknown,
  deadline: number,
  api: CoordinatorRemoteApi,
  options?: {
    checkpoint?: Parameters<typeof authenticateCoordinatorCheckpointEvidence>[6];
    native?: Parameters<typeof collectHistoricalHostedNativeQualification>[5];
  },
];

export function collectHistoricalHostedNativePredecessors(...args: PredecessorArguments) {
  return collectHostedNativePredecessors(undefined, ...args);
}

/** Select current-run stage custody or completed history from BOTH records and
 * the actual admitted consumer. No failed-current fallback or terminal credit.
 * Actual source is reacquired here; caller-supplied flags cannot appoint it. */
export function collectConfiguredHostedNativePredecessors(...args: PredecessorArguments) {
  return collectHostedNativePredecessors(currentHostedPredecessorSource, ...args);
}

/** Fixed native-job consumer. A caller cannot appoint a principal with serialized
 * configuration or a current-run flag. The original private parent supplies it. */
export function collectOriginalNativeParentPredecessors(
  parentReceipt: object,
  ...args: PredecessorArguments
) {
  const namespace = inspectCoordinatorRemoteNamespace(args[2]);
  const readCurrent = async (): Promise<PredecessorConsumer> => {
    const { requireActualHostedNativeParentSource } =
      await import("./release-hosted-native-parent.mts");
    const parent = await requireActualHostedNativeParentSource(parentReceipt);
    const configuration = inspectSelectedPublicationAuthorityConfiguration(parent.configuration);
    if (
      parent.stage !== "release-publication" ||
      configuration.purpose !== "application" ||
      configuration.journal.namespace !== namespace
    )
      throw new Error("original native post-sign predecessor consumer differs");
    const workflow = await readProductionControllerWorkflowBytes();
    parent.recheck();
    const workflowSha = createHash("sha256").update(workflow).digest("hex");
    if (workflowSha !== parent.producer.workflow_sha256)
      throw new Error("original native predecessor workflow changed");
    return {
      configuration,
      workflow_sha256: workflowSha,
      source: {
        ...parent.producer,
        authority_configuration_sha256: parent.producer.configuration_sha256,
      },
    };
  };
  return collectHostedNativePredecessors(readCurrent, ...args);
}

async function collectHostedNativePredecessors(
  readCurrent: (() => Promise<PredecessorConsumer>) | undefined,
  parent: string,
  rawRecords: readonly unknown[],
  rawConfiguration: unknown,
  deadline: number,
  api: CoordinatorRemoteApi,
  options: {
    checkpoint?: Parameters<typeof authenticateCoordinatorCheckpointEvidence>[6];
    native?: Parameters<typeof collectHistoricalHostedNativeQualification>[5];
  } = {},
) {
  const records = structuredClone(rawRecords),
    namespace = inspectCoordinatorRemoteNamespace(rawConfiguration);
  const configuration = { schema_version: 1, namespace };
  const checkpointOptions =
    options.checkpoint === undefined
      ? undefined
      : {
          ...options.checkpoint,
          ...(options.checkpoint.attestation
            ? {
                attestation: {
                  ...options.checkpoint.attestation,
                  ...(options.checkpoint.attestation.environment
                    ? { environment: { ...options.checkpoint.attestation.environment } }
                    : {}),
                },
              }
            : {}),
          ...(options.checkpoint.job
            ? {
                job: {
                  ...options.checkpoint.job,
                  ...(options.checkpoint.job.api
                    ? {
                        api: {
                          request: options.checkpoint.job.api.request.bind(
                            options.checkpoint.job.api,
                          ),
                        },
                      }
                    : {}),
                },
              }
            : {}),
        };
  const nativeOptions =
    options.native === undefined
      ? undefined
      : {
          ...options.native,
          ...(options.native.attestation
            ? {
                attestation: {
                  ...options.native.attestation,
                  ...(options.native.attestation.environment
                    ? { environment: { ...options.native.attestation.environment } }
                    : {}),
                },
              }
            : {}),
          ...(options.native.api
            ? { api: { request: options.native.api.request.bind(options.native.api) } }
            : {}),
        };
  const provider: CoordinatorRemoteApi = {
    request: api.request.bind(api),
    graphql: api.graphql.bind(api),
  };
  const active = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      throw new Error("historical native original deadline exhausted");
  };
  active();
  if (
    deadline - performance.now() > 120000 ||
    ![1, 2].includes(records.length) ||
    records.some(
      (record) => !isRecord(record) || Buffer.byteLength(JSON.stringify(record)) > 65536,
    ) ||
    new Set(records.map((record) => (isRecord(record) ? record.target : null))).size !==
      records.length
  )
    throw new Error("bounded historical native platform pair required");
  if (records.length === 1 && (!isRecord(records[0]) || records[0].target !== "windows-x86_64"))
    throw new Error("single-platform predecessor must be Windows x86-64");
  // Snapshot all supplied bytes/transports above before the first await.
  const originalConsumer = readCurrent ? await readCurrent() : undefined;
  active();
  const current =
    originalConsumer &&
    selectHostedNativePredecessorScope(records, originalConsumer.source) === "current-run"
      ? originalConsumer
      : undefined;
  const selected = records.map((record) => {
    if (!isRecord(record)) throw new Error("historical release record unavailable");
    return checkpointPin(record);
  });
  if (digest(selected[0]) !== digest(selected[1]))
    throw new Error("historical native carrier pair differs");
  const pin = selected[0]!;
  const environment = readOnlyReleaseChildEnvironment();
  if (!environment) throw new Error("isolated historical native reader required");
  if (
    !path.isAbsolute(parent) ||
    (await realpath(parent)) !== path.resolve(parent) ||
    !(await lstat(parent)).isDirectory()
  )
    throw new Error("canonical owned historical parent required");
  active();
  const directory = await mkdtemp(path.join(parent, "hosted-native-history-"));
  active();
  const repository = path.join(directory, "retained.git");
  let phase = "repository";
  try {
    execFileSync("git", ["-c", "init.templateDir=", "init", "--bare", "--quiet", repository], {
      env: {
        PATH: environment.PATH,
        SystemRoot: environment.SystemRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: Math.max(1, Math.min(10000, Math.floor(deadline - performance.now()))),
      windowsHide: true,
    });
    active();
    phase = "checkpoint-objects";
    return await withCoordinatorDeadline(deadline, async () => {
      const checkpoint = await hydrateRetainedCoordinatorCheckpointExport(
        repository,
        pin.checkpoint,
        { api: provider },
      );
      phase = "checkpoint-proof";
      const evidence = readCoordinatorCheckpointEvidence(
        checkpoint,
        configuration,
        provider,
        deadline,
      );
      const subject: unknown = JSON.parse(evidence.subject.toString("utf8"));
      if (!isRecord(subject) || subject.schema_version !== 2 || !isRecord(subject.producer))
        throw new Error("original native carrier has no exact v2 producer");
      const custody = inspectHostedNativeCustodyBundle(
        Buffer.from(JSON.stringify(subject.native_custody)),
      );
      if (custody.configuration.journal.namespace !== namespace)
        throw new Error("original native custody namespace differs");
      const assertCurrent = async () => {
        active();
        if (originalConsumer && digest(await readCurrent!()) !== digest(originalConsumer))
          throw new Error("current native predecessor consumer source changed");
        active();
      };
      if (current) {
        if (digest(custody.configuration) !== digest(current.configuration))
          throw new Error("current native predecessor full configuration differs");
        const expected = {
          controller_revision: current.source.controller_revision,
          controller_ref: current.source.controller_ref,
          actor_id: current.source.actor_id,
          run_id: current.source.run_id,
          run_attempt: current.source.run_attempt,
          configuration_sha256: current.source.authority_configuration_sha256,
          grant_sha256: current.source.grant_sha256,
          setup_sha256: current.configuration.journal.setup_plan_sha256,
          workflow_sha256: current.workflow_sha256,
        };
        for (const proof of custody.proofs) {
          const actual = Object.fromEntries(
            Object.keys(expected).map((key) => [
              key,
              proof.producer[key as keyof typeof proof.producer],
            ]),
          );
          if (digest(actual) !== digest(expected))
            throw new Error("current native predecessor original producer differs");
        }
      }
      phase = "record-association";
      const associated = records.map((record) =>
        inspectHostedNativePredecessorRecord(record, custody),
      );
      const rawProducer = subject.producer;
      const producer = {
        actor_id: String(rawProducer.actor_id),
        check_run_id: String(rawProducer.check_run_id),
        configuration_sha256: String(rawProducer.configuration_sha256),
        controller_ref: String(rawProducer.controller_ref),
        controller_revision: String(rawProducer.controller_revision),
        job_id: String(rawProducer.job_id),
        run_attempt: Number(rawProducer.run_attempt),
        run_id: String(rawProducer.run_id),
        setup_sha256: String(rawProducer.setup_sha256),
        workflow_sha256: String(rawProducer.workflow_sha256),
      };
      phase = "checkpoint-authentication";
      const authenticated = await authenticateCoordinatorCheckpointEvidence(
        directory,
        checkpoint,
        configuration,
        evidence,
        { role: "aggregate-assembly", producer },
        deadline,
        checkpointOptions,
      );
      let injected = authenticated.evidence_scope !== "github.com";
      phase = "original-native-authentication";
      const originals: object[] = [];
      for (const { proof, candidate } of associated) {
        const collect = current
          ? collectHostedNativeReleaseQualification
          : collectHistoricalHostedNativeQualification;
        const read = current
          ? verifiedHostedNativeReleaseQualification
          : verifiedHistoricalHostedNativeQualification;
        const original = await collect(
          directory,
          custody.configuration,
          {
            platform_label: proof.report.platform_label,
            stage: "payload-signing",
            candidate,
            journey: null,
            producer: proof.producer,
          },
          proof.files,
          deadline,
          nativeOptions,
        );
        injected ||= original.evidence_scope !== "github.com";
        const verified = await read(original);
        if (
          original.evidence_scope === "github.com" &&
          (!verified || digest(verified.candidate) !== digest(candidate))
        )
          throw new Error("original historical native private binding unavailable");
        originals.push(original);
        await assertCurrent();
        active();
      }
      requireAuthenticatedCheckpointEvidence(authenticated, pin.checkpoint, configuration);
      active();
      const result = Object.freeze({
        kind: current
          ? "verified-current-run-native-predecessors"
          : "verified-hosted-native-predecessors",
        evidence_scope: injected ? "injected-provider" : "github.com",
        capture_directory: directory,
        checkpoint: pin,
        checkpoint_object_reads: checkpoint.requests,
        checkpoint_proof_reads: evidence.requests,
        predecessors: associated.map(({ proof, candidate }) => ({
          platform_label: proof.report.platform_label,
          candidate,
        })),
        authority: "none",
        journey_completion: "not-established",
      });
      await writeFile(path.join(directory, "association.json"), JSON.stringify(result), {
        flag: "wx",
        mode: 0o600,
      });
      if (current) {
        for (const original of originals) {
          if (!injected && !(await verifiedHostedNativeReleaseQualification(original)))
            throw new Error("original current native predecessor expired before handoff");
          active();
        }
      }
      await assertCurrent();
      active();
      return result;
    });
  } catch {
    const failure = {
      phase,
      checkpoint: pin,
      directory,
      authority: "none",
      automatic_retry: false,
    };
    try {
      await writeFile(path.join(directory, "failure.json"), JSON.stringify(failure), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      /* Retain original partial objects even if evidence storage fails. */
    }
    throw new CoordinatorRemoteError(
      "historical native verification refused; retain original objects and captures",
      failure,
    );
  }
}
