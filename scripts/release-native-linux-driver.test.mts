import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectNativeLinuxHomeMount,
  requireFreshNativeLinuxOutput,
  nativeLinuxPreSignHarnessScenarios,
} from "./release-native-linux-driver.mts";
import { mkdtemp, mkdir, rm, lstat, readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createNativeNamespaceStreamCapture } from "../apps/desktop/scripts/native-linux-isolated-session.mts";
import { createHash } from "node:crypto";
import {
  parseDesktopHarnessOptions,
  resolveDesktopHarnessSelection,
} from "./desktop-execution-plan.mts";
import os from "node:os";
import path from "node:path";

const home = "/home/qualification/portcove-native/invocations/" + "a".repeat(64) + "/work/home";
const mount = `101 12 0:44 / ${home} rw,nosuid,nodev - tmpfs tmpfs rw,size=524288k\n`;
const filesystem = { type: 0x01021994, bsize: 4096, blocks: 131072 };
void test("namespace raw group capture keeps empty streams and refuses overflow without repeating or replacing retained files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-group-stream-")),
    id = "namespace-" + "a".repeat(32),
    capture = createNativeNamespaceStreamCapture(root, id);
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  let failures = 0;
  capture.attach({ stdout, stderr }, () => {
    failures++;
  });
  stdout.write(Buffer.from([0, 255, 10]));
  const retained = capture.finish();
  assert.equal(retained.failed, false);
  assert.equal(retained.stderr.bytes, 0);
  assert.equal(
    retained.stdout.sha256,
    createHash("sha256")
      .update(Buffer.from([0, 255, 10]))
      .digest("hex"),
  );
  assert.deepEqual(
    await readFile(path.join(root, retained.stdout.path)),
    Buffer.from([0, 255, 10]),
  );
  assert.throws(() => createNativeNamespaceStreamCapture(root, id), /EEXIST/u);
  const overflow = createNativeNamespaceStreamCapture(root, "namespace-" + "b".repeat(32)),
    large = new PassThrough();
  overflow.attach({ stdout: large, stderr: new PassThrough() }, () => {
    failures++;
  });
  large.write(Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.equal(failures, 1);
  assert.equal(overflow.finish().failed, true);
  const selection = resolveDesktopHarnessSelection(
    parseDesktopHarnessOptions(
      nativeLinuxPreSignHarnessScenarios.flatMap((name) => ["--scenario", name]),
    ).values,
  );
  assert.deepEqual(selection.selected_scenarios, ["empty-library", "appearance-restart"]);
});
void test("guest driver leaves fresh desktop output creation to the actual harness and refuses retained state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "desktop");
  assert.equal(await requireFreshNativeLinuxOutput(output), output);
  await assert.rejects(lstat(output), { code: "ENOENT" });
  await mkdir(output);
  await assert.rejects(requireFreshNativeLinuxOutput(output), /already exists/u);
});
void test("native stage state remains in one exact independently bounded tmpfs across inner launches", () => {
  const observed = inspectNativeLinuxHomeMount(mount, home, filesystem);
  assert.equal(observed.maximum_bytes, 512 * 1024 * 1024);
  assert.equal(observed.mount_id, "101");
  assert.equal(observed.authority, "none");
  assert.ok(Object.isFrozen(observed));
});
void test("host-disk home, oversized or aliased mounts cannot substitute for the hard native storage bound", () => {
  assert.throws(() => inspectNativeLinuxHomeMount(mount, home, { ...filesystem, type: 0xef53 }));
  assert.throws(() => inspectNativeLinuxHomeMount(mount, home, { ...filesystem, blocks: 131073 }));
  assert.throws(() => inspectNativeLinuxHomeMount(mount, home, { ...filesystem, blocks: NaN }));
  assert.throws(() =>
    inspectNativeLinuxHomeMount(mount.replace(" / ", " /subtree "), home, filesystem),
  );
  assert.throws(() => inspectNativeLinuxHomeMount(mount + mount, home, filesystem));
  assert.throws(() => inspectNativeLinuxHomeMount(mount, home + "/nested", filesystem));
  assert.throws(() =>
    inspectNativeLinuxHomeMount(mount.replace("rw,nosuid", "ro,nosuid"), home, filesystem),
  );
});
