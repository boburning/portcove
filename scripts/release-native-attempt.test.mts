import assert from "node:assert/strict";
import test from "node:test";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import { nativeAuthorityConfigurationFixture } from "./fixtures/native-authority-configuration-fixture.mts";
import {
  prepareNativeStageRequest,
  serializeNativeStageCapture,
} from "./release-native-stage-capture.mts";
import { prepareNativeQualificationCheck } from "./release-native-acceptance.mts";
import {
  inspectNativeCheckRecoveryPlan,
  reconcileActualNativeCheck,
} from "./release-native-candidate.mts";
import {
  claimActualNativeInvocation,
  requireActualNativeInvocation,
  inspectNativeAttemptInventory,
  inspectNativeAttemptSettlement,
  inspectNativeAttemptMarker,
} from "./release-native-attempt.mts";
import { nativeInvocationIdentity } from "./release-native-candidate.mts";

function fixture() {
  const report = nativeQualificationFixture();
  const authorities = nativeAuthorityConfigurationFixture();
  const request = {
    schema_version: 1,
    stage: report.stage,
    platform_label: report.platform_label,
    candidate: report.candidate,
    journey: report.journey,
    invocation_id: report.producer.invocation_id,
    setup_descriptor_sha256: "f".repeat(64),
  };
  const prepared = prepareNativeStageRequest(request, authorities);
  const stream = (name: string) => ({
    path: `harness.${name}.bin`,
    bytes: 0,
    sha256: "a".repeat(64),
  });
  const capture = {
    schema_version: 1,
    request_sha256: prepared.request_sha256,
    outcome: "failed",
    started_at: "2026-10-20T12:00:00.000Z",
    completed_at: "2026-10-20T12:00:01.000Z",
    harness: {
      ...report.producer.harness,
      exit_code: 1,
      stdout: stream("stdout"),
      stderr: stream("stderr"),
    },
    roots: [],
    group: { empty: true, remaining_pids: [], observed_at: "2026-10-20T12:00:01.000Z" },
    scenarios: [],
    failure: { phase: "startup", code: "fixture", message: "inert failure retained" },
  };
  return { report, authorities, prepared, request, capture };
}

void test("native invocation custody cannot reset after missing directory, marker or changed grant", () => {
  const grant = "a".repeat(64),
    id = "b".repeat(64);
  const initial =
    JSON.stringify({
      schema_version: 1,
      kind: "native-capture-custody",
      setup_grant_sha256: grant,
    }) + "\n";
  assert.deepEqual(inspectNativeAttemptInventory(initial, [], grant).invocations, []);
  const claimed = initial + id + "\n",
    entries = [`native-attempt-${id}`];
  assert.equal(inspectNativeAttemptInventory(claimed, entries, grant).authority, "none");
  for (const [anchor, names, expected] of [
    [claimed, [], grant],
    [initial, entries, grant],
    [claimed + id + "\n", entries, grant],
    [claimed, entries, "c".repeat(64)],
    [claimed.slice(0, -1), entries, grant],
    ["", [], grant],
  ] as const)
    assert.throws(() => inspectNativeAttemptInventory(anchor, names, expected));
});

void test("technical settlement preserves failed capture scope and rejects ambiguous or changed originals", () => {
  const f = fixture();
  const retained = serializeNativeStageCapture(f.request, f.authorities, f.capture).capture;
  const settled = inspectNativeAttemptSettlement(retained, f.prepared, f.authorities);
  assert.equal(settled.capture.outcome, "failed");
  assert.equal(settled.authority, "none");
  for (const changed of [
    { ...retained, group: null },
    { ...retained, group: { ...retained.group, empty: false } },
    { ...retained, group: { ...retained.group, remaining_pids: [99] } },
    { ...retained, request_sha256: "e".repeat(64) },
    { ...retained, completed_at: "2026-02-30T00:00:00.000Z" },
    { ...retained, authority: "accepted" },
    { ...retained, unexpected: true },
  ])
    assert.throws(() => inspectNativeAttemptSettlement(changed, f.prepared, f.authorities));
  assert.throws(() =>
    inspectNativeAttemptSettlement(
      retained,
      { ...f.prepared, request: { ...f.prepared.request, invocation_id: "e".repeat(64) } },
      f.authorities,
    ),
  );
});

void test("retained marker binds directory identity to exact tuple and existing coordinator counters", () => {
  const f = fixture(),
    recovery = { transient_retries: 0, substantive_repairs: 0 };
  const identity = nativeInvocationIdentity(f.prepared, recovery);
  const request = prepareNativeStageRequest(
    { ...f.request, invocation_id: identity.invocation_id },
    f.authorities,
  );
  const marker = {
    schema_version: 1,
    invocation_id: identity.invocation_id,
    setup_grant_sha256: "a".repeat(64),
    request_sha256: request.request_sha256,
    request,
    recovery,
    checkpoint: "b".repeat(40),
    authority: "none",
  };
  assert.equal(
    inspectNativeAttemptMarker(marker, identity.invocation_id, "a".repeat(64), f.authorities)
      .authority,
    "none",
  );
  for (const changed of [
    { ...marker, invocation_id: "f".repeat(64) },
    { ...marker, recovery: { ...recovery, transient_retries: 1 } },
    { ...marker, request_sha256: "f".repeat(64) },
    { ...marker, request: { ...request, request: { ...request.request, accepted: true } } },
    { ...marker, checkpoint: "absent" },
    { ...marker, authority: "accepted" },
  ])
    assert.throws(() =>
      inspectNativeAttemptMarker(changed, identity.invocation_id, "a".repeat(64), f.authorities),
    );
});

void test("retained Check wire reconstructs original exact invocation and rejects changed candidate/body", () => {
  const f = fixture(),
    wire = prepareNativeQualificationCheck(f.report);
  const expected = {
    method: "POST",
    endpoint: "repos/boburning/portcove/check-runs",
    body: wire.body,
  };
  assert.equal(
    inspectNativeCheckRecoveryPlan(f.prepared, expected, f.authorities).authority,
    "none",
  );
  for (const body of [
    { ...wire.body, head_sha: "e".repeat(40) },
    { ...wire.body, external_id: "changed" },
    { ...wire.body, conclusion: "failure" },
  ])
    assert.throws(() =>
      inspectNativeCheckRecoveryPlan(f.prepared, { ...expected, body }, f.authorities),
    );
  assert.throws(() =>
    inspectNativeCheckRecoveryPlan(
      f.prepared,
      { ...expected, endpoint: "repos/foreign/repository/check-runs" },
      f.authorities,
    ),
  );
  assert.throws(() =>
    inspectNativeCheckRecoveryPlan(
      { ...f.prepared, request_sha256: "f".repeat(64) },
      expected,
      f.authorities,
    ),
  );
});

void test("imported claims and selections cannot reach actual claim, readback or candidate execution", async () => {
  await assert.rejects(claimActualNativeInvocation({}), /actual parent-owned/);
  await assert.rejects(requireActualNativeInvocation({}), /actual freshly claimed/);
  await assert.rejects(reconcileActualNativeCheck({}, {}, {}), /actual parent-owned/);
});
