import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import { coordinatorStateRef } from "./release-coordinator-state.mts";
import {
  publishCoordinatorCheckpoint,
  CoordinatorRemoteError,
} from "./release-coordinator-remote.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import {
  inspectCoordinatorCheckpointEvidence,
  readCoordinatorCheckpointEvidence,
} from "./release-coordinator-checkpoint-evidence.mts";
import { performance } from "node:perf_hooks";

import { remoteFixture, checkpointEvidence } from "./fixtures/coordinator-state-fixtures.mts";

void test("checkpoint proof travels in the existing CAS and reads back exact bytes without asserting signature authority", async (t) => {
  const f = await remoteFixture(t);
  const evidence = checkpointEvidence(f);
  const checked = inspectCoordinatorCheckpointEvidence(f.checkpoint, f.config, evidence);
  const result = await publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
    api: f.api,
    evidence,
  });
  assert.equal(result.updates.length, 4);
  assert.deepEqual(f.counts(), { posts: 7, mutations: 1, snapshots: 2 });
  assert.equal(f.refs.get(checked.update.name), checked.update.afterOid);
  const read = readCoordinatorCheckpointEvidence(
    f.checkpoint,
    f.config,
    f.api,
    performance.now() + 60000,
  );
  assert.deepEqual(read.subject, evidence.subject);
  assert.deepEqual(read.bundle, evidence.bundle);
  assert.equal(read.authority, "none");
  assert.equal(read.signature_verification, "not-performed");
  assert.equal(read.requests, 6);
  const again = await publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
    api: f.api,
    evidence,
  });
  assert.equal(again.changed, false);
  assert.equal(f.counts().posts, 7);
  await assert.rejects(
    publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
      api: f.api,
      evidence: checkpointEvidence(f, "a different signing attempt"),
    }),
    /preimage conflicts/,
  );
  assert.equal(f.counts().mutations, 1);
  assert.equal(f.counts().posts, 7);
});

void test("checkpoint proof readback refuses changed refs, malformed objects and an exhausted original deadline", async (t) => {
  const f = await remoteFixture(t);
  const evidence = checkpointEvidence(f);
  await publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
    api: f.api,
    evidence,
  });
  for (const fault of ["tree", "blob-size", "blob-bytes", "ref", "late"]) {
    let queries = 0,
      reads = 0;
    let clock = performance.now();
    const now = t.mock.method(performance, "now", () => clock);
    const api: CoordinatorRemoteApi = {
      request(method, endpoint, body) {
        assert.equal(method, "GET");
        reads++;
        const response = f.api.request(method, endpoint, body);
        const value: unknown = structuredClone(response.body);
        assert.ok(isRecord(value));
        if (fault === "tree" && endpoint.includes("/trees/")) value.truncated = true;
        if (fault === "blob-size" && endpoint.includes("/blobs/")) value.size = 65537;
        if (fault === "blob-bytes" && endpoint.includes("/blobs/")) value.content = "YQ==";
        return { ...response, body: value };
      },
      graphql(query, variables) {
        queries++;
        const response = structuredClone(f.api.graphql(query, variables));
        if (queries === 2) {
          if (fault === "late") clock += 60001;
          if (fault === "ref") {
            assert.ok(isRecord(response.data) && isRecord(response.data.repository));
            const ref = response.data.repository.ref;
            assert.ok(isRecord(ref) && isRecord(ref.target));
            ref.target.oid = "f".repeat(40);
          }
        }
        return response;
      },
    };
    try {
      assert.throws(
        () => readCoordinatorCheckpointEvidence(f.checkpoint, f.config, api, clock + 60000),
        /checkpoint evidence/,
      );
      assert.ok(reads + queries <= 6);
      assert.equal(f.counts().posts, 7);
      assert.equal(f.counts().mutations, 1);
    } finally {
      now.mock.restore();
    }
  }
  const before = f.requests();
  const fixedTime = performance.now();
  // Keep invalid bounds outside the envelope while the guard reads the clock.
  const clockMock = t.mock.method(performance, "now", () => fixedTime);
  try {
    for (const deadline of [fixedTime - 1, Infinity, fixedTime + 120001])
      assert.throws(
        () => readCoordinatorCheckpointEvidence(f.checkpoint, f.config, f.api, deadline),
        /original bounded read deadline/,
      );
    assert.equal(f.requests(), before);
  } finally {
    clockMock.mock.restore();
  }
});

for (const changed of [
  "checkpoint",
  "state_sha256",
  "updates",
  "proof_ref",
  "producer",
  "extra",
  "oversized",
  "bundle",
]) {
  void test(`checkpoint proof refuses ${changed} before any provider operation`, async (t) => {
    const f = await remoteFixture(t);
    const evidence = checkpointEvidence(f);
    const subject = JSON.parse(evidence.subject.toString()) as Record<string, unknown>;
    if (changed === "extra") subject.extra = true;
    else if (changed === "updates") subject.updates = [];
    else if (changed === "producer") subject.producer = { run_id: "333" };
    else if (changed !== "oversized" && changed !== "bundle") subject[changed] = "f".repeat(64);
    evidence.subject = Buffer.from(JSON.stringify(subject));
    if (changed === "oversized") evidence.bundle = Buffer.alloc(65537, 32);
    if (changed === "bundle") evidence.bundle = Buffer.from("{}");
    await assert.rejects(
      publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, { api: f.api, evidence }),
      /checkpoint evidence/,
    );
    assert.equal(f.requests(), 0);
  });
}

for (const fault of ["evidence-commits", "partial-proof", "after", "readback"]) {
  void test(`checkpoint proof retains ${fault} effects without another CAS or signing attempt`, async (t) => {
    const f = await remoteFixture(t);
    const evidence = checkpointEvidence(f);
    const checked = inspectCoordinatorCheckpointEvidence(f.checkpoint, f.config, evidence);
    if (fault === "evidence-commits") f.faults.object = fault;
    else if (fault === "readback") f.faults.snapshot = "after";
    else f.faults.mutation = fault;
    const run = () =>
      publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, { api: f.api, evidence });
    if (fault === "after") {
      const result = await run();
      assert.equal(result.recovered, true);
      assert.equal(f.refs.get(checked.update.name), checked.update.afterOid);
    } else {
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError);
        assert.ok(isRecord(error.evidence));
        assert.ok(Array.isArray(error.evidence.updates));
        assert.deepEqual(error.evidence.updates.at(-1), checked.update);
        return true;
      });
    }
    assert.equal(f.counts().posts, 7);
    assert.equal(f.counts().mutations, fault === "evidence-commits" ? 0 : 1);
    assert.equal(f.objects.has(checked.update.afterOid), true);
    if (fault === "partial-proof") {
      assert.equal(f.refs.get(f.stateRef), f.saved.checkpoint);
      assert.equal(f.refs.has(checked.update.name), false);
    }
  });
}

for (const mode of ["before", "after", "concurrent", "readback"]) {
  void test(`remote checkpoint preserves ambiguous CAS outcome ${mode} without automatic retry`, async (t) => {
    const f = await remoteFixture(t);
    if (mode === "readback") f.faults.snapshot = "after";
    else f.faults.mutation = mode;
    if (mode === "after") {
      const result = await publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
        api: f.api,
      });
      assert.equal(result.recovered, true);
      assert.equal(f.refs.get(f.stateRef), f.saved.checkpoint);
    } else {
      await assert.rejects(
        publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, { api: f.api }),
        (error: unknown) => {
          assert.ok(error instanceof CoordinatorRemoteError);
          assert.ok(isRecord(error.evidence));
          if (mode === "before") assert.equal(error.evidence.observation, "observed-before");
          if (mode === "concurrent")
            assert.equal(error.evidence.observation, "unknown-or-concurrent");
          if (mode === "readback") assert.ok(error.evidence.readbackError);
          return true;
        },
      );
    }
    assert.equal(f.counts().mutations, 1);
    assert.equal(f.counts().snapshots, 2);
    assert.equal(f.git("rev-parse", coordinatorStateRef), f.saved.checkpoint);
  });
}

for (const mode of [
  "object-missing",
  "commit-parent",
  "mixed",
  "incomplete",
  "repository",
  "tag",
  "zero",
  "blobs",
  "trees",
  "commits",
]) {
  void test(`remote checkpoint refuses ${mode} before CAS`, async (t) => {
    const f = await remoteFixture(t);
    if (mode === "object-missing") f.commits.clear();
    else if (mode === "commit-parent")
      f.commits.get(f.prepared.prepared_commit)!.parents = [{ sha: "f".repeat(40) }];
    else if (mode === "mixed") f.refs.set(f.stateRef, f.saved.checkpoint);
    else if (["incomplete", "repository", "tag", "zero"].includes(mode)) f.faults.snapshot = mode;
    else f.faults.object = mode;
    await assert.rejects(
      publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, { api: f.api }),
    );
    assert.equal(f.counts().mutations, 0);
    if (!["blobs", "trees", "commits"].includes(mode)) assert.equal(f.counts().posts, 0);
    assert.equal(f.git("rev-parse", coordinatorStateRef), f.saved.checkpoint);
  });
}
