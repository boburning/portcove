import type { CatalogMediaAsset, PortListing, SourceInspectionReport, SourceRecord } from "./types";
import type { PortIdentity } from "./port-identity";

export type HeroMediaPort = PortIdentity & { id: string };
export interface HeroMediaContext {
  /** An applicable identity supplied by an owner; an offered edition is not a selection. */
  originalEditionId?: string | undefined;
}

type ReviewedOriginalGame = NonNullable<PortListing["original_game"]>;
type ReviewedEdition = ReviewedOriginalGame["source_editions"][number];

function verifiedBindings(edition: ReviewedEdition): readonly unknown[] {
  return "verified_sources" in edition && Array.isArray(edition.verified_sources)
    ? edition.verified_sources
    : [];
}

export function canCheckEditionArtwork(
  port: HeroMediaPort,
  reviewedGame: PortListing["original_game"] = port.presentation?.original_game,
) {
  if (reviewedGame?.id !== port.presentation?.original_game?.id) return false;
  const editions = reviewedGame?.source_editions ?? [];
  return (port.presentation?.media ?? []).some(
    ({ subject, edition_neutral, role }) =>
      subject.kind === "original" &&
      edition_neutral !== true &&
      role !== "key_art" &&
      subjectMatches(port, { subject }) &&
      editions.some(
        (edition) =>
          edition.id === subject.source_edition_id && verifiedBindings(edition).length > 0,
      ),
  );
}

/** Use only the current registered observation for this port and catalog identity. */
export function verifiedHeroMediaContext(
  port: HeroMediaPort,
  source: SourceRecord | null | undefined,
  report: SourceInspectionReport | undefined,
  reviewedGame: PortListing["original_game"] = port.presentation?.original_game,
): HeroMediaContext {
  const original = port.presentation?.original_game;
  const registered = report?.registered;
  const assessment = report?.inspection?.assessment;
  const classification = assessment?.classification;
  if (
    !original ||
    reviewedGame?.id !== original.id ||
    !source ||
    !registered ||
    report?.health !== "current" ||
    assessment?.health !== "current" ||
    assessment.admission.state !== "admitted" ||
    assessment.admission.mode !== "exact_identity" ||
    classification?.state !== "recognized" ||
    report.profile_id !== source.profile_id ||
    registered.profile_id !== source.profile_id ||
    registered.path !== source.path ||
    registered.updated_at !== source.updated_at ||
    registered.sha256 !== source.sha256 ||
    registered.storage_sha256 !== source.storage_sha256 ||
    registered.size !== source.size ||
    registered.storage_size !== source.storage_size ||
    !("original_editions" in report) ||
    !Array.isArray(report.original_editions)
  )
    return {};

  const matches = report.original_editions.filter(
    (
      entry: unknown,
    ): entry is {
      source_edition_id: string;
    } =>
      typeof entry === "object" &&
      entry !== null &&
      "port_id" in entry &&
      entry.port_id === port.id &&
      "original_game_id" in entry &&
      entry.original_game_id === original.id &&
      "source_edition_id" in entry &&
      typeof entry.source_edition_id === "string" &&
      original.source_editions.some(({ id }) => id === entry.source_edition_id),
  );
  if (matches.length !== 1) return {};

  const edition = reviewedGame.source_editions.find(
    ({ id }) => id === matches[0]!.source_edition_id,
  );
  if (!edition) return {};
  const identity = classification.identity;
  const stillBound = verifiedBindings(edition).some(
    (binding) =>
      typeof binding === "object" &&
      binding !== null &&
      "game_id" in binding &&
      binding.game_id === identity.game_id &&
      "variant_id" in binding &&
      binding.variant_id === identity.variant_id &&
      "representation_id" in binding &&
      binding.representation_id === identity.representation_id,
  );
  return stillBound ? { originalEditionId: edition.id } : {};
}

function subjectMatches(port: HeroMediaPort, { subject }: Pick<CatalogMediaAsset, "subject">) {
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

export function screenshotEditions(port: HeroMediaPort) {
  const editionIds = new Set<string>();
  for (const asset of port.presentation?.media ?? []) {
    if (
      asset.role === "screenshot" &&
      asset.subject.kind === "original" &&
      subjectMatches(port, asset)
    )
      editionIds.add(asset.subject.source_edition_id);
  }
  return (
    port.presentation?.original_game?.source_editions.filter(({ id }) => editionIds.has(id)) ?? []
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
