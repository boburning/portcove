import { createHash } from "node:crypto";
import type { IgdbArtwork } from "../apps/desktop/src/transport-types.generated.d.ts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { validArtworkMapping } from "./catalog-cover-mapping.mts";
import {
  isConfirmedIgdbImageGone,
  prepareCatalogArtwork,
  type ArtworkRecord,
  type createIgdbInspector,
} from "./inspect-igdb-artwork.mts";
import { advanceArtworkCheckpoint } from "./listing-artwork-checkpoint.mts";
import type { ReviewedOriginalMediaDecision } from "./reviewed-original-media.mts";
import {
  coverIdentity,
  matchesSharedCoverScope,
  sharedCoverScope,
} from "./shared-cover-projection.mts";

export type ScheduledCover = { id: string; artwork: IgdbArtwork };
type Decisions = ReadonlyMap<string, ReviewedOriginalMediaDecision>;
type Listing = Record<string, unknown>;
type Inspector = Pick<ReturnType<typeof createIgdbInspector>, "inspectGame" | "inspectImage">;
type CoverObservations = Parameters<typeof advanceArtworkCheckpoint>[1];

function scheduledCoverScope(key: string, artwork: IgdbArtwork) {
  // The checkpoint record belongs to the original edition and reviewed provider
  // identity, so new peers and renamed repositories inherit the same history.
  const subject = createHash("sha256")
    .update(JSON.stringify([key, artwork.game_id]))
    .digest("hex");
  const scope = createHash("sha256").update(subject).update(coverIdentity(artwork)).digest("hex");
  return { id: `scheduled-cover-${subject}`, scope };
}

function reviewedScope(record: AuthoredPort, reviewed: Decisions) {
  if (record.listing.artwork || record.listing.collection_covers) return undefined;
  const scope = sharedCoverScope(record);
  const decision = scope && reviewed.get(scope.key);
  if (!scope || decision?.decision !== "match") return undefined;
  return { scope, decision };
}

/** Observe each missing reviewed original once, in the ordinary rotation. */
export async function prepareScheduledCovers(
  authored: readonly AuthoredPort[],
  selected: ReadonlySet<string>,
  reviewed: Decisions,
  inspector: Inspector,
) {
  const seen = new Set<string>();
  const inputs = authored.flatMap((record) => {
    const { listing } = record;
    const match = selected.has(listing.id) && reviewedScope(record, reviewed);
    if (!match || seen.has(match.scope.key)) return [];
    seen.add(match.scope.key);
    return [
      {
        id: listing.id,
        name: listing.name,
        project_url: listing.project_url,
        presentation: { original_game: listing.original_game },
      },
    ];
  });
  if (!inputs.length) return { covers: [], records: [] };
  const result = await prepareCatalogArtwork(
    { ports: inputs },
    { ...inspector, reviewedOriginalMedia: reviewed, reviewedOriginalOnly: true },
  );
  const covers: ScheduledCover[] = result.records.flatMap((record) =>
    record.reason === "exact-original-game-cover" && record.mapping
      ? [{ id: record.port_id, artwork: record.mapping }]
      : [],
  );
  return { covers, records: result.records };
}

export function asCoverProgress(record: ArtworkRecord) {
  const retry = record.exceptions.some(({ reason }) =>
    /unavailable|budget|incomplete/u.test(reason),
  );
  return {
    port_id: record.port_id,
    role: "cover" as const,
    subject: { kind: "port" as const, port_id: record.port_id },
    reason: record.mapping
      ? "role-selected"
      : retry
        ? "media-provider-unavailable-or-incomplete"
        : "provider-role-empty",
  };
}

/** Revalidate newly proposed covers, record Gone and hold changed signed bytes,
 * and share only against the exact maintained original-game edition. */
export async function projectScheduledCovers({
  authored,
  reviewed,
  previous,
  source,
  incoming,
  shared,
  denied,
  held = new Set<string>(),
  ambiguous = new Set<string>(),
  priorCheckpoint = null,
  observations = [],
  receiptStarted,
  receiptDigest,
  now,
  inspect,
}: {
  authored: readonly AuthoredPort[];
  reviewed: Decisions;
  previous: ReadonlyMap<string, Listing>;
  source?: ReadonlyMap<string, Listing>;
  incoming?: readonly ScheduledCover[];
  shared: ReadonlyMap<string, IgdbArtwork>;
  denied: ReadonlySet<string>;
  held?: ReadonlySet<string>;
  ambiguous?: ReadonlySet<string>;
  priorCheckpoint?: Parameters<typeof advanceArtworkCheckpoint>[0];
  observations?: CoverObservations;
  receiptStarted?: number;
  receiptDigest?: string;
  now: number;
  inspect?: Inspector["inspectImage"];
}) {
  const eligible = new Map(
    authored.flatMap((record) => {
      const known = reviewedScope(record, reviewed);
      return known && !ambiguous.has(record.listing.id)
        ? [[record.listing.id, { ...known, listing: record.listing }] as const]
        : [];
    }),
  );
  type Offer = { artwork: IgdbArtwork; key: string };
  const retained = new Map<string, Offer>();
  const fresh = new Map<string, Offer>();
  function accepted(id: string, artwork: unknown, producer: Listing | undefined, signed = false) {
    const entry = eligible.get(id);
    if (
      !entry ||
      !producer ||
      !matchesSharedCoverScope(producer.original_game, entry.scope) ||
      producer.project_url !== entry.listing.project_url ||
      !validArtworkMapping(artwork) ||
      artwork.match_kind !== "underlying-game" ||
      artwork.game_id !== entry.decision.game_id ||
      (!signed && artwork.game_slug !== entry.decision.slug) ||
      denied.has(artwork.image_id)
    )
      return undefined;
    return { artwork: { ...artwork, game_slug: entry.decision.slug }, key: entry.scope.key };
  }
  for (const [id, row] of previous) {
    const offer = accepted(id, row.artwork, row, true);
    if (offer && !shared.has(id)) retained.set(id, offer);
  }
  for (const { id, artwork } of incoming ?? []) {
    const offer = accepted(id, artwork, source?.get(id));
    if (offer && !shared.has(id)) fresh.set(id, offer);
  }
  const reads = new Map<string, Promise<string | null>>();
  function observe(artwork: IgdbArtwork) {
    const old = reads.get(artwork.image_id);
    if (old) return old;
    const request = inspect!(artwork.image_id).then(
      ({ sha256 }) => sha256,
      (error: unknown) => (isConfirmedIgdbImageGone(error, artwork.image_id) ? "gone" : null),
    );
    reads.set(artwork.image_id, request);
    return request;
  }
  const health = [...observations];
  const changed = new Set(held);
  const verified = new Set<string>();
  const prior = advanceArtworkCheckpoint(priorCheckpoint, observations);
  if (inspect) {
    const targets = [
      ...new Map([...retained.values()].map((offer) => [coverIdentity(offer.artwork), offer])),
    ].sort(([a], [b]) => a.localeCompare(b));
    const width = 8;
    const offset =
      (Math.floor(now / 86_400_000) % Math.max(1, Math.ceil(targets.length / width))) * width;
    for (const [, { artwork }] of targets.slice(offset, offset + width)) {
      const value = await observe(artwork);
      if (value !== null && value !== artwork.image_sha256) changed.add(artwork.image_id);
      if (value === artwork.image_sha256) verified.add(coverIdentity(artwork));
    }
    const goneScopes = new Set<string>();
    for (const { key, artwork } of retained.values()) {
      if ((await reads.get(artwork.image_id)) !== "gone") continue;
      const scope = scheduledCoverScope(key, artwork);
      if (goneScopes.has(scope.scope)) continue;
      goneScopes.add(scope.scope);
      health.push({
        ...scope,
        artwork,
        status: "propose_fallback",
        observed_at: new Date(now).toISOString(),
        report: `sha256:${createHash("sha256")
          .update(JSON.stringify(["approved-cdn-gone", coverIdentity(artwork), now]))
          .digest("hex")}`,
      });
    }
  }
  const preservedCheckpoint = advanceArtworkCheckpoint(priorCheckpoint, health);
  function collect(scoped: Map<string, IgdbArtwork | null>, { key, artwork }: Offer) {
    const earlier = scoped.get(key);
    if (earlier === undefined) scoped.set(key, artwork);
    else if (earlier && coverIdentity(earlier) !== coverIdentity(artwork)) scoped.set(key, null);
  }
  const offers = new Map<string, IgdbArtwork | null>();
  for (const offer of retained.values()) {
    const { id } = scheduledCoverScope(offer.key, offer.artwork);
    if (!preservedCheckpoint.withdrawalsFor(id).length) collect(offers, offer);
  }
  function distribute(allowNew: boolean) {
    const proposals = new Map<string, IgdbArtwork>();
    for (const [id, { scope }] of eligible) {
      const mapping = offers.get(scope.key);
      if (
        !shared.has(id) &&
        mapping &&
        (retained.has(id) ||
          (allowNew && !changed.has(mapping.image_id) && verified.has(coverIdentity(mapping))))
      )
        proposals.set(id, mapping);
    }
    return proposals;
  }
  const preserved = distribute(false);
  const candidates = new Map<string, IgdbArtwork | null>();
  for (const offer of fresh.values()) collect(candidates, offer);
  const restorations = new Map<string, CoverObservations[number]>();
  for (const [key, artwork] of candidates)
    if (
      inspect &&
      artwork &&
      !offers.has(key) &&
      !changed.has(artwork.image_id) &&
      (await observe(artwork)) === artwork.image_sha256
    ) {
      const scope = scheduledCoverScope(key, artwork);
      const withdrawals = preservedCheckpoint.withdrawalsFor(scope.id);
      if (withdrawals.length) {
        const sameImage = prior.withdrawalsFor(scope.id).find((row) => row.scope === scope.scope);
        if (
          !sameImage ||
          withdrawals.length !== 1 ||
          Date.parse(sameImage.observed_at) >= now ||
          !receiptDigest ||
          receiptStarted === undefined ||
          receiptStarted <= Date.parse(sameImage.observed_at)
        )
          continue;
        restorations.set(key, {
          ...scope,
          artwork,
          status: "verified_accepted_bytes",
          observed_at: new Date(now).toISOString(),
          report: receiptDigest,
        });
      }
      verified.add(coverIdentity(artwork));
      collect(offers, { key, artwork });
    }
  const proposals = distribute(true);
  function checkpointFor(listings: readonly Listing[]) {
    if (!restorations.size) return preservedCheckpoint;
    const published = new Map<string, CoverObservations[number]>();
    for (const row of listings) {
      if (typeof row.id !== "string" || !proposals.has(row.id)) continue;
      const key = eligible.get(row.id)?.scope.key;
      if (!key) continue;
      const restored = restorations.get(key);
      if (
        restored &&
        validArtworkMapping(row.artwork) &&
        coverIdentity(restored.artwork) === coverIdentity(row.artwork)
      )
        published.set(key, restored);
    }
    return published.size
      ? advanceArtworkCheckpoint(priorCheckpoint, [...health, ...published.values()])
      : preservedCheckpoint;
  }
  return { preserved, proposals, preservedCheckpoint, checkpointFor };
}
