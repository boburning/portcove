import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectWindowsNativeParentSetup,
  requireActualNativeParent,
  remainingNativeParentBudget,
} from "./release-native-parent.mts";
import { inspectLocalNativeTransport } from "./release-local-native-setup.mts";
import { nativeAuthorityConfigurationFixture } from "./fixtures/native-authority-configuration-fixture.mts";

void test("source, crypto, queue and native stages share the original finite parent lifetime without allocating a new clock", () => {
  assert.equal(remainingNativeParentBudget(1800000, 600000), 1470000);
  assert.equal(remainingNativeParentBudget(90000, 2020000), 50000);
  assert.equal(remainingNativeParentBudget(90000, 1000), 90000);
  for (const elapsed of [-1, NaN, Infinity, 2070000, 2070001])
    assert.throws(() => remainingNativeParentBudget(90000, elapsed));
  for (const maximum of [0, -1, NaN, Infinity])
    assert.throws(() => remainingNativeParentBudget(maximum, 1000));
});

void test("initial Windows tool configuration is exact and cannot overlap credentials or qualify Linux", () => {
  const f = fixture();
  const tool = (name: string) => ({
    path: `C:\\Portcove\\tools\\${name}.exe`,
    sha256: "a".repeat(64),
  });
  const windows_tools = {
    powershell: tool("pwsh"),
    git: tool("git"),
    desktop_tools: {
      node: tool("node"),
      tauri_driver: tool("tauri-driver"),
      webview_driver: tool("msedgedriver"),
    },
  };
  const transport = { ...f.transport_configuration, windows_tools };
  assert.deepEqual(
    inspectLocalNativeTransport(transport, "windows-x86_64").windows_tools,
    windows_tools,
  );
  for (const changed of [
    { ...transport, windows_tools: { ...windows_tools, unreviewed: "tool" } },
    {
      ...transport,
      windows_tools: { ...windows_tools, powershell: { ...tool("pwsh"), sha256: "unknown" } },
    },
    {
      ...transport,
      windows_tools: {
        ...windows_tools,
        git: { ...tool("git"), path: transport.source_read_token },
      },
    },
    {
      ...transport,
      windows_tools: {
        ...windows_tools,
        desktop_tools: { ...windows_tools.desktop_tools, node: tool("pwsh") },
      },
    },
  ])
    assert.throws(() => inspectLocalNativeTransport(changed, "windows-x86_64"));
  assert.throws(() => inspectLocalNativeTransport(transport, "linux-x86_64"));
});

void test("public source tool pins must also reside in the scheduler-observed private controller tree", () => {
  const f = fixture();
  const tool = (name: string) => ({
    path: `${f.controller_root}\\tools\\${name}.exe`,
    sha256: "a".repeat(64),
  });
  const windows_tools = {
    git: tool("git"),
    powershell: tool("pwsh"),
    desktop_tools: {
      node: tool("node"),
      tauri_driver: tool("tauri-driver"),
      webview_driver: tool("msedgedriver"),
    },
  };
  const raw = {
    ...f,
    descriptor: {
      ...f.descriptor,
      schema_version: 2,
      public_journey: {
        profile: "ordinary-public-initial-cohort-v1",
        public_build_inputs: {
          configuration_revision: "a".repeat(40),
          manifest_sha256: "b".repeat(64),
        },
      },
    },
    transport_configuration: {
      ...f.transport_configuration,
      windows_tools,
      post_sign_verifier: tool("release-tools"),
    },
  };
  assert.equal(inspectWindowsNativeParentSetup(raw).authority, "none");
  for (const transport_configuration of [
    {
      ...raw.transport_configuration,
      post_sign_verifier: { ...tool("release-tools"), path: "C:\\Mutable\\release-tools.exe" },
    },
    {
      ...raw.transport_configuration,
      windows_tools: { ...windows_tools, git: { ...tool("git"), path: "C:\\Mutable\\git.exe" } },
    },
  ])
    assert.throws(
      () => inspectWindowsNativeParentSetup({ ...raw, transport_configuration }),
      /protected controller tree/,
    );
  assert.equal(inspectWindowsNativeParentSetup(f).authority, "none");
});

function fixture() {
  const configurationPath = "C:\\Portcove\\setup\\descriptor.json",
    controller = "C:\\Portcove\\controller";
  const descriptor = {
    schema_version: 1,
    kind: "fixed-native-parent",
    controller_revision: "e".repeat(40),
    setup_grant_sha256: "1".repeat(64),
    namespace: "portcove-test",
    platform_label: "windows-x86_64",
    authority_configuration: {
      path: "C:\\Portcove\\setup\\authorities.json",
      sha256: "2".repeat(64),
    },
    native_boundary_configuration: {
      path: "C:\\Portcove\\setup\\boundary.json",
      sha256: "3".repeat(64),
    },
    scheduler_identity: { kind: "windows-task", name: "\\Portcove\\NativeQualification" },
    capture_root: "C:\\Portcove\\capture",
  };
  const transport = {
    schema_version: 1,
    source_read_token: "C:\\Portcove\\credentials\\read.token",
    github_cli: { path: "C:\\Portcove\\tools\\gh.exe", sha256: "4".repeat(64) },
    native_issuer: {
      private_key: "C:\\Portcove\\credentials\\native.pem",
      public_key_sha256: "4".repeat(64),
    },
  };
  const expectedPaths = {
    descriptor: configurationPath,
    installation: "C:\\Portcove\\setup\\installation.json",
    authorities: descriptor.authority_configuration.path,
    boundary: descriptor.native_boundary_configuration.path,
    controller,
    capture: descriptor.capture_root,
    native_issuer: transport.native_issuer.private_key,
    source_reader: transport.source_read_token,
    source_tool: transport.github_cli.path,
  };
  const scheduler = {
    task_path: descriptor.scheduler_identity.name,
    broker_sid: "S-1-5-21-1-2-3-1001",
    action: {
      path: "C:\\Portcove\\node.exe",
      arguments: `"${controller}\\scripts\\release-native-worker.mts" "${configurationPath}" ${"a".repeat(64)}`,
      working_directory: controller,
    },
    protected_paths: expectedPaths,
  };
  return {
    authority_configuration: nativeAuthorityConfigurationFixture(),
    boundary_configuration: {
      schema_version: 1,
      account_name: "PortcoveNativeQualification",
      account_sid: "S-1-5-21-1-2-3-1002",
      broker_sid: scheduler.broker_sid,
      capture_root: descriptor.capture_root,
      controller_root: controller,
      helper_sha256: "5".repeat(64),
      profile_root: "C:\\Users\\PortcoveNativeQualification",
      work_root: "C:\\Portcove\\work",
    },
    configuration_path: configurationPath,
    controller_root: controller,
    controller_tree: "f".repeat(40),
    descriptor,
    descriptor_sha256: "a".repeat(64),
    installation_path: expectedPaths.installation,
    installation_record: { scheduler },
    transport_configuration: transport,
  };
}

void test("pure native parent wiring cannot appoint imported provenance and binds the fixed action to exact setup, source and accounts", async () => {
  const f = fixture();
  const wired = inspectWindowsNativeParentSetup(f);
  assert.equal(wired.authority, "none");
  assert.equal(wired.scope, "integrity-only");
  await assert.rejects(requireActualNativeParent(wired), /provenance/);
  const changes: ((value: typeof f) => void)[] = [
    (value) => {
      value.controller_tree = "9".repeat(40);
    },
    (value) => {
      value.descriptor.controller_revision = "9".repeat(40);
    },
    (value) => {
      value.boundary_configuration.account_sid = value.boundary_configuration.broker_sid;
    },
    (value) => {
      value.boundary_configuration.controller_root = "C:\\unrelated";
    },
    (value) => {
      value.installation_record.scheduler.action.arguments += " --report imported.json";
    },
    (value) => {
      value.installation_record.scheduler.protected_paths.native_issuer =
        "C:\\Portcove\\work\\key.pem";
    },
    (value) => {
      value.installation_record.scheduler.task_path = "\\unrelated";
    },
  ];
  for (const change of changes) {
    const modified = structuredClone(f);
    change(modified);
    assert.throws(() => inspectWindowsNativeParentSetup(modified));
  }
});

void test("a fixed Windows task for a Linux package retains Windows broker and actual guest identity domains", async () => {
  const f = fixture();
  f.descriptor.platform_label = "linux-x86_64";
  f.descriptor.scheduler_identity.name = "\\Portcove\\NativeQualificationLinux";
  f.installation_record.scheduler.task_path = f.descriptor.scheduler_identity.name;
  const distribution = {
    name: "Ubuntu",
    registration_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    wsl_version: 2,
  };
  Object.assign(f.authority_configuration.native["linux-x86_64"]!.host.account, {
    kind: "windows-wsl-uid",
    broker: f.boundary_configuration.broker_sid,
    qualification: "1002",
    distribution,
  });
  const root = "/home/portcove-native/portcove-native";
  const value = {
    ...f,
    boundary_configuration: {
      schema_version: 1,
      broker_sid: f.boundary_configuration.broker_sid,
      distribution: { ...distribution },
      qualification_uid: "1002",
      qualification_gid: "1002",
      qualification_user: "portcove-native",
      controller_root: f.controller_root,
      capture_root: f.descriptor.capture_root,
      linux_root: root,
      supervisor_sha256: "7".repeat(64),
      tools: Object.fromEntries(
        Object.entries({
          bwrap: "/usr/bin/bwrap",
          git: "/usr/bin/git",
          python: "/usr/bin/python3",
          systemctl: "/usr/bin/systemctl",
          systemd_run: "/usr/bin/systemd-run",
          xvfb: "/usr/bin/Xvfb",
          webkit_driver: "/usr/bin/WebKitWebDriver",
          node: `${root}/tools/node`,
          tauri_driver: `${root}/tools/tauri-driver`,
          wsl: String.raw`C:\Windows\System32\wsl.exe`,
        }).map(([name, filename]) => [name, { path: filename, sha256: "8".repeat(64) }]),
      ),
    },
  };
  const observed = inspectWindowsNativeParentSetup(value);
  assert.equal(observed.authority, "none");
  assert.equal(observed.boundary.broker_sid, f.boundary_configuration.broker_sid);
  assert.equal(observed.scheduler.task_path, "\\Portcove\\NativeQualificationLinux");
  await assert.rejects(requireActualNativeParent(observed), /provenance/);
  for (const modify of [
    (input: typeof value) => {
      input.boundary_configuration.qualification_uid = "1003";
    },
    (input: typeof value) => {
      input.boundary_configuration.distribution.name = "Other";
    },
    (input: typeof value) => {
      input.installation_record.scheduler.task_path = "\\Portcove\\NativeQualification";
    },
    (input: typeof value) => {
      input.boundary_configuration.broker_sid = "1000";
    },
    (input: typeof value) => {
      input.descriptor.scheduler_identity.kind = "systemd-user-unit";
    },
  ]) {
    const changed = structuredClone(value);
    modify(changed);
    assert.throws(() => inspectWindowsNativeParentSetup(changed));
  }
});

void test("initial native transport separates source read custody and native issuer; cannot supply App identities or credential values", () => {
  const f = fixture(),
    transport = f.transport_configuration;
  assert.notEqual(
    inspectLocalNativeTransport(transport, "windows-x86_64").source_read_token,
    transport.native_issuer.private_key,
  );
  for (const raw of [
    { ...transport, source_read_token: transport.native_issuer.private_key },
    { ...transport, token: "caller-token" },
    { ...transport, native_issuer: { ...transport.native_issuer, app_id: 102 } },
    { ...transport, source_read_token: "relative-token" },
    { ...transport, github_cli: { ...transport.github_cli, path: "gh" } },
    { ...transport, github_cli: { ...transport.github_cli, sha256: "changed" } },
  ])
    assert.throws(() => inspectLocalNativeTransport(raw, "windows-x86_64"));
});
