import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RoadmapClient,
  catalogQualificationSummary,
  completionEvidenceLinks,
  fieldValue,
  featureIntakeFields,
  findPortIssueDuplicates,
  materializeViews,
  manualUiChecklist,
  normalizePortKey,
  parseArguments,
  parsePortIssueForm,
  planFieldReconciliation,
  planPortStageReconciliation,
  planViewReconciliation,
  portFieldInitialization,
  projectMachineDrift,
  qualifiedPlatforms,
  reconcilePortIssueMarkers,
  renderPortIssueBody,
  renderSnapshot,
  resolveSnapshotOutput,
  selectNextItems,
  uxAuditOriginIds,
  uxAuditOrigins,
  validateConfig,
  validateDurableIssueBody,
  validatePlanOriginCoverage,
  validatePortIssueCoverage,
  validatePortStageSemantics,
  validateUxAuditOriginCoverage,
  viewMachineDrift,
} from "./roadmap.mjs";

const config = JSON.parse(await readFile(new URL("../.github/roadmap.json", import.meta.url)));
const newPortForm = await readFile(new URL("../.github/ISSUE_TEMPLATE/new-port.yml", import.meta.url), "utf8");

test("checked-in configuration contains schema rather than volatile item state", () => {
  assert.doesNotThrow(() => validateConfig(config));
  const invalid = structuredClone(config);
  invalid.project.items = [{ title: "mutable backlog" }];
  assert.throws(() => validateConfig(invalid), /volatile planning data/);
});

test("New Port form requires canonical identity input without a Project-token workflow", () => {
  assert.match(newPortForm, /id: port_key/);
  assert.match(newPortForm, /label: Durable game or target key/);
  assert.match(newPortForm, /lowercase kebab-case/);
  assert.match(newPortForm, /id: upstream[\s\S]*?required: true/);
  assert.doesNotMatch(newPortForm, /(?:PROJECT_TOKEN|personal access token)/i);
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
  fields[1].options.push({ id: "unexpected", name: "Unexpected" });
  views.push({ id: "extra", name: "Unexpected", layout: "TABLE_LAYOUT", filter: "", fields: { nodes: [{ name: "Title" }] } });
  const drift = projectMachineDrift(config, { details: { title: "Wrong", number: 1, public: false }, fields, views, repositories: [] });
  assert.ok(drift.some(value => value.includes("project title")));
  assert.ok(drift.some(value => value.includes("visibility")));
  assert.ok(drift.some(value => value.includes("not linked")));
  assert.ok(drift.some(value => value.includes("field Status")));
  assert.ok(drift.some(value => value.includes("unexpected options")));
  assert.ok(drift.some(value => value.includes("view Priority Stack")));
  assert.ok(drift.some(value => value.includes("unexpected view")));
  assert.ok(viewMachineDrift(desiredViews[0], views[0]).some(value => value.includes("filter")));
});

test("one-port-one-issue coverage rejects missing duplicate grouped and draft authority", () => {
  const catalog = { ports: [{ id: "one" }, { id: "two" }] };
  const repositoryIssue = (number, id) => ({ number, title: `[Port] ${id}`, type: "Issue", url: `https://github.com/boburning/portcove/issues/${number}`, body: renderPortIssueBody({ title: id, upstream: `https://example.test/${id}`, catalogId: id }) });
  const projectItem = (issue, workType = "Port") => ({ title: issue.title, "work type": workType, content: issue });
  const first = repositoryIssue(1, "one");
  const second = repositoryIssue(2, "two");
  assert.deepEqual(validatePortIssueCoverage(catalog, [projectItem(first), projectItem(second)], "boburning/portcove", [first, second]), []);
  const duplicateIssue = repositoryIssue(2, "one");
  const duplicate = validatePortIssueCoverage(catalog, [projectItem(first), projectItem(duplicateIssue)], "boburning/portcove", [first, duplicateIssue]);
  assert.ok(duplicate.some(value => value.includes("Two live issues")));
  assert.ok(duplicate.some(value => value.includes("lacks a canonical")));
  const grouped = repositoryIssue(3, "one");
  grouped.body += "\n<!-- portcove-catalog-id: two -->";
  assert.ok(validatePortIssueCoverage(catalog, [projectItem(grouped)], "boburning/portcove", [grouped]).some(value => value.includes("multiple catalog ports")));
  const draft = { title: "Draft only", "work type": "Port", content: { type: "DraftIssue", body: "<!-- portcove-port -->" } };
  assert.ok(validatePortIssueCoverage({ ports: [] }, [draft], "boburning/portcove").some(value => value.includes("not backed")));
  assert.ok(validatePortIssueCoverage(catalog, [projectItem(first)], "boburning/portcove", [first, second])
    .some(value => value.includes("not in the Project")));
  assert.ok(validatePortIssueCoverage({ ports: [{ id: "one" }] }, [projectItem(first, "Research")], "boburning/portcove", [first])
    .some(value => value.includes("not classified as Work type = Port")));
  const external = structuredClone(first);
  external.url = "https://github.com/example/other/issues/1";
  assert.ok(validatePortIssueCoverage({ ports: [{ id: "one" }] }, [projectItem(external)], "boburning/portcove", [first])
    .some(value => value.includes("not in the Project")));
});

test("one-port-one-issue coverage requires unique candidate keys and allows shared upstream multi-game repositories", () => {
  const issue = (number, title, body) => ({
    number,
    title,
    type: "Issue",
    url: "https://github.com/boburning/portcove/issues/" + number,
    body,
  });
  const projectItem = repositoryIssue => ({ title: repositoryIssue.title, "work type": "Port", content: repositoryIssue });
  const first = issue(1, "[Port] One",
    renderPortIssueBody({ title: "One", upstream: "https://example.test/shared", portKey: "one" }));
  const second = issue(2, "[Port] Two",
    renderPortIssueBody({ title: "Two", upstream: "https://example.test/shared/", portKey: "two" }));
  assert.deepEqual(validatePortIssueCoverage({ ports: [] }, [projectItem(first), projectItem(second)], "boburning/portcove", [first, second]), []);
  const duplicateKey = issue(3, "[Port] Different title",
    renderPortIssueBody({ title: "Different title", upstream: "https://example.test/other", portKey: "one" }));
  assert.ok(validatePortIssueCoverage({ ports: [] }, [projectItem(first), projectItem(duplicateKey)], "boburning/portcove", [first, duplicateKey])
    .some(value => value.includes("non-catalog port key one")));
  const unlabeled = issue(4, "[Port] Three",
    "<!-- portcove-port -->\n<!-- portcove-upstream: https://example.test/three -->");
  assert.ok(validatePortIssueCoverage({ ports: [] }, [projectItem(unlabeled)], "boburning/portcove", [unlabeled])
    .some(value => value.includes("research/watchlist")));
  assert.ok(validatePortIssueCoverage({ ports: [] }, [projectItem(unlabeled)], "boburning/portcove", [unlabeled])
    .some(value => value.includes("durable port key")));
});

test("capture-port deduplication normalizes punctuation titles and combines upstream with game identity", () => {
  const existing = {
    number: 1,
    title: "[Port] Pokémon: Yellow!",
    url: "https://github.com/boburning/portcove/issues/1",
    body: renderPortIssueBody({
      title: "Pokémon: Yellow!",
      upstream: "https://github.com/example/shared.git/",
      portKey: "pokemon-yellow",
    }),
  };
  assert.equal(normalizePortKey("Pokémon: Yellow!"), "pokemon-yellow");
  assert.ok(findPortIssueDuplicates([existing], {
    title: "Pokemon Yellow",
    upstream: "https://github.com/example/shared",
    portKey: "pokemon-yellow",
  }).length === 1);
  assert.deepEqual(findPortIssueDuplicates([existing], {
    title: "Pokemon Red",
    upstream: "https://github.com/example/shared",
    portKey: "pokemon-red",
  }), []);
  assert.throws(() => renderPortIssueBody({ title: "Missing key", upstream: "https://example.test/port" }), /requires a durable --port-key/);
});

test("New Port form parsing requires a canonical key and direct https upstream", () => {
  const body = `### Direct upstream URL

https://github.com/example/shared

### Durable game or target key

pokemon-yellow

### User outcome and why this port matters

Play the game.`;
  assert.deepEqual(parsePortIssueForm(body), {
    upstream: "https://github.com/example/shared",
    portKey: "pokemon-yellow",
  });
  assert.throws(() => parsePortIssueForm(body.replace("pokemon-yellow", "Pokemon Yellow")), /canonical lowercase kebab-case: pokemon-yellow/);
  assert.throws(() => parsePortIssueForm(body.replace("https://github.com/example/shared", "http://example.test/shared")), /valid https URL/);
  assert.throws(() => parsePortIssueForm(body.replace("https://github.com/example/shared", "_No response_")), /missing Direct upstream/);
  assert.throws(() => parsePortIssueForm(body.replace("pokemon-yellow", "_No response_")), /missing Durable game/);
});

test("marker reconciliation preserves form content and is repeatable", () => {
  const body = `### Direct upstream URL

https://github.com/example/shared

### Durable game or target key

pokemon-yellow

Contributor evidence stays here.

<!-- portcove-port -->
<!-- portcove-port -->
<!-- portcove-upstream: https://wrong.test -->
<!-- portcove-port-key: wrong -->`;
  const once = reconcilePortIssueMarkers(body, {
    upstream: "https://github.com/example/shared",
    portKey: "pokemon-yellow",
  });
  const twice = reconcilePortIssueMarkers(once, {
    upstream: "https://github.com/example/shared",
    portKey: "pokemon-yellow",
  });
  assert.equal(once, twice);
  assert.match(once, /Contributor evidence stays here/);
  assert.equal(once.match(/<!-- portcove-port -->/g).length, 1);
  assert.equal(once.match(/<!-- portcove-upstream:/g).length, 1);
  assert.equal(once.match(/<!-- portcove-port-key:/g).length, 1);
});

test("doctor discovers unnormalized open [Port] issues but ignores ordinary body mentions", () => {
  const form = {
    number: 10,
    title: "[Port] Form Candidate",
    state: "OPEN",
    type: "Issue",
    url: "https://github.com/boburning/portcove/issues/10",
    body: `### Direct upstream URL\n\nhttps://example.test/form\n\n### Durable game or target key\n\nform-candidate\n\nSubmitting this form does not grant support.`,
  };
  const item = { title: form.title, "work type": "Research", content: form };
  const errors = validatePortIssueCoverage({ ports: [] }, [item], "boburning/portcove", [form]);
  assert.ok(errors.some(value => value.includes("lacks the canonical port marker") && value.includes("normalize-port --issue 10")));
  assert.ok(errors.some(value => value.includes("exactly one direct upstream")));
  assert.ok(errors.some(value => value.includes("not classified as Work type = Port")));
  assert.ok(validatePortIssueCoverage({ ports: [] }, [], "boburning/portcove", [form])
    .some(value => value.includes("not in the Project")));
  const unrelated = { number: 11, title: "Discuss intake", state: "OPEN", body: "The text [Port] appears here.", url: "https://github.com/boburning/portcove/issues/11" };
  assert.deepEqual(validatePortIssueCoverage({ ports: [] }, [], "boburning/portcove", [unrelated]), []);
});

test("deduplication sees punctuation-equivalent unnormalized form issues and permits distinct shared-upstream targets", () => {
  const formIssue = {
    number: 10,
    title: "[Port] Pokémon: Yellow!",
    state: "OPEN",
    url: "https://github.com/boburning/portcove/issues/10",
    body: `### Direct upstream URL\n\nhttps://github.com/example/shared\n\n### Durable game or target key\n\npokemon-yellow`,
  };
  assert.ok(findPortIssueDuplicates([formIssue], {
    title: "Pokemon Yellow",
    upstream: "https://github.com/example/shared/",
    portKey: "pokemon-yellow",
  })[0].reasons.includes("normalized title pokemon-yellow"));
  assert.deepEqual(findPortIssueDuplicates([formIssue], {
    title: "Pokemon Red",
    upstream: "https://github.com/example/shared",
    portKey: "pokemon-red",
  }), []);
});

test("Port stage validation is evidence-based and platform-scoped", () => {
  const catalog = { ports: [
    { id: "no-evidence", support_tier: "stable", platforms: ["windows"], automated_tested_platforms: [], manually_validated_platforms: [] },
    { id: "automated", support_tier: "beta", platforms: ["windows"], automated_tested_platforms: ["windows"], manually_validated_platforms: [] },
    { id: "windows-qualified", support_tier: "alpha", platforms: ["windows", "linux"], automated_tested_platforms: ["windows"], manually_validated_platforms: ["windows"] },
  ] };
  const item = (id, stage, blocker) => ({
    id: `item-${id}-${stage}`,
    title: `[Port] ${id}`,
    "port stage": stage,
    content: {
      type: "Issue",
      number: 1,
      url: `https://github.com/boburning/portcove/issues/${id}`,
      body: renderPortIssueBody({ title: id, upstream: `https://example.test/${id}`, catalogId: id, blocker }),
    },
  });
  assert.deepEqual(validatePortStageSemantics(catalog, [item("no-evidence", "Cataloged")]).errors, []);
  assert.deepEqual(validatePortStageSemantics(catalog, [item("automated", "Automated qualification")]).errors, []);
  const stableOverclaim = validatePortStageSemantics(catalog, [item("no-evidence", "Supported")]);
  assert.ok(stableOverclaim.errors.some(value => value.includes("no automated evidence")));
  assert.ok(stableOverclaim.errors.some(value => value.includes("no platform with matching")));
  const supported = validatePortStageSemantics(catalog, [item("windows-qualified", "Supported")]);
  assert.deepEqual(supported.errors, []);
  assert.deepEqual(qualifiedPlatforms(catalog.ports[2]), ["windows"]);
  assert.match(supported.diagnostics[0], /qualified platforms = windows/);
  assert.ok(validatePortStageSemantics(catalog, [item("windows-qualified", "Cataloged")]).warnings.length > 0);
});

test("Port stage validation rejects broken manual evidence non-catalog overclaim and unsupported rejection", () => {
  const invalidManual = { id: "manual-only", platforms: ["windows"], automated_tested_platforms: [], manually_validated_platforms: ["windows"] };
  const nonCatalog = {
    title: "[Port] Candidate",
    "port stage": "Supported",
    content: { type: "Issue", url: "https://github.com/boburning/portcove/issues/1", body: renderPortIssueBody({ title: "Candidate", upstream: "https://example.test/candidate", portKey: "candidate" }) },
  };
  assert.ok(validatePortStageSemantics({ ports: [invalidManual] }, [nonCatalog]).errors
    .some(value => value.includes("exactly one valid catalog ID")));
  assert.ok(validatePortStageSemantics({ ports: [invalidManual] }, []).errors
    .some(value => value.includes("manual evidence without matching")));

  const blocked = structuredClone(nonCatalog);
  blocked["port stage"] = "Blocked";
  blocked.content.body = renderPortIssueBody({ title: "Candidate", upstream: "https://example.test/candidate", portKey: "candidate", blocker: "No artifact exists. Resume when upstream publishes one." });
  const rejected = structuredClone(nonCatalog);
  rejected["port stage"] = "Rejected";
  assert.deepEqual(validatePortStageSemantics({ ports: [] }, [blocked, rejected]).errors, []);
  const invalidBlocked = structuredClone(blocked);
  invalidBlocked.content.body = renderPortIssueBody({ title: "Candidate", upstream: "https://example.test/candidate", portKey: "candidate" });
  assert.ok(validatePortStageSemantics({ ports: [] }, [invalidBlocked]).errors
    .some(value => value.includes("lacks a usable blocker and exact resume condition")));

  const catalogRejected = structuredClone(rejected);
  catalogRejected.content.body = renderPortIssueBody({ title: "Candidate", upstream: "https://example.test/candidate", catalogId: "candidate" });
  assert.ok(validatePortStageSemantics({ ports: [{ id: "candidate", platforms: [], automated_tested_platforms: [], manually_validated_platforms: [] }] }, [catalogRejected]).errors
    .some(value => value.includes("still represented as catalog-supported")));
});

test("Supported reconciliation only downgrades overstatement and becomes idempotent after application", () => {
  const catalog = { ports: [
    { id: "none", platforms: ["windows"], automated_tested_platforms: [], manually_validated_platforms: [] },
    { id: "auto", platforms: ["windows"], automated_tested_platforms: ["windows"], manually_validated_platforms: [] },
    { id: "qualified", platforms: ["windows", "linux"], automated_tested_platforms: ["windows"], manually_validated_platforms: ["windows"] },
  ] };
  const item = id => ({ id, title: `[Port] ${id}`, "port stage": "Supported", content: { type: "Issue", number: id, body: renderPortIssueBody({ title: id, upstream: `https://example.test/${id}`, catalogId: id }) } });
  const items = catalog.ports.map(port => item(port.id));
  const plan = planPortStageReconciliation(catalog, items);
  assert.deepEqual(plan.map(change => [change.itemId, change.to]), [["none", "Cataloged"], ["auto", "Automated qualification"]]);
  for (const change of plan) items.find(candidate => candidate.id === change.itemId)["port stage"] = change.to;
  assert.deepEqual(planPortStageReconciliation(catalog, items), []);
});

test("normalization initializes only unset neutral fields and always classifies Work type as Port", () => {
  const existing = {
    status: "Ready",
    priority: "High",
    horizon: "Next",
    "target release": "Alpha 2",
    "work type": "Research",
    workstream: "Sources and ROM validation",
    platform: "Windows",
    "port stage": "Researching",
    effort: "M",
  };
  assert.deepEqual(portFieldInitialization(existing), { "Work type": "Port" });
  assert.deepEqual(portFieldInitialization(null), {
    Status: "Inbox", Priority: "None", Horizon: "Someday", "Target release": "Unscheduled",
    "Work type": "Port", Workstream: "Port catalog", Platform: "Unknown", "Port stage": "Watchlist", Effort: "Unknown",
  });
});

test("final UX audit origins require complete unique enumerated canonical ownership", () => {
  assert.equal(uxAuditOriginIds.length, 178);
  const completeBody = "<!-- portcove-ux-audit-origins: " + uxAuditOriginIds.join(" ") + " -->";
  const item = (number, body) => ({
    title: "Owner " + number,
    content: { type: "Issue", url: "https://github.com/boburning/portcove/issues/" + number, body },
  });
  assert.deepEqual(uxAuditOrigins(completeBody), uxAuditOriginIds);
  assert.deepEqual(validateUxAuditOriginCoverage([item(1, completeBody)]), []);

  const missing = "<!-- portcove-ux-audit-origins: " + uxAuditOriginIds.slice(1).join(" ") + " -->";
  assert.ok(validateUxAuditOriginCoverage([item(1, missing)]).some(value => value.includes("lacks a canonical issue: SYS-01")));

  const duplicate = "<!-- portcove-ux-audit-origins: SYS-01 -->";
  assert.ok(validateUxAuditOriginCoverage([item(1, completeBody), item(2, duplicate)])
    .some(value => value.includes("duplicate owners: SYS-01")));

  for (const [body, expected] of [
    ["<!-- portcove-ux-audit-origins: SYS-99 -->", "Unknown UX audit origin"],
    ["<!-- portcove-ux-audit-origins: SYS-1 -->", "Malformed UX audit origin"],
    ["<!-- portcove-ux-audit-origins: SYS-01..SYS-14 -->", "range must enumerate"],
    ["<!-- portcove-wording-audit-origins: WORD-01 -->", "Superseded wording audit"],
  ]) {
    assert.ok(validateUxAuditOriginCoverage([item(1, body)]).some(value => value.includes(expected)));
  }
});

test("supported-source plan origin has exactly one canonical owner", () => {
  const marker = "<!-- portcove-origins: PCV-PLAN-SUPPORTED-SOURCE-PROVENANCE-2026-09-04 -->";
  const item = (number, body) => ({
    title: "Owner " + number,
    content: { type: "Issue", url: "https://github.com/boburning/portcove/issues/" + number, body },
  });
  assert.deepEqual(validatePlanOriginCoverage([item(36, marker)]), []);
  assert.ok(validatePlanOriginCoverage([])[0].includes("found 0"));
  assert.ok(validatePlanOriginCoverage([item(36, marker), item(99, marker)])[0].includes("found 2"));
  assert.ok(validatePlanOriginCoverage([item(99, marker)])[0].includes("must be owned by issue #36"));
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
    if (args[0] === "api" && args[1] === "repos/boburning/portcove/issues") return JSON.stringify({ node_id: "I_new", html_url: "https://github.com/boburning/portcove/issues/88", number: 88 });
    if (args[0] === "project" && args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[0] === "project" && args[1] === "field-list") return JSON.stringify({ fields: Object.entries(expectedFields).map(([name, value], index) => ({ id: `F${index}`, name, options: [{ id: `O${index}`, name: value }] })) });
    if (args[0] === "api" && args[1] === "graphql") {
      if (input.includes("issues(first: 100")) return JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
      if (input.includes("addProjectV2ItemById")) return JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "PVTI_new" } } } });
      if (input.includes("issue(number: 16)")) return JSON.stringify({ data: { repository: { issue: { id: "I_pipeline", number: 16 } }, node: { parent: null } } });
      if (input.includes("addSubIssue")) return JSON.stringify({ data: { addSubIssue: { issue: { id: "I_pipeline" }, subIssue: { id: "I_new" } } } });
      return JSON.stringify({ data: { node: { projectItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  const result = client.createPortIssue({ title: "New Port", upstream: "https://example.test/upstream", portKey: "new-port" });
  assert.equal(result.itemId, "PVTI_new");
  assert.equal(calls.filter(call => call.args[1] === "repos/boburning/portcove/issues").length, 1);
  assert.ok(calls.some(call => call.input?.includes("<!-- portcove-port -->")));
  assert.ok(calls.some(call => call.input?.includes("<!-- portcove-port-key: new-port -->")));
  const fieldEdit = calls.find(call => call.input?.includes("updateProjectV2ItemFieldValue"));
  assert.ok(Object.values(JSON.parse(fieldEdit.input).variables).some(input => input.fieldId === "F6" && input.value.singleSelectOptionId === "O6"));
  assert.equal(result.parentChanged, true);
  assert.equal(calls.filter(call => call.input?.includes("addSubIssue")).length, 1);
});

test("normalize-port preserves existing planning choices and is idempotent with mocked GitHub", () => {
  const calls = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  let body = `### Direct upstream URL

https://github.com/example/form-port

### Durable game or target key

form-port

### User outcome and why this port matters

Preserve this contributor text.`;
  let workType = "Research";
  const issue = () => ({
    node_id: "I_form",
    html_url: "https://github.com/boburning/portcove/issues/42",
    number: 42,
    title: "[Port] Form Port",
    body,
    state: "OPEN",
  });
  const fieldValues = () => [
    ["Status", "Ready"], ["Priority", "High"], ["Horizon", "Next"],
    ["Target release", "Alpha 2"], ["Work type", workType],
    ["Workstream", "Sources and ROM validation"], ["Platform", "Windows"],
    ["Port stage", "Researching"], ["Effort", "M"],
  ].map(([name, value]) => ({ name: value, field: { name } }));
  const runner = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "api" && args[1] === "repos/boburning/portcove/issues/42" && args.includes("PATCH")) {
      body = JSON.parse(input).body;
      return JSON.stringify(issue());
    }
    if (args[0] === "api" && args[1] === "repos/boburning/portcove/issues/42") return JSON.stringify(issue());
    if (args[0] === "project" && args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[0] === "project" && args[1] === "field-list") return JSON.stringify({ fields: [
      { id: "F_work_type", name: "Work type", options: [{ id: "O_port", name: "Port" }] },
    ] });
    if (args[0] === "api" && args[1] === "graphql") {
      if (input.includes("issues(first: 100")) return JSON.stringify({ data: { repository: { issues: {
        nodes: [{ ...issue(), __typename: "Issue", url: issue().html_url }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } });
      if (input.includes("items(first: 50")) return JSON.stringify({ data: { node: { items: {
        nodes: [{
          id: "PVTI_form",
          content: { __typename: "Issue", number: 42, title: issue().title, body, url: issue().html_url, state: "OPEN" },
          fieldValues: { nodes: fieldValues().map(value => ({ ...value, field: { __typename: "ProjectV2SingleSelectField", ...value.field } })) },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } });
      if (input.includes("issue(number: 16)")) return JSON.stringify({ data: {
        repository: { issue: { id: "I_pipeline", number: 16 } },
        node: { parent: { id: "I_pipeline", number: 16, url: "https://github.com/boburning/portcove/issues/16" } },
      } });
      if (input.includes("updateProjectV2ItemFieldValue")) {
        workType = "Port";
        return JSON.stringify({ data: { f0: { projectV2Item: { id: "PVTI_form" } } } });
      }
    }
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  const catalog = { ports: [] };
  const first = client.normalizePortIssue({ number: 42, catalog });
  assert.equal(first.bodyChanged, true);
  assert.equal(first.projectItemAdded, false);
  assert.deepEqual(first.fieldsChanged, ["Work type"]);
  assert.equal(first.parentChanged, false);
  assert.match(body, /Preserve this contributor text/);
  const second = client.normalizePortIssue({ number: 42, catalog });
  assert.equal(second.bodyChanged, false);
  assert.deepEqual(second.fieldsChanged, []);
  assert.equal(calls.filter(call => call.input?.includes("addProjectV2ItemById")).length, 0);
  assert.equal(calls.filter(call => call.input?.includes("addSubIssue")).length, 0);
});

test("repository issue inventory follows every GraphQL page", () => {
  const calls = [];
  const runner = (args, input) => {
    calls.push({ args, input });
    const after = JSON.parse(input).variables.after;
    const number = after ? 2 : 1;
    return JSON.stringify({ data: { repository: { issues: {
      nodes: [{ __typename: "Issue", number, title: `Issue ${number}`, body: "", url: `https://github.com/boburning/portcove/issues/${number}`, state: "OPEN" }],
      pageInfo: { hasNextPage: !after, endCursor: after ? null : "cursor-1" },
    } } } });
  };
  const issues = new RoadmapClient(config, runner).repositoryIssues();
  assert.deepEqual(issues.map(issue => issue.number), [1, 2]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => JSON.parse(call.input).variables.after), [null, "cursor-1"]);
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
  const runner = (args, input) => {
    if (args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[1] === "graphql") return JSON.stringify({ data: { node: { items: {
      nodes: [
        { id: "A", content: { __typename: "DraftIssue", title: "Same" }, fieldValues: { nodes: [] } },
        { id: "B", content: { __typename: "DraftIssue", title: "Same" }, fieldValues: { nodes: [] } },
        { id: "C", content: { __typename: "DraftIssue", title: "Before" }, fieldValues: { nodes: [] } },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } });
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

test("GraphQL Project item pagination reads every item and field page", () => {
  const calls = [];
  const runner = (args, input) => {
    calls.push({ args, input });
    if (args[1] === "view") return JSON.stringify({ id: "PVT" });
    const after = JSON.parse(input).variables.after;
    const item = after
      ? { id: "I2", content: { __typename: "DraftIssue", title: "Second", body: "Draft" }, fieldValues: { nodes: [{ name: "Inbox", field: { name: "Status" } }] } }
      : { id: "I1", content: { __typename: "Issue", number: 1, title: "First", body: "Issue", url: "https://github.com/boburning/portcove/issues/1", state: "OPEN" }, fieldValues: { nodes: [{ name: "Port", field: { name: "Work type" } }] } };
    return JSON.stringify({ data: { node: { items: { nodes: [item], pageInfo: after
      ? { hasNextPage: false, endCursor: null }
      : { hasNextPage: true, endCursor: "next" } } } } });
  };
  const items = new RoadmapClient(config, runner).itemList(1);
  assert.deepEqual(items.map(item => [item.id, item.title, item.type]), [["I1", "First", "Issue"], ["I2", "Second", "DraftIssue"]]);
  assert.equal(fieldValue(items[0], "Work type"), "Port");
  assert.equal(fieldValue(items[1], "Status"), "Inbox");
  assert.equal(calls.filter(call => call.args[1] === "graphql").length, 2);
});
