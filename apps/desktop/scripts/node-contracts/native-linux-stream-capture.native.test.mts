import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createNativeNamespaceStreamCapture } from "../native-linux-isolated-session.mts";
import { nativeLinuxPreSignHarnessScenarios } from "../../../../scripts/release-native-linux-driver.mts";
import {
  parseDesktopHarnessOptions,
  resolveDesktopHarnessSelection,
} from "../../../../scripts/desktop-execution-plan.mts";

void test("namespace raw group capture keeps empty streams and refuses overflow without repeating or replacing retained files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-group-stream-"));
  type Capture = ReturnType<typeof createNativeNamespaceStreamCapture>;
  const pending = new Set<Capture>();
  const streams: PassThrough[] = [];
  t.after(async () => {
    const cleanupFailures: unknown[] = [];
    for (const stream of streams) {
      try {
        stream.destroy();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    for (const capture of pending) {
      try {
        finishCapture(capture);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length)
      throw new AggregateError(cleanupFailures, "owned stream fixture cleanup failed");
  });
  const keepCapture = (capture: Capture) => {
    pending.add(capture);
    return capture;
  };
  function finishCapture(capture: Capture) {
    // finish is single-use even if descriptor closure fails.
    pending.delete(capture);
    return capture.finish();
  }
  const captureStream = () => {
    const stream = new PassThrough();
    streams.push(stream);
    return stream;
  };
  const id = "namespace-" + "a".repeat(32),
    capture = keepCapture(createNativeNamespaceStreamCapture(root, id));
  const stdout = captureStream(),
    stderr = captureStream();
  let failures = 0;
  capture.attach({ stdout, stderr }, () => {
    failures++;
  });
  stdout.write(Buffer.from([0, 255, 10]));
  const retained = finishCapture(capture);
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
  const overflow = keepCapture(
      createNativeNamespaceStreamCapture(root, "namespace-" + "b".repeat(32)),
    ),
    large = captureStream();
  overflow.attach({ stdout: large, stderr: captureStream() }, () => {
    failures++;
  });
  large.write(Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.equal(failures, 1);
  assert.equal(finishCapture(overflow).failed, true);
  const selection = resolveDesktopHarnessSelection(
    parseDesktopHarnessOptions(
      nativeLinuxPreSignHarnessScenarios.flatMap((name) => ["--scenario", name]),
    ).values,
  );
  assert.deepEqual(selection.selected_scenarios, ["empty-library", "appearance-restart"]);
});
