import assert from "node:assert/strict";
import test from "node:test";
import { nativeQualificationFixture } from "./fixtures/native-qualification-fixture.mts";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import {
  inspectNativeQualificationAssociation,
  requireNativeReleaseQualificationPair,
  collectNativeReleaseQualificationPair,
  deriveNativeQualificationExpectations,
} from "./release-native-admission.mts";

void test("actual native collection rejects incomplete or imported expectations before provider collection", async () => {
  for (const raw of [null, [], [{}], [{}, {}]])
    await assert.rejects(
      collectNativeReleaseQualificationPair("unused", raw, {}, [], "payload-signing"),
    );
});
void test("fixed authority supplies native issuer and host while locators cannot change acquired package facts", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const apps = Object.fromEntries(
    [
      "semantic",
      "classification",
      "native_qualification",
      "protection_observer",
      "coordinator_journal",
      "dispatch",
      "release_publication",
    ].map((role, index) => [role, { app_id: 100 + index, installation_id: 200 + index }]),
  );
  const native = Object.fromEntries(
    ["windows-x86_64", "linux-x86_64"].map((platform) => {
      const report = nativeQualificationFixture();
      const { started_at: _start, invocation_id: _invocation, ...producer } = report.producer;
      return [
        platform,
        {
          producer,
          host: {
            machine_id_sha256: report.host.machine_id_sha256,
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
          compatibility: report.compatibility,
        },
      ];
    }),
  );
  const authorities = {
    schema_version: 1,
    repository_id: 1354613114,
    namespace: "portcove-test",
    apps,
    native,
  };
  const locators = [
    { platform_label: "windows-x86_64", check_id: 101, invocation_id: "1".repeat(64) },
    { platform_label: "linux-x86_64", check_id: 102, invocation_id: "2".repeat(64) },
  ];
  const archives = [
    { platform: "windows-x86_64", artifact_id: 901 },
    { platform: "linux-x86_64", artifact_id: 902 },
  ];
  const expected = await deriveNativeQualificationExpectations(
    authorities,
    locators,
    f.request,
    archives,
    "payload-signing",
  );
  assert.equal(expected[0]!.native_app_id, 102);
  assert.equal(expected[0]!.candidate.artifact_id, 901);
  assert.equal(expected[0]!.candidate.source_commit, f.request.source_commit);
  assert.equal(expected[0]!.host.engine.minimum_version, "155.0.4283.62");
  assert.equal(expected[0]!.journey, null);
  for (const changed of [
    [{ ...locators[0], native_app_id: 999 }, locators[1]],
    [{ ...locators[0], candidate: { sha256: "0".repeat(64) } }, locators[1]],
    [locators[0], locators[0]],
  ])
    await assert.rejects(
      deriveNativeQualificationExpectations(
        authorities,
        changed,
        f.request,
        archives,
        "payload-signing",
      ),
    );
  const conflated = structuredClone(authorities);
  conflated.apps.native_qualification!.app_id = conflated.apps.protection_observer!.app_id;
  await assert.rejects(
    deriveNativeQualificationExpectations(
      conflated,
      locators,
      f.request,
      archives,
      "payload-signing",
    ),
    /conflated/u,
  );
  await assert.rejects(
    deriveNativeQualificationExpectations(
      authorities,
      locators,
      f.request,
      archives,
      "release-publication",
    ),
    /pre-sign/u,
  );
});

void test("inert native association requires exact selected package bytes, source, run, attempt and immutable platform artifact", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const archives = [
    { platform: "windows-x86_64", artifact_id: 101, bytes: 100, sha256: "1".repeat(64) },
    { platform: "linux-x86_64", artifact_id: 102, bytes: 200, sha256: "2".repeat(64) },
  ];
  const reports = archives.map((archive) => {
    const report = nativeQualificationFixture();
    const file = f.request.files.find(
      (v) =>
        v.platform_label === archive.platform &&
        (v.filename.endsWith("-setup.exe") || v.filename.endsWith(".AppImage")),
    )!;
    report.platform_label = archive.platform;
    report.candidate = {
      source_commit: f.request.source_commit,
      source_tree: f.request.source_tree,
      run_id: f.request.run_id,
      run_attempt: f.request.run_attempt,
      artifact_id: archive.artifact_id,
      package: { filename: file.filename, bytes: file.bytes, sha256: file.sha256 },
    };
    if (archive.platform === "linux-x86_64") {
      report.host.account = { kind: "linux-uid", broker: "1000", qualification: "1001" };
      report.runtime.root_creation.kind = "linux-starttime-ticks";
      report.host.loaded_engine = { name: "WebKitGTK", version: "2.52.6", sha256: "3".repeat(64) };
      report.host.minimum_platform = "ubuntu-24.04-x86_64";
      report.host.qualification_profile = "ubuntu-24.04-x86_64";
      report.compatibility.minimum_os_version = "6.8.0";
    }
    return report;
  });
  const result = await inspectNativeQualificationAssociation(
    reports,
    f.request,
    archives,
    "payload-signing",
  );
  assert.equal(result.authority, "none");
  assert.match(result.scope, /no native authentication/u);
  assert.equal(result.reports.length, 2);
  await assert.rejects(
    requireNativeReleaseQualificationPair(reports, f.request, archives, "payload-signing"),
    /actual provider/u,
  );
  for (const mutate of [
    (r: typeof reports) => {
      r[0]!.candidate.package.sha256 = "0".repeat(64);
    },
    (r: typeof reports) => {
      r[0]!.candidate.source_tree = "0".repeat(40);
    },
    (r: typeof reports) => {
      r[0]!.candidate.run_attempt++;
    },
    (r: typeof reports) => {
      r[0]!.candidate.artifact_id++;
    },
    (r: typeof reports) => {
      r[1] = structuredClone(r[0]!);
    },
  ]) {
    const changed = structuredClone(reports);
    mutate(changed);
    await assert.rejects(
      inspectNativeQualificationAssociation(changed, f.request, archives, "payload-signing"),
    );
  }
  await assert.rejects(
    inspectNativeQualificationAssociation(
      reports,
      f.request,
      archives.slice(0, 1),
      "payload-signing",
    ),
  );
  await assert.rejects(
    inspectNativeQualificationAssociation(
      reports,
      f.request,
      [archives[0], archives[0]],
      "payload-signing",
    ),
  );
  await assert.rejects(
    inspectNativeQualificationAssociation(reports, f.request, archives, "release-publication"),
  );
  const full = await trustedAssemblyFixture(t);
  await assert.rejects(
    inspectNativeQualificationAssociation(reports, full.request, archives, "payload-signing"),
    /full package profile/u,
  );
});
