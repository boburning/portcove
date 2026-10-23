import { ArrowLeft } from "lucide-react";
import type { CatalogEntry } from "../features/browsing/catalog-entry";
import { listingAvailabilityLabel } from "../features/browsing/catalog-entry";
import type { Perform } from "../features/operations/use-operation-state";
import { gameProjectLabel, gameTitle } from "../port-identity";
import type { PortStatus } from "../types";
import { platformLabel } from "../view-model";
import { ArtworkControls, ArtworkImage } from "./Artwork";
import { ExternalLink } from "./ExternalLink";
import { SelfServiceSetup } from "./SelfServiceSetup";
import { Icon } from "./ui";
import { Button } from "./ui/button";

export function ListingDetailPanel({
  entry,
  status,
  generation,
  perform,
  onChanged,
  close,
}: {
  entry: CatalogEntry;
  status?: PortStatus | undefined;
  generation: number;
  perform: Perform;
  onChanged: () => void;
  close: () => void;
}) {
  const listing = entry.listing;
  return (
    <section
      className="detail-panel @container/detail relative w-full max-w-[64rem] min-w-0"
      aria-labelledby="port-detail-title"
      data-detail-workspace
      data-detail-port-id={entry.id}
    >
      <Button
        data-focusable
        className="detail-back mb-4"
        variant="ghost"
        size="sm"
        onClick={close}
        aria-label="Back to previous workspace"
      >
        <Icon glyph={ArrowLeft} /> Back
      </Button>
      <div className="detail-hero flex items-start gap-4 @min-[32rem]/detail:gap-5">
        <ArtworkImage
          port={entry}
          quietFallback
          className="detail-cover aspect-2/3 w-12 flex-none rounded-pc-md border border-pc-border bg-[var(--art-color)] @min-[20rem]/detail:w-16 @min-[32rem]/detail:w-24"
        />
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <p className="mb-1 text-xs text-pc-muted-foreground">
            {entry.platforms.length
              ? entry.platforms.map(platformLabel).join(" · ")
              : "Platforms not yet confirmed"}
          </p>
          <h1 id="port-detail-title" className="mb-0 text-[length:var(--text-2xl)]">
            {gameTitle(entry)}
          </h1>
          {gameProjectLabel(entry) && (
            <p className="mt-1 text-sm text-pc-muted-foreground">
              Port project: {gameProjectLabel(entry)}
            </p>
          )}
          <p className="mt-3 max-w-prose text-sm">{entry.summary}</p>
          {listing && (
            <p className="text-xs text-pc-muted-foreground">{listingAvailabilityLabel(listing)}</p>
          )}
        </div>
      </div>
      <div className="mt-6 grid gap-6">
        <SelfServiceSetup
          entry={entry}
          status={status}
          generation={generation}
          perform={perform}
          onChanged={onChanged}
        />
        {listing && (
          <section
            className="grid gap-3 border-t border-pc-border pt-4"
            aria-label="Upstream project"
          >
            <h2 className="text-base">Upstream project</h2>
            <div className="flex flex-wrap gap-4 text-sm">
              <ExternalLink href={listing.project_url}>Project website</ExternalLink>
              {listing.release_url && (
                <ExternalLink href={listing.release_url}>Upstream releases</ExternalLink>
              )}
              {listing.setup_url && (
                <ExternalLink href={listing.setup_url}>Setup instructions</ExternalLink>
              )}
            </div>
            <p className="text-sm text-pc-muted-foreground">
              The upstream project provides setup instructions and updates. Your original game
              files, settings and saves stay in the location you choose.
            </p>
          </section>
        )}
        <div className="border-t border-pc-border pt-4">
          <ArtworkControls key={`${entry.id}:${generation}`} port={entry} />
        </div>
      </div>
    </section>
  );
}
