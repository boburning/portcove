import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inspectReleaseNativeObservation } from "./release-native-observation.mts";

const expected = {
  platform: "linux-x86_64" as const,
  harness_source_commit: "a".repeat(40),
  harness_source_tree: "b".repeat(40),
  harness_sha256: "c".repeat(64),
  candidate_sha256: "d".repeat(64),
  predecessor_sha256: "e".repeat(64),
};
function observation() {
  return {
    schema_version: 15,
    platform: expected.platform,
    phase: "failed",
    failure: "retained actual failure",
    observation_identity: {
      schema_version: 1,
      harness: "scripts/test-linux-appimage-update.ps1",
      harness_sha256: expected.harness_sha256,
      source_commit: expected.harness_source_commit,
      source_tree: expected.harness_source_tree,
      host_os: "inert report fixture; no host claim",
      host_architecture: "X64",
      started_at: "2026-10-20T00:00:00Z",
    },
    candidate: { sha256: expected.candidate_sha256 },
    predecessor: { sha256: expected.predecessor_sha256 },
    truncated_payload_rejected: true,
    post_exchange_reconciled: false,
  };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
void test("failed/partial real-schema journal keeps its actual phase and reported subset without native acceptance", () => {
  const result = inspectReleaseNativeObservation(bytes(observation()), expected);
  assert.equal(result.phase, "failed");
  assert.deepEqual(result.reported_scenarios, ["truncated_payload_rejected"]);
  assert.ok(result.missing_observations.includes("post_exchange_reconciled"));
  assert.equal(result.native_acceptance, "unknown");
  assert.equal(result.authority, "none");
  assert.ok(result.unresolved.includes("positive matching final process-tree teardown evidence"));
});
void test("changed package, harness, source, old inner report and oversized evidence refuse", () => {
  for (const field of [
    "candidate_sha256",
    "predecessor_sha256",
    "harness_sha256",
    "harness_source_commit",
    "harness_source_tree",
  ] as const)
    assert.throws(() =>
      inspectReleaseNativeObservation(bytes(observation()), {
        ...expected,
        [field]: "f".repeat(field.endsWith("commit") || field.endsWith("tree") ? 40 : 64),
      }),
    );
  assert.throws(
    () =>
      inspectReleaseNativeObservation(bytes({ schema_version: 1, phase: "complete" }), expected),
    /outer-harness/,
  );
  assert.throws(
    () => inspectReleaseNativeObservation(Buffer.alloc(4 * 1024 * 1024 + 1), expected),
    /bound/,
  );
});
void test("maintained native producers capture actual harness checkout/file/host and package pair identities", async () => {
  for (const filename of ["test-linux-appimage-update.ps1", "test-windows-installer.ps1"]) {
    const source = await readFile(new URL(`./${filename}`, import.meta.url), "utf8");
    assert.match(source, /observation_identity = \[ordered\]@\{/);
    assert.match(source, /Get-FileHash -LiteralPath \$PSCommandPath/);
    assert.match(source, /source_tree = \(& git rev-parse 'HEAD\^\{tree\}'/);
    assert.match(source, /OSDescription/);
    assert.match(source, /requires independently authenticated handoff/);
  }
});
