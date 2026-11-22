import { fixtureIssueInventory } from "./repository-issue-inventory.fixture.mts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateConfig } from "./roadmap.mts";
import {
  renderPortIssueBody,
  renderPortResearchDeclaration,
  findPortIssueDuplicates,
} from "./roadmap-issue.mts";

import type { RoadmapClient } from "./roadmap.mts";
import { projectData, scopedIssueItemData, sdkRoadmap } from "./fixtures/roadmap-fixtures.mts";
import { isRecord } from "./runtime-values.mts";
import { intakeAmendmentAction, validateDiscoveryIntakeBody } from "./daily-discovery-session.mts";
import { observationHash } from "./upstream-observer.mts";
const config = validateConfig(
  JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
type Issue = Awaited<ReturnType<RoadmapClient["repositoryIssue"]>>;
void test("discovery rejects the Brawl metadata omission before public creation", () => {
  const upstream = "https://github.com/example/brawl";
  const valid = renderPortIssueBody({ title: "Brawl", upstream, portKey: "brawl" });
  validateDiscoveryIntakeBody(valid, upstream, "brawl");
  for (const invalid of [
    valid
      .replace(renderPortResearchDeclaration(), "")
      .replace("Catalog ID: Not assigned (researched candidate)", "Catalog ID: Unknown"),
    valid
      .replace(renderPortResearchDeclaration(), "")
      .replace("does not grant support", "leaves support Unknown")
      .replace("does not change catalog.json", "leaves catalog unchanged"),
  ])
    assert.throws(
      () => validateDiscoveryIntakeBody(invalid, upstream, "brawl"),
      /research\/watchlist/,
    );
  assert.throws(
    () => validateDiscoveryIntakeBody(valid, upstream, "different-game"),
    /canonical body markers/,
  );
});
void test("amendment recovery observes successful writes and refuses repetition or owner edits", () => {
  const amendment = { expected_body_sha256: observationHash("old"), status: "prepared" as const };
  assert.equal(intakeAmendmentAction("new", "old", amendment), "patch");
  for (const status of ["prepared", "attempted", "applied"] as const) {
    assert.equal(intakeAmendmentAction("new", "new", { ...amendment, status }), "observed");
    assert.throws(
      () => intakeAmendmentAction("new", "owner-edited", { ...amendment, status }),
      /body changed/,
    );
  }
  for (const status of ["attempted", "applied"] as const)
    assert.throws(
      () => intakeAmendmentAction("new", "old", { ...amendment, status }),
      /no repeated write/,
    );
});
void test("catalog-ID direct intake recovery keeps its existing catalog identity without inventing a port key", async () => {
  const upstream = "https://example.test/engine";
  const body = renderPortIssueBody({
    title: "Catalog Game",
    upstream,
    catalogId: "catalog-game",
  });
  const issue = {
    number: 43,
    title: "[Port] Catalog Game",
    node_id: "I43",
    html_url: "https://github.com/boburning/portcove/issues/43",
    body,
  };
  const client = await sdkRoadmap(config, {
    allowMutations: true,
    graphql: (query, variables) => {
      if (query.includes("projectV2(number:")) return projectData("PVT");
      assert.match(query, /query ScopedProjectItem/u);
      assert.deepEqual(variables, { id: "ITEM43" });
      return scopedIssueItemData("PVT", "ITEM43", issue);
    },
  });
  client.repositoryIssue = async () => issue;
  client.repositoryIssues = async () => await fixtureIssueInventory(client, []);
  client.projectContext = async () => ({
    number: config.project.number,
    details: { id: "PVT" },
    fields: [],
  });
  client.readInventory = async () => [];
  client.ensureIssueItem = async (contentId) => {
    assert.equal(contentId, "I43");
    return { id: "ITEM43" };
  };
  client.setItemFields = async (itemId, fields) => {
    assert.equal(itemId, "ITEM43");
    assert.equal(fields["Port stage"], "Cataloged");
  };
  const result = await client.normalizePortIssue({
    number: 43,
    catalog: { ports: [{ id: "catalog-game", project_url: upstream }] },
    listings: [{ id: "catalog-game", issue_number: 43 }],
  });
  assert.equal(result.bodyChanged, false);
  assert.equal(result.projectItemAdded, true);
  assert.equal(result.itemId, "ITEM43");
  assert.equal(result.issue, issue.html_url);
});
void test("captured issue identity survives failed Project intake and neutral normalization repairs the same issue", async () => {
  const state: {
    issue: Issue | null;
    receipt: Issue | null;
    fields: Readonly<Record<string, string>> | null;
  } = { issue: null, receipt: null, fields: null };
  let creates = 0;
  const client = await sdkRoadmap(config, {
    allowMutations: true,
    rest: ({ method, endpoint, body: payload }) => {
      if (method === "GET" && endpoint === `users/${config.owner}`)
        return { type: "User", node_id: "OWNER_fixture" };
      assert.equal(method, "POST");
      assert.equal(endpoint, `repos/${config.repository}/issues`);
      assert.ok(
        isRecord(payload) && typeof payload.title === "string" && typeof payload.body === "string",
      );
      creates++;
      state.issue = {
        ...payload,
        title: payload.title,
        body: payload.body,
        number: 42,
        node_id: "I42",
        html_url: "https://github.com/boburning/portcove/issues/42",
      };
      return Response.json(state.issue, { status: 201 });
    },
    graphql: (query, variables) => {
      if (query.includes("projectV2(number:")) return projectData("PVT");
      assert.match(query, /query ScopedProjectItem/u);
      assert.deepEqual(variables, { id: "ITEM42" });
      const issue = required(state.issue);
      return scopedIssueItemData("PVT", "ITEM42", {
        ...issue,
        title: required(issue.title),
        body: required(issue.body),
      });
    },
  });
  client.repositoryIssues = async () =>
    await fixtureIssueInventory(
      client,
      state.issue
        ? [
            {
              ...state.issue,
              title: state.issue.title,
              body: state.issue.body ?? "",
              state: "OPEN",
              url: state.issue.html_url,
              type: "Issue",
            },
          ]
        : [],
    );
  client.ensureIssueItem = async () => {
    throw new Error("Project access failed");
  };
  await assert.rejects(
    async () =>
      await client.createPortIssue({
        title: "Game / Engine",
        upstream: "https://github.com/example/engine",
        portKey: "game-engine",
        onIssueCreated: (value) => {
          state.receipt = value;
        },
      }),
    /Project access failed/,
  );
  assert.equal(required(state.receipt).number, 42);
  await assert.rejects(
    async () =>
      await client.createPortIssue({
        title: "Game / Engine",
        upstream: "https://github.com/example/engine",
        portKey: "game-engine",
      }),
    /durable issue/,
  );
  client.repositoryIssue = async () => required(state.issue);
  client.projectContext = async () => ({
    number: config.project.number,
    details: { id: "PVT" },
    fields: [],
  });
  client.readInventory = async () => [];
  client.ensureIssueItem = async (contentId) => {
    assert.equal(contentId, required(state.receipt).node_id);
    return { id: "ITEM42" };
  };
  client.setItemFields = async (id, values) => {
    assert.equal(id, "ITEM42");
    state.fields = values;
  };
  const result = await client.normalizePortIssue({ number: 42, catalog: { ports: [] } });
  assert.equal(result.projectItemAdded, true);
  assert.equal(result.bodyChanged, false);
  assert.equal(result.itemId, "ITEM42");
  assert.equal(result.issue, required(state.receipt).html_url);
  assert.equal(required(state.fields).Status, "Inbox");
  assert.equal(required(state.fields)["Port stage"], "Watchlist");
  assert.equal(creates, 1);
});

void test("retired duplicate and renamed upstream keep the durable key; independent forks and same-repo games stay distinct", () => {
  const issue = (
    number: number,
    title: string,
    portKey: string,
    upstream: string,
    state = "OPEN",
  ) => ({
    number,
    title: `[Port] ${title}`,
    state,
    url: `https://github.com/boburning/portcove/issues/${number}`,
    body: renderPortIssueBody({ title, portKey, upstream }),
  });
  const records = [
    issue(
      322,
      "Super Mario 64 / SM64 Co-op DX",
      "sm64coopdx",
      "https://github.com/coop-deluxe/sm64coopdx",
    ),
    issue(
      1786,
      "Retired duplicate",
      "sm64coopdx",
      "https://github.com/coop-deluxe/sm64coopdx",
      "CLOSED",
    ),
  ];
  assert.equal(
    findPortIssueDuplicates(records, {
      title: "Renamed display",
      upstream: "https://github.com/new-owner/new-name",
      portKey: "sm64coopdx",
    }).length,
    2,
  );
  assert.deepEqual(
    findPortIssueDuplicates(records, {
      title: "Super Mario 64 / Independent fork",
      upstream: "https://github.com/independent/fork",
      portKey: "sm64-independent",
    }),
    [],
  );
  assert.deepEqual(
    findPortIssueDuplicates(
      [issue(1, "Game A / Shared engine", "game-a", "https://github.com/example/shared")],
      {
        title: "Game B / Shared engine",
        upstream: "https://github.com/example/shared",
        portKey: "game-b",
      },
    ),
    [],
  );
});
