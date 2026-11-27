// Listing package facts: typed player facts for listing-only GitHub packages.
//
// The existing listing observer states which releases and assets an upstream
// publishes and whether that coverage is complete. It never reads bytes, so a
// filename is all it knows, and a filename never authorizes a runtime. This
// worker reads the exact bytes of the latest stable release's archives through
// Core (`portcove --json catalog inspect-listing-artifact`, which executes
// nothing) and records each archive's player candidates with platform-true
// header machine and SHA-256 as an `exact-release-structured` fact. Core's
// filename classifier (`portcove --json catalog classify-listing-names`) can
// only veto: an archive whose name says server, installer, tool, a non-desktop
// system, or a system or architecture none of its players has is
// contradictory and never enrolls. The generated registration route reads only
// these facts (`scripts/catalog-generated-registration.mts`).
//
// Unthrottled, resumable and never stalled:
//  - Every observed identity is evaluated each run. Unchanged releases are
//    reconfirmed from the facts already held, without reading bytes.
//  - Permanent cases are completed as ineligible with a reason and
//    re-evaluated only when the release changes: no stable release, no
//    package, only unsupported desktop forms (recorded), only non-desktop
//    forms, an archive without a provider digest, a transient failure that
//    outlasted the retention bound (with its typed cause), invalid facts
//    (including a malformed or unclassifiable newer release), or a changed
//    repository id. No size or count bound completes an identity.
//  - A permanent Core refusal is scoped to its archive: the archive is
//    recorded with a bounded refusal class and never offered, and the other
//    archives still decide their platforms.
//  - Every entry records the observed releases (for the release-line rule)
//    and the release's other package forms (`otherPackagesOf`: non-archive
//    desktop packages, bare binaries and unread containers) with the
//    provider's size and digest and the platforms each serves, never their
//    bytes (another package that is not the archive's own player for a
//    platform means the release offers a different program there). A listing whose release URL
//    names a tag is read on that tag's release line only.
//  - Candidates are the authored listing-only identities, including those
//    the generated route already offers (`workerRecords`), so offered
//    identities are refreshed with everything else.
//  - Every entry records the package forms of its release it does not read
//    (`unread_forms`), also beside a supported archive.
//  - Each identity is evaluated alone: a name Core cannot classify, a
//    malformed observation or any unexpected failure settles that identity as
//    `invalid-facts` and never fails the run.
//  - Every identity that needs bytes is inspected, one archive at a time,
//    with no identity or byte bound. Each identity has the time CI can
//    reproduce it in (`identityBudgetMinutes`; over it, `runner-time`), and
//    a deadline (a shard's real time limit) stops a run; what it cuts stays
//    pending (`WorkerState.pending`) and an unsharded next run inspects it
//    last. A sharded run plans (`inspectBytes: false`, `pending: []`),
//    inspects each shard (`only`) on the plan's table and merges the shards
//    (`combineShards`).
//  - A non-complete upstream observation (rate limit, not found, partial)
//    keeps the last-good complete facts for `lastGoodRetentionDays`; the
//    worker's own backlog (`pending-inspection`) is not an upstream attempt
//    and only the facts age bounds it. A complete observation that no longer
//    fits withdraws immediately.
//  - Every derived entry lands in the worker's table: the worker has no batch
//    bound (the scheduled job carries what one batch may not land). A run whose
//    deadline left work pending but that settled nothing reports
//    `no_progress: true`.
//
//   node scripts/listing-package-facts.mts --check
//   node scripts/listing-package-facts.mts derive --observations REPORT.json \
//     --cli PORTCOVE [--state STATE.json] [--output TABLE.json] [--now ISO] \
//     [--plan true --needs FILE | --only FILE --deadline ISO] \
//     [--workflow-run-id ID --source-commit SHA --inputs-sha256 SHA] [--report FILE] [--result FILE]
//   node scripts/listing-package-facts.mts combine --plan RESULT --shards DIR \
//     [--output TABLE.json] [--state STATE.json] [--report FILE] \
//     [--workflow-run-id ID --source-commit SHA --inputs-sha256 SHA --cli PORTCOVE]
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseCatalogSource, readCatalogSource, type AuthoredPort } from "./catalog-authoring.mts";
import {
  archiveForms,
  boundReleaseLine,
  fitContext,
  identityBudgetMinutes,
  reproductionBatchEntries,
  releaseLine,
  type Generation,
  type OtherPackage,
  otherPackageForm,
  otherPackagePlatforms,
  type ObservedReleaseFact,
  type RefusalClass,
  type RefusedArchive,
  bundledToolchain,
  toolchainNames,
  channelOnlyTag,
  listingCounts,
  listingWords,
  lineStatement,
  refusalReceipt,
  failureCauses,
  compareCodePoints,
  type FailureCause,
  checkFactsProvenance,
  checkListingFactsEntry,
  checkListingFactsTable,
  digestOf,
  emptyFactsTable,
  FACTS_PARSER,
  FACTS_PARSER_VERSION,
  fitDecision,
  lastGoodRetentionDays,
  machineSystem,
  nameContradicts,
  nonDesktopForms,
  packageFormOf,
  roles,
  unreadForms,
  type ArtifactFactV2,
  type ExcludedPlayer,
  type FactsProvenance,
  type IneligibleReason,
  type ListingFactsEntry,
  type ListingFactsTable,
  type NameSuggestion,
  type PlayerFact,
  type Role,
} from "./catalog-generated-registration.mts";
import {
  listingPackageLimit,
  listingProviderIdentity,
  listingReleaseLimit,
} from "./listing-upstream-observation.mts";
import { isRecord } from "./runtime-values.mts";
import { releaseTextFact, type ReleaseTextFact } from "./upstream-observer.mts";

export interface RetryItem {
  port_id: string;
  since: string;
  failures: number;
  /** The last failure's typed cause. */
  cause?: FailureCause;
}
export interface WorkerState {
  format: 3;
  /**
   * The resumable cursor: identities whose inspection a run's deadline cut,
   * in the order they wait. The next run inspects them first.
   */
  pending: string[];
  /** Transiently incomplete identities, retried oldest first. */
  retry: RetryItem[];
  /**
   * Entries the scheduled job derived but carried to a later batch
   * (`scripts/listing-facts-batch.mts` `carryOver`), oldest wait first. Each
   * keeps when it was first carried (`since`, so a later batch lands the
   * longest-waiting entries first) and the entry it derived, whose artifacts
   * are inspection receipts per digest-bound archive: reused like a committed
   * entry's (`reusable`) while the repository id and the parser version still
   * match, so an unchanged release is not downloaded again. Its refusals are
   * not reused: an ineligible verdict lands without reproduction.
   * A receipt grants nothing: a carried entry is reproduced from its bytes
   * when its batch lands, like any other. Absent when nothing is carried.
   */
  carried?: CarriedItem[];
}
export interface CarriedItem {
  since: string;
  entry: ListingFactsEntry;
}
export const initialState = (): WorkerState => ({ format: 3, pending: [], retry: [] });

export interface ObservedAsset {
  id: number;
  name: string;
  url: string;
  size: number;
  sha256: string | null;
}
export interface ObservedRelease {
  id: number;
  version: string;
  published_at: string | null;
  provider_prerelease: boolean;
  assets_complete: boolean;
  assets: ObservedAsset[];
  /** Asset records in this release the worker cannot read; never dropped silently. */
  malformed_assets: number;
  /**
   * The release's own text as the observer reported it (its name and its
   * body's judged line, `bodyFirstLine`, and whether that text was kept
   * whole), or null when the report carries neither: UNKNOWN optional
   * evidence. The line is never recorded; only the statement it makes is.
   */
  text: ReleaseTextFact | null;
}
/**
 * A failed inspection. `permanent` failures are not retried for this release:
 * the archive is recorded as refused with its bounded `refusal` class.
 */
export class InspectionError extends Error {
  readonly permanent: boolean;
  readonly refusal: RefusalClass;
  /** The typed cause a transient failure is reported with. */
  readonly cause: FailureCause;
  constructor(
    message: string,
    permanent: boolean,
    refusal: RefusalClass = "core-unknown",
    cause: FailureCause = permanent ? refusal : "unreadable-archive",
  ) {
    super(message);
    this.permanent = permanent;
    this.refusal = refusal;
    this.cause = cause;
  }
}
/** The typed cause of a failed inspection, bounded to `failureCauses`. */
export const failureCauseOf = (error: unknown): FailureCause =>
  error instanceof InspectionError
    ? error.cause
    : error instanceof OverBudgetError
      ? "over-budget"
      : "unreadable-archive";
/**
 * The caller's wall-clock deadline (epoch ms) ran out before or during one
 * download or Core run. Reproduction names it an `over-budget` refusal; it is
 * never a fact about the bytes.
 */
export class OverBudgetError extends Error {}
/** What Core read from one archive: its player candidates and its listing as names. */
export interface ArchiveInspection {
  players: PlayerFact[];
  /** Every distinct lowercase path component of the archive's files (Core's `names`). */
  names: string[];
  /** Every distinct lowercase file name of the archive's files (Core's `leaves`). */
  leaves: string[];
}
/** Reads verified archive bytes and returns their inspection; throws on failure. */
export type ByteInspector = (
  asset: ObservedAsset,
  readerPlatform: string,
  /** A deadline (epoch ms) for this read only, earlier than the inspector's own. */
  deadline?: number,
) => Promise<ArchiveInspection>;
/** Core's `catalog.classify-listing-names` data. */
export interface NameClassification {
  filename_rule_version: number;
  releases: { tag: string; provider_prerelease: boolean; prerelease: boolean }[];
  assets: {
    name: string;
    role: Role;
    os: string;
    arch: string;
    tool_token: string | null;
    system_token: string | null;
  }[];
  programs: { name: string; tool_token: string | null }[];
}
export type NameClassifier = (input: {
  releases: { tag: string; provider_prerelease: boolean }[];
  assets: string[];
  programs: string[];
}) => Promise<NameClassification>;

const sha = /^[a-f0-9]{64}$/u;
const day = 86_400_000;

interface Observation {
  /** The repository the observer resolved, possibly renamed. */
  observed: string;
  repositoryId: number | null;
  status: string;
  observedAt: string | null;
  releases: ObservedRelease[];
  /** Release records the observer reported in a shape the worker cannot read. */
  malformedReleases: number;
}

/**
 * The records the worker reads: the authored records before generated
 * registration routes are added. A generated route is not an authored
 * integration, so an identity the generated route already offers stays a
 * candidate: its facts are refreshed, and its withdrawal is classified by
 * the batch job (`withdrawalCauses`). Reading the assembled records instead would make every
 * enrolled identity look operational and drop its facts on the next run.
 * Every generated enrollment must name an authored listing-only GitHub
 * identity; anything else is a broken catalog assembly.
 */
export function workerRecords(source: {
  authored: readonly AuthoredPort[];
  generation: Pick<Generation, "enrollments">;
}): readonly AuthoredPort[] {
  const candidates = listingOnly(source.authored);
  for (const enrollment of source.generation.enrollments)
    if (!candidates.has(enrollment.port_id))
      throw new Error(
        `Generated registration ${enrollment.port_id} has no authored listing-only GitHub record.`,
      );
  return source.authored;
}

/**
 * Authored listing-only GitHub identities the generated route could serve,
 * including those it already offers: id -> listed repository.
 */
export function listingOnly(records: readonly AuthoredPort[]) {
  return new Map(
    records
      .filter((record) => record.integration === undefined)
      .flatMap((record) => {
        const identity = listingProviderIdentity(record.listing);
        return identity?.provider === "github" ? [[record.listing.id, identity.repository]] : [];
      }),
  );
}

/**
 * Every candidate identity's bound release line (`boundReleaseLine`, null
 * when unbound): the line the worker chooses the newest stable release from.
 */
export function boundLinesOf(records: readonly AuthoredPort[]): Map<string, string | null> {
  const candidates = listingOnly(records);
  return new Map(
    records
      .filter((record) => candidates.has(record.listing.id))
      .map((record) => [record.listing.id, boundReleaseLine(record)] as const),
  );
}

function observations(candidates: Map<string, string>, report: unknown) {
  const entries: unknown =
    isRecord(report) && Array.isArray(report.listings) ? report.listings : report;
  if (!Array.isArray(entries)) throw new Error("Observer report needs a listings array.");
  const result = new Map<string, Observation>();
  for (const raw of entries) {
    const update: unknown =
      isRecord(raw) && isRecord(raw.listing_update) ? raw.listing_update : raw;
    if (!isRecord(update) || typeof update.id !== "string" || !candidates.has(update.id)) continue;
    const observation = update.upstream_observation;
    if (!isRecord(observation) || observation.provider !== "github") continue;
    result.set(update.id, {
      observed: typeof observation.repository === "string" ? observation.repository : "",
      repositoryId:
        Number.isSafeInteger(observation.repository_id) && Number(observation.repository_id) > 0
          ? Number(observation.repository_id)
          : null,
      status: typeof observation.status === "string" ? observation.status : "failed",
      observedAt: typeof observation.observed_at === "string" ? observation.observed_at : null,
      releases: releasesOf(observation),
      malformedReleases:
        (Array.isArray(observation.releases) ? observation.releases.length : 0) -
        releasesOf(observation).length,
    });
  }
  return result;
}

/** An asset record the worker can read: positive id, name, URL and size. */
function readableAsset(asset: unknown) {
  return (
    isRecord(asset) &&
    Number.isSafeInteger(asset.id) &&
    Number(asset.id) > 0 &&
    typeof asset.name === "string" &&
    typeof asset.url === "string" &&
    Number.isSafeInteger(asset.size)
  );
}

/**
 * Why the release list cannot be ordered or read, if it cannot: the newest
 * release (highest id) has no parseable publication time, so the latest
 * stable release is unknown; or the release that would be offered, or a newer
 * one, holds an asset record the worker cannot read.
 */
export function unreadableReleases(
  releases: readonly ObservedRelease[],
  chosen: ObservedRelease | undefined,
): string | undefined {
  const newest = releases.toSorted((left, right) => right.id - left.id)[0];
  if (newest && Number.isNaN(Date.parse(newest.published_at ?? "")))
    return `The newest release (id ${newest.id}) has no parseable publication time, so the latest stable release is unknown.`;
  const relevant = releases.filter(
    (release) =>
      release === chosen ||
      (chosen !== undefined &&
        (Date.parse(release.published_at ?? "") || 0) >=
          (Date.parse(chosen.published_at ?? "") || 0)),
  );
  const malformed = (chosen ? relevant : releases).reduce(
    (sum, release) => sum + release.malformed_assets,
    0,
  );
  if (malformed > 0)
    return `The observation holds ${malformed} release asset record(s) the worker cannot read, so the release's packages are unknown.`;
  return undefined;
}

/**
 * A release's own text as an observer report (or the provider) states it.
 * The observer's kept text (`name`, `body_line`, `body_line_complete`) is
 * the judged line already; a whole `body` (the provider's own release, or an
 * older report) is read to its judged line here (`releaseTextFact`), so both
 * read alike. Null when the report states no text at all.
 */
export function reportedText(release: Record<string, unknown>): ReleaseTextFact | null {
  if (Object.hasOwn(release, "body_line") || Object.hasOwn(release, "body_line_complete"))
    return {
      title: typeof release.name === "string" ? release.name : null,
      line: typeof release.body_line === "string" ? release.body_line : null,
      line_complete: release.body_line_complete === true,
    };
  return (
    releaseTextFact({
      ...(Object.hasOwn(release, "name") ? { name: release.name } : {}),
      ...(Object.hasOwn(release, "body") ? { body: release.body } : {}),
    }) ?? null
  );
}

function releasesOf(observation: Record<string, unknown>): ObservedRelease[] {
  return (Array.isArray(observation.releases) ? observation.releases : []).flatMap(
    (release: unknown) =>
      isRecord(release) &&
      Number.isSafeInteger(release.id) &&
      Number(release.id) > 0 &&
      typeof release.version === "string" &&
      Array.isArray(release.assets)
        ? [
            {
              id: Number(release.id),
              version: release.version,
              published_at: typeof release.published_at === "string" ? release.published_at : null,
              provider_prerelease: release.provider_prerelease === true,
              assets_complete: release.assets_complete === true,
              text: reportedText(release),
              malformed_assets: release.assets.filter((asset: unknown) => !readableAsset(asset))
                .length,
              assets: release.assets.flatMap((asset: unknown) =>
                isRecord(asset) &&
                Number.isSafeInteger(asset.id) &&
                Number(asset.id) > 0 &&
                typeof asset.name === "string" &&
                typeof asset.url === "string" &&
                Number.isSafeInteger(asset.size)
                  ? [
                      {
                        id: Number(asset.id),
                        name: asset.name,
                        url: asset.url,
                        size: Number(asset.size),
                        sha256:
                          typeof asset.sha256 === "string" && sha.test(asset.sha256)
                            ? asset.sha256
                            : null,
                      },
                    ]
                  : [],
              ),
            },
          ]
        : [],
  );
}

/**
 * The latest stable release by Core's prerelease rule: newest publication,
 * then highest id. A newer release whose tag Core did not classify is never
 * skipped as a prerelease: it is returned as `unclassified`, so the identity
 * records invalid facts instead of silently falling back to an older release.
 */
export function latestStable(
  releases: readonly ObservedRelease[],
  verdict: (r: ObservedRelease) => boolean | undefined,
): { release?: ObservedRelease; unclassified?: ObservedRelease } {
  const ordered = releases.toSorted(
    (left, right) =>
      (Date.parse(right.published_at ?? "") || 0) - (Date.parse(left.published_at ?? "") || 0) ||
      right.id - left.id,
  );
  for (const release of ordered) {
    const prerelease = verdict(release);
    if (prerelease === undefined) return { unclassified: release };
    if (!prerelease) return { release };
  }
  return {};
}

export const isArchive = (name: string) =>
  (archiveForms as readonly string[]).includes(packageFormOf(name) ?? "");
/** Sorted, unique package forms of these assets that the worker does not read. */
const unreadFormsOf = (release: ObservedRelease | undefined) =>
  [
    ...new Set(
      (release?.assets ?? []).flatMap((asset) => {
        const form = packageFormOf(asset.name);
        return form && !(archiveForms as readonly string[]).includes(form) ? [form] : [];
      }),
    ),
  ].toSorted(compareCodePoints);
/** A tag as the facts record it: bounded printable text, else unknown (null). */
export const recordedTag = (version: string): string | null =>
  version.length > 0 &&
  Buffer.byteLength(version) <= 256 &&
  version.trim() === version &&
  !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u.test(version)
    ? version
    : null;
/**
 * The release's other package forms (`otherPackageForm`) in ascending asset
 * id, with the provider's size and digest and the platforms each form serves:
 * a container's by Core's verdict on its name (`suggestion`; every platform
 * when Core did not classify it). Their bytes are never downloaded: an asset
 * without a provider digest is recorded as unknown (null) and excludes the
 * platforms it serves unless the digest is known to equal an offered player.
 */
export const otherPackagesOf = (
  release: ObservedRelease,
  suggestion: (name: string) => NameSuggestion | undefined,
): OtherPackage[] =>
  release.assets
    .filter((asset) => otherPackageForm(asset.name) !== undefined)
    .map((asset) => ({
      asset_id: asset.id,
      name: asset.name,
      size: asset.size,
      sha256: asset.sha256,
      platforms: otherPackagePlatforms(
        asset.name,
        otherPackageForm(asset.name) === "container" ? suggestion(asset.name) : undefined,
      ),
    }))
    .toSorted((left, right) => left.asset_id - right.asset_id);
/**
 * The name of every release asset that is neither a recorded artifact nor a
 * refused archive (`read`), in ascending asset id: the gate classifies these
 * itself.
 */
export const otherAssetNames = (release: ObservedRelease, read: readonly number[]) =>
  release.assets
    .filter((asset) => !read.includes(asset.id))
    .toSorted((left, right) => left.id - right.id)
    .map((asset) => asset.name);
/** Names of the release's unread containers, whose name verdicts decide their platforms. */
export const containerNames = (release: ObservedRelease | undefined) =>
  (release?.assets ?? [])
    .filter((asset) => otherPackageForm(asset.name) === "container")
    .map((asset) => asset.name);
/**
 * Observed releases as the facts record them, in ascending release id: the
 * tag, Core's verdict from the provider flag and tag alone (`core_prerelease`,
 * null when Core gave none), the verdict with the release's own text
 * (`prerelease`: Core's, or a statement the text makes), the publication
 * time and whether a package file is among the assets. Null fields are
 * unknown.
 */
export const observedReleaseFacts = (
  releases: readonly ObservedRelease[],
  core: (release: ObservedRelease) => boolean | undefined,
  repository: string,
  listing: readonly string[] = [],
): ObservedReleaseFact[] =>
  releases
    .toSorted((left, right) => left.id - right.id)
    .map((release) => {
      const published = Date.parse(release.published_at ?? "");
      const text = releaseTextFacts(release, repository, listing);
      const verdict = core(release);
      return {
        release_id: release.id,
        tag: recordedTag(release.version),
        core_prerelease: verdict ?? null,
        prerelease: verdict === undefined ? null : verdict || text.statement !== null,
        published_at: Number.isNaN(published) ? null : new Date(published).toISOString(),
        packaged: release.assets.some((asset) => packageFormOf(asset.name) !== undefined),
        ...text,
      };
    });
/**
 * What the facts record of a release's own text: whether it is observed, the
 * title when it is bounded printable text (`recordedTag`'s class), and the
 * prerelease statement the title or the body's judged line makes
 * (`lineStatement`, with the listing's own words, `listingWords`). Text the
 * observer did not report, or did not keep (its source over its text
 * budget) while nothing states a prerelease, is `unobserved`: absence is
 * never inferred from it. The body is never recorded.
 */
export const releaseTextFacts = (
  release: ObservedRelease,
  repository: string,
  listing: readonly string[] = [],
): Pick<ObservedReleaseFact, "text" | "title" | "statement"> => {
  if (release.text === null) return { text: "unobserved", title: null, statement: null };
  const judged = lineStatement(
    release.text.title,
    release.text.line,
    release.text.line_complete,
    repository,
    listing,
  );
  return judged.observed
    ? {
        text: "observed",
        title: release.text.title === null ? null : recordedTag(release.text.title),
        statement: judged.statement,
      }
    : { text: "unobserved", title: null, statement: null };
};
/**
 * The releases a listing observation keeps from a provider list: the newest
 * `listingReleaseLimit` by publication time (then id), each with at most
 * `listingPackageLimit` assets, as the observer selects them.
 */
export const observerWindow = (releases: readonly ObservedRelease[]): ObservedRelease[] =>
  releases
    .toSorted(
      (left, right) =>
        Date.parse(right.published_at ?? "") - Date.parse(left.published_at ?? "") ||
        right.id - left.id,
    )
    .slice(0, listingReleaseLimit)
    .map((release) => ({ ...release, assets: release.assets.slice(0, listingPackageLimit) }));
/** Reader rules only; TAR.XZ is read by the Linux reader. */
export const readerPlatform = (name: string) =>
  name.toLowerCase().endsWith(".tar.xz") ? "linux-x86-64" : "windows-x86-64";

const agreed = (values: string[]) =>
  values.length && values.every((value) => value === values[0]) ? values[0]! : "unknown";

/**
 * One archive's structural fact. Native players make the structural claim
 * `desktop-game-runtime`; Core's filename classification can only veto it: a
 * name suggesting a non-runtime role, a tool or non-desktop system, or a
 * system or architecture that none of the players' platform-true header
 * machines has, makes it contradictory (`nameContradicts`). `os` and `arch`
 * summarize the kept players; the fit reads each player's own machine.
 */
export function artifactFact(
  asset: ObservedAsset & { sha256: string },
  candidates: readonly PlayerFact[],
  suggestion: NameSuggestion,
  programToken: (name: string) => string | null,
  toolchain: readonly string[] = [],
  counts: ArtifactFactV2["listing_counts"] = { leaves: 0, source_leaves: 0 },
): ArtifactFactV2 {
  // Core's listing-only tool veto excludes a player, never the whole archive;
  // a tool token in the archive's own name vetoes the archive below.
  const players: PlayerFact[] = [];
  const excluded: ExcludedPlayer[] = [];
  for (const candidate of candidates) {
    const player = {
      path: candidate.path,
      display_path: candidate.display_path,
      machine: candidate.machine,
      sha256: candidate.sha256,
    };
    const token = programToken(basenameOf(candidate.display_path));
    if (token === null) players.push(player);
    else excluded.push({ ...player, token });
  }
  const systems = players.map(({ machine }) => machineSystem(machine));
  const os = agreed(systems.map((system) => system.os));
  const arch = agreed(systems.map((system) => system.arch));
  const contradictory = nameContradicts(suggestion, players);
  return {
    asset_id: asset.id,
    name: asset.name,
    size: asset.size,
    sha256: asset.sha256,
    role: players.length ? "desktop-game-runtime" : "unknown",
    os,
    arch,
    source: {
      kind: "exact-release-structured",
      shape_version: 2,
      archive_sha256: asset.sha256,
    },
    name_suggestion: suggestion,
    players: players.toSorted((left, right) => compareCodePoints(left.path, right.path)),
    excluded_players: excluded.toSorted((left, right) => compareCodePoints(left.path, right.path)),
    contradictory,
    toolchain_names: [...toolchain],
    bundled_toolchain: bundledToolchain(toolchain),
    listing_counts: { ...counts },
  };
}

const basenameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** Every program an artifact fact recorded, kept or excluded, as Core reported it. */
const candidatesOf = (artifact: ArtifactFactV2): PlayerFact[] =>
  [...artifact.players, ...artifact.excluded_players].map(
    ({ path, display_path, machine, sha256 }) => ({ path, display_path, machine, sha256 }),
  );

export interface DeriveInputs {
  records: readonly AuthoredPort[];
  observerReport: unknown;
  table: unknown;
  state?: WorkerState;
  inspect: ByteInspector;
  classify: NameClassifier;
  now: string;
  /** Recorded in the table by an unattended run; absent for local runs. */
  provenance?: FactsProvenance;
  /**
   * Evaluate only these identities (one shard); every other entry stays as
   * the previous table has it. Absent: every observed identity.
   */
  only?: readonly string[];
  /**
   * False plans a sharded run: everything that needs no bytes is settled, and
   * every identity that needs bytes is left pending and listed in `needs`.
   */
  inspectBytes?: boolean;
  /**
   * Epoch ms after which no further identity's inspection starts and a
   * download or Core run in progress is cut (pass the same deadline to the
   * inspector): the shard's real time limit. Cut identities stay pending
   * (`WorkerState.pending`); an unsharded next run inspects them last. A
   * sharded run's plan reads no bytes and returns `pending: []`, so its
   * shards order a cut identity like any other (retry age, then port_id).
   */
  deadline?: number;
  /**
   * The time one identity's inspection may take, in milliseconds: by default
   * `identityBudgetMinutes` of the entries one batch can land (the candidate
   * count, at most `reproductionBatchEntries`), so CI can reproduce what the
   * worker settles. Over it the identity is a `runner-time` failure.
   */
  identityBudgetMs?: number;
}
export interface ReportRow {
  port_id: string;
  outcome:
    | "complete"
    | "unchanged"
    | "ineligible"
    | "retained-last-good"
    | "unknown"
    | "pending-shard"
    | "deferred-deadline";
  reason?: string;
  inspected: number;
  reused: number;
}
export interface DeriveResult {
  table: ListingFactsTable;
  state: WorkerState;
  report: ReportRow[];
  /** Identities whose facts were completed as ineligible, by reason. */
  ineligible: Record<string, number>;
  bytes: number;
  /**
   * The worker's own inspection backlog, left by a deadline (or by a plan
   * for its shards); never counted as an upstream attempt.
   */
  backlog: Backlog;
  /** Identities that need bytes, with their unread archive bytes, in port_id order. */
  needs: { port_id: string; bytes: number }[];
  /** Candidate identities the observer report did not cover, in port_id order. */
  unobserved: string[];
  /** Identities this run settled into the table: complete, or newly ineligible. */
  settled: number;
  /**
   * True when a deadline left work pending but this run settled no identity:
   * a whole run could not finish one identity, so a person should look.
   */
  no_progress: boolean;
}
export interface Backlog {
  /** Offered identities whose inspection is pending. */
  enrolled_pending: number;
  /** Identities not yet offered whose inspection is pending. */
  new_pending: number;
  /** Unread archive bytes of every pending identity. */
  bytes_pending: number;
}

/** Display-safe placeholder for a value that failed validation. */
export const safeText = (value: string, fallback: string) =>
  /^[\x20-\x7e]{1,256}$/u.test(value) && value.trim() === value ? value : fallback;

export const assetsDigest = (release: ObservedRelease | undefined) =>
  digestOf(
    (release?.assets ?? [])
      .map(({ id, name, size, sha256 }) => [id, name, size, sha256])
      .toSorted((left, right) => Number(left[0]) - Number(right[0])),
  );

/** Core refuses a classification request holding a longer name. */
export const maximumNameBytes = 1024;
/**
 * Names one classification request carries: Core's own request bounds
 * (`MAXIMUM_CLASSIFIED_NAMES` names in `package_shape/listing.rs`, and the
 * CLI's 8 MiB input in `crates/portcove-cli/src/main.rs`). Each name is
 * costed at its JSON text plus 64 bytes, more than any item's framing, and
 * the request envelope is reserved.
 */
const chunkNames = 50_000;
const chunkBytes = 8 * 1024 * 1024 - 1024;
/** A name Core can classify: well-formed Unicode within Core's byte bound. */
export const sendableName = (name: string) =>
  name.isWellFormed() && Buffer.byteLength(name) <= maximumNameBytes;

type TagInput = { tag: string; provider_prerelease: boolean };
const tagKey = (release: TagInput) => `${release.provider_prerelease ? 1 : 0}:${release.tag}`;
const probe = {
  releases: [{ tag: "v1.0", provider_prerelease: false }],
  assets: ["Game-v1.0-windows-x64.zip"],
  programs: ["Game.exe"],
};

/**
 * Core's verdicts for names, collected across requests. One name never fails
 * a run: names Core cannot take are not sent, and a refused request is split
 * until the refused name is isolated and left unclassified. Only a refused
 * known-good probe (an unusable CLI) fails the run.
 */
export class NameVerdicts {
  readonly #classify: NameClassifier;
  readonly #prerelease = new Map<string, boolean>();
  readonly #assets = new Map<string, NameSuggestion>();
  readonly #programs = new Map<string, string | null>();
  readonly #tried = new Set<string>();
  constructor(classify: NameClassifier) {
    this.#classify = classify;
  }
  static async start(classify: NameClassifier) {
    const verdicts = new NameVerdicts(classify);
    if (!(await verdicts.#request(probe)))
      throw new Error("Core refused a known-good name classification; the CLI is unusable.");
    return verdicts;
  }
  /**
   * The prerelease verdict, or undefined when Core did not classify the tag:
   * Core's reviewed rule, and a tag of only channel words with a date, time
   * or hash (`channelOnlyTag`) even when the provider does not flag it.
   */
  prerelease(release: { version: string; provider_prerelease: boolean }) {
    const verdict = this.#prerelease.get(
      tagKey({ tag: release.version, provider_prerelease: release.provider_prerelease }),
    );
    return verdict === undefined
      ? undefined
      : verdict || channelOnlyTag(recordedTag(release.version));
  }
  /** The asset name's suggestion, or undefined when Core did not classify it. */
  suggestion(name: string) {
    return this.#assets.get(name);
  }
  /** The program name's tool token (null for none), or undefined when unclassified. */
  programToken(name: string) {
    return this.#programs.get(name);
  }
  async add(input: { releases?: TagInput[]; assets?: string[]; programs?: string[] }) {
    const fresh = <T,>(values: T[], key: (value: T) => string, name: (value: T) => string) => {
      const chosen = new Map<string, T>();
      for (const value of values) {
        const at = key(value);
        if (!sendableName(name(value)) || this.#tried.has(at)) continue;
        this.#tried.add(at);
        chosen.set(at, value);
      }
      return [...chosen.values()];
    };
    const items = [
      ...fresh(
        input.releases ?? [],
        (release) => `t${tagKey(release)}`,
        (release) => release.tag,
      ).map((release) => ({ kind: "releases" as const, value: release, name: release.tag })),
      ...fresh(
        input.assets ?? [],
        (name) => `a${name}`,
        (name) => name,
      ).map((name) => ({
        kind: "assets" as const,
        value: name,
        name,
      })),
      ...fresh(
        input.programs ?? [],
        (name) => `p${name}`,
        (name) => name,
      ).map((name) => ({
        kind: "programs" as const,
        value: name,
        name,
      })),
    ];
    let chunk: typeof items = [];
    let size = 0;
    const flush = async () => {
      if (chunk.length) await this.#split(chunk);
      chunk = [];
      size = 0;
    };
    for (const item of items) {
      const cost = Buffer.byteLength(JSON.stringify(item.name)) + 64;
      if (chunk.length >= chunkNames || size + cost > chunkBytes) await flush();
      chunk.push(item);
      size += cost;
    }
    await flush();
  }
  async #split(
    items: { kind: "releases" | "assets" | "programs"; value: unknown; name: string }[],
  ): Promise<void> {
    const ok = await this.#request({
      releases: items.flatMap((item) => (item.kind === "releases" ? [item.value as TagInput] : [])),
      assets: items.flatMap((item) => (item.kind === "assets" ? [item.name] : [])),
      programs: items.flatMap((item) => (item.kind === "programs" ? [item.name] : [])),
    });
    if (ok || items.length === 1) return;
    const half = Math.ceil(items.length / 2);
    await this.#split(items.slice(0, half));
    await this.#split(items.slice(half));
  }
  /** One request; records its verdicts only when the whole answer is well formed. */
  async #request(input: { releases: TagInput[]; assets: string[]; programs: string[] }) {
    let result: unknown;
    try {
      result = await this.#classify(input);
    } catch (error) {
      // A deadline is the caller's budget, not a verdict on these names.
      if (error instanceof OverBudgetError) throw error;
      return false;
    }
    if (
      !isRecord(result) ||
      !Number.isSafeInteger(result.filename_rule_version) ||
      Number(result.filename_rule_version) < 1 ||
      !Array.isArray(result.releases) ||
      !Array.isArray(result.assets) ||
      !Array.isArray(result.programs) ||
      result.releases.length !== input.releases.length ||
      result.assets.length !== input.assets.length ||
      result.programs.length !== input.programs.length
    )
      return false;
    const token = (value: unknown) =>
      value === null || (typeof value === "string" && /^[a-z0-9]{1,32}$/u.test(value));
    const releases = result.releases as unknown[];
    const assets = result.assets as unknown[];
    const programs = result.programs as unknown[];
    const wellFormed =
      releases.every(
        (release, index) =>
          isRecord(release) &&
          release.tag === input.releases[index]!.tag &&
          typeof release.prerelease === "boolean",
      ) &&
      assets.every(
        (asset, index) =>
          isRecord(asset) &&
          asset.name === input.assets[index] &&
          (roles as readonly unknown[]).includes(asset.role) &&
          typeof asset.os === "string" &&
          typeof asset.arch === "string" &&
          token(asset.tool_token) &&
          token(asset.system_token),
      ) &&
      programs.every(
        (program, index) =>
          isRecord(program) && program.name === input.programs[index] && token(program.tool_token),
      );
    if (!wellFormed) return false;
    const typed = result as unknown as NameClassification;
    for (const [index, release] of typed.releases.entries())
      this.#prerelease.set(tagKey(input.releases[index]!), release.prerelease);
    for (const asset of typed.assets)
      this.#assets.set(asset.name, {
        rule_version: typed.filename_rule_version,
        role: asset.role,
        os: asset.os,
        arch: asset.arch,
        tool_token: asset.tool_token,
        system_token: asset.system_token,
      });
    for (const program of typed.programs) this.#programs.set(program.name, program.tool_token);
    return true;
  }
}

export async function deriveListingFacts(inputs: DeriveInputs): Promise<DeriveResult> {
  const previous = inputs.table ?? emptyFactsTable();
  checkListingFactsTable(previous);
  const now = inputs.now;
  if (Number.isNaN(Date.parse(now)) || Date.parse(now) < Date.parse(previous.generated_at))
    throw new Error(
      `The worker clock (${now}) is before the facts table's generation time (${previous.generated_at}).`,
    );
  if (inputs.provenance !== undefined) checkFactsProvenance(inputs.provenance);
  const state = sanitizeState(inputs.state ?? initialState());
  const candidates = listingOnly(inputs.records);
  const recordById = new Map(inputs.records.map((record) => [record.listing.id, record]));
  /** The listing's own words, which release text is judged with (`listingWords`). */
  const wordsOf = (id: string) => {
    const record = recordById.get(id);
    return record ? listingWords(record.listing) : [];
  };
  const context = fitContext(inputs.records);
  // Facts bind to the repository the listing names; a re-pointed listing rebinds.
  const bound = (entry: ListingFactsEntry) =>
    candidates.get(entry.port_id)?.toLowerCase() === entry.repository.toLowerCase();
  const entries = new Map(
    previous.entries.filter(bound).map((entry) => [entry.port_id, entry] as const),
  );
  // Identities the previous table already offers: keeping them fresh comes
  // before growth.
  const offered = new Set(
    [...entries.values()]
      .filter((entry) => {
        const record = recordById.get(entry.port_id);
        return record ? fitDecision(record, entry, previous.generated_at, context).fit : false;
      })
      .map((entry) => entry.port_id),
  );
  const only = inputs.only === undefined ? undefined : new Set(inputs.only);
  const retry = new Map(
    state.retry.filter((item) => candidates.has(item.port_id)).map((item) => [item.port_id, item]),
  );
  /** Inspection receipts of carried entries (`WorkerState.carried`). */
  const receipts = new Map((state.carried ?? []).map((item) => [item.entry.port_id, item]));
  const observed = observations(
    only === undefined ? candidates : new Map([...candidates].filter(([id]) => only.has(id))),
    inputs.observerReport,
  );
  const complete = (observation: Observation) =>
    observation.status === "complete" && observation.repositoryId !== null;

  const names = await NameVerdicts.start(inputs.classify);
  await names.add({
    releases: [...observed.values()]
      .filter(complete)
      .flatMap((observation) => observation.releases)
      .map((release) => ({
        tag: release.version,
        provider_prerelease: release.provider_prerelease,
      })),
  });
  // A release whose own title or first body line states a prerelease is one
  // for the newest-stable choice, whatever the provider flag says.
  const verdictOf = (id: string) => (release: ObservedRelease) => {
    const verdict = names.prerelease(release);
    return verdict === undefined
      ? undefined
      : verdict || releaseTextFacts(release, candidates.get(id)!, wordsOf(id)).statement !== null;
  };
  // A listing whose release URL names a tag binds the identity to that tag's
  // release line: only that line's releases can be offered.
  const lineOf = (id: string, release: ObservedRelease) =>
    releaseLine(recordedTag(release.version), release.id, candidates.get(id)!);
  const choice = new Map(
    [...observed]
      .filter(([, observation]) => complete(observation))
      .map(([id, observation]) => {
        const record = recordById.get(id);
        const bound = record ? boundReleaseLine(record) : null;
        return [
          id,
          latestStable(
            bound === null
              ? observation.releases
              : observation.releases.filter((release) => lineOf(id, release) === bound),
            verdictOf(id),
          ),
        ];
      }),
  );
  const latest = new Map<string, ObservedRelease | undefined>(
    [...choice].map(([id, chosen]) => [id, chosen.release]),
  );
  await names.add({
    assets: [...latest.values()].flatMap((release) => [
      ...(release?.assets ?? [])
        .filter((asset) => isArchive(asset.name))
        .map((asset) => asset.name),
      ...containerNames(release),
    ]),
    programs: [...entries.values()].flatMap((entry) =>
      entry.artifacts.flatMap(candidatesOf).map((player) => basenameOf(player.display_path)),
    ),
  });

  const report: ReportRow[] = [];
  const ineligibleCounts: Record<string, number> = {};
  /** Identities whose new entry this run settled (complete or newly ineligible). */
  const settledIds = new Set<string>();
  const row = (
    port_id: string,
    outcome: ReportRow["outcome"],
    reason?: string,
    inspected = 0,
    reused = 0,
  ) => {
    const existing = report.findIndex((item) => item.port_id === port_id);
    if (existing >= 0) report.splice(existing, 1);
    report.push({ port_id, outcome, ...(reason ? { reason } : {}), inspected, reused });
  };

  const observationOf = (id: string, release: ObservedRelease | undefined) => {
    const observation = observed.get(id)!;
    const observedAt =
      observation.observedAt && !Number.isNaN(Date.parse(observation.observedAt))
        ? new Date(Math.min(Date.parse(observation.observedAt), Date.parse(now))).toISOString()
        : now;
    const published = release?.published_at ? Date.parse(release.published_at) : NaN;
    return {
      release_id: release?.id ?? null,
      tag: release ? safeText(release.version, `release-${release.id}`) : null,
      published_at: Number.isNaN(published) ? null : new Date(published).toISOString(),
      observed_at: observedAt,
      coverage: "complete" as ListingFactsEntry["observation"]["coverage"],
      assets_complete: release?.assets_complete ?? true,
      assets_sha256: assetsDigest(release),
    };
  };
  /** The observed releases, for the release-line rule; null fields are unknown. */
  const observedReleasesOf = (id: string): ObservedReleaseFact[] =>
    observedReleaseFacts(
      observed.get(id)!.releases,
      (release) => names.prerelease(release),
      candidates.get(id)!,
      wordsOf(id),
    );
  const base = (id: string, repositoryId: number) => ({
    port_id: id,
    provider: "github" as const,
    repository: candidates.get(id)!,
    repository_id: repositoryId,
    listing_words: wordsOf(id),
    parser: FACTS_PARSER,
    parser_version: FACTS_PARSER_VERSION,
  });
  const ineligible = (
    id: string,
    repositoryId: number,
    release: ObservedRelease | undefined,
    reason: IneligibleReason,
    detail: string,
    observation = observationOf(id, release),
    cause: FailureCause | null = null,
  ) => {
    const entry: ListingFactsEntry = {
      ...base(id, repositoryId),
      observation,
      ineligible: { reason, detail, cause },
      unread_forms: release ? unreadFormsOf(release) : (entries.get(id)?.unread_forms ?? []),
      observed_releases: [],
      other_packages: [],
      asset_names: [],
      refused_archives: [],
      attempt: null,
      artifacts: [],
    };
    checkListingFactsEntry(entry);
    const prior = entries.get(id);
    // Reconfirming the same verdict for the same release is not progress.
    if (
      prior?.ineligible?.reason !== reason ||
      prior.observation.release_id !== observation.release_id ||
      prior.observation.assets_sha256 !== observation.assets_sha256
    )
      settledIds.add(id);
    entries.set(id, entry);
    retry.delete(id);
    ineligibleCounts[reason] = (ineligibleCounts[reason] ?? 0) + 1;
    row(id, "ineligible", reason);
  };
  const invalid = (
    id: string,
    repositoryId: number,
    release: ObservedRelease | undefined,
    why: string,
  ) =>
    ineligible(
      id,
      repositoryId,
      release,
      "invalid-facts",
      safeText(why.slice(0, 500), "Observed facts failed validation."),
    );
  /**
   * Keep last-good complete facts through a non-complete upstream attempt,
   * within the retention bound. The worker's own backlog
   * (`pending-inspection`) is not an upstream attempt: upstream was complete,
   * so it starts no retention clock and leaves the entry unchanged once
   * recorded; only the facts age (`stale-facts`) bounds it.
   */
  const notComplete = (
    id: string,
    status: "partial" | "unavailable" | "failed" | "pending-inspection",
    outcome?: ReportRow["outcome"],
    reason: string = status,
  ) => {
    const prior = entries.get(id);
    if (!prior || prior.ineligible) {
      row(id, outcome ?? "unknown", reason);
      return;
    }
    if (status === "pending-inspection") {
      if (prior.attempt?.status !== "pending-inspection")
        entries.set(id, {
          ...prior,
          attempt: { status, first_at: now, last_at: now, failures: 1 },
        });
      row(id, outcome ?? "retained-last-good", reason);
      return;
    }
    const attempt =
      prior.attempt && prior.attempt.status !== "pending-inspection"
        ? { ...prior.attempt, status, last_at: now, failures: prior.attempt.failures + 1 }
        : { status, first_at: now, last_at: now, failures: 1 };
    if ((Date.parse(now) - Date.parse(attempt.first_at)) / day > lastGoodRetentionDays) {
      ineligible(
        id,
        prior.repository_id,
        undefined,
        "observation-unavailable",
        `Upstream stayed ${status} from ${attempt.first_at.slice(0, 10)}; last-good facts are kept for ${lastGoodRetentionDays} days.`,
        { ...prior.observation },
      );
      return;
    }
    entries.set(id, { ...prior, attempt });
    row(id, outcome ?? "retained-last-good", reason);
  };
  /** Facts for known candidates with Core's current name verdicts; undefined if a name is unclassified. */
  const factFor = (
    asset: ObservedAsset & { sha256: string },
    players: readonly PlayerFact[],
    toolchain: readonly string[],
    counts: ArtifactFactV2["listing_counts"],
  ) => {
    const suggestion = names.suggestion(asset.name);
    const programs = players.map((player) => basenameOf(player.display_path));
    if (!suggestion || programs.some((name) => names.programToken(name) === undefined))
      return undefined;
    return artifactFact(
      asset,
      players,
      suggestion,
      (name) => names.programToken(name)!,
      toolchain,
      counts,
    );
  };
  const unclassified =
    "A release file or program name could not be classified by Core (malformed, over 1,024 bytes or refused), so it cannot be vetoed.";
  /** A refused archive with Core's current name verdict; undefined if its name is unclassified. */
  const refusedFor = (
    asset: ObservedAsset & { sha256: string },
    refusal: RefusalClass,
  ): RefusedArchive | undefined => {
    const suggestion = names.suggestion(asset.name);
    return suggestion
      ? {
          asset_id: asset.id,
          name: asset.name,
          size: asset.size,
          sha256: asset.sha256,
          name_suggestion: suggestion,
          refusal,
        }
      : undefined;
  };
  const settle = (
    id: string,
    repositoryId: number,
    release: ObservedRelease,
    artifacts: (ArtifactFactV2 | undefined)[],
    refused: (RefusedArchive | undefined)[] = [],
  ) => {
    if ([...artifacts, ...refused].some((fact) => fact === undefined)) {
      invalid(id, repositoryId, release, unclassified);
      return false;
    }
    const entry: ListingFactsEntry = {
      ...base(id, repositoryId),
      observation: observationOf(id, release),
      ineligible: null,
      unread_forms: unreadFormsOf(release),
      observed_releases: observedReleasesOf(id),
      other_packages: otherPackagesOf(release, (name) => names.suggestion(name)),
      asset_names: otherAssetNames(
        release,
        [...(artifacts as ArtifactFactV2[]), ...(refused as RefusedArchive[])].map(
          (fact) => fact.asset_id,
        ),
      ),
      refused_archives: (refused as RefusedArchive[]).toSorted(
        (left, right) => left.asset_id - right.asset_id,
      ),
      attempt: null,
      artifacts: artifacts as ArtifactFactV2[],
    };
    try {
      checkListingFactsEntry(entry);
    } catch (error) {
      invalid(
        id,
        repositoryId,
        release,
        `Observed facts failed validation: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return false;
    }
    entries.set(id, entry);
    retry.delete(id);
    return true;
  };
  /**
   * One identity's evaluation. Anything unexpected settles this identity as
   * `invalid-facts`, or, when even that cannot be recorded, leaves its prior
   * entry unchanged; it never fails the run.
   */
  const isolated = async (id: string, work: () => void | Promise<void>) => {
    try {
      await work();
    } catch (error) {
      // The deadline is the shard's time limit, not a fact about the identity.
      if (error instanceof OverBudgetError) throw error;
      const why = `The worker could not evaluate this identity: ${error instanceof Error ? error.message : "unknown error"}`;
      const repositoryId = observed.get(id)?.repositoryId ?? entries.get(id)?.repository_id;
      try {
        if (!repositoryId) throw new Error("no repository id");
        const release = latest.get(id) ?? choice.get(id)?.unclassified;
        invalid(
          id,
          repositoryId,
          release && Number.isSafeInteger(release.id) ? release : undefined,
          why,
        );
      } catch {
        row(id, "unknown", "worker-error");
      }
    }
  };

  // Pass A: every observed identity, without reading bytes.
  type Need = {
    id: string;
    repositoryId: number;
    release: ObservedRelease;
    archives: (ObservedAsset & { sha256: string })[];
    reusable: Map<string, ArtifactFactV2>;
    reusableRefusals: Map<string, RefusalClass>;
    cost: number;
  };
  const needs: Need[] = [];
  const evaluate = (id: string) => {
    const observation = observed.get(id)!;
    const prior = entries.get(id);
    if (!complete(observation)) {
      notComplete(
        id,
        observation.status === "unavailable"
          ? "unavailable"
          : observation.status === "failed"
            ? "failed"
            : "partial",
      );
      return;
    }
    const repositoryId = observation.repositoryId!;
    if (prior && prior.repository_id !== repositoryId) {
      // A rename keeps the id; a different id is another repository (name
      // reuse or a re-created repository): withdraw and keep the bound id.
      if (prior.ineligible?.reason === "repository-identity-changed")
        row(id, "unchanged", "repository-identity-changed");
      else
        ineligible(
          id,
          prior.repository_id,
          undefined,
          "repository-identity-changed",
          `The listed repository now resolves to id ${repositoryId}, not the bound id ${prior.repository_id}.`,
          { ...prior.observation, observed_at: observationOf(id, undefined).observed_at },
        );
      return;
    }
    if (observation.malformedReleases > 0) {
      invalid(
        id,
        repositoryId,
        undefined,
        `The observation holds ${observation.malformedReleases} release record(s) the worker cannot read, so the latest stable release is unknown.`,
      );
      return;
    }
    const unreadable = unreadableReleases(
      observation.releases,
      choice.get(id)?.release ?? choice.get(id)?.unclassified,
    );
    if (unreadable) {
      invalid(id, repositoryId, undefined, unreadable);
      return;
    }
    const unclassifiedRelease = choice.get(id)?.unclassified;
    if (unclassifiedRelease) {
      // Never fall back to an older release past a tag Core could not judge.
      invalid(
        id,
        repositoryId,
        unclassifiedRelease,
        "A release newer than every stable release has a tag Core could not classify, so the latest stable release is unknown.",
      );
      return;
    }
    const release = latest.get(id);
    if (!release) {
      ineligible(
        id,
        repositoryId,
        undefined,
        "no-stable-release",
        "The complete observation lists no stable release.",
      );
      return;
    }
    if (!release.assets_complete) {
      notComplete(id, "partial");
      return;
    }
    const fingerprint = assetsDigest(release);
    const same = [prior].find(
      (entry) =>
        entry &&
        entry.observation.release_id === release.id &&
        entry.observation.assets_sha256 === fingerprint,
    );
    // A reproduction refusal stays while its receipt holds (the same
    // release, assets, observed release text verdicts and rule versions):
    // reconfirmed without downloading. Any change derives it again.
    const refusalHolds =
      same?.ineligible?.reason !== "reproduction-refused" ||
      same.ineligible.receipt ===
        refusalReceipt({
          repository_id: repositoryId,
          release_id: release.id,
          assets_sha256: fingerprint,
          observed_releases: observedReleasesOf(id),
        });
    if (
      same?.ineligible &&
      refusalHolds &&
      !["observation-unavailable", "repository-identity-changed"].includes(same.ineligible.reason)
    ) {
      // Completed ineligible for this exact release: reconfirm, do not retry.
      entries.set(id, {
        ...same,
        observation: { ...same.observation, observed_at: observationOf(id, release).observed_at },
      });
      retry.delete(id);
      ineligibleCounts[same.ineligible.reason] =
        (ineligibleCounts[same.ineligible.reason] ?? 0) + 1;
      row(id, "unchanged", same.ineligible.reason);
      return;
    }
    if (same && !same.ineligible) {
      const refreshed = same.artifacts.map((artifact) => {
        const asset = release.assets.find((candidate) => candidate.id === artifact.asset_id);
        return asset
          ? factFor(
              { ...asset, sha256: artifact.sha256 },
              candidatesOf(artifact),
              artifact.toolchain_names,
              artifact.listing_counts,
            )
          : undefined;
      });
      const refusals = same.refused_archives.map((archive) => {
        const asset = release.assets.find((candidate) => candidate.id === archive.asset_id);
        return asset
          ? refusedFor({ ...asset, sha256: archive.sha256 }, archive.refusal)
          : undefined;
      });
      if (settle(id, repositoryId, release, refreshed, refusals))
        row(id, "unchanged", undefined, 0, same.artifacts.length + same.refused_archives.length);
      return;
    }
    const archives = release.assets
      .filter((asset) => isArchive(asset.name))
      .toSorted((left, right) => left.id - right.id);
    if (!archives.length) {
      const forms = unreadFormsOf(release);
      const desktop = forms.filter((form) => (unreadForms as readonly string[]).includes(form));
      const mobile = forms.filter((form) => (nonDesktopForms as readonly string[]).includes(form));
      if (desktop.length)
        ineligible(
          id,
          repositoryId,
          release,
          "unsupported-archive-format",
          `The stable release has no ZIP, TAR.GZ or TAR.XZ archive; it has ${forms.join(", ")}.`,
        );
      else if (mobile.length)
        ineligible(
          id,
          repositoryId,
          release,
          "non-desktop-platform",
          `The stable release has only non-desktop packages: ${mobile.join(", ")}.`,
        );
      else
        ineligible(
          id,
          repositoryId,
          release,
          "no-release-archive",
          "The stable release has no package file.",
        );
      return;
    }
    // A name Core could not classify cannot be vetoed: never read its bytes.
    if (archives.some((asset) => !names.suggestion(asset.name))) {
      invalid(id, repositoryId, release, unclassified);
      return;
    }
    if (archives.some((asset) => !asset.sha256 || asset.size < 1)) {
      ineligible(
        id,
        repositoryId,
        release,
        "no-digest",
        "A release archive has no provider SHA-256, so its bytes cannot be bound.",
      );
      return;
    }
    // No size or count bound: the provider's own per-asset maximum bounds an
    // archive, and archives are read one at a time, so shard disk never
    // accumulates. Several archives for one platform are judged by the fit
    // rule (`ambiguous-artifact`), never by a count.
    const digestBound = archives as (ObservedAsset & { sha256: string })[];
    const receipt = receipts.get(id)?.entry;
    const receipted =
      receipt?.repository_id === repositoryId && receipt.parser_version === FACTS_PARSER_VERSION
        ? receipt
        : undefined;
    const reusable = new Map(
      [prior, receipted]
        .flatMap((entry) => entry?.artifacts ?? [])
        .map((artifact) => [`${artifact.asset_id}/${artifact.sha256}`, artifact] as const),
    );
    // A carried refusal is not reused: an ineligible verdict needs no
    // reproduction, so only a committed (reproduced) refusal may stand for
    // bytes not read again.
    const reusableRefusals = new Map(
      [prior]
        .flatMap((entry) => entry?.refused_archives ?? [])
        .map((archive) => [`${archive.asset_id}/${archive.sha256}`, archive.refusal] as const),
    );
    const cost = digestBound
      .filter(
        (asset) =>
          !reusable.has(`${asset.id}/${asset.sha256}`) &&
          !reusableRefusals.has(`${asset.id}/${asset.sha256}`),
      )
      .reduce((sum, asset) => sum + asset.size, 0);
    // The generated registration fit already requires the chosen release's
    // text. Acquire that upstream evidence before reading novel archive bytes.
    // Read-only package discovery and previously inspected bytes are independent.
    if (
      cost > 0 &&
      releaseTextFacts(release, candidates.get(id)!, wordsOf(id)).text !== "observed"
    ) {
      notComplete(id, "partial", undefined, "release-text-unobserved");
      return;
    }
    needs.push({
      id,
      repositoryId,
      release,
      archives: digestBound,
      reusable,
      reusableRefusals,
      cost,
    });
  };
  for (const id of [...observed.keys()].toSorted(compareCodePoints))
    await isolated(id, () => evaluate(id));

  // Pass B: inspect every identity that needs bytes, one archive at a time,
  // with no identity or byte bound. Transient failures go oldest first, then
  // the rest in port_id order, and identities a previous deadline cut go
  // last (only in an unsharded run: a sharded plan carries `pending: []`, so
  // its shards order a cut identity like any other). Each
  // identity has the time CI can reproduce it in (`identityBudgetMinutes`);
  // over it, it is a `runner-time` failure, and a second consecutive one
  // settles it ineligible with that cause. The shard deadline (the shard's
  // real time limit) stops the pass; what it cuts stays pending.
  let bytes = 0;
  const pastDeadline = () => inputs.deadline !== undefined && Date.now() >= inputs.deadline;
  const identityBudgetMs =
    inputs.identityBudgetMs ??
    identityBudgetMinutes(Math.min(candidates.size, reproductionBatchEntries)) * 60_000;
  const cut = new Set<string>();
  const inspectOne = async (need: Need) => {
    const found: {
      asset: ObservedAsset & { sha256: string };
      players: PlayerFact[];
      toolchain: readonly string[];
      counts: ArtifactFactV2["listing_counts"];
    }[] = [];
    const refused: { asset: ObservedAsset & { sha256: string }; refusal: RefusalClass }[] = [];
    let inspected = 0;
    let reused = 0;
    const identityDeadline = Date.now() + identityBudgetMs;
    // One identity that does not fit the per-identity budget CI can
    // reproduce in: retried once, then settled with the runner-time cause.
    const runnerTime = () => {
      const prior = retry.get(need.id);
      if (prior?.cause === "runner-time") {
        ineligible(
          need.id,
          need.repositoryId,
          need.release,
          "repeated-inspection-failure",
          `Inspection did not finish within the ${Math.floor(identityBudgetMs / 60_000)}-minute per-identity budget CI can reproduce, in two consecutive runs.`,
          undefined,
          "runner-time",
        );
        return;
      }
      retry.set(need.id, {
        port_id: need.id,
        since: prior?.since ?? now,
        failures: (prior?.failures ?? 0) + 1,
        cause: "runner-time",
      });
      notComplete(need.id, "failed");
    };
    for (const asset of need.archives) {
      const known = need.reusable.get(`${asset.id}/${asset.sha256}`);
      if (known) {
        // The recorded helper entries stand for the listing already read.
        found.push({
          asset,
          players: candidatesOf(known),
          toolchain: known.toolchain_names,
          counts: known.listing_counts,
        });
        reused++;
        continue;
      }
      const knownRefusal = need.reusableRefusals.get(`${asset.id}/${asset.sha256}`);
      if (knownRefusal) {
        refused.push({ asset, refusal: knownRefusal });
        reused++;
        continue;
      }
      if (Date.now() >= identityDeadline && !pastDeadline()) {
        runnerTime();
        return;
      }
      try {
        inspected++;
        bytes += asset.size;
        const inspection = await inputs.inspect(
          asset,
          readerPlatform(asset.name),
          identityDeadline,
        );
        found.push({
          asset,
          players: inspection.players,
          toolchain: toolchainNames(inspection.names, inspection.leaves),
          counts: listingCounts(inspection.leaves),
        });
      } catch (error) {
        // The shard deadline cut this identity: it is pending, not failed.
        if (error instanceof OverBudgetError && pastDeadline()) {
          cut.add(need.id);
          return;
        }
        // Its own budget ran out: the runner's time, not the bytes.
        if (error instanceof OverBudgetError) {
          runnerTime();
          return;
        }
        // A permanent refusal is scoped to its archive: it is recorded with
        // its bounded class, never offered, and the other archives still fit.
        if (error instanceof InspectionError && error.permanent) {
          refused.push({ asset, refusal: error.refusal });
          continue;
        }
        // A transient failure is retried every run; it settles only once it
        // has lasted longer than the last-good retention bound.
        const since = retry.get(need.id)?.since ?? now;
        const failures = (retry.get(need.id)?.failures ?? 0) + 1;
        const cause = failureCauseOf(error);
        if ((Date.parse(now) - Date.parse(since)) / day > lastGoodRetentionDays) {
          ineligible(
            need.id,
            need.repositoryId,
            need.release,
            "repeated-inspection-failure",
            `Inspection failed in ${failures} runs since ${since.slice(0, 10)}; the last cause was ${cause}.`,
            undefined,
            cause,
          );
          return;
        }
        retry.set(need.id, { port_id: need.id, since, failures, cause });
        notComplete(need.id, "failed");
        return;
      }
    }
    // Every archive of the bound release answered 404: upstream itself says
    // the release's packages are gone, which is no transient failure. One 404
    // among reachable archives stays that archive's own refusal.
    if (
      need.archives.length > 0 &&
      refused.length === need.archives.length &&
      refused.every(({ refusal }) => refusal === "asset-not-found")
    ) {
      ineligible(
        need.id,
        need.repositoryId,
        need.release,
        "upstream-unavailable",
        `Every archive of the release (${need.archives.length}) answered 404 Not Found, so upstream no longer serves its packages.`,
      );
      return;
    }
    await names.add({
      programs: found.flatMap(({ players }) =>
        players.map((player) => basenameOf(player.display_path)),
      ),
    });
    if (
      settle(
        need.id,
        need.repositoryId,
        need.release,
        found.map(({ asset, players, toolchain, counts }) =>
          factFor(asset, players, toolchain, counts),
        ),
        refused.map(({ asset, refusal }) => refusedFor(asset, refusal)),
      )
    ) {
      settledIds.add(need.id);
      row(need.id, "complete", undefined, inspected, reused);
    }
  };
  const waiting = new Map(state.pending.map((id, index) => [id, index]));
  const order = needs.toSorted(
    (left, right) =>
      Number(waiting.has(left.id)) - Number(waiting.has(right.id)) ||
      (waiting.get(left.id) ?? 0) - (waiting.get(right.id) ?? 0) ||
      compareCodePoints(retry.get(left.id)?.since ?? "~", retry.get(right.id)?.since ?? "~") ||
      compareCodePoints(left.id, right.id),
  );
  for (const need of order) {
    if (inputs.inspectBytes === false || pastDeadline()) {
      cut.add(need.id);
      continue;
    }
    try {
      await isolated(need.id, () => inspectOne(need));
    } catch (error) {
      if (!(error instanceof OverBudgetError)) throw error;
      cut.add(need.id);
    }
  }
  const pending = order.filter((need) => cut.has(need.id));
  for (const need of pending)
    await isolated(need.id, () =>
      notComplete(
        need.id,
        "pending-inspection",
        inputs.inspectBytes === false ? "pending-shard" : "deferred-deadline",
      ),
    );

  // Everything lands: there is no batch bound.
  const sorted = [...entries.values()]
    .filter((entry) => candidates.has(entry.port_id))
    .toSorted((left, right) => (left.port_id < right.port_id ? -1 : 1));
  const table: ListingFactsTable = {
    format: previous.format,
    generator: previous.generator,
    generated_at: now,
    ...(inputs.provenance ? { provenance: inputs.provenance } : {}),
    entries: sorted,
    entries_sha256: digestOf(sorted),
  };
  checkListingFactsTable(table);
  const settled = settledIds.size;
  const backlog: Backlog = {
    enrolled_pending: pending.filter((need) => offered.has(need.id)).length,
    new_pending: pending.filter((need) => !offered.has(need.id)).length,
    bytes_pending: pending.reduce((sum, need) => sum + need.cost, 0),
  };
  return {
    table,
    state: {
      format: 3,
      pending: inputs.inspectBytes === false ? [] : pending.map((need) => need.id),
      retry: [...retry.values()]
        .filter((item) => !entries.get(item.port_id)?.ineligible)
        .toSorted((left, right) => compareCodePoints(left.port_id, right.port_id)),
      // Only the scheduled job's carry step rewrites the carried entries.
      ...(state.carried?.length ? { carried: state.carried } : {}),
    },
    report,
    ineligible: ineligibleCounts,
    bytes,
    backlog,
    needs: needs
      .map((need) => ({ port_id: need.id, bytes: need.cost }))
      .toSorted((left, right) => compareCodePoints(left.port_id, right.port_id)),
    unobserved: [...candidates.keys()]
      .filter((id) => (only === undefined || only.has(id)) && !observed.has(id))
      .toSorted(compareCodePoints),
    settled,
    no_progress: inputs.inspectBytes !== false && pending.length > 0 && settled === 0,
  };
}

/**
 * One sharded run's result: the plan's table and state with each shard's
 * identities taken from that shard. Every shard ran the worker on the
 * plan's table with the same clock (`now`), restricted to its identities
 * (`only`), so the merge is exact; an identity no shard covered keeps the
 * plan's pending entry.
 */
export function combineShards(
  plan: DeriveResult,
  shards: readonly { only: readonly string[]; result: DeriveResult }[],
  provenance?: FactsProvenance,
): DeriveResult {
  const owner = new Map<string, DeriveResult>();
  for (const shard of shards)
    for (const id of shard.only) {
      if (owner.has(id)) throw new Error(`Identity ${id} is in two shards.`);
      owner.set(id, shard.result);
    }
  const from = (id: string) => owner.get(id) ?? plan;
  const ids = [
    ...new Set([
      ...plan.table.entries.map((entry) => entry.port_id),
      ...shards.flatMap((shard) => shard.result.table.entries.map((entry) => entry.port_id)),
    ]),
  ].toSorted(compareCodePoints);
  const entries = ids.flatMap((id) => {
    const found = from(id).table.entries.find((entry) => entry.port_id === id);
    return found ? [found] : [];
  });
  const table: ListingFactsTable = {
    ...plan.table,
    ...(provenance ? { provenance } : {}),
    entries,
    entries_sha256: digestOf(entries),
  };
  checkListingFactsTable(table);
  const covered = (id: string) => owner.has(id);
  const reportIds = [
    ...new Set([
      ...plan.report.map((row) => row.port_id),
      ...shards.flatMap((shard) => shard.result.report.map((row) => row.port_id)),
    ]),
  ];
  const report = reportIds.flatMap((id) => from(id).report.filter((row) => row.port_id === id));
  const ineligible: Record<string, number> = { ...plan.ineligible };
  for (const shard of shards)
    for (const [reason, count] of Object.entries(shard.result.ineligible))
      ineligible[reason] = (ineligible[reason] ?? 0) + count;
  const pending = [
    ...plan.needs.map((need) => need.port_id).filter((id) => !covered(id)),
    ...shards.flatMap((shard) => shard.result.state.pending),
  ];
  const needs = new Map(plan.needs.map((need) => [need.port_id, need.bytes]));
  const offered = (id: string) =>
    report.some((row) => row.port_id === id) &&
    plan.table.entries.some((entry) => entry.port_id === id && entry.ineligible === null);
  const settled = plan.settled + shards.reduce((sum, shard) => sum + shard.result.settled, 0);
  return {
    table,
    state: {
      format: 3,
      pending,
      // Each identity's retry item comes from its owning shard only: every
      // shard started from the whole plan state, so another shard's copy of
      // it is stale.
      retry: [
        ...plan.state.retry.filter((item) => !covered(item.port_id)),
        ...shards.flatMap((shard) =>
          shard.result.state.retry.filter((item) => owner.get(item.port_id) === shard.result),
        ),
      ].toSorted((left, right) => compareCodePoints(left.port_id, right.port_id)),
      // Shards only read the carried entries; the carry step rewrites them.
      ...(plan.state.carried?.length ? { carried: plan.state.carried } : {}),
    },
    report: report.toSorted((left, right) => compareCodePoints(left.port_id, right.port_id)),
    ineligible,
    bytes: shards.reduce((sum, shard) => sum + shard.result.bytes, 0),
    backlog: {
      enrolled_pending: pending.filter(offered).length,
      new_pending: pending.filter((id) => !offered(id)).length,
      bytes_pending: pending.reduce((sum, id) => sum + (needs.get(id) ?? 0), 0),
    },
    needs: plan.needs,
    unobserved: plan.unobserved,
    settled,
    no_progress: pending.length > 0 && settled === 0,
  };
}

/** A state file's usable parts; anything malformed starts that part fresh. */
function sanitizeState(state: WorkerState): WorkerState {
  return {
    format: 3,
    pending: (Array.isArray(state.pending) ? state.pending : []).filter(
      (id: unknown): id is string => typeof id === "string",
    ),
    retry: (Array.isArray(state.retry) ? state.retry : []).filter(
      (item: unknown): item is RetryItem =>
        isRecord(item) &&
        typeof item.port_id === "string" &&
        typeof item.since === "string" &&
        !Number.isNaN(Date.parse(item.since)) &&
        Number.isSafeInteger(item.failures) &&
        Number(item.failures) > 0 &&
        (item.cause === undefined || (failureCauses as readonly unknown[]).includes(item.cause)),
    ),
    ...carriedOf(state.carried),
  };
}
/** The well-formed carried items (`WorkerState.carried`); a malformed one is dropped and re-read. */
function carriedOf(value: unknown): Pick<WorkerState, "carried"> {
  const carried = (Array.isArray(value) ? value : []).filter(
    (item: unknown): item is CarriedItem => {
      if (!isRecord(item) || typeof item.since !== "string" || Number.isNaN(Date.parse(item.since)))
        return false;
      try {
        checkListingFactsEntry(item.entry, "A carried entry");
        return true;
      } catch {
        return false;
      }
    },
  );
  return carried.length ? { carried } : {};
}

// ---------------------------------------------------------------------------
// I/O shell: bounded download, Core inspection, then delete the bytes.

/**
 * One download or Core run's timeout: what is left of the caller's deadline
 * (the shard's real time limit), or none without a deadline. There is no
 * fixed per-operation cap: a large archive on a slow link is cut only by the
 * time the shard really has. With no time left it throws `OverBudgetError`
 * before anything starts, so a caller with a deadline is never held past it
 * by more than the scheduling of this process.
 */
export function boundedTimeout(deadline: number | undefined, now = Date.now()) {
  if (deadline === undefined) return undefined;
  const left = deadline - now;
  if (left <= 0)
    throw new OverBudgetError("The deadline passed before the next download or Core run.");
  return left;
}
/** Whether a deadline has passed: an interrupted run then becomes `OverBudgetError`. */
const pastDeadline = (deadline: number | undefined) =>
  deadline !== undefined && Date.now() >= deadline;

export interface CoreRun {
  stdout: string;
  /** The process ran to an exit code (not killed or failed to start). */
  exited: boolean;
  /** The CLI could not be started at all (missing, not executable). */
  unstarted?: boolean;
}
/**
 * A fault of the Core CLI itself, not of the bytes it was given: it could not
 * be started, it crashed or printed no JSON envelope, or it refused its own
 * invocation (`usage`). The worker treats it like any inspection failure it
 * retries; the batch job's reproduction treats it as a fault of the job.
 */
export class CoreToolError extends InspectionError {}
/**
 * Run the Portcove CLI with its temporary directory inside `scratch`, which
 * the caller deletes, so a killed run (timeout) cannot leak Core's workspace.
 */
export async function runCore(
  cli: string,
  args: string[],
  scratch: string,
  timeout?: number,
): Promise<CoreRun> {
  const temporary = path.join(scratch, "core-tmp");
  await mkdir(temporary, { recursive: true });
  return await new Promise((resolve) => {
    execFile(
      cli,
      args,
      {
        // Core's output is bounded by its own input bounds (the inspected
        // file bound and the classification request bound).
        maxBuffer: Number.POSITIVE_INFINITY,
        timeout: timeout ?? 0,
        killSignal: "SIGKILL",
        windowsHide: true,
        env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
      },
      (error, stdout) => {
        const failure = error as
          | (Error & { killed?: boolean; signal?: string | null; code?: unknown })
          | null;
        resolve({
          stdout: String(stdout ?? ""),
          exited:
            !failure || (!failure.killed && !failure.signal && typeof failure.code === "number"),
          // A system error code (`ENOENT`, `EACCES`) means it never ran.
          unstarted: typeof failure?.code === "string",
        });
      },
    );
  });
}

/** Core's JSON envelope: its data, or the failure as an `InspectionError`. Exported for its unit test. */
export function coreData(run: CoreRun, what: string): Record<string, unknown> {
  if (run.unstarted)
    throw new CoreToolError(
      `The Core CLI could not be started for ${what}.`,
      false,
      "core-unknown",
      "over-budget",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    // An exited run without its JSON envelope is the CLI's own fault.
    const cause = run.exited ? "unreadable-archive" : "over-budget";
    if (run.exited)
      throw new CoreToolError(`Core gave no ${what} result.`, false, "core-unknown", cause);
    throw new InspectionError(`Core gave no ${what} result.`, false, "core-unknown", cause);
  }
  if (isRecord(parsed) && parsed.ok === true && isRecord(parsed.data)) return parsed.data;
  // The runner's disk ran out while Core extracted the archive: a real
  // constraint of the hosted runner (about 14 GB free on a standard public
  // runner, below Core's 16 GiB extraction ceiling plus the archive), never
  // a verdict on the bytes. It is transient and retried.
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  if (isRecord(error?.presentation) && error.presentation.presentation_key === "storage_full")
    throw new InspectionError(
      `The runner ran out of disk during ${what}.`,
      false,
      "core-state",
      "runner-disk",
    );
  // Core ran and refused these bytes: the same bytes are refused again. A
  // run that was killed (its timeout) settles nothing about the bytes.
  const refusal = refusalClassOf(error?.code);
  // Core refused its own invocation (a version or argument mismatch): no
  // verdict on these bytes.
  if (refusal === "core-usage" && run.exited)
    throw new CoreToolError(`Core refused the invocation during ${what}.`, true, refusal, refusal);
  throw new InspectionError(
    `Core refused the archive during ${what}.`,
    run.exited,
    refusal,
    run.exited ? refusal : "over-budget",
  );
}

/** Core's typed error code as a bounded refusal class; never Core's free text. */
export function refusalClassOf(code: unknown): RefusalClass {
  const known: Record<string, RefusalClass> = {
    usage: "core-usage",
    unsupported: "core-unsupported",
    not_found: "core-not-found",
    source_invalid: "core-source-invalid",
    network: "core-network",
    verification: "core-verification",
    install: "core-install",
    state: "core-state",
    launch: "core-launch",
    conflict: "core-conflict",
    cancelled: "core-cancelled",
  };
  return typeof code === "string" && Object.hasOwn(known, code) ? known[code]! : "core-unknown";
}

export function cliInspector(
  cli: string,
  workDirectory: string,
  options: { deadline?: number } = {},
): ByteInspector {
  return async (asset, platform, identityDeadline) => {
    const deadline =
      identityDeadline === undefined
        ? options.deadline
        : Math.min(identityDeadline, options.deadline ?? Number.POSITIVE_INFINITY);
    if (!asset.sha256 || !/^https:\/\/github\.com\//u.test(asset.url))
      throw new InspectionError(
        "Only digest-bound GitHub release assets are inspected.",
        true,
        "not-digest-bound",
      );
    const directory = await mkdtemp(path.join(workDirectory, "asset-"));
    try {
      const file = path.join(
        directory,
        `archive${isArchive(asset.name) ? packageFormOf(asset.name)! : ""}`,
      );
      let response: Response;
      try {
        const timeout = boundedTimeout(deadline);
        response = await fetch(asset.url, {
          redirect: "follow",
          ...(timeout === undefined ? {} : { signal: AbortSignal.timeout(timeout) }),
        });
      } catch {
        if (pastDeadline(deadline)) throw new OverBudgetError("The download reached the deadline.");
        throw new InspectionError("Download failed.", false, "core-unknown", "network");
      }
      // 404 is upstream's definitive statement that this asset is gone: a
      // permanent refusal of this archive. 5xx, rate limits and other
      // failures stay transient.
      if (response.status === 404)
        throw new InspectionError("Download failed: 404 Not Found.", true, "asset-not-found");
      if (!response.ok || !response.body)
        throw new InspectionError(
          `Download failed: ${response.status}.`,
          false,
          "core-unknown",
          "network",
        );
      const hash = createHash("sha256");
      let received = 0;
      const body = Readable.fromWeb(response.body as never);
      body.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > asset.size) body.destroy(new Error("Archive exceeds its declared size."));
        hash.update(chunk);
      });
      try {
        await pipeline(body, createWriteStream(file, { flags: "wx" }));
      } catch {
        if (received > asset.size)
          throw new InspectionError(
            "Archive bytes exceed the provider's size.",
            true,
            "size-exceeded",
          );
        if (pastDeadline(deadline)) throw new OverBudgetError("The download reached the deadline.");
        throw new InspectionError("Download was interrupted.", false, "core-unknown", "network");
      }
      if (received !== asset.size || hash.digest("hex") !== asset.sha256)
        throw new InspectionError(
          "Archive bytes differ from the provider's size or digest.",
          true,
          "digest-mismatch",
        );
      // The deadline is checked again before Core starts: a download that
      // used the time left never starts a Core run past the deadline.
      const inspection = await runCore(
        cli,
        [
          "--json",
          "catalog",
          "inspect-listing-artifact",
          file,
          "--platform",
          platform,
          "--size",
          String(asset.size),
          "--sha256",
          asset.sha256,
        ],
        directory,
        boundedTimeout(deadline),
      );
      if (!inspection.exited && pastDeadline(deadline))
        throw new OverBudgetError("The Core inspection reached the deadline.");
      const data = coreData(inspection, "inspection");
      if (
        data.sha256 !== asset.sha256 ||
        !Array.isArray(data.player_candidates) ||
        !Array.isArray(data.names) ||
        data.names.some((name: unknown) => typeof name !== "string") ||
        !Array.isArray(data.leaves) ||
        data.leaves.some((name: unknown) => typeof name !== "string")
      )
        throw new InspectionError("Core returned no inspection for these bytes.", false);
      const players = data.player_candidates.flatMap((player: unknown) =>
        isRecord(player) &&
        typeof player.path === "string" &&
        typeof player.display_path === "string" &&
        typeof player.machine === "string" &&
        typeof player.sha256 === "string"
          ? [
              {
                path: player.path,
                display_path: player.display_path,
                machine: player.machine,
                sha256: player.sha256,
              },
            ]
          : [],
      );
      return { players, names: data.names as string[], leaves: data.leaves as string[] };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

export function cliClassifier(
  cli: string,
  workDirectory: string,
  options: { deadline?: number } = {},
): NameClassifier {
  const { deadline } = options;
  return async (input) => {
    const directory = await mkdtemp(path.join(workDirectory, "names-"));
    try {
      const file = path.join(directory, "names.json");
      await writeFile(file, JSON.stringify(input), { flag: "wx" });
      const run = await runCore(
        cli,
        ["--json", "catalog", "classify-listing-names", file],
        directory,
        boundedTimeout(deadline),
      );
      if (!run.exited && pastDeadline(deadline))
        throw new OverBudgetError("The Core name classification reached the deadline.");
      const data = coreData(run, "name classification");
      return data as unknown as NameClassification;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

const root = fileURLToPath(new URL("../", import.meta.url));
const catalogRoot = path.join(root, "crates/portcove-core/catalog");
export const factsTablePath = path.join(catalogRoot, "listing-package-facts.generated.json");
const usage =
  "Usage: node scripts/listing-package-facts.mts --check | derive --observations REPORT --cli PORTCOVE [--state FILE] [--output FILE] [--table FILE] [--now ISO] [--plan true --needs FILE | --only FILE --deadline ISO] [--workflow-run-id ID --source-commit SHA --inputs-sha256 SHA] [--report FILE] [--result FILE] | combine --plan RESULT --shards DIR [--output FILE] [--state FILE] [--report FILE]";

function parseState(text: string): WorkerState {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.format !== 3 ||
    !Array.isArray(value.pending) ||
    !Array.isArray(value.retry)
  )
    return initialState();
  return value as unknown as WorkerState;
}

/** The worker summary line the job reads (`parseWorkerSummary`). */
export const workerSummary = (result: DeriveResult) =>
  `${JSON.stringify({ no_progress: result.no_progress, settled: result.settled, pending: result.state.pending.length, pending_ids: result.state.pending, retry: result.state.retry.length, bytes: result.bytes, backlog: result.backlog, needs: result.needs.length, ineligible: result.ineligible, unobserved: result.unobserved, identities: result.report })}\n`;

async function main(argv: string[]) {
  if (argv.length === 1 && argv[0] === "--check") {
    checkListingFactsTable(parseCatalogSource(await readFile(factsTablePath, "utf8")));
    return "Listing package facts are well formed.\n";
  }
  if (argv[0] !== "derive" && argv[0] !== "combine") throw new Error(usage);
  const options: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) throw new Error(usage);
    options[name.slice(2)] = value;
  }
  const output = options.output ?? factsTablePath;
  const write = async (result: DeriveResult) => {
    await writeFile(output, `${JSON.stringify(result.table, null, 2)}\n`);
    if (options.state) await writeFile(options.state, `${JSON.stringify(result.state)}\n`);
    if (options.result) await writeFile(options.result, `${JSON.stringify(result)}\n`);
    if (options.needs) await writeFile(options.needs, `${JSON.stringify(result.needs)}\n`);
    if (options.report) await writeFile(options.report, workerSummary(result));
    return workerSummary(result);
  };
  if (argv[0] === "combine") {
    // Merge a plan's result with its shards' results (`shard-*.json`, each
    // `{ only, result }`): the plan's table keeps its provenance.
    if (!options.plan || !options.shards) throw new Error(usage);
    const plan = JSON.parse(await readFile(options.plan, "utf8")) as DeriveResult;
    const shards = [];
    for (const name of (await readdir(options.shards)).toSorted(compareCodePoints))
      if (/^shard-[0-9]+\.json$/u.test(name))
        shards.push(
          JSON.parse(await readFile(path.join(options.shards, name), "utf8")) as {
            only: string[];
            result: DeriveResult;
          },
        );
    return await write(combineShards(plan, shards));
  }
  if (!options.observations || !options.cli) throw new Error(usage);
  const provenanceOptions = ["workflow-run-id", "source-commit", "inputs-sha256"].map((name) =>
    Boolean(options[name]),
  );
  if (provenanceOptions.some((given) => given !== provenanceOptions[0]))
    throw new Error(
      "Provenance needs --workflow-run-id, --source-commit and --inputs-sha256 together.",
    );
  const deadline = options.deadline ? Date.parse(options.deadline) : undefined;
  if (deadline !== undefined && Number.isNaN(deadline)) throw new Error(usage);
  const now = options.now ?? new Date().toISOString();
  const only = options.only
    ? (JSON.parse(await readFile(options.only, "utf8")) as unknown)
    : undefined;
  if (only !== undefined && (!Array.isArray(only) || only.some((id) => typeof id !== "string")))
    throw new Error("--only needs a JSON array of port ids.");
  const records = workerRecords(readCatalogSource(catalogRoot));
  const work = await mkdtemp(path.join(os.tmpdir(), "listing-facts-"));
  try {
    const cli = path.resolve(options.cli);
    const provenance = options["workflow-run-id"]
      ? {
          workflow_run_id: options["workflow-run-id"],
          source_commit: options["source-commit"]!,
          cli_sha256: createHash("sha256")
            .update(await readFile(cli))
            .digest("hex"),
          inputs_sha256: options["inputs-sha256"]!,
        }
      : undefined;
    const result = await deriveListingFacts({
      ...(provenance ? { provenance } : {}),
      ...(only ? { only: only as string[] } : {}),
      ...(options.plan === "true" ? { inspectBytes: false } : {}),
      ...(deadline === undefined ? {} : { deadline }),
      records,
      observerReport: JSON.parse(await readFile(options.observations, "utf8")),
      table: parseCatalogSource(await readFile(options.table ?? factsTablePath, "utf8")),
      ...(options.state
        ? {
            state: await readFile(options.state, "utf8")
              .then(parseState)
              .catch(() => initialState()),
          }
        : {}),
      inspect: cliInspector(cli, work, deadline === undefined ? {} : { deadline }),
      classify: cliClassifier(cli, work, deadline === undefined ? {} : { deadline }),
      now,
    });
    return await write(result);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
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
