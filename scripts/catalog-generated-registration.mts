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
//  6. that entry's observation is `complete` with a complete asset list
//     (anything else is UNKNOWN, never eligible);
//  7. for at least one supported desktop platform P there is an artifact whose
//     typed role is `desktop-game-runtime`, whose source authorizes (not a
//     filename suggestion), which no authorizing source contradicts, whose
//     operating system and architecture are P's, and which holds a player
//     candidate whose header machine runs on P;
//  8. on P no acquisition restriction holds `register-external` or `launch`
//     (a `download` hold does not block registration; this route never offers
//     a download).
// The route's platforms are every P satisfying 7 and 8.
import { createHash } from "node:crypto";
import { platforms } from "../apps/desktop/src/catalog-values.generated.ts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { registrationOwnership } from "./catalog-route-facts.mts";
import { heldAt, usesScummvmEngine } from "./catalog-route-holds.mts";
import { listingProviderIdentity } from "./listing-upstream-observation.mts";
import { isRecord } from "./runtime-values.mts";

/** Bump when the fit rule or the generated route shape changes. */
export const GENERATOR_VERSION = 1;
/** The facts parser version this generator reads. */
export const FACTS_PARSER = "listing-package-facts";
export const FACTS_PARSER_VERSION = 1;
export const FACTS_TABLE_FORMAT = 1;
export const ENROLLMENT_TABLE_FORMAT = 1;
export const factsTableName = "listing-package-facts.generated.json";
export const enrollmentTableName = "generated-registration.generated.json";
export const factsGenerator = "scripts/listing-package-facts.mts";
export const enrollmentGenerator = "scripts/generate-catalog.mts";

/**
 * Bounds of one generation run's enrollment delta. A run beyond them is refused
 * until a person raises the bound here in a reviewed change.
 */
export const deltaBounds = { added: 64, withdrawn: 32, changed: 64 } as const;

/** Fact sources that may establish a desktop runtime role; never a filename. */
export const authorizingSources = [
  "release-metadata",
  "exact-release-structured",
  "provider-cross-reference",
  "family-extractor",
] as const;
const sourceKinds = [...authorizingSources, "stable-declaration", "filename-suggestion"] as const;
const roles = [
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
const targetOs = ["windows", "linux", "macos", "android", "ios", "console", "web", "unknown"];
const targetArch = ["x86-64", "aarch64", "x86", "universal", "unknown"];
const coverages = ["complete", "partial", "unavailable", "failed"] as const;

export interface PlayerFact {
  path: string;
  machine: string;
  sha256: string;
}
export interface ArtifactFactV1 {
  asset_id: number;
  name: string;
  size: number;
  sha256: string | null;
  role: (typeof roles)[number];
  os: string;
  arch: string;
  source: { kind: (typeof sourceKinds)[number] } & Record<string, unknown>;
  players: PlayerFact[];
  contradictory: boolean;
}
export interface ListingFactsEntry {
  port_id: string;
  provider: "github";
  repository: string;
  parser: string;
  parser_version: number;
  observation: {
    release_id: number;
    tag: string;
    published_at: string | null;
    provider_prerelease: boolean;
    observed_at: string;
    coverage: (typeof coverages)[number];
    assets_complete: boolean;
  };
  artifacts: ArtifactFactV1[];
}
export interface ListingFactsTable {
  format: number;
  generator: string;
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
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}
function exact(value: Record<string, unknown>, fields: readonly string[], where: string) {
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown !== undefined) throw new Error(`${where} has an unknown field ${unknown}.`);
}
function relativePath(value: unknown): value is string {
  return (
    bounded(value, 1024) &&
    !value.includes("\\") &&
    !value.includes(":") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
export const digestOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function checkArtifact(value: unknown, where: string): asserts value is ArtifactFactV1 {
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
      "players",
      "contradictory",
    ],
    where,
  );
  if (
    !positive(value.asset_id) ||
    !bounded(value.name, 255) ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0 ||
    !(value.sha256 === null || sha(value.sha256)) ||
    !(roles as readonly unknown[]).includes(value.role) ||
    !targetOs.includes(value.os as string) ||
    !targetArch.includes(value.arch as string) ||
    typeof value.contradictory !== "boolean" ||
    !isRecord(value.source) ||
    !(sourceKinds as readonly unknown[]).includes(value.source.kind) ||
    !Array.isArray(value.players) ||
    value.players.length > 64
  )
    throw new Error(`${where} is not a typed artifact fact.`);
  if (value.source.kind === "exact-release-structured") {
    exact(value.source, ["kind", "shape_version", "archive_sha256"], `${where}.source`);
    if (!positive(value.source.shape_version) || value.source.archive_sha256 !== value.sha256)
      throw new Error(`${where} structural source must bind these exact archive bytes.`);
  }
  for (const [index, player] of value.players.entries()) {
    const at = `${where}.players[${index}]`;
    if (!isRecord(player)) throw new Error(`${at} must be an object.`);
    exact(player, ["path", "machine", "sha256"], at);
    if (!relativePath(player.path) || !bounded(player.machine, 64) || !sha(player.sha256))
      throw new Error(`${at} needs a package-relative path, header machine and SHA-256.`);
  }
}

/** Strict syntax of the generated facts table; content binding is the producer's. */
export function checkListingFactsTable(value: unknown): asserts value is ListingFactsTable {
  if (!isRecord(value)) throw new Error("Listing package facts must be an object.");
  exact(value, ["format", "generator", "entries", "entries_sha256"], "Listing package facts");
  if (
    value.format !== FACTS_TABLE_FORMAT ||
    value.generator !== factsGenerator ||
    !Array.isArray(value.entries) ||
    value.entries.length > 10000 ||
    value.entries_sha256 !== digestOf(value.entries)
  )
    throw new Error("Listing package facts need the current format, generator and entry digest.");
  const seen = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    const where = `Listing package facts entry ${index}`;
    if (!isRecord(entry)) throw new Error(`${where} must be an object.`);
    exact(
      entry,
      ["port_id", "provider", "repository", "parser", "parser_version", "observation", "artifacts"],
      where,
    );
    if (
      !bounded(entry.port_id, 128) ||
      seen.has(entry.port_id) ||
      entry.provider !== "github" ||
      typeof entry.repository !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(entry.repository) ||
      !bounded(entry.parser, 64) ||
      !positive(entry.parser_version) ||
      !isRecord(entry.observation) ||
      !Array.isArray(entry.artifacts) ||
      entry.artifacts.length > 256
    )
      throw new Error(`${where} needs a unique identity, GitHub repository and parser.`);
    if (
      index > 0 &&
      String((value.entries[index - 1] as ListingFactsEntry).port_id) >= entry.port_id
    )
      throw new Error("Listing package facts entries must be in ascending port_id order.");
    seen.add(entry.port_id);
    const observation = entry.observation;
    exact(
      observation,
      [
        "release_id",
        "tag",
        "published_at",
        "provider_prerelease",
        "observed_at",
        "coverage",
        "assets_complete",
      ],
      `${where}.observation`,
    );
    if (
      !positive(observation.release_id) ||
      !bounded(observation.tag, 256) ||
      !(observation.published_at === null || bounded(observation.published_at, 64)) ||
      typeof observation.provider_prerelease !== "boolean" ||
      !bounded(observation.observed_at, 64) ||
      Number.isNaN(Date.parse(observation.observed_at)) ||
      !(coverages as readonly unknown[]).includes(observation.coverage) ||
      typeof observation.assets_complete !== "boolean"
    )
      throw new Error(`${where}.observation needs a release identity and stated coverage.`);
    for (const [artifactIndex, artifact] of entry.artifacts.entries())
      checkArtifact(artifact, `${where}.artifacts[${artifactIndex}]`);
  }
}

export function emptyFactsTable(): ListingFactsTable {
  return {
    format: FACTS_TABLE_FORMAT,
    generator: factsGenerator,
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

/** Whether a header machine (Core's `package_shape::machine` names) runs on P. */
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

function artifactArchFits(artifact: ArtifactFactV1, platform: string) {
  const wanted = platform === "macos-aarch64" ? "aarch64" : "x86-64";
  return (
    artifact.arch === wanted || (hostOs[platform] === "macos" && artifact.arch === "universal")
  );
}

export interface PlatformRuntime {
  platform: string;
  asset_id: number;
  asset_name: string;
  archive_sha256: string | null;
  source: string;
  players: PlayerFact[];
}

/** Artifacts that establish a runtime for P from authorizing facts, or the reason none does. */
function platformRuntime(
  entry: ListingFactsEntry,
  platform: string,
): { runtime: PlatformRuntime } | { reason: string } {
  const runtimes = entry.artifacts.filter((artifact) => artifact.role === "desktop-game-runtime");
  if (!runtimes.length) return { reason: "no-runtime-role" };
  const authorized = runtimes.filter((artifact) =>
    (authorizingSources as readonly string[]).includes(artifact.source.kind),
  );
  if (!authorized.length) return { reason: "no-authorizing-source" };
  const consistent = authorized.filter((artifact) => !artifact.contradictory);
  if (!consistent.length) return { reason: "contradictory-role" };
  const hosted = consistent.filter(
    (artifact) => artifact.os === hostOs[platform] && artifactArchFits(artifact, platform),
  );
  if (!hosted.length) return { reason: "wrong-host" };
  for (const artifact of hosted.toSorted((left, right) => left.asset_id - right.asset_id)) {
    const players = artifact.players
      .filter((player) => machineRunsOn(player.machine, platform))
      .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    if (players.length)
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
  return { reason: "no-player-for-host" };
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
  "incomplete-coverage",
  "no-runtime-role",
  "no-authorizing-source",
  "contradictory-role",
  "wrong-host",
  "no-player-for-host",
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
  release: { id: number; tag: string; observed_at: string };
  runtimes: PlatformRuntime[];
}
export type FitDecision =
  | { port_id: string; fit: true; enrollment: GeneratedEnrollment }
  | { port_id: string; fit: false; reason: BlockedReason; detail: string };

const reasonPriority: BlockedReason[] = [
  "no-player-for-host",
  "wrong-host",
  "contradictory-role",
  "no-authorizing-source",
  "no-runtime-role",
];

export function fitDecision(
  record: AuthoredPort,
  entry: ListingFactsEntry | undefined,
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
  if (entry.observation.coverage !== "complete" || !entry.observation.assets_complete)
    return blocked(
      "incomplete-coverage",
      `Observation coverage is ${entry.observation.coverage}${entry.observation.assets_complete ? "" : " with an incomplete asset list"}; UNKNOWN.`,
    );
  const runtimes: PlatformRuntime[] = [];
  const misses = new Set<BlockedReason>();
  const held: string[] = [];
  for (const platform of platforms) {
    const found = platformRuntime(entry, platform);
    if ("reason" in found) {
      misses.add(found.reason as BlockedReason);
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
    const reason = reasonPriority.find((candidate) => misses.has(candidate)) ?? "no-runtime-role";
    return blocked(reason, `No supported desktop platform fits: ${[...misses].sort().join(", ")}.`);
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
      release: {
        id: entry.observation.release_id,
        tag: entry.observation.tag,
        observed_at: entry.observation.observed_at,
      },
      runtimes,
    },
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

/** The concrete selection step: a named program only when the facts name exactly one. */
function selectionInstruction(enrollment: GeneratedEnrollment) {
  const named = enrollment.runtimes.map((runtime) => {
    const names = [...new Set(runtime.players.map((player) => basename(player.path)))];
    return { platform: runtime.platform, names };
  });
  if (named.every(({ names }) => names.length === 1)) {
    const distinct = new Set(named.map(({ names }) => names[0]));
    const program =
      distinct.size === 1
        ? `Select ${named[0]!.names[0]} from your prepared copy.`
        : `Select the game program from your prepared copy: ${named.map(({ platform, names }) => `${names[0]} on ${platformLabels[platform]}`).join("; ")}.`;
    return `${program} Use its containing folder as the working folder. Leave arguments empty unless upstream documents some.`;
  }
  return "Select the game program from your prepared copy. Use its containing folder as the working folder. Leave arguments empty unless upstream documents some.";
}

function evidenceReference(enrollment: GeneratedEnrollment) {
  const runtimes = enrollment.runtimes
    .map(
      (runtime) =>
        `${platformLabels[runtime.platform]}: release asset ${runtime.asset_name} contains ${runtime.players.map((player) => `${player.path} (${player.machine}, SHA-256 ${player.sha256})`).join(", ")}`,
    )
    .join(". ");
  return `Portcove added this registration from observed release facts, without a title-specific review. Upstream ${enrollment.repository}, release ${enrollment.release.tag}, observed ${enrollment.release.observed_at}. ${runtimes}. Your own copy may differ; Portcove does not compare it with these files.`;
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
    .map((record) => fitDecision(record, entries.get(record.listing.id)))
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
  };
}

// ---------------------------------------------------------------------------
// The committed enrollment table, its delta and the bounded gate.

export interface EnrollmentTable {
  format: number;
  generator: string;
  generator_version: number;
  enrollments: GeneratedEnrollment[];
  blocked: Record<string, number>;
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
    enrollments: generation.enrollments,
    blocked,
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
  if (previous === undefined) return [];
  if (
    !isRecord(previous) ||
    previous.format !== ENROLLMENT_TABLE_FORMAT ||
    !Array.isArray(previous.enrollments)
  )
    throw new Error("The previous generated registration table is malformed.");
  return previous.enrollments as GeneratedEnrollment[];
}

/** Added, withdrawn and changed routes since the previous committed table, with reasons. */
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

/**
 * The safety net that replaces per-title review: refuse a run whose delta
 * exceeds the configured bounds or whose enrollments rest on any fact that is
 * not from an authorizing source, not complete or not matching its host.
 */
export function gateGeneration(
  previous: unknown,
  generation: Generation,
  bounds: { added: number; withdrawn: number; changed: number } = deltaBounds,
) {
  const delta = enrollmentDelta(previous, generation);
  const problems: string[] = [];
  for (const name of ["added", "withdrawn", "changed"] as const)
    if (delta[name].length > bounds[name])
      problems.push(`${delta[name].length} ${name} routes exceed the bound of ${bounds[name]}.`);
  for (const enrollment of generation.enrollments) {
    if (!enrollment.platforms.length) problems.push(`${enrollment.port_id} has no platform.`);
    for (const runtime of enrollment.runtimes) {
      if (!(authorizingSources as readonly string[]).includes(runtime.source))
        problems.push(
          `${enrollment.port_id} on ${runtime.platform} rests on a non-authorizing ${runtime.source} fact.`,
        );
      if (
        !runtime.players.length ||
        runtime.players.some((p) => !machineRunsOn(p.machine, runtime.platform))
      )
        problems.push(`${enrollment.port_id} on ${runtime.platform} has no matching player.`);
    }
  }
  if (problems.length)
    throw new Error(`Generated registration gate refused this run: ${problems.join(" ")}`);
  return delta;
}
