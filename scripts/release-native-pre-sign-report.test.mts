import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, link, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readNativeCapturedStream } from "./release-native-capture-files.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { createHash } from "node:crypto";
import {
  reconstructNativeLinuxPreSignReport,
  reconstructNativeLinuxPostSignReport,
  prepareActualLinuxNativeStageReport,
  requireActualLinuxNativeStageReport,
} from "./release-native-linux-report.mts";
import { inspectIsolatedNativeLinuxBinding } from "../apps/desktop/scripts/native-linux-isolated-plan.mts";
import test from "node:test";
void test("actual captured streams preserve empty stderr without relaxing nonempty JSON/public bytes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-empty-stream-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  await writeFile(path.join(root, "harness.stderr.bin"), Buffer.alloc(0));
  assert.equal((await readNativeCapturedStream(root, "harness.stderr.bin")).byteLength, 0);
  await assert.rejects(readBoundedPublicBuildInputFile(root, "harness.stderr.bin", 1), /nonempty/u);
  await assert.rejects(readNativeCapturedStream(root, "native-report.json"));
  await writeFile(path.join(root, "harness.stdout.bin"), Buffer.from([0, 255, 10]));
  assert.deepEqual(
    await readNativeCapturedStream(root, "harness.stdout.bin"),
    Buffer.from([0, 255, 10]),
  );
  await link(path.join(root, "harness.stdout.bin"), path.join(root, "alias.stdout.bin"));
  await assert.rejects(readNativeCapturedStream(root, "alias.stdout.bin"));
  await writeFile(path.join(root, "large.stderr.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(readNativeCapturedStream(root, "large.stderr.bin"));
});
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

async function linuxFixture() {
  const base = await fixture(),
    report = nativeQualificationFixture(),
    linux = base.config.native["linux-x86_64"]!,
    invocation = report.producer.invocation_id,
    root = "/home/qualification/portcove-native",
    attempt = `${root}/invocations/${invocation}`;
  const compatibility = {
    ...base.prepared.request.expected.compatibility,
    minimum_os_version: "6.8.0",
  };
  const account = {
    kind: "windows-wsl-uid",
    broker: "S-1-5-21-1-2-3-1001",
    qualification: "1002",
    distribution: {
      name: "Ubuntu",
      registration_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      wsl_version: 2,
    },
  };
  const config = {
    ...base.config,
    native: {
      ...base.config.native,
      "linux-x86_64": {
        ...linux,
        compatibility,
        producer: {
          ...linux.producer,
          harness: { ...linux.producer.harness, path: "scripts/release-native-worker.mts" },
        },
        host: { ...linux.host, account },
      },
    },
  };
  const prepared = prepareNativeStageRequest(
    {
      schema_version: 1,
      stage: "payload-signing",
      platform_label: "linux-x86_64",
      candidate: {
        ...report.candidate,
        package: { ...report.candidate.package, filename: "Portcove_0.1.0-beta.1_amd64.AppImage" },
      },
      journey: null,
      invocation_id: invocation,
      setup_descriptor_sha256: "a".repeat(64),
    },
    config,
  );
  const tools = Object.fromEntries(
    Object.entries({
      bwrap: "/usr/bin/bwrap",
      driver: `${root}/tools/tauri-driver`,
      git: "/usr/bin/git",
      node: `${root}/tools/node`,
      python: "/usr/bin/python3",
      webkit_driver: "/usr/bin/WebKitWebDriver",
      xvfb: "/usr/bin/Xvfb",
    }).map(([name, path]) => [name, { path, sha256: "b".repeat(64) }]),
  );
  const binding = inspectIsolatedNativeLinuxBinding({
    schema_version: 1,
    invocation_id: invocation,
    linux_root: root,
    account: { uid: 1002, gid: 1002 },
    application: {
      path: `${attempt}/install/Portcove.AppImage`,
      bytes: report.candidate.package.bytes,
      sha256: report.candidate.package.sha256,
    },
    controller: {
      root: `${root}/controller`,
      source_commit: linux.producer.source_commit,
      source_tree: linux.producer.source_tree,
      init_sha256: "a".repeat(64),
    },
    tools,
    unit: {
      name: `portcove-native-${invocation}.service`,
      invocation_id: "c".repeat(32),
      control_group: `/user.slice/user-1002.slice/user@1002.service/app.slice/portcove-native-${invocation}.service`,
    },
    capture_root: `${attempt}/capture`,
    home: `${attempt}/work/home`,
    deadline_utc: "2026-10-20T12:30:00.000Z",
  });
  const bindingSha = createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
    start = "2026-10-20T12:00:00.000Z",
    end = "2026-10-20T12:00:06.000Z",
    rootCreation = { kind: "linux-starttime-ticks", value: "10050" };
  const host = {
    schema_version: 1,
    invocation_id: invocation,
    qualification_uid: 1002,
    qualification_gid: 1002,
    machine_id_sha256: linux.host.machine_id_sha256,
    os_release: 'ID=ubuntu\nVERSION_ID="24.04"\n',
    kernel_release: "6.8.0",
    architecture: "x86_64",
    authority: "none",
  };
  const input = {
    started_at: start,
    version: "0.1.0-beta.1",
    binding,
    binding_sha256: bindingSha,
    host,
    outer: {
      invocation_id: invocation,
      stage_request_sha256: prepared.request_sha256,
      unit: binding.unit.name,
      unit_invocation_id: binding.unit.invocation_id,
      capture_complete: true,
      exit_code: 0,
      cgroup_empty: true,
      unit_settled: true,
      forced_termination: false,
      failure: null,
      cleanup_errors: [],
      cgroup_identity: { device: 1, inode: 2 },
      started_at: start,
      completed_at: end,
    },
    driver: {
      invocation_id: invocation,
      stage_request_sha256: prepared.request_sha256,
      status: 0,
      failure: null,
    },
    native: {
      outcome: "passed",
      revision: linux.producer.source_commit,
      platform: "linux",
      architecture: "x64",
      executable: { sha256: report.candidate.package.sha256 },
      context: { selected_scenarios: ["empty-library", "appearance-restart"] },
      checks: [
        { scenario: "empty-library", outcome: "passed" },
        { scenario: "appearance-restart", outcome: "passed" },
      ],
    },
    restart: [
      {
        preference_preserved: true,
        connected: "2026-10-20T12:00:04.000Z",
        session_delete_completed: "2026-10-20T12:00:03.000Z",
      },
    ],
    runtime: {
      schema_version: 1,
      authority: "none",
      binding_sha256: bindingSha,
      core: {
        product: "Portcove",
        product_version: "0.1.0-beta.1",
        schema_version: base.source.cli_protocol.min,
      },
      browser: { name: "wry", version: "2.52.6" },
      runtime: {
        schema_version: 1,
        authority: "none",
        driver_pid: 2,
        observed_at: "2026-10-20T12:00:02.000Z",
        architecture: "x86_64",
        kernel_release: host.kernel_release,
        os_release: host.os_release,
        process: {
          pid: 4,
          uid: 1002,
          image: "/tmp/appimage/usr/bin/portcove-desktop",
          image_sha256: "d".repeat(64),
          creation_ticks: "10100",
          creation_clock: {
            realtime_ns: String(BigInt(Date.parse("2026-10-20T12:00:02.000Z")) * 1000000n),
            boottime_ns: "102000000000",
            ticks_per_second: 100,
            started_at: "2026-10-20T12:00:01.000Z",
          },
          launch_ancestry: [
            { pid: 4, parent_pid: 3, creation_ticks: "10100" },
            { pid: 3, parent_pid: 2, creation_ticks: "10050" },
          ],
          launch_root: {
            pid: 3,
            parent_pid: 2,
            uid: 1002,
            image: "/native/application.AppImage",
            image_sha256: prepared.request.candidate.package.sha256,
            creation_ticks: "10050",
            creation_clock: {
              realtime_ns: String(BigInt(Date.parse("2026-10-20T12:00:02.000Z")) * 1000000n),
              boottime_ns: "102000000000",
              ticks_per_second: 100,
              started_at: "2026-10-20T12:00:00.500Z",
            },
          },
          loaded_libraries: [{ path: "/usr/lib/libwebkit2gtk-4.1.so.0", sha256: "e".repeat(64) }],
        },
      },
    },
    capture: {
      outcome: "completed",
      request_sha256: prepared.request_sha256,
      roots: [1, 2].map((index) => ({
        id: `namespace-${index}`,
        role: "driver",
        image: { pid: 1, sha256: binding.tools.python!.sha256 },
        creation: rootCreation,
        teardown: {
          root_pid: 1,
          root_creation: rootCreation,
          root_exited: true,
          job_empty: true,
          remaining_pids: [],
          exit_code: 0,
        },
      })),
      harness: { ...prepared.request.expected.producer.harness, exit_code: 0 },
      group: { empty: true, remaining_pids: [], observed_at: end },
    },
    evidence_sha256: "f".repeat(64),
  };
  return { base, config, prepared, input, start };
}

async function linuxPostFixture(initial: boolean) {
  const f = await linuxFixture();
  const predecessor = {
    ...f.prepared.request.candidate,
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    run_id: "55",
    artifact_id: 99,
    package: {
      ...f.prepared.request.candidate.package,
      filename: "Portcove_0.0.1_amd64.AppImage",
      sha256: "3".repeat(64),
    },
  };
  const signed = { signed_context_sha256: "d".repeat(64), signatures_sha256: "e".repeat(64) };
  const journey = initial
    ? {
        kind: "initial-empty-feed",
        metadata_bootstrap_sha256: "a".repeat(64),
        setup_plan_sha256: "b".repeat(64),
        initial_site_preimage_sha256: "c".repeat(64),
        empty_records_sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        ...signed,
      }
    : { predecessor, ...signed };
  const prepared = prepareNativeStageRequest(
    {
      schema_version: 1,
      stage: "release-publication",
      platform_label: "linux-x86_64",
      candidate: f.prepared.request.candidate,
      journey,
      invocation_id: f.prepared.request.invocation_id,
      setup_descriptor_sha256: f.prepared.request.setup_descriptor_sha256,
    },
    {
      ...f.config,
      schema_version: 2,
      native_prepublication_profile: "signed-package-compatibility-v1",
    },
  );
  const stamp = (milliseconds: number) =>
    new Date(Date.parse(f.start) + milliseconds).toISOString();
  const entries = (initial ? ["candidate"] : ["predecessor", "candidate", "rollback"]).map(
    (id, index) => {
      const runtime = structuredClone(f.input.runtime),
        native = structuredClone(f.input.native),
        restart = structuredClone(f.input.restart);
      const offset = index * 6000;
      const identity =
        id === "candidate" ? prepared.request.candidate.package : predecessor.package;
      native.executable.sha256 = identity.sha256;
      runtime.core.product_version = id === "candidate" ? f.input.version : "0.0.1";
      runtime.runtime.observed_at = stamp(offset + 2000);
      runtime.runtime.process.launch_root.image_sha256 = identity.sha256;
      for (const process of [runtime.runtime.process, runtime.runtime.process.launch_root]) {
        process.creation_ticks = String(BigInt(process.creation_ticks) + BigInt(offset / 10));
        process.creation_clock.realtime_ns = String(
          BigInt(process.creation_clock.realtime_ns) + BigInt(offset) * 1000000n,
        );
        process.creation_clock.boottime_ns = String(
          BigInt(process.creation_clock.boottime_ns) + BigInt(offset) * 1000000n,
        );
        process.creation_clock.started_at = new Date(
          Date.parse(process.creation_clock.started_at) + offset,
        ).toISOString();
      }
      runtime.runtime.process.launch_ancestry[0]!.creation_ticks =
        runtime.runtime.process.creation_ticks;
      runtime.runtime.process.launch_ancestry[1]!.creation_ticks =
        runtime.runtime.process.launch_root.creation_ticks;
      restart[0]!.session_delete_completed = stamp(offset + 3000);
      restart[0]!.connected = stamp(offset + 4000);
      const prior = index
        ? id === "rollback"
          ? prepared.request.candidate.package
          : predecessor.package
        : null;
      const packageBytes = { bytes: identity.bytes, sha256: identity.sha256 };
      return {
        id,
        package: packageBytes,
        binding_sha256: f.input.binding_sha256,
        replacement: {
          schema_version: 1,
          step: id,
          slot: id === "candidate" ? "candidate" : "predecessor",
          previous: prior ? { bytes: prior.bytes, sha256: prior.sha256 } : null,
          installed: packageBytes,
          active_identity: { device: "1", inode: String(index + 1) },
          authority: "none",
          scope: "portable package replacement only",
        },
        before_preferences_sha256: index ? "a".repeat(64) : null,
        after_preferences_sha256: "a".repeat(64),
        preferences_capture: `package-${id}.preferences.bin`,
        preferences_capture_sha256: "a".repeat(64),
        native,
        runtime,
        restart,
        started_at: stamp(offset),
        completed_at: stamp(offset + 5000),
      };
    },
  );
  const candidate = entries.find((entry) => entry.id === "candidate")!;
  const input = {
    ...structuredClone(f.input),
    native: candidate.native,
    runtime: candidate.runtime,
    restart: candidate.restart,
    publication: {
      payload_cryptography: {
        file: "native-payload-result.json",
        sha256: "f".repeat(64),
        ...signed,
      },
      predecessor_version: initial ? null : "0.0.1",
      entries,
    },
  };
  input.outer.stage_request_sha256 = prepared.request_sha256;
  input.driver.stage_request_sha256 = prepared.request_sha256;
  input.capture.request_sha256 = prepared.request_sha256;
  input.outer.completed_at = stamp(entries.length * 6000);
  input.capture.group.observed_at = input.outer.completed_at;
  input.capture.roots = Array.from({ length: entries.length * 2 }, (_, index) => ({
    ...structuredClone(f.input.capture.roots[index % 2]!),
    id: `namespace-${index}`,
  }));
  return { ...f, prepared, input };
}

void test("inert Linux report2 reconstructs initial or real distinct predecessor package lifecycle without public-updater credit", async () => {
  for (const initial of [true, false]) {
    const f = await linuxPostFixture(initial);
    const result = reconstructNativeLinuxPostSignReport(f.prepared, f.input, f.base.source);
    assert.equal(result.report.schema_version, 2);
    assert.equal(result.report.runtime.started_at, "2026-10-20T12:00:00.500Z");
    assert.ok("pending_obligations" in result.report);
    assert.deepEqual(result.report.pending_obligations, [
      "ordinary-public-discovery-and-download",
      "ordinary-updater-journal-and-recovery",
      "ordinary-public-manifest-journey",
    ]);
    assert.equal(result.authority, "none");
    await assert.rejects(prepareActualLinuxNativeStageReport(result));
    for (const mutate of [
      (v: typeof f.input) => {
        v.publication.payload_cryptography.signatures_sha256 = "0".repeat(64);
      },
      (v: typeof f.input) => {
        v.publication.entries[0]!.runtime.runtime.process.launch_root.image_sha256 = "0".repeat(64);
      },
      (v: typeof f.input) => {
        v.publication.entries[0]!.replacement.installed.sha256 = "0".repeat(64);
      },
      (v: typeof f.input) => {
        v.publication.entries[0]!.preferences_capture_sha256 = "0".repeat(64);
      },
      (v: typeof f.input) => {
        v.publication.entries[0]!.runtime.core.product_version = "unrelated";
      },
      (v: typeof f.input) => {
        v.publication.entries[0]!.started_at = v.outer.completed_at;
      },
      (v: typeof f.input) => {
        v.publication.entries[0]!.completed_at = v.started_at;
      },
      (v: typeof f.input) => {
        v.publication.entries.pop();
      },
      (v: typeof f.input) => {
        v.capture.roots.pop();
      },
    ]) {
      const changed = structuredClone(f.input);
      mutate(changed);
      assert.throws(() => reconstructNativeLinuxPostSignReport(f.prepared, changed, f.base.source));
    }
    if (!initial) {
      const changed = structuredClone(f.input);
      changed.publication.entries[2]!.after_preferences_sha256 = "0".repeat(64);
      assert.throws(() => reconstructNativeLinuxPostSignReport(f.prepared, changed, f.base.source));
    }
  }
});

void test("inert Linux reconstruction binds actual-shaped source/host/process/namespace proofs without importing capture authority", async () => {
  const { base, prepared, input, start } = await linuxFixture();
  const result = reconstructNativeLinuxPreSignReport(prepared, input, base.source);
  assert.equal(result.authority, "none");
  assert.equal(result.report.host.loaded_engine.version, "2.52.6");
  assert.equal(result.report.runtime.root_creation.kind, "linux-starttime-ticks");
  assert.equal(result.report.runtime.root_pid, 3);
  assert.equal(result.report.runtime.root_creation.value, "10050");
  const changes = [
    (v: typeof input) => {
      v.runtime.runtime.process.launch_root.image_sha256 = "c".repeat(64);
    },
    (v: typeof input) => {
      v.runtime.runtime.process.launch_root.image = "/native/unrelated";
    },
    (v: typeof input) => {
      v.runtime.runtime.process.launch_ancestry[0]!.parent_pid = 2;
    },
    (v: typeof input) => {
      v.runtime.runtime.process.launch_root.uid = 0;
    },
    (v: typeof input) => {
      v.outer.cgroup_empty = false;
    },
    (v: typeof input) => {
      v.host.machine_id_sha256 = "f".repeat(64);
    },
    (v: typeof input) => {
      v.host.kernel_release = "6.6.87.2";
    },
    (v: typeof input) => {
      v.runtime.browser.version = "2.50.0";
    },
    (v: typeof input) => {
      v.runtime.runtime.process.uid = 0;
    },
    (v: typeof input) => {
      v.runtime.runtime.process.creation_clock.started_at = start;
    },
    (v: typeof input) => {
      v.runtime.core.schema_version = 1;
    },
    (v: typeof input) => {
      v.restart[0]!.preference_preserved = false;
    },
    (v: typeof input) => {
      v.capture.roots[0]!.teardown.job_empty = false;
    },
  ];
  for (const change of changes) {
    const value = structuredClone(input);
    change(value);
    assert.throws(() => reconstructNativeLinuxPreSignReport(prepared, value, base.source));
  }
  await assert.rejects(prepareActualLinuxNativeStageReport({ capture: input }));
  await assert.rejects(requireActualLinuxNativeStageReport({ report: result.report }));
});

void test("pre-sign reconstruction joins exact installed/host/runtime facts and source declarations without direct provenance", async () => {
  const f = await fixture(),
    result = reconstructNativePreSignReport(f.prepared, f.evidence, f.source);
  assert.equal(result.authority, "none");
  assert.equal(result.report.stage, "payload-signing");
  assert.equal(result.report.host.loaded_engine.version, "155.0.4283.62");
  assert.deepEqual(result.report.compatibility.cli_protocol, f.source.cli_protocol);
  assert.equal(
    result.report.compatibility.cli_protocol.min,
    f.evidence.runtime.core.schema_version,
  );
  assert.deepEqual(
    result.report.scenarios.map((value) => value.name),
    f.prepared.request.required_scenarios,
  );
  assert.equal(result.report.host.execution_context, "native-windows11-26h2-account");
  const ownHive = structuredClone(f.evidence);
  const ownSid = ownHive.installer.details.registration_path.match(/HKEY_USERS\\([^\\]+)\\/u)?.[1];
  assert.ok(ownSid);
  Object.assign(ownHive.installer.details, {
    registration_account_sid: ownSid,
  });
  ownHive.installer.details.registration_path =
    "Microsoft.PowerShell.Core\\Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Portcove";
  reconstructNativePreSignReport(f.prepared, ownHive, f.source);
  Object.assign(ownHive.installer.details, { registration_account_sid: "S-1-5-21-1-2-3-9999" });
  assert.throws(() => reconstructNativePreSignReport(f.prepared, ownHive, f.source));
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
    {
      ...e,
      runtime: {
        ...e.runtime,
        core: { ...e.runtime.core, schema_version: f.source.cli_protocol.min - 1 },
      },
    },
    {
      ...e,
      runtime: {
        ...e.runtime,
        core: { ...e.runtime.core, schema_version: f.source.cli_protocol.max + 1 },
      },
    },
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
      cli_protocol: { min: f.source.cli_protocol.min - 1, max: f.source.cli_protocol.min - 1 },
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
