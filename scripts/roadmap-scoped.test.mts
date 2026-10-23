import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RoadmapClient, executeSetMany, validateConfig } from "./roadmap.mts";
import { runScopedDoctor, roadmapCheckScope, doctorFailureDiagnostics } from "./roadmap-scoped.mts";
import { InventoryError, retryableInventoryRead } from "./repository-issue-inventory.mts";
import { selectRoadmapHealth, roadmapHealthComment } from "./roadmap-health.mts";
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
void test("direct prerequisites use their own complete memberships rather than absence in a scoped subset", async () => {
  for (const present of [true, false]) {
    const f = fixture();
    f.values.set("Target release", config.active_release);
    f.values.set("Release commitment", "Required");
    const graphql = f.client.graphql.bind(f.client);
    f.client.graphql = (query, variables) => {
      const result = graphql(query, variables);
      assert(isRecord(result) && isRecord(result.repository) && isRecord(result.repository.issue));
      result.repository.issue.blockedBy = connection([
        {
          ...f.issue,
          id: "I2",
          number: 2,
          url: `https://github.com/${config.repository}/issues/2`,
          projectItems: connection(present ? [{ ...f.item(), id: "PVTI2" }] : []),
        },
      ]);
      return result;
    };
    const check = runScopedDoctor(config, f.client, { issues: [1], catalog: { ports: [] } });
    if (present) assert.equal((await check).global_health, "not_evaluated");
    else await assert.rejects(check, /direct dependency outside/);
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
      },
    });
    assert.equal(result.status, 1, result.stderr);
    const reference = result.stdout.match(/evidence: ([^\r\n]+)/u)?.[1];
    assert(
      reference &&
        path.resolve(reference).startsWith(path.join(root, "work", "roadmap-health") + path.sep),
    );
    const report = JSON.parse(readFileSync(reference, "utf8")) as {
      diagnosis: { kind: string };
      planning_findings_evaluated: boolean;
      coverage: string;
    };
    assert.equal(report.diagnosis.kind, "configuration_missing");
    assert.equal(report.coverage, "inconclusive");
    assert.equal(report.planning_findings_evaluated, false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
