import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platforms } from "../apps/desktop/src/catalog-values.generated.ts";
import {
  parseCatalogSource,
  readCatalogSource,
  type AuthoredPort,
  type CatalogPort,
} from "./catalog-authoring.mts";
import type { RestrictedOperation, RestrictionScope } from "./catalog-acquisition-restrictions.mts";
import {
  registrationQueues,
  type Generation,
  type RegistrationQueues,
} from "./catalog-generated-registration.mts";
import { carriers, heldAt, usesScummvmEngine } from "./catalog-route-holds.mts";
import { listingProviderIdentity } from "./listing-upstream-observation.mts";
import {
  observerListingObservations,
  readListingObservation,
  type ListingObservation,
} from "./listing-observation-reader.mts";
import { packagePlayerProjection } from "./package-player-observation.mts";
import { isRecord } from "./runtime-values.mts";

export { heldAt };

/**
 * Report-only route fit for every catalog identity. It reads committed catalog
 * source, the generated package-shape and route-enrollment tables and,
 * optionally, a listing observer report. It decides nothing about admission and
 * never edits catalog data. Every rule is generic over the data: no title, id or
 * name appears here, so an identity no code has seen is classified from its
 * fields alone. The first matching rule wins:
 *
 * 1. `excluded-scummvm`: the declared runtime engine is the ScummVM project,
 *    whether or not an operational route also exists (`enrolled` says so).
 * 2. `enrolled`: an operational definition or a generated route enrollment exists.
 *    A generated user-selected registration (`generated: true`) is an operational
 *    definition produced from observed facts with no title-specific authority.
 *
 * Every remaining identity is listing-only. Its candidate route is the existing
 * non-owning user-selected registration route (`register-external`, `launch`).
 *
 * 3. `upstream-condition`: source-only or unavailable upstream, a complete
 *    observation with no release package, or restrictions that hold every
 *    candidate-route operation on every platform with known packages.
 * 4. `data-only`: desktop packages are known for a supported platform and
 *    independently observed player facts exist for at least one of them.
 * 5. `missing-capability`: packages on a host no release provider adapter reads,
 *    or packages that carry no supported desktop platform.
 * 6. `needs-bytes-worker`: desktop packages are known but no player facts exist.
 * 7. `unobserved`: package availability is unknown and no complete observation
 *    exists. This is UNKNOWN, not absence.
 *
 * `needs-admission` is reserved for data that declares a Portcove-owned
 * install/execution route without an admitted reviewed artifact. A listing-only
 * record has no field that can declare such a route, so no rule assigns it and
 * its count is zero by construction.
 *
 * Restrictions are reported separately and evaluated the way Core's offer check
 * does (`crates/portcove-core/src/acquisition_restriction.rs`): per operation and
 * platform, the most specific fitting restriction wins, a hold wins a tie, a
 * more specific permit that could still match a deferred release or artifact
 * clears a broader hold, and a permit cancels holds only in its own carrier.
 */

export const dispositions = [
  "enrolled",
  "data-only",
  "needs-bytes-worker",
  "unobserved",
  "needs-admission",
  "missing-capability",
  "upstream-condition",
  "excluded-scummvm",
] as const;
export type Disposition = (typeof dispositions)[number];

/** Operations of the non-owning user-selected registration route. */
export const registrationRouteOperations: readonly RestrictedOperation[] = [
  "register-external",
  "launch",
];

/** Route facts describe a Windows prepared-player basename. */
const preparedPlayerPlatform = "windows-x86-64";
const desktopPlatforms: readonly string[] = platforms;

export interface RouteFitFamily {
  adapter: string;
  provider: string;
}
export interface RouteFitRestriction {
  id: string;
  carrier: "listing" | "managed";
  effect: "hold" | "permit";
  operations: RestrictedOperation[];
  scope: RestrictionScope | "whole";
  reason?: string;
}
export type ObservationState = "complete" | "incomplete" | "unavailable" | "failed" | "none";
export interface RouteFitRecord {
  id: string;
  family: RouteFitFamily;
  disposition: Disposition;
  reason: string;
  /** An operational definition or generated route enrollment exists. */
  enrolled: boolean;
  /** Present only for a generated user-selected registration route. */
  generated?: true;
  observation: ObservationState;
  restrictions: RouteFitRestriction[];
  /** Operations Core's offer check holds, by platform, among the declared ones. */
  held_operations: Partial<Record<RestrictedOperation, string[]>>;
}
export interface RouteFitSummary {
  identities: number;
  operational_definitions: number;
  listing_only: number;
  by_disposition: Record<Disposition, number>;
  by_family: Record<string, number>;
  listing_only_github_packages_windows_x86_64: number;
  data_only_windows_x86_64: number;
  /** Enrolled through a generated user-selected registration; no title-specific authority. */
  generated_registrations: number;
  restricted_identities: number;
  listing_only_download_held: number;
  observations: Record<ObservationState, number>;
  observer_report: "absent" | "applied";
}
export interface RouteFitReport {
  format_version: 2;
  summary: RouteFitSummary;
  identities: RouteFitRecord[];
  /**
   * The generated registration route's exception queues: every identity per
   * blocked reason, unread package form and name veto. Present when the
   * catalog generation is an input.
   */
  registration_queues?: RegistrationQueues;
}
export interface RouteFitInputs {
  records: readonly AuthoredPort[];
  ports: readonly CatalogPort[];
  packageShapes: unknown;
  routeEnrollment: unknown;
  /** The generated registration table; absent means no generated routes. */
  generatedRegistration?: unknown;
  /** The catalog generation, for the generated route's exception queues. */
  generation?: Generation;
  observerReport?: unknown;
}

function portEntries(value: unknown, field: string, name: string): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value[field]))
    throw new Error(`${name} needs a ${field} array.`);
  return value[field].map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.port_id !== "string" || !entry.port_id)
      throw new Error(`${name} contains an entry without a port_id.`);
    return entry;
  });
}

function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return "an unparseable host";
  }
}

function reportedRestrictions(record: AuthoredPort): RouteFitRestriction[] {
  return carriers(record).flatMap(({ carrier, list }) =>
    list.map((restriction) => ({
      id: restriction.id,
      carrier,
      effect: restriction.effect,
      operations: [...restriction.operations],
      scope:
        restriction.scope && Object.keys(restriction.scope).length
          ? structuredClone(restriction.scope)
          : ("whole" as const),
      ...(restriction.reason ? { reason: restriction.reason } : {}),
    })),
  );
}

const allOperations = (record: AuthoredPort) =>
  [
    ...new Set(
      carriers(record).flatMap(({ list }) => list.flatMap((restriction) => restriction.operations)),
    ),
  ].toSorted();

function heldOperations(record: AuthoredPort, evaluated: readonly string[]) {
  const held: Partial<Record<RestrictedOperation, string[]>> = {};
  for (const operation of allOperations(record)) {
    const on = evaluated.filter((platform) => heldAt(record, operation, platform));
    if (on.length) held[operation] = on;
  }
  return held;
}

function describeHeld(record: AuthoredPort, held: Partial<Record<string, string[]>>) {
  return Object.entries(held)
    .map(([operation, on]) => {
      const reasons = [
        ...new Set(
          on!.map((platform) => {
            const restriction = heldAt(record, operation, platform)!;
            return restriction.reason ?? restriction.id;
          }),
        ),
      ].toSorted();
      const where = on!.length === desktopPlatforms.length ? "every platform" : on!.join(", ");
      return `${operation} held on ${where}: ${reasons.join(", ")}`;
    })
    .join("; ");
}

// ---------------------------------------------------------------------------
// Observations and player facts.

interface Observed {
  state: ObservationState;
  platforms: Set<string>;
  assets: number;
}

function observedOf(observation: ListingObservation | undefined): Observed | undefined {
  if (!observation) return undefined;
  const observed: Observed = { state: observation.state, platforms: new Set(), assets: 0 };
  for (const release of observation.releases)
    for (const asset of release.assets) {
      observed.assets++;
      for (const hint of asset.platform_hints)
        if (desktopPlatforms.includes(hint)) observed.platforms.add(hint);
    }
  return observed;
}

/** Platforms with independently observed player facts and where they came from. */
function playerFacts(record: AuthoredPort, shapes: readonly Record<string, unknown>[]) {
  const facts = new Map<string, string>();
  for (const entry of shapes)
    if (
      typeof entry.platform === "string" &&
      isRecord(entry.shape) &&
      Array.isArray(entry.shape.programs) &&
      entry.shape.programs.length
    )
      facts.set(entry.platform, "a reviewed package shape");
  if (record.package_observation_v1) {
    const projection = packagePlayerProjection(record, record.package_observation_v1);
    if (projection.status === "observed")
      for (const platform of projection.platforms)
        facts.set(platform, facts.get(platform) ?? "an accepted package player observation");
  }
  if (record.route_facts_v1?.prepared_player)
    facts.set(
      preparedPlayerPlatform,
      facts.get(preparedPlayerPlatform) ?? "authored prepared-player route facts",
    );
  return facts;
}

type Fitted = Pick<RouteFitRecord, "disposition" | "reason"> & {
  packagePlatforms: string[];
};

function classifyListing(
  record: AuthoredPort,
  observed: Observed | undefined,
  shapes: readonly Record<string, unknown>[],
): Fitted {
  const listing = record.listing;
  const none = { packagePlatforms: [] };
  if (listing.availability === "source-only" || listing.availability === "unavailable")
    return {
      ...none,
      disposition: "upstream-condition",
      reason: `Upstream availability is ${listing.availability}.`,
    };
  const declared = (listing.platforms ?? []).filter((platform) =>
    desktopPlatforms.includes(platform),
  );
  const players = playerFacts(record, shapes);
  const complete = observed?.state === "complete" ? observed : undefined;
  const packagePlatforms = [
    ...new Set([
      ...(listing.availability === "packages" ? declared : []),
      ...(complete?.platforms ?? []),
      ...players.keys(),
    ]),
  ].toSorted();
  const routePlatforms = packagePlatforms.filter((platform) =>
    registrationRouteOperations.every((operation) => !heldAt(record, operation, platform)),
  );
  if (packagePlatforms.length && !routePlatforms.length)
    return {
      packagePlatforms,
      disposition: "upstream-condition",
      reason: `No registration route operation remains: ${describeHeld(record, heldOperations(record, packagePlatforms))}.`,
    };
  const playerPlatforms = routePlatforms.filter((platform) => players.has(platform));
  if (playerPlatforms.length)
    return {
      packagePlatforms,
      disposition: "data-only",
      reason: `Desktop packages are known and ${[...new Set(playerPlatforms.map((platform) => players.get(platform)))].join(" and ")} supplies player facts for ${playerPlatforms.join(", ")}; it could enter the non-owning user-selected registration route from data alone.`,
    };
  const provider = listingProviderIdentity(listing)?.provider;
  const host = hostOf(listing.release_url ?? listing.project_url);
  if (routePlatforms.length && !provider)
    return {
      packagePlatforms,
      disposition: "missing-capability",
      reason: `Packages are known for ${routePlatforms.join(", ")}, but no release provider adapter reads ${host}, so package bytes and player facts cannot be observed.`,
    };
  if (routePlatforms.length)
    return {
      packagePlatforms,
      disposition: "needs-bytes-worker",
      reason: `Desktop packages are known for ${routePlatforms.join(", ")} (${listing.availability === "packages" ? "declared" : "complete observation"}), but no player facts are derived: no package player observation, reviewed package shape or prepared-player route facts.`,
    };
  if (complete && complete.assets === 0)
    return {
      packagePlatforms,
      disposition: "upstream-condition",
      reason: "A complete observation found no release package in the observed releases.",
    };
  if (complete)
    return {
      packagePlatforms,
      disposition: "missing-capability",
      reason: `A complete observation found ${complete.assets} release package(s), none with a supported desktop platform hint.`,
    };
  if (!provider)
    return {
      packagePlatforms,
      disposition: "missing-capability",
      reason: `No release provider adapter reads ${host}, so packages cannot be observed.`,
    };
  const attempt =
    observed && observed.state !== "none" ? ` The latest observation is ${observed.state}.` : "";
  return {
    packagePlatforms,
    disposition: "unobserved",
    reason:
      listing.availability === "packages"
        ? `Packages are declared for no known desktop platform and no complete observation exists; their platforms are unobserved.${attempt}`
        : `Package availability is unobserved: no complete observation exists.${attempt}`,
  };
}

const byId = (left: { id: string }, right: { id: string }) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

function sortedCounts(entries: Iterable<string>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  return Object.fromEntries([...counts].toSorted(([left], [right]) => (left < right ? -1 : 1)));
}

function groupById(entries: readonly Record<string, unknown>[]) {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const entry of entries)
    groups.set(entry.port_id as string, [...(groups.get(entry.port_id as string) ?? []), entry]);
  return groups;
}

/** Pure analysis; equal inputs always produce byte-identical serialized output. */
export function routeFitReport(inputs: RouteFitInputs): RouteFitReport {
  const records = [...inputs.records].sort((left, right) => byId(left.listing, right.listing));
  const known = new Set(records.map((record) => record.listing.id));
  if (known.size !== records.length) throw new Error("Catalog identities must be unique.");
  const ports = new Map(inputs.ports.map((port) => [port.id, port]));
  const shapes = groupById(portEntries(inputs.packageShapes, "entries", "Package shapes"));
  const enrolled = groupById(portEntries(inputs.routeEnrollment, "cases", "Route enrollment"));
  for (const id of [...ports.keys(), ...shapes.keys(), ...enrolled.keys()])
    if (!known.has(id)) throw new Error(`${id} is not a catalog identity.`);
  const reported = observerListingObservations(inputs.observerReport, known);
  const generated = new Map(
    (inputs.generatedRegistration === undefined
      ? []
      : portEntries(inputs.generatedRegistration, "enrollments", "Generated registrations")
    ).map((entry) => [entry.port_id as string, entry]),
  );
  for (const id of generated.keys())
    if (!ports.has(id)) throw new Error(`${id} is a generated registration without a definition.`);

  const dataOnlyWindows = new Set<string>();
  const identities = records.map((record): RouteFitRecord => {
    const id = record.listing.id;
    const port = ports.get(id);
    const observed = observedOf(
      reported.get(id) ?? readListingObservation(record.listing.upstream_observation),
    );
    const restrictions = reportedRestrictions(record);
    // Every supported platform: a whole hold applies even where none is declared.
    const held = heldOperations(record, desktopPlatforms);
    const isEnrolled = port !== undefined || enrolled.has(id);
    const common = {
      id,
      enrolled: isEnrolled,
      observation: observed?.state ?? ("none" as const),
      restrictions,
      held_operations: held,
    };
    const release = port && isRecord(port.release) ? port.release : {};
    const family = port
      ? {
          adapter: typeof port.adapter === "string" ? port.adapter : "unknown",
          provider: typeof release.provider === "string" ? release.provider : "github",
        }
      : {
          adapter: "listing",
          provider: listingProviderIdentity(record.listing)?.provider ?? "other",
        };
    const heldText = Object.keys(held).length ? ` ${describeHeld(record, held)}.` : "";
    if (usesScummvmEngine(record))
      return {
        ...common,
        family,
        disposition: "excluded-scummvm",
        reason: `Runs on the ScummVM engine; ScummVM onboarding is deferred.${isEnrolled ? " An operational route also exists." : ""}${heldText}`,
      };
    const generatedRoute = generated.get(id);
    if (port && generatedRoute) {
      const release = isRecord(generatedRoute.release) ? generatedRoute.release : {};
      const on = Array.isArray(generatedRoute.platforms) ? generatedRoute.platforms.join(", ") : "";
      return {
        ...common,
        generated: true as const,
        family,
        disposition: "enrolled",
        reason: `Generated user-selected registration from observed ${String(generatedRoute.repository)} ${String(release.tag)} facts on ${on}; no title-specific authority.${heldText}`,
      };
    }
    if (port) {
      const details = [
        enrolled.has(id) ? " Reviewed prepared-player route enrolled." : "",
        shapes.has(id) ? ` ${shapes.get(id)!.length} reviewed package shape(s).` : "",
      ].join("");
      return {
        ...common,
        family,
        disposition: "enrolled",
        reason: `Operational ${family.adapter} definition with ${family.provider} releases.${details}${heldText}`,
      };
    }
    if (enrolled.has(id))
      return {
        ...common,
        family,
        disposition: "enrolled",
        reason: `Reviewed prepared-player route enrolled for user-selected registration.${heldText}`,
      };
    const { packagePlatforms, ...fitted } = classifyListing(record, observed, shapes.get(id) ?? []);
    if (fitted.disposition === "data-only" && packagePlatforms.includes("windows-x86-64"))
      dataOnlyWindows.add(id);
    const routeHeld =
      fitted.disposition === "upstream-condition" && fitted.reason.includes(" held ");
    return {
      ...common,
      family,
      ...fitted,
      reason: routeHeld ? fitted.reason : `${fitted.reason}${heldText}`,
    };
  });

  const listingOnly = records.filter((record) => !ports.has(record.listing.id));
  const byDisposition = Object.fromEntries(dispositions.map((name) => [name, 0])) as Record<
    Disposition,
    number
  >;
  for (const identity of identities) byDisposition[identity.disposition]++;
  const observations = {
    complete: 0,
    incomplete: 0,
    unavailable: 0,
    failed: 0,
    none: 0,
  };
  for (const identity of identities) observations[identity.observation]++;
  return {
    format_version: 2,
    summary: {
      identities: identities.length,
      operational_definitions: records.length - listingOnly.length,
      listing_only: listingOnly.length,
      by_disposition: byDisposition,
      by_family: sortedCounts(
        identities.map(({ family }) => `${family.adapter}/${family.provider}`),
      ),
      listing_only_github_packages_windows_x86_64: listingOnly.filter(
        ({ listing }) =>
          listing.availability === "packages" &&
          listing.platforms?.includes("windows-x86-64") &&
          listingProviderIdentity(listing)?.provider === "github",
      ).length,
      data_only_windows_x86_64: dataOnlyWindows.size,
      generated_registrations: identities.filter((identity) => identity.generated).length,
      restricted_identities: identities.filter((identity) => identity.restrictions.length).length,
      listing_only_download_held: identities.filter(
        (identity) => !ports.has(identity.id) && identity.held_operations.download,
      ).length,
      observations,
      observer_report: inputs.observerReport === undefined ? "absent" : "applied",
    },
    identities,
    ...(inputs.generation ? { registration_queues: registrationQueues(inputs.generation) } : {}),
  };
}

export function serializeRouteFitReport(report: RouteFitReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderRouteFitSummary(report: RouteFitReport): string {
  const { summary } = report;
  const row = (name: string, count: number) => `  ${name.padEnd(40)} ${String(count).padStart(5)}`;
  const lines = [
    `Catalog route fit: ${summary.identities} identities, ${summary.operational_definitions} operational definitions, ${summary.listing_only} listing-only`,
    ...dispositions.map((name) => row(name, summary.by_disposition[name])),
    `Listing-only GitHub packages declared for windows-x86-64: ${summary.listing_only_github_packages_windows_x86_64}`,
    `Data-only for windows-x86-64: ${summary.data_only_windows_x86_64}`,
    `Enrolled through generated registration (no title-specific authority): ${summary.generated_registrations}`,
    `Identities with restrictions: ${summary.restricted_identities}; listing-only with download held: ${summary.listing_only_download_held}`,
    `Observations (${summary.observer_report === "applied" ? "observer report applied" : "committed only"}):`,
    ...Object.entries(summary.observations).map(([state, count]) => row(state, count)),
    "Families:",
    ...Object.entries(summary.by_family).map(([family, count]) => row(family, count)),
    ...(report.registration_queues
      ? [
          "Generated registration queues (identity lists with --json):",
          ...Object.entries(report.registration_queues.reasons)
            .filter(([, ids]) => ids.length)
            .map(([reason, ids]) => row(reason, ids.length)),
          ...Object.entries(report.registration_queues.unread_forms).map(([form, ids]) =>
            row(`unread form ${form}`, ids.length),
          ),
          ...Object.entries(report.registration_queues.refusals).map(([refusal, ids]) =>
            row(`refused archive ${refusal}`, ids.length),
          ),
          row(
            "repositories named by more than one identity",
            Object.keys(report.registration_queues.shared_repositories).length,
          ),
          row(
            "identities on a shared repository",
            Object.values(report.registration_queues.shared_repositories).reduce(
              (sum, ids) => sum + ids.length,
              0,
            ),
          ),
          row(
            "generated-route candidates among them",
            sharedCandidates(report.registration_queues).length,
          ),
          row(
            "enrolled beside another package form for a platform without an archive (review)",
            report.registration_queues.enrolled_beside_unoffered_forms.length,
          ),
          row(
            "withheld beside another package form (asset names with --json)",
            Object.keys(report.registration_queues.other_package_forms).length,
          ),
          row(
            "withheld for a bundled toolchain (helper names with --json)",
            Object.keys(report.registration_queues.bundled_toolchains).length,
          ),
          ...Object.entries(report.registration_queues.inspection_failures).map(([cause, ids]) =>
            row(`repeated inspection failure: ${cause}`, ids.length),
          ),
          row(
            "other package forms attributed to the archive's product (review; names with --json)",
            Object.keys(report.registration_queues.same_product_forms).length,
          ),
          row(
            "with a source or third-party source archive",
            Object.keys(report.registration_queues.source_archives).length,
          ),
          row(
            "with a release whose own text states a prerelease",
            Object.keys(report.registration_queues.release_statements).length,
          ),
          row(
            "offered release text not reported by the observer (UNKNOWN)",
            report.registration_queues.release_text_unobserved.length,
          ),
          row(
            "withheld past newer releases that only their words call prereleases",
            Object.keys(report.registration_queues.worded_prerelease_skipped).length,
          ),
        ]
      : []),
  ];
  return lines.join("\n");
}

/**
 * Identities on a shared repository that the generated route could otherwise
 * serve: everything but operational, deferred-engine, unavailable and
 * unreadable identities. Without a reviewed release-line binding these stay
 * `shared-repository`.
 */
export function sharedCandidates(queues: RegistrationQueues): string[] {
  const outside = new Set(
    (
      [
        "operational-route",
        "scummvm-engine",
        "upstream-unavailable",
        "no-readable-upstream",
      ] as const
    ).flatMap((reason) => queues.reasons[reason]),
  );
  return [
    ...new Set(
      Object.values(queues.shared_repositories)
        .flat()
        .filter((id) => !outside.has(id)),
    ),
  ].toSorted();
}

/** Every catalog identity appears exactly once, with a known disposition and a reason. */
export function checkRouteFitReport(report: RouteFitReport, records: readonly AuthoredPort[]) {
  const expected = records.map((record) => record.listing.id).toSorted();
  const actual = report.identities.map((identity) => identity.id);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Route fit must list every catalog identity exactly once, in id order.");
  for (const identity of report.identities)
    if (!(dispositions as readonly string[]).includes(identity.disposition) || !identity.reason)
      throw new Error(`${identity.id} needs a known disposition and a reason.`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogDirectory = "crates/portcove-core/catalog";

export function readRouteFitInputs(repositoryRoot: string, observerReportPath?: string) {
  const catalogRoot = join(repositoryRoot, catalogDirectory);
  const { records, catalog, generation } = readCatalogSource(catalogRoot);
  const read = (file: string): unknown => parseCatalogSource(readFileSync(file, "utf8"));
  return {
    records,
    ports: catalog.ports,
    packageShapes: read(join(catalogRoot, "package-shapes.generated.json")),
    routeEnrollment: read(join(catalogRoot, "route-enrollment.generated.json")),
    generatedRegistration: read(join(catalogRoot, "generated-registration.generated.json")),
    generation,
    ...(observerReportPath === undefined ? {} : { observerReport: read(observerReportPath) }),
  } satisfies RouteFitInputs;
}

const usage =
  "Usage: node scripts/catalog-route-fit.mts [--check] [--json] [--output FILE] [--observations OBSERVER_REPORT.json]";

export function main(argv: readonly string[], repositoryRoot = root): string {
  const options = { check: false, json: false } as {
    check: boolean;
    json: boolean;
    output?: string;
    observations?: string;
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--output" || argument === "--observations") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(usage);
      options[argument.slice(2) as "output" | "observations"] = resolve(value);
    } else throw new Error(usage);
  }
  const inputs = readRouteFitInputs(repositoryRoot, options.observations);
  const report = routeFitReport(inputs);
  checkRouteFitReport(report, inputs.records);
  const serialized = serializeRouteFitReport(report);
  if (options.check && serializeRouteFitReport(routeFitReport(inputs)) !== serialized)
    throw new Error("Route fit report is not deterministic.");
  if (options.output) writeFileSync(options.output, serialized);
  return options.json ? serialized : `${renderRouteFitSummary(report)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
