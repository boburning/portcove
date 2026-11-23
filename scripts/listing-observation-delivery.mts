/** Existing observer facts -> the existing signed descriptive target. No executable authority. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  acquireCatalogReleasedReader,
  liveReleasedReaderSources,
} from "./catalog-released-reader.mts";
import type { AcquiredReleasedReader } from "./catalog-released-reader.mts";

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
const latestListingFormat = 15;
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
    Number(value.format_version) > latestListingFormat ||
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
const legacyHold = "download_block_reason";
const held = (row: Record<string, unknown> | undefined) =>
  typeof row?.[legacyHold] === "string" && row[legacyHold].length > 0;
const withoutHold = (row: Record<string, unknown>) => {
  const { [legacyHold]: _, ...rest } = row;
  return rest;
};
/** A legacy successor never carries observations; they stay compact facts. */
const legacyRow = (row: Record<string, unknown>) => {
  const { upstream_observation: _, ...rest } = row;
  return rest;
};
function uniqueRows(document: Delivery) {
  const rows = new Map<string, Record<string, unknown>>();
  for (const row of document.directory.listings) {
    const id = String(row.id);
    if (rows.has(id))
      throw new Error("Reviewed legacy listing replacement repeats a listing identity");
    rows.set(id, row);
  }
  return rows;
}

/** The facts a legacy hold is bound to: Core's format-11 export of the current
 * canonical directory and the identities the compact target withdraws. */
interface LegacyHoldBinding {
  legacy: unknown;
  compactWithdrawn: readonly string[];
}
function boundRows(binding: LegacyHoldBinding) {
  const legacy = directory(binding.legacy);
  if (legacy.format_version !== legacyListingFormat)
    throw new Error("Legacy hold binding requires Core's format-11 export");
  const withdrawn = new Set(binding.compactWithdrawn);
  const rows = new Map(
    legacy.listings
      .filter((row) => !withdrawn.has(String(row.id)))
      .map((row) => [String(row.id), legacyRow(row)]),
  );
  return (id: string) => {
    const row = rows.get(id);
    if (!row) throw new Error("Reviewed legacy listing hold has no unwithdrawn compact row");
    return row;
  };
}

/** Once compact delivery is active the legacy target stays fixed for format-11
 * readers. A successor may add safety withdrawals and may add or keep a legacy
 * download hold. A hold it adds or retells carries Core's current format-11
 * hold text, and a row it adds is exactly Core's format-11 export of that
 * unwithdrawn compact listing. It never drops or clears a hold, resurrects a
 * withdrawal or changes other legacy facts. The signer enforces the same rule
 * against the same publication's compact row (release-tools
 * `check_legacy_successor`). */
export function reviewedLegacySuccessor(
  prior: Buffer,
  authored: Buffer,
  activeRevision: number,
  binding: LegacyHoldBinding,
): Delivery {
  const original = delivery(parseCatalogSource(prior.toString("utf8")));
  const desired = delivery(parseCatalogSource(authored.toString("utf8")));
  const ids = new Set(desired.withdrawn_ids);
  if (
    desired.revision <= activeRevision ||
    ids.size !== desired.withdrawn_ids.length ||
    desired.withdrawn_ids.some(
      (id) => typeof id !== "string" || id.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id),
    )
  )
    throw new Error("Reviewed legacy listing replacement must advance the listing revision");
  if (original.withdrawn_ids.some((id) => !ids.has(id)))
    throw new Error("Reviewed legacy listing replacement removed a safety withdrawal");
  const current = boundRows(binding);
  const before = uniqueRows(original);
  const after = uniqueRows(desired);
  let tightened = false;
  for (const [id, row] of after) {
    const old = before.get(id);
    if (ids.has(id)) throw new Error("Reviewed legacy listing withdrawal changes other facts");
    if (old && observationHash(old) === observationHash(row)) continue;
    if (old && observationHash(withoutHold(old)) !== observationHash(withoutHold(row)))
      throw new Error("Reviewed legacy listing withdrawal changes other facts");
    if (!held(row))
      throw new Error(
        old
          ? "Reviewed legacy listing replacement may not clear a download hold"
          : "Reviewed legacy listing replacement may add only a held row",
      );
    if (old) {
      if (current(id)[legacyHold] !== row[legacyHold])
        throw new Error("Reviewed legacy listing hold differs from Core's format-11 listing");
    } else if (observationHash(current(id)) !== observationHash(row))
      throw new Error("Reviewed legacy listing added row differs from Core's format-11 listing");
    tightened = true;
  }
  for (const [id, old] of before)
    if (!after.has(id) && !ids.has(id))
      throw new Error(
        held(old)
          ? "Reviewed legacy listing replacement may not clear a download hold"
          : "Reviewed legacy listing replacement removed a row without a safety withdrawal",
      );
  if (!tightened && ids.size === original.withdrawn_ids.length)
    throw new Error(
      "Reviewed legacy listing replacement must add a safety withdrawal or download hold",
    );
  const frame = (value: Delivery) => ({
    ...value,
    revision: 0,
    withdrawn_ids: [],
    directory: { ...value.directory, listings: [] },
  });
  if (observationHash(frame(original)) !== observationHash(frame(desired)))
    throw new Error("Reviewed legacy listing withdrawal changes other facts");
  return desired;
}

/** After compact activation, carry Core's current format-11 download hold to
 * format-11 readers. A delivered row receives the current hold text. A row the
 * target does not deliver is added, as Core's exact format-11 export, when its
 * hold is new or changed since the active compact publication (`activeCompact`);
 * its delivered values then replace the reader's bundled row. A hold that
 * predates activation on an undelivered row stays with the reader's bundled
 * row, as before activation. Only adds or retells a hold; a hold the current
 * catalog no longer has stays in place. Identities withdrawn by either carrier
 * are left to the withdrawal route. */
export function legacyHoldSuccessor(
  signed: Buffer,
  binding: LegacyHoldBinding,
  revision: number,
  activeCompact: { listings: readonly Record<string, unknown>[] },
): { bytes: Buffer; held: string[]; added: string[] } | null {
  const document = delivery(parseCatalogSource(signed.toString("utf8")));
  const projection = directory(binding.legacy);
  if (projection.format_version !== legacyListingFormat)
    throw new Error("Legacy hold binding requires Core's format-11 export");
  const excluded = new Set([...document.withdrawn_ids, ...binding.compactWithdrawn]);
  const current = new Map(projection.listings.map((row) => [String(row.id), row]));
  const changed: string[] = [];
  const listings = document.directory.listings.map((row) => {
    const reason = current.get(String(row.id))?.[legacyHold];
    if (
      excluded.has(String(row.id)) ||
      typeof reason !== "string" ||
      !reason.length ||
      row[legacyHold] === reason
    )
      return row;
    changed.push(String(row.id));
    return { ...row, [legacyHold]: reason };
  });
  const delivered = new Set(listings.map((row) => String(row.id)));
  const previous = new Map(activeCompact.listings.map((row) => [String(row.id), row]));
  const added: string[] = [];
  for (const row of projection.listings) {
    const id = String(row.id);
    if (
      delivered.has(id) ||
      excluded.has(id) ||
      !held(row) ||
      previous.get(id)?.[legacyHold] === row[legacyHold]
    )
      continue;
    listings.push(legacyRow(row));
    added.push(id);
  }
  if (!changed.length && !added.length) return null;
  listings.sort((a, b) => String(a.id).localeCompare(String(b.id), "en"));
  const bytes = Buffer.from(
    JSON.stringify({ ...document, revision, directory: { ...document.directory, listings } }),
  );
  if (bytes.length > maximum)
    throw new Error("Legacy hold successor exceeds the legacy listing byte bound");
  return { bytes, held: changed, added };
}

/** Optional observer enrichment never blocks compact publication. When the
 * complete candidate set fails Core validation, isolate the failing candidates
 * within a bounded number of validations, then validate the admitted set once
 * more. Legacy preparation keeps its all-or-nothing fallback instead. */
export async function isolateValidEnrichment<T>(
  candidates: readonly T[],
  accepts: (subset: readonly T[]) => boolean | Promise<boolean>,
  budget = 24,
): Promise<{ admitted: T[]; excluded: T[]; validations: number }> {
  let validations = 1;
  if (await accepts(candidates)) return { admitted: [...candidates], excluded: [], validations };
  const admitted: T[] = [];
  const excluded: T[] = [];
  const visit = async (group: readonly T[]) => {
    if (!group.length) return;
    if (group.length === 1 || validations >= budget) {
      excluded.push(...group);
      return;
    }
    const middle = Math.ceil(group.length / 2);
    for (const half of [group.slice(0, middle), group.slice(middle)]) {
      if (!half.length) continue;
      if (validations >= budget) {
        excluded.push(...half);
        continue;
      }
      validations++;
      if (await accepts([...admitted, ...half])) admitted.push(...half);
      else await visit(half);
    }
  };
  await visit(candidates);
  if (admitted.length) {
    validations++;
    if (!(await accepts(admitted))) {
      excluded.push(...admitted);
      admitted.length = 0;
    }
  }
  return { admitted, excluded, validations };
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
  reviewedWithdrawals: readonly string[] = [],
  requireComplete = false,
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
        listingDeclarationHash(old) === listingDeclarationHash(comparable) &&
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
        result.upstream_observation = structuredClone(proposed);
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

/** A carrier that must follow another signed listing revision is republished
 * above it, even when its decoded directory is otherwise unchanged. */
export function publishedAbove<T extends { bytes: Buffer; revision: number; changed: boolean }>(
  result: T,
  floor: number,
): T {
  if (result.revision > floor) return result;
  const document = delivery(parseCatalogSource(result.bytes.toString("utf8")));
  const revision = floor + 1;
  if (!Number.isSafeInteger(revision)) throw new Error("Descriptive revision exhausted");
  return {
    ...result,
    bytes: Buffer.from(JSON.stringify({ ...document, revision })),
    revision,
    changed: true,
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
  return retainedListingRenewal(wire, canonicalRecords, carrier);
}

/** The exact authenticated carrier, republished unchanged for the signer. */
function retainedListingRenewal(wire: Buffer, canonicalRecords: number, carrier: string) {
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

/** Core's own refusal of a staged candidate publication. Only this excludes
 * optional enrichment; every other inspection failure fails preparation. */
export class CoreInspectionRefusal extends Error {}

/** Core's JSON error exit codes for a refused input (`catalog inspect-*`). */
const coreRefusalExitCodes: Record<string, number> = {
  unsupported: 3,
  source_invalid: 5,
  verification: 11,
};

/** Classify a failed `portcove --json catalog inspect-*` run. A refusal is a
 * completed process whose exit code and JSON envelope both name a Core input
 * refusal. A timeout, signal, crash, output overflow, malformed output or any
 * other Core error code (state, usage, ...) is an inspection failure. */
export function classifyCoreInspectionFailure(error: unknown): CoreInspectionRefusal | Error {
  const failure = isRecord(error) ? error : {};
  const stdout =
    typeof failure.stdout === "string"
      ? failure.stdout
      : Buffer.isBuffer(failure.stdout)
        ? failure.stdout.toString("utf8")
        : "";
  if (failure.code === "ETIMEDOUT" || failure.code === "ENOBUFS" || failure.signal)
    return new Error(
      `Core publication inspection did not complete (${typeof failure.code === "string" ? failure.code : String(failure.signal)}); preparation stops instead of excluding candidates`,
    );
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    envelope = undefined;
  }
  const code =
    isRecord(envelope) && envelope.ok === false && isRecord(envelope.error)
      ? envelope.error.code
      : undefined;
  const message =
    isRecord(envelope) && isRecord(envelope.error) && typeof envelope.error.message === "string"
      ? envelope.error.message.slice(0, 300)
      : "";
  if (
    typeof code === "string" &&
    Object.hasOwn(coreRefusalExitCodes, code) &&
    failure.status === coreRefusalExitCodes[code]
  )
    return new CoreInspectionRefusal(
      `Core refused the candidate publication (${code}): ${message}`,
    );
  return new Error(
    `Core publication inspection failed without a candidate refusal (exit ${String(failure.status)}${typeof code === "string" ? `, ${code}` : ""}); preparation stops instead of excluding candidates${message ? `: ${message}` : ""}`,
  );
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
/** Run the frozen released reader's capability report in a private working
 * directory with no credentials, and require the compact carrier and `format`. */
async function probeReleasedReader(
  reader: { cli: string; sha256: string },
  format: number,
  workspace: string,
  environment: NodeJS.ProcessEnv,
) {
  if (!/^[a-f0-9]{64}$/u.test(reader.sha256))
    throw new Error(
      "Compact listing activation requires a reviewed released CLI and its exact SHA-256",
    );
  const bytes = await readControllerToolFile(reader.cli);
  const digest = hash(bytes);
  if (digest !== reader.sha256) throw new Error("Reviewed released CLI SHA-256 differs");
  const probe = mkdtempSync(path.join(workspace, "released-reader-"));
  const frozen = path.join(
    probe,
    process.platform === "win32" ? "released-reader.exe" : "released-reader",
  );
  writeFileSync(frozen, bytes, { flag: "wx", mode: 0o700 });
  const temporary = path.join(probe, "temp");
  mkdirSync(temporary);
  const probeEnvironment: NodeJS.ProcessEnv = {
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
  };
  for (const name of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "PORTCOVE_PREFERENCES",
    "SystemRoot",
  ])
    if (environment[name] !== undefined) probeEnvironment[name] = environment[name];
  const report: unknown = JSON.parse(
    execFileSync(frozen, ["--json", "capabilities"], {
      cwd: probe,
      env: probeEnvironment,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    }),
  );
  return { version: requireCompactListingReader(report, format), sha256: digest };
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
  /** Reviewed recovery from an active compact carrier; no workflow passes it. */
  returnToLegacy?: boolean;
  /** An explicit reviewed reader; rehearsal and tests override selection with it. */
  releasedReader?: { cli: string; sha256: string };
  /** Select and verify the reader from the protected Preview pointer, and
   * activate or advance compact delivery only when it is verified capable.
   * `Catalog publish` passes it (#1422). */
  officialReleasedReader?: boolean;
  /** Replaces the live, anonymous acquisition (rehearsal fixtures, tests). */
  acquireReleasedReader?: (privateRoot: string) => Promise<AcquiredReleasedReader>;
  readObservation?: () => Promise<UpstreamInput>;
  /** Per-invocation Core CLI deadline; tests shorten it. */
  cliTimeoutMs?: number;
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
      timeout: options.cliTimeoutMs ?? 30000,
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
  let signedLegacy: Buffer | null = null;
  let useCompact = options.compact === true;
  let priorCompact = false;
  let successor: Delivery | undefined;
  let renewal: Awaited<ReturnType<typeof priorListingForRenewal>> | undefined;
  let observerRevision = options.observe === false ? "offline" : "unavailable";
  let activationLegacy: Buffer | null = null;
  if (options.returnToLegacy && (options.compact || authoredLegacy))
    throw new Error("A legacy-only return publishes neither a compact nor a reviewed legacy input");
  const automatic = options.officialReleasedReader === true;
  if (automatic && (options.compact || options.returnToLegacy || options.releasedReader))
    throw new Error(
      "Official released-reader selection decides activation itself; it takes no --compact, return or explicit reader",
    );
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
      // Automatic first activation needs the current authenticated legacy.
      else if (automatic) activationLegacy = previous;
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
  // Automatic selection: verify the official reader only when activation or a
  // compact format increase needs it. A failed selection never stops ordinary
  // publication: a legacy-only prior stays legacy-only, and an active compact
  // prior republishes both exact authenticated carriers until it verifies.
  let officialReader: AcquiredReleasedReader | undefined;
  let releasedReader: { version: string; sha256: string } | undefined;
  let readerUnavailable: string | undefined;
  if (automatic && !renewal) {
    const previousCompact =
      priorCompact && previous ? delivery(parseCatalogSource(previous.toString("utf8"))) : null;
    const candidateFormat = compactDirectoryFormat(canonical, previousCompact);
    const needed = priorCompact
      ? candidateFormat > (previousCompact?.directory.format_version ?? 0)
      : activationLegacy !== null;
    if (needed) {
      try {
        if (candidateFormat !== latestListingFormat)
          throw new Error("Official activation targets listing format " + latestListingFormat);
        officialReader = await (
          options.acquireReleasedReader ??
          ((root: string) =>
            acquireCatalogReleasedReader(root, liveReleasedReaderSources(process.cwd(), root)))
        )(workspace);
        const probed = await probeReleasedReader(
          officialReader,
          candidateFormat,
          workspace,
          environment,
        );
        if (probed.version !== officialReader.version)
          throw new Error("Released CLI capabilities version differs from its official release");
        releasedReader = probed;
        if (!priorCompact) {
          useCompact = true;
          retainedLegacy = activationLegacy;
        }
      } catch (cause) {
        officialReader = undefined;
        readerUnavailable = cause instanceof Error ? cause.message.slice(0, 300) : "failed";
        diagnostics.push(
          `verified compatible released CLI unavailable; retaining prior listing carriers: ${readerUnavailable}`,
        );
        if (priorCompact) {
          if (!previousWire || !retainedLegacy)
            throw new Error("Compact renewal requires both authenticated prior targets", { cause });
          renewal = retainedListingRenewal(
            previousWire,
            canonical.listings.length,
            compactListingDeliveryTarget,
          );
        }
      }
    }
  }
  if (useCompact && !retainedLegacy)
    throw new Error("Compact listing publication requires a retained legacy listing");
  if (authoredLegacy && (!priorCompact || !retainedLegacy))
    throw new Error("Reviewed legacy withdrawal requires existing compact and legacy targets");
  const exportFormat = (version: number) => {
    const baseline: unknown = JSON.parse(
      cli([
        "--json",
        "catalog",
        "inspect-listings",
        "--path",
        canonicalPath,
        "--format-version",
        String(version),
      ]),
    );
    if (!isRecord(baseline) || baseline.ok !== true)
      throw new Error("Core could not export the exact canonical directory for format " + version);
    return directory(baseline.data);
  };
  let legacyExported: Directory | undefined;
  const legacyExport = () => (legacyExported ??= exportFormat(legacyListingFormat));
  signedLegacy = retainedLegacy;
  const activeDocument = previous ? delivery(parseCatalogSource(previous.toString("utf8"))) : null;
  // A legacy hold binds to Core's format-11 export and the compact withdrawals.
  const legacyBinding = (): LegacyHoldBinding => ({
    legacy: legacyExport(),
    compactWithdrawn: activeDocument?.withdrawn_ids ?? [],
  });
  // Reviewed recovery: the next publication returns to legacy-only delivery
  // above every compact reader's replay floor, keeping every compact withdrawal.
  const returning = options.returnToLegacy === true;
  if (returning) {
    if (!priorCompact || renewal || !signedLegacy || !activeDocument)
      throw new Error(
        "A legacy-only return requires current authenticated compact and legacy targets",
      );
    useCompact = false;
    previous = signedLegacy;
    retainedLegacy = null;
  }
  if (authoredLegacy && retainedLegacy && !authoredLegacy.equals(retainedLegacy)) {
    if (renewal) {
      diagnostics.push("Deferred the authored withdrawal until the exact signed prior is current");
    } else if (activeDocument) {
      successor = reviewedLegacySuccessor(
        retainedLegacy,
        authoredLegacy,
        activeDocument.revision,
        legacyBinding(),
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
  if (
    !renewal &&
    !releasedReader &&
    useCompact &&
    (!priorCompact || format > (previousDocument?.directory.format_version ?? 0))
  ) {
    if (!options.releasedReader)
      throw new Error(
        "Compact listing activation requires a reviewed released CLI and its exact SHA-256",
      );
    releasedReader = await probeReleasedReader(
      options.releasedReader,
      format,
      workspace,
      environment,
    );
  }
  let compatible: Directory | undefined;
  if (!renewal) compatible = exportFormat(format);
  // After activation the fixed legacy target receives Core's current format-11
  // hold for each delivered row and each held row it does not deliver. A hold
  // is never removed there.
  let automaticHolds: string[] = [];
  let automaticRows: string[] = [];
  if (!renewal && useCompact && priorCompact && retainedLegacy && activeDocument) {
    const automatic = legacyHoldSuccessor(
      retainedLegacy,
      {
        legacy: legacyExport(),
        compactWithdrawn: [...activeDocument.withdrawn_ids, ...(successor?.withdrawn_ids ?? [])],
      },
      successor?.revision ?? activeDocument.revision + 1,
      activeDocument.directory,
    );
    if (automatic) {
      successor = reviewedLegacySuccessor(
        signedLegacy!,
        automatic.bytes,
        activeDocument.revision,
        legacyBinding(),
      );
      retainedLegacy = automatic.bytes;
      automaticHolds = automatic.held;
      automaticRows = automatic.added;
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
  const floor = returning ? activeDocument!.revision : (successor?.revision ?? 0);
  const project = (observations: readonly Record<string, unknown>[]) =>
    publishedAbove(
      projectListingDelivery(
        canonical,
        observations,
        previous,
        floor,
        useCompact ? compactListingDecodedMaximum : maximum,
        compatible,
        operationalIds,
        now,
        returning ? activeDocument!.withdrawn_ids : successor?.withdrawn_ids,
        useCompact,
      ),
      floor,
    );
  const inspect = (bytes: Buffer) => {
    const candidate = path.join(workspace, "listings.json");
    writeFileSync(candidate, bytes);
    return cli(["--json", "catalog", "inspect-listings", "--path", candidate]);
  };
  // Stage the complete authenticated representation for output. Compact
  // validation uses the normal publication inspector on these exact bytes.
  const stage = async (projected: ReturnType<typeof project>, destinationRoot: string) => {
    const compactWire = useCompact
      ? previousWire && priorCompact && !projected.changed
        ? previousWire
        : encodeCompactListing(projected.bytes)
      : null;
    cpSync(options.bundle, destinationRoot, { recursive: true });
    const destination = path.join(destinationRoot, listingDeliveryTarget);
    mkdirSync(path.dirname(destination), { recursive: true });
    if (authoredLegacy) {
      const copied = await readControllerToolFile(destination, maximum);
      if (!copied.equals(authoredLegacy))
        throw new Error("Reviewed legacy listing input changed during projection");
      unlinkSync(destination);
    }
    writeFileSync(destination, retainedLegacy ?? projected.bytes, { flag: "wx" });
    if (compactWire) {
      writeFileSync(path.join(destinationRoot, compactListingDeliveryTarget), compactWire, {
        flag: "wx",
      });
      try {
        cli(["--json", "catalog", "inspect-definition-publication", destinationRoot]);
      } catch (error) {
        throw classifyCoreInspectionFailure(error);
      }
    }
    return compactWire;
  };
  let projected = renewal ?? project(candidates);
  let excludedCandidates: string[] = [];
  if (!useCompact) {
    // Legacy publication keeps its existing optional-enrichment fallback.
    try {
      inspect(
        Buffer.from(JSON.stringify(delivery(JSON.parse(projected.bytes.toString())).directory)),
      );
    } catch (error) {
      if (renewal) throw error;
      diagnostics.push(
        "observer candidates failed Core validation; retaining prior applicable observations",
      );
      projected = project([]);
      inspect(
        Buffer.from(JSON.stringify(delivery(JSON.parse(projected.bytes.toString())).directory)),
      );
    }
  } else if (!renewal && candidates.length) {
    // Compact publication isolates invalid optional enrichment. Only Core's
    // refusal of the staged publication excludes candidates. Projection
    // failures, capacity exhaustion of the encoded carrier, staging errors and
    // a Core CLI crash, timeout or non-refusal error fail preparation.
    let validationRun = 0;
    const accepts = async (observations: readonly Record<string, unknown>[]) => {
      const candidate = project(observations);
      const scratch = path.join(workspace, `validation-${++validationRun}`);
      try {
        await stage(candidate, scratch);
        return true;
      } catch (error) {
        if (error instanceof CoreInspectionRefusal) return false;
        throw error;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    };
    const isolated = await isolateValidEnrichment(candidates, accepts);
    if (isolated.excluded.length) {
      excludedCandidates = isolated.excluded.map((candidate) => String(candidate.id));
      diagnostics.push(
        `observer candidates failed Core validation and were excluded: ${excludedCandidates.join(", ").slice(0, 600)}`,
      );
      projected = project(isolated.admitted);
    }
  }
  if (
    hash(await readControllerToolFile(options.canonical, maximum)) !== hash(canonicalBytes) ||
    hash(await readControllerToolFile(options.catalog, 32 * 1024 * 1024)) !== hash(catalogBytes)
  )
    throw new Error("Canonical inputs changed during observation projection");
  const bundle = path.join(options.output, "bundle");
  const compactWire = await stage(projected, bundle);
  const report = {
    bundle,
    revision: projected.revision,
    listing_format: format,
    ...(releasedReader ? { released_reader: releasedReader } : {}),
    ...(officialReader
      ? {
          released_reader_source: officialReader.receipt,
          // Publish rechecks this selection against each fresh Pages base.
          released_reader_activation: {
            version: officialReader.version,
            tag: officialReader.receipt.tag,
          },
        }
      : {}),
    ...(readerUnavailable ? { released_reader_unavailable: readerUnavailable } : {}),
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
    target_bytes: compactWire?.length ?? projected.bytes.length,
    ...(compactWire
      ? {
          decoded_bytes: projected.bytes.length,
          transport_changed: !compactWire.equals(previousWire ?? Buffer.alloc(0)),
          ...(successor
            ? {
                ...(authoredLegacy ? { reviewed_legacy_sha256: hash(authoredLegacy) } : {}),
                reviewed_legacy_revision: successor.revision,
                legacy_sha256: hash(retainedLegacy!),
                automatic_legacy_holds: automaticHolds,
                automatic_legacy_rows: automaticRows,
              }
            : {}),
        }
      : {}),
    ...(returning
      ? {
          legacy_return: {
            compact_revision: activeDocument!.revision,
            revision: projected.revision,
          },
        }
      : {}),
    ...(useCompact ? { excluded_candidates: excludedCandidates } : {}),
    projection_scope: renewal
      ? "Exact prior signed listing directory for signer-verified renewal."
      : useCompact
        ? "Complete canonical directory with applicable observations and explicit withdrawals."
        : returning
          ? "Reviewed return to legacy-only delivery above the compact revision, keeping its withdrawals."
          : "Reviewed operational and previously signed guides with bounded optional observations; omitted discovery rows retain bundled fallback. Coverage is not complete provider history.",
    diagnostics,
    scope: successor
      ? "reviewed descriptive withdrawal or legacy hold; no operation or publication grant"
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
      "return-to-legacy": { type: "boolean", default: false },
      "released-reader": { type: "string" },
      "released-reader-sha256": { type: "string" },
      "official-released-reader": { type: "boolean", default: false },
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
        returnToLegacy: values["return-to-legacy"],
        officialReleasedReader: values["official-released-reader"],
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
