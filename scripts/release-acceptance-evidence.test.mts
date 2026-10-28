import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { releasePublicBuildProvenanceFixture } from "./fixtures/release-public-build-provenance-fixture.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import {
  inspectReleaseSpdx,
  inspectVerifiedReleaseSbom,
  collectReleaseSbomEvidence,
  releaseSpdxPredicateType,
  requireVerifiedReleaseSbomDocument,
} from "./release-acceptance-evidence.mts";

const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "inert graph fixture",
  documentNamespace: "https://example.invalid/spdx/fixture",
  creationInfo: { created: "2026-10-20T00:00:00Z", creators: ["Tool: syft-1.54.1"] },
  packages: [
    {
      SPDXID: "SPDXRef-package",
      name: "fixture",
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
    },
  ],
  relationships: [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relatedSpdxElement: "SPDXRef-package",
      relationshipType: "DESCRIBES",
    },
  ],
};
void test("SPDX producer compatibility admits the current scanner while retaining historical evidence", () => {
  const current = structuredClone(document);
  current.creationInfo.creators = ["Tool: syft-1.55.0"];
  assert.doesNotThrow(() => inspectReleaseSpdx(current));
  assert.doesNotThrow(() => inspectReleaseSpdx(document));
  for (const creator of ["Tool: syft-1.55.1", "Tool: syft-1.55.0-unreviewed", "Tool: other"]) {
    current.creationInfo.creators = [creator];
    assert.throws(() => inspectReleaseSpdx(current), /pinned Syft producer/);
  }
});
void test("imported SPDX summaries cannot appoint retained publication document bytes", async () => {
  await assert.rejects(requireVerifiedReleaseSbomDocument({}), /actual same-process/);
  await assert.rejects(
    requireVerifiedReleaseSbomDocument({
      state: "verified-document",
      evidence_scope: "github.com",
      document_sha256: "a".repeat(64),
    }),
    /actual same-process/,
  );
});
const expected = {
  revision: "a".repeat(40),
  ref: "refs/tags/v0.1.0-alpha.3",
  run_id: "12345",
  run_attempt: 1,
  subjects: [{ filename: "fixture-package", sha256: "b".repeat(64) }],
  document,
};
function verification() {
  return [
    {
      verificationResult: {
        signature: {
          certificate: {
            issuer: "https://token.actions.githubusercontent.com",
            sourceRepositoryIdentifier: "1354613114",
            sourceRepositoryURI: "https://github.com/boburning/portcove",
            buildSignerURI: `https://github.com/boburning/portcove/.github/workflows/release.yml@${expected.ref}`,
            buildSignerDigest: expected.revision,
            sourceRepositoryDigest: expected.revision,
            sourceRepositoryRef: expected.ref,
            runnerEnvironment: "github-hosted",
            runInvocationURI: "https://github.com/boburning/portcove/actions/runs/12345/attempts/1",
          },
        },
        verifiedTimestamps: [{}],
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: releaseSpdxPredicateType,
          subject: expected.subjects.map(({ filename, sha256 }) => ({
            name: filename,
            digest: { sha256 },
          })),
          predicate: structuredClone(document),
        },
      },
    },
  ];
}

void test("strict SPDX validates pinned producer and closed graph without claiming scanner/compiler acceptance", () => {
  assert.match(inspectReleaseSpdx(document).scope, /no scanner, compiler or native/);
  for (const change of [
    (copy: typeof document) => {
      copy.creationInfo.creators = ["Tool: arbitrary"];
    },
    (copy: typeof document) => {
      copy.packages.push(copy.packages[0]!);
    },
    (copy: typeof document) => {
      copy.relationships[0]!.relatedSpdxElement = "SPDXRef-missing";
    },
    (copy: typeof document) => {
      copy.relationships = [];
    },
  ]) {
    const copy = structuredClone(document);
    change(copy);
    assert.throws(() => inspectReleaseSpdx(copy));
  }
});
void test("verified SBOM requires exact issuer/run/attempt/source, all subjects and actual document", () => {
  assert.equal(inspectVerifiedReleaseSbom(verification(), expected).authority, "none");
  for (const change of [
    (copy: ReturnType<typeof verification>) => {
      copy[0]!.verificationResult.signature.certificate.issuer = "https://example.invalid";
    },
    (copy: ReturnType<typeof verification>) => {
      copy[0]!.verificationResult.signature.certificate.runInvocationURI += "0";
    },
    (copy: ReturnType<typeof verification>) => {
      copy[0]!.verificationResult.signature.certificate.buildSignerDigest = "c".repeat(40);
    },
    (copy: ReturnType<typeof verification>) => {
      copy[0]!.verificationResult.statement.subject = [];
    },
    (copy: ReturnType<typeof verification>) => {
      copy[0]!.verificationResult.statement.predicate.name = "substituted";
    },
  ]) {
    const copy = verification();
    change(copy);
    assert.throws(() => inspectVerifiedReleaseSbom(copy, expected));
  }
  assert.throws(
    () => inspectVerifiedReleaseSbom([...verification(), ...verification()], expected),
    /ambiguous/,
  );
});
void test("dispatch without an existing signed final artifact remains Unknown without network", async (t) => {
  const f = await releasePublicBuildProvenanceFixture(t);
  const evidence = collectReleaseRunEvidence(f.expected, { api: f.api });
  const result = await collectReleaseSbomEvidence(f.root, f.request, evidence, {
    download: () => {
      throw new Error("unexpected network");
    },
  });
  assert.equal(result.state, "unknown");
});
void test("actual bounded ZIP + verifier transport validates fixture document but remains injected-provider", async (t) => {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const source = await releasePublicBuildProvenanceFixture(t);
  const evidence = collectReleaseRunEvidence(source.expected, { api: source.api });
  const packages = f.request.files.filter(
    (file) =>
      !file.filename.startsWith("SHA256SUMS-") && !file.filename.startsWith("release-producer-"),
  );
  const archive = createAuditZip([
    ...packages.map(
      (file) =>
        [file.filename, f.contents.get(`${file.platform_label}/${file.filename}`)!] as const,
    ),
    ["SHA256SUMS.txt", Buffer.from("fixture unused manifest")],
    ["Portcove-SBOM.spdx.json", Buffer.from(JSON.stringify(document))],
  ]);
  evidence.run.event = "push";
  evidence.jobs = [
    {
      id: 765,
      name: "attest",
      status: "completed",
      conclusion: "success",
      runner_id: 44,
      runner_name: "fixture-hosted",
      started_at: "2026-10-20T00:00:00Z",
      completed_at: "2026-10-20T00:01:00Z",
    },
  ];
  evidence.artifacts = [
    {
      id: 987,
      name: "release-final-12345-1",
      bytes: archive.length,
      archive_sha256: createHash("sha256").update(archive).digest("hex"),
      expired: false,
      created_at: "2026-10-20T00:00:00Z",
      expires_at: null,
      producer_attempt: null,
      producer_job_id: null,
    },
  ];
  const value = verification();
  value[0]!.verificationResult.statement.subject = packages.map(({ filename, sha256 }) => ({
    name: filename,
    digest: { sha256 },
  }));
  const result = await collectReleaseSbomEvidence(f.root, f.request, evidence, {
    download: () => archive,
    spawn: (command, args) => {
      assert.equal(command, "gh");
      assert.ok(args.includes("--deny-self-hosted-runners"));
      assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
      return { status: 0, stdout: JSON.stringify(value), stderr: "" };
    },
  });
  assert.equal(result.state, "verified-document");
  assert.equal(result.evidence_scope, "injected-provider");
  assert.equal(result.authority, "none");
  await assert.rejects(requireVerifiedReleaseSbomDocument(result), /actual same-process/);
  evidence.run.event = "workflow_dispatch";
  const preparedRef = `refs/tags/portcove-fixture-prepared/v${f.request.version}`;
  value[0]!.verificationResult.signature.certificate.sourceRepositoryRef = preparedRef;
  value[0]!.verificationResult.signature.certificate.buildSignerURI = `https://github.com/boburning/portcove/.github/workflows/release.yml@${preparedRef}`;
  const dispatch = await collectReleaseSbomEvidence(f.root, f.request, evidence, {
    preparedNamespace: "portcove-fixture",
    download: () => archive,
    spawn: (_command, args) => {
      assert.equal(args[args.indexOf("--source-ref") + 1], preparedRef);
      return { status: 0, stdout: JSON.stringify(value), stderr: "" };
    },
  });
  assert.equal(dispatch.state, "verified-document");
  assert.equal(dispatch.evidence_scope, "injected-provider");
  await assert.rejects(
    collectReleaseSbomEvidence(f.root, f.request, evidence, { download: () => archive }),
    /reservation namespace/,
  );
  evidence.run.event = "push";
  await assert.rejects(
    collectReleaseSbomEvidence(f.root, f.request, evidence, {
      download: () => Buffer.from("changed"),
    }),
    /bytes differ/,
  );
});
