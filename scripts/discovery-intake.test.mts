import { fixtureIssueInventory } from "./repository-issue-inventory.fixture.mts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  RoadmapClient,
  renderPortIssueBody,
  findPortIssueDuplicates,
  validateConfig,
} from "./roadmap.mts";

import { GitHubApiClient } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import type { RoadmapIssueItem } from "./roadmap.mts";
import { intakeAmendmentAction, validateDiscoveryIntakeBody } from "./daily-discovery-session.mts";
import { observationHash } from "./upstream-observer.mts";
const config = validateConfig(
  JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
type Issue = ReturnType<RoadmapClient["repositoryIssue"]>;
void test("discovery rejects the Brawl metadata omission before public creation", () => {
  const upstream = "https://github.com/example/brawl";
  const valid = renderPortIssueBody({ title: "Brawl", upstream, portKey: "brawl" });
  validateDiscoveryIntakeBody(valid, upstream, "brawl");
  for (const invalid of [
    valid.replace("Catalog ID: Not assigned (researched candidate)", "Catalog ID: Unknown"),
    valid
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
void test("catalog-ID direct intake recovery keeps its existing catalog identity without inventing a port key", () => {
  const body = renderPortIssueBody({
    title: "Catalog Game",
    upstream: "https://example.test/engine",
    catalogId: "catalog-game",
  });
  const issue = {
    number: 43,
    title: "[Port] Catalog Game",
    node_id: "I43",
    html_url: "https://github.com/boburning/portcove/issues/43",
    body,
  };
  const client = new RoadmapClient(
    config,
    new GitHubApiClient(() => {
      throw new Error("Unexpected body mutation");
    }),
  );
  client.repositoryIssue = () => issue;
  client.repositoryIssues = () => fixtureIssueInventory(client, []);
  client.itemList = () => [];
  client.projectContext = () => ({
    number: config.project.number,
    details: { id: "PVT" },
    fields: [],
  });
  client.readInventory = () => [];
  client.ensureIssueItem = () => ({ id: "ITEM43" });
  client.setItemFields = () => {};
  const result = client.normalizePortIssue({
    number: 43,
    catalog: { ports: [{ id: "catalog-game" }] },
  });
  assert.equal(result.bodyChanged, false);
  assert.equal(result.projectItemAdded, true);
});
void test("captured issue identity survives failed Project intake and neutral normalization repairs the same issue", () => {
  const state: {
    issue: Issue | null;
    receipt: Issue | null;
    projectItem: RoadmapIssueItem | null;
    fields: Readonly<Record<string, string>> | null;
  } = { issue: null, receipt: null, projectItem: null, fields: null };
  let creates = 0;
  const api = new GitHubApiClient((args, input) => {
    assert.equal(args[4], "POST");
    assert.ok(required(args[2]).endsWith("/issues"));
    const payload: unknown = JSON.parse(required(input));
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
    return `HTTP/2 201\n\n${JSON.stringify(state.issue)}`;
  });
  const client = new RoadmapClient(config, api);
  client.repositoryIssues = () =>
    fixtureIssueInventory(
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
  client.ensureIssueItem = () => {
    throw new Error("Project access failed");
  };
  assert.throws(
    () =>
      client.createPortIssue({
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
  assert.throws(
    () =>
      client.createPortIssue({
        title: "Game / Engine",
        upstream: "https://github.com/example/engine",
        portKey: "game-engine",
      }),
    /durable issue/,
  );
  client.repositoryIssue = () => required(state.issue);
  client.itemList = () => (state.projectItem ? [state.projectItem] : []);
  client.projectContext = () => ({
    number: config.project.number,
    details: { id: "PVT" },
    fields: [],
  });
  client.readInventory = () => [];
  client.ensureIssueItem = () => ({ id: "ITEM42" });
  client.setItemFields = (id, values) => {
    const issue = required(state.issue);
    assert.ok(issue.state === undefined || issue.state === null || typeof issue.state === "string");
    state.fields = values;
    state.projectItem = {
      id,
      content: { ...issue, state: issue.state, url: issue.html_url, type: "Issue" },
      fieldValues: Object.entries(values).map(([name, value]) => ({
        name: value,
        field: { name },
      })),
    };
  };
  const result = client.normalizePortIssue({ number: 42, catalog: { ports: [] } });
  assert.equal(result.projectItemAdded, true);
  assert.equal(result.bodyChanged, false);
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
