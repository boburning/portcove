import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { LatestRequestGeneration } from "../concurrency-state";
import type {
  ApplicationUpdateChoice,
  ApplicationUpdateCheckPhase,
  ApplicationUpdateCheckResult,
  ApplicationUpdatePreferences,
  ApplicationUpdateRecoveryArea,
  ApplicationUpdateStatus,
} from "../types";
import { errorText } from "../view-model";

const recommendedChoice: ApplicationUpdateChoice = {
  channel: "preview",
  mode: "automatic",
  paused: false,
};

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
    description: "Reset its check timing and retry history. Your update choice stays unchanged.",
    action: "Repair update check history",
  },
  staging: {
    title: "The staged update needs repair",
    description:
      "Clear the damaged staged download. Portcove will require a fresh verified download.",
    action: "Clear damaged staged update",
  },
  apply: {
    title: "The pending update request needs repair",
    description: "Clear the damaged exit or restart request. The verified staged download is kept.",
    action: "Clear damaged update request",
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
    title: "Update launch needs confirmation",
    description:
      "Portcove may have started the installer. It needs to check which version is installed before it can safely launch another one.",
  },
  started: {
    title: "Installer process started",
    description:
      "Portcove recorded that the installer process started. It needs to check which version is installed before it can safely offer another update action.",
  },
  failed: {
    title: "Installer did not start",
    description:
      "No installer process was created. A retry will still repeat the fresh trust, consent, ownership, compatibility and idle-state checks.",
  },
  "installer-succeeded": {
    title: "Installer process completed",
    description:
      "The installer reported success. Portcove still needs to confirm the installed version and application health before clearing the update request.",
  },
  "installer-failed": {
    title: "Installer process did not complete",
    description:
      "The installer process exited unsuccessfully and is no longer running. A retry will repeat every update safety check.",
  },
} as const;

const checkProgressCopy: Record<ApplicationUpdateCheckPhase, string> = {
  checking: "Checking signed application update metadata…",
  "acquiring-and-verifying": "Downloading and verifying the application update…",
  staged: "The verified application update is staged.",
  complete: "Application update check complete.",
};

function applicationUpdateCheckCopy(result: ApplicationUpdateCheckResult) {
  const version = result.candidate?.version;
  switch (result.kind) {
    case "update-available":
      return result.staged
        ? `${version ?? "The update"} is verified and staged for a safe apply request.`
        : `${version ?? "An update"} is available. Its download has not started.`;
    case "current":
      return "Portcove is current on the selected application update channel.";
    case "held":
      return "An eligible update is being held by its signed release policy.";
    case "incompatible":
      return "The available release is not compatible with this installation.";
    case "no-candidate":
      return "No eligible release is published for the selected channel.";
    case "superseded":
      return "Your update choice changed during the check. Run it again for the current choice.";
    case "consent-required":
      return "Save an application update choice before checking.";
    case "offline":
      return "The host reports that the network is offline.";
    case "paused":
    case "manual-mode":
    case "metered":
    case "metered-state-unknown":
    case "startup-delay":
    case "cadence":
      return "The application update check is deferred by the saved host policy.";
  }
}

function applicationUpdateApplyCopy(apply: NonNullable<ApplicationUpdateStatus["apply"]>) {
  if (apply.native_launch) return nativeLaunchCopy[apply.native_launch];

  return {
    title:
      apply.request === "restart-to-apply"
        ? "Restart to update requested"
        : "Update on safe exit requested",
    description: apply.termination
      ? `Portcove recorded ${apply.termination.replaceAll("-", " ")}. Fresh trust, consent, ownership, compatibility and idle-state checks still run before replacement.`
      : "The request is saved. Closing or restarting Portcove does not bypass fresh trust, consent, ownership, compatibility or idle-state checks.",
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
      <div className="application-update-recovery" role="alert" key={recovery.area}>
        <div>
          <strong>{copy.title}</strong>
          <p>{copy.description}</p>
        </div>
        <button
          data-focusable
          disabled={disabled || busy}
          onClick={() => void onRecover(recovery.area)}
        >
          {copy.action}
        </button>
      </div>
    );
  });
}

function restartIsAvailable(status: ApplicationUpdateStatus) {
  const failedAttempt =
    status.apply?.native_launch === "failed" || status.apply?.native_launch === "installer-failed";
  return Boolean(
    status.staged &&
    !status.recovery_required.some(({ area }) => area === "apply") &&
    (!status.apply ||
      (status.apply.request === "restart-to-apply" &&
        (failedAttempt ||
          (status.apply.native_launch === null &&
            status.apply.termination === "restart-to-apply")))),
  );
}

function StagedApplicationUpdateItem({
  status,
  disabled,
  onRestart,
}: {
  status: ApplicationUpdateStatus;
  disabled: boolean;
  onRestart: () => Promise<void>;
}) {
  if (!status.staged) return null;
  return (
    <div className="application-update-status-item">
      <strong>Verified update staged</strong>
      <p>
        {status.staged.channel === "preview" ? "Preview" : "Stable"} version {status.staged.version}{" "}
        ({formatBytes(status.staged.bytes)}) is ready for a safe apply request.
      </p>
      {restartIsAvailable(status) && (
        <button
          data-focusable
          className="primary"
          disabled={disabled}
          onClick={() => void onRestart()}
        >
          {status.apply ? "Retry restart to update" : "Restart to update"}
        </button>
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
    <p className="application-update-schedule">
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
}: {
  status: ApplicationUpdateStatus | undefined;
  busy: string;
  error: string | undefined;
  disabled: boolean;
  onRefresh: () => Promise<void>;
  onRecover: (area: ApplicationUpdateRecoveryArea) => Promise<void>;
  onRestart: () => Promise<void>;
  restartDisabled: boolean;
}) {
  const applyCopy = status?.apply ? applicationUpdateApplyCopy(status.apply) : undefined;

  return (
    <section className="application-update-status" aria-labelledby="application-status-title">
      <div className="application-update-status-heading">
        <div>
          <h3 id="application-status-title">Update activity</h3>
          <p>Host-owned status. Verified candidates are rechecked before replacement.</p>
        </div>
        <button
          data-focusable
          className="small-control"
          disabled={disabled || Boolean(busy)}
          onClick={() => void onRefresh()}
        >
          Refresh update status
        </button>
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
            onRestart={onRestart}
          />

          {applyCopy && (
            <div className="application-update-status-item">
              <strong>{applyCopy.title}</strong>
              <p>{applyCopy.description}</p>
            </div>
          )}

          {!status.staged && !status.apply && status.recovery_required.length === 0 && (
            <p className="application-update-idle">No verified application update is staged.</p>
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
  busy: boolean;
  active: "check" | "download" | undefined;
  phase: ApplicationUpdateCheckPhase | undefined;
  result: ApplicationUpdateCheckResult | undefined;
  error: string | undefined;
  check: () => Promise<void>;
  download: () => Promise<void>;
  cancel: () => Promise<void>;
};

type RevisionBoundCheckResult = {
  preferenceRevision: number | undefined;
  value: ApplicationUpdateCheckResult;
};

function useApplicationUpdateOperation({
  preferences,
  changed,
  onStart,
  onComplete,
}: {
  preferences: ApplicationUpdatePreferences | undefined;
  changed: boolean;
  onStart: () => void;
  onComplete: () => Promise<void>;
}): ApplicationUpdateOperationState {
  const requests = useRef(new LatestRequestGeneration());
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<"check" | "download">();
  const [phase, setPhase] = useState<ApplicationUpdateCheckPhase>();
  const [boundResult, setBoundResult] = useState<RevisionBoundCheckResult>();
  const [error, setError] = useState<string>();
  const result =
    boundResult?.preferenceRevision === preferences?.revision ? boundResult?.value : undefined;

  useEffect(() => {
    const tracker = requests.current;
    return () => {
      tracker.begin();
    };
  }, []);

  const run = async (
    operation: "check" | "download",
    execute: (
      onEvent: (nextPhase: ApplicationUpdateCheckPhase) => void,
    ) => Promise<ApplicationUpdateCheckResult>,
  ) => {
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
      setBoundResult({ preferenceRevision, value: nextResult });
      await onComplete();
    } catch (value) {
      if (requests.current.isCurrent(request)) setError(errorText(value));
    } finally {
      if (requests.current.isCurrent(request)) {
        setBusy(false);
        setActive(undefined);
        setPhase(undefined);
      }
    }
  };

  const check = () => run("check", desktopApi.checkApplicationUpdate);

  const download = async () => {
    const choice = preferences?.choice;
    if (
      !choice ||
      choice.paused ||
      changed ||
      result?.kind !== "update-available" ||
      !result.candidate ||
      result.staged
    )
      return;
    const expectedCandidate = result.candidate;
    await run("download", (onEvent) =>
      desktopApi.downloadApplicationUpdate(
        {
          expected_preference_revision: preferences.revision,
          expected_candidate: expectedCandidate,
        },
        onEvent,
      ),
    );
  };

  const cancel = async () => {
    setError(undefined);
    try {
      await desktopApi.cancelApplicationUpdateCheck();
    } catch (value) {
      setError(errorText(value));
    }
  };

  return { busy, active, phase, result, error, check, download, cancel };
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
  const candidateCanDownload =
    operation.result?.kind === "update-available" &&
    Boolean(operation.result.candidate) &&
    !operation.result.staged;
  const actionsDisabled = disabled || settingsBusy || changed || !preferences?.choice;

  return (
    <section
      className="application-update-status"
      aria-labelledby="application-check-title"
      aria-busy={operation.busy}
    >
      <div className="application-update-status-heading">
        <div>
          <h3 id="application-check-title">Check for application updates</h3>
          <p>
            Uses the saved channel and host-compiled signed repository. Manual checks never use a
            URL supplied by this screen.
          </p>
        </div>
        {operation.busy ? (
          <button data-focusable className="small-control" onClick={() => void operation.cancel()}>
            {operation.active === "download" ? "Cancel download" : "Cancel check"}
          </button>
        ) : (
          <button
            data-focusable
            className="small-control"
            disabled={actionsDisabled}
            onClick={() => void operation.check()}
          >
            Check for updates
          </button>
        )}
      </div>
      {operation.busy && operation.phase && (
        <p role="status">{checkProgressCopy[operation.phase]}</p>
      )}
      {operation.result && (
        <div className="application-update-status-item" role="status">
          <strong>Check complete</strong>
          <p>{applicationUpdateCheckCopy(operation.result)}</p>
          {operation.result.reasons.length > 0 && (
            <ul>
              {operation.result.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {candidateCanDownload && (
            <button
              data-focusable
              className="primary"
              disabled={actionsDisabled || Boolean(preferences?.choice?.paused)}
              onClick={() => void operation.download()}
            >
              Download and verify update
            </button>
          )}
        </div>
      )}
      {operation.error && <p role="alert">{operation.error}</p>}
    </section>
  );
}

export function ApplicationUpdateSettings({
  currentVersion,
  generation = 0,
  disabled = false,
}: {
  currentVersion: string;
  generation?: number;
  disabled?: boolean;
}) {
  const requests = useRef(new LatestRequestGeneration());
  const statusRequests = useRef(new LatestRequestGeneration());
  const [preferences, setPreferences] = useState<ApplicationUpdatePreferences>();
  const [status, setStatus] = useState<ApplicationUpdateStatus>();
  const [draft, setDraft] = useState<ApplicationUpdateChoice>(recommendedChoice);
  const [busy, setBusy] = useState("Loading application update settings…");
  const [statusBusy, setStatusBusy] = useState("Loading application update status…");
  const [error, setError] = useState<string>();
  const [canRecoverPreferences, setCanRecoverPreferences] = useState(false);
  const [statusError, setStatusError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const changed = Boolean(preferences && !choicesMatch(preferences.choice, draft));

  const applyPreferences = (value: ApplicationUpdatePreferences) => {
    setPreferences(value);
    setDraft(value.choice ?? recommendedChoice);
    setCanRecoverPreferences(false);
  };

  const load = async () => {
    const request = requests.current.begin();
    setBusy("Loading application update settings…");
    setError(undefined);
    setCanRecoverPreferences(false);
    setNotice(undefined);
    try {
      const value = await desktopApi.applicationUpdatePreferences();
      if (requests.current.isCurrent(request)) applyPreferences(value);
    } catch (value) {
      if (requests.current.isCurrent(request)) {
        setError(errorText(value));
        setCanRecoverPreferences(isRecoverableStateError(value));
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
    preferences,
    changed,
    onStart: () => setNotice(undefined),
    onComplete: loadStatus,
  });

  useEffect(() => {
    const requestTracker = requests.current;
    const request = requestTracker.begin();
    void desktopApi
      .applicationUpdatePreferences()
      .then((value) => {
        if (requestTracker.isCurrent(request)) {
          setPreferences(value);
          setDraft(value.choice ?? recommendedChoice);
        }
      })
      .catch((value: unknown) => {
        if (requestTracker.isCurrent(request)) {
          setError(errorText(value));
          setCanRecoverPreferences(isRecoverableStateError(value));
        }
      })
      .finally(() => {
        if (requestTracker.isCurrent(request)) setBusy("");
      });
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
  }, []);

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
      setNotice(
        "Application update settings saved. No update check, download, install, or restart was started.",
      );
    } catch (value) {
      if (!requests.current.isCurrent(request)) return;
      const message = errorText(value);
      try {
        const current = await desktopApi.applicationUpdatePreferences();
        if (requests.current.isCurrent(request)) {
          applyPreferences(current);
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
      applyPreferences(value);
      setNotice(
        recovering
          ? "Damaged update settings reset. No choice is saved, and automatic application update checks remain off."
          : "Saved choice cleared. Automatic application update checks remain off.",
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
      setNotice(`Application update ${area} state repaired.`);
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

  return (
    <article
      className="settings-card application-update-settings"
      data-focus-group
      aria-labelledby="application-update-settings-title"
      aria-busy={Boolean(busy)}
    >
      <div className="application-update-heading">
        <div>
          <p className="eyebrow">APPLICATION UPDATES</p>
          <h2 id="application-update-settings-title">Choose how Portcove updates</h2>
        </div>
        <p>
          Current version <strong>{currentVersion}</strong>
        </p>
      </div>

      {!preferences && !busy && (
        <div className="actions compact">
          <button
            data-focusable
            className="small-control"
            disabled={disabled}
            onClick={() => void load()}
          >
            Retry loading settings
          </button>
          {canRecoverPreferences && (
            <button data-focusable disabled={disabled} onClick={() => void reset()}>
              Reset update settings
            </button>
          )}
        </div>
      )}

      {preferences && (
        <>
          {!preferences.choice && (
            <p className="application-update-consent">
              No application update choice is saved. Automatic checks remain off until you save one.
            </p>
          )}

          <section
            className="application-update-choice"
            aria-labelledby="application-channel-label"
          >
            <h3 id="application-channel-label">Channel</h3>
            <div className="segmented" role="group" aria-label="Application update channel">
              {(["preview", "stable"] as const).map((channel) => (
                <button
                  key={channel}
                  data-focusable
                  className={draft.channel === channel ? "active" : ""}
                  aria-pressed={draft.channel === channel}
                  disabled={unavailable}
                  onClick={() => setDraft((value) => ({ ...value, channel }))}
                >
                  {channel === "preview" ? "Preview" : "Stable"}
                </button>
              ))}
            </div>
            <p>
              {draft.channel === "preview"
                ? "Preview receives public test releases and later eligible final releases."
                : "Stable waits for an eligible production release that is newer than your installed version; it never downgrades Portcove."}
            </p>
          </section>

          <section className="application-update-choice" aria-labelledby="application-mode-label">
            <h3 id="application-mode-label">Update mode</h3>
            <div className="segmented" role="group" aria-label="Application update mode">
              {(
                [
                  ["automatic", "Automatic"],
                  ["notify-only", "Notify only"],
                  ["manual", "Manual"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  data-focusable
                  className={draft.mode === mode ? "active" : ""}
                  aria-pressed={draft.mode === mode}
                  disabled={unavailable}
                  onClick={() => setDraft((value) => ({ ...value, mode }))}
                >
                  {label}
                  {mode === "automatic" && <small>Recommended</small>}
                </button>
              ))}
            </div>
            <p>
              {draft.mode === "automatic"
                ? "Allows Portcove to check and stage verified updates without asking for each release. Applying still waits for a safe exit or an explicit Restart to update action."
                : draft.mode === "notify-only"
                  ? "Checks for eligible updates and tells you when one is available. Downloading and applying require explicit actions."
                  : "Does not check automatically. Use Check for updates when you want to look for a release."}
            </p>
          </section>

          <div className="application-update-pause">
            <input
              data-focusable
              id="pause-application-updates"
              type="checkbox"
              aria-describedby="pause-application-updates-description"
              checked={draft.paused}
              disabled={unavailable}
              onChange={(event) =>
                setDraft((value) => ({ ...value, paused: event.target.checked }))
              }
            />
            <span>
              <label htmlFor="pause-application-updates">Pause application update activity</label>
              <small id="pause-application-updates-description">
                Stop automatic checks and all downloads until resumed. Manual checks remain
                available.
              </small>
            </span>
          </div>

          <p className="application-update-disclosure">
            Saving changes only stores this preference. It does not check, download, install, or
            restart Portcove.
          </p>
          <div className="actions compact">
            <button
              data-focusable
              className="primary"
              disabled={unavailable || !changed}
              onClick={() => void save()}
            >
              Save application update settings
            </button>
            <button
              data-focusable
              disabled={unavailable || !changed}
              onClick={() => setDraft(preferences.choice ?? recommendedChoice)}
            >
              Discard changes
            </button>
            <button
              data-focusable
              disabled={unavailable || !preferences.choice}
              onClick={() => void reset()}
            >
              Clear saved choice
            </button>
          </div>
        </>
      )}

      <ApplicationUpdateCheckPanel
        disabled={disabled}
        settingsBusy={Boolean(busy)}
        changed={changed}
        preferences={preferences}
        operation={updateOperation}
      />

      <ApplicationUpdateStatusPanel
        status={status}
        busy={statusBusy}
        error={statusError}
        disabled={disabled}
        onRefresh={loadStatus}
        onRecover={recover}
        onRestart={restartToUpdate}
        restartDisabled={
          disabled || Boolean(busy) || updateOperation.busy || changed || !preferences?.choice
        }
      />

      {busy && <p role="status">{busy}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
