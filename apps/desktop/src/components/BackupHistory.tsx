import { cn } from "cn";
import { useRef, useState } from "react";
import { Archive, ChevronDown, ChevronUp, RotateCcw, Trash2 } from "lucide-react";
import type { BackupInventory, BackupProblem, BackupRecord } from "../types";
import { formatBytes } from "../view-model";
import { Icon } from "./ui";
import { GhostshipLegacyRecovery } from "./GhostshipRecoveryReview";
import { BackupReviewDialog, type ApplyBackupAction } from "./BackupReview";
import { Button } from "./ui/button";
import { FailureDetails } from "./FailureDetails";
import type { BackupReadState } from "../features/backups/use-port-backups";
import { automaticSnapshotLabel } from "../features/backups/snapshot-label";
import type { TFunction } from "i18next";
import { useAppTranslation } from "../localization";

export function BackupHistory({
  gameName,
  embedded = false,
  backups,
  problems = [],
  state = "healthy",
  readState,
  restoreAssessment,
  retryRead,
  busy,
  generation = 0,
  restore,
  recoverGhostshipLegacy,
  remove,
  focusFallback,
}: {
  gameName?: string | undefined;
  embedded?: boolean;
  backups: BackupRecord[];
  problems?: BackupProblem[];
  state?: BackupInventory["state"];
  readState?: BackupReadState | undefined;
  restoreAssessment?: BackupInventory["restore_assessment"] | undefined;
  retryRead?: (() => Promise<void>) | undefined;
  busy?: string | undefined;
  generation?: number;
  restore: ApplyBackupAction;
  recoverGhostshipLegacy?: ApplyBackupAction | undefined;
  remove: ApplyBackupAction;
  focusFallback?: () => HTMLElement | null;
}) {
  const { t } = useAppTranslation("backups");
  const [expanded, setExpanded] = useState(false);
  const history = useRef<HTMLDivElement>(null);
  const retryPending = useRef(false);
  const heading = useRef<HTMLSpanElement>(null);
  const [selection, setSelection] = useState<{
    backup: BackupRecord;
    action: "restore" | "delete";
    opener: HTMLButtonElement;
    index: number;
  }>();
  const visible = expanded ? backups : backups.slice(0, 3);
  const restoreAllowed =
    (!readState || readState.status === "current") &&
    restoreAssessment?.action === "backup_restore" &&
    restoreAssessment.availability === "allowed" &&
    restoreAssessment.reason === "available" &&
    restoreAssessment.definition == null;
  const restoreConsistent =
    restoreAssessment?.action === "backup_restore" &&
    restoreAssessment.definition == null &&
    ((restoreAssessment?.availability === "allowed" && restoreAssessment.reason === "available") ||
      (restoreAssessment?.availability === "waiting" &&
        restoreAssessment.reason === "missing_backup") ||
      (restoreAssessment?.availability === "held" &&
        ["unreadable_data", "unsafe_data", "recovery_required"].includes(
          restoreAssessment.reason,
        )));
  const renderReadStatus = () =>
    readState &&
    readState.status !== "idle" &&
    (readState.status !== "current" || retryRead) && (
      <div
        className={
          readState.status === "current"
            ? undefined
            : cn(
                "backup-inventory-notice rounded-pc-md border bg-[var(--color-bg-subtle)] p-3",
                readState.status === "failed"
                  ? "border-[var(--color-warning-border)]"
                  : "border-pc-border",
              )
        }
        role={readState.status === "current" ? undefined : "status"}
      >
        {readState.status === "pending" && (
          <>
            <strong>
              {readState.hasInventory ? t("history.refreshing") : t("history.loading")}
            </strong>
            <p className="m-[4px_0_8px] text-[var(--color-text-muted)]">
              {readState.hasInventory
                ? t("history.showingLastWhileChecking")
                : t("history.notLoadedYet")}
            </p>
          </>
        )}
        {readState.status === "failed" && (
          <>
            <strong>{t("history.loadFailed")}</strong>
            <p className="m-[4px_0_8px] text-[var(--color-text-muted)]">
              {readState.hasInventory ? t("history.showingLastStale") : t("history.unknownRetry")}
            </p>
            {readState.failure && (
              <FailureDetails presentation={readState.failure} showMutationSummary={false} />
            )}
          </>
        )}
        {retryRead && (
          <Button
            data-focusable
            variant={readState.status === "current" ? "ghost" : "outline"}
            size="sm"
            disabled={readState.status === "pending"}
            onClick={() => {
              if (retryPending.current) return;
              retryPending.current = true;
              void retryRead().finally(() => {
                retryPending.current = false;
              });
            }}
          >
            {readState.status === "failed" ? t("history.retry") : t("history.refresh")}
          </Button>
        )}
      </div>
    );
  const renderInventoryNotice = () =>
    (state !== "healthy" || problems.length > 0) && (
      <div
        className={cn(
          `backup-inventory-notice rounded-pc-md border border-[var(--color-warning-border,_var(--color-border))] bg-[var(--color-bg-subtle)] p-[12px] ${state}`,
          "[&.recovery_required]:border-[var(--color-danger-border,_var(--color-border))]",
        )}
        role="status"
      >
        <strong>
          {state === "recovery_required" ? t("notice.recoveryTitle") : t("notice.attentionTitle")}
        </strong>
        {/* Two complete sentences; neither is a fragment of the other. */}
        <p className="m-[4px_0_8px] text-[var(--color-text-muted)]">
          {problems.length > 0
            ? t("notice.unavailableEntries", { count: problems.length })
            : t("notice.notFullyChecked")}{" "}
          {backups.length
            ? state === "recovery_required"
              ? t("notice.listedRecoveryAll")
              : (!readState || readState.status === "current") &&
                  restoreConsistent &&
                  restoreAssessment?.availability === "held" &&
                  restoreAssessment.reason === "recovery_required"
                ? t("notice.listedRecoveryRestore")
                : restoreAllowed
                  ? t("notice.listedReview")
                  : t("notice.listedAvailability")
            : problems.length > 0
              ? t("notice.noneAvailableReview")
              : t("notice.noneAvailable")}
        </p>
        {problems.length > 0 && (
          <div className="mt-2">
            <strong>{t("notice.nextSteps")}</strong>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {problems.map((problem) => (
                <li key={`${problem.operation_id ?? "entry"}-${problem.path}`}>
                  {/* Core's proposed action stays verbatim; recovery has app-owned copy. */}
                  {t("notice.problemAction", {
                    label: problemLabel(t, problem.kind),
                    action:
                      problem.kind === "recovery_required"
                        ? t("notice.recoveryAction")
                        : problem.proposed_action,
                  })}
                </li>
              ))}
            </ul>
          </div>
        )}
        <details>
          <summary className="cursor-pointer" data-focusable>
            {t("history.technicalDetails")}
          </summary>
          {problems.map((problem) => (
            <div
              className="backup-problem mt-[10px] grid gap-[3px]"
              key={`${problem.operation_id ?? "entry"}-${problem.path}`}
            >
              <strong>{problemLabel(t, problem.kind)}</strong>
              <span className="[overflow-wrap:anywhere]">{problem.message}</span>
              <span className="[overflow-wrap:anywhere]">{problem.proposed_action}</span>
              <small className="[overflow-wrap:anywhere]">{problem.path}</small>
            </div>
          ))}
        </details>
      </div>
    );
  const renderRestoreAssessment = () =>
    backups.length > 0 &&
    !restoreAllowed && (
      <p role="status" className="backup-restore-assessment">
        {readState && readState.status !== "current"
          ? t("restore.unknownUntilRead")
          : !restoreConsistent
            ? t("restore.unknownRefresh")
            : restoreAssessment?.reason === "recovery_required"
              ? t("restore.recoveryRequired")
              : restoreAssessment?.reason === "unsafe_data"
                ? t("restore.unsafeData")
                : restoreAssessment?.reason === "unreadable_data"
                  ? t("restore.unreadableData")
                  : restoreAssessment?.reason === "missing_backup"
                    ? t("restore.missingBackup")
                    : t("restore.unknownRefresh")}
      </p>
    );
  const renderReview = () =>
    selection && (
      <BackupReviewDialog
        gameName={gameName}
        key={`${selection.backup.id}:${selection.action}:${generation}`}
        backup={selection.backup}
        action={selection.action}
        generation={generation}
        apply={selection.action === "restore" ? restore : remove}
        close={() => setSelection(undefined)}
        finalFocus={(closeType) => {
          // The primitive calls this during unmount, before React finishes removing rows.
          // Resolve from the committed DOM in the same microtask stage as return focus.
          queueMicrotask(() => {
            const opener =
              history.current?.isConnected &&
              selection.opener.isConnected &&
              !selection.opener.disabled
                ? selection.opener
                : undefined;
            const actions = history.current?.isConnected
              ? history.current.querySelectorAll<HTMLButtonElement>(
                  `button[data-backup-action="${selection.action}"]:not(:disabled)`,
                )
              : undefined;
            const target =
              opener ??
              actions?.[Math.min(selection.index, actions.length - 1)] ??
              (heading.current?.isConnected ? heading.current : undefined) ??
              focusFallback?.();
            if (target?.isConnected)
              target.focus({
                preventScroll: true,
                ...(closeType === "keyboard" ? { focusVisible: true } : {}),
              });
          });
          return false;
        }}
      />
    );
  return (
    <div
      ref={history}
      className="backup-history mt-[18px] grid gap-[7px] pt-[18px] [border-top:1px_solid_var(--color-border)]"
      data-backup-read-state={readState?.status}
    >
      <div className="backup-heading flex items-center justify-between gap-[12px]">
        <span ref={heading} role="heading" aria-level={3} tabIndex={-1}>
          {t("history.title")}
        </span>
        <small className="text-xs text-[var(--color-text-muted)]">
          {backupSummary(t, backups.length, problems.length, state, readState)}
        </small>
      </div>
      {!embedded && <p>{t("history.description")}</p>}
      {backups.length === 0 &&
        problems.length === 0 &&
        state === "healthy" &&
        readState?.status === "current" &&
        readState.hasInventory && (
          <div className="detail-backup-empty">
            <Icon glyph={Archive} />
            <div>
              <strong>{t("history.empty")}</strong>
              <p>{t("history.emptyDescription")}</p>
            </div>
          </div>
        )}
      {renderReadStatus()}
      {renderInventoryNotice()}
      {renderRestoreAssessment()}
      {visible.map((backup, index) => {
        const createdLabel = new Date(backup.created_at * 1000).toLocaleString();
        const automaticLabel = automaticSnapshotLabel(backup);
        return (
          <div
            className="backup-row grid min-w-0 gap-3 border-b border-pc-border py-4"
            key={backup.id}
            data-backup-id={backup.id}
          >
            <span className="min-w-0">
              <strong className="text-sm font-medium [overflow-wrap:anywhere]">
                {createdLabel}
              </strong>
              <small className="mt-[3px] text-xs text-[var(--color-text-muted)]">
                {t("details.summary", { count: backup.file_count, size: formatBytes(backup.size) })}
              </small>
              {automaticLabel && (
                <small
                  className="mt-[3px] block text-xs [overflow-wrap:anywhere] text-[var(--color-text-muted)]"
                  data-automatic-snapshot
                >
                  {automaticLabel}
                </small>
              )}
            </span>
            <details>
              <summary
                data-focusable
                aria-label={t("history.rowDetailsLabel", { time: createdLabel })}
              >
                {t("history.technicalDetails")}
              </summary>
              <small className="backup-checksum mt-[3px] font-mono text-xs [overflow-wrap:anywhere] text-[var(--color-text-muted)]">
                {t("history.checksum", { sha256: backup.sha256 })}
              </small>
            </details>
            <span className="backup-actions flex flex-wrap gap-2">
              <Button
                data-focusable
                data-backup-action="restore"
                variant="outline"
                disabled={Boolean(busy) || state === "recovery_required" || !restoreAllowed}
                onClick={(event) =>
                  setSelection({ backup, action: "restore", opener: event.currentTarget, index })
                }
              >
                <Icon glyph={RotateCcw} />
                {t("history.restore")}
              </Button>
              {backup.port_id === "ghostship" && recoverGhostshipLegacy && (
                <GhostshipLegacyRecovery
                  key={`${backup.id}:${generation}`}
                  backup={backup}
                  generation={generation}
                  apply={recoverGhostshipLegacy}
                  disabled={
                    Boolean(busy) ||
                    state === "recovery_required" ||
                    (readState !== undefined && readState.status !== "current")
                  }
                />
              )}
              <Button
                data-focusable
                data-backup-action="delete"
                variant="destructive"
                size="icon"
                aria-label={t("history.deleteLabel", { time: createdLabel })}
                disabled={Boolean(busy) || state === "recovery_required"}
                onClick={(event) =>
                  setSelection({ backup, action: "delete", opener: event.currentTarget, index })
                }
              >
                <Icon glyph={Trash2} />
              </Button>
            </span>
          </div>
        );
      })}
      {renderReview()}
      {backups.length > 3 && (
        <Button
          data-focusable
          className="justify-self-start"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon glyph={expanded ? ChevronUp : ChevronDown} />
          {expanded
            ? t("history.showRecent")
            : t("history.showOlder", { count: backups.length - 3 })}
        </Button>
      )}
    </div>
  );
}

function problemLabel(t: TFunction<"backups">, kind: BackupProblem["kind"]) {
  // A future Core kind falls back to a safe generic label, never a raw value.
  switch (kind) {
    case "missing_manifest":
      return t("problem.missingManifest");
    case "unreadable_manifest":
      return t("problem.unreadableManifest");
    case "malformed_manifest":
      return t("problem.malformedManifest");
    case "identity_mismatch":
      return t("problem.identityMismatch");
    case "unsupported_entry":
      return t("problem.unsupportedEntry");
    case "recovery_required":
      return t("problem.recoveryRequired");
    default:
      return t("problem.unknown");
  }
}

function backupSummary(
  t: TFunction<"backups">,
  count: number,
  problemCount: number,
  state: BackupInventory["state"],
  readState?: BackupReadState,
) {
  if (readState && readState.status !== "current") {
    if (readState.hasInventory)
      return count ? t("summary.lastLoaded", { count }) : t("summary.lastLoadedEmpty");
    return readState.status === "pending" ? t("summary.loading") : t("summary.unavailable");
  }
  if (!count)
    return problemCount > 0 || state !== "healthy"
      ? t("summary.needsAttention")
      : t("history.empty");
  return t("summary.count", { count });
}
