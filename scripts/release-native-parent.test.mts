import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectWindowsNativeParentSetup,
  requireActualNativeParent,
} from "./release-native-parent.mts";
import { inspectLocalNativeTransport } from "./release-local-native-setup.mts";
import { nativeAuthorityConfigurationFixture } from "./fixtures/native-authority-configuration-fixture.mts";

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
  ])
    assert.throws(() => inspectLocalNativeTransport(raw, "windows-x86_64"));
});
