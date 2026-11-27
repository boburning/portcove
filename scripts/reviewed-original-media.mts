import {
  artworkEvidenceUrl,
  matchesString,
  positiveId,
  slugPattern,
} from "./catalog-cover-mapping.mts";
import { isRecord } from "./runtime-values.mts";
import { originalEditionMediaKey } from "./shared-original-media.mts";
import type { AuthoredListing, AuthoredPort } from "./catalog-authoring.mts";
import { usesScummvmEngine } from "./catalog-route-holds.mts";

export type ReviewedOriginalMediaDecision = {
  original_game_id: string;
  source_edition_id: string;
  system: string | null;
  evidence_url: string;
} & ({ decision: "match"; game_id: number; slug: string } | { decision: "exclude" });

export function reviewedOriginalMediaScope(decision: ReviewedOriginalMediaDecision) {
  return JSON.stringify([decision.original_game_id, decision.source_edition_id, decision.system]);
}

export function indexReviewedOriginalMedia(decisions: readonly ReviewedOriginalMediaDecision[]) {
  const indexed = new Map<string, ReviewedOriginalMediaDecision>();
  for (const decision of decisions) {
    const scope = reviewedOriginalMediaScope(decision);
    if (indexed.has(scope))
      throw new Error(`Multiple reviewed original media decisions for ${scope}.`);
    indexed.set(scope, decision);
  }
  return indexed;
}

export function indexAuthoredOriginalMedia(records: readonly AuthoredPort[]) {
  return indexReviewedOriginalMedia(
    records.flatMap((record) =>
      usesScummvmEngine(record) ? [] : (record.igdb_original_media_v1 ?? []),
    ),
  );
}

export function previewReviewedOriginalMedia(
  decisions: ReadonlyMap<string, ReviewedOriginalMediaDecision>,
  listings: readonly Pick<AuthoredListing, "id" | "original_game">[],
  excluded: ReadonlySet<string>,
) {
  const reports = new Map(
    [...decisions].map(([scope, decision]) => [
      scope,
      { ...decision, applicable_port_ids: [] as string[] },
    ]),
  );
  if (reports.size)
    for (const { id, original_game } of listings) {
      if (!original_game || excluded.has(id)) continue;
      for (const edition of original_game.source_editions) {
        const scope = originalEditionMediaKey(original_game.id, edition);
        if (scope) reports.get(scope)?.applicable_port_ids.push(id);
      }
    }
  return [...reports.values()];
}

/** This is an authored preparation decision. The original declaration and its
 * exact edition/system must still agree if a surrounding identity is edited. */
export function checkReviewedOriginalMedia(value: unknown, game: unknown) {
  if (value === undefined) return;
  if (!isRecord(game) || typeof game.id !== "string" || !Array.isArray(game.source_editions))
    throw new Error("Reviewed original media requires a declared original game and edition.");
  const gameId = game.id;
  const scopes = new Set(
    (game.source_editions as unknown[]).map((edition) => originalEditionMediaKey(gameId, edition)),
  );
  if (!Array.isArray(value) || value.length === 0 || value.length > game.source_editions.length)
    throw new Error("Reviewed original media needs at most one decision per declared edition.");
  for (const entry of value as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.original_game_id !== "string" ||
      typeof entry.source_edition_id !== "string" ||
      (entry.system !== null && typeof entry.system !== "string") ||
      !scopes.delete(
        JSON.stringify([entry.original_game_id, entry.source_edition_id, entry.system]),
      )
    )
      throw new Error(
        "Reviewed original media must name an exact, unique game, edition and system.",
      );
    artworkEvidenceUrl(entry.evidence_url);
    const fields = Object.keys(entry).length;
    if (entry.decision === "exclude" && fields === 5) continue;
    if (
      entry.decision === "match" &&
      fields === 7 &&
      positiveId(entry.game_id) &&
      matchesString(slugPattern, entry.slug)
    )
      continue;
    throw new Error(
      "Reviewed original media requires an exact IGDB match or an explicit exclusion.",
    );
  }
}
