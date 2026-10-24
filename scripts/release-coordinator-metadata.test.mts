import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import {
  recordCapacityReadback,
  runBoundedMetadataRenewalOperation,
  recordPublishedMetadata,
} from "./release-capacity-operation.mts";
import { metadataFixture } from "./fixtures/release-metadata-fixture.mts";
import { isDeepStrictEqual } from "node:util";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
  coordinatorStateRef,
  exportCoordinatorCheckpoint,
  importCoordinatorCheckpoint,
  readRetainedCapacityOperation,
} from "./release-coordinator-state.mts";
import {
  hydrateRetainedCoordinatorOperation,
  hydrateRetainedCoordinatorCheckpoint,
} from "./release-coordinator-recovery.mts";
import {
  publishCoordinatorCheckpoint,
  CoordinatorRemoteError,
} from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { inspectCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-evidence.mts";
import { performance } from "node:perf_hooks";
import { checkpointProofFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import { authenticateCoordinatorCheckpointEvidence } from "./release-coordinator-checkpoint-authentication.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import {
  remoteFixture,
  fixture,
  checkpointEvidence,
  remoteCapacityFixture,
} from "./fixtures/coordinator-state-fixtures.mts";

void test(
  "metadata renewal remains available during a failed candidate without consuming its recovery counters",
  { timeout: 120000 },
  async (t) => {
    const f = await remoteCapacityFixture(t);
    const { descriptor, published } = metadataFixture();
    const input = structuredClone(
      (await recoverReleaseOpportunity(f.bare, f.migrated.checkpoint)).input,
    );
    assert.ok(isRecord(input.controller) && isRecord(input.controller.capacity_attempt));
    assert.ok(isRecord(input.active_candidate));
    input.controller.capacity_attempt.schema_version = 2;
    input.active_candidate.phase = "failed";
    input.active_candidate.failure_kind = "authority";
    const failed = await checkpointReleaseOpportunity(f.bare, f.migrated.checkpoint, input);
    assert.equal(failed.plan.action, "pause-exception");
    await publishCoordinatorCheckpoint(f.bare, failed.checkpoint, f.config, { api: f.api });
    const seeded = await recordPublishedMetadata(f.bare, failed.checkpoint, published, f.options);
    let effects = 0;
    const operation = await runBoundedMetadataRenewalOperation(
      f.bare,
      seeded.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:timestamp" },
      async () => f.capacity.boundary,
      async (record, pending) => {
        effects++;
        assert.equal(f.refs.get(f.stateRef), pending.checkpoint);
        await record("qualification:timestamp-during-native-hold", "a".repeat(64));
      },
      { ...f.options, maximumReceipts: 1 },
    );
    assert.equal(effects, 1);
    const saved = await recoverReleaseOpportunity(f.bare, operation.checkpoint);
    assert.deepEqual(saved.input.active_candidate, input.active_candidate);
    assert.deepEqual(saved.input.review_request, input.review_request);
    assert.deepEqual(saved.input.review_disposition, input.review_disposition);
    assert.equal(saved.plan.action, "pause");
    assert.match(saved.plan.reason, /pending, refused or ambiguous operation/u);
    assert.equal(operation.operation.outcome, "pending");
    const settled = await recordCapacityReadback(
      f.bare,
      operation.checkpoint,
      "effect-completed",
      "b".repeat(64),
      f.options,
    );
    const resolved = await recoverReleaseOpportunity(f.bare, settled.checkpoint);
    assert.deepEqual(resolved.input.active_candidate, input.active_candidate);
    assert.equal(resolved.plan.action, "pause-exception");
  },
);

void test(
  "metadata renewal uses durable remote journal without allocating or changing an active candidate",
  { timeout: 120000 },
  async (t) => {
    const f = await remoteCapacityFixture(t);
    const { descriptor, published } = metadataFixture();
    const original = (await recoverReleaseOpportunity(f.bare, f.migrated.checkpoint)).input;
    const input = structuredClone(original);
    assert.ok(isRecord(input.controller) && isRecord(input.controller.capacity_attempt));
    input.controller.capacity_attempt.schema_version = 2;
    const modern = await checkpointReleaseOpportunity(f.bare, f.migrated.checkpoint, input);
    await publishCoordinatorCheckpoint(f.bare, modern.checkpoint, f.config, { api: f.api });
    let effects = 0;
    await assert.rejects(
      runBoundedMetadataRenewalOperation(
        f.bare,
        modern.checkpoint,
        descriptor,
        { kind: "upload", destination: "application-tuf:timestamp" },
        async () => f.capacity.boundary,
        async () => {
          effects++;
        },
        f.options,
      ),
      /seed absent/,
    );
    assert.equal(effects, 0);
    const seeded = await recordPublishedMetadata(f.bare, modern.checkpoint, published, f.options);
    const first = await runBoundedMetadataRenewalOperation(
      f.bare,
      seeded.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:timestamp" },
      async () => f.capacity.boundary,
      async (record, pending) => {
        effects++;
        assert.equal(f.refs.get(f.stateRef), pending.checkpoint);
        assert.ok(isRecord(pending.operation.metadata_renewal));
        assert.equal(
          pending.operation.metadata_renewal.prior_repository_sha256,
          published.repository_sha256,
        );
        assert.equal(pending.operation.candidate, undefined);
        await record("qualification:timestamp-envelope", "a".repeat(64));
      },
      { ...f.options, maximumReceipts: 1 },
    );
    assert.equal(first.operation.outcome, "pending");
    await assert.rejects(
      recordCapacityReadback(f.bare, first.checkpoint, "effect-completed", "b".repeat(64), {
        ...f.options,
        completedEffect: {
          remote_identity: "qualification:substituted",
          evidence_sha256: "a".repeat(64),
        },
      }),
      /cannot replace/,
    );
    const recovered = await recordCapacityReadback(
      f.bare,
      first.checkpoint,
      "effect-completed",
      "b".repeat(64),
      {
        ...f.options,
        completedEffect: {
          remote_identity: "qualification:timestamp-envelope",
          evidence_sha256: "a".repeat(64),
        },
      },
    );
    const second = await runBoundedMetadataRenewalOperation(
      f.bare,
      recovered.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:Pages" },
      async () => f.capacity.boundary,
      async (record) => record("qualification:Pages-generation", "c".repeat(64)),
      { ...f.options, maximumReceipts: 1 },
    );
    const resolved = await recordCapacityReadback(
      f.bare,
      second.checkpoint,
      "effect-completed",
      "d".repeat(64),
      f.options,
    );
    const saved = await recoverReleaseOpportunity(f.bare, resolved.checkpoint);
    assert.deepEqual(saved.input.active_candidate, original.active_candidate);
    assert.equal(saved.input.now, original.now);
    assert.ok(
      isRecord(saved.input.controller) && isRecord(saved.input.controller.capacity_attempt),
    );
    const groups = saved.input.controller.capacity_attempt.prior_operations;
    assert.ok(
      Array.isArray(groups) &&
        isRecord(groups[0]) &&
        Array.isArray(groups[0].attempts) &&
        isRecord(groups[0].attempts[0]),
    );
    const proof = groups[0].attempts[0];
    const raw = readRetainedCapacityOperation(f.bare, {
      checkpoint: String(proof.checkpoint),
      id: String(proof.id),
      operation_sha256: String(proof.operation_sha256),
    });
    assert.equal(raw.id, first.operation.id);
    // A newly recovered sparse journal does not contain arbitrary older
    // compact checkpoints. Hydrate exactly the original three inert objects
    // through the supplied owned read-only transport, without fetching parents.
    const sparse = await mkdtemp(path.join(os.tmpdir(), "retained-operation-sparse-"));
    t.after(() => rm(sparse, { recursive: true, force: true }));
    execFileSync("git", ["init", "--bare", "-q", sparse], { windowsHide: true });
    const retainedProof = {
      checkpoint: String(proof.checkpoint),
      id: String(proof.id),
      operation_sha256: String(proof.operation_sha256),
    };
    assert.throws(() => readRetainedCapacityOperation(sparse, retainedProof));
    const commitBytes = execFileSync("git", [
      "-C",
      f.bare,
      "cat-file",
      "commit",
      retainedProof.checkpoint,
    ]);
    const commitText = commitBytes.toString("utf8"),
      boundary = commitText.indexOf("\n\n"),
      header = commitText.slice(0, boundary),
      treeId = /^tree ([a-f0-9]{40})$/mu.exec(header)![1]!;
    const treeBytes = execFileSync("git", ["-C", f.bare, "cat-file", "tree", treeId]),
      blobId = treeBytes.subarray(-20).toString("hex");
    const blobBytes = execFileSync("git", ["-C", f.bare, "cat-file", "blob", blobId]);
    const actor = {
      name: "Portcove release coordinator",
      email: "coordinator@portcove.invalid",
      date: "2000-01-01T00:00:00Z",
    };
    const bodies = new Map<string, unknown>([
      [
        `repos/boburning/portcove/git/commits/${retainedProof.checkpoint}`,
        {
          sha: retainedProof.checkpoint,
          tree: { sha: treeId },
          parents: [...header.matchAll(/^parent ([a-f0-9]{40})$/gmu)].map((match) => ({
            sha: match[1],
          })),
          author: actor,
          committer: actor,
          message: commitText.slice(boundary + 2),
        },
      ],
      [
        `repos/boburning/portcove/git/trees/${treeId}`,
        {
          sha: treeId,
          truncated: false,
          tree: [{ path: "state.json", mode: "100644", type: "blob", sha: blobId }],
        },
      ],
      [
        `repos/boburning/portcove/git/blobs/${blobId}`,
        {
          sha: blobId,
          encoding: "base64",
          size: blobBytes.length,
          content: blobBytes.toString("base64"),
        },
      ],
    ]);
    const reads: string[] = [];
    const api = {
      request(method: string, endpoint: string, body?: unknown) {
        assert.equal(method, "GET");
        assert.equal(body, undefined);
        assert.ok(bodies.has(endpoint));
        reads.push(endpoint);
        return {
          status: 200,
          body: structuredClone(bodies.get(endpoint)),
          headers: new Map<string, string>(),
        };
      },
    };
    const hydrated = await hydrateRetainedCoordinatorOperation(sparse, retainedProof, { api });
    assert.deepEqual(hydrated, raw);
    assert.equal(reads.length, 3);
    const parentId = /^parent ([a-f0-9]{40})$/mu.exec(header)![1]!;
    assert.throws(() =>
      execFileSync("git", ["-C", sparse, "cat-file", "-e", parentId], {
        stdio: "pipe",
        windowsHide: true,
      }),
    );
    assert.equal(
      execFileSync("git", ["-C", sparse, "for-each-ref"], { encoding: "utf8", windowsHide: true }),
      "",
    );
    await assert.rejects(
      hydrateRetainedCoordinatorOperation(
        sparse,
        { ...retainedProof, operation_sha256: "0".repeat(64) },
        { api },
      ),
      /exact raw capacity operation/,
    );
    assert.equal(reads.length, 6);
    const historical = await hydrateRetainedCoordinatorCheckpoint(
      sparse,
      retainedProof.checkpoint,
      { api },
    );
    assert.equal(historical.checkpoint, retainedProof.checkpoint);
    assert.equal(historical.authority, "none");
    const originalHistorical: unknown = JSON.parse(blobBytes.toString("utf8"));
    assert.ok(isRecord(originalHistorical));
    assert.deepEqual(historical.input, originalHistorical.input);
    assert.equal(reads.length, 9);
    assert.equal(
      execFileSync("git", ["-C", sparse, "for-each-ref"], { encoding: "utf8", windowsHide: true }),
      "",
    );
    await assert.rejects(
      hydrateRetainedCoordinatorCheckpoint(sparse, "main", { api }),
      /exact Git/,
    );
    assert.equal(reads.length, 9);
    assert.throws(() =>
      readRetainedCapacityOperation(f.bare, {
        checkpoint: String(proof.checkpoint),
        id: String(proof.id),
        operation_sha256: "0".repeat(64),
      }),
    );
    await assert.rejects(
      runBoundedMetadataRenewalOperation(
        f.bare,
        resolved.checkpoint,
        { ...descriptor, generated_at: descriptor.generated_at },
        { kind: "upload", destination: "application-tuf:timestamp" },
        async () => f.capacity.boundary,
        async () => assert.fail("completed effect cannot repeat"),
        f.options,
      ),
      /repeat|recovery/,
    );
    const advanced = {
      ...published,
      repository_sha256: "e".repeat(64),
      snapshot_sha256: "f".repeat(64),
      timestamp_sha256: "0".repeat(64),
      versions: descriptor.next_versions,
      expires: descriptor.next_expires,
      operation_id: second.operation.id,
      publication: {
        remote_identity: "qualification:Pages-generation",
        evidence_sha256: "c".repeat(64),
        site_generation_sha256: "9".repeat(64),
      },
    };
    const final = await recordPublishedMetadata(f.bare, resolved.checkpoint, advanced, f.options);
    const finalInput = (await recoverReleaseOpportunity(f.bare, final.checkpoint)).input;
    assert.ok(isDeepStrictEqual(finalInput.active_candidate, original.active_candidate));
    assert.deepEqual(finalInput.published_metadata, advanced);
    assert.ok(isRecord(finalInput.controller) && isRecord(finalInput.controller.capacity_attempt));
    assert.deepEqual(finalInput.controller.capacity_attempt.prior_operations, []);
    assert.equal(f.refs.get(f.stateRef), final.checkpoint);
  },
);

void test(
  "observed single-effect readback restores a lost receipt and permits only its metadata handoff",
  { timeout: 120000 },
  async (t) => {
    const f = await remoteCapacityFixture(t);
    const { descriptor, published } = metadataFixture();
    const input = structuredClone(
      (await recoverReleaseOpportunity(f.bare, f.migrated.checkpoint)).input,
    );
    assert.ok(isRecord(input.controller) && isRecord(input.controller.capacity_attempt));
    input.controller.capacity_attempt.schema_version = 2;
    const modern = await checkpointReleaseOpportunity(f.bare, f.migrated.checkpoint, input);
    await publishCoordinatorCheckpoint(f.bare, modern.checkpoint, f.config, { api: f.api });
    const seed = await recordPublishedMetadata(f.bare, modern.checkpoint, published, f.options);
    let checkpoint = "",
      effects = 0;
    const request = { kind: "upload" as const, destination: "application-tuf:lost-Pages-response" };
    await assert.rejects(
      runBoundedMetadataRenewalOperation(
        f.bare,
        seed.checkpoint,
        descriptor,
        request,
        async () => f.capacity.boundary,
        async () => {
          effects++;
          throw new Error("provider response lost after effect");
        },
        { ...f.options, maximumReceipts: 1 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError && isRecord(error.evidence));
        checkpoint = String(error.evidence.checkpoint);
        return true;
      },
    );
    const lost = await recoverReleaseOpportunity(f.bare, checkpoint);
    assert.ok(isRecord(lost.input.controller) && isRecord(lost.input.controller.capacity_attempt));
    const original = lost.input.controller.capacity_attempt.operation;
    assert.ok(isRecord(original));
    assert.deepEqual(original.completed_effects, []);
    const receipt = {
      remote_identity: "qualification:observed-public-Pages-generation",
      evidence_sha256: "c".repeat(64),
    };
    for (const resolution of ["effect-not-applied", "partial-effects-retained"] as const)
      await assert.rejects(
        recordCapacityReadback(f.bare, checkpoint, resolution, "d".repeat(64), {
          ...f.options,
          completedEffect: receipt,
        }),
        /single-effect completion/,
      );
    await assert.rejects(
      recordCapacityReadback(f.bare, checkpoint, "effect-completed", "d".repeat(64), {
        ...f.options,
        completedEffect: { ...receipt, evidence_sha256: "invalid" },
      }),
    );
    assert.equal(
      execFileSync("git", ["-C", f.bare, "rev-parse", coordinatorStateRef], {
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      checkpoint,
    );
    const pendingRecovery = recordCapacityReadback(
      f.bare,
      checkpoint,
      "effect-completed",
      "d".repeat(64),
      {
        ...f.options,
        completedEffect: receipt,
      },
    );
    receipt.remote_identity = "mutated-after-call";
    const resolved = await pendingRecovery;
    const saved = await recoverReleaseOpportunity(f.bare, resolved.checkpoint);
    assert.ok(
      isRecord(saved.input.controller) && isRecord(saved.input.controller.capacity_attempt),
    );
    const operation = saved.input.controller.capacity_attempt.operation;
    assert.ok(isRecord(operation));
    assert.equal(operation.id, original.id);
    assert.equal(operation.executor_nonce, original.executor_nonce);
    assert.deepEqual(operation.failure_evidence, original.failure_evidence);
    assert.deepEqual(operation.completed_effects, [
      {
        remote_identity: "qualification:observed-public-Pages-generation",
        evidence_sha256: "c".repeat(64),
      },
    ]);
    assert.equal(f.refs.get(f.stateRef), resolved.checkpoint);
    await assert.rejects(
      runBoundedMetadataRenewalOperation(
        f.bare,
        resolved.checkpoint,
        descriptor,
        request,
        async () => f.capacity.boundary,
        async () => {
          effects++;
        },
        f.options,
      ),
      /repeat|recovery/,
    );
    assert.equal(effects, 1);
    const successor = {
      ...published,
      repository_sha256: "e".repeat(64),
      snapshot_sha256: "f".repeat(64),
      timestamp_sha256: "0".repeat(64),
      versions: descriptor.next_versions,
      expires: descriptor.next_expires,
      operation_id: original.id,
      publication: {
        remote_identity: "qualification:observed-public-Pages-generation",
        evidence_sha256: "c".repeat(64),
        site_generation_sha256: "9".repeat(64),
      },
    };
    const advanced = await recordPublishedMetadata(
      f.bare,
      resolved.checkpoint,
      successor,
      f.options,
    );
    assert.deepEqual(
      (await recoverReleaseOpportunity(f.bare, advanced.checkpoint)).input.published_metadata,
      successor,
    );
  },
);

void test(
  "metadata-only renewal needs no candidate and its compact state survives sparse import",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const before = (await recoverReleaseOpportunity(f.repository, f.initial.checkpoint)).input;
    const capacity = { ...capacityFixture(), schema_version: 2 };
    const input = {
      ...before,
      schema_version: 2,
      controller: {
        workflow: ".github/workflows/release-coordinator.yml",
        revision: "3".repeat(40),
        publication_paused: false,
        capacity_attempt: capacity,
      },
    };
    const migrated = await checkpointReleaseOpportunity(f.repository, f.initial.checkpoint, input);
    const { descriptor, published } = metadataFixture();
    const seeded = await recordPublishedMetadata(f.repository, migrated.checkpoint, published);
    const first = await runBoundedMetadataRenewalOperation(
      f.repository,
      seeded.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:releases" },
      async () => capacity.boundary,
      async (record) => record("qualification:release-role", "a".repeat(64)),
      { maximumReceipts: 1 },
    );
    const second = await runBoundedMetadataRenewalOperation(
      f.repository,
      first.checkpoint,
      descriptor,
      { kind: "upload", destination: "application-tuf:preview" },
      async () => capacity.boundary,
      async (record) => record("qualification:preview-role", "b".repeat(64)),
      { maximumReceipts: 1 },
    );
    const transportRepository = path.join(f.repository, "metadata-transport.git");
    execFileSync("git", ["clone", "--mirror", "--quiet", f.repository, transportRepository], {
      windowsHide: true,
    });
    const exported = await exportCoordinatorCheckpoint(transportRepository, second.checkpoint);
    const sparse = path.join(f.repository, "metadata-sparse.git");
    execFileSync("git", ["init", "--bare", "--quiet", sparse], { windowsHide: true });
    const objects: { kind: "commit" | "tree" | "blob"; oid: string; bytes: Buffer }[] = [];
    for (const checkpoint of [exported.checkpoint, exported.previous]) {
      assert.ok(checkpoint);
      for (const [kind, suffix] of [
        ["commit", ""],
        ["tree", "^{tree}"],
        ["blob", ":state.json"],
      ] as const) {
        const oid = execFileSync(
          "git",
          ["-C", transportRepository, "rev-parse", checkpoint + suffix],
          { encoding: "utf8", windowsHide: true },
        ).trim();
        if (!objects.some((object) => object.oid === oid))
          objects.push({
            kind,
            oid,
            bytes: execFileSync("git", ["-C", transportRepository, "cat-file", kind, oid], {
              windowsHide: true,
            }),
          });
      }
    }
    await importCoordinatorCheckpoint(sparse, exported.checkpoint, objects);
    const restored = await recoverReleaseOpportunity(sparse, exported.checkpoint);
    assert.equal(restored.input.active_candidate, null);
    assert.deepEqual(restored.input.published_metadata, published);
    assert.equal(restored.input.now, before.now);
    assert.ok(
      isRecord(restored.input.controller) && isRecord(restored.input.controller.capacity_attempt),
    );
    const groups = restored.input.controller.capacity_attempt.prior_operations;
    assert.ok(Array.isArray(groups) && groups.length === 1);
    assert.throws(() =>
      execFileSync("git", ["-C", sparse, "cat-file", "-e", seeded.checkpoint], {
        windowsHide: true,
        stdio: "ignore",
      }),
    );
  },
);

for (const expires of ["read", "first-object", "before-cas", "mutated-options"]) {
  void test(`authenticated checkpoint expiry after ${expires} stops the next mutation and retains completed effects`, async (t) => {
    const f = await remoteFixture(t),
      proof = checkpointProofFixture(f.checkpoint, f.config);
    const directory = await mkdtemp(path.join(os.tmpdir(), "checkpoint-publisher-auth-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "inert-metadata-token";
    t.after(() => {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    let clock = performance.now();
    t.mock.method(performance, "now", () => clock);
    t.mock.method(childProcess, "spawnSync", (_command: string, args: readonly string[]) => {
      if (args[0] === "attestation")
        return {
          status: 0,
          stdout: JSON.stringify([{ verificationResult: proof.verification }]),
          stderr: "",
        };
      const response = proof.api.request("GET", args[2]!);
      return {
        status: 0,
        stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(response.body)}`,
        stderr: "",
      };
    });
    syncBuiltinESMExports();
    await withReadOnlyReleaseChildren(directory, async () => {
      const receipt = await authenticateCoordinatorCheckpointEvidence(
        directory,
        f.checkpoint,
        f.config,
        proof.evidence,
        proof.expected,
        clock + 60000,
      );
      let posts = 0,
        expired = false;
      const api: CoordinatorRemoteApi = {
        request(method, endpoint, body) {
          const response = f.api.request(method, endpoint, body);
          if (method === "POST") posts++;
          if (
            (expires === "read" && method === "GET" && endpoint.includes("/git/commits/")) ||
            (expires === "first-object" && posts === 1) ||
            (expires === "before-cas" && posts === 7)
          ) {
            if (!expired) {
              clock += 60001;
              expired = true;
            }
          }
          return response;
        },
        graphql: (...args) => f.api.graphql(...args),
      };
      if (expires === "mutated-options") {
        const mutable: Parameters<typeof publishCoordinatorCheckpoint>[3] = {
          api,
          authenticatedEvidence: receipt,
        };
        const pending = publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, mutable);
        delete mutable.authenticatedEvidence;
        mutable.evidence = checkpointEvidence(f, "replacement-inert-bundle");
        const result = await pending;
        const expectedProof = inspectCoordinatorCheckpointEvidence(
          f.checkpoint,
          f.config,
          proof.evidence,
        );
        assert.deepEqual(result.updates.at(-1), expectedProof.update);
        assert.equal(f.refs.get(expectedProof.update.name), expectedProof.update.afterOid);
        return;
      }
      await assert.rejects(
        publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
          api,
          authenticatedEvidence: receipt,
        }),
        /authenticated checkpoint/,
      );
      assert.equal(f.counts().mutations, 0);
      assert.equal(f.counts().posts, expires === "read" ? 0 : expires === "first-object" ? 1 : 7);
      assert.equal(f.refs.get(f.stateRef), f.initial.checkpoint);
    });
  });
}
