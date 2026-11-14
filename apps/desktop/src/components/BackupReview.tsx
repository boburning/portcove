import { ActionReviewFailure } from "./ActionReviewFailure";
import { useRef } from "react";
import { useActionReview, type ReviewOutcome } from "../use-action-review";
import { desktopApi } from "../api";
import type { BackupAction, BackupRecord, BackupReview } from "../types";
import { formatBytes } from "../view-model";
import { automaticSnapshotLabel } from "../features/backups/snapshot-label";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { useAppTranslation } from "../localization";

export type ApplyBackupAction = (
  backup: BackupRecord,
  expectedPreview: string,
) => Promise<ReviewOutcome>;

export function BackupReviewDialog({
  gameName,
  backup,
  action,
  generation,
  apply,
  close,
  finalFocus,
}: {
  gameName?: string | undefined;
  backup: BackupRecord;
  action: BackupAction;
  generation: number;
  apply: ApplyBackupAction;
  close: () => void;
  finalFocus?: React.ComponentProps<typeof DialogContent>["finalFocus"];
}) {
  const { t } = useAppTranslation("backups");
  const cancelButton = useRef<HTMLButtonElement>(null);
  const {
    preview: review,
    pending,
    error,
    review: load,
    execute,
    dismiss,
  } = useActionReview({
    identity: `${backup.port_id}:${backup.id}:${action}:${generation}`,
    load: () => desktopApi.previewBackupAction(backup.port_id, backup.id, action, generation),
    apply: (review) => apply(review.preview.backup, review.preview.preview_sha256),
    close,
    failureMessage: t("review.failure"),
  });
  const restore = action === "restore";
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        initialFocus={cancelButton}
        showCloseButton={false}
        reviewSize="standard"
        aria-describedby="backup-review-description"
        finalFocus={finalFocus}
      >
        <DialogTitle id="backup-review-title" className="mb-2 text-xl">
          {restore ? t("review.titleRestore") : t("review.titleDelete")}
        </DialogTitle>
        <DialogDescription id="backup-review-description" className="mb-4 leading-relaxed">
          {gameName && (
            <strong className="mb-2 block wrap-anywhere text-pc-foreground">{gameName}</strong>
          )}
          {restore ? t("review.descriptionRestore") : t("review.descriptionDelete")}
        </DialogDescription>
        {pending === "review" && <p role="status">{t("review.checking")}</p>}
        {review && <BackupReviewDetails review={review} />}
        <ActionReviewFailure error={error} />
        <DialogFooter className="mt-4">
          <Button
            ref={cancelButton}
            data-focusable
            variant="outline"
            disabled={pending === "apply"}
            onClick={dismiss}
          >
            {t("review.cancel")}
          </Button>
          {!review && (
            <Button
              data-focusable
              disabled={Boolean(pending)}
              onClick={() => {
                void load();
              }}
            >
              {t("review.reviewAgain")}
            </Button>
          )}
          {review && (
            <Button
              data-focusable
              variant={restore ? "primary" : "destructive"}
              disabled={Boolean(pending)}
              onClick={() => {
                void execute();
              }}
            >
              {pending === "apply"
                ? restore
                  ? t("review.restoring")
                  : t("review.deleting")
                : restore
                  ? t("review.applyRestore")
                  : t("review.applyDelete")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BackupReviewDetails({ review }: { review: BackupReview }) {
  const { t } = useAppTranslation("backups");
  const { preview, port_name: portName, persistent_data_path: dataPath } = review;
  const { backup, action } = preview;
  const automaticLabel = automaticSnapshotLabel(backup);
  return (
    <section className="backup-review-details" aria-label={t("details.label")}>
      <p>
        <strong>
          {/* Dates follow the system's regional format, separate from message language. */}
          {t("details.heading", {
            name: portName,
            time: new Date(backup.created_at * 1000).toLocaleString(),
          })}
        </strong>
        <br />
        <small>{t("details.catalogId", { id: backup.port_id })}</small>
      </p>
      <p>
        {t("details.summary", { count: backup.file_count, size: formatBytes(backup.size) })}
        {(backup.unknown_file_count ?? 0) > 0 && (
          <>
            <br />
            <small className="[overflow-wrap:anywhere]" data-unknown-files>
              {t("details.unknownFiles", { total: backup.unknown_file_count ?? 0 })}
            </small>
          </>
        )}
        {automaticLabel && (
          <>
            <br />
            <small className="[overflow-wrap:anywhere]" data-automatic-snapshot>
              {automaticLabel}
            </small>
          </>
        )}
      </p>
      <dl>
        <div>
          <dt>{t("details.selectedBackup")}</dt>
          <dd className="m-[var(--space-1)_0_var(--space-3)] [overflow-wrap:anywhere]" dir="ltr">
            {backup.path}
          </dd>
        </div>
        <div>
          <dt>{t("details.dataFolder")}</dt>
          <dd className="m-[var(--space-1)_0_var(--space-3)] [overflow-wrap:anywhere]" dir="ltr">
            {dataPath}
          </dd>
        </div>
      </dl>
      {action === "restore" ? (
        <>
          <p>{t("details.restoreResult")}</p>
          <p>
            {preview.safety_backup_will_be_created
              ? t("details.safetyBackup")
              : t("details.noSafetyBackup")}
          </p>
          <p>{t("details.restoreStopped")}</p>
          <p>{t("details.restoreInterrupted")}</p>
        </>
      ) : (
        <>
          <p>{t("details.deletePreserved")}</p>
          {preview.retained_runtime_copy_will_be_deleted && <p>{t("details.deleteRuntimeCopy")}</p>}
          <p>{t("details.deleteIrreversible")}</p>
          <p>{t("details.deleteInterrupted")}</p>
        </>
      )}
    </section>
  );
}
