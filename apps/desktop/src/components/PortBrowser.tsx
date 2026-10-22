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
  ArrowRight,
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
  catalogSetupPresentation,
  installedCardInputPresentation,
  portActionPresentation,
} from "../features/port-actions/port-action-presentation";
import type { PortDefinition, PortStatus } from "../types";
import { observedUpdateCandidate } from "../features/browsing/update-query-context";
import {
  filterOptions,
  filterPorts,
  platformLabel,
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
import { ArtworkImage, ArtworkFrame, artworkDisplayNotice } from "./Artwork";
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
import { CatalogFilters } from "../features/browsing/CatalogFilters";
import type { GameFileFilterState } from "../features/browsing/use-game-file-filter-context";

const catalogSortOptions: readonly { value: CatalogSort; label: string }[] = [
  { value: "catalog", label: "Catalog order" },
  { value: "name", label: "Name A–Z" },
  { value: "installed-first", label: "In library first" },
];

export function PortBrowser({
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
  favorites?: ReturnType<typeof useFavorites> | undefined;
  view: View;
  ports: PortDefinition[];
  /** Search/view narrowed candidates, before either editable Catalog group. */
  catalogFilterCandidates?: PortDefinition[] | undefined;
  /** Search and canonical Library membership, before readiness and declared query. */
  libraryFilterCandidates?: PortDefinition[] | undefined;
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
  onBrowseCatalog?: (() => void) | undefined;
  onConnectGameFiles?: (() => void) | undefined;
  steamBatch?: { ports: PortDefinition[]; generation: number };
  clearFilters?: (() => void) | undefined;
  loading: boolean;
  nativeSourceDrag?: NativeSourceDragState;
}) {
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
  const restoreAfter = async (button: HTMLButtonElement, action: () => Promise<boolean>) => {
    const owner = browserOwner.current;
    const ownedFocus = document.activeElement === button;
    const accepted = await action();
    if (
      accepted &&
      ownedFocus &&
      !owner.closed &&
      !button.isConnected &&
      document.activeElement === document.body
    )
      (
        filterButton.current ??
        browserRoot.current?.querySelector<HTMLButtonElement>("[data-focusable]:not([disabled])")
      )?.focus();
  };
  const onFavoriteToggle = (portId: string, button: HTMLButtonElement) => {
    if (favorites) void restoreAfter(button, () => favorites.toggle(portId));
  };
  const resolveLibraryFilters = () => {
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
  };
  const { composedLibrary, unresolvedReadiness, candidates, readinessCount, declaredCandidates } =
    resolveLibraryFilters();
  const favoritesUnavailable = favorites?.only === true && !favorites.ids;
  const queryState =
    typeof filter === "string" ? "matched" : evaluateCatalogQuery([], filter, queryContext).state;
  const resultsUnavailable =
    favoritesUnavailable ||
    queryState === "unavailable" ||
    (composedLibrary && candidates === undefined);
  const unresolvedFilter = queryState === "unresolved";
  const favoriteCount = favorites?.ids
    ? ports.filter((port) => favorites.ids?.has(port.id)).length
    : undefined;
  const visiblePorts = favorites?.only
    ? ports.filter((port) => favorites.ids?.has(port.id))
    : ports;
  const resultCount =
    view === "library"
      ? `${visiblePorts.length} library ${visiblePorts.length === 1 ? "entry" : "entries"}`
      : `${visiblePorts.length} ${visiblePorts.length === 1 ? "port" : "ports"}`;
  const reset = () => {
    const owner = browserOwner.current;
    const origin = document.activeElement;
    favorites?.setOnly(false);
    clearFilters?.();
    window.requestAnimationFrame(() => {
      if (owner.closed || browserOwner.current !== owner) return;
      if (document.activeElement !== origin && document.activeElement !== document.body) return;
      (document.querySelector<HTMLInputElement>("#port-search") ?? filterButton.current)?.focus();
    });
  };
  const constrained =
    filterConstrained(filter) ||
    favorites?.only === true ||
    (composedLibrary && libraryReadiness !== "all");
  const firstUseEmpty =
    view === "library" &&
    !loading &&
    !recent &&
    overview.installed === 0 &&
    ports.length === 0 &&
    !constrained &&
    query.trim().length === 0;
  const renderDropAnnouncement = () => (
    <p className="sr-only" aria-live="polite">
      {nativeSourceDrag.active
        ? `Game file drop targets are available. ${nativeSourceDrag.pathCount === 1 ? "One path" : `${nativeSourceDrag.pathCount} paths`} selected.`
        : ""}
    </p>
  );
  const renderConnectPrompt = () =>
    view === "catalog" &&
    !loading &&
    overview.installed === 0 &&
    onConnectGameFiles && (
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
        <Button data-focusable variant="outline" onClick={onConnectGameFiles}>
          Connect game-file folder
        </Button>
      </section>
    );
  const renderContinue = () =>
    view === "library" &&
    recent &&
    onContinue &&
    !favorites?.only && <ContinueCard recent={recent} launch={onContinue} details={onSelect} />;
  const renderSteamBatch = () =>
    view === "library" &&
    steamBatch &&
    steamBatch.ports.length >= 2 && <SteamBatchLibraryAction {...steamBatch} />;
  const renderFavoritesFailure = () =>
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
            onClick={(event) => void restoreAfter(event.currentTarget, favorites.refresh)}
          >
            Retry favorites
          </Button>
        </div>
      </Notice>
    );
  const renderFilters = () =>
    !firstUseEmpty && (
      <div
        className="filter-row flex flex-wrap items-center gap-2"
        data-focus-group
        role="group"
        aria-label={view === "library" ? "Library filters" : "Release channel filters"}
      >
        {composedLibrary && (
          <div className="collection-readiness-compact max-w-full min-w-0">
            <ChoiceSelect
              label="Readiness"
              value={libraryReadiness}
              options={filterOptions(view).map((item) => ({
                value: item,
                label: `${filterLabel(item)} (${readinessCount(item as "all" | "ready" | "setup")})`,
              }))}
              onChange={(value) => setLibraryReadiness?.(value)}
            />
          </div>
        )}
        <div
          className={
            composedLibrary ? "collection-readiness-wide flex-wrap gap-1" : "flex flex-wrap gap-1"
          }
        >
          {filterOptions(view).map((item) => (
            <Button
              data-focusable
              aria-pressed={
                composedLibrary ? libraryReadiness === item : filterSelected(filter, item)
              }
              key={item}
              variant={
                (composedLibrary ? libraryReadiness === item : filterSelected(filter, item))
                  ? "selected"
                  : "outline"
              }
              size="sm"
              disabled={!composedLibrary && unresolvedFilter && item !== "all"}
              onClick={() =>
                composedLibrary
                  ? setLibraryReadiness?.(item)
                  : setFilter((current) =>
                      view === "catalog" ? toggleCatalogChannel(current, item, queryContext) : item,
                    )
              }
            >
              {filterLabel(item)}
              {composedLibrary && ` (${readinessCount(item as "all" | "ready" | "setup")})`}
            </Button>
          ))}
        </div>
        {favorites && (
          <Button
            data-focusable
            size="sm"
            variant={favorites.only ? "selected" : "outline"}
            ref={filterButton}
            data-favorites-filter
            aria-pressed={favorites.only}
            disabled={!favorites.ids}
            onClick={() => favorites.setOnly(!favorites.only)}
          >
            <Icon glyph={Star} size="sm" /> Favorites
            {favoriteCount === undefined ? " (unavailable)" : ` (${favoriteCount})`}
          </Button>
        )}
        {favorites?.only && view !== "library" && (
          <Button data-focusable size="sm" variant="ghost" onClick={reset}>
            Clear search and filters
          </Button>
        )}
        <span
          className={cn(
            "ml-auto text-xs text-pc-muted-foreground",
            view === "library" && "sr-only",
          )}
          aria-hidden="true"
        >
          {resultsUnavailable ? "Ports unavailable" : resultCount}
        </span>
      </div>
    );
  const renderSort = () =>
    view === "catalog" &&
    setCatalogSort && (
      <div className="w-52 shrink-0">
        <ChoiceSelect
          label="Sort"
          value={catalogSort}
          options={catalogSortOptions}
          onChange={setCatalogSort}
        />
      </div>
    );
  const renderDeclaredFilters = () =>
    (view === "catalog" || composedLibrary) && (
      <CatalogFilters
        gameFileQuery={gameFileQuery}
        view={view === "library" ? "library" : "catalog"}
        candidates={declaredCandidates}
        context={queryContext}
        filter={filter}
        setFilter={setFilter}
      />
    );
  return (
    <div ref={browserRoot} className="@container/library-query min-w-0">
      <p className="sr-only" role="status" aria-label="Search results">
        {firstUseEmpty
          ? "Your library is empty."
          : resultsUnavailable
            ? "Search results unavailable"
            : resultCount}
      </p>
      {renderDropAnnouncement()}
      {renderConnectPrompt()}
      {view === "library" && recent && onContinue && !favorites?.only && (
        <details className="mb-4 text-sm text-pc-muted-foreground">
          <summary data-focusable className="cursor-pointer py-2">
            Last played
          </summary>
          {renderContinue()}
        </details>
      )}

      {renderFavoritesFailure()}
      {unresolvedReadiness && (
        <p role="alert" className="mb-3 text-sm text-pc-muted-foreground">
          Restored readiness “{libraryReadiness}” is not supported. Choose All to reset readiness;
          declared filters remain active.
        </p>
      )}
      {favoritesUnavailable && (
        <p role="status">Favorites are unavailable; retained constraints need confirmed choices.</p>
      )}
      {unresolvedFilter && (
        <p role="alert" className="mb-3 text-sm text-pc-muted-foreground">
          These filters are not supported. Reset filters to choose a supported query.
        </p>
      )}
      {!firstUseEmpty && (
        <div
          className="library-query-tools mb-5 flex flex-wrap items-center gap-3"
          data-focus-group
        >
          {view === "library" && setQuery && (
            <PortSearch query={query} setQuery={setQuery} library />
          )}
          {renderFilters()}
          {renderDeclaredFilters()}
          {renderSort()}
          {view === "library" && !firstUseEmpty && (
            <div
              className="collection-tools ms-auto flex flex-wrap items-center gap-3"
              data-focus-group
            >
              {onBrowseCatalog && overview.installed > 0 && (
                <Button
                  data-focusable
                  data-add-games-trigger
                  variant="outline"
                  onClick={onBrowseCatalog}
                >
                  Add games
                </Button>
              )}
              {setCollectionLayout && (
                <div role="group" aria-label="Collection view" className="flex flex-wrap gap-1">
                  <span className="self-center text-xs text-pc-muted-foreground">View</span>
                  {(["covers", "rows"] as const).map((layout) => (
                    <Button
                      key={layout}
                      variant={collectionLayout === layout ? "selected" : "outline"}
                      aria-pressed={collectionLayout === layout}
                      data-focusable
                      onClick={() => setCollectionLayout(layout)}
                    >
                      {layout === "covers" ? "Covers" : "Compact rows"}
                    </Button>
                  ))}
                </div>
              )}
              {collectionLayoutFailure && (
                <p role="status" className="basis-full text-end text-xs text-pc-muted-foreground">
                  {collectionLayoutFailure === "read"
                    ? "The saved collection view could not be read. Covers are shown."
                    : "This collection view is available for this session; it could not be saved."}
                </p>
              )}
            </div>
          )}
          {renderSteamBatch()}
        </div>
      )}
      {view === "library" && !firstUseEmpty && (constrained || query.trim()) && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="m-0" role="status">
            {resultsUnavailable
              ? "Results unavailable"
              : `${visiblePorts.length} of ${overview.installed} library ${overview.installed === 1 ? "entry" : "entries"}`}
          </p>
          {(resultsUnavailable || visiblePorts.length > 0) && (
            <Button variant="ghost" onClick={reset}>
              Clear search and filters
            </Button>
          )}
        </div>
      )}
      <BrowserResults
        layout={view === "library" ? collectionLayout : "covers"}
        view={view}
        ports={visiblePorts}
        favorites={favorites}
        onFavoriteToggle={onFavoriteToggle}
        installedCount={overview.installed}
        constrained={constrained || query.trim().length > 0}
        statuses={statuses}
        onSelect={onSelect}
        onLaunch={onContinue}
        onBrowseCatalog={onBrowseCatalog}
        onConnectGameFiles={onConnectGameFiles}
        clearFilters={reset}
        loading={loading || resultsUnavailable}
        nativeSourceDrag={nativeSourceDrag}
      />
    </div>
  );
}

function filterSelected(filter: Filter | CatalogQuery, item: Filter) {
  if (typeof filter === "string") return filter === item;
  if (evaluateCatalogQuery([], filter).state === "unresolved") return false;
  return item === "all" ? !filter.channels?.length : filter.channels?.includes(item) === true;
}

function filterConstrained(filter: Filter | CatalogQuery) {
  if (typeof filter === "string") return filter !== "all";
  if (evaluateCatalogQuery([], filter).state === "unresolved") return true;
  return Object.entries(filter).some(
    ([key, values]) => key !== "version" && Array.isArray(values) && values.length > 0,
  );
}

function toggleCatalogChannel(
  filter: Filter | CatalogQuery,
  item: Filter,
  context?: CatalogQueryContext,
): Filter | CatalogQuery {
  if (
    typeof filter !== "string" &&
    evaluateCatalogQuery([], filter, context).state === "unresolved"
  )
    return item === "all" ? "all" : filter;
  const current: CatalogQuery =
    typeof filter === "string"
      ? { version: 1, channels: ["stable", "beta", "rolling"].includes(filter) ? [filter] : [] }
      : filter;
  const channels = current.channels ?? [];
  return {
    ...current,
    channels:
      item === "all"
        ? []
        : channels.includes(item)
          ? channels.filter((channel) => channel !== item)
          : [...channels, item],
  };
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
      <details className="text-xs text-pc-muted-foreground">
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
  layout,
  favorites,
  onFavoriteToggle,
  view,
  ports,
  installedCount,
  constrained,
  statuses,
  onSelect,
  onLaunch,
  onBrowseCatalog,
  onConnectGameFiles,
  clearFilters,
  loading,
  nativeSourceDrag,
}: {
  layout: CollectionLayout;
  favorites?: ReturnType<typeof useFavorites> | undefined;
  onFavoriteToggle: (portId: string, button: HTMLButtonElement) => void;
  view: View;
  ports: PortDefinition[];
  installedCount: number;
  constrained: boolean;
  statuses: Map<string, PortStatus>;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
  onLaunch?: ((portId: string) => void) | undefined;
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
        installedCount={installedCount}
        constrained={constrained}
        clearFilters={clearFilters}
        onBrowseCatalog={onBrowseCatalog}
        onConnectGameFiles={onConnectGameFiles}
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
          key={port.id}
          port={port}
          status={statuses.get(port.id)}
          readiness={portReadiness(statuses.get(port.id))}
          onSelect={onSelect}
          onLaunch={onLaunch}
          nativeSourceDrag={nativeSourceDrag}
          view={view}
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
  installedCount,
  constrained,
  clearFilters,
  onBrowseCatalog,
  onConnectGameFiles,
}: {
  view: View;
  installedCount: number;
  constrained: boolean;
  clearFilters?: (() => void) | undefined;
  onBrowseCatalog?: (() => void) | undefined;
  onConnectGameFiles?: (() => void) | undefined;
}) {
  if (view === "library" && installedCount === 0 && !constrained)
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
  if (view === "library")
    return (
      <EmptyState
        icon={Settings2}
        eyebrow="NO MATCHES"
        title="No ports in your library match your search and filters"
        description={
          installedCount === 0
            ? "This library has no ports yet. Clear the current search and readiness filters to return to the empty Library."
            : "Clear the search or change the readiness filter."
        }
        action={
          <Button data-focusable variant="outline" size="lg" onClick={clearFilters}>
            <Icon glyph={Settings2} />
            Clear search and filters
          </Button>
        }
      />
    );
  return (
    <EmptyState
      icon={Settings2}
      eyebrow="NO MATCHES"
      title="No ports match these filters"
      description="Try another search or change the filters."
      action={
        <Button data-focusable variant="outline" size="lg" onClick={clearFilters}>
          <Icon glyph={Settings2} />
          Clear search and filters
        </Button>
      }
    />
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
  const launchable =
    status.readiness?.launchable === true &&
    status.readiness.blockers.length === 0 &&
    !action.readiness.blocked;
  const trial = hasUnconfirmedLaunchInput(status, port);
  return (
    <section
      className="continue-card mb-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-pc-border pb-3 max-[48rem]:grid-cols-1"
      data-focus-group
      data-successful-launches={status.successful_launches}
      aria-label={`Continue ${gameIdentityLabel(port)}`}
    >
      <div>
        <p className="mb-1 text-xs text-pc-muted-foreground">Last played</p>
        <h2 className="m-0 text-sm">{gameTitle(port)}</h2>
        {gameProjectLabel(port) && (
          <p className="m-0 mt-1 text-xs text-pc-muted-foreground">{gameProjectLabel(port)}</p>
        )}
        {trial && (
          <p className="m-0 mt-1 text-xs text-pc-warning-foreground">Compatibility unconfirmed</p>
        )}
      </div>
      <div className="continue-actions flex gap-2 max-[65rem]:col-span-full max-[65rem]:justify-end">
        <Button
          data-focusable
          variant="outline"
          size="lg"
          data-detail-origin={`library:continue-details:${port.id}`}
          onClick={() => details(port.id, `library:continue-details:${port.id}`)}
        >
          View details
        </Button>
        <Button
          data-focusable
          variant="primary"
          size="lg"
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
                : "Play again"
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
  layout: CollectionLayout;
  onFavoriteToggle: (portId: string, button: HTMLButtonElement) => void;
  favorites?: ReturnType<typeof useFavorites> | undefined;
  port: PortDefinition;
  status?: PortStatus | undefined;
  readiness: PortReadiness;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
  onLaunch?: ((portId: string) => void) | undefined;
  nativeSourceDrag: NativeSourceDragState;
  view: View;
};

function PortCard({
  layout,
  favorites,
  onFavoriteToggle,
  port,
  status,
  readiness,
  onSelect,
  onLaunch,
  nativeSourceDrag,
  view,
}: PortCardProps) {
  const setupDescriptionId = useId();
  const resolveCardPresentation = () => {
    const input = installedCardInputPresentation(status);
    const originalState = readinessPresentation(readiness, view, status, port);
    const state = input ? { ...originalState, label: input.label } : originalState;
    const setup =
      view === "catalog" && !status?.active && !status?.external_runtime
        ? catalogSetupPresentation(status)
        : undefined;
    const channel = status?.channel ? releaseChannelPresentation(status.channel) : undefined;
    const updateAvailable = observedUpdateCandidate(port.id, status)?.availableAtLastCheck === true;
    return { input, state, setup, channel, updateAvailable };
  };
  const { input, state, setup, channel, updateAvailable } = resolveCardPresentation();
  const dropEligible = nativeSourceDrag.active && Boolean(port.source_profile);
  const dropTarget = dropEligible && nativeSourceDrag.targetPortId === port.id;
  const detailOrigin = `${view}:card:${port.id}`;
  const className = `port-card catalog-card collection-cover @container/card relative isolate flex min-w-0 flex-col p-0 text-start text-pc-foreground transition-colors duration-(--duration-fast) hover:text-pc-interactive-foreground motion-reduce:transition-none ${view === "catalog" ? "port-card-selectable cursor-pointer" : "port-card-library"}${dropEligible ? " source-drop-eligible" : ""}${dropTarget ? " source-drop-targeted outline-3 outline-solid outline-pc-ring outline-offset-2" : ""}`;
  const contents = (
    <PortCardContents
      {...{
        port,
        status,
        state,
        setup,
        setupDescriptionId,
        input,
        channel,
        updateAvailable,
        dropEligible,
        dropTarget,
      }}
      hasFavorite={Boolean(favorites)}
      detailOrigin={detailOrigin}
      onSelect={onSelect}
      onLaunch={onLaunch}
      view={view}
    />
  );
  const renderFavoriteToggle = () =>
    favorites && (
      <Tooltip label={favorites.ids?.has(port.id) ? "Remove favorite" : "Add favorite"}>
        <Button
          data-focusable
          variant={favorites.ids?.has(port.id) ? "selected" : "outline"}
          size="icon-sm"
          className={cn(
            view === "library"
              ? "shrink-0"
              : "absolute [inset-inline-start:calc(min(100%,var(--collection-art-limit))_-_2rem)] bottom-0 z-10 bg-pc-surface",
          )}
          aria-label={`Favorite ${gameIdentityLabel(port)}`}
          aria-pressed={favorites.ids?.has(port.id) ?? false}
          disabled={!favorites.ids}
          aria-disabled={favorites.busy}
          onClick={(event) => onFavoriteToggle(port.id, event.currentTarget)}
        >
          <span className={favorites.ids?.has(port.id) ? "[&_.icon]:fill-current" : undefined}>
            <Icon glyph={Star} size="sm" />
          </span>
          <span className="sr-only">
            {favorites.ids?.has(port.id) ? "Remove favorite" : "Add favorite"}
          </span>
        </Button>
      </Tooltip>
    );
  const favoriteToggle = renderFavoriteToggle();
  if (view === "library")
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
          input,
          setupDescriptionId,
          updateAvailable,
          channel,
          dropEligible,
          dropTarget,
          favoriteToggle,
        }}
      />
    );
  return (
    <div className="relative">
      <button
        data-focusable
        data-detail-origin={detailOrigin}
        className={cn(`${className} h-full w-full`, controlFocus)}
        aria-describedby={setup || input ? setupDescriptionId : undefined}
        onClick={() => onSelect(port.id, detailOrigin)}
        data-source-drop-port-id={dropEligible ? port.id : undefined}
        data-source-drop-profile-id={dropEligible ? port.source_profile : undefined}
      >
        {contents}
      </button>
      {favoriteToggle}
    </div>
  );
}

const cardBadgeClass =
  "rounded-full bg-[var(--color-bg-subtle-hover)] px-2 py-1 text-xs text-[var(--color-text-secondary)]";

function LibraryEntry({
  port,
  status,
  state,
  layout,
  detailOrigin,
  onSelect,
  onLaunch,
  input,
  setupDescriptionId,
  updateAvailable,
  channel,
  dropEligible,
  dropTarget,
  favoriteToggle,
}: Pick<PortCardProps, "port" | "status" | "layout" | "onSelect" | "onLaunch"> & {
  state: CardState;
  detailOrigin: string;
  input: ReturnType<typeof installedCardInputPresentation>;
  setupDescriptionId: string;
  updateAvailable: boolean;
  channel: ReturnType<typeof releaseChannelPresentation> | undefined;
  dropEligible: boolean;
  dropTarget: boolean;
  favoriteToggle: ReactNode;
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
        aria-label={`View details for ${gameTitle(port)} Port: ${gameProjectLabel(port) ?? port.name}`}
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
          className="collection-title text-base leading-snug font-semibold wrap-anywhere"
        >
          {gameTitle(port)}
        </span>{" "}
        <span className="collection-project block text-sm leading-normal wrap-anywhere text-[var(--color-text-secondary)]">
          <span>Port: </span>
          {gameProjectLabel(port) ?? port.name}
        </span>
      </button>
      <div className="collection-state flex min-w-0 flex-col items-start gap-1 text-sm leading-normal wrap-anywhere">
        {artworkNotice && <p className="m-0 text-pc-muted-foreground">{artworkNotice}</p>}
        <span
          className={cn(
            `readiness ${state.tone} inline-flex items-start gap-1.5 font-medium`,
            "[&.ready]:text-pc-muted-foreground [&.setup]:text-pc-warning-foreground [&.staged]:text-pc-interactive-foreground",
          )}
        >
          <Icon glyph={state.tone === "ready" ? CheckCircle2 : Wrench} size="sm" />
          {state.label}
        </span>
        {(status?.staged || updateAvailable) && (
          <Button
            variant="link"
            size="sm"
            className="h-auto min-h-6 p-0 text-start text-xs whitespace-normal"
            data-detail-origin={`${detailOrigin}:update`}
            onClick={() => onSelect(port.id, `${detailOrigin}:update`, "updates")}
          >
            {status?.staged ? "Review downloaded update" : "Review update seen at last check"}
          </Button>
        )}
        {status?.staged && updateAvailable && (
          <p className="m-0 mt-1 text-pc-interactive-foreground">
            Another update available at last check
          </p>
        )}
        {channel && channel.tone !== "stable" && (
          <p className="m-0 mt-1 text-pc-muted-foreground">Release channel: {channel.label}</p>
        )}
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
      <PortCardStatus
        port={port}
        status={status}
        state={state}
        layout={layout}
        hasFavorite={false}
        favoriteToggle={favoriteToggle}
        detailOrigin={detailOrigin}
        onSelect={onSelect}
        onLaunch={onLaunch}
        view="library"
        inputDescriptionId={input ? setupDescriptionId : undefined}
      />
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

function PortCardContents({
  port,
  status,
  state,
  setup,
  setupDescriptionId,
  input,
  channel,
  updateAvailable,
  dropEligible,
  dropTarget,
  hasFavorite,
  detailOrigin,
  onSelect,
  onLaunch,
  view,
}: Pick<PortCardProps, "port" | "status" | "onSelect" | "onLaunch" | "view"> & {
  state: CardState;
  setup?: ReturnType<typeof catalogSetupPresentation> | undefined;
  setupDescriptionId: string;
  input?: ReturnType<typeof installedCardInputPresentation> | undefined;
  channel: ReturnType<typeof releaseChannelPresentation> | undefined;
  updateAvailable?: boolean;
  dropEligible: boolean;
  dropTarget: boolean;
  hasFavorite: boolean;
  detailOrigin: string;
}) {
  const renderTitle = () => (
    <div className="flex items-start justify-between gap-2">
      <h2 className="collection-title text-base leading-snug font-semibold wrap-anywhere">
        <span>{gameTitle(port)}</span>
      </h2>
    </div>
  );
  const renderStateLabel = () => (
    <div className="collection-state flex flex-wrap items-center justify-between gap-2">
      <span
        className={cn(
          `readiness ${state.tone} inline-flex min-h-8 items-center gap-[6px] text-xs font-semibold text-[var(--color-text-secondary)]`,
          "[&.ready]:text-pc-muted-foreground [&.setup]:text-[var(--color-warning-text)] [&.staged]:text-[var(--color-interactive-text-strong)]",
        )}
      >
        <i className="size-[6px] rounded-full border border-current bg-current" />
        {state.label}
      </span>
      {port.presentation?.variant_label && (
        <span className="card-variant max-w-full text-xs leading-normal wrap-anywhere text-pc-muted-foreground">
          {port.presentation.variant_label}
        </span>
      )}
      {channel && (
        <span
          className={cn(
            `badge ${channel.tone} ${cardBadgeClass}`,
            "[&.beta]:bg-[var(--color-interactive-subtle)] [&.beta]:text-[var(--color-interactive-text)] [&.retired]:bg-[var(--color-bg-raised)] [&.retired]:text-[var(--color-text-secondary)] [&.rolling]:bg-[var(--color-warning-subtle)] [&.rolling]:text-[var(--color-warning-text)] [&.stable]:bg-[var(--color-success-subtle)] [&.stable]:text-[var(--color-success-text)] [&.update]:bg-[var(--color-highlight)] [&.update]:text-[var(--color-text-on-highlight)]",
          )}
        >
          Release channel: {channel.label}
        </span>
      )}
    </div>
  );
  const stateLabel = renderStateLabel();
  return (
    <>
      {dropEligible && (
        <span
          className="source-drop-target pointer-events-none absolute inset-3 z-1 grid place-items-center rounded-pc-md border-2 border-dashed border-[var(--color-interactive-border)] bg-pc-interactive/90 p-4 text-center text-sm font-bold text-pc-action-foreground"
          aria-hidden="true"
        >
          {dropTarget ? "Release to check" : "Drop to check for this game"}
        </span>
      )}
      <ArtworkImage
        port={port}
        quietFallback
        className="card-art collection-art relative shrink-0 overflow-hidden"
      />
      <div className="card-content flex min-w-0 flex-1 flex-col gap-2 wrap-anywhere">
        {renderTitle()}
        <p
          className="collection-project m-0 min-h-[1.5em] text-sm leading-normal text-pc-muted-foreground"
          title={gameProjectLabel(port) ? port.name : undefined}
        >
          <span>Port: {gameProjectLabel(port) ?? port.name}</span>
        </p>
        {stateLabel}
        {setup && (
          <div id={setupDescriptionId} className="sr-only">
            {setup.routes.map((route) => (
              <p key={route.action} className="m-0 mt-[9px]">
                <strong>{route.route}: </strong>
                {route.reason}
              </p>
            ))}
          </div>
        )}
        {input && (
          <div id={setupDescriptionId} className="sr-only">
            {input.reasons.map((reason) => (
              <p key={reason} className="m-0 mt-[9px]">
                {reason}
              </p>
            ))}
          </div>
        )}
        {(status?.staged || updateAvailable || port.upstream_status === "retired") && (
          <div className="flex min-h-[18px] flex-wrap gap-[5px]">
            {status?.staged && (
              <span
                className={cn(
                  `badge update ${cardBadgeClass}`,
                  "[&.beta]:bg-[var(--color-interactive-subtle)] [&.beta]:text-[var(--color-interactive-text)] [&.retired]:bg-[var(--color-bg-raised)] [&.retired]:text-[var(--color-text-secondary)] [&.rolling]:bg-[var(--color-warning-subtle)] [&.rolling]:text-[var(--color-warning-text)] [&.stable]:bg-[var(--color-success-subtle)] [&.stable]:text-[var(--color-success-text)] [&.update]:bg-[var(--color-highlight)] [&.update]:text-[var(--color-text-on-highlight)]",
                )}
              >
                Update downloaded
              </span>
            )}
            {updateAvailable && (
              <span
                className={cn(
                  `badge update ${cardBadgeClass}`,
                  "[&.beta]:bg-[var(--color-interactive-subtle)] [&.beta]:text-[var(--color-interactive-text)] [&.retired]:bg-[var(--color-bg-raised)] [&.retired]:text-[var(--color-text-secondary)] [&.rolling]:bg-[var(--color-warning-subtle)] [&.rolling]:text-[var(--color-warning-text)] [&.stable]:bg-[var(--color-success-subtle)] [&.stable]:text-[var(--color-success-text)] [&.update]:bg-[var(--color-highlight)] [&.update]:text-[var(--color-text-on-highlight)]",
                )}
              >
                Update available
              </span>
            )}
            {port.upstream_status === "retired" && (
              <span
                className={cn(
                  `badge retired self-start ${cardBadgeClass}`,
                  "[&.beta]:bg-[var(--color-interactive-subtle)] [&.beta]:text-[var(--color-interactive-text)] [&.retired]:bg-[var(--color-bg-raised)] [&.retired]:text-[var(--color-text-secondary)] [&.rolling]:bg-[var(--color-warning-subtle)] [&.rolling]:text-[var(--color-warning-text)] [&.stable]:bg-[var(--color-success-subtle)] [&.stable]:text-[var(--color-success-text)] [&.update]:bg-[var(--color-highlight)] [&.update]:text-[var(--color-text-on-highlight)]",
                )}
              >
                Retired upstream
              </span>
            )}
          </div>
        )}
        {view === "catalog" && (
          <>
            <p className="mt-[9px] mb-[11px] line-clamp-2 min-h-8 text-xs leading-[var(--leading-normal)] text-[var(--color-text-secondary)]">
              {port.summary}
            </p>
            <div className="flex flex-wrap gap-[5px]">
              {port.platforms.map((platform) => (
                <span
                  key={platform}
                  className="rounded-pc-sm bg-[var(--color-bg-subtle-hover)] px-1.5 py-1 text-xs text-[var(--color-text-secondary)]"
                >
                  {platformLabel(platform)}
                </span>
              ))}
            </div>
          </>
        )}
        <PortCardStatus
          inputDescriptionId={input ? setupDescriptionId : undefined}
          {...{ port, status, state, hasFavorite, detailOrigin, onSelect, onLaunch, view }}
        />
      </div>
    </>
  );
}

function PortCardStatus({
  layout,
  favoriteToggle,
  inputDescriptionId,
  port,
  status,
  state,
  hasFavorite,
  detailOrigin,
  onSelect,
  onLaunch,
  view,
}: Pick<PortCardProps, "port" | "status" | "onSelect" | "onLaunch" | "view"> & {
  inputDescriptionId?: string | undefined;
  state: CardState;
  hasFavorite: boolean;
  favoriteToggle?: ReactNode;
  layout?: CollectionLayout;
  detailOrigin: string;
}) {
  const action = presentPortAction(useOperationPresentation(), port.id, status, "launch");
  const canLaunch = Boolean(
    status?.readiness?.launchable === true &&
    status.readiness.blockers.length === 0 &&
    !action.readiness.blocked &&
    onLaunch,
  );
  const overflowOrigin = `library:card-more:${port.id}`;
  const reviewOrigin = `${detailOrigin}:review`;
  return (
    <div
      className={cn(
        `collection-actions flex min-h-11 flex-wrap items-center gap-2 text-xs ${layout === "rows" ? "mt-0 pt-0" : "mt-auto pt-2"} ${view === "library" ? "justify-between" : "justify-between border-t border-pc-border"}`,
        hasFavorite && (view === "library" ? "ps-8" : "pe-9"),
      )}
    >
      {view === "catalog" && (
        <strong className="font-semibold text-[var(--color-text-secondary)]">
          {cardInstallationLabel(port, status)}
        </strong>
      )}
      {view === "library" ? (
        <span className="inline-flex flex-1 flex-wrap items-center justify-end gap-1 text-[var(--color-interactive-text-strong)]">
          {!canLaunch && (
            <Button
              data-focusable
              variant="outline"
              size="sm"
              className="flex-1"
              aria-label={`Review game: ${gameIdentityLabel(port)}`}
              aria-describedby={inputDescriptionId}
              data-detail-origin={reviewOrigin}
              onClick={() => onSelect(port.id, reviewOrigin)}
            >
              Review game
            </Button>
          )}
          {canLaunch && (
            <Button
              data-focusable
              variant="primary"
              size="sm"
              className="flex-1"
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
          {favoriteToggle}
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
              <Menu.Positioner
                side="bottom"
                align="end"
                sideOffset={4}
                className="z-(--layer-floating)"
              >
                <Menu.Popup
                  data-portcove-focus-scope
                  aria-label={`More actions for ${gameIdentityLabel(port)}`}
                  className={cn(
                    floatingMotion,
                    "max-h-(--available-height) min-w-48 origin-(--transform-origin) overflow-y-auto rounded-pc-md border border-pc-border bg-pc-surface p-1 text-pc-foreground shadow-(--shadow-floating)",
                  )}
                >
                  <Menu.Item
                    className={cn(
                      controlFocus,
                      "cursor-default rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection data-highlighted:text-pc-selection-foreground",
                    )}
                    onClick={() => onSelect(port.id, overflowOrigin, "updates")}
                  >
                    Updates and activity
                  </Menu.Item>
                  <Menu.Item
                    className={cn(
                      controlFocus,
                      "cursor-default rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection data-highlighted:text-pc-selection-foreground",
                    )}
                    onClick={() => onSelect(port.id, overflowOrigin, "saves")}
                  >
                    Saves and storage
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-[var(--color-interactive-text-strong)]">
          {state.action}
          <Icon glyph={ArrowRight} size="sm" />
        </span>
      )}
    </div>
  );
}

function filterLabel(filter: Filter) {
  if (filter === "all") return "All";
  if (filter === "ready") return "Ready";
  if (filter === "setup") return "Needs attention";
  return releaseChannelPresentation(filter).label;
}

function readinessPresentation(
  readiness: PortReadiness,
  view: View,
  status?: PortStatus,
  port?: PortDefinition,
) {
  if (
    (status?.active || status?.external_runtime) &&
    portActionPresentation(status, "launch").blocked
  )
    return { label: "Launch needs review", action: "View details", tone: "setup" } as const;
  if ((readiness === "ready" || readiness === "staged") && hasUnconfirmedLaunchInput(status, port))
    return { label: "Compatibility unconfirmed", action: "View details", tone: "setup" } as const;
  if (view === "catalog" && !status?.active && !status?.external_runtime)
    return {
      label: catalogSetupPresentation(status).label,
      action: "View details",
      tone: "available",
    } as const;
  const values = {
    available: {
      label: "Available",
      action: "View details",
      tone: "available",
    },
    ready: { label: "Ready to play", action: "View details", tone: "ready" },
    source: { label: "Game files needed", action: "Finish setup", tone: "setup" },
    repair: {
      label: "Installation needs repair",
      action: "Review game",
      tone: "setup",
    },
    runtime: {
      label: "Runtime required",
      action: "Finish setup",
      tone: "setup",
    },
    bios: { label: "BIOS required", action: "Finish setup", tone: "setup" },
    setup: { label: "Setup required", action: "Finish setup", tone: "setup" },
    staged: { label: "Ready to play", action: "View details", tone: "ready" },
    unknown: {
      label: "Readiness unavailable",
      action: "Review game",
      tone: "setup",
    },
    blocked: {
      label: "Launch unavailable",
      action: "Review game",
      tone: "setup",
    },
  } as const;
  return values[readiness];
}

function cardInstallationLabel(port: PortDefinition, status: PortStatus | undefined) {
  return !status
    ? "Installation status unknown"
    : status.active
      ? `Installed ${status.active.version}`
      : status?.external_runtime
        ? `External installation ${status.external_runtime.version}`
        : port.release.provider === "user-prepared"
          ? "Prepare game"
          : "Not installed";
}
