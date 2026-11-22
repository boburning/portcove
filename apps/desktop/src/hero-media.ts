import type { SourceIdentity } from "./transport-types.generated";
import type {
  ArtworkFraming,
  CatalogMediaAsset,
  PortListing,
  PortStatus,
  SourceInspectionReport,
  SourceRecord,
} from "./types";
import type { PortIdentity } from "./port-identity";

export function backgroundObjectPosition(point: ArtworkFraming["wide"]) {
  return `${point.x / 100}% ${point.y / 100}%`;
}

export type HeroMediaPort = PortIdentity & { id: string };

export type BackgroundPreviewProps = {
  port: HeroMediaPort;
  layout: "wide" | "narrow";
  image: string;
  position: string;
  actionLabel?: string | undefined;
  /** The same verified edition context the live hero uses, so the preview matches it. */
  mediaContext?: HeroMediaContext | undefined;
  onError: () => void;
};
export interface HeroMediaContext {
  /** An applicable identity supplied by an owner; an offered edition is not a selection. */
  originalEditionId?: string | undefined;
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
          edition.id === subject.source_edition_id && Boolean(edition.verified_sources?.length),
      ),
  );
}

function reviewedEditionForIdentity(
  port: HeroMediaPort,
  reviewedGame: PortListing["original_game"],
  identity: SourceIdentity,
) {
  const original = port.presentation?.original_game;
  if (!original || reviewedGame?.id !== original.id) return undefined;
  const matches = reviewedGame.source_editions.filter(
    (edition) =>
      original.source_editions.some(({ id }) => id === edition.id) &&
      edition.verified_sources?.some(
        (binding) =>
          binding.game_id === identity.game_id &&
          binding.variant_id === identity.variant_id &&
          binding.representation_id === identity.representation_id,
      ),
  );
  return matches.length === 1 ? matches[0] : undefined;
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
    registered.storage_size !== source.storage_size
  )
    return {};

  const matches = (report.original_editions ?? []).filter(
    (entry) =>
      entry.port_id === port.id &&
      entry.original_game_id === original.id &&
      original.source_editions.some(({ id }) => id === entry.source_edition_id),
  );
  if (matches.length !== 1) return {};

  const edition = reviewedEditionForIdentity(port, reviewedGame, classification.identity);
  return edition?.id === matches[0]!.source_edition_id ? { originalEditionId: edition.id } : {};
}

/** A launch card needs confirmation from the active runtime's effective source contract. */
export function activeSourceHeroMediaContext(
  port: HeroMediaPort,
  status: PortStatus | undefined,
  source: SourceRecord | null | undefined,
  report: SourceInspectionReport | undefined,
  reviewedGame: PortListing["original_game"] = port.presentation?.original_game,
): HeroMediaContext {
  if (!status?.active && !status?.external_runtime)
    return verifiedHeroMediaContext(port, source, report, reviewedGame);
  // The effective active runtime may use retained or prepared bytes.
  // A wider catalog profile or readable saved path alone cannot identify them.
  if (
    status.port_id !== port.id ||
    status.active?.port_id !== port.id ||
    status.external_runtime ||
    !source ||
    status.readiness?.active_game_source_profile !== source.profile_id ||
    (status.readiness.source !== "current" && status.readiness.source !== "not_checked")
  )
    return {};
  return verifiedHeroMediaContext(port, source, report, reviewedGame);
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

function heroScope(asset: CatalogMediaAsset) {
  if (asset.subject.kind === "port") return 0;
  return asset.edition_neutral === true ? 2 : 1;
}

/** Presentation ordering of already admitted media, never title matching or eligibility. */
export function heroMediaCandidates(port: HeroMediaPort, context: HeroMediaContext = {}) {
  const media = (port.presentation?.media ?? []).filter(
    (asset) => subjectMatches(port, asset) && mediaApplies(asset, context),
  );
  const bySubject = (a: CatalogMediaAsset, b: CatalogMediaAsset) =>
    Number(a.subject.kind !== "port") - Number(b.subject.kind !== "port");
  const byHeroScope = (a: CatalogMediaAsset, b: CatalogMediaAsset) => heroScope(a) - heroScope(b);
  // Identity stays logo-first; photographic key art is not a replacement for a wordmark.
  // GameHero owns the existing cover, then text fallback when these logos fail.
  const foreground = media
    .filter((asset) => asset.role === "logo")
    .sort(byHeroScope)
    .slice(0, 2);
  return {
    foreground,
    backgrounds: media
      .filter((asset) => asset.role === "header")
      .sort(byHeroScope)
      .slice(0, 2),
    screenshots: media
      .filter((asset) => asset.role === "screenshot")
      .sort(bySubject)
      .slice(0, 8),
  };
}
