import { fixtureIssueInventory } from "./repository-issue-inventory.fixture.mts";
import type { RoadmapIssueItem } from "./roadmap.mts";
import { validateApproval706 } from "./linux-beta-risk-706.mts";
import type { GitHubRunner } from "./github-api.mts";
import type { SetManyClient, SetManyAssignment } from "./roadmap.mts";
import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import { createGitHubRunner } from "./github-api.mts";

import {
  RoadmapClient,
  readDoctorRepositoryIssues,
  runDoctor,
  roadmapHelp,
  roadmapCommandHelp,
  analyzeReleaseReadiness,
  renderReadinessSummary,
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
  coordinationTarget,
  parseConsumptionRecord,
  consumedReference,
  executionQueueData,
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
} from "./roadmap.mts";

interface RunnerCall {
  args: readonly string[];
  input?: string | undefined;
}
function fixtureValue<T>(value: T): NonNullable<T> {
  assert.ok(value !== undefined && value !== null, "expected present fixture value");
  return value;
}
function fixtureFind<T>(values: readonly T[], predicate: (value: T) => boolean): T {
  return fixtureValue(values.find(predicate));
}
function fixtureElement<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert.ok(value !== undefined, `expected fixture element ${index}`);
  return value;
}
function fixtureObject(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "expected a structured fixture boundary value");
  return value;
}
function fixtureJsonObject(input: unknown) {
  assert.ok(typeof input === "string", "expected serialized fixture input");
  const value: unknown = JSON.parse(input);
  return fixtureObject(value);
}
function fixtureSelectInput(value: unknown) {
  const input = fixtureObject(value);
  const selected = fixtureObject(input.value);
  assert.ok(typeof input.fieldId === "string" && typeof selected.singleSelectOptionId === "string");
  return { fieldId: input.fieldId, value: { singleSelectOptionId: selected.singleSelectOptionId } };
}
function fixtureGraphql(input: unknown) {
  const value = fixtureJsonObject(input);
  assert.ok(typeof value.query === "string" && isRecord(value.variables));
  return { query: value.query, variables: value.variables };
}
const config = validateConfig(
  JSON.parse(await readFile(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
);
function fixtureProjectDetails(
  args: readonly string[],
  input: string | undefined,
  id: string,
  number = config.project.number,
) {
  if (args[0] === "api" && args[2] === "users/boburning") return JSON.stringify({ type: "User" });
  if (args[0] !== "api" || args[1] !== "graphql") return undefined;
  const request = fixtureGraphql(input);
  if (
    !request.query.includes("user(login: $login)") ||
    !request.query.includes("projectV2(number: $number)") ||
    request.query.includes("fields(")
  )
    return undefined;
  assert.equal(request.variables.login, "boburning");
  assert.equal(request.variables.number, number);
  return JSON.stringify({ data: { user: { projectV2: { id, number } } } });
}
const newPortForm = await readFile(
  new URL("../.github/ISSUE_TEMPLATE/new-port.yml", import.meta.url),
  "utf8",
);

type PickupItem = Parameters<typeof deriveExecutionContext>[1];
type PickupRelationships = Parameters<typeof deriveExecutionContext>[2];
type PickupOptions = Parameters<typeof deriveExecutionContext>[3];
const pickupIssue = (
  number = 1104,
  body = "## Acceptance\n- [ ] Preserve recovery.",
): PickupItem => ({
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
const pickupRelations = (): PickupRelationships => ({
  parent: null,
  subIssues: [],
  blockedBy: [],
  blocking: [],
});
type ContextFixture = ReturnType<typeof deriveExecutionContext>;
const pickupContext = (
  item = pickupIssue(),
  relationships = pickupRelations(),
  options: Partial<PickupOptions> = {},
): ContextFixture =>
  deriveExecutionContext(config, item, relationships, {
    runner: "Local",
    comments: [],
    coverage: { complete: false, count: 50, total: 2200 },
    ...options,
  });
// Archived consumed-requirements record: only the read compatibility remains.
const acknowledgment = (context = pickupContext(), runner = "Local") => ({
  body: `<!-- portcove-roadmap-consumed:v1 -->\n\`\`\`json\n${JSON.stringify({
    schema_version: 1,
    kind: "consumed-requirements",
    runner,
    action: "Compared acceptance; continue owned task",
    evidence: "https://github.com/boburning/portcove/pull/1",
    snapshot: context.snapshot,
    observation_revision: context.observation_revision,
    coordination_target: context.coordination_target,
  })}\n\`\`\``,
});
const acknowledgmentComment = (context = pickupContext(), runner = "Local") => ({
  id: 1,
  body: acknowledgment(context, runner).body,
  url: `${context.coordination_target.url}#issuecomment-1`,
  author: { login: "recorder" },
});

void test("requirements comparison ignores formatting, check marks and bare delivered links, not safety text", () => {
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

void test("requirement comparison preserves literal blank lines and boundary spaces", () => {
  for (const [before, after] of [
    ["```sh\na\n\nb\n```", "```sh\na\nb\n```"],
    ["    a\n\n    b", "    a\n    b"],
    ["    printf 'spaces'  ", "    printf 'spaces' "],
    ["Use `a\n\nb`", "Use `a\nb`"],
  ]) {
    const first = pickupContext(pickupIssue(1104, before));
    const second = pickupContext(pickupIssue(1104, after));
    assert.notEqual(first.observation_revision, second.observation_revision);
  }
});

void test("scope, planning, genuine prerequisites and organization are separate comparison facets", () => {
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

void test("snapshot validation rejects altered hashes, malformed identities and missing facets", () => {
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

void test("snapshot validation rejects coercible scalar identities even with a matching revision", () => {
  const original = pickupContext().snapshot;
  const mutations = [
    (value: typeof original) => {
      // @ts-expect-error Array-valued identity deliberately crosses the runtime boundary.
      value.repository = [value.repository];
    },
    (value: typeof original) => {
      // @ts-expect-error Array-valued URL deliberately crosses the runtime boundary.
      value.issue.url = [value.issue.url];
    },
    (value: typeof original) => {
      // @ts-expect-error Array-valued hash deliberately crosses the runtime boundary.
      value.scope_revision = [value.scope_revision];
    },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(original);
    mutate(value);
    const { revision: _previous, ...inputs } = value;
    value.revision = createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
    assert.throws(() => validateExecutionSnapshot(value), /invalid/);
  }
});

void test("context distinguishes bounded absence, actual API recorder, reported consumption and worker activity", () => {
  const first = pickupContext();
  assert.equal(first.pickup.current_requirements, "unknown");
  assert.equal(first.pickup.invoked, "unknown");
  const comment = acknowledgmentComment(first);
  const consumed = pickupContext(pickupIssue(), pickupRelations(), { comments: [comment] });
  assert.equal(consumed.pickup.current_requirements, "recorded consumed");
  assert.ok(consumed.pickup.last_record);
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

void test("exact older consumption reference is bound to configured repository, runner and task", () => {
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
        coordinationTarget(config, 1104),
      ),
    /this repository/,
  );
});

void test("structured queue preserves Planned recommendations without inferring a grant or execution route", () => {
  const planned = pickupIssue();
  const required = { ...pickupIssue(925), "release commitment": "Required" };
  const output = executionQueueData([planned, required]);
  assert.equal(output.candidates.length, 2);
  assert.equal(
    fixtureElement(output.candidates, 1).after,
    fixtureElement(output.candidates, 0).url,
  );
  assert.equal(fixtureElement(output.candidates, 0).reservation, "unknown");
  assert.equal(fixtureElement(output.candidates, 0).execution_capability, "not assessed");
});

void test("selected context collects typed relationships completely and matches opaque Project identity", () => {
  const connection = <T,>(nodes: T[], totalCount = nodes.length, hasNextPage = false) => ({
    nodes,
    totalCount,
    pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor" : null },
  });
  const projectItem = (id: string, project = "PVT-selected") => ({
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
    subIssues: connection<PickupItem["content"]>([]),
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
  assert.equal(fixtureElement(result.relationships.blockedBy, 0).projectStatus, "Ready");
  assert.equal(fixtureElement(result.relationships.blocking, 0).number, 925);
  issue.blockedBy = connection([]);
  issue.subIssues = connection([reference, reference]);
  client.graphql = () => ({ repository: { issue }, node: { subIssues: issue.subIssues } });
  assert.throws(() => client.executionIssue(1104), /duplicate/);
});

void test("acknowledgment history validates bounded coverage and refuses count changes", () => {
  const client = new RoadmapClient(config);
  const target = coordinationTarget(config, 1104);
  client.coordinationBinding = () => ({ number: 1104, comments: 100 });
  client.graphql = () => ({
    repository: {
      issue: {
        url: target.url,
        comments: { nodes: [], totalCount: 100, pageInfo: { hasPreviousPage: true } },
      },
    },
  });
  assert.throws(() => client.coordinationRecords(target), /incomplete/);
  const nodes = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    url: `${target.url}#issuecomment-${i + 1}`,
    body: "plain checkpoint",
    createdAt: "2026-10-06T12:00:00Z",
    updatedAt: "2026-10-06T12:00:00Z",
  }));
  client.graphql = () => ({
    repository: {
      issue: {
        url: target.url,
        comments: { nodes, totalCount: 100, pageInfo: { hasPreviousPage: true } },
      },
    },
  });
  assert.equal(client.coordinationRecords(target).coverage.complete, false);
  let reads = 0;
  client.coordinationBinding = () => ({ number: 1104, comments: ++reads === 1 ? 100 : 101 });
  assert.throws(() => client.coordinationRecords(target), /incomplete/);
});

void test("selected issue and explicit PR history routes bind work/repository", () => {
  const target = coordinationTarget(config, 1104, 1543);
  let node = {
    number: 1543,
    html_url: target.url,
    pull_request: { url: "bound" },
    comments: 2,
    body: "Refs #1104.",
  };
  const client = new RoadmapClient(config, () => JSON.stringify(node));
  assert.equal(client.coordinationBinding(target).number, 1543);
  for (const body of [
    "Refs #11040",
    "https://github.com/other/repo/issues/1104",
    "no work reference",
    `https://github.com/${config.repository}/issues/1104x`,
    `https://github.com/${config.repository}/issues/1104-not-the-issue`,
    `https://github.com/${config.repository}/issues/11040`,
  ]) {
    node = { ...node, body };
    assert.throws(() => client.coordinationBinding(target), /does not reference/);
  }
  for (const suffix of ["", ")", "#issuecomment-1", "?query=value"]) {
    node = {
      ...node,
      body: `[Owner](https://github.com/${config.repository}/issues/1104${suffix}`,
    };
    assert.equal(client.coordinationBinding(target).number, 1543);
  }
  node = { ...node, body: "Refs #1104", html_url: "https://github.com/other/repo/pull/1543" };
  assert.throws(() => client.coordinationBinding(target), /identity/);
  assert.throws(() => coordinationTarget(config, 793), /read-only/);
  assert.throws(() => coordinationTarget(config, 1104, 793), /read-only/);
});

void test("exact legacy refs are read-only comparison; other work refs and identity substitutions fail", () => {
  const target = coordinationTarget(config, 1104);
  const url = `https://github.com/${config.repository}/issues/793#issuecomment-1`;
  const requests: string[][] = [];
  let original = {
    html_url: url,
    issue_url: `https://api.github.com/repos/${config.repository}/issues/793`,
    body: acknowledgment().body,
  };
  const client = new RoadmapClient(config, (args) => {
    requests.push([fixtureElement(args, args.indexOf("--method") + 1), fixtureElement(args, 2)]);
    return JSON.stringify(original);
  });
  assert.equal(
    consumedReference(client.coordinationComment(url, target), {
      repository: config.repository,
      runner: "Local",
      issue: 1104,
    }).issue.number,
    1104,
  );
  assert.deepEqual(requests, [["GET", `repos/${config.repository}/issues/comments/1`]]);
  assert.throws(
    () =>
      client.coordinationComment(
        `https://github.com/${config.repository}/issues/209#issuecomment-1`,
        target,
      ),
    /selected issue/,
  );
  assert.throws(
    () =>
      consumedReference(client.coordinationComment(url, target), {
        repository: config.repository,
        runner: "Other",
        issue: 1104,
      }),
    /does not match/,
  );
  original = {
    ...original,
    issue_url: `https://api.github.com/repos/${config.repository}/issues/1104`,
  };
  assert.throws(() => client.coordinationComment(url, target), /identity/);
  const substituted = acknowledgmentComment(
    pickupContext(pickupIssue(), pickupRelations(), {
      target: coordinationTarget(config, 1104, 1543),
    }),
  );
  substituted.url = `${target.url}#issuecomment-1`;
  assert.throws(
    () =>
      consumedReference(substituted, {
        repository: config.repository,
        runner: "Local",
        issue: 1104,
        target,
      }),
    /bound issue\/PR/,
  );
});

void test("capability milestones preserve history and fail closed during partial migration", () => {
  const item = (
    number: number,
    target: string,
    status = "Done",
    commitment = "Required",
    state = "CLOSED",
    dependencies: number[] = [],
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
  // @ts-expect-error Missing release target intentionally exercises incomplete planning.
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

void test("checked-in configuration contains schema rather than volatile item state", () => {
  assert.doesNotThrow(() => validateConfig(config));
  const invalid = structuredClone(config);
  Object.assign(invalid.project, { items: [{ title: "mutable backlog" }] });
  assert.throws(() => validateConfig(invalid), /volatile planning data/);
});

void test("New Port form requires canonical identity input without a Project-token workflow", () => {
  assert.match(newPortForm, /id: port_key/);
  assert.match(newPortForm, /label: Durable game or target key/);
  assert.match(newPortForm, /lowercase kebab-case/);
  assert.match(newPortForm, /id: upstream[\s\S]*?required: true/);
  assert.doesNotMatch(newPortForm, /(?:PROJECT_TOKEN|personal access token)/i);
});

void test("argument parsing keeps positional item references and named values distinct", () => {
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

void test("catalog summary and release snapshot derive qualification data from catalog JSON", () => {
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

void test("release snapshots are cumulative and Project Status alone authorizes completion", () => {
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

void test("release readiness separates required, opportunistic, unclassified, and genuine blocking dependencies", () => {
  const issue = (
    number: number,
    title: string,
    fields: Record<string, string> = {},
    blockedBy: number[] = [],
    parent: number | null = null,
  ) => ({
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
  assert.deepEqual(
    analysis.effectiveRequired
      .map((item) => fixtureValue(item.content).number)
      .sort((left, right) =>
        String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
      ),
    [1, 2, 6],
  );
  assert.deepEqual(
    analysis.opportunistic
      .map((item) => fixtureValue(item.content).number)
      .sort((left, right) =>
        String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
      ),
    [3, 6],
  );
  assert.deepEqual(
    analysis.relevantUnclassified.map((item) => fixtureValue(item.content).number),
    [4],
  );
  assert.deepEqual(
    analysis.safetyConflicts.map((item) => fixtureValue(item.content).number),
    [6],
  );
  assert.equal(analysis.dependencyConflicts.length, 1);
  assert.equal(
    fixtureValue(fixtureElement(analysis.dependencyConflicts, 0).dependency.content).number,
    2,
  );
  assert.equal(
    analysis.effectiveRequired.some((item) => fixtureValue(item.content).number === 7),
    false,
  );
  assert.equal(
    analysis.effectiveRequired.some((item) => fixtureValue(item.content).number === 5),
    false,
  );
  assert.equal(analysis.ready, false);
});

void test("dependency analysis reports cycles and Project-missing blockers", () => {
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
  assert.equal(
    fixtureValue(fixtureElement(analysis.missingProjectDependencies, 0).dependency.content).number,
    99,
  );
  assert.equal(analysis.ready, false);
});

void test("readiness fails closed when a blocking-dependency page is truncated", () => {
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

void test("completion evidence excludes ordinary upstream URLs and accepts explicit or typed records", () => {
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

void test("snapshot output is confined to docs/releases", () => {
  assert.match(resolveSnapshotOutput("docs/releases/alpha.md"), /docs[\\/]releases[\\/]alpha\.md$/);
  assert.throws(() => resolveSnapshotOutput("docs/alpha.md"), /must be under docs\/releases/);
  assert.throws(() => resolveSnapshotOutput("../outside.md"), /must be under docs\/releases/);
});

void test("durable promotion rejects missing sections and accepts a complete specification", () => {
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

void test("feature intake accepts neutral and explicit planning fields", () => {
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

void test("one-port-one-issue coverage rejects missing duplicate grouped and draft authority", () => {
  const catalog = { ports: [{ id: "one" }, { id: "two" }] };
  const repositoryIssue = (number: number, id: string) => ({
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
  const projectItem = (issue: RoadmapIssueItem, workType = "Port") => ({
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

void test("intake permits integration completion without inventing gameplay qualification", () => {
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

void test("one-port-one-issue coverage requires unique candidate keys and allows shared upstream multi-game repositories", () => {
  const issue = (number: number, title: string, body: string) => ({
    number,
    title,
    type: "Issue",
    url: "https://github.com/boburning/portcove/issues/" + number,
    body,
  });
  const projectItem = (repositoryIssue: RoadmapIssueItem) => ({
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

void test("capture-port deduplication normalizes punctuation titles and combines upstream with game identity", () => {
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

void test("New Port form parsing requires a canonical key and direct https upstream", () => {
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

void test("marker reconciliation preserves form content and is repeatable", () => {
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
  assert.equal(fixtureValue(once.match(/<!-- portcove-port -->/g)).length, 1);
  assert.equal(fixtureValue(once.match(/<!-- portcove-upstream:/g)).length, 1);
  assert.equal(fixtureValue(once.match(/<!-- portcove-port-key:/g)).length, 1);
});

void test("doctor discovers unnormalized open [Port] issues but ignores ordinary body mentions", () => {
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

void test("deduplication sees punctuation-equivalent unnormalized form issues and permits distinct shared-upstream targets", () => {
  const formIssue = {
    number: 10,
    title: "[Port] Pokémon: Yellow!",
    state: "OPEN",
    url: "https://github.com/boburning/portcove/issues/10",
    body: `### Direct upstream URL\n\nhttps://github.com/example/shared\n\n### Durable game or target key\n\npokemon-yellow`,
  };
  assert.ok(
    fixtureElement(
      findPortIssueDuplicates([formIssue], {
        title: "Pokemon Yellow",
        upstream: "https://github.com/example/shared/",
        portKey: "pokemon-yellow",
      }),
      0,
    ).reasons.includes("normalized title pokemon-yellow"),
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

void test("Port stage validation is evidence-based and platform-scoped", () => {
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
  const item = (id: string, stage: string, blocker?: string) => ({
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
        ...(blocker === undefined ? {} : { blocker }),
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
  assert.match(fixtureElement(supported.diagnostics, 0), /qualified platforms = windows/);
  assert.ok(
    validatePortStageSemantics(catalog, [item("windows-qualified", "Cataloged")]).warnings.length >
      0,
  );
});

function qualificationScope(portId: string, platform = "windows") {
  return {
    port_id: portId,
    platform,
    artifact_sha256: "a".repeat(64),
    upstream_ref: "v1",
    contract_id: "fixture-contract",
    variant: {
      state: "exact",
      identity: {
        game_id: "fixture-game",
        variant_id: "retail",
        representation_id: "canonical",
      },
    },
    check_version: "fixture-v1",
  };
}

void test("Port stage validation consumes only passed exact qualification records", () => {
  const port = {
    id: "exact",
    platforms: ["windows", "linux"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
  };
  const record = (kind: string, outcome: string, platform = "windows") => ({
    scope: qualificationScope(port.id, platform),
    kind,
    outcome,
  });
  const item = (stage: string) => ({
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
    fixtureElement(validatePortStageSemantics(catalog, [item("Supported")]).diagnostics, 0),
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

void test("Supported requires complete matching exact scopes and separate legacy intersections", () => {
  const port = {
    id: "scoped",
    platforms: ["windows"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
  };
  const auto = {
    scope: qualificationScope(port.id),
    kind: "automated_lifecycle",
    outcome: "passed",
  };
  const hands = { ...structuredClone(auto), kind: "hands_on" };
  const item = {
    id: "scoped",
    title: "[Port] Scoped",
    "port stage": "Supported",
    content: {
      type: "Issue",
      number: 1,
      url: "https://github.com/boburning/portcove/issues/1",
      body: renderPortIssueBody({
        title: "Scoped",
        upstream: "https://example.test/scoped",
        catalogId: port.id,
      }),
    },
  };
  assert.deepEqual(qualifiedPlatforms(port, [auto, hands]), ["windows"]);
  for (const path of [
    ["port_id"],
    ["platform"],
    ["artifact_sha256"],
    ["upstream_ref"],
    ["contract_id"],
    ["variant", "identity", "game_id"],
    ["variant", "identity", "variant_id"],
    ["variant", "identity", "representation_id"],
    ["check_version"],
  ]) {
    const changed = structuredClone(hands);
    const parent = fixtureObject(
      path.slice(0, -1).reduce<unknown>((value, key) => fixtureObject(value)[key], changed.scope),
    );
    const key = path.at(-1);
    assert.ok(key);
    const previous = parent[key];
    assert.ok(typeof previous === "string");
    parent[key] = key === "artifact_sha256" ? "b".repeat(64) : `${previous}-different`;
    const records = [auto, changed];
    assert.deepEqual(qualifiedPlatforms(port, records), [], path.join("."));
    const result = validatePortStageSemantics(
      { ports: [port], source_catalog: { qualification: records } },
      [item],
    );
    assert.ok(
      result.errors.some((error) => error.includes("no platform with matching")),
      path.join("."),
    );
    assert.deepEqual(
      planPortStageReconciliation({ ports: [port], source_catalog: { qualification: records } }, [
        item,
      ]).map((change) => change.to),
      ["Automated qualification"],
    );
  }
  for (const path of [
    ["artifact_sha256"],
    ["upstream_ref"],
    ["contract_id"],
    ["check_version"],
    ["variant"],
    ["variant", "identity", "game_id"],
    ["variant", "identity", "variant_id"],
    ["variant", "identity", "representation_id"],
  ]) {
    const incomplete = structuredClone(hands);
    const parent = fixtureObject(
      path
        .slice(0, -1)
        .reduce<unknown>((value, key) => fixtureObject(value)[key], incomplete.scope),
    );
    const key = path.at(-1);
    assert.ok(key);
    delete parent[key];
    assert.deepEqual(qualifiedPlatforms(port, [auto, incomplete]), [], path.join("."));
    const incompleteAuto = { ...incomplete, kind: "automated_lifecycle" };
    assert.deepEqual(qualifiedPlatforms(port, [incompleteAuto, incomplete]), [], path.join("."));
  }
  const unknown = {
    ...structuredClone(hands),
    scope: { ...hands.scope, variant: { state: "unknown" } },
  };
  assert.deepEqual(qualifiedPlatforms(port, [auto, unknown]), []);
  for (const digest of [["a".repeat(64)], 42, {}]) {
    const malformedAuto = {
      ...structuredClone(auto),
      scope: { ...auto.scope, artifact_sha256: digest },
    };
    const malformedHands = { ...structuredClone(malformedAuto), kind: "hands_on" };
    assert.deepEqual(qualifiedPlatforms(port, [malformedAuto, malformedHands]), []);
    const malformedCatalog = {
      ports: [port],
      source_catalog: {
        qualification: [malformedAuto, malformedHands],
      },
    };
    assert.ok(
      validatePortStageSemantics(malformedCatalog, [
        { ...item, "port stage": "Automated qualification" },
      ]).errors.some((error) => error.includes("no automated evidence")),
    );
  }
  const failed = { ...hands, outcome: "failed" };
  assert.deepEqual(qualifiedPlatforms(port, [auto, failed]), []);
  const legacyAuto = { ...port, automated_tested_platforms: ["windows"] };
  const legacyHands = { ...port, manually_validated_platforms: ["windows"] };
  assert.deepEqual(qualifiedPlatforms(legacyAuto, [hands]), []);
  assert.deepEqual(qualifiedPlatforms(legacyHands, [auto]), []);
  assert.deepEqual(
    qualifiedPlatforms({ ...legacyAuto, manually_validated_platforms: ["windows"] }, []),
    ["windows"],
  );
  assert.deepEqual(qualifiedPlatforms(port, [hands, auto, hands]), ["windows"]);
});

void test("Port stage validation rejects broken manual evidence non-catalog overclaim and unsupported rejection", () => {
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

void test("Supported reconciliation only downgrades overstatement and becomes idempotent after application", () => {
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
  const item = (id: string) => ({
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
    fixtureFind(items, (candidate) => candidate.id === change.itemId)["port stage"] = change.to;
  assert.deepEqual(planPortStageReconciliation(catalog, items), []);
});

void test("Supported reconciliation planning uses exact automated and hands-on records", () => {
  const ports = ["none", "auto", "qualified"].map((id) => ({
    id,
    platforms: ["windows"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
  }));
  const qualification = [
    {
      scope: qualificationScope("auto"),
      kind: "automated_lifecycle",
      outcome: "passed",
    },
    {
      scope: qualificationScope("qualified"),
      kind: "automated_lifecycle",
      outcome: "passed",
    },
    {
      scope: qualificationScope("qualified"),
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

void test("normalization initializes only unset neutral fields and always classifies Work type as Port", () => {
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

void test("final UX audit origins require complete unique enumerated canonical ownership", () => {
  assert.equal(uxAuditOriginIds.length, 178);
  const completeBody = "<!-- portcove-ux-audit-origins: " + uxAuditOriginIds.join(" ") + " -->";
  const item = (number: number, body: string) => ({
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
  ] as const) {
    assert.ok(
      validateUxAuditOriginCoverage([item(1, body)]).some((value) => value.includes(expected)),
    );
  }
});

void test("supported-source plan origin has exactly one canonical owner", () => {
  const marker = "<!-- portcove-origins: PCV-PLAN-SUPPORTED-SOURCE-PROVENANCE-2026-09-04 -->";
  const item = (number: number, body: string) => ({
    title: "Owner " + number,
    content: {
      type: "Issue",
      url: "https://github.com/boburning/portcove/issues/" + number,
      body,
    },
  });
  assert.deepEqual(validatePlanOriginCoverage([item(36, marker)]), []);
  assert.ok(fixtureElement(validatePlanOriginCoverage([]), 0).includes("found 0"));
  assert.ok(
    fixtureElement(validatePlanOriginCoverage([item(36, marker), item(99, marker)]), 0).includes(
      "found 2",
    ),
  );
  assert.ok(
    fixtureElement(validatePlanOriginCoverage([item(99, marker)]), 0).includes(
      "must be owned by issue #36",
    ),
  );
});

void test("RoadmapClient capture uses mocked gh output and stores planning fields only in Project calls", () => {
  const calls: RunnerCall[] = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    if (args[1] === "item-create") return JSON.stringify({ id: "PVTI_draft", title: "Candidate" });
    const project = fixtureProjectDetails(args, input, "PVT_project", 7);
    if (project !== undefined) return project;
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
  const variables = fixtureGraphql(edit?.input).variables;
  assert.deepEqual(
    Object.values(variables).map((value) => {
      const input = fixtureSelectInput(value);
      return [input.fieldId, input.value.singleSelectOptionId];
    }),
    [
      ["PVTSSF_status", "OPT_inbox"],
      ["PVTSSF_priority", "OPT_none"],
    ],
  );
});

void test("capture-port creates one Project-backed issue without depending on parent capacity", () => {
  const calls: RunnerCall[] = [];
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
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "api" && args[2] === "repos/boburning/portcove/issues")
      return JSON.stringify({
        node_id: "I_new",
        html_url: "https://github.com/boburning/portcove/issues/88",
        number: 88,
      });
    const project = fixtureProjectDetails(args, input, "PVT_project", 7);
    if (project !== undefined) return project;
    if (args[0] === "project" && args[1] === "field-list")
      return JSON.stringify({
        fields: Object.entries(expectedFields).map(([name, value], index) => ({
          id: `F${index}`,
          name,
          options: [{ id: `O${index}`, name: value }],
        })),
      });
    if (args[0] === "api" && args[1] === "graphql") {
      assert.doesNotMatch(
        fixtureValue(input),
        /issue\(number: 16\)|\bparent\s*\{|addSubIssue|removeSubIssue/,
      );
      if (fixtureValue(input).includes("issues(first: 100"))
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
      if (fixtureValue(input).includes("addProjectV2ItemById"))
        return JSON.stringify({
          data: { addProjectV2ItemById: { item: { id: "PVTI_new" } } },
        });
      return JSON.stringify({
        data: {
          node: {
            projectItems: {
              totalCount: 0,
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
  client.repositoryIssues = () => fixtureIssueInventory(client, []);
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
    Object.values(fixtureGraphql(fieldEdit?.input).variables).some((value) => {
      const input = fixtureSelectInput(value);
      return input.fieldId === "F6" && input.value.singleSelectOptionId === "O6";
    }),
  );
  assert.equal(calls.filter((call) => call.input?.includes("addProjectV2ItemById")).length, 1);
});

for (const parentNumber of [null, 16, 777]) {
  void test(`normalize-port preserves planning and parent ${parentNumber ?? "absence"} idempotently`, () => {
    const calls: RunnerCall[] = [];
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
    const runner: GitHubRunner = (args, input) => {
      calls.push({ args, input });
      if (
        args[0] === "api" &&
        args[2] === "repos/boburning/portcove/issues/42" &&
        args.includes("PATCH")
      ) {
        const payload = fixtureJsonObject(input);
        assert.ok(typeof payload.body === "string");
        body = payload.body;
        return JSON.stringify(issue());
      }
      if (args[0] === "api" && args[2] === "repos/boburning/portcove/issues/42")
        return JSON.stringify(issue());
      const project = fixtureProjectDetails(args, input, "PVT_project", 7);
      if (project !== undefined) return project;
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
        assert.doesNotMatch(
          fixtureValue(input),
          /issue\(number: 16\)|\bparent\s*\{|addSubIssue|removeSubIssue/,
        );
        if (fixtureValue(input).includes("issues(first: 100"))
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
        if (fixtureValue(input).includes("items(first: 50"))
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
                        id: "I_42",
                        updatedAt: "2026-10-17T00:00:00Z",
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
        if (fixtureValue(input).includes("updateProjectV2ItemFieldValue")) {
          workType = "Port";
          return JSON.stringify({
            data: { f0: { projectV2Item: { id: "PVTI_form" } } },
          });
        }
      }
      return "";
    };
    const client = new RoadmapClient(mockedConfig, runner);
    client.repositoryIssues = () =>
      fixtureIssueInventory(client, [{ ...issue(), type: "Issue", url: issue().html_url }]);
    const catalog = { ports: [] };
    const readInventory = client.readInventory.bind(client);
    client.readInventory = (query, variables, select, identity) =>
      query.includes("projectItems(")
        ? [{ id: "PVTI_form", isArchived: false, project: { id: "PVT_project" } }]
        : readInventory(query, variables, select, identity);
    client.directProjectItem = () => ({
      id: "PVTI_form",
      content: { ...issue(), type: "Issue", url: issue().html_url },
      fieldValues: fieldValues(),
    });
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

function included(body: unknown, headers: Readonly<Record<string, string>> = {}) {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `HTTP/2.0 200 OK\r\n${lines.join("\r\n")}\r\n\r\n${JSON.stringify(body)}`;
}

function restIssue(number: number, overrides: Readonly<Record<string, unknown>> = {}) {
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

function issueConnectionResponse(
  input: string | undefined,
  numbers: number[],
  total = numbers.length,
  modify?: (repository: Record<string, unknown>) => void,
) {
  const { query } = fixtureGraphql(input);
  const marker = query.includes("RepositoryIssueMarker");
  const nodes = numbers.map((number) => ({
    id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    body: "",
    url: `https://github.com/boburning/portcove/issues/${number}`,
    state: "OPEN",
    updatedAt: "2026-10-17T00:00:00Z",
  }));
  const repository = {
    id: "R_repository",
    nameWithOwner: config.repository,
    issues: {
      totalCount: total,
      nodes: marker ? nodes.slice(-1) : nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  modify?.(repository);
  return included({ data: { repository } });
}

void test("doctor requires count-verified inventory even when truncated REST includes its marker", () => {
  let restReads = 0;
  const client = new RoadmapClient(config, (args, input) => {
    if (args[1] === "graphql") return issueConnectionResponse(input, [1, 2, 3]);
    restReads++;
    return included([restIssue(3)]);
  });
  const result = readDoctorRepositoryIssues(client);
  assert.deepEqual(
    result.issues.map((issue) => issue.number),
    [1, 2, 3],
  );
  assert.equal(restReads, 0);
  assert.deepEqual(
    result.attempts.map(({ evidence: _evidence, ...attempt }) => attempt),
    [{ attempt: 1, source: "graphql", outcome: "passed", issues: 3 }],
  );
});

void test("doctor retains a failed GraphQL observation without a retry", () => {
  let requests = 0;
  const attempts: Parameters<typeof readDoctorRepositoryIssues>[1] = [];
  const client = new RoadmapClient(config, () => {
    requests++;
    throw new Error("transport unavailable");
  });
  assert.throws(() => readDoctorRepositoryIssues(client, attempts), /transport unavailable/);
  assert.equal(requests, 1);
  assert.equal(attempts.length, 1);
  assert.equal(fixtureValue(attempts[0]).source, "graphql");
  assert.equal(fixtureValue(attempts[0]).outcome, "failed");
});

void test("doctor records one complete empty GraphQL observation", () => {
  const client = new RoadmapClient(config, (_args, input) => issueConnectionResponse(input, []));
  const result = readDoctorRepositoryIssues(client);
  assert.deepEqual(result.issues, []);
  assert.equal(result.attempts[0]?.issues, 0);
});

void test("runDoctor retains an incomplete GraphQL observation for its CLI receipt", async () => {
  let traversals = 0;
  const client = new RoadmapClient(config, (args, input) => {
    assert.equal(args[1], "graphql");
    if (fixtureGraphql(input).query.includes("RepositoryIssueInventory")) traversals++;
    return issueConnectionResponse(input, [1], 3);
  });
  const attempts: Parameters<typeof readDoctorRepositoryIssues>[1] = [];
  await assert.rejects(
    runDoctor(
      config,
      Object.assign(client, {
        gh: () => "",
        completeProjectContext: () => ({ details: { id: "P" }, fields: [] }),
        viewList: () => [],
        projectAudit: () => ({
          id: "P",
          updatedAt: "2026-10-22T00:00:00Z",
          items: { totalCount: 0 },
          repositories: { nodes: [] },
        }),
        itemList: () => [],
      }),
      { quiet: true, repositoryIssueInventoryAttempts: attempts },
    ),
    /record count does not match total/,
  );
  assert.equal(traversals, 1);
  assert.deepEqual(
    attempts.map((entry) => entry.outcome),
    ["failed"],
  );
  assert.equal(fixtureValue(attempts[0]).source, "graphql");
});
void test("GraphQL repository inventory reads all pages and binds the repository and latest issue", () => {
  const cursors: unknown[] = [];
  const client = new RoadmapClient(config, (_args, input) => {
    const { query, variables } = fixtureGraphql(input);
    if (query.includes("RepositoryIssueMarker")) return issueConnectionResponse(input, [1, 2], 2);
    cursors.push(variables.after);
    return issueConnectionResponse(input, variables.after === null ? [1] : [2], 2, (repository) => {
      if (variables.after === null)
        fixtureObject(repository.issues).pageInfo = { hasNextPage: true, endCursor: "second" };
    });
  });
  assert.deepEqual(
    client.repositoryIssues().issues.map((issue) => issue.number),
    [1, 2],
  );
  assert.deepEqual(cursors, [null, "second"]);
  const empty = new RoadmapClient(config, (_args, input) => issueConnectionResponse(input, []));
  assert.deepEqual(empty.repositoryIssues().issues, []);
});

void test("GraphQL repository inventory rejects incomplete malformed duplicate and foreign inventories", () => {
  const corruptions: ((repository: Record<string, unknown>, marker: boolean) => void)[] = [
    (repository) => {
      repository.id = "";
    },
    (repository) => {
      repository.nameWithOwner = "foreign/repository";
    },
    (repository, marker) => {
      if (!marker) repository.id = "R_changed";
    },
    (repository, marker) => {
      if (!marker) fixtureObject(repository.issues).totalCount = 3;
    },
    (repository, marker) => {
      if (!marker) fixtureObject(repository.issues).nodes = [];
    },
    (repository, marker) => {
      if (!marker) fixtureObject(repository.issues).pageInfo = {};
    },
    (repository, marker) => {
      if (!marker)
        fixtureObject(repository.issues).pageInfo = { hasNextPage: true, endCursor: "stalled" };
    },
    (repository, marker) => {
      if (!marker) {
        const nodes = fixtureObject(repository.issues).nodes;
        assert.ok(Array.isArray(nodes));
        fixtureObject(nodes[1]).id = fixtureObject(nodes[0]).id;
      }
    },
    (repository, marker) => {
      if (!marker) {
        const nodes = fixtureObject(repository.issues).nodes;
        assert.ok(Array.isArray(nodes));
        fixtureObject(nodes[0]).number = 2;
        fixtureObject(nodes[0]).url = "https://github.com/boburning/portcove/issues/2";
      }
    },
    (repository, marker) => {
      if (!marker) {
        const nodes = fixtureObject(repository.issues).nodes;
        assert.ok(Array.isArray(nodes));
        fixtureObject(nodes[0]).url = "https://github.com/foreign/repository/issues/1";
      }
    },
    (repository, marker) => {
      if (marker) fixtureObject(repository.issues).nodes = [{}];
    },
  ];
  for (const corrupt of corruptions) {
    const client = new RoadmapClient(config, (_args, input) =>
      issueConnectionResponse(input, [1, 2], 2, (repository) =>
        corrupt(repository, fixtureGraphql(input).query.includes("RepositoryIssueMarker")),
      ),
    );
    assert.throws(() => client.repositoryIssues(), /inventory|pagination/);
  }
});

void test("GraphQL repository inventory rejects changed totals or latest identities at final readback", () => {
  for (const change of ["total", "identity"]) {
    let markers = 0;
    const client = new RoadmapClient(config, (_args, input) => {
      const marker = fixtureGraphql(input).query.includes("RepositoryIssueMarker");
      if (marker) markers++;
      return issueConnectionResponse(input, [1, 2], 2, (repository) => {
        if (marker && markers === 2) {
          const connection = fixtureObject(repository.issues);
          if (change === "total") connection.totalCount = 3;
          else connection.nodes = [{ id: "I_replaced", number: 2 }];
        }
      });
    });
    assert.throws(() => client.repositoryIssues(), /inventory changed/);
  }
});

void test("GraphQL repository markers reject null IDs for a nonempty inventory", () => {
  const client = new RoadmapClient(config, (_args, input) =>
    issueConnectionResponse(input, [1, 2], 2, (repository) => {
      if (fixtureGraphql(input).query.includes("RepositoryIssueMarker"))
        fixtureObject(repository.issues).nodes = [{ id: null, number: 3 }];
    }),
  );
  assert.throws(() => client.repositoryIssues(), /invalid repository issue marker/);
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

void test("Project membership refuses malformed or stalled coverage before mutation", () => {
  const cases = [
    () => ({ totalCount: 0, nodes: [], pageInfo: {} }),
    () => ({ totalCount: 1, nodes: [], pageInfo: { hasNextPage: true, endCursor: "" } }),
    (read: number) => ({
      totalCount: 4,
      nodes: [{ id: `I_${read}`, project: { id: "OTHER" } }],
      pageInfo: { hasNextPage: true, endCursor: "repeated" },
    }),
  ];
  for (const page of cases) {
    let reads = 0,
      mutations = 0;
    const client = new RoadmapClient(config, (args, input) => {
      const project = fixtureProjectDetails(args, input, "P_selected");
      if (project !== undefined) return project;
      if (args[0] === "project" && args[1] === "field-list") return JSON.stringify({ fields: [] });
      if (input?.includes("addProjectV2ItemById")) {
        mutations++;
        return JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "I_new" } } } });
      }
      assert.ok(++reads <= 3, "fixture read budget exceeded");
      return JSON.stringify({ data: { node: { projectItems: page(reads) } } });
    });
    assert.throws(() => client.ensureIssueItem("I_source"), /incomplete GitHub inventory/);
    assert.equal(mutations, 0);
  }
});

void test("RoadmapClient reuses an existing issue item instead of duplicating it", () => {
  const calls: RunnerCall[] = [];
  const mockedConfig = structuredClone(config);
  mockedConfig.project.number = 7;
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    const project = fixtureProjectDetails(args, input, "PVT_project", 7);
    if (project !== undefined) return project;
    if (args[1] === "field-list") return JSON.stringify({ fields: [] });
    if (args[0] === "api" && args[1] === "graphql") {
      const after = fixtureGraphql(input).variables.after;
      return JSON.stringify({
        data: {
          node: {
            projectItems: after
              ? {
                  totalCount: 2,
                  nodes: [{ id: "PVTI_existing", project: { id: "PVT_project" } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                }
              : {
                  totalCount: 2,
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

type ViewInventoryFixture = {
  id: string;
  views: {
    totalCount: number;
    nodes: ReturnType<typeof completeView>[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};
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

void test("coordination history rejects coerced creation and edit timestamps", () => {
  const client = new RoadmapClient(config, () => assert.fail("unexpected API call"));
  const target = coordinationTarget(config, 1104);
  client.coordinationBinding = () => ({ number: target.number, comments: 1 });
  for (const field of ["createdAt", "updatedAt"]) {
    for (const timestamp of [0, ["2026-10-07T03:00:00Z"]]) {
      const record = {
        id: "IC_1",
        url: `${target.url}#issuecomment-1`,
        body: "retained",
        createdAt: "2026-10-07T03:00:00Z",
        updatedAt: "2026-10-07T03:00:00Z",
        [field]: timestamp,
      };
      client.graphql = () => ({
        repository: {
          issue: {
            url: target.url,
            comments: {
              totalCount: 1,
              nodes: [record],
              pageInfo: { hasPreviousPage: false },
            },
          },
        },
      });
      assert.throws(() => client.coordinationRecords(target), /unavailable or incomplete/);
    }
  }
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

void test("display outcome markers and release views cannot change gate or execution membership", () => {
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
  const summarize = (record: RoadmapIssueItem) => {
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
  assert.match(fixtureValue(byName.get("Product Outcomes")).filter, /label:roadmap-outcome/);
  assert.doesNotMatch(fixtureValue(byName.get("Product Outcomes")).filter, /-status:Done/);
  assert.match(fixtureValue(byName.get("In Progress")).filter, /status:/);
  assert.doesNotMatch(fixtureValue(byName.get("In Progress")).filter, /horizon:/);
  assert.equal(fixtureValue(byName.get("Port Pipeline")).filter, "work-type:Port");
  assert.match(fixtureValue(byName.get("Required for Beta")).filter, /release-commitment:Required/);
  assert.match(fixtureValue(byName.get("Planned Additions")).filter, /release-commitment:Planned/);
});

void test("complete Project context reads every field page with opaque identity checks", () => {
  const calls: RunnerCall[] = [];
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    if (args[2] === "users/boburning") return JSON.stringify({ type: "User" });
    const request = fixtureGraphql(input);
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

void test("GraphQL Project item pagination reads every item with normalized fields", () => {
  const calls: RunnerCall[] = [];
  const runner: GitHubRunner = (args, input) => {
    calls.push({ args, input });
    const project = fixtureProjectDetails(args, input, "PVT");
    if (project !== undefined) return project;
    const after = fixtureGraphql(input).variables.after;
    const item = after
      ? {
          id: "I2",
          content: {
            __typename: "DraftIssue",
            id: "DI_second",
            updatedAt: "2026-10-17T00:00:00Z",
            body: "Draft",
            title: "Second",
          },
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
            id: "I_1",
            updatedAt: "2026-10-17T00:00:00Z",
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
  assert.equal(calls.filter((call) => call.input?.includes("items(first: 50")).length, 2);
});

void test("Project item inventory rejects a truncated nested field connection", () => {
  const runner: GitHubRunner = (args, input) => {
    const project = fixtureProjectDetails(args, input, "PVT");
    if (project !== undefined) return project;
    return JSON.stringify({
      data: {
        node: {
          items: {
            totalCount: 1,
            nodes: [
              {
                id: "I1",
                content: {
                  __typename: "DraftIssue",
                  id: "DI_1",
                  title: "Draft",
                  body: "",
                  updatedAt: "2026-10-17T00:00:00Z",
                },
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

void test("the Project reader preserves full bodies and all pages above the ordinary transport limit", () => {
  const node = (number: number) => ({
    id: `PVTI_${number}`,
    content: {
      __typename: "Issue",
      id: `I_${number}`,
      title: "Fixture",
      url: `https://github.com/boburning/portcove/issues/${number}`,
      state: "OPEN",
      updatedAt: "2026-10-17T00:00:00Z",
      number,
      body: "x".repeat(22000),
    },
    fieldValues: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  });
  const first = Array.from({ length: 50 }, (_, i) => node(i + 1));
  const last = [node(51)];
  for (const failedLastPage of [false, true]) {
    const cursors: unknown[] = [];
    const bytes: number[] = [];
    const run = createGitHubRunner({
      spawn: (_command, args, options) => {
        assert.equal(args[0], "api");
        const request = fixtureGraphql(options.input);
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
    assert.ok(fixtureElement(bytes, 0) > 1024 * 1024);
    assert.equal(first.length, 50);
    assert.equal(fixtureElement(first, 0).content.body.length, 22000);
  }
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

void test("GraphQL failures retain provider quota and reset evidence", () => {
  const runner: GitHubRunner = () =>
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
  const node = (value: number) => ({
    id: `PVTI_${value}`,
    content: {
      __typename: "DraftIssue",
      id: `DI_${value}`,
      title: "Draft",
      body: "",
      updatedAt: "2026-10-17T00:00:00Z",
    },
    fieldValues: {
      totalCount: 0,
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  const page = (numbers: readonly number[], totalCount: number, cursor: string | null = null) => ({
    nodes: numbers.map(node),
    totalCount,
    pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
  });
  function readPages(pages: readonly unknown[]) {
    let index = 0;
    const client = new RoadmapClient(config, (args, input) => {
      const project = fixtureProjectDetails(args, input, "PVT");
      if (project !== undefined) return project;
      assert.match(fixtureGraphql(input).query, /totalCount/);
      const current = pages[index++];
      if (current instanceof Error) throw current;
      assert.ok(index <= pages.length, "reader must stop before exhausting the fixture");
      return JSON.stringify({ data: { node: { items: current } } });
    });
    return client.itemList(1);
  }

  void test(`${kind} inventory accepts an empty connection`, () => {
    assert.deepEqual(readPages([page([], 0)]), []);
  });
  void test(`${kind} inventory accepts an exact page boundary`, () => {
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
  const failures: readonly (readonly [string, readonly unknown[]])[] = [
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
    void test(`${kind} inventory rejects ${reason}`, () => {
      assert.throws(() => readPages(pages), /inventory|API unavailable/);
    });
  }
}

void test("Planned and historical non-gating work share execution without changing Required readiness", () => {
  const make = (n: number, commitment: string | null, status = "Ready", deps: number[] = []) => ({
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
    analyzeReleaseReadiness(items, "Public beta").planned.map(
      (i) => fixtureValue(i.content).number,
    ),
    [2, 3, 4],
  );
  assert.deepEqual(
    selectNextItems(items).map((i) => fixtureValue(i.content).number),
    [2, 3],
  );
  const text = renderExecutionQueue(items);
  assert.match(text, /Planned/);
  assert.match(text, /after: https:\/\/example.test\/2/);
  assert.equal(analyzeReleaseReadiness(items, "Public beta").effectiveRequired.length, 1);
  fixtureElement(items, 0).content.blockedBy = { totalCount: 1, nodes: [{ number: 2 }] };
  const gates = analyzeReleaseReadiness(items, "Public beta");
  assert.equal(gates.ready, false);
  assert.equal(gates.dependencyConflicts.length, 1);
  assert.equal(gates.effectiveRequired.length, 2);
  fixtureElement(items, 0).content.blockedBy = { totalCount: 0, nodes: [] };
  Object.assign(fixtureElement(items, 0).content, { parent: { number: 2 } });
  assert.equal(analyzeReleaseReadiness(items, "Public beta").ready, true);
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

void test("queue displays incomplete dependency coverage instead of an empty prerequisite claim", () => {
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

void test("explicit pickup references preserve independent local worker evidence", () => {
  const reservation = { url: "https://github.com/boburning/portcove/issues/244#issuecomment-1" };
  for (const runner of ["local-a", "local-b"]) {
    const context = deriveExecutionContext(config, pickupIssue(244), pickupRelations(), {
      runner,
      comments: [],
      coverage: { complete: false },
      reservation,
    });
    assert.match(context.reservation.assessment, /actual writer activity, source-owner release/);
    assert.equal(fixtureObject(context.reservation).url, reservation.url);
    assert.equal(context.pickup.reported_runner, runner);
  }
  for (const command of ["handoff-offer", "handoff-return", "acknowledge"])
    assert.throws(() => roadmapCommandHelp(command, config), /unknown/);
});

void test("set help renders every configured field option without live access", async () => {
  const config = validateConfig(
    JSON.parse(await readFile(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
  );
  const help = roadmapCommandHelp("set", config);
  assert.match(help, /--type:/);
  assert.match(help, /--status: Inbox/);
  for (const name of ["Status", "Work type", "Effort"])
    for (const value of fixtureValue(
      fixtureFind(config.fields, (field) => field.name === name).options,
    ))
      assert(help.includes(value));
  assert.match(roadmapCommandHelp("doctor", config), /--summary/);
  assert.throws(() => roadmapCommandHelp("unknown", config), /unknown/);
});

void test("the finite Roadmap command inventory has purpose, Usage and examples", () => {
  assert.match(roadmapHelp, /^Read and reconcile/u);
  assert.match(roadmapHelp, /\nUsage:\n/u);
  assert.match(roadmapHelp, /incomplete reads fail/u);
  const commands = [...roadmapHelp.matchAll(/^  node scripts\/roadmap\.mts ([a-z-]+)(?: |$)/gmu)]
    .map((match) => fixtureValue(match[1]))
    .filter((command) => command !== "--help");
  for (const command of new Set(commands)) {
    const help = roadmapCommandHelp(command, config);
    assert.match(help, /^Usage: node scripts\/roadmap\.mts /u);
    assert.match(help, /--help prints help without contacting GitHub/u);
    assert.match(help, /Example:\n  node scripts\/roadmap\.mts /u);
  }
  assert.match(roadmapCommandHelp("set", config), /--status 'In progress'/u);
  assert.match(roadmapCommandHelp("bootstrap"), /changes require the Project UI/u);
});

void test("offline Roadmap success separates configuration from the absence of a repository backlog", () => {
  const result = spawnSync(process.execPath, ["scripts/roadmap.mts", "check"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, PATH: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Roadmap configuration is valid[^\n]+\.\nNo mutable roadmap items are stored in the repository\.\n/u,
  );
  assert.doesNotMatch(result.stdout, /Project.*verified|Grouping.*read back/iu);
});

void test("Roadmap command help is available without the GitHub executable or operation lock", () => {
  for (const command of ["set", "capture-feature", "doctor", "context"]) {
    const result = spawnSync(process.execPath, ["scripts/roadmap.mts", command, "--help"], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, PATH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage:/u);
    assert.match(result.stdout, /Example:/u);
    assert.match(result.stdout, new RegExp(command));
    assert.equal(result.stderr, "");
  }
  const result = spawnSync(
    process.execPath,
    ["scripts/roadmap.mts", "doctor", "--summary", "--json"],
    { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: "" } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mutually exclusive/);
});

{
  const approval: unknown = JSON.parse(
    readFileSync(new URL("../.github/linux-beta-risk-706.json", import.meta.url), "utf8"),
  );
  validateApproval706(approval, "2026-10-15T01:21:44.000Z");
  assert.ok(
    typeof approval.reconfirmedHead === "string" && typeof approval.policySha256 === "string",
  );
  const canonicalApproval = {
    ...approval,
    reconfirmedHead: approval.reconfirmedHead,
    policySha256: approval.policySha256,
  };
  const now = "2026-10-16T00:00:00.000Z";
  const item = (n: number, deps: number[] = []) => ({
    id: `i${n}`,
    title: `Remediation ${n}`,
    status: "Blocked",
    platform: "Linux",
    "work type": "Security",
    "target release": "Public beta",
    "release commitment": "Planned",
    content: {
      number: n,
      state: "OPEN",
      url: `https://github.com/boburning/portcove/issues/${n}`,
      blockedBy: { totalCount: deps.length, nodes: deps.map((number) => ({ number })) },
    },
  });
  const items = () => [item(49, [706]), item(706)];
  function evidence() {
    const policy = { ...canonicalApproval, firstPublicationTag: "v0.1.0-beta.1" };
    const candidate = {
      head: "a".repeat(40),
      lockSha256: "b".repeat(64),
      target: "x86_64-unknown-linux-gnu",
      features: ["default", "tauri/custom-protocol"],
      productionChanges: "",
      reviewedHead: policy.reconfirmedHead,
    };
    const diagnostic = {
      type: "diagnostic",
      fields: {
        severity: "error",
        code: "unsound",
        advisory: { id: policy.advisory, package: "glib" },
        labels: [{ span: "glib 0.18.5 registry+https://github.com/rust-lang/crates.io-index" }],
      },
    };
    const summary = Object.fromEntries(
      ["advisories", "bans", "licenses", "sources"].map((g) => [
        g,
        { errors: g === "advisories" ? 1 : 0, warnings: 0, notes: 0, helps: 0 },
      ]),
    );
    return {
      risk706Approval: policy,
      now,
      risk706Evidence: {
        approval: policy,
        candidate,
        scan: {
          head: candidate.head,
          lockSha256: candidate.lockSha256,
          completedAt: now,
          complete: true,
          signal: null,
          error: null,
          exitCode: 1,
          unsoundAll: true,
          configSha256: policy.policySha256,
          sourceConfigSha256: policy.policySha256,
          sourceConfig: readFileSync(new URL("../deny.toml", import.meta.url), "utf8"),
          executionConfig: readFileSync(new URL("../deny.toml", import.meta.url), "utf8"),
          toolVersion: "cargo-deny 0.20.2",
          scope: "workspace-default-all-targets-all-checks",
          stdout: "",
          stderr: [diagnostic, { type: "summary", fields: summary }]
            .map((value) => JSON.stringify(value))
            .join("\n"),
        },
        releases: [],
        purpose: "release",
        publicationTag: policy.firstPublicationTag,
      },
    };
  }
  void test("approved remediation planning is valid but never establishes release eligibility", () => {
    assert.deepEqual(
      parseArguments(["readiness", "--release", "Public beta", "--linux-beta-706"]),
      {
        command: "readiness",
        positionals: [],
        options: { "--release": "Public beta", "--linux-beta-706": true },
      },
    );
    const result = analyzeReleaseReadiness(items(), "Public beta", { now });
    assert.equal(result.safetyConflicts.length, 0);
    assert.equal(result.dependencyConflicts.length, 0);
    assert.equal(result.pendingRiskDispositions.length, 2);
    assert.equal(result.ready, false);
    assert.match(renderReadinessSummary(result), /Pending:.*actual candidate/);
    const expired = analyzeReleaseReadiness(items(), "Public beta", {
      now: "2026-11-15T04:59:00.000Z",
    });
    assert.equal(expired.safetyConflicts.length, 0);
    assert.equal(expired.ready, false);
    assert.equal(expired.pendingRiskDispositions.length, 2);
    const expiredRelease = evidence();
    expiredRelease.now = "2026-11-15T04:59:00.000Z";
    assert.throws(
      () => analyzeReleaseReadiness(items(), "Public beta", expiredRelease),
      /not valid/,
    );

    for (const options of [{ now, risk706Approval: null }]) {
      assert.equal(
        analyzeReleaseReadiness(items(), "Public beta", options).safetyConflicts.length,
        2,
      );
    }
  });
  void test("only a fully revalidated release candidate can satisfy the scoped pending nodes", () => {
    const options = evidence();
    const result = analyzeReleaseReadiness(items(), "Public beta", options);
    assert.equal(result.ready, true);
    assert.equal(fixtureValue(result.candidateDisposition706).scanPassed, false);
    assert.equal(result.effectiveRequired.length, 2);
    assert.equal(result.unfinishedRequired.length, 0);
    assert.ok(items().every((i) => i.content.state === "OPEN"));
    for (const mutate of [
      (e: ReturnType<typeof evidence>["risk706Evidence"]) => {
        e.scan.complete = false;
      },
      (e: ReturnType<typeof evidence>["risk706Evidence"]) => {
        e.candidate.productionChanges = "crates/portcove-core/src/lib.rs";
      },
      (e: ReturnType<typeof evidence>["risk706Evidence"]) => {
        e.purpose = "qualification";
      },
    ]) {
      const changed = evidence();
      mutate(changed.risk706Evidence);
      assert.throws(() => analyzeReleaseReadiness(items(), "Public beta", changed));
    }
    assert.throws(() => analyzeReleaseReadiness(items(), "1.0", options));
  });
  void test("canonical scope and all other dependency checks remain enforced", () => {
    for (const change of [
      (i: ReturnType<typeof item>) => {
        i.platform = "Steam Deck";
      },
      (i: ReturnType<typeof item>) => {
        i.content.url = "https://example.test/706";
      },
      (i: ReturnType<typeof item>) => {
        i["release commitment"] = "Opportunistic";
      },
    ]) {
      const list = items();
      change(fixtureElement(list, 1));
      assert.equal(analyzeReleaseReadiness(list, "Public beta", { now }).safetyConflicts.length, 1);
    }
    assert.equal(analyzeReleaseReadiness(items(), "1.0", { now }).safetyConflicts.length, 2);
    assert.equal(
      analyzeReleaseReadiness(items(), "Public beta", { now, candidateIssues: [49] })
        .safetyConflicts.length,
      1,
    );
    const list = items();
    fixtureElement(list, 1).content.blockedBy = { totalCount: 1, nodes: [{ number: 999 }] };
    assert.equal(
      analyzeReleaseReadiness(list, "Public beta", evidence()).missingProjectDependencies.length,
      1,
    );
    fixtureElement(list, 1).content.blockedBy = { totalCount: 1, nodes: [{ number: 49 }] };
    const cycle = analyzeReleaseReadiness(list, "Public beta", evidence());
    assert.equal(cycle.cycles.length, 1);
    assert.equal(cycle.dependencyConflicts.length, 1);
    assert.equal(cycle.ready, false);
    const deck = item(215, [49]);
    deck.platform = "Steam Deck";
    deck["release commitment"] = "Required";
    assert.equal(
      analyzeReleaseReadiness([...items(), deck], "Public beta", evidence()).dependencyConflicts
        .length,
      1,
    );
  });
}

void test("configuration validation retains the original Project definitions and rejects malformed view arrays", () => {
  const candidate = structuredClone(config);
  const before = structuredClone(candidate);
  const checked = validateConfig(candidate);
  assert.equal(checked, candidate);
  assert.deepEqual(checked, before);
  for (const views of [undefined, null, {}])
    assert.throws(() => validateConfig({ ...candidate, views }), /views must be an array/);
  assert.throws(
    () => validateConfig({ ...candidate, views: [{ ...candidate.views[0], fields: [42] }] }),
    /visible fields/,
  );
});
