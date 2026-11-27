import { ActionReviewFailure } from "./ActionReviewFailure";
import { useLayoutEffect, useRef, useState } from "react";
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

function requireMatchingBackup(
  preview: BackupReview["preview"],
  backup: BackupRecord,
  action: BackupAction,
) {
  const observed = preview.backup;
  if (
    preview.action !== action ||
    observed.port_id !== backup.port_id ||
    observed.id !== backup.id ||
    observed.sha256 !== backup.sha256
  )
    throw backupSelectionChanged;
}

function requireRestoreTarget(
  scope: BackupReview["preview"]["restore_target_sha256"],
  previous: string | undefined,
) {
  if (!scope || !/^[a-f0-9]{64}$/u.test(scope)) throw restoreReviewHolds.inventoryUnavailable;
  if (previous !== undefined && previous !== scope) throw restoreReviewHolds.targetChanged;
  return scope;
}

const restoreHoldMessages = {
  backupUnavailable: "review.backupUnavailable",
  inventoryUnavailable: "review.inventoryUnavailable",
  targetChanged: "review.targetChanged",
} as const;

function reviewExplanation({
  reconcile,
  selectionChanged,
  reopen,
  hold,
  checking,
  reviewRefusal,
}: {
  reconcile: boolean;
  selectionChanged: boolean;
  reopen: boolean;
  hold: keyof typeof restoreReviewHolds | undefined;
  checking: boolean;
  reviewRefusal: boolean;
}) {
  if (reconcile) return "review.reconcileRestore";
  if (selectionChanged) return "review.selectionChanged";
  if (reopen) return "review.reopenRestore";
  if (hold && !checking) return restoreHoldMessages[hold];
  if (reviewRefusal) return "review.refreshRefusedRestore";
}

const applyLabels = {
  restore: { ready: "review.applyRestore", pending: "review.restoring", variant: "primary" },
  delete: { ready: "review.applyDelete", pending: "review.deleting", variant: "destructive" },
} as const;

function reviewFooterAction({
  pending,
  action,
  canApply,
  canRefresh,
  canRetryDelete,
  reviewRefusal,
  refreshingRestore,
}: {
  pending: "review" | "apply" | undefined;
  action: BackupAction;
  canApply: boolean;
  canRefresh: boolean;
  canRetryDelete: boolean;
  reviewRefusal: boolean;
  refreshingRestore: boolean;
}) {
  if (canApply || pending === "apply") {
    const labels = applyLabels[action];
    return {
      intent: "apply",
      label: pending === "apply" ? labels.pending : labels.ready,
      variant: labels.variant,
      disabled: Boolean(pending),
    } as const;
  }
  if (canRefresh || canRetryDelete) {
    return {
      intent: "review",
      label: canRefresh ? "history.refresh" : "review.reviewAgain",
      variant: reviewRefusal ? "primary" : undefined,
      disabled: Boolean(pending) || refreshingRestore,
    } as const;
  }
}

function useBackupReview({
  backup,
  action,
  generation,
  apply,
  close,
  refreshRestoreReview,
  failureMessage,
}: {
  backup: BackupRecord;
  action: BackupAction;
  generation: number;
  apply: ApplyBackupAction;
  close: () => void;
  refreshRestoreReview: (() => Promise<RestoreReviewAvailability>) | undefined;
  failureMessage: string;
}) {
  const refreshBeforeReview = useRef(false);
  const [originalRestoreTarget, setOriginalRestoreTarget] = useState<{
    identity: string;
    scope: string;
  }>();
  const restore = action === "restore";
  const identity = `${backup.port_id}:${backup.id}:${backup.sha256}:${action}:${generation}`;
  const reviewedRestoreTarget =
    originalRestoreTarget?.identity === identity ? originalRestoreTarget.scope : undefined;
  const activeIdentity = useRef<string>(undefined);
  useLayoutEffect(() => {
    activeIdentity.current = identity;
    return () => {
      activeIdentity.current = undefined;
    };
  }, [identity]);
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
      requireMatchingBackup(result.preview, backup, action);
      if (restore) {
        const scope = requireRestoreTarget(
          result.preview.restore_target_sha256,
          reviewedRestoreTarget,
        );
        if (activeIdentity.current === identity && reviewedRestoreTarget === undefined)
          setOriginalRestoreTarget({ identity, scope });
      }
      return result;
    },
    apply: (review) => apply(review.preview.backup, review.preview.preview_sha256),
    close,
    failureMessage,
  });
  return {
    review,
    pending,
    error,
    failurePhase,
    reviewedRestoreTarget,
    refreshBeforeReview,
    load,
    execute,
    dismiss,
  };
}

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
  const restore = action === "restore";
  const refreshingRestore = restore && refreshingHistory;
  const {
    review,
    pending,
    error,
    failurePhase,
    reviewedRestoreTarget,
    refreshBeforeReview,
    load,
    execute,
    dismiss,
  } = useBackupReview({
    backup,
    action,
    generation,
    apply,
    close,
    refreshRestoreReview,
    failureMessage: t("review.failure"),
  });
  const selectionChanged = error === backupSelectionChanged;
  const hold =
    (Object.keys(restoreReviewHolds) as (keyof typeof restoreReviewHolds)[]).find(
      (reason) => error === restoreReviewHolds[reason],
    ) ?? (restore && restoreAvailability !== "ready" ? restoreAvailability : undefined);
  const mutation = failurePresentation(error)?.mutation_state;
  const requiresReconciliation =
    restore && failurePhase === "apply" && mutation !== "no_changes" && mutation !== "not_started";
  const canRefresh =
    Boolean(refreshRestoreReview) &&
    reviewedRestoreTarget !== undefined &&
    !requiresReconciliation &&
    hold !== "targetChanged" &&
    hold !== "backupUnavailable";
  const canReviewRefusedRestore =
    canRefresh && failurePhase === "apply" && mutation === "no_changes";
  const canApply = Boolean(review && (!restore || (!hold && !refreshingRestore)));
  const explanation = reviewExplanation({
    reconcile: requiresReconciliation,
    selectionChanged,
    reopen: restore && error !== undefined && reviewedRestoreTarget === undefined,
    hold,
    checking: Boolean(pending) || refreshingHistory,
    reviewRefusal: canReviewRefusedRestore,
  });
  const summary = explanation && t(explanation);
  const footer = reviewFooterAction({
    pending,
    action,
    canApply,
    canRefresh,
    canRetryDelete: !restore && !review && !selectionChanged,
    reviewRefusal: canReviewRefusedRestore,
    refreshingRestore,
  });
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
        {(pending === "review" || refreshingRestore) && <p role="status">{t("review.checking")}</p>}
        {review && (canApply || pending === "apply") && <BackupReviewDetails review={review} />}
        <ActionReviewFailure error={summary ? (error ?? summary) : error} summary={summary} />
        <DialogFooter className="mt-4">
          <Button data-focusable variant="outline" disabled={pending === "apply"} onClick={dismiss}>
            {t("review.cancel")}
          </Button>
          {footer && (
            <Button
              data-focusable
              key={footer.intent}
              variant={footer.variant}
              disabled={footer.disabled}
              onClick={() => {
                if (footer.intent === "apply") {
                  void execute();
                  return;
                }
                if (canRefresh) {
                  refreshBeforeReview.current = true;
                  reviewTitle.current?.focus();
                }
                void load();
              }}
            >
              {t(footer.label)}
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
