import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient, iterateGitHubPages } from "./github-client.mts";
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

void test("locked SDK pagination preserves original envelopes and independent page allowances", async () => {
  const sent: string[] = [];
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: performance.now() + 10000,
    random: () => 0,
    fetch: async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      );
      assert.equal(new Headers(init?.headers).get("x-github-api-version"), "2022-11-28");
      const page = Number(url.searchParams.get("page") ?? 1);
      sent.push(url.href);
      if (page === 1 && sent.length < 3) return new Response("temporary", { status: 503 });
      return Response.json(
        { total_count: 4, jobs: [{ id: page }] },
        {
          headers: {
            "x-github-request-id": `page-${page}`,
            ...(page < 4
              ? {
                  link: `<https://api.github.com/repos/example/repo/actions/jobs?page=${page + 1}>; rel="next"`,
                }
              : {}),
          },
        },
      );
    },
  });
  const pages = [];
  for await (const page of iterateGitHubPages(client, {
    url: "https://api.github.com/repos/example/repo/actions/jobs",
    headers: { "X-GitHub-Api-Version": "2022-11-28" },
  }))
    pages.push(page);
  assert.equal(sent.length, 6);
  assert.deepEqual(
    pages.map((page) => page.data as unknown),
    [1, 2, 3, 4].map((id) => ({ total_count: 4, jobs: [{ id }] })),
  );
  assert.equal(pages[3]?.headers["x-github-request-id"], "page-4");
});

void test("SDK pagination cannot turn409 into empty success or loop beyond an admitted page", async () => {
  for (const mode of ["conflict", "loop"] as const) {
    let dispatched = 0;
    const client = await createGitHubClient({
      credential: { kind: "anonymous" },
      deadline: performance.now() + 5000,
      fetch: async () => {
        dispatched++;
        return mode === "conflict"
          ? Response.json({ message: "Conflict" }, { status: 409 })
          : Response.json([], {
              headers: { link: '<https://api.github.com/repos/example/repo/rulesets>; rel="next"' },
            });
      },
    });
    await assert.rejects(
      async () => {
        for await (const _page of iterateGitHubPages(client, {
          url: "https://api.github.com/repos/example/repo/rulesets",
        })) {
          /* Consume to establish terminal outcome. */
        }
      },
      (error: unknown) =>
        error instanceof GitHubApiError &&
        (mode === "conflict" ? error.status === 409 : error.code === "invalid_response"),
    );
    assert.equal(dispatched, 1);
  }
});

void test("later SDK pages cannot hide failing streams or reset a collection deadline", async () => {
  for (const mode of ["stream", "limit", "deadline"] as const) {
    let dispatched = 0,
      elapsed = 0;
    const client = await createGitHubClient({
      credential: { kind: "anonymous" },
      deadline: 1000,
      now: () => elapsed,
      maxBytes: mode === "limit" ? 4 : 1024,
      fetch: async () => {
        dispatched++;
        if (dispatched === 1) {
          if (mode === "deadline") elapsed = 1000;
          return Response.json([], {
            headers: {
              link: '<https://api.github.com/repos/example/repo/issues?page=2>; rel="next"',
            },
          });
        }
        if (mode === "limit") return new Response("overflow");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("later page stream failed"));
            },
          }),
        );
      },
    });
    await assert.rejects(
      async () => {
        for await (const _page of iterateGitHubPages(client, {
          url: "https://api.github.com/repos/example/repo/issues",
        })) {
          /* Consume all pages. */
        }
      },
      (error: unknown) =>
        error instanceof GitHubApiError &&
        (mode === "deadline"
          ? error.code === "deadline_exceeded"
          : mode === "limit"
            ? error.code === "response_limit"
            : /stream failed/u.test(error.message)),
    );
    assert.equal(dispatched, mode === "deadline" ? 1 : 2);
  }
});

void test("owned credential and request timeouts remain deadlines with a frozen monotonic clock", async () => {
  const hold = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      createGitHubClient({
        credential: { kind: "local", resolve: () => new Promise<string>(() => {}) },
        deadline: 1,
        now: () => 0,
      }),
      (error: unknown) => error instanceof GitHubApiError && error.code === "deadline_exceeded",
    );
    const client = await createGitHubClient({
      credential: { kind: "anonymous" },
      deadline: 1,
      now: () => 0,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("Missing request signal"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          if (signal.aborted) reject(signal.reason);
        }),
    });
    await assert.rejects(
      client.request("GET /rate_limit"),
      (error: unknown) => error instanceof GitHubApiError && error.code === "deadline_exceeded",
    );
    const backingOff = await createGitHubClient({
      credential: { kind: "anonymous" },
      deadline: 10000,
      requestTimeoutMs: 1,
      now: () => 0,
      random: () => 0,
      fetch: async () => new Response("temporary", { status: 503 }),
      sleep: async (_milliseconds, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          if (signal.aborted) reject(signal.reason);
        }),
    });
    await assert.rejects(
      backingOff.request("GET /rate_limit", { request: { portcove: read() } }),
      (error: unknown) => error instanceof GitHubApiError && error.code === "deadline_exceeded",
    );
  } finally {
    clearTimeout(hold);
  }
});

void test("owner cancellation retains its cause when the operation clock reaches the deadline", async () => {
  for (const phase of ["credential", "request"] as const) {
    const controller = new AbortController();
    let now = 0;
    const options = { deadline: 5000, now: () => now, signal: controller.signal };
    const work =
      phase === "credential"
        ? createGitHubClient({
            ...options,
            credential: {
              kind: "local",
              resolve: async () => {
                now = 5000;
                controller.abort(new Error("owner cancelled"));
                return "unused";
              },
            },
          })
        : createGitHubClient({
            ...options,
            credential: { kind: "anonymous" },
            fetch: async () => {
              now = 5000;
              controller.abort(new Error("owner cancelled"));
              throw controller.signal.reason;
            },
          }).then((client) => client.request("GET /rate_limit"));
    await assert.rejects(
      work,
      (error: unknown) => error instanceof GitHubApiError && error.code === "cancelled",
    );
  }
});

void test("asynchronous admission settles cancellation before dispatch with no charged request", async () => {
  let entered!: () => void, release!: () => void;
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const settled: GitHubAttemptObservation[] = [];
  let sends = 0;
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: performance.now() + 5000,
    signal: controller.signal,
    async reserve(request) {
      assert.equal(request.method, "GET");
      assert.equal(request.url.pathname, "/rate_limit");
      assert.equal(request.replay, "safe-read");
      entered();
      await hold;
      return {
        consumeBytes() {},
        settle(observation) {
          settled.push(observation);
        },
      };
    },
    fetch: async () => {
      sends++;
      return Response.json({});
    },
  });
  const pending = client.request("GET /rate_limit", { request: { portcove: read() } });
  const rejected = assert.rejects(
    pending,
    (error) => error instanceof GitHubApiError && error.code === "cancelled",
  );
  await admitted;
  controller.abort(new Error("Owner cancelled admission"));
  assert.equal(sends, 0);
  release();
  await rejected;
  assert.equal(sends, 0);
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.dispatched, false);
});

void test("parsed GraphQL cost is available on each settled SDK attempt including HTTP200 failure", async () => {
  for (const failed of [false, true]) {
    const observations: GitHubAttemptObservation[] = [];
    const client = await createGitHubClient({
      credential: { kind: "anonymous" },
      deadline: performance.now() + 5000,
      reserve: () => ({
        consumeBytes() {},
        settle(value) {
          observations.push(value);
        },
      }),
      fetch: async () =>
        Response.json({
          data: {
            rateLimit: {
              cost: 17,
              remaining: 4000,
              used: 1000,
              limit: 5000,
              resetAt: "2035-01-01T00:00:00Z",
            },
          },
          ...(failed ? { errors: [{ message: "Application refused" }] } : {}),
        }),
    });
    const request = client.request("POST /graphql", {
      query: "query { rateLimit { cost } }",
      request: { portcove: { replay: "pure-query", attempts: 0 } },
    });
    if (failed)
      await assert.rejects(
        request,
        (error) => error instanceof GitHubApiError && error.code === "graphql_error",
      );
    else await request;
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.rate?.cost, 17);
  }
});

void test("uncooperative admission cannot extend SDK cancellation or its original request timeout", async (t) => {
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  for (const mode of ["cancel", "timeout"] as const) {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController(),
      policy = read();
    const settled: GitHubAttemptObservation[] = [];
    let sends = 0;
    const client = await createGitHubClient({
      credential: { kind: "anonymous" },
      deadline: performance.now() + 1000,
      requestTimeoutMs: mode === "timeout" ? 10 : 1000,
      signal: controller.signal,
      async reserve({ signal }) {
        assert.ok(signal instanceof AbortSignal);
        entered();
        await gate;
        return {
          consumeBytes() {},
          settle(attempt) {
            settled.push(attempt);
          },
        };
      },
      fetch: async () => {
        sends++;
        return Response.json({});
      },
    });
    const pending = client.request("GET /rate_limit", { request: { portcove: policy } });
    const refused = assert.rejects(
      pending,
      (error) =>
        error instanceof GitHubApiError &&
        error.code === (mode === "cancel" ? "cancelled" : "deadline_exceeded"),
    );
    await started;
    if (mode === "cancel") controller.abort(new Error("Cancelled during admission"));
    await refused;
    assert.equal(sends, 0);
    assert.equal(settled.length, 0);
    assert.ok(policy.admissionSettled, "the operation can join still-owned cleanup");
    release();
    await policy.admissionSettled;
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.dispatched, false);
  }
});

void test("late unused-reservation cleanup retains its failure without replacing cancellation or leaking the credential", async () => {
  const token = "prefixless-synthetic-cleanup-secret";
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController(),
    policy = read();
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline: performance.now() + 5000,
    signal: controller.signal,
    async reserve() {
      entered();
      await gate;
      return {
        consumeBytes() {},
        settle() {
          throw new Error(token);
        },
      };
    },
    fetch: async () => {
      throw new Error("No dispatch is permitted");
    },
  });
  const pending = client.request("GET /rate_limit", { request: { portcove: policy } });
  const cancelled = assert.rejects(
    pending,
    (error) => error instanceof GitHubApiError && error.code === "cancelled",
  );
  await started;
  controller.abort();
  await cancelled;
  release();
  assert.ok(policy.admissionSettled);
  await assert.rejects(
    policy.admissionSettled,
    (error) => error instanceof GitHubApiError && !error.message.includes(token),
  );
});

void test("postdispatch accounting failure cannot replace cancellation or suppress attempt observation", async () => {
  const controller = new AbortController(),
    policy = once();
  const observations: GitHubAttemptObservation[] = [];
  let settlements = 0;
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: performance.now() + 5000,
    signal: controller.signal,
    reserve: () => ({
      consumeBytes() {},
      settle(attempt) {
        settlements++;
        assert.equal(attempt.dispatched, true);
        throw new Error("Accounting cleanup failed");
      },
    }),
    observe: (attempt) => observations.push(attempt),
    fetch: async () => {
      controller.abort();
      throw new DOMException("Cancelled after dispatch", "AbortError");
    },
  });
  await assert.rejects(
    client.request("POST /graphql", { query: "mutation { write }", request: { portcove: policy } }),
    (error) => error instanceof GitHubApiError && error.code === "cancelled",
  );
  assert.equal(settlements, 1);
  assert.equal(observations.length, 1);
  assert.ok(policy.admissionSettled);
  await assert.rejects(policy.admissionSettled, /Accounting cleanup failed/u);
});

void test("owner API and media headers apply to SDK REST and GraphQL while explicit request headers retain precedence", async () => {
  const versions: (string | null)[] = [];
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: performance.now() + 5000,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    fetch: async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("accept"), "application/vnd.github+json");
      versions.push(headers.get("x-github-api-version"));
      return Response.json(init?.method === "POST" ? { data: { value: "complete" } } : {});
    },
  });
  await client.request("GET /rate_limit");
  await client.request("GET /rate_limit", { headers: { "X-GitHub-Api-Version": "2026-03-10" } });
  await client.graphql("query { value }");
  assert.deepEqual(versions, ["2022-11-28", "2026-03-10", "2022-11-28"]);
});

void test("malformed quota reset cannot skip a dispatched attempt settlement or observation", async () => {
  for (const status of [200, 403]) {
    let settlements = 0;
    let requests = 0;
    const observations: GitHubAttemptObservation[] = [];
    const client = await createGitHubClient({
      credential: { kind: "anonymous" },
      deadline: performance.now() + 5000,
      reserve: () => ({
        consumeBytes() {},
        settle() {
          settlements++;
        },
      }),
      observe: (observation) => observations.push(observation),
      fetch: async () => {
        requests++;
        return Response.json(
          { message: status === 403 ? "Forbidden" : "Complete" },
          {
            status,
            headers: {
              "x-ratelimit-resource": "core",
              "x-ratelimit-reset": "9007199254740991",
              "x-ratelimit-remaining": "0",
            },
          },
        );
      },
    });
    const result = client.request("GET /rate_limit", { request: { portcove: once() } });
    if (status === 200) assert.equal((await result).status, 200);
    else
      await assert.rejects(
        result,
        (error) => error instanceof GitHubApiError && error.status === 403,
      );
    assert.equal(requests, 1);
    assert.equal(settlements, 1);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.dispatched, true);
    assert.equal(observations[0]?.status, status);
    assert.equal(observations[0]?.rate?.resetAt, null);
  }
});

void test("a caller collection deadline cannot lengthen the request budget or renew a failed logical read", async (t) => {
  let time = 1000;
  let requests = 0;
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  });
  const client = await createGitHubClient({
    credential: { kind: "anonymous" },
    deadline: 101000,
    requestTimeoutMs: 100,
    now: () => time,
    fetch: async () => {
      requests++;
      return Response.json({ id: 1 });
    },
  });
  const policy: GitHubRequestPolicy = { replay: "safe-read", attempts: 0, deadline: 99000 };
  await client.request("GET /rate_limit", { request: { portcove: policy } });
  assert.equal(timeouts.at(-1), 100);
  assert.equal(policy.deadline, 1100);
  time = 1100;
  await assert.rejects(client.request("GET /rate_limit", { request: { portcove: policy } }), {
    code: "deadline_exceeded",
  });
  assert.equal(policy.deadline, 1100);
  assert.equal(requests, 1);
});

void test("actual SDK honors smaller caller attempt bounds and refuses invalid bounds before dispatch", async () => {
  for (const maximum of [1, 2, 3, 0, 4]) {
    let sends = 0;
    const sdk = await createGitHubClient({
      credential: { kind: "anonymous" },
      deadline: performance.now() + 5000,
      random: () => 0,
      sleep: async () => {},
      fetch: async () => {
        sends++;
        return Response.json({ message: "transient fixture" }, { status: 503 });
      },
    });
    await assert.rejects(
      sdk.request("GET /rate_limit", {
        request: { portcove: { replay: "safe-read", attempts: 0, maxAttempts: maximum } },
      }),
    );
    assert.equal(sends, maximum >= 1 && maximum <= 3 ? maximum : 0);
  }
});

void test("actual SDK refuses malformed UTF-8 before parsing without retry or replacement characters", async () => {
  for (const status of [200, 503]) {
    let sends = 0;
    const sdk = await createGitHubClient({
      credential: { kind: "anonymous" },
      deadline: performance.now() + 5000,
      fetch: async () => {
        sends++;
        return new Response(Uint8Array.from([123, 34, 120, 34, 58, 34, 255, 34, 125]), {
          status,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await assert.rejects(
      sdk.request("GET /rate_limit", { request: { portcove: read() } }),
      (error: unknown) =>
        error instanceof GitHubApiError &&
        error.code === "invalid_response" &&
        /UTF-8/u.test(error.message),
    );
    assert.equal(sends, 1);
  }
});

void test("explicit redirect observation uses bounded SDK parsing without following Location", async () => {
  for (const mode of ["metadata", "oversize", "failed-stream"] as const) {
    let dispatched = 0;
    const client = await createGitHubClient({
      credential: { kind: "anonymous" },
      deadline: performance.now() + 5000,
      observeRedirects: true,
      maxBytes: mode === "oversize" ? 4 : 1024,
      fetch: async (_url, init) => {
        dispatched++;
        assert.equal(init?.redirect, "manual");
        return new Response(
          mode === "failed-stream"
            ? new ReadableStream({
                start(controller) {
                  controller.error(new Error("failed redirect body"));
                },
              })
            : JSON.stringify({
                message: "Moved Permanently",
                url: "https://api.github.com/repositories/123",
              }),
          {
            status: 301,
            headers: {
              "content-type": "application/json",
              location: "https://elsewhere.invalid/private",
            },
          },
        );
      },
    });
    const request = client.request("GET /repos/owner/repo", { request: { portcove: read() } });
    if (mode === "metadata") {
      const result = await request;
      assert.equal(result.status, 301);
      assert.deepEqual(result.data, {
        message: "Moved Permanently",
        url: "https://api.github.com/repositories/123",
      });
    } else await assert.rejects(request, (error: unknown) => error instanceof GitHubApiError);
    assert.equal(dispatched, 1);
  }
});
