import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RoadmapClient, validateConfig } from "./roadmap.mts";
import type { RoadmapRequestScope } from "./roadmap.mts";
import { GitHubApiError } from "./github-operation.mts";
import { isRecord } from "./runtime-values.mts";

const config = validateConfig(
  JSON.parse(await readFile(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
function scope(fetch: typeof globalThis.fetch): RoadmapRequestScope {
  return {
    credential: { kind: "anonymous" },
    deadline: performance.now() + 10000,
    failedReads: new Map(),
    deferral: { primary: new Map(), secondary: 0 },
    fetch,
    random: () => 0,
    sleep: async () => {},
    allowMutations: false,
  };
}
function response(data: unknown, request = "request-1", status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "x-github-request-id": request,
      "x-ratelimit-resource": "graphql",
      "x-ratelimit-remaining": "1000",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-used": "1",
      "x-ratelimit-reset": "2051222400",
    },
  });
}

void test("Roadmap raw GraphQL retains request evidence and parsed quota cost through the locked SDK", async () => {
  let sends = 0;
  const client = await RoadmapClient.connect(
    config,
    scope(async (_input, init) => {
      sends++;
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("x-github-api-version"), "2022-11-28");
      return response({
        data: {
          value: "complete",
          rateLimit: {
            cost: 7,
            remaining: 993,
            used: 7,
            limit: 5000,
            resetAt: "2035-01-01T00:00:00Z",
          },
        },
      });
    }),
  );
  const data = await client.graphql(
    "query Evidence { value rateLimit { cost remaining used limit resetAt } }",
  );
  assert.equal(isRecord(data) && data.value, "complete");
  assert.equal(sends, 1);
  assert.equal(client.observations.length, 1);
  const observation = client.observations[0];
  assert.ok(observation);
  assert.equal(observation.operation, "POST graphql");
  assert.equal(observation.status, 200);
  assert.equal(observation.request_id, "request-1");
  assert.equal(observation.rate?.cost, 7);
  assert.equal(observation.rate?.remaining, 993);
  assert.match(observation.query_sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(observation.dispatched, true);
  assert.equal(observation.attempt, 1);
  assert.equal(observation.bytes_known, true);
  assert.ok(observation.bytes > 0);
});

void test("doctor client recovery shares an exhausted failed logical-read allowance", async () => {
  let sends = 0;
  const operation = scope(async () => {
    sends++;
    return response({ message: "temporary failure" }, `request-${sends}`, 500);
  });
  const first = await RoadmapClient.connect(config, operation);
  const query = "query StableLogicalPage { value }";
  await assert.rejects(first.graphql(query), (error) => error instanceof GitHubApiError);
  assert.equal(sends, 3);
  const recovered = await RoadmapClient.connect(config, operation);
  await assert.rejects(
    recovered.graphql(query),
    (error) => error instanceof GitHubApiError && error.code === "retry_exhausted",
  );
  assert.equal(sends, 3);
  assert.deepEqual(
    first.observations.map((entry) => entry.attempt),
    [1, 2, 3],
  );
  assert.equal(recovered.observations.length, 0);
});

void test("successful stability observations retain separate reads and fresh allowances", async () => {
  let sends = 0;
  const client = await RoadmapClient.connect(
    config,
    scope(async () => response({ data: { value: ++sends } })),
  );
  assert.deepEqual(await client.graphql("query Stability { value }"), { value: 1 });
  assert.deepEqual(await client.graphql("query Stability { value }"), { value: 2 });
  assert.deepEqual(
    client.observations.map((entry) => entry.attempt),
    [1, 1],
  );
});

void test("read-only Roadmap roles refuse mutations before dispatch", async () => {
  let sends = 0;
  const client = await RoadmapClient.connect(
    config,
    scope(async () => {
      sends++;
      return response({ data: {} });
    }),
  );
  await assert.rejects(
    client.graphql("mutation Write { updateProjectV2 { projectV2 { id } } }"),
    (error) => error instanceof GitHubApiError && error.code === "request_refused" &&
      isRecord(error) && error.mutation_dispatched === false,
  );
  assert.equal(sends, 0);
  assert.equal(client.observations.length, 0);
});

void test("Roadmap mutation failure retains one dispatch and ambiguous-write evidence", async () => {
  let sends = 0;
  const operation = scope(async () => {
    sends++;
    return response({ message: "remote failure" }, "write-request", 500);
  });
  operation.allowMutations = true;
  const client = await RoadmapClient.connect(config, operation);
  await assert.rejects(
    client.graphql("mutation Write { updateProjectV2 { projectV2 { id } } }"),
    (error) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.requestId, "write-request");
      assert.equal(isRecord(error) && error.mutation_dispatched, true);
      return true;
    },
  );
  assert.equal(sends, 1);
  assert.equal(client.observations[0]?.dispatched, true);
});

void test("a later inventory page failure cannot return a validated prefix", async () => {
  let sends = 0;
  const client = await RoadmapClient.connect(
    config,
    scope(async () => {
      sends++;
      return sends === 1
        ? response({
            data: {
              collection: {
                totalCount: 2,
                nodes: [{ id: "first" }],
                pageInfo: { hasNextPage: true, endCursor: "next" },
              },
            },
          })
        : response({ message: "later page unavailable" }, `later-${sends}`, 500);
    }),
  );
  await assert.rejects(
    client.readInventory(
      "query Inventory($after:String){collection{totalCount}}",
      {},
      (data) => (isRecord(data) ? data.collection : undefined),
      (node) => (isRecord(node) ? node.id : undefined),
    ),
    (error) => error instanceof GitHubApiError,
  );
  assert.equal(sends, 4);
});

void test("GraphQL HTTP 200 rate limits retain owner evidence and defer subsequent reads", async () => {
  let sends = 0;
  const operation = scope(async () => {
    sends++;
    return response({ errors: [{ type: "RATE_LIMITED", message: "quota exhausted" }],
      data: { rateLimit: { cost: 3, remaining: 0, used: 5000, limit: 5000, resetAt: "2035-01-01T00:00:00Z" } } });
  });
  const client = await RoadmapClient.connect(config, operation);
  await assert.rejects(client.graphql("query Limited { rateLimit { cost remaining used limit resetAt } }"), (error) => error instanceof GitHubApiError);
  assert.equal(sends, 1);
  assert.equal(isRecord(client.graphqlRate) && client.graphqlRate.remaining, 0);
  assert.equal(client.observations[0]?.status, 200);
  assert.equal(client.observations[0]?.rate?.cost, 3);
  await assert.rejects(client.graphql("query Another { value }"), (error) => error instanceof GitHubApiError);
  assert.equal(sends, 1);
});

void test("local mutation refusal cannot be accepted by a matching domain readback", async () => {
  let sends = 0;
  const client = await RoadmapClient.connect(config, scope(async () => {
    sends++;
    throw new Error("Unexpected transport");
  }));
  let reads = 0;
  client.projectDetails = async () => {
    reads++;
    return { id: "PVT", number: config.project.number, title: config.project.title };
  };
  await assert.rejects(client.editProject(config.project.number), error =>
    error instanceof GitHubApiError && error.code === "request_refused");
  assert.equal(reads, 1, "no reconciliation read follows a refusal before dispatch");
  assert.equal(sends, 0);
  client.projectContext = async () => ({ details: { id: "PVT" }, fields: [], number: config.project.number });
  await assert.rejects(client.capture({ title: "draft", body: "body", fields: {} }), error =>
    error instanceof GitHubApiError && error.code === "request_refused");
  assert.equal(sends, 0);
});
