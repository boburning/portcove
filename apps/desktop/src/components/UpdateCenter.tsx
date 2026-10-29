import { ArtworkImage } from "./Artwork";
import { FailureDetails } from "./FailureDetails";
import { ActivityDiagnostic } from "./ActivityDiagnostic";
import { RecoveryReview } from "./RecoveryReview";
import { GameUpdateControl } from "./GameUpdates";
import { gameUpdateAcquisitionLabel } from "../features/port-updates/acquisition-presentation";
import type { Perform } from "../features/operations/use-operation-state";
import type { CatalogEntry } from "../features/browsing/catalog-entry";
import { focusAndReveal } from "../focus";
import { gameIdentityLabel, gameTitle, gameProjectLabel } from "../port-identity";
import { controlFocus } from "./ui/control-style";
import { cn } from "cn";
import { Tabs } from "@base-ui/react/tabs";
import type { DetailDestination } from "../view-model";
import {
  activityHistoryPreview,
  activityPresentationState,
  currentUpdateSnapshot,
  hasUnconfirmedLaunchInput,
  errorText,
  failurePresentation,
  releaseChannelPresentation,
} from "../view-model";
import { OperationCancellation } from "./OperationCancellation";
import { OperationProgress } from "./OperationProgress";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Check,
  CircleMinus,
  Download,
  History,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type {
  ActivityFeed,
  ActivityOperation,
  ActivityRecord,
  OperationEvent,
  DoctorReport,
  PortDefinition,
  PortStatus,
  SourceProfile,
  UpdateCheck,
  UpdateCheckOutcome,
} from "../types";
import { EmptyState, Icon } from "./ui";
import { Button } from "./ui/button";
import { CurrentStateSummary } from "./ui/patterns";
import { useEffect, useId, useRef, useState } from "react";
import type { UpdateBatchRead } from "../features/port-updates/use-update-center";
import type { ActivitySettingsTarget } from "../features/app-shell/focus-settings-target";
import {
  presentPortAction,
  useOperationPresentation,
} from "../features/operations/operation-presentation";

const initialActivityNowSeconds = Date.now() / 1000;
const activityTargetButton =
  "-mx-1 h-auto min-h-6 min-w-0 max-w-full shrink justify-start px-1 py-0 text-start text-sm font-semibold whitespace-normal wrap-anywhere text-pc-foreground no-underline hover:text-pc-interactive-foreground hover:no-underline";
const activityDetailsClass =
  "activity-details mt-[calc(var(--space-1)_*_-1)] col-[2/-1] min-w-0 text-xs";
const activityTones: Record<string, { indicator: string; status: string }> = {
  succeeded: {
    indicator: "bg-pc-success-subtle text-pc-success-foreground",
    status: "text-pc-success-foreground",
  },
  failed: {
    indicator: "bg-pc-danger-subtle text-pc-danger-foreground",
    status: "text-pc-danger-foreground",
  },
  running: {
    indicator: "bg-pc-selection text-pc-interactive-foreground motion-safe:[&_.icon]:animate-spin",
    status: "text-pc-interactive-foreground",
  },
  unfinished: {
    indicator: "bg-pc-warning-subtle text-pc-warning-foreground",
    status: "text-pc-warning-foreground",
  },
};
type UpdateTone = "available" | "current" | "failed" | "muted" | "staged";
const updateStateTones: Record<UpdateTone, string> = {
  available: "bg-pc-warning-subtle text-pc-warning-foreground",
  current: "bg-pc-success-subtle text-pc-success-foreground",
  failed: "bg-pc-danger-subtle text-pc-danger-foreground",
  muted: "bg-[var(--color-bg-subtle-hover)] text-[var(--color-text-secondary)]",
  staged: "bg-[var(--color-interactive-subtle)] text-pc-interactive-foreground",
};
const updateRowClass =
  "update-row w-full min-w-0 cursor-pointer text-start text-pc-foreground transition-colors hover:bg-pc-secondary active:bg-pc-surface-muted";
const updateStateClass =
  "min-w-0 justify-self-end rounded-pc-md px-2 py-1 text-xs leading-snug font-medium [overflow-wrap:anywhere]";
const libraryActivitySettingsTargets: Partial<
  Record<
    ActivityOperation,
    Exclude<ActivitySettingsTarget, "source-profile" | "library-storage" | "application-updates">
  >
> = {
  discover_sources: "discover-sources",
  move_library: "move-library",
  import_library: "import-library",
  update_catalog: "catalog-updates",
};

function useUpdateCenter({
  ports,
  activityPorts = ports,
  sourceProfiles = [],
  statuses,
  activities,
  activityFeed,
  outcomes,
  batchRead,
  busy,
  checkAll,
  onSelect,
  onOpenSettings,
  generation,
  repair,
  diagnosticsRefreshing,
  diagnosticsStale,
  diagnosticFailure,
  refreshDiagnostics,
  cleanupChanged = refreshDiagnostics,
  reviewedActivityId,
  onReviewActivity,
  perform,
  onLaunch,
  section,
  onSectionChange,
  operationEvents,
}: {
  operationEvents?: ReadonlyMap<string, OperationEvent> | undefined;
  generation: number;
  section?: "tasks" | "updates" | "history";
  onSectionChange?: (section: "tasks" | "updates" | "history") => void;
  repair?: DoctorReport["repair"] | undefined;
  diagnosticsRefreshing: boolean;
  diagnosticsStale: boolean;
  diagnosticFailure?: unknown;
  refreshDiagnostics: () => Promise<unknown>;
  cleanupChanged?: () => Promise<unknown>;
  reviewedActivityId?: string | undefined;
  onReviewActivity?: (activityId: string) => void;
  perform?: Perform | undefined;
  onLaunch?: ((portId: string) => void) | undefined;
  ports: PortDefinition[];
  activityPorts?: readonly CatalogEntry[];
  sourceProfiles?: SourceProfile[];
  statuses: Map<string, PortStatus>;
  activities: ActivityRecord[];
  activityFeed?: ActivityFeed | undefined;
  outcomes: UpdateCheckOutcome[];
  batchRead?: UpdateBatchRead;
  busy?: string | undefined;
  checkAll: () => void | Promise<void>;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
  onOpenSettings: (target: ActivitySettingsTarget, sourceProfileId?: string) => void;
}) {
  const operationOwner = useOperationPresentation();
  const [localSection, setLocalSection] = useState<"tasks" | "updates" | "history">("tasks");
  const selectedSection = section ?? localSection;
  const earlierBatch =
    batchRead !== undefined && ["pending", "failed", "cancelled"].includes(batchRead.status);
  const [nowSeconds, setNowSeconds] = useState(initialActivityNowSeconds);
  const [reviewedActivity, setReviewedActivity] = useState<{ id: string; request: number }>();
  const [reviewingUpdate, setReviewingUpdate] = useState<string>();
  const updateReviewOwner = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!reviewedActivity) return;
    const frame = window.requestAnimationFrame(() => {
      const row = [...document.querySelectorAll<HTMLElement>("[data-activity-id]")].find(
        (element) => element.dataset.activityId === reviewedActivity.id,
      );
      if (row) focusAndReveal(row);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reviewedActivity]);
  useEffect(() => {
    const refreshNow = () => setNowSeconds(Date.now() / 1000);
    refreshNow();
    const interval = window.setInterval(refreshNow, 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const installed = ports.filter((port) => statuses.get(port.id)?.active);
  const managedUpdateIds = new Set(installed.map((port) => port.id));
  // Core projects retained acquisition statuses independently of catalog or
  // active-runtime membership. Do not require a synthetic operational definition.
  const retainedArchives = [...statuses.values()].filter(
    (status) => status.acquisition && !managedUpdateIds.has(status.port_id),
  );
  const external = ports.filter((port) => {
    const status = statuses.get(port.id);
    return !status?.active && status?.external_runtime;
  });
  const byPort = new Map(outcomes.map((outcome) => [outcome.port_id, outcome]));
  const savedByPort = new Map(
    installed.map((port) => {
      const snapshot = currentUpdateSnapshot(statuses.get(port.id));
      return [port.id, snapshot?.check.port_id === port.id ? snapshot : undefined] as const;
    }),
  );
  const effectiveCheck = (portId: string) => {
    const outcome = byPort.get(portId);
    return outcome ? (outcome.ok ? outcome.result : null) : savedByPort.get(portId)?.check;
  };
  const checked = installed.filter((port) => {
    return effectiveCheck(port.id)?.port_id === port.id;
  });
  const available = checked.filter((port) => effectiveCheck(port.id)?.update_available).length;
  const complete = installed.length > 0 && checked.length === installed.length;
  const latestSavedCheck = Math.max(
    0,
    ...installed.map((port) => savedByPort.get(port.id)?.checked_at ?? 0),
  );
  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  const failedInstalled = installed.filter((port) => byPort.get(port.id)?.ok === false).length;
  const staged = installed.filter((port) => statuses.get(port.id)?.staged).length;
  const renderStatistics = () => (
    <div className="update-stats grid grid-cols-[repeat(4,minmax(78px,1fr))] gap-2">
      <UpdateStat label="Installed" value={installed.length} icon={PackageCheck} />
      <UpdateStat
        label={earlierBatch ? "Updates at last check" : "Updates available"}
        value={
          installed.length === 0
            ? "—"
            : complete
              ? available
              : available > 0
                ? `${available}+`
                : "Unknown"
        }
        icon={Download}
        accent={available > 0}
      />
      <UpdateStat label="Prepared updates" value={staged} icon={ShieldCheck} accent={staged > 0} />
      <UpdateStat
        label={earlierBatch ? "Failed at last check" : "Failed"}
        value={earlierBatch && !batchRead?.hasResults ? "Unknown" : failed}
        icon={AlertTriangle}
        warning={failed > 0}
      />
    </div>
  );
  return {
    ports,
    activityPorts,
    sourceProfiles,
    statuses,
    activities,
    activityFeed,
    batchRead,
    busy,
    checkAll,
    onSelect,
    onOpenSettings,
    generation,
    repair,
    diagnosticsRefreshing,
    diagnosticsStale,
    diagnosticFailure,
    refreshDiagnostics,
    cleanupChanged,
    reviewedActivityId,
    onReviewActivity,
    perform,
    onLaunch,
    onSectionChange,
    operationEvents,
    operationOwner,
    setLocalSection,
    selectedSection,
    earlierBatch,
    nowSeconds,
    reviewedActivity,
    setReviewedActivity,
    reviewingUpdate,
    setReviewingUpdate,
    updateReviewOwner,
    installed,
    retainedArchives,
    external,
    byPort,
    savedByPort,
    effectiveCheck,
    checked,
    available,
    complete,
    failed,
    failedInstalled,
    latestSavedCheck,
    renderStatistics,
  };
}

export function UpdateCenter(props: Parameters<typeof useUpdateCenter>[0]) {
  return <UpdateCenterView {...useUpdateCenter(props)} />;
}

function UpdateCenterView(model: ReturnType<typeof useUpdateCenter>) {
  return (
    <Tabs.Root
      render={<section className="update-center" data-activity-section={model.selectedSection} />}
      value={model.selectedSection}
      onValueChange={(value: unknown) => {
        if (value !== "tasks" && value !== "updates" && value !== "history") return;
        model.setLocalSection(value);
        model.onSectionChange?.(value);
      }}
    >
      <Tabs.List aria-label="Activity sections" className="activity-tabs">
        {(
          [
            ["tasks", "Tasks"],
            ["updates", "Game updates"],
            ["history", "History"],
          ] as const
        ).map(([value, label]) => (
          <Tabs.Tab
            key={value}
            value={value}
            data-focusable
            render={<Button variant="ghost" className="activity-tab" />}
          >
            {label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      <Tabs.Panel value="updates" keepMounted aria-label="Game updates">
        <h2 className="mb-5 text-lg">Game updates</h2>
        <div
          className="update-toolbar mb-3.5 flex flex-wrap items-stretch justify-between gap-5 max-[75rem]:flex-col max-[75rem]:items-start"
          data-focus-group
        >
          <CurrentStateSummary
            title={
              model.installed.length === 0
                ? "No managed installations to check"
                : model.failedInstalled > 0
                  ? "Some update checks failed"
                  : model.checked.length === 0
                    ? "Updates not checked"
                    : `${model.available}${model.complete ? "" : "+"} updates available${model.earlierBatch ? " at last check" : ""}`
            }
          >
            <p className="text-sm text-pc-muted-foreground">
              {model.checked.length} of {model.installed.length} installed ports have a check
              result. Unchecked or failed ports may still have updates.
            </p>
          </CurrentStateSummary>
          <UpdateCheckControl
            busy={model.busy}
            status={model.batchRead?.status}
            hasInstalled={model.installed.length > 0}
            checkAll={model.checkAll}
          />
        </div>
        <UpdateBatchNotice read={model.batchRead} />
        <details className="mb-4">
          <summary className="cursor-pointer py-2 text-sm">Update statistics</summary>
          {model.renderStatistics()}
        </details>
        <p className="update-explainer mb-4 text-xs leading-[var(--leading-comfortable)] text-pc-muted-foreground">
          Checking does not install. Review an update before downloading or installing; Play uses
          your current version.
        </p>
        <p className="update-explainer mb-4 text-xs leading-[var(--leading-comfortable)] text-pc-muted-foreground">
          Looking for Portcove or catalog updates?{" "}
          <Button
            data-focusable
            variant="link"
            size="xs"
            onClick={() => model.onOpenSettings("application-updates")}
          >
            Open Portcove update settings
          </Button>
        </p>
        {model.installed.length > 0 && (
          <p className="update-explainer mb-4 text-xs leading-[var(--leading-comfortable)] text-pc-muted-foreground">
            {model.earlierBatch ? "Earlier update results cover " : "Update results cover "}
            {model.checked.length} of {model.installed.length} installed{" "}
            {model.installed.length === 1 ? "port" : "ports"}.
            {model.latestSavedCheck > 0 &&
              ` Latest saved check: ${formatActivityTime(model.latestSavedCheck)}.`}
          </p>
        )}
        {model.installed.length === 0 && model.retainedArchives.length > 0 ? (
          <p className="mb-5 text-sm text-pc-muted-foreground">
            No managed installations can be updated here. Retained archives can still be reviewed
            and discarded below.
          </p>
        ) : model.installed.length === 0 ? (
          <EmptyState
            icon={RefreshCw}
            eyebrow="UPDATE CENTER"
            title="No managed installations to check"
            description={
              model.external.length > 0
                ? "Registered runtimes are updated externally. Install a managed port or copy in an existing installation to check it for updates here."
                : "Install a port or copy in an existing installation first. Portcove will then show its update channel, update setting, latest available release, and previous installed version here."
            }
          />
        ) : (
          <div className="update-list grid max-w-5xl gap-3" data-focus-group>
            {model.installed.map((port) => {
              const status = model.statuses.get(port.id)!;
              const action = presentPortAction(
                model.operationOwner,
                port.id,
                status,
                "launch",
                model.busy,
              );
              const outcome = model.byPort.get(port.id);
              const savedCheck = model.savedByPort.get(port.id)?.check;
              const state = updateState(status, outcome, savedCheck, model.earlierBatch);
              const failure = failurePresentation(outcome?.error);
              const canReviewUpdate = Boolean(
                (status.staged ||
                  status.acquisition ||
                  model.effectiveCheck(port.id)?.update_available) &&
                model.perform,
              );
              const canLaunch = Boolean(
                model.onLaunch &&
                status.readiness?.launchable &&
                !status.readiness.pending_setup &&
                status.readiness.blockers.length === 0 &&
                !action.readiness.blocked,
              );
              const renderActions = () =>
                (canReviewUpdate || canLaunch) && (
                  <div
                    className="flex flex-wrap items-center gap-2"
                    role="group"
                    aria-label={`Actions for ${gameIdentityLabel(port)}`}
                  >
                    {canReviewUpdate && (
                      <GameUpdateControl
                        key={JSON.stringify([
                          model.generation,
                          port.id,
                          status.active?.id,
                          status.active?.version,
                          status.active?.artifact.sha256,
                          status.staged?.id,
                          status.channel,
                        ])}
                        portId={port.id}
                        generation={model.generation}
                        policy={status.update_policy}
                        busy={Boolean(action.busy)}
                        perform={model.perform}
                        compact
                        gameName={gameIdentityLabel(port)}
                        currentVersion={status.active?.version}
                        status={status}
                        reviewScope={{
                          active: model.reviewingUpdate === port.id,
                          claim: () => {
                            model.updateReviewOwner.current = port.id;
                            model.setReviewingUpdate(port.id);
                          },
                          current: () => model.updateReviewOwner.current === port.id,
                        }}
                      />
                    )}
                    {canLaunch && (
                      <Button
                        data-focusable
                        variant="outline"
                        disabled={Boolean(action.busy)}
                        focusableWhenDisabled={Boolean(action.busy)}
                        aria-busy={Boolean(action.busy)}
                        title={action.assessment.reason}
                        onClick={() => model.onLaunch?.(port.id)}
                      >
                        {hasUnconfirmedLaunchInput(status, port) ? "Try launch" : "Play"}
                      </Button>
                    )}
                  </div>
                );
              return (
                <div
                  key={port.id}
                  className="update-entry @container/update-entry grid min-w-0 gap-3 rounded-pc-lg border border-pc-border bg-pc-surface p-3"
                >
                  <button
                    data-focusable
                    data-detail-origin={`updates:installed:${port.id}`}
                    className={cn(updateRowClass, "border-0 bg-transparent p-0 shadow-none")}
                    onClick={() => model.onSelect(port.id, `updates:installed:${port.id}`)}
                  >
                    <ArtworkImage port={port} quietFallback className="update-artwork" />
                    <div className="update-title min-w-0">
                      <strong className="block text-sm">{gameTitle(port)}</strong>
                      <small className="block text-xs text-pc-muted-foreground">
                        {gameProjectLabel(port)}
                      </small>
                      <small className="mt-1 block text-xs text-[var(--color-text-secondary)] capitalize">
                        {releaseChannelPresentation(status.channel).label} ·{" "}
                        {policyLabel(status.update_policy)}
                      </small>
                    </div>
                    <div className="update-versions min-w-0 text-sm [overflow-wrap:anywhere] text-pc-muted-foreground">
                      <span className="sr-only">Installed version: </span>
                      {status.active?.version || "Unavailable"}
                      {status.active?.version &&
                        model.effectiveCheck(port.id)?.update_available &&
                        model.effectiveCheck(port.id)?.release?.version && (
                          <>
                            <span aria-hidden> → </span>
                            <span className="sr-only">; offered version: </span>
                            {model.effectiveCheck(port.id)?.release?.version}
                          </>
                        )}
                    </div>
                    <span className={`${updateStateClass} ${updateStateTones[state.tone]}`}>
                      {state.label}
                    </span>
                  </button>
                  {renderActions()}
                  <details className="col-span-full text-xs text-pc-muted-foreground">
                    <summary className="cursor-pointer py-1">Update details</summary>
                    <p>
                      Latest eligible{model.earlierBatch ? " at last check" : ""}:{" "}
                      {releaseLabel(model.effectiveCheck(port.id), outcome)}
                    </p>
                    <p>
                      {releaseChannelPresentation(status.channel).label} ·{" "}
                      {policyLabel(status.update_policy)}
                    </p>
                    {status.staged && <p>Prepared version: {status.staged.version}</p>}
                  </details>
                  {outcome?.error && (
                    <section
                      aria-label={`Update check failure for ${port.name}`}
                      data-update-check-failure={port.id}
                      className="col-span-full min-w-0 rounded-pc-md border border-pc-danger bg-pc-danger-subtle px-3 py-2 text-xs break-words"
                    >
                      <p className="text-pc-danger-foreground">{errorText(outcome.error)}</p>
                      {failure && (
                        <FailureDetails
                          key={JSON.stringify({ code: outcome.error.code, presentation: failure })}
                          presentation={failure}
                          code={outcome.error.code}
                          showMutationSummary={false}
                        />
                      )}
                    </section>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {model.retainedArchives.length > 0 && (
          <section className="mt-7" aria-label="Retained update archives">
            <h3 className="mb-3 text-base">Retained update archives</h3>
            <p className="mb-4 text-sm text-pc-muted-foreground">
              Archives remain recorded separately from installations. These records offer archive
              cleanup; preparing or installing an update requires an available managed installation
              and a fresh review.
            </p>
            <div className="grid gap-4" data-focus-group>
              {model.retainedArchives.map((status) => {
                const entry = model.activityPorts.find((port) => port.id === status.port_id);
                const displayName = entry ? gameIdentityLabel(entry) : undefined;
                return (
                  <article
                    key={status.port_id}
                    data-retained-update-archive-port-id={status.port_id}
                    className="min-w-0 rounded-pc-lg border border-pc-border bg-pc-surface p-5"
                  >
                    <h4 className="text-base">{displayName ?? status.port_id}</h4>
                    {displayName && (
                      <p className="mt-1 text-xs [overflow-wrap:anywhere] text-pc-muted-foreground">
                        {status.port_id}
                      </p>
                    )}
                    <GameUpdateControl
                      portId={status.port_id}
                      gameName={displayName}
                      generation={model.generation}
                      policy={status.update_policy}
                      busy={Boolean(model.busy)}
                      perform={model.perform}
                      status={status}
                      archiveOnly
                      compact
                    />
                  </article>
                );
              })}
            </div>
          </section>
        )}
        {model.external.length > 0 && (
          <section className="external-update-section mt-6" aria-label="Externally updated games">
            <h3 className="mb-2 text-base">Externally updated games</h3>
            <p className="update-explainer mb-4 text-xs leading-[var(--leading-comfortable)] text-pc-muted-foreground">
              You prepare updates for these registered runtimes outside Portcove. Open a game to
              review its saved location and launch details.
            </p>
            <div className="update-list grid gap-2" data-focus-group>
              {model.external.map((port) => {
                const runtime = model.statuses.get(port.id)!.external_runtime!;
                return (
                  <button
                    data-focusable
                    data-detail-origin={`updates:external:${port.id}`}
                    className={updateRowClass}
                    key={port.id}
                    onClick={() => model.onSelect(port.id, `updates:external:${port.id}`)}
                  >
                    <ArtworkImage port={port} quietFallback className="update-artwork" />
                    <div className="update-title min-w-0">
                      <strong className="block text-sm">{gameTitle(port)}</strong>
                      <small className="block text-xs text-pc-muted-foreground">
                        {gameProjectLabel(port)}
                      </small>
                      <small className="mt-1 block text-xs text-[var(--color-text-secondary)] capitalize">
                        Registered user-prepared runtime
                      </small>
                    </div>
                    <div className="update-versions grid min-w-0 grid-cols-2 gap-3.5 max-[65rem]:grid-cols-1 max-[65rem]:gap-2">
                      <div className="update-version min-w-0">
                        <small className="mt-1 block text-xs text-[var(--color-text-secondary)] capitalize">
                          {runtime.user_selected ? "Update ownership" : "Registered version"}
                        </small>
                        <span className="mt-[3px] block text-sm [overflow-wrap:anywhere] text-[var(--color-text-secondary)]">
                          {runtime.user_selected ? "You or the upstream launcher" : runtime.version}
                        </span>
                      </div>
                    </div>
                    <span className={`${updateStateClass} ${updateStateTones.muted}`}>
                      Updated externally
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </Tabs.Panel>
      <Tabs.Panel
        value={model.selectedSection === "history" ? "history" : "tasks"}
        keepMounted
        aria-label="Tasks and history"
      >
        <h2 className="mb-5 text-lg">
          {model.selectedSection === "history" ? "History" : "Tasks"}
        </h2>
        <div
          hidden={model.selectedSection === "history"}
          inert={model.selectedSection === "history" ? true : undefined}
        >
          <RecoveryReview
            generation={model.generation}
            repair={model.repair}
            ports={model.ports}
            refreshing={model.diagnosticsRefreshing}
            stale={model.diagnosticsStale}
            failure={model.diagnosticFailure}
            refresh={model.refreshDiagnostics}
            cleanupChanged={model.cleanupChanged}
            onSelect={model.onSelect}
            onOpenStorage={() => model.onOpenSettings("library-storage")}
            availableActivityIds={new Set(model.activities.map((activity) => activity.id))}
            onReviewActivity={(id) => {
              model.onReviewActivity?.(id);
              model.setReviewedActivity((previous) => ({
                id,
                request: (previous?.request ?? 0) + 1,
              }));
            }}
          />
        </div>
        <ActivityHistory
          mode={model.selectedSection === "history" ? "history" : "tasks"}
          operationEvents={model.operationEvents}
          ports={model.activityPorts}
          sourceProfiles={model.sourceProfiles}
          activities={model.activities}
          activityFeed={model.activityFeed}
          onSelect={model.onSelect}
          onOpenSettings={model.onOpenSettings}
          generation={model.generation}
          nowSeconds={model.nowSeconds}
          reviewedActivityId={
            model.onReviewActivity ? model.reviewedActivityId : model.reviewedActivity?.id
          }
        />
      </Tabs.Panel>
    </Tabs.Root>
  );
}

function UpdateCheckControl({
  busy,
  status,
  hasInstalled,
  checkAll,
}: {
  busy?: string | undefined;
  status?: UpdateBatchRead["status"] | undefined;
  hasInstalled: boolean;
  checkAll: () => void | Promise<void>;
}) {
  const pendingCheck = useRef<typeof checkAll | undefined>(undefined);
  const labelId = useId();
  return (
    <div className="update-buttons flex min-w-0 flex-wrap items-center gap-2">
      <Button
        data-focusable
        variant="outline"
        className="max-w-full min-w-0 text-start whitespace-normal [&_span]:min-w-0 [&_span]:wrap-anywhere"
        disabled={Boolean(busy) || status === "pending" || !hasInstalled}
        focusableWhenDisabled={status === "pending" || busy === "check installed"}
        aria-busy={status === "pending" || busy === "check installed"}
        aria-labelledby={labelId}
        onClick={() => {
          if (pendingCheck.current === checkAll) return;
          pendingCheck.current = checkAll;
          void Promise.resolve(checkAll()).finally(() => {
            if (pendingCheck.current === checkAll) pendingCheck.current = undefined;
          });
        }}
      >
        <Icon glyph={RefreshCw} />
        <span id={labelId}>
          {busy === "check installed" || status === "pending"
            ? "Checking installed ports…"
            : status === "failed" || status === "cancelled"
              ? "Retry update check"
              : "Check installed ports for updates"}
        </span>
      </Button>
    </div>
  );
}

function UpdateBatchNotice({ read }: { read?: UpdateBatchRead | undefined }) {
  if (!read || read.status === "idle" || read.status === "current") return null;
  return (
    <div
      className="update-explainer mb-4 text-xs leading-[var(--leading-comfortable)] text-pc-muted-foreground"
      role="status"
    >
      <strong>
        {read.status === "pending"
          ? "Checking for updates"
          : read.status === "cancelled"
            ? "Update check cancelled"
            : "Update check did not finish"}
      </strong>
      <p>
        {read.status === "pending"
          ? "Showing earlier results while the current check runs, where available."
          : "Current update results are unavailable. Earlier results remain shown where available."}
      </p>
      <p>Retry only checks for updates. Open a game to review any download or installation.</p>
      {read.status === "failed" && read.failure && (
        <FailureDetails presentation={read.failure} showMutationSummary={false} />
      )}
    </div>
  );
}

function releaseLabel(check?: UpdateCheck | null, outcome?: UpdateCheckOutcome) {
  if (!check) return outcome ? (outcome.ok ? "Unavailable" : "Check failed") : "Not checked";
  const runtimeOnly =
    check.update_available &&
    check.installed_artifact?.sha256 === check.release.asset.sha256 &&
    JSON.stringify(check.installed_runtime ?? null) !==
      JSON.stringify(check.required_runtime ?? null);
  return `${check.release.version}${runtimeOnly ? " · Runtime update" : ""}`;
}

function ActivityHistory({
  mode,
  operationEvents,
  ports,
  sourceProfiles,
  activities,
  activityFeed,
  onSelect,
  onOpenSettings,
  generation,
  nowSeconds,
  reviewedActivityId,
}: {
  mode: "tasks" | "history";
  operationEvents?: ReadonlyMap<string, OperationEvent> | undefined;
  generation: number;
  nowSeconds: number;
  reviewedActivityId?: string | undefined;
  ports: readonly CatalogEntry[];
  sourceProfiles: SourceProfile[];
  activities: ActivityRecord[];
  activityFeed?: ActivityFeed | undefined;
  onSelect: (portId: string, originKey?: string) => void;
  onOpenSettings: (target: ActivitySettingsTarget, sourceProfileId?: string) => void;
}) {
  const [focusedActivityId, setFocusedActivityId] = useState<string>();
  const names = new Map(ports.map((port) => [port.id, gameIdentityLabel(port)]));
  const portsById = new Map(ports.map((port) => [port.id, port]));
  const sourceNames = new Map(sourceProfiles.map((profile) => [profile.id, profile.label]));
  const protectedActivityIds = activityFeed
    ? [
        ...activityFeed.current_activity_ids,
        ...activityFeed.attention_required_activity_ids,
        ...activityFeed.recovery_required_activity_ids,
      ]
    : [];
  const visibleActivities = activityHistoryPreview(activities, nowSeconds, [
    ...protectedActivityIds,
    ...(reviewedActivityId ? [reviewedActivityId] : []),
    ...(focusedActivityId ? [focusedActivityId] : []),
  ]);
  const protectedIds = new Set(protectedActivityIds);
  const attentionIds = new Set([
    ...(activityFeed?.attention_required_activity_ids ?? []),
    ...(activityFeed?.recovery_required_activity_ids ?? []),
  ]);
  const inTasks = (activity: ActivityRecord) =>
    protectedIds.has(activity.id) ||
    ["running", "unfinished", "failed", "unknown"].includes(
      activityPresentationState(activity, nowSeconds),
    ) ||
    Boolean(activity.failure) ||
    activity.id === reviewedActivityId ||
    activity.id === focusedActivityId;
  const visibleInMode = (activity: ActivityRecord) =>
    mode === "tasks"
      ? inTasks(activity)
      : !["running", "unfinished"].includes(activityPresentationState(activity, nowSeconds));
  const shownActivities = visibleActivities.filter(visibleInMode);
  const groups = [
    {
      label: "Needs attention",
      records: visibleActivities.filter((item) => attentionIds.has(item.id)),
    },
    {
      label: "In progress",
      records: visibleActivities.filter(
        (item) => !attentionIds.has(item.id) && item.status === "running",
      ),
    },
    {
      label: "Recent",
      records: visibleActivities.filter(
        (item) => !attentionIds.has(item.id) && item.status !== "running",
      ),
    },
  ];
  const visibleFinishedCount = visibleActivities.filter(
    (activity) =>
      ["succeeded", "failed", "cancelled"].includes(activity.status) &&
      !protectedIds.has(activity.id),
  ).length;
  return (
    <section className="activity-history" data-record-view={mode}>
      <div className="activity-heading mb-3 flex items-end justify-between gap-4">
        <div>
          <h3 className="text-sm">Task records and diagnostics</h3>
        </div>
        <small className="text-xs text-pc-muted-foreground">
          {activityFeed ? (
            <>
              {mode === "history"
                ? `Showing ${visibleFinishedCount} recent finished tasks, plus retained review records.`
                : "Showing current tasks and records needing attention."}
              {!activityFeed.active_and_actionable_complete &&
                " Current work and attention coverage is incomplete."}
              {!activityFeed.terminal_history_complete &&
                " Earlier finished tasks exist beyond the records loaded here."}
            </>
          ) : (
            "Activity from the CLI and desktop appears here."
          )}
        </small>
      </div>
      {shownActivities.length === 0 && (
        <div className="activity-empty flex items-center gap-3 p-4 text-start text-xs text-pc-muted-foreground">
          <span className="text-pc-interactive-foreground">
            <Icon glyph={History} />
          </span>
          <div>
            <strong className="block text-pc-secondary-foreground">
              {mode === "history"
                ? "No finished tasks in these records"
                : "No current tasks in these records"}
            </strong>
            <span className="mt-1 block">
              {mode === "history"
                ? "Recorded installs, updates, checks and failures appear here when they finish."
                : "Installs, updates, checks and items needing attention appear here. Finished records are in History."}
            </span>
          </div>
        </div>
      )}
      <div className="activity-list grid gap-1.5">
        {groups
          .filter((group) => group.records.length > 0)
          // Keep rows under one parent: settlement changes their group, not
          // their DOM identity, focus or open diagnostic disclosures.
          .flatMap((group) => [
            <h3
              key={`group:${group.label}`}
              className="mt-3 mb-1 text-sm text-pc-muted-foreground"
              hidden={!group.records.some(visibleInMode)}
            >
              {mode === "history" && group.label === "Recent" ? "Finished tasks" : group.label}
            </h3>,
            ...group.records.map((activity) => (
              <ActivityRow
                operation={operationEvents?.get(activity.id)}
                activity={activity}
                port={
                  activity.target_kind === "port" && activity.target_id
                    ? portsById.get(activity.target_id)
                    : undefined
                }
                hidden={!visibleInMode(activity)}
                onFocus={() => setFocusedActivityId(activity.id)}
                onBlur={(stillInRow) => {
                  if (!stillInRow)
                    setFocusedActivityId((current) =>
                      current === activity.id ? undefined : current,
                    );
                }}
                names={names}
                sourceNames={sourceNames}
                onSelect={onSelect}
                onOpenSettings={onOpenSettings}
                key={`activity:${activity.id}`}
                generation={generation}
                nowSeconds={nowSeconds}
              />
            )),
          ])}
      </div>
    </section>
  );
}

function ActivityRow({
  operation,
  activity,
  port,
  hidden,
  onFocus,
  onBlur,
  names,
  sourceNames,
  onSelect,
  onOpenSettings,
  generation,
  nowSeconds,
}: {
  port?: CatalogEntry | undefined;
  hidden: boolean;
  onFocus: () => void;
  onBlur: (stillInRow: boolean) => void;
  operation?: OperationEvent | undefined;
  generation: number;
  nowSeconds: number;
  activity: ActivityRecord;
  names: ReadonlyMap<string, string>;
  sourceNames: ReadonlyMap<string, string>;
  onSelect: (portId: string, originKey?: string) => void;
  onOpenSettings: (target: ActivitySettingsTarget, sourceProfileId?: string) => void;
}) {
  const target = activityTarget(activity, names, sourceNames);
  const presentation = activityPresentation(activity, nowSeconds);
  const tone = activityTones[presentation.state];
  return (
    <div
      className={`activity-row ${presentation.state} ${controlFocus}`}
      hidden={hidden}
      inert={hidden ? true : undefined}
      onFocusCapture={onFocus}
      onBlurCapture={(event) => onBlur(event.currentTarget.contains(event.relatedTarget))}
      title={activity.failure?.presentation.summary}
      data-focus-group
      data-activity-id={activity.id}
      tabIndex={-1}
    >
      {port ? (
        <ArtworkImage port={port} quietFallback className="activity-artwork" />
      ) : (
        <span
          className={`activity-indicator grid size-6 place-items-center rounded-pc-sm ${tone?.indicator ?? "bg-pc-secondary text-pc-muted-foreground"}`}
          aria-hidden="true"
        >
          <Icon glyph={presentation.icon} size="sm" />
        </span>
      )}
      <div className="activity-main min-w-0">
        <ActivityTargetLink
          activity={activity}
          target={target}
          onSelect={onSelect}
          onOpenSettings={onOpenSettings}
        />
        <span className="mt-1 block text-xs text-pc-muted-foreground">
          {operationLabel(activity.operation)}
        </span>
      </div>
      <span
        className="activity-time text-end text-xs text-pc-muted-foreground max-[65rem]:col-start-2 max-[65rem]:row-start-2 max-[65rem]:text-start"
        title={
          activity.finished_at ? `Finished ${formatActivityTime(activity.finished_at)}` : undefined
        }
      >
        {presentation.time}
      </span>
      <span
        className={`activity-status justify-self-end text-xs font-medium whitespace-nowrap max-[65rem]:col-start-3 max-[65rem]:row-start-1 max-[65rem]:whitespace-normal ${tone?.status ?? "text-pc-muted-foreground"}`}
      >
        {presentation.label}
      </span>
      {presentation.state === "unfinished" && (
        <p className={activityDetailsClass}>
          This task has not reported completion. Review its details before retrying.
        </p>
      )}
      {activity.status === "running" && operation && operation.type !== "finished" && (
        <div className={activityDetailsClass}>
          <OperationProgress operation={operation} busy={activity.operation} />
        </div>
      )}
      {activity.operation === "launch" && presentation.state === "succeeded" && (
        <p className={activityDetailsClass}>
          The game process exited successfully. Gameplay was not checked.
        </p>
      )}
      {activity.cancellation && (
        <div className={activityDetailsClass}>
          <OperationCancellation operationId={activity.id} state={activity.cancellation} />
        </div>
      )}
      <ActivityFailure activity={activity} target={target} onSelect={onSelect} />
      {activity.operation === "prepare" && (
        <ActivityDiagnostic
          key={`${generation}:${activity.id}`}
          activityId={activity.id}
          generation={generation}
        />
      )}
      <details className={activityDetailsClass}>
        <summary data-focusable className="cursor-pointer py-1">
          Task details
        </summary>
        <dl className="mt-2 grid gap-1">
          <dt className="text-pc-muted-foreground">Operation ID</dt>
          <dd className="m-0 [overflow-wrap:anywhere] select-text">
            <code>{activity.id}</code>
          </dd>
        </dl>
      </details>
    </div>
  );
}

function ActivityFailure({
  activity,
  target,
  onSelect,
}: {
  activity: ActivityRecord;
  target: ReturnType<typeof activityTarget>;
  onSelect: (portId: string, originKey?: string) => void;
}) {
  return (
    <>
      {activity.failure ? (
        <div className={activityDetailsClass}>
          <p>{activity.failure.presentation.summary}</p>
          {activity.failure.presentation.recovery_actions.includes("review_preparation") &&
            target.portId && (
              <Button
                data-focusable
                variant="link"
                size="sm"
                data-detail-origin={`updates:activity:${activity.id}:review`}
                onClick={() => onSelect(target.portId!, `updates:activity:${activity.id}:review`)}
              >
                Review setup
              </Button>
            )}
          <FailureDetails
            presentation={activity.failure.presentation}
            code={activity.failure.code}
          />
        </div>
      ) : (
        activity.message && (
          <p className={activityDetailsClass}>More details may be available in a support bundle.</p>
        )
      )}
    </>
  );
}

function ActivityTargetLink({
  activity,
  target,
  onSelect,
  onOpenSettings,
}: {
  activity: ActivityRecord;
  target: ReturnType<typeof activityTarget>;
  onSelect: (portId: string, originKey?: string) => void;
  onOpenSettings: (target: ActivitySettingsTarget, sourceProfileId?: string) => void;
}) {
  if (target.portId)
    return (
      <Button
        data-focusable
        variant="link"
        size="xs"
        className={activityTargetButton}
        data-detail-origin={`updates:activity:${activity.id}:target`}
        onClick={() => onSelect(target.portId!, `updates:activity:${activity.id}:target`)}
      >
        {target.label}
      </Button>
    );
  if (activity.target_kind === "source" && activity.target_id)
    return (
      <Button
        data-focusable
        variant="link"
        size="xs"
        className={activityTargetButton}
        aria-label={`Open Game files settings for ${target.label}`}
        onClick={() => onOpenSettings("source-profile", activity.target_id!)}
      >
        {target.label}
      </Button>
    );
  const settingsTarget =
    activity.target_kind === "library"
      ? libraryActivitySettingsTargets[activity.operation]
      : undefined;
  if (settingsTarget) {
    const destination = {
      "discover-sources": "Game files",
      "move-library": "Library and storage",
      "import-library": "Library and storage",
      "catalog-updates": "Catalog updates",
    }[settingsTarget];
    return (
      <Button
        data-focusable
        variant="link"
        size="xs"
        className={activityTargetButton}
        aria-label={`Open ${destination} settings for ${target.label}`}
        onClick={() => onOpenSettings(settingsTarget)}
      >
        {target.label}
      </Button>
    );
  }
  return <span className="mt-[3px] block text-xs text-pc-muted-foreground">{target.label}</span>;
}

function activityTarget(
  activity: ActivityRecord,
  names: ReadonlyMap<string, string>,
  sourceNames: ReadonlyMap<string, string>,
) {
  const targetId = activity.target_id;
  const portId =
    activity.target_kind === "port" && targetId && names.has(targetId) ? targetId : undefined;
  const sourceLabel =
    activity.target_kind === "source" && targetId ? sourceNames.get(targetId) : undefined;
  return {
    portId,
    label: (portId && names.get(portId)) ?? sourceLabel ?? targetId ?? "Portcove library",
  };
}

function operationLabel(operation: ActivityOperation) {
  const labels: Record<ActivityOperation, string> = {
    relink_external: "Change game folder",
    download_package: "Upstream package download",
    prepare: "Game-data setup",
    launch: "Game launch",
    register_external: "Use an existing installation",
    remove_external: "Stop using an existing installation",
    check_update: "Update check",
    backup: "Backup",
    restore: "Backup restore",
    delete_backup: "Backup deletion",
    install: "Installation",
    update: "Game update",
    reconcile: "Update policy run",
    verify_install: "Installation check",
    activate: "Update activation",
    rollback: "Previous-version restore",
    adopt: "Existing-installation copy",
    remove: "Uninstall",
    remove_source: "Game-file location removal",
    register_source: "Game-file location update",
    verify_source: "Game-file check",
    move_library: "Library move",
    relocate_output: "Installed-version move",
    import_library: "Library restore",
    import_source: "Game-file import",
    discover_sources: "Game-file search",
    update_catalog: "Catalog update",
  };
  return Object.hasOwn(labels, operation) ? labels[operation] : "Activity";
}

function formatActivityTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const terminalActivityPresentations: ReadonlyMap<
  string,
  { state: string; label: string; icon: LucideIcon }
> = new Map([
  ["succeeded", { state: "succeeded", label: "Completed", icon: Check }],
  ["failed", { state: "failed", label: "Failed", icon: AlertTriangle }],
  ["cancelled", { state: "cancelled", label: "Cancelled", icon: CircleMinus }],
]);

function activityPresentation(activity: ActivityRecord, nowSeconds: number) {
  const state = activityPresentationState(activity, nowSeconds);
  if (state !== "running" && state !== "unfinished") {
    const presentation = terminalActivityPresentations.get(state) ?? {
      state: "unknown",
      label: "Status unavailable",
      icon: AlertTriangle,
    };
    return {
      ...presentation,
      ...(activity.operation === "launch" && state === "succeeded"
        ? { label: "Process exited" }
        : {}),
      time: `Started ${formatActivityTime(activity.started_at)}`,
    };
  }
  if (state === "unfinished")
    return {
      state: "unfinished",
      label: "May have been interrupted",
      time: "No completion reported",
      icon: AlertTriangle,
    };
  return {
    state: "running",
    label: "In progress",
    time: "In progress",
    icon: LoaderCircle,
  };
}

function UpdateStat({
  label,
  value,
  icon,
  accent,
  warning,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  accent?: boolean;
  warning?: boolean;
}) {
  return (
    <div className="update-stat grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 rounded-pc-lg border border-pc-border bg-pc-surface px-3.5 py-3 wrap-anywhere">
      <div
        className={`row-span-2 ${warning ? "text-pc-danger-foreground" : accent ? "text-pc-interactive-foreground" : "text-pc-muted-foreground"}`}
      >
        <Icon glyph={icon} />
      </div>
      <strong
        className={`block text-xl leading-none ${warning ? "text-pc-danger-foreground" : accent ? "text-pc-interactive-foreground" : ""}`}
      >
        {value}
      </strong>
      <span className="text-xs tracking-[0.08em] text-pc-muted-foreground uppercase">{label}</span>
    </div>
  );
}

function policyLabel(policy: PortStatus["update_policy"]) {
  const labels = {
    automatic: "Install when I run updates",
    stage: "Keep update for later",
    notify: "Notify me",
  };
  return Object.hasOwn(labels, policy) ? labels[policy] : "Update policy unavailable";
}

function updateState(
  status: PortStatus,
  outcome?: UpdateCheckOutcome,
  savedCheck?: UpdateCheck,
  earlier = false,
): { label: string; tone: UpdateTone } {
  if (!outcome) {
    if (status.staged) return { label: "Downloaded for later", tone: "staged" };
    if (status.acquisition)
      return {
        label: gameUpdateAcquisitionLabel(status.acquisition.phase),
        tone: status.acquisition.phase === "attention_required" ? "failed" : "muted",
      };
    if (savedCheck?.update_available)
      return { label: "Update available at last check", tone: "available" };
    if (savedCheck) return { label: "No update found at last check", tone: "current" };
    return { label: "Not checked", tone: "muted" };
  }
  if (!outcome.ok)
    return { label: earlier ? "Earlier check failed" : "Check failed", tone: "failed" };
  if (status.staged) return { label: "Downloaded for later", tone: "staged" };
  if (status.acquisition)
    return {
      label: gameUpdateAcquisitionLabel(status.acquisition.phase),
      tone: status.acquisition.phase === "attention_required" ? "failed" : "muted",
    };
  if (!outcome.result)
    return {
      label: earlier ? "Earlier check result unavailable" : "Check result unavailable",
      tone: "muted",
    };
  if (outcome.result.update_available)
    return {
      label: earlier ? "Update available at last check" : "Update available",
      tone: "available",
    };
  return { label: "No update found at last check", tone: "current" };
}
