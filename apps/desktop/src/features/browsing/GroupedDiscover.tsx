import { useGameComparison } from "../recommendations/use-game-comparison";
import {
  GameComparisonControls,
  GameComparisonEvidence,
} from "../recommendations/GameComparisonEvidence";
import { presentPortAction, useOperationPresentation } from "../operations/operation-presentation";
import type { CollectionLayout } from "./use-collection-layout";
import type { useFavorites } from "../favorites/use-favorites";
import { SaveGameButton, type Organization } from "../organization/OrganizationControls";
import type { TFunction } from "i18next";
import { useId, useRef, useState, type ReactNode } from "react";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../../localization";
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
import type { PortDefinition, PortStatus } from "../../types";
import { IdentityIcon } from "../identity/IdentityIcon";
import { identityLabel, identityStyle } from "../identity/identity-style";
import type { CatalogEntry } from "./catalog-entry";
import type { NativeSourceDragState } from "../../native-source-drop";
import { browsePortPresentation } from "../port-actions/browse-presentation";
import { BrowsePortObservations } from "../port-actions/BrowsePortObservations";
import { groupCatalog, originalSystems, type GameGroup } from "./original-game";
import { ImplementationChoice, ownsChoiceFocus } from "./ImplementationChoice";
import { resolveGameChoice } from "./game-choice";

export function IdentityChips({
  port,
  includeUnknown = false,
}: {
  port: CatalogEntry;
  includeUnknown?: boolean;
}) {
  const { t } = useAppTranslation("browsing");
  return (
    <div className="flex flex-wrap gap-1.5">
      {originalSystems(port)
        .filter((system) => includeUnknown || system !== "not-specified")
        .map((system) => (
          <Chip key={system} style={identityStyle(system)} title={t("discover.chip.system")}>
            <IdentityIcon name={system} />
            {identityLabel(system)}
          </Chip>
        ))}
      {port.platforms.map((platform) => (
        <Chip key={platform} title={t("discover.chip.platform")}>
          <IdentityIcon name={platform.split("-")[0]!} />
          {platformLabel(platform)}
        </Chip>
      ))}
      {port.channels?.map((channel) => (
        <Chip key={channel} style={identityStyle(channel, true)} title={t("discover.chip.channel")}>
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
  devicePlatform,
}: {
  /** Known only when Core reports this device; otherwise platforms stay listed. */
  devicePlatform?: PortDefinition["platforms"][number] | undefined;
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
  const { t } = useAppTranslation("browsing");
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
  const dialogRoot = useRef<HTMLDivElement>(null);
  const comparisonIntent = useRef({ active: false });
  const currentIntent = comparisonIntent.current;
  const heading = useRef<HTMLHeadingElement>(null);
  const leaving = useRef(false);
  const compare = (group: GameGroup, trigger: HTMLButtonElement) => {
    origin.current = trigger;
    comparisonIntent.current = { active: true };
    leaving.current = false;
    setComparison(group);
  };
  const open = (port: CatalogEntry, originKey: string) => {
    comparisonIntent.current.active = false;
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
        title={
          favorites.ids?.has(port.id) ? t("discover.favorite.remove") : t("discover.favorite.add")
        }
        variant={favorites.ids?.has(port.id) ? "selected" : "ghost"}
        aria-label={t("discover.favorite.label", { game: gameIdentityLabel(port) })}
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
        aria-label={t("discover.label")}
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
            devicePlatform={devicePlatform}
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
          if (!open) {
            comparisonIntent.current.active = false;
            setComparison(undefined);
          }
        }}
      >
        <DialogContent
          ref={dialogRoot}
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
                  ? t("discover.compare.single")
                  : t("discover.compare.several", { total: comparison.ports.length })}
              </DialogDescription>
              <details className="my-4 text-xs text-pc-muted-foreground">
                <summary data-focusable className="cursor-pointer py-2">
                  {t("discover.compare.options")}
                </summary>
                <p>{t("discover.compare.optionsIntro")}</p>
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
                  // With one port there is nothing to compare an absence against; rows
                  // without a value are omitted. Several ports keep every row aligned.
                  const single = comparison.ports.length === 1;
                  const setupLabel = installationMethodLabel(port);
                  const setupKnown = setupLabel !== "Unavailable in this catalog";
                  const filesListed = Boolean(port.presentation?.source_requirements?.length);
                  const ownershipKnown = Boolean(status?.active || status?.external_runtime);
                  return (
                    <article
                      key={port.id}
                      className="port-comparison-project min-w-0 wrap-anywhere"
                      aria-label={t("discover.cardLabel", {
                        game: gameIdentityLabel(port),
                        state: observation.state.label,
                      })}
                      aria-describedby={describedBy}
                      data-source-drop-port-id={dropEligible ? port.id : undefined}
                      data-source-drop-profile-id={dropEligible ? port.source_profile : undefined}
                    >
                      <header>
                        <h3>{gameProjectLabel(port) || port.name}</h3>
                        <p>{port.summary}</p>
                        <IdentityChips port={port} includeUnknown />
                        {!single && !port.platforms.length && (
                          <p>{t("discover.compare.noPlatform")}</p>
                        )}
                        {!single && !port.channels?.length && (
                          <p>{t("discover.compare.noChannel")}</p>
                        )}
                        {!matching.some((candidate) => candidate.id === port.id) && (
                          <p className="text-sm text-pc-muted-foreground">
                            {t("discover.compare.outsideFilters")}
                          </p>
                        )}
                      </header>
                      {(!single || setupKnown) && (
                        <div>
                          <h4>{t("discover.compare.setup")}</h4>
                          <p>{setupLabel}</p>
                        </div>
                      )}
                      {(!single || filesListed) && (
                        <div>
                          <h4>{t("discover.compare.files")}</h4>
                          {port.presentation?.source_requirements?.length ? (
                            <ul>
                              {port.presentation.source_requirements.map((requirement) => (
                                <li key={requirement.profile_id}>{requirement.label}</li>
                              ))}
                            </ul>
                          ) : (
                            <p>{t("discover.compare.filesUnlisted")}</p>
                          )}
                        </div>
                      )}
                      {(!single || ownershipKnown) && (
                        <div>
                          <h4>{t("discover.compare.updates")}</h4>
                          {renderComparisonOwnership(t, status)}
                        </div>
                      )}
                      <div className="min-w-0">
                        <GameComparisonEvidence
                          comparison={evidence}
                          portId={port.id}
                          organization={organization}
                        />
                      </div>
                      <div>
                        <h4>{t("discover.compare.status")}</h4>
                        <BrowsePortObservations
                          port={port}
                          status={status}
                          observation={observation}
                          descriptionId={descriptionId}
                          noticeChoice={organization?.snapshot?.update_notices[port.id]}
                        />
                      </div>

                      <div className="mt-3 flex flex-wrap gap-3">
                        {comparison.ports.length > 1 && (
                          <ImplementationChoice
                            port={port}
                            organization={organization}
                            onSelected={(trigger) => {
                              if (
                                comparisonIntent.current === currentIntent &&
                                currentIntent.active &&
                                ownsChoiceFocus(trigger, dialogRoot.current)
                              )
                                open(port, `catalog:card:${comparison.matchingPorts[0]!.id}`);
                            }}
                          />
                        )}
                        {favorite(port)}
                        <Button
                          data-focusable
                          variant="outline"
                          onClick={() =>
                            open(port, `catalog:card:${comparison.matchingPorts[0]!.id}`)
                          }
                          data-discover-port-id={port.id}
                          aria-label={t("discover.memberLabel", {
                            action: memberLabel(t, port, status),
                            game: gameIdentityLabel(port),
                          })}
                          aria-describedby={describedBy}
                        >
                          {memberLabel(t, port, statuses.get(port.id))}
                        </Button>
                        {port.project_url && (
                          <ExternalLink href={port.project_url}>
                            {t("discover.compare.instructions")}
                          </ExternalLink>
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

function renderComparisonOwnership(t: TFunction<"browsing">, status: PortStatus | undefined) {
  return (
    <p>
      {status?.active ? t("discover.ownership.managed") : ""}
      {status?.external_runtime ? t("discover.ownership.external") : ""}
      {!status
        ? t("discover.ownership.unavailable")
        : !status.active && !status.external_runtime
          ? t("discover.ownership.notInstalled")
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
  devicePlatform,
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
  devicePlatform?: PortDefinition["platforms"][number] | undefined;
  organization?: Organization | undefined;
  favorite: (port: CatalogEntry, card?: boolean) => ReactNode;
  open: (port: CatalogEntry, originKey: string) => void;
  compare: (group: GameGroup, trigger: HTMLButtonElement) => void;
}) {
  const { t } = useAppTranslation("browsing");
  const { first, actionGroup, status, exact, firstProject, projectLabel } = discoverCardIdentity(
    t,
    group,
    statuses,
    organization,
  );
  const observation = browsePortPresentation(first, status, "catalog");
  const descriptionId = `${descriptionPrefix}:${encodeURIComponent(first.id)}`;
  const describedBy = exact && (observation.input || observation.setup) ? descriptionId : undefined;
  const dropEligible =
    group.ports.length === 1 && sourceDropEligible(first, status, nativeSourceDrag);
  const dropTarget = dropEligible && nativeSourceDrag.targetPortId === first.id;
  const detailOrigin = `catalog:card:${first.id}`;
  const { element: artworkElement, visible } = useArtworkVisibility();
  const { display: artwork } = useArtwork(first.id, "cover", visible);
  const artworkNotice = artworkDisplayNotice(artwork);
  return (
    <article
      key={group.id}
      className={`discover-game relative min-w-0${dropTarget ? " outline-3 outline-offset-2 outline-pc-ring" : ""}`}
      aria-label={
        exact
          ? t("discover.cardLabel", {
              game: gameIdentityLabel(first),
              state: observation.state.label,
            })
          : t("discover.groupLabel", {
              title: gameTitle(first),
              count: group.ports.length,
              matching: group.matchingPorts.length,
            })
      }
      aria-describedby={describedBy}
      data-source-drop-port-id={dropEligible ? first.id : undefined}
      data-source-drop-profile-id={dropEligible ? first.source_profile : undefined}
      data-discover-port-ids={JSON.stringify(group.ports.map((port) => port.id))}
      data-detail-return-group={group.id}
      data-discover-matching-port-ids={JSON.stringify(group.matchingPorts.map((port) => port.id))}
      data-discover-primary-port-id={exact ? first.id : undefined}
    >
      <Button
        variant="ghost"
        className="discover-game-identity grid w-full min-w-0 justify-start justify-items-stretch gap-x-3 gap-y-0 p-0 text-start"
        data-focusable
        data-detail-origin={detailOrigin}
        data-detail-game-id={first.id}
        aria-label={
          !exact
            ? undefined
            : group.ports.length > 1
              ? t("discover.identity.matching", {
                  title: gameTitle(first),
                  project: projectLabel,
                  port: firstProject,
                  state: observation.state.label,
                  action: memberLabel(t, first, status),
                })
              : t("discover.identity.single", {
                  title: gameTitle(first),
                  project: projectLabel,
                  state: observation.state.label,
                  action: memberLabel(t, first, status),
                })
        }
        aria-describedby={describedBy}
        onClick={(event) =>
          exact ? open(first, detailOrigin) : compare(group, event.currentTarget)
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
      <DiscoverGameMetadata
        port={first}
        status={status}
        exact={exact}
        devicePlatform={devicePlatform}
        artworkNotice={artworkNotice}
      />
      <DiscoverGameObservation
        group={actionGroup}
        first={first}
        status={status}
        observation={observation}
        descriptionId={descriptionId}
        firstProject={firstProject}
        organization={organization}
      />
      <DiscoverGameActions
        onTask={onTask}
        group={actionGroup}
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
          {dropTarget ? t("discover.drop.release") : t("discover.drop.hover")}
        </div>
      )}
    </article>
  );
}

function DiscoverGameMetadata({
  port,
  status,
  exact,
  devicePlatform,
  artworkNotice,
}: {
  port: CatalogEntry;
  status: PortStatus | undefined;
  exact: boolean;
  devicePlatform: PortDefinition["platforms"][number] | undefined;
  artworkNotice: ReturnType<typeof artworkDisplayNotice>;
}) {
  const { t } = useAppTranslation("browsing");
  return (
    <div className="discover-game-metadata grid content-start gap-2">
      {artworkNotice && <p className="text-xs text-pc-muted-foreground">{artworkNotice}</p>}
      {/* Most catalog ports offer only Stable; that chip does not help choose a game.
          Preview, Rolling, mixed channels and a differing selected channel stay visible. */}
      {/* On a known device, platform chips repeat on every card; show only the
          exception. Without a known device, the platforms stay listed. */}
      {exact && (
        <IdentityChips
          port={{
            ...port,
            ...(devicePlatform ? { platforms: [] } : {}),
            ...(port.channels?.length === 1 &&
            port.channels[0] === "stable" &&
            (!status?.channel || status.channel === "stable")
              ? { channels: [] }
              : {}),
          }}
        />
      )}
      {exact &&
        devicePlatform &&
        port.platforms.length > 0 &&
        !port.platforms.includes(devicePlatform) && (
          <p className="m-0 text-xs text-pc-muted-foreground">
            {t("discover.unavailableFor", { platform: platformLabel(devicePlatform) })}
          </p>
        )}
    </div>
  );
}

function discoverCardIdentity(
  t: TFunction<"browsing">,
  group: GameGroup,
  statuses: ReadonlyMap<string, PortStatus>,
  organization: Organization | undefined,
) {
  const chosen = resolveGameChoice(
    group,
    statuses,
    organization?.snapshot ? (organization.snapshot.preferred_port_by_game ?? {}) : undefined,
  ).port;
  const first = chosen ?? group.matchingPorts[0]!;
  const firstProject = gameProjectLabel(first) || first.name;
  return {
    first,
    actionGroup: chosen ? { ...group, matchingPorts: [chosen] } : group,
    status: statuses.get(first.id),
    exact: Boolean(chosen) || group.matchingPorts.length === 1,
    firstProject,
    projectLabel:
      group.ports.length === 1
        ? firstProject
        : t("discover.separateProjects", { count: group.ports.length }),
  };
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
  const { t } = useAppTranslation("browsing");
  const exact = group.matchingPorts.length === 1;
  return (
    <div className="discover-game-observation grid content-start gap-1">
      {exact ? (
        <>
          {group.ports.length > 1 && (
            <p className="text-xs text-pc-muted-foreground">
              <Trans
                t={t}
                i18nKey="discover.matchingPort"
                components={{ port: <bdi>{firstProject}</bdi> }}
              />
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
        <p className="text-xs text-pc-muted-foreground">{t("discover.compareMatching")}</p>
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
  const { t } = useAppTranslation("browsing");
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
          ? t("discover.action.task")
          : group.matchingPorts.length === 1
            ? memberLabel(t, first, statuses.get(first.id))
            : t("discover.action.compare")}
        <ArrowRight aria-hidden="true" />
      </Button>
      {group.ports.length === 1 && (
        <Button
          data-focusable
          variant="ghost"
          size="sm"
          onClick={(event) => compare(group, event.currentTarget)}
        >
          {t("discover.action.why")}
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
          {t("discover.action.compareAll", { total: group.ports.length })}
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

function memberLabel(t: TFunction<"browsing">, port: CatalogEntry, status: PortStatus | undefined) {
  return port.pendingSetup
    ? t("discover.action.continue")
    : status?.active || status?.external_runtime
      ? t("discover.action.installation")
      : t("discover.action.port");
}
