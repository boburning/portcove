import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectPublicNativeLinuxBinding,
  planPublicNativeLinuxCommand,
} from "../apps/desktop/scripts/native-linux-public-plan.mts";

import {
  inspectNativeLinuxPublicStagePlan,
  inspectNativeLinuxStagePlan,
} from "./release-native-linux-driver.mts";

function fixture() {
  const invocation = "a".repeat(64),
    root = "/home/qualification/portcove-native";
  const attempt = `${root}/invocations/${invocation}`;
  return {
    schema_version: 1,
    phase: "initial-v0-v1",
    profile_id: "client-a",
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
    candidate: {
      path: `${attempt}/packages/Candidate.AppImage`,
      bytes: 200,
      sha256: "1".repeat(64),
    },
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
    ["--bind", binding.state, binding.profile_home],
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

void test("fixed guest dispatch requires explicit public schema and cannot reinterpret a legacy native stage", () => {
  const input = fixture();
  const raw = {
    schema_version: 3,
    stage: "ordinary-public-update",
    binding: input.session,
    invocation_id: input.session.invocation_id,
    stage_request_sha256: "5".repeat(64),
    public_journey: {
      candidate: input.candidate,
      phase: input.phase,
      profile_id: input.profile_id,
      source: input.source,
      network: input.network,
      retained_state_bytes: input.retained_state_bytes,
      versions: { prior: "1.0.0-beta.1", candidate: "1.0.0-beta.2" },
    },
  };
  const parsed = inspectNativeLinuxPublicStagePlan(raw);
  assert.equal(parsed.binding.candidate.sha256, input.candidate.sha256);
  assert.deepEqual(parsed.versions, raw.public_journey.versions);
  assert.equal(parsed.binding.authority, "none");
  assert.throws(() => inspectNativeLinuxStagePlan(raw));
  for (const changed of [
    { ...raw, schema_version: 1 },
    { ...raw, stage: "release-publication" },
    { ...raw, invocation_id: "b".repeat(64) },
    {
      ...raw,
      public_journey: {
        ...raw.public_journey,
        versions: { prior: "1.0.0-beta.2", candidate: "1.0.0-beta.2" },
      },
    },
    {
      ...raw,
      public_journey: {
        ...raw.public_journey,
        network: { ...input.network, metadata_base_url: "https://other.invalid/" },
      },
    },
    { ...raw, public_journey: { ...raw.public_journey, accepted: true } },
  ])
    assert.throws(() => inspectNativeLinuxPublicStagePlan(changed));
  raw.public_journey.candidate.sha256 = "6".repeat(64);
  assert.equal(parsed.binding.candidate.sha256, "1".repeat(64));
});

void test("reopened namespaces keep stable profile meaning with distinct immutable policy leaves", () => {
  const input = fixture();
  const left = planPublicNativeLinuxCommand(
    input,
    `${input.session.capture_root}/namespace-12345678-1234-1234-1234-123456789abc.json`,
  );
  const right = planPublicNativeLinuxCommand(
    input,
    `${input.session.capture_root}/namespace-22345678-1234-1234-1234-123456789abc.json`,
  );
  const sources = (args: string[]) =>
    args.flatMap((part, index) =>
      part === "--ro-bind" &&
      /\.(?:fuse\.json|network\.json|hosts|nsswitch)$/u.test(args[index + 1]!)
        ? [args[index + 1]!]
        : [],
    );
  assert.equal(sources(left.arguments).length, 4);
  assert.equal(sources(right.arguments).length, 4);
  assert.equal(new Set([...sources(left.arguments), ...sources(right.arguments)]).size, 8);
  const next = fixture();
  next.session.invocation_id = "7".repeat(64);
  const text = JSON.stringify(next).replaceAll("a".repeat(64), "7".repeat(64));
  const restored = inspectPublicNativeLinuxBinding(JSON.parse(text));
  const initial = inspectPublicNativeLinuxBinding(input);
  assert.notEqual(initial.state, restored.state);
  assert.equal(initial.profile_home, restored.profile_home);
  assert.equal(initial.profile_home, "/native/profile/client-a");
  assert.throws(() => inspectPublicNativeLinuxBinding({ ...input, profile_id: "/caller/root" }));
});

void test("parked B profile is an explicit finite phase and cannot impersonate completed A", () => {
  const initial = fixture();
  const parked = inspectPublicNativeLinuxBinding({
    ...initial,
    phase: "park-v0-with-v1",
    profile_id: "client-b",
  });
  assert.equal(parked.phase, "park-v0-with-v1");
  assert.equal(parked.profile_home, "/native/profile/client-b");
  assert.throws(() => inspectPublicNativeLinuxBinding({ ...initial, phase: "park-v0-with-v1" }));
  assert.throws(() => inspectPublicNativeLinuxBinding({ ...initial, phase: "caller-accepted" }));
});
