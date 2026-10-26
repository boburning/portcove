import type { useFavorites } from "../favorites/use-favorites";
import { SaveGameButton, type Organization } from "../organization/OrganizationControls";
import { useId, useRef, useState } from "react";
import { ArrowRight, GitCompareArrows, Star } from "lucide-react";
import { ArtworkImage } from "../../components/Artwork";
import { ExternalLink } from "../../components/ExternalLink";
import { Button } from "../../components/ui/button";
import { Chip } from "../../components/ui/chip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { gameIdentityLabel, gameProjectLabel, gameTitle } from "../../port-identity";
import {
  platformLabel,
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
import { groupCatalog, groupCountLabel, originalSystems, type GameGroup } from "./original-game";

export function IdentityChips({ port }: { port: CatalogEntry }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {originalSystems(port).map((system) => (
        <Chip key={system} style={identityStyle(system)}>
          <IdentityIcon name={system} />
          {identityLabel(system)}
        </Chip>
      ))}
      {port.platforms.map((platform) => (
        <Chip key={platform} style={identityStyle(platform.split("-")[0]!)}>
          <IdentityIcon name={platform.split("-")[0]!} />
          {platformLabel(platform)}
        </Chip>
      ))}
      {port.channels?.map((channel) => (
        <Chip key={channel} style={identityStyle(channel, true)}>
          <IdentityIcon name={channel} channel />
          {releaseChannelPresentation(channel).label}
        </Chip>
      ))}
    </div>
  );
}

export function GroupedDiscover({
  all,
  matching,
  statuses,
  onSelect,
  organization,
  favorites,
  onFavoriteToggle,
  nativeSourceDrag = { active: false, pathCount: 0 },
}: {
  organization?: Organization | undefined;
  favorites?: ReturnType<typeof useFavorites> | undefined;
  onFavoriteToggle: (portId: string, button: HTMLElement) => void;
  nativeSourceDrag?: NativeSourceDragState | undefined;
  all: readonly CatalogEntry[];
  matching: readonly CatalogEntry[];
  statuses: ReadonlyMap<string, PortStatus>;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
}) {
  const groups = groupCatalog(all, matching);
  const descriptionPrefix = useId();
  const [comparison, setComparison] = useState<GameGroup>();
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
  const favorite = (port: CatalogEntry) =>
    favorites && (
      <Button
        data-focusable
        size="icon-sm"
        variant={favorites.ids?.has(port.id) ? "selected" : "ghost"}
        aria-label={`Favorite ${gameIdentityLabel(port)}`}
        aria-pressed={favorites.ids?.has(port.id) ?? false}
        disabled={!favorites.ids || favorites.busy}
        onClick={(event) => onFavoriteToggle(port.id, event.currentTarget)}
      >
        <Star aria-hidden="true" />
      </Button>
    );
  return (
    <>
      <p className="mb-4 text-sm text-pc-muted-foreground">
        {groupCountLabel(groups)} · {matching.length} matching{" "}
        {matching.length === 1 ? "port" : "ports"}
      </p>
      <section
        aria-label="Discover games"
        className="port-grid collection-covers @container/collection grid w-full"
        data-focus-group
      >
        {groups.map((group) => {
          const first = group.matchingPorts[0]!;
          const status = statuses.get(first.id);
          const exact = group.matchingPorts.length === 1;
          const observation = browsePortPresentation(first, status, "catalog");
          const descriptionId = `${descriptionPrefix}:${encodeURIComponent(first.id)}`;
          const describedBy =
            exact && (observation.input || observation.setup) ? descriptionId : undefined;
          const dropEligible =
            group.ports.length === 1 && sourceDropEligible(first, status, nativeSourceDrag);
          const dropTarget = dropEligible && nativeSourceDrag.targetPortId === first.id;
          const detailOrigin = `catalog:card:${first.id}`;
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
              data-discover-matching-port-ids={JSON.stringify(
                group.matchingPorts.map((port) => port.id),
              )}
            >
              <Button
                variant="ghost"
                className="discover-game-identity grid w-full justify-items-start p-0 text-start"
                data-focusable
                data-detail-origin={detailOrigin}
                aria-label={
                  exact
                    ? `${gameIdentityLabel(first)}. ${observation.state.label}. ${memberLabel(first, status)}`
                    : undefined
                }
                aria-describedby={describedBy}
                onClick={(event) =>
                  group.matchingPorts.length === 1
                    ? open(first, detailOrigin)
                    : compare(group, event.currentTarget)
                }
              >
                <ArtworkImage port={first} className="collection-art" quietFallback />
                <h2 className="collection-title text-base font-semibold">{gameTitle(first)}</h2>
                <p className="collection-project text-xs text-pc-muted-foreground">
                  {group.ports.length === 1
                    ? gameProjectLabel(first) || first.name
                    : `${group.ports.length} separate port projects`}
                </p>
              </Button>
              {exact && <IdentityChips port={first} />}
              {exact ? (
                <>
                  {group.ports.length > 1 && (
                    <p className="text-xs text-pc-muted-foreground">
                      Matching port: {gameProjectLabel(first) || first.name}
                    </p>
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
                  Compare the matching ports for their own setup requirements and installation
                  status.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {group.ports.length === 1 && favorite(first)}
                <SaveGameButton port={first} groupPorts={group.ports} organization={organization} />
                <Button
                  data-focusable
                  variant="outline"
                  size="sm"
                  data-detail-origin={`${detailOrigin}:details`}
                  aria-describedby={describedBy}
                  onClick={(event) =>
                    group.matchingPorts.length === 1
                      ? open(first, `${detailOrigin}:details`)
                      : compare(group, event.currentTarget)
                  }
                >
                  {group.matchingPorts.length === 1
                    ? memberLabel(first, statuses.get(first.id))
                    : "Compare ports"}
                  <ArrowRight aria-hidden="true" />
                </Button>
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
        })}
      </section>
      <Dialog
        open={Boolean(comparison)}
        onOpenChange={(open) => {
          if (!open) setComparison(undefined);
        }}
      >
        <DialogContent
          initialFocus={heading}
          finalFocus={() => (leaving.current ? false : origin.current)}
        >
          {comparison && (
            <>
              <DialogTitle ref={heading} tabIndex={-1}>
                {gameTitle(comparison.matchingPorts[0]!)}
              </DialogTitle>
              <DialogDescription>
                Compare {comparison.ports.length} separate port projects. Each keeps its own
                installation, files and saved data.
              </DialogDescription>
              <p className="text-sm text-pc-muted-foreground">
                These are catalog declarations and current library observations. Gameplay
                comparisons have not been established for every project.
              </p>
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
                    className="border-t border-pc-border py-4"
                    aria-label={`${gameIdentityLabel(port)}. ${observation.state.label}.`}
                    aria-describedby={describedBy}
                    data-source-drop-port-id={dropEligible ? port.id : undefined}
                    data-source-drop-profile-id={dropEligible ? port.source_profile : undefined}
                  >
                    <h3>{gameProjectLabel(port) || port.name}</h3>
                    <p>{port.summary}</p>
                    <IdentityChips port={port} />
                    <BrowsePortObservations
                      port={port}
                      status={status}
                      observation={observation}
                      descriptionId={descriptionId}
                      noticeChoice={organization?.snapshot?.update_notices[port.id]}
                    />
                    {port.presentation?.source_requirements?.length ? (
                      <ul>
                        {port.presentation.source_requirements.map((requirement) => (
                          <li key={requirement.profile_id}>{requirement.label}</li>
                        ))}
                      </ul>
                    ) : null}
                    {!comparison.matchingPorts.some((candidate) => candidate.id === port.id) && (
                      <p className="text-sm text-pc-muted-foreground">
                        Outside the current filters.
                      </p>
                    )}
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
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
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
