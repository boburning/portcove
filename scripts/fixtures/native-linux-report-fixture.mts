/** Inert report composition data only; never actual runtime or issuer evidence. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { nativeQualificationFixture } from "./native-qualification-fixture.mts";
import { nativeAuthorityConfigurationFixture } from "./native-authority-configuration-fixture.mts";
import { inspectIsolatedNativeLinuxBinding } from "../../apps/desktop/scripts/native-linux-isolated-plan.mts";
import {
  nativeCompatibilitySourcePaths,
  inspectNativeCompatibilitySources,
} from "../release-native-source-contract.mts";
import { prepareNativeStageRequest } from "../release-native-stage-capture.mts";

type NativeSource = ReturnType<typeof inspectNativeCompatibilitySources>;

// Retained inert declaration input from f1f2d9a63f84814d7e0c78b6ad757a89285854ee.
// Golden report expectations remain independent and unchanged as current source evolves.
// This snapshot grants no runtime, signing or publication authority.
export const historicalApi82Library43SourceFixture: NativeSource = {
  cli_protocol: {
    min: 82,
    max: 82,
  },
  catalog_formats: [2],
  library: {
    read: {
      min: 1,
      max: 43,
    },
    write_schema: 43,
    lock_protocol: "library-lock-v1",
  },
  available_capabilities: ["library-lock-v1"],
  files: [
    {
      path: "crates/portcove-core/src/lib.rs",
      sha256: "4c79639e75267c6f2e9bb01e3f6fd72be6e0a48d565b691a0eede84a4919a552",
      bytes: 13065,
    },
    {
      path: "crates/portcove-core/src/database.rs",
      sha256: "d23281d9691e4fbe0f973ed5458ebd5dfd9bca48a3cea9fe51ad5920f2118270",
      bytes: 125854,
    },
    {
      path: "crates/portcove-core/catalog/catalog.json",
      sha256: "11befa61d06967031b71deaf1a31a285c18ce01d310373b0cc5864dd01a1ff6d",
      bytes: 1510902,
    },
    {
      path: "apps/desktop/src-tauri/src/application_update_windows.rs",
      sha256: "2bacc7db57d813303974db989725c75aa2dac949140d9dde406fb470ba177a45",
      bytes: 57726,
    },
  ],
  authority: "none",
  scope: "maintained source declarations only; runtime and acceptance independently required",
};

export async function nativePreSignReportFixture(retainedSource?: NativeSource) {
  const native = nativeQualificationFixture(),
    config = nativeAuthorityConfigurationFixture();
  config.native["windows-x86_64"]!.producer.harness.path = "scripts/release-native-worker.mts";
  const source =
    retainedSource ??
    inspectNativeCompatibilitySources(
      Object.fromEntries(
        await Promise.all(
          nativeCompatibilitySourcePaths.map(
            async (file) =>
              [file, await readFile(new URL(`../../${file}`, import.meta.url))] as const,
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

export async function nativeLinuxReportFixture(retainedSource?: NativeSource) {
  const base = await nativePreSignReportFixture(retainedSource),
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

export async function nativeLinuxPostSignReportFixture(
  initial: boolean,
  retainedSource?: NativeSource,
) {
  const f = await nativeLinuxReportFixture(retainedSource);
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
