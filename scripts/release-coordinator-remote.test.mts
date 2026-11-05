import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import {
  checkpointReleaseOpportunity,
  coordinatorStateRef,
  exportCoordinatorCheckpoint,
} from "./release-coordinator-state.mts";
import { publishCoordinatorCheckpoint } from "./release-coordinator-remote.mts";
import { createCoordinatorJournalApi } from "./release-coordinator-journal-api.mts";

import { gitObject, remoteFixture } from "./fixtures/coordinator-state-fixtures.mts";

void test("remote checkpoint exports exact Git objects, atomically persists receipts, and repeats without writes", async (t) => {
  const f = await remoteFixture(t);
  const prior = process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN;
  const token = "inert-coordinator-journal";
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = token;
  t.after(() => {
    if (prior === undefined) delete process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN;
    else process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = prior;
  });
  let loseAcknowledgment = true;
  let failReadback = false;
  let mutationObserved = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.search, "");
    assert.equal(new Headers(init?.headers).get("authorization"), `token ${token}`);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.pathname === "/graphql") {
      assert.equal(init?.method, "POST");
      assert.ok(isRecord(body) && typeof body.query === "string" && isRecord(body.variables));
      if (failReadback && mutationObserved && body.query.startsWith("query"))
        return Response.json({ message: "Authoritative readback unavailable" }, { status: 503 });
      const response = f.api.graphql(body.query, body.variables);
      if (body.query.startsWith("mutation")) mutationObserved = true;
      if (loseAcknowledgment && body.query.startsWith("mutation")) {
        loseAcknowledgment = false;
        return Response.json({ message: "Acknowledgment unavailable" }, { status: 503 });
      }
      return Response.json(response);
    }
    assert.ok(init?.method);
    const result = f.api.request(init.method, url.pathname.slice(1), body);
    assert.ok(typeof result.status === "number");
    return Response.json(result.body, { status: result.status });
  });
  const api = createCoordinatorJournalApi(f.bare);
  await assert.rejects(
    exportCoordinatorCheckpoint(f.repository, f.saved.checkpoint),
    /bare coordinator/u,
  );
  assert.equal(f.checkpoint.commit.oid, f.saved.checkpoint);
  assert.equal(gitObject("blob", Buffer.from(f.checkpoint.blob.contents)), f.checkpoint.blob.oid);
  const result = await publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
    api,
  });
  assert.equal(result.changed, true);
  assert.equal(result.recovered, true);
  assert.equal(result.updates.length, 3);
  assert.deepEqual(f.counts(), { posts: 3, mutations: 1, snapshots: 2 });
  assert.equal(f.refs.get(f.stateRef), f.saved.checkpoint);
  const again = await publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config, {
    api,
  });
  assert.equal(again.changed, false);
  assert.deepEqual(f.counts(), { posts: 3, mutations: 1, snapshots: 3 });
  assert.equal(f.git("rev-parse", coordinatorStateRef), f.saved.checkpoint);
  // Existing receipts are compared even though their values do not change.
  f.input.active_candidate!.phase = "qualifying";
  const advanced = await checkpointReleaseOpportunity(f.bare, f.saved.checkpoint, f.input);
  mutationObserved = false;
  failReadback = true;
  await assert.rejects(
    publishCoordinatorCheckpoint(f.bare, advanced.checkpoint, f.config, { api }),
    /outcome is unknown; do not retry automatically/u,
  );
  assert.equal(f.counts().mutations, 2);
  assert.equal(f.refs.get(f.stateRef), advanced.checkpoint);
  failReadback = false;
  const next = await publishCoordinatorCheckpoint(f.bare, advanced.checkpoint, f.config, {
    api,
  });
  assert.equal(next.changed, false);
  assert.equal(f.counts().mutations, 2);
  assert.equal(next.updates.length, 3);
  assert.ok(next.updates.slice(1).every((ref) => ref.beforeOid === ref.afterOid));
});

void test("remote checkpoint requires explicit configuration, transport, bare ownership and initialized history before provider calls", async (t) => {
  const f = await remoteFixture(t);
  await assert.rejects(
    publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, f.config),
    /unconfigured/u,
  );
  for (const config of [
    null,
    { ...f.config, namespace: "main" },
    { ...f.config, repository: "other/repo" },
  ])
    await assert.rejects(
      publishCoordinatorCheckpoint(f.bare, f.saved.checkpoint, config, { api: f.api }),
      /configuration/u,
    );
  await assert.rejects(
    publishCoordinatorCheckpoint(f.repository, f.saved.checkpoint, f.config, { api: f.api }),
    /bare coordinator/u,
  );
  execFileSync("git", ["-C", f.bare, "update-ref", coordinatorStateRef, f.initial.checkpoint]);
  await assert.rejects(
    publishCoordinatorCheckpoint(f.bare, f.initial.checkpoint, f.config, { api: f.api }),
    /initialized previous/u,
  );
  assert.deepEqual(f.counts(), { posts: 0, mutations: 0, snapshots: 0 });
  assert.equal(f.requests(), 0);
});
