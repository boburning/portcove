import assert from "node:assert/strict";
import test from "node:test";
import { parseNamespacePacket } from "./desktop-linux-native-session.mts";

const nonce = "12345678-1234-1234-1234-123456789abc";
void test("private namespace protocol preserves exact typed packets and extra observation metadata", () => {
  for (const payload of [
    { kind: "namespace-ready", pid: 1, uid: 1000 },
    { kind: "driver-started", pid: 2 },
    { kind: "driver-error", message: "owned failure" },
    { kind: "driver-exited", code: 0, signal: null },
    { kind: "driver-exited", code: null, signal: "SIGTERM" },
  ]) {
    const raw = { ...payload, nonce, extra: "owned retained metadata" };
    const before = structuredClone(raw);
    const { observed_at, ...actual } = parseNamespacePacket(raw, nonce);
    assert.deepEqual(actual, raw);
    assert.deepEqual(raw, before);
    assert.ok(Number.isFinite(Date.parse(observed_at)));
  }
});
void test("private namespace protocol rejects malformed, foreign and coercible packets", () => {
  assert.throws(
    () => parseNamespacePacket({ nonce: "wrong-nonce", kind: "driver-started", pid: 99 }, nonce),
    /wrong-nonce/u,
  );
  for (const value of [
    null,
    [],
    "packet",
    {},
    { nonce: "foreign", kind: "namespace-ready", pid: 1, uid: 1000 },
    { nonce, kind: "namespace-ready", pid: "1", uid: 1000 },
    { nonce, kind: "namespace-ready", pid: 1, uid: "1000" },
    { nonce, kind: "namespace-ready", pid: 2, uid: 1000 },
    { nonce, kind: "driver-started", pid: "2" },
    { nonce, kind: "driver-started", pid: 1 },
    { nonce, kind: "driver-started", pid: 2.5 },
    { nonce, kind: "driver-error", message: [] },
    { nonce, kind: "driver-exited", code: "0", signal: null },
    { nonce, kind: "driver-exited", code: 0.5, signal: null },
    { nonce, kind: "driver-exited", code: 0, signal: [] },
    { nonce, kind: "future-message" },
  ])
    assert.throws(() => parseNamespacePacket(value, nonce));
});
