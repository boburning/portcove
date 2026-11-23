import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { AuthoredPort } from "./catalog-authoring.mts";
import {
  boundFactsBatch,
  digestOf,
  emptyFactsTable,
  FACTS_PARSER,
  FACTS_PARSER_VERSION,
  needsReproduction,
  reproductionBudget,
  reproductionPlan,
  type ListingFactsEntry,
  type ListingFactsTable,
  type NameSuggestion,
  type PlayerFact,
} from "./catalog-generated-registration.mts";
import {
  artifactFact,
  assetsDigest,
  InspectionError,
  type ByteInspector,
  type NameClassifier,
} from "./listing-package-facts.mts";
import {
  batchAllowlist,
  batchBranchPrefix,
  derivedBatchPaths,
  batchInputs,
  batchPullBody,
  batchPullProblems,
  batchWorkflowPath,
  changedPaths,
  claimsBatch,
  collectConditions,
  freshnessAlertDays,
  refreshAfterDays,
  reproductionDetails,
  parseWorkerSummary,
  jobBatches,
  materialChange,
  offeredDrainDays,
  workflowLogin,
  factsFallingBehind,
  handoffObservations,
  inputsArtifactFiles,
  inputsProblems,
  mergeMessage,
  noProgressRuns,
  parseProviderRelease,
  pathViolations,
  provenanceProblems,
  queueSummary,
  reproduceFacts,
  requiredCheckState,
  requiredContexts,
  stopConditions,
  stopIssueBody,
  tableDelta,
  type ProviderRelease,
  type RunRecord,
  type WorkerSummary,
} from "./listing-facts-batch.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (seed: string) => digestOf(seed);

// Core's recorded classification (pinned by a portcove-core test), replayed.
const classification = JSON.parse(
  readFileSync(join(root, "scripts/fixtures/listing-name-classification.json"), "utf8"),
) as {
  output: {
    filename_rule_version: number;
    releases: { tag: string; provider_prerelease: boolean; prerelease: boolean }[];
    assets: (Omit<NameSuggestion, "rule_version"> & { name: string })[];
    programs: { name: string; tool_token: string | null }[];
  };
};
const coreClassifier: NameClassifier = async (input) => ({
  filename_rule_version: classification.output.filename_rule_version,
  releases: input.releases.map((release) => {
    const known = classification.output.releases.find(
      (candidate) =>
        candidate.tag === release.tag &&
        candidate.provider_prerelease === release.provider_prerelease,
    );
    assert.ok(known, release.tag);
    return known;
  }),
  assets: input.assets.map((name) => {
    const known = classification.output.assets.find((candidate) => candidate.name === name);
    assert.ok(known, name);
    return known;
  }),
  programs: input.programs.map((name) => {
    const known = classification.output.programs.find((candidate) => candidate.name === name);
    assert.ok(known, name);
    return known;
  }),
});
const suggestion = (name: string): NameSuggestion => {
  const known = classification.output.assets.find((candidate) => candidate.name === name)!;
  const { name: _name, ...rest } = known;
  return { rule_version: classification.output.filename_rule_version, ...rest };
};
const token = (name: string) =>
  classification.output.programs.find((candidate) => candidate.name === name)!.tool_token;

const windowsZip = "Game-v1.0-windows-x64.zip";
const player = (path: string, machine = "pe-x86-64"): PlayerFact => ({
  path: path.toLowerCase(),
  display_path: path,
  machine,
  sha256: sha(`${path}/${machine}`),
});
const unseen = "zz-unseen-observed-runtime-fixture";
function listing(id = unseen): AuthoredPort {
  return {
    format_version: 1,
    listing: {
      id,
      name: "Unseen Observed Runtime",
      summary: "A native runtime observed only through release facts.",
      project_url: `https://github.com/fixture-owner/${id}`,
      availability: "packages",
      platforms: ["windows-x86-64"],
    },
  };
}

/** A provider release and the eligible entry the worker would write for it. */
function fixture(id = unseen, players = [player("Game/Game.exe")], size = 4096) {
  const asset = {
    id: 21,
    name: windowsZip,
    size,
    sha256: sha(`archive-${id}`),
    url: `https://github.com/fixture-owner/${id}/releases/download/v1.0/${windowsZip}`,
  };
  const release: ProviderRelease = {
    id: 8,
    repository: `Fixture-Owner/${id}`,
    tag_name: "v1.0",
    draft: false,
    prerelease: false,
    published_at: "2026-11-01T00:00:00Z",
    assets: [
      asset,
      { id: 22, name: "README.md", size: 10, sha256: sha("readme"), url: "https://github.com/x" },
    ],
  };
  const artifact = artifactFact(asset, players, suggestion(windowsZip), token);
  const entry: ListingFactsEntry = {
    port_id: id,
    provider: "github",
    repository: `fixture-owner/${id}`,
    repository_id: 4242,
    parser: FACTS_PARSER,
    parser_version: FACTS_PARSER_VERSION,
    observation: {
      release_id: 8,
      tag: "v1.0",
      published_at: "2026-11-01T00:00:00.000Z",
      observed_at: "2026-11-20T00:00:00.000Z",
      coverage: "complete",
      assets_complete: true,
      assets_sha256: assetsDigest({
        id: 8,
        version: "v1.0",
        published_at: null,
        provider_prerelease: false,
        assets_complete: true,
        malformed_assets: 0,
        assets: release.assets,
      }),
    },
    ineligible: null,
    unread_forms: [],
    observed_releases: [
      {
        release_id: 8,
        tag: "v1.0",
        prerelease: false,
        published_at: "2026-11-01T00:00:00.000Z",
        packaged: true,
      },
    ],
    bare_executables: [],
    refused_archives: [],
    attempt: null,
    artifacts: [artifact],
  };
  return { release, entry, players };
}
const reader =
  (releases: Record<number, ProviderRelease | Error>) =>
  async (repositoryId: number, releaseId: number) => {
    assert.equal(repositoryId, 4242);
    const found = releases[releaseId];
    if (!found) throw new Error("404");
    if (found instanceof Error) throw found;
    return structuredClone(found);
  };
const inspector =
  (players: PlayerFact[] | Error, log: string[] = []): ByteInspector =>
  async (asset) => {
    log.push(asset.name);
    if (players instanceof Error) throw players;
    return players.map((item) => ({ ...item }));
  };

// ---------------------------------------------------------------------------
// Path allowlist.

void test("the batch allowlist is exactly the facts table and what catalog generation rewrites from it", () => {
  assert.deepEqual(batchAllowlist, [
    "crates/portcove-core/catalog/listing-package-facts.generated.json",
    "crates/portcove-core/catalog/generated-registration.generated.json",
    "crates/portcove-core/catalog/catalog.json",
    "crates/portcove-core/catalog/listings.json",
  ]);
  assert.deepEqual(pathViolations([...batchAllowlist]), []);
  // Only the facts table is an input; the rest must be canonical outputs.
  assert.deepEqual(derivedBatchPaths, batchAllowlist.slice(1));
  for (const outside of [
    "scripts/catalog-generated-registration.mts",
    "scripts/listing-package-facts.mts",
    ".github/workflows/listing-facts-batch.yml",
    "crates/portcove-core/catalog/ports/zz/port.json",
    "crates/portcove-core/catalog/route-enrollment.generated.json",
    "docs/CATALOG.md",
  ])
    assert.deepEqual(pathViolations([batchAllowlist[0], outside]), [outside], outside);
  // Untracked files and both sides of a change count.
  const git = (args: string[]) =>
    args[0] === "diff"
      ? `${batchAllowlist[0]}\0scripts/x.mts\0`
      : args[0] === "ls-files"
        ? "notes.txt\0"
        : undefined;
  assert.deepEqual(pathViolations(changedPaths(git, "HEAD~1")!), ["notes.txt", "scripts/x.mts"]);
  // An unreadable diff is never an empty diff.
  assert.equal(
    changedPaths(() => undefined, "HEAD~1"),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Reproduction.

void test("an entry is reproduced only when its exact bytes rebuild byte-equal facts", async () => {
  const { release, entry, players } = fixture();
  const log: string[] = [];
  const ok = await reproduceFacts({
    entries: [entry],
    readRelease: reader({ 8: release }),
    inspect: inspector(players, log),
    classify: coreClassifier,
  });
  assert.deepEqual(ok, { verified: [unseen], refused: [], bytes: 4096 });
  // Only the release's archives are read, never other files.
  assert.deepEqual(log, [windowsZip]);
  const refusal = async (
    mutate: (copy: { release: ProviderRelease; entry: ListingFactsEntry }) => void,
    inspected: PlayerFact[] | Error = players,
  ) => {
    const copy = structuredClone({ release, entry });
    mutate(copy);
    const result = await reproduceFacts({
      entries: [copy.entry],
      readRelease: reader({ 8: copy.release }),
      inspect: inspector(inspected),
      classify: coreClassifier,
    });
    assert.deepEqual(result.verified, []);
    return result.refused[0]!.reason;
  };
  // A forged player, machine or digest is a mismatch.
  assert.equal(
    await refusal((copy) => (copy.entry.artifacts[0]!.players[0]!.sha256 = sha("forged"))),
    "mismatch",
  );
  assert.equal(await refusal(() => undefined, [player("Game/Game.exe", "pe-x86")]), "mismatch");
  // A player the bytes hold but the facts left out is a mismatch too.
  assert.equal(await refusal(() => undefined, [...players, player("Other.exe")]), "mismatch");
  // A forged name verdict is a mismatch.
  assert.equal(
    await refusal((copy) => (copy.entry.artifacts[0]!.contradictory = true)),
    "mismatch",
  );
  // An archive left out of the entry is a mismatch, even when the recorded
  // asset list digest names it.
  assert.equal(
    await refusal((copy) => {
      copy.release.assets.push({
        id: 23,
        name: "Game-v1.0-linux-x86_64.tar.gz",
        size: 9,
        sha256: sha("linux"),
        url: "https://github.com/x",
      });
      copy.entry.observation.assets_sha256 = assetsDigest({
        id: 8,
        version: "v1.0",
        published_at: null,
        provider_prerelease: false,
        assets_complete: true,
        malformed_assets: 0,
        assets: copy.release.assets,
      });
    }),
    "mismatch",
  );
  // The numeric ids must name the listing's repository (D1): another
  // repository's release is refused whatever its bytes say.
  assert.equal(
    await refusal((copy) => (copy.release.repository = "someone-else/other-game")),
    "release-changed",
  );
  // Changed or missing provider facts are refused, never trusted.
  assert.equal(
    await refusal((copy) => (copy.release.assets[0]!.sha256 = sha("other"))),
    "release-changed",
  );
  assert.equal(await refusal((copy) => (copy.release.tag_name = "v1.0-rc1")), "release-changed");
  assert.equal(await refusal((copy) => (copy.release.prerelease = true)), "release-changed");
  assert.equal(await refusal((copy) => (copy.release.draft = true)), "release-changed");
  assert.equal(
    await refusal((copy) => (copy.release.published_at = "2026-11-02T00:00:00Z")),
    "release-changed",
  );
  assert.equal(
    await refusal(() => undefined, new InspectionError("Download failed.", false)),
    "asset-unavailable",
  );
  assert.equal(
    await refusal(() => undefined, new InspectionError("Archive bytes differ.", true)),
    "core-refused",
  );
  const unavailable = await reproduceFacts({
    entries: [entry],
    readRelease: reader({ 8: new Error("rate limited") }),
    inspect: inspector(players),
    classify: coreClassifier,
  });
  assert.equal(unavailable.refused[0]!.reason, "release-unavailable");
});

void test("a refused archive, the release's line facts and its installers are reproduced too (D2, D4, D5)", async () => {
  const { release, entry, players } = fixture();
  const mac = {
    id: 23,
    name: "Game-v1.0-macos-universal.zip",
    size: 512,
    sha256: sha("mac"),
    url: "https://github.com/fixture-owner/mac.zip",
  };
  release.assets.push(mac);
  entry.observation.assets_sha256 = assetsDigest({
    id: 8,
    version: "v1.0",
    published_at: null,
    provider_prerelease: false,
    assets_complete: true,
    malformed_assets: 0,
    assets: release.assets,
  });
  entry.refused_archives = [
    {
      asset_id: 23,
      name: mac.name,
      size: mac.size,
      sha256: mac.sha256,
      name_suggestion: suggestion(mac.name),
      refusal: "core-source-invalid",
    },
  ];
  const refusing =
    (refusal: InspectionError | PlayerFact[]): ByteInspector =>
    async (asset) => {
      if (asset.id !== 23) return players.map((item) => ({ ...item }));
      if (refusal instanceof Error) throw refusal;
      return refusal;
    };
  const run = (copy: ListingFactsEntry, inspect: ByteInspector, provider = release) =>
    reproduceFacts({
      entries: [copy],
      readRelease: reader({ 8: provider }),
      inspect,
      classify: coreClassifier,
    });
  const sameRefusal = new InspectionError("refused", true, "core-source-invalid");
  assert.deepEqual(await run(entry, refusing(sameRefusal)), {
    verified: [unseen],
    refused: [],
    bytes: 4096 + 512,
  });
  // A refusal that is not reproduced, or reproduced with another class, is a mismatch.
  const reason = async (copy: ListingFactsEntry, inspect: ByteInspector, provider = release) =>
    (await run(copy, inspect, provider)).refused[0]?.reason;
  assert.equal(
    await reason(entry, refusing([player("Game.app/Contents/MacOS/Game", "macho-arm64")])),
    "mismatch",
  );
  assert.equal(
    await reason(entry, refusing(new InspectionError("refused", true, "core-unsupported"))),
    "mismatch",
  );
  assert.equal(
    await reason(entry, refusing(new InspectionError("reset", false))),
    "asset-unavailable",
  );
  // A refused archive left out is a mismatch: the entry records every archive.
  assert.equal(await reason({ ...entry, refused_archives: [] }, refusing(sameRefusal)), "mismatch");
  // A forged installer list or release line record is refused.
  assert.equal(
    await reason({ ...entry, bare_executables: ["Setup.exe"] }, refusing(sameRefusal)),
    "release-changed",
  );
  assert.equal(
    await reason(
      {
        ...entry,
        observed_releases: [{ ...entry.observed_releases[0]!, tag: "sm2-v1.1" }],
      },
      refusing(sameRefusal),
    ),
    "release-changed",
  );
  // A bare installer beside the archives must be recorded.
  const installer = structuredClone(release);
  installer.assets.push({
    id: 24,
    name: "Install-Game.exe",
    size: 64,
    sha256: sha("installer"),
    url: "https://github.com/x/i.exe",
  });
  const recorded = structuredClone(entry);
  recorded.observation.assets_sha256 = assetsDigest({
    id: 8,
    version: "v1.0",
    published_at: null,
    provider_prerelease: false,
    assets_complete: true,
    malformed_assets: 0,
    assets: installer.assets,
  });
  assert.equal(await reason(recorded, refusing(sameRefusal), installer), "release-changed");
  recorded.bare_executables = ["Install-Game.exe"];
  assert.equal(await reason(recorded, refusing(sameRefusal), installer), undefined);
});

void test("reproduction is budgeted: oversized assets, too many entries or bytes and the clock refuse", async () => {
  const { release, entry, players } = fixture(unseen, [player("Game/Game.exe")], 4096);
  const run = (entries: ListingFactsEntry[], budget = {}, clock?: () => number) =>
    reproduceFacts({
      entries,
      readRelease: reader({ 8: release }),
      inspect: inspector(players),
      classify: coreClassifier,
      budget: { ...reproductionBudget, ...budget },
      ...(clock ? { clock } : {}),
    });
  assert.equal(
    (await run([entry], { maxArchiveBytes: 4095 })).refused[0]!.reason,
    "oversized-asset",
  );
  const many = await run([entry, { ...entry, port_id: "zz-second" }], { maxEntries: 1 });
  assert.deepEqual(
    many.refused.map((refusal) => refusal.reason),
    ["over-budget", "over-budget"],
  );
  assert.equal((await run([entry], { maxBytes: 4095 })).refused[0]!.reason, "over-budget");
  let now = 0;
  const late = await run([entry], { maxMilliseconds: 10 }, () => (now += 20));
  assert.equal(late.refused[0]!.reason, "over-budget");
  assert.deepEqual(reproductionBudget, {
    maxEntries: 64,
    maxBytes: 4 * 1024 ** 3,
    maxArchiveBytes: 512 * 1024 ** 2,
    maxMilliseconds: 30 * 60_000,
  });
});

void test("only eligible entries a change adds or changes are reproduced", () => {
  const { entry } = fixture();
  const table = (...entries: ListingFactsEntry[]): ListingFactsTable => ({
    ...emptyFactsTable("2026-11-20T00:00:00.000Z"),
    entries,
    entries_sha256: digestOf(entries),
  });
  assert.equal(needsReproduction(undefined, entry), true);
  // A reconfirmation only moves observed_at: nothing to re-read.
  const reconfirmed = structuredClone(entry);
  reconfirmed.observation.observed_at = "2026-11-21T00:00:00.000Z";
  assert.equal(needsReproduction(entry, reconfirmed), false);
  const changed = structuredClone(entry);
  changed.artifacts[0]!.players[0]!.sha256 = sha("new build");
  assert.equal(needsReproduction(entry, changed), true);
  const rebound = structuredClone(entry);
  rebound.repository_id = 9;
  assert.equal(needsReproduction(entry, rebound), true);
  const ineligible = {
    ...structuredClone(entry),
    ineligible: { reason: "too-large", detail: "x" },
    artifacts: [],
  } as ListingFactsEntry;
  assert.equal(needsReproduction(entry, ineligible), false);
  assert.equal(needsReproduction(ineligible, entry), true);
  // Every field that can decide enrollment is re-read (D2): a parser bump,
  // a coverage flip or changed unread forms alone is not a reconfirmation.
  for (const mutate of [
    (copy: ListingFactsEntry) => (copy.parser_version = 99),
    (copy: ListingFactsEntry) => (copy.observation.coverage = "partial"),
    (copy: ListingFactsEntry) => (copy.observation.assets_complete = false),
    (copy: ListingFactsEntry) => (copy.unread_forms = [".7z"]),
    (copy: ListingFactsEntry) => (copy.repository = "fixture-owner/other"),
  ]) {
    const copy = structuredClone(entry);
    mutate(copy);
    assert.equal(needsReproduction(copy, entry), true, String(mutate));
  }
  const retried = structuredClone(entry);
  retried.attempt = {
    status: "pending-inspection",
    first_at: "2026-11-20T00:00:00.000Z",
    last_at: "2026-11-20T00:00:00.000Z",
    failures: 1,
  };
  assert.equal(needsReproduction(entry, retried), false);
  const plan = reproductionPlan(
    table(entry),
    table(reconfirmed, { ...changed, port_id: "zz-new" }),
  );
  assert.deepEqual(
    plan.entries.map((item) => item.port_id),
    ["zz-new"],
  );
  assert.equal(plan.bytes, 4096);
  // An empty or absent baseline reproduces every eligible entry.
  assert.equal(reproductionPlan(null, table(entry)).entries.length, 1);
});

void test("a batch never asks CI to reproduce more than its budget; the rest is held", () => {
  const ids = ["zz-a", "zz-b", "zz-c"];
  const records = ids.map((id) => listing(id));
  const entries = ids.map((id) => fixture(id).entry);
  const previous = emptyFactsTable("2026-11-20T00:00:00.000Z");
  const next: ListingFactsTable = {
    ...emptyFactsTable("2026-11-20T00:00:00.000Z"),
    entries,
    entries_sha256: digestOf(entries),
  };
  const byEntries = boundFactsBatch(records, previous, next, undefined, {
    ...reproductionBudget,
    maxEntries: 2,
  });
  assert.deepEqual(
    byEntries.table.entries.map((entry) => entry.port_id),
    ["zz-a", "zz-b"],
  );
  assert.deepEqual(
    byEntries.deferred.map((entry) => entry.port_id),
    ["zz-c"],
  );
  const byBytes = boundFactsBatch(records, previous, next, undefined, {
    ...reproductionBudget,
    maxBytes: 4096,
  });
  assert.deepEqual(
    byBytes.table.entries.map((entry) => entry.port_id),
    ["zz-a"],
  );
  assert.equal(reproductionPlan(previous, byBytes.table).bytes, 4096);
});

void test("provider release records are read strictly", () => {
  const release = parseProviderRelease({
    id: 8,
    url: "https://api.github.com/repos/Owner/Game/releases/8",
    tag_name: "v1.0",
    draft: false,
    prerelease: false,
    published_at: "2026-11-01T00:00:00Z",
    assets: [
      {
        id: 1,
        name: "a.zip",
        size: 3,
        digest: `sha256:${"A".repeat(64)}`,
        browser_download_url: "https://github.com/a",
      },
      { id: 2, name: "b.zip", size: 3, digest: null, browser_download_url: "https://github.com/b" },
    ],
  });
  assert.equal(release.assets[0]!.sha256, "a".repeat(64));
  assert.equal(release.assets[1]!.sha256, null);
  assert.equal(release.repository, "Owner/Game");
  const minimal = {
    id: 8,
    url: "https://api.github.com/repos/Owner/Game/releases/8",
    tag_name: "v",
    draft: false,
    prerelease: false,
    published_at: null,
    assets: [],
  };
  for (const bad of [
    null,
    { id: 8 },
    { ...minimal, assets: [{ id: 1 }] },
    { ...minimal, url: undefined },
    { ...minimal, url: "https://example.com/repos/Owner/Game/releases/8" },
  ])
    assert.throws(() => parseProviderRelease(bad), /malformed|names no repository/u);
});

// ---------------------------------------------------------------------------
// Provenance.

const provenance = {
  workflow_run_id: "123456789",
  source_commit: "a".repeat(40),
  cli_sha256: sha("cli"),
  inputs_sha256: sha("inputs"),
};
const run = {
  id: 123456789,
  path: batchWorkflowPath,
  head_branch: "main",
  head_sha: "a".repeat(40),
  event: "schedule",
  repository: "boburning/portcove",
};

void test("a batch's provenance must name this repository's scheduled batch run at its source commit", () => {
  const context = { repository: "boburning/portcove", headRef: `${batchBranchPrefix}123456789` };
  assert.deepEqual(provenanceProblems(provenance, run, context), []);
  assert.deepEqual(
    provenanceProblems(provenance, { ...run, event: "workflow_dispatch" }, context),
    [],
  );
  for (const [label, changed] of [
    ["path", { ...run, path: ".github/workflows/ci.yml" }],
    ["branch", { ...run, head_branch: "feature" }],
    ["event", { ...run, event: "pull_request" }],
    ["sha", { ...run, head_sha: "b".repeat(40) }],
    ["repository", { ...run, repository: "someone/fork" }],
    ["id", { ...run, id: 1 }],
  ] as const)
    assert.ok(provenanceProblems(provenance, changed, context).length, label);
  assert.ok(
    provenanceProblems(provenance, run, { ...context, headRef: `${batchBranchPrefix}999` }).length,
    "branch of another run",
  );
  assert.ok(provenanceProblems(provenance, undefined, context).length);
  assert.ok(provenanceProblems(undefined, run, context).length);
});

void test("a change claims to be a batch by its branch or by new provenance", () => {
  const table = { ...emptyFactsTable(), provenance };
  assert.equal(claimsBatch(null, emptyFactsTable(), undefined), false);
  assert.equal(claimsBatch(null, table, undefined), true);
  assert.equal(claimsBatch(table, table, undefined), false);
  assert.equal(claimsBatch(null, emptyFactsTable(), `${batchBranchPrefix}1`), true);
});

/** A stored (uncompressed) or deflated ZIP of these files. */
function zip(files: Record<string, Buffer>, deflate = false) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = deflate ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc(bytes), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc(bytes), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

void test("the retained inputs must carry the recorded digest and match the files beside them", () => {
  const observations = Buffer.from('{"listings":[]}\n');
  const state = Buffer.from("");
  const inputs = batchInputs({
    runId: provenance.workflow_run_id,
    sourceCommit: provenance.source_commit,
    observerRunId: "77",
    observations,
    state,
    factsTable: Buffer.from("{}"),
    budget: { maxEntries: 64 },
  });
  const inputsBytes = Buffer.from(`${JSON.stringify(inputs, null, 2)}\n`);
  const recorded = {
    ...provenance,
    inputs_sha256: createHash("sha256").update(inputsBytes).digest("hex"),
  };
  for (const deflate of [false, true]) {
    const files = inputsArtifactFiles(
      zip(
        {
          "inputs.json": inputsBytes,
          "observations.json": observations,
          "state-before.json": state,
        },
        deflate,
      ),
    );
    assert.deepEqual(inputsProblems(recorded, files), [], `deflate ${deflate}`);
  }
  const files = new Map([
    ["inputs.json", inputsBytes],
    ["observations.json", observations],
    ["state-before.json", state],
  ]);
  assert.match(inputsProblems(provenance, files).join(), /inputs digest/u);
  assert.match(
    inputsProblems(recorded, new Map([...files, ["observations.json", Buffer.from("{}")]])).join(),
    /observations/u,
  );
  assert.match(
    inputsProblems({ ...recorded, source_commit: "c".repeat(40) }, files).join(),
    /source commit/u,
  );
  assert.match(inputsProblems(recorded, new Map()).join(), /no inputs\.json/u);
  // Only the three named files, within bounds.
  assert.throws(() => inputsArtifactFiles(zip({ "../inputs.json": inputsBytes })), /ZIP rejected/u);
  assert.throws(() => inputsArtifactFiles(zip({ "other.json": inputsBytes })), /ZIP rejected/u);
});

// ---------------------------------------------------------------------------
// Stop and wait.

const summary = (fields: Partial<WorkerSummary> = {}, backlog = 10): WorkerSummary => ({
  no_progress: false,
  settled: 3,
  backlog: {
    enrolled_pending: 0,
    new_pending: backlog,
    held_for_batch: 0,
    days_to_drain_all: 2,
    runs_to_drain_enrolled: 0,
    cadence_hours: 6,
  },
  ineligible: {},
  identities: Array.from({ length: 100 }, (_, index) => ({
    port_id: `id-${index}`,
    outcome: "unchanged",
  })),
  ...fields,
});
const record = (fields: Partial<RunRecord> = {}): RunRecord => ({
  run_id: "1",
  at: "2026-11-20T00:00:00.000Z",
  observed: 100,
  settled: 3,
  no_progress: false,
  backlog_total: 10,
  withdrawn: 0,
  identity_changed: 0,
  versions: "v",
  ...fields,
});
const assess = (history: RunRecord[], fields: Partial<Parameters<typeof stopConditions>[0]> = {}) =>
  stopConditions({
    runId: "9",
    now: "2026-11-21T00:00:00.000Z",
    summary: summary(),
    history,
    versions: "v",
    gate: "ok",
    paths: "ok",
    reproduction: "ok",
    ...fields,
  }).conditions.map((condition) => condition.name);

void test("each stop condition is detected and named", () => {
  assert.deepEqual(assess([record()]), []);
  assert.deepEqual(assess([], { gate: "refused" }), ["gate-refused"]);
  assert.deepEqual(assess([], { paths: "violated" }), ["path-allowlist"]);
  assert.deepEqual(assess([], { reproduction: "refused" }), ["reproduction-refused"]);
  assert.deepEqual(assess([], { summary: undefined }), ["worker-error"]);
  // No progress for N consecutive runs, including this one.
  const stalled = summary({ no_progress: true, settled: 0 });
  assert.deepEqual(
    assess(
      Array.from({ length: noProgressRuns - 2 }, () => record({ no_progress: true })),
      {
        summary: stalled,
      },
    ),
    [],
  );
  assert.deepEqual(
    assess(
      Array.from({ length: noProgressRuns - 1 }, () => record({ no_progress: true })),
      {
        summary: stalled,
      },
    ),
    ["no-progress"],
  );
  // A backlog that grows instead of draining.
  const growing = [6, 7, 8, 9].map((total) => record({ backlog_total: total }));
  assert.deepEqual(assess(growing, { summary: summary({}, 10) }), ["backlog-growing"]);
  assert.deepEqual(assess(growing, { summary: summary({}, 9) }), []);
  assert.deepEqual(assess([record()], { delta: { added: 0, withdrawn: 17, changed: 0 } }), [
    "large-withdrawal",
  ]);
  assert.deepEqual(assess([record()], { delta: { added: 64, withdrawn: 16, changed: 0 } }), []);
  assert.deepEqual(
    assess([record()], {
      summary: summary({
        identities: [
          ...summary().identities,
          { port_id: "moved", outcome: "ineligible", reason: "repository-identity-changed" },
        ],
      }),
    }),
    ["repository-identity-changed"],
  );
  assert.deepEqual(assess([record({ versions: "old" })]), ["rule-version-changed"]);
  assert.deepEqual(assess([record({ observed: 200 })]), ["observer-coverage-dropped"]);
  // The offered drain counts the run each batch needs to merge (D5).
  const offered = (runs: number) =>
    summary({
      backlog: {
        enrolled_pending: 9,
        new_pending: 0,
        held_for_batch: 0,
        days_to_drain_all: 1,
        runs_to_drain_enrolled: runs,
        cadence_hours: 6,
      },
    });
  assert.equal(offeredDrainDays(offered(59)), 29.5);
  assert.deepEqual(assess([record()], { summary: offered(59) }), []);
  assert.deepEqual(assess([record()], { summary: offered(60) }), ["drain-exceeds-facts-age"]);
  // A summary without the drain fields is malformed, never 0 days (A13).
  const { runs_to_drain_enrolled: _r, ...partial } = summary().backlog;
  assert.throws(
    () => parseWorkerSummary(JSON.stringify({ ...summary(), backlog: partial })),
    /malformed/u,
  );
  assert.doesNotThrow(() => parseWorkerSummary(JSON.stringify(summary())));
  // The reproduction stop names the refused entries (A12).
  const directory = mkdtempSync(join(tmpdir(), "facts-refusals-"));
  try {
    const file = join(directory, "refusals.json");
    writeFileSync(file, JSON.stringify(["zz-a: mismatch: players differ"]));
    assert.deepEqual(
      assess([record()], { reproduction: "refused", details: reproductionDetails(file) }),
      ["reproduction-refused"],
    );
    assert.match(
      stopConditions({
        runId: "9",
        now: "2026-11-21T00:00:00.000Z",
        summary: summary(),
        history: [record()],
        versions: "v",
        gate: "ok",
        paths: "ok",
        reproduction: "refused",
        details: reproductionDetails(file),
      }).conditions[0]!.detail,
      /zz-a: mismatch/u,
    );
    assert.deepEqual(reproductionDetails(join(directory, "missing.json")), {});
    // Upstream text never mentions anyone or formats the issue (A17).
    writeFileSync(file, JSON.stringify(["zz-a: mismatch: @someone `x` [link](y)"]));
    const detail = reproductionDetails(file)["reproduction-refused"]!;
    assert.doesNotMatch(detail, /@someone/u);
    assert.match(detail, /`zz-a: mismatch: @\u200bsomeone 'x' \[link\]\(y\)`/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const body = stopIssueBody({ name: "gate-refused", detail: "Grouped reason." }, "https://run");
  assert.match(body, /Grouped reason\./u);
  assert.match(body, /close this issue/u);
});

void test("the notify job adds a failed batch and failed jobs, never doubling a derive failure", () => {
  const derived = { conditions: [{ name: "gate-refused" as const, detail: "x" }], freshness: null };
  assert.deepEqual(
    collectConditions(derived, {
      prState: "none",
      prNumber: "none",
      jobs: { derive: "failure", merge: "skipped", deliver: "skipped" },
    }).conditions.map((condition) => condition.name),
    ["gate-refused"],
  );
  assert.deepEqual(
    collectConditions(
      { conditions: [], freshness: "old" },
      {
        prState: "failed",
        prNumber: "12",
        jobs: { derive: "skipped", merge: "failure", deliver: "success" },
      },
    ),
    {
      conditions: [
        {
          name: "required-check-failed",
          detail:
            "Batch pull request #12 failed a required check or is not a well-formed one-commit job batch.",
        },
        { name: "worker-error", detail: "The merge job ended failure." },
      ],
      freshness: "old",
    },
  );
  // A timed-out or cancelled job is never silent (U7).
  assert.deepEqual(
    collectConditions(
      { conditions: [], freshness: null },
      { prState: "none", prNumber: "none", jobs: { derive: "cancelled" } },
    ).conditions,
    [{ name: "worker-error", detail: "The derive job ended cancelled." }],
  );
  // While a stop issue is open only the freshness alert is filed (D4), and
  // the freshness of the committed facts is evaluated on every run.
  assert.deepEqual(
    collectConditions(
      { conditions: [], freshness: null },
      {
        blocked: true,
        freshness: "stale",
        prState: "failed",
        prNumber: "12",
        jobs: { merge: "failure" },
      },
    ),
    { conditions: [], freshness: "stale" },
  );
  // The merge message closes nothing.
  assert.doesNotMatch(
    JSON.stringify(mergeMessage(12)),
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #/iu,
  );
});

void test("the freshness watchdog compares the facts' own time with the real clock", () => {
  const { entry } = fixture();
  const table = { ...emptyFactsTable("2026-11-01T00:00:00.000Z"), entries: [entry] };
  // A quiet catalog waits up to refreshAfterDays for a reconfirmation batch:
  // the alert must not fire before that (N1).
  assert.ok(freshnessAlertDays > refreshAfterDays && freshnessAlertDays < 30);
  assert.equal(factsFallingBehind(table, "2026-11-22T00:00:00.000Z"), undefined);
  assert.match(factsFallingBehind(table, "2026-11-23T00:00:00.000Z")!, /22 days ago/u);
  // An empty table offers nothing that could go stale.
  assert.equal(
    factsFallingBehind(emptyFactsTable("2026-01-01T00:00:00.000Z"), "2026-11-09T00:00:00.000Z"),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// The open batch and its merge conditions.

void test("a batch merges only when all five required checks pass on its exact head", () => {
  const green = requiredContexts.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
  }));
  assert.deepEqual(requiredCheckState(green), { state: "green" });
  assert.deepEqual(requiredCheckState([]), {
    state: "waiting-for-checks",
    missing: [...requiredContexts],
  });
  assert.equal(requiredCheckState(green.slice(1)).state, "pending");
  assert.equal(
    requiredCheckState([
      ...green.slice(1),
      { name: "catalog", status: "in_progress", conclusion: null },
    ]).state,
    "pending",
  );
  for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", "neutral"])
    assert.deepEqual(
      requiredCheckState([...green.slice(1), { name: "catalog", status: "completed", conclusion }]),
      { state: "failed", failed: ["catalog"] },
      conclusion,
    );
  // The newest run of a context decides.
  assert.deepEqual(
    requiredCheckState([
      ...green.slice(1),
      {
        name: "catalog",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-11-20T00:00:00Z",
      },
      {
        name: "catalog",
        status: "completed",
        conclusion: "success",
        started_at: "2026-11-21T00:00:00Z",
      },
    ]),
    { state: "green" },
  );
  const pull = {
    head_ref: `${batchBranchPrefix}123`,
    author: "github-actions[bot]",
    base_ref: "main",
    commits: 1,
    draft: false,
  };
  assert.deepEqual(batchPullProblems(pull), []);
  for (const changed of [
    { head_ref: "feature/x" },
    { author: "someone" },
    { base_ref: "release" },
    { commits: 2 },
    { draft: true },
  ])
    assert.equal(batchPullProblems({ ...pull, ...changed }).length, 1, JSON.stringify(changed));
});

void test("the enrollment delta and the batch pull request body state what changed and the owner's action", () => {
  const row = (id: string, digest = "x") => ({ port_id: id, facts_sha256: digest });
  assert.deepEqual(
    tableDelta(
      { enrollments: [row("a"), row("b"), row("c")] },
      { enrollments: [row("a"), row("b", "y"), row("d")] },
    ),
    { added: 1, withdrawn: 1, changed: 1 },
  );
  assert.deepEqual(tableDelta(null, { enrollments: [row("a")] }), {
    added: 1,
    withdrawn: 0,
    changed: 0,
  });
  const body = batchPullBody({
    runUrl: "https://run",
    provenance,
    delta: { added: 2, withdrawn: 0, changed: 1 },
    reproduced: 3,
  });
  for (const heading of [
    "## Linked issue",
    "## Outcome and scope",
    "## Verification",
    "## Review and risk",
  ])
    assert.ok(body.includes(heading), heading);
  assert.match(body, /Refs #8569/u);
  assert.doesNotMatch(body, /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #/iu);
  assert.match(body, /Approve workflows to run/u);
  assert.doesNotMatch(body, /reopen/u);
});

void test("only the job's own batch pull requests count; a fork or a person cannot hold the job (D6)", () => {
  const pull = (fields: Record<string, unknown> = {}, head: Record<string, unknown> = {}) => ({
    number: 1,
    user: { login: workflowLogin },
    head: {
      ref: `${batchBranchPrefix}1`,
      repo: { full_name: "boburning/portcove" },
      ...head,
    },
    ...fields,
  });
  assert.equal(jobBatches([pull()], "boburning/portcove").length, 1);
  for (const other of [
    pull({}, { repo: { full_name: "someone/portcove" } }),
    pull({ user: { login: "someone" } }),
    pull({}, { ref: "feature/x" }),
    pull({}, { repo: null }),
  ])
    assert.equal(jobBatches([other], "boburning/portcove").length, 0, JSON.stringify(other));
});

void test("a batch is proposed only for a material change (D5)", () => {
  const { entry } = fixture();
  const at = (generatedAt: string, ...entries: ListingFactsEntry[]): ListingFactsTable => ({
    ...emptyFactsTable(generatedAt),
    entries,
    entries_sha256: digestOf(entries),
  });
  const none = { added: 0, withdrawn: 0, changed: 0 };
  const base = at("2026-11-20T00:00:00.000Z", entry);
  const reconfirmed = structuredClone(entry);
  reconfirmed.observation.observed_at = "2026-11-21T00:00:00.000Z";
  // Only time, provenance and a fresh reconfirmation moved: no pull request.
  assert.equal(materialChange(base, at("2026-11-21T00:00:00.000Z", reconfirmed), none), false);
  // An enrollment change, a new or changed entry is material.
  assert.equal(
    materialChange(base, at("2026-11-21T00:00:00.000Z", reconfirmed), { ...none, added: 1 }),
    true,
  );
  assert.equal(materialChange(at("2026-11-20T00:00:00.000Z"), base, none), true);
  const changed = structuredClone(reconfirmed);
  changed.unread_forms = [".7z"];
  assert.equal(materialChange(base, at("2026-11-21T00:00:00.000Z", changed), none), true);
  // An offered entry confirmed long ago is refreshed before it ages out.
  const old = at("2026-11-20T00:00:00.000Z", {
    ...structuredClone(entry),
    observation: { ...entry.observation, observed_at: "2026-11-01T00:00:00.000Z" },
  });
  assert.equal(materialChange(old, at("2026-11-21T00:00:00.000Z", reconfirmed), none), true);
});

// ---------------------------------------------------------------------------
// Observations and owner queues.

void test("the observer handoff becomes one worker report, first observation of each listing kept", () => {
  const directory = mkdtempSync(join(tmpdir(), "facts-handoff-"));
  try {
    const observation = (repository: string) => ({
      provider: "github",
      repository,
      status: "complete",
    });
    writeFileSync(
      join(directory, "a.json"),
      JSON.stringify({
        descriptive_listing_candidates: [
          { id: "one", upstream_observation: observation("o/one") },
          { id: "two", upstream_observation: observation("o/two") },
        ],
      }),
    );
    writeFileSync(
      join(directory, "b.json"),
      JSON.stringify({
        descriptive_listing_candidates: [
          { id: "one", upstream_observation: observation("o/late") },
        ],
      }),
    );
    writeFileSync(
      join(directory, "summary.json"),
      JSON.stringify({ descriptive_listing_candidates: [{ id: "x" }] }),
    );
    writeFileSync(join(directory, "notes.txt"), "ignored");
    assert.deepEqual(handoffObservations(directory), {
      listings: [
        { id: "one", upstream_observation: observation("o/one") },
        { id: "two", upstream_observation: observation("o/two") },
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("the exception queues report counts per reason and the top unsupported forms", () => {
  const { markdown, counts } = queueSummary({
    registration_queues: {
      reasons: { "no-observation": ["a", "b", "c"], "ambiguous-player": ["d"], "too-large": [] },
      unread_forms: { ".7z": ["a", "b"], ".exe": ["c"], ".dmg": [] },
      exclusions: { "asset-tool-name:patcher": ["e"] },
      refusals: { "core-source-invalid": ["f", "g"], "digest-mismatch": [] },
    },
  });
  assert.deepEqual(counts, {
    reasons: { "no-observation": 3, "ambiguous-player": 1 },
    unread_forms: { ".7z": 2, ".exe": 1 },
    exclusions: { "asset-tool-name:patcher": 1 },
    refusals: { "core-source-invalid": 2 },
  });
  assert.match(markdown, /\| `no-observation` \| 3 \|/u);
  assert.match(markdown, /\| `core-source-invalid` \| 2 \|/u);
  assert.match(markdown, /Top unread package forms/u);
  assert.throws(() => queueSummary({}), /registration_queues/u);
});

// ---------------------------------------------------------------------------
// The workflow: built disabled, bounded, least privilege.

void test("the workflow does nothing until the owner enables it and writes nothing on a dry run", () => {
  const text = readFileSync(join(root, batchWorkflowPath), "utf8");
  const workflow = parse(text) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<
      string,
      {
        if?: string;
        "timeout-minutes"?: number;
        permissions?: Record<string, string>;
        steps: {
          run?: string;
          uses?: string;
          "timeout-minutes"?: number;
          with?: Record<string, unknown>;
        }[];
      }
    >;
  };
  const dispatch = workflow.on.workflow_dispatch as {
    inputs: Record<string, { default: unknown; type: string }>;
  };
  assert.equal(dispatch.inputs.dry_run!.default, true);
  assert.equal(dispatch.inputs.dry_run!.type, "boolean");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "listing-facts-batch",
    "cancel-in-progress": false,
  });
  const enabled = "vars.PORTCOVE_FACTS_BATCH_ENABLED == 'true'";
  const dryRun = "github.event_name == 'workflow_dispatch' && inputs.dry_run";
  // Every job is gated: by the variable, or (read-only jobs) by a dry-run dispatch.
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(job.if, `${name} has no condition`);
    const gated = job.if.includes(enabled) || ["derive"].includes(name);
    assert.ok(gated, `${name} is not gated by the variable`);
    assert.ok(job["timeout-minutes"] && job["timeout-minutes"] <= 360, `${name} timeout`);
    // Every step has a finite budget, and the job outlasts their sum, so a
    // slow step fails inside the job and the later always-steps still run.
    let sum = 0;
    for (const step of job.steps) {
      assert.ok(
        step["timeout-minutes"] && step["timeout-minutes"] < job["timeout-minutes"],
        `${name}: a step has no finite budget: ${step.run?.slice(0, 60) ?? step.uses}`,
      );
      sum += step["timeout-minutes"];
    }
    assert.ok(sum <= job["timeout-minutes"], `${name}: steps may take ${sum} minutes`);
    const writes = Object.entries(job.permissions ?? {}).filter(([, access]) => access === "write");
    if (writes.length) {
      // A writing job runs only when enabled and never on a dry run.
      assert.ok(job.if.includes(enabled), `${name} writes without the variable`);
      assert.ok(job.if.includes(`!(${dryRun})`), `${name} writes on a dry run`);
    }
  }
  // The gate job admits a dry-run dispatch only, and derive needs the gate.
  assert.ok(workflow.jobs.gate!.if!.includes(`(${dryRun})`));
  assert.ok(workflow.jobs.derive!.if!.includes("needs.gate.outputs.blocked == 'false'"));
  assert.ok(workflow.jobs.derive!.if!.includes("needs.gate.outputs.pr_state == 'none'"));
  assert.ok(Object.values(workflow.jobs.derive!.permissions!).every((access) => access === "read"));
  // A dry run never saves the worker state.
  const save = workflow.jobs.derive!.steps.find((step) =>
    String(step.uses).startsWith("actions/cache/save"),
  );
  assert.match(String((save as { if?: string }).if), /env\.DRY_RUN != 'true'/u);
  // The merge reads commit statuses for the guarded route (U2) and checks
  // the batch composed onto the current main (D3).
  assert.equal(workflow.jobs.merge!.permissions!.statuses, "read");
  assert.match(text, /--target "\$TARGET" --tree "\$TREE"/u);
  // The freshness alert is evaluated on every enabled run, also while stopped.
  assert.doesNotMatch(workflow.jobs.notify!.if!, /blocked/u);
  // Only the built-in token: no secrets, no personal tokens.
  assert.doesNotMatch(text, /secrets\./u);
  // Merges go through the guarded route only, never an API shortcut.
  assert.match(text, /scripts\/pr-delivery\.mts"? merge[^\n]*\n[^\n]*--verify-local-composition/u);
  assert.doesNotMatch(text, /pulls\/[^\s]*\/merge|gh pr merge|enable_pr_auto_merge|--admin/u);
});
