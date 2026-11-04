import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient } from "./github-client.mts";
import type { GitHubAttemptObservation, GitHubRequestPolicy } from "./github-client.mts";

const once = (): GitHubRequestPolicy => ({ replay: "once", attempts: 0 });
const read = (): GitHubRequestPolicy => ({ replay: "safe-read", attempts: 0 });

void test("configured SDK preserves metadata, headers and byte evidence without ambient auth", async () => {
  const observations: GitHubAttemptObservation[] = [];
  const body = ' { "id": 17, "name": "é" }\n';
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: performance.now() + 5000,
    observe: (value) => observations.push(value),
    fetch: async (_url, init) => {
      assert(!new Headers(init?.headers).has("authorization"));
      assert.equal(init?.redirect, "manual");
      return new Response(body, {
        headers: { "content-type": "application/json", "x-github-request-id": "fixture" },
      });
    },
  });
  const result = await client.request("GET /repos/{owner}/{repo}", {
    owner: "owner",
    repo: "repo",
    headers: { "X-GitHub-Api-Version": "2026-03-10" },
  });
  assert.equal(result.data.id, 17);
  assert.equal(result.headers["x-github-request-id"], "fixture");
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.bytes, Buffer.byteLength(body));
});

void test("bounded metadata failure remains terminal through actual SDK error wrapping", async () => {
  for (const status of [200, 500]) {
    let sends = 0;
    const client = await createGitHubClient({
      credential: { kind: "anonymous" },
      deadline: performance.now() + 5000,
      maxBytes: 4,
      fetch: async () => {
        sends++;
        return new Response("oversized", { status });
      },
    });
    await assert.rejects(
      client.request("GET /rate_limit", { request: { portcove: read() } }),
      (error: unknown) => error instanceof Error && /byte limit/u.test(error.message),
    );
    assert.equal(sends, 1);
  }
});

void test("failed streams cannot become empty successful SDK responses", async () => {
  let sends = 0;
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: performance.now() + 5000,
    fetch: async () => {
      sends++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("body failed"));
          },
        }),
      );
    },
  });
  await assert.rejects(
    client.request("GET /rate_limit", { request: { portcove: read() } }),
    /body failed/u,
  );
  assert.equal(sends, 1);
});

void test("logical read allowance survives outer recovery and writes remain one attempt", async () => {
  let sends = 0;
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: performance.now() + 5000,
    random: () => 0,
    sleep: async () => {},
    fetch: async () => {
      sends++;
      return new Response("unavailable", { status: 503 });
    },
  });
  const policy = read();
  await assert.rejects(client.request("GET /rate_limit", { request: { portcove: policy } }));
  assert.equal(sends, 3);
  await assert.rejects(
    client.request("GET /rate_limit", { request: { portcove: policy } }),
    /allowance/u,
  );
  assert.equal(sends, 3);
  await assert.rejects(
    client.request("POST /repos/{owner}/{repo}/issues", {
      owner: "owner",
      repo: "repo",
      title: "fixture",
      request: { portcove: once() },
    }),
  );
  assert.equal(sends, 4);
});

void test("explicit credentials never fallback and scoped auth refuses foreign origins", async (context) => {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("unexpected ambient network request");
  });
  await assert.rejects(
    createGitHubClient({
      credential: { kind: "explicit", token: "" },
      deadline: performance.now() + 5000,
    }),
    /credential/u,
  );
  let sends = 0;
  const client = await createGitHubClient({
    credential: { kind: "explicit", token: "ghs_SYNTHETIC_ONLY" },
    deadline: performance.now() + 5000,
    fetch: async () => {
      sends++;
      return new Response("{}");
    },
  });
  await assert.rejects(client.request("GET https://example.com/metadata"), /scope/u);
  assert.equal(sends, 0);
});
