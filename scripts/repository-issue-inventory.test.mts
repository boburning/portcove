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
import { GitHubApiError } from "./github-operation.mts";
import { sdkRoadmap } from "./fixtures/roadmap-fixtures.mts";
import {
  runDoctor,
  doctorProjectItems,
  readMixedDoctorProject,
  validateConfig,
} from "./roadmap.mts";
import { renderPortIssueBody } from "./roadmap-issue.mts";
import { DiscoveryBudget } from "./discovery-budget.mts";

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
    async graphql(query, variables = {}) {
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

void test("doctor proves Project coverage from fresh reverse memberships without the failing listing", async () => {
  const f = readerFixture(2, (value, marker) => {
    if (marker) return;
    for (const row of connection(value).nodes) {
      row.blockedBy = {
        totalCount: 0,
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
      row.projectItems = {
        totalCount: 1,
        nodes: [
          {
            id: `ITEM_${String(row.number)}`,
            project: { id: "P" },
            isArchived: false,
            fieldValues: {
              totalCount: 0,
              edges: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
    }
  });
  let listings = 0;
  const client = {
    ...f.reader,
    completeProjectContext: async () => ({ details: { id: "P" }, fields: [] }),
    viewList: async () => [],
    projectAudit: async () => ({
      id: "P",
      updatedAt: "2026-10-22T00:00:00Z",
      items: { totalCount: 2 },
      repositories: { nodes: [] },
    }),
    itemList: async () => {
      listings++;
      throw new Error("Project listing unavailable");
    },
    async repositoryIssues(options?: { projectMemberships?: boolean }) {
      return await collectRepositoryIssueInventory(this, options);
    },
  };
  await assert.rejects(
    runDoctor(config, client, { quiet: true }),
    (error) => error instanceof Error && Array.isArray(Reflect.get(error, "doctorErrors")),
  );
  assert.equal(listings, 0);
  assert.equal(f.requests(), 3, "one repository traversal, with its two markers");
  assert.ok(f.queries.some((q) => q.includes("projectItems(")));
});

function membershipFixture(change: (row: Record<string, unknown>) => void = () => {}) {
  return readerFixture(2, (value, marker) => {
    if (marker) return;
    for (const row of connection(value).nodes) {
      row.blockedBy = {
        totalCount: 0,
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
      row.projectItems = {
        totalCount: 1,
        nodes: [
          {
            id: `ITEM_${String(row.number)}`,
            project: { id: "P" },
            isArchived: false,
            fieldValues: {
              totalCount: 0,
              edges: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
      change(row);
    }
  });
}
void test("stable forward/reverse contradiction stops one whole read with retained counts before planning findings", async () => {
  const f = membershipFixture();
  let audits = 0;
  const client = {
    ...f.reader,
    completeProjectContext: async () => ({ details: { id: "P" }, fields: [] }),
    viewList: async () => [],
    projectAudit: async () => {
      audits++;
      return {
        id: "P",
        updatedAt: "2026-10-22T00:00:00Z",
        items: { totalCount: 1 },
        repositories: { nodes: [] },
      };
    },
    itemList: async () =>
      assert.fail("Contradictory coverage cannot trigger another complete listing"),
    async repositoryIssues(options?: { projectMemberships?: boolean }) {
      return await collectRepositoryIssueInventory(this, options);
    },
  };
  const attempts: DoctorReadAttempt[] = [];
  await assert.rejects(
    runDoctorRead({
      attempts,
      read: () => runDoctor(config, client, { quiet: true }),
      reset: () => assert.fail("Stable provider contradiction must not reset and retry"),
      admitRetry: () => assert.fail("Stable contradiction is not retryable"),
    }),
    (error) => {
      assert(error instanceof InventoryError);
      assert.equal(error.kind, "provider_inconsistent");
      assert.equal(Reflect.get(error, "doctorErrors"), undefined);
      assert.deepEqual(Reflect.get(error, "membershipMismatch"), {
        project_id: "P",
        listed_count: 1,
        issue_memberships: 2,
        item_ids: ["ITEM_1", "ITEM_2"],
      });
      return true;
    },
  );
  assert.equal(attempts.length, 1);
  assert.equal(f.requests(), 3);
  assert.equal(audits, 2);
});
void test("reverse membership proof requires live verified coverage and exact active cardinality", async () => {
  const f = membershipFixture();
  const inventory = await collectRepositoryIssueInventory(f.reader, { projectMemberships: true });
  assert.equal(doctorProjectItems(inventory, f.reader, "P", 2)?.length, 2);
  assert.equal(
    doctorProjectItems(inventory, f.reader, "P", 3),
    undefined,
    "unknown drafts or foreign items require full enumeration",
  );
  assert.throws(() => doctorProjectItems(inventory, f.reader, "P", 1), {
    code: "inventory_changed",
  });
  assert.throws(() => doctorProjectItems(inventory, f.reader, "P", null), {
    code: "inventory_incomplete",
  });
  assert.throws(() => doctorProjectItems({ ...inventory }, f.reader, "P", 2), {
    code: "inventory_incomplete",
  });
  assert.throws(() => doctorProjectItems(inventory, { ...f.reader }, "P", 2), {
    code: "inventory_incomplete",
  });
  assert.equal(inventory.evidence.project_memberships, 2);
  const scoped = membershipFixture((row) => {
    if (row.number === 1)
      (row.projectItems as { nodes: Record<string, unknown>[] }).nodes[0]!.isArchived = true;
  });
  const archived = await collectRepositoryIssueInventory(scoped.reader, {
    projectMemberships: true,
  });
  assert.equal(doctorProjectItems(archived, scoped.reader, "P", 1)?.[0]?.content?.number, 2);
  assert.equal(doctorProjectItems(archived, scoped.reader, "other-project", 1), undefined);
});
void test("a mixed Project reuses verified local bodies and fields and hydrates every exceptional row", async () => {
  const stamp = "2026-10-17T00:00:00Z";
  const f = membershipFixture((row) => {
    if (row.number === 1)
      (row.projectItems as { nodes: Record<string, unknown>[] }).nodes[0]!.updatedAt = stamp;
  });
  const issues = [1, 2].map((i) => ({
    id: `ITEM_${i}`,
    isArchived: false,
    updatedAt: stamp,
    content: {
      id: `I_${i}`,
      __typename: "Issue",
      number: i,
      title: `Issue ${i}`,
      url: `https://github.com/${repository}/issues/${i}`,
      state: "OPEN",
      updatedAt: stamp,
    },
  }));
  const draft = {
    id: "ITEM_D",
    isArchived: false,
    updatedAt: stamp,
    content: { id: "D", __typename: "DraftIssue", title: "Draft", updatedAt: stamp },
  };
  const foreign = {
    ...issues[1]!,
    id: "ITEM_F",
    content: {
      ...issues[1]!.content,
      id: "FOREIGN",
      url: "https://github.com/other/game/issues/2",
    },
  };
  const pr = {
    ...issues[1]!,
    id: "ITEM_PR",
    content: {
      ...issues[1]!.content,
      id: "PR",
      __typename: "PullRequest",
      url: `https://github.com/${repository}/pull/2`,
      merged: false,
    },
  };
  const listed = [issues[0]!, draft, foreign, pr, issues[1]!];
  let omitted = false;
  let alias = false;
  let moved = false;
  const calls: unknown[] = [];
  const client = {
    ...f.reader,
    config,
    async itemList(
      _number: number,
      options?: { itemIds?: readonly string[]; includeFields?: boolean },
    ) {
      calls.push(options?.itemIds ?? options?.includeFields);
      if (!options?.itemIds)
        return listed.map((row) =>
          alias && row.id === "ITEM_1"
            ? { ...row, content: { ...row.content, id: "incorrect" } }
            : row,
        );
      return listed
        .filter((row) => options.itemIds!.includes(row.id) && !(omitted && row.id === "ITEM_D"))
        .map((row) => ({
          ...row,
          updatedAt: moved ? "2026-10-18T00:00:00Z" : stamp,
          content: {
            ...row.content,
            blockedBy: { totalCount: 0, nodes: [] },
            body: row.id === "ITEM_D" ? "foreign draft body" : "body",
          },
          fieldValues: [],
        }));
    },
  };
  const inventory = await collectRepositoryIssueInventory(client, { projectMemberships: true });
  const read = () => readMixedDoctorProject(client, 1, { id: "P" }, inventory, listed.length);
  const rows = await read();
  assert.deepEqual(calls, [false, ["ITEM_D", "ITEM_F", "ITEM_PR", "ITEM_2"]]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.content?.body]),
    [
      ["ITEM_1", "body"],
      ["ITEM_D", "foreign draft body"],
      ["ITEM_F", "body"],
      ["ITEM_PR", "body"],
      ["ITEM_2", "body"],
    ],
  );
  assert.deepEqual(rows[0]?.content?.blockedBy, { totalCount: 0, nodes: [] });
  alias = true;
  await assert.rejects(read, /revisions differ/u);
  alias = false;
  omitted = true;
  await assert.rejects(read, /details are incomplete/u);
  omitted = false;
  moved = true;
  await assert.rejects(read, /changed during collection/u);
  moved = false;
  foreign.content.url = `https://github.com/${repository}/issues/2`;
  await assert.rejects(read, /membership disagree/u);
});

void test("same-second local Project fields and blockers must agree across the two live query shapes", async (t) => {
  const stamp = "2026-11-20T12:00:00Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(stamp) });
  const end = { hasNextPage: false, endCursor: null };
  const fields = [
    { field: { name: "Status" }, name: "Validating" },
    { field: { name: "Port stage" }, name: "Cataloged" },
  ];
  const blockers = [8, 9].map((n) => ({
    id: `I_${n}`,
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/${repository}/issues/${n}`,
    state: "OPEN",
  }));
  const localItems: Record<string, unknown>[] = [];
  const fixture = membershipFixture((row) => {
    const link = (row.projectItems as { nodes: Record<string, unknown>[] }).nodes[0]!;
    link.updatedAt = row.number === 1 ? stamp : row.updatedAt;
    if (row.number === 1) {
      link.fieldValues = {
        totalCount: fields.length,
        edges: fields.map((node, i) => ({ cursor: String(i), node })),
        pageInfo: end,
      };
      row.blockedBy = { totalCount: blockers.length, nodes: blockers, pageInfo: end };
    }
    const { id, number, title, url, state, updatedAt } = row;
    localItems.push({
      id: link.id,
      isArchived: false,
      updatedAt: link.updatedAt,
      content: { __typename: "Issue", id, number, title, url, state, updatedAt },
    });
  });
  const draft = {
    id: "D",
    isArchived: false,
    updatedAt: stamp,
    content: { __typename: "DraftIssue", id: "DI", title: "Draft", updatedAt: stamp },
  };
  let selectedFields = fields.toReversed(),
    selectedBlockers = blockers.toReversed();
  const client = await sdkRoadmap(config, {
    graphql(query, variables) {
      if (query.includes("RepositoryIssue")) return fixture.reader.graphql(query, variables);
      if (query.includes("DoctorProjectItemDetails")) {
        assert.deepEqual(variables.ids, ["ITEM_1", "D"]);
        assert.match(query, /blockedBy\(first: 100\)/u);
        return {
          nodes: [localItems[0]!, draft].map((row) => {
            const local = row.id === "ITEM_1";
            const values = local ? selectedFields : [];
            return {
              ...row,
              project: { id: "P" },
              content: {
                ...(row.content as Record<string, unknown>),
                body: "body",
                ...(local
                  ? { blockedBy: { totalCount: blockers.length, nodes: selectedBlockers } }
                  : {}),
              },
              fieldValues: { totalCount: values.length, nodes: values, pageInfo: end },
            };
          }),
        };
      }
      assert.match(query, /items\(first: 100/u);
      return { node: { items: { totalCount: 3, nodes: [...localItems, draft], pageInfo: end } } };
    },
  });
  const inventory = await collectRepositoryIssueInventory(client, { projectMemberships: true });
  assert.equal(Date.parse(inventory.evidence.started_at), Date.parse(stamp));
  const read = () => readMixedDoctorProject(client, 1, { id: "P" }, inventory, 3);
  assert.equal(
    (await read()).length,
    3,
    "Equivalent fields and blockers can arrive in a different order",
  );
  selectedFields = [fields[1]!, { ...fields[0]!, name: "Done" }];
  await assert.rejects(read, { code: "inventory_changed" });
  selectedFields = fields;
  selectedBlockers = [{ ...blockers[0]!, state: "CLOSED" }, blockers[1]!];
  await assert.rejects(read, { code: "inventory_changed" });
  selectedBlockers = [blockers[0]!];
  await assert.rejects(read, { code: "inventory_incomplete" });
});

void test("nested memberships and blockers cannot silently truncate or lose identity", async () => {
  for (const corrupt of [
    (row: Record<string, unknown>) => {
      row.projectItems = null;
    },
    (row: Record<string, unknown>) => {
      (row.projectItems as Record<string, unknown>).totalCount = 2;
    },
    (row: Record<string, unknown>) => {
      (row.projectItems as { pageInfo: Record<string, unknown> }).pageInfo.hasNextPage = true;
    },
    (row: Record<string, unknown>) => {
      (row.projectItems as { nodes: Record<string, unknown>[] }).nodes[0]!.id = "duplicate";
    },
    (row: Record<string, unknown>) => {
      (row.projectItems as { nodes: Record<string, unknown>[] }).nodes[0]!.project = { id: null };
    },
    (row: Record<string, unknown>) => {
      (row.projectItems as { nodes: Record<string, unknown>[] }).nodes[0]!.isArchived = null;
    },
    (row: Record<string, unknown>) => {
      row.blockedBy = { totalCount: 2, nodes: [] };
    },
  ]) {
    const f = membershipFixture(corrupt);
    await assert.rejects(
      async () => await collectRepositoryIssueInventory(f.reader, { projectMemberships: true }),
      InventoryError,
    );
  }
  const f = membershipFixture((row) => {
    (row.projectItems as { nodes: Record<string, unknown>[] }).nodes[0]!.fieldValues = {
      totalCount: 1,
      edges: [],
      pageInfo: { hasNextPage: true, endCursor: null },
    };
  });
  await assert.rejects(collectRepositoryIssueInventory(f.reader, { projectMemberships: true }), {
    code: "inventory_incomplete",
  });
});
void test("continues nested memberships, blockers and fields and refuses revision drift", async () => {
  const revision = "2026-10-17T00:00:00Z";
  const page = (nodes: unknown[], totalCount = nodes.length, endCursor: string | null = null) => ({
    nodes,
    totalCount,
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
  });
  const fieldPage = (
    edges: unknown[],
    totalCount = edges.length,
    endCursor: string | null = null,
  ) => ({
    edges,
    totalCount,
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
  });
  const blocker = (number: number) => ({
    id: `B_${number}`,
    number,
    title: "Blocker",
    url: `https://github.com/${repository}/issues/${number}`,
    state: "OPEN",
  });
  const fields = (number: number) => ({
    cursor: `F_${number}`,
    node: { name: "Ready", field: { name: `Field ${number}` } },
  });
  const link = (number: number) => ({
    id: `LINK_${number}`,
    project: { id: `P_${number}` },
    isArchived: false,
    updatedAt: revision,
    fieldValues: number === 11 ? fieldPage([fields(1)], 2, "F_1") : fieldPage([]),
  });
  for (const changed of [null, "issue", "project", "partial"] as const) {
    const fixture = readerFixture(1, (value, marker) => {
      if (marker) return;
      const row = connection(value).nodes[0]!;
      row.blockedBy = page([blocker(10)], 2, "block-after");
      row.projectItems = page(
        Array.from({ length: 10 }, (_, i) => link(i + 1)),
        11,
        "project-after",
      );
    });
    const seen: unknown[] = [];
    const reader: InventoryReader = {
      ...fixture.reader,
      async graphql(query, variables = {}) {
        if (query.includes("RepositoryProjectItemFields")) {
          seen.push(variables.after);
          return {
            node: {
              ...link(11),
              updatedAt: changed === "project" ? "2026-10-18T00:00:00Z" : revision,
              fieldValues: fieldPage([fields(2)], changed === "partial" ? 3 : 2),
            },
          };
        }
        if (query.includes("RepositoryIssueNested")) {
          seen.push(variables.after);
          return {
            node: {
              id: "I_1",
              updatedAt: changed === "issue" ? "2026-10-18T00:00:00Z" : revision,
              repository: { id: "R", nameWithOwner: repository },
              blockedBy: page([blocker(11)], 2),
              projectItems: page([link(11)], 11),
            },
          };
        }
        return await fixture.reader.graphql(query, variables);
      },
    };
    if (changed) {
      await assert.rejects(collectRepositoryIssueInventory(reader, { projectMemberships: true }), {
        code: "inventory_changed",
      });
      continue;
    }
    const result = await collectRepositoryIssueInventory(reader, { projectMemberships: true });
    assert.deepEqual(seen, ["block-after", "project-after", "F_1"]);
    assert.equal(result.issues[0]?.blockedBy?.nodes.length, 2);
    assert.equal(result.project_memberships?.length, 11);
    assert.deepEqual(result.project_memberships?.[10]?.fieldValues, {
      totalCount: 2,
      nodes: [fields(1).node, fields(2).node],
      pageInfo: { hasNextPage: false },
    });
  }
});

void test("doctor discards reverse membership proof on a changed or missing Project revision", async () => {
  for (const revision of [undefined, "invalid", "2026-10-23T00:00:00Z"]) {
    const f = membershipFixture();
    let audits = 0;
    const client = {
      ...f.reader,
      completeProjectContext: async () => ({ details: { id: "P" }, fields: [] }),
      viewList: async () => [],
      projectAudit: async () => ({
        id: "P",
        updatedAt: audits++ ? revision : "2026-10-22T00:00:00Z",
        items: { totalCount: 2 },
        repositories: { nodes: [] },
      }),
      itemList: async () => {
        throw new Error("must not enumerate the projected set again");
      },
      async repositoryIssues(options?: { projectMemberships?: boolean }) {
        return await collectRepositoryIssueInventory(this, options);
      },
    };
    await assert.rejects(runDoctor(config, client, { quiet: true }), {
      code: revision === "2026-10-23T00:00:00Z" ? "inventory_changed" : "inventory_incomplete",
    });
  }
});

void test("a slow full-Project fallback cannot promote a stale repository observation", async () => {
  const f = membershipFixture();
  const now = Date.now;
  const client = {
    ...f.reader,
    completeProjectContext: async () => ({ details: { id: "P" }, fields: [] }),
    viewList: async () => [],
    projectAudit: async () => ({
      id: "P",
      updatedAt: "2026-10-22T00:00:00Z",
      items: { totalCount: 3 },
      repositories: { nodes: [] },
    }),
    async repositoryIssues(options?: { projectMemberships?: boolean }) {
      return await collectRepositoryIssueInventory(this, options);
    },
    itemList: async () => {
      Date.now = () => now() + 120001;
      return [1, 2, 3].map((number) => ({
        id: `ITEM_${number}`,
        content: {
          __typename: "Issue",
          id: `I_${number}`,
          number,
          title: "Fixture",
          body: "",
          state: "OPEN",
          url: `https://github.com/${repository}/issues/${number}`,
          updatedAt: "2026-10-22T00:00:00Z",
        },
      }));
    },
  };
  try {
    await assert.rejects(
      runDoctor(config, client, { quiet: true }),
      (error) => error instanceof InventoryError && /fresh collector-verified/.test(error.message),
    );
  } finally {
    Date.now = now;
  }
});

void test("shared collector covers empty and exact pagination boundaries with bounded field selection", async () => {
  for (const count of [0, 1, 50, 51, 100, 101, 1001]) {
    for (const bodies of [false, true]) {
      const f = readerFixture(count);
      const got = await collectRepositoryIssueInventory(f.reader, { bodies });
      assert.equal(got.issues.length, count);
      assert.equal(f.requests(), Math.max(1, Math.ceil(count / (bodies ? 50 : 100))) + 2);
      assert.equal(requireRepositoryIssueInventory(got, f.reader, bodies), got);
      assert.ok(Object.isFrozen(got.issues));
      assert.ok(f.queries.every((query) => !query.includes("search(")));
      assert.equal(got.evidence.total, count);
    }
  }
});
void test("newest issue present cannot hide missing middle pages", async () => {
  const f = readerFixture(101, (value, marker) => {
    if (!marker) {
      const page = connection(value);
      page.nodes = page.nodes.filter((row) => row.number === 101);
      page.pageInfo.hasNextPage = false;
    }
  });
  await assert.rejects(async () => await collectRepositoryIssueInventory(f.reader), {
    code: "inventory_incomplete",
  });
});
void test("incomplete, malformed, duplicate, foreign and stalled observations fail closed", async () => {
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
    await assert.rejects(async () => await collectRepositoryIssueInventory(f.reader));
    assert.ok(f.requests() <= 4, "collector cannot retry a rejected page");
  }
});
void test("verified inventories reject cloning, wrong clients, metadata-as-bodies and tampered evidence", async () => {
  const f = readerFixture(1),
    got = await collectRepositoryIssueInventory(f.reader);
  assert.throws(() => requireRepositoryIssueInventory(structuredClone(got), f.reader));
  assert.throws(() => requireRepositoryIssueInventory(got, readerFixture(1).reader));
  await assert.rejects(async () =>
    requireRepositoryIssueInventory(
      await collectRepositoryIssueInventory(f.reader, { bodies: false }),
      f.reader,
    ),
  );
  got.evidence.total = 0;
  assert.throws(() => requireRepositoryIssueInventory(got, f.reader));
});
void test("stale inventory cannot establish live completeness", async () => {
  const f = readerFixture(0),
    now = Date.now;
  const got = await collectRepositoryIssueInventory(f.reader);
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
      completeProjectContext: async () => ({ details: { id: "P" }, fields: [] }),
      viewList: async () => [],
      projectAudit: async () => ({
        id: "P",
        updatedAt: "2026-10-22T00:00:00Z",
        items: { totalCount: 0 },
        repositories: { nodes: [] },
      }),
      itemList: async () => [],
      async repositoryIssues() {
        return await collectRepositoryIssueInventory(this);
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

void test("doctor cannot turn a self-consistent empty Project traversal into missing-issue findings", async () => {
  const f = readerFixture(0);
  const client = {
    ...f.reader,
    completeProjectContext: async () => ({ details: { id: "P" }, fields: [] }),
    viewList: async () => [],
    projectAudit: async () => ({
      id: "P",
      updatedAt: "2026-10-22T00:00:00Z",
      items: { totalCount: 900 },
      repositories: { nodes: [] },
    }),
    itemList: async () => [],
    async repositoryIssues() {
      return await collectRepositoryIssueInventory(this);
    },
  };
  await assert.rejects(
    runDoctor(config, client, { quiet: true }),
    (error) =>
      error instanceof InventoryError &&
      error.kind === "inventory_incomplete" &&
      /observed 0, independent count 900/.test(error.message),
  );
});

void test("doctor refuses redacted Project items even when all counts agree", async () => {
  const f = readerFixture(0);
  const client = {
    ...f.reader,
    completeProjectContext: async () => ({ details: { id: "P" }, fields: [] }),
    viewList: async () => [],
    projectAudit: async () => ({
      id: "P",
      updatedAt: "2026-10-22T00:00:00Z",
      items: { totalCount: 1 },
      repositories: { nodes: [] },
    }),
    itemList: async () => [{ id: "ITEM", content: null }],
    async repositoryIssues() {
      return await collectRepositoryIssueInventory(this);
    },
  };
  await assert.rejects(
    runDoctor(config, client, { quiet: true }),
    (error) =>
      error instanceof InventoryError &&
      error.kind === "inventory_incomplete" &&
      /Redacted Project content/.test(error.message),
  );
  assert.equal(
    f.requests(),
    3,
    "reuse the single repository observation before refusing Project coverage",
  );
});

void test("real Project reads and doctor reject malformed content before interpreting absence", async () => {
  const base = {
    __typename: "Issue",
    id: "I_1",
    number: 1,
    title: "Fixture",
    body: "",
    url: `https://github.com/${repository}/issues/1`,
    state: "OPEN",
    updatedAt: "2026-10-17T00:00:00Z",
  };
  for (const content of [
    null,
    {},
    { id: "I_1" },
    { ...base, id: "" },
    { ...base, __typename: "Unknown" },
    { ...base, body: null },
    { ...base, updatedAt: "invalid" },
    { ...base, number: 2 },
    { ...base, url: `https://github.com/${repository}/pull/1` },
    { ...base, state: "UNKNOWN" },
  ]) {
    const real = await sdkRoadmap(config, {
      graphql: () => ({
        node: {
          items: {
            totalCount: 1,
            nodes: [
              {
                id: "ITEM",
                content,
                fieldValues: {
                  totalCount: 0,
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    });
    await assert.rejects(async () => await real.itemList(1, { details: { id: "P" } }), {
      code: "inventory_incomplete",
    });
    const f = readerFixture(0);
    const client = {
      ...f.reader,
      completeProjectContext: async () => ({ details: { id: "P" }, fields: [] }),
      viewList: async () => [],
      projectAudit: async () => ({
        id: "P",
        updatedAt: "2026-10-22T00:00:00Z",
        items: { totalCount: 1 },
        repositories: { nodes: [] },
      }),
      itemList: real.itemList.bind(real),
      async repositoryIssues() {
        return await collectRepositoryIssueInventory(this);
      },
    };
    await assert.rejects(runDoctor(config, client, { quiet: true }), {
      code: "inventory_incomplete",
    });
    assert.equal(f.requests(), 3);
  }
});
void test("intake and normalization never mutate after incomplete collection", async () => {
  const f = readerFixture(3, (value, marker) => {
    if (!marker) connection(value).nodes.pop();
  });
  let writes = 0;
  const client = await sdkRoadmap(config, {
    graphql: () => {
      writes++;
      throw new Error("unexpected mutation");
    },
    allowMutations: true,
  });
  client.graphql = f.reader.graphql.bind(f.reader);
  client.repositoryIssue = async () => ({
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
  await assert.rejects(
    async () =>
      await client.createPortIssue({
        title: "Fixture",
        upstream: "https://example.test/engine",
        portKey: "fixture",
      }),
  );
  await assert.rejects(
    async () => await client.normalizePortIssue({ number: 1, catalog: { ports: [] } }),
  );
  assert.equal(writes, 0);
});
void test("HTTP-200 partial-data throttling is nonretryable and retains safe request metadata", async () => {
  const client = await sdkRoadmap(config, {
    graphql: () =>
      Response.json(
        {
          data: { repository: {} },
          errors: [{ type: "RATE_LIMITED", message: "throttled" }],
        },
        { headers: { "x-github-request-id": "REQUEST", "retry-after": "60" } },
      ),
  });
  await assert.rejects(
    client.graphql("query { rateLimit { cost } }"),
    (error) => error instanceof GitHubApiError && !retryableInventoryRead(error),
  );
  assert.equal(client.observations[0]?.request_id, "REQUEST");
  assert.ok(!JSON.stringify(client.observations).includes('"repository"'));
});
void test("oversized responses are rejected without reusing partial output", async () => {
  const client = await sdkRoadmap(config, {
    maxBytes: 32,
    graphql: () => ({ value: "x".repeat(64) }),
  });
  await assert.rejects(
    client.graphql("query { viewer { id } }"),
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
      graphql: async () => ({
        repository: { id: "R", nameWithOwner: repository, issues: { totalCount: 900 } },
        node: {
          id: "P",
          items: { totalCount: 900 },
          fields: { totalCount: 22 },
          views: { totalCount: 10 },
        },
        rateLimit: { cost: 1, remaining, resetAt: new Date(Date.now() + 60000).toISOString() },
      }),
    };
    assert.equal(await admitDoctorReadRetry(reader, "P", 1000), remaining === 1000);
    assert.equal(
      await admitDoctorReadRetry(reader, "P", 1000, 10, { deadline: performance.now() + 100 }),
      false,
    );
  }
});
void test("provider query points are distinct from requests and increase admission headroom", async () => {
  const budget = new DiscoveryBudget("ordinary");
  budget.observeGraphqlCost(15);
  budget.observeGraphqlCost(undefined);
  assert.equal(budget.usage.requests, 0);
  assert.equal(budget.usage.graphql_points_observed, 15);
  assert.equal(budget.usage.graphql_cost_unknown_requests, 1);
  await budget.reserveDelivery(2, 0);
  budget.observeProvider({
    resource: "graphql",
    remaining: 35,
    resetAt: new Date(Date.now() + 60000).toISOString(),
  });
  await assert.rejects(
    async () => await budget.requireProviderCapacity(1),
    /capacity unknown|reserve/,
  );
  assert.equal(budget.graphqlPointHeadroom, 15);
});

void test("failed HTTP responses retain backoff, request identity and received byte evidence", async () => {
  const body = JSON.stringify({ message: "temporarily unavailable" });
  const client = await sdkRoadmap(config, {
    graphql: () =>
      new Response(body, {
        status: 503,
        headers: {
          "retry-after": "60",
          "x-github-request-id": "failed-request",
          "x-ratelimit-remaining": "1000",
        },
      }),
  });
  await assert.rejects(
    client.graphql("query { viewer { id } }"),
    (error) => error instanceof GitHubApiError && !retryableInventoryRead(error),
  );
  assert.equal(client.observations[0]?.request_id, "failed-request");
  assert.equal(client.observations[0]?.bytes, Buffer.byteLength(body));
});
void test("retry admission refuses expired quota and query costs above original headroom", async () => {
  let resetAt = new Date(Date.now() + 60000).toISOString();
  const reader: InventoryReader = {
    config,
    graphql: async () => ({
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
  assert.equal(await admitDoctorReadRetry(reader, "P", 1), true);
  assert.equal(await admitDoctorReadRetry(reader, "P", 1, 30), false);
  resetAt = "2000-01-01T00:00:00Z";
  assert.equal(await admitDoctorReadRetry(reader, "P", 1), false);
});
void test("response byte observations preserve whitespace and Unicode rather than reserializing JSON", async () => {
  const body = '  { "data" : { "name" : "雪" } }\n';
  const client = await sdkRoadmap(config, {
    graphql: () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
  await client.graphql("query { viewer { id } }");
  assert.equal(client.observations[0]?.bytes, Buffer.byteLength(body));
});
