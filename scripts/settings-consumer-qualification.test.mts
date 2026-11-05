import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";
import {
  openSettingsProbeListener,
  requireSettingsVerification,
} from "./settings-consumer-qualification.mts";

void test("native settings verification requires positive exact-install evidence", () => {
  const report = { install_id: "retained-install", checked_files: 183, valid: true, failures: [] };
  assert.equal(requireSettingsVerification(report, "retained-install"), report);
  for (const invalid of [
    undefined,
    { ...report, valid: false },
    { ...report, checked_files: 0 },
    { ...report, checked_files: -1 },
    { ...report, checked_files: 1.5 },
    { ...report, checked_files: undefined, verified_files: 183 },
    { ...report, install_id: "another-install" },
    { ...report, failures: ["immutable file differs"] },
    { ...report, failures: undefined },
  ])
    assert.throws(
      () => requireSettingsVerification(invalid, "retained-install"),
      /positive exact-install/,
    );
  assert.throws(() => requireSettingsVerification(report, undefined), /positive exact-install/);
});

void test("native probe listener owns the first connection and rejects/closes reconnects", async () => {
  const listener = await openSettingsProbeListener();
  const first = connect(listener.port, "127.0.0.1");
  first.on("error", () => {});
  const owned = await listener.connection(1000);
  const second = connect(listener.port, "127.0.0.1");
  second.on("error", () => {});
  await once(second, "close");
  assert.equal(owned.destroyed, false);
  const closed = once(first, "close");
  await listener.close();
  await closed;
  assert.equal(owned.destroyed, true);
});

void test("native probe connection timeout closes the server and leaves no live listener", async () => {
  const listener = await openSettingsProbeListener();
  await assert.rejects(listener.connection(10), /finite deadline/);
  await listener.close();
  const late = connect(listener.port, "127.0.0.1");
  const error = await once(late, "error");
  const failure: unknown = error[0];
  assert.ok(failure instanceof Error && "code" in failure);
  assert.equal(failure.code, "ECONNREFUSED");
  late.destroy();
});

void test("native probe reset is retained as a checked failure instead of an uncaught event", async () => {
  const listener = await openSettingsProbeListener();
  const peer = connect(listener.port, "127.0.0.1");
  peer.on("error", () => {});
  const owned = await listener.connection(1000);
  const closed = new Promise<void>((done) => owned.once("close", () => done()));
  peer.resetAndDestroy();
  await closed;
  assert.throws(() => listener.check(), /ECONNRESET|closed/);
  await listener.close();
});

void test("native probe drains but bounds an oversized upstream response before shutdown", async () => {
  const listener = await openSettingsProbeListener();
  const peer = connect(listener.port, "127.0.0.1");
  peer.on("error", () => {});
  const owned = await listener.connection(1000);
  const closed = new Promise<void>((done) => owned.once("close", () => done()));
  peer.write(Buffer.alloc(1024 * 1024 + 1));
  await closed;
  assert.throws(() => listener.check(), /bounded response allowance/);
  peer.destroy();
  await listener.close();
});
