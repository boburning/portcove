import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectPublicNativeLinuxBinding,
  planPublicNativeLinuxCommand,
} from "../apps/desktop/scripts/native-linux-public-plan.mts";

function fixture() {
  const invocation = "a".repeat(64),
    root = "/home/qualification/portcove-native";
  const attempt = `${root}/invocations/${invocation}`;
  return {
    schema_version: 1,
    session: {
      schema_version: 1,
      invocation_id: invocation,
      linux_root: root,
      account: { uid: 1001, gid: 1001 },
      application: {
        path: `${attempt}/install/Portcove.AppImage`,
        bytes: 100,
        sha256: "b".repeat(64),
      },
      controller: {
        root: `${root}/controller`,
        source_commit: "c".repeat(40),
        source_tree: "d".repeat(40),
        init_sha256: "e".repeat(64),
      },
      tools: Object.fromEntries(
        Object.entries({
          bwrap: "/usr/bin/bwrap",
          driver: `${root}/tools/tauri-driver`,
          git: "/usr/bin/git",
          node: `${root}/tools/node`,
          python: "/usr/bin/python3",
          webkit_driver: "/usr/bin/WebKitWebDriver",
          xvfb: "/usr/bin/Xvfb",
        }).map(([name, path]) => [name, { path, sha256: "f".repeat(64) }]),
      ),
      unit: {
        name: `portcove-native-${invocation}.service`,
        invocation_id: "a".repeat(32),
        control_group: `/user.slice/user-1001.slice/user@1001.service/app.slice/portcove-native-${invocation}.service`,
      },
      capture_root: `${attempt}/capture`,
      home: `${attempt}/work/home`,
      deadline_utc: "2026-11-01T00:00:00.000Z",
    },
    candidate: { path: `${attempt}/bank/Candidate.AppImage`, bytes: 200, sha256: "1".repeat(64) },
    retained_state_bytes: 1024,
    source: {
      fuse_sha256: "2".repeat(64),
      network_sha256: "3".repeat(64),
      services_sha256: "4".repeat(64),
    },
    network: {
      metadata_base_url: "https://boburning.github.io/portcove/application/metadata/",
      targets_base_url: "https://boburning.github.io/portcove/application/targets/",
      addresses: {
        "boburning.github.io": ["185.199.108.153"],
        "github.com": ["140.82.112.3"],
        "release-assets.githubusercontent.com": ["185.199.108.133"],
      },
    },
  };
}

void test("ordinary updater plan exposes only bounded state/install and fixed public/FUSE setup", () => {
  const input = fixture();
  const binding = inspectPublicNativeLinuxBinding(input);
  const plan = planPublicNativeLinuxCommand(
    input,
    `${input.session.capture_root}/namespace-12345678-1234-1234-1234-123456789abc.json`,
  );
  assert.equal(binding.authority, "none");
  assert.equal(plan.authority, "none");
  assert.equal(binding.required_writable_bytes, 16 * 1024 * 1024 + 1524);
  assert.deepEqual(plan.inherited_fuse_descriptors, [7, 8, 9, 10, 11, 12, 13, 14]);
  const binds = plan.arguments.flatMap((argument, index) =>
    argument === "--bind" ? [plan.arguments.slice(index, index + 3)] : [],
  );
  assert.deepEqual(binds, [
    ["--bind", binding.installation, "/native/installation"],
    ["--bind", binding.state, binding.state],
  ]);
  assert.ok(!plan.arguments.includes("/native/application.AppImage"));
  assert.ok(!plan.arguments.includes("/dev/fuse"));
  assert.ok(!plan.arguments.includes("--preserve-fds"));
  assert.equal(plan.arguments.filter((value) => value === "CAP_SYS_ADMIN").length, 1);
  input.network.addresses["github.com"][0] = "1.1.1.1";
  assert.equal(binding.network.addresses["github.com"]![0], "140.82.112.3");
});

void test("ordinary namespace data refuses unknown roots, package swaps and overflowing fixed storage", () => {
  for (const alter of [
    (value: ReturnType<typeof fixture>) => {
      value.candidate.path = "/tmp/candidate";
    },
    (value: ReturnType<typeof fixture>) => {
      value.candidate.sha256 = value.session.application.sha256;
    },
    (value: ReturnType<typeof fixture>) => {
      value.candidate.bytes = 256 * 1024 * 1024;
    },
    (value: ReturnType<typeof fixture>) => {
      value.retained_state_bytes = -1;
    },
    (value: ReturnType<typeof fixture>) => {
      value.network.metadata_base_url = "https://example.com/";
    },
    (value: ReturnType<typeof fixture>) => {
      value.network.addresses["github.com"] = ["127.0.0.1"];
    },
    (value: ReturnType<typeof fixture>) => {
      value.network.addresses["github.com"] = ["1.1.1.1", "1.1.1.1"];
    },
    (value: ReturnType<typeof fixture>) => {
      value.session.home = "/unbounded/home";
    },
  ]) {
    const input = fixture();
    alter(input);
    assert.throws(() => inspectPublicNativeLinuxBinding(input));
  }
});
