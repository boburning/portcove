import type { CatalogEntry } from "../features/browsing/catalog-entry";
import {
  listingActionAssessment,
  listingAvailabilityLabel,
} from "../features/browsing/catalog-entry";
import { initialDetailSection, type DetailOpening } from "../features/game-details/detail-sections";
import type { Perform } from "../features/operations/use-operation-state";
import { gameProjectLabel } from "../port-identity";
import type { PortStatus } from "../types";
import { platformLabel } from "../view-model";
import { ArtworkControls } from "./Artwork";
import { DetailLayout } from "./DetailLayout";
import { ExternalLink } from "./ExternalLink";
import { SelfServiceSetup } from "./SelfServiceSetup";
import { Button } from "./ui/button";

export function ListingDetailPanel({
  entry,
  status,
  generation,
  perform,
  onChanged,
  close,
  opening,
}: {
  entry: CatalogEntry;
  status?: PortStatus | undefined;
  generation: number;
  perform: Perform;
  onChanged: () => void;
  close: () => void;
  opening?: DetailOpening | undefined;
}) {
  const listing = entry.listing;
  const registered = status?.external_runtime;
  const launch = listingActionAssessment(entry.listingStatus, "launch");
  const needsFiles = !registered || !launch.allowed;
  const links = listing && (
    <div className="flex flex-wrap gap-4 text-sm">
      <ExternalLink href={listing.project_url}>Project website</ExternalLink>
      {listing.release_url && (
        <ExternalLink href={listing.release_url}>Upstream releases</ExternalLink>
      )}
      {listing.setup_url && (
        <ExternalLink href={listing.setup_url}>Setup instructions</ExternalLink>
      )}
    </div>
  );
  return (
    <SelfServiceSetup
      entry={entry}
      status={status}
      generation={generation}
      perform={perform}
      onChanged={onChanged}
      render={({ play, setup }) => (
        <DetailLayout
          port={entry}
          projectUrl={listing?.project_url}
          opening={opening}
          initialSection={initialDetailSection({
            destination: opening?.destination,
            needsFiles,
            hasUpdate: false,
          })}
          close={close}
          readiness={
            <span
              className={
                registered && launch.allowed
                  ? "text-pc-success-foreground"
                  : "text-pc-warning-foreground"
              }
            >
              {registered
                ? launch.allowed
                  ? "Ready to play"
                  : "Launch needs attention"
                : entry.pendingSetup
                  ? "Downloaded · finish setup"
                  : listing
                    ? listingAvailabilityLabel(listing)
                    : "Setup required"}
            </span>
          }
          installation={
            registered
              ? "Registered external installation"
              : entry.pendingSetup
                ? "Downloaded setup · " + entry.pendingSetup.path
                : "Not installed"
          }
          action={(reveal) =>
            (launch.allowed ? play : null) ?? (
              <Button
                data-focusable
                variant="primary"
                size="lg"
                onClick={() =>
                  reveal(
                    "files",
                    "detail-self-service-setup",
                    !registered && entry.pendingSetup ? "[data-self-service-continue]" : undefined,
                  )
                }
              >
                {registered
                  ? "Review launch details"
                  : entry.pendingSetup
                    ? "Continue setup"
                    : "Set up game"}
              </Button>
            )
          }
          attention={
            needsFiles
              ? (reveal) => (
                  <p>
                    {registered
                      ? launch.reason
                      : entry.pendingSetup
                        ? "Complete the upstream setup, then choose the executable."
                        : "Review available downloads and setup instructions."}{" "}
                    <Button variant="link" onClick={() => reveal("files")}>
                      Open Files
                    </Button>
                  </p>
                )
              : undefined
          }
        >
          {(reveal) => ({
            overview: (
              <>
                <div className="detail-overview">
                  <div>
                    <p className="max-w-prose leading-relaxed text-pc-muted-foreground">
                      {entry.summary}
                    </p>
                    <Button variant="link" onClick={() => reveal("files")}>
                      Files and setup
                    </Button>
                  </div>
                  <section aria-label="At a glance">
                    <h3 className="mb-4 text-base">At a glance</h3>
                    <dl className="detail-facts">
                      <div>
                        <dt>Project / variant</dt>
                        <dd>{gameProjectLabel(entry) ?? entry.name}</dd>
                      </div>
                      <div>
                        <dt>Platform</dt>
                        <dd>
                          {entry.platforms.length
                            ? entry.platforms.map(platformLabel).join(" · ")
                            : "Platforms not yet confirmed"}
                        </dd>
                      </div>
                      <div>
                        <dt>Installation method</dt>
                        <dd>Upstream setup / external registration</dd>
                      </div>
                      <div>
                        <dt>Channel</dt>
                        <dd>Managed by the upstream project</dd>
                      </div>
                      <div>
                        <dt>Recorded support</dt>
                        <dd>
                          {listing ? listingAvailabilityLabel(listing) : "No listing observation"}.
                          A catalog listing does not establish tested compatibility.
                        </dd>
                      </div>
                    </dl>
                  </section>
                </div>
                <details className="mt-6">
                  <summary data-focusable>Project status and compatibility qualifications</summary>
                  {links}
                  <p>
                    Availability describes the recorded upstream route. No managed installation or
                    compatibility check is inferred from this listing.
                  </p>
                </details>
              </>
            ),
            files: (
              <>
                <section aria-label="Installation ownership" className="mb-6">
                  <h3 className="text-base">Installation and files</h3>
                  {registered && <p className="[overflow-wrap:anywhere]">{registered.path}</p>}
                  <p>
                    You choose and maintain the installation folder. Portcove stores your launch
                    details; upstream setup manages its files.
                  </p>
                </section>
                {setup}
                <div className="mt-6">{links}</div>
                <section className="mt-7" aria-labelledby="detail-artwork">
                  <h3 id="detail-artwork" tabIndex={-1} className="mb-4 text-base">
                    Artwork
                  </h3>
                  <ArtworkControls key={entry.id + ":" + generation} port={entry} />
                </section>
              </>
            ),
            saves: (
              <>
                <h3 className="text-base">Saved-data coverage</h3>
                <p className="max-w-prose">
                  Your original game files, settings and saves stay in the location you choose.
                  External saved data is outside Portcove’s managed backup, restore and removal
                  operations. Follow the upstream instructions to locate and copy it separately.
                </p>
                {links}
                <p className="mt-4 text-sm text-pc-muted-foreground">
                  A saved setup entry or exported launch details are not a saved-data backup or a
                  version rollback.
                </p>
              </>
            ),
            versions: (
              <>
                <dl className="detail-facts">
                  <div>
                    <dt>Current installation</dt>
                    <dd>
                      {registered
                        ? "Registered external installation; version maintained upstream"
                        : "Not installed"}
                    </dd>
                  </div>
                  {entry.pendingSetup && (
                    <div>
                      <dt>Downloaded setup</dt>
                      <dd>{entry.pendingSetup.path}</dd>
                    </div>
                  )}
                </dl>
                <p className="mt-5 max-w-prose">
                  The upstream project provides setup instructions and updates. Managed update
                  checks, staged activation and rollback are unavailable for this route.
                </p>
                {links}
              </>
            ),
          })}
        </DetailLayout>
      )}
    />
  );
}
