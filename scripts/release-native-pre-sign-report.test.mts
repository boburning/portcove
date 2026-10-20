import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import { nativeAuthorityConfigurationFixture } from "./fixtures/native-authority-configuration-fixture.mts";
import {
  nativeCompatibilitySourcePaths,
  inspectNativeCompatibilitySources,
} from "./release-native-source-contract.mts";
import { prepareNativeStageRequest } from "./release-native-stage-capture.mts";
import {
  reconstructNativePreSignReport,
  prepareActualNativePreSignReport,
  requireActualNativePreSignReport,
  retainActualFailedNativeStage,
} from "./release-native-pre-sign-report.mts";

async function fixture() {
  const native = nativeQualificationFixture(),
    config = nativeAuthorityConfigurationFixture();
  const source = inspectNativeCompatibilitySources(
    Object.fromEntries(
      await Promise.all(
        nativeCompatibilitySourcePaths.map(
          async (file) => [file, await readFile(new URL(`../${file}`, import.meta.url))] as const,
        ),
      ),
    ),
  );
  const compatibility = {
    minimum_os_version: "10.0.26200",
    required_capabilities: [],
    cli_protocol: source.cli_protocol,
    catalog_formats: [...source.catalog_formats],
    library: source.library,
  };
  config.native["windows-x86_64"]!.compatibility = compatibility;
  const prepared = prepareNativeStageRequest(
    {
      schema_version: 1,
      stage: "payload-signing",
      platform_label: "windows-x86_64",
      candidate: native.candidate,
      journey: null,
      invocation_id: native.producer.invocation_id,
      setup_descriptor_sha256: "a".repeat(64),
    },
    config,
  );
  const machine = config.native["windows-x86_64"]!.host,
    version = "0.1.0-beta.1",
    bindingSha = "b".repeat(64),
    installedSha = "c".repeat(64);
  const image = { path: "C:\\runtime\\msedgewebview2.exe", bytes: 123, sha256: "d".repeat(64) };
  const capture = {
    outcome: "completed",
    roots: [
      {
        id: "installer",
        role: "candidate-package",
        image: { pid: 123, path: "C:\\inputs\\setup.exe", sha256: native.candidate.package.sha256 },
        creation: native.runtime.root_creation,
        started_at: "2026-10-20T12:00:00.000Z",
        teardown: { root_exited: true, job_empty: true, remaining_pids: [] },
      },
    ],
    group: { empty: true, remaining_pids: [], observed_at: "2026-10-20T12:00:06.000Z" },
  };
  const manifest = {
    library: [{ path: "portcove.sqlite3", bytes: 1, sha256: "e".repeat(64) }],
    preferences: { present: false },
  };
  const evidence = {
    version,
    binding_sha256: bindingSha,
    evidence_sha256: "f".repeat(64),
    installer_harness_sha256: "1".repeat(64),
    process_snapshot: {
      processes: [{ pid: 124, path: image.path, started_filetime: "134000000000000001" }],
    },
    capture,
    binding: {
      invocation_id: native.producer.invocation_id,
      account_sid: machine.account.qualification,
    },
    driver: {
      failure: null,
      finish_attempted: true,
      started_at: "2026-10-20T11:59:59.000Z",
      host_observation: {
        machine_id_sha256: machine.machine_id_sha256,
        architecture: "X64",
        os_version: "10.0.26200.1",
        engine_images: [{ ...image, version: "155.0.4283.62" }],
      },
    },
    bridge: { phase: "settled", invocation_id: native.producer.invocation_id },
    installer: {
      format: 1,
      phase: "complete",
      failure: null,
      observation_identity: {
        source_commit: native.producer.source_commit,
        source_tree: native.producer.source_tree,
        harness: "scripts/test-windows-installer.ps1",
        harness_sha256: "1".repeat(64),
      },
      package_inputs: { installer_sha256: native.candidate.package.sha256 },
      details: {
        installer_sha256: native.candidate.package.sha256,
        install_exit_code: 0,
        application_responding: true,
        application_exit_code: 0,
        uninstall_exit_code: 0,
        uninstall_registration_count: 1,
        registered_version: version,
        persistent_data_preserved: true,
        managed_files_removed: true,
        registration_removed: true,
        installed_executable_sha256: installedSha,
        registration_path: `Microsoft.PowerShell.Core\\Registry::HKEY_USERS\\${machine.account.qualification}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Portcove`,
        preservation_manifest_before_uninstall: manifest,
        preservation_manifest_after_uninstall: manifest,
      },
    },
    runtime: {
      schema_version: 1,
      authority: "none",
      architecture: "x64",
      account_binding_sha256: bindingSha,
      core: {
        product: "Portcove",
        product_version: version,
        schema_version: source.cli_protocol.min,
      },
      operating_system: "10.0.26200",
      loaded_engine_images: [image],
      browser: { name: "webview2", version: "155.0.4283.62" },
    },
    native: {
      outcome: "passed",
      revision: native.producer.source_commit,
      platform: "win32",
      architecture: "x64",
      checks: [{ scenario: "empty-library", outcome: "passed" }],
      executable: { sha256: installedSha },
    },
  };
  return { prepared, evidence, source };
}

void test("pre-sign reconstruction joins exact installed/host/runtime facts and source declarations without direct provenance", async () => {
  const f = await fixture(),
    result = reconstructNativePreSignReport(f.prepared, f.evidence, f.source);
  assert.equal(result.authority, "none");
  assert.equal(result.report.stage, "payload-signing");
  assert.equal(result.report.host.loaded_engine.version, "155.0.4283.62");
  assert.equal(result.report.compatibility.cli_protocol.min, 77);
  assert.deepEqual(
    result.report.scenarios.map((value) => value.name),
    f.prepared.request.required_scenarios,
  );
  assert.equal(result.report.host.execution_context, "native-windows11-26h2-account");
  await assert.rejects(
    prepareActualNativePreSignReport({ ...result }),
    /actual fixed parent Windows capture/,
  );
  await assert.rejects(
    requireActualNativePreSignReport({ ...result }),
    /actual direct native pre-sign report/,
  );
  await assert.rejects(
    retainActualFailedNativeStage({ ...result }, "fixture refused"),
    /actual fixed parent Windows capture/,
  );
});

void test("pre-sign report refuses metadata-only success, wrong host/source/package, missing state and old protocol", async () => {
  const f = await fixture(),
    e = f.evidence;
  const changed = [
    { ...e, accepted: true },
    { ...e, binding_sha256: "0".repeat(64) },
    { ...e, driver: { ...e.driver, failure: "partial progress" } },
    {
      ...e,
      driver: {
        ...e.driver,
        host_observation: { ...e.driver.host_observation, machine_id_sha256: "0".repeat(64) },
      },
    },
    {
      ...e,
      driver: {
        ...e.driver,
        host_observation: { ...e.driver.host_observation, os_version: "10.0.26100.1" },
      },
    },
    { ...e, runtime: { ...e.runtime, core: { ...e.runtime.core, schema_version: 76 } } },
    { ...e, runtime: { ...e.runtime, core: { ...e.runtime.core, product_version: "wrong" } } },
    { ...e, runtime: { ...e.runtime, browser: { ...e.runtime.browser, version: "154.0.0.0" } } },
    { ...e, native: { ...e.native, checks: [] } },
    { ...e, native: { ...e.native, executable: { sha256: "0".repeat(64) } } },
    {
      ...e,
      installer: {
        ...e.installer,
        details: {
          ...e.installer.details,
          registration_path: e.installer.details.registration_path.replace(
            "HKEY_USERS",
            "HKEY_CURRENT_USER",
          ),
        },
      },
    },
    {
      ...e,
      installer: {
        ...e.installer,
        details: { ...e.installer.details, preservation_manifest_after_uninstall: { library: [] } },
      },
    },
    {
      ...e,
      installer: {
        ...e.installer,
        details: { ...e.installer.details, persistent_data_preserved: false },
      },
    },
    { ...e, capture: { ...e.capture, roots: [] } },
    { ...e, capture: { ...e.capture, group: { ...e.capture.group, empty: false } } },
    { ...e, process_snapshot: { processes: [] } },
    { ...e, installer_harness_sha256: "0".repeat(64) },
    {
      ...e,
      installer: {
        ...e.installer,
        observation_identity: {
          ...e.installer.observation_identity,
          source_commit: "0".repeat(40),
        },
      },
    },
  ];
  for (const value of changed)
    assert.throws(() => reconstructNativePreSignReport(f.prepared, value, f.source));
  assert.throws(() =>
    reconstructNativePreSignReport(f.prepared, e, {
      ...f.source,
      cli_protocol: { min: 76, max: 76 },
    }),
  );
});
