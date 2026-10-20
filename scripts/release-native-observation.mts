import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./runtime-values.mts";

export interface NativeObservationExpectation {
  platform: "windows-x86_64" | "linux-x86_64";
  harness_source_commit: string;
  harness_source_tree: string;
  harness_sha256: string;
  candidate_sha256: string;
  predecessor_sha256: string;
}

/** Consume the maintained outer harness journal. A local JSON report, even when
 * complete, cannot authenticate a native host or replace its protected handoff.
 * Keep reported scenarios separate from independent acceptance and minimum OS.
 */
export function inspectReleaseNativeObservation(
  bytes: Buffer,
  expected: NativeObservationExpectation,
) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 4 * 1024 * 1024)
    throw new Error("native observation exceeds its retained byte bound");
  if (!["windows-x86_64", "linux-x86_64"].includes(expected.platform))
    throw new Error("native platform is outside the selected package pair");
  for (const name of [
    "harness_source_commit",
    "harness_source_tree",
    "harness_sha256",
    "candidate_sha256",
    "predecessor_sha256",
  ] as const) {
    const value = expected[name];
    if (
      !new RegExp(
        `^[a-f0-9]{${name.endsWith("commit") || name.endsWith("tree") ? 40 : 64}}$`,
        "u",
      ).test(value)
    )
      throw new Error("independently expected native identity unavailable");
  }
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(raw) || !isRecord(raw.observation_identity))
    throw new Error("native outer-harness identity is absent");
  const identity = raw.observation_identity;
  const harness =
    expected.platform === "windows-x86_64"
      ? "scripts/test-windows-installer.ps1"
      : "scripts/test-linux-appimage-update.ps1";
  if (
    identity.schema_version !== 1 ||
    identity.harness !== harness ||
    identity.harness_sha256 !== expected.harness_sha256 ||
    identity.source_commit !== expected.harness_source_commit ||
    identity.source_tree !== expected.harness_source_tree ||
    typeof identity.host_os !== "string" ||
    !identity.host_os ||
    identity.host_architecture !== "X64" ||
    typeof identity.started_at !== "string" ||
    !Number.isFinite(Date.parse(identity.started_at))
  )
    throw new Error("native harness/source/host observation identity differs");
  const missing: string[] = [];
  const scenarios: string[] = [];
  if (expected.platform === "linux-x86_64") {
    if (
      raw.schema_version !== 15 ||
      raw.platform !== expected.platform ||
      !isRecord(raw.candidate) ||
      !isRecord(raw.predecessor) ||
      raw.candidate.sha256 !== expected.candidate_sha256 ||
      raw.predecessor.sha256 !== expected.predecessor_sha256
    )
      throw new Error("native AppImage package pair or harness schema differs");
    for (const name of [
      "truncated_payload_rejected",
      "truncated_payload_stable_preserved",
      "truncated_payload_data_preserved",
      "interruption_recovered",
      "interruption_stable_preserved",
      "incompatible_schema_predecessor_restart_observed",
      "incompatible_schema_state_preserved",
      "read_only_state_predecessor_restart_observed",
      "read_only_state_preserved",
      "full_disk_state_preserved",
      "full_appimage_filesystem_stable_preserved",
      "runtime_contention_helper_blocked",
      "post_exchange_candidate_installed",
      "post_exchange_backup_preserved",
      "post_exchange_reconciled",
      "persistent_data_preserved",
      "candidate_restart_observed",
    ]) {
      if (raw[name] === true) scenarios.push(name);
      else missing.push(name);
    }
    if (!isRecord(raw.rootless_lifecycle)) missing.push("rootless_lifecycle");
    else {
      for (const name of [
        "update_desktop_entry_preserved",
        "update_user_paths_preserved",
        "uninstall_stable_removed",
        "uninstall_desktop_entry_removed",
        "uninstall_user_paths_preserved",
      ]) {
        if (raw.rootless_lifecycle[name] === true) scenarios.push(name);
        else missing.push(name);
      }
      const hashes = raw.rootless_lifecycle.preserved_user_sha256;
      if (
        !isRecord(hashes) ||
        Object.keys(hashes).sort().join(",") !== "backups,game_files,library,logs,saves" ||
        Object.values(hashes).some(
          (value) => typeof value !== "string" || !/^[a-fA-F0-9]{64}$/u.test(value),
        )
      )
        missing.push("exact-retained-user-state-identities");
    }
    if (raw.stable_sha256 !== expected.candidate_sha256)
      missing.push("candidate-retained-state-readback");
  } else {
    if (
      raw.format !== 1 ||
      !isRecord(raw.package_inputs) ||
      raw.package_inputs.installer_sha256 !== expected.candidate_sha256 ||
      raw.package_inputs.predecessor_installer_sha256 !== expected.predecessor_sha256
    )
      throw new Error("native NSIS package pair or harness schema differs");
    const details = raw.details;
    if (!isRecord(details)) missing.push("installer-details");
    else {
      for (const name of [
        "persistent_data_preserved",
        "managed_files_removed",
        "registration_removed",
      ]) {
        if (details[name] === true) scenarios.push(name);
        else missing.push(name);
      }
      if (
        details.update_path !== "installed_app_renderer" &&
        details.update_path !== "installed_app_helper"
      )
        missing.push("installed-application-update-path");
      if (
        !isRecord(details.preservation_manifest_before_uninstall) ||
        !isDeepStrictEqual(
          details.preservation_manifest_before_uninstall,
          details.preservation_manifest_after_uninstall,
        )
      )
        missing.push("exact-retained-state-readback");
    }
    missing.push(
      "Windows rollback/recovery observation not supplied by this outer-harness journal",
    );
  }
  if (raw.phase !== "complete" || raw.failure !== null) missing.push("completed-without-failure");
  return {
    schema_version: 1,
    authority: "none",
    native_acceptance: "unknown",
    evidence_scope: "local-report-only",
    report_sha256: createHash("sha256").update(bytes).digest("hex"),
    phase: raw.phase,
    reported_scenarios: scenarios,
    missing_observations: missing,
    identity: structuredClone(identity),
    unresolved: [
      "independently authenticated exact native report/host handoff",
      "required minimum-environment identity",
      "positive matching final process-tree teardown evidence",
    ],
    qualification:
      "report interpretation only; synthetic or imported reports cannot establish native acceptance",
  };
}
