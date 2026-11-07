import assert from "node:assert/strict";
import test from "node:test";
import { DiscoveryBudget } from "./discovery-budget.mts";
import { discoveryGitHubScope } from "./discovery-github.mts";
import { createGitHubClient } from "./github-client.mts";
import { GitHubApiError } from "./github-operation.mts";

void test("discovery SDK requires its explicit credential and charges actual GraphQL evidence", async () => {
  const budget = new DiscoveryBudget("ordinary");
  assert.throws(() => discoveryGitHubScope(budget, ""), /credential/);
  const body = ' { "data": { "value": "雪", "rateLimit": { "cost": 17 } } }\n';
  const client = await createGitHubClient(
    discoveryGitHubScope(budget, "synthetic-discovery-only", {
      fetch: async (_input, init) => {
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "token synthetic-discovery-only",
        );
        return new Response(body, { headers: { "content-type": "application/json" } });
      },
    }),
  );
  await client.request("POST /graphql", { query: "query { value rateLimit { cost } }" });
  assert.equal(budget.usage.requests, 1);
  assert.equal(budget.usage.bytes, Buffer.byteLength(body));
  assert.equal(budget.usage.graphql_points_observed, 17);
  assert.equal(budget.usage.graphql_cost_unknown_requests, 0);
  assert.ok(!JSON.stringify(budget.usage).includes("synthetic-discovery-only"));
});

void test("discovery retries charge dispatched attempts and unknown GraphQL costs separately", async () => {
  const budget = new DiscoveryBudget("ordinary");
  let sends = 0;
  const scope = discoveryGitHubScope(budget, "synthetic-only", {
    fetch: async () => {
      sends++;
      return Response.json({ message: "temporary" }, { status: 503 });
    },
  });
  const client = await createGitHubClient({ ...scope, random: () => 0, sleep: async () => {} });
  await assert.rejects(
    client.request("POST /graphql", {
      query: "query { viewer { id } }",
      request: { portcove: { replay: "pure-query", attempts: 0 } },
    }),
    (error) => error instanceof GitHubApiError,
  );
  assert.equal(sends, 3);
  assert.equal(budget.usage.requests, 3);
  assert.equal(budget.usage.graphql_cost_unknown_requests, 3);
  assert.equal(budget.usage.attempts.length, 3);
});

void test("discovery refreshes each explicit provider through bounded one-shot SDK observations", async () => {
  const budget = new DiscoveryBudget("ordinary");
  const tokens: string[] = [];
  for (const token of ["project-synthetic", "repository-synthetic"]) {
    discoveryGitHubScope(budget, token, {
      fetch: async (input, init) => {
        assert.equal(new URL(input instanceof Request ? input.url : input).pathname, "/rate_limit");
        tokens.push(new Headers(init?.headers).get("authorization") ?? "missing");
        return Response.json({
          resources: Object.fromEntries(
            ["core", "graphql", "search"].map((resource) => [
              resource,
              { remaining: 500, limit: 5000, reset: Math.floor(Date.now() / 1000) + 600 },
            ]),
          ),
        });
      },
    });
  }
  const sources = Object.keys(budget.usage.provider_sources ?? {});
  assert.equal(sources.length, 2);
  for (const source of sources)
    budget.observeProvider(
      { resource: "core", remaining: 0, resetAt: "2000-01-01T00:00:00Z" },
      source,
    );
  await budget.admit(1, 1);
  await budget.requireProviderCapacity(1);
  assert.deepEqual(tokens, ["token project-synthetic", "token repository-synthetic"]);
  assert.equal(budget.usage.requests, 2);
  assert.equal(budget.usage.attempts.length, 2);
  assert.ok((budget.usage.provider_quotas?.core?.remaining ?? 0) >= 499);
});

void test("discovery cancellation after dispatch retains one charged unknown-cost attempt", async () => {
  const budget = new DiscoveryBudget("ordinary");
  const controller = new AbortController();
  const client = await createGitHubClient(
    discoveryGitHubScope(budget, "synthetic-only", {
      signal: controller.signal,
      fetch: async () => {
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      },
    }),
  );
  await assert.rejects(
    client.request("POST /graphql", { query: "query { viewer { id } }" }),
    (error) => error instanceof GitHubApiError && error.code === "cancelled",
  );
  assert.equal(budget.usage.requests, 1);
  assert.equal(budget.usage.graphql_cost_unknown_requests, 1);
});

void test("discovery records provider deferral without waiting beyond the original SDK deadline", async () => {
  const budget = new DiscoveryBudget("ordinary");
  const scope = discoveryGitHubScope(budget, "synthetic-only", {
    fetch: async () =>
      Response.json(
        { message: "secondary rate limit" },
        { status: 429, headers: { "retry-after": "60" } },
      ),
  });
  const client = await createGitHubClient({ ...scope, deadline: performance.now() + 5000 });
  await assert.rejects(
    client.request("GET /rate_limit", {
      request: { portcove: { replay: "safe-read", attempts: 0 } },
    }),
    (error) => error instanceof GitHubApiError && error.code === "rate_limited",
  );
  assert.equal(budget.usage.requests, 1);
  assert.ok(Date.parse(budget.usage.backoff_until ?? "") > Date.now());
});

void test("discovery joins a dispatched quota probe's cancellation and accounting before terminal evidence", async () => {
  const budget = new DiscoveryBudget("ordinary"),
    controller = new AbortController();
  let entered!: () => void, release!: () => void, aborted!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sawAbort = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const scope = discoveryGitHubScope(budget, "synthetic-only", {
    signal: controller.signal,
    fetch: async (input, init) => {
      assert.equal(new URL(input instanceof Request ? input.url : input).pathname, "/rate_limit");
      const signal = init?.signal;
      assert.ok(signal instanceof AbortSignal);
      entered();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      aborted();
      await gate;
      throw new DOMException("Cancelled quota probe", "AbortError");
    },
  });
  budget.observeProvider({ resource: "core", remaining: 0, resetAt: "2000-01-01T00:00:00Z" });
  const client = await createGitHubClient(scope);
  const pending = client.request("GET /repos/owner/repo");
  const cancelled = assert.rejects(
    pending,
    (error) => error instanceof GitHubApiError && error.code === "cancelled",
  );
  await started;
  controller.abort();
  await cancelled;
  await sawAbort;
  let drained = false;
  const cleanup = budget.drain().then((failures) => {
    drained = true;
    return failures;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "a cancelled request still owns its dispatched probe");
  release();
  await cleanup;
  assert.equal(budget.usage.requests, 1);
  assert.equal(budget.usage.attempts.length, 1);
  assert.equal(budget.usage.attempts[0]?.endpoint, "https://api.github.com/rate_limit");
  assert.ok(budget.observations.some((attempt) => attempt.dispatched && attempt.status === null));
});

void test("hosted production composition routes canonical issue writes to the repository role and Project mutations to the Project role", async () => {
  const { connectHostedGitHub } = await import("./hosted-discovery-intake.mts");
  const { config } = await import("./fixtures/roadmap-fixtures.mts");
  const { fixtureIssueInventory } = await import("./repository-issue-inventory.fixture.mts");
  const { portFieldInitialization } = await import("./roadmap.mts");
  const { isRecord } = await import("./runtime-values.mts");
  const events: { method: string; path: string; credential: string | null }[] = [];
  let body = "",
    title = "[Port] Role fixture";
  const issue = () => ({
    id: 42,
    node_id: "I42",
    number: 42,
    title,
    body,
    state: "OPEN",
    html_url: `https://github.com/${config.repository}/issues/42`,
    updated_at: "2026-11-04T00:00:00Z",
  });
  const { client } = await connectHostedGitHub(
    config,
    new DiscoveryBudget("ordinary"),
    {
      project: "project-role-synthetic",
      repository: "repository-role-synthetic",
    },
    {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input),
          method = init?.method ?? "GET";
        events.push({
          method,
          path: url.pathname,
          credential: new Headers(init?.headers).get("authorization"),
        });
        const sent: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        let data: unknown;
        if (url.pathname === "/graphql") data = { data: {} };
        else if (method === "POST" || method === "PATCH") {
          assert.ok(isRecord(sent) && typeof sent.body === "string");
          body = sent.body;
          if (typeof sent.title === "string") title = sent.title;
          data = issue();
        } else {
          assert.equal(url.pathname, `/repos/${config.repository}/issues/42`);
          data = issue();
        }
        return Response.json(data);
      },
    },
  );
  client.repositoryIssues = async () => await fixtureIssueInventory(client, []);
  client.projectContext = async () => ({
    number: config.project.number,
    details: { id: "PVT" },
    fields: config.fields.map((field, index) => ({
      id: `F${index}`,
      name: field.name,
      options: field.options.map((name, option) => ({ id: `O${index}_${option}`, name })),
    })),
  });
  client.ensureIssueItem = async () => ({ id: "PVTI" });
  await client.createPortIssue({
    title: "Role fixture",
    upstream: "https://github.com/example/role-fixture",
    portKey: "role-fixture",
  });
  body =
    "### Direct upstream URL\n\nhttps://github.com/example/role-fixture\n\n### Durable game or target key\n\nrole-fixture\n\n### User outcome and why this port matters\n\nPreserve role routing.";
  client.readInventory = async () => [{ id: "PVTI", project: { id: "PVT" }, isArchived: false }];
  client.directProjectItem = async () => ({
    id: "PVTI",
    content: { id: "I42", number: 42, title, body, state: "OPEN", url: issue().html_url },
    fieldValues: Object.entries(portFieldInitialization(null)).map(([name, value]) => ({
      name: value,
      field: { name },
    })),
  });
  await client.normalizePortIssue({ number: 42, catalog: { ports: [] } });
  assert.ok(events.some((event) => event.method === "PATCH"));
  assert.ok(events.some((event) => event.path === "/graphql"));
  for (const event of events)
    assert.equal(
      event.credential,
      event.path === "/graphql" || event.method === "GET"
        ? "token project-role-synthetic"
        : "token repository-role-synthetic",
    );
});

void test("malformed quota reset metadata cannot skip settlement of a dispatched SDK attempt", async () => {
  for (const status of [200, 403]) {
    const budget = new DiscoveryBudget("ordinary");
    let sends = 0;
    const client = await createGitHubClient(
      discoveryGitHubScope(budget, "synthetic-only", {
        fetch: async () => {
          sends++;
          return Response.json(
            { message: "provider response" },
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
      }),
    );
    const result = client.request("GET /repos/owner/repo");
    if (status === 200) await result;
    else await assert.rejects(result, (error) => error instanceof GitHubApiError);
    assert.equal(sends, 1);
    assert.equal(budget.usage.requests, 1);
    assert.equal(budget.observations.length, 1);
    assert.equal(budget.observations[0]?.rate?.resetAt, null);
    assert.equal(budget.usage.provider_quotas?.core, undefined);
  }
});
