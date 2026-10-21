import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  inspectLocalNativeSetup,
  inspectLocalNativeTransport,
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

void test("explicit WSL package setup retains Windows parent custody without inventing a Linux broker or desktop tool route", () => {
  const raw = {
    ...fixture(),
    platform_label: "linux-x86_64",
    scheduler_identity: {
      kind: "windows-task",
      name: "\\Portcove\\NativeQualificationLinux",
    },
  };
  const selected = inspectLocalNativeSetup(raw);
  assert.equal(selected.platform_label, "linux-x86_64");
  assert.equal(selected.capture_root, "C:\\Owned\\capture");
  const transport = {
    schema_version: 1,
    source_read_token: "C:\\Credentials\\source.txt",
    native_issuer: {
      private_key: "C:\\Credentials\\native.pem",
      public_key_sha256: "a".repeat(64),
    },
    github_cli: { path: "C:\\Tools\\gh.exe", sha256: "b".repeat(64) },
  };
  assert.deepEqual(
    inspectLocalNativeTransport(transport, "linux-x86_64", "windows-task"),
    transport,
  );
  assert.throws(() => inspectLocalNativeTransport(transport, "linux-x86_64"));
  for (const changed of [
    { ...raw, scheduler_identity: fixture().scheduler_identity },
    { ...raw, scheduler_identity: fixture(false).scheduler_identity },
    { ...raw, platform_label: "windows-x86_64" },
    { ...raw, capture_root: "/owned/capture" },
    { ...raw, authority_configuration: fixture(false).authority_configuration },
  ])
    assert.throws(() => inspectLocalNativeSetup(changed));
  assert.throws(() =>
    inspectLocalNativeTransport(
      { ...transport, windows_tools: {} },
      "linux-x86_64",
      "windows-task",
    ),
  );
  assert.throws(() =>
    inspectLocalNativeTransport(transport, "windows-x86_64", "systemd-user-unit"),
  );
});

void test("keyless native post-sign verifier is an exact protected installation tool pin, never a credential or candidate locator", () => {
  const input = {
    schema_version: 1,
    source_read_token: "C:\\Credentials\\source.txt",
    native_issuer: {
      private_key: "C:\\Credentials\\native.pem",
      public_key_sha256: "a".repeat(64),
    },
    github_cli: { path: "C:\\Tools\\gh.exe", sha256: "b".repeat(64) },
    post_sign_verifier: {
      path: "C:\\Owned\\tools\\portcove-release-tools.exe",
      sha256: "c".repeat(64),
    },
  };
  const actual = inspectLocalNativeTransport(input, "windows-x86_64");
  assert.deepEqual(actual.post_sign_verifier, input.post_sign_verifier);
  for (const verifier of [
    { ...input.post_sign_verifier, path: input.source_read_token },
    { ...input.post_sign_verifier, path: input.native_issuer.private_key },
    { ...input.post_sign_verifier, path: input.github_cli.path.toUpperCase() },
    { ...input.post_sign_verifier, path: "../candidate.exe" },
    { ...input.post_sign_verifier, sha256: "unobserved" },
    { ...input.post_sign_verifier, accepted: true },
  ])
    assert.throws(() =>
      inspectLocalNativeTransport({ ...input, post_sign_verifier: verifier }, "windows-x86_64"),
    );
  input.post_sign_verifier.sha256 = "d".repeat(64);
  assert.equal(actual.post_sign_verifier?.sha256, "c".repeat(64));
  const pin = (name: string) => ({ path: `C:\\Tools\\${name}.exe`, sha256: "e".repeat(64) });
  assert.throws(
    () =>
      inspectLocalNativeTransport(
        {
          ...input,
          post_sign_verifier: pin("git"),
          windows_tools: {
            git: pin("git"),
            powershell: pin("pwsh"),
            desktop_tools: {
              node: pin("node"),
              tauri_driver: pin("tauri-driver"),
              webview_driver: pin("webview-driver"),
            },
          },
        },
        "windows-x86_64",
      ),
    /overlaps an independently pinned desktop tool/,
  );
});

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

void test("imported setup cannot acquire private custody; wrong file or unavailable ordinary host refuses before native launch", async (t) => {
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
  // A hosted/root Linux process is deliberately refused before file access.
  // An ordinary local process may instead refuse the shared temporary ancestor
  // or exact bytes. None supplies task/unit custody from this inert fixture.
  const unavailableLocalHost =
    process.platform === "linux" &&
    (process.env.GITHUB_ACTIONS === "true" || process.getuid?.() === 0);
  await assert.rejects(
    readPinnedLocalNativeSetup(file, "f".repeat(64)),
    unavailableLocalHost
      ? /ordinary local Linux parent required/
      : /bytes changed|ownership or ancestry/,
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
