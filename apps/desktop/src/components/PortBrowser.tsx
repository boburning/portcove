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
  onSelect: (portId: string) => void;
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
          <button
            data-focusable
            aria-pressed={filter === item}
            key={item}
            className={filter === item ? "filter active" : "filter"}
            onClick={() => setFilter(item)}
          >
            {filterLabel(item)}
          </button>
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
  onBrowseCatalog,
  clearFilters,
  loading,
  nativeSourceDrag,
}: {
  view: View;
  ports: PortDefinition[];
  installedCount: number;
  statuses: Map<string, PortStatus>;
  onSelect: (portId: string) => void;
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
          nativeSourceDrag={nativeSourceDrag}
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
        <p>Reading the shared local catalog, sources, and install state.</p>
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
        description="Browse the catalog to install a supported port, or adopt an existing native installation without changing the original folder."
        action={
          <>
            <button data-focusable className="primary button-with-icon" onClick={onBrowseCatalog}>
              <Icon glyph={Boxes} />
              Browse port catalog
            </button>
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
          <button data-focusable className="button-with-icon" onClick={clearFilters}>
            <Icon glyph={Settings2} />
            Clear search and filters
          </button>
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
        <button data-focusable className="button-with-icon" onClick={clearFilters}>
          <Icon glyph={Settings2} />
          Clear search and filters
        </button>
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
  details: (portId: string) => void;
}) {
  const { port, status } = recent;
  const launchable = status.readiness?.launchable === true;
  return (
    <section className="continue-card" data-focus-group aria-label={`Continue ${port.name}`}>
      <ArtworkImage port={port} className={`continue-art art-${port.support_tier}`} />
      <div>
        <p className="eyebrow">CONTINUE</p>
        <h2>{port.name}</h2>
        <p className="continue-meta">Last successful session · {status.active?.version}</p>
      </div>
      <div className="continue-actions">
        <button data-focusable onClick={() => details(port.id)}>
          View details
        </button>
        <button
          data-focusable
          className="primary button-with-icon"
          onClick={() => (launchable ? launch(port.id) : details(port.id))}
        >
          <Icon glyph={Gamepad2} />
          {launchable ? "Play again" : "Review launch"}
        </button>
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
          <small>Launch ready</small>
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
          <small>Staged updates</small>
        </p>
      </div>
      <p className="summary-note">
        <strong>{overview.installed} installed</strong>
        <span>View a game's details for setup and recovery options.</span>
      </p>
    </section>
  );
}

function PortCard({
  port,
  status,
  readiness,
  onSelect,
  nativeSourceDrag,
}: {
  port: PortDefinition;
  status?: PortStatus;
  readiness: PortReadiness;
  onSelect: (portId: string) => void;
  nativeSourceDrag: NativeSourceDragState;
}) {
  const state = readinessPresentation(readiness);
  const channel = releaseChannelPresentation(status?.channel ?? port.support_tier);
  const updateAvailable = currentUpdateSnapshot(status)?.check.update_available;
  const color =
    port.id.split("").reduce((total, character) => total + character.charCodeAt(0), 0) % 6;
  const dropEligible = nativeSourceDrag.active && Boolean(port.source_profile);
  const dropTarget = dropEligible && nativeSourceDrag.targetPortId === port.id;
  return (
    <button
      data-focusable
      className={`port-card${dropEligible ? " source-drop-eligible" : ""}${dropTarget ? " source-drop-targeted" : ""}`}
      aria-label={`${port.name}. ${state.label}. ${state.action}.`}
      onClick={() => onSelect(port.id)}
      data-source-drop-port-id={dropEligible ? port.id : undefined}
      data-source-drop-profile-id={dropEligible ? port.source_profile : undefined}
    >
      {dropEligible && (
        <span className="source-drop-target" aria-hidden="true">
          {dropTarget ? "Release to check" : "Drop to check for this game"}
        </span>
      )}
      <ArtworkImage port={port} className={`card-art palette-${color}`} />
      <div className="card-content">
        <div className="card-kicker">
          <span className={`readiness ${state.tone}`}>
            <i />
            {state.label}
          </span>
          <span className={`badge ${channel.tone}`}>{channel.label}</span>
        </div>
        <div className="card-title">
          <h2>{port.name}</h2>
        </div>
        <div className="card-flags">
          {updateAvailable && <span className="badge update">Update available</span>}
          {port.upstream_status === "retired" && (
            <span className="badge retired">Retired upstream</span>
          )}
        </div>
        <p>{port.summary}</p>
        <div className="platforms">
          {port.platforms.map((platform) => (
            <span key={platform}>{platformLabel(platform)}</span>
          ))}
        </div>
        <div className="card-status">
          <strong>{status?.active ? status.active.version : "Not installed"}</strong>
          <span>
            {state.action}
            <Icon glyph={ArrowRight} size="sm" />
          </span>
        </div>
      </div>
    </button>
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
    ready: { label: "Launch ready", action: "Play options", tone: "ready" },
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
    staged: { label: "Update staged", action: "Review update", tone: "staged" },
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
