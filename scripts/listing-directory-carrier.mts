import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { isRecord } from "./runtime-values.mts";

export const listingDeliveryTarget = "policy/official/catalog.listings.json";
export const compactListingDeliveryTarget = "policy/official/catalog.listings.compact.json";
export const listingDeliveryMaximum = 8 * 1024 ** 2;
export const compactListingDecodedMaximum = 32 * 1024 ** 2;
export const compactListingCarrier = "gzip-base64-json-v1";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function encodeCompactListing(bytes: Buffer) {
  if (!bytes.length || bytes.length > compactListingDecodedMaximum)
    throw new Error(
      "Complete compact listing exceeds its decoded byte bound; retaining last-good publication",
    );
  const result = Buffer.from(
    JSON.stringify({
      carrier: compactListingCarrier,
      decoded_bytes: bytes.length,
      decoded_sha256: sha256(bytes),
      gzip_base64: gzipSync(bytes).toString("base64"),
    }),
  );
  if (result.length > listingDeliveryMaximum)
    throw new Error(
      "Complete compact listing exceeds its transport byte bound; retaining last-good publication",
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
