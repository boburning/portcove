import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  HostedIntakeBridge,
  HostedRoadmapClient,
  parseHostedRequest,
  assertHostedEvent,
  hostedRequestMarker,
  hostedBody,
  hostedPlanHash,
  probeHostedProjectWrite,
  assertHostedCatalogIdentity,
} from "./hosted-discovery-intake.mts";
import { RoadmapClient, portFieldInitialization, validateConfig } from "./roadmap.mts";
import { GitHubApiClient, GitHubApiError } from "./github-api.mts";
import { observationHash } from "./upstream-observer.mts";
import { DiscoveryBudget } from "./discovery-budget.mts";
import { discoveryInventoryCost } from "./daily-discovery-session.mts";
import {
  collectRoadmapInventory,
  requireRoadmapInventory,
  invalidateRoadmapInventory,
} from "./roadmap-inventory.mts";

const config = validateConfig(
  JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
const candidate = {
  title: "Example native game",
  upstream: "https://github.com/example/native-game",
  repository_id: 987654321,
  game: "Example game",
  port_key: "example-native-game",
  evidence:
    "Primary upstream reports a source-only native implementation; host/gameplay evidence remains Unknown.",
  resume: "Revisit after a distributable upstream package and exact input/host evidence.",
};
const proposal = {
  schema_version: 1,
  kind: "proposal",
  investigator: "hosted-investigator-context",
  candidates: [candidate],
};
const encode = (data: unknown) =>
  `${hostedRequestMarker}\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;
void test("real Project field writes use the complete API schema without CLI commands", () => {
  let pages = 0;
  const mutations: unknown[] = [];
  const project = {
    id: "PVT_selected",
    number: config.project.number,
    title: config.project.title,
    url: "https://github.com/users/boburning/projects/1",
    public: true,
    closed: false,
  };
  const client = new HostedRoadmapClient(
    config,
    new GitHubApiClient((args, input) => {
      assert.equal(args[0], "api", "the bounded transport must not receive a CLI command");
      assert.equal(args[1], "graphql");
      const request = JSON.parse(input ?? "{}") as {
        query: string;
        variables: Record<string, unknown>;
      };
      let data: Record<string, unknown>;
      if (request.query.startsWith("mutation")) {
        assert.equal(pages, 2, "all schema pages must be read before mutation");
        mutations.push(request.variables);
        data = { f0: { projectV2Item: { id: "PVTI_selected" } } };
      } else if (!request.query.includes("fields(first: 100")) {
        data = { user: { projectV2: project } };
      } else {
        pages++;
        const first = request.variables.after === null;
        assert.equal(request.variables.after, first ? null : "next-field");
        data = {
          user: {
            projectV2: {
              ...project,
              fields: {
                totalCount: 2,
                nodes: first
                  ? [
                      {
                        id: "PVTF_title",
                        name: "Title",
                        __typename: "ProjectV2Field",
                        dataType: "TITLE",
                      },
                    ]
                  : [
                      {
                        id: "PVTSSF_priority",
                        name: "Priority",
                        __typename: "ProjectV2SingleSelectField",
                        dataType: "SINGLE_SELECT",
                        options: [{ id: "none-option", name: "None" }],
                      },
                    ],
                pageInfo: { hasNextPage: first, endCursor: first ? "next-field" : null },
              },
            },
          },
        };
      }
      return `HTTP/2 200 OK\n\n${JSON.stringify({ data })}`;
    }),
  );
  client._ownerType = "User";
  client.setItemFields("PVTI_selected", { Priority: "None" });
  assert.deepEqual(mutations, [
    {
      input0: {
        projectId: "PVT_selected",
        itemId: "PVTI_selected",
        fieldId: "PVTSSF_priority",
        value: { singleSelectOptionId: "none-option" },
      },
    },
  ]);
});
function fixture(candidates = [candidate]) {
  const comments = new Map<
    number,
    { id: number; body: string; user: { login: string }; issue_url: string }
  >();
  const issueUrl = "https://api.github.com/repos/boburning/portcove/issues/177";
  const request = {
    id: 100,
    body: encode({ ...proposal, candidates }),
    user: { login: "boburning" },
    issue_url: issueUrl,
  };
  comments.set(100, request);
  let commentId = 1000,
    creations = 0,
    writes = 0;
  let postFailure = false,
    projectFailure = false,
    denied = false,
    primaryChanged = false;
  const issues: {
    id: string;
    node_id: string;
    number: number;
    body: string;
    title: string;
    state: string;
    url: string;
    html_url: string;
    updatedAt: string;
  }[] = [];
  const fields = { ...portFieldInitialization(null) };
  let normalizations = 0;
  const snapshots: unknown[] = [];
  let lastInventorySnapshot: unknown;
  const client = new RoadmapClient(config);
  client.api.request = (_method, endpoint, body) => {
    const value = body as { body: string };
    if (_method === "GET") {
      const c = comments.get(Number(endpoint.split("/").at(-1)));
      if (!c) throw new Error("Unknown comment read");
      return {
        body: structuredClone(c),
        headers: new Map<string, string>(),
        rateLimit: { resource: null, limit: null, remaining: null, used: null, resetAt: null },
      };
    }
    const id = _method === "POST" ? commentId++ : Number(endpoint.split("/").at(-1));
    const c = { id, body: value.body, user: { login: "github-actions[bot]" }, issue_url: issueUrl };
    comments.set(id, c);
    snapshots.push(JSON.parse(value.body.match(/```json\n([\s\S]+)\n```$/u)![1]!));
    return {
      body: structuredClone(c),
      headers: new Map<string, string>(),
      rateLimit: { resource: null, limit: null, remaining: null, used: null, resetAt: null },
    };
  };
  client.createPortIssue = (input) => {
    if (input.inventory)
      requireRoadmapInventory(input.inventory, config.repository, client, "identity");
    assert.deepEqual(
      lastInventorySnapshot,
      snapshots.at(-1),
      "canonical inventory must follow the last durable receipt write",
    );
    if (input.inventory) invalidateRoadmapInventory(input.inventory);
    creations++;
    assert(
      snapshots.some((v) => JSON.stringify(v).includes("create-attempted")),
      "attempt receipt must precede POST",
    );
    if (postFailure) throw new Error("Transport result unknown");
    const number = Math.max(199, ...issues.map((i) => i.number)) + 1;
    const issue = {
      id: `I${number}`,
      node_id: `I${number}`,
      number,
      body: input.body!,
      title: `[Port] ${input.title}`,
      state: "OPEN",
      url: `https://github.com/boburning/portcove/issues/${number}`,
      html_url: `https://github.com/boburning/portcove/issues/${number}`,
      updatedAt: "2026-10-28T00:00:00Z",
    };
    issues.push(issue);
    input.onIssueCreated?.(issue);
    if (projectFailure) throw new Error("Project mutation interrupted");
    return { ...issue, itemId: `PVTI${number}` };
  };
  client.repositoryIssue = (n) => {
    const i = issues.find((i) => i.number === n);
    if (!i) throw new Error("Missing issue");
    return { ...i, number: n };
  };
  client.normalizePortIssue = ({ number, inventory }) => {
    if (inventory) {
      requireRoadmapInventory(inventory, config.repository, client, { planningIssue: number });
      invalidateRoadmapInventory(inventory);
    }
    normalizations++;
    Object.assign(fields, portFieldInitialization(null));
    return {
      issue: issues.find((i) => i.number === Number(number))!.url,
      bodyChanged: false,
      projectItemAdded: false,
      fieldsChanged: [],
      itemId: `PVTI${number}`,
    };
  };
  client.executionIssue = (number) =>
    ({
      item: {
        id: [177, 3849].includes(number) ? "PVTICANARY" : `PVTI${number}`,
        content: [177, 3849].includes(number)
          ? {
              id: "ICANARY",
              number,
              title: "[Port] Neutral canary",
              state: "OPEN",
              url: `https://github.com/boburning/portcove/issues/${number}`,
              body: hostedBody({ ...candidate, port_key: "neutral-canary" }, 99),
            }
          : { ...issues.find((i) => i.number === number)! },
        ...([177, 3849].includes(number) ? portFieldInitialization(null) : fields),
      },
      relationships: { parent: null, subIssues: [], blockedBy: [], blocking: [] },
    }) as ReturnType<RoadmapClient["executionIssue"]>;
  client.setItemFields = (_id, values) => {
    writes++;
    if (denied) throw new GitHubApiError("http_error", "Project access denied", { status: 403 });
    if (_id !== "PVTICANARY") Object.assign(fields, values);
  };
  const bridge = new HostedIntakeBridge(
    client,
    "a".repeat(40),
    (upstream) => ({
      metadata: {
        id: candidates.find((c) => new URL(c.upstream).pathname.slice(1) === upstream)!
          .repository_id,
        full_name: upstream,
      },
      releases: [],
      selected: [],
      readme: {
        commit: (primaryChanged ? "c" : "b").repeat(40),
        blob: "d".repeat(40),
        text: "Primary evidence",
      },
      fingerprint: "primary-release-fingerprint",
      manifest: undefined,
      manifest_evidence: { commit: "b".repeat(40), status: "unavailable-or-invalid" },
      scope: "Fixture primary evidence",
      observed_at: undefined,
    }),
    () => {},
  );
  client.completeProjectContext = () => ({
    number: config.project.number,
    details: {
      id: "PVT",
      number: config.project.number,
      title: config.project.title,
      url: "https://github.com/users/boburning/projects/1",
      public: true,
    },
    fields: [],
  });
  client.itemList = (_number, options) =>
    issues.map((i) => ({
      id: `PVTI${i.number}`,
      isArchived: false,
      content: { ...i, __typename: "Issue", body: undefined },
      ...(options?.includeFields === false ? {} : fields),
    }));
  client.directProjectItem = (id) => {
    const issue = issues.find((i) => `PVTI${i.number}` === id);
    assert(issue);
    return {
      id,
      isArchived: false,
      content: { ...issue, __typename: "Issue" },
      ...fields,
      fieldValues: Object.entries(fields).map(([name, value]) => ({
        field: { name },
        name: value,
      })),
    };
  };
  client.graphql = (query) => {
    const connection = (nodes: unknown[]) => ({
      totalCount: issues.length,
      nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    if (query.includes("projectRevision"))
      return {
        projectRevision: {
          id: "PVT",
          updatedAt: "2026-10-28T00:00:00Z",
          items: { totalCount: issues.length },
        },
      };
    let nodes: unknown[];
    if (query.includes("IntakeIssueUpdates"))
      nodes = structuredClone(issues).toSorted(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number,
      );
    else if (query.includes("RepositoryIssueMarker"))
      nodes = issues.slice(-1).map(({ id, number }) => ({ id, number }));
    else if (query.includes("UPDATED_AT"))
      nodes = issues.slice(-1).map(({ id, updatedAt }) => ({ id, updatedAt }));
    else if (query.includes("CREATED_AT")) nodes = structuredClone(issues);
    else throw new Error("Unexpected fixture inventory query");
    return { repository: { id: "R", nameWithOwner: config.repository, issues: connection(nodes) } };
  };
  bridge.inventory = (_cache, full) => {
    lastInventorySnapshot = structuredClone(snapshots.at(-1));
    return collectRoadmapInventory(
      client,
      undefined,
      full
        ? undefined
        : {
            scope: "intake",
            planningIssues: [...bridge.planningIssues],
          },
    );
  };
  const all = () => [...comments.values()].map((c) => structuredClone(c));
  return {
    get normalizations() {
      return normalizations;
    },
    request,
    bridge,
    all,
    prepare: async () => {
      denied = true;
      await assert.rejects(bridge.process(request, all()), /denied/u);
      denied = false;
    },
    comments,
    issues,
    fields,
    client,
    get creations() {
      return creations;
    },
    get writes() {
      return writes;
    },
    failPost: () => {
      postFailure = true;
    },
    failProject: (v: boolean) => {
      projectFailure = v;
    },
    deny: () => {
      denied = true;
    },
    changePrimary: () => {
      primaryChanged = true;
    },
  };
}

async function partialFixture(count = 3, stopIndex = count - 1) {
  const f = fixture(
    Array.from({ length: count }, (_, i) => ({
      ...candidate,
      title: `Recovery game ${i}`,
      game: `Recovery game ${i}`,
      upstream: `${candidate.upstream}-${i}`,
      port_key: `${candidate.port_key}-${i}`,
      repository_id: candidate.repository_id + i,
    })),
  );
  const inventory = f.bridge.inventory.bind(f.bridge);
  f.bridge.inventory = (cache, full) => {
    const comment = f.all().find((c) => c.body.startsWith("<!-- portcove-hosted-intake-receipt:"));
    const d = comment
      ? (
          JSON.parse(comment.body.match(/```json\n([\s\S]+)\n```$/u)![1]!) as {
            delivery: { status: string }[];
          }
        ).delivery
      : [];
    if (d[stopIndex]?.status === "create-attempted")
      throw new Error("Unstarted preflight exhausted");
    return inventory(cache, full);
  };
  await assert.rejects(f.bridge.process(f.request, f.all()), /Unstarted preflight/u);
  assert.equal(f.creations, stopIndex);
  f.bridge.inventory = inventory;
  return f;
}
void test("neutral recovery prefix spends no empty normalization or intermediate whole-inventory reads", async () => {
  const f = await partialFixture();
  const inventory = f.bridge.inventory.bind(f.bridge);
  let calls = 0;
  f.bridge.inventory = (cache, full) => {
    calls++;
    return inventory(cache, full);
  };
  assert.equal((await f.bridge.process(f.request, f.all()))?.status, "complete");
  assert.equal(calls, 2, "initial authority and mandatory fresh third-POST preflight only");
  assert.equal(f.normalizations, 0);
  assert.equal(f.creations, 3);
});
void test("cached-neutral owner drift holds on fresh readback without repair", async () => {
  const f = await partialFixture();
  const execution = f.client.executionIssue.bind(f.client);
  f.client.executionIssue = (number) => {
    const got = execution(number);
    if (number === 200) Object.assign(got.item, { Priority: "High" });
    return got;
  };
  await assert.rejects(f.bridge.process(f.request, f.all()), /Neutral intake field differs/u);
  assert.equal(f.normalizations, 0);
  assert.equal(f.creations, 2);
});
void test("needed normalization refreshes and rechecks ownership before writing", async () => {
  const f = await partialFixture();
  delete f.fields.Priority;
  const inventory = f.bridge.inventory.bind(f.bridge);
  let calls = 0;
  f.bridge.inventory = (cache, full) => {
    if (++calls === 2) f.fields.Priority = "High";
    return inventory(cache, full);
  };
  await assert.rejects(f.bridge.process(f.request, f.all()), /owner changes/u);
  assert.equal(calls, 2);
  assert.equal(f.normalizations, 0);
  assert.equal(f.creations, 2);
});
void test("normalization invalidation refreshes before the next retained target", async () => {
  const f = await partialFixture();
  delete f.fields.Priority;
  const inventory = f.bridge.inventory.bind(f.bridge);
  let calls = 0;
  f.bridge.inventory = (cache, full) => {
    calls++;
    return inventory(cache, full);
  };
  assert.equal((await f.bridge.process(f.request, f.all()))?.status, "complete");
  assert.equal(
    calls,
    4,
    "initial, normalization preimage, invalidated consumer and POST preflight",
  );
  assert.equal(f.normalizations, 1);
});
void test("a new POST invalidation refreshes before a later retained record", async () => {
  const candidates = [0, 1].map((i) => ({
    ...candidate,
    title: `Mixed ${i}`,
    game: `Mixed ${i}`,
    upstream: `${candidate.upstream}-${i}`,
    port_key: `${candidate.port_key}-${i}`,
    repository_id: candidate.repository_id + i,
  }));
  const f = fixture(candidates);
  const plan = candidates.map((c) => f.bridge.primary(c, f.request.id));
  f.issues.push({
    id: "I201",
    node_id: "I201",
    number: 201,
    title: `[Port] ${candidates[1]!.title}`,
    body: plan[1]!.body,
    state: "OPEN",
    url: "https://github.com/boburning/portcove/issues/201",
    html_url: "https://github.com/boburning/portcove/issues/201",
    updatedAt: "2026-10-28T00:00:00Z",
  });
  const hash = observationHash(f.request.body);
  const prior = {
    schema_version: 1,
    request_comment: f.request.id,
    request_sha256: hash,
    investigator: proposal.investigator,
    plan_sha256: hostedPlanHash(hash, plan),
    plan,
    delivery: [{ status: "prepared" }, { status: "created", created_issue: 201 }],
    status: "incomplete",
    head: f.bridge.head,
    run: "retained",
    attempt: "1",
    plan_origin: { head: f.bridge.head, run: "retained", attempt: "1" },
  };
  f.comments.set(999, {
    id: 999,
    issue_url: f.request.issue_url,
    user: { login: "github-actions[bot]" },
    body: `<!-- portcove-hosted-intake-receipt:${f.request.id} -->\n\`\`\`json\n${JSON.stringify(prior)}\n\`\`\``,
  });
  const inventory = f.bridge.inventory.bind(f.bridge);
  let calls = 0;
  f.bridge.inventory = (cache, full) => {
    calls++;
    return inventory(cache, full);
  };
  assert.equal((await f.bridge.process(f.request, f.all()))?.status, "complete");
  assert.equal(calls, 3, "initial, new POST preflight and invalidated retained consumer");
  assert.equal(f.creations, 1);
  assert.equal(f.normalizations, 0);
});
void test("known expiry refreshes the retained target without extending inventory TTL", async (t) => {
  const f = await partialFixture();
  const now = Date.now.bind(Date);
  const clock = t.mock.method(Date, "now", () => now());
  const set = f.client.setItemFields.bind(f.client);
  f.client.setItemFields = (id, values) => {
    set(id, values);
    if (id === "PVTICANARY") clock.mock.mockImplementation(() => now() + 95000);
  };
  const inventory = f.bridge.inventory.bind(f.bridge);
  let calls = 0;
  f.bridge.inventory = (cache, full) => {
    if (++calls === 2) clock.mock.restore();
    return inventory(cache, full);
  };
  assert.equal((await f.bridge.process(f.request, f.all()))?.status, "complete");
  assert.equal(calls, 3);
  assert.equal(f.normalizations, 0);
});
void test("untrusted actors, wrong repositories/issues and executable payload fields refuse", () => {
  const event = {
    repository: { full_name: "boburning/portcove" },
    sender: { login: "boburning" },
    action: "created",
    issue: { number: 177 },
    comment: { id: 1, body: encode(proposal), user: { login: "boburning" } },
  };
  assertHostedEvent(event, "issue_comment", config.repository, config.owner);
  for (const e of [
    { ...event, sender: { login: "outsider" } },
    { ...event, issue: { number: 178 } },
    { ...event, repository: { full_name: "other/repo" } },
    { ...event, comment: { ...event.comment, user: { login: "outsider" } } },
  ])
    assert.throws(() => assertHostedEvent(e, "issue_comment", config.repository, config.owner));
  for (const p of [
    { ...proposal, command: "execute me" },
    { ...proposal, candidates: [{ ...candidate, evidence: "<!-- portcove-catalog-id: fake -->" }] },
    { ...proposal, candidates: [candidate, candidate] },
    { ...proposal, candidates: [{ ...candidate, upstream: "https://evil.test/code" }] },
  ])
    assert.throws(() => parseHostedRequest(encode(p)));
});
void test("generated body retains maintained research and exact identity markers", () => {
  const body = hostedBody(candidate, 100);
  assert.match(body, /portcove-research: catalog=unassigned; support=not-granted/u);
  assert.match(body, /portcove-discovery-intake:hosted-100-example-native-game/u);
  assert.match(body, /GitHub repository ID: 987654321/u);
});
void test("ten long candidates retain a single compact logical receipt", async () => {
  const f = fixture(
    Array.from({ length: 10 }, (_, i) => ({
      ...candidate,
      title: `Long game ${i}`,
      game: `Long game ${i}`,
      upstream: `${candidate.upstream}-${i}`,
      repository_id: candidate.repository_id + i,
      port_key: `${candidate.port_key}-${i}`,
      evidence: "Dated primary upstream evidence; gameplay remains Unknown. ".repeat(65),
    })),
  );
  await f.prepare();
  const prior = [...f.comments.values()].find((c) => c.user.login === "github-actions[bot]")!;
  assert(Buffer.byteLength(prior.body) < 20000);
  assert.match(prior.body, /proposal-bound-v1/u);
  assert.doesNotMatch(prior.body, /Dated primary upstream evidence/u);
  const result = await f.bridge.process(f.request, f.all());
  assert.equal(result.status, "complete");
  assert.equal(result.delivery.length, 10);
  assert.equal(f.creations, 10);
  assert.equal(
    [...f.comments.values()].filter((c) => c.user.login === "github-actions[bot]").length,
    1,
  );
});
void test("compact plan tampering refuses and legacy complete receipts stay byte-identical", async () => {
  const f = fixture();
  await f.prepare();
  const prior = [...f.comments.values()].find((c) => c.user.login === "github-actions[bot]")!;
  const wire = JSON.parse(prior.body.match(/```json\n([\s\S]+)\n```$/u)![1]!) as {
    plan_encoding?: string;
    plan: Record<string, unknown>[];
    status: string;
  };
  const original = prior.body;
  for (const field of ["body_sha256", "candidate_index", "port_key"]) {
    const altered = structuredClone(wire);
    altered.plan[0]![field] = "changed";
    prior.body = original.replace(
      /```json\n[\s\S]+\n```$/u,
      `\`\`\`json\n${JSON.stringify(altered)}\n\`\`\``,
    );
    await assert.rejects(f.bridge.process(f.request, f.all()), /exact proposal/u);
    assert.equal(f.creations, 0);
  }
  delete wire.plan_encoding;
  wire.plan = [{ ...f.bridge.primary(candidate, f.request.id) }];
  wire.status = "complete";
  prior.body = original.replace(
    /```json\n[\s\S]+\n```$/u,
    `\`\`\`json\n${JSON.stringify(wire)}\n\`\`\``,
  );
  const legacy = prior.body;
  assert.equal((await f.bridge.process(f.request, f.all())).status, "complete");
  assert.equal(prior.body, legacy);
  assert.equal(f.creations, 0);
});
void test("safe preflight drift recovers in a fresh pass without duplicate POSTs", async () => {
  const f = fixture();
  const inventory = f.bridge.inventory.bind(f.bridge);
  let drift = true;
  f.bridge.inventory = (...args) => {
    if (drift) {
      drift = false;
      throw new GitHubApiError("inventory_changed", "membership moved");
    }
    return inventory(...args);
  };
  let error: unknown;
  try {
    await f.bridge.process(f.request, f.all());
  } catch (e) {
    error = e;
  }
  assert.equal(f.bridge.continuation(error), "inventory_changed");
  assert.equal(f.creations, 0);
  assert.equal((await f.bridge.process(f.request, f.all())).status, "complete");
  assert.equal(f.creations, 1);
});
void test("an unconfirmed issue or receipt mutation permanently excludes automatic continuation", async () => {
  for (const target of ["issue", "receipt"]) {
    const f = fixture();
    if (target === "issue") {
      f.client.createPortIssue = () => {
        throw new GitHubApiError("budget_exhausted", "POST result unknown");
      };
    } else {
      const request = f.client.api.request.bind(f.client.api);
      f.client.api.request = (...args) => {
        const result = request(...args);
        if (args[0] === "POST")
          throw new GitHubApiError("budget_exhausted", "receipt POST result unknown");
        return result;
      };
    }
    let error: unknown;
    try {
      await f.bridge.process(f.request, f.all());
    } catch (e) {
      error = e;
    }
    assert(error);
    assert.equal(f.bridge.continuation(error), null);
  }
});
void test("a legacy pending plan resumes without a reviewer or a duplicate proposal", async () => {
  const f = fixture();
  await f.prepare();
  const comment = [...f.comments.values()].find((c) => c.user.login === "github-actions[bot]")!;
  const plan = JSON.parse(comment.body.match(/```json\n([\s\S]+)\n```$/u)![1]!) as {
    status: string;
    delivery: { status: string }[];
  };
  plan.status = "needs-review";
  plan.delivery[0]!.status = "reviewed";
  comment.body = comment.body.replace(
    /```json\n[\s\S]+\n```$/u,
    `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``,
  );
  assert.equal((await f.bridge.process(f.request, f.all()))?.status, "complete");
  assert.equal(f.creations, 1);
});
void test("one proposal creates once without review, verifies neutral fields and runs the real scoped evaluator", async () => {
  const f = fixture();
  const result = await f.bridge.process(f.request, f.all());
  assert.equal(result?.status, "complete");
  assert(result?.delivery[0]);
  assert.equal(f.creations, 1);
  assert.equal(
    (result.delivery[0].doctor as { global_health: string }).global_health,
    "not_evaluated",
  );
  assert.deepEqual(result?.delivery[0]?.fields, portFieldInitialization(null));
  await f.bridge.process(f.request, f.all());
  assert.equal(f.creations, 1);
});
void test("a lost issue POST response stays held when absence is ambiguous", async () => {
  const f = fixture();
  f.failPost();
  await assert.rejects(f.bridge.process(f.request, f.all()), /unknown/u);
  await assert.rejects(f.bridge.process(f.request, f.all()), /do not recapture/u);
  assert.equal(f.creations, 1);
});
void test("delivery refreshes only for a remaining candidate or mandatory global input", async (t) => {
  for (const count of [1, 2, 11]) {
    await t.test(`${count} candidates`, async () => {
      const f = fixture(
        Array.from({ length: count }, (_, i) => ({
          ...candidate,
          title: `Game ${i}`,
          game: `Game ${i}`,
          upstream: `https://github.com/x/g${i}`,
          port_key: `g${i}`,
          evidence: "Source only; gameplay Unknown.",
          resume: "Revisit release.",
          repository_id: candidate.repository_id + i,
        })),
      );
      if (count > 10) {
        // A retained large plan still owes global validation even when its
        // current creation-envelope reservation would refuse new capture.
        const input = parseHostedRequest(f.request.body);
        const plan = input.candidates.map((c) => f.bridge.primary(c, f.request.id));
        const hash = observationHash(f.request.body);
        const receipt = {
          schema_version: 1,
          request_comment: f.request.id,
          request_sha256: hash,
          investigator: input.investigator,
          plan_sha256: hostedPlanHash(hash, plan),
          plan,
          delivery: plan.map(() => ({ status: "prepared" })),
          status: "prepared",
          head: f.bridge.head,
          run: "retained",
          attempt: "1",
          plan_origin: { head: f.bridge.head, run: "retained", attempt: "1" },
        };
        f.comments.set(999, {
          id: 999,
          issue_url: f.request.issue_url,
          user: { login: "github-actions[bot]" },
          body: `<!-- portcove-hosted-intake-receipt:${f.request.id} -->\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\``,
        });
      }
      const inventory = f.bridge.inventory.bind(f.bridge);
      const refreshedAfterDelivery = new Set<number>();
      f.bridge.inventory = (cache) => {
        const retained = f.all().find((c) => c.user.login === "github-actions[bot]");
        const receipt = (
          retained ? JSON.parse(retained.body.match(/```json\n([\s\S]+)\n```$/u)![1]!) : null
        ) as { delivery: { status: string }[] } | null;
        const delivered =
          receipt?.delivery.filter((d: { status: string }) => d.status === "delivered").length ?? 0;
        if (delivered) refreshedAfterDelivery.add(delivered);
        if (delivered === count) throw new Error("Final global input cannot be collected");
        return inventory(cache);
      };
      if (count > 10) {
        await assert.rejects(f.bridge.process(f.request, f.all()), /Final global input/u);
        assert(refreshedAfterDelivery.has(count), "global doctor requires a fresh final inventory");
      } else {
        const receipt = await f.bridge.process(f.request, f.all());
        assert.equal(receipt?.status, "complete");
        assert(receipt?.delivery.every((d) => d.status === "delivered" && d.doctor));
        assert(!refreshedAfterDelivery.has(count), "final small-batch snapshot has no consumer");
      }
      for (let n = 1; n < count; n++)
        assert(refreshedAfterDelivery.has(n), "remaining candidates require fresh inventory");
      assert.equal(f.creations, count);
    });
  }
});
void test("interrupted Project delivery recovers the same issue without another POST", async () => {
  const f = fixture();
  f.failProject(true);
  await assert.rejects(f.bridge.process(f.request, f.all()), /interrupted/u);
  f.failProject(false);
  const result = await f.bridge.process(f.request, f.all());
  assert.equal(result?.status, "complete");
  assert.equal(f.creations, 1);
});
void test("changed primary, request or existing issue body refuses stale preparation", async () => {
  for (const change of ["primary", "request", "issue"] as const) {
    const f = fixture();
    if (change !== "issue") await f.prepare();
    if (change === "primary") f.changePrimary();
    if (change === "request") f.comments.get(100)!.body += "edited";
    if (change === "issue") {
      f.failProject(true);
      await assert.rejects(f.bridge.process(f.request, f.all()));
      f.failProject(false);
      f.issues[0]!.body += "Owner revision";
    }
    await assert.rejects(f.bridge.process(f.request, f.all()));
    assert.equal(f.creations, change === "issue" ? 1 : 0);
  }
});
void test("a non-neutral field prevents successful intake; permission probe really writes and refuses denied access", async () => {
  const f = fixture();
  f.fields.Priority = "High";
  await assert.rejects(f.bridge.process(f.request, f.all()), /Neutral intake field/u);
  f.fields.Priority = "None";
  const proof = await probeHostedProjectWrite(f.client, 200);
  assert.equal(proof.fields_unchanged, true);
  assert.equal(f.writes, 2);
  f.deny();
  await assert.rejects(probeHostedProjectWrite(f.client, 200), /denied/u);
});

void test("recovery refuses changed Work type and closed state before normalizer writes", async () => {
  for (const change of ["work", "closed"]) {
    const f = fixture();
    f.failProject(true);
    await assert.rejects(f.bridge.process(f.request, f.all()));
    f.failProject(false);
    if (change === "work") f.fields["Work type"] = "Product feature";
    else f.issues[0]!.state = "CLOSED";
    await assert.rejects(f.bridge.process(f.request, f.all()), /owner changes|owner\/state/u);
    assert.equal(f.normalizations, 0);
    assert.equal(f.creations, 1);
  }
});
void test("an unrelated malformed owner request cannot block a valid candidate", async () => {
  const f = fixture();
  f.comments.set(102, { ...f.request, id: 102, body: hostedRequestMarker + " malformed" });
  assert.equal((await f.bridge.process(f.request, f.all()))?.status, "complete");
});
void test("authored shared repositories preserve independently catalogable games", () => {
  const record = {
    format_version: 1 as const,
    listing: {
      id: "other-game",
      name: "Other",
      summary: "Other game",
      project_url: candidate.upstream,
      original_game_title: "Other game",
    },
  };
  assertHostedCatalogIdentity(candidate, [record]);
  assert.throws(() =>
    assertHostedCatalogIdentity(candidate, [
      { ...record, listing: { ...record.listing, original_game_title: candidate.game } },
    ]),
  );
  const { original_game_title: _game, ...unknown } = record.listing;
  assert.throws(() => assertHostedCatalogIdentity(candidate, [{ ...record, listing: unknown }]));
});
void test("multibyte evidence fits without duplicating proposal text in the receipt", async () => {
  const f = fixture();
  const p = {
    ...proposal,
    candidates: [0, 1, 2].map((i) => ({
      ...candidate,
      title: `Game ${i}`,
      game: `Game ${i}`,
      port_key: `game-${i}`,
      evidence: "界".repeat(4800),
    })),
  };
  f.request.body = encode(p);
  f.comments.set(100, f.request);
  assert.equal((await f.bridge.process(f.request, f.all())).status, "complete");
  assert.equal(f.creations, 3);
});
void test("denied hosted Project write access prevents issue creation", async () => {
  const f = fixture();
  f.deny();
  await assert.rejects(f.bridge.process(f.request, f.all()), /denied/u);
  assert.equal(f.creations, 0);
});

async function reconciliationFixture(count = 3, stopIndex = count - 1, ambiguous = false) {
  const f = await partialFixture(count, stopIndex);
  const sourceBody = f.request.body;
  const receipt = [...f.comments.values()].find((c) =>
    c.body.startsWith("<!-- portcove-hosted-intake-receipt:100 -->"),
  )!;
  const data = JSON.parse(receipt.body.match(/```json\n([\s\S]+)\n```$/u)![1]!) as {
    plan_sha256: string;
    delivery: { status: string }[];
  };
  if (ambiguous) {
    data.delivery[stopIndex]!.status = "create-attempted";
    receipt.body = receipt.body.replace(
      /```json\n[\s\S]+\n```$/u,
      `\`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
    );
  }
  const sourceReceiptBody = receipt.body;
  const proposal = {
    ...parseHostedRequest(sourceBody),
    reconcile: {
      request_comment: 100,
      request_sha256: observationHash(sourceBody),
      receipt_comment: receipt.id,
      receipt_sha256: observationHash(receipt.body),
      plan_sha256: data.plan_sha256,
    },
  };
  f.request.body = `Withdrawn for a full-batch owner reconciliation. Original retained verbatim.\n\n${sourceBody}`;
  const successor = { ...f.request, id: 101, body: encode(proposal) };
  f.comments.set(successor.id, successor);
  f.changePrimary();
  return Object.assign(f, {
    successor,
    proposal,
    sourceBody,
    sourceReceiptBody,
    sourceReceipt: receipt,
  });
}
void test("owner reconciliation preserves six owners and ambiguous intent, then recovers an exact seventh marker", async () => {
  const f = await reconciliationFixture(10, 6, true);
  const before = f.issues.map((i) => structuredClone(i));
  await assert.rejects(f.bridge.process(f.successor, f.all()), /Ambiguous issue POST/u);
  assert.equal(f.creations, 6);
  assert.equal(
    f.sourceReceipt.body,
    f.sourceReceiptBody,
    "historical bot receipt is never modified",
  );
  assert.deepEqual(f.issues, before);
  const c = f.proposal.candidates[6]!;
  f.issues.push({
    ...before[0]!,
    id: "I206",
    node_id: "I206",
    number: 206,
    title: `[Port] ${c.title}`,
    body: hostedBody(c, 100),
    url: "https://github.com/boburning/portcove/issues/206",
    html_url: "https://github.com/boburning/portcove/issues/206",
  });
  const result = await f.bridge.process(f.successor, f.all());
  assert.equal(result?.status, "complete");
  assert.equal(result.body_request_comment, 100);
  assert.equal(f.creations, 9);
  assert.equal(f.issues.length, 10);
  assert.deepEqual(
    result.delivery.slice(0, 7).map((d) => d.created_issue),
    [200, 201, 202, 203, 204, 205, 206],
  );
  for (const [i, d] of result.delivery.entries()) {
    assert.equal(d.status, "delivered");
    assert.deepEqual(d.fields, portFieldInitialization(null));
    assert.equal(f.issues[i]!.body, hostedBody(f.proposal.candidates[i]!, 100));
    assert.equal((d.doctor as { status: string }).status, "passed");
  }
  assert.equal((await f.bridge.process(f.successor, f.all()))?.status, "complete");
  assert.equal(f.creations, 9);
  assert.equal(f.sourceReceipt.body, f.sourceReceiptBody);
});
void test("reconciliation refuses changed lineage, active sources and incomplete ordered body coverage", async (t) => {
  for (const change of [
    "request hash",
    "receipt hash",
    "plan hash",
    "active",
    "author",
    "drop",
    "reorder",
    "revise body",
    "source changed",
    "receipt changed",
    "duplicate receipt",
  ]) {
    await t.test(change, async () => {
      const f = await reconciliationFixture();
      if (change === "request hash") f.proposal.reconcile.request_sha256 = "0".repeat(64);
      if (change === "receipt hash") f.proposal.reconcile.receipt_sha256 = "0".repeat(64);
      if (change === "plan hash") f.proposal.reconcile.plan_sha256 = "0".repeat(64);
      if (change === "active") f.request.body = f.sourceBody;
      if (change === "author") f.request.user.login = "stranger";
      if (change === "drop") f.proposal.candidates.pop();
      if (change === "reorder") f.proposal.candidates.reverse();
      if (change === "revise body") f.proposal.candidates[0]!.evidence += " revised";
      if (change === "source changed") f.request.body += "\nchanged";
      if (change === "receipt changed") f.sourceReceipt.body += "\nchanged";
      if (change === "duplicate receipt") f.comments.set(998, { ...f.sourceReceipt, id: 998 });
      f.successor.body = encode(f.proposal);
      const before = f.creations,
        writes = f.writes;
      await assert.rejects(f.bridge.process(f.successor, f.all()));
      assert.equal(f.creations, before);
      assert.equal(f.writes, writes);
    });
  }
});
void test("reconciliation preserves owner bodies, duplicate marker holds and the original full doctor boundary", async (t) => {
  await t.test("owner revised canonical body", async () => {
    const f = await reconciliationFixture();
    f.issues[0]!.body += "\nOwner revision";
    await assert.rejects(f.bridge.process(f.successor, f.all()), /Created issue was revised/u);
    assert.equal(f.creations, 2);
    assert.equal(f.normalizations, 0);
  });
  await t.test("duplicate original marker", async () => {
    const f = await reconciliationFixture();
    f.issues[1]!.body = f.issues[0]!.body;
    await assert.rejects(f.bridge.process(f.successor, f.all()), /Ambiguous created issue marker/u);
    assert.equal(f.creations, 2);
  });
  await t.test("eleven remain one logical batch", async () => {
    const f = await reconciliationFixture(11, 1);
    const inventory = f.bridge.inventory.bind(f.bridge);
    let requiredGlobal = false;
    f.bridge.inventory = (cache, full) => {
      if (full) {
        requiredGlobal = true;
        throw new Error("Required full doctor input is unavailable");
      }
      return inventory(cache, full);
    };
    await assert.rejects(f.bridge.process(f.successor, f.all()), /Required full doctor input/u);
    assert.equal(requiredGlobal, true);
    assert.equal(f.creations, 11);
    const comment = f
      .all()
      .find((c) => c.body.startsWith("<!-- portcove-hosted-intake-receipt:101 -->"))!;
    const receipt = JSON.parse(comment.body.match(/```json\n([\s\S]+)\n```$/u)![1]!) as {
      status: string;
      delivery: { status: string }[];
    };
    assert.equal(receipt.status, "incomplete");
    assert.equal(receipt.delivery.length, 11);
    assert(receipt.delivery.every((d: { status: string }) => d.status === "delivered"));
    assert.equal(f.sourceReceipt.body, f.sourceReceiptBody);
  });
});
void test("source preimage is checked during successor delivery before a pending capture", async () => {
  const f = await reconciliationFixture();
  const inventory = f.bridge.inventory.bind(f.bridge);
  let observations = 0;
  f.bridge.inventory = (cache, full) => {
    const result = inventory(cache, full);
    if (++observations === 2) f.sourceReceipt.body += "\nConcurrent edit";
    return result;
  };
  await assert.rejects(f.bridge.process(f.successor, f.all()), /preimage changed/u);
  assert.equal(f.creations, 2);
  assert.equal(f.issues.length, 2);
});
void test("a second explicit reconciliation preserves the original marker and the uncertain state", async () => {
  const f = await reconciliationFixture(3, 2, true);
  await assert.rejects(f.bridge.process(f.successor, f.all()), /Ambiguous issue POST/u);
  const source = f.successor,
    original = source.body;
  const receipt = f
    .all()
    .find((c) => c.body.startsWith("<!-- portcove-hosted-intake-receipt:101 -->"))!;
  const prior = JSON.parse(receipt.body.match(/```json\n([\s\S]+)\n```$/u)![1]!) as {
    plan_sha256: string;
  };
  source.body = `Withdrawn, exact original retained.\n\n${original}`;
  const next = {
    ...source,
    id: 102,
    body: encode({
      ...parseHostedRequest(original),
      reconcile: {
        request_comment: 101,
        request_sha256: observationHash(original),
        receipt_comment: receipt.id,
        receipt_sha256: observationHash(receipt.body),
        plan_sha256: prior.plan_sha256,
      },
    }),
  };
  f.comments.set(102, next);
  await assert.rejects(f.bridge.process(next, f.all()), /Ambiguous issue POST/u);
  assert.equal(f.creations, 2);
  const result = f
    .all()
    .find((c) => c.body.startsWith("<!-- portcove-hosted-intake-receipt:102 -->"))!;
  const data = JSON.parse(result.body.match(/```json\n([\s\S]+)\n```$/u)![1]!) as {
    body_request_comment: number;
    delivery: { status: string }[];
  };
  assert.equal(data.body_request_comment, 100);
  assert.equal(data.delivery[2]!.status, "create-attempted");
});
void test("warm admission charges bounded publications, preserves IDs and never strands a new intent", async (t) => {
  for (const mode of ["request threshold", "byte threshold", "preflight recheck"] as const)
    await t.test(mode, async () => {
      const f = await partialFixture(),
        budget = new DiscoveryBudget("cold");
      const prior = [...f.comments.values()].find((c) =>
        c.body.startsWith("<!-- portcove-hosted-intake-receipt:100 -->"),
      )!;
      const stored = JSON.parse(prior.body.match(/```json\n([\s\S]+)\n```$/u)![1]!) as Record<
        string,
        unknown
      >;
      stored.padding = "\\".repeat(24000);
      prior.body = prior.body.replace(
        /```json\n[\s\S]+\n```$/u,
        `\`\`\`json\n${JSON.stringify(stored)}\n\`\`\``,
      );
      if (mode === "request threshold") budget.usage.requests = budget.limits.requests - 32;
      if (mode === "byte threshold") budget.usage.bytes = budget.limits.bytes - 2 * 1024 * 1024;
      const request = f.client.api.request.bind(f.client.api);
      let attemptPublications = 0;
      f.client.api.request = (method, endpoint, input) => {
        const sent = input === undefined ? 0 : Buffer.byteLength(JSON.stringify(input));
        budget.admit(1, 1 + sent);
        budget.usage.accounting_bytes += sent;
        const result = request(method, endpoint, input);
        budget.charge(method, endpoint, 1, Buffer.byteLength(JSON.stringify(result.body)), "200");
        if (
          method !== "GET" &&
          input &&
          typeof input === "object" &&
          "body" in input &&
          typeof input.body === "string"
        ) {
          const wire = JSON.parse(input.body.match(/```json\n([\s\S]+)\n```$/u)![1]!) as {
            delivery?: { status: string }[];
          };
          if (wire.delivery?.[2]?.status === "create-attempted") attemptPublications++;
        }
        return result;
      };
      let admissions = 0;
      Object.defineProperty(f.bridge, "admitWarmInventory", {
        value: (cache: Parameters<typeof discoveryInventoryCost>[0]) => {
          if (++admissions === 2 && mode === "preflight recheck")
            budget.charge(
              "GET",
              "bounded preflight fixture",
              1,
              budget.remaining().bytes - 2 * 1024 * 1024,
              "200",
            );
          const c = discoveryInventoryCost(cache);
          budget.admit(c.requests + 12, c.bytes + 2 * 1024 * 1024);
        },
      });
      f.bridge.inventory = HostedIntakeBridge.prototype.inventory.bind(f.bridge);
      let failure: unknown;
      try {
        await f.bridge.process(f.request, f.all());
      } catch (error) {
        failure = error;
      }
      assert(failure instanceof GitHubApiError);
      assert.equal(failure.code, "budget_exhausted");
      assert.equal(f.creations, 2);
      assert.deepEqual(
        f.issues.map((x) => x.number),
        [200, 201],
      );
      const comment = f
        .all()
        .find((c) => c.body.startsWith("<!-- portcove-hosted-intake-receipt:100 -->"))!;
      const receipt = JSON.parse(comment.body.match(/```json\n([\s\S]+)\n```$/u)![1]!) as {
        status: string;
        delivery: { status: string; created_issue?: number }[];
      };
      assert.equal(receipt.status, "incomplete");
      assert.equal(receipt.delivery[2]!.status, "prepared");
      assert.equal(receipt.delivery[2]!.created_issue, undefined);
      f.bridge.diagnostic(f.request, failure, f.all());
      assert(
        f.all().some((c) => c.body.startsWith("<!-- portcove-hosted-intake-diagnostic:100 -->")),
      );
      assert.equal(f.bridge.continuation(failure), "budget_exhausted");
      assert.equal(attemptPublications, mode === "preflight recheck" ? 1 : 0);
      assert(budget.usage.attempts.length > 0);
      assert(budget.usage.bytes + budget.usage.accounting_bytes <= budget.limits.bytes);
    });
});
