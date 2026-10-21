import assert from "node:assert/strict";
import test from "node:test";
import {
  captureActualLinuxPublicJourney,
  requireActualLinuxPublicCapture,
  inspectLinuxPublicTechnicalClosure,
} from "./release-native-linux-public-capture.mts";

void test("raw public descriptors cannot enter actual Linux capture or rehydrate its private custody", async () => {
  for (const raw of [
    {},
    { kind: "actual-public-journey-invocation", authority: "none" },
    { phase: "initial-v0-v1", parent: {} },
  ]) {
    await assert.rejects(
      captureActualLinuxPublicJourney(raw),
      /actual freshly claimed public invocation required/u,
    );
    await assert.rejects(
      requireActualLinuxPublicCapture(raw),
      /actual installed Linux public capture required/u,
    );
  }
});
void test("the same invocation cannot enter twice while its first authentication is pending", async () => {
  const raw = {};
  const first = captureActualLinuxPublicJourney(raw);
  const second = captureActualLinuxPublicJourney(raw);
  await assert.rejects(first, /actual freshly claimed public invocation required/u);
  await assert.rejects(second, /one-shot; reconcile original retained invocation/u);
});

void test("technical closure requires original Linux unit generation and positive group emptiness", () => {
  const id = "a".repeat(64),
    request = "b".repeat(64),
    raw = {
      invocation_id: id,
      request_sha256: request,
      authority: "none",
      unit: `portcove-native-${id}.service`,
      unit_invocation_id: "c".repeat(32),
      cgroup_empty: true,
      unit_settled: true,
      cgroup_settlement: "observed-unpopulated",
      cgroup_identity: { device: 1, inode: 2 },
      root_identity: { pid: 123, creation_ticks: "456" },
      exit_code: 0,
      completed_at: "2026-10-21T00:00:00.000Z",
    };
  const result = inspectLinuxPublicTechnicalClosure(raw, id, request);
  assert.equal(result.roots[0]?.creation.kind, "linux-starttime-ticks");
  assert.equal(result.authority, "none");
  for (const changed of [
    { invocation_id: "d".repeat(64) },
    { request_sha256: "e".repeat(64) },
    { cgroup_empty: false },
    { unit_settled: false },
    { unit_invocation_id: "" },
    { root_identity: null },
    { root_identity: { pid: 123, creation_ticks: "0" } },
    { exit_code: null },
    { cgroup_settlement: "wrapper-exited" },
  ])
    assert.throws(() => inspectLinuxPublicTechnicalClosure({ ...raw, ...changed }, id, request));
});
