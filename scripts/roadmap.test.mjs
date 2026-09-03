import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RoadmapClient,
  catalogQualificationSummary,
  parseArguments,
  planFieldReconciliation,
  planViewReconciliation,
  renderSnapshot,
  selectNextItems,
  validateConfig,
} from "./roadmap.mjs";

const config = JSON.parse(await readFile(new URL("../.github/roadmap.json", import.meta.url)));

test("checked-in configuration contains schema rather than volatile item state", () => {
  assert.doesNotThrow(() => validateConfig(config));
  const invalid = structuredClone(config);
  invalid.project.items = [{ title: "mutable backlog" }];
  assert.throws(() => validateConfig(invalid), /volatile planning data/);
});

test("argument parsing keeps positional item references and named values distinct", () => {
  assert.deepEqual(
    parseArguments(["set", "#42", "--status", "In progress", "--release=Alpha 1"]),
    {
      command: "set",
      positionals: ["#42"],
      options: { "--status": "In progress", "--release": "Alpha 1" },
    },
  );
  assert.throws(() => parseArguments(["move", "PVTI_1", "--before"]), /requires a value/);
});

test("field reconciliation preserves existing option identities and user data", () => {
  const desired = [{ name: "Status", options: ["Inbox", "Done"] }];
  const mockedGhFields = {
    fields: [{
      id: "PVTSSF_status",
      name: "Status",
      type: "ProjectV2SingleSelectField",
      options: [{ id: "existing", name: "Custom", color: "BLUE", description: "user data" }],
    }],
  };
  const existingPlan = planFieldReconciliation(desired, mockedGhFields);
  assert.equal(existingPlan[0].action, "update");
  assert.deepEqual(existingPlan[0].options.map(option => option.name), ["Custom", "Inbox", "Done"]);
  assert.equal(existingPlan[0].options[0].id, "existing");

  const freshPlan = planFieldReconciliation(desired, mockedGhFields, { freshProject: true });
  assert.deepEqual(freshPlan[0].options.map(option => option.name), ["Inbox", "Done"]);
});

test("view reconciliation reuses matching GraphQL views and creates only missing views", () => {
  const desired = [
    { name: "Now Board", layout: "BOARD_LAYOUT" },
    { name: "Port Pipeline", layout: "BOARD_LAYOUT" },
  ];
  const mockedGraphqlViews = [{ id: "PVTV_now", name: "Now Board", layout: "TABLE_LAYOUT" }];
  assert.deepEqual(
    planViewReconciliation(desired, mockedGraphqlViews).map(step => [step.action, step.desired.name]),
    [["update", "Now Board"], ["create", "Port Pipeline"]],
  );
});

test("next work excludes workstreams, completed items, and Later horizon", () => {
  const items = [
    { title: "Next medium", status: "Ready", priority: "Medium", horizon: "Next", "work type": "Bug" },
    { title: "Now high", status: "In progress", priority: "High", horizon: "Now", "work type": "Product feature" },
    { title: "Now urgent", status: "Ready", priority: "Urgent", horizon: "Now", "work type": "Security" },
    { title: "Parent", status: "Ready", priority: "Urgent", horizon: "Now", "work type": "Workstream" },
    { title: "Done", status: "Done", priority: "Urgent", horizon: "Now", "work type": "Bug" },
    { title: "Later", status: "Ready", priority: "Urgent", horizon: "Later", "work type": "Bug" },
  ];
  assert.deepEqual(selectNextItems(items).map(item => item.title), ["Now urgent", "Now high", "Next medium"]);
});

test("catalog summary and release snapshot derive qualification data from catalog JSON", () => {
  const catalog = {
    ports: [
      { id: "one", support_tier: "stable", platforms: ["windows", "linux"], automated_tested_platforms: ["windows"], manually_validated_platforms: ["windows"] },
      { id: "two", support_tier: "beta", platforms: ["windows"], automated_tested_platforms: [], manually_validated_platforms: [] },
    ],
  };
  assert.deepEqual(catalogQualificationSummary(catalog), {
    ports: 2,
    byTier: { stable: 1, beta: 1 },
    declaredPlatformPairs: 3,
    automatedPlatformPairs: 1,
    manuallyValidatedPlatformPairs: 1,
  });
  const document = renderSnapshot({
    release: "Alpha 1",
    generatedAt: "2026-09-03T12:00:00.000Z",
    commit: "abcdef",
    projectUrl: "https://github.com/users/boburning/projects/1",
    items: [{ title: "Trust", status: "Blocked", priority: "Urgent", horizon: "Now", type: "Security", "target release": "Alpha 1", content: { url: "https://github.com/boburning/portcove/issues/1" } }],
    catalog,
  });
  assert.match(document, /## Open blockers[\s\S]*Trust/);
  assert.match(document, /Catalog entries: 2/);
  assert.match(document, /This snapshot does not grant qualification/);
});

test("RoadmapClient capture uses mocked gh output and stores planning fields only in Project calls", () => {
  const calls = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner = (args, input) => {
    calls.push({ args, input });
    if (args[1] === "item-create") return JSON.stringify({ id: "PVTI_draft", title: "Candidate" });
    if (args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[1] === "field-list") return JSON.stringify({ fields: [
      { id: "PVTSSF_status", name: "Status", options: [{ id: "OPT_inbox", name: "Inbox" }] },
      { id: "PVTSSF_priority", name: "Priority", options: [{ id: "OPT_none", name: "None" }] },
    ] });
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  const result = client.capture({
    title: "Candidate",
    body: "Upstream: https://example.test/port",
    fields: { Status: "Inbox", Priority: "None" },
  });
  assert.equal(result.id, "PVTI_draft");
  assert.equal(calls.filter(call => call.args[1] === "item-create").length, 1);
  assert.deepEqual(
    calls.filter(call => call.args[1] === "item-edit").map(call => call.args.slice(-6)),
    [
      ["--project-id", "PVT_project", "--field-id", "PVTSSF_status", "--single-select-option-id", "OPT_inbox"],
      ["--project-id", "PVT_project", "--field-id", "PVTSSF_priority", "--single-select-option-id", "OPT_none"],
    ],
  );
});

test("RoadmapClient reuses an existing issue item instead of duplicating it", () => {
  const calls = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner = (args, input) => {
    calls.push({ args, input });
    if (args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[1] === "field-list") return JSON.stringify({ fields: [] });
    if (args[0] === "api" && args[1] === "graphql") return JSON.stringify({ data: {
      node: { projectItems: { nodes: [{ id: "PVTI_existing", project: { id: "PVT_project" } }] } },
    } });
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  assert.deepEqual(client.ensureIssueItem("I_existing"), { id: "PVTI_existing", project: { id: "PVT_project" } });
  assert.equal(calls.filter(call => call.input?.includes("addProjectV2ItemById")).length, 0);
});
