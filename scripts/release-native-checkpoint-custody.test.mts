import assert from "node:assert/strict";
import test from "node:test";
import { hostedNativeProofFixture } from "./fixtures/hosted-native-proof-fixture.mts";
import { remoteFixture, checkpointEvidence } from "./fixtures/coordinator-state-fixtures.mts";
import { inspectSelectedPublicationAuthorityConfiguration } from "./release-authority-configuration.mts";
import { inspectHostedNativeCustodyBundle } from "./release-hosted-native-proof-contract.mts";
import { candidateProgressIdentity } from "./release-candidate-progress-contract.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectHostedNativePredecessorRecord } from "./release-hosted-native-history.mts";
import {
  inspectNativeCheckpointCustody,
  inspectNativeCheckpointLocator,
  nativeCheckpointLocatorFromBuilding,
  nativeCheckpointEvidenceId,
} from "./release-native-checkpoint-custody.mts";
import {
  prepareCoordinatorCheckpointSigningInput,
  inspectCoordinatorCheckpointEvidence,
  nativeCoordinatorCheckpointPredicateType,
  readCoordinatorCheckpointEvidence,
} from "./release-coordinator-checkpoint-evidence.mts";

void test("native carrier binds original bytes to a fresh candidate/job pair without a self-reference or new Git object", async (t) => {
  const f = await remoteFixture(t);
  const fixtures = (["linux-x86_64", "windows-x86_64"] as const).map((p) =>
    hostedNativeProofFixture(p),
  );
  const value = {
    schema_version: 1,
    purpose: "hosted-native-custody",
    configuration: inspectSelectedPublicationAuthorityConfiguration(fixtures[0]!.authorities),
    stage: "payload-signing",
    proofs: fixtures.map((p) => ({
      platform_label: p.report.platform_label,
      producer: p.producer,
      files: Object.fromEntries(
        (["subject", "report", "capture", "bundle"] as const).map((key) => [
          key,
          p.files[key].toString("base64"),
        ]),
      ),
    })),
  };
  const native = inspectHostedNativeCustodyBundle(Buffer.from(JSON.stringify(value)));
  const { configuration_sha256: _full, grant_sha256: _grant, ...issuer } = fixtures[0]!.producer;
  const producer = {
    ...issuer,
    job_id: String(issuer.job_id),
    configuration_sha256: digest(native.configuration.journal),
  };
  const configuration = { schema_version: 1, namespace: native.configuration.journal.namespace };
  const original = fixtures[0]!.report.candidate;
  const candidate = {
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    prepared_commit: original.source_commit,
    prepared_tree: original.source_tree,
    version: "0.1.0-beta.1",
    intent_sha256: "3".repeat(64),
    phase: "building",
    transient_retries: 0,
    substantive_repairs: 0,
    release_run: {
      run_id: Number(original.run_id),
      attempt: original.run_attempt,
      revision: original.source_commit,
    },
  };
  const proof = {
    schema_version: 1,
    candidate_sha256: candidateProgressIdentity(candidate),
    controller_revision: producer.controller_revision,
    locators: [
      ...native.proofs.map((p) => ({
        kind: "native-job",
        id: `${p.producer.run_id}:${p.producer.run_attempt}:${p.producer.job_id}:${p.producer.check_run_id}`,
        sha256: p.subject_sha256,
      })),
      {
        kind: "native-custody",
        id: `${native.sha256}:${native.bytes.length}`,
        sha256: native.sha256,
      },
      ...native.proofs.map((p) => ({
        kind: "artifact",
        id: String(p.report.candidate.artifact_id),
        sha256: "e".repeat(64),
      })),
    ],
  };
  const attempt = {
    previous_checkpoint: f.checkpoint.previous,
    evidence_sha256: digest(proof),
    proof,
    release_run: candidate.release_run,
    transient_retries: 0,
    substantive_repairs: 0,
  };
  const checkpoint = structuredClone(f.checkpoint);
  const state = {
    input: {
      active_candidate: {
        ...candidate,
        stage_evidence: [{ phase: "building", attempts: [attempt] }],
      },
    },
  };
  checkpoint.blob.contents = JSON.stringify(state);
  const retainedBuilding = { checkpoint: checkpoint.checkpoint, input: state.input };
  const locator = nativeCheckpointLocatorFromBuilding(retainedBuilding, candidate);
  assert.deepEqual(locator, {
    checkpoint: checkpoint.checkpoint,
    native_bundle_sha256: native.sha256,
    native_bundle_bytes: native.bytes.length,
  });
  assert.equal(
    nativeCheckpointEvidenceId(locator),
    `native-checkpoint:${checkpoint.checkpoint}:${native.sha256}:${native.bytes.length}`,
  );
  assert.throws(
    () =>
      nativeCheckpointLocatorFromBuilding(retainedBuilding, {
        ...candidate,
        prepared_commit: "f".repeat(40),
      }),
    /candidate/,
  );
  for (const bad of [
    { ...locator, native_bundle_bytes: 1048577 },
    { ...locator, native_bundle_bytes: 0 },
    { ...locator, checkpoint: "not-a-checkpoint" },
    { ...locator, accepted: true },
  ])
    assert.throws(() => inspectNativeCheckpointLocator(bad));
  for (const proof of native.proofs) {
    const originalCandidate = proof.report.candidate,
      producer = proof.producer;
    const record: {
      target: string;
      source_commit: string;
      source_tree: string;
      qualified_run: { workflow: string; workflow_commit: string; run_id: string; attempt: number };
      artifact: { bytes: number; sha256: string; url: string };
      evidence_ids: string[];
    } = {
      target: proof.report.platform_label,
      source_commit: originalCandidate.source_commit,
      source_tree: originalCandidate.source_tree,
      qualified_run: {
        workflow: ".github/workflows/release.yml",
        workflow_commit: originalCandidate.source_commit,
        run_id: originalCandidate.run_id,
        attempt: originalCandidate.run_attempt,
      },
      artifact: {
        bytes: originalCandidate.package.bytes,
        sha256: originalCandidate.package.sha256,
        url: `https://github.com/boburning/portcove/releases/download/v0.1.0-beta.1/${originalCandidate.package.filename}`,
      },
      evidence_ids: [
        nativeCheckpointEvidenceId(locator),
        `native-job:${producer.run_id}:${producer.run_attempt}:${producer.job_id}:${producer.check_run_id}:${proof.subject_sha256}`,
        `native-report:${proof.report_sha256}`,
        `native-capture:${proof.report.runtime.capture_sha256}`,
        `native-teardown:${proof.report.runtime.teardown.capture_sha256}`,
      ],
    };
    assert.deepEqual(
      inspectHostedNativePredecessorRecord(record, native).candidate,
      originalCandidate,
    );
    for (const changed of [
      { ...record, source_commit: "f".repeat(40) },
      { ...record, source_tree: "f".repeat(40) },
      { ...record, artifact: { ...record.artifact, sha256: "f".repeat(64) } },
      {
        ...record,
        evidence_ids: [...record.evidence_ids, `native-check:1:${proof.report_sha256}`],
      },
      { ...record, evidence_ids: [...record.evidence_ids, `native-report:${proof.report_sha256}`] },
      {
        ...record,
        evidence_ids: record.evidence_ids.map((entry) =>
          entry.startsWith("native-job:") ? entry.replace(`:${producer.job_id}:`, ":999:") : entry,
        ),
      },
      {
        ...record,
        evidence_ids: record.evidence_ids.map((entry) =>
          entry.startsWith("native-checkpoint:")
            ? entry.replace(native.sha256, "f".repeat(64))
            : entry,
        ),
      },
    ])
      assert.throws(() => inspectHostedNativePredecessorRecord(changed, native));
  }
  assert.equal(
    inspectNativeCheckpointCustody(checkpoint, configuration, producer, value)?.sha256,
    native.sha256,
  );
  assert.throws(
    () => inspectNativeCheckpointCustody(checkpoint, configuration, producer),
    /complete custody/,
  );
  assert.throws(() =>
    inspectNativeCheckpointCustody(
      checkpoint,
      { schema_version: 1, namespace: "portcove-other" },
      producer,
      value,
    ),
  );
  const input = prepareCoordinatorCheckpointSigningInput(
    checkpoint,
    configuration,
    producer,
    value,
  );
  assert.equal(input.statement.predicateType, nativeCoordinatorCheckpointPredicateType);
  assert.ok(input.subject.length > 16384);
  const evidence = {
    subject: input.subject,
    bundle: Buffer.from(
      JSON.stringify({
        dsseEnvelope: {
          payloadType: "application/vnd.in-toto+json",
          payload: Buffer.from(JSON.stringify(input.statement)).toString("base64"),
          signatures: [{ keyid: "inert", sig: "aW5lcnQ=" }],
        },
      }),
    ),
  };
  const inspected = inspectCoordinatorCheckpointEvidence(checkpoint, configuration, evidence);
  assert.equal(inspected.objects.length, 4);
  assert.equal(inspected.signature_verification, "not-performed");
  assert.ok(Buffer.byteLength(JSON.stringify(inspected.objects[1]!.body)) < 2 * 1024 * 1024);
  let reads = 0;
  const retained = readCoordinatorCheckpointEvidence(
    checkpoint,
    configuration,
    {
      graphql() {
        reads++;
        const name = inspected.update.name;
        return {
          data: {
            repository: {
              databaseId: 1354613114,
              nameWithOwner: "boburning/portcove",
              ref: {
                prefix: "refs/tags/",
                name: name.slice("refs/tags/".length),
                target: { __typename: "Commit", oid: inspected.update.afterOid },
              },
            },
          },
        };
      },
      request(method, endpoint) {
        reads++;
        assert.equal(method, "GET");
        const object = inspected.objects.find((entry) =>
          endpoint.endsWith(`/${entry.kind}/${entry.oid}`),
        );
        assert.ok(object);
        if (object.kind === "blobs") {
          assert.ok("content" in object.body && typeof object.body.content === "string");
          return {
            status: 200,
            headers: new Map(),
            body: {
              sha: object.oid,
              encoding: "base64",
              content: object.body.content,
              size: Buffer.from(object.body.content, "base64").length,
            },
          };
        }
        if (object.kind === "trees")
          return {
            status: 200,
            headers: new Map(),
            body: { sha: object.oid, truncated: false, tree: object.body.tree },
          };
        return {
          status: 200,
          headers: new Map(),
          body: { sha: object.oid, tree: { sha: object.body.tree } },
        };
      },
    },
    performance.now() + 60000,
  );
  assert.equal(reads, 6);
  assert.deepEqual(retained.subject, input.subject);
  for (const fault of [
    "source",
    "run",
    "marker",
    "job",
    "extra-job",
    "artifact",
    "missing-artifact",
    "configuration",
    "controller",
    "old-attempt",
  ]) {
    const changed = structuredClone(state);
    const next = changed.input.active_candidate;
    const a = next.stage_evidence[0]!.attempts[0]!;
    const p = structuredClone(producer);
    if (fault === "source") next.prepared_tree = "9".repeat(40);
    if (fault === "run") a.release_run.run_id++;
    if (fault === "marker") a.proof.locators[2]!.id = `${native.sha256}:1`;
    if (fault === "job") a.proof.locators[0]!.id = "999:1:999:999";
    if (fault === "extra-job")
      a.proof.locators.push({ kind: "native-job", id: "999:1:999:999", sha256: "a".repeat(64) });
    if (fault === "artifact") a.proof.locators[3]!.id = "999";
    if (fault === "missing-artifact") a.proof.locators.pop();
    if (fault === "configuration") p.configuration_sha256 = "9".repeat(64);
    if (fault === "controller") p.controller_revision = "9".repeat(40);
    if (fault === "old-attempt") a.previous_checkpoint = "9".repeat(40);
    a.proof.candidate_sha256 = candidateProgressIdentity(next);
    a.evidence_sha256 = digest(a.proof);
    assert.throws(
      () =>
        inspectNativeCheckpointCustody(
          { ...checkpoint, blob: { ...checkpoint.blob, contents: JSON.stringify(changed) } },
          configuration,
          p,
          value,
        ),
      Error,
      fault,
    );
  }
  const later = { ...checkpoint, previous: "9".repeat(40) };
  assert.equal(inspectNativeCheckpointCustody(later, configuration, producer), null);
  assert.equal(
    inspectCoordinatorCheckpointEvidence(f.checkpoint, f.config, checkpointEvidence(f)).objects
      .length,
    4,
  );
});
