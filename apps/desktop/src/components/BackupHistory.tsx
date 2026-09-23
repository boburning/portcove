import { useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw, Trash2 } from "lucide-react";
import type { BackupInventory, BackupProblem, BackupRecord } from "../types";
import { formatBytes } from "../view-model";
import { Icon } from "./ui";
import { BackupReviewDialog, type ApplyBackupAction } from "./BackupReview";
import { Button } from "./ui/button";

export function BackupHistory({
  backups,
  problems = [],
  state = "healthy",
  busy,
  generation = 0,
  restore,
  remove,
}: {
  backups: BackupRecord[];
  problems?: BackupProblem[];
  state?: BackupInventory["state"];
  busy?: string;
  generation?: number;
  restore: ApplyBackupAction;
  remove: ApplyBackupAction;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<{
    backup: BackupRecord;
    action: "restore" | "delete";
  }>();
  const visible = expanded ? backups : backups.slice(0, 3);
  return (
    <div className="backup-history">
      <div className="backup-heading">
        <span>Backups</span>
        <small>{backupSummary(backups.length, problems.length, state)}</small>
      </div>
      <p>Backups include saves and settings managed by Portcove.</p>
      {(state !== "healthy" || problems.length > 0) && (
        <div className={`backup-inventory-notice ${state}`} role="status">
          <strong>
            {state === "recovery_required"
              ? "Backup recovery required"
              : "Some backups need attention"}
          </strong>
          <p>
            {problems.length > 0
              ? `${problems.length} backup ${problems.length === 1 ? "entry is" : "entries are"} unavailable. `
              : "The backup inventory could not be fully checked. "}
            {backups.length
              ? state === "recovery_required"
                ? "Verified backups remain listed, but restoring and deleting require recovery to finish."
                : "Verified backups remain listed and usable."
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
                    {problemLabel(problem.kind)}: {problem.proposed_action}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <details>
            <summary data-focusable>Technical details</summary>
            {problems.map((problem) => (
              <div
                className="backup-problem"
                key={`${problem.operation_id ?? "entry"}-${problem.path}`}
              >
                <strong>{problemLabel(problem.kind)}</strong>
                <span>{problem.message}</span>
                <small>{problem.path}</small>
              </div>
            ))}
          </details>
        </div>
      )}
      {visible.map((backup) => {
        const createdLabel = new Date(backup.created_at * 1000).toLocaleString();
        return (
          <div className="backup-row" key={backup.id} data-backup-id={backup.id}>
            <span>
              <strong>{createdLabel}</strong>
              <small>
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
              <small className="backup-checksum">SHA-256 {backup.sha256}</small>
            </details>
            <span className="backup-actions">
              <Button
                data-focusable
                variant="outline"
                disabled={Boolean(busy) || state === "recovery_required"}
                onClick={() => setSelection({ backup, action: "restore" })}
              >
                <Icon glyph={RotateCcw} />
                Restore
              </Button>
              <Button
                data-focusable
                variant="destructive"
                size="icon"
                aria-label={`Delete backup from ${createdLabel}`}
                disabled={Boolean(busy) || state === "recovery_required"}
                onClick={() => setSelection({ backup, action: "delete" })}
              >
                <Icon glyph={Trash2} />
              </Button>
            </span>
          </div>
        );
      })}
      {selection && (
        <BackupReviewDialog
          key={`${selection.backup.id}:${selection.action}:${generation}`}
          backup={selection.backup}
          action={selection.action}
          generation={generation}
          apply={selection.action === "restore" ? restore : remove}
          close={() => setSelection(undefined)}
        />
      )}
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

function backupSummary(count: number, problemCount: number, state: BackupInventory["state"]) {
  if (!count)
    return problemCount > 0 || state !== "healthy" ? "Backups need attention" : "No backups yet";
  return `${count} verified backup${count === 1 ? "" : "s"}`;
}
