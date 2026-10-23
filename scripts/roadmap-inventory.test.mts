import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RoadmapClient, validateConfig, renderPortIssueBody } from "./roadmap.mts";
import {
  collectRoadmapInventory,
  requireRoadmapInventory,
  invalidateRoadmapInventory,
} from "./roadmap-inventory.mts";
import type { RoadmapIssueItem } from "./roadmap.mts";
import type { InventoryCache } from "./roadmap-inventory.mts";
import { GitHubApiClient } from "./github-api.mts";
import { GitHubApiError } from "./github-api.mts";
import { observationHash } from "./upstream-observer.mts";
import { DiscoveryBudget } from "./discovery-budget.mts";
import { readDiscoveryCache } from "./discovery-cache.mts";
import {
  discoveryDeliveryCost,
  discoveryInventoryCost,
  DiscoverySession,
} from "./daily-discovery-session.mts";
const config = validateConfig(
  JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
function fixture(count = 2, bodySize = 32) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `I${i}`,
    number: i + 1,
    title: `Issue ${i}`,
    url: `https://github.com/${config.repository}/issues/${i + 1}`,
    state: "OPEN",
    updatedAt: "2026-10-17T00:00:00Z",
    body: "x".repeat(bodySize),
  }));
  const client = new RoadmapClient(
    config,
    new GitHubApiClient(() => {
      throw new Error("Unexpected transport");
    }),
  );
  let bodyReads = 0,
    marker = 0,
    bytes = 0,
    requests = 0;
  let alterPage: (value: unknown) => unknown = (v) => v;
  let mutateMarker = false;
  const project: RoadmapIssueItem[] = rows.map((r, i) => ({
    id: `P${i}`,
    isArchived: i === 1,
    content: { ...r, body: undefined },
    fieldValues: [],
  }));
  client.completeProjectContext = () => ({
    number: config.project.number,
    details: {
      id: "PROJECT",
      number: config.project.number,
      title: config.project.title,
      url: "https://github.com/users/boburning/projects/1",
      public: true,
    },
    fields: [],
  });
  client.itemList = (_number, options) => {
    assert.equal(options?.includeArchived, true);
    assert.equal(options?.includeBodies, false);
    assert.equal(options?.includeDependencies, true);
    requests += Math.ceil(project.length / 100);
    bytes += Buffer.byteLength(JSON.stringify(project));
    return structuredClone(project);
  };
  client.graphql = (query, vars) => {
    assert.ok(vars);
    let value: unknown;
    if (query.includes("projectRevision"))
      value = {
        projectRevision: {
          id: "PROJECT",
          updatedAt: "2026-10-17T00:00:00Z",
          items: { totalCount: project.length },
        },
      };
    else if (query.includes("RepositoryIssueMarker")) {
      value = {
        repository: {
          id: "REPO",
          nameWithOwner: config.repository,
          issues: {
            totalCount: rows.length,
            nodes: rows.slice(-1).map(({ id, number }) => ({ id, number })),
          },
        },
      };
    } else if (query.includes("UPDATED_AT")) {
      marker++;
      value = {
        repository: {
          id: "REPO",
          nameWithOwner: config.repository,
          issues: {
            totalCount: rows.length,
            nodes: rows
              .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .slice(0, 1)
              .map(({ id, updatedAt }) => ({
                id,
                updatedAt: mutateMarker && marker > 1 ? `changed-${marker}` : updatedAt,
              })),
          },
        },
      };
    } else if (query.includes("CREATED_AT")) {
      const after = vars.after === null ? 0 : Number(vars.after);
      const nodes = rows.slice(after, after + 100).map(({ body: _body, ...r }) => r);
      value = alterPage({
        repository: {
          id: "REPO",
          nameWithOwner: config.repository,
          issues: {
            nodes,
            totalCount: rows.length,
            pageInfo: { hasNextPage: after + 100 < rows.length, endCursor: String(after + 100) },
          },
        },
      });
    } else if (query.includes("nodes(ids:")) {
      assert.ok(Array.isArray(vars.ids));
      bodyReads += vars.ids.length;
      value = {
        nodes: vars.ids.map((id) => ({ __typename: "Issue", ...rows.find((r) => r.id === id) })),
      };
    } else throw new Error("Unexpected inventory query");
    requests++;
    bytes += Buffer.byteLength(JSON.stringify(value));
    return structuredClone(value);
  };
  return {
    client,
    rows,
    project,
    stats: () => ({ bodyReads, bytes, requests }),
    alter: (f: typeof alterPage) => {
      alterPage = f;
    },
    race: () => {
      mutateMarker = true;
    },
  };
}
void test("cold inventory hydrates once, joins by opaque identity, and keeps archive scope separate", () => {
  const f = fixture();
  const got = collectRoadmapInventory(f.client);
  assert.equal(got.issues.length, 2);
  assert.equal(got.items.length, 1);
  assert.equal(got.archivedItems.length, 1);
  assert.equal(got.body_reads, 2);
  assert.equal(got.items[0]?.content?.body, f.rows[0]?.body);
  assert.equal(requireRoadmapInventory(got, config.repository, f.client), got);
  assert.throws(
    () => requireRoadmapInventory(structuredClone(got), config.repository),
    /collector-validated/,
  );
  assert.throws(
    () => requireRoadmapInventory(got, config.repository, fixture().client),
    /collector-validated/,
  );
  got.issues[0]!.body = "tampered";
  assert.throws(() => requireRoadmapInventory(got, config.repository), /collector-validated/);
});

void test("validated inventory refuses a self-consistent Project traversal missing independently counted items", () => {
  const f = fixture(2);
  f.client.itemList = () => [];
  assert.throws(() => collectRoadmapInventory(f.client), /Project inventory count mismatch/);
});
async function temporarySession(
  t: test.TestContext,
  cache?: InventoryCache & { baseline_completed_at?: string },
) {
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const state = await mkdtemp(path.join(work, "discovery-fixture-"));
  const run = path.join(state, "runs", "fixture");
  await mkdir(run, { recursive: true });
  if (cache) writeFileSync(path.join(state, "inventory.json"), JSON.stringify(cache));
  t.after(async () => {
    assert.ok(path.resolve(state).startsWith(path.resolve(work) + path.sep));
    await rm(state, { recursive: true, force: true });
  });
  const session = new DiscoverySession(
    state,
    run,
    config,
    "fixture-token",
    new Date().toISOString(),
    "fixture-head",
  );
  session.client.api.request = () => {
    throw new Error("Unexpected fixture API request; live network forbidden");
  };
  return {
    state,
    run,
    session,
  };
}
void test("interrupted state preserves checkpoint work, matching review and the original created issue", async (t) => {
  const { state, run, session } = await temporarySession(t);
  const f = fixture(1);
  f.rows[0]!.id = "I42";
  f.rows[0]!.number = 42;
  f.rows[0]!.url = `https://github.com/${config.repository}/issues/42`;
  const body =
    "<!-- portcove-discovery-intake:fixture -->\n\n" +
    renderPortIssueBody({
      title: "Fixture",
      upstream: "https://github.com/example/fixture",
      portKey: "fixture",
    });
  f.rows[0]!.title = "[Port] Fixture";
  f.rows[0]!.body = body;
  f.project.length = 0;
  session.client.graphql = f.client.graphql;
  session.client.completeProjectContext = f.client.completeProjectContext;
  session.client.itemList = f.client.itemList;
  session.client.repositoryIssue = () => ({
    number: 42,
    node_id: "I42",
    html_url: f.rows[0]!.url,
    title: "[Port] Fixture",
    body,
    state: "open",
  });
  session.client.api.request = () => ({
    body: {
      resources: {
        core: { remaining: 5000, reset: 4070908800 },
        graphql: { remaining: 5000, reset: 4070908800 },
      },
    },
    headers: new Map(),
    rateLimit: { resource: null, limit: null, remaining: null, used: null, resetAt: null },
  });
  session.client.viewList = () => [];
  session.client.projectAudit = () => ({
    id: "PROJECT",
    number: config.project.number,
    title: config.project.title,
    url: "https://github.com/users/boburning/projects/1",
    public: true,
    repositories: { nodes: [] },
  });
  let registered = 0;
  session.client.ensureIssueItem = () => {
    registered++;
    return { id: "P42" };
  };
  session.client.setItemFields = () => {};
  session.journal.evidence.e = {
    repository: "example/fixture",
    material: "evidence",
    file: path.join(run, "evidence.json"),
    requests: 1,
    bytes: 1,
  };
  const evidenceHash = observationHash(["evidence"]);
  const bodyHash = observationHash(body);
  session.journal.candidates.fixture = {
    id: "fixture",
    kind: "intake",
    title: "Fixture",
    upstream: "https://github.com/example/fixture",
    portKey: "fixture",
    body,
    body_sha256: bodyHash,
    evidence_ids: ["e"],
    evidence_sha256: evidenceHash,
    status: "created",
    created_issue: 42,
    review: {
      verdict: "clear",
      model: "gpt-6.1-sol",
      reasoning: "high",
      reviewer: "separate-reviewer",
      body_sha256: bodyHash,
      evidence_sha256: evidenceHash,
    },
  };
  session.checkpoint.checked["42"] = new Date().toISOString();
  session.persist();
  const resumed = new DiscoverySession(
    state,
    run,
    config,
    "fixture-token",
    new Date().toISOString(),
    "fixture-head",
  );
  assert.ok(resumed.checkpoint.checked["42"]);
  assert.equal(resumed.journal.candidates.fixture?.created_issue, 42);
  session.refresh();
  await assert.rejects(session.apply(), /readback|Project drift/);
  assert.equal(registered, 1);
  assert.equal(session.journal.candidates.fixture?.created_issue, 42);
  assert.equal(session.journal.candidates.fixture?.status, "doctor-pending");
  // No issue POST is implemented by the fixture: recovery must use the retained issue.
  const receipt = await session.finish(new Error("fixture final-doctor gap"));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.delivery, "pending");
  assert.equal(receipt.candidates[0]?.issue, 42);
  const journal = JSON.parse(readFileSync(path.join(state, "active-run.json"), "utf8")) as {
    candidates: Record<string, { body: string }>;
  };
  journal.candidates.fixture!.body = "tampered";
  writeFileSync(path.join(state, "active-run.json"), JSON.stringify(journal));
  assert.throws(
    () =>
      new DiscoverySession(
        state,
        run,
        config,
        "fixture-token",
        new Date().toISOString(),
        "fixture-head",
      ),
    /binding is invalid/,
  );
});
void test("delivered candidates make quiet repeats write nothing and review cannot revive them", async (t) => {
  const { session } = await temporarySession(t);
  session.journal.candidates.done = {
    id: "done",
    kind: "comment",
    title: "Fixture",
    upstream: "https://github.com/example/fixture",
    portKey: "fixture",
    body: "done",
    body_sha256: "x",
    evidence_ids: [],
    evidence_sha256: "x",
    status: "delivered",
  };
  assert.deepEqual(await session.apply(), { applied: 0 });
  assert.throws(
    () =>
      session.review({
        candidate_id: "done",
        verdict: "clear",
        model: "gpt-6.1-sol",
        reasoning: "high",
        reviewer: "other",
        body_sha256: "x",
        evidence_sha256: "x",
      }),
    /Separate review/,
  );
});
void test("unchanged finish preserves final inventory guards and records no planning doctor", async (t) => {
  const { session } = await temporarySession(t);
  const f = fixture(1);
  session.client.graphql = f.client.graphql;
  session.client.completeProjectContext = f.client.completeProjectContext;
  session.client.itemList = f.client.itemList;
  session.client.projectAudit = () => assert.fail("Unchanged finish must not run full doctor");
  session.checkProviderCapacity = () => {};
  session.refresh();
  session.journal.collection_done = true;
  let refreshes = 0;
  const refresh = session.refresh.bind(session);
  session.refresh = () => {
    refreshes++;
    return refresh();
  };
  const receipt = await session.finish();
  assert.equal(receipt.status, "completed", JSON.stringify(receipt.notes));
  assert.equal(refreshes, 1, "Final complete inventory guards still execute");
  assert.deepEqual(receipt.doctor, {
    status: "not_run",
    scope: "none",
    head: "fixture-head",
    evidence: path.join(session.runDir, "doctor.json"),
  });
});
void test("charged final recollection fits the scheduled budget and refuses genuine exhaustion", async (t) => {
  for (const priorRequests of [142, 166])
    await t.test(String(priorRequests), async (t) => {
      const f = fixture(891);
      const previous = collectRoadmapInventory(f.client);
      const { session } = await temporarySession(t, {
        ...previous,
        baseline_completed_at: new Date().toISOString(),
      });
      assert.equal(session.budget.usage.profile, "ordinary");
      session.inventory = previous;
      session.inventoryStarted = true;
      session.budget.delivery = true;
      session.budget.charge("GET", "prior collection and delivery", priorRequests, 3500000, "200");
      session.client.completeProjectContext = () => {
        session.budget.admit(2, 2);
        session.budget.charge("POST", "fixture project details and fields", 2, 2, "200");
        return f.client.completeProjectContext();
      };
      session.client.itemList = RoadmapClient.prototype.itemList;
      let traversals = 0;
      session.client.graphql = (query, vars) => {
        session.budget.admit(1, 1);
        let response: ReturnType<typeof f.client.graphql>;
        if (query.includes("items(first:") && !query.includes("projectRevision")) {
          if (vars?.after === null) traversals++;
          const offset = vars?.after === null ? 0 : Number(vars?.after);
          const nodes = f.project.slice(offset, offset + 100).map((item) => ({
            ...item,
            content: { ...item.content, __typename: "Issue" },
            fieldValues: {
              totalCount: 0,
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          }));
          response = {
            node: {
              items: {
                totalCount: traversals === 1 && offset === 100 ? 892 : 891,
                nodes,
                pageInfo: {
                  hasNextPage: offset + 100 < f.project.length,
                  endCursor: String(offset + 100),
                },
              },
            },
          };
        } else response = f.client.graphql(query, vars);
        session.budget.charge(
          "POST",
          "fixture graphql",
          1,
          Buffer.byteLength(JSON.stringify(response)),
          "200",
        );
        return response;
      };
      if (priorRequests === 166) {
        const retained = readFileSync(path.join(session.stateDir, "inventory.json"), "utf8");
        assert.throws(() => session.refresh(), /budget cannot admit/);
        assert.equal(
          traversals,
          1,
          "insufficient capacity must refuse before replacement requests",
        );
        assert.equal(readFileSync(path.join(session.stateDir, "inventory.json"), "utf8"), retained);
        assert.equal(session.inventory, previous);
        assert.match(JSON.stringify(session.journal.notes), /"status":"failed"/);
        return;
      }
      session.refresh();
      assert.equal(traversals, 2);
      assert.equal(session.inventoryRecollections, 1);
      assert.equal(
        requireRoadmapInventory(session.inventory, config.repository, session.client),
        session.inventory,
      );
      assert.equal(session.inventory.items.length + session.inventory.archivedItems.length, 891);
      assert.equal(session.budget.usage.requests, 187);
      assert.equal(
        session.budget.usage.requests,
        session.budget.usage.attempts.reduce((sum, a) => sum + a.requests, 0),
      );
      assert.match(JSON.stringify(session.journal.notes), /"status":"complete"/);
      assert.match(JSON.stringify(session.journal.notes), /"requests_after":160/);
    });
});
void test("one complete recollection replaces Project count drift without joining abandoned pages", async (t) => {
  const { session } = await temporarySession(t);
  const f = fixture(101);
  session.client.completeProjectContext = f.client.completeProjectContext;
  session.client.itemList = RoadmapClient.prototype.itemList;
  let traversals = 0;
  let alwaysDrift = false;
  session.client.graphql = (query, vars) => {
    if (query.includes("items(first:") && !query.includes("projectRevision")) {
      if (vars?.after === null) traversals++;
      const offset = vars?.after === null ? 0 : 100;
      const drift = (traversals === 1 || alwaysDrift) && offset === 100;
      const nodes = f.project.slice(offset, offset + 100).map((item) => ({
        ...item,
        content: { ...item.content, __typename: "Issue" },
        fieldValues: {
          totalCount: 0,
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }));
      return {
        node: {
          items: {
            totalCount: drift ? 102 : 101,
            nodes,
            pageInfo: { hasNextPage: offset === 0, endCursor: offset === 0 ? "page2" : null },
          },
        },
      };
    }
    return f.client.graphql(query, vars);
  };
  session.refresh();
  assert.equal(traversals, 2);
  assert.equal(session.inventoryRecollections, 1);
  assert.equal(session.inventory.issues.length, 101);
  assert.equal(session.inventory.items.length + session.inventory.archivedItems.length, 101);
  assert.equal(
    requireRoadmapInventory(session.inventory, config.repository, session.client),
    session.inventory,
  );
  assert.match(JSON.stringify(session.journal.notes), /total 101 -> 102/);
  alwaysDrift = true;
  assert.throws(() => session.refresh(), /inventory changed during pagination/);
  assert.equal(traversals, 3, "successful recollection must not reset the session allowance");
});
void test("transport denials never consume semantic recollection allowance", async (t) => {
  const { session } = await temporarySession(t);
  let calls = 0;
  session.client.graphql = () => {
    calls++;
    throw new GitHubApiError("http_error", "denied", { status: 403 });
  };
  assert.throws(() => session.refresh(), /denied/);
  assert.equal(calls, 1);
  assert.equal(session.inventoryRecollections, 0);
});
void test("failed recollection retains both observations without publishing a cache", async (t) => {
  const { session, state } = await temporarySession(t);
  let calls = 0;
  session.client.graphql = () => {
    calls++;
    throw new GitHubApiError("inventory_changed", `count drift attempt ${calls}`, {
      operation: "readInventory",
    });
  };
  assert.throws(() => session.refresh(), /count drift attempt 2/);
  assert.equal(calls, 2);
  assert.equal(session.inventoryRecollections, 1);
  assert.equal(session.inventoryStarted, false);
  assert.equal(existsSync(path.join(state, "inventory.json")), false);
  const retained = JSON.stringify(session.journal.notes);
  assert.match(retained, /count drift attempt 1/);
  assert.match(retained, /count drift attempt 2/);
  assert.match(retained, /"status":"failed"/);
});
void test("unclassified integrity failures never trigger semantic recollection", async (t) => {
  const { session } = await temporarySession(t);
  let calls = 0;
  session.client.graphql = () => {
    calls++;
    throw new Error("Duplicate opaque identity in inventory");
  };
  assert.throws(() => session.refresh(), /Duplicate opaque identity/);
  assert.equal(calls, 1);
  assert.equal(session.inventoryRecollections, 0);
});
void test("delivery provider preflight refuses before evidence refresh or any mutation", async (t) => {
  const { session } = await temporarySession(t);
  session.inventory = collectRoadmapInventory(fixture(1).client);
  session.journal.candidates.waiting = {
    id: "waiting",
    kind: "comment",
    title: "Fixture",
    upstream: "https://github.com/example/fixture",
    portKey: "fixture",
    issue: 42,
    body: "facts",
    body_sha256: observationHash("facts"),
    evidence_ids: [],
    evidence_sha256: observationHash([]),
    status: "reviewed",
  };
  let probes = 0;
  session.client.api.request = (method, endpoint) => {
    assert.equal(method, "GET");
    assert.equal(endpoint, "rate_limit");
    probes++;
    return {
      body: {
        resources: {
          core: { remaining: 5000, reset: 4070908800 },
          graphql: { remaining: 0, reset: 4070908800 },
        },
      },
      headers: new Map(),
      rateLimit: { resource: null, limit: null, remaining: null, used: null, resetAt: null },
    };
  };
  await assert.rejects(session.apply(), /graphql quota.*2099/);
  assert.equal(probes, 1);
  assert.equal(session.journal.candidates.waiting?.status, "reviewed");
  assert.equal(session.budget.delivery, false);
  assert.equal(session.wrote, false);
});
void test("malformed inventory JSON selects cold rebuild and retains the original corrupt bytes", async (t) => {
  const { state, run } = await temporarySession(t);
  const file = path.join(state, "inventory.json");
  writeFileSync(file, '{"truncated":');
  assert.equal(readDiscoveryCache(file), undefined);
  assert.equal(readFileSync(file, "utf8"), '{"truncated":');
  const rebuilt = new DiscoverySession(
    state,
    run,
    config,
    "fixture-token",
    new Date().toISOString(),
    "fixture-head",
  );
  assert.equal(rebuilt.budget.usage.profile, "cold");
  assert.equal(rebuilt.inventoryCache, undefined);
  const saved = readdirSync(run).find((name) => name.startsWith("invalid-inventory-"));
  assert.ok(saved);
  assert.equal(readFileSync(path.join(run, saved), "utf8"), readFileSync(file, "utf8"));
});
void test("material proposal identity ignores wording and invalid replacements preserve held drafts", async (t) => {
  const { session, run } = await temporarySession(t);
  session.inventory = collectRoadmapInventory(fixture(1).client);
  session.journal.evidence.one = {
    repository: "example/fixture",
    material: "one",
    file: path.join(run, "one.json"),
    requests: 1,
    bytes: 1,
  };
  const input = {
    kind: "comment",
    issue: 42,
    title: "Fixture",
    portKey: "fixture",
    upstream: "https://github.com/example/fixture",
    body: "Material facts",
    evidence_ids: ["one"],
  };
  const first = session.propose(input);
  assert.equal(session.propose({ ...input, body: "Same facts, different wording" }).id, first.id);
  assert.equal(Object.keys(session.journal.candidates).length, 1);
  session.hold({
    candidate_id: first.id,
    reason: "Identity unresolved",
    resume: "Exact provider identity confirmed",
  });
  session.journal.evidence.two = {
    repository: "example/fixture",
    material: "two",
    file: path.join(run, "two.json"),
    requests: 1,
    bytes: 1,
  };
  assert.throws(
    () => session.propose({ ...input, title: null, evidence_ids: ["two"] }),
    /Missing discovery message text/,
  );
  assert.equal(session.journal.candidates[first.id]?.status, "held");
  session.budget.usage.requests = session.budget.limits.requests;
  assert.throws(() => session.propose({ ...input, evidence_ids: ["two"] }), /budget/);
  assert.equal(session.journal.candidates[first.id]?.status, "held");
  assert.equal(Object.keys(session.journal.candidates).length, 1);
});
void test("quiet rotation yields a continuation at its reserved floor and cannot exceed fifty across commands", async (t) => {
  const { session } = await temporarySession(t);
  const f = fixture(60);
  for (const row of f.rows) {
    row.title = "[Port] Fixture " + row.number;
    row.body = renderPortIssueBody({
      title: "Fixture " + row.number,
      upstream: "https://github.com/example/fixture-" + row.number,
      portKey: "fixture-" + row.number,
    });
    Object.assign(f.project[row.number - 1]!.content!, row, { body: undefined });
  }
  session.inventory = collectRoadmapInventory(f.client);
  session.budget.reserveDelivery(session.budget.limits.requests, 0);
  const deferred = session.recheck();
  assert.deepEqual(deferred.checked, []);
  assert.equal(session.quietAttempts, 0);
  assert.equal(session.journal.coverage, "partial");
  assert.ok(session.journal.notes.length);
  session.budget.reserve = { requests: 0, bytes: 0 };
  session.client.api.request = () => ({
    body: { id: 1, full_name: "example/fixture", archived: false },
    headers: new Map(),
    rateLimit: { resource: null, limit: null, remaining: null, used: null, resetAt: null },
  });
  const first = session.recheck();
  assert.equal(first.checked.length, 50);
  assert.equal(session.quietAttempts, 50);
  assert.deepEqual(session.recheck().checked, []);
  session.deepInvestigations = 12;
  assert.throws(() => session.research("example/fixture"), /Deep investigation limit/);
});
void test("warm inventory fetches changed bodies only and rejects corrupt cached body hashes", () => {
  const f = fixture();
  const first = collectRoadmapInventory(f.client);
  const second = collectRoadmapInventory(f.client, first);
  assert.equal(second.body_reads, 0);
  f.rows[0]!.updatedAt = "2026-10-17T01:00:00Z";
  f.project[0]!.content!.updatedAt = f.rows[0]!.updatedAt;
  const changed = collectRoadmapInventory(f.client, second);
  assert.equal(changed.body_reads, 1);
  changed.issues[1]!.body_sha256 = "bad";
  assert.equal(collectRoadmapInventory(f.client, changed).body_reads, 1);
  invalidateRoadmapInventory(second);
  assert.throws(() => requireRoadmapInventory(second, config.repository), /collector-validated/);
});
void test("one hydration revision change reconciles the whole issue before fresh Project join", () => {
  const f = fixture();
  const graphql = f.client.graphql.bind(f.client);
  let changed = false;
  f.client.graphql = (query, vars) => {
    if (query.includes("nodes(ids:") && !changed) {
      changed = true;
      Object.assign(f.rows[0]!, {
        updatedAt: "2026-10-17T02:00:00Z",
        title: "New title",
        state: "CLOSED",
        body: "new body",
      });
      Object.assign(f.project[0]!.content!, f.rows[0], { body: undefined });
    }
    return graphql(query, vars);
  };
  const got = collectRoadmapInventory(f.client);
  assert.equal(got.issues[0]?.title, "New title");
  assert.equal(got.issues[0]?.state, "CLOSED");
  assert.equal(got.issues[0]?.body, "new body");
  assert.equal(got.items[0]?.content?.body, "new body");
  assert.equal(requireRoadmapInventory(got, config.repository, f.client), got);
});

void test("a comment edit during the Project window discards that entire view and rehydrates only its changed issue", () => {
  for (const timing of ["items", "project-after", "hydration"] as const) {
    const f = fixture(101);
    const warm = collectRoadmapInventory(f.client);
    const graphql = f.client.graphql.bind(f.client);
    const items = f.client.itemList.bind(f.client);
    let traversals = 0,
      projectMarkers = 0,
      moved = false;
    const edit = () => {
      moved = true;
      f.rows[0]!.updatedAt = "2026-10-17T03:00:00Z";
      f.project[0]!.content!.updatedAt = f.rows[0]!.updatedAt;
      f.project[0]!.fieldValues = [{ name: "fresh second view" }];
    };
    f.client.itemList = (number, options) => {
      traversals++;
      const result = items(number, options);
      if (timing === "items" && !moved) edit();
      return result;
    };
    f.client.graphql = (query, vars) => {
      const result = graphql(query, vars);
      if (timing === "project-after" && query.includes("projectRevision") && ++projectMarkers === 2)
        edit();
      if (timing === "hydration" && query.includes("UPDATED_AT") && !moved && traversals === 0) {
        // The first marker is the preimage; move on the post-hydration marker.
        if (++projectMarkers === 2) edit();
      }
      return result;
    };
    const got = collectRoadmapInventory(f.client, warm);
    assert.equal(traversals, 2, timing);
    assert.equal(got.body_reads, 1, timing);
    assert.equal(got.items[0]?.content?.updatedAt, f.rows[0]!.updatedAt);
    assert.equal(got.items[0]?.content?.body, warm.issues[0]?.body);
    assert.deepEqual(got.items[0]?.fieldValues, [{ name: "fresh second view" }]);
    assert.equal(requireRoadmapInventory(got, config.repository, f.client), got);
  }
});

void test("same-second semantic changes force fresh bodies and fresh Project metadata", () => {
  const f = fixture();
  const previous = collectRoadmapInventory(f.client);
  const items = f.client.itemList.bind(f.client);
  let reads = 0;
  f.client.itemList = (number, options) => {
    if (++reads === 1) {
      Object.assign(f.rows[0]!, { title: "Renamed", state: "CLOSED", body: "new canonical key" });
      Object.assign(f.project[0]!.content!, f.rows[0], { body: undefined });
    }
    return items(number, options);
  };
  const got = collectRoadmapInventory(f.client, previous);
  assert.equal(reads, 2);
  assert.equal(got.body_reads, 1);
  assert.equal(got.issues[0]?.body, "new canonical key");
  assert.equal(got.items[0]?.content?.title, "Renamed");
  assert.equal(got.items[0]?.content?.state, "CLOSED");
});

void test("a cache observed in the revision's second cannot hide another body edit", () => {
  const f = fixture(1);
  const previous = collectRoadmapInventory(f.client);
  const cache = { ...previous, observed_at: f.rows[0]!.updatedAt };
  f.rows[0]!.body = "a later edit in the same timestamp second";
  const got = collectRoadmapInventory(f.client, cache);
  assert.equal(got.body_reads, 1);
  assert.equal(got.issues[0]?.body, f.rows[0]!.body);
});

void test("foreign issue comment drift is reconciled only once with a fresh whole Project view", () => {
  for (const alwaysMove of [false, true]) {
    const f = fixture(1);
    const foreign = {
      ...f.rows[0]!,
      type: "Issue",
      id: "FOREIGN",
      number: 7,
      url: "https://github.com/other/repo/issues/7",
    };
    f.project.push({
      id: "PF",
      isArchived: false,
      content: { ...foreign, body: undefined },
      fieldValues: [],
    });
    const graphql = f.client.graphql.bind(f.client);
    const items = f.client.itemList.bind(f.client);
    let reads = 0,
      hydrations = 0;
    f.client.itemList = (number, options) => {
      reads++;
      f.project[1]!.content!.updatedAt = foreign.updatedAt;
      return items(number, options);
    };
    f.client.graphql = (query, vars) => {
      if (
        query.includes("nodes(ids:") &&
        Array.isArray(vars?.ids) &&
        vars.ids.includes("FOREIGN")
      ) {
        if (++hydrations === 1 || alwaysMove)
          foreign.updatedAt = `2026-10-17T0${hydrations}:00:00Z`;
        return { nodes: [{ __typename: "Issue", ...foreign }] };
      }
      return graphql(query, vars);
    };
    if (alwaysMove)
      assert.throws(() => collectRoadmapInventory(f.client), /changed during body hydration/);
    else {
      const got = collectRoadmapInventory(f.client);
      assert.equal(reads, 2);
      assert.equal(got.items.at(-1)?.content?.updatedAt, foreign.updatedAt);
    }
  }
});

void test("comment recovery is charged under 200 requests and a failed replacement preserves the last complete cache", async (t) => {
  for (const prior of [140, 160])
    await t.test(String(prior), async (t) => {
      const f = fixture(891);
      const previous = collectRoadmapInventory(f.client);
      const { session, state } = await temporarySession(t, {
        ...previous,
        baseline_completed_at: new Date().toISOString(),
      });
      session.inventory = previous;
      session.inventoryStarted = true;
      session.budget.delivery = true;
      session.budget.charge("GET", "prior collection", prior, 3500000, "200");
      const retained = readFileSync(path.join(state, "inventory.json"), "utf8");
      session.client.graphql = (query, vars) => {
        session.budget.admit(1, 1);
        const result = f.client.graphql(query, vars);
        session.budget.charge(
          "POST",
          "fixture GraphQL",
          1,
          Buffer.byteLength(JSON.stringify(result)),
          "200",
        );
        return result;
      };
      session.client.completeProjectContext = f.client.completeProjectContext;
      let reads = 0;
      session.client.itemList = (number, options) => {
        const pages = Math.ceil(f.project.length / 100);
        session.budget.admit(pages, 1);
        const result = f.client.itemList(number, options);
        session.budget.charge(
          "POST",
          "fixture Project pages",
          pages,
          Buffer.byteLength(JSON.stringify(result)),
          "200",
        );
        if (++reads === 1) {
          f.rows[0]!.updatedAt = "2026-10-17T03:00:00Z";
          f.project[0]!.content!.updatedAt = f.rows[0]!.updatedAt;
        }
        return result;
      };
      if (prior === 160) {
        assert.throws(() => session.refresh(), /budget cannot admit/);
        assert.equal(reads, 1, "first Project view completed and replacement metadata was charged");
        assert.ok(
          session.budget.usage.requests > 190,
          "refusal must occur within replacement, not the first view",
        );
        assert.equal(session.inventory, previous);
        assert.equal(readFileSync(path.join(state, "inventory.json"), "utf8"), retained);
      } else {
        session.refresh();
        assert.equal(reads, 2);
        assert.equal(session.inventory.body_reads, 1);
        assert.ok(session.budget.usage.requests > prior + 40);
        assert.ok(session.budget.usage.requests <= 200);
        assert.equal(
          session.inventoryRecollections,
          0,
          "semantic reconciliation must not nest session recovery",
        );
      }
      assert.equal(session.budget.limits.requests, 200);
      assert.equal(
        session.budget.usage.requests,
        session.budget.usage.attempts.reduce((sum, a) => sum + a.requests, 0),
      );
      assert.equal(session.wrote, false);
    });
});

void test("stable drafts and merged PRs retain their kind-specific fields through bounded hydration", () => {
  for (const kind of ["DraftIssue", "PullRequest"] as const)
    for (const changes of [0, 1, 2]) {
      const f = fixture(1);
      const foreign: RoadmapIssueItem = {
        id: "FOREIGN",
        type: kind,
        title: "Foreign content",
        body: "body",
        updatedAt: "2026-10-17T00:00:00Z",
        ...(kind === "PullRequest"
          ? {
              number: 7,
              url: "https://github.com/other/repo/pull/7",
              state: "MERGED",
              merged: true,
            }
          : {}),
      };
      f.project.push({
        id: "PF",
        isArchived: false,
        content: { ...foreign, body: undefined },
        fieldValues: [],
      });
      const graphql = f.client.graphql.bind(f.client);
      const items = f.client.itemList.bind(f.client);
      let reads = 0,
        hydrations = 0;
      f.client.itemList = (number, options) => {
        reads++;
        f.project[1]!.content!.updatedAt = foreign.updatedAt;
        return items(number, options);
      };
      f.client.graphql = (query, vars) => {
        if (
          query.includes("nodes(ids:") &&
          Array.isArray(vars?.ids) &&
          vars.ids.includes("FOREIGN")
        ) {
          if (++hydrations <= changes) foreign.updatedAt = `2026-10-17T0${hydrations}:00:00Z`;
          return { nodes: [{ __typename: kind, ...foreign }] };
        }
        return graphql(query, vars);
      };
      if (changes === 2)
        assert.throws(() => collectRoadmapInventory(f.client), /changed during body hydration/);
      else {
        const got = collectRoadmapInventory(f.client);
        assert.equal(reads, changes + 1);
        assert.equal(got.items.at(-1)?.content?.type, kind);
        assert.equal(got.items.at(-1)?.content?.body, "body");
        if (kind === "PullRequest") {
          assert.equal(got.items.at(-1)?.content?.state, "MERGED");
          assert.equal(got.items.at(-1)?.content?.merged, true);
        }
      }
    }
});

void test("a second comment change in the replacement Project read refuses the entire observation", () => {
  const f = fixture();
  const warm = collectRoadmapInventory(f.client);
  const items = f.client.itemList.bind(f.client);
  let reads = 0;
  f.client.itemList = (number, options) => {
    const result = items(number, options);
    f.rows[0]!.updatedAt = `2026-10-17T0${++reads}:00:00Z`;
    f.project[0]!.content!.updatedAt = f.rows[0]!.updatedAt;
    return result;
  };
  assert.throws(() => collectRoadmapInventory(f.client, warm), /Repository changed during/);
  assert.equal(reads, 2);
});

void test("inventory estimates include terminal pages, foreign hydration batches and expanded dependencies", () => {
  const empty = collectRoadmapInventory(fixture(0).client);
  assert.equal(discoveryInventoryCost(empty).requests, 11);
  const inventory = collectRoadmapInventory(fixture(1).client);
  const base = discoveryInventoryCost(inventory);
  const foreign = Array.from({ length: 11 }, (_, index) => ({
    id: `PF${index}`,
    isArchived: false,
    content: {
      id: `IF${index}`,
      body: "foreign".repeat(2000),
      blockedBy: { totalCount: 101, nodes: [] },
    },
  }));
  inventory.items.push(...foreign);
  const expanded = discoveryInventoryCost(inventory);
  assert.equal(expanded.requests - base.requests, 2 + 11 * 2);
  assert.ok(expanded.bytes - base.bytes >= 11 * 14000);
});

void test("same-timestamp Project title disagreement cannot reuse an old body or consume unlimited reconciliation", () => {
  const f = fixture();
  const warm = collectRoadmapInventory(f.client);
  const items = f.client.itemList.bind(f.client);
  let reads = 0;
  f.client.itemList = (number, options) => {
    reads++;
    const result = items(number, options);
    result[0]!.content!.title = "unconfirmed Project title";
    return result;
  };
  assert.throws(() => collectRoadmapInventory(f.client, warm), /revision mismatch/);
  assert.equal(reads, 2);
});
void test("hydration identity mismatch remains fatal and identifies the affected issue", () => {
  const f = fixture();
  const graphql = f.client.graphql.bind(f.client);
  f.client.graphql = (query, vars) => {
    const data = graphql(query, vars);
    if (query.includes("nodes(ids:")) {
      const value = data as { nodes: { url: string }[] };
      value.nodes[0]!.url = "https://github.com/foreign/repo/issues/1";
    }
    return data;
  };
  assert.throws(() => collectRoadmapInventory(f.client), /identity.*#1/);
});
void test("reconciliation never inherits a changed repository provider identity or name", () => {
  for (const replacement of [{ id: "OTHER" }, { nameWithOwner: "foreign/repository" }]) {
    const f = fixture();
    const graphql = f.client.graphql.bind(f.client);
    let markers = 0;
    f.client.graphql = (query, vars) => {
      const data = graphql(query, vars);
      if (query.includes("UPDATED_AT") && ++markers > 1)
        Object.assign((data as { repository: Record<string, unknown> }).repository, replacement);
      return data;
    };
    assert.throws(() => collectRoadmapInventory(f.client), /provider identity changed/);
  }
});
void test("incomplete, duplicate, racing and redacted observations never become valid inventories", () => {
  const malformed = fixture();
  malformed.alter(() => ({
    repository: {
      id: "REPO",
      nameWithOwner: config.repository,
      issues: { nodes: [], totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null } },
    },
  }));
  assert.throws(
    () => collectRoadmapInventory(malformed.client),
    /record count does not match total/,
  );
  const duplicate = fixture();
  duplicate.rows[1]!.id = duplicate.rows[0]!.id;
  assert.throws(() => collectRoadmapInventory(duplicate.client), /duplicate record identity/);
  const cursor = fixture(101);
  cursor.alter((v) => {
    const value = v as { repository: { issues: { pageInfo: { endCursor: null } } } };
    value.repository.issues.pageInfo.endCursor = null;
    return value;
  });
  assert.throws(() => collectRoadmapInventory(cursor.client), /pagination/);
  const race = fixture();
  race.race();
  assert.throws(() => collectRoadmapInventory(race.client), /changed during/);
  const missing = fixture();
  missing.project[0]!.content = null;
  assert.throws(() => collectRoadmapInventory(missing.client), /Redacted/);
  const revision = fixture();
  revision.project[0]!.content!.updatedAt = "other";
  assert.throws(() => collectRoadmapInventory(revision.client), /revision mismatch/);
  const archive = fixture();
  delete archive.project[0]!.isArchived;
  assert.throws(() => collectRoadmapInventory(archive.client), /archive scope/);
});
void test("1000 issue, 16 MiB corpus fits cold and warm two-candidate delivery reservations", () => {
  const f = fixture(1000, 16 * 1024);
  const cold = collectRoadmapInventory(f.client);
  const coldUsage = f.stats();
  assert.ok(coldUsage.bytes < 64 * 1024 * 1024);
  assert.ok(coldUsage.requests < 300);
  const before = f.stats();
  const warm = collectRoadmapInventory(f.client, cold);
  const delta = {
    requests: f.stats().requests - before.requests,
    bytes: f.stats().bytes - before.bytes,
  };
  assert.equal(warm.body_reads, 0);
  assert.ok(delta.bytes < 2 * 1024 * 1024);
  const cost = discoveryDeliveryCost(warm, [
    { body: "candidate".repeat(1000), requests: 7, bytes: 128 * 1024 },
    { body: "candidate".repeat(1000), requests: 7, bytes: 128 * 1024 },
  ]);
  const ordinary = new DiscoveryBudget("ordinary");
  ordinary.charge("GET", "fixture warm inventory", delta.requests, delta.bytes, "200");
  ordinary.reserveDelivery(cost.requests, cost.bytes);
  assert.ok(
    ordinary.remaining().requests >= 20,
    JSON.stringify({ remaining: ordinary.remaining(), delta, cost }),
  );
  assert.ok(ordinary.remaining().bytes > 10 * 1024 * 1024);
  assert.deepEqual(
    cold.issues.map((i) => i.body),
    warm.issues.map((i) => i.body),
  );
  assert.equal(
    observationHash(cold.issues.map((i) => i.body)),
    observationHash(warm.issues.map((i) => i.body)),
  );
});
