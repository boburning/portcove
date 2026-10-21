import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  retainNativeCaptureWire,
  hashRetainedNativeCaptureFile,
} from "./release-native-wsl-wire.mts";
import {
  inspectWslNativeDriverPlan,
  boundedNativeWslOperationTimeout,
  requireActualWslNativeCapture,
} from "./release-native-wsl-capture.mts";
void test("a retained hash cannot return usable bytes after its original clock expires during a read", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-capture-hash-clock-"));
  await writeFile(path.join(directory, "retained.bin"), Buffer.alloc(65536, 1));
  let now = 0;
  const clock = context.mock.method(performance, "now", () => (now += 100));
  try {
    await assert.rejects(
      hashRetainedNativeCaptureFile(directory, "retained.bin", 65536, 65536, 250),
      /original capture hash budget exhausted/u,
    );
    assert.ok(now >= 300);
  } finally {
    clock.mock.restore();
  }
});
void test("parked capture parsing refuses an exhausted original clock before opening or creating paths", async () => {
  await assert.rejects(
    retainNativeCaptureWire(
      "missing-original.wire",
      "must-not-create",
      "a".repeat(64),
      "b".repeat(64),
      performance.now() - 1,
    ),
    /original capture read budget exhausted/u,
  );
  await assert.rejects(
    retainNativeCaptureWire(
      "missing-original.wire",
      "must-not-create",
      "a".repeat(64),
      "b".repeat(64),
      Number.NaN,
    ),
    /original capture read budget exhausted/u,
  );
});
function fixture() {
  const id = "a".repeat(64),
    root = String.raw`E:\Portcove\controller`,
    capture = String.raw`E:\Portcove\native-capture`,
    linux = "/home/qualification/portcove-native";
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
  const paths = {
    bwrap: "/usr/bin/bwrap",
    git: "/usr/bin/git",
    python: "/usr/bin/python3",
    systemctl: "/usr/bin/systemctl",
    systemd_run: "/usr/bin/systemd-run",
    xvfb: "/usr/bin/Xvfb",
    webkit_driver: "/usr/bin/WebKitWebDriver",
    node: `${linux}/tools/node`,
    tauri_driver: `${linux}/tools/tauri-driver`,
    wsl: String.raw`C:\Windows\System32\wsl.exe`,
  };
  return {
    schema_version: 1,
    host_expected: { machine_id_sha256: "a".repeat(64), minimum_os_version: "6.8" },
    entry_pins: {
      supervisor_sha256: "e".repeat(64),
      transfer_sha256: "3".repeat(64),
      controller_revision: "4".repeat(40),
      controller_tree: "5".repeat(40),
    },
    invocation_id: id,
    request_sha256: "b".repeat(64),
    plan_sha256: "c".repeat(64),
    stage_request_sha256: "d".repeat(64),
    controller_root: root,
    capture_root: capture,
    capture_directory: capture + `\\native-attempt-${id}`,
    boundary_configuration: {
      schema_version: 1,
      broker_sid: account.broker,
      distribution: account.distribution,
      qualification_uid: "1002",
      qualification_gid: "1002",
      qualification_user: "qualification",
      controller_root: root,
      capture_root: capture,
      linux_root: linux,
      supervisor_sha256: "e".repeat(64),
      tools: Object.fromEntries(
        Object.entries(paths).map(([key, path]) => [key, { path, sha256: "f".repeat(64) }]),
      ),
    },
    account,
    package: {
      path: capture + String.raw`\native-source-frozen\Portcove.AppImage`,
      bytes: 1234,
      sha256: "1".repeat(64),
    },
    node: { path: String.raw`C:\Portcove\node.exe`, sha256: "2".repeat(64) },
    parent_deadline_utc: "2026-11-01T00:00:00.000Z",
  };
}
void test("post-sign transport package preparation permits only a distinct bounded retained predecessor", () => {
  const old = fixture();
  const next = {
    ...old,
    schema_version: 2,
    predecessor: {
      ...old.package,
      path: old.package.path.replace("Portcove.AppImage", "Predecessor.AppImage"),
      sha256: "9".repeat(64),
    },
  };
  assert.equal(inspectWslNativeDriverPlan(next).predecessor?.sha256, next.predecessor.sha256);
  for (const wrong of [
    { ...next, schema_version: 1 },
    { ...next, predecessor: { ...next.predecessor, sha256: old.package.sha256 } },
    {
      ...next,
      predecessor: { ...next.predecessor, path: String.raw`E:\other\Predecessor.AppImage` },
    },
    { ...next, predecessor: { ...next.predecessor, bytes: 512 * 1024 * 1024 + 1 } },
  ])
    assert.throws(() => inspectWslNativeDriverPlan(wrong));
  assert.equal(inspectWslNativeDriverPlan(old).predecessor, null);
});
void test("bounded guest wire retains complete raw observations and refuses oversized metadata, wrong digest and incomplete closure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-wire-")),
    invocation = "a".repeat(64),
    sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
  const payload = Buffer.alloc(65537, 0xff);
  const header = (name: string, bytes: number, digest: string) =>
    Buffer.from(
      JSON.stringify({
        schema_version: 1,
        invocation_id: invocation,
        path: name,
        bytes,
        sha256: digest,
      }) + "\n",
    );
  const complete = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      invocation_id: invocation,
      complete: true,
      count: 2,
      authority: "none",
    }) + "\n",
  );
  const valid = Buffer.concat([
    header(".outer-json-" + "b".repeat(32), 0, sha(Buffer.alloc(0))),
    header("desktop/output.bin", payload.length, sha(payload)),
    payload,
    complete,
  ]);
  const wire = path.join(root, "valid.bin");
  await writeFile(wire, valid);
  const result = await retainNativeCaptureWire(
    wire,
    path.join(root, "retained"),
    invocation,
    sha(valid),
  );
  assert.equal(result.authority, "none");
  assert.equal(result.entries.length, 2);
  assert.equal(
    await hashRetainedNativeCaptureFile(
      result.directory,
      result.entries[0]!.path,
      32 * 1024 * 1024,
      0,
    ),
    sha(Buffer.alloc(0)),
  );
  assert.deepEqual(await readFile(path.join(result.directory, "desktop/output.bin")), payload);
  await assert.rejects(
    retainNativeCaptureWire(wire, result.directory, invocation, sha(valid)),
    /EEXIST/u,
  );
  const invalid = [
    Buffer.alloc(2049, 65),
    header("huge.bin", 32 * 1024 * 1024 + 1, "b".repeat(64)),
    header("../escape", 1, "b".repeat(64)),
    header("NUL.bin", 1, "b".repeat(64)),
    Buffer.concat([header("wrong.bin", 1, "b".repeat(64)), Buffer.from("x")]),
    valid.subarray(0, valid.length - 2),
    Buffer.concat([valid, Buffer.from("x")]),
  ];
  for (const [index, bytes] of invalid.entries()) {
    const input = path.join(root, `invalid-${index}.bin`),
      output = path.join(root, `partial-${index}`);
    await writeFile(input, bytes);
    await assert.rejects(retainNativeCaptureWire(input, output, invocation, sha(bytes)));
    if (index < 4)
      assert.deepEqual(await readdir(output), [], "raw header refused before any file write");
  }
});
void test("fixed data-only guest driver plan binds original Windows/guest source and capture domains", () => {
  const raw = fixture(),
    selected = inspectWslNativeDriverPlan(raw);
  assert.equal(selected.authority, "none");
  assert.equal(selected.boundary.account.qualification, "1002");
  raw.package.path = "C:\\other.exe";
  assert.ok(selected.package.path.endsWith("Portcove.AppImage"));
  assert.throws(() => inspectWslNativeDriverPlan(raw));
  for (const change of [
    (v: ReturnType<typeof fixture>) => {
      v.capture_directory += "-other";
    },
    (v: ReturnType<typeof fixture>) => {
      v.boundary_configuration.qualification_uid = "0";
    },
    (v: ReturnType<typeof fixture>) => {
      v.package.bytes = 512 * 1024 * 1024 + 1;
    },
    (v: ReturnType<typeof fixture>) => {
      v.node.sha256 = "unknown";
    },
    (v: ReturnType<typeof fixture>) => {
      v.parent_deadline_utc = "2026-02-30T00:00:00.000Z";
    },
  ]) {
    const value = fixture();
    change(value);
    assert.throws(() => inspectWslNativeDriverPlan(value));
  }
});
void test("no caller JSON or successful-driver descriptor can mint actual parent capture provenance", async () => {
  await assert.rejects(
    requireActualWslNativeCapture({
      kind: "actual-wsl-native-capture",
      authority: "none",
      native_acceptance: "accepted",
      status: 0,
    }),
    /actual installed parent/u,
  );
});
void test("guest operation budget intersects the original clock before any effect", () => {
  assert.equal(boundedNativeWslOperationTimeout(30000, 123), 123);
  for (const pair of [
    [1, 0],
    [0, 5000],
    [-1, 5000],
    [Infinity, 5000],
    [1, NaN],
  ])
    assert.throws(() => boundedNativeWslOperationTimeout(pair[0]!, pair[1]!));
});

void test("ordinary public Windows-to-guest transport stages distinct V0 and V1 without native predecessor reinterpretation", () => {
  const old = fixture();
  const publicPlan = {
    ...old,
    schema_version: 3,
    candidate: {
      ...old.package,
      path: old.package.path.replace("Portcove.AppImage", "Candidate.AppImage"),
      sha256: "9".repeat(64),
    },
  };
  const parsed = inspectWslNativeDriverPlan(publicPlan);
  assert.equal(parsed.schema_version, 3);
  assert.equal(parsed.package.sha256, old.package.sha256);
  assert.equal(parsed.public_candidate?.sha256, publicPlan.candidate.sha256);
  assert.equal(parsed.predecessor, null);
  assert.equal(parsed.authority, "none");
  for (const wrong of [
    { ...publicPlan, schema_version: 1 },
    { ...publicPlan, candidate: null },
    { ...publicPlan, predecessor: publicPlan.candidate },
    { ...publicPlan, candidate: { ...publicPlan.candidate, sha256: old.package.sha256 } },
    {
      ...publicPlan,
      candidate: { ...publicPlan.candidate, path: String.raw`E:\other\Candidate.AppImage` },
    },
  ])
    assert.throws(() => inspectWslNativeDriverPlan(wrong));
});
void test("continuation capsule is a bounded fixed original capture input and cannot reinterpret schema3", () => {
  const raw = fixture();
  const input = {
    ...raw,
    schema_version: 4,
    candidate: { ...raw.package, sha256: "8".repeat(64) },
    parked_capture: {
      path: raw.capture_root + String.raw`\native-attempt-original\public-capture.stdout.bin`,
      bytes: 123,
      sha256: "7".repeat(64),
    },
  };
  const parsed = inspectWslNativeDriverPlan(input);
  assert.equal(parsed.schema_version, 4);
  assert.equal(parsed.parked_capture?.bytes, 123);
  for (const changed of [
    { ...input, schema_version: 3 },
    { ...input, parked_capture: null },
    { ...input, parked_capture: { ...input.parked_capture, bytes: 272 * 1024 * 1024 + 1 } },
    {
      ...input,
      parked_capture: { ...input.parked_capture, path: raw.capture_root + String.raw`\other.bin` },
    },
  ])
    assert.throws(() => inspectWslNativeDriverPlan(changed));
});
