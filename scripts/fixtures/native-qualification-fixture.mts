import { nativeQualificationScenarios } from "../release-native-qualification-contract.mts";
export function nativeQualificationFixture(
  stage: "payload-signing" | "release-publication" = "payload-signing",
) {
  const sha = "a".repeat(64),
    source = "b".repeat(40);
  const candidate = {
    source_commit: source,
    source_tree: "c".repeat(40),
    run_id: "12345",
    run_attempt: 2,
    artifact_id: 123,
    package: { filename: "Portcove_0.1.0-beta.1_x64-setup.exe", bytes: 1234, sha256: sha },
  };
  return {
    schema_version: 1,
    stage,
    platform_label: "windows-x86_64",
    candidate,
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
              ...candidate,
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
