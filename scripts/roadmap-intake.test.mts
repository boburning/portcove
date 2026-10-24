import { fixtureIssueInventory } from "./repository-issue-inventory.fixture.mts";
import type { RoadmapIssueItem } from "./roadmap.mts";
import type { GitHubRunner } from "./github-api.mts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RoadmapClient,
  featureIntakeFields,
  findPortIssueDuplicates,
  normalizePortKey,
  parsePortIssueForm,
  portFieldInitialization,
  reconcilePortIssueMarkers,
  renderPortIssueBody,
  uxAuditOriginIds,
  uxAuditOrigins,
  validateDurableIssueBody,
  validatePlanOriginCoverage,
  validatePortIssueCoverage,
  validateUxAuditOriginCoverage,
} from "./roadmap.mts";

import {
  fixtureValue,
  fixtureElement,
  fixtureObject,
  fixtureJsonObject,
  fixtureGraphql,
  config,
  fixtureProjectDetails,
} from "./fixtures/roadmap-fixtures.mts";
import type { RunnerCall } from "./fixtures/roadmap-fixtures.mts";

function fixtureSelectInput(value: unknown) {
  const input = fixtureObject(value);
  const selected = fixtureObject(input.value);
  assert.ok(typeof input.fieldId === "string" && typeof selected.singleSelectOptionId === "string");
  return { fieldId: input.fieldId, value: { singleSelectOptionId: selected.singleSelectOptionId } };
}

const newPortForm = await readFile(
  new URL("../.github/ISSUE_TEMPLATE/new-port.yml", import.meta.url),
  "utf8",
);

void test("New Port form requires canonical identity input without a Project-token workflow", () => {
  assert.match(newPortForm, /id: port_key/);
  assert.match(newPortForm, /label: Durable game or target key/);
  assert.match(newPortForm, /lowercase kebab-case/);
  assert.match(newPortForm, /id: upstream[\s\S]*?required: true/);
  assert.doesNotMatch(newPortForm, /(?:PROJECT_TOKEN|personal access token)/i);
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
