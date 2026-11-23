// Unattended listing facts batch (#8569): the checks and decisions of the
// scheduled job `.github/workflows/listing-facts-batch.yml` and of the
// pull-request side that holds every facts-table change to the same rules.
//
// The job runs the facts worker (`scripts/listing-package-facts.mts`) over
// the whole candidate set, sharded across a job matrix, regenerates the
// catalog and proposes one batch: every entry that needs no reproduction, and
// at most half an hour's reproduction share of those that do (`carryOver`:
// the job and the batch's CI each reproduce them, possibly in one hour); the
// rest is carried to the next batch, never dropped. Nothing here is a
// second status or backlog authority: the facts table, the enrollment table
// and `catalog-route-fit.mts --json` stay the record; the job keeps only the
// worker state and a short run history in its cache.
//
// Rules this file owns, each fail-closed:
//  - Path allowlist: a batch changes only the facts table and the outputs
//    `scripts/generate-catalog.mts` rewrites from it (`batchAllowlist`), each
//    a regular non-executable file (`modeViolations`).
//  - Checker separation: one change may not edit the facts table and the
//    code that checks it (`checkerSeparationProblem`), unless the table is
//    empty on both sides. This catches accidents; a deliberate change to
//    both is held only by review.
//  - Reproduction: every eligible entry a change adds or changes is re-read
//    from its exact digest-bound release asset and re-inspected by Core; its
//    players and facts must be byte-equal, and its release must still be the
//    newest stable one. An oversized, unavailable or changed asset is
//    refused, never trusted (`reproduceFacts`); so is a time ahead of the
//    clock (`clockProblems`). An archive byte-identical to the baseline's is
//    re-checked by its provider metadata only (`reusedArchives`). The scope
//    and bindings come from the base's authored catalog, and a change that
//    edits facts together with authored sources reproduces nothing
//    (`authoredSourceProblem`). Network, provider, rate-limit and runner-disk
//    failures are transient, never a verdict (`transientReasons`).
//  - Quota: GitHub calls honour the stated quota and GitHub's retry guidance
//    inside the step's deadline (`githubRequest`); reproduction plans half of
//    the hourly GITHUB_TOKEN quota (`reproductionHourlyRequests`), and one
//    batch lands only what fits it twice, once for the job's reproduction and
//    once for its pull request's CI (`reproductionBatchEntries`, `carryOver`).
//  - Capacity: a batch past a released-reader bound is never proposed
//    (`batchCapacity`).
//  - Provenance: a batch names the workflow run, source commit and inputs
//    digest it came from; CI checks them against that run, its retained
//    inputs and its outputs record (`provenanceProblems`, `inputsProblems`,
//    `outputsProblems`).
//  - Stop and wait: conditions a person must clear (`stopConditions`),
//    including a withdrawal no upstream fact explains (`withdrawalCauses`).
//
//   node scripts/listing-facts-batch.mts plan [--base REV]
//   node scripts/listing-facts-batch.mts verify --cli PORTCOVE [--base REV] \
//     [--reproduce false | --shard I] [--deadline-minutes M]
//   node scripts/listing-facts-batch.mts worker-shards --needs FILE --directory DIR
//   node scripts/listing-facts-batch.mts paths [--base REV] [--head REV]
//   node scripts/listing-facts-batch.mts observations --handoff DIR --output FILE
//   node scripts/listing-facts-batch.mts inputs --observations FILE --state FILE \
//     --observer-run ID --source-commit SHA --run-id ID --output FILE
//   node scripts/listing-facts-batch.mts assess --worker-report FILE --history FILE \
//     --run-id ID [--gate ok|refused] [--paths ok|violated] [--reproduction ok|refused] \
//     [--facts FILE] [--now ISO]
//   node scripts/listing-facts-batch.mts carry --report FILE [--base REV]
//   node scripts/listing-facts-batch.mts capacity --output FILE
//   node scripts/listing-facts-batch.mts delta|versions|observer-run|open-pull-request …
//   node scripts/listing-facts-batch.mts merge-intent|collect …   (job plumbing)
//   node scripts/listing-facts-batch.mts queues --route-fit FILE [--output FILE]
//   node scripts/listing-facts-batch.mts issues --conditions FILE [--unfiled FILE]  (GitHub writes)
//   node scripts/listing-facts-batch.mts blocked [--unfiled FILE]                   (GitHub reads)
//   node scripts/listing-facts-batch.mts pull-request                               (GitHub reads)
// Any command takes `--deadline-minutes M`: its step's deadline for GitHub calls.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { parseCatalogSource, readCatalogSource, type AuthoredPort } from "./catalog-authoring.mts";
import { capacityConstant, catalogSizeBounds, catalogSizeGuard } from "./catalog-capacity.mts";
import {
  checkListingFactsTable,
  compareCodePoints,
  digestOf,
  FACTS_PARSER_VERSION,
  maxFactsAgeDays,
  GENERATOR_VERSION,
  enrollmentTablePath,
  factsTablePath,
  gateBaselineRevision,
  readGateBaseline,
  identityShards,
  releaseLine,
  reproductionDeadlineMinutes,
  githubTokenHourlyRequests,
  reproductionBatchEntries,
  reproductionHourlyRequests,
  toolchainNames,
  reproductionPlan,
  sameExceptReconfirmation,
  type ArtifactFactV2,
  type FactsProvenance,
  type GitRunner,
  type ListingFactsEntry,
  type ListingFactsTable,
} from "./catalog-generated-registration.mts";
import {
  artifactFact,
  assetsDigest,
  containerNames,
  observedReleaseFacts,
  observerWindow,
  otherPackagesOf,
  otherAssetNames,
  boundLinesOf,
  listingOnly,
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
    // About 3 seconds in practice; a 2-minute harness budget keeps a hung
    // check inside its step.
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
  workflows: [
    ".github/workflows/ci.yml",
    batchWorkflowPath,
    ".github/actions/setup-rust/",
    ".github/actions/stop-if-superseded/",
    ".node-version",
  ],
  /** Scripts whose import closure is the check: the batch rules, the worker, the gate, catalog generation and CI's plan. */
  scripts: [
    "scripts/listing-facts-batch.mts",
    "scripts/listing-package-facts.mts",
    "scripts/catalog-generated-registration.mts",
    "scripts/generate-catalog.mts",
    "scripts/validation-plan.mts",
    "scripts/ci-baseline.mts",
  ],
  /** The workspace manifest, the toolchain, vendored code and Core's root; member manifests are derived. */
  rust: [
    "Cargo.lock",
    "Cargo.toml",
    "rust-toolchain.toml",
    "vendor/",
    "crates/portcove-core/src/lib.rs",
    "crates/portcove-core/src/package_shape.rs",
    "crates/portcove-core/src/package_shape/",
  ],
  /** The Core module whose submodules' direct `crate::` dependencies are also checker inputs. */
  core: "crates/portcove-core/src/package_shape.rs",
  /** The CLI crate root: its whole `mod` closure is a checker input. */
  cli: "crates/portcove-cli/src/main.rs",
} as const;

/** The `[workspace] members` paths of a workspace manifest, in order. */
export function workspaceMembers(manifest: string): string[] {
  const list = /^\s*members\s*=\s*\[([^\]]*)\]/mu.exec(manifest)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/gu)].map((match) =>
    path.posix.normalize(match[1]!).replace(/\/$/u, ""),
  );
}

const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+\.(?:mts|ts|mjs|js))["']/gmu;

/**
 * The paths the PR-side facts check depends on, derived from the checkout:
 * the fixed workflow and CLI inputs, the relative import closure of the
 * checker scripts, the workspace manifest and every workspace member's manifest, toolchain and vendored
 * code, the CLI crate's whole `mod` closure, and the Core inspection module
 * with every Core module it names directly (`crate::<module>` as
 * `src/<module>.rs` and `src/<module>/`). Deeper Core dependencies are held by
 * review only. Directories end with `/`.
 */
export function checkerPaths(read: (file: string) => string | undefined): string[] {
  const found = new Set<string>([...checkerRoots.workflows, ...checkerRoots.rust]);
  // Every workspace member's manifest: a member changes the lock and the build.
  for (const member of workspaceMembers(read("Cargo.toml") ?? ""))
    found.add(`${member}/Cargo.toml`);
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
  // The CLI crate's whole module closure: a crate root's `mod x;` is
  // `<dir>/x.rs` (and its `<dir>/x/` submodules); any other file's is
  // `<file stem>/x.rs`.
  const cli: string[] = [checkerRoots.cli];
  for (let index = 0; index < cli.length; index++) {
    const file = cli[index]!;
    const text = read(file);
    if (text === undefined) continue;
    found.add(file);
    const directory =
      file === checkerRoots.cli ? path.posix.dirname(file) : file.slice(0, -".rs".length);
    for (const match of text.matchAll(
      /^\s*(?:pub(?:\([a-z]+\))?\s+)?mod\s+([a-z_][a-z0-9_]*)\s*;/gmu,
    )) {
      const child = `${directory}/${match[1]!}.rs`;
      if (!cli.includes(child)) cli.push(child);
      found.add(`${directory}/${match[1]!}/`);
    }
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
 * A table that has no entry on either side is not refused: there is nothing
 * to verify, so a format bump may rewrite an empty table with its checker.
 */
export function checkerSeparationProblem(
  changed: readonly string[],
  checker: readonly string[],
  facts: { baseline: unknown; current: unknown },
): string | undefined {
  if (!changed.includes(factsTablePath)) return undefined;
  // An empty table on both sides has nothing to verify: a format bump that
  // rewrites an empty table cannot carry facts past a loosened checker.
  if (factsEntryCount(facts.baseline) === 0 && factsEntryCount(facts.current) === 0)
    return undefined;
  const touched = checkerChanges(changed, checker);
  if (!touched.length) return undefined;
  return `This change edits the listing facts table and the code that checks it (${touched.slice(0, 8).join(", ")}${touched.length > 8 ? `, and ${touched.length - 8} more` : ""}). The pull-request check runs this change's own code, so the facts table and its checker must be separate changes: land the checker change first, then the facts.`;
}

/**
 * The number of entries a facts table holds: 0 for a missing table (`null`),
 * undefined for anything not shaped as a table, so it never reads as empty.
 */
export function factsEntryCount(table: unknown): number | undefined {
  if (table === null) return 0;
  if (!isRecord(table) || !Array.isArray(table.entries)) return undefined;
  return table.entries.length;
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
/**
 * The first page of a repository's releases, newest first, as the worker's
 * observations state them; `full` when the page is full, so more may exist.
 * `records` holds each well-formed release of the page as the release
 * endpoint would state it (repository, draft state and assets), so one list
 * call per repository reads both the offered release and its neighbours.
 */
export interface ProviderReleaseList {
  releases: ObservedRelease[];
  full: boolean;
  records: ProviderRelease[];
}
/** Lists one bounded page of a repository's releases by numeric id; throws when unavailable. */
export type ReleaseLister = (repositoryId: number) => Promise<ProviderReleaseList>;
/** Releases one listing read returns: one page of the REST maximum. */
export const releaseListPage = 100;

export type RefusalReason =
  | "over-budget"
  | "transient"
  | "release-unavailable"
  | "release-changed"
  | "not-latest-stable"
  | "asset-unavailable"
  | "core-refused"
  | "mismatch";
/** Refusals that are the runner's time or the provider's condition: retried, never a stop. */
export const transientReasons: readonly RefusalReason[] = ["over-budget", "transient"];
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
 * Why a reproduction plan may not run at all, decided offline before any
 * provider call or download: an entry whose `port_id` is not an authored
 * listing-only GitHub identity, whose `repository` is not the one its
 * listing names, or whose `repository_id` differs from the id the baseline
 * entry bound to that same repository. A change naming any such entry is
 * refused whole. The entries a change can name are therefore bounded by the
 * authored catalog, the real constraint on what an untrusted pull request
 * can make CI read.
 */
export function reproductionScopeProblems(
  entries: readonly ListingFactsEntry[],
  records: readonly AuthoredPort[],
  baseline: unknown,
): string[] {
  const listed = listingOnly(records);
  const before = new Map(
    (isRecord(baseline) && Array.isArray(baseline.entries)
      ? (baseline.entries as ListingFactsEntry[])
      : []
    ).map((entry) => [entry.port_id, entry]),
  );
  const problems: string[] = [];
  for (const entry of entries) {
    const repository = listed.get(entry.port_id);
    if (repository === undefined)
      problems.push(`${entry.port_id} is not an authored listing-only GitHub identity.`);
    else if (repository.toLowerCase() !== entry.repository.toLowerCase())
      problems.push(
        `${entry.port_id} names ${entry.repository}, but its listing names ${repository}.`,
      );
    else {
      const prior = before.get(entry.port_id);
      if (
        prior &&
        prior.repository.toLowerCase() === entry.repository.toLowerCase() &&
        prior.repository_id !== entry.repository_id
      )
        problems.push(
          `${entry.port_id} binds ${entry.repository} to repository id ${entry.repository_id}, but it was bound to ${prior.repository_id}.`,
        );
    }
  }
  return problems;
}

/** The directory every authored listing and catalog source lives under. */
export const authoredCatalogRoot = "crates/portcove-core/catalog/";
/**
 * Why a change may not reproduce at all, decided offline before any provider
 * call: it changes reproducible facts entries (`planned` > 0) together with an
 * authored listing or catalog source file, any path under
 * `authoredCatalogRoot` other than the generated batch outputs
 * (`batchAllowlist`). Authored sources land first in their own reviewed
 * change, facts later, the same shape as checker separation; a batch never
 * touches an authored file. Otherwise one untrusted change could add a listing
 * naming any repository and its facts entry together, and make CI download
 * that repository's releases and spend the repository's API quota.
 */
export function authoredSourceProblem(
  changed: readonly string[],
  planned: number,
): string | undefined {
  if (planned === 0) return undefined;
  const allowed = new Set<string>(batchAllowlist);
  const authored = changed
    .filter((file) => file.startsWith(authoredCatalogRoot) && !allowed.has(file))
    .toSorted();
  if (!authored.length) return undefined;
  return `This change edits ${planned} reproducible listing facts entries together with authored catalog sources (${authored
    .slice(0, 5)
    .join(
      ", ",
    )}${authored.length > 5 ? ", …" : ""}); land the authored change first and the facts in a later change.`;
}

/**
 * How many reproduction shards may run at once so their REST requests fit
 * reproduction's share of the `GITHUB_TOKEN` quota
 * (`reproductionHourlyRequests`, half of `githubTokenHourlyRequests`): each
 * entry costs at most one request (its repository's release list, read once
 * per shard), so a shard costs at most its entry count, and the share divided
 * by that is the number of shards whose requests fit one hour. When a change
 * plans more entries than the share, shards started after the share is spent
 * wait for the reset inside their deadline (`expectedQuotaWaitMinutes`); the
 * batch job never proposes such a change (`reproductionBatchEntries`).
 */
export function reproductionParallelism(entries: number, shards: number) {
  if (shards < 1) return 1;
  const perShard = Math.ceil(entries / shards);
  return Math.max(
    1,
    Math.min(shards, Math.floor(reproductionHourlyRequests / Math.max(1, perShard))),
  );
}

export { githubTokenHourlyRequests, reproductionHourlyRequests };

/**
 * Whether a failed inspection is the provider's or the runner's condition,
 * retried next run: a download's network failure or provider error, or the
 * runner's disk running out while Core extracted the archive. Core's own
 * refusal of the bytes, or bytes it could not read, is not.
 */
export const transientInspection = (error: unknown) =>
  error instanceof InspectionError &&
  !error.permanent &&
  (error.cause === "network" || error.cause === "runner-disk");

/**
 * Re-derive every planned entry from its provider release and exact bytes.
 * An entry is verified only when the release still states the recorded tag,
 * publication time, stable verdict and asset list, it is still the newest
 * stable release the worker's rules choose from the repository's release
 * list, the entry records exactly the release's archives, and each archive's
 * re-inspected players and Core's name verdicts rebuild a byte-equal artifact
 * fact. Anything else, including the shard's deadline, refuses that entry.
 * There is no entry, byte or archive-size bound: a shard holds the fewest
 * entries the matrix allows (`identityShards`) and reads one archive at a
 * time.
 *
 * `boundLines` names, for every entry, the release line its listing binds
 * (`boundReleaseLine`, null when unbound): the worker chooses the newest
 * stable release of that line only, so reproduction checks the same. An
 * entry it does not name is no authored listing-only identity: then every
 * entry is refused before any provider call or download
 * (`reproductionScopeProblems` refuses such a plan earlier).
 *
 * Each repository's release list is read once per call (one REST request
 * per repository, the `GITHUB_TOKEN` quota being the constraint) and the
 * offered release is read from it.
 *
 * `deadline` (epoch ms, none by default: the shard job's real time limit
 * less its other steps) is checked before each entry and archive; pass the
 * same deadline to the inspector and classifier so a download or Core run
 * that reaches it stops there and the entry is refused as `over-budget`
 * instead of running past the step.
 */
export async function reproduceFacts(inputs: {
  entries: readonly ListingFactsEntry[];
  listReleases: ReleaseLister;
  inspect: ByteInspector;
  classify: NameClassifier;
  boundLines: ReadonlyMap<string, string | null>;
  /**
   * Per entry, the archives whose recorded facts are byte-identical to the
   * baseline's (`reusedArchives`): only their provider metadata and name
   * verdict are re-checked, their bytes are not read again.
   */
  reused?: ReadonlyMap<string, ReadonlySet<number>>;
  clock?: () => number;
  deadline?: number;
}): Promise<ReproductionResult> {
  const clock = inputs.clock ?? Date.now;
  const deadline = inputs.deadline ?? Number.POSITIVE_INFINITY;
  const refused: Refusal[] = [];
  const verified: string[] = [];
  const overBudget = "The reproduction reached its shard's deadline.";
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
  // Scope first: an entry for no authored listing-only identity refuses the
  // whole call with zero provider calls and zero downloads.
  if (inputs.entries.some((entry) => !inputs.boundLines.has(entry.port_id)))
    return {
      verified,
      refused: inputs.entries.map((entry) => ({
        port_id: entry.port_id,
        reason: "mismatch" as const,
        detail: inputs.boundLines.has(entry.port_id)
          ? "Another entry of this change names no authored listing-only identity."
          : "The entry's listing is not an authored listing-only identity.",
      })),
      bytes: 0,
    };
  const lists = new Map<number, Promise<ProviderReleaseList>>();
  const listOf = (repositoryId: number) => {
    let found = lists.get(repositoryId);
    if (!found) {
      found = inputs.listReleases(repositoryId);
      lists.set(repositoryId, found);
    }
    return found;
  };
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
    const reused = inputs.reused?.get(entry.port_id) ?? new Set<number>();
    const releaseId = entry.observation.release_id;
    if (releaseId === null)
      return { reason: "release-changed", detail: "An eligible entry names no release." };
    // The repository's release list, read once: the offered release and the
    // newest-stable check both come from it.
    let listed: ProviderReleaseList;
    try {
      listed = await listOf(entry.repository_id);
    } catch (error) {
      // Quota exhaustion past the deadline is the runner's time, not a fact.
      if (error instanceof OverBudgetError) throw error;
      // A network failure, server error or rate limit is the provider's
      // condition: retried next run, never a verdict on the facts.
      if (error instanceof TransientGithubError)
        return {
          reason: "transient",
          detail: `The release list could not be read: ${error.message}`,
        };
      return {
        reason: "release-unavailable",
        detail: `The release list could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
    const release = listed.records.find((record) => record.id === releaseId);
    if (!release)
      return {
        reason: "release-unavailable",
        detail: `Release ${releaseId} is not a well-formed release among the repository's newest ${releaseListPage}.`,
      };
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
      assets: [
        ...release.assets.filter((asset) => isArchive(asset.name)).map((asset) => asset.name),
        ...containerNames(observed),
      ],
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
      // and every other package form beside its archives with the platforms
      // it serves. The other observed releases are restated from the
      // release list below.
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
        JSON.stringify(otherPackagesOf(observed, (name) => names.suggestion(name))) ===
          JSON.stringify(entry.other_packages),
        "the other package forms beside the archives",
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
    const newest = await newestStableProblem(
      listed,
      releaseId,
      entry.repository,
      inputs.boundLines.get(entry.port_id) ?? null,
    );
    if (newest) return { reason: "not-latest-stable", detail: newest };
    // The recorded observed releases are exactly the observer's window of the
    // listed releases: an entry that leaves out another line's release, or
    // changes one, is refused (a release published since the run is too).
    const window = observerWindow(listed.releases);
    await names.add({
      releases: window.map((item) => ({
        tag: item.version,
        provider_prerelease: item.provider_prerelease,
      })),
    });
    if (
      JSON.stringify(observedReleaseFacts(window, (item) => names.prerelease(item))) !==
      JSON.stringify(entry.observed_releases)
    )
      return {
        reason: "mismatch",
        detail:
          "The entry's observed releases are not the repository's newest releases as the provider lists them now.",
      };
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
    // Every other asset name, which the gate classifies with its own code,
    // is exactly the release's: none left out, none added.
    if (JSON.stringify(otherAssetNames(observed, recorded)) !== JSON.stringify(entry.asset_names))
      return {
        reason: "mismatch",
        detail: "The entry does not record exactly the release's other asset names.",
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
      // A byte-identical record of the baseline: its bytes were reproduced
      // when it landed, so only the provider's metadata (above) and Core's
      // name verdict are re-checked.
      if (reused.has(artifact.asset_id)) {
        if (
          JSON.stringify(names.suggestion(asset.name)) !== JSON.stringify(artifact.name_suggestion)
        )
          return {
            reason: "mismatch",
            detail: `${artifact.name}: Core's name verdict differs from the recorded facts.`,
          };
        continue;
      }
      if (clock() >= deadline) return { reason: "over-budget", detail: overBudget };
      const bound: ObservedAsset & { sha256: string } = { ...asset, sha256: artifact.sha256 };
      let players;
      let toolchain: string[];
      try {
        bytes += asset.size;
        const inspection = await inputs.inspect(bound, readerPlatform(asset.name));
        players = inspection.players;
        toolchain = toolchainNames(inspection.names, inspection.leaves);
      } catch (error) {
        if (error instanceof OverBudgetError) throw error;
        const permanent = error instanceof InspectionError && error.permanent;
        return {
          reason: permanent
            ? "core-refused"
            : transientInspection(error)
              ? "transient"
              : "asset-unavailable",
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
      const rebuilt: ArtifactFactV2 = artifactFact(
        bound,
        players,
        suggestion,
        (name) => names.programToken(name)!,
        toolchain,
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
      if (reused.has(archive.asset_id)) continue;
      if (clock() >= deadline) return { reason: "over-budget", detail: overBudget };
      let outcome: string;
      try {
        bytes += asset.size;
        await inputs.inspect({ ...asset, sha256: archive.sha256 }, readerPlatform(asset.name));
        outcome = "inspected";
      } catch (error) {
        if (error instanceof OverBudgetError) throw error;
        outcome =
          error instanceof InspectionError && error.permanent
            ? error.refusal
            : transientInspection(error)
              ? "transient"
              : "unavailable";
      }
      if (outcome !== archive.refusal)
        return {
          reason:
            outcome === "transient"
              ? "transient"
              : outcome === "unavailable"
                ? "asset-unavailable"
                : "mismatch",
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
    // A full page shows the newest releases; when it holds no stable release
    // of the line, an older page might, so the newest stable one is unknown.
    // When it holds one, nothing on a later page is newer.
    if (listed.full && !chosen.release)
      return `The newest ${releaseListPage} releases hold no stable release of the line; an older page cannot be read in one request.`;
    if (chosen.release?.id !== releaseId)
      return `The newest stable release is ${chosen.release ? `id ${chosen.release.id}` : "none"}, not the recorded id ${releaseId}.`;
    return undefined;
  }
}

const apiVersion = "2022-11-28";
/**
 * The REST response bound and per-request timeout: a release page of 100
 * releases with their asset lists stays far below 8 MiB, and 30 seconds is
 * the request's harness budget, not a product deadline.
 */
export const githubResponseBytes = 8 * 1024 * 1024;
export const githubRequestMs = 30_000;
/**
 * GitHub's documented retry guidance for a refusal that states no wait (a
 * secondary rate limit without `retry-after`, a server error, a network
 * failure): wait at least a minute, then back off exponentially
 * ([documentation](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately)).
 * Every retry stays inside the caller's deadline.
 */
export const githubFirstRetryMs = 60_000;
/**
 * A provider or runner condition, never a fact about the release: a network
 * failure, a server error, a secondary rate limit or a spent quota that does
 * not clear before the deadline. Reproduction reports it as transient (the
 * next run retries); a job step fails with this clear cause.
 */
export class TransientGithubError extends Error {}
/** The quota state the provider last stated: when the next request may go. */
const quota = { resumeAt: 0 };
/**
 * The deadline (epoch ms) of the running command's step, from its
 * `--deadline-minutes` (the step's timeout less the time to start and report):
 * every request without its own deadline is bounded by it. Without one, a
 * request is tried once and never waits.
 */
const stepDeadline: { at?: number } = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * When a response says the quota is spent, the time (epoch ms) a request may
 * go again: `retry-after` seconds (at least one second, so a `retry-after: 0`
 * never spins), else `x-ratelimit-reset` when `x-ratelimit-remaining` is 0.
 * Undefined when the response states no wait.
 */
export function quotaResumeAt(
  status: number,
  headers: { get(name: string): string | null },
  now: number,
): number | undefined {
  const retryAfter = Number(headers.get("retry-after"));
  if ([403, 429].includes(status) && headers.get("retry-after") !== null && retryAfter >= 0)
    return now + Math.max(1, retryAfter) * 1000;
  if (headers.get("x-ratelimit-remaining") !== "0") return undefined;
  const reset = Number(headers.get("x-ratelimit-reset"));
  // GitHub asks for at least a minute's wait when it states no usable reset;
  // a reset already past still waits a second, so a refusal never spins.
  return Number.isFinite(reset) && reset > 0
    ? Math.max(now + 1000, reset * 1000)
    : now + githubFirstRetryMs;
}
/** A response past `githubResponseBytes`: the provider's answer, never retried. */
class OversizedResponseError extends Error {}
/**
 * A response body read up to `githubResponseBytes`: reading stops, and the
 * request fails, as soon as the bound is passed, so an oversized answer is
 * never buffered whole.
 */
async function boundedBody(response: Response, url: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > githubResponseBytes) {
    await response.body?.cancel();
    throw new OversizedResponseError(`${url} answered more than ${githubResponseBytes} bytes.`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done || !value) break;
    length += value.byteLength;
    if (length > githubResponseBytes) {
      await reader.cancel();
      throw new OversizedResponseError(`${url} answered more than ${githubResponseBytes} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}
/** Whether a 403 or 429 refusal is a rate limit (primary or secondary), not a permission. */
const rateLimited = (status: number, resume: number | undefined, body: Buffer) =>
  status === 429 ||
  (status === 403 && (resume !== undefined || /rate limit/iu.test(body.toString("utf8"))));
/**
 * One GitHub REST request with the workflow token when present, inside
 * `deadline` (epoch ms; none given means no wait at all). A spent quota
 * (`quotaResumeAt`) is waited out before the next request. A network failure,
 * a server error (5xx) or a rate-limit refusal is retried after the stated
 * wait, or after at least a minute with exponential backoff
 * (`githubFirstRetryMs`). A body whose reading fails (an abort, a connection
 * closed early) or a successful answer whose body does not parse (a truncated
 * body) is a network failure too, retried the same way. A retry or wait that
 * would pass the deadline ends with `TransientGithubError` naming its cause;
 * any other refusal, and an answer past `githubResponseBytes`, is an ordinary
 * error. Returns the parsed JSON body, or null for an empty one.
 */
export async function githubRequest(
  method: string,
  url: string,
  token: string | undefined,
  options: {
    body?: unknown;
    deadline?: number;
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
): Promise<unknown> {
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? fetch;
  const pause = options.sleep ?? sleep;
  const given = options.deadline ?? stepDeadline.at;
  const deadline = given ?? now();
  // The wait before a retry that states none: a minute, doubling each time.
  let backoff = githubFirstRetryMs;
  // Why the previous attempt failed, and whether the provider stated the wait.
  let cause = "";
  let stated = false;
  for (;;) {
    let wait = Math.max(0, quota.resumeAt - now());
    if (cause && !stated) {
      wait = Math.max(wait, backoff);
      backoff *= 2;
    }
    // Every attempt, the first included, starts only inside the deadline.
    if (wait > 0 || (given !== undefined && now() >= deadline)) {
      if (now() + wait >= deadline)
        throw new TransientGithubError(
          quota.resumeAt > now()
            ? `The GITHUB_TOKEN quota is spent until ${new Date(quota.resumeAt).toISOString()}; ${method} ${url} was not done before the deadline.`
            : `${method} ${url} did not succeed before the deadline${cause ? `: ${cause}` : ""}.`,
        );
      await pause(wait);
    }
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": apiVersion,
          "user-agent": "portcove-listing-facts-batch",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(githubRequestMs),
      });
    } catch (error) {
      cause = `a network failure (${error instanceof Error ? error.message : "unknown"})`;
      stated = false;
      continue;
    }
    const resume = quotaResumeAt(response.status, response.headers, now());
    if (resume !== undefined) quota.resumeAt = Math.max(quota.resumeAt, resume);
    let body: Buffer;
    try {
      body = await boundedBody(response, url);
    } catch (error) {
      if (error instanceof OversizedResponseError) throw error;
      cause = `a network failure while reading the response (${error instanceof Error ? error.message : "unknown"})`;
      stated = false;
      continue;
    }
    if (rateLimited(response.status, resume, body)) {
      // A stated wait (`retry-after`, a reset) is waited exactly; a secondary
      // limit that states none backs off from a minute.
      cause = `a rate limit (${response.status})`;
      stated = resume !== undefined;
      continue;
    }
    if (response.status >= 500) {
      cause = `a server error (${response.status})`;
      stated = false;
      continue;
    }
    if (!response.ok) throw new Error(`${method} ${url} answered ${response.status}.`);
    if (!body.length) return null;
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch (error) {
      cause = `a truncated or unreadable response body (${error instanceof Error ? error.message : "unknown"})`;
      stated = false;
      continue;
    }
  }
}
/** Bounded JSON GET of the GitHub REST API (`githubRequest`). */
export async function githubJson(
  url: string,
  token: string | undefined,
  options: {
    deadline?: number;
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
): Promise<unknown> {
  return await githubRequest("GET", url, token, options);
}
/** Forget the stated quota (tests only). */
export const resetQuota = () => {
  quota.resumeAt = 0;
};

/**
 * One page of releases by numeric repository id, newest first: the same
 * `per_page=100` page bound the observer reads with. The one REST request
 * reproduction makes per repository.
 */
export function githubReleaseLister(
  token: string | undefined,
  options: { deadline?: number } = {},
): ReleaseLister {
  return async (repositoryId) =>
    parseProviderReleaseList(
      await githubJson(
        `https://api.github.com/repositories/${repositoryId}/releases?per_page=${releaseListPage}&page=1`,
        token,
        options,
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
  const records = value.flatMap((release: unknown) => {
    try {
      return [parseProviderRelease(release)];
    } catch {
      // A malformed record is no release to offer: the entry naming it is
      // refused as unavailable, never trusted.
      return [];
    }
  });
  return {
    releases: releases
      .filter((release) => !release.draft)
      .map(({ draft: _draft, ...rest }) => rest),
    full: value.length === releaseListPage,
    records,
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
 * twice keeps its first observation. The handoff is this repository's own
 * observer artifact; its size is the observer's, with no bound of its own.
 */
export function handoffObservations(directory: string) {
  const listings: unknown[] = [];
  const seen = new Set<string>();
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "summary.json")
    .toSorted();
  for (const name of files) {
    const file = path.join(directory, name);
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

/**
 * Reconfirmed facts older than this are refreshed by a batch even when
 * nothing else changed: half the facts age, so the batch and the person who
 * approves its runs have the other half before offered routes age out.
 */
export const refreshAfterDays = maxFactsAgeDays / 2;
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

/**
 * Why each route a change withdraws is withdrawn, from the facts on both
 * sides. Only a definitive upstream statement proceeds unattended
 * (`upstream`): its facts entry changed in anything but a reconfirmation
 * through a new release or a verdict from a complete observation (a
 * repository id that changed under the listed name included), or its
 * listing is no longer a candidate (an authored change). Everything else is
 * held for a person: `rule-version` when another facts parser version
 * rewrote the entry; `observation-unavailable` when upstream stayed
 * incomplete past the retention bound (an observer or provider outage reads
 * the same as a deleted repository, so nothing tells them apart);
 * `inspection-failure` when the worker could not read the bytes
 * (`repeated-inspection-failure`, including the runner-time and runner-disk
 * causes) or Core could not classify a name (`invalid-facts`); and
 * `not-reobserved` when the entry is unchanged but for a reconfirmation (a
 * rule change, or facts ageing out without a complete observation).
 */
export type WithdrawalCause =
  | "upstream"
  | "rule-version"
  | "observation-unavailable"
  | "inspection-failure"
  | "not-reobserved";
export function withdrawalCauses(
  previousEnrollments: unknown,
  currentEnrollments: unknown,
  previousFacts: unknown,
  current: ListingFactsTable,
): { port_id: string; cause: WithdrawalCause }[] {
  const ids = (table: unknown) =>
    new Set(
      (isRecord(table) && Array.isArray(table.enrollments) ? table.enrollments : []).flatMap(
        (row: unknown) => (isRecord(row) && typeof row.port_id === "string" ? [row.port_id] : []),
      ),
    );
  const after = ids(currentEnrollments);
  const before = new Map(
    (isRecord(previousFacts) && Array.isArray(previousFacts.entries)
      ? (previousFacts.entries as ListingFactsEntry[])
      : []
    ).map((entry) => [entry.port_id, entry]),
  );
  const now = new Map(current.entries.map((entry) => [entry.port_id, entry]));
  const cause = (prior: ListingFactsEntry | undefined, next: ListingFactsEntry | undefined) => {
    // The listing is no longer a candidate: an authored, reviewed change.
    if (!next) return "upstream" as const;
    if (!prior) return "not-reobserved" as const;
    if (prior.parser_version !== next.parser_version) return "rule-version" as const;
    const reason = next.ineligible?.reason;
    if (reason === "observation-unavailable") return "observation-unavailable" as const;
    if (reason === "repeated-inspection-failure" || reason === "invalid-facts")
      return "inspection-failure" as const;
    return sameExceptReconfirmation(prior, next)
      ? ("not-reobserved" as const)
      : ("upstream" as const);
  };
  return [...ids(previousEnrollments)]
    .filter((id) => !after.has(id))
    .toSorted(compareCodePoints)
    .map((port_id) => ({ port_id, cause: cause(before.get(port_id), now.get(port_id)) }));
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
  /** Entries carried to a later batch (`carryOver`). */
  carried?: number;
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
    ...(input.carried
      ? [
          `- ${input.carried} further entries are carried to the next batch: one batch lands at most ${reproductionBatchEntries} entries that need reproduction (half an hour's reproduction share, because the batch job and this CI each reproduce them), so neither waits for a quota reset. They are not complete and keep their previous facts until then.`,
        ]
      : []),
    "",
    "## Review and risk",
    "",
    "No title-specific review happens on this route; the documented rules, the gate and the reproduction are the review (docs/CATALOG.md, scheduled facts batch job).",
    "",
    "This pull request was opened with the workflow token, so GitHub creates its `pull_request` runs in an approval-required state: a person with write access starts them with **Approve workflows to run**, and that approval counts as a human intervention. Approval grants CI permission only; the next scheduled run separately confirms merge eligibility and merges it through the guarded delivery route only when all five required checks pass on its exact head; a failing check stops the job.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Carry-over: a batch lands only what its pull-request CI can reproduce.

/**
 * The batch a run may propose: at most `limit` entries that need reproduction
 * (`reproductionBatchEntries`: one hour's reproduction share of the quota
 * divided by the two reproductions each entry gets, the job's own and the
 * batch pull request's CI, which may fall in one hour), so neither waits for
 * a quota reset and each CI shard
 * keeps its whole deadline. Entries past the limit, in port_id order, are
 * carried: each keeps its baseline entry (or stays absent when it is new), so
 * the next run derives it again and a later batch lands it. Carried work is
 * never dropped and never reported complete (`carriedSummary`). Entries that
 * need no reproduction (reconfirmations, ineligible verdicts) always land.
 */
export function carryOver(
  baseline: unknown,
  current: ListingFactsTable,
  limit: number = reproductionBatchEntries,
): { table: ListingFactsTable; carried: string[] } {
  const plan = reproductionPlan(baseline, current);
  if (plan.entries.length <= limit) return { table: current, carried: [] };
  const carried = new Set(plan.entries.slice(limit).map((entry) => entry.port_id));
  const before = new Map(
    (isRecord(baseline) && Array.isArray(baseline.entries)
      ? (baseline.entries as ListingFactsEntry[])
      : []
    ).map((entry) => [entry.port_id, entry]),
  );
  const entries = current.entries.flatMap((entry) => {
    if (!carried.has(entry.port_id)) return [entry];
    const prior = before.get(entry.port_id);
    return prior ? [prior] : [];
  });
  const table = { ...current, entries, entries_sha256: digestOf(entries) };
  checkListingFactsTable(table);
  return { table, carried: [...carried].toSorted(compareCodePoints) };
}
/**
 * The worker summary with carried identities marked: each carried row's
 * outcome becomes `carried`, `settled` no longer counts them, and
 * `carried_ids` lists them, so the run reports them as unfinished.
 */
export function carriedSummary(text: string, carried: readonly string[]): string {
  const value = JSON.parse(text) as Record<string, unknown>;
  const ids = new Set(carried);
  const identities = Array.isArray(value.identities)
    ? (value.identities as { port_id: string; outcome: string }[])
    : [];
  const settledCarried = identities.filter(
    (row) => ids.has(row.port_id) && row.outcome === "complete",
  ).length;
  return `${JSON.stringify({
    ...value,
    settled: Math.max(0, Number(value.settled) - settledCarried),
    carried_ids: [...carried],
    identities: identities.map((row) =>
      ids.has(row.port_id) ? { ...row, outcome: "carried" } : row,
    ),
  })}\n`;
}

// ---------------------------------------------------------------------------
// Catalog capacity: what released readers accept.

/**
 * The bytes Core's retained installed contract adds to the JSON-escaped
 * `catalog.json` text: its other fields, which do not grow with routes. Core's
 * growth test (`catalog_growth_stays_within_supported_capacity`) measured
 * 4,529,946 escaped contract bytes beside 4,526,469 escaped catalog bytes, so
 * 3,477 bytes; the reserve is about four times that.
 */
export const retainedContractReserveBytes = 16 * 1024;

/** One measured capacity guard: bytes against 85% of a released reader's bound. */
export interface CapacityRow {
  name: string;
  bytes: number;
  bound: number;
  ceiling: number;
  headroom: number;
  ok: boolean;
}

/**
 * The batch against both released-reader bounds, at Core's supported share
 * (`CATALOG_SUPPORTED_CAPACITY_PERCENT`, 85%):
 *  - `MAX_CATALOG_BYTES` (16 MiB): the generated catalog, its compact and
 *    signed-envelope forms (`catalogSizeGuard`), and the binding measure, the
 *    JSON-escaped retained installed contract, estimated as the escaped
 *    `catalog.json` text plus `retainedContractReserveBytes`;
 *  - `MAX_LISTING_BYTES` (8 MiB): the embedded listing directory.
 * Released readers refuse more than the bound, so a batch past a ceiling is
 * never proposed: its required check would fail.
 */
export function batchCapacity(input: {
  catalogText: string;
  listingBytes: number;
  signedCatalogSource: string;
  listingSource: string;
}): { ok: boolean; percent: number; rows: CapacityRow[] } {
  const bounds = catalogSizeBounds(input.signedCatalogSource);
  const listingBound = capacityConstant(input.listingSource, "MAX_LISTING_BYTES");
  const guard = catalogSizeGuard(
    Buffer.byteLength(input.catalogText),
    JSON.parse(input.catalogText) as unknown,
    bounds,
    { bytes: input.listingBytes, bound: listingBound },
  );
  const ceiling = Math.floor((bounds.current * bounds.percent) / 100);
  const retained =
    Buffer.byteLength(JSON.stringify(input.catalogText)) + retainedContractReserveBytes;
  const rows: CapacityRow[] = [
    ...guard.rows.map(({ name, bytes, bound, ceiling: limit, headroom, ok }) => ({
      name,
      bytes,
      bound,
      ceiling: limit,
      headroom,
      ok,
    })),
    {
      name: "JSON-escaped retained installed contract bytes (estimate)",
      bytes: retained,
      bound: bounds.current,
      ceiling,
      headroom: ceiling - retained,
      ok: retained <= ceiling,
    },
  ];
  return { ok: rows.every((row) => row.ok), percent: bounds.percent, rows };
}

/** The `catalog-capacity` stop's detail: every exceeded guard with its exact figures. */
export function capacityDetail(result: ReturnType<typeof batchCapacity>): string | undefined {
  const over = result.rows.filter((row) => !row.ok);
  if (!over.length) return undefined;
  return `This batch would exceed what released readers accept, so no pull request was opened (its required check would fail): ${over
    .map(
      (row) =>
        `${row.name} ${row.bytes} bytes against a ceiling of ${row.ceiling} (${result.percent}% of ${row.bound}), ${-row.headroom} bytes over`,
    )
    .join(
      "; ",
    )}. Raising a bound needs a compatibility analysis of released readers; until then the batch stays unproposed.`;
}

// ---------------------------------------------------------------------------
// Stop and wait: conditions only a person clears.

export const stopConditionNames = [
  "gate-refused",
  "catalog-capacity",
  "reproduction-refused",
  "reproduction-transient",
  "path-allowlist",
  "required-check-failed",
  "no-progress",
  "backlog-growing",
  "withdrawal-held",
  "repository-identity-changed",
  "rule-version-changed",
  "observer-coverage-dropped",
  "pending-repeated",
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
  /** The identities the observer covered; kept on the newest record only. */
  observed_ids?: string[];
  /** The identities a shard deadline left pending; kept on the newest record only. */
  pending_ids?: string[];
  settled: number;
  no_progress: boolean;
  backlog_total: number;
  withdrawn: number;
  identity_changed: number;
  versions: string;
  /** This run's reproduction ended only transiently (`reproductionTransient`). */
  reproduction_transient?: boolean;
}
/**
 * Facts older than this against the real clock raise the freshness alert: a
 * quiet catalog proposes its reconfirmation batch at `refreshAfterDays`, so
 * facts older than that have not landed one. Derived, not chosen.
 */
export const freshnessAlertDays = maxFactsAgeDays / 2;
/**
 * A batch pull request whose required checks have not all started or
 * finished after this many days stops the job: its runs most likely wait for
 * a person to approve them. A reconfirmation proposed at `refreshAfterDays`
 * must merge within the rest of the facts age, or offered routes age out;
 * so the wait is the facts age less the refresh point.
 */
export const batchWaitDays = maxFactsAgeDays - maxFactsAgeDays / 2;
/**
 * The clock skew a recorded time may lead the real clock by: none. Every
 * recorded time comes from an earlier run on GitHub-hosted runners, whose
 * clocks are synchronized, and is checked later.
 */
export const clockSkewMs = 0;

/** The parts of the worker's summary line the job reads. */
export interface WorkerSummary {
  no_progress: boolean;
  settled: number;
  backlog: {
    enrolled_pending: number;
    new_pending: number;
    bytes_pending: number;
  };
  ineligible: Record<string, number>;
  /** Candidate identities the observer report did not cover. */
  unobserved: string[];
  /** Identities a shard deadline left pending, absent from older summaries. */
  pending_ids?: string[];
  /** Identities carried to a later batch (`carryOver`): unfinished, never complete. */
  carried_ids?: string[];
  identities: { port_id: string; outcome: string; reason?: string }[];
}

export function parseWorkerSummary(text: string): WorkerSummary {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.no_progress !== "boolean" ||
    !Number.isSafeInteger(value.settled) ||
    !isRecord(value.backlog) ||
    // The backlog stop reads these; a summary without them must not read as 0.
    !Number.isSafeInteger(value.backlog.enrolled_pending) ||
    !Number.isSafeInteger(value.backlog.new_pending) ||
    !isRecord(value.ineligible) ||
    !Array.isArray(value.unobserved) ||
    !Array.isArray(value.identities) ||
    ![value.pending_ids, value.carried_ids].every(
      (ids) =>
        ids === undefined ||
        (Array.isArray(ids) && ids.every((id: unknown) => typeof id === "string")),
    )
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
  /** `transient`: refused only for the runner's time (`reproductionTransient`), no stop. */
  reproduction: "ok" | "refused" | "transient" | "skipped";
  delta?: { added: number; withdrawn: number; changed: number };
  /** Withdrawals no upstream fact explains (`withdrawalCauses`). */
  held?: readonly { port_id: string; cause: string }[];
  /** The exceeded capacity guards (`capacityDetail`), when the batch would exceed one. */
  capacity?: string;
  details?: Partial<Record<StopConditionName, string>>;
}): { conditions: StopCondition[]; record: RunRecord | undefined } {
  const conditions: StopCondition[] = [];
  const add = (name: StopConditionName, detail: string) =>
    conditions.push({ name, detail: input.details?.[name] ?? detail });
  if (input.gate === "refused")
    add("gate-refused", "The generated registration gate refused this run's generation.");
  if (input.capacity) add("catalog-capacity", input.capacity);
  if (input.paths === "violated")
    add("path-allowlist", "The batch changed a path outside the generated-file allowlist.");
  if (input.reproduction === "refused")
    add("reproduction-refused", "CI could not reproduce an eligible entry from its exact bytes.");
  if (!input.summary) {
    add("worker-error", "The facts worker failed before writing its summary.");
    return { conditions, record: undefined };
  }
  const summary = input.summary;
  const backlog = summary.backlog.enrolled_pending + summary.backlog.new_pending;
  const identityChanged = summary.identities.filter(
    (row) => row.reason === "repository-identity-changed" && row.outcome === "ineligible",
  ).length;
  const observedIds = summary.identities.map((row) => row.port_id).toSorted(compareCodePoints);
  const record: RunRecord = {
    run_id: input.runId,
    at: input.now,
    observed: observedIds.length,
    observed_ids: observedIds,
    pending_ids: [...(summary.pending_ids ?? [])].toSorted(compareCodePoints),
    settled: summary.settled,
    no_progress: summary.no_progress,
    backlog_total: backlog,
    withdrawn: input.delta?.withdrawn ?? 0,
    identity_changed: identityChanged,
    versions: input.versions,
    ...(input.reproduction === "transient" ? { reproduction_transient: true } : {}),
  };
  // A run has no identity or byte bound, so one run that left work pending
  // but settled nothing means a whole shard could not finish one identity.
  if (summary.no_progress)
    add(
      "no-progress",
      `This run's deadlines left ${backlog} identities pending, and it settled none.`,
    );
  const previous = input.history.at(-1);
  // A transient reproduction is retried by the next run; the same on two
  // consecutive runs is no longer a passing condition, so a person looks.
  if (input.reproduction === "transient" && previous?.reproduction_transient)
    add(
      "reproduction-transient",
      "CI could not reproduce this batch for transient reasons (network, provider errors, rate limits, the runner's time or disk) on two consecutive runs.",
    );
  // Pending work exists only where a shard's deadline cut it; more of it
  // than the previous run left means the shards no longer keep up.
  if (previous && backlog > previous.backlog_total)
    add(
      "backlog-growing",
      `Shard deadlines left ${backlog} identities pending, up from ${previous.backlog_total}.`,
    );
  // Withdrawals an upstream fact explains proceed; a withdrawal a rule or
  // parser version change, or a lapse of observation, causes is held for a
  // person: it is how a bug would withdraw offered games.
  const held = input.held ?? [];
  if (held.length)
    add(
      "withdrawal-held",
      `This batch would withdraw ${held.length} offered route(s) without a change in upstream facts: ${held
        .slice(0, 5)
        .map((item) => `${item.port_id} (${item.cause})`)
        .join(
          ", ",
        )}${held.length > 5 ? ", …" : ""}. Review the cause; a rule change lands by hand.`,
    );
  if (identityChanged > 0)
    add(
      "repository-identity-changed",
      `${identityChanged} listed repositories now resolve to another repository id.`,
    );
  if (previous && previous.versions !== input.versions)
    add(
      "rule-version-changed",
      `The facts parser, generator, classifier or CLI changed (${previous.versions} → ${input.versions}); review one batch by hand.`,
    );
  // Coverage drops when an identity the previous run's observer covered is
  // a candidate this run's observer report does not cover at all.
  const lost = previous?.observed_ids
    ? summary.unobserved.filter((id) => previous.observed_ids!.includes(id))
    : [];
  // An identity a shard deadline left pending in this run and the previous
  // one is starved: each identity has a budget CI can reproduce in, so this
  // means a shard no longer fits its work.
  const starved = previous?.pending_ids
    ? (summary.pending_ids ?? []).filter((id) => previous.pending_ids!.includes(id))
    : [];
  if (starved.length) {
    const causes = new Map<string, string[]>();
    for (const id of starved.toSorted(compareCodePoints)) {
      const cause =
        summary.identities.find((row) => row.port_id === id)?.outcome ?? "deferred-deadline";
      causes.set(cause, [...(causes.get(cause) ?? []), id]);
    }
    add(
      "pending-repeated",
      `${starved.length} identities stayed pending across consecutive runs: ${[...causes]
        .map(
          ([cause, ids]) =>
            `${cause} (${ids.length}: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""})`,
        )
        .join("; ")}.`,
    );
  }
  if (lost.length)
    add(
      "observer-coverage-dropped",
      `The observer no longer covers ${lost.length} identities it covered in the previous run: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ", …" : ""}.`,
    );
  return { conditions, record };
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
/** The refusal files of one reproduction: one file, or a directory of one per shard. */
function refusalFiles(file: string) {
  return statSync(file).isDirectory()
    ? readdirSync(file)
        .filter((name) => name.endsWith(".json"))
        .toSorted()
        .map((name) => path.join(file, name))
    : [file];
}
/** One refusal file: `{ ok, transient, refusals }`, or an array of refusal lines. */
function readRefusals(name: string): { ok: boolean; transient: boolean; refusals: unknown[] } {
  const parsed: unknown = JSON.parse(readFileSync(name, "utf8"));
  if (Array.isArray(parsed))
    return { ok: parsed.length === 0, transient: false, refusals: parsed as unknown[] };
  if (isRecord(parsed) && Array.isArray(parsed.refusals))
    return {
      ok: parsed.ok === true,
      transient: parsed.transient === true,
      refusals: parsed.refusals as unknown[],
    };
  return { ok: false, transient: false, refusals: [] };
}
export function reproductionDetails(file: string | undefined) {
  if (!file) return {};
  try {
    const lines = refusalFiles(file)
      .flatMap((name) => readRefusals(name).refusals)
      .slice(0, 5);
    if (!lines.length) return {};
    const listed = lines.map((line) => `- ${inertText(String(line).slice(0, 400))}`).join("\n");
    return {
      "reproduction-refused": `CI could not reproduce these eligible entries from their exact bytes:\n${listed}`,
      "reproduction-transient": `CI could not reproduce this batch for transient reasons on two consecutive runs; the latest causes:\n${listed}`,
    };
  } catch {
    return {};
  }
}
/**
 * Whether a refused reproduction was only transient: every one of `shards`
 * shards wrote its refusal file, and each says its only problems were the
 * runner's time (its deadline or a GITHUB_TOKEN quota wait) or the provider's
 * or runner's condition (network, server errors, rate limits, runner disk;
 * `transientReasons`). Such a run proposes nothing and the next run retries;
 * the same on two consecutive runs stops (`reproduction-transient`).
 */
export function reproductionTransient(file: string | undefined, shards: number): boolean {
  if (!file || !(shards > 0)) return false;
  try {
    const files = refusalFiles(file);
    const read = files.map(readRefusals);
    return (
      files.length === shards &&
      read.some((item) => item.transient) &&
      read.every((item) => item.transient || item.ok)
    );
  } catch {
    return false;
  }
}

/** The batch workflow's jobs, as `collect` reads their results. */
export const batchJobs = [
  "gate",
  "prepare",
  "inspect",
  "combine",
  "reproduce",
  "decide",
  "merge",
  "deliver",
] as const;
/** Jobs whose failure the deriving run's own conditions already explain. */
const derivingJobs: readonly string[] = [
  "derive",
  "prepare",
  "inspect",
  "combine",
  "reproduce",
  "decide",
];

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
    // A deriving job that failed after its run named its conditions failed
    // because of them. A timed-out or cancelled job ends the same way:
    // nothing silent.
    if (
      ["failure", "cancelled"].includes(result) &&
      !(derivingJobs.includes(job) && found.conditions.length)
    )
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
/**
 * When a `repeated-inspection-failure` (a `runner-time` or `runner-disk`
 * cause included) is reconsidered: the worker reconfirms the ineligible entry
 * without retrying for as long as the offered release and its asset list stay
 * the same, so it lasts until the entry changes.
 */
export const inspectionFailureReconsideration =
  "Each identity here stays ineligible until its entry changes: a new offered release or a changed asset list makes the next run inspect it again. Until then the worker reconfirms it without retrying (a facts parser version change alone does not); a person may instead review it for a curated route.";
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
  const failures = sizes(queues.inspection_failures);
  // Repositories several identities name: each stays `shared-repository`
  // until a reviewed release-line binding exists.
  const shared = sizes(queues.shared_repositories);
  // Enrolled identities whose release also ships a form for a platform it
  // offers no archive for: each is listed for a person to review.
  const review = Array.isArray(queues.enrolled_beside_unoffered_forms)
    ? queues.enrolled_beside_unoffered_forms.filter((id): id is string => typeof id === "string")
    : [];
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
      ...table("Repeated inspection failures by cause", failures),
      ...(failures.length ? [inspectionFailureReconsideration, ""] : []),
      ...table(
        `Repositories named by more than one identity (${shared.length}; ${shared.reduce((sum, [, count]) => sum + count, 0)} identities; top ${top})`,
        shared.slice(0, top),
      ),
      `### Enrolled beside another package form for a platform without an archive (review: ${review.length})`,
      "",
      ...(review.length ? review.map((id) => `- \`${id}\``) : ["None."]),
      "",
    ].join("\n"),
    counts: {
      reasons: Object.fromEntries(reasons),
      unread_forms: Object.fromEntries(sizes(queues.unread_forms)),
      exclusions: Object.fromEntries(sizes(queues.exclusions)),
      refusals: Object.fromEntries(refusals),
      inspection_failures: Object.fromEntries(failures),
      shared_repositories: Object.fromEntries(shared),
      enrolled_beside_unoffered_forms: review.length,
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
function checkerSeparation(
  changed: readonly string[] | undefined,
  facts: { baseline: unknown; current: unknown },
): string | undefined {
  if (!changed) return "git could not list the changed paths; refusing.";
  return checkerSeparationProblem(changed, checkerPaths(readCheckout), facts);
}

/**
 * The authored catalog records of revision `revision` (the change's base), so
 * the reproduction scope and release-line bindings never come from the
 * change itself: a listing only the head adds is never in scope.
 */
function authoredRecordsAt(revision: string): AuthoredPort[] {
  const directory = mkdtempSync(path.join(os.tmpdir(), "listing-facts-base-"));
  try {
    const archive = spawnSync(
      "git",
      ["archive", "--format=tar", revision, "--", authoredCatalogRoot.slice(0, -1)],
      { cwd: root, maxBuffer: 512 * 1024 * 1024, timeout: 2 * 60_000, killSignal: "SIGKILL" },
    );
    if (archive.status !== 0)
      throw new Error(`Cannot read the authored catalog of revision ${revision}.`);
    const extract = spawnSync("tar", ["-x", "-C", directory], {
      input: archive.stdout,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 2 * 60_000,
      killSignal: "SIGKILL",
    });
    if (extract.status !== 0)
      throw new Error(`Cannot unpack the authored catalog of revision ${revision}.`);
    return readCatalogSource(path.join(directory, authoredCatalogRoot)).authored;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

/**
 * A GitHub REST write to this repository (`githubRequest`): it honours the
 * stated quota, retries transient failures by GitHub's guidance and ends at
 * the step's deadline (`stepDeadline`) with a clear cause.
 */
async function githubWrite(method: string, route: string, body: unknown) {
  return await githubRequest(
    method,
    `https://api.github.com/repos/${repository()}${route}`,
    token(),
    {
      body,
    },
  );
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

/** One issue the job files: its title and body. */
export interface JobIssue {
  title: string;
  body: string;
}
/**
 * File one issue per condition: comment on an open one, reopen a closed one,
 * else open one. Returns the issues not filed when a GitHub call failed (the
 * failed one and every later one) with the error, so they are kept for the
 * next run instead of lost.
 */
async function fileIssues(
  issues: readonly JobIssue[],
): Promise<{ unfiled: JobIssue[]; error?: unknown }> {
  if (!issues.length) return { unfiled: [] };
  let index = 0;
  try {
    const existing = [...(await jobIssues("open")), ...(await jobIssues("closed"))];
    for (; index < issues.length; index++) {
      const { title, body } = issues[index]!;
      const issue = existing.find((candidate) => candidate.title === title);
      if (!issue) await githubWrite("POST", "/issues", { title, body });
      // An open issue already says it; only a recurrence after it was closed
      // reopens and comments, so a waiting stop never repeats itself each run.
      else if (issue.state !== "open") {
        await githubWrite("PATCH", `/issues/${issue.number}`, { state: "open" });
        await githubWrite("POST", `/issues/${issue.number}/comments`, { body });
      }
    }
    return { unfiled: [] };
  } catch (error) {
    return { unfiled: issues.slice(index), error };
  }
}
/**
 * Issues an earlier run could not file (`fileIssues`), kept in the job's
 * cache. A missing record holds none; an unreadable one fails closed as one
 * stop to file, never as "nothing waiting".
 */
export function readUnfiled(file: string | undefined): JobIssue[] {
  if (!file || !existsSync(file)) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      Array.isArray(value) &&
      value.every(
        (item) => isRecord(item) && typeof item.title === "string" && typeof item.body === "string",
      )
    )
      return value as JobIssue[];
  } catch {
    // Fall through.
  }
  return [
    {
      title: `${stopIssuePrefix}worker-error`,
      body: "The record of stop issues an earlier run could not file is unreadable; review that run's notify job.",
    },
  ];
}

async function main(argv: string[]): Promise<string> {
  const [command, ...rest] = argv;
  const option = options(rest);
  if (option["deadline-minutes"] !== undefined) {
    const minutes = Number(option["deadline-minutes"]);
    if (!(minutes > 0)) throw new Error(`${command} --deadline-minutes needs a positive number.`);
    stepDeadline.at = Date.now() + minutes * 60_000;
  }
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
        output("shards", "[]");
        return `Listing facts are verified on pull requests; ${event} runs skip reproduction.\n`;
      }
      const current = currentFacts();
      const base = baselineRevision(option.base);
      const baseline = baselineFacts(option.base);
      const changed = changedPaths(git, base, "HEAD");
      // The facts table and the code that checks it are separate changes.
      const separation = checkerSeparation(changed, { baseline, current });
      if (separation) throw new Error(separation);
      const plan = reproductionPlan(baseline, current);
      // Authored sources and the facts they enable are separate changes too.
      const authored = authoredSourceProblem(changed ?? [], plan.entries.length);
      if (authored)
        throw new Error(`Listing facts change refused before any download: ${authored}`);
      // Offline scope first, against the base's authored catalog: a change
      // naming an entry for no authored listing-only identity, or another
      // repository, is refused whole with zero provider calls and downloads.
      const scope = reproductionScopeProblems(
        plan.entries,
        plan.entries.length ? authoredRecordsAt(base) : [],
        baseline,
      );
      if (scope.length)
        throw new Error(
          `Listing facts change refused before any download:\n- ${scope.join("\n- ")}`,
        );
      const batch = claimsBatch(baseline, current, process.env.GITHUB_HEAD_REF);
      const factsChanged = digestOf(isRecord(baseline) ? baseline : null) !== digestOf(current);
      // One matrix job per shard: every entry is reproduced, each shard
      // holding the fewest entries the matrix allows.
      const shards = identityShards(plan.entries.map((entry) => entry.port_id));
      output("reproduce", String(plan.entries.length > 0));
      output("batch", String(batch));
      output("shards", JSON.stringify(shards.map((_, index) => index)));
      const parallel = reproductionParallelism(plan.entries.length, shards.length);
      output("max_parallel", String(parallel));
      return `${JSON.stringify({ facts_changed: factsChanged, batch, reproduce: plan.entries.length, shards: shards.length, max_parallel: parallel, bytes: plan.bytes })}\n`;
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
      const changed = changedPaths(git, base, "HEAD");
      const separation = checkerSeparation(changed, { baseline, current });
      if (separation) problems.push(separation);
      problems.push(...clockProblems(baseline, current, Date.now()));
      const headRef = process.env.GITHUB_HEAD_REF || undefined;
      // A reproduction shard leaves the batch checks to the one checks run.
      if (option.shard === undefined && claimsBatch(baseline, current, headRef)) {
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
      // `--reproduce false` runs only the checks above (once per change);
      // `--shard I` reproduces only shard I of `identityShards`, so a matrix
      // reproduces every entry. Without either, every entry here.
      const plan = reproductionPlan(baseline, current);
      // Scope and release-line bindings come from the base's authored catalog;
      // a change that also edits authored sources reproduces nothing.
      const authored = authoredSourceProblem(changed ?? [], plan.entries.length);
      const baseRecords = plan.entries.length && !authored ? authoredRecordsAt(base) : [];
      const scope = authored
        ? [authored]
        : reproductionScopeProblems(plan.entries, baseRecords, baseline);
      problems.push(...scope);
      const shards = identityShards(plan.entries.map((entry) => entry.port_id));
      const shard = option.shard === undefined ? undefined : Number(option.shard);
      if (
        shard !== undefined &&
        !(Number.isSafeInteger(shard) && shard >= 0 && shard < shards.length)
      )
        throw new Error(`verify --shard ${option.shard} names no shard of ${shards.length}.`);
      const mine = new Set(
        shard === undefined ? plan.entries.map((e) => e.port_id) : shards[shard],
      );
      const refused: Refusal[] = [];
      // An out-of-scope plan reads nothing at all.
      const entries =
        option.reproduce === "false" || scope.length
          ? []
          : plan.entries.filter((entry) => mine.has(entry.port_id));
      if (entries.length) {
        if (!option.cli) throw new Error("verify needs --cli to reproduce facts.");
        const work = await mkdtemp(path.join(os.tmpdir(), "listing-facts-reproduce-"));
        try {
          const cli = path.resolve(option.cli);
          // The shard's real time limit, by default the binding CI shard
          // deadline: every download, Core run and quota wait is cut at it,
          // and the entry is refused as over-budget (transient).
          const minutes = option["deadline-minutes"]
            ? Number(option["deadline-minutes"])
            : reproductionDeadlineMinutes;
          if (!(minutes > 0)) throw new Error("verify --deadline-minutes needs a positive number.");
          const timing = { deadline: Date.now() + minutes * 60_000 };
          stepDeadline.at ??= timing.deadline;
          const result = await reproduceFacts({
            entries,
            listReleases: githubReleaseLister(token(), timing),
            inspect: cliInspector(cli, work, timing),
            classify: cliClassifier(cli, work, timing),
            boundLines: boundLinesOf(baseRecords),
            reused: plan.reused,
            ...timing,
          });
          summary(
            `Reproduced ${result.verified.length} of ${entries.length} changed eligible facts entries${shard === undefined ? "" : ` in shard ${shard} of ${shards.length}`} (${result.bytes} bytes).`,
          );
          for (const refusal of result.refused)
            problems.push(`${refusal.port_id}: ${refusal.reason}: ${refusal.detail}`);
          refused.push(...result.refused);
        } finally {
          await rm(work, { recursive: true, force: true });
        }
      }
      output("reproduced", String(entries.length));
      // The stop issue names the refused entries (at most five). A shard
      // whose only problems are over-budget refusals (its deadline, a quota
      // wait included) is transient: the runner's time, never the facts.
      if (option.refusals)
        writeFileSync(
          option.refusals,
          `${JSON.stringify({
            ok: problems.length === 0,
            transient:
              problems.length > 0 &&
              problems.length === refused.length &&
              refused.every((refusal) => transientReasons.includes(refusal.reason)),
            refusals: refused.slice(0, 5).map((r) => `${r.port_id}: ${r.reason}: ${r.detail}`),
          })}\n`,
        );
      if (
        problems.length &&
        problems.length === refused.length &&
        refused.every((refusal) => transientReasons.includes(refusal.reason))
      )
        throw new Error(
          `Listing facts reproduction could not finish for transient reasons (the provider's or the runner's condition, not the facts); re-run this check:\n- ${problems.join("\n- ")}`,
        );
      if (problems.length)
        throw new Error(`Listing facts change refused:\n- ${problems.join("\n- ")}`);
      return `Listing facts change verified: ${entries.length} eligible entries reproduced.\n`;
    }
    case "worker-shards": {
      // The facts worker's shards: one per identity that needs bytes, at
      // most `matrixJobLimit`, each written as `only-<index>.json`.
      if (!option.needs || !option.directory)
        throw new Error("worker-shards needs --needs and --directory.");
      const needs = JSON.parse(readFileSync(option.needs, "utf8")) as { port_id: string }[];
      const shards = identityShards(needs.map((need) => need.port_id));
      mkdirSync(option.directory, { recursive: true });
      for (const [index, only] of shards.entries())
        writeFileSync(
          path.join(option.directory, `only-${index}.json`),
          `${JSON.stringify(only)}\n`,
        );
      output("shards", JSON.stringify(shards.map((_, index) => index)));
      return `${needs.length} identities need bytes in ${shards.length} shard(s).\n`;
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
            held?: { port_id: string; cause: string }[];
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
        reproduction:
          option.reproduction === "refused" &&
          reproductionTransient(option.refusals, Number(option["shard-count"]))
            ? "transient"
            : ((option.reproduction as "ok" | "refused" | "skipped") ?? "skipped"),
        ...(delta ? { delta, held: delta.held ?? [] } : {}),
        ...capacityInput(option.capacity),
        details: reproductionDetails(option.refusals),
      });
      if (record)
        // The identity list is kept on the newest record only: coverage
        // compares one run with the previous one.
        writeFileSync(
          option.history,
          `${JSON.stringify(
            [
              ...history.map(({ observed_ids: _ids, pending_ids: _pending, ...rest }) => rest),
              record,
            ].slice(-30),
          )}\n`,
        );
      const facts = currentFacts();
      const behind = factsFallingBehind(facts, option.now ?? new Date().toISOString());
      if (option.output)
        writeFileSync(
          option.output,
          `${JSON.stringify({ conditions, freshness: behind ?? null })}\n`,
        );
      output("stop", String(conditions.length > 0));
      output("transient", String(record?.reproduction_transient === true));
      summary(
        conditions.length
          ? `### Stop conditions\n\n${conditions.map((c) => `- **${c.name}**: ${c.detail}`).join("\n")}`
          : "No stop condition.",
      );
      return `${JSON.stringify({ conditions, freshness: behind ?? null })}\n`;
    }
    case "carry": {
      // Before generation: keep in this batch only what its pull-request CI
      // and the job can both reproduce within one hour's reproduction share.
      if (!option.report) throw new Error("carry needs --report.");
      const { table, carried } = carryOver(baselineFacts(option.base), currentFacts());
      if (carried.length) {
        writeFileSync(path.join(root, factsTablePath), `${JSON.stringify(table, null, 2)}\n`);
        writeFileSync(option.report, carriedSummary(readFileSync(option.report, "utf8"), carried));
        summary(
          `Carried ${carried.length} entries to the next batch: this batch lands at most ${reproductionBatchEntries} entries that need reproduction.`,
        );
      }
      output("carried", String(carried.length));
      return `${JSON.stringify({ carried: carried.length })}\n`;
    }
    case "capacity": {
      // The regenerated catalog against both released-reader bounds, before
      // any pull request exists. Records the result; the stop is `assess`'s.
      if (!option.output) throw new Error("capacity needs --output.");
      const result = batchCapacity({
        catalogText: readFileSync(
          path.join(root, "crates/portcove-core/catalog/catalog.json"),
          "utf8",
        ),
        listingBytes: statSync(path.join(root, "crates/portcove-core/catalog/listings.json")).size,
        signedCatalogSource: readFileSync(
          path.join(root, "crates/portcove-core/src/signed_catalog.rs"),
          "utf8",
        ),
        listingSource: readFileSync(
          path.join(root, "crates/portcove-core/src/catalog/listings.rs"),
          "utf8",
        ),
      });
      const detail = capacityDetail(result) ?? null;
      writeFileSync(option.output, `${JSON.stringify({ ...result, detail })}\n`);
      output("capacity", result.ok ? "ok" : "exceeded");
      summary(
        result.rows
          .map(
            (row) =>
              `- ${row.ok ? "ok" : "**over**"} ${row.name}: ${row.bytes} of ${row.ceiling}; headroom ${row.headroom}`,
          )
          .join("\n"),
      );
      return `${JSON.stringify({ ok: result.ok, detail })}\n`;
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
      // An earlier run's unfiled issues go first; whatever cannot be filed
      // now (a spent quota, the step's deadline) is kept for the next run,
      // whose gate holds the job until it is filed.
      const earlier = readUnfiled(option.unfiled);
      const { unfiled, error } = await fileIssues([
        ...earlier,
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
      if (option.unfiled) {
        mkdirSync(path.dirname(option.unfiled), { recursive: true });
        writeFileSync(option.unfiled, `${JSON.stringify(unfiled)}\n`);
      }
      if (error)
        throw new Error(
          `${unfiled.length} issue(s) were not filed and are kept for the next run: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      return `Filed ${earlier.length + known.length} stop condition(s).\n`;
    }
    case "blocked": {
      // A stop an earlier run could not file holds the run until notify
      // files it; an open stop issue holds every run until a person closes it.
      const waiting = readUnfiled(option.unfiled).filter((issue) =>
        issue.title.startsWith(stopIssuePrefix),
      );
      if (waiting.length) {
        output("blocked", "true");
        summary(
          `Stopped: ${waiting.length} stop issue(s) an earlier run could not file are filed by this run's notify job first.`,
        );
        return `${JSON.stringify({ unfiled: waiting.map((issue) => issue.title) })}\n`;
      }
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
      const previous = before ? (JSON.parse(before) as unknown) : null;
      const current: unknown = JSON.parse(
        readFileSync(path.join(root, enrollmentTablePath), "utf8"),
      );
      const delta = tableDelta(previous, current);
      const held = withdrawalCauses(previous, current, baselineFacts(base), currentFacts()).filter(
        (item) => item.cause !== "upstream",
      );
      if (option.output) writeFileSync(option.output, `${JSON.stringify({ ...delta, held })}\n`);
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
      // The body states what the batch leaves for later: an unreadable report fails.
      const carried = option.report
        ? (parseWorkerSummary(readFileSync(option.report, "utf8")).carried_ids?.length ?? 0)
        : 0;
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
          carried,
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
        jobs: Object.fromEntries(batchJobs.map((job) => [job, option[job] ?? ""] as const)),
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

/** The `capacity` record `assess` reads: a detail only when a guard is exceeded; unreadable fails closed. */
function capacityInput(file: string | undefined): { capacity?: string } {
  if (!file) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isRecord(value) && value.ok === true) return {};
    if (isRecord(value) && typeof value.detail === "string") return { capacity: value.detail };
  } catch {
    // Fall through: an unreadable record never reads as within capacity.
  }
  return {
    capacity: "The batch's capacity record is missing or unreadable; no batch is proposed.",
  };
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
