import { isRecord } from "./runtime-values.mts";

interface ListingProjectionRow {
  listing: Record<string, unknown>;
  prior: Record<string, unknown> | undefined;
  required: boolean;
  retained: boolean;
  updated: boolean;
}

function listingBytes(listing: Record<string, unknown>) {
  return Buffer.byteLength(JSON.stringify(listing));
}

function expired(observation: Record<string, unknown>, now: number) {
  return typeof observation.fresh_until === "string" && Date.parse(observation.fresh_until) <= now;
}

/** Reserve published identities, reviewed operational guides and still-usable prior facts
 * before spending the rest of the signed target on optional observation enrichment. */
export function fitListingAdmissions(
  rows: readonly ListingProjectionRow[],
  envelopeBytes: number,
  limit: number,
  now: number,
) {
  const selected = new Map<unknown, ListingProjectionRow>();
  const omitted: { id: string; reason: string }[] = [];
  const omittedObservations: { id: string; reason: string }[] = [];
  let size = envelopeBytes;
  function fit(row: ListingProjectionRow) {
    const old = selected.get(row.listing.id);
    const extra =
      listingBytes(row.listing) -
      (old ? listingBytes(old.listing) : 0) +
      Number(!old && selected.size > 0);
    if (size + extra > limit) return false;
    selected.set(row.listing.id, row);
    size += extra;
    return true;
  }
  for (const row of rows) {
    if (!row.required) continue;
    const listing = { ...row.listing };
    delete listing.upstream_observation;
    const retainPrior = row.prior !== undefined && !expired(row.prior, now);
    if (retainPrior)
      listing.upstream_observation = row.updated ? row.prior : row.listing.upstream_observation;
    if (!fit({ ...row, listing, retained: retainPrior, updated: false }))
      throw new Error(
        "Reviewed listing admissions and unexpired prior observations exceed the signed target byte bound",
      );
  }
  for (const row of rows) {
    if (
      row.required &&
      isRecord(row.listing.upstream_observation) &&
      !expired(row.listing.upstream_observation, now) &&
      !fit(row)
    )
      omittedObservations.push({
        id: String(row.listing.id),
        reason: "existing-target-byte-budget",
      });
  }
  for (const row of rows) {
    if (
      row.required &&
      isRecord(row.listing.upstream_observation) &&
      expired(row.listing.upstream_observation, now) &&
      !fit(row)
    )
      omittedObservations.push({
        id: String(row.listing.id),
        reason: "expired-observation-byte-budget",
      });
  }
  for (const row of rows) {
    if (!row.required && !fit(row))
      omitted.push({ id: String(row.listing.id), reason: "existing-target-byte-budget" });
  }
  const admitted = [...selected.values()];
  return {
    listings: admitted.map((row) => row.listing),
    retained: admitted.filter((row) => row.retained).length,
    updated: admitted.filter((row) => row.updated).length,
    omitted,
    omittedObservations,
  };
}
