/** Native pre-key joins reuse the maintained capture and report reconstruction.
 * These byte inspectors grant no authority; the receiver authenticates the
 * fixed Actions producer and exact artifact before admitting any key use. */
import assert from "node:assert/strict";
import path from "node:path";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectNativeReleaseQualification,
  hostedWindowsContinuityPlatform,
  nativeQualificationWorkerPath,
  nativeQualificationScenarios,
  inspectNativeQualificationAccount,
} from "./release-native-qualification-contract.mts";
import { inspectHostedWindowsOperatingSystem } from "./release-hosted-native-windows-host.mts";
import { serializeApplicationPreSignCapture } from "./release-native-stage-capture.mts";
import type { NativeStageRequest } from "./release-native-stage-capture.mts";
import { reconstructHostedNativeWindowsPreSignReport } from "./release-native-pre-sign-report.mts";
import type { inspectNativeCompatibilitySources } from "./release-native-source-contract.mts";

export function inspectApplicationPublicInstalledJourney(
  installer: unknown,
  journey: unknown,
  expected: {
    invocation: string;
    harness_sha256: string;
    prior_version: string;
    candidate_version: string;
    candidate_executable_sha256: string;
  },
) {
  assert.ok(isRecord(installer) && installer.phase === "complete" && isRecord(installer.details));
  assert.equal(installer.details.uninstall_exit_code, 0);
  assert.equal(installer.details.managed_files_removed, true);
  assert.equal(installer.details.registration_removed, true);
  assert.equal(installer.details.persistent_data_preserved, true);
  const before = installer.details.preservation_manifest_before_uninstall;
  assert.ok(isRecord(before) && Array.isArray(before.library) && before.library.length > 0);
  assert.deepEqual(before, installer.details.preservation_manifest_after_uninstall);
  assert.ok(isRecord(installer.details.isolated_account_boundary));
  assert.equal(
    installer.details.isolated_account_boundary.native_invocation_id,
    expected.invocation,
  );
  assert.equal(
    installer.details.isolated_account_boundary.installed_executable_sha256,
    expected.candidate_executable_sha256,
  );
  assert.ok(isRecord(journey) && journey.schema_version === 1 && journey.authority === "none");
  assert.equal(journey.native_acceptance, "not-established");
  assert.ok(isRecord(journey.harness));
  assert.equal(journey.harness.sha256, expected.harness_sha256);
  assert.ok(Array.isArray(journey.recovery_cases));
  assert.deepEqual(
    journey.recovery_cases
      .map((item: unknown) => {
        assert.ok(isRecord(item) && typeof item.area === "string");
        return item.area;
      })
      .sort(),
    ["apply", "schedule", "staging"],
  );
  assert.equal(journey.phase, "initial-v0-v1");
  assert.equal(journey.outcome, "observed");
  assert.ok(
    isRecord(journey.user_state) &&
      isRecord(journey.user_state.before) &&
      isRecord(journey.user_state.after),
  );
  assert.equal(journey.user_state.before.application_version, expected.prior_version);
  assert.equal(journey.user_state.after.application_version, expected.candidate_version);
  const preservation = installer.details.journey_profile_preservation;
  assert.ok(isRecord(preservation) && isRecord(journey.profile));
  const normalized = (value: unknown) => {
    assert.ok(typeof value === "string" && /^[a-z]:[\\/]/iu.test(value));
    return path.win32.resolve(value).toLowerCase();
  };
  const library = normalized(preservation.library_root);
  const preferences = normalized(preservation.preferences_path);
  assert.equal(path.win32.basename(library), "library");
  assert.equal(preferences, path.win32.join(path.win32.dirname(library), "preferences.json"));
  assert.equal(library, normalized(journey.profile.library_root));
  assert.equal(library, normalized(journey.user_state.before.library_root));
  assert.equal(library, normalized(journey.user_state.after.library_root));
  assert.equal(preferences, normalized(journey.profile.preferences_path));
  const profile = preservation.before;
  assert.ok(isRecord(profile) && Array.isArray(profile.library) && isRecord(profile.preferences));
  assert.deepEqual(profile, preservation.after);
  assert.ok(
    profile.library.some(
      (entry: unknown) =>
        isRecord(entry) &&
        entry.path === "portcove.sqlite3" &&
        entry.type === "file" &&
        typeof entry.bytes === "number" &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes > 0 &&
        typeof entry.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(entry.sha256),
    ),
  );
  if (profile.preferences.present === true) {
    assert.ok(
      typeof profile.preferences.bytes === "number" &&
        Number.isSafeInteger(profile.preferences.bytes) &&
        profile.preferences.bytes > 0,
    );
    assert.ok(
      typeof profile.preferences.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(profile.preferences.sha256),
    );
  } else {
    assert.deepEqual(profile.preferences, { present: false, bytes: null, sha256: null });
  }

  assert.ok(
    isRecord(journey.automatic_relaunch) && isRecord(journey.automatic_relaunch.executable),
  );
  assert.equal(journey.automatic_relaunch.executable.sha256, expected.candidate_executable_sha256);
  assert.equal(journey.automatic_relaunch.title, "Portcove");
}

export function inspectApplicationPublicInstalledProducer(
  raw: unknown,
  expected: { run_id: string; run_attempt: number; source: string },
) {
  assert.ok(isRecord(raw) && Array.isArray(raw.jobs) && raw.jobs.length < 100);
  assert.equal(raw.total_count, raw.jobs.length);
  const selected = raw.jobs.filter(
    (job: unknown) => isRecord(job) && job.name === "public_installed",
  );
  assert.equal(selected.length, 1);
  const job: unknown = selected[0];
  assert.ok(isRecord(job) && job.status === "completed" && job.conclusion === "success");
  assert.equal(job.run_id, Number(expected.run_id));
  assert.equal(job.run_attempt, expected.run_attempt);
  assert.equal(job.head_sha, expected.source);
  assert.ok(typeof job.id === "number" && Number.isSafeInteger(job.id) && job.id > 0);
  assert.ok(
    typeof job.runner_id === "number" && Number.isSafeInteger(job.runner_id) && job.runner_id > 0,
  );
  assert.ok(Array.isArray(job.labels) && job.labels.includes("windows-2022"));
  assert.ok(typeof job.started_at === "string" && typeof job.completed_at === "string");
  const started = Date.parse(job.started_at),
    completed = Date.parse(job.completed_at);
  assert.ok(Number.isFinite(started) && completed >= started && completed - started <= 15 * 60_000);
  return { job_id: job.id, started, completed };
}

export function inspectApplicationPublicInstalledProof(
  raw: unknown,
  installer: unknown,
  journey: unknown,
  expected: {
    source: string;
    ref: string;
    run_id: string;
    run_attempt: number;
    producer: ReturnType<typeof inspectApplicationPublicInstalledProducer>;
    candidate: unknown;
    harness_sha256: string;
    inputs: Omit<
      Parameters<typeof inspectApplicationPublicInstalledJourney>[2],
      "invocation" | "harness_sha256"
    > & {
      prior_installer_sha256: string;
      candidate_installer_sha256: string;
    };
    inputs_sha256: string;
    minimum: Minimum;
  },
) {
  assert.ok(isRecord(raw));
  assert.equal(
    Object.keys(raw).sort().join(","),
    "authority,candidate,completed_at,control_commit,control_ref,host,inputs,inputs_sha256,installer_sha256,invocation,journey_sha256,kind,owner_teardown,run_attempt,run_id,schema_version,stage_settlement,started_at",
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.kind, "application-public-installed-observation");
  assert.equal(raw.authority, "none");
  assert.equal(raw.control_commit, expected.source);
  assert.equal(raw.control_ref, expected.ref);
  assert.equal(raw.run_id, expected.run_id);
  assert.equal(raw.run_attempt, expected.run_attempt);
  assert.deepEqual(raw.candidate, expected.candidate);
  assert.deepEqual(raw.inputs, expected.inputs);
  assert.equal(raw.inputs_sha256, expected.inputs_sha256);
  assert.equal(raw.installer_sha256, digest(installer));
  assert.equal(raw.journey_sha256, digest(journey));
  assert.ok(typeof raw.started_at === "string" && typeof raw.completed_at === "string");
  const started = Date.parse(raw.started_at),
    completed = Date.parse(raw.completed_at);
  assert.ok(
    started >= expected.producer.started &&
      completed >= started &&
      completed <= expected.producer.completed + 999,
    "proof is outside the actual hosted job",
  );
  const host = inspectApplicationNativeHost(raw.host, expected.minimum);
  assert.ok(typeof raw.invocation === "string" && /^[a-f0-9]{64}$/u.test(raw.invocation));
  const teardown = raw.owner_teardown,
    settlement = raw.stage_settlement;
  assert.ok(isRecord(teardown) && isRecord(settlement));
  assert.equal(teardown.authority, "none");
  assert.equal(teardown.binding, host.nonce);
  assert.equal(teardown.failure, "");
  assert.deepEqual(teardown.cleanup_failures, []);
  assert.equal(teardown.credential_disposed, true);
  assert.ok(
    typeof teardown.owner_pid === "number" &&
      Number.isSafeInteger(teardown.owner_pid) &&
      teardown.owner_pid > 0,
  );
  assert.equal(settlement.authority, "none");
  assert.equal(settlement.stage, "ordinary-public-initial");
  assert.equal(settlement.binding, host.nonce);
  assert.equal(settlement.account_sid, host.account.qualification);
  assert.equal(settlement.disabled, true);
  assert.equal(settlement.station_restored, true);
  assert.equal(settlement.group_empty, true);
  assert.equal(settlement.harness_exit_code, 0);
  assert.equal(settlement.harness_drained, true);
  assert.deepEqual(settlement.broker_job_remaining_pids, [teardown.owner_pid]);
  inspectApplicationPublicInstalledJourney(installer, journey, {
    ...expected.inputs,
    invocation: raw.invocation,
    harness_sha256: expected.harness_sha256,
  });
  return {
    job_id: expected.producer.job_id,
    run_attempt: expected.run_attempt,
    invocation: raw.invocation,
    authority: "none" as const,
  };
}

export const applicationNativeHarness = nativeQualificationWorkerPath;
export const applicationNativeFiles = [
  "native-qualification.json",
  "native-capture.json",
  "native-evidence.json",
] as const;
export const applicationNativeJobName = "native / execute";
export const applicationNativeExecutionMinutes = 33;

/** Attesting retained observations never changes their original execution.
 * Only the attested artifact name and provenance use the fresh attempt. */
export function inspectApplicationNativeAttempts(
  native: number,
  attestation: number,
  current: number,
) {
  assert.ok(Number.isSafeInteger(current) && current >= 1 && current <= 3);
  assert.ok(Number.isSafeInteger(native) && native >= 1 && native <= current);
  assert.ok(Number.isSafeInteger(attestation) && attestation >= native && attestation <= current);
  return { native_attempt: native, attestation_attempt: attestation };
}
type Minimum = "windows-11-26h2-x64" | typeof hostedWindowsContinuityPlatform;
export type ApplicationNativeHost = {
  machine_id_sha256: string;
  nonce: string;
  account_binding_sha256: string;
  qualification_profile: "fixed-hosted-native-v1";
  execution_context: string;
  account: { kind: "windows-sid"; broker: string; qualification: string };
  os: {
    caption: string;
    version: string;
    display_version: string;
    product_type: number;
    build_number: string;
  };
  qualification_is_administrator: false;
  qualification_is_elevated: false;
};

/** This expectation is supplied by the fixed producer's separately owned job
 * output, not a field selected by the report or capture being checked. */
export function inspectApplicationNativeHost(
  raw: unknown,
  minimum: Minimum,
): ApplicationNativeHost {
  assert.ok(isRecord(raw));
  assert.equal(
    Object.keys(raw).sort().join(","),
    "account,account_binding_sha256,execution_context,machine_id_sha256,nonce,os,qualification_is_administrator,qualification_is_elevated,qualification_profile",
  );
  assert.equal(raw.qualification_profile, "fixed-hosted-native-v1");
  assert.equal(raw.qualification_is_administrator, false);
  assert.equal(raw.qualification_is_elevated, false);
  for (const key of ["machine_id_sha256", "account_binding_sha256", "nonce"] as const)
    assert.ok(typeof raw[key] === "string" && /^[a-f0-9]{64}$/u.test(raw[key]));
  const account = inspectNativeQualificationAccount(raw.account);
  assert.equal(account.kind, "windows-sid");
  assert.match(account.qualification, /^S-1-5-21-(?:[0-9]{1,10}-){3}[0-9]{1,10}$/u);
  const rid = BigInt(account.qualification.split("-").at(-1)!);
  assert.ok(
    rid >= 1000n && rid <= 4294967295n,
    "candidate cannot be SYSTEM/service/built-in account",
  );
  const context =
    minimum === hostedWindowsContinuityPlatform
      ? "native-windows-server-2022-hosted-isolated-account"
      : "native-windows-11-26h2-hosted-isolated-account";
  assert.equal(raw.execution_context, context);
  assert.ok(isRecord(raw.os) && typeof raw.os.version === "string");
  const os = inspectHostedWindowsOperatingSystem(raw.os, minimum, raw.os.version, "10.0.26200");
  assert.ok(
    typeof os.caption === "string" &&
      typeof os.version === "string" &&
      typeof os.display_version === "string" &&
      typeof os.product_type === "number" &&
      typeof os.build_number === "string",
  );
  return {
    machine_id_sha256: String(raw.machine_id_sha256),
    nonce: String(raw.nonce),
    account_binding_sha256: String(raw.account_binding_sha256),
    qualification_profile: "fixed-hosted-native-v1",
    execution_context: context,
    account: { kind: "windows-sid", broker: account.broker, qualification: account.qualification },
    os: {
      caption: os.caption,
      version: os.version,
      display_version: os.display_version,
      product_type: os.product_type,
      build_number: os.build_number,
    },
    qualification_is_administrator: false,
    qualification_is_elevated: false,
  };
}
export type ApplicationNativeBinding = {
  control_commit: string;
  control_tree: string;
  control_ref: string;
  harness_sha256: string;
  run_id: string;
  native_attempt: number;
  package_attempt: number;
  unsigned_artifact: number;
  source_commit: string;
  source_tree: string;
  package: { filename: string; bytes: number; sha256: string };
  package_manifest_sha256: string;
  minimum_webview2_version: string;
  minimum_platform: Minimum;
  host: ApplicationNativeHost;
  native_invocation_id: string;
  setup_plan_sha256: string;
  source_declarations: ReturnType<typeof inspectNativeCompatibilitySources>;
};

export function applicationNativeRequest(
  expected: ApplicationNativeBinding,
): NativeStageRequest["request"] {
  const host = inspectApplicationNativeHost(expected.host, expected.minimum_platform);
  for (const value of [
    expected.control_commit,
    expected.control_tree,
    expected.source_commit,
    expected.source_tree,
  ])
    assert.match(value, /^[a-f0-9]{40}$/u);
  assert.match(
    expected.control_ref,
    /^refs\/tags\/portcove-production-controller-windows-[A-Za-z0-9._-]{1,64}$/u,
  );
  assert.match(expected.run_id, /^[1-9][0-9]{0,15}$/u);
  assert.ok(Number.isSafeInteger(Number(expected.run_id)));
  assert.ok(
    Number.isSafeInteger(expected.package_attempt) &&
      expected.package_attempt >= 1 &&
      expected.package_attempt <= expected.native_attempt &&
      expected.native_attempt <= 3 &&
      Number.isSafeInteger(expected.native_attempt),
  );
  assert.ok(Number.isSafeInteger(expected.unsigned_artifact) && expected.unsigned_artifact > 0);
  assert.ok(
    Number.isSafeInteger(expected.package.bytes) &&
      expected.package.bytes > 0 &&
      expected.package.bytes <= 512 * 1024 ** 2,
  );
  assert.match(expected.package.filename, /^Portcove_[A-Za-z0-9.+-]{1,96}_x64-setup\.exe$/u);
  for (const value of [
    expected.package.sha256,
    expected.package_manifest_sha256,
    expected.harness_sha256,
    expected.native_invocation_id,
    expected.setup_plan_sha256,
  ])
    assert.match(value, /^[a-f0-9]{64}$/u);
  assert.match(expected.minimum_webview2_version, /^[0-9]{1,10}(?:\.[0-9]{1,10}){3}$/u);
  assert.ok(
    expected.minimum_platform === "windows-11-26h2-x64" ||
      expected.minimum_platform === hostedWindowsContinuityPlatform,
  );
  const declarations = expected.source_declarations;
  const compatibility = {
    minimum_os_version: "10.0.26200",
    required_capabilities: [...declarations.available_capabilities],
    cli_protocol: declarations.cli_protocol,
    catalog_formats: [...declarations.catalog_formats],
    library: declarations.library,
  };
  const policy = {
    control_ref: expected.control_ref,
    package_manifest_sha256: expected.package_manifest_sha256,
    native_attempt: expected.native_attempt,
    host,
    compatibility,
  };
  return {
    schema_version: 1,
    repository_id: 1354613114,
    namespace: "portcove-production",
    stage: "payload-signing",
    platform_label: "windows-x86_64",
    invocation_id: expected.native_invocation_id,
    setup_descriptor_sha256: expected.setup_plan_sha256,
    authority_configuration_digest: digest(policy),
    candidate: {
      source_commit: expected.source_commit,
      source_tree: expected.source_tree,
      run_id: expected.run_id,
      run_attempt: expected.package_attempt,
      artifact_id: expected.unsigned_artifact,
      package: expected.package,
    },
    journey: null,
    expected: {
      producer: {
        source_commit: expected.control_commit,
        source_tree: expected.control_tree,
        harness: { path: applicationNativeHarness, sha256: expected.harness_sha256 },
      },
      host: {
        machine_id_sha256: host.machine_id_sha256,
        qualification_profile: host.qualification_profile,
        minimum_platform: expected.minimum_platform,
        account: host.account,
        engine: { name: "WebView2", minimum_version: expected.minimum_webview2_version },
      },
      compatibility,
    },
    required_scenarios: [...nativeQualificationScenarios["payload-signing"]],
  };
}

export function inspectApplicationNativeAcceptance(
  reportRaw: unknown,
  captureRaw: unknown,
  evidenceRaw: unknown,
  expected: ApplicationNativeBinding,
) {
  const request = applicationNativeRequest(expected);
  const prepared: NativeStageRequest = {
    request,
    request_sha256: digest(request),
    authority: "none",
    scope: "integrity-only",
  };
  const report = inspectNativeReleaseQualification(reportRaw);
  assert.equal(report.schema_version, 1);
  assert.equal(report.stage, "payload-signing");
  assert.equal(report.platform_label, "windows-x86_64");
  assert.deepEqual(report.candidate, request.candidate);
  assert.ok(
    isRecord(captureRaw) &&
      captureRaw.authority === "none" &&
      captureRaw.scope === "integrity-only",
  );
  const { authority: _authority, scope: _scope, ...captureData } = captureRaw;
  const captured = serializeApplicationPreSignCapture(captureData, {
    request_sha256: prepared.request_sha256,
    harness: request.expected.producer.harness,
  });
  assert.equal(captured.capture.outcome, "completed");
  assert.deepEqual(captured.capture, captureRaw);
  assert.ok(
    captured.capture.roots.some(
      (root) =>
        root.role === "candidate-package" &&
        root.image.sha256 === expected.package.sha256 &&
        root.teardown?.exit_code === 0,
    ),
    "exact candidate installer did not exit naturally and successfully",
  );
  assert.ok(isRecord(evidenceRaw));
  assert.deepEqual(evidenceRaw.capture, captureRaw);
  assert.equal(evidenceRaw.binding_sha256, expected.host.account_binding_sha256);
  assert.equal(
    evidenceRaw.version,
    expected.package.filename.slice("Portcove_".length, -"_x64-setup.exe".length),
  );
  const host = expected.host;
  const reconstructed = reconstructHostedNativeWindowsPreSignReport(
    prepared,
    evidenceRaw,
    expected.source_declarations,
    {
      schema_version: 1,
      nonce: host.nonce,
      architecture: "x86_64",
      machine_id_sha256: host.machine_id_sha256,
      broker_sid: host.account.broker,
      os: host.os,
    },
    host.nonce,
  );
  assert.deepEqual(
    reconstructed.report,
    report,
    "native report differs from actual installer/runtime/source/host reconstruction",
  );
  return {
    request_sha256: prepared.request_sha256,
    report,
    capture_sha256: captured.capture_sha256,
    minimum_platform: expected.minimum_platform,
    authority: "none" as const,
    scope: "native reconstruction only; fixed producer authentication remains separately required",
  };
}

/** Actual successful producer chronology is checked in addition to attestation.
 * A fresh signature over stale native observations is not fresh execution. */
export function inspectApplicationNativeProducerJob(
  raw: unknown,
  report: { producer: { started_at: string }; runtime: { teardown: { completed_at: string } } },
  expected: ApplicationNativeBinding,
) {
  assert.ok(
    isRecord(raw) &&
      Array.isArray(raw.jobs) &&
      raw.total_count === raw.jobs.length &&
      raw.jobs.length < 100,
  );
  const jobs = raw.jobs.filter(
    (job: unknown) => isRecord(job) && job.name === applicationNativeJobName,
  );
  assert.equal(jobs.length, 1);
  const job: unknown = jobs[0];
  assert.ok(isRecord(job));
  assert.equal(job.run_id, Number(expected.run_id));
  assert.equal(job.run_attempt, expected.native_attempt);
  assert.equal(job.head_sha, expected.control_commit);
  assert.equal(job.status, "completed");
  assert.equal(job.conclusion, "success");
  assert.ok(typeof job.id === "number" && Number.isSafeInteger(job.id) && job.id > 0);
  assert.ok(
    typeof job.runner_id === "number" && Number.isSafeInteger(job.runner_id) && job.runner_id > 0,
  );
  assert.ok(typeof job.started_at === "string" && typeof job.completed_at === "string");
  const start = Date.parse(job.started_at),
    end = Date.parse(job.completed_at);
  assert.ok(
    Number.isFinite(start) &&
      Number.isFinite(end) &&
      start <= Date.parse(report.producer.started_at) &&
      start <= end &&
      end - start <= applicationNativeExecutionMinutes * 60000,
  );
  assert.ok(
    Date.parse(report.runtime.teardown.completed_at) <= end,
    "native capture is outside its actual successful producer job",
  );
  return { job_id: job.id, producer_attempt: expected.native_attempt, authority: "none" as const };
}
