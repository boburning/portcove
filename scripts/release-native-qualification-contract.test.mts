import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectNativeReleaseQualification,
  nativeQualificationScenarios,
  nativePrepublicationScenarios,
  nativePrepublicationProfile,
  nativePrepublicationPending,
} from "./release-native-qualification-contract.mts";

function report(stage: "payload-signing" | "release-publication" = "payload-signing") {
  const sha = "a".repeat(64),
    commit = "b".repeat(40);
  return {
    schema_version: 1,
    stage,
    platform_label: "windows-x86_64",
    candidate: {
      source_commit: commit,
      source_tree: "c".repeat(40),
      run_id: "12345",
      run_attempt: 2,
      artifact_id: 123,
      package: { filename: "Portcove_0.1.0-beta.1_x64-setup.exe", bytes: 1234, sha256: sha },
    },
    producer: {
      invocation_id: "d".repeat(64),
      source_commit: "e".repeat(40),
      source_tree: "f".repeat(40),
      harness: { path: "scripts/qualify-native-release.ps1", sha256: sha },
      started_at: "2026-10-20T11:59:59.000Z",
    },
    host: {
      machine_id_sha256: sha,
      architecture: "x86_64",
      qualification_profile: "windows-11-26h2-x64",
      os_version: "10.0.26200.1000",
      minimum_platform: "windows-11-26h2-x64",
      execution_context: "native-inert-fixture",
      account: { kind: "windows-sid", broker: "S-1-5-21-1000", qualification: "S-1-5-21-1001" },
      loaded_engine: { name: "WebView2", version: "145.0.1.2", sha256: sha },
    },
    runtime: {
      root_pid: 123,
      root_creation: { kind: "windows-filetime", value: "133000000000000000" },
      started_at: "2026-10-20T12:00:00.000Z",
      completed_at: "2026-10-20T12:00:05.000Z",
      capture_sha256: sha,
      teardown: {
        root_exited: true,
        tree_empty: true,
        remaining_pids: [],
        completed_at: "2026-10-20T12:00:06.000Z",
        capture_sha256: sha,
      },
    },
    compatibility: {
      minimum_os_version: "10.0.26200",
      required_capabilities: ["application-update"],
      cli_protocol: { min: 1, max: 2 },
      catalog_formats: [3],
      library: { read: { min: 1, max: 2 }, write_schema: 2, lock_protocol: "portcove-library-v1" },
    },
    scenarios: nativeQualificationScenarios[stage].map((name) => ({
      name,
      outcome: "passed",
      started_at: "2026-10-20T12:00:01.000Z",
      completed_at: "2026-10-20T12:00:04.000Z",
      capture_sha256: sha,
    })),
    journey:
      stage === "payload-signing"
        ? null
        : {
            predecessor: {
              source_commit: "0".repeat(40),
              source_tree: "1".repeat(40),
              run_id: "12222",
              run_attempt: 1,
              artifact_id: 122,
              package: {
                filename: "Portcove_0.1.0-alpha.2_x64-setup.exe",
                bytes: 1200,
                sha256: "2".repeat(64),
              },
            },
            signed_context_sha256: "3".repeat(64),
            signatures_sha256: "4".repeat(64),
          },
  };
}
void test("inert native contract keeps signing and publication stages distinct and detaches mutable input", () => {
  const input = report(),
    actual = inspectNativeReleaseQualification(input);
  assert.equal(actual.stage, "payload-signing");
  assert.notEqual(actual.candidate.source_commit, actual.producer.source_commit);
  assert.equal(actual.candidate.run_attempt, 2);
  input.compatibility.required_capabilities[0] = "changed";
  input.scenarios[0]!.capture_sha256 = "0".repeat(64);
  assert.equal(actual.compatibility.required_capabilities[0], "application-update");
  assert.equal(actual.scenarios[0]!.capture_sha256, "a".repeat(64));
  const publication = inspectNativeReleaseQualification(report("release-publication"));
  assert.deepEqual(
    publication.scenarios.map((s) => s.name),
    nativeQualificationScenarios["release-publication"],
  );
  const wrong = report();
  wrong.stage = "release-publication";
  assert.throws(() => inspectNativeReleaseQualification(wrong));
  assert.equal(Object.hasOwn(actual, "accepted"), false);
  assert.equal(Object.hasOwn(actual, "authority"), false);
});
void test("schema2 prepublication wire keeps package compatibility separate from pending ordinary public journey", () => {
  const legacy = report("release-publication");
  const value = {
    ...legacy,
    schema_version: 2,
    native_prepublication_profile: nativePrepublicationProfile,
    pending_obligations: [...nativePrepublicationPending],
    scenarios: nativePrepublicationScenarios.map((name, index) => ({
      ...legacy.scenarios[index]!,
      name,
    })),
  };
  const result = inspectNativeReleaseQualification(value);
  assert.equal(result.schema_version, 2);
  assert.equal(result.native_prepublication_profile, nativePrepublicationProfile);
  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.name),
    nativePrepublicationScenarios,
  );
  assert.deepEqual(result.pending_obligations, nativePrepublicationPending);
  assert.equal(result.journey?.signed_context_sha256, "3".repeat(64));
  value.pending_obligations[0] = "changed" as (typeof value.pending_obligations)[number];
  assert.deepEqual(result.pending_obligations, nativePrepublicationPending);
  for (const changed of [
    { ...value, pending_obligations: [] },
    { ...value, pending_obligations: [...nativePrepublicationPending].reverse() },
    {
      ...value,
      pending_obligations: [...nativePrepublicationPending],
      native_prepublication_profile: "caller-profile",
    },
    {
      ...value,
      pending_obligations: [...nativePrepublicationPending],
      stage: "payload-signing",
      journey: null,
    },
    { ...value, pending_obligations: [...nativePrepublicationPending], journey: null },
    {
      ...value,
      pending_obligations: [...nativePrepublicationPending],
      scenarios: legacy.scenarios,
    },
    { ...value, pending_obligations: [...nativePrepublicationPending], schema_version: 1 },
  ])
    assert.throws(() => inspectNativeReleaseQualification(changed));
  assert.deepEqual(
    inspectNativeReleaseQualification(legacy).scenarios.map((scenario) => scenario.name),
    nativeQualificationScenarios["release-publication"],
  );
});
void test("post-sign native captures bind exact predecessor and signed context while empty required capabilities remain valid", () => {
  const value = report("release-publication");
  value.compatibility.required_capabilities = [];
  const parsed = inspectNativeReleaseQualification(value);
  assert.deepEqual(parsed.compatibility.required_capabilities, []);
  assert.equal(parsed.journey?.predecessor.run_id, "12222");
  assert.equal(parsed.runtime.root_creation.value, "133000000000000000");
  for (const mutation of [
    (v: ReturnType<typeof report>) => {
      v.journey = null;
    },
    (v: ReturnType<typeof report>) => {
      v.journey!.signed_context_sha256 = "";
    },
    (v: ReturnType<typeof report>) => {
      v.journey!.predecessor.package.sha256 = v.candidate.package.sha256;
    },
    (v: ReturnType<typeof report>) => {
      v.runtime.root_creation.value = "";
    },
    (v: ReturnType<typeof report>) => {
      v.producer.started_at = "2026-10-20T12:00:01.000Z";
    },
  ]) {
    const bad = report("release-publication");
    mutation(bad);
    assert.throws(() => inspectNativeReleaseQualification(bad));
  }
  const premature = report();
  premature.journey = value.journey;
  assert.throws(() => inspectNativeReleaseQualification(premature), /pre-sign/u);
});
void test("inert native contract requires complete actual scenario capture, chronology and teardown", () => {
  const cases: ((value: ReturnType<typeof report>) => void)[] = [
    (v) => {
      v.scenarios.pop();
    },
    (v) => {
      v.scenarios.reverse();
    },
    (v) => {
      v.scenarios[0]!.outcome = "failed";
    },
    (v) => {
      v.scenarios[0]!.capture_sha256 = "unknown";
    },
    (v) => {
      v.scenarios[0]!.completed_at = "2026-10-20T12:00:08.000Z";
    },
    (v) => {
      v.runtime.teardown.root_exited = false;
    },
    (v) => {
      v.runtime.teardown.tree_empty = false;
    },
    (v) => {
      (v.runtime.teardown.remaining_pids as number[]).push(456);
    },
    (v) => {
      v.runtime.teardown.completed_at = "2026-10-20T11:00:00.000Z";
    },
    (v) => {
      v.runtime.root_pid = 0;
    },
  ];
  for (const change of cases) {
    const value = report();
    change(value);
    assert.throws(() => inspectNativeReleaseQualification(value));
  }
});
void test("inert native contract refuses account conflation, missing engine/minimum observations and unknown fields", () => {
  const cases: ((value: ReturnType<typeof report>) => void)[] = [
    (v) => {
      v.host.account.qualification = v.host.account.broker;
    },
    (v) => {
      v.host.account.kind = "linux-uid";
    },
    (v) => {
      v.host.loaded_engine.sha256 = "unknown";
    },
    (v) => {
      v.host.minimum_platform = "";
    },
    (v) => {
      v.compatibility.minimum_os_version = "";
    },
    (v) => {
      v.compatibility.cli_protocol.max = 0;
    },
    (v) => {
      v.compatibility.catalog_formats.push(3);
    },
    (v) => {
      v.candidate.package.filename = "../candidate.exe";
    },
    (v) => {
      v.candidate.run_id = "12345/retry";
    },
    (v) => {
      v.producer.invocation_id = "";
    },
    (v) => {
      Object.assign(v, { accepted: true });
    },
    (v) => {
      Object.assign(v.producer, { run_id: "12345" });
    },
  ];
  for (const change of cases) {
    const value = report();
    change(value);
    assert.throws(() => inspectNativeReleaseQualification(value));
  }
});
