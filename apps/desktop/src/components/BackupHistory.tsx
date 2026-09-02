import { useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw, Trash2 } from "lucide-react";
import type { BackupRecord } from "../types";
import { formatBytes } from "../view-model";
import { Icon } from "./ui";

export function BackupHistory({ backups, busy, restore, remove }: {
  backups: BackupRecord[];
  busy?: string;
  restore: (backup: BackupRecord) => void;
  remove: (backup: BackupRecord) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? backups : backups.slice(0, 3);
  return <div className="backup-history">
    <div className="backup-heading"><label>Data backups</label><small>{backupSummary(backups.length)}</small></div>
    {visible.map(backup => <div className="backup-row" key={backup.id}>
      <span><strong>{new Date(backup.created_at * 1000).toLocaleString()}</strong><small>{backup.file_count} files · {formatBytes(backup.size)} · {backup.sha256.slice(0, 10)}…</small></span>
      <span className="backup-actions"><button data-focusable className="button-with-icon" disabled={Boolean(busy)} onClick={() => restore(backup)}><Icon glyph={RotateCcw} />Restore</button><button data-focusable className="danger icon-button" aria-label={`Delete backup from ${new Date(backup.created_at * 1000).toLocaleString()}`} disabled={Boolean(busy)} onClick={() => remove(backup)}><Icon glyph={Trash2} /></button></span>
    </div>)}
    {backups.length > 3 && <button data-focusable className="backup-expander button-with-icon" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Icon glyph={expanded ? ChevronUp : ChevronDown} />{expanded ? "Show recent only" : `Show ${backups.length - 3} older`}</button>}
  </div>;
}

function backupSummary(count: number) {
  if (!count) return "No snapshots yet";
  return `${count} verified snapshot${count === 1 ? "" : "s"}`;
}
