import assert from "node:assert/strict";
import test from "node:test";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import {
  prepareNativeStageRequest,
  serializeNativeStageCapture,
} from "./release-native-stage-capture.mts";

function fixture(stage: "payload-signing" | "release-publication" = "payload-signing") {
  const report = nativeQualificationFixture(stage);
  const { invocation_id: _invocation, started_at: _started, ...producer } = report.producer;
  const authorities = {
    schema_version: 1,
    repository_id: 1354613114,
    namespace: "portcove-test",
    apps: Object.fromEntries(
      [
        "semantic",
        "classification",
        "native_qualification",
        "protection_observer",
        "coordinator_journal",
        "dispatch",
        "release_publication",
      ].map((role, index) => [
        role,
        {
          app_id: 100 + index,
          installation_id: 200 + index,
          ...(role === "dispatch" ? { actor_id: "123456" } : {}),
        },
      ]),
    ),
    native: Object.fromEntries(
      ["windows-x86_64", "linux-x86_64"].map((platform) => [
        platform,
        {
          producer,
          compatibility: report.compatibility,
          host: {
            machine_id_sha256: "a".repeat(64),
            qualification_profile: "inert-fixture",
            minimum_platform:
              platform === "windows-x86_64" ? "windows-11-26h2-x64" : "ubuntu-24.04-x64",
            account:
              platform === "windows-x86_64"
                ? {
                    kind: "windows-sid",
                    broker: "S-1-5-21-1-2-3-1001",
                    qualification: "S-1-5-21-1-2-3-1002",
                  }
                : { kind: "linux-uid", broker: "1000", qualification: "1001" },
            engine: {
              name: platform === "windows-x86_64" ? "WebView2" : "WebKitGTK",
              minimum_version: platform === "windows-x86_64" ? "155.0.4283.62" : "2.52.6",
            },
          },
        },
      ]),
    ),
  };
  const request = {
    schema_version: 1,
    stage,
    platform_label: "windows-x86_64",
    candidate: report.candidate,
    journey: report.journey,
    invocation_id: "d".repeat(64),
    setup_descriptor_sha256: "1".repeat(64),
  };
  const prepared = prepareNativeStageRequest(request, authorities);
  const stream = (id: string, name: string) => ({
    path: `${id}.${name}.bin`,
    bytes: 0,
    sha256: "a".repeat(64),
  });
  const capture = {
    schema_version: 1,
    request_sha256: prepared.request_sha256,
    outcome: "completed",
    started_at: report.runtime.started_at,
    completed_at: "2026-10-20T12:00:06.000Z",
    harness: {
      ...producer.harness,
      exit_code: 0,
      stdout: stream("harness", "stdout"),
      stderr: stream("harness", "stderr"),
    },
    roots: [
      {
        id: "application",
        role: "application",
        image: { pid: 123, path: "C:\\owned\\application.exe", sha256: "a".repeat(64) },
        creation: report.runtime.root_creation,
        started_at: report.runtime.started_at,
        stdout: stream("application", "stdout"),
        stderr: stream("application", "stderr"),
        teardown: {
          root_pid: 123,
          root_creation: report.runtime.root_creation,
          root_exited: true,
          job_empty: true,
          remaining_pids: [] as number[],
          exit_code: 0,
          observed_at: "2026-10-20T12:00:05.000Z",
        },
      },
    ],
    group: { empty: true, remaining_pids: [], observed_at: "2026-10-20T12:00:06.000Z" },
    scenarios: report.scenarios,
    failure: null,
  };
  return { authorities, request, prepared, capture };
}

void test("native stage freezes exact configured expectations and signed journey without granting authority", () => {
  for (const stage of ["payload-signing", "release-publication"] as const) {
    const f = fixture(stage);
    const result = serializeNativeStageCapture(f.request, f.authorities, f.capture);
    assert.equal(result.authority, "none");
    assert.equal(result.capture.scope, "integrity-only");
    assert.equal(result.capture.scenarios.length, f.prepared.request.required_scenarios.length);
    const before = f.prepared.request.candidate.package.sha256;
    f.request.candidate.package.sha256 = "9".repeat(64);
    assert.equal(f.prepared.request.candidate.package.sha256, before);
    assert.ok(Object.isFrozen(f.prepared.request.expected));
    assert.throws(
      () => serializeNativeStageCapture(f.request, f.authorities, f.capture),
      /request\/outcome/,
    );
  }
});

void test("native complete capture refuses changed identity, omitted scenarios, partial teardown and contradictory timing", () => {
  const f = fixture();
  const changes: ((value: typeof f.capture) => void)[] = [
    (value) => {
      value.request_sha256 = "9".repeat(64);
    },
    (value) => {
      value.harness.sha256 = "9".repeat(64);
    },
    (value) => {
      value.scenarios.pop();
    },
    (value) => {
      value.roots[0]!.teardown.root_pid = 124;
    },
    (value) => {
      value.roots[0]!.teardown.job_empty = false;
    },
    (value) => {
      value.roots[0]!.teardown.remaining_pids = [124];
    },
    (value) => {
      value.roots[0]!.stdout.bytes = 4 * 1024 * 1024 + 1;
    },
    (value) => {
      value.roots[0]!.stdout.path = "../external";
    },
    (value) => {
      value.roots[0]!.teardown.observed_at = "2026-10-20T12:00:00.000Z";
      value.roots[0]!.started_at = "2026-10-20T12:00:01.000Z";
    },
    (value) => {
      value.group.observed_at = "2026-10-20T12:00:00.000Z";
      value.roots[0]!.started_at = "2026-10-20T12:00:01.000Z";
    },
  ];
  for (const change of changes) {
    const capture = structuredClone(f.capture);
    change(capture);
    assert.throws(() => serializeNativeStageCapture(f.request, f.authorities, capture));
  }
});

void test("failed and ambiguous stages preserve partial roots/output and cannot serialize as complete", () => {
  const f = fixture();
  for (const outcome of ["failed", "ambiguous"]) {
    const partial = {
      ...f.capture,
      outcome,
      failure: { phase: "capture", code: "partial-output", message: "retained refusal" },
      group: null,
      roots: f.capture.roots.map((root) => ({ ...root, teardown: null })),
      scenarios: [],
    };
    const result = serializeNativeStageCapture(f.request, f.authorities, partial);
    assert.equal(result.capture.outcome, outcome);
    assert.equal(result.capture.roots[0]!.teardown, null);
    assert.equal(result.authority, "none");
    assert.throws(() =>
      serializeNativeStageCapture(f.request, f.authorities, { ...partial, outcome: "completed" }),
    );
  }
});
