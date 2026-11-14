import { Trans } from "react-i18next";
import type { TFunction } from "i18next";
import { SettingsRow } from "../../components/ui/patterns";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { useAppTranslation } from "../../localization";
import type {
  ApplicationUpdateChannel,
  ApplicationUpdateProgress,
  ApplicationUpdateStatus,
} from "../../types";
import { errorText, formatBytes } from "../../view-model";
import type { ApplicationUpdateModel } from "./use-application-update";

const mutedCopyClass = "m-0 text-xs leading-[var(--leading-relaxed)] text-pc-muted-foreground";
const surfaceClass = "rounded-pc-md border border-pc-border bg-[var(--color-bg-subtle)] p-3";
const channels = ["beta", "preview"] as const satisfies readonly ApplicationUpdateChannel[];

/** Settings section for Portcove's own updates: channel, automatic checks and install. */
export function ApplicationUpdateSettings({
  update,
  currentVersion,
  generation,
  disabled = false,
}: {
  update: ApplicationUpdateModel;
  currentVersion: string;
  generation: number;
  disabled?: boolean;
}) {
  const { t } = useAppTranslation("applicationUpdate");
  const { status, preferences, busy, failure } = update;
  const locked = disabled || busy !== undefined || Boolean(status?.installing);
  return (
    <SettingsRow
      className="application-update-settings grid min-h-0 gap-5"
      data-focus-group
      aria-labelledby="application-update-settings-title"
      aria-busy={busy !== undefined}
    >
      <div className="flex items-start justify-between gap-4 max-[65rem]:flex-col">
        <h2 id="application-update-settings-title" tabIndex={-1}>
          {t("settings.title")}
        </h2>
        <p className="m-0 rounded-pc-md bg-[var(--color-bg-subtle)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
          <Trans
            t={t}
            i18nKey="settings.currentVersion"
            values={{ version: status?.current_version ?? currentVersion }}
            components={{ strong: <strong /> }}
          />
        </p>
      </div>

      {preferences && (
        <section className="grid gap-2" aria-labelledby="application-update-channel-label">
          <h3 id="application-update-channel-label" className="text-sm">
            {t("channel.heading")}
          </h3>
          <div
            className="segmented grid [grid-auto-columns:1fr] [grid-auto-flow:column] rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-[3px]"
            role="group"
            aria-labelledby="application-update-channel-label"
          >
            {channels.map((channel) => (
              <Button
                key={channel}
                data-focusable
                variant={preferences.channel === channel ? "selected" : "ghost"}
                aria-pressed={preferences.channel === channel}
                disabled={locked}
                onClick={() => void update.savePreferences({ ...preferences, channel })}
              >
                {channel === "beta" ? t("channel.beta") : t("channel.preview")}
              </Button>
            ))}
          </div>
          <p className={mutedCopyClass}>
            {preferences.channel === "beta"
              ? t("channel.description", { context: "beta" })
              : t("channel.description", { context: "preview" })}
          </p>
          <label
            htmlFor="application-update-automatic-checks"
            className="mt-2 flex min-h-10 cursor-pointer items-start gap-3 rounded-pc-md bg-[var(--color-bg-subtle)] p-3"
          >
            <Checkbox
              data-focusable
              className="mt-0.5"
              id="application-update-automatic-checks"
              aria-describedby="application-update-automatic-checks-description"
              checked={preferences.automatic_checks}
              disabled={locked}
              onCheckedChange={(checked) =>
                void update.savePreferences({ ...preferences, automatic_checks: checked })
              }
            />
            <span className="grid gap-0.5">
              <span className="font-bold text-pc-foreground">{t("automatic.label")}</span>
              <small
                id="application-update-automatic-checks-description"
                className={mutedCopyClass}
              >
                {t("automatic.description")}
              </small>
            </span>
          </label>
        </section>
      )}

      <section className="grid gap-3" aria-labelledby="application-update-status-title">
        <h3 id="application-update-status-title" className="text-sm" tabIndex={-1}>
          {t("status.title")}
        </h3>
        <p className={mutedCopyClass} role="status">
          {statusCopy(t, status, busy === "check")}
        </p>
        {status?.available && (
          <AvailableUpdate
            available={status.available}
            installing={busy === "install" || status.installing}
            progress={update.progress}
            disabled={locked}
            install={() => void update.install(generation)}
          />
        )}
        <div>
          <Button
            data-focusable
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={() => void update.check()}
          >
            {t("status.check")}
          </Button>
        </div>
      </section>

      {failure !== undefined && <p role="alert">{failureCopy(t, failure)}</p>}
    </SettingsRow>
  );
}

// The host names known refusals in a failure detail so this copy stays localized;
// any other failure keeps its shared presentation.
function failureCopy(t: TFunction<"applicationUpdate">, failure: unknown) {
  const details =
    typeof failure === "object" && failure && "details" in failure ? failure.details : undefined;
  const reason =
    typeof details === "object" && details && "application_update_refusal" in details
      ? details.application_update_refusal
      : undefined;
  switch (reason) {
    case "library-busy":
      return t("failure.libraryBusy");
    case "in-progress":
      return t("failure.inProgress");
    case "check-failed":
      return t("failure.checkFailed");
    case "download-failed":
      return t("failure.downloadFailed");
    case "install-failed":
      return t("failure.installFailed");
    case "stale":
      return t("failure.stale");
    case "save-failed":
      return t("failure.saveFailed");
    case "unavailable":
      return t("failure.unavailable");
    default:
      return errorText(failure);
  }
}

function statusCopy(
  t: TFunction<"applicationUpdate">,
  status: ApplicationUpdateStatus | undefined,
  checking: boolean,
) {
  if (checking || status?.checking) return t("status.checking");
  if (status?.available) return t("status.available", { version: status.available.version });
  if (status?.last_checked_unix_seconds)
    return t("status.current", {
      checked: new Date(status.last_checked_unix_seconds * 1000).toLocaleString(),
    });
  return t("status.notChecked");
}

function AvailableUpdate({
  available,
  installing,
  progress,
  disabled,
  install,
}: {
  available: NonNullable<ApplicationUpdateStatus["available"]>;
  installing: boolean;
  progress: ApplicationUpdateProgress | undefined;
  disabled: boolean;
  install: () => void;
}) {
  const { t } = useAppTranslation("applicationUpdate");
  return (
    <article
      className={`application-update-available grid gap-3 ${surfaceClass}`}
      aria-labelledby="application-update-available-title"
    >
      <div className="grid gap-1">
        <h4 id="application-update-available-title" className="m-0" tabIndex={-1}>
          {t("available.title", { version: available.version })}
        </h4>
        {available.date && (
          <p className={mutedCopyClass}>
            {t("available.published", { date: new Date(available.date).toLocaleDateString() })}
          </p>
        )}
      </div>
      {available.notes ? (
        <div className="grid gap-1">
          <h5 className="m-0 text-xs">{t("available.notesTitle")}</h5>
          <p className="m-0 text-sm whitespace-pre-line">{available.notes}</p>
        </div>
      ) : (
        <p className={mutedCopyClass}>{t("available.noNotes")}</p>
      )}
      <p className={mutedCopyClass}>{t("available.restartDisclosure")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button data-focusable variant="primary" size="sm" disabled={disabled} onClick={install}>
          {t("available.install")}
        </Button>
        {installing && (
          <p className="m-0 text-sm" role="status" aria-live="polite">
            {progressCopy(t, progress)}
          </p>
        )}
      </div>
    </article>
  );
}

function progressCopy(
  t: TFunction<"applicationUpdate">,
  progress: ApplicationUpdateProgress | undefined,
) {
  if (progress?.phase === "installing") return t("progress.installing");
  if (progress?.phase === "downloading")
    return progress.total_bytes
      ? t("progress.downloading", {
          downloaded: formatBytes(progress.downloaded_bytes),
          total: formatBytes(progress.total_bytes),
        })
      : t("progress.downloadingUnknown", { downloaded: formatBytes(progress.downloaded_bytes) });
  return t("progress.starting");
}
