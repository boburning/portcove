import assert from "node:assert/strict";
import test from "node:test";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";

const entry = new URL("./desktop-install-test.mts", import.meta.url);
void test("serialized install refresh rejection, explicit retry and restoration preserve real IPC forwarding", () => {
  const program = `
    const subject=await import(entry);
    const {runInstallFetchProbeOracle}=await import(new URL('../../../scripts/fixtures/native-fetch-probe-fixture.mts',entry));
    await runInstallFetchProbeOracle(subject);
  `;
  runDesktopModuleFixture(entry, program);
  runDesktopModuleFixture(entry, program, {
    exportName: "installRefreshProbe",
    variant: "aliased",
  });
  assert.throws(
    () =>
      runDesktopModuleFixture(entry, program, {
        exportName: "installRefreshProbe",
        variant: "wrong-export",
      }),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      error.message.includes("INSTALL_REFRESH_PROBE_INSTALLATION"),
    "INSTALL_REFRESH_PROBE_REMOVED_DEPENDENCY",
  );
});

void test("actual install refresh scenario enters its imported probe and restores before returning failure", () => {
  const program = `
    const {runInstallCallerProbe}=await import(new URL('../../../scripts/fixtures/native-fetch-probe-fixture.mts',entry));
    await runInstallCallerProbe(entry);
  `;
  runDesktopModuleFixture(entry, program);
  runDesktopModuleFixture(entry, program, { exportName: "installScenarios", variant: "aliased" });
  assert.throws(
    () =>
      runDesktopModuleFixture(entry, program, {
        exportName: "installScenarios",
        variant: "wrong-export",
      }),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      error.message.includes("NATIVE_INSTALL_CALLER_NOT_INVOKED"),
    "NATIVE_INSTALL_REPLACED_ACTUAL_CALLER",
  );
});
