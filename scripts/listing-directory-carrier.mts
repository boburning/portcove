import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { isRecord } from "./runtime-values.mts";

export const listingDeliveryTarget = "policy/official/catalog.listings.json";
export const compactListingDeliveryTarget = "policy/official/catalog.listings.compact.json";
export const listingDeliveryMaximum = 8 * 1024 ** 2;
export const compactListingDecodedMaximum = 32 * 1024 ** 2;
export const compactListingCarrier = "gzip-base64-json-v1";
export const compactListingRecordMaximum = 1024 ** 2;
/** Listings and withdrawals each, as released compact readers bound them. */
export const compactListingCountMaximum = 10000;
/** Core's `MAX_LISTING_DIRECTORY_TEXT_BYTES`: the working-memory bound for the
 * authored listing directory text. Tooling that reads the canonical
 * `listings.json` uses it, never a delivery bound; a test pins it to Core. */
export const listingDirectoryTextMaximum = 64 * 1024 ** 2;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Why a listing candidate cannot be published while everything else about the
 * run is sound. Only these, and Core's input refusal of the final staged
 * publication, stop listing publication; preparation then renews the exact
 * prior listing targets. Canonical inputs changing mid-run, tool crashes,
 * timeouts, non-refusal Core errors and filesystem failures are plain errors
 * and stay fatal. */
export type ListingStopCode =
  | "decoded_bound"
  | "transport_bound"
  | "listing_count"
  | "record_bound"
  | "withdrawal_count"
  | "withdrawal_input"
  | "missing_without_withdrawal"
  | "conflicting_observations"
  | "core_refusal";

export class ListingPublicationStop extends Error {
  readonly code: ListingStopCode;
  readonly figures: Record<string, number | string | string[]>;
  constructor(
    code: ListingStopCode,
    message: string,
    figures: Record<string, number | string | string[]> = {},
  ) {
    super(message);
    this.name = "ListingPublicationStop";
    this.code = code;
    this.figures = figures;
  }
}

export function encodeCompactListing(bytes: Buffer) {
  if (!bytes.length || bytes.length > compactListingDecodedMaximum)
    throw new ListingPublicationStop(
      "decoded_bound",
      "Complete compact listing exceeds its decoded byte bound; retaining last-good publication",
      { decoded_bytes: bytes.length, decoded_limit: compactListingDecodedMaximum },
    );
  const compressed = gzipSync(bytes);
  // Preserve the published Unix OS byte in the gzip header on every host.
  compressed[9] = 3;
  const result = Buffer.from(
    JSON.stringify({
      carrier: compactListingCarrier,
      decoded_bytes: bytes.length,
      decoded_sha256: sha256(bytes),
      gzip_base64: compressed.toString("base64"),
    }),
  );
  if (result.length > listingDeliveryMaximum)
    throw new ListingPublicationStop(
      "transport_bound",
      "Complete compact listing exceeds its transport byte bound; retaining last-good publication",
      {
        wire_bytes: result.length,
        wire_limit: listingDeliveryMaximum,
        decoded_bytes: bytes.length,
        decoded_limit: compactListingDecodedMaximum,
      },
    );
  return result;
}

/** Only consume a retained carrier from the authenticated producer inventory. */
export function decodeRetainedCompactListing(raw: Buffer) {
  const error = () => new Error("Invalid retained compact listing carrier");
  if (!raw.length || raw.length > listingDeliveryMaximum) throw error();
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "carrier,decoded_bytes,decoded_sha256,gzip_base64" ||
    value.carrier !== compactListingCarrier ||
    typeof value.decoded_bytes !== "number" ||
    !Number.isSafeInteger(value.decoded_bytes) ||
    value.decoded_bytes < 1 ||
    value.decoded_bytes > compactListingDecodedMaximum ||
    typeof value.gzip_base64 !== "string"
  )
    throw error();
  const compressed = Buffer.from(value.gzip_base64, "base64");
  if (compressed.toString("base64") !== value.gzip_base64) throw error();
  const decoded = gunzipSync(compressed, { maxOutputLength: value.decoded_bytes });
  if (decoded.length !== value.decoded_bytes || sha256(decoded) !== value.decoded_sha256)
    throw error();
  return decoded;
}
