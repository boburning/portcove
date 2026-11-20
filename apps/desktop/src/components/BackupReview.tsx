import { ActionReviewFailure } from "./ActionReviewFailure";
import { useLayoutEffect, useRef } from "react";
import { useActionReview, type ReviewOutcome } from "../use-action-review";
import { desktopApi } from "../api";
import type { BackupAction, BackupRecord, BackupReview } from "../types";
import { failurePresentation, formatBytes } from "../view-model";
import { automaticSnapshotLabel } from "../features/backups/snapshot-label";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { useAppTranslation } from "../localization";

const backupSelectionChanged = new Error("Backup preview does not match the selected backup.");
const restoreReviewHolds = {
  backupUnavailable: new Error(),
  inventoryUnavailable: new Error(),
  targetChanged: new Error(),
};
export type RestoreReviewAvailability = "ready" | keyof typeof restoreReviewHolds;

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
  restoreAvailability = "ready",
  refreshingHistory = false,
  refreshRestoreReview,
}: {
  gameName?: string | undefined;
  backup: BackupRecord;
  action: BackupAction;
  generation: number;
  apply: ApplyBackupAction;
  close: () => void;
  finalFocus?: React.ComponentProps<typeof DialogContent>["finalFocus"];
  restoreAvailability?: RestoreReviewAvailability;
  refreshingHistory?: boolean;
  refreshRestoreReview?: (() => Promise<RestoreReviewAvailability>) | undefined;
}) {
  const { t } = useAppTranslation("backups");
  const reviewTitle = useRef<HTMLHeadingElement>(null);
  const refreshBeforeReview = useRef(false);
  const originalRestoreTarget = useRef<{ identity: string; scope: string | null | undefined }>(
    undefined,
  );
  const restore = action === "restore";
  const identity = `${backup.port_id}:${backup.id}:${backup.sha256}:${action}:${generation}`;
  const {
    preview: review,
    pending,
    error,
    failurePhase,
    review: load,
    execute,
    dismiss,
  } = useActionReview({
    identity,
    load: async () => {
      if (refreshBeforeReview.current && refreshRestoreReview) {
        refreshBeforeReview.current = false;
        const availability = await refreshRestoreReview();
        if (availability !== "ready") throw restoreReviewHolds[availability];
      }
      const result = await desktopApi.previewBackupAction(
        backup.port_id,
        backup.id,
        action,
        generation,
      );
      const observed = result.preview.backup;
      if (
        result.preview.action !== action ||
        observed.port_id !== backup.port_id ||
        observed.id !== backup.id ||
        observed.sha256 !== backup.sha256
      ) {
        throw backupSelectionChanged;
      }
      const original = originalRestoreTarget.current;
      if (restore && original?.identity === identity) {
        if (!original.scope || !result.preview.restore_target_sha256)
          throw restoreReviewHolds.inventoryUnavailable;
        if (original.scope !== result.preview.restore_target_sha256)
          throw restoreReviewHolds.targetChanged;
      }
      return result;
    },
    apply: (review) => apply(review.preview.backup, review.preview.preview_sha256),
    close,
    failureMessage: t("review.failure"),
  });
  useLayoutEffect(() => {
    if (restore && review && originalRestoreTarget.current?.identity !== identity)
      originalRestoreTarget.current = { identity, scope: review.preview.restore_target_sha256 };
  }, [restore, review, identity]);
  const selectionChanged = error === backupSelectionChanged;
  const hold =
    (Object.keys(restoreReviewHolds) as (keyof typeof restoreReviewHolds)[]).find(
      (reason) => error === restoreReviewHolds[reason],
    ) ?? (restore && restoreAvailability !== "ready" ? restoreAvailability : undefined);
  const mutation = failurePresentation(error)?.mutation_state;
  const requiresReconciliation =
    restore && failurePhase === "apply" && mutation !== "no_changes" && mutation !== "not_started";
  const canRefresh =
    refreshRestoreReview &&
    !requiresReconciliation &&
    hold !== "targetChanged" &&
    hold !== "backupUnavailable";
  const canApply = Boolean(review && (!restore || (!hold && !refreshingHistory)));
  const holdMessage = {
    backupUnavailable: t("review.backupUnavailable"),
    inventoryUnavailable: t("review.inventoryUnavailable"),
    targetChanged: t("review.targetChanged"),
  };
  const explanation = requiresReconciliation
    ? t("review.reconcileRestore")
    : hold && !pending && !refreshingHistory
      ? holdMessage[hold]
      : selectionChanged
        ? t("review.selectionChanged")
        : undefined;
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        initialFocus={reviewTitle}
        showCloseButton={false}
        reviewSize="standard"
        aria-describedby="backup-review-description"
        finalFocus={finalFocus}
      >
        <DialogTitle
          ref={reviewTitle}
          tabIndex={-1}
          id="backup-review-title"
          className="mb-2 text-xl"
        >
          {restore ? t("review.titleRestore") : t("review.titleDelete")}
        </DialogTitle>
        <DialogDescription id="backup-review-description" className="mb-4 leading-relaxed">
          {gameName && (
            <strong className="mb-2 block wrap-anywhere text-pc-foreground">{gameName}</strong>
          )}
          {restore ? t("review.descriptionRestore") : t("review.descriptionDelete")}
        </DialogDescription>
        {(pending === "review" || (restore && refreshingHistory)) && (
          <p role="status">{t("review.checking")}</p>
        )}
        {review && (canApply || pending === "apply") && <BackupReviewDetails review={review} />}
        <ActionReviewFailure
          error={explanation ? (error ?? explanation) : error}
          summary={explanation}
        />
        <DialogFooter className="mt-4">
          <Button data-focusable variant="outline" disabled={pending === "apply"} onClick={dismiss}>
            {t("review.cancel")}
          </Button>
          {!canApply &&
            (canRefresh || (!restore && !review && !selectionChanged)) &&
            pending !== "apply" && (
              <Button
                data-focusable
                disabled={Boolean(pending) || (restore && refreshingHistory)}
                onClick={() => {
                  if (canRefresh) {
                    refreshBeforeReview.current = true;
                    reviewTitle.current?.focus();
                  }
                  void load();
                }}
              >
                {t(canRefresh ? "history.refresh" : "review.reviewAgain")}
              </Button>
            )}
          {(canApply || pending === "apply") && (
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
    <section className="backup-review-details grid min-w-0 gap-3" aria-label={t("details.label")}>
      <div className="grid min-w-0 gap-1 wrap-anywhere">
        <strong>
          {/* Dates follow the system's regional format, separate from message language. */}
          {t("details.heading", {
            name: portName,
            time: new Date(backup.created_at * 1000).toLocaleString(),
          })}
        </strong>
        <p className="text-sm">
          {t("details.summary", { count: backup.file_count, size: formatBytes(backup.size) })}
        </p>
        <small className="text-xs text-pc-muted-foreground">
          {t("details.catalogId", { id: backup.port_id })}
        </small>
        {(backup.unknown_file_count ?? 0) > 0 && (
          <small className="text-xs text-pc-muted-foreground" data-unknown-files>
            {t("details.unknownFiles", { total: backup.unknown_file_count ?? 0 })}
          </small>
        )}
        {automaticLabel && (
          <small className="text-xs text-pc-muted-foreground" data-automatic-snapshot>
            {automaticLabel}
          </small>
        )}
      </div>
      <dl className="grid min-w-0 gap-3 rounded-pc-md border border-pc-border bg-pc-surface-muted p-3">
        <div>
          <dt className="text-xs font-semibold">{t("details.selectedBackup")}</dt>
          <dd
            className="mt-1 font-mono text-xs leading-relaxed wrap-anywhere select-text"
            dir="ltr"
          >
            {backup.path}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold">{t("details.dataFolder")}</dt>
          <dd
            className="mt-1 font-mono text-xs leading-relaxed wrap-anywhere select-text"
            dir="ltr"
          >
            {dataPath}
          </dd>
        </div>
      </dl>
      <div className="grid gap-2 text-sm leading-relaxed">
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
            {preview.retained_runtime_copy_will_be_deleted && (
              <p>{t("details.deleteRuntimeCopy")}</p>
            )}
            <p>{t("details.deleteIrreversible")}</p>
            <p>{t("details.deleteInterrupted")}</p>
          </>
        )}
      </div>
    </section>
  );
}
