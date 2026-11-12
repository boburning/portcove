import { ExternalLink } from "../../components/ExternalLink";
import { SettingsRow } from "../../components/ui/patterns";
import { useEffect, useRef, useState, type SetStateAction } from "react";
import type { TFunction } from "i18next";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../../localization";
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
import { Checkbox } from "../../components/ui/checkbox";
import { focusAndReveal } from "../../focus";
import type { Perform } from "../operations/use-operation-state";

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

// Copy functions take `TFunction<"applicationUpdate">` so extraction keeps each
// static key in its namespace. State stores message identities, never English.
function recoveryCopy(t: TFunction<"applicationUpdate">, area: ApplicationUpdateRecoveryArea) {
  switch (area) {
    case "schedule":
      return {
        title: t("status.recoveryScheduleTitle"),
        description: t("status.recoveryScheduleDescription"),
        action: t("status.recoveryScheduleAction"),
      };
    case "staging":
      return {
        title: t("status.recoveryStagingTitle"),
        description: t("status.recoveryStagingDescription"),
        action: t("status.recoveryStagingAction"),
      };
    case "apply":
      return {
        title: t("status.recoveryApplyTitle"),
        description: t("status.recoveryApplyDescription"),
        action: t("status.recoveryApplyAction"),
      };
  }
}

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

function checkProgressCopy(t: TFunction<"applicationUpdate">, phase: ApplicationUpdateCheckPhase) {
  switch (phase) {
    case "checking":
      return t("check.progress_checking");
    case "acquiring-and-verifying":
      return t("check.progress_acquiringAndVerifying");
    case "staged":
      return t("check.progress_staged");
    case "complete":
      return t("check.progress_complete");
  }
}

function applicationUpdateCheckCopy(
  t: TFunction<"applicationUpdate">,
  result: ApplicationUpdateCheckResult,
) {
  const version = result.candidate?.version;
  const completeTitle = t("result.completeTitle");
  switch (result.kind) {
    case "update-available":
      return result.staged
        ? {
            title: t("result.stagedTitle"),
            description: version
              ? t("result.stagedDescription", { version })
              : t("result.stagedDescriptionNoVersion"),
          }
        : {
            title: completeTitle,
            description: version
              ? t("result.availableDescription", { version })
              : t("result.availableDescriptionNoVersion"),
          };
    case "current":
      return { title: completeTitle, description: t("result.current") };
    case "held":
      return { title: completeTitle, description: t("result.held") };
    case "incompatible":
      return { title: completeTitle, description: t("result.incompatible") };
    case "no-candidate":
      return { title: completeTitle, description: t("result.noCandidate") };
    case "superseded":
      return { title: t("result.supersededTitle"), description: t("result.superseded") };
    case "consent-required":
      return {
        title: t("result.consentRequiredTitle"),
        description: t("result.consentRequired"),
      };
    case "offline":
      return { title: t("result.offlineTitle"), description: t("result.offline") };
    case "paused":
      return { title: t("result.pausedTitle"), description: t("result.paused") };
    case "manual-mode":
      return { title: t("result.manualModeTitle"), description: t("result.manualMode") };
    case "metered":
      return { title: t("result.meteredTitle"), description: t("result.metered") };
    case "metered-state-unknown":
      return { title: t("result.meteredTitle"), description: t("result.meteredUnknown") };
    case "startup-delay":
    case "cadence":
      return { title: t("result.scheduledTitle"), description: t("result.scheduled") };
  }
}

function nativeLaunchCopy(t: TFunction<"applicationUpdate">, status: ApplicationUpdateStatus) {
  const retry = restartIsAvailable(status);
  switch (status.apply?.native_launch) {
    case "starting":
      return { title: t("status.launchStartingTitle"), description: t("status.launchStarting") };
    case "started":
      return { title: t("status.launchStartedTitle"), description: t("status.launchStarted") };
    case "failed":
      return {
        title: t("status.launchFailedTitle"),
        description: retry ? t("status.launchFailedRetry") : t("status.launchFailedRefresh"),
      };
    case "installer-succeeded":
      return {
        title: t("status.installerSucceededTitle"),
        description: t("status.installerSucceeded"),
      };
    case "installer-failed":
      return {
        title: t("status.installerFailedTitle"),
        description: retry ? t("status.installerFailedRetry") : t("status.installerFailedRefresh"),
      };
    default:
      return undefined;
  }
}

function terminationCopy(
  t: TFunction<"applicationUpdate">,
  termination: NonNullable<NonNullable<ApplicationUpdateStatus["apply"]>["termination"]>,
) {
  switch (termination) {
    case "normal-exit":
      return t("status.terminationNormalExit");
    case "restart-to-apply":
      return t("status.terminationRestartToApply");
    case "crash":
      return t("status.terminationCrash");
    case "os-shutdown":
      return t("status.terminationOsShutdown");
    case "steam-stop":
      return t("status.terminationSteamStop");
    default:
      return t("status.terminationUnknown");
  }
}

function applicationUpdateApplyCopy(
  t: TFunction<"applicationUpdate">,
  status: ApplicationUpdateStatus,
) {
  const apply = status.apply;
  if (!apply) return undefined;
  if (apply.native_launch) return nativeLaunchCopy(t, status);
  if (apply.termination) {
    return {
      title: t("status.terminationTitle"),
      description: terminationCopy(t, apply.termination),
    };
  }
  return {
    title:
      apply.request === "restart-to-apply"
        ? t("status.waitingRestartTitle")
        : t("status.waitingCloseTitle"),
    description: t("status.applyDescription"),
  };
}

type StatusBusy =
  | ""
  | "loadingStatus"
  | "refreshingStatus"
  | "repairingSchedule"
  | "repairingStaging"
  | "repairingApply";
type SettingsBusy =
  | ""
  | "loadingSettings"
  | "savingSettings"
  | "resettingDamaged"
  | "clearingChoice"
  | "preparingRestart"
  | "restarting";
type RestartBlocker = "noChoice" | "changed";
type UpdateNotice =
  | "saved"
  | "resetDamaged"
  | "resetPreferences"
  | "repairedSchedule"
  | "repairedStaging"
  | "repairedApplyWithDownload"
  | "repairedApplyNoDownload";
/** `text` keeps a Core or upstream diagnostic verbatim; other kinds are app-owned copy. */
type UpdateMessage =
  | { kind: "text"; text: string }
  | { kind: "saveFailedRefreshed"; error: string }
  | {
      kind:
        | "requestIncomplete"
        | "channelMismatch"
        | "unexpectedStaged"
        | "repairIncomplete"
        | "restartUnconfirmed";
    };

/** App-owned check failures keep a stable code; the message serves diagnostics. */
class ApplicationUpdateCheckError extends Error {
  constructor(readonly code: "channelMismatch" | "unexpectedStaged") {
    // Diagnostics stay English, like Core's; presentation localizes the code.
    super(
      code === "channelMismatch"
        ? "The update check returned a different channel. Check again."
        : "The one-time check returned an unexpected download result. Refresh update activity to review it.",
    );
  }
}

function failureMessage(value: unknown): UpdateMessage {
  return value instanceof ApplicationUpdateCheckError
    ? { kind: value.code }
    : { kind: "text", text: errorText(value) };
}

function updateMessageCopy(t: TFunction<"applicationUpdate">, message: UpdateMessage) {
  switch (message.kind) {
    case "text":
      return message.text;
    case "saveFailedRefreshed":
      return t("outcome.saveFailedRefreshed", { error: message.error });
    case "requestIncomplete":
      return t("check.requestIncomplete");
    case "channelMismatch":
      return t("check.channelMismatch");
    case "unexpectedStaged":
      return t("check.unexpectedStaged");
    case "repairIncomplete":
      return t("status.repairIncomplete");
    case "restartUnconfirmed":
      return t("status.restartUnconfirmed");
  }
}

function statusBusyCopy(t: TFunction<"applicationUpdate">, busy: Exclude<StatusBusy, "">) {
  switch (busy) {
    case "loadingStatus":
      return t("busy.loadingStatus");
    case "refreshingStatus":
      return t("busy.refreshingStatus");
    case "repairingSchedule":
      return t("busy.repairingSchedule");
    case "repairingStaging":
      return t("busy.repairingStaging");
    case "repairingApply":
      return t("busy.repairingApply");
  }
}

function settingsBusyCopy(t: TFunction<"applicationUpdate">, busy: Exclude<SettingsBusy, "">) {
  switch (busy) {
    case "loadingSettings":
      return t("busy.loadingSettings");
    case "savingSettings":
      return t("busy.savingSettings");
    case "resettingDamaged":
      return t("busy.resettingDamaged");
    case "clearingChoice":
      return t("busy.clearingChoice");
    case "preparingRestart":
      return t("busy.preparingRestart");
    case "restarting":
      return t("busy.restarting");
  }
}

function noticeCopy(t: TFunction<"applicationUpdate">, notice: UpdateNotice) {
  switch (notice) {
    case "saved":
      return t("outcome.saved");
    case "resetDamaged":
      return t("outcome.resetDamaged");
    case "resetPreferences":
      return t("outcome.resetPreferences");
    case "repairedSchedule":
      return t("outcome.repairedSchedule");
    case "repairedStaging":
      return t("outcome.repairedStaging");
    case "repairedApplyWithDownload":
      return t("outcome.repairedApplyWithDownload");
    case "repairedApplyNoDownload":
      return t("outcome.repairedApplyNoDownload");
  }
}

function restartBlockerCopy(t: TFunction<"applicationUpdate">, blocker: RestartBlocker) {
  return blocker === "noChoice"
    ? t("settings.restartBlockedNoChoice")
    : t("settings.restartBlockedChanged");
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
  const { t } = useAppTranslation("applicationUpdate");
  return recoveries.map((recovery) => {
    const copy = recoveryCopy(t, recovery.area);
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

function installRestrictionCopy(
  t: TFunction<"applicationUpdate">,
  status: ApplicationUpdateStatus,
) {
  switch (status.install_eligibility) {
    case "package-managed-deb":
      return t("status.restrictionDeb");
    case "package-managed-rpm":
      return t("status.restrictionRpm");
    case "not-configured":
      return t("status.restrictionNotConfigured");
    case "unavailable":
      return t("status.restrictionUnavailable");
    case "eligible":
      return status.recovery_required.some(({ area }) => area === "apply")
        ? t("status.restrictionRepairApply")
        : t("status.restrictionReviewPending");
  }
}

function ManualUpgradeLink({
  eligibility,
}: {
  eligibility: ApplicationUpdateStatus["install_eligibility"];
}) {
  const { t } = useAppTranslation("applicationUpdate");
  if (eligibility !== "not-configured" && eligibility !== "unavailable") return null;
  return (
    <ExternalLink href="https://github.com/boburning/portcove/blob/main/docs/UPGRADING.md#upgrade-portcove">
      {t("status.manualLink")}
    </ExternalLink>
  );
}

function StagedApplicationUpdateItem({
  status,
  disabled,
  blocker,
  onRestart,
}: {
  status: ApplicationUpdateStatus;
  disabled: boolean;
  blocker?: RestartBlocker | undefined;
  onRestart: () => Promise<void>;
}) {
  const { t } = useAppTranslation("applicationUpdate");
  if (!status.staged) return null;
  const canRestart = restartIsAvailable(status);
  const summaryValues = {
    version: status.staged.version,
    size: formatBytes(status.staged.bytes),
  };
  return (
    <div className={updateStatusItemClass}>
      <strong>
        {canRestart && !blocker ? t("status.readyTitle") : t("status.downloadedTitle")}
      </strong>
      {/* Complete sentences; a channel name is never inserted into a sentence. */}
      <p className={updateMutedCopyClass}>
        {status.staged.channel === "preview"
          ? t("status.stagedSummary", { context: "preview", ...summaryValues })
          : t("status.stagedSummary", { context: "stable", ...summaryValues })}{" "}
        {blocker
          ? restartBlockerCopy(t, blocker)
          : canRestart
            ? t("status.restartNote")
            : installRestrictionCopy(t, status)}
      </p>
      <ManualUpgradeLink eligibility={status.install_eligibility} />
      {canRestart && (
        <Button
          data-focusable
          variant="primary"
          size="sm"
          disabled={disabled}
          onClick={() => void onRestart()}
        >
          {status.apply ? t("status.retryRestart") : t("status.restart")}
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
  const { t } = useAppTranslation("applicationUpdate");
  if (!schedule) return null;
  return (
    <p className={`application-update-schedule ${updateSurfaceClass} ${updateMutedCopyClass}`}>
      {schedule.last_success_unix_seconds
        ? t("status.lastSuccess", { time: formatTimestamp(schedule.last_success_unix_seconds) })
        : t("status.noSuccess")}{" "}
      {schedule.consecutive_failures > 0 &&
        t("status.failures", { count: schedule.consecutive_failures })}{" "}
      {schedule.next_automatic_check_unix_seconds &&
        t("status.nextAttempt", {
          time: formatTimestamp(schedule.next_automatic_check_unix_seconds),
        })}
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
  busy: StatusBusy;
  error: UpdateMessage | undefined;
  disabled: boolean;
  onRefresh: () => Promise<void>;
  onRecover: (area: ApplicationUpdateRecoveryArea) => Promise<void>;
  onRestart: () => Promise<void>;
  restartDisabled: boolean;
  restartBlocker?: RestartBlocker | undefined;
}) {
  const { t } = useAppTranslation("applicationUpdate");
  const applyCopy = status?.apply ? applicationUpdateApplyCopy(t, status) : undefined;

  return (
    <section className={updatePanelClass} aria-labelledby="application-status-title">
      <div className={updatePanelHeadingClass}>
        <div className="grid gap-1">
          <h3 id="application-status-title" tabIndex={-1}>
            {t("status.title")}
          </h3>
          <p className={updateMutedCopyClass}>{t("status.description")}</p>
        </div>
        <Button
          data-focusable
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={disabled || Boolean(busy)}
          onClick={() => void onRefresh()}
        >
          {t("status.refresh")}
        </Button>
      </div>

      {status && (
        <>
          {!status.staged && status.install_eligibility !== "eligible" && (
            <div className={`${updateSurfaceClass} ${updateMutedCopyClass}`}>
              <p>{installRestrictionCopy(t, status)}</p>
              <ManualUpgradeLink eligibility={status.install_eligibility} />
            </div>
          )}
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
              {t("status.idle")}
            </p>
          )}

          <ApplicationUpdateScheduleSummary schedule={status.schedule} />
        </>
      )}

      {busy && <p role="status">{statusBusyCopy(t, busy)}</p>}
      {error && <p role="alert">{updateMessageCopy(t, error)}</p>}
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
  error: UpdateMessage | undefined;
  check: () => Promise<void>;
  download: () => Promise<void>;
  cancel: () => Promise<void>;
};

type BoundUpdateResult = {
  preferenceRevision: number | undefined;
  checkedChannel?: ApplicationUpdateChoice["channel"];
  value: ApplicationUpdateCheckResult;
};

function performApplicationTask<T>(
  perform: Perform | undefined,
  generation: number,
  action: string,
  task: () => Promise<T>,
) {
  return perform
    ? perform(action, task, {
        refresh: "none",
        invalidateDiagnostics: false,
        propagateFailure: true,
        context: {
          action,
          target: { kind: "application", id: "portcove", label: "Portcove" },
          libraryGeneration: generation,
          exclusionScope: "application",
        },
      })
    : task();
}

function useApplicationUpdateOperation({
  perform,
  generation,
  preferences,
  changed,
  onStart,
  onComplete,
  automaticNotice,
  initialChannel,
}: {
  perform?: Perform | undefined;
  generation: number;
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
  const [error, setError] = useState<UpdateMessage>();
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
      const task = () =>
        execute((nextPhase) => {
          if (requests.current.isCurrent(request)) setPhase(nextPhase);
        });
      const nextResult = await performApplicationTask(
        perform,
        generation,
        operation === "check" ? "Check application update" : "Download application update",
        task,
      );
      if (!requests.current.isCurrent(request)) return;
      if (!nextResult) {
        setError({ kind: "requestIncomplete" });
        return;
      }
      setBoundResult({ preferenceRevision, ...nextResult });
      if (operation === "download") await onComplete();
    } catch (value) {
      if (requests.current.isCurrent(request)) setError(failureMessage(value));
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
        throw new ApplicationUpdateCheckError("channelMismatch");
      if (checked.result.staged) throw new ApplicationUpdateCheckError("unexpectedStaged");
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
      setError(failureMessage(value));
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
  t: TFunction<"applicationUpdate">,
  preferences: ApplicationUpdatePreferences | undefined,
  changed: boolean,
  channel: ApplicationUpdateChoice["channel"] | undefined,
) {
  if (!preferences?.choice) return t("check.blockerNoChoice");
  if (changed) return t("check.blockerChanged");
  if (preferences.choice.paused) return t("check.blockerPaused");
  if (channel !== preferences.choice.channel)
    return channel === "stable"
      ? t("check.blockerChannel", { context: "stable" })
      : t("check.blockerChannel", { context: "preview" });
  return undefined;
}

function resultSourceCopy(
  t: TFunction<"applicationUpdate">,
  oneTime: boolean,
  channel: ApplicationUpdateChoice["channel"] | undefined,
) {
  if (oneTime)
    return channel === "stable"
      ? t("check.source_oneTimeStable")
      : t("check.source_oneTimePreview");
  return channel === "stable" ? t("check.source_savedStable") : t("check.source_savedPreview");
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
  const { t } = useAppTranslation("applicationUpdate");
  const copy = applicationUpdateCheckCopy(t, result);
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
          {t("check.download")}
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
  const { t } = useAppTranslation("applicationUpdate");
  const actionsDisabled = disabled;
  const blocker = downloadSettingsBlocker(t, preferences, changed, operation.resultChannel);

  return (
    <section
      className={updatePanelClass}
      aria-labelledby="application-check-title"
      aria-busy={operation.busy}
    >
      <div className={updatePanelHeadingClass}>
        <div className="grid gap-1">
          <h3 id="application-check-title" tabIndex={-1}>
            {t("check.title")}
          </h3>
          <p className={updateMutedCopyClass}>{t("check.description")}</p>
        </div>
        {operation.busy ? (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void operation.cancel()}
          >
            {operation.active === "download" ? t("check.cancelDownload") : t("check.cancelCheck")}
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
            {t("check.start")}
          </Button>
        )}
      </div>
      <div role="group" aria-label={t("check.channelGroup")} className="flex flex-wrap gap-2">
        <span className="self-center text-sm text-pc-muted-foreground">
          {t("check.channelOnly")}
        </span>
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
            {channel === "stable" ? t("channel.stable") : t("channel.preview")}
          </Button>
        ))}
      </div>
      {operation.busy && operation.phase && (
        <p role="status">{checkProgressCopy(t, operation.phase)}</p>
      )}
      {operation.result && (
        <p className={updateMutedCopyClass}>
          {resultSourceCopy(t, operation.isOneTimeResult, operation.resultChannel)}
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
      {operation.error && <p role="alert">{updateMessageCopy(t, operation.error)}</p>}
    </section>
  );
}

function useApplicationUpdateSettings({
  perform,
  currentVersion,
  generation = 0,
  disabled = false,
  automaticNotice,
  preferencesState,
}: {
  perform?: Perform | undefined;
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
  const [actionBusy, setBusy] = useState<SettingsBusy>("");
  const busy: SettingsBusy = preferencesState?.loading ? "loadingSettings" : actionBusy;
  const [statusBusy, setStatusBusy] = useState<StatusBusy>("loadingStatus");
  const [error, setError] = useState<UpdateMessage>();
  const canRecoverPreferences = isRecoverableStateError(preferencesState?.failure);
  const [statusError, setStatusError] = useState<UpdateMessage>();
  const [notice, setNotice] = useState<UpdateNotice>();
  const changed = Boolean(preferences && !choicesMatch(preferences.choice, draft));

  const applyPreferences = (value: ApplicationUpdatePreferences) => {
    const accepted = preferencesState?.accept(value);
    if (accepted) setDraft(accepted.choice ?? recommendedChoice);
  };

  const load = async () => {
    const request = requests.current.begin();
    setBusy("loadingSettings");
    setError(undefined);
    setNotice(undefined);
    try {
      const value = await preferencesState?.refresh();
      if (value && requests.current.isCurrent(request)) setDraft(value.choice ?? recommendedChoice);
    } catch (value) {
      if (requests.current.isCurrent(request)) {
        setError(failureMessage(value));
      }
    } finally {
      if (requests.current.isCurrent(request)) setBusy("");
    }
  };

  const loadStatus = async () => {
    const request = statusRequests.current.begin();
    setStatusBusy("refreshingStatus");
    setStatusError(undefined);
    try {
      const value = await desktopApi.applicationUpdateStatus();
      if (statusRequests.current.isCurrent(request)) setStatus(value);
    } catch (value) {
      if (statusRequests.current.isCurrent(request)) setStatusError(failureMessage(value));
    } finally {
      if (statusRequests.current.isCurrent(request)) setStatusBusy("");
    }
  };

  const updateOperation = useApplicationUpdateOperation({
    perform,
    generation,
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
        if (statusTracker.isCurrent(statusRequest)) setStatusError(failureMessage(value));
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
    setBusy("savingSettings");
    setError(undefined);
    setNotice(undefined);
    try {
      const value = await desktopApi.setApplicationUpdatePreferences(preferences.revision, draft);
      if (!requests.current.isCurrent(request)) return;
      applyPreferences(value);
      setNotice("saved");
    } catch (value) {
      if (!requests.current.isCurrent(request)) return;
      const message = failureMessage(value);
      try {
        const current = await preferencesState?.refresh();
        if (current && requests.current.isCurrent(request)) {
          setDraft(current.choice ?? recommendedChoice);
          setError(
            message.kind === "text"
              ? { kind: "saveFailedRefreshed", error: message.text }
              : message,
          );
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
    setBusy(recovering ? "resettingDamaged" : "clearingChoice");
    setError(undefined);
    setNotice(undefined);
    try {
      const value = preferences
        ? await desktopApi.resetApplicationUpdatePreferences()
        : await desktopApi.recoverApplicationUpdatePreferences();
      if (!requests.current.isCurrent(request)) return;
      if (recovering) preferencesState?.acceptRecovered(value);
      else applyPreferences(value);
      setNotice(recovering ? "resetDamaged" : "resetPreferences");
    } catch (value) {
      if (requests.current.isCurrent(request)) setError(failureMessage(value));
    } finally {
      if (requests.current.isCurrent(request)) setBusy("");
    }
  };

  const recover = async (area: ApplicationUpdateRecoveryArea) => {
    const request = statusRequests.current.begin();
    setStatusBusy(
      area === "schedule"
        ? "repairingSchedule"
        : area === "staging"
          ? "repairingStaging"
          : "repairingApply",
    );
    setStatusError(undefined);
    setNotice(undefined);
    try {
      const value = await performApplicationTask(
        perform,
        generation,
        "Repair application update",
        () => desktopApi.recoverApplicationUpdateState(area),
      );
      if (!statusRequests.current.isCurrent(request)) return;
      if (!value) {
        setStatusError({ kind: "repairIncomplete" });
        return;
      }
      setStatus(value);
      setNotice(
        area === "schedule"
          ? "repairedSchedule"
          : area === "staging"
            ? "repairedStaging"
            : value.staged
              ? "repairedApplyWithDownload"
              : "repairedApplyNoDownload",
      );
    } catch (value) {
      if (statusRequests.current.isCurrent(request)) setStatusError(failureMessage(value));
    } finally {
      if (statusRequests.current.isCurrent(request)) setStatusBusy("");
    }
  };

  const restartToUpdate = async () => {
    setBusy("preparingRestart");
    setError(undefined);
    setNotice(undefined);
    try {
      const accepted = await performApplicationTask(
        perform,
        generation,
        "Restart to update Portcove",
        async () => {
          await desktopApi.restartToApplyApplicationUpdate(generation);
          return true;
        },
      );
      if (!accepted) {
        setBusy("");
        setError({ kind: "restartUnconfirmed" });
        return;
      }
      setBusy("restarting");
    } catch (value) {
      setError(failureMessage(value));
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
          ? "#application-update-channel-group button:not(:disabled)"
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
  const { t } = useAppTranslation("applicationUpdate");
  // A build that cannot install its own updates cannot honor Automatic; checks and
  // notifications still work, so only that mode is withheld.
  const automaticUnavailable = Boolean(status && status.install_eligibility !== "eligible");
  const renderPreferences = () =>
    preferences && (
      <section
        className="grid gap-5"
        aria-labelledby="application-preferences-title"
        aria-busy={Boolean(busy)}
      >
        <h3 id="application-preferences-title" tabIndex={-1}>
          {t("preferences.title")}
        </h3>
        {preferences.choice && (
          <p className="m-0 text-sm text-pc-muted-foreground">
            {preferences.choice.channel === "preview"
              ? t("preferences.savedDefault", { context: "preview" })
              : t("preferences.savedDefault", { context: "stable" })}
          </p>
        )}
        {!preferences.choice && (
          <p className="application-update-consent rounded-pc-md border border-[var(--color-warning-border)] bg-pc-warning-subtle p-3 text-pc-warning-foreground">
            {t("preferences.noChoice")}
          </p>
        )}

        <section className={updateChoiceClass} aria-labelledby="application-channel-label">
          <h3 id="application-channel-label" className="text-sm">
            {t("preferences.channelHeading")}
          </h3>
          <div
            id="application-update-channel-group"
            className="segmented grid [grid-auto-columns:1fr] [grid-auto-flow:column] rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-[3px]"
            role="group"
            aria-label={t("preferences.channelGroup")}
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
                {channel === "preview" ? t("channel.preview") : t("channel.stable")}
              </Button>
            ))}
          </div>
          <p className={updateMutedCopyClass}>
            {draft.channel === "preview"
              ? t("preferences.channelDescription", { context: "preview" })
              : t("preferences.channelDescription", { context: "stable" })}
          </p>
        </section>

        <section className={updateChoiceClass} aria-labelledby="application-mode-label">
          <h3 id="application-mode-label" className="text-sm">
            {t("preferences.modeHeading")}
          </h3>
          <div
            className="segmented grid [grid-auto-columns:1fr] [grid-auto-flow:column] rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-[3px]"
            role="group"
            aria-label={t("preferences.modeGroup")}
            aria-describedby={
              automaticUnavailable ? "application-update-automatic-unavailable" : undefined
            }
          >
            {(
              [
                ["automatic", t("preferences.mode_automatic")],
                ["notify-only", t("preferences.mode_notifyOnly")],
                ["manual", t("preferences.mode_manual")],
              ] as const
            ).map(([mode, label]) => (
              <Button
                key={mode}
                data-focusable
                variant={draft.mode === mode ? "selected" : "ghost"}
                className={updateChoiceButtonClass}
                aria-pressed={draft.mode === mode}
                disabled={unavailable || (mode === "automatic" && automaticUnavailable)}
                onClick={() => setDraft((value) => ({ ...value, mode }))}
              >
                {label}
                {mode === "automatic" && !automaticUnavailable && (
                  <small className="text-[length:var(--text-2xs)] normal-case">
                    {t("preferences.recommended")}
                  </small>
                )}
              </Button>
            ))}
          </div>
          <p className={updateMutedCopyClass}>
            {draft.mode === "automatic"
              ? t("preferences.modeDescription_automatic")
              : draft.mode === "notify-only"
                ? t("preferences.modeDescription_notifyOnly")
                : t("preferences.modeDescription_manual")}
          </p>
          {automaticUnavailable && (
            <p id="application-update-automatic-unavailable" className={updateMutedCopyClass}>
              {t("preferences.automaticUnavailable")}
            </p>
          )}
        </section>

        <label
          htmlFor="pause-application-updates"
          className="application-update-pause flex min-h-10 cursor-pointer items-start gap-3 rounded-pc-md bg-[var(--color-bg-subtle)] p-3"
        >
          <Checkbox
            data-focusable
            className="mt-0.5"
            id="pause-application-updates"
            aria-labelledby="pause-application-updates-label"
            aria-describedby="pause-application-updates-description"
            checked={draft.paused}
            disabled={unavailable}
            onCheckedChange={(paused) => setDraft((value) => ({ ...value, paused }))}
          />
          <span className="grid gap-0.5">
            <span
              id="pause-application-updates-label"
              className="cursor-pointer font-bold text-pc-foreground"
            >
              {t("preferences.pauseLabel")}
            </span>
            <small id="pause-application-updates-description" className={updateMutedCopyClass}>
              {t("preferences.pauseDescription")}
            </small>
          </span>
        </label>

        <p className={updateDisclosureClass}>{t("preferences.saveDoesNotStart")}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            data-focusable
            variant="primary"
            size="sm"
            disabled={unavailable || !changed}
            onClick={() => void save()}
          >
            {t("preferences.save")}
          </Button>
          <Button
            data-focusable
            variant="outline"
            size="sm"
            disabled={unavailable || !changed}
            onClick={() => setDraft(preferences.choice ?? recommendedChoice)}
          >
            {t("preferences.discard")}
          </Button>
          <Button
            data-focusable
            variant="destructive"
            size="sm"
            disabled={unavailable || !preferences.choice}
            onClick={() => void reset()}
          >
            {t("preferences.reset")}
          </Button>
        </div>
        <p className={updateDisclosureClass}>{t("preferences.resetDisclosure")}</p>
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
          <h2 id="application-update-settings-title" ref={headingRef} tabIndex={-1}>
            {t("settings.title")}
          </h2>
        </div>
        <p className="rounded-pc-md bg-[var(--color-bg-subtle)] px-3 py-2 text-xs whitespace-nowrap text-[var(--color-text-secondary)] max-[65rem]:whitespace-normal">
          <Trans
            t={t}
            i18nKey="settings.currentVersion"
            values={{ version: currentVersion }}
            components={{ strong: <strong /> }}
          />
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
            {t("settings.retryLoad")}
          </Button>
          {canRecoverPreferences && (
            <Button
              data-focusable
              variant="destructive"
              size="sm"
              disabled={disabled}
              onClick={() => void reset()}
            >
              {t("settings.resetDamaged")}
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

      {busy && <p role="status">{settingsBusyCopy(t, busy)}</p>}
      {notice && <p role="status">{noticeCopy(t, notice)}</p>}
      {(error || preferencesState?.failure !== undefined) && (
        <p role="alert">
          {error ? updateMessageCopy(t, error) : errorText(preferencesState?.failure)}
        </p>
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
      ? ("noChoice" as const)
      : changed
        ? ("changed" as const)
        : undefined,
  };
}
