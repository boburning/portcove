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
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";

import { gitObject, remoteFixture } from "./fixtures/coordinator-state-fixtures.mts";

void test("remote checkpoint exports exact Git objects, atomically persists receipts, and repeats without writes", async (t) => {
  const f = await remoteFixture(t);
  // Exercise the real bounded API adapter and its JSON stdin contract without
  // invoking gh, resolving credentials, or making a network request.
  const api = new GitHubApiClient(
    createGitHubRunner({
      cwd: f.bare,
      spawn: (command, args, options) => {
        assert.equal(command, "gh");
        assert.equal(options.timeout, 15_000);
        assert.equal(options.windowsHide, true);
        let response: unknown;
        let status: number;
        if (options.input !== undefined) assert.equal(typeof options.input, "string");
        const input: unknown =
          options.input === undefined ? null : JSON.parse(options.input as string);
        if (args[1] === "graphql") {
          assert.deepEqual(args, ["api", "graphql", "--include", "--input", "-"]);
          assert.ok(
            isRecord(input) && typeof input.query === "string" && isRecord(input.variables),
          );
          response = f.api.graphql(input.query, input.variables);
          status = 200;
        } else {
          const method = args[args.indexOf("--method") + 1];
          assert.ok(method);
          const result = f.api.request(method, args[2]!, input);
          response = result.body;
          status = result.status!;
        }
        return {
          status: 0,
          stdout: `HTTP/2.0 ${status} Fixture\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(response)}`,
          stderr: "",
        };
      },
    }),
  );
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
  assert.equal(result.recovered, false);
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
  const next = await publishCoordinatorCheckpoint(f.bare, advanced.checkpoint, f.config, {
    api,
  });
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
