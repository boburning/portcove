import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyGitHubReleaseAttestation } from "./github-release-attestation.mts";

// A real GitHub immutable-release attestation (nightly-0.1.0-preview.14), read
// anonymously from the public attestations API, and GitHub's entry of the
// Sigstore trusted root read anonymously through `gh attestation trusted-root`.
interface Certificates {
  certChain: { certificates: { rawBytes: string }[] };
  validFor: { start: string; end?: string };
}
interface TrustedRoot {
  certificateAuthorities: Certificates[];
  timestampAuthorities: Certificates[];
}
interface Bundle {
  mediaType: string;
  dsseEnvelope: { payload: string; payloadType: string; signatures: { sig: string }[] };
  verificationMaterial: {
    certificate: { rawBytes: string };
    timestampVerificationData?: { rfc3161Timestamps: { signedTimestamp: string }[] };
  };
}
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/github-release-attestation/${name}`, import.meta.url), "utf8"),
  );
const bundle = () => fixture("nightly-0.1.0-preview.14.bundle.json") as Bundle;
const root = () => fixture("trusted-root.json") as TrustedRoot;
const flip = (value: string, index = 10) => {
  const bytes = Buffer.from(value, "base64");
  bytes[index] = bytes[index]! ^ 1;
  return bytes.toString("base64");
};

void test("a real GitHub release attestation verifies offline without credentials", () => {
  const { statement, signed_at } = verifyGitHubReleaseAttestation(bundle(), root());
  assert.equal(signed_at, "2026-11-22T16:20:14.000Z");
  assert.equal(statement.predicateType, "https://in-toto.io/attestation/release/v0.2");
  const predicate = statement.predicate as Record<string, unknown>;
  assert.equal(predicate.tag, "nightly-0.1.0-preview.14");
  assert.equal(predicate.repository, "boburning/portcove");
  const subjects = statement.subject as { name?: string; digest: Record<string, string> }[];
  assert.equal(
    subjects.find((subject) => subject.name === "portcove-cli-0.1.0-preview.14-linux-x86_64.tar.gz")
      ?.digest.sha256,
    "1a5fa16c73518d89c0779d8d7c326e3a4776e4fe96119a217c67c075f07c7050",
  );
});

void test("tampered statements, signatures, certificates and timestamps are refused", () => {
  const refused = (mutate: (value: Bundle) => void, expected: RegExp, trust = root()) => {
    const value = bundle();
    mutate(value);
    assert.throws(() => verifyGitHubReleaseAttestation(value, trust), expected);
  };
  // A changed statement no longer matches the signature.
  refused((value) => {
    const statement = JSON.parse(Buffer.from(value.dsseEnvelope.payload, "base64").toString()) as {
      subject: { digest: { sha256: string } }[];
    };
    statement.subject[1]!.digest.sha256 = "0".repeat(64);
    value.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  }, /signature differs/u);
  // A changed signature is no longer the one the timestamp covers.
  refused((value) => {
    const signature = value.dsseEnvelope.signatures[0]!;
    signature.sig = flip(signature.sig, 20);
  }, /timestamp does not cover the attestation signature/u);
  // Another signer identity.
  refused((value) => {
    value.verificationMaterial.certificate.rawBytes =
      root().timestampAuthorities[0]!.certChain.certificates[0]!.rawBytes;
  }, /signer identity differs/u);
  refused((value) => {
    delete value.verificationMaterial.timestampVerificationData;
  }, /signed timestamp missing/u);
  refused((value) => {
    const token = value.verificationMaterial.timestampVerificationData!.rfc3161Timestamps[0]!;
    const bytes = Buffer.from(token.signedTimestamp, "base64");
    // The last byte is inside the TSA signature value.
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    token.signedTimestamp = bytes.toString("base64");
  }, /no trusted timestamp authority/u);
  refused((value) => {
    value.dsseEnvelope.signatures.push(value.dsseEnvelope.signatures[0]!);
  }, /exactly one signature/u);
  refused((value) => {
    value.mediaType = "application/vnd.dev.sigstore.bundle.v0.2+json";
  }, /unexpected bundle/u);
  refused((value) => {
    value.dsseEnvelope.payloadType = "text/plain";
  }, /unexpected payload type/u);
  // Trust material that does not include GitHub's authorities refuses.
  refused(() => undefined, /no trusted timestamp authority/u, {
    ...root(),
    timestampAuthorities: [],
  });
  refused(() => undefined, /does not chain/u, { ...root(), certificateAuthorities: [] });
  // An authority is trusted only within its validity window.
  const expired = root();
  for (const authority of expired.certificateAuthorities)
    authority.validFor = { start: "2020-01-01T00:00:00Z", end: "2020-02-01T00:00:00Z" };
  refused(() => undefined, /does not chain/u, expired);
  // A certificate authority from another root cannot vouch for the signer.
  const foreign = root();
  for (const authority of foreign.certificateAuthorities)
    authority.certChain.certificates = root().timestampAuthorities[0]!.certChain.certificates;
  refused(() => undefined, /does not chain/u, foreign);
});
