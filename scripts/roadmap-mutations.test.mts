import type { GitHubRunner } from "./github-api.mts";
import type { SetManyClient, SetManyAssignment } from "./roadmap.mts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  RoadmapClient,
  executeSetMany,
  executeCommitmentRename,
  maximumMutationChunkAssignments,
  planFieldReconciliation,
  setManyRequiredReserve,
  validateSetManySpec,
} from "./roadmap.mts";

import {
  fixtureFind,
  fixtureElement,
  fixtureObject,
  fixtureGraphql,
  config,
  fixtureProjectDetails,
} from "./fixtures/roadmap-fixtures.mts";
import type { RunnerCall } from "./fixtures/roadmap-fixtures.mts";

function adaptiveSetManyFixture(
  count: number,
  {
    rates = null,
    mutationError = false,
  }: {
    rates?: readonly ReturnType<SetManyClient["sampleGraphqlRate"]>[] | null;
    mutationError?: boolean;
  } = {},
) {
  const changes: SetManyAssignment[] = Array.from({ length: count }, (_, index) => ({
    target: `#${index + 1}`,
    itemId: `ITEM_${index + 1}`,
    fieldName: "Status",
    from: "Ready",
    to: "Done",
    observed: "Ready",
  }));
  const values = new Map(changes.map((change) => [change.itemId, change.from]));
  const mutations: string[][] = [];
  let rateIndex = 0;
  const client: SetManyClient = {
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

void test("Release commitment field migration is idempotent", () => {
  const desired = [fixtureFind(config.fields, (field) => field.name === "Release commitment")];
  assert.equal(
    fixtureElement(planFieldReconciliation(desired, { fields: [] }), 0).action,
    "create",
  );
  const actual = {
    fields: [
      {
        id: "commitment",
        name: "Release commitment",
        type: "ProjectV2SingleSelectField",
        options: fixtureElement(desired, 0).options.map((name, index) => ({
          id: `option-${index}`,
          name,
        })),
      },
    ],
  };
  assert.equal(fixtureElement(planFieldReconciliation(desired, actual), 0).action, "keep");
});

void test("promotion validation happens before any GitHub mutation", () => {
  let calls = 0;
  const client = new RoadmapClient(config, () => {
    calls += 1;
    return "";
  });
  assert.throws(() => client.promote("PVTI_draft", "lightweight note"), /incomplete/);
  assert.equal(calls, 0);
});

void test("move refuses ambiguous item references", () => {
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner: GitHubRunner = (args, input) => {
    const project = fixtureProjectDetails(args, input, "PVT_project", 7);
    if (project !== undefined) return project;
    if (args[1] === "graphql")
      return JSON.stringify({
        data: {
          node: {
            items: {
              totalCount: 3,
              nodes: [
                {
                  id: "A",
                  content: {
                    __typename: "DraftIssue",
                    id: "DI_same",
                    updatedAt: "2026-10-17T00:00:00Z",
                    body: "Draft",
                    title: "Same",
                  },
                  fieldValues: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
                {
                  id: "B",
                  content: {
                    __typename: "DraftIssue",
                    id: "DI_same",
                    updatedAt: "2026-10-17T00:00:00Z",
                    body: "Draft",
                    title: "Same",
                  },
                  fieldValues: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
                {
                  id: "C",
                  content: {
                    __typename: "DraftIssue",
                    id: "DI_before",
                    updatedAt: "2026-10-17T00:00:00Z",
                    body: "Draft",
                    title: "Before",
                  },
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

void test("set-many validates transitions before one mutation and exact readback", () => {
  const calls: RunnerCall[] = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  let status = "Ready";
  const fieldConnection = () => ({
    totalCount: 1,
    nodes: [{ name: status, field: { name: "Status" } }],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    const project = fixtureProjectDetails(args, input, "PVT", 7);
    if (project !== undefined) return project;
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
    const request = fixtureGraphql(input);
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
                    id: "I_838",
                    title: "Fixture",
                    body: "",
                    state: "OPEN",
                    updatedAt: "2026-10-17T00:00:00Z",
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
  client.executionIssue = () => ({
    item: {
      id: "PVTI_838",
      content: {
        id: "I_838",
        number: 838,
        url: "https://github.com/boburning/portcove/issues/838",
        state: "OPEN",
      },
    },
    relationships: { blockedBy: [], blocking: [], parent: null, subIssues: [] },
  });
  client.directProjectItem = () => ({
    id: "PVTI_838",
    content: { number: 838 },
    fieldValues: [{ name: status, field: { name: "Status" } }],
  });
  const spec = {
    schema_version: 1,
    updates: [{ target: "#838", fields: { Status: { from: "Ready", to: "Done" } } }],
  };
  const plan = client.planSetMany(spec);
  assert.equal(plan.pending.length, 1);
  client.applySetMany(plan);
  assert.ok(client.verifySetMany(plan).every((result) => result.verified));
  assert.equal(calls.filter((call) => call.input?.includes("items(first: 50")).length, 0);
  assert.equal(
    calls.filter((call) => call.input?.includes("updateProjectV2ItemFieldValue")).length,
    1,
  );
});

void test("set-many specifications fail closed before GitHub access", () => {
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
  ] as const)
    assert.throws(() => setManyRequiredReserve(values[0], values[1]), /quota inputs/);
});

void test("set-many applies at most 25 assignments per verified adaptive chunk", async () => {
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

void test("set-many reconciles an ambiguous mutation response without retrying", async () => {
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

void test("set-many resumes already-applied assignments with exact readback and no repeated writes", async () => {
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

void test("set-many stops before the next chunk when preserving quota requires a resume", async () => {
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
      fixtureObject(error).operationStatus === "partial" &&
      fixtureObject(fixtureObject(error).operationEvidence).verified === 25 &&
      fixtureObject(fixtureObject(error).operationEvidence).remaining === 5,
  );
  assert.equal(fixture.mutations.length, 1);
});

void test("set-many refuses unexpected pre-chunk state without mutation", async () => {
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
    (error) =>
      error instanceof Error &&
      fixtureObject(error).operationStatus === "partial" &&
      /stopped before mutation/.test(error.message),
  );
  assert.equal(fixture.mutations.length, 0);
});

void test("commitment rename preserves IDs, assignments and metadata and resumes without mutation", () => {
  const desired = { ...config, project: { ...config.project, number: 1 } };
  let fields: [
    {
      id: string;
      name: string;
      type: string;
      options: Parameters<
        Parameters<typeof executeCommitmentRename>[0]["client"]["updateField"]
      >[1];
    },
  ] = [
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
  const client: Parameters<typeof executeCommitmentRename>[0]["client"] = {
    fieldList: () => structuredClone(fields),
    sampleGraphqlRate: () => ({ remaining: 2000 }),
    itemList: () => [
      {
        id: "a",
        fieldValues: [
          {
            field: { name: "Release commitment" },
            name: fixtureElement(fixtureElement(fields, 0).options, 1).name,
          },
        ],
      },
      { id: "b", fieldValues: [] },
    ],
    updateField: (id, options) => {
      assert.equal(id, "field");
      writes++;
      fixtureElement(fields, 0).options = options;
    },
  };
  assert.equal(executeCommitmentRename({ client, config: desired }).status, "planned");
  assert.equal(writes, 0);
  const result = executeCommitmentRename({ client, config: desired, apply: true });
  assert.equal(result.assignmentsVerified, 2);
  assert.equal(result.option, "planned");
  assert.equal(writes, 1);
  assert.equal(fixtureElement(fixtureElement(fields, 0).options, 1).color, "BLUE");
  assert.equal(fixtureElement(fixtureElement(fields, 0).options, 1).description, "Approved");
  assert.equal(
    executeCommitmentRename({ client, config: desired, apply: true }).alreadyApplied,
    true,
  );
  assert.equal(writes, 1);
  fixtureElement(fields, 0).options.push({ id: "duplicate", name: "Opportunistic" });
  assert.throws(
    () => executeCommitmentRename({ client, config: desired, apply: true }),
    /both historical and active/,
  );
  assert.equal(writes, 1);
});

void test("commitment rename refuses divergent assignment readback and reconciles ambiguous transport", () => {
  const fields: [
    {
      id: string;
      name: string;
      type: string;
      options: Parameters<
        Parameters<typeof executeCommitmentRename>[0]["client"]["updateField"]
      >[1];
    },
  ] = [
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
  const client: Parameters<typeof executeCommitmentRename>[0]["client"] = {
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
      fixtureElement(fields, 0).options = opts;
    },
  };
  assert.throws(
    () => executeCommitmentRename({ client, config, apply: true }),
    /assignment changed/,
  );
  fixtureElement(fixtureElement(fields, 0).options, 1).name = "Opportunistic";
  client.itemList = () => [
    {
      id: "a",
      fieldValues: [
        {
          field: { name: "Release commitment" },
          name: fixtureElement(fixtureElement(fields, 0).options, 1).name,
        },
      ],
    },
  ];
  client.updateField = (_id, opts) => {
    fixtureElement(fields, 0).options = opts;
    throw Error("lost response");
  };
  assert.equal(executeCommitmentRename({ client, config, apply: true }).reconciledAfterError, true);
});
