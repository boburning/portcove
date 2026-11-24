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
//  5. one facts entry exists for it, names that same repository, was written
//     by the current facts parser version and judged release text with the
//     listing's own words (`listing_words`, else `repository-mismatch`);
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
//     a date, time or hash is a prerelease (`channelOnlyTag`), and so is a
//     release whose title or first body line states one where a status
//     stands (`releaseStatement`, `statesPrerelease`);
//  7b. the release ships no other package form (a non-archive desktop
//     package such as `.exe`, `.msix`, `.AppImage`, `.sh` or `.dmg`, a bare
//     binary, or any other asset that is neither a read archive, a library,
//     a non-desktop package nor on the closed non-program list: an unread
//     container whose name permits P, `otherPackageForm`) for a platform P it also offers a readable archive
//     for (one whose name permits P), other than that archive's own player
//     for P: every such asset has a provider digest equal to a player of P's
//     archives, or is the LISTING's product (`listingProductNames`) at the
//     same version in another package form whose archives' players are
//     named literally for that product
//     (`sameProductForm`, `programNamesProduct`, `sameVersion`,
//     a contradiction detector, never proof the archive is the game), else
//     the release offers a different package than the archive where the rule
//     would bind, the archives' role is unknown and the whole identity is
//     excluded (`other-package-form-beside-archive`). A form serving only
//     platforms without an offered archive is ignored, and a source archive
//     (`sourceArchive`) offers no platform;
//  7c. no archive that could be the game, on any platform, bundles a
//     toolchain helper: the whole identity is `bundled-toolchain`;
//  8. for at least one supported desktop platform P there is an artifact whose
//     typed role is `desktop-game-runtime` from exact digest-bound archive
//     bytes, which neither its asset name (Core's filename classifier and
//     listing-only tool and system vetoes, vetoes only) nor another source
//     contradicts, whose name holds no role word (`archiveRoleToken`: an
//     update, patch, delta or symbols archive, also with trailing digits,
//     whatever the product's own name) and names no other system or
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
//     artifacts remain they are one package (equal archive SHA-256,
//     `onePackage`), whatever their names say, else `ambiguous-artifact`;
//     no archive Core refused has
//     a name that allows P (`core-refused`);
// 10. on P no acquisition restriction holds `register-external` or `launch`
//     (a `download` hold does not block registration; this route never offers
//     a download);
// 11. on no platform is the one program named for a launcher, loader,
//     settings or setup step (`launcherProgram`): the whole identity is
//     `launcher-entry`, and the gate refuses every runtime of such an identity;
// 11a. contradiction detectors layered on top, which can only withhold: no
//     archive or program name holds a character outside ASCII
//     (`non-ascii-name`), and no program of an archive that could be the
//     game, on any platform, has a role word (`programRoleWord`) in its file
//     name or any folder segment, or glued to the product's name
//     (`role-program`);
// 11b. closed vocabulary: on every platform with a runtime, every token of the
//     offered archive's name is a product word, a version or a neutral word,
//     and the product words joined are the listing's or repository's name
//     (`archiveNameAccount`), else the whole identity is
//     `archive-name-unaccounted`; every offered program's literal name is
//     that name (with architecture words only where no other package form
//     ships) in folders of accounted words (`programNameUnaccounted`), else
//     `program-name-unaccounted`. Anything unaccounted withholds; nothing
//     enrolls by being absent from a deny-list. Measured name reliefs only
//     ACCOUNT for tokens (`nameReliefs`): a partial name with a distinctive
//     word and every adjacent number, an initialism, a measured port
//     descriptor, a build identifier, and a folder spelled like the archive.
//     A relieved product that spells another catalog listing's complete name
//     is `archive-names-another-listing`.
// A source-named archive holding programs counts in rules 7b, 7c and 9 as an
// ordinary candidate (`countedArchive`) and is never itself offered.
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
export const GENERATOR_VERSION = 23;
/** The facts parser version this generator reads. */
export const FACTS_PARSER = "listing-package-facts";
export const FACTS_PARSER_VERSION = 23;
export const FACTS_TABLE_FORMAT = 17;
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
  "upstream-unavailable",
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
   * Every name in the archive's listing that equals a toolchain helper, with
   * or without `.exe` (`toolchainNames`): a file leaf as recorded
   * (`python.exe`), a directory component that is no file leaf with a
   * trailing `/` (`zig/`, `link/`). Sorted and unique. The fit rule
   * (`bundledToolchain`) and the gate each derive the helpers from it.
   */
  toolchain_names: string[];
  /**
   * Compiler, interpreter and build helpers the archive bundles
   * (`bundledToolchain` of `toolchain_names`). Sorted and unique; any one
   * means the release builds or prepares the game on the player's machine
   * (`bundled-toolchain`).
   */
  bundled_toolchain: string[];
  /**
   * The archive listing's distinct file names (Core's `leaves`) counted:
   * all of them, and those that are source files (`sourceFileLeaf`). Only
   * counts are recorded; the source-archive rule (`sourceArchive`) reads them.
   */
  listing_counts: { leaves: number; source_leaves: number };
}
/**
 * Source-file extensions and exact build-file names a source or
 * third-party library dump consists of. A closed list; anything else is not
 * a source file.
 */
export const sourceFileExtensions = [
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "c++",
  "hpp",
  "hh",
  "hxx",
  "inl",
  "ipp",
  "m",
  "mm",
  "rs",
  "go",
  "java",
  "kt",
  "cs",
  "swift",
  "zig",
  "s",
  "asm",
  "py",
  "js",
  "ts",
  "cmake",
  "mk",
  "am",
  "ac",
] as const;
export const sourceFileNames = [
  "makefile",
  "cmakelists.txt",
  "configure",
  "meson.build",
  "build.gradle",
  "cargo.toml",
] as const;
/** Whether an archive listing file name is a source or build file. */
export function sourceFileLeaf(leaf: string): boolean {
  const lower = leaf.toLowerCase();
  if ((sourceFileNames as readonly string[]).includes(lower)) return true;
  const dot = lower.lastIndexOf(".");
  return dot > 0 && (sourceFileExtensions as readonly string[]).includes(lower.slice(dot + 1));
}
/** The recorded listing counts of an archive's file names (Core's `leaves`). */
export function listingCounts(leaves: readonly string[]): ArtifactFactV2["listing_counts"] {
  const distinct = [...new Set(leaves.map((leaf) => leaf.toLowerCase()))];
  return { leaves: distinct.length, source_leaves: distinct.filter(sourceFileLeaf).length };
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
  /**
   * Whether the observer reported the release's own text (its name and
   * body): `unobserved` is UNKNOWN optional evidence, never a statement
   * either way, and leaves `title` and `statement` null.
   */
  text: "observed" | "unobserved";
  /**
   * The release name as published when it is bounded printable text
   * (`recordedTag`'s class), else null. Recorded so the fit rule and the
   * gate each re-derive its statement (`releaseStatement`).
   */
  title: string | null;
  /**
   * The first prerelease statement the release's own text makes: where
   * (`title`, or `body-first-line`, the first non-empty line or heading of
   * the body) and which token class. The body itself is never stored. Null
   * when neither place states a prerelease.
   */
  statement: ReleaseStatement | null;
}
/** Token classes a release title or first body line can state a prerelease with. */
export const statementTokens = [
  "prerelease",
  "release-candidate",
  "beta",
  "alpha",
  "early-access",
  "unstable",
  "nightly",
  "preview",
  "experimental",
  "test-build",
  "development-snapshot",
  "wip",
  "dev",
  "canary",
  "demo",
  "debug-build",
  "test-release",
  "prototype",
  "playtest",
  "daily-build",
  "not-for-production",
] as const;
export type StatementToken = (typeof statementTokens)[number];
export const statementFields = ["title", "body-first-line"] as const;
export interface ReleaseStatement {
  field: (typeof statementFields)[number];
  token: StatementToken;
}
/**
 * The words a listing's own names supply (its id, name and original game
 * title, `nameWords`), sorted and unique: with the repository name's words
 * they are the product's own words, which a release title or first body line
 * uses as a name, not as a status (`releaseStatement`). The facts record them
 * per entry (`listing_words`), so the facts check, the fit rule and the gate
 * judge release text with the same words.
 */
export function listingWords(listing: Record<string, unknown>): string[] {
  return [
    ...new Set(
      [listing.id, listing.name, listing.original_game_title]
        .filter((value): value is string => typeof value === "string")
        .flatMap(nameWords)
        .filter((word) => word.length <= 64),
    ),
  ]
    .toSorted(compareCodePoints)
    .slice(0, maxListingWords);
}
/** At most this many listing words (each at most 64 characters) are recorded per entry. */
export const maxListingWords = 64;
/**
 * Release text with what never states anything about the release removed:
 * image references (`![alt](beta.png)`), HTML tags, link targets (the link
 * text stays), URLs, compare ranges (`v0.9-beta...v1.0`, as in a generated
 * "Full Changelog" line) and image file names.
 */
export function statementText(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/gu, "$1")
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/gu, " ")
    .replace(/(?<![A-Za-z0-9])www\.\S*/giu, " ")
    .replace(/\S+\.{2,3}\S+/gu, " ")
    .replace(/\S+\.(?:png|jpe?g|gif|webp|svg|ico|bmp)(?![A-Za-z0-9])/giu, " ");
}
/** Words between a status word and its version that keep them adjacent (`Beta build 7`). */
export const statementConnectors = ["build", "version", "ver", "v", "no", "number"] as const;
/**
 * Words that, before a status word (skipping `statementFillers`), make it a
 * negation or a past transition, never the release's own status: `Out of
 * beta`, `No longer a release candidate`, `Changes since the last beta`.
 */
export const statementNegators = [
  "not",
  "no",
  "longer",
  "since",
  "after",
  "from",
  "post",
  "past",
  "former",
  "formerly",
  "previously",
  "was",
  "were",
  "leaving",
  "left",
  "leaves",
  "exits",
  "exited",
  "ended",
  "ends",
  "graduated",
  "graduates",
  "than",
  "over",
  "beyond",
] as const;
/**
 * Words directly before a status word that make it stand as the release's
 * status (`Public beta test`, `Open alpha`), wherever it is in the line.
 */
export const statementQualifiers = [
  "public",
  "open",
  "closed",
  "developer",
  "technical",
  "early",
] as const;
/** Articles, ordinal adjectives and qualifiers skipped when looking for a negation. */
export const statementFillers = [
  "a",
  "an",
  "the",
  "last",
  "latest",
  "previous",
  "final",
  "first",
  ...statementQualifiers,
] as const;
interface StatementWord {
  word: string;
  numeric: boolean;
  /** The index of the glued token (letters and digits joined by single `.` or `_`). */
  group: number;
  parenthesised: boolean;
}
function statementWords(line: string): StatementWord[] {
  const words: StatementWord[] = [];
  let depth = 0;
  let group = 0;
  for (const [token] of statementText(line)
    .toLowerCase()
    .matchAll(/[a-z0-9]+(?:[._][a-z0-9]+)*|[([{]|[)\]}]/gu)) {
    if ("([{".includes(token)) depth++;
    else if (")]}".includes(token)) depth = Math.max(0, depth - 1);
    else {
      group++;
      for (const chunk of token.split(/[._]/u))
        for (const word of chunk.split(/(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/u))
          words.push({ word, numeric: /^[0-9]+$/u.test(word), group, parenthesised: depth > 0 });
    }
  }
  return words;
}
/**
 * The prerelease statement one line of release text makes, or null. The
 * statements are a `prerelease` or `pre release` word pair (`pre-release`),
 * `release candidate` or a standalone `rc`, `beta` or `alpha`, an `early
 * access` word pair, and `unstable`. Words are
 * split at separators and letter/digit changes, never inside a word, so
 * `Arc`, `Alphabet` and `BetaQuest` state nothing. URLs, link targets, image
 * references and compare ranges are removed first (`statementText`).
 *
 * A status word states the release's status only where a status stands: glued
 * to digits (`rc2`, `1.0rc1`, `beta.2`), directly before a version (`Beta 3`,
 * `Pre-release build 7`, `Early access 0.3`, past a connector word,
 * `statementConnectors`) or directly after one (`v1.0 Beta`), as the line's
 * last word (`v1.0 Beta`, `Release candidate`), inside parentheses or
 * brackets (`(beta)`, `(unstable)`), or directly after a qualifier
 * (`statementQualifiers`: `Public beta test`); never anywhere in a sentence. A negation or past transition before it
 * (`statementNegators`, or `out of`) states nothing. The product's own words
 * (the repository name's words and `listingWords`) before the line's first
 * number name the product, not a status (`Beta Squadron 1.2`, `Alpha Quest
 * 1.0`), while the same word after a version still states one (`Beta
 * Squadron 1.3 Beta 2`). Only the release title and the body's first line
 * are ever judged: a project-level remark further down ("pre-release
 * quality") never is.
 */
export function releaseStatement(
  line: string,
  repository: string,
  listing: readonly string[] = [],
): StatementToken | null {
  const own = new Set([...nameWords(repository.split("/")[1] ?? ""), ...listing]);
  const words = statementWords(line);
  const firstNumber = words.findIndex((item) => item.numeric);
  const named = (index: number) =>
    own.has(words[index]!.word) && (firstNumber < 0 || index < firstNumber);
  const negated = (index: number) => {
    let back = index - 1;
    while (back >= 0 && (statementFillers as readonly string[]).includes(words[back]!.word)) back--;
    const previous = words[back]?.word;
    if (previous === undefined) return false;
    return (
      (statementNegators as readonly string[]).includes(previous) ||
      (previous === "of" && words[back - 1]?.word === "out")
    );
  };
  // `preview` and `dev` state a status only with a number: glued to digits
  // (`dev3`, `preview.2`) or directly before one (`Preview 2`, `Dev build 7`).
  const numbered = (index: number) => {
    if (words.some((item) => item.numeric && item.group === words[index]!.group)) return true;
    let after = index + 1;
    while (after < words.length && [...statementConnectors, "release"].includes(words[after]!.word))
      after++;
    return words[after]?.numeric === true;
  };
  const stands = (first: number, last: number) => {
    // Glued to digits: a number in the status words' own tokens.
    const glued = words.some(
      (item) =>
        item.numeric && item.group >= words[first]!.group && item.group <= words[last]!.group,
    );
    if (glued) return true;
    let after = last + 1;
    while (after < words.length && [...statementConnectors, "release"].includes(words[after]!.word))
      after++;
    return (
      words[after]?.numeric === true ||
      words[first - 1]?.numeric === true ||
      // Last in the line, or followed only by connector words and
      // `release` (`Demo version`, `Beta build`, `Canary release`).
      words
        .slice(last + 1)
        .every((item) =>
          [...statementConnectors, "release"].includes(
            item.word as (typeof statementConnectors)[number],
          ),
        ) ||
      words[first]!.parenthesised ||
      (statementQualifiers as readonly string[]).includes(words[first - 1]?.word ?? "")
    );
  };
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!.word;
    const next = words[index + 1]?.word;
    let token: StatementToken | null = null;
    let last = index;
    if (word === "pre" && next === "release") {
      token = "prerelease";
      last = index + 1;
    } else if (word === "release" && next === "candidate") {
      token = "release-candidate";
      last = index + 1;
    } else if (word === "early" && next === "access") {
      token = "early-access";
      last = index + 1;
    } else if (!named(index)) {
      if (word === "prerelease") token = "prerelease";
      else if (word === "rc") token = "release-candidate";
      else if (word === "beta" || word === "alpha") token = word;
      else if (word === "unstable") token = "unstable";
      else if (word === "nightly" || word === "experimental" || word === "wip") token = word;
      else if (word === "test" && next === "build") {
        token = "test-build";
        last = index + 1;
      } else if (word === "development" && next === "snapshot") {
        token = "development-snapshot";
        last = index + 1;
      } else if (word === "debug" && next === "build") {
        token = "debug-build";
        last = index + 1;
      } else if ((word === "test" || word === "testing") && next === "release") {
        token = "test-release";
        last = index + 1;
      } else if (word === "daily" && next === "build") {
        token = "daily-build";
        last = index + 1;
      } else if (word === "preview" || word === "canary" || word === "demo") token = word;
      else if ((word === "dev" || word === "prototype" || word === "playtest") && numbered(index))
        token = word;
    }
    // `Not for production` states a prerelease wherever it stands.
    if (word === "not" && next === "for" && words[index + 2]?.word === "production")
      return "not-for-production";
    if (token !== null && !negated(index) && stands(index, last)) return token;
  }
  return null;
}
/**
 * The line of a release body that is judged: the first line, within the
 * first 4,096 characters, that holds a letter or digit once what states
 * nothing is removed (`statementText`) and leading Markdown heading, quote,
 * list and emphasis marks are removed, bounded to 256 characters; null when
 * there is none. A banner image or a bare link line is skipped.
 */
export function bodyFirstLine(body: string): string | null {
  for (const raw of body.slice(0, 4096).split(/\r?\n/u)) {
    const line = statementText(raw)
      .replace(/^[\s#>*_=~`-]+/u, "")
      .trim();
    if (/[A-Za-z0-9]/u.test(line)) return line.slice(0, 256);
  }
  return null;
}
/**
 * The statement a release's observed text makes: the title first, then the
 * body's first line (`bodyFirstLine`), or null.
 */
export function textStatement(
  title: string | null,
  body: string | null,
  repository: string,
  listing: readonly string[] = [],
): ReleaseStatement | null {
  const titled = title === null ? null : releaseStatement(title, repository, listing);
  if (titled !== null) return { field: "title", token: titled };
  const first = body === null ? null : bodyFirstLine(body);
  const bodied = first === null ? null : releaseStatement(first, repository, listing);
  return bodied === null ? null : { field: "body-first-line", token: bodied };
}
/**
 * Whether a recorded release states a prerelease in its own text: its
 * recorded title re-derived here with the listing's words, or the recorded
 * body statement.
 */
export function statesPrerelease(
  release: ObservedReleaseFact,
  repository: string,
  listing: readonly string[],
): boolean {
  return (
    release.statement !== null ||
    (release.title !== null && releaseStatement(release.title, repository, listing) !== null)
  );
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
  "asset-not-found",
] as const;
export type RefusalClass = (typeof refusalClasses)[number];
/**
 * Why an inspection failed without a permanent verdict on the bytes, as a
 * bounded class: the download (`network`), a timeout or deadline
 * (`over-budget`), bytes Core read but returned nothing usable for
 * (`unreadable-archive`), an identity whose inspection does not fit the
 * per-identity budget CI can reproduce (`runner-time`,
 * `identityBudgetMinutes`), a runner that ran out of disk while Core
 * extracted the archive (`runner-disk`), or a refusal class
 * (`refusalClasses`, including `digest-mismatch`). The runner causes are
 * real constraints of the hosted runner, never verdicts on the bytes.
 */
export const failureCauses = [
  "network",
  "over-budget",
  "unreadable-archive",
  "runner-time",
  "runner-disk",
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
 * not on the list. A file leaf also matches a versioned or renamed copy of
 * a compiler or interpreter (`versionedHelper`).
 */
export const toolchainHelpers = [
  "zig",
  "clang",
  "clang++",
  "gcc",
  "g++",
  "cc1",
  "ld",
  "lld",
  "ld.lld",
  "python",
  "python3",
  "pythonw",
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
/**
 * Short or common helper names that also name ordinary folders
 * (`assets/link/`, `levels/ld/`, `make/`, `node/`, `Python/`): they match only
 * as a file leaf, with or without `.exe`, never as a directory.
 */
export const fileOnlyHelpers = [
  "cl",
  "ld",
  "link",
  "make",
  "node",
  "python",
  "python3",
  "pythonw",
  "pip",
];
/**
 * A versioned or renamed compiler or interpreter file leaf, never a
 * directory: `python3.11`, `clang-17`, `gcc-13`, `zig-x86_64`,
 * `pythonw.exe`. Its first group is the helper. `python311.dll` (another
 * extension) and a `gcc-libs/` folder never match.
 */
const versionedHelper =
  /^(python3?|pythonw|clang(?:\+\+)?|gcc|g\+\+|lld|ld\.lld|zig)(?:-?[0-9]+(?:\.[0-9]+)*|-[a-z0-9_]+)?(?:\.exe)?$/u;
/**
 * The helper an archive listing entry names, or null: an exact helper name
 * with or without `.exe`; a file leaf (`file`) also by `versionedHelper`.
 */
function helperOf(name: string, file: boolean): string | null {
  const stem = name.endsWith(".exe") ? name.slice(0, -4) : name;
  if (toolchainHelpers.includes(stem)) return stem;
  return file ? (versionedHelper.exec(name)?.[1] ?? null) : null;
}
/**
 * The helper-named entries of an archive listing: Core's `names` (every path
 * component) and `leaves` (every file name). A file leaf is recorded as is
 * (`python.exe`, `python3.11`), a component that is no file leaf with a
 * trailing `/` (`zig/`). Sorted and unique.
 */
export function toolchainNames(names: readonly string[], leaves: readonly string[]): string[] {
  const files = new Set(leaves.map((leaf) => leaf.toLowerCase()));
  const found = new Set<string>();
  for (const leaf of files) if (helperOf(leaf, true) !== null) found.add(leaf);
  for (const name of names) {
    const lower = name.toLowerCase();
    if (helperOf(lower, false) !== null && !files.has(lower)) found.add(`${lower}/`);
  }
  return [...found].toSorted(compareCodePoints);
}
/**
 * The toolchain helpers recorded listing entries (`toolchainNames`) show,
 * sorted and unique: every helper-named file leaf, and a helper-named
 * directory unless the helper is file-only (`fileOnlyHelpers`).
 */
export function bundledToolchain(entries: readonly string[]): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    const directory = entry.endsWith("/");
    const helper = helperOf(directory ? entry.slice(0, -1) : entry, !directory);
    if (helper === null) continue;
    if (directory && fileOnlyHelpers.includes(helper)) continue;
    found.add(helper);
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
  /**
   * The listing's own words (`listingWords`) the worker judged release text
   * with; the fit rule and the gate re-derive them from the listing and
   * refuse facts judged with other words.
   */
  listing_words: string[];
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
  /**
   * The name of every asset of the offered release that is neither a recorded
   * artifact nor a refused archive, in ascending asset id (within the
   * observer's asset window). The gate classifies these names itself
   * (`gateFormKind`) instead of seeing only what the worker's classifier
   * recorded in `other_packages`.
   */
  asset_names: string[];
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
      "toolchain_names",
      "bundled_toolchain",
      "listing_counts",
    ],
    where,
  );
  const counts = value.listing_counts;
  if (!isRecord(counts)) throw new Error(`${where}.listing_counts must be an object.`);
  exact(counts, ["leaves", "source_leaves"], `${where}.listing_counts`);
  if (
    !Number.isSafeInteger(counts.leaves) ||
    !Number.isSafeInteger(counts.source_leaves) ||
    Number(counts.source_leaves) < 0 ||
    Number(counts.source_leaves) > Number(counts.leaves) ||
    Number(counts.leaves) > coreInspectedFileBound
  )
    throw new Error(
      `${where}.listing_counts needs file and source-file counts within Core's bound.`,
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
  if (
    !Array.isArray(value.toolchain_names) ||
    value.toolchain_names.some(
      (name: unknown, index: number, names: unknown[]) =>
        typeof name !== "string" ||
        (name.endsWith("/") ? helperOf(name.slice(0, -1), false) : helperOf(name, true)) === null ||
        (index > 0 && compareCodePoints(String(names[index - 1]), name) >= 0),
    ) ||
    JSON.stringify(bundledToolchain(value.toolchain_names)) !==
      JSON.stringify(value.bundled_toolchain)
  )
    throw new Error(
      `${where}.toolchain_names must be sorted, unique helper-named listing entries that show its bundled_toolchain.`,
    );
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
    exact(
      release,
      ["release_id", "tag", "prerelease", "published_at", "packaged", "text", "title", "statement"],
      at,
    );
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
    const statement = release.statement;
    if (statement !== null) {
      if (!isRecord(statement)) throw new Error(`${at}.statement must be an object or null.`);
      exact(statement, ["field", "token"], `${at}.statement`);
    }
    const titled =
      typeof release.title === "string" && typeof entry.repository === "string"
        ? releaseStatement(
            release.title,
            entry.repository,
            Array.isArray(entry.listing_words) ? (entry.listing_words as string[]) : [],
          )
        : null;
    if (
      !(release.text === "observed" || release.text === "unobserved") ||
      !(release.title === null || bounded(release.title, 256)) ||
      (release.text === "unobserved" && (release.title !== null || statement !== null)) ||
      (statement !== null &&
        (!(statementFields as readonly unknown[]).includes(statement.field) ||
          !(statementTokens as readonly unknown[]).includes(statement.token))) ||
      // A recorded title's statement is re-derived: it must be the one recorded.
      (titled !== null && (statement?.field !== "title" || statement.token !== titled)) ||
      (titled === null && release.title !== null && statement?.field === "title") ||
      (statement !== null && release.prerelease === false)
    )
      throw new Error(
        `${at} needs its release text observed or unobserved, a bounded title or null, and the prerelease statement that text makes, counted in its verdict.`,
      );
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
    // A container whose name verdict permits no supported platform (a
    // non-desktop or other-system name) serves none: it is recorded with
    // an empty platform list, which only a container may have.
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
      (served.length === 0 && kind !== "container") ||
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
      "listing_words",
      "parser",
      "parser_version",
      "observation",
      "ineligible",
      "unread_forms",
      "observed_releases",
      "other_packages",
      "asset_names",
      "refused_archives",
      "attempt",
      "artifacts",
    ],
    where,
  );
  if (
    !Array.isArray(entry.asset_names) ||
    entry.asset_names.length > listingPackageLimit ||
    entry.asset_names.some((name: unknown) => !bounded(name, 255)) ||
    (Array.isArray(entry.other_packages) ? (entry.other_packages as unknown[]) : []).some(
      (other) => !(entry.asset_names as unknown[]).includes(isRecord(other) ? other.name : other),
    )
  )
    throw new Error(
      `${where}.asset_names must be a bounded list of the release's other asset names, holding every other package form.`,
    );
  if (
    !Array.isArray(entry.listing_words) ||
    entry.listing_words.length > maxListingWords ||
    entry.listing_words.some(
      (word: unknown, index: number, words: unknown[]) =>
        typeof word !== "string" ||
        !/^[a-z0-9]{1,64}$/u.test(word) ||
        (index > 0 && compareCodePoints(String(words[index - 1]), word) >= 0),
    )
  )
    throw new Error(`${where}.listing_words must be the listing's sorted, unique own words.`);
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
      (entry.asset_names as unknown[]).length ||
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
  ".appinstaller",
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
 * from a second title by name alone (`skyrun` beside `skyrow`, a launcher
 * beside its game), so it is `ambiguous-player`, never enrolled.
 */
export const maxDistinctPrograms = 1;
/**
 * Words that name a build variant of the same program, not another program,
 * when they stand alone between separators. A bare `64`, `32` or `86` is
 * dropped only in that position (`Game-64.exe`, `skyrun.x86_64.exe`), never
 * when it is glued to the name: `Lantern64.exe` can be a different game
 * from `Lantern.exe`, and `Game64.exe` cannot be told apart from it by name, so
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
 * A program's name without its build-variant words: `skyrun.x86_64.exe` and
 * `skyrun.x86.exe` are both `skyrun`, `Game.console.exe` and `Game-64.exe`
 * are `game`, `Lantern3.exe` stays `lantern-3` and `Lantern64.exe` stays `lantern-64`.
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
 * (`new-game`, `fix-it-fast`, `test-orbit`), so alone among product words
 * they stay.
 */
const conditionalChannelWords = new Set([
  "test",
  "testing",
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
/**
 * The date or time part a word continues, after the part before it, or ""
 * when it is none. Only real calendar and clock shapes count: a year
 * `19xx`/`20xx`; a month directly after a year and a day directly after that
 * month (`2025-01-01`); an eight-digit `yyyymmdd`, optionally with `hhmm` or
 * `hhmmss` glued after it; and an `hhmm` or `hhmmss` word directly after a
 * whole date (`build_20261120_2250`). So `build-42`, `build-1234` and
 * `beta-01` hold no date.
 */
type DatePart = "" | "year" | "month" | "date" | "time";
const compactDate =
  /^(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])(?:(?:[01][0-9]|2[0-3])[0-5][0-9](?:[0-5][0-9])?)?$/u;
const timeOfDay = /^(?:[01][0-9]|2[0-3])[0-5][0-9](?:[0-5][0-9])?$/u;
export function nextDatePart(previous: DatePart, word: string): DatePart {
  if (compactDate.test(word)) return "date";
  if (previous === "date" && timeOfDay.test(word)) return "time";
  if (previous === "month" && /^(?:0[1-9]|[12][0-9]|3[01])$/u.test(word)) return "date";
  if (previous === "year" && /^(?:0[1-9]|1[0-2])$/u.test(word)) return "month";
  if (/^(?:19|20)[0-9]{2}$/u.test(word)) return "year";
  return "";
}
/**
 * Whether a tag consists only of rolling-channel words plus dates, times,
 * hashes and build-target words (`build_20261120_2250`, `nightly-2025-01-01`,
 * `continuous`, `latest`, `dev-abc1234`). Such a release is a prerelease for
 * the newest-stable choice even when the provider does not flag it: it names
 * no version a player can rely on. A number that is not a real date or time
 * (`build-42`, `beta-01`) is a version, so the tag is not channel-only.
 */
export function channelOnlyTag(tag: string | null): boolean {
  if (tag === null || !/^[\x21-\x7e]+$/u.test(tag)) return false;
  const lower = tag.toLowerCase().replace(/(?<![a-z0-9])x86[_-]64(?![a-z0-9])/gu, "x8664");
  let channel = false;
  let part: DatePart = "";
  for (const word of lower.split(/[^a-z0-9]+/u).filter(Boolean)) {
    const date = nextDatePart(part, word);
    if (date) {
      part = date;
      continue;
    }
    part = "";
    if (buildTargetWords.has(word)) continue;
    // A commit hash marks a channel build: a tag of only a hash (`abc1234`)
    // names no stable release and no release line of its own.
    if (hashToken(word) || rollingChannelWords.has(word)) {
      channel = true;
      continue;
    }
    const glued = /^([a-z]+)([0-9]+)$/u.exec(word);
    if (glued && rollingChannelWords.has(glued[1]!)) {
      part = nextDatePart("", glued[2]!);
      if (part) {
        channel = true;
        continue;
      }
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
    // A commit hash is version noise, except as the tag's first word, where a
    // hex-looking word names the product (`facade1-v1.0`); `v.0.1` is a version.
    if (hashToken(word) && index > 0) break;
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
 * changes, lowercase (`OpenLanternPS1` is `open`, `lantern`, `ps`, `1`;
 * `lantern64recomp` is `lantern`, `64`, `recomp`).
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
 * does not name `lantern64recomp`. Without a listing binding, only such a line
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
  /** Every catalog listing, for the cross-listing contradiction of a relieved name. */
  listings: readonly Record<string, unknown>[];
}
export function fitContext(records: readonly AuthoredPort[]): FitContext {
  const repositories = new Map<string, { port_id: string; line: string | null }[]>();
  for (const record of records)
    for (const key of listedRepositories(record.listing))
      repositories.set(key, [
        ...(repositories.get(key) ?? []),
        { port_id: record.listing.id, line: boundReleaseLine(record) },
      ]);
  return {
    repositories,
    listings: records.map((record) => record.listing as Record<string, unknown>),
  };
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
  const own = listingWords(record.listing);
  if (statesPrerelease(chosen, entry.repository, own))
    return {
      reason: "no-stable-release",
      detail:
        "The offered release's own title or first body line states a prerelease (pre-release, release candidate, beta or alpha), although the provider flag says stable.",
    };
  // Lines are counted over stable packaged releases only (and releases whose
  // verdict Core did not give): a prerelease's tag noise never splits the
  // product. Prereleases are judged below.
  const stableOrUnknown = (release: ObservedReleaseFact) =>
    release.prerelease === null ||
    (release.prerelease === false &&
      !channelOnlyTag(release.tag) &&
      !statesPrerelease(release, entry.repository, own));
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
        (release.prerelease !== false ||
          channelOnlyTag(release.tag) ||
          statesPrerelease(release, entry.repository, own)) &&
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
  // Audio.
  ".mp3",
  ".ogg",
  ".flac",
  ".wav",
  ".opus",
  // Fonts.
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  // Subtitles.
  ".srt",
  ".vtt",
  // Office documents and ebooks.
  ".docx",
  ".odt",
  ".epub",
  // Signing and attestation (`.cosign.bundle` ends in `.bundle`).
  ".bundle",
  ".p7s",
  ".crt",
  ".cer",
  ".pub",
  ".sbom",
  ".spdx",
  // Lockfiles, configuration, translations and other metadata.
  ".lock",
  ".toml",
  ".exe.config",
  ".map",
  ".ini",
  ".cfg",
  ".mo",
  ".po",
  ".css",
  ".desktop",
  // Game data packs for a host engine (`.pk4`, `.vbmod`, `.rtz`), scripts
  // (`.py`) and ahead-of-time images (`.aot`) are deliberately absent: such
  // a file can be, or launch, the program, so it keeps competing.
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
  "go.sum",
  "go.mod",
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
/**
 * Words that make a name without a file extension a checksum list
 * (`Game-1.0-SHA256SUMS`, `checksums-linux`), as a whole separator-delimited
 * word.
 */
export const checksumWords = ["sha256sums", "sha512sums", "checksums"] as const;
/** Whether a name has no file extension: no final `.` and letters and digits including a letter, other than a version (`v1`). */
const extensionless = (lower: string) => {
  const extension = /\.([a-z0-9]+)$/u.exec(lower)?.[1];
  return extension === undefined || !/[a-z]/u.test(extension) || /^v[0-9]+$/u.test(extension);
};
/** A release file that is never a program: `nonProgramSuffixes`, `nonProgramNames`, a license name or an extension-less checksum list. */
export const nonProgramFile = (name: string) => {
  const lower = name.toLowerCase();
  return (
    nonProgramSuffixes.some((suffix) => lower.endsWith(suffix)) ||
    (nonProgramNames as readonly string[]).includes(lower) ||
    spdxName.test(lower) ||
    documentPrefix.test(lower) ||
    (extensionless(lower) &&
      lower
        .split(/[^a-z0-9]+/u)
        .some((word) => (checksumWords as readonly string[]).includes(word)))
  );
};
/**
 * Whole separator-delimited words that name macOS in a name, and words that
 * name a system with no desktop route (the listing-only system tokens).
 * Judged before the extension-less Linux fallback and before `.pkg`.
 */
export const macosNameWords = ["osx", "macos", "darwin"] as const;
export const nonDesktopNameWords = [
  "android",
  "androidtv",
  "ios",
  "iphone",
  "ipad",
  "ipados",
  "tvos",
  "watchos",
  "visionos",
  "freebsd",
  "openbsd",
  "netbsd",
  "haiku",
  "switch",
  "wii",
  "wiiu",
  "vita",
  "psvita",
  "ps3",
  "ps4",
  "ps5",
  "psp",
  "xbox",
  "3ds",
  "nds",
  "portmaster",
] as const;
const nameWordSet = (lower: string) => new Set(lower.split(/[^a-z0-9]+/u).filter(Boolean));
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
 *  5. `windows`: `.exe`, `.msi`, `.msix`, `.appx`, `.msixbundle`, `.appxbundle`,
 *     `.appinstaller` (an App Installer file names an MSIX package by URI,
 *     possibly hosted elsewhere, so it offers a Windows package);
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
  const words = nameWordSet(lower);
  // A console package (`Game-ps4.pkg`) is not a macOS installer.
  if (lower.endsWith(".pkg") && nonDesktopNameWords.some((word) => words.has(word)))
    return undefined;
  if (lower.endsWith(".dmg") || lower.endsWith(".pkg")) return "macos";
  // A `.wad` beside a desktop archive competes as an unread container:
  // withholding a real console build is cheap.
  if (lower.endsWith(".wad")) return "container";
  if ((nonDesktopForms as readonly string[]).some((form) => lower.endsWith(form))) return undefined;
  // A file extension: a final `.` and letters and digits, one a letter, that
  // are not a version (`v1`). A name without one is a bare binary: macOS
  // when a whole word names macOS, else Linux.
  if (extensionless(lower))
    return macosNameWords.some((word) => words.has(word)) ? "macos" : "linux";
  return "container";
}
const windowsForms: readonly string[] = [
  ".exe",
  ".msi",
  ".msix",
  ".appx",
  ".msixbundle",
  ".appxbundle",
  ".appinstaller",
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
export function competingPackages(
  entry: ListingFactsEntry,
  listing: Record<string, unknown>,
): [string, OtherPackage[]][] {
  const competing: [string, OtherPackage[]][] = [];
  for (const platform of platforms) {
    // A source archive is never offered, so it offers no platform.
    const offered = entry.artifacts.filter(
      (artifact) => namePermits(artifact, platform) && !sourceArchive(artifact, entry.repository),
    );
    if (!offered.length) continue;
    const players = new Set(
      offered.flatMap((artifact) =>
        artifact.players
          .filter((player) => machineRunsOn(player.machine, platform))
          .map((player) => player.sha256),
      ),
    );
    const candidates = offerableArchives(offered, platform);
    const foreign = entry.other_packages.filter(
      (other) =>
        other.platforms.includes(platform) &&
        (other.sha256 === null || !players.has(other.sha256)) &&
        !sameProductForm(other.name, candidates, platform, listing),
    );
    if (foreign.length) competing.push([platform, foreign]);
  }
  return competing;
}

/**
 * Words a package name carries for its package form, never for its product:
 * an installer or portable build of the same product (`Game-1.0-Setup.exe`,
 * `GameInstaller.exe`, `Game-1.0-portable.zip`), also as a camel-case part.
 */
export const packageFormWords = ["setup", "install", "installer", "portable"] as const;
/** Platform and architecture words product words drop besides `buildTargetWords`. */
const productTargetWords = new Set(["universal2", "64bit", "32bit"]);
/**
 * A release asset name's product words and version. The package form
 * (`packageFormOf`, and an `.app` bundle suffix before it) or another file
 * extension is removed; the rest is split at separators (`x86_64`, `x86-64`
 * and `64-bit` stay one word). A whole word that is a platform or
 * architecture word (`buildTargetWords`: `linux`, `win64`, `x86_64`,
 * `amd64`, …), a release-channel word alone or with digits (`channelMarker`:
 * `release`, `beta`, `rc2`, `build`) or a package-form word
 * (`packageFormWords`) is dropped. A version token (`versionToken`: digits,
 * optionally after `v`, `r` or `b`) is the version, without that letter.
 * Every other word is split into product words (`nameWords`: camel-case
 * humps and letter/digit changes), dropping package-form parts, so
 * `GameSetup` is `game`. `Game-1.0-win64.zip`, `Game-1.0-Setup.exe`,
 * `Game-1.0.AppImage` and `game_1.0_amd64.deb` are all product `game`
 * version `1.0`.
 */
export function productIdentity(name: string): { words: string[]; version: string[] } {
  let base = name;
  const form = packageFormOf(name);
  if (form !== undefined) {
    base = base.slice(0, base.length - form.length);
    // A Debian revision after the upstream version (`game_1.0-1_amd64.deb`)
    // is packaging, not the product's version.
    if (form.toLowerCase() === ".deb")
      base = base.replace(/(?<=[0-9])-[0-9]+(?=_[A-Za-z0-9]+$|$)/u, "");
  } else {
    const extension = /\.[A-Za-z0-9]+$/u.exec(base)?.[0];
    if (extension !== undefined && /[A-Za-z]/u.test(extension) && !/^\.v[0-9]+$/iu.test(extension))
      base = base.slice(0, base.length - extension.length);
  }
  if (/\.app$/iu.test(base)) base = base.slice(0, -4);
  const normalized = base
    .replace(/(?<![A-Za-z0-9])x86[_-]64(?![A-Za-z0-9])/giu, "x8664")
    .replace(/(?<![A-Za-z0-9])(64|32)[_-]bit(?![A-Za-z0-9])/giu, "$1bit");
  const words: string[] = [];
  const version: string[] = [];
  for (const chunk of normalized.split(/[^A-Za-z0-9]+/u).filter(Boolean)) {
    const lower = chunk.toLowerCase();
    if (
      buildTargetWords.has(lower) ||
      productTargetWords.has(lower) ||
      channelMarker(lower) ||
      (packageFormWords as readonly string[]).includes(lower)
    )
      continue;
    if (versionToken(lower)) {
      version.push(lower.replace(/^[vrb]/u, ""));
      continue;
    }
    words.push(
      ...nameWords(chunk).filter((word) => !(packageFormWords as readonly string[]).includes(word)),
    );
  }
  return { words, version };
}
/**
 * Whether another package form names the same product and version as every
 * archive that would be offered beside it (`productIdentity`), and that
 * product is the LISTING's product (`listingProductNames`: its words joined
 * equal the listing's id, name or original title words joined): then it is
 * the listed product in another package form, not a competitor. Empty
 * product words on either side, a different version, a product other than
 * the listing's, or no such archive are never the same product. This only
 * detects contradiction: it never proves an archive is the game, and the
 * player-program rules still decide it.
 */
export function sameProductForm(
  name: string,
  archives: readonly ArtifactFactV2[],
  platform: string,
  listing: Record<string, unknown>,
): boolean {
  const other = productIdentity(name);
  return (
    reliefForm(name) &&
    other.words.length > 0 &&
    listingProductNames(listing).has(other.words.join("")) &&
    archives.length > 0 &&
    archives.every((archive) => {
      const own = productIdentity(archive.name);
      return (
        own.words.length > 0 &&
        own.words.join("-") === other.words.join("-") &&
        sameVersion(own.version, other.version, name) &&
        archive.players
          .filter((player) => machineRunsOn(player.machine, platform))
          .every((player) => programNamesProduct(player.path, own.words))
      );
    })
  );
}
/**
 * Whether a player program is named exactly for the product, literally: its
 * lowercased file name, without a trailing `.exe`, with every character that
 * is not a letter or digit removed, equals the product words joined. Nothing
 * else is dropped: no trailing digits, no variant word (`debug`, `console`),
 * no architecture or bitness word. `Game.exe` and `game` name product
 * `game`; `Game-debug.exe`, `Game2.exe`, `Game-2.exe`, `Game64.exe`,
 * `Game.x86_64` and `supergame2.exe` (for `super-game`) do not, nor does a
 * shared word, a prefix or a containment (`GameCodegen.exe` for `game`,
 * `Table.exe` for `table-game`).
 */
export function programNamesProduct(path: string, product: readonly string[]): boolean {
  const joinedProduct = product.join("");
  if (!joinedProduct) return false;
  return literalProgramName(path) === joinedProduct;
}
/**
 * Containers the same-product relief recognises besides the single-system
 * installer and package kinds: an unrecognised container named for the
 * product (`Game-1.0.pk3`, `Game-1.0.wad`) never gets relief.
 */
export const reliefContainerForms = [
  ".7z",
  ".rar",
  ".tar",
  ".tar.bz2",
  ".tbz2",
  ".tar.zst",
] as const;
/** Whether another package form is one the same-product relief may apply to (`reliefContainerForms`). */
export function reliefForm(name: string): boolean {
  const kind = otherPackageForm(name);
  if (kind === "windows" || kind === "linux" || kind === "macos") return true;
  const lower = name.toLowerCase();
  return kind === "container" && reliefContainerForms.some((form) => lower.endsWith(form));
}
/**
 * The listing's product names: its id and name as whole words (`nameWords`)
 * joined, so `super-game` and `Super Game` are both `supergame`. The
 * original game's title is not one.
 */
export function listingProductNames(listing: Record<string, unknown>): Set<string> {
  return new Set(
    [listing.id, listing.name]
      .filter((value): value is string => typeof value === "string")
      .map((value) => nameWords(value).join(""))
      .filter(Boolean),
  );
}
/**
 * The names an archive or program may equal: the listing's id and name and
 * the repository name, each as whole words (`nameWords`). The original
 * game's title is not one: a remake's listing must not enroll an archive
 * named only for the original.
 */
export function accountNames(listing: Record<string, unknown>, repository: string): string[][] {
  return [listing.id, listing.name, repository.split("/")[1]]
    .filter((value): value is string => typeof value === "string")
    .map(nameWords)
    .filter((words) => words.length > 0);
}
/** The account names joined (`accountNames`). */
function ownJoinedNames(listing: Record<string, unknown>, repository: string): Set<string> {
  return new Set(accountNames(listing, repository).map((words) => words.join("")));
}
/**
 * The raw names a program or folder may spell under the reliefs (R4): the
 * listing's id and name, the repository name and the accepted archive
 * product.
 */
export function reliefForms(
  listing: Record<string, unknown>,
  repository: string,
  product: string,
): string[] {
  return [listing.id, listing.name, repository.split("/")[1], product].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
}
/**
 * The closed list of words an archive name may carry besides its product
 * and version: platform and operating-system words, architecture words and
 * packaging words. It grows only from measured evidence with a recorded
 * example (the `unaccounted_tokens` queue), never speculatively.
 */
export const neutralArchiveWords = [
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
  "universal2",
  "x64",
  "x86",
  "x8664",
  "amd64",
  "arm64",
  "aarch64",
  "i386",
  "i686",
  "64bit",
  "32bit",
  "portable",
  "release",
  "appimage",
] as const;
/**
 * The closed list of architecture words a program name may carry after its
 * product name, only where the release ships no other package form:
 * `Game-x64.exe`, `game.x86_64`. A bare `64` or `32` is not one: `Game64`
 * can be another title.
 */
export const programArchitectureWords = [
  "x86",
  "x64",
  "x8664",
  "amd64",
  "arm64",
  "aarch64",
  "i386",
  "i686",
  "64bit",
  "32bit",
  "win32",
  "win64",
  "universal",
  "universal2",
] as const;
/**
 * The closed list of folder words a program may sit under besides product
 * words, versions and neutral words: `bin/`, `x64/`, `game/` and a macOS
 * bundle's `Game.app/Contents/MacOS/`.
 */
export const programLayoutWords = ["bin", "game", "app", "contents", "x64", "win64"] as const;
/** The chunk a build identifier or patch-lettered version becomes before tokenising. */
const buildPlaceholder = "vbuild0";
/**
 * A name with its build identifiers marked (R6): a `V`-glued dotted version
 * after a letter (`recompV0.6.1`) and a dotted version with one glued patch
 * letter other than `a`, `b` or `r` (`1.2.0p`) become a build chunk, and a
 * dotted version glued to a prerelease marker (`1.2.0b2`, `1.0rc1`, `1.0a`)
 * becomes a version chunk followed by the marker as its own chunk, which
 * then withholds as a word after the version.
 */
function buildIdentifiers(base: string): string {
  return base
    .replace(/(?<=[A-Za-z])[vV][0-9]+(?:\.[0-9]+)+(?![A-Za-z0-9])/gu, `-${buildPlaceholder}-`)
    .replace(
      /(?<![A-Za-z0-9.])[vVrR]?[0-9]+(?:\.[0-9]+)+((?:alpha|beta|pre|rc|a|b|r)[0-9]*)(?![A-Za-z0-9])/giu,
      "-v0-$1-",
    )
    .replace(
      /(?<![A-Za-z0-9.])[vVrR]?[0-9]+(?:\.[0-9]+)+[c-qs-zC-QS-Z](?![A-Za-z0-9])/gu,
      `-${buildPlaceholder}-`,
    );
}
/**
 * An archive name's tokens, in order: the package form or another file
 * extension (and an `.app` suffix) is removed, `x86_64`, `x86-64` and
 * `64-bit` are one word, and a run of digit groups joined by dots (`1.0.2`,
 * `v2.1.0`) is one `version` token. The rest is split at separators into
 * chunks: a neutral word (`neutralArchiveWords`) is a `neutral` token; digits
 * after `v` or `r` are a `version` token (a `b` prefix is not one: `b2`
 * usually says beta 2); digits only are an `integer` token; every other
 * chunk is split into whole words (`nameWords`), each a `neutral` token or a
 * `word` token, digits glued to letters included (`Doom3` is `doom`, `3`).
 * `chunk` names the chunk a token came from, for evidence.
 *
 * Build identifiers (R6) are `build` tokens, read like versions: a chunk of
 * 7 to 40 hex characters with a letter and a digit (`e1625759`, the
 * `0c97cca` of `0.79.0c97cca`), a dotted version with one glued patch
 * letter other than `a`, `b` or `r` (`1.2.0p`), and a dotted version glued
 * by `v` or `V` to a product word (`condemned2recompV0.6.1`). A dotted
 * version glued to `a`, `b`, `r`, `rc`, `alpha`, `beta` or `pre`, with or
 * without a number (`1.2.0b2`, `1.0rc1`, `1.0a`), is a prerelease marker: the
 * marker stays a word after the version and withholds.
 */
export function archiveNameTokens(name: string): {
  tokens: {
    word: string;
    kind: "word" | "integer" | "version" | "neutral" | "build";
    chunk: string;
  }[];
} {
  let base = name;
  const form = packageFormOf(name);
  if (form !== undefined) base = base.slice(0, base.length - form.length);
  else {
    const extension = /\.[A-Za-z0-9]+$/u.exec(base)?.[0];
    if (extension !== undefined && /[A-Za-z]/u.test(extension) && !/^\.v[0-9]+$/iu.test(extension))
      base = base.slice(0, -extension.length);
  }
  if (/\.app$/iu.test(base)) base = base.slice(0, -4);
  const widened = base
    .replace(/(?<![A-Za-z0-9])x86[_-]64(?![A-Za-z0-9])/giu, "x8664")
    .replace(/(?<![A-Za-z0-9])(64|32)[_-]bit(?![A-Za-z0-9])/giu, "$1bit");
  const normalized = buildIdentifiers(widened)
    // A dotted version becomes one version chunk.
    .replace(/(?<![A-Za-z0-9.])[vVrR]?[0-9]+(?:\.[0-9]+)+(?![A-Za-z0-9])/gu, "-v0-");
  const neutral = neutralArchiveWords as readonly string[];
  const tokens: {
    word: string;
    kind: "word" | "integer" | "version" | "neutral" | "build";
    chunk: string;
  }[] = [];
  for (const chunk of normalized.split(/[^A-Za-z0-9]+/u).filter(Boolean)) {
    const lower = chunk.toLowerCase();
    if (lower === buildPlaceholder || hashToken(lower))
      tokens.push({ word: lower, kind: "build", chunk: lower });
    else if (neutral.includes(lower)) tokens.push({ word: lower, kind: "neutral", chunk: lower });
    else if (/^[0-9]+$/u.test(lower)) tokens.push({ word: lower, kind: "integer", chunk: lower });
    else if (/^[vr][0-9]+$/u.test(lower))
      tokens.push({ word: lower, kind: "version", chunk: lower });
    else
      for (const word of nameWords(chunk))
        tokens.push({ word, kind: neutral.includes(word) ? "neutral" : "word", chunk: lower });
  }
  // `uni` directly beside a macOS word is a universal-build marker.
  const macos = (token: { word: string } | undefined) =>
    token !== undefined && ["macos", "mac", "osx", "darwin"].includes(token.word);
  tokens.forEach((token, index) => {
    if (
      token.kind === "word" &&
      token.word === universalMarker &&
      (macos(tokens[index - 1]) || macos(tokens[index + 1]))
    )
      token.kind = "neutral";
  });
  return { tokens };
}
/**
 * Whether product tokens spell one account name (`accountNames`) exactly: the
 * tokens joined equal the name's words joined, and every integer token is
 * exactly one whole word of the name at that position.
 */
function spellsName(
  tokens: readonly { word: string; kind: string }[],
  name: readonly string[],
): boolean {
  if (tokens.map((token) => token.word).join("") !== name.join("")) return false;
  const starts = new Map<number, string>();
  let offset = 0;
  for (const word of name) {
    starts.set(offset, word);
    offset += word.length;
  }
  offset = 0;
  for (const token of tokens) {
    if (token.kind === "integer" && starts.get(offset) !== token.word) return false;
    offset += token.word.length;
  }
  return true;
}
/** Whether a four-digit integer reads as a year (1970 to 2099). */
const yearShaped = (word: string) => /^(?:19[7-9][0-9]|20[0-9][0-9])$/u.test(word);
/**
 * How an archive name is accounted for against the listing, by an ordered
 * grammar: `PRODUCT (VERSION | NEUTRAL)*` (`archiveNameTokens`). The product
 * is the contiguous prefix of word and integer tokens; after the first
 * version or neutral token no product word may appear (a later word is
 * unaccounted), and a later integer can never complete a name: one of one to
 * three digits withholds (`number:<n>`), one of four or more digits is a date
 * or build number read as a version. The product must spell one of the listing's id or name, or
 * the repository name (`spellsName`): an integer of one to three digits in it
 * must be a number of that name at that position, and the prefix may instead
 * end at an integer of four or more digits followed only by integers (a date
 * or build number read as a version). The result is the accepted product
 * (joined), whether only the repository name accounts for it, whether a
 * product number was counted, and whether a year-shaped integer was dropped as
 * a version; or the unaccounted tokens: a word after the product, else a
 * product word that is no word of those names (a single letter glued to
 * digits as its chunk, `b2`), else an integer no name has there
 * (`number:<n>`), else the name's words the archive lacks (`missing:<word>`).
 * Any leftover withholds (`archive-name-unaccounted`): for `Game 2`,
 * `Game-1.0-2-…`, `Game-v1-2-…`, `Game-2024-2-…` and `Game-win64-2.zip`; for
 * `Super Game`, `Super-1.0-Game.zip`, `Super-Game-2-…` and `SuperGame-Lite`;
 * for `Doom 2`, `Doom3` and `doom-2.1.0-…`; for `Doom`, `Doom-2-…`.
 *
 * The measured reliefs only account for more tokens (`reliefs` records
 * which): after the product a port descriptor or region word may stand, and
 * `uni` beside a macOS word (`descriptor`); build identifiers are versions
 * (`build-id`); and where no name is spelled exactly, the product may spell
 * one under `reliefSpelling` (`partial-name`, `descriptor`, `initialism`),
 * the listing's names first, then the repository's. Such a product that
 * spells another catalog listing's complete name (`others`,
 * `otherListingsSpelled`) is a contradiction (`anotherListing`).
 */
export function archiveNameAccount(
  name: string,
  listing: Record<string, unknown>,
  repository: string,
  others: readonly Record<string, unknown>[] = [],
):
  | {
      product: string;
      repositoryOnly: boolean;
      numbered: boolean;
      yearAsVersion: boolean;
      reliefs: NameRelief[];
    }
  | { unaccounted: string[] }
  | { anotherListing: string[] } {
  const names = accountNames(listing, repository);
  const repositoryWords = nameWords(repository.split("/")[1] ?? "").join("");
  const listingNames = accountNames(listing, "").map((words) => words.join(""));
  const { tokens } = archiveNameTokens(name);
  let end = 0;
  while (end < tokens.length && (tokens[end]!.kind === "word" || tokens[end]!.kind === "integer"))
    end++;
  const prefix = tokens.slice(0, end);
  const after = tokens.slice(end);
  const evidence = (token: { word: string; chunk: string }) =>
    /^[a-z][0-9]+$/u.test(token.chunk) ? token.chunk : token.word;
  const late = after.filter((token) => token.kind === "word" && !descriptorWord(token.word));
  if (late.length) return { unaccounted: [...new Set(late.map(evidence))] };
  const reliefs = new Set<NameRelief>();
  if (
    after.some((token) => token.kind === "word") ||
    tokens.some((token) => token.word === universalMarker)
  )
    reliefs.add("descriptor");
  if (tokens.some((token) => token.kind === "build")) reliefs.add("build-id");
  const sorted = (more: readonly NameRelief[] = []) =>
    nameReliefs.filter((relief) => reliefs.has(relief) || more.includes(relief));
  // A short integer after a version or neutral token is no product number
  // and no recognisable version: it withholds. Four or more digits (a date
  // or build number) stay versions.
  const lateNumbers = after.filter((token) => token.kind === "integer" && token.word.length < 4);
  if (lateNumbers.length)
    return { unaccounted: [...new Set(lateNumbers.map((token) => `number:${token.word}`))] };
  // The whole prefix first, then cuts at a long integer followed only by integers.
  const cuts = [prefix.length];
  for (let index = 0; index < prefix.length; index++)
    if (
      prefix[index]!.kind === "integer" &&
      prefix[index]!.word.length >= 4 &&
      // After a version, a short integer would withhold: only long ones follow.
      prefix.slice(index).every((token) => token.kind === "integer" && token.word.length >= 4)
    )
      cuts.push(index);
  for (const cut of cuts) {
    const kept = prefix.slice(0, cut);
    if (!kept.length) continue;
    const matched = names.find((words) => spellsName(kept, words));
    if (matched) {
      const joined = matched.join("");
      return {
        product: joined,
        repositoryOnly: joined === repositoryWords && !listingNames.includes(joined),
        numbered: kept.some((token) => token.kind === "integer"),
        yearAsVersion: cut < prefix.length && yearShaped(prefix[cut]!.word),
        reliefs: sorted(),
      };
    }
  }
  // The measured reliefs, on the same cuts: the listing's names first.
  const listingRaw = [listing.id, listing.name].filter(
    (value): value is string => typeof value === "string",
  );
  const repositoryRaw = repository.split("/")[1];
  for (const cut of cuts) {
    const kept = prefix.slice(0, cut);
    if (!kept.length) continue;
    const literal = kept.map((token) => token.word).join("");
    const digits = new Map<number, number>();
    let offset = 0;
    for (const token of kept) {
      if (/^[0-9]+$/u.test(token.word)) digits.set(offset, token.word.length);
      offset += token.word.length;
    }
    let found: { reliefs: NameRelief[]; repositoryOnly: boolean } | undefined;
    for (const raw of listingRaw) {
      const reliefsOf = reliefSpelling(literal, digits, nameForm(raw));
      if (reliefsOf) {
        found = { reliefs: reliefsOf, repositoryOnly: false };
        break;
      }
    }
    if (!found && repositoryRaw !== undefined) {
      const reliefsOf = reliefSpelling(literal, digits, nameForm(repositoryRaw));
      if (reliefsOf) found = { reliefs: reliefsOf, repositoryOnly: true };
    }
    if (!found) continue;
    // A number another accepted name links to a kept word is never optional.
    if (
      dropsLinkedNumber(
        literal,
        digits,
        [...listingRaw, ...(repositoryRaw === undefined ? [] : [repositoryRaw])].map(nameForm),
      )
    )
      continue;
    const another = otherListingsSpelled(literal, digits, others, listing.id);
    if (another.length) return { anotherListing: another };
    return {
      product: literal,
      repositoryOnly: found.repositoryOnly,
      numbered: kept.some((token) => token.kind === "integer"),
      yearAsVersion: cut < prefix.length && yearShaped(prefix[cut]!.word),
      reliefs: sorted(found.reliefs),
    };
  }
  const nameWordSet = new Set(names.flat());
  const extra = prefix.filter(
    (token) => token.kind === "word" && !nameWordSet.has(token.word) && !descriptorWord(token.word),
  );
  if (extra.length) return { unaccounted: [...new Set(extra.map(evidence))] };
  const numbers = prefix
    .filter((token) => token.kind === "integer" && token.word.length < 4)
    .map((token) => `number:${token.word}`);
  if (numbers.length) return { unaccounted: [...new Set(numbers)] };
  const present = new Set(prefix.map((token) => token.word));
  // The name sharing the most words with the archive: the listing's name,
  // then the repository's, then the id.
  const ordered = [listing.name, repository.split("/")[1], listing.id]
    .filter((value): value is string => typeof value === "string")
    .map(nameWords);
  const closest = ordered.reduce<string[] | undefined>((best, words) => {
    const overlap = words.filter((word) => present.has(word)).length;
    const bestOverlap = best?.filter((word) => present.has(word)).length ?? 0;
    return overlap > bestOverlap ? words : best;
  }, undefined);
  const missing = (closest ?? []).filter((word) => !present.has(word));
  if (missing.length) return { unaccounted: missing.map((word) => `missing:${word}`) };
  return { unaccounted: [prefix.map((token) => token.word).join("-") || "no-product"] };
}
/**
 * How a program is accounted for: its literal name (`literalProgramName`)
 * equals one of `names` (the listing's, repository's and accepted archive's
 * product names joined), optionally followed, only where the release ships
 * no other package form (`strict` false), by architecture words
 * (`programArchitectureWords`); and every folder on its path is made of
 * product words, versions, neutral words (`neutralArchiveWords`) and layout
 * words (`programLayoutWords`). The result is null, or the unaccounted
 * leftover (`program-name-unaccounted`): `supergameserver64`,
 * `SUPERGAMELAUNCHER`, `supergame-cli`, `Other.exe` in a joined-name archive,
 * or a `server/` or `tools/` folder.
 */
export function programNameUnaccounted(
  path: string,
  names: ReadonlySet<string>,
  words: ReadonlySet<string>,
  strict: boolean,
  forms: readonly string[] = [],
  used: Set<NameRelief> = new Set(),
): string | null {
  const literal = literalProgramName(path);
  const parsed = forms.map(nameForm).filter((form) => form.length > 0);
  if (!names.has(literal)) {
    const architecture = programArchitectureWords as readonly string[];
    const suffixed = (rest: string): boolean =>
      rest === "" ||
      architecture.some((word) => rest.startsWith(word) && suffixed(rest.slice(word.length)));
    const base = strict
      ? undefined
      : [...names].find((name) => literal.startsWith(name) && suffixed(literal.slice(name.length)));
    if (base === undefined) {
      // R4: beside no other package form, the literal name may spell an
      // accepted name or the accepted archive product under the reliefs,
      // optionally followed by architecture words.
      let relieved: NameRelief[] | null = null;
      for (let cut = literal.length; !strict && relieved === null && cut > 0; cut--) {
        if (!suffixed(literal.slice(cut))) continue;
        const core = literal.slice(0, cut);
        if (dropsLinkedNumber(core, digitRuns(core), parsed)) continue;
        for (const form of parsed) {
          relieved = reliefSpelling(core, digitRuns(core), form);
          if (relieved) break;
        }
      }
      if (relieved === null) return literal;
      for (const relief of relieved) used.add(relief);
    }
  }
  const allowed = new Set<string>([
    ...words,
    ...(neutralArchiveWords as readonly string[]),
    ...(programLayoutWords as readonly string[]),
  ]);
  // Each folder by the archive grammar: a dotted run, `v<N>`, `r<N>` and four
  // or more digits are versions; a whole chunk that is an allowed word or an
  // accounted name (`MacOS`, `x64`, `Doom2` for `Doom 2`) is accepted; an
  // integer of one to three digits only where the segment's words before it
  // and the number spell an accounted name (`Doom-2/` for `Doom 2`, never for
  // `Doom`); digits glued to letters only as a whole accounted name.
  const segmentAccounted = (segment: string): boolean => {
    const normalized = segment
      .replace(/(?<![A-Za-z0-9])x86[_-]64(?![A-Za-z0-9])/giu, "x8664")
      .replace(/(?<![A-Za-z0-9.])[vVrR]?[0-9]+(?:\.[0-9]+)+(?![A-Za-z0-9])/gu, "-v0-");
    let before = "";
    let boundary = false;
    for (const chunk of normalized.split(/[^A-Za-z0-9]+/u).filter(Boolean)) {
      const lower = chunk.toLowerCase();
      if (/^[vr]?[0-9]+$/u.test(lower) && !/^[0-9]{1,3}$/u.test(lower)) {
        boundary = true;
        continue;
      }
      if ((neutralArchiveWords as readonly string[]).includes(lower)) boundary = true;
      if (/^[0-9]{1,3}$/u.test(lower)) {
        // A product number follows the product words directly.
        if (boundary || !names.has(before + lower)) return false;
        before += lower;
        continue;
      }
      if (allowed.has(lower) || names.has(lower)) {
        before += lower;
        continue;
      }
      const parts = nameWords(chunk);
      if (!parts.every((word) => !/^[0-9]+$/u.test(word) && allowed.has(word))) return false;
      before += parts.join("");
    }
    return true;
  };
  for (const segment of path.split("/").slice(0, -1)) {
    if (segmentAccounted(segment)) continue;
    // R5: the whole segment read as the accepted product, versions and
    // neutral words.
    if (!folderSpellsProduct(segment, names, parsed)) return `${segment}/`;
    used.add("folder");
  }
  return null;
}
/**
 * Whether a folder segment is the accepted product, versions and neutral
 * words (R5): read by the archive grammar (`archiveNameTokens`), its product
 * prefix joined is one of `names` or spells an accepted name form under the
 * reliefs (`reliefSpelling`), and every later token is a version, build
 * identifier, neutral word, four-digit-or-longer number, descriptor, or `uni`
 * beside a macOS word. `Amped2-Recomp-v0.2.0-windows-x86_64/`,
 * `SSX3-Recomp-v0.3.0-windows-x86_64/` and `Dora64-3-1.0.0-Windows-x64/`
 * failed the per-word folder rule only for their glued digits.
 */
function folderSpellsProduct(
  segment: string,
  names: ReadonlySet<string>,
  forms: readonly NameFormWord[][],
): boolean {
  if (!forms.length) return false;
  const { tokens } = archiveNameTokens(`${segment}.zip`);
  let end = 0;
  while (end < tokens.length && (tokens[end]!.kind === "word" || tokens[end]!.kind === "integer"))
    end++;
  if (end === 0) return false;
  for (const token of tokens.slice(end))
    if (token.kind === "word" && !descriptorWord(token.word)) return false;
    else if (token.kind === "integer" && token.word.length < 4) return false;
  const kept = tokens.slice(0, end);
  const literal = kept.map((token) => token.word).join("");
  if (names.has(literal)) return true;
  const digits = new Map<number, number>();
  let offset = 0;
  for (const token of kept) {
    if (/^[0-9]+$/u.test(token.word)) digits.set(offset, token.word.length);
    offset += token.word.length;
  }
  if (dropsLinkedNumber(literal, digits, forms)) return false;
  return forms.some((form) => reliefSpelling(literal, digits, form) !== null);
}
/** Whether a name holds any character outside ASCII: a homoglyph or full-width evasion. */
export function nonAsciiName(name: string): boolean {
  return /[\u0080-\u{10ffff}]/u.test(name);
}
/** A program's file name lowercased, without a trailing `.exe`, letters and digits only. */
export function literalProgramName(path: string): string {
  return basename(path)
    .toLowerCase()
    .replace(/\.exe$/u, "")
    .replace(/[^a-z0-9]+/gu, "");
}
/**
 * Whether two asset versions are the same version for `sameProductForm`:
 * equal once trailing zero components are removed (`1.0.0` is `1.0`), or the
 * other form is an AppImage that names no version at all (an unversioned
 * `Game.AppImage` beside `Game-1.0-linux.tar.gz`, a common rolling name).
 * Both unversioned are the same version; any other unversioned form beside
 * a versioned archive, a container above all, keeps competing.
 */
export function sameVersion(
  archive: readonly string[],
  other: readonly string[],
  otherName = "",
): boolean {
  if (!other.length) return !archive.length || /\.appimage$/iu.test(otherName);
  const trimmed = (version: readonly string[]) => {
    const parts = [...version];
    while (parts.length > 1 && /^0+$/u.test(parts.at(-1)!)) parts.pop();
    return parts.join(".");
  };
  return archive.length > 0 && trimmed(archive) === trimmed(other);
}
/**
 * The archives that could be offered for P: runtime facts from exact bytes
 * whose own name vetoes nothing and that hold a player running on P.
 */
function offerableArchives(artifacts: readonly ArtifactFactV2[], platform: string) {
  return artifacts.filter(
    (artifact) =>
      artifact.role === "desktop-game-runtime" &&
      artifact.source.kind === authorizingSource &&
      !vetoed(artifact) &&
      artifact.players.some((player) => machineRunsOn(player.machine, platform)),
  );
}

/** Archive name words that make it a source archive, as whole separator-delimited words. */
export const sourceArchiveWords = ["source", "sources", "src"] as const;
/** Whether an archive's own name says it is a source archive (Core's `source-archive` role, or a source word). */
function sourceNamed(artifact: { name: string; name_suggestion: NameSuggestion }) {
  return (
    artifact.name_suggestion.role === "source-archive" ||
    artifact.name
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .some((word) => (sourceArchiveWords as readonly string[]).includes(word))
  );
}
/** Whether an archive's listing shows an executable program: a kept or a tool-vetoed player. */
const holdsProgram = (artifact: ArtifactFactV2) =>
  artifact.players.length > 0 || artifact.excluded_players.length > 0;
/**
 * Whether an archive is a source or compliance archive. Only an archive whose
 * listing shows no executable program can be one: its name says so
 * (`sourceNamed`), or it is a third-party source dump: at least three
 * quarters of its listing's file names are source or build files
 * (`listing_counts`), and its product words (`productIdentity`) share no
 * word with the repository's name. A source archive is never offered, offers
 * no platform to another package form, is never one of a platform's
 * competing archives and never counts for the toolchain rule. A source-named
 * archive that holds programs is no source archive: it stays in every
 * ambiguity, package and competition count (`countedArchive`), and is never
 * itself offered, because its own name contradicts it.
 */
export function sourceArchive(artifact: ArtifactFactV2, repository: string): boolean {
  if (holdsProgram(artifact)) return false;
  if (sourceNamed(artifact)) return true;
  const { leaves, source_leaves } = artifact.listing_counts;
  if (leaves === 0 || source_leaves * 4 < leaves * 3) return false;
  const own = new Set(nameWords(repository.split("/")[1] ?? ""));
  return !productIdentity(artifact.name).words.some((word) => own.has(word));
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
 * Words of an archive's own name that make it another role than the game
 * package: an update or patch payload, a delta, symbols and debug builds, a
 * dedicated or headless server build, or a demo, also with a trailing number
 * (`update2`, `patch01`, `demo2`). The archive name is split into words like product names are (`nameWords`: separators,
 * camel-case humps, letter/digit changes), so `GameUpdate-linux.tar.gz` holds
 * `update` and `DeltaSquadron-win64.zip` holds `delta`. Every occurrence
 * vetoes, whatever the product's or repository's own name: the archive name
 * alone cannot tell a title word from a role suffix, so a game whose title
 * holds one of these words as a separate word of its archive name is
 * withheld as `contradictory-role` until attribution data vouches for the
 * archive. A glued word that only contains the letters (`Deltaforce`,
 * `Patchwork`) is one other word and does not match.
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
  "dedicated",
  "headless",
  "demo",
] as const;
/** The first role token among an archive name's words, or null. */
export function archiveRoleToken(name: string): string | null {
  const words = new Set(nameWords(name));
  return archiveRoleTokens.find((token) => words.has(token)) ?? null;
}
/** Whether an artifact is vetoed by its own name or its contradiction flag: it is never offered. */
const vetoed = (artifact: ArtifactFactV2) =>
  artifact.contradictory || archiveRoleToken(artifact.name) !== null || sourceNamed(artifact);
/**
 * Whether an archive counts as one that could be a platform's game in the
 * ambiguity, one-package and toolchain rules: a runtime archive from exact
 * bytes whose name holds no role word and that is either not vetoed, or
 * source-named while holding programs (a source-named archive with players
 * is an ordinary candidate for counting, never dropped from the count).
 */
const countedArchive = (artifact: ArtifactFactV2) =>
  artifact.role === "desktop-game-runtime" &&
  artifact.source.kind === authorizingSource &&
  archiveRoleToken(artifact.name) === null &&
  (sourceNamed(artifact) ? artifact.players.length > 0 : !artifact.contradictory);

/**
 * Words that make a program a launcher, loader, settings or setup step
 * rather than the game itself, as a whole word of its file name
 * (`nameWords`: separators, camel-case humps and letter/digit changes):
 * `Launcher.exe`, `GameLauncher.exe`, `Launch.exe`, `StartGame.exe`,
 * `Settings.exe`, `game-config`, `GameCfg.exe`, `Setup.exe`,
 * `Install.exe`, `Loader.exe`. A word only containing one (`Startup.exe`,
 * `Configurator.exe`, `Installation.exe`) is another word and does not match.
 */
export const launcherWords = [
  "launcher",
  "launch",
  "start",
  "loader",
  "settings",
  "config",
  "cfg",
  "configure",
  "setup",
  "install",
  "installer",
] as const;
/** Whether a player program is named for a launcher, settings or setup step. */
export function launcherProgram(path: string): boolean {
  return nameWords(basename(path)).some((word) =>
    (launcherWords as readonly string[]).includes(word),
  );
}
/**
 * Words that make a program, or a folder it sits in, another role than the
 * game itself: a debug build, a dedicated or headless server, tools, an
 * editor, an SDK, or a demo. Matched as whole words (`nameWords`) of the
 * program's file name and of every folder segment of its path:
 * `Game-debug.exe`, `GameServer.exe`, `server/Game.exe`, `Game Editor/Game.exe`.
 * A word only containing one (`Serverless.exe`, `Demos.exe`, `Toolset/`) does
 * not match. Any match withholds the whole identity (`role-program`).
 */
export const programRoleWords = [
  "debug",
  "dedicated",
  "headless",
  "server",
  "tools",
  "editor",
  "sdk",
  "demo",
  "dbg",
  "srv",
  "ded",
  "trial",
  "shareware",
  "test",
] as const;
/**
 * The first role word of a player's file name or folder segments, or null:
 * a whole word (`programRoleWords`), or, glued or in capitals where no word
 * boundary shows, the program's literal name (`literalProgramName`) equal to
 * one of `names` (the listing's, repository's and archive's product names
 * joined) with a role word before or after it (`gameserver.exe`,
 * `GAMESERVER.EXE`, `gamedebug.exe`, `servergame.exe`), or with a trailing
 * `d` (`gamed.exe`, a daemon or dedicated build).
 */
export function programRoleWord(path: string, names: Iterable<string> = []): string | null {
  for (const segment of path.split("/"))
    for (const word of nameWords(segment))
      if ((programRoleWords as readonly string[]).includes(word)) return word;
  const literal = literalProgramName(path);
  for (const name of names) {
    if (!name) continue;
    if (literal === `${name}d`) return "d";
    for (const role of programRoleWords)
      if (literal === `${name}${role}` || literal === `${role}${name}`) return role;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Name reliefs (generator 23). The product attribution of an archive comes
// from the catalog binding (the listing names its own repository, a shared
// repository is withheld, more than one surviving archive is ambiguous);
// names detect contradictions. Each relief below only ACCOUNTS for tokens
// that exact name equality could not: it never overrides a deny list, an
// ambiguity, a split package, a wrong number or any token still unaccounted.
// Every relief was measured on real upstream data (main at 157d6be2,
// generator 22) with the recorded example beside it; the lists grow only so.

/** The reliefs an enrollment can depend on, each listed for a person to hand-check. */
export const nameReliefs = [
  "partial-name",
  "initialism",
  "descriptor",
  "build-id",
  "folder",
] as const;
export type NameRelief = (typeof nameReliefs)[number];
/**
 * Port-descriptor words: a word that says how a port was made, not which
 * game it is. An archive or program name may carry one the accepted name
 * lacks, and may omit one the accepted name has. A descriptor is never the
 * distinctive word of a partial name. Each has its measured example.
 */
export const portDescriptorWords = [
  // `gow2-recomp-0.4.7-linux-x86_64.tar.gz` (repository gears-of-war-2-pc-port);
  // repositories `doa3-recomp`, `ki-recomp`, `f-zero-x-recomp`.
  "recomp",
  // `FZeroXRecompiled-v0.1.16-windows-x64.zip` (repository f-zero-x-recomp),
  // `DarkRiftRecompiled-macOS-arm64.zip` (repository DarkRiftRecomp).
  "recompiled",
  // Listing "The Sims (Original Xbox Static Recompilation)", `Sims1-win64.zip`.
  "recompilation",
  // Repository crusader-no-remorse-decomp, `crusader-no-remorse-1.69.0-windows-x64.zip`.
  "decomp",
  // Owner-listed in the `decomp` family; no separate archive measured.
  "decompiled",
  // Repository SealTeam-Source-Port, `SealTeam-0.6.1-windows-x64.zip`.
  "port",
  // `MechAssault2-PC-v0.1.0-win-x64.zip`, `Skate2-PC-v0.2.0.zip`, `Skate1-PC-v0.2.0.zip`.
  "pc",
  // Two measured archive names carry `native` beside the port's product.
  "native",
  // "Static Recompilation" in a listing title (`Sims1-win64.zip`).
  "static",
  // Owner-listed in the same family; no separate archive measured.
  "unofficial",
] as const;
/**
 * Region words of the original the player must supply, read like
 * descriptors: `usa` and `ntsc` were measured on archive names; `pal` is
 * owner-listed in the same family.
 */
export const regionDescriptorWords = ["usa", "ntsc", "pal"] as const;
/**
 * `uni` is a macOS universal-build marker (two measured macOS archives), and
 * only directly beside a macOS platform word of the same name (`macos`,
 * `mac`, `osx`, `darwin`): `Game-1.4-macos-uni.zip`, `Game-uni-macOS.zip`.
 * Anywhere else it is unaccounted.
 */
export const universalMarker = "uni";
const descriptorSet = new Set<string>([...portDescriptorWords, ...regionDescriptorWords]);
/** Whether a word is a port descriptor or region word (`portDescriptorWords`, `regionDescriptorWords`). */
export const descriptorWord = (word: string) => descriptorSet.has(word);
/**
 * Words that never count as the distinctive word a partial name keeps:
 * articles and connectors, generic nouns and edition words, and platform
 * and console words. Descriptors, neutral words, numbers and single letters
 * never count either.
 */
export const nonDistinctiveWords = [
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "from",
  "by",
  "vs",
  "versus",
  "de",
  "la",
  "le",
  "el",
  "les",
  "los",
  "das",
  "der",
  "die",
  "no",
  "game",
  "games",
  "edition",
  "collection",
  "series",
  "remake",
  "remaster",
  "remastered",
  "version",
  "project",
  "engine",
  "source",
  "sdl",
  "original",
  "classic",
  "complete",
  "definitive",
  "deluxe",
  "ultimate",
  "special",
  "anniversary",
  "trilogy",
  "episode",
  "part",
  "chapter",
  "vol",
  "volume",
  "hd",
  "xbox",
  "playstation",
  "ps",
  "ps1",
  "ps2",
  "ps3",
  "ps4",
  "psx",
  "psp",
  "vita",
  "nintendo",
  "n64",
  "gamecube",
  "gc",
  "wii",
  "wiiu",
  "switch",
  "ds",
  "nds",
  "gba",
  "gb",
  "gbc",
  "snes",
  "nes",
  "sfc",
  "famicom",
  "genesis",
  "megadrive",
  "dreamcast",
  "saturn",
  "sega",
  "sony",
  "arcade",
  "dos",
  "console",
] as const;
const nonDistinctiveSet = new Set<string>([
  ...nonDistinctiveWords,
  ...neutralArchiveWords,
  ...descriptorSet,
]);
/** Whether a word can be the distinctive word of a partial name. */
const distinctiveWord = (word: string) =>
  word.length >= 2 && !/^[0-9]+$/u.test(word) && !nonDistinctiveSet.has(word);
/**
 * Short words that already mean an edition, medium or variant, so an
 * initialism equal to one is never accepted, even where it really is the
 * initials: `hd`, `sd`, `dx`, `cd`, `re` and the like.
 */
export const editionShortWords = [
  "hd",
  "sd",
  "uhd",
  "dx",
  "cd",
  "dvd",
  "ex",
  "se",
  "ce",
  "le",
  "re",
  "mp",
  "sp",
  "vr",
  "xl",
] as const;
/**
 * Words that are never an initialism: the neutral, descriptor, layout and
 * package-form words, every deny list (archive role, program role, launcher,
 * channel, tool and non-desktop words), the variant words that stay
 * unaccounted (`beta`, `demo`, `lite`, `deck`, `mods`, `extended`, `fixed`,
 * …) and `editionShortWords`.
 */
export const initialismVetoWords = [
  ...new Set<string>([
    ...neutralArchiveWords,
    ...portDescriptorWords,
    ...regionDescriptorWords,
    universalMarker,
    ...programLayoutWords,
    ...packageFormWords,
    ...archiveRoleTokens,
    ...programRoleWords,
    ...launcherWords,
    ...channelWords,
    ...conditionalChannelWords,
    ...rollingChannelWords,
    ...variantWords,
    ...nonDesktopNameWords,
    ...sourceArchiveWords,
    ...editionShortWords,
    "test",
    "demo",
    "trial",
    "lite",
    "deck",
    "mods",
    "mod",
    "extended",
    "fixed",
    "remaster",
    "remastered",
    "classic",
    "tool",
    "tools",
    "cli",
    "data",
    "assets",
    "bin",
    "sdk",
  ]),
].toSorted(compareCodePoints);
const initialismVeto = new Set<string>(initialismVetoWords);

/** One word of an accepted name with what the reliefs need to know about it. */
export interface NameFormWord {
  word: string;
  numeric: boolean;
  /** A port descriptor or region word: never kept, never required. */
  descriptor: boolean;
  /** Glued to the previous word or joined by a space, `-`, `_` or `.` only. */
  linked: boolean;
  /** Glued to the previous word in one chunk (`3D`, `OpenTESArena`). */
  glued: boolean;
  /** An `s` after an apostrophe (`Hawk's`): it adds no initial. */
  possessive: boolean;
  /** Two to five capitals (`TES`, `DOA`): as an initial it may stand whole. */
  acronym: boolean;
}
/**
 * An accepted name's words (`nameWords` splitting) with their links: a word
 * is `linked` to the previous one when glued to it or joined only by a
 * space, `-`, `_` or `.`, so `Skate 2` links `2` to `skate`, while `Game
 * (1998)` and `Crackdown: Xbox 360` do not link across the bracket or colon.
 */
export function nameForm(value: string): NameFormWord[] {
  const form: NameFormWord[] = [];
  const parts = value.split(/([^A-Za-z0-9]+)/u);
  let separator = "";
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (index % 2 === 1) {
      separator = part;
      continue;
    }
    const pieces = part
      .split(
        /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/u,
      )
      .filter(Boolean);
    pieces.forEach((piece, at) => {
      const word = piece.toLowerCase();
      form.push({
        word,
        numeric: /^[0-9]+$/u.test(word),
        descriptor: descriptorSet.has(word),
        linked: form.length > 0 && (at > 0 || /^[ ._-]+$/u.test(separator)),
        glued: at > 0,
        possessive: at === 0 && word === "s" && /^['’]$/u.test(separator),
        acronym: /^[A-Z]{2,5}$/u.test(piece),
      });
    });
    if (pieces.length) separator = "";
  }
  return form;
}
const formCache = new WeakMap<object, NameFormWord[][]>();
/** The forms of a listing's complete accepted names: its id, its name and its GitHub repository's name. */
function listingForms(listing: Record<string, unknown>): NameFormWord[][] {
  const cached = formCache.get(listing);
  if (cached) return cached;
  const identity = listingProviderIdentity(listing);
  const repository = identity?.provider === "github" ? identity.repository : undefined;
  const forms = [listing.id, listing.name, repository?.split("/")[1]]
    .filter((value): value is string => typeof value === "string")
    .map(nameForm)
    .filter((form) => form.length > 0);
  formCache.set(listing, forms);
  return forms;
}
/** The start of every maximal digit run of a literal, with its length. */
export function digitRuns(literal: string): Map<number, number> {
  const runs = new Map<number, number>();
  for (const match of literal.matchAll(/[0-9]+/gu)) runs.set(match.index, match[0].length);
  return runs;
}
const omittedBit = 1;
const distinctBit = 2;
const descriptorBit = 4;
const keptBit = 8;
const droppedNumberBit = 16;
/**
 * Every way a literal (lowercase letters and digits) spells an ordered
 * subsequence of an accepted name's words with descriptors anywhere, as
 * bit masks: a core word omitted, a distinctive word kept, a descriptor
 * spelled, a word kept. A numeric word must spell exactly one digit run of
 * the literal (`digits`: start to length), so every number of the literal
 * is a number of the name. A numeric word linked to a kept word that is no
 * number must be kept too: `Doom` does not spell `Doom 2`, nor `Skate` for
 * `Skate 2`, while `Crackdown` omits the `360` linked only to an omitted
 * `xbox`, and a year in brackets may go. Descriptor words of the name are
 * never kept and never required.
 */
function subsequenceMasks(
  literal: string,
  digits: ReadonlyMap<number, number>,
  form: readonly NameFormWord[],
  lenient = false,
): Set<number> {
  const memo = new Map<string, Set<number>>();
  const visit = (position: number, index: number, previousKept: boolean): Set<number> => {
    const key = `${position}:${index}:${previousKept ? 1 : 0}`;
    const known = memo.get(key);
    if (known) return known;
    const masks = new Set<number>();
    memo.set(key, masks);
    if (position === literal.length && index === form.length) masks.add(0);
    // Leniently, a digit run of the literal may stand for no word.
    const run = digits.get(position);
    if (lenient && run !== undefined)
      for (const mask of visit(position + run, index, previousKept)) masks.add(mask);
    if (position < literal.length)
      for (const descriptor of descriptorSet)
        if (literal.startsWith(descriptor, position))
          for (const mask of visit(position + descriptor.length, index, previousKept))
            masks.add(mask | descriptorBit);
    if (index < form.length) {
      const word = form[index]!;
      const previous = form[index - 1];
      if (word.descriptor) for (const mask of visit(position, index + 1, false)) masks.add(mask);
      else {
        const spelled = word.numeric
          ? digits.get(position) === word.word.length && literal.startsWith(word.word, position)
          : literal.startsWith(word.word, position);
        // A kept word may not leave its own linked number behind.
        const stranded =
          !word.numeric &&
          word.linked &&
          previous !== undefined &&
          previous.numeric &&
          !previous.descriptor &&
          !previousKept;
        if (spelled && (!stranded || lenient))
          for (const mask of visit(position + word.word.length, index + 1, true))
            masks.add(
              mask |
                keptBit |
                (distinctiveWord(word.word) ? distinctBit : 0) |
                (stranded ? droppedNumberBit : 0),
            );
        const orphaned =
          word.numeric &&
          word.linked &&
          previous !== undefined &&
          !previous.numeric &&
          previousKept;
        if (!orphaned || lenient)
          for (const mask of visit(position, index + 1, false))
            masks.add(mask | omittedBit | (orphaned ? droppedNumberBit : 0));
      }
    }
    return masks;
  };
  return visit(0, 0, false);
}
/** Whether a literal is a run of descriptor words (`descriptorWord`), empty included. */
function descriptorRun(literal: string): boolean {
  const reachable = new Set<number>([0]);
  for (let position = 0; position <= literal.length; position++) {
    if (!reachable.has(position)) continue;
    if (position === literal.length) return true;
    for (const descriptor of descriptorSet)
      if (literal.startsWith(descriptor, position)) reachable.add(position + descriptor.length);
  }
  return false;
}
/**
 * The initialisms of an accepted name (R2): the initials of a run of its
 * words from its first word on, covering more than half of its words and
 * at least two of them, with two to six letters. A word gives its first
 * letter, an acronym (`TES` in `OpenTESArena`) its first letter or all of
 * it, a number all its digits (`wg3d` for `Wayne Gretzky's 3D Hockey`), a
 * possessive `s` nothing. A run may not stop before a number linked to its
 * last word (`dw2` for `Digimon World 2`, never `dw`) or inside a glued
 * chunk (`wg3d`, never `wg3`), and a descriptor ends it. The run keeps a distinctive word, and an initialism that is a deny,
 * neutral, descriptor, channel, variant or edition word (`initialismVetoWords`:
 * `hd`, `dx`, `cd`, `re`, `demo`, …) is never one.
 */
export function nameInitialisms(form: readonly NameFormWord[]): Set<string> {
  const initialisms = new Set<string>();
  const counted = form.filter((word) => !word.possessive && !word.descriptor).length;
  let start = 0;
  while (start < form.length && form[start]!.descriptor) start++;
  let options = new Set<string>([""]);
  let words = 0;
  let distinct = false;
  for (let index = start; index < form.length; index++) {
    const word = form[index]!;
    if (word.descriptor) break;
    if (word.possessive) continue;
    const initials = word.numeric
      ? [word.word]
      : word.acronym
        ? [word.word[0]!, word.word]
        : [word.word[0]!];
    const next = new Set<string>();
    for (const option of options)
      for (const initial of initials)
        if (option.length + initial.length <= 12) next.add(option + initial);
    options = next;
    words++;
    distinct ||= distinctiveWord(word.word);
    // A run never stops inside a glued chunk (`3D`) or before its own
    // linked number.
    const following = form[index + 1];
    if (
      following !== undefined &&
      !following.descriptor &&
      (following.glued || (following.numeric && following.linked))
    )
      continue;
    if (words < 2 || words * 2 <= counted || !distinct) continue;
    for (const option of options) {
      const letters = option.replace(/[0-9]/gu, "").length;
      if (letters < 2 || letters > 6) continue;
      if (initialismVeto.has(option) || initialismVeto.has(option.replace(/[0-9]+$/u, "")))
        continue;
      initialisms.add(option);
    }
  }
  return initialisms;
}
/**
 * The reliefs (`partial-name`, `descriptor`, `initialism`) under which a
 * literal spells one accepted name, or null: the whole name modulo
 * descriptors (`descriptor`); else an ordered subsequence that keeps a
 * distinctive word and every linked number (`partial-name`, R1); else
 * descriptors around one initialism of the name (`initialism`, R2).
 */
export function reliefSpelling(
  literal: string,
  digits: ReadonlyMap<number, number>,
  form: readonly NameFormWord[],
): NameRelief[] | null {
  if (!literal) return null;
  const masks = [...subsequenceMasks(literal, digits, form)].filter((mask) => mask & keptBit);
  if (masks.some((mask) => !(mask & omittedBit))) return ["descriptor"];
  const partial = masks.filter((mask) => mask & omittedBit && mask & distinctBit);
  if (partial.length)
    return partial.some((mask) => mask & descriptorBit)
      ? ["descriptor", "partial-name"]
      : ["partial-name"];
  for (const initialism of nameInitialisms(form)) {
    for (let at = literal.indexOf(initialism); at >= 0; at = literal.indexOf(initialism, at + 1)) {
      const before = literal.slice(0, at);
      const after = literal.slice(at + initialism.length);
      if (/^[0-9]/u.test(after) || /[0-9]$/u.test(before)) continue;
      if (descriptorRun(before) && descriptorRun(after))
        return before || after ? ["descriptor", "initialism"] : ["initialism"];
    }
  }
  return null;
}
/**
 * Whether a relieved literal drops a number one of the listing's own
 * accepted names links to a word the literal keeps (numbers are never
 * optional, across names too): for a listing named "Doom 2" whose id is
 * `doom`, `Doom-1.0-win64.zip` spells the id but drops the name's `2`, and
 * `Sims1-…` drops the `2` of "The Sims 2". A name the literal spells under
 * the reliefs is no contradiction.
 */
export function dropsLinkedNumber(
  literal: string,
  digits: ReadonlyMap<number, number>,
  forms: readonly NameFormWord[][],
): boolean {
  return forms.some((form) => {
    const valid = (mask: number) =>
      (mask & keptBit) !== 0 && (!(mask & omittedBit) || (mask & distinctBit) !== 0);
    if ([...subsequenceMasks(literal, digits, form)].some(valid)) return false;
    return [...subsequenceMasks(literal, digits, form, true)].some(
      (mask) => valid(mask) && (mask & droppedNumberBit) !== 0,
    );
  });
}
/**
 * The other catalog listings whose complete accepted name (id, name or
 * GitHub repository name, modulo descriptors) a relieved literal spells:
 * `StarWars-1.0.zip` in the repository of a listing named "Star Wars
 * Battlefront" spells the listing "Star Wars", a contradiction
 * (`archive-names-another-listing`).
 */
export function otherListingsSpelled(
  literal: string,
  digits: ReadonlyMap<number, number>,
  others: readonly Record<string, unknown>[],
  ownId: unknown,
): string[] {
  const spelled = new Set<string>();
  for (const other of others) {
    if (other.id === ownId) continue;
    for (const form of listingForms(other)) {
      const first = form.find((word) => !word.descriptor);
      if (first === undefined || !literal.includes(first.word)) continue;
      if (
        [...subsequenceMasks(literal, digits, form)].some(
          (mask) => mask & keptBit && !(mask & omittedBit),
        )
      )
        spelled.add(String(other.id));
    }
  }
  return [...spelled].toSorted(compareCodePoints);
}
/**
 * The other archives of a release that may be parts of the game offered on a
 * platform: every archive but the offered one whose listing shows no
 * program (no kept or tool-vetoed player), that is no source archive
 * (`sourceArchive`), and whose own name allows the platform
 * (`Game-data-1.0.zip` or `Game-assets-1.0.zip` beside `Game-1.0-win64.zip`;
 * `Game-data-1.0-linux.tar.gz` ties itself to another platform and is none).
 */
export function splitParts(entry: ListingFactsEntry, platform: string, offered: number) {
  return entry.artifacts.filter(
    (artifact) =>
      artifact.asset_id !== offered &&
      !holdsProgram(artifact) &&
      !sourceArchive(artifact, entry.repository) &&
      namePermits(artifact, platform),
  );
}
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
 * archive can hold the same game program as the full 145 MB build). More
 * than one distinct archive is ambiguous, whatever their names say: an
 * explicitly Windows-named partial build beside an OS-neutral full build
 * cannot be told apart from the full build by name. Order and size never
 * choose.
 */
function onePackage(hosted: ReturnType<typeof hostedPlayers>) {
  const distinct = [
    ...new Map(hosted.map((item) => [item.artifact.sha256, item] as const)).values(),
  ];
  return distinct.length === 1 ? distinct[0] : undefined;
}

/** Why the players one platform would get are not one program, if they are not. */
function ambiguity(
  hosted: ReturnType<typeof hostedPlayers>,
):
  | { kind: "several-programs" | "several-players" | "several-directories"; names: string[] }
  | undefined {
  const players = hosted.flatMap((item) => item.players);
  const programs = new Set(players.map(({ path }) => programStem(path)));
  const names = [...new Set(players.map(({ display_path }) => basename(display_path)))].toSorted(
    compareCodePoints,
  );
  if (programs.size > maxDistinctPrograms) return { kind: "several-programs", names };
  if (hosted.some((item) => new Set(item.players.map(({ path }) => topDirectory(path))).size > 1))
    return { kind: "several-directories", names };
  // Two players of one program on the platform (`Game/bin/Game.exe` beside
  // `Game/x64/Game.exe`, or `Game.exe` beside `Game-x64.exe`) cannot be told
  // apart by name: exactly one must survive the platform selection.
  if (new Set(players.map(({ path }) => path)).size > 1) return { kind: "several-players", names };
  return undefined;
}

/** The `ambiguous-player` exclusions of an entry: one per kind, from the first platform that has it. */
function ambiguityExclusions(entry: ListingFactsEntry): Exclusion[] {
  const usable = entry.artifacts.filter(countedArchive);
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
  return [
    ...entry.artifacts.flatMap((artifact) => artifactExclusions(artifact)),
    ...ambiguityExclusions(entry),
  ];
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
  // A source-named archive holding programs counts here as an ordinary
  // candidate (it can make P ambiguous) but is never the one offered.
  const consistent = authorized.filter(countedArchive);
  if (!consistent.some((artifact) => !vetoed(artifact)))
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
  const chosen = onePackage(hosted);
  if (!chosen) return { reason: "ambiguous-artifact" };
  if (vetoed(chosen.artifact)) return { reason: vetoReason(chosen.artifact) };
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
  // `upstream-unavailable` (listing availability, or every archive of the
  // offered release answering 404) is among `ineligibleReasons`.
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
  "launcher-entry",
  "split-package",
  "role-program",
  "non-ascii-name",
  "archive-names-another-listing",
  "archive-name-unaccounted",
  "program-name-unaccounted",
  "route-held",
  "guide-bound",
] as const;
export type BlockedReason = (typeof blockedReasons)[number];
/**
 * The fit's withholding reasons the gate deliberately does not restate, each
 * with why a wrong enrollment cannot follow from the omission. Every other
 * reason in `blockedReasons` has its own gate restatement, which a test
 * enumerates with one forced enrollment per reason.
 */
export const gateExemptions: Partial<Record<BlockedReason, string>> = {
  "route-held":
    "Core evaluates the listing's acquisition restrictions itself at offer time for every registration and launch (`acquisition_restriction.rs`, `RegisterExternal` and `Launch`), whichever route carries the record, so a held operation stays unusable even if a route were generated.",
  "guide-bound":
    "The bound is a presentation limit, not an attribution: Core's listing validation refuses a guide with more than eight steps and references (`catalog/listings.rs`), so an over-bound generated guide cannot be published.",
};
/** The withholding reasons whose evidence `registration_queues.reason_evidence` carries. */
export const evidenceReasons = [
  "role-program",
  "launcher-entry",
  "split-package",
  "non-ascii-name",
  "archive-names-another-listing",
  "archive-name-unaccounted",
  "program-name-unaccounted",
] as const satisfies readonly BlockedReason[];

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
  | {
      port_id: string;
      fit: true;
      enrollment: GeneratedEnrollment;
      /** The measured name reliefs that accounted for an offered archive, program or folder. */
      reliefs: NameRelief[];
    }
  | {
      port_id: string;
      fit: false;
      reason: BlockedReason;
      detail: string;
      /** The matched word and path or name per finding, for the reasons that carry evidence. */
      evidence?: string[];
      /** The unaccounted tokens, for `archive-name-unaccounted` and `program-name-unaccounted`. */
      tokens?: string[];
    };

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
  const blocked = (
    reason: BlockedReason,
    detail: string,
    evidence?: string[],
    tokens?: string[],
  ): FitDecision => ({
    port_id,
    fit: false,
    reason,
    detail,
    ...(evidence ? { evidence: evidence.slice(0, 32).map((item) => item.slice(0, 300)) } : {}),
    ...(tokens
      ? { tokens: [...new Set(tokens)].slice(0, 32).map((item) => item.slice(0, 120)) }
      : {}),
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
  // Release text was judged with the listing's own words: facts judged with
  // other words (the listing was renamed since) are not this listing's.
  if (entry.listing_words.join(" ") !== listingWords(record.listing).join(" "))
    return blocked(
      "repository-mismatch",
      "Facts judged the release text with the words of another listing name; UNKNOWN until observed again.",
    );
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
  const competing = competingPackages(entry, record.listing);
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
  // A compiler, interpreter or build helper in any archive of the release
  // that could be the game builds or prepares it on first start: that is a
  // property of the project, not of one archive, so every platform waits.
  const toolchains = [
    ...new Set(
      entry.artifacts
        .filter(
          (artifact) =>
            countedArchive(artifact) &&
            !sourceArchive(artifact, entry.repository) &&
            platforms.some((platform) => namePermits(artifact, platform)),
        )
        .flatMap((artifact) => artifact.bundled_toolchain),
    ),
  ].toSorted(compareCodePoints);
  if (toolchains.length)
    return blocked(
      "bundled-toolchain",
      `An archive of the release that could be the game bundles ${toolchains.join(", ")}: the release builds or prepares the game on the player's machine, so every platform awaits review.`,
    );
  // A name with characters outside ASCII can imitate another name (a
  // homoglyph or a full-width letter): every platform waits.
  const nonAscii = [
    ...entry.artifacts.filter((artifact) => nonAsciiName(artifact.name)).map((a) => a.name),
    ...entry.artifacts
      .flatMap((artifact) => artifact.players)
      .filter((item) => nonAsciiName(item.display_path))
      .map((item) => item.display_path),
  ];
  if (nonAscii.length)
    return blocked(
      "non-ascii-name",
      `An archive or program name holds characters outside ASCII: ${nonAscii.slice(0, 3).join(", ")}.`.slice(
        0,
        1000,
      ),
      nonAscii,
    );
  // A debug, server, tools, editor, SDK, demo, trial or test program, or one
  // in a folder so named, in any archive of the release that could be the
  // game: the archive's role is not the game's, so every platform waits.
  const ownNames = ownJoinedNames(record.listing, entry.repository);
  const rolePrograms = entry.artifacts
    .filter(
      (artifact) =>
        countedArchive(artifact) &&
        !sourceArchive(artifact, entry.repository) &&
        platforms.some((platform) => namePermits(artifact, platform)),
    )
    .flatMap((artifact) => {
      const names = new Set(ownNames);
      const product = productIdentity(artifact.name).words.join("");
      if (product) names.add(product);
      return artifact.players.flatMap((item) => {
        const word = programRoleWord(item.display_path, names);
        return word === null ? [] : [`${word}: ${item.display_path}`];
      });
    });
  if (rolePrograms.length)
    return blocked(
      "role-program",
      `A program of an archive that could be the game is named, or sits in a folder named, for another role: ${rolePrograms.slice(0, 3).join(", ")}.`.slice(
        0,
        1000,
      ),
      rolePrograms,
    );
  const runtimes: PlatformRuntime[] = [];
  const misses = new Set<BlockedReason>();
  const held: string[] = [];
  const launchers: string[] = [];
  const unaccountedArchives: string[] = [];
  const archiveTokens: string[] = [];
  const unaccountedPrograms: string[] = [];
  const programTokens: string[] = [];
  const splitPackages: string[] = [];
  const namesAnother: string[] = [];
  const reliefs = new Set<NameRelief>();
  // Beside another package form the program name stays strictly literal.
  const strict = entry.other_packages.length > 0;
  for (const platform of platforms) {
    const found = platformRuntime(entry, platform);
    if ("reason" in found) {
      misses.add(found.reason);
      continue;
    }
    const launcher = found.runtime.players.find((item) => launcherProgram(item.display_path));
    if (launcher) launchers.push(`${platform}: ${launcher.display_path}`);
    // Another archive whose name allows the platform, holds no program and
    // is no source archive may be the rest of the game: the offered archive
    // alone may not be the whole game.
    for (const other of splitParts(entry, platform, found.runtime.asset_id))
      splitPackages.push(`${platform}: ${found.runtime.asset_name} + ${other.name}`);
    const account = archiveNameAccount(
      found.runtime.asset_name,
      record.listing,
      entry.repository,
      context.listings,
    );
    if ("anotherListing" in account)
      namesAnother.push(
        `${platform}: ${found.runtime.asset_name} (${account.anotherListing.join(", ")})`,
      );
    else if ("unaccounted" in account) {
      unaccountedArchives.push(
        `${platform}: ${found.runtime.asset_name} (${account.unaccounted.join(", ")})`,
      );
      archiveTokens.push(...account.unaccounted);
    } else {
      for (const relief of account.reliefs) reliefs.add(relief);
      const names = new Set([...ownJoinedNames(record.listing, entry.repository), account.product]);
      const words = new Set([
        ...nameWords(found.runtime.asset_name),
        ...accountNames(record.listing, entry.repository).flat(),
      ]);
      const forms = reliefForms(record.listing, entry.repository, account.product);
      for (const item of found.runtime.players) {
        const leftover = programNameUnaccounted(
          item.display_path,
          names,
          words,
          strict,
          forms,
          reliefs,
        );
        if (leftover !== null) {
          unaccountedPrograms.push(`${platform}: ${item.display_path} (${leftover})`);
          programTokens.push(leftover);
        }
      }
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
  // A launcher or settings program as the only player may build or prepare
  // the game itself: nothing in the facts says it is the runtime entry.
  if (launchers.length)
    return blocked(
      "launcher-entry",
      `The only player program on ${launchers.join(", ")} is named for a launcher, settings or setup step, and no listing or release data declares it the game's runtime entry.`.slice(
        0,
        1000,
      ),
      launchers,
    );
  if (splitPackages.length)
    return blocked(
      "split-package",
      `The release splits the game across archives on ${splitPackages.join(", ")}: an archive without programs whose name allows the platform may hold the rest of the game.`.slice(
        0,
        1000,
      ),
      splitPackages,
    );
  // A relieved archive product that spells another catalog listing's
  // complete name contradicts this listing's binding.
  if (namesAnother.length)
    return blocked(
      "archive-names-another-listing",
      `The archive offered on ${namesAnother.join(", ")} spells, under a name relief, the complete name of another catalog listing.`.slice(
        0,
        1000,
      ),
      namesAnother,
    );
  // Every token of the offered archive's name is a product word, a version
  // or a neutral word, and the product is the listing's or repository's
  // name: anything left over is unaccounted, and nothing in the facts says
  // what it means.
  if (unaccountedArchives.length)
    return blocked(
      "archive-name-unaccounted",
      `The archive offered on ${unaccountedArchives.join(", ")} carries tokens that are neither the listing's or repository's name, a version nor a neutral platform, architecture or packaging word.`.slice(
        0,
        1000,
      ),
      unaccountedArchives,
      archiveTokens,
    );
  // The program is the product's own name (with an architecture suffix only
  // where no other package form ships), in folders of accounted words.
  if (unaccountedPrograms.length)
    return blocked(
      "program-name-unaccounted",
      `The program offered on ${unaccountedPrograms.join(", ")} is not the listing's, repository's or archive's product name, or sits in a folder of unaccounted words.`.slice(
        0,
        1000,
      ),
      unaccountedPrograms,
      programTokens,
    );
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
    reliefs: nameReliefs.filter((relief) => reliefs.has(relief)),
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
      exclusions.push({
        reason: "asset-role-name",
        token: named.role,
        name: artifact.name,
      });
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
   * The evidence of the name-rule withholds a person acts on: per reason of
   * `evidenceReasons`, per withheld identity in port_id order, the matched
   * word with the program path, or the platform with the archive name and
   * program path, as the fit rule recorded them (`role-program`,
   * `launcher-entry`, `non-ascii-name`, `archive-product-unrelated`,
   * `program-product-unrelated`).
   */
  reason_evidence: Record<(typeof evidenceReasons)[number], Record<string, string[]>>;
  /**
   * The closed-vocabulary withholds grouped by the unaccounted token, most
   * frequent first (then by token): per reason, each token with the number
   * of identities it withholds and those identities in port_id order. A
   * person decides from this queue, with a recorded example, whether a token
   * deserves a neutral list; the lists never grow speculatively.
   */
  /**
   * Every enrolled identity whose offered archive, on some platform, is
   * accounted for only by the repository's name (not the listing's id or
   * name), in port_id order: the group a person hand-checks first.
   */
  accepted_by_repository_name_only: string[];
  /**
   * Every enrolled identity whose offered archive name, on some platform,
   * was accounted for only by counting a number as a product word
   * (`Doom-2-1.0-win64.zip` for `Doom 2`), in port_id order.
   */
  numbered_products: string[];
  /**
   * Every enrolled identity whose offered archive name, on some platform,
   * was accounted for by reading a year-shaped integer (1970 to 2099) as a
   * version (`doom-2016-win64.zip` for `Doom`), in port_id order: a person
   * hand-checks that the year is not part of the title.
   */
  year_as_version: string[];
  /**
   * Every enrolled identity whose release also holds an archive whose only
   * programs the tool veto excluded, beside the offered one, in port_id
   * order: the count the lead measures.
   */
  tool_only_archives_beside: string[];
  /**
   * Every enrolled identity, in port_id order, with the measured name
   * reliefs (`nameReliefs`) that accounted for its offered archive,
   * program or folder names; an empty list when exact names did.
   */
  enrollment_reliefs: Record<string, NameRelief[]>;
  /**
   * The relieved enrollments by relief, each in port_id order: the queue a
   * person hand-checks first (`partial-name`, `initialism`, `descriptor`,
   * `build-id`, `folder`).
   */
  relieved_enrollments: Record<NameRelief, string[]>;
  unaccounted_tokens: Record<
    "archive-name-unaccounted" | "program-name-unaccounted",
    { token: string; count: number; identities: string[] }[]
  >;
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
  /**
   * Per identity, in port_id order, the other package forms that no longer
   * compete with an offered archive only because they name the same product
   * and version (`sameProductForm`): a review queue for the attribution, which
   * detects contradictions and never proves the archive is the game.
   */
  same_product_forms: Record<string, string[]>;
  /** Per identity, in port_id order, its archives classified as source archives (`sourceArchive`). */
  source_archives: Record<string, string[]>;
  /**
   * Per identity, in port_id order, every observed release whose own text
   * states a prerelease, as `<tag or #id>: <field> <token>`.
   */
  release_statements: Record<string, string[]>;
  /**
   * Identities, in port_id order, whose offered release's text the observer
   * did not report: the release-text rule is UNKNOWN for them, not passed.
   */
  release_text_unobserved: string[];
}

export function registrationQueues(generation: Generation): RegistrationQueues {
  const reasons = Object.fromEntries(blockedReasons.map((reason) => [reason, [] as string[]]));
  for (const decision of generation.decisions)
    if (!decision.fit) reasons[decision.reason]!.push(decision.port_id);
  const reasonEvidence = Object.fromEntries(
    evidenceReasons.map((reason) => [
      reason,
      Object.fromEntries(
        generation.decisions
          .flatMap((decision): [string, string[]][] =>
            !decision.fit && decision.reason === reason
              ? [[decision.port_id, decision.evidence ?? []]]
              : [],
          )
          .toSorted(([left], [right]) => compareCodePoints(left, right)),
      ),
    ]),
  ) as RegistrationQueues["reason_evidence"];
  const unaccountedTokens = Object.fromEntries(
    (["archive-name-unaccounted", "program-name-unaccounted"] as const).map((reason) => {
      const byToken = new Map<string, Set<string>>();
      for (const decision of generation.decisions)
        if (!decision.fit && decision.reason === reason)
          for (const token of decision.tokens ?? [])
            byToken.set(token, (byToken.get(token) ?? new Set()).add(decision.port_id));
      return [
        reason,
        [...byToken]
          .map(([token, ids]) => ({
            token,
            count: ids.size,
            identities: [...ids].toSorted(compareCodePoints),
          }))
          .toSorted(
            (left, right) => right.count - left.count || compareCodePoints(left.token, right.token),
          ),
      ];
    }),
  ) as RegistrationQueues["unaccounted_tokens"];
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
    reason_evidence: reasonEvidence,
    accepted_by_repository_name_only: enrolledAccounts(generation, "repositoryOnly"),
    numbered_products: enrolledAccounts(generation, "numbered"),
    year_as_version: enrolledAccounts(generation, "yearAsVersion"),
    tool_only_archives_beside: generation.enrollments
      .filter((enrollment) => {
        const entry = generation.facts.entries.find(
          (candidate) => candidate.port_id === enrollment.port_id,
        );
        const offered = new Set(enrollment.runtimes.map((runtime) => runtime.asset_id));
        return (entry?.artifacts ?? []).some(
          (artifact) =>
            !offered.has(artifact.asset_id) &&
            artifact.players.length === 0 &&
            artifact.excluded_players.length > 0,
        );
      })
      .map((enrollment) => enrollment.port_id)
      .toSorted(compareCodePoints),
    enrollment_reliefs: Object.fromEntries(
      generation.decisions
        .flatMap((decision): [string, NameRelief[]][] =>
          decision.fit ? [[decision.port_id, [...decision.reliefs]]] : [],
        )
        .toSorted(([left], [right]) => compareCodePoints(left, right)),
    ),
    relieved_enrollments: Object.fromEntries(
      nameReliefs.map((relief) => [
        relief,
        generation.decisions
          .filter((decision) => decision.fit && decision.reliefs.includes(relief))
          .map((decision) => decision.port_id)
          .toSorted(compareCodePoints),
      ]),
    ) as Record<NameRelief, string[]>,
    unaccounted_tokens: unaccountedTokens,
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
            competingPackages(entry, listingOf(generation, id)).flatMap(([, foreign]) =>
              foreign.map((other) => other.name),
            ),
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
    same_product_forms: perEntry(generation, (entry) =>
      entry.other_packages
        .filter((other) =>
          other.platforms.some((platform) => {
            const offered = entry.artifacts.filter(
              (artifact) =>
                namePermits(artifact, platform) && !sourceArchive(artifact, entry.repository),
            );
            const digests = new Set(
              offered.flatMap((artifact) =>
                artifact.players
                  .filter((player) => machineRunsOn(player.machine, platform))
                  .map((player) => player.sha256),
              ),
            );
            return (
              offered.length > 0 &&
              (other.sha256 === null || !digests.has(other.sha256)) &&
              sameProductForm(
                other.name,
                offerableArchives(offered, platform),
                platform,
                listingOf(generation, entry.port_id),
              )
            );
          }),
        )
        .map((other) => other.name),
    ),
    source_archives: perEntry(generation, (entry) =>
      entry.artifacts
        .filter((artifact) => sourceArchive(artifact, entry.repository))
        .map((artifact) => artifact.name),
    ),
    release_statements: perEntry(generation, (entry) =>
      entry.observed_releases
        .filter((release) => statesPrerelease(release, entry.repository, entry.listing_words))
        .map((release) => {
          const statement = release.statement ?? {
            field: "title",
            token: releaseStatement(release.title!, entry.repository, entry.listing_words)!,
          };
          return `${release.tag ?? `#${release.release_id}`}: ${statement.field} ${statement.token}`;
        }),
    ),
    release_text_unobserved: generation.facts.entries
      .filter(
        (entry) =>
          entry.ineligible === null &&
          entry.observed_releases.some(
            (release) =>
              release.release_id === entry.observation.release_id && release.text === "unobserved",
          ),
      )
      .map((entry) => entry.port_id)
      .toSorted(compareCodePoints),
  };
}
/** A per-identity name list for every facts entry that has one, in port_id order. */
/** The enrolled identities whose offered archive name was accounted for in this way. */
function enrolledAccounts(
  generation: Generation,
  flag: "repositoryOnly" | "numbered" | "yearAsVersion",
): string[] {
  return generation.enrollments
    .filter((enrollment) =>
      enrollment.runtimes.some((runtime) => {
        const account = archiveNameAccount(
          runtime.asset_name,
          listingOf(generation, enrollment.port_id),
          enrollment.repository,
        );
        return "product" in account && account[flag];
      }),
    )
    .map((enrollment) => enrollment.port_id)
    .toSorted(compareCodePoints);
}
/** The listing record of an identity in a generation, or an empty record. */
function listingOf(generation: Generation, id: string): Record<string, unknown> {
  return (
    (generation.records.find((record) => record.listing.id === id)?.listing as
      | Record<string, unknown>
      | undefined) ?? {}
  );
}
function perEntry(
  generation: Generation,
  names: (entry: ListingFactsEntry) => string[],
): Record<string, string[]> {
  return Object.fromEntries(
    generation.facts.entries
      .map((entry): [string, string[]] => [
        entry.port_id,
        [...new Set(names(entry))].toSorted(compareCodePoints),
      ])
      .filter(([, list]) => list.length)
      .toSorted(([left], [right]) => compareCodePoints(left, right)),
  );
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
  /**
   * The authored records the generation decided, before any generated route
   * was added: the gate judges the listing-level withholds (an operational
   * route, the engine, availability, the repository) on these.
   */
  authored: readonly AuthoredPort[];
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
    authored: records,
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
/** The facts age and last-good retention bounds, restated for the gate (tested equal). */
export const gateFactsAgeDays = 30;
export const gateRetentionDays = 14;
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
    // A number glued to a name is part of it (`lantern64`): only a separate
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
  // Words and the first separator character after each ("" at the end);
  // `x86_64` / `x86-64` standing alone is one build-target word.
  const lower = tag.toLowerCase().replace(/(?<![a-z0-9])x86[_-]64(?![a-z0-9])/gu, "x8664");
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
  // Mark dropped words.
  const alwaysDropped = scanned.map(
    (word) => targets.includes(word.text) || channel.includes(word.text.replace(/[0-9]+$/u, "")),
  );
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
    [
      "test",
      "testing",
      "tester",
      "prealpha",
      "canary",
      "wip",
      "experimental",
      "fixed",
      "fix",
      "new",
    ].includes(word) ||
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
    // A hash reads as the version, except as the first word, where it names
    // the product (`cafe2024-v2`); so does `v.` before digits (`v.0.1.1`).
    if (isHash(text) && index > 0) break;
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
  const hash = (word: string) =>
    /^[0-9a-f]{7,40}$/u.test(word) && /[0-9]/u.test(word) && /[a-f]/u.test(word);
  // Real date and time shapes only: a year 19xx/20xx, a month after a year, a
  // day after that month, yyyymmdd (with hhmm or hhmmss glued), and hhmm or
  // hhmmss after a whole date.
  const twoDigits = (word: string, low: number, high: number) =>
    /^[0-9]{2}$/u.test(word) && Number(word) >= low && Number(word) <= high;
  const clock = (word: string) =>
    (word.length === 4 || word.length === 6) &&
    /^[0-9]+$/u.test(word) &&
    twoDigits(word.slice(0, 2), 0, 23) &&
    twoDigits(word.slice(2, 4), 0, 59) &&
    (word.length === 4 || twoDigits(word.slice(4, 6), 0, 59));
  const year = (word: string) =>
    /^[0-9]{4}$/u.test(word) && ["19", "20"].includes(word.slice(0, 2));
  const fullDate = (word: string) =>
    /^[0-9]+$/u.test(word) &&
    [8, 12, 14].includes(word.length) &&
    year(word.slice(0, 4)) &&
    twoDigits(word.slice(4, 6), 1, 12) &&
    twoDigits(word.slice(6, 8), 1, 31) &&
    (word.length === 8 || clock(word.slice(8)));
  const dateKind = (word: string, before: string) =>
    fullDate(word)
      ? "date"
      : before === "date" && clock(word)
        ? "time"
        : before === "month" && twoDigits(word, 1, 31)
          ? "date"
          : before === "year" && twoDigits(word, 1, 12)
            ? "month"
            : year(word)
              ? "year"
              : "";
  const words = tag
    .toLowerCase()
    .replace(/(?<![a-z0-9])x86[_-]64(?![a-z0-9])/gu, "x8664")
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "");
  let sawChannel = false;
  let before = "";
  for (const word of words) {
    const kind = dateKind(word, before);
    before = kind;
    if (kind || systems.has(word)) continue;
    if (hash(word) || rolling.has(word)) {
      sawChannel = true;
      continue;
    }
    const letters = word.replace(/[0-9]+$/u, "");
    if (rolling.has(letters) && letters !== word) {
      before = dateKind(word.slice(letters.length), "");
      if (before) {
        sawChannel = true;
        continue;
      }
    }
    return false;
  }
  return sawChannel;
}
/** A name's whole words, restated: separators, camel-case humps and letter/digit changes. */
function gateNameWords(value: string): string[] {
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
  return words;
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
    const words = gateNameWords(value);
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
/**
 * Whether an archive's own name holds a role word, restated: see
 * `archiveRoleToken`. The archive name is split into whole words like product
 * names are (`gateNameWords`); every occurrence vetoes, whatever the product's
 * own name. Exported for its unit table only.
 */
export function gateRoleWord(name: string) {
  const roleWords = [
    "update",
    "updater",
    "hotfix",
    "delta",
    "incremental",
    "patch",
    "symbols",
    "debug",
    "dedicated",
    "headless",
    "demo",
  ];
  return gateNameWords(name).some((word) => roleWords.includes(word));
}
/**
 * Toolchain helper names, restated: see `toolchainHelpers`, `fileOnlyHelpers`
 * and `versionedHelper`. `versioned` lists the compilers and interpreters a
 * file leaf may also name with a version or a `-` suffix, longest first where
 * one is a prefix of another.
 */
const gateToolchain = {
  all: [
    "zig",
    "clang",
    "clang++",
    "gcc",
    "g++",
    "cc1",
    "ld",
    "lld",
    "ld.lld",
    "python",
    "python3",
    "pythonw",
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
  ],
  fileOnly: ["cl", "ld", "link", "make", "node", "python", "python3", "pythonw", "pip"],
  versioned: [
    "python3",
    "python",
    "pythonw",
    "clang++",
    "clang",
    "gcc",
    "g++",
    "ld.lld",
    "lld",
    "zig",
  ],
};
/**
 * The helper a recorded listing entry names, restated: an exact helper name
 * with or without `.exe`, or, for a file leaf only, a versioned helper: the
 * base name followed by nothing, by digits and dotted digits with an optional
 * leading `-`, or by `-` and letters, digits and `_`; then an optional `.exe`.
 * Exported for its unit table only.
 */
export function gateHelper(recorded: string): string | null {
  const folder = recorded.endsWith("/");
  let stem = folder ? recorded.slice(0, -1) : recorded;
  if (stem.endsWith(".exe")) stem = stem.slice(0, -4);
  if (gateToolchain.all.includes(stem)) return stem;
  if (folder) return null;
  for (const base of gateToolchain.versioned) {
    if (!stem.startsWith(base)) continue;
    const rest = stem.slice(base.length);
    const numbered = rest.startsWith("-") ? rest.slice(1) : rest;
    const dotted =
      numbered !== "" && numbered.split(".").every((part) => part !== "" && /^[0-9]+$/u.test(part));
    const suffixed = rest.length > 1 && rest[0] === "-" && /^[a-z0-9_]+$/u.test(rest.slice(1));
    if (dotted || suffixed) return base;
  }
  return null;
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
    "mp3",
    "ogg",
    "flac",
    "wav",
    "opus",
    "ttf",
    "otf",
    "woff",
    "woff2",
    "srt",
    "vtt",
    "docx",
    "odt",
    "epub",
    "bundle",
    "p7s",
    "crt",
    "cer",
    "pub",
    "sbom",
    "spdx",
    "lock",
    "toml",
    "map",
    "ini",
    "cfg",
    "mo",
    "po",
    "css",
    "desktop",
  ]);
  const dot = lower.lastIndexOf(".");
  const last = dot < 0 ? "" : lower.slice(dot + 1);
  if ((dot >= 0 && ignoredSuffixes.has(last)) || tail(".intoto.jsonl") || tail(".exe.config"))
    return undefined;
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
    "go.sum",
    "go.mod",
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
  // A name without an extension (none, a version such as `1`, `0-linux` or
  // `v2`) is a bare binary, unless a whole word makes it a checksum list.
  const bare =
    dot < 0 || !/^[a-z0-9]+$/u.test(last) || !/[a-z]/u.test(last) || /^v\d+$/u.test(last);
  const words = lower.split(/[^a-z0-9]+/u);
  if (bare && words.some((word) => ["sha256sums", "sha512sums", "checksums"].includes(word)))
    return undefined;
  // 4. Split volumes: `.001`, `.1000`, `.z01`, `.r00`, `.part1.rar`.
  if (/\.\d\d\d+$/u.test(lower) || /\.[zr]\d\d$/u.test(lower) || /\.part\d+\.rar$/u.test(lower))
    return "container";
  // 5. Single-system forms and bare binaries.
  if (["exe", "msi", "msix", "appx", "msixbundle", "appxbundle", "appinstaller"].includes(last))
    return "windows";
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
  // A `.pkg` naming a console or another non-desktop system is that
  // system's package, not a macOS installer.
  const consoleWords = [
    "android",
    "androidtv",
    "ios",
    "iphone",
    "ipad",
    "ipados",
    "tvos",
    "watchos",
    "visionos",
    "freebsd",
    "openbsd",
    "netbsd",
    "haiku",
    "switch",
    "wii",
    "wiiu",
    "vita",
    "psvita",
    "ps3",
    "ps4",
    "ps5",
    "psp",
    "xbox",
    "3ds",
    "nds",
    "portmaster",
  ];
  if (last === "pkg" && words.some((word) => consoleWords.includes(word))) return undefined;
  if (last === "dmg" || last === "pkg") return "macos";
  // 6. Non-desktop packages keep their own treatment, except a `.wad`, which
  // competes as a container.
  if (last === "wad") return "container";
  if (["ipa", "apk", "aab", "vpk", "nro", "nsp", "3dsx", "cia"].includes(last)) return undefined;
  // A bare binary is macOS when a whole word names macOS, else Linux.
  if (bare)
    return words.some((word) => ["osx", "macos", "darwin"].includes(word)) ? "macos" : "linux";
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

/**
 * The listing's own words, restated: see `listingWords`. Exported for its
 * unit table only.
 */
export function gateListingWords(listing: Record<string, unknown>): string[] {
  const words = new Set<string>();
  for (const value of [listing.id, listing.name, listing.original_game_title])
    if (typeof value === "string")
      for (const word of gateNameWords(value)) if (word.length <= 64) words.add(word);
  return [...words].sort().slice(0, 64);
}
/**
 * The prerelease statement token class a line of release text makes,
 * restated: see `releaseStatement` and `statementText`. Exported for its
 * unit table only.
 */
export function gateStatement(
  line: string,
  repository: string,
  listing: readonly string[] = [],
): string | null {
  const own = [...gateNameWords(repository.split("/")[1] ?? ""), ...listing];
  // Image references, tags, link targets, URLs, compare ranges and image
  // file names never state anything.
  const text = line
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/gu, "$1")
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/gu, " ")
    .replace(/(?<![A-Za-z0-9])www\.\S*/giu, " ")
    .replace(/\S+\.{2,3}\S+/gu, " ")
    .replace(/\S+\.(?:png|jpe?g|gif|webp|svg|ico|bmp)(?![A-Za-z0-9])/giu, " ")
    .toLowerCase();
  const words: { text: string; number: boolean; token: number; inside: boolean }[] = [];
  let depth = 0;
  let token = 0;
  let run = "";
  const flush = () => {
    // Letters and digits joined by one `.` or `_` are one glued token.
    for (const piece of run.split(/[._]{2,}/u)) {
      const parts = piece.split(/[._]/u).flatMap((part) => part.match(/[a-z]+|[0-9]+/gu) ?? []);
      if (!parts.length) continue;
      token++;
      for (const part of parts)
        words.push({ text: part, number: /^[0-9]/u.test(part), token, inside: depth > 0 });
    }
    run = "";
  };
  for (const character of text) {
    if (/[a-z0-9._]/u.test(character)) {
      run += character;
      continue;
    }
    flush();
    if ("([{".includes(character)) depth++;
    else if (")]}".includes(character)) depth = depth > 0 ? depth - 1 : 0;
  }
  flush();
  const qualifiers = ["public", "open", "closed", "developer", "technical", "early"];
  const fillers = ["a", "an", "the", "last", "latest", "previous", "final", "first", ...qualifiers];
  const negators = [
    "not",
    "no",
    "longer",
    "since",
    "after",
    "from",
    "post",
    "past",
    "former",
    "formerly",
    "previously",
    "was",
    "were",
    "leaving",
    "left",
    "leaves",
    "exits",
    "exited",
    "ended",
    "ends",
    "graduated",
    "graduates",
    "than",
    "over",
    "beyond",
  ];
  const connectors = ["build", "version", "ver", "v", "no", "number"];
  let firstNumber = -1;
  for (let index = 0; index < words.length && firstNumber < 0; index++)
    if (words[index]!.number) firstNumber = index;
  for (let index = 0; index < words.length; index++) {
    const here = words[index]!.text;
    const next = words[index + 1]?.text;
    let found: string | null = null;
    let end = index;
    if (here === "pre" && next === "release") {
      found = "prerelease";
      end = index + 1;
    } else if (here === "release" && next === "candidate") {
      found = "release-candidate";
      end = index + 1;
    } else if (here === "early" && next === "access") {
      found = "early-access";
      end = index + 1;
    } else if (!(own.includes(here) && (firstNumber < 0 || index < firstNumber))) {
      if (here === "prerelease") found = "prerelease";
      else if (here === "rc") found = "release-candidate";
      else if (here === "beta" || here === "alpha") found = here;
      else if (here === "unstable") found = "unstable";
      else if (["nightly", "experimental", "wip"].includes(here)) found = here;
      else if (here === "test" && next === "build") {
        found = "test-build";
        end = index + 1;
      } else if (here === "development" && next === "snapshot") {
        found = "development-snapshot";
        end = index + 1;
      } else if (here === "debug" && next === "build") {
        found = "debug-build";
        end = index + 1;
      } else if ((here === "test" || here === "testing") && next === "release") {
        found = "test-release";
        end = index + 1;
      } else if (here === "daily" && next === "build") {
        found = "daily-build";
        end = index + 1;
      } else if (["preview", "canary", "demo"].includes(here)) found = here;
      else if (["dev", "prototype", "playtest"].includes(here)) {
        // Only with a number: glued to digits, or next past connectors.
        let numberAt = index + 1;
        while (
          numberAt < words.length &&
          [...connectors, "release"].includes(words[numberAt]!.text)
        )
          numberAt++;
        if (
          words.some((word) => word.number && word.token === words[index]!.token) ||
          words[numberAt]?.number === true
        )
          found = here;
      }
    }
    if (here === "not" && next === "for" && words[index + 2]?.text === "production")
      return "not-for-production";
    if (found === null) continue;
    let back = index - 1;
    while (back >= 0 && fillers.includes(words[back]!.text)) back--;
    if (
      back >= 0 &&
      (negators.includes(words[back]!.text) ||
        (words[back]!.text === "of" && words[back - 1]?.text === "out"))
    )
      continue;
    let after = end + 1;
    // Connector words and `release` between a status word and its number.
    while (after < words.length && [...connectors, "release"].includes(words[after]!.text)) after++;
    const glued = words.some(
      (word) => word.number && word.token >= words[index]!.token && word.token <= words[end]!.token,
    );
    if (
      glued ||
      words[after]?.number === true ||
      words[index - 1]?.number === true ||
      words.slice(end + 1).every((word) => [...connectors, "release"].includes(word.text)) ||
      words[index]!.inside ||
      (index > 0 && qualifiers.includes(words[index - 1]!.text))
    )
      return found;
  }
  return null;
}
/** Whether a recorded release states a prerelease in its own text, restated. */
function gateStates(release: ObservedReleaseFact, repository: string, listing: readonly string[]) {
  if (release.statement !== null) return true;
  return (
    typeof release.title === "string" && gateStatement(release.title, repository, listing) !== null
  );
}
/**
 * A release asset name's product words and version, restated: see
 * `productIdentity`. Exported for its unit table only.
 */
export function gateProduct(name: string): { words: string[]; version: string[] } {
  const base = gateNameBase(name);
  const targets = gateTargets;
  return gateProductOf(base, targets);
}
/**
 * An asset name without its package form or other lettered extension (and an
 * `.app` bundle suffix), with `x86_64`, `x86-64` and `64-bit` as one word,
 * restated: see `productIdentity`.
 */
function gateNameBase(name: string): string {
  const lower = name.toLowerCase();
  // Known package forms, longest first, then any other lettered extension.
  const forms = [
    ".tar.gz",
    ".tar.xz",
    ".tar.bz2",
    ".tar.zst",
    ".tgz",
    ".tbz2",
    ".zip",
    ".tar",
    ".7z",
    ".rar",
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
    ".msixbundle",
    ".appxbundle",
    ".appinstaller",
    ".msix",
    ".appx",
    ".snap",
    ".bin",
    ".sh",
    ".linux",
    ".x86",
    ".arm64",
    ".aarch64",
    ".ipa",
    ".apk",
    ".aab",
    ".vpk",
    ".nro",
    ".nsp",
    ".3dsx",
    ".cia",
    ".wad",
  ].toSorted((left, right) => right.length - left.length);
  let base = name;
  const form = forms.find((suffix) => lower.endsWith(suffix));
  if (form) {
    base = name.slice(0, name.length - form.length);
    // A Debian package's revision (`_1.0-1_amd64`) is not the version.
    if (form === ".deb") {
      const revision = /([0-9])-[0-9]+(_[A-Za-z0-9]+)?$/u.exec(base);
      if (revision) base = base.slice(0, revision.index) + revision[1]! + (revision[2] ?? "");
    }
  } else {
    const dot = name.lastIndexOf(".");
    const tail = dot < 0 ? "" : name.slice(dot + 1);
    if (/^[A-Za-z0-9]+$/u.test(tail) && /[A-Za-z]/u.test(tail) && !/^[vV]\d+$/u.test(tail))
      base = name.slice(0, dot);
  }
  if (base.toLowerCase().endsWith(".app")) base = base.slice(0, -4);
  return base
    .replace(/(?<![A-Za-z0-9])x86[_-]64(?![A-Za-z0-9])/giu, "x8664")
    .replace(/(?<![A-Za-z0-9])(64|32)[_-]bit(?![A-Za-z0-9])/giu, "$1bit");
}
/** Platform and architecture words a product drops, restated. */
const gateTargets = [
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
  "universal2",
  "x64",
  "x86",
  "x8664",
  "amd64",
  "arm64",
  "aarch64",
  "i386",
  "i686",
  "64bit",
  "32bit",
];
/** A name base's product words and version, restated: see `productIdentity`. */
function gateProductOf(base: string, targets: readonly string[]) {
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
    "hotfix",
  ];
  const formWords = ["setup", "install", "installer", "portable"];
  const words: string[] = [];
  const version: string[] = [];
  for (const chunk of base.split(/[^A-Za-z0-9]+/u)) {
    if (!chunk) continue;
    const low = chunk.toLowerCase();
    const letters = /^([a-z]+)\d*$/u.exec(low)?.[1];
    if (
      targets.includes(low) ||
      formWords.includes(low) ||
      (letters !== undefined && channel.includes(letters))
    )
      continue;
    if (/^[vrb]?\d+$/u.test(low)) {
      version.push(low.replace(/^[vrb]/u, ""));
      continue;
    }
    for (const word of gateNameWords(chunk)) if (!formWords.includes(word)) words.push(word);
  }
  return { words, version };
}
/**
 * Whether another package form names the same product and version as every
 * given archive, that product is the listing's (its words joined equal the
 * listing's id, name or original title words joined), and each archive's
 * players for the platform are named literally for that product (the file
 * name lowercased, without `.exe`, letters and digits only), restated: see
 * `sameProductForm`, `listingProductNames`, `sameVersion` and
 * `programNamesProduct`.
 */
function gateSameProduct(
  name: string,
  archives: readonly ArtifactFactV2[],
  platform: string,
  listing: Record<string, unknown>,
) {
  const other = gateProduct(name);
  if (!other.words.length || !archives.length) return false;
  // Relief only for the single-system kinds and the recognised containers.
  const kind = gateFormKind(name);
  const lowerName = name.toLowerCase();
  if (
    kind !== "windows" &&
    kind !== "linux" &&
    kind !== "macos" &&
    !(
      kind === "container" &&
      [".7z", ".rar", ".tar", ".tar.bz2", ".tbz2", ".tar.zst"].some((form) =>
        lowerName.endsWith(form),
      )
    )
  )
    return false;
  const listed: string[] = [];
  for (const value of [listing.id, listing.name])
    if (typeof value === "string") listed.push(gateNameWords(value).join(""));
  if (!listed.includes(other.words.join(""))) return false;
  const versionKey = (version: readonly string[]) => {
    let end = version.length;
    while (end > 1 && /^0+$/u.test(version[end - 1]!)) end--;
    return version.slice(0, end).join(" ");
  };
  for (const archive of archives) {
    const own = gateProduct(archive.name);
    if (
      !own.words.length ||
      own.words.join(" ") !== other.words.join(" ") ||
      !(
        (other.version.length === 0 &&
          (own.version.length === 0 || name.toLowerCase().endsWith(".appimage"))) ||
        (own.version.length > 0 && versionKey(own.version) === versionKey(other.version))
      )
    )
      return false;
    const productJoined = own.words.join("");
    for (const player of archive.players) {
      if (!gateMachineRuns(player.machine, platform)) continue;
      let file = player.path.slice(player.path.lastIndexOf("/") + 1).toLowerCase();
      if (file.endsWith(".exe")) file = file.slice(0, -4);
      let literal = "";
      for (const character of file) if (/[a-z0-9]/u.test(character)) literal += character;
      if (literal !== productJoined) return false;
    }
  }
  return true;
}
/** Whether an archive's own name says source archive, restated: Core's role or a whole source word. */
function gateSourceNamed(artifact: ArtifactFactV2) {
  if (artifact.name_suggestion.role === "source-archive") return true;
  return artifact.name
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .some((word) => word === "source" || word === "sources" || word === "src");
}
/** Whether an archive is a source or third-party source archive, restated: see `sourceArchive`. */
function gateSource(artifact: ArtifactFactV2, repository: string) {
  // An archive whose listing shows a program is never a source archive.
  if (artifact.players.length > 0 || artifact.excluded_players.length > 0) return false;
  if (gateSourceNamed(artifact)) return true;
  const counts = artifact.listing_counts;
  if (!counts || counts.leaves < 1 || counts.source_leaves * 4 < counts.leaves * 3) return false;
  const own = gateNameWords(repository.split("/")[1] ?? "");
  return gateProduct(artifact.name).words.every((word) => !own.includes(word));
}
/** Whether an archive is vetoed by its role, flags or own name words, restated. */
function gateArchiveVetoed(artifact: ArtifactFactV2) {
  return (
    artifact.contradictory ||
    gateRoleWord(artifact.name) ||
    gateSourceNamed(artifact) ||
    artifact.role !== "desktop-game-runtime"
  );
}
/**
 * Whether an archive counts in the gate's program, package and toolchain
 * counts, restated: see `countedArchive`. A source-named archive counts
 * when it holds players, whatever its contradiction flag.
 */
function gateCounted(artifact: ArtifactFactV2) {
  if (
    artifact.role !== "desktop-game-runtime" ||
    artifact.source.kind !== "exact-release-structured" ||
    gateRoleWord(artifact.name)
  )
    return false;
  return gateSourceNamed(artifact) ? artifact.players.length > 0 : !artifact.contradictory;
}
/** Whether a program's file name names a launcher, loader, settings or setup step, restated. */
export function gateLauncher(path: string) {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return gateNameWords(file).some((word) =>
    [
      "launcher",
      "launch",
      "start",
      "loader",
      "settings",
      "config",
      "cfg",
      "configure",
      "setup",
      "install",
      "installer",
    ].includes(word),
  );
}
/**
 * Whether a program's file name or any folder it sits in names another role
 * than the game, restated: see `programRoleWord`. Exported for its unit
 * table only.
 */
export function gateRoleProgram(path: string, names: readonly string[] = []) {
  const roles = [
    "debug",
    "dedicated",
    "headless",
    "server",
    "tools",
    "editor",
    "sdk",
    "demo",
    "dbg",
    "srv",
    "ded",
    "trial",
    "shareware",
    "test",
  ];
  if (
    path.split("/").some((segment) => gateNameWords(segment).some((word) => roles.includes(word)))
  )
    return true;
  // Glued or in capitals: the literal file name is a name with a role word
  // before or after it, or with a trailing `d`.
  let file = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (file.endsWith(".exe")) file = file.slice(0, -4);
  let literal = "";
  for (const character of file) if (/[a-z0-9]/u.test(character)) literal += character;
  for (const name of names) {
    if (name === "") continue;
    if (literal === name + "d") return true;
    for (const role of roles) if (literal === name + role || literal === role + name) return true;
  }
  return false;
}
/** Whether a name holds a character outside ASCII, restated. Exported for its unit table only. */
export function gateNonAscii(name: string) {
  for (let index = 0; index < name.length; index++) if (name.charCodeAt(index) > 0x7f) return true;
  return false;
}
/** The listing's id, name, original title and repository name, each as whole words joined. */
function gateJoinedNames(listing: Record<string, unknown>, repository: string) {
  return gateNameLists(listing, repository).map((words) => words.join(""));
}
/**
 * The listing's id and name and the repository name as whole words,
 * restated: see `accountNames`. The original game's title is not one.
 */
function gateNameLists(listing: Record<string, unknown>, repository: string) {
  const lists: string[][] = [];
  for (const value of [listing.id, listing.name, repository.split("/")[1]])
    if (typeof value === "string") {
      const words = gateNameWords(value);
      if (words.length > 0) lists.push(words);
    }
  return lists;
}
/** The neutral archive words, restated: see `neutralArchiveWords`. */
const gateNeutral = [
  ...gateTargets.filter((word) => word !== "32bit" && word !== "64bit"),
  "64bit",
  "32bit",
  "universal2",
  "portable",
  "release",
  "appimage",
];
/** The port-descriptor and region words, restated: see `portDescriptorWords`, `regionDescriptorWords`. */
const gateDescriptors = [
  "recomp",
  "recompiled",
  "recompilation",
  "decomp",
  "decompiled",
  "port",
  "pc",
  "native",
  "static",
  "unofficial",
  "usa",
  "ntsc",
  "pal",
];
/** The words that never count as distinctive, restated: see `nonDistinctiveWords`. */
const gateUndistinctive = [
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "from",
  "by",
  "vs",
  "versus",
  "de",
  "la",
  "le",
  "el",
  "les",
  "los",
  "das",
  "der",
  "die",
  "no",
  "game",
  "games",
  "edition",
  "collection",
  "series",
  "remake",
  "remaster",
  "remastered",
  "version",
  "project",
  "engine",
  "source",
  "sdl",
  "original",
  "classic",
  "complete",
  "definitive",
  "deluxe",
  "ultimate",
  "special",
  "anniversary",
  "trilogy",
  "episode",
  "part",
  "chapter",
  "vol",
  "volume",
  "hd",
  "xbox",
  "playstation",
  "ps",
  "ps1",
  "ps2",
  "ps3",
  "ps4",
  "psx",
  "psp",
  "vita",
  "nintendo",
  "n64",
  "gamecube",
  "gc",
  "wii",
  "wiiu",
  "switch",
  "ds",
  "nds",
  "gba",
  "gb",
  "gbc",
  "snes",
  "nes",
  "sfc",
  "famicom",
  "genesis",
  "megadrive",
  "dreamcast",
  "saturn",
  "sega",
  "sony",
  "arcade",
  "dos",
  "console",
];
/** Whether a word can be the distinctive word a partial name keeps, restated. */
function gateDistinctive(word: string) {
  if (word.length < 2 || /^\d+$/u.test(word)) return false;
  return (
    !gateUndistinctive.includes(word) &&
    !gateNeutral.includes(word) &&
    !gateDescriptors.includes(word)
  );
}
/** The words that are never an initialism, restated: see `initialismVetoWords`. Exported for its unit table only. */
export const gateInitialismVeto = [
  "32",
  "32bit",
  "3ds",
  "64",
  "64bit",
  "86",
  "aarch64",
  "alpha",
  "amd64",
  "android",
  "androidtv",
  "app",
  "appimage",
  "arm",
  "arm64",
  "assets",
  "auto",
  "autobuild",
  "beta",
  "bin",
  "bit",
  "build",
  "builds",
  "canary",
  "cd",
  "ce",
  "cfg",
  "ci",
  "classic",
  "cli",
  "config",
  "configure",
  "console",
  "contents",
  "continuous",
  "daily",
  "darwin",
  "data",
  "dbg",
  "debug",
  "deck",
  "decomp",
  "decompiled",
  "ded",
  "dedicated",
  "delta",
  "demo",
  "dev",
  "devel",
  "develop",
  "development",
  "dvd",
  "dx",
  "edge",
  "editor",
  "ex",
  "exe",
  "experimental",
  "extended",
  "fix",
  "fixed",
  "freebsd",
  "game",
  "haiku",
  "hd",
  "head",
  "headless",
  "hotfix",
  "i386",
  "i686",
  "incremental",
  "install",
  "installer",
  "ios",
  "ipad",
  "ipados",
  "iphone",
  "latest",
  "launch",
  "launcher",
  "le",
  "linux",
  "linux32",
  "linux64",
  "lite",
  "loader",
  "mac",
  "macos",
  "main",
  "master",
  "mod",
  "mods",
  "mp",
  "native",
  "nds",
  "netbsd",
  "new",
  "nightlies",
  "nightly",
  "ntsc",
  "openbsd",
  "osx",
  "pal",
  "patch",
  "pc",
  "port",
  "portable",
  "portmaster",
  "pre",
  "prealpha",
  "prerelease",
  "preview",
  "ps3",
  "ps4",
  "ps5",
  "psp",
  "psvita",
  "rc",
  "re",
  "recomp",
  "recompilation",
  "recompiled",
  "rel",
  "release",
  "releases",
  "remaster",
  "remastered",
  "rev",
  "revision",
  "sd",
  "sdk",
  "se",
  "server",
  "settings",
  "setup",
  "shareware",
  "snapshot",
  "source",
  "sources",
  "sp",
  "src",
  "srv",
  "stable",
  "start",
  "static",
  "switch",
  "symbols",
  "test",
  "tester",
  "testing",
  "tool",
  "tools",
  "trial",
  "trunk",
  "tvos",
  "uhd",
  "uni",
  "universal",
  "universal2",
  "unofficial",
  "unstable",
  "update",
  "updater",
  "usa",
  "ver",
  "version",
  "visionos",
  "vita",
  "vr",
  "watchos",
  "weekly",
  "wii",
  "wiiu",
  "win",
  "win32",
  "win64",
  "windows",
  "wip",
  "x64",
  "x86",
  "x8664",
  "x86_64",
  "xbox",
  "xl",
];
/** One word of an accepted name for the reliefs, restated: see `NameFormWord`. */
interface GateFormWord {
  text: string;
  digits: boolean;
  descriptor: boolean;
  linked: boolean;
  glued: boolean;
  possessive: boolean;
  capitals: boolean;
}
/** An accepted name's words with their links, restated: see `nameForm`. */
function gateForm(value: string): GateFormWord[] {
  const words: GateFormWord[] = [];
  let index = 0;
  let separator = "";
  while (index < value.length) {
    if (!/[A-Za-z0-9]/u.test(value[index]!)) {
      separator += value[index]!;
      index++;
      continue;
    }
    let chunkEnd = index;
    while (chunkEnd < value.length && /[A-Za-z0-9]/u.test(value[chunkEnd]!)) chunkEnd++;
    const chunk = value.slice(index, chunkEnd);
    // The same humps as `gateNameWords`, keeping the original letters.
    const pieces: string[] = [];
    let current = "";
    for (let at = 0; at < chunk.length; at++) {
      const character = chunk[at]!;
      const before = chunk[at - 1] ?? "";
      const after = chunk[at + 1] ?? "";
      const isUpper = /[A-Z]/u.test(character);
      const isDigit = /\d/u.test(character);
      const beforeDigit = /\d/u.test(before);
      const cut =
        current !== "" &&
        ((/[a-z]/u.test(before) && isUpper) ||
          (/[A-Z]/u.test(before) && isUpper && /[a-z]/u.test(after)) ||
          (beforeDigit && !isDigit) ||
          (!beforeDigit && isDigit));
      if (cut) {
        pieces.push(current);
        current = "";
      }
      current += character;
    }
    if (current) pieces.push(current);
    for (let at = 0; at < pieces.length; at++) {
      const text = pieces[at]!.toLowerCase();
      words.push({
        text,
        digits: /^\d+$/u.test(text),
        descriptor: gateDescriptors.includes(text),
        linked: words.length > 0 && (at > 0 || /^[ ._-]+$/u.test(separator)),
        glued: at > 0,
        possessive: at === 0 && text === "s" && (separator === "'" || separator === "’"),
        capitals: /^[A-Z]{2,5}$/u.test(pieces[at]!),
      });
    }
    separator = "";
    index = chunkEnd;
  }
  return words;
}
/**
 * The outcomes of spelling a literal as an ordered subsequence of a name's
 * words with descriptors anywhere, restated: see `subsequenceMasks`. Each
 * outcome is a string of flags: `o` a word omitted, `d` a distinctive word
 * kept, `k` a word kept, `x` a descriptor spelled, and, only when lenient,
 * `n` a linked number dropped (a digit run of the literal may then also
 * stand for no word).
 */
function gateSubsequence(
  literal: string,
  digitStarts: ReadonlyMap<number, number>,
  form: readonly GateFormWord[],
  lenient = false,
): string[] {
  const memo = new Map<string, string[]>();
  const flags = (...parts: string[]) =>
    ["o", "d", "k", "x", "n"].filter((flag) => parts.some((part) => part.includes(flag))).join("");
  const walk = (at: number, word: number, keptBefore: boolean): string[] => {
    const key = `${at}/${word}/${keptBefore}`;
    if (memo.has(key)) return memo.get(key)!;
    const out = new Set<string>();
    memo.set(key, []);
    if (at === literal.length && word === form.length) out.add("");
    if (lenient && digitStarts.has(at))
      for (const rest of walk(at + digitStarts.get(at)!, word, keptBefore)) out.add(rest);
    for (const descriptor of gateDescriptors)
      if (literal.slice(at, at + descriptor.length) === descriptor)
        for (const rest of walk(at + descriptor.length, word, keptBefore))
          out.add(flags(rest, "x"));
    const current = form[word];
    if (current !== undefined) {
      const prior = form[word - 1];
      if (current.descriptor) for (const rest of walk(at, word + 1, false)) out.add(rest);
      else {
        let spells = literal.slice(at, at + current.text.length) === current.text;
        if (current.digits) spells &&= digitStarts.get(at) === current.text.length;
        const leavesNumber =
          !current.digits &&
          current.linked &&
          prior !== undefined &&
          prior.digits &&
          !prior.descriptor &&
          !keptBefore;
        if (spells && (lenient || !leavesNumber))
          for (const rest of walk(at + current.text.length, word + 1, true))
            out.add(
              flags(rest, "k", gateDistinctive(current.text) ? "d" : "", leavesNumber ? "n" : ""),
            );
        const dropsNumber =
          current.digits && current.linked && prior !== undefined && !prior.digits && keptBefore;
        if (lenient || !dropsNumber)
          for (const rest of walk(at, word + 1, false))
            out.add(flags(rest, "o", dropsNumber ? "n" : ""));
      }
    }
    const result = [...out];
    memo.set(key, result);
    return result;
  };
  return walk(0, 0, false);
}
/**
 * Whether a relieved literal drops a number one of the listing's accepted
 * names links to a word it keeps, restated: see `dropsLinkedNumber`.
 */
function gateDropsNumber(
  literal: string,
  digitStarts: ReadonlyMap<number, number>,
  raws: readonly string[],
): boolean {
  return gateDropsNumberForms(literal, digitStarts, raws.map(gateForm));
}
function gateDropsNumberForms(
  literal: string,
  digitStarts: ReadonlyMap<number, number>,
  forms: readonly GateFormWord[][],
): boolean {
  const acceptable = (outcome: string) =>
    outcome.includes("k") && (!outcome.includes("o") || outcome.includes("d"));
  for (const form of forms) {
    if (gateSubsequence(literal, digitStarts, form).some(acceptable)) continue;
    if (
      gateSubsequence(literal, digitStarts, form, true).some(
        (outcome) => acceptable(outcome) && outcome.includes("n"),
      )
    )
      return true;
  }
  return false;
}
/** Whether a literal is made only of descriptor words, restated. */
function gateDescriptorsOnly(literal: string): boolean {
  if (literal === "") return true;
  return gateDescriptors.some(
    (descriptor) =>
      literal.startsWith(descriptor) && gateDescriptorsOnly(literal.slice(descriptor.length)),
  );
}
/** The initialisms of a name, restated: see `nameInitialisms`. */
function gateInitialisms(form: readonly GateFormWord[]): string[] {
  const total = form.filter((word) => !word.descriptor && !word.possessive).length;
  const found: string[] = [];
  let first = 0;
  while (first < form.length && form[first]!.descriptor) first++;
  let spellings = [""];
  let used = 0;
  let distinct = false;
  for (let index = first; index < form.length; index++) {
    const word = form[index]!;
    if (word.descriptor) break;
    if (word.possessive) continue;
    let initials = [word.text.slice(0, 1)];
    if (word.digits) initials = [word.text];
    else if (word.capitals) initials = [word.text.slice(0, 1), word.text];
    const grown: string[] = [];
    for (const spelling of spellings)
      for (const initial of initials)
        if ((spelling + initial).length <= 12 && !grown.includes(spelling + initial))
          grown.push(spelling + initial);
    spellings = grown;
    used += 1;
    if (gateDistinctive(word.text)) distinct = true;
    const next = form[index + 1];
    if (next && !next.descriptor && (next.glued || (next.digits && next.linked))) continue;
    if (used < 2 || used * 2 <= total || !distinct) continue;
    for (const spelling of spellings) {
      const letters = spelling.replace(/\d/gu, "");
      if (letters.length < 2 || letters.length > 6) continue;
      if (
        gateInitialismVeto.includes(spelling) ||
        gateInitialismVeto.includes(spelling.replace(/\d+$/u, ""))
      )
        continue;
      if (!found.includes(spelling)) found.push(spelling);
    }
  }
  return found;
}
/**
 * Whether a literal spells a name under the reliefs, restated: see
 * `reliefSpelling`. Exported for its unit table only.
 */
export function gateRelief(
  literal: string,
  digitStarts: ReadonlyMap<number, number>,
  form: readonly GateFormWord[],
): boolean {
  if (literal === "") return false;
  for (const outcome of gateSubsequence(literal, digitStarts, form)) {
    if (!outcome.includes("k")) continue;
    if (!outcome.includes("o")) return true;
    if (outcome.includes("d")) return true;
  }
  for (const initialism of gateInitialisms(form)) {
    let at = literal.indexOf(initialism);
    while (at >= 0) {
      const head = literal.slice(0, at);
      const tail = literal.slice(at + initialism.length);
      if (gateDescriptorsOnly(head) && gateDescriptorsOnly(tail)) return true;
      at = literal.indexOf(initialism, at + 1);
    }
  }
  return false;
}
/** A literal's digit runs, start to length, restated. */
function gateDigitStarts(literal: string) {
  const starts = new Map<number, number>();
  let index = 0;
  while (index < literal.length) {
    if (!/\d/u.test(literal[index]!)) {
      index++;
      continue;
    }
    let end = index;
    while (end < literal.length && /\d/u.test(literal[end]!)) end++;
    starts.set(index, end - index);
    index = end;
  }
  return starts;
}
/**
 * Whether a relieved literal spells the complete accepted name (id, name or
 * GitHub repository name, modulo descriptors) of another listing, restated:
 * see `otherListingsSpelled`.
 */
function gateSpellsAnotherListing(
  literal: string,
  digitStarts: ReadonlyMap<number, number>,
  listings: readonly Record<string, unknown>[],
  ownId: unknown,
): boolean {
  for (const listing of listings) {
    if (listing.id === ownId) continue;
    const repository = gateProviderRepository(listing);
    for (const raw of [listing.id, listing.name, repository?.split("/")[1]]) {
      if (typeof raw !== "string") continue;
      const form = gateForm(raw);
      if (!form.length) continue;
      if (
        gateSubsequence(literal, digitStarts, form).some(
          (outcome) => outcome.includes("k") && !outcome.includes("o"),
        )
      )
        return true;
    }
  }
  return false;
}
/**
 * A name base with its build identifiers marked, restated: see
 * `buildIdentifiers`. A `V`-glued dotted version after a letter and a dotted
 * version with one glued patch letter (not `a`, `b` or `r`) become the build
 * chunk; a prerelease marker glued to a dotted version stands apart after it.
 */
function gateBuildMarks(base: string): string {
  let marked = base.replace(/([A-Za-z])[vV]\d+(\.\d+)+(?=$|[^A-Za-z0-9])/gu, "$1-vbuild0-");
  marked = marked.replace(
    /(^|[^A-Za-z0-9.])[vVrR]?\d+(\.\d+)+(alpha|beta|pre|rc|a|b|r)(\d*)(?=$|[^A-Za-z0-9])/giu,
    "$1-v0-$3$4-",
  );
  return marked.replace(
    /(^|[^A-Za-z0-9.])[vVrR]?\d+(\.\d+)+[c-qs-zC-QS-Z](?=$|[^A-Za-z0-9])/gu,
    "$1-vbuild0-",
  );
}
/**
 * A name base's tokens for the archive grammar, restated: see
 * `archiveNameTokens`. Build identifiers and dotted versions are marked
 * first; a build chunk, neutral chunk, `v<N>` or `r<N>` is a `version` or
 * `neutral` boundary, digits alone an `integer`, and every other chunk's
 * words are `neutral` or `word`; `uni` directly beside a macOS word is
 * `neutral`.
 */
function gateGrammarTokens(base: string) {
  let marked = gateBuildMarks(base);
  marked = marked.replace(/(^|[^A-Za-z0-9.])[vVrR]?\d+(\.\d+)+(?=$|[^A-Za-z0-9])/gu, "$1-v0-");
  const tokens: { text: string; kind: "word" | "integer" | "boundary" }[] = [];
  for (const chunk of marked.split(/[^A-Za-z0-9]+/u)) {
    if (chunk === "") continue;
    const low = chunk.toLowerCase();
    if (gateBuildChunk(low) || gateNeutral.includes(low) || /^[vr]\d+$/u.test(low))
      tokens.push({ text: low, kind: "boundary" });
    else if (/^\d+$/u.test(low)) tokens.push({ text: low, kind: "integer" });
    else
      for (const word of gateNameWords(chunk))
        tokens.push({ text: word, kind: gateNeutral.includes(word) ? "boundary" : "word" });
  }
  const apple = ["macos", "mac", "osx", "darwin"];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "word" || token.text !== "uni") continue;
    if (
      apple.includes(tokens[index - 1]?.text ?? "") ||
      apple.includes(tokens[index + 1]?.text ?? "")
    )
      token.kind = "boundary";
  }
  return tokens;
}
/** Whether a chunk is a commit hash or the build chunk, restated: see `hashToken`. */
function gateBuildChunk(low: string) {
  if (low === "vbuild0") return true;
  return (
    low.length >= 7 &&
    low.length <= 40 &&
    /^[0-9a-f]+$/u.test(low) &&
    /\d/u.test(low) &&
    /[a-f]/u.test(low)
  );
}
/**
 * How an archive name is accounted for against the listing, restated: see
 * `archiveNameAccount`. Only whether it is accounted, and the joined product,
 * matter to the gate: the joined name for an exact spelling, the archive's own
 * product for a relieved one. A relieved product that spells another
 * listing's complete name (`listings`) is not accounted. Exported for its unit
 * table only.
 */
export function gateArchiveAccount(
  name: string,
  listing: Record<string, unknown>,
  repository: string,
  listings: readonly Record<string, unknown>[] = [],
): string | null {
  // PRODUCT (VERSION | NEUTRAL | DESCRIPTOR)*: the product is the leading run
  // of words and integers; after it, no other word may appear, and integers
  // are versions.
  const product: { word: string; integer: boolean }[] = [];
  let productEnded = false;
  for (const token of gateGrammarTokens(gateNameBase(name))) {
    if (token.kind === "boundary") {
      productEnded = true;
      continue;
    }
    if (!productEnded) {
      product.push({ word: token.text, integer: token.kind === "integer" });
      continue;
    }
    // After the product only a date or build number, or a descriptor, may stand.
    if (token.kind === "integer" ? token.text.length < 4 : !gateDescriptors.includes(token.text))
      return null;
  }
  // The whole product, or cut at a long integer followed only by integers.
  const cuts = [product.length];
  for (let index = 0; index < product.length; index++) {
    const rest = product.slice(index);
    if (
      product[index]!.integer &&
      product[index]!.word.length >= 4 &&
      rest.every((t) => t.integer && t.word.length >= 4)
    )
      cuts.push(index);
  }
  for (const cut of cuts) {
    const kept = product.slice(0, cut);
    if (kept.length === 0) continue;
    for (const words of gateNameLists(listing, repository)) {
      // The same letters, with each integer exactly one word of the name.
      if (kept.map((token) => token.word).join("") !== words.join("")) continue;
      let position = 0;
      let wordAt = 0;
      let wordStart = 0;
      let aligned = true;
      for (const token of kept) {
        while (wordAt < words.length && wordStart + words[wordAt]!.length <= position) {
          wordStart += words[wordAt]!.length;
          wordAt++;
        }
        if (token.integer && !(wordStart === position && words[wordAt] === token.word))
          aligned = false;
        position += token.word.length;
      }
      if (aligned) return words.join("");
    }
  }
  // The reliefs on the same cuts: the archive's own product, when it spells
  // an accepted name under them and no other listing's complete name.
  const raws = [listing.id, listing.name, repository.split("/")[1]].filter(
    (value): value is string => typeof value === "string",
  );
  for (const cut of cuts) {
    const kept = product.slice(0, cut);
    if (kept.length === 0) continue;
    let literal = "";
    const digitStarts = new Map<number, number>();
    for (const token of kept) {
      if (/^\d+$/u.test(token.word)) digitStarts.set(literal.length, token.word.length);
      literal += token.word;
    }
    if (!raws.some((raw) => gateRelief(literal, digitStarts, gateForm(raw)))) continue;
    if (gateDropsNumber(literal, digitStarts, raws)) continue;
    if (gateSpellsAnotherListing(literal, digitStarts, listings, listing.id)) return null;
    return literal;
  }
  return null;
}
/** The raw names a program or folder may spell under the reliefs, restated: see `reliefForms`. */
function gateReliefForms(listing: Record<string, unknown>, repository: string, product: string) {
  const forms: string[] = [];
  for (const value of [listing.id, listing.name, repository.split("/")[1], product])
    if (typeof value === "string" && value !== "") forms.push(value);
  return forms;
}
/** The words a program's folders may use besides neutral, layout and version words, restated. */
function gateAccountWords(archive: string, listing: Record<string, unknown>, repository: string) {
  return [...gateNameWords(archive), ...gateNameLists(listing, repository).flat()];
}
/**
 * Whether a folder segment is the accepted product, versions and neutral
 * words, restated: see `folderSpellsProduct`.
 */
function gateFolderProduct(
  segment: string,
  names: readonly string[],
  forms: readonly GateFormWord[][],
): boolean {
  if (forms.length === 0) return false;
  let literal = "";
  const digitStarts = new Map<number, number>();
  let ended = false;
  for (const token of gateGrammarTokens(gateNameBase(`${segment}.zip`))) {
    if (token.kind === "boundary") {
      ended = true;
      continue;
    }
    if (ended) {
      if (token.kind === "integer" ? token.text.length < 4 : !gateDescriptors.includes(token.text))
        return false;
      continue;
    }
    if (/^\d+$/u.test(token.text)) digitStarts.set(literal.length, token.text.length);
    literal += token.text;
  }
  if (literal === "") return false;
  if (names.includes(literal)) return true;
  if (gateDropsNumberForms(literal, digitStarts, forms)) return false;
  return forms.some((form) => gateRelief(literal, digitStarts, form));
}
/**
 * Whether a program is accounted for, restated: see `programNameUnaccounted`.
 * Beside no other package form, the literal name (before architecture words)
 * may also spell one of `forms` (the listing's id and name, the repository
 * name and the accepted archive product) under the reliefs, and a folder may
 * be the accepted product, versions and neutral words. Exported for its unit
 * table only.
 */
export function gateProgramAccounted(
  path: string,
  names: readonly string[],
  words: readonly string[],
  strict: boolean,
  forms: readonly string[] = [],
): boolean {
  const parsedForms = forms.map(gateForm).filter((form) => form.length > 0);
  let file = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (file.endsWith(".exe")) file = file.slice(0, -4);
  let literal = "";
  for (const character of file) if (/[a-z0-9]/u.test(character)) literal += character;
  const architecture = [
    "x86",
    "x64",
    "x8664",
    "amd64",
    "arm64",
    "aarch64",
    "i386",
    "i686",
    "64bit",
    "32bit",
    "win32",
    "win64",
    "universal",
    "universal2",
  ];
  // Whether a rest is a run of architecture words, tried left to right.
  const architectureRun = (rest: string): boolean => {
    if (rest === "") return true;
    for (const word of architecture)
      if (rest.startsWith(word) && architectureRun(rest.slice(word.length))) return true;
    return false;
  };
  let named = names.includes(literal);
  if (!named && !strict)
    named = names.some(
      (name) =>
        name !== "" && literal.startsWith(name) && architectureRun(literal.slice(name.length)),
    );
  if (!named && !strict)
    for (let end = 1; end <= literal.length && !named; end++) {
      if (!architectureRun(literal.slice(end))) continue;
      const core = literal.slice(0, end);
      if (gateDropsNumberForms(core, gateDigitStarts(core), parsedForms)) continue;
      named = parsedForms.some((form) => gateRelief(core, gateDigitStarts(core), form));
    }
  if (!named) return false;
  const layout = ["bin", "game", "app", "contents", "x64", "win64"];
  const segments = path.split("/");
  segments.pop();
  const known = (word: string) =>
    words.includes(word) || gateNeutral.includes(word) || layout.includes(word);
  const segmentKnown = (segment: string): boolean => {
    let normalized = segment.replace(/(?<![A-Za-z0-9])x86[_-]64(?![A-Za-z0-9])/giu, "x8664");
    normalized = normalized.replace(
      /(^|[^A-Za-z0-9.])[vVrR]?\d+(\.\d+)+(?=$|[^A-Za-z0-9])/gu,
      "$1-v0-",
    );
    let spelled = "";
    let afterBoundary = false;
    for (const chunk of normalized.split(/[^A-Za-z0-9]+/u)) {
      const low = chunk.toLowerCase();
      if (low === "") continue;
      // Versions: `v<N>`, `r<N>`, four or more digits.
      if (/^[vr]\d+$/u.test(low) || /^\d{4,}$/u.test(low)) {
        afterBoundary = true;
        continue;
      }
      if (gateNeutral.includes(low)) afterBoundary = true;
      if (/^\d{1,3}$/u.test(low)) {
        // A product number directly after the segment's product words.
        if (afterBoundary || !names.includes(spelled + low)) return false;
        spelled += low;
        continue;
      }
      if (known(low) || names.includes(low)) {
        spelled += low;
        continue;
      }
      const parts = gateNameWords(chunk);
      for (const word of parts) if (/^\d+$/u.test(word) || !known(word)) return false;
      spelled += parts.join("");
    }
    return true;
  };
  for (const segment of segments)
    if (!segmentKnown(segment) && !gateFolderProduct(segment, names, parsedForms)) return false;
  return true;
}
/**
 * The GitHub repository a listing's provider identity names, restated: see
 * `listingProviderIdentity`. The release URL comes first, else the project
 * URL; HTTPS on `github.com` only, with no user, password, port, query or
 * fragment; the path is `/<owner>/<name>`, an optional `.git`, an optional
 * `/releases` subpath and an optional trailing slash. Anything else names
 * none. Exported for its unit table only.
 */
export function gateProviderRepository(listing: Record<string, unknown>): string | null {
  const raw = typeof listing.release_url === "string" ? listing.release_url : listing.project_url;
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  const parts = url.pathname.split("/");
  // `/owner/name`, then optionally `releases` and anything below it.
  if (parts[0] !== "" || parts.length < 3) return null;
  const owner = parts[1]!;
  let name = parts[2]!;
  const rest = parts.slice(3);
  if (rest.length > 0 && !(rest.length === 1 && rest[0] === "") && rest[0] !== "releases")
    return null;
  const part = /^[A-Za-z0-9_.-]+$/u;
  // One `.git` is dropped unless nothing would be left of the name.
  if (name.endsWith(".git") && name.length > 4) name = name.slice(0, -4);
  if (!part.test(owner) || !part.test(name) || [owner, name].some((p) => p === "." || p === ".."))
    return null;
  return `${owner}/${name}`;
}
/** Whether a record runs on the ScummVM engine, restated from its declared runtime. */
function gateScummvm(record: AuthoredPort) {
  const implementation = (record.listing as Record<string, unknown>).implementation;
  if (!isRecord(implementation) || !Array.isArray(implementation.dependencies)) return false;
  for (const dependency of implementation.dependencies) {
    if (!isRecord(dependency) || dependency.kind !== "runtime") continue;
    if (typeof dependency.project_url !== "string") continue;
    let url: URL;
    try {
      url = new URL(dependency.project_url);
    } catch {
      continue;
    }
    let path = url.pathname.toLowerCase();
    while (path.endsWith("/")) path = path.slice(0, -1);
    if (path.endsWith(".git")) path = path.slice(0, -4);
    if (url.hostname.toLowerCase() === "github.com" && path === "/scummvm/scummvm") return true;
  }
  return false;
}

/** Problems with one enrollment, judged against its facts entry and listing only. */
function gateEnrollmentProblems(
  enrollment: GeneratedEnrollment,
  entry: ListingFactsEntry | undefined,
  generatedAt: string,
  listings: readonly Record<string, unknown>[],
  records: readonly AuthoredPort[],
): string[] {
  const id = enrollment.port_id;
  if (!entry) return [`${id} has no facts entry.`];
  const problems: string[] = [];
  // The listing-level withholds, restated: one runtime owner, an engine
  // onboarded elsewhere, an available GitHub upstream that is the listing's
  // own, and facts from the current parser.
  const record = records.find((candidate) => candidate.listing.id === id);
  if (!record) problems.push(`${id} has no catalog record.`);
  else {
    if (record.integration !== undefined || record.route_facts_v1 !== undefined)
      problems.push(`${id} already has an operational route; it has one runtime owner.`);
    if (gateScummvm(record)) problems.push(`${id} runs on the ScummVM engine.`);
    const availability = (record.listing as Record<string, unknown>).availability;
    if (availability === "source-only" || availability === "unavailable")
      problems.push(`${id} has upstream availability ${String(availability)}.`);
  }
  // The repository is the one the listing's provider identity names: the
  // release URL first, else the project URL, a GitHub repository only.
  const ownListing = listings.find((listing) => listing.id === id) ?? {};
  const providerRepository = gateProviderRepository(ownListing);
  if (entry.provider !== "github" || providerRepository === null)
    problems.push(`${id} names no GitHub repository.`);
  else if (providerRepository.toLowerCase() !== entry.repository.toLowerCase())
    problems.push(`${id} rests on facts of a repository its listing does not name.`);
  if (entry.parser !== "listing-package-facts" || entry.parser_version !== FACTS_PARSER_VERSION)
    problems.push(`${id} rests on facts of another parser version.`);
  // A name with characters outside ASCII can imitate another name.
  for (const candidate of entry.artifacts) {
    const named = [candidate.name, ...candidate.players.map((player) => player.display_path)];
    const foreign = named.find(gateNonAscii);
    if (foreign !== undefined)
      problems.push(`${id} rests on a release with a name outside ASCII (${foreign}).`);
  }
  // One product per release: no other identity names the repository unless
  // the listing binds this one to a line of its own, the offered release is on
  // that line, the releases form one line or the listing names it, and no newer
  // prerelease of another line follows the offered release.
  const own = listings.find((listing) => listing.id === id) ?? {};
  const bound = gateBoundLine(own);
  // Release text is judged with the listing's own words: facts judged with
  // other words are not this listing's.
  const ownWords = gateListingWords(own);
  // Beside another package form (recorded, or classified by the gate from
  // the recorded asset names) a program name stays strictly literal.
  const strict =
    entry.other_packages.length > 0 ||
    (Array.isArray(entry.asset_names) ? entry.asset_names : []).some(
      (name) => gateFormKind(name) !== undefined,
    );
  if (!Array.isArray(entry.listing_words) || entry.listing_words.join(" ") !== ownWords.join(" "))
    problems.push(`${id} rests on facts that judged release text with other listing words.`);
  const repository = entry.repository.toLowerCase();
  const others = listings.filter(
    (listing) => listing.id !== id && gateRepositories(listing).has(repository),
  );
  if (others.length && (bound === null || others.some((other) => gateBoundLine(other) === bound)))
    problems.push(`${id} shares its repository with another identity and no line of its own.`);
  const offered = entry.observed_releases.find(
    (release) => release.release_id === enrollment.release.id,
  );
  if (
    !offered ||
    offered.prerelease !== false ||
    gateChannelOnlyTag(offered.tag) ||
    gateStates(offered, entry.repository, ownWords)
  )
    problems.push(`${id} offers a release its facts do not record as stable.`);
  else {
    const line = gateLine(offered.tag, offered.release_id, entry.repository);
    const lines = new Set([line]);
    // Lines over stable packaged releases (and unknown verdicts) only.
    for (const release of entry.observed_releases)
      if (
        release.packaged &&
        (release.prerelease === null ||
          (release.prerelease === false &&
            !gateChannelOnlyTag(release.tag) &&
            !gateStates(release, entry.repository, ownWords)))
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
        (release.prerelease !== false ||
          gateChannelOnlyTag(release.tag) ||
          gateStates(release, entry.repository, ownWords)) &&
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
  // Every other asset name the facts record is classified by the gate's own
  // classifier: a form the gate sees that the worker did not record competes
  // with an unknown digest on every platform its kind can serve.
  const competing: { name: string; sha256: unknown; platforms: unknown }[] = [
    ...entry.other_packages,
  ];
  for (const name of Array.isArray(entry.asset_names) ? entry.asset_names : []) {
    const kind = gateFormKind(name);
    if (kind === undefined || entry.other_packages.some((other) => other.name === name)) continue;
    competing.push({
      name,
      sha256: null,
      platforms: kind === "container" ? Object.keys(gateMachines) : gateFormPlatforms(name),
    });
  }
  for (const other of competing) {
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
          ) &&
          !gateSource(candidate, entry.repository),
      );
      if (!offered.length) continue;
      const digests = offered.flatMap((candidate) =>
        candidate.players
          .filter((player) => gateMachineRuns(player.machine, platform))
          .map((player) => player.sha256),
      );
      // The same product and version in another package form is no
      // competitor: its name agrees with every archive that could be offered.
      const offerable = offered.filter(
        (candidate) =>
          candidate.source.kind === "exact-release-structured" &&
          !gateArchiveVetoed(candidate) &&
          candidate.players.some((player) => gateMachineRuns(player.machine, platform)),
      );
      if (
        (typeof other.sha256 !== "string" || !digests.includes(other.sha256)) &&
        !gateSameProduct(other.name, offerable, platform, own)
      )
        problems.push(
          `${id} rests on a release that also ships another package for ${platform} (${other.name}) beside an archive offered for it.`,
        );
    }
  }
  // A toolchain in any archive that could be the game is a property of the
  // project: no platform enrolls beside it.
  for (const candidate of entry.artifacts) {
    if (!gateCounted(candidate) || gateSource(candidate, entry.repository)) continue;
    const permitsSome = Object.values(gateMachines).some(
      (host) =>
        ["unknown", host.os].includes(candidate.name_suggestion.os) &&
        ["unknown", host.arch, ...(host.os === "macos" ? ["universal"] : [])].includes(
          candidate.name_suggestion.arch,
        ),
    );
    if (!permitsSome) continue;
    const helpers = new Set<string>();
    for (const recorded of Array.isArray(candidate.toolchain_names)
      ? candidate.toolchain_names
      : []) {
      const helper = gateHelper(recorded);
      if (helper === null) continue;
      if (recorded.endsWith("/") && gateToolchain.fileOnly.includes(helper)) continue;
      helpers.add(helper);
    }
    if (helpers.size)
      problems.push(
        `${id} rests on a release whose archive ${candidate.name} bundles ${[...helpers].toSorted().join(", ")}.`,
      );
  }
  // A program named, or in a folder named, for another role (debug, server,
  // tools, editor, SDK, demo) in any archive that could be the game: no
  // platform enrolls.
  for (const candidate of entry.artifacts) {
    if (!gateCounted(candidate) || gateSource(candidate, entry.repository)) continue;
    const permitsSome = Object.values(gateMachines).some(
      (host) =>
        ["unknown", host.os].includes(candidate.name_suggestion.os) &&
        ["unknown", host.arch, ...(host.os === "macos" ? ["universal"] : [])].includes(
          candidate.name_suggestion.arch,
        ),
    );
    if (!permitsSome) continue;
    const roleNames = gateJoinedNames(own, entry.repository);
    const archiveProduct = gateProduct(candidate.name).words.join("");
    if (archiveProduct !== "") roleNames.push(archiveProduct);
    const role = candidate.players.find((player) =>
      gateRoleProgram(player.display_path, roleNames),
    );
    if (role)
      problems.push(
        `${id} rests on a release whose archive ${candidate.name} holds ${role.display_path}, named or placed for another role than the game.`,
      );
  }
  // A platform whose only program, in one archive, is named for a launcher,
  // settings or setup step withholds the whole identity, whichever platforms
  // the enrollment names: the same candidates as the one-program check below,
  // where exactly one archive (by SHA-256) holds the platform's players, they
  // are one program under one top-level directory, the archive is offerable,
  // and no refused archive's name permits the platform.
  for (const [platform, host] of Object.entries(gateMachines)) {
    const permits = (named: NameSuggestion) =>
      ["unknown", host.os].includes(named.os) &&
      ["unknown", host.arch, ...(host.os === "macos" ? ["universal"] : [])].includes(named.arch);
    if (
      entry.refused_archives.some(
        (refused) => !gateNameVetoes(refused.name_suggestion) && permits(refused.name_suggestion),
      )
    )
      continue;
    const runs = (player: PlayerFact) => gateMachineRuns(player.machine, platform);
    const holding = entry.artifacts
      .filter(
        (candidate) =>
          gateCounted(candidate) &&
          permits(candidate.name_suggestion) &&
          candidate.players.some(runs),
      )
      .toSorted((left, right) => left.asset_id - right.asset_id);
    if (new Set(holding.map((candidate) => candidate.sha256)).size !== 1) continue;
    const players = holding.flatMap((candidate) => candidate.players.filter(runs));
    if (new Set(players.map((player) => gateProgram(player.path))).size !== 1) continue;
    const topOf = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "");
    if (
      holding.some(
        (candidate) =>
          new Set(candidate.players.filter(runs).map((player) => topOf(player.path))).size > 1,
      )
    )
      continue;
    const offered = holding.at(-1)!;
    if (offered.contradictory || gateSourceNamed(offered)) continue;
    const launcher = players.find((player) => gateLauncher(player.display_path));
    if (launcher)
      problems.push(
        `${id} has a launcher, settings or setup program (${launcher.display_path.slice(launcher.display_path.lastIndexOf("/") + 1)}) as the only program on ${platform}, so no platform of the identity may enroll.`,
      );
    const part = entry.artifacts.find(
      (candidate) =>
        candidate.asset_id !== offered.asset_id &&
        candidate.players.length === 0 &&
        candidate.excluded_players.length === 0 &&
        !gateSource(candidate, entry.repository) &&
        permits(candidate.name_suggestion),
    );
    if (part)
      problems.push(
        `${id} offers ${offered.name} on ${platform} beside ${part.name}, an archive without programs that may hold the rest of the game, so no platform of the identity may enroll.`,
      );
    const accepted = gateArchiveAccount(offered.name, own, entry.repository, listings);
    if (accepted === null)
      problems.push(
        gateArchiveAccount(offered.name, own, entry.repository) === null
          ? `${id} offers ${offered.name} on ${platform}, whose name holds an unaccounted token, so no platform of the identity may enroll.`
          : `${id} offers ${offered.name} on ${platform}, whose relieved name spells another catalog listing, so no platform of the identity may enroll.`,
      );
    else if (
      players.some(
        (player) =>
          !gateProgramAccounted(
            player.display_path,
            [...gateJoinedNames(own, entry.repository), accepted],
            gateAccountWords(offered.name, own, entry.repository),
            strict,
            gateReliefForms(own, entry.repository, accepted),
          ),
      )
    )
      problems.push(
        `${id} offers ${offered.name} on ${platform}, whose program name or folder holds an unaccounted token, so no platform of the identity may enroll.`,
      );
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
  if (reference - Date.parse(entry.observation.observed_at) > gateFactsAgeDays * gateDay)
    problems.push(`${id} rests on facts older than ${gateFactsAgeDays} days.`);
  if (
    entry.attempt &&
    entry.attempt.status !== "pending-inspection" &&
    reference - Date.parse(entry.attempt.first_at) > gateRetentionDays * gateDay
  )
    problems.push(`${id} rests on last-good facts kept beyond ${gateRetentionDays} days.`);
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
      gateRoleWord(artifact.name) ||
      gateSourceNamed(artifact) ||
      gateSource(artifact, entry.repository)
    )
      problems.push(
        `${where} rests on a contradicted, role-named, source or non-runtime artifact.`,
      );
    if (runtime.players.some((player) => gateLauncher(player.display_path)))
      problems.push(`${where} offers a launcher, settings or setup program as its only player.`);
    const runtimeNames = gateJoinedNames(own, entry.repository);
    if (gateProduct(artifact.name).words.length)
      runtimeNames.push(gateProduct(artifact.name).words.join(""));
    if (runtime.players.some((player) => gateRoleProgram(player.display_path, runtimeNames)))
      problems.push(`${where} offers a program named or placed for another role than the game.`);
    // A split package: another archive without programs whose name allows
    // the platform may hold the rest of the game.
    const splitPart = entry.artifacts.find(
      (candidate) =>
        candidate.asset_id !== artifact.asset_id &&
        candidate.players.length === 0 &&
        candidate.excluded_players.length === 0 &&
        !gateSource(candidate, entry.repository) &&
        ["unknown", host.os].includes(candidate.name_suggestion.os) &&
        ["unknown", host.arch, ...(host.os === "macos" ? ["universal"] : [])].includes(
          candidate.name_suggestion.arch,
        ),
    );
    if (splitPart)
      problems.push(`${where} rests on a release that splits the game into ${splitPart.name}.`);
    const runtimeAccepted = gateArchiveAccount(artifact.name, own, entry.repository, listings);
    if (runtimeAccepted === null)
      problems.push(
        gateArchiveAccount(artifact.name, own, entry.repository) === null
          ? `${where} rests on archive ${artifact.name}, whose name holds an unaccounted token.`
          : `${where} rests on archive ${artifact.name}, whose relieved name spells another catalog listing.`,
      );
    else if (
      runtime.players.some(
        (player) =>
          !gateProgramAccounted(
            player.display_path,
            [...gateJoinedNames(own, entry.repository), runtimeAccepted],
            gateAccountWords(artifact.name, own, entry.repository),
            strict,
            gateReliefForms(own, entry.repository, runtimeAccepted),
          ),
      )
    )
      problems.push(`${where} offers a program whose name or folder holds an unaccounted token.`);
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
    // Exactly one player survives the platform selection.
    if (new Set(running.map((player) => player.path)).size > 1)
      problems.push(`${where} offers more than one player of its program; none is chosen by name.`);
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
        !gateCounted(candidate) ||
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
    // the same package (equal archive bytes), whatever the names say; none
    // bundles a toolchain; and no refused archive could be the platform's
    // game.
    const archives = new Set<string>();
    for (const candidate of entry.artifacts) {
      const candidateName = candidate.name_suggestion;
      if (
        !gateCounted(candidate) ||
        !["unknown", host.os].includes(candidateName.os) ||
        !["unknown", host.arch, ...(host.os === "macos" ? ["universal"] : [])].includes(
          candidateName.arch,
        )
      )
        continue;
      if (!candidate.players.some((player) => gateMachineRuns(player.machine, runtime.platform)))
        continue;
      // Re-derived from the recorded listing entries, not the worker's
      // summary: a helper file leaf, or a helper directory unless the helper
      // is a short folder-like name that counts only as a file.
      const helpers = new Set<string>();
      for (const recorded of Array.isArray(candidate.toolchain_names)
        ? candidate.toolchain_names
        : []) {
        const helper = gateHelper(recorded);
        if (helper === null) continue;
        if (recorded.endsWith("/") && gateToolchain.fileOnly.includes(helper)) continue;
        helpers.add(helper);
      }
      if (helpers.size)
        problems.push(
          `${where} is decided beside an archive that bundles ${[...helpers].toSorted().join(", ")}.`,
        );
      archives.add(candidate.sha256);
    }
    if (archives.size > 1)
      problems.push(
        `${where} rests on one of ${archives.size} different archives for the platform.`,
      );
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
 * restates the release-asset classifier independently (`gateFormKind`) and
 * applies it to every other asset name the facts record (`asset_names`), so
 * an asset the worker's classifier wrongly drops still competes here with an
 * unknown digest. Reproduction compares those names with the re-listed
 * release.
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
  for (const enrollment of generation.enrollments)
    problems.push(
      ...gateEnrollmentProblems(
        enrollment,
        entries.get(enrollment.port_id),
        generation.facts.generated_at,
        generation.records.map((record) => record.listing as Record<string, unknown>),
        generation.authored,
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
 * The deadline, in minutes, of one CI reproduction shard: the repository's
 * 120-minute CI job cap (`ci-workflow.test.mts`) less the shard's other
 * steps. It binds every path that reproduces facts: pull-request CI and the
 * batch job's own reproduction use it, and the facts worker never settles an
 * identity whose inspection would not fit it (`identityBudgetMinutes`).
 */
export const reproductionDeadlineMinutes = 85;
/**
 * The built-in `GITHUB_TOKEN`'s REST quota: 1,000 requests an hour per
 * repository, shared by every workflow of the repository
 * ([GitHub documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github_token-in-github-actions)).
 * An App installation token has its own larger quota; nothing here assumes one.
 */
export const githubTokenHourlyRequests = 1_000;
/**
 * The share of that hourly quota reproduction plans to spend: half. The other
 * half stays for every other workflow of the repository, which spend the same
 * per-repository quota while reproduction runs (CI's other jobs and plan
 * reads, the upstream observer, discovery, the batch job's own gate, merge
 * and issue calls) and whose use is not measured here (UNKNOWN), so no
 * smaller reserve is justified. Reproduction spends at most one request per
 * entry (its repository's release list).
 */
export const reproductionHourlyRequests = githubTokenHourlyRequests / 2;
/**
 * The longest wait for the quota once it is spent: GitHub resets the primary
 * quota hourly, so a request refused just after a reset waits up to an hour.
 */
export const quotaResetWaitMinutes = 60;
/**
 * How many times one batch's entries are reproduced: once by the batch job
 * before it proposes the batch and once by the batch pull request's CI. The
 * two can fall in the same hour, so both count against one hour's share.
 */
export const reproductionsPerBatch = 2;
/**
 * The reproduction entries one batch may land: one hour's reproduction share
 * divided by the reproductions each entry gets (`reproductionsPerBatch`), at
 * one request per entry. The batch job lands at most this many per batch and
 * carries the rest to its next batch, so its own reproduction and its pull
 * request's CI together stay within the share even in one hour, and neither
 * waits for the quota.
 */
export const reproductionBatchEntries = reproductionHourlyRequests / reproductionsPerBatch;
/**
 * The quota wait, in minutes, a reproduction of `entries` entries must expect
 * inside its shard deadline: none while one hour's share covers every
 * request, else one reset (`quotaResetWaitMinutes`). More than one reset never
 * fits the 85-minute deadline, so the shards are also run at a parallelism
 * whose concurrent requests fit the share (`reproductionParallelism`).
 */
export function expectedQuotaWaitMinutes(entries: number) {
  return entries > reproductionHourlyRequests ? quotaResetWaitMinutes : 0;
}
/**
 * The time one identity's inspection may take so CI can reproduce it: a CI
 * reproduction shard holds at most ceil(entries / `matrixJobLimit`) entries,
 * and they share the shard's `reproductionDeadlineMinutes` less the quota
 * wait it must expect (`expectedQuotaWaitMinutes`). The worker passes the
 * entries one batch can land, at most `reproductionBatchEntries`, so its
 * budget matches the CI that later reproduces the batch. An identity over it
 * is a `runner-time` failure, never settled as facts.
 */
export function identityBudgetMinutes(entries: number) {
  return (
    (reproductionDeadlineMinutes - expectedQuotaWaitMinutes(entries)) /
    Math.max(1, Math.ceil(entries / matrixJobLimit))
  );
}
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
/**
 * The archives of `next` whose recorded facts CI need not re-read from their
 * bytes: `previous` is an eligible baseline entry (its archives were
 * reproduced when it landed) of the same repository id, parser and parser
 * version, and holds a byte-identical record for the same asset id (same
 * SHA-256, players, name verdicts and refusal). Reproduction still re-checks
 * each one's provider metadata (name, size, digest) and name verdict; a
 * changed artifact, parser version or recorded fact is fully reproduced. A
 * new release on another line changes only `observed_releases` or
 * `other_packages`, so it re-reads no archive.
 */
export function reusedArchives(
  previous: ListingFactsEntry | undefined,
  next: ListingFactsEntry,
): Set<number> {
  const reused = new Set<number>();
  if (
    !previous ||
    previous.ineligible !== null ||
    previous.repository_id !== next.repository_id ||
    previous.parser !== next.parser ||
    previous.parser_version !== next.parser_version
  )
    return reused;
  const before = new Map(
    [...previous.artifacts, ...previous.refused_archives].map((archive) => [
      archive.asset_id,
      digestOf(archive),
    ]),
  );
  for (const archive of [...next.artifacts, ...next.refused_archives])
    if (before.get(archive.asset_id) === digestOf(archive)) reused.add(archive.asset_id);
  return reused;
}
/** Archive bytes reproducing an entry downloads: every archive not reused from `previous`. */
export const reproductionCost = (entry: ListingFactsEntry, previous?: ListingFactsEntry) => {
  const reused = reusedArchives(previous, entry);
  return [...entry.artifacts, ...entry.refused_archives]
    .filter((archive) => !reused.has(archive.asset_id))
    .reduce((sum, artifact) => sum + artifact.size, 0);
};
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
  return {
    entries,
    bytes: entries.reduce(
      (sum, entry) => sum + reproductionCost(entry, before.get(entry.port_id)),
      0,
    ),
    /** Per planned entry, the archives reproduction reuses (`reusedArchives`). */
    reused: new Map(
      entries.map((entry) => [entry.port_id, reusedArchives(before.get(entry.port_id), entry)]),
    ),
  };
}
