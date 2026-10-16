import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RoadmapClient, renderPortIssueBody, findPortIssueDuplicates } from "./roadmap.mjs";

const config = JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url)));
test("catalog-ID direct intake recovery keeps its existing catalog identity without inventing a port key", () => {
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
  const client = new RoadmapClient(config, {
    request() {
      throw new Error("Unexpected body mutation");
    },
  });
  client.repositoryIssue = () => issue;
  client.repositoryIssues = () => [];
  client.itemList = () => [];
  client.ensureIssueItem = () => ({ id: "ITEM43" });
  client.setItemFields = () => {};
  const result = client.normalizePortIssue({
    number: 43,
    catalog: { ports: [{ id: "catalog-game" }] },
  });
  assert.equal(result.bodyChanged, false);
  assert.equal(result.projectItemAdded, true);
});
test("captured issue identity survives failed Project intake and neutral normalization repairs the same issue", () => {
  let issue = null,
    receipt = null,
    projectItem = null,
    fields = null,
    creates = 0;
  const client = new RoadmapClient(config, {
    request(method, endpoint, payload) {
      assert.equal(method, "POST");
      assert.ok(endpoint.endsWith("/issues"));
      creates++;
      issue = {
        ...payload,
        number: 42,
        node_id: "I42",
        html_url: "https://github.com/boburning/portcove/issues/42",
      };
      return { body: issue };
    },
  });
  client.repositoryIssues = () => (issue ? [{ ...issue, url: issue.html_url, type: "Issue" }] : []);
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
          receipt = value;
        },
      }),
    /Project access failed/,
  );
  assert.equal(receipt.number, 42);
  assert.throws(
    () =>
      client.createPortIssue({
        title: "Game / Engine",
        upstream: "https://github.com/example/engine",
        portKey: "game-engine",
      }),
    /durable issue/,
  );
  client.repositoryIssue = () => issue;
  client.itemList = () => (projectItem ? [projectItem] : []);
  client.ensureIssueItem = () => ({ id: "ITEM42" });
  client.setItemFields = (id, values) => {
    fields = values;
    projectItem = {
      id,
      content: { ...issue, url: issue.html_url, type: "Issue" },
      fieldValues: Object.entries(values).map(([name, value]) => ({
        name: value,
        field: { name },
      })),
    };
  };
  const result = client.normalizePortIssue({ number: 42, catalog: { ports: [] } });
  assert.equal(result.projectItemAdded, true);
  assert.equal(result.bodyChanged, false);
  assert.equal(fields.Status, "Inbox");
  assert.equal(fields["Port stage"], "Watchlist");
  assert.equal(creates, 1);
});

test("retired duplicate and renamed upstream keep the durable key; independent forks and same-repo games stay distinct", () => {
  const issue = (number, title, portKey, upstream, state = "OPEN") => ({
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
