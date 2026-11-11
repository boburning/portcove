import { ExternalLaunchWarnings } from "./AuthoredSetupWarnings";
import { GameHero } from "./GameHero";
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
import { GroupedLibrary } from "../features/browsing/GroupedLibrary";
import { groupCatalog, groupCountLabel } from "../features/browsing/original-game";
import { PortSearch } from "./PortSearch";
import { controlFocus, floatingMotion } from "./ui/control-style";
import { gameTitle, gameProjectLabel, gameIdentityLabel } from "../port-identity";
import { cn } from "cn";
import { Notice } from "./ui/patterns";
import type { useFavorites } from "../features/favorites/use-favorites";
import {
  memo,
  useCallback,
  useState,
  useRef,
  useEffect,
  useId,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";
import { useLatestCallback } from "../shared/use-latest-callback";
import type { CollectionLayout } from "../features/browsing/use-collection-layout";
import {
  ArrowRight,
  Heart,
  LayoutGrid,
  List,
  Play,
  Save,
  Boxes,
  Compass,
  ArrowDownCircle,
  CheckCircle2,
  Gamepad2,
  History,
  LoaderCircle,
  MoreHorizontal,
  Settings2,
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
import { useArtwork, useArtworkVisibility } from "../artwork";
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
import {
  activeLibraryQuickView,
  libraryQuickViewCounts,
  hasCustomUpdateFilter,
  readinessForQuickView,
  withoutUpdatesQuickView,
  withUpdatesQuickView,
  type LibraryQuickView,
} from "../features/browsing/library-quick-views";
import type { GameFileFilterState } from "../features/browsing/use-game-file-filter-context";

const catalogSortOptions: readonly { value: CatalogSort; label: string }[] = [
  { value: "catalog", label: "Catalog order" },
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

function browserResultAvailability(
  favorites: ReturnType<typeof useFavorites> | undefined,
  loading: boolean,
  filter: Filter | CatalogQuery,
  queryContext: CatalogQueryContext | undefined,
  readinessUnavailable: boolean,
) {
  const favoritesUnavailable = favorites?.only === true && !favorites.ids;
  const loadingResults = loading || Boolean(favoritesUnavailable && favorites?.busy);
  const showingRetainedFavorites = Boolean(favorites?.only && favorites.ids && favorites.failure);
  const queryState =
    typeof filter === "string" ? "matched" : evaluateCatalogQuery([], filter, queryContext).state;
  const resultsUnavailable =
    favoritesUnavailable ||
    queryState === "unavailable" ||
    queryState === "unresolved" ||
    readinessUnavailable;
  const unresolvedFilter = queryState === "unresolved";
  return {
    favoritesUnavailable,
    loadingResults,
    showingRetainedFavorites,
    resultsUnavailable,
    unresolvedFilter,
  };
}

function browserResultCountLabel({
  view,
  visiblePorts,
  ports,
  catalogUniverse,
  declaredCandidates,
}: {
  view: View;
  visiblePorts: CatalogEntry[];
  ports: CatalogEntry[];
  catalogUniverse: CatalogEntry[] | undefined;
  declaredCandidates: CatalogEntry[] | undefined;
}) {
  if (view === "catalog") {
    const groups = groupCatalog(catalogUniverse ?? declaredCandidates ?? ports, visiblePorts);
    return `${groupCountLabel(groups)} · ${visiblePorts.length} matching ports`;
  }
  if (view === "library") {
    const groups = groupCatalog(catalogUniverse ?? ports, visiblePorts);
    if (groups.some((group) => group.ports.length > 1))
      return `${groupCountLabel(groups)} · ${visiblePorts.length} matching ports`;
  }
  return browserResultCount(view, visiblePorts.length);
}

function usePortBrowser({
  organization,
  organizationSelection,
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
  onDiscover,
  onConnectGameFiles,
  steamBatch,
  clearFilters,
  loading,
  nativeSourceDrag = idleNativeSourceDrag,
  collectionLayout = "covers",
  setCollectionLayout,
  collectionLayoutFailure,
}: {
  collectionLayout?: CollectionLayout;
  setCollectionLayout?: ((layout: CollectionLayout) => void) | undefined;
  collectionLayoutFailure?: "read" | "write" | undefined;
  organization?: Organization | undefined;
  organizationSelection?: { value: string; onChange: (value: string) => void } | undefined;
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
  onDiscover?: (() => void) | undefined;
  onConnectGameFiles?: (() => void) | undefined;
  steamBatch?: { ports: PortDefinition[]; generation: number };
  clearFilters?: (() => void) | undefined;
  loading: boolean;
  nativeSourceDrag?: NativeSourceDragState;
}) {
  const [organizationViews, setOrganizationViews] = useState({ library: "all", catalog: "all" });
  const organizationKey = view === "catalog" ? "catalog" : "library";
  const organizationView = organizationSelection?.value ?? organizationViews[organizationKey];
  const setOrganizationView = (value: string) => {
    if (organizationSelection) organizationSelection.onChange(value);
    else setOrganizationViews((current) => ({ ...current, [organizationKey]: value }));
  };
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
  // Card callbacks keep their identity across renders so memoized cards can skip
  // unrelated workspace updates; each call still uses the latest owner handler.
  const stableSelect = useLatestCallback(onSelect);
  const stableContinue = useLatestCallback(onContinue);
  const stableTask = useLatestCallback(onTask);
  const restoreAfter = useCallback(async (button: HTMLElement, action: () => Promise<boolean>) => {
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
  }, []);
  const onFavoriteToggle = useCallback(
    (portId: string, button: HTMLElement) => {
      if (favorites) void restoreAfter(button, () => favorites.toggle(portId));
    },
    [favorites, restoreAfter],
  );
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
  const {
    favoritesUnavailable,
    loadingResults,
    showingRetainedFavorites,
    resultsUnavailable,
    unresolvedFilter,
  } = browserResultAvailability(
    favorites,
    loading,
    filter,
    queryContext,
    composedLibrary && candidates === undefined,
  );
  const { favoriteCount, visiblePorts: favoriteMatches } = favoritePorts(ports, favorites);
  const visiblePorts = organizedPorts(
    favoriteMatches,
    organization,
    organizationView,
    view === "catalog",
    catalogUniverse ?? ports,
  );
  const activeQuickView = activeLibraryQuickView({
    favoritesOnly: favorites?.only === true,
    readiness: libraryReadiness,
    filter,
  });
  const favoriteIds = favorites?.ids;
  const quickViewCounts = libraryQuickViewCounts({
    // An unread collection snapshot makes a selected collection's counts unknown.
    base:
      composedLibrary && (organizationView === "all" || organization?.snapshot)
        ? candidates
        : undefined,
    filter,
    readiness: libraryReadiness,
    favoriteIds,
    statuses,
    // Match filterPorts: group facts use the full catalog, not the searched base.
    context: {
      ...queryContext,
      catalogUniverse: queryContext?.catalogUniverse ?? catalogUniverse ?? candidates ?? [],
    },
    scope: (scoped) =>
      organizedPorts(scoped, organization, organizationView, false, catalogUniverse ?? ports),
  });

  const resultCount = browserResultCountLabel({
    view,
    visiblePorts,
    ports,
    catalogUniverse,
    declaredCandidates,
  });
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
  const firstUseEmpty =
    !resultsUnavailable &&
    firstLibraryVisit({
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
    organizationInSidebar: Boolean(organizationSelection),
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
    onSelect: stableSelect,
    onContinue: onContinue ? stableContinue : undefined,
    onTask: onTask ? stableTask : undefined,
    onBrowseCatalog,
    onDiscover,
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
    loadingResults,
    showingRetainedFavorites,
    resultsUnavailable,
    unresolvedFilter,
    favoriteCount,
    activeQuickView,
    quickViewCounts,
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

type BrowserModel = ReturnType<typeof usePortBrowser>;

function DiscoverOrganizationControls({
  model,
  favorites,
  renderFilters,
  renderSteamBatch,
}: {
  model: Pick<
    BrowserModel,
    | "view"
    | "organization"
    | "organizationView"
    | "setOrganizationView"
    | "filter"
    | "setFilter"
    | "queryContext"
  >;
  favorites: BrowserModel["favorites"];
  renderFilters: () => ReactNode;
  renderSteamBatch: () => ReactNode;
}) {
  if (model.view !== "catalog" || !model.organization) return null;
  const query = queryFromFilter(model.filter);
  const notInLibrary = query.membership?.length === 1 && query.membership[0] === "not-in-library";
  return (
    <OrganizationControls
      organization={model.organization}
      selected={model.organizationView}
      onSelect={(value) => {
        model.setOrganizationView(value);
        favorites?.setOnly(false);
        model.setFilter((current) => {
          const query = queryFromFilter(current);
          return query.version === 1 ? { ...query, membership: [] } : current;
        });
      }}
      allSelected={
        model.organizationView === "all" && !favorites?.only && !query.membership?.length
      }
      afterAll={
        <Button
          size="sm"
          data-focusable
          variant={notInLibrary ? "selected" : "ghost"}
          aria-pressed={notInLibrary}
          disabled={query.version !== 1 || !model.queryContext?.library}
          onClick={() => {
            model.setOrganizationView("all");
            favorites?.setOnly(false);
            model.setFilter((current) => {
              const query = queryFromFilter(current);
              return query.version === 1 ? { ...query, membership: ["not-in-library"] } : current;
            });
          }}
        >
          Not in library
        </Button>
      }
      discover
    >
      {renderFilters()}
      {renderSteamBatch()}
    </OrganizationControls>
  );
}

function BrowserResultNotices({
  model,
  favorites,
}: {
  model: Pick<
    BrowserModel,
    | "unresolvedReadiness"
    | "libraryReadiness"
    | "favoritesUnavailable"
    | "loadingResults"
    | "resultsUnavailable"
    | "unresolvedFilter"
    | "visiblePorts"
    | "view"
    | "constrained"
    | "query"
    | "reset"
  >;
  favorites: BrowserModel["favorites"];
}) {
  return (
    <>
      {model.unresolvedReadiness && (
        <p role="alert" className="mb-3 text-sm text-pc-muted-foreground">
          We couldn’t restore the status filter “{model.libraryReadiness}”. Choose All to reset it.
          Your other filters will stay on.
        </p>
      )}
      {model.favoritesUnavailable && !model.loadingResults && (
        <Button variant="outline" onClick={() => favorites?.setOnly(false)}>
          Show all games
        </Button>
      )}
      {model.resultsUnavailable &&
        !model.favoritesUnavailable &&
        !model.unresolvedFilter &&
        !model.loadingResults && (
          <Notice intent="warning">
            {model.visiblePorts.length
              ? "Portcove couldn’t check these filters. Previously loaded results are shown."
              : "Portcove couldn’t check these filters."}
            {(model.view !== "library" || !(model.constrained || model.query.trim())) && (
              <Button variant="outline" onClick={model.reset}>
                Reset view
              </Button>
            )}
          </Notice>
        )}
      {model.unresolvedFilter && (
        <p role="alert" className="mb-3 text-sm text-pc-muted-foreground">
          These saved filters aren’t supported by this version of Portcove. Reset them to search
          again.
        </p>
      )}
    </>
  );
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
        {model.loadingResults
          ? "Loading search results"
          : model.firstUseEmpty
            ? "Your library is empty."
            : model.resultsUnavailable
              ? "Search results unavailable"
              : model.showingRetainedFavorites
                ? `Last confirmed favorites. ${model.resultCount}`
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
        <DiscoverOrganizationControls
          model={model}
          favorites={favorites}
          renderFilters={renderFilters}
          renderSteamBatch={renderSteamBatch}
        />
      </div>
      {renderFavoritesFailure()}
      <BrowserResultNotices model={model} favorites={favorites} />
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
        onDiscover={model.onDiscover}
        onConnectGameFiles={model.onConnectGameFiles}
        clearFilters={model.reset}
        loading={model.loadingResults}
        unavailable={model.resultsUnavailable}
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

export function SteamBatchLibraryAction({
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
          Library tools
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
  onDiscover,
  onConnectGameFiles,
  clearFilters,
  loading,
  unavailable,
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
  onDiscover?: (() => void) | undefined;
  onConnectGameFiles?: (() => void) | undefined;
  clearFilters?: (() => void) | undefined;
  loading: boolean;
  unavailable: boolean;
  nativeSourceDrag: NativeSourceDragState;
}) {
  if (loading && ports.length === 0) return <LoadingState />;
  if (unavailable && ports.length === 0) return null;
  if (ports.length === 0)
    return (
      <BrowserEmptyState
        view={view}
        query={query}
        installedCount={installedCount}
        constrained={constrained}
        clearFilters={clearFilters}
        onBrowseCatalog={onBrowseCatalog}
        onDiscover={onDiscover}
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
          ? `port-grid collection-${layout} @container/collection grid w-full ${layout === "rows" ? "gap-0" : ""}`
          : "port-grid collection-covers @container/collection grid w-full"
      }
      aria-label={view === "library" ? "Library entries" : "Find games entries"}
      data-focus-group
    >
      <GroupedLibrary
        layout={layout}
        all={allCatalogPorts}
        matching={ports}
        statuses={statuses}
        organization={organization}
        onSelect={onSelect}
        renderPort={(port) => (
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
        )}
      />
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
  onDiscover,
  onConnectGameFiles,
}: {
  view: View;
  query: string;
  installedCount: number;
  constrained: boolean;
  clearFilters?: (() => void) | undefined;
  onBrowseCatalog?: (() => void) | undefined;
  /** First run: Discover is the primary way to choose a game. */
  onDiscover?: (() => void) | undefined;
  onConnectGameFiles?: (() => void) | undefined;
}) {
  if (view === "library" && installedCount === 0 && !constrained && !query.trim())
    return (
      <EmptyState
        visual={
          <span className="empty-mascot-stage grid size-16 place-items-center">
            <BrandMascot className="size-full" decorative transparent />
          </span>
        }
        title="Your library is empty"
        description="Portcove installs community-made versions of games, called ports, and keeps them updated. Some ports need files from your own copy of the original game; Portcove checks them and keeps them on this computer. You can also copy a supported installation without changing its original folder."
        action={
          <>
            {onDiscover && (
              <Button data-focusable variant="primary" size="lg" onClick={onDiscover}>
                <Icon glyph={Compass} />
                Browse games
              </Button>
            )}
            <Button
              data-focusable
              data-add-games-trigger
              variant={onDiscover ? "outline" : "primary"}
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
    <div className={view === "library" ? "library-empty-result" : undefined}>
      <EmptyState
        icon={Settings2}
        title={view === "library" ? "Nothing in your library matches" : "No matching games"}
        description={
          view === "library"
            ? "Reset search, filters, quick views and collection selection to browse again."
            : query
              ? `No games match “${query}” with the current view. Reset search, filters, quick views and collection selection to browse again.`
              : "No games match the current filters and view. Reset filters, quick views and collection selection to browse again."
        }
        action={
          <Button data-focusable variant="outline" size="lg" onClick={clearFilters}>
            <Icon glyph={Settings2} />
            Reset view
          </Button>
        }
      />
    </div>
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
  const action = presentPortAction(useOperationPresentation(), port.id, status, "launch");
  const launchable = continueLaunchable(port, status, action.readiness.blocked);
  const trial = hasUnconfirmedLaunchInput(status, port);
  const previouslyPlayed = status.successful_launches > 0;
  return (
    <GameHero
      port={port}
      variant="continue"
      className="continue-card mb-6"
      successfulLaunches={status.successful_launches}
      label={`${previouslyPlayed ? "Continue" : "Play"} ${gameIdentityLabel(port)}`}
    >
      <div className="continue-identity min-w-0 wrap-anywhere">
        <h2 className="continue-title m-0">{gameTitle(port)}</h2>
        {gameProjectLabel(port) && (
          <p className="m-0 mt-1 text-xs text-pc-muted-foreground">{gameProjectLabel(port)}</p>
        )}
        {trial && (
          <p className="m-0 mt-1 text-xs text-pc-warning-foreground">Compatibility unconfirmed</p>
        )}
      </div>
      <div className="continue-actions min-w-0">
        {launchable && status.external_runtime && (
          <ExternalLaunchWarnings portId={port.id} status={status} />
        )}
        <Button
          data-focusable
          variant="primary"
          size="default"
          data-detail-origin={launchable ? undefined : `library:continue-review:${port.id}`}
          disabled={launchable && Boolean(action.busy)}
          focusableWhenDisabled={launchable && Boolean(action.busy)}
          aria-busy={launchable && Boolean(action.busy)}
          title={action.assessment.reason}
          onClick={() =>
            launchable ? launch(port.id) : details(port.id, `library:continue-review:${port.id}`)
          }
        >
          <Icon glyph={Play} className="fill-current" />
          {launchable
            ? status.readiness?.pending_setup
              ? "Launch to finish setup"
              : trial
                ? "Try launch"
                : previouslyPlayed
                  ? "Continue playing"
                  : "Play"
            : "Review launch"}
        </Button>
        <Button
          data-focusable
          variant="ghost"
          className="continue-details"
          data-detail-origin={`library:continue-details:${port.id}`}
          onClick={() => details(port.id, `library:continue-details:${port.id}`)}
        >
          Game details
          <Icon glyph={ArrowRight} />
        </Button>
      </div>
    </GameHero>
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

const idleNativeSourceDrag: NativeSourceDragState = { active: false, pathCount: 0 };

/** Memoized: a grid re-renders only cards whose port, status or shared inputs changed. */
const PortCard = memo(function PortCard({
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
            "flex cursor-default items-center gap-2 rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection data-highlighted:text-pc-selection-foreground [&_svg]:size-4 [&_svg]:shrink-0",
          )}
          onClick={(event) => onFavoriteToggle(port.id, event.currentTarget)}
        >
          <Heart aria-hidden="true" />
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
        favorites,
        onFavoriteToggle,
      }}
    />
  );
});

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
  favorites,
  onFavoriteToggle,
}: Pick<
  PortCardProps,
  | "port"
  | "status"
  | "layout"
  | "onSelect"
  | "onLaunch"
  | "onTask"
  | "favorites"
  | "onFavoriteToggle"
> & {
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
      <div className="collection-main">
        <button
          data-focusable
          className={cn(
            controlFocus,
            "collection-identity cursor-pointer text-start hover:text-pc-interactive-foreground",
          )}
          aria-label={`View details for ${gameIdentityLabel(port).replace(" · ", " ")}`}
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
          <span className="collection-caption">
            <span
              role="heading"
              aria-level={2}
              className="collection-title font-semibold wrap-anywhere"
            >
              {gameTitle(port)}
            </span>{" "}
            <span
              className="collection-project block wrap-anywhere text-[var(--color-text-secondary)]"
              title={gameProjectLabel(port)}
            >
              {gameProjectLabel(port)}
            </span>
          </span>
        </button>
        <div className="library-entry-chips">
          <IdentityChips
            port={{
              ...port,
              platforms: [],
              // Routine Stable repeats on every card; keep it when it differs
              // from the selected channel or the channel is not Stable.
              channels:
                status?.active &&
                (status.active.channel !== "stable" || status.channel !== status.active.channel)
                  ? [status.active.channel]
                  : [],
            }}
          />
        </div>
      </div>

      <div className="collection-personal-actions">
        <PortCardActionMenu
          {...{ favoriteMenu, port, status, onSelect }}
          overflowOrigin={`library:card-more:${port.id}`}
        />
        {favorites && (
          <Button
            data-focusable
            variant="ghost"
            size="icon-sm"
            className="collection-art-action collection-favorite"
            aria-label={`Favorite ${gameIdentityLabel(port)}`}
            aria-pressed={favorites.ids?.has(port.id) ?? false}
            title={favorites.ids?.has(port.id) ? "Remove from favorites" : "Add to favorites"}
            disabled={!favorites.ids || favorites.busy}
            onClick={(event) => onFavoriteToggle(port.id, event.currentTarget)}
          >
            <Heart aria-hidden="true" />
          </Button>
        )}
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
  const reviewOrigin = `${detailOrigin}:review`;
  const reviewSetup = Boolean(
    port.pendingSetup || hasPendingSetupAction(status) || installedCardInputPresentation(status),
  );
  const playLabel = status?.readiness?.pending_setup
    ? "Start setup"
    : hasUnconfirmedLaunchInput(status, port)
      ? "Try launch"
      : "Play";
  const reviewLabel =
    port.pendingSetup?.state === "attention-required"
      ? "Review download"
      : port.pendingSetup
        ? "Continue setup"
        : reviewSetup
          ? "Set up"
          : "View details";
  return (
    <div className="collection-actions mt-0 flex min-h-8 flex-wrap items-center justify-end gap-1 pt-0 text-xs">
      {!taskPrimary && canLaunch && status?.external_runtime && (
        <ExternalLaunchWarnings portId={port.id} status={status} />
      )}
      <span className="inline-flex flex-wrap items-center justify-end gap-1 text-[var(--color-interactive-text-strong)]">
        {taskPrimary ? (
          <Button
            key="task"
            data-focusable
            variant="outline"
            size="xs"
            className="library-card-action"
            data-detail-origin={`${detailOrigin}:task`}
            aria-label={`View task: ${gameIdentityLabel(port)}`}
            onClick={() =>
              onTask
                ? onTask(action.pending?.context.activityId)
                : onSelect(port.id, `${detailOrigin}:task`)
            }
          >
            View task <ArrowRight aria-hidden="true" />
          </Button>
        ) : !canLaunch ? (
          <Button
            key="review"
            data-focusable
            variant="outline"
            size="xs"
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
            <ArrowRight aria-hidden="true" />
          </Button>
        ) : (
          <Button
            key="play"
            data-focusable
            variant="primary"
            size="xs"
            className="library-card-action library-card-play"
            disabled={Boolean(action.busy)}
            focusableWhenDisabled={Boolean(action.busy)}
            aria-busy={Boolean(action.busy)}
            aria-label={`${playLabel}: ${gameIdentityLabel(port)}`}
            title={action.assessment.reason}
            onClick={() => onLaunch?.(port.id)}
          >
            <Play aria-hidden="true" fill="currentColor" />
            {playLabel}
          </Button>
        )}
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
            {favorites.failure === "write"
              ? "Your choice may already be saved. Retry favorites to check."
              : favorites.ids
                ? "Portcove is showing your last saved favorites. Retry favorites to check for changes."
                : "Portcove couldn’t load your favorites. Retry favorites or keep browsing and playing without them."}
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
        aria-label={model.view === "library" ? "Library filters" : "Favorite games"}
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
            aria-label={`Favorites ${model.favoriteCount ?? "unavailable"}`}
            aria-pressed={favorites.only}
            disabled={!favorites.ids}
            onClick={() => {
              if (model.view === "catalog") {
                model.setOrganizationView("all");
                model.setFilter((current) => {
                  const query = queryFromFilter(current);
                  return query.version === 1 ? { ...query, membership: [] } : current;
                });
              }
              favorites.setOnly(!favorites.only);
            }}
          >
            Favorites{" "}
            <span className="browse-count" aria-hidden="true">
              {model.favoriteCount ?? "unavailable"}
            </span>
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
  const countId = useId();
  if (!model.composedLibrary || model.firstUseEmpty) return null;
  const active = model.activeQuickView;
  const counts = model.quickViewCounts;
  const select = (view: LibraryQuickView) => {
    model.setLibraryReadiness?.(readinessForQuickView(view, model.libraryReadiness));
    if (view === "favorites") favorites?.setOnly(true);
    else if (favorites?.only) favorites.setOnly(false);
    model.setFilter((current) =>
      view === "updates" ? withUpdatesQuickView(current) : withoutUpdatesQuickView(current),
    );
  };
  const views: { view: LibraryQuickView; label: string; description: string }[] = [
    { view: "all", label: "All", description: "Every game in this library scope" },
    ...(favorites
      ? [
          {
            view: "favorites" as const,
            label: "Favorites",
            description: "Games you marked as favorites",
          },
        ]
      : []),
    {
      view: "attention",
      label: "Needs attention",
      description: "Games that need setup, files or repair before they can play",
    },
    {
      view: "updates",
      label: "Updates",
      description: "Games with an update available or downloaded and ready to apply",
    },
  ];
  const enabled = (view: LibraryQuickView) =>
    view === "favorites"
      ? Boolean(favorites?.ids)
      : view === "updates"
        ? !model.unresolvedFilter && !hasCustomUpdateFilter(model.filter)
        : true;
  // One tab stop: the selected view, or the first view when constraints combine.
  const tabStop = active && enabled(active) ? active : "all";
  const move = (from: LibraryQuickView, key: string, group: HTMLElement | null) => {
    const order = views.map((item) => item.view).filter(enabled);
    const index = order.indexOf(from);
    const target =
      key === "Home"
        ? order[0]
        : key === "End"
          ? order.at(-1)
          : key === "ArrowRight" || key === "ArrowDown"
            ? order[(index + 1) % order.length]
            : key === "ArrowLeft" || key === "ArrowUp"
              ? order[(index - 1 + order.length) % order.length]
              : undefined;
    if (!target) return false;
    select(target);
    group?.querySelector<HTMLButtonElement>(`[data-quick-view="${target}"]`)?.focus();
    return true;
  };
  return (
    <div
      role="radiogroup"
      aria-label="Library quick views"
      data-focus-group
      className="flex min-w-0 flex-wrap items-center gap-1"
    >
      {views.map(({ view, label }) => {
        const count = counts[view];
        const checked = active === view;
        return (
          <Button
            key={view}
            size="sm"
            role="radio"
            data-focusable
            data-quick-view={view}
            data-favorites-filter={view === "favorites" ? true : undefined}
            ref={view === "favorites" ? filterButton : undefined}
            variant={checked ? "selected" : "ghost"}
            aria-checked={checked}
            tabIndex={view === tabStop ? 0 : -1}
            disabled={!enabled(view)}
            aria-label={view === "favorites" ? `Favorites ${count}` : undefined}
            aria-describedby={`${countId}-${view}`}
            onClick={() => {
              if (!checked) select(view);
            }}
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              if (move(view, event.key, event.currentTarget.parentElement)) event.preventDefault();
            }}
          >
            {label}
            {typeof count === "number" && (
              <span className="browse-count" aria-hidden="true">
                {count}
              </span>
            )}
          </Button>
        );
      })}
      {views.map(({ view, description }) => {
        const count = counts[view];
        return (
          <span key={view} id={`${countId}-${view}`} className="sr-only">
            {view === "updates" && hasCustomUpdateFilter(model.filter)
              ? "Unavailable while an Observed updates filter is set. Clear that filter to use this view."
              : `${description}.`}
            {/* Favorites already names its count. */}
            {view !== "favorites" &&
              ` ${typeof count === "number" ? `${count} ${count === 1 ? "game" : "games"}` : "Count unavailable"}`}
          </span>
        );
      })}
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
      <div className="browse-sort w-44 max-w-full min-w-0">
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
              : catalogSortOptions.map((option) =>
                  option.value === "catalog" && model.queryContext?.devicePlatform
                    ? { ...option, label: "Library & device" }
                    : option,
                )
          }
          onChange={model.setCatalogSort}
        />
      </div>
    )
  );
}

function CollectionResultSummary({
  model,
}: {
  model: Pick<
    ReturnType<typeof usePortBrowser>,
    | "resultsUnavailable"
    | "resultCount"
    | "organizationView"
    | "organization"
    | "libraryReadiness"
    | "view"
    | "collectionLayoutFailure"
    | "firstUseEmpty"
    | "constrained"
    | "query"
    | "visiblePorts"
    | "reset"
    | "overview"
  >;
}) {
  const constrainedLibrary =
    model.view === "library" && (model.constrained || model.query.trim().length > 0);
  const count = constrainedLibrary
    ? libraryResultCount(model.visiblePorts.length, model.overview.installed)
    : model.resultCount;
  // The unfiltered library total already appears under the page heading.
  const showCount = model.view !== "library" || constrainedLibrary || model.resultsUnavailable;
  const hasContext =
    model.organizationView !== "all" ||
    (model.libraryReadiness !== "all" && model.view === "library") ||
    Boolean(model.collectionLayoutFailure);
  if (!showCount && !hasContext) return null;
  return (
    <div className="collection-result-summary">
      {showCount && <span>{model.resultsUnavailable ? "Ports unavailable" : count}</span>}
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
      {constrainedLibrary &&
        !model.firstUseEmpty &&
        (model.resultsUnavailable || model.visiblePorts.length > 0) && (
          <Button variant="ghost" size="sm" onClick={model.reset}>
            Reset view
          </Button>
        )}
      {model.collectionLayoutFailure && (
        <span role="status">
          {model.collectionLayoutFailure === "read"
            ? "The saved collection view could not be read. Covers are shown."
            : "This collection view is available for this session; it could not be saved."}
        </span>
      )}
    </div>
  );
}

function libraryResultCount(visible: number, installed: number) {
  return `${visible} of ${installed} in your library`;
}

function CollectionLayoutToggle({
  layout,
  onChange,
}: {
  layout: "covers" | "rows";
  onChange: (layout: "covers" | "rows") => void;
}) {
  return (
    <div role="group" aria-label="Collection view" className="ms-auto flex flex-wrap gap-1">
      <span className="self-center text-xs text-pc-muted-foreground">View</span>
      {(["covers", "rows"] as const).map((nextLayout) => (
        <Button
          key={nextLayout}
          variant={layout === nextLayout ? "selected" : "ghost"}
          size="sm"
          aria-pressed={layout === nextLayout}
          aria-label={nextLayout === "rows" ? "Compact rows" : "Covers"}
          data-focusable
          onClick={() => onChange(nextLayout)}
        >
          <Icon glyph={nextLayout === "covers" ? LayoutGrid : List} size="sm" />
          <span className="collection-layout-label">
            {nextLayout === "covers" ? "Covers" : "Rows"}
          </span>
        </Button>
      ))}
    </div>
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
      {!model.composedLibrary &&
        !(model.view === "catalog" && model.organization) &&
        renderFilters()}
    </>
  );
  const after = (
    <>
      {model.view === "library" && model.organization && !model.organizationInSidebar && (
        <div className={model.organizationInSidebar ? "compact-library-collections" : undefined}>
          <OrganizationControls
            organization={model.organization}
            selected={model.organizationView}
            onSelect={model.setOrganizationView}
            discover={false}
          >
            {renderSteamBatch()}
          </OrganizationControls>
        </div>
      )}
      {renderSort()}
      {setCollectionLayout && (
        <CollectionLayoutToggle layout={model.collectionLayout} onChange={setCollectionLayout} />
      )}
      {!model.organization && renderSteamBatch()}
    </>
  );
  const summary = <CollectionResultSummary model={model} />;
  return (
    <div className="library-query-tools mb-4" data-view={model.view}>
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
          quickViewUpdates={model.composedLibrary && model.activeQuickView === "updates"}
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
          className="library-update-review h-auto min-h-6 items-start gap-1.5 p-0 text-start text-xs font-normal whitespace-normal"
          data-detail-origin={`${detailOrigin}:update`}
          onClick={() => onSelect(port.id, `${detailOrigin}:update`, "updates")}
        >
          <Icon glyph={ArrowDownCircle} size="sm" />
          {status?.acquisition
            ? gameUpdateAcquisitionLabel(status.acquisition.phase)
            : status?.staged
              ? "Update saved for later"
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
              className="collection-art-action collection-more"
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
                "flex cursor-default items-center gap-2 rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection data-highlighted:text-pc-selection-foreground [&_svg]:size-4 [&_svg]:shrink-0",
              )}
              onClick={() =>
                onSelect(
                  port.id,
                  overflowOrigin,
                  port.release && !status?.external_runtime?.user_selected ? "updates" : undefined,
                )
              }
            >
              <History aria-hidden="true" />
              {port.release && !status?.external_runtime?.user_selected
                ? "Updates and activity"
                : "Launch details"}
            </Menu.Item>
            {port.release && !status?.external_runtime?.user_selected && (
              <Menu.Item
                className={cn(
                  controlFocus,
                  "flex cursor-default items-center gap-2 rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection data-highlighted:text-pc-selection-foreground [&_svg]:size-4 [&_svg]:shrink-0",
                )}
                onClick={() => onSelect(port.id, overflowOrigin, "saves")}
              >
                <Save aria-hidden="true" />
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
    ? `${count} in your library`
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
