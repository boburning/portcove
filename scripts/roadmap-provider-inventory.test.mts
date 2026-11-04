import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiError } from "./github-operation.mts";
import { readDoctorRepositoryIssues, runDoctor, fieldValue } from "./roadmap.mts";
import { doctorFailureDiagnostics } from "./roadmap-scoped.mts";
import {
  fixtureValue,
  fixtureElement,
  fixtureObject,
  config,
  sdkRoadmap,
  projectData,
} from "./fixtures/roadmap-fixtures.mts";

function issueConnectionResponse(
  query: string,
  numbers: number[],
  total = numbers.length,
  modify?: (repository: Record<string, unknown>) => void,
) {
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
  return { repository };
}

void test("doctor requires count-verified inventory even when a truncated REST marker exists", async () => {
  let restReads = 0;
  const client = await sdkRoadmap(config, {
    graphql: (query) => issueConnectionResponse(query, [1, 2, 3]),
    rest() {
      restReads++;
      throw new Error("REST cannot supply complete GraphQL coverage");
    },
  });
  const result = await readDoctorRepositoryIssues(client);
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

void test("doctor retains a failed logical GraphQL observation without collection replay", async () => {
  let reads = 0;
  const attempts: Parameters<typeof readDoctorRepositoryIssues>[1] = [];
  const client = {
    config,
    async repositoryIssues() {
      reads++;
      throw new Error("transport unavailable");
    },
  };
  await assert.rejects(readDoctorRepositoryIssues(client, attempts), /transport unavailable/);
  assert.equal(reads, 1);
  assert.equal(attempts.length, 1);
  assert.equal(fixtureValue(attempts[0]).source, "graphql");
  assert.equal(fixtureValue(attempts[0]).outcome, "failed");
});

void test("doctor records one complete empty GraphQL observation", async () => {
  const client = await sdkRoadmap(config, {
    graphql: (query) => issueConnectionResponse(query, []),
  });
  const result = await readDoctorRepositoryIssues(client);
  assert.deepEqual(result.issues, []);
  assert.equal(result.attempts[0]?.issues, 0);
});

void test("global doctor retains provider quota and authentication failures before planning", async () => {
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
    let sends = 0;
    const refused = () => {
      sends++;
      return Response.json(failure.body, {
        status: failure.status,
        headers: {
          "x-ratelimit-resource": failure.stage === "owner" ? "core" : "graphql",
          "x-ratelimit-remaining": String(failure.remaining),
          "x-ratelimit-reset": String(resetSeconds),
        },
      });
    };
    const client = await sdkRoadmap(config, {
      rest({ endpoint }) {
        assert.equal(endpoint, `users/${config.owner}`);
        if (failure.stage === "owner") return refused();
        sends++;
        return { type: "User", node_id: "OWNER" };
      },
      graphql(query) {
        assert.match(query, /projectV2\(number:.*fields\(/u);
        return refused();
      },
    });
    assert.equal("gh" in client, false);
    const attempts: Parameters<typeof readDoctorRepositoryIssues>[1] = [];
    await assert.rejects(
      runDoctor(config, client, { quiet: true, repositoryIssueInventoryAttempts: attempts }),
      (error) => {
        assert.ok(error instanceof GitHubApiError);
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
    assert.equal(sends, failure.stage === "owner" ? 1 : 2);
    assert.equal(client.observations.length, sends);
    assert.equal(client.observations.at(-1)?.failure, failure.code);
    assert.deepEqual(attempts, []);
  }
});

void test("runDoctor retains an incomplete repository observation for its receipt", async () => {
  let traversals = 0;
  const client = await sdkRoadmap(config, {
    graphql(query) {
      if (query.includes("RepositoryIssueInventory")) traversals++;
      return issueConnectionResponse(query, [1], 3);
    },
  });
  const attempts: Parameters<typeof readDoctorRepositoryIssues>[1] = [];
  const doctor = Object.assign(client, {
    async completeProjectContext() {
      return { number: 1, details: { id: "P" }, fields: [] };
    },
    async viewList() {
      return [];
    },
    async projectAudit() {
      return {
        id: "P",
        updatedAt: "2026-10-22T00:00:00Z",
        items: { totalCount: 0 },
        repositories: { nodes: [] },
      };
    },
    async itemList() {
      return [];
    },
  });
  await assert.rejects(
    runDoctor(config, doctor, { quiet: true, repositoryIssueInventoryAttempts: attempts }),
    /record count does not match total/,
  );
  assert.equal(traversals, 1);
  assert.deepEqual(
    attempts.map((entry) => entry.outcome),
    ["failed"],
  );
  assert.equal(attempts[0]?.source, "graphql");
});

void test("GraphQL repository inventory reads every page and binds repository and latest issue", async () => {
  const cursors: unknown[] = [];
  const client = await sdkRoadmap(config, {
    graphql(query, variables) {
      if (query.includes("RepositoryIssueMarker")) return issueConnectionResponse(query, [1, 2], 2);
      cursors.push(variables.after);
      return issueConnectionResponse(
        query,
        variables.after === null ? [1] : [2],
        2,
        (repository) => {
          if (variables.after === null)
            fixtureObject(repository.issues).pageInfo = { hasNextPage: true, endCursor: "second" };
        },
      );
    },
  });
  assert.deepEqual(
    (await client.repositoryIssues()).issues.map((issue) => issue.number),
    [1, 2],
  );
  assert.deepEqual(cursors, [null, "second"]);
  const empty = await sdkRoadmap(config, {
    graphql: (query) => issueConnectionResponse(query, []),
  });
  assert.deepEqual((await empty.repositoryIssues()).issues, []);
});

void test("GraphQL repository inventory rejects incomplete malformed duplicate and foreign inventories", async () => {
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
    const client = await sdkRoadmap(config, {
      graphql: (query) =>
        issueConnectionResponse(query, [1, 2], 2, (repository) =>
          corrupt(repository, query.includes("RepositoryIssueMarker")),
        ),
    });
    await assert.rejects(client.repositoryIssues(), /inventory|pagination/);
  }
});

void test("GraphQL repository inventory rejects changed totals or latest identities at final readback", async () => {
  for (const change of ["total", "identity"]) {
    let markers = 0;
    const client = await sdkRoadmap(config, {
      graphql(query) {
        const marker = query.includes("RepositoryIssueMarker");
        if (marker) markers++;
        return issueConnectionResponse(query, [1, 2], 2, (repository) => {
          if (marker && markers === 2) {
            const connection = fixtureObject(repository.issues);
            if (change === "total") connection.totalCount = 3;
            else connection.nodes = [{ id: "I_replaced", number: 2 }];
          }
        });
      },
    });
    await assert.rejects(client.repositoryIssues(), /inventory changed/);
  }
});

void test("GraphQL repository markers reject null IDs for nonempty inventory", async () => {
  const client = await sdkRoadmap(config, {
    graphql: (query) =>
      issueConnectionResponse(query, [1, 2], 2, (repository) => {
        if (query.includes("RepositoryIssueMarker"))
          fixtureObject(repository.issues).nodes = [{ id: null, number: 3 }];
      }),
  });
  await assert.rejects(client.repositoryIssues(), /invalid repository issue marker/);
});

void test("Project membership refuses malformed or stalled coverage before mutation", async () => {
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
    const client = await sdkRoadmap(config, {
      allowMutations: true,
      graphql(query) {
        if (query.includes("projectV2(number:")) return projectData("P_selected");
        if (query.startsWith("mutation")) {
          mutations++;
          throw new Error("Unexpected mutation");
        }
        assert.ok(++reads <= 3);
        return { node: { projectItems: page(reads) } };
      },
    });
    await assert.rejects(client.ensureIssueItem("I_source"), /incomplete GitHub inventory/);
    assert.equal(mutations, 0);
  }
});

void test("existing issue membership is reused after complete pagination", async () => {
  const cursors: unknown[] = [];
  let mutations = 0;
  const selected = structuredClone(config);
  selected.project.number = 7;
  const client = await sdkRoadmap(selected, {
    allowMutations: true,
    graphql(query, variables) {
      if (query.includes("projectV2(number:")) return projectData("PVT_project", 7);
      if (query.startsWith("mutation")) {
        mutations++;
        throw new Error("Unexpected mutation");
      }
      cursors.push(variables.after);
      return {
        node: {
          projectItems: {
            totalCount: 2,
            nodes: variables.after
              ? [{ id: "PVTI_existing", project: { id: "PVT_project" } }]
              : [{ id: "PVTI_other", project: { id: "OTHER" } }],
            pageInfo: {
              hasNextPage: !variables.after,
              endCursor: variables.after ? null : "page2",
            },
          },
        },
      };
    },
  });
  assert.deepEqual(await client.ensureIssueItem("I_existing"), {
    id: "PVTI_existing",
    project: { id: "PVT_project" },
  });
  assert.equal(mutations, 0);
  assert.deepEqual(cursors, [null, "page2"]);
});

void test("complete Project context reads every field page with opaque identity checks", async () => {
  const cursors: unknown[] = [];
  const client = await sdkRoadmap(config, {
    graphql(_query, variables) {
      cursors.push(variables.after);
      const data = projectData("PVT", 1, [
        {
          id: variables.after ? "F2" : "F1",
          name: variables.after ? "Priority" : "Status",
          dataType: "SINGLE_SELECT",
          options: [],
        },
      ]);
      data.user.projectV2.fields.totalCount = 2;
      data.user.projectV2.fields.pageInfo = variables.after
        ? { hasNextPage: false, endCursor: null }
        : { hasNextPage: true, endCursor: "field-page-2" };
      return data;
    },
  });
  assert.deepEqual(
    (await client.completeProjectContext(1)).fields.map((field) => field.id),
    ["F1", "F2"],
  );
  assert.deepEqual(cursors, [null, "field-page-2"]);
});

const emptyFields = () => ({
  totalCount: 0,
  nodes: [],
  pageInfo: { hasNextPage: false, endCursor: null },
});
function draft(number: number) {
  return {
    id: `PVTI_${number}`,
    content: {
      __typename: "DraftIssue",
      id: `DI_${number}`,
      title: "Draft",
      body: "",
      updatedAt: "2026-10-17T00:00:00Z",
    },
    fieldValues: emptyFields(),
  };
}
function page(numbers: readonly number[], totalCount: number, cursor: string | null = null) {
  return {
    nodes: numbers.map(draft),
    totalCount,
    pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
  };
}
async function readPages(pages: readonly unknown[]) {
  let index = 0;
  const client = await sdkRoadmap(config, {
    graphql(query) {
      if (query.includes("projectV2(number:")) return projectData("PVT");
      assert.match(query, /totalCount/);
      const current = pages[index++];
      if (current instanceof Error) throw current;
      assert.ok(index <= pages.length, "reader must stop before exhausting the fixture");
      return { node: { items: current } };
    },
  });
  return client.itemList(1);
}

void test("GraphQL Project item pagination preserves full content and normalized fields", async () => {
  const first = {
    id: "I1",
    content: {
      __typename: "Issue",
      id: "I_1",
      updatedAt: "2026-10-17T00:00:00Z",
      number: 1,
      title: "First",
      body: "Issue",
      url: `https://github.com/${config.repository}/issues/1`,
      state: "OPEN",
    },
    fieldValues: {
      totalCount: 1,
      nodes: [{ name: "Port", field: { name: "Work type" } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  const second = {
    ...draft(2),
    content: { ...draft(2).content, title: "Second", body: "Draft" },
    fieldValues: {
      totalCount: 1,
      nodes: [{ name: "Inbox", field: { name: "Status" } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  const items = await readPages([
    { totalCount: 2, nodes: [first], pageInfo: { hasNextPage: true, endCursor: "next" } },
    { totalCount: 2, nodes: [second], pageInfo: { hasNextPage: false, endCursor: null } },
  ]);
  assert.deepEqual(
    items.map((item) => [item.id, item.title, item.type]),
    [
      ["I1", "First", "Issue"],
      ["PVTI_2", "Second", "DraftIssue"],
    ],
  );
  assert.equal(fieldValue(items[0], "Work type"), "Port");
  assert.equal(fieldValue(items[1], "Status"), "Inbox");
});

void test("Project item inventory rejects truncated nested field coverage", async () => {
  const item = draft(1);
  const malformed = {
    ...item,
    fieldValues: {
      totalCount: 2,
      nodes: [{ name: "Ready", field: { name: "Status" } }],
      pageInfo: { hasNextPage: true, endCursor: "field-page" },
    },
  };
  await assert.rejects(
    readPages([
      { totalCount: 1, nodes: [malformed], pageInfo: { hasNextPage: false, endCursor: null } },
    ]),
    /fields are truncated/,
  );
});

void test("Project inventory retains full bodies above one MiB and rejects a failed later stream", async () => {
  const node = (number: number) => ({
    id: `PVTI_${number}`,
    content: {
      __typename: "Issue",
      id: `I_${number}`,
      title: "Fixture",
      url: `https://github.com/${config.repository}/issues/${number}`,
      state: "OPEN",
      updatedAt: "2026-10-17T00:00:00Z",
      number,
      body: "x".repeat(22000),
    },
    fieldValues: emptyFields(),
  });
  const first = Array.from({ length: 50 }, (_, i) => node(i + 1)),
    last = [node(51)];
  for (const failedLastPage of [false, true]) {
    const cursors: unknown[] = [],
      bytes: number[] = [];
    const client = await sdkRoadmap(config, {
      graphql(query, variables) {
        assert.match(query, /items\(first: 50/);
        assert.doesNotMatch(query, /mutation/);
        const cursor = variables.after;
        cursors.push(cursor);
        const data = {
          node: {
            items: {
              totalCount: 51,
              nodes: cursor ? last : first,
              pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : "page-two" },
            },
          },
        };
        bytes.push(Buffer.byteLength(JSON.stringify({ data })));
        if (cursor && failedLastPage) {
          let sent = false;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sent) controller.error(new Error("failing provider response stream"));
                else {
                  sent = true;
                  controller.enqueue(new TextEncoder().encode('{"data":'));
                }
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return data;
      },
    });
    const collect = () => client.itemList(1, { details: { id: "PVT" } });
    if (failedLastPage) await assert.rejects(collect(), (error) => error instanceof GitHubApiError);
    else {
      const items = await collect();
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
  }
});

void test("GraphQL failures retain provider quota and reset evidence", async () => {
  const client = await sdkRoadmap(config, {
    graphql: () =>
      Response.json(
        { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
        {
          headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-used": "5000",
            "x-ratelimit-reset": "1789524000",
          },
        },
      ),
  });
  await assert.rejects(client.graphql("query { viewer { login } }"), (error) => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.rateLimit?.remaining, 0);
    assert.equal(error.rateLimit?.resetAt, new Date(1789524000 * 1000).toISOString());
    return true;
  });
});

for (const kind of ["items"]) {
  void test(`${kind} inventory accepts an empty connection`, async () => {
    assert.deepEqual(await readPages([page([], 0)]), []);
  });
  void test(`${kind} inventory accepts an exact page boundary`, async () => {
    assert.equal(
      (
        await readPages([
          page(
            Array.from({ length: 50 }, (_, i) => i + 1),
            50,
          ),
        ])
      ).length,
      50,
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
    void test(`${kind} inventory rejects ${reason}`, async () => {
      await assert.rejects(async () => await readPages(pages), /inventory|API unavailable/);
    });
  }
}
