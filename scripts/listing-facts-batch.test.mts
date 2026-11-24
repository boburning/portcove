import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CapacityMeasure } from "./catalog-capacity.mts";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { AuthoredPort } from "./catalog-authoring.mts";
import {
  identityShards,
  identityBudgetMinutes,
  matrixJobLimit,
  reproductionDeadlineMinutes,
  reproductionBatchEntries,
  reproductionsPerBatch,
  digestOf,
  emptyFactsTable,
  FACTS_PARSER,
  FACTS_PARSER_VERSION,
  listingWords,
  needsReproduction,
  reproductionPlan,
  reusedArchives,
  type ListingFactsEntry,
  type ListingFactsTable,
  type NameSuggestion,
  type PlayerFact,
} from "./catalog-generated-registration.mts";
import {
  artifactFact,
  assetsDigest,
  InspectionError,
  OverBudgetError,
  boundLinesOf,
  boundedTimeout,
  type ByteInspector,
  type NameClassifier,
} from "./listing-package-facts.mts";
import {
  authoredSourceProblem,
  batchAllowlist,
  batchBranchPrefix,
  batchCapacity,
  capacityDetail,
  carriedSummary,
  carryOver,
  retainedContractReserveBytes,
  derivedBatchPaths,
  batchInputs,
  batchPullBody,
  batchPullProblems,
  batchWorkflowPath,
  allowlistProblems,
  changedEntries,
  changedPaths,
  checkerChanges,
  checkerPaths,
  checkerSeparationProblem,
  factsEntryCount,
  ciRunFor,
  claimsBatch,
  clockProblems,
  clockSkewMs,
  batchOutputs,
  batchWaitDays,
  modeViolations,
  outputsProblems,
  collectConditions,
  expectedBatchAuthor,
  isExpectedBatchAuthor,
  freshnessAlertDays,
  refreshAfterDays,
  reproductionDetails,
  reproductionParallelism,
  reproductionScopeProblems,
  reproductionTransient,
  githubJson,
  githubRequest,
  githubFirstRetryMs,
  githubResponseBytes,
  TransientGithubError,
  transientInspection,
  readUnfiled,
  githubTokenHourlyRequests,
  reproductionHourlyRequests,
  quotaResumeAt,
  resetQuota,
  parseWorkerSummary,
  jobBatches,
  materialChange,
  workflowLogin,
  factsFallingBehind,
  handoffObservations,
  inputsArtifactFiles,
  inputsProblems,
  mergeMessage,
  withdrawalCauses,
  identityRefusal,
  inspectionRefusal,
  GithubStatusError,
  identityRefusals,
  refusalRecord,
  withholdRefused,
  withheldSummary,
  parseProviderRelease,
  parseProviderReleaseList,
  parseRawDiff,
  pathViolations,
  provenanceProblems,
  queueSummary,
  reproduceFacts,
  requiredCheckState,
  requiredContexts,
  stopConditions,
  stopConditionNames,
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
    name: null,
    body: null,
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
    listing_words: listingWords({ id, name: "Fixture Game" }),
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
        text: null,
        assets: release.assets,
      }),
    },
    ineligible: null,
    unread_forms: [],
    observed_releases: [
      {
        release_id: 8,
        tag: "v1.0",
        core_prerelease: false,
        prerelease: false,
        published_at: "2026-11-01T00:00:00.000Z",
        packaged: true,
        text: "unobserved" as const,
        title: null,
        statement: null,
      },
    ],
    other_packages: [],
    asset_names: ["README.md"],
    refused_archives: [],
    attempt: null,
    artifacts: [artifact],
  };
  return { release, entry, players };
}
/** A provider release as the REST release list states it. */
const listed = (release: ProviderRelease) => ({
  url: `https://api.github.com/repos/${release.repository}/releases/${release.id}`,
  id: release.id,
  tag_name: release.tag_name,
  draft: release.draft,
  prerelease: release.prerelease,
  published_at: release.published_at,
  name: release.name,
  body: release.body,
  assets: release.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    size: asset.size,
    browser_download_url: asset.url,
    ...(asset.sha256 ? { digest: `sha256:${asset.sha256}` } : {}),
  })),
});
/** The release list reader: the given releases, read through the strict list parser. */
const lister =
  (...releases: (ProviderRelease | Record<string, unknown>)[]) =>
  async (repositoryId: number) => {
    assert.equal(repositoryId, 4242);
    return parseProviderReleaseList(
      releases.map((release) =>
        "repository" in release ? listed(release as ProviderRelease) : release,
      ),
    );
  };
const inspector =
  (players: PlayerFact[] | Error, log: string[] = []): ByteInspector =>
  async (asset) => {
    log.push(asset.name);
    if (players instanceof Error) throw players;
    return { players: players.map((item) => ({ ...item })), names: [], leaves: [] };
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
  const raw = (mode: string, file: string) =>
    `:${mode === "000000" ? "000000" : "100644"} ${mode} ${"0".repeat(40)} ${"1".repeat(40)} M\0${file}\0`;
  const git = (args: string[]) =>
    args[0] === "diff"
      ? `${raw("100644", batchAllowlist[0])}${raw("100644", "scripts/x.mts")}`
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

void test("an allowlisted path must stay a regular, non-executable file (F4)", () => {
  const header = (from: string, to: string) =>
    `:${from} ${to} ${"0".repeat(40)} ${"1".repeat(40)} M`;
  const facts = batchAllowlist[0];
  assert.deepEqual(parseRawDiff(`${header("100644", "100644")}\0${facts}\0`), [
    { path: facts, modes: ["100644", "100644"] },
  ]);
  assert.equal(parseRawDiff("not a raw diff\0x\0"), undefined);
  assert.equal(parseRawDiff(`${header("100644", "100644")}\0`), undefined);
  // Added, changed and deleted regular files are fine.
  for (const modes of [
    ["000000", "100644"],
    ["100644", "100644"],
    ["100644", "000000"],
  ] as [string, string][])
    assert.deepEqual(modeViolations([{ path: facts, modes }]), [], modes.join());
  // A symlink, an executable bit or a gitlink at an allowlisted name is not.
  for (const mode of ["120000", "100755", "160000"]) {
    assert.equal(modeViolations([{ path: facts, modes: ["100644", mode] }]).length, 1, mode);
    assert.equal(modeViolations([{ path: facts, modes: [mode, "100644"] }]).length, 1, mode);
    assert.match(allowlistProblems([{ path: facts, modes: ["100644", mode] }]).join(), /regular/u);
  }
  // Modes outside the allowlist are already a path violation.
  assert.deepEqual(modeViolations([{ path: "scripts/x.mts", modes: ["000000", "100755"] }]), []);
  assert.match(allowlistProblems(undefined).join(), /could not list/u);

  // Against real git: the raw diff names each kind of change by mode.
  const directory = mkdtempSync(join(tmpdir(), "listing-facts-modes-"));
  try {
    const run = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      return result.status === 0 ? result.stdout : undefined;
    };
    const must = (args: string[]) => assert.notEqual(run(args), undefined, args.join(" "));
    must(["init", "--quiet"]);
    must(["config", "user.email", "fixture@example.invalid"]);
    must(["config", "user.name", "fixture"]);
    must(["config", "core.symlinks", "true"]);
    mkdirSync(join(directory, "crates/portcove-core/catalog"), { recursive: true });
    for (const file of batchAllowlist) writeFileSync(join(directory, file), "{}\n");
    must(["add", "-A"]);
    must(["commit", "--quiet", "-m", "base"]);
    const base = run(["rev-parse", "HEAD"])!.trim();
    const kinds: Record<string, () => void> = {
      symlink: () => {
        rmSync(join(directory, batchAllowlist[0]));
        symlinkSync("listings.json", join(directory, batchAllowlist[0]));
      },
      executable: () => chmodSync(join(directory, batchAllowlist[1]), 0o755),
      // Staged directly: the index holds a commit where the file was.
      gitlink: () => must(["update-index", "--cacheinfo", `160000,${base},${batchAllowlist[2]}`]),
    };
    for (const [kind, change] of Object.entries(kinds)) {
      must(["reset", "--quiet", "--hard", base]);
      if (kind !== "gitlink") {
        change();
        must(["add", "-A"]);
      } else change();
      must(["commit", "--quiet", "-m", kind]);
      const entries = changedEntries(run, base, "HEAD");
      assert.ok(entries, kind);
      assert.equal(modeViolations(entries).length, 1, `${kind}: ${JSON.stringify(entries)}`);
      // The paths themselves are allowlisted: only the mode check refuses.
      assert.deepEqual(pathViolations(changedPaths(run, base, "HEAD")!), [], kind);
    }
    must(["reset", "--quiet", "--hard", base]);
    writeFileSync(join(directory, batchAllowlist[0]), '{"x":1}\n');
    must(["commit", "--quiet", "-am", "regular"]);
    assert.deepEqual(allowlistProblems(changedEntries(run, base, "HEAD")), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("the facts table and the code that checks it must be separate changes (F1)", () => {
  const read = (file: string) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch {
      return undefined;
    }
  };
  const checker = checkerPaths(read);
  // Derived, not listed: the workflows, the import closure of the checker
  // scripts, the CLI dispatch and Core's inspection module with the Core
  // modules it names.
  for (const expected of [
    ".github/workflows/ci.yml",
    ".github/workflows/listing-facts-batch.yml",
    ".github/actions/setup-rust/",
    "scripts/listing-facts-batch.mts",
    "scripts/listing-package-facts.mts",
    "scripts/catalog-generated-registration.mts",
    "scripts/validation-plan.mts",
    "scripts/generate-catalog.mts",
    // Imported, never named in the roots.
    "scripts/bounded-zip.mts",
    "scripts/runtime-values.mts",
    "scripts/catalog-route-facts.mts",
    "apps/desktop/src/catalog-values.generated.ts",
    "Cargo.lock",
    "Cargo.toml",
    "rust-toolchain.toml",
    "vendor/",
    ".node-version",
    ".github/actions/stop-if-superseded/",
    "scripts/ci-baseline.mts",
    "crates/portcove-cli/Cargo.toml",
    "crates/portcove-core/Cargo.toml",
    "crates/portcove-core/src/lib.rs",
    "crates/portcove-cli/src/main.rs",
    "crates/portcove-cli/src/catalog.rs",
    "crates/portcove-cli/src/catalog/",
    "crates/portcove-cli/src/catalog/render.rs",
    "crates/portcove-cli/src/startup.rs",
    "crates/portcove-cli/src/args.rs",
    "crates/portcove-cli/src/schema.rs",
    "crates/portcove-core/src/package_shape.rs",
    "crates/portcove-core/src/package_shape/",
    "crates/portcove-core/src/archive.rs",
    "crates/portcove-core/src/route_facts.rs",
  ])
    assert.ok(checker.includes(expected), expected);
  for (const file of checker.filter((entry) => !entry.endsWith("/")))
    assert.notEqual(read(file), undefined, `${file} is named but does not exist`);
  // Fixed directory entries must exist (derived module directories may not).
  for (const directory of [
    ".github/actions/setup-rust/",
    ".github/actions/stop-if-superseded/",
    "vendor/",
    "crates/portcove-core/src/package_shape/",
  ])
    assert.ok(
      checker.includes(directory) && statSync(join(root, directory)).isDirectory(),
      `${directory} is named but is not a directory`,
    );
  // Every workspace member's manifest, derived from the workspace manifest.
  for (const manifest of [
    "tools/rust-portability/Cargo.toml",
    "apps/desktop/src-tauri/Cargo.toml",
    "crates/portcove-listing-carrier/Cargo.toml",
  ])
    assert.ok(checker.includes(manifest), manifest);
  assert.deepEqual(
    checkerChanges(
      ["crates/portcove-core/src/package_shape/machine.rs", "docs/CATALOG.md"],
      checker,
    ),
    ["crates/portcove-core/src/package_shape/machine.rs"],
  );
  const facts = batchAllowlist[0];
  const enrollment = batchAllowlist[1];
  const entry = { id: "port.example" };
  const filled = { baseline: { entries: [entry] }, current: { entries: [entry] } };
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/listing-facts-batch.yml",
    "scripts/listing-facts-batch.mts",
    "scripts/listing-package-facts.mts",
    "scripts/catalog-generated-registration.mts",
    "scripts/validation-plan.mts",
    "crates/portcove-core/src/package_shape/machine.rs",
    "crates/portcove-core/src/package_shape/listing.rs",
  ])
    assert.match(
      checkerSeparationProblem([facts, enrollment, path], checker, filled) ?? "",
      /must be separate changes/u,
      path,
    );
  // The facts alone, a batch's generated outputs, and a checker change with
  // the enrollment it necessarily regenerates are not refused.
  assert.equal(checkerSeparationProblem([...batchAllowlist], checker, filled), undefined);
  assert.equal(
    checkerSeparationProblem(
      [enrollment, "scripts/catalog-generated-registration.mts"],
      checker,
      filled,
    ),
    undefined,
  );
  assert.equal(checkerSeparationProblem([facts, "docs/CATALOG.md"], checker, filled), undefined);
});

void test("an empty facts table on both sides may change with its checker (B1)", () => {
  const checker = checkerPaths((file) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch {
      return undefined;
    }
  });
  const facts = batchAllowlist[0];
  const change = [facts, "scripts/listing-package-facts.mts"];
  const empty = { format: 6, entries: [] };
  const filled = { format: 6, entries: [{ id: "port.example" }] };
  // Empty to empty: a format bump rewrites a table with nothing to verify.
  assert.equal(
    checkerSeparationProblem(change, checker, { baseline: empty, current: empty }),
    undefined,
  );
  assert.equal(
    checkerSeparationProblem(change, checker, { baseline: null, current: empty }),
    undefined,
  );
  // Empty to non-empty, non-empty to anything, or an unreadable side: refused.
  for (const [baseline, current] of [
    [empty, filled],
    [null, filled],
    [filled, empty],
    [filled, filled],
    [{ format: 6 }, empty],
    [empty, "not a table"],
  ] as const)
    assert.match(
      checkerSeparationProblem(change, checker, { baseline, current }) ?? "",
      /must be separate changes/u,
      JSON.stringify([baseline, current]),
    );
  assert.equal(factsEntryCount(null), 0);
  assert.equal(factsEntryCount(empty), 0);
  assert.equal(factsEntryCount(filled), 1);
  assert.equal(factsEntryCount({}), undefined);
});

// ---------------------------------------------------------------------------
// Reproduction.

/** Every entry's listing binds no release line. */
const unbound = (entries: readonly ListingFactsEntry[]) =>
  new Map(entries.map((entry) => [entry.port_id, null] as const));

void test("an entry is reproduced only when its exact bytes rebuild byte-equal facts", async () => {
  const { release, entry, players } = fixture();
  const log: string[] = [];
  const ok = await reproduceFacts({
    entries: [entry],
    listReleases: lister(release),
    inspect: inspector(players, log),
    classify: coreClassifier,
    boundLines: unbound([entry]),
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
      listReleases: lister(copy.release),
      inspect: inspector(inspected),
      classify: coreClassifier,
      boundLines: unbound([copy.entry]),
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
        text: null,
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
    listReleases: async () => {
      throw new Error("rate limited");
    },
    inspect: inspector(players),
    classify: coreClassifier,
    boundLines: unbound([entry]),
  });
  // An untyped failure is no statement of the provider's data: a fault of
  // the job itself, which stops it instead of withholding the identity.
  assert.equal(unavailable.refused[0]!.reason, "job-fault");
  const listedAs = async (error: Error) =>
    (
      await reproduceFacts({
        entries: [entry],
        listReleases: async () => {
          throw error;
        },
        inspect: inspector(players),
        classify: coreClassifier,
        boundLines: unbound([entry]),
      })
    ).refused[0]!.reason;
  assert.equal(
    await listedAs(new GithubStatusError("GET x answered 404.", 404)),
    "release-unavailable",
  );
  assert.equal(
    await listedAs(new GithubStatusError("GET x answered 410.", 410)),
    "release-unavailable",
  );
  assert.equal(await listedAs(new GithubStatusError("GET x answered 401.", 401)), "job-fault");
  assert.equal(await listedAs(new GithubStatusError("GET x answered 403.", 403)), "job-fault");
  assert.equal(await listedAs(new TypeError("x is not a function")), "job-fault");
  // Inspection: Core's verdict and typed failures are the identity's; the
  // deadline is the runner's; anything untyped is the job's own fault.
  assert.equal(inspectionRefusal(new InspectionError("Core refused.", true)), "core-refused");
  assert.equal(
    inspectionRefusal(new InspectionError("Download failed.", false, "core-unknown", "network")),
    "transient",
  );
  assert.equal(
    inspectionRefusal(new InspectionError("Killed.", false, "core-unknown", "over-budget")),
    "over-budget",
  );
  assert.equal(
    inspectionRefusal(
      new InspectionError("No result.", false, "core-unknown", "unreadable-archive"),
    ),
    "asset-unavailable",
  );
  assert.equal(inspectionRefusal(new Error("spawn portcove ENOENT")), "job-fault");
  assert.equal(await refusal(() => undefined, new Error("spawn portcove ENOENT")), "job-fault");
  assert.equal(identityRefusal({ reason: "job-fault" }), false);
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
    text: null,
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
      if (asset.id !== 23)
        return { players: players.map((item) => ({ ...item })), names: [], leaves: [] };
      if (refusal instanceof Error) throw refusal;
      return { players: refusal, names: [], leaves: [] };
    };
  const run = (copy: ListingFactsEntry, inspect: ByteInspector, provider = release) =>
    reproduceFacts({
      entries: [copy],
      listReleases: lister(provider),
      inspect,
      classify: coreClassifier,
      boundLines: unbound([copy]),
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
  // A forged other-package list or release line record is refused.
  const setup = {
    asset_id: 24,
    name: "Setup.exe",
    size: 64,
    sha256: sha("installer"),
    platforms: ["windows-x86-64"],
  };
  assert.equal(
    await reason({ ...entry, other_packages: [setup] }, refusing(sameRefusal)),
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
  // Another package form beside the archives must be recorded with its size,
  // digest and platforms: an entry that omits it is refused (B3, F8).
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
    text: null,
    assets: installer.assets,
  });
  assert.equal(await reason(recorded, refusing(sameRefusal), installer), "release-changed");
  const recordedInstaller = { ...setup, name: "Install-Game.exe" };
  recorded.other_packages = [recordedInstaller];
  // Every other asset name is recorded too, for the gate's own classifier (R7).
  assert.equal(await reason(recorded, refusing(sameRefusal), installer), "mismatch");
  recorded.asset_names = [...recorded.asset_names, "Install-Game.exe"];
  assert.equal(await reason(recorded, refusing(sameRefusal), installer), undefined);
  assert.equal(
    await reason(
      { ...recorded, asset_names: [...recorded.asset_names, "Extra.exe"] },
      refusing(sameRefusal),
      installer,
    ),
    "mismatch",
  );
  for (const forged of [
    { ...recordedInstaller, sha256: sha("other-program") },
    { ...recordedInstaller, sha256: null },
    { ...recordedInstaller, size: 65 },
    { ...recordedInstaller, platforms: ["linux-x86-64"] },
  ])
    assert.equal(
      await reason({ ...recorded, other_packages: [forged] }, refusing(sameRefusal), installer),
      "release-changed",
    );
  // An unread container is recorded with the platforms its name permits.
  const container = structuredClone(release);
  container.assets.push({
    id: 25,
    name: "Game-win64.7z",
    size: 64,
    sha256: sha("container"),
    url: "https://github.com/x/g.7z",
  });
  const withContainer = structuredClone(entry);
  withContainer.observation.assets_sha256 = assetsDigest({
    id: 8,
    version: "v1.0",
    published_at: null,
    provider_prerelease: false,
    assets_complete: true,
    malformed_assets: 0,
    text: null,
    assets: container.assets,
  });
  assert.equal(await reason(withContainer, refusing(sameRefusal), container), "release-changed");
  withContainer.other_packages = [
    {
      asset_id: 25,
      name: "Game-win64.7z",
      size: 64,
      sha256: sha("container"),
      platforms: ["windows-x86-64"],
    },
  ];
  withContainer.asset_names = [...withContainer.asset_names, "Game-win64.7z"];
  assert.equal(await reason(withContainer, refusing(sameRefusal), container), undefined);
});

void test("reproduction restates the observed releases from the release list (F8)", async () => {
  const { release, entry, players } = fixture(unseen, [player("Game/Game.exe")]);
  // An older release of another line, in the observer's window.
  const tool = {
    id: 7,
    repository: release.repository,
    tag_name: "texture-studio-v1.0.0",
    draft: false,
    prerelease: false,
    published_at: "2026-10-01T00:00:00Z",
    name: null,
    body: null,
    assets: [
      {
        id: 31,
        name: "Editor.zip",
        size: 10,
        sha256: sha("editor"),
        url: "https://github.com/x/e",
      },
    ],
  };
  const run = async (copy: ListingFactsEntry, ...listedReleases: ProviderRelease[]) =>
    (
      await reproduceFacts({
        entries: [copy],
        listReleases: lister(...listedReleases),
        inspect: inspector(players),
        classify: coreClassifier,
        boundLines: unbound([copy]),
      })
    ).refused[0];
  // The entry's single observed release matches a list of that release alone.
  assert.equal(await run(entry, release), undefined);
  // Omitting another line's release from the observed releases is refused, so
  // the release-line exclusion cannot be forged away.
  const omitted = await run(entry, release, tool);
  assert.equal(omitted?.reason, "mismatch");
  assert.match(omitted?.detail ?? "", /observed releases/u);
  // Recording it as the list states it reproduces.
  const complete = structuredClone(entry);
  complete.observed_releases.unshift({
    release_id: 7,
    tag: "texture-studio-v1.0.0",
    core_prerelease: false,
    prerelease: false,
    published_at: "2026-10-01T00:00:00.000Z",
    packaged: true,
    text: "unobserved" as const,
    title: null,
    statement: null,
  });
  assert.equal(await run(complete, release, tool), undefined);
});

void test("reproduction has no entry, byte or size bound; only the shard's clock refuses (B2)", async () => {
  // Replaces the former 64-entry / 4 GiB / 512 MiB / 30-minute budget.
  const { release, entry, players } = fixture(unseen, [player("Game/Game.exe")], 4096);
  const run = (entries: ListingFactsEntry[], clock?: () => number, deadline?: number) =>
    reproduceFacts({
      entries,
      listReleases: lister(release),
      inspect: inspector(players),
      classify: coreClassifier,
      boundLines: unbound(entries),
      ...(clock ? { clock } : {}),
      ...(deadline === undefined ? {} : { deadline }),
    });
  // Many entries, each as large as the provider allows, are all read.
  const wide = await run([entry, { ...entry, port_id: "zz-second" }]);
  assert.deepEqual(wide.verified, [unseen, "zz-second"]);
  assert.deepEqual(wide.refused, []);
  // A shard's deadline refuses what it reaches, never trusts it.
  let now = 0;
  const late = await run([entry], () => (now += 20), 10);
  assert.equal(late.refused[0]!.reason, "over-budget");
});

void test("reproduction shards hold every entry, deterministically, within the matrix limit (B2)", () => {
  assert.equal(matrixJobLimit, 256);
  const ids = Array.from({ length: 400 }, (_, index) => `zz-${String(index).padStart(3, "0")}`);
  const shards = identityShards(ids.toReversed());
  assert.equal(shards.length, 256);
  assert.deepEqual(shards.flat().toSorted(), ids);
  assert.ok(shards.every((shard) => shard.length >= 1 && shard.length <= 2));
  assert.deepEqual(identityShards(ids), shards, "independent of input order");
  assert.deepEqual(identityShards(["zz-a", "zz-b"]), [["zz-a"], ["zz-b"]]);
  assert.deepEqual(identityShards([]), []);
});

void test("reproduction proves the named release is still the newest stable one (F2)", async () => {
  const { release, entry, players } = fixture();
  // The entry records the newer release 9 as the list states it (F8).
  const recording = (tag: string, prerelease: boolean) => {
    const copy = structuredClone(entry);
    copy.observed_releases.push({
      release_id: 9,
      tag,
      core_prerelease: prerelease,
      prerelease,
      published_at: "2026-11-10T00:00:00.000Z",
      packaged: false,
      text: "unobserved" as const,
      title: null,
      statement: null,
    });
    return copy;
  };
  const run = (
    listReleases: Parameters<typeof reproduceFacts>[0]["listReleases"],
    recorded = entry,
  ) =>
    reproduceFacts({
      entries: [recorded],
      listReleases,
      inspect: inspector(players),
      classify: coreClassifier,
      boundLines: unbound([recorded]),
    });
  const other = (fields: Partial<ProviderRelease>): ProviderRelease => ({
    ...structuredClone(release),
    id: 9,
    published_at: "2026-11-10T00:00:00Z",
    assets: [],
    ...fields,
  });
  // A newer prerelease or draft does not displace the stable release.
  assert.deepEqual(
    (await run(lister(other({ tag_name: "v2.0-rc1" }), release), recording("v2.0-rc1", true)))
      .verified,
    [unseen],
  );
  assert.deepEqual(
    (
      await run(
        lister(other({ tag_name: "v3.0", prerelease: true }), release),
        recording("v3.0", true),
      )
    ).verified,
    [unseen],
  );
  // Left out of the entry, the newer release is a mismatch.
  assert.equal(
    (await run(lister(other({ tag_name: "v2.0-rc1" }), release))).refused[0]!.reason,
    "mismatch",
  );
  assert.deepEqual(
    (await run(lister(other({ tag_name: "alphabet-1.0", draft: true }), release))).verified,
    [unseen],
  );
  const refused = async (listReleases: Parameters<typeof run>[0]) => {
    const result = await run(listReleases);
    assert.deepEqual(result.verified, []);
    return result.refused[0]!;
  };
  // An older release whose bytes reproduce must not enroll.
  const newer = await refused(lister(other({ tag_name: "alphabet-1.0" }), release));
  assert.equal(newer.reason, "not-latest-stable");
  assert.match(newer.detail, /id 9, not the recorded id 8/u);
  // A listing bound to the release's own line is checked on that line only,
  // as the worker chooses; an entry without an authored listing is refused.
  const onLine = (boundLines: ReadonlyMap<string, string | null>) =>
    reproduceFacts({
      entries: [recording("alphabet-1.0", false)],
      listReleases: lister(other({ tag_name: "alphabet-1.0" }), release),
      inspect: inspector(players),
      classify: coreClassifier,
      boundLines,
    });
  assert.deepEqual((await onLine(new Map([[unseen, ""]]))).verified, [unseen]);
  assert.equal(
    (await onLine(new Map([[unseen, "alphabet"]]))).refused[0]!.reason,
    "not-latest-stable",
  );
  assert.equal((await onLine(new Map())).refused[0]!.reason, "out-of-scope");
  // A newer tag Core cannot classify, a newest release without a parseable
  // time and an unreadable asset are unknown, never a fall-back.
  assert.equal(
    (await refused(lister(other({ tag_name: "v9-unclassified" }), release))).reason,
    "not-latest-stable",
  );
  assert.match(
    (await refused(lister(other({ tag_name: "v2.0-rc1", published_at: null }), release))).detail,
    /no parseable publication time/u,
  );
  // The offered release is read from the list itself (J2): a malformed
  // record of it is no release to offer.
  const malformed = await refused(
    lister({ ...listed(release), assets: [...listed(release).assets, { id: "x" }] }),
  );
  assert.equal(malformed.reason, "release-unavailable");
  assert.match(malformed.detail, /not a well-formed release/u);
  // An unreadable asset of a newer release leaves the newest stable unknown.
  assert.match(
    (
      await refused(
        lister({ ...listed(other({ tag_name: "v2.0-rc1" })), assets: [{ id: "x" }] }, release),
      )
    ).detail,
    /cannot read/u,
  );
  // A full page that does not hold the offered release refuses it; one whose
  // newest stable release of the line is the offered one reproduces, since
  // nothing on a later page is newer (J7). An unreadable list is unavailable.
  const page = Array.from({ length: 100 }, (_, index) =>
    listed(other({ id: 100 + index, tag_name: "v2.0-rc1" })),
  );
  assert.equal((await refused(lister(...page))).reason, "release-unavailable");
  const drafts = Array.from({ length: 99 }, (_, index) =>
    listed(other({ id: 100 + index, tag_name: `v0.${index}`, draft: true })),
  );
  assert.deepEqual((await run(lister(release, ...drafts))).verified, [unseen]);
  assert.equal(
    (
      await refused(async () => {
        throw new Error("rate limited");
      })
    ).reason,
    "job-fault",
  );
  assert.equal(
    (await refused(async () => parseProviderReleaseList([{ id: 8 }]))).reason,
    "release-unavailable",
  );
  assert.throws(() => parseProviderReleaseList({}), /malformed/u);
});

void test("a reproduction that reaches its deadline refuses the entry as over-budget (F7)", async () => {
  const { release, entry, players } = fixture();
  // Every download and Core run is cut to the time left; none starts after it.
  // No fixed per-operation cap: only the deadline cuts.
  assert.equal(boundedTimeout(undefined), undefined);
  assert.equal(boundedTimeout(1_000_000 + 5000, 1_000_000), 5000);
  assert.equal(boundedTimeout(1_000_000 + 60 * 60_000, 1_000_000), 60 * 60_000);
  assert.throws(() => boundedTimeout(1_000_000, 1_000_000), OverBudgetError);
  const base = {
    entries: [entry, { ...entry, port_id: "zz-second" }],
    listReleases: lister(release),
    classify: coreClassifier,
    boundLines: unbound([entry, { ...entry, port_id: "zz-second" }]),
  };
  // A download or Core run that reached the deadline is over-budget, not a
  // fact about the bytes, and later entries are refused the same way.
  const cut = await reproduceFacts({
    ...base,
    inspect: async () => {
      throw new OverBudgetError("The Core inspection reached the deadline.");
    },
  });
  assert.deepEqual(
    cut.refused.map((refusal) => refusal.reason),
    ["over-budget", "over-budget"],
  );
  // A classification cut at the deadline refuses everything as over-budget.
  const late = await reproduceFacts({
    ...base,
    inspect: inspector(players),
    classify: async () => {
      throw new OverBudgetError("The Core name classification reached the deadline.");
    },
  });
  assert.deepEqual(
    late.refused.map((refusal) => refusal.reason),
    ["over-budget", "over-budget"],
  );
  // A passed deadline refuses before any read.
  const reads: string[] = [];
  const passed = await reproduceFacts({
    ...base,
    inspect: inspector(players, reads),
    deadline: Date.now() - 1,
  });
  assert.deepEqual(reads, []);
  assert.ok(passed.refused.every((refusal) => refusal.reason === "over-budget"));
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
    ineligible: { reason: "no-digest", detail: "x", cause: null },
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

void test("a whole table of new entries is planned for reproduction in one change (B2)", () => {
  // Replaces the former batch hold at the reproduction budget.
  const ids = Array.from({ length: 300 }, (_, index) => `zz-${String(index).padStart(3, "0")}`);
  const entries = ids.map((id) => fixture(id).entry);
  const previous = emptyFactsTable("2026-11-20T00:00:00.000Z");
  const next: ListingFactsTable = {
    ...emptyFactsTable("2026-11-20T00:00:00.000Z"),
    entries,
    entries_sha256: digestOf(entries),
  };
  const plan = reproductionPlan(previous, next);
  assert.deepEqual(
    plan.entries.map((entry) => entry.port_id),
    ids,
  );
  assert.equal(plan.bytes, 300 * 4096);
  assert.deepEqual(
    identityShards(plan.entries.map((entry) => entry.port_id))
      .flat()
      .toSorted(),
    ids,
  );
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

void test("a batch's provenance is bound to the facts table its run produced (F5)", () => {
  const facts = Buffer.from('{"entries":[]}\n');
  const patch = Buffer.from("From 0000 Mon Sep 17 00:00:00 2001\n");
  const record = (fields: Partial<ReturnType<typeof batchOutputs>> = {}) =>
    Buffer.from(
      JSON.stringify({
        ...batchOutputs({
          runId: provenance.workflow_run_id,
          dryRun: false,
          factsTable: facts,
          patch,
        }),
        ...fields,
      }),
    );
  assert.deepEqual(JSON.parse(record().toString()), {
    format: 1,
    run_id: provenance.workflow_run_id,
    dry_run: false,
    facts_table_sha256: createHash("sha256").update(facts).digest("hex"),
    batch_patch_sha256: createHash("sha256").update(patch).digest("hex"),
  });
  assert.deepEqual(outputsProblems(provenance, record(), facts), []);
  assert.deepEqual(outputsProblems(provenance, record(), facts, patch), []);
  // Another table, another patch, another run, or a dry run never back a batch.
  assert.match(
    outputsProblems(provenance, record(), Buffer.from("{}")).join(),
    /not the one the named run produced/u,
  );
  assert.match(
    outputsProblems(provenance, record(), facts, Buffer.from("x")).join(),
    /batch patch is not/u,
  );
  assert.match(outputsProblems(provenance, record({ run_id: "1" }), facts).join(), /another run/u);
  assert.match(
    outputsProblems(provenance, record({ dry_run: true }), facts).join(),
    /was a dry run/u,
  );
  assert.match(outputsProblems(provenance, undefined, facts).join(), /no outputs\.json/u);
  assert.match(outputsProblems(provenance, Buffer.from("{"), facts).join(), /not JSON/u);
  assert.match(
    outputsProblems(provenance, Buffer.from('{"format":2}'), facts).join(),
    /malformed/u,
  );
});

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
    bytes_pending: backlog * 100,
  },
  ineligible: {},
  unobserved: [],
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
  assert.deepEqual(assess([], { reproduction: "refused" }), ["reproduction-unsound"]);
  assert.deepEqual(assess([], { summary: undefined }), ["worker-error"]);
  // One run whose deadlines left work pending but settled nothing stops
  // (formerly three consecutive runs).
  assert.deepEqual(assess([record()], { summary: summary({ no_progress: true, settled: 0 }) }), [
    "no-progress",
  ]);
  // A deadline backlog larger than the previous run's (formerly four runs of growth).
  assert.deepEqual(assess([record({ backlog_total: 9 })], { summary: summary({}, 10) }), [
    "backlog-growing",
  ]);
  assert.deepEqual(assess([record({ backlog_total: 10 })], { summary: summary({}, 10) }), []);
  assert.deepEqual(assess([record({ backlog_total: 0 })], { summary: summary({}, 0) }), []);
  // Withdrawals no upstream fact explains are held, whatever their number
  // (formerly more than 16 withdrawals); upstream-caused ones of any number proceed.
  assert.deepEqual(
    assess([record()], {
      delta: { added: 0, withdrawn: 1, changed: 0 },
      held: [{ port_id: "zz-a", cause: "rule-version" }],
    }),
    ["withdrawal-held"],
  );
  assert.deepEqual(
    assess([record()], { delta: { added: 400, withdrawn: 300, changed: 200 }, held: [] }),
    [],
  );
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
  // Coverage drops when an identity the previous observer covered is
  // uncovered now (formerly a quarter fewer identities).
  assert.deepEqual(
    assess([record({ observed_ids: ["id-1", "zz-lost"] })], {
      summary: summary({ unobserved: ["zz-lost"] }),
    }),
    ["observer-coverage-dropped"],
  );
  assert.deepEqual(
    assess([record({ observed_ids: ["id-1"] })], {
      summary: summary({ unobserved: ["zz-new-listing"] }),
    }),
    [],
  );
  // A summary without the backlog fields is malformed, never 0 (A13).
  const { new_pending: _n, ...partial } = summary().backlog;
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
      ["reproduction-unsound"],
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
    const detail = reproductionDetails(file)["reproduction-unsound"]!;
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

void test("a withdrawal is held unless an upstream fact explains it (B1)", () => {
  const ids = ["zz-a", "zz-b", "zz-c", "zz-d"];
  const prior = ids.map((id) => fixture(id).entry);
  const factsOf = (entries: ListingFactsEntry[]): ListingFactsTable => ({
    ...emptyFactsTable("2026-11-20T00:00:00.000Z"),
    entries,
    entries_sha256: digestOf(entries),
  });
  const released = structuredClone(prior[0]!);
  released.observation.release_id = 9;
  const reconfirmed = structuredClone(prior[1]!);
  reconfirmed.observation.observed_at = "2026-11-21T00:00:00.000Z";
  const reparsed = structuredClone(prior[2]!);
  reparsed.parser_version += 1;
  const enrollments = (list: string[]) => ({ enrollments: list.map((port_id) => ({ port_id })) });
  assert.deepEqual(
    withdrawalCauses(
      enrollments(ids),
      enrollments([]),
      factsOf(prior),
      factsOf([released, reconfirmed, reparsed]),
    ),
    [
      { port_id: "zz-a", cause: "upstream" },
      { port_id: "zz-b", cause: "not-reobserved" },
      { port_id: "zz-c", cause: "rule-version" },
      { port_id: "zz-d", cause: "upstream" },
    ],
  );
  // Kept routes are not withdrawals.
  assert.deepEqual(
    withdrawalCauses(enrollments(ids), enrollments(ids), factsOf(prior), factsOf(prior)),
    [],
  );
  // An observer outage or an unreadable archive is no upstream statement:
  // held, never withdrawn unattended (J6). A verdict from a complete
  // observation, or a repository id that changed under the name, proceeds.
  const ineligibleAs = (entry: ListingFactsEntry, reason: string, cause: string | null = null) =>
    ({
      ...structuredClone(entry),
      ineligible: { reason, detail: "x", cause },
      observed_releases: [],
      other_packages: [],
      asset_names: [],
      refused_archives: [],
      artifacts: [],
    }) as ListingFactsEntry;
  assert.deepEqual(
    withdrawalCauses(
      enrollments(ids),
      enrollments([]),
      factsOf(prior),
      factsOf([
        ineligibleAs(prior[0]!, "observation-unavailable"),
        ineligibleAs(prior[1]!, "repeated-inspection-failure", "runner-time"),
        ineligibleAs(prior[2]!, "no-stable-release"),
        ineligibleAs(prior[3]!, "repository-identity-changed"),
      ]),
    ),
    [
      { port_id: "zz-a", cause: "observation-unavailable" },
      { port_id: "zz-b", cause: "inspection-failure" },
      { port_id: "zz-c", cause: "upstream" },
      { port_id: "zz-d", cause: "upstream" },
    ],
  );
  assert.deepEqual(
    withdrawalCauses(
      enrollments(["zz-a"]),
      enrollments([]),
      factsOf(prior),
      factsOf([ineligibleAs(prior[0]!, "invalid-facts")]),
    ),
    [{ port_id: "zz-a", cause: "inspection-failure" }],
  );
});

void test("a batch waiting for its checks for days, and a failed gate job, file a stop issue (F8, F10)", () => {
  const waiting = (prState: string, prCreatedAt: string) =>
    collectConditions(
      { conditions: [], freshness: null },
      {
        prState,
        prNumber: "12",
        prCreatedAt,
        now: "2026-11-23T00:00:00.000Z",
        jobs: {},
      },
    ).conditions;
  // Derived from the facts age: a reconfirmation proposed at refreshAfterDays
  // must merge within the rest of the 30 days (formerly 3 days).
  assert.equal(batchWaitDays, 30 - refreshAfterDays);
  for (const state of ["waiting-for-checks", "pending"]) {
    assert.deepEqual(waiting(state, "2026-11-09T00:00:00.000Z"), [], state);
    const [condition, ...rest] = waiting(state, "2026-11-07T00:00:00.000Z");
    assert.deepEqual(rest, []);
    assert.equal(condition!.name, "batch-waiting");
    assert.match(condition!.detail, /#12 has waited 16 days .*look at its CI runs/u);
    assert.doesNotMatch(condition!.detail, /Approve workflows|reopen/u);
  }
  // A green, failed or absent batch, or an unknown opening time, never waits.
  for (const state of ["green", "failed", "none"])
    assert.ok(
      !waiting(state, "2026-11-01T00:00:00.000Z").some((item) => item.name === "batch-waiting"),
      state,
    );
  assert.deepEqual(waiting("pending", "none"), []);
  // One issue per condition: the waiting stop has its own reused title.
  assert.ok(stopConditionNames.includes("batch-waiting"));
  // A failed gate job is a worker error, filed like every other job's.
  assert.deepEqual(
    collectConditions(
      { conditions: [], freshness: null },
      { prState: "none", prNumber: "none", jobs: { gate: "failure", derive: "skipped" } },
    ).conditions,
    [{ name: "worker-error", detail: "The gate job ended failure." }],
  );
});

void test("the guarded merge binds to the head's own successful CI run (F10)", () => {
  const head = "a".repeat(40);
  const run = (fields: Record<string, unknown> = {}) => ({
    id: 10,
    run_attempt: 1,
    head_sha: head,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    ...fields,
  });
  assert.deepEqual(ciRunFor([run()], head), { id: 10, attempt: 1 });
  // The newest run, then the newest attempt, decides.
  assert.deepEqual(
    ciRunFor([run(), run({ id: 12 }), run({ id: 12, run_attempt: 2 }), run({ id: 11 })], head),
    { id: 12, attempt: 2 },
  );
  for (const fields of [
    { head_sha: "b".repeat(40) },
    { path: ".github/workflows/other.yml" },
    { event: "push" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { run_attempt: 0 },
    { id: "10" },
  ])
    assert.equal(ciRunFor([run(fields)], head), undefined, JSON.stringify(fields));
  assert.equal(ciRunFor(["not a run", null], head), undefined);
});

void test("the freshness watchdog compares the facts' own time with the real clock", () => {
  const { entry } = fixture();
  const table = { ...emptyFactsTable("2026-11-01T00:00:00.000Z"), entries: [entry] };
  // A quiet catalog proposes its reconfirmation batch at refreshAfterDays:
  // the alert fires once facts are older than that, never before (N1).
  assert.equal(freshnessAlertDays, refreshAfterDays);
  assert.ok(freshnessAlertDays < 30);
  const quiet = { ...table, generated_at: "2026-11-20T00:00:00.000Z" };
  assert.equal(factsFallingBehind(quiet, "2026-12-05T00:00:00.000Z"), undefined);
  assert.match(factsFallingBehind(quiet, "2026-12-06T00:00:00.000Z")!, /16 days ago/u);
  // An empty table alerts too once it is old, so a first batch that never
  // lands is visible (F8); a fresh empty table does not.
  assert.match(
    factsFallingBehind(emptyFactsTable("2026-01-01T00:00:00.000Z"), "2026-11-09T00:00:00.000Z")!,
    /No facts batch has landed since the empty facts table was written 312 days ago/u,
  );
  assert.equal(
    factsFallingBehind(emptyFactsTable("2026-11-01T00:00:00.000Z"), "2026-11-09T00:00:00.000Z"),
    undefined,
  );
  // A time ahead of the clock is an alert, never a negative age (F3).
  assert.match(
    factsFallingBehind(table, "2026-10-31T23:00:00.000Z")!,
    /ahead of the clock .*generated_at 2026-11-01/u,
  );
  // Exactly at the clock it is not: no skew is allowed (formerly 10 minutes).
  assert.equal(
    factsFallingBehind({ ...table, entries: [] }, "2026-11-01T00:00:00.000Z"),
    undefined,
  );
  const observedAhead = structuredClone(table);
  observedAhead.generated_at = "2026-11-20T00:00:00.000Z";
  observedAhead.entries[0]!.observation.observed_at = "2026-12-01T00:00:00.000Z";
  assert.match(
    factsFallingBehind(observedAhead, "2026-11-21T00:00:00.000Z")!,
    new RegExp(`${unseen} observed_at 2026-12-01`, "u"),
  );
});

void test("a facts change may not record times ahead of the clock (F3)", () => {
  const { entry } = fixture();
  const now = Date.parse("2026-11-21T00:00:00.000Z");
  const table = { ...emptyFactsTable("2026-11-21T00:00:00.000Z"), entries: [entry] };
  // Times at the clock, and an unchanged table, pass: no skew is allowed.
  assert.equal(clockSkewMs, 0);
  assert.deepEqual(clockProblems(null, table, now), []);
  assert.deepEqual(clockProblems(table, table, now + 365 * 86_400_000 * -1), []);
  const ahead = { ...table, generated_at: "2026-11-21T00:00:01.000Z" };
  assert.match(clockProblems(null, ahead, now).join(), /generated_at .* ahead of the clock/u);
  const observed = structuredClone(table);
  observed.entries[0]!.observation.observed_at = "2026-11-21T00:00:01.000Z";
  assert.match(clockProblems(null, observed, now).join(), /observed_at .* ahead of the clock/u);
  // An unchanged observed_at is not judged again; an unparseable time is ahead.
  const baseline = structuredClone(observed);
  baseline.generated_at = "2026-11-20T00:00:00.000Z";
  assert.deepEqual(clockProblems(baseline, observed, now), []);
  assert.equal(clockProblems(null, { ...table, generated_at: "soon" }, now).length, 1);
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
    author: "portcove-facts-batch[bot]",
    author_type: "Bot",
    base_ref: "main",
    commits: 1,
    draft: false,
  };
  assert.deepEqual(batchPullProblems(pull), []);
  for (const changed of [
    { head_ref: "feature/x" },
    { author: "someone", author_type: "User" },
    { author_type: "User" },
    // The built-in token no longer delivers: another workflow cannot pose as the job.
    { author: workflowLogin },
    { base_ref: "release" },
    { commits: 2 },
    { draft: true },
  ])
    assert.equal(batchPullProblems({ ...pull, ...changed }).length, 1, JSON.stringify(changed));
});

void test("another App's batch-shaped pull request is the named foreign-batch-author stop (F3)", () => {
  assert.equal(expectedBatchAuthor(undefined), undefined);
  assert.equal(expectedBatchAuthor(""), undefined);
  assert.equal(expectedBatchAuthor("bad slug[bot]"), undefined);
  assert.equal(expectedBatchAuthor("portcove-facts-batch"), "portcove-facts-batch[bot]");
  // Unknown slug: any App's bot is evaluated; `merge` binds it to the minted App.
  assert.ok(isExpectedBatchAuthor("other-app[bot]", undefined));
  assert.ok(isExpectedBatchAuthor("Portcove-Facts-Batch[bot]", "portcove-facts-batch"));
  assert.ok(!isExpectedBatchAuthor("other-app[bot]", "portcove-facts-batch"));
  assert.ok(stopConditionNames.includes("foreign-batch-author"));
  const { conditions } = collectConditions(
    { conditions: [], freshness: null },
    {
      prState: "foreign",
      prNumber: "7",
      foreignAuthor: "other-app[bot]",
      jobs: { merge: "success", gate: "success" },
    },
  );
  assert.deepEqual(
    conditions.map((condition) => condition.name),
    ["foreign-batch-author"],
  );
  assert.match(conditions[0]!.detail, /#7 was opened by other-app\[bot\]/u);
  // A stop issue already open files nothing more.
  assert.deepEqual(
    collectConditions(
      { conditions: [], freshness: null },
      { blocked: true, prState: "foreign", prNumber: "7", foreignAuthor: "x[bot]", jobs: {} },
    ).conditions,
    [],
  );
  // Without the slug, the keyless gate never calls a batch green: it is the
  // named batch-app-slug-unset stop, so `merge` never sees that batch.
  assert.ok(stopConditionNames.includes("batch-app-slug-unset"));
  const unbound = collectConditions(
    { conditions: [], freshness: null },
    { prState: "unbound", prNumber: "9", jobs: { merge: "skipped" } },
  ).conditions;
  assert.deepEqual(
    unbound.map((condition) => condition.name),
    ["batch-app-slug-unset"],
  );
  assert.match(unbound[0]!.detail, /#9 .*PORTCOVE_FACTS_BATCH_APP_SLUG/u);
  const source = readFileSync(join(root, "scripts/listing-facts-batch.mts"), "utf8");
  assert.match(
    source,
    /if \(state\.state === "green" && expectedBatchAuthor\(appSlug\) === undefined\)\n\s*state = \{ state: "unbound" \};/u,
  );
  // The workflow wires both detections to `notify`, and the merge job never
  // merges or deletes for a foreign author.
  const text = readFileSync(join(root, batchWorkflowPath), "utf8");
  const workflow = parse(text) as {
    jobs: Record<
      string,
      {
        outputs?: Record<string, string>;
        steps: { id?: string; if?: string; run?: string; env?: Record<string, string> }[];
      }
    >;
  };
  const gatePull = workflow.jobs.gate!.steps.find((step) => step.id === "pull")!;
  assert.equal(
    gatePull.env!.PORTCOVE_FACTS_BATCH_APP_SLUG,
    "${{ vars.PORTCOVE_FACTS_BATCH_APP_SLUG }}",
  );
  assert.equal(workflow.jobs.merge!.outputs!.foreign_author, "${{ steps.author.outputs.foreign }}");
  for (const step of workflow.jobs.merge!.steps.filter((item) =>
    /pr-delivery\.mts"? merge|:refs\/heads\/\$\{BRANCH\}/u.test(item.run ?? ""),
  ))
    assert.equal(step.if, "steps.author.outputs.foreign == ''");
  const notify = workflow.jobs.notify!.steps.find((step) => /collect/u.test(step.run ?? ""))!;
  assert.match(notify.env!.FOREIGN_AUTHOR!, /needs\.merge\.outputs\.foreign_author/u);
  assert.match(notify.env!.FOREIGN_AUTHOR!, /needs\.gate\.outputs\.pr_state == 'foreign'/u);
  assert.match(notify.run!, /--foreign-author "\$\{FOREIGN_AUTHOR:-\}"/u);
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
  // The App opened it: its checks start without a person (#1422 owner decision).
  assert.match(body, /opened by the job's GitHub App/u);
  assert.doesNotMatch(body, /Approve workflows|approval-required/u);
  assert.match(body, /no person needs to approve, close or reopen it/u);
});

void test("only the job's own batch pull requests count; a fork or a person cannot hold the job (D6)", () => {
  const pull = (fields: Record<string, unknown> = {}, head: Record<string, unknown> = {}) => ({
    number: 1,
    user: { login: "portcove-facts-batch[bot]", type: "Bot" },
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
    pull({ user: { login: "someone", type: "User" } }),
    pull({ user: { login: "someone[bot]", type: "User" } }),
    pull({ user: { login: workflowLogin, type: "Bot" } }),
    pull({ user: { login: "portcove-facts-batch[bot]" } }),
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
      inspection_failures: { "runner-time": ["l"] },
      shared_repositories: { "o/shared": ["h", "i", "j"] },
      enrolled_beside_unoffered_forms: ["k"],
    },
  });
  assert.deepEqual(counts, {
    reasons: { "no-observation": 3, "ambiguous-player": 1 },
    unread_forms: { ".7z": 2, ".exe": 1 },
    exclusions: { "asset-tool-name:patcher": 1 },
    refusals: { "core-source-invalid": 2 },
    inspection_failures: { "runner-time": 1 },
    shared_repositories: { "o/shared": 3 },
    enrolled_beside_unoffered_forms: 1,
  });
  assert.match(markdown, /platform without an archive \(review: 1\)\n\n- `k`/u);
  assert.match(markdown, /more than one identity \(1; 3 identities/u);
  assert.match(markdown, /\| `no-observation` \| 3 \|/u);
  assert.match(markdown, /\| `core-source-invalid` \| 2 \|/u);
  assert.match(markdown, /Top unread package forms/u);
  // A runner-time ineligibility says when it is reconsidered (J-F4).
  assert.match(markdown, /\| `runner-time` \| 1 \|/u);
  assert.match(markdown, /stays ineligible until its entry changes/u);
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
        environment?: string;
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
    const gated =
      job.if.includes(enabled) ||
      ["prepare", "inspect", "combine", "reproduce", "decide"].includes(name);
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
    // A job holding the App's key writes with it, whatever its built-in token may do.
    if (writes.length || job.environment !== undefined) {
      // A writing job runs only when enabled and never on a dry run.
      assert.ok(job.if.includes(enabled), `${name} writes without the variable`);
      assert.ok(job.if.includes(`!(${dryRun})`), `${name} writes on a dry run`);
    }
  }
  // The gate job admits a dry-run dispatch only, and the derivation needs the gate.
  assert.ok(workflow.jobs.gate!.if!.includes(`(${dryRun})`));
  assert.ok(workflow.jobs.prepare!.if!.includes("needs.gate.outputs.blocked == 'false'"));
  assert.ok(workflow.jobs.prepare!.if!.includes("needs.gate.outputs.pr_state == 'none'"));
  for (const name of ["prepare", "inspect", "combine", "reproduce", "decide"])
    assert.ok(
      Object.values(workflow.jobs[name]!.permissions!).every((access) => access === "read"),
      `${name} only reads`,
    );
  // The derivation is sharded by a matrix from the plan, with no size bound
  // (B2, B3): each shard is bounded only by the hosted job's 6-hour limit.
  const matrixOf = (name: string) =>
    (workflow.jobs[name] as unknown as { strategy: { matrix: { shard: string } } }).strategy.matrix
      .shard;
  assert.equal(matrixOf("inspect"), "${{ fromJSON(needs.prepare.outputs.shards) }}");
  assert.equal(matrixOf("reproduce"), "${{ fromJSON(needs.combine.outputs.shards) }}");
  assert.equal(workflow.jobs.inspect!["timeout-minutes"], 360);
  // The job's reproduction has CI's shard deadline (J3): the sum of its
  // steps, whose reproduction step outlasts `reproductionDeadlineMinutes`.
  assert.equal(workflow.jobs.reproduce!["timeout-minutes"], 125);
  // A missing shard is never merged around.
  assert.match(workflow.jobs.combine!.if!, /needs\.inspect\.result == 'success'/u);
  assert.doesNotMatch(text, /maxIdentities|maxBytes|cadence-hours|reproductionBudget/u);
  // A dry run never saves the worker state.
  const save = workflow.jobs.decide!.steps.find((step) =>
    String(step.uses).startsWith("actions/cache/save"),
  );
  assert.match(String((save as { if?: string }).if), /env\.DRY_RUN != 'true'/u);
  // The merge reads commit statuses for the guarded route (U2) and checks
  // the batch composed onto the current main (D3).
  assert.equal(workflow.jobs.merge!.permissions!.statuses, "read");
  assert.match(text, /--target "\$TARGET" --tree "\$TREE"/u);
  // The freshness alert is evaluated on every enabled run, also while stopped.
  assert.doesNotMatch(workflow.jobs.notify!.if!, /blocked/u);
  // The only secret is the App's key, in its mint steps (see the App token test).
  assert.equal(text.match(/secrets\./gu)?.length, 2);
  // No expression is interpolated into a shell script: every value reaches
  // `run:` through `env:` as a shell variable (F6).
  for (const [name, job] of Object.entries(workflow.jobs))
    for (const step of job.steps)
      assert.doesNotMatch(
        step.run ?? "",
        /\$\{\{/u,
        `${name}: ${step.run?.slice(0, 60)} interpolates an expression`,
      );
  // The worker state is saved only after the batch pull request opened (F9);
  // derive saves it only for a run that proposes nothing.
  const deliverSteps = workflow.jobs.deliver!.steps;
  const opened = deliverSteps.findIndex((step) => /open-pull-request/u.test(step.run ?? ""));
  const saved = deliverSteps.findIndex((step) =>
    String(step.uses).startsWith("actions/cache/save"),
  );
  assert.ok(
    opened >= 0 && saved > opened,
    "deliver saves the state after opening the pull request",
  );
  assert.match(String((save as { if?: string }).if), /steps\.ready\.outputs\.ready != 'true'/u);
  // The delivered patch is the one this run recorded, and the outputs
  // record is retained for the pull-request check (F5).
  assert.match(text, /outputs-check --revision "\$commit" \\\n\s*--record/u);
  assert.match(text, /name: listing-facts-batch-outputs-\$\{\{ github\.run_id \}\}/u);
  // The merge binds to the head's CI run (F10) and cleans up its branch.
  assert.match(text, /--run "\$CI_RUN" --attempt "\$CI_ATTEMPT"/u);
  assert.equal(workflow.jobs.gate!.permissions!.actions, "read");
  assert.match(text, /":refs\/heads\/\$\{BRANCH\}"/u);
  // A failed gate job still reaches the stop assessment (F10).
  assert.match(workflow.jobs.notify!.if!, /needs\.gate\.result != 'skipped'/u);
  // Merges go through the guarded route only, never an API shortcut.
  assert.match(text, /scripts\/pr-delivery\.mts"? merge[^\n]*\n[^\n]*--verify-local-composition/u);
  assert.doesNotMatch(text, /pulls\/[^\s]*\/merge|gh pr merge|enable_pr_auto_merge|--admin/u);
});

void test("only deliver and merge mint the App token, in the facts-batch environment (#1422)", () => {
  const text = readFileSync(join(root, batchWorkflowPath), "utf8");
  type Step = {
    id?: string;
    name?: string;
    run?: string;
    uses?: string;
    if?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
    "timeout-minutes"?: number;
  };
  type Job = {
    if?: string;
    environment?: unknown;
    needs?: string | string[];
    permissions?: Record<string, string>;
    strategy?: unknown;
    "timeout-minutes"?: number;
    steps: Step[];
  };
  const workflow = parse(text) as { on: Record<string, unknown>; jobs: Record<string, Job> };
  // Triggers unchanged: the schedule and a manual dispatch only.
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  const mint = "actions/create-github-app-token@";
  const pinned = /^actions\/create-github-app-token@[0-9a-f]{40}$/u;
  const appJobs = ["deliver", "merge"];
  const enabled = "vars.PORTCOVE_FACTS_BATCH_ENABLED == 'true'";
  const dryRun = "github.event_name == 'workflow_dispatch' && inputs.dry_run";
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const serialized = JSON.stringify(job);
    const mints = job.steps.filter((step) => step.uses?.startsWith(mint));
    if (appJobs.includes(name)) {
      assert.equal(job.environment, "facts-batch", name);
      // A dry run never reaches the mint step: the job itself is skipped.
      assert.ok(job.if?.includes(enabled), `${name} runs without the variable`);
      assert.ok(job.if?.includes(`!(${dryRun})`), `${name} runs on a dry run`);
      assert.equal(mints.length, 1, `${name} mints exactly one token`);
      const [step] = mints;
      assert.match(step!.uses!, pinned, `${name}: the mint action is pinned by commit SHA`);
      assert.match(
        text,
        new RegExp(`${step!.uses!.replace(/[.]/gu, "\\.")} # v\\d+\\.\\d+\\.\\d+`, "u"),
      );
      // The narrowest token: this repository, Contents and Pull requests only.
      // No `owner`/`repositories` input, so the pinned action scopes the
      // token to `GITHUB_REPOSITORY` on every trigger. A `schedule` event has
      // no `github.event.repository`: an input derived from it would be
      // empty and widen the token to every repository of the installation.
      assert.deepEqual(step!.with, {
        "app-id": "${{ vars.FACTS_BATCH_APP_ID }}",
        "private-key": "${{ secrets.FACTS_BATCH_APP_PRIVATE_KEY }}",
        "permission-contents": "write",
        "permission-pull-requests": "write",
      });
      assert.doesNotMatch(JSON.stringify(step!.with), /github\.event|owner|repositories/u, name);
      assert.equal(step!.id, "app");
      // The built-in token of an App job writes nothing.
      assert.ok(
        Object.values(job.permissions ?? {}).every((access) => access === "read"),
        `${name}: the built-in token only reads`,
      );
      // The key reaches the mint step alone; the token only the steps that write.
      for (const other of job.steps.filter((candidate) => candidate !== step)) {
        assert.doesNotMatch(JSON.stringify(other), /secrets\.|FACTS_BATCH_APP/u, name);
        if (JSON.stringify(other).includes("steps.app.outputs.token"))
          assert.match(
            JSON.stringify(other.env ?? {}),
            /steps\.app\.outputs\.token/u,
            `${name}: the token reaches a step through env only`,
          );
      }
      // Every check that needs no credential runs before the token exists.
      const minted = job.steps.indexOf(step!);
      const firstUse = job.steps.findIndex((candidate) =>
        JSON.stringify(candidate).includes("steps.app.outputs"),
      );
      assert.ok(firstUse > minted, `${name} uses the token after minting it`);
      // Pushes carry a step-scoped credential, never a persisted one or a URL token.
      for (const candidate of job.steps.filter((item) => /git push/u.test(item.run ?? ""))) {
        assert.match(
          candidate.run!,
          /GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader/u,
        );
        assert.doesNotMatch(
          candidate.run!,
          /x-access-token:\$\{?[A-Z_]+\}?@|git config|credential\.helper/u,
        );
        assert.equal(candidate.env?.APP_TOKEN, "${{ steps.app.outputs.token }}", name);
      }
    } else {
      // Every other job, above all those that run Core over downloaded bytes
      // and every matrix shard, never sees the key, the App id or its token.
      assert.equal(job.environment, undefined, `${name} declares an environment`);
      assert.equal(mints.length, 0, `${name} mints a token`);
      assert.doesNotMatch(
        serialized,
        /FACTS_BATCH_APP_ID|FACTS_BATCH_APP_PRIVATE_KEY|steps\.app\.outputs|secrets\.|PORTCOVE_MERGE_TOKEN/u,
        `${name} references the App`,
      );
    }
    // Every checkout keeps no credential; no expression is interpolated into a script.
    for (const step of job.steps) {
      if (step.uses?.startsWith("actions/checkout@"))
        assert.equal(
          (step.with as Record<string, unknown> | undefined)?.["persist-credentials"],
          false,
          name,
        );
      assert.doesNotMatch(step.run ?? "", /\$\{\{/u, `${name}: ${step.name}`);
    }
  }
  // `gate` and `notify` stay on the built-in token; notify files the issues.
  assert.equal(workflow.jobs.notify!.permissions!.issues, "write");
  for (const name of ["gate", "notify"])
    assert.match(JSON.stringify(workflow.jobs[name]), /github\.token/u, name);
  // The App token is never written out: not to an artifact, a cache, or the log.
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps.filter(
      (item) =>
        item.uses?.startsWith("actions/upload-artifact@") ||
        item.uses?.startsWith("actions/cache/save@"),
    ))
      assert.doesNotMatch(JSON.stringify(step), /steps\.app|TOKEN/u);
  assert.doesNotMatch(text, /echo[^\n]*\$\{?(?:APP_TOKEN|PORTCOVE_MERGE_TOKEN|GITHUB_TOKEN)\b/u);
  // The merge job reads its evidence with the built-in token and merges with
  // the App token, only after binding the batch to the App's own login.
  const merge = workflow.jobs.merge!;
  const guarded = merge.steps.find((step) => /pr-delivery\.mts"? merge/u.test(step.run ?? ""))!;
  assert.equal(guarded.env!.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(guarded.env!.PORTCOVE_MERGE_TOKEN, "${{ steps.app.outputs.token }}");
  assert.match(guarded.run!, /--run "\$CI_RUN" --attempt "\$CI_ATTEMPT"/u);
  const bound = merge.steps.findIndex((step) => /\$\{APP_SLUG\}\[bot\]/u.test(step.run ?? ""));
  assert.ok(
    bound >= 0 && bound < merge.steps.indexOf(guarded),
    "the author binding precedes the merge",
  );
  // The App token opens the pull request; the state is saved only after.
  const deliver = workflow.jobs.deliver!;
  const opened = deliver.steps.find((step) => /open-pull-request/u.test(step.run ?? ""))!;
  assert.equal(opened.env!.GITHUB_TOKEN, "${{ steps.app.outputs.token }}");
  // No documentation or code path asks a person to approve, close or reopen a batch.
  assert.doesNotMatch(text, /Approve workflows|approval-required|close and reopen/iu);
});

void test("deliver and merge never execute batch or artifact content; the mint comes last (F1)", () => {
  const text = readFileSync(join(root, batchWorkflowPath), "utf8");
  type Step = { id?: string; name?: string; run?: string; uses?: string; with?: unknown };
  const workflow = parse(text) as { jobs: Record<string, { steps: Step[] }> };
  const mint = "actions/create-github-app-token@";
  // A script of the untouched main checkout, the only code these jobs run.
  const trusted = /^"\$GITHUB_WORKSPACE\/scripts\/[a-z0-9-]+\.mts"$/u;
  // Comments are prose, not commands; a continued line is one command.
  const code = (step: Step) =>
    (step.run ?? "")
      .split("\n")
      .filter((line) => !/^\s*#/u.test(line))
      .join("\n")
      .replace(/\\\n\s*/gu, " ");
  for (const name of ["deliver", "merge"]) {
    const steps = workflow.jobs[name]!.steps;
    // The first step that brings batch or artifact content into the job.
    const untrusted = steps.findIndex(
      (step) =>
        step.uses?.startsWith("actions/download-artifact@") ||
        /refs\/pull\/|\bam\b/u.test(code(step)),
    );
    assert.ok(untrusted > 0, name);
    // Dependencies are installed from main's lockfile, before any batch content.
    const install = steps.findIndex((step) => /pnpm install --frozen-lockfile/u.test(code(step)));
    assert.ok(install >= 0 && install < untrusted, `${name} installs before batch content`);
    for (const step of steps.slice(untrusted)) {
      const body = code(step);
      const label = `${name}: ${step.name ?? step.uses}`;
      // No local action, package manager, shell script or relative program.
      assert.ok(!step.uses?.startsWith("./"), label);
      assert.doesNotMatch(
        body,
        /\b(?:pnpm|npm|npx|yarn|corepack|cargo|make|source)\b|(?:^|[\s;&|(])(?:bash|sh|\.)\s+\S|(?:^|[\s;&|(])\.\//u,
        label,
      );
      assert.doesNotMatch(
        body,
        /\bcd "\$RUNNER_TEMP\/batch"|\$RUNNER_TEMP\/(?:batch|head)\/\S*\.(?:m?[jt]s|sh)\b/u,
      );
      for (const match of body.matchAll(/(?:^|[\s;&|(=])node\s+(\S+)/gu)) {
        const script = match[1]!;
        if (trusted.test(script)) continue;
        // The one exception: catalog generation in a checkout of main's tip
        // that received only the allowlisted data files of the composition,
        // proven equal to it before anything runs there.
        assert.equal(name, "merge", `${label} runs ${script}`);
        assert.equal(script, '"$RUNNER_TEMP/main/scripts/generate-catalog.mts"', label);
        const checked = body.indexOf(
          `test "$(git -C "$RUNNER_TEMP/main" rev-parse 'HEAD^{tree}')" = "$tree"`,
        );
        assert.ok(checked >= 0 && checked < match.index, `${label}: data-only composition first`);
        assert.match(
          body,
          /isolated_git worktree add --quiet --detach "\$RUNNER_TEMP\/main" "\$target"/u,
        );
        assert.match(
          body,
          /git cat-file blob "\$\{tree\}:\$\{file\}" > "\$RUNNER_TEMP\/main\/\$\{file\}"/u,
        );
        assert.doesNotMatch(body, /git (?:-C \S+ )?(?:merge|checkout|switch|am)(?![\w-])/u, label);
      }
      // Git that writes batch files runs without ambient configuration,
      // hooks, attribute files or fsmonitor.
      if (/isolated_git/u.test(body))
        for (const setting of [
          "GIT_CONFIG_NOSYSTEM=1",
          "GIT_CONFIG_GLOBAL=/dev/null",
          "GIT_ATTR_NOSYSTEM=1",
          "-c core.hooksPath=/dev/null",
          "-c core.attributesFile=/dev/null",
          "-c core.fsmonitor=false",
        ])
          assert.ok(body.includes(setting), `${label}: ${setting}`);
      for (const line of body.split("\n").filter((item) => /\bam\b/u.test(item)))
        assert.match(line, /^\s*isolated_git -C "\$RUNNER_TEMP\/batch"/u, label);
      for (const line of body.split("\n").filter((item) => /\bworktree add\b/u.test(item)))
        assert.match(line, /isolated_git worktree add|--no-checkout/u, label);
      for (const line of body.split("\n").filter((item) => /\bgit\b[^\n]*\bpush\b/u.test(item)))
        assert.match(line, /-c core\.hooksPath=\/dev\/null push --quiet --no-verify/u, label);
    }
    // The workspace itself is never patched or merged: batch content goes
    // to a separate worktree or stays Git objects.
    assert.doesNotMatch(
      steps.map(code).join("\n"),
      /^\s*git (?:-c \S+ \\?\s*)*(?:am|merge|checkout|switch|apply)(?![\w-])/mu,
      name,
    );
    // The mint is the last step before the steps that use its outputs, and
    // nothing that reads batch content runs after it except the push of the
    // already-checked commit.
    const minted = steps.findIndex((step) => step.uses?.startsWith(mint));
    const users = steps.flatMap((step, index) =>
      JSON.stringify(step).includes("steps.app.outputs") ? [index] : [],
    );
    assert.equal(users[0], minted + 1, `${name}: the mint immediately precedes its first use`);
    assert.deepEqual(
      users,
      Array.from({ length: users.length }, (_, index) => minted + 1 + index),
      `${name}: every step between the mint and the last token use needs it`,
    );
    for (const step of steps.slice(minted + 1))
      assert.doesNotMatch(
        code(step),
        /\bam\b|worktree add|merge-tree|outputs-check|\bpaths --base|generate-catalog/u,
        `${name}: ${step.name ?? step.uses} reads batch content after the mint`,
      );
    // Every check runs before the mint.
    const checks = steps.flatMap((step, index) =>
      /outputs-check|\bpaths --base|generate-catalog|merge-intent/u.test(code(step)) ? [index] : [],
    );
    assert.ok(checks.length && checks.every((index) => index < minted), name);
    // Downloads are data only: none is a program, and none lands in the checkout's code.
    for (const step of steps.filter((item) => item.uses?.startsWith("actions/download-artifact@")))
      assert.match(
        String((step.with as { path?: string }).path),
        /^work\/listing-facts-batch(?:\/outputs)?$/u,
      );
  }
  assert.equal(
    workflow.jobs.merge!.steps.some((step) => step.uses?.startsWith("actions/download-artifact@")),
    false,
    "merge downloads no artifact",
  );
  // deliver pushes the checked commit by id from the untouched checkout.
  assert.match(text, /"\$\{COMMIT\}:refs\/heads\/\$\{branch\}"/u);
  assert.match(text, /open-pull-request --revision "\$COMMIT"/u);
});

// ---------------------------------------------------------------------------
// Part J: what an untrusted change can make CI do, quota and runner limits.

const authored = (id: string): AuthoredPort => ({
  format_version: 1,
  listing: {
    id,
    name: "Fixture Game",
    summary: "A listing-only fixture.",
    project_url: `https://github.com/fixture-owner/${id}`,
    availability: "packages",
    platforms: ["windows-x86-64"],
  },
});

void test("a change naming an entry outside the authored catalog is refused before any call (J1)", async () => {
  const { release, entry, players } = fixture();
  const records = [authored(unseen)];
  assert.deepEqual(reproductionScopeProblems([entry], records, null), []);
  // A fabricated identity, a foreign repository and a re-bound id are refused.
  const fabricated = { ...structuredClone(entry), port_id: "zz-fabricated" };
  const foreign = { ...structuredClone(entry), repository: "huge-owner/huge-repository" };
  const rebound = { ...structuredClone(entry), repository_id: 99 };
  const baseline = { entries: [entry] };
  assert.match(
    reproductionScopeProblems([fabricated], records, null).join(" "),
    /not an authored listing-only/u,
  );
  assert.match(
    reproductionScopeProblems([foreign], records, null).join(" "),
    /huge-owner\/huge-repository, but its listing names/u,
  );
  assert.match(
    reproductionScopeProblems([rebound], records, baseline).join(" "),
    /repository id 99, but it was bound to 4242/u,
  );
  // A new identity has no prior binding: its id is checked by reproduction.
  assert.deepEqual(reproductionScopeProblems([rebound], records, null), []);
  // Reproduction itself refuses the whole call with zero provider calls and
  // zero downloads when any entry is out of scope.
  let calls = 0;
  const log: string[] = [];
  const result = await reproduceFacts({
    entries: [entry, fabricated],
    listReleases: async (id) => {
      calls++;
      return await lister(release)(id);
    },
    inspect: inspector(players, log),
    classify: coreClassifier,
    boundLines: unbound([entry]),
  });
  assert.equal(calls, 0);
  assert.deepEqual(log, []);
  assert.deepEqual(
    result.refused.map((refusal) => refusal.reason),
    ["out-of-scope", "out-of-scope"],
  );
  assert.equal(result.bytes, 0);
});

void test("authored sources and their facts are separate changes; scope comes from the base (J-J1)", async () => {
  const { release, entry, players } = fixture();
  const factsTable = "crates/portcove-core/catalog/listing-package-facts.generated.json";
  const listingFile = `crates/portcove-core/catalog/ports/${unseen}.json`;
  // The head adds an authored listing and its facts entry together: refused
  // before any call, whatever the listing says.
  assert.match(
    authoredSourceProblem(
      [factsTable, listingFile, "crates/portcove-core/catalog/catalog.json"],
      1,
    )!,
    new RegExp(
      `1 reproducible listing facts entries together with authored catalog sources \\(${listingFile.replace(/[.]/gu, "\\.")}\\)`,
      "u",
    ),
  );
  assert.ok(
    authoredSourceProblem(["crates/portcove-core/catalog/catalog-shared.json", factsTable], 3),
  );
  // Facts alone, or only the generated outputs beside them, may reproduce.
  assert.equal(authoredSourceProblem([factsTable], 1), undefined);
  assert.equal(authoredSourceProblem([...batchAllowlist], 4), undefined);
  // Authored changes with no reproducible entry are ordinary changes.
  assert.equal(authoredSourceProblem([listingFile, factsTable], 0), undefined);
  // The scope comes from the base: a listing only the head adds is out of
  // scope, so reproduction makes zero provider calls and zero downloads.
  const base: AuthoredPort[] = [];
  assert.match(
    reproductionScopeProblems([entry], base, null).join(" "),
    /not an authored listing-only/u,
  );
  let calls = 0;
  const log: string[] = [];
  const counted = async (id: number) => {
    calls++;
    return await lister(release)(id);
  };
  const headOnly = await reproduceFacts({
    entries: [entry],
    listReleases: counted,
    inspect: inspector(players, log),
    classify: coreClassifier,
    boundLines: boundLinesOf(base),
  });
  assert.equal(calls, 0);
  assert.deepEqual(log, []);
  assert.deepEqual(
    headOnly.refused.map((refusal) => refusal.reason),
    ["out-of-scope"],
  );
  // A facts entry for an identity the base already authors is reproduced.
  const authoredBase = [authored(unseen)];
  assert.deepEqual(reproductionScopeProblems([entry], authoredBase, null), []);
  const reproduced = await reproduceFacts({
    entries: [entry],
    listReleases: counted,
    inspect: inspector(players, log),
    classify: coreClassifier,
    boundLines: boundLinesOf(authoredBase),
  });
  assert.deepEqual(reproduced.verified, [unseen]);
  assert.equal(calls, 1);
  // Every reproduction shard stops when a newer head superseded its run.
  const ci = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { steps: { uses?: string; with?: Record<string, string> }[] }>;
  };
  const steps = ci.jobs.listing_facts_reproduction!.steps;
  const stop = steps.findIndex((step) => step.uses === "./.github/actions/stop-if-superseded");
  assert.ok(stop > 0 && stop < steps.findIndex((step) => step.uses?.startsWith("pnpm/")));
  assert.equal(steps[stop]!.with!["head-sha"], "${{ github.event.pull_request.head.sha }}");
});

void test("byte-identical archives are not re-read; a changed one, or another parser, is (J-B2)", async () => {
  const { release, entry, players } = fixture();
  // The baseline entry was reproduced when it landed. A change that touches
  // only the release-line facts keeps the archive record byte-identical.
  const baseline = structuredClone(entry);
  baseline.observed_releases = [];
  assert.deepEqual([...reusedArchives(baseline, entry)], [21]);
  const plan = reproductionPlan(
    { entries: [baseline] },
    { ...emptyFactsTable(), entries: [entry] },
  );
  assert.deepEqual(
    plan.entries.map((item) => item.port_id),
    [unseen],
  );
  assert.equal(plan.bytes, 0);
  assert.deepEqual([...plan.reused.get(unseen)!], [21]);
  const log: string[] = [];
  const result = await reproduceFacts({
    entries: [entry],
    listReleases: lister(release),
    inspect: inspector(players, log),
    classify: coreClassifier,
    boundLines: unbound([entry]),
    reused: plan.reused,
  });
  assert.deepEqual(result.verified, [unseen]);
  assert.deepEqual(log, []);
  assert.equal(result.bytes, 0);
  // The provider metadata is still re-checked: a moved digest is refused.
  const moved = structuredClone(release);
  moved.assets[0]!.sha256 = sha("moved");
  const refused = await reproduceFacts({
    entries: [entry],
    listReleases: lister(moved),
    inspect: inspector(players, log),
    classify: coreClassifier,
    boundLines: unbound([entry]),
    reused: plan.reused,
  });
  assert.deepEqual(refused.verified, []);
  assert.deepEqual(log, []);
  // A changed recorded fact, another parser version, a re-bound repository
  // or an ineligible baseline reuses nothing: the bytes are read again.
  const otherFact = structuredClone(baseline);
  otherFact.artifacts[0]!.players = [];
  const otherParser = { ...structuredClone(baseline), parser_version: FACTS_PARSER_VERSION - 1 };
  const otherId = { ...structuredClone(baseline), repository_id: 7 };
  const ineligible = { ...structuredClone(baseline), ineligible: "no-runtime" as never };
  for (const previous of [otherFact, otherParser, otherId, ineligible, undefined])
    assert.equal(reusedArchives(previous, entry).size, 0);
  const full = reproductionPlan(
    { entries: [otherFact] },
    { ...emptyFactsTable(), entries: [entry] },
  );
  assert.equal(full.bytes, 4096);
  await reproduceFacts({
    entries: [entry],
    listReleases: lister(release),
    inspect: inspector(players, log),
    classify: coreClassifier,
    boundLines: unbound([entry]),
    reused: full.reused,
  });
  assert.deepEqual(log, [windowsZip]);
});

void test("a batch lands only what its CI can reproduce in one hour's share; the rest is carried (J-B1)", () => {
  // The batch job and the batch's pull-request CI each reproduce every entry,
  // possibly in one hour: both together fit one hour's share at one request
  // per entry, so a batch lands half of it.
  assert.equal(reproductionsPerBatch, 2);
  assert.equal(reproductionBatchEntries, 250);
  assert.equal(reproductionBatchEntries * reproductionsPerBatch, reproductionHourlyRequests);
  const ids = ["zz-carry-a", "zz-carry-b", "zz-carry-c", "zz-carry-d"];
  const fresh = ids.map((id) => fixture(id).entry);
  // zz-carry-c had an older offered entry; zz-carry-d is new.
  const older = structuredClone(fresh[2]!);
  older.observation.observed_at = "2026-11-01T00:00:00.000Z";
  older.asset_names = [];
  const baseline = { ...emptyFactsTable(), entries: [older] };
  const current = { ...emptyFactsTable(), entries: fresh, entries_sha256: digestOf(fresh) };
  // Within the limit nothing is carried.
  assert.deepEqual(carryOver(baseline, current, 4).carried, []);
  const { table, carried } = carryOver(baseline, current, 2);
  assert.deepEqual(carried, ["zz-carry-c", "zz-carry-d"]);
  // The carried entries keep their baseline facts or stay absent.
  assert.deepEqual(
    table.entries.map((entry) => entry.port_id),
    ["zz-carry-a", "zz-carry-b", "zz-carry-c"],
  );
  assert.deepEqual(table.entries[2], older);
  assert.equal(table.entries_sha256, digestOf(table.entries));
  // What lands needs exactly the limit's reproduction.
  assert.equal(reproductionPlan(baseline, table).entries.length, 2);
  // The summary reports them as carried, never complete or settled.
  const text = JSON.stringify({
    ...summary(),
    settled: 4,
    identities: ids.map((port_id) => ({ port_id, outcome: "complete" })),
  });
  const marked = parseWorkerSummary(carriedSummary(text, carried));
  assert.equal(marked.settled, 2);
  assert.deepEqual(marked.carried_ids, carried);
  assert.deepEqual(
    marked.identities.map((row) => row.outcome),
    ["complete", "complete", "carried", "carried"],
  );
  // The batch pull request says so.
  assert.match(
    batchPullBody({
      runUrl: "https://example.invalid/run",
      provenance: {
        workflow_run_id: "1",
        source_commit: "a".repeat(40),
        cli_sha256: "b".repeat(64),
        inputs_sha256: "c".repeat(64),
      },
      delta: { added: 2, withdrawn: 0, changed: 0 },
      reproduced: 2,
      carried: 2,
    }),
    /2 further entries are carried to the next batch/u,
  );
  // The job carries before it generates the catalog.
  const workflow = parse(readFileSync(join(root, batchWorkflowPath), "utf8")) as {
    jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
  };
  const generate = workflow.jobs.combine!.steps.find((step) => step.id === "generate")!.run!;
  assert.ok(
    generate.indexOf("listing-facts-batch.mts carry --base HEAD") <
      generate.indexOf("generate-catalog.mts"),
  );
});

void test("reproduction reads each repository's release list once and waits out a spent quota (J2)", async () => {
  // Two entries of one repository: one list request, no per-release read.
  const { release, entry, players } = fixture();
  const second = structuredClone(entry);
  second.port_id = "zz-second";
  let calls = 0;
  const result = await reproduceFacts({
    entries: [entry, second],
    listReleases: async (id) => {
      calls++;
      return await lister(release)(id);
    },
    inspect: inspector(players),
    classify: coreClassifier,
    boundLines: new Map([
      [unseen, null],
      ["zz-second", null],
    ]),
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.verified.toSorted(), ["zz-second", unseen].toSorted());
  // The provider's quota headers decide the wait.
  const headers = (values: Record<string, string>) => ({
    get: (name: string) => values[name] ?? null,
  });
  assert.equal(quotaResumeAt(200, headers({ "x-ratelimit-remaining": "5" }), 1_000), undefined);
  assert.equal(
    quotaResumeAt(
      403,
      headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "100" }),
      1_000,
    ),
    100_000,
  );
  assert.equal(quotaResumeAt(429, headers({ "retry-after": "7" }), 1_000), 8_000);
  assert.equal(
    quotaResumeAt(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" }), 1_000),
    61_000,
  );
  assert.equal(
    quotaResumeAt(403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" }), 5_000),
    6_000,
  );
  // A spent quota is waited out and the request repeated, within the deadline.
  let clock = 1_000_000;
  const answers = [
    new Response("[]", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((clock + 20) / 1000) },
    }),
    new Response("[1]", { status: 200, headers: { "x-ratelimit-remaining": "999" } }),
  ];
  resetQuota();
  let requests = 0;
  const fetcher = (async () => {
    requests++;
    return answers.shift()!;
  }) as unknown as typeof fetch;
  assert.deepEqual(
    await githubJson("https://api.github.com/x", undefined, {
      fetch: fetcher,
      now: () => clock,
      deadline: clock + 60_000,
    }),
    [1],
  );
  assert.equal(requests, 2);
  // A wait past the deadline fails transiently, with the quota's reset time.
  resetQuota();
  clock = 2_000_000;
  const spent = (async () =>
    new Response("[]", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(clock / 1000 + 3600) },
    })) as unknown as typeof fetch;
  await assert.rejects(
    githubJson("https://api.github.com/x", undefined, {
      fetch: spent,
      now: () => clock,
      deadline: clock + 60_000,
    }),
    (error: unknown) =>
      error instanceof TransientGithubError && /quota is spent until/u.test(error.message),
  );
  resetQuota();
  // Shards run with the parallelism reproduction's half of the hourly quota
  // allows: at most one request per entry, so a shard costs its entry count.
  assert.equal(githubTokenHourlyRequests, 1_000);
  assert.equal(reproductionHourlyRequests, 500);
  assert.equal(
    reproductionParallelism(
      400,
      identityShards(Array.from({ length: 400 }, (_, i) => `id-${i}`)).length,
    ),
    250,
  );
  assert.equal(reproductionParallelism(1_100, 256), 100);
  assert.equal(reproductionParallelism(5_000, 256), 25);
  assert.equal(reproductionParallelism(0, 0), 1);
  // Over-budget refusals of every shard are transient, never a stop.
  const directory = mkdtempSync(join(tmpdir(), "facts-transient-"));
  try {
    const write = (name: string, value: unknown) =>
      writeFileSync(join(directory, name), JSON.stringify(value));
    write("refusals-0.json", { ok: false, transient: true, refusals: ["zz-a: over-budget: x"] });
    write("refusals-1.json", { ok: true, transient: false, refusals: [] });
    assert.equal(reproductionTransient(directory, 2), true);
    // A missing shard file, or any other refusal, is not transient.
    assert.equal(reproductionTransient(directory, 3), false);
    write("refusals-2.json", { ok: false, transient: false, refusals: ["zz-b: mismatch: y"] });
    assert.equal(reproductionTransient(directory, 3), false);
    const conditions = (reproduction: "refused" | "transient") =>
      stopConditions({
        runId: "9",
        now: "2026-11-21T00:00:00.000Z",
        summary: summary(),
        history: [record()],
        versions: "v",
        gate: "ok",
        paths: "ok",
        reproduction,
      }).conditions.map((condition) => condition.name);
    assert.deepEqual(conditions("transient"), []);
    assert.deepEqual(conditions("refused"), ["reproduction-unsound"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("one shared reproduction deadline bounds CI, the job and each identity's inspection (J3, J8)", () => {
  assert.equal(reproductionDeadlineMinutes, 85);
  // A CI shard holds ceil(candidates / 256) entries sharing the deadline.
  assert.equal(identityBudgetMinutes(1), 85);
  assert.equal(identityBudgetMinutes(256), 85);
  assert.equal(identityBudgetMinutes(400), 42.5);
  // Past one hour's reproduction share a shard must expect one quota reset.
  assert.equal(identityBudgetMinutes(500), 42.5);
  assert.equal(identityBudgetMinutes(501), (85 - 60) / 2);
  assert.equal(identityBudgetMinutes(1_100), 5);
  // The worker's budget is computed for one batch, which keeps a whole
  // deadline per entry.
  assert.equal(identityBudgetMinutes(reproductionBatchEntries), 85);
  const ci = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<
      string,
      {
        if?: string;
        needs?: string[];
        "timeout-minutes"?: number;
        permissions?: Record<string, string>;
        strategy?: Record<string, unknown>;
        steps: {
          name?: string;
          run?: string;
          env?: Record<string, string>;
          "timeout-minutes"?: number;
        }[];
      }
    >;
  };
  const shard = ci.jobs.listing_facts_reproduction!;
  // The repository's 120-minute CI job cap binds; the step outlasts the
  // deadline `verify` applies by default, so it never passes it.
  assert.ok(shard["timeout-minutes"]! <= 120);
  const step = shard.steps.find((item) => item.run?.includes("listing-facts-batch.mts verify"))!;
  assert.ok(step["timeout-minutes"]! > reproductionDeadlineMinutes);
  assert.doesNotMatch(step.run!, /--deadline-minutes/u);
  // Least privilege, always evaluated, bounded by the quota.
  assert.deepEqual(shard.permissions, { contents: "read" });
  assert.match(shard.if!, /^always\(\) &&/u);
  assert.match(String(shard.strategy!["max-parallel"]), /outputs\.max_parallel/u);
  // The `catalog` aggregate needs every reproduction shard and fails unless
  // they all succeeded when the plan asked for reproduction.
  const catalog = ci.jobs.catalog!;
  assert.match(catalog.if!, /always\(\)/u);
  assert.ok(catalog.needs!.includes("listing_facts_reproduction"));
  const required = catalog.steps.find(
    (item) => item.name === "Require every listing facts reproduction shard",
  )!;
  assert.equal(required.env!.RESULT, "${{ needs.listing_facts_reproduction.result }}");
  assert.match(required.run!, /\[ "\$REPRODUCE" = true \] && \[ "\$RESULT" != success \]/u);
  // The batch job's reproduction uses the same default deadline.
  const batch = parse(readFileSync(join(root, batchWorkflowPath), "utf8")) as {
    on: Record<string, unknown>;
    jobs: Record<
      string,
      { steps: { run?: string; "timeout-minutes"?: number }[]; strategy?: Record<string, unknown> }
    >;
  };
  // Triggers: the schedule and a manual dispatch only.
  assert.deepEqual(Object.keys(batch.on).toSorted(), ["schedule", "workflow_dispatch"]);
  const own = batch.jobs.reproduce!.steps.find((item) => item.run?.includes("verify --cli"))!;
  assert.doesNotMatch(own.run!, /--deadline-minutes/u);
  assert.ok(own["timeout-minutes"]! > reproductionDeadlineMinutes);
  assert.match(String(batch.jobs.reproduce!.strategy!["max-parallel"]), /outputs\.max_parallel/u);
});

void test("an identity that stays pending across consecutive runs stops the job, by cause (J4)", () => {
  const starving = { ...summary(), pending_ids: ["zz-slow", "zz-other"] };
  starving.identities = [
    { port_id: "zz-slow", outcome: "deferred-deadline" },
    { port_id: "zz-other", outcome: "deferred-deadline" },
  ];
  const first = stopConditions({
    runId: "1",
    now: "2026-11-21T00:00:00.000Z",
    summary: starving,
    history: [],
    versions: "v",
    gate: "ok",
    paths: "ok",
    reproduction: "ok",
  });
  assert.deepEqual(first.record!.pending_ids, ["zz-other", "zz-slow"]);
  const second = stopConditions({
    runId: "2",
    now: "2026-11-21T06:00:00.000Z",
    summary: { ...starving, pending_ids: ["zz-slow"] },
    history: [first.record!],
    versions: "v",
    gate: "ok",
    paths: "ok",
    reproduction: "ok",
  });
  const condition = second.conditions.find((item) => item.name === "pending-repeated")!;
  assert.match(condition.detail, /deferred-deadline \(1: zz-slow\)/u);
  assert.ok(stopConditionNames.includes("pending-repeated"));
  assert.throws(
    () => parseWorkerSummary(JSON.stringify({ ...summary(), pending_ids: [1] })),
    /malformed/u,
  );
});

void test("a batch past either released-reader bound is never proposed; it stops as catalog-capacity (R-F7)", async () => {
  const {
    capacityConstant,
    listingDeliveryBounds,
    listingDirectoryMeasures,
    withdrawalIdentities,
  } = await import("./catalog-capacity.mts");
  const { listingDirectoryTextMaximum } = await import("./listing-directory-carrier.mts");
  const signedCatalogSource = readFileSync(
    join(root, "crates/portcove-core/src/signed_catalog.rs"),
    "utf8",
  );
  const listingSource = readFileSync(
    join(root, "crates/portcove-core/src/catalog/listings.rs"),
    "utf8",
  );
  // The listing row's one bound is Core's listing directory text bound.
  assert.equal(
    listingDirectoryTextMaximum,
    capacityConstant(listingSource, "MAX_LISTING_DIRECTORY_TEXT_BYTES"),
  );
  const catalogText = readFileSync(join(root, "crates/portcove-core/catalog/catalog.json"), "utf8");
  const listingText = readFileSync(join(root, "crates/portcove-core/catalog/listings.json"));
  const listingBytes = statSync(join(root, "crates/portcove-core/catalog/listings.json")).size;
  // The delivery rows are exactly `catalog-capacity`'s listing rows.
  const listingDelivery = listingDirectoryMeasures(
    listingText,
    listingDeliveryBounds(
      readFileSync(join(root, "crates/portcove-listing-carrier/src/lib.rs"), "utf8"),
      listingSource,
      readFileSync(join(root, "crates/portcove-core/src/listing_delivery.rs"), "utf8"),
    ),
    undefined,
    withdrawalIdentities(
      JSON.parse(
        readFileSync(join(root, "crates/portcove-core/catalog/listing-withdrawals.json"), "utf8"),
      ),
    ),
  );
  // Today's catalog fits every bound.
  const today = batchCapacity({
    catalogText,
    listingBytes,
    signedCatalogSource,
    listingDelivery,
  });
  assert.equal(today.ok, true);
  assert.equal(capacityDetail(today), undefined);
  assert.equal(today.percent, 85);
  const retained = today.rows.find((row) => row.name.startsWith("JSON-escaped retained"))!;
  assert.equal(
    retained.bytes,
    Buffer.byteLength(JSON.stringify(catalogText)) + retainedContractReserveBytes,
  );
  assert.equal(retained.ceiling, Math.floor((16 * 1024 * 1024 * 85) / 100));
  const listingRows = today.rows.filter((row) => row.name.includes("listings.json"));
  assert.equal(listingRows.length, 1, "one listing text row, against one bound");
  // Every other listing row of the required check is checked too.
  assert.deepEqual(
    today.rows.slice(3, -1).map((row) => row.name),
    listingDelivery.map(([name]) => name),
  );
  const carrier = today.rows.find((row) => row.name.startsWith("compact listing carrier bytes"))!;
  assert.equal(carrier.bound, 8 * 1024 * 1024);
  // A batch past a delivery row the required check enforces is refused, so
  // it never opens a pull request that check would fail.
  const raised = (match: (name: string) => boolean, bytes: number) =>
    listingDelivery.map((measure): CapacityMeasure => {
      const [name, , bound, basis, ...margin] = measure;
      return match(name) ? [name, bytes, bound, basis, ...margin] : measure;
    });
  const overDelivery = batchCapacity({
    catalogText,
    listingBytes,
    signedCatalogSource,
    listingDelivery: raised((name) => name === carrier.name, carrier.ceiling + 1),
  });
  assert.deepEqual(
    overDelivery.rows.filter((row) => !row.ok).map((row) => row.name),
    [carrier.name],
  );
  // The frozen legacy target is informational in the required check: it
  // never stops a batch.
  assert.equal(
    batchCapacity({
      catalogText,
      listingBytes,
      signedCatalogSource,
      listingDelivery: raised((name) => name.startsWith("frozen legacy"), 16 * 1024 * 1024),
    }).ok,
    true,
  );
  const listing = listingRows[0]!;
  assert.equal(listing.bound, listingDirectoryTextMaximum);
  assert.equal(listing.ceiling, Math.floor((listingDirectoryTextMaximum * 85) / 100));
  // The former 8 MiB canonical read no longer binds the directory.
  assert.equal(
    batchCapacity({
      catalogText,
      listingBytes: 8 * 1024 * 1024 + 1,
      signedCatalogSource,
      listingDelivery: [],
    }).ok,
    true,
  );
  // At the ceiling the batch is proposed; one byte past it, it is refused
  // with the exact figures.
  assert.equal(
    batchCapacity({
      catalogText,
      listingBytes: listing.ceiling,
      signedCatalogSource,
      listingDelivery: [],
    }).ok,
    true,
  );
  const listings = batchCapacity({
    catalogText,
    listingBytes: listing.ceiling + 1,
    signedCatalogSource,
    listingDelivery: [],
  });
  assert.equal(listings.ok, false);
  assert.deepEqual(
    listings.rows.filter((row) => !row.ok).map((row) => row.name),
    ["generated listings.json bytes"],
  );
  assert.match(
    capacityDetail(listings)!,
    new RegExp(
      `generated listings.json bytes ${listing.ceiling + 1} bytes against a ceiling of ${listing.ceiling} \\(85% of ${listingDirectoryTextMaximum}\\), 1 bytes over`,
      "u",
    ),
  );
  // Escaping grows the text (each structural quote takes two bytes), so the
  // escaped contract binds while the raw text still fits.
  const quoted = JSON.stringify({
    ports: [{ id: "one", tags: Array.from({ length: 2_500_000 }, () => "a") }],
  });
  const escaped = batchCapacity({
    catalogText: quoted,
    listingBytes: 0,
    signedCatalogSource,
    listingDelivery: [],
  });
  assert.equal(escaped.rows[0]!.ok, true);
  assert.equal(escaped.rows.find((row) => row.name.startsWith("JSON-escaped retained"))!.ok, false);
  // The stop carries the figures; no other condition is invented.
  const stop = stopConditions({
    runId: "9",
    now: "2026-11-21T00:00:00.000Z",
    summary: summary(),
    history: [record()],
    versions: "v",
    gate: "ok",
    paths: "ok",
    reproduction: "ok",
    capacity: capacityDetail(listings)!,
  });
  assert.deepEqual(
    stop.conditions.map((condition) => condition.name),
    ["catalog-capacity"],
  );
  assert.match(stop.conditions[0]!.detail, /no pull request was opened/u);
  assert.ok(stopConditionNames.includes("catalog-capacity"));
  // The job checks capacity before any pull request: `combine` records it,
  // and `decide` proposes nothing unless it is within both bounds.
  const workflow = parse(readFileSync(join(root, batchWorkflowPath), "utf8")) as {
    jobs: Record<
      string,
      {
        outputs?: Record<string, string>;
        steps: { id?: string; run?: string; env?: Record<string, string> }[];
      }
    >;
  };
  const combine = workflow.jobs.combine!;
  const step = combine.steps.find((item) => item.id === "capacity")!;
  assert.match(step.run!, /listing-facts-batch\.mts capacity --output/u);
  assert.equal(combine.outputs!.capacity, "${{ steps.capacity.outputs.capacity }}");
  const decide = workflow.jobs.decide!;
  const ready = decide.steps.find((item) => item.id === "ready")!;
  // The batch as it stands: combine's measure, or the re-check's after an
  // identity was withheld (`withholdRefused`).
  assert.equal(ready.env!.CAPACITY, "${{ steps.effective.outputs.capacity }}");
  const effective = decide.steps.find((item) => item.id === "effective")!;
  assert.equal(effective.env!.COMBINE_CAPACITY, "${{ needs.combine.outputs.capacity }}");
  assert.equal(effective.env!.CAPACITY, "${{ steps.rechecked_capacity.outputs.capacity }}");
  const recheck = decide.steps.find((item) => item.id === "rechecked_capacity")!;
  assert.match(
    recheck.run!,
    /listing-facts-batch\.mts capacity --output "\$WORK\/capacity\.json"/u,
  );
  assert.match(ready.run!, /\[ "\$CAPACITY" = ok \]/u);
  const assess = decide.steps.find((item) => item.id === "assess")!;
  assert.match(assess.run!, /--capacity "\$WORK\/capacity\.json"/u);
});

void test("GitHub calls follow the retry guidance inside their deadline and classify transient failures (J-B3, J-B6, J-F2, J-F3)", async () => {
  // A fake clock that sleeping advances.
  let clock = 10_000_000;
  const now = () => clock;
  const waits: number[] = [];
  const pause = async (ms: number) => {
    waits.push(ms);
    clock += ms;
  };
  const scripted = (responses: (Response | Error)[]) => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      const next = responses.shift() ?? new Response("{}", { status: 200 });
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
    return { fetcher, calls: () => calls };
  };
  const call = (fetcher: typeof fetch, deadline?: number) =>
    githubRequest("GET", "https://api.github.com/y", undefined, {
      fetch: fetcher,
      now,
      sleep: pause,
      ...(deadline === undefined ? {} : { deadline }),
    });
  // A secondary limit stating no wait, a server error and a network failure
  // are retried after a minute, then exponentially longer.
  resetQuota();
  const flaky = scripted([
    new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403 }),
    new Response("{}", { status: 502 }),
    new TypeError("fetch failed"),
    new Response('{"ok":true}', { status: 200 }),
  ]);
  assert.deepEqual(await call(flaky.fetcher, clock + 3_600_000), { ok: true });
  assert.equal(flaky.calls(), 4);
  assert.deepEqual(waits, [githubFirstRetryMs, 2 * githubFirstRetryMs, 4 * githubFirstRetryMs]);
  // A retry that would pass the deadline ends transiently with its cause.
  waits.length = 0;
  const failing = scripted([new Response("{}", { status: 503 })]);
  await assert.rejects(
    call(failing.fetcher, clock + 30_000),
    (error: unknown) =>
      error instanceof TransientGithubError && /a server error \(503\)/u.test(error.message),
  );
  assert.deepEqual(waits, []);
  // Without a deadline a request is tried once and never waits.
  const once = scripted([new TypeError("fetch failed")]);
  await assert.rejects(call(once.fetcher), TransientGithubError);
  assert.equal(once.calls(), 1);
  // `retry-after: 0` waits a second, and the deadline still ends the loop.
  resetQuota();
  waits.length = 0;
  const zero = () => new Response("{}", { status: 429, headers: { "retry-after": "0" } });
  const spinning = scripted(Array.from({ length: 10 }, zero));
  await assert.rejects(call(spinning.fetcher, clock + 3_500), TransientGithubError);
  assert.ok(waits.every((ms) => ms >= 1_000));
  assert.ok(spinning.calls() <= 4);
  // A permission refusal is no rate limit: an ordinary error, not retried.
  resetQuota();
  const denied = scripted([new Response('{"message":"Resource not accessible"}', { status: 403 })]);
  await assert.rejects(
    call(denied.fetcher, clock + 3_600_000),
    (error: unknown) =>
      !(error instanceof TransientGithubError) && /answered 403/u.test(String(error)),
  );
  assert.equal(denied.calls(), 1);
  // The size bound is enforced while reading: the stream is cancelled once
  // it passes the bound, never buffered whole.
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const huge = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const oversized = scripted([new Response(huge, { status: 200 })]);
  await assert.rejects(call(oversized.fetcher, clock + 60_000), /answered more than/u);
  assert.ok(cancelled);
  assert.ok(pulled <= githubResponseBytes / chunk.length + 2);
  // An oversized answer is the provider's answer, never a transient failure.
  const oversizedAgain = scripted([
    new Response("[]", {
      status: 200,
      headers: { "content-length": String(githubResponseBytes + 1) },
    }),
  ]);
  await assert.rejects(
    call(oversizedAgain.fetcher, clock + 3_600_000),
    (error: unknown) =>
      !(error instanceof TransientGithubError) && /answered more than/u.test(String(error)),
  );
  assert.equal(oversizedAgain.calls(), 1);
  // A body whose reading aborts, and a truncated body that does not parse,
  // are network failures: retried after a minute, never a verdict (B3).
  resetQuota();
  waits.length = 0;
  const aborted = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('[{"id":'));
          controller.error(new Error("terminated"));
        },
      }),
      { status: 200 },
    );
  const recovering = scripted([
    aborted(),
    new Response('[{"id":', { status: 200 }),
    new Response("[1]", { status: 200 }),
  ]);
  assert.deepEqual(await call(recovering.fetcher, clock + 3_600_000), [1]);
  assert.equal(recovering.calls(), 3);
  assert.deepEqual(waits, [githubFirstRetryMs, 2 * githubFirstRetryMs]);
  // Past the deadline they end transiently, naming the cause.
  await assert.rejects(
    call(scripted([aborted()]).fetcher, clock + 30_000),
    (error: unknown) =>
      error instanceof TransientGithubError &&
      /network failure while reading the response/u.test(error.message),
  );
  await assert.rejects(
    call(scripted([new Response('[{"id":', { status: 200 })]).fetcher, clock + 30_000),
    (error: unknown) =>
      error instanceof TransientGithubError &&
      /truncated or unreadable response body/u.test(error.message),
  );
  resetQuota();
  // Reproduction reports network and runner-disk failures as transient.
  assert.equal(
    transientInspection(new InspectionError("Download failed.", false, "core-unknown", "network")),
    true,
  );
  assert.equal(
    transientInspection(new InspectionError("Disk.", false, "core-state", "runner-disk")),
    true,
  );
  assert.equal(transientInspection(new InspectionError("Refused.", true, "core-usage")), false);
  assert.equal(
    transientInspection(
      new InspectionError("No result.", false, "core-unknown", "unreadable-archive"),
    ),
    false,
  );
  const { release, entry, players } = fixture();
  const offline = await reproduceFacts({
    entries: [entry],
    listReleases: async () => {
      throw new TransientGithubError("a server error (502)");
    },
    inspect: inspector(players),
    classify: coreClassifier,
    boundLines: unbound([entry]),
  });
  assert.deepEqual(
    offline.refused.map((refusal) => refusal.reason),
    ["transient"],
  );
  const diskFull = await reproduceFacts({
    entries: [entry],
    listReleases: lister(release),
    inspect: inspector(new InspectionError("Disk.", false, "core-state", "runner-disk")),
    classify: coreClassifier,
    boundLines: unbound([entry]),
  });
  assert.deepEqual(
    diskFull.refused.map((refusal) => refusal.reason),
    ["transient"],
  );
  // A transient refusal file is transient for the run; two consecutive
  // transient runs stop the job with its causes.
  const directory = mkdtempSync(join(tmpdir(), "facts-transient-b3-"));
  try {
    writeFileSync(
      join(directory, "refusals-0.json"),
      JSON.stringify({ ok: false, transient: true, refusals: ["zz-a: transient: x"] }),
    );
    assert.equal(reproductionTransient(directory, 1), true);
    const first = stopConditions({
      runId: "1",
      now: "2026-11-21T00:00:00.000Z",
      summary: summary(),
      history: [record()],
      versions: "v",
      gate: "ok",
      paths: "ok",
      reproduction: "transient",
      details: reproductionDetails(directory),
    });
    assert.deepEqual(first.conditions, []);
    assert.equal(first.record!.reproduction_transient, true);
    const second = stopConditions({
      runId: "2",
      now: "2026-11-21T06:00:00.000Z",
      summary: summary(),
      history: [first.record!],
      versions: "v",
      gate: "ok",
      paths: "ok",
      reproduction: "transient",
      details: reproductionDetails(directory),
    });
    assert.deepEqual(
      second.conditions.map((condition) => condition.name),
      ["reproduction-transient"],
    );
    assert.match(second.conditions[0]!.detail, /zz-a: transient: x/u);
    assert.ok(stopConditionNames.includes("reproduction-transient"));
    // Unfiled stop issues are read back strictly; an unreadable record holds.
    const unfiled = join(directory, "unfiled.json");
    assert.deepEqual(readUnfiled(unfiled), []);
    writeFileSync(
      unfiled,
      JSON.stringify([{ title: "Listing facts batch stopped: x", body: "b" }]),
    );
    assert.deepEqual(readUnfiled(unfiled), [
      { title: "Listing facts batch stopped: x", body: "b" },
    ]);
    writeFileSync(unfiled, "{");
    assert.match(readUnfiled(unfiled)[0]!.title, /stopped: worker-error/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // The gate and notify steps bound their GitHub calls and keep unfiled
  // issues for the next run; the CI checks step bounds its reads too.
  const workflow = parse(readFileSync(join(root, batchWorkflowPath), "utf8")) as {
    jobs: Record<
      string,
      {
        steps: {
          id?: string;
          name?: string;
          run?: string;
          uses?: string;
          if?: string;
          with?: Record<string, string>;
        }[];
      }
    >;
  };
  const gate = workflow.jobs.gate!.steps;
  assert.match(
    gate.find((step) => step.id === "blocked")!.run!,
    /--unfiled .* --deadline-minutes 1/u,
  );
  assert.match(gate.find((step) => step.id === "pull")!.run!, /--deadline-minutes 1/u);
  const notify = workflow.jobs.notify!.steps;
  assert.match(
    notify.find((step) => step.name === "File one issue per stop condition")!.run!,
    /--unfiled work\/listing-facts-batch\/unfiled\.json --deadline-minutes 3/u,
  );
  const keep = notify.find((step) => step.name === "Keep the stop issues this run could not file")!;
  assert.equal(keep.if, "always()");
  assert.match(keep.uses!, /^actions\/cache\/save@/u);
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.equal(ci.match(/verify --reproduce false --deadline-minutes 14/gu)?.length, 2);
});

void test("reproduction restates a release's own text where the entry records it observed (#8569 1a)", async () => {
  const { release, entry, players } = fixture();
  const run = (recorded: ListingFactsEntry, provider: ProviderRelease) =>
    reproduceFacts({
      entries: [recorded],
      listReleases: lister(provider),
      inspect: inspector(players),
      classify: coreClassifier,
      boundLines: unbound([recorded]),
    });
  const beta = { ...release, name: "v1.0 Beta", body: null };
  // Recorded unobserved (the observer reported no text): text that states
  // nothing is left unobserved, exactly as the worker recorded it.
  assert.deepEqual((await run(entry, { ...release, name: "v1.0", body: "Fixes." })).verified, [
    unseen,
  ]);
  // R1 (review at f92d6f2c): recorded unobserved, but the provider's text now
  // states a prerelease (title or first body line): reconfirmation refuses
  // the entry as a mismatch so the worker observes it again. Before R1 this
  // row was verified.
  const unobservedBeta = await run(entry, beta);
  assert.deepEqual(unobservedBeta.verified, []);
  assert.equal(unobservedBeta.refused[0]!.reason, "mismatch");
  assert.match(unobservedBeta.refused[0]!.detail, /unobserved text/u);
  const unobservedBody = await run(entry, {
    ...release,
    name: "v1.0",
    body: "## Public beta test",
  });
  assert.equal(unobservedBody.refused[0]!.reason, "mismatch");
  // Recorded observed: the provider's title must still state no prerelease.
  const observed = structuredClone(entry);
  observed.observed_releases[0] = {
    ...observed.observed_releases[0]!,
    text: "observed",
    title: "v1.0",
  };
  assert.deepEqual((await run(observed, { ...release, name: "v1.0", body: "Fixes." })).verified, [
    unseen,
  ]);
  const titled = await run(observed, beta);
  assert.equal(titled.refused[0]!.reason, "release-changed");
  assert.match(titled.refused[0]!.detail, /stable-release verdict/u);
  // A first body line stating a release candidate is refused alike; a
  // remark further down is not a statement.
  const bodied = await run(observed, { ...release, name: "v1.0", body: "## RC 2\nnotes" });
  assert.equal(bodied.refused[0]!.reason, "release-changed");
  const remark = await run(observed, {
    ...release,
    name: "v1.0",
    body: "Fixes.\n\nStill pre-release quality.",
  });
  assert.deepEqual(remark.verified, [unseen]);
});

void test("a reproduction refusal of one identity withholds only that identity; the job proceeds (#1422 2)", () => {
  const ids = ["youkaicountry-yknytt", "zz-proceeds"];
  const entries = ids.map((id) => fixture(id).entry);
  const current: ListingFactsTable = {
    ...emptyFactsTable("2026-11-20T00:00:00.000Z"),
    entries,
    entries_sha256: digestOf(entries),
  };
  // The measured refusal: the release list's title states a prerelease.
  const refusal = {
    port_id: "youkaicountry-yknytt",
    reason: "mismatch" as const,
    detail:
      "Release 8 is recorded with unobserved text, but its text now states a prerelease; it is observed again.",
  };
  // Which refusals are a verdict on one identity, and which say the
  // reproduction itself is unsound or only the runner's condition.
  for (const reason of [
    "release-unavailable",
    "release-changed",
    "not-latest-stable",
    "asset-unavailable",
    "core-refused",
    "mismatch",
  ] as const)
    assert.equal(identityRefusal({ reason }), true, reason);
  for (const reason of ["over-budget", "transient", "out-of-scope"] as const)
    assert.equal(identityRefusal({ reason }), false, reason);
  const { table, withheld } = withholdRefused(current, [refusal]);
  assert.deepEqual(withheld, [refusal]);
  const refused = table.entries.find((entry) => entry.port_id === refusal.port_id)!;
  assert.equal(refused.ineligible?.reason, "reproduction-refused");
  assert.match(refused.ineligible?.detail ?? "", /\(mismatch\)/u);
  // The entry keeps the release it was refused for; the rest is untouched.
  assert.deepEqual(refused.observation, entries[0]!.observation);
  assert.deepEqual(refused.artifacts, []);
  assert.deepEqual(
    table.entries.find((entry) => entry.port_id === "zz-proceeds"),
    entries[1],
  );
  assert.equal(table.entries_sha256, digestOf(table.entries));
  // The same refusal again is the same entry: a reconfirmation, not churn.
  assert.deepEqual(
    withholdRefused(current, [{ ...refusal, detail: "Another provider message." }]).table,
    table,
  );
  // A refusal that is not one identity's, or names nothing in the batch, or
  // an entry that offers nothing, withholds nothing: the step fails.
  assert.throws(
    () => withholdRefused(current, [{ ...refusal, reason: "out-of-scope" }]),
    /withholds no identity/u,
  );
  assert.throws(
    () => withholdRefused(current, [{ ...refusal, reason: "transient" }]),
    /withholds no identity/u,
  );
  assert.throws(
    () => withholdRefused(current, [{ ...refusal, port_id: "zz-other" }]),
    /outside this batch/u,
  );
  assert.throws(() => withholdRefused(table, [refusal]), /offers nothing/u);
  // The worker summary reports the identity as ineligible for that reason.
  const text = withheldSummary(
    JSON.stringify({
      ...summary(),
      identities: ids.map((port_id) => ({ port_id, outcome: "complete" })),
    }),
    withheld,
  );
  const parsed = parseWorkerSummary(text);
  assert.deepEqual(parsed.identities, [
    { port_id: "youkaicountry-yknytt", outcome: "ineligible", reason: "reproduction-refused" },
    { port_id: "zz-proceeds", outcome: "complete" },
  ]);
  assert.equal(parsed.ineligible["reproduction-refused"], 1);
  // Its shard records the typed outcome as per identity: no stop, no transient.
  const record = refusalRecord(1, [refusal]);
  assert.equal(record.ok, true);
  assert.equal(record.transient, false);
  assert.deepEqual(record.refused, [refusal]);
  // Out of scope, or a problem beside the refusals, is not per identity.
  assert.equal(refusalRecord(1, [{ ...refusal, reason: "out-of-scope" }]).ok, false);
  assert.equal(refusalRecord(2, [refusal]).ok, false);
  // Transient beside identity refusals: the batch is retried, not stopped.
  const mixed = refusalRecord(2, [
    refusal,
    { port_id: "zz-proceeds", reason: "transient", detail: "x" },
  ]);
  assert.deepEqual([mixed.ok, mixed.transient], [false, true]);
  const directory = mkdtempSync(join(tmpdir(), "facts-withhold-"));
  try {
    const write = (name: string, value: unknown) =>
      writeFileSync(join(directory, name), JSON.stringify(value));
    write("refusals-0.json", refusalRecord(1, [refusal]));
    write("refusals-1.json", refusalRecord(0, []));
    assert.deepEqual(identityRefusals(directory, 2), [refusal]);
    // An identity-only reproduction is not transient: the job proceeds.
    assert.equal(reproductionTransient(directory, 2), false);
    // A missing shard record, an older record without typed refusals, or an
    // unsound record withholds nothing.
    assert.throws(() => identityRefusals(directory, 3), /2 of 3/u);
    write("refusals-1.json", { ok: true, transient: false, refusals: [] });
    assert.throws(() => identityRefusals(directory, 2), /not per identity/u);
    write("refusals-1.json", refusalRecord(1, [{ ...refusal, reason: "out-of-scope" }]));
    assert.throws(() => identityRefusals(directory, 2), /not per identity/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // An identity withheld after reproduction is no stop condition; only an
  // unsound reproduction is.
  const conditions = (reproduction: "ok" | "refused") =>
    stopConditions({
      runId: "9",
      now: "2026-11-21T00:00:00.000Z",
      summary: parsed,
      history: [],
      versions: "v",
      gate: "ok",
      paths: "ok",
      reproduction,
    }).conditions.map((condition) => condition.name);
  assert.deepEqual(conditions("ok"), []);
  assert.deepEqual(conditions("refused"), ["reproduction-unsound"]);
  // Withdrawing a route players already have because the job's own
  // reproduction disagreed is held for a person (`withdrawal-held`).
  const enrollments = (list: string[]) => ({ enrollments: list.map((port_id) => ({ port_id })) });
  assert.deepEqual(
    withdrawalCauses(enrollments(ids), enrollments(["zz-proceeds"]), current, table),
    [{ port_id: "youkaicountry-yknytt", cause: "reproduction-refused" }],
  );
});

void test("the decide job withholds refused identities and re-checks the batch before proposing it (#1422 2)", () => {
  const workflow = parse(readFileSync(join(root, batchWorkflowPath), "utf8")) as {
    jobs: Record<
      string,
      {
        "timeout-minutes"?: number;
        steps: {
          id?: string;
          if?: string;
          run?: string;
          env?: Record<string, string>;
          "continue-on-error"?: boolean;
        }[];
      }
    >;
  };
  const steps = workflow.jobs.decide!.steps;
  const index = (id: string) => steps.findIndex((step) => step.id === id);
  const withhold = steps[index("withhold")]!;
  assert.match(withhold.run!, /listing-facts-batch\.mts withhold --refusals/u);
  assert.match(withhold.if!, /needs\.reproduce\.result == 'success'/u);
  // Regenerated, then every check of the batch runs again before assess.
  const order = [
    "withhold",
    "regenerate",
    "rechecked_paths",
    "rechecked_gate",
    "rechecked_capacity",
    "rechecked_checks",
    "effective",
    "assess",
    "ready",
  ].map(index);
  assert.ok(
    order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)),
    String(order),
  );
  assert.match(
    steps[index("regenerate")]!.run!,
    /generate-catalog\.mts[\s\S]*--amend[\s\S]*format-patch/u,
  );
  assert.match(steps[index("rechecked_gate")]!.run!, /generate-catalog\.mts --check/u);
  assert.match(
    steps[index("rechecked_checks")]!.run!,
    /verify --base HEAD~1 --own-run true --reproduce false/u,
  );
  for (const id of ["rechecked_paths", "rechecked_gate", "rechecked_capacity", "rechecked_checks"])
    assert.equal(steps[index(id)]!["continue-on-error"], true, id);
  // A failed withhold is an unsound reproduction, and nothing is proposed.
  const assess = steps[index("assess")]!;
  assert.match(assess.env!.VERIFY!, /steps\.withhold\.outcome == 'failure'/u);
  assert.match(assess.env!.PATHS!, /steps\.effective\.outputs\.paths/u);
  assert.match(assess.env!.GATE!, /steps\.effective\.outputs\.gate/u);
  const ready = steps[index("ready")]!;
  assert.equal(ready.env!.MATERIAL, "${{ steps.effective.outputs.material }}");
  assert.match(ready.env!.REPRODUCE!, /steps\.withhold\.outcome == 'failure' && 'failure'/u);
});

void test("repeat refusals wait behind other entries, and an unbuilt withheld batch is its own stop (#1422 2)", () => {
  const ids = ["zz-a-refused", "zz-b", "zz-c"];
  const fresh = ids.map((id) => fixture(id).entry);
  const current = { ...emptyFactsTable(), entries: fresh, entries_sha256: digestOf(fresh) };
  const refusedBefore = withholdRefused(current, [
    { port_id: "zz-a-refused", reason: "mismatch", detail: "x" },
  ]).table.entries[0]!;
  const baseline = { ...emptyFactsTable(), entries: [refusedBefore] };
  // With two slots, the identity refused on this same release again waits.
  assert.deepEqual(carryOver(baseline, current, 2).carried, ["zz-a-refused"]);
  // Refused for an older release, it is no repeat: port_id order holds.
  const olderRelease = structuredClone(refusedBefore);
  olderRelease.observation.release_id = 7;
  assert.deepEqual(
    carryOver({ ...emptyFactsTable(), entries: [olderRelease] }, current, 2).carried,
    ["zz-c"],
  );
  const conditions = stopConditions({
    runId: "9",
    now: "2026-11-21T00:00:00.000Z",
    summary: summary(),
    history: [],
    versions: "v",
    gate: "skipped",
    paths: "skipped",
    reproduction: "ok",
    withheldRecheck: "regenerating the batch",
  }).conditions;
  assert.deepEqual(
    conditions.map((condition) => condition.name),
    ["withheld-batch-unchecked"],
  );
  assert.match(conditions[0]!.detail, /regenerating the batch failed/u);
  const workflow = parse(readFileSync(join(root, batchWorkflowPath), "utf8")) as {
    jobs: Record<string, { steps: { id?: string; run?: string; env?: Record<string, string> }[] }>;
  };
  const steps = workflow.jobs.decide!.steps;
  const effective = steps.find((step) => step.id === "effective")!;
  assert.equal(effective.env!.REQUEUED, "${{ steps.requeue.outcome }}");
  assert.match(effective.run!, /paths=skipped/u);
  assert.match(effective.run!, /recheck=regenerating the batch/u);
  assert.match(effective.run!, /recheck=publishing its exception queues/u);
  const assess = steps.find((step) => step.id === "assess")!;
  assert.equal(assess.env!.RECHECK, "${{ steps.effective.outputs.recheck }}");
  assert.match(assess.run!, /--withheld-recheck/u);
});
