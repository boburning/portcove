/** Existing observer facts -> the existing signed descriptive target. No executable authority. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fitListingAdmissions } from "./listing-admission-budget.mts";
import { isRecord } from "./runtime-values.mts";
import { parseCatalogSource, typedIgdbScene } from "./catalog-authoring.mts";
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
import {
  observeScummvmGameData,
  projectScummvmGameData,
  withoutScummvmGameData,
  type ScummvmGameDataObservation,
} from "./scummvm-game-data-observation.mts";

import {
  compactListingCarrier,
  compactListingDecodedMaximum,
  compactListingDeliveryTarget,
  decodeRetainedCompactListing,
  encodeCompactListing,
  listingDeliveryMaximum as maximum,
  listingDeliveryTarget,
} from "./listing-directory-carrier.mts";

export { listingDeliveryTarget };
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const legacyListingFormat = 11;
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
    Number(value.format_version) > 13 ||
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
/** Once compact delivery is active an exact authored legacy target may add
 * safety withdrawals, keeping all other signed legacy rows untouched. */
export function reviewedLegacyWithdrawal(
  prior: Buffer,
  authored: Buffer,
  activeRevision: number,
): Delivery {
  const original = delivery(parseCatalogSource(prior.toString("utf8")));
  const desired = delivery(parseCatalogSource(authored.toString("utf8")));
  const ids = new Set(desired.withdrawn_ids);
  if (
    desired.revision <= activeRevision ||
    ids.size !== desired.withdrawn_ids.length ||
    ids.size <= original.withdrawn_ids.length ||
    original.withdrawn_ids.some((id) => !ids.has(id)) ||
    desired.withdrawn_ids.some(
      (id) => typeof id !== "string" || id.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id),
    )
  )
    throw new Error("Reviewed legacy listing replacement must advance and add a safety withdrawal");
  const expected = {
    ...original,
    revision: desired.revision,
    withdrawn_ids: desired.withdrawn_ids,
    directory: {
      ...original.directory,
      listings: original.directory.listings.filter((row) => !ids.has(String(row.id))),
    },
  };
  if (observationHash(expected) !== observationHash(desired))
    throw new Error("Reviewed legacy listing withdrawal changes other facts");
  return desired;
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
    observationHash(prior.facts) === observationHash(next.facts)
  );
}

function compactDirectoryFormat(canonical: Directory, previous: Delivery | null) {
  return Math.max(
    legacyListingFormat,
    canonical.format_version,
    previous?.directory.format_version ?? 0,
  );
}

export function requireCompactListingReader(report: unknown, format: number) {
  if (
    !isRecord(report) ||
    report.ok !== true ||
    report.command !== "capabilities" ||
    !isRecord(report.data) ||
    report.data.product !== "Portcove" ||
    typeof report.data.product_version !== "string" ||
    !report.data.product_version.length ||
    !Array.isArray(report.data.listing_delivery_carriers) ||
    !report.data.listing_delivery_carriers.includes(compactListingCarrier) ||
    !Array.isArray(report.data.listing_formats) ||
    !report.data.listing_formats.includes(format)
  )
    throw new Error(
      "The reviewed released CLI must support " +
        compactListingCarrier +
        " and listing format " +
        format,
    );
  return report.data.product_version;
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
  reviewedWithdrawals: readonly string[] = [],
  requireComplete = false,
  scummvmGameData?: ScummvmGameDataObservation,
) {
  const raw = directory(canonical);
  const previousDocument = previous
    ? delivery(parseCatalogSource(previous.toString("utf8")))
    : null;
  const format = requireComplete
    ? compactDirectoryFormat(raw, previousDocument)
    : legacyListingFormat;
  const baseline = directory(compatible ?? raw);
  const identities = new Set(raw.listings.map((listing) => listing.id));
  if (
    baseline.format_version !== format ||
    baseline.listings.length !== raw.listings.length ||
    baseline.listings.some((listing) => !identities.has(listing.id))
  )
    throw new Error("Core compatibility projection changed canonical identities or format");
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
  const withdrawn = [
    ...new Set([...(previousDocument?.withdrawn_ids ?? []), ...reviewedWithdrawals]),
  ];
  if (withdrawn.length > 10000)
    throw new Error(
      "Listing withdrawals exceed their count bound; retaining last-good publication",
    );
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
        (requireComplete ||
          previousListings.has(listing.id) ||
          operationalIds.has(String(listing.id)) ||
          updates.has(String(listing.id)) ||
          isRecord(listing.upstream_observation)),
    )
    .map((listing) => {
      const result = structuredClone(listing);
      const old = previousListings.get(listing.id);
      let comparable = listing;
      // Pre-format-13 signed rows could not carry typed scenes.
      if (
        old &&
        format >= 13 &&
        previousDocument &&
        previousDocument.directory.format_version < 13 &&
        Array.isArray(listing.media) &&
        listing.media.some(typedIgdbScene)
      ) {
        comparable = { ...listing };
        const media = listing.media.filter((asset) => !typedIgdbScene(asset));
        if (media.length > 0) comparable.media = media;
        else delete comparable.media;
      }
      const prior =
        old &&
        listingDeclarationHash(withoutScummvmGameData(old)) === listingDeclarationHash(comparable) &&
        isRecord(old.upstream_observation)
          ? old.upstream_observation
          : undefined;
      const authored = isRecord(result.upstream_observation)
        ? result.upstream_observation
        : undefined;
      if (prior && (!authored || observedAt(prior) > observedAt(authored)))
        result.upstream_observation = structuredClone(prior);
      const held = isRecord(result.upstream_observation) ? result.upstream_observation : undefined;
      const proposed = updates.get(String(listing.id));
      if (
        proposed &&
        (!held ||
          (proposed.status === "complete" &&
            observedAt(proposed) >= observedAt(held) &&
            !retainFreshObservation(held, proposed, now)))
      )
        result.upstream_observation = structuredClone(proposed);
      return {
        listing: result,
        prior,
        required: previousListings.has(listing.id) || operationalIds.has(String(listing.id)),
        retained: !!prior,
        updated:
          result.upstream_observation === undefined
            ? false
            : observationHash(result.upstream_observation) !==
              observationHash(old?.upstream_observation ?? null),
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
    directory: { format_version: format, listings },
  });
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope([])));
  const maximumForMode = requireComplete ? compactListingDecodedMaximum : maximum;
  if (envelopeBytes > byteLimit || byteLimit > maximumForMode)
    throw new Error("Descriptive envelope exceeds its byte bound");
  const { listings, retained, updated, omitted, omittedObservations } = requireComplete
    ? {
        listings: proposedRows.map((row) => row.listing),
        retained: proposedRows.filter((row) => row.retained).length,
        updated: proposedRows.filter((row) => row.updated).length,
        omitted: [],
        omittedObservations: [],
      }
    : fitListingAdmissions(proposedRows, envelopeBytes, byteLimit, now);
  listings.sort((a, b) => String(a.id).localeCompare(String(b.id), "en"));
  // Spend only the bytes left after the ordinary identity and observation
  // admission decisions. Extra guidance cannot displace another listing.
  let remaining = byteLimit - Buffer.byteLength(JSON.stringify(envelope(listings)));
  let scummvmGuides = 0;
  for (const listing of listings) {
    const before = listing.manual_setup;
    const previousListing = previousListings.get(listing.id);
    projectScummvmGameData(listing, previousListing, scummvmGameData);
    if (listing.manual_setup === before) continue;
    const used = () =>
      Buffer.byteLength(JSON.stringify(listing.manual_setup)) -
      Buffer.byteLength(JSON.stringify(before));
    if (used() > remaining) {
      listing.manual_setup = before;
      projectScummvmGameData(listing, previousListing, undefined);
      if (listing.manual_setup === before) continue;
      if (used() > remaining) {
        listing.manual_setup = before;
        continue;
      }
    }
    remaining -= used();
    scummvmGuides += 1;
  }
  const candidate = envelope(listings);
  const bytes = Buffer.from(JSON.stringify(candidate));
  if (bytes.length > byteLimit)
    throw new Error(
      requireComplete
        ? "Complete compact listing exceeds its decoded byte bound; retaining last-good publication"
        : "Descriptive delivery exceeds its byte bound",
    );
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
      scummvm_guides: scummvmGuides,
    };
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
    scummvm_guides: scummvmGuides,
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

function readDeliveryCarrier(wire: Buffer, carrier: string) {
  const bytes =
    carrier === compactListingDeliveryTarget ? decodeRetainedCompactListing(wire) : wire;
  return { bytes, document: delivery(parseCatalogSource(bytes.toString("utf8"))) };
}

/** The caller must obtain this report from the existing compiled verifier.
 * No path is guessed, and an unreferenced blob is never a signed last-good. */
export async function verifiedPriorListing(
  prior: string,
  verification: unknown,
  carrier = listingDeliveryTarget,
): Promise<Buffer | null> {
  if (
    !isRecord(verification) ||
    verification.schema_version !== 1 ||
    verification.authority !== "none" ||
    !Array.isArray(verification.files)
  )
    throw new Error("Prior repository verification unavailable");
  const identity = publishedTargets(prior)[carrier];
  if (identity === undefined) return null;
  if (!/^[a-f0-9]{64}$/u.test(identity)) throw new Error("Prior target digest is invalid");
  const target = `targets/${identity}.${carrier}`;
  const verifiedFiles: unknown[] = verification.files;
  const entry = verifiedFiles.find((raw) => isRecord(raw) && raw.target === target);
  if (!isRecord(entry) || entry.sha256 !== identity)
    throw new Error("Prior listing is not referenced by verified repository inventory");
  const bytes = await readControllerToolFile(path.join(prior, target), maximum);
  if (bytes.length !== entry.bytes || hash(bytes) !== identity)
    throw new Error("Prior signed listing bytes differ");
  readDeliveryCarrier(bytes, carrier);
  return bytes;
}

export async function priorListingForRenewal(
  prior: string,
  canonicalRecords: number,
  carrier = listingDeliveryTarget,
) {
  const identity = publishedTargets(prior)[carrier];
  if (!identity || !/^[a-f0-9]{64}$/u.test(identity))
    throw new Error("Cannot establish the previous listing identity for renewal");
  const wire = await readControllerToolFile(
    path.join(prior, `targets/${identity}.${carrier}`),
    maximum,
  );
  if (hash(wire) !== identity) throw new Error("Historical listing target digest differs");
  const { bytes, document: old } = readDeliveryCarrier(wire, carrier);
  return {
    bytes,
    wire,
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
  compact?: boolean;
  releasedReader?: { cli: string; sha256: string };
  readObservation?: () => Promise<UpstreamInput>;
  readScummvmObservation?: () => Promise<ScummvmGameDataObservation>;
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
  const authoredPath = path.join(options.bundle, listingDeliveryTarget);
  const authoredLegacy = existsSync(authoredPath)
    ? await readControllerToolFile(authoredPath, maximum)
    : null;
  let previous: Buffer | null = null;
  let previousWire: Buffer | null = null;
  let retainedLegacy: Buffer | null = null;
  let useCompact = options.compact === true;
  let priorCompact = false;
  let withdrawal: Delivery | undefined;
  let renewal: Awaited<ReturnType<typeof priorListingForRenewal>> | undefined;
  let observerRevision = options.observe === false ? "offline" : "unavailable";
  if (options.prior) {
    if (!existsSync(path.join(options.prior, "metadata/timestamp.json")))
      throw new Error(
        "Previous catalog timestamp unavailable; cannot establish initial listing admission",
      );
    priorCompact = Object.hasOwn(publishedTargets(options.prior), compactListingDeliveryTarget);
    useCompact ||= priorCompact;
    const previousCarrier = priorCompact ? compactListingDeliveryTarget : listingDeliveryTarget;
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
      previousWire = await verifiedPriorListing(prior, report, previousCarrier);
      previous = previousWire ? readDeliveryCarrier(previousWire, previousCarrier).bytes : null;
      if (useCompact)
        retainedLegacy = priorCompact ? await verifiedPriorListing(prior, report) : previous;
    } catch (error) {
      // The signer authenticates the historical target before renewal. Never use
      // an unauthenticated observation, or replace a directory we could not read.
      renewal = await priorListingForRenewal(
        options.prior,
        canonical.listings.length,
        previousCarrier,
      );
      previousWire = renewal.wire;
      // An expired baseline can renew its exact existing representation. First
      // compact publication requires a separately current authenticated legacy.
      useCompact = priorCompact;
      if (useCompact)
        retainedLegacy = (await priorListingForRenewal(options.prior, canonical.listings.length))
          .wire;
      diagnostics.push(
        `retained exact previous listing bytes for historical signer verification; prior unavailable: ${error instanceof Error ? error.message.slice(0, 300) : "verification failed"}`,
      );
    }
  }
  if (useCompact && !retainedLegacy)
    throw new Error("Compact listing publication requires a retained legacy listing");
  if (authoredLegacy && (!priorCompact || !retainedLegacy))
    throw new Error("Reviewed legacy withdrawal requires existing compact and legacy targets");
  if (authoredLegacy && retainedLegacy && !authoredLegacy.equals(retainedLegacy)) {
    if (renewal) {
      diagnostics.push("Deferred the authored withdrawal until the exact signed prior is current");
    } else if (previous) {
      withdrawal = reviewedLegacyWithdrawal(
        retainedLegacy,
        authoredLegacy,
        delivery(parseCatalogSource(previous.toString("utf8"))).revision,
      );
      retainedLegacy = authoredLegacy;
    }
  }
  const previousDocument = previous
    ? delivery(parseCatalogSource(previous.toString("utf8")))
    : null;
  const format = renewal
    ? delivery(parseCatalogSource(renewal.bytes.toString("utf8"))).directory.format_version
    : useCompact
      ? compactDirectoryFormat(canonical, previousDocument)
      : legacyListingFormat;
  let releasedReader: { version: string; sha256: string } | undefined;
  if (
    !renewal &&
    useCompact &&
    (!priorCompact || format > (previousDocument?.directory.format_version ?? 0))
  ) {
    if (!options.releasedReader || !/^[a-f0-9]{64}$/u.test(options.releasedReader.sha256))
      throw new Error(
        "Compact listing activation requires a reviewed released CLI and its exact SHA-256",
      );
    const bytes = await readControllerToolFile(options.releasedReader.cli);
    const digest = hash(bytes);
    if (digest !== options.releasedReader.sha256)
      throw new Error("Reviewed released CLI SHA-256 differs");
    const frozen = path.join(
      workspace,
      process.platform === "win32" ? "released-reader.exe" : "released-reader",
    );
    writeFileSync(frozen, bytes, { flag: "wx", mode: 0o700 });
    const report: unknown = JSON.parse(
      execFileSync(frozen, ["--json", "capabilities"], {
        env: environment,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      }),
    );
    releasedReader = {
      version: requireCompactListingReader(report, format),
      sha256: digest,
    };
  }
  let compatible: Directory | undefined;
  if (!renewal) {
    const baseline: unknown = JSON.parse(
      cli([
        "--json",
        "catalog",
        "inspect-listings",
        "--path",
        canonicalPath,
        "--format-version",
        String(format),
      ]),
    );
    if (!isRecord(baseline) || baseline.ok !== true)
      throw new Error("Core could not export the exact canonical directory for format " + format);
    compatible = directory(baseline.data);
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
  let gameData: ScummvmGameDataObservation | undefined;
  if (!renewal && options.observe !== false) {
    try {
      gameData = await (options.readScummvmObservation ?? observeScummvmGameData)();
    } catch (error) {
      diagnostics.push(
        `ScummVM game data unavailable: ${error instanceof Error ? error.message.slice(0, 200) : "read failed"}`,
      );
    }
  }
  const project = (
    observations: readonly Record<string, unknown>[],
    scummvm?: ScummvmGameDataObservation,
  ) =>
    projectListingDelivery(
      canonical,
      observations,
      previous,
      withdrawal?.revision ?? 0,
      useCompact ? compactListingDecodedMaximum : maximum,
      compatible,
      operationalIds,
      now,
      withdrawal?.withdrawn_ids,
      useCompact,
      scummvm,
    );
  let projected = renewal ?? project(candidates, gameData);
  const inspect = (bytes: Buffer) => {
    const candidate = path.join(workspace, "listings.json");
    writeFileSync(candidate, bytes);
    return cli(["--json", "catalog", "inspect-listings", "--path", candidate]);
  };
  if (!useCompact) {
    // Legacy publication keeps its existing optional-enrichment fallback.
    try {
      inspect(Buffer.from(JSON.stringify(delivery(JSON.parse(projected.bytes.toString())).directory)));
    } catch (error) {
      if (renewal) throw error;
      diagnostics.push(
        "observer candidates failed Core validation; retaining prior applicable observations",
      );
      projected = project([], gameData);
      inspect(Buffer.from(JSON.stringify(delivery(JSON.parse(projected.bytes.toString())).directory)));
    }
  }
  // Stage the complete authenticated representation before copying the output bundle.
  // Compact validation below uses the normal publication inspector on these exact bytes.
  const compactWire = useCompact
    ? previousWire && priorCompact && !projected.changed
      ? previousWire
      : encodeCompactListing(projected.bytes)
    : null;
  if (
    hash(await readControllerToolFile(options.canonical, maximum)) !== hash(canonicalBytes) ||
    hash(await readControllerToolFile(options.catalog, 32 * 1024 * 1024)) !== hash(catalogBytes)
  )
    throw new Error("Canonical inputs changed during observation projection");
  const bundle = path.join(options.output, "bundle");
  cpSync(options.bundle, bundle, { recursive: true });
  const destination = path.join(bundle, listingDeliveryTarget);
  mkdirSync(path.dirname(destination), { recursive: true });
  if (authoredLegacy) {
    const copied = await readControllerToolFile(destination, maximum);
    if (!copied.equals(authoredLegacy))
      throw new Error("Reviewed legacy listing input changed during projection");
    unlinkSync(destination);
  }
  writeFileSync(destination, retainedLegacy ?? projected.bytes, { flag: "wx" });
  if (compactWire) {
    writeFileSync(path.join(bundle, compactListingDeliveryTarget), compactWire, { flag: "wx" });
    cli(["--json", "catalog", "inspect-definition-publication", bundle]);
  }
  const report = {
    bundle,
    revision: projected.revision,
    listing_format: format,
    ...(releasedReader ? { released_reader: releasedReader } : {}),
    changed: projected.changed,
    retained: projected.retained,
    updated: projected.updated,
    source_candidates: candidates.length,
    observer_revision: observerRevision,
    scummvm_guides: "scummvm_guides" in projected ? projected.scummvm_guides : null,
    scummvm_game_data: gameData
      ? {
          revision: gameData.revision,
          blob: gameData.blob,
          sha256: gameData.sha256,
          observed_game_keys: gameData.editions.size,
        }
      : null,
    canonical_sha256: hash(canonicalBytes),
    catalog_sha256: hash(catalogBytes),
    canonical_records: projected.canonical_records,
    delivered_records: projected.delivered_records,
    omitted: projected.omitted,
    omitted_observations: projected.omittedObservations,
    not_projected_records: projected.canonical_records - projected.delivered_records,
    target_bytes: compactWire?.length ?? projected.bytes.length,
    ...(compactWire
      ? {
          decoded_bytes: projected.bytes.length,
          transport_changed: !compactWire.equals(previousWire ?? Buffer.alloc(0)),
          ...(withdrawal && authoredLegacy
            ? {
                reviewed_legacy_sha256: hash(authoredLegacy),
                reviewed_legacy_revision: withdrawal.revision,
              }
            : {}),
        }
      : {}),
    projection_scope: renewal
      ? "Exact prior signed listing directory for signer-verified renewal."
      : useCompact
        ? "Complete canonical directory with applicable observations and explicit withdrawals."
        : "Reviewed operational and previously signed guides with bounded optional observations; omitted discovery rows retain bundled fallback. Coverage is not complete provider history.",
    diagnostics,
    scope: withdrawal
      ? "reviewed descriptive withdrawal; no operation or publication grant"
      : "descriptive-observation-only; canonical fields unchanged; no operation or publication grant",
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
      compact: { type: "boolean", default: false },
      "released-reader": { type: "string" },
      "released-reader-sha256": { type: "string" },
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
  if (Boolean(values["released-reader"]) !== Boolean(values["released-reader-sha256"]))
    throw new Error("--released-reader and --released-reader-sha256 are required together");
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
        compact: values.compact,
        ...(values["released-reader"] && values["released-reader-sha256"]
          ? {
              releasedReader: {
                cli: path.resolve(values["released-reader"]),
                sha256: values["released-reader-sha256"],
              },
            }
          : {}),
      }),
    ),
  );
}
