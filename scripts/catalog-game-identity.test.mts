import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyReviewedGameAssignments,
  catalogGameIdentityReport,
  type ReviewedGameAssignment,
} from "./catalog-game-identity.mts";
import { readCatalogSource, type AuthoredPort } from "./catalog-authoring.mts";

const game = (id = "original-game") => ({
  format_version: 1 as const,
  id,
  evidence_urls: ["https://example.org/reviewed-original"],
  source_editions: [],
});
const record = (id: string, target: string, known = false): AuthoredPort => ({
  format_version: 1,
  listing: {
    id,
    issue_number: id === "alpha" ? 1 : id === "beta" ? 2 : 3,
    name: `Implementation ${id}`,
    summary: "A synthetic test implementation.",
    project_url: `https://github.com/test/${id}`,
    original_game_title: "Shared Name",
    ...(known ? { original_game: game() } : {}),
  },
  upstream_lineage: {
    format_version: 1,
    target_key: target,
    origin: { project_url: `https://github.com/test/${id}` },
    decisions: [],
  },
});
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "portcove-game-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "ports"));
  writeFileSync(
    join(root, "catalog-shared.json"),
    json({
      schema_version: 2,
      source_catalog: { identities: [], contracts: [], evidence: [], qualification: [] },
    }),
  );
  const managed = record("alpha", "shared-target", true);
  managed.integration = {
    adapter: "native-portable",
    source_profile: "specific-originals",
    persistent_paths: ["saves"],
    release: { repository: "test/alpha" },
  };
  const records = [managed, record("beta", "shared-target"), record("remake", "remake-target")];
  for (const member of records)
    writeFileSync(join(root, "ports", `${member.listing.id}.json`), json(member));
  const projected = readCatalogSource(root);
  writeFileSync(join(root, "catalog.json"), json(projected.catalog));
  writeFileSync(join(root, "listings.json"), json(projected.directory));
  const assignment = (id: string): ReviewedGameAssignment => ({
    port_id: id,
    expected_sha256: hash(readFileSync(join(root, "ports", `${id}.json`))),
    original_game: game(),
  });
  return { root, records, assignment };
}

void test("audit counts actual ports, exposes partial targets and same-title candidates without grouping them", (t) => {
  const { root } = fixture(t);
  const report = catalogGameIdentityReport(root);
  assert.deepEqual(report.coverage, {
    port_records: 3,
    operational_definitions: 1,
    mapped_ports: 1,
    original_game_ids: 1,
    unresolved_project_entries: 2,
    production_groups: 3,
    multi_port_lineage_targets: 1,
    multi_port_lineage_members: 2,
    projection_identity_gaps: 0,
  });
  assert.deepEqual(report.lineage_families, [
    {
      key: "target:shared-target",
      port_ids: ["alpha", "beta"],
      original_game_ids: ["original-game"],
      disposition: "review-partial-mapping",
    },
  ]);
  assert.deepEqual(report.title_candidates, [
    { title: "shared name", port_ids: ["alpha", "beta", "remake"] },
  ]);
  assert.equal(report.ports.find(({ port_id }) => port_id === "remake")?.original_game, null);
  const stale = structuredClone(readCatalogSource(root).catalog);
  const first = stale.ports[0]!;
  assert.ok(first.presentation);
  delete first.presentation.original_game;
  writeFileSync(join(root, "catalog.json"), json(stale));
  assert.equal(
    catalogGameIdentityReport(root).coverage.projection_identity_gaps,
    1,
    "an older operational definition must not mask a corrected listing unnoticed",
  );
});

void test("reviewed batch refuses all stale or invalid work before source mutation", (t) => {
  const { root, assignment } = fixture(t);
  const alpha = readFileSync(join(root, "ports", "alpha.json"));
  const beta = assignment("beta");
  const stale = { ...beta, expected_sha256: "0".repeat(64) };
  assert.throws(
    () =>
      applyReviewedGameAssignments(
        root,
        { format_version: 1, assignments: [assignment("alpha"), stale] },
        true,
      ),
    /Stale authored input/u,
  );
  assert.ok(readFileSync(join(root, "ports", "alpha.json")).equals(alpha));
  const invalid = {
    ...beta,
    original_game: { ...game(), evidence_urls: ["http://example.org/unreviewed"] },
  };
  assert.throws(
    () =>
      applyReviewedGameAssignments(
        root,
        { format_version: 1, assignments: [assignment("alpha"), invalid] },
        true,
      ),
    /HTTPS/u,
  );
  assert.ok(readFileSync(join(root, "ports", "alpha.json")).equals(alpha));
  assert.throws(
    () =>
      applyReviewedGameAssignments(
        root,
        {
          format_version: 1,
          assignments: [{ ...assignment("alpha"), original_game: game("replacement-id") }],
        },
        true,
      ),
    /Core preference\/media compatibility/u,
  );
});

void test("explicit assignments preserve source, lineage and unknown fields, then expose generation drift", (t) => {
  const { root, assignment } = fixture(t);
  const before = readCatalogSource(root);
  const input = { format_version: 1 as const, assignments: [assignment("beta")] };
  const source = readFileSync(join(root, "ports", "beta.json"));
  assert.equal(applyReviewedGameAssignments(root, input).written, false);
  assert.ok(readFileSync(join(root, "ports", "beta.json")).equals(source));
  assert.equal(applyReviewedGameAssignments(root, input, true).written, true);
  const after = readCatalogSource(root);
  const betaBefore = before.records.find(({ listing }) => listing.id === "beta")!;
  const betaAfter = after.records.find(({ listing }) => listing.id === "beta")!;
  assert.deepEqual(betaAfter, {
    ...betaBefore,
    listing: { ...betaBefore.listing, original_game: game() },
  });
  assert.deepEqual(
    after.records.find(({ listing }) => listing.id === "alpha"),
    before.records.find(({ listing }) => listing.id === "alpha"),
  );
  const report = catalogGameIdentityReport(root);
  assert.equal(report.coverage.production_groups, 2);
  assert.equal(report.coverage.projection_identity_gaps, 1);
  assert.equal(report.lineage_families[0]?.disposition, "mapped");
  assert.throws(() => applyReviewedGameAssignments(root, input, true), /Stale authored input/u);
});

void test("reviewed unresolved and non-single-game decisions remain authoring-only", (t) => {
  const { root } = fixture(t);
  const path = join(root, "ports", "remake.json");
  const before = JSON.parse(readFileSync(path, "utf8")) as AuthoredPort;
  const review = {
    disposition: "unresolved" as const,
    reason:
      "Primary source facts are unavailable; the same-name remake relation needs upstream evidence.",
    evidence_urls: ["https://example.org/retained-missing-source"],
  };
  applyReviewedGameAssignments(
    root,
    {
      format_version: 1,
      assignments: [
        {
          port_id: "remake",
          expected_sha256: hash(readFileSync(path)),
          original_game_review: review,
        },
      ],
    },
    true,
  );
  const after = readCatalogSource(root);
  assert.equal(
    after.directory.listings.find(({ id }) => id === "remake")?.original_game,
    undefined,
  );
  assert.deepEqual(
    after.records.find(({ listing }) => listing.id === "remake"),
    { ...before, original_game_review: review },
  );
});
