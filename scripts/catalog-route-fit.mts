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
import type { AcquisitionRestriction } from "./catalog-acquisition-restrictions.mts";
import { listingProviderIdentity } from "./listing-upstream-observation.mts";
import { isRecord } from "./runtime-values.mts";

/**
 * Report-only route fit for every catalog identity. It reads committed catalog
 * source, the generated package-shape and route-enrollment tables and,
 * optionally, a listing observer report. It decides nothing about admission and
 * never edits catalog data. Every rule is generic over the data: no title, id or
 * name appears here, so an identity no code has seen is classified from its
 * fields alone. The first matching rule wins:
 *
 * 1. `enrolled`: an operational definition or a generated route enrollment exists.
 * 2. `excluded-scummvm`: the declared runtime engine is the ScummVM project.
 * 3. `upstream-condition`: source-only, unavailable or a route-wide typed hold.
 * 4. `data-only`: GitHub-hosted packages for a supported desktop platform, so the
 *    existing user-selected registration route fits from data alone.
 * 5. `needs-admission`: packages for a supported platform outside GitHub, so a
 *    Portcove-owned route would need independent exact-byte admission.
 * 6. `missing-capability`: packages for no supported desktop platform, or a host
 *    no release provider adapter observes.
 * 7. `needs-bytes-worker`: an observable host whose package bytes and player
 *    facts have not been observed yet.
 */

export const dispositions = [
  "enrolled",
  "data-only",
  "needs-bytes-worker",
  "needs-admission",
  "missing-capability",
  "upstream-condition",
  "excluded-scummvm",
] as const;
export type Disposition = (typeof dispositions)[number];

/** The engine identity behind every ScummVM-hosted listing, compared as a URL. */
const scummvmEngineProject = "github.com/scummvm/scummvm";
const registrationProvider = "github";

export interface RouteFitFamily {
  adapter: string;
  provider: string;
}
export interface RouteFitRecord {
  id: string;
  family: RouteFitFamily;
  disposition: Disposition;
  reason: string;
}
export interface RouteFitSummary {
  identities: number;
  operational_definitions: number;
  listing_only: number;
  by_disposition: Record<Disposition, number>;
  by_family: Record<string, number>;
  listing_only_github_packages_windows_x86_64: number;
  data_only_windows_x86_64: number;
  observer_report: "absent" | "applied";
}
export interface RouteFitReport {
  format_version: 1;
  summary: RouteFitSummary;
  identities: RouteFitRecord[];
}
export interface RouteFitInputs {
  records: readonly AuthoredPort[];
  ports: readonly CatalogPort[];
  packageShapes: unknown;
  routeEnrollment: unknown;
  observerReport?: unknown;
}

function portIds(value: unknown, field: string, name: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[field]))
    throw new Error(`${name} needs a ${field} array.`);
  return value[field].map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.port_id !== "string" || !entry.port_id)
      throw new Error(`${name} contains an entry without a port_id.`);
    return entry.port_id;
  });
}

function counted(ids: readonly string[]) {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function engineProject(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`
      .toLowerCase()
      .replace(/\.git$/u, "")
      .replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

/** Engine identity from the implementation's declared runtime, never the title. */
function usesScummvmEngine(record: AuthoredPort): boolean {
  const implementation: unknown = record.listing.implementation;
  if (!isRecord(implementation) || !Array.isArray(implementation.dependencies)) return false;
  return implementation.dependencies.some(
    (dependency: unknown) =>
      isRecord(dependency) &&
      dependency.kind === "runtime" &&
      engineProject(dependency.project_url) === scummvmEngineProject,
  );
}

/** Any hold without a scope applies to the whole route; scoped holds do not. */
function routeWideHolds(record: AuthoredPort): string[] {
  const restrictions: AcquisitionRestriction[] = record.listing.restrictions ?? [];
  return restrictions
    .filter(
      (restriction) =>
        restriction.effect === "hold" &&
        (restriction.scope === undefined || Object.keys(restriction.scope).length === 0),
    )
    .map((restriction) => restriction.reason ?? restriction.id)
    .toSorted();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "an unparseable host";
  }
}

/** Supported desktop platforms with observed package assets, from successful observations only. */
function observedPackagePlatforms(report: unknown, known: ReadonlySet<string>) {
  const result = new Map<string, Set<string>>();
  if (report === undefined) return result;
  const entries: unknown =
    isRecord(report) && Array.isArray(report.listings) ? report.listings : report;
  if (!Array.isArray(entries))
    throw new Error("Observer report needs a listings array of listing updates.");
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== "string")
      throw new Error("Observer report contains a listing without an id.");
    if (!known.has(entry.id))
      throw new Error(`Observer report names ${entry.id}, which is not a catalog identity.`);
    const observation = entry.upstream_observation;
    // A failed, unavailable or incomplete attempt is not evidence of packages.
    if (!isRecord(observation) || observation.status !== undefined) continue;
    const observed = result.get(entry.id) ?? new Set<string>();
    for (const release of Array.isArray(observation.releases) ? observation.releases : [])
      for (const asset of isRecord(release) && Array.isArray(release.assets) ? release.assets : [])
        for (const hint of isRecord(asset) && Array.isArray(asset.platform_hints)
          ? asset.platform_hints
          : [])
          if ((platforms as readonly unknown[]).includes(hint)) observed.add(hint as string);
    result.set(entry.id, observed);
  }
  return result;
}

function classifyListing(
  record: AuthoredPort,
  observed: ReadonlySet<string> | undefined,
): Omit<RouteFitRecord, "id" | "family"> & { packagePlatforms?: string[] } {
  const listing = record.listing;
  if (usesScummvmEngine(record))
    return {
      disposition: "excluded-scummvm",
      reason: "Runs on the ScummVM engine; ScummVM onboarding is deferred.",
    };
  if (listing.availability === "source-only" || listing.availability === "unavailable")
    return {
      disposition: "upstream-condition",
      reason: `Upstream availability is ${listing.availability}.`,
    };
  const holds = routeWideHolds(record);
  if (holds.length)
    return {
      disposition: "upstream-condition",
      reason: `Route-wide acquisition hold: ${[...new Set(holds)].join(", ")}.`,
    };
  const declared = (listing.platforms ?? []).filter((platform) =>
    (platforms as readonly string[]).includes(platform),
  );
  const packagePlatforms = [
    ...new Set([...(listing.availability === "packages" ? declared : []), ...(observed ?? [])]),
  ].toSorted();
  const provider = listingProviderIdentity(listing)?.provider;
  const evidence = listing.availability === "packages" ? "declared" : "observed";
  if (packagePlatforms.length && provider === registrationProvider)
    return {
      disposition: "data-only",
      packagePlatforms,
      reason: `GitHub packages ${evidence} for ${packagePlatforms.join(", ")}; the user-selected registration route fits from data.`,
    };
  if (packagePlatforms.length)
    return {
      disposition: "needs-admission",
      reason: `Packages ${evidence} for ${packagePlatforms.join(", ")} are hosted on ${provider ?? hostOf(listing.release_url ?? listing.project_url)}, outside the registration route; a Portcove-owned route needs independent exact-byte admission.`,
    };
  if (listing.availability === "packages")
    return {
      disposition: "missing-capability",
      reason: "Upstream packages declare no supported desktop platform.",
    };
  if (!provider)
    return {
      disposition: "missing-capability",
      reason: `No release provider adapter observes ${hostOf(listing.release_url ?? listing.project_url)}.`,
    };
  return {
    disposition: "needs-bytes-worker",
    reason: `${provider === "github" ? "GitHub" : "GitLab"} package bytes and player facts for a supported platform are not observed yet.`,
  };
}

const byId = (left: { id: string }, right: { id: string }) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

function sortedCounts(entries: Iterable<string>): Record<string, number> {
  const counts = counted([...entries]);
  return Object.fromEntries([...counts].toSorted(([left], [right]) => (left < right ? -1 : 1)));
}

/** Pure analysis; equal inputs always produce byte-identical serialized output. */
export function routeFitReport(inputs: RouteFitInputs): RouteFitReport {
  const records = [...inputs.records].sort((left, right) => byId(left.listing, right.listing));
  const known = new Set(records.map((record) => record.listing.id));
  if (known.size !== records.length) throw new Error("Catalog identities must be unique.");
  const ports = new Map(inputs.ports.map((port) => [port.id, port]));
  const shapes = counted(portIds(inputs.packageShapes, "entries", "Package shapes"));
  const enrolled = counted(portIds(inputs.routeEnrollment, "cases", "Route enrollment"));
  for (const id of [...ports.keys(), ...shapes.keys(), ...enrolled.keys()])
    if (!known.has(id)) throw new Error(`${id} is not a catalog identity.`);
  const observations = observedPackagePlatforms(inputs.observerReport, known);

  const dataOnlyWindows = new Set<string>();
  const identities = records.map((record): RouteFitRecord => {
    const id = record.listing.id;
    const port = ports.get(id);
    if (port) {
      const release = isRecord(port.release) ? port.release : {};
      const provider = typeof release.provider === "string" ? release.provider : "github";
      const adapter = typeof port.adapter === "string" ? port.adapter : "unknown";
      const details = [
        enrolled.has(id) ? " Reviewed prepared-player route enrolled." : "",
        shapes.has(id) ? ` ${shapes.get(id)} reviewed package shape(s).` : "",
      ].join("");
      return {
        id,
        family: { adapter, provider },
        disposition: "enrolled",
        reason: `Operational ${adapter} definition with ${provider} releases.${details}`,
      };
    }
    const family = {
      adapter: "listing",
      provider: listingProviderIdentity(record.listing)?.provider ?? "other",
    };
    if (enrolled.has(id))
      return {
        id,
        family,
        disposition: "enrolled",
        reason: "Reviewed prepared-player route enrolled for user-selected registration.",
      };
    const { packagePlatforms, ...fit } = classifyListing(record, observations.get(id));
    if (packagePlatforms?.includes("windows-x86-64")) dataOnlyWindows.add(id);
    return { id, family, ...fit };
  });

  const listingOnly = records.filter((record) => !ports.has(record.listing.id));
  const byDisposition = Object.fromEntries(dispositions.map((name) => [name, 0])) as Record<
    Disposition,
    number
  >;
  for (const identity of identities) byDisposition[identity.disposition]++;
  return {
    format_version: 1,
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
      observer_report: inputs.observerReport === undefined ? "absent" : "applied",
    },
    identities,
  };
}

export function serializeRouteFitReport(report: RouteFitReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderRouteFitSummary(report: RouteFitReport): string {
  const { summary } = report;
  const lines = [
    `Catalog route fit: ${summary.identities} identities, ${summary.operational_definitions} operational definitions, ${summary.listing_only} listing-only`,
  ];
  for (const name of dispositions)
    lines.push(`  ${name.padEnd(40)} ${String(summary.by_disposition[name]).padStart(5)}`);
  lines.push(
    `Listing-only GitHub packages for windows-x86-64: ${summary.listing_only_github_packages_windows_x86_64}`,
  );
  lines.push(`Data-only for windows-x86-64: ${summary.data_only_windows_x86_64}`);
  lines.push("Families:");
  for (const [family, count] of Object.entries(summary.by_family))
    lines.push(`  ${family.padEnd(40)} ${String(count).padStart(5)}`);
  return lines.join("\n");
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
  const { records, catalog } = readCatalogSource(catalogRoot);
  const read = (file: string): unknown => parseCatalogSource(readFileSync(file, "utf8"));
  return {
    records,
    ports: catalog.ports,
    packageShapes: read(join(catalogRoot, "package-shapes.generated.json")),
    routeEnrollment: read(join(catalogRoot, "route-enrollment.generated.json")),
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
