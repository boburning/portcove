import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
    { type: "current-upstream", key: "upstream:repository:github.com:2" },
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
    { type: "candidate-origin", key: "upstream:repository:github.com:77" },
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

void test("GemRB shares one repository identity across separate listings and journal observations", () => {
  const directory = new URL("../crates/portcove-core/catalog/ports/", import.meta.url);
  const records = readdirSync(directory)
    .filter((file) => file.endsWith("-gemrb.json"))
    .map(
      (file) =>
        JSON.parse(readFileSync(new URL(file, directory), "utf8")) as Parameters<
          typeof buildUniverse
        >[0]["records"][number],
    );
  const legacyUrl = "https://github.com/gemrb/gemrb";
  const unrelated = {
    listing: { id: "reused-repository-name", project_url: legacyUrl, issue_number: 42 },
    upstream_lineage: lineage("unrelated-game", legacyUrl, "1234"),
  };
  const intake = new Map<string, unknown>([
    ["intake:17", { slots: [{ repository_id: 3297830, linked_issue: 73 }] }],
    ["intake:19", { slots: [{ repository_id: 2000 }, { repository_id: -1 }] }],
  ]);
  const issues = new Map<string, unknown>([
    ["issue:73", { number: 73, title: "A closed observation follow-up", state: "CLOSED" }],
    ["issue:42", { number: 42, title: "A separately tracked implementation", state: "OPEN" }],
  ]);
  const input = {
    records: [
      ...records,
      unrelated,
      { listing: { id: "unverified-same-url", project_url: legacyUrl } },
    ],
    intake,
    issues,
  };
  const universe = buildUniverse(input);
  assert.deepEqual(buildUniverse({ ...input, records: [...input.records].reverse() }), universe);
  const byKey = new Map(universe.map((item) => [item.key, item]));
  const upstream = byKey.get("upstream:repository:github.com:3297830");
  assert.equal(upstream?.name, legacyUrl);
  assert.deepEqual(upstream.relations, [
    { type: "observed-in-intake", key: "intake:17" },
    { type: "serves-listing", key: "port:baldur-s-gate-ii-enhanced-edition-gemrb" },
    { type: "serves-listing", key: "port:baldur-s-gate-ii-original-gemrb" },
    { type: "serves-listing", key: "port:baldur-s-gate-original-gemrb" },
    { type: "serves-listing", key: "port:icewind-dale-ii-gemrb" },
    { type: "serves-listing", key: "port:icewind-dale-original-gemrb" },
    { type: "serves-listing", key: "port:planescape-torment-original-gemrb" },
  ]);
  assert.equal(
    byKey.get("port:baldur-s-gate-ii-original-gemrb")?.target_key,
    "baldur-s-gate-ii-original-gemrb",
  );
  assert.equal(
    byKey.get("port:baldur-s-gate-ii-enhanced-edition-gemrb")?.target_key,
    "baldur-s-gate-ii-enhanced-edition-gemrb",
  );
  assert.ok(byKey.get("port:unverified-same-url")?.identity_gap);
  assert.equal(byKey.get("port:unverified-same-url")?.relations.length, 0);
  assert.equal(byKey.get("upstream:repository:github.com:2000")?.kind, "upstream");
  assert.ok(!byKey.has("upstream:repository:github.com:-1"));
  assert.equal(byKey.get("issue:73")?.name, "A closed observation follow-up");
  assert.equal(byKey.get("issue:42")?.name, "A separately tracked implementation");
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

void test("canonical game identities remain distinct from retained lineage scopes and port counts", () => {
  const make = (id: string, gameId?: string) => ({
    listing: {
      id,
      issue_number: id === "first" ? 1 : 2,
      project_url: `https://github.com/test/${id}`,
      ...(gameId ? { original_game: { id: gameId } } : {}),
    },
    upstream_lineage: lineage("shared-target", `https://github.com/test/${id}`, id),
  });
  const partial = buildUniverse({ records: [make("first", "original"), make("second")] });
  const port = partial.find(({ key }) => key === "port:first")!;
  assert.equal(port.original_game_id, "original");
  assert.equal(port.target_key, "shared-target");
  assert.match(port.grouping_gap ?? "", /Partial original-game mapping/u);
  assert.equal(
    partial.find(({ key }) => key === "port:second")?.original_game_id,
    null,
    "lineage supplies no automatic game fallback",
  );
  assert.equal(
    universeGroups(partial)
      .get("target:shared-target")
      ?.filter(({ kind }) => kind === "port").length,
    2,
  );
  assert.ok(
    (universeGroups(partial).get("target:shared-target")?.length ?? 0) > 2,
    "implementation identities must not inflate port coverage",
  );
  const conflicts = buildUniverse({
    records: [make("first", "original"), make("second", "remake")],
  });
  assert.ok(
    conflicts
      .filter(({ kind }) => kind === "port")
      .every(({ grouping_gap }) => grouping_gap?.includes("multiple original-game IDs")),
  );
  assert.deepEqual(
    [...universeGroups(conflicts).keys()].sort(),
    [
      "target:shared-target",
      "upstream:repository:github.com:first",
      "upstream:repository:github.com:second",
    ],
    "descriptive evidence preserves the lineage scope and separate upstream repository entries",
  );
});
