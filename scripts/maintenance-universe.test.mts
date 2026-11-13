import assert from "node:assert/strict";
import test from "node:test";
import { buildUniverse, universeGroups } from "./maintenance-universe.mts";
import { lineageDecisionDigest, type LineageDecision } from "./upstream-lineage.mts";

const lineage = (target: string, url: string, id: string, decisions: unknown[] = []) => ({
  format_version: 1 as const,
  target_key: target,
  origin: { project_url: url, repository: { host: "github.com", id } },
  decisions: decisions as never[],
});

void test("the universe keeps every canonical identity distinct and relates them as edges", () => {
  const fork = {
    listing: {
      id: "alpha-fork",
      name: "Alpha",
      original_game_title: "Shared Game",
      project_url: "https://github.com/Other/Alpha",
      issue_number: 11,
    },
    upstream_lineage: lineage("shared-game", "https://github.com/Other/Alpha", "2"),
  };
  const decision: LineageDecision = {
    from: {
      project_url: "https://github.com/Other/Alpha",
      repository: { host: "github.com", id: "2" },
    },
    to: {
      project_url: "https://github.com/Owner/Alpha",
      repository: { host: "github.com", id: "1" },
    },
    relationship: "fork",
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
    related_port: { id: "alpha", issue_number: 10 },
  };
  decision.review = {
    reference: "https://example.org/independent-review",
    decision_sha256: lineageDecisionDigest(fork, fork.upstream_lineage, decision),
  };
  fork.upstream_lineage.decisions.push(decision as never);
  const universe = buildUniverse({
    records: [
      {
        listing: {
          id: "alpha",
          name: "Alpha",
          original_game_title: "Shared Game",
          project_url: "https://github.com/Owner/Alpha",
          issue_number: 10,
        },
        upstream_lineage: lineage("shared-game", "https://github.com/Owner/Alpha", "1"),
      },
      fork,
      {
        listing: { id: "broken", project_url: "https://example.test/broken" },
        upstream_lineage: { format_version: 1, target_key: "x" } as never,
      },
    ],
    issues: new Map<string, unknown>([
      ["issue:10", { number: 10, title: "Alpha", catalog_ids: ["alpha"], port_keys: [] }],
      ["issue:20", { number: 20, title: "Alpha", catalog_ids: [], port_keys: ["beta-port"] }],
      ["issue:30", { number: 30, title: "Unrelated", catalog_ids: [], port_keys: [] }],
    ]),
    intake: new Map<string, unknown>([
      [
        "intake:5",
        {
          slots: [
            {
              port_key: "gamma",
              linked_issue: 20,
              upstream: "https://github.com/someone/gamma",
              repository_id: 77,
            },
            { port_key: null },
          ],
        },
      ],
    ]),
    definitions: ["definition:official/alpha"],
    catalogComplete: true,
  });
  const byKey = new Map(universe.map((entry) => [entry.key, entry]));
  // Same name and game never merge two ports; a fork is an edge.
  assert.equal(byKey.get("port:alpha")?.name, byKey.get("port:alpha-fork")?.name);
  assert.deepEqual(byKey.get("port:alpha-fork")?.relations, [
    {
      type: "retains-implementation",
      key: "implementation:repository:github.com:2:shared-game",
    },
    {
      type: "retains-implementation",
      key: "implementation:url:https://github.com/other/alpha:shared-game",
    },
    { type: "canonical-work", key: "issue:11" },
    { type: "fork", key: "port:alpha" },
  ]);
  assert.deepEqual(byKey.get("implementation:repository:github.com:1:shared-game")?.relations, [
    { type: "implemented-by", key: "port:alpha" },
  ]);
  // An issue-only implementation is searchable without inventing a catalog identity.
  assert.equal(byKey.get("issue:20")?.kind, "issue");
  assert.deepEqual(byKey.get("issue:20")?.port_keys, ["beta-port"]);
  assert.ok(!byKey.has("port:beta-port"));
  assert.ok(!byKey.has("issue:30"), "an issue naming no port is not an implementation");
  assert.deepEqual(byKey.get("issue:10")?.relations, [{ type: "tracks-port", key: "port:alpha" }]);
  assert.deepEqual(byKey.get("intake:5")?.port_keys, ["gamma"]);
  assert.deepEqual(byKey.get("intake:5")?.relations, [
    { type: "linked-work", key: "issue:20" },
    { type: "candidate-repository", key: "repository:github.com:77" },
    { type: "candidate-upstream", key: "url:https://github.com/someone/gamma" },
  ]);
  assert.equal(byKey.get("definition:official/alpha")?.kind, "definition");
  // A lineage that does not validate keeps its port, with the reason visible.
  assert.ok(byKey.get("port:broken")?.identity_gap);
  assert.deepEqual(byKey.get("port:broken")?.relations, []);
  assert.equal(byKey.get("port:broken")?.target_key, null, "an unvalidated target never groups");
  // Distinct implementations of one game group by lineage target.
  assert.deepEqual(
    universeGroups(universe)
      .get("target:shared-game")
      ?.map(({ key }) => key)
      .filter((key) => key.startsWith("port:")),
    ["port:alpha", "port:alpha-fork"],
  );
  assert.deepEqual(
    universe.map(({ key }) => key),
    [...universe.map(({ key }) => key)].sort(),
  );
});

void test("legacy records and sampled catalogs keep their unknowns visible", () => {
  const universe = buildUniverse({
    records: [{ listing: { id: "legacy", project_url: "https://example.test/legacy" } }],
    issues: new Map<string, unknown>([
      ["issue:40", { number: 40, catalog_ids: ["legacy", "elsewhere"], port_keys: [] }],
    ]),
  });
  const byKey = new Map(universe.map((entry) => [entry.key, entry]));
  assert.match(byKey.get("port:legacy")?.identity_gap ?? "", /legacy-unassessed/u);
  assert.equal(byKey.get("port:legacy")?.target_key, null);
  // A sample cannot call a catalog ID uncataloged.
  assert.deepEqual(byKey.get("issue:40")?.relations, [
    { type: "names-port-catalog-coverage-unknown", key: "port:elsewhere" },
    { type: "tracks-port", key: "port:legacy" },
  ]);
});
