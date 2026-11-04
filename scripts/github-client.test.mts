import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient } from "./github-client.mts";
import type { GitHubAttemptObservation, GitHubRequestPolicy } from "./github-client.mts";
import { localDeveloperCredential, verifyGitHubAttestation } from "./github-cli.mts";
import { GitHubApiError } from "./github-operation.mts";

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

void test("credential resolution is bounded and cancellation never exposes its raw reason", async () => {
  const controller = new AbortController();
  controller.abort(new Error("ghs_SYNTHETIC_ONLY"));
  let calls = 0;
  await assert.rejects(
    createGitHubClient({
      credential: {
        kind: "local",
        resolve: async () => {
          calls++;
          return new Promise<string>(() => {});
        },
      },
      signal: controller.signal,
      deadline: performance.now() + 100,
    }),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.code === "cancelled" &&
      !error.message.includes("SYNTHETIC"),
  );
  assert.equal(calls, 0);
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      createGitHubClient({
        credential: { kind: "local", resolve: async () => new Promise<string>(() => {}) },
        deadline: performance.now() + 10,
      }),
      (error: unknown) => error instanceof GitHubApiError && error.code === "deadline_exceeded",
    );
  } finally {
    clearTimeout(keepAlive);
  }
  const token = "ghs_SYNTHETIC_ONLY";
  const later = new AbortController();
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    signal: later.signal,
    deadline: performance.now() + 1000,
    fetch: async () => {
      throw new Error("must not dispatch");
    },
  });
  later.abort(new Error(`cancelled with ${token}`));
  await assert.rejects(
    client.request("GET /rate_limit"),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.code === "cancelled" &&
      !error.message.includes(token),
  );
});

void test("local credential roles preserve precedence, resolve once and refuse CI fallback", async () => {
  const explicit = localDeveloperCredential({
    deadline: performance.now() + 1000,
    environment: { GH_TOKEN: "first", GITHUB_TOKEN: "second" },
    resolve: async () => {
      throw new Error("must not resolve");
    },
  });
  assert.deepEqual(explicit, { kind: "explicit", token: "first" });
  assert.throws(
    () =>
      localDeveloperCredential({
        deadline: performance.now() + 1000,
        environment: { GITHUB_ACTIONS: "true" },
      }),
    /credential/u,
  );
  let calls = 0;
  const credential = localDeveloperCredential({
    deadline: performance.now() + 1000,
    environment: {},
    resolve: async () => {
      calls++;
      return "opaque-synthetic";
    },
  });
  assert.equal(credential.kind, "local");
  if (credential.kind !== "local") throw new Error("expected local credential");
  await credential.resolve(new AbortController().signal);
  await credential.resolve(new AbortController().signal);
  assert.equal(calls, 1);
  assert.throws(
    () =>
      verifyGitHubAttestation(["api", "repos/owner/repo"], {
        cwd: process.cwd(),
        timeoutMs: 1000,
        maxBytes: 1024,
      }),
    /attestation/u,
  );
});

void test("secondary fallback increases 60 then120 seconds without multiplying attempts", async () => {
  let mono = 0,
    wall = 1_800_000_000_000,
    sends = 0,
    held = 0;
  const waits: number[] = [];
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: 300_000,
    requestTimeoutMs: 300_000,
    now: () => mono,
    wallNow: () => wall,
    sleep: async (delay) => {
      assert.equal(held, 0);
      waits.push(delay);
      mono += delay;
      wall += delay;
    },
    reserve: () => {
      held++;
      return {
        consumeBytes() {},
        settle() {
          held--;
        },
      };
    },
    fetch: async () => {
      sends++;
      return new Response(JSON.stringify({ message: "secondary rate limit" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await assert.rejects(
    client.request("GET /rate_limit", { request: { portcove: read() } }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "rate_limited",
  );
  assert.equal(sends, 3);
  assert.equal(held, 0);
  assert.deepEqual(waits, [60_000, 120_000]);
});

void test("GraphQL HTTP200 throttling updates shared deferral without replay or partial data", async () => {
  const state = { primary: new Map<string, number>(), secondary: 0 };
  const wall = Date.now();
  let sends = 0;
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: performance.now() + 1000,
    deferral: state,
    fetch: async () => {
      sends++;
      return new Response(
        JSON.stringify({
          data: { partial: true },
          errors: [{ type: "RATE_LIMITED", message: "secondary rate limit" }],
        }),
        { headers: { "content-type": "application/json", "x-github-request-id": "graph-fixture" } },
      );
    },
  });
  await assert.rejects(
    client.request("POST /graphql", {
      query: "query { viewer { login } }",
      request: { portcove: { replay: "pure-query", attempts: 0 } },
    }),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.code === "rate_limited" &&
      error.requestId === "graph-fixture",
  );
  assert.equal(sends, 1);
  assert(state.secondary >= wall + 60_000);
  await assert.rejects(client.request("GET /rate_limit"), /deferral/u);
  assert.equal(sends, 1);
});

void test("authorization failures do not defer, primary waits do not shorten, and304 keeps headers", async () => {
  const state = { primary: new Map<string, number>(), secondary: 0 };
  let status = 403,
    limited = false;
  const client = await createGitHubClient({
    credential: { kind: "explicit", token: "ghs_SYNTHETIC_ONLY" },
    deadline: performance.now() + 1000,
    deferral: state,
    fetch: async () =>
      new Response(status === 304 ? null : "{}", {
        status,
        headers: {
          "content-type": "application/json",
          etag: "fixture",
          "x-github-request-id": "primary",
          ...(limited
            ? {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-resource": "core",
                "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 600),
              }
            : {}),
        },
      }),
  });
  await assert.rejects(client.request("GET /rate_limit"));
  assert.equal(state.secondary, 0);
  assert.equal(state.primary.size, 0);
  status = 304;
  const response = await client.request("GET /rate_limit", {
    headers: { "If-None-Match": "fixture" },
  });
  assert.equal(response.status, 304);
  assert.equal(response.headers.etag, "fixture");
  status = 403;
  limited = true;
  await assert.rejects(
    client.request("GET /rate_limit", { request: { portcove: read() } }),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.code === "rate_limited" &&
      error.requestId === "primary" &&
      error.rateLimit?.remaining === 0,
  );
  assert(state.primary.get("core")! > Date.now() + 500_000);
});

void test("large numeric identities reject before hashing while opaque IDs and safe JSON remain exact", async () => {
  let body = '{"id":9007199254740993}';
  let sends = 0;
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: performance.now() + 1000,
    fetch: async () => {
      sends++;
      return new Response(body, { headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(
    client.request("GET /rate_limit", { request: { portcove: read() } }),
    /numeric/u,
  );
  assert.equal(sends, 1);
  body = '{"id":9007199254740991,"node_ids":["A","a"]}';
  assert.equal(JSON.stringify((await client.request("GET /rate_limit")).data), body);
});

void test("cancellation drains a pending response and settles its dispatched reservation", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const observations: GitHubAttemptObservation[] = [];
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    signal: controller.signal,
    deadline: performance.now() + 1000,
    reserve: () => ({ consumeBytes() {}, settle: (value) => observations.push(value) }),
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            setTimeout(() => controller.abort(new Error("ghs_SYNTHETIC_ONLY")), 5);
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await assert.rejects(client.request("GET /rate_limit"), /REDACTED/u);
  assert(cancelled);
  assert.equal(observations.length, 1);
  assert(observations[0]?.dispatched);
});

void test("raw GraphQL success preserves full evidence in one SDK request", async () => {
  let dispatched = 0;
  const observations: GitHubAttemptObservation[] = [];
  const payload = { data: { viewer: { id: "opaque-node" }, rateLimit: { remaining: 42 } } };
  const client = await createGitHubClient({
    credential: { kind: "explicit", token: "synthetic-known-credential" },
    deadline: performance.now() + 5000,
    observe: (observation) => observations.push(observation),
    fetch: async (_input, init) => {
      dispatched++;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-github-api-version"), "2026-03-10");
      assert.equal(headers.get("accept"), "application/vnd.github+json");
      return Response.json(payload, {
        headers: {
          "x-github-request-id": "graphql-evidence",
          "x-ratelimit-resource": "graphql",
        },
      });
    },
  });
  const response = await client.request("POST /graphql", {
    data: { query: "query { viewer { id } rateLimit { remaining } }" },
    headers: { "X-GitHub-Api-Version": "2026-03-10", accept: "application/vnd.github+json" },
    request: { portcove: { replay: "pure-query", attempts: 0 } },
  });
  assert.deepEqual(response.data, payload);
  assert.equal(response.headers["x-github-request-id"], "graphql-evidence");
  assert.equal(observations[0]?.headers["x-ratelimit-resource"], "graphql");
  assert.equal(dispatched, 1);
});

void test("SDK refuses redirects before following or parsing their response", async () => {
  let dispatched = 0;
  let cancelled = false;
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: performance.now() + 5000,
    fetch: async () => {
      dispatched++;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 302,
          headers: { location: "https://elsewhere.invalid/credential-target" },
        },
      );
    },
  });
  await assert.rejects(
    client.request("GET /rate_limit", { request: { portcove: read() } }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "redirect_refused",
  );
  assert.equal(dispatched, 1);
  assert.equal(cancelled, true);
});
