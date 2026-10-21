import { nativeQualificationFixture } from "./native-qualification-fixture.mts";

/** Inert configuration identities, never observed provider or host authority. */
export function nativeAuthorityConfigurationFixture() {
  const report = nativeQualificationFixture();
  const { started_at: _start, invocation_id: _invocation, ...producer } = report.producer;
  return {
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
            qualification_profile: "inert-config-only",
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
}
