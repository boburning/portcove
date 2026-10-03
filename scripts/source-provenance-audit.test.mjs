import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { renderPortIssueBody } from "./roadmap.mjs";
import {
  buildSourceProvenanceAudit,
  readLiveSourceProvenance,
  renderSourceProvenanceAudit,
  runReadOnlyGitHubCommand,
  runSourceProvenanceAudit,
} from "./source-provenance-audit.mjs";

const sha = (character) => character.repeat(40);

function included(body, headers = {}) {
  return (
    "HTTP/2.0 200 OK\r\n" +
    Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("") +
    `\r\n${JSON.stringify(body)}`
  );
}

function catalog() {
  return {
    schema_version: 2,
    source_catalog: {
      evidence: [{ id: "review", role: "upstream_support" }],
      identities: [
        {
          id: "sample-source",
          variants: [
            {
              id: "retail",
              representations: [
                {
                  id: "canonical",
                  kind: "raw-file",
                  identities: [{ scope: "original-file", sha256: "a".repeat(64) }],
                  evidence_ids: ["review"],
                },
              ],
              evidence_ids: ["review"],
            },
          ],
        },
      ],
      contracts: [
        {
          id: "sample-contract",
          port_id: "sample",
          profile_id: "sample-source",
          supported_variant_ids: ["retail"],
          evidence_ids: ["review"],
        },
      ],
      validators: [],
      qualification: [],
    },
    ports: [
      {
        id: "sample",
        name: "Sample",
        platforms: ["windows-x86-64"],
        automated_tested_platforms: [],
        manually_validated_platforms: [],
      },
    ],
  };
}

function issue(
  number,
  title,
  { catalogId, portKey, upstream = `https://example.test/${number}` } = {},
) {
  return {
    number,
    title: `[Port] ${title}`,
    state: "OPEN",
    url: `https://github.com/boburning/portcove/issues/${number}`,
    body: renderPortIssueBody({
      title,
      upstream,
      catalogId,
      portKey,
      blocker: "Source evidence is pending. Resume when the reviewed manifest is available.",
    }),
  };
}

function projectItem(value, stage) {
  return {
    content: { ...value, type: "Issue" },
    title: value.title,
    status: stage === "Blocked" ? "Blocked" : "Ready",
    "work type": "Port",
    "port stage": stage,
    horizon: "Later",
    priority: "Medium",
    "target release": "Unscheduled",
  };
}

function fixture() {
  const catalogIssue = issue(1, "Sample", { catalogId: "sample" });
  const researchIssue = issue(2, "Research", { portKey: "research" });
  return {
    catalogText: `${JSON.stringify(catalog(), null, 2)}\n`,
    issues: [researchIssue, catalogIssue],
    projectItems: [projectItem(researchIssue, "Watchlist"), projectItem(catalogIssue, "Cataloged")],
    generatedAt: "2026-09-06T15:00:00Z",
    baseCommit: sha("a"),
    generatorCommit: sha("b"),
    projectUrl: "https://github.com/users/boburning/projects/1",
  };
}

test("identical offline fixtures produce byte-identical ordered evidence", () => {
  const first = buildSourceProvenanceAudit(fixture());
  const second = buildSourceProvenanceAudit(fixture());
  assert.deepEqual(first, second);
  assert.equal(renderSourceProvenanceAudit(first), renderSourceProvenanceAudit(second));
  assert.deepEqual(first.counts, {
    catalogPorts: 1,
    sourceProfiles: 1,
    sourceVariants: 1,
    sourceRepresentations: 1,
    sourceContracts: 1,
    sourceEvidence: 1,
    preservationCrosswalkEvidence: 0,
    qualificationRecords: 0,
    portIssues: 2,
    catalogedIssues: 1,
    researchIssues: 1,
  });
  assert.deepEqual(first.observations, []);
  assert.equal(first.research[0].sourceEvidence, "Gap recorded");
  assert.equal(
    first.cataloged[0].qualification,
    "No exact records; legacy automated=0, hands-on=0",
  );
});

function researchBlockerInput(body) {
  const input = fixture();
  const identity = input.issues[0].body
    .replace(/^\s*- Current blocker and exact resume condition:.*$/gmu, "")
    .replace(/^## Dependencies and blockers\s*$[\s\S]*?(?=^##\s|(?![\s\S]))/gmu, "");
  input.issues[0].body = `${body}\n${identity}`;
  input.projectItems[0].content.body = input.issues[0].body;
  return input;
}

function researchBlocker(body) {
  return buildSourceProvenanceAudit(researchBlockerInput(body)).research[0].gap;
}

function mergedBlockerFixture(blocker, overrides = {}) {
  const input = researchBlockerInput(`- Current blocker and exact resume condition: ${blocker}`);
  input.projectItems.push({
    content: {
      type: "PullRequest",
      number: 31,
      state: "MERGED",
      merged: true,
      url: "https://github.com/boburning/portcove/pull/31",
      ...overrides,
    },
  });
  return input;
}

function mergedReferenceObservations(input) {
  return buildSourceProvenanceAudit(input).observations.filter((value) =>
    value.startsWith("Active blocker references merged PR"),
  );
}

test("known merged references in active blockers are reported without resolving acceptance", async (t) => {
  for (const reference of [
    "PR #31",
    "boburning/portcove#31",
    "https://github.com/boburning/portcove/pull/31",
    "https://github.com/boburning/portcove/pull/31#issuecomment-1",
  ]) {
    await t.test(reference, () => {
      const input = mergedBlockerFixture(
        `Waiting for ${reference} to merge. Resume when the reviewed manifest is available.`,
      );
      const before = structuredClone(input);
      const first = buildSourceProvenanceAudit(input);
      const second = buildSourceProvenanceAudit(input);
      assert.equal(mergedReferenceObservations(input).length, 1);
      assert.match(first.observations.join("\n"), /Review remaining acceptance/);
      assert.match(first.research[0].gap, /reviewed manifest/);
      assert.deepEqual(first, second);
      assert.deepEqual(input, before);
      assert.equal(first.schemaVersion, 1);
      assert.match(
        renderSourceProvenanceAudit(first),
        /Unlisted, closed, partial or unavailable PR facts are not assumed merged/,
      );
    });
  }
});

test("merged findings require actual same-repository unambiguous PR facts", async (t) => {
  for (const [label, overrides] of [
    ["closed unmerged", { state: "CLOSED", merged: false }],
    ["closed alone", { state: "CLOSED", merged: undefined }],
    ["merged label alone", { merged: undefined }],
    ["inconsistent state", { state: "CLOSED" }],
    ["string flag", { merged: "true" }],
    ["issue not PR", { type: "Issue" }],
    ["other repository", { url: "https://github.com/other/portcove/pull/31" }],
    ["other host", { url: "https://example.test/boburning/portcove/pull/31" }],
    ["bare fact URL", { url: "PR #31" }],
    ["scoped fact URL", { url: "boburning/portcove#31" }],
    ["wrong number", { url: "https://github.com/boburning/portcove/pull/32" }],
  ])
    await t.test(label, () =>
      assert.deepEqual(
        mergedReferenceObservations(
          mergedBlockerFixture("Waiting for PR #31 to merge.", overrides),
        ),
        [],
      ),
    );
  const conflicting = mergedBlockerFixture("Waiting for PR #31 to merge.");
  conflicting.projectItems.push({
    content: { ...conflicting.projectItems.at(-1).content, state: "OPEN", merged: false },
  });
  assert.deepEqual(mergedReferenceObservations(conflicting), []);
  const missing = mergedBlockerFixture("Waiting for PR #31 to merge.");
  missing.projectItems.pop();
  assert.deepEqual(mergedReferenceObservations(missing), []);
  const unavailable = mergedBlockerFixture("Waiting for PR #31 to merge.");
  unavailable.projectState = "unavailable";
  assert.deepEqual(mergedReferenceObservations(unavailable), []);
  const partial = mergedBlockerFixture("Waiting for PR #31 to merge.");
  partial.projectItems = {
    items: partial.projectItems,
    totalCount: 9,
    pageInfo: { hasNextPage: true },
  };
  assert.deepEqual(mergedReferenceObservations(partial), []);
});

test("completed, cross-repository and ambiguous prose is not a merge prerequisite", async (t) => {
  for (const blocker of [
    "Waiting for PR #99 to merge.",
    "Waiting for other/portcove#31 to merge.",
    "Waiting for https://github.com/other/portcove/pull/31 to merge.",
    "Waiting for issue #31 to close.",
    "PR #31 merged. Waiting for gameplay evidence.",
    "Not waiting for PR #31 to merge; manifest review is pending.",
    "Maybe waiting for PR #31 to merge.",
    "We aren't waiting for PR #31 to merge; manifest review is pending.",
    "We aren’t waiting for PR #31 to merge; manifest review is pending.",
    "Waiting for PR #31 to merge?",
    "Waiting for `PR #31` in this code example.",
    "<!-- Waiting for PR #31 to merge. -->",
  ])
    await t.test(blocker, () =>
      assert.deepEqual(mergedReferenceObservations(mergedBlockerFixture(blocker)), []),
    );
  const closed = mergedBlockerFixture("Waiting for PR #31 to merge.");
  closed.issues[0].state = "CLOSED";
  assert.deepEqual(mergedReferenceObservations(closed), []);
});

test("merged-reference reporting reuses current history scope and groups known prerequisites", () => {
  const input = mergedBlockerFixture(
    "Waiting for PR #31 and PR #32 to merge. Resume when reviewed evidence exists.",
  );
  input.projectItems.push({
    content: {
      ...input.projectItems.at(-1).content,
      number: 32,
      url: "https://github.com/boburning/portcove/pull/32",
    },
  });
  assert.equal(mergedReferenceObservations(input).length, 2);
  const history = `<details><summary>Superseded history</summary>\n- Current blocker and exact resume condition: Waiting for PR #31 to merge.\n</details>`;
  input.issues[0].body = `${history}\n- Current blocker and exact resume condition: Waiting for PR #99 to merge.\n`;
  assert.deepEqual(mergedReferenceObservations(input), []);
  input.issues[0].body = `<details><summary>Current blocker details</summary>\n- Current blocker and exact resume condition: Waiting for PR #31 to merge.\n</details>`;
  assert.equal(mergedReferenceObservations(input).length, 1);
});

test("cataloged specifications and complete fixture metadata retain the same advisory boundary", () => {
  const input = mergedBlockerFixture("Waiting for PR #31 to merge.");
  input.issues[0].body = input.issues[0].body.replace(
    "Waiting for PR #31 to merge.",
    "Source evidence still needs review.",
  );
  input.issues[1].body = input.issues[1].body.replace(
    "Source evidence is pending. Resume when the reviewed manifest is available.",
    "Waiting for PR #31 to merge. Resume when reviewed evidence exists.",
  );
  input.projectItems.push(structuredClone(input.projectItems.at(-1)));
  input.projectState = "fixture";
  input.projectItems = {
    items: input.projectItems,
    totalCount: input.projectItems.length,
    pageInfo: { hasNextPage: false },
  };
  const result = buildSourceProvenanceAudit(input);
  assert.equal(mergedReferenceObservations(input).length, 1);
  assert.match(mergedReferenceObservations(input)[0], /issues\/1/);
  assert.equal(result.cataloged[0].deterministicIdentity, true);
  assert.equal(
    result.cataloged[0].qualification,
    "No exact records; legacy automated=0, hands-on=0",
  );
  input.projectItems.pageInfo.hasNextPage = "unknown";
  assert.deepEqual(mergedReferenceObservations(input), []);
});

test("superseded collapsed history does not replace the current research blocker", () => {
  const history = `<details>
<summary>Superseded historical scope</summary>
- Current blocker and exact resume condition: Wait for an already completed historical PR.
</details>`;
  const active = "## Dependencies and blockers\nAccepted-source review is still outstanding.";
  for (const body of [`${history}\n${active}`, `${active}\n${history}`]) {
    const input = researchBlockerInput(body);
    const first = buildSourceProvenanceAudit(input);
    const second = buildSourceProvenanceAudit(input);
    assert.equal(first.research[0].gap, "Accepted-source review is still outstanding.");
    assert.equal(renderSourceProvenanceAudit(first), renderSourceProvenanceAudit(second));
    assert.deepEqual(first.observations, []);
    const baseline = buildSourceProvenanceAudit(fixture());
    assert.deepEqual(first.cataloged, baseline.cataloged);
    assert.deepEqual(first.counts, baseline.counts);
    assert.deepEqual({ ...first.research[0], gap: baseline.research[0].gap }, baseline.research[0]);
  }
});

function researchEvidenceInput(body) {
  const input = fixture();
  const identity = input.issues[0].body
    .replace(/^\s*- Source requirements and accepted revisions:.*$/gmu, "")
    .replace(/^\s*- Release assets and integrity:.*$/gmu, "");
  input.issues[0].body = `${body}\n${identity}`;
  input.projectItems[0].content.body = input.issues[0].body;
  return input;
}

test("research evidence summaries ignore explicitly superseded history", async (t) => {
  for (const example of [
    {
      name: "obsolete accepted source cannot replace current pending evidence",
      historical: "- Source requirements and accepted revisions: Reviewed obsolete revision.",
      active: "- Source requirements and accepted revisions: Pending",
      expected: { sourceEvidence: "Gap recorded", releaseIntegrity: "Not structurally recorded" },
    },
    {
      name: "historical pending integrity cannot override current verified evidence",
      historical: "Release integrity: pending",
      active: "Release integrity: verified",
      expected: {
        sourceEvidence: "Not structurally recorded",
        releaseIntegrity: "Evidence mentioned in issue",
      },
    },
    {
      name: "superseded checksum alone cannot establish current integrity evidence",
      historical: "Artifact SHA-256: obsolete reviewed identity.",
      active: "Current artifact integrity has not been described.",
      expected: {
        sourceEvidence: "Not structurally recorded",
        releaseIntegrity: "Not structurally recorded",
      },
    },
  ]) {
    await t.test(example.name, () => {
      const history = `<details>\n<summary>Superseded historical scope</summary>\n${example.historical}\n</details>`;
      for (const body of [`${history}\n${example.active}`, `${example.active}\n${history}`]) {
        const input = researchEvidenceInput(body);
        const first = buildSourceProvenanceAudit(input);
        const second = buildSourceProvenanceAudit(input);
        const row = first.research[0];
        assert.deepEqual(
          { sourceEvidence: row.sourceEvidence, releaseIntegrity: row.releaseIntegrity },
          example.expected,
        );
        assert.equal(renderSourceProvenanceAudit(first), renderSourceProvenanceAudit(second));
        const baseline = buildSourceProvenanceAudit(fixture());
        assert.deepEqual(first.cataloged, baseline.cataloged);
        assert.deepEqual(first.counts, baseline.counts);
        assert.deepEqual(first.observations, baseline.observations);
        assert.deepEqual(
          {
            ...row,
            sourceEvidence: baseline.research[0].sourceEvidence,
            releaseIntegrity: baseline.research[0].releaseIntegrity,
          },
          baseline.research[0],
        );
      }
    });
  }
});

test("active ambiguous and malformed research evidence remains visible", () => {
  const facts =
    "- Source requirements and accepted revisions: Reviewed current revision.\nRelease integrity: pending";
  const bodies = [
    ...[
      "Current evidence",
      "Historical context still applicable",
      "Not superseded",
      "Superseded?",
      "Superseded history isn't established",
      "Superseded historical scope?",
    ].map((label) => `<details>\n<summary>${label}</summary>\n${facts}\n</details>`),
    `<details>\n${facts}\n</details>`,
    `<details><summary>Superseded history</summary>\n${facts}`,
    `<details><summary>Current scope</summary><details><summary>Superseded history</summary>\n${facts}\n</details>`,
    `<!-- <details><summary>Superseded history</summary>\n${facts}\n</details> -->`,
    `\`\`\`html\n<details><summary>Superseded history</summary>\n${facts}\n</details>\n\`\`\``,
  ];
  for (const body of bodies) {
    const row = buildSourceProvenanceAudit(researchEvidenceInput(body)).research[0];
    assert.equal(row.sourceEvidence, "Evidence mentioned in issue");
    assert.equal(row.releaseIntegrity, "Gap recorded");
  }
});

test("active and unlabeled collapsed details remain authoritative blockers", () => {
  for (const summary of [
    "Current blocker details",
    "Historical context still applicable",
    "Not superseded",
    "Superseded? Review is still pending",
    "Superseded historical scope?",
    "Superseded history is not established",
    "Superseded history remains unconfirmed",
    "Superseded history isn't established",
    "Superseded history isn’t established",
    "Superseded history may still be current",
    "Current blocker supersedes an earlier decision",
  ]) {
    assert.equal(
      researchBlocker(
        `<details open>\n<summary>${summary}</summary>\n- Current blocker and exact resume condition: Current review remains required.\n</details>`,
      ),
      "Current review remains required.",
    );
  }
  assert.equal(
    researchBlocker(
      "<details>\n- Current blocker and exact resume condition: Unlabeled review remains required.\n</details>",
    ),
    "Unlabeled review remains required.",
  );
});

test("section blockers before and after active details are retained", () => {
  const gap = researchBlocker(`## Dependencies and blockers
Current source review remains required.
<details><summary>Current exact resume evidence</summary>
Artifact bytes have not been assessed.
</details>
Fresh accepted records are still required.`);
  assert.equal(
    gap,
    "Current source review remains required. Current exact resume evidence Artifact bytes have not been assessed. Fresh accepted records are still required.",
  );
});

test("supersession follows balanced nested boundaries and leaves current neighbors", () => {
  const history = `<DETAILS open>
<SUMMARY><strong>Superseded</strong> historical scope</SUMMARY>
<details><summary>Previous exact blocker</summary>
- Current blocker and exact resume condition: Historical nested blocker.
</details>
</DETAILS>`;
  assert.equal(
    researchBlocker(
      `${history}\n<details><summary>Current review</summary>\n- Current blocker and exact resume condition: Active neighbor remains required.\n</details>`,
    ),
    "Active neighbor remains required.",
  );
  const nested = researchBlocker(`## Dependencies and blockers
<details><summary>Current evidence</summary>
${history}
Active evidence remains missing.
</details>`);
  assert.equal(nested, "Current evidence Active evidence remains missing.");
});

test("malformed or code/comment examples do not establish a superseded boundary", () => {
  for (const body of [
    "<details><summary>Superseded historical scope</summary>\n- Current blocker and exact resume condition: Unclosed evidence remains visible.",
    "<details><summary>Current scope</summary><details><summary>Superseded history</summary>\n- Current blocker and exact resume condition: Unclosed evidence remains visible.\n</details>",
    "<details><summary>Superseded historical scope\n<details><summary>Current exact evidence</summary>\n- Current blocker and exact resume condition: Unclosed evidence remains visible.\n</details>\n</details>",
    "<details><summary>Superseded historical scope\n- Current blocker and exact resume condition: Unclosed evidence remains visible.\n</details>",
  ])
    assert.equal(researchBlocker(body), "Unclosed evidence remains visible.");
  for (const wrapper of [
    (text) => `\`\`\`html\n${text}\n\`\`\``,
    (text) => `~~~~html\n${text}\n~~~~`,
    (text) => `<!-- ${text} -->`,
    (text) => `\`${text}\``,
  ]) {
    const example = wrapper(
      "<details><summary>Superseded historical scope</summary>Example facts remain visible.</details>",
    );
    const gap = researchBlocker(
      `## Dependencies and blockers\n${example}\nActual review remains required.`,
    );
    assert.ok(gap.includes("Example facts remain visible."));
    assert.ok(gap.includes("Actual review remains required."));
  }
});

test("negative fixtures expose missing tickets, duplicate catalog IDs, stale hashes, and missing evidence", () => {
  const missingIssue = fixture();
  missingIssue.issues = missingIssue.issues.filter((value) => value.number !== 1);
  missingIssue.projectItems = missingIssue.projectItems.filter(
    (value) => value.content.number !== 1,
  );
  assert.ok(
    buildSourceProvenanceAudit(missingIssue).observations.some((value) =>
      value.includes("Catalog port lacks"),
    ),
  );

  const duplicateId = fixture();
  const parsed = JSON.parse(duplicateId.catalogText);
  parsed.ports.push({ ...parsed.ports[0] });
  duplicateId.catalogText = JSON.stringify(parsed);
  assert.ok(
    buildSourceProvenanceAudit(duplicateId).observations.includes(
      "Duplicate catalog port ID: sample",
    ),
  );

  const stale = fixture();
  stale.expectedCatalogSha256 = "0".repeat(64);
  assert.ok(
    buildSourceProvenanceAudit(stale).observations.some((value) =>
      value.startsWith("Stale catalog hash:"),
    ),
  );

  const missingEvidence = fixture();
  const missingCatalog = JSON.parse(missingEvidence.catalogText);
  missingCatalog.source_catalog.contracts[0].evidence_ids = ["absent"];
  missingEvidence.catalogText = JSON.stringify(missingCatalog);
  assert.ok(
    buildSourceProvenanceAudit(missingEvidence).observations.includes(
      "Missing source evidence reference: absent",
    ),
  );
});

test("duplicate candidate keys and titles fail while one shared upstream can serve distinct targets", () => {
  const input = fixture();
  const second = issue(3, "Another Game", {
    portKey: "another-game",
    upstream: "https://example.test/shared",
  });
  input.issues[0] = issue(2, "Research", {
    portKey: "research",
    upstream: "https://example.test/shared/",
  });
  input.issues.push(second);
  input.projectItems = [
    projectItem(input.issues[0], "Watchlist"),
    projectItem(input.issues[1], "Cataloged"),
    projectItem(second, "Watchlist"),
  ];
  assert.equal(
    buildSourceProvenanceAudit(input).observations.some((value) =>
      value.includes("share direct upstream"),
    ),
    false,
  );

  const duplicateTarget = issue(4, "Alias for Another Game", {
    portKey: "another-game",
    upstream: "https://example.test/shared",
  });
  const sameTarget = structuredClone(input);
  sameTarget.issues.push(duplicateTarget);
  sameTarget.projectItems.push(projectItem(duplicateTarget, "Watchlist"));
  assert.ok(
    buildSourceProvenanceAudit(sameTarget).observations.some((value) =>
      value.includes("share direct upstream and game/target identity"),
    ),
  );

  const duplicateKey = issue(5, "Different Title", {
    portKey: "research",
    upstream: "https://example.test/other",
  });
  input.issues.push(duplicateKey);
  input.projectItems.push(projectItem(duplicateKey, "Watchlist"));
  const keyAudit = buildSourceProvenanceAudit(input);
  assert.ok(keyAudit.observations.some((value) => value.includes("non-catalog port key research")));

  const duplicateTitle = issue(6, "Research!", { portKey: "unique-key" });
  input.issues.push(duplicateTitle);
  input.projectItems.push(projectItem(duplicateTitle, "Watchlist"));
  assert.ok(
    buildSourceProvenanceAudit(input).observations.some((value) =>
      value.includes("normalized title identity research"),
    ),
  );
});

test("misclassified Project state is surfaced as drift", () => {
  const input = fixture();
  input.projectItems[0]["port stage"] = "Cataloged";
  assert.ok(
    buildSourceProvenanceAudit(input).observations.some((value) =>
      value.includes("must have exactly one valid catalog ID"),
    ),
  );
});

test("live enrichment calls only bounded read commands and API errors do not expose tokens", () => {
  const calls = [];
  const result = readLiveSourceProvenance({
    repository: "boburning/portcove",
    owner: "boburning",
    projectNumber: 1,
    run(args, input) {
      calls.push({ args, input });
      if (args[0] === "project") return { id: "PVT" };
      if (args[0] === "api" && args[1] === "--include" && !input) return included([]);
      const page = {
        totalCount: 0,
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
      return included({ data: { node: { items: page } } });
    },
  });
  assert.deepEqual(result, {
    issues: [],
    projectItems: [],
    pullRequests: [],
    projectState: "available",
  });
  assert.deepEqual(
    calls.map(({ args }) => args.slice(0, 2)),
    [
      ["api", "--include"],
      ["api", "--include"],
      ["api", "--include"],
      ["project", "view"],
      ["api", "graphql"],
    ],
  );
  assert.ok(
    calls
      .filter(({ args }) => args[0] === "api" && args[1] === "--include" && args[2])
      .every(({ args }) => args[2].includes("/issues?state=all")),
  );
  for (const { input } of calls.filter((call) => call.input)) {
    const query = JSON.parse(input).query;
    assert.match(query, /^query\(/);
    assert.match(query, /(?:issues\(first: 100|items\(first: 50)/);
    assert.match(query, /totalCount/);
    assert.doesNotMatch(query, /\bmutation\b/);
  }

  const secret = "github_pat_secret_value_that_must_not_appear";
  assert.throws(
    () =>
      readLiveSourceProvenance({
        repository: "boburning/portcove",
        owner: "boburning",
        projectNumber: 1,
        run() {
          throw new Error(secret);
        },
      }),
    (error) => !error.message.includes(secret),
  );
});

test("live GitHub reads allow the full bounded Project payload", () => {
  let invocation;
  const value = runReadOnlyGitHubCommand(
    ["api", "graphql", "--input", "-"],
    '{"query":"query { viewer { login } }"}',
    (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: '{"items":[]}', stderr: "" };
    },
  );
  assert.deepEqual(value, { items: [] });
  assert.equal(invocation.command, "gh");
  assert.deepEqual(invocation.args, ["api", "graphql", "--input", "-"]);
  assert.equal(invocation.options.input, '{"query":"query { viewer { login } }"}');
  assert.equal(invocation.options.maxBuffer, 32 * 1024 * 1024);
});

test("rendered output labels evidence authority and catalog versus research scope", () => {
  const report = renderSourceProvenanceAudit(buildSourceProvenanceAudit(fixture()));
  assert.match(report, /Dated read-only evidence/);
  assert.match(report, /not a roadmap, priority authority/);
  assert.match(report, /## Cataloged support inventory/);
  assert.match(report, /## Research inventory/);
  assert.match(report, /Exact qualification counts only artifact\/source-variant-scoped records/);
});

function paginatedLiveRunner(issues, projectItems, intercept = () => {}) {
  return (args, input) => {
    if (args[0] === "project") return { id: "PVT" };
    if (args[0] === "api" && args[1] === "--include" && !input) {
      const endpoint = args[2];
      if (endpoint.includes("direction=desc")) {
        const latest = issues.reduce(
          (current, issue) => (issue.number > current.number ? issue : current),
          { number: 0 },
        );
        return included(latest.number ? [{ number: latest.number }] : []);
      }
      const pageMatch = /[?&]page=(\d+)/u.exec(endpoint);
      const pageNumber = Number(pageMatch?.[1] ?? 1);
      const offset = (pageNumber - 1) * 100;
      intercept({ isIssues: true, offset });
      const nodes = issues.slice(offset, offset + 100).map((issue) => ({
        ...issue,
        node_id: issue.node_id ?? `I_${issue.number}`,
        html_url: issue.html_url ?? issue.url ?? `https://github.test/issues/${issue.number}`,
        state: String(issue.state ?? "open").toLowerCase(),
      }));
      const hasNextPage = offset + nodes.length < issues.length;
      return included(
        nodes,
        hasNextPage
          ? {
              link: `<repos/boburning/portcove/issues?state=all&sort=created&direction=asc&per_page=100&page=${pageNumber + 1}>; rel="next"`,
            }
          : {},
      );
    }
    const { variables } = JSON.parse(input);
    const values = projectItems;
    const size = 50;
    const offset = Number(variables.after ?? 0);
    intercept({ isIssues: false, offset });
    const nodes = values.slice(offset, offset + size);
    const hasNextPage = offset + nodes.length < values.length;
    const page = {
      nodes,
      totalCount: values.length,
      pageInfo: {
        hasNextPage,
        endCursor: hasNextPage ? String(offset + nodes.length) : null,
      },
    };
    return included({ data: { node: { items: page } } });
  };
}

function largeLiveFixture() {
  const input = fixture();
  const issues = [
    ...Array.from({ length: 1001 }, (_, i) => ({
      number: i + 3,
      title: `Other work ${i}`,
      body: "",
      state: "CLOSED",
      __typename: "Issue",
    })),
    ...input.issues.map((value) => ({ ...value, __typename: "Issue" })),
  ];
  const projectItems = [
    ...Array.from({ length: 1001 }, (_, i) => ({
      id: `PVTI_draft_${i}`,
      content: { __typename: "DraftIssue", title: `Draft ${i}` },
      fieldValues: {
        totalCount: 0,
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    })),
    ...input.projectItems.map((value, index) => ({
      id: `PVTI_port_${index}`,
      content: { ...value.content, __typename: "Issue" },
      fieldValues: {
        nodes: [
          ["Status", value.status],
          ["Work type", "Port"],
          ["Port stage", value["port stage"]],
          ["Horizon", value.horizon],
          ["Priority", value.priority],
          ["Target release", value["target release"]],
        ].map(([name, option]) => ({ name: option, field: { name } })),
        totalCount: 6,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    })),
  ];
  return { input, issues, projectItems };
}

test("live provenance includes canonical ports beyond 1000 records with deterministic output", () => {
  const { input, issues, projectItems } = largeLiveFixture();
  const calls = [];
  const run = paginatedLiveRunner(issues, projectItems, (call) => calls.push(call));
  const live = readLiveSourceProvenance({
    repository: "boburning/portcove",
    owner: "boburning",
    projectNumber: 1,
    run,
  });
  assert.equal(live.issues.length, 1003);
  assert.equal(live.projectItems.length, 1003);
  assert.equal(calls.filter((call) => call.isIssues).length, 11);
  assert.equal(calls.filter((call) => !call.isIssues).length, 21);
  assert.equal(live.projectItems.at(-1).content.number, 1);
  const first = buildSourceProvenanceAudit({ ...input, ...live });
  const second = buildSourceProvenanceAudit({
    ...input,
    ...readLiveSourceProvenance({
      repository: "boburning/portcove",
      owner: "boburning",
      projectNumber: 1,
      run,
    }),
  });
  assert.deepEqual(first.observations, []);
  assert.equal(first.counts.portIssues, 2);
  assert.equal(first.counts.catalogedIssues, 1);
  assert.equal(first.counts.researchIssues, 1);
  assert.equal(renderSourceProvenanceAudit(first), renderSourceProvenanceAudit(second));
});

test("failed later live pages preserve existing snapshots and create no partial snapshot", async () => {
  const directory = await mkdtemp(new URL("../docs/archive/provenance-test-", import.meta.url));
  const existing = `${directory}/existing.md`;
  const absent = `${directory}/absent.md`;
  const secret = "github_pat_private_test_value";
  const { issues, projectItems } = largeLiveFixture();
  try {
    await writeFile(existing, "previous verified snapshot\n");
    for (const failIssues of [true, false]) {
      const run = paginatedLiveRunner(issues, projectItems, ({ isIssues, offset }) => {
        if (isIssues === failIssues && offset > 0) throw new Error(secret);
      });
      for (const output of [existing, absent]) {
        await assert.rejects(
          runSourceProvenanceAudit(
            [
              "--live",
              "--generated-at",
              "2026-09-06T15:00:00Z",
              "--base-commit",
              sha("a"),
              "--generator-commit",
              sha("b"),
              "--output",
              output,
            ],
            { run },
          ),
          (error) =>
            error.message === "read-only GitHub enrichment failed; no snapshot was written" &&
            !error.message.includes(secret),
        );
      }
      assert.equal(await readFile(existing, "utf8"), "previous verified snapshot\n");
      await assert.rejects(readFile(absent), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("incomplete offline collections preserve previous provenance snapshots", async (t) => {
  const directory = await mkdtemp(new URL("../docs/archive/provenance-test-", import.meta.url));
  const input = fixture();
  const catalogPath = `${directory}/catalog.json`;
  const issuesPath = `${directory}/issues.json`;
  const projectPath = `${directory}/project.json`;
  const existing = `${directory}/existing.md`;
  const absent = `${directory}/absent.md`;
  const args = (output) => [
    "--catalog",
    catalogPath,
    "--issues",
    issuesPath,
    "--project-items",
    projectPath,
    "--generated-at",
    input.generatedAt,
    "--base-commit",
    input.baseCommit,
    "--generator-commit",
    input.generatorCommit,
    "--output",
    output,
  ];
  try {
    await writeFile(catalogPath, input.catalogText);
    await writeFile(existing, "previous verified snapshot\n");
    for (const [label, collection, metadata] of [
      [
        "issues with an unfinished page",
        "issues",
        { totalCount: 3, pageInfo: { hasNextPage: true } },
      ],
      [
        "issues with a contradictory total",
        "issues",
        { totalCount: 3, pageInfo: { hasNextPage: false } },
      ],
      [
        "Project with an unfinished page",
        "projectItems",
        { totalCount: 3, pageInfo: { hasNextPage: true } },
      ],
      [
        "Project with unknown pagination",
        "projectItems",
        { totalCount: 2, pageInfo: { hasNextPage: "unknown" } },
      ],
      ["issues without pagination metadata", "issues", {}],
      ["Project without a declared total", "projectItems", { pageInfo: { hasNextPage: false } }],
    ])
      await t.test(label, async () => {
        const issues =
          collection === "issues" ? { items: input.issues, ...metadata } : input.issues;
        const projectItems =
          collection === "projectItems"
            ? { items: input.projectItems, ...metadata }
            : input.projectItems;
        await writeFile(issuesPath, JSON.stringify(issues));
        await writeFile(projectPath, JSON.stringify(projectItems));
        for (const output of [existing, absent])
          await assert.rejects(runSourceProvenanceAudit(args(output)), /incomplete offline/);
        assert.equal(await readFile(existing, "utf8"), "previous verified snapshot\n");
        await assert.rejects(readFile(absent), { code: "ENOENT" });
      });
    for (const [label, wrap] of [
      ["complete arrays", (items) => items],
      [
        "complete envelopes",
        (items) => ({
          items,
          totalCount: items.length,
          pageInfo: { hasNextPage: false },
        }),
      ],
    ])
      await t.test(label, async () => {
        await writeFile(issuesPath, JSON.stringify(wrap(input.issues)));
        await writeFile(projectPath, JSON.stringify(wrap(input.projectItems)));
        await runSourceProvenanceAudit(args(absent));
        assert.match(await readFile(absent, "utf8"), /- Durable Port issues: 2/);
        await rm(absent);
      });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live blockers resolve referenced PRs independently of Project membership", async (t) => {
  for (const [label, response, expected] of [
    [
      "merged",
      {
        __typename: "PullRequest",
        number: 31,
        url: "https://github.com/boburning/portcove/pull/31",
        state: "MERGED",
        merged: true,
      },
      1,
    ],
    [
      "closed",
      {
        __typename: "PullRequest",
        number: 31,
        url: "https://github.com/boburning/portcove/pull/31",
        state: "CLOSED",
        merged: false,
      },
      0,
    ],
    ["unknown", null, 0],
  ])
    await t.test(label, () => {
      const input = mergedBlockerFixture("Waiting for PR #31 and PR #31 to merge.");
      input.projectItems.pop();
      const baseRun = paginatedLiveRunner(input.issues, []);
      const requests = [];
      const live = readLiveSourceProvenance({
        repository: "boburning/portcove",
        owner: "boburning",
        projectNumber: 1,
        run(args, payload) {
          if (payload && JSON.parse(payload).query.includes("pullRequest(number:")) {
            requests.push(JSON.parse(payload).variables);
            return included({ data: { repository: { pullRequest: response } } });
          }
          return baseRun(args, payload);
        },
      });
      assert.deepEqual(requests, [{ owner: "boburning", name: "portcove", number: 31 }]);
      assert.deepEqual(live.projectItems, []);
      assert.equal(mergedReferenceObservations({ ...input, ...live }).length, expected);
    });
});

test("referenced PR reads fail closed on partial or contradictory facts", async (t) => {
  for (const response of [
    undefined,
    {},
    { __typename: "PullRequest", number: 31, url: "PR #31", state: "MERGED", merged: true },
    {
      __typename: "PullRequest",
      number: 31,
      url: "https://github.com/boburning/portcove/pull/31",
      state: "CLOSED",
      merged: true,
    },
  ]) {
    await t.test(JSON.stringify(response) ?? "missing", () => {
      const input = mergedBlockerFixture("Waiting for PR #31 to merge.");
      const baseRun = paginatedLiveRunner(input.issues, []);
      assert.throws(
        () =>
          readLiveSourceProvenance({
            repository: "boburning/portcove",
            owner: "boburning",
            projectNumber: 1,
            run(args, payload) {
              if (payload && JSON.parse(payload).query.includes("pullRequest(number:"))
                return included({ data: { repository: { pullRequest: response } } });
              return baseRun(args, payload);
            },
          }),
        /enrichment failed/,
      );
    });
  }
});

test("live reference lookup bounds work before requesting any PR", () => {
  const input = researchBlockerInput(
    "- Current blocker and exact resume condition: Waiting for " +
      Array.from({ length: 101 }, (_, i) => `PR #${i + 1}`).join(", "),
  );
  // The explicit gap deliberately truncates prose at 500 characters. Use one
  // short reference per issue to exercise the complete collector bound.
  const issues = Array.from({ length: 101 }, (_, i) => ({
    ...input.issues[0],
    number: i + 1,
    body: input.issues[0].body.replace(
      /^- Current blocker and exact resume condition:.*$/mu,
      `- Current blocker and exact resume condition: Waiting for PR #${i + 1} to merge.`,
    ),
  }));
  const baseRun = paginatedLiveRunner(issues, []);
  let prRequests = 0;
  assert.throws(
    () =>
      readLiveSourceProvenance({
        repository: "boburning/portcove",
        owner: "boburning",
        projectNumber: 1,
        run(args, payload) {
          if (payload && JSON.parse(payload).query.includes("pullRequest(number:")) prRequests++;
          return baseRun(args, payload);
        },
      }),
    /enrichment failed/,
  );
  assert.equal(prRequests, 0);
});
