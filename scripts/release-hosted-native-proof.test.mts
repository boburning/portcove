import assert from "node:assert/strict";
import test from "node:test";
import { hostedNativeProofFixture } from "./fixtures/hosted-native-proof-fixture.mts";
import {
  inspectHostedNativeProofFiles,
  prepareHostedNativeProofSubject,
  hostedNativeProofLimits,
  inspectHostedNativeTransportIdentities,
  inspectHostedNativeCustodyBundle,
} from "./release-hosted-native-proof-contract.mts";
import { prepareHostedNativeStageRequest } from "./release-native-stage-capture.mts";
import { inspectSelectedPublicationAuthorityConfiguration } from "./release-authority-configuration.mts";
import { isRecord } from "./runtime-values.mts";

for (const stage of ["payload-signing", "release-publication"] as const) {
  void test(`${stage} source-selected Server proof states continuity only and preserves client compatibility`, () => {
    const f = hostedNativeProofFixture("windows-x86_64", stage, "server-continuity");
    const checked = inspectHostedNativeProofFiles(f.files, f.authorities, f.producer);
    assert.equal(checked.qualification_scope, "continuity-only");
    const subject: unknown = JSON.parse(checked.subject.toString());
    assert.ok(isRecord(subject));
    assert.equal(subject.purpose, "hosted-native-continuity");
    assert.equal(checked.report.host.minimum_platform, "windows-server-2022-x64-continuity");
    assert.equal(checked.report.host.os_version, "10.0.20348.1000");
    assert.equal(checked.report.compatibility.minimum_os_version, "10.0.26200");
    assert.equal(checked.signature_verification, "not-performed");
    assert.equal(checked.authority, "none");
    for (const minimum of ["10.0.20348", "unknown"]) {
      const altered = structuredClone(f.authorities);
      altered.hosted_native["windows-x86_64"].compatibility.minimum_os_version = minimum;
      assert.throws(() => inspectSelectedPublicationAuthorityConfiguration(altered));
    }
    for (const os of [
      { ...f.hostObservation.os, product_type: 1 },
      { ...f.hostObservation.os, caption: "Microsoft Windows Server 2025" },
      { ...f.hostObservation.os, version: "10.0.20347.1000" },
      { ...f.hostObservation.os, display_version: "26H2" },
    ])
      assert.throws(
        () =>
          prepareHostedNativeProofSubject(
            f.authorities,
            f.producer,
            f.files.report,
            f.files.capture,
            { ...f.hostObservation, os },
          ),
        /observation differs/,
      );
    assert.throws(
      () =>
        prepareHostedNativeProofSubject(
          f.authorities,
          f.producer,
          f.files.report,
          f.files.capture,
          { ...f.hostObservation, architecture: "arm64" },
        ),
      /host identity/,
    );
    const client = hostedNativeProofFixture("windows-x86_64", stage);
    assert.throws(
      () =>
        prepareHostedNativeProofSubject(
          client.authorities,
          client.producer,
          client.files.report,
          client.files.capture,
          f.hostObservation,
        ),
      /observation differs/,
    );
    assert.throws(
      () =>
        inspectHostedNativeProofFiles(
          {
            ...f.files,
            subject: Buffer.from(
              JSON.stringify({
                ...subject,
                purpose: "hosted-native-qualification",
              }),
            ),
          },
          f.authorities,
          f.producer,
        ),
      /manifest differs/,
    );
  });
}

for (const platform of ["windows-x86_64", "linux-x86_64"] as const) {
  for (const stage of ["payload-signing", "release-publication"] as const) {
    void test(`${platform}/${stage} exact selected proof binds structured capture including teardown without authority`, () => {
      const f = hostedNativeProofFixture(platform, stage);
      const checked = inspectHostedNativeProofFiles(f.files, f.authorities, f.producer);
      assert.equal(checked.authority, "none");
      assert.equal(checked.signature_verification, "not-performed");
      assert.equal(checked.report.stage, stage);
      assert.equal(checked.report.platform_label, platform);
      assert.equal(checked.capture.group?.empty, true);
      assert.equal(
        checked.report.runtime.capture_sha256,
        checked.report.runtime.teardown.capture_sha256,
      );
      assert.ok(f.files.capture.length <= hostedNativeProofLimits.capture);
      f.files.report.fill(0);
      assert.notEqual(checked.files.report[0], 0);
    });
  }
  void test(`${platform} selected request refuses conflated or wrong-platform accounts and freezes its host snapshot`, () => {
    const f = hostedNativeProofFixture(platform);
    const captured = prepareHostedNativeStageRequest(f.request, f.authorities, f.host);
    f.host.machine_id_sha256 = "9".repeat(64);
    assert.notEqual(captured.request.expected.host.machine_id_sha256, f.host.machine_id_sha256);
    assert.throws(() =>
      prepareHostedNativeStageRequest(f.request, f.authorities, {
        ...f.host,
        account: { ...f.host.account, qualification: f.host.account.broker },
      }),
    );
    assert.throws(() =>
      prepareHostedNativeStageRequest(f.request, f.authorities, {
        ...f.host,
        account:
          platform === "windows-x86_64"
            ? { kind: "linux-uid", broker: "1000", qualification: "1001" }
            : { kind: "windows-sid", broker: "S-1-5-21-1", qualification: "S-1-5-21-2" },
      }),
    );
  });
}
for (const fault of [
  "source",
  "compatibility",
  "old-engine",
  "missing-root",
  "capture",
  "manifest",
  "issuer-binding",
  "incomplete",
  "oversize",
  "unbound-bundle",
] as const) {
  void test(`selected native proof refuses ${fault} without claiming signature/native acceptance`, () => {
    const f = hostedNativeProofFixture();
    const report = structuredClone(f.report);
    if (fault === "source") report.producer.source_commit = "9".repeat(40);
    if (fault === "compatibility") report.compatibility.catalog_formats = [1];
    if (fault === "old-engine") report.host.loaded_engine.version = "1.0";
    if (fault === "missing-root") report.runtime.root_pid++;
    if (fault === "capture") report.runtime.capture_sha256 = "9".repeat(64);
    const modified =
      fault === "incomplete"
        ? {
            ...report,
            runtime: {
              ...report.runtime,
              teardown: { ...report.runtime.teardown, root_exited: false },
            },
          }
        : report;
    if (
      ["source", "compatibility", "old-engine", "missing-root", "capture", "incomplete"].includes(
        fault,
      )
    )
      f.files.report = Buffer.from(JSON.stringify(modified));
    if (fault === "manifest") f.files.subject = Buffer.concat([f.files.subject, Buffer.from("\n")]);
    if (fault === "issuer-binding") f.producer.grant_sha256 = "9".repeat(64);
    if (fault === "oversize") f.files.capture = Buffer.alloc(hostedNativeProofLimits.capture + 1);
    if (fault === "unbound-bundle")
      f.files.bundle = Buffer.from(
        JSON.stringify({
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload: Buffer.from("{}").toString("base64"),
            signatures: [{}],
          },
        }),
      );
    assert.throws(() => inspectHostedNativeProofFiles(f.files, f.authorities, f.producer));
  });
}
void test("selected original-attempt source binding rejects reruns and unknown fields before any signing", () => {
  const f = hostedNativeProofFixture();
  assert.throws(() =>
    prepareHostedNativeProofSubject(
      f.authorities,
      { ...f.producer, run_attempt: 2 },
      f.files.report,
      f.files.capture,
      f.hostObservation,
    ),
  );
  assert.throws(() =>
    prepareHostedNativeProofSubject(
      f.authorities,
      { ...f.producer, authority: "accepted" },
      f.files.report,
      f.files.capture,
      f.hostObservation,
    ),
  );
});

for (const platform of ["windows-x86_64", "linux-x86_64"] as const) {
  void test(`${platform} observed OS contradictions and independently altered report scenarios are refused before signing`, () => {
    const f = hostedNativeProofFixture(platform);
    const badOs =
      platform === "windows-x86_64"
        ? {
            product_type: 3,
            caption: "Microsoft Windows Server 2025",
            display_version: "26H2",
            version: f.report.host.os_version,
            build_number: "26200",
          }
        : { id: "ubuntu", version_id: "22.04", kernel_release: f.report.host.os_version };
    assert.throws(
      () =>
        prepareHostedNativeProofSubject(
          f.authorities,
          f.producer,
          f.files.report,
          f.files.capture,
          { ...f.hostObservation, os: badOs },
        ),
      /observation differs/,
    );
    const report = structuredClone(f.report);
    report.scenarios[0]!.capture_sha256 = "e".repeat(64);
    assert.throws(
      () =>
        prepareHostedNativeProofSubject(
          f.authorities,
          f.producer,
          Buffer.from(JSON.stringify(report)),
          f.files.capture,
          f.hostObservation,
        ),
      /exact capture/,
    );
  });
}

void test("selected native transport identities preserve job/report/subject separately and reject fake Check fields or mixed platforms", () => {
  const entries = (["windows-x86_64", "linux-x86_64"] as const).map((platform) => {
    const f = hostedNativeProofFixture(platform),
      prepared = inspectHostedNativeProofFiles(f.files, f.authorities, f.producer);
    return {
      platform,
      transport: "fixed-hosted-job",
      report_sha256: prepared.report_sha256,
      hosted_job: {
        ...f.producer,
        subject_sha256: prepared.subject_sha256,
        report_sha256: prepared.report_sha256,
        bundle_sha256: "b".repeat(64),
      },
    };
  });
  assert.deepEqual(inspectHostedNativeTransportIdentities(entries), entries);
  assert.throws(() => inspectHostedNativeTransportIdentities([entries[0], entries[0]]));
  assert.throws(() =>
    inspectHostedNativeTransportIdentities([{ ...entries[0], check_id: 1 }, entries[1]]),
  );
  assert.throws(() =>
    inspectHostedNativeTransportIdentities([
      { ...entries[0], report_sha256: "e".repeat(64) },
      entries[1],
    ]),
  );
});

void test("bounded custody preserves all original proof bytes without signature or durable-custody authority", () => {
  const fixtures = (["linux-x86_64", "windows-x86_64"] as const).map((platform) =>
    hostedNativeProofFixture(platform),
  );
  const value = {
    schema_version: 1,
    purpose: "hosted-native-custody",
    configuration: inspectSelectedPublicationAuthorityConfiguration(fixtures[0]!.authorities),
    stage: "payload-signing",
    proofs: fixtures.map((f) => ({
      platform_label: f.report.platform_label,
      producer: f.producer,
      files: Object.fromEntries(
        (["subject", "report", "capture", "bundle"] as const).map((key) => [
          key,
          f.files[key].toString("base64"),
        ]),
      ),
    })),
  };
  const bytes = Buffer.from(JSON.stringify(value)),
    checked = inspectHostedNativeCustodyBundle(bytes);
  assert.equal(checked.authority, "none");
  assert.equal(checked.signature_verification, "not-performed");
  assert.ok(checked.bytes.length < hostedNativeProofLimits.custody);
  for (const [i, f] of fixtures.entries())
    for (const key of ["subject", "report", "capture", "bundle"] as const)
      assert.deepEqual(checked.proofs[i]!.files[key], f.files[key]);
  for (const modified of [
    { ...value, proofs: [...value.proofs].reverse() },
    { ...value, proofs: [value.proofs[0], value.proofs[0]] },
    { ...value, stage: "release-publication" },
    {
      ...value,
      proofs: [
        { ...value.proofs[0], files: { ...value.proofs[0]!.files, capture: "" } },
        value.proofs[1],
      ],
    },
    { ...value, authority: "accepted" },
  ])
    assert.throws(() => inspectHostedNativeCustodyBundle(Buffer.from(JSON.stringify(modified))));
  assert.throws(() =>
    inspectHostedNativeCustodyBundle(Buffer.alloc(hostedNativeProofLimits.custody + 1)),
  );
  assert.throws(() => inspectHostedNativeCustodyBundle(Buffer.concat([bytes, Buffer.from("\n")])));
});
