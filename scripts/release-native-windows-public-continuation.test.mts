import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectWindowsPublicContinuationPaths,
  readActualWindowsPublicContinuation,
} from "./release-native-windows-public-continuation.mts";

function fixture() {
  const invocation = "a".repeat(64),
    executable = "b".repeat(64),
    staged = "c".repeat(64);
  const boundary = {
    account_sid: "S-1-5-21-1-2-3-1003",
    profile_root: "C:\\Users\\PublicProof",
    work_root: "C:\\PublicProof\\work",
    controller_root: "C:\\Owner\\controller",
    helper_sha256: "d".repeat(64),
  };
  const work = `${boundary.work_root}\\${invocation}`,
    run = `run-${"e".repeat(32)}`;
  const binding = { invocation_id: invocation, ...boundary, work_root: work };
  const installer = {
    phase: "public_v1_parked",
    failure: null,
    uninstaller_sha256: "f".repeat(64),
    owned_paths: {
      run_root_relative: run,
      install_relative: `${run}/installed`,
      library_relative: `${run}/library`,
    },
    details: {
      kept_installed: true,
      installed_executable_sha256: executable,
      application: `${work}\\installer\\${run}\\installed\\portcove-desktop.exe`,
      registration_path: `Microsoft.PowerShell.Core\\Registry::HKEY_USERS\\${boundary.account_sid}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Portcove`,
    },
  };
  const report = {
    phase: "park-v0-with-v1",
    outcome: "parked",
    parked: {
      installed_sha256: executable,
      staged_installer_sha256: staged,
      status: { apply: null, recovery_required: [], staged: { version: "0.1.0-beta.2" } },
    },
    user_state: { after: { library_root: `${work}\\desktop-ordinary-public-update\\library` } },
  };
  return { invocation, executable, staged, boundary, binding, installer, report };
}
function inspect(f: ReturnType<typeof fixture>) {
  return inspectWindowsPublicContinuationPaths(
    f.binding,
    f.installer,
    f.report,
    f.boundary,
    f.invocation,
    f.executable,
    "0.1.0-beta.2",
    f.staged,
  );
}
void test("continuation derives only the original exact B work/install/runtime and public HKU leaf", () => {
  const f = fixture(),
    result = inspect(f);
  assert.equal(result.work_root, f.binding.work_root);
  assert.equal(result.application, f.installer.details.application);
  assert.equal(result.runtime_root, `${f.binding.work_root}\\desktop-ordinary-public-update`);
  assert.equal(result.registration_path, f.installer.details.registration_path);
  f.binding.profile_root = f.binding.profile_root.toLowerCase();
  assert.deepEqual(inspect(f), result);
});
void test("continuation refuses other accounts, invocations and shifted runtime/install paths", () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.binding.account_sid = "S-1-5-21-1-2-3-1002";
    },
    (f) => {
      f.binding.work_root += "-sibling";
    },
    (f) => {
      f.binding.work_root = f.binding.work_root.replace("\\work\\", "\\work\\..\\work\\");
    },
    (f) => {
      f.binding.profile_root += ":stream";
    },
    (f) => {
      f.installer.owned_paths.run_root_relative = "../another";
    },
    (f) => {
      f.installer.details.application = f.installer.details.application.replace(
        "installed",
        "elsewhere",
      );
    },
    (f) => {
      f.installer.details.registration_path = f.installer.details.registration_path.replace(
        "HKEY_USERS",
        "HKEY_LOCAL_MACHINE",
      );
    },
    (f) => {
      f.report.user_state.after.library_root += "-sibling";
    },
    (f) => {
      f.report.parked.staged_installer_sha256 = "0".repeat(64);
    },
    (f) => {
      f.report.parked.status.recovery_required.push("staging" as never);
    },
    (f) => {
      f.installer.phase = "failed";
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspect(f));
  }
});
void test("copied continuation projections cannot become an actual current claim", async () => {
  await assert.rejects(readActualWindowsPublicContinuation({ ...inspect(fixture()) }), /actual/u);
});
