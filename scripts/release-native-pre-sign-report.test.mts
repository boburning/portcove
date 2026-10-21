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
  reconstructNativePostSignReport,
  prepareActualNativePreSignReport,
  requireActualNativePreSignReport,
  retainActualFailedNativeStage,
} from "./release-native-pre-sign-report.mts";

async function fixture() {
  const native = nativeQualificationFixture(),
    config = nativeAuthorityConfigurationFixture();
  config.native["windows-x86_64"]!.producer.harness.path = "scripts/release-native-worker.mts";
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
  return { prepared, evidence, source, config };
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

void test("post-sign report2 preserves initial versus predecessor package scope and pending ordinary public obligations", async () => {
  const f = await fixture();
  const config = {
    ...f.config,
    schema_version: 2,
    native_prepublication_profile: "signed-package-compatibility-v1",
  };
  const journey = {
    kind: "initial-empty-feed",
    metadata_bootstrap_sha256: "a".repeat(64),
    setup_plan_sha256: "b".repeat(64),
    initial_site_preimage_sha256: "c".repeat(64),
    empty_records_sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    signed_context_sha256: "d".repeat(64),
    signatures_sha256: "e".repeat(64),
  };
  const request = {
    schema_version: 1,
    stage: "release-publication",
    platform_label: "windows-x86_64",
    candidate: f.prepared.request.candidate,
    journey,
    invocation_id: f.prepared.request.invocation_id,
    setup_descriptor_sha256: f.prepared.request.setup_descriptor_sha256,
  };
  const prepared = prepareNativeStageRequest(request, config);
  const evidence = structuredClone(f.evidence);
  Object.assign(evidence.installer.details, {
    upgrade: null,
    package_rollback: null,
    update_path: "explicit_bootstrap_destination",
  });
  const crypto = {
    signed_context_sha256: journey.signed_context_sha256,
    signatures_sha256: journey.signatures_sha256,
    result_sha256: "f".repeat(64),
    sha256: request.candidate.package.sha256,
    bytes: request.candidate.package.bytes,
    predecessor_version: null,
  };
  const output = reconstructNativePostSignReport(prepared, evidence, f.source, crypto);
  assert.equal(output.authority, "none");
  assert.equal(output.report.schema_version, 2);
  assert.equal(output.report.stage, "release-publication");
  assert.deepEqual(
    output.report.scenarios.map((item) => item.name),
    ["fresh-install", "candidate-launch", "retained-state", "signature-cryptography"],
  );
  assert.ok("pending_obligations" in output.report);
  assert.deepEqual(output.report.pending_obligations, [
    "ordinary-public-discovery-and-download",
    "ordinary-updater-journal-and-recovery",
    "ordinary-public-manifest-journey",
  ]);
  assert.throws(() => reconstructNativePreSignReport(prepared, evidence, f.source));
  for (const changed of [
    { ...crypto, signed_context_sha256: "0".repeat(64) },
    { ...crypto, signatures_sha256: "0".repeat(64) },
    { ...crypto, sha256: "0".repeat(64) },
    { ...crypto, bytes: crypto.bytes + 1 },
    { ...crypto, result_sha256: "unknown" },
  ])
    assert.throws(() => reconstructNativePostSignReport(prepared, evidence, f.source, changed));
  const claimed = structuredClone(evidence);
  Object.assign(claimed.installer.details, {
    upgrade: { predecessor_smoke: { responding: true } },
  });
  assert.throws(() => reconstructNativePostSignReport(prepared, claimed, f.source, crypto));
  const predecessor = {
    ...request.candidate,
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    run_id: "55",
    artifact_id: 99,
    package: {
      ...request.candidate.package,
      filename: "Portcove_0.0.1_x64-setup.exe",
      sha256: "3".repeat(64),
    },
  };
  const ordinary = prepareNativeStageRequest(
    {
      ...request,
      journey: {
        predecessor,
        signed_context_sha256: journey.signed_context_sha256,
        signatures_sha256: journey.signatures_sha256,
      },
    },
    config,
  );
  const next = structuredClone(evidence),
    preserved = next.installer.details.preservation_manifest_before_uninstall;
  Object.assign(next.installer.details, {
    update_path: "registered_nsis_update",
    upgrade: {
      predecessor_installer_sha256: predecessor.package.sha256,
      predecessor_executable_sha256: "4".repeat(64),
      predecessor_smoke: { responding: true, exit_code: 0 },
    },
    package_rollback: {
      predecessor_installer_sha256: predecessor.package.sha256,
      executable_sha256: "4".repeat(64),
      install_exit_code: 0,
      registration_count: 1,
      registration_path: next.installer.details.registration_path,
      registered_version: "0.0.1",
      smoke: { responding: true, exit_code: 0 },
      database_present: true,
      sentinel_sha256: "5".repeat(64),
      manifest_before_install: preserved,
      manifest_after_install: preserved,
      manifest_after_launch: preserved,
      scope: "signed-package compatibility only; ordinary public updater journey remains pending",
    },
  });
  const predecessorRoot = structuredClone(next.capture.roots[0]!);
  predecessorRoot.id = "predecessor";
  predecessorRoot.image.pid = 122;
  predecessorRoot.image.sha256 = predecessor.package.sha256;
  next.capture.roots.push(predecessorRoot);
  const ordinaryCrypto = { ...crypto, predecessor_version: "0.0.1" };
  const ordinaryOutput = reconstructNativePostSignReport(ordinary, next, f.source, ordinaryCrypto);
  assert.deepEqual(
    ordinaryOutput.report.scenarios.map((item) => item.name),
    ["install-over-prior", "candidate-launch", "retained-state", "package-rollback"],
  );
  for (const mutation of [
    "wrong-version",
    "wrong-package",
    "wrong-executable",
    "changed-state",
    "missing-root",
    "wrong-hive",
    "failed-smoke",
  ]) {
    const altered = structuredClone(next) as typeof next & {
      installer: { details: { package_rollback: Record<string, unknown> } };
    };
    const details = altered.installer.details as unknown as Record<string, unknown>,
      rollback = details.package_rollback as Record<string, unknown>;
    if (mutation === "wrong-version") rollback.registered_version = "0.0.11";
    if (mutation === "wrong-package") rollback.predecessor_installer_sha256 = "6".repeat(64);
    if (mutation === "wrong-executable") rollback.executable_sha256 = "6".repeat(64);
    if (mutation === "changed-state") rollback.manifest_after_install = { library: [] };
    if (mutation === "missing-root") altered.capture.roots = altered.capture.roots.slice(0, 1);
    if (mutation === "wrong-hive") rollback.registration_path = "HKCU\\Other";
    if (mutation === "failed-smoke") rollback.smoke = { responding: false, exit_code: 0 };
    assert.throws(() =>
      reconstructNativePostSignReport(ordinary, altered, f.source, ordinaryCrypto),
    );
  }
});
