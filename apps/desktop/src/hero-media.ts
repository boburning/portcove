import type { CatalogMediaAsset } from "./types";
import type { PortIdentity } from "./port-identity";

export type HeroMediaPort = PortIdentity & { id: string };
export interface HeroMediaContext {
  /** An applicable identity supplied by an owner; an offered edition is not a selection. */
  originalEditionId?: string | undefined;
}

function subjectMatches(port: HeroMediaPort, asset: CatalogMediaAsset) {
  const subject = asset.subject;
  if (subject.kind === "port") return subject.port_id === port.id;
  const original = port.presentation?.original_game;
  return (
    original?.id === subject.game_id &&
    original.source_editions.some((edition) => edition.id === subject.source_edition_id)
  );
}

function mediaApplies(asset: CatalogMediaAsset, context: HeroMediaContext) {
  return (
    asset.subject.kind === "port" ||
    asset.edition_neutral === true ||
    asset.subject.source_edition_id === context.originalEditionId
  );
}

/** Presentation ordering of already admitted media, never title matching or eligibility. */
export function heroMediaCandidates(port: HeroMediaPort, context: HeroMediaContext = {}) {
  const media = (port.presentation?.media ?? []).filter(
    (asset) => subjectMatches(port, asset) && mediaApplies(asset, context),
  );
  const bySubject = (a: CatalogMediaAsset, b: CatalogMediaAsset) =>
    Number(a.subject.kind !== "port") - Number(b.subject.kind !== "port");
  // Identity stays logo-first; photographic key art is not a replacement for a wordmark.
  // GameHero owns the existing cover, then text fallback when these logos fail.
  const foreground = media
    .filter((asset) => asset.role === "logo")
    .sort(bySubject)
    .slice(0, 2);
  return {
    foreground,
    backgrounds: media
      .filter((asset) => asset.role === "header")
      .sort(bySubject)
      .slice(0, 2),
    screenshots: media
      .filter((asset) => asset.role === "screenshot")
      .sort(bySubject)
      .slice(0, 8),
  };
}
