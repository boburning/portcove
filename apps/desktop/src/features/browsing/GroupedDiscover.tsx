import { useGameComparison } from "../recommendations/use-game-comparison";
import {
  GameComparisonControls,
  GameComparisonEvidence,
} from "../recommendations/GameComparisonEvidence";
import { presentPortAction, useOperationPresentation } from "../operations/operation-presentation";
import type { CollectionLayout } from "./use-collection-layout";
import type { useFavorites } from "../favorites/use-favorites";
import { SaveGameButton, type Organization } from "../organization/OrganizationControls";
import { useId, useRef, useState, type ReactNode } from "react";
import { ArrowRight, GitCompareArrows, Heart, Star } from "lucide-react";
import { ArtworkFrame, artworkDisplayNotice } from "../../components/Artwork";
import { useArtwork, useArtworkVisibility } from "../../artwork";
import { ExternalLink } from "../../components/ExternalLink";
import { Button } from "../../components/ui/button";
import { Chip } from "../../components/ui/chip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { gameIdentityLabel, gameProjectLabel, gameTitle } from "../../port-identity";
import {
  platformLabel,
  installationMethodLabel,
  releaseChannelPresentation,
  type DetailDestination,
} from "../../view-model";
import type { PortStatus } from "../../types";
import { IdentityIcon } from "../identity/IdentityIcon";
import { identityLabel, identityStyle } from "../identity/identity-style";
import type { CatalogEntry } from "./catalog-entry";
import type { NativeSourceDragState } from "../../native-source-drop";
import { browsePortPresentation } from "../port-actions/browse-presentation";
import { BrowsePortObservations } from "../port-actions/BrowsePortObservations";
import { groupCatalog, originalSystems, type GameGroup } from "./original-game";

export function IdentityChips({
  port,
  includeUnknown = false,
}: {
  port: CatalogEntry;
  includeUnknown?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {originalSystems(port)
        .filter((system) => includeUnknown || system !== "not-specified")
        .map((system) => (
          <Chip key={system} style={identityStyle(system)} title="Original system">
            <IdentityIcon name={system} />
            {identityLabel(system)}
          </Chip>
        ))}
      {port.platforms.map((platform) => (
        <Chip key={platform} style={identityStyle(platform.split("-")[0]!)} title="Runs on">
          <IdentityIcon name={platform.split("-")[0]!} />
          {platformLabel(platform)}
        </Chip>
      ))}
      {port.channels?.map((channel) => (
        <Chip key={channel} style={identityStyle(channel, true)} title="Release channel">
          <IdentityIcon name={channel} channel />
          {releaseChannelPresentation(channel).label}
        </Chip>
      ))}
    </div>
  );
}

export function GroupedDiscover({
  layout = "covers",
  all,
  onTask,
  matching,
  statuses,
  onSelect,
  organization,
  favorites,
  onFavoriteToggle,
  nativeSourceDrag = { active: false, pathCount: 0 },
}: {
  layout?: CollectionLayout;
  organization?: Organization | undefined;
  favorites?: ReturnType<typeof useFavorites> | undefined;
  onFavoriteToggle: (portId: string, button: HTMLElement) => void;
  nativeSourceDrag?: NativeSourceDragState | undefined;
  onTask?: ((activityId?: string) => void) | undefined;
  all: readonly CatalogEntry[];
  matching: readonly CatalogEntry[];
  statuses: ReadonlyMap<string, PortStatus>;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
}) {
  const groups = groupCatalog(all, matching);
  const descriptionPrefix = useId();
  const [comparisonSelection, setComparison] = useState<GameGroup>();
  const comparison =
    comparisonSelection &&
    groupCatalog(all, all).find((group) =>
      group.ports.some((port) => port.id === comparisonSelection.ports[0]?.id),
    );
  const owner = useOperationPresentation();
  const comparisonObservationKey = JSON.stringify([
    comparison?.ports,
    comparison?.ports.map((port) => statuses.get(port.id)),
    organization?.snapshot?.revision,
  ]);
  const evidence = useGameComparison({
    portId: comparison?.ports[0]?.id,
    generation: owner?.generation,
    observationKey: comparisonObservationKey,
  });
  const origin = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const leaving = useRef(false);
  const compare = (group: GameGroup, trigger: HTMLButtonElement) => {
    origin.current = trigger;
    leaving.current = false;
    setComparison(group);
  };
  const open = (port: CatalogEntry, originKey: string) => {
    leaving.current = true;
    setComparison(undefined);
    onSelect(port.id, originKey);
  };
  const favorite = (port: CatalogEntry, card = false) =>
    favorites && (
      <Button
        data-focusable
        size="icon-sm"
        className={card ? "collection-art-action collection-favorite" : undefined}
        title={favorites.ids?.has(port.id) ? "Remove from favorites" : "Add to favorites"}
        variant={favorites.ids?.has(port.id) ? "selected" : "ghost"}
        aria-label={`Favorite ${gameIdentityLabel(port)}`}
        aria-pressed={favorites.ids?.has(port.id) ?? false}
        disabled={!favorites.ids || favorites.busy}
        onClick={(event) => onFavoriteToggle(port.id, event.currentTarget)}
      >
        {card ? <Heart aria-hidden="true" /> : <Star aria-hidden="true" />}
      </Button>
    );
  return (
    <>
      <section
        aria-label="Discover games"
        className={`port-grid discover-grid discover-${layout} collection-${layout} @container/collection grid w-full`}
        data-focus-group
      >
        {groups.map((group) => (
          <DiscoverGameCard
            onTask={onTask}
            key={group.id}
            group={group}
            statuses={statuses}
            descriptionPrefix={descriptionPrefix}
            nativeSourceDrag={nativeSourceDrag}
            organization={organization}
            favorite={favorite}
            open={open}
            compare={compare}
          />
        ))}
      </section>
      <Dialog
        open={Boolean(comparison)}
        onOpenChange={(open) => {
          if (!open) setComparison(undefined);
        }}
      >
        <DialogContent
          reviewSize="large"
          className="port-comparison-dialog"
          initialFocus={heading}
          finalFocus={() => (leaving.current ? false : origin.current)}
        >
          {comparison && (
            <>
              <DialogTitle ref={heading} tabIndex={-1}>
                {gameTitle(comparison.matchingPorts[0]!)}
              </DialogTitle>
              <DialogDescription>
                {comparison.ports.length === 1
                  ? "Review this port’s requirements and recorded information."
                  : `Compare ${comparison.ports.length} port projects. Each keeps its own installation, files and saved data.`}
              </DialogDescription>
              <details className="my-4 text-xs text-pc-muted-foreground">
                <summary data-focusable className="cursor-pointer py-2">
                  Recorded evidence and comparison settings
                </summary>
                <p>
                  Feature details are not available for every project. Check the recorded evidence
                  and project instructions. Switching projects does not establish save or mod
                  compatibility.
                </p>
                <GameComparisonControls comparison={evidence} />
              </details>
              <div className="port-comparison-grid">
                {comparison.ports.map((port) => {
                  const status = statuses.get(port.id);
                  const observation = browsePortPresentation(port, status, "catalog");
                  const descriptionId = `${descriptionPrefix}:comparison:${encodeURIComponent(port.id)}`;
                  const describedBy =
                    observation.input || observation.setup ? descriptionId : undefined;
                  const dropEligible = sourceDropEligible(port, status, nativeSourceDrag);
                  return (
                    <article
                      key={port.id}
                      className="port-comparison-project min-w-0 wrap-anywhere"
                      aria-label={`${gameIdentityLabel(port)}. ${observation.state.label}.`}
                      aria-describedby={describedBy}
                      data-source-drop-port-id={dropEligible ? port.id : undefined}
                      data-source-drop-profile-id={dropEligible ? port.source_profile : undefined}
                    >
                      <header>
                        <h3>{gameProjectLabel(port) || port.name}</h3>
                        <p>{port.summary}</p>
                        <IdentityChips port={port} includeUnknown />
                        {!port.platforms.length && <p>No platform is listed.</p>}
                        {!port.channels?.length && <p>No release channel is listed.</p>}
                        {!matching.some((candidate) => candidate.id === port.id) && (
                          <p className="text-sm text-pc-muted-foreground">
                            Outside the current filters.
                          </p>
                        )}
                      </header>
                      <div className="min-w-0">
                        <GameComparisonEvidence
                          comparison={evidence}
                          portId={port.id}
                          organization={organization}
                        />
                      </div>
                      <div>
                        <h4>Setup route</h4>
                        <p>{installationMethodLabel(port)}</p>
                      </div>
                      <div>
                        <h4>Required files</h4>
                        {port.presentation?.source_requirements?.length ? (
                          <ul>
                            {port.presentation.source_requirements.map((requirement) => (
                              <li key={requirement.profile_id}>{requirement.label}</li>
                            ))}
                          </ul>
                        ) : (
                          <p>
                            Requirements are not listed here. Check the project’s setup
                            instructions.
                          </p>
                        )}
                      </div>
                      <div>
                        <h4>Ownership</h4>
                        {renderComparisonOwnership(status)}
                      </div>
                      <div>
                        <h4>Current observations</h4>
                        <BrowsePortObservations
                          port={port}
                          status={status}
                          observation={observation}
                          descriptionId={descriptionId}
                          noticeChoice={organization?.snapshot?.update_notices[port.id]}
                        />
                      </div>

                      <div className="mt-3 flex flex-wrap gap-3">
                        {favorite(port)}
                        <Button
                          data-focusable
                          variant="outline"
                          onClick={() =>
                            open(port, `catalog:card:${comparison.matchingPorts[0]!.id}`)
                          }
                          data-discover-port-id={port.id}
                          aria-label={`${memberLabel(port, status)}: ${gameIdentityLabel(port)}`}
                          aria-describedby={describedBy}
                        >
                          {memberLabel(port, statuses.get(port.id))}
                        </Button>
                        {port.project_url && (
                          <ExternalLink href={port.project_url}>Project instructions</ExternalLink>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function renderComparisonOwnership(status: PortStatus | undefined) {
  return (
    <p>
      {status?.active ? "Managed installation. Portcove handles reviewed updates." : ""}
      {status?.external_runtime ? "External installation. You or its launcher handle updates." : ""}
      {!status
        ? "Installation ownership is unavailable. Check the project instructions."
        : !status.active && !status.external_runtime
          ? "Not installed. Follow this project’s setup instructions."
          : ""}
    </p>
  );
}

function DiscoverGameCard({
  group,
  onTask,
  statuses,
  descriptionPrefix,
  nativeSourceDrag,
  organization,
  favorite,
  open,
  compare,
}: {
  group: GameGroup;
  onTask?: ((activityId?: string) => void) | undefined;
  statuses: ReadonlyMap<string, PortStatus>;
  descriptionPrefix: string;
  nativeSourceDrag: NativeSourceDragState;
  organization?: Organization | undefined;
  favorite: (port: CatalogEntry, card?: boolean) => ReactNode;
  open: (port: CatalogEntry, originKey: string) => void;
  compare: (group: GameGroup, trigger: HTMLButtonElement) => void;
}) {
  const first = group.matchingPorts[0]!;
  const status = statuses.get(first.id);
  const exact = group.matchingPorts.length === 1;
  const observation = browsePortPresentation(first, status, "catalog");
  const descriptionId = `${descriptionPrefix}:${encodeURIComponent(first.id)}`;
  const describedBy = exact && (observation.input || observation.setup) ? descriptionId : undefined;
  const dropEligible =
    group.ports.length === 1 && sourceDropEligible(first, status, nativeSourceDrag);
  const dropTarget = dropEligible && nativeSourceDrag.targetPortId === first.id;
  const detailOrigin = `catalog:card:${first.id}`;
  const firstProject = gameProjectLabel(first) || first.name;
  const projectLabel =
    group.ports.length === 1 ? firstProject : `${group.ports.length} separate port projects`;
  const { element: artworkElement, visible } = useArtworkVisibility();
  const { display: artwork } = useArtwork(first.id, "cover", visible);
  const artworkNotice = artworkDisplayNotice(artwork);
  return (
    <article
      key={group.id}
      className={`discover-game relative min-w-0${dropTarget ? " outline-3 outline-offset-2 outline-pc-ring" : ""}`}
      aria-label={
        exact
          ? `${gameIdentityLabel(first)}. ${observation.state.label}.`
          : `${gameTitle(first)}. ${group.ports.length} separate port projects; ${group.matchingPorts.length} matching.`
      }
      aria-describedby={describedBy}
      data-source-drop-port-id={dropEligible ? first.id : undefined}
      data-source-drop-profile-id={dropEligible ? first.source_profile : undefined}
      data-discover-port-ids={JSON.stringify(group.ports.map((port) => port.id))}
      data-discover-matching-port-ids={JSON.stringify(group.matchingPorts.map((port) => port.id))}
    >
      <Button
        variant="ghost"
        className="discover-game-identity grid w-full min-w-0 justify-start justify-items-stretch gap-x-3 gap-y-0 p-0 text-start"
        data-focusable
        data-detail-origin={detailOrigin}
        aria-label={
          exact
            ? `${gameTitle(first)} ${projectLabel}. ${group.ports.length > 1 ? `Matching port: ${firstProject}. ` : ""}${observation.state.label}. ${memberLabel(first, status)}`
            : undefined
        }
        aria-describedby={describedBy}
        onClick={(event) =>
          group.matchingPorts.length === 1
            ? open(first, detailOrigin)
            : compare(group, event.currentTarget)
        }
      >
        <ArtworkFrame
          element={artworkElement}
          display={artwork}
          identityArtwork
          className="collection-art"
        />
        <h2 className="collection-title font-semibold">{gameTitle(first)}</h2>{" "}
        <p className="collection-project text-pc-muted-foreground">{projectLabel}</p>
      </Button>
      <div className="collection-personal-actions">
        {group.ports.length === 1 && favorite(first, true)}
        <SaveGameButton card port={first} groupPorts={group.ports} organization={organization} />
      </div>
      <div className="discover-game-metadata grid content-start gap-2">
        {artworkNotice && <p className="text-xs text-pc-muted-foreground">{artworkNotice}</p>}
        {exact && <IdentityChips port={first} />}
      </div>
      <DiscoverGameObservation
        group={group}
        first={first}
        status={status}
        observation={observation}
        descriptionId={descriptionId}
        firstProject={firstProject}
        organization={organization}
      />
      <DiscoverGameActions
        onTask={onTask}
        group={group}
        statuses={statuses}
        first={first}
        detailOrigin={detailOrigin}
        describedBy={describedBy}
        open={open}
        compare={compare}
      />
      {dropEligible && (
        <div
          aria-hidden="true"
          className="source-drop-target pointer-events-none absolute inset-0 grid place-items-center rounded-pc-md border-2 border-dashed border-pc-interactive bg-pc-interactive/90 p-3 text-center text-sm font-bold text-pc-action-foreground"
        >
          {dropTarget ? "Release to check" : "Drop to check for this game"}
        </div>
      )}
    </article>
  );
}

function DiscoverGameObservation({
  group,
  first,
  status,
  observation,
  descriptionId,
  firstProject,
  organization,
}: {
  group: GameGroup;
  first: CatalogEntry;
  status: PortStatus | undefined;
  observation: ReturnType<typeof browsePortPresentation>;
  descriptionId: string;
  firstProject: string;
  organization: Organization | undefined;
}) {
  const exact = group.matchingPorts.length === 1;
  return (
    <div className="discover-game-observation grid content-start gap-1">
      {exact ? (
        <>
          {group.ports.length > 1 && (
            <p className="text-xs text-pc-muted-foreground">Matching port: {firstProject}</p>
          )}
          <BrowsePortObservations
            port={first}
            status={status}
            observation={observation}
            descriptionId={descriptionId}
            noticeChoice={organization?.snapshot?.update_notices[first.id]}
          />
        </>
      ) : (
        <p className="text-xs text-pc-muted-foreground">
          Compare the matching ports for their own setup requirements and installation status.
        </p>
      )}
    </div>
  );
}

function DiscoverGameActions({
  group,
  onTask,
  statuses,
  first,
  detailOrigin,
  describedBy,
  open,
  compare,
}: Pick<
  Parameters<typeof DiscoverGameCard>[0],
  "group" | "onTask" | "statuses" | "open" | "compare"
> & {
  first: CatalogEntry;
  detailOrigin: string;
  describedBy: string | undefined;
}) {
  const action = presentPortAction(
    useOperationPresentation(),
    first.id,
    statuses.get(first.id),
    "launch",
  );
  const task = group.matchingPorts.length === 1 && action.pending && onTask;
  return (
    <div className="discover-game-actions grid content-start justify-items-start gap-2">
      <Button
        data-focusable
        variant="outline"
        size="sm"
        className="discover-card-action"
        data-detail-origin={`${detailOrigin}:details`}
        aria-describedby={describedBy}
        onClick={(event) =>
          task
            ? onTask?.(action.pending?.context.activityId)
            : group.matchingPorts.length === 1
              ? open(first, `${detailOrigin}:details`)
              : compare(group, event.currentTarget)
        }
      >
        {task
          ? "View task"
          : group.matchingPorts.length === 1
            ? memberLabel(first, statuses.get(first.id))
            : "Compare ports"}
        <ArrowRight aria-hidden="true" />
      </Button>
      {group.ports.length === 1 && (
        <Button
          data-focusable
          variant="ghost"
          size="sm"
          onClick={(event) => compare(group, event.currentTarget)}
        >
          Why this port?
        </Button>
      )}
      {group.ports.length > 1 && group.matchingPorts.length === 1 && (
        <Button
          data-focusable
          size="sm"
          variant="ghost"
          onClick={(event) => compare(group, event.currentTarget)}
        >
          <GitCompareArrows aria-hidden="true" />
          Compare all {group.ports.length}
        </Button>
      )}
    </div>
  );
}

function sourceDropEligible(
  port: CatalogEntry,
  status: PortStatus | undefined,
  drag: NativeSourceDragState,
) {
  return (
    drag.active &&
    Boolean(port.source_profile) &&
    !status?.external_runtime?.user_selected &&
    !port.pendingSetup
  );
}

function memberLabel(port: CatalogEntry, status: PortStatus | undefined) {
  return port.pendingSetup
    ? "Continue setup"
    : status?.active || status?.external_runtime
      ? "View installation"
      : "View port";
}
