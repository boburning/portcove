import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HEALTH_INPUTS_VERSION,
  healthArtifactHash,
  healthCatalogPortHash,
  healthEndpointHash,
  healthLineageInputs,
  healthPortHash,
  healthPortInputs,
} from "./upstream-health-inputs.mts";
import { discoverUpstreamHealthScope, selectUpstreamHealthScope } from "./upstream-health-plan.mts";
import { lineageDecisionDigest, type LineageDecision } from "./upstream-lineage.mts";

const catalogPath = "crates/portcove-core/catalog/catalog.json";
const authoringPath = (id: string) => `crates/portcove-core/catalog/ports/${id}.json`;
const port = (id: string) => ({
  id,
  name: id,
  summary: "A catalog description.",
  project_url: `https://github.com/owner/${id}`,
  adapter: "owned",
  platforms: ["windows-x86-64"],
  release: { repository: `owner/${id}` },
});
const catalog = () => ({ schema_version: 2, ports: [port("game"), port("other")] });
const authoring = (id: string) => ({
  listing: {
    id,
    project_url: `https://github.com/owner/${id}`,
    issue_number: id === "game" ? 1 : 2,
    name: id,
    summary: "Catalog listing copy.",
    artwork: { image_id: "old-cover" },
  },
  upstream_lineage: {
    format_version: 1 as const,
    target_key: id,
    origin: { project_url: `https://github.com/owner/${id}` },
    decisions: [] as LineageDecision[],
  },
});
function acceptAlternative(record: ReturnType<typeof authoring>) {
  const result = structuredClone(record);
  const decision: LineageDecision = {
    from: result.upstream_lineage.origin,
    to: { project_url: "https://github.com/owner/other" },
    relationship: "alternative",
    outcome: "accepted",
    rationale: "A separately admitted implementation retains its own canonical port.",
    evidence: [
      {
        kind: "supporting",
        reference: "https://example.invalid/review",
        note: "Reviewed attributable evidence.",
      },
    ],
    reconsider_when: "New contradictory provenance evidence is reviewed.",
    related_port: { id: "other", issue_number: 2 },
  };
  decision.review = {
    reference: "https://example.invalid/independent-review",
    decision_sha256: lineageDecisionDigest(result, result.upstream_lineage, decision),
  };
  result.upstream_lineage.decisions.push(decision);
  return result;
}
const change = (file = catalogPath, extra = {}) => ({
  oldPath: file,
  newPath: file,
  status: "M",
  oldMode: "100644",
  newMode: "100644",
  ...extra,
});

void test("health inputs exclude presentation and runtime fields", () => {
  const original = port("game");
  const presentation = {
    ...original,
    name: "A corrected title",
    summary: "A shorter summary",
    artwork: { image_id: "new-cover", image_sha256: "a".repeat(64) },
    source_profile: "new-profile",
    executable_hints: { "windows-x86-64": ["other.exe"] },
    persistent_paths: ["saves"],
    manually_validated_platforms: ["windows-x86-64"],
  };
  assert.equal(healthPortInputs(original).format_version, HEALTH_INPUTS_VERSION);
  assert.equal(healthPortHash(presentation), healthPortHash(original));
  for (const changed of [
    { ...original, project_url: "https://github.com/successor/game" },
    { ...original, release: { repository: "successor/game" } },
    { ...original, upstream_status: "retired" },
    { ...original, adapter: "psx-recomp-managed" },
    { ...original, platforms: ["windows-x86-64", "linux-x86-64"] },
  ])
    assert.notEqual(healthPortHash(changed), healthPortHash(original));
});

void test("every accepted direct-pin identity fact invalidates its monitoring fingerprint", () => {
  const pin = {
    url: "https://github.com/owner/game/releases/download/v1/game.zip",
    version: "v1",
    size: 123,
    sha256: "a".repeat(64),
  };
  const withPin = (artifact: typeof pin) => ({
    ...port("game"),
    release: { provider: "direct-manifest", direct: { "windows-x86-64": artifact } },
  });
  for (const changed of [
    { ...pin, url: pin.url.replace("v1", "v2") },
    { ...pin, version: "v2" },
    { ...pin, size: 124 },
    { ...pin, sha256: "b".repeat(64) },
  ]) {
    assert.notEqual(healthPortHash(withPin(changed)), healthPortHash(withPin(pin)));
    assert.notEqual(
      healthArtifactHash(withPin(changed), "windows-x86-64"),
      healthArtifactHash(withPin(pin), "windows-x86-64"),
    );
  }
});

void test("artifact accounting binds one platform independently of project metadata", () => {
  const artifact = {
    url: "https://github.com/owner/game/releases/download/v1/game.zip",
    version: "v1",
    size: 123,
    sha256: "a".repeat(64),
  };
  const original = {
    ...port("game"),
    release: { provider: "direct-manifest", direct: { "windows-x86-64": artifact } },
  };
  const changedProject = { ...original, project_url: "https://github.com/successor/game" };
  const addedPlatform = {
    ...original,
    release: {
      ...original.release,
      direct: { ...original.release.direct, "linux-x86-64": artifact },
    },
  };
  const originalHash = healthArtifactHash(original, "windows-x86-64");
  assert.equal(healthArtifactHash(changedProject, "windows-x86-64"), originalHash);
  assert.equal(healthArtifactHash(addedPlatform, "windows-x86-64"), originalHash);
  assert.notEqual(healthArtifactHash(addedPlatform, "linux-x86-64"), originalHash);
  assert.throws(() => healthArtifactHash(original, "missing"), /artifact platform/);
});

void test("endpoint accounting preserves distinct project and acquisition roles", () => {
  const original = port("game");
  const movedProject = { ...original, project_url: "https://github.com/successor/game" };
  const hash = (value: unknown, role: "project" | "acquisition") =>
    healthEndpointHash(value, role, "github", "owner/game");
  assert.equal(hash(original, "acquisition"), hash(movedProject, "acquisition"));
  assert.notEqual(hash(original, "project"), hash(movedProject, "project"));
  assert.notEqual(hash(original, "project"), hash(original, "acquisition"));
  assert.notEqual(
    hash(original, "acquisition"),
    hash({ ...original, upstream_status: "retired" }, "acquisition"),
  );
});

void test("lineage freshness binds reviewed authoring facts without presentation churn", () => {
  const input = catalog();
  const original = authoring("game");
  const accepted = acceptAlternative(original);
  const art = structuredClone(original);
  art.listing.artwork.image_id = "new-cover";
  art.listing.name = "New display name";
  art.listing.summary = "New listing copy";
  const hash = (record: unknown, id = "game") => healthCatalogPortHash(input, id, [record]);
  assert.deepEqual(healthLineageInputs(art), healthLineageInputs(original));
  assert.equal(hash(art), hash(original));
  assert.notEqual(hash(accepted), hash(original));
  assert.notEqual(hash(original), healthCatalogPortHash(input, "game"));
  assert.equal(hash(accepted, "other"), hash(original, "other"));
  const changedIssue = structuredClone(original);
  changedIssue.listing.issue_number = 3;
  assert.notEqual(hash(changedIssue), hash(original));
  const invalid = structuredClone(accepted);
  invalid.upstream_lineage.decisions[0]!.review!.decision_sha256 = "a".repeat(64);
  assert.throws(() => hash(invalid), /review does not bind/);
  assert.throws(
    () =>
      hash({
        ...original,
        listing: { ...original.listing, project_url: "https://github.com/owner/wrong" },
      }),
    /Listing origin/,
  );
  assert.throws(() => healthCatalogPortHash(input, "game", [original, original]), /duplicate/);
});

void test("mixed artwork and documentation changes make no live obligations", async () => {
  const base = catalog();
  const head = {
    ...base,
    ports: base.ports.map((value) => ({ ...value, artwork: { image_id: "new-cover" } })),
  };
  const before = [authoring("game"), authoring("other")];
  const after = structuredClone(before);
  for (const record of after) record.listing.artwork.image_id = "new-cover";
  const scope = await selectUpstreamHealthScope(
    base,
    head,
    [
      change(),
      change("crates/portcove-core/catalog/ports/game.json"),
      change("crates/portcove-core/catalog/ports/other.json"),
      change("apps/desktop/src/library.tsx"),
      change("README.md"),
    ],
    { base: before, head: after },
  );
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.port_ids, []);
});

void test("bulk listing-only artwork does not enter the monitored lineage inventory", async () => {
  const input = catalog();
  const listed = Array.from({ length: 400 }, (_, index) => ({
    listing: { id: `listed-${index}`, artwork: { image_id: "old-cover" } },
    upstream_lineage: "outside the runtime health inventory",
  }));
  const updated = listed.map((record) => ({
    ...record,
    listing: { ...record.listing, artwork: { image_id: "new-cover" } },
  }));
  const game = authoring("game");
  const gameArt = structuredClone(game);
  gameArt.listing.artwork.image_id = "new-cover";
  const changes = [
    change(authoringPath("game")),
    ...listed.map((record) => change(authoringPath(record.listing.id))),
  ];
  const scope = await selectUpstreamHealthScope(input, input, changes, {
    base: [game, ...listed],
    head: [gameArt, ...updated],
  });
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.port_ids, []);
  const relevant = await selectUpstreamHealthScope(input, input, changes, {
    base: [game, ...listed],
    head: [acceptAlternative(game), ...updated],
  });
  assert.deepEqual(relevant.port_ids, ["game"]);
  const invalid = structuredClone(game);
  invalid.listing.project_url = "http://invalid.example/game";
  await assert.rejects(
    selectUpstreamHealthScope(input, input, changes, {
      base: [game, ...listed],
      head: [invalid, ...updated],
    }),
    /credential-free HTTPS/,
  );
});

void test("listing-only additions stay unmonitored while integration transitions remain selected", async () => {
  const input = catalog();
  const listed = { listing: { id: "listed", artwork: { image_id: "cover" } } };
  const addition = change(authoringPath("listed"), { status: "A", oldMode: "000000" });
  assert.equal((await selectUpstreamHealthScope(input, input, [addition])).mode, "none");
  assert.equal(
    (
      await selectUpstreamHealthScope(input, input, [addition], {
        base: [],
        head: [listed],
      })
    ).mode,
    "none",
  );
  const integrated = { ...input, ports: [...input.ports, port("listed")] };
  const changes = [change(), change(authoringPath("listed"))];
  const scope = await selectUpstreamHealthScope(input, integrated, changes, {
    base: [listed],
    head: [authoring("listed")],
  });
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.port_ids, ["listed"]);
  assert.equal(
    (
      await selectUpstreamHealthScope(integrated, input, changes, {
        base: [authoring("listed")],
        head: [listed],
      })
    ).mode,
    "full",
  );
  await assert.rejects(
    selectUpstreamHealthScope(input, integrated, changes, { base: [listed], head: [] }),
    /Missing exact lineage/,
  );
});

void test("operational changes stay scoped through unrelated additions and renames", async () => {
  const base = catalog();
  const head = structuredClone(base);
  head.ports[0]!.release.repository = "successor/game";
  const scope = await selectUpstreamHealthScope(
    base,
    head,
    [
      change(),
      change("crates/portcove-core/catalog/ports/game.json"),
      change("docs/new-guide.md", { status: "A", oldMode: "000000" }),
      change("apps/desktop/src/old.ts", { status: "R", newPath: "apps/desktop/src/new.ts" }),
    ],
    { base: [authoring("game")], head: [authoring("game")] },
  );
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.port_ids, ["game"]);
});

void test("lineage-only authoring selects its port and unavailable comparison cannot skip", async () => {
  const input = catalog();
  const before = authoring("game");
  const after = acceptAlternative(before);
  const changes = [change(authoringPath("game")), change("README.md")];
  const scope = await selectUpstreamHealthScope(input, input, changes, {
    base: [before],
    head: [after],
  });
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.port_ids, ["game"]);
  assert.equal((await selectUpstreamHealthScope(input, input, changes)).mode, "full");
  await assert.rejects(
    selectUpstreamHealthScope(input, input, changes, { base: [], head: [after] }),
    /Missing exact lineage/,
  );
  await assert.rejects(
    selectUpstreamHealthScope(input, input, changes, {
      base: [before],
      head: [{ listing: { id: "game", project_url: 42 } }],
    }),
    /lineage listing/,
  );
  assert.equal(
    (
      await selectUpstreamHealthScope(input, input, [
        change(authoringPath("game"), { status: "D", newMode: "000000" }),
      ])
    ).mode,
    "full",
  );
});

void test("qualification invalidates only the owning port", async () => {
  const base = catalog();
  const head = {
    ...base,
    source_catalog: {
      qualification: [
        {
          scope: { port_id: "game", upstream_ref: "v1", artifact_sha256: "a".repeat(64) },
          outcome: "failed",
          evidence: "retained-evidence",
        },
      ],
    },
  };
  assert.notEqual(healthCatalogPortHash(base, "game"), healthCatalogPortHash(head, "game"));
  assert.equal(healthCatalogPortHash(base, "other"), healthCatalogPortHash(head, "other"));
  assert.deepEqual((await selectUpstreamHealthScope(base, head, [change()])).port_ids, ["game"]);
  const updatedOutcome = structuredClone(head);
  updatedOutcome.source_catalog.qualification[0]!.outcome = "passed";
  assert.notEqual(
    healthCatalogPortHash(head, "game"),
    healthCatalogPortHash(updatedOutcome, "game"),
  );
  assert.equal(healthPortHash(head.ports[0]), healthPortHash(base.ports[0]));
});

void test("shared tools and uncertain Git records retain full diagnostics", async () => {
  const input = catalog();
  for (const changes of [
    [change("scripts/upstream-health-inputs.mts")],
    [change("scripts/upstream-lineage.mts")],
    [change("scripts/release-path-safety.mts")],
    [change("scripts/check-catalog-repositories.mts")],
    [change(".github/upstream-health-accounting.json")],
    [change(".github/workflows/upstream-health.yml")],
    [change("old-name.mts", { status: "R", newPath: "scripts/upstream-health-plan.mts" })],
    [change(catalogPath, { newMode: "120000" })],
    [change("../unsafe")],
    [change(catalogPath, { status: "U" })],
  ])
    assert.equal((await selectUpstreamHealthScope(input, input, changes)).mode, "full");
  assert.equal((await selectUpstreamHealthScope(input, input, [])).mode, "none");
});

void test("additions select the port; removals and schema changes stay explicit", async () => {
  const base = catalog();
  const head = { ...base, ports: [...base.ports, port("new")] };
  assert.deepEqual((await selectUpstreamHealthScope(base, head, [change()])).port_ids, ["new"]);
  assert.equal((await selectUpstreamHealthScope(head, base, [change()])).mode, "full");
  assert.equal(
    (await selectUpstreamHealthScope(base, { ...base, schema_version: 3 }, [change()])).mode,
    "full",
  );
});

async function repository(t: { after: (cleanup: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-health-plan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: directory, maxBuffer: 8 * 1024 * 1024 });
  const read = (args: string[]) => git(args).toString("utf8").trim();
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.name", "Health fixture"]);
  git(["config", "user.email", "health-fixture@example.invalid"]);
  git(["config", "core.autocrlf", "false"]);
  await mkdir(path.dirname(path.join(directory, catalogPath)), { recursive: true });
  await mkdir(path.join(directory, "crates/portcove-core/catalog/ports"), { recursive: true });
  const writeCatalog = (value: unknown) =>
    writeFile(path.join(directory, catalogPath), `${JSON.stringify(value, null, 2)}\n`);
  const readCatalog = () => readFile(path.join(directory, catalogPath), "utf8");
  const readAuthoring = (relativePath: string) =>
    readFile(path.join(directory, relativePath), "utf8");
  const writeAuthoring = (id: string, value: unknown) =>
    writeFile(path.join(directory, authoringPath(id)), `${JSON.stringify(value, null, 2)}\n`);
  const commit = (message: string) => {
    git(["add", "."]);
    git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message]);
    return read(["rev-parse", "HEAD"]);
  };
  const base = catalog();
  await writeCatalog(base);
  for (const port of base.ports) await writeAuthoring(port.id, authoring(port.id));
  await writeFile(path.join(directory, "README.md"), "Base\n");
  const ancestor = commit("Initial catalog");
  return {
    directory,
    git,
    read,
    base,
    ancestor,
    writeCatalog,
    readCatalog,
    writeAuthoring,
    readAuthoring,
    commit,
  };
}

void test("merge discovery selects a lineage-only accepted decision against the actual target", async (t) => {
  const f = await repository(t);
  f.git(["checkout", "--quiet", "-b", "feature"]);
  await f.writeAuthoring("game", acceptAlternative(authoring("game")));
  const headSha = f.commit("Record a reviewed alternative without changing runtime catalog");
  f.git(["checkout", "--quiet", "main"]);
  const target = authoring("other");
  target.upstream_lineage.decisions.push({
    from: target.upstream_lineage.origin,
    to: { project_url: "https://github.com/candidate/other" },
    relationship: "successor",
    outcome: "unresolved",
    rationale: "Attributable continuity remains unresolved.",
    evidence: [
      {
        kind: "context",
        reference: "https://example.invalid/candidate",
        note: "Candidate evidence.",
      },
    ],
    reconsider_when: "Independent continuity review supplies sufficient evidence.",
  });
  await f.writeAuthoring("other", target);
  const baseSha = f.commit("Record unrelated target lineage evidence");
  f.git([
    "-c",
    "commit.gpgsign=false",
    "merge",
    "--quiet",
    "--no-ff",
    "feature",
    "-m",
    "Test merge",
  ]);
  const checkoutSha = f.read(["rev-parse", "HEAD"]);
  const context = { event: "pull_request", baseSha, headSha, checkoutSha };
  const scope = await discoverUpstreamHealthScope(context, f.git, f.readCatalog, f.readAuthoring);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.port_ids, ["game"]);
  assert.ok("identities" in scope);
  assert.equal(scope.identities.comparison_base, baseSha);
  assert.equal(scope.base_catalog_sha256, scope.checkout_catalog_sha256);
  assert.notEqual(scope.base_lineage_sha256, scope.checkout_lineage_sha256);
  await f.writeAuthoring("game", authoring("game"));
  await assert.rejects(
    discoverUpstreamHealthScope(context, f.git, f.readCatalog, f.readAuthoring),
    /Working lineage differs/,
  );
});

void test("authoring-only artwork and copy stay outside PR health selection", async (t) => {
  const f = await repository(t);
  f.git(["checkout", "--quiet", "-b", "feature"]);
  const art = authoring("game");
  art.listing.artwork.image_id = "new-cover";
  art.listing.name = "A corrected name";
  art.listing.summary = "A clearer description";
  await f.writeAuthoring("game", art);
  const headSha = f.commit("Improve authored presentation only");
  const scope = await discoverUpstreamHealthScope(
    { event: "pull_request", baseSha: f.ancestor, headSha, checkoutSha: headSha },
    f.git,
    f.readCatalog,
    f.readAuthoring,
  );
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.port_ids, []);
  assert.ok("identities" in scope);
  assert.equal(scope.base_catalog_sha256, scope.checkout_catalog_sha256);
  assert.equal(scope.base_lineage_sha256, scope.checkout_lineage_sha256);
});

void test("Git discovery skips 400 listing-only artwork records and a listing-only addition", async (t) => {
  const f = await repository(t);
  const ids = Array.from({ length: 400 }, (_, index) => `listed-${index}`);
  const listing = (id: string, image: string) => ({
    listing: { id, name: id, artwork: { image_id: image } },
  });
  for (const id of ids) await f.writeAuthoring(id, listing(id, "old-cover"));
  const baseSha = f.commit("Retain listing-only catalog records");
  f.git(["checkout", "--quiet", "-b", "feature"]);
  for (const id of ids) await f.writeAuthoring(id, listing(id, "new-cover"));
  await f.writeAuthoring("listed-new", listing("listed-new", "cover"));
  const art = authoring("game");
  art.listing.artwork.image_id = "new-cover";
  await f.writeAuthoring("game", art);
  const headSha = f.commit("Update artwork across integrated and listing-only entries");
  const authoringReads: string[] = [];
  const scope = await discoverUpstreamHealthScope(
    { event: "pull_request", baseSha, headSha, checkoutSha: headSha },
    (args) => {
      if (args[0] === "show" && args[1]?.includes("/catalog/ports/"))
        assert.ok(args[1].endsWith("/game.json"), "Listing-only Git blobs must not be read");
      return f.git(args);
    },
    f.readCatalog,
    (filename) => {
      authoringReads.push(filename);
      assert.equal(filename, authoringPath("game"));
      return f.readAuthoring(filename);
    },
  );
  assert.equal(scope.mode, "none");
  assert.deepEqual(scope.port_ids, []);
  assert.deepEqual(authoringReads, [authoringPath("game")]);
});

void test("merge discovery excludes target-only changes despite an advanced event base", async (t) => {
  const f = await repository(t);
  f.git(["checkout", "--quiet", "-b", "feature"]);
  const feature = structuredClone(f.base);
  feature.ports[0]!.summary = "Presentation changed on the PR.";
  await f.writeCatalog(feature);
  const headSha = f.commit("Change description");
  f.git(["checkout", "--quiet", "main"]);
  const target = structuredClone(f.base);
  target.ports[1]!.release.repository = "owner/target-change";
  await f.writeCatalog(target);
  const targetSha = f.commit("Change unrelated target port");
  f.git(["checkout", "--quiet", "-b", "test-merge"]);
  f.git([
    "-c",
    "commit.gpgsign=false",
    "merge",
    "--quiet",
    "--no-ff",
    "feature",
    "-m",
    "Test merge",
  ]);
  const checkoutSha = f.read(["rev-parse", "HEAD"]);
  f.git(["checkout", "--quiet", "main"]);
  await writeFile(path.join(f.directory, "README.md"), "Advanced target\n");
  const baseSha = f.commit("Advance target after the merge was produced");
  f.git(["checkout", "--quiet", "--detach", checkoutSha]);
  const scope = await discoverUpstreamHealthScope(
    { event: "pull_request", baseSha, headSha, checkoutSha },
    f.git,
    f.readCatalog,
  );
  assert.equal(scope.mode, "none");
  assert.ok("identities" in scope);
  assert.equal(scope.identities.actual_target, targetSha);
  assert.equal(scope.identities.comparison_base, targetSha);
  assert.equal(scope.identities.base, baseSha);
  assert.notEqual(scope.identities.checkout_tree, scope.identities.head_tree);
});

void test("merge discovery validates upstream changes, head, target and catalog", async (t) => {
  const f = await repository(t);
  f.git(["checkout", "--quiet", "-b", "feature"]);
  const feature = structuredClone(f.base);
  feature.ports[0]!.release.repository = "successor/game";
  await f.writeCatalog(feature);
  const headSha = f.commit("Change acquisition location");
  f.git(["checkout", "--quiet", "main"]);
  await writeFile(path.join(f.directory, "README.md"), "Target documentation\n");
  const baseSha = f.commit("Update target documentation");
  f.git([
    "-c",
    "commit.gpgsign=false",
    "merge",
    "--quiet",
    "--no-ff",
    "feature",
    "-m",
    "Test merge",
  ]);
  const checkoutSha = f.read(["rev-parse", "HEAD"]);
  const context = { event: "pull_request", baseSha, headSha, checkoutSha };
  const scope = await discoverUpstreamHealthScope(context, f.git, f.readCatalog);
  assert.equal(scope.mode, "affected");
  assert.deepEqual(scope.port_ids, ["game"]);
  await assert.rejects(
    discoverUpstreamHealthScope({ ...context, headSha: f.ancestor }, f.git, f.readCatalog),
    /exact PR head/,
  );
  await assert.rejects(
    discoverUpstreamHealthScope({ ...context, checkoutSha: headSha }, f.git, f.readCatalog),
    /Checked-out HEAD differs/,
  );
  f.git(["checkout", "--quiet", "-b", "different-target", f.ancestor]);
  await writeFile(path.join(f.directory, "README.md"), "A divergent target\n");
  const divergentBase = f.commit("Divergent target");
  f.git(["checkout", "--quiet", "--detach", checkoutSha]);
  await assert.rejects(
    discoverUpstreamHealthScope({ ...context, baseSha: divergentBase }, f.git, f.readCatalog),
    /target ancestry/,
  );
  await f.writeCatalog(f.base);
  await assert.rejects(
    discoverUpstreamHealthScope(context, f.git, f.readCatalog),
    /Working catalog differs/,
  );
});

void test("head checkout uses its branch delta; non-PR runs remain full", async (t) => {
  const f = await repository(t);
  f.git(["checkout", "--quiet", "-b", "feature"]);
  const feature = structuredClone(f.base);
  feature.ports[0]!.summary = "Changed copy.";
  await f.writeCatalog(feature);
  const headSha = f.commit("Edit description");
  f.git(["checkout", "--quiet", "main"]);
  const target = structuredClone(f.base);
  target.ports[1]!.release.repository = "owner/target-change";
  await f.writeCatalog(target);
  const baseSha = f.commit("Change target acquisition");
  f.git(["checkout", "--quiet", "feature"]);
  const scope = await discoverUpstreamHealthScope(
    { event: "pull_request", baseSha, headSha, checkoutSha: headSha },
    f.git,
    f.readCatalog,
  );
  assert.equal(scope.mode, "none");
  assert.ok("identities" in scope);
  assert.equal(scope.identities.comparison_base, f.ancestor);
  for (const event of ["push", "schedule", "workflow_dispatch"])
    assert.equal(
      (
        await discoverUpstreamHealthScope(
          { event },
          () => assert.fail("Non-PR monitoring must not need PR refs"),
          f.readCatalog,
        )
      ).mode,
      "full",
    );
});
void test("scope selection validates both complete inventories before a full fallback", async () => {
  const invalid: [unknown, RegExp][] = [
    [null, /Catalog ports must be an array/u],
    [{ ports: [null] }, /Catalog requires unique stable port IDs/u],
    [{ ports: [port("Bad")] }, /Catalog requires unique stable port IDs/u],
    [{ ports: [port("game"), port("game")] }, /Catalog requires unique stable port IDs/u],
    [
      { ports: [port("game"), { ...port("other"), project_url: 42 }] },
      /Unsupported original upstream location/u,
    ],
    [
      { ports: [{ ...port("game"), automated_tested_platforms: ["plan9"] }] },
      /Unsupported catalog platform/u,
    ],
    [
      { ports: [{ ...port("game"), release: { repository: "../escape" } }] },
      /Unsupported hosted catalog repository/u,
    ],
    [
      { ports: [{ ...port("game"), release: { provider: "direct-manifest" } }] },
      /Direct manifest requires explicit artifact locations/u,
    ],
    [
      {
        ports: [
          {
            ...port("game"),
            release: {
              provider: "direct-manifest",
              direct: {
                "windows-x86-64": {
                  url: "http://localhost/file",
                  version: "v1",
                  size: 1,
                  sha256: "a".repeat(64),
                },
              },
            },
          },
        ],
      },
      /Direct manifest requires a safe exact artifact identity/u,
    ],
    [{ ...catalog(), source_catalog: [] }, /Invalid source catalog/u],
    [
      {
        ...catalog(),
        source_catalog: {
          qualification: [
            { scope: { port_id: "game", upstream_ref: "v1", artifact_sha256: "bad" } },
          ],
        },
      },
      /Qualification requires an exact historical release identity/u,
    ],
  ];
  for (const [input, error] of invalid) {
    await assert.rejects(selectUpstreamHealthScope(input, catalog(), null), error);
    await assert.rejects(selectUpstreamHealthScope(catalog(), input, null), error);
  }
  for (const input of [
    { ...catalog(), ignored: 1n },
    { ...catalog(), ports: [{ ...port("game"), presentation: { ignored: 1n } }] },
  ]) {
    await assert.rejects(selectUpstreamHealthScope(input, catalog(), null), TypeError);
    await assert.rejects(selectUpstreamHealthScope(catalog(), input, null), TypeError);
  }
  const cyclic = { ...catalog(), ignored: {} };
  cyclic.ignored = cyclic;
  await assert.rejects(selectUpstreamHealthScope(cyclic, catalog(), null), RangeError);
  await assert.rejects(selectUpstreamHealthScope(catalog(), cyclic, null), RangeError);
});
