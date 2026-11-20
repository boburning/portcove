import type { useFavorites } from "../features/favorites/use-favorites";
import { releaseKey } from "../features/browsing/download-identity";
import { upstreamUpdatesDestination } from "../features/browsing/upstream-links";
import { ArrowRight, FolderOpen, Save } from "lucide-react";
import type { ReactNode } from "react";
import {
  FavoriteGameButton,
  FavoritePreferenceFailure,
} from "../features/organization/OrganizationControls";
import { ListingMaintenanceFacts } from "../features/browsing/ListingMaintenanceFacts";
import type { CatalogEntry } from "../features/browsing/catalog-entry";
import {
  listingActionAssessment,
  listingAvailabilityLabel,
} from "../features/browsing/catalog-entry";
import { initialDetailSection, type DetailOpening } from "../features/game-details/detail-sections";
import type { Perform } from "../features/operations/use-operation-state";
import type { PortStatus } from "../types";
import { continueActionPresentation, platformLabel } from "../view-model";
import { ArtworkControls } from "./Artwork";
import { GameHeroFramingPreview } from "./GameHero";
import {
  presentPortAction,
  useOperationPresentation,
} from "../features/operations/operation-presentation";
import { useAppTranslation } from "../localization";
import { DetailLayout } from "./DetailLayout";
import { SetupStatement, type DetailOrganization } from "./DetailChoices";
import { RuntimeLaunchFacts } from "./ExternalRuntime";
import { ExternalLink } from "./ExternalLink";
import { SelfServiceSetup } from "./SelfServiceSetup";
import { PortCapabilities } from "./PortCapabilities";
import { Button } from "./ui/button";
import { Icon } from "./ui";
import { CurrentStateSummary, ManagementRow } from "./ui/patterns";

function renderListingEvidence(listing: CatalogEntry["listing"]) {
  return (
    <dl className="detail-facts">
      <div>
        <dt>Recorded availability</dt>
        <dd>{listing ? listingAvailabilityLabel(listing) : "No listing observation"}</dd>
        {listing?.availability_override_reason && <dd>{listing.availability_override_reason}</dd>}
        {listing?.upstream_observation && (
          <dd>
            Checked {new Date(listing.upstream_observation.attempted_at).toLocaleString()}; facts
            observed{" "}
            {listing.upstream_observation.observed_at
              ? new Date(listing.upstream_observation.observed_at).toLocaleString()
              : "unavailable"}
            . Release asset names and provider hashes are observations, not compatibility or byte
            verification.
          </dd>
        )}
      </div>
      {listing?.upstream_observation && listing.upstream_observation.releases.length > 0 && (
        <div>
          <dt>Observed release assets</dt>
          <dd>
            <details>
              <summary>Release window and package candidates</summary>
              {listing.upstream_observation.releases.map((release) => (
                <div key={releaseKey(release.id)}>
                  <ExternalLink href={release.release_url}>{release.version}</ExternalLink>
                  <ul>
                    {release.assets.map((asset) => (
                      <li key={asset.id}>
                        {asset.name} —{" "}
                        {asset.platform_hints.length
                          ? `${asset.platform_hints.map(platformLabel).join(" · ")} filename hints`
                          : "Platform not identified"}
                      </li>
                    ))}
                  </ul>
                  {!release.assets_complete && (
                    <p>This release’s assets were not completely observed.</p>
                  )}
                </div>
              ))}
            </details>
          </dd>
        </div>
      )}
      <ListingMaintenanceFacts listing={listing} />
    </dl>
  );
}

function renderListingRequirements(
  entry: CatalogEntry,
  platforms: CatalogEntry["platforms"],
  registeredPlatform: CatalogEntry["platforms"][number] | undefined,
) {
  return (
    <dl className="detail-facts">
      <div>
        <dt>Original game files</dt>
        <dd>
          {entry.presentation?.manual_setup
            ? "Follow the upstream setup instructions"
            : "Requirements not specified"}
        </dd>
      </div>
      {registeredPlatform && (
        <div>
          <dt>Recorded installation platforms</dt>
          <dd>{platformLabel(registeredPlatform)}</dd>
        </div>
      )}
      <div>
        <dt>Upstream project platforms</dt>
        <dd>
          {platforms.length
            ? platforms.map(platformLabel).join(" · ")
            : "Platforms not yet confirmed"}
        </dd>
      </div>
      <div>
        <dt>Installation</dt>
        <dd>
          {registeredPlatform
            ? "Externally maintained installation"
            : "Upstream setup / external registration"}
        </dd>
      </div>
      <div>
        <dt>Update channel</dt>
        <dd>Managed by the upstream project</dd>
      </div>
    </dl>
  );
}

export function ListingDetailPanel({
  entry,
  libraryRoot,
  status,
  generation,
  perform,
  onChanged,
  close,
  backLabel,
  opening,
  openSupport,
  organization,
  groupPorts,
  favorites,
  implementationControl,
  managementSupplement,
}: {
  entry: CatalogEntry;
  groupPorts?: readonly CatalogEntry[] | undefined;
  favorites?: ReturnType<typeof useFavorites> | undefined;
  implementationControl?: ReactNode;
  managementSupplement?: ReactNode;
  libraryRoot?: string | undefined;
  status?: PortStatus | undefined;
  generation: number;
  perform: Perform;
  onChanged: () => void;
  close: () => void;
  backLabel?: string | undefined;
  opening?: DetailOpening | undefined;
  openSupport?: (() => void) | undefined;
  organization?: DetailOrganization | undefined;
}) {
  const { t } = useAppTranslation("installation");
  const listing = entry.listing;
  const platforms = listing?.platforms ?? (entry.definition ? [] : entry.platforms);
  const updates = listing && upstreamUpdatesDestination(listing.project_url, listing.release_url);
  const registered = status?.external_runtime;
  const launch = listingActionAssessment(entry.listingStatus, "launch");
  const launchReadiness = presentPortAction(
    useOperationPresentation(),
    entry.id,
    status,
    "launch",
  ).readiness;
  const continueAction = continueActionPresentation(entry, status, launchReadiness.blocked);
  const readinessUnknown =
    registered && !launch.allowed && typeof status?.readiness?.launchable !== "boolean";
  const needsFiles = !registered || !launch.allowed;
  const setupActionLabel = registered
    ? "Review launch details"
    : entry.pendingSetup
      ? "Continue setup"
      : "Set up game";

  const links = listing && (
    <div className="flex flex-wrap gap-4 text-sm">
      <ExternalLink href={listing.project_url}>Project website</ExternalLink>
      {updates?.releases && <ExternalLink href={updates.url}>Upstream releases</ExternalLink>}
      {!entry.pendingSetup && listing.setup_url && (
        <ExternalLink href={listing.setup_url}>Project setup guide</ExternalLink>
      )}
    </div>
  );
  return (
    <SelfServiceSetup
      libraryRoot={libraryRoot}
      entry={entry}
      status={status}
      generation={generation}
      perform={perform}
      onChanged={onChanged}
      render={({ play, setup }) => (
        <DetailLayout
          backLabel={backLabel}
          port={entry}
          platforms={registered ? [registered.platform] : []}
          upstreamPlatforms={platforms.filter((platform) => platform !== registered?.platform)}
          managementSupplement={managementSupplement}
          favoriteControl={
            <>
              {implementationControl}
              <FavoriteGameButton
                port={entry}
                groupPorts={groupPorts}
                organization={organization}
                favorites={favorites}
              />
              <FavoritePreferenceFailure favorites={favorites} organization={organization} />
            </>
          }
          projectUrl={listing?.project_url}
          openSupport={openSupport}
          overviewRequirements={renderListingRequirements(entry, platforms, registered?.platform)}
          overviewActions={(reveal) => (
            <div className="detail-journey-links">
              <Button
                variant="ghost"
                className="justify-start p-4.5 text-start"
                onClick={() => reveal("files")}
              >
                <Icon glyph={FolderOpen} />
                <span>
                  <strong>Game files</strong>
                  <small>
                    {registered
                      ? "Your external launch details"
                      : "Downloads and upstream instructions"}
                  </small>
                </span>
                <Icon glyph={ArrowRight} />
              </Button>
              <Button
                variant="ghost"
                className="justify-start p-4.5 text-start"
                onClick={() => reveal("saves")}
              >
                <Icon glyph={Save} />
                <span>
                  <strong>Saves & backups</strong>
                  <small>Review external saved-data ownership</small>
                </span>
                <Icon glyph={ArrowRight} />
              </Button>
            </div>
          )}
          overviewDetails={
            <section className="detail-evidence" aria-label="Project information and checks">
              <PortCapabilities entry={entry} status={status} generation={generation} />
              <details className="mt-6">
                <summary data-focusable>Project status and compatibility qualifications</summary>
                {links}
                {renderListingEvidence(listing)}
                <p>
                  Availability describes the recorded upstream route. No managed installation or
                  compatibility check is inferred from this listing.
                </p>
              </details>
            </section>
          }
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
                  : readinessUnknown
                    ? "text-pc-muted-foreground"
                    : "text-pc-warning-foreground"
              }
            >
              {registered
                ? launch.allowed
                  ? "Ready to play"
                  : readinessUnknown
                    ? "Can't check right now"
                    : "Launch needs attention"
                : entry.pendingSetup
                  ? "Downloaded · finish setup"
                  : listing
                    ? listingAvailabilityLabel(listing)
                    : "Setup needed"}
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
                onClick={() => reveal("files", "detail-self-service-setup")}
              >
                {setupActionLabel}
                <Icon glyph={ArrowRight} />
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
                        ? "Confirm the game or launcher in Game files to finish setup."
                        : "Review available downloads and setup instructions."}{" "}
                    <Button variant="link" onClick={() => reveal("files")}>
                      Open Game files
                    </Button>
                  </p>
                )
              : undefined
          }
        >
          {(reveal) => ({
            overview: (
              <>
                <section className="detail-about" aria-label="About this port">
                  <h3 className="mb-3 text-base">About this port</h3>
                  <p className="max-w-prose leading-relaxed text-pc-muted-foreground">
                    {entry.summary}
                  </p>
                </section>
              </>
            ),
            files: (
              <div className="detail-setup-workspace">
                <div className="detail-setup-main">
                  {setup}
                  {(entry.presentation?.manual_setup || entry.presentation?.manual_preparation) && (
                    <SetupStatement portId={entry.id} status={status} organization={organization} />
                  )}
                </div>
                <aside className="detail-setup-context" aria-label="Installation management">
                  <h3 className="mb-3 text-base">Installation and files</h3>
                  {registered && <p className="[overflow-wrap:anywhere]">{registered.path}</p>}
                  <p className="text-sm text-pc-muted-foreground">
                    You choose and maintain the installation folder. Portcove stores your launch
                    details; upstream setup manages its files.
                  </p>
                  <div className="mt-5">{links}</div>
                </aside>
              </div>
            ),
            saves: (
              <CurrentStateSummary
                title={
                  <span className="inline-flex items-center gap-2">
                    <Icon glyph={FolderOpen} />
                    Saves managed externally
                  </span>
                }
              >
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
              </CurrentStateSummary>
            ),
            versions: (
              <CurrentStateSummary
                title={
                  registered
                    ? "Updates managed externally"
                    : entry.pendingSetup
                      ? "Downloaded setup"
                      : "No installation yet"
                }
              >
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
              </CurrentStateSummary>
            ),
            manage: (
              <>
                <CurrentStateSummary title="Installation" className="mb-6">
                  {registered ? (
                    <>
                      <RuntimeLaunchFacts
                        executable={registered.executable}
                        workingDirectory={registered.path}
                        launchArguments={registered.user_selected?.arguments}
                      />
                      <p>
                        You or the upstream launcher maintain this installation and its updates.
                        Keep backups of your external saves with the tools or instructions from the
                        project.
                      </p>
                      <Button
                        variant="link"
                        onClick={() => reveal("files", "detail-self-service-setup")}
                      >
                        Edit launch details
                      </Button>
                    </>
                  ) : entry.pendingSetup ? (
                    <>
                      <p className="[overflow-wrap:anywhere]">{entry.pendingSetup.path}</p>
                      <p>This download has not become an installed game.</p>
                      <Button
                        variant="link"
                        onClick={() => reveal("files", "detail-self-service-setup")}
                      >
                        Continue setup
                      </Button>
                    </>
                  ) : (
                    <p>Set up this game before managing an installation.</p>
                  )}
                </CurrentStateSummary>
                <ManagementRow
                  title="Artwork"
                  targetId="detail-artwork"
                  description="Choose a cover, background, wide cover, or logo for this game."
                >
                  <ArtworkControls
                    key={entry.id + ":" + generation}
                    port={entry}
                    Preview={GameHeroFramingPreview}
                    previewActions={{
                      wide: play && launch.allowed ? t("selfService.play") : setupActionLabel,
                      narrow: continueAction.label,
                    }}
                  />
                </ManagementRow>
              </>
            ),
          })}
        </DetailLayout>
      )}
    />
  );
}
