import { useState, type Dispatch, type SetStateAction } from "react";
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Download,
  Gamepad2,
  LoaderCircle,
  MoreHorizontal,
  Settings2,
  Wrench,
} from "lucide-react";
import type { PortDefinition, PortStatus } from "../types";
import {
  currentUpdateSnapshot,
  filterOptions,
  platformLabel,
  portReadiness,
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
import { ArtworkImage } from "./Artwork";
import { Button } from "./ui/button";
import { Menu } from "@base-ui/react/menu";
import { ChoiceSelect } from "./ChoiceSelect";
import { SteamBatchEntryDialog } from "./SteamEntry";

const catalogSortOptions: readonly { value: CatalogSort; label: string }[] = [
  { value: "catalog", label: "Catalog order" },
  { value: "name", label: "Name A–Z" },
  { value: "installed-first", label: "In library first" },
];

export function PortBrowser({
  view,
  ports,
  statuses,
  overview,
  recent,
  filter,
  query = "",
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
}: {
  view: View;
  ports: PortDefinition[];
  statuses: Map<string, PortStatus>;
  overview: LibraryOverview;
  filter: Filter;
  query?: string;
  catalogSort?: CatalogSort;
  setCatalogSort?: Dispatch<SetStateAction<CatalogSort>>;
  recent?: RecentPort;
  setFilter: Dispatch<SetStateAction<Filter>>;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
  onContinue?: (portId: string) => void;
  onBrowseCatalog?: () => void;
  onConnectGameFiles?: () => void;
  steamBatch?: { ports: PortDefinition[]; generation: number };
  clearFilters?: () => void;
  loading: boolean;
  nativeSourceDrag?: NativeSourceDragState;
}) {
  const firstUseEmpty =
    view === "library" &&
    !loading &&
    !recent &&
    overview.installed === 0 &&
    ports.length === 0 &&
    filter === "all" &&
    query.trim().length === 0;
  return (
    <>
      <p className="sr-only" aria-live="polite">
        {nativeSourceDrag.active
          ? `Game file drop targets are available. ${nativeSourceDrag.pathCount === 1 ? "One path" : `${nativeSourceDrag.pathCount} paths`} selected.`
          : ""}
      </p>
      {view === "library" && recent && onContinue && (
        <ContinueCard recent={recent} launch={onContinue} details={onSelect} />
      )}
      {view === "library" && overview.installed > 0 && <LibrarySummary overview={overview} />}
      {view === "library" && steamBatch && steamBatch.ports.length >= 2 && (
        <SteamBatchLibraryAction {...steamBatch} />
      )}
      {!firstUseEmpty && (
        <div
          className="filter-row"
          data-focus-group
          role="group"
          aria-label={view === "library" ? "Library filters" : "Release channel filters"}
        >
          {filterOptions(view).map((item) => (
            <Button
              data-focusable
              aria-pressed={filter === item}
              key={item}
              variant={filter === item ? "selected" : "outline"}
              size="sm"
              className="capitalize"
              onClick={() => setFilter(item)}
            >
              {filterLabel(item)}
            </Button>
          ))}
          <span>
            {ports.length} {ports.length === 1 ? "port" : "ports"}
          </span>
        </div>
      )}
      {view === "catalog" && setCatalogSort && (
        <div className="mb-4 ml-auto w-52">
          <ChoiceSelect
            label="Sort"
            value={catalogSort}
            options={catalogSortOptions}
            onChange={setCatalogSort}
          />
        </div>
      )}
      <BrowserResults
        view={view}
        ports={ports}
        installedCount={overview.installed}
        constrained={filter !== "all" || query.trim().length > 0}
        statuses={statuses}
        onSelect={onSelect}
        onLaunch={onContinue}
        onBrowseCatalog={onBrowseCatalog}
        onConnectGameFiles={onConnectGameFiles}
        clearFilters={clearFilters}
        loading={loading}
        nativeSourceDrag={nativeSourceDrag}
      />
    </>
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
      <div className="mb-4 flex justify-end">
        <Button data-focusable variant="outline" onClick={() => setOpen(true)}>
          <Icon glyph={Gamepad2} />
          Add selected games to Steam
        </Button>
      </div>
      {open && (
        <SteamBatchEntryDialog ports={ports} generation={generation} close={() => setOpen(false)} />
      )}
    </>
  );
}

function BrowserResults({
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
  view: View;
  ports: PortDefinition[];
  installedCount: number;
  constrained: boolean;
  statuses: Map<string, PortStatus>;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
  onLaunch?: (portId: string) => void;
  onBrowseCatalog?: () => void;
  onConnectGameFiles?: () => void;
  clearFilters?: () => void;
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
    <section className="port-grid" data-focus-group>
      {ports.map((port) => (
        <PortCard
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
      className="loading-state flex min-h-[18.75rem] items-center justify-center gap-4 rounded-pc-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-subtle)] p-10 text-left text-pc-muted-foreground"
      aria-live="polite"
    >
      <div className="grid w-48 shrink-0 justify-items-center gap-1">
        <BrandWordmark className="h-18 w-48" />
        <span className="loading-mark relative grid size-12 place-items-center rounded-pc-lg border border-pc-border bg-pc-surface text-[var(--color-interactive-text)] shadow-[var(--shadow-control)]">
          <BrandMotif />
          <Icon glyph={LoaderCircle} size="lg" />
        </span>
      </div>
      <div>
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
  clearFilters?: () => void;
  onBrowseCatalog?: () => void;
  onConnectGameFiles?: () => void;
}) {
  if (view === "library" && installedCount === 0 && !constrained)
    return (
      <EmptyState
        visual={
          <span className="empty-mascot-stage">
            <BrandMascot decorative />
          </span>
        }
        eyebrow="EMPTY LIBRARY"
        title="Your library is empty"
        description="Browse the catalog to install a supported port or register a prepared runtime. You can also copy an existing supported installation without changing its original folder."
        action={
          <>
            <Button data-focusable variant="primary" size="lg" onClick={onBrowseCatalog}>
              <Icon glyph={Boxes} />
              Browse port catalog
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
  const launchable = status.readiness?.launchable === true;
  return (
    <section
      className="continue-card"
      data-focus-group
      data-successful-launches={status.successful_launches}
      aria-label={`Continue ${port.name}`}
    >
      <ArtworkImage port={port} className="continue-art" />
      <div>
        <p className="eyebrow">CONTINUE</p>
        <h2>{port.name}</h2>
        {(status.active || status.external_runtime) && (
          <p className="continue-meta">
            {status.active
              ? `Version ${status.active.version}`
              : `External version ${status.external_runtime?.version}`}
          </p>
        )}
      </div>
      <div className="continue-actions">
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
          onClick={() =>
            launchable ? launch(port.id) : details(port.id, `library:continue-review:${port.id}`)
          }
        >
          <Icon glyph={Gamepad2} />
          {launchable ? "Play again" : "Review launch"}
        </Button>
      </div>
    </section>
  );
}

function LibrarySummary({ overview }: { overview: LibraryOverview }) {
  return (
    <section className="library-summary" aria-label="Library readiness">
      <strong>{overview.installed} in library</strong>
      <span className="library-summary-status ready">
        <Icon glyph={CheckCircle2} size="sm" />
        {overview.ready === overview.installed
          ? "All ready to play"
          : `${overview.ready} ready to play`}
      </span>
      {overview.needsSetup > 0 && (
        <span className="library-summary-status attention">
          <Icon glyph={Wrench} size="sm" />
          {overview.needsSetup} {overview.needsSetup === 1 ? "needs" : "need"} attention
        </span>
      )}
      {overview.staged > 0 && (
        <span className="library-summary-status update">
          <Icon glyph={Download} size="sm" />
          {overview.staged} {overview.staged === 1 ? "update" : "updates"} downloaded
        </span>
      )}
    </section>
  );
}

type PortCardProps = {
  port: PortDefinition;
  status?: PortStatus;
  readiness: PortReadiness;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
  onLaunch?: (portId: string) => void;
  nativeSourceDrag: NativeSourceDragState;
  view: View;
};

function PortCard({
  port,
  status,
  readiness,
  onSelect,
  onLaunch,
  nativeSourceDrag,
  view,
}: PortCardProps) {
  const state = readinessPresentation(readiness);
  const channel = status?.channel ? releaseChannelPresentation(status.channel) : undefined;
  const updateAvailable = currentUpdateSnapshot(status)?.check.update_available;
  const dropEligible = nativeSourceDrag.active && Boolean(port.source_profile);
  const dropTarget = dropEligible && nativeSourceDrag.targetPortId === port.id;
  const detailOrigin = `${view}:card:${port.id}`;
  const className = `port-card ${view === "catalog" ? "port-card-selectable" : "port-card-library"}${dropEligible ? " source-drop-eligible" : ""}${dropTarget ? " source-drop-targeted" : ""}`;
  const contents = (
    <PortCardContents
      {...{ port, status, state, channel, updateAvailable, dropEligible, dropTarget }}
      detailOrigin={detailOrigin}
      onSelect={onSelect}
      onLaunch={onLaunch}
      view={view}
    />
  );
  if (view === "library")
    return (
      <article
        className={className}
        aria-label={`${port.name}. ${state.label}. ${state.action}.`}
        data-source-drop-port-id={dropEligible ? port.id : undefined}
        data-source-drop-profile-id={dropEligible ? port.source_profile : undefined}
      >
        {contents}
      </article>
    );
  return (
    <button
      data-focusable
      data-detail-origin={detailOrigin}
      className={className}
      aria-label={`${port.name}. ${state.label}. ${state.action}.`}
      onClick={() => onSelect(port.id, detailOrigin)}
      data-source-drop-port-id={dropEligible ? port.id : undefined}
      data-source-drop-profile-id={dropEligible ? port.source_profile : undefined}
    >
      {contents}
    </button>
  );
}

function PortCardContents({
  port,
  status,
  state,
  channel,
  updateAvailable,
  dropEligible,
  dropTarget,
  detailOrigin,
  onSelect,
  onLaunch,
  view,
}: Pick<PortCardProps, "port" | "status" | "onSelect" | "onLaunch" | "view"> & {
  state: ReturnType<typeof readinessPresentation>;
  channel: ReturnType<typeof releaseChannelPresentation> | undefined;
  updateAvailable?: boolean;
  dropEligible: boolean;
  dropTarget: boolean;
  detailOrigin: string;
}) {
  const title = (
    <div className="card-title">
      <h2>{port.name}</h2>
    </div>
  );
  const stateLabel = (
    <div className="card-kicker">
      <span className={`readiness ${state.tone}`}>
        <i />
        {state.label}
      </span>
      {view === "catalog" && channel && (
        <span className={`badge ${channel.tone}`}>{channel.label}</span>
      )}
    </div>
  );
  return (
    <>
      {dropEligible && (
        <span className="source-drop-target" aria-hidden="true">
          {dropTarget ? "Release to check" : "Drop to check for this game"}
        </span>
      )}
      <ArtworkImage port={port} className="card-art" />
      <div className="card-content">
        {view === "library" ? (
          <>
            {title}
            {stateLabel}
          </>
        ) : (
          <>
            {stateLabel}
            {title}
          </>
        )}
        {view === "library" && channel && (
          <small className="card-secondary">Release channel: {channel.label}</small>
        )}
        {(updateAvailable || port.upstream_status === "retired") && (
          <div className="card-flags">
            {updateAvailable && <span className="badge update">Update available</span>}
            {port.upstream_status === "retired" && (
              <span className="badge retired">Retired upstream</span>
            )}
          </div>
        )}
        {view === "catalog" && (
          <>
            <p>{port.summary}</p>
            <div className="platforms">
              {port.platforms.map((platform) => (
                <span key={platform}>{platformLabel(platform)}</span>
              ))}
            </div>
          </>
        )}
        <PortCardStatus {...{ port, status, state, detailOrigin, onSelect, onLaunch, view }} />
      </div>
    </>
  );
}

function PortCardStatus({
  port,
  status,
  state,
  detailOrigin,
  onSelect,
  onLaunch,
  view,
}: Pick<PortCardProps, "port" | "status" | "onSelect" | "onLaunch" | "view"> & {
  state: ReturnType<typeof readinessPresentation>;
  detailOrigin: string;
}) {
  const overflowOrigin = `library:card-more:${port.id}`;
  return (
    <div className="card-status">
      {view === "catalog" && (
        <strong>
          {status?.active
            ? status.active.version
            : status?.external_runtime
              ? `External ${status.external_runtime.version}`
              : port.release.provider === "user-prepared"
                ? "Prepare runtime"
                : "Not installed"}
        </strong>
      )}
      {view === "library" ? (
        <span className="card-actions">
          <Button
            data-focusable
            variant="outline"
            size="sm"
            aria-label={`View details for ${port.name}`}
            data-detail-origin={detailOrigin}
            onClick={() => onSelect(port.id, detailOrigin)}
          >
            Details
          </Button>
          {status?.readiness?.launchable === true && onLaunch && (
            <Button data-focusable variant="primary" size="sm" onClick={() => onLaunch(port.id)}>
              <Icon glyph={Gamepad2} size="sm" />
              Play
            </Button>
          )}
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  data-focusable
                  data-detail-origin={overflowOrigin}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More actions for ${port.name}`}
                >
                  <Icon glyph={MoreHorizontal} size="sm" />
                </Button>
              }
            />
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="end" sideOffset={4} className="isolate z-50">
                <Menu.Popup
                  data-portcove-focus-scope
                  aria-label={`More actions for ${port.name}`}
                  className="min-w-48 rounded-lg bg-pc-surface p-1 text-pc-foreground shadow-md ring-1 ring-pc-foreground/10"
                >
                  <Menu.Item
                    className="cursor-default rounded-md px-3 py-2 text-sm outline-none focus:bg-pc-accent focus:text-pc-accent-foreground"
                    onClick={() => onSelect(port.id, overflowOrigin, "updates")}
                  >
                    Updates and activity
                  </Menu.Item>
                  <Menu.Item
                    className="cursor-default rounded-md px-3 py-2 text-sm outline-none focus:bg-pc-accent focus:text-pc-accent-foreground"
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
        <span>
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
  return filter;
}

function readinessPresentation(readiness: PortReadiness) {
  const values = {
    available: {
      label: "Available",
      action: "View details",
      tone: "available",
    },
    ready: { label: "Ready to play", action: "View details", tone: "ready" },
    source: { label: "Source required", action: "Finish setup", tone: "setup" },
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
    staged: { label: "Update downloaded", action: "Review update", tone: "staged" },
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
