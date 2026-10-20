import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  inspectPublicationResultArchive,
  preparePublicationResultPredicate,
  receivePublicationResultArtifact,
  requireReceivedPublicationResult,
} from "./release-publication-result-artifact.mts";

void test("publication result handoff admits one bounded UTF-8 member and rejects alternate inventory, CRC, and expansion", () => {
  const bytes = Buffer.from('{"scope":"fixture-integrity-only"}\n');
  for (const method of [0, 8]) {
    const archive = createAuditZip([["immutable-release-result.json", bytes, { method }]]);
    assert.deepEqual(inspectPublicationResultArchive(archive), bytes);
  }
  assert.throws(
    () => inspectPublicationResultArchive(createAuditZip([["other.json", bytes]])),
    /path|inventory/,
  );
  assert.throws(
    () =>
      inspectPublicationResultArchive(
        createAuditZip([
          ["immutable-release-result.json", bytes],
          ["extra", bytes],
        ]),
      ),
    /limit|inventory|bound|path/,
  );
  assert.throws(
    () =>
      inspectPublicationResultArchive(
        createAuditZip([["immutable-release-result.json", Buffer.alloc(65537)]]),
      ),
    /limit|bound/,
  );
  const archive = createAuditZip([["immutable-release-result.json", bytes, { method: 0 }]]);
  const offset = 30 + Buffer.byteLength("immutable-release-result.json");
  archive[offset] = archive[offset]! ^ 1;
  assert.throws(() => inspectPublicationResultArchive(archive), /byte|CRC/);
  assert.throws(
    () =>
      inspectPublicationResultArchive(
        createAuditZip([["immutable-release-result.json", Buffer.from([0xff])]]),
      ),
    /byte/,
  );
  assert.deepEqual(
    inspectPublicationResultArchive(
      createAuditZip([["immutable-release-result-attestation.json", bytes]]),
      true,
    ),
    bytes,
  );
});

void test("copied publication custody cannot prepare a predicate or establish a received result", async () => {
  await assert.rejects(
    preparePublicationResultPredicate(
      {},
      { id: 1, sha256: "a".repeat(64) },
      performance.now() + 1000,
    ),
    /actual owned/,
  );
  await assert.rejects(
    requireReceivedPublicationResult({
      kind: "attested-owned-immutable-release-result",
      evidence_scope: "github.com",
    }),
    /actual authenticated/,
  );
});

void test("receiver refuses changed controller expectations and provider artifact identity before any download", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-result-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = {
    controller_revision: "a".repeat(40),
    source_tree: "b".repeat(40),
    controller_ref: "refs/tags/portcove-production-controller-fixture",
    run_id: "123",
    run_attempt: 1,
    artifact: { id: 1, sha256: "c".repeat(64) },
    bundle: { id: 2, sha256: "d".repeat(64) },
    report_sha256: "e".repeat(64),
  };
  let downloads = 0;
  const download = () => {
    downloads++;
    throw new Error("must not download");
  };
  await assert.rejects(
    receivePublicationResultArtifact(
      directory,
      { ...expected, run_attempt: 2 },
      {},
      performance.now() + 10000,
      { download },
    ),
    /identity/,
  );
  assert.deepEqual(await readdir(directory), []);
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: expected.controller_revision,
    path: ".github/workflows/application-update-production.yml",
    event: "workflow_dispatch",
    status: "in_progress",
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const requests: string[] = [];
  await assert.rejects(
    receivePublicationResultArtifact(directory, expected, {}, performance.now() + 10000, {
      download,
      api: {
        request(method, endpoint) {
          assert.equal(method, "GET");
          requests.push(endpoint);
          if (endpoint.includes("git/commits/"))
            return {
              status: 200,
              headers: new Map<string, string>(),
              body: { sha: expected.controller_revision, tree: { sha: expected.source_tree } },
            };
          if (endpoint.includes("actions/runs/"))
            return { status: 200, headers: new Map<string, string>(), body: run };
          return {
            status: 200,
            headers: new Map<string, string>(),
            body: {
              id: 1,
              name: "wrong-publisher-artifact",
              digest: `sha256:${expected.artifact.sha256}`,
              expired: false,
            },
          };
        },
      },
    }),
    /acquisition refused/,
  );
  assert.equal(downloads, 0);
  assert.equal(requests.length, 4);
  const [retained] = await readdir(directory);
  const refusal: unknown = JSON.parse(
    await readFile(path.join(directory, retained!, "refusal.json"), "utf8"),
  );
  assert.ok(isRecord(refusal));
  assert.equal(refusal.phase, "provider-before");
  assert.equal(refusal.automatic_retry, false);
  const before = await readdir(directory);
  await assert.rejects(
    receivePublicationResultArtifact(directory, expected, {}, performance.now() - 1, { download }),
    /deadline/,
  );
  assert.deepEqual(await readdir(directory), before);
});
