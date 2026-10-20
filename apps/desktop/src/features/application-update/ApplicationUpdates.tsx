import { SettingsRow } from "../../components/ui/patterns";
import { useEffect, useRef, useState, type SetStateAction } from "react";
import { desktopApi } from "../../api";
import { LatestRequestGeneration } from "../../shared/concurrency-state";
import type { ApplicationUpdatePreferencesState } from "./use-application-update-preferences";
import type {
  ApplicationUpdateChoice,
  ApplicationUpdateCheckPhase,
  ApplicationUpdateCheckResult,
  ApplicationUpdateNoticeSnapshot,
  ApplicationUpdatePreferences,
  ApplicationUpdateRecoveryArea,
  ApplicationUpdateStatus,
} from "../../types";
import { errorText } from "../../view-model";
import { Button } from "../../components/ui/button";
import { focusAndReveal } from "../../focus";

const recommendedChoice: ApplicationUpdateChoice = {
  channel: "preview",
  mode: "automatic",
  paused: false,
};

const updatePanelClass = "application-update-status grid gap-3 border-t border-pc-border pt-4";
const updatePanelHeadingClass =
  "application-update-status-heading flex items-start justify-between gap-3 max-[65rem]:flex-col";
const updateSurfaceClass = "rounded-pc-md border border-pc-border bg-[var(--color-bg-subtle)] p-3";
const updateStatusItemClass = `application-update-status-item grid gap-1 ${updateSurfaceClass}`;
const updateMutedCopyClass = "text-xs leading-[var(--leading-relaxed)] text-pc-muted-foreground";
const updateDisclosureClass =
  "application-update-disclosure text-[var(--color-text-secondary)] rounded-pc-md border border-pc-border bg-[var(--color-bg-subtle)] p-3 text-xs";
const updateChoiceClass = "application-update-choice grid gap-2";
const updateChoiceButtonClass = "grid h-auto min-h-12 place-items-center gap-0.5 py-1";

function choicesMatch(left: ApplicationUpdateChoice | null, right: ApplicationUpdateChoice) {
  return (
    left?.channel === right.channel && left.mode === right.mode && left.paused === right.paused
  );
}

const recoveryCopy: Record<
  ApplicationUpdateRecoveryArea,
  { title: string; description: string; action: string }
> = {
  schedule: {
    title: "Update check history needs repair",
    description: "Reset check timing and retry history. Your update settings stay unchanged.",
    action: "Reset update-check history",
  },
  staging: {
    title: "Update download needs repair",
    description: "Delete the damaged download. You will need to download and verify it again.",
    action: "Delete damaged update download",
  },
  apply: {
    title: "The pending update request needs repair",
    description: "Clear only the pending request. This does not delete a verified download.",
    action: "Clear pending update request",
  },
};

function formatTimestamp(value: number) {
  return new Date(value * 1000).toLocaleString();
}

function formatBytes(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: "megabyte",
    maximumFractionDigits: 1,
  }).format(value / (1024 * 1024));
}

const nativeLaunchCopy = {
  starting: {
    title: "Installer start is unconfirmed",
    description:
      "Portcove cannot confirm whether the installer started. Reopen Portcove to check the installed version before another update attempt.",
  },
  started: {
    title: "Installer started",
    description:
      "The installer started, but Portcove has not confirmed the update. Reopen Portcove to check the installed version.",
  },
  failed: {
    title: "Installer didn't start",
    description: "The installer didn't start.",
  },
  "installer-succeeded": {
    title: "Installer reported success",
    description:
      "The installer reported success. Reopen Portcove to confirm the installed version and application health.",
  },
  "installer-failed": {
    title: "Installer did not complete",
    description: "The installer couldn't finish the update.",
  },
} as const;

const checkProgressCopy: Record<ApplicationUpdateCheckPhase, string> = {
  checking: "Checking for Portcove updates…",
  "acquiring-and-verifying": "Downloading and verifying the application update…",
  staged: "The Portcove update is downloaded and checked. It has not been installed.",
  complete: "Application update check complete.",
};

function applicationUpdateCheckCopy(result: ApplicationUpdateCheckResult) {
  const version = result.candidate?.version;
  switch (result.kind) {
    case "update-available":
      return result.staged
        ? {
            title: "Update downloaded and verified",
            description: `Portcove ${version ?? "update"} has been downloaded and checked. Installation conditions will be checked again when you restart or close Portcove.`,
          }
        : {
            title: "Update check complete",
            description: `Portcove ${version ?? "update"} is available. Its download has not started.`,
          };
    case "current":
      return {
        title: "Update check complete",
        description: "Portcove is current on the selected application update channel.",
      };
    case "held":
      return {
        title: "Update check complete",
        description: "No update can be offered on this channel.",
      };
    case "incompatible":
      return {
        title: "Update check complete",
        description: "The available release is not compatible with this installation.",
      };
    case "no-candidate":
      return {
        title: "Update check complete",
        description: "No eligible release is published for the selected channel.",
      };
    case "superseded":
      return {
        title: "Update check not completed",
        description:
          "Your update choice changed during the check. Run it again for the current choice.",
      };
    case "consent-required":
      return {
        title: "Automatic updates are off",
        description: "Choose update settings to enable automatic checks. You can still check once.",
      };
    case "offline":
      return {
        title: "Couldn't check for updates",
        description: "Connect to the internet and try again.",
      };
    case "paused":
      return {
        title: "Automatic update checks are paused",
        description: "Manual checks remain available. Resume downloads in update settings.",
      };
    case "manual-mode":
      return {
        title: "Automatic update checks are off",
        description: "Use Check for updates when you want to look for a release.",
      };
    case "metered":
      return {
        title: "Waiting to check for updates",
        description: "Automatic checks are waiting for an unmetered connection.",
      };
    case "metered-state-unknown":
      return {
        title: "Waiting to check for updates",
        description: "Portcove cannot confirm whether this connection is unmetered.",
      };
    case "startup-delay":
    case "cadence":
      return {
        title: "Next automatic check is scheduled for later",
        description: "You can check manually now, or wait for the scheduled automatic check.",
      };
  }
}

function applicationUpdateApplyCopy(status: ApplicationUpdateStatus) {
  const apply = status.apply;
  if (!apply) return undefined;
  if (apply.native_launch) {
    const copy = nativeLaunchCopy[apply.native_launch];
    if (apply.native_launch === "failed" || apply.native_launch === "installer-failed") {
      return {
        ...copy,
        description: `${copy.description} ${restartIsAvailable(status) ? "Try Restart to update again." : "Refresh update status to review the next available action."}`,
      };
    }
    return copy;
  }

  return {
    title:
      apply.request === "restart-to-apply" ? "Restart request saved" : "Safe-exit request saved",
    description: apply.termination
      ? `Portcove recorded ${apply.termination.replaceAll("-", " ")}. The installer has not been confirmed to start.`
      : "The request is saved. The installer has not started; Portcove checks installation conditions again before replacing the app.",
  };
}

function isRecoverableStateError(value: unknown) {
  if (typeof value !== "object" || !value || !("code" in value)) return false;
  const code = String(value.code);
  return code === "state" || code === "unsupported";
}

function ApplicationUpdateRecoveryItems({
  recoveries,
  disabled,
  busy,
  onRecover,
}: {
  recoveries: ApplicationUpdateStatus["recovery_required"];
  disabled: boolean;
  busy: boolean;
  onRecover: (area: ApplicationUpdateRecoveryArea) => Promise<void>;
}) {
  return recoveries.map((recovery) => {
    const copy = recoveryCopy[recovery.area];
    return (
      <div
        className="application-update-recovery flex items-start justify-between gap-3 rounded-pc-md border border-[var(--color-danger-border)] bg-pc-danger-subtle p-3 text-pc-danger-foreground max-[65rem]:flex-col"
        role="alert"
        key={recovery.area}
      >
        <div className="grid gap-1">
          <strong>{copy.title}</strong>
          <p className={updateMutedCopyClass}>{copy.description}</p>
        </div>
        <Button
          data-focusable
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={disabled || busy}
          onClick={() => void onRecover(recovery.area)}
        >
          {copy.action}
        </Button>
      </div>
    );
  });
}

function restartIsAvailable(status: ApplicationUpdateStatus) {
  const failedAttempt =
    status.apply?.native_launch === "failed" || status.apply?.native_launch === "installer-failed";
  return Boolean(
    status.staged &&
    status.install_eligibility === "eligible" &&
    !status.recovery_required.some(({ area }) => area === "apply") &&
    (!status.apply ||
      (status.apply.request === "restart-to-apply" &&
        (failedAttempt ||
          (status.apply.native_launch === null &&
            status.apply.termination === "restart-to-apply")))),
  );
}

function installRestrictionCopy(status: ApplicationUpdateStatus) {
  switch (status.install_eligibility) {
    case "package-managed-deb":
      return "This DEB installation is managed by its package manager. Update it through the same package source.";
    case "package-managed-rpm":
      return "This RPM installation is managed by its package manager. Update it through the same package source.";
    case "not-configured":
      return "Application updating is not configured in this build. Use the documented manual recovery path.";
    case "unavailable":
      return "This installation cannot use Portcove's built-in updater. Use a supported package or the documented manual recovery path.";
    case "eligible":
      return status.recovery_required.some(({ area }) => area === "apply")
        ? "Repair the pending update request before trying again."
        : "Review the pending request or installer result below before another restart.";
  }
}

function StagedApplicationUpdateItem({
  status,
  disabled,
  blocker,
  onRestart,
}: {
  status: ApplicationUpdateStatus;
  disabled: boolean;
  blocker?: string | undefined;
  onRestart: () => Promise<void>;
}) {
  if (!status.staged) return null;
  const canRestart = restartIsAvailable(status);
  return (
    <div className={updateStatusItemClass}>
      <strong>
        {canRestart && !blocker ? "Update ready to install" : "Verified update downloaded"}
      </strong>
      <p className={updateMutedCopyClass}>
        Portcove {status.staged.version} (
        {status.staged.channel === "preview" ? "Preview" : "Stable"},{" "}
        {formatBytes(status.staged.bytes)}) has been downloaded and verified.
        {blocker
          ? ` ${blocker}`
          : canRestart
            ? " Restart to update will check package ownership and other installation requirements again."
            : ` ${installRestrictionCopy(status)}`}
      </p>
      {canRestart && (
        <Button
          data-focusable
          variant="primary"
          size="sm"
          disabled={disabled}
          onClick={() => void onRestart()}
        >
          {status.apply ? "Retry restart to update" : "Restart to update"}
        </Button>
      )}
    </div>
  );
}

function ApplicationUpdateScheduleSummary({
  schedule,
}: {
  schedule: ApplicationUpdateStatus["schedule"];
}) {
  if (!schedule) return null;
  return (
    <p className={`application-update-schedule ${updateSurfaceClass} ${updateMutedCopyClass}`}>
      {schedule.last_success_unix_seconds
        ? `Last successful check: ${formatTimestamp(schedule.last_success_unix_seconds)}.`
        : "No successful application update check is recorded."}{" "}
      {schedule.consecutive_failures > 0 &&
        `${schedule.consecutive_failures} consecutive check failure${schedule.consecutive_failures === 1 ? "" : "s"} recorded.`}{" "}
      {schedule.next_automatic_check_unix_seconds &&
        `Next automatic attempt: ${formatTimestamp(schedule.next_automatic_check_unix_seconds)}.`}
    </p>
  );
}

function ApplicationUpdateStatusPanel({
  status,
  busy,
  error,
  disabled,
  onRefresh,
  onRecover,
  onRestart,
  restartDisabled,
  restartBlocker,
}: {
  status: ApplicationUpdateStatus | undefined;
  busy: string;
  error: string | undefined;
  disabled: boolean;
  onRefresh: () => Promise<void>;
  onRecover: (area: ApplicationUpdateRecoveryArea) => Promise<void>;
  onRestart: () => Promise<void>;
  restartDisabled: boolean;
  restartBlocker?: string | undefined;
}) {
  const applyCopy = status?.apply ? applicationUpdateApplyCopy(status) : undefined;

  return (
    <section className={updatePanelClass} aria-labelledby="application-status-title">
      <div className={updatePanelHeadingClass}>
        <div className="grid gap-1">
          <h3 id="application-status-title" tabIndex={-1}>
            Update activity
          </h3>
          <p className={updateMutedCopyClass}>
            See the download, restart request, and installer state.
          </p>
        </div>
        <Button
          data-focusable
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={disabled || Boolean(busy)}
          onClick={() => void onRefresh()}
        >
          Refresh update status
        </Button>
      </div>

      {status && (
        <>
          <ApplicationUpdateRecoveryItems
            recoveries={status.recovery_required}
            disabled={disabled}
            busy={Boolean(busy)}
            onRecover={onRecover}
          />
          <StagedApplicationUpdateItem
            status={status}
            disabled={restartDisabled || Boolean(busy)}
            blocker={restartBlocker}
            onRestart={onRestart}
          />

          {applyCopy && (
            <div className={updateStatusItemClass}>
              <strong>{applyCopy.title}</strong>
              <p className={updateMutedCopyClass}>{applyCopy.description}</p>
            </div>
          )}

          {!status.staged && !status.apply && status.recovery_required.length === 0 && (
            <p className={`application-update-idle ${updateSurfaceClass} ${updateMutedCopyClass}`}>
              No verified application update is staged.
            </p>
          )}

          <ApplicationUpdateScheduleSummary schedule={status.schedule} />
        </>
      )}

      {busy && <p role="status">{busy}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

type ApplicationUpdateOperationState = {
  checkChannel: ApplicationUpdateChoice["channel"];
  changeCheckChannel: (channel: ApplicationUpdateChoice["channel"]) => void;
  resultChannel: ApplicationUpdateChoice["channel"] | undefined;
  isOneTimeResult: boolean;
  busy: boolean;
  active: "check" | "download" | undefined;
  phase: ApplicationUpdateCheckPhase | undefined;
  result: ApplicationUpdateCheckResult | undefined;
  error: string | undefined;
  check: () => Promise<void>;
  download: () => Promise<void>;
  cancel: () => Promise<void>;
};

type BoundUpdateResult = {
  preferenceRevision: number | undefined;
  checkedChannel?: ApplicationUpdateChoice["channel"];
  value: ApplicationUpdateCheckResult;
};

function useApplicationUpdateOperation({
  preferences,
  changed,
  onStart,
  onComplete,
  automaticNotice,
  initialChannel,
}: {
  preferences: ApplicationUpdatePreferences | undefined;
  changed: boolean;
  onStart: () => void;
  onComplete: () => Promise<void>;
  automaticNotice?: ApplicationUpdateNoticeSnapshot["notice"] | undefined;
  initialChannel: ApplicationUpdateChoice["channel"];
}): ApplicationUpdateOperationState {
  const requests = useRef(new LatestRequestGeneration());
  const running = useRef(false);
  const [checkChannel, setCheckChannel] = useState(initialChannel);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<"check" | "download">();
  const [phase, setPhase] = useState<ApplicationUpdateCheckPhase>();
  const [boundResult, setBoundResult] = useState<BoundUpdateResult>();
  const [error, setError] = useState<string>();
  const currentAutomaticResult =
    automaticNotice && automaticNotice.preference_revision === preferences?.revision
      ? {
          preferenceRevision: automaticNotice.preference_revision,
          value: automaticNotice.result,
        }
      : undefined;
  const eligibleBoundResult =
    boundResult &&
    (boundResult.checkedChannel
      ? boundResult.checkedChannel === checkChannel
      : boundResult.preferenceRevision === preferences?.revision)
      ? boundResult
      : undefined;
  const presentedResult = eligibleBoundResult ?? currentAutomaticResult;
  const result = presentedResult?.value;
  const resultChannel =
    presentedResult && "checkedChannel" in presentedResult
      ? presentedResult.checkedChannel
      : preferences?.choice?.channel;
  const isOneTimeResult = Boolean(
    presentedResult && "checkedChannel" in presentedResult && presentedResult.checkedChannel,
  );

  useEffect(() => {
    const tracker = requests.current;
    return () => {
      tracker.begin();
    };
  }, []);

  const run = async (
    operation: "check" | "download",
    execute: (onEvent: (nextPhase: ApplicationUpdateCheckPhase) => void) => Promise<{
      value: ApplicationUpdateCheckResult;
      checkedChannel?: ApplicationUpdateChoice["channel"];
    }>,
  ) => {
    if (running.current) return;
    running.current = true;
    const request = requests.current.begin();
    const preferenceRevision = preferences?.revision;
    setBusy(true);
    setActive(operation);
    setPhase("checking");
    setBoundResult(undefined);
    setError(undefined);
    onStart();
    try {
      const nextResult = await execute((nextPhase) => {
        if (requests.current.isCurrent(request)) setPhase(nextPhase);
      });
      if (!requests.current.isCurrent(request)) return;
      setBoundResult({ preferenceRevision, ...nextResult });
      if (operation === "download") await onComplete();
    } catch (value) {
      if (requests.current.isCurrent(request)) setError(errorText(value));
    } finally {
      running.current = false;
      if (requests.current.isCurrent(request)) {
        setBusy(false);
        setActive(undefined);
        setPhase(undefined);
      }
    }
  };

  const check = () =>
    run("check", async (onEvent) => {
      const checked = await desktopApi.checkApplicationUpdate(onEvent, { channel: checkChannel });
      if (
        checked.checked_channel !== checkChannel ||
        (checked.result.candidate && checked.result.candidate.channel !== checkChannel)
      )
        throw new Error("The update check returned a different channel. Check again.");
      if (checked.result.staged)
        throw new Error(
          "The one-time check returned an unexpected download result. Refresh update activity to review it.",
        );
      return { value: checked.result, checkedChannel: checked.checked_channel };
    });

  const changeCheckChannel = (channel: ApplicationUpdateChoice["channel"]) => {
    if (running.current || channel === checkChannel) return;
    requests.current.begin();
    setBoundResult(undefined);
    setError(undefined);
    setCheckChannel(channel);
  };

  const download = async () => {
    const choice = preferences?.choice;
    if (
      !choice ||
      choice.paused ||
      changed ||
      choice.channel !== resultChannel ||
      result?.kind !== "update-available" ||
      !result.candidate ||
      result.staged
    )
      return;
    const expectedCandidate = result.candidate;
    await run("download", async (onEvent) => ({
      value: await desktopApi.downloadApplicationUpdate(
        {
          expected_preference_revision: preferences.revision,
          expected_candidate: expectedCandidate,
        },
        onEvent,
      ),
    }));
  };

  const cancel = async () => {
    setError(undefined);
    try {
      await desktopApi.cancelApplicationUpdateCheck();
    } catch (value) {
      setError(errorText(value));
    }
  };

  return {
    busy,
    active,
    phase,
    result,
    error,
    check,
    download,
    cancel,
    checkChannel,
    changeCheckChannel,
    resultChannel,
    isOneTimeResult,
  };
}

function downloadSettingsBlocker(
  preferences: ApplicationUpdatePreferences | undefined,
  changed: boolean,
  channel: ApplicationUpdateChoice["channel"] | undefined,
) {
  if (!preferences?.choice)
    return "Choose and save update settings before downloading. This check does not enable automatic updates.";
  if (changed) return "Save or discard your update settings changes before downloading.";
  if (preferences.choice.paused) return "Resume application update activity before downloading.";
  if (channel !== preferences.choice.channel)
    return `Save ${channel === "stable" ? "Stable" : "Preview"} as your update channel before downloading this result.`;
  return undefined;
}

function ApplicationUpdateCheckResultItem({
  result,
  downloadDisabled,
  onDownload,
}: {
  result: ApplicationUpdateCheckResult;
  downloadDisabled: boolean;
  onDownload: () => Promise<void>;
}) {
  const copy = applicationUpdateCheckCopy(result);
  const candidateCanDownload =
    result.kind === "update-available" && Boolean(result.candidate) && !result.staged;
  return (
    <div className={updateStatusItemClass} role="status">
      <strong>{copy.title}</strong>
      <p className={updateMutedCopyClass}>{copy.description}</p>
      {result.reasons.length > 0 && (
        <ul>
          {result.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {candidateCanDownload && (
        <Button
          data-focusable
          variant="primary"
          size="sm"
          disabled={downloadDisabled}
          onClick={() => void onDownload()}
        >
          Download and verify update
        </Button>
      )}
    </div>
  );
}

function ApplicationUpdateCheckPanel({
  disabled,
  settingsBusy,
  changed,
  preferences,
  operation,
}: {
  disabled: boolean;
  settingsBusy: boolean;
  changed: boolean;
  preferences: ApplicationUpdatePreferences | undefined;
  operation: ApplicationUpdateOperationState;
}) {
  const actionsDisabled = disabled;
  const blocker = downloadSettingsBlocker(preferences, changed, operation.resultChannel);

  return (
    <section
      className={updatePanelClass}
      aria-labelledby="application-check-title"
      aria-busy={operation.busy}
    >
      <div className={updatePanelHeadingClass}>
        <div className="grid gap-1">
          <h3 id="application-check-title" tabIndex={-1}>
            Check for application updates
          </h3>
          <p className={updateMutedCopyClass}>
            Check once without changing your update settings. This checks trusted release metadata;
            it does not download or install Portcove.
          </p>
        </div>
        {operation.busy ? (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void operation.cancel()}
          >
            {operation.active === "download" ? "Cancel download" : "Cancel check"}
          </Button>
        ) : (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={actionsDisabled}
            onClick={() => void operation.check()}
          >
            Check for updates
          </Button>
        )}
      </div>
      <div role="group" aria-label="One-time update channel" className="flex flex-wrap gap-2">
        <span className="self-center text-sm text-pc-muted-foreground">Channel for this check</span>
        {(["stable", "preview"] as const).map((channel) => (
          <Button
            key={channel}
            data-focusable
            variant={operation.checkChannel === channel ? "selected" : "outline"}
            size="sm"
            aria-pressed={operation.checkChannel === channel}
            disabled={actionsDisabled || operation.busy}
            onClick={() => operation.changeCheckChannel(channel)}
          >
            {channel === "stable" ? "Stable" : "Preview"}
          </Button>
        ))}
      </div>
      {operation.busy && operation.phase && (
        <p role="status">{checkProgressCopy[operation.phase]}</p>
      )}
      {operation.result && (
        <p className={updateMutedCopyClass}>
          {operation.isOneTimeResult ? "One-time check" : "Saved update activity"} ·{" "}
          {operation.resultChannel === "stable" ? "Stable" : "Preview"}
        </p>
      )}
      {operation.result?.kind === "update-available" && blocker && (
        <p className={updateDisclosureClass}>{blocker}</p>
      )}
      {operation.result && (
        <ApplicationUpdateCheckResultItem
          result={operation.result}
          downloadDisabled={actionsDisabled || settingsBusy || Boolean(blocker)}
          onDownload={operation.download}
        />
      )}
      {operation.error && <p role="alert">{operation.error}</p>}
    </section>
  );
}

function useApplicationUpdateSettings({
  currentVersion,
  generation = 0,
  disabled = false,
  automaticNotice,
  preferencesState,
}: {
  currentVersion: string;
  generation?: number | undefined;
  disabled?: boolean;
  automaticNotice?: ApplicationUpdateNoticeSnapshot["notice"] | undefined;
  preferencesState?: ApplicationUpdatePreferencesState | undefined;
}) {
  const requests = useRef(new LatestRequestGeneration());
  const statusRequests = useRef(new LatestRequestGeneration());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const preferences = preferencesState?.preferences;
  const refreshPreferences = preferencesState?.refresh;
  const [status, setStatus] = useState<ApplicationUpdateStatus>();
  const [draftState, setDraftState] = useState<{
    source: ApplicationUpdatePreferences | undefined;
    choice: ApplicationUpdateChoice;
  }>({ source: undefined, choice: recommendedChoice });
  const draft =
    draftState.source === preferences
      ? draftState.choice
      : (preferences?.choice ?? recommendedChoice);
  const setDraft = (next: SetStateAction<ApplicationUpdateChoice>) =>
    setDraftState({
      source: preferences,
      choice: typeof next === "function" ? next(draft) : next,
    });
  const [actionBusy, setBusy] = useState("");
  const busy = preferencesState?.loading ? "Loading application update settings…" : actionBusy;
  const [statusBusy, setStatusBusy] = useState("Loading application update status…");
  const [error, setError] = useState<string>();
  const canRecoverPreferences = isRecoverableStateError(preferencesState?.failure);
  const [statusError, setStatusError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const changed = Boolean(preferences && !choicesMatch(preferences.choice, draft));

  const applyPreferences = (value: ApplicationUpdatePreferences) => {
    const accepted = preferencesState?.accept(value);
    if (accepted) setDraft(accepted.choice ?? recommendedChoice);
  };

  const load = async () => {
    const request = requests.current.begin();
    setBusy("Loading application update settings…");
    setError(undefined);
    setNotice(undefined);
    try {
      const value = await preferencesState?.refresh();
      if (value && requests.current.isCurrent(request)) setDraft(value.choice ?? recommendedChoice);
    } catch (value) {
      if (requests.current.isCurrent(request)) {
        setError(errorText(value));
      }
    } finally {
      if (requests.current.isCurrent(request)) setBusy("");
    }
  };

  const loadStatus = async () => {
    const request = statusRequests.current.begin();
    setStatusBusy("Refreshing application update status…");
    setStatusError(undefined);
    try {
      const value = await desktopApi.applicationUpdateStatus();
      if (statusRequests.current.isCurrent(request)) setStatus(value);
    } catch (value) {
      if (statusRequests.current.isCurrent(request)) setStatusError(errorText(value));
    } finally {
      if (statusRequests.current.isCurrent(request)) setStatusBusy("");
    }
  };

  const updateOperation = useApplicationUpdateOperation({
    initialChannel:
      Number(currentVersion.split(".")[0]) >= 1 && !currentVersion.includes("-")
        ? "stable"
        : "preview",
    preferences,
    changed,
    onStart: () => setNotice(undefined),
    onComplete: loadStatus,
    automaticNotice,
  });

  useEffect(() => {
    const requestTracker = requests.current;
    // Re-entry refreshes external changes; a concurrent startup read is coalesced.
    void refreshPreferences?.().catch(() => {});
    const statusTracker = statusRequests.current;
    const statusRequest = statusTracker.begin();
    void desktopApi
      .applicationUpdateStatus()
      .then((value) => {
        if (statusTracker.isCurrent(statusRequest)) setStatus(value);
      })
      .catch((value: unknown) => {
        if (statusTracker.isCurrent(statusRequest)) setStatusError(errorText(value));
      })
      .finally(() => {
        if (statusTracker.isCurrent(statusRequest)) setStatusBusy("");
      });
    return () => {
      requestTracker.begin();
      statusTracker.begin();
    };
  }, [refreshPreferences]);

  const save = async () => {
    if (!preferences || choicesMatch(preferences.choice, draft)) return;
    const request = requests.current.begin();
    setBusy("Saving application update settings…");
    setError(undefined);
    setNotice(undefined);
    try {
      const value = await desktopApi.setApplicationUpdatePreferences(preferences.revision, draft);
      if (!requests.current.isCurrent(request)) return;
      applyPreferences(value);
      setNotice("Update settings saved. Saving these settings does not start an update.");
    } catch (value) {
      if (!requests.current.isCurrent(request)) return;
      const message = errorText(value);
      try {
        const current = await preferencesState?.refresh();
        if (current && requests.current.isCurrent(request)) {
          setDraft(current.choice ?? recommendedChoice);
          setError(`${message} Current settings were refreshed; review them before saving again.`);
        }
      } catch {
        if (requests.current.isCurrent(request)) setError(message);
      }
    } finally {
      if (requests.current.isCurrent(request)) setBusy("");
    }
  };

  const reset = async () => {
    if (preferences && !preferences.choice) return;
    const recovering = !preferences;
    const request = requests.current.begin();
    setBusy(
      recovering
        ? "Resetting damaged application update settings…"
        : "Clearing the saved application update choice…",
    );
    setError(undefined);
    setNotice(undefined);
    try {
      const value = preferences
        ? await desktopApi.resetApplicationUpdatePreferences()
        : await desktopApi.recoverApplicationUpdatePreferences();
      if (!requests.current.isCurrent(request)) return;
      if (recovering) preferencesState?.acceptRecovered(value);
      else applyPreferences(value);
      setNotice(
        recovering
          ? "Damaged update settings reset. No choice is saved, and automatic application update checks remain off."
          : "Update preferences reset. Automatic checks remain off until you save a new choice.",
      );
    } catch (value) {
      if (requests.current.isCurrent(request)) setError(errorText(value));
    } finally {
      if (requests.current.isCurrent(request)) setBusy("");
    }
  };

  const recover = async (area: ApplicationUpdateRecoveryArea) => {
    const request = statusRequests.current.begin();
    setStatusBusy(`Repairing ${area} state…`);
    setStatusError(undefined);
    setNotice(undefined);
    try {
      const value = await desktopApi.recoverApplicationUpdateState(area);
      if (!statusRequests.current.isCurrent(request)) return;
      setStatus(value);
      setNotice(
        {
          schedule: "Update-check history reset.",
          staging: "Damaged update download deleted. Download the update again.",
          apply: value.staged
            ? "Pending update request cleared. The verified download remains available."
            : "Pending update request cleared. No verified download is currently available.",
        }[area],
      );
    } catch (value) {
      if (statusRequests.current.isCurrent(request)) setStatusError(errorText(value));
    } finally {
      if (statusRequests.current.isCurrent(request)) setStatusBusy("");
    }
  };

  const restartToUpdate = async () => {
    setBusy("Preparing a safe restart to update…");
    setError(undefined);
    setNotice(undefined);
    try {
      await desktopApi.restartToApplyApplicationUpdate(generation);
      setBusy("Restarting Portcove to apply the verified update…");
    } catch (value) {
      setError(errorText(value));
      setBusy("");
      await loadStatus();
    }
  };

  const unavailable = disabled || Boolean(busy) || !preferences;

  useEffect(() => {
    const heading = headingRef.current;
    if (unavailable || !heading) return;
    const settings = heading.closest(".application-update-settings");
    const preferencesHeading = settings?.querySelector("#application-preferences-title");
    const active = document.activeElement;
    if (active !== heading && active !== preferencesHeading) return;
    focusAndReveal(
      settings?.querySelector<HTMLElement>(
        active === preferencesHeading
          ? '[aria-label="Application update channel"] button:not(:disabled)'
          : "button:not(:disabled)",
      ),
    );
  }, [unavailable]);

  return {
    currentVersion,
    disabled,
    preferencesState,
    headingRef,
    preferences,
    draft,
    setDraft,
    busy,
    status,
    statusBusy,
    error,
    canRecoverPreferences,
    statusError,
    notice,
    changed,
    updateOperation,
    load,
    save,
    reset,
    recover,
    restartToUpdate,
    unavailable,
    loadStatus,
  };
}

export function ApplicationUpdateSettings(
  props: Parameters<typeof useApplicationUpdateSettings>[0],
) {
  const {
    currentVersion,
    disabled,
    preferencesState,
    headingRef,
    preferences,
    draft,
    setDraft,
    busy,
    status,
    statusBusy,
    error,
    canRecoverPreferences,
    statusError,
    notice,
    changed,
    updateOperation,
    load,
    save,
    reset,
    recover,
    restartToUpdate,
    unavailable,
    loadStatus,
  } = useApplicationUpdateSettings(props);
  const renderPreferences = () =>
    preferences && (
      <section
        className="grid gap-5"
        aria-labelledby="application-preferences-title"
        aria-busy={Boolean(busy)}
      >
        <h3 id="application-preferences-title" tabIndex={-1}>
          Future update behavior
        </h3>
        {!preferences.choice && (
          <p className="application-update-consent rounded-pc-md border border-[var(--color-warning-border)] bg-pc-warning-subtle p-3 text-pc-warning-foreground">
            No application update choice is saved. Automatic checks remain off until you save one.
          </p>
        )}

        <section className={updateChoiceClass} aria-labelledby="application-channel-label">
          <h3 id="application-channel-label" className="text-sm">
            Channel
          </h3>
          <div
            className="segmented grid [grid-auto-columns:1fr] [grid-auto-flow:column] rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-[3px]"
            role="group"
            aria-label="Application update channel"
          >
            {(["preview", "stable"] as const).map((channel) => (
              <Button
                key={channel}
                data-focusable
                variant={draft.channel === channel ? "selected" : "ghost"}
                className={updateChoiceButtonClass}
                aria-pressed={draft.channel === channel}
                disabled={unavailable}
                onClick={() => setDraft((value) => ({ ...value, channel }))}
              >
                {channel === "preview" ? "Preview" : "Stable"}
              </Button>
            ))}
          </div>
          <p className={updateMutedCopyClass}>
            {draft.channel === "preview"
              ? "Preview receives public test releases and later eligible final releases."
              : "Stable waits for an eligible production release that is newer than your installed version; it never downgrades Portcove."}
          </p>
        </section>

        <section className={updateChoiceClass} aria-labelledby="application-mode-label">
          <h3 id="application-mode-label" className="text-sm">
            Update mode
          </h3>
          <div
            className="segmented grid [grid-auto-columns:1fr] [grid-auto-flow:column] rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-[3px]"
            role="group"
            aria-label="Application update mode"
          >
            {(
              [
                ["automatic", "Automatic"],
                ["notify-only", "Notify only"],
                ["manual", "Manual"],
              ] as const
            ).map(([mode, label]) => (
              <Button
                key={mode}
                data-focusable
                variant={draft.mode === mode ? "selected" : "ghost"}
                className={updateChoiceButtonClass}
                aria-pressed={draft.mode === mode}
                disabled={unavailable}
                onClick={() => setDraft((value) => ({ ...value, mode }))}
              >
                {label}
                {mode === "automatic" && (
                  <small className="text-[length:var(--text-2xs)] normal-case">Recommended</small>
                )}
              </Button>
            ))}
          </div>
          <p className={updateMutedCopyClass}>
            {draft.mode === "automatic"
              ? "Allows Portcove to check and stage verified updates without asking for each release. Applying still waits for a safe exit or an explicit Restart to update action."
              : draft.mode === "notify-only"
                ? "Checks for eligible updates and tells you when one is available. Downloading and applying require explicit actions."
                : "Does not check automatically. Use Check for updates when you want to look for a release."}
          </p>
        </section>

        <div className="application-update-pause flex cursor-pointer items-start gap-3 rounded-pc-md bg-[var(--color-bg-subtle)] p-3">
          <input
            data-focusable
            className="mt-[3px] w-auto"
            id="pause-application-updates"
            type="checkbox"
            aria-describedby="pause-application-updates-description"
            checked={draft.paused}
            disabled={unavailable}
            onChange={(event) => setDraft((value) => ({ ...value, paused: event.target.checked }))}
          />
          <span className="grid gap-0.5">
            <label
              htmlFor="pause-application-updates"
              className="cursor-pointer font-bold text-pc-foreground"
            >
              Pause application update activity
            </label>
            <small id="pause-application-updates-description" className={updateMutedCopyClass}>
              Stop automatic checks and all downloads until resumed. Manual checks remain available.
            </small>
          </span>
        </div>

        <p className={updateDisclosureClass}>Saving these settings does not start an update.</p>
        <div className="flex flex-wrap gap-2">
          <Button
            data-focusable
            variant="primary"
            size="sm"
            disabled={unavailable || !changed}
            onClick={() => void save()}
          >
            Save application update settings
          </Button>
          <Button
            data-focusable
            variant="outline"
            size="sm"
            disabled={unavailable || !changed}
            onClick={() => setDraft(preferences.choice ?? recommendedChoice)}
          >
            Discard changes
          </Button>
          <Button
            data-focusable
            variant="destructive"
            size="sm"
            disabled={unavailable || !preferences.choice}
            onClick={() => void reset()}
          >
            Reset update preferences
          </Button>
        </div>
        <p className={updateDisclosureClass}>
          Reset update preferences clears your saved choice and turns off automatic checks until you
          choose again.
        </p>
      </section>
    );
  const restartAvailability = applicationRestartAvailability(
    disabled,
    Boolean(busy),
    updateOperation.busy,
    changed,
    preferences,
  );
  return (
    <SettingsRow
      className="application-update-settings grid min-h-0 gap-5"
      data-focus-group
      aria-labelledby="application-update-settings-title"
    >
      <div className="application-update-heading flex items-start justify-between gap-4 max-[65rem]:flex-col">
        <div>
          <p className="eyebrow mb-[6px] text-[length:var(--text-xs)] font-bold tracking-[0.16em] text-[var(--color-text-secondary)]">
            APPLICATION UPDATES
          </p>
          <h2 id="application-update-settings-title" ref={headingRef} tabIndex={-1}>
            Portcove updates
          </h2>
        </div>
        <p className="rounded-pc-md bg-[var(--color-bg-subtle)] px-3 py-2 text-xs whitespace-nowrap text-[var(--color-text-secondary)] max-[65rem]:whitespace-normal">
          Current version <strong>{currentVersion}</strong>
        </p>
      </div>

      <ApplicationUpdateCheckPanel
        disabled={disabled}
        settingsBusy={Boolean(busy)}
        changed={changed}
        preferences={preferences}
        operation={updateOperation}
      />

      {!preferences && !busy && (
        <div className="flex flex-wrap gap-2">
          <Button
            data-focusable
            variant="outline"
            size="sm"
            disabled={disabled || !preferencesState}
            onClick={() => void load()}
          >
            Retry loading settings
          </Button>
          {canRecoverPreferences && (
            <Button
              data-focusable
              variant="destructive"
              size="sm"
              disabled={disabled}
              onClick={() => void reset()}
            >
              Reset update settings
            </Button>
          )}
        </div>
      )}

      {renderPreferences()}

      <ApplicationUpdateStatusPanel
        status={status}
        busy={statusBusy}
        error={statusError}
        disabled={disabled}
        onRefresh={loadStatus}
        onRecover={recover}
        onRestart={restartToUpdate}
        {...restartAvailability}
      />

      {busy && <p role="status">{busy}</p>}
      {notice && <p role="status">{notice}</p>}
      {(error || preferencesState?.failure !== undefined) && (
        <p role="alert">{error ?? errorText(preferencesState?.failure)}</p>
      )}
    </SettingsRow>
  );
}

function applicationRestartAvailability(
  disabled: boolean,
  busy: boolean,
  operationBusy: boolean,
  changed: boolean,
  preferences: ApplicationUpdatePreferences | undefined,
) {
  return {
    restartDisabled: disabled || busy || operationBusy || changed || !preferences?.choice,
    restartBlocker: !preferences?.choice
      ? "Save your update settings before restarting to update."
      : changed
        ? "Save or discard your changes before restarting to update."
        : undefined,
  };
}
