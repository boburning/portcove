import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RoadmapClient,
  catalogQualificationSummary,
  completionEvidenceLinks,
  featureIntakeFields,
  materializeViews,
  manualUiChecklist,
  parseArguments,
  planFieldReconciliation,
  planViewReconciliation,
  projectMachineDrift,
  renderPortIssueBody,
  renderSnapshot,
  resolveSnapshotOutput,
  selectNextItems,
  validateConfig,
  validateDurableIssueBody,
  validatePortIssueCoverage,
  viewMachineDrift,
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
    { name: "Now Board", layout: "BOARD_LAYOUT", filter: "horizon:Now", fields: ["Title"] },
    { name: "Port Pipeline", layout: "BOARD_LAYOUT", filter: "work-type:Port", fields: ["Title"] },
  ];
  const mockedGraphqlViews = [{ id: "PVTV_now", name: "Now Board", layout: "TABLE_LAYOUT", filter: "horizon:Now", fields: { nodes: [{ name: "Title" }] } }];
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

test("release snapshots are cumulative and Project Status alone authorizes completion", () => {
  const items = [
    { title: "Alpha blocker", status: "Blocked", "target release": "Alpha 1", content: { state: "OPEN", url: "https://github.com/boburning/portcove/issues/1", body: "Upstream https://example.test/not-evidence" } },
    { title: "Closed not planned", status: "Deferred", "target release": "Alpha 2", content: { state: "CLOSED", url: "https://github.com/boburning/portcove/issues/2", body: "## Completion evidence\n\nNone." } },
    { title: "Beta complete", status: "Done", "target release": "Beta 1", content: { state: "CLOSED", url: "https://github.com/boburning/portcove/issues/3", body: "## Completion evidence\n\nhttps://github.com/boburning/portcove/pull/12" } },
    { title: "Later beta", status: "Ready", "target release": "Beta 2", content: { state: "OPEN", url: "https://github.com/boburning/portcove/issues/4" } },
  ];
  const document = renderSnapshot({ release: "Beta 1", generatedAt: "2026-09-03T00:00:00Z", commit: "abc", projectUrl: "https://example.test/project", items, catalog: { ports: [] } });
  assert.match(document, /Cumulative required stages: Alpha 1, Alpha 2, Alpha 3, Beta 1/);
  assert.match(document, /## Open blockers[\s\S]*Alpha blocker/);
  assert.match(document, /## Completed required items[\s\S]*Beta complete/);
  assert.match(document, /## Unfinished required items[\s\S]*Closed not planned/);
  assert.match(document, /## Repository closure and Project Status inconsistencies[\s\S]*Closed not planned/);
  assert.doesNotMatch(document, /Later beta/);
  assert.doesNotMatch(document, /example\.test\/not-evidence/);
  assert.match(document, /portcove\/pull\/12/);
});

test("completion evidence excludes ordinary upstream URLs and accepts explicit or typed records", () => {
  const links = completionEvidenceLinks([{ body: [
    "Upstream: https://github.com/vendor/game",
    "Implementation: https://github.com/boburning/portcove/pull/22",
    "Qualification: https://example.test/qualification/windows",
    "## Completion evidence",
    "https://example.test/evidence/result.json",
    "## Dependencies and blockers",
    "https://example.test/not-evidence",
  ].join("\n") }]);
  assert.deepEqual(links, [
    "https://example.test/evidence/result.json",
    "https://example.test/qualification/windows",
    "https://github.com/boburning/portcove/pull/22",
  ]);
});

test("snapshot output is confined to docs/releases", () => {
  assert.match(resolveSnapshotOutput("docs/releases/alpha.md"), /docs[\\/]releases[\\/]alpha\.md$/);
  assert.throws(() => resolveSnapshotOutput("docs/alpha.md"), /must be under docs\/releases/);
  assert.throws(() => resolveSnapshotOutput("../outside.md"), /must be under docs\/releases/);
});

test("durable promotion rejects missing sections and accepts a complete specification", () => {
  assert.throws(() => validateDurableIssueBody("## User outcome\n\nUseful"), /incomplete/);
  const body = [
    "## User outcome\n\nUseful outcome", "## Current behavior and evidence\n\nObserved behavior",
    "## Scope\n\nExact scope", "## Non-goals\n\nExcluded behavior",
    "## Acceptance criteria\n\n- [ ] Proven", "## Required tests\n\nFocused test",
    "## Documentation impact\n\nNo stable contract change", "## Dependencies and blockers\n\nNone",
    "## Completion evidence\n\nRequired before Done",
  ].join("\n\n");
  assert.equal(validateDurableIssueBody(body), body);
});

test("feature intake accepts neutral and explicit planning fields", () => {
  assert.deepEqual(featureIntakeFields(config), {
    Status: "Inbox", Priority: "None", Horizon: "Someday", "Target release": "Unscheduled",
    "Work type": "Product feature", Effort: "Unknown",
  });
  assert.equal(featureIntakeFields(config, { "--workstream": "Desktop UX", "--platform": "Windows", "--priority": "High", "--horizon": "Now", "--release": "Alpha 2" }).Workstream, "Desktop UX");
  assert.throws(() => featureIntakeFields(config, { "--platform": "Everywhere" }), /not a valid Platform/);
});

test("active release materialization and manual checklist are explicit", () => {
  const current = materializeViews(config).find(view => view.name === "Current Release");
  assert.match(current.filter, /Alpha 1/);
  assert.equal(manualUiChecklist(config).filter(line => /^\d+\. .*: group by/.test(line)).length, 9);
  assert.match(manualUiChecklist(config).at(-1), /completion workflows/);
});

test("doctor drift covers identity linkage field options and view properties", () => {
  const desiredViews = materializeViews(config);
  const fields = config.fields.map((field, index) => ({ id: `F${index}`, name: field.name, type: "ProjectV2SingleSelectField", options: field.options.map((name, option) => ({ id: `${index}-${option}`, name })) }));
  const views = desiredViews.map((view, index) => ({ id: `V${index}`, name: view.name, layout: view.layout, filter: view.filter, fields: { nodes: view.fields.map(name => ({ name })) } }));
  assert.deepEqual(projectMachineDrift(config, { details: { title: config.project.title, number: 1, public: true }, fields, views, repositories: [{ owner: { login: "boburning" }, name: "portcove" }] }), []);
  views[0].filter = "wrong";
  fields[0].options = fields[0].options.filter(option => option.name !== "Done");
  const drift = projectMachineDrift(config, { details: { title: "Wrong", number: 1, public: false }, fields, views, repositories: [] });
  assert.ok(drift.some(value => value.includes("project title")));
  assert.ok(drift.some(value => value.includes("visibility")));
  assert.ok(drift.some(value => value.includes("not linked")));
  assert.ok(drift.some(value => value.includes("field Status")));
  assert.ok(drift.some(value => value.includes("view Priority Stack")));
  assert.ok(viewMachineDrift(desiredViews[0], views[0]).some(value => value.includes("filter")));
});

test("one-port-one-issue coverage rejects missing duplicate grouped and draft authority", () => {
  const catalog = { ports: [{ id: "one" }, { id: "two" }] };
  const issue = (number, id) => ({ title: `Port ${id}`, "work type": "Port", content: { type: "Issue", url: `https://github.com/boburning/portcove/issues/${number}`, body: `${renderPortIssueBody({ title: id, upstream: `https://example.test/${id}`, catalogId: id })}` } });
  assert.deepEqual(validatePortIssueCoverage(catalog, [issue(1, "one"), issue(2, "two")], "boburning/portcove"), []);
  const duplicate = validatePortIssueCoverage(catalog, [issue(1, "one"), issue(2, "one")], "boburning/portcove");
  assert.ok(duplicate.some(value => value.includes("Two live issues")));
  assert.ok(duplicate.some(value => value.includes("lacks a canonical")));
  const grouped = issue(3, "one");
  grouped.content.body += "\n<!-- portcove-catalog-id: two -->";
  assert.ok(validatePortIssueCoverage(catalog, [grouped], "boburning/portcove").some(value => value.includes("multiple catalog ports")));
  const draft = { title: "Draft only", "work type": "Port", content: { type: "DraftIssue", body: "<!-- portcove-port -->" } };
  assert.ok(validatePortIssueCoverage({ ports: [] }, [draft], "boburning/portcove").some(value => value.includes("not backed")));
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
  const edit = calls.find(call => call.input?.includes("updateProjectV2ItemFieldValue"));
  const variables = JSON.parse(edit.input).variables;
  assert.deepEqual(Object.values(variables).map(input => [input.fieldId, input.value.singleSelectOptionId]), [
    ["PVTSSF_status", "OPT_inbox"], ["PVTSSF_priority", "OPT_none"],
  ]);
});

test("capture-port creates one repository issue and initializes Unknown platform", () => {
  const calls = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const expectedFields = {
    Status: "Inbox", Priority: "None", Horizon: "Someday", "Target release": "Unscheduled",
    "Work type": "Port", Workstream: "Port catalog", Platform: "Unknown", "Port stage": "Watchlist", Effort: "Unknown",
  };
  const runner = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "api" && args[1] === "repos/boburning/portcove/issues") return JSON.stringify({ node_id: "I_new", html_url: "https://github.com/boburning/portcove/issues/88", number: 88 });
    if (args[0] === "project" && args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[0] === "project" && args[1] === "field-list") return JSON.stringify({ fields: Object.entries(expectedFields).map(([name, value], index) => ({ id: `F${index}`, name, options: [{ id: `O${index}`, name: value }] })) });
    if (args[0] === "api" && args[1] === "graphql") {
      if (input.includes("addProjectV2ItemById")) return JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "PVTI_new" } } } });
      return JSON.stringify({ data: { node: { projectItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  const result = client.createPortIssue({ title: "New Port", upstream: "https://example.test/upstream" });
  assert.equal(result.itemId, "PVTI_new");
  assert.equal(calls.filter(call => call.args[1] === "repos/boburning/portcove/issues").length, 1);
  assert.ok(calls.some(call => call.input?.includes("<!-- portcove-port -->")));
  const fieldEdit = calls.find(call => call.input?.includes("updateProjectV2ItemFieldValue"));
  assert.ok(Object.values(JSON.parse(fieldEdit.input).variables).some(input => input.fieldId === "F6" && input.value.singleSelectOptionId === "O6"));
});

test("promotion validation happens before any GitHub mutation", () => {
  let calls = 0;
  const client = new RoadmapClient(config, () => { calls += 1; return ""; });
  assert.throws(() => client.promote("PVTI_draft", "lightweight note"), /incomplete/);
  assert.equal(calls, 0);
});

test("move refuses ambiguous item references", () => {
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner = args => {
    if (args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[1] === "item-list") return JSON.stringify({ items: [
      { id: "A", title: "Same" }, { id: "B", title: "Same" }, { id: "C", title: "Before" },
    ] });
    return "";
  };
  assert.throws(() => new RoadmapClient(mockedConfig, runner).moveBefore("Same", "Before"), /ambiguous/);
});

test("RoadmapClient reuses an existing issue item instead of duplicating it", () => {
  const calls = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner = (args, input) => {
    calls.push({ args, input });
    if (args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[1] === "field-list") return JSON.stringify({ fields: [] });
    if (args[0] === "api" && args[1] === "graphql") {
      const after = JSON.parse(input).variables.after;
      return JSON.stringify({ data: { node: { projectItems: after
        ? { nodes: [{ id: "PVTI_existing", project: { id: "PVT_project" } }], pageInfo: { hasNextPage: false, endCursor: null } }
        : { nodes: [{ id: "PVTI_other", project: { id: "OTHER" } }], pageInfo: { hasNextPage: true, endCursor: "page2" } } } } });
    }
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  assert.deepEqual(client.ensureIssueItem("I_existing"), { id: "PVTI_existing", project: { id: "PVT_project" } });
  assert.equal(calls.filter(call => call.input?.includes("addProjectV2ItemById")).length, 0);
  assert.equal(calls.filter(call => call.input?.includes("projectItems(first: 100")).length, 2);
});

test("GraphQL view pagination reads every page", () => {
  const calls = [];
  const runner = (args, input) => {
    calls.push({ args, input });
    const after = JSON.parse(input).variables.after;
    return JSON.stringify({ data: { node: { views: after
      ? { nodes: [{ id: "V2", name: "Second" }], pageInfo: { hasNextPage: false, endCursor: null } }
      : { nodes: [{ id: "V1", name: "First" }], pageInfo: { hasNextPage: true, endCursor: "next" } } } } });
  };
  assert.deepEqual(new RoadmapClient(config, runner).viewList("PVT" ).map(view => view.name), ["First", "Second"]);
  assert.equal(calls.length, 2);
});
