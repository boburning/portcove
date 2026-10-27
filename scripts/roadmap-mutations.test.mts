import { createHash } from "node:crypto";
import type { GitHubRunner } from "./github-api.mts";
import type { SetManyClient, SetManyAssignment } from "./roadmap.mts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SetManyJournal,
  readSetManyInput,
  maximumSetManyInputBytes,
} from "./roadmap-batch-progress.mts";
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
      const live = changes.map((change) => ({ ...change, observed: values.get(change.itemId) }));
      return {
        context: {},
        pending: live.filter((change) => change.observed !== change.to),
        alreadyApplied: live.filter((change) => change.observed === change.to),
        assignments: changes.length,
      };
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
  assert.ok(validateSetManySpec(config, tooLarge).assignments > 100);
  assert.equal(setManyRequiredReserve(11, 1), 123);
  assert.equal(setManyRequiredReserve(11, 100), 147);
  for (const values of [
    [-1, 1],
    [1, -1],
    [1, Number.MAX_SAFE_INTEGER + 1],
  ] as const)
    assert.throws(() => setManyRequiredReserve(values[0], values[1]), /quota inputs/);
});

void test("set-many applies at most 25 assignments per verified adaptive chunk", async () => {
  const fixture = adaptiveSetManyFixture(127);
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
    [25, 25, 25, 25, 25, 2],
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence.verified, 127);
  assert.equal(result.evidence.remaining, 0);
  assert.equal(result.evidence.chunks.length, 6);
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

void test("127 assignments resume from durable verified chunks without specification splitting", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-bulk-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputFile = path.join(root, "spec.json");
  const input = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      updates: Array.from({ length: 127 }, (_, i) => ({
        target: `#${i + 1}`,
        fields: { Status: { from: "Ready", to: "Done" } },
      })),
    }),
  );
  writeFileSync(inputFile, input);
  const file = path.join(root, "progress.json");
  const first = new SetManyJournal(file, inputFile, input, config);
  const fixture = adaptiveSetManyFixture(127);
  await assert.rejects(
    executeSetMany({
      client: fixture.client,
      config,
      spec: JSON.parse(input.toString()),
      apply: true,
      doctor: async () => {},
      onCheckpoint: (progress) => {
        first.observe(progress);
        if (progress.phase === "readback")
          throw new Error("fixture cancellation after verified chunk");
      },
    }),
    /fixture cancellation/,
  );
  assert.equal(fixture.mutations.length, 1);
  assert.equal(first.journal?.verified.length, 25);
  const resumed = new SetManyJournal(file, inputFile, readSetManyInput(inputFile), config);
  const result = await executeSetMany({
    client: fixture.client,
    config,
    spec: JSON.parse(input.toString()),
    apply: true,
    doctor: async () => {},
    onCheckpoint: (progress) => resumed.observe(progress),
  });
  assert.equal(result.evidence.verified, 127);
  assert.equal(new Set(fixture.mutations.flat()).size, 127);
  assert.equal(fixture.mutations.flat().length, 127);
  assert.equal(resumed.journal?.verified.length, 127);
  assert.equal(resumed.journal?.phase, "completed");
  assert.deepEqual(resumed.journal?.uncertain, []);
  fixture.values.set("ITEM_1", "Ready");
  await assert.rejects(
    executeSetMany({
      client: fixture.client,
      config,
      spec: {},
      apply: true,
      doctor: async () => {},
      onCheckpoint: (progress) => resumed.observe(progress),
    }),
    /verified state changed concurrently/,
  );
  assert.equal(fixture.mutations.flat().length, 127);
  writeFileSync(inputFile, Buffer.concat([input, Buffer.from("\n")]));
  assert.throws(
    () => new SetManyJournal(file, inputFile, readSetManyInput(inputFile), config),
    /journal identity/,
  );
});

void test("ambiguous partial bulk writes stay held until their exact targets are observed", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-ambiguous-progress-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputFile = path.join(root, "spec.json");
  writeFileSync(inputFile, "{}");
  const file = path.join(root, "progress.json");
  const journal = new SetManyJournal(file, inputFile, readSetManyInput(inputFile), config);
  const fixture = adaptiveSetManyFixture(2);
  let mutations = 0;
  fixture.client.applySetMany = () => {
    mutations++;
    fixture.values.set("ITEM_1", "Done");
    throw new Error("ambiguous connection loss");
  };
  const run = (progress: SetManyJournal) =>
    executeSetMany({
      client: fixture.client,
      config,
      spec: {},
      apply: true,
      doctor: async () => {},
      onCheckpoint: (event) => progress.observe(event),
    });
  await assert.rejects(run(journal), /readback mismatches/);
  assert.equal(journal.journal?.verified.length, 1);
  assert.equal(journal.journal?.uncertain.length, 1);
  const resumed = new SetManyJournal(file, inputFile, readSetManyInput(inputFile), config);
  await assert.rejects(run(resumed), /no automatic retry/);
  assert.equal(mutations, 1);
  fixture.values.set("ITEM_2", "Done");
  assert.equal((await run(resumed)).status, "succeeded");
  assert.equal(mutations, 1);
});

void test("bulk progress refuses changed resolved identities, malformed journals and oversized inputs", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-bulk-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputFile = path.join(root, "spec.json");
  writeFileSync(inputFile, "{}");
  const file = path.join(root, "progress.json");
  const journal = new SetManyJournal(file, inputFile, readSetManyInput(inputFile), config);
  const changes = adaptiveSetManyFixture(1).changes;
  journal.observe({ phase: "plan", assignments: changes, changes: [] });
  assert.throws(
    () =>
      journal.observe({
        phase: "plan",
        assignments: changes.map((change) => ({ ...change, itemId: "OTHER" })),
        changes: [],
      }),
    /identities changed/,
  );
  writeFileSync(inputFile, Buffer.alloc(maximumSetManyInputBytes + 1));
  assert.throws(() => readSetManyInput(inputFile), /bounded regular file/);
  writeFileSync(file, "{}");
  writeFileSync(inputFile, "{}");
  assert.throws(
    () => new SetManyJournal(file, inputFile, readSetManyInput(inputFile), config),
    /journal identity/,
  );
  if (process.platform !== "win32") {
    const alias = path.join(root, "alias.json");
    symlinkSync(inputFile, alias);
    assert.throws(() => readSetManyInput(alias), /bounded regular file/);
  }
});

void test("final bulk readback requests at most25 distinct item identities per query", () => {
  const client = new RoadmapClient(config, () => {
    throw new Error("Unexpected transport");
  });
  const calls: number[] = [];
  client.graphql = (_query, variables) => {
    const ids = variables?.ids;
    assert.ok(Array.isArray(ids));
    calls.push(ids.length);
    return {
      nodes: ids.map((id: unknown) => ({
        id,
        fieldValues: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
      })),
    };
  };
  const assignments = adaptiveSetManyFixture(127).changes;
  assert.equal(client.readSetManyItems({ pending: assignments, alreadyApplied: [] }).size, 127);
  assert.deepEqual(calls, [25, 25, 25, 25, 25, 2]);
  client.graphql = () => ({ nodes: [] });
  assert.throws(
    () => client.readSetManyItems({ pending: assignments, alreadyApplied: [] }),
    /item count differs/,
  );
});

void test("a large logical preflight cost does not become an impossible per-chunk quota reserve", async () => {
  const used = [0, 3000, 3002, 3030, 3058, 3086, 3114, 3142];
  const fixture = adaptiveSetManyFixture(127, {
    rates: used.map((value) => ({
      used: value,
      remaining: 5000 - value,
      resetAt: "2026-09-16T12:00:00.000Z",
    })),
  });
  const result = await executeSetMany({
    client: fixture.client,
    config,
    spec: {},
    apply: true,
    doctor: async () => {},
  });
  assert.equal(result.evidence.verified, 127);
  assert.deepEqual(
    fixture.mutations.map((chunk) => chunk.length),
    [25, 25, 25, 25, 25, 2],
  );
});

function phasedFixture(count = 127, limit = 300) {
  let clock = Date.parse("2026-10-27T00:00:00Z");
  let remaining = limit;
  let windows = 0;
  let metadata = 0;
  let changedBinding = false;
  let alias = false;
  let ambiguous = false;
  const values = new Map(Array.from({ length: count }, (_, i) => [`ITEM_${i + 1}`, "Ready"]));
  const versions = new Map([...values.keys()].map((id) => [id, 0]));
  const mutations: string[][] = [];
  const binding = () => ({
    project_id: "PROJECT",
    field_id: "STATUS",
    option_id: changedBinding ? "OTHER" : "DONE",
  });
  const revision = (id: string) => {
    const text = JSON.stringify({ id, value: values.get(id), version: versions.get(id) });
    // Exact stable revision fixtures model the provider's item updatedAt/content binding.
    return createHash("sha256").update(text).digest("hex");
  };
  const charge = (amount: number) => {
    if (amount > remaining) throw new Error("fixture quota exhausted unexpectedly");
    remaining -= amount;
  };
  const spec = {
    schema_version: 1,
    updates: Array.from({ length: count }, (_, i) => ({
      target: `#${i + 1}`,
      fields: { Status: { from: "Ready", to: "Done" } },
    })),
  };
  const client: SetManyClient = {
    sampleGraphqlRate: () => ({
      used: limit - remaining,
      remaining,
      resetAt: new Date(clock + 3600000).toISOString(),
    }),
    planSetMany(input) {
      const selected = validateSetManySpec(config, input);
      const rows = selected.updates.flatMap((update) =>
        Object.entries(update.fields).map(([fieldName, transition]) => {
          const id =
            alias && update.target === `#${count}` ? "ITEM_1" : `ITEM_${update.target.slice(1)}`;
          metadata += 1;
          charge(7);
          return {
            target: update.target,
            itemId: id,
            fieldName,
            ...transition,
            observed: values.get(id),
            mutation_identity: binding(),
          };
        }),
      );
      return {
        context: {},
        assignments: rows.length,
        pending: rows.filter((row) => row.observed !== row.to),
        alreadyApplied: rows.filter((row) => row.observed === row.to),
      };
    },
    refreshSetManyPlan(input) {
      return this.planSetMany(input);
    },
    validateSetManyBindings(rows) {
      if (rows.some((row) => JSON.stringify(row.mutation_identity) !== JSON.stringify(binding())))
        throw new Error("fixture binding changed");
    },
    verifySetMany(plan) {
      const rows = [...plan.pending, ...plan.alreadyApplied];
      charge(rows.length);
      return rows.map((row) => ({
        ...row,
        observed: values.get(row.itemId),
        verified: values.get(row.itemId) === row.to,
        item_revision: revision(row.itemId),
      }));
    },
    applySetMany(_plan, rows) {
      charge(rows.length);
      mutations.push(rows.map((row) => row.itemId));
      for (const row of ambiguous ? rows.slice(0, 1) : rows) {
        values.set(row.itemId, row.to);
        versions.set(row.itemId, (versions.get(row.itemId) ?? 0) + 1);
      }
      if (ambiguous) throw new Error("fixture ambiguous mutation");
    },
  };
  return {
    client,
    spec,
    values,
    versions,
    mutations,
    metadata: () => metadata,
    clock: () => clock,
    windows: () => windows,
    reset: async (until: number) => {
      assert.ok(windows < 1000, "fixture continuation must make progress");
      windows += 1;
      clock = until + 1;
      remaining = limit;
    },
    changeBinding: () => {
      changedBinding = true;
    },
    alias: () => {
      alias = true;
    },
    ambiguous: () => {
      ambiguous = true;
    },
  };
}

void test("durable preflight and independently verified writes complete through automatic quota windows", async (t) => {
  const { continueRoadmapCapacity } = await import("./roadmap-capacity-continuation.mts");
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-phased-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = phasedFixture();
  const file = path.join(root, "spec.json");
  const bytes = Buffer.from(JSON.stringify(h.spec));
  writeFileSync(file, bytes);
  const journalPath = path.join(root, "journal.json");
  let lock = false;
  let deferrals = 0;
  const result = await continueRoadmapCapacity(
    async () => {
      lock = true;
      try {
        return await executeSetMany({
          client: h.client,
          config,
          spec: h.spec,
          apply: true,
          progress: new SetManyJournal(journalPath, file, readSetManyInput(file), config),
          doctor: async () => {},
        });
      } finally {
        lock = false;
      }
    },
    {
      now: h.clock,
      wait: async (until) => {
        assert.equal(lock, false);
        await h.reset(until);
      },
      observe: (error) => {
        deferrals += 1;
        assert.ok(error);
      },
    },
  );
  assert.equal(result.status, "succeeded");
  assert.ok(deferrals > 2);
  assert.equal(h.windows(), deferrals);
  assert.ok(h.mutations.every((chunk) => chunk.length <= 25));
  assert.equal(h.mutations.flat().length, 127);
  assert.equal(new Set(h.mutations.flat()).size, 127);
  assert.ok(
    h.metadata() < 127 * 4,
    "accepted preflight and verified prefixes must not be repeatedly rehydrated",
  );
});

void test("late preflight aliases and changed schema bindings refuse before new mutation", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-phased-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const mode of ["alias", "binding"]) {
    const h = phasedFixture(127, 10000);
    if (mode === "alias") h.alias();
    const file = path.join(root, `${mode}.json`);
    writeFileSync(file, JSON.stringify(h.spec));
    const progress = new SetManyJournal(
      path.join(root, `${mode}-journal.json`),
      file,
      readSetManyInput(file),
      config,
    );
    await assert.rejects(
      executeSetMany({
        client: h.client,
        config,
        spec: h.spec,
        apply: true,
        progress,
        doctor: async () => {},
        onCheckpoint: (phase) => {
          if (phase.phase === "plan" && mode === "binding") h.changeBinding();
        },
      }),
      mode === "alias" ? /duplicate set-many resolved/ : /binding changed/,
    );
    assert.equal(h.mutations.length, 0);
  }
});

void test("final read epochs retain completed chunks and a new invocation holds a concurrent reversal without rewriting", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-phased-final-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = phasedFixture(127, 10000);
  const file = path.join(root, "spec.json");
  writeFileSync(file, JSON.stringify(h.spec));
  const journal = path.join(root, "journal.json");
  const fresh = () => new SetManyJournal(journal, file, readSetManyInput(file), config);
  await assert.rejects(
    executeSetMany({
      client: h.client,
      config,
      spec: h.spec,
      apply: true,
      progress: fresh(),
      doctor: async () => {
        throw new Error("fixture original doctor failure");
      },
    }),
    /original doctor failure/,
  );
  assert.equal(h.mutations.flat().length, 127);
  const metadata = h.metadata();
  const resumed = await executeSetMany({
    client: h.client,
    config,
    spec: h.spec,
    apply: true,
    progress: fresh(),
    doctor: async () => {},
  });
  assert.equal(resumed.status, "succeeded");
  assert.equal(h.metadata(), metadata);
  assert.equal(h.mutations.flat().length, 127);
  h.values.set("ITEM_1", "Ready");
  h.versions.set("ITEM_1", (h.versions.get("ITEM_1") ?? 0) + 1);
  await assert.rejects(
    executeSetMany({
      client: h.client,
      config,
      spec: h.spec,
      apply: true,
      progress: fresh(),
      doctor: async () => {},
    }),
    /conflicting or incomplete field/,
  );
  assert.equal(h.mutations.flat().length, 127);
});

void test("ambiguous mutations and unknown reset capacity never enter automatic quota retry", async (t) => {
  const { continueRoadmapCapacity, roadmapQuotaDeferred } =
    await import("./roadmap-capacity-continuation.mts");
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-phased-uncertain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = phasedFixture(30, 10000);
  h.ambiguous();
  const file = path.join(root, "spec.json");
  writeFileSync(file, JSON.stringify(h.spec));
  const journal = path.join(root, "journal.json");
  const execute = () =>
    executeSetMany({
      client: h.client,
      config,
      spec: h.spec,
      apply: true,
      progress: new SetManyJournal(journal, file, readSetManyInput(file), config),
      doctor: async () => {},
    });
  let waits = 0;
  await assert.rejects(
    continueRoadmapCapacity(execute, {
      now: h.clock,
      wait: async () => {
        waits += 1;
      },
    }),
    /readback mismatches/,
  );
  assert.equal(waits, 0);
  assert.equal(h.mutations.length, 1);
  await assert.rejects(execute(), /ambiguous write remains unresolved/);
  assert.equal(h.mutations.length, 1);
  for (const resetAt of ["Unknown", new Date(h.clock() - 1).toISOString()]) {
    await assert.rejects(
      continueRoadmapCapacity(
        async () => {
          throw roadmapQuotaDeferred("fixture", {}, { remaining: 0, resetAt });
        },
        {
          now: h.clock,
          wait: async () => {
            waits += 1;
          },
        },
      ),
      /provider reset/,
    );
  }
  assert.equal(waits, 0);
});

void test("quota-wait cancellation and changed specification preserve preflight without mutation", async (t) => {
  const { continueRoadmapCapacity } = await import("./roadmap-capacity-continuation.mts");
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-phased-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const mode of ["cancel", "changed-input"]) {
    const h = phasedFixture();
    const file = path.join(root, `${mode}.json`);
    writeFileSync(file, JSON.stringify(h.spec));
    const journal = path.join(root, `${mode}-journal.json`);
    const execute = () =>
      executeSetMany({
        client: h.client,
        config,
        spec: h.spec,
        apply: true,
        progress: new SetManyJournal(journal, file, readSetManyInput(file), config),
        doctor: async () => {},
      });
    await assert.rejects(
      continueRoadmapCapacity(execute, {
        now: h.clock,
        wait: async (until) => {
          if (mode === "cancel") throw new Error("fixture cancelled while waiting for reset");
          await h.reset(until);
          writeFileSync(file, JSON.stringify({ ...h.spec, changed: true }));
        },
      }),
      mode === "cancel" ? /cancelled while waiting/ : /journal identity/,
    );
    assert.equal(h.mutations.length, 0);
    assert.ok(
      new SetManyJournal(
        journal,
        file,
        mode === "cancel" ? readSetManyInput(file) : Buffer.from(JSON.stringify(h.spec)),
        config,
      ).planning!.next_update > 0,
    );
  }
});

void test("final field verification itself continues across quota windows without restarting its accepted prefix", async (t) => {
  const { continueRoadmapCapacity } = await import("./roadmap-capacity-continuation.mts");
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-final-window-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = phasedFixture(427);
  const file = path.join(root, "spec.json");
  writeFileSync(file, JSON.stringify(h.spec));
  const journal = path.join(root, "journal.json");
  const finalPositions: number[] = [];
  const resumptionPositions = new Map<number, number[]>();
  const result = await continueRoadmapCapacity(
    () =>
      executeSetMany({
        client: h.client,
        config,
        spec: h.spec,
        apply: true,
        progress: new SetManyJournal(journal, file, readSetManyInput(file), config),
        doctor: async () => {},
      }),
    {
      now: h.clock,
      wait: h.reset,
      observe: (error) => {
        const evidence = (
          error as {
            operationEvidence: {
              phase: string;
              verified_assignments?: number;
              retained_assignments?: number;
              checked_assignments?: number;
            };
          }
        ).operationEvidence;
        if (evidence.phase === "final-field-read")
          finalPositions.push(evidence.verified_assignments!);
        if (evidence.phase === "resumption-field-read") {
          const values = resumptionPositions.get(evidence.retained_assignments!) ?? [];
          values.push(evidence.checked_assignments!);
          resumptionPositions.set(evidence.retained_assignments!, values);
        }
      },
    },
  );
  assert.equal(result.status, "succeeded");
  assert.ok(finalPositions.length >= 2);
  assert.ok(
    finalPositions.every((value, index) => index === 0 || value > finalPositions[index - 1]!),
  );
  assert.ok([...resumptionPositions.values()].some((values) => values.length > 1));
  for (const values of resumptionPositions.values())
    assert.ok(values.every((value, index) => index === 0 || value > values[index - 1]!));
  assert.equal(result.evidence.verification_epoch!.checked_assignments, 427);
  assert.match(result.evidence.verification_epoch!.scope, /not an atomic global-current snapshot/);
  assert.equal(h.mutations.flat().length, 427);
  assert.equal(new Set(h.mutations.flat()).size, 427);
});

void test("a concurrent field reversal sharing an unchanged timestamp still fails authoritative final field readback", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-same-clock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = phasedFixture(30, 10000);
  const file = path.join(root, "spec.json");
  writeFileSync(file, JSON.stringify(h.spec));
  const progress = new SetManyJournal(
    path.join(root, "journal.json"),
    file,
    readSetManyInput(file),
    config,
  );
  let reversed = false;
  const original = h.client.verifySetMany;
  h.client.verifySetMany = (plan) =>
    original.call(h.client, plan).map((row) => ({ ...row, item_revision: "a".repeat(64) }));
  await assert.rejects(
    executeSetMany({
      client: h.client,
      config,
      spec: h.spec,
      apply: true,
      progress,
      doctor: async () => {},
      onCheckpoint: (phase) => {
        if (!reversed && phase.phase === "readback" && h.mutations.flat().length === 30) {
          reversed = true;
          h.values.set("ITEM_1", "Ready");
        }
      },
    }),
    /conflicting or incomplete field/,
  );
  assert.equal(h.values.get("ITEM_1"), "Ready");
  assert.equal(h.mutations.flat().length, 30);
});

void test("durable field readback binds exact field and option IDs despite duplicate display names", () => {
  const client = new RoadmapClient(config, () => {
    throw new Error("Unexpected transport");
  });
  client.completeProjectContext = () => ({
    number: config.project.number,
    details: { id: "PROJECT" },
    fields: [
      {
        id: "STATUS",
        name: "Status",
        options: [
          { id: "READY", name: "Ready" },
          { id: "DONE", name: "Done" },
        ],
      },
    ],
  });
  const row: SetManyAssignment = {
    target: "#1",
    itemId: "ITEM_1",
    fieldName: "Status",
    from: "Ready",
    to: "Done",
    observed: "Ready",
    mutation_identity: { project_id: "PROJECT", field_id: "STATUS", option_id: "DONE" },
    target_identity: { content_id: "ISSUE", kind: "Issue" },
  };
  client.validateSetManyBindings([row]);
  const values = [
    { name: "Done", optionId: "DONE", field: { id: "OTHER", name: "Status" } },
    { name: "Ready", optionId: "READY", field: { id: "STATUS", name: "Status" } },
  ];
  let contentId = "ISSUE";
  client.graphql = () => ({
    nodes: [
      {
        id: "ITEM_1",
        isArchived: false,
        project: { id: "PROJECT" },
        content: { id: contentId, __typename: "Issue" },
        fieldValues: { totalCount: values.length, nodes: values, pageInfo: { hasNextPage: false } },
      },
    ],
  });
  const initial = client.verifySetMany({ pending: [row], alreadyApplied: [] });
  assert.equal(initial[0]!.observed, "Ready");
  assert.equal(initial[0]!.verified, false);
  values[1] = { name: "Done", optionId: "DONE", field: { id: "STATUS", name: "Status" } };
  assert.equal(client.verifySetMany({ pending: [row], alreadyApplied: [] })[0]!.verified, true);
  const saved = values[1];
  values[1] = { ...saved, optionId: "" };
  assert.throws(
    () => client.verifySetMany({ pending: [row], alreadyApplied: [] }),
    /identity coverage is incomplete/,
  );
  values[1] = saved;
  contentId = "REPLACEMENT";
  assert.throws(
    () => client.verifySetMany({ pending: [row], alreadyApplied: [] }),
    /content identity changed/,
  );
});

void test("read-only previews continue across quota windows and start fresh after completion without mutation state", async (t) => {
  const { continueRoadmapCapacity } = await import("./roadmap-capacity-continuation.mts");
  const { setManyPreviewJournalName } = await import("./roadmap-batch-progress.mts");
  const root = mkdtempSync(path.join(tmpdir(), "roadmap-preview-window-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = phasedFixture();
  const file = path.join(root, "spec.json");
  const input = Buffer.from(JSON.stringify(h.spec));
  writeFileSync(file, input);
  const journal = path.join(root, setManyPreviewJournalName(file, input, config));
  const execute = () =>
    executeSetMany({
      client: h.client,
      config,
      spec: h.spec,
      progress: new SetManyJournal(journal, file, readSetManyInput(file), config),
    });
  const result = await continueRoadmapCapacity(execute, { now: h.clock, wait: h.reset });
  assert.equal(result.status, "planned");
  assert.equal(h.mutations.length, 0);
  assert.equal(h.metadata(), 127);
  const planned = new SetManyJournal(journal, file, readSetManyInput(file), config);
  assert.equal(planned.journal!.phase, "preview-completed");
  assert.equal(planned.journal!.verified.length, 0);
  h.values.set("ITEM_1", "Done");
  const fresh = await continueRoadmapCapacity(execute, { now: h.clock, wait: h.reset });
  assert.equal(fresh.evidence.already_applied_at_start, 1);
  assert.equal(h.metadata(), 254);
  assert.equal(h.mutations.length, 0);
  assert.notEqual(
    setManyPreviewJournalName(file, input, config),
    setManyPreviewJournalName(file, Buffer.from("changed"), config),
  );
});

void test("capacity continuation binds the complete caller identity before waiting again", async () => {
  const { continueRoadmapCapacity, roadmapQuotaDeferred } =
    await import("./roadmap-capacity-continuation.mts");
  let input = "original";
  let calls = 0;
  await assert.rejects(
    continueRoadmapCapacity(
      async () => {
        calls += 1;
        throw roadmapQuotaDeferred(
          "fixture",
          {},
          { remaining: 0, resetAt: "2026-10-27T01:00:00Z" },
        );
      },
      {
        now: () => Date.parse("2026-10-27T00:00:00Z"),
        identity: () => input,
        wait: async () => {
          input = "changed";
        },
      },
    ),
    /specification or configuration changed/,
  );
  assert.equal(calls, 1);
});
