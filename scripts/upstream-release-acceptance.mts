/** Exact controlled native receipts. Provenance alone never supplies acceptance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./runtime-values.mts";
import {
  rehearsalExecution,
  rehearsalOriginRef,
  rehearsalOrigin,
  rehearsalPublicBase,
} from "./upstream-release-identity.mts";
import {
  rehearsalEntry,
  rehearsalVersions,
  readRehearsalManifest,
  type RehearsalManifest,
} from "./upstream-release-rehearsal.mts";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";

const receiptFiles = ["installed.json", "renderer-update-evidence.json", "summary.json"];
async function jsonFile(directory: string, name: string) {
  const filename = path.join(directory, name);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 65536)
    throw new Error("native receipt is not a bounded regular JSON file");
  const bytes = await readFile(filename);
  if (bytes.length !== stat.size) throw new Error("native receipt changed during read");
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
}

export function inspectRehearsalAcceptance(
  installed: unknown,
  renderer: unknown,
  summary: unknown,
  expected: {
    source: string;
    run_id: string;
    origin_attempt: number;
    producer_attempt: number;
    version: string;
    manifest_sha256: string;
    installer_sha256: string;
    source_tree: string;
    harness_sha256: string;
    public_transport?: boolean;
    executor?: { source: string; run_id: string; run_attempt: number };
  },
) {
  assert.ok(isRecord(installed) && installed.phase === "complete" && installed.failure === null);
  const observation = installed.observation_identity;
  assert.ok(
    isRecord(observation) &&
      observation.schema_version === 1 &&
      observation.source_commit === (expected.executor?.source ?? expected.source) &&
      observation.source_tree === expected.source_tree &&
      observation.harness === "scripts/test-windows-installer.ps1" &&
      observation.harness_sha256 === expected.harness_sha256,
  );
  assert.deepEqual(installed.unverified_child_observations, []);
  assert.equal(installed.unverified_child_capture_failed, false);
  const expectedProcesses = new Map<string, number>([
    ["predecessor_installer", 0],
    ["predecessor_smoke", 0],
    ["installed_update_truncated_stage", 1],
    ["installed_update_tampered_stage", 1],
    ["installed_update_recovery_status", 1],
    ["installed_update_recovery_repair", 0],
    ["installed_update_recovery_verified", 0],
    ["candidate_smoke", 0],
    ["candidate_uninstaller", 0],
  ]);
  assert.ok(
    Array.isArray(installed.process_runs) &&
      installed.process_runs.length >= expectedProcesses.size &&
      installed.process_runs.length <= 32,
  );
  const seen = new Set<string>();
  for (const process of installed.process_runs) {
    assert.ok(
      isRecord(process) &&
        typeof process.role === "string" &&
        !seen.has(process.role) &&
        process.status === "exit_observed" &&
        Number.isSafeInteger(process.pid) &&
        Number(process.pid) > 0 &&
        process.exit_observation === "Observed through the retained launch handle" &&
        typeof process.executable_sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(process.executable_sha256),
    );
    assert.equal(
      process.exit_code,
      expectedProcesses.get(process.role) ??
        (process.role === "candidate_uninstaller_child" ? 0 : undefined),
    );
    assert.ok(
      expectedProcesses.has(process.role) || process.role === "candidate_uninstaller_child",
    );
    seen.add(process.role);
    if (process.role === "candidate_uninstaller_child") {
      const parent: unknown = installed.process_runs.find(
        (row) => isRecord(row) && row.role === "candidate_uninstaller",
      );
      assert.ok(
        isRecord(parent) &&
          process.parent_run_id === parent.id &&
          process.parent_pid === parent.pid,
      );
    }
  }
  assert.ok([...expectedProcesses.keys()].every((role) => seen.has(role)));
  const absence = installed.private_signing_inputs_absent;
  assert.ok(isRecord(absence));
  assert.deepEqual(
    Object.keys(absence).sort(),
    [
      "payload_private_key",
      "tuf_private_root",
      "signing_private_key_environment",
      "signing_private_key_path_environment",
      "signing_password_environment",
    ].sort(),
  );
  assert.ok(Object.values(absence).every((value) => value === true));
  const details = installed.details;
  assert.ok(
    isRecord(details) &&
      details.registered_version === expected.version &&
      details.installer_sha256 === expected.installer_sha256,
  );
  assert.ok(
    details.application_responding === true &&
      details.application_exit_code === 0 &&
      details.uninstall_exit_code === 0 &&
      details.managed_files_removed === true &&
      details.registration_removed === true &&
      details.persistent_data_preserved === true,
  );
  assert.ok(
    isRecord(details.expected_executable) &&
      typeof details.expected_executable.raw_sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(details.expected_executable.raw_sha256) &&
      details.expected_executable.bundled_sha256 === details.installed_executable_sha256,
  );
  const before = details.preservation_manifest_before_uninstall;
  const after = details.preservation_manifest_after_uninstall;
  assert.ok(
    isRecord(before) &&
      isRecord(after) &&
      isRecord(before.preferences) &&
      before.preferences.present === true &&
      Array.isArray(before.library),
  );
  assert.ok(before.library.some((row) => isRecord(row) && row.path === "portcove.sqlite3"));
  assert.ok(
    before.library.some(
      (row) => isRecord(row) && row.path === "user/installer-qualification/preserve.txt",
    ),
  );
  assert.ok(isDeepStrictEqual(before, after));
  for (const key of ["installed_truncated_stage", "installed_tampered_stage"]) {
    const refusal = installed[key];
    assert.ok(
      isRecord(refusal) &&
        refusal.exit_code === 1 &&
        refusal.staging_empty === true &&
        refusal.predecessor_preserved === true &&
        refusal.sentinel_preserved === true,
    );
  }
  const recovery = installed.installed_recovery;
  assert.ok(
    isRecord(recovery) &&
      recovery.status_exit_code === 1 &&
      recovery.repair_exit_code === 0 &&
      recovery.healthy_status_exit_code === 0 &&
      recovery.staging_empty === true,
  );
  assert.ok(
    isRecord(renderer) &&
      renderer.phase === "complete" &&
      renderer.failure === null &&
      renderer.source_commit === (expected.executor?.source ?? expected.source) &&
      renderer.candidate_version === expected.version &&
      renderer.candidate_installer_sha256 === expected.installer_sha256 &&
      renderer.candidate_executable_sha256 === details.installed_executable_sha256,
  );
  assert.ok(isRecord(renderer.helper_result) && renderer.helper_result.exit_code === 0);
  assert.ok(
    isRecord(renderer.helper_process_marker) &&
      isRecord(renderer.relaunch_process_marker) &&
      isRecord(renderer.helper_os_exit) &&
      renderer.helper_os_exit.kind === "observation" &&
      isRecord(renderer.helper_os_exit.observation),
  );
  const helperExit = renderer.helper_os_exit.observation;
  assert.ok(
    helperExit.status === "exit-observed" &&
      helperExit.exit_code === 0 &&
      helperExit.observation === "retained-process-handle" &&
      helperExit.pid === renderer.helper_process_marker.process_id &&
      helperExit.pid === renderer.helper_result.process_id &&
      helperExit.path === renderer.helper_process_marker.executable &&
      typeof helperExit.started_filetime === "string" &&
      /^[1-9][0-9]{16,19}$/u.test(helperExit.started_filetime),
  );
  assert.ok(isRecord(renderer.natural_process_exit));
  for (const [role, pid] of [
    ["helper", helperExit.pid],
    ["candidate", renderer.relaunch_process_marker.process_id],
  ] as const) {
    const process = renderer.natural_process_exit[role];
    assert.ok(
      isRecord(process) &&
        isRecord(process.capture) &&
        process.capture.status === "exited" &&
        process.capture.pid === pid &&
        isRecord(process.exit) &&
        process.exit.status === "exited" &&
        process.exit.pid === pid &&
        Number.isSafeInteger(pid) &&
        Number(pid) > 0,
    );
  }
  assert.ok(
    isRecord(renderer.embedded_cleanup) &&
      renderer.embedded_cleanup.forced === false &&
      renderer.embedded_cleanup.exit_code === 0,
  );
  assert.ok(
    isRecord(renderer.updater_process_cleanup) &&
      renderer.updater_process_cleanup.candidate === "exited naturally before cleanup" &&
      renderer.updater_process_cleanup.helper === "exited naturally before cleanup",
  );
  assert.ok(
    isRecord(summary) &&
      summary.scope ===
        (expected.public_transport
          ? "disposable-public-installed-fixture"
          : "disposable-installed-fixture") &&
      summary.source === expected.source &&
      summary.run_id === expected.run_id &&
      summary.attempt === expected.producer_attempt &&
      summary.original_attempt === expected.origin_attempt &&
      summary.candidate_version === expected.version &&
      summary.signed_manifest_sha256 === expected.manifest_sha256 &&
      summary.private_authority_transferred === false &&
      summary.metadata_transport ===
        (expected.public_transport
          ? "compiled-https-and-normal-github-payload"
          : "local-public-fixture") &&
      summary.production === false,
  );
  if (expected.executor) assert.deepEqual(summary.executor, expected.executor);
  if (expected.public_transport) {
    assert.equal(
      installed.controlled_public_transport,
      "compiled HTTPS metadata and normal GitHub payload transport; no local repository or payload substitute",
    );
  } else {
    const empty = summary.empty_https_feed;
    const base = rehearsalPublicBase({
      run_id: expected.run_id,
      run_attempt: expected.origin_attempt,
    });
    assert.ok(
      isRecord(empty) &&
        empty.scope === "controlled-empty-https-feed" &&
        empty.state === "no-candidate" &&
        empty.authenticated_metadata === true &&
        empty.production === false &&
        empty.metadata_url === `${base}metadata/` &&
        empty.targets_url === `${base}targets/`,
    );
  }
  return { scope: "controlled disposable elevated Windows Server fixture only", authority: "none" };
}

async function inspectFiles(
  directory: string,
  signedDirectory: string,
  producerAttempt: number,
  publicTransport = false,
) {
  const m = await readRehearsalManifest(signedDirectory);
  const observationSource = publicTransport ? rehearsalExecution().source : m.source;
  const manifestEntry = await rehearsalEntry(signedDirectory, "rehearsal.json");
  const values = await Promise.all(receiptFiles.map((name) => jsonFile(directory, name)));
  inspectRehearsalAcceptance(values[0]!.value, values[1]!.value, values[2]!.value, {
    source: m.source,
    run_id: m.run_id,
    origin_attempt: m.run_attempt,
    producer_attempt: producerAttempt,
    version: m.version,
    manifest_sha256: manifestEntry.sha256,
    installer_sha256: m.files[0]!.sha256,
    source_tree: execFileSync("git", ["rev-parse", `${observationSource}^{tree}`], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4096,
    }).trim(),
    harness_sha256: createHash("sha256")
      .update(
        execFileSync("git", ["show", `${observationSource}:scripts/test-windows-installer.ps1`], {
          timeout: 30000,
          maxBuffer: 2 * 1024 ** 2,
        }),
      )
      .digest("hex"),
    public_transport: publicTransport,
    ...(publicTransport ? { executor: rehearsalExecution() } : {}),
  });
  return { m, manifestEntry, values };
}

async function writeAcceptance(directory: string, signedDirectory: string) {
  const executor = rehearsalExecution();
  const { m, manifestEntry, values } = await inspectFiles(
    directory,
    signedDirectory,
    executor.run_attempt,
  );
  const output = "work/upstream-acceptance";
  await mkdir(output);
  for (const [index, name] of receiptFiles.entries())
    await writeFile(path.join(output, name), values[index]!.bytes, { flag: "wx" });
  const files = await Promise.all(receiptFiles.map((name) => rehearsalEntry(output, name)));
  await writeFile(
    path.join(output, "acceptance.json"),
    `${JSON.stringify({
      scope: "disposable-installed-acceptance",
      origin: rehearsalOrigin(),
      producer_attempt: executor.run_attempt,
      manifest_sha256: manifestEntry.sha256,
      candidate_version: m.version,
      files,
    })}\n`,
    { flag: "wx" },
  );
}

async function inspectAcceptanceFiles(
  directory: string,
  signedDirectory: string,
  producerAttempt: number,
) {
  const origin = rehearsalOrigin(),
    execution = rehearsalExecution();
  if (
    !Number.isSafeInteger(producerAttempt) ||
    producerAttempt < origin.run_attempt ||
    producerAttempt > execution.run_attempt
  )
    throw new Error("native acceptance producer attempt differs");
  const { bytes, value } = await jsonFile(directory, "acceptance.json");
  assert.ok(
    isRecord(value) &&
      Object.keys(value).sort().join(",") ===
        "candidate_version,files,manifest_sha256,origin,producer_attempt,scope" &&
      value.scope === "disposable-installed-acceptance" &&
      isDeepStrictEqual(value.origin, origin) &&
      value.producer_attempt === producerAttempt,
  );
  const { m, manifestEntry } = await inspectFiles(directory, signedDirectory, producerAttempt);
  assert.equal(value.manifest_sha256, manifestEntry.sha256);
  assert.equal(value.candidate_version, m.version);
  const files = await Promise.all(receiptFiles.map((name) => rehearsalEntry(directory, name)));
  assert.deepEqual(value.files, files);
  return {
    manifest: m,
    files: [...files, await rehearsalEntry(directory, "acceptance.json")],
    bytes,
  };
}

export async function verifyRehearsalAcceptance(
  directory: string,
  signedDirectory: string,
  producerAttempt: number,
  attesterAttempt: number,
  phase = "verify",
): Promise<{ manifest: RehearsalManifest; files: Awaited<ReturnType<typeof rehearsalEntry>>[] }> {
  const origin = rehearsalOrigin(),
    execution = rehearsalExecution();
  if (
    !Number.isSafeInteger(attesterAttempt) ||
    attesterAttempt < producerAttempt ||
    attesterAttempt > execution.run_attempt
  )
    throw new Error(
      "acceptance attester attempt differs from original native producer or executor",
    );
  const result = await inspectAcceptanceFiles(directory, signedDirectory, producerAttempt);
  if (!/^[a-z-]{1,32}$/u.test(phase)) throw new Error("unknown acceptance verification phase");
  const evidence = `work/verified-acceptance-${phase}`;
  await mkdir(evidence);
  await verifyReleaseSourceAttestation(
    evidence,
    path.resolve(directory, "acceptance.json"),
    {
      source_commit: origin.source,
      ref: rehearsalOriginRef,
      run_id: origin.run_id,
      run_attempt: attesterAttempt,
      subjects: [
        {
          filename: "acceptance.json",
          sha256: createHash("sha256").update(result.bytes).digest("hex"),
        },
      ],
    },
    { scope: "upstream-rehearsal" },
  );
  return { manifest: result.manifest, files: result.files };
}

async function inspectPublicPredecessor(
  directory: string,
  signedDirectory: string,
  producerAttempt: number,
) {
  const origin = rehearsalOrigin();
  const m = await readRehearsalManifest(signedDirectory);
  const { bytes, value } = await jsonFile(directory, "public-predecessor.json");
  const root = await rehearsalEntry(signedDirectory, "trusted-root.json");
  const version = rehearsalVersions(origin).public_predecessor;
  assert.ok(
    isRecord(value) &&
      value.scope === "disposable-public-predecessor" &&
      isDeepStrictEqual(value.origin, origin) &&
      value.producer_attempt === producerAttempt &&
      value.version === version &&
      value.public_base === rehearsalPublicBase(origin) &&
      value.root_sha256 === root.sha256 &&
      isRecord(value.installer),
  );
  const installer = await rehearsalEntry(directory, `Portcove_${version}_x64-setup.exe`);
  assert.deepEqual(value.installer, installer);
  assert.equal(value.candidate_version, m.version);
  return { bytes, installer };
}

async function writePublicPredecessor(signedDirectory: string) {
  const origin = rehearsalOrigin(),
    execution = rehearsalExecution();
  const m = await readRehearsalManifest(signedDirectory);
  const root = await rehearsalEntry(signedDirectory, "trusted-root.json");
  const base = rehearsalPublicBase(origin);
  assert.equal(process.env.PORTCOVE_APPLICATION_UPDATE_METADATA_URL, `${base}metadata/`);
  assert.equal(process.env.PORTCOVE_APPLICATION_UPDATE_TARGETS_URL, `${base}targets/`);
  assert.equal(
    path.resolve(process.env.PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE ?? ""),
    path.resolve(signedDirectory, "trusted-root.json"),
  );
  const version = rehearsalVersions(origin).public_predecessor;
  const output = "work/upstream-public-predecessor";
  await mkdir(output);
  const name = `Portcove_${version}_x64-setup.exe`;
  await copyFile(path.join("target/release/bundle/nsis", name), path.join(output, name));
  await writeFile(
    path.join(output, "public-predecessor.json"),
    `${JSON.stringify({
      scope: "disposable-public-predecessor",
      origin,
      producer_attempt: execution.run_attempt,
      version,
      candidate_version: m.version,
      public_base: base,
      root_sha256: root.sha256,
      installer: await rehearsalEntry(output, name),
    })}\n`,
    { flag: "wx" },
  );
}

async function verifyPublicPredecessor(
  directory: string,
  signedDirectory: string,
  nativeAttempt: number,
  attesterAttempt: number,
) {
  const origin = rehearsalOrigin(),
    execution = rehearsalExecution();
  if (
    !Number.isSafeInteger(nativeAttempt) ||
    nativeAttempt < origin.run_attempt ||
    !Number.isSafeInteger(attesterAttempt) ||
    attesterAttempt < nativeAttempt ||
    attesterAttempt > execution.run_attempt
  )
    throw new Error("public predecessor producer/attester attempts differ");
  const result = await inspectPublicPredecessor(directory, signedDirectory, nativeAttempt);
  const evidence = "work/verified-public-predecessor";
  await mkdir(evidence);
  await verifyReleaseSourceAttestation(
    evidence,
    path.resolve(directory, "public-predecessor.json"),
    {
      source_commit: origin.source,
      ref: rehearsalOriginRef,
      run_id: origin.run_id,
      run_attempt: attesterAttempt,
      subjects: [
        {
          filename: "public-predecessor.json",
          sha256: createHash("sha256").update(result.bytes).digest("hex"),
        },
      ],
    },
    { scope: "upstream-rehearsal" },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, directory, signed, attempt] = process.argv.slice(2);
  if (!directory || !signed)
    throw new Error("expected write|check NATIVE_RECEIPTS SIGNED_DIRECTORY [NATIVE_ATTEMPT]");
  if (phase === "write") await writeAcceptance(directory, signed);
  else if (phase === "check" && attempt && /^[1-9][0-9]{0,5}$/u.test(attempt))
    await inspectAcceptanceFiles(directory, signed, Number(attempt));
  else if (phase === "check-public" && attempt && /^[1-9][0-9]{0,5}$/u.test(attempt)) {
    const current = await inspectFiles(directory, signed, Number(attempt), true);
    const original = await jsonFile("work/upstream-acceptance", "installed.json");
    assert.ok(
      isRecord(original.value) &&
        isRecord(original.value.details) &&
        isRecord(current.values[0]!.value) &&
        isRecord(current.values[0]!.value.details),
    );
    assert.deepEqual(
      current.values[0]!.value.details.expected_executable,
      original.value.details.expected_executable,
    );
  } else if (phase === "write-public-predecessor") await writePublicPredecessor(signed);
  else if (phase === "check-public-predecessor" && attempt && /^[1-9][0-9]{0,5}$/u.test(attempt))
    await inspectPublicPredecessor(directory, signed, Number(attempt));
  else if (phase === "verify-public-predecessor" && attempt && /^[1-9][0-9]{0,5}$/u.test(attempt))
    await verifyPublicPredecessor(directory, signed, Number(attempt), Number(process.argv[6]));
  else throw new Error("unknown acceptance phase or native producer attempt");
}
