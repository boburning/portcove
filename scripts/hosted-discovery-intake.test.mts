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
  probeHostedProjectWrite,
  assertHostedCatalogIdentity,
} from "./hosted-discovery-intake.mts";
import { RoadmapClient, portFieldInitialization, validateConfig } from "./roadmap.mts";
import { GitHubApiClient, GitHubApiError } from "./github-api.mts";

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
function fixture() {
  const comments = new Map<
    number,
    { id: number; body: string; user: { login: string }; issue_url: string }
  >();
  const issueUrl = "https://api.github.com/repos/boburning/portcove/issues/177";
  const request = {
    id: 100,
    body: encode(proposal),
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
    assert.deepEqual(
      lastInventorySnapshot,
      snapshots.at(-1),
      "canonical inventory must follow the last durable receipt write",
    );
    creations++;
    assert(
      snapshots.some((v) => JSON.stringify(v).includes("create-attempted")),
      "attempt receipt must precede POST",
    );
    if (postFailure) throw new Error("Transport result unknown");
    const issue = {
      id: "I200",
      node_id: "I200",
      number: 200,
      body: input.body!,
      title: `[Port] ${input.title}`,
      state: "OPEN",
      url: "https://github.com/boburning/portcove/issues/200",
      html_url: "https://github.com/boburning/portcove/issues/200",
      updatedAt: "2026-10-28T00:00:00Z",
    };
    issues.push(issue);
    input.onIssueCreated?.(issue);
    if (projectFailure) throw new Error("Project mutation interrupted");
    return { ...issue, itemId: "PVTI200" };
  };
  client.repositoryIssue = (n) => {
    const i = issues.find((i) => i.number === n);
    if (!i) throw new Error("Missing issue");
    return { ...i, number: n };
  };
  client.normalizePortIssue = () => {
    normalizations++;
    return {
      issue: issues[0]!.url,
      bodyChanged: false,
      projectItemAdded: false,
      fieldsChanged: [],
      itemId: "PVTI200",
    };
  };
  client.executionIssue = (number) =>
    ({
      item: {
        id: [177, 3849].includes(number) ? "PVTICANARY" : "PVTI200",
        content: [177, 3849].includes(number)
          ? {
              id: "ICANARY",
              number,
              title: "[Port] Neutral canary",
              state: "OPEN",
              url: `https://github.com/boburning/portcove/issues/${number}`,
              body: hostedBody({ ...candidate, port_key: "neutral-canary" }, 99),
            }
          : { ...issues[0]! },
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
    () => ({
      metadata: { id: candidate.repository_id, full_name: "example/native-game" },
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
  bridge.inventory = () => {
    lastInventorySnapshot = structuredClone(snapshots.at(-1));
    return {
      format: 1,
      repository: config.repository,
      repository_node_id: "R",
      observed_at: new Date().toISOString(),
      issues,
      items: issues.map((i) => ({
        id: "PVTI200",
        isArchived: false,
        content: { ...i },
        ...fields,
      })),
      archivedItems: [],
      body_reads: 0,
      projectId: "PVT",
    };
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
void test("oversized complete receipts refuse before any canonical write", async () => {
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
  await assert.rejects(f.bridge.process(f.request, f.all()), /envelope|retain complete/u);
  assert.equal(f.creations, 0);
});
void test("denied hosted Project write access prevents issue creation", async () => {
  const f = fixture();
  f.deny();
  await assert.rejects(f.bridge.process(f.request, f.all()), /denied/u);
  assert.equal(f.creations, 0);
});
