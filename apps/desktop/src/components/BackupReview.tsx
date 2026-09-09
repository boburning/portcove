import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { useDialogFocus } from "../dialog";
import type { BackupAction, BackupRecord, BackupReview } from "../types";
import { errorText, formatBytes } from "../view-model";

export type ApplyBackupAction = (backup: BackupRecord, expectedPreview: string) => Promise<boolean>;

export function BackupReviewDialog({ backup, action, generation, apply, close }: {
  backup: BackupRecord; action: BackupAction; generation: number; apply: ApplyBackupAction; close: () => void;
}) {
  const [review, setReview] = useState<BackupReview>();
  const [pending, setPending] = useState<"review" | "apply">();
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const dismiss = () => { if (pending !== "apply") close(); };
  const dialog = useDialogFocus(dismiss);
  const load = async () => {
    const current = ++request.current;
    setPending("review"); setReview(undefined); setError(undefined);
    try {
      const result = await desktopApi.previewBackupAction(backup.port_id, backup.id, action, generation);
      if (request.current === current) setReview(result);
    } catch (value) { if (request.current === current) setError(errorText(value)); }
    finally { if (request.current === current) setPending(undefined); }
  };
  useEffect(() => { void load(); return () => { request.current += 1; }; }, [backup.id, backup.port_id, action, generation]);
  const execute = async () => {
    if (!review || pending) return;
    const current = ++request.current;
    setPending("apply"); setError(undefined);
    try {
      const completed = await apply(review.preview.backup, review.preview.preview_sha256);
      if (request.current !== current) return;
      if (completed) close();
      else setError("The operation did not complete. Review the current backup and data before trying again.");
    } catch (value) { if (request.current === current) setError(errorText(value)); }
    finally { if (request.current === current) { setPending(undefined); setReview(undefined); } }
  };
  const restore = action === "restore";
  return <div className="scrim"><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="backup-review-title" aria-describedby="backup-review-description">
    <h2 id="backup-review-title">{restore ? "Review backup restore" : "Review backup deletion"}</h2>
    <p id="backup-review-description">{restore ? "Replace this game's saved data with the selected snapshot." : "Permanently remove only the selected saved-data snapshot."}</p>
    {pending === "review" && <p role="status">Checking the backup and current saved data…</p>}
    {review && <BackupReviewDetails review={review} />}
    {error && <p role="alert">{error}</p>}
    <div className="modal-actions">
      <button data-autofocus data-focusable disabled={pending === "apply"} onClick={dismiss}>Keep current state</button>
      {!review && <button data-focusable disabled={Boolean(pending)} onClick={() => { void load(); }}>Review again</button>}
      {review && <button data-focusable className={restore ? "primary" : "danger"} disabled={Boolean(pending)} onClick={() => { void execute(); }}>{pending === "apply" ? "Applying reviewed change…" : restore ? "Restore this backup" : "Delete this backup permanently"}</button>}
    </div>
  </section></div>;
}

function BackupReviewDetails({ review }: { review: BackupReview }) {
  const { preview, persistent_data_path: dataPath } = review;
  const { backup, action } = preview;
  return <section className="backup-review-details" aria-label="Backup changes and preserved data">
    <p><strong>{backup.port_id} · {new Date(backup.created_at * 1000).toLocaleString()}</strong></p>
    <p>{backup.file_count} files · {formatBytes(backup.size)}</p>
    <dl><div><dt>Selected snapshot</dt><dd>{backup.path}</dd></div><div><dt>Saved-data folder</dt><dd>{dataPath}</dd></div></dl>
    {action === "restore" ? <>
      <p>The saved-data folder will contain this snapshot's data. The selected backup, other backups and installed game versions are preserved.</p>
      <p>{preview.safety_backup_will_be_created ? "Current saved data will be preserved in a new safety backup before replacement. Restore that safety backup to return to the previous data." : "There is no current saved-data content to preserve in a safety backup. A previous-data safety backup will not be created."}</p>
      <p>The game must be stopped. If its data changes after this review, review again before restoring.</p>
      <p>If interrupted, Portcove retains recovery data and checks the restore when the library reopens. Review any recovery notice before another restore.</p>
    </> : <>
      <p>Current saved data, other backups and installed game versions are preserved.</p>
      <p>This snapshot cannot be recovered after deletion. No safety copy of the deleted snapshot is created.</p>
      <p>If interrupted, Portcove retains a deletion journal and reconciles the selected snapshot when the library reopens. An interrupted deletion may finish; it is not a reversible cancellation.</p>
    </>}
  </section>;
}
