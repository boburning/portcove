import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { createHostedWindowsNativeProofStore } from "./release-owned-windows-proof-store.mts";
import { windowsSourceSystemExecutables } from "./release-native-runtime-custody.mts";

function proofParent(context: test.TestContext, foreignWritable = false) {
  const outer = disposableDirectory(context, path.join(homedir(), ".pc-windows-proof-")),
    root = path.join(outer, "private"),
    script =
      "$ErrorActionPreference='Stop';Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:PORTCOVE_PROOF_TEST_SETUP));[Portcove.HostedNative.Setup]::Directory($env:PORTCOVE_PROOF_TEST_ROOT,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value,$env:PORTCOVE_PROOF_TEST_FOREIGN,($env:PORTCOVE_PROOF_TEST_FOREIGN -ne ''))";
  execFileSync(
    windowsSourceSystemExecutables.powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      timeout: 15000,
      windowsHide: true,
      stdio: "pipe",
      env: {
        ...process.env,
        PORTCOVE_PROOF_TEST_ROOT: root,
        PORTCOVE_PROOF_TEST_FOREIGN: foreignWritable ? "S-1-5-32-545" : "",
        PORTCOVE_PROOF_TEST_SETUP: fileURLToPath(
          new URL("./release-hosted-native-windows-setup.cs.txt", import.meta.url),
        ),
      },
    },
  );
  return root;
}

void test("Windows proof storage refuses an unsupported host or path before creating an attempt", async (context) => {
  const root = disposableDirectory(context, path.join(tmpdir(), "pc-windows-proof-")),
    target = path.join(root, "attempt") + (process.platform === "win32" ? ":stream" : "");
  await assert.rejects(createHostedWindowsNativeProofStore(target));
  assert.equal(existsSync(target), false);
});

void test(
  "Windows proof storage exclusively flushes bounded public records and never adopts attempts",
  {
    skip: process.platform !== "win32",
  },
  async (context) => {
    const root = proofParent(context),
      target = path.join(root, "attempt"),
      store = await createHostedWindowsNativeProofStore(target);
    await store.write("subject.json", Buffer.from("{}\n"));
    const capture = Buffer.alloc(128 * 1024 + 1, 32);
    await store.write("capture.json", capture);
    assert.equal(readFileSync(path.join(target, "subject.json"), "utf8"), "{}\n");
    assert.deepEqual(readFileSync(path.join(target, "capture.json")), capture);
    await assert.rejects(createHostedWindowsNativeProofStore(target));
    await assert.rejects(store.write("subject.json", Buffer.from("overwrite")));
    await assert.rejects(store.write("later.json", Buffer.from("{}")), /stopped/);
    assert.equal(readFileSync(path.join(target, "subject.json"), "utf8"), "{}\n");
  },
);

void test(
  "Windows proof storage detects prior-file and directory substitution and retains partial attempts",
  {
    skip: process.platform !== "win32",
  },
  async (context) => {
    const root = proofParent(context),
      target = path.join(root, "attempt"),
      store = await createHostedWindowsNativeProofStore(target);
    await store.write("subject.json", Buffer.from("first"));
    writeFileSync(path.join(target, "subject.json"), "other");
    await assert.rejects(store.write("bundle.json", Buffer.from("{}")));
    assert.equal(existsSync(path.join(target, "bundle.json")), false);
    const second = path.join(root, "second"),
      other = await createHostedWindowsNativeProofStore(second);
    renameSync(second, second + "-retained");
    mkdirSync(second);
    await assert.rejects(other.write("subject.json", Buffer.from("{}")));
    assert.equal(existsSync(path.join(second, "subject.json")), false);
    assert.ok(existsSync(path.join(second + "-retained", "store-created.json")));
  },
);

void test(
  "Windows proof storage refuses a deliberately foreign-writable fixture and nonlocal paths",
  { skip: process.platform !== "win32" },
  async (context) => {
    const root = proofParent(context, true);
    const target = path.join(root, "attempt");
    await assert.rejects(createHostedWindowsNativeProofStore(target), /foreign writer/);
    assert.ok(existsSync(path.join(target, "store-created.json")));
    for (const invalid of [
      "\\\\server\\share\\attempt",
      "\\\\?\\C:\\attempt",
      "C:\\attempt:stream",
    ])
      await assert.rejects(createHostedWindowsNativeProofStore(invalid), /canonical local/);
  },
);

void test(
  "Windows proof storage permanently refuses concurrent writes including the in-flight result",
  { skip: process.platform !== "win32" },
  async (context) => {
    const root = proofParent(context),
      store = await createHostedWindowsNativeProofStore(path.join(root, "attempt"));
    const results = await Promise.allSettled([
      store.write("subject.json", Buffer.from("{}")),
      store.write("bundle.json", Buffer.from("{}")),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["rejected", "rejected"],
    );
    await assert.rejects(store.write("later.json", Buffer.from("{}")), /stopped/);
    assert.equal(existsSync(path.join(root, "attempt", "bundle.json")), false);
    assert.equal(existsSync(path.join(root, "attempt", "later.json")), false);
  },
);

void test(
  "Windows proof storage refuses oversized and escaping records before writing",
  {
    skip: process.platform !== "win32",
  },
  async (context) => {
    const root = proofParent(context);
    for (const [index, name, bytes] of [
      [0, "subject.json", Buffer.alloc(128 * 1024 + 1)],
      [1, "capture.json", Buffer.alloc(128 * 1024 + 2)],
      [2, "../escape.json", Buffer.from("{}")],
      [3, "store-created.json", Buffer.from("{}")],
      [4, "con.json", Buffer.from("{}")],
    ] as const) {
      const target = path.join(root, String(index)),
        store = await createHostedWindowsNativeProofStore(target);
      await assert.rejects(store.write(name, bytes), /boundary/);
      await assert.rejects(store.write("later.json", Buffer.from("{}")), /stopped/);
      assert.equal(existsSync(path.join(target, "later.json")), false);
    }
    assert.equal(existsSync(path.join(root, "escape.json")), false);
  },
);
