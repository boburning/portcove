/** Canonical listings and completed observer facts -> the compact signed
 * descriptive listing target, the sole live listing carrier (#1422). The legacy
 * format-11 target stays named with its last signed bytes for older previews
 * and never changes again. No executable authority. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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
  compactListingCountMaximum,
  compactListingDecodedMaximum,
  compactListingDeliveryTarget,
  compactListingRecordMaximum,
  decodeRetainedCompactListing,
  encodeCompactListing,
  listingDeliveryMaximum as maximum,
  listingDeliveryTarget,
  listingDirectoryTextMaximum,
  ListingPublicationStop,
} from "./listing-directory-carrier.mts";

export { listingDeliveryTarget, ListingPublicationStop };
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const legacyListingFormat = 11;
const latestListingFormat = 16;
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
    // A structural input bound only. The released readers' listing-count
    // bound is checked by projection as a listing publication stop.
    value.listings.length > 10 * compactListingCountMaximum
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
/** Optional observer enrichment never blocks compact publication. When the
 * complete candidate set fails Core validation, isolate the failing candidates
 * within a bounded number of validations, then validate the admitted set once
 * more. */
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

/** Project the complete canonical directory into the compact listing carrier.
 * Every unwithdrawn canonical identity is delivered; applicable completed
 * observations enrich rows and never displace one. The decoded document is
 * bounded by the released readers' compact decoded maximum. */
export function projectListingDelivery(
  canonical: unknown,
  candidates: readonly Record<string, unknown>[],
  previous: Buffer | null,
  options: {
    /** The next revision exceeds this floor (the retained legacy revision). */
    revisionFloor?: number;
    /** Core's exact export of the canonical directory at the delivered format. */
    compatible?: unknown;
    now?: number;
    /** Reviewed withdrawals added to the previous publication's withdrawals. */
    withdrawals?: readonly string[];
    /** A tighter decoded bound (tests); never above the compact decoded maximum. */
    byteLimit?: number;
  } = {},
) {
  const {
    revisionFloor = 0,
    compatible,
    now = Date.now(),
    withdrawals = [],
    byteLimit = compactListingDecodedMaximum,
  } = options;
  const raw = directory(canonical);
  const previousDocument = previous
    ? delivery(parseCatalogSource(previous.toString("utf8")))
    : null;
  const format = compactDirectoryFormat(raw, previousDocument);
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
      throw new ListingPublicationStop(
        "conflicting_observations",
        "Conflicting descriptive observation candidates",
        { listing_id: String(candidate.id) },
      );
    updates.set(String(candidate.id), compatibleObservation(candidate.upstream_observation));
  }
  const withdrawn = [...new Set([...(previousDocument?.withdrawn_ids ?? []), ...withdrawals])];
  if (withdrawn.length > compactListingCountMaximum)
    throw new ListingPublicationStop(
      "withdrawal_count",
      "Listing withdrawals exceed their count bound; retaining last-good publication",
      { withdrawals: withdrawn.length, withdrawal_limit: compactListingCountMaximum },
    );
  const withdrawalSet = new Set(withdrawn);
  const missing = [...previousListings.keys()]
    .map(String)
    .filter((id) => !identities.has(id) && !withdrawalSet.has(id))
    .sort();
  if (missing.length)
    throw new ListingPublicationStop(
      "missing_without_withdrawal",
      "Previously published listing missing from the canonical directory without an explicit withdrawal",
      { missing_count: missing.length, missing_ids: missing.slice(0, 20) },
    );
  const observedAt = (value: Record<string, unknown> | undefined) =>
    value && typeof value.observed_at === "string" ? Date.parse(value.observed_at) : -Infinity;
  let retained = 0;
  let updated = 0;
  const listings = baseline.listings
    .filter((listing) => !withdrawalSet.has(String(listing.id)))
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
      if (prior) retained++;
      if (
        result.upstream_observation !== undefined &&
        observationHash(result.upstream_observation) !==
          observationHash(omitUnknownAssetDigests(old?.upstream_observation ?? null))
      )
        updated++;
      return result;
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id), "en"));
  // The bounds the currently supported released readers enforce, stated here
  // rather than taken from this checkout's Core, which a later reader
  // generation may raise.
  if (listings.length > compactListingCountMaximum)
    throw new ListingPublicationStop(
      "listing_count",
      "Delivered listings exceed the released readers' count bound; retaining last-good publication",
      { listings: listings.length, listing_limit: compactListingCountMaximum },
    );
  let largest = { id: "", bytes: 0 };
  for (const listing of listings) {
    const bytes = Buffer.byteLength(JSON.stringify(listing));
    if (bytes > largest.bytes) largest = { id: String(listing.id), bytes };
  }
  if (largest.bytes > compactListingRecordMaximum)
    throw new ListingPublicationStop(
      "record_bound",
      "A delivered listing exceeds the released readers' record byte bound; retaining last-good publication",
      {
        listing_id: largest.id,
        record_bytes: largest.bytes,
        record_limit: compactListingRecordMaximum,
      },
    );
  const revision = Math.max(previousDocument?.revision ?? 0, revisionFloor) + 1;
  if (!Number.isSafeInteger(revision) || revision > 9007199254740991)
    throw new Error("Descriptive revision exhausted");
  const candidate = {
    listing_delivery_schema: 1,
    revision,
    withdrawn_ids: withdrawn,
    directory: { format_version: format, listings },
  };
  if (byteLimit > compactListingDecodedMaximum)
    throw new Error("Descriptive byte bound exceeds the compact decoded maximum");
  const bytes = Buffer.from(JSON.stringify(candidate));
  if (bytes.length > byteLimit)
    throw new ListingPublicationStop(
      "decoded_bound",
      "Complete compact listing exceeds its decoded byte bound; retaining last-good publication",
      { decoded_bytes: bytes.length, decoded_limit: byteLimit },
    );
  const counts = {
    retained,
    updated,
    canonical_records: raw.listings.length,
    delivered_records: listings.length,
  };
  if (
    previousDocument &&
    observationHash(previousDocument.directory) === observationHash(candidate.directory) &&
    observationHash(previousDocument.withdrawn_ids) === observationHash(candidate.withdrawn_ids)
  )
    return { bytes: previous!, revision: previousDocument.revision, changed: false, ...counts };
  return { bytes, revision, changed: true, ...counts };
}

/** The reviewed, committed listing withdrawal record (docs/SIGNED-CATALOG.md,
 * "Withdrawing a listing"). */
export const listingWithdrawalsInput = "crates/portcove-core/catalog/listing-withdrawals.json";
const withdrawalReference =
  /^https:\/\/github\.com\/boburning\/portcove\/(?:issues|pull)\/[1-9]\d{0,9}$/u;

function parseWithdrawalRecord(bytes: Buffer): unknown {
  try {
    return parseCatalogSource(bytes.toString("utf8"));
  } catch (error) {
    throw new ListingPublicationStop(
      "withdrawal_input",
      `Listing withdrawal record is not valid JSON: ${error instanceof Error ? error.message.slice(0, 200) : "parse failed"}`,
    );
  }
}

/** Validate the committed withdrawal record against the canonical directory
 * and every withdrawal already published. Withdrawals are cumulative: an entry
 * is never removed, and a withdrawn identity never returns to `listings.json`
 * (a re-listing uses a new identity). Any violation is a listing-only stop. */
export function listingWithdrawals(
  value: unknown,
  canonicalIds: ReadonlySet<string>,
  published: readonly string[] = [],
) {
  const refuse = (message: string, figures: Record<string, number | string | string[]> = {}) =>
    new ListingPublicationStop(
      "withdrawal_input",
      `Listing withdrawal record: ${message}`,
      figures,
    );
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "schema_version,withdrawals" ||
    value.schema_version !== 1 ||
    !Array.isArray(value.withdrawals) ||
    value.withdrawals.length > compactListingCountMaximum
  )
    throw refuse("requires schema_version 1 and a bounded withdrawals array");
  const ids: string[] = [];
  for (const entry of value.withdrawals as unknown[]) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(",") !== "id,reason,reference" ||
      typeof entry.id !== "string" ||
      entry.id.length > 128 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.id) ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      entry.reason !== entry.reason.trim() ||
      entry.reason.length > 500 ||
      typeof entry.reference !== "string" ||
      !withdrawalReference.test(entry.reference)
    )
      throw refuse("each entry needs a listing id, a reason and a Portcove issue or PR reference");
    if (ids.length && !(ids[ids.length - 1]! < entry.id))
      throw refuse("entries must be sorted by id without repeats", { id: entry.id });
    ids.push(entry.id);
  }
  const present = ids.filter((id) => canonicalIds.has(id));
  if (present.length)
    throw refuse("a withdrawn listing is still in the canonical directory", {
      present_ids: present.slice(0, 20),
    });
  const recorded = new Set(ids);
  const forgotten = published.filter((id) => !recorded.has(id)).sort();
  if (forgotten.length)
    throw refuse("a published withdrawal was removed; withdrawals are never removed", {
      forgotten_ids: forgotten.slice(0, 20),
    });
  return ids;
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

/** The first application generation that reads live listing changes: Preview
 * 14 is the first release whose reader selects the compact carrier, and the
 * compact carrier is the only listing target that still changes. Older
 * previews keep the frozen legacy target and need an application update for
 * further listing changes (docs/SIGNED-CATALOG.md). Raised when a later reader
 * generation replaces the compact carrier. */
export const minimumLiveListingReader = "0.1.0-preview.14";
// Adding a successor changes the minimum for live updates on the one compact
// target. Identify the first released reader for the new format before enabling it.
const liveListingReaderFloors = new Map([[15, minimumLiveListingReader]]);

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
  /** Select and verify the reader from the protected Preview pointer
   * (`Catalog publish`). */
  officialReleasedReader?: boolean;
  /** An explicit reviewed reader (rehearsal, tests); never with official selection. */
  releasedReader?: { cli: string; sha256: string };
  /** Replaces the live, anonymous acquisition (rehearsal fixtures, tests). */
  acquireReleasedReader?: (privateRoot: string) => Promise<AcquiredReleasedReader>;
  readObservation?: () => Promise<UpstreamInput>;
  /** The committed withdrawal record; absent means no withdrawals are added. */
  withdrawals?: string;
  /** Per-invocation Core CLI deadline; tests shorten it. */
  cliTimeoutMs?: number;
}) {
  if (existsSync(options.output)) throw new Error("Observation bundle output already exists");
  const automatic = options.officialReleasedReader === true;
  if (automatic && options.releasedReader)
    throw new Error("Official released-reader selection takes no explicit reader");
  for (const target of [listingDeliveryTarget, compactListingDeliveryTarget])
    if (existsSync(path.join(options.bundle, target)))
      throw new Error("Listing targets come only from observation projection, not the bundle");
  // The signer accepts compact delivery only beside the retained legacy target,
  // so a publication always starts from the authenticated prior repository.
  if (!options.prior)
    throw new Error(
      "Listing publication requires the prior signed repository and its retained legacy listing",
    );
  const priorRepository = options.prior;
  if (!existsSync(path.join(options.prior, "metadata/timestamp.json")))
    throw new Error("Previous catalog timestamp unavailable; cannot establish listing admission");
  const priorTargets = publishedTargets(options.prior);
  if (!Object.hasOwn(priorTargets, listingDeliveryTarget))
    throw new Error("Prior repository has no retained legacy listing target");
  const priorCompact = Object.hasOwn(priorTargets, compactListingDeliveryTarget);
  mkdirSync(options.output, { recursive: true });
  const workspace = path.join(options.output, "observation-work");
  mkdirSync(workspace);
  const environment = isolatedEnvironment(workspace);
  const diagnostics: string[] = [];
  // The canonical directory is authored text bounded by Core's working-memory
  // limit, not by the listing wire bound the delivered target obeys.
  const canonicalBytes = await readControllerToolFile(
    options.canonical,
    listingDirectoryTextMaximum,
  );
  const catalogBytes = await readControllerToolFile(options.catalog, 32 * 1024 * 1024);
  const withdrawalBytes = options.withdrawals
    ? await readControllerToolFile(options.withdrawals, maximum)
    : null;
  const canonical = directory(parseCatalogSource(canonicalBytes.toString("utf8")));
  const current = parseCatalogSource(catalogBytes.toString("utf8"));
  if (!isRecord(current) || !Array.isArray(current.ports))
    throw new Error("Operational catalog requires a complete port array");
  const portIds = new Set<string>();
  for (const port of current.ports) {
    if (!isRecord(port) || typeof port.id !== "string" || portIds.has(port.id))
      throw new Error("Operational catalog has an invalid or duplicate port identity");
    portIds.add(port.id);
  }
  const cli = (args: string[]) =>
    execFileSync(options.cli, args, {
      env: environment,
      timeout: options.cliTimeoutMs ?? 30000,
      // Core's exported directory comes back on stdout: the buffer follows the
      // canonical input's own bound, so no smaller hidden ceiling applies.
      maxBuffer: listingDirectoryTextMaximum,
      encoding: "utf8",
    });
  const canonicalPath = path.join(workspace, "canonical.json");
  writeFileSync(canonicalPath, canonicalBytes, { flag: "wx" });

  // The legacy target is republished with its exact last signed bytes; the
  // compact target carries every listing change.
  let legacyWire: Buffer;
  let compactWire: Buffer | null = null;
  let previous: Buffer;
  let renewal: ReturnType<typeof retainedListingRenewal> | undefined;
  let observerRevision = options.observe === false ? "offline" : "unavailable";
  // Why the prior signed repository could not be verified, when it could not.
  let priorUnverified: string | undefined;
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
    const legacy = await verifiedPriorListing(prior, report);
    if (!legacy) throw new Error("Prior legacy listing is not referenced");
    legacyWire = legacy;
    compactWire = priorCompact
      ? await verifiedPriorListing(prior, report, compactListingDeliveryTarget)
      : null;
    if (priorCompact && !compactWire) throw new Error("Prior compact listing is not referenced");
    previous = compactWire
      ? readDeliveryCarrier(compactWire, compactListingDeliveryTarget).bytes
      : legacyWire;
  } catch (error) {
    // The signer authenticates the historical targets before renewal. Never use
    // an unauthenticated observation, or replace a directory we could not read.
    const carrier = priorCompact ? compactListingDeliveryTarget : listingDeliveryTarget;
    renewal = await priorListingForRenewal(options.prior, canonical.listings.length, carrier);
    legacyWire = priorCompact
      ? (await priorListingForRenewal(options.prior, canonical.listings.length)).wire
      : renewal.wire;
    compactWire = priorCompact ? renewal.wire : null;
    previous = renewal.bytes;
    priorUnverified = error instanceof Error ? error.message.slice(0, 300) : "verification failed";
    diagnostics.push(
      `retained exact previous listing bytes for historical signer verification; prior unavailable: ${priorUnverified}`,
    );
  }
  const legacyDocument = delivery(parseCatalogSource(legacyWire.toString("utf8")));
  const previousDocument = delivery(parseCatalogSource(previous.toString("utf8")));
  const format = compactDirectoryFormat(canonical, priorCompact ? previousDocument : null);

  // Released-reader gate: the compact carrier is first published, or raised to
  // a newer format, only after the current released preview is verified to read
  // it. Otherwise the exact prior state is renewed and nothing new is published.
  let officialReader: AcquiredReleasedReader | undefined;
  let releasedReader: { version: string; sha256: string } | undefined;
  let readerUnavailable: string | undefined;
  // A first compact publication or a compact format raise is pending until a
  // run publishes it; every deferral is reported and fails the run after
  // readback, so it is never silently postponed.
  const activationNeeded = !priorCompact || format > previousDocument.directory.format_version;
  const priorUnavailable = renewal !== undefined;
  if (!renewal && activationNeeded) {
    try {
      if (automatic) {
        if (!liveListingReaderFloors.has(format))
          throw new Error(`Listing format ${format} has no declared released reader floor`);
        officialReader = await (
          options.acquireReleasedReader ??
          ((root: string) =>
            acquireCatalogReleasedReader(
              root,
              // The Pages worktree holding the prior: its checked-out commit,
              // not a remote-tracking ref.
              liveReleasedReaderSources(process.cwd(), root, priorRepository),
            ))
        )(workspace);
        releasedReader = await probeReleasedReader(officialReader, format, workspace, environment);
        if (releasedReader.version !== officialReader.version)
          throw new Error("Released CLI capabilities version differs from its official release");
      } else if (options.releasedReader) {
        releasedReader = await probeReleasedReader(
          options.releasedReader,
          format,
          workspace,
          environment,
        );
      } else throw new Error("No released reader source was configured");
    } catch (cause) {
      officialReader = undefined;
      releasedReader = undefined;
      readerUnavailable = cause instanceof Error ? cause.message.slice(0, 300) : "failed";
      diagnostics.push(
        `verified compatible released CLI unavailable; retaining prior listing carriers: ${readerUnavailable}`,
      );
      renewal = retainedListingRenewal(
        compactWire ?? legacyWire,
        canonical.listings.length,
        compactWire ? compactListingDeliveryTarget : listingDeliveryTarget,
      );
    }
  }

  const now = Date.now();
  let candidates: Record<string, unknown>[] = [];
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
    if (options.observe !== false) {
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
  }
  // Every compact revision exceeds the frozen legacy revision, the signer's
  // replay floor for the first compact publication.
  let withdrawals: string[] = [];
  const project = (observations: readonly Record<string, unknown>[]) =>
    publishedAbove(
      projectListingDelivery(canonical, observations, previous, {
        revisionFloor: legacyDocument.revision,
        compatible,
        now,
        withdrawals,
      }),
      legacyDocument.revision,
    );
  // Stage the complete authenticated representation; Core's normal publication
  // inspector validates these exact bytes.
  const stage = (projected: { bytes: Buffer; changed: boolean }, destinationRoot: string) => {
    const wire = renewal
      ? compactWire
      : compactWire && !projected.changed
        ? compactWire
        : encodeCompactListing(projected.bytes);
    cpSync(options.bundle, destinationRoot, { recursive: true });
    const legacyPath = path.join(destinationRoot, listingDeliveryTarget);
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, legacyWire, { flag: "wx" });
    if (wire)
      writeFileSync(path.join(destinationRoot, compactListingDeliveryTarget), wire, {
        flag: "wx",
      });
    try {
      cli(["--json", "catalog", "inspect-definition-publication", destinationRoot]);
    } catch (error) {
      throw classifyCoreInspectionFailure(error);
    }
    return wire;
  };
  let projected:
    | Pick<
        ReturnType<typeof retainedListingRenewal>,
        | "bytes"
        | "revision"
        | "changed"
        | "retained"
        | "updated"
        | "canonical_records"
        | "delivered_records"
      >
    | undefined = renewal;
  const renewedBeforeProjection = renewal !== undefined;
  let excludedCandidates: string[] = [];
  // A listing-only failure stops listing publication, never the catalog:
  // projection, encoding and Core's refusal of the final staged publication
  // renew the exact prior listing targets and the report records the stop.
  let stopped: ListingPublicationStop | undefined;
  const stopListing = (error: unknown) => {
    if (error instanceof CoreInspectionRefusal)
      return new ListingPublicationStop("core_refusal", error.message, {
        message: error.message.slice(0, 300),
      });
    if (error instanceof ListingPublicationStop) return error;
    throw error;
  };
  if (!renewal) {
    try {
      withdrawals = listingWithdrawals(
        withdrawalBytes
          ? parseWithdrawalRecord(withdrawalBytes)
          : // Without a record, add none and keep every published withdrawal.
            { schema_version: 1, withdrawals: [] },
        new Set(canonical.listings.map((listing) => String(listing.id))),
        withdrawalBytes
          ? [...new Set([...legacyDocument.withdrawn_ids, ...previousDocument.withdrawn_ids])]
          : [],
      );
      projected = project(candidates);
      if (candidates.length) {
        // Only Core's refusal of the staged publication excludes optional
        // enrichment. A listing stop ends listing publication below; staging
        // errors and a Core CLI crash, timeout or non-refusal error fail
        // preparation.
        let validationRun = 0;
        const accepts = (observations: readonly Record<string, unknown>[]) => {
          const candidate = project(observations);
          const scratch = path.join(workspace, `validation-${++validationRun}`);
          try {
            stage(candidate, scratch);
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
    } catch (error) {
      stopped = stopListing(error);
    }
  }
  if (
    hash(await readControllerToolFile(options.canonical, listingDirectoryTextMaximum)) !==
      hash(canonicalBytes) ||
    hash(await readControllerToolFile(options.catalog, 32 * 1024 * 1024)) !== hash(catalogBytes) ||
    (options.withdrawals !== undefined &&
      hash(await readControllerToolFile(options.withdrawals, maximum)) !== hash(withdrawalBytes!))
  )
    throw new Error("Canonical inputs changed during observation projection");
  const bundle = path.join(options.output, "bundle");
  let wire: Buffer | null = null;
  if (!stopped) {
    if (!projected) throw new Error("No listing projection was prepared");
    try {
      wire = stage(projected, bundle);
    } catch (error) {
      // Core refusing an exact prior renewal is never a listing-only stop.
      if (renewedBeforeProjection) throw error;
      stopped = stopListing(error);
      rmSync(bundle, { recursive: true, force: true });
    }
  }
  if (stopped) {
    diagnostics.push(
      `listing publication stopped (${stopped.code}); renewing the exact prior listing targets: ${stopped.message.slice(0, 300)}`,
    );
    renewal = retainedListingRenewal(
      compactWire ?? legacyWire,
      canonical.listings.length,
      compactWire ? compactListingDeliveryTarget : listingDeliveryTarget,
    );
    projected = renewal;
    // The renewal is the exact prior publication; Core refusing it is not a
    // listing-only failure and fails preparation.
    wire = stage(renewal, bundle);
  }
  if (!projected) throw new Error("No listing projection was prepared");
  const delivered = delivery(parseCatalogSource(projected.bytes.toString("utf8")));
  const report = {
    bundle,
    carrier: wire ? "compact" : "legacy-renewal",
    minimum_live_listing_reader:
      liveListingReaderFloors.get(delivered.directory.format_version) ??
      (delivered.directory.format_version < 15 ? minimumLiveListingReader : null),
    revision: projected.revision,
    listing_format: delivered.directory.format_version,
    ...(releasedReader ? { released_reader: releasedReader } : {}),
    ...(officialReader && !stopped
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
    ...(activationNeeded && renewal
      ? {
          listing_activation_pending: {
            prior_carrier: priorCompact ? "compact" : "legacy",
            prior_format: previousDocument.directory.format_version,
            candidate_format: format,
            reason: (
              readerUnavailable ??
              stopped?.message ??
              (priorUnavailable
                ? "the prior signed repository could not be verified"
                : "not published")
            ).slice(0, 600),
          },
        }
      : {}),
    ...(priorUnverified !== undefined
      ? {
          // Projection was skipped and the exact prior listing targets renewed,
          // so canonical listing changes are unpublished. Like a stop, the run
          // publishes everything else and fails after readback.
          listing_prior_unverified: {
            prior_carrier: priorCompact ? "compact" : "legacy",
            reason: priorUnverified,
          },
        }
      : {}),
    ...(stopped
      ? {
          // The run publishes freshness, definitions and policy, then fails
          // loudly after readback so a person resolves the listing stop.
          listing_publication_stopped: {
            code: stopped.code,
            reason: stopped.message.slice(0, 600),
            figures: stopped.figures,
          },
        }
      : {}),
    withdrawal_record: withdrawalBytes
      ? { sha256: hash(withdrawalBytes), withdrawals: withdrawals.length }
      : null,
    changed: projected.changed,
    retained: projected.retained,
    updated: projected.updated,
    source_candidates: candidates.length,
    observer_revision: observerRevision,
    canonical_sha256: hash(canonicalBytes),
    catalog_sha256: hash(catalogBytes),
    canonical_records: projected.canonical_records,
    delivered_records: projected.delivered_records,
    withdrawn_records: delivered.withdrawn_ids.length,
    not_projected_records: projected.canonical_records - projected.delivered_records,
    target_bytes: (wire ?? legacyWire).length,
    decoded_bytes: projected.bytes.length,
    ...(wire
      ? {
          target_sha256: hash(wire),
          transport_changed: !wire.equals(compactWire ?? Buffer.alloc(0)),
        }
      : {}),
    legacy_target: {
      sha256: hash(legacyWire),
      bytes: legacyWire.length,
      revision: legacyDocument.revision,
      unchanged: true,
    },
    excluded_candidates: excludedCandidates,
    projection_scope: stopped
      ? "Listing publication stopped; exact prior signed listing targets renewed."
      : renewal
        ? "Exact prior signed listing targets for signer-verified renewal."
        : "Complete canonical directory with applicable observations and explicit withdrawals.",
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
      "released-reader": { type: "string" },
      "released-reader-sha256": { type: "string" },
      "official-released-reader": { type: "boolean", default: false },
      withdrawals: { type: "string" },
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
        officialReleasedReader: values["official-released-reader"],
        ...(values.withdrawals ? { withdrawals: path.resolve(values.withdrawals) } : {}),
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
