import { useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw, Trash2 } from "lucide-react";
import type { BackupInventory, BackupProblem, BackupRecord } from "../types";
import { formatBytes } from "../view-model";
import { Icon } from "./ui";

export function BackupHistory({ backups, problems = [], state = "healthy", busy, restore, remove }: {
  backups: BackupRecord[];
  problems?: BackupProblem[];
  state?: BackupInventory["state"];
  busy?: string;
  restore: (backup: BackupRecord) => void;
  remove: (backup: BackupRecord) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? backups : backups.slice(0, 3);
  return <div className="backup-history">
    <div className="backup-heading"><label>Data backups</label><small>{backupSummary(backups.length)}</small></div>
    {state !== "healthy" && <div className={`backup-inventory-notice ${state}`} role="status">
      <strong>{state === "recovery_required" ? "Backup recovery required" : "Some backups need attention"}</strong>
      <p>{problems.length} backup {problems.length === 1 ? "entry is" : "entries are"} unavailable. {backups.length ? "Verified backups remain listed and usable." : "No verified backup is currently available."}</p>
      <details><summary data-focusable>Technical details</summary>{problems.map(problem => <div className="backup-problem" key={`${problem.operation_id ?? "entry"}-${problem.path}`}>
        <strong>{problemLabel(problem.kind)}</strong><span>{problem.message}</span><small>{problem.path}</small><small>Next: {problem.proposed_action}</small>
      </div>)}</details>
    </div>}
    {visible.map(backup => <div className="backup-row" key={backup.id}>
      <span><strong>{new Date(backup.created_at * 1000).toLocaleString()}</strong><small>{backup.file_count} files · {formatBytes(backup.size)} · {backup.sha256.slice(0, 10)}…</small></span>
      <span className="backup-actions"><button data-focusable className="button-with-icon" disabled={Boolean(busy)} onClick={() => restore(backup)}><Icon glyph={RotateCcw} />Restore</button><button data-focusable className="danger icon-button" aria-label={`Delete backup from ${new Date(backup.created_at * 1000).toLocaleString()}`} disabled={Boolean(busy)} onClick={() => remove(backup)}><Icon glyph={Trash2} /></button></span>
    </div>)}
    {backups.length > 3 && <button data-focusable className="backup-expander button-with-icon" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Icon glyph={expanded ? ChevronUp : ChevronDown} />{expanded ? "Show recent only" : `Show ${backups.length - 3} older`}</button>}
  </div>;
}

function problemLabel(kind: BackupProblem["kind"]) {
  return ({
    missing_manifest: "Missing manifest",
    unreadable_manifest: "Unreadable manifest",
    malformed_manifest: "Malformed manifest",
    identity_mismatch: "Identity mismatch",
    unsupported_entry: "Unsupported entry",
    recovery_required: "Recovery required",
  } satisfies Record<BackupProblem["kind"], string>)[kind];
}

function backupSummary(count: number) {
  if (!count) return "No snapshots yet";
  return `${count} verified snapshot${count === 1 ? "" : "s"}`;
}
