import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createGitHubRunner } from "./github-api.mjs";

import {
  RoadmapClient,
  analyzeReleaseReadiness,
  catalogQualificationSummary,
  completionEvidenceLinks,
  dependencyCycles,
  executeSetMany,
  executeCommitmentRename,
  executionSnapshot,
  validateExecutionSnapshot,
  normalizeRequirements,
  compareExecutionSnapshots,
  deriveExecutionContext,
  prepareConsumption,
  parseConsumptionRecord,
  consumedReference,
  executeConsumption,
  executionQueueData,
  consumptionEnvelope,
  fieldValue,
  featureIntakeFields,
  findPortIssueDuplicates,
  materializeViews,
  manualUiChecklist,
  maximumMutationChunkAssignments,
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
  renderExecutionQueue,
  resolveSnapshotOutput,
  selectNextItems,
  setManyRequiredReserve,
  uxAuditOriginIds,
  uxAuditOrigins,
  validateConfig,
  validateDurableIssueBody,
  validatePlanOriginCoverage,
  validatePortIssueCoverage,
  validatePortStageSemantics,
  validateSetManySpec,
  validateUxAuditOriginCoverage,
  viewMachineDrift,
} from "./roadmap.mjs";

const config = JSON.parse(await readFile(new URL("../.github/roadmap.json", import.meta.url)));
const newPortForm = await readFile(
  new URL("../.github/ISSUE_TEMPLATE/new-port.yml", import.meta.url),
  "utf8",
);

const pickupIssue = (number = 1104, body = "## Acceptance\n- [ ] Preserve recovery.") => ({
  id: `item-${number}`,
  status: "Ready",
  priority: "High",
  horizon: "Next",
  "release commitment": "Planned",
  "target release": "1.0",
  content: {
    id: `issue-${number}`,
    number,
    title: `Outcome ${number}`,
    body,
    state: "OPEN",
    url: `https://github.com/${config.repository}/issues/${number}`,
  },
});
const pickupRelations = () => ({ parent: null, subIssues: [], blockedBy: [], blocking: [] });
const pickupContext = (item = pickupIssue(), relationships = pickupRelations(), options = {}) =>
  deriveExecutionContext(config, item, relationships, {
    runner: "Local",
    comments: [],
    coverage: { complete: false, count: 50, total: 2200 },
    ...options,
  });
const acknowledgment = (context = pickupContext(), runner = "Local") =>
  prepareConsumption(
    context,
    {
      runner,
      action: "Compared acceptance; continue owned task",
      evidence: "https://github.com/boburning/portcove/pull/1",
    },
    [],
  );
const acknowledgmentComment = (context = pickupContext(), runner = "Local") => ({
  id: 1,
  body: acknowledgment(context, runner).body,
  url: `https://github.com/${config.repository}/issues/793#issuecomment-1`,
  author: { login: "recorder" },
});

test("requirements comparison ignores formatting, check marks and bare delivered links, not safety text", () => {
  const first = pickupIssue(
    1104,
    "## Acceptance\n- [ ] Preserve recovery.\n## Delivered evidence\n- [PR](https://github.com/boburning/portcove/pull/1)",
  );
  const second = pickupIssue(
    1104,
    "# Acceptance\r\n- [x]  Preserve recovery.\r\n## Delivered evidence\n- [new PR](https://github.com/boburning/portcove/pull/2)",
  );
  assert.equal(
    executionSnapshot(config, first, pickupRelations()).scope_revision,
    executionSnapshot(config, second, pickupRelations()).scope_revision,
  );
  for (const [old, next] of [
    ["Never delete originals", "Delete originals"],
    ["```\nnode verify.mjs --safe\n```", "```\nnode verify.mjs --unsafe\n```"],
    ["Preserve /saves", "Preserve /configuration"],
    ['```\nnode task.mjs "two  spaces"\n```', '```\nnode task.mjs "two spaces"\n```'],
    ['Use `"two  spaces"`', 'Use `"two spaces"`'],
    ['    command "two  spaces"', '    command "two spaces"'],
  ])
    assert.notEqual(
      normalizeRequirements(`## Delivered evidence\n${old}`),
      normalizeRequirements(`## Delivered evidence\n${next}`),
    );
});

test("scope, planning, genuine prerequisites and organization are separate comparison facets", () => {
  const initial = executionSnapshot(config, pickupIssue(), pickupRelations());
  assert.equal(compareExecutionSnapshots(initial).state, "unknown");
  assert.equal(compareExecutionSnapshots(initial, initial).state, "unchanged");
  const planned = executionSnapshot(
    config,
    { ...pickupIssue(), priority: "Medium" },
    pickupRelations(),
  );
  assert.deepEqual(compareExecutionSnapshots(planned, initial).changes, ["planning_changed"]);
  assert.deepEqual(compareExecutionSnapshots(planned, initial).planning_fields, ["Priority"]);
  const changed = executionSnapshot(
    config,
    pickupIssue(1104, "Do not activate until the current plan passes"),
    pickupRelations(),
  );
  assert.deepEqual(compareExecutionSnapshots(changed, initial).changes, [
    "scope_comparison_required",
  ]);
  const reference = { ...pickupIssue(925).content, projectStatus: "In progress" };
  const dependency = executionSnapshot(config, pickupIssue(), {
    ...pickupRelations(),
    blockedBy: [reference],
  });
  assert.deepEqual(compareExecutionSnapshots(dependency, initial).changes, [
    "prerequisites_changed",
  ]);
  const organization = executionSnapshot(config, pickupIssue(), {
    ...pickupRelations(),
    parent: reference,
  });
  assert.deepEqual(compareExecutionSnapshots(organization, initial).changes, [
    "organization_changed",
  ]);
  const closed = pickupIssue();
  closed.content.state = "CLOSED";
  assert.deepEqual(
    compareExecutionSnapshots(executionSnapshot(config, closed, pickupRelations()), initial)
      .changes,
    ["issue_state_changed"],
  );
  const closedPrerequisite = executionSnapshot(config, pickupIssue(), {
    ...pickupRelations(),
    blockedBy: [{ ...reference, state: "CLOSED" }],
  });
  assert.deepEqual(compareExecutionSnapshots(closedPrerequisite, dependency).changes, [
    "prerequisites_changed",
  ]);
  assert.throws(
    () =>
      compareExecutionSnapshots(
        initial,
        executionSnapshot(config, pickupIssue(209), pickupRelations()),
      ),
    /another repository or issue/,
  );
});

test("snapshot validation rejects altered hashes, malformed identities and missing facets", () => {
  const snapshot = pickupContext().snapshot;
  assert.equal(validateExecutionSnapshot(snapshot), snapshot);
  assert.throws(
    () => validateExecutionSnapshot({ ...snapshot, scope_revision: "changed" }),
    /invalid/,
  );
  assert.throws(
    () => validateExecutionSnapshot({ ...snapshot, issue: { ...snapshot.issue, number: 0 } }),
    /invalid/,
  );
  assert.throws(() => validateExecutionSnapshot({ ...snapshot, planning: {} }), /invalid/);
  assert.throws(
    () => parseConsumptionRecord("<!-- portcove-roadmap-consumed:v1 -->\nmissing JSON"),
    /incomplete/,
  );
});

test("context distinguishes bounded absence, actual API recorder, reported consumption and worker activity", () => {
  const first = pickupContext();
  assert.equal(first.pickup.current_requirements, "unknown");
  assert.equal(first.pickup.invoked, "unknown");
  const comment = acknowledgmentComment(first);
  const consumed = pickupContext(pickupIssue(), pickupRelations(), { comments: [comment] });
  assert.equal(consumed.pickup.current_requirements, "recorded consumed");
  assert.equal(consumed.pickup.last_record.recorder, "recorder");
  assert.equal(consumed.pickup.assigned, "unknown");
  assert.equal(consumed.reservation.assessment, "unknown");
  const changed = pickupContext(pickupIssue(1104, "New acceptance"), pickupRelations(), {
    comments: [comment],
  });
  assert.equal(changed.pickup.current_requirements, "pending comparison");
  assert.equal(changed.comparison.state, "comparison_required");
  assert.equal(changed.recommendation.execution_capability.startsWith("not assessed"), true);
});

test("exact older consumption reference is bound to configured repository, runner and task", () => {
  const comment = acknowledgmentComment();
  assert.equal(
    consumedReference(comment, { repository: config.repository, runner: "Local", issue: 1104 })
      .issue.number,
    1104,
  );
  for (const override of [{ repository: "other/repo" }, { runner: "Cloud A" }, { issue: 209 }])
    assert.throws(
      () =>
        consumedReference(comment, {
          repository: config.repository,
          runner: "Local",
          issue: 1104,
          ...override,
        }),
      /does not match/,
    );
  assert.throws(
    () =>
      new RoadmapClient(config).coordinationComment(
        "https://github.com/other/repo/issues/793#issuecomment-1",
      ),
    /this repository/,
  );
});

test("repeated recorded consumption is quiet, but returning to an earlier revision is a new comparison", () => {
  const context = pickupContext();
  const options = { runner: "Local", action: "Continue", evidence: "actual inspected task" };
  const first = acknowledgmentComment(context);
  assert.equal(prepareConsumption(context, options, [first]).needed, false);
  assert.equal(
    prepareConsumption(context, { ...options, runner: "Cloud A" }, [first]).needed,
    true,
  );
  const changed = acknowledgmentComment(pickupContext(pickupIssue(1104, "Changed acceptance")));
  assert.equal(prepareConsumption(context, options, [first, changed]).needed, true);
});

test("acknowledgment payload roundtrips action and evidence code fences without poisoning later reads", () => {
  const context = pickupContext();
  const action = 'Compared example: ```json\n{}\n```; preserve "two  spaces"';
  const evidence = 'Actual recipe:\n```json\n{"observed":true}\n```';
  const prepared = prepareConsumption(context, { runner: "Local", action, evidence }, []);
  const record = parseConsumptionRecord(prepared.body);
  assert.equal(record.action, action);
  assert.equal(record.evidence, evidence);
  assert.equal(
    prepareConsumption(context, { runner: "Local", action, evidence }, [
      { body: prepared.body, url: "existing" },
    ]).needed,
    false,
  );
});

function consumptionClient({
  changed = false,
  transport = false,
  readback = true,
  prior = [],
} = {}) {
  const writes = [];
  const context = pickupContext();
  const saved = acknowledgment(context);
  return {
    writes,
    context,
    client: {
      coordinationRecords: () => ({
        nodes: writes.length
          ? [...prior, { ...acknowledgmentComment(context), body: writes[0].body }]
          : prior,
      }),
      executionIssue: () => ({
        item: changed ? pickupIssue(1104, "Concurrent requirements") : pickupIssue(),
        relationships: pickupRelations(),
      }),
      api: {
        request(method, endpoint, payload) {
          assert.equal(method, "POST");
          assert.equal(endpoint, `repos/${config.repository}/issues/793/comments`);
          writes.push(payload);
          if (transport) throw new Error("lost POST response");
          return { body: { id: 1 } };
        },
      },
      coordinationComment: () => {
        if (!readback) throw new Error("unavailable readback");
        return { ...acknowledgmentComment(context), body: writes[0]?.body ?? saved.body };
      },
    },
  };
}

test("acknowledgment plans by default and stale requirements cause zero writes", () => {
  const options = {
    config,
    runner: "Local",
    action: "Compared live scope",
    evidence: "actual task read",
  };
  const fresh = consumptionClient();
  assert.equal(executeConsumption({ ...options, ...fresh }).status, "planned");
  assert.equal(fresh.writes.length, 0);
  const stale = consumptionClient({ changed: true });
  assert.throws(
    () => executeConsumption({ ...options, ...stale, apply: true }),
    /snapshot is stale/,
  );
  assert.equal(stale.writes.length, 0);
  const repeated = consumptionClient({ prior: [acknowledgmentComment()] });
  assert.equal(executeConsumption({ ...options, ...repeated, apply: true }).needed, false);
  assert.equal(repeated.writes.length, 0);
});

test("ambiguous acknowledgment POST is read back without retry; unavailable result retains exact pending body", () => {
  const options = {
    config,
    runner: "Local",
    action: "Compared live scope",
    evidence: "actual task read",
    apply: true,
  };
  const ambiguous = consumptionClient({ transport: true });
  assert.equal(executeConsumption({ ...options, ...ambiguous }).readback, "exact");
  assert.equal(ambiguous.writes.length, 1);
  const unavailable = consumptionClient({ readback: false });
  assert.throws(
    () => executeConsumption({ ...options, ...unavailable }),
    (error) => {
      assert.equal(error.operationStatus, "unknown");
      assert.equal(error.operationEvidence.pending_body, unavailable.writes[0].body);
      return true;
    },
  );
  assert.equal(unavailable.writes.length, 1);
});

test("structured queue preserves Planned recommendations without inferring a grant or execution route", () => {
  const planned = pickupIssue();
  const required = { ...pickupIssue(925), "release commitment": "Required" };
  const output = executionQueueData([planned, required]);
  assert.equal(output.candidates.length, 2);
  assert.equal(output.candidates[1].after, output.candidates[0].url);
  assert.equal(output.candidates[0].reservation, "unknown");
  assert.equal(output.candidates[0].execution_capability, "not assessed");
});

test("consumption JSON preserves the planned body and quiet success in the existing operation envelope", () => {
  const planned = consumptionEnvelope({ status: "planned", ...acknowledgment() });
  assert.equal(planned.operation, "roadmap.acknowledge");
  assert.equal(planned.status, "planned");
  assert.equal(parseConsumptionRecord(planned.evidence.body).snapshot.issue.number, 1104);
  const quiet = consumptionEnvelope({
    status: "succeeded",
    needed: false,
    reason: "Already consumed",
    url: "retained reference",
  });
  assert.equal(quiet.summary, "Already consumed");
  assert.equal(quiet.evidence.needed, false);
});

test("selected context collects typed relationships completely and matches opaque Project identity", () => {
  const connection = (nodes, totalCount = nodes.length, hasNextPage = false) => ({
    nodes,
    totalCount,
    pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor" : null },
  });
  const projectItem = (id, project = "PVT-selected") => ({
    id,
    project: { id: project },
    fieldValues: connection([{ name: "Ready", field: { name: "Status" } }]),
  });
  const reference = pickupIssue(925).content;
  const issue = {
    ...pickupIssue().content,
    parent: null,
    projectItems: connection([projectItem("selected"), projectItem("other", "PVT-other")]),
    blockedBy: connection([], 1, true),
    blocking: connection([reference]),
    subIssues: connection([]),
  };
  const client = new RoadmapClient(config);
  client.projectDetails = () => ({ id: "PVT-selected" });
  client.graphql = (query) => {
    if (query.includes("repository(owner")) return { repository: { issue } };
    return {
      node: {
        blockedBy: connection([
          { ...reference, projectItems: connection([projectItem("dependency")]) },
        ]),
      },
    };
  };
  const result = client.executionIssue(1104);
  assert.equal(result.item.id, "selected");
  assert.equal(result.relationships.blockedBy.length, 1);
  assert.equal(result.relationships.blockedBy[0].projectStatus, "Ready");
  assert.equal(result.relationships.blocking[0].number, 925);
  issue.blockedBy = connection([]);
  issue.subIssues = connection([reference, reference]);
  client.graphql = () => ({ repository: { issue }, node: { subIssues: issue.subIssues } });
  assert.throws(() => client.executionIssue(1104), /duplicate/);
});

test("acknowledgment history fails closed on count changes and recent-window truncation", () => {
  const client = new RoadmapClient(config);
  client.repositoryIssue = () => ({ comments: 1 });
  client.api.paginateRest = () => [];
  assert.throws(() => client.coordinationRecords({ complete: true }), /incomplete/);
  client.graphql = () => ({
    repository: {
      issue: { comments: { nodes: [], totalCount: 100, pageInfo: { hasPreviousPage: true } } },
    },
  });
  assert.throws(() => client.coordinationRecords(), /incomplete/);
});

test("capability milestones preserve history and fail closed during partial migration", () => {
  const item = (
    number,
    target,
    status = "Done",
    commitment = "Required",
    state = "CLOSED",
    dependencies = [],
  ) => ({
    id: `item-${number}`,
    status,
    "target release": target,
    "release commitment": commitment,
    content: {
      number,
      state,
      title: `Outcome ${number}`,
      blockedBy: {
        totalCount: dependencies.length,
        nodes: dependencies.map((n) => ({ number: n })),
      },
    },
  });
  const history = item(1, "Alpha 2");
  const beta = item(2, "Public beta");
  const production = item(3, "1.0", "Ready", "Required", "OPEN");
  assert.equal(analyzeReleaseReadiness([history, beta, production], "Public beta").ready, true);
  assert.equal(analyzeReleaseReadiness([history, beta, production], "1.0").ready, false);
  assert.equal(
    analyzeReleaseReadiness([history, beta, production], "Public beta", {
      candidateIssues: [1],
    }).ready,
    true,
  );
  assert.equal(
    analyzeReleaseReadiness([history, beta, production], "Public beta", {
      candidateIssues: [3],
    }).ready,
    false,
  );
  assert.throws(
    () =>
      analyzeReleaseReadiness([history], "Public beta", {
        candidateIssues: [],
      }),
    /explicit positive/,
  );
  assert.throws(
    () =>
      analyzeReleaseReadiness([history], "Public beta", {
        candidateIssues: [999],
      }),
    /missing from the Project/,
  );
  assert.equal(analyzeReleaseReadiness([history], "Alpha 2").ready, true);
  const unmigrated = item(4, "Alpha 3", "Ready", "Opportunistic", "OPEN");
  assert.equal(
    analyzeReleaseReadiness([history, beta, unmigrated], "Public beta").migrationConflicts.length,
    1,
  );
  assert.equal(analyzeReleaseReadiness([history, beta, unmigrated], "Public beta").ready, false);
  const missingTarget = item(5, undefined);
  assert.equal(analyzeReleaseReadiness([history, beta, missingTarget], "Public beta").ready, false);
  assert.equal(analyzeReleaseReadiness([item(5, "Unscheduled")], "Public beta").ready, false);
  assert.equal(analyzeReleaseReadiness([item(5, "Typo")], "1.0").ready, false);
  assert.equal(
    analyzeReleaseReadiness([item(6, "Public beta", "Done", "Required", "OPEN")], "Public beta")
      .ready,
    false,
  );
  assert.equal(
    analyzeReleaseReadiness(
      [item(7, "Public beta", "Done", "Required", "CLOSED", [3]), production],
      "Public beta",
    ).dependencyConflicts.length,
    1,
  );
  assert.equal(
    analyzeReleaseReadiness([item(8, "Public beta", "Done", "")], "Public beta").ready,
    false,
  );
  const selected = item(9, "1.0", "Done", "Opportunistic", "CLOSED", [10]);
  const blocker = item(10, "Post-1.0", "Ready", "Opportunistic", "OPEN");
  assert.equal(
    analyzeReleaseReadiness([selected, blocker], "Public beta", {
      candidateIssues: [9],
    }).ready,
    false,
  );
  blocker.status = "Done";
  blocker.content.state = "CLOSED";
  assert.equal(
    analyzeReleaseReadiness([selected, blocker], "Public beta", {
      candidateIssues: [9],
    }).ready,
    true,
  );
  blocker["release commitment"] = "";
  assert.equal(
    analyzeReleaseReadiness([selected, blocker], "Public beta", {
      candidateIssues: [9],
    }).ready,
    false,
  );
});

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
  assert.deepEqual(parseArguments(["set", "#42", "--status", "In progress", "--release=Alpha 1"]), {
    command: "set",
    positionals: ["#42"],
    options: { "--status": "In progress", "--release": "Alpha 1" },
  });
  assert.deepEqual(parseArguments(["set-many", "--spec-file", "plan.json", "--apply", "--json"]), {
    command: "set-many",
    positionals: [],
    options: { "--spec-file": "plan.json", "--apply": true, "--json": true },
  });
  assert.throws(() => parseArguments(["move", "PVTI_1", "--before"]), /requires a value/);
});

test("field reconciliation preserves existing option identities and user data", () => {
  const desired = [{ name: "Status", options: ["Inbox", "Done"] }];
  const mockedGhFields = {
    fields: [
      {
        id: "PVTSSF_status",
        name: "Status",
        type: "ProjectV2SingleSelectField",
        options: [
          {
            id: "existing",
            name: "Custom",
            color: "BLUE",
            description: "user data",
          },
        ],
      },
    ],
  };
  const existingPlan = planFieldReconciliation(desired, mockedGhFields);
  assert.equal(existingPlan[0].action, "update");
  assert.deepEqual(
    existingPlan[0].options.map((option) => option.name),
    ["Custom", "Inbox", "Done"],
  );
  assert.equal(existingPlan[0].options[0].id, "existing");

  const freshPlan = planFieldReconciliation(desired, mockedGhFields, {
    freshProject: true,
  });
  assert.deepEqual(
    freshPlan[0].options.map((option) => option.name),
    ["Inbox", "Done"],
  );
});

test("view reconciliation reuses matching GraphQL views and creates only missing views", () => {
  const desired = [
    {
      name: "Now Board",
      layout: "BOARD_LAYOUT",
      filter: "horizon:Now",
      fields: ["Title"],
    },
    {
      name: "Port Pipeline",
      layout: "BOARD_LAYOUT",
      filter: "work-type:Port",
      fields: ["Title"],
    },
  ];
  const mockedGraphqlViews = [
    {
      id: "PVTV_now",
      name: "Now Board",
      layout: "TABLE_LAYOUT",
      filter: "horizon:Now",
      fields: { nodes: [{ name: "Title" }] },
    },
  ];
  assert.deepEqual(
    planViewReconciliation(desired, mockedGraphqlViews).map((step) => [
      step.action,
      step.desired.name,
    ]),
    [
      ["update", "Now Board"],
      ["create", "Port Pipeline"],
    ],
  );
});

test("active port work is additive and preserves the complete inventory view", () => {
  const inventory = config.views.find((view) => view.name === "Port Pipeline");
  assert.equal(inventory.filter, "work-type:Port");
  const active = config.views.find((view) => view.name === "Active Port Work");
  assert.equal(active.layout, "TABLE_LAYOUT");
  assert.equal(active.filter, "work-type:Port -status:Done -status:Deferred");
  assert.deepEqual(active.fields, [
    "Title",
    "Priority",
    "Horizon",
    "Status",
    "Port stage",
    "Platform",
    "Assignees",
  ]);
  assert.equal(active.manual_group_by, "Status");
  assert.equal(active.manual_sort_by, "Priority,manual");
  const existing = config.views
    .filter((view) => view !== active)
    .map((view, index) => ({ ...view, id: `V${index}` }));
  const plan = planViewReconciliation(config.views, existing);
  assert.deepEqual(
    plan.filter((step) => step.action === "create").map((step) => step.desired.name),
    ["Active Port Work"],
  );
  assert.equal(plan.find((step) => step.desired.name === inventory.name).actual.id, "V2");
});

test("next work excludes workstreams, completed items, and Later horizon", () => {
  const items = [
    {
      title: "Next medium",
      status: "Ready",
      priority: "Medium",
      horizon: "Next",
      "work type": "Bug",
    },
    {
      title: "Now high",
      status: "In progress",
      priority: "High",
      horizon: "Now",
      "work type": "Product feature",
    },
    {
      title: "Now urgent",
      status: "Ready",
      priority: "Urgent",
      horizon: "Now",
      "work type": "Security",
    },
    {
      title: "Parent",
      status: "Ready",
      priority: "Urgent",
      horizon: "Now",
      "work type": "Workstream",
    },
    {
      title: "Done",
      status: "Done",
      priority: "Urgent",
      horizon: "Now",
      "work type": "Bug",
    },
    {
      title: "Later",
      status: "Ready",
      priority: "Urgent",
      horizon: "Later",
      "work type": "Bug",
    },
  ];
  assert.deepEqual(
    selectNextItems(items).map((item) => item.title),
    ["Now urgent", "Now high", "Next medium"],
  );
});

test("catalog summary and release snapshot derive qualification data from catalog JSON", () => {
  const catalog = {
    ports: [
      {
        id: "one",
        support_tier: "stable",
        platforms: ["windows", "linux"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: ["windows"],
      },
      {
        id: "two",
        support_tier: "beta",
        platforms: ["windows"],
        automated_tested_platforms: [],
        manually_validated_platforms: [],
      },
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
    items: [
      {
        title: "Trust",
        status: "Blocked",
        priority: "Urgent",
        horizon: "Now",
        type: "Security",
        "target release": "Alpha 1",
        "release commitment": "Required",
        content: { url: "https://github.com/boburning/portcove/issues/1" },
      },
    ],
    catalog,
  });
  assert.match(document, /## Open blockers[\s\S]*Trust/);
  assert.match(document, /Catalog entries: 2/);
  assert.match(document, /This snapshot does not grant qualification/);
});

test("release snapshots are cumulative and Project Status alone authorizes completion", () => {
  const items = [
    {
      title: "Alpha blocker",
      status: "Blocked",
      "target release": "Alpha 1",
      "release commitment": "Required",
      content: {
        state: "OPEN",
        url: "https://github.com/boburning/portcove/issues/1",
        body: "Upstream https://example.test/not-evidence",
      },
    },
    {
      title: "Closed not planned",
      status: "Deferred",
      "target release": "Alpha 2",
      "release commitment": "Required",
      content: {
        state: "CLOSED",
        url: "https://github.com/boburning/portcove/issues/2",
        body: "## Completion evidence\n\nNone.",
      },
    },
    {
      title: "Beta complete",
      status: "Done",
      "target release": "Beta 1",
      "release commitment": "Required",
      content: {
        state: "CLOSED",
        url: "https://github.com/boburning/portcove/issues/3",
        body: "## Completion evidence\n\nhttps://github.com/boburning/portcove/pull/12",
      },
    },
    {
      title: "Later beta",
      status: "Ready",
      "target release": "Beta 2",
      "release commitment": "Required",
      content: {
        state: "OPEN",
        url: "https://github.com/boburning/portcove/issues/4",
      },
    },
  ];
  const document = renderSnapshot({
    release: "Beta 1",
    generatedAt: "2026-09-03T00:00:00Z",
    commit: "abc",
    projectUrl: "https://example.test/project",
    items,
    catalog: { ports: [] },
  });
  assert.match(document, /Cumulative required stages: Alpha 1, Alpha 2, Alpha 3, Beta 1/);
  assert.match(document, /## Open blockers[\s\S]*Alpha blocker/);
  assert.match(document, /## Completed required items[\s\S]*Beta complete/);
  assert.match(document, /## Unfinished required items[\s\S]*Closed not planned/);
  assert.match(
    document,
    /## Repository closure and Project Status inconsistencies[\s\S]*Closed not planned/,
  );
  assert.doesNotMatch(document, /Later beta/);
  assert.doesNotMatch(document, /example\.test\/not-evidence/);
  assert.match(document, /portcove\/pull\/12/);
});

test("release readiness separates required, opportunistic, unclassified, and genuine blocking dependencies", () => {
  const issue = (number, title, fields = {}, blockedBy = [], parent = null) => ({
    id: `item-${number}`,
    title,
    ...fields,
    content: {
      number,
      title,
      state: fields.status === "Done" ? "CLOSED" : "OPEN",
      url: `https://github.com/boburning/portcove/issues/${number}`,
      blockedBy: {
        nodes: blockedBy.map((dependency) => ({
          number: dependency,
          title: `Issue ${dependency}`,
          state: "OPEN",
          url: `https://github.com/boburning/portcove/issues/${dependency}`,
        })),
      },
      parent: parent ? { number: parent } : null,
    },
  });
  const items = [
    issue(
      1,
      "Required outcome",
      {
        status: "Ready",
        "target release": "Alpha 2",
        "release commitment": "Required",
        "work type": "Product feature",
      },
      [2],
    ),
    issue(2, "Misclassified dependency", {
      status: "Ready",
      "target release": "Post-V1",
      "release commitment": "Opportunistic",
      "work type": "Product feature",
    }),
    issue(3, "Optional slice", {
      status: "Ready",
      "target release": "Alpha 2",
      "release commitment": "Opportunistic",
      "work type": "Product feature",
    }),
    issue(4, "Unclassified release work", {
      status: "Ready",
      "target release": "Alpha 2",
      "work type": "Product feature",
    }),
    issue(5, "Unrelated intake", {
      status: "Inbox",
      "target release": "Unscheduled",
      "work type": "Port",
    }),
    issue(6, "Misclassified safety failure", {
      status: "Blocked",
      "target release": "Alpha 2",
      "release commitment": "Opportunistic",
      "work type": "Security",
    }),
    issue(
      7,
      "Child but not blocker",
      {
        status: "Ready",
        "target release": "Post-V1",
        "release commitment": "Opportunistic",
        "work type": "Product feature",
      },
      [],
      1,
    ),
  ];
  const analysis = analyzeReleaseReadiness(items, "Alpha 2");
  assert.deepEqual(analysis.effectiveRequired.map((item) => item.content.number).sort(), [1, 2, 6]);
  assert.deepEqual(analysis.opportunistic.map((item) => item.content.number).sort(), [3, 6]);
  assert.deepEqual(
    analysis.relevantUnclassified.map((item) => item.content.number),
    [4],
  );
  assert.deepEqual(
    analysis.safetyConflicts.map((item) => item.content.number),
    [6],
  );
  assert.equal(analysis.dependencyConflicts.length, 1);
  assert.equal(analysis.dependencyConflicts[0].dependency.content.number, 2);
  assert.equal(
    analysis.effectiveRequired.some((item) => item.content.number === 7),
    false,
  );
  assert.equal(
    analysis.effectiveRequired.some((item) => item.content.number === 5),
    false,
  );
  assert.equal(analysis.ready, false);
});

test("dependency analysis reports cycles and Project-missing blockers", () => {
  const one = {
    id: "one",
    title: "One",
    status: "Ready",
    "target release": "Alpha 1",
    "release commitment": "Required",
    content: {
      number: 1,
      url: "https://github.com/boburning/portcove/issues/1",
      blockedBy: { nodes: [{ number: 2, title: "Two" }] },
    },
  };
  const two = {
    id: "two",
    title: "Two",
    status: "Ready",
    "target release": "Alpha 1",
    "release commitment": "Required",
    content: {
      number: 2,
      url: "https://github.com/boburning/portcove/issues/2",
      blockedBy: {
        nodes: [
          { number: 1, title: "One" },
          {
            number: 99,
            title: "Missing",
            url: "https://github.com/boburning/portcove/issues/99",
          },
        ],
      },
    },
  };
  assert.deepEqual(dependencyCycles([one, two]), [[1, 2, 1]]);
  const analysis = analyzeReleaseReadiness([one, two], "Alpha 1");
  assert.equal(analysis.missingProjectDependencies.length, 1);
  assert.equal(analysis.missingProjectDependencies[0].dependency.content.number, 99);
  assert.equal(analysis.ready, false);
});

test("readiness fails closed when a blocking-dependency page is truncated", () => {
  const item = {
    id: "one",
    title: "One",
    status: "Done",
    "target release": "Alpha 1",
    "release commitment": "Required",
    content: {
      number: 1,
      state: "CLOSED",
      url: "https://github.com/boburning/portcove/issues/1",
      blockedBy: { totalCount: 11, nodes: [] },
    },
  };
  const analysis = analyzeReleaseReadiness([item], "Alpha 1");
  assert.deepEqual(analysis.truncatedDependencies, [item]);
  assert.equal(analysis.ready, false);

  const unrelated = {
    ...item,
    id: "later",
    "target release": "Post-V1",
    "release commitment": "Opportunistic",
    content: { ...item.content, number: 2 },
  };
  const required = {
    ...item,
    content: { ...item.content, blockedBy: { totalCount: 0, nodes: [] } },
  };
  const scoped = analyzeReleaseReadiness([required, unrelated], "Alpha 1");
  assert.deepEqual(scoped.truncatedDependencies, []);
  assert.equal(scoped.ready, true);
});

test("completion evidence excludes ordinary upstream URLs and accepts explicit or typed records", () => {
  const links = completionEvidenceLinks([
    {
      body: [
        "Upstream: https://github.com/vendor/game",
        "Implementation: https://github.com/boburning/portcove/pull/22",
        "Qualification: https://example.test/qualification/windows",
        "## Completion evidence",
        "https://example.test/evidence/result.json",
        "## Dependencies and blockers",
        "https://example.test/not-evidence",
      ].join("\n"),
    },
  ]);
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
    "## User outcome\n\nUseful outcome",
    "## Current behavior and evidence\n\nObserved behavior",
    "## Scope\n\nExact scope",
    "## Non-goals\n\nExcluded behavior",
    "## Acceptance criteria\n\n- [ ] Proven",
    "## Required tests\n\nFocused test",
    "## Documentation impact\n\nNo stable contract change",
    "## Dependencies and blockers\n\nNone",
    "## Completion evidence\n\nRequired before Done",
  ].join("\n\n");
  assert.equal(validateDurableIssueBody(body), body);
});

test("feature intake accepts neutral and explicit planning fields", () => {
  assert.deepEqual(featureIntakeFields(config), {
    Status: "Inbox",
    Priority: "None",
    Horizon: "Someday",
    "Target release": "Unscheduled",
    "Work type": "Product feature",
    Effort: "Unknown",
  });
  assert.equal(
    featureIntakeFields(config, {
      "--workstream": "Desktop UX",
      "--platform": "Windows",
      "--priority": "High",
      "--horizon": "Now",
      "--release": "Alpha 2",
    }).Workstream,
    "Desktop UX",
  );
  assert.equal(
    featureIntakeFields(config, { "--commitment": "Planned" })["Release commitment"],
    "Planned",
  );
  assert.throws(
    () => featureIntakeFields(config, { "--platform": "Everywhere" }),
    /not a valid Platform/,
  );
});

test("Release commitment field migration is idempotent", () => {
  const desired = [config.fields.find((field) => field.name === "Release commitment")];
  assert.equal(planFieldReconciliation(desired, { fields: [] })[0].action, "create");
  const actual = {
    fields: [
      {
        id: "commitment",
        name: "Release commitment",
        type: "ProjectV2SingleSelectField",
        options: desired[0].options.map((name, index) => ({
          id: `option-${index}`,
          name,
        })),
      },
    ],
  };
  assert.equal(planFieldReconciliation(desired, actual)[0].action, "keep");
});

test("active release materialization and manual checklist are explicit", () => {
  const current = materializeViews(config).find((view) => view.name === "Required for Beta");
  assert.equal(
    current.filter,
    `-status:Done target-release:"${config.active_release}" release-commitment:Required`,
  );
  const alpha1 = materializeViews({
    ...config,
    active_release: "Alpha 1",
  }).find((view) => view.name === "Required for Beta");
  assert.equal(alpha1.filter, '-status:Done target-release:"Alpha 1" release-commitment:Required');
  assert.equal(
    manualUiChecklist(config).filter((line) => /^\d+\. .*: group by/.test(line)).length,
    config.views.length,
  );
  assert.match(manualUiChecklist(config).at(-1), /completion workflows/);
});

test("doctor drift covers identity linkage field options and view properties", () => {
  const desiredViews = materializeViews(config);
  const fields = config.fields.map((field, index) => ({
    id: `F${index}`,
    name: field.name,
    type: "ProjectV2SingleSelectField",
    options: field.options.map((name, option) => ({
      id: `${index}-${option}`,
      name,
    })),
  }));
  const views = desiredViews.map((view, index) => ({
    id: `V${index}`,
    name: view.name,
    layout: view.layout,
    filter: view.filter,
    fields: { nodes: view.fields.map((name) => ({ name })) },
  }));
  assert.deepEqual(
    projectMachineDrift(config, {
      details: { title: config.project.title, number: 1, public: true },
      fields,
      views,
      repositories: [{ owner: { login: "boburning" }, name: "portcove" }],
    }),
    [],
  );
  views[0].filter = "wrong";
  fields[0].options = fields[0].options.filter((option) => option.name !== "Done");
  fields[1].options.push({ id: "unexpected", name: "Unexpected" });
  views.push({
    id: "extra",
    name: "Unexpected",
    layout: "TABLE_LAYOUT",
    filter: "",
    fields: { nodes: [{ name: "Title" }] },
  });
  const drift = projectMachineDrift(config, {
    details: { title: "Wrong", number: 1, public: false },
    fields,
    views,
    repositories: [],
  });
  assert.ok(drift.some((value) => value.includes("project title")));
  assert.ok(drift.some((value) => value.includes("visibility")));
  assert.ok(drift.some((value) => value.includes("not linked")));
  assert.ok(drift.some((value) => value.includes("field Status")));
  assert.ok(drift.some((value) => value.includes("unexpected options")));
  assert.ok(drift.some((value) => value.includes("view Next Queue")));
  assert.ok(drift.some((value) => value.includes("unexpected view")));
  assert.ok(viewMachineDrift(desiredViews[0], views[0]).some((value) => value.includes("filter")));
});

test("one-port-one-issue coverage rejects missing duplicate grouped and draft authority", () => {
  const catalog = { ports: [{ id: "one" }, { id: "two" }] };
  const repositoryIssue = (number, id) => ({
    number,
    title: `[Port] ${id}`,
    type: "Issue",
    url: `https://github.com/boburning/portcove/issues/${number}`,
    body: renderPortIssueBody({
      title: id,
      upstream: `https://example.test/${id}`,
      catalogId: id,
    }),
  });
  const projectItem = (issue, workType = "Port") => ({
    title: issue.title,
    "work type": workType,
    content: issue,
  });
  const first = repositoryIssue(1, "one");
  const second = repositoryIssue(2, "two");
  assert.deepEqual(
    validatePortIssueCoverage(
      catalog,
      [projectItem(first), projectItem(second)],
      "boburning/portcove",
      [first, second],
    ),
    [],
  );
  const duplicateIssue = repositoryIssue(2, "one");
  const duplicate = validatePortIssueCoverage(
    catalog,
    [projectItem(first), projectItem(duplicateIssue)],
    "boburning/portcove",
    [first, duplicateIssue],
  );
  assert.ok(duplicate.some((value) => value.includes("Two live issues")));
  assert.ok(duplicate.some((value) => value.includes("lacks a canonical")));
  const grouped = repositoryIssue(3, "one");
  grouped.body += "\n<!-- portcove-catalog-id: two -->";
  assert.ok(
    validatePortIssueCoverage(catalog, [projectItem(grouped)], "boburning/portcove", [
      grouped,
    ]).some((value) => value.includes("multiple catalog ports")),
  );
  const draft = {
    title: "Draft only",
    "work type": "Port",
    content: { type: "DraftIssue", body: "<!-- portcove-port -->" },
  };
  assert.ok(
    validatePortIssueCoverage({ ports: [] }, [draft], "boburning/portcove").some((value) =>
      value.includes("not backed"),
    ),
  );
  assert.ok(
    validatePortIssueCoverage(catalog, [projectItem(first)], "boburning/portcove", [
      first,
      second,
    ]).some((value) => value.includes("not in the Project")),
  );
  assert.ok(
    validatePortIssueCoverage(
      { ports: [{ id: "one" }] },
      [projectItem(first, "Research")],
      "boburning/portcove",
      [first],
    ).some((value) => value.includes("not classified as Work type = Port")),
  );
  const external = structuredClone(first);
  external.url = "https://github.com/example/other/issues/1";
  assert.ok(
    validatePortIssueCoverage(
      { ports: [{ id: "one" }] },
      [projectItem(external)],
      "boburning/portcove",
      [first],
    ).some((value) => value.includes("not in the Project")),
  );
});

test("intake permits integration completion without inventing gameplay qualification", () => {
  const body = renderPortIssueBody({
    title: "Fixture",
    upstream: "https://example.test/fixture",
    portKey: "fixture",
  });
  assert.doesNotThrow(() => validateDurableIssueBody(body));
  assert.match(body, /absent optional gameplay evidence as Unknown, not failure/);
  assert.match(body, /explicit hands-on support claims still require actual observations/);
  assert.match(body, /Unsupported management operations remain unavailable with reasons/);
  assert.match(body, /Manual qualification: Not yet recorded/);
  assert.doesNotMatch(body, /required hands-on behavior for each claimed platform/);
});

test("one-port-one-issue coverage requires unique candidate keys and allows shared upstream multi-game repositories", () => {
  const issue = (number, title, body) => ({
    number,
    title,
    type: "Issue",
    url: "https://github.com/boburning/portcove/issues/" + number,
    body,
  });
  const projectItem = (repositoryIssue) => ({
    title: repositoryIssue.title,
    "work type": "Port",
    content: repositoryIssue,
  });
  const first = issue(
    1,
    "[Port] One",
    renderPortIssueBody({
      title: "One",
      upstream: "https://example.test/shared",
      portKey: "one",
    }),
  );
  const second = issue(
    2,
    "[Port] Two",
    renderPortIssueBody({
      title: "Two",
      upstream: "https://example.test/shared/",
      portKey: "two",
    }),
  );
  assert.deepEqual(
    validatePortIssueCoverage(
      { ports: [] },
      [projectItem(first), projectItem(second)],
      "boburning/portcove",
      [first, second],
    ),
    [],
  );
  const duplicateKey = issue(
    3,
    "[Port] Different title",
    renderPortIssueBody({
      title: "Different title",
      upstream: "https://example.test/other",
      portKey: "one",
    }),
  );
  assert.ok(
    validatePortIssueCoverage(
      { ports: [] },
      [projectItem(first), projectItem(duplicateKey)],
      "boburning/portcove",
      [first, duplicateKey],
    ).some((value) => value.includes("non-catalog port key one")),
  );
  const unlabeled = issue(
    4,
    "[Port] Three",
    "<!-- portcove-port -->\n<!-- portcove-upstream: https://example.test/three -->",
  );
  assert.ok(
    validatePortIssueCoverage({ ports: [] }, [projectItem(unlabeled)], "boburning/portcove", [
      unlabeled,
    ]).some((value) => value.includes("research/watchlist")),
  );
  assert.ok(
    validatePortIssueCoverage({ ports: [] }, [projectItem(unlabeled)], "boburning/portcove", [
      unlabeled,
    ]).some((value) => value.includes("durable port key")),
  );
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
  assert.ok(
    findPortIssueDuplicates([existing], {
      title: "Pokemon Yellow",
      upstream: "https://github.com/example/shared",
      portKey: "pokemon-yellow",
    }).length === 1,
  );
  assert.deepEqual(
    findPortIssueDuplicates([existing], {
      title: "Pokemon Red",
      upstream: "https://github.com/example/shared",
      portKey: "pokemon-red",
    }),
    [],
  );
  assert.throws(
    () =>
      renderPortIssueBody({
        title: "Missing key",
        upstream: "https://example.test/port",
      }),
    /requires a durable --port-key/,
  );
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
  assert.throws(
    () => parsePortIssueForm(body.replace("pokemon-yellow", "Pokemon Yellow")),
    /canonical lowercase kebab-case: pokemon-yellow/,
  );
  assert.throws(
    () =>
      parsePortIssueForm(
        body.replace("https://github.com/example/shared", "http://example.test/shared"),
      ),
    /valid https URL/,
  );
  assert.throws(
    () => parsePortIssueForm(body.replace("https://github.com/example/shared", "_No response_")),
    /missing Direct upstream/,
  );
  assert.throws(
    () => parsePortIssueForm(body.replace("pokemon-yellow", "_No response_")),
    /missing Durable game/,
  );
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
  assert.ok(
    errors.some(
      (value) =>
        value.includes("lacks the canonical port marker") &&
        value.includes("normalize-port --issue 10"),
    ),
  );
  assert.ok(errors.some((value) => value.includes("exactly one direct upstream")));
  assert.ok(errors.some((value) => value.includes("not classified as Work type = Port")));
  assert.ok(
    validatePortIssueCoverage({ ports: [] }, [], "boburning/portcove", [form]).some((value) =>
      value.includes("not in the Project"),
    ),
  );
  const unrelated = {
    number: 11,
    title: "Discuss intake",
    state: "OPEN",
    body: "The text [Port] appears here.",
    url: "https://github.com/boburning/portcove/issues/11",
  };
  assert.deepEqual(
    validatePortIssueCoverage({ ports: [] }, [], "boburning/portcove", [unrelated]),
    [],
  );
});

test("deduplication sees punctuation-equivalent unnormalized form issues and permits distinct shared-upstream targets", () => {
  const formIssue = {
    number: 10,
    title: "[Port] Pokémon: Yellow!",
    state: "OPEN",
    url: "https://github.com/boburning/portcove/issues/10",
    body: `### Direct upstream URL\n\nhttps://github.com/example/shared\n\n### Durable game or target key\n\npokemon-yellow`,
  };
  assert.ok(
    findPortIssueDuplicates([formIssue], {
      title: "Pokemon Yellow",
      upstream: "https://github.com/example/shared/",
      portKey: "pokemon-yellow",
    })[0].reasons.includes("normalized title pokemon-yellow"),
  );
  assert.deepEqual(
    findPortIssueDuplicates([formIssue], {
      title: "Pokemon Red",
      upstream: "https://github.com/example/shared",
      portKey: "pokemon-red",
    }),
    [],
  );
});

test("Port stage validation is evidence-based and platform-scoped", () => {
  const catalog = {
    ports: [
      {
        id: "no-evidence",
        support_tier: "stable",
        platforms: ["windows"],
        automated_tested_platforms: [],
        manually_validated_platforms: [],
      },
      {
        id: "automated",
        support_tier: "beta",
        platforms: ["windows"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: [],
      },
      {
        id: "windows-qualified",
        support_tier: "alpha",
        platforms: ["windows", "linux"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: ["windows"],
      },
    ],
  };
  const item = (id, stage, blocker) => ({
    id: `item-${id}-${stage}`,
    title: `[Port] ${id}`,
    "port stage": stage,
    content: {
      type: "Issue",
      number: 1,
      url: `https://github.com/boburning/portcove/issues/${id}`,
      body: renderPortIssueBody({
        title: id,
        upstream: `https://example.test/${id}`,
        catalogId: id,
        blocker,
      }),
    },
  });
  assert.deepEqual(
    validatePortStageSemantics(catalog, [item("no-evidence", "Cataloged")]).errors,
    [],
  );
  assert.deepEqual(
    validatePortStageSemantics(catalog, [item("automated", "Automated qualification")]).errors,
    [],
  );
  const stableOverclaim = validatePortStageSemantics(catalog, [item("no-evidence", "Supported")]);
  assert.ok(stableOverclaim.errors.some((value) => value.includes("no automated evidence")));
  assert.ok(stableOverclaim.errors.some((value) => value.includes("no platform with matching")));
  const supported = validatePortStageSemantics(catalog, [item("windows-qualified", "Supported")]);
  assert.deepEqual(supported.errors, []);
  assert.deepEqual(qualifiedPlatforms(catalog.ports[2]), ["windows"]);
  assert.match(supported.diagnostics[0], /qualified platforms = windows/);
  assert.ok(
    validatePortStageSemantics(catalog, [item("windows-qualified", "Cataloged")]).warnings.length >
      0,
  );
});

test("Port stage validation consumes only passed exact qualification records", () => {
  const port = {
    id: "exact",
    platforms: ["windows", "linux"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
  };
  const record = (kind, outcome, platform = "windows") => ({
    scope: { port_id: port.id, platform },
    kind,
    outcome,
  });
  const item = (stage) => ({
    id: `exact-${stage}`,
    title: "[Port] Exact",
    "port stage": stage,
    content: {
      type: "Issue",
      number: 1,
      url: "https://github.com/boburning/portcove/issues/1",
      body: renderPortIssueBody({
        title: "Exact",
        upstream: "https://example.test/exact",
        catalogId: port.id,
      }),
    },
  });
  const records = [
    record("automated_lifecycle", "passed"),
    record("automated_lifecycle", "passed"),
    record("known_failure", "failed"),
    record("hands_on", "passed"),
    record("structural_check", "passed", "linux"),
    record("automated_lifecycle", "failed", "linux"),
  ];
  const catalog = { ports: [port], source_catalog: { qualification: records } };

  assert.deepEqual(qualifiedPlatforms(port, records), ["windows"]);
  assert.deepEqual(validatePortStageSemantics(catalog, [item("Supported")]).errors, []);
  assert.match(
    validatePortStageSemantics(catalog, [item("Supported")]).diagnostics[0],
    /qualified platforms = windows/,
  );

  for (const disallowed of [
    [record("structural_check", "passed")],
    [record("automated_lifecycle", "failed")],
    [record("automated_lifecycle", "passed", "steam-deck")],
  ]) {
    const result = validatePortStageSemantics(
      { ports: [port], source_catalog: { qualification: disallowed } },
      [item("Automated qualification")],
    );
    assert.ok(result.errors.some((value) => value.includes("no automated evidence")));
  }

  const handsOnOnly = validatePortStageSemantics(
    {
      ports: [port],
      source_catalog: { qualification: [record("hands_on", "passed")] },
    },
    [item("Supported")],
  );
  assert.ok(handsOnOnly.errors.some((value) => value.includes("manual evidence without matching")));
  assert.ok(handsOnOnly.errors.some((value) => value.includes("no platform with matching")));

  const undeclaredHandsOn = validatePortStageSemantics(
    {
      ports: [port],
      source_catalog: {
        qualification: [
          record("automated_lifecycle", "passed"),
          record("hands_on", "passed", "steam-deck"),
        ],
      },
    },
    [item("Automated qualification")],
  );
  assert.ok(
    undeclaredHandsOn.errors.some(
      (value) =>
        value.includes("manual evidence without matching declared automated qualification") &&
        value.includes("steam-deck"),
    ),
  );
});

test("Port stage validation rejects broken manual evidence non-catalog overclaim and unsupported rejection", () => {
  const invalidManual = {
    id: "manual-only",
    platforms: ["windows"],
    automated_tested_platforms: [],
    manually_validated_platforms: ["windows"],
  };
  const nonCatalog = {
    title: "[Port] Candidate",
    "port stage": "Supported",
    content: {
      type: "Issue",
      url: "https://github.com/boburning/portcove/issues/1",
      body: renderPortIssueBody({
        title: "Candidate",
        upstream: "https://example.test/candidate",
        portKey: "candidate",
      }),
    },
  };
  assert.ok(
    validatePortStageSemantics({ ports: [invalidManual] }, [nonCatalog]).errors.some((value) =>
      value.includes("exactly one valid catalog ID"),
    ),
  );
  assert.ok(
    validatePortStageSemantics({ ports: [invalidManual] }, []).errors.some((value) =>
      value.includes("manual evidence without matching"),
    ),
  );

  const blocked = structuredClone(nonCatalog);
  blocked["port stage"] = "Blocked";
  blocked.content.body = renderPortIssueBody({
    title: "Candidate",
    upstream: "https://example.test/candidate",
    portKey: "candidate",
    blocker: "No artifact exists. Resume when upstream publishes one.",
  });
  const rejected = structuredClone(nonCatalog);
  rejected["port stage"] = "Rejected";
  assert.deepEqual(validatePortStageSemantics({ ports: [] }, [blocked, rejected]).errors, []);
  const invalidBlocked = structuredClone(blocked);
  invalidBlocked.content.body = renderPortIssueBody({
    title: "Candidate",
    upstream: "https://example.test/candidate",
    portKey: "candidate",
  });
  assert.ok(
    validatePortStageSemantics({ ports: [] }, [invalidBlocked]).errors.some((value) =>
      value.includes("lacks a usable blocker and exact resume condition"),
    ),
  );

  const catalogRejected = structuredClone(rejected);
  catalogRejected.content.body = renderPortIssueBody({
    title: "Candidate",
    upstream: "https://example.test/candidate",
    catalogId: "candidate",
  });
  assert.ok(
    validatePortStageSemantics(
      {
        ports: [
          {
            id: "candidate",
            platforms: [],
            automated_tested_platforms: [],
            manually_validated_platforms: [],
          },
        ],
      },
      [catalogRejected],
    ).errors.some((value) => value.includes("still represented as catalog-supported")),
  );
});

test("Supported reconciliation only downgrades overstatement and becomes idempotent after application", () => {
  const catalog = {
    ports: [
      {
        id: "none",
        platforms: ["windows"],
        automated_tested_platforms: [],
        manually_validated_platforms: [],
      },
      {
        id: "auto",
        platforms: ["windows"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: [],
      },
      {
        id: "qualified",
        platforms: ["windows", "linux"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: ["windows"],
      },
    ],
  };
  const item = (id) => ({
    id,
    title: `[Port] ${id}`,
    "port stage": "Supported",
    content: {
      type: "Issue",
      number: id,
      body: renderPortIssueBody({
        title: id,
        upstream: `https://example.test/${id}`,
        catalogId: id,
      }),
    },
  });
  const items = catalog.ports.map((port) => item(port.id));
  const plan = planPortStageReconciliation(catalog, items);
  assert.deepEqual(
    plan.map((change) => [change.itemId, change.to]),
    [
      ["none", "Cataloged"],
      ["auto", "Automated qualification"],
    ],
  );
  for (const change of plan)
    items.find((candidate) => candidate.id === change.itemId)["port stage"] = change.to;
  assert.deepEqual(planPortStageReconciliation(catalog, items), []);
});

test("Supported reconciliation planning uses exact automated and hands-on records", () => {
  const ports = ["none", "auto", "qualified"].map((id) => ({
    id,
    platforms: ["windows"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
  }));
  const qualification = [
    {
      scope: { port_id: "auto", platform: "windows" },
      kind: "automated_lifecycle",
      outcome: "passed",
    },
    {
      scope: { port_id: "qualified", platform: "windows" },
      kind: "automated_lifecycle",
      outcome: "passed",
    },
    {
      scope: { port_id: "qualified", platform: "windows" },
      kind: "hands_on",
      outcome: "passed",
    },
  ];
  const items = ports.map((port) => ({
    id: port.id,
    title: `[Port] ${port.id}`,
    "port stage": "Supported",
    content: {
      type: "Issue",
      number: port.id,
      body: renderPortIssueBody({
        title: port.id,
        upstream: `https://example.test/${port.id}`,
        catalogId: port.id,
      }),
    },
  }));

  assert.deepEqual(
    planPortStageReconciliation({ ports, source_catalog: { qualification } }, items).map(
      (change) => [change.itemId, change.to],
    ),
    [
      ["none", "Cataloged"],
      ["auto", "Automated qualification"],
    ],
  );
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
    Status: "Inbox",
    Priority: "None",
    Horizon: "Someday",
    "Target release": "Unscheduled",
    "Work type": "Port",
    Workstream: "Port catalog",
    Platform: "Unknown",
    "Port stage": "Watchlist",
    Effort: "Unknown",
  });
});

test("final UX audit origins require complete unique enumerated canonical ownership", () => {
  assert.equal(uxAuditOriginIds.length, 178);
  const completeBody = "<!-- portcove-ux-audit-origins: " + uxAuditOriginIds.join(" ") + " -->";
  const item = (number, body) => ({
    title: "Owner " + number,
    content: {
      type: "Issue",
      url: "https://github.com/boburning/portcove/issues/" + number,
      body,
    },
  });
  assert.deepEqual(uxAuditOrigins(completeBody), uxAuditOriginIds);
  assert.deepEqual(validateUxAuditOriginCoverage([item(1, completeBody)]), []);

  const missing = "<!-- portcove-ux-audit-origins: " + uxAuditOriginIds.slice(1).join(" ") + " -->";
  assert.ok(
    validateUxAuditOriginCoverage([item(1, missing)]).some((value) =>
      value.includes("lacks a canonical issue: SYS-01"),
    ),
  );

  const duplicate = "<!-- portcove-ux-audit-origins: SYS-01 -->";
  assert.ok(
    validateUxAuditOriginCoverage([item(1, completeBody), item(2, duplicate)]).some((value) =>
      value.includes("duplicate owners: SYS-01"),
    ),
  );

  for (const [body, expected] of [
    ["<!-- portcove-ux-audit-origins: SYS-99 -->", "Unknown UX audit origin"],
    ["<!-- portcove-ux-audit-origins: SYS-1 -->", "Malformed UX audit origin"],
    ["<!-- portcove-ux-audit-origins: SYS-01..SYS-14 -->", "range must enumerate"],
    ["<!-- portcove-wording-audit-origins: WORD-01 -->", "Superseded wording audit"],
  ]) {
    assert.ok(
      validateUxAuditOriginCoverage([item(1, body)]).some((value) => value.includes(expected)),
    );
  }
});

test("supported-source plan origin has exactly one canonical owner", () => {
  const marker = "<!-- portcove-origins: PCV-PLAN-SUPPORTED-SOURCE-PROVENANCE-2026-09-04 -->";
  const item = (number, body) => ({
    title: "Owner " + number,
    content: {
      type: "Issue",
      url: "https://github.com/boburning/portcove/issues/" + number,
      body,
    },
  });
  assert.deepEqual(validatePlanOriginCoverage([item(36, marker)]), []);
  assert.ok(validatePlanOriginCoverage([])[0].includes("found 0"));
  assert.ok(
    validatePlanOriginCoverage([item(36, marker), item(99, marker)])[0].includes("found 2"),
  );
  assert.ok(
    validatePlanOriginCoverage([item(99, marker)])[0].includes("must be owned by issue #36"),
  );
});

test("RoadmapClient capture uses mocked gh output and stores planning fields only in Project calls", () => {
  const calls = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner = (args, input) => {
    calls.push({ args, input });
    if (args[1] === "item-create") return JSON.stringify({ id: "PVTI_draft", title: "Candidate" });
    if (args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[1] === "field-list")
      return JSON.stringify({
        fields: [
          {
            id: "PVTSSF_status",
            name: "Status",
            options: [{ id: "OPT_inbox", name: "Inbox" }],
          },
          {
            id: "PVTSSF_priority",
            name: "Priority",
            options: [{ id: "OPT_none", name: "None" }],
          },
        ],
      });
    if (args[1] === "graphql") return JSON.stringify({ data: {} });
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  const result = client.capture({
    title: "Candidate",
    body: "Upstream: https://example.test/port",
    fields: { Status: "Inbox", Priority: "None" },
  });
  assert.equal(result.id, "PVTI_draft");
  assert.equal(calls.filter((call) => call.args[1] === "item-create").length, 1);
  const edit = calls.find((call) => call.input?.includes("updateProjectV2ItemFieldValue"));
  const variables = JSON.parse(edit.input).variables;
  assert.deepEqual(
    Object.values(variables).map((input) => [input.fieldId, input.value.singleSelectOptionId]),
    [
      ["PVTSSF_status", "OPT_inbox"],
      ["PVTSSF_priority", "OPT_none"],
    ],
  );
});

test("capture-port creates one Project-backed issue without depending on parent capacity", () => {
  const calls = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const expectedFields = {
    Status: "Inbox",
    Priority: "None",
    Horizon: "Someday",
    "Target release": "Unscheduled",
    "Work type": "Port",
    Workstream: "Port catalog",
    Platform: "Unknown",
    "Port stage": "Watchlist",
    Effort: "Unknown",
  };
  const runner = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "api" && args[2] === "repos/boburning/portcove/issues")
      return JSON.stringify({
        node_id: "I_new",
        html_url: "https://github.com/boburning/portcove/issues/88",
        number: 88,
      });
    if (args[0] === "project" && args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[0] === "project" && args[1] === "field-list")
      return JSON.stringify({
        fields: Object.entries(expectedFields).map(([name, value], index) => ({
          id: `F${index}`,
          name,
          options: [{ id: `O${index}`, name: value }],
        })),
      });
    if (args[0] === "api" && args[1] === "graphql") {
      assert.doesNotMatch(input, /issue\(number: 16\)|\bparent\s*\{|addSubIssue|removeSubIssue/);
      if (input.includes("issues(first: 100"))
        return JSON.stringify({
          data: {
            repository: {
              issues: {
                totalCount: 0,
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      if (input.includes("addProjectV2ItemById"))
        return JSON.stringify({
          data: { addProjectV2ItemById: { item: { id: "PVTI_new" } } },
        });
      return JSON.stringify({
        data: {
          node: {
            projectItems: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    return "";
  };
  const client = new RoadmapClient(mockedConfig, runner);
  client.repositoryIssues = () => [];
  const result = client.createPortIssue({
    title: "New Port",
    upstream: "https://example.test/upstream",
    portKey: "new-port",
  });
  assert.equal(result.itemId, "PVTI_new");
  assert.equal(
    calls.filter((call) => call.args[2] === "repos/boburning/portcove/issues").length,
    1,
  );
  assert.ok(calls.some((call) => call.input?.includes("<!-- portcove-port -->")));
  assert.ok(calls.some((call) => call.input?.includes("<!-- portcove-port-key: new-port -->")));
  const fieldEdit = calls.find((call) => call.input?.includes("updateProjectV2ItemFieldValue"));
  assert.ok(
    Object.values(JSON.parse(fieldEdit.input).variables).some(
      (input) => input.fieldId === "F6" && input.value.singleSelectOptionId === "O6",
    ),
  );
  assert.equal(calls.filter((call) => call.input?.includes("addProjectV2ItemById")).length, 1);
});

for (const parentNumber of [null, 16, 777]) {
  test(`normalize-port preserves planning and parent ${parentNumber ?? "absence"} idempotently`, () => {
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
      parent: parentNumber === null ? null : { number: parentNumber },
    });
    const fieldValues = () =>
      [
        ["Status", "Ready"],
        ["Priority", "High"],
        ["Horizon", "Next"],
        ["Target release", "Alpha 2"],
        ["Work type", workType],
        ["Workstream", "Sources and ROM validation"],
        ["Platform", "Windows"],
        ["Port stage", "Researching"],
        ["Effort", "M"],
      ].map(([name, value]) => ({ name: value, field: { name } }));
    const runner = (args, input) => {
      calls.push({ args, input });
      if (
        args[0] === "api" &&
        args[2] === "repos/boburning/portcove/issues/42" &&
        args.includes("PATCH")
      ) {
        body = JSON.parse(input).body;
        return JSON.stringify(issue());
      }
      if (args[0] === "api" && args[2] === "repos/boburning/portcove/issues/42")
        return JSON.stringify(issue());
      if (args[0] === "project" && args[1] === "view") return JSON.stringify({ id: "PVT_project" });
      if (args[0] === "project" && args[1] === "field-list")
        return JSON.stringify({
          fields: [
            {
              id: "F_work_type",
              name: "Work type",
              options: [{ id: "O_port", name: "Port" }],
            },
          ],
        });
      if (args[0] === "api" && args[1] === "graphql") {
        assert.doesNotMatch(input, /issue\(number: 16\)|\bparent\s*\{|addSubIssue|removeSubIssue/);
        if (input.includes("issues(first: 100"))
          return JSON.stringify({
            data: {
              repository: {
                issues: {
                  totalCount: 1,
                  nodes: [{ ...issue(), __typename: "Issue", url: issue().html_url }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        if (input.includes("items(first: 50"))
          return JSON.stringify({
            data: {
              node: {
                items: {
                  totalCount: 1,
                  nodes: [
                    {
                      id: "PVTI_form",
                      content: {
                        __typename: "Issue",
                        number: 42,
                        title: issue().title,
                        body,
                        url: issue().html_url,
                        state: "OPEN",
                      },
                      fieldValues: {
                        totalCount: fieldValues().length,
                        nodes: fieldValues().map((value) => ({
                          ...value,
                          field: {
                            __typename: "ProjectV2SingleSelectField",
                            ...value.field,
                          },
                        })),
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        if (input.includes("updateProjectV2ItemFieldValue")) {
          workType = "Port";
          return JSON.stringify({
            data: { f0: { projectV2Item: { id: "PVTI_form" } } },
          });
        }
      }
      return "";
    };
    const client = new RoadmapClient(mockedConfig, runner);
    client.repositoryIssues = () => [{ ...issue(), type: "Issue", url: issue().html_url }];
    const catalog = { ports: [] };
    const first = client.normalizePortIssue({ number: 42, catalog });
    assert.equal(first.bodyChanged, true);
    assert.equal(first.projectItemAdded, false);
    assert.deepEqual(first.fieldsChanged, ["Work type"]);
    assert.match(body, /Preserve this contributor text/);
    const second = client.normalizePortIssue({ number: 42, catalog });
    assert.equal(second.bodyChanged, false);
    assert.deepEqual(second.fieldsChanged, []);
    assert.equal(calls.filter((call) => call.input?.includes("addProjectV2ItemById")).length, 0);
    assert.equal(calls.filter((call) => call.input?.includes("addSubIssue")).length, 0);
  });
}

function included(body, headers = {}) {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `HTTP/2.0 200 OK\r\n${lines.join("\r\n")}\r\n\r\n${JSON.stringify(body)}`;
}

function restIssue(number, overrides = {}) {
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

test("repository issue inventory follows every REST page and filters pull requests", () => {
  const calls = [];
  let markers = 0;
  const runner = (args) => {
    calls.push(args);
    const endpoint = args[2];
    if (endpoint.includes("direction=desc")) {
      markers += 1;
      return included([restIssue(3, { pull_request: { url: "https://example.test" } })]);
    }
    if (endpoint === "https://api.github.test/issues?page=2")
      return included([restIssue(3, { pull_request: { url: "https://example.test" } })]);
    return included([restIssue(1), restIssue(2)], {
      link: '<https://api.github.test/issues?page=2>; rel="next"',
    });
  };
  const issues = new RoadmapClient(config, runner).repositoryIssues();
  assert.deepEqual(
    issues.map((issue) => issue.number),
    [1, 2],
  );
  assert.equal(markers, 2);
  assert.equal(calls.length, 4);
});

test("repository issue inventory rejects pagination loops duplicates and a changing high-water mark", () => {
  const scenarios = [
    (args) => {
      const endpoint = args[2];
      if (endpoint.includes("direction=desc")) return included([restIssue(1)]);
      return included([restIssue(1)], {
        link: `<${endpoint}>; rel="next"`,
      });
    },
    (args) => {
      const endpoint = args[2];
      if (endpoint.includes("direction=desc")) return included([restIssue(1)]);
      return included([restIssue(1), restIssue(1)]);
    },
    (() => {
      let marker = 1;
      return (args) => {
        if (args[2].includes("direction=desc")) return included([restIssue(marker++)]);
        return included([restIssue(1)]);
      };
    })(),
  ];
  for (const runner of scenarios) {
    assert.throws(
      () => new RoadmapClient(config, runner).repositoryIssues(),
      /inventory|pagination/,
    );
  }
});

test("promotion validation happens before any GitHub mutation", () => {
  let calls = 0;
  const client = new RoadmapClient(config, () => {
    calls += 1;
    return "";
  });
  assert.throws(() => client.promote("PVTI_draft", "lightweight note"), /incomplete/);
  assert.equal(calls, 0);
});

test("move refuses ambiguous item references", () => {
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner = (args) => {
    if (args[1] === "view") return JSON.stringify({ id: "PVT_project" });
    if (args[1] === "graphql")
      return JSON.stringify({
        data: {
          node: {
            items: {
              totalCount: 3,
              nodes: [
                {
                  id: "A",
                  content: { __typename: "DraftIssue", title: "Same" },
                  fieldValues: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
                {
                  id: "B",
                  content: { __typename: "DraftIssue", title: "Same" },
                  fieldValues: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
                {
                  id: "C",
                  content: { __typename: "DraftIssue", title: "Before" },
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
        },
      });
    return "";
  };
  assert.throws(
    () => new RoadmapClient(mockedConfig, runner).moveBefore("Same", "Before"),
    /ambiguous/,
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
    if (args[0] === "api" && args[1] === "graphql") {
      const after = JSON.parse(input).variables.after;
      return JSON.stringify({
        data: {
          node: {
            projectItems: after
              ? {
                  nodes: [{ id: "PVTI_existing", project: { id: "PVT_project" } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                }
              : {
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

test("GraphQL view pagination reads every page", () => {
  const calls = [];
  const runner = (args, input) => {
    calls.push({ args, input });
    const after = JSON.parse(input).variables.after;
    return JSON.stringify({
      data: {
        node: {
          id: "PVT",
          views: after
            ? {
                totalCount: 2,
                nodes: [completeView("V2", "Second")],
                pageInfo: { hasNextPage: false, endCursor: null },
              }
            : {
                totalCount: 2,
                nodes: [completeView("V1", "First")],
                pageInfo: { hasNextPage: true, endCursor: "next" },
              },
        },
      },
    });
  };
  assert.deepEqual(
    new RoadmapClient(config, runner).viewList("PVT").map((view) => view.name),
    ["First", "Second"],
  );
  assert.equal(calls.length, 2);
});

function completeView(id, name) {
  const empty = () => ({
    totalCount: 0,
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  return {
    id,
    name,
    fields: empty(),
    groupByFields: empty(),
    verticalGroupByFields: empty(),
    sortByFields: empty(),
  };
}

test("view renames retain identity and repeated reconciliation creates no duplicate", () => {
  const desired = {
    name: "Product Outcomes",
    previous_name: "Product Roadmap",
    layout: "TABLE_LAYOUT",
    filter: "label:roadmap-outcome",
    fields: ["Title"],
    manual_group_by: null,
    manual_sort_by: "manual",
  };
  const original = {
    ...completeView("V_original", "Product Roadmap"),
    layout: desired.layout,
    filter: desired.filter,
    fields: { nodes: [{ id: "F_title", name: "Title" }] },
  };
  const plan = planViewReconciliation([desired], [original]);
  assert.equal(plan[0].action, "update");
  assert.equal(plan[0].actual.id, "V_original");
  const saved = { ...original, name: desired.name };
  assert.equal(planViewReconciliation([desired], [saved])[0].action, "keep");
  assert.throws(
    () => planViewReconciliation([desired], [original, { ...saved, id: "V_duplicate" }]),
    /ambiguous/,
  );
  assert.throws(() => planViewReconciliation([desired], [original, original]), /duplicate actual/);
  assert.throws(
    () => planViewReconciliation([desired, { ...desired, name: "Other" }], [original]),
    /duplicate view identity/,
  );
});

test("view inventory refuses incomplete records rather than claiming a complete UI", () => {
  for (const alter of [
    (node) => {
      node.id = "wrong";
    },
    (node) => {
      delete node.views.totalCount;
    },
    (node) => {
      node.views.totalCount = 2;
    },
    (node) => {
      node.views.nodes.push(node.views.nodes[0]);
      node.views.totalCount = 2;
    },
    (node) => {
      node.views.nodes[0].fields.pageInfo.hasNextPage = true;
    },
    (node) => {
      delete node.views.nodes[0].sortByFields;
    },
    (node) => {
      node.views.pageInfo.hasNextPage = true;
      node.views.pageInfo.endCursor = null;
    },
  ]) {
    const node = {
      id: "PVT",
      views: {
        totalCount: 1,
        nodes: [completeView("V1", "One")],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    alter(node);
    assert.throws(
      () => new RoadmapClient(config, () => JSON.stringify({ data: { node } })).viewList("PVT"),
      /incomplete GitHub inventory/,
    );
  }
});

test("readable grouping and sorting distinguish empty settings from unavailable evidence", () => {
  const desired = {
    name: "One",
    layout: "TABLE_LAYOUT",
    filter: "",
    fields: [],
    manual_group_by: "Status",
    manual_sort_by: "Priority,manual",
  };
  const actual = { ...completeView("V1", "One"), layout: desired.layout, filter: "" };
  assert.match(
    viewMachineDrift(desired, actual).join("\n"),
    /grouping nothing.*UI change required/,
  );
  actual.groupByFields.nodes = [{ id: "F_status", name: "Status" }];
  actual.sortByFields.nodes = [{ direction: "ASC", field: { id: "F_priority", name: "Priority" } }];
  assert.deepEqual(viewMachineDrift(desired, actual), []);
  actual.sortByFields.nodes[0].direction = "DESC";
  assert.match(viewMachineDrift(desired, actual).join("\n"), /Priority:DESC/);
  actual.sortByFields.nodes[0].direction = "ASC";
  actual.verticalGroupByFields.nodes = [{ id: "F_hidden", name: "Platform" }];
  assert.match(viewMachineDrift(desired, actual).join("\n"), /secondary grouping Platform/);
});

test("view reconciliation preflights every view and verifies saved identities", () => {
  const desired = {
    name: "One",
    layout: "TABLE_LAYOUT",
    filter: "wanted",
    fields: ["Title"],
    manual_group_by: null,
    manual_sort_by: "manual",
  };
  const views = [desired, { ...desired, name: "Two" }];
  const settings = { ...config, views };
  const saved = views.map((view, index) => ({
    ...completeView(`V${index}`, view.name),
    layout: view.layout,
    filter: "old",
    fields: { nodes: [{ id: "Ftitle", name: "Title" }] },
  }));
  const client = new RoadmapClient(settings, () => {
    throw new Error("unexpected GitHub call");
  });
  client.viewList = () => saved;
  const writes = [];
  client.graphql = (query, variables) => {
    writes.push(variables.input);
    Object.assign(
      saved.find((view) => view.id === variables.input.viewId),
      { filter: variables.input.filter },
    );
  };
  saved[1].groupByFields.nodes = [{ id: "Fstatus", name: "Status" }];
  assert.throws(() => client.reconcileViews("P", [{ id: "Ftitle", name: "Title" }]), /owner UI/);
  assert.equal(writes.length, 0);
  saved[1].groupByFields.nodes = [];
  client.reconcileViews("P", [{ id: "Ftitle", name: "Title" }]);
  assert.equal(writes.length, 2);
  assert.equal(
    client
      .reconcileViews("P", [{ id: "Ftitle", name: "Title" }])
      .every((step) => step.action === "keep"),
    true,
  );
  saved[0].filter = "old";
  client.graphql = () => {};
  assert.throws(
    () => client.reconcileViews("P", [{ id: "Ftitle", name: "Title" }]),
    /readback did not match/,
  );
});

test("display outcome markers and release views cannot change gate or execution membership", () => {
  const fields = {
    Status: "Ready",
    Horizon: "Next",
    Priority: "High",
    "Work type": "Product feature",
    "Target release": "Public beta",
    "Release commitment": "Planned",
  };
  const item = {
    id: "PVTI_demo",
    content: { number: 99, state: "OPEN", title: "Demo", body: "" },
    fieldValues: Object.entries(fields).map(([name, value]) => ({ name: value, field: { name } })),
  };
  const marked = { ...item, labels: [config.outcome_label] };
  const summarize = (record) => {
    const analysis = analyzeReleaseReadiness([record], "Public beta");
    return {
      ready: analysis.ready,
      required: analysis.effectiveRequired.map((entry) => entry.id),
      unfinished: analysis.unfinishedRequired.map((entry) => entry.id),
      planned: analysis.planned.map((entry) => entry.id),
    };
  };
  assert.deepEqual(summarize(item), summarize(marked));
  assert.equal(selectNextItems([marked])[0], marked);
  const byName = new Map(materializeViews(config).map((view) => [view.name, view]));
  assert.match(byName.get("Product Outcomes").filter, /label:roadmap-outcome/);
  assert.doesNotMatch(byName.get("Product Outcomes").filter, /-status:Done/);
  assert.match(byName.get("In Progress").filter, /status:/);
  assert.doesNotMatch(byName.get("In Progress").filter, /horizon:/);
  assert.equal(byName.get("Port Pipeline").filter, "work-type:Port");
  assert.match(byName.get("Required for Beta").filter, /release-commitment:Required/);
  assert.match(byName.get("Planned Additions").filter, /release-commitment:Planned/);
});

test("complete Project context reads every field page with opaque identity checks", () => {
  const calls = [];
  const runner = (args, input) => {
    calls.push({ args, input });
    if (args[2] === "users/boburning") return JSON.stringify({ type: "User" });
    const request = JSON.parse(input);
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

test("GraphQL Project item pagination reads every item with normalized fields", () => {
  const calls = [];
  const runner = (args, input) => {
    calls.push({ args, input });
    if (args[1] === "view") return JSON.stringify({ id: "PVT" });
    const after = JSON.parse(input).variables.after;
    const item = after
      ? {
          id: "I2",
          content: { __typename: "DraftIssue", title: "Second", body: "Draft" },
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
  assert.equal(calls.filter((call) => call.args[1] === "graphql").length, 2);
});

test("Project item inventory rejects a truncated nested field connection", () => {
  const runner = (args) => {
    if (args[1] === "view") return JSON.stringify({ id: "PVT" });
    return JSON.stringify({
      data: {
        node: {
          items: {
            totalCount: 1,
            nodes: [
              {
                id: "I1",
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

test("set-many validates transitions before one mutation and exact readback", () => {
  const calls = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  let status = "Ready";
  const fieldConnection = () => ({
    totalCount: 1,
    nodes: [{ name: status, field: { name: "Status" } }],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const runner = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "api" && args[2] === "users/boburning") return JSON.stringify({ type: "User" });
    if (args[0] === "project" && args[1] === "view")
      return JSON.stringify({ id: "PVT", number: 7 });
    if (args[0] === "project" && args[1] === "field-list")
      return JSON.stringify({
        fields: [
          {
            id: "F_status",
            name: "Status",
            options: [
              { id: "O_ready", name: "Ready" },
              { id: "O_done", name: "Done" },
            ],
          },
        ],
      });
    const request = JSON.parse(input);
    if (request.query.includes("projectV2(number:"))
      return JSON.stringify({
        data: {
          user: {
            projectV2: {
              id: "PVT",
              number: 7,
              title: "Portcove Roadmap",
              url: "https://github.test/project/7",
              public: true,
              closed: false,
              shortDescription: "Roadmap",
              readme: "Readme",
              fields: {
                totalCount: 1,
                nodes: [
                  {
                    __typename: "ProjectV2SingleSelectField",
                    id: "F_status",
                    name: "Status",
                    dataType: "SINGLE_SELECT",
                    options: [
                      { id: "O_ready", name: "Ready" },
                      { id: "O_done", name: "Done" },
                    ],
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      });
    if (request.query.includes("items(first: 50"))
      return JSON.stringify({
        data: {
          node: {
            items: {
              totalCount: 1,
              nodes: [
                {
                  id: "PVTI_838",
                  content: {
                    __typename: "Issue",
                    number: 838,
                    url: "https://github.com/boburning/portcove/issues/838",
                  },
                  fieldValues: fieldConnection(),
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    if (request.query.includes("updateProjectV2ItemFieldValue")) {
      status = "Done";
      return JSON.stringify({ data: { f0: { projectV2Item: { id: "PVTI_838" } } } });
    }
    if (request.query.includes("nodes(ids:"))
      return JSON.stringify({
        data: { nodes: [{ id: "PVTI_838", fieldValues: fieldConnection() }] },
      });
    throw new Error(`unexpected GraphQL request: ${request.query}`);
  };
  const client = new RoadmapClient(mockedConfig, runner);
  const spec = {
    schema_version: 1,
    updates: [{ target: "#838", fields: { Status: { from: "Ready", to: "Done" } } }],
  };
  const plan = client.planSetMany(spec);
  assert.equal(plan.pending.length, 1);
  client.applySetMany(plan);
  assert.ok(client.verifySetMany(plan).every((result) => result.verified));
  assert.equal(calls.filter((call) => call.input?.includes("items(first: 50")).length, 1);
  assert.equal(
    calls.filter((call) => call.input?.includes("updateProjectV2ItemFieldValue")).length,
    1,
  );
});

test("set-many specifications fail closed before GitHub access", () => {
  const invalid = [
    { schema_version: 2, updates: [] },
    { schema_version: 1, updates: [] },
    {
      schema_version: 1,
      updates: [{ target: "#1", fields: { Status: { from: "Ready", to: "Ready" } } }],
    },
    {
      schema_version: 1,
      updates: [
        { target: "#1", fields: { Status: { from: "Ready", to: "Done" } } },
        { target: "#1", fields: { Status: { from: "Ready", to: "Done" } } },
      ],
    },
  ];
  for (const spec of invalid) assert.throws(() => validateSetManySpec(config, spec));
  const tooLarge = {
    schema_version: 1,
    updates: Array.from({ length: 11 }, (_, index) => ({
      target: `#${index + 1}`,
      fields: Object.fromEntries(
        config.fields.map((field) => [
          field.name,
          { from: field.options[0], to: field.options[1] },
        ]),
      ),
    })),
  };
  assert.throws(() => validateSetManySpec(config, tooLarge), /at most 100/);
  assert.equal(setManyRequiredReserve(11, 1), 123);
  assert.equal(setManyRequiredReserve(11, 100), 147);
  for (const values of [
    [-1, 1],
    [1, -1],
    [1, 101],
  ])
    assert.throws(() => setManyRequiredReserve(...values), /quota inputs/);
});

function adaptiveSetManyFixture(count, { rates = null, mutationError = false } = {}) {
  const changes = Array.from({ length: count }, (_, index) => ({
    target: `#${index + 1}`,
    itemId: `ITEM_${index + 1}`,
    fieldName: "Status",
    from: "Ready",
    to: "Done",
  }));
  const values = new Map(changes.map((change) => [change.itemId, change.from]));
  const mutations = [];
  let rateIndex = 0;
  const client = {
    sampleGraphqlRate() {
      const rate = rates?.[rateIndex] ?? {
        used: rateIndex,
        remaining: 5000 - rateIndex,
        resetAt: "2026-09-16T12:00:00.000Z",
      };
      rateIndex += 1;
      return rate;
    },
    planSetMany() {
      return { context: {}, pending: changes, alreadyApplied: [], assignments: changes.length };
    },
    verifySetMany(plan) {
      return [...plan.pending, ...plan.alreadyApplied].map((change) => {
        const observed = values.get(change.itemId);
        return { ...change, observed, verified: observed === change.to };
      });
    },
    applySetMany(_plan, pending) {
      mutations.push(pending.map((change) => change.itemId));
      for (const change of pending) values.set(change.itemId, change.to);
      if (mutationError) throw new Error("connection closed after send");
    },
  };
  return { changes, client, mutations, values };
}

test("set-many applies at most 25 assignments per verified adaptive chunk", async () => {
  const fixture = adaptiveSetManyFixture(52);
  const result = await executeSetMany({
    client: fixture.client,
    config,
    spec: {},
    apply: true,
    doctor: async () => {},
  });
  assert.equal(maximumMutationChunkAssignments, 25);
  assert.deepEqual(
    fixture.mutations.map((chunk) => chunk.length),
    [25, 25, 2],
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence.verified, 52);
  assert.equal(result.evidence.remaining, 0);
  assert.equal(result.evidence.chunks.length, 3);
});

test("set-many reconciles an ambiguous mutation response without retrying", async () => {
  const fixture = adaptiveSetManyFixture(2, { mutationError: true });
  const result = await executeSetMany({
    client: fixture.client,
    config,
    spec: {},
    apply: true,
    doctor: async () => {},
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence.reconciled_after_error, 2);
  assert.equal(fixture.mutations.length, 1);
});

test("set-many resumes already-applied assignments with exact readback and no repeated writes", async () => {
  const fixture = adaptiveSetManyFixture(2);
  for (const change of fixture.changes) fixture.values.set(change.itemId, change.to);
  fixture.client.planSetMany = () => ({
    context: {},
    pending: [],
    alreadyApplied: fixture.changes,
    assignments: 2,
  });
  let readbacks = 0;
  const verify = fixture.client.verifySetMany;
  fixture.client.verifySetMany = (plan) => {
    readbacks += 1;
    return verify(plan);
  };
  let doctors = 0;
  const result = await executeSetMany({
    client: fixture.client,
    config,
    spec: {},
    apply: true,
    doctor: async () => {
      doctors += 1;
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence.already_applied_at_start, 2);
  assert.equal(result.evidence.verified, 2);
  assert.equal(result.evidence.remaining, 0);
  assert.equal(result.evidence.doctor, "passed");
  assert.equal(fixture.mutations.length, 0);
  assert.equal(readbacks, 1);
  assert.equal(doctors, 1);
});

test("the Project reader preserves full bodies and all pages above the ordinary transport limit", () => {
  const node = (number) => ({
    id: `PVTI_${number}`,
    content: { __typename: "Issue", number, body: "x".repeat(22000) },
    fieldValues: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  });
  const first = Array.from({ length: 50 }, (_, i) => node(i + 1));
  const last = [node(51)];
  for (const failedLastPage of [false, true]) {
    const cursors = [];
    const bytes = [];
    const run = createGitHubRunner({
      spawn: (_command, args, options) => {
        assert.equal(args[0], "api");
        const request = JSON.parse(options.input);
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
    assert.ok(bytes[0] > 1024 * 1024);
    assert.equal(first.length, 50);
    assert.equal(first[0].content.body.length, 22000);
  }
});

test("set-many stops before the next chunk when preserving quota requires a resume", async () => {
  const fixture = adaptiveSetManyFixture(30, {
    rates: [
      { used: 0, remaining: 500, resetAt: "later" },
      { used: 10, remaining: 490, resetAt: "later" },
      { used: 11, remaining: 489, resetAt: "later" },
      { used: 12, remaining: 0, resetAt: "later" },
    ],
  });
  await assert.rejects(
    () =>
      executeSetMany({
        client: fixture.client,
        config,
        spec: {},
        apply: true,
        doctor: async () => {},
      }),
    (error) =>
      error.operationStatus === "partial" &&
      error.operationEvidence.verified === 25 &&
      error.operationEvidence.remaining === 5,
  );
  assert.equal(fixture.mutations.length, 1);
});

test("set-many refuses unexpected pre-chunk state without mutation", async () => {
  const fixture = adaptiveSetManyFixture(2);
  fixture.values.set("ITEM_1", "In progress");
  await assert.rejects(
    () =>
      executeSetMany({
        client: fixture.client,
        config,
        spec: {},
        apply: true,
        doctor: async () => {},
      }),
    (error) => error.operationStatus === "partial" && /stopped before mutation/.test(error.message),
  );
  assert.equal(fixture.mutations.length, 0);
});

test("GraphQL failures retain provider quota and reset evidence", () => {
  const runner = () =>
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
  const node = (value) => ({
    id: `PVTI_${value}`,
    fieldValues: {
      totalCount: 0,
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  const page = (numbers, totalCount, cursor = null) => ({
    nodes: numbers.map(node),
    totalCount,
    pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
  });
  function readPages(pages) {
    let index = 0;
    const client = new RoadmapClient(config, (args, input) => {
      if (args[0] === "project") return JSON.stringify({ id: "PVT" });
      assert.match(JSON.parse(input).query, /totalCount/);
      const current = pages[index++];
      if (current instanceof Error) throw current;
      assert.ok(index <= pages.length, "reader must stop before exhausting the fixture");
      return JSON.stringify({ data: { node: { items: current } } });
    });
    return client.itemList(1);
  }

  test(`${kind} inventory accepts an empty connection`, () => {
    assert.deepEqual(readPages([page([], 0)]), []);
  });
  test(`${kind} inventory accepts an exact page boundary`, () => {
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
  const failures = [
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
    test(`${kind} inventory rejects ${reason}`, () => {
      assert.throws(() => readPages(pages), /inventory|API unavailable/);
    });
  }
}

test("Planned and historical non-gating work share execution without changing Required readiness", () => {
  const make = (n, commitment, status = "Ready", deps = []) => ({
    id: `i${n}`,
    title: `Work ${n}`,
    status,
    priority: "High",
    horizon: "Next",
    "work type": "Product feature",
    "target release": "Public beta",
    "release commitment": commitment,
    content: {
      number: n,
      state: status === "Done" ? "CLOSED" : "OPEN",
      url: `https://example.test/${n}`,
      blockedBy: { totalCount: deps.length, nodes: deps.map((number) => ({ number })) },
    },
  });
  const items = [
    make(1, "Required", "Done"),
    make(2, "Planned"),
    make(3, "Opportunistic"),
    make(4, "Planned", "Deferred"),
  ];
  assert.equal(analyzeReleaseReadiness(items, "Public beta").ready, true);
  assert.deepEqual(
    analyzeReleaseReadiness(items, "Public beta").planned.map((i) => i.content.number),
    [2, 3, 4],
  );
  assert.deepEqual(
    selectNextItems(items).map((i) => i.content.number),
    [2, 3],
  );
  const text = renderExecutionQueue(items);
  assert.match(text, /Planned/);
  assert.match(text, /after: https:\/\/example.test\/2/);
  assert.equal(analyzeReleaseReadiness(items, "Public beta").effectiveRequired.length, 1);
  items[0].content.blockedBy = { totalCount: 1, nodes: [{ number: 2 }] };
  const gates = analyzeReleaseReadiness(items, "Public beta");
  assert.equal(gates.ready, false);
  assert.equal(gates.dependencyConflicts.length, 1);
  assert.equal(gates.effectiveRequired.length, 2);
  items[0].content.blockedBy = { totalCount: 0, nodes: [] };
  items[0].content.parent = { number: 2 };
  assert.equal(analyzeReleaseReadiness(items, "Public beta").ready, true);
});

test("commitment rename preserves IDs, assignments and metadata and resumes without mutation", () => {
  const desired = { ...config, project: { ...config.project, number: 1 } };
  let fields = [
    {
      id: "field",
      name: "Release commitment",
      type: "SINGLE_SELECT",
      options: [
        { id: "required", name: "Required", color: "RED", description: "Gate" },
        { id: "planned", name: "Opportunistic", color: "BLUE", description: "Approved" },
      ],
    },
  ];
  let writes = 0;
  const client = {
    fieldList: () => structuredClone(fields),
    sampleGraphqlRate: () => ({ remaining: 2000 }),
    itemList: () => [
      {
        id: "a",
        fieldValues: [{ field: { name: "Release commitment" }, name: fields[0].options[1].name }],
      },
      { id: "b", fieldValues: [] },
    ],
    updateField: (id, options) => {
      assert.equal(id, "field");
      writes++;
      fields[0].options = options;
    },
  };
  assert.equal(executeCommitmentRename({ client, config: desired }).status, "planned");
  assert.equal(writes, 0);
  const result = executeCommitmentRename({ client, config: desired, apply: true });
  assert.equal(result.assignmentsVerified, 2);
  assert.equal(result.option, "planned");
  assert.equal(writes, 1);
  assert.equal(fields[0].options[1].color, "BLUE");
  assert.equal(fields[0].options[1].description, "Approved");
  assert.equal(
    executeCommitmentRename({ client, config: desired, apply: true }).alreadyApplied,
    true,
  );
  assert.equal(writes, 1);
  fields[0].options.push({ id: "duplicate", name: "Opportunistic" });
  assert.throws(
    () => executeCommitmentRename({ client, config: desired, apply: true }),
    /both historical and active/,
  );
  assert.equal(writes, 1);
});

test("commitment rename refuses divergent assignment readback and reconciles ambiguous transport", () => {
  const fields = [
    {
      id: "f",
      name: "Release commitment",
      type: "SINGLE_SELECT",
      options: [
        { id: "r", name: "Required" },
        { id: "p", name: "Opportunistic" },
      ],
    },
  ];
  let reads = 0;
  const client = {
    fieldList: () => structuredClone(fields),
    sampleGraphqlRate: () => ({ remaining: 1000 }),
    itemList: () => [
      {
        id: "a",
        fieldValues: [
          { field: { name: "Release commitment" }, name: reads++ ? "Required" : "Opportunistic" },
        ],
      },
    ],
    updateField: (_id, opts) => {
      fields[0].options = opts;
    },
  };
  assert.throws(
    () => executeCommitmentRename({ client, config, apply: true }),
    /assignment changed/,
  );
  fields[0].options[1].name = "Opportunistic";
  client.itemList = () => [
    {
      id: "a",
      fieldValues: [{ field: { name: "Release commitment" }, name: fields[0].options[1].name }],
    },
  ];
  client.updateField = (_id, opts) => {
    fields[0].options = opts;
    throw Error("lost response");
  };
  assert.equal(executeCommitmentRename({ client, config, apply: true }).reconciledAfterError, true);
});

test("queue displays incomplete dependency coverage instead of an empty prerequisite claim", () => {
  const record = {
    title: "Partial",
    status: "Ready",
    priority: "High",
    horizon: "Next",
    "work type": "Bug",
    "release commitment": "Planned",
    content: { number: 1, state: "OPEN", blockedBy: { totalCount: 11, nodes: [] } },
  };
  assert.match(renderExecutionQueue([record]), /prerequisite coverage incomplete/);
});
