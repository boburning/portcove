import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { validateConfig } from "./roadmap.mts";
import { GitHubApiError } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import {
  MembershipReadbackClient,
  parseInventoryItems,
  readbackMemberships,
} from "./roadmap-membership-readback.mts";

const config = validateConfig(
  JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
const connection = <T,>(nodes: T[]) => ({
  totalCount: nodes.length,
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
function fixture() {
  const issues = [1, 2, 3].map((number) => ({
    id: `I${number}`,
    number,
    title: `Issue ${number}`,
    body: "Fixture only",
    state: "OPEN",
    updatedAt: "2026-10-23T10:00:00Z",
    url: `https://github.com/${config.repository}/issues/${number}`,
    __typename: "Issue",
  }));
  const items = issues.map((issue) => ({
    id: `PVTI_${issue.number}`,
    isArchived: issue.number === 3,
    project: { id: "PVT" },
    content: issue,
    fieldValues: connection([]),
  }));
  const forward: unknown[] = [
    ...items,
    {
      id: "PVTI_draft",
      isArchived: false,
      content: {
        id: "D1",
        __typename: "DraftIssue",
        title: "Draft",
        body: "",
        updatedAt: "2026-10-23T10:00:00Z",
      },
      fieldValues: connection([]),
    },
  ];
  const direct = new Map(items.map((item) => [item.id, item]));
  const client = new MembershipReadbackClient(config);
  client.projectDetails = () => ({ id: "PVT", number: config.project.number });
  client.completeProjectContext = () => ({
    number: config.project.number,
    details: { id: "PVT" },
    fields: [],
  });
  let audits = 0;
  const revisions = ["2026-10-23T10:00:00Z", "2026-10-23T10:00:00Z"];
  client.projectAudit = () => ({
    id: "PVT",
    updatedAt: revisions[audits++],
    items: { totalCount: 3 },
  });
  const queries: string[] = [];
  client.graphql = (query, variables) => {
    queries.push(query);
    assert(!query.includes("mutation"), "Readback must not mutate GitHub");
    if (query.includes("ScopedProjectItem"))
      return { node: direct.get(String(variables?.id)) ?? null };
    if (query.includes("items(first:")) {
      assert(query.includes("archivedStates: [ARCHIVED, NOT_ARCHIVED]"));
      const offset = variables?.after ? Number(variables.after) : 0;
      const nodes = forward.slice(offset, offset + 2);
      return {
        node: {
          items: {
            totalCount: forward.length,
            nodes,
            pageInfo: {
              hasNextPage: offset + 2 < forward.length,
              endCursor: String(offset + nodes.length),
            },
          },
        },
      };
    }
    const repository = { id: "R1", nameWithOwner: config.repository };
    if (query.includes("RepositoryIssueMarker"))
      return {
        repository: {
          ...repository,
          issues: { totalCount: issues.length, nodes: [issues.at(-1)] },
        },
      };
    assert(query.includes("RepositoryIssueInventory"), "Unexpected GitHub read");
    assert(query.includes("includeArchived:true"));
    return {
      repository: {
        ...repository,
        issues: connection(
          issues.map((issue) => ({
            ...issue,
            blockedBy: connection([]),
            projectItems: connection([items[issue.number - 1]]),
          })),
        ),
      },
    };
  };
  return { client, issues, items, forward, direct, revisions, queries };
}

void test("bounded Project item selection rejects issues, commands, duplicates and oversized input", () => {
  assert.deepEqual(parseInventoryItems(" PVTI_a\nPVTI_b "), ["PVTI_a", "PVTI_b"]);
  for (const value of [
    "",
    "2397",
    "--help",
    "PVTI_a PVTI_a",
    "PVTI_a;echo",
    " ".repeat(1401),
    Array.from({ length: 11 }, (_, n) => `PVTI_${n}`).join(" "),
  ])
    assert.throws(() => parseInventoryItems(value));
});

void test("complete readback compares exact bindings, retains pages, and distinguishes archived and draft rows", () => {
  const f = fixture();
  const report = readbackMemberships(f.client, "PVTI_1 PVTI_2");
  assert.equal(report.verdict, "CONSISTENT");
  assert.equal(report.planning_evaluation, "not_run");
  assert.equal(report.repository_issue_count, 3);
  assert.deepEqual(report.discrepancies, []);
  assert.deepEqual(report.counts, {
    forward_all: 4,
    forward_active: 3,
    forward_archived: 1,
    active_repository_forward: 2,
    active_repository_reverse: 2,
    active_other_content: 1,
    independently_reported_active: 3,
  });
  assert.deepEqual(
    report.direct.map((row) => [row.item_id, row.content_id, row.number]),
    [
      ["PVTI_1", "I1", 1],
      ["PVTI_2", "I2", 2],
    ],
  );
  assert.equal(f.client.connections[0]?.pages.length, 2);
  assert.equal(f.client.connections[0]?.pages.at(-1)?.terminal, true);
  assert.equal(report.reverse_evidence[0]?.total, 3);
});

void test("stable complete forward omissions remain INCONSISTENT even when direct and reverse reads succeed", () => {
  const f = fixture();
  f.forward.splice(0, 1);
  const report = readbackMemberships(f.client, "PVTI_1 PVTI_2");
  assert.equal(report.verdict, "INCONSISTENT");
  assert(report.discrepancies.includes("PVTI_1: reverse-only active membership"));
  assert(report.discrepancies.some((value) => value.includes("Forward active count")));
  assert.equal(report.direct.length, 2);
});

void test("equal counts cannot hide exchanged issue bindings or unrequested membership drift", () => {
  const f = fixture();
  f.forward[0] = { ...f.items[0], content: f.issues[1] };
  f.forward[1] = { ...f.items[1], content: f.issues[0] };
  const report = readbackMemberships(f.client, "PVTI_1");
  assert.equal(report.verdict, "INCONSISTENT");
  assert(report.discrepancies.includes("PVTI_2: forward/reverse identity mismatch"));
});

void test("a changed Project revision makes otherwise complete reads UNKNOWN", () => {
  const f = fixture();
  f.revisions[1] = "2026-10-23T10:01:00Z";
  const report = readbackMemberships(f.client, "PVTI_1");
  assert.equal(report.verdict, "UNKNOWN");
  assert.equal(isRecord(report.error) && report.error.code, "inventory_changed");
  assert.equal(report.forward.length, 4);
  assert.equal(report.reverse.length, 3);
  assert.equal(report.direct.length, 1);
});

void test("failed pagination retains partial page receipts without manufacturing an empty complete inventory", () => {
  const f = fixture();
  const graphql = f.client.graphql.bind(f.client);
  f.client.graphql = (query, variables) => {
    if (query.includes("items(first:") && variables?.after)
      throw new GitHubApiError("http_error", "Provider read failed", { status: 503 });
    return graphql(query, variables);
  };
  const report = readbackMemberships(f.client, "PVTI_1");
  assert.equal(report.verdict, "UNKNOWN");
  assert.equal(isRecord(report.error) && report.error.code, "http_error");
  assert.equal(f.client.connections[0]?.pages.length, 1);
  assert.equal(f.client.connections[0]?.pages[0]?.observed, 2);
  assert.equal(report.counts, undefined);
  assert.equal(report.direct.length, 0);
});

void test("archived, missing, or foreign direct items cannot establish recovery", () => {
  for (const kind of ["archived", "missing", "foreign"] as const) {
    const f = fixture();
    const original = f.direct.get("PVTI_1");
    assert(original);
    if (kind === "missing") f.direct.delete("PVTI_1");
    else if (kind === "archived") f.direct.set("PVTI_1", { ...original, isArchived: true });
    else f.direct.set("PVTI_1", { ...original, project: { id: "OTHER_PROJECT" } });
    const report = readbackMemberships(f.client, "PVTI_1");
    assert.equal(report.verdict, "UNKNOWN", kind);
    assert.equal(isRecord(report.error) && report.error.code, "inventory_identity");
    assert.equal(report.reverse.length, 3);
  }
});

void test("missing dedicated credential and invalid selection stop before any GitHub read", () => {
  for (const [items, configured] of [
    ["PVTI_1", false],
    ["not-an-item", true],
  ] as const) {
    const f = fixture();
    f.client.projectDetails = () => assert.fail("No GitHub reads are permitted");
    const report = readbackMemberships(f.client, items, configured);
    assert.equal(report.verdict, "UNKNOWN");
    assert.equal(f.queries.length, 0);
  }
});

void test("manual inventory mode retains a skip receipt and uses only the dedicated credential", () => {
  const workflow: unknown = parse(
    readFileSync(new URL("../.github/workflows/roadmap-health.yml", import.meta.url), "utf8"),
  );
  assert(isRecord(workflow) && isRecord(workflow.jobs) && isRecord(workflow.jobs.check));
  const steps = workflow.jobs.check.steps;
  assert(Array.isArray(steps));
  const readback: unknown = steps.find(
    (step: unknown) =>
      isRecord(step) && step.run === "node scripts/roadmap-membership-readback.mts",
  );
  const health: unknown = steps.find(
    (step: unknown) => isRecord(step) && step.run === "node scripts/roadmap-health.mts",
  );
  assert(isRecord(readback) && isRecord(health) && isRecord(readback.env));
  assert.equal(
    readback.if,
    "github.event_name == 'workflow_dispatch' && inputs.inventory_items != ''",
  );
  assert.equal(
    health.if,
    undefined,
    "The collector records a no-health-scope manifest for journal replay",
  );
  assert.deepEqual(readback.env, {
    ROADMAP_INVENTORY_ITEMS: "${{ inputs.inventory_items }}",
    GH_TOKEN: "${{ secrets.PORTCOVE_ROADMAP_TOKEN }}",
  });
  assert(!String(readback.run).includes("${{"), "Dispatch data must not become shell source");
});
