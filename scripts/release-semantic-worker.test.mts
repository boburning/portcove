import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectSemanticWorkerConfiguration } from "./release-semantic-worker.mts";
import { reviewFrozenCoordinatorRequest } from "./release-semantic-request-pipeline.mts";
import { releaseSourceFixture } from "./fixtures/release-source-fixture.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import { createReleaseReviewRequest } from "./release-review-request.mts";

function configuration() {
  return {
    schema_version: 1,
    kind: "portcove-fixed-semantic-worker",
    worker_revision: "a".repeat(40),
    setup_grant_sha256: "1".repeat(64),
    namespace: "portcove-worker-fixture",
    output_parent: "/unprovisioned/output",
    source_repository: "/unprovisioned/source",
    source_read_token: "/unprovisioned/credentials/source-read",
    auth_cache: "/unprovisioned/reviewer/auth.json",
    runtime: {
      schema_version: 1,
      output_parent: "/unprovisioned/output",
      node_executable: "/unprovisioned/node",
      codex_executable: "/unprovisioned/codex",
      node_sha256: "2".repeat(64),
      codex_sha256: "3".repeat(64),
      supervisor_sha256: "4".repeat(64),
      tools_sha256: {
        python: "5".repeat(64),
        bwrap: "6".repeat(64),
        systemd_run: "7".repeat(64),
        systemctl: "8".repeat(64),
      },
    },
    issuer: {
      issuer: { app_id: 123, installation_id: 456, writer_app_id: 789 },
      private_key: "/unprovisioned/issuer/private.pem",
      public_key_sha256: "9".repeat(64),
      node_sha256: "2".repeat(64),
      http_modules_sha256: {
        "release-semantic-issuer-http.mts": "a".repeat(64),
        "release-canonical.mts": "b".repeat(64),
        "runtime-values.mts": "c".repeat(64),
      },
    },
  };
}
void test("worker setup excludes supplied outcomes/backends and separates the fixed issuer from source/reviewer inputs", () => {
  const raw = configuration();
  const result = inspectSemanticWorkerConfiguration(raw);
  assert.equal(result.namespace, raw.namespace);
  assert.notEqual(result.source_read_token, result.issuer.private_key);
  for (const changed of [
    { ...raw, accepted: true },
    { ...raw, source_read_token: "ambient" },
    { ...raw, source_read_token: raw.auth_cache },
    { ...raw, source_read_token: `${raw.output_parent}/source-token` },
    { ...raw, source_read_token: "/unprovisioned/./credentials/source-read" },
    { ...raw, runtime: { ...raw.runtime, backend: "return-accepted" } },
    { ...raw, issuer: { ...raw.issuer, issuer: { ...raw.issuer.issuer, app_id: 15368 } } },
    { ...raw, issuer: { ...raw.issuer, issuer: { ...raw.issuer.issuer, app_id: 789 } } },
    { ...raw, issuer: { ...raw.issuer, node_sha256: "d".repeat(64) } },
  ])
    assert.throws(() => inspectSemanticWorkerConfiguration(changed));
});

void test("actual proposal pipeline freezes real Git inputs then refuses an unqualified host/runtime before capture or issuer release", async (t) => {
  const f = releaseSourceFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "semantic-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "--quiet", root], { windowsHide: true });
  const git = (args: string[], input?: string | Buffer) =>
    execFileSync("git", ["-C", root, ...args], { input, windowsHide: true })
      .toString()
      .trim();
  for (const text of ["readme\n", "base\n", "source\n"])
    git(["hash-object", "-w", "--stdin"], text);
  const readme = git(["hash-object", "--stdin"], "readme\n");
  for (const blob of [f.oldBlob, f.newBlob])
    git(["mktree"], `100644 blob ${readme}\tREADME.md\n100644 blob ${blob}\tapp.rs\n`);
  for (const commit of [f.base, f.original])
    git(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      inspectRemoteCommitObject(commit, commit.sha).object.bytes,
    );
  const raw = inspectSemanticWorkerConfiguration(configuration());
  const request = createReleaseReviewRequest({
    before_checkpoint: "f".repeat(40),
    requested_at: "2026-01-01T00:00:00.000Z",
    base_commit: f.base.sha,
    base_version: "0.1.0-alpha.2",
    source_commit: f.original.sha,
    source_tree: f.sourceTree,
    change_set_sha256: f.expectedHash,
  });
  const release = {
    id: 1,
    draft: false,
    tag_name: "v0.1.0-alpha.2",
    published_at: "2026-01-01T00:00:00Z",
  };
  let reads = 0,
    guards = 0,
    handoffs = 0;
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      reads++;
      let body: unknown;
      let status = 200;
      if (endpoint === "repos/boburning/portcove")
        body = { id: 1354613114, full_name: "boburning/portcove" };
      else if (endpoint.includes("/releases?")) body = [release];
      else if (endpoint.endsWith("/releases/1")) body = release;
      else if (endpoint.includes("/git/ref/tags/v0.1.0-alpha.2"))
        body = { ref: "refs/tags/v0.1.0-alpha.2", object: { type: "commit", sha: f.base.sha } };
      else if (endpoint.includes("/git/ref/tags/portcove-worker-fixture-")) {
        body = { message: "Not Found" };
        status = 404;
      } else return f.api.request(method, endpoint);
      return { status, body, headers: new Map<string, string>() };
    },
  };
  const selected = {
    namespace: raw.namespace,
    issuer: raw.issuer,
    runtime: {
      ...raw.runtime,
      backend: "linux-rootless" as const,
      auth_cache: raw.auth_cache,
      requireIsolationReady: async () => {
        guards++;
      },
    },
    requireCurrentRequestAndProvisioning: async () => {
      guards++;
    },
    retainOriginalCheckRequest: async () => {
      handoffs++;
    },
  };
  await assert.rejects(
    reviewFrozenCoordinatorRequest(api, root, request, selected),
    /fixed ordinary Linux runtime|qualified runtime changed|ENOENT/,
  );
  assert.ok(reads > 0);
  assert.ok(guards >= 1);
  assert.equal(handoffs, 0);
  reads = 0;
  await assert.rejects(
    reviewFrozenCoordinatorRequest(api, root, request, {
      ...selected,
      requireCurrentRequestAndProvisioning: async () => {
        throw new Error("request superseded");
      },
    }),
    /request superseded/,
  );
  assert.equal(reads, 0);
});
