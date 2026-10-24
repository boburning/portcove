import type { GitHubRunner } from "./github-api.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createGitHubRunner, GitHubApiError } from "./github-api.mts";

import { RoadmapClient, readDoctorRepositoryIssues, runDoctor, fieldValue } from "./roadmap.mts";
import { doctorFailureDiagnostics } from "./roadmap-scoped.mts";

import {
  fixtureValue,
  fixtureElement,
  fixtureObject,
  fixtureGraphql,
  config,
  fixtureProjectDetails,
} from "./fixtures/roadmap-fixtures.mts";
import type { RunnerCall } from "./fixtures/roadmap-fixtures.mts";

function included(body: unknown, headers: Readonly<Record<string, string>> = {}) {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `HTTP/2.0 200 OK\r\n${lines.join("\r\n")}\r\n\r\n${JSON.stringify(body)}`;
}

function restIssue(number: number, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    node_id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    body: "",
    html_url: `https://github.com/boburning/portcove/issues/${number}`,
    state: "open",
    ...overrides,
  };
}

function issueConnectionResponse(
  input: string | undefined,
  numbers: number[],
  total = numbers.length,
  modify?: (repository: Record<string, unknown>) => void,
) {
  const { query } = fixtureGraphql(input);
  const marker = query.includes("RepositoryIssueMarker");
  const nodes = numbers.map((number) => ({
    id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    body: "",
    url: `https://github.com/boburning/portcove/issues/${number}`,
    state: "OPEN",
    updatedAt: "2026-10-17T00:00:00Z",
  }));
  const repository = {
    id: "R_repository",
    nameWithOwner: config.repository,
    issues: {
      totalCount: total,
      nodes: marker ? nodes.slice(-1) : nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  modify?.(repository);
  return included({ data: { repository } });
}

void test("doctor requires count-verified inventory even when truncated REST includes its marker", () => {
  let restReads = 0;
  const client = new RoadmapClient(config, (args, input) => {
    if (args[1] === "graphql") return issueConnectionResponse(input, [1, 2, 3]);
    restReads++;
    return included([restIssue(3)]);
  });
  const result = readDoctorRepositoryIssues(client);
  assert.deepEqual(
    result.issues.map((issue) => issue.number),
    [1, 2, 3],
  );
  assert.equal(restReads, 0);
  assert.deepEqual(
    result.attempts.map(({ evidence: _evidence, ...attempt }) => attempt),
    [{ attempt: 1, source: "graphql", outcome: "passed", issues: 3 }],
  );
});

void test("doctor retains a failed GraphQL observation without a retry", () => {
  let requests = 0;
  const attempts: Parameters<typeof readDoctorRepositoryIssues>[1] = [];
  const client = new RoadmapClient(config, () => {
    requests++;
    throw new Error("transport unavailable");
  });
  assert.throws(() => readDoctorRepositoryIssues(client, attempts), /transport unavailable/);
  assert.equal(requests, 1);
  assert.equal(attempts.length, 1);
  assert.equal(fixtureValue(attempts[0]).source, "graphql");
  assert.equal(fixtureValue(attempts[0]).outcome, "failed");
});

void test("doctor records one complete empty GraphQL observation", () => {
  const client = new RoadmapClient(config, (_args, input) => issueConnectionResponse(input, []));
  const result = readDoctorRepositoryIssues(client);
  assert.deepEqual(result.issues, []);
  assert.equal(result.attempts[0]?.issues, 0);
});

void test("global doctor retains observable quota and authentication failures before planning", async () => {
  const resetSeconds = 1792880126;
  for (const failure of [
    {
      stage: "project",
      status: 200,
      remaining: 0,
      body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
      code: "rate_limited",
      kind: "rate_limit",
    },
    {
      stage: "project",
      status: 403,
      remaining: 4000,
      body: { message: "Resource not accessible by personal access token" },
      code: "command_failed",
      kind: "authentication",
    },
    {
      stage: "owner",
      status: 401,
      remaining: 4999,
      body: { message: "Bad credentials" },
      code: "command_failed",
      kind: "authentication",
    },
  ] as const) {
    const commands: (readonly string[])[] = [];
    const client = new RoadmapClient(
      config,
      createGitHubRunner({
        spawn: (_command, args, options) => {
          commands.push(args);
          assert.equal(args[0], "api", "Opaque CLI authentication must not mask API evidence");
          if (args[2] === `users/${config.owner}` && failure.stage !== "owner")
            return { status: 0, stdout: included({ type: "User" }), stderr: "" };
          if (failure.stage === "project") {
            assert.equal(args[1], "graphql");
            assert.match(fixtureGraphql(options.input).query, /projectV2\(number:.*fields\(/u);
          }
          return {
            status: 1,
            stdout:
              `HTTP/2.0 ${failure.status} Provider response\r\n` +
              `x-ratelimit-resource: ${failure.stage === "owner" ? "core" : "graphql"}\r\n` +
              `x-ratelimit-remaining: ${failure.remaining}\r\n` +
              `x-ratelimit-reset: ${resetSeconds}\r\n\r\n` +
              JSON.stringify(failure.body),
            stderr: "gh: provider refused this request",
          };
        },
      }),
    );
    // API-only clients need no opaque CLI command capability for a doctor read.
    Object.defineProperty(client, "gh", { value: undefined });
    const attempts: Parameters<typeof readDoctorRepositoryIssues>[1] = [];
    await assert.rejects(
      runDoctor(config, client, { quiet: true, repositoryIssueInventoryAttempts: attempts }),
      (error) => {
        assert(error instanceof GitHubApiError);
        const diagnosis = doctorFailureDiagnostics(error);
        assert.equal(diagnosis.kind, failure.kind);
        assert.equal(diagnosis.coverage, "inconclusive");
        assert.equal(diagnosis.error.code, failure.code);
        assert.equal(diagnosis.provider?.status, failure.status);
        assert.equal(diagnosis.provider?.rate?.remaining, failure.remaining);
        assert.equal(
          diagnosis.provider?.rate?.resetAt,
          new Date(resetSeconds * 1000).toISOString(),
        );
        assert.equal("doctorErrors" in error, false);
        return true;
      },
    );
    assert.equal(commands.length, failure.stage === "owner" ? 1 : 2);
    assert.equal(client.api.observations.length, commands.length);
    assert.equal(client.api.observations.at(-1)?.failure, failure.code);
    assert.deepEqual(attempts, [], "Unavailable provider reads cannot establish an inventory");
  }
});

void test("runDoctor retains an incomplete GraphQL observation for its CLI receipt", async () => {
  let traversals = 0;
  const client = new RoadmapClient(config, (args, input) => {
    assert.equal(args[1], "graphql");
    if (fixtureGraphql(input).query.includes("RepositoryIssueInventory")) traversals++;
    return issueConnectionResponse(input, [1], 3);
  });
  const attempts: Parameters<typeof readDoctorRepositoryIssues>[1] = [];
  await assert.rejects(
    runDoctor(
      config,
      Object.assign(client, {
        gh: () => "",
        completeProjectContext: () => ({ details: { id: "P" }, fields: [] }),
        viewList: () => [],
        projectAudit: () => ({
          id: "P",
          updatedAt: "2026-10-22T00:00:00Z",
          items: { totalCount: 0 },
          repositories: { nodes: [] },
        }),
        itemList: () => [],
      }),
      { quiet: true, repositoryIssueInventoryAttempts: attempts },
    ),
    /record count does not match total/,
  );
  assert.equal(traversals, 1);
  assert.deepEqual(
    attempts.map((entry) => entry.outcome),
    ["failed"],
  );
  assert.equal(fixtureValue(attempts[0]).source, "graphql");
});

void test("GraphQL repository inventory reads all pages and binds the repository and latest issue", () => {
  const cursors: unknown[] = [];
  const client = new RoadmapClient(config, (_args, input) => {
    const { query, variables } = fixtureGraphql(input);
    if (query.includes("RepositoryIssueMarker")) return issueConnectionResponse(input, [1, 2], 2);
    cursors.push(variables.after);
    return issueConnectionResponse(input, variables.after === null ? [1] : [2], 2, (repository) => {
      if (variables.after === null)
        fixtureObject(repository.issues).pageInfo = { hasNextPage: true, endCursor: "second" };
    });
  });
  assert.deepEqual(
    client.repositoryIssues().issues.map((issue) => issue.number),
    [1, 2],
  );
  assert.deepEqual(cursors, [null, "second"]);
  const empty = new RoadmapClient(config, (_args, input) => issueConnectionResponse(input, []));
  assert.deepEqual(empty.repositoryIssues().issues, []);
});

void test("GraphQL repository inventory rejects incomplete malformed duplicate and foreign inventories", () => {
  const corruptions: ((repository: Record<string, unknown>, marker: boolean) => void)[] = [
    (repository) => {
      repository.id = "";
    },
    (repository) => {
      repository.nameWithOwner = "foreign/repository";
    },
    (repository, marker) => {
      if (!marker) repository.id = "R_changed";
    },
    (repository, marker) => {
      if (!marker) fixtureObject(repository.issues).totalCount = 3;
    },
    (repository, marker) => {
      if (!marker) fixtureObject(repository.issues).nodes = [];
    },
    (repository, marker) => {
      if (!marker) fixtureObject(repository.issues).pageInfo = {};
    },
    (repository, marker) => {
      if (!marker)
        fixtureObject(repository.issues).pageInfo = { hasNextPage: true, endCursor: "stalled" };
    },
    (repository, marker) => {
      if (!marker) {
        const nodes = fixtureObject(repository.issues).nodes;
        assert.ok(Array.isArray(nodes));
        fixtureObject(nodes[1]).id = fixtureObject(nodes[0]).id;
      }
    },
    (repository, marker) => {
      if (!marker) {
        const nodes = fixtureObject(repository.issues).nodes;
        assert.ok(Array.isArray(nodes));
        fixtureObject(nodes[0]).number = 2;
        fixtureObject(nodes[0]).url = "https://github.com/boburning/portcove/issues/2";
      }
    },
    (repository, marker) => {
      if (!marker) {
        const nodes = fixtureObject(repository.issues).nodes;
        assert.ok(Array.isArray(nodes));
        fixtureObject(nodes[0]).url = "https://github.com/foreign/repository/issues/1";
      }
    },
    (repository, marker) => {
      if (marker) fixtureObject(repository.issues).nodes = [{}];
    },
  ];
  for (const corrupt of corruptions) {
    const client = new RoadmapClient(config, (_args, input) =>
      issueConnectionResponse(input, [1, 2], 2, (repository) =>
        corrupt(repository, fixtureGraphql(input).query.includes("RepositoryIssueMarker")),
      ),
    );
    assert.throws(() => client.repositoryIssues(), /inventory|pagination/);
  }
});

void test("GraphQL repository inventory rejects changed totals or latest identities at final readback", () => {
  for (const change of ["total", "identity"]) {
    let markers = 0;
    const client = new RoadmapClient(config, (_args, input) => {
      const marker = fixtureGraphql(input).query.includes("RepositoryIssueMarker");
      if (marker) markers++;
      return issueConnectionResponse(input, [1, 2], 2, (repository) => {
        if (marker && markers === 2) {
          const connection = fixtureObject(repository.issues);
          if (change === "total") connection.totalCount = 3;
          else connection.nodes = [{ id: "I_replaced", number: 2 }];
        }
      });
    });
    assert.throws(() => client.repositoryIssues(), /inventory changed/);
  }
});

void test("GraphQL repository markers reject null IDs for a nonempty inventory", () => {
  const client = new RoadmapClient(config, (_args, input) =>
    issueConnectionResponse(input, [1, 2], 2, (repository) => {
      if (fixtureGraphql(input).query.includes("RepositoryIssueMarker"))
        fixtureObject(repository.issues).nodes = [{ id: null, number: 3 }];
    }),
  );
  assert.throws(() => client.repositoryIssues(), /invalid repository issue marker/);
});

void test("Project membership refuses malformed or stalled coverage before mutation", () => {
  const cases = [
    () => ({ totalCount: 0, nodes: [], pageInfo: {} }),
    () => ({ totalCount: 1, nodes: [], pageInfo: { hasNextPage: true, endCursor: "" } }),
    (read: number) => ({
      totalCount: 4,
      nodes: [{ id: `I_${read}`, project: { id: "OTHER" } }],
      pageInfo: { hasNextPage: true, endCursor: "repeated" },
    }),
  ];
  for (const page of cases) {
    let reads = 0,
      mutations = 0;
    const client = new RoadmapClient(config, (args, input) => {
      const project = fixtureProjectDetails(args, input, "P_selected");
      if (project !== undefined) return project;
      if (args[0] === "project" && args[1] === "field-list") return JSON.stringify({ fields: [] });
      if (input?.includes("addProjectV2ItemById")) {
        mutations++;
        return JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "I_new" } } } });
      }
      assert.ok(++reads <= 3, "fixture read budget exceeded");
      return JSON.stringify({ data: { node: { projectItems: page(reads) } } });
    });
    assert.throws(() => client.ensureIssueItem("I_source"), /incomplete GitHub inventory/);
    assert.equal(mutations, 0);
  }
});

void test("RoadmapClient reuses an existing issue item instead of duplicating it", () => {
  const calls: RunnerCall[] = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    const project = fixtureProjectDetails(args, input, "PVT_project", 7);
    if (project !== undefined) return project;
    if (args[1] === "field-list") return JSON.stringify({ fields: [] });
    if (args[0] === "api" && args[1] === "graphql") {
      const after = fixtureGraphql(input).variables.after;
      return JSON.stringify({
        data: {
          node: {
            projectItems: after
              ? {
                  totalCount: 2,
                  nodes: [{ id: "PVTI_existing", project: { id: "PVT_project" } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                }
              : {
                  totalCount: 2,
                  nodes: [{ id: "PVTI_other", project: { id: "OTHER" } }],
                  pageInfo: { hasNextPage: true, endCursor: "page2" },
                },
          },
        },
      });
    }
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  assert.deepEqual(client.ensureIssueItem("I_existing"), {
    id: "PVTI_existing",
    project: { id: "PVT_project" },
  });
  assert.equal(calls.filter((call) => call.input?.includes("addProjectV2ItemById")).length, 0);
  assert.equal(calls.filter((call) => call.input?.includes("projectItems(first: 100")).length, 2);
});

void test("complete Project context reads every field page with opaque identity checks", () => {
  const calls: RunnerCall[] = [];
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    if (args[2] === "users/boburning") return JSON.stringify({ type: "User" });
    const request = fixtureGraphql(input);
    const after = request.variables.after;
    return JSON.stringify({
      data: {
        user: {
          projectV2: {
            id: "PVT",
            number: 1,
            title: "Portcove Roadmap",
            url: "https://github.test/project/1",
            public: true,
            closed: false,
            fields: {
              totalCount: 2,
              nodes: [
                {
                  id: after ? "F2" : "F1",
                  name: after ? "Priority" : "Status",
                  dataType: "SINGLE_SELECT",
                  options: [],
                },
              ],
              pageInfo: after
                ? { hasNextPage: false, endCursor: null }
                : { hasNextPage: true, endCursor: "field-page-2" },
            },
          },
        },
      },
    });
  };
  const context = new RoadmapClient(config, runner).completeProjectContext(1);
  assert.deepEqual(
    context.fields.map((field) => field.id),
    ["F1", "F2"],
  );
  assert.equal(calls.filter((call) => call.input).length, 2);
});

void test("GraphQL Project item pagination reads every item with normalized fields", () => {
  const calls: RunnerCall[] = [];
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    const project = fixtureProjectDetails(args, input, "PVT");
    if (project !== undefined) return project;
    const after = fixtureGraphql(input).variables.after;
    const item = after
      ? {
          id: "I2",
          content: {
            __typename: "DraftIssue",
            id: "DI_second",
            updatedAt: "2026-10-17T00:00:00Z",
            body: "Draft",
            title: "Second",
          },
          fieldValues: {
            totalCount: 1,
            nodes: [{ name: "Inbox", field: { name: "Status" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }
      : {
          id: "I1",
          content: {
            __typename: "Issue",
            id: "I_1",
            updatedAt: "2026-10-17T00:00:00Z",
            number: 1,
            title: "First",
            body: "Issue",
            url: "https://github.com/boburning/portcove/issues/1",
            state: "OPEN",
          },
          fieldValues: {
            totalCount: 1,
            nodes: [{ name: "Port", field: { name: "Work type" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
    return JSON.stringify({
      data: {
        node: {
          items: {
            totalCount: 2,
            nodes: [item],
            pageInfo: after
              ? { hasNextPage: false, endCursor: null }
              : { hasNextPage: true, endCursor: "next" },
          },
        },
      },
    });
  };
  const items = new RoadmapClient(config, runner).itemList(1);
  assert.deepEqual(
    items.map((item) => [item.id, item.title, item.type]),
    [
      ["I1", "First", "Issue"],
      ["I2", "Second", "DraftIssue"],
    ],
  );
  assert.equal(fieldValue(items[0], "Work type"), "Port");
  assert.equal(fieldValue(items[1], "Status"), "Inbox");
  assert.equal(calls.filter((call) => call.input?.includes("items(first: 50")).length, 2);
});

void test("Project item inventory rejects a truncated nested field connection", () => {
  const runner: GitHubRunner = (args, input) => {
    const project = fixtureProjectDetails(args, input, "PVT");
    if (project !== undefined) return project;
    return JSON.stringify({
      data: {
        node: {
          items: {
            totalCount: 1,
            nodes: [
              {
                id: "I1",
                content: {
                  __typename: "DraftIssue",
                  id: "DI_1",
                  title: "Draft",
                  body: "",
                  updatedAt: "2026-10-17T00:00:00Z",
                },
                fieldValues: {
                  totalCount: 2,
                  nodes: [{ name: "Ready", field: { name: "Status" } }],
                  pageInfo: { hasNextPage: true, endCursor: "field-page" },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
  };
  assert.throws(() => new RoadmapClient(config, runner).itemList(1), /fields are truncated/);
});

void test("the Project reader preserves full bodies and all pages above the ordinary transport limit", () => {
  const node = (number: number) => ({
    id: `PVTI_${number}`,
    content: {
      __typename: "Issue",
      id: `I_${number}`,
      title: "Fixture",
      url: `https://github.com/boburning/portcove/issues/${number}`,
      state: "OPEN",
      updatedAt: "2026-10-17T00:00:00Z",
      number,
      body: "x".repeat(22000),
    },
    fieldValues: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  });
  const first = Array.from({ length: 50 }, (_, i) => node(i + 1));
  const last = [node(51)];
  for (const failedLastPage of [false, true]) {
    const cursors: unknown[] = [];
    const bytes: number[] = [];
    const run = createGitHubRunner({
      spawn: (_command, args, options) => {
        assert.equal(args[0], "api");
        const request = fixtureGraphql(options.input);
        assert.match(request.query, /items\(first: 50/);
        assert.doesNotMatch(request.query, /mutation/);
        const cursor = request.variables.after;
        cursors.push(cursor);
        const output = JSON.stringify({
          data: {
            node: {
              items: {
                totalCount: 51,
                nodes: cursor ? last : first,
                pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : "page-two" },
              },
            },
          },
        });
        bytes.push(Buffer.byteLength(output));
        if (cursor && failedLastPage)
          return {
            error: Object.assign(new Error("private partial response"), { code: "ENOBUFS" }),
            status: 0,
            stdout: output,
            stderr: "private diagnostics",
          };
        return spawnSync(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
          ...options,
          input: output,
        });
      },
    });
    const client = new RoadmapClient(config, run);
    const collect = () => client.itemList(1, { details: { id: "PVT" } });
    if (failedLastPage) assert.throws(collect, /collection limit/);
    else {
      const items = collect();
      assert.equal(items.length, 51);
      assert.equal(new Set(items.map((item) => item.id)).size, 51);
      assert.deepEqual(
        items.map(({ id, content }) => ({ id, content })),
        [...first, ...last].map(({ id, content }) => ({
          id,
          content: { ...content, type: "Issue" },
        })),
      );
    }
    assert.deepEqual(cursors, [null, "page-two"]);
    assert.ok(fixtureElement(bytes, 0) > 1024 * 1024);
    assert.equal(first.length, 50);
    assert.equal(fixtureElement(first, 0).content.body.length, 22000);
  }
});

void test("GraphQL failures retain provider quota and reset evidence", () => {
  const runner: GitHubRunner = () =>
    included(
      {
        data: null,
        errors: [{ message: "API rate limit exceeded" }],
      },
      {
        "x-ratelimit-resource": "graphql",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-used": "5000",
        "x-ratelimit-reset": "1789524000",
      },
    );
  assert.throws(
    () => new RoadmapClient(config, runner).graphql("query { viewer { login } }"),
    /0 points remain.*reset at/,
  );
});
for (const kind of ["items"]) {
  const node = (value: number) => ({
    id: `PVTI_${value}`,
    content: {
      __typename: "DraftIssue",
      id: `DI_${value}`,
      title: "Draft",
      body: "",
      updatedAt: "2026-10-17T00:00:00Z",
    },
    fieldValues: {
      totalCount: 0,
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  const page = (numbers: readonly number[], totalCount: number, cursor: string | null = null) => ({
    nodes: numbers.map(node),
    totalCount,
    pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
  });
  function readPages(pages: readonly unknown[]) {
    let index = 0;
    const client = new RoadmapClient(config, (args, input) => {
      const project = fixtureProjectDetails(args, input, "PVT");
      if (project !== undefined) return project;
      assert.match(fixtureGraphql(input).query, /totalCount/);
      const current = pages[index++];
      if (current instanceof Error) throw current;
      assert.ok(index <= pages.length, "reader must stop before exhausting the fixture");
      return JSON.stringify({ data: { node: { items: current } } });
    });
    return client.itemList(1);
  }

  void test(`${kind} inventory accepts an empty connection`, () => {
    assert.deepEqual(readPages([page([], 0)]), []);
  });
  void test(`${kind} inventory accepts an exact page boundary`, () => {
    const size = 50;
    assert.equal(
      readPages([
        page(
          Array.from({ length: size }, (_, i) => i + 1),
          size,
        ),
      ]).length,
      size,
    );
  });
  const failures: readonly (readonly [string, readonly unknown[]])[] = [
    ["missing connection", [null]],
    ["missing nodes", [{ totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } }]],
    ["missing pagination", [{ nodes: [], totalCount: 0 }]],
    ["missing total", [{ ...page([], 0), totalCount: undefined }]],
    ["invalid total", [page([], -1)]],
    [
      "invalid hasNextPage",
      [{ ...page([], 0), pageInfo: { hasNextPage: "false", endCursor: null } }],
    ],
    ["missing cursor", [{ ...page([1], 2), pageInfo: { hasNextPage: true, endCursor: null } }]],
    ["repeated cursor", [page([1], 3, "next"), page([2], 3, "next")]],
    ["cursor cycle", [page([1], 4, "a"), page([2], 4, "b"), page([3], 4, "a")]],
    ["empty intermediate page", [page([], 1, "next")]],
    ["duplicate records", [page([1], 2, "next"), page([1], 2)]],
    ["null record", [{ ...page([], 1), nodes: [null] }]],
    ["missing identity", [{ ...page([], 1), nodes: [{}] }]],
    ["short total", [page([1], 2)]],
    ["excess records", [page([1, 2], 1)]],
    ["changing total", [page([1], 2, "next"), page([2], 3)]],
    ["missing final page", [page([1], 2, "next"), null]],
    ["failed final request", [page([1], 2, "next"), new Error("API unavailable")]],
  ];
  for (const [reason, pages] of failures) {
    void test(`${kind} inventory rejects ${reason}`, () => {
      assert.throws(() => readPages(pages), /inventory|API unavailable/);
    });
  }
}
