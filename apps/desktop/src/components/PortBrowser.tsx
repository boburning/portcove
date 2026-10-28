import { MediaCredit } from "./CatalogMedia";
import {
  browsePortPresentation,
  browseStatusSummary,
  readinessPresentation,
} from "../features/port-actions/browse-presentation";
import { updateNoticeHidden } from "../features/organization/organization";
import { gameUpdateAcquisitionLabel } from "../features/port-updates/acquisition-presentation";
import {
  OrganizationControls,
  OrganizationMenuItems,
  organizedPorts,
  type Organization,
} from "../features/organization/OrganizationControls";
import { GroupedDiscover, IdentityChips } from "../features/browsing/GroupedDiscover";
import { groupCatalog, groupCountLabel } from "../features/browsing/original-game";
import { PortSearch } from "./PortSearch";
import { controlFocus, floatingMotion } from "./ui/control-style";
import { gameTitle, gameProjectLabel, gameIdentityLabel } from "../port-identity";
import { cn } from "cn";
import { Notice } from "./ui/patterns";
import type { useFavorites } from "../features/favorites/use-favorites";
import {
  useState,
  useRef,
  useEffect,
  useId,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";
import type { CollectionLayout } from "../features/browsing/use-collection-layout";
import {
  Boxes,
  CheckCircle2,
  Gamepad2,
  LoaderCircle,
  MoreHorizontal,
  Settings2,
  Star,
  Wrench,
} from "lucide-react";
import {
  installedCardInputPresentation,
  hasPendingSetupAction,
  concurrentReadinessReasons,
} from "../features/port-actions/port-action-presentation";
import type { PortDefinition, PortStatus } from "../types";
import { listingActionAssessment, type CatalogEntry } from "../features/browsing/catalog-entry";
import { observedUpdateCandidate } from "../features/browsing/update-query-context";
import {
  currentUpdateSnapshot,
  mostRecentPort,
  filterOptions,
  filterPorts,
  portReadiness,
  hasUnconfirmedLaunchInput,
  releaseChannelPresentation,
  type Filter,
  type CatalogSort,
  type DetailDestination,
  type LibraryOverview,
  type PortReadiness,
  type RecentPort,
  type View,
} from "../view-model";
import { BrandMascot, BrandWordmark } from "./Brand";
import { BrandMotif, EmptyState, Icon } from "./ui";
import type { NativeSourceDragState } from "../native-source-drop";
import { ArtworkFrame, artworkDisplayNotice } from "./Artwork";
import { useArtwork, useArtworkVisibility, useHeaderArtwork } from "../artwork";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { Menu } from "@base-ui/react/menu";
import { ChoiceSelect } from "./ChoiceSelect";
import { SteamBatchEntryDialog } from "./SteamEntry";
import {
  presentPortAction,
  useOperationPresentation,
} from "../features/operations/operation-presentation";
import {
  evaluateCatalogQuery,
  type CatalogQuery,
  type CatalogQueryContext,
} from "../features/browsing/catalog-query";
import { CatalogFilters, queryFromFilter } from "../features/browsing/CatalogFilters";
import type { GameFileFilterState } from "../features/browsing/use-game-file-filter-context";

const catalogSortOptions: readonly { value: CatalogSort; label: string }[] = [
  { value: "catalog", label: "Suggested order" },
  { value: "name", label: "Title A–Z" },
  { value: "name-desc", label: "Title Z–A" },
  { value: "installed-first", label: "In library first" },
];

function firstLibraryVisit({
  view,
  loading,
  recent,
  installed,
  portCount,
  constrained,
  query,
}: {
  view: View;
  loading: boolean;
  recent: RecentPort | undefined;
  installed: number;
  portCount: number;
  constrained: boolean;
  query: string;
}) {
  return (
    view === "library" &&
    !loading &&
    !recent &&
    installed === 0 &&
    portCount === 0 &&
    !constrained &&
    query.trim().length === 0
  );
}
function visibleRecentPort(
  recent: RecentPort | undefined,
  organization: Organization | undefined,
  ports: CatalogEntry[],
  statuses: Map<string, PortStatus>,
) {
  return organization?.snapshot?.hidden_port_ids.includes(recent?.port.id ?? "")
    ? mostRecentPort(
        ports.filter((port) => !organization.snapshot?.hidden_port_ids.includes(port.id)),
        statuses,
      )
    : recent;
}

function usePortBrowser({
  organization,
  catalogUniverse,
  favorites,
  view,
  ports,
  catalogFilterCandidates,
  libraryFilterCandidates,
  queryContext,
  gameFileQuery,
  libraryReadiness = "all",
  setLibraryReadiness,
  statuses,
  overview,
  recent,
  filter,
  query = "",
  setQuery,
  catalogSort = "catalog",
  setCatalogSort,
  setFilter,
  onSelect,
  onContinue,
  onTask,
  onBrowseCatalog,
  onConnectGameFiles,
  steamBatch,
  clearFilters,
  loading,
  nativeSourceDrag = { active: false, pathCount: 0 },
  collectionLayout = "covers",
  setCollectionLayout,
  collectionLayoutFailure,
}: {
  collectionLayout?: CollectionLayout;
  setCollectionLayout?: ((layout: CollectionLayout) => void) | undefined;
  collectionLayoutFailure?: "read" | "write" | undefined;
  organization?: Organization | undefined;
  catalogUniverse?: CatalogEntry[] | undefined;
  favorites?: ReturnType<typeof useFavorites> | undefined;
  view: View;
  ports: CatalogEntry[];
  /** Search/view narrowed candidates, before either editable Catalog group. */
  catalogFilterCandidates?: CatalogEntry[] | undefined;
  /** Search and canonical Library membership, before readiness and declared query. */
  libraryFilterCandidates?: CatalogEntry[] | undefined;
  queryContext?: CatalogQueryContext;
  gameFileQuery?: GameFileFilterState | undefined;
  libraryReadiness?: string;
  setLibraryReadiness?: (readiness: string) => void;
  statuses: Map<string, PortStatus>;
  overview: LibraryOverview;
  filter: Filter | CatalogQuery;
  query?: string;
  setQuery?: Dispatch<SetStateAction<string>> | undefined;
  catalogSort?: CatalogSort;
  setCatalogSort?: Dispatch<SetStateAction<CatalogSort>>;
  recent?: RecentPort | undefined;
  setFilter: Dispatch<SetStateAction<Filter | CatalogQuery>>;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
  onContinue?: (portId: string) => void;
  onTask?: ((activityId?: string) => void) | undefined;
  onBrowseCatalog?: (() => void) | undefined;
  onConnectGameFiles?: (() => void) | undefined;
  steamBatch?: { ports: PortDefinition[]; generation: number };
  clearFilters?: (() => void) | undefined;
  loading: boolean;
  nativeSourceDrag?: NativeSourceDragState;
}) {
  const [organizationViews, setOrganizationViews] = useState({ library: "all", catalog: "all" });
  const organizationKey = view === "catalog" ? "catalog" : "library";
  const organizationView = organizationViews[organizationKey];
  const setOrganizationView = (value: string) =>
    setOrganizationViews((current) => ({ ...current, [organizationKey]: value }));
  const browserOwner = useRef({ closed: false });
  const filterButton = useRef<HTMLButtonElement>(null);
  const browserRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const owner = { closed: false };
    browserOwner.current = owner;
    return () => {
      owner.closed = true;
    };
  }, []);
  const restoreAfter = async (button: HTMLElement, action: () => Promise<boolean>) => {
    const owner = browserOwner.current;
    const ownedFocus = document.activeElement === button;
    const accepted = await action();
    if (!accepted || !ownedFocus) return;
    window.requestAnimationFrame(() => {
      if (
        owner.closed ||
        browserOwner.current !== owner ||
        button.isConnected ||
        document.activeElement !== document.body
      )
        return;
      (
        filterButton.current ??
        browserRoot.current?.querySelector<HTMLButtonElement>("[data-focusable]:not([disabled])")
      )?.focus();
    });
  };
  const onFavoriteToggle = (portId: string, button: HTMLElement) => {
    if (favorites) void restoreAfter(button, () => favorites.toggle(portId));
  };
  const { composedLibrary, unresolvedReadiness, candidates, readinessCount, declaredCandidates } =
    resolveLibraryFilters({
      view,
      setLibraryReadiness,
      libraryReadiness,
      libraryFilterCandidates,
      catalogFilterCandidates,
      favorites,
      filter,
      queryContext,
      statuses,
    });
  const favoritesUnavailable = favorites?.only === true && !favorites.ids;
  const queryState =
    typeof filter === "string" ? "matched" : evaluateCatalogQuery([], filter, queryContext).state;
  const resultsUnavailable =
    favoritesUnavailable ||
    queryState === "unavailable" ||
    (composedLibrary && candidates === undefined);
  const unresolvedFilter = queryState === "unresolved";
  const { favoriteCount, visiblePorts: favoriteMatches } = favoritePorts(ports, favorites);
  const visiblePorts = organizedPorts(
    favoriteMatches,
    organization,
    organizationView,
    view === "catalog",
    catalogUniverse ?? ports,
  );
  const resultCount =
    view === "catalog"
      ? `${groupCountLabel(groupCatalog(catalogUniverse ?? declaredCandidates ?? ports, visiblePorts))} · ${visiblePorts.length} matching ports`
      : browserResultCount(view, visiblePorts.length);
  const reset = () => {
    const owner = browserOwner.current;
    const origin = document.activeElement;
    favorites?.setOnly(false);
    setOrganizationView("all");
    clearFilters?.();
    window.requestAnimationFrame(() => {
      if (owner.closed || browserOwner.current !== owner) return;
      if (document.activeElement !== origin && document.activeElement !== document.body) return;
      (document.querySelector<HTMLInputElement>("#port-search") ?? filterButton.current)?.focus();
    });
  };
  const constrained =
    organizationView !== "all" ||
    filterConstrained(filter) ||
    favorites?.only === true ||
    (composedLibrary && libraryReadiness !== "all");
  const firstUseEmpty = firstLibraryVisit({
    view,
    loading,
    recent,
    installed: overview.installed,
    portCount: ports.length,
    constrained,
    query,
  });
  return {
    favorites,
    organization,
    organizationView,
    setOrganizationView,
    catalogUniverse,
    view,
    queryContext,
    gameFileQuery,
    libraryReadiness,
    setLibraryReadiness,
    statuses,
    overview,
    recent: visibleRecentPort(recent, organization, catalogUniverse ?? ports, statuses),
    filter,
    query,
    setQuery,
    catalogSort,
    setCatalogSort,
    setFilter,
    onSelect,
    onContinue,
    onTask,
    onBrowseCatalog,
    onConnectGameFiles,
    steamBatch,
    loading,
    nativeSourceDrag,
    collectionLayout,
    setCollectionLayout,
    collectionLayoutFailure,
    filterButton,
    browserRoot,
    restoreAfter,
    onFavoriteToggle,
    composedLibrary,
    unresolvedReadiness,
    readinessCount,
    declaredCandidates,
    favoritesUnavailable,
    resultsUnavailable,
    unresolvedFilter,
    favoriteCount,
    visiblePorts,
    resultCount,
    reset,
    constrained,
    firstUseEmpty,
  };
}

export function PortBrowser(props: Parameters<typeof usePortBrowser>[0]) {
  return <PortBrowserView {...usePortBrowser(props)} />;
}

function PortBrowserView({
  browserRoot,
  filterButton,
  favorites,
  setCollectionLayout,
  ...model
}: ReturnType<typeof usePortBrowser>) {
  const renderDropAnnouncement = () => renderDropAnnouncementPortBrowserView(model);
  const renderConnectPrompt = () => renderConnectPromptPortBrowserView(model);
  const renderContinue = () => renderContinuePortBrowserView(model, favorites);
  const renderSteamBatch = () => renderSteamBatchPortBrowserView(model);
  const renderFavoritesFailure = () => renderFavoritesFailurePortBrowserView(model, favorites);
  const renderFilters = () => renderFiltersPortBrowserView(model, favorites, filterButton);
  const renderSort = () => renderSortPortBrowserView(model);
  return (
    <div ref={browserRoot} className="@container/library-query min-w-0">
      <p className="sr-only" role="status" aria-label="Search results">
        {model.firstUseEmpty
          ? "Your library is empty."
          : model.resultsUnavailable
            ? "Search results unavailable"
            : model.resultCount}
      </p>
      {renderDropAnnouncement()}
      {renderConnectPrompt()}
      {<BrowserLastPlayed {...{ favorites, model, renderContinue }} />}

      <div
        className={cn(
          "browse-navigation flex min-w-0 flex-wrap items-start gap-2",
          model.view === "library" && "mb-3",
        )}
      >
        <BrowserQuickViews model={model} favorites={favorites} filterButton={filterButton} />
        {model.organization && (
          <OrganizationControls
            organization={model.organization}
            selected={model.organizationView}
            onSelect={model.setOrganizationView}
            discover={model.view === "catalog"}
          >
            {renderSteamBatch()}
          </OrganizationControls>
        )}
      </div>
      {renderFavoritesFailure()}
      {model.unresolvedReadiness && (
        <p role="alert" className="mb-3 text-sm text-pc-muted-foreground">
          Restored readiness “{model.libraryReadiness}” is not supported. Choose All to reset
          readiness; declared filters remain active.
        </p>
      )}
      {model.favoritesUnavailable && (
        <p role="status">Favorites are unavailable; retained constraints need confirmed choices.</p>
      )}
      {model.unresolvedFilter && (
        <p role="alert" className="mb-3 text-sm text-pc-muted-foreground">
          These filters are not supported. Reset filters to choose a supported query.
        </p>
      )}
      {
        <BrowserCollectionTools
          {...{
            setCollectionLayout,
            model,
            renderSteamBatch,
            renderFilters,
            renderSort,
          }}
        />
      }
      {<SuggestedOrderHint {...{ model }} />}
      <BrowserFilterRecovery model={model} />
      <BrowserResults
        layout={model.collectionLayout}
        query={model.query}
        view={model.view}
        ports={model.visiblePorts}
        allCatalogPorts={model.catalogUniverse ?? model.declaredCandidates ?? model.visiblePorts}
        organization={model.organization}
        restoreAfter={model.restoreAfter}
        favorites={favorites}
        onFavoriteToggle={model.onFavoriteToggle}
        installedCount={model.overview.installed}
        constrained={model.constrained || model.query.trim().length > 0}
        statuses={model.statuses}
        onSelect={model.onSelect}
        onTask={model.onTask}
        onLaunch={model.onContinue}
        onBrowseCatalog={model.onBrowseCatalog}
        onConnectGameFiles={model.onConnectGameFiles}
        clearFilters={model.reset}
        loading={model.loading || model.resultsUnavailable}
        nativeSourceDrag={model.nativeSourceDrag}
      />
    </div>
  );
}

function BrowserFilterRecovery({
  model,
}: {
  model: Omit<
    ReturnType<typeof usePortBrowser>,
    "browserRoot" | "filterButton" | "favorites" | "setCollectionLayout"
  >;
}) {
  return (
    <>
      {model.view === "library" &&
        !model.firstUseEmpty &&
        (model.constrained || model.query.trim()) && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2 text-sm">
            <p className="m-0" role="status">
              {model.resultsUnavailable
                ? "Results unavailable"
                : `${model.visiblePorts.length} of ${model.overview.installed} library ${model.overview.installed === 1 ? "entry" : "entries"}`}
            </p>
            {(model.resultsUnavailable || model.visiblePorts.length > 0) && (
              <Button variant="ghost" onClick={model.reset}>
                Reset view
              </Button>
            )}
          </div>
        )}
      {model.view === "catalog" &&
        !model.visiblePorts.length &&
        typeof model.filter !== "string" &&
        Boolean(model.filter.platforms?.length) && (
          <Button
            data-focusable
            variant="outline"
            className="mb-4"
            onClick={() =>
              model.setFilter((current) =>
                typeof current === "string" ? current : { ...current, platforms: [] },
              )
            }
          >
            Search all platforms
          </Button>
        )}
    </>
  );
}

function filterConstrained(filter: Filter | CatalogQuery) {
  if (typeof filter === "string") return filter !== "all";
  if (evaluateCatalogQuery([], filter).state === "unresolved") return true;
  return Object.entries(filter).some(
    ([key, values]) => key !== "version" && Array.isArray(values) && values.length > 0,
  );
}

function SteamBatchLibraryAction({
  ports,
  generation,
}: {
  ports: PortDefinition[];
  generation: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <details className="collection-tools text-xs text-pc-muted-foreground" data-focus-group>
        <summary data-focusable className="cursor-pointer py-2">
          Collection commands
        </summary>
        <p>
          Choose from {ports.length} installed entries in this library, including any hidden by
          filters. This does not install or launch a game.
        </p>
        <Button data-focusable variant="outline" onClick={() => setOpen(true)}>
          <Icon glyph={Gamepad2} />
          Choose games for Steam…
        </Button>
      </details>
      {open && (
        <SteamBatchEntryDialog ports={ports} generation={generation} close={() => setOpen(false)} />
      )}
    </>
  );
}

function BrowserResults({
  organization,
  query,
  restoreAfter,
  layout,
  favorites,
  onFavoriteToggle,
  view,
  ports,
  installedCount,
  allCatalogPorts,
  constrained,
  statuses,
  onSelect,
  onLaunch,
  onTask,
  onBrowseCatalog,
  onConnectGameFiles,
  clearFilters,
  loading,
  nativeSourceDrag,
}: {
  organization?: Organization | undefined;
  restoreAfter: (button: HTMLElement, action: () => Promise<boolean>) => Promise<void>;
  layout: CollectionLayout;
  query: string;
  favorites?: ReturnType<typeof useFavorites> | undefined;
  onFavoriteToggle: (portId: string, button: HTMLElement) => void;
  view: View;
  ports: CatalogEntry[];
  installedCount: number;
  allCatalogPorts: readonly CatalogEntry[];
  constrained: boolean;
  statuses: Map<string, PortStatus>;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
  onLaunch?: ((portId: string) => void) | undefined;
  onTask?: ((activityId?: string) => void) | undefined;
  onBrowseCatalog?: (() => void) | undefined;
  onConnectGameFiles?: (() => void) | undefined;
  clearFilters?: (() => void) | undefined;
  loading: boolean;
  nativeSourceDrag: NativeSourceDragState;
}) {
  if (loading) return <LoadingState />;
  if (ports.length === 0)
    return (
      <BrowserEmptyState
        view={view}
        query={query}
        installedCount={installedCount}
        constrained={constrained}
        clearFilters={clearFilters}
        onBrowseCatalog={onBrowseCatalog}
        onConnectGameFiles={onConnectGameFiles}
      />
    );
  if (view === "catalog")
    return (
      <GroupedDiscover
        onTask={onTask}
        layout={layout}
        all={allCatalogPorts}
        matching={ports}
        statuses={statuses}
        onSelect={onSelect}
        organization={organization}
        favorites={favorites}
        onFavoriteToggle={onFavoriteToggle}
        nativeSourceDrag={nativeSourceDrag}
      />
    );
  return (
    <section
      className={
        view === "library"
          ? `port-grid collection-${layout} @container/collection grid w-full ${layout === "rows" ? "gap-0" : "gap-4"}`
          : "port-grid collection-covers @container/collection grid w-full"
      }
      aria-label={view === "library" ? "Library entries" : "Find games entries"}
      data-focus-group
    >
      {ports.map((port) => (
        <PortCard
          layout={layout}
          favorites={favorites}
          onFavoriteToggle={onFavoriteToggle}
          organization={organization}
          restoreAfter={restoreAfter}
          key={port.id}
          port={port}
          status={statuses.get(port.id)}
          readiness={portReadiness(statuses.get(port.id))}
          onSelect={onSelect}
          onTask={onTask}
          onLaunch={onLaunch}
          nativeSourceDrag={nativeSourceDrag}
          view="library"
        />
      ))}
    </section>
  );
}

function LoadingState() {
  return (
    <section
      className="loading-state flex min-h-[18.75rem] flex-col items-center justify-center gap-4 rounded-pc-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] p-4 text-start text-pc-muted-foreground min-[48rem]:flex-row min-[48rem]:p-10"
      aria-live="polite"
    >
      <div className="grid w-48 max-w-full shrink-0 justify-items-center gap-1">
        <BrandWordmark className="block h-18 w-48 max-w-[100%] bg-[var(--color-brand-stage)] object-contain" />
        <span className="loading-mark relative grid size-12 place-items-center rounded-pc-lg border border-pc-border bg-pc-surface text-[var(--color-interactive-text)] shadow-[var(--shadow-control)]">
          <BrandMotif className="absolute -bottom-1.5" />
          <Icon
            glyph={LoaderCircle}
            className="animate-spin motion-reduce:animate-none"
            size="lg"
          />
        </span>
      </div>
      <div className="max-w-full min-w-0 [overflow-wrap:anywhere]">
        <strong className="block text-pc-foreground">Loading your port library</strong>
        <p className="m-0 max-w-[32rem] leading-[var(--leading-relaxed)]">
          Loading the catalog, added game files, and ports in your library.
        </p>
      </div>
    </section>
  );
}

function BrowserEmptyState({
  view,
  query,
  installedCount,
  constrained,
  clearFilters,
  onBrowseCatalog,
  onConnectGameFiles,
}: {
  view: View;
  query: string;
  installedCount: number;
  constrained: boolean;
  clearFilters?: (() => void) | undefined;
  onBrowseCatalog?: (() => void) | undefined;
  onConnectGameFiles?: (() => void) | undefined;
}) {
  if (view === "library" && installedCount === 0 && !constrained && !query.trim())
    return (
      <EmptyState
        visual={
          <span className="empty-mascot-stage grid size-16 place-items-center overflow-hidden rounded-pc-lg border border-[var(--color-border-strong)] bg-[var(--color-brand-stage)]">
            <BrandMascot className="size-full" decorative />
          </span>
        }
        title="Your library is empty"
        description="Add games using your original files, search a chosen folder, or find a port. You can also copy a supported installation without changing its original folder."
        action={
          <>
            <Button
              data-focusable
              data-add-games-trigger
              variant="primary"
              size="lg"
              onClick={onBrowseCatalog}
            >
              <Icon glyph={Boxes} />
              Add games
            </Button>
            {onConnectGameFiles && (
              <Button data-focusable variant="outline" size="lg" onClick={onConnectGameFiles}>
                Connect game-file folder
              </Button>
            )}
          </>
        }
      />
    );
  return (
    <EmptyState
      icon={Settings2}
      title="No matching games"
      description={
        query
          ? `No ${view === "library" ? "library entries" : "games"} match “${query}” with the current view. Reset search, filters, quick views and collection selection to browse again.`
          : "No games match the current filters and view. Reset filters, quick views and collection selection to browse again."
      }
      action={
        <Button data-focusable variant="outline" size="lg" onClick={clearFilters}>
          <Icon glyph={Settings2} />
          Reset view
        </Button>
      }
    />
  );
}

function continueLaunchable(port: CatalogEntry, status: PortStatus, blocked: boolean) {
  return (
    (!port.listing || listingActionAssessment(port.listingStatus, "launch").allowed) &&
    !port.pendingSetup &&
    status.readiness?.launchable === true &&
    status.readiness.blockers.length === 0 &&
    !blocked
  );
}

function ContinueCard({
  recent,
  launch,
  details,
}: {
  recent: RecentPort;
  launch: (portId: string) => void;
  details: (portId: string, originKey?: string) => void;
}) {
  const { port, status } = recent;
  const { element, visible } = useArtworkVisibility();
  const { display: artwork, catalogMedia } = useHeaderArtwork(port, visible);
  const action = presentPortAction(useOperationPresentation(), port.id, status, "launch");
  const launchable = continueLaunchable(port, status, action.readiness.blocked);
  const trial = hasUnconfirmedLaunchInput(status, port);
  const previouslyPlayed = status.successful_launches > 0;
  return (
    <section
      ref={element}
      className="continue-card mb-4 grid min-w-0 items-center rounded-pc-lg border border-pc-border bg-pc-surface"
      data-focus-group
      data-successful-launches={status.successful_launches}
      aria-label={`${previouslyPlayed ? "Continue" : "Play"} ${gameIdentityLabel(port)}`}
    >
      {artwork.image && (
        <div className="continue-art" aria-hidden="true">
          <img src={artwork.image} alt="" onError={artwork.onImageError} />
        </div>
      )}
      <div className="continue-identity min-w-0 wrap-anywhere">
        <p className="mb-1 text-xs text-pc-muted-foreground">
          {previouslyPlayed ? "Continue playing" : "Play"}
        </p>
        <h2 className="m-0 text-base">{gameTitle(port)}</h2>
        {gameProjectLabel(port) && (
          <p className="m-0 mt-1 text-xs text-pc-muted-foreground">{gameProjectLabel(port)}</p>
        )}
        {trial && (
          <p className="m-0 mt-1 text-xs text-pc-warning-foreground">Compatibility unconfirmed</p>
        )}
        {catalogMedia && <MediaCredit media={catalogMedia} />}
      </div>
      <div className="continue-actions min-w-0">
        <Button
          data-focusable
          variant="outline"
          size="sm"
          data-detail-origin={`library:continue-details:${port.id}`}
          onClick={() => details(port.id, `library:continue-details:${port.id}`)}
        >
          View details
        </Button>
        <Button
          data-focusable
          variant="primary"
          size="sm"
          data-detail-origin={launchable ? undefined : `library:continue-review:${port.id}`}
          disabled={launchable && Boolean(action.busy)}
          focusableWhenDisabled={launchable && Boolean(action.busy)}
          aria-busy={launchable && Boolean(action.busy)}
          title={action.assessment.reason}
          onClick={() =>
            launchable ? launch(port.id) : details(port.id, `library:continue-review:${port.id}`)
          }
        >
          <Icon glyph={Gamepad2} />
          {launchable
            ? status.readiness?.pending_setup
              ? "Start setup"
              : trial
                ? "Try launch"
                : previouslyPlayed
                  ? "Play again"
                  : "Play"
            : "Review launch"}
        </Button>
      </div>
    </section>
  );
}

type CardState = {
  label: string;
  action: ReturnType<typeof readinessPresentation>["action"];
  tone: ReturnType<typeof readinessPresentation>["tone"];
};

type PortCardProps = {
  organization?: Organization | undefined;
  restoreAfter: (button: HTMLElement, action: () => Promise<boolean>) => Promise<void>;
  layout: CollectionLayout;
  onFavoriteToggle: (portId: string, button: HTMLElement) => void;
  favorites?: ReturnType<typeof useFavorites> | undefined;
  port: CatalogEntry;
  status?: PortStatus | undefined;
  readiness: PortReadiness;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
  onLaunch?: ((portId: string) => void) | undefined;
  onTask?: ((activityId?: string) => void) | undefined;
  nativeSourceDrag: NativeSourceDragState;
  view: "library";
};

function PortCard({
  organization,
  restoreAfter,
  layout,
  favorites,
  onFavoriteToggle,
  port,
  status,
  readiness,
  onSelect,
  onLaunch,
  onTask,
  nativeSourceDrag,
  view,
}: PortCardProps) {
  const setupDescriptionId = useId();
  const resolveCardPresentation = () => {
    const { input, state } = browsePortPresentation(port, status, view, readiness);
    const release = currentUpdateSnapshot(status)?.check.release;
    const hiddenNotice = updateNoticeHidden(
      organization?.snapshot?.update_notices[port.id],
      release?.asset.sha256
        ? { version: release.version, artifact_sha256: release.asset.sha256 }
        : undefined,
    );
    const updateAvailable =
      !hiddenNotice && observedUpdateCandidate(port.id, status)?.availableAtLastCheck === true;
    return { input, state, updateAvailable };
  };
  const { input, state, updateAvailable } = resolveCardPresentation();
  const dropEligible =
    nativeSourceDrag.active &&
    Boolean(port.source_profile) &&
    !status?.external_runtime?.user_selected &&
    !port.pendingSetup;
  const dropTarget = dropEligible && nativeSourceDrag.targetPortId === port.id;
  const detailOrigin = `${view}:card:${port.id}`;
  const favoriteMenu = (
    <>
      {" "}
      {organization && (
        <OrganizationMenuItems
          port={port}
          organization={organization}
          after={(action) => {
            const target = document.activeElement;
            if (target instanceof HTMLElement) void restoreAfter(target, action);
          }}
        />
      )}{" "}
      {favorites && (
        <Menu.Item
          disabled={!favorites.ids || favorites.busy}
          className={cn(
            controlFocus,
            "flex cursor-default items-center gap-2 rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection data-highlighted:text-pc-selection-foreground",
          )}
          onClick={(event) => onFavoriteToggle(port.id, event.currentTarget)}
        >
          <Icon glyph={Star} size="sm" />
          {favorites.ids?.has(port.id) ? "Remove from favorites" : "Add to favorites"}
        </Menu.Item>
      )}
    </>
  );
  return (
    <LibraryEntry
      {...{
        port,
        status,
        state,
        layout,
        detailOrigin,
        onSelect,
        onLaunch,
        onTask,
        input,
        setupDescriptionId,
        updateAvailable,
        dropEligible,
        dropTarget,
        favoriteMenu,
      }}
    />
  );
}

function LibraryEntry({
  port,
  status,
  state,
  layout,
  detailOrigin,
  onSelect,
  onLaunch,
  onTask,
  input,
  setupDescriptionId,
  updateAvailable,
  dropEligible,
  dropTarget,
  favoriteMenu,
}: Pick<PortCardProps, "port" | "status" | "layout" | "onSelect" | "onLaunch" | "onTask"> & {
  state: CardState;
  detailOrigin: string;
  input: ReturnType<typeof installedCardInputPresentation>;
  setupDescriptionId: string;
  updateAvailable: boolean;
  dropEligible: boolean;
  dropTarget: boolean;
  favoriteMenu: ReactNode;
}) {
  const { element: artworkElement, visible } = useArtworkVisibility();
  const { display: artwork } = useArtwork(port.id, "cover", visible);
  const artworkNotice = artworkDisplayNotice(artwork);
  return (
    <article
      className={cn(
        `port-card port-card-library collection-entry collection-${layout === "rows" ? "row" : "cover"} relative min-w-0`,
        dropTarget && "outline-3 outline-offset-2 outline-pc-ring outline-solid",
      )}
      aria-label={`${gameIdentityLabel(port)}. ${state.label}.`}
      aria-describedby={input ? setupDescriptionId : undefined}
      data-source-drop-port-id={dropEligible ? port.id : undefined}
      data-source-drop-profile-id={dropEligible ? port.source_profile : undefined}
    >
      <button
        data-focusable
        className={cn(
          controlFocus,
          "collection-identity cursor-pointer text-start hover:text-pc-interactive-foreground",
        )}
        aria-label={`View details for ${gameTitle(port)} ${gameProjectLabel(port) ?? port.name}`}
        aria-describedby={input ? setupDescriptionId : undefined}
        data-detail-game-id={port.id}
        data-detail-origin={detailOrigin}
        onClick={() => onSelect(port.id, detailOrigin)}
      >
        <ArtworkFrame
          element={artworkElement}
          display={artwork}
          identityArtwork
          className="card-art collection-art"
        />
        <span
          role="heading"
          aria-level={2}
          className="collection-title text-sm leading-snug font-semibold wrap-anywhere"
        >
          {gameTitle(port)}
        </span>{" "}
        <span className="collection-project block text-xs leading-normal wrap-anywhere text-[var(--color-text-secondary)]">
          {gameProjectLabel(port) ?? port.name}
        </span>
      </button>
      <div className="library-entry-chips">
        <IdentityChips
          port={{ ...port, platforms: [], channels: status?.active ? [status.active.channel] : [] }}
        />
      </div>
      <div className="library-entry-footer">
        <LibraryEntryState
          {...{
            port,
            status,
            state,
            detailOrigin,
            onSelect,
            input,
            setupDescriptionId,
            updateAvailable,
            artworkNotice,
          }}
        />
        <PortCardStatus
          port={port}
          status={status}
          favoriteMenu={favoriteMenu}
          detailOrigin={detailOrigin}
          onSelect={onSelect}
          onTask={onTask}
          onLaunch={onLaunch}
          inputDescriptionId={input ? setupDescriptionId : undefined}
        />
      </div>
      {dropEligible && (
        <span
          className="source-drop-target pointer-events-none absolute inset-0 grid place-items-center rounded-pc-md border-2 border-dashed border-pc-interactive bg-pc-interactive/90 p-3 text-center text-sm font-bold text-pc-action-foreground"
          aria-hidden="true"
        >
          {dropTarget ? "Release to check" : "Drop to check for this game"}
        </span>
      )}
    </article>
  );
}

function PortCardStatus({
  favoriteMenu,
  inputDescriptionId,
  port,
  status,
  detailOrigin,
  onSelect,
  onLaunch,
  onTask,
}: Pick<PortCardProps, "port" | "status" | "onSelect" | "onLaunch" | "onTask"> & {
  inputDescriptionId?: string | undefined;
  favoriteMenu?: ReactNode;
  detailOrigin: string;
}) {
  const action = presentPortAction(useOperationPresentation(), port.id, status, "launch");
  const taskPrimary = Boolean(action.busy && action.pending?.context.operation !== "launch");
  const canLaunch = cardCanLaunch(port, status, action, onLaunch);
  const overflowOrigin = `library:card-more:${port.id}`;
  const reviewOrigin = `${detailOrigin}:review`;
  const reviewSetup = Boolean(
    port.pendingSetup || hasPendingSetupAction(status) || installedCardInputPresentation(status),
  );
  const reviewLabel =
    port.pendingSetup?.state === "attention-required"
      ? "Review download"
      : port.pendingSetup
        ? "Continue setup"
        : reviewSetup
          ? "Review setup"
          : "Review game";
  return (
    <div className="collection-actions mt-0 flex min-h-8 flex-wrap items-center justify-end gap-1 pt-0 text-xs">
      <span className="inline-flex flex-wrap items-center justify-end gap-1 text-[var(--color-interactive-text-strong)]">
        {taskPrimary && (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            className="library-card-action"
            data-detail-origin={`${detailOrigin}:task`}
            onClick={() =>
              onTask
                ? onTask(action.pending?.context.activityId)
                : onSelect(port.id, `${detailOrigin}:task`)
            }
          >
            View task
          </Button>
        )}
        {!taskPrimary && !canLaunch && (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            className="library-card-action"
            aria-label={`${reviewLabel}: ${gameIdentityLabel(port)}`}
            aria-describedby={inputDescriptionId}
            data-detail-origin={reviewOrigin}
            onClick={() =>
              reviewSetup
                ? onSelect(port.id, reviewOrigin, "files")
                : onSelect(port.id, reviewOrigin)
            }
          >
            {reviewLabel}
          </Button>
        )}
        {!taskPrimary && canLaunch && (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            className="library-card-action"
            disabled={Boolean(action.busy)}
            focusableWhenDisabled={Boolean(action.busy)}
            aria-busy={Boolean(action.busy)}
            title={action.assessment.reason}
            onClick={() => onLaunch?.(port.id)}
          >
            {status?.readiness?.pending_setup
              ? "Start setup"
              : hasUnconfirmedLaunchInput(status, port)
                ? "Try launch"
                : "Play"}
          </Button>
        )}
        <PortCardActionMenu {...{ favoriteMenu, port, status, onSelect, overflowOrigin }} />
      </span>
    </div>
  );
}

function filterLabel(filter: Filter) {
  if (filter === "all") return "All";
  if (filter === "ready") return "Ready";
  if (filter === "setup") return "Needs attention";
  return releaseChannelPresentation(filter).label;
}

function resolveLibraryFilters({
  view,
  setLibraryReadiness,
  libraryReadiness = "all",
  libraryFilterCandidates,
  catalogFilterCandidates,
  favorites,
  filter,
  queryContext,
  statuses,
}: {
  [
    K in
      | "view"
      | "setLibraryReadiness"
      | "libraryReadiness"
      | "libraryFilterCandidates"
      | "catalogFilterCandidates"
      | "favorites"
      | "filter"
      | "queryContext"
      | "statuses"
  ]: Parameters<typeof usePortBrowser>[0][K];
}) {
  const composedLibrary = view === "library" && Boolean(setLibraryReadiness);
  const unresolvedReadiness =
    composedLibrary && !["all", "ready", "setup"].includes(libraryReadiness);
  const candidates = view === "library" ? libraryFilterCandidates : catalogFilterCandidates;
  const countCandidates =
    candidates === undefined || (favorites?.only && !favorites.ids)
      ? undefined
      : favorites?.only
        ? candidates.filter((port) => favorites.ids?.has(port.id))
        : candidates;
  const declaredMatches =
    countCandidates === undefined
      ? undefined
      : evaluateCatalogQuery(
          countCandidates,
          filter === "all"
            ? { version: 1 }
            : typeof filter === "string"
              ? { version: 1, channels: [filter] }
              : filter,
          queryContext,
        );
  const readinessCount = (readiness: "all" | "ready" | "setup") =>
    declaredMatches?.state === "matched"
      ? filterPorts(declaredMatches.ports, statuses, "library", readiness, "").length
      : "unavailable";
  const declaredCandidates = composedLibrary
    ? countCandidates === undefined || unresolvedReadiness
      ? undefined
      : filterPorts(
          countCandidates,
          statuses,
          "library",
          libraryReadiness as "all" | "ready" | "setup",
          "",
        )
    : countCandidates;
  return { composedLibrary, unresolvedReadiness, candidates, readinessCount, declaredCandidates };
}

function renderDropAnnouncementPortBrowserView(
  model: Omit<
    ReturnType<typeof usePortBrowser>,
    "browserRoot" | "filterButton" | "favorites" | "setCollectionLayout"
  >,
) {
  return (
    <p className="sr-only" aria-live="polite">
      {model.nativeSourceDrag.active
        ? `Game file drop targets are available. ${model.nativeSourceDrag.pathCount === 1 ? "One path" : `${model.nativeSourceDrag.pathCount} paths`} selected.`
        : ""}
    </p>
  );
}

function renderConnectPromptPortBrowserView(
  model: Omit<
    ReturnType<typeof usePortBrowser>,
    "browserRoot" | "filterButton" | "favorites" | "setCollectionLayout"
  >,
) {
  return (
    model.view === "catalog" &&
    !model.loading &&
    model.overview.installed === 0 &&
    model.onConnectGameFiles && (
      <section
        aria-label="Connect your game files"
        className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-pc-border pb-4"
        data-focus-group
      >
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-sm font-semibold">Find ports for games you own</h2>
          <p className="mt-1 mb-0 text-sm text-pc-muted-foreground">
            Browse below, or connect a folder to find matching games. Your originals stay in place.
          </p>
        </div>
        <Button data-focusable variant="outline" onClick={model.onConnectGameFiles}>
          Connect game-file folder
        </Button>
      </section>
    )
  );
}

function renderContinuePortBrowserView(
  model: Omit<
    ReturnType<typeof usePortBrowser>,
    "browserRoot" | "filterButton" | "favorites" | "setCollectionLayout"
  >,
  favorites: ReturnType<typeof usePortBrowser>["favorites"],
) {
  return (
    model.view === "library" &&
    model.recent &&
    model.onContinue &&
    !favorites?.only && (
      <ContinueCard recent={model.recent} launch={model.onContinue} details={model.onSelect} />
    )
  );
}

function renderSteamBatchPortBrowserView(
  model: Omit<
    ReturnType<typeof usePortBrowser>,
    "browserRoot" | "filterButton" | "favorites" | "setCollectionLayout"
  >,
) {
  return (
    model.view === "library" &&
    model.steamBatch &&
    model.steamBatch.ports.length >= 2 && <SteamBatchLibraryAction {...model.steamBatch} />
  );
}

function renderFavoritesFailurePortBrowserView(
  model: Omit<
    ReturnType<typeof usePortBrowser>,
    "browserRoot" | "filterButton" | "favorites" | "setCollectionLayout"
  >,
  favorites: ReturnType<typeof usePortBrowser>["favorites"],
) {
  return (
    favorites?.failure && (
      <Notice intent="danger" className="mb-3" role="alert">
        <div data-slot="notice-body">
          <strong>
            {favorites.failure === "write"
              ? "Favorite choice could not be confirmed"
              : "Favorites could not be refreshed"}
          </strong>
          <p>
            Last confirmed choices have been kept; a write may already have applied. You can keep
            browsing and playing. Retry reading favorites to reconcile them; if the error continues,
            repair the host preferences file.
          </p>
          <Button
            data-focusable
            variant="outline"
            aria-disabled={favorites.busy}
            onClick={(event) => void model.restoreAfter(event.currentTarget, favorites.refresh)}
          >
            Retry favorites
          </Button>
        </div>
      </Notice>
    )
  );
}

function renderFiltersPortBrowserView(
  model: Omit<
    ReturnType<typeof usePortBrowser>,
    "browserRoot" | "filterButton" | "favorites" | "setCollectionLayout"
  >,
  favorites: ReturnType<typeof usePortBrowser>["favorites"],
  filterButton: ReturnType<typeof usePortBrowser>["filterButton"] | undefined,
) {
  return (
    !model.firstUseEmpty && (
      <div
        className="filter-row"
        data-focus-group
        role="group"
        aria-label={model.view === "library" ? "Library filters" : "Release channel filters"}
      >
        {model.composedLibrary && (
          <div className="collection-readiness max-w-full min-w-0">
            <ChoiceSelect
              inline
              label="Readiness"
              value={model.libraryReadiness}
              options={filterOptions(model.view).map((item) => ({
                value: item,
                label: `${filterLabel(item)} (${model.readinessCount(item as "all" | "ready" | "setup")})`,
              }))}
              onChange={(value) => model.setLibraryReadiness?.(value)}
            />
          </div>
        )}
        {favorites && (
          <Button
            data-focusable
            size="sm"
            variant={favorites.only ? "selected" : "ghost"}
            ref={filterButton}
            data-favorites-filter
            aria-pressed={favorites.only}
            disabled={!favorites.ids}
            onClick={() => favorites.setOnly(!favorites.only)}
          >
            <Icon glyph={Star} size="sm" /> Favorites
            {model.favoriteCount === undefined ? " (unavailable)" : ` (${model.favoriteCount})`}
          </Button>
        )}
        {favorites?.only && model.view !== "library" && (
          <Button data-focusable size="sm" variant="ghost" onClick={model.reset}>
            Reset view
          </Button>
        )}
      </div>
    )
  );
}

function BrowserQuickViews({
  model,
  favorites,
  filterButton,
}: {
  model: Parameters<typeof renderFiltersPortBrowserView>[0];
  favorites: ReturnType<typeof usePortBrowser>["favorites"];
  filterButton: ReturnType<typeof usePortBrowser>["filterButton"];
}) {
  if (!model.composedLibrary || model.firstUseEmpty) return null;
  const updateQuery = queryFromFilter(model.filter).updates ?? [];
  const clearUpdates = (current: Filter | CatalogQuery) => {
    const query = queryFromFilter(current);
    return query.version === 1 ? { ...query, updates: [] } : current;
  };
  const all =
    model.libraryReadiness === "all" &&
    !favorites?.only &&
    !updateQuery.length &&
    model.organizationView === "all";
  return (
    <div
      role="group"
      aria-label="Library quick views"
      data-focus-group
      className="flex min-w-0 flex-wrap items-center gap-1"
    >
      <Button
        size="sm"
        data-focusable
        variant={all ? "selected" : "ghost"}
        aria-pressed={all}
        title="Reset quick views and collection selection; keep search and other filters"
        onClick={() => {
          model.setLibraryReadiness?.("all");
          favorites?.setOnly(false);
          model.setOrganizationView("all");
          model.setFilter(clearUpdates);
        }}
      >
        All games
      </Button>
      {favorites && (
        <Button
          size="sm"
          data-focusable
          data-favorites-filter
          ref={filterButton}
          variant={favorites.only ? "selected" : "ghost"}
          aria-pressed={favorites.only}
          disabled={!favorites.ids}
          onClick={() => favorites.setOnly(!favorites.only)}
        >
          <Icon glyph={Star} size="sm" />
          Favorites{" "}
          {model.favoriteCount === undefined ? "(unavailable)" : `(${model.favoriteCount})`}
        </Button>
      )}
      <Button
        size="sm"
        data-focusable
        variant={model.libraryReadiness === "setup" ? "selected" : "ghost"}
        aria-pressed={model.libraryReadiness === "setup"}
        title="Recorded setup, repair or readiness needs"
        onClick={() =>
          model.setLibraryReadiness?.(model.libraryReadiness === "setup" ? "all" : "setup")
        }
      >
        Needs attention
      </Button>
      <Button
        size="sm"
        data-focusable
        variant={updateQuery.length ? "selected" : "ghost"}
        aria-pressed={updateQuery.length > 0}
        disabled={model.unresolvedFilter}
        onClick={() =>
          model.setFilter((current) => {
            const query = queryFromFilter(current);
            return query.version === 1
              ? { ...query, updates: query.updates?.length ? [] : ["available", "staged"] }
              : current;
          })
        }
      >
        Updates
      </Button>
    </div>
  );
}

function renderSortPortBrowserView(
  model: Omit<
    ReturnType<typeof usePortBrowser>,
    "browserRoot" | "filterButton" | "favorites" | "setCollectionLayout"
  >,
) {
  return (
    model.setCatalogSort && (
      <div className="browse-sort w-52 max-w-full min-w-0">
        <ChoiceSelect
          inline
          label="Sort"
          value={model.catalogSort}
          options={
            model.view === "library"
              ? [
                  { value: "catalog", label: "Catalog order" },
                  ...catalogSortOptions.filter(
                    (option) => option.value === "name" || option.value === "name-desc",
                  ),
                  { value: "recent", label: "Recently played" },
                ]
              : catalogSortOptions
          }
          onChange={model.setCatalogSort}
        />
      </div>
    )
  );
}

function BrowserCollectionTools({
  setCollectionLayout,
  model,
  renderSteamBatch,
  renderFilters,
  renderSort,
}: {
  setCollectionLayout: ReturnType<typeof usePortBrowser>["setCollectionLayout"];
  model: Omit<
    ReturnType<typeof usePortBrowser>,
    "browserRoot" | "filterButton" | "favorites" | "setCollectionLayout"
  >;
  renderSteamBatch: () => ReactNode;
  renderFilters: () => ReactNode;
  renderSort: () => ReactNode;
}) {
  if (model.firstUseEmpty) return null;
  const before = (
    <>
      {model.setQuery && (
        <PortSearch
          query={model.query}
          setQuery={model.setQuery}
          library={model.view === "library"}
        />
      )}
      {!model.composedLibrary && renderFilters()}
    </>
  );
  const after = (
    <>
      {renderSort()}
      {setCollectionLayout && (
        <div role="group" aria-label="Collection view" className="ms-auto flex flex-wrap gap-1">
          <span className="self-center text-xs text-pc-muted-foreground">View</span>
          {(["covers", "rows"] as const).map((layout) => (
            <Button
              key={layout}
              variant={model.collectionLayout === layout ? "selected" : "ghost"}
              size="sm"
              aria-pressed={model.collectionLayout === layout}
              aria-label={layout === "rows" ? "Compact rows" : undefined}
              data-focusable
              onClick={() => setCollectionLayout(layout)}
            >
              {layout === "covers" ? (
                "Covers"
              ) : (
                <>
                  <span className="max-[42rem]:hidden">Compact rows</span>
                  <span className="hidden max-[42rem]:inline">Rows</span>
                </>
              )}
            </Button>
          ))}
        </div>
      )}
      {!model.organization && renderSteamBatch()}
    </>
  );
  const summary = (
    <>
      <span>{model.resultsUnavailable ? "Ports unavailable" : model.resultCount}</span>
      {model.organizationView !== "all" && (
        <span>
          Collection:{" "}
          {model.organizationView.startsWith("collection:")
            ? (model.organization?.snapshot?.collections[model.organizationView.slice(11)]?.name ??
              "Unavailable collection")
            : model.organizationView}
        </span>
      )}
      {model.libraryReadiness !== "all" && model.view === "library" && (
        <span>Readiness: {filterLabel(model.libraryReadiness as Filter)}</span>
      )}
      {model.collectionLayoutFailure && (
        <span role="status">
          {model.collectionLayoutFailure === "read"
            ? "The saved collection view could not be read. Covers are shown."
            : "This collection view is available for this session; it could not be saved."}
        </span>
      )}
    </>
  );
  return (
    <div className="library-query-tools mb-4">
      {model.view === "catalog" || model.composedLibrary ? (
        <CatalogFilters
          before={before}
          after={after}
          advanced={
            model.composedLibrary
              ? renderFiltersPortBrowserView(model, undefined, undefined)
              : undefined
          }
          summary={summary}
          gameFileQuery={model.gameFileQuery}
          view={model.view === "library" ? "library" : "catalog"}
          candidates={model.declaredCandidates}
          context={model.queryContext}
          filter={model.filter}
          setFilter={model.setFilter}
        />
      ) : (
        <>
          <div className="browse-toolbar flex flex-wrap items-center gap-2">
            {before}
            {after}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-pc-muted-foreground">
            {summary}
          </div>
        </>
      )}
    </div>
  );
}

function LibraryEntryState({
  port,
  status,
  state,
  detailOrigin,
  onSelect,
  input,
  setupDescriptionId,
  updateAvailable,
  artworkNotice,
}: Pick<
  Parameters<typeof LibraryEntry>[0] & { artworkNotice: ReturnType<typeof artworkDisplayNotice> },
  | "port"
  | "status"
  | "state"
  | "detailOrigin"
  | "onSelect"
  | "input"
  | "setupDescriptionId"
  | "updateAvailable"
  | "artworkNotice"
>) {
  const summary = browseStatusSummary(state, status, updateAvailable);
  return (
    <div className="collection-state flex min-w-0 flex-col items-start gap-1 text-xs leading-normal wrap-anywhere">
      {artworkNotice && <p className="m-0 text-pc-muted-foreground">{artworkNotice}</p>}
      {summary.showReadiness && (
        <span
          className={cn(
            `readiness ${state.tone} inline-flex items-start gap-1.5 font-medium`,
            "[&.ready]:text-pc-success-foreground [&.setup]:text-pc-warning-foreground [&.staged]:text-pc-interactive-foreground",
          )}
        >
          <Icon glyph={state.tone === "ready" ? CheckCircle2 : Wrench} size="sm" />
          {state.label}
        </span>
      )}
      {concurrentReadinessReasons(status).map((reason) => (
        <p key={reason} className="m-0 text-pc-warning-foreground">
          {reason}
        </p>
      ))}
      <LibraryUpdateReview
        port={port}
        status={status}
        detailOrigin={detailOrigin}
        onSelect={onSelect}
        updateAvailable={updateAvailable}
      />
      <LibraryUpdateFacts status={status} updateAvailable={updateAvailable} />
      {port.upstream_status === "retired" && (
        <p className="m-0 mt-1 text-pc-warning-foreground">Retired upstream</p>
      )}
      {input && (
        <div id={setupDescriptionId} className="sr-only">
          {input.reasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function LibraryUpdateFacts({
  status,
  updateAvailable,
}: Pick<Parameters<typeof LibraryEntryState>[0], "status" | "updateAvailable">) {
  return (
    <>
      {(status?.acquisition ||
        (status?.staged && updateAvailable) ||
        (status?.active && status.channel !== status.active.channel)) && (
        <details className="card-secondary-facts">
          <summary data-focusable>Update details</summary>
          {status?.staged && updateAvailable && (
            <p className="m-0 mt-1 text-pc-interactive-foreground">
              Another update available at last check
            </p>
          )}
          {status?.active && status.channel !== status.active.channel && (
            <p className="m-0 mt-1 text-pc-muted-foreground">
              Selected update channel: {releaseChannelPresentation(status.channel).label}
            </p>
          )}
          {status?.acquisition && <p>{gameUpdateAcquisitionLabel(status.acquisition.phase)}</p>}
        </details>
      )}
    </>
  );
}

function LibraryUpdateReview({
  port,
  status,
  detailOrigin,
  onSelect,
  updateAvailable,
}: Pick<
  Parameters<typeof LibraryEntryState>[0],
  "port" | "status" | "detailOrigin" | "onSelect" | "updateAvailable"
>) {
  return (
    <>
      {(status?.staged || status?.acquisition || updateAvailable) && (
        <Button
          variant="link"
          size="sm"
          className="h-auto min-h-6 p-0 text-start text-xs whitespace-normal"
          data-detail-origin={`${detailOrigin}:update`}
          onClick={() => onSelect(port.id, `${detailOrigin}:update`, "updates")}
        >
          {status?.acquisition
            ? gameUpdateAcquisitionLabel(status.acquisition.phase)
            : status?.staged
              ? "Update prepared"
              : "Update available at last check"}
        </Button>
      )}
    </>
  );
}

function PortCardActionMenu({
  favoriteMenu,
  port,
  status,
  onSelect,
  overflowOrigin,
}: Pick<
  Parameters<typeof PortCardStatus>[0] & { overflowOrigin: string },
  "favoriteMenu" | "port" | "status" | "onSelect" | "overflowOrigin"
>) {
  return (
    <Menu.Root>
      <Tooltip label="More actions">
        <Menu.Trigger
          render={
            <Button
              data-focusable
              data-detail-origin={overflowOrigin}
              variant="ghost"
              size="icon-sm"
              aria-label={`More actions for ${gameIdentityLabel(port)}`}
            >
              <Icon glyph={MoreHorizontal} size="sm" />
            </Button>
          }
        />
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-(--layer-floating)">
          <Menu.Popup
            data-portcove-focus-scope
            aria-label={`More actions for ${gameIdentityLabel(port)}`}
            className={cn(
              floatingMotion,
              "max-h-(--available-height) min-w-48 origin-(--transform-origin) overflow-y-auto rounded-pc-md border border-pc-border bg-pc-surface p-1 text-pc-foreground shadow-(--shadow-floating)",
            )}
          >
            {favoriteMenu}
            <Menu.Item
              className={cn(
                controlFocus,
                "cursor-default rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection data-highlighted:text-pc-selection-foreground",
              )}
              onClick={() =>
                onSelect(
                  port.id,
                  overflowOrigin,
                  port.release && !status?.external_runtime?.user_selected ? "updates" : undefined,
                )
              }
            >
              {port.release && !status?.external_runtime?.user_selected
                ? "Updates and activity"
                : "Launch details"}
            </Menu.Item>
            {port.release && !status?.external_runtime?.user_selected && (
              <Menu.Item
                className={cn(
                  controlFocus,
                  "cursor-default rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection data-highlighted:text-pc-selection-foreground",
                )}
                onClick={() => onSelect(port.id, overflowOrigin, "saves")}
              >
                Saves & backups
              </Menu.Item>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function cardCanLaunch(
  port: CatalogEntry,
  status: PortStatus | undefined,
  action: ReturnType<typeof presentPortAction>,
  onLaunch: PortCardProps["onLaunch"],
) {
  return Boolean(
    (!port.listing || listingActionAssessment(port.listingStatus, "launch").allowed) &&
    !port.pendingSetup &&
    status?.readiness?.launchable === true &&
    status.readiness.blockers.length === 0 &&
    !action.readiness.blocked &&
    onLaunch,
  );
}

function favoritePorts(
  ports: CatalogEntry[],
  favorites: Parameters<typeof usePortBrowser>[0]["favorites"],
) {
  const favoriteCount = favorites?.ids
    ? ports.filter((port) => favorites.ids?.has(port.id)).length
    : undefined;
  const visiblePorts = favorites?.only
    ? ports.filter((port) => favorites.ids?.has(port.id))
    : ports;
  return { favoriteCount, visiblePorts };
}

function BrowserLastPlayed({
  favorites,
  model,
  renderContinue,
}: Pick<
  {
    model: Omit<
      ReturnType<typeof usePortBrowser>,
      "browserRoot" | "filterButton" | "favorites" | "setCollectionLayout"
    >;
    favorites: ReturnType<typeof usePortBrowser>["favorites"];
    renderContinue: () => ReactNode;
  },
  "favorites" | "model" | "renderContinue"
>) {
  return (
    model.view === "library" &&
    model.recent &&
    model.onContinue &&
    !favorites?.only && <>{renderContinue()}</>
  );
}

function browserResultCount(view: View, count: number) {
  return view === "library"
    ? `${count} library ${count === 1 ? "entry" : "entries"}`
    : `${count} ${count === 1 ? "port" : "ports"}`;
}

function SuggestedOrderHint({
  model,
}: Pick<
  {
    model: Omit<
      ReturnType<typeof usePortBrowser>,
      "browserRoot" | "filterButton" | "favorites" | "setCollectionLayout"
    >;
  },
  "model"
>) {
  return (
    model.view === "catalog" &&
    model.catalogSort === "catalog" &&
    model.queryContext?.devicePlatform && (
      <p className="mb-4 text-xs text-pc-muted-foreground">
        Your library and setup options for this device appear first. All ports remain searchable.
      </p>
    )
  );
}
