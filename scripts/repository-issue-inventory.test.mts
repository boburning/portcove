import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  collectRepositoryIssueInventory,
  requireRepositoryIssueInventory,
  InventoryError,
  retryableInventoryRead,
  runDoctorRead,
  admitDoctorReadRetry,
} from "./repository-issue-inventory.mts";
import type { DoctorReadAttempt, InventoryReader } from "./repository-issue-inventory.mts";
import { GitHubApiClient, GitHubApiError, createGitHubRunner } from "./github-api.mts";
import { RoadmapClient, runDoctor, validateConfig, renderPortIssueBody } from "./roadmap.mts";
import { DiscoveryBudget, createDiscoveryTransport } from "./discovery-budget.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";

const config = validateConfig(
  JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
const repository = config.repository;
function readerFixture(
  count: number,
  corrupt: (value: Record<string, unknown>, marker: boolean, page: number) => void = () => {},
) {
  let requests = 0;
  const queries: string[] = [];
  const reader: InventoryReader = {
    config,
    graphql(query, variables = {}) {
      queries.push(query);
      requests++;
      const marker = query.includes("RepositoryIssueMarker"),
        size = query.includes("first:50,") ? 50 : 100;
      const offset = Number(variables.after ?? 0);
      const numbers = marker
        ? count
          ? [count]
          : []
        : Array.from({ length: Math.min(size, count - offset) }, (_, i) => offset + i + 1);
      const value: Record<string, unknown> = {
        id: "R",
        nameWithOwner: repository,
        issues: {
          totalCount: count,
          nodes: numbers.map((number) => ({
            id: `I_${number}`,
            number,
            title: `Issue ${number}`,
            body: "body",
            url: `https://github.com/${repository}/issues/${number}`,
            state: "OPEN",
            updatedAt: "2026-10-17T00:00:00Z",
          })),
          pageInfo: {
            hasNextPage: !marker && offset + size < count,
            endCursor: offset + size < count ? String(offset + size) : null,
          },
        },
      };
      corrupt(value, marker, offset);
      return { repository: value };
    },
  };
  return { reader, queries, requests: () => requests };
}
const connection = (value: Record<string, unknown>) =>
  value.issues as {
    totalCount: number;
    nodes: Record<string, unknown>[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };

void test("shared collector covers empty and exact pagination boundaries with bounded field selection", () => {
  for (const count of [0, 1, 50, 51, 100, 101, 1001]) {
    for (const bodies of [false, true]) {
      const f = readerFixture(count);
      const got = collectRepositoryIssueInventory(f.reader, { bodies });
      assert.equal(got.issues.length, count);
      assert.equal(f.requests(), Math.max(1, Math.ceil(count / (bodies ? 50 : 100))) + 2);
      assert.equal(requireRepositoryIssueInventory(got, f.reader, bodies), got);
      assert.ok(Object.isFrozen(got.issues));
      assert.ok(f.queries.every((query) => !query.includes("search(")));
      assert.equal(got.evidence.total, count);
    }
  }
});
void test("newest issue present cannot hide missing middle pages", () => {
  const f = readerFixture(101, (value, marker) => {
    if (!marker) {
      const page = connection(value);
      page.nodes = page.nodes.filter((row) => row.number === 101);
      page.pageInfo.hasNextPage = false;
    }
  });
  assert.throws(() => collectRepositoryIssueInventory(f.reader), { code: "inventory_incomplete" });
});
void test("incomplete, malformed, duplicate, foreign and stalled observations fail closed", () => {
  const corruptions = [
    (v: Record<string, unknown>) => {
      v.id = "";
    },
    (v: Record<string, unknown>) => {
      v.nameWithOwner = "foreign/repository";
    },
    (v: Record<string, unknown>) => {
      connection(v).nodes[0]!.id = null;
    },
    (v: Record<string, unknown>) => {
      connection(v).nodes[0]!.number = 0;
    },
    (v: Record<string, unknown>) => {
      connection(v).nodes[0]!.body = null;
    },
    (v: Record<string, unknown>) => {
      connection(v).nodes[0]!.updatedAt = "invalid";
    },
    (v: Record<string, unknown>) => {
      connection(v).nodes[0]!.url = "https://github.com/foreign/repo/issues/1";
    },
    (v: Record<string, unknown>) => {
      connection(v).nodes[1]!.id = connection(v).nodes[0]!.id;
    },
    (v: Record<string, unknown>) => {
      connection(v).nodes[1]!.number = connection(v).nodes[0]!.number;
    },
    (v: Record<string, unknown>) => {
      connection(v).pageInfo.endCursor = null;
    },
  ];
  for (const corrupt of corruptions) {
    const f = readerFixture(101, (value, marker) => {
      if (!marker) corrupt(value);
    });
    assert.throws(() => collectRepositoryIssueInventory(f.reader));
    assert.ok(f.requests() <= 4, "collector cannot retry a rejected page");
  }
});
void test("verified inventories reject cloning, wrong clients, metadata-as-bodies and tampered evidence", () => {
  const f = readerFixture(1),
    got = collectRepositoryIssueInventory(f.reader);
  assert.throws(() => requireRepositoryIssueInventory(structuredClone(got), f.reader));
  assert.throws(() => requireRepositoryIssueInventory(got, readerFixture(1).reader));
  assert.throws(() =>
    requireRepositoryIssueInventory(
      collectRepositoryIssueInventory(f.reader, { bodies: false }),
      f.reader,
    ),
  );
  got.evidence.total = 0;
  assert.throws(() => requireRepositoryIssueInventory(got, f.reader));
});
void test("stale inventory cannot establish live completeness", () => {
  const f = readerFixture(0),
    now = Date.now;
  const got = collectRepositoryIssueInventory(f.reader);
  Date.now = () => now() + 120001;
  try {
    assert.throws(() => requireRepositoryIssueInventory(got, f.reader));
  } finally {
    Date.now = now;
  }
});
void test("programmatic doctor uses the same strict collector with or without an evidence sink", async () => {
  for (const sink of [undefined, []]) {
    const f = readerFixture(2, (value, marker) => {
      if (!marker) connection(value).nodes.pop();
    });
    const client = {
      ...f.reader,
      gh: () => "",
      completeProjectContext: () => ({ details: { id: "P" }, fields: [] }),
      viewList: () => [],
      projectAudit: () => ({ repositories: { nodes: [] } }),
      itemList: () => [],
      repositoryIssues() {
        return collectRepositoryIssueInventory(this);
      },
    };
    await assert.rejects(
      runDoctor(config, client, {
        quiet: true,
        ...(sink ? { repositoryIssueInventoryAttempts: sink } : {}),
      }),
      { code: "inventory_incomplete" },
    );
    assert.equal(f.requests(), 2);
    if (sink) assert.equal(sink.length, 1);
  }
});
void test("intake and normalization never mutate after incomplete collection", () => {
  const f = readerFixture(3, (value, marker) => {
    if (!marker) connection(value).nodes.pop();
  });
  let writes = 0;
  const client = new RoadmapClient(config, () => {
    writes++;
    throw new Error("unexpected mutation");
  });
  client.graphql = f.reader.graphql.bind(f.reader);
  client.repositoryIssue = () => ({
    number: 1,
    node_id: "I_1",
    title: "[Port] Fixture",
    html_url: `https://github.com/${repository}/issues/1`,
    body: renderPortIssueBody({
      title: "Fixture",
      upstream: "https://example.test/engine",
      portKey: "fixture",
    }),
  });
  assert.throws(() =>
    client.createPortIssue({
      title: "Fixture",
      upstream: "https://example.test/engine",
      portKey: "fixture",
    }),
  );
  assert.throws(() => client.normalizePortIssue({ number: 1, catalog: { ports: [] } }));
  assert.equal(writes, 0);
});
void test("HTTP-200 partial-data throttling is nonretryable and retains safe request metadata", () => {
  const api = new GitHubApiClient(
    () =>
      "HTTP/2 200\nx-github-request-id: REQUEST\nretry-after: 60\n\n" +
      JSON.stringify({
        data: { repository: {} },
        errors: [{ type: "RATE_LIMITED", message: "throttled" }],
      }),
  );
  assert.throws(
    () => api.graphql("query { rateLimit { cost } }"),
    (error) =>
      error instanceof GitHubApiError &&
      error.code === "rate_limited" &&
      !retryableInventoryRead(error),
  );
  assert.equal(api.observations[0]?.request_id, "REQUEST");
  assert.ok(!JSON.stringify(api.observations).includes('"repository"'));
});
void test("oversized responses are rejected without reusing partial output", () => {
  const api = new GitHubApiClient(
    createGitHubRunner({
      maxBuffer: 32,
      spawn: () => ({
        status: null,
        stdout: '{"data":{}}',
        stderr: "",
        error: Object.assign(new Error("overflow"), { code: "ENOBUFS" }),
      }),
    }),
  );
  assert.throws(
    () => api.graphql("query { viewer { id } }"),
    (error) => error instanceof GitHubApiError && !retryableInventoryRead(error),
  );
});
void test("whole-read retry retains attempts, resets context and stops after the second failure", async () => {
  for (const succeeds of [true, false]) {
    const attempts: DoctorReadAttempt[] = [];
    let reads = 0,
      resets = 0;
    const result = runDoctorRead({
      attempts,
      read: async () => {
        reads++;
        if (reads === 1 || !succeeds) throw new InventoryError("inventory_changed", "changed");
        return 42;
      },
      admitRetry: () => true,
      reset: () => {
        resets++;
      },
    });
    if (succeeds) assert.equal(await result, 42);
    else await assert.rejects(result);
    assert.equal(reads, 2);
    assert.equal(resets, 1);
    assert.deepEqual(
      attempts.map((a) => a.outcome),
      ["failed", succeeds ? "passed" : "failed"],
    );
  }
});
void test("missing capacity and nonretryable errors never restart a read", async () => {
  for (const error of [
    new InventoryError("inventory_changed", "changed"),
    new InventoryError("inventory_incomplete", "missing"),
    new GitHubApiError("command_failed", "overflow", {
      cause: Object.assign(new Error("overflow"), { code: "ENOBUFS" }),
    }),
    new GitHubApiError("rate_limited", "limited", { status: 503 }),
  ]) {
    let reads = 0;
    const attempts: DoctorReadAttempt[] = [];
    await assert.rejects(
      runDoctorRead({
        attempts,
        read: async () => {
          reads++;
          throw error;
        },
        admitRetry: () => false,
        reset: () => assert.fail("unexpected reset"),
      }),
    );
    assert.equal(reads, 1);
  }
  assert.ok(
    retryableInventoryRead(
      new GitHubApiError("command_failed", "timeout", {
        cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      }),
    ),
  );
});
void test("retry admission requires fresh totals, known quota and the existing deadline", async () => {
  for (const remaining of [undefined, 0, 10, 1000]) {
    const reader: InventoryReader = {
      config,
      graphql: () => ({
        repository: { id: "R", nameWithOwner: repository, issues: { totalCount: 900 } },
        node: {
          id: "P",
          items: { totalCount: 900 },
          fields: { totalCount: 22 },
          views: { totalCount: 10 },
        },
        rateLimit: { cost: 1, remaining, resetAt: "2026-10-22T20:00:00Z" },
      }),
    };
    assert.equal(admitDoctorReadRetry(reader, "P", 1000), remaining === 1000);
    await withCoordinatorDeadline(performance.now() + 100, async () => {
      assert.equal(admitDoctorReadRetry(reader, "P", 1000), false);
    });
  }
});
void test("provider query points are distinct from requests and increase admission headroom", () => {
  const budget = new DiscoveryBudget("ordinary");
  budget.observeGraphqlCost(15);
  budget.observeGraphqlCost(undefined);
  assert.equal(budget.usage.requests, 0);
  assert.equal(budget.usage.graphql_points_observed, 15);
  assert.equal(budget.usage.graphql_cost_unknown_requests, 1);
  budget.reserveDelivery(2, 0);
  budget.observeProvider({
    resource: "graphql",
    remaining: 35,
    resetAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.throws(() => budget.requireProviderCapacity(1), /capacity unknown|reserve/);
  assert.equal(budget.graphqlPointHeadroom, 15);
});

void test("failed HTTP responses retain backoff, request identity and received byte evidence", () => {
  const body = JSON.stringify({ message: "temporarily unavailable" });
  const api = new GitHubApiClient(
    createGitHubRunner({
      spawn: () => ({
        status: 1,
        stderr: "HTTP 503",
        stdout: `HTTP/2 503\nretry-after: 60\nx-github-request-id: failed-request\nx-ratelimit-remaining: 1000\n\n${body}`,
      }),
    }),
  );
  assert.throws(
    () => api.graphql("query { viewer { id } }"),
    (error) =>
      error instanceof GitHubApiError &&
      error.retryAfter === "60" &&
      !retryableInventoryRead(error),
  );
  assert.equal(api.observations[0]?.request_id, "failed-request");
  assert.equal(api.observations[0]?.bytes, Buffer.byteLength(body));
});
void test("retry admission refuses expired quota and query costs above original headroom", () => {
  let resetAt = new Date(Date.now() + 60000).toISOString();
  const reader: InventoryReader = {
    config,
    graphql: () => ({
      repository: { id: "R", nameWithOwner: repository, issues: { totalCount: 900 } },
      node: {
        id: "P",
        items: { totalCount: 900 },
        fields: { totalCount: 22 },
        views: { totalCount: 10 },
      },
      rateLimit: { cost: 1, remaining: 500, resetAt },
    }),
  };
  assert.equal(admitDoctorReadRetry(reader, "P", 1), true);
  assert.equal(admitDoctorReadRetry(reader, "P", 1, 30), false);
  resetAt = "2000-01-01T00:00:00Z";
  assert.equal(admitDoctorReadRetry(reader, "P", 1), false);
});
void test("response byte observations preserve whitespace and Unicode rather than reserializing JSON", () => {
  const body = '  { "data" : { "name" : "雪" } }\n';
  const api = new GitHubApiClient(
    createGitHubRunner({
      spawn: () => ({ status: 0, stderr: "", stdout: "HTTP/2 200\n\n" + body }),
    }),
  );
  api.graphql("query { viewer { id } }");
  assert.equal(api.observations[0]?.bytes, Buffer.byteLength(body));
});

void test("failed bounded GraphQL workers conservatively retain unknown point costs", () => {
  const budget = new DiscoveryBudget("ordinary");
  const transport = createDiscoveryTransport(
    budget,
    "fixture-token",
    new URL("./nonexistent-inert-worker.mts", import.meta.url).pathname,
  );
  assert.throws(
    () =>
      transport.runner(
        ["api", "graphql", "--include", "--input", "-"],
        '{"query":"query{viewer{id}}"}',
      ),
    /Bounded HTTP worker failed/,
  );
  assert.equal(budget.usage.requests, 5);
  assert.equal(budget.usage.graphql_cost_unknown_requests, 5);
});
