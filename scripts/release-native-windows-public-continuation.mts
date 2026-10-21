/** Historical B paths are observations, never an account or launch capability. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { requireActualPublicJourneyInvocation } from "./release-native-attempt.mts";
import { requireActualWindowsPublicParent } from "./release-native-parent.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { requireActualPublicWindowsCompilerIdentity } from "./release-native-public-compiler.mts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (raw: unknown) => {
  assert.ok(typeof raw === "string" && /^[A-Za-z]:\\/u.test(raw));
  for (const value of raw) assert.ok(value.charCodeAt(0) >= 32);
  assert.ok(!/[<>"|?*]/u.test(raw));
  assert.ok(
    raw
      .split("\\")
      .slice(1)
      .every((part) => part && part !== "." && part !== ".." && !/[:/]|[. ]$/u.test(part)),
  );
  assert.equal(path.win32.normalize(raw), raw);
  return raw;
};
const same = (left: unknown, right: string) => {
  assert.equal(canonical(left).toLowerCase(), right.toLowerCase());
};

/** Inert exact-shape projection, called only after the actual historical hashes
 * and current private claim have been checked. No caller path can select a new
 * installation, runtime, registry namespace or account. */
export function inspectWindowsPublicContinuationPaths(
  rawBinding: unknown,
  rawInstaller: unknown,
  rawReport: unknown,
  boundary: unknown,
  previousInvocation: string,
  priorExecutableSha256: string,
  parkedVersion: string,
  parkedInstallerSha256: string,
) {
  assert.match(previousInvocation, /^[a-f0-9]{64}$/u);
  assert.ok(isRecord(rawBinding) && isRecord(rawInstaller) && isRecord(rawReport));
  assert.ok(isRecord(boundary));
  assert.ok(
    typeof boundary.account_sid === "string" &&
      /^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/u.test(boundary.account_sid),
  );
  assert.ok(
    typeof boundary.helper_sha256 === "string" && /^[a-f0-9]{64}$/u.test(boundary.helper_sha256),
  );
  assert.equal(rawBinding.invocation_id, previousInvocation);
  assert.equal(rawBinding.account_sid, boundary.account_sid);
  assert.equal(rawBinding.helper_sha256, boundary.helper_sha256);
  same(rawBinding.profile_root, canonical(boundary.profile_root));
  same(rawBinding.controller_root, canonical(boundary.controller_root));
  const work = path.win32.join(canonical(boundary.work_root), previousInvocation);
  same(rawBinding.work_root, work);
  const testBase = path.win32.join(work, "installer");
  assert.equal(rawInstaller.phase, "public_v1_parked");
  assert.equal(rawInstaller.failure, null);
  assert.ok(isRecord(rawInstaller.owned_paths) && isRecord(rawInstaller.details));
  const owned = rawInstaller.owned_paths;
  assert.ok(
    typeof owned.run_root_relative === "string" &&
      /^run-[a-f0-9]{32}$/u.test(owned.run_root_relative),
  );
  const run = path.win32.join(testBase, owned.run_root_relative);
  assert.equal(owned.install_relative, `${owned.run_root_relative}/installed`);
  assert.equal(owned.library_relative, `${owned.run_root_relative}/library`);
  const install = path.win32.join(run, "installed");
  const application = path.win32.join(install, "portcove-desktop.exe");
  const details = rawInstaller.details;
  assert.equal(details.kept_installed, true);
  assert.equal(details.installed_executable_sha256, priorExecutableSha256);
  same(details.application, application);
  assert.ok(typeof details.registration_path === "string");
  const registryPrefix = `Microsoft.PowerShell.Core\\Registry::HKEY_USERS\\${boundary.account_sid}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\`;
  // PowerShell's provider-qualified PSPath is retained unchanged; no HKCU/HKLM
  // or another user's registration may be substituted.
  assert.ok(details.registration_path.startsWith(registryPrefix));
  const registryLeaf = details.registration_path.slice(registryPrefix.length);
  assert.match(registryLeaf, /^[^\\/]{1,160}$/u);
  for (const value of registryLeaf) assert.ok(value.charCodeAt(0) >= 32);
  assert.ok(typeof rawInstaller.uninstaller_sha256 === "string");
  assert.match(rawInstaller.uninstaller_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(rawReport.phase, "park-v0-with-v1");
  assert.equal(rawReport.outcome, "parked");
  assert.ok(!Object.hasOwn(rawReport, "cleanup_failure"));
  assert.ok(isRecord(rawReport.parked) && isRecord(rawReport.parked.status));
  assert.equal(rawReport.parked.installed_sha256, priorExecutableSha256);
  assert.equal(rawReport.parked.staged_installer_sha256, parkedInstallerSha256);
  const status = rawReport.parked.status;
  assert.equal(status.apply, null);
  assert.deepEqual(status.recovery_required, []);
  assert.ok(isRecord(status.staged));
  assert.equal(status.staged.version, parkedVersion);
  assert.ok(isRecord(rawReport.user_state) && isRecord(rawReport.user_state.after));
  const runtime = path.win32.join(work, "desktop-ordinary-public-update");
  same(rawReport.user_state.after.library_root, path.win32.join(runtime, "library"));
  return {
    work_root: work,
    test_base: testBase,
    run_root: run,
    install_root: install,
    library_root: path.win32.join(run, "library"),
    runtime_root: runtime,
    application,
    uninstaller: path.win32.join(install, "uninstall.exe"),
    uninstaller_sha256: rawInstaller.uninstaller_sha256,
    registration_path: details.registration_path,
    prior_state: structuredClone(rawReport.user_state.after),
    parked_status: structuredClone(status),
  };
}

/** Only a genuine current V2 claim can recover the positively settled original
 * B inputs. Rehashes original protected files; never restores or launches. */
export async function readActualWindowsPublicContinuation(claim: object) {
  const selected = await requireActualPublicJourneyInvocation(claim);
  assert.equal(selected.phase, "continue-with-v2");
  const parent = await requireActualWindowsPublicParent(selected.parent_receipt);
  const previous = selected.previous_settled_capture;
  assert.ok(previous && selected.compiler_receipts && selected.parked_package);
  assert.equal(previous.marker.phase, "park-v0-with-v1");
  assert.equal(previous.settled.proof_outcome, "completed");
  const read = async (file: string) => {
    const identity = previous.settled.files.find((item) => item.path === file);
    assert.ok(identity && identity.bytes > 0 && identity.bytes <= 4 * 1024 * 1024);
    const bytes = await readBoundedPublicBuildInputFile(previous.directory, file, identity.bytes);
    assert.equal(bytes.length, identity.bytes);
    assert.equal(hash(bytes), identity.sha256);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  };
  const prior = await requireActualPublicWindowsCompilerIdentity(selected.compiler_receipts.prior);
  const result = inspectWindowsPublicContinuationPaths(
    await read("account-binding.json"),
    await read("installer.json"),
    await read("ordinary-public-update/public-update-journey.json"),
    parent.boundary_configuration,
    previous.marker.invocation_id,
    prior.identity.executable.nsis_sha256,
    selected.parked_package.identity.version,
    selected.parked_package.identity.package.sha256,
  );
  await requireActualPublicJourneyInvocation(claim);
  await requireActualWindowsPublicParent(selected.parent_receipt);
  const reportIdentity = previous.settled.files.find(
    (file) => file.path === "ordinary-public-update/public-update-journey.json",
  );
  assert.ok(reportIdentity);
  return {
    ...result,
    previous_invocation_id: previous.marker.invocation_id,
    previous_report: {
      path: path.join(previous.directory, reportIdentity.path),
      bytes: reportIdentity.bytes,
      sha256: reportIdentity.sha256,
    },
  };
}
