// Unattended listing facts batch (#8569): the checks and decisions of the
// scheduled job `.github/workflows/listing-facts-batch.yml` and of the
// pull-request side that holds every facts-table change to the same rules.
//
// The job runs the facts worker (`scripts/listing-package-facts.mts`) once,
// regenerates the catalog and proposes one bounded batch. Nothing here is a
// second status or backlog authority: the facts table, the enrollment table
// and `catalog-route-fit.mts --json` stay the record; the job keeps only the
// worker state and a short run history in its cache.
//
// Rules this file owns, each fail-closed:
//  - Path allowlist: a batch changes only the facts table and the outputs
//    `scripts/generate-catalog.mts` rewrites from it (`batchAllowlist`), each
//    a regular non-executable file (`modeViolations`).
//  - Checker separation: one change may not edit the facts table and the
//    code that checks it (`checkerSeparationProblem`). This catches
//    accidents; a deliberate change to both is held only by review.
//  - Reproduction: every eligible entry a change adds or changes is re-read
//    from its exact digest-bound release asset and re-inspected by Core; its
//    players and facts must be byte-equal, and its release must still be the
//    newest stable one. An oversized, unavailable or changed asset is
//    refused, never trusted (`reproduceFacts`); so is a time ahead of the
//    clock (`clockProblems`).
//  - Provenance: a batch names the workflow run, source commit and inputs
//    digest it came from; CI checks them against that run, its retained
//    inputs and its outputs record (`provenanceProblems`, `inputsProblems`,
//    `outputsProblems`).
//  - Stop and wait: conditions a person must clear (`stopConditions`).
//
//   node scripts/listing-facts-batch.mts plan [--base REV]
//   node scripts/listing-facts-batch.mts verify --cli PORTCOVE [--base REV]
//   node scripts/listing-facts-batch.mts paths [--base REV] [--head REV]
//   node scripts/listing-facts-batch.mts observations --handoff DIR --output FILE
//   node scripts/listing-facts-batch.mts inputs --observations FILE --state FILE \
//     --observer-run ID --source-commit SHA --run-id ID --output FILE
//   node scripts/listing-facts-batch.mts assess --worker-report FILE --history FILE \
//     --run-id ID [--gate ok|refused] [--paths ok|violated] [--reproduction ok|refused] \
//     [--facts FILE] [--now ISO]
//   node scripts/listing-facts-batch.mts delta|versions|observer-run|open-pull-request …
//   node scripts/listing-facts-batch.mts merge-intent|collect …   (job plumbing)
//   node scripts/listing-facts-batch.mts queues --route-fit FILE [--output FILE]
//   node scripts/listing-facts-batch.mts issues --conditions FILE   (GitHub writes)
//   node scripts/listing-facts-batch.mts blocked                      (GitHub reads)
//   node scripts/listing-facts-batch.mts pull-request                 (GitHub reads)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { parseCatalogSource, readCatalogSource } from "./catalog-authoring.mts";
import {
  checkListingFactsTable,
  digestOf,
  FACTS_PARSER_VERSION,
  GENERATOR_VERSION,
  enrollmentTablePath,
  factsTablePath,
  gateBaselineRevision,
  readGateBaseline,
  reproductionBudget,
  reproductionCost,
  releaseLine,
  reproductionPlan,
  sameExceptReconfirmation,
  type ArtifactFactV2,
  type FactsProvenance,
  type GitRunner,
  type ListingFactsEntry,
  type ListingFactsTable,
  type ReproductionBudget,
} from "./catalog-generated-registration.mts";
import {
  artifactFact,
  assetsDigest,
  bareExecutablesOf,
  boundLinesOf,
  cliClassifier,
  cliInspector,
  InspectionError,
  isArchive,
  latestStable,
  NameVerdicts,
  OverBudgetError,
  readerPlatform,
  recordedTag,
  safeText,
  unreadableReleases,
  type ByteInspector,
  type NameClassifier,
  type ObservedAsset,
  type ObservedRelease,
} from "./listing-package-facts.mts";
import { isRecord } from "./runtime-values.mts";

const root = fileURLToPath(new URL("../", import.meta.url));

export const batchWorkflowPath = ".github/workflows/listing-facts-batch.yml";
/** A batch branch is this prefix and the run id that produced it. */
export const batchBranchPrefix = "automation/listing-facts-batch-";
export const inputsArtifactPrefix = "listing-facts-batch-inputs-";
/** The run's outputs record: digests of the facts table and batch patch it produced. */
export const outputsArtifactPrefix = "listing-facts-batch-outputs-";
/** Title prefix of the one issue per stop condition. */
export const stopIssuePrefix = "Listing facts batch stopped: ";
export const freshnessIssueTitle = "Listing facts batch: facts are falling behind the clock";
/** The required contexts a batch must pass on its exact head before merge. */
export const requiredContexts = [
  "catalog",
  "dependency-review",
  "frontend",
  "rust",
  "rust-quality",
] as const;

/**
 * Every path a batch may change: the facts table, the inputs nothing else
 * reads, and exactly the outputs `scripts/generate-catalog.mts` rewrites
 * when only the facts table changed (the enrollment table, the operational
 * catalog that gains the generated records, and the generated discovery
 * directory whose listings keep only their other platforms). CI also
 * requires `generate-catalog.mts --check`, so each output must equal what
 * the facts produce.
 */
export const batchAllowlist = [
  factsTablePath,
  enrollmentTablePath,
  "crates/portcove-core/catalog/catalog.json",
  "crates/portcove-core/catalog/listings.json",
] as const;

/**
 * The allowed paths a batch never authors: each must be byte-for-byte what
 * `scripts/generate-catalog.mts` writes from the facts table and the
 * unchanged sources (`generate-catalog.mts --check` compares every output).
 */
export const derivedBatchPaths = batchAllowlist.filter((file) => file !== factsTablePath);

/** Problems when the derived batch paths are not the canonical generator output. */
function canonicalDerivativeProblems(): string[] {
  const result = spawnSync(process.execPath, ["scripts/generate-catalog.mts", "--check"], {
    cwd: root,
    encoding: "utf8",
    // About 3 seconds in practice; a 2-minute cap keeps verify inside its
    // step budget beside the 30-minute reproduction and one 10-minute item.
    timeout: 2 * 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0
    ? []
    : [
        `${derivedBatchPaths.join(", ")} must be the byte-for-byte output of catalog generation from the facts table: ${(result.stderr || "generate-catalog.mts --check failed").trim().slice(-400)}`,
      ];
}

/** Paths outside the batch allowlist. */
export function pathViolations(paths: readonly string[]): string[] {
  const allowed = new Set<string>(batchAllowlist);
  return [...new Set(paths)].filter((file) => !allowed.has(file)).toSorted();
}

/** One changed path with its Git file modes before and after (`000000` when absent). */
export interface ChangedEntry {
  path: string;
  modes: [string, string];
}
/**
 * The modes an allowlisted path may have on either side: absent or a regular,
 * non-executable file. A symlink (`120000`), an executable bit (`100755`) or a
 * gitlink (`160000`) at an allowlisted path is a violation: the allowlist is
 * by name, and a name alone does not make a path a plain generated file.
 */
export const allowedModes: readonly string[] = ["000000", "100644"];

/**
 * `git diff --raw -z --no-renames` records: `:<old> <new> <sha> <sha> <status>`
 * then the path. Undefined when the text is not that shape, which callers
 * treat as a violation.
 */
export function parseRawDiff(text: string): ChangedEntry[] | undefined {
  const parts = text.split("\0");
  if (parts.at(-1) === "") parts.pop();
  const entries: ChangedEntry[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const header = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ [A-Z][0-9]*$/u.exec(
      parts[index] ?? "",
    );
    const file = parts[index + 1];
    if (!header || !file) return undefined;
    entries.push({ path: file, modes: [header[1]!, header[2]!] });
  }
  return entries;
}

/** Allowlisted paths whose mode on either side is not a regular non-executable file. */
export function modeViolations(entries: readonly ChangedEntry[]): string[] {
  const allowed = new Set<string>(batchAllowlist);
  return entries
    .filter(
      (entry) =>
        allowed.has(entry.path) && entry.modes.some((mode) => !allowedModes.includes(mode)),
    )
    .map((entry) => `${entry.path} (mode ${entry.modes.join(" → ")})`)
    .toSorted();
}

/**
 * Entries changed against `base`: the committed range to `head` when given,
 * else committed and working-tree changes plus untracked files (as regular
 * files; they are never allowlisted, since every allowlisted path is
 * tracked). Both sides of a rename count. Undefined when git cannot say,
 * which callers treat as a violation.
 */
export function changedEntries(
  git: GitRunner,
  base: string,
  head?: string,
): ChangedEntry[] | undefined {
  const diff = git([
    "diff",
    "--raw",
    "-z",
    "--no-renames",
    "--no-abbrev",
    base,
    ...(head ? [head] : []),
  ]);
  const raw = diff === undefined ? undefined : parseRawDiff(diff);
  if (!raw) return undefined;
  if (head) return raw;
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked === undefined) return undefined;
  return [
    ...raw,
    ...untracked
      .split("\0")
      .filter(Boolean)
      .map((file): ChangedEntry => ({ path: file, modes: ["000000", "100644"] })),
  ];
}

/** Paths changed against `base` (see `changedEntries`). */
export function changedPaths(git: GitRunner, base: string, head?: string): string[] | undefined {
  return changedEntries(git, base, head)?.map((entry) => entry.path);
}

/** Every allowlist problem of a change: paths outside it and modes inside it. */
export function allowlistProblems(entries: readonly ChangedEntry[] | undefined): string[] {
  if (!entries) return ["git could not list the changed paths and modes."];
  const problems: string[] = [];
  const outside = pathViolations(entries.map((entry) => entry.path));
  if (outside.length)
    problems.push(
      `A batch may change only ${batchAllowlist.join(", ")}; it changed ${outside.join(", ")}.`,
    );
  const modes = modeViolations(entries);
  if (modes.length)
    problems.push(
      `An allowlisted path must stay a regular, non-executable file: ${modes.join(", ")}.`,
    );
  return problems;
}

// ---------------------------------------------------------------------------
// Checker separation: the PR-side check runs the pull request's own code.

/**
 * Inputs of the facts check that are not found by following script imports:
 * the two workflows that run it, the Rust setup they share, the Rust lock
 * and the CLI command files that dispatch Core's inspection and name
 * classification. Directories end with `/`.
 */
const checkerRoots = {
  workflows: [".github/workflows/ci.yml", batchWorkflowPath, ".github/actions/setup-rust/"],
  /** Scripts whose import closure is the check: the batch rules, the worker, the gate, catalog generation and CI's plan. */
  scripts: [
    "scripts/listing-facts-batch.mts",
    "scripts/listing-package-facts.mts",
    "scripts/catalog-generated-registration.mts",
    "scripts/generate-catalog.mts",
    "scripts/validation-plan.mts",
  ],
  rust: [
    "Cargo.lock",
    "crates/portcove-cli/src/main.rs",
    "crates/portcove-cli/src/catalog.rs",
    "crates/portcove-core/src/package_shape.rs",
    "crates/portcove-core/src/package_shape/",
  ],
  /** The Core module whose submodules' direct `crate::` dependencies are also checker inputs. */
  core: "crates/portcove-core/src/package_shape.rs",
} as const;

const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+\.(?:mts|ts|mjs|js))["']/gmu;

/**
 * The paths the PR-side facts check depends on, derived from the checkout:
 * the fixed workflow and CLI inputs, the relative import closure of the
 * checker scripts, and the Core inspection module with every Core module it
 * names directly (`crate::<module>` as `src/<module>.rs` and `src/<module>/`).
 * Deeper Core dependencies are held by review only. Directories end with `/`.
 */
export function checkerPaths(read: (file: string) => string | undefined): string[] {
  const found = new Set<string>([...checkerRoots.workflows, ...checkerRoots.rust]);
  const queue: string[] = [...checkerRoots.scripts];
  while (queue.length) {
    const file = queue.shift()!;
    if (found.has(file)) continue;
    const text = read(file);
    if (text === undefined) continue;
    found.add(file);
    for (const match of text.matchAll(importPattern))
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]!)));
  }
  // The module file and its `mod x;` submodules (`<dir>/x.rs`), recursively.
  const modules = new Set<string>();
  const files = [checkerRoots.core as string];
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    const text = read(file);
    if (text === undefined) continue;
    const directory = file.slice(0, -".rs".length);
    for (const match of text.matchAll(
      /^\s*(?:pub(?:\([a-z]+\))?\s+)?mod\s+([a-z_][a-z0-9_]*)\s*;/gmu,
    ))
      files.push(`${directory}/${match[1]!}.rs`);
    for (const match of text.matchAll(/\bcrate::([a-z_][a-z0-9_]*)/gu)) modules.add(match[1]!);
  }
  for (const module of modules) {
    found.add(`crates/portcove-core/src/${module}.rs`);
    found.add(`crates/portcove-core/src/${module}/`);
  }
  return [...found].toSorted();
}

/** Changed paths that are checker inputs. */
export function checkerChanges(changed: readonly string[], checker: readonly string[]) {
  return [...new Set(changed)]
    .filter((file) =>
      checker.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry)),
    )
    .toSorted();
}

/**
 * The refusal when one change edits the facts table and the code that checks
 * it. The PR-side check runs the pull request's own code, so such a change
 * could check itself with a loosened checker. This catches accidents; a
 * deliberate change to both is held only by review. The enrollment table
 * alone is not refused: a rule change necessarily regenerates it in the same
 * change (`generate-catalog.mts --check`), from facts the change cannot edit.
 */
export function checkerSeparationProblem(
  changed: readonly string[],
  checker: readonly string[],
): string | undefined {
  if (!changed.includes(factsTablePath)) return undefined;
  const touched = checkerChanges(changed, checker);
  if (!touched.length) return undefined;
  return `This change edits the listing facts table and the code that checks it (${touched.slice(0, 8).join(", ")}${touched.length > 8 ? `, and ${touched.length - 8} more` : ""}). The pull-request check runs this change's own code, so the facts table and its checker must be separate changes: land the checker change first, then the facts.`;
}

// ---------------------------------------------------------------------------
// Reproduction: re-read the exact bytes behind facts.

/** A provider release as the GitHub REST release endpoint states it. */
export interface ProviderRelease {
  id: number;
  /** `owner/name` the provider names for the release's repository now. */
  repository: string;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: { id: number; name: string; size: number; sha256: string | null; url: string }[];
}
/** Reads one release of a repository by numeric ids; throws when unavailable. */
export type ReleaseReader = (repositoryId: number, releaseId: number) => Promise<ProviderRelease>;
/**
 * The first page of a repository's releases, newest first, as the worker's
 * observations state them; `full` when the page is full, so more may exist.
 */
export interface ProviderReleaseList {
  releases: ObservedRelease[];
  full: boolean;
}
/** Lists one bounded page of a repository's releases by numeric id; throws when unavailable. */
export type ReleaseLister = (repositoryId: number) => Promise<ProviderReleaseList>;
/** Releases one listing read returns: one page of the REST maximum. */
export const releaseListPage = 100;

export type RefusalReason =
  | "over-budget"
  | "oversized-asset"
  | "release-unavailable"
  | "release-changed"
  | "not-latest-stable"
  | "asset-unavailable"
  | "core-refused"
  | "mismatch";
export interface Refusal {
  port_id: string;
  reason: RefusalReason;
  detail: string;
}
export interface ReproductionResult {
  verified: string[];
  refused: Refusal[];
  bytes: number;
}

/**
 * Re-derive every planned entry from its provider release and exact bytes.
 * An entry is verified only when the release still states the recorded tag,
 * publication time, stable verdict and asset list, it is still the newest
 * stable release the worker's rules choose from the repository's release
 * list, the entry records exactly the release's archives, and each archive's
 * re-inspected players and Core's name verdicts rebuild a byte-equal artifact
 * fact. Anything else, including a budget overrun, refuses that entry.
 *
 * `boundLines` names, for every entry, the release line its listing binds
 * (`boundReleaseLine`, null when unbound): the worker chooses the newest
 * stable release of that line only, so reproduction checks the same.
 *
 * `deadline` (epoch ms, default now plus `budget.maxMilliseconds`) is checked
 * before each entry and archive; pass the same deadline to the inspector and
 * classifier so a download or Core run that reaches it stops there and the
 * entry is refused as `over-budget` instead of running past the step.
 */
export async function reproduceFacts(inputs: {
  entries: readonly ListingFactsEntry[];
  readRelease: ReleaseReader;
  listReleases: ReleaseLister;
  inspect: ByteInspector;
  classify: NameClassifier;
  boundLines: ReadonlyMap<string, string | null>;
  budget?: ReproductionBudget;
  clock?: () => number;
  deadline?: number;
}): Promise<ReproductionResult> {
  const budget = inputs.budget ?? reproductionBudget;
  const clock = inputs.clock ?? Date.now;
  const deadline = inputs.deadline ?? clock() + budget.maxMilliseconds;
  const refused: Refusal[] = [];
  const verified: string[] = [];
  const total = inputs.entries.reduce((sum, entry) => sum + reproductionCost(entry), 0);
  if (inputs.entries.length > budget.maxEntries || total > budget.maxBytes) {
    const detail = `The change asks to reproduce ${inputs.entries.length} entries and ${total} bytes; one change may reproduce at most ${budget.maxEntries} entries and ${budget.maxBytes} bytes.`;
    return {
      verified,
      refused: inputs.entries.map((entry) => ({
        port_id: entry.port_id,
        reason: "over-budget",
        detail,
      })),
      bytes: 0,
    };
  }
  const overBudget = `The reproduction ran out of its ${budget.maxMilliseconds} ms budget.`;
  let names: NameVerdicts;
  try {
    names = await NameVerdicts.start(inputs.classify);
  } catch (error) {
    if (!(error instanceof OverBudgetError)) throw error;
    return {
      verified,
      refused: inputs.entries.map((entry) => ({
        port_id: entry.port_id,
        reason: "over-budget",
        detail: overBudget,
      })),
      bytes: 0,
    };
  }
  let bytes = 0;
  for (const entry of inputs.entries) {
    const refuse = (reason: RefusalReason, detail: string) =>
      refused.push({ port_id: entry.port_id, reason, detail });
    if (clock() >= deadline) {
      refuse("over-budget", overBudget);
      continue;
    }
    try {
      const outcome = await reproduceEntry(entry);
      if (outcome === "verified") verified.push(entry.port_id);
      else refuse(outcome.reason, outcome.detail);
    } catch (error) {
      // A download, Core run or classification that reached the deadline.
      if (!(error instanceof OverBudgetError)) throw error;
      refuse("over-budget", overBudget);
    }
  }
  return { verified, refused, bytes };

  async function reproduceEntry(
    entry: ListingFactsEntry,
  ): Promise<"verified" | { reason: RefusalReason; detail: string }> {
    const large = [...entry.artifacts, ...entry.refused_archives].find(
      (artifact) => artifact.size > budget.maxArchiveBytes,
    );
    if (large)
      return {
        reason: "oversized-asset",
        detail: `${large.name} exceeds ${budget.maxArchiveBytes} bytes.`,
      };
    const releaseId = entry.observation.release_id;
    if (releaseId === null)
      return { reason: "release-changed", detail: "An eligible entry names no release." };
    let release: ProviderRelease;
    try {
      release = await inputs.readRelease(entry.repository_id, releaseId);
    } catch (error) {
      return {
        reason: "release-unavailable",
        detail: `The release could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
    const observed: ObservedRelease = {
      id: release.id,
      version: release.tag_name,
      published_at: release.published_at,
      provider_prerelease: release.prerelease,
      assets_complete: true,
      malformed_assets: 0,
      assets: release.assets.map(({ id, name, url, size, sha256 }) => ({
        id,
        name,
        url,
        size,
        sha256,
      })),
    };
    const published = Date.parse(release.published_at ?? "");
    await names.add({
      releases: [{ tag: release.tag_name, provider_prerelease: release.prerelease }],
      assets: release.assets.filter((asset) => isArchive(asset.name)).map((asset) => asset.name),
    });
    const stated: [boolean, string][] = [
      // The numeric ids must name the listing's own repository: a release of
      // any other repository is refused, whatever its bytes say.
      [
        release.repository.toLowerCase() === entry.repository.toLowerCase(),
        `the listed repository ${entry.repository} (the ids name ${release.repository})`,
      ],
      [release.id === releaseId && !release.draft, "the release id or draft state"],
      [
        safeText(release.tag_name, `release-${release.id}`) === entry.observation.tag,
        "the release tag",
      ],
      [
        (Number.isNaN(published) ? null : new Date(published).toISOString()) ===
          entry.observation.published_at,
        "the publication time",
      ],
      [names.prerelease(observed) === false, "the stable-release verdict"],
      [assetsDigest(observed) === entry.observation.assets_sha256, "the release asset list"],
      // The release's own line facts: its tag, time and verdict as recorded,
      // and the bare installer programs beside its archives. Other releases'
      // lines come from the observer report the batch run retained.
      [
        entry.observed_releases.some(
          (recorded) =>
            recorded.release_id === release.id &&
            recorded.tag === recordedTag(release.tag_name) &&
            recorded.prerelease === false &&
            recorded.published_at === entry.observation.published_at,
        ),
        "the release among the observed releases",
      ],
      [
        JSON.stringify(bareExecutablesOf(observed)) === JSON.stringify(entry.bare_executables),
        "the bare installer and program assets",
      ],
    ];
    const differs = stated.filter(([same]) => !same).map(([, what]) => what);
    if (differs.length)
      return {
        reason: "release-changed",
        detail: `The provider no longer states ${differs.join(", ")}.`,
      };
    // The release must still be the one the worker's rules offer: the newest
    // stable release of the repository's list. An older release whose bytes
    // reproduce must not enroll.
    let listed: ProviderReleaseList;
    try {
      listed = await inputs.listReleases(entry.repository_id);
    } catch (error) {
      return {
        reason: "release-unavailable",
        detail: `The release list could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
    if (!inputs.boundLines.has(entry.port_id))
      return {
        reason: "mismatch",
        detail: "The entry's listing is not an authored listing-only identity.",
      };
    const newest = await newestStableProblem(
      listed,
      releaseId,
      entry.repository,
      inputs.boundLines.get(entry.port_id) ?? null,
    );
    if (newest) return { reason: "not-latest-stable", detail: newest };
    // The entry records exactly the release's archives: none may be left out.
    const archives = release.assets
      .filter((asset) => isArchive(asset.name))
      .map((asset) => asset.id)
      .toSorted((left, right) => left - right);
    const recorded = [...entry.artifacts, ...entry.refused_archives]
      .map((artifact) => artifact.asset_id)
      .toSorted((left, right) => left - right);
    if (JSON.stringify(archives) !== JSON.stringify(recorded))
      return {
        reason: "mismatch",
        detail: "The entry does not record exactly the release's archives.",
      };
    for (const artifact of entry.artifacts) {
      const asset = release.assets.find((candidate) => candidate.id === artifact.asset_id)!;
      if (
        asset.name !== artifact.name ||
        asset.size !== artifact.size ||
        asset.sha256 !== artifact.sha256
      )
        return {
          reason: "release-changed",
          detail: `${artifact.name} no longer has the recorded name, size or digest.`,
        };
      if (clock() >= deadline) return { reason: "over-budget", detail: overBudget };
      const bound: ObservedAsset & { sha256: string } = { ...asset, sha256: artifact.sha256 };
      let players;
      try {
        bytes += asset.size;
        players = await inputs.inspect(bound, readerPlatform(asset.name));
      } catch (error) {
        if (error instanceof OverBudgetError) throw error;
        const permanent = error instanceof InspectionError && error.permanent;
        return {
          reason: permanent ? "core-refused" : "asset-unavailable",
          detail: `${artifact.name}: ${error instanceof Error ? error.message : "inspection failed"}`,
        };
      }
      await names.add({
        programs: players.map((player) =>
          player.display_path.slice(player.display_path.lastIndexOf("/") + 1),
        ),
      });
      const suggestion = names.suggestion(asset.name);
      const programs = players.map((player) =>
        player.display_path.slice(player.display_path.lastIndexOf("/") + 1),
      );
      if (!suggestion || programs.some((name) => names.programToken(name) === undefined))
        return {
          reason: "mismatch",
          detail: `Core could not classify a name in ${artifact.name}.`,
        };
      const rebuilt: ArtifactFactV2 = artifactFact(bound, players, suggestion, (name) =>
        names.programToken(name)!,
      );
      if (JSON.stringify(rebuilt) !== JSON.stringify(artifact))
        return {
          reason: "mismatch",
          detail: `${artifact.name}: the re-inspected players or Core's name verdicts differ from the recorded facts.`,
        };
    }
    // A refused archive is refused again, for the same class, under the same name verdict.
    for (const archive of entry.refused_archives) {
      const asset = release.assets.find((candidate) => candidate.id === archive.asset_id)!;
      if (
        asset.name !== archive.name ||
        asset.size !== archive.size ||
        asset.sha256 !== archive.sha256 ||
        JSON.stringify(names.suggestion(asset.name)) !== JSON.stringify(archive.name_suggestion)
      )
        return {
          reason: "release-changed",
          detail: `${archive.name} no longer has the recorded name, size, digest or name verdict.`,
        };
      if (clock() >= deadline) return { reason: "over-budget", detail: overBudget };
      let outcome: string;
      try {
        bytes += asset.size;
        await inputs.inspect({ ...asset, sha256: archive.sha256 }, readerPlatform(asset.name));
        outcome = "inspected";
      } catch (error) {
        if (error instanceof OverBudgetError) throw error;
        outcome = error instanceof InspectionError && error.permanent ? error.refusal : "transient";
      }
      if (outcome !== archive.refusal)
        return {
          reason: outcome === "transient" ? "asset-unavailable" : "mismatch",
          detail: `${archive.name}: the recorded ${archive.refusal} refusal was not reproduced.`,
        };
    }
    return "verified";
  }

  /** Why `releaseId` is not the newest stable release of the list, if it is not. */
  async function newestStableProblem(
    listed: ProviderReleaseList,
    releaseId: number,
    repository: string,
    line: string | null,
  ) {
    if (listed.full)
      return `The repository lists ${releaseListPage} or more releases; one page cannot show the newest stable release.`;
    await names.add({
      releases: listed.releases.map((item) => ({
        tag: item.version,
        provider_prerelease: item.provider_prerelease,
      })),
    });
    const offered =
      line === null
        ? listed.releases
        : listed.releases.filter(
            (item) => releaseLine(recordedTag(item.version), item.id, repository) === line,
          );
    const chosen = latestStable(offered, (item) => names.prerelease(item));
    const unreadable = unreadableReleases(listed.releases, chosen.release ?? chosen.unclassified);
    if (unreadable) return unreadable;
    if (chosen.unclassified)
      return `Release ${chosen.unclassified.id} is newer than every stable release and has a tag Core could not classify.`;
    if (chosen.release?.id !== releaseId)
      return `The newest stable release is ${chosen.release ? `id ${chosen.release.id}` : "none"}, not the recorded id ${releaseId}.`;
    return undefined;
  }
}

const apiVersion = "2022-11-28";
/** Bounded JSON GET of the GitHub REST API with the workflow token when present. */
async function githubJson(
  url: string,
  token: string | undefined,
  maxBytes = 8 * 1024 * 1024,
  timeoutMs = 30_000,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": apiVersion,
      "user-agent": "portcove-listing-facts-batch",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) throw new Error(`${url} answered more than ${maxBytes} bytes.`);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return JSON.parse(body.toString("utf8")) as unknown;
}

/** The release reader CI uses: GitHub's REST release by numeric repository and release id. */
export function githubReleaseReader(token: string | undefined): ReleaseReader {
  return async (repositoryId, releaseId) =>
    parseProviderRelease(
      await githubJson(
        `https://api.github.com/repositories/${repositoryId}/releases/${releaseId}`,
        token,
      ),
    );
}

/**
 * One page of releases by numeric repository id, newest first: the same
 * `per_page=100` page bound the observer reads with.
 */
export function githubReleaseLister(token: string | undefined): ReleaseLister {
  return async (repositoryId) =>
    parseProviderReleaseList(
      await githubJson(
        `https://api.github.com/repositories/${repositoryId}/releases?per_page=${releaseListPage}&page=1`,
        token,
      ),
    );
}

/**
 * A release list page as the worker's observations state it. A malformed
 * release record fails the whole list (the newest stable release is then
 * unknown); a malformed asset record is counted, as the worker counts it,
 * so `unreadableReleases` judges it the same way. Drafts are not releases.
 */
export function parseProviderReleaseList(value: unknown): ProviderReleaseList {
  if (!Array.isArray(value) || value.length > releaseListPage)
    throw new Error("The provider release list is malformed.");
  const releases = value.map((release: unknown): ObservedRelease & { draft: boolean } => {
    if (
      !isRecord(release) ||
      !Number.isSafeInteger(release.id) ||
      Number(release.id) < 1 ||
      typeof release.tag_name !== "string" ||
      typeof release.draft !== "boolean" ||
      typeof release.prerelease !== "boolean" ||
      !(release.published_at === null || typeof release.published_at === "string") ||
      !Array.isArray(release.assets)
    )
      throw new Error("A provider release list record is malformed.");
    const readable = (asset: unknown): asset is Record<string, unknown> =>
      isRecord(asset) &&
      Number.isSafeInteger(asset.id) &&
      Number(asset.id) > 0 &&
      typeof asset.name === "string" &&
      typeof asset.browser_download_url === "string" &&
      Number.isSafeInteger(asset.size);
    const assets = (release.assets as unknown[]).filter(readable);
    return {
      id: Number(release.id),
      version: release.tag_name,
      published_at: release.published_at,
      provider_prerelease: release.prerelease,
      draft: release.draft,
      assets_complete: true,
      malformed_assets: release.assets.length - assets.length,
      assets: assets.map((asset) => ({
        id: Number(asset.id),
        name: String(asset.name),
        url: String(asset.browser_download_url),
        size: Number(asset.size),
        sha256:
          typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/iu.test(asset.digest)
            ? asset.digest.slice(7).toLowerCase()
            : null,
      })),
    };
  });
  return {
    releases: releases
      .filter((release) => !release.draft)
      .map(({ draft: _draft, ...rest }) => rest),
    full: value.length === releaseListPage,
  };
}

/** A provider release record, or an error naming what is malformed. */
export function parseProviderRelease(value: unknown): ProviderRelease {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    typeof value.tag_name !== "string" ||
    typeof value.draft !== "boolean" ||
    typeof value.prerelease !== "boolean" ||
    !(value.published_at === null || typeof value.published_at === "string") ||
    !Array.isArray(value.assets) ||
    typeof value.url !== "string"
  )
    throw new Error("The provider release record is malformed.");
  // `https://api.github.com/repos/<owner>/<name>/releases/<id>` names the
  // repository the numeric repository id resolves to now.
  const named = /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)\/releases\/[0-9]+$/u.exec(
    value.url,
  );
  if (!named) throw new Error("The provider release record names no repository.");
  const assets = value.assets.map((asset: unknown) => {
    if (
      !isRecord(asset) ||
      !Number.isSafeInteger(asset.id) ||
      typeof asset.name !== "string" ||
      !Number.isSafeInteger(asset.size) ||
      typeof asset.browser_download_url !== "string"
    )
      throw new Error("A provider release asset record is malformed.");
    const digest =
      typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/iu.test(asset.digest)
        ? asset.digest.slice(7).toLowerCase()
        : null;
    return {
      id: Number(asset.id),
      name: asset.name,
      size: Number(asset.size),
      sha256: digest,
      url: asset.browser_download_url,
    };
  });
  return {
    id: Number(value.id),
    repository: named[1]!,
    tag_name: value.tag_name,
    draft: value.draft,
    prerelease: value.prerelease,
    published_at: value.published_at,
    assets,
  };
}

// ---------------------------------------------------------------------------
// Provenance: a batch names the run it came from, and CI checks it.

/** The facts table's provenance changed against the baseline: the change claims to be a batch. */
export function claimsBatch(
  baseline: unknown,
  current: ListingFactsTable,
  headRef: string | undefined,
): boolean {
  const before = isRecord(baseline) ? (baseline.provenance ?? null) : null;
  return (
    Boolean(headRef?.startsWith(batchBranchPrefix)) ||
    (current.provenance !== undefined && digestOf(before) !== digestOf(current.provenance))
  );
}

/** What a GitHub workflow run says about itself (REST `actions/runs/{id}`). */
export interface WorkflowRunRecord {
  id: number;
  path: string;
  head_branch: string | null;
  head_sha: string;
  event: string;
  repository: string;
}

/** Problems with a batch's provenance against the run it names. */
export function provenanceProblems(
  provenance: FactsProvenance | undefined,
  run: WorkflowRunRecord | undefined,
  context: { repository: string; headRef?: string | undefined },
): string[] {
  if (!provenance) return ["A batch must record its provenance."];
  const problems: string[] = [];
  if (!run) return [`Workflow run ${provenance.workflow_run_id} could not be read.`];
  if (String(run.id) !== provenance.workflow_run_id)
    problems.push("The provenance names another run.");
  if (run.repository !== context.repository)
    problems.push(`Run ${run.id} belongs to ${run.repository}, not ${context.repository}.`);
  if (run.path !== batchWorkflowPath)
    problems.push(`Run ${run.id} is ${run.path}, not the batch workflow ${batchWorkflowPath}.`);
  if (run.head_branch !== "main") problems.push(`Run ${run.id} did not run from main.`);
  if (!["schedule", "workflow_dispatch"].includes(run.event))
    problems.push(`Run ${run.id} was started by ${run.event}, not by the schedule or a dispatch.`);
  if (run.head_sha !== provenance.source_commit)
    problems.push(
      `Run ${run.id} ran ${run.head_sha}, not the recorded ${provenance.source_commit}.`,
    );
  if (context.headRef !== undefined && context.headRef !== `${batchBranchPrefix}${run.id}`)
    problems.push(
      `The pull request branch ${context.headRef} is not the batch branch of run ${run.id}.`,
    );
  return problems;
}

/** The inputs one batch run records and retains as an artifact. */
export interface BatchInputs {
  format: 1;
  run_id: string;
  source_commit: string;
  observer_run_id: string;
  observations_sha256: string;
  state_sha256: string;
  facts_table_sha256: string;
  budget: Record<string, number>;
}

/** Problems with a run's retained inputs against the provenance and the files beside them. */
export function inputsProblems(
  provenance: FactsProvenance,
  files: ReadonlyMap<string, Buffer>,
): string[] {
  const inputs = files.get("inputs.json");
  if (!inputs) return ["The run's inputs artifact holds no inputs.json."];
  const sha = (bytes: Buffer | undefined) =>
    bytes ? createHash("sha256").update(bytes).digest("hex") : "missing";
  if (sha(inputs) !== provenance.inputs_sha256)
    return ["The run's inputs.json does not have the recorded inputs digest."];
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputs.toString("utf8"));
  } catch {
    return ["The run's inputs.json is not JSON."];
  }
  if (!isRecord(parsed) || parsed.format !== 1) return ["The run's inputs.json is malformed."];
  const problems: string[] = [];
  if (parsed.run_id !== provenance.workflow_run_id) problems.push("inputs.json names another run.");
  if (parsed.source_commit !== provenance.source_commit)
    problems.push("inputs.json names another source commit.");
  if (parsed.observations_sha256 !== sha(files.get("observations.json")))
    problems.push("The retained observations differ from inputs.json.");
  if (parsed.state_sha256 !== sha(files.get("state-before.json")))
    problems.push("The retained worker state differs from inputs.json.");
  return problems;
}

/** Inputs of one run, with digests of the files retained beside it. */
export function batchInputs(input: {
  runId: string;
  sourceCommit: string;
  observerRunId: string;
  observations: Buffer;
  state: Buffer;
  factsTable: Buffer;
  budget: Record<string, number>;
}): BatchInputs {
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  return {
    format: 1,
    run_id: input.runId,
    source_commit: input.sourceCommit,
    observer_run_id: input.observerRunId,
    observations_sha256: sha(input.observations),
    state_sha256: sha(input.state),
    facts_table_sha256: sha(input.factsTable),
    budget: input.budget,
  };
}

/**
 * What one run produced, retained after the worker as the
 * `listing-facts-batch-outputs-<run id>` artifact: the SHA-256 of the facts
 * table it wrote and of its one-commit batch patch, and whether it was a dry
 * run. CI binds a batch's provenance to these outputs, not only to the inputs.
 */
export interface BatchOutputs {
  format: 1;
  run_id: string;
  dry_run: boolean;
  facts_table_sha256: string;
  batch_patch_sha256: string;
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function batchOutputs(input: {
  runId: string;
  dryRun: boolean;
  factsTable: Buffer;
  patch: Buffer;
}): BatchOutputs {
  return {
    format: 1,
    run_id: input.runId,
    dry_run: input.dryRun,
    facts_table_sha256: sha256(input.factsTable),
    batch_patch_sha256: sha256(input.patch),
  };
}
/**
 * Problems with a run's outputs record against the provenance and the facts
 * table under check (and the batch patch, where the caller holds it). A dry
 * run's outputs never back a batch: it pushes no branch and saves no state.
 */
export function outputsProblems(
  provenance: FactsProvenance,
  record: Buffer | undefined,
  factsTable: Buffer,
  patch?: Buffer,
): string[] {
  if (!record) return ["The run's outputs artifact holds no outputs.json."];
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.toString("utf8"));
  } catch {
    return ["The run's outputs.json is not JSON."];
  }
  if (
    !isRecord(parsed) ||
    parsed.format !== 1 ||
    typeof parsed.dry_run !== "boolean" ||
    typeof parsed.facts_table_sha256 !== "string" ||
    typeof parsed.batch_patch_sha256 !== "string"
  )
    return ["The run's outputs.json is malformed."];
  const problems: string[] = [];
  if (parsed.run_id !== provenance.workflow_run_id)
    problems.push("outputs.json names another run.");
  if (parsed.dry_run)
    problems.push(`Run ${provenance.workflow_run_id} was a dry run; a dry run backs no batch.`);
  if (parsed.facts_table_sha256 !== sha256(factsTable))
    problems.push("The facts table is not the one the named run produced.");
  if (patch && parsed.batch_patch_sha256 !== sha256(patch))
    problems.push("The batch patch is not the one the named run produced.");
  return problems;
}

/** A retained artifact's files, read from its ZIP within fixed bounds. */
export function artifactFiles(archive: Buffer, allowed: readonly string[]): Map<string, Buffer> {
  const parsed = inspectBoundedZip(
    archive,
    {
      compressedBytes: 64 * 1024 * 1024,
      expandedBytes: 128 * 1024 * 1024,
      files: allowed.length,
      nameBytes: 64,
      allowedPaths: new Set(allowed),
    },
    { deadline: Date.now() + 30_000 },
  );
  const files = new Map<string, Buffer>();
  for (const entry of parsed.entries) {
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.bytes) });
    if (bytes.length !== entry.bytes) throw new Error(`ZIP rejected: ${entry.name} size`);
    files.set(entry.name, bytes);
  }
  return files;
}
/** The retained inputs artifact's files. */
export const inputsArtifactFiles = (archive: Buffer) =>
  artifactFiles(archive, ["inputs.json", "observations.json", "state-before.json"]);

// ---------------------------------------------------------------------------
// Observations: the observer's retained handoff, as the worker's report.

/**
 * The listing observations of an observer handoff directory (one JSON file
 * per provider source, each with `descriptive_listing_candidates`), as a
 * worker report `{ listings }`. Files are read in name order; a listing seen
 * twice keeps its first observation. Bounded: at most 4,096 files and 64 MiB.
 */
export function handoffObservations(directory: string) {
  const listings: unknown[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "summary.json")
    .toSorted();
  if (files.length > 4096) throw new Error("The observer handoff holds too many files.");
  for (const name of files) {
    const file = path.join(directory, name);
    const size = statSync(file).size;
    bytes += size;
    if (bytes > 64 * 1024 * 1024) throw new Error("The observer handoff exceeds 64 MiB.");
    const report: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(report) || !Array.isArray(report.descriptive_listing_candidates)) continue;
    for (const candidate of report.descriptive_listing_candidates as unknown[]) {
      if (!isRecord(candidate) || typeof candidate.id !== "string" || seen.has(candidate.id))
        continue;
      seen.add(candidate.id);
      listings.push({ id: candidate.id, upstream_observation: candidate.upstream_observation });
    }
  }
  return { listings };
}

/** Reconfirmed facts older than this are refreshed by a batch even when nothing else changed. */
export const refreshAfterDays = 14;
/**
 * Whether a derived batch is worth a pull request (and a person's approval):
 * the enrollment changed, an entry appeared, disappeared or changed in
 * anything but a reconfirmation, or a committed eligible entry was last
 * confirmed more than `refreshAfterDays` before the new table's time, so
 * landing its reconfirmation keeps it inside the 30-day facts age. A run that
 * only moved `generated_at`, provenance and fresh reconfirmations is not.
 */
export function materialChange(
  baseline: unknown,
  current: ListingFactsTable,
  delta: { added: number; withdrawn: number; changed: number },
): boolean {
  if (delta.added + delta.withdrawn + delta.changed > 0) return true;
  const before = new Map(
    (isRecord(baseline) && Array.isArray(baseline.entries)
      ? (baseline.entries as ListingFactsEntry[])
      : []
    ).map((entry) => [entry.port_id, entry]),
  );
  if (before.size !== current.entries.length) return true;
  const now = Date.parse(current.generated_at);
  return current.entries.some((entry) => {
    const prior = before.get(entry.port_id);
    if (!prior || !sameExceptReconfirmation(prior, entry)) return true;
    return (
      prior.ineligible === null &&
      prior.observation.observed_at !== entry.observation.observed_at &&
      (now - Date.parse(prior.observation.observed_at)) / 86_400_000 > refreshAfterDays
    );
  });
}

/** Enrollment changes between two committed enrollment tables, by port_id. */
export function tableDelta(previous: unknown, current: unknown) {
  const rows = (table: unknown) =>
    new Map(
      (isRecord(table) && Array.isArray(table.enrollments) ? table.enrollments : []).flatMap(
        (row: unknown) =>
          isRecord(row) && typeof row.port_id === "string" ? [[row.port_id, digestOf(row)]] : [],
      ),
    );
  const before = rows(previous);
  const after = rows(current);
  return {
    added: [...after.keys()].filter((id) => !before.has(id)).length,
    withdrawn: [...before.keys()].filter((id) => !after.has(id)).length,
    changed: [...after].filter(([id, digest]) => before.has(id) && before.get(id) !== digest)
      .length,
  };
}

/** The pull request body of one batch: provenance, counts and the owner's one action. */
export function batchPullBody(input: {
  runUrl: string;
  provenance: FactsProvenance;
  delta: { added: number; withdrawn: number; changed: number };
  reproduced: number;
}) {
  return [
    "## Linked issue",
    "",
    "Refs #8569",
    "",
    "## Outcome and scope",
    "",
    `One unattended listing facts batch from ${input.runUrl}: ${input.delta.added} generated routes added, ${input.delta.withdrawn} withdrawn, ${input.delta.changed} changed. It changes only ${batchAllowlist.map((file) => `\`${file}\``).join(", ")}.`,
    "",
    "## Verification",
    "",
    `- Provenance: run ${input.provenance.workflow_run_id}, source ${input.provenance.source_commit}, CLI SHA-256 ${input.provenance.cli_sha256}, inputs SHA-256 ${input.provenance.inputs_sha256} (artifact \`${inputsArtifactPrefix}${input.provenance.workflow_run_id}\`).`,
    `- The job reproduced ${input.reproduced} eligible entries from their exact release bytes, kept the path allowlist and passed the generated registration gate; pull-request CI repeats all three on the exact head.`,
    "",
    "## Review and risk",
    "",
    "No title-specific review happens on this route; the documented rules, the gate and the reproduction are the review (docs/CATALOG.md, scheduled facts batch job).",
    "",
    "This pull request was opened with the workflow token, so GitHub creates its `pull_request` runs in an approval-required state: a person with write access starts them with **Approve workflows to run**, and that approval counts as a human intervention. Approval grants CI permission only; the next scheduled run separately confirms merge eligibility and merges it through the guarded delivery route only when all five required checks pass on its exact head; a failing check stops the job.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Stop and wait: conditions only a person clears.

export const stopConditionNames = [
  "gate-refused",
  "reproduction-refused",
  "path-allowlist",
  "required-check-failed",
  "no-progress",
  "backlog-growing",
  "large-withdrawal",
  "repository-identity-changed",
  "rule-version-changed",
  "observer-coverage-dropped",
  "drain-exceeds-facts-age",
  "batch-waiting",
  "worker-error",
] as const;
export type StopConditionName = (typeof stopConditionNames)[number];
export interface StopCondition {
  name: StopConditionName;
  detail: string;
}

/** One run's record in the job's history (kept in the worker cache). */
export interface RunRecord {
  run_id: string;
  at: string;
  observed: number;
  settled: number;
  no_progress: boolean;
  backlog_total: number;
  withdrawn: number;
  identity_changed: number;
  versions: string;
}
/** Consecutive no-progress runs before the job stops. */
export const noProgressRuns = 3;
/** Consecutive runs whose backlog grew before the job stops. */
export const backlogGrowthRuns = 4;
/** More withdrawals than this in one batch stop the job. */
export const largeWithdrawal = 16;
/** A coverage drop larger than this share of the previous run stops the job. */
export const coverageDropShare = 0.25;
/**
 * Facts older than this against the real clock raise the freshness alert. It
 * stays above `refreshAfterDays`, the longest a quiet catalog waits before a
 * reconfirmation batch, and below the 30-day facts age.
 */
export const freshnessAlertDays = 21;
/**
 * A batch pull request whose required checks have not all started or
 * finished after this many days stops the job: its runs most likely wait for
 * a person to approve them.
 */
export const batchWaitDays = 3;
/** The clock skew a recorded time may lead the real clock by. */
export const clockSkewMs = 10 * 60_000;

/** The parts of the worker's summary line the job reads. */
export interface WorkerSummary {
  no_progress: boolean;
  settled: number;
  backlog: {
    enrolled_pending: number;
    new_pending: number;
    held_for_batch: number;
    days_to_drain_all: number;
    runs_to_drain_enrolled: number;
    cadence_hours: number;
  };
  ineligible: Record<string, number>;
  identities: { port_id: string; outcome: string; reason?: string }[];
}

export function parseWorkerSummary(text: string): WorkerSummary {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.no_progress !== "boolean" ||
    !Number.isSafeInteger(value.settled) ||
    !isRecord(value.backlog) ||
    // The drain stop reads these; a summary without them must not read as 0 days.
    !Number.isSafeInteger(value.backlog.runs_to_drain_enrolled) ||
    !(Number(value.backlog.cadence_hours) > 0) ||
    !isRecord(value.ineligible) ||
    !Array.isArray(value.identities)
  )
    throw new Error("The worker summary is malformed.");
  return value as unknown as WorkerSummary;
}

/**
 * The stop conditions of one run, from its worker summary, its checks and the
 * history of earlier runs (newest last). Pure; the caller files one issue per
 * condition and appends the returned record to the history.
 */
export function stopConditions(input: {
  runId: string;
  now: string;
  summary: WorkerSummary | undefined;
  history: readonly RunRecord[];
  versions: string;
  gate: "ok" | "refused" | "skipped";
  paths: "ok" | "violated" | "skipped";
  reproduction: "ok" | "refused" | "skipped";
  delta?: { added: number; withdrawn: number; changed: number };
  details?: Partial<Record<StopConditionName, string>>;
}): { conditions: StopCondition[]; record: RunRecord | undefined } {
  const conditions: StopCondition[] = [];
  const add = (name: StopConditionName, detail: string) =>
    conditions.push({ name, detail: input.details?.[name] ?? detail });
  if (input.gate === "refused")
    add("gate-refused", "The generated registration gate refused this run's generation.");
  if (input.paths === "violated")
    add("path-allowlist", "The batch changed a path outside the generated-file allowlist.");
  if (input.reproduction === "refused")
    add("reproduction-refused", "CI could not reproduce an eligible entry from its exact bytes.");
  if (!input.summary) {
    add("worker-error", "The facts worker failed before writing its summary.");
    return { conditions, record: undefined };
  }
  const summary = input.summary;
  const backlog =
    summary.backlog.enrolled_pending + summary.backlog.new_pending + summary.backlog.held_for_batch;
  const identityChanged = summary.identities.filter(
    (row) => row.reason === "repository-identity-changed" && row.outcome === "ineligible",
  ).length;
  const record: RunRecord = {
    run_id: input.runId,
    at: input.now,
    observed: summary.identities.length,
    settled: summary.settled,
    no_progress: summary.no_progress,
    backlog_total: backlog,
    withdrawn: input.delta?.withdrawn ?? 0,
    identity_changed: identityChanged,
    versions: input.versions,
  };
  const runs = [...input.history, record];
  const last = (count: number) => runs.slice(-count);
  if (runs.length >= noProgressRuns && last(noProgressRuns).every((run) => run.no_progress))
    add(
      "no-progress",
      `${noProgressRuns} consecutive runs settled nothing while work waited (runs ${last(
        noProgressRuns,
      )
        .map((run) => run.run_id)
        .join(", ")}).`,
    );
  const growth = last(backlogGrowthRuns + 1);
  if (
    growth.length === backlogGrowthRuns + 1 &&
    growth.every(
      (run, index) => index === 0 || run.backlog_total > growth[index - 1]!.backlog_total,
    )
  )
    add(
      "backlog-growing",
      `The backlog grew for ${backlogGrowthRuns} consecutive runs: ${growth.map((run) => run.backlog_total).join(" → ")}.`,
    );
  if ((input.delta?.withdrawn ?? 0) > largeWithdrawal)
    add(
      "large-withdrawal",
      `This batch withdraws ${input.delta!.withdrawn} routes; more than ${largeWithdrawal} needs a person.`,
    );
  if (identityChanged > 0)
    add(
      "repository-identity-changed",
      `${identityChanged} listed repositories now resolve to another repository id.`,
    );
  const previous = input.history.at(-1);
  if (previous && previous.versions !== input.versions)
    add(
      "rule-version-changed",
      `The facts parser, generator, classifier or CLI changed (${previous.versions} → ${input.versions}); review one batch by hand.`,
    );
  if (
    previous &&
    previous.observed > 0 &&
    record.observed < previous.observed * (1 - coverageDropShare)
  )
    add(
      "observer-coverage-dropped",
      `The observer covered ${record.observed} identities, down from ${previous.observed}.`,
    );
  const drainDays = offeredDrainDays(summary);
  if (drainDays >= 30)
    add(
      "drain-exceeds-facts-age",
      `Refreshing the offered identities whose release changed takes about ${drainDays} days (${runsPerBatch} runs per batch at this cadence, before any wait for a person), not within the 30-day facts age.`,
    );
  return { conditions, record };
}

/**
 * Runs one landed batch costs: the deriving run that opens it and the run
 * that merges it (a run derives only while no batch is open).
 */
export const runsPerBatch = 2;
/**
 * Days until the offered identities whose release changed are refreshed and
 * landed: the worker's run count for them, times the runs each landed batch
 * costs, at the configured cadence. Waits for a person to approve a batch's runs come
 * on top; the freshness alert covers those.
 */
export function offeredDrainDays(summary: WorkerSummary) {
  const runs = summary.backlog.runs_to_drain_enrolled;
  const cadence = summary.backlog.cadence_hours;
  return Math.round(((runs * runsPerBatch * cadence) / 24) * 10) / 10;
}

/**
 * Whether the committed facts have fallen behind the real clock. A time ahead
 * of the clock by more than `clockSkewMs` is an alert, never a negative age:
 * facts age is measured from `generated_at`, so a future time would keep
 * routes offered past 30 days. An empty table alerts too, so a first batch
 * that never lands is visible.
 */
export function factsFallingBehind(table: ListingFactsTable, now: string): string | undefined {
  const clock = Date.parse(now);
  const generated = Date.parse(table.generated_at);
  const future = [
    ...(generated > clock + clockSkewMs ? [`generated_at ${table.generated_at}`] : []),
    ...table.entries
      .filter((entry) => Date.parse(entry.observation.observed_at) > clock + clockSkewMs)
      .slice(0, 5)
      .map((entry) => `${entry.port_id} observed_at ${entry.observation.observed_at}`),
  ];
  if (future.length)
    return `The committed facts record times ahead of the clock (${now}): ${future.join(", ")}. Facts age is measured from these times, so routes could stay offered past 30 days.`;
  const age = (clock - generated) / 86_400_000;
  if (age <= freshnessAlertDays) return undefined;
  if (!table.entries.length)
    return `No facts batch has landed since the empty facts table was written ${Math.floor(age)} days ago (${table.generated_at}); the first batch may be waiting for a person.`;
  return `The committed facts were generated ${Math.floor(age)} days ago (${table.generated_at}); generated routes keep their offer until 30 days, measured against that time, not the clock.`;
}

/**
 * Times a facts change records ahead of the clock: `generated_at` and every
 * added or changed `observed_at` may lead `now` by at most `clockSkewMs`.
 * Facts age is measured from these times, so a future time would extend an
 * offer. An unchanged table (a change that does not touch the facts) is not judged.
 */
export function clockProblems(
  baseline: unknown,
  current: ListingFactsTable,
  now: number,
): string[] {
  if (digestOf(isRecord(baseline) ? baseline : null) === digestOf(current)) return [];
  const limit = now + clockSkewMs;
  const problems: string[] = [];
  if (!(Date.parse(current.generated_at) <= limit))
    problems.push(`generated_at ${current.generated_at} is ahead of the clock.`);
  const before = new Map(
    (isRecord(baseline) && Array.isArray(baseline.entries)
      ? (baseline.entries as ListingFactsEntry[])
      : []
    ).map((entry) => [entry.port_id, entry.observation.observed_at]),
  );
  for (const entry of current.entries) {
    const observed = entry.observation.observed_at;
    if (before.get(entry.port_id) !== observed && !(Date.parse(observed) <= limit))
      problems.push(`${entry.port_id} observed_at ${observed} is ahead of the clock.`);
  }
  return problems;
}

/** The issue body for one condition: grouped reason, run and how to clear it. */
export function stopIssueBody(condition: StopCondition, runUrl: string) {
  return [
    `The unattended listing facts batch stopped: **${condition.name}**.`,
    "",
    condition.detail,
    "",
    `Run: ${runUrl}`,
    "",
    "The job does nothing while any issue titled `" +
      stopIssuePrefix +
      "…` is open. Investigate, repair or accept the cause, then close this issue to let the next scheduled run continue. A recurrence reopens this same issue.",
  ].join("\n");
}
/** The freshness alert body; the alert does not stop the job, whose next batch is the remedy. */
export function freshnessIssueBody(detail: string, runUrl: string) {
  return [
    "The unattended listing facts batch has not landed fresh facts recently.",
    "",
    detail,
    "",
    `Run: ${runUrl}`,
    "",
    "This alert does not stop the job. Merge or clear the waiting batch, or close a stop issue, so a batch lands; close this issue once facts are fresh. A recurrence reopens it.",
  ].join("\n");
}

/**
 * Upstream text (asset names, tags, errors) as inert Markdown code: no
 * mention, link or formatting reaches a public issue body.
 */
export const inertText = (text: string) =>
  `\`${text.replace(/[`\r\n]/gu, "'").replace(/@/gu, "@\u200b")}\``;

/** The refused entries a verify step recorded, as the reproduction stop's detail. */
export function reproductionDetails(file: string | undefined) {
  if (!file) return {};
  try {
    const lines: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(lines) || !lines.length) return {};
    return {
      "reproduction-refused": `CI could not reproduce these eligible entries from their exact bytes:\n${lines
        .map((line) => `- ${inertText(String(line).slice(0, 400))}`)
        .join("\n")}`,
    };
  } catch {
    return {};
  }
}

/** Add a failed batch pull request and failed jobs to a run's conditions. */
export function collectConditions(
  found: { conditions: StopCondition[]; freshness: string | null },
  input: {
    prState: string;
    prNumber: string;
    /** When the open batch pull request was opened, for `batch-waiting`. */
    prCreatedAt?: string;
    now?: string;
    jobs: Record<string, string>;
    /** An open stop issue holds the job: only the freshness alert is filed. */
    blocked?: boolean;
    /** The freshness of the committed facts, evaluated on every enabled run. */
    freshness?: string | null;
  },
) {
  const freshness = input.freshness !== undefined ? input.freshness : found.freshness;
  if (input.blocked) return { conditions: [] as StopCondition[], freshness };
  const conditions = [...found.conditions];
  if (input.prState === "failed")
    conditions.push({
      name: "required-check-failed",
      detail: `Batch pull request #${input.prNumber} failed a required check or is not a well-formed one-commit job batch.`,
    });
  const waited =
    (Date.parse(input.now ?? new Date().toISOString()) - Date.parse(input.prCreatedAt ?? "")) /
    86_400_000;
  if (["waiting-for-checks", "pending"].includes(input.prState) && waited > batchWaitDays)
    conditions.push({
      name: "batch-waiting",
      detail: `Batch pull request #${input.prNumber} has waited ${Math.floor(waited)} days for its required checks (state ${input.prState}). Its workflow runs most likely wait for **Approve workflows to run**; approve them or close the pull request, then close this issue.`,
    });
  for (const [job, result] of Object.entries(input.jobs))
    // A derive job that already named its conditions failed because of them.
    // A timed-out or cancelled job ends the same way: nothing silent.
    if (["failure", "cancelled"].includes(result) && !(job === "derive" && found.conditions.length))
      conditions.push({ name: "worker-error", detail: `The ${job} job ended ${result}.` });
  return { conditions, freshness };
}

/** The exact squash message of a batch merge: no closing keyword. */
export const mergeMessage = (number: number) => ({
  title: `chore(catalog): listing facts batch (#${number})`,
  body: "Unattended listing facts batch. Refs #8569",
});

// ---------------------------------------------------------------------------
// Owner queues: what still needs a person or a mechanism.

/** Counts per reason and the most frequent unread package forms, as Markdown. */
export function queueSummary(routeFit: unknown, top = 8): { markdown: string; counts: unknown } {
  const queues = isRecord(routeFit) ? routeFit.registration_queues : undefined;
  if (!isRecord(queues)) throw new Error("catalog-route-fit --json has no registration_queues.");
  const sizes = (group: unknown) =>
    isRecord(group)
      ? Object.entries(group)
          .map(([key, ids]) => [key, Array.isArray(ids) ? ids.length : 0] as const)
          .filter(([, count]) => count > 0)
          .toSorted((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
      : [];
  const reasons = sizes(queues.reasons);
  const forms = sizes(queues.unread_forms).slice(0, top);
  const exclusions = sizes(queues.exclusions).slice(0, top);
  const refusals = sizes(queues.refusals);
  const table = (title: string, rows: readonly (readonly [string, number])[]) =>
    rows.length
      ? [
          `### ${title}`,
          "",
          "| Queue | Identities |",
          "| --- | ---: |",
          ...rows.map(([key, count]) => `| \`${key}\` | ${count} |`),
          "",
        ]
      : [`### ${title}`, "", "None.", ""];
  return {
    markdown: [
      "## Registration exception queues",
      "",
      "Complete identity lists are in the `registration-queues` artifact (`catalog-route-fit.mts --json`).",
      "",
      ...table("Blocked reasons", reasons),
      ...table("Top unread package forms", forms),
      ...table("Top name vetoes", exclusions),
      ...table("Refused archives by class", refusals),
    ].join("\n"),
    counts: {
      reasons: Object.fromEntries(reasons),
      unread_forms: Object.fromEntries(sizes(queues.unread_forms)),
      exclusions: Object.fromEntries(sizes(queues.exclusions)),
      refusals: Object.fromEntries(refusals),
    },
  };
}

// ---------------------------------------------------------------------------
// The open batch pull request and its exact-head checks.

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
}
export type BatchPullState =
  | { state: "none" }
  | { state: "waiting-for-checks"; missing: string[] }
  | { state: "pending"; pending: string[] }
  | { state: "failed"; failed: string[] }
  | { state: "green" };

/** The required-check state of a batch head: the newest run of each required context decides. */
export function requiredCheckState(runs: readonly CheckRun[]): BatchPullState {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const prior = latest.get(run.name);
    if (!prior || String(run.started_at ?? "") >= String(prior.started_at ?? ""))
      latest.set(run.name, run);
  }
  const missing = requiredContexts.filter((name) => !latest.has(name));
  const failed = requiredContexts.filter((name) => {
    const run = latest.get(name);
    return run?.status === "completed" && run.conclusion !== "success";
  });
  if (failed.length) return { state: "failed", failed };
  if (missing.length === requiredContexts.length) return { state: "waiting-for-checks", missing };
  const pending = requiredContexts.filter((name) => latest.get(name)?.status !== "completed");
  if (pending.length) return { state: "pending", pending };
  return { state: "green" };
}

/**
 * The CI workflow run the guarded merge binds to: the newest successful,
 * completed `pull_request` run of `.github/workflows/ci.yml` on exactly this
 * head (highest id, then attempt). The merge then requires every required
 * context to be a successful job of that run attempt, not merely a passing
 * check of the same name.
 */
export function ciRunFor(
  runs: readonly unknown[],
  head: string,
): { id: number; attempt: number } | undefined {
  const matching = runs.flatMap((run) =>
    isRecord(run) &&
    Number.isSafeInteger(run.id) &&
    Number.isSafeInteger(run.run_attempt) &&
    Number(run.run_attempt) > 0 &&
    run.head_sha === head &&
    run.path === ".github/workflows/ci.yml" &&
    run.event === "pull_request" &&
    run.status === "completed" &&
    run.conclusion === "success"
      ? [{ id: Number(run.id), attempt: Number(run.run_attempt) }]
      : [],
  );
  return matching.toSorted((left, right) => right.id - left.id || right.attempt - left.attempt)[0];
}

/**
 * The open pull requests the job itself opened: a batch branch in this
 * repository, opened by the workflow token. A fork or a person using a
 * batch-like branch name is not a batch and cannot hold or stop the job.
 */
export function jobBatches(pulls: readonly unknown[], repository: string) {
  return pulls.filter(
    (pull): pull is Record<string, unknown> =>
      isRecord(pull) &&
      isRecord(pull.head) &&
      isRecord(pull.head.repo) &&
      isRecord(pull.user) &&
      String(pull.head.ref).startsWith(batchBranchPrefix) &&
      pull.head.repo.full_name === repository &&
      pull.user.login === workflowLogin,
  );
}

/** Problems with an open pull request that claims to be a batch, before any merge. */
export function batchPullProblems(pull: {
  head_ref: string;
  author: string;
  base_ref: string;
  commits: number;
  draft: boolean;
}): string[] {
  const problems: string[] = [];
  if (!/^automation\/listing-facts-batch-[1-9][0-9]{0,19}$/u.test(pull.head_ref))
    problems.push(`${pull.head_ref} is not a batch branch.`);
  if (pull.author !== "github-actions[bot]")
    problems.push(`The pull request was opened by ${pull.author}, not by the job.`);
  if (pull.base_ref !== "main") problems.push("The pull request does not target main.");
  if (pull.commits !== 1) problems.push(`The batch has ${pull.commits} commits, not exactly one.`);
  if (pull.draft) problems.push("The batch pull request is a draft.");
  return problems;
}

// ---------------------------------------------------------------------------
// I/O shell.

const git: GitRunner = (args) => {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : undefined;
};

function options(argv: string[]) {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--"))
      throw new Error(`Expected --name value pairs, got ${name ?? "nothing"}.`);
    values[name.slice(2)] = value;
  }
  return values;
}

/** The baseline facts table: `--base REV` when given, else the gate's baseline. */
function baselineFacts(base: string | undefined): unknown {
  if (base === undefined) return readGateBaseline(process.env, git, factsTablePath);
  const listed = git(["ls-tree", "--name-only", base, "--", factsTablePath]);
  if (listed === undefined) throw new Error(`Cannot read revision ${base}.`);
  if (!listed.trim()) return null;
  return JSON.parse(git(["show", `${base}:${factsTablePath}`]) ?? "null") as unknown;
}
function baselineRevision(base: string | undefined) {
  if (base) return base;
  const revision = gateBaselineRevision(process.env, git);
  if (!revision) throw new Error("The batch checks need the baseline history (fetch-depth 2).");
  return revision;
}

/** A checkout file as text, or undefined when it does not exist. */
const readCheckout = (file: string) => {
  const absolute = path.join(root, file);
  return existsSync(absolute) && statSync(absolute).isFile()
    ? readFileSync(absolute, "utf8")
    : undefined;
};

/** The checker-separation refusal for the committed range `base..HEAD`, if any. */
function checkerSeparation(base: string): string | undefined {
  const changed = changedPaths(git, base, "HEAD");
  if (!changed) return "git could not list the changed paths; refusing.";
  return checkerSeparationProblem(changed, checkerPaths(readCheckout));
}

function currentFacts(): ListingFactsTable {
  const table = parseCatalogSource(readFileSync(path.join(root, factsTablePath), "utf8"));
  checkListingFactsTable(table);
  return table;
}

function output(name: string, value: string) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
function summary(markdown: string) {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

const repository = () => {
  const value = process.env.GITHUB_REPOSITORY;
  if (!value || !/^[\w.-]+\/[\w.-]+$/u.test(value))
    throw new Error("GITHUB_REPOSITORY is required.");
  return value;
};
const token = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;

async function githubWrite(method: string, route: string, body: unknown) {
  const response = await fetch(`https://api.github.com/repos/${repository()}${route}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": apiVersion,
      "user-agent": "portcove-listing-facts-batch",
      "content-type": "application/json",
      authorization: `Bearer ${token() ?? ""}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}.`);
  return await response.json();
}

/** The login the built-in workflow token acts as. */
export const workflowLogin = "github-actions[bot]";
/**
 * Issues the workflow token opened in one state, most recently updated
 * first, at most 1,000. A list the API refuses fails the run: an unknown
 * stop state is never read as "not stopped".
 */
async function jobIssues(state: "open" | "closed") {
  const issues: { number: number; title: string; state: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await githubJson(
      `https://api.github.com/repos/${repository()}/issues?state=${state}&creator=${encodeURIComponent(workflowLogin)}&sort=updated&direction=desc&per_page=100&page=${page}`,
      token(),
    );
    if (!Array.isArray(batch)) throw new Error("The issue list is malformed.");
    for (const issue of batch)
      if (
        isRecord(issue) &&
        !isRecord(issue.pull_request) &&
        Number.isSafeInteger(issue.number) &&
        typeof issue.title === "string" &&
        typeof issue.state === "string"
      )
        issues.push({ number: Number(issue.number), title: issue.title, state: issue.state });
    if (batch.length < 100) return issues;
  }
  // Never read a truncated open list as "not stopped". The closed list only
  // finds an issue to reopen; when it is truncated (closed issues and pull
  // requests only grow), a recurrence opens a new issue instead.
  if (state === "closed") return issues;
  throw new Error(`More than 1,000 open workflow issues; the stop state is unknown.`);
}

/** File one issue per condition: comment on an open one, reopen a closed one, else open one. */
async function fileIssues(issues: readonly { title: string; body: string }[]) {
  if (!issues.length) return;
  const existing = [...(await jobIssues("open")), ...(await jobIssues("closed"))];
  for (const { title, body } of issues) {
    const issue = existing.find((candidate) => candidate.title === title);
    if (!issue) await githubWrite("POST", "/issues", { title, body });
    // An open issue already says it; only a recurrence after it was closed
    // reopens and comments, so a waiting stop never repeats itself each run.
    else if (issue.state !== "open") {
      await githubWrite("PATCH", `/issues/${issue.number}`, { state: "open" });
      await githubWrite("POST", `/issues/${issue.number}/comments`, { body });
    }
  }
}

async function main(argv: string[]): Promise<string> {
  const [command, ...rest] = argv;
  const option = options(rest);
  switch (command) {
    case "plan": {
      // Which pull-request checks a facts change needs; read-only and offline.
      // Required checks gate pull requests and merge groups; a push to main
      // was verified on its pull request at the exact head, so it re-reads
      // no upstream bytes that may since have moved.
      const event = process.env.GITHUB_EVENT_NAME;
      if (event && !["pull_request", "merge_group"].includes(event) && option.base === undefined) {
        output("reproduce", "false");
        output("batch", "false");
        return `Listing facts are verified on pull requests; ${event} runs skip reproduction.\n`;
      }
      const current = currentFacts();
      const baseline = baselineFacts(option.base);
      // The facts table and the code that checks it are separate changes.
      const separation = checkerSeparation(baselineRevision(option.base));
      if (separation) throw new Error(separation);
      const plan = reproductionPlan(baseline, current);
      const batch = claimsBatch(baseline, current, process.env.GITHUB_HEAD_REF);
      const changed = digestOf(isRecord(baseline) ? baseline : null) !== digestOf(current);
      output("reproduce", String(plan.entries.length > 0));
      output("batch", String(batch));
      return `${JSON.stringify({ facts_changed: changed, batch, reproduce: plan.entries.length, bytes: plan.bytes })}\n`;
    }
    case "paths": {
      // Working tree against --base, or the committed range --base..--head.
      const base = baselineRevision(option.base);
      const changed = changedEntries(git, base, option.head);
      const problems = allowlistProblems(changed);
      if (problems.length) throw new Error(problems.join("\n"));
      return `Batch paths are within the allowlist (${changed!.length} changed).\n`;
    }
    case "verify": {
      // Every facts-table change: reproduce eligible entries; a change that
      // claims to be a batch also keeps the path allowlist and provenance.
      const current = currentFacts();
      const base = baselineRevision(option.base);
      const baseline = baselineFacts(base);
      const problems: string[] = [];
      const separation = checkerSeparation(base);
      if (separation) problems.push(separation);
      problems.push(...clockProblems(baseline, current, Date.now()));
      const headRef = process.env.GITHUB_HEAD_REF || undefined;
      if (claimsBatch(baseline, current, headRef)) {
        // The committed range only: files a CI step leaves behind are not
        // part of the change (the job checks its working tree with `paths`).
        problems.push(...allowlistProblems(changedEntries(git, base, "HEAD")));
        // Only the facts table is an input: every other allowed path must be
        // the byte-for-byte output catalog generation writes from it.
        problems.push(...canonicalDerivativeProblems());
        // The job verifies its own fresh batch before any pull request or
        // inputs artifact exists; pull-request CI checks the run it names.
        if (option["own-run"] !== "true")
          problems.push(...(await verifyProvenance(current, headRef)));
      }
      const plan = reproductionPlan(baseline, current);
      if (plan.entries.length) {
        if (!option.cli) throw new Error("verify needs --cli to reproduce facts.");
        const work = await mkdtemp(path.join(os.tmpdir(), "listing-facts-reproduce-"));
        try {
          const cli = path.resolve(option.cli);
          // One deadline for the whole reproduction: every download and Core
          // run is cut at it, and the entry is refused as over-budget.
          const deadline = Date.now() + reproductionBudget.maxMilliseconds;
          const result = await reproduceFacts({
            entries: plan.entries,
            readRelease: githubReleaseReader(token()),
            listReleases: githubReleaseLister(token()),
            inspect: cliInspector(cli, work, { deadline }),
            classify: cliClassifier(cli, work, { deadline }),
            boundLines: boundLinesOf(
              readCatalogSource(path.join(root, "crates/portcove-core/catalog")).authored,
            ),
            deadline,
          });
          summary(
            `Reproduced ${result.verified.length} of ${plan.entries.length} changed eligible facts entries (${result.bytes} bytes).`,
          );
          for (const refusal of result.refused)
            problems.push(`${refusal.port_id}: ${refusal.reason}: ${refusal.detail}`);
          // The stop issue names the refused entries (at most five).
          if (option.refusals)
            writeFileSync(
              option.refusals,
              `${JSON.stringify(result.refused.slice(0, 5).map((r) => `${r.port_id}: ${r.reason}: ${r.detail}`))}\n`,
            );
        } finally {
          await rm(work, { recursive: true, force: true });
        }
      }
      output("reproduced", String(plan.entries.length));
      if (problems.length)
        throw new Error(`Listing facts change refused:\n- ${problems.join("\n- ")}`);
      return `Listing facts change verified: ${plan.entries.length} eligible entries reproduced.\n`;
    }
    case "observations": {
      if (!option.handoff || !option.output)
        throw new Error("observations needs --handoff and --output.");
      const report = handoffObservations(option.handoff);
      writeFileSync(option.output, `${JSON.stringify(report)}\n`);
      output("observed", String(report.listings.length));
      return `${report.listings.length} listing observations.\n`;
    }
    case "inputs": {
      for (const name of [
        "observations",
        "state",
        "observer-run",
        "source-commit",
        "run-id",
        "output",
      ])
        if (!option[name]) throw new Error(`inputs needs --${name}.`);
      const read = (file: string) => {
        try {
          return readFileSync(file);
        } catch {
          return Buffer.from("");
        }
      };
      const inputs = batchInputs({
        runId: option["run-id"]!,
        sourceCommit: option["source-commit"]!,
        observerRunId: option["observer-run"]!,
        observations: read(option.observations!),
        state: read(option.state!),
        factsTable: read(path.join(root, factsTablePath)),
        budget: { ...reproductionBudget },
      });
      const bytes = Buffer.from(`${JSON.stringify(inputs, null, 2)}\n`);
      writeFileSync(option.output!, bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      output("inputs_sha256", digest);
      return `${digest}\n`;
    }
    case "outputs": {
      // The run's outputs record, written after the batch commit exists.
      for (const name of ["run-id", "dry-run", "patch", "output"])
        if (!option[name]) throw new Error(`outputs needs --${name}.`);
      const record = batchOutputs({
        runId: option["run-id"]!,
        dryRun: option["dry-run"] === "true",
        factsTable: readFileSync(path.join(root, factsTablePath)),
        patch: readFileSync(option.patch!),
      });
      mkdirSync(path.dirname(option.output!), { recursive: true });
      writeFileSync(option.output!, `${JSON.stringify(record, null, 2)}\n`);
      return `${JSON.stringify(record)}\n`;
    }
    case "outputs-check": {
      // The deliver job: the applied patch and facts table are this run's.
      if (!option.record || !option.patch)
        throw new Error("outputs-check needs --record and --patch.");
      const current = currentFacts();
      if (!current.provenance) throw new Error("A batch must record its provenance.");
      const problems = outputsProblems(
        current.provenance,
        readFileSync(option.record),
        readFileSync(path.join(root, factsTablePath)),
        readFileSync(option.patch),
      );
      if (problems.length) throw new Error(problems.join("\n"));
      return "The batch is the one this run recorded.\n";
    }
    case "assess": {
      if (!option.history || !option["run-id"])
        throw new Error("assess needs --history and --run-id.");
      let history: RunRecord[] = [];
      try {
        const parsed: unknown = JSON.parse(readFileSync(option.history, "utf8"));
        if (Array.isArray(parsed)) history = parsed as RunRecord[];
      } catch {
        history = [];
      }
      let workerSummary: WorkerSummary | undefined;
      try {
        workerSummary = option["worker-report"]
          ? parseWorkerSummary(readFileSync(option["worker-report"], "utf8"))
          : undefined;
      } catch {
        workerSummary = undefined;
      }
      const delta = option.delta
        ? (JSON.parse(readFileSync(option.delta, "utf8")) as {
            added: number;
            withdrawn: number;
            changed: number;
          })
        : undefined;
      const { conditions, record } = stopConditions({
        runId: option["run-id"],
        now: option.now ?? new Date().toISOString(),
        summary: workerSummary,
        history,
        versions: option.versions ?? "unknown",
        gate: (option.gate as "ok" | "refused" | "skipped") ?? "skipped",
        paths: (option.paths as "ok" | "violated" | "skipped") ?? "skipped",
        reproduction: (option.reproduction as "ok" | "refused" | "skipped") ?? "skipped",
        ...(delta ? { delta } : {}),
        details: reproductionDetails(option.refusals),
      });
      if (record)
        writeFileSync(option.history, `${JSON.stringify([...history, record].slice(-30))}\n`);
      const facts = currentFacts();
      const behind = factsFallingBehind(facts, option.now ?? new Date().toISOString());
      if (option.output)
        writeFileSync(
          option.output,
          `${JSON.stringify({ conditions, freshness: behind ?? null })}\n`,
        );
      output("stop", String(conditions.length > 0));
      summary(
        conditions.length
          ? `### Stop conditions\n\n${conditions.map((c) => `- **${c.name}**: ${c.detail}`).join("\n")}`
          : "No stop condition.",
      );
      return `${JSON.stringify({ conditions, freshness: behind ?? null })}\n`;
    }
    case "issues": {
      if (!option.conditions || !option["run-url"])
        throw new Error("issues needs --conditions and --run-url.");
      const parsed = JSON.parse(readFileSync(option.conditions, "utf8")) as {
        conditions: StopCondition[];
        freshness: string | null;
      };
      const known = parsed.conditions.filter((condition) =>
        (stopConditionNames as readonly string[]).includes(condition.name),
      );
      await fileIssues([
        ...known.map((condition) => ({
          title: `${stopIssuePrefix}${condition.name}`,
          body: stopIssueBody(condition, option["run-url"]!),
        })),
        ...(parsed.freshness
          ? [
              {
                title: freshnessIssueTitle,
                body: freshnessIssueBody(parsed.freshness, option["run-url"]),
              },
            ]
          : []),
      ]);
      return `Filed ${known.length} stop condition(s).\n`;
    }
    case "blocked": {
      // An open stop issue holds every further run until a person closes it.
      const open = (await jobIssues("open")).filter((issue) =>
        issue.title.startsWith(stopIssuePrefix),
      );
      output("blocked", String(open.length > 0));
      if (open.length)
        summary(
          `Stopped until a person closes: ${open.map((issue) => `#${issue.number}`).join(", ")}.`,
        );
      return `${JSON.stringify(open)}\n`;
    }
    case "pull-request": {
      // The one open batch pull request and its exact-head required checks.
      const pulls: unknown[] = [];
      for (let page = 1; page <= 10; page++) {
        const list = await githubJson(
          `https://api.github.com/repos/${repository()}/pulls?state=open&base=main&per_page=100&page=${page}`,
          token(),
        );
        if (!Array.isArray(list)) throw new Error("The pull request list is malformed.");
        pulls.push(...(list as unknown[]));
        if (list.length < 100) break;
        if (page === 10)
          throw new Error("More than 1,000 open pull requests; the batch state is unknown.");
      }
      const batches = jobBatches(pulls, repository());
      if (batches.length === 0) {
        output("state", "none");
        return `${JSON.stringify({ state: "none" })}\n`;
      }
      if (batches.length > 1)
        throw new Error(`${batches.length} batch pull requests are open; one at a time.`);
      const pull = batches[0]!;
      const number = Number(pull.number);
      const detail = await githubJson(
        `https://api.github.com/repos/${repository()}/pulls/${number}`,
        token(),
      );
      if (
        !isRecord(detail) ||
        !isRecord(detail.head) ||
        !isRecord(detail.base) ||
        !isRecord(detail.user)
      )
        throw new Error("The pull request record is malformed.");
      const head = String(detail.head.sha);
      const problems = batchPullProblems({
        head_ref: String(detail.head.ref),
        author: String(detail.user.login),
        base_ref: String(detail.base.ref),
        commits: Number(detail.commits),
        draft: detail.draft === true,
      });
      // Each required context by name, so other check runs cannot crowd it out.
      const runs: CheckRun[] = [];
      for (const context of requiredContexts) {
        const checks = await githubJson(
          `https://api.github.com/repos/${repository()}/commits/${head}/check-runs?check_name=${encodeURIComponent(context)}&per_page=100`,
          token(),
        );
        if (!isRecord(checks) || !Array.isArray(checks.check_runs))
          throw new Error("The check run list is malformed.");
        runs.push(...(checks.check_runs as CheckRun[]));
      }
      let state: BatchPullState = problems.length
        ? { state: "failed", failed: problems }
        : requiredCheckState(runs);
      // The merge binds to the CI workflow run whose jobs are the contexts.
      let ci: { id: number; attempt: number } | undefined;
      if (state.state === "green") {
        const list = await githubJson(
          `https://api.github.com/repos/${repository()}/actions/workflows/ci.yml/runs?head_sha=${head}&event=pull_request&status=completed&per_page=100`,
          token(),
        );
        ci = ciRunFor(
          isRecord(list) && Array.isArray(list.workflow_runs) ? list.workflow_runs : [],
          head,
        );
        if (!ci) state = { state: "pending", pending: ["CI workflow run"] };
      }
      output("state", state.state);
      output("created_at", typeof detail.created_at === "string" ? detail.created_at : "");
      output("ci_run", ci ? String(ci.id) : "");
      output("ci_attempt", ci ? String(ci.attempt) : "");
      output("number", String(number));
      output("head", head);
      output("head_ref", String(detail.head.ref));
      return `${JSON.stringify({ number, head, ...state })}\n`;
    }
    case "delta": {
      const base = baselineRevision(option.base);
      const before = git(["show", `${base}:${enrollmentTablePath}`]);
      const delta = tableDelta(
        before ? (JSON.parse(before) as unknown) : null,
        JSON.parse(readFileSync(path.join(root, enrollmentTablePath), "utf8")),
      );
      if (option.output) writeFileSync(option.output, `${JSON.stringify(delta)}\n`);
      output("changed", String(delta.added + delta.withdrawn + delta.changed > 0));
      output("material", String(materialChange(baselineFacts(base), currentFacts(), delta)));
      return `${JSON.stringify(delta)}\n`;
    }
    case "observer-run": {
      // The newest main observer run that retained a catalog handoff.
      const runs = await githubJson(
        `https://api.github.com/repos/${repository()}/actions/workflows/configured-upstream-observer.yml/runs?branch=main&status=completed&per_page=20`,
        token(),
      );
      const list = isRecord(runs) && Array.isArray(runs.workflow_runs) ? runs.workflow_runs : [];
      for (const run of list as unknown[]) {
        if (!isRecord(run) || !Number.isSafeInteger(run.id) || run.head_branch !== "main") continue;
        const artifacts = await githubJson(
          `https://api.github.com/repos/${repository()}/actions/runs/${Number(run.id)}/artifacts?per_page=100`,
          token(),
        );
        const handoff = (
          isRecord(artifacts) && Array.isArray(artifacts.artifacts) ? artifacts.artifacts : []
        ).find(
          (artifact: unknown) =>
            isRecord(artifact) &&
            typeof artifact.name === "string" &&
            artifact.name.startsWith(`catalog-upstream-observations-${Number(run.id)}-`) &&
            artifact.expired !== true,
        ) as Record<string, unknown> | undefined;
        if (handoff) {
          output("run_id", String(run.id));
          output("artifact", String(handoff.name));
          return `${JSON.stringify({ run_id: run.id, artifact: handoff.name })}\n`;
        }
      }
      throw new Error("No recent main observer run retained a catalog observation handoff.");
    }
    case "open-pull-request": {
      for (const name of ["branch", "run-url", "delta", "reproduced"])
        if (!option[name]) throw new Error(`open-pull-request needs --${name}.`);
      const current = currentFacts();
      if (!current.provenance) throw new Error("A batch must record its provenance.");
      if (option.branch !== `${batchBranchPrefix}${current.provenance.workflow_run_id}`)
        throw new Error("The branch is not this run's batch branch.");
      const delta = JSON.parse(readFileSync(option.delta!, "utf8")) as {
        added: number;
        withdrawn: number;
        changed: number;
      };
      const created = await githubWrite("POST", "/pulls", {
        title: `chore(catalog): listing facts batch ${current.provenance.workflow_run_id}`,
        head: option.branch,
        base: "main",
        draft: false,
        body: batchPullBody({
          runUrl: option["run-url"]!,
          provenance: current.provenance,
          delta,
          reproduced: Number(option.reproduced),
        }),
      });
      const number = isRecord(created) ? Number(created.number) : NaN;
      output("number", String(number));
      summary(`Opened batch pull request #${number}.`);
      return `${number}\n`;
    }
    case "versions": {
      // The rule versions a batch depends on; a change stops for one reviewed batch.
      if (!option.cli) throw new Error("versions needs --cli.");
      const work = await mkdtemp(path.join(os.tmpdir(), "listing-facts-versions-"));
      try {
        const probe = await cliClassifier(
          path.resolve(option.cli),
          work,
        )({
          releases: [],
          assets: ["Game-v1.0-windows-x64.zip"],
          programs: [],
        });
        return `facts-${FACTS_PARSER_VERSION}/generator-${GENERATOR_VERSION}/filename-rule-${probe.filename_rule_version}\n`;
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
    case "merge-intent": {
      // The guarded merge's closure intent (closes nothing) and exact message.
      if (!option.number || !option.closure || !option.message)
        throw new Error("merge-intent needs --number, --closure and --message.");
      if (!/^[1-9][0-9]{0,9}$/u.test(option.number))
        throw new Error("--number must be a pull request number.");
      writeFileSync(
        option.closure,
        `${JSON.stringify({ format_version: 1, allowed_targets: [] })}\n`,
      );
      writeFileSync(option.message, `${JSON.stringify(mergeMessage(Number(option.number)))}\n`);
      return "Merge intent written.\n";
    }
    case "collect": {
      // The notify job's final condition list: the derive job's conditions
      // plus a failed batch pull request and failed jobs.
      if (!option.conditions) throw new Error("collect needs --conditions.");
      let found: { conditions: StopCondition[]; freshness: string | null } = {
        conditions: [],
        freshness: null,
      };
      try {
        found = JSON.parse(readFileSync(option.conditions, "utf8")) as typeof found;
      } catch {
        mkdirSync(path.dirname(option.conditions), { recursive: true });
      }
      const collected = collectConditions(found, {
        blocked: option.blocked === "true",
        freshness: factsFallingBehind(currentFacts(), new Date().toISOString()) ?? null,
        prState: option["pr-state"] ?? "none",
        prNumber: option["pr-number"] ?? "none",
        ...(option["pr-created-at"] ? { prCreatedAt: option["pr-created-at"] } : {}),
        jobs: {
          gate: option.gate ?? "",
          derive: option.derive ?? "",
          merge: option.merge ?? "",
          deliver: option.deliver ?? "",
        },
      });
      writeFileSync(option.conditions, `${JSON.stringify(collected)}\n`);
      return `${collected.conditions.length} condition(s).\n`;
    }
    case "queues": {
      if (!option["route-fit"]) throw new Error("queues needs --route-fit.");
      const { markdown, counts } = queueSummary(
        JSON.parse(readFileSync(option["route-fit"], "utf8")),
      );
      summary(markdown);
      if (option.output) writeFileSync(option.output, `${JSON.stringify(counts, null, 2)}\n`);
      return `${markdown}\n`;
    }
    default:
      throw new Error(
        `Unknown command ${command ?? "(none)"}; see the header of scripts/listing-facts-batch.mts.`,
      );
  }
}

/** Provenance of a facts table that claims to be a batch, against its run and inputs artifact. */
async function verifyProvenance(current: ListingFactsTable, headRef: string | undefined) {
  const provenance = current.provenance;
  if (!provenance) return ["A batch must record its provenance."];
  let run: WorkflowRunRecord | undefined;
  try {
    const value = await githubJson(
      `https://api.github.com/repos/${repository()}/actions/runs/${provenance.workflow_run_id}`,
      token(),
    );
    if (isRecord(value) && isRecord(value.repository))
      run = {
        id: Number(value.id),
        path: String(value.path),
        head_branch: typeof value.head_branch === "string" ? value.head_branch : null,
        head_sha: String(value.head_sha),
        event: String(value.event),
        repository: String(value.repository.full_name),
      };
  } catch {
    run = undefined;
  }
  const problems = provenanceProblems(provenance, run, { repository: repository(), headRef });
  if (problems.length) return problems;
  try {
    const files = await runArtifact(
      provenance.workflow_run_id,
      `${inputsArtifactPrefix}${provenance.workflow_run_id}`,
      ["inputs.json", "observations.json", "state-before.json"],
    );
    if (typeof files === "string") return [files];
    const inputs = inputsProblems(provenance, files);
    if (inputs.length) return inputs;
  } catch (error) {
    return [
      `The run's inputs could not be verified: ${error instanceof Error ? error.message : "unknown error"}`,
    ];
  }
  // Bound to the outputs: the facts table must be the one the named run
  // produced, and that run must not have been a dry run.
  try {
    const record = await runArtifact(
      provenance.workflow_run_id,
      `${outputsArtifactPrefix}${provenance.workflow_run_id}`,
      ["outputs.json"],
    );
    if (typeof record === "string") return [record];
    return outputsProblems(
      provenance,
      record.get("outputs.json"),
      readFileSync(path.join(root, factsTablePath)),
    );
  } catch (error) {
    return [
      `The run's outputs could not be verified: ${error instanceof Error ? error.message : "unknown error"}`,
    ];
  }
}

/** One named artifact of a run, as its files, or a problem string when it cannot be read. */
async function runArtifact(
  runId: string,
  name: string,
  allowed: readonly string[],
): Promise<Map<string, Buffer> | string> {
  const list = await githubJson(
    `https://api.github.com/repos/${repository()}/actions/runs/${runId}/artifacts?name=${name}`,
    token(),
  );
  const artifact =
    isRecord(list) && Array.isArray(list.artifacts) ? (list.artifacts[0] as unknown) : undefined;
  if (
    !isRecord(artifact) ||
    typeof artifact.archive_download_url !== "string" ||
    artifact.expired === true
  )
    return `The run's ${name} artifact is missing or expired.`;
  const response = await fetch(artifact.archive_download_url, {
    headers: {
      authorization: `Bearer ${token() ?? ""}`,
      "user-agent": "portcove-listing-facts-batch",
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) return `The run's ${name} artifact answered ${response.status}.`;
  return artifactFiles(Buffer.from(await response.arrayBuffer()), allowed);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (text) => process.stdout.write(text),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
