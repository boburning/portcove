import { cn } from "cn";
import { useRef, useState } from "react";
import { Archive, ChevronDown, ChevronUp, RotateCcw, Trash2 } from "lucide-react";
import type { BackupInventory, BackupProblem, BackupRecord } from "../types";
import { formatBytes } from "../view-model";
import { Icon } from "./ui";
import { BackupReviewDialog, type ApplyBackupAction } from "./BackupReview";
import { Button } from "./ui/button";
import { FailureDetails } from "./FailureDetails";
import type { BackupReadState } from "../features/backups/use-port-backups";

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
  remove: ApplyBackupAction;
  focusFallback?: () => HTMLElement | null;
}) {
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
              {readState.hasInventory ? "Refreshing backup history" : "Loading backup history"}
            </strong>
            <p className="m-[4px_0_8px] text-[var(--color-text-muted)]">
              {readState.hasInventory
                ? "Showing the last loaded backup list while the current list is checked."
                : "The backup list has not been loaded yet."}
            </p>
          </>
        )}
        {readState.status === "failed" && (
          <>
            <strong>Backup history could not be loaded</strong>
            <p className="m-[4px_0_8px] text-[var(--color-text-muted)]">
              {readState.hasInventory
                ? "Showing the last loaded backup list. It may have changed since it was read."
                : "The backup list is unknown. Retry to read it again."}
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
            {readState.status === "failed" ? "Retry backup history" : "Refresh backup history"}
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
          {state === "recovery_required"
            ? "Backup recovery required"
            : "Some backups need attention"}
        </strong>
        <p className="m-[4px_0_8px] text-[var(--color-text-muted)]">
          {problems.length > 0
            ? `${problems.length} backup ${problems.length === 1 ? "entry is" : "entries are"} unavailable. `
            : "The backup inventory could not be fully checked. "}
          {backups.length
            ? state === "recovery_required"
              ? "Verified backups remain listed, but restoring and deleting require recovery to finish."
              : (!readState || readState.status === "current") &&
                  restoreConsistent &&
                  restoreAssessment?.availability === "held" &&
                  restoreAssessment.reason === "recovery_required"
                ? "Verified backups remain listed, but restoring requires recovery to finish."
                : restoreAllowed
                  ? "Verified backups remain listed and usable."
                  : "Verified backups remain listed. Review the current restore availability below."
            : problems.length > 0
              ? "No backup is currently available to restore. Review the problems below."
              : "No backup is currently available to restore."}
        </p>
        {problems.length > 0 && (
          <div className="mt-2">
            <strong>What to do next</strong>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {problems.map((problem) => (
                <li key={`${problem.operation_id ?? "entry"}-${problem.path}`}>
                  {problemLabel(problem.kind)}:{" "}
                  {problem.kind === "recovery_required"
                    ? "Restart Portcove, then check your backups again. If recovery still needs attention, review diagnostics in Settings → Advanced."
                    : problem.proposed_action}
                </li>
              ))}
            </ul>
          </div>
        )}
        <details>
          <summary className="cursor-pointer" data-focusable>
            Technical details
          </summary>
          {problems.map((problem) => (
            <div
              className="backup-problem mt-[10px] grid gap-[3px]"
              key={`${problem.operation_id ?? "entry"}-${problem.path}`}
            >
              <strong>{problemLabel(problem.kind)}</strong>
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
          ? "Restore eligibility is unknown until backup history is read again."
          : !restoreConsistent
            ? "Restore eligibility is unknown. Refresh backup history before proceeding."
            : restoreAssessment?.reason === "recovery_required"
              ? "Restoring requires recovery to finish. Restart Portcove, then check your backups again. If recovery still needs attention, review diagnostics in Settings → Advanced."
              : restoreAssessment?.reason === "unsafe_data"
                ? "Restore is on hold. Review the backup and saves folder managed by Portcove."
                : restoreAssessment?.reason === "unreadable_data"
                  ? "Restore is on hold because Portcove’s managed saves folder could not be read."
                  : restoreAssessment?.reason === "missing_backup"
                    ? "No usable backup is currently available to restore."
                    : "Restore eligibility is unknown. Refresh backup history before proceeding."}
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
          Backups
        </span>
        <small className="text-xs text-[var(--color-text-muted)]">
          {backupSummary(backups.length, problems.length, state, readState)}
        </small>
      </div>
      {!embedded && <p>Backups include saves and settings managed by Portcove.</p>}
      {backups.length === 0 &&
        problems.length === 0 &&
        state === "healthy" &&
        readState?.status === "current" &&
        readState.hasInventory && (
          <div className="detail-backup-empty">
            <Icon glyph={Archive} />
            <div>
              <strong>No backups yet</strong>
              <p>
                A backup will appear here after you back up this installation’s managed saves and
                settings.
              </p>
            </div>
          </div>
        )}
      {renderReadStatus()}
      {renderInventoryNotice()}
      {renderRestoreAssessment()}
      {visible.map((backup, index) => {
        const createdLabel = new Date(backup.created_at * 1000).toLocaleString();
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
                {backup.file_count} {backup.file_count === 1 ? "file" : "files"} ·{" "}
                {formatBytes(backup.size)}
              </small>
            </span>
            <details>
              <summary
                data-focusable
                aria-label={`Technical details for backup from ${createdLabel}`}
              >
                Technical details
              </summary>
              <small className="backup-checksum mt-[3px] font-mono text-xs [overflow-wrap:anywhere] text-[var(--color-text-muted)]">
                SHA-256 {backup.sha256}
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
                Restore
              </Button>
              <Button
                data-focusable
                data-backup-action="delete"
                variant="destructive"
                size="icon"
                aria-label={`Delete backup from ${createdLabel}`}
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
          {expanded ? "Show recent only" : `Show ${backups.length - 3} older`}
        </Button>
      )}
    </div>
  );
}

function problemLabel(kind: BackupProblem["kind"]) {
  const labels = {
    missing_manifest: "Missing manifest",
    unreadable_manifest: "Unreadable manifest",
    malformed_manifest: "Malformed manifest",
    identity_mismatch: "Identity mismatch",
    unsupported_entry: "Unsupported entry",
    recovery_required: "Recovery required",
  } satisfies Record<BackupProblem["kind"], string>;
  return Object.hasOwn(labels, kind) ? labels[kind] : "Backup information unavailable";
}

function backupSummary(
  count: number,
  problemCount: number,
  state: BackupInventory["state"],
  readState?: BackupReadState,
) {
  if (readState && readState.status !== "current") {
    if (readState.hasInventory)
      return count
        ? `${count} last-loaded backup${count === 1 ? "" : "s"}`
        : "Last-loaded backup list is empty";
    return readState.status === "pending" ? "Loading backups" : "Backup history unavailable";
  }
  if (!count)
    return problemCount > 0 || state !== "healthy" ? "Backups need attention" : "No backups yet";
  return `${count} verified backup${count === 1 ? "" : "s"}`;
}
