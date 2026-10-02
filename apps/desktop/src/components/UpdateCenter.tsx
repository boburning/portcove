import { FailureDetails } from "./FailureDetails";
import { ActivityDiagnostic } from "./ActivityDiagnostic";
import { RecoveryReview } from "./RecoveryReview";
import {
  activityHistoryPreview,
  activityPresentationState,
  currentUpdateSnapshot,
  errorText,
  releaseChannelPresentation,
} from "../view-model";
import { OperationCancellation } from "./OperationCancellation";
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
  DoctorReport,
  PortDefinition,
  PortStatus,
  SourceProfile,
  UpdateCheck,
  UpdateCheckOutcome,
} from "../types";
import { EmptyState, Icon } from "./ui";
import { Button } from "./ui/button";
import { useEffect, useRef, useState } from "react";
import type { UpdateBatchRead } from "../features/port-updates/use-update-center";
import type { ActivitySettingsTarget } from "../features/app-shell/focus-settings-target";

const initialActivityNowSeconds = Date.now() / 1000;
const activityTargetButton =
  "-mx-1 h-auto min-h-6 min-w-0 max-w-full shrink justify-start overflow-hidden px-1 py-0 text-ellipsis text-xs font-normal text-pc-secondary-foreground no-underline hover:text-pc-interactive-foreground hover:no-underline";
const activityDetailsClass = "activity-details col-[2/-1] min-w-0 text-xs";
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
    indicator: "bg-pc-accent text-pc-interactive-foreground motion-safe:[&_.icon]:animate-spin",
    status: "text-pc-interactive-foreground",
  },
  unfinished: {
    indicator: "bg-pc-warning-subtle text-pc-warning-foreground",
    status: "text-pc-warning-foreground",
  },
};
type UpdateTone = "available" | "current" | "failed" | "muted" | "staged";
const updateMarkTones: Record<UpdateTone, string> = {
  available: "bg-pc-warning-subtle text-pc-warning-foreground",
  current: "bg-pc-success-subtle text-pc-success-foreground",
  failed: "bg-pc-danger-surface text-[var(--color-text-on-dark)]",
  muted: "bg-[var(--color-bg-subtle-hover)] text-[var(--color-text-secondary)]",
  staged: "bg-pc-primary text-pc-primary-foreground",
};
const updateStateTones: Record<UpdateTone, string> = {
  available: "bg-pc-warning-subtle text-pc-warning-foreground",
  current: "bg-pc-success-subtle text-pc-success-foreground",
  failed: "bg-pc-danger-subtle text-pc-danger-foreground",
  muted: "bg-[var(--color-bg-subtle-hover)] text-[var(--color-text-secondary)]",
  staged: "bg-[var(--color-interactive-subtle)] text-pc-interactive-foreground",
};
const updateRowClass =
  "update-row grid w-full grid-cols-[42px_minmax(180px,1fr)_minmax(214px,284px)_90px] cursor-pointer items-center gap-3.5 rounded-pc-lg border border-pc-border bg-pc-surface p-3 text-left text-pc-foreground shadow-[var(--shadow-control)] transition-[color,background-color,border-color,box-shadow,transform] duration-(--duration-normal) ease-(--ease-standard) hover:border-pc-primary hover:bg-pc-secondary active:translate-y-px active:bg-pc-surface-muted active:shadow-[var(--shadow-pressed)] max-[65rem]:grid-cols-[2.625rem_minmax(11rem,1fr)_minmax(8rem,1fr)_5.625rem]";
const updateMarkClass = "grid size-[42px] place-items-center rounded-pc-md text-xs font-black";
const updateStateClass =
  "justify-self-end rounded-full px-2 py-[5px] text-[length:var(--text-2xs)] font-extrabold tracking-[0.06em] uppercase";
const libraryActivitySettingsTargets: Partial<
  Record<ActivityOperation, Exclude<ActivitySettingsTarget, "source-profile" | "library-storage">>
> = {
  discover_sources: "discover-sources",
  move_library: "move-library",
  import_library: "import-library",
  update_catalog: "catalog-updates",
};

export function UpdateCenter({
  ports,
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
}: {
  generation: number;
  repair?: DoctorReport["repair"];
  diagnosticsRefreshing: boolean;
  diagnosticsStale: boolean;
  diagnosticFailure?: unknown;
  refreshDiagnostics: () => Promise<unknown>;
  cleanupChanged?: () => Promise<unknown>;
  ports: PortDefinition[];
  sourceProfiles?: SourceProfile[];
  statuses: Map<string, PortStatus>;
  activities: ActivityRecord[];
  activityFeed?: ActivityFeed;
  outcomes: UpdateCheckOutcome[];
  batchRead?: UpdateBatchRead;
  busy?: string;
  checkAll: () => void | Promise<void>;
  onSelect: (portId: string, originKey?: string) => void;
  onOpenSettings: (target: ActivitySettingsTarget, sourceProfileId?: string) => void;
}) {
  const pendingCheck = useRef<typeof checkAll | undefined>(undefined);
  const earlierBatch =
    batchRead !== undefined && ["pending", "failed", "cancelled"].includes(batchRead.status);
  const [nowSeconds, setNowSeconds] = useState(initialActivityNowSeconds);
  useEffect(() => {
    const refreshNow = () => setNowSeconds(Date.now() / 1000);
    refreshNow();
    const interval = window.setInterval(refreshNow, 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const installed = ports.filter((port) => statuses.get(port.id)?.active);
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
  const staged = installed.filter((port) => statuses.get(port.id)?.staged).length;
  return (
    <section className="update-center">
      <div
        className="update-toolbar mb-3.5 flex flex-wrap items-stretch justify-between gap-5 max-[75rem]:flex-col max-[75rem]:items-start"
        data-focus-group
      >
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
          <UpdateStat
            label="Saved for later"
            value={staged}
            icon={ShieldCheck}
            accent={staged > 0}
          />
          <UpdateStat
            label={earlierBatch ? "Failed at last check" : "Failed"}
            value={earlierBatch && !batchRead?.hasResults ? "Unknown" : failed}
            icon={AlertTriangle}
            warning={failed > 0}
          />
        </div>
        <div className="update-buttons flex items-center gap-2">
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(busy) || batchRead?.status === "pending" || installed.length === 0}
            onClick={() => {
              if (pendingCheck.current === checkAll) return;
              pendingCheck.current = checkAll;
              void Promise.resolve(checkAll()).finally(() => {
                if (pendingCheck.current === checkAll) pendingCheck.current = undefined;
              });
            }}
          >
            <Icon glyph={RefreshCw} />
            {busy === "check installed" || batchRead?.status === "pending"
              ? "Checking installed ports…"
              : batchRead?.status === "failed" || batchRead?.status === "cancelled"
                ? "Retry update check"
                : "Check installed ports for updates"}
          </Button>
        </div>
      </div>
      {earlierBatch && (
        <div
          className="update-explainer mb-4 text-xs leading-[var(--leading-comfortable)] text-pc-muted-foreground"
          role="status"
        >
          <strong>
            {batchRead.status === "pending"
              ? "Checking for updates"
              : batchRead.status === "cancelled"
                ? "Update check cancelled"
                : "Update check did not finish"}
          </strong>
          <p>
            {batchRead.status === "pending"
              ? "Showing earlier results while the current check runs, where available."
              : "Current update results are unavailable. Earlier results remain shown where available."}
          </p>
          <p>Retry only checks for updates. Open a game to review any download or installation.</p>
          {batchRead.status === "failed" && batchRead.failure && (
            <FailureDetails presentation={batchRead.failure} showMutationSummary={false} />
          )}
        </div>
      )}
      <p className="update-explainer mb-4 text-xs leading-[var(--leading-comfortable)] text-pc-muted-foreground">
        Checking only looks for updates. Open a game below to review a download or installation.
        Saving its update settings runs no update.
      </p>
      <p className="update-explainer mb-4 text-xs leading-[var(--leading-comfortable)] text-pc-muted-foreground">
        Looking for Portcove or catalog updates?{" "}
        <Button
          data-focusable
          variant="link"
          size="xs"
          onClick={() => onOpenSettings("catalog-updates")}
        >
          Open Portcove &amp; catalog update settings
        </Button>
      </p>
      {installed.length > 0 && (
        <p className="update-explainer mb-4 text-xs leading-[var(--leading-comfortable)] text-pc-muted-foreground">
          {earlierBatch ? "Earlier update results cover " : "Update results cover "}
          {checked.length} of {installed.length} installed games.
          {latestSavedCheck > 0 && ` Latest saved check: ${formatActivityTime(latestSavedCheck)}.`}
        </p>
      )}
      {installed.length === 0 ? (
        <EmptyState
          icon={RefreshCw}
          eyebrow="UPDATE CENTER"
          title="No managed installations to check"
          description={
            external.length > 0
              ? "Registered runtimes are updated externally. Install a managed port or copy in an existing installation to check it for updates here."
              : "Install a port or copy in an existing installation first. Portcove will then show its update channel, update setting, latest available release, and previous installed version here."
          }
        />
      ) : (
        <div className="update-list grid gap-2" data-focus-group>
          {installed.map((port) => {
            const status = statuses.get(port.id)!;
            const outcome = byPort.get(port.id);
            const savedCheck = savedByPort.get(port.id)?.check;
            const state = updateState(status, outcome, savedCheck, earlierBatch);
            return (
              <button
                data-focusable
                data-detail-origin={`updates:installed:${port.id}`}
                className={updateRowClass}
                key={port.id}
                title={outcome?.error ? errorText(outcome.error) : undefined}
                onClick={() => onSelect(port.id, `updates:installed:${port.id}`)}
              >
                <div className={`${updateMarkClass} ${updateMarkTones[state.tone]}`}>
                  {port.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="update-title min-w-0">
                  <strong className="block text-sm">{port.name}</strong>
                  <small className="mt-1 block text-[length:var(--text-2xs)] text-[var(--color-text-secondary)] capitalize">
                    {releaseChannelPresentation(status.channel).label} ·{" "}
                    {policyLabel(status.update_policy)}
                  </small>
                </div>
                <div className="update-versions grid min-w-0 grid-cols-2 gap-3.5 max-[65rem]:grid-cols-1 max-[65rem]:gap-2">
                  <div className="update-version min-w-0">
                    <small className="mt-1 block text-xs text-[var(--color-text-secondary)] capitalize">
                      Installed
                    </small>
                    <span className="mt-[3px] block text-sm text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">
                      {status.active?.version}
                    </span>
                  </div>
                  <div className="update-version min-w-0">
                    <small className="mt-1 block text-xs text-[var(--color-text-secondary)] capitalize">
                      {earlierBatch ? "Latest eligible at last check" : "Latest eligible"}
                    </small>
                    <span className="mt-[3px] block text-sm text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">
                      {releaseLabel(effectiveCheck(port.id), outcome)}
                    </span>
                  </div>
                </div>
                <span className={`${updateStateClass} ${updateStateTones[state.tone]}`}>
                  {state.label}
                </span>
                {outcome?.error && (
                  <small className="update-error col-[2/-1] overflow-hidden text-ellipsis whitespace-nowrap text-pc-danger-foreground">
                    {errorText(outcome.error)}
                  </small>
                )}
              </button>
            );
          })}
        </div>
      )}
      {external.length > 0 && (
        <section className="external-update-section mt-6" aria-label="Externally updated games">
          <h3 className="mb-2 text-base">Externally updated games</h3>
          <p className="update-explainer mb-4 text-xs leading-[var(--leading-comfortable)] text-pc-muted-foreground">
            You prepare updates for these registered runtimes outside Portcove. Open a game to
            review its saved location and launch details.
          </p>
          <div className="update-list grid gap-2" data-focus-group>
            {external.map((port) => {
              const runtime = statuses.get(port.id)!.external_runtime!;
              return (
                <button
                  data-focusable
                  data-detail-origin={`updates:external:${port.id}`}
                  className={updateRowClass}
                  key={port.id}
                  onClick={() => onSelect(port.id, `updates:external:${port.id}`)}
                >
                  <div className={`${updateMarkClass} ${updateMarkTones.muted}`}>
                    {port.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="update-title min-w-0">
                    <strong className="block text-sm">{port.name}</strong>
                    <small className="mt-1 block text-[length:var(--text-2xs)] text-[var(--color-text-secondary)] capitalize">
                      Registered user-prepared runtime
                    </small>
                  </div>
                  <div className="update-versions grid min-w-0 grid-cols-2 gap-3.5 max-[65rem]:grid-cols-1 max-[65rem]:gap-2">
                    <div className="update-version min-w-0">
                      <small className="mt-1 block text-xs text-[var(--color-text-secondary)] capitalize">
                        Registered version
                      </small>
                      <span className="mt-[3px] block text-sm text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">
                        {runtime.version}
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
      <RecoveryReview
        generation={generation}
        repair={repair}
        ports={ports}
        refreshing={diagnosticsRefreshing}
        stale={diagnosticsStale}
        failure={diagnosticFailure}
        refresh={refreshDiagnostics}
        cleanupChanged={cleanupChanged}
      />
      <ActivityHistory
        ports={ports}
        sourceProfiles={sourceProfiles}
        activities={activities}
        activityFeed={activityFeed}
        onSelect={onSelect}
        onOpenSettings={onOpenSettings}
        generation={generation}
        nowSeconds={nowSeconds}
      />
    </section>
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
  ports,
  sourceProfiles,
  activities,
  activityFeed,
  onSelect,
  onOpenSettings,
  generation,
  nowSeconds,
}: {
  generation: number;
  nowSeconds: number;
  ports: PortDefinition[];
  sourceProfiles: SourceProfile[];
  activities: ActivityRecord[];
  activityFeed?: ActivityFeed;
  onSelect: (portId: string, originKey?: string) => void;
  onOpenSettings: (target: ActivitySettingsTarget, sourceProfileId?: string) => void;
}) {
  const names = new Map(ports.map((port) => [port.id, port.name]));
  const sourceNames = new Map(sourceProfiles.map((profile) => [profile.id, profile.label]));
  const protectedActivityIds = activityFeed
    ? [
        ...activityFeed.current_activity_ids,
        ...activityFeed.attention_required_activity_ids,
        ...activityFeed.recovery_required_activity_ids,
      ]
    : [];
  const visibleActivities = activityHistoryPreview(activities, nowSeconds, protectedActivityIds);
  const protectedIds = new Set(protectedActivityIds);
  const visibleFinishedCount = visibleActivities.filter(
    (activity) =>
      ["succeeded", "failed", "cancelled"].includes(activity.status) &&
      !protectedIds.has(activity.id),
  ).length;
  return (
    <section className="activity-history mt-7 border-t border-pc-border pt-6">
      <div className="activity-heading mb-3 flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow">ACTIVITY HISTORY</p>
          <h2 className="mb-0 text-lg">Recent activity</h2>
        </div>
        <small className="text-xs text-pc-muted-foreground">
          {activityFeed ? (
            <>
              Showing {visibleFinishedCount} recent finished tasks, plus tasks in progress and items
              needing attention.
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
      {activities.length === 0 ? (
        <div className="activity-empty flex items-center gap-3 p-4 text-left text-xs text-pc-muted-foreground">
          <span className="text-pc-interactive-foreground">
            <Icon glyph={History} />
          </span>
          <div>
            <strong className="block text-pc-secondary-foreground">No activity yet</strong>
            <span className="mt-1 block">
              Installs, updates, verification, restored versions, copied installations, and failures
              will appear here.
            </span>
          </div>
        </div>
      ) : (
        <div className="activity-list grid gap-1.5">
          {visibleActivities.map((activity) => (
            <ActivityRow
              activity={activity}
              names={names}
              sourceNames={sourceNames}
              onSelect={onSelect}
              onOpenSettings={onOpenSettings}
              key={activity.id}
              generation={generation}
              nowSeconds={nowSeconds}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ActivityRow({
  activity,
  names,
  sourceNames,
  onSelect,
  onOpenSettings,
  generation,
  nowSeconds,
}: {
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
      className={`activity-row ${presentation.state} grid min-h-14 grid-cols-[1.5rem_minmax(0,1fr)_max-content_max-content] items-center gap-3 rounded-pc-md border border-pc-border bg-pc-surface px-3 py-2.5 max-[65rem]:grid-cols-[1.5rem_minmax(0,1fr)_4.5rem]`}
      title={activity.failure?.presentation.summary}
      data-focus-group
    >
      <span
        className={`grid size-6 place-items-center rounded-pc-sm ${tone?.indicator ?? "bg-pc-secondary text-pc-muted-foreground"}`}
        aria-hidden="true"
      >
        <Icon glyph={presentation.icon} size="sm" />
      </span>
      <div className="activity-main min-w-0">
        <strong className="block text-xs">{operationLabel(activity.operation)}</strong>
        <ActivityTargetLink
          activity={activity}
          target={target}
          onSelect={onSelect}
          onOpenSettings={onOpenSettings}
        />
      </div>
      <span
        className="activity-time whitespace-nowrap text-right text-[length:var(--text-2xs)] text-pc-muted-foreground max-[65rem]:hidden"
        title={
          activity.finished_at ? `Finished ${formatActivityTime(activity.finished_at)}` : undefined
        }
      >
        {presentation.time}
      </span>
      <span
        className={`activity-status justify-self-end whitespace-nowrap text-[length:var(--text-2xs)] font-extrabold tracking-[0.06em] uppercase max-[65rem]:whitespace-normal ${tone?.status ?? "text-pc-muted-foreground"}`}
      >
        {presentation.label}
      </span>
      {presentation.state === "unfinished" && (
        <p className={activityDetailsClass}>
          This task has not reported completion. Review its details before retrying.
        </p>
      )}
      {activity.cancellation && (
        <OperationCancellation operationId={activity.id} state={activity.cancellation} />
      )}
      {activity.failure ? (
        <div className={activityDetailsClass}>
          <p>{activity.failure.presentation.summary}</p>
          {activity.failure.presentation.recovery_actions.includes("review_preparation") &&
            target.portId && (
              <Button
                data-focusable
                variant="outline"
                size="sm"
                data-detail-origin={`updates:activity:${activity.id}:review`}
                onClick={() => onSelect(target.portId!, `updates:activity:${activity.id}:review`)}
              >
                Review game preparation
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
      {activity.operation === "prepare" && (
        <ActivityDiagnostic
          key={`${generation}:${activity.id}`}
          activityId={activity.id}
          generation={generation}
        />
      )}
    </div>
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
    <div className="update-stat grid min-w-[82px] grid-cols-[auto_1fr] items-center gap-x-2 rounded-pc-lg border border-pc-border bg-pc-surface px-3.5 py-3">
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
    stage: "Download for later",
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
    if (status.staged) return { label: "Update saved for later", tone: "staged" };
    if (savedCheck?.update_available)
      return { label: "Update available at last check", tone: "available" };
    if (savedCheck) return { label: "No update found at last check", tone: "current" };
    return { label: "Not checked", tone: "muted" };
  }
  if (!outcome.ok)
    return { label: earlier ? "Earlier check failed" : "Check failed", tone: "failed" };
  if (status.staged) return { label: "Update saved for later", tone: "staged" };
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
