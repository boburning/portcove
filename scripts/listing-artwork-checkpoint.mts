import { createHash } from "node:crypto";
import { validArtworkCollection, validArtworkMapping } from "./catalog-cover-mapping.mts";
import type { applicableCoverHealth } from "./listing-artwork-observation.mts";
import { orderedJsonSha256 } from "./json-values.mts";
import { isRecord } from "./runtime-values.mts";

export const artworkCheckpointTarget = "policy/official/catalog.cover-checkpoint.json";
export const artworkCheckpointMax = 1024 * 1024;
const digest = /^[a-f0-9]{64}$/u;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const maxRows = 3072;

type Row = {
  id: string;
  scope: string;
  image_id: string;
  prior_sha256: string;
  observed_at: string;
  receipt: string;
  state: "gone" | "restored";
};
type Checkpoint = {
  checkpoint_schema: 1;
  listing_sha256: string;
  prior_checkpoint_sha256: string | null;
  entries: Row[];
};

export function coverDeclarationScope(row: Record<string, unknown>) {
  return orderedJsonSha256([
    row.id,
    row.project_url ?? null,
    row.original_game ?? null,
    row.artwork ?? null,
    row.collection_covers ?? null,
  ]);
}

const key = (row: Pick<Row, "id" | "scope" | "image_id" | "prior_sha256">) =>
  [row.id, row.scope, row.image_id, row.prior_sha256].join("/");

function validRecord(row: unknown): row is Row {
  return (
    isRecord(row) &&
    Object.keys(row).length === 7 &&
    typeof row.id === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.id) &&
    row.id.length <= 128 &&
    typeof row.scope === "string" &&
    digest.test(row.scope) &&
    typeof row.image_id === "string" &&
    /^[a-zA-Z0-9]{1,64}$/u.test(row.image_id) &&
    typeof row.prior_sha256 === "string" &&
    digest.test(row.prior_sha256) &&
    typeof row.observed_at === "string" &&
    Number.isFinite(Date.parse(row.observed_at)) &&
    row.observed_at === new Date(row.observed_at).toISOString() &&
    typeof row.receipt === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(row.receipt) &&
    (row.state === "gone" || row.state === "restored")
  );
}

export function readArtworkCheckpoint(bytes: Buffer, listing: Buffer): Checkpoint {
  if (bytes.length === 0 || bytes.length > artworkCheckpointMax)
    throw new Error("Cover checkpoint is outside its byte bound");
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 4 ||
    raw.checkpoint_schema !== 1 ||
    raw.listing_sha256 !== sha(listing) ||
    (raw.prior_checkpoint_sha256 !== null &&
      (typeof raw.prior_checkpoint_sha256 !== "string" ||
        !digest.test(raw.prior_checkpoint_sha256))) ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > maxRows
  )
    throw new Error("Cover checkpoint is unbound to the authenticated listing");
  let previous = "";
  const entries = (raw.entries as unknown[]).map((row) => {
    if (!validRecord(row) || key(row) <= previous)
      throw new Error("Cover checkpoint entries are invalid, duplicated or unordered");
    previous = key(row);
    return row;
  });
  return {
    checkpoint_schema: 1,
    listing_sha256: raw.listing_sha256,
    prior_checkpoint_sha256: raw.prior_checkpoint_sha256,
    entries,
  };
}

/** Only the compiler-authenticated publisher input supplies prior. A mismatch,
 * unavailable window or expired artifact supplies no transition.
 */
export function advanceArtworkCheckpoint(
  prior: { bytes: Buffer; listing: Buffer } | null,
  observations: ReturnType<typeof applicableCoverHealth>,
) {
  const held = prior ? readArtworkCheckpoint(prior.bytes, prior.listing) : null;
  const entries = new Map(held?.entries.map((row) => [key(row), row]));
  for (const observation of observations) {
    if (observation.status === "hold_changed_bytes") continue;
    const row = {
      id: observation.id,
      scope: observation.scope,
      image_id: observation.artwork.image_id,
      prior_sha256: observation.artwork.image_sha256,
      observed_at: observation.observed_at,
      receipt: observation.report,
      state: observation.status === "propose_fallback" ? "gone" : "restored",
    };
    if (!validRecord(row)) throw new Error("Projected cover receipt has an invalid scope");
    const identity = key(row);
    const previous = entries.get(identity);
    if (
      (!previous && row.state === "restored") ||
      (previous && row.observed_at <= previous.observed_at)
    )
      continue;
    entries.set(identity, row);
  }
  if (entries.size > maxRows) throw new Error("Cover checkpoint exceeds its receipt count bound");
  const sorted = [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);
  return {
    apply(listing: Record<string, unknown>) {
      if (typeof listing.id !== "string") return listing;
      const scope = coverDeclarationScope(listing);
      const gone = (artwork: { image_id: string; image_sha256: string }) =>
        entries.get(
          key({
            id: String(listing.id),
            scope,
            image_id: artwork.image_id,
            prior_sha256: artwork.image_sha256,
          }),
        )?.state === "gone";
      const result = { ...listing };
      if (validArtworkMapping(listing.artwork) && gone(listing.artwork)) {
        delete result.artwork;
      } else if (validArtworkCollection(listing.collection_covers)) {
        const remaining = listing.collection_covers.filter((artwork) => !gone(artwork));
        if (remaining.length) result.collection_covers = remaining;
        else delete result.collection_covers;
      }
      return result;
    },
    finish(listing: Buffer) {
      if (!sorted.length) return null;
      if (
        prior &&
        held?.listing_sha256 === sha(listing) &&
        JSON.stringify(sorted) === JSON.stringify(held.entries)
      )
        return prior.bytes;
      const checkpoint: Checkpoint = {
        checkpoint_schema: 1,
        listing_sha256: sha(listing),
        prior_checkpoint_sha256: prior ? sha(prior.bytes) : null,
        entries: sorted,
      };
      const bytes = Buffer.from(JSON.stringify(checkpoint) + "\n");
      readArtworkCheckpoint(bytes, listing);
      return bytes;
    },
  };
}
