// Generated user-selected registration routes (#8569, owner decision on #1422).
//
// A deterministic, data-only step of catalog assembly. For every listing-only
// identity whose observed facts fit, it emits the shared registration-only
// form the hand-authored routes use (`external_registration_v1: true`, the
// `user-prepared` provider and the `staged-source-portable` adapter). Portcove
// downloads and executes nothing on this route: the player keeps and prepares
// their own copy, and the player and upstream own runtime replacement.
//
// Facts come only from the generated listing package-facts table, never from
// a title, an id, a name or a hand-kept list. A route exists exactly while its
// facts hold; when a fact stops holding the next generation omits it, and the
// enrollment delta records the withdrawal.
//
// Fit rule for a listing-only identity (first failing clause is the reason):
//  1. no authored integration and no reviewed prepared-player route enrollment
//     (`route_facts_v1`): an existing route already serves the title;
//  2. its declared runtime engine is not the ScummVM project;
//  3. its availability is not `source-only` or `unavailable`;
//  4. its project or release URL names a GitHub repository (a readable upstream);
//  5. one facts entry exists for it, names that same repository and was written
//     by the current facts parser version;
//  6. the worker did not complete the entry as ineligible (no stable release,
//     no supported or digest-bound archive, only non-desktop package forms, an
//     archive over the limits, a permanent Core refusal, a changed repository
//     id, or upstream unknown for longer than the last-good retention);
//  7. that entry's observation is `complete` with a complete asset list, its
//     facts are at most `maxFactsAgeDays` older than the table, and any run of
//     non-complete upstream attempts since is at most `lastGoodRetentionDays`
//     long; the worker's own backlog (`pending-inspection`) is not an upstream
//     attempt (anything else is UNKNOWN or stale, never eligible);
//  7a. the release belongs to this identity's product: no other catalog
//     identity names the repository unless the listing's release URL binds
//     this one to a release line no other identity is bound to
//     (`shared-repository`); the observed stable releases form one release
//     line or the listing binds one, the offered release is on it, an unbound
//     line is the main line or names the listed product (`lineNamesProduct`),
//     and no newer prerelease on the main line or another product-naming line
//     follows it (`ambiguous-release-line`); a tag of only channel words with
//     a date, time or hash is a prerelease (`channelOnlyTag`);
//  7b. the release ships no other package form (a non-archive desktop
//     package such as `.exe`, `.msix`, `.AppImage`, `.sh` or `.dmg`, a bare
//     binary, or any other asset that is neither a read archive, a library,
//     a non-desktop package nor on the closed non-program list: an unread
//     container whose name permits P, `otherPackageForm`) for a platform P it also offers a readable archive
//     for (one whose name permits P), other than that archive's own player
//     for P: every such asset has a provider digest equal to a player of P's
//     archives, else the release offers a different package than the archive
//     where the rule would bind, the archives' role is unknown and the whole
//     identity is excluded (`other-package-form-beside-archive`). A form
//     serving only platforms without an offered archive is ignored;
//  8. for at least one supported desktop platform P there is an artifact whose
//     typed role is `desktop-game-runtime` from exact digest-bound archive
//     bytes, which neither its asset name (Core's filename classifier and
//     listing-only tool and system vetoes, vetoes only) nor another source
//     contradicts, whose name holds no role word (`archiveRoleToken`: an
//     update, patch, delta or symbols archive) and names no other system or
//     architecture than P's,
//     and which holds a player candidate whose platform-true header machine
//     runs on P and whose name carries no tool token. Each player's own
//     machine decides where it runs; other players in the same archive (a
//     32-bit helper, the other system of a combined archive) neither help nor
//     block P;
//  9. on P the players of every such artifact are one program: after tool
//     vetoes and same-program variants (architecture, system, console and
//     debug words) at most `maxDistinctPrograms` (1) distinct program names
//     remain, and one artifact's players sit under one top-level directory.
//     Anything more could be several titles and is `ambiguous-player`. None
//     bundles a toolchain helper (`bundled-toolchain`). When several such
//     artifacts remain they are one package (equal archive SHA-256), or
//     exactly one names P's system beside only system-neutral others
//     (`onePackage`), else `ambiguous-artifact`; no archive Core refused has
//     a name that allows P (`core-refused`);
// 10. on P no acquisition restriction holds `register-external` or `launch`
//     (a `download` hold does not block registration; this route never offers
//     a download).
// The route's platforms are every P satisfying 8 to 10.
import { createHash } from "node:crypto";
import { platforms } from "../apps/desktop/src/catalog-values.generated.ts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { registrationOwnership } from "./catalog-route-facts.mts";
import { heldAt, usesScummvmEngine } from "./catalog-route-holds.mts";
import {
  listingPackageLimit,
  listingProviderIdentity,
  listingReleaseLimit,
} from "./listing-upstream-observation.mts";
import { isRecord } from "./runtime-values.mts";

/** Bump when the fit rule or the generated route shape changes. */
export const GENERATOR_VERSION = 12;
/** The facts parser version this generator reads. */
export const FACTS_PARSER = "listing-package-facts";
export const FACTS_PARSER_VERSION = 13;
export const FACTS_TABLE_FORMAT = 11;
export const ENROLLMENT_TABLE_FORMAT = 1;
export const factsTableName = "listing-package-facts.generated.json";
export const enrollmentTableName = "generated-registration.generated.json";
export const factsGenerator = "scripts/listing-package-facts.mts";
export const enrollmentGenerator = "scripts/generate-catalog.mts";

/**
 * Facts older than this, measured against the table's `generated_at`, are
 * stale: the correctness bound on how long observed release facts are
 * trusted without a fresh complete observation.
 */
export const maxFactsAgeDays = 30;
/**
 * Last-good facts survive consecutive non-complete attempts for this long,
 * and a transient inspection failure is retried for this long: the
 * correctness bound on how long an upstream or provider fault is treated as
 * temporary.
 */
export const lastGoodRetentionDays = 14;
/**
 * Core's bound on the regular files one listing inspection reads
 * (`MAXIMUM_SHAPE_PATHS` in `crates/portcove-core/src/package_shape.rs`):
 * no archive can record more programs than that.
 */
export const coreInspectedFileBound = 16_384;
const day = 86_400_000;

/** The only fact source generator v1 accepts: exact, digest-bound archive bytes. */
export const authorizingSource = "exact-release-structured";
export const roles = [
  "desktop-game-runtime",
  "desktop-game-data",
  "dedicated-server",
  "builder",
  "installer",
  "importer",
  "compiler",
  "dev-tool",
  "original-game-input",
  "mobile-package",
  "console-output",
  "documentation",
  "source-archive",
  "integrity-metadata",
  "debug-symbols",
  "unknown",
] as const;
export type Role = (typeof roles)[number];
const targetOs = ["windows", "linux", "macos", "android", "ios", "console", "web", "unknown"];
const targetArch = ["x86-64", "aarch64", "x86", "universal", "unknown"];
const coverages = ["complete", "partial", "unavailable", "failed"] as const;
const attemptStatuses = ["partial", "unavailable", "failed", "pending-inspection"] as const;
/**
 * Reasons the worker completes an identity as ineligible. Each is positive
 * evidence or a permanent bound; the worker re-evaluates it only when the
 * release changes.
 */
export const ineligibleReasons = [
  "no-stable-release",
  "no-release-archive",
  "unsupported-archive-format",
  "non-desktop-platform",
  "no-digest",
  "core-refused",
  "repeated-inspection-failure",
  "invalid-facts",
  "repository-identity-changed",
  "observation-unavailable",
] as const;
export type IneligibleReason = (typeof ineligibleReasons)[number];

export interface PlayerFact {
  /** Lowercase package-relative path: the comparison key. */
  path: string;
  /** The same path with the archive's letter case, for display. */
  display_path: string;
  machine: string;
  sha256: string;
}
export interface NameSuggestion {
  rule_version: number;
  role: Role;
  os: string;
  arch: string;
  /** Core's listing-only tool token in the asset name; any token vetoes the archive. */
  tool_token: string | null;
  /** Core's listing-only non-desktop system token in the asset name; any token vetoes the archive. */
  system_token: string | null;
}
/** A native program Core's listing-only tool veto excluded from the players. */
export interface ExcludedPlayer extends PlayerFact {
  token: string;
}
export interface ArtifactFactV2 {
  asset_id: number;
  name: string;
  size: number;
  sha256: string;
  role: Role;
  /** Summary of the kept players' systems (`unknown` when they differ); fit reads each player's machine. */
  os: string;
  /** Summary of the kept players' architectures (`unknown` when they differ). */
  arch: string;
  source: { kind: typeof authorizingSource; shape_version: number; archive_sha256: string };
  /** What Core's filename classifier suggests; it can only veto. */
  name_suggestion: NameSuggestion;
  /** Native programs outside tool locations whose names carry no tool token. */
  players: PlayerFact[];
  /** Native programs whose names carry a listing-only tool token. */
  excluded_players: ExcludedPlayer[];
  contradictory: boolean;
  /**
   * Compiler, interpreter and build helpers the archive bundles
   * (`toolchainHelpers`), from its listing: path components equal to a helper
   * name, with or without `.exe`. Sorted and unique; any one means the release
   * builds or prepares the game on the player's machine (`bundled-toolchain`).
   */
  bundled_toolchain: string[];
}
/**
 * One release the observer reported for the repository (newest first, within
 * the observer's own release bound): enough to derive its release line.
 */
export interface ObservedReleaseFact {
  release_id: number;
  /** The tag as published, or null when it is not a bounded printable string. */
  tag: string | null;
  /** Core's prerelease verdict, or null when Core did not classify the tag. */
  prerelease: boolean | null;
  published_at: string | null;
  /** Whether the release carries at least one package file. */
  packaged: boolean;
}
/** Why Core (or the worker's byte binding) refused one archive. */
export const refusalClasses = [
  "core-usage",
  "core-unsupported",
  "core-not-found",
  "core-source-invalid",
  "core-network",
  "core-verification",
  "core-install",
  "core-state",
  "core-launch",
  "core-conflict",
  "core-cancelled",
  "core-unknown",
  "digest-mismatch",
  "size-exceeded",
  "not-digest-bound",
] as const;
export type RefusalClass = (typeof refusalClasses)[number];
/**
 * Why an inspection failed without a permanent verdict on the bytes, as a
 * bounded class: the download (`network`), a timeout or deadline
 * (`over-budget`), bytes Core read but returned nothing usable for
 * (`unreadable-archive`), or a refusal class (`refusalClasses`, including
 * `digest-mismatch`).
 */
export const failureCauses = [
  "network",
  "over-budget",
  "unreadable-archive",
  ...refusalClasses,
] as const;
export type FailureCause = (typeof failureCauses)[number];

/**
 * Compiler, interpreter, build and patch helpers whose presence in a release
 * archive means the release builds or prepares the game on the player's
 * machine ("build on first start"): that needs a person, never a generated
 * registration. Matched only as a whole path component, case-insensitive,
 * with or without `.exe`, so `python311.dll` or a `scripts/` folder never
 * match. `7z`/`7za` are extraction helpers that ordinary games ship and are
 * not on the list.
 */
export const toolchainHelpers = [
  "zig",
  "clang",
  "gcc",
  "g++",
  "cc1",
  "ld",
  "lld",
  "python",
  "python3",
  "pip",
  "node",
  "cmake",
  "ninja",
  "make",
  "msbuild",
  "cl",
  "link",
  "hactool",
  "extract-xiso",
  "xdelta",
  "xdelta3",
];
/** The toolchain helpers an archive listing (Core's `names`) holds, sorted and unique. */
export function bundledToolchain(names: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    const stem = lower.endsWith(".exe") ? lower.slice(0, -4) : lower;
    if (toolchainHelpers.includes(stem)) found.add(stem);
  }
  return [...found].toSorted(compareCodePoints);
}
/** An archive whose bytes Core refused permanently; it is never offered. */
export interface RefusedArchive {
  asset_id: number;
  name: string;
  size: number;
  sha256: string;
  name_suggestion: NameSuggestion;
  refusal: RefusalClass;
}
export interface ListingFactsEntry {
  port_id: string;
  provider: "github";
  /** The repository the listing names; facts bind to it and to `repository_id`. */
  repository: string;
  repository_id: number;
  parser: string;
  parser_version: number;
  observation: {
    release_id: number | null;
    tag: string | null;
    published_at: string | null;
    /** When upstream last completely confirmed these facts. */
    observed_at: string;
    coverage: (typeof coverages)[number];
    assets_complete: boolean;
    /** Digest of the release's asset list; a change re-evaluates the release. */
    assets_sha256: string;
  };
  ineligible: {
    reason: IneligibleReason;
    detail: string;
    /**
     * The typed cause of a `repeated-inspection-failure` (`failureCauses`);
     * null for every other reason.
     */
    cause: FailureCause | null;
  } | null;
  /**
   * Package forms of the release's assets the worker does not read, sorted and
   * unique, whether or not a supported archive sits beside them: unsupported
   * desktop forms (`unreadForms`) and non-desktop forms (`nonDesktopForms`).
   */
  unread_forms: string[];
  /**
   * The observed releases of the repository, in ascending release id, for the
   * release-line rule. Empty for an ineligible entry.
   */
  observed_releases: ObservedReleaseFact[];
  /**
   * The release's other package forms (`otherPackageForm`) in ascending asset
   * id, with the provider's size and digest (null when the provider states
   * none) and the platforms each can serve. One whose digest is not a player
   * of a platform's offered archive is a different program for that
   * platform. Empty for an ineligible entry.
   */
  other_packages: OtherPackage[];
  /** Archives of the release Core refused; never offered. Empty when ineligible. */
  refused_archives: RefusedArchive[];
  /** Consecutive non-complete attempts since `observed_at`; last-good facts stay. */
  attempt: {
    status: (typeof attemptStatuses)[number];
    first_at: string;
    last_at: string;
    failures: number;
  } | null;
  artifacts: ArtifactFactV2[];
}
/**
 * Where an unattended worker run came from. Absent for local runs; when
 * present, its shape is checked and it is carried into the enrollment table.
 */
export interface FactsProvenance {
  /** The workflow run id of the job that ran the worker. */
  workflow_run_id: string;
  /** The repository commit the worker ran from. */
  source_commit: string;
  /** SHA-256 of the Portcove CLI binary the worker ran. */
  cli_sha256: string;
  /**
   * SHA-256 of the run's `inputs.json` (the observer report, prior worker
   * state, budget and cadence digests), retained as that run's
   * `listing-facts-batch-inputs-<run id>` artifact.
   */
  inputs_sha256: string;
}
export interface ListingFactsTable {
  format: number;
  generator: string;
  /** The worker run that wrote the table: the reference time for facts age. */
  generated_at: string;
  provenance?: FactsProvenance;
  entries: ListingFactsEntry[];
  entries_sha256: string;
}

const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
function bounded(value: unknown, maximum = 512): value is string {
  if (typeof value !== "string" || !value || value.trim() !== value) return false;
  if (Buffer.byteLength(value) > maximum) return false;
  // No control, format (bidi, zero-width), separator or unassigned characters.
  return !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u.test(value);
}
const timestamp = (value: unknown): value is string =>
  bounded(value, 64) && !Number.isNaN(Date.parse(value));
function exact(value: Record<string, unknown>, fields: readonly string[], where: string) {
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown !== undefined) throw new Error(`${where} has an unknown field ${unknown}.`);
  const missing = fields.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new Error(`${where} is missing ${missing}.`);
}
function relativePath(value: unknown): value is string {
  return (
    bounded(value, 1024) &&
    !value.includes("\\") &&
    !value.includes(":") &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".." && part.trim() === part)
  );
}
export const digestOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function checkArtifact(value: unknown, where: string): asserts value is ArtifactFactV2 {
  if (!isRecord(value)) throw new Error(`${where} must be an object.`);
  exact(
    value,
    [
      "asset_id",
      "name",
      "size",
      "sha256",
      "role",
      "os",
      "arch",
      "source",
      "name_suggestion",
      "players",
      "excluded_players",
      "contradictory",
      "bundled_toolchain",
    ],
    where,
  );
  if (
    !positive(value.asset_id) ||
    !bounded(value.name, 255) ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 1 ||
    !sha(value.sha256) ||
    !(roles as readonly unknown[]).includes(value.role) ||
    !targetOs.includes(value.os as string) ||
    !targetArch.includes(value.arch as string) ||
    typeof value.contradictory !== "boolean" ||
    !Array.isArray(value.players) ||
    value.players.length > coreInspectedFileBound ||
    !Array.isArray(value.excluded_players) ||
    value.excluded_players.length > coreInspectedFileBound
  )
    throw new Error(`${where} is not a typed artifact fact.`);
  // Generator v1 trusts only exact structural observations of digest-bound bytes.
  if (!isRecord(value.source) || value.source.kind !== authorizingSource)
    throw new Error(`${where} must come from an exact-release-structured observation.`);
  exact(value.source, ["kind", "shape_version", "archive_sha256"], `${where}.source`);
  if (!positive(value.source.shape_version) || value.source.archive_sha256 !== value.sha256)
    throw new Error(`${where} structural source must bind these exact archive bytes.`);
  checkSuggestion(value.name_suggestion, `${where}.name_suggestion`);
  const paths = new Set<string>();
  for (const [index, player] of [
    ...value.players.map((item: unknown) => ["players", item] as const),
    ...value.excluded_players.map((item: unknown) => ["excluded_players", item] as const),
  ].entries()) {
    const [list, item] = player;
    const at = `${where}.${list}[${index}]`;
    if (!isRecord(item)) throw new Error(`${at} must be an object.`);
    const excluded = list === "excluded_players";
    exact(item, ["path", "display_path", "machine", "sha256", ...(excluded ? ["token"] : [])], at);
    if (
      !relativePath(item.path) ||
      !relativePath(item.display_path) ||
      item.display_path.toLowerCase() !== item.path ||
      !bounded(item.machine, 64) ||
      !sha(item.sha256) ||
      (excluded && !toolToken(item.token)) ||
      paths.has(item.path)
    )
      throw new Error(`${at} needs a package-relative path, header machine and SHA-256.`);
    paths.add(item.path);
  }
  if ((value.role === "desktop-game-runtime") !== value.players.length > 0)
    throw new Error(`${where} claims a runtime role exactly when it holds players.`);
  if (
    !Array.isArray(value.bundled_toolchain) ||
    value.bundled_toolchain.some(
      (name: unknown, index: number, names: unknown[]) =>
        typeof name !== "string" ||
        !toolchainHelpers.includes(name) ||
        (index > 0 && compareCodePoints(String(names[index - 1]), name) >= 0),
    )
  )
    throw new Error(`${where}.bundled_toolchain must be sorted, unique toolchain helper names.`);
}

function checkSuggestion(suggestion: unknown, where: string) {
  if (!isRecord(suggestion)) throw new Error(`${where} must be an object.`);
  exact(suggestion, ["rule_version", "role", "os", "arch", "tool_token", "system_token"], where);
  if (
    !positive(suggestion.rule_version) ||
    !(suggestion.tool_token === null || toolToken(suggestion.tool_token)) ||
    !(suggestion.system_token === null || toolToken(suggestion.system_token)) ||
    !(roles as readonly unknown[]).includes(suggestion.role) ||
    !targetOs.includes(suggestion.os as string) ||
    !targetArch.includes(suggestion.arch as string)
  )
    throw new Error(`${where} is not a filename classification.`);
}

/**
 * The observer's own window: at most `listingReleaseLimit` releases, each
 * with at most `listingPackageLimit` assets
 * (`scripts/listing-upstream-observation.mts`). An entry can record no more.
 */
const maxObservedReleases = listingReleaseLimit;
const maxOtherPackages = listingPackageLimit;
const maxRefusedArchives = listingPackageLimit;

function checkReleaseFacts(entry: Record<string, unknown>, where: string) {
  const releases = entry.observed_releases;
  if (!Array.isArray(releases) || releases.length > maxObservedReleases)
    throw new Error(`${where}.observed_releases must be a bounded list.`);
  for (const [index, release] of releases.entries()) {
    const at = `${where}.observed_releases[${index}]`;
    if (!isRecord(release)) throw new Error(`${at} must be an object.`);
    exact(release, ["release_id", "tag", "prerelease", "published_at", "packaged"], at);
    if (
      !positive(release.release_id) ||
      (index > 0 &&
        Number((releases[index - 1] as Record<string, unknown>).release_id) >=
          release.release_id) ||
      !(release.tag === null || bounded(release.tag, 256)) ||
      !(release.prerelease === null || typeof release.prerelease === "boolean") ||
      !(release.published_at === null || timestamp(release.published_at)) ||
      typeof release.packaged !== "boolean"
    )
      throw new Error(`${at} needs a release id in ascending order, a tag, a verdict and a time.`);
  }
  const others = entry.other_packages;
  if (!Array.isArray(others) || others.length > maxOtherPackages)
    throw new Error(`${where}.other_packages must be a bounded list.`);
  for (const [index, other] of others.entries()) {
    const at = `${where}.other_packages[${index}]`;
    if (!isRecord(other)) throw new Error(`${at} must be an object.`);
    exact(other, ["asset_id", "name", "size", "sha256", "platforms"], at);
    const kind = typeof other.name === "string" ? otherPackageForm(other.name) : undefined;
    const served = Array.isArray(other.platforms) ? (other.platforms as unknown[]) : [];
    const fixed = kind && kind !== "container" ? formPlatforms[kind] : undefined;
    if (
      !positive(other.asset_id) ||
      (index > 0 &&
        Number((others[index - 1] as Record<string, unknown>).asset_id) >= other.asset_id) ||
      !bounded(other.name, 255) ||
      kind === undefined ||
      !Number.isSafeInteger(other.size) ||
      Number(other.size) < 0 ||
      !(other.sha256 === null || sha(other.sha256)) ||
      !Array.isArray(other.platforms) ||
      served.length === 0 ||
      JSON.stringify(served) !==
        JSON.stringify(platforms.filter((platform) => served.includes(platform))) ||
      (fixed !== undefined && JSON.stringify(served) !== JSON.stringify(fixed))
    )
      throw new Error(
        `${at} needs another package form in ascending order, its size, its digest or null and the platforms its form serves.`,
      );
  }
  const refused = entry.refused_archives;
  if (!Array.isArray(refused) || refused.length > maxRefusedArchives)
    throw new Error(`${where}.refused_archives must be a bounded list.`);
  for (const [index, archive] of refused.entries()) {
    const at = `${where}.refused_archives[${index}]`;
    if (!isRecord(archive)) throw new Error(`${at} must be an object.`);
    exact(archive, ["asset_id", "name", "size", "sha256", "name_suggestion", "refusal"], at);
    if (
      !positive(archive.asset_id) ||
      (index > 0 &&
        Number((refused[index - 1] as Record<string, unknown>).asset_id) >= archive.asset_id) ||
      !bounded(archive.name, 255) ||
      !Number.isSafeInteger(archive.size) ||
      Number(archive.size) < 1 ||
      !sha(archive.sha256) ||
      !(refusalClasses as readonly unknown[]).includes(archive.refusal)
    )
      throw new Error(`${at} needs an asset in ascending order, its digest and a refusal class.`);
    checkSuggestion(archive.name_suggestion, `${at}.name_suggestion`);
  }
}

/** A Core tool token: a lowercase ASCII word. */
const toolToken = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9]{1,32}$/u.test(value);

const provenanceFields = [
  "workflow_run_id",
  "source_commit",
  "cli_sha256",
  "inputs_sha256",
] as const;
/** The optional table-level provenance an unattended worker run records. */
export function checkFactsProvenance(value: unknown): asserts value is FactsProvenance {
  if (!isRecord(value)) throw new Error("Listing package facts provenance must be an object.");
  exact(value, provenanceFields, "Listing package facts provenance");
  if (
    typeof value.workflow_run_id !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(value.workflow_run_id) ||
    typeof value.source_commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.source_commit) ||
    !sha(value.cli_sha256) ||
    !sha(value.inputs_sha256)
  )
    throw new Error(
      "Listing package facts provenance needs a workflow run id, a 40-digit source commit, the CLI SHA-256 and the inputs SHA-256.",
    );
}

/** One entry's strict syntax; the worker checks each identity with it. */
export function checkListingFactsEntry(
  entry: unknown,
  where = "Listing package facts entry",
): asserts entry is ListingFactsEntry {
  if (!isRecord(entry)) throw new Error(`${where} must be an object.`);
  exact(
    entry,
    [
      "port_id",
      "provider",
      "repository",
      "repository_id",
      "parser",
      "parser_version",
      "observation",
      "ineligible",
      "unread_forms",
      "observed_releases",
      "other_packages",
      "refused_archives",
      "attempt",
      "artifacts",
    ],
    where,
  );
  checkReleaseFacts(entry, where);
  if (
    !Array.isArray(entry.unread_forms) ||
    entry.unread_forms.some(
      (form: unknown, index: number, forms: unknown[]) =>
        !(packageForms as readonly unknown[]).includes(form) ||
        (index > 0 && compareCodePoints(String(forms[index - 1]), String(form)) >= 0),
    )
  )
    throw new Error(`${where}.unread_forms must be sorted, unique known package forms.`);
  if (
    !bounded(entry.port_id, 128) ||
    entry.provider !== "github" ||
    typeof entry.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(entry.repository) ||
    !positive(entry.repository_id) ||
    !bounded(entry.parser, 64) ||
    !positive(entry.parser_version) ||
    !isRecord(entry.observation) ||
    !Array.isArray(entry.artifacts) ||
    entry.artifacts.length > listingPackageLimit
  )
    throw new Error(`${where} needs an identity, GitHub repository id and parser.`);
  const observation = entry.observation;
  exact(
    observation,
    [
      "release_id",
      "tag",
      "published_at",
      "observed_at",
      "coverage",
      "assets_complete",
      "assets_sha256",
    ],
    `${where}.observation`,
  );
  if (
    !(observation.release_id === null || positive(observation.release_id)) ||
    !(observation.tag === null || bounded(observation.tag, 256)) ||
    (observation.release_id === null) !== (observation.tag === null) ||
    !(observation.published_at === null || timestamp(observation.published_at)) ||
    !timestamp(observation.observed_at) ||
    !(coverages as readonly unknown[]).includes(observation.coverage) ||
    typeof observation.assets_complete !== "boolean" ||
    !sha(observation.assets_sha256)
  )
    throw new Error(`${where}.observation needs a release identity and stated coverage.`);
  if (entry.ineligible !== null) {
    if (!isRecord(entry.ineligible)) throw new Error(`${where}.ineligible must be an object.`);
    exact(entry.ineligible, ["reason", "detail", "cause"], `${where}.ineligible`);
    if (
      !(ineligibleReasons as readonly unknown[]).includes(entry.ineligible.reason) ||
      (entry.ineligible.reason === "repeated-inspection-failure"
        ? !(failureCauses as readonly unknown[]).includes(entry.ineligible.cause)
        : entry.ineligible.cause !== null) ||
      !bounded(entry.ineligible.detail, 512) ||
      entry.artifacts.length ||
      (entry.observed_releases as unknown[]).length ||
      (entry.other_packages as unknown[]).length ||
      (entry.refused_archives as unknown[]).length
    )
      throw new Error(
        `${where}.ineligible needs a known reason, a cause exactly for a repeated inspection failure, and no artifacts, releases or refusals.`,
      );
  } else if (observation.release_id === null)
    throw new Error(`${where} without a release must be ineligible.`);
  else if (
    !(entry.observed_releases as ObservedReleaseFact[]).some(
      (release) => release.release_id === observation.release_id && release.prerelease === false,
    )
  )
    throw new Error(`${where} must record its own stable release among the observed releases.`);
  if (entry.attempt !== null) {
    if (!isRecord(entry.attempt)) throw new Error(`${where}.attempt must be an object.`);
    exact(entry.attempt, ["status", "first_at", "last_at", "failures"], `${where}.attempt`);
    if (
      !(attemptStatuses as readonly unknown[]).includes(entry.attempt.status) ||
      !timestamp(entry.attempt.first_at) ||
      !timestamp(entry.attempt.last_at) ||
      Date.parse(entry.attempt.last_at) < Date.parse(entry.attempt.first_at) ||
      !positive(entry.attempt.failures)
    )
      throw new Error(`${where}.attempt needs a status, a time span and a count.`);
  }
  const assets = new Set<number>(
    (entry.refused_archives as RefusedArchive[]).map((archive) => archive.asset_id),
  );
  for (const [artifactIndex, artifact] of entry.artifacts.entries()) {
    checkArtifact(artifact, `${where}.artifacts[${artifactIndex}]`);
    if (assets.has(artifact.asset_id))
      throw new Error(`${where} names asset ${artifact.asset_id} twice.`);
    assets.add(artifact.asset_id);
  }
}

/** Strict syntax of the generated facts table; content binding is the producer's. */
export function checkListingFactsTable(value: unknown): asserts value is ListingFactsTable {
  if (!isRecord(value)) throw new Error("Listing package facts must be an object.");
  const { provenance, ...rest } = value;
  exact(
    rest,
    ["format", "generator", "generated_at", "entries", "entries_sha256"],
    "Listing package facts",
  );
  if (Object.hasOwn(value, "provenance")) checkFactsProvenance(provenance);
  if (
    value.format !== FACTS_TABLE_FORMAT ||
    value.generator !== factsGenerator ||
    !timestamp(value.generated_at) ||
    !Array.isArray(value.entries) ||
    value.entries_sha256 !== digestOf(value.entries)
  )
    throw new Error("Listing package facts need the current format, generator and entry digest.");
  for (const [index, entry] of value.entries.entries()) {
    const where = `Listing package facts entry ${index}`;
    checkListingFactsEntry(entry, where);
    if (index > 0 && (value.entries[index - 1] as ListingFactsEntry).port_id >= entry.port_id)
      throw new Error("Listing package facts entries must be in ascending, unique port_id order.");
    if (Date.parse(entry.observation.observed_at) > Date.parse(value.generated_at))
      throw new Error(`${where} was observed after the table was generated.`);
  }
}

// ---------------------------------------------------------------------------
// Package forms and deterministic ordering.

/** Archive forms the worker reads through Core. */
export const archiveForms = [".zip", ".tar.gz", ".tgz", ".tar.xz"] as const;
/** Desktop package forms the worker does not read: never inspected, always recorded. */
export const unreadForms = [
  ".7z",
  ".rar",
  ".tar.bz2",
  ".tbz2",
  ".tar.zst",
  ".tar",
  ".exe",
  ".msi",
  ".dmg",
  ".pkg",
  ".appimage",
  ".deb",
  ".rpm",
  ".flatpak",
  ".run",
  ".x86_64",
  ".jar",
  ".msix",
  ".appx",
  ".msixbundle",
  ".appxbundle",
  ".snap",
  ".bin",
  ".sh",
  ".linux",
  ".x86",
  ".arm64",
  ".aarch64",
] as const;
/** Package forms only non-desktop systems install (mobile and console). */
export const nonDesktopForms = [
  ".ipa",
  ".apk",
  ".aab",
  ".vpk",
  ".nro",
  ".nsp",
  ".3dsx",
  ".cia",
  ".wad",
] as const;
const packageForms = [...unreadForms, ...nonDesktopForms];
/** The longest known package form a file name ends with, lowercase. */
export function packageFormOf(name: string): string | undefined {
  const lower = name.toLowerCase();
  return [...archiveForms, ...packageForms]
    .filter((form) => lower.endsWith(form))
    .toSorted((left, right) => right.length - left.length)[0];
}

/**
 * Locale-independent order by Unicode code point. `localeCompare` depends on
 * the ICU data of the running Node, so equal inputs could order differently on
 * different machines; generated tables never use it.
 */
export function compareCodePoints(left: string, right: string): number {
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const a = left.codePointAt(i)!;
    const b = right.codePointAt(j)!;
    if (a !== b) return a < b ? -1 : 1;
    i += a > 0xffff ? 2 : 1;
    j += b > 0xffff ? 2 : 1;
  }
  return i < left.length ? 1 : j < right.length ? -1 : 0;
}

export const initialFactsTime = "2026-11-23T00:00:00.000Z";
export function emptyFactsTable(generated_at = initialFactsTime): ListingFactsTable {
  return {
    format: FACTS_TABLE_FORMAT,
    generator: factsGenerator,
    generated_at,
    entries: [],
    entries_sha256: digestOf([]),
  };
}

// ---------------------------------------------------------------------------
// Host facts: the operating system, architecture and header machine of P.

const hostOs: Record<string, string> = {
  "windows-x86-64": "windows",
  "linux-x86-64": "linux",
  "macos-x86-64": "macos",
  "macos-aarch64": "macos",
};
const hostArch: Record<string, string> = {
  "windows-x86-64": "x86-64",
  "linux-x86-64": "x86-64",
  "macos-x86-64": "x86-64",
  "macos-aarch64": "arm64",
};

/**
 * Systems of Core's platform-true machine names
 * (`package_shape::machine::ExecutableImage::platform_machine`). An unqualified
 * name is its format's desktop host; a qualifier names another system.
 */
const machineQualifiers: Record<string, readonly string[]> = {
  pe: ["xbox", "efi", "arm64ec", "unknown"],
  elf: ["android", "freebsd", "openbsd", "netbsd", "haiku", "solaris", "unknown"],
  macho: ["ios", "tvos", "watchos", "visionos", "other", "unplatformed", "unknown"],
};
const formatHost: Record<string, string> = { pe: "windows", elf: "linux", macho: "macos" };
/** Systems no supported desktop platform is; `unknown` and `unplatformed` are unknown, not these. */
const nonDesktopSystems = new Set([
  "xbox",
  "efi",
  "android",
  "freebsd",
  "openbsd",
  "netbsd",
  "haiku",
  "solaris",
  "ios",
  "tvos",
  "watchos",
  "visionos",
  "other",
]);
export type PlayerPlatformClass = "desktop" | "non-desktop" | "unknown";
export interface MachineSystem {
  /** `windows`, `linux`, `macos`, a qualifier such as `android`, or `unknown`. */
  system: string;
  /** `x86-64`, `aarch64`, `x86`, `universal` or `unknown`. */
  arch: string;
  platformClass: PlayerPlatformClass;
  /** The system in the facts' target-OS vocabulary, for summaries and name vetoes. */
  os: string;
}

/** What a platform-true machine name says about the player's system and architecture. */
export function machineSystem(machine: string): MachineSystem {
  const dash = machine.indexOf("-");
  const prefix = dash < 0 ? "" : machine.slice(0, dash);
  const format = /^elf(?:32|64)(?:be)?$/u.test(prefix) ? "elf" : prefix;
  let rest = dash < 0 ? "" : machine.slice(dash + 1);
  let system = formatHost[format] ?? "unknown";
  const qualifier = (machineQualifiers[format] ?? []).find((word) => rest.startsWith(`${word}-`));
  if (qualifier) {
    system = qualifier;
    rest = rest.slice(qualifier.length + 1);
  }
  // An ARM64EC image has an x64 header but is built for Windows on Arm.
  if (system === "arm64ec") {
    system = "windows";
    rest = "arm64";
  }
  const arch = rest.startsWith("universal-")
    ? "universal"
    : rest === "arm64"
      ? "aarch64"
      : rest === "x86-64" || rest === "x86"
        ? rest
        : "unknown";
  const platformClass: PlayerPlatformClass = ["windows", "linux", "macos"].includes(system)
    ? "desktop"
    : nonDesktopSystems.has(system)
      ? "non-desktop"
      : "unknown";
  const os = ["windows", "linux", "macos", "android"].includes(system)
    ? system
    : ["ios", "tvos", "watchos", "visionos"].includes(system)
      ? "ios"
      : system === "xbox"
        ? "console"
        : "unknown";
  return { system, arch, platformClass, os };
}

/** Whether a filename's architecture agrees with a player's (a universal player serves both). */
export const archAgrees = (named: string, actual: string) =>
  named === "unknown" ||
  named === actual ||
  (actual === "universal" && (named === "x86-64" || named === "aarch64"));

/**
 * Whether an archive's own name vetoes it as a whole: a non-runtime role, a
 * tool or non-desktop system token, or a system or architecture that none of
 * its kept players has. The worker records this as `contradictory`.
 */
export function nameContradicts(suggestion: NameSuggestion, players: readonly PlayerFact[]) {
  const systems = players.map(({ machine }) => machineSystem(machine));
  return (
    players.length > 0 &&
    (!["desktop-game-runtime", "unknown"].includes(suggestion.role) ||
      suggestion.tool_token !== null ||
      suggestion.system_token !== null ||
      (suggestion.os !== "unknown" && !systems.some(({ os }) => os === suggestion.os)) ||
      (suggestion.arch !== "unknown" &&
        !systems.some(({ arch }) => archAgrees(suggestion.arch, arch))))
  );
}

/** Whether a header machine (Core's platform-true `package_shape::machine` names) runs on P. */
export function machineRunsOn(machine: string, platform: string): boolean {
  const arch = hostArch[platform];
  switch (hostOs[platform]) {
    case "windows":
      return machine === `pe-${arch}`;
    case "linux":
      return machine === `elf64-${arch}`;
    case "macos":
      return (
        machine === `macho-${arch}` ||
        (machine.startsWith("macho-universal-") &&
          machine.slice("macho-universal-".length).split("+").includes(arch!))
      );
    default:
      return false;
  }
}

/** Whether an archive's name permits P: it names no other system or architecture. */
function namePermits(artifact: ArtifactFactV2, platform: string) {
  return namePermitsName(artifact.name_suggestion, platform);
}
/** Whether a name vetoes its archive by its own words, whatever the archive holds. */
function nameVetoes(named: NameSuggestion) {
  return (
    named.tool_token !== null ||
    named.system_token !== null ||
    !["desktop-game-runtime", "unknown"].includes(named.role)
  );
}
function namePermitsName(named: NameSuggestion, platform: string) {
  const wanted = platform === "macos-aarch64" ? "aarch64" : "x86-64";
  return (
    (named.os === "unknown" || named.os === hostOs[platform]) &&
    (named.arch === "unknown" ||
      named.arch === wanted ||
      (hostOs[platform] === "macos" && named.arch === "universal"))
  );
}

/**
 * Distinct program names allowed per platform. One: after the tool veto and
 * same-program variants, a second distinct program name cannot be told apart
 * from a second title by name alone (`openjk` beside `openjo`, a launcher
 * beside its game), so it is `ambiguous-player`, never enrolled.
 */
export const maxDistinctPrograms = 1;
/**
 * Words that name a build variant of the same program, not another program,
 * when they stand alone between separators. A bare `64`, `32` or `86` is
 * dropped only in that position (`Game-64.exe`, `openjk.x86_64.exe`), never
 * when it is glued to the name: `Doom64.exe` is Doom 64, a different game
 * from `Doom.exe`, and `Game64.exe` cannot be told apart from it by name, so
 * such a pair stays two programs (`ambiguous-player`).
 */
const variantWords = new Set([
  "exe",
  "bin",
  "x86",
  "x64",
  "x86_64",
  "amd64",
  "arm64",
  "aarch64",
  "arm",
  "i386",
  "i686",
  "win",
  "win32",
  "win64",
  "windows",
  "linux",
  "mac",
  "macos",
  "osx",
  "universal",
  "universal2",
  "64",
  "32",
  "86",
  "64bit",
  "32bit",
  "bit",
  "console",
  "debug",
]);
/** Variant words that may also be split off a glued word: never bare numbers. */
const gluedVariantWords = new Set([...variantWords].filter((word) => !/^[0-9]+$/u.test(word)));
/**
 * A program's name without its build-variant words: `openjk.x86_64.exe` and
 * `openjk.x86.exe` are both `openjk`, `Game.console.exe` and `Game-64.exe`
 * are `game`, `Doom3.exe` stays `doom-3` and `Doom64.exe` stays `doom-64`.
 */
export function programStem(path: string) {
  const name = basename(path).toLowerCase();
  const words = name
    .split(/[^a-z0-9]+/u)
    .filter((word) => word && !variantWords.has(word))
    .flatMap((word) => word.split(/(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/u))
    .filter((word) => !gluedVariantWords.has(word));
  return words.join("-") || name;
}
const topDirectory = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "");

function artifactArchFits(artifact: ArtifactFactV2, platform: string) {
  return namePermits(artifact, platform);
}

// ---------------------------------------------------------------------------
// Release lines: which product a release belongs to.

/**
 * Words a tag's line drops: release-channel words, never a product name, alone
 * or glued to a number (`rc2`, `beta5`, `build123`). `release-1.2`,
 * `nightly-2026` and `v1.3` are one line; `game2-v1.1` and
 * `level-editor-v1.0.0` are lines of their own. `final` and `update` are not
 * channel words: they can name a product (`final-fantasy`, `updater`).
 */
const channelWords = new Set([
  "release",
  "releases",
  "rel",
  "version",
  "ver",
  "rev",
  "revision",
  "stable",
  "latest",
  "nightly",
  "continuous",
  "snapshot",
  "preview",
  "beta",
  "alpha",
  "rc",
  "pre",
  "prerelease",
  "dev",
  "build",
  "ci",
  "test",
  "testing",
  "hotfix",
]);
/** A release-channel word, alone or with a number glued after it. */
const channelMarker = (word: string) => {
  const match = /^([a-z]+)[0-9]*$/u.exec(word);
  return match !== null && channelWords.has(match[1]!);
};
/**
 * Operating-system and architecture words a tag's line drops, as whole words
 * only (`x86_64` is read as one word), so builds of one product for several
 * systems are one line: `windows-v1.0`, `win64-1.0` and `linux` are the main
 * line.
 */
const buildTargetWords = new Set([
  "windows",
  "win",
  "win32",
  "win64",
  "linux",
  "linux32",
  "linux64",
  "macos",
  "mac",
  "osx",
  "darwin",
  "universal",
  "x64",
  "x86",
  "x8664",
  "amd64",
  "arm64",
  "aarch64",
  "i386",
  "i686",
]);
/** A word the line drops: a channel marker or a build target. */
const droppedWord = (word: string) => channelMarker(word) || buildTargetWords.has(word);
/** A version token: digits, optionally after one `v`, `r` or `b`. */
const versionToken = (word: string) => /^[vrb]?[0-9]+$/u.test(word);
/**
 * A commit hash: 7 to 40 hex characters with at least one digit and one
 * letter a–f (`1a2b3c4`, `abc1234`). Read as version noise.
 */
export const hashToken = (word: string) =>
  /^[0-9a-f]{7,40}$/u.test(word) && /[0-9]/u.test(word) && /[a-f]/u.test(word);
/**
 * Channel words a line drops only when they stand next to a version, date or
 * hash, or when the tag holds nothing else: they also start product names
 * (`new-game`, `fix-it-felix`), so alone among product words they stay.
 */
const conditionalChannelWords = new Set([
  "tester",
  "prealpha",
  "canary",
  "wip",
  "experimental",
  "fixed",
  "fix",
  "new",
]);
const conditionalChannel = (word: string) =>
  conditionalChannelWords.has(word) || /^pr[0-9]+$/u.test(word);
/** A word that reads as a version, date or hash: digits, `v1`, `r2`, `b3` or a hash. */
const versionLike = (word: string | undefined) =>
  word !== undefined && (versionToken(word) || hashToken(word));

/**
 * Release-channel words of a rolling or unversioned build (`nightly`,
 * `continuous`, `latest`, `dev`, `build`, …).
 */
const rollingChannelWords = new Set([
  "nightly",
  "nightlies",
  "continuous",
  "latest",
  "dev",
  "devel",
  "develop",
  "development",
  "build",
  "builds",
  "snapshot",
  "canary",
  "preview",
  "test",
  "testing",
  "tester",
  "ci",
  "alpha",
  "beta",
  "rc",
  "pre",
  "prerelease",
  "prealpha",
  "wip",
  "experimental",
  "unstable",
  "daily",
  "weekly",
  "edge",
  "master",
  "main",
  "trunk",
  "head",
  "auto",
  "autobuild",
]);
/** A date or time word: an even number of digits, two to fourteen (`01`, `2250`, `20261120`). */
const dateWord = (word: string) => /^(?:[0-9]{2}){1,7}$/u.test(word);
/**
 * Whether a tag consists only of rolling-channel words plus dates, times,
 * hashes and build-target words (`build_20261120_2250`, `nightly-2025-01-01`,
 * `continuous`, `latest`, `dev-abc1234`). Such a release is a prerelease for
 * the newest-stable choice even when the provider does not flag it: it names
 * no version a player can rely on.
 */
export function channelOnlyTag(tag: string | null): boolean {
  if (tag === null || !/^[\x21-\x7e]+$/u.test(tag)) return false;
  const lower = tag.toLowerCase().replace(/(?<![a-z0-9])x86[_-]64(?![a-z0-9])/gu, "x8664");
  let channel = false;
  for (const word of lower.split(/[^a-z0-9]+/u).filter(Boolean)) {
    if (hashToken(word) || dateWord(word) || buildTargetWords.has(word)) continue;
    if (rollingChannelWords.has(word)) {
      channel = true;
      continue;
    }
    const glued = /^([a-z]+)([0-9]+)$/u.exec(word);
    if (glued && rollingChannelWords.has(glued[1]!) && dateWord(glued[2]!)) {
      channel = true;
      continue;
    }
    return false;
  }
  return channel;
}

/**
 * A release tag's line: its product words before the version, lowercase,
 * without release-channel or build-target words. Derivation errs toward ONE
 * line for version, channel and build-target noise and toward DIFFERENT lines
 * for different product words; a tag it cannot tell apart is a line of its
 * own, so the identity is excluded rather than enrolled for another product:
 *  - the version starts at a real version token: a whole word of digits,
 *    optionally after one `v`, `r` or `b` (`v1`, `r14388`, `2025`), never a
 *    number followed by a letter (`x2`, `game2` are product words); a
 *    product word with a glued `v<digits>` ending (`game2v0`) is cut there;
 *  - a `v`, `r` or `b` word directly followed (after a separator other than
 *    `.`) by another version token is a product word (`r2-v1.0` is `r2`);
 *  - a bare number of one or two digits directly after a product word, not
 *    before `.`, is part of the product when it is the last kept word
 *    (`game-2`, `sm-1`), or before another product word or a version
 *    (`game-64-v1`, `part-2-1.0`); before another bare number it is the
 *    version (`game-1-2-0`);
 *  - channel words, alone or glued to a number (`rc2`, `nightly20250101`),
 *    and build-target words (`win64`, `linux`, `x86_64`) are dropped.
 * A line spelling the repository's own name is the main line (`""`). A tag
 * that is not printable ASCII, or unknown, is a line of its own
 * (`#<release id>`), so it never merges with another.
 */
export function releaseLine(tag: string | null, releaseId: number, repository: string): string {
  if (tag === null || !/^[\x21-\x7e]+$/u.test(tag)) return `#${releaseId}`;
  const normalized = tag.toLowerCase().replace(/(?<![a-z0-9])x86[_-]64(?![a-z0-9])/gu, "x8664");
  const parts = [...normalized.matchAll(/([a-z0-9]+)([^a-z0-9]*)/gu)].map((match) => ({
    word: match[1]!,
    after: match[2]!.slice(0, 1),
  }));
  const bareNumber = (word: string | undefined) => word !== undefined && /^[0-9]+$/u.test(word);
  // Conditional channel words are noise beside a version, date or hash, or
  // when the tag holds only noise.
  const onlyNoise = parts.every(
    ({ word }) => droppedWord(word) || conditionalChannel(word) || versionLike(word),
  );
  const noise = parts.map(
    ({ word }, index) =>
      droppedWord(word) ||
      (conditionalChannel(word) &&
        (onlyNoise || versionLike(parts[index - 1]?.word) || versionLike(parts[index + 1]?.word))),
  );
  const words: string[] = [];
  let previousKept = false;
  for (const [index, { word, after }] of parts.entries()) {
    if (noise[index]) {
      previousKept = false;
      continue;
    }
    const next = parts[index + 1];
    // A commit hash is version noise; `v.0.1` is a version.
    if (hashToken(word)) break;
    if (word === "v" && after === "." && bareNumber(next?.word)) break;
    if (/^[vrb][0-9]+$/u.test(word)) {
      // `r2-v1.0`: a version-shaped word before another version names a product.
      if (after === "." || next === undefined || !versionToken(next.word)) break;
      words.push(word);
      previousKept = true;
      continue;
    }
    if (bareNumber(word)) {
      const rest = parts.slice(index + 1).filter((_, offset) => !noise[index + 1 + offset]);
      const partOfProduct =
        previousKept &&
        word.length <= 2 &&
        after !== "." &&
        (rest.length === 0 || !bareNumber(rest[0]!.word) || rest[0]!.after === ".");
      if (!partOfProduct) break;
      words.push(word);
      continue;
    }
    const glued = /^(.*[a-z].*?)v[0-9]+$/u.exec(word);
    if (glued && glued[1]!.length >= 2) {
      words.push(glued[1]!);
      break;
    }
    words.push(word);
    previousKept = true;
  }
  const name = (repository.split("/")[1] ?? "").toLowerCase().replace(/[^a-z0-9]/gu, "");
  return words.join("") === name ? "" : words.join("-");
}

/**
 * The words of a name: split at separators, camel-case humps and letter/digit
 * changes, lowercase (`OpenQuestPS1` is `open`, `quest`, `ps`, `1`;
 * `quest64recomp` is `quest`, `64`, `recomp`).
 */
export function nameWords(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9]+/u)
    .flatMap((word) =>
      word.split(
        /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/u,
      ),
    )
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * Whether a release line names the listed product itself: the main line, or
 * a line of at least three letters and digits that equals one whole word, or a
 * contiguous run of whole words, of the repository name or the listing's id,
 * name or original title (`nameWords`). A part of a word never counts: `rec`
 * does not name `quest64recomp`. Without a listing binding, only such a line
 * may be offered: a line of other product words (a level editor's
 * `level-editor-v1.0`) is never taken for the game.
 */
export function lineNamesProduct(
  line: string,
  repository: string,
  listing: Record<string, unknown>,
): boolean {
  if (line === "") return true;
  if (line.startsWith("#")) return false;
  const joined = line.replace(/-/gu, "");
  if (joined.length < 3) return false;
  return [repository.split("/")[1], listing.id, listing.name, listing.original_game_title].some(
    (value) => {
      if (typeof value !== "string") return false;
      const words = nameWords(value);
      for (let start = 0; start < words.length; start++) {
        let run = "";
        for (let end = start; end < words.length && run.length < joined.length; end++) {
          run += words[end]!;
          if (run === joined) return true;
        }
      }
      return false;
    },
  );
}

/**
 * The release line the listing itself binds the identity to: the tag its
 * `release_url` names on its own GitHub repository
 * (`https://github.com/<owner>/<name>/releases/tag/<tag>`), or null.
 */
export function boundReleaseLine(record: AuthoredPort): string | null {
  const url = record.listing.release_url;
  const prefix = "https://github.com/";
  if (typeof url !== "string" || !url.startsWith(prefix)) return null;
  const [owner, name, releases, tagWord, encoded, ...rest] = url.slice(prefix.length).split("/");
  if (
    rest.length ||
    !githubPathPart(owner) ||
    !githubPathPart(name) ||
    releases !== "releases" ||
    tagWord !== "tag" ||
    !encoded ||
    /[?#]/u.test(encoded)
  )
    return null;
  let tag: string;
  try {
    tag = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return releaseLine(tag, 0, `${owner}/${name}`);
}
const githubPathPart = (part: string | undefined): part is string =>
  part !== undefined && /^[A-Za-z0-9_.-]+$/u.test(part);

/**
 * Every GitHub repository a listing names through its release URL or its
 * project URL, with any path below the repository, lowercase. Permissive on
 * purpose: an identity is counted as sharing a repository whenever either URL
 * names it, so a listing URL into a subdirectory never hides a sharing
 * identity.
 */
export function listedRepositories(listing: Record<string, unknown>): string[] {
  const prefix = "https://github.com/";
  const named = new Set<string>();
  for (const url of [listing.release_url, listing.project_url]) {
    if (typeof url !== "string" || !url.startsWith(prefix)) continue;
    const [owner, name] = url.slice(prefix.length).split(/[?#]/u)[0]!.split("/");
    if (!githubPathPart(owner) || !githubPathPart(name)) continue;
    const bare = name.endsWith(".git") ? name.slice(0, -4) : name;
    named.add(`${owner}/${bare || name}`.toLowerCase());
  }
  return [...named];
}

/** Catalog-wide facts the fit rule needs beyond one record: who else names a repository. */
export interface FitContext {
  /** Lowercase GitHub repository -> every identity naming it, with its bound line. */
  repositories: Map<string, { port_id: string; line: string | null }[]>;
}
export function fitContext(records: readonly AuthoredPort[]): FitContext {
  const repositories = new Map<string, { port_id: string; line: string | null }[]>();
  for (const record of records)
    for (const key of listedRepositories(record.listing))
      repositories.set(key, [
        ...(repositories.get(key) ?? []),
        { port_id: record.listing.id, line: boundReleaseLine(record) },
      ]);
  return { repositories };
}

/** Why the observed releases do not tie this identity to one product's release, if they do not. */
function releaseLineProblem(
  record: AuthoredPort,
  entry: ListingFactsEntry,
  context: FitContext,
):
  | { reason: "shared-repository" | "ambiguous-release-line" | "no-stable-release"; detail: string }
  | undefined {
  const bound = boundReleaseLine(record);
  const sharing = (context.repositories.get(entry.repository.toLowerCase()) ?? []).filter(
    (other) => other.port_id !== entry.port_id,
  );
  const chosen = entry.observed_releases.find(
    (release) => release.release_id === entry.observation.release_id,
  );
  if (!chosen)
    return {
      reason: "ambiguous-release-line",
      detail: "The offered release is not among the observed releases, so its line is unknown.",
    };
  const lineOf = (release: ObservedReleaseFact) =>
    releaseLine(release.tag, release.release_id, entry.repository);
  const chosenLine = lineOf(chosen);
  if (sharing.length && (bound === null || sharing.some((other) => other.line === bound)))
    return {
      reason: "shared-repository",
      detail: `${sharing.length + 1} catalog identities name this repository, and the listing binds this one to no release line of its own.`,
    };
  if (chosen.prerelease !== false || channelOnlyTag(chosen.tag))
    return {
      reason: "no-stable-release",
      detail:
        "The offered release is a prerelease: its tag names only a release channel and a date, time or hash.",
    };
  // Lines are counted over stable packaged releases only (and releases whose
  // verdict Core did not give): a prerelease's tag noise never splits the
  // product. Prereleases are judged below.
  const stableOrUnknown = (release: ObservedReleaseFact) =>
    release.prerelease === null || (release.prerelease === false && !channelOnlyTag(release.tag));
  const lines = new Set([
    chosenLine,
    ...entry.observed_releases
      .filter((release) => release.packaged && stableOrUnknown(release))
      .map(lineOf),
  ]);
  if (bound !== null && bound !== chosenLine)
    return {
      reason: "ambiguous-release-line",
      detail: "The offered release is not on the release line the listing names.",
    };
  if (lines.size > 1 && bound === null)
    return {
      reason: "ambiguous-release-line",
      detail: `The repository's stable releases fall into ${lines.size} release lines, and the listing binds this identity to none.`,
    };
  if (bound === null && !lineNamesProduct(chosenLine, entry.repository, record.listing))
    return {
      reason: "ambiguous-release-line",
      detail:
        "The offered release's line names other product words than the repository or listing, and the listing binds this identity to no line.",
    };
  // A stable release older than a newer prerelease on another line that is
  // the main line or names the product (or whose line or verdict is unknown)
  // may be another product's older release beside the game's betas: never
  // offer it. A newer prerelease on a line of other product words (a tool's
  // beta) does not decide the game.
  const published = Date.parse(chosen.published_at ?? "");
  if (
    entry.observed_releases.some((release) => {
      const line = lineOf(release);
      return (
        (release.prerelease !== false || channelOnlyTag(release.tag)) &&
        line !== chosenLine &&
        !(Date.parse(release.published_at ?? "") <= published) &&
        (release.prerelease === null ||
          line.startsWith("#") ||
          lineNamesProduct(line, entry.repository, record.listing))
      );
    })
  )
    return {
      reason: "ambiguous-release-line",
      detail:
        "A newer prerelease on the main line or another line naming the product follows the offered stable release.",
    };
  return undefined;
}

/**
 * A release asset that is another package form than the archives the worker
 * reads, as the provider states it, with the platforms its form can serve.
 * Its bytes are never downloaded.
 */
export interface OtherPackage {
  asset_id: number;
  name: string;
  size: number;
  /** The provider's SHA-256, or null when it states none (UNKNOWN). */
  sha256: string | null;
  /** Supported platforms the form can serve, in `platforms` order. */
  platforms: string[];
}

/** Platforms a single-system package form serves. */
export const formPlatforms = {
  windows: ["windows-x86-64"],
  linux: ["linux-x86-64"],
  macos: ["macos-x86-64", "macos-aarch64"],
} as const;
/**
 * The closed list of release files that are never a program, by suffix, any
 * letter case: checksums and signatures, update metadata, text and documents,
 * images and media used as release decoration, debug symbols, patches and
 * torrents. Only this list and `nonProgramNames` ignore an asset; every other
 * file that is not a read archive, a library or a non-desktop package
 * competes with the archive.
 */
export const nonProgramSuffixes = [
  // Checksums and signatures.
  ".sha1",
  ".sha224",
  ".sha256",
  ".sha384",
  ".sha512",
  ".sha1sum",
  ".sha256sum",
  ".sha512sum",
  ".sha256sums",
  ".md5",
  ".md5sum",
  ".checksum",
  ".checksums",
  ".sig",
  ".asc",
  ".minisig",
  ".pem",
  ".gpg",
  ".sigstore",
  ".intoto.jsonl",
  // Update metadata.
  ".blockmap",
  ".zsync",
  ".yml",
  ".yaml",
  ".json",
  ".xml",
  ".plist",
  // Text and documents.
  ".txt",
  ".md",
  ".markdown",
  ".rst",
  ".pdf",
  ".html",
  ".htm",
  ".rtf",
  ".nfo",
  ".log",
  ".csv",
  // Images and media.
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".mp4",
  ".webm",
  ".mov",
  // Debug symbols.
  ".pdb",
  ".dbg",
  ".debug",
  ".sym",
  // Patches and torrents.
  ".torrent",
  ".patch",
  ".diff",
] as const;
/** Exact whole names, any letter case, that are never a program. */
export const nonProgramNames = [
  "sha256sums",
  "sha512sums",
  "sha1sums",
  "md5sums",
  "b2sums",
  "b3sums",
  "shasums",
  "shasums256",
  "shasums512",
  "checksum",
  "checksums",
  "hashes",
  "signatures",
  "sha256sum",
  "sha512sum",
  "sha1sum",
  "md5sum",
  "releases",
  "version",
  "manifest",
  "license",
  "licence",
  "copying",
  "readme",
  "changelog",
  "changes",
  "notice",
  "authors",
  "credits",
  "news",
  "todo",
  "install",
  "makefile",
  "dockerfile",
] as const;
/** An SPDX-looking license name (`gpl-3.0`, `lgpl-2.1-or-later`, `apache-2.0`). */
const spdxName =
  /^(?:(?:a|l)?gpl|mpl|apache|epl|cddl|eupl|ofl|artistic|bsl|cc0|cc-by(?:-sa|-nc|-nd)*)-[0-9]+(?:\.[0-9]+)*(?:-only|-or-later)?$|^bsd-[0-9]-clause$/u;
/**
 * A documentation word followed only by `.lesser` or `-`, `_` or `.` and a
 * license identifier (`LICENSE-MIT`, `COPYING.LESSER`, `Licence-Apache`,
 * `NOTICE-THIRD-PARTY`). A document suffix (`README.markdown`) is on
 * `nonProgramSuffixes`. Anything else after the word (`Readme-Launcher`,
 * `Changes-Game-linux`) is classified by the other rules.
 */
const documentPrefix =
  /^(?:license|licence|copying|readme|changelog|changes|notice|authors)(?:\.lesser|[._-](?:third[-_]?party|3rd[-_]?party|(?:mit|bsd|isc|zlib|apache|gpl|lgpl|agpl|mpl|epl|ofl|cc0|cc-by(?:-sa)?|unlicense|boost|bsl)(?:[-_.]?[0-9]+(?:\.[0-9]+)*)?(?:[-_.]?(?:only|or-later|clause))?))?$/u;
/** A release file that is never a program: `nonProgramSuffixes`, `nonProgramNames` or a license name. */
export const nonProgramFile = (name: string) => {
  const lower = name.toLowerCase();
  return (
    nonProgramSuffixes.some((suffix) => lower.endsWith(suffix)) ||
    (nonProgramNames as readonly string[]).includes(lower) ||
    spdxName.test(lower) ||
    documentPrefix.test(lower)
  );
};
/** A shared library: `*.so`, `*.so.<n>[.<n>…]`, `*.dll`, `*.dylib`. */
const libraryName = (lower: string) =>
  /\.so(\.[0-9]+)*$/u.test(lower) || lower.endsWith(".dll") || lower.endsWith(".dylib");
/**
 * A volume of a split file (`Game.7z.001`, `Game.zip.001`, `Game.exe.001`,
 * `Game.iso.001`, bare `Game.001`, `Game.z01`, `Game.r00`, `Game.part1.rar`):
 * any name ending `.` and three or more digits is one, whatever precedes it. A
 * container the worker does not read.
 */
export const splitVolume = (name: string) =>
  /\.[0-9]{3,}$/u.test(name) ||
  /\.(?:z|r)[0-9]{2}$/u.test(name.toLowerCase()) ||
  /\.part[0-9]+\.rar$/u.test(name.toLowerCase());

/**
 * The kind of another package form a release asset is, judged in this order
 * on the lowercased name; the first match decides:
 *  1. a read archive (`archiveForms`, also `.app.zip`, `.dSYM.zip`): undefined;
 *  2. a shared library (`*.so`, `*.so.<n>…`, `*.dll`, `*.dylib`): undefined;
 *  3. a file on the closed non-program list (`nonProgramFile`): undefined;
 *  4. a volume of a split file (`splitVolume`): `container`;
 *  5. `windows`: `.exe`, `.msi`, `.msix`, `.appx`, `.msixbundle`, `.appxbundle`;
 *     `linux`: `.AppImage`, `.deb`, `.rpm`, `.flatpak`, `.snap`, `.run`,
 *     `.bin`, `.sh`, `.linux`, `.x86`, `.x86_64`, `.arm64`, `.aarch64`, or a
 *     bare binary: a name with no file extension (no final `.` followed by
 *     letters and digits including a letter, other than a version such as
 *     `v1`), so `game-v1.0`, `Game.v1.2` and `game.1.2.3` are bare binaries;
 *     `macos`: `.dmg`, `.pkg`;
 *  6. a non-desktop package (`nonDesktopForms`): undefined;
 *  7. everything else, any other or unknown extension (`.7z`, `.txz`,
 *     `.tar.Z`, `.zipx`, `.sit`, `.wim`, `.iso`, `.pck`, `.xyz`, …):
 *     `container`, an unread container serving every platform its name
 *     permits.
 * An unknown form therefore competes with the archive instead of being
 * ignored; extending `nonProgramSuffixes` is the deliberate way to ignore one.
 */
export function otherPackageForm(
  name: string,
): "windows" | "linux" | "macos" | "container" | undefined {
  const lower = name.toLowerCase();
  if (archiveForms.some((form) => lower.endsWith(form))) return undefined;
  if (libraryName(lower) || nonProgramFile(name)) return undefined;
  if (splitVolume(name)) return "container";
  if (windowsForms.some((form) => lower.endsWith(form))) return "windows";
  if (linuxForms.some((form) => lower.endsWith(form))) return "linux";
  if (lower.endsWith(".dmg") || lower.endsWith(".pkg")) return "macos";
  if ((nonDesktopForms as readonly string[]).some((form) => lower.endsWith(form))) return undefined;
  // A file extension: a final `.` and letters and digits, one a letter, that
  // are not a version (`v1`).
  const extension = /\.([a-z0-9]+)$/u.exec(lower)?.[1];
  if (extension === undefined || !/[a-z]/u.test(extension) || /^v[0-9]+$/u.test(extension))
    return "linux";
  return "container";
}
const windowsForms: readonly string[] = [
  ".exe",
  ".msi",
  ".msix",
  ".appx",
  ".msixbundle",
  ".appxbundle",
];
const linuxForms: readonly string[] = [
  ".appimage",
  ".deb",
  ".rpm",
  ".flatpak",
  ".snap",
  ".run",
  ".bin",
  ".sh",
  ".linux",
  ".x86",
  ".x86_64",
  ".arm64",
  ".aarch64",
];

/**
 * The platforms another package form serves: its system's platforms, or for
 * a container every platform its name permits (every platform when Core
 * could not classify the name).
 */
export function otherPackagePlatforms(
  name: string,
  suggestion: NameSuggestion | undefined,
): string[] {
  const kind = otherPackageForm(name);
  if (kind === undefined) return [];
  if (kind !== "container") return [...formPlatforms[kind]];
  return platforms.filter((platform) => !suggestion || namePermitsName(suggestion, platform));
}

/**
 * The other packages of the release that compete with an offered archive:
 * per platform P that the release also offers a readable archive for (one
 * whose name permits P), every other package serving P whose digest is
 * unknown or equal to no player of those archives that runs on P. Such a
 * release offers a different package than the archive on a platform the rule
 * would bind, so the archives' role is unknown and the whole identity is
 * excluded. A form serving only platforms without an offered archive is
 * ignored: no platform of it can be bound.
 */
export function competingPackages(entry: ListingFactsEntry): [string, OtherPackage[]][] {
  const competing: [string, OtherPackage[]][] = [];
  for (const platform of platforms) {
    const offered = entry.artifacts.filter((artifact) => namePermits(artifact, platform));
    if (!offered.length) continue;
    const players = new Set(
      offered.flatMap((artifact) =>
        artifact.players
          .filter((player) => machineRunsOn(player.machine, platform))
          .map((player) => player.sha256),
      ),
    );
    const foreign = entry.other_packages.filter(
      (other) =>
        other.platforms.includes(platform) && (other.sha256 === null || !players.has(other.sha256)),
    );
    if (foreign.length) competing.push([platform, foreign]);
  }
  return competing;
}

export interface PlatformRuntime {
  platform: string;
  asset_id: number;
  asset_name: string;
  archive_sha256: string;
  source: string;
  players: PlayerFact[];
}

const toolRoles = new Set([
  "dedicated-server",
  "builder",
  "installer",
  "importer",
  "compiler",
  "dev-tool",
]);
/**
 * Whole words of an archive's own name that make it another role than the
 * game package: an update or patch payload, a delta, or symbols and debug
 * builds. An archive holding the game's own program under such a name (an
 * update archive beside the full game) is never offered.
 */
export const archiveRoleTokens = [
  "update",
  "updater",
  "hotfix",
  "delta",
  "incremental",
  "patch",
  "symbols",
  "debug",
] as const;
/** The first role token among the separator-delimited words of an archive name, or null. */
export function archiveRoleToken(name: string): string | null {
  const words = new Set(name.toLowerCase().split(/[^a-z0-9]+/u));
  return archiveRoleTokens.find((token) => words.has(token)) ?? null;
}
/** Whether an artifact is vetoed by its own name or its contradiction flag. */
const vetoed = (artifact: ArtifactFactV2) =>
  artifact.contradictory || archiveRoleToken(artifact.name) !== null;

/** Why an archive's own name vetoes it. */
function vetoReason(artifact: ArtifactFactV2): BlockedReason {
  const named = artifact.name_suggestion;
  if (
    named.system_token !== null ||
    ["mobile-package", "console-output"].includes(named.role) ||
    ["android", "ios", "console", "web"].includes(named.os)
  )
    return "non-desktop-platform";
  if (named.tool_token !== null || toolRoles.has(named.role)) return "tool-not-game";
  return "contradictory-role";
}

/** The players of these artifacts that run on P, by artifact in asset order, for artifacts whose name permits P. */
function hostedPlayers(artifacts: readonly ArtifactFactV2[], platform: string) {
  return artifacts
    .filter((artifact) => artifactArchFits(artifact, platform))
    .toSorted((left, right) => left.asset_id - right.asset_id)
    .map((artifact) => ({
      artifact,
      players: artifact.players
        .filter((player) => machineRunsOn(player.machine, platform))
        .map((player) => ({ ...player }))
        .toSorted((left, right) => compareCodePoints(left.path, right.path)),
    }))
    .filter(({ players }) => players.length);
}

/**
 * The one package P is offered from, or undefined when it is ambiguous.
 * Archives are the same package only when their bytes are (equal archive
 * SHA-256); equal players in different archives are not (a 4 MB update
 * archive can hold the same game program as the full 145 MB build). When
 * more than one distinct archive remains, exactly one whose name explicitly
 * names P's operating system beside only OS-neutral others is chosen; any
 * other combination is ambiguous. Order and size never choose.
 */
function onePackage(hosted: ReturnType<typeof hostedPlayers>, platform: string) {
  const distinct = [
    ...new Map(hosted.map((item) => [item.artifact.sha256, item] as const)).values(),
  ];
  if (distinct.length === 1) return distinct[0];
  const explicit = distinct.filter(
    ({ artifact }) => artifact.name_suggestion.os === hostOs[platform],
  );
  const neutral = distinct.filter(({ artifact }) => artifact.name_suggestion.os === "unknown");
  return explicit.length === 1 && explicit.length + neutral.length === distinct.length
    ? explicit[0]
    : undefined;
}

/** Why the players one platform would get are not one program, if they are not. */
function ambiguity(
  hosted: ReturnType<typeof hostedPlayers>,
): { kind: "several-programs" | "several-directories"; names: string[] } | undefined {
  const players = hosted.flatMap((item) => item.players);
  const programs = new Set(players.map(({ path }) => programStem(path)));
  const names = [...new Set(players.map(({ display_path }) => basename(display_path)))].toSorted(
    compareCodePoints,
  );
  if (programs.size > maxDistinctPrograms) return { kind: "several-programs", names };
  if (hosted.some((item) => new Set(item.players.map(({ path }) => topDirectory(path))).size > 1))
    return { kind: "several-directories", names };
  return undefined;
}

/** The `ambiguous-player` exclusions of an entry: one per kind, from the first platform that has it. */
function ambiguityExclusions(entry: ListingFactsEntry): Exclusion[] {
  const usable = entry.artifacts.filter(
    (artifact) =>
      artifact.role === "desktop-game-runtime" &&
      artifact.source.kind === authorizingSource &&
      !vetoed(artifact),
  );
  const found = new Map<string, Exclusion>();
  for (const platform of platforms) {
    const ambiguous = ambiguity(hostedPlayers(usable, platform));
    if (ambiguous && !found.has(ambiguous.kind))
      found.set(ambiguous.kind, {
        reason: "ambiguous-player",
        token: ambiguous.kind,
        name: ambiguous.names.slice(0, 4).join(" + ").slice(0, 255),
      });
  }
  return [...found.values()];
}

/** Every exclusion of an entry: name-based vetoes and ambiguous players. */
export function entryExclusions(entry: ListingFactsEntry): Exclusion[] {
  return [...entry.artifacts.flatMap(artifactExclusions), ...ambiguityExclusions(entry)];
}

/** An artifact that establishes a runtime for P from exact bytes, or the reason none does. */
function platformRuntime(
  entry: ListingFactsEntry,
  platform: string,
): { runtime: PlatformRuntime } | { reason: BlockedReason } {
  // A refused archive whose own name allows P could be P's game or a second
  // one: P is never decided around it.
  if (
    entry.refused_archives.some(
      (archive) =>
        !nameVetoes(archive.name_suggestion) && namePermitsName(archive.name_suggestion, platform),
    )
  )
    return { reason: "core-refused" };
  const runtimes = entry.artifacts.filter((artifact) => artifact.role === "desktop-game-runtime");
  if (!runtimes.length)
    return {
      reason: entry.artifacts.some((artifact) => artifact.excluded_players.length)
        ? "tool-not-game"
        : "no-player",
    };
  const authorized = runtimes.filter((artifact) => artifact.source.kind === authorizingSource);
  if (!authorized.length) return { reason: "no-authorizing-source" };
  const consistent = authorized.filter((artifact) => !vetoed(artifact));
  if (!consistent.length)
    return {
      reason:
        (["non-desktop-platform", "tool-not-game", "contradictory-role"] as const).find((reason) =>
          authorized.some((artifact) => vetoReason(artifact) === reason),
        ) ?? "contradictory-role",
    };
  const hosted = hostedPlayers(consistent, platform);
  if (!hosted.length) {
    const classes = new Set(
      consistent.flatMap((artifact) =>
        artifact.players.map(({ machine }) => machineSystem(machine).platformClass),
      ),
    );
    return {
      reason: classes.has("desktop")
        ? "wrong-host"
        : classes.has("unknown")
          ? "unknown-platform"
          : "non-desktop-platform",
    };
  }
  if (ambiguity(hosted)) return { reason: "ambiguous-player" };
  // An archive that bundles a compiler, interpreter or build helper builds
  // or prepares the game on the player's machine: it needs a person.
  if (hosted.some(({ artifact }) => artifact.bundled_toolchain.length))
    return { reason: "bundled-toolchain" };
  const chosen = onePackage(hosted, platform);
  if (!chosen) return { reason: "ambiguous-artifact" };
  const { artifact, players } = chosen;
  return {
    runtime: {
      platform,
      asset_id: artifact.asset_id,
      asset_name: artifact.name,
      archive_sha256: artifact.sha256,
      source: artifact.source.kind,
      players,
    },
  };
}

// ---------------------------------------------------------------------------
// The fit decision.

export const blockedReasons = [
  "operational-route",
  "scummvm-engine",
  "upstream-unavailable",
  "no-readable-upstream",
  "no-observation",
  "repository-mismatch",
  "stale-parser",
  ...ineligibleReasons,
  "incomplete-coverage",
  "stale-facts",
  "shared-repository",
  "ambiguous-release-line",
  "other-package-form-beside-archive",
  "no-player",
  "tool-not-game",
  "no-authorizing-source",
  "contradictory-role",
  "unknown-platform",
  "wrong-host",
  "ambiguous-player",
  "ambiguous-artifact",
  "bundled-toolchain",
  "route-held",
  "guide-bound",
] as const;
export type BlockedReason = (typeof blockedReasons)[number];

export interface GeneratedEnrollment {
  port_id: string;
  platforms: string[];
  generator_version: number;
  facts_sha256: string;
  repository: string;
  repository_id: number;
  release: { id: number; tag: string; observed_at: string };
  runtimes: PlatformRuntime[];
}
export type FitDecision =
  | { port_id: string; fit: true; enrollment: GeneratedEnrollment }
  | { port_id: string; fit: false; reason: BlockedReason; detail: string };

/** When no platform fits, the identity's reason is the first of these any platform gave. */
const reasonPriority: BlockedReason[] = [
  "ambiguous-player",
  "ambiguous-artifact",
  "core-refused",
  "bundled-toolchain",
  "wrong-host",
  "unknown-platform",
  "non-desktop-platform",
  "contradictory-role",
  "tool-not-game",
  "no-authorizing-source",
  "no-player",
];

/** Whether the entry's facts are too old or upstream has been unknown too long. */
export function factsFreshness(
  entry: ListingFactsEntry,
  generatedAt: string,
): { reason: "stale-facts" | "observation-unavailable"; detail: string } | undefined {
  const reference = Date.parse(generatedAt);
  const age = (reference - Date.parse(entry.observation.observed_at)) / day;
  if (age > maxFactsAgeDays)
    return {
      reason: "stale-facts",
      detail: `Facts were last confirmed ${Math.floor(age)} days before this table; the bound is ${maxFactsAgeDays}.`,
    };
  // The worker's own inspection backlog (`pending-inspection`) is not an
  // upstream attempt: upstream was complete, so only the facts age applies.
  if (entry.attempt && entry.attempt.status !== "pending-inspection") {
    const unknown = (reference - Date.parse(entry.attempt.first_at)) / day;
    if (unknown > lastGoodRetentionDays)
      return {
        reason: "observation-unavailable",
        detail: `Upstream has been ${entry.attempt.status} for ${Math.floor(unknown)} days; last-good facts are kept for ${lastGoodRetentionDays}.`,
      };
  }
  return undefined;
}

export function fitDecision(
  record: AuthoredPort,
  entry: ListingFactsEntry | undefined,
  generatedAt: string,
  context: FitContext,
): FitDecision {
  const port_id = record.listing.id;
  const blocked = (reason: BlockedReason, detail: string): FitDecision => ({
    port_id,
    fit: false,
    reason,
    detail,
  });
  if (record.integration !== undefined)
    return blocked("operational-route", "An authored operational route exists.");
  if (record.route_facts_v1 !== undefined)
    return blocked("operational-route", "A reviewed prepared-player route enrollment exists.");
  if (usesScummvmEngine(record))
    return blocked("scummvm-engine", "Runs on the ScummVM engine; onboarding is deferred.");
  const availability = record.listing.availability;
  if (availability === "source-only" || availability === "unavailable")
    return blocked("upstream-unavailable", `Upstream availability is ${availability}.`);
  const identity = listingProviderIdentity(record.listing);
  if (identity?.provider !== "github")
    return blocked("no-readable-upstream", "No GitHub release provider reads this upstream.");
  if (!entry) return blocked("no-observation", "No listing package facts exist; UNKNOWN.");
  if (entry.repository.toLowerCase() !== identity.repository.toLowerCase())
    return blocked(
      "repository-mismatch",
      `Facts observed ${entry.repository}, but the listing names ${identity.repository}.`,
    );
  if (entry.parser !== FACTS_PARSER || entry.parser_version !== FACTS_PARSER_VERSION)
    return blocked("stale-parser", `Facts come from ${entry.parser} v${entry.parser_version}.`);
  if (entry.ineligible) return blocked(entry.ineligible.reason, entry.ineligible.detail);
  if (entry.observation.coverage !== "complete" || !entry.observation.assets_complete)
    return blocked(
      "incomplete-coverage",
      `Observation coverage is ${entry.observation.coverage}${entry.observation.assets_complete ? "" : " with an incomplete asset list"}; UNKNOWN.`,
    );
  const freshness = factsFreshness(entry, generatedAt);
  if (freshness) return blocked(freshness.reason, freshness.detail);
  const line = releaseLineProblem(record, entry, context);
  if (line) return blocked(line.reason, line.detail);
  const competing = competingPackages(entry);
  if (competing.length) {
    const names = [
      ...new Set(competing.flatMap(([, foreign]) => foreign.map((other) => other.name))),
    ];
    const unknown = competing.some(([, foreign]) => foreign.some((other) => other.sha256 === null));
    return blocked(
      "other-package-form-beside-archive",
      `On ${competing.map(([platform]) => platform).join(", ")} the release offers an archive and also ships ${names.length} other package file(s) that are not that archive's player (${names
        .slice(0, 3)
        .join(
          ", ",
        )}${unknown ? "; a digest is UNKNOWN" : ""}), so the archives' role is unknown and the identity awaits review.`.slice(
        0,
        1000,
      ),
    );
  }
  const runtimes: PlatformRuntime[] = [];
  const misses = new Set<BlockedReason>();
  const held: string[] = [];
  for (const platform of platforms) {
    const found = platformRuntime(entry, platform);
    if ("reason" in found) {
      misses.add(found.reason);
      continue;
    }
    const hold = ["register-external", "launch"]
      .map((operation) => heldAt(record, operation, platform))
      .find(Boolean);
    if (hold) {
      held.push(`${platform} (${hold.reason ?? hold.id})`);
      continue;
    }
    runtimes.push(found.runtime);
  }
  if (!runtimes.length) {
    if (held.length)
      return blocked("route-held", `Registration or launch is held on ${held.join(", ")}.`);
    const reason = reasonPriority.find((candidate) => misses.has(candidate)) ?? "no-player";
    const vetoes = entryExclusions(entry).map(
      (item) => `${item.reason} ${item.token} (${item.name})`,
    );
    return blocked(
      reason,
      `No supported desktop platform fits: ${[...misses].toSorted(compareCodePoints).join(", ")}.${
        vetoes.length ? ` Fail-safe exclusions: ${vetoes.slice(0, 8).join(", ")}.` : ""
      }`.slice(0, 1000),
    );
  }
  if (!authoredGuideFits(record))
    return blocked(
      "guide-bound",
      "The authored guide leaves no room for the selection step and ownership reference within the eight-entry guide bound.",
    );
  return {
    port_id,
    fit: true,
    enrollment: {
      port_id,
      platforms: runtimes.map((runtime) => runtime.platform),
      generator_version: GENERATOR_VERSION,
      facts_sha256: digestOf(entry),
      repository: entry.repository,
      repository_id: entry.repository_id,
      release: {
        id: entry.observation.release_id!,
        tag: entry.observation.tag!,
        observed_at: entry.observation.observed_at,
      },
      runtimes,
    },
  };
}

// ---------------------------------------------------------------------------
// Fail-safe exclusions: every name-based veto and every ambiguous player set,
// so groups of wrongly excluded real games can be found and the rule, not a
// single game, fixed.

export const exclusionReasons = [
  "asset-tool-name",
  "asset-system-token",
  "asset-role-name",
  "asset-system-name",
  "asset-architecture-name",
  "player-tool-name",
  "ambiguous-player",
  "bundled-toolchain",
] as const;
export interface Exclusion {
  reason: (typeof exclusionReasons)[number];
  /** The vetoing token, role, system or architecture. */
  token: string;
  /** The vetoed asset name or program file name. */
  name: string;
}

/** The name-based vetoes that excluded a native runtime or player of one artifact. */
export function artifactExclusions(artifact: ArtifactFactV2): Exclusion[] {
  const named = artifact.name_suggestion;
  const exclusions: Exclusion[] = [];
  // An archive name vetoes only an archive that holds native programs.
  if (artifact.players.length || artifact.excluded_players.length) {
    if (named.tool_token !== null)
      exclusions.push({ reason: "asset-tool-name", token: named.tool_token, name: artifact.name });
    if (named.system_token !== null)
      exclusions.push({
        reason: "asset-system-token",
        token: named.system_token,
        name: artifact.name,
      });
    if (named.role !== "desktop-game-runtime" && named.role !== "unknown")
      exclusions.push({ reason: "asset-role-name", token: named.role, name: artifact.name });
    const roleToken = archiveRoleToken(artifact.name);
    if (roleToken !== null)
      exclusions.push({ reason: "asset-role-name", token: roleToken, name: artifact.name });
  }
  for (const helper of artifact.bundled_toolchain)
    exclusions.push({ reason: "bundled-toolchain", token: helper, name: artifact.name });
  // System and architecture compare with each kept player's header machine:
  // the name is vetoed when no player has what it names.
  if (artifact.players.length) {
    const systems = artifact.players.map(({ machine }) => machineSystem(machine));
    if (named.os !== "unknown" && !systems.some(({ os }) => os === named.os))
      exclusions.push({ reason: "asset-system-name", token: named.os, name: artifact.name });
    if (!systems.some(({ arch }) => archAgrees(named.arch, arch)))
      exclusions.push({
        reason: "asset-architecture-name",
        token: named.arch,
        name: artifact.name,
      });
  }
  for (const player of artifact.excluded_players)
    exclusions.push({
      reason: "player-tool-name",
      token: player.token,
      name: basename(player.display_path),
    });
  return exclusions;
}

export interface ExclusionGroup {
  reason: Exclusion["reason"];
  token: string;
  /** Identities with at least one such exclusion. */
  count: number;
  /** Up to `exclusionExamples` identities, in port_id order, with their outcome. */
  examples: { port_id: string; name: string; outcome: string }[];
}
export const exclusionExamples = 5;

/** Exclusions grouped by reason and token, most frequent first. */
export function failSafeExclusions(generation: Generation): ExclusionGroup[] {
  const outcomes = new Map(
    generation.decisions.map((decision) => [
      decision.port_id,
      decision.fit ? "enrolled" : decision.reason,
    ]),
  );
  const groups = new Map<string, ExclusionGroup>();
  for (const entry of generation.facts.entries) {
    const seen = new Set<string>();
    for (const exclusion of entryExclusions(entry)) {
      const key = `${exclusion.reason}\u0000${exclusion.token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key) ?? {
        reason: exclusion.reason,
        token: exclusion.token,
        count: 0,
        examples: [],
      };
      group.count++;
      if (group.examples.length < exclusionExamples)
        group.examples.push({
          port_id: entry.port_id,
          name: exclusion.name,
          outcome: outcomes.get(entry.port_id) ?? "unknown",
        });
      groups.set(key, group);
    }
  }
  return [...groups.values()].toSorted(
    (left, right) =>
      right.count - left.count ||
      compareCodePoints(left.reason, right.reason) ||
      compareCodePoints(left.token, right.token),
  );
}

/**
 * The owner's exception queues: every listing-only identity the generated
 * route does not enroll, grouped by machine-readable reason, with complete
 * identity lists in port_id order. Report output only (`catalog-route-fit.mts
 * --json`); the committed enrollment table keeps counts and examples.
 */
export interface RegistrationQueues {
  /** Every blocked reason, each with all of its identities. */
  reasons: Record<BlockedReason, string[]>;
  /**
   * Identities whose observed release holds each package form the worker does
   * not read, also when a supported archive sits beside it.
   */
  unread_forms: Record<string, string[]>;
  /** Every name-based veto as `reason:token`, with all of its identities. */
  exclusions: Record<string, string[]>;
  /** Every refusal class of a refused archive, with the identities that have one. */
  refusals: Record<string, string[]>;
  /**
   * Every GitHub repository more than one catalog identity names, with those
   * identities: the `shared-repository` queue an owner clears with a reviewed
   * release-line binding, whether or not facts exist yet.
   */
  shared_repositories: Record<string, string[]>;
  /**
   * Every enrolled identity whose release also records another package form
   * serving a platform with no offered archive (`competingPackages` ignores
   * such a form), in port_id order: a review queue for the residual where
   * the release's only program for an enrolled platform is not the game (a
   * Windows installer beside a neutral-named Linux tarball holding something
   * else, and the mirror case).
   */
  enrolled_beside_unoffered_forms: string[];
  /**
   * The `other-package-form-beside-archive` queue's evidence: per withheld
   * identity, in port_id order, the names of the release assets that compete
   * with its archive, in code-point order: every one, bounded only by the
   * release's own assets in the observer's `listingPackageLimit` window. An
   * unusual extra file listed here is how a
   * person decides deliberately whether the closed non-program list
   * (`nonProgramSuffixes`) should grow.
   */
  other_package_forms: Record<string, string[]>;
  /**
   * The `bundled-toolchain` queue's evidence: per identity with an archive
   * that bundles a toolchain helper, in port_id order, the helper names
   * (bounded by the closed `toolchainHelpers` list).
   */
  bundled_toolchains: Record<string, string[]>;
  /**
   * The `repeated-inspection-failure` queue by typed cause
   * (`failureCauses`), each with its identities.
   */
  inspection_failures: Record<string, string[]>;
}

export function registrationQueues(generation: Generation): RegistrationQueues {
  const reasons = Object.fromEntries(blockedReasons.map((reason) => [reason, [] as string[]]));
  for (const decision of generation.decisions)
    if (!decision.fit) reasons[decision.reason]!.push(decision.port_id);
  const grouped = (pairs: [string, string][]) => {
    const groups: Record<string, string[]> = {};
    for (const key of [...new Set(pairs.map(([key]) => key))].toSorted(compareCodePoints))
      groups[key] = [
        ...new Set(pairs.filter(([candidate]) => candidate === key).map(([, id]) => id)),
      ].toSorted(compareCodePoints);
    return groups;
  };
  return {
    reasons: Object.fromEntries(
      Object.entries(reasons).map(([reason, ids]) => [reason, ids.toSorted(compareCodePoints)]),
    ) as Record<BlockedReason, string[]>,
    unread_forms: grouped(
      generation.facts.entries.flatMap((entry) =>
        entry.unread_forms.map((form): [string, string] => [form, entry.port_id]),
      ),
    ),
    exclusions: grouped(
      generation.facts.entries.flatMap((entry) =>
        entryExclusions(entry).map((item): [string, string] => [
          `${item.reason}:${item.token}`,
          entry.port_id,
        ]),
      ),
    ),
    refusals: grouped(
      generation.facts.entries.flatMap((entry) =>
        entry.refused_archives.map((archive): [string, string] => [archive.refusal, entry.port_id]),
      ),
    ),
    shared_repositories: Object.fromEntries(
      [...fitContext(generation.records).repositories]
        .filter(([, identities]) => identities.length > 1)
        .map(([repository, identities]): [string, string[]] => [
          repository,
          [...new Set(identities.map((identity) => identity.port_id))].toSorted(compareCodePoints),
        ])
        .filter(([, ids]) => ids.length > 1)
        .toSorted(([left], [right]) => compareCodePoints(left, right)),
    ),
    enrolled_beside_unoffered_forms: generation.decisions
      .filter((decision) => {
        if (!decision.fit) return false;
        const entry = generation.facts.entries.find(
          (candidate) => candidate.port_id === decision.port_id,
        );
        return (entry?.other_packages ?? []).some((other) =>
          other.platforms.some(
            (platform) => !entry!.artifacts.some((artifact) => namePermits(artifact, platform)),
          ),
        );
      })
      .map((decision) => decision.port_id)
      .toSorted(compareCodePoints),
    other_package_forms: Object.fromEntries(
      generation.decisions
        .filter(
          (decision) => !decision.fit && decision.reason === "other-package-form-beside-archive",
        )
        .map((decision) => decision.port_id)
        .toSorted(compareCodePoints)
        .flatMap((id): [string, string[]][] => {
          const entry = generation.facts.entries.find((candidate) => candidate.port_id === id);
          if (!entry) return [];
          const names = new Set(
            competingPackages(entry).flatMap(([, foreign]) => foreign.map((other) => other.name)),
          );
          return [[id, [...names].toSorted(compareCodePoints)]];
        }),
    ),
    bundled_toolchains: Object.fromEntries(
      generation.facts.entries
        .map((entry): [string, string[]] => [
          entry.port_id,
          [...new Set(entry.artifacts.flatMap((artifact) => artifact.bundled_toolchain))].toSorted(
            compareCodePoints,
          ),
        ])
        .filter(([, names]) => names.length)
        .toSorted(([left], [right]) => compareCodePoints(left, right)),
    ),
    inspection_failures: grouped(
      generation.facts.entries.flatMap((entry): [string, string][] =>
        entry.ineligible?.reason === "repeated-inspection-failure" && entry.ineligible.cause
          ? [[entry.ineligible.cause, entry.port_id]]
          : [],
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// The generated route: the shared registration-only form plus generic copy.

const platformLabels: Record<string, string> = {
  "windows-x86-64": "Windows",
  "linux-x86-64": "Linux",
  "macos-x86-64": "macOS (Intel)",
  "macos-aarch64": "macOS (Apple silicon)",
};
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Upstream text reaches the player only through this conservative class:
 * printable ASCII letters, digits and `._-+()[]` plus inner spaces, at most
 * 120 characters. Anything else (format and bidi controls, zero-width or
 * look-alike characters) is never rendered; generic wording replaces it.
 */
export function displayableName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    /^[A-Za-z0-9._+()[\]-](?:[A-Za-z0-9 ._+()[\]-]*[A-Za-z0-9._+()[\]-])?$/u.test(value)
  );
}

export const genericSelection =
  "Select the game program in your prepared copy. Use its containing folder as the working folder. Leave arguments empty unless upstream documents some.";

/**
 * The concrete selection step. A program is named only when the facts name
 * exactly one player per platform, the same everywhere, and its original-case
 * name passes the display class; otherwise the wording stays generic.
 */
function selectionInstruction(enrollment: GeneratedEnrollment) {
  const names = enrollment.runtimes.map(
    (runtime) => new Set(runtime.players.map((player) => basename(player.display_path))),
  );
  if (!names.every((set) => set.size === 1)) return genericSelection;
  const distinct = new Set(names.map((set) => [...set][0]!));
  const [name] = distinct;
  // A launcher or settings program may be the documented entry point, but
  // the guide never calls it the game.
  if (distinct.size !== 1 || !displayableName(name!) || /launcher|settings|config/iu.test(name!))
    return genericSelection;
  return `Select ${name} in your prepared copy. Use its containing folder as the working folder. Leave arguments empty unless upstream documents some.`;
}

/** At most three displayable names, then a count of the rest. */
function summarizeNames(values: readonly string[], noun: string) {
  const unique = [...new Set(values)];
  const shown = unique.filter(displayableName).slice(0, 3);
  const rest = unique.length - shown.length;
  if (!shown.length) return `${unique.length} ${noun}${unique.length === 1 ? "" : "s"}`;
  return rest ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

function evidenceReference(enrollment: GeneratedEnrollment) {
  const release = displayableName(enrollment.release.tag)
    ? `release ${enrollment.release.tag}`
    : "its latest stable release";
  const runtimes = enrollment.runtimes
    .map((runtime) => {
      const asset = displayableName(runtime.asset_name)
        ? `release file ${runtime.asset_name}`
        : "a release file";
      return `${platformLabels[runtime.platform]}: ${asset} contains ${summarizeNames(
        runtime.players.map((player) => basename(player.display_path)),
        "program",
      )}`;
    })
    .join(". ");
  return `Portcove added this registration from observed release facts, without a title-specific review. Upstream ${enrollment.repository}, ${release}, checked ${enrollment.release.observed_at.slice(0, 10)}. ${runtimes}. Your own copy may differ; Portcove does not compare it with these files.`;
}

/** Generic, honest guide. Title-specific facts that are unknown stay unknown. */
export function generatedGuide(record: AuthoredPort, enrollment: GeneratedEnrollment) {
  return {
    steps: [
      {
        title: "Prepare your own copy",
        instruction:
          "Get and prepare the game program yourself, following the upstream project's own instructions. Portcove does not download, build or repair it.",
      },
      {
        title: "Add the original game files upstream needs",
        instruction:
          "Upstream decides which original game files are needed and where they go. Portcove does not know them for this game and does not check them.",
      },
      {
        title: "Select the game program",
        instruction: selectionInstruction(enrollment),
      },
      {
        title: "Review the registration, then choose Play",
        instruction:
          "Portcove records your selection after you review it. Play is a separate action. Portcove supervises only the program you selected.",
      },
    ],
    warnings: [
      "Portcove added this game from release data without checking this game by hand. Upstream's instructions take precedence over this guide.",
      "You and upstream own updates, saves and settings. Portcove does not back up, update, migrate or delete this installation you maintain.",
    ],
    help_url: record.listing.setup_url ?? record.listing.project_url,
    references: [
      {
        title: "Registration ownership and removal",
        instruction: registrationOwnership,
      },
      {
        title: "How this route was added",
        instruction: evidenceReference(enrollment),
      },
    ],
  };
}

type Guide = {
  steps: { title: string; instruction: string }[];
  warnings: string[];
  references?: { title: string; instruction: string }[];
  help_url?: string;
};
/**
 * Core's catalog guide schema bound (`crates/portcove-core/src/catalog.rs`
 * and `catalog/listings.rs`): steps plus references, and warnings, at most
 * eight. Every client enforces it, so a longer guide cannot ship, and
 * truncating an authored guide would drop title-specific steps: an identity
 * without room is withheld (`guide-bound`).
 */
const guideBound = 8;
const authoredGuide = (record: AuthoredPort) =>
  isRecord(record.listing.manual_setup)
    ? (record.listing.manual_setup as unknown as Guide)
    : undefined;
function authoredGuideFits(record: AuthoredPort) {
  const guide = authoredGuide(record);
  return (
    !guide ||
    (guide.steps.length + (guide.references?.length ?? 0) + 2 <= guideBound &&
      guide.warnings.length + 1 <= guideBound)
  );
}

/**
 * The route's guide. A title-specific guide already authored on the listing
 * stays first and unchanged; the generated selection step, the "added from
 * release data" warning and the ownership reference follow it, and the review
 * step and provenance reference when the bound leaves room.
 */
export function routeGuide(record: AuthoredPort, enrollment: GeneratedEnrollment): Guide {
  const generic = generatedGuide(record, enrollment);
  const guide = authoredGuide(record);
  if (!guide) return generic;
  const [, , select, review] = generic.steps;
  const [ownership, provenance] = generic.references;
  const steps = [...guide.steps, select!];
  const references = [...(guide.references ?? []), ownership!];
  if (steps.length + references.length + 2 <= guideBound) {
    steps.push(review!);
    references.push(provenance!);
  }
  return {
    ...structuredClone(guide),
    steps,
    warnings: [...guide.warnings, generic.warnings[0]!],
    references,
  };
}

export const generatedManualPreparation =
  "Prepare this game yourself using the upstream project's instructions and any original game files it needs, then select the game program. You maintain its files, updates, saves and settings. Portcove does not download, build or repair it.";

/** The exact registration-only form of the hand-authored routes, from facts. */
export function generatedRecord(
  record: AuthoredPort,
  enrollment: GeneratedEnrollment,
): AuthoredPort {
  const listing = structuredClone(record.listing);
  listing.manual_setup = routeGuide(record, enrollment);
  // A platform is declared once: the integration now carries the route's
  // platforms, and the listing keeps only other descriptive package platforms.
  const descriptive = (listing.platforms ?? []).filter(
    (platform) => !enrollment.platforms.includes(platform),
  );
  if (descriptive.length) listing.platforms = descriptive;
  else delete listing.platforms;
  return {
    ...structuredClone(record),
    listing,
    external_registration_v1: true,
    integration: {
      support_tier: "beta",
      channels: ["stable"],
      platforms: [...enrollment.platforms],
      automated_tested_platforms: [],
      manually_validated_platforms: [],
      adapter: "staged-source-portable",
      release: { provider: "user-prepared", repository: enrollment.repository },
      presentation: {
        installation_method: "user-prepared-runtime",
        source_requirements: [],
        saves_and_settings: "external-user-owned",
        manual_preparation: generatedManualPreparation,
      },
    },
  };
}

export interface Generation {
  records: AuthoredPort[];
  decisions: FitDecision[];
  enrollments: GeneratedEnrollment[];
  /** The checked facts table the decisions read. */
  facts: ListingFactsTable;
}

/** Pure: equal records and facts always produce the same records and decisions. */
export function generateRegistrations(
  records: readonly AuthoredPort[],
  facts: unknown = emptyFactsTable(),
): Generation {
  checkListingFactsTable(facts);
  const known = new Set(records.map((record) => record.listing.id));
  const entries = new Map(facts.entries.map((entry) => [entry.port_id, entry]));
  for (const id of entries.keys())
    if (!known.has(id)) throw new Error(`Listing package facts name ${id}, which is not listed.`);
  const context = fitContext(records);
  const decisions = records
    .map((record) =>
      fitDecision(record, entries.get(record.listing.id), facts.generated_at, context),
    )
    .toSorted((left, right) => (left.port_id < right.port_id ? -1 : 1));
  const fitting = new Map(
    decisions.flatMap((decision) =>
      decision.fit ? [[decision.port_id, decision.enrollment] as const] : [],
    ),
  );
  const output = records.map((record) => {
    const enrollment = fitting.get(record.listing.id);
    return enrollment ? generatedRecord(record, enrollment) : record;
  });
  return {
    records: output,
    decisions,
    enrollments: [...fitting.values()].toSorted((a, b) => (a.port_id < b.port_id ? -1 : 1)),
    facts,
  };
}

// ---------------------------------------------------------------------------
// The committed enrollment table, its delta and the bounded gate.

export interface EnrollmentTable {
  format: number;
  generator: string;
  generator_version: number;
  /** The facts worker run's provenance, when an unattended run recorded one. */
  facts_provenance: FactsProvenance | null;
  enrollments: GeneratedEnrollment[];
  blocked: Record<string, number>;
  /** Every name-based veto, grouped by reason and token, with examples. */
  blocked_exclusions: ExclusionGroup[];
}

export function enrollmentTable(generation: Generation): EnrollmentTable {
  const blocked = Object.fromEntries(blockedReasons.map((reason) => [reason, 0])) as Record<
    string,
    number
  >;
  for (const decision of generation.decisions) if (!decision.fit) blocked[decision.reason]!++;
  return {
    format: ENROLLMENT_TABLE_FORMAT,
    generator: enrollmentGenerator,
    generator_version: GENERATOR_VERSION,
    facts_provenance: generation.facts.provenance ?? null,
    enrollments: generation.enrollments,
    blocked,
    blocked_exclusions: failSafeExclusions(generation),
  };
}

export const serializeEnrollmentTable = (table: EnrollmentTable) =>
  `${JSON.stringify(table, null, 2)}\n`;

export interface EnrollmentDelta {
  added: { port_id: string; platforms: string[]; reason: string }[];
  withdrawn: { port_id: string; reason: string }[];
  changed: { port_id: string; reason: string }[];
}

function previousEnrollments(previous: unknown): GeneratedEnrollment[] {
  if (previous === undefined || previous === null) return [];
  if (
    !isRecord(previous) ||
    previous.format !== ENROLLMENT_TABLE_FORMAT ||
    !Array.isArray(previous.enrollments) ||
    previous.enrollments.some((row: unknown) => !isRecord(row) || typeof row.port_id !== "string")
  )
    throw new Error("The baseline generated registration table is malformed.");
  return previous.enrollments as GeneratedEnrollment[];
}

/** Added, withdrawn and changed routes since the baseline table, with reasons. */
export function enrollmentDelta(previous: unknown, generation: Generation): EnrollmentDelta {
  const before = new Map(previousEnrollments(previous).map((row) => [row.port_id, row]));
  const after = new Map(generation.enrollments.map((row) => [row.port_id, row]));
  const decisions = new Map(generation.decisions.map((decision) => [decision.port_id, decision]));
  const delta: EnrollmentDelta = { added: [], withdrawn: [], changed: [] };
  for (const [id, row] of after) {
    const prior = before.get(id);
    if (!prior)
      delta.added.push({
        port_id: id,
        platforms: row.platforms,
        reason: `Facts from ${row.repository} ${row.release.tag} fit on ${row.platforms.join(", ")}.`,
      });
    else if (JSON.stringify(prior) !== JSON.stringify(row)) {
      const what = [
        JSON.stringify(prior.platforms) !== JSON.stringify(row.platforms)
          ? `platforms ${prior.platforms.join(",")} -> ${row.platforms.join(",")}`
          : "",
        prior.release.tag !== row.release.tag
          ? `release ${prior.release.tag} -> ${row.release.tag}`
          : "",
        prior.generator_version !== row.generator_version ? "generator version" : "",
      ].filter(Boolean);
      delta.changed.push({
        port_id: id,
        reason: what.join("; ") || "player facts changed",
      });
    }
  }
  for (const id of before.keys())
    if (!after.has(id)) {
      const decision = decisions.get(id);
      delta.withdrawn.push({
        port_id: id,
        reason: !decision
          ? "The listing no longer exists."
          : decision.fit
            ? "Unexpected"
            : `${decision.reason}: ${decision.detail}`,
      });
    }
  return delta;
}

// ---------------------------------------------------------------------------
// The gate: the safety net that replaces per-title review. Its checks are
// written independently of the fit rule above and never call its helpers, so
// a defect in one is not hidden by the same defect in the other.

/** Header machines that run on each platform, restated for the gate. */
const gateMachines: Record<
  string,
  { os: string; arch: string; exact: string[]; universal: string }
> = {
  "windows-x86-64": { os: "windows", arch: "x86-64", exact: ["pe-x86-64"], universal: "" },
  "linux-x86-64": { os: "linux", arch: "x86-64", exact: ["elf64-x86-64"], universal: "" },
  "macos-x86-64": { os: "macos", arch: "x86-64", exact: ["macho-x86-64"], universal: "x86-64" },
  "macos-aarch64": { os: "macos", arch: "aarch64", exact: ["macho-arm64"], universal: "arm64" },
};
const gateDay = 24 * 60 * 60 * 1000;
/** Words the gate drops from a program name before comparing programs, restated. */
const gateVariantWords = [
  "exe",
  "bin",
  "x86",
  "x64",
  "x86_64",
  "amd64",
  "arm64",
  "aarch64",
  "arm",
  "i386",
  "i686",
  "win",
  "win32",
  "win64",
  "windows",
  "linux",
  "mac",
  "macos",
  "osx",
  "universal",
  "universal2",
  "64",
  "32",
  "86",
  "64bit",
  "32bit",
  "bit",
  "console",
  "debug",
];
function gateProgram(path: string) {
  const file = (path.split("/").pop() ?? path).toLowerCase();
  const kept: string[] = [];
  for (const word of file.split(/[^a-z0-9]+/u)) {
    if (!word || gateVariantWords.includes(word)) continue;
    // A number glued to a name is part of it (`doom64`): only a separate
    // `64`, `32` or `86` is a build variant.
    for (const part of word.match(/[a-z]+|[0-9]+/gu) ?? [])
      if (/^[0-9]+$/u.test(part) || !gateVariantWords.includes(part)) kept.push(part);
  }
  return kept.length ? kept.join("-") : file;
}

function gateMachineRuns(machine: string, platform: string) {
  const host = gateMachines[platform];
  if (!host) return false;
  if (host.exact.includes(machine)) return true;
  const prefix = "macho-universal-";
  return (
    host.universal !== "" &&
    machine.startsWith(prefix) &&
    machine.slice(prefix.length).split("+").includes(host.universal)
  );
}

/**
 * Every GitHub repository a listing names through its release URL or project
 * URL, any path below it, lowercase; restated permissively, so the gate never
 * misses an identity that shares a repository.
 */
function gateRepositories(listing: Record<string, unknown>): Set<string> {
  const named = new Set<string>();
  for (const url of [listing.release_url, listing.project_url]) {
    if (typeof url !== "string") continue;
    const match =
      /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/u.exec(
        url,
      );
    if (match) named.add(`${match[1]}/${match[2]}`.toLowerCase());
  }
  return named;
}
/** A tag's release line, restated: see `releaseLine`. Exported for its unit table only. */
export function gateLine(tag: string | null, id: number, repository: string) {
  if (tag === null || !/^[!-~]+$/u.test(tag)) return `#${id}`;
  const channel = [
    "release",
    "releases",
    "rel",
    "version",
    "ver",
    "rev",
    "revision",
    "stable",
    "latest",
    "nightly",
    "continuous",
    "snapshot",
    "preview",
    "beta",
    "alpha",
    "rc",
    "pre",
    "prerelease",
    "dev",
    "build",
    "ci",
    "test",
    "testing",
    "hotfix",
  ];
  const targets = [
    "windows",
    "win",
    "win32",
    "win64",
    "linux",
    "linux32",
    "linux64",
    "macos",
    "mac",
    "osx",
    "darwin",
    "universal",
    "x64",
    "x86",
    "amd64",
    "arm64",
    "aarch64",
    "i386",
    "i686",
    "x8664",
  ];
  const isNumber = (word: string) => /^[0-9]+$/u.test(word);
  const isVersion = (word: string) => /^[vrb]?[0-9]+$/u.test(word);
  // Words and the first separator character after each ("" at the end).
  const lower = tag.toLowerCase();
  const scanned: { text: string; then: string }[] = [];
  let position = 0;
  while (position < lower.length) {
    const start = lower.slice(position).search(/[a-z0-9]/u);
    if (start < 0) break;
    let end = position + start;
    while (end < lower.length && /[a-z0-9]/u.test(lower[end]!)) end++;
    scanned.push({
      text: lower.slice(position + start, end),
      then: lower[end] ?? "",
    });
    position = end;
  }
  // Mark dropped words; `x86_64` / `x86-64` is one build-target word.
  const alwaysDropped = scanned.map((word, index) => {
    const previous = scanned[index - 1];
    const glued64 =
      word.text === "64" &&
      previous?.text === "x86" &&
      (previous.then === "_" || previous.then === "-");
    return (
      glued64 || targets.includes(word.text) || channel.includes(word.text.replace(/[0-9]+$/u, ""))
    );
  });
  // A hash: 7 to 40 hex characters with a digit and a letter a-f.
  const isHash = (word: string) =>
    word.length >= 7 &&
    word.length <= 40 &&
    word.split("").every((character) => "0123456789abcdef".includes(character)) &&
    word.split("").some((character) => character >= "0" && character <= "9") &&
    word.split("").some((character) => character >= "a" && character <= "f");
  // Channel words that are noise only beside a version, date or hash, or
  // when the tag holds nothing else.
  const sometimes = (word: string) =>
    ["tester", "prealpha", "canary", "wip", "experimental", "fixed", "fix", "new"].includes(word) ||
    (word.startsWith("pr") && word.length > 2 && isNumber(word.slice(2)));
  const numeric = (word: string | undefined) =>
    word !== undefined && (isVersion(word) || isHash(word));
  const nothingElse = scanned.every(
    (word, index) => alwaysDropped[index] || sometimes(word.text) || numeric(word.text),
  );
  const words = scanned.map((word, index) => ({
    ...word,
    dropped:
      alwaysDropped[index]! ||
      (sometimes(word.text) &&
        (nothingElse || numeric(scanned[index - 1]?.text) || numeric(scanned[index + 1]?.text))),
  }));
  const kept: string[] = [];
  let afterProductWord = false;
  for (let index = 0; index < words.length; index++) {
    const { text, then, dropped } = words[index]!;
    if (dropped) {
      afterProductWord = false;
      continue;
    }
    // A hash reads as the version; so does `v.` before digits (`v.0.1.1`).
    if (isHash(text)) break;
    if (text === "v" && then === "." && isNumber(words[index + 1]?.text ?? "")) break;
    if (isVersion(text) && !isNumber(text)) {
      // A version-shaped word directly before another version is a product word.
      const following = words[index + 1];
      if (then !== "." && following && isVersion(following.text)) {
        kept.push(text);
        afterProductWord = true;
        continue;
      }
      break;
    }
    if (isNumber(text)) {
      const following = words.slice(index + 1).find((word) => !word.dropped);
      const product =
        afterProductWord &&
        text.length <= 2 &&
        then !== "." &&
        (following === undefined || !isNumber(following.text) || following.then === ".");
      if (!product) break;
      kept.push(text);
      continue;
    }
    const v = text.lastIndexOf("v");
    if (v >= 2 && /^[0-9]+$/u.test(text.slice(v + 1)) && /[a-z]/u.test(text.slice(0, v))) {
      kept.push(text.slice(0, v));
      break;
    }
    kept.push(text);
    afterProductWord = true;
  }
  const own = (repository.split("/")[1] ?? "").toLowerCase().replace(/[^a-z0-9]/gu, "");
  return kept.join("") === own ? "" : kept.join("-");
}
/**
 * Whether a tag is only rolling-channel words with dates, times, hashes and
 * build targets, restated: see `channelOnlyTag`. Exported for its unit table
 * only.
 */
export function gateChannelOnlyTag(tag: string | null): boolean {
  if (tag === null || !/^[!-~]+$/u.test(tag)) return false;
  const rolling = new Set([
    "nightly",
    "nightlies",
    "continuous",
    "latest",
    "dev",
    "devel",
    "develop",
    "development",
    "build",
    "builds",
    "snapshot",
    "canary",
    "preview",
    "test",
    "testing",
    "tester",
    "ci",
    "alpha",
    "beta",
    "rc",
    "pre",
    "prerelease",
    "prealpha",
    "wip",
    "experimental",
    "unstable",
    "daily",
    "weekly",
    "edge",
    "master",
    "main",
    "trunk",
    "head",
    "auto",
    "autobuild",
  ]);
  const systems = new Set([
    "windows",
    "win",
    "win32",
    "win64",
    "linux",
    "linux32",
    "linux64",
    "macos",
    "mac",
    "osx",
    "darwin",
    "universal",
    "x64",
    "x86",
    "x8664",
    "amd64",
    "arm64",
    "aarch64",
    "i386",
    "i686",
  ]);
  const digits = (word: string) =>
    word.length >= 2 && word.length <= 14 && word.length % 2 === 0 && /^[0-9]+$/u.test(word);
  const hash = (word: string) =>
    /^[0-9a-f]{7,40}$/u.test(word) && /[0-9]/u.test(word) && /[a-f]/u.test(word);
  const words = tag
    .toLowerCase()
    .replaceAll("x86_64", "x8664")
    .replaceAll("x86-64", "x8664")
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "");
  let sawChannel = false;
  for (const word of words) {
    if (hash(word) || digits(word) || systems.has(word)) continue;
    const letters = word.replace(/[0-9]+$/u, "");
    if (rolling.has(letters) && (letters === word || digits(word.slice(letters.length)))) {
      sawChannel = true;
      continue;
    }
    return false;
  }
  return sawChannel;
}
/** Whether an unbound line names the listed product, restated: see `lineNamesProduct`. Exported for its unit table only. */
export function gateLineNamesProduct(
  line: string,
  repository: string,
  listing: Record<string, unknown>,
): boolean {
  if (line === "") return true;
  if (line[0] === "#") return false;
  const needle = line.split("-").join("");
  if (needle.length < 3) return false;
  for (const value of [
    repository.split("/")[1],
    listing.id,
    listing.name,
    listing.original_game_title,
  ]) {
    if (typeof value !== "string") continue;
    // Whole words: separators, camel-case humps and letter/digit changes.
    const words: string[] = [];
    let current = "";
    let previous = "";
    for (let index = 0; index < value.length; index++) {
      const character = value[index]!;
      const kind = /[a-z]/u.test(character)
        ? "lower"
        : /[A-Z]/u.test(character)
          ? "upper"
          : /[0-9]/u.test(character)
            ? "digit"
            : "";
      const nextLower = /[a-z]/u.test(value[index + 1] ?? "");
      const boundary =
        kind === "" ||
        (previous === "lower" && kind === "upper") ||
        (previous === "upper" && kind === "upper" && nextLower) ||
        (previous === "digit" && kind !== "digit") ||
        (previous !== "digit" && previous !== "" && kind === "digit");
      if (boundary && current) {
        words.push(current.toLowerCase());
        current = "";
      }
      if (kind) current += character;
      previous = kind;
    }
    if (current) words.push(current.toLowerCase());
    // A contiguous run of whole words spells the line exactly.
    for (let first = 0; first < words.length; first++)
      for (let last = first; last < words.length; last++) {
        const run = words.slice(first, last + 1).join("");
        if (run === needle) return true;
        if (run.length >= needle.length) break;
      }
  }
  return false;
}
/** The line a listing's own release URL binds it to, restated. */
function gateBoundLine(listing: Record<string, unknown>): string | null {
  const url = listing.release_url;
  if (typeof url !== "string") return null;
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/tag\/([^/?#]+)$/u.exec(
      url,
    );
  if (!match) return null;
  try {
    return gateLine(decodeURIComponent(match[3]!), 0, `${match[1]}/${match[2]}`);
  } catch {
    return null;
  }
}
/** Whether an archive's own name holds a role word, restated: see `archiveRoleToken`. */
function gateRoleWord(name: string) {
  const words = name.toLowerCase().split(/[^a-z0-9]+/u);
  return ["update", "updater", "hotfix", "delta", "incremental", "patch", "symbols", "debug"].some(
    (word) => words.includes(word),
  );
}
/** Name words that veto an archive whatever it holds, restated. */
function gateNameVetoes(named: NameSuggestion) {
  return (
    named.tool_token !== null ||
    named.system_token !== null ||
    (named.role !== "desktop-game-runtime" && named.role !== "unknown")
  );
}

/**
 * The kind of another package form, restated independently of
 * `otherPackageForm` with the same order: read archive, library, closed
 * non-program list, split volume, single-system form, non-desktop package,
 * and everything else an unread container. Exported for its unit table only.
 */
export function gateFormKind(
  name: string,
): "windows" | "linux" | "macos" | "container" | undefined {
  const lower = name.toLowerCase();
  const tail = (suffix: string) => lower.endsWith(suffix);
  // 1. Archives the worker reads.
  if ([".zip", ".tar.gz", ".tgz", ".tar.xz"].some(tail)) return undefined;
  // 2. Shared libraries, also versioned (`libgame.so.1.0.123`).
  if (tail(".dll") || tail(".dylib") || /\.so(?:\.\d+)*$/u.test(lower)) return undefined;
  // 3. The closed non-program list: suffixes, exact names, license names.
  const ignoredSuffixes = new Set([
    "sha1",
    "sha224",
    "sha256",
    "sha384",
    "sha512",
    "sha1sum",
    "sha256sum",
    "sha512sum",
    "sha256sums",
    "md5",
    "md5sum",
    "checksum",
    "checksums",
    "sig",
    "asc",
    "minisig",
    "pem",
    "gpg",
    "sigstore",
    "blockmap",
    "zsync",
    "yml",
    "yaml",
    "json",
    "xml",
    "plist",
    "txt",
    "md",
    "markdown",
    "rst",
    "pdf",
    "html",
    "htm",
    "rtf",
    "nfo",
    "log",
    "csv",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "ico",
    "mp4",
    "webm",
    "mov",
    "pdb",
    "dbg",
    "debug",
    "sym",
    "torrent",
    "patch",
    "diff",
  ]);
  const dot = lower.lastIndexOf(".");
  const last = dot < 0 ? "" : lower.slice(dot + 1);
  if ((dot >= 0 && ignoredSuffixes.has(last)) || tail(".intoto.jsonl")) return undefined;
  const ignoredNames = new Set([
    "sha256sums",
    "sha512sums",
    "sha1sums",
    "md5sums",
    "b2sums",
    "b3sums",
    "shasums",
    "shasums256",
    "shasums512",
    "checksum",
    "checksums",
    "hashes",
    "signatures",
    "sha1sum",
    "sha256sum",
    "sha512sum",
    "md5sum",
    "releases",
    "version",
    "manifest",
    "license",
    "licence",
    "copying",
    "readme",
    "changelog",
    "changes",
    "notice",
    "authors",
    "credits",
    "news",
    "todo",
    "install",
    "makefile",
    "dockerfile",
  ]);
  if (ignoredNames.has(lower)) return undefined;
  if (
    /^(a|l)?gpl-\d+(\.\d+)*(-only|-or-later)?$/u.test(lower) ||
    /^(mpl|apache|epl|cddl|eupl|ofl|artistic|bsl|cc0|cc-by(-sa|-nc|-nd)*)-\d+(\.\d+)*(-only|-or-later)?$/u.test(
      lower,
    ) ||
    /^bsd-\d-clause$/u.test(lower)
  )
    return undefined;
  const word = /^(license|licence|copying|readme|changelog|changes|notice|authors)/u.exec(lower);
  if (word) {
    const rest = lower.slice(word[0].length);
    const licenseId =
      /^(third[-_]?party|3rd[-_]?party|(mit|bsd|isc|zlib|apache|gpl|lgpl|agpl|mpl|epl|ofl|cc0|cc-by(-sa)?|unlicense|boost|bsl)([-_.]?\d+(\.\d+)*)?([-_.]?(only|or-later|clause))?)$/u;
    if (rest === ".lesser" || (/^[-_.]/u.test(rest) && licenseId.test(rest.slice(1))))
      return undefined;
  }
  // 4. Split volumes: `.001`, `.1000`, `.z01`, `.r00`, `.part1.rar`.
  if (/\.\d\d\d+$/u.test(lower) || /\.[zr]\d\d$/u.test(lower) || /\.part\d+\.rar$/u.test(lower))
    return "container";
  // 5. Single-system forms and bare binaries.
  if (["exe", "msi", "msix", "appx", "msixbundle", "appxbundle"].includes(last)) return "windows";
  if (
    [
      "appimage",
      "deb",
      "rpm",
      "flatpak",
      "snap",
      "run",
      "bin",
      "sh",
      "linux",
      "x86",
      "x86_64",
      "arm64",
      "aarch64",
    ].includes(last)
  )
    return "linux";
  if (last === "dmg" || last === "pkg") return "macos";
  // 6. Non-desktop packages keep their own treatment.
  if (["ipa", "apk", "aab", "vpk", "nro", "nsp", "3dsx", "cia", "wad"].includes(last))
    return undefined;
  // A name without an extension (none, a version such as `1`, `0-linux` or
  // `v2`) is a bare Linux binary.
  if (dot < 0 || !/^[a-z0-9]+$/u.test(last) || !/[a-z]/u.test(last) || /^v\d+$/u.test(last))
    return "linux";
  // 7. Everything else is an unread container.
  return "container";
}
/**
 * The fixed platforms another package form serves by its own name, restated:
 * see `gateFormKind`. A container (any form the gate does not know, and any
 * split volume) serves the platforms its name verdict records; a non-program
 * file serves none. Exported for its unit table only.
 */
export function gateFormPlatforms(name: string): string[] {
  const kind = gateFormKind(name);
  if (kind === "windows") return ["windows-x86-64"];
  if (kind === "linux") return ["linux-x86-64"];
  if (kind === "macos") return ["macos-x86-64", "macos-aarch64"];
  return [];
}

/** Problems with one enrollment, judged against its facts entry and listing only. */
function gateEnrollmentProblems(
  enrollment: GeneratedEnrollment,
  entry: ListingFactsEntry | undefined,
  generatedAt: string,
  listings: readonly Record<string, unknown>[],
): string[] {
  const id = enrollment.port_id;
  if (!entry) return [`${id} has no facts entry.`];
  const problems: string[] = [];
  // One product per release: no other identity names the repository unless
  // the listing binds this one to a line of its own, the offered release is on
  // that line, the releases form one line or the listing names it, and no newer
  // prerelease of another line follows the offered release.
  const own = listings.find((listing) => listing.id === id) ?? {};
  const bound = gateBoundLine(own);
  const repository = entry.repository.toLowerCase();
  const others = listings.filter(
    (listing) => listing.id !== id && gateRepositories(listing).has(repository),
  );
  if (others.length && (bound === null || others.some((other) => gateBoundLine(other) === bound)))
    problems.push(`${id} shares its repository with another identity and no line of its own.`);
  const offered = entry.observed_releases.find(
    (release) => release.release_id === enrollment.release.id,
  );
  if (!offered || offered.prerelease !== false || gateChannelOnlyTag(offered.tag))
    problems.push(`${id} offers a release its facts do not record as stable.`);
  else {
    const line = gateLine(offered.tag, offered.release_id, entry.repository);
    const lines = new Set([line]);
    // Lines over stable packaged releases (and unknown verdicts) only.
    for (const release of entry.observed_releases)
      if (
        release.packaged &&
        (release.prerelease === null ||
          (release.prerelease === false && !gateChannelOnlyTag(release.tag)))
      )
        lines.add(gateLine(release.tag, release.release_id, entry.repository));
    if (bound !== null ? bound !== line : lines.size !== 1)
      problems.push(`${id} offers a release whose release line is ambiguous.`);
    if (bound === null && !gateLineNamesProduct(line, entry.repository, own))
      problems.push(`${id} offers an unbound release line of other product words.`);
    const at = Date.parse(offered.published_at ?? "");
    for (const release of entry.observed_releases) {
      const other = gateLine(release.tag, release.release_id, entry.repository);
      if (
        (release.prerelease !== false || gateChannelOnlyTag(release.tag)) &&
        other !== line &&
        !(Date.parse(release.published_at ?? "") <= at) &&
        (release.prerelease === null ||
          other[0] === "#" ||
          gateLineNamesProduct(other, entry.repository, own))
      )
        problems.push(
          `${id} offers a stable release older than a prerelease of the main or a product-naming line.`,
        );
    }
  }
  // No other package form may serve a platform the release also offers a
  // readable archive for, unless it is byte-equal to a player those archives
  // hold for that platform; an unknown digest is not. Such a release is
  // refused whole, whichever platforms the enrollment names. The gate names
  // each form's platforms itself and widens them by the recorded ones (a
  // container's name verdict), never narrows them.
  for (const other of entry.other_packages) {
    const served = new Set<string>(Array.isArray(other.platforms) ? other.platforms : []);
    for (const platform of gateFormPlatforms(other.name)) served.add(platform);
    for (const platform of served) {
      const host = gateMachines[platform];
      if (!host) continue;
      const offered = entry.artifacts.filter(
        (candidate) =>
          ["unknown", host.os].includes(candidate.name_suggestion.os) &&
          ["unknown", host.arch, ...(host.os === "macos" ? ["universal"] : [])].includes(
            candidate.name_suggestion.arch,
          ),
      );
      if (!offered.length) continue;
      const digests = offered.flatMap((candidate) =>
        candidate.players
          .filter((player) => gateMachineRuns(player.machine, platform))
          .map((player) => player.sha256),
      );
      if (typeof other.sha256 !== "string" || !digests.includes(other.sha256))
        problems.push(
          `${id} rests on a release that also ships another package for ${platform} (${other.name}) beside an archive offered for it.`,
        );
    }
  }
  if (createHash("sha256").update(JSON.stringify(entry)).digest("hex") !== enrollment.facts_sha256)
    problems.push(`${id} does not rest on the committed facts entry.`);
  if (
    entry.ineligible !== null ||
    entry.observation.coverage !== "complete" ||
    entry.observation.assets_complete !== true ||
    entry.repository_id !== enrollment.repository_id ||
    entry.repository !== enrollment.repository ||
    entry.observation.release_id !== enrollment.release.id
  )
    problems.push(`${id} rests on facts that are not a complete, eligible, bound observation.`);
  const reference = Date.parse(generatedAt);
  if (reference - Date.parse(entry.observation.observed_at) > 30 * gateDay)
    problems.push(`${id} rests on facts older than 30 days.`);
  if (
    entry.attempt &&
    entry.attempt.status !== "pending-inspection" &&
    reference - Date.parse(entry.attempt.first_at) > 14 * gateDay
  )
    problems.push(`${id} rests on last-good facts kept beyond 14 days.`);
  const platformsSeen = new Set<string>();
  if (!enrollment.platforms.length) problems.push(`${id} has no platform.`);
  for (const platform of enrollment.platforms) {
    if (!gateMachines[platform] || platformsSeen.has(platform))
      problems.push(`${id} names platform ${platform} twice or unsupported.`);
    platformsSeen.add(platform);
  }
  if (enrollment.runtimes.length !== enrollment.platforms.length)
    problems.push(`${id} has a platform without a runtime.`);
  for (const runtime of enrollment.runtimes) {
    const where = `${id} on ${runtime.platform}`;
    const host = gateMachines[runtime.platform];
    const artifact = entry.artifacts.find((candidate) => candidate.asset_id === runtime.asset_id);
    if (!host || !enrollment.platforms.includes(runtime.platform) || !artifact) {
      problems.push(`${where} names no observed artifact.`);
      continue;
    }
    if (
      runtime.source !== "exact-release-structured" ||
      artifact.source.kind !== "exact-release-structured" ||
      typeof artifact.sha256 !== "string" ||
      artifact.sha256.length !== 64 ||
      artifact.source.archive_sha256 !== artifact.sha256 ||
      runtime.archive_sha256 !== artifact.sha256
    )
      problems.push(`${where} rests on a non-authorizing ${runtime.source} fact or unbound bytes.`);
    if (
      artifact.role !== "desktop-game-runtime" ||
      artifact.contradictory ||
      gateRoleWord(artifact.name)
    )
      problems.push(`${where} rests on a contradicted, role-named or non-runtime artifact.`);
    const named = artifact.name_suggestion;
    if (named.tool_token !== null || named.system_token !== null)
      problems.push(
        `${where} rests on an artifact whose name carries the token ${named.tool_token ?? named.system_token}.`,
      );
    if (
      runtime.players.some((player) =>
        artifact.excluded_players.some((excluded) => excluded.path === player.path),
      )
    )
      problems.push(`${where} names a player the tool veto excluded.`);
    if (
      !["desktop-game-runtime", "unknown"].includes(named.role) ||
      !["unknown", host.os].includes(named.os) ||
      !["unknown", host.arch, ...(host.os === "macos" ? ["universal"] : [])].includes(named.arch)
    )
      problems.push(`${where} rests on an artifact its own name contradicts.`);
    if (!runtime.players.length) problems.push(`${where} has no matching player.`);
    // Every player of the artifact that runs here is named: none is trimmed away.
    const running = artifact.players.filter((player) =>
      gateMachineRuns(player.machine, runtime.platform),
    );
    if (
      running.length !== runtime.players.length ||
      running.some((player) => !runtime.players.some((named) => named.path === player.path))
    )
      problems.push(`${where} does not name every player of its artifact that runs there.`);
    const topLevel = (path: string) => {
      const parts = path.split("/");
      return parts.length > 1 ? (parts[0] ?? "") : "";
    };
    // One program on this platform across every artifact whose name allows
    // it, each such artifact's players under one top-level directory.
    const programs = new Set<string>();
    let severalDirectories = false;
    for (const candidate of entry.artifacts) {
      const candidateName = candidate.name_suggestion;
      if (
        candidate.contradictory ||
        gateRoleWord(candidate.name) ||
        candidate.role !== "desktop-game-runtime" ||
        !["unknown", host.os].includes(candidateName.os) ||
        !["unknown", host.arch, ...(host.os === "macos" ? ["universal"] : [])].includes(
          candidateName.arch,
        )
      )
        continue;
      const directories = new Set<string>();
      for (const player of candidate.players)
        if (gateMachineRuns(player.machine, runtime.platform)) {
          programs.add(gateProgram(player.path));
          directories.add(topLevel(player.path));
        }
      if (directories.size > 1) severalDirectories = true;
    }
    if (severalDirectories)
      problems.push(`${where} has players under several top-level directories.`);
    if (programs.size !== 1)
      problems.push(
        `${where} rests on ${programs.size} distinct programs; only one program may enroll.`,
      );
    // Every archive whose name allows the platform and holds its players is
    // the same package (equal archive bytes) unless exactly one explicitly
    // names the platform's system beside only system-neutral others, and it
    // is the offered one; none bundles a toolchain; and no refused archive
    // could be the platform's game.
    const archives = new Map<string, string>();
    for (const candidate of entry.artifacts) {
      const candidateName = candidate.name_suggestion;
      if (
        candidate.contradictory ||
        gateRoleWord(candidate.name) ||
        candidate.role !== "desktop-game-runtime" ||
        !["unknown", host.os].includes(candidateName.os) ||
        !["unknown", host.arch, ...(host.os === "macos" ? ["universal"] : [])].includes(
          candidateName.arch,
        )
      )
        continue;
      if (!candidate.players.some((player) => gateMachineRuns(player.machine, runtime.platform)))
        continue;
      if (candidate.bundled_toolchain.length)
        problems.push(
          `${where} is decided beside an archive that bundles ${candidate.bundled_toolchain.join(", ")}.`,
        );
      archives.set(candidate.sha256, candidateName.os);
    }
    if (archives.size > 1) {
      const systems = [...archives.values()];
      const explicit = systems.filter((os) => os === host.os).length;
      if (
        explicit !== 1 ||
        systems.some((os) => os !== host.os && os !== "unknown") ||
        artifact.name_suggestion.os !== host.os
      )
        problems.push(
          `${where} rests on one of ${archives.size} different archives for the platform.`,
        );
    }
    for (const refused of entry.refused_archives) {
      const refusedName = refused.name_suggestion;
      if (refused.asset_id === runtime.asset_id)
        problems.push(`${where} offers an archive Core refused.`);
      if (
        !gateNameVetoes(refusedName) &&
        ["unknown", host.os].includes(refusedName.os) &&
        ["unknown", host.arch, ...(host.os === "macos" ? ["universal"] : [])].includes(
          refusedName.arch,
        )
      )
        problems.push(`${where} is decided beside a refused archive that could hold its game.`);
    }
    for (const player of runtime.players) {
      const observed = artifact.players.find(
        (candidate) =>
          candidate.path === player.path &&
          candidate.display_path === player.display_path &&
          candidate.machine === player.machine &&
          candidate.sha256 === player.sha256,
      );
      if (!observed || !gateMachineRuns(player.machine, runtime.platform))
        problems.push(`${where} has no matching player.`);
    }
  }
  return problems;
}

/**
 * Refuse a generation whose enrollments do not rest on complete, current,
 * digest-bound facts, or whose facts time moves backwards from the
 * baseline's (the merge base's committed tables, never the working tree).
 * The delta has no size bound: every enrollment that passes these checks may
 * land in one change. A mass withdrawal a bug could cause is held by the
 * facts batch job's `withdrawal-held` stop (`withdrawalCauses`). The gate
 * restates the release-asset classifier independently (`gateFormKind`) but
 * sees only the assets the facts recorded as other package forms. Reproducing
 * the facts re-lists the release with the worker's classifier, so an asset
 * that classifier wrongly drops is dropped alike there; the inverted default
 * (only the closed non-program list is ignored) bounds that mistake.
 */
export function gateGeneration(
  baseline: unknown,
  generation: Generation,
  baselineFacts: unknown = null,
) {
  const delta = enrollmentDelta(baseline, generation);
  const problems: string[] = [];
  // Facts age is measured against the table's own time, so that time must
  // never move backwards from the baseline's.
  if (baselineFacts !== null && baselineFacts !== undefined) {
    const before = isRecord(baselineFacts) ? Date.parse(String(baselineFacts.generated_at)) : NaN;
    if (Number.isNaN(before)) problems.push("The baseline facts table has no generation time.");
    else if (Date.parse(generation.facts.generated_at) < before)
      problems.push(
        `The facts table was generated at ${generation.facts.generated_at}, before the baseline's ${String((baselineFacts as Record<string, unknown>).generated_at)}.`,
      );
  }
  const entries = new Map(generation.facts.entries.map((entry) => [entry.port_id, entry]));
  const listings = generation.records.map((record) => record.listing as Record<string, unknown>);
  for (const enrollment of generation.enrollments)
    problems.push(
      ...gateEnrollmentProblems(
        enrollment,
        entries.get(enrollment.port_id),
        generation.facts.generated_at,
        listings,
      ),
    );
  if (problems.length)
    throw new Error(`Generated registration gate refused this run: ${problems.join(" ")}`);
  return delta;
}

// ---------------------------------------------------------------------------
// The gate's baseline: the committed table at the merge base.

export const enrollmentTablePath = `crates/portcove-core/catalog/${enrollmentTableName}`;
export const factsTablePath = `crates/portcove-core/catalog/${factsTableName}`;
/** Runs git and returns stdout, or undefined when the command fails. */
export type GitRunner = (args: string[]) => string | undefined;

/**
 * The revision whose committed table is the gate's baseline. Pull requests and
 * merge groups compare with the base they merge into (the first parent of the
 * checked-out merge commit, else the merge base with `origin/$GITHUB_BASE_REF`);
 * pushes and scheduled runs compare with the previous commit; a local run
 * compares with the merge base of `origin/main`.
 */
export function gateBaselineRevision(env: NodeJS.ProcessEnv, git: GitRunner): string | undefined {
  const event = env.GITHUB_EVENT_NAME;
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.trim();
  if (!head) return undefined;
  const parents = (git(["rev-list", "--parents", "-n", "1", "HEAD"]) ?? "").trim().split(/\s+/u);
  if (event === "pull_request" || event === "pull_request_target" || event === "merge_group") {
    if (parents.length === 3) return parents[1];
    const base = env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : "origin/main";
    return git(["merge-base", "HEAD", base])?.trim() || undefined;
  }
  if (event) return parents[1];
  return git(["merge-base", "HEAD", "origin/main"])?.trim() || undefined;
}

/**
 * The baseline table, or `null` for an empty one (no table at that revision,
 * or no git repository at all). Inside a repository an unresolvable baseline
 * is an error: the gate never falls back to the working tree.
 */
export function readGateBaseline(
  env: NodeJS.ProcessEnv,
  git: GitRunner,
  file: string = enrollmentTablePath,
): unknown {
  if (git(["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return null;
  const revision = gateBaselineRevision(env, git);
  if (!revision)
    throw new Error(
      "The generated registration gate needs the merge base's history; fetch the base branch (CI: checkout fetch-depth 2 or more).",
    );
  const listed = git(["ls-tree", "--name-only", revision, "--", file]);
  if (listed === undefined)
    throw new Error(`The generated registration gate cannot read revision ${revision}.`);
  if (!listed.trim()) return null;
  const text = git(["show", `${revision}:${file}`]);
  if (text === undefined) throw new Error(`Cannot read ${file} at ${revision}.`);
  return JSON.parse(text) as unknown;
}

// ---------------------------------------------------------------------------
// Reproduction: CI re-reads the exact bytes behind every eligible entry a
// change adds or changes (`scripts/listing-facts-batch.mts reproduce`).

/**
 * GitHub Actions runs at most this many jobs from one matrix
 * ([documentation](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#jobsjob_idstrategymatrix)).
 */
export const matrixJobLimit = 256;
/**
 * Deterministic shards of identities: `count` shards (one per identity, at
 * most `matrixJobLimit`), identity i in port_id order in shard i mod count.
 * Reproduction and the facts worker shard the same way, so every shard
 * holds the fewest identities the matrix allows and none is left out.
 */
export function identityShards(ids: readonly string[]): string[][] {
  const sorted = [...new Set(ids)].toSorted(compareCodePoints);
  const count = Math.min(matrixJobLimit, sorted.length);
  const shards: string[][] = Array.from({ length: count }, () => []);
  for (const [index, id] of sorted.entries()) shards[index % count]!.push(id);
  return shards;
}

/**
 * An entry without the fields a reconfirmation alone moves: `observed_at`
 * and the worker's `attempt` record. Every other field (repository binding,
 * parser version, coverage, unread forms, release and artifacts) can decide
 * whether the entry enrolls, so a change to any of them is re-read.
 */
const reproducedFields = (entry: ListingFactsEntry) => {
  const { attempt: _attempt, observation, ...rest } = entry;
  const { observed_at: _observedAt, ...kept } = observation;
  return digestOf({ ...rest, observation: kept });
};
/**
 * Whether `next` must be reproduced from its bytes: it is eligible (it can
 * offer a route) and it is new, was ineligible, or differs from `previous` in
 * anything but `observed_at` and `attempt`. A reconfirmation re-reads nothing;
 * an ineligible entry offers nothing (its withdrawals stay bounded by the
 * gate).
 */
export function needsReproduction(
  previous: ListingFactsEntry | undefined,
  next: ListingFactsEntry,
): boolean {
  if (next.ineligible !== null) return false;
  return (
    !previous ||
    previous.ineligible !== null ||
    reproducedFields(previous) !== reproducedFields(next)
  );
}
/** Whether two entries differ only in what a reconfirmation moves (`observed_at`, `attempt`). */
export const sameExceptReconfirmation = (left: ListingFactsEntry, right: ListingFactsEntry) =>
  reproducedFields(left) === reproducedFields(right);
/** Archive bytes reproducing an entry downloads. */
export const reproductionCost = (entry: ListingFactsEntry) =>
  [...entry.artifacts, ...entry.refused_archives].reduce((sum, artifact) => sum + artifact.size, 0);
/** Entries of `next` that must be reproduced against `previous`, in port_id order. */
export function reproductionPlan(previous: unknown, next: ListingFactsTable) {
  const before = new Map(
    (isRecord(previous) && Array.isArray(previous.entries)
      ? (previous.entries as ListingFactsEntry[])
      : []
    ).map((entry) => [entry.port_id, entry]),
  );
  const entries = next.entries.filter((entry) =>
    needsReproduction(before.get(entry.port_id), entry),
  );
  return { entries, bytes: entries.reduce((sum, entry) => sum + reproductionCost(entry), 0) };
}
