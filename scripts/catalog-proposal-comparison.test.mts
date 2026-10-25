import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  requiredFixture,
  record,
  records,
  text,
  fixtureJson,
  run,
  isolatedGenerator,
  proposalDecoderFixture,
} from "./fixtures/catalog-generator-fixtures.mts";
import type { FixtureCatalog } from "./fixtures/catalog-generator-fixtures.mts";

function differenceRecords(value: unknown) {
  return records(value).map((item) => ({ ...item, path: text(item.path) }));
}

function comparisonReport(value: unknown) {
  const report = record(value);
  const changes = record(report.proposal_changes);
  return {
    ...report,
    differences: differenceRecords(report.differences),
    proposal_changes: {
      ...changes,
      ports: records(changes.ports).map((port) => {
        const groups = record(port.changes);
        return {
          ...port,
          port_id: text(port.port_id),
          action: text(port.action),
          name_before: port.name_before,
          name_after: port.name_after,
          changes: {
            source: differenceRecords(groups.source),
            execution: differenceRecords(groups.execution),
            persistence: differenceRecords(groups.persistence),
            other: differenceRecords(groups.other),
          },
        };
      }),
      source_records: records(changes.source_records),
      order_changes: records(changes.order_changes),
    },
  };
}

function compareProposal(before: FixtureCatalog, after: FixtureCatalog) {
  const fixture = isolatedGenerator();
  writeFileSync(
    join(fixture.catalogs, "catalog-schema2-migration-fixture.json"),
    JSON.stringify(before),
  );
  writeFileSync(join(fixture.catalogs, "catalog-current-authoring.json"), JSON.stringify(after));
  const result = fixture.run("--compare-historical");
  assert.equal(result.status, 0, result.stderr);
  return comparisonReport(fixtureJson(result.stdout));
}

function proposalFixture(): FixtureCatalog {
  return {
    schema_version: 2,
    ports: ["first", "second"].map((id) => ({
      id,
      name: `Port ${id}`,
      summary: "Fixture description",
      project_url: "https://example.org/project",
      source_profile: "shared-source",
      release: { repository: "fixture/shared" },
      executable_hints: { "linux-x86-64": ["game"] },
      persistent_paths: ["saves"],
    })),
    source_catalog: {
      identities: [{ id: "shared-source", label: "Shared source", variants: [] }],
      contracts: [],
      evidence: [],
      validators: [],
      qualification: [],
    },
  };
}

void test("unreviewed proposal identities report required fixture review without editing expectations", () => {
  // Test generic bookkeeping with independently fixed identities, not the live
  // catalog count. Live accepted-catalog and frozen equality checks are separate.
  const expectedBytes = Buffer.from(
    JSON.stringify({ port_ids: ["added-port"], source_profile_ids: ["added-source"] }),
  );
  const fixture = proposalDecoderFixture(0, false, "--prepare-proposal", (input, catalogs) => {
    input.ports = [
      { id: "frozen-port", name: "Frozen fixture" },
      { id: "added-port", name: "Reviewed fixture" },
      { id: "unreviewed-proposal-port", name: "Unreviewed fixture" },
    ].map((port) => ({
      ...port,
      summary: "Fixture description",
      project_url: "https://example.org/project",
    }));
    input.source_catalog = {
      identities: [{ id: "frozen-source" }],
      contracts: [],
      validators: [],
      evidence: [],
      qualification: [],
    };
    writeFileSync(
      join(catalogs, "catalog-schema1-fixture.json"),
      JSON.stringify({
        ports: [{ id: "frozen-port" }],
        source_profiles: [{ id: "frozen-source" }],
      }),
    );
    writeFileSync(join(catalogs, "catalog-legacy-additions-fixture.json"), expectedBytes);
  });
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  assert.equal(fixture.processes.filter(({ inspection }) => inspection).length, 3);
  const report = fixtureJson(readFileSync(join(fixture.output, "proposal-evidence.json")));
  assert.deepEqual(
    record(report.declaration_cases).cases,
    [],
    "unreviewed identity bookkeeping is not a declaration change against the same accepted fixture",
  );
  assert.match(
    text(record(report.declaration_cases).scope),
    /not validation impact, capability fit or reusable qualification/u,
  );
  const review = record(report.compatibility_fixture_review);
  assert.equal(review.status, "requires-review");
  assert.deepEqual(record(record(review.collections).port_ids).unreviewed_ids, [
    "unreviewed-proposal-port",
  ]);
  assert.deepEqual(record(record(review.collections).source_profile_ids).missing_expected_ids, [
    "added-source",
  ]);
  assert.equal(record(record(review.collections).port_ids).expected_count, 2);
  assert.deepEqual(
    readFileSync(join(fixture.catalogs, "catalog-legacy-additions-fixture.json")),
    expectedBytes,
  );
  assert.equal(review.fixture_sha256, createHash("sha256").update(expectedBytes).digest("hex"));
});

void test("proposal identity report separates insertion from unchanged shared-repository siblings", () => {
  const before = proposalFixture();
  const after = structuredClone(before);
  after.ports.unshift({ ...requiredFixture(after.ports[0]), id: "new", name: "New port" });
  const report = compareProposal(before, after);
  assert.ok(report.differences.some((change) => change.path === "$.ports[0].id"));
  assert.deepEqual(
    report.proposal_changes.ports.map(({ port_id, action, name_after }) => ({
      port_id,
      action,
      name_after,
    })),
    [{ port_id: "new", action: "added", name_after: "New port" }],
  );
  assert.deepEqual(report.proposal_changes.order_changes, [
    {
      collection: "ports",
      before: ["first", "second"],
      after: ["new", "first", "second"],
    },
  ]);
  assert.deepEqual(report.proposal_changes.source_records, []);
  assert.deepEqual(compareProposal(before, after), report);
});

void test("proposal identity report retains exact source execution persistence and unclassified changes", () => {
  const before = proposalFixture();
  const after = structuredClone(before);
  const port = requiredFixture(after.ports[1]);
  port.source_profile = "replacement-source";
  requiredFixture(port.executable_hints)["linux-x86-64"] = ["replacement"];
  port.persistent_paths = ["replacement-saves"];
  port.n64_runtime_at_executable_parent = true;
  requiredFixture(port.release).user_prepared = {
    "linux-x86-64": { mutable_paths: ["player-data"] },
  };
  port.summary = "Changed description";
  requiredFixture(after.source_catalog.identities[0]).label = "Changed shared source";
  const report = compareProposal(before, after);
  const change = requiredFixture(report.proposal_changes.ports[0]);
  assert.equal(change.port_id, "second");
  assert.equal(change.name_before, "Port second");
  assert.equal(change.name_after, "Port second");
  assert.deepEqual(change.changes.source, [
    { path: "$.source_profile", before: "shared-source", after: "replacement-source" },
  ]);
  assert.deepEqual(requiredFixture(change.changes.execution[0]), {
    path: "$.executable_hints.linux-x86-64[0]",
    before: "game",
    after: "replacement",
  });
  assert.ok(change.changes.persistence.some((item) => item.path === "$.persistent_paths[0]"));
  assert.deepEqual(
    change.changes.execution.find((item) => item.path === "$.n64_runtime_at_executable_parent"),
    { path: "$.n64_runtime_at_executable_parent", after: true },
  );
  assert.ok(
    change.changes.persistence.some(
      (item) => item.path === "$.release.user_prepared.linux-x86-64.mutable_paths",
    ),
  );
  assert.ok(change.changes.other.some((item) => item.path === "$.summary"));
  assert.deepEqual(report.proposal_changes.source_records, [
    {
      collection: "source_catalog.identities",
      id: "shared-source",
      action: "modified",
      label_before: "Shared source",
      label_after: "Changed shared source",
      differences: [{ path: "$.label", before: "Shared source", after: "Changed shared source" }],
    },
  ]);
});

void test("proposal identity report preserves removals ordering and hostile identities without merging them", () => {
  const before = proposalFixture();
  // Authored filenames require stable port IDs; prototype-shaped retained source
  // identities still exercise the report's untrusted-key boundary separately.
  before.ports.push({
    ...requiredFixture(before.ports[0]),
    id: "constructor",
    name: "constructor",
  });
  before.source_catalog.identities.push({ id: "__proto__", label: "Retained source" });
  const after = structuredClone(before);
  after.ports.shift();
  after.ports.reverse();
  requiredFixture(after.ports.find((port) => port.id === "constructor")).launch_arguments = [
    "--reviewed",
  ];
  after.source_catalog.identities = [{ id: "__proto__", label: "Reviewed source" }];
  const report = compareProposal(before, after);
  assert.deepEqual(
    report.proposal_changes.ports.map(({ port_id, action }) => ({ port_id, action })),
    [
      { port_id: "first", action: "removed" },
      { port_id: "constructor", action: "modified" },
    ],
  );
  assert.equal(requiredFixture(report.proposal_changes.ports[0]).name_after, null);
  assert.deepEqual(requiredFixture(report.proposal_changes.ports[1]).changes.execution, [
    { path: "$.launch_arguments", after: ["--reviewed"] },
  ]);
  assert.equal(requiredFixture(report.proposal_changes.source_records[0]).action, "removed");
  assert.equal(requiredFixture(report.proposal_changes.source_records[1]).id, "__proto__");
  assert.equal(requiredFixture(report.proposal_changes.source_records[1]).action, "modified");
  assert.deepEqual(
    report.proposal_changes.order_changes.map((item) => item.collection),
    ["ports", "source_catalog.identities"],
  );
  const ordered = structuredClone(before);
  ordered.ports.reverse();
  const reorder = compareProposal(before, ordered).proposal_changes;
  assert.deepEqual(reorder.ports, []);
  assert.equal(reorder.order_changes.length, 1);
});

void test("proposal identity report refuses duplicate historical identities instead of losing a record", () => {
  const before = proposalFixture();
  const after = structuredClone(before);
  before.source_catalog.validators = [{ id: "validator" }, { id: "validator" }];
  const fixture = isolatedGenerator();
  writeFileSync(
    join(fixture.catalogs, "catalog-schema2-migration-fixture.json"),
    JSON.stringify(before),
  );
  writeFileSync(join(fixture.catalogs, "catalog-current-authoring.json"), JSON.stringify(after));
  const result = fixture.run("--compare-historical");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /source_catalog.validators has a missing or duplicate record identity/,
  );
  assert.equal(result.stdout, "");
});

void test("proposal identity report keeps added empty own fields and exact null values", () => {
  const before = proposalFixture();
  const after = structuredClone(before);
  Object.defineProperty(requiredFixture(after.ports[0]), "__proto__", {
    value: {},
    enumerable: true,
  });
  requiredFixture(after.ports[0]).source_profile = null;
  const change = requiredFixture(compareProposal(before, after).proposal_changes.ports[0]);
  assert.deepEqual(change.changes.other, [{ path: "$.__proto__", after: {} }]);
  assert.deepEqual(change.changes.source, [
    { path: "$.source_profile", before: "shared-source", after: null },
  ]);
});

void test("proposal identity report leaves similarly named unknown presentation fields unclassified", () => {
  const before = proposalFixture();
  const after = structuredClone(before);
  requiredFixture(after.ports[0]).presentation = {
    source_requirements: [],
    saves_and_settings: "external_user_owned",
    source_requirements_extra: "unclassified source wording",
    saves_and_settings_extra: "unclassified persistence wording",
  };
  const change = requiredFixture(compareProposal(before, after).proposal_changes.ports[0]);
  assert.deepEqual(
    change.changes.source.map((item) => item.path),
    ["$.presentation.source_requirements"],
  );
  assert.deepEqual(
    change.changes.persistence.map((item) => item.path),
    ["$.presentation.saves_and_settings"],
  );
  assert.deepEqual(
    change.changes.other.map((item) => item.path),
    ["$.presentation.saves_and_settings_extra", "$.presentation.source_requirements_extra"],
  );
});

void test("semantic diff retains own fields colliding with Object.prototype", () => {
  const fixture = isolatedGenerator();
  const currentPath = join(fixture.catalogs, "catalog-current-authoring.json");
  const before = readFileSync(currentPath, "utf8");
  writeFileSync(join(fixture.catalogs, "catalog-schema2-migration-fixture.json"), before);
  const current = fixtureJson(before);
  for (const [key, value] of Object.entries(
    fixtureJson('{"__proto__":{},"constructor":{},"toString":{}}'),
  ))
    Object.defineProperty(current, key, { value, enumerable: true });
  writeFileSync(currentPath, JSON.stringify(current));
  const result = fixture.run("--compare-historical");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixtureJson(result.stdout).differences, [
    { path: "$.__proto__", after: {} },
    { path: "$.constructor", after: {} },
    { path: "$.toString", after: {} },
  ]);
});

void test("semantic comparison reports every historical-to-current difference", () => {
  const result = run("--compare-historical");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const comparison = fixtureJson(result.stdout);
  assert.equal(typeof comparison.equal, "boolean");
  assert.match(text(comparison.historical_sha256), /^[0-9a-f]{64}$/u);
  assert.match(text(comparison.current_sha256), /^[0-9a-f]{64}$/u);
  assert.ok(Array.isArray(comparison.differences));
  assert.equal(comparison.equal, comparison.differences.length === 0);
  for (const difference of records(comparison.differences))
    assert.match(text(difference.path), /^\$/u);
});
