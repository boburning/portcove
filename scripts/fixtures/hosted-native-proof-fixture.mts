/** Inert structural proof. No runtime, signature or provider evidence. */
import { createHash } from "node:crypto";
import { selectedPublicationAuthoritiesFixture } from "./checkpoint-proof-fixture.mts";
import { nativeQualificationFixture } from "./native-qualification-fixture.mts";
import {
  inspectNativeReleaseQualification,
  nativePrepublicationProfile,
  nativePrepublicationPending,
  nativePrepublicationScenarios,
  hostedWindowsContinuityPlatform,
} from "../release-native-qualification-contract.mts";
import {
  prepareHostedNativeStageRequest,
  serializeHostedNativeStageCapture,
} from "../release-native-stage-capture.mts";
import { prepareHostedNativeProofSubject } from "../release-hosted-native-proof-contract.mts";
import { releaseCanonicalDigest as digest } from "../release-canonical.mts";

export function hostedNativeProofFixture(
  platform: "windows-x86_64" | "linux-x86_64" = "windows-x86_64",
  stage: "payload-signing" | "release-publication" = "payload-signing",
  profile: "client-minimum" | "server-continuity" = "client-minimum",
) {
  const authorities = selectedPublicationAuthoritiesFixture("application");
  if (!("hosted_native" in authorities)) throw new Error("application fixture required");
  if (profile === "server-continuity") {
    if (platform !== "windows-x86_64") throw new Error("Windows fixture profile required");
    authorities.hosted_native[platform].minimum_platform = hostedWindowsContinuityPlatform;
  }
  const server = profile === "server-continuity";
  const windows = platform === "windows-x86_64",
    base = nativeQualificationFixture(stage),
    fixed = authorities.hosted_native[platform];
  const sourceFiles = {
    harness: Buffer.from("inert fixed native harness\n"),
    workflow: Buffer.from("inert held controller workflow\n"),
  };
  for (const profile of Object.values(authorities.hosted_native))
    profile.producer.harness.sha256 = createHash("sha256")
      .update(sourceFiles.harness)
      .digest("hex");
  const host = {
    machine_id_sha256: "a".repeat(64),
    qualification_profile: "fixed-hosted-native-v1",
    account: windows
      ? { kind: "windows-sid", broker: "S-1-5-21-1-2-3-1000", qualification: "S-1-5-21-1-2-3-1001" }
      : { kind: "linux-uid", broker: "1000", qualification: "1001" },
  };
  const report = inspectNativeReleaseQualification({
    ...base,
    schema_version: stage === "payload-signing" ? 1 : 2,
    platform_label: platform,
    candidate: {
      ...base.candidate,
      artifact_id: base.candidate.artifact_id + (windows ? 0 : 1),
      package: {
        ...base.candidate.package,
        filename: windows
          ? base.candidate.package.filename
          : "Portcove_0.1.0-beta.1_amd64.AppImage",
      },
    },
    ...(stage === "release-publication"
      ? {
          native_prepublication_profile: nativePrepublicationProfile,
          pending_obligations: [...nativePrepublicationPending],
          scenarios: nativePrepublicationScenarios.map((name, i) => ({
            ...base.scenarios[i],
            name,
          })),
        }
      : {}),
    producer: { ...base.producer, ...fixed.producer },
    host: {
      ...base.host,
      ...host,
      minimum_platform: fixed.minimum_platform,
      os_version: server ? "10.0.20348.1000" : windows ? "10.0.26200.1000" : "6.8.0-ubuntu-fixture",
      execution_context: "inert-hosted-proof-fixture",
      loaded_engine: {
        ...base.host.loaded_engine,
        name: fixed.engine.name,
        version: fixed.engine.minimum_version,
      },
    },
    compatibility: fixed.compatibility,
    runtime: {
      ...base.runtime,
      completed_at: "2026-10-20T12:00:06.000Z",
      root_creation: {
        kind: windows ? "windows-filetime" : "linux-starttime-ticks",
        value: windows ? "133000000000000000" : "5000",
      },
    },
  });
  const request = {
    schema_version: 1,
    stage,
    platform_label: platform,
    candidate: report.candidate,
    journey: report.journey,
    invocation_id: report.producer.invocation_id,
    setup_descriptor_sha256: authorities.journal.setup_plan_sha256,
  };
  const prepared = prepareHostedNativeStageRequest(request, authorities, host);
  const empty = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  const stream = (id: string, name: string) => ({
    path: `${id}.${name}.bin`,
    bytes: 0,
    sha256: empty,
  });
  const capture = serializeHostedNativeStageCapture(request, authorities, host, {
    schema_version: 1,
    request_sha256: prepared.request_sha256,
    outcome: "completed",
    started_at: report.runtime.started_at,
    completed_at: report.runtime.completed_at,
    harness: {
      ...fixed.producer.harness,
      exit_code: 0,
      stdout: stream("harness", "stdout"),
      stderr: stream("harness", "stderr"),
    },
    roots: [
      {
        id: "candidate",
        role: "candidate-package",
        image: {
          pid: report.runtime.root_pid,
          path: windows ? "C:\\owned\\candidate.exe" : "/owned/candidate.AppImage",
          sha256: report.candidate.package.sha256,
        },
        creation: report.runtime.root_creation,
        started_at: report.runtime.started_at,
        stdout: stream("candidate", "stdout"),
        stderr: stream("candidate", "stderr"),
        teardown: {
          root_pid: report.runtime.root_pid,
          root_creation: report.runtime.root_creation,
          root_exited: true,
          job_empty: true,
          remaining_pids: [],
          exit_code: 0,
          observed_at: report.runtime.completed_at,
        },
      },
    ],
    group: { empty: true, remaining_pids: [], observed_at: report.runtime.completed_at },
    scenarios: report.scenarios,
    failure: null,
  });
  report.runtime.capture_sha256 = capture.capture_sha256;
  report.runtime.teardown.capture_sha256 = capture.capture_sha256;
  const producer = {
    controller_revision: "a".repeat(40),
    controller_ref: "refs/tags/portcove-production-controller-fixture",
    actor_id: "1122",
    run_id: "9988",
    run_attempt: 1,
    job_id: windows ? 501 : 502,
    check_run_id: windows ? "777" : "778",
    configuration_sha256: digest(authorities),
    setup_sha256: authorities.journal.setup_plan_sha256,
    workflow_sha256: createHash("sha256").update(sourceFiles.workflow).digest("hex"),
    grant_sha256: "4".repeat(64),
  };
  const reportBytes = Buffer.from(JSON.stringify(report)),
    captureBytes = Buffer.from(capture.bytes);
  const hostObservation = {
    platform_label: platform,
    architecture: "x86_64",
    machine_id_sha256: report.host.machine_id_sha256,
    os: windows
      ? {
          product_type: server ? 3 : 1,
          caption: server ? "Microsoft Windows Server 2022 Datacenter" : "Microsoft Windows 11 Pro",
          display_version: server ? "21H2" : "26H2",
          version: report.host.os_version,
          build_number: server ? "20348" : "26200",
        }
      : { id: "ubuntu", version_id: "24.04", kernel_release: report.host.os_version },
  };
  const proof = prepareHostedNativeProofSubject(
    authorities,
    producer,
    reportBytes,
    captureBytes,
    hostObservation,
  );
  const bundle = Buffer.from(
    JSON.stringify({
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(proof.statement)).toString("base64"),
        signatures: [{ keyid: "inert", sig: "aW5lcnQ=" }],
      },
    }),
  );
  return {
    authorities,
    producer,
    report,
    capture,
    request,
    host,
    sourceFiles,
    hostObservation,
    files: { subject: proof.subject, report: reportBytes, capture: captureBytes, bundle },
  };
}
