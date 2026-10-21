import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectIsolatedNativeLinuxBinding,
  planIsolatedNativeLinuxCommand,
} from "../apps/desktop/scripts/native-linux-isolated-plan.mts";

function fixture() {
  const id = "a".repeat(64),
    root = "/home/qualification/portcove-native",
    attempt = `${root}/invocations/${id}`;
  return {
    schema_version: 1,
    invocation_id: id,
    linux_root: root,
    account: { uid: 1001, gid: 1001 },
    application: {
      path: `${attempt}/install/Portcove.AppImage`,
      bytes: 123,
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
      }).map(([key, path]) => [key, { path, sha256: "f".repeat(64) }]),
    ),
    unit: {
      name: `portcove-native-${id}.service`,
      invocation_id: "a".repeat(32),
      control_group: `/user.slice/user-1001.slice/user@1001.service/app.slice/portcove-native-${id}.service`,
    },
    capture_root: `${attempt}/capture`,
    home: `${attempt}/work/home`,
    deadline_utc: "2026-11-01T00:00:00.000Z",
  };
}
void test("isolated Linux plan exposes only selected package/data and fixed readonly tools", () => {
  const input = fixture(),
    inspected = inspectIsolatedNativeLinuxBinding(input);
  const plan = planIsolatedNativeLinuxCommand(
    input,
    `${input.capture_root}/namespace-12345678-1234-1234-1234-123456789abc.json`,
  );
  assert.equal(plan.authority, "none");
  assert.ok(Object.isFrozen(inspected.tools));
  assert.ok(plan.arguments.includes("--as-pid-1"));
  assert.ok(plan.arguments.includes("--cap-drop"));
  assert.ok(!plan.arguments.includes("--preserve-fds")); // Not a supported bubblewrap option.
  assert.ok(
    !plan.arguments.some((value) =>
      /\/mnt\/|\/run\/user|disable.*sandbox|--disable-userns/u.test(value),
    ),
  );
  assert.equal(plan.arguments.filter((value) => value === "--bind").length, 1);
  assert.ok(
    plan.arguments.includes(String(512 * 1024 * 1024)) &&
      plan.arguments.includes(String(64 * 1024 * 1024)),
  );
  input.account.uid = 0;
  assert.equal(inspected.account.uid, 1001);
});
void test("isolated Linux plan refuses account, cgroup, path, source and tool substitutions", () => {
  for (const alter of [
    (v: ReturnType<typeof fixture>) => {
      v.account.uid = 0;
    },
    (v: ReturnType<typeof fixture>) => {
      v.home = v.capture_root;
    },
    (v: ReturnType<typeof fixture>) => {
      v.application.path = "/mnt/c/untrusted.AppImage";
    },
    (v: ReturnType<typeof fixture>) => {
      v.tools.python!.path = "/tmp/python";
    },
    (v: ReturnType<typeof fixture>) => {
      v.unit.control_group = "/system.slice/other.service";
    },
    (v: ReturnType<typeof fixture>) => {
      v.controller.source_tree = "missing";
    },
    (v: ReturnType<typeof fixture>) => {
      v.deadline_utc = "2026-02-30T00:00:00.000Z";
    },
  ]) {
    const input = fixture();
    alter(input);
    assert.throws(() => inspectIsolatedNativeLinuxBinding(input));
  }
  assert.throws(() => planIsolatedNativeLinuxCommand(fixture(), "/tmp/config.json"));
});
