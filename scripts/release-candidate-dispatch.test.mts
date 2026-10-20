import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchPreparedReleaseCandidate,
  readPreparedReleaseCandidate,
} from "./release-candidate-dispatch.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { isRecord } from "./runtime-values.mts";

const input = {
  version: "0.19.0-preview.1",
  prepared_commit: "a".repeat(40),
  remote_configuration: { schema_version: 1, namespace: "portcove-fixture" },
  dispatch_actor_id: "1234",
};
function provider(mode = "success") {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const transport: typeof fetch = async (raw, init) => {
    const url = typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url;
    const method = init?.method ?? "GET";
    assert.ok(init?.body === undefined || typeof init.body === "string");
    const body: unknown = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    assert.equal(new Headers(init?.headers).get("x-github-api-version"), "2026-03-10");
    assert.equal(init?.redirect, "error");
    if (url.endsWith("/release.yml"))
      return Response.json({ id: 999, path: ".github/workflows/release.yml", state: "active" });
    if (url.endsWith("/dispatches")) {
      if (mode === "lost") throw new Error("credential-super-secret must not escape");
      if (mode === "legacy") return new Response(null, { status: 204 });
      return Response.json({
        workflow_run_id: 42,
        run_url: "https://api.github.com/repos/boburning/portcove/actions/runs/42",
        html_url: "https://github.com/boburning/portcove/actions/runs/42",
      });
    }
    assert.equal(url, "https://api.github.com/repos/boburning/portcove/actions/runs/42");
    return Response.json({
      id: 42,
      workflow_id: 999,
      path: ".github/workflows/release.yml",
      event: "workflow_dispatch",
      run_attempt: mode === "attempt" ? 2 : 1,
      head_sha: mode === "source" ? "b".repeat(40) : input.prepared_commit,
      head_branch: "portcove-fixture-prepared/v0.19.0-preview.1",
      repository: { id: 1354613114, full_name: "boburning/portcove" },
      actor: { id: mode === "actor" ? 555 : 1234 },
      triggering_actor: { id: 1234 },
      status: "queued",
    });
  };
  return { calls, transport };
}
void test("one immutable prepared tag dispatch binds documented acknowledgment and exact run readback", async () => {
  const fixture = provider();
  let guard = 0;
  const result = await dispatchPreparedReleaseCandidate(
    input,
    "credential-super-secret",
    async () => {
      assert.equal(fixture.calls.length, 1);
      guard++;
    },
    fixture.transport,
  );
  assert.equal(guard, 1);
  assert.equal(result.remote_identity, "github-actions:boburning/portcove:run:42:attempt:1");
  assert.equal(result.evidence.ref, "refs/tags/portcove-fixture-prepared/v0.19.0-preview.1");
  assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
  assert.deepEqual(fixture.calls[1]?.body, { ref: "portcove-fixture-prepared/v0.19.0-preview.1" });
});
void test("dispatch never retries lost acknowledgment, unsupported status or mismatched actual run", async () => {
  for (const mode of ["lost", "legacy", "attempt", "source", "actor"]) {
    const fixture = provider(mode);
    await assert.rejects(
      dispatchPreparedReleaseCandidate(
        input,
        "credential-super-secret",
        async () => {},
        fixture.transport,
      ),
      (error: unknown) => {
        assert.ok(error instanceof CoordinatorRemoteError);
        assert.ok(isRecord(error.evidence));
        assert.equal(error.evidence.mutation_attempted, true);
        assert.equal(JSON.stringify(error).includes("credential-super-secret"), false);
        return true;
      },
    );
    assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
  }
});
void test("late control refusal performs zero POST and reports refusal before effect", async () => {
  const fixture = provider();
  await assert.rejects(
    dispatchPreparedReleaseCandidate(
      input,
      "credential-super-secret",
      async () => {
        throw new Error("expired observation");
      },
      fixture.transport,
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError);
      assert.ok(isRecord(error.evidence));
      assert.equal(error.evidence.mutation_attempted, false);
      return true;
    },
  );
  assert.equal(fixture.calls.length, 1);
});

void test("exact retained run continuation repeats only GET and reproduces original receipt", async () => {
  const first = provider();
  const original = await dispatchPreparedReleaseCandidate(
    input,
    "secret",
    async () => {},
    first.transport,
  );
  const continuation = provider();
  const observed = await readPreparedReleaseCandidate(input, 42, "secret", continuation.transport);
  assert.equal(observed.evidence_sha256, original.evidence_sha256);
  assert.equal(observed.remote_identity, original.remote_identity);
  assert.deepEqual(
    continuation.calls.map((call) => call.method),
    ["GET", "GET"],
  );
});
