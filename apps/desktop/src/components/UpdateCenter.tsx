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
import { useEffect, useState } from "react";

const initialActivityNowSeconds = Date.now() / 1000;
const activityTargetButton =
  "-mx-1 h-auto min-h-6 min-w-0 max-w-full shrink justify-start overflow-hidden px-1 py-0 text-ellipsis text-xs font-normal text-pc-secondary-foreground no-underline hover:text-pc-primary hover:no-underline";
type ActivitySettingsTarget = "game-files" | "move-library" | "import-library" | "catalog-updates";
const libraryActivitySettingsTargets: Partial<Record<ActivityOperation, ActivitySettingsTarget>> = {
  discover_sources: "game-files",
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
  busy?: string;
  checkAll: () => void;
  onSelect: (portId: string, originKey?: string) => void;
  onOpenSettings: (target: ActivitySettingsTarget) => void;
}) {
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
      <div className="update-toolbar" data-focus-group>
        <div className="update-stats">
          <UpdateStat label="Installed" value={installed.length} icon={PackageCheck} />
          <UpdateStat
            label="Updates available"
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
          <UpdateStat label="Failed" value={failed} icon={AlertTriangle} warning={failed > 0} />
        </div>
        <div className="update-buttons">
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(busy) || installed.length === 0}
            onClick={checkAll}
          >
            <Icon glyph={RefreshCw} />
            {busy === "check installed"
              ? "Checking installed ports…"
              : "Check installed ports for updates"}
          </Button>
        </div>
      </div>
      <p className="update-explainer">
        Checking only looks for updates. Open a game below to review a download or installation.
        Saving its update settings runs no update.
      </p>
      <p className="update-explainer">
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
        <p className="update-explainer">
          Update results cover {checked.length} of {installed.length} installed games.
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
        <div className="update-list" data-focus-group>
          {installed.map((port) => {
            const status = statuses.get(port.id)!;
            const outcome = byPort.get(port.id);
            const savedCheck = savedByPort.get(port.id)?.check;
            const state = updateState(status, outcome, savedCheck);
            return (
              <button
                data-focusable
                data-detail-origin={`updates:installed:${port.id}`}
                className="update-row"
                key={port.id}
                title={outcome?.error ? errorText(outcome.error) : undefined}
                onClick={() => onSelect(port.id, `updates:installed:${port.id}`)}
              >
                <div className={`update-mark ${state.tone}`}>
                  {port.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="update-title">
                  <strong>{port.name}</strong>
                  <small>
                    {releaseChannelPresentation(status.channel).label} ·{" "}
                    {policyLabel(status.update_policy)}
                  </small>
                </div>
                <div className="update-versions">
                  <div className="update-version">
                    <small>Installed</small>
                    <span>{status.active?.version}</span>
                  </div>
                  <div className="update-version">
                    <small>Latest eligible</small>
                    <span>{releaseLabel(effectiveCheck(port.id))}</span>
                  </div>
                </div>
                <span className={`update-state ${state.tone}`}>{state.label}</span>
                {outcome?.error && (
                  <small className="update-error">{errorText(outcome.error)}</small>
                )}
              </button>
            );
          })}
        </div>
      )}
      {external.length > 0 && (
        <section className="external-update-section" aria-label="Externally updated games">
          <h3>Externally updated games</h3>
          <p className="update-explainer">
            You prepare updates for these registered runtimes outside Portcove. Open a game to
            review its registration and launch details.
          </p>
          <div className="update-list" data-focus-group>
            {external.map((port) => {
              const runtime = statuses.get(port.id)!.external_runtime!;
              return (
                <button
                  data-focusable
                  data-detail-origin={`updates:external:${port.id}`}
                  className="update-row"
                  key={port.id}
                  onClick={() => onSelect(port.id, `updates:external:${port.id}`)}
                >
                  <div className="update-mark muted">{port.name.slice(0, 2).toUpperCase()}</div>
                  <div className="update-title">
                    <strong>{port.name}</strong>
                    <small>Registered user-prepared runtime</small>
                  </div>
                  <div className="update-versions">
                    <div className="update-version">
                      <small>Registered version</small>
                      <span>{runtime.version}</span>
                    </div>
                  </div>
                  <span className="update-state muted">Updated externally</span>
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

function releaseLabel(check?: UpdateCheck | null) {
  if (!check) return "—";
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
  onOpenSettings: (target: ActivitySettingsTarget) => void;
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
    <section className="activity-history">
      <div className="activity-heading">
        <div>
          <p className="eyebrow">ACTIVITY HISTORY</p>
          <h2>Recent activity</h2>
        </div>
        <small>
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
        <div className="activity-empty">
          <Icon glyph={History} />
          <div>
            <strong>No activity yet</strong>
            <span>
              Installs, updates, verification, restored versions, copied installations, and failures
              will appear here.
            </span>
          </div>
        </div>
      ) : (
        <div className="activity-list">
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
  onOpenSettings: (target: ActivitySettingsTarget) => void;
}) {
  const target = activityTarget(activity, names, sourceNames);
  const presentation = activityPresentation(activity, nowSeconds);
  return (
    <div
      className={`activity-row ${presentation.state}`}
      title={activity.failure?.presentation.summary}
      data-focus-group
    >
      <span className="activity-indicator" aria-hidden="true">
        <Icon glyph={presentation.icon} size="sm" />
      </span>
      <div className="activity-main">
        <strong>{operationLabel(activity.operation)}</strong>
        <ActivityTargetLink
          activity={activity}
          target={target}
          onSelect={onSelect}
          onOpenSettings={onOpenSettings}
        />
      </div>
      <span
        className="activity-time"
        title={
          activity.finished_at ? `Finished ${formatActivityTime(activity.finished_at)}` : undefined
        }
      >
        {presentation.time}
      </span>
      <span className="activity-status">{presentation.label}</span>
      {presentation.state === "unfinished" && (
        <p className="activity-details">
          This task has not reported completion. Review its details before retrying.
        </p>
      )}
      {activity.cancellation && (
        <OperationCancellation operationId={activity.id} state={activity.cancellation} />
      )}
      {activity.failure ? (
        <div className="activity-details">
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
          <p className="activity-details">More details may be available in a support bundle.</p>
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
  onOpenSettings: (target: ActivitySettingsTarget) => void;
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
        aria-label={`Open Game Files settings for ${target.label}`}
        onClick={() => onOpenSettings("game-files")}
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
      "game-files": "Game Files",
      "move-library": "Library & Storage",
      "import-library": "Library & Storage",
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
  return <span>{target.label}</span>;
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
    register_external: "External runtime registration",
    remove_external: "External registration removal",
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
    <div
      className={warning ? "update-stat warning" : accent ? "update-stat accent" : "update-stat"}
    >
      <Icon glyph={icon} />
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function policyLabel(policy: PortStatus["update_policy"]) {
  const labels = {
    automatic: "Install when running updates",
    stage: "Download for later",
    notify: "Notify me",
  };
  return Object.hasOwn(labels, policy) ? labels[policy] : "Update policy unavailable";
}

function updateState(status: PortStatus, outcome?: UpdateCheckOutcome, savedCheck?: UpdateCheck) {
  if (!outcome) {
    if (status.staged) return { label: "Update saved for later", tone: "staged" };
    if (savedCheck?.update_available)
      return { label: "Update available at last check", tone: "available" };
    if (savedCheck) return { label: "No update found at last check", tone: "current" };
    return { label: "Not checked", tone: "muted" };
  }
  if (!outcome.ok) return { label: "Check failed", tone: "failed" };
  if (status.staged) return { label: "Update saved for later", tone: "staged" };
  if (!outcome.result) return { label: "Check result unavailable", tone: "muted" };
  if (outcome.result.update_available) return { label: "Update available", tone: "available" };
  return { label: "No update found at last check", tone: "current" };
}
