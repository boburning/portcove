import type { Dispatch, SetStateAction } from "react";
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Download,
  Gamepad2,
  LoaderCircle,
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

export function PortBrowser({
  view,
  ports,
  statuses,
  overview,
  recent,
  filter,
  setFilter,
  onSelect,
  onContinue,
  onBrowseCatalog,
  clearFilters,
  loading,
  nativeSourceDrag = { active: false, pathCount: 0 },
}: {
  view: View;
  ports: PortDefinition[];
  statuses: Map<string, PortStatus>;
  overview: LibraryOverview;
  filter: Filter;
  recent?: RecentPort;
  setFilter: Dispatch<SetStateAction<Filter>>;
  onSelect: (portId: string, originKey?: string) => void;
  onContinue?: (portId: string) => void;
  onBrowseCatalog?: () => void;
  clearFilters?: () => void;
  loading: boolean;
  nativeSourceDrag?: NativeSourceDragState;
}) {
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
      {view === "library" && <LibrarySummary overview={overview} />}
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
      <BrowserResults
        view={view}
        ports={ports}
        installedCount={overview.installed}
        statuses={statuses}
        onSelect={onSelect}
        onLaunch={onContinue}
        onBrowseCatalog={onBrowseCatalog}
        clearFilters={clearFilters}
        loading={loading}
        nativeSourceDrag={nativeSourceDrag}
      />
    </>
  );
}

function BrowserResults({
  view,
  ports,
  installedCount,
  statuses,
  onSelect,
  onLaunch,
  onBrowseCatalog,
  clearFilters,
  loading,
  nativeSourceDrag,
}: {
  view: View;
  ports: PortDefinition[];
  installedCount: number;
  statuses: Map<string, PortStatus>;
  onSelect: (portId: string, originKey?: string) => void;
  onLaunch?: (portId: string) => void;
  onBrowseCatalog?: () => void;
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
        clearFilters={clearFilters}
        onBrowseCatalog={onBrowseCatalog}
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
    <section className="loading-state" aria-live="polite">
      <div className="loading-brand">
        <BrandWordmark />
        <span className="loading-mark">
          <BrandMotif />
          <Icon glyph={LoaderCircle} size="lg" />
        </span>
      </div>
      <div>
        <strong>Loading your port library</strong>
        <p>Loading the catalog, added game files, and installed ports from this device.</p>
      </div>
    </section>
  );
}

function BrowserEmptyState({
  view,
  installedCount,
  clearFilters,
  onBrowseCatalog,
}: {
  view: View;
  installedCount: number;
  clearFilters?: () => void;
  onBrowseCatalog?: () => void;
}) {
  if (view === "library" && installedCount === 0)
    return (
      <EmptyState
        visual={
          <span className="empty-mascot-stage">
            <BrandMascot decorative />
          </span>
        }
        eyebrow="EMPTY LIBRARY"
        title="No installed ports yet"
        description="Browse the catalog to install a supported port, or copy an existing supported installation without changing the original folder."
        action={
          <>
            <Button data-focusable variant="primary" size="lg" onClick={onBrowseCatalog}>
              <Icon glyph={Boxes} />
              Browse port catalog
            </Button>
          </>
        }
      />
    );
  if (view === "library")
    return (
      <EmptyState
        icon={Settings2}
        eyebrow="NO MATCHES"
        title="No installed ports match your search and filters"
        description="Your installed ports are still in this library. Clear the current search and readiness filters to show them again."
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
      description="Try another title, platform term, or release channel. The catalog itself has not been changed."
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
    <section className="continue-card" data-focus-group aria-label={`Continue ${port.name}`}>
      <ArtworkImage port={port} className="continue-art" />
      <div>
        <p className="eyebrow">CONTINUE</p>
        <h2>{port.name}</h2>
        <p className="continue-meta">Last played · {status.active?.version}</p>
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
      <div>
        <span className="summary-icon ready">
          <Icon glyph={CheckCircle2} />
        </span>
        <p>
          <strong className="summary-value">{overview.ready}</strong>
          <small>Ready to play</small>
        </p>
      </div>
      <div>
        <span className="summary-icon setup">
          <Icon glyph={Wrench} />
        </span>
        <p>
          <strong className="summary-value">{overview.needsSetup}</strong>
          <small>Need attention</small>
        </p>
      </div>
      <div>
        <span className="summary-icon staged">
          <Icon glyph={Download} />
        </span>
        <p>
          <strong className="summary-value">{overview.staged}</strong>
          <small>Updates downloaded</small>
        </p>
      </div>
      <p className="summary-note">
        <strong>{overview.installed} installed</strong>
        <span>View a game's details for setup and recovery options.</span>
      </p>
    </section>
  );
}

type PortCardProps = {
  port: PortDefinition;
  status?: PortStatus;
  readiness: PortReadiness;
  onSelect: (portId: string, originKey?: string) => void;
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
  return (
    <div className="card-status">
      {view === "catalog" && (
        <strong>{status?.active ? status.active.version : "Not installed"}</strong>
      )}
      {view === "library" ? (
        <span className="card-actions">
          <Button
            data-focusable
            variant="outline"
            size="sm"
            data-detail-origin={detailOrigin}
            onClick={() => onSelect(port.id, detailOrigin)}
          >
            View details
          </Button>
          {status?.readiness?.launchable === true && onLaunch && (
            <Button data-focusable variant="primary" size="sm" onClick={() => onLaunch(port.id)}>
              <Icon glyph={Gamepad2} size="sm" />
              Play
            </Button>
          )}
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
