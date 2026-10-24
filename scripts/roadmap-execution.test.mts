import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  RoadmapClient,
  roadmapCommandHelp,
  analyzeReleaseReadiness,
  executionSnapshot,
  validateExecutionSnapshot,
  normalizeRequirements,
  compareExecutionSnapshots,
  deriveExecutionContext,
  coordinationTarget,
  parseConsumptionRecord,
  consumedReference,
  executionQueueData,
  renderExecutionQueue,
  selectNextItems,
} from "./roadmap.mts";

import {
  fixtureValue,
  fixtureElement,
  fixtureObject,
  config,
} from "./fixtures/roadmap-fixtures.mts";

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
