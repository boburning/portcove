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
//  8. for at least one supported desktop platform P there is an artifact whose
//     typed role is `desktop-game-runtime` from exact digest-bound archive
//     bytes, which neither its asset name (Core's filename classifier and
//     listing-only tool and system vetoes, vetoes only) nor another source
//     contradicts, whose name names no other system or architecture than P's,
//     and which holds a player candidate whose platform-true header machine
//     runs on P and whose name carries no tool token. Each player's own
//     machine decides where it runs; other players in the same archive (a
//     32-bit helper, the other system of a combined archive) neither help nor
//     block P;
//  9. on P the players of every such artifact are one program: after tool
//     vetoes and same-program variants (architecture, system, console and
//     debug words) at most `maxDistinctPrograms` (1) distinct program names
//     remain, and one artifact's players sit under one top-level directory.
//     Anything more could be several titles and is `ambiguous-player`;
// 10. on P no acquisition restriction holds `register-external` or `launch`
//     (a `download` hold does not block registration; this route never offers
//     a download).
// The route's platforms are every P satisfying 8 to 10.
import { createHash } from "node:crypto";
import { platforms } from "../apps/desktop/src/catalog-values.generated.ts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { registrationOwnership } from "./catalog-route-facts.mts";
import { heldAt, usesScummvmEngine } from "./catalog-route-holds.mts";
import { listingProviderIdentity } from "./listing-upstream-observation.mts";
import { isRecord } from "./runtime-values.mts";

/** Bump when the fit rule or the generated route shape changes. */
export const GENERATOR_VERSION = 5;
/** The facts parser version this generator reads. */
export const FACTS_PARSER = "listing-package-facts";
export const FACTS_PARSER_VERSION = 5;
export const FACTS_TABLE_FORMAT = 4;
export const ENROLLMENT_TABLE_FORMAT = 1;
export const factsTableName = "listing-package-facts.generated.json";
export const enrollmentTableName = "generated-registration.generated.json";
export const factsGenerator = "scripts/listing-package-facts.mts";
export const enrollmentGenerator = "scripts/generate-catalog.mts";

/**
 * Bounds of one generation's enrollment delta against the merge-base table.
 * A larger change lands as successive batches, one per worker run; a run
 * beyond them is refused until a person raises the bound here in a reviewed
 * change. There is no bypass.
 */
export const deltaBounds = { added: 64, withdrawn: 32, changed: 64 } as const;
/** Facts older than this, measured against the table's `generated_at`, are stale. */
export const maxFactsAgeDays = 30;
/** Last-good facts survive consecutive non-complete attempts for this long. */
export const lastGoodRetentionDays = 14;
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
  "too-large",
  "too-many-assets",
  "exceeds-run-budget",
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
  ineligible: { reason: IneligibleReason; detail: string } | null;
  /**
   * Package forms of the release's assets the worker does not read, sorted and
   * unique, whether or not a supported archive sits beside them: unsupported
   * desktop forms (`unreadForms`) and non-desktop forms (`nonDesktopForms`).
   */
  unread_forms: string[];
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
    value.players.length > 64 ||
    !Array.isArray(value.excluded_players) ||
    value.excluded_players.length > 64
  )
    throw new Error(`${where} is not a typed artifact fact.`);
  // Generator v1 trusts only exact structural observations of digest-bound bytes.
  if (!isRecord(value.source) || value.source.kind !== authorizingSource)
    throw new Error(`${where} must come from an exact-release-structured observation.`);
  exact(value.source, ["kind", "shape_version", "archive_sha256"], `${where}.source`);
  if (!positive(value.source.shape_version) || value.source.archive_sha256 !== value.sha256)
    throw new Error(`${where} structural source must bind these exact archive bytes.`);
  const suggestion = value.name_suggestion;
  if (!isRecord(suggestion)) throw new Error(`${where}.name_suggestion must be an object.`);
  exact(
    suggestion,
    ["rule_version", "role", "os", "arch", "tool_token", "system_token"],
    `${where}.name_suggestion`,
  );
  if (
    !positive(suggestion.rule_version) ||
    !(suggestion.tool_token === null || toolToken(suggestion.tool_token)) ||
    !(suggestion.system_token === null || toolToken(suggestion.system_token)) ||
    !(roles as readonly unknown[]).includes(suggestion.role) ||
    !targetOs.includes(suggestion.os as string) ||
    !targetArch.includes(suggestion.arch as string)
  )
    throw new Error(`${where}.name_suggestion is not a filename classification.`);
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
      "attempt",
      "artifacts",
    ],
    where,
  );
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
    entry.artifacts.length > 256
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
    exact(entry.ineligible, ["reason", "detail"], `${where}.ineligible`);
    if (
      !(ineligibleReasons as readonly unknown[]).includes(entry.ineligible.reason) ||
      !bounded(entry.ineligible.detail, 512) ||
      entry.artifacts.length
    )
      throw new Error(`${where}.ineligible needs a known reason and no artifacts.`);
  } else if (observation.release_id === null)
    throw new Error(`${where} without a release must be ineligible.`);
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
  const assets = new Set<number>();
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
    value.entries.length > 10000 ||
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
  ".jar",
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
  const named = artifact.name_suggestion;
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
      !artifact.contradictory,
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
  const runtimes = entry.artifacts.filter((artifact) => artifact.role === "desktop-game-runtime");
  if (!runtimes.length)
    return {
      reason: entry.artifacts.some((artifact) => artifact.excluded_players.length)
        ? "tool-not-game"
        : "no-player",
    };
  const authorized = runtimes.filter((artifact) => artifact.source.kind === authorizingSource);
  if (!authorized.length) return { reason: "no-authorizing-source" };
  const consistent = authorized.filter((artifact) => !artifact.contradictory);
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
  const [{ artifact, players }] = hosted as [(typeof hosted)[number]];
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
  "no-player",
  "tool-not-game",
  "no-authorizing-source",
  "contradictory-role",
  "unknown-platform",
  "wrong-host",
  "ambiguous-player",
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
  generatedAt: string = entry?.observation.observed_at ?? initialFactsTime,
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
  }
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
  if (distinct.size !== 1 || !displayableName(name!)) return genericSelection;
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
/** Core's concrete guide bound: steps plus references, and warnings, at most eight. */
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
  const decisions = records
    .map((record) => fitDecision(record, entries.get(record.listing.id), facts.generated_at))
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

/** Problems with one enrollment, judged against its facts entry only. */
function gateEnrollmentProblems(
  enrollment: GeneratedEnrollment,
  entry: ListingFactsEntry | undefined,
  generatedAt: string,
): string[] {
  const id = enrollment.port_id;
  if (!entry) return [`${id} has no facts entry.`];
  const problems: string[] = [];
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
    if (artifact.role !== "desktop-game-runtime" || artifact.contradictory)
      problems.push(`${where} rests on a contradicted or non-runtime artifact.`);
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
 * Refuse a generation whose delta against the baseline (the merge base's
 * committed table, never the working tree) exceeds the bounds, or whose
 * enrollments do not rest on complete, current, digest-bound facts.
 */
export function gateGeneration(
  baseline: unknown,
  generation: Generation,
  bounds: { added: number; withdrawn: number; changed: number } = deltaBounds,
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
  for (const name of ["added", "withdrawn", "changed"] as const)
    if (delta[name].length > bounds[name])
      problems.push(
        `${delta[name].length} ${name} routes exceed the bound of ${bounds[name]}; land them as successive batches.`,
      );
  const entries = new Map(generation.facts.entries.map((entry) => [entry.port_id, entry]));
  for (const enrollment of generation.enrollments)
    problems.push(
      ...gateEnrollmentProblems(
        enrollment,
        entries.get(enrollment.port_id),
        generation.facts.generated_at,
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

export interface ReproductionBudget {
  /** Eligible entries one change may add or change. */
  maxEntries: number;
  /** Archive bytes one reproduction may download in total. */
  maxBytes: number;
  /** Largest single archive; a larger one is refused, never trusted. */
  maxArchiveBytes: number;
  /** Wall-clock budget of one reproduction, in milliseconds. */
  maxMilliseconds: number;
}
/**
 * One change's reproduction budget. The entry bound is the gate's largest
 * delta bound; 4 GiB is two worker runs' byte budget, and an archive is never
 * larger than the worker reads (512 MiB). The 30-minute deadline is checked
 * before each archive, and one download or Core run stops after 10 minutes,
 * so a reproduction ends within 40 minutes, inside its 42-minute CI step.
 */
export const reproductionBudget: ReproductionBudget = {
  maxEntries: Math.max(deltaBounds.added, deltaBounds.changed),
  maxBytes: 4 * 1024 ** 3,
  maxArchiveBytes: 512 * 1024 ** 2,
  maxMilliseconds: 30 * 60_000,
};

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
  entry.artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
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

// ---------------------------------------------------------------------------
// Batching: facts land through one bounded batch per worker run.

/**
 * Keep the new facts of identities in port_id order while the enrollment delta
 * against the routes `previous` produces stays within the bounds; every other
 * changed identity keeps its previous entry, and its new entry is returned as
 * deferred so the next run offers it again without reading bytes. A change
 * that time alone causes (facts ageing out) cannot be deferred and counts
 * first. Eligible entries that need reproduction also stay within
 * `reproduction` (entries and archive bytes), so CI can always re-read every
 * one of them. Deterministic and pure.
 */
export function boundFactsBatch(
  records: readonly AuthoredPort[],
  previous: ListingFactsTable,
  next: ListingFactsTable,
  bounds: { added: number; withdrawn: number; changed: number } = deltaBounds,
  reproduction: ReproductionBudget = reproductionBudget,
): { table: ListingFactsTable; deferred: ListingFactsEntry[] } {
  const byId = new Map(records.map((record) => [record.listing.id, record]));
  const before = new Map(previous.entries.map((entry) => [entry.port_id, entry]));
  const after = new Map(next.entries.map((entry) => [entry.port_id, entry]));
  const enrolled = (id: string, entry: ListingFactsEntry | undefined, at: string) => {
    const record = byId.get(id);
    const decision = record ? fitDecision(record, entry, at) : undefined;
    return decision?.fit ? JSON.stringify(decision.enrollment) : undefined;
  };
  const effect = (from: string | undefined, to: string | undefined) =>
    from === to ? undefined : !from ? "added" : !to ? "withdrawn" : "changed";
  const counts = { added: 0, withdrawn: 0, changed: 0 };
  const ids = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  const accepted = new Map<string, ListingFactsEntry>();
  const pending: string[] = [];
  for (const id of ids) {
    const old = before.get(id);
    const proposed = after.get(id);
    if (digestOf(old ?? null) === digestOf(proposed ?? null)) {
      if (old) accepted.set(id, old);
      const change = effect(
        enrolled(id, old, previous.generated_at),
        enrolled(id, old, next.generated_at),
      );
      if (change) counts[change]++;
    } else pending.push(id);
  }
  const deferred: ListingFactsEntry[] = [];
  // Every eligible entry this batch adds or changes is re-read from its exact
  // bytes in CI; the batch never asks for more than that check may read.
  let reproduceEntries = 0;
  let reproduceBytes = 0;
  for (const id of pending) {
    const old = before.get(id);
    const proposed = after.get(id);
    const base = enrolled(id, old, previous.generated_at);
    const change = effect(base, enrolled(id, proposed, next.generated_at));
    const cost = proposed && needsReproduction(old, proposed) ? reproductionCost(proposed) : null;
    const reproducible =
      cost === null ||
      (reproduceEntries < reproduction.maxEntries &&
        reproduceBytes + cost <= reproduction.maxBytes);
    if (reproducible && (!change || counts[change] < bounds[change])) {
      if (cost !== null) {
        reproduceEntries++;
        reproduceBytes += cost;
      }
      if (change) counts[change]++;
      if (proposed) accepted.set(id, proposed);
      continue;
    }
    if (proposed) deferred.push(proposed);
    if (old) accepted.set(id, old);
    const kept = effect(base, enrolled(id, old, next.generated_at));
    if (kept) counts[kept]++;
  }
  const sorted = [...accepted.values()].toSorted((left, right) =>
    left.port_id < right.port_id ? -1 : 1,
  );
  return { table: { ...next, entries: sorted, entries_sha256: digestOf(sorted) }, deferred };
}
