import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assembleCatalogRecords,
  checkedAuthoredPort,
  readCatalogSource,
} from "./catalog-authoring.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { preparePort } from "./prepare-port.mts";
import {
  assessUpstreamLineage,
  checkLineageChange,
  checkLineageIdentities,
  checkObservedRepository,
  lineageDecisionDigest,
} from "./upstream-lineage.mts";
import type { LineageDecision, UpstreamIdentity, UpstreamLineage } from "./upstream-lineage.mts";

const original: UpstreamIdentity = {
  project_url: "https://github.com/fixture/original",
  repository: { host: "github.com", id: "123" },
};
const moved: UpstreamIdentity = {
  project_url: "https://github.com/fixture/moved",
  repository: { host: "github.com", id: "123" },
};
const sourceRoot = fileURLToPath(new URL("../crates/portcove-core/catalog/", import.meta.url));

function port(id = "lineage-fixture", issue = 900001): AuthoredPort {
  return {
    format_version: 1,
    listing: {
      id,
      issue_number: issue,
      project_url: original.project_url,
      name: "Fixture",
      summary: "Lineage fixture.",
    },
    upstream_lineage: {
      format_version: 1,
      target_key: "fixture-game",
      origin: structuredClone(original),
      decisions: [],
    },
  };
}
function lineage(record: AuthoredPort): UpstreamLineage {
  assert.ok(record.upstream_lineage);
  return record.upstream_lineage;
}
function decision(from = original, to = moved): LineageDecision {
  return {
    from: structuredClone(from),
    to: structuredClone(to),
    relationship: "relocation",
    outcome: "accepted",
    rationale: "Independent review reconciled provider identity and attributable project history.",
    evidence: [
      {
        kind: "supporting",
        reference: "https://example.org/retained-evidence",
        note: "Synthetic attributable identity and history evidence.",
      },
    ],
    reconsider_when: "New contradictory provider or maintainer evidence requires a new review.",
  };
}
function reviewed(record: AuthoredPort, entry: LineageDecision) {
  entry.review = {
    reference: "https://example.org/independent-review",
    decision_sha256: lineageDecisionDigest(record, lineage(record), entry),
  };
  return entry;
}
function append(record: AuthoredPort, entry: LineageDecision) {
  lineage(record).decisions.push(reviewed(record, entry));
  if (entry.outcome === "accepted" && ["relocation", "successor"].includes(entry.relationship))
    record.listing.project_url = entry.to.project_url;
  return record;
}

void test("legacy records remain unassessed and may acquire an absent canonical issue", () => {
  const record = port();
  delete record.upstream_lineage;
  delete record.listing.issue_number;
  assert.equal(assessUpstreamLineage(record).status, "legacy-unassessed");
  const proposed = structuredClone(record);
  proposed.listing.issue_number = 900001;
  assert.equal(checkLineageChange(record, proposed).status, "legacy-unassessed");
  proposed.listing.project_url = moved.project_url;
  assert.throws(() => checkLineageChange(record, proposed), /another origin/u);
});

void test("a reviewed relocation preserves port identity and every previous origin", () => {
  const before = port();
  const after = append(structuredClone(before), decision());
  assert.deepEqual(checkLineageChange(before, after).history, [original, moved]);
  assert.equal(after.listing.id, before.listing.id);
  assert.equal(after.listing.issue_number, before.listing.issue_number);
  assert.deepEqual(assessUpstreamLineage(before).history, [original]);
});

void test("cross-host relocation uses provider coordinates without replacing the canonical port", () => {
  const target = {
    project_url: "https://gitlab.com/fixture/port",
    repository: { host: "gitlab.com", id: "999" },
  };
  const before = port();
  const after = append(structuredClone(before), decision(original, target));
  assert.deepEqual(checkLineageChange(before, after).current, target);
});

void test("a successor requires its own reviewed continuity, not an inherited repository ID", () => {
  const before = port();
  const target = {
    project_url: "https://github.com/new-maintainer/continued",
    repository: { host: "github.com", id: "456" },
  };
  const entry = decision(original, target);
  entry.relationship = "successor";
  const after = append(structuredClone(before), entry);
  assert.deepEqual(checkLineageChange(before, after).current, target);
});

void test("an unresolved or rejected proposal never changes the accepted origin", () => {
  for (const outcome of ["unresolved", "rejected"] as const) {
    const record = port();
    const entry = decision();
    entry.outcome = outcome;
    entry.evidence[0]!.kind = "context";
    lineage(record).decisions.push(entry);
    assert.deepEqual(assessUpstreamLineage(record).current, original);
    record.listing.project_url = moved.project_url;
    assert.throws(() => checkedAuthoredPort(record), /last accepted/u);
  }
});

void test("unreviewed, weak-only and contradictory evidence cannot accept a transition", () => {
  const unreviewed = port();
  lineage(unreviewed).decisions.push(decision());
  assert.throws(() => assessUpstreamLineage(unreviewed), /separate review/u);
  for (const kind of ["context", "contradiction"] as const) {
    const record = port();
    const entry = decision();
    entry.evidence[0]!.kind = kind;
    append(record, entry);
    assert.throws(() => assessUpstreamLineage(record), /alone|contradiction/u);
  }
});

void test("review is invalidated by changing exact identity, rationale, port, issue or target", () => {
  const record = append(port(), decision());
  const changes: ((record: AuthoredPort) => void)[] = [
    (r) => {
      lineage(r).decisions[0]!.to.repository!.id = "changed";
    },
    (r) => {
      lineage(r).decisions[0]!.rationale = "Different assessment.";
    },
    (r) => {
      r.listing.id = "other-port";
    },
    (r) => {
      r.listing.issue_number = 900002;
    },
    (r) => {
      lineage(r).target_key = "other-game";
    },
  ];
  for (const change of changes) {
    const altered = structuredClone(record);
    change(altered);
    assert.throws(() => assessUpstreamLineage(altered), /exact decision/u);
  }
});

void test("provider-ID reuse at the same name and false same-host relocations are refused", () => {
  for (const project_url of [original.project_url, moved.project_url]) {
    const target = { project_url, repository: { host: "github.com", id: "999" } };
    const record = append(port(), decision(original, target));
    assert.throws(() => assessUpstreamLineage(record), /Repository-name reuse/u);
  }
  assert.throws(() => checkObservedRepository(port(), 999), /repository-name reuse/u);
  assert.doesNotThrow(() => checkObservedRepository(port(), 123));
  assert.doesNotThrow(() => checkObservedRepository(port(), undefined));
});

void test("failed transitions and reviewed reversals retain ordered history", () => {
  const before = append(port(), decision());
  const after = structuredClone(before);
  const failed = decision(moved, { project_url: "https://example.org/unresolved" });
  failed.outcome = "unresolved";
  failed.evidence[0]!.kind = "context";
  lineage(after).decisions.push(failed);
  append(after, decision(moved, original));
  assert.deepEqual(checkLineageChange(before, after).history, [original, moved, original]);
  assert.deepEqual(assessUpstreamLineage(before).history, [original, moved]);
  const rewritten = structuredClone(after);
  lineage(rewritten).decisions.splice(0, 1);
  assert.throws(() => checkLineageChange(before, rewritten), /retained upstream history/u);
  const removed = structuredClone(before);
  delete removed.upstream_lineage;
  assert.throws(() => checkLineageChange(before, removed), /Retain the original lineage/u);
});

void test("forks, alternatives and independent products use a distinct canonical record", () => {
  for (const relationship of ["fork", "alternative", "independent"] as const) {
    const record = port();
    const related = port("separate-port", 900002);
    const target = {
      project_url: "https://github.com/fixture/separate",
      repository: { host: "github.com", id: "456" },
    };
    related.listing.project_url = target.project_url;
    lineage(related).origin = target;
    const entry = decision(original, target);
    entry.relationship = relationship;
    entry.related_port = { id: related.listing.id, issue_number: related.listing.issue_number! };
    append(record, entry);
    assert.deepEqual(assessUpstreamLineage(record).current, original);
    assert.doesNotThrow(() => checkLineageIdentities([record, related]));
    assert.throws(() => checkLineageIdentities([record]), /separate canonical/u);
    related.listing.issue_number = 900003;
    assert.throws(() => checkLineageIdentities([record, related]), /separate canonical/u);
  }
});

void test("canonical issues and target-specific historical aliases reject duplicate implementations", () => {
  const first = append(port(), decision());
  const alias = port("alias-port", 900002);
  assert.throws(() => checkLineageIdentities([first, alias]), /Duplicate upstream implementation/u);
  lineage(alias).target_key = "another-game";
  assert.doesNotThrow(() => checkLineageIdentities([first, alias]));
  assert.ok(first.listing.issue_number);
  alias.listing.issue_number = first.listing.issue_number;
  assert.throws(() => checkLineageIdentities([first, alias]), /Canonical issue/u);
});

void test("malformed, oversized and ambiguous lineage records fail before projection", () => {
  const inputs: unknown[] = [
    null,
    { ...lineage(port()), ignored: true },
    { ...lineage(port()), decisions: Array.from({ length: 65 }, () => decision()) },
    { ...lineage(port()), origin: { project_url: "https://user:secret@example.org/project" } },
    { ...lineage(port()), origin: { ...original, repository: { host: "gitlab.com", id: "123" } } },
  ];
  for (const upstream_lineage of inputs)
    assert.throws(() => checkedAuthoredPort({ ...port(), upstream_lineage }));
});

void test("JSON arrays and objects cannot impersonate decision enums or conceal contradictions", () => {
  for (const field of ["relationship", "outcome", "kind"]) {
    for (const value of [
      [field === "relationship" ? "successor" : field === "outcome" ? "accepted" : "contradiction"],
      {},
    ]) {
      const record = append(port(), decision());
      const entry = lineage(record).decisions[0]!;
      if (field === "kind") Object.assign(entry.evidence[0]!, { kind: value });
      else Object.assign(entry, { [field]: value });
      reviewed(record, entry);
      assert.throws(() => checkedAuthoredPort(record), /Lineage decision|lineage evidence/u);
    }
  }
  const record = append(port(), decision());
  const entry = lineage(record).decisions[0]!;
  entry.evidence.push({ ...entry.evidence[0]! });
  Object.assign(entry.evidence[1]!, { kind: ["contradiction"] });
  reviewed(record, entry);
  assert.throws(() => checkedAuthoredPort(record), /lineage evidence/u);
});

void test("known GitHub URL spellings cannot duplicate an implementation without a provider ID", () => {
  for (const project_url of [
    "https://github.com/FIXTURE/ORIGINAL/",
    "https://github.com/fixture/original.git",
  ]) {
    const first = port();
    delete lineage(first).origin.repository;
    const duplicate = port("duplicate-port", 900002);
    duplicate.listing.project_url = project_url;
    lineage(duplicate).origin = { project_url };
    assert.throws(() => checkLineageIdentities([first, duplicate]), /Duplicate upstream/u);
  }
  const fragment = port();
  lineage(fragment).origin.project_url += "#readme";
  assert.throws(() => checkedAuthoredPort(fragment), /repository root/u);
  const legacy = port();
  delete legacy.upstream_lineage;
  legacy.listing.project_url += "/tree/main#readme";
  assert.equal(assessUpstreamLineage(legacy).status, "legacy-unassessed");
});

void test("self-consistent historical rewrites and repeated decisions are refused against a baseline", () => {
  const before = append(port(), decision());
  const rewritten = structuredClone(before);
  lineage(rewritten).decisions[0]!.rationale = "Rewritten historical rationale.";
  reviewed(rewritten, lineage(rewritten).decisions[0]!);
  assert.throws(() => checkLineageChange(before, rewritten), /every prior decision/u);
  const repeated = port();
  const unresolved = decision();
  unresolved.outcome = "unresolved";
  lineage(repeated).decisions.push(unresolved, structuredClone(unresolved));
  assert.throws(() => assessUpstreamLineage(repeated), /Duplicate lineage/u);
});

void test("real retained decisions distinguish accepted ReCut relocation from unresolved Star Fox succession", () => {
  const authored = readCatalogSource(sourceRoot);
  const recut = authored.records.find((record) => record.listing.id === "paper-mario-recut")!;
  const star = authored.records.find((record) => record.listing.id === "star-fox-enhanced")!;
  const moved = assessUpstreamLineage(recut);
  assert.equal(moved.decisions[0]!.outcome, "accepted");
  assert.equal(moved.current.repository?.id, "1247923238");
  assert.equal(moved.history.length, 2);
  const unresolved = assessUpstreamLineage(star);
  assert.equal(unresolved.decisions[0]!.outcome, "unresolved");
  assert.equal(unresolved.current.project_url, "https://github.com/kandowontu/starfox-enhanced");
  assert.equal(unresolved.history.length, 1);
  const { ports: _ports, ...shared } = authored.catalog;
  const legacy = authored.records.map(({ upstream_lineage: _lineage, ...record }) => record);
  const withoutMetadata = assembleCatalogRecords(shared, legacy);
  assert.deepEqual(withoutMetadata.catalog, authored.catalog);
  assert.deepEqual(withoutMetadata.directory, authored.directory);
});

void test("lineage metadata never changes runtime projections, accepted releases or qualification", () => {
  const authored = readCatalogSource(sourceRoot);
  const existing = authored.records.find(
    (record) => record.integration && record.listing.issue_number,
  )!;
  assert.ok(existing);
  const records = structuredClone(authored.records);
  const changed = records.find((record) => record.listing.id === existing.listing.id)!;
  changed.upstream_lineage = {
    format_version: 1,
    target_key: "retained-contract-fixture",
    origin: { project_url: changed.listing.project_url },
    decisions: [],
  };
  const baseline = JSON.stringify(authored.catalog);
  const { ports: _ports, ...shared } = authored.catalog;
  const result = assembleCatalogRecords(shared, records);
  assert.equal(JSON.stringify(result.catalog), baseline);
  assert.deepEqual(result.directory, authored.directory);
  assert.deepEqual(changed.integration, existing.integration);
  assert.equal(JSON.stringify(authored.catalog), baseline);
});

function preparationFixture(record: AuthoredPort) {
  const root = mkdtempSync(join(tmpdir(), "portcove-lineage-"));
  const catalogRoot = join(root, "catalog");
  cpSync(sourceRoot, catalogRoot, { recursive: true });
  const recordFile = join(catalogRoot, "ports", `${record.listing.id}.json`);
  writeFileSync(recordFile, JSON.stringify(record));
  return {
    root,
    catalogRoot,
    recordFile,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
function metadataFetcher(id: number, name = "fixture/moved"): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({ id, full_name: name, name: "Fixture", description: "A fixture." }),
      { status: 200 },
    );
}

void test("production preparation accepts reviewed location change without rewriting accepted catalog files", async () => {
  const before = port();
  const fixture = preparationFixture(before);
  try {
    const retained = readFileSync(fixture.recordFile);
    const candidate = append(structuredClone(before), decision());
    const result = await preparePort({
      catalogRoot: fixture.catalogRoot,
      outputDirectory: join(fixture.root, "proposal"),
      record: candidate,
      facts: { fetcher: metadataFetcher(123) },
      artwork: { inspectGame: () => [] },
    });
    assert.deepEqual(result.report.lineage.current, moved);
    assert.deepEqual(readFileSync(fixture.recordFile), retained);
    const output = result.report.files.records.find((entry) => entry.id === candidate.listing.id);
    assert.ok(output);
    const proposed = checkedAuthoredPort(JSON.parse(readFileSync(output.path, "utf8")));
    assert.deepEqual(proposed.upstream_lineage, candidate.upstream_lineage);
  } finally {
    fixture.clean();
  }
});

void test("production preparation refuses origin changes and live name reuse while retaining inputs", async () => {
  const before = port();
  const fixture = preparationFixture(before);
  try {
    const retained = readFileSync(fixture.recordFile);
    await assert.rejects(
      preparePort({
        catalogRoot: fixture.catalogRoot,
        outputDirectory: join(fixture.root, "changed-origin"),
        id: before.listing.id,
        projectUrl: moved.project_url,
        facts: { fetcher: metadataFetcher(123) },
        artwork: { inspectGame: () => [] },
      }),
      /last accepted/u,
    );
    await assert.rejects(
      preparePort({
        catalogRoot: fixture.catalogRoot,
        outputDirectory: join(fixture.root, "reused-name"),
        id: before.listing.id,
        projectUrl: original.project_url,
        facts: { fetcher: metadataFetcher(999, "fixture/original") },
        artwork: { inspectGame: () => [] },
      }),
      /repository-name reuse/u,
    );
    assert.deepEqual(readFileSync(fixture.recordFile), retained);
  } finally {
    fixture.clean();
  }
});
