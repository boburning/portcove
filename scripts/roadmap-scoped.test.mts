import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { RoadmapClient, executeSetMany, validateConfig } from "./roadmap.mts";
import { runScopedDoctor, roadmapCheckScope, doctorFailureDiagnostics } from "./roadmap-scoped.mts";
import { InventoryError, retryableInventoryRead } from "./repository-issue-inventory.mts";
import {
  selectRoadmapHealth,
  roadmapHealthComment,
  roadmapHealthSummary,
  findRoadmapHealthComment,
} from "./roadmap-health.mts";
import { GitHubApiError } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";

const config = validateConfig(
  JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
const connection = <T,>(nodes: T[]) => ({
  totalCount: nodes.length,
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
function fixture() {
  const values = new Map([
    ["Status", "Inbox"],
    ["Priority", "None"],
    ["Target release", "Unscheduled"],
    ["Release commitment", "Planned"],
    ["Work type", "Product feature"],
  ]);
  const fields = () =>
    connection([...values].map(([field, name]) => ({ name, field: { name: field } })));
  const issue = {
    id: "I1",
    number: 1,
    title: "Scoped task",
    body: "Explicit finite work",
    state: "OPEN",
    updatedAt: "2026-10-22T12:00:00Z",
    url: `https://github.com/${config.repository}/issues/1`,
  };
  const item = () => ({
    id: "PVTI1",
    isArchived: false,
    project: { id: "PVT" },
    content: { ...issue, __typename: "Issue" },
    fieldValues: fields(),
  });
  const client = new RoadmapClient(config);
  client.projectDetails = () => ({ id: "PVT" });
  client.completeProjectContext = () => ({
    number: config.project.number,
    details: { id: "PVT" },
    fields: config.fields.map((field) => ({
      ...field,
      id: field.name,
      options: field.options.map((name) => ({ name, id: `${field.name}:${name}` })),
    })),
  });
  const queries: string[] = [];
  let mutations = 0,
    rates = 0;
  client.sampleGraphqlRate = () => ({
    resource: "graphql",
    used: ++rates,
    remaining: 4999 - rates,
    resetAt: "2099-01-01T00:00:00Z",
  });
  client.itemList = () => {
    throw new Error("Global Project listing must not run");
  };
  client.graphql = (query, variables) => {
    queries.push(query);
    if (query.includes("updateProjectV2ItemFieldValue")) {
      mutations++;
      for (const input of Object.values(variables ?? {})) {
        assert(input && typeof input === "object" && "fieldId" in input && "value" in input);
        const field = String(input.fieldId);
        assert(
          input.value && typeof input.value === "object" && "singleSelectOptionId" in input.value,
        );
        values.set(field, String(input.value.singleSelectOptionId).slice(field.length + 1));
      }
      return { f0: { projectV2Item: { id: "PVTI1" } } };
    }
    if (query.includes("ScopedProjectItem")) return { node: item() };
    if (query.includes("nodes(ids:")) return { nodes: [item()] };
    assert(query.includes("repository(owner"), "Unexpected query");
    return {
      repository: {
        issue: {
          ...issue,
          parent: null,
          projectItems: connection([item()]),
          blockedBy: connection([]),
          blocking: connection([]),
          subIssues: connection([]),
        },
      },
    };
  };
  return { client, issue, item, values, queries, mutations: () => mutations };
}

void test("scoped doctor uses real direct issue reads and never needs the failing global listing", async () => {
  const f = fixture();
  const result = await runScopedDoctor(config, f.client, { issues: [1], catalog: { ports: [] } });
  assert.equal(result.coverage, "complete");
  assert.equal(result.global_health, "not_evaluated");
  assert.deepEqual(result.scope.checked_issues, [1]);
  assert.equal(f.queries.length, 2);
  assert.equal(f.mutations(), 0);
});

for (const ownerType of ["User", "Organization"] as const) {
  void test(`scoped doctor resolves a ${ownerType} Project through observable API reads`, async () => {
    const f = fixture();
    const root = ownerType === "Organization" ? "organization" : "user";
    const otherRoot = ownerType === "Organization" ? "user" : "organization";
    const client = new RoadmapClient(config, (args, input) => {
      assert.equal(args[0], "api", "Project CLI owner inference must not run");
      if (args[2] === `users/${config.owner}`) {
        assert(args.includes("GET"));
        return JSON.stringify({ login: config.owner, type: ownerType });
      }
      assert.equal(args[1], "graphql");
      const request: unknown = JSON.parse(input ?? "null");
      assert(isRecord(request) && typeof request.query === "string" && isRecord(request.variables));
      if (request.query.includes("projectV2(number:")) {
        assert(request.query.includes(`${root}(login: $login)`));
        assert(!request.query.includes(`${otherRoot}(login:`));
        assert.deepEqual(request.variables, { login: config.owner, number: config.project.number });
        return JSON.stringify({
          data: {
            [root]: { projectV2: { id: "PVT", number: config.project.number } },
          },
        });
      }
      return JSON.stringify({ data: f.client.graphql(request.query, request.variables) });
    });
    const result = await runScopedDoctor(config, client, { issues: [1], catalog: { ports: [] } });
    assert.equal(result.coverage, "complete");
    assert.equal(result.global_health, "not_evaluated");
    assert.deepEqual(result.scope.checked_issues, [1]);
    assert.deepEqual(
      client.api.observations.map(({ operation }) => operation),
      [`GET users/${config.owner}`, "POST graphql", "POST graphql", "POST graphql"],
    );
    assert.equal(f.queries.length, 2);
    assert.equal(f.mutations(), 0);
  });
}

void test("selected Project lookup rejects absent or mismatched identities before issue reads", () => {
  for (const project of [
    null,
    {},
    { id: "", number: config.project.number },
    { id: "PVT", number: 999 },
  ]) {
    const client = new RoadmapClient(config, (args) => {
      assert.equal(args[0], "api");
      if (args[2] === `users/${config.owner}`) return JSON.stringify({ type: "User" });
      return JSON.stringify({ data: { user: { projectV2: project } } });
    });
    assert.throws(
      () => client.executionIssue(1),
      /selected Project identity is unavailable or mismatched/,
    );
    assert.equal(client.api.observations.length, 2);
  }
});

void test("Project discovery retains provider authentication failures and their diagnostics", async () => {
  for (const [stage, status] of [
    ["owner", 401],
    ["project", 403],
  ] as const) {
    const client = new RoadmapClient(config, (args) => {
      assert.equal(args[0], "api");
      if (stage === "project" && args[2] === `users/${config.owner}`)
        return JSON.stringify({ type: "User" });
      throw new GitHubApiError("http_error", "Project credential was refused", { status });
    });
    await assert.rejects(
      runScopedDoctor(config, client, { issues: [1], catalog: { ports: [] } }),
      (error: unknown) => {
        assert(error instanceof GitHubApiError);
        assert.equal(error.status, status);
        const diagnosis = doctorFailureDiagnostics(error);
        assert.equal(diagnosis.kind, "authentication");
        assert.equal(diagnosis.coverage, "inconclusive");
        assert.match(diagnosis.error.message, /Project credential was refused/);
        return true;
      },
    );
    assert.equal(client.api.observations.length, stage === "owner" ? 1 : 2);
  }
});

void test("direct prerequisites use their own complete memberships rather than absence in a scoped subset", async () => {
  for (const present of [true, false]) {
    const f = fixture();
    f.values.set("Target release", config.active_release);
    f.values.set("Release commitment", "Required");
    const graphql = f.client.graphql.bind(f.client);
    f.client.graphql = (query, variables) => {
      const dependency = {
        ...f.issue,
        id: "I2",
        number: 2,
        url: `https://github.com/${config.repository}/issues/2`,
      };
      if (query.includes("nodes(ids:"))
        return {
          nodes: [
            {
              ...dependency,
              __typename: "Issue",
              projectItems: connection(present ? [{ ...f.item(), id: "PVTI2" }] : []),
            },
          ],
        };
      const result = graphql(query, variables);
      assert(isRecord(result) && isRecord(result.repository) && isRecord(result.repository.issue));
      result.repository.issue.blockedBy = connection([dependency]);
      return result;
    };
    const check = runScopedDoctor(config, f.client, { issues: [1], catalog: { ports: [] } });
    if (present) assert.equal((await check).global_health, "not_evaluated");
    else await assert.rejects(check, /direct dependency outside/);
  }
});

void test("dependency memberships query only actual identities in bounded batches", () => {
  const f = fixture();
  const dependencies = Array.from({ length: 11 }, (_, index) => ({
    ...f.issue,
    id: `I${index + 2}`,
    number: index + 2,
    url: `https://github.com/${index === 0 ? "other/repository" : config.repository}/issues/${index + 2}`,
  }));
  const initial = f.client.graphql.bind(f.client);
  const batches: unknown[][] = [];
  f.client.graphql = (query, variables) => {
    assert.match(query, /rateLimit\{cost limit remaining resetAt used\}/u);
    if (query.includes("nodes(ids:")) {
      const ids = variables?.ids;
      assert(Array.isArray(ids));
      batches.push(ids);
      return {
        nodes: ids.toReversed().map((id) => ({
          ...dependencies.find((node) => node.id === id),
          __typename: "Issue",
          projectItems: connection([{ ...f.item(), id: `PVTI-${id}` }]),
        })),
      };
    }
    assert.doesNotMatch(query, /blockedBy[^]*projectItems/u);
    const result = initial(query, variables);
    assert(isRecord(result) && isRecord(result.repository) && isRecord(result.repository.issue));
    result.repository.issue.blockedBy = connection(dependencies);
    return result;
  };
  const result = f.client.executionIssue(1);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [10, 1],
  );
  assert.deepEqual(
    result.relationships.blockedBy.map((node) => node.id),
    dependencies.map((node) => node.id),
  );
  assert(result.relationships.blockedBy.every((node) => node.projectItemId === `PVTI-${node.id}`));
  assert.equal(result.relationships.blockedBy[0]?.url, dependencies[0]?.url);
});

void test("dependency hydration refuses incomplete identities and concurrent content changes", () => {
  const corruptions: ((nodes: Record<string, unknown>[]) => unknown[])[] = [
    () => [],
    () => [null],
    (nodes) => [nodes[0], nodes[0]],
    ([node]) => [{ ...node, id: "foreign" }],
    ([node]) => [{ ...node, __typename: "PullRequest" }],
    ([node]) => [{ ...node, url: "https://github.com/other/repository/issues/2" }],
    ([node]) => [{ ...node, number: 99 }],
    ([node]) => [{ ...node, body: "changed" }],
    ([node]) => [{ ...node, title: "changed" }],
    ([node]) => [{ ...node, state: "CLOSED" }],
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const f = fixture();
    const dependency = {
      ...f.issue,
      id: "I2",
      number: 2,
      url: `https://github.com/${config.repository}/issues/2`,
    };
    const initial = f.client.graphql.bind(f.client);
    f.client.graphql = (query, variables) => {
      if (query.includes("nodes(ids:"))
        return {
          nodes: corrupt([
            { ...dependency, __typename: "Issue", projectItems: connection([f.item()]) },
          ]),
        };
      const result = initial(query, variables);
      assert(isRecord(result) && isRecord(result.repository) && isRecord(result.repository.issue));
      result.repository.issue.blockedBy = connection([dependency]);
      return result;
    };
    assert.throws(
      () => f.client.executionIssue(1),
      (error: unknown) => {
        assert(error instanceof InventoryError);
        assert.equal(
          error.kind,
          index >= 7
            ? "inventory_changed"
            : [0, 2].includes(index)
              ? "inventory_incomplete"
              : "inventory_identity",
        );
        return true;
      },
    );
  }
});

void test("planning failures retain the complete checked scope without granting coverage to provider failures", async () => {
  const f = fixture();
  f.issue.state = "CLOSED";
  await assert.rejects(
    runScopedDoctor(config, f.client, { issues: [1], catalog: { ports: [] } }),
    (error: unknown) => {
      assert(isRecord(error));
      assert.deepEqual(error.doctorScope, { kind: "issues", issues: [1], checked_issues: [1] });
      return true;
    },
  );
  f.client.executionIssue = () => {
    throw new InventoryError("inventory_incomplete", "Missing membership");
  };
  await assert.rejects(
    runScopedDoctor(config, f.client, { issues: [1], catalog: { ports: [] } }),
    (error: unknown) => {
      assert(isRecord(error));
      assert.equal(error.doctorScope, undefined);
      return true;
    },
  );
});

void test("diagnostics show bounded redacted findings and provider reset evidence", () => {
  const report = {
    status: "failed",
    scope: { kind: "issues", issues: [1] },
    coverage: "inconclusive",
    errors: [
      "API quota exhausted ghp_secret @someone <details>",
      "API quota exhausted ghp_secret @someone <details>",
    ],
    diagnosis: doctorFailureDiagnostics(
      new GitHubApiError("rate_limited", "quota", {
        status: 200,
        retryAfter: "60",
        rateLimit: {
          resource: "graphql",
          limit: 5000,
          remaining: 58,
          used: 4942,
          resetAt: "2026-10-24T22:15:26Z",
        },
      }),
    ),
  };
  for (const text of [
    roadmapHealthComment(report, null, "https://github.test/run/1"),
    roadmapHealthSummary(report, "https://github.test/run/1"),
  ]) {
    assert(text);
    assert.match(text, /Observed findings/u);
    assert.match(text, /Remaining quota: 58/u);
    assert.match(text, /2026-10-24T22:15:26.000Z/u);
    assert.match(text, /Retry-After: 60 seconds/u);
    assert.doesNotMatch(text, /ghp_secret/u);
    assert(text.includes("\\@someone \\<details\\>"));
    assert.match(text, /No complete checked issue set is established/u);
  }
});

void test("direct item resolution validates configured Project, issue binding, archive and complete fields", () => {
  const f = fixture();
  assert.equal(f.client.directProjectItem("#1").id, "PVTI1");
  for (const corruption of [
    { isArchived: true },
    { project: { id: "foreign" } },
    { fieldValues: { ...f.item().fieldValues, totalCount: 99 } },
    { content: { ...f.issue, __typename: "Issue", number: 2 } },
  ]) {
    const bad = fixture();
    const graphql = bad.client.graphql.bind(bad.client);
    bad.client.graphql = (query, variables) =>
      query.includes("ScopedProjectItem")
        ? { node: { ...bad.item(), ...corruption } }
        : graphql(query, variables);
    assert.throws(() => bad.client.directProjectItem("#1"), /identity|binding|truncated|outside/);
    assert.equal(bad.mutations(), 0);
  }
});

void test("ordinary set-many runs automatic scoped validation after exact readback", async () => {
  const f = fixture();
  const result = await executeSetMany({
    config,
    client: f.client,
    apply: true,
    spec: {
      schema_version: 1,
      updates: [{ target: "#1", fields: { Priority: { from: "None", to: "High" } } }],
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence.doctor_scope, "issues");
  assert.equal(result.evidence.doctor, "passed");
  assert.equal(f.values.get("Priority"), "High");
  assert.equal(f.mutations(), 1);
});

void test("scoped status consistency includes closed and reopened unscheduled work", async () => {
  for (const [state, status, valid] of [
    ["CLOSED", "Inbox", false],
    ["OPEN", "Done", false],
    ["CLOSED", "Done", true],
    ["OPEN", "Inbox", true],
  ] as const) {
    const f = fixture();
    f.issue.state = state;
    f.values.set("Status", status);
    const check = runScopedDoctor(config, f.client, { issues: [1], catalog: { ports: [] } });
    if (valid) await check;
    else await assert.rejects(check, /inconsistent repository\/Project status/u);
  }
});

void test("production batch outcomes retain typed doctor causes and completed mutation evidence", async () => {
  const mismatch = { listed_count: 1, issue_memberships: 2, item_ids: ["PVTI1", "PVTI2"] };
  for (const [cause, kind] of [
    [
      Object.assign(new InventoryError("provider_inconsistent", "Index mismatch"), {
        membershipMismatch: mismatch,
      }),
      "provider_inconsistent",
    ],
    [
      Object.assign(new Error("Planning conflict"), { doctorErrors: ["Status mismatch"] }),
      "planning_findings",
    ],
    [new GitHubApiError("http_error", "Forbidden", { status: 403 }), "authentication"],
    [new GitHubApiError("rate_limited", "Quota reset pending", { status: 429 }), "rate_limit"],
    [new GitHubApiError("budget_exhausted", "Reserve exhausted"), "budget"],
  ] as const) {
    const f = fixture();
    await assert.rejects(
      executeSetMany({
        config,
        client: f.client,
        apply: true,
        spec: {
          schema_version: 1,
          updates: [{ target: "#1", fields: { Priority: { from: "None", to: "High" } } }],
        },
        doctor: () => {
          throw cause;
        },
      }),
      (error: unknown) => {
        assert(isRecord(error) && isRecord(error.operationEvidence));
        assert.equal(error.operationStatus, "partial");
        assert.equal(error.operationEvidence.doctor, "failed");
        assert.equal(error.operationEvidence.verified, 1);
        const diagnosis = doctorFailureDiagnostics(error);
        assert.equal(diagnosis.kind, kind);
        assert.equal(
          diagnosis.coverage,
          kind === "planning_findings" ? "complete" : "inconclusive",
        );
        assert.equal(diagnosis.error.code, "set_many_partial");
        assert(diagnosis.cause);
        if (kind === "provider_inconsistent")
          assert.deepEqual(diagnosis.membership_mismatch, mismatch);
        return true;
      },
    );
    assert.equal(f.values.get("Priority"), "High");
    assert.equal(f.mutations(), 1);
  }
});

void test("scoped concurrent edits invalidate success and invalid requests make no API calls", async () => {
  const f = fixture();
  const graphql = f.client.graphql.bind(f.client);
  let reads = 0;
  f.client.graphql = (query, variables) => {
    if (++reads === 2) f.issue.body = "Changed required work";
    return graphql(query, variables);
  };
  await assert.rejects(
    runScopedDoctor(config, f.client, { issues: [1], catalog: { ports: [] } }),
    /changed during validation/,
  );
  const invalid = fixture();
  for (const issues of [[], [0], [1.5], Array.from({ length: 101 }, (_, i) => i + 1)])
    await assert.rejects(runScopedDoctor(config, invalid.client, { issues }), /1 to 100/);
  assert.equal(invalid.queries.length, 0);
});

void test("full doctor selection is explicit for material batches and release planning", () => {
  const changes = Array.from({ length: 10 }, (_, i) => ({
    target: `#${i + 1}`,
    fieldName: "Priority",
  }));
  assert.equal(roadmapCheckScope(changes), "issues");
  assert.equal(roadmapCheckScope([...changes, { target: "#11", fieldName: "Status" }]), "global");
  for (const fieldName of ["Target release", "Release commitment"])
    assert.equal(roadmapCheckScope([{ target: "#1", fieldName }]), "global");
});

void test("stable provider contradictions are inconclusive and never read-retried", () => {
  const error = new InventoryError("provider_inconsistent", "Stable counts disagree");
  assert.equal(retryableInventoryRead(error), false);
  assert.equal(doctorFailureDiagnostics(error).coverage, "inconclusive");
  assert.match(doctorFailureDiagnostics(error).recovery_condition!, /do not recreate/);
});

void test("issue events and explicit requests select scoped checks; substantial changes select full checks", () => {
  const read = () => "same";
  assert.deepEqual(selectRoadmapHealth("issues", { issue: { number: 42 } }, read), {
    mode: "issues",
    issue: 42,
  });
  assert.deepEqual(selectRoadmapHealth("workflow_dispatch", { inputs: { issue: "42" } }, read), {
    mode: "issues",
    issue: 42,
  });
  assert.deepEqual(selectRoadmapHealth("workflow_dispatch", {}, read), { mode: "global" });
  assert.deepEqual(
    selectRoadmapHealth("workflow_dispatch", { inputs: { inventory_items: "PVTI_example" } }, read),
    { mode: "none" },
  );
  assert.throws(
    () => selectRoadmapHealth("issues", { issue: { number: "42; command" } }, read),
    /Invalid/,
  );
  assert.throws(() => selectRoadmapHealth("schedule", {}, read), /Unsupported/);
  const event = { before: "a".repeat(40), after: "b".repeat(40) };
  const catalog = (id: string) => JSON.stringify({ ports: [{ id, platforms: ["windows-x64"] }] });
  assert.deepEqual(
    selectRoadmapHealth("push", event, (_revision, file) =>
      file.endsWith("catalog.json") ? catalog("one") : "same",
    ),
    { mode: "none" },
  );
  assert.deepEqual(
    selectRoadmapHealth("push", event, (revision, file) =>
      file.endsWith("catalog.json") ? catalog(revision) : "same",
    ),
    { mode: "global" },
  );
  assert.deepEqual(
    selectRoadmapHealth("push", event, () => {
      throw new Error("Missing base");
    }),
    { mode: "global" },
  );
});

void test("extracted Roadmap issue policy still triggers and selects a global health check", () => {
  const leaf = "scripts/roadmap-issue.mts";
  const workflow: unknown = parseDocument(
    readFileSync(new URL("../.github/workflows/roadmap-health.yml", import.meta.url), "utf8"),
    { uniqueKeys: true },
  ).toJS();
  assert.ok(isRecord(workflow) && isRecord(workflow.on) && isRecord(workflow.on.push));
  assert.ok(Array.isArray(workflow.on.push.paths) && workflow.on.push.paths.includes(leaf));
  assert.deepEqual(
    selectRoadmapHealth(
      "push",
      {
        before: "a".repeat(40),
        after: "b".repeat(40),
      },
      (revision, file) =>
        file === leaf ? revision : file.endsWith("catalog.json") ? '{"ports":[]}' : "same",
    ),
    { mode: "global" },
  );
});

void test("diagnostic reporting is quiet on unchanged repeats and scoped success cannot clear global failure", () => {
  const failure = {
    status: "failed",
    scope: { kind: "global" },
    diagnosis: { kind: "provider_inconsistent", recovery_condition: "Restore the existing index" },
  };
  const first = roadmapHealthComment(failure, null, "https://github.test/run/1");
  assert(first);
  assert.equal(roadmapHealthComment(failure, first, "https://github.test/run/2"), null);
  assert.equal(
    roadmapHealthComment(
      { status: "passed", scope: { kind: "issues", issues: [1] } },
      first,
      "https://github.test/run/3",
    ),
    null,
  );
  assert.match(
    roadmapHealthComment(
      { status: "passed", scope: { kind: "global" } },
      first,
      "https://github.test/run/4",
    )!,
    /recovered/,
  );
  const scopedFailure = { ...failure, scope: { kind: "issues", issues: [1] } };
  const scopedComment = roadmapHealthComment(scopedFailure, null, "https://github.test/run/5");
  assert.match(
    roadmapHealthComment(
      { status: "passed", scope: { kind: "issues", issues: [1], checked_issues: [1, 2] } },
      scopedComment,
      "https://github.test/run/6",
    )!,
    /recovered/,
  );
});

void test("hosted automation has no periodic schedule and executes trusted source with retained failures", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/roadmap-health.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /\b(?:schedule|cron):/u);
  assert.match(workflow, /github\.event\.repository\.default_branch/u);
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /PORTCOVE_ROADMAP_TOKEN/u);
  assert.doesNotMatch(workflow, /pull_request_target|issue_comment/u);
  assert.doesNotMatch(workflow, /concurrency:/u);
  assert.match(workflow, /needs: configuration/u);
  assert.match(workflow, /available: \$\{\{ steps\.project-token\.outputs\.available \}\}/u);
  assert.match(workflow, /permissions: \{\}/u);
  assert.match(workflow, /if \[\[ -n "\$PROJECT_TOKEN" \]\]; then/u);
  assert.match(workflow, /echo 'available=true'/u);
  assert.match(workflow, /echo 'available=false'/u);
  assert.doesNotMatch(workflow, /echo[^\n]*\$PROJECT_TOKEN/u);
});

void test("retained observations expose scope and source without refreshing unchanged diagnoses", () => {
  const runUrl = "https://github.test/actions/runs/1/attempts/2";
  const failure = {
    status: "failed",
    scope: { kind: "issues", issues: [42], checked_issues: [42, 71] },
    coverage: "inconclusive",
    observation: { observed_at: "2026-10-23T12:00:00.000Z", checkout_head: "b".repeat(40) },
    diagnosis: { kind: "transport", recovery_condition: "Restore a complete receipt" },
  };
  const comment = roadmapHealthComment(failure, null, runUrl);
  assert(comment);
  for (const text of [comment, roadmapHealthSummary(failure, runUrl)]) {
    assert.match(text, /issues #42\./u);
    assert.match(text, /Checked issues: #42, #71/u);
    assert.match(text, /Observed: 2026-10-23T12:00:00.000Z/u);
    assert(text.includes(`Actual checkout: \`${"b".repeat(40)}\``));
    assert(text.includes(runUrl));
    assert.match(text, /Coverage: \*\*inconclusive\*\*/u);
    assert.match(text, /global health was not evaluated/u);
    assert.doesNotMatch(text, /Latest Roadmap check/u);
  }
  assert.equal(
    roadmapHealthComment(
      {
        ...failure,
        observation: { observed_at: "2026-10-23T13:00:00.000Z", checkout_head: "c".repeat(40) },
      },
      comment,
      "https://github.test/actions/runs/1/attempts/3",
    ),
    null,
  );
  const global = {
    ...failure,
    scope: { kind: "global" },
    coverage: "complete",
    global_health: "failed",
  };
  for (const text of [
    roadmapHealthComment(global, null, runUrl)!,
    roadmapHealthSummary(global, runUrl),
  ]) {
    assert.match(text, /global audit/u);
    assert.match(text, /Global audit coverage: \*\*complete\*\*/u);
    assert.match(text, /Global health: \*\*failed\*\*/u);
    assert.doesNotMatch(text, /global health was not evaluated|scoped result/u);
  }
});

void test("missing hosted configuration shares one incident across issues and global checks", () => {
  const missing = (scope: Record<string, unknown>) => ({
    status: "failed",
    scope,
    coverage: "inconclusive",
    planning_findings_evaluated: false,
    diagnosis: {
      kind: "configuration_missing",
      recovery_condition: "Configure the dedicated token",
    },
  });
  const first = missing({ kind: "issues", issues: [1] });
  const body = roadmapHealthComment(first, null, "https://github.test/run/1");
  assert(body);
  assert.match(body, /\*\*not configured\*\*/u);
  assert.match(body, /doctor did not run/u);
  assert.doesNotMatch(body, /Latest Roadmap check: \*\*failed\*\*/u);
  const comment = { id: 1, body, user: { type: "Bot", login: "github-actions[bot]" } };
  for (const scope of [{ kind: "issues", issues: [2] }, { kind: "global" }]) {
    const report = missing(scope);
    assert.equal(findRoadmapHealthComment([comment], report), comment);
    assert.equal(roadmapHealthComment(report, body, "https://github.test/run/2"), null);
    assert.deepEqual(report.scope, scope);
  }
  assert.deepEqual(first.scope, { kind: "issues", issues: [1] });
  assert.equal(first.coverage, "inconclusive");
  assert.equal(first.planning_findings_evaluated, false);
  // A configured scoped success neither repurposes the incident nor claims
  // that missing configuration was a checked planning finding.
  const passed = { status: "passed", scope: first.scope };
  assert.equal(findRoadmapHealthComment([comment], passed), undefined);
  assert.equal(roadmapHealthComment(passed, body, "https://github.test/run/3"), null);
});

void test("configuration migration deterministically reuses legacy evidence without absorbing planning failures", () => {
  const bot = { type: "Bot", login: "github-actions[bot]" };
  const legacy = (id: number, scope: Record<string, unknown>) => ({
    id,
    user: bot,
    body:
      `<!-- portcove-roadmap-health:${JSON.stringify({ scope: JSON.stringify(scope), status: "failed", digest: "legacy" })} -->\n` +
      "Latest Roadmap check: **failed**.\n\nClassification: `configuration_missing`. Setup required.",
  });
  const global = legacy(10, { kind: "global" });
  const scoped = legacy(5, { kind: "issues", issues: [1] });
  const otherGlobal = legacy(20, { kind: "global" });
  const missing = {
    status: "failed",
    scope: { kind: "issues", issues: [2] },
    diagnosis: { kind: "configuration_missing" },
  };
  const planning = {
    ...missing,
    scope: { kind: "issues", issues: [1] },
    diagnosis: { kind: "planning_findings" },
    errors: ["Missing required field"],
  };
  const provider = {
    id: 2,
    user: bot,
    body: roadmapHealthComment(
      { ...planning, scope: { kind: "global" }, diagnosis: { kind: "provider_inconsistent" } },
      null,
      "https://github.test/run/1",
    )!,
  };
  const planningComment = {
    id: 3,
    user: bot,
    body: roadmapHealthComment(planning, null, "https://github.test/run/2")!,
  };
  const unrelated = [
    provider,
    planningComment,
    { ...global, id: 1, user: { type: "User", login: "owner" } },
    { ...global, id: 4, body: "<!-- portcove-roadmap-health:invalid -->" + global.body },
  ];
  assert.equal(findRoadmapHealthComment(unrelated, missing), undefined);
  const comments = [...unrelated, otherGlobal, scoped, global];
  assert.equal(findRoadmapHealthComment(comments, missing), global);
  assert.equal(findRoadmapHealthComment(comments.toReversed(), missing), global);
  global.body = roadmapHealthComment(missing, global.body, "https://github.test/run/3")!;
  assert.match(global.body, /repository-wide setup incident/u);
  assert.equal(findRoadmapHealthComment(comments.toReversed(), missing), global);
  assert.equal(roadmapHealthComment(missing, global.body, "https://github.test/run/4"), null);
  assert.equal(findRoadmapHealthComment(comments, planning), planningComment);
  assert.equal(findRoadmapHealthComment([global, scoped], planning), undefined);
  assert.equal(findRoadmapHealthComment([scoped], { ...planning, status: "passed" }), undefined);
  assert.match(provider.body, /provider_inconsistent/u);
  assert.match(scoped.body, /Latest Roadmap check: \*\*failed\*\*/u);
});

void test("interleaved scopes retain independent failures and unchanged diagnosis order remains quiet", () => {
  const globalFailure = {
    status: "failed",
    scope: { kind: "global" },
    diagnosis: {
      kind: "provider_inconsistent",
      membership_mismatch: { listed_count: 1, item_ids: ["B", "A"] },
    },
    errors: ["second", "first"],
  };
  const scoped = (issue: number, status = "failed") => ({
    ...globalFailure,
    status,
    scope: { kind: "issues", issues: [issue] },
  });
  const comments: Record<string, unknown>[] = [];
  const report = (value: Record<string, unknown>) => {
    const previous = findRoadmapHealthComment(comments, value);
    const body = roadmapHealthComment(
      value,
      previous ? String(previous.body) : null,
      "https://github.test/run/1",
    );
    if (body) {
      if (previous) previous.body = body;
      else
        comments.push({
          id: comments.length + 1,
          body,
          user: { type: "Bot", login: "github-actions[bot]" },
        });
    }
    return body;
  };
  assert(report(globalFailure));
  assert(report(scoped(1)));
  assert(report(scoped(2)));
  assert.equal(report(scoped(1)), null);
  assert.equal(
    report({
      ...globalFailure,
      diagnosis: {
        ...globalFailure.diagnosis,
        membership_mismatch: { item_ids: ["A", "B"], listed_count: 1 },
      },
      errors: ["first", "second"],
    }),
    null,
  );
  assert.match(report(scoped(1, "passed"))!, /recovered/u);
  assert.match(String(findRoadmapHealthComment(comments, globalFailure)?.body), /\*\*failed\*\*/u);
  assert.match(String(findRoadmapHealthComment(comments, scoped(2))?.body), /\*\*failed\*\*/u);
  assert.equal(comments.length, 3);
  assert.equal(report(scoped(1, "passed")), null);
  assert.equal(
    findRoadmapHealthComment(
      [{ ...comments[0], user: { type: "User", login: "owner" } }],
      globalFailure,
    ),
    undefined,
  );
});
void test("actual unattended entrypoint retains missing-credential diagnostics without contacting GitHub", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const temporary = mkdtempSync(path.join(os.tmpdir(), "roadmap-health-event-"));
  try {
    const event = path.join(temporary, "event.json");
    writeFileSync(event, JSON.stringify({ issue: { number: 42 } }));
    const result = spawnSync(process.execPath, ["scripts/roadmap-health.mts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env: {
        ...process.env,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GITHUB_EVENT_PATH: event,
        GITHUB_EVENT_NAME: "issues",
        GITHUB_STEP_SUMMARY: path.join(temporary, "summary.md"),
        GITHUB_SERVER_URL: "https://github.test",
        GITHUB_REPOSITORY: "owner/repository",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_SHA: "0".repeat(40),
      },
    });
    assert.equal(result.status, 1, result.stderr);
    const reference = result.stdout.match(/evidence: ([^\r\n]+)/u)?.[1];
    assert(
      reference &&
        path.resolve(reference).startsWith(path.join(root, "work", "roadmap-health") + path.sep),
      result.stderr || result.stdout || String(result.error),
    );
    const report = JSON.parse(readFileSync(reference, "utf8")) as {
      scope: { kind: string; issues: number[] };
      diagnosis: { kind: string };
      planning_findings_evaluated: boolean;
      coverage: string;
      observation: { observed_at: string; checkout_head: string; run_url: string };
    };
    assert.deepEqual(report.scope, { kind: "issues", issues: [42] });
    assert.equal(report.diagnosis.kind, "configuration_missing");
    assert.equal(report.coverage, "inconclusive");
    assert.equal(report.planning_findings_evaluated, false);
    assert.equal(
      report.observation.run_url,
      "https://github.test/owner/repository/actions/runs/123/attempts/2",
    );
    const actualHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    assert.equal(actualHead.status, 0);
    assert.equal(report.observation.checkout_head, actualHead.stdout.trim());
    assert.notEqual(report.observation.checkout_head, "0".repeat(40));
    assert(Number.isFinite(Date.parse(report.observation.observed_at)));
    const summary = readFileSync(path.join(temporary, "summary.md"), "utf8");
    assert.match(summary, /\*\*not configured\*\*/u);
    assert.match(summary, /configuration_missing/u);
    assert.match(summary, /PORTCOVE_ROADMAP_TOKEN/u);
    assert.match(summary, /issue=2414/u);
    assert.match(summary, /issues #42/u);
    assert(summary.includes(report.observation.run_url));
    assert(summary.includes(report.observation.checkout_head));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
