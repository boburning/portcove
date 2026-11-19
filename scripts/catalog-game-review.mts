import { isRecord } from "./runtime-values.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";

/** Repository review only. Never projected or required by legacy runtime readers. */
export interface OriginalGameReview {
  disposition: "unresolved" | "multi-game" | "helper" | "framework" | "separate";
  reason: string;
  evidence_urls: string[];
}

export function checkOriginalGameReview(value: unknown): asserts value is OriginalGameReview {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["disposition", "reason", "evidence_urls"].includes(key)) ||
    !["unresolved", "multi-game", "helper", "framework", "separate"].includes(
      String(value.disposition),
    ) ||
    typeof value.reason !== "string" ||
    !value.reason.trim() ||
    value.reason !== value.reason.trim() ||
    Buffer.byteLength(value.reason) > 4096 ||
    /\p{Cc}/u.test(value.reason) ||
    !Array.isArray(value.evidence_urls) ||
    !value.evidence_urls.length ||
    value.evidence_urls.length > 8
  )
    throw new Error(
      "Original-game review requires a disposition, specific reason and bounded public evidence.",
    );
  for (const reference of value.evidence_urls) {
    if (typeof reference !== "string" || reference.length > 4096)
      throw new Error("Invalid original-game review evidence.");
    const url = new URL(reference);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Original-game review evidence requires public HTTPS.");
  }
}

/** Preparation/promotion require a decision, without revoking older installations. */
export function requireOriginalGameDecision(
  record: AuthoredPort,
  records: readonly AuthoredPort[] = [],
) {
  if (record.original_game_review !== undefined)
    checkOriginalGameReview(record.original_game_review);
  if (!record.listing.original_game && !record.original_game_review)
    throw new Error(
      `${record.listing.id}: review original-game grouping: reuse an established ID, establish an evidenced ID, or record original_game_review with the specific unresolved/non-single-game reason.`,
    );
  if (record.original_game_review?.disposition === "separate" && !record.listing.original_game)
    throw new Error(
      `${record.listing.id}: a reviewed separate game needs its evidenced original_game; use unresolved while its identity remains unknown.`,
    );
  if (
    record.original_game_review &&
    record.original_game_review.disposition !== "separate" &&
    record.listing.original_game
  )
    throw new Error(
      `${record.listing.id}: non-single-game/unresolved review contradicts a single original_game assignment.`,
    );
  const title = (entry: AuthoredPort) =>
    (entry.listing.original_game_title ?? entry.listing.name)
      .normalize("NFKC")
      .toLocaleLowerCase("en")
      .replace(/\s+/gu, " ")
      .trim();
  const peers = records.filter(
    (entry) =>
      entry.listing.id !== record.listing.id &&
      entry.listing.original_game &&
      (title(entry) === title(record) ||
        (entry.upstream_lineage?.target_key &&
          entry.upstream_lineage.target_key === record.upstream_lineage?.target_key)),
  );
  if (
    record.listing.original_game &&
    !record.original_game_review &&
    peers.some((entry) => entry.listing.original_game!.id !== record.listing.original_game!.id)
  )
    throw new Error(
      `${record.listing.id}: candidate known family has another original-game ID; reuse it or record an evidenced separate-scope review. Names and lineage alone do not prove equivalence.`,
    );
}

/** Cross-record evidence consistency; titles and URLs may legitimately be aliases. */
export function checkOriginalGameConsistency(
  records: readonly AuthoredPort[],
  requireCompleteFamilies = false,
) {
  const editions = new Map<string, { system: string; port: string }>();
  const targets = new Map<string, AuthoredPort[]>();
  for (const record of records) {
    const game = record.listing.original_game;
    for (const edition of game?.source_editions ?? []) {
      if (!edition.system) continue;
      const key = `${game!.id}:${edition.id}`;
      const previous = editions.get(key);
      if (previous && previous.system !== edition.system)
        throw new Error(
          `${record.listing.id}: source edition ${key} contradicts ${previous.port}'s original system.`,
        );
      editions.set(key, { system: edition.system, port: record.listing.id });
    }
    const target = record.upstream_lineage?.target_key;
    if (target) targets.set(target, [...(targets.get(target) ?? []), record]);
  }
  for (const [target, members] of targets) {
    const mapped = members.filter((record) => record.listing.original_game);
    if (!mapped.length || !requireCompleteFamilies) continue;
    for (const record of members) {
      if (!record.listing.original_game && !record.original_game_review)
        throw new Error(
          `${record.listing.id}: partial original-game mapping for lineage target ${target}; review the relationship explicitly (lineage is not grouping evidence).`,
        );
    }
  }
}

/** Research can finish before identity evidence; admission still requires the decision. */
export function originalGamePreparationFeedback(
  record: AuthoredPort,
  records: readonly AuthoredPort[],
) {
  try {
    requireOriginalGameDecision(record, records);
    return {
      status: "reviewed",
      original_game_id: record.listing.original_game?.id ?? null,
      disposition: record.original_game_review?.disposition ?? "single-game",
      reason: record.original_game_review?.reason ?? null,
    };
  } catch (error) {
    return {
      status: "needs-review",
      original_game_id: record.listing.original_game?.id ?? null,
      reason: error instanceof Error ? error.message : String(error),
      next: "Review retained original-game facts; reuse an established ID, add an evidenced original_game, or record a specific original_game_review before promotion and repository validation.",
    };
  }
}
