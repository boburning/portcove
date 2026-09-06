import assert from "node:assert/strict";
import test from "node:test";

import { renderPortIssueBody } from "./roadmap.mjs";
import {
  buildSourceProvenanceAudit,
  readLiveSourceProvenance,
  renderSourceProvenanceAudit,
  runReadOnlyGitHubCommand,
} from "./source-provenance-audit.mjs";

const sha = character => character.repeat(40);

function catalog() {
  return {
    schema_version: 2,
    source_catalog: {
      evidence: [{ id: "review", role: "upstream_support" }],
      identities: [{
        id: "sample-source",
        variants: [{
          id: "retail",
          representations: [{
            id: "canonical",
            kind: "raw-file",
            identities: [{ scope: "original-file", sha256: "a".repeat(64) }],
            evidence_ids: ["review"],
          }],
          evidence_ids: ["review"],
        }],
      }],
      contracts: [{
        id: "sample-contract",
        port_id: "sample",
        profile_id: "sample-source",
        supported_variant_ids: ["retail"],
        evidence_ids: ["review"],
      }],
      validators: [],
      qualification: [],
    },
    ports: [{
      id: "sample",
      name: "Sample",
      platforms: ["windows-x86-64"],
      automated_tested_platforms: [],
      manually_validated_platforms: [],
    }],
  };
}

function issue(number, title, { catalogId, portKey, upstream = `https://example.test/${number}` } = {}) {
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
  assert.equal(first.cataloged[0].qualification, "No exact records; legacy automated=0, hands-on=0");
});

test("negative fixtures expose missing tickets, duplicate catalog IDs, stale hashes, and missing evidence", () => {
  const missingIssue = fixture();
  missingIssue.issues = missingIssue.issues.filter(value => value.number !== 1);
  missingIssue.projectItems = missingIssue.projectItems.filter(value => value.content.number !== 1);
  assert.ok(buildSourceProvenanceAudit(missingIssue).observations.some(value => value.includes("Catalog port lacks")));

  const duplicateId = fixture();
  const parsed = JSON.parse(duplicateId.catalogText);
  parsed.ports.push({ ...parsed.ports[0] });
  duplicateId.catalogText = JSON.stringify(parsed);
  assert.ok(buildSourceProvenanceAudit(duplicateId).observations.includes("Duplicate catalog port ID: sample"));

  const stale = fixture();
  stale.expectedCatalogSha256 = "0".repeat(64);
  assert.ok(buildSourceProvenanceAudit(stale).observations.some(value => value.startsWith("Stale catalog hash:")));

  const missingEvidence = fixture();
  const missingCatalog = JSON.parse(missingEvidence.catalogText);
  missingCatalog.source_catalog.contracts[0].evidence_ids = ["absent"];
  missingEvidence.catalogText = JSON.stringify(missingCatalog);
  assert.ok(buildSourceProvenanceAudit(missingEvidence).observations.includes("Missing source evidence reference: absent"));
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
    buildSourceProvenanceAudit(input).observations.some(value => value.includes("share direct upstream")),
    false,
  );

  const duplicateTarget = issue(4, "Alias for Another Game", {
    portKey: "another-game",
    upstream: "https://example.test/shared",
  });
  const sameTarget = structuredClone(input);
  sameTarget.issues.push(duplicateTarget);
  sameTarget.projectItems.push(projectItem(duplicateTarget, "Watchlist"));
  assert.ok(buildSourceProvenanceAudit(sameTarget).observations.some(value => value.includes("share direct upstream and game/target identity")));

  const duplicateKey = issue(5, "Different Title", {
    portKey: "research",
    upstream: "https://example.test/other",
  });
  input.issues.push(duplicateKey);
  input.projectItems.push(projectItem(duplicateKey, "Watchlist"));
  const keyAudit = buildSourceProvenanceAudit(input);
  assert.ok(keyAudit.observations.some(value => value.includes("non-catalog port key research")));

  const duplicateTitle = issue(6, "Research!", { portKey: "unique-key" });
  input.issues.push(duplicateTitle);
  input.projectItems.push(projectItem(duplicateTitle, "Watchlist"));
  assert.ok(buildSourceProvenanceAudit(input).observations.some(value => value.includes("normalized title identity research")));
});

test("misclassified Project state is surfaced as drift", () => {
  const input = fixture();
  input.projectItems[0]["port stage"] = "Cataloged";
  assert.ok(buildSourceProvenanceAudit(input).observations.some(value => value.includes("must have exactly one valid catalog ID")));
});

test("live enrichment calls only bounded read commands and API errors do not expose tokens", () => {
  const calls = [];
  const result = readLiveSourceProvenance({
    repository: "boburning/portcove",
    owner: "boburning",
    projectNumber: 1,
    run(args) {
      calls.push(args);
      return args[0] === "issue" ? [] : { items: [] };
    },
  });
  assert.deepEqual(result, { issues: [], projectItems: [], projectState: "available" });
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [["issue", "list"], ["project", "item-list"]]);
  assert.equal(calls.flat().some(value => /create|edit|close|delete|token/i.test(value)), false);

  const secret = "github_pat_secret_value_that_must_not_appear";
  assert.throws(
    () => readLiveSourceProvenance({
      repository: "boburning/portcove",
      owner: "boburning",
      projectNumber: 1,
      run() { throw new Error(secret); },
    }),
    error => !error.message.includes(secret),
  );
});

test("live GitHub reads allow the full bounded Project payload", () => {
  let invocation;
  const value = runReadOnlyGitHubCommand(["project", "item-list"], (command, args, options) => {
    invocation = { command, args, options };
    return { status: 0, stdout: '{"items":[]}', stderr: "" };
  });
  assert.deepEqual(value, { items: [] });
  assert.equal(invocation.command, "gh");
  assert.deepEqual(invocation.args, ["project", "item-list"]);
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
