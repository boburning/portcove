/** Existing observer facts -> the existing signed descriptive target. No executable authority. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fitListingAdmissions } from "./listing-admission-budget.mts";
import { isRecord } from "./runtime-values.mts";
import { parseCatalogSource } from "./catalog-authoring.mts";
import { listingDeclarationHash } from "./listing-upstream-observation.mts";
import { compatibleGithubListingAssetUrl, observationHash } from "./upstream-observer.mts";
import {
  catalogObservationSources,
  validateCatalogObserverCheckpoint,
} from "./catalog-upstream-observer.mts";
import { readUpstreamObservations } from "./maintenance-upstream.mts";
import type { UpstreamInput } from "./maintenance-upstream.mts";
import { copyPriorRepository, publishedTargets } from "./catalog-publish.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";

export const listingDeliveryTarget = "policy/official/catalog.listings.json";
const maximum = 8 * 1024 * 1024;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
interface Directory {
  format_version: number;
  listings: Record<string, unknown>[];
}
interface Delivery {
  listing_delivery_schema: 1;
  revision: number;
  withdrawn_ids: string[];
  directory: Directory;
}
function directory(value: unknown): Directory {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.format_version) ||
    Number(value.format_version) < 1 ||
    Number(value.format_version) > 15 ||
    !Array.isArray(value.listings) ||
    value.listings.length > 10000
  )
    throw new Error("Listing projection requires a supported bounded canonical directory");
  const seen = new Set();
  for (const listing of value.listings) {
    if (
      !isRecord(listing) ||
      typeof listing.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(listing.id) ||
      listing.id.length > 128 ||
      seen.has(listing.id)
    )
      throw new Error("Listing projection requires unique canonical identities");
    seen.add(listing.id);
  }
  return value as unknown as Directory;
}
function delivery(value: unknown): Delivery {
  if (
    !isRecord(value) ||
    value.listing_delivery_schema !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    Number(value.revision) > 9007199254740991 ||
    !Array.isArray(value.withdrawn_ids) ||
    value.withdrawn_ids.length > 10000
  )
    throw new Error("Invalid prior descriptive delivery envelope");
  directory(value.directory);
  return value as unknown as Delivery;
}
/** Use validated checkpoint policies only when producer AND current canonical
 * declarations/operational facts still agree. An artifact never supplies facts
 * outside upstream_observation and cannot create an authored identity. */
export function completedListingCandidates(
  input: UpstreamInput,
  current: unknown,
  canonical: unknown,
  now = Date.now(),
  gaps: string[] = [],
) {
  const checkpoint = validateCatalogObserverCheckpoint(input.checkpoint, now);
  const currentDirectory = directory(canonical);
  const declarations = new Map(currentDirectory.listings.map((listing) => [listing.id, listing]));
  const currentPorts = new Map(
    (isRecord(current) && Array.isArray(current.ports) ? current.ports : [])
      .filter(isRecord)
      .map((port) => [port.id, port]),
  );
  const originalPorts = new Map(
    (isRecord(input.catalog) && Array.isArray(input.catalog.ports) ? input.catalog.ports : [])
      .filter(isRecord)
      .map((port) => [port.id, port]),
  );
  const candidates: Record<string, unknown>[] = [];
  for (const source of catalogObservationSources(input.catalog).sources) {
    const progress = checkpoint.sources[source.key];
    if (!progress?.completed_scope_sha256) {
      gaps.push(`${source.repository}: no applicable completed observer scope`);
      continue;
    }
    if (progress.exception_key)
      gaps.push(
        `${source.repository}: retained completed observation; latest observer exception ${progress.exception_rule ?? "unknown"}`,
      );
    for (const port of source.ports) {
      const canonicalListing = declarations.get(port.id);
      if (
        !canonicalListing ||
        !port.listing ||
        listingDeclarationHash(port.listing) !== listingDeclarationHash(canonicalListing) ||
        observationHash(originalPorts.get(port.id) ?? null) !==
          observationHash(currentPorts.get(port.id) ?? null)
      )
        continue;
      const policies = progress.last_complete_policies.filter(
        (policy) => policy.port_id === port.id,
      );
      const policy = policies.length === 1 ? policies[0] : undefined;
      if (
        !policy ||
        !isRecord(policy.listing_update) ||
        listingDeclarationHash(policy.listing_update) !==
          listingDeclarationHash(canonicalListing) ||
        !isRecord(policy.listing_update.upstream_observation)
      )
        continue;
      // These are the completed observation's original coverage and clocks, not
      // a fresh provider check. Failed later attempts do not re-date this record.
      candidates.push(policy.listing_update);
    }
  }
  return candidates;
}

function completeObservation(value: Record<string, unknown>) {
  const { attempted_at, observed_at, fresh_until, ...facts } = value;
  if (
    facts.status !== "complete" ||
    typeof attempted_at !== "string" ||
    typeof observed_at !== "string" ||
    typeof fresh_until !== "string"
  )
    return null;
  const attempted = Date.parse(attempted_at);
  const observed = Date.parse(observed_at);
  const expires = Date.parse(fresh_until);
  if (!Number.isFinite(attempted) || !(observed <= attempted && attempted < expires)) return null;
  return { attempted, observed, expires, facts };
}

/**
 * Keep an already signed observation through the first half of its original
 * freshness window when the completed refresh only advances its clocks.
 * Leaving the old clocks intact preserves the exact evidence readers received.
 */
function retainFreshObservation(
  held: Record<string, unknown>,
  proposed: Record<string, unknown>,
  now: number,
) {
  const prior = completeObservation(held);
  const next = completeObservation(proposed);
  return (
    prior !== null &&
    next !== null &&
    prior.observed <= now &&
    now < prior.observed + (prior.expires - prior.observed) / 2 &&
    next.observed >= prior.observed &&
    next.attempted >= prior.attempted &&
    next.expires >= prior.expires &&
    next.expires - next.observed >= prior.expires - prior.observed &&
    observationHash(omitUnknownAssetDigests(prior.facts)) ===
      observationHash(omitUnknownAssetDigests(next.facts))
  );
}

function omitUnknownAssetDigests(observation: unknown): unknown {
  if (!isRecord(observation) || !Array.isArray(observation.releases)) return observation;
  const releases: unknown[] = structuredClone(observation.releases);
  for (const release of releases) {
    if (!isRecord(release) || !Array.isArray(release.assets)) continue;
    for (const asset of release.assets) {
      // The listing reader decodes both spellings as an absent provider digest.
      if (isRecord(asset) && asset.sha256 === null) delete asset.sha256;
    }
  }
  return { ...observation, releases };
}

export function projectListingDelivery(
  canonical: unknown,
  candidates: readonly Record<string, unknown>[],
  previous: Buffer | null,
  revisionFloor = 0,
  byteLimit = maximum,
  compatible?: unknown,
  operationalIds: ReadonlySet<string> = new Set(),
  now = Date.now(),
) {
  const raw = directory(canonical);
  const baseline = directory(compatible ?? raw);
  const identities = new Set(raw.listings.map((listing) => listing.id));
  if (
    baseline.format_version !== 11 ||
    baseline.listings.length !== raw.listings.length ||
    baseline.listings.some((listing) => !identities.has(listing.id))
  )
    throw new Error("Core compatibility projection changed canonical identities");
  const previousDocument = previous
    ? delivery(parseCatalogSource(previous.toString("utf8")))
    : null;
  const previousListings = new Map(
    previousDocument?.directory.listings.map((listing) => [listing.id, listing]) ?? [],
  );
  const updates = new Map<string, Record<string, unknown>>();
  const declarations = new Map(raw.listings.map((listing) => [listing.id, listing]));
  for (const candidate of candidates) {
    const current = typeof candidate.id === "string" ? declarations.get(candidate.id) : undefined;
    if (
      !current ||
      listingDeclarationHash(candidate) !== listingDeclarationHash(current) ||
      !isRecord(candidate.upstream_observation)
    )
      continue;
    if (updates.has(String(candidate.id)))
      throw new Error("Conflicting descriptive observation candidates");
    updates.set(String(candidate.id), compatibleObservation(candidate.upstream_observation));
  }
  const withdrawn = previousDocument?.withdrawn_ids ?? [];
  const withdrawalSet = new Set(withdrawn);
  for (const id of previousListings.keys()) {
    if (!identities.has(id) && !withdrawalSet.has(String(id)))
      throw new Error(
        "Previously published listing missing from the canonical directory without an explicit withdrawal",
      );
  }
  const observedAt = (value: Record<string, unknown> | undefined) =>
    value && typeof value.observed_at === "string" ? Date.parse(value.observed_at) : -Infinity;
  const proposedRows = baseline.listings
    .filter(
      (listing) =>
        !withdrawalSet.has(String(listing.id)) &&
        (previousListings.has(listing.id) ||
          operationalIds.has(String(listing.id)) ||
          updates.has(String(listing.id)) ||
          isRecord(listing.upstream_observation)),
    )
    .map((listing) => {
      const result = structuredClone(listing);
      const old = previousListings.get(listing.id);
      const prior =
        old &&
        listingDeclarationHash(old) === listingDeclarationHash(listing) &&
        isRecord(old.upstream_observation)
          ? old.upstream_observation
          : undefined;
      const authored = isRecord(result.upstream_observation)
        ? result.upstream_observation
        : undefined;
      if (prior && (!authored || observedAt(prior) > observedAt(authored)))
        result.upstream_observation = prior;
      const held = isRecord(result.upstream_observation) ? result.upstream_observation : undefined;
      const proposed = updates.get(String(listing.id));
      if (
        proposed &&
        (!held ||
          (proposed.status === "complete" &&
            observedAt(proposed) >= observedAt(held) &&
            !retainFreshObservation(held, proposed, now)))
      )
        result.upstream_observation = proposed;
      if (result.upstream_observation !== undefined)
        result.upstream_observation = omitUnknownAssetDigests(result.upstream_observation);
      return {
        listing: result,
        prior,
        required: previousListings.has(listing.id) || operationalIds.has(String(listing.id)),
        retained: !!prior,
        updated:
          result.upstream_observation === undefined
            ? false
            : observationHash(result.upstream_observation) !==
              observationHash(omitUnknownAssetDigests(old?.upstream_observation ?? null)),
        priority: previousListings.has(listing.id) ? 0 : authored ? 1 : 2,
      };
    })
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        String(left.listing.id).localeCompare(String(right.listing.id), "en"),
    );
  const revision = Math.max(previousDocument?.revision ?? 0, revisionFloor) + 1;
  if (!Number.isSafeInteger(revision) || revision > 9007199254740991)
    throw new Error("Descriptive revision exhausted");
  const envelope = (listings: Record<string, unknown>[], value = revision) => ({
    listing_delivery_schema: 1,
    revision: value,
    withdrawn_ids: withdrawn,
    directory: { format_version: 11, listings },
  });
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope([])));
  if (envelopeBytes > byteLimit || byteLimit > maximum)
    throw new Error("Descriptive envelope exceeds existing byte bound");
  const { listings, retained, updated, omitted, omittedObservations } = fitListingAdmissions(
    proposedRows,
    envelopeBytes,
    byteLimit,
    now,
  );
  listings.sort((a, b) => String(a.id).localeCompare(String(b.id), "en"));
  const candidate = envelope(listings);
  if (
    previousDocument &&
    observationHash(previousDocument.directory) === observationHash(candidate.directory) &&
    observationHash(previousDocument.withdrawn_ids) === observationHash(candidate.withdrawn_ids)
  )
    return {
      bytes: previous!,
      revision: previousDocument.revision,
      changed: false,
      retained,
      updated,
      omitted,
      omittedObservations,
      canonical_records: raw.listings.length,
      delivered_records: listings.length,
    };
  const bytes = Buffer.from(JSON.stringify(candidate));
  if (bytes.length > byteLimit) throw new Error("Descriptive delivery exceeds its byte bound");
  return {
    bytes,
    revision,
    changed: true,
    retained,
    updated,
    omitted,
    omittedObservations,
    canonical_records: raw.listings.length,
    delivered_records: listings.length,
  };
}

function compatibleObservation(observation: Record<string, unknown>) {
  const { repository, releases } = observation;
  if (
    (observation.provider ?? "github") !== "github" ||
    typeof repository !== "string" ||
    !Array.isArray(releases)
  )
    return observation;
  return {
    ...observation,
    releases: releases.map((release: unknown) => {
      if (
        !isRecord(release) ||
        typeof release.version !== "string" ||
        !release.version.includes("/") ||
        !Array.isArray(release.assets)
      )
        return release;
      const tag = release.version;
      return {
        ...release,
        assets: release.assets.map((asset: unknown) =>
          isRecord(asset) && typeof asset.url === "string" && typeof asset.name === "string"
            ? {
                ...asset,
                url: compatibleGithubListingAssetUrl(asset.url, repository, tag, asset.name),
              }
            : asset,
        ),
      };
    }),
  };
}

/** The caller must obtain this report from the existing compiled verifier.
 * No path is guessed, and an unreferenced blob is never a signed last-good. */
export async function verifiedPriorListing(
  prior: string,
  verification: unknown,
): Promise<Buffer | null> {
  if (
    !isRecord(verification) ||
    verification.schema_version !== 1 ||
    verification.authority !== "none" ||
    !Array.isArray(verification.files)
  )
    throw new Error("Prior repository verification unavailable");
  const identity = publishedTargets(prior)[listingDeliveryTarget];
  if (identity === undefined) return null;
  if (!/^[a-f0-9]{64}$/u.test(identity)) throw new Error("Prior target digest is invalid");
  const target = `targets/${identity}.${listingDeliveryTarget}`;
  const verifiedFiles: unknown[] = verification.files;
  const entry = verifiedFiles.find((raw) => isRecord(raw) && raw.target === target);
  if (!isRecord(entry) || entry.sha256 !== identity)
    throw new Error("Prior listing is not referenced by verified repository inventory");
  const bytes = await readControllerToolFile(path.join(prior, target), maximum);
  if (bytes.length !== entry.bytes || hash(bytes) !== identity)
    throw new Error("Prior signed listing bytes differ");
  delivery(parseCatalogSource(bytes.toString("utf8")));
  return bytes;
}

export async function priorListingForRenewal(prior: string, canonicalRecords: number) {
  const identity = publishedTargets(prior)[listingDeliveryTarget];
  if (!identity || !/^[a-f0-9]{64}$/u.test(identity))
    throw new Error("Cannot establish the previous listing identity for renewal");
  const bytes = await readControllerToolFile(
    path.join(prior, `targets/${identity}.${listingDeliveryTarget}`),
    maximum,
  );
  if (hash(bytes) !== identity) throw new Error("Historical listing target digest differs");
  const old = delivery(parseCatalogSource(bytes.toString("utf8")));
  return {
    bytes,
    revision: old.revision,
    changed: false,
    retained: 0,
    updated: 0,
    omitted: [],
    omittedObservations: [],
    canonical_records: canonicalRecords,
    delivered_records: old.directory.listings.length,
  };
}

function isolatedEnvironment(root: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    APPDATA: path.join(root, "config"),
    LOCALAPPDATA: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    PORTCOVE_PREFERENCES: path.join(root, "preferences.json"),
  };
  for (const name of ["home", "config", "cache", "data", "state"])
    mkdirSync(path.join(root, name), { recursive: true });
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.PORTCOVE_GITHUB_TOKEN;
  return env;
}
export async function prepareObservationBundle(options: {
  bundle: string;
  canonical: string;
  catalog: string;
  prior: string | null;
  output: string;
  cli: string;
  tools: string;
  root: string;
  offlineTargets: string;
  observe?: boolean;
  readObservation?: () => Promise<UpstreamInput>;
}) {
  if (existsSync(options.output)) throw new Error("Observation bundle output already exists");
  mkdirSync(options.output, { recursive: true });
  const workspace = path.join(options.output, "observation-work");
  mkdirSync(workspace);
  const environment = isolatedEnvironment(workspace);
  const diagnostics: string[] = [];
  const canonicalBytes = await readControllerToolFile(options.canonical, maximum);
  const catalogBytes = await readControllerToolFile(options.catalog, 32 * 1024 * 1024);
  const canonical = directory(parseCatalogSource(canonicalBytes.toString("utf8")));
  const current = parseCatalogSource(catalogBytes.toString("utf8"));
  const cli = (args: string[]) =>
    execFileSync(options.cli, args, {
      env: environment,
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
  const canonicalPath = path.join(workspace, "canonical.json");
  writeFileSync(canonicalPath, canonicalBytes, { flag: "wx" });
  const baseline: unknown = JSON.parse(
    cli([
      "--json",
      "catalog",
      "inspect-listings",
      "--path",
      canonicalPath,
      "--format-version",
      "11",
    ]),
  );
  if (!isRecord(baseline) || baseline.ok !== true)
    throw new Error("Core could not export the exact canonical directory for format 11");
  const compatible = directory(baseline.data);
  let previous: Buffer | null = null;
  const revisionFloor = 0;
  let renewal: Awaited<ReturnType<typeof priorListingForRenewal>> | undefined;
  let observerRevision = options.observe === false ? "offline" : "unavailable";
  if (options.prior) {
    if (!existsSync(path.join(options.prior, "metadata/timestamp.json")))
      throw new Error(
        "Previous catalog timestamp unavailable; cannot establish initial listing admission",
      );
    try {
      const prior = path.join(workspace, "verified-prior");
      copyPriorRepository(options.prior, prior);
      const config = path.join(workspace, "verify.json");
      const root = await readControllerToolFile(options.root, 1024 * 1024),
        top = await readControllerToolFile(options.offlineTargets, maximum);
      writeFileSync(
        config,
        JSON.stringify({
          schema_version: 1,
          initial_root_profile: "single-owner-one-of-one-v1",
          trusted_root: path.resolve(options.root),
          trusted_root_sha256: hash(root),
          offline_targets: path.resolve(options.offlineTargets),
          offline_targets_sha256: hash(top),
          repository: prior,
        }),
      );
      const report: unknown = JSON.parse(
        execFileSync(options.tools, ["verify-definition-repository", config], {
          env: environment,
          timeout: 90000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        }),
      );
      previous = await verifiedPriorListing(prior, report);
    } catch (error) {
      // The signer authenticates the historical target before renewal. Never use
      // an unauthenticated observation, or replace a directory we could not read.
      renewal = await priorListingForRenewal(options.prior, canonical.listings.length);
      diagnostics.push(
        `retained exact previous listing bytes for historical signer verification; prior unavailable: ${error instanceof Error ? error.message.slice(0, 300) : "verification failed"}`,
      );
    }
  }
  if (!isRecord(current) || !Array.isArray(current.ports))
    throw new Error("Operational catalog requires a complete port array");
  const operationalIds = new Set<string>();
  for (const port of current.ports) {
    if (!isRecord(port) || typeof port.id !== "string" || operationalIds.has(port.id))
      throw new Error("Operational catalog has an invalid or duplicate port identity");
    operationalIds.add(port.id);
  }
  const now = Date.now();
  let candidates: Record<string, unknown>[] = [];
  if (!renewal && options.observe !== false) {
    try {
      const input = await (
        options.readObservation ??
        (() =>
          readUpstreamObservations((revision, file) =>
            execFileSync("git", ["show", `${revision}:${file}`], {
              maxBuffer: 16 * 1024 * 1024,
              timeout: 15000,
            }),
          ))
      )();
      observerRevision = input.revision;
      candidates = completedListingCandidates(input, current, canonical, now, diagnostics);
    } catch (error) {
      diagnostics.push(
        `observer unavailable: ${error instanceof Error ? error.message.slice(0, 300) : "read failed"}`,
      );
    }
  }
  let projected =
    renewal ??
    projectListingDelivery(
      canonical,
      candidates,
      previous,
      revisionFloor,
      maximum,
      compatible,
      operationalIds,
      now,
    );
  const inspect = (bytes: Buffer) => {
    const candidate = path.join(workspace, "listings.json");
    writeFileSync(candidate, bytes);
    return cli(["--json", "catalog", "inspect-listings", "--path", candidate]);
  };
  // Optional bad enrichment cannot stall independent catalog publication/renewal.
  try {
    inspect(
      Buffer.from(JSON.stringify(delivery(JSON.parse(projected.bytes.toString())).directory)),
    );
  } catch (error) {
    if (renewal) throw error;
    diagnostics.push(
      "observer candidates failed Core validation; retaining prior applicable observations",
    );
    projected = projectListingDelivery(
      canonical,
      [],
      previous,
      revisionFloor,
      maximum,
      compatible,
      operationalIds,
      now,
    );
    inspect(
      Buffer.from(JSON.stringify(delivery(JSON.parse(projected.bytes.toString())).directory)),
    );
  }
  if (
    hash(await readControllerToolFile(options.canonical, maximum)) !== hash(canonicalBytes) ||
    hash(await readControllerToolFile(options.catalog, 32 * 1024 * 1024)) !== hash(catalogBytes)
  )
    throw new Error("Canonical inputs changed during observation projection");
  const bundle = path.join(options.output, "bundle");
  cpSync(options.bundle, bundle, { recursive: true });
  const destination = path.join(bundle, listingDeliveryTarget);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, projected.bytes, { flag: "wx" });
  const report = {
    bundle,
    revision: projected.revision,
    changed: projected.changed,
    retained: projected.retained,
    updated: projected.updated,
    source_candidates: candidates.length,
    observer_revision: observerRevision,
    canonical_sha256: hash(canonicalBytes),
    catalog_sha256: hash(catalogBytes),
    canonical_records: projected.canonical_records,
    delivered_records: projected.delivered_records,
    omitted: projected.omitted,
    omitted_observations: projected.omittedObservations,
    not_projected_records: projected.canonical_records - projected.delivered_records,
    target_bytes: projected.bytes.length,
    projection_scope:
      "Reviewed operational and previously signed guides with bounded optional observations; omitted discovery rows retain bundled fallback. Coverage is not complete provider history.",
    diagnostics,
    scope:
      "descriptive-observation-only; canonical fields unchanged; no operation or publication grant",
  };
  writeFileSync(path.join(options.output, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      bundle: { type: "string" },
      canonical: { type: "string" },
      catalog: { type: "string" },
      prior: { type: "string" },
      output: { type: "string" },
      cli: { type: "string" },
      tools: { type: "string" },
      root: { type: "string" },
      "offline-targets": { type: "string" },
      offline: { type: "boolean", default: false },
    },
  });
  for (const key of [
    "bundle",
    "canonical",
    "catalog",
    "output",
    "cli",
    "tools",
    "root",
    "offline-targets",
  ] as const)
    if (!values[key]) throw new Error(`--${key} is required`);
  console.log(
    JSON.stringify(
      await prepareObservationBundle({
        bundle: path.resolve(values.bundle!),
        canonical: path.resolve(values.canonical!),
        catalog: path.resolve(values.catalog!),
        prior: values.prior && values.prior !== "none" ? path.resolve(values.prior) : null,
        output: path.resolve(values.output!),
        cli: path.resolve(values.cli!),
        tools: path.resolve(values.tools!),
        root: path.resolve(values.root!),
        offlineTargets: path.resolve(values["offline-targets"]!),
        observe: !values.offline,
      }),
    ),
  );
}
