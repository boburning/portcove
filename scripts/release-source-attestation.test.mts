import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectReleaseSourceAttestation,
  releaseProcessPredicate,
} from "./release-source-attestation.mts";

const expected = {
  source_commit: "a".repeat(40),
  ref: "refs/tags/portcove-beta-prepared/v0.9.1",
  run_id: "12345",
  run_attempt: 2,
  subjects: [{ filename: "compiler-result-cli-linux-x86_64.json", sha256: "b".repeat(64) }],
};
function fixture() {
  return [
    {
      verificationResult: {
        verifiedTimestamps: [{ type: "inert fixture; parser only" }],
        signature: {
          certificate: {
            issuer: "https://token.actions.githubusercontent.com",
            sourceRepositoryIdentifier: "1354613114",
            sourceRepositoryURI: "https://github.com/boburning/portcove",
            buildSignerURI: `https://github.com/boburning/portcove/.github/workflows/release.yml@${expected.ref}`,
            buildSignerDigest: expected.source_commit,
            sourceRepositoryDigest: expected.source_commit,
            sourceRepositoryRef: expected.ref,
            runnerEnvironment: "github-hosted",
            runInvocationURI: `https://github.com/boburning/portcove/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`,
          },
        },
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: releaseProcessPredicate,
          subject: expected.subjects.map((entry) => ({
            name: entry.filename,
            digest: { sha256: entry.sha256 },
          })),
          predicate: { inert: true },
        },
      },
    },
  ];
}
void test("source report parser binds complete exact subjects and workflow/source/run/attempt without minting authority", () => {
  const result = inspectReleaseSourceAttestation(fixture(), expected);
  assert.equal(result.authority, "none");
  assert.equal(result.statement.predicateType, releaseProcessPredicate);
  assert.throws(
    () => inspectReleaseSourceAttestation([...fixture(), ...fixture()], expected),
    /ambiguous/,
  );
});
void test("wrong issuer/ref/workflow/source/attempt, missing timestamps and changed/extra/omitted subject refuse", () => {
  for (const [key, value] of [
    ["issuer", "https://wrong.invalid"],
    [
      "buildSignerURI",
      "https://github.com/boburning/portcove/.github/workflows/ci.yml@refs/heads/main",
    ],
    ["buildSignerDigest", "c".repeat(40)],
    ["sourceRepositoryRef", "refs/heads/main"],
    ["runInvocationURI", "https://github.com/boburning/portcove/actions/runs/12345/attempts/1"],
    ["runnerEnvironment", "self-hosted"],
  ]) {
    const raw = fixture();
    Object.assign(raw[0]!.verificationResult.signature.certificate, { [key!]: value });
    assert.throws(() => inspectReleaseSourceAttestation(raw, expected), /differs/);
  }
  for (const change of [
    (raw: ReturnType<typeof fixture>) => {
      raw[0]!.verificationResult.verifiedTimestamps = [];
    },
    (raw: ReturnType<typeof fixture>) => {
      raw[0]!.verificationResult.statement.subject = [];
    },
    (raw: ReturnType<typeof fixture>) => {
      raw[0]!.verificationResult.statement.subject.push({
        name: "extra.json",
        digest: { sha256: "c".repeat(64) },
      });
    },
    (raw: ReturnType<typeof fixture>) => {
      raw[0]!.verificationResult.statement.subject[0]!.digest.sha256 = "c".repeat(64);
    },
  ]) {
    const raw = fixture();
    change(raw);
    assert.throws(() => inspectReleaseSourceAttestation(raw, expected));
  }
});
