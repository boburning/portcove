/** Closed wire custody only. Parsing or preparing these bytes grants no job,
 * native, signature, archival, execution or publication authority. */
import { inspectHostedWindowsOperatingSystem } from "./release-hosted-native-windows-host.mts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectSelectedPublicationAuthorityConfiguration } from "./release-authority-configuration.mts";
import {
  inspectNativeReleaseQualification,
  hostedWindowsContinuityPlatform,
} from "./release-native-qualification-contract.mts";
import { serializeHostedNativeStageCapture } from "./release-native-stage-capture.mts";
import {
  hostedNativeJobProfile,
  controllerOidcSubject,
  inspectAssemblerIdentityExpectation,
} from "./assembler-job-identity.mts";

export const hostedNativePredicateType =
  "https://portcove.dev/attestations/hosted-native-qualification/v1";
export const hostedNativeProofLimits = Object.freeze({
  subject: 16384,
  report: 65536,
  capture: 131073,
  bundle: 65536,
  custody: 1048576,
});
export type HostedNativeProofFiles = {
  subject: Buffer;
  report: Buffer;
  capture: Buffer;
  bundle: Buffer;
};
const hash = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
function atLeast(raw: string, floor: string) {
  const numbers = (value: string) => {
    if (!/^[0-9]{1,10}(?:\.[0-9]{1,10}){1,3}$/u.test(value))
      throw new Error("hosted native observed version unavailable");
    return value.split(".").map(BigInt);
  };
  const actual = numbers(raw),
    minimum = numbers(floor);
  for (let i = 0; i < 4; i++) {
    if ((actual[i] ?? 0n) < (minimum[i] ?? 0n)) return false;
    if ((actual[i] ?? 0n) > (minimum[i] ?? 0n)) return true;
  }
  return true;
}
function hostIdentity(
  raw: unknown,
  report: ReturnType<typeof inspectNativeReleaseQualification>,
  selectedPlatform: string,
) {
  exact(raw, "architecture,machine_id_sha256,os,platform_label");
  if (
    raw.architecture !== "x86_64" ||
    raw.platform_label !== report.platform_label ||
    raw.machine_id_sha256 !== report.host.machine_id_sha256
  )
    throw new Error("hosted native observed host identity differs");
  const os = raw.os;
  if (report.platform_label === "windows-x86_64") {
    exact(os, "build_number,caption,display_version,product_type,version");
    try {
      inspectHostedWindowsOperatingSystem(
        os,
        selectedPlatform as "windows-11-26h2-x64" | typeof hostedWindowsContinuityPlatform,
        report.host.os_version,
        report.compatibility.minimum_os_version,
      );
    } catch (cause) {
      throw new Error(
        selectedPlatform === hostedWindowsContinuityPlatform
          ? "hosted native actual Windows Server continuity observation differs"
          : "hosted native actual Windows client/minimum observation differs",
        { cause },
      );
    }
  } else {
    exact(os, "id,kernel_release,version_id");
    if (
      os.id !== "ubuntu" ||
      os.version_id !== "24.04" ||
      typeof os.kernel_release !== "string" ||
      !/^[0-9][A-Za-z0-9.+_-]{1,127}$/u.test(os.kernel_release) ||
      os.kernel_release !== report.host.os_version ||
      !atLeast(os.version_id, report.compatibility.minimum_os_version)
    )
      throw new Error("hosted native actual Ubuntu/minimum observation differs");
  }
  return structuredClone(raw);
}
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("hosted native proof exact schema differs");
}
function sha(raw: unknown) {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/u.test(raw))
    throw new Error("hosted native proof digest differs");
  return raw;
}
function json(bytes: Buffer) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
function bounded(raw: Buffer, maximum: number) {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > maximum)
    throw new Error("hosted native proof file exceeds bound");
  return Buffer.from(raw);
}
function identity(bytes: Buffer) {
  return { bytes: bytes.length, sha256: hash(bytes) };
}

export function inspectHostedNativeProducer(
  raw: unknown,
  platform: "windows-x86_64" | "linux-x86_64",
) {
  exact(
    raw,
    "actor_id,check_run_id,configuration_sha256,controller_ref,controller_revision,grant_sha256,job_id,run_attempt,run_id,setup_sha256,workflow_sha256",
  );
  const profile = hostedNativeJobProfile(platform);
  const expected = inspectAssemblerIdentityExpectation({
    controller_revision: raw.controller_revision,
    controller_ref: raw.controller_ref,
    actor_id: raw.actor_id,
    run_id: raw.run_id,
    run_attempt: raw.run_attempt,
    audience: profile.audience,
    subject: controllerOidcSubject(String(raw.controller_ref), profile.environment),
  });
  if (
    raw.run_attempt !== 1 ||
    !Number.isSafeInteger(raw.job_id) ||
    Number(raw.job_id) < 1 ||
    typeof raw.check_run_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(raw.check_run_id)
  )
    throw new Error("hosted native original job/attempt identity differs");
  return {
    controller_revision: expected.controller_revision,
    controller_ref: expected.controller_ref,
    actor_id: expected.actor_id,
    run_id: expected.run_id,
    run_attempt: expected.run_attempt,
    job_id: Number(raw.job_id),
    check_run_id: raw.check_run_id,
    configuration_sha256: sha(raw.configuration_sha256),
    setup_sha256: sha(raw.setup_sha256),
    workflow_sha256: sha(raw.workflow_sha256),
    grant_sha256: sha(raw.grant_sha256),
  };
}

/** Exact file manifest before signing. The fixed parent separately requires its
 * direct-capture receipt and live authenticated job before invoking its signer. */
export function prepareHostedNativeProofSubject(
  rawAuthorities: unknown,
  rawProducer: unknown,
  rawReport: Buffer,
  rawCapture: Buffer,
  rawHostObservation: unknown,
) {
  const reportBytes = bounded(rawReport, hostedNativeProofLimits.report);
  const captureBytes = bounded(rawCapture, hostedNativeProofLimits.capture);
  const report = inspectNativeReleaseQualification(json(reportBytes));
  const authorities = inspectSelectedPublicationAuthorityConfiguration(rawAuthorities);
  if (authorities.purpose !== "application")
    throw new Error("hosted native application authority required");
  const producer = inspectHostedNativeProducer(rawProducer, report.platform_label);
  const fixed = authorities.hosted_native[report.platform_label];
  const hostObservation = hostIdentity(rawHostObservation, report, fixed.minimum_platform);
  const continuityOnly = fixed.minimum_platform === hostedWindowsContinuityPlatform;
  const { invocation_id: _invocation, started_at: _started, ...actualProducer } = report.producer;
  if (
    producer.configuration_sha256 !== digest(authorities) ||
    producer.setup_sha256 !== authorities.journal.setup_plan_sha256 ||
    !isDeepStrictEqual(actualProducer, fixed.producer) ||
    !isDeepStrictEqual(report.compatibility, fixed.compatibility) ||
    report.host.qualification_profile !== "fixed-hosted-native-v1" ||
    report.host.minimum_platform !== fixed.minimum_platform ||
    report.host.loaded_engine.name !== fixed.engine.name ||
    report.schema_version !== (report.stage === "payload-signing" ? 1 : 2)
  )
    throw new Error("hosted native report differs from selected configuration/source/stage");
  if (!atLeast(report.host.loaded_engine.version, fixed.engine.minimum_version))
    throw new Error("hosted native loaded engine below minimum");
  const capture = json(captureBytes);
  if (!isRecord(capture) || capture.authority !== "none" || capture.scope !== "integrity-only")
    throw new Error("hosted native retained structured capture required");
  const { authority: _authority, scope: _scope, ...rawCaptureData } = capture;
  const reconstructed = serializeHostedNativeStageCapture(
    {
      schema_version: 1,
      stage: report.stage,
      platform_label: report.platform_label,
      candidate: report.candidate,
      journey: report.journey,
      invocation_id: report.producer.invocation_id,
      setup_descriptor_sha256: producer.setup_sha256,
    },
    authorities,
    {
      machine_id_sha256: report.host.machine_id_sha256,
      qualification_profile: report.host.qualification_profile,
      account: report.host.account,
    },
    rawCaptureData,
  );
  const roots = reconstructed.capture.roots.filter(
    (root) =>
      root.role !== "profile-keeper" &&
      root.image.pid === report.runtime.root_pid &&
      isDeepStrictEqual(root.creation, report.runtime.root_creation),
  );
  const first = roots.length === 1 ? roots[0] : undefined,
    group = reconstructed.capture.group;
  if (
    reconstructed.capture.outcome !== "completed" ||
    !isDeepStrictEqual(capture, reconstructed.capture) ||
    !isDeepStrictEqual(report.scenarios, reconstructed.capture.scenarios) ||
    report.runtime.capture_sha256 !== reconstructed.capture_sha256 ||
    report.runtime.teardown.capture_sha256 !== reconstructed.capture_sha256 ||
    !first ||
    !group ||
    report.runtime.root_pid !== first.image.pid ||
    !isDeepStrictEqual(report.runtime.root_creation, first.creation) ||
    report.runtime.started_at !== first.started_at ||
    report.runtime.completed_at !== group.observed_at ||
    report.runtime.teardown.completed_at !== group.observed_at
  )
    throw new Error("hosted native report does not bind exact capture/settlement");
  const subject = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      purpose: continuityOnly ? "hosted-native-continuity" : "hosted-native-qualification",
      platform_label: report.platform_label,
      stage: report.stage,
      producer,
      host_observation: hostObservation,
      files: { report: identity(reportBytes), capture: identity(captureBytes) },
    }),
  );
  bounded(subject, hostedNativeProofLimits.subject);
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "portcove-hosted-native-qualification", digest: { sha256: hash(subject) } }],
    predicateType: hostedNativePredicateType,
    predicate: { schema_version: 1, native_subject_sha256: hash(subject), producer },
  };
  return {
    subject,
    statement,
    report,
    capture: reconstructed.capture,
    producer,
    qualification_scope: continuityOnly ? ("continuity-only" as const) : ("native-stage" as const),
    authority: "none" as const,
  };
}

export function inspectHostedNativeProofFiles(
  raw: HostedNativeProofFiles,
  authorities: unknown,
  expectedProducer: unknown,
) {
  const files = Object.fromEntries(
    (["subject", "report", "capture", "bundle"] as const).map((key) => [
      key,
      bounded(raw[key], hostedNativeProofLimits[key]),
    ]),
  ) as HostedNativeProofFiles;
  const prepared = prepareHostedNativeProofSubject(
    authorities,
    expectedProducer,
    files.report,
    files.capture,
    (() => {
      const subject = json(files.subject);
      if (!isRecord(subject)) throw new Error("hosted native observed host missing");
      return subject.host_observation;
    })(),
  );
  if (!files.subject.equals(prepared.subject))
    throw new Error("hosted native expected manifest differs");
  const bundle = json(files.bundle);
  const envelope = isRecord(bundle) ? bundle.dsseEnvelope : null;
  if (
    !isRecord(envelope) ||
    envelope.payloadType !== "application/vnd.in-toto+json" ||
    typeof envelope.payload !== "string" ||
    envelope.payload.length > 32768 ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length !== 1
  )
    throw new Error("hosted native bounded original DSSE envelope required");
  const payload = Buffer.from(envelope.payload, "base64");
  if (
    payload.toString("base64") !== envelope.payload ||
    !isDeepStrictEqual(json(payload), prepared.statement)
  )
    throw new Error("hosted native attested subject differs");
  return {
    ...prepared,
    files,
    subject_sha256: hash(files.subject),
    report_sha256: digest(prepared.report),
    signature_verification: "not-performed" as const,
  };
}

/** Closed public transport identities, not proof bytes or acceptance. Used by
 * signing-context handoffs so selected job IDs cannot masquerade as App Checks. */
export function inspectHostedNativeTransportIdentities(raw: unknown) {
  const entries: unknown = structuredClone(raw);
  if (
    !Array.isArray(entries) ||
    entries.length !== 2 ||
    Buffer.byteLength(JSON.stringify(entries)) > 16384
  )
    throw new Error("hosted native transport requires the bounded platform pair");
  const result = entries.map((entry: unknown) => {
    exact(entry, "hosted_job,platform,report_sha256,transport");
    if (
      entry.transport !== "fixed-hosted-job" ||
      (entry.platform !== "windows-x86_64" && entry.platform !== "linux-x86_64")
    )
      throw new Error("hosted native transport platform differs");
    exact(
      entry.hosted_job,
      "actor_id,bundle_sha256,check_run_id,configuration_sha256,controller_ref,controller_revision,grant_sha256,job_id,report_sha256,run_attempt,run_id,setup_sha256,subject_sha256,workflow_sha256",
    );
    const { bundle_sha256, report_sha256, subject_sha256, ...producer } = entry.hosted_job;
    const observed = inspectHostedNativeProducer(producer, entry.platform);
    if (sha(entry.report_sha256) !== sha(report_sha256))
      throw new Error("hosted native transport report digest differs");
    return {
      platform: entry.platform,
      transport: "fixed-hosted-job" as const,
      hosted_job: {
        ...observed,
        bundle_sha256: sha(bundle_sha256),
        report_sha256: sha(report_sha256),
        subject_sha256: sha(subject_sha256),
      },
      report_sha256: sha(report_sha256),
    };
  });
  if (new Set(result.map((entry) => entry.platform)).size !== 2)
    throw new Error("hosted native transport platform duplicated");
  return result;
}

/** Exact original bytes for existing checkpoint custody. This parser performs
 * no signature verification or historical admission and never grants a brand. */
export function inspectHostedNativeCustodyBundle(raw: Buffer) {
  const bytes = bounded(raw, hostedNativeProofLimits.custody);
  const value = json(bytes);
  exact(value, "configuration,proofs,purpose,schema_version,stage");
  if (
    value.schema_version !== 1 ||
    value.purpose !== "hosted-native-custody" ||
    !["payload-signing", "release-publication"].includes(String(value.stage)) ||
    !Array.isArray(value.proofs) ||
    value.proofs.length !== 2
  )
    throw new Error("hosted native custody complete bounded pair required");
  const configuration = inspectSelectedPublicationAuthorityConfiguration(value.configuration);
  if (configuration.purpose !== "application")
    throw new Error("hosted native custody application required");
  const proofs = value.proofs.map((rawEntry: unknown) => {
    exact(rawEntry, "files,platform_label,producer");
    exact(rawEntry.files, "bundle,capture,report,subject");
    const files = {} as HostedNativeProofFiles;
    for (const key of ["subject", "report", "capture", "bundle"] as const) {
      const encoded = rawEntry.files[key];
      if (
        typeof encoded !== "string" ||
        encoded.length > Math.ceil(hostedNativeProofLimits[key] / 3) * 4
      )
        throw new Error("hosted native custody member exceeds fixed bound");
      files[key] = Buffer.from(encoded, "base64");
      if (files[key].toString("base64") !== encoded)
        throw new Error("hosted native custody base64 differs");
    }
    const prepared = inspectHostedNativeProofFiles(files, configuration, rawEntry.producer);
    if (
      prepared.report.platform_label !== rawEntry.platform_label ||
      prepared.report.stage !== value.stage
    )
      throw new Error("hosted native custody stage or platform differs");
    return prepared;
  });
  if (
    proofs.map((proof) => proof.report.platform_label).join(",") !==
      "linux-x86_64,windows-x86_64" ||
    new Set(proofs.map((proof) => proof.report.candidate.artifact_id)).size !== 2 ||
    new Set(proofs.map((proof) => proof.producer.job_id)).size !== 2 ||
    new Set(proofs.map((proof) => proof.producer.check_run_id)).size !== 2
  )
    throw new Error("hosted native custody pair is unordered or duplicated");
  const common = (proof: (typeof proofs)[number]) => {
    const { artifact_id: _artifact, package: _package, ...candidate } = proof.report.candidate;
    const {
      run_id: _run,
      run_attempt: _attempt,
      job_id: _job,
      check_run_id: _check,
      ...producer
    } = proof.producer;
    return { candidate, producer };
  };
  if (!isDeepStrictEqual(common(proofs[0]!), common(proofs[1]!)))
    throw new Error("hosted native custody source, candidate or authority pair differs");
  const canonical = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      purpose: "hosted-native-custody",
      configuration,
      stage: value.stage,
      proofs: proofs.map((proof) => ({
        platform_label: proof.report.platform_label,
        producer: proof.producer,
        files: Object.fromEntries(
          (["subject", "report", "capture", "bundle"] as const).map((key) => [
            key,
            proof.files[key].toString("base64"),
          ]),
        ),
      })),
    }),
  );
  if (!canonical.equals(bytes)) throw new Error("hosted native custody canonical bytes differ");
  return {
    bytes,
    sha256: hash(bytes),
    stage: value.stage,
    configuration,
    proofs,
    authority: "none" as const,
    signature_verification: "not-performed" as const,
  };
}
