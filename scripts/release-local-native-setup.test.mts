import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  inspectLocalNativeSetup,
  readPinnedLocalNativeSetup,
  requirePinnedLocalNativeSetup,
  renderLinuxNativeWorkerUnit,
  requireActualLinuxNativeScheduler,
  observeActualLinuxNativeScheduler,
} from "./release-local-native-setup.mts";

function fixture(windows = true) {
  const root = windows ? "C:\\Owned" : "/owned";
  const paths = windows ? path.win32 : path.posix;
  return {
    schema_version: 1,
    kind: "fixed-native-parent",
    controller_revision: "a".repeat(40),
    setup_grant_sha256: "b".repeat(64),
    namespace: "portcove-fixture",
    platform_label: windows ? "windows-x86_64" : "linux-x86_64",
    authority_configuration: { path: paths.join(root, "authorities.json"), sha256: "c".repeat(64) },
    native_boundary_configuration: {
      path: paths.join(root, "boundary.json"),
      sha256: "d".repeat(64),
    },
    scheduler_identity: {
      kind: windows ? "windows-task" : "systemd-user-unit",
      name: windows ? "\\Portcove\\NativeQualification" : "portcove-native-worker.service",
    },
    capture_root: paths.join(root, "capture"),
  };
}

void test("native installed descriptor binds fixed scheduler/platform and refuses supplied authority, aliases and foreign routes", () => {
  for (const windows of [true, false]) {
    const raw = fixture(windows);
    const selected = inspectLocalNativeSetup(raw);
    assert.equal(selected.scheduler_identity.name, raw.scheduler_identity.name);
    for (const changed of [
      { ...raw, accepted: true },
      { ...raw, issuer_key: "arbitrary" },
      { ...raw, controller_revision: "a".repeat(39) },
      { ...raw, namespace: "../foreign" },
      { ...raw, scheduler_identity: { ...raw.scheduler_identity, name: "foreign" } },
      { ...raw, scheduler_identity: { ...raw.scheduler_identity, kind: "github-actions" } },
      { ...raw, authority_configuration: { path: "relative", sha256: "c".repeat(64) } },
      { ...raw, capture_root: windows ? "C:\\Owned\\..\\capture" : "/owned/../capture" },
      { ...raw, capture_root: windows ? "\\\\server\\capture" : "https://foreign/" },
    ])
      assert.throws(() => inspectLocalNativeSetup(changed));
    raw.authority_configuration.sha256 = "e".repeat(64);
    assert.equal(selected.authority_configuration.sha256, "c".repeat(64));
  }
});

void test("imported setup cannot acquire private custody; wrong actual file identity refuses before scheduler or native launch", async (t) => {
  await assert.rejects(
    requireActualLinuxNativeScheduler({ kind: "actual-linux-native-scheduler" }),
    /actual Linux/,
  );
  await assert.rejects(
    observeActualLinuxNativeScheduler({ kind: "local-native-setup-byte-custody" }),
    /actual pinned/,
  );
  await assert.rejects(
    requirePinnedLocalNativeSetup({
      kind: "local-native-setup-byte-custody",
      descriptor_sha256: "a".repeat(64),
    }),
    /actual pinned/,
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "native-setup-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "setup.json");
  await writeFile(file, JSON.stringify(fixture()), { mode: 0o600 });
  // Linux may refuse the shared temporary ancestor first; neither route can
  // supply task/unit custody or release credentials from this inert fixture.
  await assert.rejects(
    readPinnedLocalNativeSetup(file, "f".repeat(64)),
    /bytes changed|ownership or ancestry/,
  );
});

void test("Linux native unit preparation fixes ordinary oneshot, action, finite timeout and complete-tree termination without installation", () => {
  const unit = renderLinuxNativeWorkerUnit(
    "/owned/node",
    "/owned/controller",
    "/owned/setup.json",
    "a".repeat(64),
  );
  assert.match(unit, /Type=oneshot\n/u);
  assert.match(
    unit,
    /ExecStart=\/owned\/node \/owned\/controller\/scripts\/release-native-worker.mts \/owned\/setup.json a{64}\n/u,
  );
  assert.match(unit, /TimeoutStartSec=2100\n/u);
  assert.match(unit, /KillMode=control-group\nRestart=no\n/u);
  for (const value of ["/owned/%h", "/owned/a b", "/owned/x\ny", "/owned/../node"])
    assert.throws(() =>
      renderLinuxNativeWorkerUnit(value, "/owned/controller", "/owned/setup.json", "a".repeat(64)),
    );
});
