import type { GitHubRunner } from "./github-api.mts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  RoadmapClient,
  materializeViews,
  manualUiChecklist,
  planFieldReconciliation,
  planViewReconciliation,
  projectMachineDrift,
  selectNextItems,
  viewMachineDrift,
} from "./roadmap.mts";

import {
  fixtureValue,
  fixtureFind,
  fixtureElement,
  fixtureObject,
  fixtureGraphql,
  config,
} from "./fixtures/roadmap-fixtures.mts";
import type { RunnerCall } from "./fixtures/roadmap-fixtures.mts";

function completeView(id: string, name: string) {
  type Field = { id: string; name: string };
  const empty = <T,>() => {
    const nodes: T[] = [];
    return { totalCount: 0, nodes, pageInfo: { hasNextPage: false, endCursor: null } };
  };
  return {
    id,
    name,
    fields: empty<Field>(),
    groupByFields: empty<Field>(),
    verticalGroupByFields: empty<Field>(),
    sortByFields: empty<{ direction: string; field: Field }>(),
  };
}

type ViewInventoryFixture = {
  id: string;
  views: {
    totalCount: number;
    nodes: ReturnType<typeof completeView>[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

void test("field reconciliation preserves existing option identities and user data", () => {
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
  const existingStep = fixtureElement(existingPlan, 0);
  assert.ok(existingStep.action === "update");
  assert.deepEqual(
    existingStep.options.map((option) => option.name),
    ["Custom", "Inbox", "Done"],
  );
  assert.equal(fixtureElement(existingStep.options, 0).id, "existing");

  const freshPlan = planFieldReconciliation(desired, mockedGhFields, {
    freshProject: true,
  });
  const freshStep = fixtureElement(freshPlan, 0);
  assert.ok(freshStep.action === "update");
  assert.deepEqual(
    freshStep.options.map((option) => option.name),
    ["Inbox", "Done"],
  );
});

void test("view reconciliation reuses matching GraphQL views and creates only missing views", () => {
  const desired = [
    {
      name: "Now Board",
      layout: "BOARD_LAYOUT",
      filter: "horizon:Now",
      fields: ["Title"],
      manual_group_by: null,
      manual_sort_by: "manual",
    },
    {
      name: "Port Pipeline",
      layout: "BOARD_LAYOUT",
      filter: "work-type:Port",
      fields: ["Title"],
      manual_group_by: null,
      manual_sort_by: "manual",
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

void test("active port work is additive and preserves the complete inventory view", () => {
  const inventory = config.views.find((view) => view.name === "Port Pipeline");
  assert.ok(inventory);
  assert.equal(inventory.filter, "work-type:Port");
  const active = config.views.find((view) => view.name === "Active Port Work");
  assert.ok(active);
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
    .map((view, index) => ({
      ...view,
      id: `V${index}`,
      fields: { nodes: view.fields.map((name) => ({ name })) },
    }));
  const plan = planViewReconciliation(config.views, existing);
  assert.deepEqual(
    plan.filter((step) => step.action === "create").map((step) => step.desired.name),
    ["Active Port Work"],
  );
  const inventoryStep = plan.find((step) => step.desired.name === inventory.name);
  assert.ok(inventoryStep && inventoryStep.actual);
  assert.equal(inventoryStep.actual.id, "V2");
});

void test("next work excludes workstreams, completed items, and Later horizon", () => {
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

void test("active release materialization and manual checklist are explicit", () => {
  const current = fixtureFind(
    materializeViews(config),
    (view) => view.name === "Required for Beta",
  );
  assert.equal(
    current.filter,
    `-status:Done target-release:"${config.active_release}" release-commitment:Required`,
  );
  const alpha1 = materializeViews({
    ...config,
    active_release: "Alpha 1",
  }).find((view) => view.name === "Required for Beta");
  assert.ok(alpha1);
  assert.equal(alpha1.filter, '-status:Done target-release:"Alpha 1" release-commitment:Required');
  assert.equal(
    manualUiChecklist(config).filter((line) => /^\d+\. .*: group by/.test(line)).length,
    config.views.length,
  );
  assert.match(fixtureValue(manualUiChecklist(config).at(-1)), /completion workflows/);
});

void test("doctor drift covers identity linkage field options and view properties", () => {
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
  fixtureElement(views, 0).filter = "wrong";
  fixtureElement(fields, 0).options = fixtureElement(fields, 0).options.filter(
    (option) => option.name !== "Done",
  );
  fixtureElement(fields, 1).options.push({ id: "unexpected", name: "Unexpected" });
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
  assert.ok(
    viewMachineDrift(fixtureElement(desiredViews, 0), fixtureElement(views, 0)).some((value) =>
      value.includes("filter"),
    ),
  );
});

void test("GraphQL view pagination reads every page", () => {
  const calls: RunnerCall[] = [];
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    const after = fixtureGraphql(input).variables.after;
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

void test("view renames retain identity and repeated reconciliation creates no duplicate", () => {
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
  assert.equal(fixtureElement(plan, 0).action, "update");
  assert.equal(fixtureValue(fixtureElement(plan, 0).actual).id, "V_original");
  const saved = { ...original, name: desired.name };
  assert.equal(fixtureElement(planViewReconciliation([desired], [saved]), 0).action, "keep");
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

void test("view inventory refuses incomplete records rather than claiming a complete UI", () => {
  for (const alter of [
    (node: ViewInventoryFixture) => {
      node.id = "wrong";
    },
    (node: ViewInventoryFixture) => {
      // @ts-expect-error Missing total intentionally exercises incomplete provider data.
      delete node.views.totalCount;
    },
    (node: ViewInventoryFixture) => {
      node.views.totalCount = 2;
    },
    (node: ViewInventoryFixture) => {
      node.views.nodes.push(fixtureElement(node.views.nodes, 0));
      node.views.totalCount = 2;
    },
    (node: ViewInventoryFixture) => {
      fixtureElement(node.views.nodes, 0).fields.pageInfo.hasNextPage = true;
    },
    (node: ViewInventoryFixture) => {
      // @ts-expect-error Missing sort inventory intentionally exercises unavailable provider data.
      delete fixtureElement(node.views.nodes, 0).sortByFields;
    },
    (node: ViewInventoryFixture) => {
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

void test("Project provider observations reject malformed option scalars before planning", () => {
  const client = new RoadmapClient(config, () =>
    JSON.stringify({
      fields: [{ id: "F_status", name: "Status", options: [{ id: "O_bad", name: 7 }] }],
    }),
  );
  assert.throws(() => client.fieldList(config.project.number), /malformed Project option/);
});

void test("readable grouping and sorting distinguish empty settings from unavailable evidence", () => {
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
  fixtureElement(actual.sortByFields.nodes, 0).direction = "DESC";
  assert.match(viewMachineDrift(desired, actual).join("\n"), /Priority:DESC/);
  fixtureElement(actual.sortByFields.nodes, 0).direction = "ASC";
  actual.verticalGroupByFields.nodes = [{ id: "F_hidden", name: "Platform" }];
  assert.match(viewMachineDrift(desired, actual).join("\n"), /secondary grouping Platform/);
});

void test("view reconciliation preflights every view and verifies saved identities", () => {
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
  client.graphql = (_query, variables) => {
    const input = fixtureObject(fixtureValue(variables).input);
    assert.ok(typeof input.viewId === "string" && typeof input.filter === "string");
    writes.push(input);
    const target = fixtureValue(saved.find((view) => view.id === input.viewId));
    Object.assign(target, { filter: input.filter });
  };
  fixtureElement(saved, 1).groupByFields.nodes = [{ id: "Fstatus", name: "Status" }];
  assert.throws(() => client.reconcileViews("P", [{ id: "Ftitle", name: "Title" }]), /owner UI/);
  assert.equal(writes.length, 0);
  fixtureElement(saved, 1).groupByFields.nodes = [];
  client.reconcileViews("P", [{ id: "Ftitle", name: "Title" }]);
  assert.equal(writes.length, 2);
  assert.equal(
    client
      .reconcileViews("P", [{ id: "Ftitle", name: "Title" }])
      .every((step) => step.action === "keep"),
    true,
  );
  fixtureElement(saved, 0).filter = "old";
  client.graphql = () => {};
  assert.throws(
    () => client.reconcileViews("P", [{ id: "Ftitle", name: "Title" }]),
    /readback did not match/,
  );
});
